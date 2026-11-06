import type { Clock } from "./types.ts";

/**
 * The Bookings contract (S2, orchestrator-owned, protected; protocol §4). The read side is buzz-school brief A item 2,
 * `GET /school-admin/schools/<id>/bookings?from=&to=`, joined with brief D's `attendanceFor(bookingIds)`; the write
 * side is brief D's admin outcome and admin cancel routes. S8's adapters call those routes; the fixtures stand in
 * until then. The Reader and the Writer of `reader.ts` and `writer.ts` extend `BookingsReader` and `BookingsWriter`.
 *
 * No billing field exists in brief A (held credits, a booking's payment): none is invented here, so the UI shows no
 * held or paid amount for a booking. The UI derives no number the server should derive. What it may work out is
 * stated below and exported as `needsOutcome` and `insideCutoff`: rules over `state`, `attendance`, `startsAt`,
 * `cutoffMinutes` and the clock, nothing else.
 */

/** One read of the list: the school's bookings that start from `from` to `to` (both `YYYY-MM-DD`, inclusive, in the
 * school's time zone). Brief A caps a range at 62 days. */
export type BookingsQuery = { school: string; from: string; to: string };

export type BookingHost = { id: string; name: string };
/** The member a booking is for: `key` is the atm customer id (`family:<familyId>`, brief A item 1), `name` the
 * nickname, else the family name. */
export type BookingAttendee = { key: string; name: string };
/** The states the list holds: a booking waiting for its host's approval, or a confirmed one. Cancelled bookings are
 * not in the list (the S8 adapter drops them). */
export type BookingState = "requested" | "confirmed";
/** Brief D's `booking_attendance.state`. */
export type Attendance = "attended" | "no_show";

export type Booking = {
	id: string;
	eventId: string;
	/** The bookable item's name, e.g. "Massage 90". */
	service: string;
	/** Start and end as the school's local wall time, `YYYY-MM-DDTHH:MM`, the form of `Clock.now`, so the two compare
	 * as strings (the S8 adapter converts brief A's instants with the school's `timeZone`). */
	startsAt: string;
	endsAt: string;
	hosts: BookingHost[];
	/** null for a guest booking. */
	attendee: BookingAttendee | null;
	guest: boolean;
	state: BookingState;
	/** The item's own cancel cutoff (`booking_events.change_cutoff_min`). */
	cutoffMinutes: number;
	seriesId: string | null;
	/**
	 * The series badge as the mockup's Status column shows it ("weekly · 3 left"), worded by the server. NOT in brief A
	 * today: the fixtures fill it from the mockup and the S8 adapter leaves it out until a route provides it (an S8
	 * gap). The UI shows it as it is and never counts what is left.
	 */
	seriesLabel?: string;
	/** From brief D's `attendanceFor`: the outcome an admin recorded, or null when none is. */
	attendance: Attendance | null;
	/**
	 * How the booking is paid, as the mockup's Billing column shows it. NOT in brief A today ("no billing fields exist
	 * yet"): the fixtures fill it from the mockup, and the S8 adapter leaves it out until a route provides it (an S8 gap,
	 * waiting on atm's booking payments). When it is absent the UI shows no billing text and offers Release hold.
	 */
	billing?: BookingBilling;
};

/** `free`: nothing held or paid. `held`: credits held for the booking. `paid`: paid in money (minor units). */
export type BookingBilling =
	| { kind: "free" }
	| { kind: "held"; credits: number }
	| { kind: "paid"; amountMinor: number; currency: string };

/** Brief A's answer, with `attendance` joined onto each booking. */
export type BookingsList = { bookings: Booking[] };

export interface BookingsReader {
	/** The list for one range. The overdue group (bookings before `from` that still need an outcome) is a second read
	 * over the 62 days that end the day before `from`. */
	bookings(query: BookingsQuery): Promise<BookingsList>;
}

/** Brief D item 2, `POST .../bookings/<bookingId>/outcome { state, note? }`. Confirm attended sends `attended`;
 * No-show sends `no_show`. */
export type RecordOutcome = {
	school: string;
	bookingId: string;
	state: Attendance;
	note?: string;
};
/** Brief D: the outcome has no credit effect yet. */
export type OutcomeRecorded = { creditEffect: "not_wired" };
/** Brief D item 3, `POST .../bookings/<bookingId>/cancel { reason, waiveCutoff? }`: the Bookings tab's Release hold.
 * Outside the cutoff it is sent without `waiveCutoff`; inside, after the dialog, with `waiveCutoff` true when the
 * admin ticked "Waive the late-cancel forfeit" and false when not. */
export type CancelBooking = {
	school: string;
	bookingId: string;
	reason: string;
	waiveCutoff?: boolean;
};

/** The mockup's Release hold has no reason field, so the tab sends this one. */
export const adminReleaseReason = "admin_release";

export interface BookingsWriter {
	recordOutcome(request: RecordOutcome): Promise<OutcomeRecorded>;
	cancelBooking(request: CancelBooking): Promise<void>;
}
/* Confirm all attended has no route of its own: it is one `recordOutcome({ school, bookingId, state: "attended" })`
 * per booking of its group that needs an outcome, in the order the rows show (`startsAt` ascending). */

const minuteMilliseconds = 60_000;
/** Minutes from `now` to `wallTime`, both `YYYY-MM-DDTHH:MM`, read as the same zone (the clock's). */
const minutesBetween = (now: string, wallTime: string): number =>
	(Date.parse(`${wallTime}:00Z`) - Date.parse(`${now}:00Z`)) /
	minuteMilliseconds;

/** Overdue (mockup `needsOut`): a confirmed booking that has started and has no recorded outcome. Its row offers
 * Confirm attended and No-show; before the range's first day it sits in the "Overdue: needs an outcome" group. */
export const needsOutcome = (booking: Booking, clock: Clock): boolean =>
	booking.state === "confirmed" &&
	booking.attendance === null &&
	booking.startsAt < clock.now;

/** Inside the cutoff (mockup `isWithin`): a confirmed booking that has not started and starts in fewer than its
 * `cutoffMinutes`. Its status reads "Inside <hours>h cutoff", whole hours or one decimal (mockup `fmtCut`), and its
 * Release hold opens the waive dialog. */
export const insideCutoff = (booking: Booking, clock: Clock): boolean =>
	booking.state === "confirmed" &&
	booking.startsAt >= clock.now &&
	minutesBetween(clock.now, booking.startsAt) < booking.cutoffMinutes;
