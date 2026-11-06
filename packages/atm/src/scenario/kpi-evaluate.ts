/**
 * The pure part of the KPI spec: its types and what is done with a channel's base aggregates (zero-fill, the derived
 * KPIs, the canonical rows). No Ajv, no file and no hash, so the Worker can run it; `kpis.ts` adds the spec's schema
 * check and the hash and re-exports all of this.
 */
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

export const compareKpiRows = (a: KpiRow, b: KpiRow) =>
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
	return out.sort(compareKpiRows);
};

/** The KPI a cell id belongs to: `revenue_by_tier:fellow` is `revenue_by_tier`. */
export const kpiRootId = (id: string): string => id.split(":")[0] as string;
