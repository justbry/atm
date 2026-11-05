import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EMPTY_GRANTS_STATE, menuCatalogRows } from "../src/billing/grants.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
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
import type { Menu, StripeEventResult } from "../src/billing/types.js";
import { balancesOf } from "../src/ledger/replay.js";
import { toCatalog } from "../src/ledger/run.js";
import type { AtmEvent } from "../src/types.js";
import {
	chargeRefunded,
	disputeEvent,
	invoicePaid,
	paymentIntentOf,
	priceIdOf,
	subscriptionDeleted,
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

/** What publishing the menu would have recorded: each lookup key's Stripe price id. */
const priceIds = Object.fromEntries(
	[...menuLineItems(SCHOOL, menu).keys()].map((key) => [key, priceIdOf(key)]),
);

/** The family service in miniature: stored rows and revision, the event log, one write per event. */
const store = (world: Menu = menu) => {
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
				eventId: id,
				menu: world,
				menuVersion: MENU_VERSION,
				policy: DEFAULT_POLICY,
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

		expect(r.events.map((e) => e.event_type)).toEqual(["credit.granted"]);
		const event = r.events[0] as AtmEvent;
		expect(event.cause).toBe("evt_create");
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
		expect(r.rowChanges?.nextRevision).toBe(2);
		expect(r.events.length).toBeGreaterThan(0);
		for (const e of r.events) {
			expect(e.cause).toBe("evt_cycle_2");
			expect(e.labels.menu_version).toBe("3");
			expect(sumsToZero(e)).toBe(true);
		}
		expect(s.avail(T1 + 20_000)).toBe(4);
	});

	test("a yearly grant on a monthly plan is booked by the reset that fills it", () => {
		const s = store();
		const r = create(s, "sparkle-4");
		expect(
			r.events.map((e) => [e.event_type, e.labels.feature, e.text]),
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
		expect(r.events.map((e) => [e.labels.feature, e.text])).toEqual([
			["retreat", "granted 1 retreat on sparkle-4@v3"],
			["visit", "granted 4 visit on sparkle-4@v3"],
		]);
		expect(new Set(r.events.map((e) => e.idem)).size).toBe(2);
		expect(r.events.map((e) => e.idem)).toEqual([
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
		expect(r.events.map((e) => e.event_type)).toEqual(["credit.adjusted"]);
		expect(r.events[0]?.cause).toBe("evt_re_1");
		expect(r.events[0]?.labels.mapping).toBe("stripe/charge.refunded@v1");
		expect(s.avail(T0 + 1)).toBe(0);
		expect(s.handle(refundOf("in_1"), T1)).toEqual({
			rowChanges: null,
			events: [],
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

	test("a canceled subscription is a row write with no credit event; the visits then lapse on their own", () => {
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
		expect(r.events).toEqual([]);
		expect(r.rowChanges?.nextRevision).toBe(2);
		expect(s.avail(T0 + 2 * 86_400_000)).toBe(2);
		expect(s.avail(D("2026-03-15T18:00:01Z"))).toBe(0);
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
		expect(r.events.map((e) => [e.event_type, e.labels.plan])).toEqual([
			["credit.granted", "gift"],
		]);
		expect(s.avail(D("2026-07-14T00:00:00Z"))).toBe(1);
		expect(s.avail(D("2026-07-16T00:00:00Z"))).toBe(0);

		const dollars = store();
		const d = dollars.handle(gift(addonKey("gift-dollars"), 5000), T0);
		expect(d.events).toEqual([]);
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
		expect(s.handle(refund, T0 - 3_600_000)).toEqual({
			rowChanges: null,
			events: [],
		});
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

describe("refusals", () => {
	const input = (event: unknown) => ({
		event,
		eventId: "evt_x",
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
		expect(r.events).toHaveLength(1);
	});

	test("a refund or dispute for a family with no rows is nothing, not an error", () => {
		const r = handleStripeEvent(input(refundOf("in_unknown")));
		expect(r).toEqual({ rowChanges: null, events: [] });
	});
});
