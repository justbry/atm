/**
 * The one-time payment for a booking: the Checkout Session's parameters. The Stripe events it leads to (`checkout.session.*`,
 * the refund of its charge) are decided in `handle.ts`. Owned by the paid-booking change (0.8.0); the signature is fixed in
 * `ROADMAP.md` ("0.8.0 design") and `types.ts`, and this file holds it until that change lands.
 */
import type { BookingCheckoutInput, BookingCheckoutResult } from "./types.js";

/** A payment-mode Checkout Session for one booking, or why not. */
export const bookingCheckoutParams = (
	_input: BookingCheckoutInput,
): BookingCheckoutResult => {
	throw new Error("bookingCheckoutParams is not built yet");
};
