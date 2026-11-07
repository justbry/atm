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

/** A figure of an audience's document as text, the one reading of its cases that the page and the CSV both use: its
 * `value` (empty when it is hidden), and the `hidden` reason (empty when it is shown). */
export function cellText(
	cell: ReportCell,
	money: boolean,
	currency: string,
	whole: boolean,
): { value: string; hidden: string } {
	if (typeof cell === "number")
		return {
			value: money ? formatMoney(cell, currency, whole) : String(cell),
			hidden: "",
		};
	if ("lt" in cell)
		return {
			value: money
				? `under ${formatMoney(cell.lt, currency, true)}`
				: `<${cell.lt}`,
			hidden: "",
		};
	if ("approx" in cell) return { value: String(cell.approx), hidden: "" };
	if ("until" in cell)
		return {
			value: "",
			hidden: `Published after ${dayMonthYear(cell.until)}`,
		};
	if ("who" in cell) return { value: "", hidden: `${cell.who} see this` };
	return {
		value: cell.hidden === "suppressed" ? suppressedText : "",
		hidden: cell.text,
	};
}

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
	const { value, hidden } = cellText(cell, money, currency, whole);
	if (typeof cell === "number") return value;
	if ("lt" in cell)
		return money ? (
			value
		) : (
			<span
				class="kapprox"
				title={`Rounded to the nearest 10: fewer than ${smallCount} ${noun}`}
			>
				{value}
			</span>
		);
	if ("approx" in cell)
		return (
			<span class="kapprox" title={cell.why}>
				{value}
			</span>
		);
	if ("until" in cell)
		return (
			<span class="khid" data-hid="embargoed" title={hidden}>
				<Icon name="clock" />
				{hidden}
			</span>
		);
	if ("who" in cell)
		return (
			<span class="khid" data-hid={cell.hidden} title={hidden}>
				<Icon name="lock" />
				{hidden}
			</span>
		);
	if (cell.hidden === "suppressed")
		return (
			<span class="kcutv" title={cell.text}>
				{value}
			</span>
		);
	return (
		<span class="khid" data-hid={cell.hidden} title={cell.text}>
			<Icon name={cell.hidden === "embargoed" ? "clock" : "lock"} />
			{hidden}
		</span>
	);
}
