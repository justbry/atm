import { describe, expect, test } from "bun:test";
import {
	cancelBooking,
	confirmBooking,
	holdBooking,
	noShowBooking,
	releaseBooking,
} from "../src/billing/bookable.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { grantsFromRows, StaleRevision } from "../src/billing/rows.js";
import type {
	BillingPolicy,
	BookingResult,
	HoldBookingInput,
} from "../src/billing/types.js";
import { validateEvent } from "../src/ledger/validate.js";
import {
	DAY,
	HOLDER,
	HOUR,
	member,
	PAID_AT,
	typesOf,
	yearlyWithPack,
} from "./billing-bookable-world.js";

const NOW = PAID_AT + DAY;
const STARTS = PAID_AT + 20 * DAY;
const EXPIRES = STARTS + DAY;
const TIER = "ce_tier_visit_month";
const PACK = "ce_once_in_p_pack_visit";
const YEAR_TIER = "ce_tier_visit_year";
const YEAR_PACK = "ce_once_in_y_pack_visit";

type Member = ReturnType<typeof member>;

const hold = (
	m: Member,
	over: Partial<HoldBookingInput> = {},
	now = NOW,
): BookingResult =>
	m.apply(
		holdBooking({
			...m.ctx(now),
			bookingId: "b1",
			featureId: "visit",
			credits: 1,
			startsAt: STARTS,
			expiresAt: EXPIRES,
			...over,
		}),
	);

const settle = (
	fn: typeof confirmBooking,
	m: Member,
	now: number,
	bookingId = "b1",
) => m.apply(fn({ ...m.ctx(now), bookingId }));

const ok = <T extends BookingResult>(result: T): Extract<T, { ok: true }> => {
	if (!result.ok) throw new Error(`refused: ${result.reason}`);
	return result as Extract<T, { ok: true }>;
};

const policyWith = (over: Partial<BillingPolicy>): BillingPolicy => ({
	...DEFAULT_POLICY,
	...over,
});

describe("hold", () => {
	test("takes the credits out of what can be spent and keeps them held", () => {
		const m = member();
		expect(m.balance(NOW)).toEqual({ avail: 2, held: 0 });
		const before = m.revision;
		const result = ok(hold(m));
		expect(m.balance(NOW)).toEqual({ avail: 1, held: 1 });
		expect(result.rowChanges).toMatchObject({
			subjectKey: `sch_vol|live|${HOLDER}`,
			expectedRevision: before,
			nextRevision: before + 1,
		});
		expect(m.revision).toBe(before + 1);
		expect(m.rowBalances()[TIER]).toBe(1);
		// the engine's rows keep the lock's ids; atm keeps the whole row
		expect(m.engine.openLocks.map((l) => l.id)).toEqual(["lock_b1"]);
		expect(result.booking).toMatchObject({
			state: "held",
			cost: { kind: "credits", featureId: "visit", credits: 1 },
			startsAt: STARTS,
			expiresAt: EXPIRES,
			expiryAction: "confirm",
			heldAt: NOW,
		});
		expect(result.booking.lock).toMatchObject({
			id: "lock_b1",
			lock_id: "bk_b1",
			feature_id: "visit",
			overage_behavior: "reject",
			expires_at: EXPIRES,
			expiry_action: "confirm",
		});
		expect(m.grants.bookings).toEqual({ b1: result.booking });
	});

	test("makes a credit.held event with its postings, labels and ids from the booking", () => {
		const m = member();
		const { events } = ok(hold(m));
		expect(typesOf(events)).toEqual(["credit.held"]);
		const [held] = events;
		expect(held?.labels).toMatchObject({
			feature: "visit",
			booking: "b1",
			menu_version: "1",
			policy_version: "1",
			mapping: "atm/booking",
		});
		expect(held?.idem).toBe("engine:bk:b1:hold:held");
		expect(held?.postings.map((p) => [p.account, p.amount])).toEqual([
			[`credits:avail:${HOLDER}:visit`, "-1"],
			[`credits:held:${HOLDER}:visit`, "1"],
		]);
		expect(held?.payload).toMatchObject({
			complete: true,
			command: {
				type: "track",
				commandId: "bk:b1:hold",
				requestId: "bk:b1:hold",
				overageBehavior: "reject",
				enforceOverdueBlock: true,
				value: 1,
				lock: { id: "lock_b1", lockId: "bk_b1", expiryAction: "confirm" },
			},
		});
		for (const event of events)
			expect(validateEvent(event)).toEqual({ ok: true, errors: [] });
	});

	test("the lock lapses as a release when a no-show does not spend", () => {
		const m = member({ policy: policyWith({ noShow: "release" }) });
		expect(ok(hold(m)).booking.expiryAction).toBe("release");
		expect(m.engine.openLocks).toHaveLength(1);
		expect(ok(hold(member())).booking.expiryAction).toBe("confirm");
	});

	test("two holds cannot both take the last credit", () => {
		const m = member();
		ok(hold(m, { bookingId: "a", credits: 1 }));
		const second = hold(m, { bookingId: "b", credits: 2 });
		expect(second).toMatchObject({ ok: false, reason: "insufficient_credits" });
		expect(m.balance(NOW)).toEqual({ avail: 1, held: 1 });
		ok(hold(m, { bookingId: "c", credits: 1 }));
		expect(hold(m, { bookingId: "d", credits: 1 })).toMatchObject({
			ok: false,
			reason: "insufficient_credits",
		});
		expect(m.balance(NOW)).toEqual({ avail: 0, held: 2 });
	});

	test("two holds computed from the same rows cannot both be written: the second is stale", () => {
		const m = member();
		const input = (bookingId: string) => ({
			...m.ctx(NOW),
			bookingId,
			featureId: "visit",
			credits: 2,
			startsAt: STARTS,
			expiresAt: EXPIRES,
		});
		const first = ok(holdBooking(input("a")));
		const second = ok(holdBooking(input("b")));
		m.apply(first);
		expect(() => m.apply(second)).toThrow(StaleRevision);
	});

	test("draws the row that lapses first, and a release gives back to the rows it came from", () => {
		// the tier row resets 2026-02-15, the pack row lapses 2026-04-15
		const m = member({ invoices: ["inv-create-s2-pack"] });
		expect(m.rowBalances()).toEqual({ [TIER]: 2, [PACK]: 2 });
		const original = JSON.stringify(m.engine.customerEntitlements);
		ok(hold(m, { credits: 3 }));
		expect(m.rowBalances()).toEqual({ [TIER]: 0, [PACK]: 1 });
		ok(settle(releaseBooking, m, NOW + DAY));
		expect(m.rowBalances()).toEqual({ [TIER]: 2, [PACK]: 2 });
		expect(JSON.stringify(m.engine.customerEntitlements)).toBe(original);
		expect(m.balance(NOW + DAY)).toEqual({ avail: 4, held: 0 });
	});

	test("expiry order beats creation order: a pack that lapses before the yearly row is drawn first", () => {
		const yearly = () => member({ invoices: [yearlyWithPack()] });
		const m = yearly();
		expect(m.rowBalances()).toEqual({ [YEAR_TIER]: 24, [YEAR_PACK]: 2 });
		const events = ok(hold(m, { credits: 3 })).events;
		expect(m.rowBalances()).toEqual({ [YEAR_TIER]: 23, [YEAR_PACK]: 0 });
		// one hold across two rows is one event for the feature
		expect(typesOf(events)).toEqual(["credit.held"]);
		ok(settle(releaseBooking, m, NOW + DAY));
		expect(m.rowBalances()).toEqual({ [YEAR_TIER]: 24, [YEAR_PACK]: 2 });

		// the engine's own order draws the refilling row first
		const engineOrder = member({
			invoices: [yearlyWithPack()],
			policy: policyWith({ deductionOrder: "engine" }),
		});
		ok(hold(engineOrder, { credits: 3 }));
		expect(engineOrder.rowBalances()).toEqual({
			[YEAR_TIER]: 21,
			[YEAR_PACK]: 2,
		});
	});

	test("refuses a feature the holder has no credits of, and a holder with no subject", () => {
		const m = member();
		expect(hold(m, { featureId: "retreat" })).toMatchObject({
			ok: false,
			reason: "feature_not_in_plan",
		});
		expect(
			holdBooking({
				...m.ctx(NOW, { rows: [], revision: 0 }),
				bookingId: "b1",
				featureId: "visit",
				credits: 1,
				startsAt: STARTS,
				expiresAt: EXPIRES,
			}),
		).toMatchObject({ ok: false, reason: "not_a_member" });
		// nothing was written
		expect(m.grants.bookings).toBeUndefined();
		expect(m.balance(NOW)).toEqual({ avail: 2, held: 0 });
	});

	test("refuses input it cannot use", () => {
		const m = member();
		const bad = (over: Partial<HoldBookingInput>) =>
			hold(m, over, NOW) as { ok: false; reason: string };
		for (const over of [
			{ credits: 0 },
			{ credits: -1 },
			{ credits: 1.5 },
			{ credits: Number.NaN },
			{ startsAt: Number.NaN },
			{ expiresAt: Number.POSITIVE_INFINITY },
			{ expiresAt: NOW },
			{ expiresAt: NOW - 1 },
			{ startsAt: EXPIRES + 1 },
			{ featureId: "nope" },
			{ bookingId: "" },
		])
			expect(bad(over)).toMatchObject({ ok: false, reason: "bad_input" });
		expect(m.revision).toBe(member().revision);
		expect(m.grants.bookings).toBeUndefined();
	});
});

describe("confirm, release, cancel and no-show", () => {
	test("confirm spends: the credits stay out, the lock closes, the record says spent", () => {
		const m = member();
		ok(hold(m));
		const result = ok(settle(confirmBooking, m, STARTS + HOUR));
		expect(result.booking).toMatchObject({
			state: "spent",
			settledAt: STARTS + HOUR,
			settledBy: "confirm",
		});
		expect(result.booking).not.toHaveProperty("lock");
		expect(m.engine.openLocks).toEqual([]);
		expect(m.rowBalances()[TIER]).toBe(1);
		expect(m.balance(STARTS + HOUR)).toEqual({ avail: 1, held: 0 });
		expect(typesOf(result.events)).toEqual(["credit.spent"]);
		const [spent] = result.events;
		expect(spent?.postings.map((p) => [p.account, p.amount])).toEqual([
			[`credits:held:${HOLDER}:visit`, "-1"],
			["credits:spent:booking", "1"],
		]);
		expect(spent?.payload).toMatchObject({
			command: {
				type: "finalize",
				finalValue: null,
				commandId: "bk:b1:confirm",
			},
		});
		expect(validateEvent(spent as never)).toEqual({ ok: true, errors: [] });
	});

	test("release gives the credits back and closes the lock", () => {
		const m = member();
		ok(hold(m));
		const result = ok(settle(releaseBooking, m, NOW + HOUR));
		expect(result.booking).toMatchObject({
			state: "released",
			settledBy: "release",
			settledAt: NOW + HOUR,
		});
		expect(result.booking).not.toHaveProperty("lock");
		expect(typesOf(result.events)).toEqual(["credit.released"]);
		expect(m.rowBalances()[TIER]).toBe(2);
		expect(m.engine.openLocks).toEqual([]);
		expect(m.balance(NOW + HOUR)).toEqual({ avail: 2, held: 0 });
	});

	test("a cancel up to the cutoff releases, whatever the policy says about late ones", () => {
		for (const lateCancel of ["spend", "release"] as const) {
			const m = member({ policy: policyWith({ lateCancel }) });
			ok(hold(m));
			// exactly 24 hours before the start is still before the cutoff
			const result = ok(settle(cancelBooking, m, STARTS - 24 * HOUR));
			expect(result.late).toBe(false);
			expect(result.booking).toMatchObject({
				state: "released",
				settledBy: "cancel",
			});
			expect(typesOf(result.events)).toEqual(["credit.released"]);
			expect(m.balance(STARTS)).toEqual({ avail: 2, held: 0 });
		}
	});

	test("a cancel after the cutoff does what policy.lateCancel says", () => {
		const spend = member();
		ok(hold(spend));
		const spent = ok(settle(cancelBooking, spend, STARTS - 24 * HOUR + 1));
		expect(spent.late).toBe(true);
		expect(spent.booking).toMatchObject({
			state: "spent",
			settledBy: "late_cancel",
		});
		expect(typesOf(spent.events)).toEqual(["credit.forfeited"]);
		expect(spend.balance(STARTS)).toEqual({ avail: 1, held: 0 });
		expect(spend.engine.openLocks).toEqual([]);

		const release = member({ policy: policyWith({ lateCancel: "release" }) });
		ok(hold(release));
		const released = ok(settle(cancelBooking, release, STARTS - HOUR));
		expect(released.late).toBe(true);
		expect(released.booking).toMatchObject({
			state: "released",
			settledBy: "late_cancel",
		});
		expect(typesOf(released.events)).toEqual(["credit.released"]);
		expect(release.balance(STARTS)).toEqual({ avail: 2, held: 0 });
	});

	test("the cutoff counts back policy.cancelCutoffHours from the start", () => {
		const m = member({ policy: policyWith({ cancelCutoffHours: 48 }) });
		ok(hold(m));
		const late = ok(settle(cancelBooking, m, STARTS - 47 * HOUR));
		expect(late.late).toBe(true);
		const none = member({ policy: policyWith({ cancelCutoffHours: 0 }) });
		ok(hold(none));
		expect(ok(settle(cancelBooking, none, STARTS - 1)).late).toBe(false);
	});

	test("a policy stored before the booking fields existed gets the defaults", () => {
		const old = { ...DEFAULT_POLICY } as Partial<BillingPolicy>;
		delete old.cancelCutoffHours;
		delete old.noShow;
		delete old.lateCancel;
		const m = member({ policy: old as BillingPolicy });
		expect(ok(hold(m)).booking.expiryAction).toBe("confirm");
		expect(
			ok(settle(cancelBooking, m, STARTS - 24 * HOUR + 1)).booking,
		).toMatchObject({
			settledBy: "late_cancel",
			state: "spent",
		});
	});

	test("a no-show spends under the default policy and releases when the policy says so", () => {
		const m = member();
		ok(hold(m));
		const result = ok(settle(noShowBooking, m, STARTS + HOUR));
		expect(result.booking).toMatchObject({
			state: "spent",
			settledBy: "no_show",
		});
		expect(typesOf(result.events)).toEqual(["credit.forfeited"]);
		expect(m.balance(STARTS + HOUR)).toEqual({ avail: 1, held: 0 });

		const kind = member({ policy: policyWith({ noShow: "release" }) });
		ok(hold(kind));
		const released = ok(settle(noShowBooking, kind, STARTS + HOUR));
		expect(released.booking).toMatchObject({
			state: "released",
			settledBy: "no_show",
		});
		expect(typesOf(released.events)).toEqual(["credit.released"]);
		expect(kind.balance(STARTS + HOUR)).toEqual({ avail: 2, held: 0 });
	});

	test("a booking held across two rows spends both and gives both back", () => {
		const m = member({ invoices: ["inv-create-s2-pack"] });
		ok(hold(m, { credits: 3 }));
		ok(settle(confirmBooking, m, STARTS + HOUR));
		expect(m.rowBalances()).toEqual({ [TIER]: 0, [PACK]: 1 });
		expect(m.balance(STARTS + HOUR)).toEqual({ avail: 1, held: 0 });
	});
});

describe("credit.low and credit.depleted", () => {
	test("a hold that takes the balance to the threshold is credit.low", () => {
		const m = member({ policy: policyWith({ lowCreditThreshold: 1 }) });
		const first = ok(hold(m));
		expect(typesOf(first.events)).toEqual(["credit.held", "credit.low"]);
		expect(first.events[1]).toMatchObject({
			postings: [],
			payload: {
				feature: "visit",
				available: 1,
				previous_available: 2,
				threshold: 1,
			},
		});
		const second = ok(hold(m, { bookingId: "b2" }));
		expect(typesOf(second.events)).toEqual(["credit.held", "credit.depleted"]);
		expect(second.events[1]?.payload).toMatchObject({
			available: 0,
			previous_available: 1,
		});
		for (const event of [...first.events, ...second.events])
			expect(validateEvent(event)).toEqual({ ok: true, errors: [] });
	});

	test("the default threshold of 2 alerts a hold from 3 to 2, and running out is depleted", () => {
		const m = member({ invoices: ["inv-create-s2-pack"] });
		expect(m.balance(NOW).avail).toBe(4);
		expect(typesOf(ok(hold(m, { bookingId: "a", credits: 2 })).events)).toEqual(
			["credit.held", "credit.low"],
		);
		expect(typesOf(ok(hold(m, { bookingId: "b", credits: 2 })).events)).toEqual(
			["credit.held", "credit.depleted"],
		);
	});

	test("a release or a spend of what is already held alerts nothing more", () => {
		const m = member({ policy: policyWith({ lowCreditThreshold: 1 }) });
		ok(hold(m));
		expect(typesOf(ok(settle(confirmBooking, m, STARTS)).events)).toEqual([
			"credit.spent",
		]);
		const kind = member();
		ok(hold(kind, { credits: 2 }));
		expect(
			typesOf(ok(settle(releaseBooking, kind, NOW + HOUR)).events),
		).toEqual(["credit.released"]);
	});

	test("a threshold of 0 makes no credit.low but running out is still depleted", () => {
		const m = member({ policy: policyWith({ lowCreditThreshold: 0 }) });
		expect(typesOf(ok(hold(m)).events)).toEqual(["credit.held"]);
		expect(typesOf(ok(hold(m, { bookingId: "b2" })).events)).toEqual([
			"credit.held",
			"credit.depleted",
		]);
	});
});

describe("replays and refusals", () => {
	test("the same hold twice is a replay: ok, nothing to write, the same booking", () => {
		const m = member();
		const first = ok(hold(m));
		const again = ok(hold(m, {}, NOW + HOUR));
		expect(again.rowChanges).toBeNull();
		expect(again.events).toEqual([]);
		expect(again.booking).toEqual(first.booking);
		expect(m.balance(NOW)).toEqual({ avail: 1, held: 1 });
		// even after the hold's own expiry has passed
		expect(ok(hold(m, {}, EXPIRES + DAY)).rowChanges).toBeNull();
	});

	test("the same hold after it was settled is still a replay", () => {
		const m = member();
		ok(hold(m));
		ok(settle(confirmBooking, m, STARTS));
		const again = ok(hold(m, {}, STARTS + HOUR));
		expect(again.rowChanges).toBeNull();
		expect(again.booking.state).toBe("spent");
	});

	test("the same booking id with other fields is booking_conflict", () => {
		const m = member();
		ok(hold(m));
		for (const over of [
			{ credits: 2 },
			{ startsAt: STARTS + 1 },
			{ expiresAt: EXPIRES + 1 },
			{ featureId: "retreat" },
		])
			expect(hold(m, over)).toMatchObject({
				ok: false,
				reason: "booking_conflict",
			});
		expect(m.balance(NOW)).toEqual({ avail: 1, held: 1 });
	});

	test("a settle of the same kind twice is a no-op; the opposite is already_settled", () => {
		const m = member();
		ok(hold(m));
		ok(settle(confirmBooking, m, STARTS));
		const rows = JSON.stringify(m.rows);
		for (const fn of [confirmBooking, noShowBooking]) {
			const again = ok(settle(fn, m, STARTS + HOUR));
			expect(again).toMatchObject({ rowChanges: null, events: [] });
			expect(again.booking.state).toBe("spent");
		}
		expect(settle(releaseBooking, m, STARTS + HOUR)).toMatchObject({
			ok: false,
			reason: "already_settled",
		});
		expect(settle(cancelBooking, m, STARTS - 48 * HOUR)).toMatchObject({
			ok: false,
			reason: "already_settled",
		});
		expect(JSON.stringify(m.rows)).toBe(rows);

		const released = member();
		ok(hold(released));
		ok(settle(releaseBooking, released, NOW + HOUR));
		expect(
			ok(settle(releaseBooking, released, NOW + 2 * HOUR)).rowChanges,
		).toBeNull();
		expect(ok(settle(cancelBooking, released, NOW + 2 * HOUR))).toMatchObject({
			rowChanges: null,
			late: false,
		});
		expect(settle(confirmBooking, released, NOW + 2 * HOUR)).toMatchObject({
			ok: false,
			reason: "already_settled",
		});
		expect(settle(noShowBooking, released, NOW + 2 * HOUR)).toMatchObject({
			ok: false,
			reason: "already_settled",
		});
	});

	test("a late cancel replayed, even at another time, answers the same", () => {
		const m = member();
		ok(hold(m));
		ok(settle(cancelBooking, m, STARTS - HOUR));
		expect(ok(settle(cancelBooking, m, STARTS + DAY))).toMatchObject({
			rowChanges: null,
			late: true,
			booking: { state: "spent", settledBy: "late_cancel" },
		});
	});

	test("a booking nothing is held for is no_hold, in every command", () => {
		const m = member();
		for (const fn of [
			confirmBooking,
			releaseBooking,
			cancelBooking,
			noShowBooking,
		])
			expect(settle(fn, m, NOW, "ghost")).toMatchObject({
				ok: false,
				reason: "no_hold",
			});
		ok(hold(m));
		expect(settle(confirmBooking, m, NOW, "ghost")).toMatchObject({
			reason: "no_hold",
		});
		expect(
			confirmBooking({
				...m.ctx(NOW, { rows: [], revision: 0 }),
				bookingId: "b1",
			}),
		).toMatchObject({ reason: "no_hold" });
	});

	test("a booking that is not a credits booking is not_credits", () => {
		const m = member();
		const state = m.grants;
		const rows = m.rows.map((row) =>
			row.table === "atm_grants"
				? {
						...row,
						data: {
							...state,
							bookings: {
								paid: {
									state: "paid",
									cost: { kind: "price", amount: 4500, currency: "usd" },
									startsAt: STARTS,
									expiresAt: null,
								},
							},
						},
					}
				: row,
		);
		expect(
			confirmBooking({
				...m.ctx(NOW, { rows: rows as never }),
				bookingId: "paid",
			}),
		).toMatchObject({ ok: false, reason: "not_credits" });
		// a hold under a paid booking's id is a conflict, not a second booking
		expect(
			holdBooking({
				...m.ctx(NOW, { rows: rows as never }),
				bookingId: "paid",
				featureId: "visit",
				credits: 1,
				startsAt: STARTS,
				expiresAt: EXPIRES,
			}),
		).toMatchObject({ ok: false, reason: "booking_conflict" });
	});

	test("rows that disagree with the booking record are refused, not thrown", () => {
		const m = member();
		ok(hold(m));
		// the engine's lock row is gone but the record still says held
		const rows = m.rows.filter((row) => row.table !== "openLocks");
		expect(
			releaseBooking({ ...m.ctx(NOW, { rows }), bookingId: "b1" }),
		).toMatchObject({ ok: false, reason: "no_hold" });
	});
});

describe("ids and the stored state", () => {
	test("the same input gives the same output, byte for byte", () => {
		const run = () => {
			const m = member({ invoices: ["inv-create-s2-pack"] });
			const hold1 = hold(m, { credits: 3 });
			const settled = settle(cancelBooking, m, STARTS - HOUR);
			return JSON.stringify([hold1, settled, m.rows, m.events]);
		};
		expect(run()).toBe(run());
		const m = member();
		const input = {
			...m.ctx(NOW),
			bookingId: "b1",
			featureId: "visit",
			credits: 1,
			startsAt: STARTS,
			expiresAt: EXPIRES,
		};
		const before = JSON.stringify(input);
		expect(JSON.stringify(holdBooking(input))).toBe(
			JSON.stringify(holdBooking(input)),
		);
		// the input's rows are not changed by the call
		expect(JSON.stringify(input)).toBe(before);
	});

	test("every id comes from the booking id, and two bookings do not share one", () => {
		const m = member({ invoices: ["inv-create-s2-pack"] });
		const a = ok(hold(m, { bookingId: "a" }));
		const b = ok(hold(m, { bookingId: "b" }));
		const ids = [...a.events, ...b.events].flatMap((e) => [e.id, e.idem]);
		expect(new Set(ids).size).toBe(ids.length);
		expect(a.events[0]?.idem).toContain("bk:a:hold");
		expect(b.events[0]?.idem).toContain("bk:b:hold");
		expect(Object.keys(m.grants.bookings ?? {})).toEqual(["a", "b"]);
	});

	test("a state that never books keeps no bookings key, and nothing refused writes a row", () => {
		const m = member();
		const before = JSON.stringify(m.rows);
		expect(Object.hasOwn(m.grants, "bookings")).toBe(false);
		hold(m, { credits: 9 });
		hold(m, { featureId: "retreat" });
		hold(m, { credits: 0 });
		settle(confirmBooking, m, NOW, "ghost");
		expect(JSON.stringify(m.rows)).toBe(before);
		expect(Object.hasOwn(grantsFromRows(m.rows), "bookings")).toBe(false);
	});

	test("a hold writes the engine's rows and the grants row, and nothing else, under one revision", () => {
		const m = member();
		const result = ok(hold(m));
		expect(result.rowChanges?.upserts.map((r) => r.table).sort()).toEqual([
			"atm_grants",
			"customerEntitlements",
			"openLocks",
		]);
		expect(result.rowChanges?.deletes).toEqual([]);
		const settled = ok(settle(confirmBooking, m, STARTS));
		expect(settled.rowChanges?.deletes).toEqual([
			{ table: "openLocks", id: "lock_b1" },
		]);
		expect(settled.rowChanges?.upserts.map((r) => r.table)).toEqual([
			"atm_grants",
		]);
		expect(settled.rowChanges?.nextRevision).toBe(m.revision);
	});
});
