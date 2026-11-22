// SPDX-License-Identifier: Apache-2.0
/**
 * The shared contract of tfd-notes (docs/specs/promissory-notes.md). Every other file in this package builds on these
 * shapes. Money and rates cross the JSON boundary as strings; inside the engine they are `bigint`.
 */

/** `YYYY-MM-DD`, a calendar date with no zone. */
export type CivilDate = string;

export type Role = "lender" | "borrower";

export const ENGINE_VERSION = "tfd-notes/1";
export const NOTE_EVENT_SCHEMA = "tfd.note-event.v1";

/** An integer count of minor units, as digits: `"35000"`. No event field is negative; a reversal is its own event kind. */
export type MinorString = string;

export type Frequency = "weekly" | "biweekly" | "monthly";

export type ScheduleTerms =
	| {
			type: "amortized";
			frequency: Frequency;
			/** Installments, at least 1. */
			count: number;
			first_due: CivilDate;
	  }
	| {
			type: "custom";
			/** Strictly increasing due dates after `issue_date`. */
			installments: { due: CivilDate; amount_minor: MinorString }[];
	  }
	| { type: "none" };

export interface NoteTerms {
	/** ISO 4217 code, three capital letters. */
	currency: string;
	/** Decimal places of the minor unit, 0 to 4. */
	exponent: number;
	principal_minor: MinorString;
	issue_date: CivilDate;
	/** Nominal annual rate as a decimal string with at most 6 places: `"0.0525"`, `"0"`. */
	annual_rate: string;
	day_count: "actual/365";
	rounding: "half-up";
	/** IANA zone the caller uses to turn an instant into a civil date. */
	timezone: string;
	schedule: ScheduleTerms;
	/** Optional sha256 hex of the signed document. */
	document_sha256?: string;
}

export interface ScheduleRow {
	n: number;
	due: CivilDate;
	payment_minor: MinorString;
	interest_minor: MinorString;
	principal_minor: MinorString;
	balance_after_minor: MinorString;
}

/** Who states a backfilled payment. `both-agree` is derived from a confirmation (R-14) and is never recorded. */
export type PaymentSource = "lender-states" | "borrower-states";

interface EventBase {
	schema: typeof NOTE_EVENT_SCHEMA;
	/** Unique event id (ULID or similar; opaque to the engine). */
	id: string;
	note_id: string;
	/** Per-note sequence: starts at 1, no gaps, no repeats. */
	seq: number;
	/** UTC instant the event was entered, ISO 8601 with `Z`. */
	entered_at: string;
	entered_by: Role;
}

export interface NoteCreatedEvent extends EventBase {
	type: "note.created";
	terms: NoteTerms;
}

export interface PaymentRecordedEvent extends EventBase {
	type: "payment.recorded";
	/** `payment` is the borrower paying the lender; `reversal` takes a recorded payment back (a bounced check). */
	kind: "payment" | "reversal";
	amount_minor: MinorString;
	value_date: CivilDate;
	method?: string;
	reference?: string;
	/** Required when `kind` is `reversal`: the `id` of the payment event it reverses. */
	reverses?: string;
	/** Present on a backfilled past payment. */
	source?: PaymentSource;
}

export interface PaymentConfirmedEvent extends EventBase {
	type: "payment.confirmed";
	/** The `id` of the payment.recorded event confirmed. Covers that one event only. */
	target: string;
}

export interface PaymentDisputedEvent extends EventBase {
	type: "payment.disputed";
	target: string;
	/** What the disputing party says the amount was. Required. */
	counter_amount_minor: MinorString;
	/** Required, non-empty. */
	reason: string;
}

export interface PaymentResolvedEvent extends EventBase {
	type: "payment.resolved";
	/** The `id` of the payment.recorded event whose dispute is settled. */
	target: string;
	agreed_amount_minor: MinorString;
}

export interface AnnotationAddedEvent extends EventBase {
	type: "annotation.added";
	text: string;
	attachment_sha256?: string;
	/** Optional `id` of the event the note is about. */
	target?: string;
}

export type NoteEvent =
	| NoteCreatedEvent
	| PaymentRecordedEvent
	| PaymentConfirmedEvent
	| PaymentDisputedEvent
	| PaymentResolvedEvent
	| AnnotationAddedEvent;

/** What one party's count of the loan is on a date. */
export interface Balance {
	principal_minor: MinorString;
	/** Accrued unpaid interest, rounded half up. */
	interest_minor: MinorString;
	/** principal + interest. */
	payoff_minor: MinorString;
	paid_minor: MinorString;
	/** Amount paid beyond the payoff, never applied. */
	overpaid_minor: MinorString;
}

export type PaymentStatus =
	| "confirmed"
	| "claimed-by-lender"
	| "claimed-by-borrower"
	| "disputed"
	| "resolved"
	| "reversed";

/** One payment's line in the itemised difference between the two views. */
export interface DifferenceItem {
	event_id: string;
	value_date: CivilDate;
	status: PaymentStatus;
	lender_counts_minor: MinorString;
	borrower_counts_minor: MinorString;
	/** `lender − borrower`: positive when the lender counts more paid. */
	difference_minor: MinorString;
	/** Whole days from `entered_at` to the `as_of` date while unanswered, else null. */
	unanswered_days: number | null;
	reason?: string;
	/** The payment's `source` when it was backfilled (R-14). */
	source?: PaymentSource;
}

export interface Statement {
	engine_version: typeof ENGINE_VERSION;
	note_id: string;
	currency: string;
	exponent: number;
	as_of: CivilDate;
	schedule: ScheduleRow[];
	lender: Balance;
	borrower: Balance;
	/** Only payments the two views count differently. */
	difference: DifferenceItem[];
	/** `lender payoff − borrower payoff`; positive means the lender says more is owed. */
	payoff_gap_minor: MinorString;
	expected: {
		/** Cumulative installments due on or before `as_of`. */
		due_to_date_minor: MinorString;
		/** Per view, cumulative paid. */
		lender_paid_minor: MinorString;
		borrower_paid_minor: MinorString;
		lender_overdue_minor: MinorString;
		borrower_overdue_minor: MinorString;
		lender_days_overdue: number;
		borrower_days_overdue: number;
	};
}
