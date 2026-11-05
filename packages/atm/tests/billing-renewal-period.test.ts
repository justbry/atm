/**
 * Renewals as Stripe really sends them (API 2025-10-29.clover, recorded in the sandbox): a `subscription_cycle`
 * invoice's own period is the PREVIOUS period, and its tier line carries the NEW one; a `subscription_create` invoice
 * has period_start == period_end, and the line carries the service period. The numbers below are those invoices'.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { addUtcMonths } from "../src/billing/grants.js";
import { grantsFromRows } from "../src/billing/rows.js";
import {
	addonPriceKey,
	lookupKeyOf,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { createStore, type Store } from "./billing-store.js";
import { invoicePaid } from "./stripe-events.js";

const SCHOOL = "sch_vol";
const FAMILY = "fam_8k2";
const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;
const menu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
const metadata = { b4u_school: SCHOOL, family_id: FAMILY };

// The real invoices (seconds to ms): create, then the first renewal; the renewal's own period is the create's.
const CREATE_START = 1793865498 * SECOND;
const CYCLE_2_START = 1796457498 * SECOND;
const CYCLE_2_PAID = 1796461098 * SECOND;
const CYCLE_2_END = 1799135898 * SECOND;
// A third period, invented in the same shape: Jan 5 to Feb 5 (UTC).
const CYCLE_3_END = addUtcMonths(CYCLE_2_END, 1);

const tierLine = (tierId: string, interval: "month" | "year") => {
	const price = menu.tiers
		.find((t) => t.id === tierId)
		?.prices.find((p) => p.interval === interval);
	return {
		lookupKey: lookupKeyOf(
			SCHOOL,
			tierPriceKey(tierId, interval),
			price?.amount as number,
			menu.currency,
		),
		amount: price?.amount as number,
		interval,
	};
};

const newStore = () => createStore({ menu, school: SCHOOL, family: FAMILY });

/** `subscription_create`: the invoice's period is a point, the tier line carries the service period. */
const realCreate = (
	s: Store,
	{
		tierId = "sparkle-2",
		interval = "month",
		start = CREATE_START,
		end = CYCLE_2_START,
	}: {
		tierId?: string;
		interval?: "month" | "year";
		start?: number;
		end?: number;
	} = {},
) =>
	s.handle(
		invoicePaid({
			eventId: "evt_create",
			invoiceId: "in_create",
			at: start,
			subscriptionId: "sub_1",
			reason: "subscription_create",
			periodStart: start,
			periodEnd: start,
			lines: [
				{
					...tierLine(tierId, interval),
					periodStart: start,
					periodEnd: end,
				},
			],
			metadata,
		}),
		start,
	);

/** `subscription_cycle`: the invoice's period is the previous one, the tier line carries the new one. */
const realRenewal = (
	s: Store,
	{
		id,
		previous,
		period,
		paidAt = period.start + HOUR,
		tierId = "sparkle-2",
		interval = "month",
	}: {
		id: string;
		previous: { start: number; end: number };
		period: { start: number; end: number };
		paidAt?: number;
		tierId?: string;
		interval?: "month" | "year";
	},
) =>
	s.handle(
		invoicePaid({
			eventId: `evt_${id}`,
			invoiceId: `in_${id}`,
			at: paidAt,
			paidAt,
			subscriptionId: "sub_1",
			reason: "subscription_cycle",
			periodStart: previous.start,
			periodEnd: previous.end,
			lines: [
				{
					...tierLine(tierId, interval),
					periodStart: period.start,
					periodEnd: period.end,
				},
			],
			metadata,
		}),
		paidAt,
	);

const TIER_VISIT_ROW = "ce_tier_visit_month";
const FIRST = { start: CREATE_START, end: CYCLE_2_START };
const SECOND_PERIOD = { start: CYCLE_2_START, end: CYCLE_2_END };
const THIRD = { start: CYCLE_2_END, end: CYCLE_3_END };

/** The tier's visit row, as the engine stores it. */
const visitRow = (s: Store) =>
	s.rows.find(
		(r) => r.table === "customerEntitlements" && r.id === TIER_VISIT_ROW,
	)?.data as { next_reset_at: number | null; balance: number } | undefined;

const rollovers = (s: Store) =>
	s.rows
		.filter((r) => r.table === "rollovers")
		.map((r) => r.data as { balance: number; expires_at: number | null });

describe("a real create, then a real subscription_cycle renewal", () => {
	test("the create grants the line's period: next reset at its end", () => {
		const s = newStore();
		expect(realCreate(s).refused).toBeUndefined();
		const state = grantsFromRows(s.rows);
		expect(state.cycleStart).toBe(CREATE_START);
		expect(state.cycleEnd).toBe(CYCLE_2_START);
		expect(state.anchor).toBe(CREATE_START);
		expect(visitRow(s)?.next_reset_at).toBe(CYCLE_2_START);
		expect(s.avail(CREATE_START + 1)).toBe(2);
	});

	test("the renewal resets at the new period start, refills, rolls over, and runs to the line's end", () => {
		const s = newStore();
		realCreate(s);
		s.spend(1, CREATE_START + 5 * DAY);
		expect(s.avail(CYCLE_2_START - SECOND)).toBe(1);

		const r = realRenewal(s, {
			id: "cycle_2",
			previous: FIRST,
			period: SECOND_PERIOD,
			paidAt: CYCLE_2_PAID,
		});
		expect(r.refused).toBeUndefined();

		// one leftover rolled over, two fresh visits
		expect(s.avail(CYCLE_2_PAID)).toBe(3);
		expect(visitRow(s)?.next_reset_at).toBe(CYCLE_2_END);
		const carried = rollovers(s);
		expect(carried).toHaveLength(1);
		// the rollover lapses a month after the cycle that ended
		expect(carried[0]?.expires_at).toBe(addUtcMonths(CYCLE_2_START, 1));
		expect(s.avail(addUtcMonths(CYCLE_2_START, 1) + SECOND)).toBe(2);

		const state = grantsFromRows(s.rows);
		expect(state.cycleStart).toBe(CYCLE_2_START);
		expect(state.cycleEnd).toBe(CYCLE_2_END);
		expect(state.anchor).toBe(CREATE_START);
		expect(state.invoices.in_cycle_2?.granted.map((g) => g.units)).toEqual([2]);
		expect(state.invoices.in_cycle_2?.granted[0]?.rolloverExpiresAt).toBe(
			addUtcMonths(CYCLE_2_END, 1),
		);
	});

	test("a second renewal follows the first: no drift", () => {
		const s = newStore();
		realCreate(s);
		realRenewal(s, {
			id: "cycle_2",
			previous: FIRST,
			period: SECOND_PERIOD,
		});
		realRenewal(s, { id: "cycle_3", previous: SECOND_PERIOD, period: THIRD });
		const state = grantsFromRows(s.rows);
		expect(state.cycleStart).toBe(CYCLE_2_END);
		expect(state.cycleEnd).toBe(CYCLE_3_END);
		expect(visitRow(s)?.next_reset_at).toBe(CYCLE_3_END);
		// two visits unused each time: the rollover is capped at the tier's max of 2
		expect(s.avail(CYCLE_2_END + HOUR)).toBe(4);
	});

	test("a renewal paid weeks late still resets from the period start", () => {
		const onTime = newStore();
		realCreate(onTime);
		realRenewal(onTime, {
			id: "cycle_2",
			previous: FIRST,
			period: SECOND_PERIOD,
		});

		const late = newStore();
		realCreate(late);
		const paidAt = CYCLE_2_START + 21 * DAY;
		const r = realRenewal(late, {
			id: "cycle_2",
			previous: FIRST,
			period: SECOND_PERIOD,
			paidAt,
		});
		expect(r.refused).toBeUndefined();
		expect(visitRow(late)?.next_reset_at).toBe(CYCLE_2_END);
		expect(rollovers(late)[0]?.expires_at).toBe(
			rollovers(onTime)[0]?.expires_at as number,
		);
		expect(grantsFromRows(late.rows).cycleStart).toBe(CYCLE_2_START);
		expect(late.avail(paidAt)).toBe(4);
	});
});

describe("a yearly plan", () => {
	const YEAR_START = CREATE_START;
	const YEAR_END = addUtcMonths(YEAR_START, 12);
	const NEXT_YEAR_END = addUtcMonths(YEAR_START, 24);

	test("renews on the line's year, not the invoice's previous year", () => {
		const s = newStore();
		realCreate(s, { interval: "year", start: YEAR_START, end: YEAR_END });
		expect(grantsFromRows(s.rows).cycleEnd).toBe(YEAR_END);
		const r = realRenewal(s, {
			id: "year_2",
			previous: { start: YEAR_START, end: YEAR_END },
			period: { start: YEAR_END, end: NEXT_YEAR_END },
			interval: "year",
		});
		expect(r.refused).toBeUndefined();
		const state = grantsFromRows(s.rows);
		expect(state.cycleStart).toBe(YEAR_END);
		expect(state.cycleEnd).toBe(NEXT_YEAR_END);
		expect(state.anchor).toBe(YEAR_START);
	});
});

describe("an upgrade in the middle of a real-shaped cycle", () => {
	test("is prorated over the line's period, not the invoice's previous one", () => {
		const s = newStore();
		realCreate(s);
		realRenewal(s, {
			id: "cycle_2",
			previous: FIRST,
			period: SECOND_PERIOD,
		});
		// three days into the 31-day second period: 28 of 31 days are left
		const at = CYCLE_2_START + 3 * DAY;
		const before = s.avail(at);
		const r = s.handle(
			invoicePaid({
				eventId: "evt_up",
				invoiceId: "in_up",
				at,
				subscriptionId: "sub_1",
				reason: "subscription_update",
				periodStart: at,
				periodEnd: CYCLE_2_END,
				lines: [
					{
						...tierLine("sparkle-2", "month"),
						amount: -13000,
						proration: true,
						periodStart: at,
						periodEnd: CYCLE_2_END,
					},
					{
						...tierLine("sparkle-4", "month"),
						amount: 26000,
						proration: true,
						periodStart: at,
						periodEnd: CYCLE_2_END,
					},
				],
				metadata,
			}),
			at,
		);
		expect(r.refused).toBeUndefined();
		// sparkle-4 minus sparkle-2 is 2 visits: 2 x 28/31 rounds up to 2 (over the invoice's two-month span it would be 1)
		expect(s.avail(at)).toBe(before + 2);
		const state = grantsFromRows(s.rows);
		expect(state.tierId).toBe("sparkle-4");
		expect(state.cycleStart).toBe(CYCLE_2_START);
		expect(state.cycleEnd).toBe(CYCLE_2_END);
		expect(visitRow(s)?.next_reset_at).toBe(CYCLE_2_END);
	});
});

describe("an invoice whose lines carry no period", () => {
	test("falls back to the invoice's own period", () => {
		const s = newStore();
		const start = CREATE_START;
		const end = CYCLE_2_START;
		const raw = invoicePaid({
			eventId: "evt_plain",
			invoiceId: "in_plain",
			at: start,
			subscriptionId: "sub_1",
			reason: "subscription_create",
			periodStart: start,
			periodEnd: end,
			lines: [tierLine("sparkle-2", "month")],
			metadata,
		});
		// Stripe gives every real line a period; a hand-made invoice may not.
		for (const line of raw.data.object.lines.data) line.period = undefined;
		const r = s.handle(raw, start);
		expect(r.refused).toBeUndefined();
		const state = grantsFromRows(s.rows);
		expect(state.cycleStart).toBe(start);
		expect(state.cycleEnd).toBe(end);
		expect(visitRow(s)?.next_reset_at).toBe(end);
	});
});

describe("a tier line with a start but no end", () => {
	test("takes neither: start and end both come from the invoice, never a zero-length cycle", () => {
		const s = newStore();
		realCreate(s);
		const raw = invoicePaid({
			eventId: "evt_half",
			invoiceId: "in_half",
			at: CYCLE_2_PAID,
			paidAt: CYCLE_2_PAID,
			subscriptionId: "sub_1",
			reason: "subscription_cycle",
			periodStart: FIRST.start,
			periodEnd: FIRST.end,
			lines: [
				{
					...tierLine("sparkle-2", "month"),
					periodStart: SECOND_PERIOD.start,
					periodEnd: SECOND_PERIOD.end,
				},
			],
			metadata,
		});
		// The line's start is the new period's, which is the invoice's end: paired with it, the cycle would be empty.
		for (const line of raw.data.object.lines.data) line.period.end = undefined;
		const r = s.handle(raw, CYCLE_2_PAID);
		expect(r.refused).toBeUndefined();
		const state = grantsFromRows(s.rows);
		expect(state.cycleStart).toBe(FIRST.start);
		expect(state.cycleEnd).toBe(FIRST.end);
	});
});

describe("an off-cycle add-on bought mid-cycle", () => {
	// A monthly add-on whose visits are granted once a year: its row is seeded and refilled by the engine's reset.
	const shineMenu: Menu = {
		...menu,
		addons: [
			...menu.addons,
			{
				id: "shine",
				name: "Shine",
				price: { amount: 4000, every: "month" },
				grants: [{ featureId: "visit", amount: 6, every: "year" }],
			},
		],
	};
	const shineKey = lookupKeyOf(
		SCHOOL,
		addonPriceKey("shine", "month"),
		4000,
		menu.currency,
	);

	test("is filled when the update invoice's period starts before the purchase", () => {
		const s = createStore({ menu: shineMenu, school: SCHOOL, family: FAMILY });
		realCreate(s);
		const boughtAt = CREATE_START + 10 * DAY;
		const before = s.avail(boughtAt);
		const r = s.handle(
			invoicePaid({
				eventId: "evt_shine",
				invoiceId: "in_shine",
				at: boughtAt,
				subscriptionId: "sub_1",
				reason: "subscription_update",
				// Pending items since the last invoice: the invoice's period opens at the cycle start, before the purchase.
				periodStart: CREATE_START,
				periodEnd: boughtAt,
				lines: [
					{
						lookupKey: shineKey,
						amount: 2800,
						interval: "month",
						proration: true,
						periodStart: boughtAt,
						periodEnd: CYCLE_2_START,
					},
				],
				metadata,
			}),
			boughtAt,
		);
		expect(r.refused).toBeUndefined();
		const granted = grantsFromRows(s.rows).invoices.in_shine?.granted ?? [];
		expect(granted.map((g) => g.units)).toEqual([6]);
		const row = s.rows.find(
			(x) => x.table === "customerEntitlements" && x.id === granted[0]?.rowId,
		)?.data as { balance: number; next_reset_at: number | null } | undefined;
		expect(row?.balance).toBe(6);
		expect(row?.next_reset_at).toBe(addUtcMonths(boughtAt, 12));
		expect(s.avail(boughtAt + SECOND)).toBe(before + 6);
	});
});
