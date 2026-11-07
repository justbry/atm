/**
 * The KPI spec (`kpis/school.v1.json`, checked against `schema/kpis.v1.json`) and what is done with it once a channel has
 * computed the base aggregates: zero-fill, the derived KPIs (ratio, combine), the canonical rows, the hash and the
 * per-KPI diff. Each channel (the atm fold, hledger, DuckDB) turns the same spec into base values; nothing else may
 * differ between them, so the formulas of the derived KPIs live here once and the base ones in the spec.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import schoolSpec from "../../kpis/school.v1.json";
import kpisSchema from "../../schema/kpis.v1.json";
import { canonicalize, sha256Hex } from "../ledger/util.js";
import {
	compareKpiRows,
	type Kpi,
	type KpiRow,
	type KpiSpec,
} from "./kpi-evaluate.js";

export type {
	BaseKpi,
	BaseValues,
	Kpi,
	KpiBy,
	KpiChannel,
	KpiCompute,
	KpiRow,
	KpiSpec,
	KpiUnit,
	KpiWhere,
} from "./kpi-evaluate.js";
export { evaluateKpis, isBase, periodsFrom } from "./kpi-evaluate.js";

export class KpiSpecError extends Error {}

let validator: ReturnType<Ajv2020["compile"]> | null = null;

/** The spec checked against its schema and its own references (a ratio or combine names earlier KPIs without a dimension). Throws `KpiSpecError` with every problem. */
export const parseKpiSpec = (raw: unknown): KpiSpec => {
	if (!validator)
		validator = new Ajv2020({ allErrors: true, strict: false }).compile(
			kpisSchema,
		);
	if (!validator(raw))
		throw new KpiSpecError(
			`kpis spec does not match schema/kpis.v1.json: ${(validator.errors ?? [])
				.map((e) => `${e.instancePath || "/"} ${e.message}`)
				.join("; ")}`,
		);
	const spec = raw as KpiSpec;
	const problems: string[] = [];
	const seen = new Map<string, Kpi>();
	for (const kpi of spec.kpis) {
		if (seen.has(kpi.id)) problems.push(`duplicate id ${kpi.id}`);
		const refs =
			kpi.compute.op === "ratio"
				? [kpi.compute.num, kpi.compute.den]
				: kpi.compute.op === "combine"
					? kpi.compute.terms.map((t) => t.kpi)
					: [];
		const c = kpi.compute;
		if ((c.op === "count" || c.op === "distinct") && c.by?.from === "account")
			problems.push(
				`${kpi.id}: ${c.op} cannot be split by account (an event has several postings); use a label`,
			);
		for (const ref of refs) {
			const target = seen.get(ref);
			if (!target) problems.push(`${kpi.id}: ${ref} is not an earlier KPI`);
			else if ("by" in target.compute && target.compute.by)
				problems.push(`${kpi.id}: ${ref} has a dimension`);
		}
		seen.set(kpi.id, kpi);
	}
	if (problems.length > 0) throw new KpiSpecError(problems.join("; "));
	return spec;
};

/** The committed spec for a school's books. */
export const SCHOOL_KPIS: KpiSpec = parseKpiSpec(schoolSpec);

/** The hashed document: `{kpiId, period, value}` rows sorted by id then period, canonical JSON, sha256. */
export const kpiHash = (rows: readonly KpiRow[]): string =>
	sha256Hex(
		canonicalize(
			[...rows]
				.sort(compareKpiRows)
				.map(({ kpiId, period, value }) => ({ kpiId, period, value })),
		),
	);

/** One line per KPI-period that differs between two channels' rows: `kpi period: a=1 b=2`. Empty when equal. */
export const diffKpis = (
	a: { name: string; rows: readonly KpiRow[] },
	b: { name: string; rows: readonly KpiRow[] },
): string[] => {
	const index = (rows: readonly KpiRow[]) =>
		new Map(rows.map((r) => [`${r.kpiId} ${r.period}`, r.value]));
	const left = index(a.rows);
	const right = index(b.rows);
	const lines: string[] = [];
	for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
		const l = left.get(key);
		const r = right.get(key);
		if (l !== r)
			lines.push(
				`${key}: ${a.name}=${l ?? "missing"} ${b.name}=${r ?? "missing"}`,
			);
	}
	return lines;
};
