/**
 * The matrix's cases made of Stripe's own deliveries: the scrubbed sandbox events in
 * `fixtures/billing/stripe/recorded/delivered`, in the order Stripe sent them, with the 409 retries the handler asks for.
 * The events are real; everything on the other side is written by hand from reading them (the amounts are the files',
 * the fee is the 2.9% + 30 cents Stripe's price list gives for 260.00, and a dispute's balance transaction is the one the
 * recorded dispute carries: -26,000 with a fee of 1,500, and for a win +26,000 with no fee back).
 * The sandbox ran on test clocks, and two scenarios (`yearly-raise`, `tier-and-quantity-change`) carry invoices paid weeks
 * after the event that announces them; those are left out, as the books date a payment by its `paid_at`.
 */

import { deliver, stamp } from "./e2e-cases.js";
import {
	type Case,
	type Step,
	stripeBalance,
	stripeDispute,
	stripeInvoice,
	stripeRefund,
} from "./e2e-matrix.js";
import {
	RECORDED_SCHOOL,
	recorded,
	recordedMenu,
	recordedPriceIds,
} from "./e2e-recorded.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const FEE = 784; // 26,000 x 2.9% = 754 + 30
const GROSS = 26_000;
const DISPUTED = 26_000;
const DISPUTE_FEE = 1500;
const MONTH = { "2026-11": [] as string[] };
const DISPUTE_LINES = ["amount_differs fees -", "amount_differs net -"];

const step = (
	scenario: string,
	number: string,
	status: number,
	outcome: string,
	delay = 0,
): Step => {
	const { event, at } = recorded(scenario, number);
	return deliver(at + delay, event, status, outcome);
};

const familyOf = (scenario: string, invoiceFile: string): string =>
	recorded(scenario, invoiceFile).event.data.object.parent.subscription_details
		.metadata.family_id;

const invoiceId = (scenario: string, invoiceFile: string): string =>
	recorded(scenario, invoiceFile).event.data.object.id;

const paidAtMs = (scenario: string, invoiceFile: string): number =>
	recorded(scenario, invoiceFile).event.data.object.status_transitions.paid_at *
	SECOND;

const base = {
	menu: recordedMenu,
	env: "test" as const,
	priceIds: recordedPriceIds(),
};

/** One recorded scenario's Stripe side: its invoice and the charge for it. */
const paid = (scenario: string, invoiceFile: string) => {
	const id = invoiceId(scenario, invoiceFile);
	const at = paidAtMs(scenario, invoiceFile);
	return {
		id,
		invoice: stripeInvoice(id, GROSS, stamp(at)),
		charge: stripeBalance(`txn_${id}`, "charge", GROSS, FEE, stamp(at)),
	};
};

const fullRefund = (): Case => {
	const scenario = "full-refund";
	const { id, invoice, charge } = paid(scenario, "03");
	const refund = recorded(scenario, "04");
	return {
		id: "recorded-full-refund",
		title:
			"recorded: full refund, the link and the refund arriving before the invoice",
		path: "recorded full-refund: invoice_payment.paid 409, invoice.paid, charge.refunded 409, both retried",
		...base,
		fees: { [id]: FEE },
		steps: [
			step(scenario, "02", 200, "applied"),
			step(scenario, "01", 409, "unmatched_invoice"),
			step(scenario, "03", 200, "applied"),
			step(scenario, "04", 409, "unmatched_payment"),
			step(scenario, "01", 200, "applied", MINUTE),
			step(scenario, "04", 200, "applied", MINUTE),
		],
		verdict: "OK",
		books: [
			{
				school: RECORDED_SCHOOL,
				// 260.00 paid and all of it refunded; Stripe keeps its 7.84; the two visits (the tier is sparkle at 2 units) are taken back
				hand: {
					"income:membership:sparkle": 26_000,
					refunds: 26_000,
					fees: 784,
					stripe: -784,
					net: -784,
				},
				stripe: {
					invoices: [invoice],
					refunds: [
						stripeRefund("re_recorded_full", GROSS, stamp(refund.at), id, {
							charge: refund.event.data.object.id,
							intent: refund.event.data.object.payment_intent,
						}),
					],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						charge,
						stripeBalance(
							"txn_re_recorded_full",
							"refund",
							-GROSS,
							0,
							stamp(refund.at),
						),
					],
				},
				reconcile: MONTH,
			},
		],
	};
};

const partialRefund = (): Case => {
	const scenario = "partial-refund";
	const family = familyOf(scenario, "01");
	const { id, invoice, charge } = paid(scenario, "01");
	const refund = recorded(scenario, "04");
	return {
		id: "recorded-partial-refund",
		title: "recorded: partial refund of 50.00",
		path: "recorded partial-refund: charge.refunded with previous_attributes",
		...base,
		fees: { [id]: FEE },
		steps: [
			step(scenario, "01", 200, "applied"),
			step(scenario, "02", 200, "applied"),
			step(scenario, "03", 200, "applied"),
			step(scenario, "04", 200, "applied"),
		],
		verdict: "OK",
		books: [
			{
				school: RECORDED_SCHOOL,
				// 260.00 - 50.00 - 7.84 = 202.16; the two visits stay
				hand: {
					"income:membership:sparkle": 26_000,
					refunds: 5000,
					fees: 784,
					stripe: 20_216,
					net: 20_216,
					[`avail:family:${family}:visit`]: 2,
				},
				stripe: {
					invoices: [invoice],
					refunds: [
						stripeRefund("re_recorded_partial", 5000, stamp(refund.at), id, {
							charge: refund.event.data.object.id,
							intent: refund.event.data.object.payment_intent,
						}),
					],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						charge,
						stripeBalance(
							"txn_re_recorded_partial",
							"refund",
							-5000,
							0,
							stamp(refund.at),
						),
					],
				},
				reconcile: MONTH,
			},
		],
	};
};

const disputeLost = (): Case => {
	const scenario = "dispute-lost";
	const { id, invoice, charge } = paid(scenario, "02");
	const dispute = recorded(scenario, "04");
	const disputeId: string = dispute.event.data.object.id;
	return {
		id: "recorded-dispute-lost",
		title: "recorded: dispute opened and lost",
		path: "recorded dispute-lost: charge.dispute.created and .closed (lost) before the link",
		...base,
		fees: { [id]: FEE },
		steps: [
			step(scenario, "01", 409, "unmatched_invoice"),
			step(scenario, "02", 200, "applied"),
			step(scenario, "03", 200, "applied"),
			step(scenario, "04", 409, "unmatched_payment"),
			step(scenario, "05", 409, "unmatched_payment"),
			step(scenario, "01", 200, "applied", MINUTE),
			step(scenario, "04", 200, "applied", MINUTE),
			step(scenario, "05", 200, "applied", MINUTE),
		],
		verdict: "KNOWN",
		discrepancies: ["K1"],
		books: [
			{
				school: RECORDED_SCHOOL,
				// the 260.00 went back to the cardholder and Stripe charged its 15.00 dispute fee: 252.16 - 260.00 - 15.00 = -22.84
				hand: {
					"income:membership:sparkle": 26_000,
					disputes: 26_000,
					fees: 2284,
					stripe: -2284,
					net: -2284,
				},
				// DISCREPANCY: K1 the credits are taken back (the real events do it) and no money line is made
				pinned: { disputes: 0, fees: 784, stripe: 25_216, net: 25_216 },
				stripe: {
					invoices: [invoice],
					refunds: [],
					disputes: [
						stripeDispute(disputeId, DISPUTED, stamp(dispute.at), "lost"),
					],
					payouts: [],
					balanceTransactions: [
						charge,
						stripeBalance(
							`txn_${disputeId}`,
							"adjustment",
							-DISPUTED,
							DISPUTE_FEE,
							stamp(dispute.at),
						),
					],
				},
				reconcile: {
					"2026-11": [
						// DISCREPANCY: K1
						`missing_in_log dispute ${disputeId}`,
						`missing_in_log dispute ${disputeId}`,
						...DISPUTE_LINES,
					],
				},
			},
		],
	};
};

const disputeWon = (): Case => {
	const scenario = "dispute-won";
	const family = familyOf(scenario, "02");
	const { id, invoice, charge } = paid(scenario, "02");
	const dispute = recorded(scenario, "01");
	const closed = recorded(scenario, "05");
	const disputeId: string = dispute.event.data.object.id;
	return {
		id: "recorded-dispute-won",
		title: "recorded: dispute opened and won, the fee not returned",
		path: "recorded dispute-won: charge.dispute.created before its invoice, .closed (won)",
		...base,
		fees: { [id]: FEE },
		steps: [
			step(scenario, "01", 409, "unmatched_payment"),
			step(scenario, "02", 200, "applied"),
			step(scenario, "03", 200, "applied"),
			step(scenario, "04", 200, "applied"),
			step(scenario, "05", 200, "applied"),
			step(scenario, "01", 200, "applied", MINUTE),
		],
		verdict: "KNOWN",
		discrepancies: ["K1"],
		books: [
			{
				school: RECORDED_SCHOOL,
				// won: the 260.00 comes back; the 15.00 fee does not (the recorded reversal has fee 0): 252.16 - 15.00 = 237.16
				hand: {
					"income:membership:sparkle": 26_000,
					fees: 2284,
					stripe: 23_716,
					net: 23_716,
					[`avail:family:${family}:visit`]: 2,
				},
				// DISCREPANCY: K1 the 15.00 fee of a dispute that was won is not booked
				pinned: { fees: 784, stripe: 25_216, net: 25_216 },
				stripe: {
					invoices: [invoice],
					refunds: [],
					disputes: [
						stripeDispute(disputeId, DISPUTED, stamp(dispute.at), "won"),
					],
					payouts: [],
					balanceTransactions: [
						charge,
						stripeBalance(
							`txn_${disputeId}`,
							"adjustment",
							-DISPUTED,
							DISPUTE_FEE,
							stamp(dispute.at),
						),
						stripeBalance(
							`txn_${disputeId}_won`,
							"adjustment",
							DISPUTED,
							0,
							stamp(closed.at),
						),
					],
				},
				reconcile: {
					"2026-11": [
						// DISCREPANCY: K1
						`missing_in_log dispute ${disputeId}`,
						`missing_in_log dispute ${disputeId}`,
						...DISPUTE_LINES,
					],
				},
			},
		],
	};
};

export const RECORDED_CASES: Case[] = [
	fullRefund(),
	partialRefund(),
	disputeLost(),
	disputeWon(),
];
