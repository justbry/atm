/**
 * The money lines a Stripe event leaves in the books: a paid invoice is a `payment.succeeded` (gross, the Stripe fee and
 * the net that reaches `assets:stripe`), a refund is a `payment.refunded` and a payout is a `payout.paid`. The postings
 * and their signs are `moneyPostings` in `../ledger/postings.ts`; this only says which event to make from a fact.
 * USD only, as the postings are: a fact in another currency makes no money line, but it does make a `money.skipped` event
 * (no postings; a count), so that the skip is in the log and not only in the absence of a line. The decision (keep the
 * credits, answer 200 `non_usd`) is in `docs/financial-reports.md`, "Non-USD".
 *
 * Pure. Each event's idem is the Stripe object's id (`stripe:in_...`, `stripe:evt_...`, `stripe:po_...`), so the same
 * fact decided twice makes the same event, which the outbox's (school, idem) key drops.
 */
import { ledgerEvent } from "../ledger/postings.js";
import type {
	AtmEvent,
	BillingInvoice,
	BillingRefund,
	GrantLabels,
	StripePayout,
} from "../types.js";

const USD = "usd";
const CENTS_PER_DOLLAR = 100;
const PAYOUT_KEY = "stripe:payouts";

type Booker = {
	school: string;
	tz: string;
	/** The ULID of the stored input event, which is every decision event's `cause`. */
	cause: string;
};

/**
 * The marker a skipped money line leaves: `money.skipped`, with no postings. Its idem is the Stripe object's id with
 * `:non_usd`, so a re-send under another event id leaves one marker, as it leaves one money line.
 */
const skippedNonUsd = ({
	kind,
	id,
	amount,
	currency,
	at,
	key,
	labels,
	booker,
}: {
	kind: "invoice" | "refund" | "payout";
	id: string;
	amount: number;
	currency: string;
	at: number;
	key: string;
	labels: Record<string, string>;
	booker: Booker;
}): AtmEvent =>
	ledgerEvent({
		type: "money.skipped",
		school: booker.school,
		tz: booker.tz,
		eventTime: at,
		key,
		idem: `stripe:${id}:non_usd`,
		cause: booker.cause,
		labels,
		text: `${kind} ${id} ${amount} ${currency} not booked: not USD`,
		payload: { id, kind, reason: "non_usd", currency, amount },
	});

/** Why a fee cannot be booked, or null when it can: a whole number of cents, from 0 to what the invoice paid. */
export const feeProblem = (
	fee: number | undefined,
	amountPaid: number,
): string | null =>
	fee === undefined || (Number.isInteger(fee) && fee >= 0 && fee <= amountPaid)
		? null
		: `fee must be a whole number of cents from 0 to the ${amountPaid} the invoice paid, got ${String(fee)}`;

/**
 * Which income account a payment goes to, from the lines the menu named: the tier's (`membership:<tier>`), else the first
 * add-on's (`addon:<add-on>`), else `other`. An invoice that pays for both books all of it under the tier. The tier is
 * the one the invoice pays for: a line of its own, else the line that charges (an upgrade's invoice also lists the credit
 * for the tier it leaves, which is no income of that tier).
 */
const incomeKindOf = (invoice: BillingInvoice): string => {
	const tiers = invoice.lines.filter(
		(line) => line.kind === "tier" && line.tierId,
	);
	const tier =
		tiers.find((line) => !line.proration) ??
		tiers.find((line) => line.amount > 0) ??
		tiers[0];
	if (tier?.tierId) return `membership:${tier.tierId}`;
	const addon = invoice.lines.find(
		(line) => line.kind === "addon" && line.addonId,
	);
	return addon?.addonId ? `addon:${addon.addonId}` : "other";
};

/**
 * A paid invoice: `payment.succeeded` for what it paid, with `fee` taken out of the cash and booked as an expense. No
 * event for an invoice that paid nothing (a free trial, a fully credited invoice); one that paid in another currency makes
 * a `money.skipped` and no payment.
 */
export const paymentEvents = ({
	invoice,
	fee,
	labels,
	booker,
	holder,
}: {
	invoice: BillingInvoice;
	fee: number | undefined;
	labels: GrantLabels;
	booker: Booker;
	holder: { customerId: string };
}): AtmEvent[] => {
	if (invoice.amountPaid <= 0) return [];
	if (invoice.currency !== USD)
		return [
			skippedNonUsd({
				kind: "invoice",
				id: invoice.id,
				amount: invoice.amountPaid,
				currency: invoice.currency,
				at: invoice.paidAt,
				key: holder.customerId,
				labels,
				booker,
			}),
		];
	const taken = fee ?? 0;
	const dollars = invoice.amountPaid / CENTS_PER_DOLLAR;
	return [
		ledgerEvent({
			type: "payment.succeeded",
			school: booker.school,
			tz: booker.tz,
			eventTime: invoice.paidAt,
			key: holder.customerId,
			idem: `stripe:${invoice.id}`,
			cause: booker.cause,
			labels,
			amount: invoice.amountPaid,
			fee: taken,
			incomeKind: incomeKindOf(invoice),
			text: `payment ${dollars} USD for invoice ${invoice.id}`,
			payload: {
				id: invoice.id,
				amount_paid: invoice.amountPaid,
				fee: taken,
				// false: the caller gave no fee, so the books hold the gross amount, which is not the same as a fee of 0
				fee_known: fee !== undefined,
				currency: invoice.currency,
				customer: invoice.customerId,
			},
		}),
	];
};

/**
 * A refund in another currency, which the books do not take: its marker, or nothing for a refund that moved no money or
 * is in USD. Asked for a refund of a payment the books do not hold too (a non-USD invoice was never booked, so its refund
 * is not a `payment.refunded` either), which is why `refundEvents` is not the only caller.
 */
export const skippedRefundEvents = ({
	refund,
	labels,
	booker,
	holder,
}: {
	refund: BillingRefund;
	labels: GrantLabels;
	booker: Booker;
	holder: { customerId: string };
}): AtmEvent[] => {
	const refunded = refund.amount - (refund.previousAmount ?? 0);
	if (refunded <= 0 || (refund.currency ?? USD) === USD) return [];
	return [
		skippedNonUsd({
			kind: "refund",
			id: refund.id,
			amount: refunded,
			currency: refund.currency ?? USD,
			at: refund.at,
			key: holder.customerId,
			labels,
			booker,
		}),
	];
};

/**
 * A refund: `payment.refunded` for what this event refunded. A `charge.refunded` carries the charge's total refunded so
 * far, so the amount is that total less what it was before the event (`previousAmount`). Stripe keeps its fee on a
 * refund, so nothing is booked back from `expenses:billing:stripe-fees`.
 */
export const refundEvents = ({
	refund,
	labels,
	booker,
	holder,
}: {
	refund: BillingRefund;
	labels: GrantLabels;
	booker: Booker;
	holder: { customerId: string };
}): AtmEvent[] => {
	const refunded = refund.amount - (refund.previousAmount ?? 0);
	if (refunded <= 0) return [];
	if ((refund.currency ?? USD) !== USD)
		return skippedRefundEvents({ refund, labels, booker, holder });
	return [
		ledgerEvent({
			type: "payment.refunded",
			school: booker.school,
			tz: booker.tz,
			eventTime: refund.at,
			key: holder.customerId,
			idem: `stripe:${refund.id}`,
			cause: booker.cause,
			labels,
			amount: refunded,
			text: `refunded ${refunded / CENTS_PER_DOLLAR} USD of charge ${refund.chargeId}`,
			payload: {
				id: refund.id,
				amount: refunded,
				currency: USD,
				// What ties the event to Stripe's refund list: its refunds name the charge and the payment intent, never the
				// event. `reconcile` pairs by these and the amount; `amount_refunded` is the total the amount was taken from.
				charge: refund.chargeId,
				...(refund.paymentIntentId
					? { payment_intent: refund.paymentIntentId }
					: {}),
				...(refund.invoiceId ? { invoice: refund.invoiceId } : {}),
				amount_refunded: refund.amount,
			},
		}),
	];
};

/** A payout: `payout.paid` moves the cash from `assets:stripe` to `assets:clearing:stripe-payouts`. Another currency makes a `money.skipped` and no payout line. */
export const payoutEvents = ({
	payout,
	booker,
}: {
	payout: StripePayout;
	booker: Booker;
}): AtmEvent[] =>
	payout.currency === USD
		? [
				ledgerEvent({
					type: "payout.paid",
					school: booker.school,
					tz: booker.tz,
					eventTime: payout.at,
					key: PAYOUT_KEY,
					idem: `stripe:${payout.id}`,
					cause: booker.cause,
					labels: { mapping: payout.source.mapping },
					amount: payout.amount,
					text: `payout ${payout.amount / CENTS_PER_DOLLAR} USD`,
					payload: {
						id: payout.id,
						amount: payout.amount,
						currency: payout.currency,
					},
				}),
			]
		: [
				skippedNonUsd({
					kind: "payout",
					id: payout.id,
					amount: payout.amount,
					currency: payout.currency,
					at: payout.at,
					key: PAYOUT_KEY,
					labels: { mapping: payout.source.mapping },
					booker,
				}),
			];
