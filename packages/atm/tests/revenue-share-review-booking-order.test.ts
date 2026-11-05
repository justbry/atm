/**
 * Two partial refunds of one booking's charge delivered in the wrong order. Each event books its own amount
 * (`amount_refunded` less `previous_attributes.amount_refunded`), as an invoice's refund does, so `reconcile` pairs each
 * of Stripe's refunds with one line; the record's running total decides only the state and the share's reversal.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { reconcile } from "../src/ledger/reconcile.js";
import type { AtmEvent, ReconcileStripe } from "../src/types.js";
import { ofType, withShare, world } from "./revenue-share-world.js";

const dir = `${import.meta.dir}/../fixtures/billing/stripe/recorded/booking`;
// biome-ignore lint/suspicious/noExplicitAny: recorded JSON
const load = (name: string): any =>
	JSON.parse(readFileSync(`${dir}/${name}.json`, "utf8"));

const second = load("checkout.session.completed.second");
const partial = load("charge.refunded.partial"); // 1000 of 3000, previous 0
const rest = structuredClone(partial);
rest.id = "evt_rest";
rest.created = partial.created + 60;
rest.data.object.amount_refunded = 3000;
rest.data.object.refunded = true;
rest.data.previous_attributes = { amount_refunded: 1000 };
const intent = second.data.object.payment_intent as string;
const charge = partial.data.object.id as string;

const stripeSide = (): ReconcileStripe => ({
	invoices: [],
	paymentIntents: [
		{
			id: intent,
			status: "succeeded",
			amount: 3000,
			currency: "usd",
			created: second.data.object.created,
			livemode: false,
			metadata: { booking_id: "bk_trig2" },
		},
	],
	refunds: [
		{
			id: "re_1",
			amount: 1000,
			currency: "usd",
			charge,
			payment_intent: intent,
			created: partial.created,
			status: "succeeded",
		},
		{
			id: "re_2",
			amount: 2000,
			currency: "usd",
			charge,
			payment_intent: intent,
			created: rest.created,
			status: "succeeded",
		},
	],
	disputes: [],
	payouts: [],
});

const run = (events: readonly AtmEvent[]) =>
	reconcile({
		events,
		stripe: stripeSide(),
		period: { month: "2026-11" },
		mode: "test",
		timeZone: "America/Denver",
	});

const refundLines = (events: readonly AtmEvent[]) =>
	ofType(events, "payment.refunded").map((e) => e.payload.amount);

const reversedShare = (events: readonly AtmEvent[]) =>
	ofType(events, "share.reversed").reduce(
		(total, e) => total + (e.payload.reversed as number),
		0,
	);

test("in order: two refund lines (1000, 2000), reconcile clean on refunds", () => {
	const s = world({ school: "sch_demo", policy: withShare(2.5) });
	s.handle(second);
	s.handle(partial);
	s.handle(rest);
	expect(refundLines(s.events)).toEqual([1000, 2000]);
	expect(
		run(s.events).differences.filter((d) => d.object === "refund"),
	).toEqual([]);
});

test("out of order: one line per Stripe refund (2000 then 1000), reconcile clean on refunds, the share reversed once in full", () => {
	const s = world({ school: "sch_demo", policy: withShare(2.5) });
	s.handle(second);
	s.handle(rest);
	const late = s.handle(partial);
	expect(refundLines(s.events)).toEqual([2000, 1000]);
	// the late event is the older total: it books its line and changes no row and no share
	expect(late.rowChanges).toBeNull();
	expect(ofType(late.events, "share.reversed")).toEqual([]);
	expect(
		run(s.events).differences.filter((d) => d.object === "refund"),
	).toEqual([]);
	// 2.5% of 3000 is 75, all of it reversed by the full refund
	expect(reversedShare(s.events)).toBe(75);
	expect(s.grants.bookings?.bk_trig2?.payment?.share).toEqual({
		accrued: 75,
		reversed: 75,
	});
	expect(s.grants.bookings?.bk_trig2).toMatchObject({
		state: "refunded",
		payment: { refunded: 3000 },
	});
});

test("a redelivery makes the same line under the same idem, so the outbox keeps one", () => {
	const s = world({ school: "sch_demo", policy: withShare(2.5) });
	s.handle(second);
	const first = s.handle(partial);
	const again = s.handle(partial);
	const lineOf = (events: readonly AtmEvent[]) =>
		ofType(events, "payment.refunded").map((e) => [e.idem, e.payload.amount]);
	expect(lineOf(again.events)).toEqual(lineOf(first.events));
	expect(again.rowChanges).toBeNull();
	expect(ofType(again.events, "share.reversed")).toEqual([]);
});

test("a refund of more than was paid is clamped for the share, and the lines are Stripe's own amounts", () => {
	const s = world({ school: "sch_demo", policy: withShare(2.5) });
	s.handle(second);
	const over = structuredClone(rest);
	over.data.object.amount_refunded = 4000;
	over.data.previous_attributes = { amount_refunded: 0 };
	s.handle(over);
	expect(refundLines(s.events)).toEqual([4000]);
	expect(reversedShare(s.events)).toBe(75);
	expect(s.grants.bookings?.bk_trig2?.payment?.share).toEqual({
		accrued: 75,
		reversed: 75,
	});
});

test("an event without previous_attributes still books what the running total rose by", () => {
	const s = world({ school: "sch_demo", policy: withShare(2.5) });
	s.handle(second);
	s.handle(partial);
	const bare = structuredClone(rest);
	bare.data.previous_attributes = undefined;
	s.handle(bare);
	expect(refundLines(s.events)).toEqual([1000, 2000]);
});
