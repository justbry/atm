import type { ComponentChildren } from "preact";
import type { ReportCell } from "../data/ledger.ts";
import { smallCount } from "./books-pane.ts";
import { Icon } from "./icon.tsx";
import { suppressedText } from "./kpi-cell.tsx";
import { formatMoney } from "./money.ts";
import { monthName } from "./period.ts";

/** `7 Jan 2027`: the day a figure publishes (the books panes only, so it stays out of the first load). */
export const dayMonthYear = (isoDate: string): string =>
	`${Number(isoDate.slice(8))} ${monthName(isoDate)} ${isoDate.slice(0, 4)}`;

/** One figure of an audience's document (mockup `kFigHtml`): a number as money or a count, `under $100` or `<10` for a
 * figure the cell rules round, and for one that is not shown the reason, never a 0. */
export function Figure({
	cell,
	money,
	currency,
	whole,
	noun,
}: {
	cell: ReportCell;
	money: boolean;
	currency: string;
	whole: boolean;
	/** What a count under the minimum counts, for its title. */
	noun: string;
}): ComponentChildren {
	if (typeof cell === "number")
		return money ? formatMoney(cell, currency, whole) : String(cell);
	if ("lt" in cell)
		return money ? (
			`under ${formatMoney(cell.lt, currency, true)}`
		) : (
			<span
				class="kapprox"
				title={`Rounded to the nearest 10: fewer than ${smallCount} ${noun}`}
			>
				{`<${cell.lt}`}
			</span>
		);
	if ("approx" in cell)
		return (
			<span class="kapprox" title={cell.why}>
				{String(cell.approx)}
			</span>
		);
	if ("until" in cell) {
		const text = `Published after ${dayMonthYear(cell.until)}`;
		return (
			<span class="khid" data-hid="embargoed" title={text}>
				<Icon name="clock" />
				{text}
			</span>
		);
	}
	if ("who" in cell) {
		const text = `${cell.who} see this`;
		return (
			<span class="khid" data-hid={cell.hidden} title={text}>
				<Icon name="lock" />
				{text}
			</span>
		);
	}
	if (cell.hidden === "suppressed")
		return (
			<span class="kcutv" title={cell.text}>
				{suppressedText}
			</span>
		);
	return (
		<span class="khid" data-hid={cell.hidden} title={cell.text}>
			<Icon name="lock" />
			{cell.text}
		</span>
	);
}
