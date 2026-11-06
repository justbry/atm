/**
 * Cases of deliveries in the orders Stripe really allows: it promises no order, so a refund can beat the link to its
 * payment, the link can beat its invoice, a webhook arrives twice, and the handler's 409 is answered by a retry later.
 *
 * Every number is written by hand, from the price list and the handler's documented contract (the table at the top of
 * `src/handler/stripe-webhook.ts`), and none is read from the handler, the log or a report:
 *   - answers   invoice_payment.paid with no indexed invoice: 409 unmatched_invoice; a refund with no indexed payment:
 *               409 unmatched_payment; the same Stripe event id again once done: 200 duplicate.
 *   - hand      what the books must say; the sums are in the comments next to them.
 *   - stripe    Stripe's own records for the same history.
 *
 * The price list (fixtures/billing/grants/menu.json, USD cents): sparkle-2 26,000 a month and 2 visits (a month is 31
 * days here, 15 January to 15 February); Stripe's fee is 2.9% + 30 cents, rounded: 784 on 26,000.
 */
import {
	FEB15,
	HOUR,
	invoice,
	JAN15,
	link,
	MAR15,
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
import { FAMILY, SCHOOL } from "../handler-harness.js";
import type { RawEvent } from "../stripe-events.js";

/** The id of the case the property test shuffles. */
export const OUT_OF_ORDER_CASE_ID = "out-of-order";

const SPARKLE_2 = 26_000;
const FEE = 784;
const FIRST_AT = ms(JAN15);
const RENEWAL_AT = ms(FEB15);
const MINUTE = 60_000;
const SECOND = 1000;

const stamp = (atMs: number): string =>
	`${new Date(atMs).toISOString().slice(0, 19)}Z`;

const deliver = (
	at: number,
	event: RawEvent,
	status = 200,
	outcome = "applied",
	reason?: string,
): Step => ({
	at,
	event,
	answer: reason ? [status, outcome, reason] : [status, outcome],
});

const charge = (invoiceId: string, atMs: number) =>
	stripeBalance(`txn_${invoiceId}`, "charge", SPARKLE_2, FEE, stamp(atMs));

/** The first payment of a sparkle-2 member, 15 January 18:00 UTC. */
const createInvoice = (): RawEvent =>
	invoice({
		id: "in_1",
		at: FIRST_AT,
		end: RENEWAL_AT,
		lines: [tierLine("sparkle-2", { amount: SPARKLE_2 })],
	});

/** The renewal, 15 February 18:00 UTC: its own period is the cycle that ended, its tier line carries the new one. */
const renewalInvoice = (): RawEvent =>
	invoice({
		id: "in_2",
		at: RENEWAL_AT,
		reason: "subscription_cycle",
		start: FIRST_AT,
		end: RENEWAL_AT,
		lines: [
			tierLine("sparkle-2", {
				amount: SPARKLE_2,
				periodStart: RENEWAL_AT,
				periodEnd: ms(MAR15),
			}),
		],
	});

const OUT_OF_ORDER: Case = {
	id: OUT_OF_ORDER_CASE_ID,
	title:
		"renewal story delivered out of order: 409s, redeliveries and the retries",
	path: "invoice_payment.paid -> 409; charge.refunded x2 (reversed) -> 409; invoice.paid; duplicate; retries",
	fees: { in_1: FEE, in_2: FEE },
	steps: (() => {
		const create = createInvoice();
		const renewal = renewalInvoice();
		const createLink = link("in_1", FIRST_AT + SECOND);
		const renewalLink = link("in_2", RENEWAL_AT + SECOND);
		// two partial refunds of the renewal's payment; the charge says 50.00 refunded after the first, 80.00 after the second
		const refundFirst = refundOf({
			id: "evt_re_a",
			invoiceId: "in_2",
			amount: 5000,
			charged: SPARKLE_2,
			total: 5000,
			at: RENEWAL_AT + HOUR,
		});
		const refundSecond = refundOf({
			id: "evt_re_b",
			invoiceId: "in_2",
			amount: 3000,
			charged: SPARKLE_2,
			total: 8000,
			at: RENEWAL_AT + 2 * HOUR,
		});
		const late = RENEWAL_AT + 2 * HOUR;
		return [
			// January in order
			deliver(FIRST_AT, create),
			deliver(FIRST_AT + SECOND, createLink),
			// the renewal's link beats its invoice: the invoice is not indexed, so 409 and nothing is claimed
			deliver(RENEWAL_AT + SECOND, renewalLink, 409, "unmatched_invoice"),
			// the second refund (80.00 refunded in all) and then the first reach the handler before the payment is linked
			deliver(late + MINUTE, refundSecond, 409, "unmatched_payment"),
			deliver(late + 2 * MINUTE, refundFirst, 409, "unmatched_payment"),
			// the renewal's invoice arrives at last, then Stripe sends it again under the same event id
			deliver(late + 3 * MINUTE, renewal),
			deliver(late + 4 * MINUTE, renewal, 200, "duplicate"),
			// the retries, in the order Stripe's backoff happens to send them: the link, the second refund, a duplicate
			// of the link, the first refund, a duplicate of the second refund
			deliver(late + 5 * MINUTE, renewalLink),
			deliver(late + 6 * MINUTE, refundSecond),
			deliver(late + 7 * MINUTE, renewalLink, 200, "duplicate"),
			deliver(late + 8 * MINUTE, refundFirst),
			deliver(late + 9 * MINUTE, refundSecond, 200, "duplicate"),
		];
	})(),
	verdict: "OK",
	books: [
		{
			school: SCHOOL,
			monthly: true,
			handMonthly: {
				Jan: { "income:membership:sparkle-2": SPARKLE_2, fees: FEE },
				// the refunds are February's: their events are dated 19:00 and 20:00 UTC on 15 February whenever they were delivered
				Feb: {
					"income:membership:sparkle-2": SPARKLE_2,
					refunds: 8000,
					fees: FEE,
				},
			},
			// two payments of 260.00 (52,000), two fees of 7.84 (1,568), the refunds 50.00 + 30.00 = 80.00 (8,000) in either order:
			// 520.00 - 80.00 - 15.68 = 424.32, Stripe's balance and the net income. Credits: 2 in January, 2 more at the
			// renewal and the 2 unused ones carry over (the cap is 2): 4 visits, none taken back by a partial refund
			hand: {
				"income:membership:sparkle-2": 52_000,
				refunds: 8000,
				fees: 1568,
				stripe: 42_432,
				net: 42_432,
				[`avail:family:${FAMILY}:visit`]: 4,
			},
			stripe: {
				invoices: [
					stripeInvoice("in_1", SPARKLE_2, JAN15),
					stripeInvoice("in_2", SPARKLE_2, FEB15),
				],
				refunds: [
					stripeRefund("re_a", 5000, stamp(RENEWAL_AT + HOUR), "in_2"),
					stripeRefund("re_b", 3000, stamp(RENEWAL_AT + 2 * HOUR), "in_2"),
				],
				disputes: [],
				payouts: [],
				balanceTransactions: [
					charge("in_1", FIRST_AT),
					charge("in_2", RENEWAL_AT),
					stripeBalance(
						"txn_re_a",
						"refund",
						-5000,
						0,
						stamp(RENEWAL_AT + HOUR),
					),
					stripeBalance(
						"txn_re_b",
						"refund",
						-3000,
						0,
						stamp(RENEWAL_AT + 2 * HOUR),
					),
				],
			},
			reconcile: { "2026-01": [], "2026-02": [] },
		},
	],
	notes: [
		"The story is the in-order one (create, link, renewal, link, two partial refunds); only the order of delivery differs.",
		"Answers by the handler's contract: a link whose invoice is not indexed is 409 unmatched_invoice; a refund whose payment is not linked is 409 unmatched_payment; neither claims the event, so Stripe's retry is a first delivery and answers 200 applied; an event id already done is 200 duplicate.",
		"The refund of 30.00 (charge total 80.00, previous 50.00) is applied before the refund of 50.00 (total 50.00, previous 0): each is worth its total less its previous_attributes, so the two add up to 80.00 in either order.",
		"Income: 26,000 x 2 = 52,000. Fees: 784 x 2 = 1,568 (2.9% of 26,000 = 754, plus 30). Refunds: 5,000 + 3,000 = 8,000. Stripe's balance and net: 52,000 - 8,000 - 1,568 = 42,432.",
		"Months: January 26,000 income and 784 fee; February 26,000 income, 784 fee and 8,000 refunds (the refund events are dated 19:00 and 20:00 UTC on 15 February, Denver time 12:00 and 13:00).",
	],
};

/**
 * A renewal that reaches the handler before the create invoice of the same subscription. The handler does not wait
 * for the create: a holder with no subscription yet takes the first tier invoice it is sent (a known limit, documented in
 * `docs/stripe-findings.md`), so the renewal answers 200 applied, and the create invoice that follows meets the
 * engine's own state check: 422 refused `rejected`, on every retry. The money is right (a refused paid invoice books its
 * payment); the credits of the create invoice are never granted.
 */
const RENEWAL_BEFORE_CREATE: Case = {
	id: "renewal-before-create",
	title:
		"renewal invoice.paid delivered before the create invoice of the same subscription",
	path: "invoice.paid (subscription_cycle) -> applied; invoice.paid (subscription_create) -> 422 rejected, retried",
	fees: { in_1: FEE, in_2: FEE },
	steps: (() => {
		const create = createInvoice();
		const renewal = renewalInvoice();
		const createLink = link("in_1", FIRST_AT + SECOND);
		const renewalLink = link("in_2", RENEWAL_AT + SECOND);
		return [
			deliver(RENEWAL_AT, renewal),
			deliver(RENEWAL_AT + SECOND, renewalLink),
			// the create invoice, a month late: refused, though its money is booked
			deliver(RENEWAL_AT + MINUTE, create, 422, "refused", "rejected"),
			// its link cannot find the invoice (a refused one is not indexed)
			deliver(RENEWAL_AT + 2 * MINUTE, createLink, 409, "unmatched_invoice"),
			// Stripe's retry of the create invoice gets the same refusal
			deliver(RENEWAL_AT + 3 * MINUTE, create, 422, "refused", "rejected"),
			deliver(RENEWAL_AT + 4 * MINUTE, createLink, 409, "unmatched_invoice"),
		];
	})(),
	verdict: "DISCREPANCY",
	discrepancies: ["D7"],
	books: [
		{
			school: SCHOOL,
			// the books of the in-order story: two payments of 260.00 (52,000) and two fees of 7.84 (1,568): 520.00 - 15.68 =
			// 504.32; credits of the in-order story: 2 + 2 + 2 carried over = 4 visits
			hand: {
				"income:membership:sparkle-2": 52_000,
				fees: 1568,
				stripe: 50_432,
				net: 50_432,
				[`avail:family:${FAMILY}:visit`]: 4,
			},
			pinned: {
				// DISCREPANCY: D7. The create invoice grants nothing: only the renewal's 2 visits are in the books
				[`avail:family:${FAMILY}:visit`]: 2,
			},
			stripe: {
				invoices: [
					stripeInvoice("in_1", SPARKLE_2, JAN15),
					stripeInvoice("in_2", SPARKLE_2, FEB15),
				],
				refunds: [],
				disputes: [],
				payouts: [],
				balanceTransactions: [
					charge("in_1", FIRST_AT),
					charge("in_2", RENEWAL_AT),
				],
			},
			reconcile: { "2026-01": [], "2026-02": [] },
		},
	],
	notes: [
		"Money: 26,000 x 2 = 52,000 income, 784 x 2 = 1,568 fees, 52,000 - 1,568 = 50,432 in Stripe's balance. The refused create invoice still books its payment, so reconcile is clean.",
		"Credits by hand: January's 2 visits, the renewal's refill to 2 and the 2 carried over (cap 2) = 4, as in the in-order story. The handler gives 2: the renewal became the holder's first invoice and the create is refused for good.",
	],
};

export const CASES: Case[] = [OUT_OF_ORDER, RENEWAL_BEFORE_CREATE];
