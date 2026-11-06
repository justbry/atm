/**
 * Writes `src/fixtures/mart/` (protocol §4; disclosure spec v2):
 * - `rows.json`, per preset, atm's export rows of the KPIs the documents read (no `closing_balance_*`, no holder ids);
 * - `documents.json`, the oracle's document for every school, data source, audience and PIN state, with the rules of
 *   the disclosure object (`src/fixtures/disclosure.json`: the B4 Uni file, each school's override and size): B4 Uni and
 *   Harbor Arts Academy from the mart (keys `<preset>.<audience>` and `har/<preset>.<audience>`), Vibes of Light, Maple
 *   Pilates and Lotus Lane Yoga from the mockup's own events (`gates/mockup-schools.json`, keys `<school>.<audience>`),
 *   each with a `.pin-locked` variant from governance up;
 * - `provenance.json`, per document: sha256 of atm's `canonicalize(document)` and its sources: the preset's
 *   fixtureHash and kpisHash (atm's stage hashes) for the mart, the mockup's sha256 for the events schools.
 * The first two are generated, not committed (ignored by git, rebuilt by `dev`, `build`, `test`, the test preload and
 * the gate runner). `provenance.json` is committed: a normal run checks the documents against it and refuses on any
 * difference; only `--record` (the orchestrator, after a deliberate change) rewrites it.
 * Refuses unless every export's fixtureHash and kpisHash equal atm's goldens and kpiHash(rows) equals kpisHash.
 * Deterministic. Usage, from packages/ledger-ui: bun scripts/import-mart.ts [--record]
 */
import {
	existsSync,
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
	documentKey,
	documentVariants,
	eventsSource,
	type Gift,
	type KpiRow,
	kpiDocument,
	largeSchoolScale,
	type MockupSchool,
	type MonthlySource,
	martSource,
	type PresetBundle,
} from "../gates/oracle.ts";
import {
	applyOverride,
	type Disclosure,
	type DisclosureFile,
} from "../src/data/disclosure.ts";
import type { KpiDocument } from "../src/data/kpi-document.ts";

export const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
const packageRoot = join(import.meta.dir, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const snapshot = join(repositoryRoot, "plans/ledger-ui/design/mart");
const goldens = join(repositoryRoot, "packages/atm/tests/golden/scenarios");
const output = join(packageRoot, "src/fixtures/mart");

type KpiExport = { fixtureHash: string; kpisHash: string; rows: KpiRow[] };
type Bundle = { profiles: Record<string, PresetBundle> };
export type DisclosureFixture = {
	file: DisclosureFile;
	schools: Record<string, Disclosure>;
};
export type MockupSchools = {
	mockupSha256: string;
	schools: Record<string, MockupSchool>;
	donors: Record<string, Gift[]>;
};
export type Provenance =
	| {
			sha256: string;
			school: string;
			preset: string;
			fixtureHash: string;
			kpisHash: string;
	  }
	| { sha256: string; school: string; mockupSha256: string };
/** One document to build: its key, the query, and its source. */
export type DocumentPlan = {
	key: string;
	school: string;
	preset: string | null;
	build: () => KpiDocument;
	provenance: (sha256: string) => Provenance;
};

/** The schools whose Dashboard shows the mart's presets (the mockup's `s.kpi` schools) and how each scales them. */
export const martSchools: Record<
	string,
	{ scale: typeof largeSchoolScale | null }
> = {
	b4u: { scale: null },
	har: { scale: largeSchoolScale },
};
/** The mockup's currency symbols (`s.cur`) for the events schools. */
const currencyOfSymbol: Record<string, string> = { $: "usd", C$: "cad" };

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
const readJson = <T>(path: string): T =>
	JSON.parse(readFileSync(path, "utf8")) as T;
/** The export rows the documents read: atm's school-level KPIs (no closing balances, no holder ids). */
export const namedRow = (kpiId: string): boolean =>
	!kpiId.startsWith("closing_balance") &&
	!/(?:family|profile):/.test(kpiId) &&
	kpiId !== "credits_outstanding";
const serialize = (value: unknown): string =>
	`${JSON.stringify(value, null, "\t")}\n`;

/** Every document, from the committed inputs: the snapshot, the disclosure fixture and the mockup's schools. */
export function plan(
	rows: Record<string, KpiRow[]>,
	sources: Record<string, KpiExport>,
): DocumentPlan[] {
	const bundle = readJson<Bundle>(join(snapshot, "bundle.json"));
	const disclosure = readJson<DisclosureFixture>(
		join(packageRoot, "src/fixtures/disclosure.json"),
	);
	const mockup = readJson<MockupSchools>(
		join(packageRoot, "gates/mockup-schools.json"),
	);
	const schoolOf = (school: string) => {
		const found = disclosure.schools[school];
		if (!found) throw new Error(`${school} is not in disclosure.json`);
		return {
			size: found.size,
			file: applyOverride(disclosure.file, found.override),
		};
	};
	const plans: DocumentPlan[] = [];
	for (const [school, { scale }] of Object.entries(martSchools)) {
		const { size, file } = schoolOf(school);
		const gifts = (mockup.donors[school] ?? []).map((gift) => ({ ...gift }));
		for (const preset of Object.keys(sources).sort()) {
			const presetBundle = bundle.profiles[preset];
			const exported = sources[preset];
			if (!presetBundle || !exported) throw new Error(`${preset}: no source`);
			let source: MonthlySource | null = null;
			for (const { audience, pinLocked } of documentVariants())
				plans.push({
					key: documentKey({ school, preset, audience, pinLocked }),
					school,
					preset,
					build: () => {
						source ??= martSource(
							rows[preset] ?? [],
							presetBundle,
							Number(clock.today.slice(0, 4)),
							gifts,
							scale,
						);
						return kpiDocument({
							school,
							size,
							file,
							audience,
							pinLocked,
							currency: presetBundle.params.currency ?? "usd",
							preset,
							source,
							clock,
						});
					},
					provenance: (sha256) => ({
						sha256,
						school,
						preset,
						fixtureHash: exported.fixtureHash,
						kpisHash: exported.kpisHash,
					}),
				});
		}
	}
	for (const [school, data] of Object.entries(mockup.schools)) {
		const { size, file } = schoolOf(school);
		const source = eventsSource(data);
		for (const { audience, pinLocked } of documentVariants())
			plans.push({
				key: documentKey({ school, preset: null, audience, pinLocked }),
				school,
				preset: null,
				build: () =>
					kpiDocument({
						school,
						size,
						file,
						audience,
						pinLocked,
						currency: currencyOfSymbol[data.currency] ?? "usd",
						preset: null,
						source,
						clock,
					}),
				provenance: (sha256) => ({
					sha256,
					school,
					mockupSha256: mockup.mockupSha256,
				}),
			});
	}
	return plans;
}

/** atm's exports, refused unless they equal atm's goldens; and the rows the documents read. */
export function importRows(): {
	rows: Record<string, KpiRow[]>;
	sources: Record<string, KpiExport>;
	problems: string[];
} {
	const presets = readdirSync(join(snapshot, "kpis"))
		.filter((name) => name.endsWith(".json.gz"))
		.map((name) => name.slice(0, -".json.gz".length))
		.sort();
	const problems: string[] = [];
	const rows: Record<string, KpiRow[]> = {};
	const sources: Record<string, KpiExport> = {};
	for (const preset of presets) {
		const exported = readExport(preset);
		const golden = readJson<KpiExport>(join(goldens, `${preset}.json`));
		if (exported.fixtureHash !== golden.fixtureHash)
			problems.push(`${preset}: fixtureHash differs from atm's golden`);
		if (exported.kpisHash !== golden.kpisHash)
			problems.push(`${preset}: kpisHash differs from atm's golden`);
		if (kpiHash(exported.rows) !== exported.kpisHash)
			problems.push(`${preset}: kpiHash(rows) differs from kpisHash`);
		sources[preset] = exported;
		rows[preset] = [...exported.rows]
			.filter((row) => namedRow(row.kpiId))
			.sort(byId)
			.map(({ kpiId, period, unit, value }) => ({
				kpiId,
				period,
				unit,
				value,
			}));
	}
	return { rows, sources, problems };
}

function main(): void {
	const { rows, sources, problems } = importRows();
	if (problems.length) {
		process.stderr.write(
			`refusing to import the mart:\n${problems.join("\n")}\n`,
		);
		process.exit(1);
	}
	const documents: Record<string, KpiDocument> = {};
	const provenance: Record<string, Provenance> = {};
	for (const entry of plan(rows, sources)) {
		const document = entry.build();
		documents[entry.key] = document;
		provenance[entry.key] = entry.provenance(sha256Hex(canonicalize(document)));
	}
	mkdirSync(output, { recursive: true });
	const record = process.argv.includes("--record");
	const provenancePath = join(output, "provenance.json");
	if (!record) {
		const recorded = existsSync(provenancePath)
			? readJson<Record<string, Provenance>>(provenancePath)
			: {};
		const differences = [
			...new Set([...Object.keys(recorded), ...Object.keys(provenance)]),
		].filter(
			(key) =>
				canonicalize(recorded[key] ?? null) !==
				canonicalize(provenance[key] ?? null),
		);
		if (differences.length) {
			process.stderr.write(
				`refusing to write the fixtures: ${differences.length} documents differ from the committed provenance.json (first: ${differences[0]}); after a deliberate change run with --record\n`,
			);
			process.exit(1);
		}
	}
	const files: Record<string, unknown> = {
		"rows.json": rows,
		"documents.json": documents,
		...(record ? { "provenance.json": provenance } : {}),
	};
	for (const [name, value] of Object.entries(files))
		writeFileSync(join(output, name), serialize(value));
	const sizes = Object.keys(files).map(
		(name) => `${name} ${statSync(join(output, name)).size} bytes`,
	);
	process.stdout.write(
		`${Object.keys(sources).length} presets, ${Object.keys(documents).length} documents, provenance ${record ? "recorded" : "matches"}; ${sizes.join(", ")}\n`,
	);
}

if (import.meta.main) main();
