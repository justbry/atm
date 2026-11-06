/** The KPI document (spec v3 "The document", protocol §3): one per school, year, viewer and grain. The fixtures are
 * computed by the orchestrator's `gates/oracle.ts`; the UI only renders them and derives nothing. */
export type Viewer = "owner" | "finance" | "admin" | "locked" | "demo";
export type Grain = "month" | "quarter";
export type HiddenKind =
	| "suppressed"
	| "locked"
	| "not_computed"
	| "open_period"
	| "blocked";
/** A number in the KPI's unit (money in integer minor units, a count, or a fraction), a band `{ lt: N }` shown as
 * `<N`, or a hidden cell with its reason. */
export type Cell = number | { lt: number } | { hidden: HiddenKind };
/** What `data-cell` says about a rendered cell. */
export type CellKind = "number" | "lt" | HiddenKind;
/** How a KPI's numbers are written: `money` with `Intl.NumberFormat("en-US", { style: "currency" })` from minor
 * units, `integer` with en-US grouping, `percent1` as a percent with one decimal. */
export type KpiFormat = "money" | "integer" | "percent1";

export type KpiMeta = {
	title: string;
	/** atm's unit: `cents` (minor units of the document currency), `count` or `ratio`. */
	unit: "cents" | "count" | "ratio";
	/** Decimals shown: 2 for money, 0 for integers, 1 for percents. */
	precision: number;
	format: KpiFormat;
	/** Computed from other KPIs (or, for demo-only KPIs, derived from the mart). */
	derived: boolean;
	/** Shown only to the demo viewer, with the label "derived, demo only". */
	demoOnly: boolean;
};

export type KpiDocument = {
	school: string;
	preset: string;
	viewer: Viewer;
	year: number;
	basis: "cash";
	/** ISO 4217, lower case as atm writes it (`usd`, `eur`). */
	currency: string;
	tz: string;
	kpiSpecVersion: string;
	grain: Grain;
	asOf: string;
	lagMinutes: number;
	/** The open period (the clock's month or quarter), when the preset has it. */
	partialPeriods: string[];
	rules: { minContributors: number; maxShare: number };
	/** `YYYY-MM` or `YYYY-Qn`, up to the clock's month. */
	periods: string[];
	/** One cell per period; dimensioned ids are `<kpi>:<dimension>`. */
	series: Record<string, Cell[]>;
	meta: Record<string, KpiMeta>;
	notComputed: Array<{ id: string; reason: string }>;
	verified: boolean;
};

/** What the Reader's `kpiDocument` is asked for. */
export type KpiQuery = { preset: string; viewer: Viewer; grain: Grain };

export const cellKind = (cell: Cell): CellKind =>
	typeof cell === "number" ? "number" : "lt" in cell ? "lt" : cell.hidden;
