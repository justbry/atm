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
 * The books: no money line (`payment.succeeded`, `payment.refunded`) is made for a booking's payment. A booking has no
 * invoice, and `reconcile` pairs a `payment.succeeded` with a Stripe invoice, so a booking's payment would show there as
 * a payment Stripe never had. Until reconcile pairs by charge, the booking's payment and its refund are left out of the
 * books (see the 0.8.0 notes in `ROADMAP.md`).
 *
 * Pure: no clock, no network. Decided once: the replay of a paid session finds its record and decides nothing, so the
 * caller must write the rows and act on the outcome in one transaction (as for an invoice).
 */
import type {
	AtmEnv,
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
import { grantsRow, subjectKey } from "./rows.js";

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
	input: StripeEventInput,
	env: AtmEnv,
	holder: Holder,
	state: GrantsState,
	booking: BookingPaymentOutcome,
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
		events: [],
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
	input: StripeEventInput;
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

	const holder = known ?? {
		orgId: schoolId,
		customerId: `${FAMILY_PREFIX}${familyId}`,
	};
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
		},
	};
	// A subject with no rows is created here from the metadata, as a dollar gift creates one: a grants row with a holder.
	const state = withBooking(
		known ? grants : { ...grants, holder },
		bookingId,
		record,
	);
	return writeGrants(input, env, holder, state, {
		action: "paid",
		bookingId,
		familyId,
		schoolId,
		sessionId: fact.sessionId,
		paymentIntentId: fact.paymentIntentId,
		chargeId: null,
		amount,
		currency: fact.currency,
	});
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
	input: StripeEventInput;
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
	const next: BookingRecord = {
		...record,
		state: full ? "refunded" : record.state,
		payment: { ...payment, refunded: Math.max(total, payment.refunded) },
	};
	return writeGrants(input, env, holder, withBooking(grants, bookingId, next), {
		action: full ? "refunded" : "partly_refunded",
		bookingId,
		familyId: familyOf(holder),
		schoolId: holder.orgId,
		sessionId: payment.sessionId,
		paymentIntentId: payment.paymentIntentId ?? fact.paymentIntentId ?? null,
		chargeId: fact.chargeId,
		amount: total,
		currency: fact.currency ?? payment.currency,
	});
};
