import { type ComponentChildren, Fragment, type JSX } from "preact";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import {
	type BooksLevel,
	type Cell,
	cellKind,
	type HiddenKind,
	type KpiDocument,
	type KpiFormat,
	type LagClass,
	type PeriodInfo,
} from "../data/kpi-document.ts";
import type { Reader } from "../data/reader.ts";
import type {
	BooksLevelOption,
	DashboardOptions,
	Preset,
	School,
} from "../data/types.ts";
import { Icon, type IconName } from "./icon.tsx";
import { type Route, withQuery } from "./route.ts";

type DashboardView = "money" | "members" | "risk";
type ViewOption = {
	id: DashboardView;
	label: string;
	icon: IconName;
	/** Which delay of the level the view follows (the document's `caption` and `waiting` are per lag class). */
	lag: LagClass;
};
const views: [ViewOption, ...ViewOption[]] = [
	{ id: "money", label: "Money", icon: "coin", lag: "money" },
	{ id: "members", label: "Members", icon: "users", lag: "usage" },
	{ id: "risk", label: "Risk", icon: "alert", lag: "money" },
];
/** The mockup's `BK_LV` icons, by the Reader's rank order (widest audience first), so no level is named here. */
const levelIcons: IconName[] = ["eye", "user", "users", "coin", "key"];
const chartColors = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
] as const;
const [firstColor, secondColor, thirdColor, fourthColor, fifthColor] =
	chartColors;
const grossColor = "rgba(138, 138, 150, 0.5)";
/** The mockup's tones and "Needs a look": a refund rate over 10% or 3 disputes or more; over 20% or 5 is severe. */
const refundRateBad = 0.1;
const refundRateWarn = 0.05;
const refundRateSevere = 0.2;
const disputesBad = 3;
const disputesSevere = 5;
const pinDigits = 4;
const chartWidth = 600;
const dayChartWidth = 1200;
const dayChartHeight = 64;
const dayLabelEvery = 5;

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
function numberFormat(format: KpiFormat, currency: string): Intl.NumberFormat {
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

/** What every part of the pane reads: the document, the Reader's labels, the view's lag class, the selected period's
 * index, and how to open a period. */
type Books = {
	document: KpiDocument;
	labels: Record<HiddenKind, string>;
	lag: LagClass;
	selected: number;
	choose: (period: string) => void;
};

const cellAt = ({ document }: Books, kpi: string, index: number): Cell =>
	document.series[kpi]?.[index] ?? { hidden: "not_computed" };
/** The cell's number, or null for a band or a hidden cell: those are never drawn, and never as 0. */
const numberAt = (books: Books, kpi: string, index: number): number | null => {
	const cell = cellAt(books, kpi, index);
	return typeof cell === "number" ? cell : null;
};
/** A cell as cell-rules writes it. */
function cellText(
	{ document, labels }: Books,
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
const seriesStartingWith = (document: KpiDocument, prefix: string): string[] =>
	Object.keys(document.series).filter((kpi) => kpi.startsWith(prefix));
/** "A", "A and B", "A, B and C". */
function namesList(names: string[]): string {
	const last = names.at(-1) ?? "";
	return names.length < 2
		? last
		: `${names.slice(0, -1).join(", ")} and ${last}`;
}

/** One document cell (protocol §3): its kind in `data-cell`, its text exactly as cell-rules writes it, and the reason
 * of a hidden cell in its title. */
function Value({
	books,
	kpi,
	index = books.selected,
	test,
}: {
	books: Books;
	kpi: string;
	index?: number;
	test?: string;
}): JSX.Element {
	const cell = cellAt(books, kpi, index);
	const kind = cellKind(cell);
	const why = typeof cell === "object" && "hidden" in cell ? cell.why : null;
	return (
		<span
			data-test={test}
			data-kpi={kpi}
			data-period={books.document.periods[index]}
			data-cell={kind}
			class={kind === "suppressed" ? "kcutv" : undefined}
			title={why ? `Hidden: ${why}` : undefined}
		>
			{cellText(books, kpi, cell)}
		</span>
	);
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

/** A card (mockup `kc`): its value cells joined by "+", dashed when the first is hidden by the cell rules. */
function Card({
	books,
	label,
	kpis,
	tone = "",
	children,
}: {
	books: Books;
	label: string;
	kpis: [string, ...string[]];
	tone?: Tone;
	children: ComponentChildren;
}): JSX.Element {
	const cut = cellKind(cellAt(books, kpis[0], books.selected)) === "suppressed";
	return (
		<div class={`kcard ${cut ? "kcut" : tone}`.trim()} data-test="kpi-card">
			<small data-test="kpi-label">{label}</small>
			<b>
				{kpis.map((kpi, index) => (
					<Fragment key={kpi}>
						{index > 0 && " + "}
						<Value books={books} kpi={kpi} test="kpi-value" />
					</Fragment>
				))}
			</b>
			<i>{children}</i>
		</div>
	);
}

/** The month before, as a cell: the mockup's change against it would be a number the UI computes. */
function Previous({
	books,
	kpi,
}: {
	books: Books;
	kpi: string;
}): ComponentChildren {
	const before = books.document.periodInfo[books.selected - 1];
	if (!before) return "First month";
	return (
		<>
			{before.label}:{" "}
			<Value books={books} kpi={kpi} index={books.selected - 1} />
		</>
	);
}

/** The cards of a view (mockup `dashAgg` and `dashFull`): the month grain adds the average per member and, on Risk,
 * net income. */
function Cards({
	books,
	view,
}: {
	books: Books;
	view: DashboardView;
}): JSX.Element {
	const { document, selected } = books;
	const label = document.periodInfo[selected]?.label ?? "";
	const month = document.grain === "month";
	const rate = numberAt(books, "refund_rate", selected);
	const { roundTo } = document.policy;
	const rounding = roundTo
		? `rounded to ${numberFormat("money0", document.currency).format(roundTo / 100)}`
		: "exact";
	if (view === "money")
		return (
			<div class="kcards">
				<Card books={books} label="Gross collected" kpis={["gross_collected"]}>
					{month ? (
						<Previous books={books} kpi="gross_collected" />
					) : (
						`${label}, ${rounding}`
					)}
				</Card>
				<Card
					books={books}
					label="Refunds"
					kpis={["refunds"]}
					tone={month ? refundTone(rate) : ""}
				>
					<Value books={books} kpi="refund_rate" /> of gross
				</Card>
				<Card books={books} label="Payment fees" kpis={["stripe_fees"]}>
					{month ? <Previous books={books} kpi="stripe_fees" /> : `in ${label}`}
				</Card>
				<Card books={books} label="Net income" kpis={["net_income"]} tone="ok">
					{month ? (
						<Previous books={books} kpi="net_income" />
					) : (
						"Rounded on its own"
					)}
				</Card>
				<Card books={books} label="Paid out" kpis={["payouts"]}>
					Lands the month after
				</Card>
			</div>
		);
	if (view === "members")
		return (
			<div class="kcards">
				<Card books={books} label="Paying members" kpis={["paying_members"]}>
					{month ? (
						<Previous books={books} kpi="paying_members" />
					) : (
						`most in one month of ${label}`
					)}
				</Card>
				<Card books={books} label="New paying" kpis={["new_paying_members"]}>
					{month ? "first payment this month" : `first payment in ${label}`}
				</Card>
				{month && (
					<Card books={books} label="Avg per paying member" kpis={["arpa"]}>
						in {label}
					</Card>
				)}
				<Card books={books} label="Credits used" kpis={["credits_consumed"]}>
					<Value books={books} kpi="credits_granted" /> granted ·{" "}
					<Value books={books} kpi="credits_expired" /> expired
				</Card>
			</div>
		);
	return (
		<div class="kcards">
			<Card
				books={books}
				label="Refund rate"
				kpis={["refund_rate"]}
				tone={refundTone(rate)}
			>
				<Value books={books} kpi="refunds" /> refunded
			</Card>
			<Card
				books={books}
				label="Disputes opened"
				kpis={["disputes_opened"]}
				tone={disputeTone(numberAt(books, "disputes_opened", selected))}
			>
				in {label}
			</Card>
			<Card
				books={books}
				label="Dispute cost"
				kpis={["disputes_lost", "dispute_fees"]}
			>
				lost + fees
			</Card>
			{month && (
				<Card books={books} label="Net income" kpis={["net_income"]}>
					<Previous books={books} kpi="net_income" />
				</Card>
			)}
		</div>
	);
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

/** The period labels under a chart, as HTML so they keep their size when the chart scales. */
function Axis({ books }: { books: Books }): JSX.Element {
	const { periodInfo } = books.document;
	return (
		<div
			class="kax"
			aria-hidden="true"
			style={{ gridTemplateColumns: `repeat(${periodInfo.length}, 1fr)` }}
		>
			{periodInfo.map((info, index) => (
				<span
					key={info.period}
					class={index === books.selected ? "on" : undefined}
				>
					{info.label}
				</span>
			))}
		</div>
	);
}

/** A column per period with its cells in the tooltip; the selected period's column is shaded. */
function Column({
	books,
	index,
	width,
	height,
	kpis,
}: {
	books: Books;
	index: number;
	width: number;
	height: number;
	kpis: Array<{ kpi: string; name: string }>;
}): JSX.Element {
	const label = books.document.periodInfo[index]?.label;
	const cells = kpis.map(
		({ kpi, name }) =>
			`${name} ${cellText(books, kpi, cellAt(books, kpi, index))}`,
	);
	return (
		<rect
			class={index === books.selected ? "col on" : "col"}
			x={index * width}
			y={0}
			width={width}
			height={height}
		>
			<title>{`${label}: ${cells.join(" · ")}`}</title>
		</rect>
	);
}

type ChartSeries = { kpi: string; name: string; color: string };

/** Grouped bars per period (mockup `kbars`), scaled to the largest number shown. */
function Bars({
	books,
	series,
}: {
	books: Books;
	series: ChartSeries[];
}): JSX.Element {
	const height = 110;
	const { periodInfo } = books.document;
	const columnWidth = chartWidth / periodInfo.length;
	const barWidth = (columnWidth * 0.72) / series.length;
	const values = series.map(({ kpi }) =>
		periodInfo.map((_, index) => numberAt(books, kpi, index)),
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
				{periodInfo.map((info, index) => (
					<g key={info.period}>
						<Column
							books={books}
							index={index}
							width={columnWidth}
							height={height}
							kpis={series}
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
			<Axis books={books} />
		</>
	);
}

/** A line through the periods' numbers (mockup `kline`), with an optional dashed threshold. */
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
	const { periodInfo } = books.document;
	const columnWidth = chartWidth / periodInfo.length;
	const values = periodInfo.map((_, index) => numberAt(books, kpi, index));
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
					{periodInfo.map((info, index) => (
						<Column
							key={info.period}
							books={books}
							index={index}
							width={columnWidth}
							height={height}
							kpis={[{ kpi, name }]}
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
					{values.map((value, index) =>
						value === null ? null : (
							<circle
								key={periodInfo[index]?.period}
								cx={x(index)}
								cy={y(value)}
								r={index === books.selected ? 4.5 : 2.5}
								fill={index === books.selected ? "var(--foreground)" : color}
								pointer-events="none"
							/>
						),
					)}
				</svg>
				{threshold !== undefined && (
					<span
						class="kthr"
						style={{ top: `${(y(threshold) / height) * 100}%` }}
					>
						{cellText(books, kpi, threshold)}
					</span>
				)}
			</div>
			<Axis books={books} />
		</>
	);
}

/** Gross per day of the selected month (mockup `kdays`): days not shown yet are a low grey stub, never a 0 bar. */
function Days({
	books,
	period,
	label,
}: {
	books: Books;
	period: string;
	label: string;
}): JSX.Element | null {
	const { days } = books.document;
	if (!days) return null;
	const inMonth = days.periods.flatMap((day, index) =>
		day.startsWith(`${period}-`)
			? [{ day, cell: days.series.gross_collected?.[index] }]
			: [],
	);
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
				aria-label={`Gross by day, ${label}`}
			>
				{inMonth.map(({ day, cell = { hidden: "not_computed" } }, position) => {
					const shared = {
						"data-kpi": "gross_collected",
						"data-day": day,
						"data-cell": cellKind(cell),
						x: position * columnWidth + 1,
						width: columnWidth - 2,
						rx: 2,
					};
					const title = (
						<title>{`${label} ${Number(day.slice(8))}: ${cellText(books, "gross_collected", cell)}`}</title>
					);
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
								{title}
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
							{title}
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

/** Rows of one period's breakdown (plans, funds, donor sizes), then the reason of every hidden row. */
function Breakdown({
	books,
	kpis,
}: {
	books: Books;
	kpis: string[];
}): JSX.Element {
	const { document, selected } = books;
	const values = kpis.map((kpi) => numberAt(books, kpi, selected));
	const largest = Math.max(1, ...values.filter((value) => value !== null));
	const reasons = kpis.flatMap((kpi) => {
		const cell = cellAt(books, kpi, selected);
		return typeof cell === "object" && "hidden" in cell && cell.why
			? [`${document.meta[kpi]?.title}: ${cell.why}`]
			: [];
	});
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
							<Value books={books} kpi={kpi} />
						</b>
					</div>
				);
			})}
			{reasons.length > 0 && (
				<div class="kwhy" data-test="kpi-why">
					<Icon name="lock" />
					<span>{reasons.join(" · ")}</span>
				</div>
			)}
		</>
	);
}

/** Public and Member (mockup `dashAgg`): one row per period, the waiting ones with the day they show from. */
function PeriodRows({
	books,
	view,
	levels,
}: {
	books: Books;
	view: DashboardView;
	levels: BooksLevelOption[];
}): JSX.Element {
	const { document, selected, lag } = books;
	const kpi = view === "members" ? "paying_members" : "gross_collected";
	const values = document.periodInfo.map((_, index) =>
		numberAt(books, kpi, index),
	);
	const largest = Math.max(1, ...values.filter((value) => value !== null));
	const lead = `${view === "members" ? "Paying members" : "Gross"} by ${document.grain}${view === "risk" ? " (the base for refund and dispute rates)" : ""}`;
	const breakdownsFrom = levels.find(({ steps }) => steps > "G2")?.name;
	const identified = levels
		.filter(({ steps }) => steps === "G6")
		.map(({ name }) => name);
	return (
		<div class="kgrid">
			<div class="kbox">
				<h6>{lead}</h6>
				{document.periodInfo.map((info, index) => {
					const value = values[index] ?? null;
					if (info.waiting[lag])
						return (
							<div class="krow kp kwait" key={info.period}>
								<span>{info.label}</span>
								<div class="t" />
								<b>from {info.shownFromLabel[lag]}</b>
							</div>
						);
					return (
						<div
							class={index === selected ? "krow kp kon" : "krow kp"}
							key={info.period}
						>
							<span>{info.label}</span>
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
								<Value books={books} kpi={kpi} index={index} />
							</b>
						</div>
					);
				})}
				<div class="mut" style={{ marginTop: "8px" }}>
					{view === "members"
						? "Counts of people."
						: "Rounded on their own, so a year is not the sum of its rounded quarters."}{" "}
					Cell rules hide a figure with fewer than{" "}
					{document.rules.minContributors} payers.
				</div>
			</div>
			<div class="kbox">
				<h6>More detail</h6>
				<div class="mut">
					Breakdowns by plan or fund show from {breakdownsFrom} up. Names show
					to {namesList(identified)} only.
				</div>
			</div>
		</div>
	);
}

/** "Needs a look" (mockup Risk): the periods with a refund rate over 10% or 3 disputes or more. */
function Flags({ books }: { books: Books }): JSX.Element {
	const { periodInfo } = books.document;
	const flags = periodInfo.flatMap((info, index) => {
		const rate = numberAt(books, "refund_rate", index);
		const disputes = numberAt(books, "disputes_opened", index);
		const highRate = rate !== null && rate > refundRateBad;
		const manyDisputes = disputes !== null && disputes >= disputesBad;
		if (!highRate && !manyDisputes) return [];
		const severe =
			(highRate && rate > refundRateSevere) ||
			(manyDisputes && disputes >= disputesSevere);
		return [
			<div class="kflag" data-test="dash-flag" key={info.period}>
				<span class={severe ? "kdot kd-bad" : "kdot kd-warn"} />
				<span>{info.label}</span>
				<span class="mut">
					{highRate && (
						<>
							Refund rate{" "}
							<Value books={books} kpi="refund_rate" index={index} />
						</>
					)}
					{highRate && manyDisputes && " · "}
					{manyDisputes && (
						<>
							<Value books={books} kpi="disputes_opened" index={index} />{" "}
							disputes
						</>
					)}
				</span>
				<span>
					<button
						type="button"
						class="link"
						onClick={() => books.choose(info.period)}
					>
						Show ›
					</button>
				</span>
			</div>,
		];
	});
	return (
		<div class="kbox" style={{ gridColumn: "1 / -1" }}>
			<h6>Needs a look</h6>
			{flags.length > 0 ? (
				flags
			) : (
				<div class="mut">Nothing unusual in {books.document.year}.</div>
			)}
		</div>
	);
}

/** Governance, Finance admin and Owner (mockup `dashFull`): the month's charts, breakdowns and distributions. */
function MonthCharts({
	books,
	view,
	openReports,
}: {
	books: Books;
	view: DashboardView;
	openReports: () => void;
}): JSX.Element {
	const { document, selected } = books;
	const info = document.periodInfo[selected];
	const label = info?.label ?? "";
	const { year } = document;
	const identified = document.policy.steps === "G6";
	if (view === "money") {
		const plans = seriesStartingWith(document, "revenue_by_tier:");
		const funds = seriesStartingWith(document, "donations_by_fund:");
		const hasDays = document.days?.periods.some((day) =>
			day.startsWith(`${info?.period}-`),
		);
		return (
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
					<h6>Gross by plan, {label}</h6>
					{plans.length > 0 ? (
						<Breakdown books={books} kpis={plans} />
					) : (
						<div class="mut">No plans yet.</div>
					)}
					<div class="mut" style={{ marginTop: "8px" }}>
						Memberships only. Add-ons and bookings appear here when the school
						sells them.
					</div>
				</div>
				{funds.length > 0 && (
					<div class="kbox">
						<h6>
							Donations by fund, {year} to {label}
						</h6>
						<Breakdown books={books} kpis={funds} />
					</div>
				)}
				{info && hasDays && (
					<div class="kbox" style={{ gridColumn: "1 / -1" }}>
						<h6>
							Gross by day, {label}
							<Legend
								items={[
									[info.partial ? "Days so far (live)" : "Day", firstColor],
								]}
							/>
						</h6>
						<Days books={books} period={info.period} label={label} />
					</div>
				)}
			</div>
		);
	}
	if (view === "members") {
		const buckets = seriesStartingWith(document, "donors_by_size:");
		return (
			<>
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
							Credits
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
					{"donors_count" in document.series && (
						<div class="kbox" style={{ gridColumn: "1 / -1" }}>
							<h6>
								How donors give, {year} to {label}
								<Legend
									items={[
										[
											identified
												? "Distribution only here; names are in Reports"
												: "No names, no rows",
											thirdColor,
										],
									]}
								/>
							</h6>
							<div class="kdistline" data-test="donor-line">
								<b>
									<Value books={books} kpi="donors_count" /> donors
								</b>
								:{" "}
								{buckets.map((kpi, index) => (
									<Fragment key={kpi}>
										{index > 0 && ", "}
										<Value books={books} kpi={kpi} />{" "}
										{document.meta[kpi]?.title}
									</Fragment>
								))}
								; median gift <Value books={books} kpi="donors_median_gift" />
							</div>
							<Breakdown books={books} kpis={buckets} />
						</div>
					)}
				</div>
				{identified && (
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
	}
	const anyDisputes = document.periodInfo.some(
		(_, index) => (numberAt(books, "disputes_opened", index) ?? 0) > 0,
	);
	return (
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
					<Legend
						items={[
							["Lost", fifthColor],
							["Fees", fourthColor],
						]}
					/>
				</h6>
				{anyDisputes ? (
					<Bars
						books={books}
						series={[
							{ kpi: "disputes_lost", name: "Lost", color: fifthColor },
							{ kpi: "dispute_fees", name: "Fees", color: fourthColor },
						]}
					/>
				) : (
					<div class="kempty">No disputes in {year}</div>
				)}
			</div>
			<Flags books={books} />
		</div>
	);
}

/** The cells the cards do not show: the blocked balance on Members, the KPIs the server does not compute on Money. */
function Unavailable({
	books,
	view,
}: {
	books: Books;
	view: DashboardView;
}): JSX.Element | null {
	const { document } = books;
	const reasons = document.notComputed
		.filter(({ id }) => !(id in document.series))
		.map(({ reason }) => reason);
	let content: ComponentChildren = null;
	if (view === "members" && "credits_outstanding" in document.series)
		content = (
			<>
				{document.meta.credits_outstanding?.title}:{" "}
				<Value books={books} kpi="credits_outstanding" />
			</>
		);
	else if (view === "money" && reasons.length > 0)
		content = reasons.join(" · ");
	if (!content) return null;
	return (
		<div class="kwhy" style={{ margin: "-4px 0 10px" }}>
			<Icon name="info" />
			<span>{content}</span>
		</div>
	);
}

/** The PIN prompt (mockup `bkLock`): Unlock opens once 4 digits are typed. The fixtures check no PIN. */
function PinLock({
	levelName,
	onUnlock,
}: {
	levelName: string;
	onUnlock: () => void;
}): JSX.Element {
	const [pin, setPin] = useState("");
	return (
		<div class="klock" data-test="pin-lock">
			<Icon name="lock" />
			<h4>Enter your PIN to see books</h4>
			<div class="mut">
				{levelName} opens the books with your family PIN. Nothing is shown until
				you unlock.
			</div>
			<div class="fld">
				<label>
					Your family PIN
					<input
						class="bpin"
						type="password"
						inputMode="numeric"
						maxLength={6}
						autoComplete="off"
						aria-label="Your family PIN"
						data-test="pin-input"
						value={pin}
						onInput={(event) => setPin(event.currentTarget.value)}
					/>
				</label>
			</div>
			<button
				type="button"
				class="btn p"
				data-test="pin-unlock"
				disabled={pin.length < pinDigits}
				onClick={onUnlock}
			>
				<Icon name="unlock" />
				Unlock
			</button>
		</div>
	);
}

/** A period button's title: when a period not shown yet shows, or that the open month is live. */
function periodTitle(info: PeriodInfo, lag: LagClass): string | undefined {
	if (info.shownFrom[lag] !== null)
		return `Shows from ${info.shownFromLabel[lag]}`;
	if (info.partial) return "Open month: live, can still change";
	return undefined;
}

/** The hash's period; else the school's opening month; else the last period the view shows; else the first. */
function selectedIndex(
	document: KpiDocument,
	asked: string | null,
	opensOn: string | undefined,
	shows: (info: PeriodInfo) => boolean,
): number {
	const requested = document.periods.indexOf(asked ?? "");
	if (requested >= 0) return requested;
	const opening = document.periodInfo.findIndex(
		(info) => info.period === opensOn && shows(info),
	);
	if (opening >= 0) return opening;
	return Math.max(0, document.periodInfo.map(shows).lastIndexOf(true));
}

type Loaded = {
	key: string;
	options: DashboardOptions;
	preset: Preset;
	level: BooksLevelOption;
	document: KpiDocument | undefined;
};

/** The Dashboard pane (mockup `dashboard()`): the books level switcher, then Money, Members or Risk for one period of
 * the server's KPI document at that level. Every number is a document cell written in its format; nothing is summed,
 * compared across periods or recomputed. */
export function Dashboard({
	reader,
	school,
	route,
	navigate,
	onRendered,
	onToast,
}: {
	reader: Reader;
	school: School;
	route: Route;
	navigate: (route: Route) => void;
	/** Called after each render that shows the document the route asks for. */
	onRendered: () => void;
	onToast: (text: string) => void;
}): JSX.Element | null {
	const { query } = route;
	const view = views.find(({ id }) => id === query.get("view")) ?? views[0];
	const presetAsked = query.get("preset");
	const levelAsked = query.get("level");
	const pinAsked = query.get("pin") === "locked";
	const { booksLevel } = school;
	const key = `${presetAsked}.${levelAsked ?? booksLevel}.${pinAsked}`;
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	useEffect(() => {
		let current = true;
		const load = async (): Promise<void> => {
			const options = await reader.dashboardOptions();
			const preset =
				options.presets.find(({ id }) => id === presetAsked) ??
				options.presets[0];
			const level =
				options.levels.find(({ id }) => id === levelAsked) ??
				options.levels.find(({ id }) => id === booksLevel);
			if (!level) return;
			const document = await reader.kpiDocument({
				preset: preset.id,
				level: level.id,
				pinLocked: level.pin && pinAsked,
			});
			if (current) setLoaded({ key, options, preset, level, document });
		};
		load();
		return () => {
			current = false;
		};
	}, [reader, key, presetAsked, levelAsked, pinAsked, booksLevel]);
	const shown = loaded?.key === key ? loaded : null;
	useLayoutEffect(() => {
		if (shown?.document) onRendered();
	});
	if (!shown?.document) return null;

	const { options, preset, level, document } = shown;
	const go = (name: string, value: string | null): void =>
		navigate(withQuery(route, name, value));
	const month = document.grain === "month";
	const shows = (info: PeriodInfo): boolean =>
		info.shownFrom[view.lag] === null;
	const selectable = (info: PeriodInfo | undefined): info is PeriodInfo =>
		info !== undefined && (!month || shows(info));
	const selected = selectedIndex(
		document,
		query.get("month"),
		school.dashboardOpensOn,
		shows,
	);
	const selectedInfo = document.periodInfo[selected];
	const books: Books = {
		document,
		labels: options.labels,
		lag: view.lag,
		selected,
		choose: (period) => go("month", period),
	};
	const levelName = (id: BooksLevel): string =>
		options.levels.find((option) => option.id === id)?.name ?? id;
	const currency = numberFormat("money0", document.currency)
		.formatToParts(0)
		.find(({ type }) => type === "currency")?.value;
	const waiting = selectedInfo?.waiting[view.lag];
	const empty = (document.series.payments_count ?? []).every(
		(cell) => cell === 0 || cellKind(cell) === "not_yet",
	);
	const step = (direction: -1 | 1): JSX.Element => {
		const target = document.periodInfo[selected + direction];
		return (
			<button
				type="button"
				data-test="dash-step"
				data-step={direction}
				aria-label={direction < 0 ? "Previous month" : "Next month"}
				disabled={!selectable(target)}
				onClick={() => target && books.choose(target.period)}
			>
				{direction < 0 ? "‹" : "›"}
			</button>
		);
	};
	let body: JSX.Element;
	if (empty)
		body = (
			<div class="kbox kempty" data-test="dash-empty">
				No payments yet. This dashboard fills in after the first payment.
			</div>
		);
	else if (waiting)
		body = (
			<div class="kbox kwait kwaitbox" data-test="dash-wait">
				<b>{waiting.title}</b>
				<span>{waiting.when}</span>
				<span>{waiting.why}</span>
			</div>
		);
	else
		body = (
			<>
				<Cards books={books} view={view.id} />
				<Unavailable books={books} view={view.id} />
				{month && (
					<MonthCharts
						books={books}
						view={view.id}
						openReports={() => navigate({ ...route, tab: "reports" })}
					/>
				)}
			</>
		);

	return (
		<>
			<div class="kbv">
				<span class="mut">View books as</span>
				<div class="seg">
					{options.levels.map((option, rank) => (
						<button
							key={option.id}
							type="button"
							class={option.id === level.id ? "on" : undefined}
							data-test="books-level"
							data-level={option.id}
							aria-pressed={option.id === level.id}
							onClick={() => go("level", option.id)}
						>
							<Icon name={levelIcons[rank] ?? "eye"} />
							{option.name}
						</button>
					))}
				</div>
				{level.pin && (
					<button
						type="button"
						class={pinAsked ? "chip on" : "chip"}
						data-test="pin-chip"
						aria-pressed={pinAsked}
						title={`${namesList(options.levels.filter(({ pin }) => pin).map(({ name }) => name))} open books with the family PIN`}
						onClick={() => go("pin", pinAsked ? null : "locked")}
					>
						<Icon name="lock" />
						PIN locked
					</button>
				)}
				<span class="kbvnote mut" data-test="books-note">
					You are {levelName(booksLevel)} here. This switch previews what each
					level sees.
				</span>
			</div>
			{document.pinLocked ? (
				<PinLock
					key={level.id}
					levelName={level.name}
					onUnlock={() => {
						go("pin", null);
						onToast("Books unlocked for this session.");
					}}
				/>
			) : (
				<>
					<div class="kt">
						<div class="seg">
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
							Cash basis · {currency}
						</span>
						<span class="badge b-warn" data-test="dash-badge">
							Fixture data: invented
						</span>
						{document.verified && (
							<span class="badge b-ok" data-test="verified-badge">
								Verified
							</span>
						)}
						<span class="sp" />
						<div class="seg" style={{ flexWrap: "wrap" }}>
							{options.presets.map(({ id, label }) => (
								<button
									key={id}
									type="button"
									class={id === preset.id ? "on" : undefined}
									data-test="preset-option"
									data-preset={id}
									aria-pressed={id === preset.id}
									onClick={() => go("preset", id)}
								>
									{label}
								</button>
							))}
						</div>
					</div>
					<div class="kmonths">
						{month && step(-1)}
						{document.periodInfo.map((info, index) => {
							const notYet = !shows(info);
							return (
								<button
									key={info.period}
									type="button"
									class={
										[
											index === selected && "on",
											notYet && "kwait",
											info.partial && "kopen",
										]
											.filter(Boolean)
											.join(" ") || undefined
									}
									data-test="dash-period"
									data-period={info.period}
									aria-pressed={index === selected}
									disabled={!selectable(info)}
									title={periodTitle(info, view.lag)}
									onClick={() => books.choose(info.period)}
								>
									{info.label}
								</button>
							);
						})}
						{month && step(1)}
						{month && (
							<span class="mut" style={{ marginLeft: "6px" }}>
								{document.year}
							</span>
						)}
						{document.partialPeriods.length > 0 && (
							<span
								class="mut"
								style={{ marginLeft: "6px" }}
								data-test="open-key"
							>
								hatched = open month, live
							</span>
						)}
					</div>
					<div class="kcaption" data-test="dash-caption">
						<Icon name="info" />
						<span>{document.caption[view.lag]}</span>
					</div>
					{month && preset.note && (
						<div class="note" data-test="dash-note">
							<Icon name="alert" />
							<span>{preset.note}</span>
						</div>
					)}
					{body}
					{!month && !empty && (
						<PeriodRows books={books} view={view.id} levels={options.levels} />
					)}
				</>
			)}
		</>
	);
}
