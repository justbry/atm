/**
 * The contributions view: for each KPI cell of a month, how many distinct holders contribute and how much of the cell the
 * largest one holds. It is what the cell rules need (spec: at least 5 holders, none above 60% of the cell) and nothing
 * else: counts and a share, never a holder key, a name, or an amount. `views/kpi/contributions/YYYY-MM.json`.
 *
 * The object form is `KpiContributions` of `kpi-document.ts` (S8b): `contributions` maps a cell id to the month to
 * `{ holders, largestShare }`, so a reader merges the months of a year by merging those maps. The cell types here are
 * structurally the same as S8b's `KpiContribution`.
 *
 * A cell is a base KPI of the spec (`kpis/school.v1.json`), `<kpiId>` or `<kpiId>:<dimension>`, for the month. Its
 * contributors are the holders (`event.key`) whose own events give the cell a nonzero amount, found by running the atm
 * channel on each holder's events alone, exactly as `contributionsFromEvents` (scenario/suppress.ts) does for the job and
 * test tooling. A cell nobody contributes to is absent: zero holders. Cells whose id names a holder, and the closing
 * credit balances, are left out (`isExportableKpiId`), as the KPI document leaves them out.
 *
 * `largestShare` is the largest contributor's share of the cell's absolute amount, 0 to 1, rounded UP to 6 decimals, so
 * the rule "dominant when the largest holder's amount times 1,000,000 exceeds the cell's times `maxShare` times
 * 1,000,000" is `largestShare > maxShare` exactly (for a `maxShare` in whole millionths): 0.6 is 0.6. A cell with
 * holders and an amount of 0 (offsetting signs) cannot be tested for dominance and is 1, which is dominant.
 *
 * `quarter` is for a school too small for a monthly document (under 10 active payers), whose cells are quarterly: a
 * quarter's holders are not the sum of its months', so the quarter is aggregated from the holders (a cumulative balance
 * takes the last month, a distinct count is the union of holders) and only then reduced to counts. It is written on the
 * quarter's last month, and on the last month of the log (a quarter still open): its cells are that quarter to date,
 * keyed by the quarter (`2026-Q2`) where the month's are keyed by month.
 *
 * Pure and Worker-safe: no Ajv (the spec is the committed JSON, typed, not validated at run time; a test checks it equals
 * the validated one), no `node:fs`.
 */
import schoolSpec from "../../kpis/school.v1.json";
import { atmChannel } from "../scenario/channels/atm.js";
import type { KpiSpec } from "../scenario/kpi-evaluate.js";
import {
	aggregateShares,
	type Contributions,
	isExportableKpiId,
	quarterOf,
	type Shares,
} from "../scenario/suppress-core.js";
import type { AtmEvent } from "../types.js";
import { byText } from "./order.js";

/** The committed school KPI spec, as data. `scenario/kpis.ts` has the same one, checked against its schema with Ajv. */
export const SCHOOL_KPI_SPEC = schoolSpec as unknown as KpiSpec;

const MICRO = 1_000_000n;

/** Each holder's amount per cell and month: the atm channel run on each holder's events alone (as `contributionsFromEvents` does). */
const sharesOfHolders = (
	groups: Map<string, AtmEvent[]>,
	spec: KpiSpec,
	periods: readonly string[],
): Contributions => {
	const out: Contributions = {};
	for (const [holder, events] of groups)
		for (const [id, byPeriod] of Object.entries(
			atmChannel.base({ events, spec, periods }),
		))
			for (const [period, n] of Object.entries(byPeriod)) {
				if (n === 0) continue;
				const byPeriodOut = out[id] ?? {};
				out[id] = byPeriodOut;
				const shares = byPeriodOut[period] ?? {};
				byPeriodOut[period] = shares;
				shares[holder] = n;
			}
	return out;
};
const MONTHS_PER_QUARTER = 3;

/** One cell: how many holders contribute, and the largest one's share of the cell (0 to 1, rounded up to 6 decimals). */
export type ContributionCell = { holders: number; largestShare: number };

/** Cell id to period (a month, or a quarter in `quarter`) to the cell. */
export type CellContributions = Record<
	string,
	Record<string, ContributionCell>
>;

/** A contributions month object. */
export type ContributionsObject = {
	school: string;
	month: string;
	/** The month's cells: id to `{ [month]: cell }`, ids sorted. */
	contributions: CellContributions;
	/** Present on the last month of a quarter and on the log's last month: the quarter to date (`2026-Q2`). */
	quarter?: { period: string; contributions: CellContributions };
};

/** A contributions month without the school and month its object adds. */
export type ContributionsView = Omit<ContributionsObject, "school" | "month">;

const cellOf = (shares: Shares): ContributionCell | null => {
	const amounts = Object.values(shares).filter((n) => n !== 0);
	if (amounts.length === 0) return null;
	let total = 0n;
	let largest = 0n;
	for (const n of amounts) {
		total += BigInt(n);
		const magnitude = BigInt(Math.abs(n));
		if (magnitude > largest) largest = magnitude;
	}
	const absoluteTotal = total < 0n ? -total : total;
	const micro =
		absoluteTotal === 0n
			? MICRO
			: (largest * MICRO + absoluteTotal - 1n) / absoluteTotal;
	return {
		holders: amounts.length,
		largestShare: Number(micro) / Number(MICRO),
	};
};

const cellsOf = (
	contributions: Contributions,
	period: string,
): CellContributions => {
	const cells: CellContributions = {};
	for (const id of Object.keys(contributions).sort(byText)) {
		const cell = cellOf(contributions[id]?.[period] ?? {});
		if (cell !== null) cells[id] = { [period]: cell };
	}
	return cells;
};

const monthNumber = (month: string): number =>
	Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

const monthName = (index: number): string =>
	`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;

/** Every month from the first to the last, none left out: the atm channel carries a cumulative balance across them. */
const monthRange = (first: string, last: string): string[] =>
	Array.from({ length: monthNumber(last) - monthNumber(first) + 1 }, (_, i) =>
		monthName(monthNumber(first) + i),
	);

/** The months of `month`'s quarter, from the quarter's first up to `month`. */
const quarterToDate = (month: string): string[] => {
	const index = monthNumber(month);
	const offset = (index % 12) % MONTHS_PER_QUARTER;
	return Array.from({ length: offset + 1 }, (_, i) =>
		monthName(index - offset + i),
	);
};

const isQuarterEnd = (month: string): boolean =>
	Number(month.slice(5, 7)) % MONTHS_PER_QUARTER === 0;

/**
 * The contributions views of a log: one per month any event falls in, by `YYYY-MM` ascending. `events` are one cut of
 * the log (`buildViews` passes the events up to `asOf`). `spec` defaults to the school KPI spec.
 */
export const buildContributions = (
	events: readonly AtmEvent[],
	spec: KpiSpec = SCHOOL_KPI_SPEC,
): Record<string, ContributionsView> => {
	const months = [
		...new Set(events.map((event) => event.date.slice(0, 7))),
	].sort(byText);
	const first = months[0];
	const last = months.at(-1);
	if (first === undefined || last === undefined) return {};
	const byHolder = new Map<string, AtmEvent[]>();
	for (const event of events) {
		const own = byHolder.get(event.key);
		if (own) own.push(event);
		else byHolder.set(event.key, [event]);
	}
	const all = sharesOfHolders(byHolder, spec, monthRange(first, last));
	const contributions: Contributions = {};
	for (const [id, byPeriod] of Object.entries(all))
		if (isExportableKpiId(id)) contributions[id] = byPeriod;
	const out: Record<string, ContributionsView> = {};
	for (const month of months) {
		const view: ContributionsView = {
			contributions: cellsOf(contributions, month),
		};
		if (isQuarterEnd(month) || month === last) {
			const period = quarterOf(month);
			const merged = aggregateShares({
				contributions,
				spec,
				months: new Map([[period, quarterToDate(month)]]),
			});
			view.quarter = { period, contributions: cellsOf(merged, period) };
		}
		out[month] = view;
	}
	return out;
};

/** Whether the cell rules show a cell: `minContributors` holders at least, and the largest holding `maxShare` of it at most. The verdict `suppressKpis` reaches from the same cell. */
export const cellPasses = (
	cell: ContributionCell | undefined,
	rules: { minContributors: number; maxShare: number },
): boolean => {
	if (cell === undefined) return false;
	const micro = (share: number) => Math.round(share * Number(MICRO));
	return (
		cell.holders >= rules.minContributors &&
		micro(cell.largestShare) <= micro(rules.maxShare)
	);
};
