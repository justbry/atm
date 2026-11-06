/**
 * Writes `src/fixtures/mart/` from the mart snapshot (protocol §4, §11b):
 * - `cell-rules.json`, a copy of `plans/ledger-ui/loop/cell-rules.v3.json`;
 * - `rows.json`, per preset, atm's export rows of the KPIs `cell-rules` names (no `closing_balance_*`, no holder ids);
 * - `documents.json`, the oracle's document for every preset and books level, plus the PIN-locked variant from
 *   governance up (`<preset>.<level>` and `<preset>.<level>.pin-locked`);
 * - `provenance.json`, per document: sha256 of atm's `canonicalize(document)` and the source preset's fixtureHash and
 *   kpisHash, so each level's document traces to atm's stage hashes.
 * Refuses unless every export's fixtureHash and kpisHash equal atm's goldens and kpiHash(rows) equals kpisHash.
 * Deterministic. Usage, from packages/ledger-ui: bun scripts/import-mart.ts
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
	documentKey,
	documentVariants,
	type KpiRow,
	kpiDocument,
	type PresetBundle,
} from "../gates/oracle.ts";
import type { KpiDocument } from "../src/data/kpi-document.ts";

const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
const packageRoot = join(import.meta.dir, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const snapshot = join(repositoryRoot, "plans/ledger-ui/design/mart");
const cellRulesPath = join(
	repositoryRoot,
	"plans/ledger-ui/loop/cell-rules.v3.json",
);
const goldens = join(repositoryRoot, "packages/atm/tests/golden/scenarios");
const output = join(packageRoot, "src/fixtures/mart");

type KpiExport = { fixtureHash: string; kpisHash: string; rows: KpiRow[] };
type Bundle = { profiles: Record<string, PresetBundle> };
type Provenance = {
	sha256: string;
	preset: string;
	fixtureHash: string;
	kpisHash: string;
};

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
const readExport = (preset: string): KpiExport =>
	JSON.parse(
		gunzipSync(
			readFileSync(join(snapshot, "kpis", `${preset}.json.gz`)),
		).toString("utf8"),
	) as KpiExport;
const holderPattern = /(?:family|profile):/;
const serialize = (value: unknown): string =>
	`${JSON.stringify(value, null, "\t")}\n`;

function main(): void {
	const rules = JSON.parse(readFileSync(cellRulesPath, "utf8")) as CellRules;
	const bundle = JSON.parse(
		readFileSync(join(snapshot, "bundle.json"), "utf8"),
	) as Bundle;
	const presets = readdirSync(join(snapshot, "kpis"))
		.filter((name) => name.endsWith(".json.gz"))
		.map((name) => name.slice(0, -".json.gz".length))
		.sort();
	const named = (kpiId: string): boolean =>
		kpiId in rules.kpis ||
		(kpiId.includes(":") &&
			`${kpiId.slice(0, kpiId.indexOf(":"))}:*` in rules.kpis);
	const problems: string[] = [];
	const rows: Record<string, KpiRow[]> = {};
	const sources: Record<string, KpiExport> = {};
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
		sources[preset] = exported;
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
	const provenance: Record<string, Provenance> = {};
	for (const preset of presets) {
		const presetBundle = bundle.profiles[preset];
		const source = sources[preset];
		if (!presetBundle || !source) throw new Error(`${preset}: no source`);
		for (const { level, pinLocked } of documentVariants(rules)) {
			const key = documentKey(preset, level, pinLocked);
			const document = kpiDocument({
				rows: rows[preset] ?? [],
				bundle: presetBundle,
				rules,
				preset,
				level,
				pinLocked,
				clock,
			});
			documents[key] = document;
			provenance[key] = {
				sha256: sha256Hex(canonicalize(document)),
				preset,
				fixtureHash: source.fixtureHash,
				kpisHash: source.kpisHash,
			};
		}
	}
	mkdirSync(output, { recursive: true });
	const files: Record<string, unknown> = {
		"cell-rules.json": rules,
		"rows.json": rows,
		"documents.json": documents,
		"provenance.json": provenance,
	};
	for (const [name, value] of Object.entries(files))
		writeFileSync(join(output, name), serialize(value));
	const sizes = Object.keys(files).map(
		(name) => `${name} ${statSync(join(output, name)).size} bytes`,
	);
	process.stdout.write(
		`${presets.length} presets, ${Object.keys(documents).length} documents; ${sizes.join(", ")}\n`,
	);
}

main();
