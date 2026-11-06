/**
 * Gate R's harness (protocol v9 addendum §3): runs the current smoke.mjs body against the UI and judges it against
 * `checks.json`. Needs the global happy-dom window (`test/setup.ts`).
 */
import { uiEnvironment } from "./adapter.ts";
import {
	type CheckRun,
	loadSmoke,
	readTable,
	runBody,
	type Slice,
	type Status,
	type StepError,
	sliceOrder,
	slicesUpTo,
	type Table,
	type TableEntry,
} from "./smoke.ts";

export type Outcome = {
	id: string;
	entry: TableEntry;
	/** What the UI run did: pass, fail (ran and failed) or unreached (its step threw before `ok` ran). */
	result: "pass" | "fail" | "unreached";
	detail: string;
	selectors: string[];
};
export type Coverage = Record<
	Slice,
	Record<"pass" | "fail" | Exclude<Status, "pass" | "fail">, number> & {
		/** pending-slice checks that already pass. */
		passingEarly: number;
	}
>;
export type ParityReport = {
	slice: Slice;
	smokeSha256: string;
	runtimeChecks: number;
	outcomes: Outcome[];
	/** Runtime ids the table does not have: run parity-sync. */
	untracked: CheckRun[];
	errors: StepError[];
	coverage: Coverage;
	/** Owned checks (slice up to `slice`) that are not na and did not pass. */
	failures: Outcome[];
	/** na entries without a reason. */
	unexplained: string[];
};

const unreachedDetail = (line: number, errors: StepError[]): string => {
	const holding = errors
		.filter(({ start, end }) => start <= line && line <= end)
		.sort((first, second) => second.start - first.start)[0];
	return holding
		? `not reached: the step at line ${holding.start} threw: ${holding.message}`
		: "not reached";
};

export async function runParity(slice: Slice): Promise<ParityReport> {
	const compiled = loadSmoke();
	const table: Table = readTable();
	const ui = await uiEnvironment(compiled);
	let run: Awaited<ReturnType<typeof runBody>>;
	try {
		run = await runBody(compiled, ui.environment, {
			settle: ui.settle,
			takeSelectors: ui.takeSelectors,
		});
	} finally {
		ui.cleanup();
	}
	const byId = new Map(run.checks.map((check) => [check.id, check]));
	const owned = new Set<string>(slicesUpTo(slice));
	const outcomes: Outcome[] = Object.entries(table.checks)
		.filter(([, entry]) => !entry.removed)
		.map(([id, entry]) => {
			const check = byId.get(id);
			if (!check)
				return {
					id,
					entry,
					result: "unreached",
					detail: unreachedDetail(entry.line, run.errors),
					selectors: [],
				};
			return {
				id,
				entry,
				result: check.pass ? "pass" : "fail",
				detail: check.info,
				selectors: check.selectors,
			};
		});
	const coverage = Object.fromEntries(
		sliceOrder.map((name) => [
			name,
			{ pass: 0, fail: 0, "pending-slice": 0, na: 0, passingEarly: 0 },
		]),
	) as Coverage;
	for (const outcome of outcomes) {
		const counts = coverage[outcome.entry.slice];
		if (outcome.entry.status === "na") counts.na += 1;
		else if (!owned.has(outcome.entry.slice)) {
			counts["pending-slice"] += 1;
			if (outcome.result === "pass") counts.passingEarly += 1;
		} else if (outcome.result === "pass") counts.pass += 1;
		else counts.fail += 1;
	}
	return {
		slice,
		smokeSha256: compiled.sha256,
		runtimeChecks: run.checks.length,
		outcomes,
		untracked: run.checks.filter((check) => !(check.id in table.checks)),
		errors: run.errors,
		coverage,
		failures: outcomes.filter(
			(outcome) =>
				owned.has(outcome.entry.slice) &&
				outcome.entry.status !== "na" &&
				outcome.result !== "pass",
		),
		unexplained: outcomes
			.filter(({ entry }) => entry.status === "na" && !entry.reason?.trim())
			.map(({ id }) => id),
	};
}

/** Gate R is green when the table matches the current smoke.mjs, every runtime check is in it, every na has a reason,
 * and every owned check that is not na passed. */
export const gateProblems = (report: ParityReport, table: Table): string[] => {
	const problems: string[] = [];
	if (table.smoke.sha256 !== report.smokeSha256)
		problems.push(
			"checks.json was synced from another smoke.mjs: run plans/ledger-ui/loop/tools/parity-sync.ts",
		);
	if (report.untracked.length)
		problems.push(
			`${report.untracked.length} runtime checks are not in checks.json: run parity-sync (${report.untracked
				.slice(0, 3)
				.map(({ id }) => id)
				.join(", ")})`,
		);
	if (report.unexplained.length)
		problems.push(`na without a reason: ${report.unexplained.join(", ")}`);
	if (report.failures.length)
		problems.push(
			`${report.failures.length} checks owned by ${slicesUpTo(report.slice).join(", ")} do not pass`,
		);
	return problems;
};

export const formatCoverage = (report: ParityReport): string => {
	const header =
		"slice  pass  fail  pending-slice  na  (pending already passing)";
	const rows = sliceOrder.map((name) => {
		const counts = report.coverage[name];
		return `${name.padEnd(5)}  ${String(counts.pass).padStart(4)}  ${String(counts.fail).padStart(4)}  ${String(counts["pending-slice"]).padStart(13)}  ${String(counts.na).padStart(2)}  (${counts.passingEarly})`;
	});
	return [header, ...rows].join("\n");
};

export const formatFailures = (report: ParityReport): string =>
	report.failures
		.map(
			({ id, entry, result, detail }) =>
				`${entry.slice} ${result} ${id} (line ${entry.line})${detail ? `: ${detail}` : ""}`,
		)
		.join("\n");
