/**
 * Credit expiry over time (breakage): granted credits that go unused roll over once, then lapse. Hand numbers only: the
 * price list is fixtures/billing/grants/menu.json (sparkle-2 26,000 a month, 2 visits, rollover max 2 for 1 month;
 * sparkle-1 13,000 a month, 1 visit, rollover max 1 for 1 month), Stripe's fee is 2.9% + 30 cents, rounded.
 */
import {
	FEB15,
	HOUR,
	invoice,
	JAN15,
	MAR15,
	ms,
	tierLine,
} from "../e2e-events.js";
import {
	type Case,
	type Step,
	stripeBalance,
	stripeInvoice,
} from "../e2e-matrix.js";
import { FAMILY, SCHOOL } from "../handler-harness.js";
import type { RawEvent } from "../stripe-events.js";

const SPARKLE_1 = 13_000;
const SPARKLE_2 = 26_000;
const APR15 = "2026-04-15T18:00:00Z";
const FIRST_AT = ms(JAN15);
const SECOND_FAMILY = "fam_b2";
const SECOND_SUBSCRIPTION = "sub_b";
/** The second family pays two hours after the first. */
const LATER = 2 * HOUR;

const stamp = (atMs: number): string =>
	`${new Date(atMs).toISOString().slice(0, 19)}Z`;

const applied = (at: number, event: RawEvent): Step => ({
	at,
	event,
	answer: [200, "applied"],
});

const visits = (family: string) => `avail:family:${family}:visit`;

/** Sparkle-2 member A: the first payment, then the cycles ending 15 February and 15 March. */
const memberA = (
	id: string,
	paidAt: number,
	cycle: { start: number; end: number },
	reason: "subscription_create" | "subscription_cycle",
	next?: { start: number; end: number },
): RawEvent =>
	invoice({
		id,
		at: paidAt,
		reason,
		start: cycle.start,
		end: cycle.end,
		lines: [
			tierLine("sparkle-2", {
				amount: SPARKLE_2,
				...(next ? { periodStart: next.start, periodEnd: next.end } : {}),
			}),
		],
	});

/** Sparkle-1 member B, on its own subscription and family. */
const memberB = (
	id: string,
	paidAt: number,
	cycle: { start: number; end: number },
	reason: "subscription_create" | "subscription_cycle",
	next?: { start: number; end: number },
): RawEvent =>
	invoice({
		id,
		at: paidAt,
		reason,
		subscription: SECOND_SUBSCRIPTION,
		family: SECOND_FAMILY,
		start: cycle.start,
		end: cycle.end,
		lines: [
			tierLine("sparkle-1", {
				amount: SPARKLE_1,
				...(next ? { periodStart: next.start, periodEnd: next.end } : {}),
			}),
		],
	});

const charge = (invoiceId: string, gross: number, fee: number, atMs: number) =>
	stripeBalance(`txn_${invoiceId}`, "charge", gross, fee, stamp(atMs));

const JAN_CYCLE = { start: FIRST_AT, end: ms(FEB15) };
const FEB_CYCLE = { start: ms(FEB15), end: ms(MAR15) };
const MAR_CYCLE = { start: ms(MAR15), end: ms(APR15) };

const FEB_RENEWAL_A = memberA(
	"in_2",
	ms(FEB15),
	JAN_CYCLE,
	"subscription_cycle",
	FEB_CYCLE,
);
/** The March renewal is paid five minutes after the cycle boundary, the cron having run on the boundary. */
const MARCH_RENEWAL_AT = ms(MAR15) + 5 * 60_000;
const MARCH_16 = ms("2026-03-16T12:00:00Z");
const APRIL_16 = ms("2026-04-16T12:00:00Z");

export const CASES: Case[] = [
	{
		id: "credit-expiry",
		title:
			"credit expiry: unused visits roll over once, then lapse (breakage), a rollover cap loses part",
		path: "invoice.paid (subscription_cycle) resets + the cron's credit.expired (lapse)",
		fees: {
			in_1: 784,
			in_2: 784,
			in_3: 784,
			in_b1: 407,
			in_b2: 407,
		},
		steps: [
			applied(
				FIRST_AT,
				memberA("in_1", FIRST_AT, JAN_CYCLE, "subscription_create"),
			),
			applied(
				FIRST_AT + LATER,
				memberB("in_b1", FIRST_AT + LATER, JAN_CYCLE, "subscription_create"),
			),
			applied(ms(FEB15), FEB_RENEWAL_A),
			// Stripe retries the renewal a minute later: the same event id
			{
				at: ms(FEB15) + 60_000,
				event: FEB_RENEWAL_A,
				answer: [200, "duplicate"],
			},
			applied(
				ms(FEB15) + LATER,
				memberB(
					"in_b2",
					ms(FEB15) + LATER,
					JAN_CYCLE,
					"subscription_cycle",
					FEB_CYCLE,
				),
			),
			// 15 March 18:00: the visits A rolled over on 15 February lapse at this instant, and the cron runs before the renewal
			{ kind: "lapse", at: ms(MAR15), family: FAMILY, feature: "visit" },
			applied(
				MARCH_RENEWAL_AT,
				memberA(
					"in_3",
					MARCH_RENEWAL_AT,
					FEB_CYCLE,
					"subscription_cycle",
					MAR_CYCLE,
				),
			),
			// B never pays again: B's January unit (rolled over on 15 February) lapses on 15 March, the day after the cron runs
			{
				kind: "lapse",
				at: MARCH_16,
				family: SECOND_FAMILY,
				feature: "visit",
			},
			// the cron runs twice at the same instant: the second books nothing
			{
				kind: "lapse",
				at: MARCH_16,
				family: SECOND_FAMILY,
				feature: "visit",
			},
			// A stops paying after March: the visits rolled over on 15 March lapse on 15 April, the cron runs the day after
			{ kind: "lapse", at: APRIL_16, family: FAMILY, feature: "visit" },
			{ kind: "ship", at: APRIL_16 + HOUR },
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				monthly: true,
				handMonthly: {
					Jan: {
						"income:membership:sparkle-2": SPARKLE_2,
						"income:membership:sparkle-1": SPARKLE_1,
						fees: 784 + 407,
					},
					Feb: {
						"income:membership:sparkle-2": SPARKLE_2,
						"income:membership:sparkle-1": SPARKLE_1,
						fees: 784 + 407,
					},
					Mar: { "income:membership:sparkle-2": SPARKLE_2, fees: 784 },
					// the April column exists for the expiry only: no money moves
					Apr: {},
				},
				// A: 3 x 260.00 = 780.00, fee 7.84 each (26,000 x 2.9% = 754 + 30); B: 2 x 130.00 = 260.00, fee 4.07 each (13,000
				// x 2.9% = 377 + 30): income 1,040.00, fees 23.52 + 8.14 = 31.66, net and Stripe's balance 1,008.34
				// credits A (sparkle-2, 2 a month, carry max 2 for one month): 2 on 15 January; 15 February: the 2 unused roll over
				// (they lapse 15 March 18:00), 2 are granted: 4; 15 March 18:00 the cron expires those 2 (2 left); the renewal five
				// minutes later rolls the 2 unused over again (lapse 15 April 18:00) and grants 2: 4; the cron on 16 April expires
				// the 2 rolled on 15 March: 2 are left.
				// credits B (sparkle-1, 1 a month, max 1): 1 on 15 January; 15 February: 1 rolled, 1 granted: 2; no payment in March,
				// so the cron on 16 March expires the rolled one (expired 1): 1 left (the second cron run books nothing).
				// credit totals: granted 8 (A 6, B 2), expired 5 (A 4, B 1): A 2 + B 1 = 3 are left.
				hand: {
					"income:membership:sparkle-2": 3 * SPARKLE_2,
					"income:membership:sparkle-1": 2 * SPARKLE_1,
					fees: 3 * 784 + 2 * 407,
					stripe: 3 * SPARKLE_2 + 2 * SPARKLE_1 - (3 * 784 + 2 * 407),
					net: 3 * SPARKLE_2 + 2 * SPARKLE_1 - (3 * 784 + 2 * 407),
					[visits(FAMILY)]: 2,
					[visits(SECOND_FAMILY)]: 1,
				},
				stripe: {
					invoices: [
						stripeInvoice("in_1", SPARKLE_2, JAN15),
						stripeInvoice("in_b1", SPARKLE_1, stamp(FIRST_AT + LATER)),
						stripeInvoice("in_2", SPARKLE_2, FEB15),
						stripeInvoice("in_b2", SPARKLE_1, stamp(ms(FEB15) + LATER)),
						stripeInvoice("in_3", SPARKLE_2, stamp(MARCH_RENEWAL_AT)),
					],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						charge("in_1", SPARKLE_2, 784, FIRST_AT),
						charge("in_b1", SPARKLE_1, 407, FIRST_AT + LATER),
						charge("in_2", SPARKLE_2, 784, ms(FEB15)),
						charge("in_b2", SPARKLE_1, 407, ms(FEB15) + LATER),
						charge("in_3", SPARKLE_2, 784, MARCH_RENEWAL_AT),
					],
				},
				reconcile: { "2026-01": [], "2026-02": [], "2026-03": [] },
			},
		],
		notes: [
			"credits granted 8 (A 2+2+2, B 1+1), credits expired 5 (A 2 by the cron at 15 March 18:00, before the renewal, + 2 by the cron on 16 April; B 1 by the cron on 16 March), 3 left",
			"KPI by month (school time, Denver): credits_granted Jan 3, Feb 3, Mar 2, Apr 0; credits_expired Mar 3 (A 2 and B 1, all lapsed 15 March), Apr 2",
			"breakage_rate: Mar 3/2 = 1.5 (expired in a month with fewer grants), Apr 0 (no grants: the ratio is 0 by definition)",
			"the duplicate delivery of in_2 books nothing; the second cron run on 16 March books nothing",
		],
	},
];
