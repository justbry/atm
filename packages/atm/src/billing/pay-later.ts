/**
 * Pay later on B4 Uni (`docs/specs/promissory-notes.md`, "Use: Pay later on B4 Uni"; `plans/b4uni-merchant/PLAN.md`):
 * a zero-interest promissory note in tfd-notes, each instalment paid through a tfd one-time checkout tied to the note.
 *
 *   payLaterNote              the note's `note.created` event: USD, rate 0, amortized, at most 4 instalments
 *   instalmentCheckoutParams  a payment-mode Checkout Session for one instalment (`price_data`, `invoice_creation`), whose
 *                             invoice carries `b4u_note` and `b4u_instalment`; the handler books it to
 *                             `income:billing:pay-later` and grants nothing
 *   notePaymentEvent          the paid instalment's `payment.succeeded` as the note's `payment.recorded` (lender side)
 *   noteReversalEvent         a full refund of it as the whole `reversal` of that payment
 *
 * The cap of 4 instalments is the pricing side's until counsel reviews Regulation Z (the spec's "Limit for counsel"):
 * tfd-notes accepts up to 5200, so it is enforced here, on the note and again at each checkout. Pure: no clock, no
 * network, no store. The caller appends the note events to the note's stream, with the next `seq`.
 */
import {
	generateSchedule,
	NOTE_EVENT_SCHEMA,
	parseNoteEvent,
	statement,
} from "tfd-notes";
import type {
	AtmEvent,
	InstalmentCheckoutInput,
	InstalmentCheckoutResult,
	NoteEventSlot,
	NotePaymentRecorded,
	NoteReversalResult,
	PayLaterNoteCreated,
	PayLaterNoteInput,
	PayLaterNoteResult,
} from "../types.js";
import { MAX_LINE_TOTAL } from "./menu.js";
import {
	PAY_LATER_INSTALMENT_FIELD,
	PAY_LATER_NOTE_FIELD,
} from "./pay-later-fields.js";

/** Most instalments a Pay later note may have until counsel reviews Regulation Z. */
export const MAX_PAY_LATER_INSTALMENTS = 4;
/** The books take USD only, so a Pay later note is in USD. */
const PAY_LATER_CURRENCY = "USD";
const CENTS_EXPONENT = 2;
const ZERO_RATE = "0";
/** The smallest USD charge Stripe takes, in cents: an instalment below it could not be paid by checkout. */
const STRIPE_MIN_AMOUNT = 50n;
const CHECKOUT_METHOD = "checkout";

/** The `note.created` of a Pay later note, entered by the lender, or why not. */
export const payLaterNote = (input: PayLaterNoteInput): PayLaterNoteResult => {
	if (
		!Number.isInteger(input.count) ||
		input.count < 1 ||
		input.count > MAX_PAY_LATER_INSTALMENTS
	)
		return { ok: false, reason: "too_many_instalments", count: input.count };
	if (
		!Number.isInteger(input.principal) ||
		input.principal <= 0 ||
		input.principal > MAX_LINE_TOTAL
	)
		return { ok: false, reason: "bad_amount" };
	const event: PayLaterNoteCreated = {
		schema: NOTE_EVENT_SCHEMA,
		id: input.eventId,
		note_id: input.noteId,
		seq: 1,
		entered_at: input.enteredAt,
		entered_by: "lender",
		type: "note.created",
		terms: {
			currency: PAY_LATER_CURRENCY,
			exponent: CENTS_EXPONENT,
			principal_minor: String(input.principal),
			issue_date: input.issueDate,
			annual_rate: ZERO_RATE,
			day_count: "actual/365",
			rounding: "half-up",
			timezone: input.timeZone,
			schedule: {
				type: "amortized",
				frequency: input.frequency,
				count: input.count,
				first_due: input.firstDue,
			},
		},
	};
	let schedule: ReturnType<typeof generateSchedule>;
	try {
		const parsed = parseNoteEvent(event);
		schedule =
			parsed.type === "note.created" ? generateSchedule(parsed.terms) : [];
	} catch (error) {
		return {
			ok: false,
			reason: "bad_terms",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	// A small principal splits into instalments Stripe refuses (or of 0 cents: 5 cents in 4 is 2, 2, 1, 0).
	if (schedule.some((row) => BigInt(row.payment_minor) < STRIPE_MIN_AMOUNT))
		return { ok: false, reason: "bad_amount" };
	return { ok: true, event };
};

/**
 * The checkout for instalment `instalment` of a Pay later note, or why not. The amount is the schedule row's payment, but
 * never more than the lender view's payoff (a note paid ahead owes less on its last instalment). Throws when the stream
 * is not a valid note (tfd-notes' `validateStream`): that is the caller's data, not a buyer's choice.
 */
export const instalmentCheckoutParams = (
	input: InstalmentCheckoutInput,
): InstalmentCheckoutResult => {
	const read = statement([...input.noteEvents], input.asOf);
	// The stream may come in any order (tfd-notes orders it by `seq`); `statement` has checked it holds one `note.created`.
	const created = parseNoteEvent(
		input.noteEvents.find(
			(event) =>
				typeof event === "object" &&
				event !== null &&
				(event as { type?: unknown }).type === "note.created",
		),
	);
	const terms = created.type === "note.created" ? created.terms : null;
	if (
		!terms ||
		terms.currency !== PAY_LATER_CURRENCY ||
		terms.exponent !== CENTS_EXPONENT ||
		terms.annual_rate !== ZERO_RATE ||
		terms.schedule.type !== "amortized" ||
		terms.schedule.count > MAX_PAY_LATER_INSTALMENTS
	)
		return { ok: false, reason: "not_pay_later" };
	const row = read.schedule.find((r) => r.n === input.instalment);
	if (!row)
		return {
			ok: false,
			reason: "instalment_not_found",
			instalment: input.instalment,
		};
	const dueThrough = read.schedule
		.filter((r) => r.n <= input.instalment)
		.reduce((sum, r) => sum + BigInt(r.payment_minor), 0n);
	const paid = BigInt(read.lender.paid_minor);
	const payoff = BigInt(read.lender.payoff_minor);
	if (paid >= dueThrough || payoff === 0n)
		return {
			ok: false,
			reason: "instalment_paid",
			instalment: input.instalment,
		};
	const scheduled = BigInt(row.payment_minor);
	const amount = Number(scheduled < payoff ? scheduled : payoff);
	const metadata: Record<string, string> = {
		b4u_school: input.schoolId,
		family_id: input.familyId,
		[PAY_LATER_NOTE_FIELD]: read.note_id,
		[PAY_LATER_INSTALMENT_FIELD]: String(input.instalment),
	};
	return {
		ok: true,
		amount,
		params: {
			mode: "payment",
			client_reference_id: input.familyId,
			success_url: input.returnUrls.success,
			cancel_url: input.returnUrls.cancel,
			line_items: [
				{
					quantity: 1,
					price_data: {
						currency: PAY_LATER_CURRENCY.toLowerCase(),
						unit_amount: amount,
						product_data: { name: input.name },
					},
				},
			],
			metadata,
			// Checkout's session metadata does not reach the invoice; the handler finds the family and the note on the invoice.
			invoice_creation: {
				enabled: true,
				invoice_data: {
					metadata: { ...metadata },
					...(input.invoice?.description
						? { description: input.invoice.description }
						: {}),
					...(input.invoice?.footer ? { footer: input.invoice.footer } : {}),
				},
			},
		},
	};
};

const textAt = (
	record: Record<string, unknown>,
	key: string,
): string | null => {
	const value = record[key];
	return typeof value === "string" && value !== "" ? value : null;
};

/**
 * The note's `payment.recorded` for a paid instalment: the handler's `payment.succeeded` of an invoice that carries
 * `b4u_note` (its `labels.note`). Entered by the lender, which counts it in both views at once; the family can still
 * dispute it. The amount is the gross paid (Stripe's fee is B4 Uni's cost, not the family's), the date the payment's local
 * date in the books, and the reference the invoice id. Null for any other event.
 */
export const notePaymentEvent = (
	event: AtmEvent,
	slot: NoteEventSlot,
): NotePaymentRecorded | null => {
	const noteId = event.labels?.note;
	if (event.event_type !== "payment.succeeded" || !noteId) return null;
	const amount = event.payload.amount_paid;
	if (typeof amount !== "number" || !Number.isSafeInteger(amount)) return null;
	const reference = textAt(event.payload, "id");
	return {
		schema: NOTE_EVENT_SCHEMA,
		id: slot.eventId,
		note_id: noteId,
		seq: slot.seq,
		entered_at: slot.enteredAt,
		entered_by: "lender",
		type: "payment.recorded",
		kind: "payment",
		amount_minor: String(amount),
		value_date: event.date,
		method: CHECKOUT_METHOD,
		...(reference ? { reference } : {}),
	};
};

/**
 * The whole `reversal` of an instalment's payment, from the handler's `payment.refunded` once the charge is refunded in
 * full (`payload.amount_refunded`, the charge's total refunded so far). `payment` is the note's `payment.recorded` whose
 * `reference` is the refunded invoice (`payload.invoice`).
 */
export const noteReversalEvent = (
	refund: AtmEvent,
	payment: NotePaymentRecorded,
	slot: NoteEventSlot,
): NoteReversalResult => {
	const invoice = textAt(refund.payload, "invoice");
	if (
		refund.event_type !== "payment.refunded" ||
		payment.kind !== "payment" ||
		!invoice ||
		invoice !== payment.reference
	)
		return { ok: false, reason: "not_this_payment" };
	const paid = Number(payment.amount_minor);
	const refundedTotal = refund.payload.amount_refunded;
	const refunded =
		typeof refundedTotal === "number" ? refundedTotal : Number.NaN;
	if (refunded !== paid)
		return { ok: false, reason: "partial_refund", refunded, paid };
	return {
		ok: true,
		event: {
			schema: NOTE_EVENT_SCHEMA,
			id: slot.eventId,
			note_id: payment.note_id,
			seq: slot.seq,
			entered_at: slot.enteredAt,
			entered_by: "lender",
			type: "payment.recorded",
			kind: "reversal",
			amount_minor: payment.amount_minor,
			value_date: refund.date,
			method: CHECKOUT_METHOD,
			reference: refund.idem,
			reverses: payment.id,
		},
	};
};
