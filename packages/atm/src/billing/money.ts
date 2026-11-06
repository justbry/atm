/**
 * The money lines a Stripe event leaves in the books: a paid invoice is a `payment.succeeded` (gross, the Stripe fee and
 * the net that reaches `assets:stripe`), and so is a paid booking's one-time payment (`bookingPaymentEvents`, income
 * `income:billing:booking`, no invoice), a refund is a `payment.refunded`, a payout is a `payout.paid`, and a dispute that
 * moved money is a `payment.disputed` (the amount withdrawn and Stripe's dispute fee) and, when it closes, a `dispute.closed`. The postings
 * and their signs are `moneyPostings` in `../ledger/postings.ts`; this only says which event to make from a fact.
 * USD only, as the postings are: a fact in another currency makes no money line, but it does make a `money.skipped` event
 * (no postings; a count), so that the skip is in the log and not only in the absence of a line. The decision (keep the
 * credits, answer 200 `non_usd`) is in `docs/financial-reports.md`, "Non-USD".
 *
 * Pure. Each event's idem is the Stripe object's id (`stripe:in_...`, `stripe:evt_...`, `stripe:po_...`), so the same
 * fact decided twice makes the same event, which the outbox's (school, idem) key drops. A booking's payment is keyed by its
 * payment intent (`stripe:pi_...`).
 */
import { ledgerEvent } from "../ledger/postings.js";
import type {
	AtmEvent,
	BillingDispute,
	BillingInvoice,
	BillingRefund,
	GrantLabels,
	StripePayout,
} from "../types.js";

const USD = "usd";
/** The one currency the books take; the handler asks it of a `payout.failed` to know whether a payout line can exist. */
export const USD_CURRENCY = USD;
const CENTS_PER_DOLLAR = 100;
const PAYOUT_KEY = "stripe:payouts";
/** The income account tail of a paid booking: `income:billing:booking`. */
const BOOKING_INCOME_KIND = "booking";

/** The labels a decision event carries: the menu, policy and mapping versions, and a booking's id on its own events. */
type Labels = Record<string, string>;

export type Booker = {
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
	kind: "invoice" | "booking" | "refund" | "payout" | "dispute";
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

/** Who books the money lines: the holder's school, in the menu's time zone, caused by the stored input event. */
export const bookerOf = (
	input: { menu: { timeZone: string }; eventId: string },
	holder: { orgId: string },
): Booker => ({
	school: holder.orgId,
	tz: input.menu.timeZone,
	cause: input.eventId,
});

/** Why a fee cannot be booked, or null when it can: a whole number of cents, from 0 to what the invoice (or booking) paid. */
export const feeProblem = (
	fee: number | undefined,
	amountPaid: number,
	payer: "invoice" | "booking" = "invoice",
): string | null =>
	fee === undefined || (Number.isInteger(fee) && fee >= 0 && fee <= amountPaid)
		? null
		: `fee must be a whole number of cents from 0 to the ${amountPaid} the ${payer} paid, got ${String(fee)}`;

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

/** A payment of cents in USD with the fee taken out of the cash: the one `payment.succeeded` shape, whatever paid. */
const paymentSucceeded = ({
	id,
	amount,
	fee,
	at,
	incomeKind,
	text,
	payload,
	labels,
	booker,
	holder,
}: {
	id: string;
	amount: number;
	fee: number | undefined;
	at: number;
	incomeKind: string;
	text: string;
	/** What follows `amount_paid`, `fee` and `fee_known` in the payload. */
	payload: (taken: number) => Record<string, unknown>;
	labels: Labels;
	booker: Booker;
	holder: { customerId: string };
}): AtmEvent => {
	const taken = fee ?? 0;
	return ledgerEvent({
		type: "payment.succeeded",
		school: booker.school,
		tz: booker.tz,
		eventTime: at,
		key: holder.customerId,
		idem: `stripe:${id}`,
		cause: booker.cause,
		labels,
		amount,
		fee: taken,
		incomeKind,
		text,
		payload: payload(taken),
	});
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
	labels: Labels;
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
	const dollars = invoice.amountPaid / CENTS_PER_DOLLAR;
	return [
		paymentSucceeded({
			id: invoice.id,
			amount: invoice.amountPaid,
			fee,
			at: invoice.paidAt,
			incomeKind: incomeKindOf(invoice),
			text: `payment ${dollars} USD for invoice ${invoice.id}`,
			payload: (taken) => ({
				id: invoice.id,
				amount_paid: invoice.amountPaid,
				fee: taken,
				// false: the caller gave no fee, so the books hold the gross amount, which is not the same as a fee of 0
				fee_known: fee !== undefined,
				currency: invoice.currency,
				customer: invoice.customerId,
			}),
			labels,
			booker,
			holder,
		}),
	];
};

/** A booking's one-time payment, as its paid Checkout Session says it (no invoice). */
export type BookingPayment = {
	bookingId: string;
	sessionId: string;
	/** The payment intent (`pi_...`); null only for a session that names none, which then stands for the payment by its own id. */
	paymentIntentId: string | null;
	/** What the session collected (`amount_total`), minor units: the gross. */
	amount: number;
	currency: string;
	at: number;
};

/**
 * A paid booking: `payment.succeeded` for what the session collected, to `income:billing:booking`, with `fee` taken out of
 * the cash as for an invoice. Keyed by the payment intent (`stripe:pi_...`), the id `reconcile` pairs with Stripe's
 * payment intents; the payload also names the booking and the session. One in another currency makes a `money.skipped`
 * (kind `booking`) and no payment. The event's `customer` is the holder's id in atm (the session names no Stripe customer).
 */
export const bookingPaymentEvents = ({
	payment,
	fee,
	labels,
	booker,
	holder,
}: {
	payment: BookingPayment;
	fee: number | undefined;
	labels: Labels;
	booker: Booker;
	holder: { customerId: string };
}): AtmEvent[] => {
	const id = payment.paymentIntentId ?? payment.sessionId;
	if (payment.amount <= 0) return [];
	if (payment.currency !== USD)
		return [
			skippedNonUsd({
				kind: "booking",
				id,
				amount: payment.amount,
				currency: payment.currency,
				at: payment.at,
				key: holder.customerId,
				labels,
				booker,
			}),
		];
	return [
		paymentSucceeded({
			id,
			amount: payment.amount,
			fee,
			at: payment.at,
			incomeKind: BOOKING_INCOME_KIND,
			text: `payment ${payment.amount / CENTS_PER_DOLLAR} USD for booking ${payment.bookingId}`,
			payload: (taken) => ({
				id,
				amount_paid: payment.amount,
				fee: taken,
				fee_known: fee !== undefined,
				currency: payment.currency,
				customer: holder.customerId,
				booking: payment.bookingId,
				session: payment.sessionId,
				...(payment.paymentIntentId
					? { payment_intent: payment.paymentIntentId }
					: {}),
			}),
			labels,
			booker,
			holder,
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
	labels: Labels;
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
	bookingId,
}: {
	refund: BillingRefund;
	labels: Labels;
	booker: Booker;
	holder: { customerId: string };
	/** The booking whose payment this refunds, named in the payload (no invoice does). */
	bookingId?: string;
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
				...(bookingId ? { booking: bookingId } : {}),
				amount_refunded: refund.amount,
			},
		}),
	];
};

/** The Stripe event that says a payout failed after it was paid out. */
export const PAYOUT_FAILED_TYPE = "payout.failed";

/** The idem of a payout's line, and of its reversal when it failed: one each, whatever event ids deliver them. */
export const payoutIdem = (payoutId: string, failed = false): string =>
	failed ? `stripe:${payoutId}:failed` : `stripe:${payoutId}`;

/**
 * A payout: `payout.paid` moves the cash from `assets:stripe` to `assets:clearing:stripe-payouts`. A payout that then
 * failed (`failed`, from `payout.failed`) is the same `payout.paid` the other way round, under its own idem and dated by
 * the failure: the cash is back in the Stripe balance, and nothing else moves (the fee was never the payout's). Another
 * currency makes a `money.skipped` and no payout line, for the payout and for its failure alike (one marker: its idem is
 * the payout's).
 */
export const payoutEvents = ({
	payout,
	booker,
	failed = false,
}: {
	payout: StripePayout;
	booker: Booker;
	failed?: boolean;
}): AtmEvent[] =>
	payout.currency === USD
		? [
				ledgerEvent({
					type: "payout.paid",
					school: booker.school,
					tz: booker.tz,
					eventTime: payout.at,
					key: PAYOUT_KEY,
					idem: payoutIdem(payout.id, failed),
					cause: booker.cause,
					labels: { mapping: payout.source.mapping },
					amount: payout.amount,
					...(failed ? { failed } : {}),
					text: `payout${failed ? " failed" : ""} ${payout.amount / CENTS_PER_DOLLAR} USD`,
					payload: {
						id: payout.id,
						amount: payout.amount,
						currency: payout.currency,
						...(failed ? { failed } : {}),
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

/**
 * A dispute in another currency that moved money, which the books do not take: its marker, or nothing for one in USD, one
 * with no withdrawal (an inquiry) or one with no amount. The idem is `stripe:<dispute id>:non_usd` and the date is the
 * opening line's, so the created event, the closed event and a re-send leave one marker (the outbox drops the others).
 * Asked for a dispute of a payment the books do not hold too (a non-USD invoice was never booked, so a dispute of it is
 * not a `payment.disputed` either, as for a refund), which is why `disputeEvents` is not the only caller.
 */
export const skippedDisputeEvents = ({
	dispute,
	labels,
	booker,
	holder,
}: {
	dispute: BillingDispute;
	labels: GrantLabels;
	booker: Booker;
	holder: { customerId: string };
}): AtmEvent[] => {
	const { amount, fee, withdrawn } = dispute;
	const currency = dispute.currency ?? USD;
	if (
		currency === USD ||
		amount === undefined ||
		amount <= 0 ||
		fee === undefined ||
		withdrawn === undefined ||
		withdrawn >= 0
	)
		return [];
	return [
		skippedNonUsd({
			kind: "dispute",
			id: dispute.id,
			amount,
			currency,
			at: dispute.withdrawnAt ?? dispute.openedAt ?? dispute.at,
			key: holder.customerId,
			labels,
			booker,
		}),
	];
};

/**
 * A dispute that moved money: `payment.disputed` for what Stripe withdrew when it opened (the disputed amount, and the
 * dispute fee it took with it: both are in the dispute's own `balance_transactions`, so nothing is asked of the caller), and
 * for a `charge.dispute.closed` also `dispute.closed`. A closed event carries the same withdrawal, so it makes the opening
 * line too, with the same idem and the same instant (the withdrawal's own `created`, which `reconcile` scopes Stripe's cash by) as the created event's: whichever Stripe
 * delivers first books it and the outbox drops the other, which also covers a dispute whose created event never came.
 * Won, the amount comes back and the fee does not: the recorded won dispute reverses `amount` with a fee of 0 and no
 * transaction gives the dispute fee back. Lost, `dispute.closed` has no postings.
 *
 * Nothing for a dispute with no withdrawal (an inquiry, `warning_*`: Stripe takes nothing from the balance, so there is
 * no money line to leave out) or with no amount. One in another currency that did move money makes only a `money.skipped`.
 */
export const disputeEvents = ({
	dispute,
	closing,
	labels,
	booker,
	holder,
}: {
	dispute: BillingDispute;
	/** The event is `charge.dispute.closed`. */
	closing: boolean;
	labels: GrantLabels;
	booker: Booker;
	holder: { customerId: string };
}): AtmEvent[] => {
	const { amount, fee, withdrawn } = dispute;
	if (
		amount === undefined ||
		amount <= 0 ||
		fee === undefined ||
		withdrawn === undefined ||
		withdrawn >= 0
	)
		return [];
	// One marker for the dispute, whichever of its events comes (idem `stripe:<dispute id>:non_usd`, dated like the opening
	// line): the closing makes it again and the outbox drops it. The closing line is not made either: a lost one has no
	// postings and a won one would reverse an opening that was never booked.
	if ((dispute.currency ?? USD) !== USD)
		return skippedDisputeEvents({ dispute, labels, booker, holder });
	const opened = ledgerEvent({
		type: "payment.disputed",
		school: booker.school,
		tz: booker.tz,
		eventTime: dispute.withdrawnAt ?? dispute.openedAt ?? dispute.at,
		key: holder.customerId,
		idem: `stripe:${dispute.id}`,
		cause: booker.cause,
		labels,
		amount,
		fee,
		text: `dispute opened on ${amount / CENTS_PER_DOLLAR} USD of charge ${dispute.chargeId}, dispute fee ${fee / CENTS_PER_DOLLAR} USD`,
		payload: {
			id: dispute.id,
			amount,
			fee,
			currency: USD,
			charge: dispute.chargeId,
			...(dispute.paymentIntentId
				? { payment_intent: dispute.paymentIntentId }
				: {}),
			...(dispute.invoiceId ? { invoice: dispute.invoiceId } : {}),
		},
	});
	if (!closing) return [opened];
	if (dispute.status === "open") return [];
	return [
		opened,
		ledgerEvent({
			type: "dispute.closed",
			school: booker.school,
			tz: booker.tz,
			// Won: the instant the reversal reached the balance, which can be a second before the event's `created`
			eventTime:
				dispute.status === "won"
					? (dispute.reversedAt ?? dispute.at)
					: dispute.at,
			key: holder.customerId,
			idem: `stripe:${dispute.id}:closed`,
			cause: booker.cause,
			labels,
			amount,
			won: dispute.status === "won",
			text: `dispute ${dispute.status}`,
			payload: { id: dispute.id, status: dispute.status },
		}),
	];
};
