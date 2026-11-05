/**
 * The cases of the end-to-end reconciliation matrix (`e2e-reconcile.test.ts`, `docs/e2e-reconciliation.md`).
 *
 * Every number below is written by hand, from the price list and Stripe's documented shapes, and none is read from the
 * handler, the log or a report:
 *   - `hand`    what the school's books must say. The sums are in the comments next to them.
 *   - `stripe`  Stripe's own records for the same history: invoices, refunds with their `re_` ids, payouts, disputes and
 *               balance transactions (a charge's `fee` is what Stripe kept; `net` = `amount` - `fee`).
 *   - `pinned`  where today's handler books something else, what it books (a discrepancy). A pinned number must differ
 *               from the hand number: when a fix lands the test fails and says the pin is stale.
 *   - `reconcile` the differences `atm reconcile` must print for each month ("kind object id"); empty is clean.
 *
 * `// DISCREPANCY: <id>` marks each pin and each expected difference; the ids are those of docs/e2e-reconciliation.md.
 * K1 (a dispute's money and fee, #66) and K2 (a non-USD invoice or payout, #68) were KNOWN here and are now fixed on dev:
 * their cases reconcile, with hand numbers worked out from the recorded dispute (26,000 withdrawn with a 1,500 fee).
 *
 * The price list (fixtures/billing/grants/menu.json, USD cents): sparkle-1 13,000 and 1 visit a month; sparkle-2 26,000
 * (260,000 a year) and 2 visits; sparkle-4 52,000, 4 visits and a retreat a year; glow 5,000 a month and 1 visit; pack
 * 9,000 once and 1 visit. A month is 31 days here (15 January to 15 February); Stripe's fee is 2.9% + 30 cents, rounded.
 */
import type { Menu } from "../src/billing/types.js";
import {
	addonLine,
	DAY,
	disputeOf,
	FEB15,
	HOUR,
	invoice,
	JAN15,
	link,
	MAR15,
	ms,
	payoutOf,
	refundOf,
	resent,
	subscriptionOf,
	tierLine,
} from "./e2e-events.js";
import {
	type Case,
	type Step,
	stripeBalance,
	stripeDispute,
	stripeInvoice,
	stripePayout,
	stripeRefund,
} from "./e2e-matrix.js";
import { menu as baseMenu, FAMILY, SCHOOL } from "./handler-harness.js";
import type { RawEvent } from "./stripe-events.js";

const SPARKLE_1 = 13_000;
const SPARKLE_2 = 26_000;
/** Stripe's dispute fee in the recorded sandbox dispute (`fee_details`: "Dispute fee", 1,500). */
const DISPUTE_FEE = 1500;
const FIRST_AT = ms(JAN15);
const SECOND_SCHOOL = "sch_two";
const OTHER_FAMILY = "fam_b2";
const THIRD_FAMILY = "fam_c3";
const visits = (family = FAMILY, kind = "avail", feature = "visit") =>
	`${kind}:family:${family}:${feature}`;
const PARENT = ["synthetic.parent@example.test", "Synthetic Parent"];

/** Sparkle-2 sold in 1, 2 or 4 units (the quantity cases). */
const quantityMenu: Menu = {
	...baseMenu,
	tiers: baseMenu.tiers.map((tier) =>
		tier.id === "sparkle-2" ? { ...tier, quantities: [1, 2, 4] } : tier,
	),
};

export const stamp = (atMs: number): string =>
	`${new Date(atMs).toISOString().slice(0, 19)}Z`;
const days = (n: number, hours = 0): number =>
	FIRST_AT + n * DAY + hours * HOUR;

export const deliver = (
	at: number,
	event: RawEvent,
	status = 200,
	outcome = "applied",
	reason?: string,
	school?: string,
): Step => ({
	at,
	event,
	answer: reason ? [status, outcome, reason] : [status, outcome],
	...(school ? { school } : {}),
});
export const applied = (at: number, event: RawEvent) => deliver(at, event);

/** The first payment of a sparkle-2 member, 15 January 18:00 UTC. */
const firstInvoice = (
	id = "in_1",
	over: Partial<Parameters<typeof invoice>[0]> = {},
) =>
	invoice({
		id,
		at: FIRST_AT,
		end: ms(FEB15),
		lines: [tierLine("sparkle-2", { amount: SPARKLE_2 })],
		...over,
	});

/** The first payment, then the link that lets a refund or a dispute find it: the start of most cases. */
const paidAndLinked = (id = "in_1"): Step[] => [
	applied(FIRST_AT, firstInvoice(id)),
	applied(FIRST_AT + 1000, link(id, FIRST_AT + 1000)),
];

/** A refund of sparkle-2's first invoice. */
const refundStep = (
	at: number,
	id: string,
	amount: number,
	total?: number,
	withoutPrevious = false,
) =>
	applied(
		at,
		refundOf({
			id,
			invoiceId: "in_1",
			amount,
			charged: SPARKLE_2,
			total,
			at,
			withoutPrevious,
		}),
	);

/** Stripe's charge for an invoice. */
const charge = (invoiceId: string, gross: number, fee: number, atMs: number) =>
	stripeBalance(`txn_${invoiceId}`, "charge", gross, fee, stamp(atMs));
const FIRST_CHARGE = charge("in_1", SPARKLE_2, 784, FIRST_AT);
const FIRST_INVOICE = stripeInvoice("in_1", SPARKLE_2, JAN15);
const JAN: string[] = [];
const ONLY_JANUARY = { "2026-01": JAN };
const FEES_26 = { in_1: 784 };

/** The opening of the dispute on `in_1`, with Stripe's withdrawal (260.00 and the 15.00 dispute fee). */
const disputeCreated = (id: string): RawEvent =>
	disputeOf({
		type: "charge.dispute.created",
		id,
		invoiceId: "in_1",
		status: "needs_response",
		at: days(2),
		fee: DISPUTE_FEE,
	});

/** The closing of that dispute as lost; it lists the same withdrawal as the opening. */
const disputeLost = (id: string): RawEvent =>
	disputeOf({
		type: "charge.dispute.closed",
		id,
		invoiceId: "in_1",
		status: "lost",
		at: days(12),
		openedAt: days(2),
		fee: DISPUTE_FEE,
	});

export const CASES: Case[] = [
	{
		id: "create",
		title: "subscription create invoice",
		path: "invoice.paid (subscription_create) + invoice_payment.paid",
		fees: FEES_26,
		steps: paidAndLinked(),
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// 260.00 in, Stripe keeps 7.84: 252.16 is Stripe's balance and the net income; two visits granted
				hand: {
					"income:membership:sparkle-2": 26_000,
					fees: 784,
					stripe: 25_216,
					net: 25_216,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [FIRST_CHARGE],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "renewal",
		title: "monthly cycle renewal",
		path: "invoice.paid (subscription_cycle)",
		fees: { in_1: 784, in_2: 784 },
		steps: [
			...paidAndLinked(),
			applied(
				ms(FEB15),
				// the renewal's own period is the cycle that ended; its tier line carries the new one
				invoice({
					id: "in_2",
					at: ms(FEB15),
					reason: "subscription_cycle",
					start: FIRST_AT,
					end: ms(FEB15),
					lines: [
						tierLine("sparkle-2", {
							amount: SPARKLE_2,
							periodStart: ms(FEB15),
							periodEnd: ms(MAR15),
						}),
					],
				}),
			),
			applied(ms(FEB15) + 1000, link("in_2", ms(FEB15) + 1000)),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				monthly: true,
				handMonthly: {
					Jan: { "income:membership:sparkle-2": 26_000, fees: 784 },
					Feb: { "income:membership:sparkle-2": 26_000, fees: 784 },
				},
				// two payments of 260.00 and two fees of 7.84: 520.00 - 15.68 = 504.32
				// credits: 2 in January, 2 more in February, and the 2 unused ones carry over (the cap is 2): 4 available
				hand: {
					"income:membership:sparkle-2": 52_000,
					fees: 1568,
					stripe: 50_432,
					net: 50_432,
					[visits()]: 4,
				},
				stripe: {
					invoices: [FIRST_INVOICE, stripeInvoice("in_2", SPARKLE_2, FEB15)],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						charge("in_2", SPARKLE_2, 784, ms(FEB15)),
					],
				},
				reconcile: { "2026-01": JAN, "2026-02": [] },
			},
		],
	},
	{
		id: "upgrade",
		title: "upgrade invoice: sparkle-2 to sparkle-4 ten days in (proration)",
		path: "invoice.paid (subscription_update, two proration lines)",
		fees: { in_1: 784, in_2: 541 },
		steps: [
			...paidAndLinked(),
			applied(
				days(10),
				// 21 of 31 days left: the unused sparkle-2 is credited 26,000 x 21/31 = 17,613 (rounded) and sparkle-4 charged
				// 52,000 x 21/31 = 35,226; the member pays the difference, 17,613
				invoice({
					id: "in_2",
					at: days(10),
					reason: "subscription_update",
					start: FIRST_AT,
					end: days(10),
					lines: [
						tierLine("sparkle-2", {
							amount: -17_613,
							proration: true,
							periodStart: days(10),
							periodEnd: ms(FEB15),
						}),
						tierLine("sparkle-4", {
							amount: 35_226,
							proration: true,
							periodStart: days(10),
							periodEnd: ms(FEB15),
						}),
					],
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// income: 260.00 for sparkle-2 (never reduced by the credit line: only the 176.13 paid is booked) and 176.13 for
				// sparkle-4; fees 7.84 + 5.41 (17,613 x 2.9% = 511 + 30); cash 436.13 - 13.25 = 422.88
				// credits: 2 visits, and 4 - 2 = 2 more, prorated 21/31 and rounded up = 2: 4 visits, plus sparkle-4's retreat
				hand: {
					"income:membership:sparkle-2": 26_000,
					"income:membership:sparkle-4": 17_613,
					fees: 1325,
					stripe: 42_288,
					net: 42_288,
					[visits()]: 4,
					[visits(FAMILY, "avail", "retreat")]: 1,
				},
				stripe: {
					invoices: [
						FIRST_INVOICE,
						stripeInvoice("in_2", 17_613, stamp(days(10))),
					],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						charge("in_2", 17_613, 541, days(10)),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "quantity-raise",
		title: "quantity raise: two units to four ten days in",
		path: "invoice.paid (subscription_update, quantity proration pair)",
		menu: quantityMenu,
		fees: { in_1: 1538, in_2: 1052 },
		steps: [
			applied(
				FIRST_AT,
				invoice({
					id: "in_1",
					at: FIRST_AT,
					end: ms(FEB15),
					lines: [
						tierLine("sparkle-2", {
							menu: quantityMenu,
							amount: 2 * SPARKLE_2,
							quantity: 2,
						}),
					],
				}),
			),
			applied(
				days(10),
				// 21/31 of the cycle left: credit the two units not used (2 x 26,000 x 21/31 = 35,226), charge four (70,452)
				invoice({
					id: "in_2",
					at: days(10),
					reason: "subscription_update",
					start: FIRST_AT,
					end: days(10),
					lines: [
						tierLine("sparkle-2", {
							menu: quantityMenu,
							amount: -35_226,
							quantity: 2,
							proration: true,
							periodStart: days(10),
							periodEnd: ms(FEB15),
						}),
						tierLine("sparkle-2", {
							menu: quantityMenu,
							amount: 70_452,
							quantity: 4,
							proration: true,
							periodStart: days(10),
							periodEnd: ms(FEB15),
						}),
					],
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// 520.00 for two units, then 352.26 for the raise: 872.26 of sparkle-2; fees 15.38 (52,000 x 2.9% = 1,508 + 30) and
				// 10.52 (35,226 x 2.9% = 1,021.55, plus 30 = 1,051.55, rounded to 1,052); cash 872.26 - 25.90 = 846.36
				// credits: 4 visits for two units, and the raise adds 2 units x 2 visits x 21/31 = 2.71, rounded up to 3: 7
				hand: {
					"income:membership:sparkle-2": 87_226,
					fees: 2590,
					stripe: 84_636,
					net: 84_636,
					[visits()]: 7,
				},
				stripe: {
					invoices: [
						stripeInvoice("in_1", 2 * SPARKLE_2, JAN15),
						stripeInvoice("in_2", 35_226, stamp(days(10))),
					],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						charge("in_1", 2 * SPARKLE_2, 1538, FIRST_AT),
						charge("in_2", 35_226, 1052, days(10)),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "quantity-decrease",
		title: "quantity decrease at renewal: four units to two",
		path: "invoice.paid (subscription_cycle at a lower quantity)",
		menu: quantityMenu,
		fees: { in_1: 3046, in_2: 1538 },
		steps: [
			applied(
				FIRST_AT,
				invoice({
					id: "in_1",
					at: FIRST_AT,
					end: ms(FEB15),
					lines: [
						tierLine("sparkle-2", {
							menu: quantityMenu,
							amount: 4 * SPARKLE_2,
							quantity: 4,
						}),
					],
				}),
			),
			// the member lowers the count to two with no proration: Stripe sends the subscription change, no invoice
			applied(
				days(5),
				subscriptionOf({
					type: "customer.subscription.updated",
					id: "evt_sub_2",
					status: "active",
					tierId: "sparkle-2",
					quantity: 2,
					start: FIRST_AT,
					end: ms(FEB15),
					at: days(5),
					menu: quantityMenu,
				}),
			),
			applied(
				ms(FEB15),
				invoice({
					id: "in_2",
					at: ms(FEB15),
					reason: "subscription_cycle",
					start: FIRST_AT,
					end: ms(FEB15),
					lines: [
						tierLine("sparkle-2", {
							menu: quantityMenu,
							amount: 2 * SPARKLE_2,
							quantity: 2,
							periodStart: ms(FEB15),
							periodEnd: ms(MAR15),
						}),
					],
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// 1,040.00 for four units, then 520.00 for two: 1,560.00; fees 30.46 (104,000 x 2.9% = 3,016 + 30) and 15.38;
				// cash 1,560.00 - 45.84 = 1,514.16
				// credits: 8 visits for four units; the renewal grants 2 units x 2 = 4 and keeps what fits the new cap, 2 x 2 = 4
				hand: {
					"income:membership:sparkle-2": 156_000,
					fees: 4584,
					stripe: 151_416,
					net: 151_416,
					[visits()]: 8,
				},
				stripe: {
					invoices: [
						stripeInvoice("in_1", 4 * SPARKLE_2, JAN15),
						stripeInvoice("in_2", 2 * SPARKLE_2, FEB15),
					],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						charge("in_1", 4 * SPARKLE_2, 3046, FIRST_AT),
						charge("in_2", 2 * SPARKLE_2, 1538, ms(FEB15)),
					],
				},
				monthly: true,
				handMonthly: {
					Jan: { "income:membership:sparkle-2": 104_000, fees: 3046 },
					Feb: { "income:membership:sparkle-2": 52_000, fees: 1538 },
				},
				reconcile: { "2026-01": JAN, "2026-02": [] },
			},
		],
	},
	{
		id: "addon-recurring",
		title: "add-on purchase: glow bought ten days into the cycle",
		path: "invoice.paid (subscription_update, add-on line only)",
		fees: { in_1: 784, in_2: 128 },
		steps: [
			...paidAndLinked(),
			applied(
				days(10),
				// glow is 5,000 a month: 21/31 of it remains, 3,387
				invoice({
					id: "in_2",
					at: days(10),
					reason: "subscription_update",
					start: days(10),
					end: ms(FEB15),
					lines: [
						addonLine("glow", {
							amount: 3387,
							proration: true,
							periodStart: days(10),
							periodEnd: ms(FEB15),
						}),
					],
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// 260.00 + 33.87 income; fees 7.84 + 1.28 (3,387 x 2.9% = 98 + 30); cash 293.87 - 9.12 = 284.75
				// credits: 2 visits, and glow's 1 visit prorated 21/31 and rounded up = 1: 3
				hand: {
					"income:membership:sparkle-2": 26_000,
					"income:addon:glow": 3387,
					fees: 912,
					stripe: 28_475,
					net: 28_475,
					[visits()]: 3,
				},
				stripe: {
					invoices: [
						FIRST_INVOICE,
						stripeInvoice("in_2", 3387, stamp(days(10))),
					],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						charge("in_2", 3387, 128, days(10)),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "create-with-addon",
		title: "one invoice for a tier and a recurring add-on",
		path: "invoice.paid (subscription_create, tier line + add-on line)",
		fees: { in_1: 929 },
		steps: [
			applied(
				FIRST_AT,
				firstInvoice("in_1", {
					lines: [
						tierLine("sparkle-2", { amount: SPARKLE_2 }),
						addonLine("glow", { amount: 5000 }),
					],
				}),
			),
			applied(FIRST_AT + 1000, link("in_1", FIRST_AT + 1000)),
		],
		verdict: "DISCREPANCY",
		discrepancies: ["D6"],
		books: [
			{
				school: SCHOOL,
				// 260.00 for the tier and 50.00 for glow; fee 9.29 (31,000 x 2.9% = 899 + 30); cash 310.00 - 9.29 = 300.71
				// credits: the tier's 2 visits and glow's 1
				hand: {
					"income:membership:sparkle-2": 26_000,
					"income:addon:glow": 5000,
					fees: 929,
					stripe: 30_071,
					net: 30_071,
					[visits()]: 3,
				},
				// DISCREPANCY: D6 one payment, one income account: the whole 310.00 is booked as the tier's
				pinned: {
					"income:membership:sparkle-2": 31_000,
					"income:addon:glow": 0,
				},
				stripe: {
					invoices: [stripeInvoice("in_1", 31_000, JAN15)],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [charge("in_1", 31_000, 929, FIRST_AT)],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "addon-once",
		title: "add-on purchase: a one-time pack, no subscription",
		path: "invoice.paid (manual, no subscription, add-on line only)",
		fees: { in_1: 291 },
		steps: [
			applied(
				FIRST_AT,
				invoice({
					id: "in_1",
					at: FIRST_AT,
					reason: "manual",
					subscription: null,
					lines: [addonLine("pack", { amount: 9000 })],
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// 90.00 in, fee 2.91 (9,000 x 2.9% = 261 + 30): 87.09; one visit
				hand: {
					"income:addon:pack": 9000,
					fees: 291,
					stripe: 8709,
					net: 8709,
					[visits()]: 1,
				},
				stripe: {
					invoices: [stripeInvoice("in_1", 9000, JAN15)],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [charge("in_1", 9000, 291, FIRST_AT)],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "refund-partial",
		title: "partial refund",
		path: "charge.refunded (amount below the charge)",
		fees: FEES_26,
		steps: [...paidAndLinked(), refundStep(days(0, 1), "evt_re_1", 5000)],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// 260.00 - 50.00 refunded - 7.84 fee = 202.16; a partial refund takes no credits back
				hand: {
					"income:membership:sparkle-2": 26_000,
					refunds: 5000,
					fees: 784,
					stripe: 20_216,
					net: 20_216,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [stripeRefund("re_a", 5000, stamp(days(0, 1)), "in_1")],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance("txn_re_a", "refund", -5000, 0, stamp(days(0, 1))),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "refund-two-partials",
		title: "two partial refunds of one payment",
		path: "charge.refunded x2 (running total in the charge)",
		fees: FEES_26,
		steps: [
			...paidAndLinked(),
			refundStep(days(0, 1), "evt_re_1", 5000),
			// the charge now says 80.00 refunded in all: this event is worth 30.00
			refundStep(days(0, 2), "evt_re_2", 3000, 8000),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// 50.00 + 30.00 = 80.00 refunded: 260.00 - 80.00 - 7.84 = 172.16
				hand: {
					"income:membership:sparkle-2": 26_000,
					refunds: 8000,
					fees: 784,
					stripe: 17_216,
					net: 17_216,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [
						stripeRefund("re_a", 5000, stamp(days(0, 1)), "in_1"),
						stripeRefund("re_b", 3000, stamp(days(0, 2)), "in_1"),
					],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance("txn_re_a", "refund", -5000, 0, stamp(days(0, 1))),
						stripeBalance("txn_re_b", "refund", -3000, 0, stamp(days(0, 2))),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "refund-partials-to-full",
		title: "two partial refunds that add up to the whole charge",
		path: "charge.refunded x2 (the second makes the charge fully refunded: credits taken back)",
		fees: FEES_26,
		steps: [
			...paidAndLinked(),
			refundStep(days(0, 1), "evt_re_1", 5000),
			// the charge is now refunded in full: 50.00 + 210.00
			refundStep(days(0, 2), "evt_re_2", 21_000, SPARKLE_2),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// 50.00 + 210.00 = 260.00 handed back; the fee stays; the two visits are taken back by the second refund
				hand: {
					"income:membership:sparkle-2": 26_000,
					refunds: 26_000,
					fees: 784,
					stripe: -784,
					net: -784,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [
						stripeRefund("re_a", 5000, stamp(days(0, 1)), "in_1"),
						stripeRefund("re_b", 21_000, stamp(days(0, 2)), "in_1"),
					],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance("txn_re_a", "refund", -5000, 0, stamp(days(0, 1))),
						stripeBalance("txn_re_b", "refund", -21_000, 0, stamp(days(0, 2))),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "refund-full",
		title: "full refund",
		path: "charge.refunded (amount = charge: credits taken back)",
		fees: FEES_26,
		steps: [...paidAndLinked(), refundStep(days(0, 1), "evt_re_1", SPARKLE_2)],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// everything handed back, the 7.84 fee is not: cash and net are -7.84; the two visits are taken back
				hand: {
					"income:membership:sparkle-2": 26_000,
					refunds: 26_000,
					fees: 784,
					stripe: -784,
					net: -784,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [stripeRefund("re_a", SPARKLE_2, stamp(days(0, 1)), "in_1")],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance(
							"txn_re_a",
							"refund",
							-SPARKLE_2,
							0,
							stamp(days(0, 1)),
						),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "refund-before-link",
		title: "refund before its payment is linked: 409, then the retry",
		path: "charge.refunded -> 409 unmatched_payment -> invoice_payment.paid -> retry",
		fees: FEES_26,
		steps: [
			applied(FIRST_AT, firstInvoice()),
			// Stripe sent the refund first: the handler cannot tell whose it is yet, claims nothing and answers 409
			deliver(
				days(0, 1),
				refundOf({
					id: "evt_re_1",
					invoiceId: "in_1",
					amount: 5000,
					charged: SPARKLE_2,
					at: days(0, 1),
				}),
				409,
				"unmatched_payment",
			),
			applied(days(0, 1) + 1000, link("in_1", days(0, 1) + 1000)),
			// the retry (the same event) now finds its invoice
			refundStep(days(0, 2), "evt_re_1", 5000),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// the same books as one partial refund: 260.00 - 50.00 - 7.84 = 202.16
				hand: {
					"income:membership:sparkle-2": 26_000,
					refunds: 5000,
					fees: 784,
					stripe: 20_216,
					net: 20_216,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [stripeRefund("re_a", 5000, stamp(days(0, 1)), "in_1")],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance("txn_re_a", "refund", -5000, 0, stamp(days(0, 1))),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "link-before-invoice",
		title: "invoice_payment.paid before invoice.paid",
		path: "invoice_payment.paid -> 409 unmatched_invoice -> invoice.paid -> retry -> refund",
		fees: FEES_26,
		steps: [
			deliver(FIRST_AT, link("in_1", FIRST_AT), 409, "unmatched_invoice"),
			applied(FIRST_AT + 1000, firstInvoice()),
			applied(FIRST_AT + 2000, link("in_1", FIRST_AT)),
			refundStep(days(0, 1), "evt_re_1", 5000),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				hand: {
					"income:membership:sparkle-2": 26_000,
					refunds: 5000,
					fees: 784,
					stripe: 20_216,
					net: 20_216,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [stripeRefund("re_a", 5000, stamp(days(0, 1)), "in_1")],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance("txn_re_a", "refund", -5000, 0, stamp(days(0, 1))),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "duplicate-delivery",
		title: "duplicate deliveries of every event type",
		path: "claim: duplicate; invoice already granted; payout idem",
		fees: FEES_26,
		steps: [
			applied(FIRST_AT, firstInvoice()),
			// Stripe's retry: the same event id
			deliver(FIRST_AT + 60_000, firstInvoice(), 200, "duplicate"),
			// the same invoice under a second event id: nothing more is granted or booked
			applied(
				FIRST_AT + 120_000,
				resent(firstInvoice(), "evt_in_1_second_event"),
			),
			applied(FIRST_AT + 1000, link("in_1", FIRST_AT + 1000)),
			deliver(
				FIRST_AT + 61_000,
				link("in_1", FIRST_AT + 1000),
				200,
				"duplicate",
			),
			refundStep(days(0, 1), "evt_re_1", 5000),
			deliver(
				days(0, 1) + 60_000,
				refundOf({
					id: "evt_re_1",
					invoiceId: "in_1",
					amount: 5000,
					charged: SPARKLE_2,
					at: days(0, 1),
				}),
				200,
				"duplicate",
			),
			applied(
				days(2),
				payoutOf({
					id: "evt_po_1",
					payoutId: "po_1",
					amount: 20_216,
					at: days(2),
				}),
			),
			deliver(
				days(2) + 60_000,
				payoutOf({
					id: "evt_po_1",
					payoutId: "po_1",
					amount: 20_216,
					at: days(2),
				}),
				200,
				"duplicate",
			),
			// the same payout under another event id is still one payout
			applied(
				days(2) + 120_000,
				payoutOf({
					id: "evt_po_1_second_event",
					payoutId: "po_1",
					amount: 20_216,
					at: days(2),
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// one payment, one refund, one payout, however many times Stripe said so: 260.00 - 50.00 - 7.84 = 202.16, all paid out
				hand: {
					"income:membership:sparkle-2": 26_000,
					refunds: 5000,
					fees: 784,
					clearing: 20_216,
					net: 20_216,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [stripeRefund("re_a", 5000, stamp(days(0, 1)), "in_1")],
					disputes: [],
					payouts: [stripePayout("po_1", 20_216, stamp(days(2)))],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance("txn_re_a", "refund", -5000, 0, stamp(days(0, 1))),
						stripeBalance("txn_po_1", "payout", -20_216, 0, stamp(days(2))),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "failed-delivery-retry",
		title: "failed delivery, then the retry",
		path: "paymentFee throws -> 500; 409 busy inside the claim window; takeover after it",
		fees: FEES_26,
		steps: [
			// the caller's fee lookup fails: it answers 500, the claim stays open
			{
				at: FIRST_AT,
				event: firstInvoice(),
				answer: [500, "threw"],
				feeFails: true,
			},
			// Stripe retries a minute later: the claim is still fresh
			deliver(FIRST_AT + 60_000, firstInvoice(), 409, "busy"),
			// ... and after the claim's five minutes, the retry takes it over and books
			applied(FIRST_AT + 6 * 60_000, firstInvoice()),
			applied(FIRST_AT + 7 * 60_000, link("in_1", FIRST_AT + 7 * 60_000)),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// the same books as a delivery that never failed
				hand: {
					"income:membership:sparkle-2": 26_000,
					fees: 784,
					stripe: 25_216,
					net: 25_216,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [FIRST_CHARGE],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "dispute-opened",
		title: "dispute opened",
		path: "charge.dispute.created (needs_response, 260.00 withdrawn with a 15.00 fee)",
		fees: FEES_26,
		steps: [
			...paidAndLinked(),
			applied(
				days(2),
				disputeOf({
					type: "charge.dispute.created",
					id: "evt_dp_1",
					invoiceId: "in_1",
					status: "needs_response",
					at: days(2),
					fee: DISPUTE_FEE,
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// Stripe takes the 260.00 out of the balance when the dispute opens and charges its 15.00 dispute fee: the
				// opening is assets:stripe -275.00, disputes +260.00, dispute fees +15.00 (a different account from the 7.84 of
				// the payment). The income stays: 260.00 - 260.00 - 7.84 - 15.00 = -22.84 net, and the cash 252.16 - 275.00 = -22.84.
				// The member keeps the two visits: only a lost dispute takes credits back.
				hand: {
					"income:membership:sparkle-2": 26_000,
					disputes: 26_000,
					fees: 784,
					disputeFees: DISPUTE_FEE,
					stripe: -2284,
					net: -2284,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [
						stripeDispute("dp_1", SPARKLE_2, stamp(days(2)), "needs_response"),
					],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance(
							"txn_dp_1",
							"adjustment",
							-SPARKLE_2,
							DISPUTE_FEE,
							stamp(days(2)),
						),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "dispute-lost",
		title: "dispute lost",
		path: "charge.dispute.created, charge.dispute.closed (lost: credits taken back, the opening stands)",
		fees: FEES_26,
		steps: [
			...paidAndLinked(),
			applied(
				days(2),
				disputeOf({
					type: "charge.dispute.created",
					id: "evt_dp_1",
					invoiceId: "in_1",
					status: "needs_response",
					at: days(2),
					fee: DISPUTE_FEE,
				}),
			),
			// the closing event lists the same withdrawal again: it must not be booked a second time
			applied(
				days(12),
				disputeOf({
					type: "charge.dispute.closed",
					id: "evt_dp_1_closed",
					invoiceId: "in_1",
					status: "lost",
					at: days(12),
					openedAt: days(2),
					fee: DISPUTE_FEE,
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// lost: the opening stands (assets:stripe -275.00, disputes +260.00, dispute fees +15.00) and the close books
				// nothing: the 260.00 stays with the cardholder and the 15.00 with Stripe, the income stays, and the two visits
				// go back. Net 260.00 - 260.00 - 7.84 - 15.00 = -22.84; cash 252.16 - 275.00 = -22.84.
				hand: {
					"income:membership:sparkle-2": 26_000,
					disputes: 26_000,
					fees: 784,
					disputeFees: DISPUTE_FEE,
					stripe: -2284,
					net: -2284,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [stripeDispute("dp_1", SPARKLE_2, stamp(days(2)), "lost")],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance(
							"txn_dp_1",
							"adjustment",
							-SPARKLE_2,
							DISPUTE_FEE,
							stamp(days(2)),
						),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "dispute-won",
		title: "dispute won",
		path: "charge.dispute.created, charge.dispute.closed (won: the amount comes back, the fee does not)",
		fees: FEES_26,
		steps: [
			...paidAndLinked(),
			applied(
				days(2),
				disputeOf({
					type: "charge.dispute.created",
					id: "evt_dp_1",
					invoiceId: "in_1",
					status: "needs_response",
					at: days(2),
					fee: DISPUTE_FEE,
				}),
			),
			applied(
				days(12),
				disputeOf({
					type: "charge.dispute.closed",
					id: "evt_dp_1_closed",
					invoiceId: "in_1",
					status: "won",
					at: days(12),
					openedAt: days(2),
					fee: DISPUTE_FEE,
					reversed: true,
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// won: the opening (assets:stripe -275.00, disputes +260.00, dispute fees +15.00) is followed by the return of
				// the 260.00 (assets:stripe +260.00, disputes -260.00, so disputes net to 0). The 15.00 dispute fee stays an
				// expense: Stripe's recorded won dispute (fixtures/billing/stripe/recorded/delivered/dispute-won) returns 26,000
				// with a fee of 0. Net 260.00 - 7.84 - 15.00 = 237.16; cash 252.16 - 275.00 + 260.00 = 237.16.
				hand: {
					"income:membership:sparkle-2": 26_000,
					fees: 784,
					disputeFees: DISPUTE_FEE,
					stripe: 23_716,
					net: 23_716,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [stripeDispute("dp_1", SPARKLE_2, stamp(days(2)), "won")],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance(
							"txn_dp_1",
							"adjustment",
							-SPARKLE_2,
							DISPUTE_FEE,
							stamp(days(2)),
						),
						stripeBalance(
							"txn_dp_1_won",
							"adjustment",
							SPARKLE_2,
							0,
							stamp(days(12)),
						),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "dispute-redelivered",
		title: "a dispute's events delivered again",
		path: "charge.dispute.created and .closed again: same event id, new event id; the withdrawal is booked once",
		fees: FEES_26,
		steps: [
			...paidAndLinked(),
			applied(days(2), disputeCreated("evt_dp_1")),
			// Stripe's retry: the same event id
			deliver(days(2) + 60_000, disputeCreated("evt_dp_1"), 200, "duplicate"),
			// the same dispute under a second event id: the fee is not booked twice
			applied(days(2) + 120_000, disputeCreated("evt_dp_1_second_event")),
			applied(days(12), disputeLost("evt_dp_1_closed")),
			deliver(
				days(12) + 60_000,
				disputeLost("evt_dp_1_closed"),
				200,
				"duplicate",
			),
			applied(days(12) + 120_000, disputeLost("evt_dp_1_closed_second_event")),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// one dispute, however many times Stripe said so: the same books as a lost dispute delivered once.
				// Net 260.00 - 260.00 - 7.84 - 15.00 = -22.84; cash 252.16 - 275.00 = -22.84; the two visits are taken back once.
				hand: {
					"income:membership:sparkle-2": 26_000,
					disputes: 26_000,
					fees: 784,
					disputeFees: DISPUTE_FEE,
					stripe: -2284,
					net: -2284,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [stripeDispute("dp_1", SPARKLE_2, stamp(days(2)), "lost")],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance(
							"txn_dp_1",
							"adjustment",
							-SPARKLE_2,
							DISPUTE_FEE,
							stamp(days(2)),
						),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "payout-with-fees",
		title: "payout.paid after a payment with a fee",
		path: "payout.paid",
		fees: FEES_26,
		steps: [
			...paidAndLinked(),
			applied(
				days(2),
				payoutOf({
					id: "evt_po_1",
					payoutId: "po_1",
					amount: 25_216,
					at: days(2),
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// Stripe pays out what it holds: 260.00 - 7.84 = 252.16, all of it; the cash moves to the clearing account
				hand: {
					"income:membership:sparkle-2": 26_000,
					fees: 784,
					clearing: 25_216,
					net: 25_216,
					[visits()]: 2,
				},
				// Stripe's payout is created a day before the payout.paid event that announces its arrival
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [],
					payouts: [stripePayout("po_1", 25_216, stamp(days(1)))],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance("txn_po_1", "payout", -25_216, 0, stamp(days(1))),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "payout-several-payments",
		title: "one payout covering three payments of three families",
		path: "payout.paid after three invoice.paid",
		fees: { in_1: 784, in_2: 407, in_3: 784 },
		steps: [
			applied(FIRST_AT, firstInvoice("in_1")),
			applied(
				days(1),
				invoice({
					id: "in_2",
					at: days(1),
					subscription: "sub_2",
					family: OTHER_FAMILY,
					lines: [tierLine("sparkle-1", { amount: SPARKLE_1 })],
				}),
			),
			applied(
				days(2),
				invoice({
					id: "in_3",
					at: days(2),
					subscription: "sub_3",
					family: THIRD_FAMILY,
					lines: [tierLine("sparkle-2", { amount: SPARKLE_2 })],
				}),
			),
			applied(
				days(5),
				payoutOf({
					id: "evt_po_1",
					payoutId: "po_1",
					amount: 63_025,
					at: days(5),
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// 260.00 + 130.00 + 260.00 = 650.00; fees 7.84 + 4.07 + 7.84 = 19.75; paid out 650.00 - 19.75 = 630.25
				hand: {
					"income:membership:sparkle-2": 52_000,
					"income:membership:sparkle-1": 13_000,
					fees: 1975,
					clearing: 63_025,
					net: 63_025,
					[visits(FAMILY)]: 2,
					[visits(OTHER_FAMILY)]: 1,
					[visits(THIRD_FAMILY)]: 2,
				},
				stripe: {
					invoices: [
						FIRST_INVOICE,
						stripeInvoice("in_2", SPARKLE_1, stamp(days(1))),
						stripeInvoice("in_3", SPARKLE_2, stamp(days(2))),
					],
					refunds: [],
					disputes: [],
					payouts: [stripePayout("po_1", 63_025, stamp(days(5)))],
					balanceTransactions: [
						FIRST_CHARGE,
						charge("in_2", SPARKLE_1, 407, days(1)),
						charge("in_3", SPARKLE_2, 784, days(2)),
						stripeBalance("txn_po_1", "payout", -63_025, 0, stamp(days(5))),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "payout-across-months",
		title: "a payout created in January that arrives in February",
		path: "payout.paid is dated by its arrival (the event), Stripe's payout by its creation",
		fees: FEES_26,
		steps: [
			...paidAndLinked(),
			applied(
				ms("2026-02-02T18:00:00Z"),
				payoutOf({
					id: "evt_po_1",
					payoutId: "po_1",
					amount: 25_216,
					at: ms("2026-02-02T18:00:00Z"),
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				monthly: true,
				// the payout is not in the income statement: January has the payment, February nothing
				handMonthly: {
					Jan: { "income:membership:sparkle-2": 26_000, fees: 784 },
					Feb: {},
				},
				// by the end of the books: 260.00 - 7.84 paid out. The monthly balance sheet shows the 252.16 still in Stripe's
				// balance at the end of January and in the clearing account at the end of February
				hand: {
					"income:membership:sparkle-2": 26_000,
					fees: 784,
					clearing: 25_216,
					net: 25_216,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [],
					payouts: [stripePayout("po_1", 25_216, "2026-01-30T18:00:00Z")],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance(
							"txn_po_1",
							"payout",
							-25_216,
							0,
							"2026-01-30T18:00:00Z",
						),
					],
				},
				// Stripe dates the payout 30 January, the log 2 February: reconcile pairs the payout by id and does not call it a shift
				reconcile: { "2026-01": JAN, "2026-02": [] },
			},
		],
	},
	{
		id: "month-boundary",
		title: "month boundary: Denver's 31 January is UTC's 1 February",
		path: "event_time -> the school's local date -> the month's journal",
		fees: { in_1: 784, in_2: 407 },
		steps: [
			// 23:30 UTC on 31 January: 16:30 in Denver, January in both
			applied(
				ms("2026-01-31T23:30:00Z"),
				firstInvoice("in_1", {
					at: ms("2026-01-31T23:30:00Z"),
					end: ms("2026-03-03T23:30:00Z"),
				}),
			),
			applied(
				ms("2026-01-31T23:30:01Z"),
				link("in_1", ms("2026-01-31T23:30:01Z")),
			),
			// 03:00 UTC on 1 February: 20:00 on 31 January in Denver, so January's book although UTC (and Stripe's dashboard) say February
			applied(
				ms("2026-02-01T03:00:00Z"),
				invoice({
					id: "in_2",
					at: ms("2026-02-01T03:00:00Z"),
					subscription: "sub_2",
					family: OTHER_FAMILY,
					lines: [tierLine("sparkle-1", { amount: SPARKLE_1 })],
				}),
			),
			// 08:00 UTC on 1 February: 01:00 in Denver, February in both
			applied(
				ms("2026-02-01T08:00:00Z"),
				refundOf({
					id: "evt_re_1",
					invoiceId: "in_1",
					amount: 5000,
					charged: SPARKLE_2,
					at: ms("2026-02-01T08:00:00Z"),
				}),
			),
			applied(
				ms("2026-02-03T18:00:00Z"),
				payoutOf({
					id: "evt_po_1",
					payoutId: "po_1",
					amount: 32_809,
					at: ms("2026-02-03T18:00:00Z"),
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				monthly: true,
				// in_2 is paid at 03:00 UTC on 1 February, which is 20:00 on 31 January in Denver: January's
				handMonthly: {
					Jan: {
						"income:membership:sparkle-2": 26_000,
						"income:membership:sparkle-1": 13_000,
						fees: 1191,
					},
					Feb: { refunds: 5000 },
				},
				// January: 260.00 + 130.00 income, fees 7.84 + 4.07. February: 50.00 refunded, 328.09 paid out
				// 390.00 - 50.00 - 11.91 = 328.09 in all, and all of it paid out
				hand: {
					"income:membership:sparkle-2": 26_000,
					"income:membership:sparkle-1": 13_000,
					refunds: 5000,
					fees: 1191,
					clearing: 32_809,
					net: 32_809,
					[visits(FAMILY)]: 2,
					[visits(OTHER_FAMILY)]: 1,
				},
				stripe: {
					invoices: [
						stripeInvoice("in_1", SPARKLE_2, "2026-01-31T23:30:00Z"),
						stripeInvoice("in_2", SPARKLE_1, "2026-02-01T03:00:00Z"),
					],
					refunds: [stripeRefund("re_a", 5000, "2026-02-01T08:00:00Z", "in_1")],
					disputes: [],
					payouts: [stripePayout("po_1", 32_809, "2026-02-03T18:00:00Z")],
					balanceTransactions: [
						stripeBalance(
							"txn_in_1",
							"charge",
							SPARKLE_2,
							784,
							"2026-01-31T23:30:00Z",
						),
						stripeBalance(
							"txn_in_2",
							"charge",
							SPARKLE_1,
							407,
							"2026-02-01T03:00:00Z",
						),
						stripeBalance(
							"txn_re_a",
							"refund",
							-5000,
							0,
							"2026-02-01T08:00:00Z",
						),
						stripeBalance(
							"txn_po_1",
							"payout",
							-32_809,
							0,
							"2026-02-03T18:00:00Z",
						),
					],
				},
				reconcile: { "2026-01": JAN, "2026-02": [] },
			},
		],
	},
	{
		id: "yearly",
		title: "yearly invoice",
		path: "invoice.paid (sparkle-2, year interval)",
		fees: { in_1: 7570 },
		steps: [
			applied(
				FIRST_AT,
				invoice({
					id: "in_1",
					at: FIRST_AT,
					end: ms("2027-01-15T18:00:00Z"),
					lines: [tierLine("sparkle-2", { interval: "year", amount: 260_000 })],
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// cash basis, by design (docs/financial-reports.md#revenue-timing): 2,600.00 in January, fee 75.70 (260,000 x 2.9% =
				// 7,540 + 30), 2,524.30 net; a yearly payment grants twelve monthly allowances at once (README), 12 x 2 visits
				hand: {
					"income:membership:sparkle-2": 260_000,
					fees: 7570,
					stripe: 252_430,
					net: 252_430,
					[visits()]: 24,
				},
				stripe: {
					invoices: [stripeInvoice("in_1", 260_000, JAN15)],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [charge("in_1", 260_000, 7570, FIRST_AT)],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "second-school",
		title: "the same family in a second school",
		path: "one endpoint per school: school_mismatch, separate books",
		fees: { in_1: 784, in_b1: 407 },
		steps: [
			applied(FIRST_AT, firstInvoice("in_1")),
			// the family also belongs to a second school, paid on that school's own Stripe account
			deliver(
				FIRST_AT,
				invoice({
					id: "in_b1",
					at: FIRST_AT,
					school: SECOND_SCHOOL,
					subscription: "sub_b1",
					lines: [
						tierLine("sparkle-1", { school: SECOND_SCHOOL, amount: SPARKLE_1 }),
					],
				}),
				200,
				"applied",
				undefined,
				SECOND_SCHOOL,
			),
			// the second school's invoice sent to the first school's endpoint is refused before any claim
			deliver(
				FIRST_AT + 1000,
				invoice({
					id: "in_b1",
					at: FIRST_AT,
					school: SECOND_SCHOOL,
					subscription: "sub_b1",
					lines: [
						tierLine("sparkle-1", { school: SECOND_SCHOOL, amount: SPARKLE_1 }),
					],
				}),
				422,
				"school_mismatch",
			),
			applied(
				days(2),
				payoutOf({
					id: "evt_po_1",
					payoutId: "po_1",
					amount: 25_216,
					at: days(2),
				}),
			),
			deliver(
				days(2),
				payoutOf({
					id: "evt_po_b1",
					payoutId: "po_b1",
					amount: 12_593,
					at: days(2),
				}),
				200,
				"applied",
				undefined,
				SECOND_SCHOOL,
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// only this school's 260.00: 252.16 paid out; the second school's 130.00 is nowhere in it
				hand: {
					"income:membership:sparkle-2": 26_000,
					fees: 784,
					clearing: 25_216,
					net: 25_216,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [],
					payouts: [stripePayout("po_1", 25_216, stamp(days(2)))],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance("txn_po_1", "payout", -25_216, 0, stamp(days(2))),
					],
				},
				reconcile: ONLY_JANUARY,
			},
			{
				school: SECOND_SCHOOL,
				// the second school's own: 130.00 less 4.07 fee = 125.93 paid out; the family has one visit there, two in the first
				hand: {
					"income:membership:sparkle-1": 13_000,
					fees: 407,
					clearing: 12_593,
					net: 12_593,
					[visits()]: 1,
				},
				stripe: {
					invoices: [stripeInvoice("in_b1", SPARKLE_1, JAN15)],
					refunds: [],
					disputes: [],
					payouts: [stripePayout("po_b1", 12_593, stamp(days(2)))],
					balanceTransactions: [
						charge("in_b1", SPARKLE_1, 407, FIRST_AT),
						stripeBalance("txn_po_b1", "payout", -12_593, 0, stamp(days(2))),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "erasure",
		title: "erasure after payments",
		path: "subject.erased recorded after payment.succeeded, payment.refunded, payout.paid",
		fees: FEES_26,
		steps: [
			...paidAndLinked(),
			refundStep(days(0, 1), "evt_re_1", 5000),
			applied(
				days(2),
				payoutOf({
					id: "evt_po_1",
					payoutId: "po_1",
					amount: 20_216,
					at: days(2),
				}),
			),
			{ kind: "erase", at: days(3), family: FAMILY },
		],
		personal: PARENT,
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// the money lines stay: 260.00 - 50.00 - 7.84 = 202.16, paid out; the erasure moves no money
				hand: {
					"income:membership:sparkle-2": 26_000,
					refunds: 5000,
					fees: 784,
					clearing: 20_216,
					net: 20_216,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [stripeRefund("re_a", 5000, stamp(days(0, 1)), "in_1")],
					disputes: [],
					payouts: [stripePayout("po_1", 20_216, stamp(days(2)))],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance("txn_re_a", "refund", -5000, 0, stamp(days(0, 1))),
						stripeBalance("txn_po_1", "payout", -20_216, 0, stamp(days(2))),
					],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "non-usd",
		title: "non-USD invoice and payout",
		path: "invoice.paid and payout.paid in eur: 200 non_usd, a money.skipped marker each, no money line",
		fees: { in_eur: 784 },
		steps: [
			deliver(
				FIRST_AT,
				firstInvoice("in_eur", { currency: "eur" }),
				200,
				"non_usd",
			),
			deliver(
				days(2),
				payoutOf({
					id: "evt_po_eur",
					payoutId: "po_eur",
					amount: 20_000,
					at: days(2),
					currency: "eur",
				}),
				200,
				"non_usd",
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// The books are in dollars: a euro invoice and a euro payout make no money line, so every money number is 0 and
				// the report says nothing of the 260.00 EUR. What the handler does instead is answer 200 `non_usd`, grant the
				// invoice's credits (two visits, as for a USD invoice) and leave one `money.skipped` marker for each of the two
				// lines it left out: reconcile's count of them is 2 in January (the invoice on the 15th, the payout on the 17th).
				hand: { [visits()]: 2 },
				skipped: { "2026-01": { non_usd: 2 } },
				// Stripe's side holds what the books do not: 260.00 EUR charged with a 7.84 fee, 200.00 EUR paid out, which
				// leaves 52.16 EUR in its balance; that is the count of 2 skipped lines explaining the two differences below.
				foreign: { balance: 5216, fees: 784 },
				stripe: {
					invoices: [stripeInvoice("in_eur", SPARKLE_2, JAN15, "eur")],
					refunds: [],
					disputes: [],
					payouts: [
						stripePayout("po_eur", 20_000, stamp(days(2)), "paid", "eur"),
					],
					balanceTransactions: [
						stripeBalance("txn_in_eur", "charge", SPARKLE_2, 784, JAN15, "eur"),
						stripeBalance(
							"txn_po_eur",
							"payout",
							-20_000,
							0,
							stamp(days(2)),
							"eur",
						),
					],
				},
				reconcile: {
					// the euro invoice and payout are in Stripe's lists and not in the dollar books, which the `skipped` count says
					"2026-01": ["missing_in_log invoice in_eur", "not_in_log payout -"],
				},
			},
		],
	},
	{
		id: "fee-unknown",
		title: "payment booked without a fee (the caller passes none)",
		path: "invoice.paid with no paymentFee dependency",
		steps: [
			...paidAndLinked(),
			applied(
				days(2),
				payoutOf({
					id: "evt_po_1",
					payoutId: "po_1",
					amount: 25_216,
					at: days(2),
				}),
			),
		],
		verdict: "DISCREPANCY",
		discrepancies: ["D1"],
		books: [
			{
				school: SCHOOL,
				// Stripe kept 7.84 and paid out the other 252.16: nothing is left in Stripe's balance
				hand: {
					"income:membership:sparkle-2": 26_000,
					fees: 784,
					clearing: 25_216,
					net: 25_216,
					[visits()]: 2,
				},
				// DISCREPANCY: D1 no fee line, so the 7.84 stays in assets:stripe for ever and the net income is 7.84 too high
				pinned: { fees: 0, stripe: 784, net: 26_000 },
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [],
					payouts: [stripePayout("po_1", 25_216, stamp(days(2)))],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance("txn_po_1", "payout", -25_216, 0, stamp(days(2))),
					],
				},
				reconcile: {
					"2026-01": [
						// DISCREPANCY: D1
						"not_in_log fees -",
					],
				},
			},
		],
	},
	{
		id: "refund-no-previous",
		title: "two refunds of an event without previous_attributes",
		path: "charge.refunded (no previous_attributes: books the running total)",
		fees: FEES_26,
		steps: [
			...paidAndLinked(),
			refundStep(days(0, 1), "evt_re_1", 5000, 5000, true),
			refundStep(days(0, 2), "evt_re_2", 3000, 8000, true),
		],
		verdict: "DISCREPANCY",
		discrepancies: ["D2"],
		books: [
			{
				school: SCHOOL,
				// 50.00 and 30.00 were refunded: 80.00
				hand: {
					"income:membership:sparkle-2": 26_000,
					refunds: 8000,
					fees: 784,
					stripe: 17_216,
					net: 17_216,
					[visits()]: 2,
				},
				// DISCREPANCY: D2 the second event is booked at the charge's running total, 80.00, not at its own 30.00
				pinned: { refunds: 13_000, stripe: 12_216, net: 12_216 },
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [
						stripeRefund("re_a", 5000, stamp(days(0, 1)), "in_1"),
						stripeRefund("re_b", 3000, stamp(days(0, 2)), "in_1"),
					],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance("txn_re_a", "refund", -5000, 0, stamp(days(0, 1))),
						stripeBalance("txn_re_b", "refund", -3000, 0, stamp(days(0, 2))),
					],
				},
				reconcile: {
					"2026-01": [
						// DISCREPANCY: D2
						"amount_differs refund re_b",
						"amount_differs net -",
					],
				},
			},
		],
	},
	{
		id: "payout-failed",
		title: "payout.paid, then the payout fails",
		path: "payout.failed (not mapped: 200 ignored)",
		fees: FEES_26,
		steps: [
			...paidAndLinked(),
			applied(
				days(2),
				payoutOf({
					id: "evt_po_1",
					payoutId: "po_1",
					amount: 25_216,
					at: days(2),
				}),
			),
			deliver(
				days(4),
				payoutOf({
					id: "evt_po_1_failed",
					payoutId: "po_1",
					amount: 25_216,
					at: days(4),
					type: "payout.failed",
				}),
				200,
				"ignored",
			),
		],
		verdict: "DISCREPANCY",
		discrepancies: ["D3"],
		books: [
			{
				school: SCHOOL,
				// the bank refused the transfer: Stripe has the 252.16 back in its balance and nothing is in the clearing account
				hand: {
					"income:membership:sparkle-2": 26_000,
					fees: 784,
					stripe: 25_216,
					net: 25_216,
					[visits()]: 2,
				},
				// DISCREPANCY: D3 the failure is not mapped: the 252.16 stays in the clearing account as if it had reached the bank
				pinned: { stripe: 0, clearing: 25_216 },
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [],
					payouts: [stripePayout("po_1", 25_216, stamp(days(2)), "failed")],
					balanceTransactions: [
						FIRST_CHARGE,
						stripeBalance("txn_po_1", "payout", -25_216, 0, stamp(days(2))),
						stripeBalance(
							"txn_po_1_failure",
							"payout_failure",
							25_216,
							0,
							stamp(days(4)),
						),
					],
				},
				reconcile: {
					"2026-01": [
						// DISCREPANCY: D3
						"missing_in_stripe payout po_1",
					],
				},
			},
		],
	},
	{
		id: "refused-invoice",
		title: "a paid invoice the menu does not know",
		path: "invoice.paid -> 422 unmatched_line, claim released, nothing booked",
		fees: FEES_26,
		steps: [
			deliver(
				FIRST_AT,
				invoice({
					id: "in_1",
					at: FIRST_AT,
					lines: [
						{ lookupKey: "b4u_unlisted", amount: SPARKLE_2, interval: "month" },
					],
				}),
				422,
				"refused",
				"unmatched_line",
			),
		],
		verdict: "DISCREPANCY",
		discrepancies: ["D4"],
		books: [
			{
				school: SCHOOL,
				// the family paid 260.00 and Stripe kept 7.84: a human has to fix the menu and re-send the event
				hand: {
					"income:other": 26_000,
					fees: 784,
					stripe: 25_216,
					net: 25_216,
				},
				// DISCREPANCY: D4 refused by design (the answer is the alarm): the books hold nothing until the event is re-sent
				pinned: { "income:other": 0, fees: 0, stripe: 0, net: 0 },
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [FIRST_CHARGE],
				},
				reconcile: {
					"2026-01": [
						// DISCREPANCY: D4 reconcile is what notices it
						"missing_in_log invoice in_1",
						"not_in_log fees -",
						"amount_differs net -",
					],
				},
			},
		],
	},
	{
		id: "foreign-invoice",
		title: "another product's invoice on the same Stripe account",
		path: "invoice.paid without holder metadata: 200 ignored",
		steps: [
			deliver(
				FIRST_AT,
				invoice({
					id: "in_other",
					at: FIRST_AT,
					metadata: {},
					lines: [
						{ lookupKey: "other_product", amount: 5000, interval: "month" },
					],
				}),
				200,
				"ignored",
			),
		],
		verdict: "DISCREPANCY",
		discrepancies: ["D5"],
		books: [
			{
				school: SCHOOL,
				// not the school's money: its books stay empty. Stripe's side: 50.00 charged, fee 1.75 (5,000 x 2.9% = 145, plus
				// 30), 48.25 left in its balance
				hand: {},
				foreign: { balance: 4825, fees: 175 },
				stripe: {
					invoices: [stripeInvoice("in_other", 5000, JAN15)],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [charge("in_other", 5000, 175, FIRST_AT)],
				},
				reconcile: {
					"2026-01": [
						// DISCREPANCY: D5 reconcile cannot tell another product's payment from a missing one
						"missing_in_log invoice in_other",
						"not_in_log fees -",
						"amount_differs net -",
					],
				},
			},
		],
	},
	{
		id: "zero-invoice",
		title: "an invoice that paid nothing (100% discount)",
		path: "invoice.paid with amount_paid 0: credits, no money line",
		fees: { in_1: 0 },
		steps: [applied(FIRST_AT, firstInvoice("in_1", { amountPaid: 0 }))],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// nothing was paid, so nothing is booked; the member still gets the two visits the tier grants
				hand: { [visits()]: 2 },
				stripe: {
					invoices: [stripeInvoice("in_1", 0, JAN15)],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
	{
		id: "subscription-canceled",
		title: "subscription canceled after a payment",
		path: "customer.subscription.deleted",
		fees: FEES_26,
		steps: [
			...paidAndLinked(),
			applied(
				days(10),
				subscriptionOf({
					type: "customer.subscription.deleted",
					id: "evt_sub_end",
					status: "canceled",
					tierId: "sparkle-2",
					start: FIRST_AT,
					end: ms(FEB15),
					at: days(10),
				}),
			),
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// a cancellation moves no money; the visits already granted stay until their own expiry
				hand: {
					"income:membership:sparkle-2": 26_000,
					fees: 784,
					stripe: 25_216,
					net: 25_216,
					[visits()]: 2,
				},
				stripe: {
					invoices: [FIRST_INVOICE],
					refunds: [],
					disputes: [],
					payouts: [],
					balanceTransactions: [FIRST_CHARGE],
				},
				reconcile: ONLY_JANUARY,
			},
		],
	},
];
