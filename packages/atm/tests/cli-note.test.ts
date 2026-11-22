/**
 * `tfd note schedule` and `tfd note statement` end to end: the CLI is spawned (src/bin.ts) over files in a temporary
 * folder, and its figures are compared with the tfd-notes library's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSchedule, type NoteTerms, statement } from "tfd-notes";
import { tmp } from "./helpers.js";

const BIN = join(import.meta.dir, "../src/bin.ts");
const BANNED_WORDS = /proof|enforceable|binding|tamper-proof/i;
const FOOTER =
	"Computed by tfd-notes from the recorded events. A record, not legal or tax advice.";
const INSTALLMENTS = 36;
const AS_OF = "2026-03-01";

const TERMS: NoteTerms = {
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
		count: INSTALLMENTS,
		first_due: "2026-02-15",
	},
};

type Fields = Record<string, unknown>;

const makeEvent = (
	seq: number,
	type: string,
	enteredBy: string,
	fields: Fields,
): Fields => ({
	schema: "tfd.note-event.v1",
	id: `evt-${seq}`,
	note_id: "note-1",
	seq,
	entered_at: "2026-02-20T12:00:00Z",
	entered_by: enteredBy,
	type,
	...fields,
});

const createdEvent = (terms: NoteTerms = TERMS) =>
	makeEvent(1, "note.created", "lender", { terms });
const borrowerPayment = (seq: number) =>
	makeEvent(seq, "payment.recorded", "borrower", {
		kind: "payment",
		amount_minor: "35000",
		value_date: "2026-02-15",
	});
const lenderConfirmation = (seq: number, target: string) =>
	makeEvent(seq, "payment.confirmed", "lender", { target });

const jsonl = (events: Fields[], separator = "\n") =>
	`${events.map((event) => JSON.stringify(event)).join(separator)}\n`;

const note = (args: string[]) => {
	const run = Bun.spawnSync([process.execPath, BIN, "note", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: run.exitCode,
		stdout: run.stdout.toString(),
		stderr: run.stderr.toString(),
	};
};

let folder = "";
const fileIn = async (name: string, content: string) => {
	const path = join(folder, name);
	await writeFile(path, content);
	return path;
};

beforeAll(async () => {
	folder = await tmp("cli-note");
});

afterAll(async () => {
	await rm(folder, { recursive: true, force: true });
});

describe("tfd note schedule", () => {
	test("prints the 36-installment table with a zero last balance and totals", async () => {
		const path = await fileIn("terms.json", JSON.stringify(TERMS));
		const run = note(["schedule", path]);
		expect(run.exitCode).toBe(0);
		const lines = run.stdout.split("\n");
		const rows = lines.filter((line) =>
			/^\d+\s+\d{4}-\d{2}-\d{2}\s/.test(line),
		);
		expect(rows).toHaveLength(INSTALLMENTS);
		expect(rows[0]).toContain("299.69");
		expect(rows.at(-1)?.trimEnd().endsWith(" 0.00")).toBe(true);
		expect(lines.find((line) => line.startsWith("total"))).toContain(
			"10000.00",
		);
		expect(run.stdout).not.toMatch(BANNED_WORDS);
	});

	test("--json prints the library's schedule unchanged on one line", async () => {
		const path = await fileIn("terms-json.json", JSON.stringify(TERMS));
		const run = note(["schedule", path, "--json"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout.trimEnd().split("\n")).toHaveLength(1);
		expect(JSON.parse(run.stdout)).toEqual({
			ok: true,
			schedule: generateSchedule(TERMS),
		});
	});

	test("exponent 0 prints integers", async () => {
		const yen: NoteTerms = {
			...TERMS,
			currency: "JPY",
			exponent: 0,
			principal_minor: "120000",
			annual_rate: "0",
			schedule: {
				type: "amortized",
				frequency: "monthly",
				count: 12,
				first_due: "2026-02-15",
			},
		};
		const path = await fileIn("yen.json", JSON.stringify(yen));
		const run = note(["schedule", path]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("10000");
		expect(run.stdout).not.toMatch(/\d\.\d\d/);
	});

	test("terms the library refuses are a one-line input error", async () => {
		const path = await fileIn(
			"bad-terms.json",
			JSON.stringify({ ...TERMS, currency: "dollars" }),
		);
		const run = note(["schedule", path]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr.trimEnd().split("\n")).toHaveLength(1);
		expect(run.stderr).toContain("not valid note terms");
	});

	test("a file that is not JSON or is missing is exit 2", async () => {
		const path = await fileIn("not-json.json", "{nope");
		expect(note(["schedule", path]).exitCode).toBe(2);
		const missing = note(["schedule", join(folder, "missing.json")]);
		expect(missing.exitCode).toBe(2);
		expect(missing.stderr).toContain("cannot be read");
	});
});

describe("tfd note statement", () => {
	test("shows the gap while a borrower payment is unanswered, then none after the lender confirms", async () => {
		const open = await fileIn(
			"gap.jsonl",
			jsonl([createdEvent(), borrowerPayment(2)]),
		);
		const gap = note(["statement", open, "--as-of", AS_OF]);
		expect(gap.exitCode).toBe(0);
		expect(gap.stdout).toContain("Lender view");
		expect(gap.stdout).toContain("Borrower view");
		expect(gap.stdout).toContain("Payoff gap");
		expect(gap.stdout).toContain("350.59");
		expect(gap.stdout).toContain("claimed by borrower");
		expect(gap.stdout).toContain("unanswered for 9 days");
		expect(gap.stdout).toContain("days overdue");
		expect(gap.stdout).toContain(FOOTER);

		const closed = await fileIn(
			"no-gap.jsonl",
			jsonl([
				createdEvent(),
				borrowerPayment(2),
				lenderConfirmation(3, "evt-2"),
			]),
		);
		const agreed = note(["statement", closed, "--as-of", AS_OF]);
		expect(agreed.exitCode).toBe(0);
		expect(agreed.stdout).toContain("the two views agree");
		expect(agreed.stdout).toContain("Itemised difference: none");
		expect(agreed.stdout).not.toContain("claimed by borrower");

		for (const output of [gap.stdout, agreed.stdout]) {
			expect(output).not.toMatch(BANNED_WORDS);
		}
	});

	test("--json prints { ok, statement } as one line equal to the library's", async () => {
		const events = [createdEvent(), borrowerPayment(2)];
		const path = await fileIn("json.jsonl", jsonl(events));
		const run = note(["statement", path, "--as-of", AS_OF, "--json"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout.trimEnd().split("\n")).toHaveLength(1);
		const parsed = JSON.parse(run.stdout);
		expect(parsed.ok).toBe(true);
		expect(parsed.statement).toEqual(statement(events, AS_OF));
		expect(parsed.statement.difference).toHaveLength(1);
	});

	test("blank lines and CRLF line ends are ignored", async () => {
		const events = [createdEvent(), borrowerPayment(2)];
		const path = await fileIn(
			"blank.jsonl",
			`\n\n${jsonl(events, "\n\n   \n")}\n\n`,
		);
		const run = note(["statement", path, "--as-of", AS_OF, "--json"]);
		expect(run.exitCode).toBe(0);
		expect(JSON.parse(run.stdout).statement).toEqual(statement(events, AS_OF));
		const crlf = await fileIn("crlf.jsonl", jsonl(events, "\r\n"));
		expect(note(["statement", crlf, "--as-of", AS_OF]).exitCode).toBe(0);
	});

	test("a gap in seq is exit 2 with one stderr line naming it", async () => {
		const path = await fileIn(
			"seq-gap.jsonl",
			jsonl([createdEvent(), borrowerPayment(3)]),
		);
		const run = note(["statement", path, "--as-of", AS_OF]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr.trimEnd().split("\n")).toHaveLength(1);
		expect(run.stderr).toContain("gap");
		expect(run.stdout).toBe("");
	});

	test("--json with an error prints { ok: false } and exits 2", async () => {
		const path = await fileIn(
			"seq-gap-json.jsonl",
			jsonl([createdEvent(), borrowerPayment(3)]),
		);
		const run = note(["statement", path, "--as-of", AS_OF, "--json"]);
		expect(run.exitCode).toBe(2);
		expect(JSON.parse(run.stdout).ok).toBe(false);
	});

	test("a line that is not JSON names its line number", async () => {
		const path = await fileIn(
			"bad-line.jsonl",
			`${JSON.stringify(createdEvent())}\n\n{oops\n`,
		);
		const run = note(["statement", path, "--as-of", AS_OF]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("line 3");
	});

	test("a missing or invalid --as-of is exit 2", async () => {
		const path = await fileIn("as-of.jsonl", jsonl([createdEvent()]));
		const missing = note(["statement", path]);
		expect(missing.exitCode).toBe(2);
		expect(missing.stderr).toContain("--as-of");
		const invalid = note(["statement", path, "--as-of", "2026-02-30"]);
		expect(invalid.exitCode).toBe(2);
		expect(invalid.stderr).toContain("YYYY-MM-DD");
	});
});
