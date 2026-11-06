/** The KPI document (spec v3 "The document", protocol §3 and §11b): one per school, preset, books level and PIN state.
 * The fixtures are computed by the orchestrator's `gates/oracle.ts`; the UI only renders them and derives nothing. */
export type BooksLevel =
	| "public"
	| "member"
	| "governance"
	| "finance_admin"
	| "owner";
export type Grain = "year" | "quarter" | "month";
export type HiddenKind =
	| "suppressed"
	| "locked"
	| "not_computed"
	| "not_yet"
	| "blocked";
/** A number in the KPI's unit (money in integer minor units, a count, or a fraction), `{ lt: N }` for a positive
 * amount that rounds to 0 (shown "under $1,000"), or a hidden cell with its kind and, when suppressed, the reason
 * (for example "fewer than 5 payers"). */
export type Cell =
	| number
	| { lt: number }
	| { hidden: HiddenKind; why?: string };
/** What `data-cell` says about a rendered cell. */
export type CellKind = "number" | "lt" | HiddenKind;
/** How a KPI's numbers are written: `money` with `Intl.NumberFormat("en-US", { style: "currency" })` from minor
 * units, `money0` the same with no decimals, `integer` with en-US grouping, `percent1` a percent with one decimal. */
export type KpiFormat = "money" | "money0" | "integer" | "percent1";
/** A KPI's lag class: which delay of the level applies to it. */
export type LagClass = "money" | "usage";

export type KpiMeta = {
	title: string;
	/** atm's unit: `cents` (minor units of the document currency), `count` or `ratio`. */
	unit: "cents" | "count" | "ratio";
	/** Decimals shown. */
	precision: number;
	format: KpiFormat;
	/** The granularity step (G1 totals to G4 distributions). */
	step: "G1" | "G2" | "G3" | "G4";
	lag: LagClass;
	/** Computed from other KPIs. */
	derived: boolean;
	/** Invented by the fixtures (the mockup's donors), not from atm's books. */
	invented: boolean;
	/** How a year or quarter cell is made, when it is not a plain sum (for example "most in one month of the
	 * period"). */
	note?: string;
};

export type PeriodInfo = {
	period: string;
	/** As the period strip shows it: `2024`, `Q1 2025`, `Jun`. */
	label: string;
	/** Invented from 2026's shape (the mockup's earlier years), not from atm's books. */
	invented: boolean;
	/** The open period, live and still changing (finance admin and owner). */
	partial: boolean;
	/** The day the period shows for each lag class, or null when it shows now. */
	shownFrom: Record<LagClass, string | null>;
	/** That day as the mockup writes it: `Jan 2027` (years, quarters) or `Nov 7` (months). */
	shownFromLabel: Record<LagClass, string | null>;
	/** The "not shown yet" box for each lag class, or null when the period shows. */
	waiting: Record<
		LagClass,
		{ title: string; when: string; why: string } | null
	>;
};

export type KpiDocument = {
	school: string;
	preset: string;
	level: BooksLevel;
	pinLocked: boolean;
	year: number;
	basis: "cash";
	/** ISO 4217, lower case as atm writes it (`usd`, `eur`). */
	currency: string;
	tz: string;
	kpiSpecVersion: string;
	grain: Grain;
	asOf: string;
	lagMinutes: number;
	/** The open period, when the level shows it and the preset has it. */
	partialPeriods: string[];
	rules: { minContributors: number; maxShare: number };
	policy: {
		steps: "G2" | "G4" | "G6";
		roundTo: number;
		cellRules: "all" | "G3 and G4" | "off";
		pin: boolean;
	};
	/** The level's caption for each lag class (the Money and Risk views use `money`, Members `usage`). */
	caption: Record<LagClass, string>;
	/** `YYYY`, `YYYY-Qn` or `YYYY-MM`, up to the clock's month. */
	periods: string[];
	periodInfo: PeriodInfo[];
	/** One cell per period; dimensioned ids are `<kpi>:<dimension>`. */
	series: Record<string, Cell[]>;
	meta: Record<string, KpiMeta>;
	/** Finance admin and owner: gross collected per day of every month in `periods` (invented from the month's total,
	 * as the mockup does); days after the clock are not_yet. */
	days: { periods: string[]; series: Record<string, Cell[]> } | null;
	notComputed: Array<{ id: string; reason: string }>;
	/** The fixture quirks this document carries. */
	notes: string[];
	verified: boolean;
};

/** What the Reader's `kpiDocument` is asked for. `pinLocked` applies from governance up. */
export type KpiQuery = {
	preset: string;
	level: BooksLevel;
	pinLocked: boolean;
};

export const cellKind = (cell: Cell): CellKind =>
	typeof cell === "number" ? "number" : "lt" in cell ? "lt" : cell.hidden;
