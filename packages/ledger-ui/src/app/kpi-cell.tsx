import type { JSX } from "preact";
import {
	type Cell,
	cellKind,
	type KpiDocument,
	type KpiFormat,
	type TableGrain,
} from "../data/kpi-document.ts";

/** Intl formats by cell-rules `formats` (en-US), for figures that are not document cells (the money of a plan). */
const formatOptions: Record<KpiFormat, Intl.NumberFormatOptions> = {
	money: { style: "currency" },
	money0: {
		style: "currency",
		minimumFractionDigits: 0,
		maximumFractionDigits: 0,
	},
	integer: {},
	percent1: {
		style: "percent",
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	},
};
const numberFormats = new Map<string, Intl.NumberFormat>();
export function numberFormat(
	format: KpiFormat,
	currency: string,
): Intl.NumberFormat {
	const key = `${format}:${currency}`;
	const known = numberFormats.get(key);
	if (known) return known;
	const made = new Intl.NumberFormat("en-US", {
		...formatOptions[format],
		currency: currency.toUpperCase(),
	});
	numberFormats.set(key, made);
	return made;
}

const minorUnitsPerUnit = 100;
const decimals: Record<"money" | "money0", number> = { money: 2, money0: 0 };
const percent = 100;
/** The text a suppressed cell reads (cell-rules `labels.suppressed`); its reason is its title. */
export const suppressedText = "—";

/** A figure as the KPI document's contract writes it (`KpiFormat`): money with "−" (U+2212) for a negative and the
 * document's symbol, en-US grouping; a count as its plain number; a rate to one decimal. */
function figureText(value: number, format: KpiFormat, symbol: string): string {
	if (format === "integer") return String(value);
	if (format === "percent1") return `${(value * percent).toFixed(1)}%`;
	const digits = decimals[format];
	const units = Math.abs(value) / minorUnitsPerUnit;
	const written = (digits === 0 ? Math.round(units) : units).toLocaleString(
		"en-US",
		{ minimumFractionDigits: digits, maximumFractionDigits: digits },
	);
	return `${value < 0 ? "−" : ""}${symbol}${written}`;
}

const isMoney = (format: KpiFormat): boolean =>
	format === "money" || format === "money0";

/** A cell's text (the document's `meta` gives the format): a number, `<10` or "under $100" for `lt`, the rounded count
 * of `approx`, and for a hidden cell its own text, "—" when the cell rules suppress it. */
export function cellText(
	document: KpiDocument,
	kpi: string,
	cell: Cell,
): string {
	const format = document.meta[kpi]?.format ?? "integer";
	if (typeof cell === "number")
		return figureText(cell, format, document.symbol);
	if ("lt" in cell)
		return isMoney(format)
			? `under ${figureText(cell.lt, "money0", document.symbol)}`
			: `<${cell.lt}`;
	if ("approx" in cell) return String(cell.approx);
	return cell.hidden === "suppressed" ? suppressedText : cell.text;
}

/** Why a cell is not a plain figure, for its title. */
const cellWhy = (cell: Cell): string | undefined => {
	if (typeof cell === "number") return undefined;
	if ("hidden" in cell) return cell.text;
	return cell.why;
};

/** One document cell (protocol §3) of the table at `grain`: its KPI and period, its kind in `data-cell`, its text as
 * the contract writes it and why it is not a plain figure in its title. A KPI the table lacks is `not_computed`. */
export function KpiValue({
	document,
	grain,
	kpi,
	period,
	test,
}: {
	document: KpiDocument;
	grain: TableGrain;
	kpi: string;
	period: string;
	test?: string | undefined;
}): JSX.Element {
	const table = document.tables[grain];
	const index = table?.periods.indexOf(period) ?? -1;
	const cell: Cell = table?.series[kpi]?.[index] ?? {
		hidden: "not_computed",
		text: "Not computed",
	};
	const kind = cellKind(cell);
	return (
		<span
			data-test={test}
			data-kpi={kpi}
			data-period={period}
			data-cell={kind}
			class={kind === "suppressed" ? "kcutv" : undefined}
			title={cellWhy(cell)}
		>
			{cellText(document, kpi, cell)}
		</span>
	);
}
