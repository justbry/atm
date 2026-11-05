/**
 * A full refund (or a lost dispute) takes back what the invoice granted, also the credits a booking holds: those are not in
 * the balance when the refund runs, so the invoice remembers them and the release that frees them takes them back. A
 * confirm keeps them spent (they were used).
 */
import { expect, test } from "bun:test";
import {
	confirmBooking,
	holdBooking,
	releaseBooking,
} from "../src/billing/bookable.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { applyRowChanges, grantsFromRows } from "../src/billing/rows.js";
import { deterministicUlid } from "../src/ledger/ids.js";
import { replayEvents } from "../src/ledger/replay.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent } from "../src/types.js";
import { checkWithHledger } from "./billing-bookable-review-world.js";
import {
	catalogRows,
	DAY,
	HOLDER,
	load,
	member,
	menu,
	PAID_AT,
} from "./billing-bookable-world.js";
import { hasHledger } from "./helpers.js";
import { chargeRefunded } from "./stripe-events.js";

const NOW = PAID_AT + DAY;
const STARTS = PAID_AT + 20 * DAY;
const EXPIRES = STARTS + DAY;

type Member = ReturnType<typeof member>;

/**
 * A full refund of the pack invoice `in_p`, handled as the caller does. Its events join the member's; returns the rows and
 * revision written (the member's own `apply` takes booking results only, so the test goes on from these).
 */
const refundInFull = (booked: Member, at: number) => {
	const invoiceId = "in_p";
	const { amountPaid } = load<{ amountPaid: number }>("inv-create-s2-pack");
	const event = chargeRefunded({
		eventId: `evt_re_${invoiceId}`,
		chargeId: `ch_${invoiceId}`,
		invoiceId,
		amount: amountPaid,
		chargeAmount: amountPaid,
		at,
	});
	const result = handleStripeEvent({
		event,
		eventId: deterministicUlid({ timeMs: at, revision: 0, seed: event.id }),
		menu,
		menuVersion: 1,
		policy: DEFAULT_POLICY,
		policyVersion: 1,
		rows: booked.rows,
		revision: booked.revision,
		catalog: catalogRows,
		now: at,
		priceIds: {},
		invoiceIds: { [`pi_${invoiceId}`]: invoiceId },
	});
	if (result.refused) throw new Error(result.refused.message);
	if (!result.rowChanges) throw new Error("the refund changed nothing");
	const written = applyRowChanges({
		rows: booked.rows,
		revision: booked.revision,
		changes: result.rowChanges,
	});
	booked.events.push(...result.events);
	return written;
};

/** Every visit comes from invoice `in_p` (the tier's 2 and a pack of 2); a booking holds 3 of them; `in_p` is refunded in full. */
const heldThenRefunded = () => {
	const booked = member({ invoices: ["inv-create-s2-pack"] });
	const held = booked.apply(
		holdBooking({
			...booked.ctx(NOW),
			bookingId: "b1",
			featureId: "visit",
			credits: 3,
			startsAt: STARTS,
			expiresAt: EXPIRES,
		}),
	);
	expect(held.ok).toBe(true);
	return { booked, written: refundInFull(booked, NOW + 1000) };
};

const engineTotal = (rows: Member["rows"]) =>
	rows
		.filter((row) => row.table === "customerEntitlements")
		.reduce((sum, row) => sum + (row.data as { balance: number }).balance, 0);

const availablePostings = (events: readonly AtmEvent[]) =>
	events
		.flatMap((event) => event.postings)
		.filter((posting) => posting.account === `credits:avail:${HOLDER}:visit`)
		.reduce((sum, posting) => sum + Number(posting.amount), 0);

test("a release after a full refund takes back the credits the booking held", () => {
	const { booked, written } = heldThenRefunded();
	const released = releaseBooking({
		...booked.ctx(NOW + 2000, written),
		bookingId: "b1",
	});
	if (!released.ok) throw new Error(released.reason);
	const after = applyRowChanges({
		...written,
		changes: released.rowChanges as never,
	});
	// every credit came from in_p, which was refunded in full: nothing is left
	expect(engineTotal(after.rows)).toBe(0);
	expect(grantsFromRows(after.rows).invoices.in_p?.owed).toBeUndefined();
	for (const event of released.events)
		expect(validateEvent(event)).toEqual({ ok: true, errors: [] });
	const adjusted = released.events.filter(
		(event) => event.event_type === "credit.adjusted",
	);
	expect(adjusted).toHaveLength(1);
	expect(adjusted[0]?.postings.map((p) => [p.account, p.amount])).toEqual([
		[`credits:avail:${HOLDER}:visit`, "-3"],
		["credits:adjust", "3"],
	]);
});

test("the refund remembers what the booking holds; the books follow the engine through the release", () => {
	const { booked, written } = heldThenRefunded();
	expect(grantsFromRows(written.rows).invoices.in_p?.owed).toEqual({
		ce_tier_visit_month: 2,
		ce_once_in_p_pack_visit: 1,
	});
	const released = releaseBooking({
		...booked.ctx(NOW + 2000, written),
		bookingId: "b1",
	});
	if (!released.ok) throw new Error(released.reason);
	// The member started with 4 visits, all from in_p: the hold, the refund and the release leave none in the books.
	expect(4 + availablePostings([...booked.events, ...released.events])).toBe(0);
});

test("the log of the hold, the refund and the release replays to the engine's balance", () => {
	const start = member({ invoices: ["inv-create-s2-pack"] }).engine;
	const { booked, written } = heldThenRefunded();
	const released = releaseBooking({
		...booked.ctx(NOW + 2000, written),
		bookingId: "b1",
	});
	if (!released.ok) throw new Error(released.reason);
	const events = [...booked.events, ...released.events];
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
	expect(replayed.balances.find((b) => b.feature === "visit")?.avail).toBe(0);
	if (hasHledger)
		expect(checkWithHledger(events)).toEqual({ exitCode: 0, stderr: "" });
});

test("a confirm after a full refund keeps the held credits spent and clears what the invoice was owed", () => {
	const { booked, written } = heldThenRefunded();
	const confirmed = confirmBooking({
		...booked.ctx(NOW + 2000, written),
		bookingId: "b1",
	});
	if (!confirmed.ok) throw new Error(confirmed.reason);
	const after = applyRowChanges({
		...written,
		changes: confirmed.rowChanges as never,
	});
	expect(engineTotal(after.rows)).toBe(0);
	expect(confirmed.booking.state).toBe("spent");
	expect(grantsFromRows(after.rows).invoices.in_p?.owed).toBeUndefined();
	expect(confirmed.events.map((event) => event.event_type)).toEqual([
		"credit.spent",
	]);
});

test("a refund with nothing held writes the invoice record as before (no owed key)", () => {
	const booked = member({ invoices: ["inv-create-s2-pack"] });
	const written = refundInFull(booked, NOW);
	const record = grantsFromRows(written.rows).invoices.in_p;
	expect(record?.removed).toBe(true);
	expect(record).not.toHaveProperty("owed");
	expect(engineTotal(written.rows)).toBe(0);
});
