/**
 * Regenerates packages/ledger-ui/test/parity/checks.json from the current plans/ledger-ui/design/smoke.mjs (protocol
 * v9 addendum §3). Usage, from anywhere: bun plans/ledger-ui/loop/tools/parity-sync.ts [--force]
 *
 * Runs the smoke body, split and rewritten as the UI harness runs it (packages/ledger-ui/test/parity/smoke.ts), against
 * the mockup with the package's happy-dom, and collects every runtime check. Existing ids keep their slice, status,
 * reason and ui; their name and line follow the current file. A new id is added as pending-slice with a slice guessed
 * from its name (or the previous check's slice); an id the file no longer produces is marked `removed` and kept. The
 * order is the run order, removed ids after; the output depends only on smoke.mjs, the mockup and the old table.
 * Refuses to write (exit 1) when a check fails on the mockup, unless --force: the mockup is the spec and must pass.
 */
import { existsSync } from "node:fs";
import {
	loadSmoke,
	mockupEnvironment,
	readTable,
	runBody,
	type Slice,
	sliceOrder,
	type Table,
	type TableEntry,
	tableComment,
	tablePath,
	writeTable,
} from "../../../../packages/ledger-ui/test/parity/smoke.ts";

/** First match wins; the tab or feature the check exercises names its slice (protocol v8 §10, v9 addendum §5, and the
 * orchestrator's order of 2026-11-06 for the frozen disclosure-v2 mockup: the top bar's View as dropdown, the single
 * period control and the preview banner are S7; audience gating goes to the tab it exercises; Dashboard audiences are
 * S1b; the every-tab audience matrix needs every tab, so S7). Ids already in the table keep their slice. */
const sliceRules: ReadonlyArray<readonly [RegExp, Slice]> = [
	[/^(boots without errors|no runtime errors|tabs$)/, "S0"],
	[/^yaml: no console\.log/, "S0"],
	[
		/^view as: (governance preview locks Members|admin preview shows the roster)/,
		"S4",
	],
	[/^(top bar: View as|view as:|period:|narrow:)/, "S7"],
	[/^matrix: /, "S5"],
	[/^matrix \w+ \w+: Reports/, "S5"],
	[/^matrix /, "S7"],
	[/^ranked \d+: .*\b(Ledger|Reports|Donors|donor)/, "S5"],
	[/^ranked \d+: .*\b(promo|Promos)\b/, "S5"],
	[/^ranked \d+: .*(drawer|⋯ menu)/, "S4"],
	[/^ranked \d+: .*portal/, "S6"],
	[/^ranked \d+: .*plan/, "S3"],
	[/^audience chip:/, "S4"],
	[/^tier audience:/, "S3"],
	[/^settings:/, "S7"],
	[/^(portal|embed):/, "S6"],
	[/^(rounding|counts|disclosure):/, "S1b"],
	[/^books (gov|fin|owner|member|locked): (Reports|Ledger|Donors)/, "S5"],
	[/^books\b/, "S1b"],
	[/^axis\b/, "S1"],
	[
		/^(dash |members view|risk view|month step|b4u (fixture|jun|members paying)|disputes flags|annual |nw empty)/,
		"S1",
	],
	[/^(bk |bulk )/, "S2"],
	[/^(plans |yaml:)/, "S3"],
	[
		/^(admin csv: (Ledger|ledger|Reports)|gate: (non-finance admin has Ledger|donors CSV))/,
		"S5",
	],
	[/^gate: portal/, "S6"],
	[
		/^(mem |drawer |owner can|last owner|self-demote|role |revoke |make admin|remove admin|b4u viewer|non-owner|b4u family|chips:|balance bar|menu:|kbd:|admin csv: drawer|gate: (drawer|menu))/,
		"S4",
	],
	[/^(portal |hist:|csv|layout:)/, "S6"],
];
const guessSlice = (name: string, previous: Slice): Slice =>
	sliceRules.find(([pattern]) => pattern.test(name))?.[1] ?? previous;

const force = process.argv.includes("--force");
const compiled = loadSmoke();
const run = await runBody(compiled, await mockupEnvironment(compiled), {
	settle: async () => undefined,
});
const failing = run.checks.filter((check) => !check.pass);
if (failing.length || run.errors.length) {
	for (const check of failing)
		process.stdout.write(
			`mockup FAIL ${check.id} (line ${check.line}): ${check.info}\n`,
		);
	for (const error of run.errors)
		process.stdout.write(
			`mockup step error, lines ${error.start}-${error.end}: ${error.message}\n`,
		);
	if (!force) {
		process.stdout.write(
			"not written: the mockup must pass its own spec (--force to write anyway)\n",
		);
		process.exit(1);
	}
}

const old: Table | null = existsSync(tablePath) ? readTable() : null;
const checks: Record<string, TableEntry> = {};
let previous: Slice = "S0";
let added = 0;
for (const check of run.checks) {
	const kept = old?.checks[check.id];
	const entry: TableEntry = kept
		? { ...kept, name: check.name, line: check.line }
		: {
				name: check.name,
				line: check.line,
				slice: guessSlice(check.name, previous),
				status: "pending-slice",
			};
	if (!kept) added += 1;
	delete entry.removed;
	checks[check.id] = entry;
	previous = entry.slice;
}
let removed = 0;
for (const [id, entry] of Object.entries(old?.checks ?? {}))
	if (!(id in checks)) {
		checks[id] = { ...entry, removed: true };
		removed += 1;
	}

writeTable({
	$comment: tableComment,
	smoke: {
		path: "plans/ledger-ui/design/smoke.mjs",
		sha256: compiled.sha256,
		runtimeChecks: run.checks.length,
	},
	sliceOrder: [...sliceOrder],
	checks,
});
process.stdout.write(
	`checks.json: ${run.checks.length} runtime checks, ${added} added, ${removed} marked removed, smoke ${compiled.sha256.slice(0, 12)}\n`,
);
