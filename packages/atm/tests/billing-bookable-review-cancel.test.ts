/**
 * A cancel is for a session that has not started: from `startsAt` on it is refused as `session_started` (the caller records
 * a no-show), so a member who missed the session cannot cancel it to get the credit back under `lateCancel: "release"`.
 */
import { expect, test } from "bun:test";
import {
	cancelBooking,
	holdBooking,
	noShowBooking,
} from "../src/billing/bookable.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { DAY, HOUR, member, PAID_AT } from "./billing-bookable-world.js";

const NOW = PAID_AT + DAY;
const STARTS = PAID_AT + 20 * DAY;
const EXPIRES = STARTS + DAY;

const heldUnder = (lateCancel: "spend" | "release") => {
	const booked = member({
		policy: { ...DEFAULT_POLICY, noShow: "spend", lateCancel },
	});
	const held = booked.apply(
		holdBooking({
			...booked.ctx(NOW),
			bookingId: "b1",
			featureId: "visit",
			credits: 1,
			startsAt: STARTS,
			expiresAt: EXPIRES,
		}),
	);
	expect(held.ok).toBe(true);
	return booked;
};

test("a cancel after the session started is refused as session_started", () => {
	const booked = heldUnder("release");
	const at = STARTS + 3 * HOUR;
	const cancel = booked.apply(
		cancelBooking({ ...booked.ctx(at), bookingId: "b1" }),
	);
	expect(cancel).toMatchObject({ ok: false, reason: "session_started" });
	if (cancel.ok) throw new Error("the cancel was taken");
	expect(cancel.message).toContain("noShowBooking");
	expect(booked.balance(at)).toEqual({ avail: 1, held: 1 });
	expect(booked.grants.bookings?.b1?.state).toBe("held");
});

test("a cancel at the very start is refused too", () => {
	const booked = heldUnder("release");
	const cancel = cancelBooking({ ...booked.ctx(STARTS), bookingId: "b1" });
	expect(cancel).toMatchObject({ ok: false, reason: "session_started" });
});

test("a cancel between the cutoff and the start is still a late cancel", () => {
	const booked = heldUnder("release");
	const cancel = booked.apply(
		cancelBooking({ ...booked.ctx(STARTS - HOUR), bookingId: "b1" }),
	);
	if (!cancel.ok) throw new Error(cancel.reason);
	expect(cancel.late).toBe(true);
	expect(cancel.booking).toMatchObject({
		state: "released",
		settledBy: "late_cancel",
	});
});

test("after the start, the no-show is what settles the booking", () => {
	const booked = heldUnder("release");
	const at = STARTS + 3 * HOUR;
	booked.apply(cancelBooking({ ...booked.ctx(at), bookingId: "b1" }));
	const noShow = booked.apply(
		noShowBooking({ ...booked.ctx(at), bookingId: "b1" }),
	);
	if (!noShow.ok) throw new Error(noShow.reason);
	expect(noShow.booking).toMatchObject({
		state: "spent",
		settledBy: "no_show",
	});
});

test("a cancel that settled before the start replays after it as the same result", () => {
	const booked = heldUnder("release");
	const first = booked.apply(
		cancelBooking({ ...booked.ctx(STARTS - HOUR), bookingId: "b1" }),
	);
	if (!first.ok) throw new Error(first.reason);
	const replay = cancelBooking({
		...booked.ctx(STARTS + HOUR),
		bookingId: "b1",
	});
	if (!replay.ok) throw new Error(replay.reason);
	expect(replay.rowChanges).toBeNull();
	expect(replay.late).toBe(true);
});
