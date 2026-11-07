/**
 * Gate R (protocol v9 addendum §3), from packages/ledger-ui:
 *   bun test/parity/run.ts --slice S<k> [--record] [--json <path>]
 * Runs the current smoke.mjs body against the UI, prints per-slice coverage and every owned check that does not pass,
 * and exits 1 unless gate R is green for the slice. --record writes what the run saw back into checks.json: for the
 * owned slices, status pass or fail (with the reason); for every check, ui (the selectors resolved). na entries and
 * slices are never changed. --json writes the whole report.
 */
import "../setup.ts";
import { writeFileSync } from "node:fs";
import {
	formatCoverage,
	formatFailures,
	gateProblems,
	runParity,
} from "./harness.ts";
import { isSlice, readTable, slicesUpTo, writeTable } from "./smoke.ts";

const argument = (name: string): string | undefined => {
	const index = process.argv.indexOf(name);
	return index > 0 ? process.argv[index + 1] : undefined;
};
const slice = argument("--slice") ?? "";
if (!isSlice(slice)) {
	process.stdout.write(
		`R red: --slice must be one of the slice names, got "${slice}"\n`,
	);
	process.exit(1);
}

const report = await runParity(slice);
const table = readTable();
if (process.argv.includes("--record")) {
	const owned = new Set<string>(slicesUpTo(slice));
	for (const outcome of report.outcomes) {
		const entry = table.checks[outcome.id];
		if (!entry) continue;
		if (outcome.selectors.length) entry.ui = outcome.selectors.join(" | ");
		if (entry.status === "na" || !owned.has(entry.slice)) continue;
		entry.status = outcome.result === "pass" ? "pass" : "fail";
		if (entry.status === "pass") delete entry.reason;
		else
			entry.reason = `${outcome.result}${outcome.detail ? `: ${outcome.detail}` : ""}`;
	}
	writeTable(table);
}
const jsonPath = argument("--json");
if (jsonPath)
	writeFileSync(jsonPath, `${JSON.stringify(report, null, "\t")}\n`);

const problems = gateProblems(report, table);
process.stdout.write(
	`parity: ${report.runtimeChecks} checks reached on the UI of ${report.outcomes.length} live in checks.json, ${Object.keys(table.checks).length - report.outcomes.length} removed (smoke ${report.smokeSha256.slice(0, 12)}); slice ${slice} owns ${slicesUpTo(slice).join(", ")}\n${formatCoverage(report)}\n`,
);
if (report.failures.length) process.stdout.write(`${formatFailures(report)}\n`);
if (problems.length) {
	process.stdout.write(`R red: ${problems.join("; ")}\n`);
	process.exit(1);
}
process.stdout.write(
	`R green: every check owned by ${slicesUpTo(slice).join(", ")} passes or is na\n`,
);
