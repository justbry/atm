/**
 * Pay later (`src/billing/pay-later.ts`): a zero-interest tfd-notes note, each instalment paid by a tfd one-time
 * checkout tied to the note, booked by the handler and recorded back on the note.
 */
import { describe, expect, test } from "bun:test";
import { statement } from "tfd-notes";
import menuJson from "../fixtures/billing/grants/menu.json";
import {
	instalmentCheckoutParams,
	MAX_PAY_LATER_INSTALMENTS,
	notePaymentEvent,
	noteReversalEvent,
	payLaterNote,
} from "../src/billing/pay-later.js";
import type { Menu } from "../src/billing/types.js";
import { createStore } from "../src/scenario/store.js";
import { chargeRefunded, invoicePaid } from "../src/scenario/stripe-events.js";
import { harness } from "./handler-harness.js";

const SCHOOL = "b4uni";
const FAMILY = "fam_7";
const NOTE = "note_go_unlimited_7";
const menu = menuJson as Menu;
const RETURN = { success: "https://x/ok", cancel: "https://x/no" };
/** Go Unlimited for a year, $1,824, in four monthly instalments. */
const created = () => {
	const result = payLaterNote({
		noteId: NOTE,
		eventId: "ne_1",
		enteredAt: "2026-11-23T17:00:00Z",
		principal: 182_400,
		issueDate: "2026-11-23",
		firstDue: "2026-12-23",
		count: 4,
		frequency: "monthly",
		timeZone: "America/Denver",
	});
	if (!result.ok) throw new Error(`expected a note, got ${result.reason}`);
	return result.event;
};
const checkout = (noteEvents: unknown[], instalment: number) =>
	instalmentCheckoutParams({
		schoolId: SCHOOL,
		familyId: FAMILY,
		noteEvents,
		instalment,
		asOf: "2026-12-20",
		name: `Go Unlimited, instalment ${instalment} of 4`,
		returnUrls: RETURN,
	});
const at = Date.UTC(2026, 11, 20, 18);
/** The paid invoice of instalment `n`'s checkout: an inline price (no lookup key) and the checkout's metadata. */
const paid = (n: number, amount: number, metadata?: Record<string, string>) =>
	invoicePaid({
		eventId: `evt_inst_${n}`,
		invoiceId: `in_inst_${n}`,
		at,
		subscriptionId: null,
		reason: "manual",
		periodStart: at,
		periodEnd: at,
		lines: [{ lookupKey: `inline_${n}`, amount, interval: null }],
		metadata: metadata ?? {
			b4u_school: SCHOOL,
			family_id: FAMILY,
			b4u_note: NOTE,
			b4u_instalment: String(n),
		},
	});

describe("payLaterNote", () => {
	test("a zero-interest USD note in at most 4 instalments", () => {
		const note = created();
		expect(note.terms).toMatchObject({
			currency: "USD",
			exponent: 2,
			principal_minor: "182400",
			annual_rate: "0",
			schedule: { type: "amortized", count: 4, frequency: "monthly" },
		});
		expect(
			statement([note], "2026-11-23").schedule.map((r) => r.payment_minor),
		).toEqual(["45600", "45600", "45600", "45600"]);
	});

	test(`more than ${MAX_PAY_LATER_INSTALMENTS} instalments, a bad amount or bad dates are refused`, () => {
		const base = {
			noteId: NOTE,
			eventId: "ne_1",
			enteredAt: "2026-11-23T17:00:00Z",
			principal: 182_400,
			issueDate: "2026-11-23",
			firstDue: "2026-12-23",
			count: 4,
			frequency: "monthly" as const,
			timeZone: "America/Denver",
		};
		expect(payLaterNote({ ...base, count: 5 })).toEqual({
			ok: false,
			reason: "too_many_instalments",
			count: 5,
		});
		expect(payLaterNote({ ...base, principal: 0 })).toEqual({
			ok: false,
			reason: "bad_amount",
		});
		// 5 cents in 4 instalments is 2, 2, 1 and 0 cents, which Stripe would not charge.
		expect(payLaterNote({ ...base, principal: 5 })).toEqual({
			ok: false,
			reason: "bad_amount",
		});
		expect(payLaterNote({ ...base, firstDue: "2026-11-01" })).toMatchObject({
			ok: false,
			reason: "bad_terms",
		});
	});
});

describe("instalmentCheckoutParams", () => {
	test("one inline line for the instalment, the note on the invoice", () => {
		const result = checkout([created()], 1);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.amount).toBe(45_600);
		expect(result.params.mode).toBe("payment");
		expect(result.params.line_items).toEqual([
			{
				quantity: 1,
				price_data: {
					currency: "usd",
					unit_amount: 45_600,
					product_data: { name: "Go Unlimited, instalment 1 of 4" },
				},
			},
		]);
		expect(result.params.invoice_creation.invoice_data.metadata).toEqual({
			b4u_school: SCHOOL,
			family_id: FAMILY,
			b4u_note: NOTE,
			b4u_instalment: "1",
		});
	});

	test("an instalment off the schedule, or one already paid, is refused", () => {
		expect(checkout([created()], 5)).toEqual({
			ok: false,
			reason: "instalment_not_found",
			instalment: 5,
		});
		const payment = {
			schema: "tfd.note-event.v1",
			id: "ne_2",
			note_id: NOTE,
			seq: 2,
			entered_at: "2026-12-20T18:00:00Z",
			entered_by: "lender",
			type: "payment.recorded",
			kind: "payment",
			amount_minor: "45600",
			value_date: "2026-12-20",
		};
		expect(checkout([created(), payment], 1)).toEqual({
			ok: false,
			reason: "instalment_paid",
			instalment: 1,
		});
		expect(checkout([created(), payment], 2).ok).toBe(true);
	});

	test("the stream may come in any order", () => {
		const payment = {
			schema: "tfd.note-event.v1",
			id: "ne_2",
			note_id: NOTE,
			seq: 2,
			entered_at: "2026-12-20T18:00:00Z",
			entered_by: "lender",
			type: "payment.recorded",
			kind: "payment",
			amount_minor: "45600",
			value_date: "2026-12-20",
		};
		expect(checkout([payment, created()], 2)).toMatchObject({
			ok: true,
			amount: 45_600,
		});
	});

	test("a note that is not a Pay later note is refused", () => {
		const note = created();
		note.terms.annual_rate = "0.05";
		expect(checkout([note], 1)).toEqual({ ok: false, reason: "not_pay_later" });
	});
});

describe("the handler books an instalment; the note records it", () => {
	test("applied, booked to income:billing:pay-later with the note's labels, no credits", () => {
		const family = createStore({ menu, school: SCHOOL, family: FAMILY });
		const result = family.handle(paid(1, 45_600), at);
		expect(result.refused ?? null).toBeNull();
		const payment = family.events.find(
			(e) => e.event_type === "payment.succeeded",
		);
		expect(payment?.postings).toEqual([
			{ account: "assets:stripe", amount: "456.00", commodity: "USD" },
			{
				account: "income:billing:pay-later",
				amount: "-456.00",
				commodity: "USD",
			},
		]);
		expect(payment?.labels).toMatchObject({ note: NOTE, instalment: "1" });
		expect(
			family.events.filter((e) => e.event_type.startsWith("credit.")),
		).toEqual([]);
	});

	test("an inline price without the note is still refused, as before", () => {
		const family = createStore({ menu, school: SCHOOL, family: FAMILY });
		const result = family.handle(
			paid(1, 45_600, { b4u_school: SCHOOL, family_id: FAMILY }),
			at,
		);
		expect(result.refused?.reason).toBe("unmatched_line");
	});

	test("the paid instalment becomes the note's payment; a full refund its reversal", () => {
		const family = createStore({ menu, school: SCHOOL, family: FAMILY });
		family.handle(paid(1, 45_600), at);
		const booked = family.events.find(
			(e) => e.event_type === "payment.succeeded",
		);
		if (!booked) throw new Error("no payment booked");
		const recorded = notePaymentEvent(booked, {
			seq: 2,
			eventId: "ne_2",
			enteredAt: "2026-12-20T18:00:05Z",
		});
		expect(recorded).toMatchObject({
			type: "payment.recorded",
			kind: "payment",
			entered_by: "lender",
			amount_minor: "45600",
			value_date: "2026-12-20",
			method: "checkout",
			reference: "in_inst_1",
		});
		if (!recorded) return;
		const note = [created(), recorded];
		expect(statement(note, "2026-12-24").lender.paid_minor).toBe("45600");
		expect(statement(note, "2026-12-24").borrower.paid_minor).toBe("45600");

		const later = at + 86_400_000;
		family.handle(
			chargeRefunded({
				eventId: "evt_refund_1",
				chargeId: "ch_inst_1",
				invoiceId: "in_inst_1",
				amount: 45_600,
				chargeAmount: 45_600,
				at: later,
			}),
			later,
		);
		const refund = family.events.find(
			(e) => e.event_type === "payment.refunded",
		);
		if (!refund) throw new Error("no refund booked");
		const reversal = noteReversalEvent(refund, recorded, {
			seq: 3,
			eventId: "ne_3",
			enteredAt: "2026-12-21T18:00:05Z",
		});
		expect(reversal).toMatchObject({
			ok: true,
			event: { kind: "reversal", reverses: "ne_2", amount_minor: "45600" },
		});
		if (!reversal.ok) return;
		expect(
			statement([...note, reversal.event], "2026-12-24").lender.paid_minor,
		).toBe("0");
	});

	test("a partial refund is not a reversal", () => {
		const family = createStore({ menu, school: SCHOOL, family: FAMILY });
		family.handle(paid(1, 45_600), at);
		const booked = family.events.find(
			(e) => e.event_type === "payment.succeeded",
		);
		const recorded = booked
			? notePaymentEvent(booked, {
					seq: 2,
					eventId: "ne_2",
					enteredAt: "2026-12-20T18:00:05Z",
				})
			: null;
		if (!recorded) throw new Error("no note payment");
		family.handle(
			chargeRefunded({
				eventId: "evt_refund_1",
				chargeId: "ch_inst_1",
				invoiceId: "in_inst_1",
				amount: 10_000,
				chargeAmount: 45_600,
				at: at + 1,
			}),
			at + 1,
		);
		const refund = family.events.find(
			(e) => e.event_type === "payment.refunded",
		);
		if (!refund) throw new Error("no refund booked");
		expect(
			noteReversalEvent(refund, recorded, {
				seq: 3,
				eventId: "ne_3",
				enteredAt: "2026-12-21T18:00:05Z",
			}),
		).toEqual({
			ok: false,
			reason: "partial_refund",
			refunded: 10_000,
			paid: 45_600,
		});
	});

	test("notePaymentEvent ignores a payment that is not an instalment", () => {
		const family = createStore({ menu, school: SCHOOL, family: FAMILY });
		family.handle(paid(1, 45_600), at);
		const booked = family.events.find(
			(e) => e.event_type === "payment.succeeded",
		);
		if (!booked) throw new Error("no payment booked");
		const { note: _note, ...labels } = booked.labels ?? {};
		expect(
			notePaymentEvent(
				{ ...booked, labels },
				{ seq: 2, eventId: "ne_2", enteredAt: "2026-12-20T18:00:05Z" },
			),
		).toBeNull();
	});

	test("through the reference webhook handler: 200 applied, booked once", () => {
		const h = harness(undefined, { school: SCHOOL, menu });
		expect(h.deliver(paid(2, 45_600), at).body.outcome).toBe("applied");
		expect(h.deliver(paid(2, 45_600), at).body.outcome).toBe("duplicate");
		const payments = h
			.outbox()
			.filter((event) => event.event_type === "payment.succeeded");
		expect(payments).toHaveLength(1);
		expect(payments[0]?.labels).toMatchObject({ note: NOTE, instalment: "2" });
	});
});
