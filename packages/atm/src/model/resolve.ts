/**
 * The ledger model's types, its resolution against the KPI spec, and the two projections the Worker reads: the KPI
 * document's catalog and the derived KPIs (`src/ledger/kpi-catalog.ts`). Worker-safe: no Ajv, no file read, no
 * `new Function`. It checks the model's references, not its shape: `parseLedgerModel` (`ledger-model.ts`) checks the
 * shape against `schema/model.v1.json` with Ajv first, and `tests/model-generated.test.ts` holds the Worker's
 * unvalidated resolution of the committed JSON to the validated one.
 */
import type {
	DerivedKpi,
	KpiCatalogEntry,
	KpiCatalogKind,
} from "../ledger/kpi-catalog.js";
import type { Kpi, KpiSpec, KpiUnit } from "../scenario/kpi-evaluate.js";

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
	document?: {
		title: string;
		need?: "categories" | "breakdown" | "spread";
		/** The document's order of its measures (the mockup's KPI table); unique. */
		position?: number;
	};
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
export type ResolvedModel = { model: LedgerModel; measures: ResolvedMeasure[] };

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

/**
 * The model resolved against the KPI spec, its shape taken as given. Throws `LedgerModelError` with every problem: an id
 * used twice, a namespace that not exactly one prefix maps to, a term that names nothing (entity, dimension, measure,
 * CURIE prefix), a spec KPI with no measure or a measure with no spec KPI, a dimension the spec's `by` does not have, a
 * format the unit cannot take, a `ruleOf` in another class, a `capped` measure that is not derived.
 */
export const resolveLedgerModel = (
	model: LedgerModel,
	spec: KpiSpec,
): ResolvedModel => {
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
	unique(
		"document position",
		model.measures.flatMap((measure) =>
			measure.document?.position === undefined
				? []
				: [String(measure.document.position)],
		),
	);
	const namespacePrefixes = prefixesOfNamespace(model);
	if (namespacePrefixes.length !== 1)
		problems.push(
			`namespace ${model.namespace}: ${namespacePrefixes.length} prefixes map to it (${namespacePrefixes.join(", ") || "none"}), not exactly one`,
		);

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

/** The prefixes whose IRI is the model's namespace; a valid model has exactly one. */
const prefixesOfNamespace = (model: LedgerModel): string[] =>
	Object.keys(model.prefixes).filter(
		(prefix) => model.prefixes[prefix] === model.namespace,
	);

/** The CURIE prefix of the model's own terms: the one prefix that maps to the namespace, whatever its name. */
export const namespacePrefix = (model: LedgerModel): string => {
	const [prefix, ...others] = prefixesOfNamespace(model);
	if (prefix === undefined || others.length > 0)
		throw new LedgerModelError(
			`namespace ${model.namespace}: not exactly one prefix maps to it`,
		);
	return prefix;
};

/** The IRI of a model term: an entity `<namespace><Id>`, a measure `<namespace>measure/<id>`, a dimension
 * `<namespace>dimension/<id>`. */
export const termIri = {
	entity: (model: LedgerModel, id: string): string => `${model.namespace}${id}`,
	measure: (model: LedgerModel, id: string): string =>
		`${model.namespace}measure/${id}`,
	dimension: (model: LedgerModel, id: string): string =>
		`${model.namespace}dimension/${id}`,
};

/** How a unit's figures add up and are written in the KPI document. */
export const kindOfUnit: Record<KpiUnit, KpiCatalogKind> = {
	cents: "money",
	count: "count",
	ratio: "rate",
};

/** The measures the KPI document carries, in its order: by `document.position`, then the rest in model order. */
export const documentMeasures = (
	measures: readonly ResolvedMeasure[],
): ResolvedMeasure[] =>
	measures
		.map((measure, index) => ({ measure, index }))
		.filter(({ measure }) => measure.document)
		.sort(
			(first, second) =>
				(first.measure.document?.position ?? Number.POSITIVE_INFINITY) -
					(second.measure.document?.position ?? Number.POSITIVE_INFINITY) ||
				first.index - second.index,
		)
		.map(({ measure }) => measure);

/** The dimension a measure is split by, if any. */
export const dimensionOf = (
	model: LedgerModel,
	measure: ResolvedMeasure,
): ModelDimension | undefined =>
	model.dimensions.find((dimension) => dimension.id === measure.dimensions[0]);
/** `id`, or `id:*` for a measure split by a dimension (the document expands it per value). */
export const catalogKey = (measure: ResolvedMeasure): string =>
	measure.dimensions.length > 0 ? `${measure.id}:*` : measure.id;
const isDerived = (measure: ResolvedMeasure): boolean =>
	measure.kpi?.compute.op === "ratio" || measure.kpi?.compute.op === "combine";

/** The KPI document's catalog: one entry per document measure, in the document's order, keyed by `catalogKey`. */
export const kpiCatalogOf = ({
	model,
	measures,
}: ResolvedModel): Record<string, KpiCatalogEntry> => {
	const catalog: Record<string, KpiCatalogEntry> = {};
	for (const measure of documentMeasures(measures)) {
		const dimensionNeed = dimensionOf(model, measure)?.need;
		const need =
			measure.document?.need ??
			(dimensionNeed && dimensionNeed !== "total" ? dimensionNeed : undefined);
		catalog[catalogKey(measure)] = {
			title: measure.document?.title ?? measure.title,
			kind: kindOfUnit[measure.unit],
			ruleOf: measure.disclosure.ruleOf ?? measure.id,
			...(need ? { need } : {}),
			...(measure.inputs.length > 0 ? { inputs: [...measure.inputs] } : {}),
			format: measure.format,
		};
	}
	return catalog;
};
/** The spec's ratio and combine KPIs, by id, in model order. */
export const derivedKpisOf = ({
	measures,
}: ResolvedModel): Record<string, DerivedKpi> =>
	Object.fromEntries(
		measures.filter(isDerived).map((measure) => [
			measure.id,
			{
				inputs: [...measure.inputs],
				capped: measure.disclosure.capped ?? false,
			},
		]),
	);
