/**
 * What a Stripe event decides about a one-time booking payment (the Checkout Session `bookingCheckoutParams` makes and the
 * refund of its charge). `handle.ts` calls these before its own rules; each returns the whole `StripeEventResult`.
 *
 *   checkout.session.completed / async_payment_succeeded, paid   -> `booking: { action: "paid" }`, and the booking's
 *       record in the holder's grants state (`bookings[bookingId]`, state `paid`, with its payment)
 *   checkout.session.expired                                     -> `booking: { action: "expired" }`, no row change
 *   charge.refunded of a booking's charge                        -> `booking: { action: "refunded" | "partly_refunded" }`
 *
 * What is NOT decided here, on purpose: a session in subscription (or setup) mode, a session with no `booking_id` (a
 * one-time add-on checkout: its invoice decides), and an unpaid `completed` (a delayed payment method: its
 * `async_payment_succeeded` decides). Each is `{ rowChanges: null, events: [] }`.
 *
 * The books: a paid booking makes a `payment.succeeded` (gross = the session's `amount_total`, income
 * `income:billing:booking`, idem `stripe:<payment intent id>`, `labels.booking` the booking id; the Stripe fee is the
 * caller's optional `StripeEventInput.fee`, as for an invoice), and a refund of a payment the books hold makes a
 * `payment.refunded` for what the charge's running total rose by (`amount_refunded` less the record's `payment.refunded`,
 * so an event that arrives late books nothing twice and nothing is lost). `payment.booked` on the record says the books took the
 * payment; a payment decided before payments were booked, or one in another currency (a `money.skipped` marker, as for an
 * invoice), has none and its refund books no `payment.refunded`. `reconcile` pairs the payment with Stripe's payment
 * intents (`paymentIntents`) and the refund with Stripe's refunds, by payment intent.
 *
 * The revenue share (`./share.ts`): when the policy has a rate, a paid booking also makes a `share.accrued` after its
 * `payment.succeeded`, and a refund of a payment that accrued one makes a `share.reversed` after its `payment.refunded`;
 * the record keeps what was accrued and reversed (`payment.share`), absent when there was none.
 *
 * Pure: no clock, no network. Decided once: the replay of a paid session finds its record and decides nothing, so the
 * caller must write the rows and act on the outcome in one transaction (as for an invoice).
 */
import type {
	AtmEnv,
	AtmEvent,
	AtmIdentity,
	BillingRefund,
	BookingPaymentOutcome,
	BookingRecord,
	CheckoutSessionFact,
	GrantsState,
	StripeEventInput,
	StripeEventRefusal,
	StripeEventResult,
} from "../types.js";
import {
	bookerOf,
	bookingPaymentEvents,
	feeProblem,
	refundEvents,
	skippedRefundEvents,
} from "./money.js";
import { grantsRow, subjectKey } from "./rows.js";
import { accrueShare, reverseShare } from "./share.js";

const FAMILY_PREFIX = "family:";

type Holder = { orgId: string; customerId: string };

const refuse = (
	reason: StripeEventRefusal["reason"],
	message: string,
): StripeEventResult => ({
	rowChanges: null,
	events: [],
	refused: { reason, message },
});

const nothing = (): StripeEventResult => ({ rowChanges: null, events: [] });

/** The holder an existing state names; null for a subject with no rows yet. */
const holderOf = (grants: GrantsState): Holder | null =>
	grants.identity ?? grants.holder;

const familyOf = (holder: Holder): string =>
	holder.customerId.startsWith(FAMILY_PREFIX)
		? holder.customerId.slice(FAMILY_PREFIX.length)
		: holder.customerId;

/** The one write of a booking decision: the grants row alone, one revision on. Engine rows are not touched. */
const writeGrants = (
	input: Omit<StripeEventInput, "event">,
	env: AtmEnv,
	holder: Holder,
	state: GrantsState,
	booking: BookingPaymentOutcome,
	events: AtmEvent[],
): StripeEventResult => {
	const identity: AtmIdentity = {
		orgId: holder.orgId,
		env,
		customerId: holder.customerId,
		entityId: null,
	};
	return {
		rowChanges: {
			subjectKey: subjectKey(identity),
			expectedRevision: input.revision,
			nextRevision: input.revision + 1,
			upserts: [grantsRow(state)],
			deletes: [],
		},
		events,
		booking,
	};
};

const withBooking = (
	grants: GrantsState,
	bookingId: string,
	record: BookingRecord,
): GrantsState => ({
	...grants,
	bookings: { ...grants.bookings, [bookingId]: record },
});

/** The labels of a booking's money lines: the versions and mapping every decision carries, and the booking's id. */
const labelsOf = (
	input: Omit<StripeEventInput, "event">,
	mapping: string,
	bookingId: string,
): Record<string, string> => ({
	menu_version: String(input.menuVersion),
	policy_version: String(input.policyVersion),
	mapping,
	booking: bookingId,
});

/** A positive whole number of minor units, or null. */
const wholeAmount = (value: number | null): number | null =>
	value !== null && Number.isInteger(value) && value > 0 ? value : null;

/**
 * A Checkout Session event. Returns nothing for a session that is not a booking's payment (see the file header), a refusal
 * for a booking's session that cannot be decided, else the outcome.
 */
export const decideCheckoutSession = ({
	input,
	env,
	grants,
	fact,
}: {
	input: Omit<StripeEventInput, "event">;
	env: AtmEnv;
	grants: GrantsState;
	fact: CheckoutSessionFact;
}): StripeEventResult => {
	const bookingId = fact.metadata.booking_id;
	if (fact.mode !== "payment" || !bookingId) return nothing();
	const existing = grants.bookings?.[bookingId];
	const known = holderOf(grants);
	const schoolId = fact.metadata.b4u_school ?? known?.orgId;
	const familyId =
		fact.metadata.family_id ?? (known ? familyOf(known) : undefined);
	if (!schoolId || !familyId)
		return refuse(
			"missing_metadata",
			`session ${fact.sessionId} (booking ${bookingId}) has no b4u_school/family_id metadata to name the holder`,
		);

	if (fact.status === "expired") {
		// A booking that was paid (by another session of it) is not freed by a session that lapsed.
		if (existing?.payment) return nothing();
		return {
			rowChanges: null,
			events: [],
			booking: {
				action: "expired",
				bookingId,
				familyId,
				schoolId,
				sessionId: fact.sessionId,
				paymentIntentId: fact.paymentIntentId,
				chargeId: null,
				amount: wholeAmount(fact.amountTotal) ?? 0,
				currency: fact.currency ?? "",
			},
		};
	}

	// Not paid yet: a delayed payment method completes the session as `unpaid`, and its `async_payment_succeeded` decides.
	if (fact.status !== "complete" || fact.paymentStatus !== "paid")
		return nothing();
	if (existing?.payment?.sessionId === fact.sessionId) return nothing();
	const amount = wholeAmount(fact.amountTotal);
	if (amount === null || !fact.currency)
		return refuse(
			"bad_event",
			`session ${fact.sessionId} (booking ${bookingId}) is paid but has no amount_total or currency`,
		);
	// A second session paid for the same booking is money taken twice: recording it would lose the first payment, and
	// confirming twice hides it. Say so, for a person to refund one of them.
	if (
		existing &&
		existing.state !== "refunded" &&
		existing.state !== "released"
	)
		return refuse(
			"rejected",
			`booking ${bookingId} is already ${existing.state}${existing.payment ? ` (paid by session ${existing.payment.sessionId})` : ""}, and session ${fact.sessionId} paid for it too: refund one of the payments`,
		);

	const problem = feeProblem(input.fee, amount, "booking");
	if (problem) return refuse("bad_event", problem);

	const holder = known ?? {
		orgId: schoolId,
		customerId: `${FAMILY_PREFIX}${familyId}`,
	};
	const booker = bookerOf(input, holder);
	const labels = labelsOf(input, fact.source.mapping, bookingId);
	const payment = bookingPaymentEvents({
		payment: {
			bookingId,
			sessionId: fact.sessionId,
			paymentIntentId: fact.paymentIntentId,
			amount,
			currency: fact.currency,
			at: fact.at,
		},
		fee: input.fee,
		labels,
		booker,
		holder,
	});
	// The school's revenue share on what the session collected, booked right after the payment.
	const share = accrueShare({
		policy: input.policy,
		kind: "booking",
		collected: amount,
		money: payment,
		paymentId: fact.paymentIntentId ?? fact.sessionId,
		labels,
		booker,
		holder,
	});
	const money = [...payment, ...share.events];
	const record: BookingRecord = {
		state: "paid",
		cost: { kind: "price", amount, currency: fact.currency },
		startsAt: null,
		expiresAt: null,
		payment: {
			sessionId: fact.sessionId,
			paymentIntentId: fact.paymentIntentId,
			amount,
			currency: fact.currency,
			refunded: 0,
			// Only a payment line is a payment the books took: the `money.skipped` marker of a non-USD booking is not one.
			...(payment.some((event) => event.event_type === "payment.succeeded")
				? { booked: true }
				: {}),
			// What the share accrued on it, which a refund reverses in proportion; absent when the school has no rate.
			...(share.accrued > 0
				? { share: { accrued: share.accrued, reversed: 0 } }
				: {}),
		},
	};
	// A subject with no rows is created here from the metadata, as a dollar gift creates one: a grants row with a holder.
	const state = withBooking(
		known ? grants : { ...grants, holder },
		bookingId,
		record,
	);
	return writeGrants(
		input,
		env,
		holder,
		state,
		{
			action: "paid",
			bookingId,
			familyId,
			schoolId,
			sessionId: fact.sessionId,
			paymentIntentId: fact.paymentIntentId,
			chargeId: null,
			amount,
			currency: fact.currency,
		},
		money,
	);
};

/**
 * A refund of a booking's charge, named by the caller's `bookingIds` (payment intent or charge id) or by the charge's own
 * `metadata.booking_id`. Null when the refund is not a booking's, so the invoice rules go on: a charge that an invoice
 * paid (the fact's `invoiceId`, or `input.invoiceIds`) is the invoice's, and one that names neither is as it was before.
 */
export const decideBookingRefund = ({
	input,
	env,
	grants,
	fact,
}: {
	input: Omit<StripeEventInput, "event">;
	env: AtmEnv;
	grants: GrantsState;
	fact: BillingRefund;
}): StripeEventResult | null => {
	const paymentRefs = [fact.paymentIntentId, fact.chargeId].filter(
		(ref): ref is string => typeof ref === "string" && ref !== "",
	);
	if (fact.invoiceId || paymentRefs.some((ref) => input.invoiceIds?.[ref]))
		return null;
	const bookingId =
		paymentRefs.map((ref) => input.bookingIds?.[ref]).find(Boolean) ??
		fact.bookingId;
	if (!bookingId) return null;

	const holder = holderOf(grants);
	const record = grants.bookings?.[bookingId];
	const payment = record?.payment;
	if (!holder || !record || !payment)
		return refuse(
			"unmatched_booking",
			`${fact.id} (charge ${fact.chargeId}) is a refund of booking ${bookingId}, which this holder has not paid for: retry once its checkout.session.completed is handled`,
		);
	if (
		payment.paymentIntentId &&
		fact.paymentIntentId &&
		payment.paymentIntentId !== fact.paymentIntentId
	)
		return refuse(
			"unmatched_booking",
			`${fact.id} refunds payment intent ${fact.paymentIntentId}, but booking ${bookingId} was paid by ${payment.paymentIntentId}`,
		);

	// `amount` is the charge's total refunded after this event: an event that does not raise it (a redelivery, or an older
	// one that arrived late) decides nothing, and the full refund is decided once.
	const total = fact.amount;
	const settled = record.state === "refunded";
	if (settled || (total <= payment.refunded && !fact.full)) return nothing();
	const full = fact.full;
	// What this event added to the charge's refunded total, by the record's own running total: an event that arrives late (a
	// smaller total than one already decided) adds nothing, and the books end at the charge's total whatever the order.
	const refund: BillingRefund = {
		...fact,
		previousAmount: payment.refunded,
		currency: fact.currency ?? payment.currency,
	};
	// Only a refund of a payment the books hold is a `payment.refunded`; a non-USD one leaves the marker either way.
	const booker = bookerOf(input, holder);
	const labels = labelsOf(input, fact.source.mapping, bookingId);
	const refunded = (payment.booked ? refundEvents : skippedRefundEvents)({
		refund,
		labels,
		booker,
		holder,
		...(payment.booked ? { bookingId } : {}),
	});
	const refundedTotal = Math.max(total, payment.refunded);
	// The part of the payment's share this refund takes back, from the record's own running total.
	const share = reverseShare({
		record: payment.share,
		collected: payment.amount,
		refundedTotal,
		refundId: fact.id,
		refundAt: fact.at,
		money: refunded,
		paymentId: payment.paymentIntentId ?? payment.sessionId,
		labels,
		booker,
		holder,
	});
	const money = [...refunded, ...share.events];
	const next: BookingRecord = {
		...record,
		state: full ? "refunded" : record.state,
		payment: {
			...payment,
			refunded: refundedTotal,
			...(share.share ? { share: share.share } : {}),
		},
	};
	return writeGrants(
		input,
		env,
		holder,
		withBooking(grants, bookingId, next),
		{
			action: full ? "refunded" : "partly_refunded",
			bookingId,
			familyId: familyOf(holder),
			schoolId: holder.orgId,
			sessionId: payment.sessionId,
			paymentIntentId: payment.paymentIntentId ?? fact.paymentIntentId ?? null,
			chargeId: fact.chargeId,
			amount: total,
			currency: fact.currency ?? payment.currency,
		},
		money,
	);
};
