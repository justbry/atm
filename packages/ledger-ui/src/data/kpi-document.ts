import type {
	Audience,
	DetailStep,
	KpiClass,
	SchoolSize,
} from "./disclosure.ts";

/** The KPI document (disclosure spec v2 "Documents and routes"): one per school, data source, audience and PIN state,
 * with the audience's detail, grain, delay, rounding and cell rules already applied by the orchestrator's
 * `gates/oracle.ts` from the disclosure object (`disclosure.ts`). The UI renders it and derives nothing. */

/** Why a cell is not a figure. `embargoed`, `members_only` and `no_grant` are the disclosure's `HiddenReason`s;
 * `suppressed` an amount that fails the cell rules (shown "—"); `future` a day after the clock; `locked` the PIN-locked
 * document; `not_computed` no row. */
export type HiddenKind =
	| "embargoed"
	| "members_only"
	| "no_grant"
	| "suppressed"
	| "future"
	| "locked"
	| "not_computed";
/**
 * - a number in the KPI's unit (money in minor units, a count, a fraction);
 * - `{ lt }`: a positive amount that rounds to 0 ("under $100"), or a count from 1 to 9 that fails the cell rules
 *   ("<10", with `why`);
 * - `{ approx, why }`: a count that fails the cell rules, rounded to the nearest 10;
 * - `{ hidden, text }`: what the cell reads instead ("Published after 7 Jan 2027", "Members see this", "Governance and
 *   up see this", "Hidden: fewer than 5 payers" shown as "—").
 */
export type Cell =
	| number
	| { lt: number; why?: string }
	| { approx: number; why: string }
	| { hidden: HiddenKind; text: string };
/** What `data-cell` says about a rendered cell. */
export type CellKind = "number" | "lt" | "approx" | HiddenKind;
/** As the mockup writes figures (`kusd`, `kusd0`, `kpct`): `money` is "−" (U+2212) for a negative, the document's
 * `symbol`, then the units with en-US grouping and two decimals (`toLocaleString("en-US", { minimumFractionDigits: 2,
 * maximumFractionDigits: 2 })`); `money0` the same rounded to whole units (`Math.round`, no decimals: rounded
 * audiences, plans, funds, the median gift); `integer` the plain number (`String`); `percent1`
 * `(value * 100).toFixed(1) + "%"`. A count `lt` reads `<10`, an amount `lt` "under " plus the unit in `money0`; an
 * `approx` count its plain number. */
export type KpiFormat = "money" | "money0" | "integer" | "percent1";
export type TableGrain = "year" | "quarter" | "month" | "day";

export type KpiMeta = {
	/** The mockup's label (its KPI table), or the dimension's name ("Scholar", "Memberships", "General"). */
	title: string;
	kind: "money" | "count" | "rate";
	format: KpiFormat;
	/** The disclosure class (the donor KPIs, which atm's catalog does not have yet, sit with `people` and `income`). */
	kpiClass: KpiClass;
	/** The audience's own grain for this KPI (its rule's `every`; `day` when live): the table a series of it reads. */
	every: TableGrain;
	detail: DetailStep;
	/** Not from atm's books: the mockup's donors, or a scaled school. */
	invented: boolean;
};

/** A table of cells at one grain: periods `YYYY`, `YYYY-Qn`, `YYYY-MM` or `YYYY-MM-DD`. */
export type KpiTable = {
	periods: string[];
	series: Record<string, Cell[]>;
	/** Row order where the mockup sorts rows by value: per group (`donations_by_fund`), per period, the ids. */
	order?: Record<string, string[][]>;
	/** Month table only (mockup `dlt`): per money or count series, each cell's change against the month before, or
	 * null when either is not a figure or the month is the first. The UI prints it ("Same as May", "▼ $6 vs May");
	 * it never subtracts. */
	changes?: Record<string, Array<number | null>>;
};

/** A period of the Dashboard's strip: the audience's grain, its state as the period control has it, `open` for the
 * live audiences' open month. */
export type DocumentPeriod = {
	period: string;
	label: string;
	from: string;
	to: string;
	state: "shown" | "embargoed" | "future";
	title: string | null;
	open: boolean;
	/** Invented from 2026's months (the mockup's earlier years), not from atm's books. */
	invented: boolean;
};

export type KpiDocument = {
	school: string;
	source: { kind: "mart"; preset: string } | { kind: "events" };
	/** The badge: "Fixture data: invented" or "From this school's events". */
	dataSource: "fixture" | "events";
	audience: Audience;
	pinLocked: boolean;
	year: number;
	basis: "cash";
	/** ISO 4217, lower case (`usd`, `cad`, `eur`). */
	currency: string;
	/** The money symbol figures are written with (mockup `s.cur`): `$`, `C$`, `€`. */
	symbol: string;
	kpiSpecVersion: string;
	asOf: string;
	size: SchoolSize;
	/** Money rounding for this audience and school size, minor units; 0 is exact. */
	roundTo: number;
	live: boolean;
	cellRules: "on" | "breakdown and spread" | "off";
	/** The strip's grain. */
	grain: "year" | "quarter" | "month";
	periods: DocumentPeriod[];
	/** The caption (mockup `bkCaption`) by year of the selected period. */
	captions: Record<string, string>;
	/** No payment and no paying member in the year shown (mockup `dashFull`'s "No payments yet"); never for Public and
	 * Member. */
	empty: boolean;
	tables: Partial<Record<TableGrain, KpiTable>>;
	meta: Record<string, KpiMeta>;
	notComputed: Array<{ id: string; reason: string }>;
	notes: string[];
	verified: boolean;
};

/** What the Reader's `kpiDocument` is asked for: the school, the preset (fixture schools only), the audience the
 * route views (`resolveViewAs(...).option.audience`) and the PIN chip. */
export type KpiQuery = {
	school: string;
	preset: string;
	audience: Audience;
	pinLocked: boolean;
};

/** @deprecated The books levels of cell-rules v3, retired by the audiences of `disclosure.ts`; kept only while
 * `School.booksLevel` and S0's View as still read them (the S1b build moves them to `resolveViewAs`). */
export type BooksLevel =
	| "public"
	| "member"
	| "governance"
	| "finance_admin"
	| "owner";

export const cellKind = (cell: Cell): CellKind =>
	typeof cell === "number"
		? "number"
		: "lt" in cell
			? "lt"
			: "approx" in cell
				? "approx"
				: cell.hidden;
