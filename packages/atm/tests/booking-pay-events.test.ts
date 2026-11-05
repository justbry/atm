/**
 * `handleStripeEvent` on a one-time booking payment: the Checkout Session events and the refund of its charge.
 *
 * The recorded files (`fixtures/billing/stripe/recorded/booking/`) are test-mode sandbox objects, scrubbed; see the README
 * there for what they are and what they are not (the sessions came from `stripe trigger`, not from `bookingCheckoutParams`).
 * The `async_payment_succeeded` event is NOT recorded: that test is built from a recorded `completed` event and says so.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { menuCatalogRows } from "../src/billing/grants.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	applyRowChanges,
	type BillingRow,
	GRANTS_TABLE,
	grantsFromRows,
} from "../src/billing/rows.js";
import {
	lookupKeyOf,
	menuLineItems,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type {
	BookingPaymentOutcome,
	Menu,
	StripeEventResult,
} from "../src/billing/types.js";
import { deterministicUlid } from "../src/ledger/ids.js";
import { canonicalize } from "../src/ledger/util.js";
import type { AtmEnv } from "../src/types.js";
import {
	chargeRefunded,
	invoicePaid,
	paymentIntentOf,
	priceIdOf,
} from "./stripe-events.js";
import { shapeProblems } from "./stripe-shape.js";

const SCHOOL = "sch_demo";
const FAMILY = "fam_demo1";
const HOLDER = `family:${FAMILY}`;
const NOW = Date.parse("2026-11-05T12:00:00Z");

const bookingDir = `${import.meta.dir}/../fixtures/billing/stripe/recorded/booking`;
// biome-ignore lint/suspicious/noExplicitAny: recorded Stripe JSON is read and edited by path, untyped
const load = (name: string): any =>
	JSON.parse(readFileSync(`${bookingDir}/${name}`, "utf8"));

const menu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
const catalog = menuCatalogRows({ menu, school: SCHOOL });
const priceIds = Object.fromEntries(
	[...menuLineItems(SCHOOL, menu).keys()].map((key) => [key, priceIdOf(key)]),
);

const inputEventId = (stripeEventId: string) =>
	deterministicUlid({
		timeMs: NOW,
		revision: 0,
		seed: canonicalize([SCHOOL, stripeEventId]),
	});

/** The family service in miniature: the stored rows and revision, one write per event. */
const world = (env?: AtmEnv) => {
	let rows: BillingRow[] = [];
	let revision = 0;
	const bookingIds: Record<string, string> = {};
	const invoiceIds: Record<string, string> = {};
	const api = {
		bookingIds,
		invoiceIds,
		get rows() {
			return rows;
		},
		get revision() {
			return revision;
		},
		get grants() {
			return grantsFromRows(rows);
		},
		/** Handles an event and writes what it decided, as the caller would. */
		handle(event: { id: string }): StripeEventResult {
			const result = handleStripeEvent({
				event,
				eventId: inputEventId(event.id),
				menu,
				menuVersion: 3,
				policy: DEFAULT_POLICY,
				policyVersion: 1,
				rows,
				revision,
				catalog,
				now: NOW,
				priceIds,
				bookingIds,
				invoiceIds,
				...(env ? { env } : {}),
			});
			if (result.rowChanges)
				({ rows, revision } = applyRowChanges({
					rows,
					revision,
					changes: result.rowChanges,
				}));
			return result;
		},
	};
	return api;
};

const NOTHING = { rowChanges: null, events: [] };
const outcomeOf = (result: StripeEventResult): BookingPaymentOutcome => {
	if (!result.booking)
		throw new Error(`no booking outcome: ${JSON.stringify(result.refused)}`);
	return result.booking;
};

const completed = load("checkout.session.completed.json");
const second = load("checkout.session.completed.second.json");
const expired = load("checkout.session.expired.json");
const subscription = load("checkout.session.completed.subscription.json");
const fullRefund = load("charge.refunded.full.json");
const partialRefund = load("charge.refunded.partial.json");

const sessionId = completed.data.object.id as string;
const paymentIntentId = completed.data.object.payment_intent as string;
const chargeId = fullRefund.data.object.id as string;

const UNLISTED_OR_NULL = /must NOT have additional properties|must be null$/;

describe("the recorded booking files fit Stripe's API version", () => {
	test.each([
		"checkout.session.completed.json",
		"checkout.session.completed.second.json",
		"checkout.session.expired.json",
		"checkout.session.completed.subscription.json",
		"charge.refunded.full.json",
		"charge.refunded.partial.json",
	])("%s: no value of a wrong type", (name) => {
		// Real Stripe sends fields the pruned spec lacks (and the charge's older null ones): only those may be reported, as in
		// `stripe-recorded.test.ts`. A wrong type, or a field a mapping reads, would fail here.
		for (const problem of shapeProblems(load(name)))
			expect(problem).toMatch(UNLISTED_OR_NULL);
	});

	test("the files carry no account id, email, or Stripe-hosted link", () => {
		const text = readdirSync(bookingDir)
			.map((name) => readFileSync(`${bookingDir}/${name}`, "utf8"))
			.join("\n");
		expect(text).not.toMatch(/acct_[A-Za-z0-9]+/);
		expect(text).not.toMatch(/"[^"\s]+@(?!example\.test)[^"\s]+"/);
		expect(text).not.toMatch(
			/https:\/\/(pay|invoice|receipt|checkout)\.stripe\.com/,
		);
	});

	test("the refund's charge carries the booking id the payment intent was given", () => {
		expect(fullRefund.data.object.metadata.booking_id).toBe("bk_trig1");
		expect(fullRefund.data.object.payment_intent).toBe(paymentIntentId);
	});
});

describe("checkout.session.completed of a booking", () => {
	test("decides paid, and records the booking and its payment in the holder's grants state", () => {
		const s = world();
		const result = s.handle(completed);
		expect(result.refused).toBeUndefined();
		// the books' lines are in tests/booking-money.test.ts; the credits are untouched
		expect(result.events.map((event) => event.event_type)).toEqual([
			"payment.succeeded",
		]);
		expect(result.booking).toEqual({
			action: "paid",
			bookingId: "bk_trig1",
			familyId: FAMILY,
			schoolId: SCHOOL,
			sessionId,
			paymentIntentId,
			chargeId: null,
			amount: 3000,
			currency: "usd",
		});
		expect(s.grants.bookings).toEqual({
			bk_trig1: {
				state: "paid",
				cost: { kind: "price", amount: 3000, currency: "usd" },
				startsAt: null,
				expiresAt: null,
				payment: {
					sessionId,
					paymentIntentId,
					amount: 3000,
					currency: "usd",
					refunded: 0,
					booked: true,
				},
			},
		});
	});

	test("a family with no rows gets a holder from the metadata, and one write of the grants row alone", () => {
		const s = world();
		const result = s.handle(completed);
		expect(result.rowChanges).toEqual({
			subjectKey: `${SCHOOL}|live|${HOLDER}`,
			expectedRevision: 0,
			nextRevision: 1,
			upserts: [expect.objectContaining({ table: GRANTS_TABLE, id: "grants" })],
			deletes: [],
		});
		expect(s.grants.holder).toEqual({ orgId: SCHOOL, customerId: HOLDER });
		expect(s.rows.every((row) => row.table === GRANTS_TABLE)).toBe(true);
	});

	test("env test names a subject of its own; the default is live", () => {
		expect(world("test").handle(completed).rowChanges?.subjectKey).toBe(
			`${SCHOOL}|test|${HOLDER}`,
		);
		expect(world().handle(completed).rowChanges?.subjectKey).toBe(
			`${SCHOOL}|live|${HOLDER}`,
		);
	});

	test("the replay of the same event decides nothing: no rows, no events, no second outcome", () => {
		const s = world();
		s.handle(completed);
		const before = JSON.stringify(s.rows);
		expect(s.handle(completed)).toEqual(NOTHING);
		expect(JSON.stringify(s.rows)).toBe(before);
		expect(s.revision).toBe(1);
	});

	test("a family that already has engine rows keeps them and its identity; only the grants row is written", () => {
		const s = world();
		const price = menu.tiers
			.find((t) => t.id === "sparkle-2")
			?.prices.find((p) => p.interval === "month")?.amount as number;
		const key = lookupKeyOf(
			SCHOOL,
			tierPriceKey("sparkle-2", "month"),
			price,
			menu.currency,
		);
		const start = NOW - 86_400_000;
		const invoice = s.handle(
			invoicePaid({
				eventId: "evt_in_1",
				invoiceId: "in_1",
				at: start,
				subscriptionId: "sub_1",
				reason: "subscription_create",
				periodStart: start,
				periodEnd: start + 30 * 86_400_000,
				lines: [{ lookupKey: key, amount: price, interval: "month" }],
				metadata: { b4u_school: SCHOOL, family_id: FAMILY },
			}),
		);
		expect(invoice.refused).toBeUndefined();
		const engineBefore = JSON.stringify(
			s.rows.filter((row) => row.table !== GRANTS_TABLE),
		);
		const identity = s.grants.identity;
		expect(identity).not.toBeNull();
		const revisionBefore = s.revision;

		const result = s.handle(completed);
		expect(outcomeOf(result).action).toBe("paid");
		expect(result.rowChanges?.upserts.map((row) => row.table)).toEqual([
			GRANTS_TABLE,
		]);
		expect(result.rowChanges?.expectedRevision).toBe(revisionBefore);
		expect(result.rowChanges?.nextRevision).toBe(revisionBefore + 1);
		expect(
			JSON.stringify(s.rows.filter((row) => row.table !== GRANTS_TABLE)),
		).toBe(engineBefore);
		expect(s.grants.identity).toEqual(identity);
		expect(Object.keys(s.grants.invoices)).toEqual(["in_1"]);
		expect(Object.keys(s.grants.bookings ?? {})).toEqual(["bk_trig1"]);
	});

	test("a second booking is added beside the first", () => {
		const s = world();
		s.handle(completed);
		s.handle(second);
		expect(Object.keys(s.grants.bookings ?? {}).sort()).toEqual([
			"bk_trig1",
			"bk_trig2",
		]);
	});

	test("a session that is complete but unpaid (a delayed method) decides nothing", () => {
		const event = structuredClone(completed);
		event.data.object.payment_status = "unpaid";
		expect(world().handle(event)).toEqual(NOTHING);
	});

	test("async_payment_succeeded decides paid (unverified fixture: a recorded completed event with its type changed, not a recording)", () => {
		const s = world();
		const early = structuredClone(completed);
		early.data.object.payment_status = "unpaid";
		expect(s.handle(early)).toEqual(NOTHING);
		const later = structuredClone(completed);
		later.id = "evt_unverified_async_succeeded";
		later.type = "checkout.session.async_payment_succeeded";
		const outcome = outcomeOf(s.handle(later));
		expect(outcome).toMatchObject({
			action: "paid",
			bookingId: "bk_trig1",
			amount: 3000,
		});
		expect(s.grants.bookings?.bk_trig1?.state).toBe("paid");
	});

	test("a subscription-mode session decides nothing (the invoice does)", () => {
		expect(subscription.data.object.mode).toBe("subscription");
		const s = world();
		expect(s.handle(subscription)).toEqual(NOTHING);
		expect(s.rows).toEqual([]);
	});

	test("a payment-mode session without a booking id (a one-time add-on checkout) decides nothing", () => {
		const event = structuredClone(completed);
		event.data.object.metadata = { b4u_school: SCHOOL, family_id: FAMILY };
		expect(world().handle(event)).toEqual(NOTHING);
	});

	test("a booking's session with no school or family to name the holder is refused", () => {
		const event = structuredClone(completed);
		event.data.object.metadata = { booking_id: "bk_trig1" };
		const result = world().handle(event);
		expect(result.refused?.reason).toBe("missing_metadata");
		expect(result.rowChanges).toBeNull();
	});

	test("a second session paying for a booking already paid is refused for a person to refund, and the first payment stands", () => {
		const s = world();
		s.handle(completed);
		const again = structuredClone(completed);
		again.id = "evt_again";
		again.data.object.id = "cs_test_ScrubSessionAgain";
		const result = s.handle(again);
		expect(result.refused?.reason).toBe("rejected");
		expect(result.refused?.message).toContain("refund one of the payments");
		expect(s.grants.bookings?.bk_trig1?.payment?.sessionId).toBe(sessionId);
	});

	test("a booking refunded in full can be paid again by a new session", () => {
		const s = world();
		s.handle(completed);
		s.bookingIds[paymentIntentId] = "bk_trig1";
		s.handle(fullRefund);
		expect(s.grants.bookings?.bk_trig1?.state).toBe("refunded");
		const again = structuredClone(completed);
		again.id = "evt_again";
		again.data.object.id = "cs_test_ScrubSessionAgain";
		again.data.object.payment_intent = "pi_ScrubAgain";
		expect(outcomeOf(s.handle(again)).action).toBe("paid");
		expect(s.grants.bookings?.bk_trig1).toMatchObject({
			state: "paid",
			payment: { sessionId: "cs_test_ScrubSessionAgain", refunded: 0 },
		});
	});

	test("a paid session with no amount is refused, not recorded", () => {
		const event = structuredClone(completed);
		event.data.object.amount_total = null;
		const result = world().handle(event);
		expect(result.refused?.reason).toBe("bad_event");
		expect(result.rowChanges).toBeNull();
	});
});

describe("checkout.session.expired of a booking", () => {
	test("decides expired and writes nothing", () => {
		const s = world();
		const result = s.handle(expired);
		expect(result.rowChanges).toBeNull();
		expect(result.events).toEqual([]);
		expect(result.booking).toMatchObject({
			action: "expired",
			bookingId: "bk_trig3",
			familyId: FAMILY,
			schoolId: SCHOOL,
			sessionId: expired.data.object.id,
			chargeId: null,
		});
		expect(s.rows).toEqual([]);
	});

	test("does not free a booking that another of its sessions paid for", () => {
		const s = world();
		s.handle(completed);
		const late = structuredClone(expired);
		late.data.object.metadata.booking_id = "bk_trig1";
		expect(s.handle(late)).toEqual(NOTHING);
	});
});

describe("charge.refunded of a booking's charge", () => {
	test("a full refund named by bookingIds decides refunded and marks the booking refunded", () => {
		const s = world();
		s.handle(completed);
		s.bookingIds[paymentIntentId] = "bk_trig1";
		const result = s.handle(fullRefund);
		expect(result.refused).toBeUndefined();
		expect(result.events.map((event) => event.event_type)).toEqual([
			"payment.refunded",
		]);
		expect(result.booking).toEqual({
			action: "refunded",
			bookingId: "bk_trig1",
			familyId: FAMILY,
			schoolId: SCHOOL,
			sessionId,
			paymentIntentId,
			chargeId,
			amount: 3000,
			currency: "usd",
		});
		expect(s.grants.bookings?.bk_trig1).toMatchObject({
			state: "refunded",
			payment: { refunded: 3000 },
		});
	});

	test("a full refund named by the charge's own metadata needs no bookingIds", () => {
		const s = world();
		s.handle(completed);
		expect(outcomeOf(s.handle(fullRefund))).toMatchObject({
			action: "refunded",
			bookingId: "bk_trig1",
		});
	});

	test("it does not go through the invoice path: no unmatched_invoice, no credits touched", () => {
		const s = world();
		s.handle(completed);
		const result = s.handle(fullRefund);
		expect(result.refused).toBeUndefined();
		// no credit event: the only line is the refund's money line
		expect(result.events.map((event) => event.event_type)).toEqual([
			"payment.refunded",
		]);
	});

	test("the redelivery of a full refund decides nothing", () => {
		const s = world();
		s.handle(completed);
		s.handle(fullRefund);
		const revision = s.revision;
		expect(s.handle(fullRefund)).toEqual(NOTHING);
		expect(s.revision).toBe(revision);
	});

	test("a partial refund decides partly_refunded with the running total and cancels nothing", () => {
		const s = world();
		s.handle(second);
		const result = s.handle(partialRefund);
		expect(result.booking).toMatchObject({
			action: "partly_refunded",
			bookingId: "bk_trig2",
			amount: 1000,
			chargeId: partialRefund.data.object.id,
		});
		expect(s.grants.bookings?.bk_trig2).toMatchObject({
			state: "paid",
			payment: { refunded: 1000 },
		});
	});

	test("a partial refund that is later completed by a full one decides refunded; an older, smaller event after it decides nothing", () => {
		const s = world();
		s.handle(second);
		s.handle(partialRefund);
		const rest = structuredClone(partialRefund);
		rest.id = "evt_rest";
		rest.data.object.amount_refunded = 3000;
		rest.data.object.refunded = true;
		rest.data.previous_attributes = { amount_refunded: 1000 };
		expect(outcomeOf(s.handle(rest))).toMatchObject({
			action: "refunded",
			amount: 3000,
		});
		expect(s.grants.bookings?.bk_trig2).toMatchObject({
			state: "refunded",
			payment: { refunded: 3000 },
		});
		const old = structuredClone(partialRefund);
		old.id = "evt_old";
		expect(s.handle(old)).toEqual(NOTHING);
	});

	test("a refund that names a booking this holder has not paid for is refused unmatched_booking (retry once the session is handled)", () => {
		const s = world();
		const result = s.handle(fullRefund);
		expect(result.refused?.reason).toBe("unmatched_booking");
		expect(result.rowChanges).toBeNull();
		expect(result.booking).toBeUndefined();
		// ... and is decided once the paid session has been
		s.handle(completed);
		expect(outcomeOf(s.handle(fullRefund)).action).toBe("refunded");
	});

	test("the same through bookingIds for a charge whose metadata names nothing", () => {
		const s = world();
		const bare = structuredClone(fullRefund);
		bare.data.object.metadata = {};
		s.bookingIds[paymentIntentId] = "bk_trig1";
		expect(s.handle(bare).refused?.reason).toBe("unmatched_booking");
		s.handle(completed);
		expect(outcomeOf(s.handle(bare)).action).toBe("refunded");
	});

	test("a refund of another payment intent than the booking's is refused, not applied", () => {
		const s = world();
		s.handle(completed);
		const other = structuredClone(fullRefund);
		other.data.object.payment_intent = "pi_ScrubOther";
		const result = s.handle(other);
		expect(result.refused?.reason).toBe("unmatched_booking");
		expect(s.grants.bookings?.bk_trig1?.state).toBe("paid");
	});

	test("a refund of an invoice's charge still follows the invoice path, whatever its metadata says", () => {
		const s = world();
		const price = menu.tiers
			.find((t) => t.id === "sparkle-2")
			?.prices.find((p) => p.interval === "month")?.amount as number;
		const key = lookupKeyOf(
			SCHOOL,
			tierPriceKey("sparkle-2", "month"),
			price,
			menu.currency,
		);
		const start = NOW - 86_400_000;
		s.handle(
			invoicePaid({
				eventId: "evt_in_1",
				invoiceId: "in_1",
				at: start,
				subscriptionId: "sub_1",
				reason: "subscription_create",
				periodStart: start,
				periodEnd: start + 30 * 86_400_000,
				lines: [{ lookupKey: key, amount: price, interval: "month" }],
				metadata: { b4u_school: SCHOOL, family_id: FAMILY },
			}),
		);
		s.handle(completed);
		s.invoiceIds[paymentIntentOf("in_1")] = "in_1";
		const refund = chargeRefunded({
			eventId: "evt_re_in_1",
			chargeId: "ch_in_1",
			invoiceId: "in_1",
			amount: price,
			chargeAmount: price,
			at: NOW,
		});
		// the charge happens to carry a booking id, and the caller knows its payment intent is an invoice's
		refund.data.object.metadata = { booking_id: "bk_trig1" };
		const result = s.handle(refund);
		expect(result.booking).toBeUndefined();
		expect(result.refused).toBeUndefined();
		expect(result.events.length).toBeGreaterThan(0);
		expect(s.grants.invoices.in_1).toBeDefined();
		expect(s.grants.bookings?.bk_trig1?.state).toBe("paid");
	});

	test("a refund that names neither an invoice nor a booking keeps today's behaviour", () => {
		const s = world();
		const bare = structuredClone(fullRefund);
		bare.data.object.metadata = {};
		// no rows, no invoice, no booking: nothing is decided (a charge that is not ours)
		expect(s.handle(bare)).toEqual(NOTHING);
		// a holder exists and the full refund would take credits back: refused for the missing invoice, as before
		s.handle(completed);
		expect(s.handle(bare).refused?.reason).toBe("unmatched_invoice");
	});
});
