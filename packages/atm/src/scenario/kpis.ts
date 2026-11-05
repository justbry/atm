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
import type { AtmEvent } from "../types.js";

export type KpiWhere = {
	eventType?: string[];
	account?: string;
	label?: { name: string; pattern: string };
};
export type KpiBy = { from: string; pattern: string };
export type KpiCompute =
	| {
			op: "sum";
			commodity: "usd" | "credits";
			sign: 1 | -1;
			where: KpiWhere;
			cumulative?: boolean;
			by?: KpiBy;
	  }
	| { op: "count"; where: KpiWhere; by?: KpiBy }
	| { op: "distinct"; where: KpiWhere; first?: boolean; by?: KpiBy }
	| { op: "ratio"; num: string; den: string }
	| { op: "combine"; terms: { kpi: string; sign: 1 | -1 }[] };
export type KpiUnit = "cents" | "count" | "ratio";
export type Kpi = {
	id: string;
	title: string;
	unit: KpiUnit;
	precision: number;
	definition: string;
	compute: KpiCompute;
};
export type KpiSpec = { version: 1; grain: "month"; kpis: Kpi[] };
/** A base KPI: one a channel computes from the events (the others are derived from these). */
export type BaseKpi = Kpi & {
	compute: Extract<KpiCompute, { op: "sum" | "count" | "distinct" }>;
};
export const isBase = (kpi: Kpi): kpi is BaseKpi =>
	kpi.compute.op === "sum" ||
	kpi.compute.op === "count" ||
	kpi.compute.op === "distinct";

/** What a channel returns: for each base KPI id (`<id>` or `<id>:<dimension>`), its whole-number value per period; a period left out is 0. */
export type BaseValues = Record<string, Record<string, number>>;

/** One channel: the same spec over the same events, in its own engine. */
export type KpiChannel = {
	name: string;
	base: (input: {
		events: readonly AtmEvent[];
		spec: KpiSpec;
		periods: readonly string[];
	}) => Promise<BaseValues> | BaseValues;
};

export type KpiRow = {
	kpiId: string;
	period: string;
	value: number;
	unit: KpiUnit;
};

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

/** `YYYY-MM` months from `start` for `months` months. */
export const periodsFrom = (start: string, months: number): string[] => {
	const [y, m] = start.split("-").map(Number) as [number, number];
	return Array.from({ length: months }, (_, i) => {
		const index = y * 12 + (m - 1) + i;
		return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
	});
};

const roundedRatio = (num: number, den: number, precision: number): number => {
	if (den === 0) return 0;
	const scale = 10n ** BigInt(precision);
	const n = BigInt(num) * scale;
	const d = BigInt(den);
	// half up, away from zero for negatives
	const negative = n < 0n !== d < 0n;
	const abs = (x: bigint) => (x < 0n ? -x : x);
	const q = (2n * abs(n) + abs(d)) / (2n * abs(d));
	return Number(negative ? -q : q) / Number(scale);
};

const byId = (a: KpiRow, b: KpiRow) =>
	a.kpiId < b.kpiId
		? -1
		: a.kpiId > b.kpiId
			? 1
			: a.period < b.period
				? -1
				: a.period > b.period
					? 1
					: 0;

/** Base values to every KPI of the spec, per period: dimensions filled with 0 in the periods they are absent, derived KPIs evaluated, sorted by id then period. */
export const evaluateKpis = ({
	spec,
	base,
	periods,
}: {
	spec: KpiSpec;
	base: BaseValues;
	periods: readonly string[];
}): KpiRow[] => {
	const rows = new Map<string, Record<string, number>>();
	for (const kpi of spec.kpis) {
		const c = kpi.compute;
		if (isBase(kpi)) {
			const ids = kpi.compute.by
				? Object.keys(base).filter((k) => k.startsWith(`${kpi.id}:`))
				: [kpi.id];
			for (const id of ids) {
				const values = base[id] ?? {};
				rows.set(
					id,
					Object.fromEntries(periods.map((p) => [p, values[p] ?? 0])),
				);
			}
		} else if (c.op === "ratio") {
			const num = rows.get(c.num) as Record<string, number>;
			const den = rows.get(c.den) as Record<string, number>;
			rows.set(
				kpi.id,
				Object.fromEntries(
					periods.map((p) => [
						p,
						roundedRatio(num[p] as number, den[p] as number, kpi.precision),
					]),
				),
			);
		} else if (c.op === "combine") {
			rows.set(
				kpi.id,
				Object.fromEntries(
					periods.map((p) => [
						p,
						c.terms.reduce(
							(n, t) =>
								n +
								t.sign *
									((rows.get(t.kpi) as Record<string, number>)[p] as number),
							0,
						),
					]),
				),
			);
		}
	}
	const unitOf = new Map(spec.kpis.map((k) => [k.id, k.unit]));
	const out: KpiRow[] = [];
	for (const [kpiId, values] of rows)
		for (const period of periods)
			out.push({
				kpiId,
				period,
				value: values[period] as number,
				unit: unitOf.get(kpiId.split(":")[0] as string) as KpiUnit,
			});
	return out.sort(byId);
};

/** The hashed document: `{kpiId, period, value}` rows sorted by id then period, canonical JSON, sha256. */
export const kpiHash = (rows: readonly KpiRow[]): string =>
	sha256Hex(
		canonicalize(
			[...rows]
				.sort(byId)
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
