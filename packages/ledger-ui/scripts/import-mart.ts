/**
 * Writes `src/fixtures/mart/` from the mart snapshot (protocol §4): `cell-rules.json` (a copy of
 * `plans/ledger-ui/loop/cell-rules.v2.json`), `rows.json` (per preset, atm's export rows of the KPIs `cell-rules`
 * names, so no `closing_balance_*` and no holder-dimensioned rows) and `documents.json` (the oracle's document for
 * every preset x viewer x grain). Refuses unless every export's fixtureHash and kpisHash equal atm's goldens and
 * kpiHash(rows) equals kpisHash. Deterministic. Usage, from packages/ledger-ui: bun scripts/import-mart.ts
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { canonicalize, sha256Hex } from "../../atm/src/ledger/util.ts";
import {
	type CellRules,
	type KpiRow,
	kpiDocument,
	type PresetBundle,
} from "../gates/oracle.ts";
import type { Grain, KpiDocument, Viewer } from "../src/data/kpi-document.ts";

export const viewers: readonly Viewer[] = [
	"owner",
	"finance",
	"admin",
	"locked",
	"demo",
];
export const grains: readonly Grain[] = ["month", "quarter"];
export const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };

const packageRoot = join(import.meta.dir, "..");
const repositoryRoot = join(packageRoot, "..", "..");
export const snapshot = join(repositoryRoot, "plans/ledger-ui/design/mart");
export const cellRulesPath = join(
	repositoryRoot,
	"plans/ledger-ui/loop/cell-rules.v2.json",
);
const goldens = join(repositoryRoot, "packages/atm/tests/golden/scenarios");
export const output = join(packageRoot, "src/fixtures/mart");

type KpiExport = {
	fixtureHash: string;
	kpisHash: string;
	rows: KpiRow[];
};
type Bundle = { profiles: Record<string, PresetBundle> };

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
	sha256Hex(
		canonicalize(
			[...rows]
				.sort(byId)
				.map(({ kpiId, period, value }) => ({ kpiId, period, value })),
		),
	);

export const readExport = (preset: string): KpiExport =>
	JSON.parse(
		gunzipSync(
			readFileSync(join(snapshot, "kpis", `${preset}.json.gz`)),
		).toString("utf8"),
	) as KpiExport;
export const readBundle = (): Bundle =>
	JSON.parse(readFileSync(join(snapshot, "bundle.json"), "utf8")) as Bundle;
export const readRules = (): CellRules =>
	JSON.parse(readFileSync(cellRulesPath, "utf8")) as CellRules;
export const presetsOf = (): string[] =>
	readdirSync(join(snapshot, "kpis"))
		.filter((name) => name.endsWith(".json.gz"))
		.map((name) => name.slice(0, -".json.gz".length))
		.sort();

/** The KPI ids `cell-rules` names: an exact id, or `<kpi>:<dimension>` under a `<kpi>:*` entry. */
export const namedIn =
	(rules: CellRules) =>
	(kpiId: string): boolean =>
		kpiId in rules.kpis ||
		(kpiId.includes(":") &&
			`${kpiId.slice(0, kpiId.indexOf(":"))}:*` in rules.kpis);
const holderPattern = /(?:family|profile):/;

export const documentKey = (
	preset: string,
	viewer: Viewer,
	grain: Grain,
): string => `${preset}.${viewer}.${grain}`;

export const serialize = (value: unknown): string =>
	`${JSON.stringify(value, null, "\t")}\n`;

function main(): void {
	const rules = readRules();
	const bundle = readBundle();
	const presets = presetsOf();
	const named = namedIn(rules);
	const problems: string[] = [];
	const rows: Record<string, KpiRow[]> = {};
	for (const preset of presets) {
		const exported = readExport(preset);
		const golden = JSON.parse(
			readFileSync(join(goldens, `${preset}.json`), "utf8"),
		) as KpiExport;
		if (exported.fixtureHash !== golden.fixtureHash)
			problems.push(`${preset}: fixtureHash differs from atm's golden`);
		if (exported.kpisHash !== golden.kpisHash)
			problems.push(`${preset}: kpisHash differs from atm's golden`);
		if (kpiHash(exported.rows) !== exported.kpisHash)
			problems.push(`${preset}: kpiHash(rows) differs from kpisHash`);
		if (!bundle.profiles[preset])
			problems.push(`${preset}: not in bundle.json`);
		rows[preset] = [...exported.rows]
			.filter((row) => named(row.kpiId) && !holderPattern.test(row.kpiId))
			.sort(byId)
			.map(({ kpiId, period, unit, value }) => ({
				kpiId,
				period,
				unit,
				value,
			}));
	}
	if (problems.length) {
		process.stderr.write(
			`refusing to import the mart:\n${problems.join("\n")}\n`,
		);
		process.exit(1);
	}
	const documents: Record<string, KpiDocument> = {};
	for (const preset of presets) {
		const presetBundle = bundle.profiles[preset];
		if (!presetBundle) throw new Error(`${preset}: not in bundle.json`);
		for (const viewer of viewers)
			for (const grain of grains)
				documents[documentKey(preset, viewer, grain)] = kpiDocument({
					rows: rows[preset] ?? [],
					bundle: presetBundle,
					rules,
					preset,
					viewer,
					grain,
					clock,
				});
	}
	mkdirSync(output, { recursive: true });
	writeFileSync(join(output, "cell-rules.json"), serialize(rules));
	writeFileSync(join(output, "rows.json"), serialize(rows));
	writeFileSync(join(output, "documents.json"), serialize(documents));
	const sizes = ["cell-rules.json", "rows.json", "documents.json"].map(
		(name) => `${name} ${statSync(join(output, name)).size} bytes`,
	);
	process.stdout.write(
		`${presets.length} presets, ${Object.keys(documents).length} documents; ${sizes.join(", ")}\n`,
	);
}

if (import.meta.main) main();
