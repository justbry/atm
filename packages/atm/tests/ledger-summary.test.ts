import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { readEvents } from "../src/ledger/files.js";
import { ledgerEvent } from "../src/ledger/postings.js";
import { replayEvents } from "../src/ledger/replay.js";
import { memberSummary, membersOf } from "../src/ledger/summary.js";
import type { AtmCatalogRow, AtmEvent } from "../src/types.js";
import { createStore } from "./billing-store.js";
import { invoicePaid } from "./stripe-events.js";

const FIXTURES = join(import.meta.dir, "../fixtures");
const readJson = (...path: string[]) =>
	JSON.parse(readFileSync(join(FIXTURES, ...path), "utf8"));
const AS_OF = new Date("2027-03-01T00:00:00Z");

const loadFixture = async (dir: string, school: string) => ({
	events: (await readEvents(join(FIXTURES, dir), school)).events,
	catalog: readJson(dir, "catalog.json") as AtmCatalogRow[],
});

const unwrap = <Value extends { ok: boolean }>(
	result: Value,
): Extract<Value, { ok: true }> => {
	if (!result.ok) throw new Error(JSON.stringify(result));
	return result as Extract<Value, { ok: true }>;
};

describe("membersOf", () => {
	test("vibes-year: available and held are the replay's balances, used is the net of spent and forfeited postings", async () => {
		const { events, catalog } = await loadFixture("vibes-year", "sch_vol");
		const result = unwrap(membersOf(events, AS_OF, { catalog }));
		const replayed = replayEvents({
			events,
			catalog,
			asOf: AS_OF.toISOString(),
		});
		const member = result.members["family:fam_th6z"];
		expect(member).toBeDefined();
		const balance = replayed.balances.find(
			(b) => b.holder === "family:fam_th6z" && b.feature === "visit",
		);
		expect(member?.features.visit?.available).toBe(balance?.avail as number);
		expect(member?.features.visit?.held).toBe(balance?.held as number);
		// the fixture's committed posting totals: spent 8 + 3 + 4 and forfeited 1
		expect(member?.features.visit?.used).toBe(16);
		expect(member?.plan).toBeTypeOf("string");
		expect(member?.lastEventAt).toBe(
			[...events].sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1)?.event_time ??
				null,
		);
		expect(result.asOf).toBe("2027-03-01T00:00:00Z");
	});

	test("vibes-multi: every holder with credit or plan events is a member and none has negative used", async () => {
		const { events, catalog } = await loadFixture("vibes-multi", "sch_multi");
		const result = unwrap(membersOf(events, AS_OF, { catalog }));
		const holders = new Set(
			events
				.filter((e) => e.event_type.startsWith("credit."))
				.map((e) => e.key),
		);
		expect(holders.size).toBeGreaterThan(1);
		expect(new Set(Object.keys(result.members))).toEqual(
			new Set([
				...holders,
				...events
					.filter((e) => e.event_type.startsWith("plan."))
					.map((e) => e.key),
			]),
		);
		for (const member of Object.values(result.members))
			for (const feature of Object.values(member.features))
				expect(feature.used).toBeGreaterThanOrEqual(0);
	});

	test("nextExpiryAt is the earliest expiry still ahead of asOf, and moves on as asOf does", async () => {
		const { events, catalog } = await loadFixture("vibes-year", "sch_vol");
		const early = unwrap(
			membersOf(events, new Date("2026-02-01T00:00:00Z"), { catalog }),
		).members["family:fam_th6z"]?.features.visit;
		expect(early?.nextExpiryAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(Date.parse(early?.nextExpiryAt as string)).toBeGreaterThan(
			Date.parse("2026-02-01T00:00:00Z"),
		);
		const late = unwrap(membersOf(events, AS_OF, { catalog })).members[
			"family:fam_th6z"
		]?.features.visit;
		expect(late?.nextExpiryAt ?? "9999").not.toBe(early?.nextExpiryAt);
	});

	test("memberSummary is one entry of membersOf, and null for a key the log does not know", async () => {
		const { events, catalog } = await loadFixture("vibes-year", "sch_vol");
		const all = unwrap(membersOf(events, AS_OF, { catalog }));
		const one = unwrap(
			memberSummary(events, "family:fam_th6z", AS_OF, { catalog }),
		);
		expect(one.summary).toEqual(all.members["family:fam_th6z"] ?? null);
		expect(
			unwrap(memberSummary(events, "family:nobody", AS_OF, { catalog }))
				.summary,
		).toBeNull();
	});

	test("the output carries no name or email, whatever the events' payloads hold", async () => {
		const { events, catalog } = await loadFixture("vibes-year", "sch_vol");
		const tainted = events.map((e) =>
			e.event_type === "payment.succeeded"
				? {
						...e,
						payload: {
							...e.payload,
							billing_email: "someone@example.com",
							billing_name: "Someone Named",
						},
					}
				: e,
		);
		const text = JSON.stringify(membersOf(tainted, AS_OF, { catalog }));
		expect(text).not.toContain("example.com");
		expect(text).not.toContain("Someone");
	});
});

describe("membersOf on a log it cannot replay", () => {
	test("a 0.3.0 log with a lost command comes back as a replay-gap value, not a throw", () => {
		const dir = join(FIXTURES, "log-0.3.0");
		const events = readFileSync(
			join(dir, "sparkle-2-year/events.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as AtmEvent);
		const catalog = readJson("log-0.3.0", "catalog.json") as AtmCatalogRow[];
		const result = membersOf(events, AS_OF, { catalog });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatchObject({
			kind: "replay-gap",
			subject: "family:fam_old",
			after: 2,
			before: 3,
		});
		expect(memberSummary(events, "family:fam_old", AS_OF, { catalog }).ok).toBe(
			false,
		);
	});

	test("an event the engine decides differently is a replay value", async () => {
		const { events, catalog } = await loadFixture("vibes-year", "sch_vol");
		const broken = events.map((e) =>
			e.event_type === "credit.held"
				? { ...e, postings: [], text: "tampered" }
				: e,
		);
		const result = membersOf(broken, AS_OF, { catalog });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("replay");
	});

	test("without catalog rows or a catalog.published event the answer is no-catalog", async () => {
		const { events } = await loadFixture("vibes-year", "sch_vol");
		const result = membersOf(events, AS_OF);
		expect(result).toMatchObject({ ok: false, error: { kind: "no-catalog" } });
	});
});

describe("the catalog from the log itself", () => {
	const SCHOOL = "sch_vol";
	const FAMILY = "fam_summary";
	const menu = readJson("billing/grants/menu.json") as Menu;
	const T0 = Date.parse("2026-01-15T18:00:00Z");
	const T1 = Date.parse("2026-02-15T18:00:00Z");

	test("the latest catalog.published event's menu is the catalog, equal to giving its rows", () => {
		const store = createStore({ menu, school: SCHOOL, family: FAMILY });
		const price = menu.tiers
			.find((t) => t.id === "sparkle-2")
			?.prices.find((p) => p.interval === "month")?.amount as number;
		store.handle(
			invoicePaid({
				eventId: "evt_in_1",
				invoiceId: "in_1",
				at: T0 + 10_000,
				subscriptionId: "sub_1",
				reason: "subscription_create",
				periodStart: T0,
				periodEnd: T1,
				lines: [
					{
						lookupKey: lookupKeyOf(
							SCHOOL,
							tierPriceKey("sparkle-2", "month"),
							price,
							menu.currency,
						),
						amount: price,
						interval: "month",
					},
				],
				metadata: { b4u_school: SCHOOL, family_id: FAMILY },
			}),
			T0 + 10_000,
		);
		const published = ledgerEvent({
			type: "catalog.published",
			school: SCHOOL,
			tz: menu.timeZone,
			eventTime: Date.UTC(2026, 0, 1),
			key: SCHOOL,
			idem: "settings:catalog:1",
			payload: { plans: ["sparkle-2@v1"], menu, version: 1 },
		});
		const events = [...store.events, published];
		const asOf = new Date(T0 + 86_400_000);
		const derived = unwrap(membersOf(events, asOf));
		const given = unwrap(
			membersOf(store.events, asOf, {
				catalog: menuCatalogRows({ menu, school: SCHOOL }),
			}),
		);
		expect(derived.members).toEqual(given.members);
		expect(
			derived.members[`family:${FAMILY}`]?.features.visit?.available,
		).toBeGreaterThan(0);
		expect(derived.members[SCHOOL]).toBeUndefined();
	});
});
