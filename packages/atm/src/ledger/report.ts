import { join } from "node:path";
import { type JournalRun, journalMonth, readEvents } from "./files.js";

export const REPORT_NAMES = [
	"income-statement",
	"balance-sheet",
	"credits",
] as const;
export type ReportName = (typeof REPORT_NAMES)[number];
export type ReportChoice = ReportName | "all";
export type ReportFormat = "table" | "csv";

export const REPORT_CHOICES: readonly ReportChoice[] = [...REPORT_NAMES, "all"];
export const REPORT_FORMATS: readonly ReportFormat[] = ["table", "csv"];

/** The hledger commands the golden-year tests run (`tests/hledger-reports.test.ts`), after `-f main.journal`. */
const HLEDGER_COMMANDS: Record<ReportName, readonly string[]> = {
	"income-statement": ["is"],
	"balance-sheet": ["bs"],
	credits: ["bal", "credits:", "--flat"],
};

/** Thrown when hledger cannot be run: not installed, not on PATH, or failing. The message is one line. */
export class HledgerError extends Error {}

export type ReportOutput = { report: ReportName; text: string };

/** The `money.skipped` events (a non-USD invoice, refund or payout the handler applied but did not book), counted. */
export type SkippedNonUsd = { inMonth: number; total: number };

export type ReportRun = {
	journal: JournalRun;
	reports: ReportOutput[];
	/** Money the reports leave out because it is not in USD: in the month built, and in all the school's events. */
	skippedNonUsd: SkippedNonUsd;
};

/** One line for stderr when the reports leave non-USD money out; null when nothing was skipped. */
export const skippedNote = ({
	skippedNonUsd,
	month,
}: {
	skippedNonUsd: SkippedNonUsd;
	month: string;
}): string | null =>
	skippedNonUsd.total === 0
		? null
		: `atm report: ${skippedNonUsd.inMonth} non-USD money line(s) skipped in ${month} (${skippedNonUsd.total} in all events); the reports are USD only and leave them out\n`;

const oneLine = (text: string): string =>
	text.trim().split("\n")[0] || "no message";

/** Throws a `HledgerError` that says so when `hledger` does not run, so a missing tool is never a silent skip. */
const assertHledgerRuns = (): void => {
	try {
		const probe = Bun.spawnSync(["hledger", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (probe.exitCode === 0) return;
		throw new HledgerError(
			`hledger --version failed: ${oneLine(probe.stderr.toString())}`,
		);
	} catch (error) {
		if (error instanceof HledgerError) throw error;
		throw new HledgerError(
			"hledger is not installed or not on PATH; atm report needs it (https://hledger.org/install.html)",
		);
	}
};

const runHledger = ({
	books,
	report,
	format,
}: {
	books: string;
	report: ReportName;
	format: ReportFormat;
}): string => {
	const output = format === "csv" ? ["-O", "csv"] : [];
	const run = Bun.spawnSync(
		["hledger", "-f", "main.journal", ...HLEDGER_COMMANDS[report], ...output],
		{ cwd: books, stdout: "pipe", stderr: "pipe" },
	);
	if (run.exitCode !== 0)
		throw new HledgerError(
			`hledger ${report} failed: ${oneLine(run.stderr.toString())}`,
		);
	return run.stdout.toString();
};

/**
 * `atm report`: checks that hledger runs, builds the month's journal (`journalMonth`: the same files `atm journal`
 * writes), then runs hledger on the school's `main.journal` for the chosen reports. `main.journal` includes every month
 * journaled so far, so the reports are to date over all of them: journal each earlier month first (a month never built
 * is not in them). Throws `HledgerError` before writing anything when hledger is missing.
 */
export const reportMonth = async ({
	root,
	school,
	month,
	report = "all",
	format = "table",
}: {
	root: string;
	school: string;
	month: string;
	report?: ReportChoice;
	format?: ReportFormat;
}): Promise<ReportRun> => {
	assertHledgerRuns();
	const journal = await journalMonth({ root, school, month });
	const books = join(root, "schools", school);
	const names = report === "all" ? REPORT_NAMES : [report];
	const skipped = (await readEvents(root, school)).events.filter(
		(event) =>
			event.event_type === "money.skipped" &&
			event.payload.reason === "non_usd",
	);
	return {
		journal,
		reports: names.map((name) => ({
			report: name,
			text: runHledger({ books, report: name, format }),
		})),
		skippedNonUsd: {
			inMonth: skipped.filter((event) => event.date.startsWith(`${month}-`))
				.length,
			total: skipped.length,
		},
	};
};
