/**
 * The `codes` bundle: a member discount code, a dollar gift certificate bought and then used by someone else.
 *
 * Every number is written by hand from the price list (fixtures/billing/grants/menu.json, USD cents: sparkle-2 26,000 a
 * month and 2 visits, the gift-dollars add-on 5,000 once, no credits) and Stripe's
 * documented shapes; none is read from the handler, the log or a report. Stripe's fee is 2.9% + 30 cents, rounded.
 *
 * Rules the story rests on (src/billing/grants.ts, money.ts, codes.ts): an invoice's line `amount` is the GROSS line and
 * a discount never changes what an invoice grants; the books take what was paid (`amount_paid`), so income is the net
 * of the discount; a dollar gift grants no credits (it is a coupon of Stripe's, applied to the first invoice it meets).
 */
import type { Menu } from "../../src/billing/types.js";
import {
	addonLine,
	invoice,
	link,
	ms,
	refundOf,
	tierLine,
} from "../e2e-events.js";
import {
	type Case,
	type Step,
	stripeBalance,
	stripeInvoice,
	stripeRefund,
} from "../e2e-matrix.js";
import { menu as baseMenu, FAMILY, SCHOOL } from "../handler-harness.js";
import type { RawEvent } from "../stripe-events.js";

const SPARKLE_2 = 26_000;
const GIFT_DOLLARS = 5000;
/** WELCOME15: 15% off the first sparkle-2 invoice. 26,000 x 15% = 3,900. */
const WELCOME_OFF = 3900;
const GIFT_BUYER = "fam_b2";
const GIFT_RECIPIENT = "fam_c3";

const menu: Menu = {
	...baseMenu,
	codes: [
		{
			id: "welcome",
			kind: "member",
			code: "WELCOME15",
			percentOff: 15,
			tierIds: ["sparkle-2"],
		},
	],
};

const MEMBER_PAID = ms("2026-01-15T18:00:00Z");
const GIFT_BOUGHT = ms("2026-01-20T16:00:00Z");
const GIFT_USED = ms("2026-02-01T17:00:00Z");
const REFUND_AT = ms("2026-02-02T10:00:00Z");
const MINUTE = 60_000;
const SECOND = 1000;

const stamp = (atMs: number): string =>
	`${new Date(atMs).toISOString().slice(0, 19)}Z`;

/** Stripe's charge for an invoice: the net of any discount is what it took. */
const charge = (invoiceId: string, paid: number, fee: number, atMs: number) =>
	stripeBalance(`txn_${invoiceId}`, "charge", paid, fee, stamp(atMs));

/** An invoice event with the discount Stripe shows: lines stay gross, the discount sits beside, `amount_paid` is net. */
const discounted = (event: RawEvent, off: number): RawEvent => {
	const object = event.data.object;
	const [line] = object.lines.data;
	line.discount_amounts = [{ amount: off, discount: "di_synth" }];
	object.total_discount_amounts = [{ amount: off, discount: "di_synth" }];
	return event;
};

/** The sparkle-2 member's first payment: 260.00 list, WELCOME15 takes 39.00 off, 221.00 is charged. */
const memberInvoice = (): RawEvent =>
	discounted(
		invoice({
			id: "in_1",
			at: MEMBER_PAID,
			end: ms("2026-02-15T18:00:00Z"),
			lines: [tierLine("sparkle-2", { menu, amount: SPARKLE_2 })],
			amountPaid: SPARKLE_2 - WELCOME_OFF,
		}),
		WELCOME_OFF,
	);

/** Someone buys a 50.00 dollar gift certificate: a one-time invoice with no subscription. */
const giftInvoice = (): RawEvent =>
	invoice({
		id: "in_2",
		at: GIFT_BOUGHT,
		reason: "manual",
		subscription: null,
		family: GIFT_BUYER,
		lines: [addonLine("gift-dollars", { menu, amount: GIFT_DOLLARS })],
	});

/** The recipient starts sparkle-2 (260.00) with the gift's promotion code: a 50.00 coupon, 210.00 charged. */
const recipientInvoice = (): RawEvent =>
	discounted(
		invoice({
			id: "in_3",
			at: GIFT_USED,
			subscription: "sub_3",
			family: GIFT_RECIPIENT,
			end: ms("2026-03-01T17:00:00Z"),
			lines: [tierLine("sparkle-2", { menu, amount: SPARKLE_2 })],
			amountPaid: SPARKLE_2 - GIFT_DOLLARS,
		}),
		GIFT_DOLLARS,
	);

const refundEvent = (): RawEvent =>
	refundOf({
		id: "evt_re_3",
		invoiceId: "in_3",
		amount: 2000,
		// the charge is what was paid, 210.00
		charged: SPARKLE_2 - GIFT_DOLLARS,
		at: REFUND_AT,
	});

const steps: Step[] = [
	{
		at: MEMBER_PAID,
		event: memberInvoice(),
		answer: [200, "applied"],
	},
	{
		at: MEMBER_PAID + SECOND,
		event: link("in_1", MEMBER_PAID + SECOND),
		answer: [200, "applied"],
	},
	// Stripe's retry: the same event id
	{
		at: MEMBER_PAID + MINUTE,
		event: memberInvoice(),
		answer: [200, "duplicate"],
	},
	{ at: GIFT_BOUGHT, event: giftInvoice(), answer: [200, "applied"] },
	{
		at: GIFT_BOUGHT + SECOND,
		event: link("in_2", GIFT_BOUGHT + SECOND),
		answer: [200, "applied"],
	},
	{ at: GIFT_USED, event: recipientInvoice(), answer: [200, "applied"] },
	// the refund of part of the 80.00 arrives before the payment is linked: Stripe is told to retry
	{
		at: REFUND_AT,
		event: refundEvent(),
		answer: [409, "unmatched_payment"],
	},
	{
		at: REFUND_AT + 5 * MINUTE,
		event: link("in_3", REFUND_AT + 5 * MINUTE),
		answer: [200, "applied"],
	},
	{
		at: REFUND_AT + 10 * MINUTE,
		event: refundEvent(),
		answer: [200, "applied"],
	},
];

const visits = (family: string) => `avail:family:${family}:visit`;

export const CASES: Case[] = [
	{
		id: "codes",
		title:
			"a member discount code, and a dollar gift certificate bought and used",
		path: "invoice.paid (discounted, amount_paid below the lines) + invoice.paid (gift add-on) + invoice.paid (gift coupon) + charge.refunded",
		menu,
		fees: { in_1: 671, in_2: 175, in_3: 639 },
		steps,
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				monthly: true,
				handMonthly: {
					// January: 221.00 + 50.00 income; fees 6.71 + 1.75
					Jan: {
						"income:membership:sparkle-2": 22_100,
						"income:addon:gift-dollars": 5000,
						fees: 846,
					},
					// February: 210.00 of sparkle-2 income, 20.00 refunded, fee 6.39
					Feb: {
						"income:membership:sparkle-2": 21_000,
						refunds: 2000,
						fees: 639,
					},
				},
				// in_1: list 260.00, WELCOME15 takes 15% = 39.00, so 221.00 is paid and booked; fee 221.00 x 2.9% = 6.409 -> 6.41, plus 0.30 = 6.71
				// in_2: the gift certificate, 50.00; fee 50.00 x 2.9% = 1.45 + 0.30 = 1.75; it grants no credits
				// in_3: sparkle-2 list 260.00, the gift's 50.00 coupon is taken off, 210.00 paid; fee 210.00 x 2.9% = 6.09 + 0.30 = 6.39;
				//       20.00 of it refunded (a partial refund takes no credits back)
				// sparkle-2 income 221.00 + 210.00 = 431.00, gift income 50.00: 481.00; fees 6.71 + 1.75 + 6.39 = 14.85; refunds 20.00
				// Stripe's balance and the net income: 481.00 - 20.00 - 14.85 = 446.15
				// credits: a discount never changes a grant, so each sparkle-2 payer gets 2 visits; the gift gives none
				hand: {
					"income:membership:sparkle-2": 43_100,
					"income:addon:gift-dollars": 5000,
					refunds: 2000,
					fees: 1485,
					stripe: 44_615,
					net: 44_615,
					[visits(FAMILY)]: 2,
					[visits(GIFT_RECIPIENT)]: 2,
				},
				stripe: {
					invoices: [
						stripeInvoice("in_1", SPARKLE_2 - WELCOME_OFF, stamp(MEMBER_PAID)),
						stripeInvoice("in_2", GIFT_DOLLARS, stamp(GIFT_BOUGHT)),
						stripeInvoice("in_3", SPARKLE_2 - GIFT_DOLLARS, stamp(GIFT_USED)),
					],
					refunds: [stripeRefund("re_a", 2000, stamp(REFUND_AT), "in_3")],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						charge("in_1", SPARKLE_2 - WELCOME_OFF, 671, MEMBER_PAID),
						charge("in_2", GIFT_DOLLARS, 175, GIFT_BOUGHT),
						charge("in_3", SPARKLE_2 - GIFT_DOLLARS, 639, GIFT_USED),
						stripeBalance("txn_re_a", "refund", -2000, 0, stamp(REFUND_AT)),
					],
				},
				reconcile: { "2026-01": [], "2026-02": [] },
			},
		],
		notes: [
			"A discount never changes what an invoice grants: the lines are gross, the books take amount_paid.",
			"A dollar gift certificate books its price as income when sold and grants no credits; the coupon it makes lowers a later invoice's amount_paid, which is what that invoice books.",
			"A refund that arrives before its payment is linked answers 409 and is applied on the retry.",
		],
	},
];
