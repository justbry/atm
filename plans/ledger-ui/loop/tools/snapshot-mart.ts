/**
 * Refreshes plans/ledger-ui/design/mart from the coordinating atm session's mart (default /tmp/atm-mart) and atm on
 * this checkout. Run from the repo root: bun plans/ledger-ui/loop/tools/snapshot-mart.ts [--from /tmp/atm-mart]
 *
 * Writes bundle.json and dashboard.html verbatim, kpis/<preset>.json.gz (atm's own `scenario kpis` export, gzipped
 * without a timestamp), views/<preset>/ (atm's writeViews over the preset's event log, for the presets atm can replay)
 * and SNAPSHOT.md (hashes, the atm commit, and atm's error for every preset it cannot replay). Refuses unless every
 * preset's fixtureHash and kpisHash equal packages/atm/tests/golden/scenarios on this checkout and kpiHash(rows)
 * recomputed with atm's canonicalize equals kpisHash.
 */
import { execFileSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { menuCatalogRows } from "../../../../packages/atm/src/billing/grants.ts";
import {
	canonicalize,
	sha256Hex,
} from "../../../../packages/atm/src/ledger/util.ts";
import { FolderStore } from "../../../../packages/atm/src/store/folder-store.ts";
import { buildViews, writeViews } from "../../../../packages/atm/src/worker.ts";

type KpiRow = { kpiId: string; period: string; value: number };
type KpiExport = {
	fixtureHash: string;
	kpisHash: string;
	profile: string;
	rows: KpiRow[];
};

const fromIndex = process.argv.indexOf("--from");
const source =
	fromIndex > 0 ? (process.argv[fromIndex + 1] ?? "") : "/tmp/atm-mart";
const target = "plans/ledger-ui/design/mart";
const goldenDirectory = "packages/atm/tests/golden/scenarios";
const sha = (bytes: Uint8Array | string): string =>
	sha256Hex(
		typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
	);
const byId = (first: KpiRow, second: KpiRow): number =>
	first.kpiId < second.kpiId
		? -1
		: first.kpiId > second.kpiId
			? 1
			: first.period < second.period
				? -1
				: first.period > second.period
					? 1
					: 0;
const kpiHash = (rows: readonly KpiRow[]): string =>
	sha(
		canonicalize(
			[...rows]
				.sort(byId)
				.map(({ kpiId, period, value }) => ({ kpiId, period, value })),
		),
	);

const bundleText = readFileSync(join(source, "out/bundle.json"), "utf8");
const bundle = JSON.parse(bundleText) as {
	reconcile: { cells: number; ok: number };
	profiles: Record<string, unknown>;
};
if (bundle.reconcile.ok !== bundle.reconcile.cells)
	throw new Error(
		`mart reconcile ${bundle.reconcile.ok}/${bundle.reconcile.cells}`,
	);
const presets = Object.keys(bundle.profiles).sort();

rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, "kpis"), { recursive: true });
writeFileSync(join(target, "bundle.json"), bundleText);
cpSync(join(source, "out/dashboard.html"), join(target, "dashboard.html"));
cpSync(join(source, "README.md"), join(target, "README.md"));

const lines: string[] = [];
const replayErrors: string[] = [];
for (const preset of presets) {
	const exportText = readFileSync(
		join(source, `kpis/${preset}/kpis.json`),
		"utf8",
	);
	const exported = JSON.parse(exportText) as KpiExport;
	const golden = JSON.parse(
		readFileSync(join(goldenDirectory, `${preset}.json`), "utf8"),
	) as KpiExport;
	if (
		exported.fixtureHash !== golden.fixtureHash ||
		exported.kpisHash !== golden.kpisHash
	) {
		throw new Error(`${preset}: export hashes differ from ${goldenDirectory}`);
	}
	if (kpiHash(exported.rows) !== exported.kpisHash)
		throw new Error(`${preset}: kpiHash(rows) differs from kpisHash`);
	const gzipped = gzipSync(exportText, { level: 9 });
	writeFileSync(join(target, `kpis/${preset}.json.gz`), gzipped);

	const directory = join(source, `events/${preset}`);
	const events = readFileSync(join(directory, "events.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const menu = JSON.parse(readFileSync(join(directory, "menu.json"), "utf8"));
	const school = events[0].school as string;
	const asOf = new Date(
		events
			.map((event) => event.event_time as string)
			.sort()
			.at(-1) as string,
	);
	const result = buildViews(events, {
		school,
		asOf,
		catalog: menuCatalogRows({ menu, school }),
	});
	let views = "not replayable";
	if (result.ok) {
		await writeViews(
			new FolderStore({ root: join(target, "views", preset) }),
			school,
			result.views,
		);
		views = `views at asOf ${asOf.toISOString()}`;
	} else {
		replayErrors.push(
			`- \`${preset}\`: ${result.error.kind}: ${result.error.message}`,
		);
	}
	lines.push(
		`| \`${preset}\` | \`${exported.fixtureHash}\` | \`${exported.kpisHash}\` | \`${sha(exportText)}\` | ${views} |`,
	);
}

const atmCommit = execFileSync("git", ["rev-parse", "HEAD"], {
	encoding: "utf8",
}).trim();
writeFileSync(
	join(target, "SNAPSHOT.md"),
	`# Mart snapshot

Written by \`plans/ledger-ui/loop/tools/snapshot-mart.ts\`; do not edit by hand. Source: the coordinating atm session's mart (\`${source}\`), checked against atm at \`${atmCommit}\`.

- \`bundle.json\` sha256 \`${sha(bundleText)}\`, reconcile ${bundle.reconcile.ok}/${bundle.reconcile.cells}
- \`kpis/<preset>.json.gz\`: atm's own \`scenario kpis\` export, gzipped; its fixtureHash and kpisHash equal \`${goldenDirectory}\`, and kpiHash(rows) recomputed with atm's \`canonicalize\` equals kpisHash
- \`views/<preset>/\`: atm's \`writeViews\` output (objects plus \`views/manifest.json\` with a sha256 per object) for the presets atm can replay

| Preset | fixtureHash | kpisHash | sha256 of kpis.json | Read slice |
|---|---|---|---|---|
${lines.join("\n")}

Presets atm's read slice cannot replay (atm's error, verbatim):

${replayErrors.length ? replayErrors.join("\n") : "- none"}
`,
);
process.stdout.write(
	`${presets.length} presets, ${presets.length - replayErrors.length} with views\n`,
);
