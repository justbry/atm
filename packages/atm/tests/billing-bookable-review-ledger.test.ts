/**
 * The events of every booking command name the caller's booking id in `labels.booking`, and the log they make (with the
 * releases that take back refunded or lapsed credits) is valid, balanced, journals, replays and passes `hledger check`.
 */
import { expect, test } from "bun:test";
import {
	cancelBooking,
	confirmBooking,
	holdBooking,
	noShowBooking,
	releaseBooking,
	settleExpiredHold,
} from "../src/billing/bookable.js";
import { lapsedRows, lapseEvent } from "../src/ledger/postings.js";
import { replayEvents } from "../src/ledger/replay.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent } from "../src/types.js";
import { checkWithHledger } from "./billing-bookable-review-world.js";
import {
	catalogRows,
	DAY,
	HOLDER,
	HOUR,
	member,
	PAID_AT,
	yearlyWithPack,
} from "./billing-bookable-world.js";
import { hasHledger } from "./helpers.js";

const NOW = PAID_AT + DAY;
const STARTS = PAID_AT + 20 * DAY;
const EXPIRES = STARTS + DAY;

/** Six bookings of one visit each, settled every way a booking settles. */
const everyWay = () => {
	const booked = member({ invoices: [yearlyWithPack()] });
	const start = booked.engine;
	const byBooking = new Map<string, AtmEvent[]>();
	const run = (bookingId: string, result: ReturnType<typeof holdBooking>) => {
		if (!result.ok) throw new Error(`${bookingId}: ${result.reason}`);
		booked.apply(result);
		byBooking.set(bookingId, [
			...(byBooking.get(bookingId) ?? []),
			...result.events,
		]);
	};
	for (const bookingId of ["a", "b", "c", "d", "e", "f"])
		run(
			bookingId,
			holdBooking({
				...booked.ctx(NOW),
				bookingId,
				featureId: "visit",
				credits: 1,
				startsAt: STARTS,
				expiresAt: EXPIRES,
			}),
		);
	run("a", confirmBooking({ ...booked.ctx(NOW + HOUR), bookingId: "a" }));
	run("b", releaseBooking({ ...booked.ctx(NOW + HOUR), bookingId: "b" }));
	run("c", cancelBooking({ ...booked.ctx(NOW + HOUR), bookingId: "c" }));
	run("d", cancelBooking({ ...booked.ctx(STARTS - HOUR), bookingId: "d" }));
	run("e", noShowBooking({ ...booked.ctx(STARTS + HOUR), bookingId: "e" }));
	run("f", settleExpiredHold({ ...booked.ctx(EXPIRES), bookingId: "f" }));
	return { booked, start, byBooking };
};

const balanced = (event: AtmEvent) => {
	const sums = new Map<string, number>();
	for (const posting of event.postings)
		sums.set(
			posting.commodity,
			(sums.get(posting.commodity) ?? 0) + Number(posting.amount),
		);
	return [...sums.values()].every((sum) => sum === 0);
};

test("every event of a booking carries its booking id in labels.booking, and every label is a string", () => {
	const { byBooking } = everyWay();
	for (const [bookingId, events] of byBooking) {
		expect(events.length).toBeGreaterThan(1);
		for (const event of events) {
			expect(event.labels.booking).toBe(bookingId);
			for (const value of Object.values(event.labels))
				expect(typeof value).toBe("string");
		}
	}
});

test("the events of every way a booking settles are valid, balanced, journal and replay", () => {
	const { booked, start, byBooking } = everyWay();
	const events = [...byBooking.values()].flat();
	for (const event of events) {
		expect(validateEvent(event)).toEqual({ ok: true, errors: [] });
		expect(balanced(event)).toBe(true);
	}
	const replayed = replayEvents({
		events,
		catalog: catalogRows,
		snapshot: {
			states: { [HOLDER]: start as never },
			holds: {},
			lastEventId: null,
		},
	});
	expect(replayed.applied).toBe(events.length);
	expect(replayed.balances.find((b) => b.feature === "visit")?.avail).toBe(
		booked.balance(EXPIRES).avail,
	);
});

test("a release onto a lapsed row replays, with the cron's lapse before it", () => {
	const booked = member({ invoices: [yearlyWithPack()] });
	const start = booked.engine;
	booked.apply(
		holdBooking({
			...booked.ctx(NOW),
			bookingId: "b1",
			featureId: "visit",
			credits: 1,
			startsAt: PAID_AT + 120 * DAY,
			expiresAt: PAID_AT + 121 * DAY,
		}),
	);
	const pack = booked.engine.customerEntitlements.find((row) =>
		row.id.startsWith("ce_once_"),
	) as { expires_at: number };
	const lapses = lapsedRows({
		state: booked.engine,
		featureOf: (id) => (id === "feat_visit" ? "visit" : undefined),
		feature: "visit",
		atMs: pack.expires_at + DAY,
	}).map((row) =>
		lapseEvent({
			row,
			holder: HOLDER,
			key: HOLDER,
			feature: "visit",
			school: "sch_vol",
			tz: "UTC",
			revision: booked.engine.revision,
		}),
	);
	const released = booked.apply(
		releaseBooking({
			...booked.ctx(pack.expires_at + 2 * DAY),
			bookingId: "b1",
		}),
	);
	expect(released.ok).toBe(true);
	const events = [...booked.events, ...lapses];
	for (const event of events)
		expect(validateEvent(event)).toEqual({ ok: true, errors: [] });
	const replayed = replayEvents({
		events,
		catalog: catalogRows,
		snapshot: {
			states: { [HOLDER]: start as never },
			holds: {},
			lastEventId: null,
		},
	});
	expect(replayed.applied).toBe(events.length);
	if (hasHledger)
		expect(checkWithHledger(events)).toEqual({ exitCode: 0, stderr: "" });
});

test.skipIf(!hasHledger)(
	"hledger checks the journal of every way a booking settles",
	() => {
		const { byBooking } = everyWay();
		expect(checkWithHledger([...byBooking.values()].flat())).toEqual({
			exitCode: 0,
			stderr: "",
		});
	},
);
