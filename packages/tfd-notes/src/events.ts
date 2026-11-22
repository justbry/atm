// SPDX-License-Identifier: Apache-2.0
/**
 * Hand-written, dependency-free validation of `tfd.note-event.v1` events and of a whole note stream
 * (docs/specs/promissory-notes.md R-1, R-2, R-3, R-6, R-7, R-10 to R-14, AC-3, AC-6).
 *
 * `parseNoteEvent` checks one event's shape. `validateStream` parses each event, orders by `seq`, and enforces the
 * rules that need other events: one `note.created` first, one `note_id`, no gap or repeat in `seq`, unique ids,
 * references to earlier events, and the two-party roles. Every error is a plain `Error` whose message names the event
 * type and the field.
 */

import { addDays, addMonthsAnchored } from "./date.js";
import {
	type AnnotationAddedEvent,
	NOTE_EVENT_SCHEMA,
	type NoteCreatedEvent,
	type NoteEvent,
	type NoteTerms,
	type PaymentConfirmedEvent,
	type PaymentDisputedEvent,
	type PaymentRecordedEvent,
	type PaymentResolvedEvent,
	type PaymentSource,
	type Role,
	type ScheduleTerms,
} from "./types.js";

type JsonRecord = Record<string, unknown>;
type BaseFields = Pick<
	NoteCreatedEvent,
	"schema" | "id" | "note_id" | "seq" | "entered_at" | "entered_by"
>;

const MONEY_PATTERN = /^(0|[1-9][0-9]*)$/;
const RATE_PATTERN = /^(0|0\.[0-9]{1,6})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_PATTERN =
	/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?Z$/;

const MAX_EXPONENT = 4;
/** The most installments an amortized schedule may have (R-8); the schedule generator refuses more. */
const MAX_INSTALLMENTS = 5200;
const WEEK_DAYS = 7;
const BIWEEK_DAYS = 14;
const FIRST_SEQ = 1;
const FEBRUARY = 2;
const LEAP_YEAR_CYCLE = 4;
const CENTURY = 100;
const LEAP_CENTURY_CYCLE = 400;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const BASE_KEYS = [
	"schema",
	"id",
	"note_id",
	"seq",
	"entered_at",
	"entered_by",
	"type",
] as const;
const ROLES = ["lender", "borrower"] as const;
const FREQUENCIES = ["weekly", "biweekly", "monthly"] as const;
const PAYMENT_KINDS = ["payment", "reversal"] as const;
// `both-agree` is derived from a confirmation and never typed (R-14), so the validator does not accept it.
const TYPED_SOURCES = ["lender-states", "borrower-states"] as const;
const EVENT_TYPES = [
	"note.created",
	"payment.recorded",
	"payment.confirmed",
	"payment.disputed",
	"payment.resolved",
	"annotation.added",
] as const;

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const show = (value: unknown): string => {
	if (typeof value === "string") return JSON.stringify(value);
	if (isRecord(value)) return "an object";
	if (Array.isArray(value)) return "an array";
	return String(value);
};

// A function declaration, not an arrow: only declarations with an explicit `never` type narrow the caller's flow.
function fail(label: string, message: string): never {
	throw new Error(`${label}: ${message}`);
}

const isLeapYear = (year: number): boolean =>
	year % LEAP_YEAR_CYCLE === 0 &&
	(year % CENTURY !== 0 || year % LEAP_CENTURY_CYCLE === 0);

const isCalendarDate = (text: string): boolean => {
	const match = DATE_PATTERN.exec(text);
	if (match === null) return false;
	const year = Number.parseInt(match[1], 10);
	const month = Number.parseInt(match[2], 10);
	const day = Number.parseInt(match[3], 10);
	if (year < 1 || month < 1 || month > DAYS_IN_MONTH.length) return false;
	const daysInMonth =
		month === FEBRUARY && isLeapYear(year)
			? DAYS_IN_MONTH[month - 1] + 1
			: DAYS_IN_MONTH[month - 1];
	return day >= 1 && day <= daysInMonth;
};

const isOneOf = <Choice extends string>(
	choices: readonly Choice[],
	value: unknown,
): value is Choice => choices.some((choice) => choice === value);

/** Rejects a missing required key and any key outside the required and optional lists. */
const checkKeys = (
	record: JsonRecord,
	label: string,
	prefix: string,
	required: readonly string[],
	optional: readonly string[],
): void => {
	for (const key of required) {
		if (!(key in record)) fail(label, `${prefix}${key} is required`);
	}
	for (const key of Object.keys(record)) {
		if (!(required.includes(key) || optional.includes(key))) {
			fail(label, `${prefix}${key} is not allowed`);
		}
	}
};

const readString = (label: string, path: string, value: unknown): string => {
	if (typeof value !== "string" || value.length === 0) {
		return fail(
			label,
			`${path} must be a non-empty string, got ${show(value)}`,
		);
	}
	return value;
};

const readText = (label: string, path: string, value: unknown): string => {
	if (typeof value !== "string") {
		return fail(label, `${path} must be a string, got ${show(value)}`);
	}
	return value;
};

/** Money of at least one minor unit, for fields that must be positive (the principal). */
const readPositiveMoney = (
	label: string,
	path: string,
	value: unknown,
): string => {
	const money = readMoney(label, path, value);
	if (money === "0") {
		return fail(label, `${path} must be at least 1 minor unit, got "0"`);
	}
	return money;
};

const readMoney = (label: string, path: string, value: unknown): string => {
	if (typeof value !== "string" || !MONEY_PATTERN.test(value)) {
		return fail(
			label,
			`${path} must be a non-negative integer digit string of minor units, got ${show(value)}`,
		);
	}
	return value;
};

const readDate = (label: string, path: string, value: unknown): string => {
	if (typeof value !== "string" || !isCalendarDate(value)) {
		return fail(
			label,
			`${path} must be a calendar date YYYY-MM-DD, got ${show(value)}`,
		);
	}
	return value;
};

const readSha256 = (label: string, path: string, value: unknown): string => {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		return fail(
			label,
			`${path} must be 64 lowercase hex characters, got ${show(value)}`,
		);
	}
	return value;
};

const readInstant = (label: string, path: string, value: unknown): string => {
	const match = typeof value === "string" ? INSTANT_PATTERN.exec(value) : null;
	if (
		typeof value !== "string" ||
		match === null ||
		!isCalendarDate(match[1])
	) {
		return fail(
			label,
			`${path} must be an ISO 8601 UTC instant ending in Z, got ${show(value)}`,
		);
	}
	return value;
};

const readRole = (label: string, path: string, value: unknown): Role => {
	if (!isOneOf(ROLES, value)) {
		return fail(
			label,
			`${path} must be "lender" or "borrower", got ${show(value)}`,
		);
	}
	return value;
};

/** An integer from 1 to `maximum`, itself at most 2^53 - 1 (the schema's `maximum`), so it is exact in a `number`. */
const readPositiveInteger = (
	label: string,
	path: string,
	value: unknown,
	maximum = Number.MAX_SAFE_INTEGER,
): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		return fail(
			label,
			`${path} must be an integer of at least 1, got ${show(value)}`,
		);
	}
	if (value > maximum) {
		return fail(
			label,
			`${path} must be an integer from 1 to ${maximum}, got ${show(value)}`,
		);
	}
	return value;
};

const readBase = (record: JsonRecord, label: string): BaseFields => {
	if (record.schema !== NOTE_EVENT_SCHEMA) {
		fail(
			label,
			`schema must be "${NOTE_EVENT_SCHEMA}", got ${show(record.schema)}`,
		);
	}
	return {
		schema: NOTE_EVENT_SCHEMA,
		id: readString(label, "id", record.id),
		note_id: readString(label, "note_id", record.note_id),
		seq: readPositiveInteger(label, "seq", record.seq),
		entered_at: readInstant(label, "entered_at", record.entered_at),
		entered_by: readRole(label, "entered_by", record.entered_by),
	};
};

/** The due date of installment `index` (from 0) counted from `firstDue`, the same way the schedule generator does. */
const dueDateAt = (
	firstDue: string,
	frequency: (typeof FREQUENCIES)[number],
	index: number,
): string => {
	if (frequency === "weekly") return addDays(firstDue, WEEK_DAYS * index);
	if (frequency === "biweekly") return addDays(firstDue, BIWEEK_DAYS * index);
	return addMonthsAnchored(firstDue, index);
};

const readAmortized = (
	label: string,
	issueDate: string,
	value: JsonRecord,
	frequency: (typeof FREQUENCIES)[number],
): ScheduleTerms => {
	const count = readPositiveInteger(
		label,
		"terms.schedule.count",
		value.count,
		MAX_INSTALLMENTS,
	);
	const firstDue = readDate(label, "terms.schedule.first_due", value.first_due);
	if (firstDue <= issueDate) {
		fail(
			label,
			`terms.schedule.first_due ${firstDue} must be after issue_date ${issueDate}`,
		);
	}
	try {
		dueDateAt(firstDue, frequency, count - 1);
	} catch {
		fail(
			label,
			`terms.schedule.count ${count} puts the last due date beyond year 9999`,
		);
	}
	return { type: "amortized", frequency, count, first_due: firstDue };
};

const readSchedule = (
	label: string,
	issueDate: string,
	value: unknown,
): ScheduleTerms => {
	if (!isRecord(value)) {
		return fail(label, `terms.schedule must be an object, got ${show(value)}`);
	}
	const path = "terms.schedule.";
	if (value.type === "none") {
		checkKeys(value, label, path, ["type"], []);
		return { type: "none" };
	}
	if (value.type === "amortized") {
		checkKeys(
			value,
			label,
			path,
			["type", "frequency", "count", "first_due"],
			[],
		);
		if (!isOneOf(FREQUENCIES, value.frequency)) {
			return fail(
				label,
				`terms.schedule.frequency must be "weekly", "biweekly" or "monthly", got ${show(value.frequency)}`,
			);
		}
		return readAmortized(label, issueDate, value, value.frequency);
	}
	if (value.type === "custom") {
		checkKeys(value, label, path, ["type", "installments"], []);
		return {
			type: "custom",
			installments: readInstallments(label, issueDate, value.installments),
		};
	}
	return fail(
		label,
		`terms.schedule.type must be "amortized", "custom" or "none", got ${show(value.type)}`,
	);
};

const readInstallments = (
	label: string,
	issueDate: string,
	value: unknown,
): { due: string; amount_minor: string }[] => {
	if (!Array.isArray(value) || value.length === 0) {
		return fail(label, "terms.schedule.installments must be a non-empty array");
	}
	const installments: { due: string; amount_minor: string }[] = [];
	let previousDue = issueDate;
	let previousName = "issue_date";
	for (const [index, item] of value.entries()) {
		const path = `terms.schedule.installments[${index}]`;
		if (!isRecord(item)) {
			return fail(label, `${path} must be an object, got ${show(item)}`);
		}
		checkKeys(item, label, `${path}.`, ["due", "amount_minor"], []);
		const due = readDate(label, `${path}.due`, item.due);
		if (due <= previousDue) {
			fail(
				label,
				`${path}.due ${due} must be after ${previousName} ${previousDue}`,
			);
		}
		installments.push({
			due,
			amount_minor: readMoney(label, `${path}.amount_minor`, item.amount_minor),
		});
		previousDue = due;
		previousName = `installments[${index}].due`;
	}
	return installments;
};

const readTerms = (label: string, value: unknown): NoteTerms => {
	if (!isRecord(value)) {
		return fail(label, `terms must be an object, got ${show(value)}`);
	}
	checkKeys(
		value,
		label,
		"terms.",
		[
			"currency",
			"exponent",
			"principal_minor",
			"issue_date",
			"annual_rate",
			"day_count",
			"rounding",
			"timezone",
			"schedule",
		],
		["document_sha256"],
	);
	if (
		typeof value.currency !== "string" ||
		!CURRENCY_PATTERN.test(value.currency)
	) {
		fail(
			label,
			`terms.currency must be three capital letters, got ${show(value.currency)}`,
		);
	}
	const exponent = value.exponent;
	if (
		typeof exponent !== "number" ||
		!Number.isInteger(exponent) ||
		exponent < 0 ||
		exponent > MAX_EXPONENT
	) {
		fail(
			label,
			`terms.exponent must be an integer from 0 to ${MAX_EXPONENT}, got ${show(exponent)}`,
		);
	}
	if (
		typeof value.annual_rate !== "string" ||
		!RATE_PATTERN.test(value.annual_rate)
	) {
		fail(
			label,
			`terms.annual_rate must be a decimal string below 1 with at most 6 places, got ${show(value.annual_rate)}`,
		);
	}
	if (value.day_count !== "actual/365") {
		fail(
			label,
			`terms.day_count must be "actual/365", got ${show(value.day_count)}`,
		);
	}
	if (value.rounding !== "half-up") {
		fail(
			label,
			`terms.rounding must be "half-up", got ${show(value.rounding)}`,
		);
	}
	const issueDate = readDate(label, "terms.issue_date", value.issue_date);
	const terms: NoteTerms = {
		currency: value.currency,
		exponent,
		principal_minor: readPositiveMoney(
			label,
			"terms.principal_minor",
			value.principal_minor,
		),
		issue_date: issueDate,
		annual_rate: value.annual_rate,
		day_count: "actual/365",
		rounding: "half-up",
		timezone: readString(label, "terms.timezone", value.timezone),
		schedule: readSchedule(label, issueDate, value.schedule),
	};
	if ("document_sha256" in value) {
		terms.document_sha256 = readSha256(
			label,
			"terms.document_sha256",
			value.document_sha256,
		);
	}
	return terms;
};

const parseNoteCreated = (record: JsonRecord): NoteCreatedEvent => {
	const label = "note.created";
	checkKeys(record, label, "", [...BASE_KEYS, "terms"], []);
	const base = readBase(record, label);
	return {
		...base,
		type: "note.created",
		terms: readTerms(label, record.terms),
	};
};

const parsePaymentRecorded = (record: JsonRecord): PaymentRecordedEvent => {
	const label = "payment.recorded";
	checkKeys(
		record,
		label,
		"",
		[...BASE_KEYS, "kind", "amount_minor", "value_date"],
		["method", "reference", "reverses", "source"],
	);
	const base = readBase(record, label);
	if (!isOneOf(PAYMENT_KINDS, record.kind)) {
		return fail(
			label,
			`kind must be "payment" or "reversal", got ${show(record.kind)}`,
		);
	}
	const kind = record.kind;
	const event: PaymentRecordedEvent = {
		...base,
		type: "payment.recorded",
		kind,
		amount_minor: readMoney(label, "amount_minor", record.amount_minor),
		value_date: readDate(label, "value_date", record.value_date),
	};
	if (kind === "reversal" && !("reverses" in record)) {
		fail(label, "reverses is required when kind is reversal");
	}
	if (kind === "payment" && "reverses" in record) {
		fail(label, "reverses is only allowed when kind is reversal");
	}
	if ("reverses" in record) {
		event.reverses = readString(label, "reverses", record.reverses);
	}
	if ("method" in record) {
		event.method = readText(label, "method", record.method);
	}
	if ("reference" in record) {
		event.reference = readText(label, "reference", record.reference);
	}
	if ("source" in record) {
		event.source = readSource(label, record.source);
	}
	return event;
};

const readSource = (label: string, value: unknown): PaymentSource => {
	if (value === "both-agree") {
		return fail(
			label,
			'source "both-agree" is derived from a confirmation and cannot be recorded',
		);
	}
	if (!isOneOf(TYPED_SOURCES, value)) {
		return fail(
			label,
			`source must be "lender-states" or "borrower-states", got ${show(value)}`,
		);
	}
	return value;
};

const parsePaymentConfirmed = (record: JsonRecord): PaymentConfirmedEvent => {
	const label = "payment.confirmed";
	checkKeys(record, label, "", [...BASE_KEYS, "target"], []);
	const base = readBase(record, label);
	return {
		...base,
		type: "payment.confirmed",
		target: readString(label, "target", record.target),
	};
};

const parsePaymentDisputed = (record: JsonRecord): PaymentDisputedEvent => {
	const label = "payment.disputed";
	checkKeys(
		record,
		label,
		"",
		[...BASE_KEYS, "target", "counter_amount_minor", "reason"],
		[],
	);
	const base = readBase(record, label);
	return {
		...base,
		type: "payment.disputed",
		target: readString(label, "target", record.target),
		counter_amount_minor: readMoney(
			label,
			"counter_amount_minor",
			record.counter_amount_minor,
		),
		reason: readString(label, "reason", record.reason),
	};
};

const parsePaymentResolved = (record: JsonRecord): PaymentResolvedEvent => {
	const label = "payment.resolved";
	checkKeys(
		record,
		label,
		"",
		[...BASE_KEYS, "target", "agreed_amount_minor"],
		[],
	);
	const base = readBase(record, label);
	return {
		...base,
		type: "payment.resolved",
		target: readString(label, "target", record.target),
		agreed_amount_minor: readMoney(
			label,
			"agreed_amount_minor",
			record.agreed_amount_minor,
		),
	};
};

const parseAnnotationAdded = (record: JsonRecord): AnnotationAddedEvent => {
	const label = "annotation.added";
	checkKeys(
		record,
		label,
		"",
		[...BASE_KEYS, "text"],
		["attachment_sha256", "target"],
	);
	const base = readBase(record, label);
	const event: AnnotationAddedEvent = {
		...base,
		type: "annotation.added",
		text: readString(label, "text", record.text),
	};
	if ("attachment_sha256" in record) {
		event.attachment_sha256 = readSha256(
			label,
			"attachment_sha256",
			record.attachment_sha256,
		);
	}
	if ("target" in record) {
		event.target = readString(label, "target", record.target);
	}
	return event;
};

/** Validates one event's shape and returns it typed. Throws an `Error` naming the event type and the field. */
export const parseNoteEvent = (value: unknown): NoteEvent => {
	if (!isRecord(value)) {
		return fail("event", `must be an object, got ${show(value)}`);
	}
	switch (value.type) {
		case "note.created":
			return parseNoteCreated(value);
		case "payment.recorded":
			return parsePaymentRecorded(value);
		case "payment.confirmed":
			return parsePaymentConfirmed(value);
		case "payment.disputed":
			return parsePaymentDisputed(value);
		case "payment.resolved":
			return parsePaymentResolved(value);
		case "annotation.added":
			return parseAnnotationAdded(value);
		default:
			return fail(
				"event",
				`type must be one of ${EVENT_TYPES.join(", ")}, got ${show(value.type)}`,
			);
	}
};

interface StreamState {
	issueDate: string;
	noteId: string;
	/** Every event id seen so far, with the type and seq that owns it. */
	seen: Map<string, NoteEvent>;
	recorded: Map<string, PaymentRecordedEvent>;
	disputed: Set<string>;
	/** Each reversed payment's id, with the reversal that undoes it (R-9a: at most once). */
	reversedBy: Map<string, PaymentRecordedEvent>;
}

function streamFail(event: NoteEvent, message: string): never {
	return fail(event.type, `seq ${event.seq}: ${message}`);
}

/** Resolves `target` to an earlier payment.recorded event, or throws. */
const findRecorded = (
	state: StreamState,
	event: NoteEvent,
	field: string,
	target: string,
): PaymentRecordedEvent => {
	const recorded = state.recorded.get(target);
	if (recorded !== undefined) return recorded;
	const other = state.seen.get(target);
	if (other !== undefined) {
		return streamFail(
			event,
			`${field} ${show(target)} has type ${other.type}, not payment.recorded`,
		);
	}
	return streamFail(
		event,
		`${field} ${show(target)} does not match an earlier payment.recorded event`,
	);
};

const checkResponder = (
	state: StreamState,
	event: PaymentConfirmedEvent | PaymentDisputedEvent,
	verb: string,
): void => {
	const recorded = findRecorded(state, event, "target", event.target);
	if (recorded.entered_by === event.entered_by) {
		streamFail(
			event,
			`${event.entered_by} cannot ${verb} a payment the ${event.entered_by} recorded (${show(event.target)})`,
		);
	}
};

const checkPaymentRecorded = (
	state: StreamState,
	event: PaymentRecordedEvent,
): void => {
	if (event.value_date < state.issueDate) {
		streamFail(
			event,
			`value_date ${event.value_date} is before issue_date ${state.issueDate}`,
		);
	}
	if (event.reverses === undefined) return;
	const target = findRecorded(state, event, "reverses", event.reverses);
	if (target.kind !== "payment") {
		streamFail(
			event,
			`reverses ${show(event.reverses)} must be a payment, not a ${target.kind}`,
		);
	}
	if (event.amount_minor !== target.amount_minor) {
		streamFail(
			event,
			`a reversal undoes one whole payment: amount_minor ${event.amount_minor} differs from the ${target.amount_minor} of ${show(event.reverses)}`,
		);
	}
	if (event.value_date < target.value_date) {
		streamFail(
			event,
			`value_date ${event.value_date} is before the ${target.value_date} of the payment ${show(event.reverses)} it reverses`,
		);
	}
	const earlier = state.reversedBy.get(target.id);
	if (earlier !== undefined) {
		streamFail(
			event,
			`payment ${show(target.id)} is already reversed by ${show(earlier.id)} (seq ${earlier.seq}); ${show(event.id)} cannot reverse it again`,
		);
	}
};

const checkEventAgainstStream = (
	state: StreamState,
	event: NoteEvent,
): void => {
	switch (event.type) {
		case "note.created":
			return;
		case "payment.recorded":
			checkPaymentRecorded(state, event);
			return;
		case "payment.confirmed":
			checkResponder(state, event, "confirm");
			return;
		case "payment.disputed":
			checkResponder(state, event, "dispute");
			return;
		case "payment.resolved":
			findRecorded(state, event, "target", event.target);
			if (!state.disputed.has(event.target)) {
				streamFail(
					event,
					`target ${show(event.target)} has no earlier payment.disputed event`,
				);
			}
			return;
		case "annotation.added":
			if (event.target !== undefined && !state.seen.has(event.target)) {
				streamFail(
					event,
					`target ${show(event.target)} does not match an earlier event`,
				);
			}
			return;
		default:
			return;
	}
};

const recordInState = (state: StreamState, event: NoteEvent): void => {
	state.seen.set(event.id, event);
	if (event.type === "payment.recorded") {
		state.recorded.set(event.id, event);
		if (event.reverses !== undefined)
			state.reversedBy.set(event.reverses, event);
	}
	if (event.type === "payment.disputed") state.disputed.add(event.target);
};

const orderBySeq = (events: NoteEvent[]): NoteEvent[] => {
	const ordered = [...events].sort((left, right) => left.seq - right.seq);
	for (const [index, event] of ordered.entries()) {
		const previous = ordered[index - 1];
		if (previous !== undefined && previous.seq === event.seq) {
			fail("stream", `seq ${event.seq} is repeated`);
		}
		if (event.seq !== index + FIRST_SEQ) {
			fail(
				"stream",
				`seq has a gap: expected ${index + FIRST_SEQ}, found ${event.seq}`,
			);
		}
	}
	return ordered;
};

/**
 * Parses every event, orders them by `seq`, and enforces the stream rules. Returns the events in `seq` order, so the
 * same events in any input order give the same result (AC-3). Throws an `Error` on the first violation.
 */
export const validateStream = (events: unknown[]): NoteEvent[] => {
	if (events.length === 0) fail("stream", "must contain at least one event");
	const parsed: NoteEvent[] = [];
	for (const [index, value] of events.entries()) {
		try {
			parsed.push(parseNoteEvent(value));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`events[${index}]: ${message}`);
		}
	}
	const ordered = orderBySeq(parsed);
	const [first] = ordered;
	if (first === undefined || first.type !== "note.created") {
		return fail("stream", "the first event (seq 1) must be note.created");
	}
	const state: StreamState = {
		issueDate: first.terms.issue_date,
		noteId: first.note_id,
		seen: new Map(),
		recorded: new Map(),
		disputed: new Set(),
		reversedBy: new Map(),
	};
	for (const event of ordered) {
		if (event.note_id !== state.noteId) {
			streamFail(
				event,
				`note_id ${show(event.note_id)} differs from ${show(state.noteId)}`,
			);
		}
		if (event !== first && event.type === "note.created") {
			streamFail(event, "note.created is only allowed as the first event");
		}
		const owner = state.seen.get(event.id);
		if (owner !== undefined) {
			streamFail(
				event,
				`id ${show(event.id)} is already used by seq ${owner.seq}`,
			);
		}
		checkEventAgainstStream(state, event);
		recordInState(state, event);
	}
	return ordered;
};
