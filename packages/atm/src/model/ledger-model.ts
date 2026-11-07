/**
 * The ledger model (`model/ledger.v1.json`, checked against `schema/model.v1.json`): the entities of a school's books,
 * how they join, the dimensions a KPI is split by and what each KPI means. A measure of `source: kpiSpec` is the KPI of
 * the same id in `kpis/school.v1.json` and restates nothing the spec says; this file resolves the two together. Not
 * Worker code (it compiles a schema with Ajv): the Worker reads only what `bun model/build.ts` generates from it.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import modelJson from "../../model/ledger.v1.json";
import modelSchema from "../../schema/model.v1.json";
import type { Kpi, KpiSpec, KpiUnit } from "../scenario/kpi-evaluate.js";
import { SCHOOL_KPIS } from "../scenario/kpis.js";

export type EntityKind = "thing" | "value" | "report";
export type FieldPath = string;
export type ModelLinks = { exactMatch?: string[]; closeMatch?: string[] };
export type ModelEntity = {
	id: string;
	kind: EntityKind;
	description: string;
	synonyms?: string[];
	key?: {
		eventTypes?: string[];
		fields: FieldPath[];
		pattern?: string;
		example?: string;
	};
	eventTypes?: string[];
	source?: string;
	links?: ModelLinks;
};
export type ModelJoin = {
	from: FieldPath[];
	to: FieldPath[];
	when?: FieldPath;
};
export type ModelRelationship = {
	id: string;
	from: string;
	to: string;
	cardinality: "many-to-one" | "one-to-one";
	description: string;
	fromEvents?: string[];
	toEvents?: string[];
	joins?: ModelJoin[];
	certifiedBy: "presets" | "presets-vacuous" | "external";
};
export type DetailNeed =
	| "total"
	| "categories"
	| "breakdown"
	| "spread"
	| "rows"
	| "names";
export type ModelDimension = {
	id: string;
	entity?: string;
	values?: string[];
	description: string;
	synonyms?: string[];
	need: DetailNeed;
};
export type MeasureFormat = "money" | "money0" | "integer" | "percent1";
export type MeasureClass =
	| "income"
	| "losses"
	| "cash"
	| "people"
	| "activity"
	| "personal";
export type ModelMeasure = {
	id: string;
	source: "kpiSpec" | "document" | "fixture";
	title?: string;
	unit?: KpiUnit;
	definition?: string;
	inputs?: string[];
	entity: string;
	dimensions: string[];
	format: MeasureFormat;
	grain: "month" | "day";
	rollup: "sum" | "max" | "last" | "recompute";
	disclosure: { class: MeasureClass; capped?: boolean; ruleOf?: string };
	document?: { title: string; need?: "categories" | "breakdown" | "spread" };
	synonyms?: string[];
};
export type LedgerModel = {
	version: 1;
	id: "ledger.v1";
	namespace: string;
	kpiSpec: "school.v1";
	prefixes: Record<string, string>;
	external?: Record<
		string,
		{ release: string; checked: string; note?: string }
	>;
	entities: ModelEntity[];
	relationships: ModelRelationship[];
	dimensions: ModelDimension[];
	measures: ModelMeasure[];
};

/** A measure with what the KPI spec says of it filled in: title, unit, definition and inputs, whatever its source. */
export type ResolvedMeasure = ModelMeasure & {
	title: string;
	unit: KpiUnit;
	definition: string;
	/** A spec KPI's ratio `[num, den]` or combine terms in order; a document measure's own `inputs`; else empty. */
	inputs: string[];
	/** The spec KPI, for `source: kpiSpec`. */
	kpi?: Kpi;
};

export class LedgerModelError extends Error {}

const formatsOfUnit: Record<KpiUnit, MeasureFormat[]> = {
	cents: ["money", "money0"],
	count: ["integer"],
	ratio: ["percent1"],
};

const inputsOfKpi = (kpi: Kpi): string[] =>
	kpi.compute.op === "ratio"
		? [kpi.compute.num, kpi.compute.den]
		: kpi.compute.op === "combine"
			? kpi.compute.terms.map((term) => term.kpi)
			: [];

let validator: ReturnType<Ajv2020["compile"]> | null = null;

/**
 * The model checked against its schema and resolved against the KPI spec. Throws `LedgerModelError` with every problem:
 * an id used twice, a term that names nothing (entity, dimension, measure, CURIE prefix), a spec KPI with no measure or a
 * measure with no spec KPI, a dimension the spec's `by` does not have, a format the unit cannot take, a `ruleOf` in
 * another class, a `capped` measure that is not derived.
 */
export const parseLedgerModel = (
	raw: unknown,
	spec: KpiSpec = SCHOOL_KPIS,
): { model: LedgerModel; measures: ResolvedMeasure[] } => {
	if (!validator)
		validator = new Ajv2020({ allErrors: true, strict: false }).compile(
			modelSchema,
		);
	if (!validator(raw))
		throw new LedgerModelError(
			`model does not match schema/model.v1.json: ${(validator.errors ?? [])
				.map((error) => `${error.instancePath || "/"} ${error.message}`)
				.join("; ")}`,
		);
	const model = raw as LedgerModel;
	const problems: string[] = [];
	const unique = (kind: string, ids: string[]) => {
		const seen = new Set<string>();
		for (const id of ids) {
			if (seen.has(id)) problems.push(`duplicate ${kind} ${id}`);
			seen.add(id);
		}
		return seen;
	};
	const entities = unique(
		"entity",
		model.entities.map((entity) => entity.id),
	);
	const dimensions = unique(
		"dimension",
		model.dimensions.map((dimension) => dimension.id),
	);
	const measureIds = unique(
		"measure",
		model.measures.map((measure) => measure.id),
	);
	unique(
		"relationship",
		model.relationships.map((relationship) => relationship.id),
	);
	if (model.prefixes.atm !== model.namespace)
		problems.push("prefix atm is not the namespace");

	const curie = (where: string, value: string) => {
		const prefix = value.split(":")[0] as string;
		if (!Object.hasOwn(model.prefixes, prefix))
			problems.push(`${where}: ${value} has no prefix ${prefix}`);
	};
	for (const entity of model.entities)
		for (const value of [
			...(entity.links?.exactMatch ?? []),
			...(entity.links?.closeMatch ?? []),
		])
			curie(`entity ${entity.id}`, value);
	for (const dimension of model.dimensions)
		if (dimension.entity && !entities.has(dimension.entity))
			problems.push(
				`dimension ${dimension.id}: entity ${dimension.entity} is not in the model`,
			);
	for (const relationship of model.relationships)
		for (const end of [relationship.from, relationship.to])
			if (!entities.has(end))
				problems.push(
					`relationship ${relationship.id}: entity ${end} is not in the model`,
				);
	for (const relationship of model.relationships)
		for (const join of relationship.joins ?? [])
			if (join.from.length !== join.to.length)
				problems.push(
					`relationship ${relationship.id}: a join pairs ${join.from.length} fields with ${join.to.length}`,
				);

	const kpiById = new Map(spec.kpis.map((kpi) => [kpi.id, kpi]));
	const byId = new Map(model.measures.map((measure) => [measure.id, measure]));
	for (const kpi of spec.kpis) {
		const measure = byId.get(kpi.id);
		if (!measure || measure.source !== "kpiSpec")
			problems.push(`KPI ${kpi.id} of ${model.kpiSpec} has no kpiSpec measure`);
	}
	const measures: ResolvedMeasure[] = [];
	for (const measure of model.measures) {
		const where = `measure ${measure.id}`;
		if (!entities.has(measure.entity))
			problems.push(`${where}: entity ${measure.entity} is not in the model`);
		for (const dimension of measure.dimensions)
			if (!dimensions.has(dimension))
				problems.push(`${where}: dimension ${dimension} is not in the model`);
		const kpi = kpiById.get(measure.id);
		if (measure.source === "kpiSpec" && !kpi)
			problems.push(`${where}: no KPI ${measure.id} in ${model.kpiSpec}`);
		if (measure.source !== "kpiSpec" && kpi)
			problems.push(
				`${where}: is a KPI of ${model.kpiSpec}, so its source is kpiSpec`,
			);
		if (kpi) {
			const split = "by" in kpi.compute && kpi.compute.by !== undefined;
			if (split !== measure.dimensions.length > 0)
				problems.push(
					`${where}: ${split ? "the spec splits it, the model names no dimension" : "the model names a dimension the spec does not split by"}`,
				);
		}
		const unit = kpi?.unit ?? measure.unit;
		const inputs = kpi ? inputsOfKpi(kpi) : (measure.inputs ?? []);
		for (const input of inputs)
			if (!measureIds.has(input))
				problems.push(`${where}: input ${input} is not a measure`);
		if (unit && !formatsOfUnit[unit].includes(measure.format))
			problems.push(`${where}: format ${measure.format} for unit ${unit}`);
		const { ruleOf, capped } = measure.disclosure;
		if (ruleOf) {
			const target = byId.get(ruleOf);
			if (!target) problems.push(`${where}: ruleOf ${ruleOf} is not a measure`);
			else if (target.disclosure.class !== measure.disclosure.class)
				problems.push(
					`${where}: class ${measure.disclosure.class}, but ruleOf ${ruleOf} is ${target.disclosure.class}`,
				);
		}
		if (capped && inputs.length === 0)
			problems.push(`${where}: capped, but it has no inputs`);
		measures.push({
			...measure,
			title: kpi?.title ?? measure.title ?? measure.id,
			unit: unit ?? "count",
			definition: kpi?.definition ?? measure.definition ?? "",
			inputs,
			...(kpi ? { kpi } : {}),
		});
	}
	if (problems.length > 0) throw new LedgerModelError(problems.join("; "));
	return { model, measures };
};

/** The committed model, resolved against the committed KPI spec. */
export const LEDGER_MODEL = parseLedgerModel(modelJson);

/** The IRI of a model term: an entity `<namespace><Id>`, a measure `<namespace>measure/<id>`, a dimension
 * `<namespace>dimension/<id>`. */
export const termIri = {
	entity: (model: LedgerModel, id: string): string => `${model.namespace}${id}`,
	measure: (model: LedgerModel, id: string): string =>
		`${model.namespace}measure/${id}`,
	dimension: (model: LedgerModel, id: string): string =>
		`${model.namespace}dimension/${id}`,
};
