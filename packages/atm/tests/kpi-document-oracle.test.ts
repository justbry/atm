/**
 * `kpiDocument` of `atm/worker` against the independent implementation, `packages/ledger-ui/gates/oracle.ts`, on the same
 * inputs: the 15 mart presets of the snapshot (`plans/ledger-ui/design/mart/kpis`), for B4 Uni (small) and the scaled
 * Harbor Arts Academy (large), the five audiences, and the PIN open and locked from governance up. The documents must
 * be `canonicalize`-equal, byte for byte. The oracle is loaded by a computed path: it imports with `.ts` extensions and
 * is checked under the UI package's own compiler options, not this package's.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { applyOverride } from "../src/ledger/kpi-disclosure.js";
import { canonicalize, sha256Hex } from "../src/ledger/util.js";
import {
	audiences,
	type KpiDisclosure,
	type KpiDocumentContext,
	type KpiDocumentRow,
	type KpiGift,
	kpiDocument,
} from "../src/worker.js";

const REPOSITORY = resolve(import.meta.dir, "../../..");
const UI = join(REPOSITORY, "packages/ledger-ui");
const SNAPSHOT = join(REPOSITORY, "plans/ledger-ui/design/mart");
const CLOCK = { today: "2026-11-05", now: "2026-11-05T12:00" };
const YEAR = 2026;

type OracleDocument = ReturnType<typeof kpiDocument>;
type OracleSource = {
	kind: "mart" | "events";
	values: Record<string, Array<number | null>>;
	tiers: Array<{ id: string; title: string }>;
	days: number[][] | null;
	invented: boolean;
};
type Oracle = {
	martSource: (
		rows: KpiDocumentRow[],
		bundle: unknown,
		year: number,
		donors: KpiGift[],
		scale: { money: number; count: number } | null,
	) => OracleSource;
	kpiDocument: (input: {
		school: string;
		size: KpiDisclosure["size"];
		file: ReturnType<typeof applyOverride>;
		audience: (typeof audiences)[number];
		pinLocked: boolean;
		currency: string;
		preset: string | null;
		source: OracleSource;
		clock: typeof CLOCK;
	}) => OracleDocument;
	largeSchoolScale: { money: number; count: number };
};
type DisclosureFixture = {
	file: KpiDisclosure["file"];
	schools: Record<
		string,
		{ size: KpiDisclosure["size"]; override: KpiDisclosure["override"] }
	>;
};
type Bundle = {
	profiles: Record<
		string,
		{ params: { currency?: string }; tiers: Record<string, unknown> }
	>;
};

const oraclePath = join(UI, "gates/oracle.ts");
const oracle = (await import(oraclePath)) as Oracle;
const readJson = <T>(path: string): T =>
	JSON.parse(readFileSync(path, "utf8")) as T;
const disclosureFixture = readJson<DisclosureFixture>(
	join(UI, "src/fixtures/disclosure.json"),
);
const mockup = readJson<{ donors: Record<string, KpiGift[]> }>(
	join(UI, "gates/mockup-schools.json"),
);
const bundle = readJson<Bundle>(join(SNAPSHOT, "bundle.json"));
const presets = readdirSync(join(SNAPSHOT, "kpis"))
	.filter((name) => name.endsWith(".json.gz"))
	.map((name) => name.slice(0, -".json.gz".length))
	.sort();
const rowsOf = (preset: string): KpiDocumentRow[] =>
	(
		JSON.parse(
			gunzipSync(
				readFileSync(join(SNAPSHOT, "kpis", `${preset}.json.gz`)),
			).toString("utf8"),
		) as { rows: KpiDocumentRow[] }
	).rows;

const variants = audiences.flatMap((audience) =>
	audiences.indexOf(audience) >= audiences.indexOf("governance")
		? [
				{ audience, pinLocked: false },
				{ audience, pinLocked: true },
			]
		: [{ audience, pinLocked: false }],
);
/** The two mart schools: B4 Uni's figures, and Harbor Arts Academy's, scaled (money by 40, counts by 10). */
const schools = [
	{ school: "b4u", scale: null },
	{ school: "har", scale: oracle.largeSchoolScale },
] as const;

const disclosureOf = (school: string): KpiDisclosure => {
	const found = disclosureFixture.schools[school];
	if (!found) throw new Error(`${school} is not in disclosure.json`);
	return {
		size: found.size,
		file: disclosureFixture.file,
		override: found.override,
	};
};
const scaledRows = (
	rows: KpiDocumentRow[],
	scale: { money: number; count: number } | null,
): KpiDocumentRow[] =>
	scale
		? rows.map((row) => ({
				...row,
				value: row.value * (row.unit === "cents" ? scale.money : scale.count),
			}))
		: rows;

/** The Worker's document and the oracle's for one school, preset, audience and PIN state. */
const both = (
	school: string,
	preset: string,
	scale: { money: number; count: number } | null,
	audience: (typeof audiences)[number],
	pinLocked: boolean,
	extra: { days?: number[][] } = {},
): { worker: OracleDocument; oracle: OracleDocument } => {
	const rows = rowsOf(preset);
	const profile = bundle.profiles[preset];
	if (!profile) throw new Error(`${preset}: no bundle profile`);
	const donors = mockup.donors[school] ?? [];
	const disclosure = disclosureOf(school);
	const currency = profile.params.currency ?? "usd";
	const source = oracle.martSource(
		rows.filter(
			(row) =>
				!row.kpiId.startsWith("closing_balance") &&
				!/(?:family|profile):/.test(row.kpiId) &&
				row.kpiId !== "credits_outstanding",
		),
		profile,
		YEAR,
		donors.map((gift) => ({ ...gift })),
		scale,
	);
	if (extra.days) source.days = extra.days;
	const context: KpiDocumentContext = {
		school,
		currency,
		clock: CLOCK,
		preset,
		plans: source.tiers.map((tier) => tier.id),
		donors,
		days: source.days,
		invented: scale !== null,
	};
	return {
		worker: kpiDocument(
			scaledRows(rows, scale),
			{},
			disclosure,
			audience,
			pinLocked,
			context,
		),
		oracle: oracle.kpiDocument({
			school,
			size: disclosure.size,
			file: applyOverride(disclosure.file, disclosure.override),
			audience,
			pinLocked,
			currency,
			preset,
			source,
			clock: CLOCK,
		}),
	};
};

describe("kpiDocument (atm/worker) equals gates/oracle.ts", () => {
	test("the snapshot holds the 15 presets", () => {
		expect(presets).toHaveLength(15);
	});

	for (const { school, scale } of schools)
		for (const preset of presets)
			test(`${school} ${preset}: every audience, PIN open and locked`, () => {
				for (const { audience, pinLocked } of variants) {
					const pair = both(school, preset, scale, audience, pinLocked);
					expect(
						canonicalize(pair.worker),
						`${school}/${preset}.${audience}${pinLocked ? ".pin-locked" : ""}`,
					).toBe(canonicalize(pair.oracle));
				}
			});

	test("the Worker's documents hash to the committed provenance.json", () => {
		const provenance = readJson<Record<string, { sha256: string }>>(
			join(UI, "src/fixtures/mart/provenance.json"),
		);
		let checked = 0;
		for (const { school, scale } of schools)
			for (const preset of presets)
				for (const { audience, pinLocked } of variants) {
					const key = `${school === "b4u" ? preset : `${school}/${preset}`}.${audience}${pinLocked ? ".pin-locked" : ""}`;
					const { worker } = both(school, preset, scale, audience, pinLocked);
					expect(sha256Hex(canonicalize(worker)), key).toBe(
						provenance[key]?.sha256 as string,
					);
					checked += 1;
				}
		expect(checked).toBe(2 * 15 * variants.length);
	});

	test("the documents carry what the oracle now emits", () => {
		const { worker } = both("b4u", "disputes", null, "governance", false);
		const month = worker.tables.month;
		expect(month?.changes).toBeDefined();
		expect(month?.order?.revenue_by_tier?.length).toBe(month?.periods.length);
		expect(month?.order?.donations_by_fund).toBeDefined();
		expect(Object.keys(worker.tables.month?.series ?? {})).toContain(
			"dispute_cost",
		);
		expect(worker.meta.dispute_cost?.title).toBe("Dispute cost");
	});

	test("a day source replaces the weighted split, as in the oracle", () => {
		const days = Array.from({ length: 12 }, (_, month) =>
			Array.from(
				{ length: new Date(Date.UTC(YEAR, month + 1, 0)).getUTCDate() },
				(_, day) => 100 * (month + 1) + day,
			),
		);
		for (const audience of ["finance", "owner"] as const) {
			const pair = both("b4u", "growth-12mo", null, audience, false, { days });
			expect(canonicalize(pair.worker)).toBe(canonicalize(pair.oracle));
			expect(pair.worker.tables.day?.series.gross_collected?.[1]).toBe(101);
		}
	});

	test("a PIN-locked document below governance is refused", () => {
		expect(() => both("b4u", "growth-12mo", null, "public", true)).toThrow(
			"public opens no books with a PIN",
		);
	});

	test("a school's own events: no preset, no donors, no plans given", () => {
		const rows = rowsOf("growth-12mo");
		const document = kpiDocument(
			rows,
			{},
			disclosureOf("b4u"),
			"owner",
			false,
			{
				school: "own",
				currency: "usd",
				clock: CLOCK,
			},
		);
		expect(document.source).toEqual({ kind: "events" });
		expect(document.dataSource).toBe("events");
		expect(Object.keys(document.tables.month?.series ?? {})).not.toContain(
			"donors_count",
		);
		expect(document.notes.join(" ")).not.toContain("fixture gifts");
	});
});

describe("the output types are the UI's", () => {
	test("kpi-document-types.ts is the type block of ledger-ui's kpi-document.ts", () => {
		const block = (path: string): string => {
			const text = readFileSync(path, "utf8");
			return text.slice(
				text.indexOf("/** Why a cell is not a figure."),
				text.indexOf("/** What the Reader's"),
			);
		};
		const ui = block(join(UI, "src/data/kpi-document.ts"));
		const worker = readFileSync(
			join(import.meta.dir, "../src/ledger/kpi-document-types.ts"),
			"utf8",
		);
		expect(ui.length).toBeGreaterThan(1000);
		expect(worker).toContain(ui.trimEnd());
	});
});
