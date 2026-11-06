import type { JSX } from "preact";
import {
	type Cell,
	cellKind,
	type HiddenKind,
	type KpiDocument,
	type KpiFormat,
} from "../data/kpi-document.ts";

/** cell-rules `formats`. */
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
const isMoney = (format: KpiFormat): boolean =>
	formatOptions[format].style === "currency";

/** What a cell needs to be written: its document and the Reader's text for each hidden kind. */
export type CellContext = {
	document: KpiDocument;
	labels: Record<HiddenKind, string>;
};

/** A cell as cell-rules writes it. */
export function cellText(
	{ document, labels }: CellContext,
	kpi: string,
	cell: Cell,
): string {
	const format = document.meta[kpi]?.format ?? "integer";
	if (typeof cell === "number")
		return numberFormat(format, document.currency).format(
			isMoney(format) ? cell / 100 : cell,
		);
	if ("lt" in cell)
		return isMoney(format)
			? `under ${numberFormat("money0", document.currency).format(cell.lt / 100)}`
			: `<${cell.lt}`;
	return labels[cell.hidden];
}

/** One document cell (protocol §3): its kind in `data-cell`, its text exactly as cell-rules writes it, and the reason
 * of a hidden cell in its title. */
export function KpiValue({
	context,
	kpi,
	index,
	test,
}: {
	context: CellContext;
	kpi: string;
	index: number;
	test?: string | undefined;
}): JSX.Element {
	const cell: Cell = context.document.series[kpi]?.[index] ?? {
		hidden: "not_computed",
	};
	const kind = cellKind(cell);
	const why = typeof cell === "object" && "hidden" in cell ? cell.why : null;
	return (
		<span
			data-test={test}
			data-kpi={kpi}
			data-period={context.document.periods[index]}
			data-cell={kind}
			class={kind === "suppressed" ? "kcutv" : undefined}
			title={why ? `Hidden: ${why}` : undefined}
		>
			{cellText(context, kpi, cell)}
		</span>
	);
}
