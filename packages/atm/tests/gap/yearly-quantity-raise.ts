/**
 * A yearly payer of a tier sold in quantities buys one seat, raises to two seats a hundred days in (the subscription_update
 * invoice with its proration pair) and renews a year after the purchase at two seats. Hand numbers only: sparkle-2 costs
 * 260,000 a year per seat (fixtures/billing/grants/menu.json) and grants 2 visits a month, 12 months at once = 24 visits per
 * seat a year, rollover max 2 per seat for one month. Stripe's fee is 2.9% + 30 cents, rounded.
 */

import type { Menu } from "../../src/billing/types.js";
import {
	DAY,
	HOUR,
	invoice,
	JAN15,
	link,
	ms,
	tierLine,
} from "../e2e-events.js";
import {
	type Case,
	type Step,
	stripeBalance,
	stripeInvoice,
} from "../e2e-matrix.js";
import { menu as baseMenu, FAMILY, SCHOOL } from "../handler-harness.js";
import { type RawEvent, subscriptionEvent } from "../stripe-events.js";

/** Sparkle-2 sold in 1, 2 or 4 seats. */
const quantityMenu: Menu = {
	...baseMenu,
	tiers: baseMenu.tiers.map((tier) =>
		tier.id === "sparkle-2" ? { ...tier, quantities: [1, 2, 4] } : tier,
	),
};

const SEAT_YEARLY = 260_000;
const FIRST_AT = ms(JAN15);
const YEAR_END = FIRST_AT + 365 * DAY;
const SECOND_YEAR_END = YEAR_END + 365 * DAY;
const RAISED_AT = FIRST_AT + 100 * DAY;
const RETRY_AFTER = 6 * 60_000;

const stamp = (atMs: number): string =>
	`${new Date(atMs).toISOString().slice(0, 19)}Z`;

const visits = `avail:family:${FAMILY}:visit`;

const seatLine = (
	quantity: number,
	amount: number,
	period?: { start: number; end: number; proration?: boolean },
) =>
	tierLine("sparkle-2", {
		menu: quantityMenu,
		interval: "year",
		amount,
		quantity,
		...(period
			? {
					periodStart: period.start,
					periodEnd: period.end,
					...(period.proration ? { proration: true } : {}),
				}
			: {}),
	});

const firstInvoice = invoice({
	id: "in_1",
	at: FIRST_AT,
	end: YEAR_END,
	lines: [seatLine(1, SEAT_YEARLY)],
});

// 265 of the 365 days are left at the raise: the unused seat is credited 260,000 x 265/365 = 188,767.12 (188,767) and two
// seats are charged 520,000 x 265/365 = 377,534.25 (377,534); the member pays the difference, 188,767
const RAISE_CREDIT = -188_767;
const RAISE_CHARGE = 377_534;
const RAISE_PAID = 188_767;
const RAISE_PERIOD = { start: RAISED_AT, end: YEAR_END, proration: true };
const raiseInvoice = invoice({
	id: "in_2",
	at: RAISED_AT,
	reason: "subscription_update",
	start: FIRST_AT,
	end: RAISED_AT,
	lines: [
		seatLine(1, RAISE_CREDIT, RAISE_PERIOD),
		seatLine(2, RAISE_CHARGE, RAISE_PERIOD),
	],
});

const seatSubscription = (
	eventId: string,
	quantity: number,
	at: number,
	start: number,
	end: number,
): RawEvent =>
	subscriptionEvent({
		type: "customer.subscription.updated",
		eventId,
		subscriptionId: "sub_1",
		status: "active",
		items: [
			{
				lookupKey: tierLine("sparkle-2", {
					menu: quantityMenu,
					interval: "year",
					amount: 0,
				}).lookupKey,
				interval: "year",
				quantity,
			},
		],
		periodStart: start,
		periodEnd: end,
		at,
		metadata: { b4u_school: SCHOOL, family_id: FAMILY },
	});

const RENEWED_AT = YEAR_END;
const renewalInvoice = invoice({
	id: "in_3",
	at: RENEWED_AT,
	reason: "subscription_cycle",
	start: FIRST_AT,
	end: YEAR_END,
	lines: [
		seatLine(2, 2 * SEAT_YEARLY, { start: YEAR_END, end: SECOND_YEAR_END }),
	],
});

const applied = (at: number, event: RawEvent): Step => ({
	at,
	event,
	answer: [200, "applied"],
});

const charge = (invoiceId: string, gross: number, fee: number, atMs: number) =>
	stripeBalance(`txn_${invoiceId}`, "charge", gross, fee, stamp(atMs));

// fees: 260,000 x 2.9% = 7,540 + 30; 188,767 x 2.9% = 5,474.24 + 30 = 5,504.24; 520,000 x 2.9% = 15,080 + 30
const FEE_FIRST = 7570;
const FEE_RAISE = 5504;
const FEE_RENEWAL = 15_110;

export const CASES: Case[] = [
	{
		id: "yearly-quantity-raise",
		title:
			"yearly payer: one seat, a raise to two seats 100 days in, a yearly renewal at two seats",
		path: "invoice.paid (year, subscription_update quantity pair), then subscription_cycle at the raised quantity",
		menu: quantityMenu,
		fees: { in_1: FEE_FIRST, in_2: FEE_RAISE, in_3: FEE_RENEWAL },
		steps: [
			applied(FIRST_AT, firstInvoice),
			applied(FIRST_AT + 1000, link("in_1", FIRST_AT + 1000)),
			applied(RAISED_AT, raiseInvoice),
			// Stripe sends the raise again: the same event id
			{
				at: RAISED_AT + 60_000,
				event: raiseInvoice,
				answer: [200, "duplicate"],
			},
			// the subscription's own update (two seats) arrives after the invoice: it grants nothing more
			applied(
				RAISED_AT + HOUR,
				seatSubscription(
					"evt_sub_two_seats",
					2,
					RAISED_AT + HOUR,
					FIRST_AT,
					YEAR_END,
				),
			),
			// the renewal: the caller's fee lookup fails, Stripe answers 500 and retries six minutes later
			{
				at: RENEWED_AT,
				event: renewalInvoice,
				answer: [500, "threw"],
				feeFails: true,
			},
			applied(RENEWED_AT + RETRY_AFTER, renewalInvoice),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// revenue of sparkle-2: 260,000 + 188,767 + 520,000 = 968,767 (the raise books the 188,767 paid, not the two
				// proration lines); fees 75.70 + 55.04 + 151.10 = 281.84; cash and net income 9,687.67 - 281.84 = 9,405.83
				// credits: 24 visits for one seat (2 x 12); the raise adds 1 seat x 24 x 265/365 = 17.42, rounded up to 18: 42;
				// the renewal refills 2 seats x 24 = 48 and keeps 4 of the 42 unused (cap 2 per seat x 2 seats): 52
				hand: {
					"income:membership:sparkle-2": 260_000 + RAISE_PAID + 520_000,
					fees: FEE_FIRST + FEE_RAISE + FEE_RENEWAL,
					stripe:
						260_000 +
						RAISE_PAID +
						520_000 -
						(FEE_FIRST + FEE_RAISE + FEE_RENEWAL),
					net:
						260_000 +
						RAISE_PAID +
						520_000 -
						(FEE_FIRST + FEE_RAISE + FEE_RENEWAL),
					[visits]: 52,
				},
				stripe: {
					invoices: [
						stripeInvoice("in_1", SEAT_YEARLY, JAN15),
						stripeInvoice("in_2", RAISE_PAID, stamp(RAISED_AT)),
						stripeInvoice("in_3", 2 * SEAT_YEARLY, stamp(RENEWED_AT)),
					],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						charge("in_1", SEAT_YEARLY, FEE_FIRST, FIRST_AT),
						charge("in_2", RAISE_PAID, FEE_RAISE, RAISED_AT),
						charge("in_3", 2 * SEAT_YEARLY, FEE_RENEWAL, RENEWED_AT),
					],
				},
				reconcile: { "2026-01": [], "2026-04": [], "2027-01": [] },
			},
		],
		notes: [
			"proration: 265 of 365 days left at the raise; credit 260,000 x 265/365 = 188,767.12, charge 520,000 x 265/365 = 377,534.25, paid 377,534 - 188,767 = 188,767",
			"fees: 7,570 (260,000 x 2.9% = 7,540 + 30), 5,504 (188,767 x 2.9% = 5,474.24 + 30 = 5,504.24), 15,110 (520,000 x 2.9% = 15,080 + 30)",
			"credits: 24 granted in Jan 2026; the raise adds 18 in Apr 2026 (24 x 265/365 = 17.42, rounded up), booked as credit.adjusted so it is not in credits_granted; 48 granted in Jan 2027 (2 seats x 24)",
			"renewal: before it 42 visits are unused; the rollover cap is 2 per seat x 2 seats = 4, so 4 are kept and 38 expire at the reset (refill 48 less the 10 by which the balance rose): 4 + 48 = 52",
			"KPI by month: credits_granted Jan 2026 24, Apr 2026 0 (the raise is an adjustment), Jan 2027 48; credits_expired Jan 2027 38; breakage_rate Jan 2027 38/48 = 0.7917",
			"the duplicate raise books nothing; the 500 on the renewal books nothing until the retry",
		],
	},
];
