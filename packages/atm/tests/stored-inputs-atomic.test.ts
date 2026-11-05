/**
 * The input is written in the delivery's one transaction: a write that fails at ANY point of a delivery (the claim, the rows,
 * the outbox, the indexes, the context, the seed, the input, the claim's done mark) leaves every table as it was, the
 * `sqlite_sequence` of `applied_order` included, and the retry that follows stores the input once.
 */
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { SqlDatabase } from "../src/handler/types.js";
import type { Menu } from "../src/types.js";
import {
	FAMILY,
	HOUR,
	harness,
	linked,
	menu,
	paid,
	SCHOOL,
	T0,
	T1,
	tierKey,
} from "./handler-harness.js";
import { invoicePaid } from "./stripe-events.js";

const TABLES = [
	"atm_subjects",
	"atm_rows",
	"atm_invoice_index",
	"atm_payment_index",
	"ledger_outbox",
	"atm_event_inputs",
	"atm_input_contexts",
	"atm_input_seeds",
	"atm_input_erasures",
	"sqlite_sequence",
] as const;
const STALE_WINDOW = HOUR;

/** Every table a delivery writes except the claim (its insert is its own transaction), as one string. */
const snapshot = (raw: Database): string =>
	JSON.stringify(
		TABLES.map((table) => [table, raw.query(`SELECT * FROM ${table}`).all()]),
	);

/** A database whose `k`-th write throws; `writes()` counts the writes made so far. */
const failingAt = (db: SqlDatabase, failOn: number) => {
	let made = 0;
	const wrapped: SqlDatabase = {
		...db,
		run: (sql, params) => {
			made += 1;
			if (made === failOn) throw new Error(`injected failure at write ${made}`);
			return db.run(sql, params);
		},
	};
	return { wrapped, writes: () => made };
};

const renewal = (invoiceId: string, at: number) =>
	invoicePaid({
		eventId: `evt_${invoiceId}`,
		invoiceId,
		at,
		subscriptionId: "sub_1",
		reason: "subscription_cycle",
		periodStart: at,
		periodEnd: at + 30 * 24 * HOUR,
		lines: [{ lookupKey: tierKey(), amount: 26_000, interval: "month" }],
		metadata: { b4u_school: SCHOOL, family_id: FAMILY },
	});

const noTiers: Menu = { ...menu, tiers: [] };

type Scenario = {
	h: ReturnType<typeof harness>;
	/** One delivery, `shift` ms later than the first try (the retry is after the claim's stale window). */
	go: (shift: number) => unknown;
};

const scenarios: Record<string, () => Scenario> = {
	"an applied delivery that seeds a holder with rows": () => {
		const h = harness({ in_2: 100 });
		h.deliver(paid("in_1"));
		// the first delivery was before the upgrade: the next one seeds
		h.raw.run(`DELETE FROM atm_event_inputs`);
		h.raw.run(`DELETE FROM atm_input_contexts`);
		return { h, go: (shift) => h.deliver(renewal("in_2", T1), T1 + shift) };
	},
	"a 422 refusal": () => {
		const h = harness(undefined, { menu: noTiers });
		return { h, go: (shift) => h.deliver(paid(), T0 + shift) };
	},
	"an invoice_payment.paid": () => {
		const h = harness();
		h.deliver(paid("in_1"));
		return {
			h,
			go: (shift) => h.deliver(linked("in_1"), T0 + 1000 + shift),
		};
	},
};

describe("a write that fails at any point rolls the whole delivery back", () => {
	for (const [name, make] of Object.entries(scenarios))
		test(name, () => {
			const probe = make();
			const counter = failingAt(probe.h.deps.db, Number.POSITIVE_INFINITY);
			probe.h.deps.db = counter.wrapped;
			probe.go(0);
			const total = counter.writes();
			expect(total).toBeGreaterThan(3);

			for (let failOn = 1; failOn <= total; failOn += 1) {
				const scenario = make();
				const healthy = scenario.h.deps.db;
				const before = snapshot(scenario.h.raw);
				scenario.h.deps.db = failingAt(healthy, failOn).wrapped;
				expect(() => scenario.go(0), `write ${failOn}`).toThrow(
					"injected failure",
				);
				expect(snapshot(scenario.h.raw), `write ${failOn}`).toBe(before);

				// the retry after the stale window stores the input once, in the order after the last one
				scenario.h.deps.db = healthy;
				scenario.go(STALE_WINDOW);
				const orders = (
					scenario.h.raw
						.query(
							`SELECT applied_order FROM atm_event_inputs ORDER BY applied_order`,
						)
						.all() as { applied_order: number }[]
				).map((row) => row.applied_order);
				expect(new Set(orders).size, `write ${failOn}`).toBe(orders.length);
				expect(orders, `write ${failOn}`).toEqual(
					[...orders].sort((a, b) => a - b),
				);
			}
		});
});
