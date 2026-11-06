import { type ComponentChildren, Fragment, type JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
	type Audience,
	audienceNames,
	audiences,
	type LockPanel as Lock,
} from "../data/disclosure.ts";
import {
	type Cell,
	cellKind,
	type DocumentPeriod,
	type HiddenKind,
	type KpiDocument,
	type TableGrain,
} from "../data/kpi-document.ts";
import type { Preset } from "../data/types.ts";
import type { BooksPaneProps } from "./books-pane.ts";
import { Icon, type IconName } from "./icon.tsx";
import { cellText, figureText, notComputedCell } from "./kpi-cell.tsx";
import { monthName, type Period, parsePeriod } from "./period.ts";
import { PinLock } from "./pin-lock.tsx";
import { withQuery } from "./route.ts";
import { keepLoading } from "./use-loaded.ts";
import { useViewing } from "./viewing.ts";

/** The mockup's four fixture scenarios (its `Fixture scenario` segmented control) come first in the Reader's list; the
 * other presets of the mart sit in one select beside them. */
const featuredScenarios = 4;

type DashboardView = "money" | "members" | "risk";
type ViewOption = { id: DashboardView; label: string; icon: IconName };
const views: [ViewOption, ...ViewOption[]] = [
	{ id: "money", label: "Money", icon: "coin" },
	{ id: "members", label: "Members", icon: "users" },
	{ id: "risk", label: "Risk", icon: "alert" },
];
const chartColors = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
] as const;
const [firstColor, secondColor, thirdColor, , fifthColor] = chartColors;
const grossColor = "rgba(138, 138, 150, 0.5)";
/** The mockup's tones and "Needs a look": a refund rate over 10% or 3 disputes or more; over 20% or 5 is severe. */
const refundRateBad = 0.1;
const refundRateWarn = 0.05;
const refundRateSevere = 0.2;
const disputesBad = 3;
const disputesSevere = 5;
const chartWidth = 600;
const dayChartWidth = 1200;
const dayChartHeight = 64;
const dayLabelEvery = 5;
const openMonthTitle = "Open month: live, can still change";
/** A suppressed cell's text is "Hidden: <why>"; its reason line names the row before the why. */
const hiddenPrefix = /^Hidden: /;
/** The hidden kinds that keep a figure from an audience: their cells say why, with the clock or the lock. */
const withheldKinds = new Set<HiddenKind>([
	"embargoed",
	"members_only",
	"no_grant",
]);

const grainOf = (period: string): TableGrain => {
	if (/^\d{4}$/.test(period)) return "year";
	if (/-Q\d$/.test(period)) return "quarter";
	if (/^\d{4}-\d{2}$/.test(period)) return "month";
	return "day";
};
/** `Jun` for a month, `Q2 2026` for a quarter, `2024` for a year. */
function periodName(period: string): string {
	const [year = "", part] = period.split("-");
	if (part === undefined) return year;
	if (part.startsWith("Q")) return `${part} ${year}`;
	return monthName(`${period}-01`);
}
/** "A", "A and B", "A, B and C". */
function namesList(names: string[]): string {
	const last = names.at(-1) ?? "";
	return names.length < 2
		? last
		: `${names.slice(0, -1).join(", ")} and ${last}`;
}

/** What every part of the pane reads: the document, the strip period on screen, and how to open a period. */
type Books = {
	document: KpiDocument;
	selected: DocumentPeriod;
	choose: (period: string) => void;
};

/** The year table's sum of the four rounded quarters, which the Member's year note names. */
const quartersKpi = "gross_collected_rounded_quarters";

/** The cell of a KPI in a period, from the table of that period's grain; undefined when the document has none. */
function cellAt(
	document: KpiDocument,
	kpi: string,
	period: string,
): Cell | undefined {
	const table = document.tables[grainOf(period)];
	const index = table?.periods.indexOf(period) ?? -1;
	return index < 0 ? undefined : table?.series[kpi]?.[index];
}
/** The cell's number, or null: a band or a hidden cell is never drawn, and never as 0. */
function numberAt(
	document: KpiDocument,
	kpi: string,
	period: string,
): number | null {
	const cell = cellAt(document, kpi, period);
	return typeof cell === "number" ? cell : null;
}
const seriesStartingWith = (
	document: KpiDocument,
	grain: TableGrain,
	prefix: string,
): string[] =>
	Object.keys(document.tables[grain]?.series ?? {}).filter((kpi) =>
		kpi.startsWith(prefix),
	);
/** The periods of a table that fall in the selected period's year; every year for the year table. */
function periodsOf(books: Books, grain: TableGrain): string[] {
	const year = books.selected.period.slice(0, 4);
	return (books.document.tables[grain]?.periods ?? []).filter(
		(period) => grain === "year" || period.startsWith(`${year}-`),
	);
}

/** One document cell (protocol §3): its kind in `data-cell`, its text exactly as the mockup writes it, and its reason
 * in the title: a hidden cell its text, a rounded count "Rounded to the nearest 10: <why>". A cell shown a second time
 * (the donor rows under the donor line) is not `marked` again. */
function Value({
	books,
	kpi,
	period = books.selected.period,
	test,
	marked = true,
}: {
	books: Books;
	kpi: string;
	period?: string;
	test?: string;
	marked?: boolean;
}): JSX.Element {
	const { document } = books;
	const cell = cellAt(document, kpi, period) ?? notComputedCell;
	const shared = marked
		? {
				"data-test": test,
				"data-kpi": kpi,
				"data-period": period,
				"data-cell": cellKind(cell),
			}
		: {};
	const text = cellText(document, kpi, cell);
	if (typeof cell === "number") return <span {...shared}>{text}</span>;
	if ("hidden" in cell) {
		if (cell.hidden === "suppressed")
			return (
				<span {...shared} class="kcutv" title={cell.text}>
					{text}
				</span>
			);
		if (withheldKinds.has(cell.hidden))
			return (
				<span {...shared} class="khid" data-hid={cell.hidden} title={cell.text}>
					<Icon name={cell.hidden === "embargoed" ? "clock" : "lock"} />
					{text}
				</span>
			);
		return <span {...shared}>{text}</span>;
	}
	if (cell.why)
		return (
			<span
				{...shared}
				class="kapprox"
				title={`Rounded to the nearest 10: ${cell.why}`}
			>
				{text}
			</span>
		);
	return <span {...shared}>{text}</span>;
}

type Tone = "ok" | "warn" | "bad" | "";
function refundTone(rate: number | null): Tone {
	if (rate === null) return "";
	if (rate > refundRateBad) return "bad";
	if (rate > refundRateWarn) return "warn";
	return "ok";
}
function disputeTone(disputes: number | null): Tone {
	if (disputes === null) return "";
	if (disputes >= disputesBad) return "bad";
	if (disputes >= 1) return "warn";
	return "ok";
}
/** The month's dispute cost in minor units, as the mockup tones it: over $50 bad, any cost a warning. */
const disputeCostBad = 5000;
function disputeCostTone(cost: number | null): Tone {
	if (cost === null) return "";
	if (cost > disputeCostBad) return "bad";
	return cost > 0 ? "warn" : "ok";
}
/** A card whose figure is withheld says why instead of its line (mockup `kcard`). */
function withheldLine(cell: Cell | undefined): string | null {
	if (cell === undefined || typeof cell === "number" || !("hidden" in cell))
		return null;
	if (cell.hidden === "suppressed") return cell.text;
	if (cell.hidden === "embargoed") return "Inside its delay";
	if (withheldKinds.has(cell.hidden)) return "Not in this document";
	return null;
}

/** A card (mockup `kcard`): one value cell, dashed when it is withheld, and then its reason takes the place of the
 * sub-line, once. */
function Card({
	books,
	label,
	kpi,
	tone = "",
	children,
}: {
	books: Books;
	label: string;
	kpi: string;
	tone?: Tone;
	children?: ComponentChildren;
}): JSX.Element {
	const withheld = withheldLine(
		cellAt(books.document, kpi, books.selected.period),
	);
	return (
		<div
			class={`kcard ${withheld === null ? tone : "kcut"}`.trim()}
			data-test="kpi-card"
			data-k={kpi}
		>
			<small data-test="kpi-label">{label}</small>
			<b>
				<Value books={books} kpi={kpi} test="kpi-value" />
			</b>
			<i>{withheld ?? children}</i>
		</div>
	);
}

/** The sub-line of a month card (mockup `dlt`): "First month", "Same as May", or "▲ $6 vs May" with the change the
 * document carries (`KpiTable.changes`); the UI subtracts nothing. A change that is no figure says nothing. */
function Change({
	books,
	kpi,
}: {
	books: Books;
	kpi: string;
}): ComponentChildren {
	const { document, selected } = books;
	const table = document.tables.month;
	const index = table?.periods.indexOf(selected.period) ?? -1;
	if (!table || index < 0) return null;
	if (index === 0) return "First month";
	const change = table.changes?.[kpi]?.[index];
	if (change === undefined || change === null) return null;
	const before = monthName(`${table.periods[index - 1]}-01`);
	if (change === 0) return `Same as ${before}`;
	const format =
		document.meta[kpi]?.format === "integer" ? "integer" : "money0";
	return `${change > 0 ? "▲" : "▼"} ${figureText(Math.abs(change), format, document.symbol)} vs ${before}`;
}

function Legend({
	items,
}: {
	items: Array<[name: string, color: string]>;
}): JSX.Element {
	return (
		<span class="kleg">
			{items.map(([name, color]) => (
				<span key={name}>
					<i style={{ background: color }} />
					{name}
				</span>
			))}
		</span>
	);
}

/** The month labels under a chart, as HTML so they keep their size when the chart scales. */
function Axis({
	books,
	periods,
}: {
	books: Books;
	periods: string[];
}): JSX.Element {
	return (
		<div
			class="kax"
			aria-hidden="true"
			style={{ gridTemplateColumns: `repeat(${periods.length}, 1fr)` }}
		>
			{periods.map((period) => (
				<span
					key={period}
					class={period === books.selected.period ? "on" : undefined}
				>
					{periodName(period)}
				</span>
			))}
		</div>
	);
}

type ChartSeries = { kpi: string; name: string; color: string };

/** A column per month with its cells in the tooltip ("not shown yet" for a cell that is no number); the selected
 * month's column is shaded. */
function Column({
	books,
	period,
	position,
	width,
	height,
	series,
}: {
	books: Books;
	period: string;
	position: number;
	width: number;
	height: number;
	series: ChartSeries[];
}): JSX.Element {
	const { document } = books;
	const cells = series.map(({ kpi, name }) => {
		const cell = cellAt(document, kpi, period);
		return `${name} ${typeof cell === "number" ? cellText(document, kpi, cell) : "not shown yet"}`;
	});
	return (
		<rect
			class={period === books.selected.period ? "col on" : "col"}
			x={position * width}
			y={0}
			width={width}
			height={height}
		>
			<title>{`${periodName(period)}: ${cells.join(" · ")}`}</title>
		</rect>
	);
}

/** Grouped bars per month (mockup `kbars`), scaled to the largest number shown. */
function Bars({
	books,
	series,
}: {
	books: Books;
	series: ChartSeries[];
}): JSX.Element {
	const height = 110;
	const periods = periodsOf(books, "month");
	const columnWidth = chartWidth / periods.length;
	const barWidth = (columnWidth * 0.72) / series.length;
	const values = series.map(({ kpi }) =>
		periods.map((period) => numberAt(books.document, kpi, period)),
	);
	const largest = Math.max(
		1,
		...values.flat().filter((value) => value !== null),
	);
	return (
		<>
			<svg
				class="kc"
				viewBox={`0 0 ${chartWidth} ${height}`}
				role="img"
				aria-label={namesList(series.map(({ name }) => name))}
			>
				{periods.map((period, index) => (
					<g key={period}>
						<Column
							books={books}
							period={period}
							position={index}
							width={columnWidth}
							height={height}
							series={series}
						/>
						{series.map(({ kpi, color }, position) => {
							const value = values[position]?.[index] ?? null;
							if (value === null) return null;
							const barHeight = (Math.max(0, value) / largest) * height;
							return (
								<rect
									key={kpi}
									x={
										index * columnWidth +
										columnWidth * 0.14 +
										position * barWidth
									}
									y={height - barHeight}
									width={Math.max(1, barWidth - 1)}
									height={barHeight}
									rx={2}
									fill={color}
									pointer-events="none"
								/>
							);
						})}
					</g>
				))}
			</svg>
			<Axis books={books} periods={periods} />
		</>
	);
}

/** A line through the months' numbers (mockup `kline`), with an optional dashed threshold. */
function Line({
	books,
	kpi,
	name,
	color,
	smallestTop,
	threshold,
}: {
	books: Books;
	kpi: string;
	name: string;
	color: string;
	smallestTop: number;
	threshold?: number;
}): JSX.Element {
	const height = 100;
	const periods = periodsOf(books, "month");
	const columnWidth = chartWidth / periods.length;
	const values = periods.map((period) => numberAt(books.document, kpi, period));
	const top = Math.max(
		smallestTop,
		threshold ?? 0,
		...values.filter((value) => value !== null),
	);
	const x = (index: number): number => index * columnWidth + columnWidth / 2;
	const y = (value: number): number =>
		height - (value / top) * (height - 10) - 2;
	const points = values.flatMap((value, index) =>
		value === null ? [] : [`${x(index)},${y(value)}`],
	);
	return (
		<>
			<div class="kcs">
				<svg
					class="kc"
					viewBox={`0 0 ${chartWidth} ${height}`}
					role="img"
					aria-label={name}
				>
					{periods.map((period, index) => (
						<Column
							key={period}
							books={books}
							period={period}
							position={index}
							width={columnWidth}
							height={height}
							series={[{ kpi, name, color }]}
						/>
					))}
					{threshold !== undefined && (
						<line
							x1={0}
							x2={chartWidth}
							y1={y(threshold)}
							y2={y(threshold)}
							stroke="var(--warning)"
							stroke-dasharray="4 3"
						/>
					)}
					<polyline
						fill="none"
						stroke={color}
						stroke-width={2}
						points={points.join(" ")}
						pointer-events="none"
					/>
					{values.map((value, index) => {
						const period = periods[index] ?? "";
						const selected = period === books.selected.period;
						return value === null ? null : (
							<circle
								key={period}
								cx={x(index)}
								cy={y(value)}
								r={selected ? 4.5 : 2.5}
								fill={selected ? "var(--foreground)" : color}
								pointer-events="none"
							/>
						);
					})}
				</svg>
				{threshold !== undefined && (
					<span
						class="kthr"
						style={{ top: `${(y(threshold) / height) * 100}%` }}
					>
						{cellText(books.document, kpi, threshold)}
					</span>
				)}
			</div>
			<Axis books={books} periods={periods} />
		</>
	);
}

/** Gross per day of the selected month (mockup `kdays`): a day that is no number is a low grey stub, never a 0 bar.
 * Each day carries its cell's kind and, for a number, its value. */
function Days({ books }: { books: Books }): JSX.Element | null {
	const { document, selected } = books;
	const days = document.tables.day;
	if (!days) return null;
	const month = monthName(selected.from);
	const inMonth = days.periods.flatMap((day, index) => {
		const cell = days.series.gross_collected?.[index];
		return day.startsWith(`${selected.period}-`) && cell !== undefined
			? [{ day, cell }]
			: [];
	});
	const columnWidth = dayChartWidth / inMonth.length;
	const largest = Math.max(
		1,
		...inMonth.flatMap(({ cell }) => (typeof cell === "number" ? [cell] : [])),
	);
	return (
		<>
			<svg
				class="kc"
				viewBox={`0 0 ${dayChartWidth} ${dayChartHeight}`}
				role="img"
				aria-label={`Gross by day, ${selected.label}`}
			>
				{inMonth.map(({ day, cell }, position) => {
					const shared = {
						"data-kpi": "gross_collected",
						"data-day": day,
						"data-cell": cellKind(cell),
						x: position * columnWidth + 1,
						width: columnWidth - 2,
						rx: 2,
					};
					const label = `${month} ${Number(day.slice(8))}`;
					if (typeof cell !== "number")
						return (
							<rect
								key={day}
								{...shared}
								y={dayChartHeight - 10}
								height={10}
								fill="var(--border)"
								opacity={0.4}
							>
								<title>{`${label}: not yet`}</title>
							</rect>
						);
					const barHeight = (cell / largest) * dayChartHeight;
					return (
						<rect
							key={day}
							{...shared}
							data-value={cell}
							y={dayChartHeight - barHeight}
							height={barHeight}
							fill={firstColor}
						>
							<title>{`${label}: ${cellText(document, "gross_collected", cell)}`}</title>
						</rect>
					);
				})}
			</svg>
			<div class="kaxd" aria-hidden="true">
				{inMonth.map(({ day }, position) =>
					position % dayLabelEvery === 0 || position === inMonth.length - 1 ? (
						<span
							key={day}
							style={{
								left: `${(((position + 0.5) * columnWidth) / dayChartWidth) * 100}%`,
							}}
						>
							{Number(day.slice(8))}
						</span>
					) : null,
				)}
			</div>
		</>
	);
}

/** The reason line under a breakdown (mockup `kwhyHtml`): "<row>: <why>" for every row the cell rules hid or
 * rounded. */
function Reasons({
	books,
	kpis,
}: {
	books: Books;
	kpis: string[];
}): JSX.Element | null {
	const { document, selected } = books;
	const reasons = kpis.flatMap((kpi) => {
		const cell = cellAt(document, kpi, selected.period);
		const title = document.meta[kpi]?.title;
		if (cell === undefined || typeof cell === "number") return [];
		if ("hidden" in cell)
			return cell.hidden === "suppressed"
				? [`${title}: ${cell.text.replace(hiddenPrefix, "")}`]
				: [];
		return cell.why ? [`${title}: ${cell.why}`] : [];
	});
	if (reasons.length === 0) return null;
	return (
		<div class="kwhy" data-test="kpi-why">
			<Icon name="lock" />
			<span>{reasons.join(" · ")}</span>
		</div>
	);
}

/** Rows of one period's breakdown (plans, funds, donor sizes), then the reason of every row the rules hid. */
function Breakdown({
	books,
	kpis,
	marked = true,
}: {
	books: Books;
	kpis: string[];
	marked?: boolean;
}): JSX.Element {
	const { document, selected } = books;
	const values = kpis.map((kpi) => numberAt(document, kpi, selected.period));
	const largest = Math.max(1, ...values.filter((value) => value !== null));
	return (
		<>
			{kpis.map((kpi, index) => {
				const title = document.meta[kpi]?.title;
				const value = values[index] ?? null;
				return (
					<div class="krow" key={kpi}>
						<span title={title}>{title}</span>
						<div class="t">
							{value !== null && (
								<i
									style={{
										width: `${(Math.max(0, value) / largest) * 100}%`,
										background: chartColors[index % chartColors.length],
									}}
								/>
							)}
						</div>
						<b>
							<Value books={books} kpi={kpi} marked={marked} />
						</b>
					</div>
				);
			})}
			<Reasons books={books} kpis={kpis} />
		</>
	);
}

/** One row per period of a KPI at its own grain (`meta.every`) over the selected period's year (every year for a
 * yearly KPI): mockup `dashAgg` `series`. A period inside its delay is hatched. */
function SeriesRows({
	books,
	kpi,
}: {
	books: Books;
	kpi: string;
}): JSX.Element {
	const { document, selected } = books;
	const every = document.meta[kpi]?.every ?? document.grain;
	const periods = periodsOf(books, every);
	const values = periods.map((period) => numberAt(document, kpi, period));
	const largest = Math.max(1, ...values.filter((value) => value !== null));
	return (
		<>
			{periods.map((period, index) => {
				const value = values[index] ?? null;
				const cell = cellAt(document, kpi, period);
				const embargoed = cell !== undefined && cellKind(cell) === "embargoed";
				const rowClass =
					value === null
						? embargoed
							? "krow kp kwait"
							: "krow kp"
						: period === selected.period
							? "krow kp kon"
							: "krow kp";
				return (
					<div class={rowClass} key={period}>
						<span>{periodName(period)}</span>
						<div class="t">
							{value !== null && (
								<i
									style={{
										width: `${(Math.max(0, value) / largest) * 100}%`,
										background: firstColor,
									}}
								/>
							)}
						</div>
						<b>
							<Value books={books} kpi={kpi} period={period} />
						</b>
					</div>
				);
			})}
		</>
	);
}

/** "<title> by <grain>": the heading of a series. */
const seriesHeading = (
	document: KpiDocument,
	kpi: string,
	title: string,
): string => `${title} by ${document.meta[kpi]?.every ?? document.grain}`;

/** The "By plan or fund" row below Governance (mockup `dashAgg`): the label, an empty track and the small lock figure
 * saying who sees it, like a hidden card. */
function PlanLock({ lock }: { lock: Lock }): JSX.Element {
	return (
		<div
			class="krow"
			data-test="lock-panel"
			data-surface="dashboard-plan"
			data-lock={lock.reason}
		>
			<span>By plan or fund</span>
			<div class="t" />
			<b>
				<span class="khid" data-hid={lock.reason} title={lock.who}>
					<Icon name="lock" />
					<span data-test="lock-who">{lock.who}</span>
				</span>
			</b>
		</div>
	);
}

/** Public and Member (mockup `dashAgg`): the period's cards, then each KPI's series at its own grain. Below
 * Governance the plan breakdown is the row's lock panel. */
function AggregateBody({
	books,
	view,
	creditsName,
	planLock,
	fewerThan,
}: {
	books: Books;
	view: DashboardView;
	creditsName: string;
	planLock: Lock | undefined;
	fewerThan: number | null;
}): JSX.Element {
	const { document, selected } = books;
	const { label } = selected;
	if (view === "money") {
		const kinds = seriesStartingWith(
			document,
			grainOf(selected.period),
			"revenue_by_kind:",
		);
		const year = selected.period.slice(0, 4);
		const yearTotal =
			document.grain === "quarter" &&
			document.tables.year?.periods.includes(year);
		const yearNote =
			yearTotal && typeof cellAt(document, quartersKpi, year) === "number";
		return (
			<>
				<div class="kcards">
					<Card books={books} label="Gross collected" kpi="gross_collected">
						{document.roundTo > 0
							? `${label}, rounded to ${figureText(document.roundTo, "money0", document.symbol)}`
							: label}
					</Card>
					<Card books={books} label="Refunds" kpi="refunds">
						<Value books={books} kpi="refund_rate" /> of gross
					</Card>
					<Card books={books} label="Payment fees" kpi="stripe_fees">
						in {label}
					</Card>
					<Card books={books} label="Net income" kpi="net_income" tone="ok">
						Rounded on its own
					</Card>
					<Card books={books} label="Paid out" kpi="payouts">
						Lands the month after
					</Card>
				</div>
				<div class="kgrid">
					<div class="kbox">
						<h6>{seriesHeading(document, "gross_collected", "Gross")}</h6>
						<SeriesRows books={books} kpi="gross_collected" />
						{yearTotal && (
							<>
								<div class="krow kyear" data-year={year}>
									<span>
										<b>{year} total</b>
									</span>
									<div class="t" />
									<b>
										<Value books={books} kpi="gross_collected" period={year} />
									</b>
								</div>
								{yearNote && (
									<p class="mut kyearnote" data-test="year-note">
										The four rounded quarters add up to{" "}
										<Value books={books} kpi={quartersKpi} period={year} />
										{"; the year is rounded from its own events."}
									</p>
								)}
							</>
						)}
						{!yearNote && (
							<div class="mut kfoot">
								Each period is rounded on its own, so a year is not the sum of
								its rounded quarters.
							</div>
						)}
					</div>
					<div class="kbox">
						<h6>Income by kind, {label}</h6>
						{kinds.length > 0 ? (
							<Breakdown books={books} kpis={kinds} />
						) : (
							<div class="mut">No income in this period.</div>
						)}
						{planLock && <PlanLock lock={planLock} />}
						<div class="mut kfoot">
							Names show to finance admins and the owner only.
						</div>
					</div>
				</div>
			</>
		);
	}
	if (view === "members")
		return (
			<>
				<div class="kcards">
					<Card books={books} label="Paying members" kpi="paying_members">
						most in one month of {label}
					</Card>
					<Card books={books} label="New paying" kpi="new_paying_members">
						first payment in {label}
					</Card>
					<Card books={books} label="Avg per paying member" kpi="arpa">
						in {label}
					</Card>
					<Card
						books={books}
						label={`${creditsName} used`}
						kpi="credits_consumed"
					>
						<Value books={books} kpi="credits_granted" /> granted ·{" "}
						<Value books={books} kpi="credits_expired" /> expired
					</Card>
				</div>
				<div class="kgrid">
					<div class="kbox">
						<h6>
							{seriesHeading(document, "paying_members", "Paying members")}
						</h6>
						<SeriesRows books={books} kpi="paying_members" />
						<div class="mut kfoot">
							Counts of people.
							{fewerThan !== null &&
								` Under ${fewerThan} payers a count shows as <10 or to the nearest 10, never 0.`}
						</div>
					</div>
					<div class="kbox">
						<h6>
							{seriesHeading(
								document,
								"credits_consumed",
								`${creditsName} used`,
							)}
						</h6>
						<SeriesRows books={books} kpi="credits_consumed" />
					</div>
				</div>
			</>
		);
	return (
		<>
			<div class="kcards">
				<Card books={books} label="Refund rate" kpi="refund_rate">
					<Value books={books} kpi="refunds" /> refunded
				</Card>
				<Card books={books} label="Disputes opened" kpi="disputes_opened">
					in {label}
				</Card>
				<Card books={books} label="Dispute cost" kpi="dispute_cost">
					lost + fees
				</Card>
				<Card books={books} label="Net income" kpi="net_income">
					after refunds and fees
				</Card>
			</div>
			<div class="kgrid">
				<div class="kbox">
					<h6>{seriesHeading(document, "refunds", "Refunds")}</h6>
					<SeriesRows books={books} kpi="refunds" />
				</div>
				<div class="kbox">
					<h6>
						{seriesHeading(document, "gross_collected", "Gross")} (the base for
						refund and dispute rates)
					</h6>
					<SeriesRows books={books} kpi="gross_collected" />
				</div>
			</div>
		</>
	);
}

/** "Needs a look" (mockup Risk): the months with a refund rate over 10% or 3 disputes or more. */
function Flags({ books }: { books: Books }): JSX.Element {
	const { document } = books;
	const flags = periodsOf(books, "month").flatMap((period) => {
		const rate = numberAt(document, "refund_rate", period);
		const disputes = numberAt(document, "disputes_opened", period);
		const highRate = rate !== null && rate > refundRateBad;
		const manyDisputes = disputes !== null && disputes >= disputesBad;
		if (!highRate && !manyDisputes) return [];
		const severe =
			(highRate && rate > refundRateSevere) ||
			(manyDisputes && disputes >= disputesSevere);
		return [
			<div class="kflag" data-test="dash-flag" key={period}>
				<span class={severe ? "kdot kd-bad" : "kdot kd-warn"} />
				<span>{periodName(period)}</span>
				<span class="mut">
					{highRate && (
						<>
							Refund rate{" "}
							<Value books={books} kpi="refund_rate" period={period} />
						</>
					)}
					{highRate && manyDisputes && " · "}
					{manyDisputes && (
						<>
							<Value books={books} kpi="disputes_opened" period={period} />{" "}
							disputes
						</>
					)}
				</span>
				<span>
					<button
						type="button"
						class="link"
						onClick={() => books.choose(period)}
					>
						Show ›
					</button>
				</span>
			</div>,
		];
	});
	return (
		<div class="kbox kfull">
			<h6>Needs a look</h6>
			{flags.length > 0 ? (
				flags
			) : (
				<div class="mut">
					Nothing unusual in {books.selected.period.slice(0, 4)}.
				</div>
			)}
		</div>
	);
}

/** How donors give (mockup `bkDistHtml`): the count, each size bucket and the median gift, as cells. */
function Donors({ books }: { books: Books }): JSX.Element {
	const { document, selected } = books;
	const donors = cellAt(document, "donors_count", selected.period);
	if (donors === 0)
		return (
			<div class="mut">
				No donations recorded in {selected.period.slice(0, 4)} yet.
			</div>
		);
	if (typeof donors !== "number")
		return (
			<div class="kdistline" data-test="donor-line">
				<Value books={books} kpi="donors_count" /> donors
			</div>
		);
	const buckets = seriesStartingWith(document, "month", "donors_by_size:");
	return (
		<>
			<div class="kdistline" data-test="donor-line">
				<b>
					<Value books={books} kpi="donors_count" /> donors
				</b>
				:{" "}
				{buckets.map((kpi, index) => (
					<Fragment key={kpi}>
						{index > 0 && ", "}
						<Value books={books} kpi={kpi} /> {document.meta[kpi]?.title}
					</Fragment>
				))}
				; median gift <Value books={books} kpi="donors_median_gift" />
			</div>
			<Breakdown books={books} kpis={buckets} marked={false} />
		</>
	);
}

/** Governance, Finance admin and Owner (mockup `dashFull`): the month's cards, charts, breakdowns and spreads. */
function MonthBody({
	books,
	view,
	creditsName,
	identities,
	openReports,
}: {
	books: Books;
	view: DashboardView;
	creditsName: string;
	identities: boolean;
	openReports: () => void;
}): JSX.Element {
	const { document, selected } = books;
	const month = monthName(selected.from);
	const year = selected.period.slice(0, 4);
	const index = document.tables.month?.periods.indexOf(selected.period) ?? -1;
	const rate = numberAt(document, "refund_rate", selected.period);
	if (view === "money") {
		const plans =
			document.tables.month?.order?.revenue_by_tier?.[index] ??
			seriesStartingWith(document, "month", "revenue_by_tier:");
		const funds =
			document.tables.month?.order?.donations_by_fund?.[index] ?? [];
		const days = document.tables.day?.periods.some((day) =>
			day.startsWith(`${selected.period}-`),
		);
		return (
			<>
				<div class="kcards">
					<Card books={books} label="Gross collected" kpi="gross_collected">
						<Change books={books} kpi="gross_collected" />
					</Card>
					<Card
						books={books}
						label="Refunds"
						kpi="refunds"
						tone={
							rate !== null && rate > refundRateWarn ? refundTone(rate) : ""
						}
					>
						<Value books={books} kpi="refund_rate" /> of gross
					</Card>
					<Card books={books} label="Payment fees" kpi="stripe_fees">
						<Change books={books} kpi="stripe_fees" />
					</Card>
					<Card books={books} label="Net income" kpi="net_income" tone="ok">
						<Change books={books} kpi="net_income" />
					</Card>
					<Card books={books} label="Paid out" kpi="payouts">
						Lands the month after
					</Card>
				</div>
				<div class="kgrid">
					<div class="kbox">
						<h6>
							Gross vs net, {year}
							<Legend
								items={[
									["Gross", grossColor],
									["Net", firstColor],
								]}
							/>
						</h6>
						<Bars
							books={books}
							series={[
								{ kpi: "gross_collected", name: "Gross", color: grossColor },
								{ kpi: "net_income", name: "Net", color: firstColor },
							]}
						/>
					</div>
					<div class="kbox">
						<h6>Gross by plan, {month}</h6>
						{plans.length > 0 ? (
							<Breakdown books={books} kpis={plans} />
						) : (
							<div class="mut">No plans yet.</div>
						)}
						<div class="mut kfoot">
							Memberships only. Add-ons and bookings appear here when the school
							sells them.
						</div>
					</div>
					{funds.length > 0 && (
						<div class="kbox">
							<h6>
								Donations by fund, {year} to {month}
							</h6>
							<Breakdown books={books} kpis={funds} />
						</div>
					)}
					{document.live && days && (
						<div class="kbox kfull">
							<h6>
								Gross by day, {month}
								<Legend
									items={[
										[selected.open ? "Days so far (live)" : "Day", firstColor],
									]}
								/>
							</h6>
							<Days books={books} />
						</div>
					)}
				</div>
			</>
		);
	}
	if (view === "members")
		return (
			<>
				<div class="kcards">
					<Card books={books} label="Paying members" kpi="paying_members">
						<Change books={books} kpi="paying_members" />
					</Card>
					<Card books={books} label="New paying" kpi="new_paying_members">
						first payment this month
					</Card>
					<Card books={books} label="Avg per paying member" kpi="arpa">
						in {month}
					</Card>
					<Card
						books={books}
						label={`${creditsName} used`}
						kpi="credits_consumed"
					>
						<Value books={books} kpi="credits_granted" /> granted ·{" "}
						<Value books={books} kpi="credits_expired" /> expired
					</Card>
				</div>
				<div class="kgrid">
					<div class="kbox">
						<h6>
							Paying members
							<Legend
								items={[["Members who paid in the month", secondColor]]}
							/>
						</h6>
						<Line
							books={books}
							kpi="paying_members"
							name="Paying members"
							color={secondColor}
							smallestTop={5}
						/>
					</div>
					<div class="kbox">
						<h6>
							{creditsName}
							<Legend
								items={[
									["Granted", firstColor],
									["Used", secondColor],
									["Expired", thirdColor],
								]}
							/>
						</h6>
						<Bars
							books={books}
							series={[
								{ kpi: "credits_granted", name: "Granted", color: firstColor },
								{ kpi: "credits_consumed", name: "Used", color: secondColor },
								{ kpi: "credits_expired", name: "Expired", color: thirdColor },
							]}
						/>
					</div>
					{"donors_count" in (document.tables.month?.series ?? {}) && (
						<div class="kbox kfull">
							<h6>
								How donors give, {year} to {month}
								<Legend
									items={[
										[
											identities
												? "Spread only here; names are in Reports"
												: "No names, no rows",
											thirdColor,
										],
									]}
								/>
							</h6>
							<Donors books={books} />
						</div>
					)}
				</div>
				{identities && (
					<div class="kcaption">
						<Icon name="info" />
						<span>
							Names and amounts:{" "}
							<button type="button" class="link" onClick={openReports}>
								Donors and payers
							</button>{" "}
							in Reports. Every identified read is audited.
						</span>
					</div>
				)}
			</>
		);
	const anyDisputes = periodsOf(books, "month").some(
		(period) => (numberAt(document, "disputes_opened", period) ?? 0) > 0,
	);
	return (
		<>
			<div class="kcards">
				<Card
					books={books}
					label="Refund rate"
					kpi="refund_rate"
					tone={refundTone(rate)}
				>
					<Value books={books} kpi="refunds" /> refunded
				</Card>
				<Card
					books={books}
					label="Disputes opened"
					kpi="disputes_opened"
					tone={disputeTone(
						numberAt(document, "disputes_opened", selected.period),
					)}
				>
					in {month}
				</Card>
				<Card
					books={books}
					label="Dispute cost"
					kpi="dispute_cost"
					tone={disputeCostTone(
						numberAt(document, "dispute_cost", selected.period),
					)}
				>
					lost <Value books={books} kpi="disputes_lost" /> + fees{" "}
					<Value books={books} kpi="dispute_fees" />
				</Card>
				<Card books={books} label="Net income" kpi="net_income">
					<Change books={books} kpi="net_income" />
				</Card>
			</div>
			<div class="kgrid">
				<div class="kbox">
					<h6>
						Refund rate
						<Legend items={[["Share of gross refunded", fifthColor]]} />
					</h6>
					<Line
						books={books}
						kpi="refund_rate"
						name="Refund rate"
						color={fifthColor}
						smallestTop={0.12}
						threshold={refundRateBad}
					/>
				</div>
				<div class="kbox">
					<h6>
						Dispute cost
						<Legend items={[["Lost + fees", fifthColor]]} />
					</h6>
					{anyDisputes ? (
						<Bars
							books={books}
							series={[
								{ kpi: "dispute_cost", name: "Cost", color: fifthColor },
							]}
						/>
					) : (
						<div class="kempty">No disputes in {year}</div>
					)}
				</div>
				<Flags books={books} />
			</div>
		</>
	);
}

/** The strip period the route shows (S7's notes, mockup `snapP`): the route's period when the audience may pick it,
 * else the last pickable one that ends on or before it, else the first pickable one. */
function snapPeriod(
	periods: DocumentPeriod[],
	asked: Period,
): DocumentPeriod | undefined {
	const pickable = periods.filter(({ state }) => state === "shown");
	return (
		pickable.find(({ from, to }) => from === asked.from && to === asked.to) ??
		pickable.filter(({ to }) => to <= asked.to).at(-1) ??
		pickable[0] ??
		periods[0]
	);
}

/** The caption (document `captions` by the selected year), its audience name in bold as the mockup writes it. */
function Caption({
	text,
	audience,
}: {
	text: string;
	audience: Audience;
}): JSX.Element {
	const name = audienceNames[audience];
	return (
		<div class="kcaption" data-test="dash-caption">
			<Icon name="info" />
			<span>
				{text.startsWith(name) ? (
					<>
						<b>{name}</b>
						{text.slice(name.length)}
					</>
				) : (
					text
				)}
			</span>
		</div>
	);
}

type Loaded = {
	key: string;
	school: string;
	presets: Preset[];
	document: KpiDocument | undefined;
};

/** The Dashboard pane (mockup `dashboard()`): Money, Members or Risk for one period of the KPI document of the
 * audience the route views (`useViewing`). Public and Member read their years or quarters, each KPI at its
 * own grain; Governance and up read months, the live audiences with the open month and its days. Every figure is a
 * document cell written as the mockup writes it: nothing is summed, compared or recomputed, and a hidden or missing
 * cell is never a 0. */
export function Dashboard({
	reader,
	school,
	clock,
	route,
	navigate,
	onRendered,
	onToast,
}: BooksPaneProps): JSX.Element | null {
	const { query } = route;
	const view = views.find(({ id }) => id === query.get("view")) ?? views[0];
	const { disclosure, option, view: audienceView } = useViewing();
	const { audience } = option;
	const pinLocked = audienceView.pin && query.get("pin") === "locked";
	const presetAsked = query.get("preset");
	const key = `${school.id}/${presetAsked}/${audience}/${pinLocked}`;
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	/** The documents read so far, by the `key` that asked for them, and the other audiences' right after the first paint:
	 * picking another View as row shows its document in the same click, with no wait for the Reader. */
	const documents = useRef(new Map<string, KpiDocument>());
	const heldAudiences = disclosure.viewAs.flatMap((row) =>
		row.held ? [row.audience] : [],
	);
	const heldKey = heldAudiences.join(",");
	useEffect(() => {
		let current = true;
		const load = async (): Promise<void> => {
			const { presets } = await reader.dashboardOptions();
			const preset = presets.find(({ id }) => id === presetAsked) ?? presets[0];
			const read = async (
				forAudience: typeof audience,
				locked: boolean,
			): Promise<KpiDocument | undefined> => {
				const read = await reader.kpiDocument({
					school: school.id,
					preset: preset.id,
					audience: forAudience,
					pinLocked: locked,
				});
				if (read)
					documents.current.set(
						`${school.id}/${presetAsked}/${forAudience}/${locked}`,
						read,
					);
				return read;
			};
			const document = await read(audience, pinLocked);
			if (current) setLoaded({ key, school: school.id, presets, document });
			const others = new Set(heldKey.split(",") as Array<typeof audience>);
			others.delete(audience);
			await Promise.all(
				[...others].map((other) => read(other, false).catch(() => undefined)),
			);
		};
		load().catch(keepLoading);
		return () => {
			current = false;
		};
	}, [reader, key, school.id, presetAsked, audience, pinLocked, heldKey]);
	const onScreen = loaded?.key === key && loaded.document !== undefined;
	useLayoutEffect(() => {
		if (onScreen) onRendered();
	});
	/** While the next document loads, the one before stays on screen (the route is reported only once it is in). */
	const document =
		documents.current.get(key) ??
		(loaded?.school === school.id ? loaded.document : undefined);
	if (!(loaded && document)) return null;

	const go = (name: string, value: string | null): void =>
		navigate(withQuery(route, name, value));
	const preset =
		loaded.presets.find(({ id }) => id === presetAsked) ?? loaded.presets[0];
	const month = document.grain === "month";
	const selected = snapPeriod(
		document.periods,
		parsePeriod(
			query.get("month") ?? school.dashboardOpensOn ?? null,
			clock.today,
		),
	);
	if (!selected) return null;
	const books: Books = {
		document,
		selected,
		choose: (period) => {
			const target = document.periods.find(
				(candidate) => candidate.period === period,
			);
			if (target) go("month", month ? period : `${target.from}..${target.to}`);
		},
	};
	const position = document.periods.indexOf(selected);
	const creditsName = `${school.creditUnit.other.charAt(0).toUpperCase()}${school.creditUnit.other.slice(1)}`;
	const pinAudiences = audiences.filter(
		(candidate) => disclosure.views[candidate].pin,
	);
	const step = (direction: -1 | 1): JSX.Element => {
		const target = document.periods[position + direction];
		return (
			<button
				type="button"
				data-test="dash-step"
				data-step={direction}
				aria-label={direction < 0 ? "Previous month" : "Next month"}
				disabled={target?.state !== "shown"}
				onClick={() => target && books.choose(target.period)}
			>
				{direction < 0 ? "‹" : "›"}
			</button>
		);
	};
	const featured = loaded.presets.slice(0, featuredScenarios);
	const more = loaded.presets.slice(featuredScenarios);
	const caption = document.captions[selected.period.slice(0, 4)];
	let body: JSX.Element;
	if (selected.state !== "shown")
		body = (
			<div class="kbox kwait kwaitbox">
				<b>{selected.label} is not shown yet</b>
				<span>{selected.title}.</span>
			</div>
		);
	else if (!month)
		body = (
			<AggregateBody
				books={books}
				view={view.id}
				creditsName={creditsName}
				planLock={option.locks["dashboard-plan"]}
				fewerThan={audienceView.smallCounts?.fewerThan ?? null}
			/>
		);
	else if (document.empty)
		body = (
			<div class="kbox kempty" data-test="dash-empty">
				No payments yet. This dashboard fills in after the first payment.
			</div>
		);
	else
		body = (
			<MonthBody
				books={books}
				view={view.id}
				creditsName={creditsName}
				identities={audienceView.identities}
				openReports={() => navigate({ ...route, tab: "reports" })}
			/>
		);

	return (
		<>
			<div class="kt">
				{/* biome-ignore lint/a11y/useSemanticElements: the mockup's segmented control is a div; a fieldset brings its own border and padding */}
				<div class="seg" role="group" aria-label="Dashboard view">
					{views.map(({ id, label, icon }) => (
						<button
							key={id}
							type="button"
							class={id === view.id ? "on" : undefined}
							data-test="dash-view"
							data-view={id}
							aria-pressed={id === view.id}
							onClick={() => go("view", id)}
						>
							<Icon name={icon} />
							{label}
						</button>
					))}
				</div>
				<span class="badge" data-test="dash-badge">
					<Icon name="scale" />
					Cash basis · {document.symbol}
				</span>
				<span
					class={document.dataSource === "fixture" ? "badge b-warn" : "badge"}
					data-test="dash-badge"
					title={document.notes.join(" ") || undefined}
				>
					{document.dataSource === "fixture"
						? "Fixture data: invented"
						: "From this school's events"}
				</span>
				{audienceView.pin && (
					<button
						type="button"
						class={pinLocked ? "chip on" : "chip"}
						data-test="pin-chip"
						aria-pressed={pinLocked}
						title={`${namesList(pinAudiences.map((candidate) => audienceNames[candidate]))} open books with the family PIN`}
						onClick={() => go("pin", pinLocked ? null : "locked")}
					>
						<Icon name="lock" />
						PIN locked
					</button>
				)}
				{document.source.kind === "mart" && (
					<>
						<span class="sp" />
						{/* biome-ignore lint/a11y/useSemanticElements: the mockup's segmented control is a div; a fieldset brings its own border and padding */}
						<div class="seg" role="group" aria-label="Fixture scenario">
							{featured.map(({ id, label }) => (
								<button
									key={id}
									type="button"
									class={id === preset?.id ? "on" : undefined}
									data-test="preset-option"
									data-preset={id}
									aria-pressed={id === preset?.id}
									onClick={() => go("preset", id)}
								>
									{label}
								</button>
							))}
						</div>
						{more.length > 0 && (
							<select
								class="kmore"
								aria-label="More scenarios"
								value={
									more.some(({ id }) => id === preset?.id) ? preset?.id : ""
								}
								onChange={(event) => {
									if (event.currentTarget.value)
										go("preset", event.currentTarget.value);
								}}
							>
								<option value="">More scenarios</option>
								{more.map(({ id, label }) => (
									<option
										key={id}
										value={id}
										class={id === preset?.id ? "on" : undefined}
										data-test="preset-option"
										data-preset={id}
									>
										{label}
									</option>
								))}
							</select>
						)}
					</>
				)}
			</div>
			{document.pinLocked ? (
				<PinLock
					key={audience}
					levelName={audienceNames[audience]}
					onUnlock={() => {
						go("pin", null);
						onToast("Books unlocked for this session.");
					}}
				/>
			) : (
				<>
					{/* biome-ignore lint/a11y/useSemanticElements: the mockup's month strip is a div; a fieldset brings its own border and padding */}
					<div
						class="kmonths"
						role="group"
						aria-label={month ? "Month" : "Period"}
					>
						{month && step(-1)}
						{document.periods.map((period) => {
							const classes = [
								period === selected && "on",
								period.state === "embargoed" && "kwait",
								period.open && "kopen",
							].filter(Boolean);
							return (
								<button
									key={period.period}
									type="button"
									class={classes.join(" ") || undefined}
									data-test="dash-period"
									data-period={period.period}
									aria-pressed={period === selected}
									disabled={period.state !== "shown"}
									title={
										period.open ? openMonthTitle : (period.title ?? undefined)
									}
									onClick={() => books.choose(period.period)}
								>
									{month ? periodName(period.period) : period.label}
								</button>
							);
						})}
						{month && step(1)}
						{month && (
							<span class="mut kafter">{selected.period.slice(0, 4)}</span>
						)}
						{document.periods.some(({ open }) => open) && (
							<span class="mut kopenkey kafter" data-test="open-key">
								hatched = open month, live
							</span>
						)}
					</div>
					{caption && <Caption text={caption} audience={audience} />}
					{month && document.source.kind === "mart" && preset?.note && (
						<div class="note" data-test="dash-note">
							<Icon name="alert" />
							<span>{preset.note}</span>
						</div>
					)}
					{body}
				</>
			)}
		</>
	);
}
