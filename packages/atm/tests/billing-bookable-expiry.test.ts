import { describe, expect, test } from "bun:test";
import {
	cancelBooking,
	confirmBooking,
	expiredHolds,
	holdBooking,
	noShowBooking,
	releaseBooking,
	settleExpiredHold,
} from "../src/billing/bookable.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import type { BillingPolicy, BookingResult } from "../src/billing/types.js";
import { replayEvents } from "../src/ledger/replay.js";
import { validateEvent } from "../src/ledger/validate.js";
import {
	catalogRows,
	DAY,
	HOLDER,
	HOUR,
	member,
	PAID_AT,
	typesOf,
} from "./billing-bookable-world.js";

const NOW = PAID_AT + DAY;
const STARTS = PAID_AT + 20 * DAY;
const EXPIRES = STARTS + DAY;

type Member = ReturnType<typeof member>;

const hold = (
	m: Member,
	bookingId: string,
	over: { credits?: number; startsAt?: number; expiresAt?: number } = {},
) =>
	m.apply(
		holdBooking({
			...m.ctx(NOW),
			bookingId,
			featureId: "visit",
			credits: 1,
			startsAt: STARTS,
			expiresAt: EXPIRES,
			...over,
		}),
	);

const call = (
	fn: typeof confirmBooking,
	m: Member,
	bookingId: string,
	now: number,
) => m.apply(fn({ ...m.ctx(now), bookingId }));

const ok = <T extends BookingResult>(result: T): Extract<T, { ok: true }> => {
	if (!result.ok) throw new Error(`refused: ${result.reason}`);
	return result as Extract<T, { ok: true }>;
};

const noShowReleases: BillingPolicy = { ...DEFAULT_POLICY, noShow: "release" };

describe("expiredHolds", () => {
	test("lists the held bookings whose expiry has passed, soonest first, ties by id", () => {
		const m = member({ invoices: ["inv-create-s2-year"] });
		ok(hold(m, "late", { expiresAt: STARTS + 3 * DAY }));
		ok(hold(m, "b", { expiresAt: STARTS + DAY }));
		ok(hold(m, "a", { expiresAt: STARTS + DAY }));
		ok(hold(m, "soon", { startsAt: NOW, expiresAt: NOW + HOUR }));
		expect(expiredHolds({ rows: m.rows, now: NOW })).toEqual([]);
		expect(expiredHolds({ rows: m.rows, now: NOW + HOUR })).toEqual([
			{
				bookingId: "soon",
				expiresAt: NOW + HOUR,
				expiryAction: "confirm",
				featureId: "visit",
				credits: 1,
			},
		]);
		expect(
			expiredHolds({ rows: m.rows, now: STARTS + DAY }).map((h) => h.bookingId),
		).toEqual(["soon", "a", "b"]);
		expect(
			expiredHolds({ rows: m.rows, now: STARTS + 9 * DAY }).map(
				(h) => h.bookingId,
			),
		).toEqual(["soon", "a", "b", "late"]);
	});

	test("leaves out what was settled, and says each hold's own action", () => {
		const m = member({ invoices: ["inv-create-s2-year"] });
		ok(hold(m, "spent"));
		ok(hold(m, "given"));
		ok(hold(m, "open"));
		ok(call(confirmBooking, m, "spent", STARTS));
		ok(call(releaseBooking, m, "given", STARTS));
		expect(
			expiredHolds({ rows: m.rows, now: EXPIRES }).map((h) => h.bookingId),
		).toEqual(["open"]);
		const kind = member({ policy: noShowReleases });
		ok(hold(kind, "open"));
		expect(expiredHolds({ rows: kind.rows, now: EXPIRES })[0]).toMatchObject({
			expiryAction: "release",
		});
	});

	test("a state that never booked has none", () => {
		const m = member();
		expect(expiredHolds({ rows: m.rows, now: EXPIRES })).toEqual([]);
		expect(expiredHolds({ rows: [], now: EXPIRES })).toEqual([]);
	});
});

describe("settleExpiredHold", () => {
	test("a confirm hold keeps its credits spent: the lock goes, the balance does not move", () => {
		const m = member();
		ok(hold(m, "b1"));
		const balances = JSON.stringify(m.rowBalances());
		const result = ok(call(settleExpiredHold, m, "b1", EXPIRES));
		expect(result.booking).toMatchObject({
			state: "spent",
			settledBy: "expiry",
			settledAt: EXPIRES,
		});
		expect(result.booking).not.toHaveProperty("lock");
		expect(JSON.stringify(m.rowBalances())).toBe(balances);
		expect(m.engine.openLocks).toEqual([]);
		expect(m.balance(EXPIRES)).toEqual({ avail: 1, held: 0 });
		expect(typesOf(result.events)).toEqual(["credit.forfeited"]);
		expect(result.events[0]?.payload).toMatchObject({
			held: 1,
			command: { type: "confirmExpiredLock", commandId: "bk:b1:expiry" },
		});
		expect(result.events[0]?.labels.booking).toBe("b1");
		expect(validateEvent(result.events[0] as never)).toEqual({
			ok: true,
			errors: [],
		});
		expect(expiredHolds({ rows: m.rows, now: EXPIRES })).toEqual([]);
	});

	test("a release hold gives its credits back", () => {
		const m = member({ policy: noShowReleases });
		ok(hold(m, "b1", { credits: 2 }));
		expect(m.balance(NOW)).toEqual({ avail: 0, held: 2 });
		const result = ok(call(settleExpiredHold, m, "b1", EXPIRES));
		expect(result.booking).toMatchObject({
			state: "released",
			settledBy: "expiry",
		});
		expect(typesOf(result.events)).toEqual(["credit.released"]);
		expect(m.balance(EXPIRES)).toEqual({ avail: 2, held: 0 });
		expect(m.engine.openLocks).toEqual([]);
	});

	test("a hold that has not lapsed is not settled by the sweep", () => {
		const m = member();
		ok(hold(m, "b1"));
		const rows = JSON.stringify(m.rows);
		expect(call(settleExpiredHold, m, "b1", EXPIRES - 1)).toMatchObject({
			ok: false,
			reason: "bad_input",
		});
		expect(JSON.stringify(m.rows)).toBe(rows);
	});

	test("an unknown booking is no_hold, a settled one is a no-op, one settled the other way is already_settled", () => {
		const m = member();
		expect(call(settleExpiredHold, m, "ghost", EXPIRES)).toMatchObject({
			ok: false,
			reason: "no_hold",
		});
		ok(hold(m, "b1"));
		ok(call(settleExpiredHold, m, "b1", EXPIRES));
		expect(ok(call(settleExpiredHold, m, "b1", EXPIRES + DAY))).toMatchObject({
			rowChanges: null,
			events: [],
		});
		const given = member();
		ok(hold(given, "b1"));
		ok(call(releaseBooking, given, "b1", STARTS));
		expect(call(settleExpiredHold, given, "b1", EXPIRES)).toMatchObject({
			ok: false,
			reason: "already_settled",
		});
	});
});

describe("a call on a hold whose expiry has passed", () => {
	const late = EXPIRES + HOUR;

	test("on a confirm hold: what the expiry would do still works, the opposite is hold_expired", () => {
		const spend = member();
		ok(hold(spend, "b1"));
		expect(call(releaseBooking, spend, "b1", late)).toMatchObject({
			ok: false,
			reason: "hold_expired",
		});
		expect(call(releaseBooking, spend, "b1", late)).toMatchObject({
			message: expect.stringContaining("settleExpiredHold"),
		});
		// a cancel after the session started (the hold lapses after the start) is refused whatever the policy
		const mixed = member({
			policy: { ...DEFAULT_POLICY, lateCancel: "release" },
		});
		ok(hold(mixed, "b1"));
		expect(call(cancelBooking, mixed, "b1", late)).toMatchObject({
			reason: "session_started",
		});
		expect(mixed.engine.openLocks).toHaveLength(1);
		expect(call(confirmBooking, spend, "b1", late)).toMatchObject({
			ok: true,
			booking: { state: "spent", settledBy: "confirm" },
		});

		const cancelled = member();
		ok(hold(cancelled, "b1"));
		expect(call(cancelBooking, cancelled, "b1", late)).toMatchObject({
			ok: false,
			reason: "session_started",
		});
		expect(cancelled.engine.openLocks).toHaveLength(1);
		const noShow = member();
		ok(hold(noShow, "b1"));
		expect(call(noShowBooking, noShow, "b1", late)).toMatchObject({
			ok: true,
			booking: { state: "spent", settledBy: "no_show" },
		});
	});

	test("on a release hold: a release works, a spend is hold_expired", () => {
		const m = member({ policy: noShowReleases });
		ok(hold(m, "b1"));
		expect(call(confirmBooking, m, "b1", late)).toMatchObject({
			ok: false,
			reason: "hold_expired",
		});
		expect(m.balance(late)).toEqual({ avail: 1, held: 1 });
		expect(call(releaseBooking, m, "b1", late)).toMatchObject({
			ok: true,
			booking: { state: "released", settledBy: "release" },
		});
		expect(m.balance(late)).toEqual({ avail: 2, held: 0 });
		expect(m.engine.openLocks).toEqual([]);
	});

	test("before the expiry nothing is restricted", () => {
		const m = member();
		ok(hold(m, "b1"));
		expect(call(releaseBooking, m, "b1", EXPIRES - 1)).toMatchObject({
			ok: true,
		});
	});
});

describe("the events replay", () => {
	test("hold, spend, forfeit and release rebuild the balances and each recorded event is the one its mutation derives", () => {
		const m = member({ invoices: ["inv-create-s2-pack"] });
		const start = m.engine;
		ok(hold(m, "a", { credits: 1 }));
		ok(hold(m, "b", { credits: 1 }));
		ok(hold(m, "c", { credits: 1 }));
		ok(hold(m, "d", { credits: 1 }));
		ok(call(confirmBooking, m, "a", NOW + HOUR));
		ok(call(noShowBooking, m, "b", NOW + 2 * HOUR));
		ok(call(releaseBooking, m, "c", NOW + 3 * HOUR));
		ok(call(settleExpiredHold, m, "d", EXPIRES));
		expect(typesOf(m.events)).toEqual([
			"credit.held",
			"credit.held",
			"credit.low",
			"credit.held",
			"credit.held",
			"credit.depleted",
			"credit.spent",
			"credit.forfeited",
			"credit.released",
			"credit.forfeited",
		]);
		const replayed = replayEvents({
			events: m.events,
			catalog: catalogRows,
			snapshot: {
				states: { [HOLDER]: start as never },
				holds: {},
				lastEventId: null,
			},
		});
		const found = replayed.balances.find((b) => b.feature === "visit");
		expect(found?.avail).toBe(m.balance(EXPIRES).avail);
		expect(found?.held).toBe(0);
		expect(m.balance(EXPIRES)).toEqual({ avail: 1, held: 0 });
	});

	test("a forged alert is refused by the replay", () => {
		const m = member();
		const start = m.engine;
		ok(hold(m, "a", { credits: 2 }));
		const forged = m.events.map((e) =>
			e.event_type === "credit.depleted"
				? { ...e, payload: { ...e.payload, available: 1 } }
				: e,
		);
		expect(typesOf(forged)).toContain("credit.depleted");
		expect(() =>
			replayEvents({
				events: forged,
				catalog: catalogRows,
				snapshot: {
					states: { [HOLDER]: start as never },
					holds: {},
					lastEventId: null,
				},
			}),
		).toThrow(/differs from the one the mutation derives/);
	});
});
