import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type {
	ReportChoice,
	ReportFormat,
	ReportName,
	ReportRun,
	SkippedNonUsd,
} from "../types.js";
import { journalMonth, readEvents } from "./files.js";

export const REPORT_NAMES: readonly ReportName[] = [
	"income-statement",
	"balance-sheet",
	"credits",
];

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

/** Node's `spawnSync` stops a child at 1 MiB of output (ENOBUFS); a year of CSV can pass that, and Bun's never did. */
const HLEDGER_MAX_BUFFER = 256 * 1024 * 1024;

const oneLine = (text: string): string =>
	text.trim().split("\n")[0] || "no message";

/** Throws a `HledgerError` that says so when `hledger` does not run, so a missing tool is never a silent skip. Node's `spawnSync`, not Bun's: the library bundle also runs under Node. */
const assertHledgerRuns = (): void => {
	const probe = spawnSync("hledger", ["--version"], {
		encoding: "utf8",
		maxBuffer: HLEDGER_MAX_BUFFER,
	});
	if (probe.error)
		throw new HledgerError(
			"hledger is not installed or not on PATH; atm report needs it (https://hledger.org/install.html)",
		);
	if (probe.status !== 0)
		throw new HledgerError(
			`hledger --version failed: ${oneLine(probe.stderr)}`,
		);
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
	const run = spawnSync(
		"hledger",
		["-f", "main.journal", ...HLEDGER_COMMANDS[report], ...output],
		{ cwd: books, encoding: "utf8", maxBuffer: HLEDGER_MAX_BUFFER },
	);
	if (run.error || run.status !== 0)
		throw new HledgerError(
			`hledger ${report} failed: ${oneLine(run.error?.message ?? run.stderr)}`,
		);
	return run.stdout;
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
