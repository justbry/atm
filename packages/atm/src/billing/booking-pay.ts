/**
 * The one-time payment for a booking: the Checkout Session's parameters. The Stripe events it leads to
 * (`checkout.session.*`, the refund of its charge) are decided in `booking-events.ts` and called from `handle.ts`. The
 * signature is fixed in `ROADMAP.md` ("0.8.0 design") and `types.ts`.
 *
 * Pure: no clock, no network. The session carries one inline price (`price_data`), so nothing is published to Stripe for a
 * booking, and no `invoice_creation`: a booking is not a membership invoice, so no invoice is made and no credits are
 * granted. Its metadata is on the session (the `checkout.session.*` events) and on the payment intent (Stripe copies a
 * payment intent's metadata to its charge, which is what a refund carries).
 */
import type { BookingCheckoutInput, BookingCheckoutResult } from "./types.js";

/** The largest amount Stripe takes for one line: eight nines, in minor units. */
const STRIPE_MAX_AMOUNT = 99_999_999;

const CURRENCY_PATTERN = /^[a-z]{3}$/;

/** What marks a session as a booking's, next to its `booking_id`. */
export const BOOKING_KIND = "booking";

/** A payment-mode Checkout Session for one booking, or why not. */
export const bookingCheckoutParams = (
	input: BookingCheckoutInput,
): BookingCheckoutResult => {
	const { amount } = input;
	if (!Number.isInteger(amount) || amount <= 0 || amount > STRIPE_MAX_AMOUNT)
		return { ok: false, reason: "bad_amount" };
	const currency =
		typeof input.currency === "string" ? input.currency.toLowerCase() : "";
	if (!CURRENCY_PATTERN.test(currency))
		return { ok: false, reason: "bad_currency" };
	if (typeof input.bookingId !== "string" || input.bookingId.trim() === "")
		return { ok: false, reason: "no_booking_id" };
	const metadata: Record<string, string> = {
		b4u_school: input.schoolId,
		family_id: input.familyId,
		booking_id: input.bookingId,
		b4u_kind: BOOKING_KIND,
		...(input.forProfileId ? { profile_id: input.forProfileId } : {}),
	};
	return {
		ok: true,
		params: {
			mode: "payment",
			client_reference_id: input.familyId,
			success_url: input.returnUrls.success,
			cancel_url: input.returnUrls.cancel,
			line_items: [
				{
					quantity: 1,
					price_data: {
						currency,
						unit_amount: amount,
						product_data: { name: input.name },
					},
				},
			],
			metadata,
			// A copy: the charge's metadata must not move with the session's if the caller adds a key to one.
			payment_intent_data: { metadata: { ...metadata } },
		},
	};
};
