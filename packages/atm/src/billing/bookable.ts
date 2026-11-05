/**
 * What a bookable item costs and the commands that hold, spend and release its credits. Pure: nothing is read from the clock
 * or written; every call takes the subject's rows and the time. Owned by the bookable-pricing change (0.8.0); the signatures
 * are fixed in `ROADMAP.md` ("0.8.0 design") and `types.ts`, and this file holds them until that change lands.
 */
import type {
	BillingRow,
	BillingValidation,
	BookingQuote,
	BookingResult,
	ExpiredHold,
	HoldBookingInput,
	Menu,
	QuoteInput,
	SettleBookingInput,
} from "./types.js";

const notBuilt = (name: string): never => {
	throw new Error(`${name} is not built yet`);
};

/** Checks an unknown value as a `Billing` against the menu: the feature exists, credits are a whole number of 1 or more, the amount is a whole number of cents above 0, the currency is the menu's, every tier id exists. */
export const validateBilling = (
	_input: unknown,
	_menu: Menu,
): BillingValidation => notBuilt("validateBilling");

/** The cost of one booking for this holder: credits to hold, a price to pay, nothing, or why not. */
export const quoteBooking = (_input: QuoteInput): BookingQuote =>
	notBuilt("quoteBooking");

/** Holds the booking's credits on a lock. */
export const holdBooking = (_input: HoldBookingInput): BookingResult =>
	notBuilt("holdBooking");

/** Spends what the booking holds (the session happened). */
export const confirmBooking = (_input: SettleBookingInput): BookingResult =>
	notBuilt("confirmBooking");

/** Gives back what the booking holds. */
export const releaseBooking = (_input: SettleBookingInput): BookingResult =>
	notBuilt("releaseBooking");

/** A member's cancel: released before the cutoff, `policy.lateCancel` after it. */
export const cancelBooking = (_input: SettleBookingInput): BookingResult =>
	notBuilt("cancelBooking");

/** The session passed without the member: `policy.noShow`. */
export const noShowBooking = (_input: SettleBookingInput): BookingResult =>
	notBuilt("noShowBooking");

/** The holds whose expiry has passed and nobody settled, soonest first. */
export const expiredHolds = (_input: {
	rows: readonly BillingRow[];
	now: number;
}): ExpiredHold[] => notBuilt("expiredHolds");

/** Applies an expired hold's own expiry action: `confirm` keeps it spent, `release` gives it back. */
export const settleExpiredHold = (_input: SettleBookingInput): BookingResult =>
	notBuilt("settleExpiredHold");
