/**
 * `tfd note schedule` and `tfd note statement`: the promissory-note figures of the Apache-2.0 `tfd-notes` library printed
 * as plain text or, with `--json`, as one JSON line. Both commands are pure reads of a file the caller names. Exit 0 when
 * the figures are printed (two views that differ are information, not a conflict), 2 for input it cannot use (one line on
 * stderr, written so a caller can fix the input and run again).
 */
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import {
	generateSchedule,
	isValidCivilDate,
	NOTE_EVENT_SCHEMA,
	type NoteTerms,
	parseMinor,
	parseNoteEvent,
	type ScheduleRow,
	type Statement,
	statement,
	statusLabel,
} from "tfd-notes";
import { commandName } from "./command-name.js";
import type { CliKit } from "./scenario/cli.js";

const STATEMENT_FOOTER =
	"Computed by tfd-notes from the recorded events. A record, not legal or tax advice.";
const SCHEDULE_FOOTER =
	"Computed by tfd-notes from the terms. A record, not legal or tax advice.";

/** The placeholder fields that make a terms object a `note.created` event, so the library's own checks run on it. */
const TERMS_WRAPPER = {
	schema: NOTE_EVENT_SCHEMA,
	id: "terms-check",
	note_id: "terms-check",
	seq: 1,
	entered_at: "2000-01-01T00:00:00Z",
	entered_by: "lender",
	type: "note.created",
} as const;

const NEWLINE = /\r?\n/;
const MINUS = "-";
const COLUMN_GAP = "  ";

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** A minor-unit digit string as a decimal with `exponent` places: `"35000"`, 2 gives `350.00`; exponent 0 gives digits. */
const formatAmount = (minor: string, exponent: number): string => {
	const value = parseMinor(minor.startsWith(MINUS) ? minor.slice(1) : minor);
	const sign = minor.startsWith(MINUS) && value !== 0n ? MINUS : "";
	if (exponent === 0) return `${sign}${value}`;
	const digits = value.toString().padStart(exponent + 1, "0");
	const whole = digits.slice(0, digits.length - exponent);
	const fraction = digits.slice(digits.length - exponent);
	return `${sign}${whole}.${fraction}`;
};

/** Rows of cells as text, each column as wide as its widest cell; the first column is left-aligned, the rest right. */
const alignedTable = (rows: string[][]): string => {
	const widths: number[] = [];
	for (const row of rows) {
		for (const [index, cell] of row.entries()) {
			widths[index] = Math.max(widths[index] ?? 0, cell.length);
		}
	}
	return rows
		.map((row) =>
			row
				.map((cell, index) => {
					const width = widths[index] ?? cell.length;
					return index === 0 ? cell.padEnd(width) : cell.padStart(width);
				})
				.join(COLUMN_GAP)
				.trimEnd(),
		)
		.join("\n");
};

const readText = async (kit: CliKit, path: string): Promise<string> => {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		throw new kit.InputError(`${path} cannot be read: ${messageOf(error)}`);
	}
};

const parseTermsFile = async (
	kit: CliKit,
	path: string,
): Promise<NoteTerms> => {
	const text = await readText(kit, path);
	let terms: unknown;
	try {
		terms = JSON.parse(text);
	} catch (error) {
		throw new kit.InputError(`${path} is not JSON: ${messageOf(error)}`);
	}
	try {
		const event = parseNoteEvent({ ...TERMS_WRAPPER, terms });
		if (event.type !== "note.created") throw new Error("not a note.created");
		return event.terms;
	} catch (error) {
		throw new kit.InputError(
			`${path} is not valid note terms: ${messageOf(error)}`,
		);
	}
};

const readEventLines = async (
	kit: CliKit,
	path: string,
): Promise<unknown[]> => {
	const text = await readText(kit, path);
	const events: unknown[] = [];
	for (const [index, line] of text.split(NEWLINE).entries()) {
		if (line.trim() === "") continue;
		try {
			events.push(JSON.parse(line));
		} catch (error) {
			throw new kit.InputError(
				`${path} line ${index + 1} is not JSON (one event per line): ${messageOf(error)}`,
			);
		}
	}
	return events;
};

const sumMinor = (rows: ScheduleRow[], pick: (row: ScheduleRow) => string) => {
	let total = 0n;
	for (const row of rows) total += parseMinor(pick(row));
	return total.toString();
};

const scheduleText = (terms: NoteTerms, rows: ScheduleRow[]): string => {
	const { exponent } = terms;
	const amount = (minor: string) => formatAmount(minor, exponent);
	const heading = `Schedule: ${terms.currency} ${amount(terms.principal_minor)} at a yearly rate of ${terms.annual_rate}, issued ${terms.issue_date}`;
	if (rows.length === 0) {
		return `${heading}\nNo schedule: this note has no installments (type none).\n\n${SCHEDULE_FOOTER}\n`;
	}
	const table = alignedTable([
		["n", "due", "payment", "interest", "principal", "balance"],
		...rows.map((row) => [
			String(row.n),
			row.due,
			amount(row.payment_minor),
			amount(row.interest_minor),
			amount(row.principal_minor),
			amount(row.balance_after_minor),
		]),
		[
			"total",
			"",
			amount(sumMinor(rows, (row) => row.payment_minor)),
			amount(sumMinor(rows, (row) => row.interest_minor)),
			amount(sumMinor(rows, (row) => row.principal_minor)),
			"",
		],
	]);
	return `${heading}\n\n${table}\n\n${SCHEDULE_FOOTER}\n`;
};

const viewsTable = (report: Statement): string => {
	const amount = (minor: string) => formatAmount(minor, report.exponent);
	const { lender, borrower } = report;
	return alignedTable([
		["", "Lender view", "Borrower view"],
		[
			"principal",
			amount(lender.principal_minor),
			amount(borrower.principal_minor),
		],
		[
			"interest",
			amount(lender.interest_minor),
			amount(borrower.interest_minor),
		],
		["payoff", amount(lender.payoff_minor), amount(borrower.payoff_minor)],
		["paid", amount(lender.paid_minor), amount(borrower.paid_minor)],
		[
			"overpaid",
			amount(lender.overpaid_minor),
			amount(borrower.overpaid_minor),
		],
	]);
};

const differenceLines = (report: Statement): string[] => {
	const amount = (minor: string) => formatAmount(minor, report.exponent);
	if (report.difference.length === 0) {
		return ["Itemised difference: none, both views count the same payments."];
	}
	const lines = [
		`Itemised difference (${report.difference.length}), lender minus borrower:`,
	];
	for (const item of report.difference) {
		const age =
			item.unanswered_days === null
				? ""
				: `; unanswered for ${item.unanswered_days} ${item.unanswered_days === 1 ? "day" : "days"}`;
		const reason = item.reason === undefined ? "" : `; reason: ${item.reason}`;
		lines.push(
			`  ${item.value_date}  ${statusLabel(item.status)}: lender counts ${amount(item.lender_counts_minor)}, borrower counts ${amount(item.borrower_counts_minor)}, difference ${amount(item.difference_minor)} (event ${item.event_id}${age}${reason})`,
		);
	}
	return lines;
};

const expectedLines = (report: Statement): string[] => {
	const amount = (minor: string) => formatAmount(minor, report.exponent);
	const { expected } = report;
	const table = alignedTable([
		["", "Lender view", "Borrower view"],
		[
			"expected by now",
			amount(expected.due_to_date_minor),
			amount(expected.due_to_date_minor),
		],
		[
			"paid",
			amount(expected.lender_paid_minor),
			amount(expected.borrower_paid_minor),
		],
		[
			"overdue",
			amount(expected.lender_overdue_minor),
			amount(expected.borrower_overdue_minor),
		],
		[
			"days overdue",
			String(expected.lender_days_overdue),
			String(expected.borrower_days_overdue),
		],
	]);
	return [`Expected against paid, as of ${report.as_of}:`, table];
};

const statementText = (report: Statement): string => {
	const gap = formatAmount(report.payoff_gap_minor, report.exponent);
	const gapLine =
		parseMinor(report.payoff_gap_minor.replace(MINUS, "")) === 0n
			? "Payoff gap: 0 (the two views agree on the payoff)."
			: `Payoff gap (lender payoff minus borrower payoff): ${gap}`;
	return `${[
		`Note ${report.note_id} (${report.currency}), as of ${report.as_of}`,
		"",
		viewsTable(report),
		"",
		gapLine,
		"",
		...differenceLines(report),
		"",
		...expectedLines(report),
		"",
		STATEMENT_FOOTER,
	].join("\n")}\n`;
};

/** The library throws plain errors for terms it cannot schedule; they are input errors here, so the message stays one plain line. */
const scheduleOf = (kit: CliKit, terms: NoteTerms): ScheduleRow[] => {
	try {
		return generateSchedule(terms);
	} catch (error) {
		throw new kit.InputError(messageOf(error));
	}
};

export const addNoteCommands = (program: Command, kit: CliKit): void => {
	const note = program
		.command("note")
		.description(
			"promissory notes: the schedule of a note's terms and the two-party statement of its recorded events, computed by the Apache-2.0 tfd-notes library; each is a read of one file and prints one aligned table or, with --json, one JSON line",
		);
	kit.exitTwoOnUsageError(note);

	kit.exitTwoOnUsageError(
		note
			.command("schedule")
			.argument("<terms.json>", "a file holding one note's terms as JSON")
			.description(
				"print the repayment schedule of a note's terms: n, due date, payment, interest, principal and balance for each installment, and totals",
			)
			.option(
				"--json",
				"print one JSON line ({ok, schedule}) with the library's strings unchanged, instead of the table",
			)
			.action((path: string, options: { json?: boolean }) =>
				kit.unattended("note schedule", options.json === true, async () => {
					const terms = await parseTermsFile(kit, path);
					const rows = scheduleOf(kit, terms);
					if (options.json) kit.writeJson({ ok: true, schedule: rows });
					else process.stdout.write(scheduleText(terms, rows));
				}),
			),
	);

	kit.exitTwoOnUsageError(
		note
			.command("statement")
			.argument(
				"<events.jsonl>",
				"a file with one note event as JSON on each line; blank lines are ignored",
			)
			.requiredOption(
				"--as-of <date>",
				"the date to compute the statement for, YYYY-MM-DD",
			)
			.description(
				`print the statement of a note on a date: the lender's and the borrower's count side by side, the payoff gap, the payments the two counts differ on and expected against paid. A difference is information: exit 0 (2 for a file or event it cannot use). Example: ${commandName} note statement events.jsonl --as-of 2026-03-01`,
			)
			.option(
				"--json",
				"print one JSON line ({ok, statement}) instead of the text",
			)
			.action((path: string, options: { asOf: string; json?: boolean }) =>
				kit.unattended("note statement", options.json === true, async () => {
					if (!isValidCivilDate(options.asOf)) {
						throw new kit.InputError(
							`--as-of ${options.asOf} is not a date: use YYYY-MM-DD`,
						);
					}
					const events = await readEventLines(kit, path);
					let report: Statement;
					try {
						report = statement(events, options.asOf);
					} catch (error) {
						throw new kit.InputError(`${path}: ${messageOf(error)}`);
					}
					if (options.json) kit.writeJson({ ok: true, statement: report });
					else process.stdout.write(statementText(report));
				}),
			),
	);
};
