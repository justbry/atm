/**
 * What `bun model/build.ts` generates from the ledger model (`src/model/generate.ts`), against what it replaces and what
 * reads it: the files on disk are the generator's bytes (and Biome's); the class table is the UI fixture's; the derived
 * KPIs are the UI's; the catalog is the KPI document's (its need, ruleOf, inputs and money0 facts); every `x-measure`,
 * `x-jsonld-type` and `$ref` of the OpenAPI components resolves, and real KPI documents (mart presets, both mart schools,
 * the five audiences, PIN open and locked) validate against `KpiDocument` with Ajv 2020; every JSON-LD term expands to
 * an IRI under a declared prefix. The UI's `disclosure.ts` and the oracle load by a computed path, as in
 * `kpi-document-oracle.test.ts`: they are checked under the UI package's own compiler options.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { Ajv2020 } from "ajv/dist/2020.js";
import modelSchema from "../schema/model.v1.json";
import { derivedKpiCatalog, kpiCatalog } from "../src/ledger/kpi-catalog.js";
import {
	applyOverride,
	audiences,
	derivedKpis,
	detailSteps,
	disclosureGrains,
	type KpiDisclosure,
	kpiClasses,
} from "../src/ledger/kpi-disclosure.js";
import {
	type KpiDocumentContext,
	type KpiDocumentRow,
	type KpiGift,
	kpiDocument,
	roundedQuartersKpi,
} from "../src/ledger/kpi-document.js";
import {
	catalogKey,
	derivedKpisOf,
	dimensionTerm,
	disclosureClassesOf,
	documentFacts,
	documentMeasures,
	generatedDirectory,
	generateModelFiles,
	kpiCatalogOf,
	kpiDocumentOpenApiOf,
} from "../src/model/generate.js";
import { LEDGER_MODEL, termIri } from "../src/model/ledger-model.js";

const PACKAGE = resolve(import.meta.dir, "..");
const REPOSITORY = resolve(PACKAGE, "../..");
const UI = join(REPOSITORY, "packages/ledger-ui");
const SNAPSHOT = join(REPOSITORY, "plans/ledger-ui/design/mart");
const BIOME = join(REPOSITORY, "node_modules/.bin/biome");
const CLOCK = { today: "2026-11-05", now: "2026-11-05T12:00" };
const YEAR = 2026;

const { model, measures } = LEDGER_MODEL;
const files = generateModelFiles(LEDGER_MODEL);
const readJson = <T>(path: string): T =>
	JSON.parse(readFileSync(path, "utf8")) as T;
const generated = <T>(name: string): T =>
	readJson<T>(join(PACKAGE, generatedDirectory, name));
const measureById = new Map(measures.map((measure) => [measure.id, measure]));
const expand = (curie: string): string => {
	const [prefix = "", ...rest] = curie.split(":");
	const namespace = model.prefixes[prefix];
	if (!namespace) throw new Error(`${curie}: no prefix ${prefix}`);
	return `${namespace}${rest.join(":")}`;
};
const entityIris = new Set(
	model.entities.map((entity) => termIri.entity(model, entity.id)),
);

type DisclosureFixture = {
	file: KpiDisclosure["file"];
	schools: Record<
		string,
		{ size: KpiDisclosure["size"]; override: KpiDisclosure["override"] }
	>;
};
const disclosureFixture = readJson<DisclosureFixture>(
	join(UI, "src/fixtures/disclosure.json"),
);

type Oracle = {
	martSource: (
		rows: KpiDocumentRow[],
		bundle: unknown,
		year: number,
		donors: KpiGift[],
		scale: { money: number; count: number } | null,
	) => {
		tiers: Array<{ id: string }>;
		days: number[][] | null;
	};
	kpiDocument: (
		input: Record<string, unknown>,
	) => ReturnType<typeof kpiDocument>;
	largeSchoolScale: { money: number; count: number };
};
const oracle = (await import(join(UI, "gates/oracle.ts"))) as Oracle;

describe("the generated files", () => {
	test("on disk, each is the generator's bytes, and nothing else is in model/generated", () => {
		for (const file of files)
			expect(
				readFileSync(join(PACKAGE, file.path), "utf8"),
				`${file.path} is stale or hand-edited: run bun model/build.ts`,
			).toBe(file.content);
		expect(readdirSync(join(PACKAGE, generatedDirectory)).sort()).toEqual(
			files.map((file) => basename(file.path)).sort(),
		);
	});

	test("Biome's formatter leaves the generator's bytes as they are", () => {
		for (const file of files) {
			const formatted = Bun.spawnSync(
				[BIOME, "format", `--stdin-file-path=${join(PACKAGE, file.path)}`],
				{ stdin: new TextEncoder().encode(file.content), cwd: REPOSITORY },
			);
			expect(formatted.exitCode, file.path).toBe(0);
			expect(formatted.stdout.toString(), file.path).toBe(file.content);
		}
	});
});

describe("the disclosure class table and the derived KPIs", () => {
	test("the classes deep-equal the UI fixture's file.classes, in order", () => {
		const { classes } = generated<{ catalog: string; classes: unknown }>(
			"disclosure-classes.v1.json",
		);
		expect(JSON.stringify(classes)).toBe(
			JSON.stringify(disclosureFixture.file.classes),
		);
		expect(classes).toEqual(disclosureClassesOf(LEDGER_MODEL));
		expect(Object.keys(disclosureFixture.file.classes)).toEqual([
			...kpiClasses,
		]);
		expect(disclosureFixture.file.catalog).toBe(model.kpiSpec);
	});

	test("the derived KPIs are the UI's, inputs as sets, and the Worker's derivedKpis is the generated one", async () => {
		const ui = (await import(join(UI, "src/data/disclosure.ts"))) as {
			derivedKpis: Record<string, { inputs: string[]; capped: boolean }>;
		};
		const asSets = (
			table: Record<string, { inputs: string[]; capped: boolean }>,
		) =>
			Object.fromEntries(
				Object.entries(table).map(([id, { inputs, capped }]) => [
					id,
					{ inputs: [...inputs].sort(), capped },
				]),
			);
		expect(asSets(derivedKpisOf(LEDGER_MODEL))).toEqual(asSets(ui.derivedKpis));
		expect(Object.keys(derivedKpisOf(LEDGER_MODEL))).toEqual(
			Object.keys(ui.derivedKpis),
		);
		expect(derivedKpis).toBe(derivedKpiCatalog);
		expect(derivedKpiCatalog).toEqual(derivedKpisOf(LEDGER_MODEL));
	});
});

describe("the KPI catalog", () => {
	const catalog = kpiCatalogOf(LEDGER_MODEL);

	test("the Worker's catalog is the generated one", () => {
		expect(kpiCatalog).toEqual(catalog);
		expect(Object.keys(kpiCatalog)).toEqual(Object.keys(catalog));
	});

	test("one entry per document measure, in document position order, with the model's title, unit, rule and format", () => {
		const carried = measures.filter((measure) => measure.document);
		expect(Object.keys(catalog)).toEqual(
			documentMeasures(measures).map(catalogKey),
		);
		expect(Object.keys(catalog)).toHaveLength(carried.length);
		const positions = documentMeasures(measures).map(
			(measure) => measure.document?.position,
		);
		expect(positions).toEqual(
			[...positions].sort((first, second) => (first ?? 0) - (second ?? 0)),
		);
		const kind = { cents: "money", count: "count", ratio: "rate" } as const;
		for (const measure of carried) {
			const entry = catalog[catalogKey(measure)];
			expect(entry?.title, measure.id).toBe(measure.document?.title as string);
			expect(entry?.kind, measure.id).toBe(kind[measure.unit]);
			expect(entry?.ruleOf, measure.id).toBe(
				measure.disclosure.ruleOf ?? measure.id,
			);
			expect(entry?.format, measure.id).toBe(measure.format);
			expect(entry?.inputs ?? [], measure.id).toEqual(measure.inputs);
		}
	});

	test("need, ruleOf, inputs and money0: the document's facts", () => {
		const needs = Object.fromEntries(
			Object.entries(catalog).flatMap(([key, entry]) =>
				entry.need ? [[key, entry.need]] : [],
			),
		);
		expect(needs).toEqual({
			"revenue_by_kind:*": "categories",
			"revenue_by_tier:*": "breakdown",
			"donations_by_fund:*": "breakdown",
			donors_count: "spread",
			"donors_by_size:*": "spread",
			donors_median_gift: "spread",
		});
		const borrowed = Object.fromEntries(
			Object.entries(catalog).flatMap(([key, entry]) =>
				entry.ruleOf === key.replace(/:\*$/, "") ? [] : [[key, entry.ruleOf]],
			),
		);
		expect(borrowed).toEqual({
			dispute_cost: "disputes_lost",
			"donations_by_fund:*": "revenue_by_tier",
			donors_count: "paying_members",
			"donors_by_size:*": "paying_members",
			donors_median_gift: "paying_members",
		});
		// A rate's inputs are [numerator, denominator]: kpi-document.ts divides the first by the second.
		for (const [key, entry] of Object.entries(catalog)) {
			if (entry.kind !== "rate") continue;
			const compute = measureById.get(key)?.kpi?.compute;
			expect(compute?.op, key).toBe("ratio");
			if (compute?.op === "ratio")
				expect(entry.inputs, key).toEqual([compute.num, compute.den]);
		}
		expect(catalog.refund_rate?.inputs).toEqual(["refunds", "gross_collected"]);
		expect(catalog.dispute_rate?.inputs).toEqual([
			"disputes_opened",
			"payments_count",
		]);
		expect(catalog.breakage_rate?.inputs).toEqual([
			"credits_expired",
			"credits_granted",
		]);
		expect(catalog.arpa?.inputs).toEqual(["gross_collected", "paying_members"]);
		expect(catalog.dispute_cost?.inputs).toEqual([
			"disputes_lost",
			"dispute_fees",
		]);
		expect([...(catalog.net_income?.inputs ?? [])].sort()).toEqual(
			[
				"gross_collected",
				"refunds",
				"stripe_fees",
				"disputes_lost",
				"dispute_fees",
			].sort(),
		);
		// The id-prefix list the meta block used before `format: money0`.
		expect(
			Object.keys(catalog).filter((key) => catalog[key]?.format === "money0"),
		).toEqual([
			"revenue_by_tier:*",
			"donations_by_fund:*",
			"donors_median_gift",
		]);
	});
});

describe("the OpenAPI components", () => {
	const openapi = generated<{
		openapi: string;
		info: { version: string };
		paths: object;
		components: { schemas: Record<string, unknown> };
	}>("kpi-document.openapi.json");
	const walk = (
		node: unknown,
		visit: (key: string, value: unknown) => void,
	): void => {
		if (node === null || typeof node !== "object") return;
		for (const [key, value] of Object.entries(node)) {
			visit(key, value);
			walk(value, visit);
		}
	};

	test("OpenAPI 3.1, no paths yet, the model's version", () => {
		expect(openapi.openapi).toBe("3.1.0");
		expect(openapi.paths).toEqual({});
		expect(openapi.info.version).toBe(model.id);
		expect(openapi).toEqual(
			kpiDocumentOpenApiOf(LEDGER_MODEL) as typeof openapi,
		);
	});

	test("every x-measure is a model measure, every x-jsonld-type a model entity, every $ref resolves", () => {
		const found = { measures: new Set<string>(), types: new Set<string>() };
		walk(openapi, (key, value) => {
			if (key === "x-measure") {
				expect(measureById.has(value as string), String(value)).toBe(true);
				found.measures.add(value as string);
			}
			if (key === "x-jsonld-type") {
				expect(entityIris.has(expand(value as string)), String(value)).toBe(
					true,
				);
				found.types.add(value as string);
			}
			if (key === "$ref") {
				const pointer = (value as string).replace(/^#\//, "").split("/");
				let target: unknown = openapi;
				for (const part of pointer)
					target = (target as Record<string, unknown> | undefined)?.[part];
				expect(target, String(value)).toBeDefined();
			}
		});
		for (const measure of documentMeasures(measures))
			expect(found.measures.has(measure.id), measure.id).toBe(true);
		for (const type of [
			"atm:KpiDocument",
			"atm:KpiCell",
			"atm:Period",
			"atm:Audience",
			"atm:DisclosureClass",
			"atm:MonetaryAmount",
		])
			expect(found.types.has(type), type).toBe(true);
	});

	test("the enums that are not model facts are the Worker's", () => {
		const schemas = openapi.components.schemas as Record<
			string,
			{ enum?: unknown[] }
		>;
		expect(documentFacts.audiences).toEqual([...audiences]);
		expect(documentFacts.tableGrains).toEqual([...disclosureGrains]);
		expect(documentFacts.roundedQuarters.key).toBe(roundedQuartersKpi);
		expect(schemas.KpiClass?.enum).toEqual([...kpiClasses]);
		expect(schemas.DetailStep?.enum).toEqual([...detailSteps]);
		expect(schemas.KpiFormat?.enum).toEqual(
			modelSchema.$defs.measure.properties.format.enum,
		);
	});
});

describe("real KPI documents validate against KpiDocument", () => {
	const openapiId = "https://b4uni.com/_model/kpi-document.openapi.json";
	const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
	ajv.addVocabulary([
		"openapi",
		"info",
		"paths",
		"components",
		"x-generated",
		"x-measure",
		"x-jsonld-type",
	]);
	ajv.addSchema({
		...generated<object>("kpi-document.openapi.json"),
		$id: openapiId,
	});
	const validate = ajv.getSchema(
		`${openapiId}#/components/schemas/KpiDocument`,
	);
	if (!validate) throw new Error("KpiDocument does not compile");
	const problems = (document: unknown): string =>
		validate(document)
			? ""
			: (validate.errors ?? [])
					.slice(0, 5)
					.map((error) => `${error.instancePath} ${error.message}`)
					.join("; ");

	const mockup = readJson<{ donors: Record<string, KpiGift[]> }>(
		join(UI, "gates/mockup-schools.json"),
	);
	const bundle = readJson<{
		profiles: Record<string, { params: { currency?: string } }>;
	}>(join(SNAPSHOT, "bundle.json"));
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
	const schools = [
		{ school: "b4u", scale: null },
		{ school: "har", scale: oracle.largeSchoolScale },
	] as const;
	/** The Worker's document and the oracle's, as tests/kpi-document-oracle.test.ts builds them. */
	const both = (
		school: string,
		preset: string,
		scale: { money: number; count: number } | null,
		audience: (typeof audiences)[number],
		pinLocked: boolean,
	) => {
		const rows = rowsOf(preset);
		const profile = bundle.profiles[preset];
		const found = disclosureFixture.schools[school];
		if (!profile || !found) throw new Error(`${school}/${preset}: no fixture`);
		const disclosure: KpiDisclosure = {
			size: found.size,
			file: disclosureFixture.file,
			override: found.override,
		};
		const donors = mockup.donors[school] ?? [];
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
		const scaled = scale
			? rows.map((row) => ({
					...row,
					value: row.value * (row.unit === "cents" ? scale.money : scale.count),
				}))
			: rows;
		return {
			worker: kpiDocument(scaled, {}, disclosure, audience, pinLocked, context),
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

	for (const preset of ["growth-12mo", "disputes", "heavy-refunds", "non-usd"])
		test(`${preset}: both schools, every audience, PIN open and locked`, () => {
			let checked = 0;
			for (const { school, scale } of schools)
				for (const { audience, pinLocked } of variants) {
					const where = `${school}/${preset}.${audience}${pinLocked ? ".pin-locked" : ""}`;
					const pair = both(school, preset, scale, audience, pinLocked);
					expect(problems(pair.worker), where).toBe("");
					// The model's document order is the document's: meta and series keys come in the oracle's order.
					expect(Object.keys(pair.worker.meta), where).toEqual(
						Object.keys(pair.oracle.meta),
					);
					for (const [grain, table] of Object.entries(pair.worker.tables))
						expect(
							Object.keys(table?.series ?? {}),
							`${where} ${grain}`,
						).toEqual(
							Object.keys(
								pair.oracle.tables[grain as keyof typeof pair.oracle.tables]
									?.series ?? {},
							),
						);
					checked += 1;
				}
			expect(checked).toBe(2 * variants.length);
		});

	test("a school's own events validate too", () => {
		const document = kpiDocument(
			rowsOf("growth-12mo"),
			{},
			{
				size: "small",
				file: disclosureFixture.file,
				override: {},
			},
			"owner",
			false,
			{ school: "own", currency: "usd", clock: CLOCK },
		);
		expect(problems(document)).toBe("");
	});

	test("the schema is closed: an unknown key, a wrong kind or a bad cell fails", () => {
		const { worker } = both("b4u", "growth-12mo", null, "owner", false);
		const copy = () => structuredClone(worker);
		const unknownKey = copy();
		(unknownKey as Record<string, unknown>).extra = true;
		expect(problems(unknownKey)).not.toBe("");
		const unknownSeries = copy();
		if (unknownSeries.tables.month)
			unknownSeries.tables.month.series.not_a_measure = [];
		expect(problems(unknownSeries)).not.toBe("");
		const wrongKind = copy();
		if (wrongKind.meta.gross_collected)
			wrongKind.meta.gross_collected.kind = "count";
		expect(problems(wrongKind)).not.toBe("");
		const badCell = copy();
		badCell.tables.month?.series.gross_collected?.splice(0, 1, {
			hidden: "gone",
			text: "",
		} as never);
		expect(problems(badCell)).not.toBe("");
	});
});

describe("the JSON-LD context", () => {
	const document = generated<{
		"@context": Record<string, unknown>;
		"@included": Array<Record<string, unknown>>;
	}>(`${model.id}.context.jsonld`);
	const context = document["@context"];
	const prefixes = Object.keys(model.prefixes);
	const expandTerm = (curie: string): string => {
		const prefix = curie.slice(0, curie.indexOf(":"));
		expect(prefixes, curie).toContain(prefix);
		return expand(curie);
	};

	test("JSON-LD 1.1 with the model's prefixes and no other keyword", () => {
		expect(context["@version"]).toBe(1.1);
		for (const prefix of prefixes)
			expect(context[prefix]).toBe(model.prefixes[prefix] as string);
		for (const key of Object.keys(context)) {
			expect(key.startsWith("$"), key).toBe(false);
			if (key.startsWith("@")) expect(key).toBe("@version");
		}
		for (const key of Object.keys(document))
			expect(["@context", "@id", "@included", "skos:note"], key).toContain(key);
	});

	test("every term expands to an IRI under a declared prefix", () => {
		for (const [term, definition] of Object.entries(context)) {
			if (term === "@version" || prefixes.includes(term)) continue;
			const id =
				typeof definition === "string"
					? definition
					: (definition as { "@id": string })["@id"];
			expect(typeof id, term).toBe("string");
			const iri = expandTerm(id);
			expect(
				prefixes.some((prefix) =>
					iri.startsWith(model.prefixes[prefix] as string),
				),
			).toBe(true);
			if (typeof definition === "object" && definition !== null) {
				for (const key of Object.keys(definition))
					expect(["@id", "@type", "@container"], term).toContain(key);
				const { "@type": type, "@container": container } = definition as {
					"@type"?: string;
					"@container"?: string;
				};
				if (type !== undefined) expect(["@id", "@vocab"]).toContain(type);
				if (container !== undefined) expect(container).toBe("@set");
			}
		}
	});

	test("one term per entity, measure and dimension, at the model's IRI", () => {
		const iriOf = (term: string): string => {
			const definition = context[term];
			return expandTerm(
				typeof definition === "string"
					? definition
					: (definition as { "@id": string })["@id"],
			);
		};
		for (const entity of model.entities)
			expect(iriOf(entity.id)).toBe(termIri.entity(model, entity.id));
		for (const measure of measures)
			expect(iriOf(measure.id)).toBe(termIri.measure(model, measure.id));
		for (const dimension of model.dimensions)
			expect(iriOf(dimensionTerm(dimension.id))).toBe(
				termIri.dimension(model, dimension.id),
			);
	});

	test("the included links are the model's, by IRI", () => {
		const linked = model.entities.filter((entity) => entity.links);
		expect(document["@included"].map((node) => node["@id"])).toEqual(
			linked.map((entity) => `atm:${entity.id}`),
		);
		for (const node of document["@included"]) {
			const entity = linked.find(
				(candidate) =>
					termIri.entity(model, candidate.id) ===
					expandTerm(node["@id"] as string),
			);
			expect(entity, String(node["@id"])).toBeDefined();
			for (const link of ["exactMatch", "closeMatch"] as const) {
				const values = (node[link] as string[] | undefined) ?? [];
				for (const value of values) expandTerm(value);
				expect(values).toEqual(entity?.links?.[link] ?? []);
			}
		}
	});
});
