/**
 * Stored inputs (`atm_event_inputs`) through the real reference handler: what a delivery writes, what it does not, the order,
 * the transaction it is written in, the erasure hook, and the additive DDL. The privacy sweep over a database file is in
 * `stored-inputs-privacy.test.ts`; a booking's inputs, written by the family service's endpoint, in
 * `stored-inputs-booking.test.ts`. Design: `docs/simulate-from-inputs.md`.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeStripeEvent } from "../src/billing/handle.js";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import {
	ATM_VERSION,
	contextHashOf,
	eraseStoredInputs,
	inputCauseId,
	inputsStatus,
	readInputs,
	replayFactOf,
	shippedSeedKey,
	sqliteInputsSource,
} from "../src/handler/inputs.js";
import { HANDLER_DDL, migrateHandlerSchema } from "../src/handler/schema.js";
import type { SqlDatabase } from "../src/handler/types.js";
import { sha256Hex } from "../src/ledger/util.js";
import type { Menu } from "../src/types.js";
import {
	RECORDED_SCHOOL,
	recordedMenu,
	recordedPriceIds,
} from "./e2e-recorded.js";
import {
	FAMILY,
	HOUR,
	harness,
	linked,
	menu,
	paid,
	refund,
	SCHOOL,
	T0,
	T1,
	tierKey,
} from "./handler-harness.js";
import { invoicePaid, type RawEvent } from "./stripe-events.js";

type Row = {
	applied_order: number;
	env: string;
	event_id: string;
	school_id: string;
	subject_key: string | null;
	type: string;
	mapping: string;
	livemode: number | null;
	stripe_created: number;
	received_at: number;
	outcome: string;
	reason: string | null;
	attempts: number;
	revision_before: number | null;
	revision_after: number | null;
	atm_version: string;
	context_hash: string | null;
	menu_version: string | null;
	policy_version: string | null;
	fee: number | null;
	payment_refs: string | null;
	input_id: string;
	booking_refs: string | null;
	raw_sha256: string | null;
	body: string | null;
	erased_at: number | null;
	batch_key: string | null;
	shipped_at: number | null;
};

const inputRows = (raw: Database, where = ""): Row[] =>
	raw
		.query(`SELECT * FROM atm_event_inputs ${where} ORDER BY applied_order`)
		.all() as Row[];

const count = (raw: Database, table: string): number =>
	(raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const claimState = (raw: Database, eventId: string, env = "live") =>
	(
		raw
			.query(
				`SELECT state FROM atm_event_claims WHERE env = ? AND event_id = ?`,
			)
			.get(env, eventId) as { state: string } | null
	)?.state;

const MINUTE = 60_000;
const QUEUED_AT = 1_800_000_000_000;

describe("a delivery stores its input", () => {
	test("once, with the trimmed fact, the side inputs, the raw body's hash and the context it ran under", () => {
		const h = harness({ in_1: 784 });
		const event = paid();
		h.deps.paymentRefs = () => ["pi_in_1", "ch_in_1"];
		expect(h.deliver(event).body.outcome).toBe("applied");

		const [row, ...rest] = inputRows(h.raw);
		expect(rest).toEqual([]);
		const inputId = inputCauseId({
			school: SCHOOL,
			eventId: "evt_in_1",
			stripeCreated: event.created,
		});
		expect(row).toMatchObject({
			env: "live",
			event_id: "evt_in_1",
			school_id: SCHOOL,
			subject_key: `${SCHOOL}|live|family:${FAMILY}`,
			type: "invoice.paid",
			mapping: "stripe/invoice.paid@v1",
			outcome: "applied",
			reason: null,
			attempts: 1,
			revision_before: 0,
			revision_after: 1,
			atm_version: ATM_VERSION,
			menu_version: "3",
			policy_version: "1",
			fee: 784,
			input_id: inputId,
			booking_refs: null,
			stripe_created: event.created,
			erased_at: null,
			batch_key: null,
			shipped_at: null,
		});
		expect(row?.payment_refs && JSON.parse(row.payment_refs)).toEqual([
			"pi_in_1",
			"ch_in_1",
		]);
		expect(row?.raw_sha256).toBe(sha256Hex(JSON.stringify(event)));
		// the fact is the normalized one, trimmed: no source, number or bearer link, metadata cut to the two keys
		const normalized = normalizeStripeEvent(event, inputId);
		if (!normalized.ok) throw new Error("the fixture must normalize");
		const body = JSON.parse(row?.body ?? "null") as {
			v: number;
			fact: Record<string, unknown>;
		};
		expect(body).toEqual({
			v: 1,
			fact: JSON.parse(JSON.stringify(replayFactOf(normalized.fact))),
		});
		for (const dropped of [
			"source",
			"number",
			"hostedInvoiceUrl",
			"invoicePdf",
		])
			expect(body.fact).not.toHaveProperty(dropped);
		// the context: one row, with what was in force
		const context = h.deps.context(SCHOOL);
		if (!context) throw new Error("the harness serves the school");
		const hash = contextHashOf({
			menu: context.menu,
			policy: context.policy,
			priceIds: context.priceIds ?? {},
		});
		expect(row?.context_hash).toBe(hash);
		const contexts = h.raw.query(`SELECT * FROM atm_input_contexts`).all() as {
			context_hash: string;
			school_id: string;
			body: string;
		}[];
		expect(contexts.map((c) => [c.context_hash, c.school_id])).toEqual([
			[hash, SCHOOL],
		]);
		expect(JSON.parse(contexts[0]?.body ?? "{}").menu).toEqual(menu);
		// a new holder has no rows to seed from
		expect(count(h.raw, "atm_input_seeds")).toBe(0);
	});

	test("a redelivery (duplicate) stores nothing new", () => {
		const h = harness();
		h.deliver(paid());
		const before = inputRows(h.raw);
		expect(before).toHaveLength(1);
		expect(h.deliver(paid()).body.outcome).toBe("duplicate");
		expect(inputRows(h.raw)).toEqual(before);
		expect(count(h.raw, "atm_input_contexts")).toBe(1);
	});

	test("two events with the same context share one context row", () => {
		const h = harness();
		h.deliver(paid("in_1"));
		expect(h.deliver(renewal("in_2", T1), T1).body.outcome).toBe("applied");
		expect(count(h.raw, "atm_event_inputs")).toBe(2);
		expect(count(h.raw, "atm_input_contexts")).toBe(1);
	});

	test("the same Stripe id under env live and env test stores two rows", () => {
		const raw = new Database(":memory:");
		const live = harness(undefined, { raw });
		const test = harness(undefined, { raw, env: "test" });
		expect(live.deliver(paid()).body.outcome).toBe("applied");
		expect(test.deliver(paid()).body.outcome).toBe("applied");
		const rows = inputRows(raw);
		expect(rows.map((row) => [row.env, row.event_id])).toEqual([
			["live", "evt_in_1"],
			["test", "evt_in_1"],
		]);
		expect(rows.map((row) => row.subject_key)).toEqual([
			`${SCHOOL}|live|family:${FAMILY}`,
			`${SCHOOL}|test|family:${FAMILY}`,
		]);
		expect(rows[0]?.applied_order).not.toBe(rows[1]?.applied_order);
		// one context per env
		expect(count(raw, "atm_input_contexts")).toBe(2);
	});

	test("an invoice_payment.paid is stored too (it teaches the payment index), with no context", () => {
		const h = harness();
		h.deliver(paid("in_1"));
		expect(h.deliver(linked("in_1"), T0 + 1000).body.outcome).toBe("applied");
		const row = inputRows(h.raw, "WHERE type = 'invoice_payment.paid'")[0];
		expect(row).toMatchObject({
			event_id: "evt_link_in_1",
			outcome: "applied",
			context_hash: null,
			revision_before: 1,
			revision_after: 1,
			fee: null,
		});
	});

	test("a refund and a payout are stored", () => {
		const h = harness();
		h.deliver(paid("in_1"));
		h.deliver(linked("in_1"), T0 + 1000);
		expect(h.deliver(refund(5000), T0 + HOUR).body.outcome).toBe("applied");
		expect(inputRows(h.raw).map((row) => row.type)).toEqual([
			"invoice.paid",
			"invoice_payment.paid",
			"charge.refunded",
		]);
	});
});

describe("a refused delivery", () => {
	const brokenMenu: Menu = {
		...menu,
		tiers: menu.tiers.filter((tier) => tier.id !== "sparkle-2"),
	};

	test("stores the input and its reason; a retry counts an attempt; the applied delivery replaces it with a new applied_order", () => {
		const raw = new Database(":memory:");
		const broken = harness(undefined, { raw, menu: brokenMenu });
		const fixed = harness(undefined, { raw });
		const first = broken.deliver(paid());
		expect(first.status).toBe(422);
		expect(first.body.reason).toBe("unmatched_line");
		const [refused] = inputRows(raw);
		expect(refused).toMatchObject({
			event_id: "evt_in_1",
			outcome: "refused",
			reason: "unmatched_line",
			attempts: 1,
			subject_key: `${SCHOOL}|live|family:${FAMILY}`,
			revision_before: 0,
			revision_after: 0,
		});
		expect(refused?.body).not.toBeNull();
		// the claim is released, as before
		expect(claimState(raw, "evt_in_1")).toBeUndefined();
		expect(inputsStatus(bunDb(raw), { env: "live" })).toMatchObject({
			available: true,
			applied: 0,
			refused: 1,
		});
		// no seed for a refusal: the rows can change before the input that is applied
		expect(count(raw, "atm_input_seeds")).toBe(0);

		expect(broken.deliver(paid()).status).toBe(422);
		const [again, ...others] = inputRows(raw);
		expect(others).toEqual([]);
		expect(again).toMatchObject({ outcome: "refused", attempts: 2 });
		expect(again?.applied_order).toBe(refused?.applied_order as number);

		expect(fixed.deliver(paid()).body.outcome).toBe("applied");
		const [applied, ...rest] = inputRows(raw);
		expect(rest).toEqual([]);
		expect(applied).toMatchObject({
			event_id: "evt_in_1",
			outcome: "applied",
			reason: null,
			attempts: 3,
			revision_before: 0,
			revision_after: 1,
		});
		expect(applied?.applied_order).toBeGreaterThan(
			refused?.applied_order as number,
		);
		// a delivery after that is a duplicate and leaves the row as it is
		expect(fixed.deliver(paid()).body.outcome).toBe("duplicate");
		expect(inputRows(raw)).toEqual([applied as Row]);
	});

	test("a refusal on the 409 list (a wait) stores nothing", () => {
		const h = harness();
		// an invoice_payment.paid whose invoice is not indexed yet, and a refund whose payment is not linked
		expect(h.deliver(linked("in_1")).body.outcome).toBe("unmatched_invoice");
		expect(h.deliver(refund(5000)).body.outcome).toBe("unmatched_payment");
		expect(count(h.raw, "atm_event_inputs")).toBe(0);
		expect(count(h.raw, "atm_input_contexts")).toBe(0);
	});
});

describe("what is never stored", () => {
	const foreign = (): RawEvent =>
		invoicePaid({
			eventId: "evt_other",
			invoiceId: "in_other",
			at: T0,
			subscriptionId: "sub_other",
			reason: "subscription_create",
			periodStart: T0,
			periodEnd: T0 + 30 * 24 * HOUR,
			lines: [{ lookupKey: tierKey(), amount: 100, interval: "month" }],
			metadata: {},
		});

	test("an ignored foreign event, an unmapped type, a livemode mismatch and an event that does not normalize", () => {
		const h = harness();
		expect(h.deliver(foreign()).body.outcome).toBe("ignored");
		expect(claimState(h.raw, "evt_other")).toBe("done");
		expect(
			h.deliver({ ...paid("in_2"), type: "customer.created" }).body.outcome,
		).toBe("ignored");
		expect(h.deliver({ ...paid("in_3"), livemode: false }).body.outcome).toBe(
			"livemode_mismatch",
		);
		const response = h.deliver({ ...paid("in_4"), api_version: "2019-01-01" });
		expect(response.status).toBe(422);
		expect(response.body.reason).toBe("unknown_mapping");
		expect(count(h.raw, "atm_event_inputs")).toBe(0);
		expect(count(h.raw, "atm_input_contexts")).toBe(0);
		expect(inputsStatus(h.db)).toEqual({ available: false, reason: "empty" });
	});
});

describe("the applied order", () => {
	const deliveredDir = join(
		import.meta.dir,
		"../fixtures/billing/stripe/recorded/delivered",
	);
	const scenarios = readdirSync(deliveredDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const eventsOf = (scenario: string): RawEvent[] =>
		readdirSync(join(deliveredDir, scenario))
			.filter((name) => name.endsWith(".json"))
			.sort()
			.map((name) =>
				JSON.parse(readFileSync(join(deliveredDir, scenario, name), "utf8")),
			);

	/** Delivers in created order, then retries the 409s as Stripe does; returns the ids in the order of the 200 answers that applied. */
	const run = (scenario: string) => {
		const h = harness(undefined, {
			school: RECORDED_SCHOOL,
			menu: recordedMenu,
			env: "test",
			priceIds: recordedPriceIds(),
		});
		const events = eventsOf(scenario);
		const answered: string[] = [];
		let waited = false;
		let pending = events;
		for (let pass = 0; pass < 4 && pending.length > 0; pass += 1) {
			const retry: RawEvent[] = [];
			for (const event of pending) {
				const response = h.deliver(event, event.created * 1000);
				if (response.status === 409) {
					waited = true;
					retry.push(event);
				} else if (
					response.status === 200 &&
					["applied", "non_usd"].includes(response.body.outcome)
				)
					answered.push(event.id);
			}
			pending = retry;
		}
		expect(pending).toEqual([]);
		return { h, events, answered, waited };
	};

	test.each(scenarios)(
		"%s: applied_order is the order of the 200 answers, and differs from the created order where the handler waited",
		(scenario) => {
			const { h, events, answered, waited } = run(scenario);
			const stored = inputRows(h.raw).map((row) => row.event_id);
			expect(stored).toEqual(answered);
			expect(inputRows(h.raw).every((row) => row.outcome === "applied")).toBe(
				true,
			);
			const created = events
				.map((event) => event.id)
				.filter((id) => answered.includes(id));
			if (waited) expect(stored).not.toEqual(created);
			else expect(stored).toEqual(created);
			// every row is strictly increasing in applied_order
			const orders = inputRows(h.raw).map((row) => row.applied_order);
			expect(orders).toEqual([...orders].sort((a, b) => a - b));
		},
	);

	test("the scenarios where the handler waited are the ones the design counts: 6 of 8", () => {
		const waitedCount = scenarios.filter((scenario) => run(scenario).waited);
		expect(scenarios).toHaveLength(8);
		expect(waitedCount).toHaveLength(6);
	});
});

/** A database wrapper that throws on the statements `fail` matches, so a write can be made to fail at one chosen point. */
const failing = (
	base: SqlDatabase,
	fail: (sql: string) => boolean,
): SqlDatabase => ({
	exec: (sql) => base.exec(sql),
	all: (sql, params) => base.all(sql, params),
	run: (sql, params) => {
		if (fail(sql)) throw new Error("injected failure");
		return base.run(sql, params);
	},
	transaction: (fn) => base.transaction(fn),
});

const bunDb = (raw: Database): SqlDatabase => bunSqlite(raw);

describe("the input is written in the delivery's one transaction", () => {
	const nothingCommitted = (raw: Database) => {
		expect(count(raw, "atm_event_inputs")).toBe(0);
		expect(count(raw, "atm_input_contexts")).toBe(0);
		expect(count(raw, "atm_input_seeds")).toBe(0);
		expect(count(raw, "ledger_outbox")).toBe(0);
		expect(count(raw, "atm_rows")).toBe(0);
		expect(count(raw, "atm_subjects")).toBe(0);
		expect(count(raw, "atm_invoice_index")).toBe(0);
	};

	test("a crash after the outbox append leaves no input, no outbox row and the claim claimed", () => {
		const h = harness();
		const healthy = h.deps.db;
		h.deps.db = failing(healthy, (sql) =>
			sql.startsWith("INSERT INTO atm_invoice_index"),
		);
		expect(() => h.deliver(paid())).toThrow("injected failure");
		nothingCommitted(h.raw);
		expect(claimState(h.raw, "evt_in_1")).toBe("claimed");
		// the retry after the stale window is applied and stores its input once
		h.deps.db = healthy;
		expect(h.deliver(paid(), T0 + 10 * MINUTE).body.outcome).toBe("applied");
		expect(count(h.raw, "atm_event_inputs")).toBe(1);
		expect(claimState(h.raw, "evt_in_1")).toBe("done");
	});

	test("a failure in the input write alone leaves the claim not done and no outbox rows", () => {
		const h = harness();
		const healthy = h.deps.db;
		h.deps.db = failing(healthy, (sql) =>
			sql.startsWith("INSERT INTO atm_event_inputs"),
		);
		expect(() => h.deliver(paid())).toThrow("injected failure");
		nothingCommitted(h.raw);
		expect(claimState(h.raw, "evt_in_1")).toBe("claimed");
	});

	test("a failure in the claim's done mark leaves no input row either", () => {
		const h = harness();
		const healthy = h.deps.db;
		h.deps.db = failing(healthy, (sql) =>
			sql.startsWith("UPDATE atm_event_claims SET state = 'done'"),
		);
		expect(() => h.deliver(paid())).toThrow("injected failure");
		nothingCommitted(h.raw);
		expect(claimState(h.raw, "evt_in_1")).toBe("claimed");
	});

	test("a failure in the input write of an invoice_payment.paid leaves its claim claimed and no payment index row", () => {
		const h = harness();
		h.deliver(paid("in_1"));
		const healthy = h.deps.db;
		h.deps.db = failing(healthy, (sql) =>
			sql.startsWith("INSERT INTO atm_event_inputs"),
		);
		expect(() => h.deliver(linked("in_1"), T0 + 1000)).toThrow(
			"injected failure",
		);
		expect(count(h.raw, "atm_payment_index")).toBe(0);
		expect(claimState(h.raw, "evt_link_in_1")).toBe("claimed");
		expect(count(h.raw, "atm_event_inputs")).toBe(1);
	});

	test("a refusal's input is written in the transaction that releases the claim", () => {
		const raw = new Database(":memory:");
		const broken = harness(undefined, {
			raw,
			menu: { ...menu, tiers: [] },
		});
		const healthy = broken.deps.db;
		broken.deps.db = failing(healthy, (sql) =>
			sql.startsWith("INSERT INTO atm_event_inputs"),
		);
		expect(() => broken.deliver(paid())).toThrow("injected failure");
		expect(count(raw, "atm_event_inputs")).toBe(0);
		expect(claimState(raw, "evt_in_1")).toBe("claimed");
	});
});

/** The renewal of `paid()`'s subscription (the same family), a month on. */
const renewal = (invoiceId: string, at: number): RawEvent =>
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

describe("a holder that already has rows", () => {
	test("its rows and revision are stored as its seed at its first stored input, once", () => {
		const h = harness();
		h.deliver(paid("in_1"));
		const rowsBefore = h.raw
			.query(
				`SELECT table_name, row_id, data FROM atm_rows ORDER BY table_name, row_id`,
			)
			.all() as { table_name: string; row_id: string; data: string }[];
		// the first delivery was before the upgrade: nothing of it was stored
		h.raw.run(`DELETE FROM atm_event_inputs`);
		h.raw.run(`DELETE FROM atm_input_contexts`);
		for (const [invoiceId, at] of [
			["in_2", T1],
			["in_3", T1 + 30 * 24 * HOUR],
		] as const)
			expect(h.deliver(renewal(invoiceId, at), at).body.outcome).toBe(
				"applied",
			);
		const seeds = h.raw.query(`SELECT * FROM atm_input_seeds`).all() as {
			subject_key: string;
			revision: number;
			first_event_id: string;
			rows: string;
		}[];
		expect(seeds).toHaveLength(1);
		expect(seeds[0]).toMatchObject({
			subject_key: `${SCHOOL}|live|family:${FAMILY}`,
			revision: 1,
			first_event_id: "evt_in_2",
		});
		const stored = JSON.parse(seeds[0]?.rows ?? "[]") as {
			table: string;
			id: string;
			data: unknown;
		}[];
		expect(
			stored.map((row) => [row.table, row.id, JSON.stringify(row.data)]),
		).toEqual(rowsBefore.map((row) => [row.table_name, row.row_id, row.data]));
		// the revisions chain: the seed's, then each input starts where the one before ended
		const [first, second] = inputRows(h.raw);
		expect(first?.revision_before).toBe(1);
		expect(first?.revision_after).toBeGreaterThan(1);
		expect(second?.revision_before).toBe(first?.revision_after as number);
		expect(inputsStatus(h.db, { env: "live", school: SCHOOL })).toMatchObject({
			available: true,
			applied: 2,
			seeds: 1,
		});
	});
});

describe("erasure", () => {
	const OTHER = "fam_other";
	/** A family's first invoice creates its subscription; a later one is its renewal. */
	const deliverFor = (
		h: ReturnType<typeof harness>,
		family: string,
		invoiceId: string,
		at: number,
		reason:
			| "subscription_create"
			| "subscription_cycle" = "subscription_create",
	) => {
		const response = h.deliver(
			invoicePaid({
				eventId: `evt_${invoiceId}`,
				invoiceId,
				at,
				subscriptionId: `sub_${family}`,
				reason,
				periodStart: at,
				periodEnd: at + 30 * 24 * HOUR,
				lines: [{ lookupKey: tierKey(), amount: 26_000, interval: "month" }],
				metadata: { b4u_school: SCHOOL, family_id: family },
			}),
			at,
		);
		expect(response.body.outcome).toBe("applied");
		return response;
	};
	const keyOf = (family: string) => `${SCHOOL}|live|family:${family}`;

	test("tombstones the holder's inputs and removes its seed; other holders' inputs and the ledger's money events stay", () => {
		const h = harness({ in_a1: 784, in_a2: 784, in_b1: 784 });
		h.deps.paymentRefs = () => ["pi_x"];
		deliverFor(h, FAMILY, "in_a1", T0);
		// pre-upgrade history for the holder: its first stored input seeds
		h.raw.run(`DELETE FROM atm_event_inputs`);
		h.raw.run(`DELETE FROM atm_input_contexts`);
		deliverFor(h, FAMILY, "in_a2", T1, "subscription_cycle");
		deliverFor(h, OTHER, "in_b1", T0 + 2 * HOUR);
		expect(count(h.raw, "atm_input_seeds")).toBe(1);
		const outboxBefore = h.raw
			.query(`SELECT * FROM ledger_outbox ORDER BY id`)
			.all();
		const rowsBefore = h.raw
			.query(`SELECT * FROM atm_rows ORDER BY subject_key, table_name, row_id`)
			.all();
		const otherBefore = inputRows(
			h.raw,
			`WHERE subject_key = '${keyOf(OTHER)}'`,
		);
		const mine = inputRows(h.raw, `WHERE subject_key = '${keyOf(FAMILY)}'`);
		expect(mine).toHaveLength(1);

		const done = eraseStoredInputs(h.db, {
			env: "live",
			school: SCHOOL,
			subjectKey: keyOf(FAMILY),
			nowMs: QUEUED_AT,
		});
		expect(done).toEqual({ inputs: 1, seeds: 1, queued: 0 });

		const [tombstone] = inputRows(h.raw, `WHERE event_id = 'evt_in_a2'`);
		expect(tombstone).toMatchObject({
			body: null,
			subject_key: null,
			payment_refs: null,
			booking_refs: null,
			fee: null,
			raw_sha256: null,
			erased_at: QUEUED_AT,
			// what names no person is kept
			env: "live",
			event_id: "evt_in_a2",
			school_id: SCHOOL,
			type: "invoice.paid",
			mapping: "stripe/invoice.paid@v1",
			outcome: "applied",
			applied_order: mine[0]?.applied_order,
			input_id: mine[0]?.input_id,
			stripe_created: mine[0]?.stripe_created,
			atm_version: ATM_VERSION,
		});
		expect(count(h.raw, "atm_input_seeds")).toBe(0);
		// the other holder is untouched, byte for byte
		expect(inputRows(h.raw, `WHERE subject_key = '${keyOf(OTHER)}'`)).toEqual(
			otherBefore,
		);
		// the ledger's money events and the rows stay
		expect(
			h.raw.query(`SELECT * FROM ledger_outbox ORDER BY id`).all(),
		).toEqual(outboxBefore);
		expect(
			h.raw
				.query(
					`SELECT * FROM atm_rows ORDER BY subject_key, table_name, row_id`,
				)
				.all(),
		).toEqual(rowsBefore);
		expect(inputsStatus(h.db, { env: "live", school: SCHOOL })).toMatchObject({
			available: true,
			applied: 1,
			erased: 1,
			seeds: 0,
		});
		// a read for a replay: the tombstone is an input without a fact, the other holder's has its fact
		const read = readInputs(h.db, { env: "live", school: SCHOOL });
		expect(
			read.inputs.map((input) => [input.eventId, input.fact === null]),
		).toEqual([
			["evt_in_a2", true],
			["evt_in_b1", false],
		]);
		expect(read.seeds.size).toBe(0);
	});

	test("is idempotent", () => {
		const h = harness();
		deliverFor(h, FAMILY, "in_a1", T0);
		const args = {
			env: "live" as const,
			school: SCHOOL,
			subjectKey: keyOf(FAMILY),
			nowMs: QUEUED_AT,
		};
		expect(eraseStoredInputs(h.db, args)).toMatchObject({ inputs: 1 });
		const after = inputRows(h.raw);
		expect(eraseStoredInputs(h.db, { ...args, nowMs: QUEUED_AT + 1 })).toEqual({
			inputs: 0,
			seeds: 0,
			queued: 0,
		});
		expect(inputRows(h.raw)).toEqual(after);
	});

	test("queues the shipped batches that held the holder, and its shipped seed, and no others", () => {
		const h = harness();
		deliverFor(h, FAMILY, "in_a1", T0);
		h.raw.run(`DELETE FROM atm_event_inputs`);
		deliverFor(h, FAMILY, "in_a2", T1, "subscription_cycle");
		deliverFor(h, OTHER, "in_b1", T0 + 2 * HOUR);
		deliverFor(h, FAMILY, "in_a3", T1 + 30 * 24 * HOUR, "subscription_cycle");
		const prefix = `schools/${SCHOOL}/inputs/live/date=2026-01-15`;
		const shared = `${prefix}/batch-000000000001-aaaaaaaaaaaaaaaa.jsonl`;
		const mineOnly = `${prefix}/batch-000000000004-bbbbbbbbbbbbbbbb.jsonl`;
		const othersOnly = `${prefix}/batch-000000000009-cccccccccccccccc.jsonl`;
		h.raw.run(
			`UPDATE atm_event_inputs SET batch_key = ?, shipped_at = 1 WHERE event_id IN ('evt_in_a2', 'evt_in_b1')`,
			[shared] as never,
		);
		h.raw.run(
			`UPDATE atm_event_inputs SET batch_key = ?, shipped_at = 1 WHERE event_id = 'evt_in_a3'`,
			[mineOnly] as never,
		);
		h.raw.run(`UPDATE atm_input_seeds SET shipped_at = 1`);
		h.raw.run(
			`INSERT INTO atm_event_inputs (env, event_id, school_id, subject_key, type, api_version, mapping, stripe_created, received_at, outcome, atm_version, input_id, batch_key, shipped_at) VALUES ('live', 'evt_x', ?, ?, 'invoice.paid', 'v', 'm', 1, 1, 'applied', 'v', 'i', ?, 1)`,
			[SCHOOL, keyOf("fam_third"), othersOnly] as never,
		);

		const done = eraseStoredInputs(h.db, {
			env: "live",
			school: SCHOOL,
			subjectKey: keyOf(FAMILY),
			nowMs: QUEUED_AT,
		});
		expect(done).toEqual({ inputs: 2, seeds: 1, queued: 3 });
		const queue = h.raw
			.query(
				`SELECT env, school_id, object_key, kind, queued_at, replacement_key, done_at FROM atm_input_erasures ORDER BY object_key`,
			)
			.all();
		expect(queue).toEqual(
			[
				[shared, "batch"],
				[mineOnly, "batch"],
				[
					shippedSeedKey({
						school: SCHOOL,
						env: "live",
						subjectKey: keyOf(FAMILY),
					}),
					"seed",
				],
			]
				.sort((a, b) => (a[0] as string).localeCompare(b[0] as string))
				.map(([objectKey, kind]) => ({
					env: "live",
					school_id: SCHOOL,
					object_key: objectKey,
					kind,
					queued_at: QUEUED_AT,
					replacement_key: null,
					done_at: null,
				})),
		);
		// the other holders keep their batch marks
		expect(inputRows(h.raw, `WHERE event_id = 'evt_in_b1'`)[0]).toMatchObject({
			batch_key: shared,
			shipped_at: 1,
		});
		// the tombstones keep theirs, so a shipper can find what to rewrite
		expect(inputRows(h.raw, `WHERE event_id = 'evt_in_a3'`)[0]?.batch_key).toBe(
			mineOnly,
		);
		// a second call queues nothing more
		expect(
			eraseStoredInputs(h.db, {
				env: "live",
				school: SCHOOL,
				subjectKey: keyOf(FAMILY),
				nowMs: QUEUED_AT + 1,
			}),
		).toEqual({ inputs: 0, seeds: 0, queued: 0 });
		expect(count(h.raw, "atm_input_erasures")).toBe(3);
	});
});

describe("reading", () => {
	test("sqliteInputsSource returns what readInputs does, and an older database reads as empty", async () => {
		const h = harness({ in_1: 784 });
		h.deliver(paid());
		const read = await sqliteInputsSource(h.db).read({
			env: "live",
			school: SCHOOL,
		});
		expect(read).toEqual(readInputs(h.db, { env: "live", school: SCHOOL }));
		expect(read.inputs).toHaveLength(1);
		expect(read.inputs[0]).toMatchObject({
			eventId: "evt_in_1",
			fee: 784,
			livemode: expect.anything(),
			outcome: "applied",
		});
		expect(read.contexts.size).toBe(1);
		const other = await sqliteInputsSource(h.db).read({
			env: "test",
			school: SCHOOL,
		});
		expect(other.inputs).toEqual([]);

		const old = bunDb(new Database(":memory:"));
		expect(inputsStatus(old)).toEqual({ available: false, reason: "no_table" });
		const empty = await sqliteInputsSource(old).read({
			env: "live",
			school: SCHOOL,
		});
		expect(empty.inputs).toEqual([]);
	});
});

describe("the new tables are additive", () => {
	const inputTables = [
		"atm_event_inputs",
		"atm_input_contexts",
		"atm_input_seeds",
		"atm_input_erasures",
	];
	const shapeOfSchema = (raw: Database) =>
		raw
			.query(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`)
			.all();

	test("HANDLER_DDL twice is a no-op", () => {
		const raw = new Database(":memory:");
		raw.exec(HANDLER_DDL);
		const once = shapeOfSchema(raw);
		raw.exec(HANDLER_DDL);
		expect(shapeOfSchema(raw)).toEqual(once);
		expect((once as { name: string }[]).map((entry) => entry.name)).toEqual(
			expect.arrayContaining(inputTables),
		);
	});

	test("a database made before the inputs gets the tables from the DDL, with its rows untouched", () => {
		const h = harness();
		h.deliver(paid("in_1"));
		h.deliver(linked("in_1"), T0 + 1000);
		const keep = [
			"atm_event_claims",
			"ledger_outbox",
			"atm_rows",
			"atm_subjects",
			"atm_invoice_index",
			"atm_payment_index",
		];
		const before = Object.fromEntries(
			keep.map((table) => [table, h.raw.query(`SELECT * FROM ${table}`).all()]),
		);
		for (const table of inputTables) h.raw.exec(`DROP TABLE ${table}`);
		expect(inputsStatus(h.db)).toEqual({
			available: false,
			reason: "no_table",
		});
		// migrateHandlerSchema has nothing to rebuild for them
		expect(migrateHandlerSchema(h.db)).toEqual({ rebuilt: [] });
		h.raw.exec(HANDLER_DDL);
		for (const table of keep)
			expect(h.raw.query(`SELECT * FROM ${table}`).all()).toEqual(
				before[table] as never,
			);
		expect(inputsStatus(h.db)).toEqual({ available: false, reason: "empty" });
	});

	test("a handler on a database without them stops with an error that names HANDLER_DDL, before it touches anything", () => {
		const raw = new Database(":memory:");
		const h = harness(undefined, { raw });
		for (const table of inputTables) raw.exec(`DROP TABLE ${table}`);
		expect(() => h.deliver(paid())).toThrow(/HANDLER_DDL/);
		expect(count(raw, "atm_event_claims")).toBe(0);
		expect(count(raw, "ledger_outbox")).toBe(0);
		// and so does the writer, called alone
		expect(() =>
			eraseStoredInputs(h.db, {
				env: "live",
				school: SCHOOL,
				subjectKey: "x",
				nowMs: 1,
			}),
		).toThrow(/atm_event_inputs/);
	});

	test("the constraints hold: one row per (env, event_id), a refusal has a reason and an applied row has none", () => {
		const raw = new Database(":memory:");
		raw.exec(HANDLER_DDL);
		const insert = (outcome: string, reason: string | null, eventId = "e1") =>
			raw.run(
				`INSERT INTO atm_event_inputs (env, event_id, school_id, type, api_version, mapping, stripe_created, received_at, outcome, reason, atm_version, input_id) VALUES ('live', ?, 's', 't', 'v', 'm', 1, 1, ?, ?, 'v', 'i')`,
				[eventId, outcome, reason] as never,
			);
		expect(() => insert("refused", null)).toThrow();
		expect(() => insert("applied", "rejected")).toThrow();
		insert("applied", null);
		expect(() => insert("applied", null)).toThrow();
		expect(() =>
			raw.run(
				`INSERT INTO atm_event_inputs (env, event_id, school_id, type, api_version, mapping, stripe_created, received_at, outcome, atm_version, input_id) VALUES ('prod', 'e2', 's', 't', 'v', 'm', 1, 1, 'applied', 'v', 'i')`,
			),
		).toThrow();
	});
});
