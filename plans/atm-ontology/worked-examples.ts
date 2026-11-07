/**
 * The worked examples of `custom-metrics.md`, recomputed from atm's own code. Run from the repository root:
 *
 *     bun plans/atm-ontology/worked-examples.ts
 *
 * Nothing here ships. The definitions, the validator and the custom-metric cells are the design's (a prototype in this
 * file); every input figure is atm's: the mart snapshot rows (`plans/ledger-ui/design/mart/kpis/<preset>.json.gz`,
 * re-derived here from `buildFixture` with the atm fold and checked against the snapshot's hashes), the ledger model
 * (`LEDGER_MODEL`), the disclosure rules (`kpiRule`) and the real KPI document (`kpiDocument` of `atm/worker`, with the
 * UI's disclosure fixture and the clock the oracle test uses). Figures of the proposed `paying_members_by_tier` measure
 * are counted from the preset events here and labelled as the proposed measure's: atm computes no such figure today.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { canonicalize, sha256Hex } from "../../packages/atm/src/ledger/util.js";
import { LEDGER_MODEL } from "../../packages/atm/src/model/ledger-model.js";
import type { ModelDimension } from "../../packages/atm/src/model/resolve.js";
import { atmChannel } from "../../packages/atm/src/scenario/channels/atm.js";
import { buildFixture } from "../../packages/atm/src/scenario/fixture.js";
import {
	evaluateKpis,
	type KpiRow,
	type KpiSpec,
	kpiHash,
	SCHOOL_KPIS,
} from "../../packages/atm/src/scenario/kpis.js";
import { PROFILE_NAMES } from "../../packages/atm/src/scenario/profiles.js";
import type { AtmEvent } from "../../packages/atm/src/types.js";
import {
	type Audience,
	applyOverride,
	audiences,
	type Cell,
	type DetailStep,
	type DisclosureFile,
	type DisclosureGrain,
	detailSteps,
	disclosureGrains,
	type KpiDisclosure,
	type KpiDocument,
	type KpiGift,
	kpiDocument,
	kpiRule,
	type ResolvedRule,
} from "../../packages/atm/src/worker.js";

const REPOSITORY = resolve(import.meta.dir, "../..");
const SNAPSHOT = join(REPOSITORY, "plans/ledger-ui/design/mart");
const CLOCK = { today: "2026-11-05", now: "2026-11-05T12:00" };
const SCHOOL = "b4u";
const MIN_CONTRIBUTORS = 5;
const MAX_SHARE = 0.6;
const RATIO_PRECISION = 4;
const MEMBERSHIP_ACCOUNT = /^income:billing:membership:([^:]+)$/;
const PLAN_ORDER = ["scholar", "fellow", "seminar", "audit"];

// ---- Output

const out = (text = ""): void => {
	process.stdout.write(`${text}\n`);
};
const heading = (text: string): void => {
	out();
	out(`## ${text}`);
};
const show = (value: unknown): string => JSON.stringify(value);
/** A series of cells, a run of equal cells written once with its length: `[26700, 23700 x5]`. */
const series = (cells: readonly unknown[]): string => {
	const runs: Array<{ text: string; count: number }> = [];
	for (const cell of cells) {
		const text = show(cell);
		const last = runs.at(-1);
		if (last && last.text === text) last.count += 1;
		else runs.push({ text, count: 1 });
	}
	return `[${runs.map((run) => (run.count > 1 ? `${run.text} x${run.count}` : run.text)).join(", ")}]`;
};

// ---- atm's inputs

const readJson = <T>(path: string): T =>
	JSON.parse(readFileSync(path, "utf8")) as T;
type SnapshotKpis = {
	fixtureHash: string;
	kpisHash: string;
	rows: KpiRow[];
};
const snapshotOf = (preset: string): SnapshotKpis =>
	JSON.parse(
		gunzipSync(
			readFileSync(join(SNAPSHOT, "kpis", `${preset}.json.gz`)),
		).toString("utf8"),
	) as SnapshotKpis;
const disclosureFixture = readJson<{
	file: DisclosureFile;
	schools: Record<string, Omit<KpiDisclosure, "file">>;
}>(join(REPOSITORY, "packages/ledger-ui/src/fixtures/disclosure.json"));
const mockupDonors = readJson<{ donors: Record<string, KpiGift[]> }>(
	join(REPOSITORY, "packages/ledger-ui/gates/mockup-schools.json"),
).donors;
const bundle = readJson<{
	profiles: Record<string, { tiers: Record<string, number[]> }>;
}>(join(SNAPSHOT, "bundle.json"));
const schoolDisclosure = disclosureFixture.schools[SCHOOL];
if (!schoolDisclosure) throw new Error(`${SCHOOL} is not in disclosure.json`);
const disclosure: KpiDisclosure = {
	size: schoolDisclosure.size,
	override: schoolDisclosure.override,
	file: disclosureFixture.file,
};
const file = applyOverride(disclosure.file, disclosure.override);

/** A preset's events (`buildFixture`) and KPI rows (the atm fold), checked against the mart snapshot the KPI
 * document's tests read: the fixture hash and the KPI hash must both be the snapshot's. */
type Preset = { name: string; events: AtmEvent[]; rows: KpiRow[] };
const presetOf = (name: string): Preset => {
	const fixture = buildFixture({ profile: name });
	const base = atmChannel.base({
		events: fixture.events,
		spec: SCHOOL_KPIS,
		periods: fixture.periods,
	});
	const rows = evaluateKpis({
		spec: SCHOOL_KPIS,
		base,
		periods: fixture.periods,
	});
	const snapshot = snapshotOf(name);
	if (fixture.hash !== snapshot.fixtureHash)
		throw new Error(`${name}: fixture hash is not the snapshot's`);
	if (kpiHash(rows) !== snapshot.kpisHash)
		throw new Error(`${name}: KPI hash is not the snapshot's`);
	return { name, events: fixture.events, rows };
};

const documentOf = (
	preset: Preset,
	audience: Audience,
	donors: readonly KpiGift[] = [],
): KpiDocument => {
	const tiers = Object.keys(bundle.profiles[preset.name]?.tiers ?? {});
	return kpiDocument(preset.rows, {}, disclosure, audience, false, {
		school: SCHOOL,
		currency: "usd",
		clock: CLOCK,
		preset: preset.name,
		plans: PLAN_ORDER.filter((plan) => tiers.includes(plan)),
		donors,
	});
};
const rowValue = (
	preset: Preset,
	kpiId: string,
	period: string,
): number | null =>
	preset.rows.find((row) => row.kpiId === kpiId && row.period === period)
		?.value ?? null;
const monthsOf = (preset: Preset): string[] =>
	[...new Set(preset.rows.map((row) => row.period))].sort();
const isFigure = (cell: Cell | undefined): cell is number =>
	typeof cell === "number";
const cellAt = (
	document: KpiDocument,
	grain: "month" | "quarter" | "year",
	id: string,
	period: string,
): Cell | undefined => {
	const table = document.tables[grain];
	const index = table?.periods.indexOf(period) ?? -1;
	return index < 0 ? undefined : table?.series[id]?.[index];
};
/** A cell hidden before any figure is read (the audience's rule, grain, detail or delay). */
const isGated = (cell: Cell | undefined): boolean =>
	typeof cell === "object" &&
	"hidden" in cell &&
	cell.hidden !== "suppressed" &&
	cell.hidden !== "not_computed";

/** atm's ratio rounding (`roundedRatio` of the KPI spec: half up, in integers, four places), reached through
 * `evaluateKpis` with a two-input spec, so the custom cells round as the catalog's rates do. */
const atmRatio = (numerator: number, denominator: number): number => {
	const spec: KpiSpec = {
		version: 1,
		grain: "month",
		kpis: [
			{
				id: "numerator",
				title: "numerator",
				unit: "cents",
				precision: 0,
				definition: "the window's numerator",
				compute: { op: "count", where: {} },
			},
			{
				id: "denominator",
				title: "denominator",
				unit: "cents",
				precision: 0,
				definition: "the window's denominator",
				compute: { op: "count", where: {} },
			},
			{
				id: "rate",
				title: "rate",
				unit: "ratio",
				precision: RATIO_PRECISION,
				definition: "numerator / denominator",
				compute: { op: "ratio", num: "numerator", den: "denominator" },
			},
		],
	};
	const rows = evaluateKpis({
		spec,
		base: { numerator: { p: numerator }, denominator: { p: denominator } },
		periods: ["p"],
	});
	return rows.find((row) => row.kpiId === "rate")?.value ?? 0;
};
/** The document's per-member money rounding (`arpa`: cents to two decimals). */
const perMember = (cents: number, members: number): number =>
	Math.round((cents / members) * 100) / 100;

// ---- The definition format and its validator (the design's prototype)

type Filter = string | { in: string[] };
type Term = { measure: string; where?: Record<string, Filter> };
type SignedTerm = { sign: 1 | -1; of: Term };
type SumExpression = { op: "sum"; terms: SignedTerm[] };
type Side = Term | SumExpression;
type Compute =
	| { op: "value"; of: Term }
	| SumExpression
	| { op: "ratio"; numerator: Side; denominator: Side };
type MetricDefinition = {
	id: string;
	version: number;
	title: string;
	description: string;
	model: string;
	kpiSpec: string;
	unit: "cents" | "count" | "ratio";
	format: "money" | "money0" | "integer" | "percent1";
	compute: Compute;
	groupBy?: string;
	window?: { trailing: number } | { toDate: "year" };
	compare?: {
		with: "previousPeriod" | "samePeriodLastYear";
		as: "difference" | "ratio";
	};
};

type MeasureFacts = {
	id: string;
	unit: "cents" | "count" | "ratio";
	rollup: "sum" | "max" | "last" | "recompute";
	kpiClass: string;
	/** The KPI whose disclosure rule it follows. */
	ruleOf: string;
	dimensions: string[];
	need?: DetailStep;
	source: string;
	/** A derived measure's inputs (a ratio's or a combine's terms). */
	inputs: string[];
	/** The proposed model field: the cell this measure's split adds up to. */
	partitionOf?: string;
	synonyms: string[];
};
type ModelView = {
	id: string;
	kpiSpec: string;
	measures: Map<string, MeasureFacts>;
	dimensions: Map<string, ModelDimension>;
	/** Not a measure, and why: the document's `notComputed`. */
	notComputed: Map<string, string>;
};

/** Proposed for model v1.1: which split adds up to which cell (checked on the presets below). */
const proposedPartitions: Record<string, string> = {
	revenue_by_kind: "gross_collected",
	revenue_by_tier: "revenue_by_kind:membership",
};

const modelV1 = (): ModelView => {
	const measures = new Map<string, MeasureFacts>();
	for (const measure of LEDGER_MODEL.measures)
		measures.set(measure.id, {
			id: measure.id,
			unit: measure.unit,
			rollup: measure.rollup,
			kpiClass: measure.disclosure.class,
			ruleOf: measure.disclosure.ruleOf ?? measure.id,
			dimensions: measure.dimensions,
			need: measure.document?.need,
			source: measure.source,
			inputs: measure.inputs,
			partitionOf: proposedPartitions[measure.id],
			synonyms: measure.synonyms ?? [],
		});
	return {
		id: LEDGER_MODEL.model.id,
		kpiSpec: LEDGER_MODEL.model.kpiSpec,
		measures,
		dimensions: new Map(
			LEDGER_MODEL.model.dimensions.map((dimension) => [
				dimension.id,
				dimension,
			]),
		),
		notComputed: new Map([
			[
				"mrr",
				"MRR is not computed: cash basis, a yearly payer counts in the month paid",
			],
			["churned_members", "Churn is not computed: cash basis"],
		]),
	};
};
/** Model v1.1 as proposed: one new base measure, distinct holders per membership income account. */
const modelV1Point1 = (): ModelView => {
	const view = modelV1();
	view.id = "ledger.v1.1";
	view.kpiSpec = "school.v1.1";
	view.measures.set("paying_members_by_tier", {
		id: "paying_members_by_tier",
		unit: "count",
		rollup: "max",
		kpiClass: "people",
		ruleOf: "paying_members",
		dimensions: ["tier"],
		source: "kpiSpec",
		inputs: [],
		partitionOf: "paying_members",
		synonyms: ["payers by plan", "members by tier", "active members by tier"],
	});
	return view;
};

type Problem = {
	code: string;
	term?: string;
	message: string;
	suggestion?: string;
};
type Answer =
	| {
			audience: Audience;
			shown: true;
			live: boolean;
			every: DisclosureGrain;
			detail: DetailStep;
			after: string | null;
			cellRules: "on" | "breakdown and spread" | "off";
			evaluatedAt: string;
	  }
	| { audience: Audience; shown: false; why: string };
type Verdict = {
	id: string;
	accepted: boolean;
	problems: Problem[];
	unit?: string;
	need?: DetailStep;
	answerable?: Answer[];
	hash: string;
};

const termsOfSide = (side: Side): SignedTerm[] =>
	"op" in side ? side.terms : [{ sign: 1, of: side }];
const termsOf = (compute: Compute): SignedTerm[] =>
	compute.op === "value"
		? [{ sign: 1, of: compute.of }]
		: compute.op === "sum"
			? compute.terms
			: [
					...termsOfSide(compute.numerator),
					...termsOfSide(compute.denominator),
				];
const normalized = (text: string): string =>
	text.toLowerCase().replace(/[\s_-]+/g, " ");
const detailRank = (detail: DetailStep): number => detailSteps.indexOf(detail);
const grainRank = (grain: DisclosureGrain): number =>
	disclosureGrains.indexOf(grain);
const grainMonths: Record<DisclosureGrain, number> = {
	day: 1,
	month: 1,
	quarter: 3,
	year: 12,
};
const delayDays = (delay: string | null): number => {
	if (!delay) return 0;
	const [count = "0", unit = ""] = delay.split(" ");
	return Number(count) * (unit.startsWith("week") ? 7 : 30.44);
};

/** The partition chain of a term: the cells it adds up into, nearest first (`revenue_by_tier:fellow` is inside
 * `revenue_by_kind:membership`, which is inside `gross_collected`). */
const familyOf = (view: ModelView, measureId: string): string[] => {
	const chain: string[] = [measureId];
	let current = view.measures.get(measureId)?.partitionOf;
	while (current) {
		chain.push(current);
		current = view.measures.get(current.split(":")[0] as string)?.partitionOf;
	}
	return chain;
};
const rootOf = (view: ModelView, measureId: string): string =>
	(familyOf(view, measureId).at(-1) as string).split(":")[0] as string;

const suggest = (view: ModelView, term: string): string | undefined => {
	const wanted = normalized(term);
	for (const measure of view.measures.values())
		if (measure.synonyms.some((synonym) => normalized(synonym) === wanted))
			return measure.id;
	for (const dimension of view.dimensions.values())
		if ((dimension.synonyms ?? []).some((s) => normalized(s) === wanted))
			return dimension.id;
	return undefined;
};

const unitOfSide = (
	view: ModelView,
	side: Side,
	problems: Problem[],
): string | undefined => {
	const units = new Set(
		termsOfSide(side).map(
			(term) => view.measures.get(term.of.measure)?.unit ?? "unknown",
		),
	);
	if (units.has("unknown")) return undefined;
	if (units.size > 1) {
		problems.push({
			code: "unit_mismatch",
			message: `a sum adds ${[...units].join(" and ")}`,
		});
		return undefined;
	}
	const unit = [...units][0] as string;
	if (unit === "ratio" && termsOfSide(side).length > 1) {
		problems.push({
			code: "unit_mismatch",
			message: "rates are not added: recompute the rate from its inputs",
		});
		return undefined;
	}
	return unit;
};

/** The rule of a metric for an audience: each input's `kpiRule`, capped as `kpiRule` caps a derived KPI (the
 * finest detail any input allows, the coarsest grain, the longest delay); null when an input has none. */
const cappedRule = (
	view: ModelView,
	measureIds: string[],
	audience: Audience,
): ResolvedRule | null => {
	let capped: ResolvedRule | null = null;
	for (const id of measureIds) {
		const measure = view.measures.get(id);
		if (!measure) return null;
		const rule = kpiRule(file, audience, measure.ruleOf);
		if (!rule) return null;
		if (!capped) {
			capped = { ...rule };
			continue;
		}
		if (detailRank(rule.detail) < detailRank(capped.detail))
			capped.detail = rule.detail;
		if (grainRank(rule.every) < grainRank(capped.every))
			capped.every = rule.every;
		if (delayDays(rule.after) > delayDays(capped.after))
			capped.after = rule.after;
		capped.live = capped.live && rule.live;
	}
	return capped;
};

export const validate = (
	definition: MetricDefinition,
	view: ModelView,
): Verdict => {
	const problems: Problem[] = [];
	const hash = sha256Hex(canonicalize(definition));
	if (definition.model !== view.id)
		problems.push({
			code: "stale",
			message: `pinned to model ${definition.model}, the catalog is on ${view.id}`,
		});
	const terms = termsOf(definition.compute);
	for (const { of: term } of terms) {
		const measure = view.measures.get(term.measure);
		if (!measure) {
			const why = view.notComputed.get(term.measure);
			const near = suggest(view, term.measure);
			problems.push({
				code: "unknown_term",
				term: term.measure,
				message: why
					? `${term.measure} is not a measure of ${view.id}: ${why}`
					: `${term.measure} is not a measure of ${view.id}`,
				...(near ? { suggestion: near } : {}),
			});
			continue;
		}
		if (measure.kpiClass === "personal")
			problems.push({
				code: "personal",
				term: term.measure,
				message: `${term.measure} is in the personal class: no custom metric reads it`,
			});
		for (const [dimensionId, filter] of Object.entries(term.where ?? {})) {
			const dimension = view.dimensions.get(dimensionId);
			if (!dimension) {
				const near = suggest(view, dimensionId);
				problems.push({
					code: "unknown_term",
					term: dimensionId,
					message: `${dimensionId} is not a dimension of ${view.id}`,
					...(near ? { suggestion: near } : {}),
				});
				continue;
			}
			if (!measure.dimensions.includes(dimensionId))
				problems.push({
					code: "dimension_not_carried",
					term: `${term.measure} by ${dimensionId}`,
					message: `${term.measure} has no ${dimensionId} dimension (it has ${measure.dimensions.length ? measure.dimensions.join(", ") : "none"})`,
				});
			const values = typeof filter === "string" ? [filter] : filter.in;
			for (const value of values)
				if (dimension.values && !dimension.values.includes(value))
					problems.push({
						code: "unknown_term",
						term: `${dimensionId}=${value}`,
						message: `${value} is not a value of ${dimensionId} (${dimension.values.join(", ")})`,
					});
		}
	}
	const groupBy = definition.groupBy
		? view.dimensions.get(definition.groupBy)
		: undefined;
	if (definition.groupBy && !groupBy)
		problems.push({
			code: "unknown_term",
			term: definition.groupBy,
			message: `${definition.groupBy} is not a dimension of ${view.id}`,
		});
	if (groupBy) {
		if (groupBy.need === "rows" || groupBy.need === "names")
			problems.push({
				code: "identity_dimension",
				term: groupBy.id,
				message: `${groupBy.id} splits to ${groupBy.need}: a custom metric is never split to rows or names`,
			});
		for (const { of: term } of terms) {
			const measure = view.measures.get(term.measure);
			if (measure && !measure.dimensions.includes(groupBy.id))
				problems.push({
					code: "dimension_not_carried",
					term: `${term.measure} by ${groupBy.id}`,
					message: `${term.measure} has no ${groupBy.id} dimension (it has ${measure.dimensions.length ? measure.dimensions.join(", ") : "none"})`,
				});
		}
	}
	const known = terms.every(({ of: term }) => view.measures.has(term.measure));

	// Units
	let unit: string | undefined;
	if (known) {
		const compute = definition.compute;
		if (compute.op === "value")
			unit = view.measures.get(compute.of.measure)?.unit;
		else if (compute.op === "sum") unit = unitOfSide(view, compute, problems);
		else {
			const top = unitOfSide(view, compute.numerator, problems);
			const bottom = unitOfSide(view, compute.denominator, problems);
			if (top && bottom) {
				if (top === "ratio" || bottom === "ratio")
					problems.push({
						code: "unit_mismatch",
						message: "a ratio of rates: recompute from the rates' inputs",
					});
				else if (top === bottom) unit = "ratio";
				else if (top === "cents" && bottom === "count") unit = "cents";
				else
					problems.push({
						code: "unit_mismatch",
						message: `${top} / ${bottom} has no unit the document writes`,
					});
			}
		}
		if (unit && unit !== definition.unit)
			problems.push({
				code: "unit_mismatch",
				message: `declared ${definition.unit}, the terms give ${unit}`,
			});
	}

	// Rollups
	if (known) {
		for (const { of: term } of terms) {
			const measure = view.measures.get(term.measure) as MeasureFacts;
			const alone = definition.compute.op === "value" && !definition.window;
			if (measure.rollup === "recompute" && !alone)
				problems.push({
					code: "rollup",
					term: term.measure,
					message: `${term.measure} is recomputed per period, never added or windowed: use its inputs (${measure.inputs.join(", ")})`,
				});
			if (measure.rollup === "last" && definition.window)
				problems.push({
					code: "rollup",
					term: term.measure,
					message: `${term.measure} is a closing balance: it is not summed over a window`,
				});
		}
		const sums =
			definition.compute.op === "sum"
				? [definition.compute]
				: definition.compute.op === "ratio"
					? [
							definition.compute.numerator,
							definition.compute.denominator,
						].filter((side): side is SumExpression => "op" in side)
					: [];
		for (const sum of sums) {
			const rollups = new Set(
				sum.terms.map(
					({ of: term }) => view.measures.get(term.measure)?.rollup,
				),
			);
			if (rollups.size > 1 || rollups.has("max"))
				problems.push({
					code: "rollup",
					message: `a sum of ${[...rollups].join(" and ")} measures: only flows (sum) or balances (last) are added`,
				});
			// Complementary leak: two terms of one partition family with opposite signs
			for (const first of sum.terms)
				for (const second of sum.terms) {
					if (first.sign !== 1 || second.sign !== -1) continue;
					const firstRoot = rootOf(view, first.of.measure);
					if (firstRoot !== rootOf(view, second.of.measure)) continue;
					const cell = `${second.of.measure}${
						second.of.where
							? `:${Object.values(second.of.where)
									.flatMap((filter) =>
										typeof filter === "string" ? [filter] : filter.in,
									)
									.join("+")}`
							: ""
					}`;
					problems.push({
						code: "complementary_difference",
						term: cell,
						message: `subtracts ${cell} from ${first.of.measure}${first.of.where ? ` (${show(first.of.where)})` : ""}, cells of one total (${familyOf(view, second.of.measure).join(" < ")}): the difference is the rest of the split, a cell the document may hide`,
					});
				}
		}
	}

	// Detail the metric needs: the split's, or a filtered dimension's (one plan's figure is a breakdown cell)
	const needs: DetailStep[] = ["total"];
	if (groupBy) needs.push(groupBy.need as DetailStep);
	for (const { of: term } of terms) {
		const measure = view.measures.get(term.measure);
		if (measure?.need) needs.push(measure.need);
		for (const dimensionId of Object.keys(term.where ?? {})) {
			const dimension = view.dimensions.get(dimensionId);
			if (dimension) needs.push(dimension.need as DetailStep);
		}
	}
	const need = needs.reduce((finest, step) =>
		detailRank(step) > detailRank(finest) ? step : finest,
	);

	const accepted = problems.length === 0;
	if (!accepted)
		return {
			id: `${definition.id}@${definition.version}`,
			accepted,
			problems,
			hash,
		};

	const measureIds = [...new Set(terms.map(({ of: term }) => term.measure))];
	const answerable: Answer[] = audiences.map((audience) => {
		const rule = cappedRule(view, measureIds, audience);
		if (!rule) return { audience, shown: false, why: "no rule for an input" };
		if (rule.live)
			return {
				audience,
				shown: true,
				live: true,
				every: "day",
				detail: "names",
				after: null,
				cellRules: "off",
				evaluatedAt: "every month, the open month included",
			};
		if (detailRank(need) > detailRank(rule.detail))
			return {
				audience,
				shown: false,
				why: `needs ${need}, the audience's detail is ${rule.detail}`,
			};
		const window = definition.window;
		if (
			window &&
			"trailing" in window &&
			window.trailing % grainMonths[rule.every] !== 0
		)
			return {
				audience,
				shown: false,
				why: `a ${window.trailing}-month window steps finer than this audience's ${rule.every}`,
			};
		const ruled =
			audiences.indexOf(audience) < audiences.indexOf("governance") ||
			detailRank(need) >= detailRank("breakdown");
		return {
			audience,
			shown: true,
			live: false,
			every: rule.every,
			detail: rule.detail,
			after: rule.after,
			cellRules:
				audiences.indexOf(audience) < audiences.indexOf("governance")
					? "on"
					: ruled
						? "on"
						: "breakdown and spread",
			evaluatedAt: `${rule.every} ends${rule.after ? `, published ${rule.after} after the period closes` : ", at close"}`,
		};
	});
	return {
		id: `${definition.id}@${definition.version}`,
		accepted,
		problems,
		...(unit ? { unit } : {}),
		need,
		answerable,
		hash,
	};
};

/** The first audience that sees a metric, written as the document writes it (`whoSees`). */
const whoSeesText = (verdict: Verdict): string => {
	const first = verdict.answerable?.find((answer) => answer.shown)?.audience;
	return first === "member" || first === "public"
		? "Members see this"
		: first === "governance"
			? "Governance and up see this"
			: "Finance admins and the owner see this";
};

const printVerdict = (verdict: Verdict): void => {
	out(`validate ${verdict.id}: ${verdict.accepted ? "accepted" : "refused"}`);
	for (const problem of verdict.problems)
		out(
			`  ${problem.code}${problem.term ? ` [${problem.term}]` : ""}: ${problem.message}${problem.suggestion ? ` (did you mean ${problem.suggestion}?)` : ""}`,
		);
	if (verdict.accepted) {
		out(`  unit ${verdict.unit}, needs ${verdict.need}`);
		for (const answer of verdict.answerable ?? [])
			out(
				`  ${answer.audience}: ${answer.shown ? show({ every: answer.every, detail: answer.detail, after: answer.after, cellRules: answer.cellRules, evaluatedAt: answer.evaluatedAt }) : `not shown (${answer.why}) -> ${show({ hidden: "no_grant", text: whoSeesText(verdict) })}`}`,
			);
	}
	out(`  definition sha256 ${verdict.hash}`);
};

// ---- Facts about the presets the design relies on

heading("0. Inputs and the facts the design relies on");
const presets = new Map<string, Preset>();
for (const name of PROFILE_NAMES) presets.set(name, presetOf(name));
out(
	`${presets.size} presets rebuilt with buildFixture and the atm fold; each fixture hash and KPI hash equals the mart snapshot's.`,
);
let membershipPayments = 0;
let morePostings = 0;
let partitionMonths = 0;
let partitionMisses = 0;
let tierPayerMonths = 0;
let tierPayerMisses = 0;
for (const preset of presets.values()) {
	const payersByMonth = new Map<string, Map<string, Set<string>>>();
	for (const event of preset.events) {
		if (event.event_type !== "payment.succeeded") continue;
		const tiers = event.postings
			.map((posting) => MEMBERSHIP_ACCOUNT.exec(posting.account)?.[1])
			.filter((tier): tier is string => tier !== undefined);
		if (tiers.length === 0) continue;
		membershipPayments += 1;
		if (tiers.length > 1) morePostings += 1;
		const month = event.date.slice(0, 7);
		const byTier = payersByMonth.get(month) ?? new Map<string, Set<string>>();
		payersByMonth.set(month, byTier);
		for (const tier of tiers) {
			const holders = byTier.get(tier) ?? new Set<string>();
			holders.add(event.key);
			byTier.set(tier, holders);
		}
	}
	for (const month of monthsOf(preset)) {
		const gross = rowValue(preset, "gross_collected", month) ?? 0;
		const kinds = preset.rows
			.filter(
				(row) =>
					row.period === month && row.kpiId.startsWith("revenue_by_kind:"),
			)
			.reduce((sum, row) => sum + row.value, 0);
		const tiers = preset.rows
			.filter(
				(row) =>
					row.period === month && row.kpiId.startsWith("revenue_by_tier:"),
			)
			.reduce((sum, row) => sum + row.value, 0);
		const membership =
			rowValue(preset, "revenue_by_kind:membership", month) ?? 0;
		partitionMonths += 1;
		if (kinds !== gross || tiers !== membership) partitionMisses += 1;
		const payers = rowValue(preset, "paying_members", month) ?? 0;
		const byTier = [...(payersByMonth.get(month)?.values() ?? [])].reduce(
			(sum, holders) => sum + holders.size,
			0,
		);
		tierPayerMonths += 1;
		if (byTier !== payers) tierPayerMisses += 1;
	}
}
out(
	`membership payments on the 15 presets: ${membershipPayments}; with more than one membership posting: ${morePostings}`,
);
out(
	`preset months where sum(revenue_by_kind:*) = gross_collected and sum(revenue_by_tier:*) = revenue_by_kind:membership: ${partitionMonths - partitionMisses} of ${partitionMonths}`,
);
out(
	`preset months where the proposed paying_members_by_tier adds up to paying_members: ${tierPayerMonths - tierPayerMisses} of ${tierPayerMonths}`,
);

// ---- Example 1: revenue per paying member, by tier (one-payer-tier)

heading("1. Revenue per paying member, by plan (one-payer-tier)");
const revenuePerMember: MetricDefinition = {
	id: "revenue_per_paying_member_by_tier",
	version: 1,
	title: "Revenue per paying member, by plan",
	description:
		"Membership revenue of a plan over the plan's paying members, per month (cash basis).",
	model: "ledger.v1",
	kpiSpec: "school.v1",
	unit: "cents",
	format: "money0",
	compute: {
		op: "ratio",
		numerator: { measure: "revenue_by_tier" },
		denominator: { measure: "paying_members" },
	},
	groupBy: "tier",
};
printVerdict(validate(revenuePerMember, modelV1()));
const revenuePerMemberV1Point1: MetricDefinition = {
	...revenuePerMember,
	model: "ledger.v1.1",
	kpiSpec: "school.v1.1",
	compute: {
		op: "ratio",
		numerator: { measure: "revenue_by_tier" },
		denominator: { measure: "paying_members_by_tier" },
	},
};
printVerdict(validate(revenuePerMemberV1Point1, modelV1Point1()));

const onePayerTier = presets.get("one-payer-tier") as Preset;
const onePayerMonths = monthsOf(onePayerTier);
type TierMonth = {
	payers: number;
	revenue: number;
	largestShare: number;
};
/** The proposed measure's figures: distinct holders with a membership posting to the plan's income account in the
 * month, counted here from the preset's events (atm has no such KPI). With each holder's share of the plan's revenue. */
const tierMonthsOf = (preset: Preset): Map<string, TierMonth> => {
	const holders = new Map<string, Map<string, number>>();
	for (const event of preset.events) {
		if (event.event_type !== "payment.succeeded") continue;
		for (const posting of event.postings) {
			const tier = MEMBERSHIP_ACCOUNT.exec(posting.account)?.[1];
			if (!tier) continue;
			const key = `${tier}@${event.date.slice(0, 7)}`;
			const byHolder = holders.get(key) ?? new Map<string, number>();
			holders.set(key, byHolder);
			const cents = -Math.round(Number(posting.amount) * 100);
			byHolder.set(event.key, (byHolder.get(event.key) ?? 0) + cents);
		}
	}
	const result = new Map<string, TierMonth>();
	for (const [key, byHolder] of holders) {
		const amounts = [...byHolder.values()];
		const revenue = amounts.reduce((sum, amount) => sum + amount, 0);
		result.set(key, {
			payers: byHolder.size,
			revenue,
			largestShare: Math.max(...amounts) / revenue,
		});
	}
	return result;
};
const onePayerTierMonths = tierMonthsOf(onePayerTier);
const tiersOfPreset = PLAN_ORDER.filter((tier) =>
	onePayerTier.rows.some((row) => row.kpiId === `revenue_by_tier:${tier}`),
);
out();
out(
	"proposed paying_members_by_tier (counted from the preset events; not an atm figure today), and atm's revenue_by_tier:",
);
for (const tier of tiersOfPreset)
	out(
		`  ${tier}: payers ${series(onePayerMonths.map((month) => onePayerTierMonths.get(`${tier}@${month}`)?.payers ?? 0))} revenue ${series(onePayerMonths.map((month) => rowValue(onePayerTier, `revenue_by_tier:${tier}`, month)))} largest holder share ${series(onePayerMonths.map((month) => Number((onePayerTierMonths.get(`${tier}@${month}`)?.largestShare ?? 0).toFixed(3))))}`,
	);
for (const month of onePayerMonths) {
	const revenueSum = tiersOfPreset.reduce(
		(sum, tier) =>
			sum + (onePayerTierMonths.get(`${tier}@${month}`)?.revenue ?? 0),
		0,
	);
	if (
		revenueSum !== rowValue(onePayerTier, "revenue_by_kind:membership", month)
	)
		throw new Error(`${month}: event revenue is not atm's`);
}

const reasons = {
	fewer: "Hidden: fewer than 5 payers",
	share: "Hidden: one payer is over 60%",
	hiddenPair:
		"Hidden: hidden so the cell beside it can't be worked out from the total",
	roundedPair:
		"rounded so the cell beside it can't be worked out from the total",
	input: "Hidden: a figure it is worked out from is hidden",
};
/** The document's `roundCount` for a count that fails the cell rules (the file's `failingRoundTo` is 10). */
const roundCount = (value: number, why: string): Cell => {
	const unit = file.counts.failingRoundTo;
	return value < unit
		? { lt: unit, why }
		: { approx: Math.round(value / unit) * unit, why };
};

const governanceOnePayer = documentOf(onePayerTier, "governance");
const memberOnePayer = documentOf(onePayerTier, "member");
out();
out(
	"atm's governance document today (kpiDocument, oracle cell rule), revenue_by_tier cells:",
);
for (const tier of tiersOfPreset)
	out(
		`  revenue_by_tier:${tier} ${series(onePayerMonths.map((month) => cellAt(governanceOnePayer, "month", `revenue_by_tier:${tier}`, month)))}`,
	);
out(
	`  arpa ${series(onePayerMonths.map((month) => cellAt(governanceOnePayer, "month", "arpa", month)))} (the oracle counts a plan's payers as round(revenue / arpa))`,
);

/** The design's cells at governance with D9 resolved to per-cell holders: each input split takes the cell rules on
 * its own holders and the complementary rule (one hidden term hides the smallest shown one), then the custom cell is
 * hidden when either input cell is not a figure. */
const designCells = (month: string): Record<string, Cell> => {
	const revenueCells: Record<string, Cell> = {};
	const payerCells: Record<string, Cell> = {};
	for (const tier of tiersOfPreset) {
		const facts = onePayerTierMonths.get(`${tier}@${month}`);
		const revenue =
			rowValue(onePayerTier, `revenue_by_tier:${tier}`, month) ?? 0;
		const payers = facts?.payers ?? 0;
		const why =
			payers > 0 && payers < MIN_CONTRIBUTORS
				? reasons.fewer
				: (facts?.largestShare ?? 0) > MAX_SHARE
					? reasons.share
					: "";
		revenueCells[tier] = why ? { hidden: "suppressed", text: why } : revenue;
		payerCells[tier] = why
			? roundCount(payers, why.replace("Hidden: ", ""))
			: payers;
	}
	const pair = (cells: Record<string, Cell>, kind: "money" | "count"): void => {
		const cut = tiersOfPreset.filter((tier) => !isFigure(cells[tier]));
		if (cut.length !== 1) return;
		const next = tiersOfPreset
			.filter((tier) => isFigure(cells[tier]) && (cells[tier] as number) > 0)
			.sort(
				(first, second) => (cells[first] as number) - (cells[second] as number),
			)[0];
		if (next)
			cells[next] =
				kind === "money"
					? { hidden: "suppressed", text: reasons.hiddenPair }
					: roundCount(cells[next] as number, reasons.roundedPair);
	};
	pair(revenueCells, "money");
	pair(payerCells, "count");
	const result: Record<string, Cell> = {};
	for (const tier of tiersOfPreset) {
		const revenue = revenueCells[tier];
		const payers = payerCells[tier];
		result[`revenue_by_tier:${tier}`] = revenue as Cell;
		result[`paying_members_by_tier:${tier}`] = payers as Cell;
		result[`revenue_per_paying_member_by_tier:${tier}`] =
			isFigure(revenue) && isFigure(payers)
				? perMember(revenue, payers)
				: !isFigure(revenueCells[tier]) &&
						typeof revenue === "object" &&
						"hidden" in revenue &&
						revenue.text === reasons.fewer
					? { hidden: "suppressed", text: reasons.fewer }
					: { hidden: "suppressed", text: reasons.input };
	}
	return result;
};
out();
out(
	"design, governance, month table, D9 = per-cell holders (inputs as the document would show them, then the custom cell):",
);
const designByMonth = onePayerMonths.map(designCells);
for (const prefix of [
	"paying_members_by_tier",
	"revenue_by_tier",
	"revenue_per_paying_member_by_tier",
])
	for (const tier of tiersOfPreset)
		out(
			`  ${prefix}:${tier} ${series(designByMonth.map((cells) => cells[`${prefix}:${tier}`]))}`,
		);
out(
	`  July to December (atm's cells; no rows on this preset after June): ${series(["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"].map((month) => cellAt(governanceOnePayer, "month", "revenue_by_tier:scholar", month)))}`,
);
out();
out(
	"design under today's oracle rule instead (revenue_by_tier cells as atm's document has them; payers per plan pass on the period's 20 paying members):",
);
for (const tier of tiersOfPreset) {
	const cells = onePayerMonths.map((month) => {
		const revenue = cellAt(
			governanceOnePayer,
			"month",
			`revenue_by_tier:${tier}`,
			month,
		);
		const payers = onePayerTierMonths.get(`${tier}@${month}`)?.payers ?? 0;
		return isFigure(revenue)
			? perMember(revenue, payers)
			: { hidden: "suppressed", text: reasons.input };
	});
	out(
		`  revenue_per_paying_member_by_tier:${tier} ${series(cells)}; paying_members_by_tier:${tier} would show ${series(onePayerMonths.map((month) => onePayerTierMonths.get(`${tier}@${month}`)?.payers ?? 0))}`,
	);
}
out();
const scholarJanuary =
	designByMonth[0]?.["revenue_per_paying_member_by_tier:scholar"];
const scholarFebruary =
	designByMonth[1]?.["revenue_per_paying_member_by_tier:scholar"];
out(
	`compare with previousPeriod as difference, governance, 2026-02: scholar ${isFigure(scholarJanuary) && isFigure(scholarFebruary) ? scholarFebruary - scholarJanuary : "hidden"}; fellow ${show({ hidden: "suppressed", text: reasons.fewer })} (a comparison with a hidden side is hidden)`,
);
out(
	`member, quarter table: every cell ${show({ hidden: "no_grant", text: "Governance and up see this" })}; atm's member document carries no revenue_by_tier series either: ${Object.keys(memberOnePayer.tables.quarter?.series ?? {}).some((id) => id.startsWith("revenue_by_tier")) ? "it does" : "confirmed"}`,
);

// ---- Example 2: refund rate, trailing three months (heavy-refunds)

heading("2. Refund rate, trailing three months (heavy-refunds)");
const trailingRefundRate: MetricDefinition = {
	id: "refund_rate_trailing_3_months",
	version: 1,
	title: "Refund rate, trailing three months",
	description:
		"Refunds over gross collected, both summed over the three months ending with the period.",
	model: "ledger.v1",
	kpiSpec: "school.v1",
	unit: "ratio",
	format: "percent1",
	compute: {
		op: "ratio",
		numerator: { measure: "refunds" },
		denominator: { measure: "gross_collected" },
	},
	window: { trailing: 3 },
};
printVerdict(validate(trailingRefundRate, modelV1()));
const heavyRefunds = presets.get("heavy-refunds") as Preset;
const heavyMonths = monthsOf(heavyRefunds);
const governanceHeavy = documentOf(heavyRefunds, "governance");
const memberHeavy = documentOf(heavyRefunds, "member");
const months2026 = Array.from(
	{ length: 12 },
	(_, index) => `2026-${String(index + 1).padStart(2, "0")}`,
);
const windowOf = (endMonth: string, length: number): string[] => {
	const index = months2026.indexOf(endMonth);
	return months2026.slice(Math.max(0, index - length + 1), index + 1).length ===
		length
		? months2026.slice(index - length + 1, index + 1)
		: [];
};
const windowSum = (preset: Preset, kpiId: string, window: string[]) =>
	window.reduce((sum, month) => sum + (rowValue(preset, kpiId, month) ?? 0), 0);
const trailingCell = (
	preset: Preset,
	document: KpiDocument,
	grain: "month" | "quarter",
	period: string,
	window: string[],
): Cell => {
	const gate = cellAt(document, grain, "refund_rate", period);
	if (isGated(gate)) return gate as Cell;
	if (
		window.length === 0 ||
		window.some((month) => !heavyMonths.includes(month))
	)
		return {
			hidden: "not_computed",
			text: "Not computed: the window starts before the books",
		};
	const gross = windowSum(preset, "gross_collected", window);
	if (gross === 0) return { hidden: "not_computed", text: "Not computed" };
	return atmRatio(windowSum(preset, "refunds", window), gross);
};
out();
out(
	"governance, month table (rule: losses and income both month, no delay; cell rules off for a total):",
);
out(
	`  refund_rate_trailing_3_months ${series(months2026.map((month) => trailingCell(heavyRefunds, governanceHeavy, "month", month, windowOf(month, 3))))}`,
);
out(
	`  atm's refund_rate (month)     ${series(months2026.map((month) => cellAt(governanceHeavy, "month", "refund_rate", month)))}`,
);
out();
out(
	"member, quarter table (rule: total, quarter, 6 weeks; evaluated at quarter ends only, where the window is the quarter):",
);
const quarters2026 = ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"];
const quarterWindow = (quarter: string): string[] => {
	const index = Number(quarter.slice(-1)) - 1;
	return months2026.slice(3 * index, 3 * index + 3);
};
const memberTrailing = quarters2026.map((quarter) =>
	trailingCell(
		heavyRefunds,
		memberHeavy,
		"quarter",
		quarter,
		quarterWindow(quarter),
	),
);
const memberCatalog = quarters2026.map((quarter) =>
	cellAt(memberHeavy, "quarter", "refund_rate", quarter),
);
out(`  refund_rate_trailing_3_months ${series(memberTrailing)}`);
out(`  atm's refund_rate (quarter)   ${series(memberCatalog)}`);
out(
	`  equal to atm's member quarter cells: ${show(memberTrailing) === show(memberCatalog)}`,
);
for (const [index, quarter] of quarters2026.slice(0, 2).entries()) {
	const window = quarterWindow(quarter);
	const refundedBy = new Map<string, number>();
	for (const event of heavyRefunds.events) {
		if (
			event.event_type !== "payment.refunded" ||
			!window.includes(event.date.slice(0, 7))
		)
			continue;
		for (const posting of event.postings)
			if (posting.account === "income:billing:refunds")
				refundedBy.set(
					event.key,
					(refundedBy.get(event.key) ?? 0) +
						Math.round(Number(posting.amount) * 100),
				);
	}
	const refundHolders = refundedBy.size;
	const refundTotal = [...refundedBy.values()].reduce(
		(sum, amount) => sum + amount,
		0,
	);
	if (refundTotal !== windowSum(heavyRefunds, "refunds", window))
		throw new Error(`${quarter}: event refunds are not atm's`);
	const largestRefundShare = Math.max(...refundedBy.values()) / refundTotal;
	out(
		`  ${quarter}: refunds ${windowSum(heavyRefunds, "refunds", window)} / gross ${windowSum(heavyRefunds, "gross_collected", window)}; period paying members (oracle rule) ${Math.max(...window.map((month) => rowValue(heavyRefunds, "paying_members", month) ?? 0))}; distinct refunded holders (per-cell rule) ${refundHolders}, largest holder ${largestRefundShare.toFixed(3)} of the refunds; cell ${show(memberTrailing[index])}`,
	);
}
const firstQuarter = memberTrailing[0];
const secondQuarter = memberTrailing[1];
out(
	`  compare with previousPeriod as difference, 2026-Q2: ${isFigure(firstQuarter) && isFigure(secondQuarter) ? Number((secondQuarter - firstQuarter).toFixed(RATIO_PRECISION)) : "hidden"}; 2026-Q3: ${show(memberTrailing[2])} (an embargoed side keeps it embargoed)`,
);
out(
	`  compare with samePeriodLastYear, 2026-Q1: ${show({ hidden: "not_computed", text: "Not computed: no books for 2025-Q1" })}; atm's member document shows 2025-Q1 refund_rate ${show(cellAt(memberHeavy, "quarter", "refund_rate", "2025-Q1"))}, but ${show(memberHeavy.notes[0])}`,
);
out();
out(
	"why the member document never steps the window monthly: windows ending in Apr and May are not quarters, and consecutive windows difference to month figures:",
);
for (const month of ["2026-03", "2026-04", "2026-05", "2026-06"]) {
	const window = windowOf(month, 3);
	out(
		`  window ${window[0]}..${month}: refunds ${windowSum(heavyRefunds, "refunds", window)}, gross ${windowSum(heavyRefunds, "gross_collected", window)}, rate ${atmRatio(windowSum(heavyRefunds, "refunds", window), windowSum(heavyRefunds, "gross_collected", window))}`,
	);
}
out(
	`  T(Apr) - T(Mar) of refunds = refunds(Apr) - refunds(Jan) = ${windowSum(heavyRefunds, "refunds", windowOf("2026-04", 3)) - windowSum(heavyRefunds, "refunds", windowOf("2026-03", 3))} (${rowValue(heavyRefunds, "refunds", "2026-04")} - ${rowValue(heavyRefunds, "refunds", "2026-01")}), a month-grain fact`,
);
out(
	`  T(May) - T(Jun) of refunds = refunds(Mar) - refunds(Jun) = ${windowSum(heavyRefunds, "refunds", windowOf("2026-05", 3)) - windowSum(heavyRefunds, "refunds", windowOf("2026-06", 3))}; June had ${rowValue(heavyRefunds, "refunds", "2026-06")} in refunds, so a member who knows June was quiet learns March exactly (${rowValue(heavyRefunds, "refunds", "2026-03")})`,
);

// ---- Example 3: a donor campaign total (fixture gifts)

heading("3. A campaign total (the mockup's fixture gifts, b4u)");
const scholarshipsByMonth: MetricDefinition = {
	id: "scholarships_campaign_total",
	version: 1,
	title: "Scholarships campaign",
	description: "Gifts received for the Scholarships campaign, per month.",
	model: "ledger.v1",
	kpiSpec: "school.v1",
	unit: "cents",
	format: "money0",
	compute: {
		op: "value",
		of: { measure: "donations_by_fund", where: { campaign: "scholarships" } },
	},
};
printVerdict(validate(scholarshipsByMonth, modelV1()));
const scholarshipsToDate: MetricDefinition = {
	...scholarshipsByMonth,
	id: "scholarships_campaign_to_date",
	title: "Scholarships campaign, year to date",
	description: "Gifts received for the Scholarships campaign since 1 January.",
	window: { toDate: "year" },
};
printVerdict(validate(scholarshipsToDate, modelV1()));
const gifts = mockupDonors[SCHOOL] ?? [];
const monthlyMembers = presets.get("monthly-members") as Preset;
const governanceDonors = documentOf(monthlyMembers, "governance", gifts);
const financeDonors = documentOf(monthlyMembers, "finance", gifts);
const memberDonors = documentOf(monthlyMembers, "member", gifts);
const funds = [...new Set(gifts.map((gift) => gift.fund))];
const slug = (text: string): string =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
const giftMonths = months2026.slice(0, 9);
out();
out(
	`fixture gifts: ${gifts.length}, ${gifts[0]?.date} to ${gifts
		.map((gift) => gift.date)
		.sort()
		.at(-1)}`,
);
for (const fund of funds) {
	const inMonth = giftMonths.map((month) =>
		gifts.filter((gift) => gift.fund === fund && gift.date.startsWith(month)),
	);
	out(
		`  ${slug(fund)}: gifts per month ${series(inMonth.map((list) => list.length))}, cents per month ${series(inMonth.map((list) => list.reduce((sum, gift) => sum + gift.amount, 0)))}`,
	);
}
out();
out(
	"atm's governance document today: donations_by_fund is year to date (January to the end of each month), cell rules on (a breakdown):",
);
for (const fund of funds)
	out(
		`  donations_by_fund:${slug(fund)} ${series(giftMonths.map((month) => cellAt(governanceDonors, "month", `donations_by_fund:${slug(fund)}`, month)))}`,
	);
out("atm's finance document (live, cell rules off):");
for (const fund of funds)
	out(
		`  donations_by_fund:${slug(fund)} ${series(giftMonths.map((month) => cellAt(financeDonors, "month", `donations_by_fund:${slug(fund)}`, month)))}`,
	);
out(
	`member document: donor series present: ${Object.keys(memberDonors.tables.quarter?.series ?? {}).some((id) => id.startsWith("donations"))}`,
);
/** A month's own gifts to a fund pass the cell rules (at least 5 gifts, the largest at most 60%). */
const monthPasses = (fund: string, month: string): boolean => {
	const inside = gifts.filter(
		(gift) => gift.fund === fund && gift.date.startsWith(month),
	);
	if (inside.length === 0) return true;
	const sum = inside.reduce((total, gift) => total + gift.amount, 0);
	return (
		inside.length >= MIN_CONTRIBUTORS &&
		Math.max(...inside.map((gift) => gift.amount)) / sum <= MAX_SHARE
	);
};
out();
out(
	"leak in today's year-to-date table: consecutive shown cells whose difference is one month's gifts that fail the cell rules:",
);
let leaks = 0;
for (const fund of funds) {
	const id = `donations_by_fund:${slug(fund)}`;
	for (const [index, month] of giftMonths.entries()) {
		if (index === 0) continue;
		const before = cellAt(
			governanceDonors,
			"month",
			id,
			giftMonths[index - 1] as string,
		);
		const now = cellAt(governanceDonors, "month", id, month);
		if (!isFigure(before) || !isFigure(now) || monthPasses(fund, month))
			continue;
		const inside = gifts.filter(
			(gift) => gift.fund === fund && gift.date.startsWith(month),
		);
		leaks += 1;
		out(
			`  ${id} ${month}: ${now} - ${before} = ${now - before}, the month's ${inside.length} gift(s) ${show(inside.map((gift) => gift.amount))}`,
		);
	}
}
out(`  ${leaks} month cells`);
/** The design's governance cells for the per-month campaign total: the month's own gifts take the cell rules; one
 * hidden fund hides the smallest shown one. */
const campaignMonthCells = (fund: string): Cell[] =>
	giftMonths.map((month) => {
		const items = funds.map((name) => {
			const inside = gifts.filter(
				(gift) => gift.fund === name && gift.date.startsWith(month),
			);
			const sum = inside.reduce((total, gift) => total + gift.amount, 0);
			const top = Math.max(0, ...inside.map((gift) => gift.amount));
			const why =
				inside.length === 0
					? ""
					: inside.length < MIN_CONTRIBUTORS
						? "Hidden: fewer than 5 donors"
						: top / sum > MAX_SHARE
							? "Hidden: one donor is over 60%"
							: "";
			return { name, count: inside.length, sum, why };
		});
		const hidden = items.filter((item) => item.why);
		if (hidden.length === 1) {
			const next = items
				.filter((item) => !item.why && item.count > 0)
				.sort((first, second) => first.sum - second.sum)[0];
			if (next) next.why = reasons.hiddenPair;
		}
		const item = items.find((candidate) => candidate.name === fund);
		if (!item || item.count === 0) return 0;
		return item.why ? { hidden: "suppressed", text: item.why } : item.sum;
	});
/** The design's year-to-date cells: a cell shows only when its difference from the last shown cell (the months that
 * entered) passes the cell rules as one cell; otherwise it is hidden like a complementary cell. */
const campaignToDateCells = (fund: string): Cell[] => {
	let lastShown = -1;
	return giftMonths.map((month, index) => {
		const entering = gifts.filter(
			(gift) =>
				gift.fund === fund &&
				gift.date.slice(0, 7) > (giftMonths[lastShown] ?? "0000-00") &&
				gift.date.slice(0, 7) <= month,
		);
		const sum = entering.reduce((total, gift) => total + gift.amount, 0);
		const passes =
			entering.length === 0 ||
			(entering.length >= MIN_CONTRIBUTORS &&
				Math.max(...entering.map((gift) => gift.amount)) / sum <= MAX_SHARE);
		if (!passes)
			return {
				hidden: "suppressed",
				text: "Hidden: the change since the last figure has fewer than 5 donors or one over 60%",
			};
		lastShown = index;
		return gifts
			.filter((gift) => gift.fund === fund && gift.date.slice(0, 7) <= month)
			.reduce((total, gift) => total + gift.amount, 0);
	});
};
out();
out("design, governance, month table:");
out(
	`  scholarships_campaign_total    ${series(campaignMonthCells("Scholarships"))}`,
);
out(
	`  scholarships_campaign_to_date  ${series(campaignToDateCells("Scholarships"))}`,
);
out(
	`  (building fund, per month)     ${series(campaignMonthCells("Building fund"))}`,
);
out(
	`design, finance and owner: live, cell rules off: to date ${series(giftMonths.map((month) => gifts.filter((gift) => gift.fund === "Scholarships" && gift.date.slice(0, 7) <= month).reduce((total, gift) => total + gift.amount, 0)))}`,
);
out(
	`design, public and member: every cell ${show({ hidden: "no_grant", text: "Governance and up see this" })}`,
);

// ---- Example 4: refused (one-payer-tier)

heading(
	"4. Refused: membership revenue without the fellow plan (one-payer-tier)",
);
const withoutFellow: MetricDefinition = {
	id: "membership_revenue_without_fellow",
	version: 1,
	title: "Membership revenue, fellow excluded",
	description: "Gross collected less the fellow plan's revenue.",
	model: "ledger.v1",
	kpiSpec: "school.v1",
	unit: "cents",
	format: "money0",
	compute: {
		op: "sum",
		terms: [
			{ sign: 1, of: { measure: "gross_collected" } },
			{
				sign: -1,
				of: { measure: "revenue_by_tier", where: { tier: "fellow" } },
			},
		],
	},
};
printVerdict(validate(withoutFellow, modelV1()));
const otherTiers: MetricDefinition = {
	...withoutFellow,
	id: "fellow_by_difference",
	title: "Membership revenue less the other plans",
	description: "Membership revenue less audit, scholar and seminar.",
	compute: {
		op: "sum",
		terms: [
			{
				sign: 1,
				of: { measure: "revenue_by_kind", where: { kind: "membership" } },
			},
			{
				sign: -1,
				of: {
					measure: "revenue_by_tier",
					where: { tier: { in: ["audit", "scholar", "seminar"] } },
				},
			},
		],
	},
};
printVerdict(validate(otherTiers, modelV1()));
const positiveOnly: MetricDefinition = {
	...withoutFellow,
	id: "membership_revenue_three_plans",
	title: "Membership revenue of three plans",
	description: "Revenue of audit, scholar and seminar.",
	compute: {
		op: "value",
		of: {
			measure: "revenue_by_tier",
			where: { tier: { in: ["audit", "scholar", "seminar"] } },
		},
	},
};
printVerdict(validate(positiveOnly, modelV1()));
out();
out(
	"what the refused definition would print at governance, against atm's cells (one-payer-tier):",
);
for (const month of onePayerMonths.slice(0, 2)) {
	const gross = cellAt(governanceOnePayer, "month", "gross_collected", month);
	const fellow = cellAt(
		governanceOnePayer,
		"month",
		"revenue_by_tier:fellow",
		month,
	);
	const difference =
		(rowValue(onePayerTier, "gross_collected", month) ?? 0) -
		(rowValue(onePayerTier, "revenue_by_tier:fellow", month) ?? 0);
	out(
		`  ${month}: gross_collected cell ${show(gross)}, revenue_by_tier:fellow cell ${show(fellow)}, gross - fellow = ${difference}, so fellow = ${isFigure(gross) ? gross - difference : "?"} (the one fellow payer's payment)`,
	);
}
const threePlans = (month: string) =>
	["audit", "scholar", "seminar"].reduce(
		(sum, tier) =>
			sum + (rowValue(onePayerTier, `revenue_by_tier:${tier}`, month) ?? 0),
		0,
	);
out(
	`  the accepted positive-only rewrite, 2026-02: three plans = ${threePlans("2026-02")}, complement within revenue_by_kind:membership = ${(rowValue(onePayerTier, "revenue_by_kind:membership", "2026-02") ?? 0) - threePlans("2026-02")} from ${onePayerTierMonths.get("fellow@2026-02")?.payers} payer -> cell ${show({ hidden: "suppressed", text: reasons.hiddenPair })}`,
);
out();
out("other refusals:");
const refusals: MetricDefinition[] = [
	{
		...withoutFellow,
		id: "mrr_by_tier",
		title: "MRR by plan",
		description: "Monthly recurring revenue by plan.",
		compute: { op: "value", of: { measure: "mrr" } },
		groupBy: "tier",
	},
	{
		...withoutFellow,
		id: "revenue_alias",
		title: "Revenue",
		description: "Revenue.",
		compute: { op: "value", of: { measure: "revenue" } },
	},
	{
		...withoutFellow,
		id: "paying_members_by_tier_v1",
		title: "Paying members by plan",
		description: "Paying members, split by plan, on model v1.",
		unit: "count",
		format: "integer",
		compute: { op: "value", of: { measure: "paying_members" } },
		groupBy: "tier",
	},
	{
		...withoutFellow,
		id: "credit_balances_by_account",
		title: "Credit balances",
		description: "Each credit account's closing balance.",
		unit: "count",
		format: "integer",
		compute: { op: "value", of: { measure: "closing_balance_credits" } },
		groupBy: "account",
	},
	{
		...withoutFellow,
		id: "refund_rate_summed",
		title: "Refund rate, summed",
		description: "Three months of refund rates added up.",
		unit: "ratio",
		format: "percent1",
		compute: { op: "value", of: { measure: "refund_rate" } },
		window: { trailing: 3 },
	},
	{
		...withoutFellow,
		id: "members_per_dollar",
		title: "Members per dollar",
		description: "Paying members over gross collected.",
		unit: "ratio",
		format: "percent1",
		compute: {
			op: "ratio",
			numerator: { measure: "paying_members" },
			denominator: { measure: "gross_collected" },
		},
	},
];
for (const definition of refusals)
	printVerdict(validate(definition, modelV1()));
out();
out(
	"a published definition after the model drops or renames a measure (refunds renamed refunds_issued in a later model):",
);
const renamed = modelV1();
renamed.id = "ledger.v2";
const refunds = renamed.measures.get("refunds") as MeasureFacts;
renamed.measures.delete("refunds");
renamed.measures.set("refunds_issued", { ...refunds, id: "refunds_issued" });
printVerdict(validate(trailingRefundRate, renamed));

// `--definitions`: the example definitions as the doc prints them (their hashes are above).
if (process.argv.includes("--definitions")) {
	heading("Definitions");
	for (const definition of [
		revenuePerMember,
		revenuePerMemberV1Point1,
		trailingRefundRate,
		scholarshipsByMonth,
		scholarshipsToDate,
		withoutFellow,
		otherTiers,
		positiveOnly,
	])
		out(JSON.stringify(definition, null, "\t"));
}
