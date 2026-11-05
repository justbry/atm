import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateYear } from "../fixtures/vibes.js";
import { menuCatalogRows } from "../src/billing/grants.js";
import { stateFromRows } from "../src/billing/rows.js";
import type { Menu } from "../src/billing/types.js";
import { replayEvents } from "../src/ledger/replay.js";
import { canonicalize } from "../src/ledger/util.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent } from "../src/types.js";
import { engineRowsOf } from "./billing-store.js";
import { replayYear, settingsOf, yearInputs } from "./replay-inputs.js";
import { shapeProblems } from "./stripe-shape.js";

const menu = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../fixtures/billing/grants/menu.json"),
		"utf8",
	),
) as Menu;
const GOLDEN = join(import.meta.dir, "golden/replay/decisions.jsonl");

const year = generateYear({ seed: 1 });
const inputs = yearInputs(year, menu);
const replay = replayYear({ year, inputs });

/** What an event says, without how it was made: not its id, idem, cause, source, payload or the second it ran. */
const meaning = (e: AtmEvent) =>
	canonicalize({
		type: e.event_type,
		date: e.date,
		feature: e.labels.feature,
		text: e.text,
		postings: e.postings,
		rolled_over: e.labels.rolled_over,
		expires_at: e.labels.expires_at,
	});
const sorted = (events: readonly AtmEvent[]) => events.map(meaning).sort();

describe("the fixture year, replayed from its inputs", () => {
	test("the inputs are settings and raw Stripe events, and the bookings the family service made", () => {
		expect(inputs.settings.map((e) => e.event_type)).toEqual([
			"catalog.published",
			"policy.published",
		]);
		const kinds = inputs.steps.map((s) =>
			s.kind === "stripe" ? (s.event as { type: string }).type : s.kind,
		);
		expect(kinds.filter((k) => k === "invoice.paid")).toHaveLength(14); // 12 payments, 2 gifts
		expect(kinds.filter((k) => k === "charge.refunded")).toHaveLength(1);
		expect(kinds.filter((k) => k === "family").length).toBeGreaterThan(30);
		for (const event of inputs.settings)
			expect(validateEvent(event).ok).toBe(true);
	});

	test("every raw Stripe event fits Stripe's shape for the pinned API version", () => {
		for (const step of inputs.steps)
			if (step.kind === "stripe")
				expect(shapeProblems(step.event as Record<string, unknown>)).toEqual(
					[],
				);
	});

	test("the settings events give back the menu and the policy", () => {
		const s = settingsOf(inputs.settings);
		expect(s.menu).toEqual(menu);
		expect(s.menuVersion).toBe(1);
		expect(s.policyVersion).toBe(1);
	});

	test("a settings event without its menu or policy and version is not valid, and settingsOf will not read it", () => {
		const [catalog, policy] = inputs.settings as [AtmEvent, AtmEvent];
		const without = (e: AtmEvent, key: string): AtmEvent => {
			const payload = { ...e.payload };
			delete payload[key];
			return { ...e, payload };
		};
		expect(validateEvent(without(catalog, "menu")).ok).toBe(false);
		expect(validateEvent(without(catalog, "version")).ok).toBe(false);
		expect(validateEvent(without(policy, "policy")).ok).toBe(false);
		expect(() => settingsOf([without(catalog, "menu"), policy])).toThrow(
			/catalog.published/,
		);
		expect(() => settingsOf([catalog, without(policy, "policy")])).toThrow(
			/policy.published/,
		);
	});

	test("the decision events are valid events, each naming the input that caused it", () => {
		const fromStripe = replay.decisions.filter((e) => e.source !== "cron");
		expect(fromStripe.length).toBeGreaterThanOrEqual(15); // a grant or reset for each of 12 payments, 2 gifts, the refund
		for (const e of replay.decisions) {
			const result = validateEvent(e);
			expect(result.errors).toEqual([]);
		}
		for (const e of fromStripe) {
			expect(e.cause).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
			expect(Object.keys(e.labels)).toEqual(
				expect.arrayContaining(["menu_version", "policy_version", "mapping"]),
			);
		}
	});

	test("every event's postings sum to zero in each commodity", () => {
		for (const e of replay.credit) {
			const by = new Map<string, number>();
			for (const p of e.postings)
				by.set(p.commodity, (by.get(p.commodity) ?? 0) + Number(p.amount));
			expect([...by.values()].every((v) => v === 0)).toBe(true);
		}
	});

	test("the credit events equal the fixture's own: grants, rollovers, the gifts, the refund, the expiries", () => {
		expect(sorted(replay.credit)).toEqual(sorted(inputs.expectedCredit));
	});

	test("the final balances equal expected.json", () => {
		expect(replay.balances).toEqual(year.expected.balances);
	});

	test("the credit postings total what expected.json totals, account by account", () => {
		const totals: Record<string, number> = {};
		for (const e of replay.credit)
			for (const p of e.postings)
				if (p.account.startsWith("credits:"))
					totals[`${p.account} ${p.commodity}`] =
						(totals[`${p.account} ${p.commodity}`] ?? 0) + Number(p.amount);
		const expected = Object.fromEntries(
			Object.entries(year.expected.postingTotals)
				.filter(([k]) => k.startsWith("credits:"))
				.map(([k, v]) => [k, Number(v)]),
		);
		expect(totals).toEqual(expected);
	});

	test("the decisions are the committed golden (tests/golden/replay/decisions.jsonl)", () => {
		const text = `${replay.decisions.map((e) => JSON.stringify(e)).join("\n")}\n`;
		if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, text);
		expect(text).toBe(readFileSync(GOLDEN, "utf8"));
	});

	test("the decisions and the family's bookings, replayed through the engine, end on the rows and balances of the year", () => {
		const replayed = replayEvents({
			events: replay.log,
			catalog: menuCatalogRows({ menu, school: inputs.school }),
			asOf: year.expected.asOf,
		});
		const live = stateFromRows({
			identity: {
				orgId: inputs.school,
				env: "live",
				customerId: inputs.holder,
				entityId: null,
			},
			revision: replay.revision,
			rows: replay.rows,
		});
		expect(engineRowsOf(replayed.snapshot.states[inputs.holder])).toBe(
			engineRowsOf(live),
		);
		expect(replayed.balances).toEqual(replay.balances);
	});

	test("replaying again gives the same decisions and the same rows, byte for byte", () => {
		const again = replayYear({ year, inputs });
		expect(JSON.stringify(again.decisions)).toBe(
			JSON.stringify(replay.decisions),
		);
		expect(JSON.stringify(again.rows)).toBe(JSON.stringify(replay.rows));
		expect(again.revision).toBe(replay.revision);
	});
});
