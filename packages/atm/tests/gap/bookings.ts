/**
 * The `bookings` bundle: four one-time bookings paid by Checkout Session (no invoice, no subscription): one paid and kept,
 * one whose hold expired unpaid, one cancelled by a full refund that arrives before its own payment, one part-refunded.
 *
 * A booking's Stripe events are decided by the family service's own endpoint (the reference handler ignores
 * `checkout.session.*`), which the runner plays as `tests/stored-inputs-booking.test.ts` does. Every number below is
 * written by hand from the rules and none is read from the handler, the log or a report:
 *   - the books take the session's `amount_total` as `income:billing:booking`; Stripe's fee is the caller's, by payment
 *     intent: 2.9% + 30 cents, rounded (the school's policy has no revenue share, so no share lines)
 *   - a refund is booked for what the event itself refunded (`amount_refunded` less `previous_attributes.amount_refunded`)
 *   - a refund of a booking the endpoint has not heard of answers 409 `unmatched_booking`, stores nothing, and is applied
 *     when Stripe delivers it again after the booking's payment
 *   - an expired session books nothing; booking ids: bk_1 .. bk_4
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ms } from "../e2e-events.js";
import {
	type Case,
	type Step,
	stripeBalance,
	stripePaymentIntent,
	stripeRefund,
} from "../e2e-matrix.js";
import { FAMILY, SCHOOL } from "../handler-harness.js";
import type { RawEvent } from "../stripe-events.js";

const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const MS_PER_SECOND = 1000;

const BOOKING_DIRECTORY = join(
	import.meta.dir,
	"../../fixtures/billing/stripe/recorded/booking",
);

/** A recorded booking event (a sandbox object) as the template of a live one. */
const template = (name: string): RawEvent => {
	const event = JSON.parse(
		readFileSync(join(BOOKING_DIRECTORY, name), "utf8"),
	) as RawEvent;
	event.livemode = true;
	event.data.object.livemode = true;
	return event;
};

const seconds = (atMs: number): number => Math.floor(atMs / MS_PER_SECOND);

const stamp = (atMs: number): string =>
	`${new Date(atMs).toISOString().slice(0, 19)}Z`;

const OTHER_FAMILY = "fam_c3";

type Booking = {
	bookingId: string;
	family: string;
	cents: number;
	paymentIntent: string;
	charge: string;
	/** When the customer paid (Stripe's time of the session and the intent). */
	paidAt: number;
};

const BK_1: Booking = {
	bookingId: "bk_1",
	family: FAMILY,
	cents: 3000,
	paymentIntent: "pi_bk_1",
	charge: "ch_bk_1",
	paidAt: ms("2026-03-02T15:00:00Z"),
};
const BK_3: Booking = {
	bookingId: "bk_3",
	family: OTHER_FAMILY,
	cents: 5000,
	paymentIntent: "pi_bk_3",
	charge: "ch_bk_3",
	paidAt: ms("2026-03-05T11:00:00Z"),
};
const BK_4: Booking = {
	bookingId: "bk_4",
	family: FAMILY,
	cents: 2000,
	paymentIntent: "pi_bk_4",
	charge: "ch_bk_4",
	paidAt: ms("2026-03-09T08:00:00Z"),
};
const EXPIRED_AT = ms("2026-03-03T10:00:00Z");
const BK_2_FAMILY = FAMILY;
const BK_2_CENTS = 3000;

const metadataOf = (bookingId: string, family: string) => ({
	b4u_kind: "booking",
	b4u_school: SCHOOL,
	booking_id: bookingId,
	family_id: family,
});

/** `checkout.session.completed` for a paid payment-mode session. */
const paid = (booking: Booking, eventId: string): RawEvent => {
	const event = template("checkout.session.completed.json");
	const session = event.data.object;
	event.id = eventId;
	event.created = seconds(booking.paidAt);
	session.id = `cs_${booking.bookingId}`;
	session.created = seconds(booking.paidAt) - 2;
	session.amount_subtotal = booking.cents;
	session.amount_total = booking.cents;
	session.payment_intent = booking.paymentIntent;
	session.metadata = metadataOf(booking.bookingId, booking.family);
	return event;
};

/** `checkout.session.expired`: the hold ran out unpaid, so the session has no payment intent. */
const expired = (): RawEvent => {
	const event = template("checkout.session.expired.json");
	const session = event.data.object;
	event.id = "evt_bk_2_expired";
	event.created = seconds(EXPIRED_AT);
	session.id = "cs_bk_2";
	session.amount_total = BK_2_CENTS;
	session.payment_intent = null;
	session.metadata = metadataOf("bk_2", BK_2_FAMILY);
	return event;
};

/** `charge.refunded` of a booking's charge: `refundedTotal` is the charge's total after this refund. */
const refunded = (
	booking: Booking,
	eventId: string,
	atMs: number,
	refundedTotal: number,
	previousTotal: number,
): RawEvent => {
	const event = template("charge.refunded.full.json");
	const charge = event.data.object;
	event.id = eventId;
	event.created = seconds(atMs);
	charge.id = booking.charge;
	charge.payment_intent = booking.paymentIntent;
	charge.amount = booking.cents;
	charge.amount_captured = booking.cents;
	charge.amount_refunded = refundedTotal;
	charge.refunded = refundedTotal === booking.cents;
	charge.metadata = { booking_id: booking.bookingId };
	event.data.previous_attributes = { amount_refunded: previousTotal };
	return event;
};

const BK_3_REFUND_AT = ms("2026-03-05T12:00:00Z");
const BK_4_REFUND_AT = ms("2026-03-09T09:00:00Z");

/** The delivery clock: a webhook arrives a few seconds after the event's own time. */
const arrives = (atMs: number): number => atMs + 5 * SECOND;

const steps: Step[] = [
	{
		at: arrives(BK_1.paidAt),
		event: paid(BK_1, "evt_bk_1_paid"),
		answer: [200, "applied"],
	},
	// Stripe's retry of the same event id: stored once
	{
		at: BK_1.paidAt + MINUTE,
		event: paid(BK_1, "evt_bk_1_paid"),
		answer: [200, "duplicate"],
	},
	{
		at: arrives(EXPIRED_AT),
		event: expired(),
		answer: [200, "applied"],
	},
	// bk_3's refund beats its own payment: the endpoint has not heard of the booking, answers 409 and stores nothing
	{
		at: arrives(BK_3_REFUND_AT),
		event: refunded(BK_3, "evt_bk_3_refund", BK_3_REFUND_AT, 5000, 0),
		answer: [409, "unmatched_booking"],
	},
	// the payment, delayed, arrives afterwards (its event is from before the refund)
	{
		at: BK_3_REFUND_AT + 10 * MINUTE,
		event: paid(BK_3, "evt_bk_3_paid"),
		answer: [200, "applied"],
	},
	// Stripe delivers the refund again an hour on: now it is applied
	{
		at: BK_3_REFUND_AT + HOUR,
		event: refunded(BK_3, "evt_bk_3_refund", BK_3_REFUND_AT, 5000, 0),
		answer: [200, "applied"],
	},
	{
		at: arrives(BK_4.paidAt),
		event: paid(BK_4, "evt_bk_4_paid"),
		answer: [200, "applied"],
	},
	{
		at: arrives(BK_4_REFUND_AT),
		event: refunded(BK_4, "evt_bk_4_refund", BK_4_REFUND_AT, 500, 0),
		answer: [200, "applied"],
	},
];

export const CASES: Case[] = [
	{
		id: "bookings",
		title:
			"four one-time bookings: kept, expired unpaid, cancelled by a refund that beat its payment, part-refunded",
		path: "checkout.session.completed + checkout.session.expired + charge.refunded (a booking's, decided by the family service)",
		// the caller's fee lookup, by payment intent
		fees: { pi_bk_1: 117, pi_bk_3: 175, pi_bk_4: 88 },
		steps,
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// income: bk_1 30.00 + bk_3 50.00 + bk_4 20.00 = 100.00 (bk_2 expired: nothing booked)
				// refunds: bk_3 50.00 in full + bk_4 5.00 of 20.00 = 55.00
				// fees (2.9% + 0.30, rounded): bk_1 30.00 -> 0.87 + 0.30 = 1.17; bk_3 50.00 -> 1.45 + 0.30 = 1.75;
				//       bk_4 20.00 -> 0.58 + 0.30 = 0.88; total 3.80 (Stripe keeps a charge's fee on a refund)
				// Stripe's balance and the net income: 100.00 - 55.00 - 3.80 = 41.20
				// credits: a booking grants none
				hand: {
					"income:booking": 10_000,
					refunds: 5500,
					fees: 380,
					stripe: 4120,
					net: 4120,
				},
				stripe: {
					invoices: [],
					refunds: [
						stripeRefund("re_bk_3", 5000, stamp(BK_3_REFUND_AT), "bk_3", {
							charge: BK_3.charge,
							intent: BK_3.paymentIntent,
						}),
						stripeRefund("re_bk_4", 500, stamp(BK_4_REFUND_AT), "bk_4", {
							charge: BK_4.charge,
							intent: BK_4.paymentIntent,
						}),
					],
					disputes: [],
					payouts: [],
					paymentIntents: [
						stripePaymentIntent(
							BK_1.paymentIntent,
							BK_1.cents,
							stamp(BK_1.paidAt),
							BK_1.bookingId,
						),
						stripePaymentIntent(
							BK_3.paymentIntent,
							BK_3.cents,
							stamp(BK_3.paidAt),
							BK_3.bookingId,
						),
						stripePaymentIntent(
							BK_4.paymentIntent,
							BK_4.cents,
							stamp(BK_4.paidAt),
							BK_4.bookingId,
						),
					],
					balanceTransactions: [
						stripeBalance("txn_bk_1", "charge", 3000, 117, stamp(BK_1.paidAt)),
						stripeBalance("txn_bk_3", "charge", 5000, 175, stamp(BK_3.paidAt)),
						stripeBalance("txn_bk_4", "charge", 2000, 88, stamp(BK_4.paidAt)),
						stripeBalance(
							"txn_re_bk_3",
							"refund",
							-5000,
							0,
							stamp(BK_3_REFUND_AT),
						),
						stripeBalance(
							"txn_re_bk_4",
							"refund",
							-500,
							0,
							stamp(BK_4_REFUND_AT),
						),
					],
				},
				reconcile: { "2026-03": [] },
			},
		],
		notes: [
			"A booking's events are decided by the family service's own endpoint, not the reference handler; the runner plays that endpoint (stored-inputs-booking.test.ts) with its booking index, so a refund can be named by the payment intent.",
			"bk_1 30.00 paid and kept; bk_2 expired unpaid, nothing booked; bk_3 50.00 paid then refunded in full; bk_4 20.00 paid then 5.00 refunded.",
			"bk_3's refund event arrives before its payment event: 409 unmatched_booking (nothing stored), applied when Stripe delivers it again after the payment.",
			"Totals by hand: income 10,000; refunds 5,000 + 500 = 5,500; fees 117 + 175 + 88 = 380; Stripe's balance and the net income 10,000 - 5,500 - 380 = 4,120. No credits.",
		],
	},
];
