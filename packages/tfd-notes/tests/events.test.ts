// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import schema from "../schema/note-event.v1.json";
import { parseNoteEvent, validateStream } from "../src/events.js";
import type { NoteEvent } from "../src/types.js";

type Fields = Record<string, unknown>;

const NOTE_ID = "note-1";

const TERMS: Fields = {
	currency: "USD",
	exponent: 2,
	principal_minor: "1000000",
	issue_date: "2026-01-15",
	annual_rate: "0.05",
	day_count: "actual/365",
	rounding: "half-up",
	timezone: "America/Denver",
	schedule: {
		type: "amortized",
		frequency: "monthly",
		count: 36,
		first_due: "2026-02-15",
	},
};

const make = (
	seq: number,
	type: string,
	enteredBy: string,
	fields: Fields,
): Fields => ({
	schema: "tfd.note-event.v1",
	id: `evt-${seq}`,
	note_id: NOTE_ID,
	seq,
	entered_at: "2026-02-01T12:00:00Z",
	entered_by: enteredBy,
	type,
	...fields,
});

const created = (fields: Fields = {}): Fields =>
	make(1, "note.created", "lender", { terms: TERMS, ...fields });
const recorded = (
	seq: number,
	enteredBy: string,
	fields: Fields = {},
): Fields =>
	make(seq, "payment.recorded", enteredBy, {
		kind: "payment",
		amount_minor: "35000",
		value_date: "2026-02-10",
		...fields,
	});
const confirmed = (seq: number, enteredBy: string, target: string): Fields =>
	make(seq, "payment.confirmed", enteredBy, { target });
const disputed = (
	seq: number,
	enteredBy: string,
	target: string,
	fields: Fields = {},
): Fields =>
	make(seq, "payment.disputed", enteredBy, {
		target,
		counter_amount_minor: "30000",
		reason: "I handed over 300",
		...fields,
	});
const resolved = (seq: number, enteredBy: string, target: string): Fields =>
	make(seq, "payment.resolved", enteredBy, {
		target,
		agreed_amount_minor: "32000",
	});
const annotation = (seq: number, fields: Fields = {}): Fields =>
	make(seq, "annotation.added", "lender", { text: "Paid in cash", ...fields });

const without = (record: Fields, key: string): Fields => {
	const copy = { ...record };
	delete copy[key];
	return copy;
};

const withTerms = (changes: Fields): Fields =>
	created({ terms: { ...TERMS, ...changes } });

const withSchedule = (schedule: Fields): Fields => withTerms({ schedule });

const custom = (dates: string[]): Fields =>
	withSchedule({
		type: "custom",
		installments: dates.map((due) => ({ due, amount_minor: "1000" })),
	});

const SHA = "a".repeat(64);
// Read by key name: a literal `then` property trips the noThenProperty lint rule.
const THEN_KEY = "then";

describe("parseNoteEvent accepts", () => {
	const valid: [string, Fields][] = [
		["note.created", created()],
		[
			"note.created with a custom schedule and a document hash",
			withTerms({
				document_sha256: SHA,
				schedule: {
					type: "custom",
					installments: [
						{ due: "2026-06-15", amount_minor: "0" },
						{ due: "2027-01-15", amount_minor: "1000000" },
					],
				},
			}),
		],
		["note.created with no schedule", withSchedule({ type: "none" })],
		["rate 0", withTerms({ annual_rate: "0" })],
		["rate with 6 places", withTerms({ annual_rate: "0.052500" })],
		["exponent 0", withTerms({ exponent: 0 })],
		["exponent 4", withTerms({ exponent: 4 })],
		["issue date on a leap day", withTerms({ issue_date: "2024-02-29" })],
		[
			"issue date on a 400-year leap day",
			withTerms({ issue_date: "2000-02-29" }),
		],
		["payment.recorded", recorded(2, "borrower")],
		[
			"payment.recorded with every optional field",
			recorded(2, "lender", {
				method: "transfer",
				reference: "TX-9",
				source: "lender-states",
			}),
		],
		["zero amount", recorded(2, "borrower", { amount_minor: "0" })],
		[
			"reversal with reverses",
			recorded(3, "lender", { kind: "reversal", reverses: "evt-2" }),
		],
		["payment.confirmed", confirmed(3, "lender", "evt-2")],
		["payment.disputed", disputed(3, "lender", "evt-2")],
		[
			"zero counter amount",
			disputed(3, "lender", "evt-2", { counter_amount_minor: "0" }),
		],
		["payment.resolved", resolved(4, "lender", "evt-2")],
		["annotation.added", annotation(5)],
		[
			"annotation.added with attachment and target",
			annotation(5, { attachment_sha256: SHA, target: "evt-2" }),
		],
	];
	for (const [name, event] of valid) {
		it(name, () => {
			const parsed = parseNoteEvent(event);
			expect(parsed.type).toBe(event.type as NoteEvent["type"]);
			expect(parsed).toEqual(event as unknown as NoteEvent);
		});
	}

	it("entered_at with fractional seconds", () => {
		const parsed = parseNoteEvent({
			...confirmed(3, "lender", "evt-2"),
			entered_at: "2026-02-01T12:00:00.123Z",
		});
		expect(parsed.entered_at).toBe("2026-02-01T12:00:00.123Z");
	});
});

describe("parseNoteEvent rejects", () => {
	const invalid: [string, unknown, string][] = [
		["null", null, "event: must be an object"],
		["an array", [], "event: must be an object"],
		["a string", "note.created", "event: must be an object"],
		[
			"a missing type",
			without(created(), "type"),
			"event: type must be one of",
		],
		[
			"an unknown type",
			make(2, "loan.forgiven", "lender", {}),
			"event: type must be one of",
		],
		[
			"a wrong schema",
			{ ...created(), schema: "tfd.note-event.v2" },
			"note.created: schema must be",
		],
		["a missing id", without(created(), "id"), "note.created: id is required"],
		[
			"an empty id",
			{ ...created(), id: "" },
			"note.created: id must be a non-empty string",
		],
		[
			"an empty note_id",
			{ ...created(), note_id: "" },
			"note.created: note_id must be a non-empty string",
		],
		[
			"seq 0",
			{ ...created(), seq: 0 },
			"note.created: seq must be an integer of at least 1",
		],
		[
			"a fractional seq",
			{ ...created(), seq: 1.5 },
			"note.created: seq must be an integer",
		],
		[
			"a string seq",
			{ ...created(), seq: "1" },
			"note.created: seq must be an integer",
		],
		[
			"an entered_at without Z",
			{ ...created(), entered_at: "2026-02-01T12:00:00+00:00" },
			"entered_at must be an ISO 8601 UTC instant",
		],
		[
			"an entered_at with no time",
			{ ...created(), entered_at: "2026-02-01" },
			"entered_at must be an ISO 8601 UTC instant",
		],
		[
			"an entered_at on a missing day",
			{ ...created(), entered_at: "2026-02-30T12:00:00Z" },
			"entered_at must be an ISO 8601 UTC instant",
		],
		[
			"an entered_at at hour 24",
			{ ...created(), entered_at: "2026-02-01T24:00:00Z" },
			"entered_at must be an ISO 8601 UTC instant",
		],
		[
			"an unknown role",
			{ ...created(), entered_by: "admin" },
			"entered_by must be",
		],
		[
			"an unknown key on note.created",
			{ ...created(), extra: 1 },
			"note.created: extra is not allowed",
		],
		[
			"an unknown key on payment.recorded",
			recorded(2, "borrower", { memo: "x" }),
			"payment.recorded: memo is not allowed",
		],
		[
			"an unknown key on payment.confirmed",
			{ ...confirmed(3, "lender", "evt-2"), reason: "x" },
			"payment.confirmed: reason is not allowed",
		],
		[
			"an unknown key on annotation.added",
			annotation(5, { author: "x" }),
			"annotation.added: author is not allowed",
		],
		[
			"a missing terms",
			without(created(), "terms"),
			"note.created: terms is required",
		],
		[
			"terms that are not an object",
			created({ terms: "none" }),
			"note.created: terms must be an object",
		],
		[
			"an unknown terms key",
			withTerms({ fee_minor: "100" }),
			"note.created: terms.fee_minor is not allowed",
		],
		[
			"a missing terms key",
			created({ terms: without(TERMS, "timezone") }),
			"note.created: terms.timezone is required",
		],
		[
			"a lowercase currency",
			withTerms({ currency: "usd" }),
			"terms.currency must be three capital letters",
		],
		[
			"a short currency",
			withTerms({ currency: "US" }),
			"terms.currency must be three capital letters",
		],
		[
			"a long currency",
			withTerms({ currency: "USDD" }),
			"terms.currency must be three capital letters",
		],
		[
			"exponent 5",
			withTerms({ exponent: 5 }),
			"terms.exponent must be an integer from 0 to 4",
		],
		[
			"a negative exponent",
			withTerms({ exponent: -1 }),
			"terms.exponent must be an integer from 0 to 4",
		],
		[
			"a fractional exponent",
			withTerms({ exponent: 1.5 }),
			"terms.exponent must be an integer from 0 to 4",
		],
		[
			"a string exponent",
			withTerms({ exponent: "2" }),
			"terms.exponent must be an integer from 0 to 4",
		],
		[
			"a rate of 1",
			withTerms({ annual_rate: "1" }),
			"terms.annual_rate must be a decimal string",
		],
		[
			"a rate with 7 places",
			withTerms({ annual_rate: "0.1234567" }),
			"terms.annual_rate must be a decimal string",
		],
		[
			"a rate with no leading zero",
			withTerms({ annual_rate: ".05" }),
			"terms.annual_rate must be a decimal string",
		],
		[
			"a rate with a trailing point",
			withTerms({ annual_rate: "0." }),
			"terms.annual_rate must be a decimal string",
		],
		[
			"a negative rate",
			withTerms({ annual_rate: "-0.05" }),
			"terms.annual_rate must be a decimal string",
		],
		[
			"a numeric rate",
			withTerms({ annual_rate: 0.05 }),
			"terms.annual_rate must be a decimal string",
		],
		[
			"a wrong day count",
			withTerms({ day_count: "30/360" }),
			"terms.day_count must be",
		],
		[
			"a wrong rounding",
			withTerms({ rounding: "half-even" }),
			"terms.rounding must be",
		],
		[
			"an empty timezone",
			withTerms({ timezone: "" }),
			"terms.timezone must be a non-empty string",
		],
		[
			"a bad document hash",
			withTerms({ document_sha256: "ABC" }),
			"terms.document_sha256 must be 64 lowercase hex",
		],
		[
			"a negative principal",
			withTerms({ principal_minor: "-1" }),
			"terms.principal_minor must be a non-negative integer",
		],
		[
			"a decimal principal",
			withTerms({ principal_minor: "10000.00" }),
			"terms.principal_minor must be a non-negative integer",
		],
		[
			"a numeric principal",
			withTerms({ principal_minor: 1000000 }),
			"terms.principal_minor must be a non-negative integer",
		],
		[
			"a missing day in the issue date",
			withTerms({ issue_date: "2026-02-30" }),
			"terms.issue_date must be a calendar date",
		],
		[
			"Feb 29 in a common year",
			withTerms({ issue_date: "2025-02-29" }),
			"terms.issue_date must be a calendar date",
		],
		[
			"Feb 29 in a century year",
			withTerms({ issue_date: "1900-02-29" }),
			"terms.issue_date must be a calendar date",
		],
		[
			"month 13",
			withTerms({ issue_date: "2026-13-01" }),
			"terms.issue_date must be a calendar date",
		],
		[
			"month 0",
			withTerms({ issue_date: "2026-00-10" }),
			"terms.issue_date must be a calendar date",
		],
		[
			"day 0",
			withTerms({ issue_date: "2026-01-00" }),
			"terms.issue_date must be a calendar date",
		],
		[
			"an unpadded date",
			withTerms({ issue_date: "2026-1-5" }),
			"terms.issue_date must be a calendar date",
		],
		[
			"31 days in April",
			withTerms({ issue_date: "2026-04-31" }),
			"terms.issue_date must be a calendar date",
		],
		[
			"a schedule that is not an object",
			withTerms({ schedule: "monthly" }),
			"terms.schedule must be an object",
		],
		[
			"an unknown schedule type",
			withSchedule({ type: "balloon" }),
			"terms.schedule.type must be",
		],
		[
			"an unknown schedule key",
			withSchedule({ type: "none", count: 3 }),
			"terms.schedule.count is not allowed",
		],
		[
			"an unknown frequency",
			withSchedule({
				type: "amortized",
				frequency: "daily",
				count: 3,
				first_due: "2026-02-15",
			}),
			"terms.schedule.frequency must be",
		],
		[
			"a zero installment count",
			withSchedule({
				type: "amortized",
				frequency: "monthly",
				count: 0,
				first_due: "2026-02-15",
			}),
			"terms.schedule.count must be an integer of at least 1",
		],
		[
			"a fractional installment count",
			withSchedule({
				type: "amortized",
				frequency: "monthly",
				count: 2.5,
				first_due: "2026-02-15",
			}),
			"terms.schedule.count must be an integer",
		],
		[
			"a bad first_due",
			withSchedule({
				type: "amortized",
				frequency: "monthly",
				count: 3,
				first_due: "2026-02-30",
			}),
			"terms.schedule.first_due must be a calendar date",
		],
		[
			"a missing amortized key",
			withSchedule({ type: "amortized", frequency: "monthly", count: 3 }),
			"terms.schedule.first_due is required",
		],
		[
			"an empty custom list",
			withSchedule({ type: "custom", installments: [] }),
			"terms.schedule.installments must be a non-empty array",
		],
		[
			"a custom list that is not an array",
			withSchedule({ type: "custom", installments: "x" }),
			"terms.schedule.installments must be a non-empty array",
		],
		[
			"an equal custom due date",
			custom(["2026-03-01", "2026-03-01"]),
			"terms.schedule.installments[1].due 2026-03-01 must be after installments[0].due 2026-03-01",
		],
		[
			"a decreasing custom due date",
			custom(["2026-03-01", "2026-02-01"]),
			"terms.schedule.installments[1].due 2026-02-01 must be after",
		],
		[
			"a custom due on the issue date",
			custom(["2026-01-15"]),
			"terms.schedule.installments[0].due 2026-01-15 must be after issue_date 2026-01-15",
		],
		[
			"a custom due before the issue date",
			custom(["2026-01-01", "2026-03-01"]),
			"terms.schedule.installments[0].due 2026-01-01 must be after issue_date",
		],
		[
			"a custom installment that is not an object",
			withSchedule({ type: "custom", installments: ["x"] }),
			"terms.schedule.installments[0] must be an object",
		],
		[
			"a custom installment with an extra key",
			withSchedule({
				type: "custom",
				installments: [{ due: "2026-03-01", amount_minor: "1", note: "x" }],
			}),
			"terms.schedule.installments[0].note is not allowed",
		],
		[
			"a negative custom amount",
			withSchedule({
				type: "custom",
				installments: [{ due: "2026-03-01", amount_minor: "-1" }],
			}),
			"terms.schedule.installments[0].amount_minor must be a non-negative integer",
		],
		[
			"a payment with an unknown kind",
			recorded(2, "borrower", { kind: "refund" }),
			"payment.recorded: kind must be",
		],
		[
			"a negative payment amount",
			recorded(2, "borrower", { amount_minor: "-100" }),
			"payment.recorded: amount_minor must be a non-negative integer",
		],
		[
			"a payment amount with a leading zero",
			recorded(2, "borrower", { amount_minor: "0100" }),
			"payment.recorded: amount_minor must be a non-negative integer",
		],
		[
			"a payment amount with a decimal",
			recorded(2, "borrower", { amount_minor: "350.00" }),
			"payment.recorded: amount_minor must be a non-negative integer",
		],
		[
			"a payment amount in exponent form",
			recorded(2, "borrower", { amount_minor: "1e3" }),
			"payment.recorded: amount_minor must be a non-negative integer",
		],
		[
			"an empty payment amount",
			recorded(2, "borrower", { amount_minor: "" }),
			"payment.recorded: amount_minor must be a non-negative integer",
		],
		[
			"a numeric payment amount",
			recorded(2, "borrower", { amount_minor: 35000 }),
			"payment.recorded: amount_minor must be a non-negative integer",
		],
		[
			"a missing amount",
			without(recorded(2, "borrower"), "amount_minor"),
			"payment.recorded: amount_minor is required",
		],
		[
			"a bad value_date",
			recorded(2, "borrower", { value_date: "2026-02-30" }),
			"payment.recorded: value_date must be a calendar date",
		],
		[
			"a missing value_date",
			without(recorded(2, "borrower"), "value_date"),
			"payment.recorded: value_date is required",
		],
		[
			"a reversal without reverses",
			recorded(3, "lender", { kind: "reversal" }),
			"payment.recorded: reverses is required when kind is reversal",
		],
		[
			"a payment with reverses",
			recorded(3, "lender", { reverses: "evt-2" }),
			"payment.recorded: reverses is only allowed when kind is reversal",
		],
		[
			"an empty reverses",
			recorded(3, "lender", { kind: "reversal", reverses: "" }),
			"payment.recorded: reverses must be a non-empty string",
		],
		[
			"a typed both-agree source",
			recorded(2, "borrower", { source: "both-agree" }),
			'payment.recorded: source "both-agree" is derived',
		],
		[
			"an unknown source",
			recorded(2, "borrower", { source: "witness" }),
			"payment.recorded: source must be",
		],
		[
			"a numeric method",
			recorded(2, "borrower", { method: 5 }),
			"payment.recorded: method must be a string",
		],
		[
			"a numeric reference",
			recorded(2, "borrower", { reference: 5 }),
			"payment.recorded: reference must be a string",
		],
		[
			"a confirmation without a target",
			without(confirmed(3, "lender", "evt-2"), "target"),
			"payment.confirmed: target is required",
		],
		[
			"a dispute without a reason",
			without(disputed(3, "lender", "evt-2"), "reason"),
			"payment.disputed: reason is required",
		],
		[
			"a dispute with an empty reason",
			disputed(3, "lender", "evt-2", { reason: "" }),
			"payment.disputed: reason must be a non-empty string",
		],
		[
			"a dispute without a counter amount",
			without(disputed(3, "lender", "evt-2"), "counter_amount_minor"),
			"payment.disputed: counter_amount_minor is required",
		],
		[
			"a dispute with neither",
			without(
				without(disputed(3, "lender", "evt-2"), "reason"),
				"counter_amount_minor",
			),
			"payment.disputed: counter_amount_minor is required",
		],
		[
			"a dispute with a negative counter amount",
			disputed(3, "lender", "evt-2", { counter_amount_minor: "-1" }),
			"payment.disputed: counter_amount_minor must be a non-negative integer",
		],
		[
			"a dispute without a target",
			without(disputed(3, "lender", "evt-2"), "target"),
			"payment.disputed: target is required",
		],
		[
			"a resolution without an agreed amount",
			without(resolved(4, "lender", "evt-2"), "agreed_amount_minor"),
			"payment.resolved: agreed_amount_minor is required",
		],
		[
			"a resolution with a bad agreed amount",
			{ ...resolved(4, "lender", "evt-2"), agreed_amount_minor: "1.5" },
			"payment.resolved: agreed_amount_minor must be a non-negative integer",
		],
		[
			"an empty annotation text",
			annotation(5, { text: "" }),
			"annotation.added: text must be a non-empty string",
		],
		[
			"a missing annotation text",
			without(annotation(5), "text"),
			"annotation.added: text is required",
		],
		[
			"a bad attachment hash",
			annotation(5, { attachment_sha256: "abc" }),
			"annotation.added: attachment_sha256 must be 64 lowercase hex",
		],
		[
			"an empty annotation target",
			annotation(5, { target: "" }),
			"annotation.added: target must be a non-empty string",
		],
	];
	for (const [name, event, message] of invalid) {
		it(name, () => {
			expect(() => parseNoteEvent(event)).toThrow(message);
		});
	}
});

describe("parseNoteEvent holes closed", () => {
	const amortized = (fields: Fields): Fields =>
		withSchedule({
			type: "amortized",
			frequency: "monthly",
			count: 3,
			first_due: "2026-02-15",
			...fields,
		});
	const rejected: [string, Fields, string][] = [
		[
			"a principal of 0",
			withTerms({ principal_minor: "0" }),
			'terms.principal_minor must be at least 1 minor unit, got "0"',
		],
		[
			"first_due on the issue date",
			amortized({ first_due: "2026-01-15" }),
			"terms.schedule.first_due 2026-01-15 must be after issue_date 2026-01-15",
		],
		[
			"first_due before the issue date",
			amortized({ first_due: "2026-01-14" }),
			"terms.schedule.first_due 2026-01-14 must be after issue_date",
		],
		[
			"more than 5200 installments",
			amortized({ count: 5201 }),
			"terms.schedule.count must be an integer from 1 to 5200, got 5201",
		],
		[
			"a count above 2^53 - 1",
			amortized({ count: 2 ** 53 }),
			"terms.schedule.count must be an integer of at least 1",
		],
		[
			"a negative count",
			amortized({ count: -1 }),
			"terms.schedule.count must be an integer of at least 1",
		],
		[
			"a last due date beyond year 9999",
			amortized({ count: 5200, first_due: "9900-01-01", frequency: "monthly" }),
			"terms.schedule.count 5200 puts the last due date beyond year 9999",
		],
		[
			"a weekly last due date beyond year 9999",
			amortized({ count: 5200, first_due: "9999-12-01", frequency: "weekly" }),
			"terms.schedule.count 5200 puts the last due date beyond year 9999",
		],
		[
			"a fractional seq",
			{ ...recorded(2, "borrower"), seq: 1.5 },
			"payment.recorded: seq must be an integer of at least 1",
		],
		[
			"a seq above 2^53 - 1",
			{ ...recorded(2, "borrower"), seq: 2 ** 53 },
			"payment.recorded: seq must be an integer of at least 1",
		],
		[
			"a seq of 0",
			{ ...recorded(2, "borrower"), seq: 0 },
			"payment.recorded: seq must be an integer of at least 1",
		],
	];
	for (const [name, event, message] of rejected) {
		it(`rejects ${name}`, () => {
			expect(() => parseNoteEvent(event)).toThrow(message);
		});
	}

	it("accepts 5200 installments and a principal of 1", () => {
		expect(
			parseNoteEvent(amortized({ count: 5200, frequency: "monthly" })),
		).toBeDefined();
		expect(parseNoteEvent(withTerms({ principal_minor: "1" }))).toBeDefined();
	});

	it("accepts 5200 installments at every frequency", () => {
		for (const frequency of ["weekly", "biweekly", "monthly"]) {
			const events = [
				withSchedule({
					type: "amortized",
					frequency,
					count: 5200,
					first_due: "2026-02-15",
				}),
			];
			expect(validateStream(events).length).toBe(1);
		}
	});
});

describe("validateStream accepts", () => {
	const fullStream = (): Fields[] => [
		created(),
		recorded(2, "borrower"),
		confirmed(3, "lender", "evt-2"),
		recorded(4, "lender", { source: "lender-states" }),
		disputed(5, "borrower", "evt-4"),
		resolved(6, "lender", "evt-4"),
		annotation(7, { target: "evt-2", attachment_sha256: SHA }),
		recorded(8, "lender", { kind: "reversal", reverses: "evt-2" }),
		confirmed(9, "borrower", "evt-8"),
		recorded(10, "borrower", { value_date: "2026-01-15" }),
	];

	it("a full stream, in seq order", () => {
		const events = validateStream(fullStream());
		expect(events.map((event) => event.seq)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
		]);
		expect(events.map((event) => event.type)).toEqual([
			"note.created",
			"payment.recorded",
			"payment.confirmed",
			"payment.recorded",
			"payment.disputed",
			"payment.resolved",
			"annotation.added",
			"payment.recorded",
			"payment.confirmed",
			"payment.recorded",
		]);
	});

	it("the same events in any input order, returned sorted by seq (AC-3)", () => {
		const forward = validateStream(fullStream());
		const backward = validateStream(fullStream().reverse());
		expect(backward).toEqual(forward);
	});

	it("a stream of only note.created", () => {
		expect(validateStream([created()]).length).toBe(1);
	});

	it("a value_date on the issue date", () => {
		const events = validateStream([
			created(),
			recorded(2, "borrower", { value_date: "2026-01-15" }),
		]);
		expect(events.length).toBe(2);
	});

	it("a resolution by either party after a dispute", () => {
		const events = validateStream([
			created(),
			recorded(2, "borrower"),
			disputed(3, "lender", "evt-2"),
			resolved(4, "borrower", "evt-2"),
		]);
		expect(events.length).toBe(4);
	});
});

describe("validateStream rejects", () => {
	const base = (): Fields[] => [created(), recorded(2, "borrower")];
	const invalidStreams: [string, () => unknown[], string][] = [
		["an empty stream", () => [], "stream: must contain at least one event"],
		[
			"a stream that starts with a payment",
			() => [recorded(1, "borrower")],
			"stream: the first event (seq 1) must be note.created",
		],
		[
			"a stream whose seq 1 is not note.created",
			() => [{ ...created(), seq: 2 }, recorded(1, "borrower")],
			"stream: the first event (seq 1) must be note.created",
		],
		[
			"a second note.created",
			() => [...base(), { ...created(), id: "evt-3", seq: 3 }],
			"note.created: seq 3: note.created is only allowed as the first event",
		],
		[
			"a different note_id",
			() => [
				...base(),
				{ ...confirmed(3, "lender", "evt-2"), note_id: "note-2" },
			],
			'payment.confirmed: seq 3: note_id "note-2" differs from "note-1"',
		],
		[
			"a seq gap",
			() => [...base(), confirmed(4, "lender", "evt-2")],
			"stream: seq has a gap: expected 3, found 4",
		],
		[
			"a seq that does not start at 1",
			() => [{ ...created(), seq: 2 }, { ...recorded(3, "borrower") }],
			"stream: seq has a gap: expected 1, found 2",
		],
		[
			"a repeated seq",
			() => [
				...base(),
				confirmed(3, "lender", "evt-2"),
				{ ...annotation(3), id: "evt-x" },
			],
			"stream: seq 3 is repeated",
		],
		[
			"a repeated event id",
			() => [...base(), { ...confirmed(3, "lender", "evt-2"), id: "evt-2" }],
			'payment.confirmed: seq 3: id "evt-2" is already used by seq 2',
		],
		[
			"a confirmation of an unknown event",
			() => [...base(), confirmed(3, "lender", "evt-99")],
			'payment.confirmed: seq 3: target "evt-99" does not match an earlier payment.recorded event',
		],
		[
			"a confirmation of a later event",
			() => [
				created(),
				confirmed(2, "lender", "evt-3"),
				recorded(3, "borrower"),
			],
			'payment.confirmed: seq 2: target "evt-3" does not match an earlier payment.recorded event',
		],
		[
			"a confirmation of a note.created event",
			() => [...base(), confirmed(3, "borrower", "evt-1")],
			'payment.confirmed: seq 3: target "evt-1" has type note.created, not payment.recorded',
		],
		[
			"a dispute of an unknown event",
			() => [...base(), disputed(3, "lender", "evt-99")],
			'payment.disputed: seq 3: target "evt-99" does not match an earlier payment.recorded event',
		],
		[
			"a dispute of an annotation",
			() => [...base(), annotation(3), disputed(4, "lender", "evt-3")],
			'payment.disputed: seq 4: target "evt-3" has type annotation.added, not payment.recorded',
		],
		[
			"a resolution of an unknown event",
			() => [...base(), resolved(3, "lender", "evt-99")],
			'payment.resolved: seq 3: target "evt-99" does not match an earlier payment.recorded event',
		],
		[
			"a resolution without a dispute",
			() => [...base(), resolved(3, "lender", "evt-2")],
			'payment.resolved: seq 3: target "evt-2" has no earlier payment.disputed event',
		],
		[
			"a resolution before its dispute",
			() => [
				...base(),
				resolved(3, "lender", "evt-2"),
				disputed(4, "lender", "evt-2"),
			],
			'payment.resolved: seq 3: target "evt-2" has no earlier payment.disputed event',
		],
		[
			"a reversal of an unknown event",
			() => [
				...base(),
				recorded(3, "lender", { kind: "reversal", reverses: "evt-99" }),
			],
			'payment.recorded: seq 3: reverses "evt-99" does not match an earlier payment.recorded event',
		],
		[
			"a reversal of a note.created event",
			() => [
				...base(),
				recorded(3, "lender", { kind: "reversal", reverses: "evt-1" }),
			],
			'payment.recorded: seq 3: reverses "evt-1" has type note.created, not payment.recorded',
		],
		[
			"a reversal of a reversal",
			() => [
				...base(),
				recorded(3, "lender", { kind: "reversal", reverses: "evt-2" }),
				recorded(4, "lender", { kind: "reversal", reverses: "evt-3" }),
			],
			'payment.recorded: seq 4: reverses "evt-3" must be a payment, not a reversal',
		],
		[
			"a reversal for a different amount than its payment",
			() => [
				...base(),
				recorded(3, "lender", {
					kind: "reversal",
					reverses: "evt-2",
					amount_minor: "10000",
				}),
			],
			'payment.recorded: seq 3: a reversal undoes one whole payment: amount_minor 10000 differs from the 35000 of "evt-2"',
		],
		[
			"a reversal dated before its payment",
			() => [
				...base(),
				recorded(3, "lender", {
					kind: "reversal",
					reverses: "evt-2",
					value_date: "2026-02-09",
				}),
			],
			'payment.recorded: seq 3: value_date 2026-02-09 is before the 2026-02-10 of the payment "evt-2" it reverses',
		],
		[
			"a second reversal of the same payment by the same party",
			() => [
				...base(),
				recorded(3, "lender", { kind: "reversal", reverses: "evt-2" }),
				recorded(4, "lender", { kind: "reversal", reverses: "evt-2" }),
			],
			'payment.recorded: seq 4: payment "evt-2" is already reversed by "evt-3" (seq 3); "evt-4" cannot reverse it again',
		],
		[
			"a second reversal of the same payment by the other party",
			() => [
				...base(),
				recorded(3, "lender", { kind: "reversal", reverses: "evt-2" }),
				recorded(4, "borrower", { kind: "reversal", reverses: "evt-2" }),
			],
			'payment.recorded: seq 4: payment "evt-2" is already reversed by "evt-3" (seq 3); "evt-4" cannot reverse it again',
		],
		[
			"a payment dated before the issue date",
			() => [created(), recorded(2, "borrower", { value_date: "2026-01-14" })],
			"payment.recorded: seq 2: value_date 2026-01-14 is before issue_date 2026-01-15",
		],
		[
			"a reversal dated before the issue date",
			() => [
				...base(),
				recorded(3, "lender", {
					kind: "reversal",
					reverses: "evt-2",
					value_date: "2025-12-31",
				}),
			],
			"payment.recorded: seq 3: value_date 2025-12-31 is before issue_date",
		],
		[
			"a borrower confirming their own payment",
			() => [...base(), confirmed(3, "borrower", "evt-2")],
			'payment.confirmed: seq 3: borrower cannot confirm a payment the borrower recorded ("evt-2")',
		],
		[
			"a lender confirming their own payment",
			() => [created(), recorded(2, "lender"), confirmed(3, "lender", "evt-2")],
			'payment.confirmed: seq 3: lender cannot confirm a payment the lender recorded ("evt-2")',
		],
		[
			"a lender disputing their own payment",
			() => [created(), recorded(2, "lender"), disputed(3, "lender", "evt-2")],
			'payment.disputed: seq 3: lender cannot dispute a payment the lender recorded ("evt-2")',
		],
		[
			"a borrower disputing their own payment",
			() => [...base(), disputed(3, "borrower", "evt-2")],
			'payment.disputed: seq 3: borrower cannot dispute a payment the borrower recorded ("evt-2")',
		],
		[
			"an annotation about an unknown event",
			() => [...base(), annotation(3, { target: "evt-99" })],
			'annotation.added: seq 3: target "evt-99" does not match an earlier event',
		],
		[
			"a dispute without a reason inside a stream",
			() => [...base(), without(disputed(3, "lender", "evt-2"), "reason")],
			"events[2]: payment.disputed: reason is required",
		],
		[
			"a bad event named by its index",
			() => [created(), { ...recorded(2, "borrower"), amount_minor: "-5" }],
			"events[1]: payment.recorded: amount_minor must be a non-negative integer",
		],
	];
	for (const [name, build, message] of invalidStreams) {
		it(name, () => {
			expect(() => validateStream(build())).toThrow(message);
		});
	}
});

describe("schema/note-event.v1.json", () => {
	const EVENT_TYPE_NAMES: NoteEvent["type"][] = [
		"note.created",
		"payment.recorded",
		"payment.confirmed",
		"payment.disputed",
		"payment.resolved",
		"annotation.added",
	];

	it("is JSON Schema 2020-12 with a oneOf over the six event types", () => {
		expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
		expect(schema.oneOf.length).toBe(6);
		expect(EVENT_TYPE_NAMES.length).toBe(6);
	});

	it("has one branch per NoteEvent type, each closed", () => {
		const branchTypes = schema.oneOf.map(
			(branch) => branch.properties.type.const,
		);
		expect(branchTypes).toEqual(EVENT_TYPE_NAMES);
		for (const branch of schema.oneOf) {
			expect(branch.additionalProperties).toBe(false);
			expect(branch.properties.schema).toEqual({ $ref: "#/$defs/schema" });
		}
		expect(schema.$defs.schema.const).toBe("tfd.note-event.v1");
	});

	it("matches the validator on bounds: seq and count maximum, positive principal, code-only checks described", () => {
		expect(schema.$defs.seq.maximum).toBe(Number.MAX_SAFE_INTEGER);
		expect(schema.$defs.terms.properties.principal_minor).toEqual({
			$ref: "#/$defs/minor_positive",
		});
		expect(new RegExp(schema.$defs.minor_positive.pattern).test("0")).toBe(
			false,
		);
		expect(new RegExp(schema.$defs.minor_positive.pattern).test("1")).toBe(
			true,
		);
		const amortizedBranch = JSON.parse(
			JSON.stringify(schema.$defs.schedule.oneOf[0]),
		) as { properties: { count: { maximum: number } } };
		expect(amortizedBranch.properties.count.maximum).toBe(
			Number.MAX_SAFE_INTEGER,
		);
		expect(schema.description).toContain("checked in code");
	});

	it("requires counter_amount_minor and reason on payment.disputed", () => {
		const branch = schema.oneOf.find(
			(candidate) => candidate.properties.type.const === "payment.disputed",
		);
		expect(branch?.required).toContain("counter_amount_minor");
		expect(branch?.required).toContain("reason");
	});

	it("makes reverses depend on kind", () => {
		const branch = schema.oneOf.find(
			(candidate) => candidate.properties.type.const === "payment.recorded",
		);
		expect(branch).toBeDefined();
		expect(branch).toMatchObject({
			if: { properties: { kind: { const: "reversal" } } },
		});
		const conditions = JSON.parse(JSON.stringify(branch)) as Record<
			string,
			unknown
		>;
		expect(conditions[THEN_KEY]).toEqual({ required: ["reverses"] });
		expect(conditions.else).toEqual({ not: { required: ["reverses"] } });
	});
});
