import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EMPTY_GRANTS_STATE, menuCatalogRows } from "../src/billing/grants.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import { commandOrg, DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	applyRowChanges,
	type BillingRow,
	GRANTS_TABLE,
	grantsFromRows,
	StaleRevision,
	stateFromRows,
} from "../src/billing/rows.js";
import {
	addonPriceKey,
	lookupKeyOf,
	menuLineItems,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type {
	BillingPolicy,
	Menu,
	StripeEventResult,
} from "../src/billing/types.js";
import { deterministicUlid } from "../src/ledger/ids.js";
import { balancesOf, replayEvents } from "../src/ledger/replay.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import { canonicalize } from "../src/ledger/util.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent } from "../src/types.js";
import {
	chargeRefunded,
	disputeEvent,
	invoicePaid,
	paymentIntentOf,
	priceIdOf,
	subscriptionDeleted,
	subscriptionEvent,
} from "./stripe-events.js";

const SCHOOL = "sch_vol";
const FAMILY = "fam_8k2";
const HOLDER = `family:${FAMILY}`;
const menu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
const catalogRows = menuCatalogRows({ menu, school: SCHOOL });
const D = (s: string) => Date.parse(s);
const MENU_VERSION = 3;
const POLICY_VERSION = 1;

const tierKey = (tierId: string, interval: "month" | "year") => {
	const price = menu.tiers
		.find((t) => t.id === tierId)
		?.prices.find((p) => p.interval === interval);
	return lookupKeyOf(
		SCHOOL,
		tierPriceKey(tierId, interval),
		price?.amount as number,
		menu.currency,
	);
};
const addonKey = (addonId: string) => {
	const addon = menu.addons.find(
		(a) => a.id === addonId,
	) as Menu["addons"][number];
	return lookupKeyOf(
		SCHOOL,
		addonPriceKey(addon.id, addon.price.every, addon.gift),
		addon.price.amount,
		menu.currency,
	);
};
const metadata = { b4u_school: SCHOOL, family_id: FAMILY };

/** The stored input event's id: a ULID the event decides. Stripe's own `evt_` id is what the caller dedupes on. */
const inputEventId = (stripeEventId: string, at: number) =>
	deterministicUlid({
		timeMs: at,
		revision: 0,
		seed: canonicalize([SCHOOL, stripeEventId]),
	});

/** What publishing the menu would have recorded: each lookup key's Stripe price id. */
const priceIds = Object.fromEntries(
	[...menuLineItems(SCHOOL, menu).keys()].map((key) => [key, priceIdOf(key)]),
);

/** The family service in miniature: stored rows and revision, the event log, one write per event. */
const store = (world: Menu = menu, policy: BillingPolicy = DEFAULT_POLICY) => {
	const worldRows = menuCatalogRows({ menu: world, school: SCHOOL });
	const worldCatalog = toCatalog(worldRows);
	let rows: BillingRow[] = [];
	let revision = 0;
	const events: AtmEvent[] = [];
	const results: StripeEventResult[] = [];
	/** The payment intent of each paid invoice: what the caller learns from `invoice_payment.paid`. */
	const invoiceIds: Record<string, string> = {};
	const api = {
		get rows() {
			return rows;
		},
		get revision() {
			return revision;
		},
		events,
		results,
		handle(event: unknown, at: number) {
			const id = (event as { id: string }).id;
			const paid = event as { type: string; data: { object: { id: string } } };
			if (paid.type === "invoice.paid")
				invoiceIds[paymentIntentOf(paid.data.object.id)] = paid.data.object.id;
			const result = handleStripeEvent({
				event,
				eventId: inputEventId(id, at),
				menu: world,
				menuVersion: MENU_VERSION,
				policy,
				policyVersion: POLICY_VERSION,
				rows,
				revision,
				catalog: worldRows,
				now: at,
				priceIds,
				invoiceIds,
			});
			results.push(result);
			if (result.rowChanges) {
				({ rows, revision } = applyRowChanges({
					rows,
					revision,
					changes: result.rowChanges,
				}));
			}
			events.push(...result.events);
			return result;
		},
		avail(asOf: number, feature = "visit") {
			const state = stateFromRows({
				identity: {
					orgId: SCHOOL,
					env: "live",
					customerId: HOLDER,
					entityId: null,
				},
				revision,
				rows,
			});
			if (!state) return 0;
			return (
				balancesOf({
					states: { [HOLDER]: state as never },
					holds: {},
					catalog: worldCatalog,
					asOfMs: asOf,
				}).find((b) => b.feature === feature)?.avail ?? 0
			);
		},
	};
	return api;
};

const T0 = D("2026-01-15T18:00:00Z");
const T1 = D("2026-02-15T18:00:00Z");
const T2 = D("2026-03-15T18:00:00Z");

const create = (s: ReturnType<typeof store>, tier = "sparkle-2") =>
	s.handle(
		invoicePaid({
			eventId: "evt_create",
			invoiceId: "in_1",
			at: T0 + 10_000,
			paidAt: T0 + 5000,
			subscriptionId: "sub_1",
			reason: "subscription_create",
			periodStart: T0,
			periodEnd: T1,
			lines: [
				{
					lookupKey: tierKey(tier, "month"),
					amount: menu.tiers
						.find((t) => t.id === tier)
						?.prices.find((p) => p.interval === "month")?.amount as number,
					interval: "month",
				},
			],
			metadata,
		}),
		T0 + 10_000,
	);

const renew = (s: ReturnType<typeof store>, id = "2") =>
	s.handle(
		invoicePaid({
			eventId: `evt_cycle_${id}`,
			invoiceId: `in_${id}`,
			at: T1 + 10_000,
			subscriptionId: "sub_1",
			reason: "subscription_cycle",
			periodStart: T1,
			periodEnd: T2,
			lines: [
				{
					lookupKey: tierKey("sparkle-2", "month"),
					amount: 26000,
					interval: "month",
				},
			],
			metadata,
		}),
		T1 + 10_000,
	);

const refundOf = (invoiceId: string, id = "1") =>
	chargeRefunded({
		eventId: `evt_re_${id}`,
		refundId: `re_${id}`,
		chargeId: `ch_${invoiceId}`,
		invoiceId,
		amount: 26000,
		chargeAmount: 26000,
		at: T1 + 3_600_000,
	});

const sumsToZero = (e: AtmEvent) => {
	const by = new Map<string, number>();
	for (const p of e.postings)
		by.set(p.commodity, (by.get(p.commodity) ?? 0) + Number(p.amount));
	return [...by.values()].every((v) => Math.abs(v) < 1e-9);
};

/** The events that move credits: the money lines of a payment or a refund (`payment.*`) are tested apart, in tests/billing-money.test.ts. */
const creditEvents = (events: readonly AtmEvent[]) =>
	events.filter((e) => !e.event_type.startsWith("payment."));

describe("handleStripeEvent", () => {
	test("a first payment: rows for the engine and the grants under one revision, and a labelled credit.granted", () => {
		const s = store();
		const r = create(s);
		expect(r.refused).toBeUndefined();
		expect(r.rowChanges).toMatchObject({
			subjectKey: `${SCHOOL}|live|${HOLDER}`,
			expectedRevision: 0,
			nextRevision: 1,
		});
		const tables = new Set(r.rowChanges?.upserts.map((u) => u.table));
		expect(tables.has(GRANTS_TABLE)).toBe(true);
		expect(tables.has("customerEntitlements")).toBe(true);
		expect(s.revision).toBe(1);
		expect(grantsFromRows(s.rows).invoices.in_1?.granted).toHaveLength(1);
		expect(s.avail(T0)).toBe(2);

		expect(creditEvents(r.events).map((e) => e.event_type)).toEqual([
			"credit.granted",
		]);
		const event = r.events[0] as AtmEvent;
		expect(event.cause).toBe(inputEventId("evt_create", T0 + 10_000));
		expect(event.labels).toMatchObject({
			menu_version: "3",
			policy_version: "1",
			mapping: "stripe/invoice.paid@v1",
			feature: "visit",
			plan: "sparkle-2@v3",
		});
		expect(event.text).toBe("granted 2 visit on sparkle-2@v3");
		expect(sumsToZero(event)).toBe(true);
	});

	test("a replayed event decides nothing and writes nothing", () => {
		const s = store();
		create(s);
		const again = create(s);
		expect(again).toEqual({ rowChanges: null, events: [] });
		expect(s.revision).toBe(1);
	});

	test("a renewal resets, rolls over, and every event names its cause", () => {
		const s = store();
		create(s);
		const r = renew(s);
		expect(r.rowChanges?.expectedRevision).toBe(1);
		// the reset, then the update that puts the row's next reset on Stripe's cycle end
		expect(r.rowChanges?.nextRevision).toBe(3);
		expect(r.events.length).toBeGreaterThan(0);
		for (const e of r.events) {
			expect(e.cause).toBe(inputEventId("evt_cycle_2", T1 + 10_000));
			expect(e.labels.menu_version).toBe("3");
			expect(sumsToZero(e)).toBe(true);
		}
		expect(s.avail(T1 + 20_000)).toBe(4);
	});

	test("a yearly grant on a monthly plan is booked by the reset that fills it", () => {
		const s = store();
		const r = create(s, "sparkle-4");
		expect(
			creditEvents(r.events).map((e) => [
				e.event_type,
				e.labels.feature,
				e.text,
			]),
		).toEqual([
			["credit.granted", "visit", "granted 4 visit on sparkle-4@v3"],
			["credit.granted", "retreat", "granted 1 retreat on sparkle-4@v3"],
		]);
		for (const e of r.events) expect(sumsToZero(e)).toBe(true);
		expect(s.avail(T0, "retreat")).toBe(1);
		expect(s.avail(T0, "visit")).toBe(4);
	});

	test("one mutation that moves two features is booked one event per feature, each balanced", () => {
		const both = structuredClone(menu);
		const tier = both.tiers.find(
			(t) => t.id === "sparkle-4",
		) as Menu["tiers"][number];
		tier.grants = [
			{ featureId: "visit", amount: 4, every: "month" },
			{ featureId: "retreat", amount: 1, every: "month" },
		];
		const s = store(both);
		const r = create(s, "sparkle-4");
		const credits = creditEvents(r.events);
		expect(credits.map((e) => [e.labels.feature, e.text])).toEqual([
			["retreat", "granted 1 retreat on sparkle-4@v3"],
			["visit", "granted 4 visit on sparkle-4@v3"],
		]);
		expect(new Set(credits.map((e) => e.idem)).size).toBe(2);
		expect(credits.map((e) => e.idem)).toEqual([
			expect.stringMatching(/^engine\.retreat:/),
			expect.stringMatching(/^engine\.visit:/),
		]);
		for (const e of r.events) expect(sumsToZero(e)).toBe(true);
		expect(s.avail(T0, "retreat")).toBe(1);
		expect(s.avail(T0, "visit")).toBe(4);
	});

	test("a full refund takes the unused visits back, once", () => {
		const s = store();
		create(s);
		const r = s.handle(refundOf("in_1"), T1);
		// The clawback takes the family's last visits, but it is the rules' own take-back, not a draw: no credit.depleted.
		expect(r.events.map((e) => e.event_type)).toEqual([
			"credit.adjusted",
			"payment.refunded",
		]);
		expect(r.events[0]?.cause).toBe(inputEventId("evt_re_1", T1));
		expect(r.events[0]?.labels.mapping).toBe("stripe/charge.refunded@v1");
		expect(s.avail(T0 + 1)).toBe(0);
		// handled again: no rows, no credits, and the refund's own money line again, which the outbox's idem drops
		expect(s.handle(refundOf("in_1"), T1)).toEqual({
			rowChanges: null,
			events: [r.events[1]],
		});
	});

	test("a refund of the older invoice also takes its rolled-over leftovers", () => {
		const s = store();
		create(s);
		renew(s);
		expect(s.avail(T1 + 20_000)).toBe(4);
		s.handle(refundOf("in_1"), T1 + 3_600_000);
		expect(s.avail(T1 + 3_700_000)).toBe(2);
	});

	test("a lost dispute removes like a full refund; won or open does nothing", () => {
		const s = store();
		create(s);
		const dispute = (status: "needs_response" | "won" | "lost", id: string) =>
			disputeEvent({
				type: "charge.dispute.closed",
				eventId: `evt_dp_${id}`,
				disputeId: `dp_${id}`,
				chargeId: "ch_in_1",
				invoiceId: "in_1",
				status,
				at: T1,
			});
		expect(s.handle(dispute("won", "a"), T1).rowChanges).toBeNull();
		expect(s.avail(T0 + 1)).toBe(2);
		const lost = s.handle(dispute("lost", "b"), T1);
		expect(lost.events.map((e) => e.event_type)).toEqual(["credit.adjusted"]);
		expect(s.avail(T0 + 1)).toBe(0);
	});

	test("a canceled subscription moves each row's expiry and books it as credit.expiration_changed, with no postings; the visits then lapse on their own", () => {
		// BY DESIGN: this used to be "a row write with no credit event" (events toEqual([])).
		const s = store();
		create(s);
		const r = s.handle(
			subscriptionDeleted({
				eventId: "evt_sub_del",
				subscriptionId: "sub_1",
				tierId: "sparkle-2",
				interval: "month",
				periodStart: T0,
				periodEnd: T1,
				at: T0 + 86_400_000,
			}),
			T0 + 86_400_000,
		);
		expect(
			r.events.map((e) => [e.event_type, e.postings, e.payload]),
		).toMatchObject([
			[
				"credit.expiration_changed",
				[],
				{
					row_id: "ce_tier_visit_month",
					previous_expires_at: null,
					expires_at: T2,
					refills_ended: true,
				},
			],
		]);
		expect(r.events[0]?.idem).toMatch(/:expiry:ce_tier_visit_month$/);
		expect(r.events[0]?.labels.expires_at).toBe("2026-03-15T18:00:00Z");
		expect(r.events[0]?.cause).toBe(
			inputEventId("evt_sub_del", T0 + 86_400_000),
		);
		expect(validateEvent(r.events[0]).errors).toEqual([]);
		expect(r.rowChanges?.nextRevision).toBe(2);
		expect(s.avail(T0 + 2 * 86_400_000)).toBe(2);
		expect(s.avail(D("2026-03-15T18:00:01Z"))).toBe(0);
	});

	test("replaying the log reproduces the engine's balances before and after the new expiry date", () => {
		const s = store();
		create(s);
		s.handle(
			subscriptionDeleted({
				eventId: "evt_sub_del",
				subscriptionId: "sub_1",
				tierId: "sparkle-2",
				interval: "month",
				periodStart: T0,
				periodEnd: T1,
				at: T0 + 86_400_000,
			}),
			T0 + 86_400_000,
		);
		for (const asOf of [
			T0 + 2 * 86_400_000,
			T2 - 1,
			D("2026-03-15T18:00:01Z"),
		]) {
			const replayed = replayEvents({
				events: s.events,
				catalog: catalogRows,
				asOf: new Date(asOf).toISOString(),
			});
			expect(
				replayed.balances.find((b) => b.feature === "visit")?.avail ?? 0,
			).toBe(s.avail(asOf));
		}
	});

	test("a second delivery of the end, or the same event again, books no second expiration event", () => {
		const s = store();
		create(s);
		const ended = (eventId: string) =>
			subscriptionDeleted({
				eventId,
				subscriptionId: "sub_1",
				tierId: "sparkle-2",
				interval: "month",
				periodStart: T0,
				periodEnd: T1,
				at: T0 + 86_400_000,
			});
		const first = s.handle(ended("evt_sub_del"), T0 + 86_400_000);
		expect(first.events).toHaveLength(1);
		expect(s.handle(ended("evt_sub_del"), T0 + 86_400_000)).toEqual({
			rowChanges: null,
			events: [],
		});
		expect(
			s.handle(ended("evt_sub_del_again"), T0 + 86_400_000).events,
		).toEqual([]);
		expect(
			s.events.filter((e) => e.event_type === "credit.expiration_changed"),
		).toHaveLength(1);
	});

	test("a gift add-on is credited for the policy's months; a dollar gift is a grants-only write", () => {
		const s = store();
		const gift = (lookupKey: string, amount: number) =>
			invoicePaid({
				eventId: "evt_gift",
				invoiceId: "in_gift",
				at: T0,
				subscriptionId: null,
				reason: "manual",
				periodStart: T0,
				periodEnd: T0,
				lines: [{ lookupKey, amount }],
				metadata,
			});
		const r = s.handle(gift(addonKey("gift-visit"), 13000), T0);
		expect(
			creditEvents(r.events).map((e) => [e.event_type, e.labels.plan]),
		).toEqual([["credit.granted", "gift"]]);
		expect(s.avail(D("2026-07-14T00:00:00Z"))).toBe(1);
		expect(s.avail(D("2026-07-16T00:00:00Z"))).toBe(0);

		const dollars = store();
		const d = dollars.handle(gift(addonKey("gift-dollars"), 5000), T0);
		expect(creditEvents(d.events)).toEqual([]);
		expect(d.rowChanges?.upserts.map((u) => u.table)).toEqual([GRANTS_TABLE]);
		expect(d.rowChanges?.nextRevision).toBe(1);
		expect(
			dollars.handle(gift(addonKey("gift-dollars"), 5000), T0).rowChanges,
		).toBeNull();
	});

	test("one revision covers both: a write computed against another revision is stale", () => {
		const s = store();
		const changes = create(s).rowChanges;
		if (!changes) throw new Error("expected a write");
		expect(() =>
			applyRowChanges({ rows: s.rows, revision: s.revision, changes }),
		).toThrow(StaleRevision);
	});

	test("the same inputs give the same rows and events, byte for byte", () => {
		const run = () => {
			const s = store();
			create(s);
			renew(s);
			s.handle(refundOf("in_1"), T1 + 3_600_000);
			return JSON.stringify({
				rows: s.rows,
				events: s.events,
				revision: s.revision,
			});
		};
		expect(run()).toBe(run());
	});

	test("an empty store holds no grants state until the first payment", () => {
		expect(grantsFromRows([])).toEqual(EMPTY_GRANTS_STATE);
	});
});

describe("what the random histories found", () => {
	test("a dollar gift first leaves a subject with no engine rows at revision 1; the first plan after it still lands", () => {
		const s = store();
		s.handle(
			invoicePaid({
				eventId: "evt_dg",
				invoiceId: "in_dg",
				at: T0 - 86_400_000,
				subscriptionId: null,
				reason: "manual",
				periodStart: T0,
				periodEnd: T0,
				lines: [{ lookupKey: addonKey("gift-dollars"), amount: 5000 }],
				metadata,
			}),
			T0 - 86_400_000,
		);
		expect(s.revision).toBe(1);
		const r = create(s);
		expect(r.refused).toBeUndefined();
		expect(r.rowChanges).toMatchObject({
			expectedRevision: 1,
			nextRevision: 2,
		});
		expect(s.avail(T0)).toBe(2);
	});

	test("a refund of a dollar gift is handled once, before or after the family has credits", () => {
		const s = store();
		const gift = invoicePaid({
			eventId: "evt_dg",
			invoiceId: "in_dg",
			at: T0 - 86_400_000,
			subscriptionId: null,
			reason: "manual",
			periodStart: T0,
			periodEnd: T0,
			lines: [{ lookupKey: addonKey("gift-dollars"), amount: 5000 }],
			metadata,
		});
		s.handle(gift, T0 - 86_400_000);
		const refund = chargeRefunded({
			eventId: "evt_re_dg",
			refundId: "re_dg",
			chargeId: "ch_in_dg",
			invoiceId: "in_dg",
			amount: 5000,
			chargeAmount: 5000,
			at: T0 - 3_600_000,
		});
		expect(s.handle(refund, T0 - 3_600_000).rowChanges).not.toBeNull();
		create(s);
		const again = s.handle(refund, T0 - 3_600_000);
		expect(again.rowChanges).toBeNull();
		expect(creditEvents(again.events)).toEqual([]);
	});

	test("a downgrade that drops a feature and an upgrade that brings it back revive the row instead of inserting it twice", () => {
		const s = store();
		create(s, "sparkle-4");
		expect(s.avail(T0, "retreat")).toBe(1);
		// the renewal moves to sparkle-2, which has no retreat: the row stops refilling and keeps its visit
		s.handle(
			invoicePaid({
				eventId: "evt_c2",
				invoiceId: "in_c2",
				at: T1,
				subscriptionId: "sub_1",
				reason: "subscription_cycle",
				periodStart: T1,
				periodEnd: T2,
				lines: [
					{
						lookupKey: tierKey("sparkle-2", "month"),
						amount: 26000,
						interval: "month",
					},
				],
				metadata,
			}),
			T1,
		);
		expect(s.avail(T1 + 1000, "retreat")).toBe(1);
		const grants = grantsFromRows(s.rows);
		expect(grants.retired).toEqual({ ce_tier_retreat_year: 1 });
		expect(grants.rows.ce_tier_retreat_year).toBeUndefined();
		// and mid-cycle back up to sparkle-4
		const up = s.handle(
			invoicePaid({
				eventId: "evt_up",
				invoiceId: "in_up",
				at: T1 + 86_400_000,
				subscriptionId: "sub_1",
				reason: "subscription_update",
				periodStart: T1 + 86_400_000,
				periodEnd: T2,
				lines: [
					{
						lookupKey: tierKey("sparkle-2", "month"),
						amount: -9000,
						interval: "month",
						proration: true,
					},
					{
						lookupKey: tierKey("sparkle-4", "month"),
						amount: 18000,
						interval: "month",
						proration: true,
					},
				],
				metadata,
			}),
			T1 + 86_400_000,
		);
		expect(up.refused).toBeUndefined();
		const after = grantsFromRows(s.rows);
		expect(after.retired).toEqual({});
		expect(after.rows.ce_tier_retreat_year).toBe(2);
		// the retreat row was refilled by the reset: the kept visit rolled over (or stayed) and a new one came
		expect(s.avail(T1 + 2 * 86_400_000, "retreat")).toBeGreaterThanOrEqual(1);
	});

	test("the same, on the renewal itself", () => {
		const s = store();
		create(s, "sparkle-4");
		const cycle = (
			id: string,
			at: number,
			start: number,
			end: number,
			tier: string,
		) =>
			s.handle(
				invoicePaid({
					eventId: `evt_${id}`,
					invoiceId: `in_${id}`,
					at,
					subscriptionId: "sub_1",
					reason: "subscription_cycle",
					periodStart: start,
					periodEnd: end,
					lines: [
						{
							lookupKey: tierKey(tier as "sparkle-2", "month"),
							amount: 1,
							interval: "month",
						},
					],
					metadata,
				}),
				at,
			);
		const T3 = D("2026-04-15T18:00:00Z");
		expect(cycle("c2", T1, T1, T2, "sparkle-2").refused).toBeUndefined();
		const back = cycle("c4", T2, T2, T3, "sparkle-4");
		expect(back.refused).toBeUndefined();
		expect(grantsFromRows(s.rows).retired).toEqual({});
		expect(s.avail(T2 + 1000, "retreat")).toBeGreaterThanOrEqual(1);
		expect(s.avail(T2 + 1000, "visit")).toBe(4 + 2);
	});

	test("a row the plan moved off lapses when the subscription ends, as its old tier's rollover would", () => {
		const s = store();
		create(s, "sparkle-4");
		s.handle(
			invoicePaid({
				eventId: "evt_c2",
				invoiceId: "in_c2",
				at: T1,
				subscriptionId: "sub_1",
				reason: "subscription_cycle",
				periodStart: T1,
				periodEnd: T2,
				lines: [
					{
						lookupKey: tierKey("sparkle-2", "month"),
						amount: 26000,
						interval: "month",
					},
				],
				metadata,
			}),
			T1,
		);
		expect(s.avail(D("2027-06-01T00:00:00Z"), "retreat")).toBe(1); // kept, with no end in sight
		s.handle(
			subscriptionDeleted({
				eventId: "evt_sd",
				subscriptionId: "sub_1",
				tierId: "sparkle-2",
				interval: "month",
				periodStart: T1,
				periodEnd: T2,
				at: T1 + 86_400_000,
			}),
			T1 + 86_400_000,
		);
		expect(s.avail(T2 - 1, "retreat")).toBe(1);
		expect(s.avail(T2 + 1, "retreat")).toBe(0);
	});

	test("ending a subscription books one expiration event per row it moves, the retired row without ending any refill", () => {
		const s = store();
		create(s, "sparkle-4");
		s.handle(
			invoicePaid({
				eventId: "evt_c2",
				invoiceId: "in_c2",
				at: T1,
				subscriptionId: "sub_1",
				reason: "subscription_cycle",
				periodStart: T1,
				periodEnd: T2,
				lines: [
					{
						lookupKey: tierKey("sparkle-2", "month"),
						amount: 26000,
						interval: "month",
					},
				],
				metadata,
			}),
			T1,
		);
		const ended = s.handle(
			subscriptionDeleted({
				eventId: "evt_sd",
				subscriptionId: "sub_1",
				tierId: "sparkle-2",
				interval: "month",
				periodStart: T1,
				periodEnd: T2,
				at: T1 + 86_400_000,
			}),
			T1 + 86_400_000,
		);
		const moved = ended.events.filter(
			(e) => e.event_type === "credit.expiration_changed",
		);
		expect(moved).toHaveLength(ended.events.length);
		const byRow = Object.fromEntries(
			moved.map((e) => [
				(e.payload as { row_id: string }).row_id,
				{
					feature: e.labels.feature,
					previous: (e.payload as { previous_expires_at: number | null })
						.previous_expires_at,
					next: (e.payload as { expires_at: number }).expires_at,
					refillsEnded: (e.payload as { refills_ended: boolean }).refills_ended,
				},
			]),
		);
		expect(byRow.ce_tier_retreat_year).toEqual({
			feature: "retreat",
			previous: null,
			next: T2,
			refillsEnded: false,
		});
		expect(byRow.ce_tier_visit_month).toMatchObject({
			feature: "visit",
			previous: null,
			next: D("2026-04-15T18:00:00Z"),
			refillsEnded: true,
		});
		expect(new Set(moved.map((e) => e.idem)).size).toBe(moved.length);
		// the lapse dates the engine now holds
		for (const asOf of [T2 - 1, T2 + 1, D("2026-04-15T18:00:01Z")]) {
			expect(s.avail(asOf, "retreat")).toBe(asOf < T2 ? 1 : 0);
		}
	});

	test("a second subscription for a family whose first ended is refused, nothing written", () => {
		const s = store();
		create(s);
		s.handle(
			subscriptionDeleted({
				eventId: "evt_sd",
				subscriptionId: "sub_1",
				tierId: "sparkle-2",
				interval: "month",
				periodStart: T0,
				periodEnd: T1,
				at: T0 + 86_400_000,
			}),
			T0 + 86_400_000,
		);
		const before = JSON.stringify([s.rows, s.revision]);
		const again = s.handle(
			invoicePaid({
				eventId: "evt_new",
				invoiceId: "in_new",
				at: T2,
				subscriptionId: "sub_2",
				reason: "subscription_create",
				periodStart: T2,
				periodEnd: D("2026-04-15T18:00:00Z"),
				lines: [
					{
						lookupKey: tierKey("sparkle-2", "month"),
						amount: 26000,
						interval: "month",
					},
				],
				metadata,
			}),
			T2,
		);
		expect(again.refused?.reason).toBe("rejected");
		expect(again.refused?.message).toMatch(/second subscription/);
		expect(JSON.stringify([s.rows, s.revision])).toBe(before);
	});
});

describe("what the reviews found", () => {
	const dispute = (
		status: "needs_response" | "won" | "lost",
		invoiceId: string,
	) =>
		disputeEvent({
			type: "charge.dispute.closed",
			eventId: `evt_dp_${invoiceId}_${status}`,
			disputeId: `dp_${invoiceId}_${status}`,
			chargeId: `ch_${invoiceId}`,
			invoiceId,
			status,
			at: T1,
		});

	test("a replayed invoice is nothing even after the menu changed its price", () => {
		const s = store();
		create(s);
		const repriced = structuredClone(menu);
		const tier = repriced.tiers.find(
			(t) => t.id === "sparkle-2",
		) as Menu["tiers"][number];
		(
			tier.prices.find((p) => p.interval === "month") as { amount: number }
		).amount = 30000;
		const again = handleStripeEvent({
			event: invoicePaid({
				eventId: "evt_create",
				invoiceId: "in_1",
				at: T0 + 10_000,
				subscriptionId: "sub_1",
				reason: "subscription_create",
				periodStart: T0,
				periodEnd: T1,
				lines: [
					{
						lookupKey: tierKey("sparkle-2", "month"),
						amount: 26000,
						interval: "month",
					},
				],
				metadata,
			}),
			eventId: "01KWE000000000000000000000",
			menu: repriced,
			menuVersion: 4,
			policy: DEFAULT_POLICY,
			policyVersion: POLICY_VERSION,
			rows: s.rows,
			revision: s.revision,
			catalog: menuCatalogRows({ menu: repriced, school: SCHOOL }),
			now: T0 + 10_000,
			priceIds,
		});
		expect(again).toEqual({ rowChanges: null, events: [] });
	});

	test("a full refund or lost dispute that names no invoice we have handled is refused, not ignored", () => {
		const s = store();
		create(s);
		const unlinked = chargeRefunded({
			eventId: "evt_re_x",
			refundId: "re_x",
			chargeId: "ch_unknown",
			invoiceId: null,
			amount: 26000,
			chargeAmount: 26000,
			at: T1,
		});
		const r = s.handle(unlinked, T1);
		expect(r.refused?.reason).toBe("unmatched_invoice");
		expect(r.rowChanges).toBeNull();
		expect(s.handle(dispute("lost", "in_other"), T1).refused?.reason).toBe(
			"unmatched_invoice",
		);
		// a partial refund or a dispute not lost takes nothing back, so there is nothing to retry
		const partial = chargeRefunded({
			eventId: "evt_re_p",
			refundId: "re_p",
			chargeId: "ch_unknown",
			invoiceId: null,
			amount: 100,
			chargeAmount: 26000,
			at: T1,
		});
		expect(s.handle(partial, T1)).toEqual({ rowChanges: null, events: [] });
		expect(s.handle(dispute("won", "in_other"), T1)).toEqual({
			rowChanges: null,
			events: [],
		});
		// and once the invoice is known the same refund goes through
		expect(s.handle(refundOf("in_1"), T1).refused).toBeUndefined();
	});

	test("a cancel that arrives before any invoice of the holder is refused to be retried; one for an older subscription is not", () => {
		const s = store();
		s.handle(
			invoicePaid({
				eventId: "evt_dg",
				invoiceId: "in_dg",
				at: T0 - 86_400_000,
				subscriptionId: null,
				reason: "manual",
				periodStart: T0,
				periodEnd: T0,
				lines: [{ lookupKey: addonKey("gift-dollars"), amount: 5000 }],
				metadata,
			}),
			T0 - 86_400_000,
		);
		const cancel = (id: string) =>
			subscriptionDeleted({
				eventId: `evt_sd_${id}`,
				subscriptionId: id,
				tierId: "sparkle-2",
				interval: "month",
				periodStart: T0,
				periodEnd: T1,
				at: T0 + 86_400_000,
			});
		expect(s.handle(cancel("sub_1"), T0 + 86_400_000).refused?.reason).toBe(
			"unknown_subscription",
		);
		create(s);
		expect(s.handle(cancel("sub_old"), T0 + 86_400_000)).toEqual({
			rowChanges: null,
			events: [],
		});
	});

	test("credits of one feature from the tier, a recurring add-on and a pack are booked each to its own plan", () => {
		const s = store();
		const r = s.handle(
			invoicePaid({
				eventId: "evt_multi",
				invoiceId: "in_multi",
				at: T0,
				subscriptionId: "sub_1",
				reason: "subscription_create",
				periodStart: T0,
				periodEnd: T1,
				lines: [
					{
						lookupKey: tierKey("sparkle-2", "month"),
						amount: 26000,
						interval: "month",
					},
					{ lookupKey: addonKey("glow"), amount: 5000, interval: "month" },
					{ lookupKey: addonKey("pack"), amount: 9000 },
				],
				metadata,
			}),
			T0,
		);
		expect(r.refused).toBeUndefined();
		expect(creditEvents(r.events).map((e) => e.text)).toEqual([
			"granted 1 visit on glow@v3",
			"granted 1 visit on pack@v3",
			"granted 2 visit on sparkle-2@v3",
		]);
		expect(new Set(creditEvents(r.events).map((e) => e.idem)).size).toBe(3);
		expect(
			creditEvents(r.events).map(
				(e) =>
					e.postings.find((p) => p.account.startsWith("credits:issued:"))
						?.account,
			),
		).toEqual([
			"credits:issued:glow@v3",
			"credits:issued:pack@v3",
			"credits:issued:sparkle-2@v3",
		]);
		expect(s.avail(T0)).toBe(4);
		// A full refund takes all four back over the three plans: the rules' take-back, not a draw, so no alert.
		const refund = s.handle(refundOf("in_multi"), T1);
		expect(refund.refused).toBeUndefined();
		expect(
			new Set(creditEvents(refund.events).map((e) => e.event_type)),
		).toEqual(new Set(["credit.adjusted"]));
		expect(s.avail(T1 + 3_700_000)).toBe(0);
	});

	test("a renewal whose invoice carries no checkout metadata is handled for a holder we know", () => {
		const s = store();
		create(s);
		const r = s.handle(
			invoicePaid({
				eventId: "evt_nometa",
				invoiceId: "in_nometa",
				at: T1 + 10_000,
				subscriptionId: "sub_1",
				reason: "subscription_cycle",
				periodStart: T1,
				periodEnd: T2,
				lines: [
					{
						lookupKey: tierKey("sparkle-2", "month"),
						amount: 26000,
						interval: "month",
					},
				],
				metadata: {},
			}),
			T1 + 10_000,
		);
		expect(r.refused).toBeUndefined();
		expect(s.avail(T1 + 20_000)).toBe(4);
	});

	test("a no-op result is its own object each time", () => {
		const s = store();
		const a = s.handle(refundOf("in_unknown"), T1);
		a.events.push({} as never);
		expect(s.handle(refundOf("in_unknown"), T1).events).toEqual([]);
	});
});

describe("refusals", () => {
	const input = (event: unknown) => ({
		event,
		eventId: inputEventId("evt_x", T0),
		menu,
		menuVersion: MENU_VERSION,
		policy: DEFAULT_POLICY,
		policyVersion: POLICY_VERSION,
		rows: [] as BillingRow[],
		revision: 0,
		catalog: catalogRows,
		now: T0,
		priceIds,
	});
	const paid = () =>
		invoicePaid({
			eventId: "evt_x",
			invoiceId: "in_x",
			at: T0,
			subscriptionId: "sub_1",
			reason: "subscription_create",
			periodStart: T0,
			periodEnd: T1,
			lines: [
				{
					lookupKey: tierKey("sparkle-2", "month"),
					amount: 26000,
					interval: "month",
				},
			],
			metadata,
		});
	const refusedAs = (event: unknown) => {
		const r = handleStripeEvent(input(event));
		expect(r.rowChanges).toBeNull();
		expect(r.events).toEqual([]);
		return r.refused?.reason;
	};

	test("not an event, or an event type with no mapping, or a Stripe version we have no mapping for", () => {
		expect(refusedAs("nope")).toBe("bad_event");
		expect(refusedAs({ type: "invoice.paid" })).toBe("bad_event");
		expect(
			refusedAs({ type: "customer.created", api_version: "2025-10-29.clover" }),
		).toBe("unknown_mapping");
		expect(refusedAs({ ...paid(), api_version: "2099-01-01.future" })).toBe(
			"unknown_mapping",
		);
	});

	test("an event whose fields are not where the mapping says is refused", () => {
		const event = paid();
		event.data.object.period_start = "soon";
		expect(refusedAs(event)).toBe("bad_event");
	});

	test("an invoice without the checkout metadata is refused, not guessed", () => {
		const event = paid();
		event.data.object.metadata = {};
		event.data.object.parent.subscription_details.metadata = {};
		expect(refusedAs(event)).toBe("missing_metadata");
	});

	test("money for one of our prices that the menu does not know is refused, not silently ignored", () => {
		const event = paid();
		event.data.object.lines.data[0].pricing.price_details.price =
			"price_for_an_old_amount";
		expect(refusedAs(event)).toBe("unmatched_line");
	});

	test("without the price ids no line can match the menu (a Stripe line carries only its price id)", () => {
		const r = handleStripeEvent({ ...input(paid()), priceIds: undefined });
		expect(r.refused?.reason).toBe("unmatched_line");
	});

	test("an unknown line that is free or a credit is left alone", () => {
		const event = paid();
		for (const amount of [0, -500]) {
			const extra = structuredClone(event.data.object.lines.data[0]);
			extra.amount = amount;
			extra.pricing.price_details.price = "price_something_else";
			event.data.object.lines.data.push(extra);
		}
		const r = handleStripeEvent(input(event));
		expect(r.refused).toBeUndefined();
		expect(creditEvents(r.events)).toHaveLength(1);
	});

	test("a refund or dispute for a family with no rows is nothing, not an error", () => {
		const r = handleStripeEvent(input(refundOf("in_unknown")));
		expect(r).toEqual({ rowChanges: null, events: [] });
	});
});

describe("subscription events", () => {
	const sub = (over: Partial<Parameters<typeof subscriptionEvent>[0]> = {}) =>
		subscriptionEvent({
			type: "customer.subscription.updated",
			eventId: "evt_sub",
			subscriptionId: "sub_1",
			status: "active",
			items: [{ lookupKey: tierKey("sparkle-2", "month"), interval: "month" }],
			periodStart: T0,
			periodEnd: T1,
			at: T0 + 20_000,
			metadata,
			...over,
		});
	const DAY = 86_400_000;
	const grantsOf = (s: ReturnType<typeof store>) => grantsFromRows(s.rows);

	test("a subscription seen before its first invoice records the holder and the membership, and credits nothing", () => {
		const s = store();
		const r = s.handle(
			sub({ type: "customer.subscription.created" }),
			T0 + 20_000,
		);
		expect(r.events).toEqual([]);
		expect(r.rowChanges?.upserts.map((u) => u.table)).toEqual([GRANTS_TABLE]);
		const grants = grantsOf(s);
		expect(grants.holder).toEqual({ orgId: SCHOOL, customerId: HOLDER });
		expect(grants.membership).toEqual({
			subscriptionId: "sub_1",
			status: "active",
			tierId: "sparkle-2",
			interval: "month",
			quantity: 1,
			renewsAt: T1,
			cancelAtPeriodEnd: false,
			endsAt: null,
			at: T0 + 20_000,
		});
		expect(grants.tierId).toBeNull();
		expect(s.avail(T0 + 30_000)).toBe(0);
		// The invoice that follows grants as it always did.
		create(s);
		expect(s.avail(T0 + 30_000)).toBe(2);
		expect(grantsOf(s).membership?.tierId).toBe("sparkle-2");
	});

	test("cancel at period end is recorded and changes no credits; the subscription still runs", () => {
		const s = store();
		create(s);
		const before = s.avail(T0 + 2 * DAY);
		const r = s.handle(
			sub({ cancelAtPeriodEnd: true, at: T0 + DAY }),
			T0 + DAY,
		);
		expect(r.events).toEqual([]);
		expect(r.rowChanges?.upserts.map((u) => u.table)).toEqual([GRANTS_TABLE]);
		const grants = grantsOf(s);
		expect(grants.membership).toMatchObject({
			status: "active",
			cancelAtPeriodEnd: true,
			renewsAt: null,
			endsAt: T1,
		});
		expect(grants.endedAt).toBeNull();
		expect(s.avail(T0 + 2 * DAY)).toBe(before);
	});

	test("a tier change Stripe has made shows in the membership; credits follow only the paid invoice", () => {
		const s = store();
		create(s);
		const r = s.handle(
			sub({
				items: [
					{ lookupKey: tierKey("sparkle-4", "month"), interval: "month" },
				],
				at: T0 + DAY,
			}),
			T0 + DAY,
		);
		expect(r.events).toEqual([]);
		const grants = grantsOf(s);
		expect(grants.membership?.tierId).toBe("sparkle-4");
		expect(grants.tierId).toBe("sparkle-2");
		expect(s.avail(T0 + 2 * DAY)).toBe(2);
	});

	test("the tier is found among several items, and by price id when the lookup key is absent", () => {
		const s = store();
		const raw = sub({
			items: [
				{ lookupKey: addonKey("glow"), interval: "month" },
				{ lookupKey: tierKey("sparkle-2", "year"), interval: "year" },
			],
		});
		delete raw.data.object.items.data[1].price.lookup_key;
		s.handle(raw, T0 + 20_000);
		expect(grantsOf(s).membership).toMatchObject({
			tierId: "sparkle-2",
			interval: "year",
		});
	});

	test.each([
		["past_due", "past_due", T1],
		["unpaid", "past_due", T1],
		["incomplete", "incomplete", null],
		["paused", "inactive", null],
		["trialing", "active", T1],
	] as const)("status %s is shown as %s", (status, shown, renewsAt) => {
		const s = store();
		create(s);
		s.handle(sub({ status, at: T0 + DAY }), T0 + DAY);
		expect(grantsOf(s).membership).toMatchObject({ status: shown, renewsAt });
	});

	test("an event about another subscription than the holder's changes nothing", () => {
		const s = store();
		create(s);
		const before = grantsOf(s).membership;
		const r = s.handle(
			sub({
				subscriptionId: "sub_old",
				status: "canceled",
				type: "customer.subscription.deleted",
				at: T0 + 2 * DAY,
			}),
			T0 + 2 * DAY,
		);
		expect(r).toEqual({ rowChanges: null, events: [] });
		expect(grantsOf(s).membership).toEqual(before);
	});

	test("a replayed event and an older one than the one on record change nothing", () => {
		const s = store();
		create(s);
		const newer = sub({ cancelAtPeriodEnd: true, at: T0 + 2 * DAY });
		expect(s.handle(newer, T0 + 2 * DAY).rowChanges).not.toBeNull();
		expect(s.handle(newer, T0 + 2 * DAY).rowChanges).toBeNull();
		const older = sub({
			eventId: "evt_older",
			cancelAtPeriodEnd: false,
			at: T0 + DAY,
		});
		expect(s.handle(older, T0 + 3 * DAY).rowChanges).toBeNull();
		expect(grantsOf(s).membership?.cancelAtPeriodEnd).toBe(true);
	});

	test("an item of ours that the menu does not know is refused, nothing written", () => {
		const s = store();
		const r = s.handle(
			sub({
				items: [
					{ lookupKey: "b4u_sch_vol_t_ghost_month_100_usd", interval: "month" },
				],
			}),
			T0 + 20_000,
		);
		expect(r.refused?.reason).toBe("unmatched_line");
		expect(r.rowChanges).toBeNull();
		expect(s.rows).toEqual([]);
	});

	test("events of one second do not undo a more final status, in either order", () => {
		const at = T0 + DAY;
		const created = sub({
			type: "customer.subscription.created",
			eventId: "evt_created",
			status: "incomplete",
			at,
		});
		const updated = sub({ eventId: "evt_updated", status: "active", at });
		const deleted = sub({
			type: "customer.subscription.deleted",
			eventId: "evt_deleted",
			status: "canceled",
			at,
		});
		const updatedFirst = store();
		create(updatedFirst);
		updatedFirst.handle(updated, at);
		updatedFirst.handle(created, at);
		expect(grantsOf(updatedFirst).membership?.status).toBe("active");
		const createdFirst = store();
		create(createdFirst);
		createdFirst.handle(created, at);
		createdFirst.handle(updated, at);
		expect(grantsOf(createdFirst).membership?.status).toBe("active");
		const endedFirst = store();
		create(endedFirst);
		endedFirst.handle(deleted, at);
		endedFirst.handle(created, at);
		endedFirst.handle(updated, at);
		expect(grantsOf(endedFirst).membership?.status).toBe("ended");
		expect(grantsOf(endedFirst).endedAt).toBe(at);
	});

	test("a canceled event older than the membership on record ends nothing and lapses nothing", () => {
		const s = store();
		create(s);
		s.handle(sub({ cancelAtPeriodEnd: true, at: T0 + 2 * DAY }), T0 + 2 * DAY);
		const before = s.avail(T0 + 3 * DAY);
		const r = s.handle(
			sub({
				type: "customer.subscription.deleted",
				eventId: "evt_stale_deleted",
				status: "canceled",
				at: T0 + DAY,
			}),
			T0 + 3 * DAY,
		);
		expect(r).toEqual({ rowChanges: null, events: [] });
		const grants = grantsOf(s);
		expect(grants.endedAt).toBeNull();
		expect(grants.membership?.status).toBe("active");
		expect(s.avail(D("2026-03-15T18:00:01Z"))).toBe(before);
	});

	test("before the first invoice, a late event of one subscription does not overwrite another's membership", () => {
		const s = store();
		s.handle(
			sub({ subscriptionId: "sub_a", eventId: "evt_a1", at: T0 + 10_000 }),
			T0 + 40_000,
		);
		s.handle(
			sub({
				subscriptionId: "sub_b",
				eventId: "evt_b1",
				items: [
					{ lookupKey: tierKey("sparkle-4", "month"), interval: "month" },
				],
				at: T0 + 30_000,
			}),
			T0 + 40_000,
		);
		const r = s.handle(
			sub({
				subscriptionId: "sub_a",
				eventId: "evt_a2",
				cancelAtPeriodEnd: true,
				at: T0 + 20_000,
			}),
			T0 + 40_000,
		);
		expect(r.rowChanges).toBeNull();
		expect(grantsOf(s).membership).toMatchObject({
			subscriptionId: "sub_b",
			tierId: "sparkle-4",
		});
	});

	test("a canceled subscription whose price left the menu is not refused: it ends, the credits lapse, the tier stays", () => {
		const s = store();
		create(s);
		const r = s.handle(
			sub({
				type: "customer.subscription.deleted",
				status: "canceled",
				items: [
					{ lookupKey: "b4u_sch_vol_t_ghost_month_100_usd", interval: "month" },
				],
				at: T0 + DAY,
			}),
			T0 + DAY,
		);
		expect(r.refused).toBeUndefined();
		const grants = grantsOf(s);
		expect(grants.endedAt).toBe(T0 + DAY);
		expect(grants.membership).toMatchObject({
			status: "ended",
			tierId: "sparkle-2",
			interval: "month",
		});
		expect(s.avail(D("2026-03-15T18:00:01Z"))).toBe(0);
	});

	test("an unknown item on another subscription than the holder's is not refused, it changes nothing", () => {
		const s = store();
		create(s);
		const r = s.handle(
			sub({
				subscriptionId: "sub_old",
				items: [
					{ lookupKey: "b4u_sch_vol_t_ghost_month_100_usd", interval: "month" },
				],
				at: T0 + DAY,
			}),
			T0 + DAY,
		);
		expect(r).toEqual({ rowChanges: null, events: [] });
	});

	test("a subscription that names no family and meets no stored holder is not ours to record", () => {
		const s = store();
		const r = s.handle(sub({ metadata: null }), T0 + 20_000);
		expect(r).toEqual({ rowChanges: null, events: [] });
		// Once the family has rows, the stored holder names it and the metadata is not needed.
		create(s);
		s.handle(
			sub({ metadata: null, cancelAtPeriodEnd: true, at: T0 + DAY }),
			T0 + DAY,
		);
		expect(grantsOf(s).membership?.cancelAtPeriodEnd).toBe(true);
	});

	test("two families' cancels book distinct expiry events, though they share row ids", () => {
		const idems = ["fam_a", "fam_b"].map((family) => {
			const s = store();
			const tagged = { b4u_school: SCHOOL, family_id: family };
			s.handle(
				invoicePaid({
					eventId: `evt_create_${family}`,
					invoiceId: `in_${family}`,
					at: T0 + 10_000,
					paidAt: T0 + 5000,
					subscriptionId: "sub_1",
					reason: "subscription_create",
					periodStart: T0,
					periodEnd: T1,
					lines: [
						{
							lookupKey: tierKey("sparkle-2", "month"),
							amount: 26000,
							interval: "month",
						},
					],
					metadata: tagged,
				}),
				T0 + 10_000,
			);
			const r = s.handle(
				sub({
					type: "customer.subscription.deleted",
					status: "canceled",
					eventId: `evt_del_${family}`,
					metadata: tagged,
					at: T0 + DAY,
				}),
				T0 + DAY,
			);
			return r.events.map((e) => e.idem);
		});
		expect(idems[0]).toHaveLength(1);
		expect(idems[0]?.[0]).not.toBe(idems[1]?.[0]);
	});

	test("deleted records the end and still lapses the credits", () => {
		const s = store();
		create(s);
		s.handle(
			sub({
				type: "customer.subscription.deleted",
				status: "canceled",
				at: T0 + DAY,
			}),
			T0 + DAY,
		);
		const grants = grantsOf(s);
		expect(grants.membership).toMatchObject({
			status: "ended",
			tierId: "sparkle-2",
			renewsAt: null,
			endsAt: null,
		});
		expect(grants.endedAt).toBe(T0 + DAY);
		expect(s.avail(T0 + 2 * DAY)).toBe(2);
		expect(s.avail(D("2026-03-15T18:00:01Z"))).toBe(0);
	});
});

describe("deduction order", () => {
	const DAY = 86_400_000;
	/** A one-month gift bought ten days before the tier: it lapses before the tier's first reset. */
	const gifted = (deductionOrder: BillingPolicy["deductionOrder"]) => {
		const policy = { ...DEFAULT_POLICY, giftSessionMonths: 1, deductionOrder };
		const s = store(menu, policy);
		s.handle(
			invoicePaid({
				eventId: "evt_gift",
				invoiceId: "in_gift",
				at: T0 - 10 * DAY,
				subscriptionId: null,
				reason: "manual",
				periodStart: T0 - 10 * DAY,
				periodEnd: T0 - 10 * DAY,
				lines: [{ lookupKey: addonKey("gift-visit"), amount: 13000 }],
				metadata,
			}),
			T0 - 10 * DAY,
		);
		create(s);
		return { s, policy };
	};
	/** The credit rows one `track` of a visit takes from, with the org the policy makes for it. */
	const drawnFrom = (world: ReturnType<typeof gifted>) => {
		const identity = {
			orgId: SCHOOL,
			env: "live" as const,
			customerId: HOLDER,
			entityId: null,
		};
		const state = stateFromRows({
			identity,
			revision: world.s.revision,
			rows: world.s.rows,
		});
		const run = runOnState({
			state,
			catalog: toCatalog(catalogRows),
			command: {
				schemaVersion: 1,
				type: "track",
				org: commandOrg(world.policy),
				commandId: "track_1",
				requestId: "track_1",
				identity,
				occurredAt: T0 + DAY,
				featureId: "visit",
				internalFeatureId: "feat_visit",
				value: 1,
				overageBehavior: "reject",
				properties: null,
				usageEvent: null,
			},
		});
		return (run.mutation?.changes ?? [])
			.filter((c) => c.table === "customerEntitlements" && c.op === "increment")
			.map((c) => (c as { id: string }).id);
	};

	test("by expiry, the gift that lapses before the tier's next reset is spent first", () => {
		const rows = drawnFrom(gifted("expiry"));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatch(/^ce_gift_/);
	});

	test("the engine's own order spends the refilling tier row first", () => {
		const rows = drawnFrom(gifted("engine"));
		expect(rows).toEqual(["ce_tier_visit_month"]);
	});
});

describe("input event id", () => {
	test("every event a history makes passes the ledger's envelope, cause included", () => {
		const s = store();
		create(s);
		renew(s);
		s.handle(refundOf("in_1"), T2);
		expect(s.events.length).toBeGreaterThan(0);
		for (const e of s.events)
			expect(validateEvent(e).errors, e.idem).toEqual([]);
	});

	test("an eventId that is not a ULID (Stripe's own id) is refused, nothing written", () => {
		const r = handleStripeEvent({
			event: invoicePaid({
				eventId: "evt_x",
				invoiceId: "in_x",
				at: T0,
				subscriptionId: "sub_1",
				reason: "subscription_create",
				periodStart: T0,
				periodEnd: T1,
				lines: [
					{
						lookupKey: tierKey("sparkle-2", "month"),
						amount: 26000,
						interval: "month",
					},
				],
				metadata,
			}),
			eventId: "evt_x",
			menu,
			menuVersion: MENU_VERSION,
			policy: DEFAULT_POLICY,
			policyVersion: POLICY_VERSION,
			rows: [],
			revision: 0,
			catalog: catalogRows,
			now: T0,
			priceIds,
		});
		expect(r.rowChanges).toBeNull();
		expect(r.events).toEqual([]);
		expect(r.refused?.reason).toBe("bad_event");
		expect(r.refused?.message).toMatch(/ULID/);
	});
});
