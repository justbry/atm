import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { readEvents } from "../src/ledger/files.js";
import { ledgerEvent } from "../src/ledger/postings.js";
import { replayEvents } from "../src/ledger/replay.js";
import { eventsAsOf, memberSummary, membersOf } from "../src/ledger/summary.js";
import type { AtmCatalogRow, AtmEvent } from "../src/types.js";
import { createStore } from "./billing-store.js";
import {
	HOLDER,
	handBuiltLog,
	catalog as handCatalog,
	PLAN,
} from "./ledger-read-log.js";
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
		// the plan is the latest `labels.plan` of the member's events, not any string
		expect(member?.plan).toBe(
			[...events]
				.filter((e) => e.key === "family:fam_th6z" && e.labels.plan)
				.sort((a, b) => (a.id < b.id ? -1 : 1))
				.at(-1)?.labels.plan as string,
		);
		expect(member?.plan).toBe("sparkle-1@v1");
		expect(member?.lastEventAt).toBe(
			[...events].sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1)?.event_time ??
				null,
		);
		expect(result.asOf).toBe("2027-03-01T00:00:00Z");
	});

	test("vibes-multi: every holder with credit or plan events is a member, and each feature's used is its spent and forfeited postings net of refunds", async () => {
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
		let total = 0;
		for (const member of Object.values(result.members))
			for (const [feature, summary] of Object.entries(member.features)) {
				const expected = events
					.filter((e) => e.key === member.key && e.labels.feature === feature)
					.flatMap((e) => e.postings)
					.filter(
						(p) =>
							p.account.startsWith("credits:spent:") ||
							p.account === "credits:forfeited",
					)
					.reduce((sum, p) => sum + Number(p.amount), 0);
				expect(summary.used).toBe(expected);
				total += summary.used;
			}
		expect(total).toBeGreaterThan(0);
	});

	test("nextExpiryAt is the earliest expiry still ahead of asOf, and moves on as asOf does", async () => {
		const { events, catalog } = await loadFixture("vibes-year", "sch_vol");
		const visitAt = (at: string) =>
			unwrap(membersOf(events, new Date(at), { catalog })).members[
				"family:fam_th6z"
			]?.features.visit;
		// Feb 2026: one grant booked, nothing on it expires
		expect(visitAt("2026-02-01T00:00:00Z")?.nextExpiryAt).toBeNull();
		// June 2026: the Jun 17 grant is not booked yet, the rows held then expire on Sep 12
		expect(visitAt("2026-06-01T00:00:00Z")?.nextExpiryAt).toBe(
			"2026-09-12T18:08:00Z",
		);
		// Mar 2027: nothing left that holds credits and expires
		expect(visitAt("2027-03-01T00:00:00Z")?.nextExpiryAt).toBeNull();
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

describe("membersOf on a hand-built log", () => {
	const { events, at } = handBuiltLog();
	const summaryAt = (asOf: number) =>
		unwrap(membersOf(events, new Date(asOf), { catalog: handCatalog })).members[
			HOLDER
		];

	test("the plan payment grants 2 visits and the plan is its label", () => {
		expect(summaryAt(at.paid + 1000)).toEqual({
			key: HOLDER,
			plan: PLAN,
			features: {
				visit: { available: 2, held: 0, used: 0, nextExpiryAt: null },
			},
			lastEventAt: "2026-01-15T18:00:10Z",
		});
	});

	test("each spent visit is used, and a refunded visit comes off used and back to available", () => {
		expect(summaryAt(at.firstSpent + 1000)?.features.visit).toEqual({
			available: 1,
			held: 0,
			used: 1,
			nextExpiryAt: null,
		});
		expect(summaryAt(at.secondSpent + 1000)?.features.visit).toEqual({
			available: 0,
			held: 0,
			used: 2,
			nextExpiryAt: null,
		});
		const refunded = summaryAt(at.refunded + 1000);
		expect(refunded?.features.visit).toEqual({
			available: 1,
			held: 0,
			used: 1,
			nextExpiryAt: null,
		});
		expect(refunded?.lastEventAt).toBe("2026-01-21T18:00:00Z");
	});

	test("a hold that is not spent yet is held, not used", () => {
		const held = summaryAt(at.firstSpent - 1000)?.features.visit;
		expect(held).toEqual({
			available: 1,
			held: 1,
			used: 0,
			nextExpiryAt: null,
		});
	});
});

describe("asOf cuts the log", () => {
	test("an asOf in the middle of a log gives what a replay of only the earlier events gives", async () => {
		const { events, catalog } = await loadFixture("vibes-year", "sch_vol");
		const asOf = new Date("2026-06-01T00:00:00Z");
		const earlier = events.filter(
			(e) => Date.parse(e.event_time) <= asOf.getTime(),
		);
		expect(earlier.length).toBeGreaterThan(10);
		expect(earlier.length).toBeLessThan(events.length);
		const cut = unwrap(membersOf(events, asOf, { catalog }));
		const replayed = replayEvents({
			events: earlier,
			catalog,
			asOf: asOf.toISOString(),
		});
		for (const balance of replayed.balances) {
			const feature = cut.members[balance.holder]?.features[balance.feature];
			expect(feature?.available).toBe(balance.avail);
			expect(feature?.held).toBe(balance.held);
		}
		// the same answer from the earlier events alone: nothing after asOf is read for used, plan or lastEventAt
		expect(cut.members).toEqual(
			unwrap(membersOf(earlier, asOf, { catalog })).members,
		);
		const member = cut.members["family:fam_th6z"];
		expect(member?.plan).toBe("sparkle-2@v1");
		expect(member?.features.visit?.used).toBe(9);
		expect(member?.lastEventAt).toBe("2026-05-28T04:08:00Z");
	});

	test("a member whose first event is after asOf is not in the answer", async () => {
		const { events, catalog } = await loadFixture("vibes-multi", "sch_multi");
		const first = [...events]
			.filter((e) => e.event_type.startsWith("credit."))
			.sort((a, b) => (a.event_time < b.event_time ? -1 : 1))[0] as AtmEvent;
		const before = new Date(Date.parse(first.event_time) - 1000);
		expect(
			unwrap(membersOf(events, before, { catalog })).members[first.key],
		).toBeUndefined();
	});

	test("the cut is by event_time: a late-shipped event counts from the instant it happened", async () => {
		const { events } = await loadFixture("vibes-year", "sch_vol");
		const early = events[0] as AtmEvent;
		const shipped = { ...early, ingest_time: "2099-01-01T00:00:00Z" };
		const asOf = new Date(Date.parse(early.event_time) + 1000);
		expect(eventsAsOf([shipped], asOf)).toEqual([shipped]);
		expect(
			eventsAsOf([shipped], new Date(Date.parse(early.event_time) - 1)),
		).toEqual([]);
	});

	test("a later revision of a subject leaves with an earlier one that is cut, even when its own time is earlier", () => {
		const base = {
			school: "s",
			key: "family:fam_x",
			labels: {},
			postings: [],
			idem: "",
		} as unknown as AtmEvent;
		const at = (id: string, time: string, after: number): AtmEvent => ({
			...base,
			id,
			idem: id,
			event_time: time,
			payload: { mutation: { revision: { before: after - 1, after } } },
		});
		// revision 1 (the payment) is stamped after revision 2 (the reset the engine ran for the period start)
		const payment = at("evt_1", "2026-01-15T18:00:00Z", 1);
		const reset = at("evt_2", "2026-01-15T15:00:00Z", 2);
		const noMutation = {
			...base,
			id: "evt_0",
			idem: "evt_0",
			event_time: "2026-01-15T12:00:00Z",
			payload: {},
		} as AtmEvent;
		const asOf = new Date("2026-01-15T16:00:00Z");
		expect(eventsAsOf([payment, reset, noMutation], asOf)).toEqual([
			noMutation,
		]);
		expect(
			eventsAsOf(
				[payment, reset, noMutation],
				new Date("2026-01-15T19:00:00Z"),
			),
		).toEqual([payment, reset, noMutation]);
	});
});
