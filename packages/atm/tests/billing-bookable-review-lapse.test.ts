/**
 * Credits a booking holds on a row that lapses while they are held do not come back on a release: they lapsed with the
 * row. The release books them as `credit.expired`, and the books equal the engine whether the cron's lapse of the row ran
 * before the release or runs after it.
 */
import { expect, test } from "bun:test";
import { holdBooking, releaseBooking } from "../src/billing/bookable.js";
import type { BillingInvoice, Menu } from "../src/billing/types.js";
import { lapsedRows, lapseEvent } from "../src/ledger/postings.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent } from "../src/types.js";
import { reviewWorld } from "./billing-bookable-review-world.js";
import {
	DAY,
	HOLDER,
	load,
	member,
	PAID_AT,
	yearlyWithPack,
} from "./billing-bookable-world.js";

const PACK_ROW = "ce_once_in_y_pack_visit";

const availablePostings = (events: readonly AtmEvent[]) =>
	events
		.flatMap((event) => event.postings)
		.filter((posting) => posting.account === `credits:avail:${HOLDER}:visit`)
		.reduce((sum, posting) => sum + Number(posting.amount), 0);

/** What the cron records with `recordLapse`: one `credit.expired` per lapsed row. */
const cronLapse = (booked: ReturnType<typeof member>, atMs: number) =>
	lapsedRows({
		state: booked.engine,
		featureOf: (id) => (id === "feat_visit" ? "visit" : undefined),
		feature: "visit",
		atMs,
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

/** A yearly tier and a pack that lapses first; one visit held from the pack for a session after the pack lapses. */
const heldFromPack = () => {
	const booked = member({ invoices: [yearlyWithPack()] });
	const start = PAID_AT + DAY;
	const engineStart = booked.balance(start).avail;
	const held = booked.apply(
		holdBooking({
			...booked.ctx(start),
			bookingId: "b1",
			featureId: "visit",
			credits: 1,
			startsAt: PAID_AT + 120 * DAY,
			expiresAt: PAID_AT + 121 * DAY,
		}),
	);
	expect(held.ok).toBe(true);
	const packRow = booked.engine.customerEntitlements.find(
		(row) => row.id === PACK_ROW,
	) as { expires_at: number };
	return { booked, engineStart, packExpiry: packRow.expires_at };
};

/** The outbox keeps one event per idem (the first). */
const outboxOf = () => {
	const kept = new Map<string, AtmEvent>();
	return {
		log(events: readonly AtmEvent[]) {
			for (const event of events)
				if (!kept.has(event.idem)) kept.set(event.idem, event);
		},
		get events() {
			return [...kept.values()];
		},
	};
};

test("the cron lapsed the row before the release: the books equal the engine", () => {
	const { booked, engineStart, packExpiry } = heldFromPack();
	const outbox = outboxOf();
	outbox.log(booked.events);
	outbox.log(cronLapse(booked, packExpiry + DAY));
	const released = booked.apply(
		releaseBooking({ ...booked.ctx(packExpiry + 2 * DAY), bookingId: "b1" }),
	);
	if (!released.ok) throw new Error(released.reason);
	outbox.log(released.events);
	outbox.log(cronLapse(booked, packExpiry + 3 * DAY));
	const at = packExpiry + 3 * DAY;
	expect(engineStart + availablePostings(outbox.events)).toBe(
		booked.balance(at).avail,
	);
});

test("the cron lapses the row after the release: the books equal the engine", () => {
	const { booked, engineStart, packExpiry } = heldFromPack();
	const outbox = outboxOf();
	outbox.log(booked.events);
	const released = booked.apply(
		releaseBooking({ ...booked.ctx(packExpiry + 2 * DAY), bookingId: "b1" }),
	);
	if (!released.ok) throw new Error(released.reason);
	outbox.log(released.events);
	outbox.log(cronLapse(booked, packExpiry + 3 * DAY));
	const at = packExpiry + 3 * DAY;
	expect(engineStart + availablePostings(outbox.events)).toBe(
		booked.balance(at).avail,
	);
});

test("a credit held from a rollover that lapses while held lapses with it", () => {
	const create = load<BillingInvoice>("inv-create-s2");
	const february = load<BillingInvoice>("inv-cycle-s2-feb");
	const world = reviewWorld(load<Menu>("menu"));
	world.invoice(create);
	world.invoice(february);
	const [rolled] = world.rollovers();
	if (!rolled?.expiresAt)
		throw new Error("January's leftovers did not roll over");
	// the rollover lapses soonest, so the hold draws from it
	const held = world.apply(
		holdBooking({
			...world.ctx(february.paidAt + DAY),
			bookingId: "b1",
			featureId: "visit",
			credits: 1,
			startsAt: rolled.expiresAt + 5 * DAY,
			expiresAt: rolled.expiresAt + 6 * DAY,
		}),
	);
	if (!held.ok) throw new Error(held.reason);
	expect(world.rollovers()[0]?.balance).toBe(rolled.balance - 1);
	const released = world.apply(
		releaseBooking({ ...world.ctx(rolled.expiresAt + DAY), bookingId: "b1" }),
	);
	if (!released.ok) throw new Error(released.reason);
	expect(world.rollovers()[0]?.balance).toBe(rolled.balance - 1);
	expect(released.events.map((event) => event.event_type)).toEqual([
		"credit.released",
		"credit.expired",
	]);
	for (const event of released.events)
		expect(validateEvent(event)).toEqual({ ok: true, errors: [] });
});

test("the release books the lapsed credit as credit.expired and does not give it back to the row", () => {
	const { booked, packExpiry } = heldFromPack();
	const before = booked.rowBalances()[PACK_ROW];
	const released = booked.apply(
		releaseBooking({ ...booked.ctx(packExpiry + 2 * DAY), bookingId: "b1" }),
	);
	if (!released.ok) throw new Error(released.reason);
	expect(booked.rowBalances()[PACK_ROW]).toBe(before);
	expect(released.booking.state).toBe("released");
	expect(released.events.map((event) => event.event_type)).toEqual([
		"credit.released",
		"credit.expired",
	]);
	for (const event of released.events)
		expect(validateEvent(event)).toEqual({ ok: true, errors: [] });
});
