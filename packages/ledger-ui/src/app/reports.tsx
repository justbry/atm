import type { JSX } from "preact";
import { useLayoutEffect } from "preact/hooks";
import {
	type AudienceReport,
	audienceNames,
	type CreditUnit,
	type CsvColumn,
	csvFileNames,
	type IncomeSeries,
	type IncomeStatement,
	type LedgerDrill,
	needsPin,
	type ReportCell,
	type SchoolRules,
	type StatementAmounts,
	type StatementCsvRow,
	statementColumns,
	statementLines,
} from "../data/ledger.ts";
import type { BooksPaneProps } from "./books-pane.ts";
import { Donors } from "./donors.tsx";
import { DownloadButton } from "./download-button.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { LoadFailed } from "./load-failed.tsx";
import { formatMoney } from "./money.ts";
import {
	monthAndDay,
	type Period,
	parsePeriod,
	periodLabel,
} from "./period.ts";
import { PinLock } from "./pin-lock.tsx";
import { cellText, Figure } from "./report-figure.tsx";
import { type Route, withQuery } from "./route.ts";
import { useLoaded } from "./use-loaded.ts";
import { useViewing } from "./viewing.ts";

const sparkWidth = 600;
const sparkHeight = 56;
const drillTitle = "Show these events in the ledger";
const financeOnlyTitle = "Finance admins only: the rows behind a figure";
const grainWords = { year: "years", quarter: "quarters", month: "months" };
/** A figure the source does not record yet (the Worker answers null): never shown as 0. */
const notAvailableText = "—";
const statementAmount = (cents: number | null, currency: string): string =>
	cents === null ? notAvailableText : formatMoney(cents, currency);
const whoSees: Record<AudienceReport["audience"], string> = {
	public: "Public sees",
	member: "Members see",
	governance: "Governance sees",
};

/** A money figure of the document, rounded or exact as the document says. */
const documentFigure =
	(document: AudienceReport, currency: string) =>
	(cell: ReportCell, noun = "payers"): JSX.Element => (
		<Figure
			cell={cell}
			money
			currency={currency}
			whole={document.rounding !== null}
			noun={noun}
		/>
	);

type DocumentRow = { line: string; kpi: string; value: string; hidden: string };
const slug = (text: string): string =>
	text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// ---- The sparkline (mockup `spark`).

const sparkLabel = (series: IncomeSeries, start: string): string =>
	series.step === "day" ? monthAndDay(start) : `week of ${monthAndDay(start)}`;

function Spark({
	series,
	previous,
	from,
	currency,
}: {
	series: IncomeSeries;
	previous: IncomeSeries | null;
	from: string;
	currency: string;
}): JSX.Element {
	if (series.points.length === 0)
		return (
			<>
				<div class="sphead">
					<h5 style="margin:0" data-test="report-spark-title">
						Daily income
					</h5>
				</div>
				<p class="mut" style="margin:0">
					No data yet for this period.
				</p>
			</>
		);
	const amounts = series.points.map(({ amountCents }) => amountCents);
	const before = previous
		? previous.points
				.slice(0, amounts.length)
				.map(({ amountCents }) => amountCents)
		: null;
	const highest = Math.max(1, ...amounts, ...(before ?? [0]));
	const x = (index: number): number =>
		amounts.length > 1
			? (index * sparkWidth) / (amounts.length - 1)
			: sparkWidth / 2;
	const y = (value: number): number =>
		sparkHeight - 4 - (value / highest) * (sparkHeight - 10);
	const line = (values: number[]): string =>
		values
			.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
			.join(" ");
	const title = `${series.step === "day" ? "Daily" : "Weekly"} income`;
	const slot = sparkWidth / amounts.length;
	return (
		<>
			<div class="sphead">
				<h5 style="margin:0" data-test="report-spark-title">
					{title}
				</h5>
				<span class="mut" data-test="report-spark-summary">
					{`${formatMoney(series.totalCents, currency)}${
						series.peak
							? ` · peak ${formatMoney(series.peak.amountCents, currency)} (${sparkLabel(series, series.peak.start)})`
							: ""
					}`}
				</span>
			</div>
			<svg
				class="sp"
				viewBox={`0 0 ${sparkWidth} ${sparkHeight}`}
				preserveAspectRatio="none"
				role="img"
				aria-label={`${title} for the period`}
			>
				<polygon
					points={`0,${sparkHeight} ${line(amounts)} ${sparkWidth},${sparkHeight}`}
					fill="var(--primary)"
					opacity=".15"
				/>
				{before && (
					<polyline
						points={line(before)}
						fill="none"
						stroke="var(--muted-foreground)"
						stroke-width="1.5"
						stroke-dasharray="4 3"
						vector-effect="non-scaling-stroke"
					/>
				)}
				<polyline
					points={line(amounts)}
					fill="none"
					stroke="var(--primary)"
					stroke-width="2"
					vector-effect="non-scaling-stroke"
				/>
				{series.points.map((point, index) => (
					<rect
						key={point.start}
						data-test="report-spark-point"
						x={x(index) - slot / 2}
						y="0"
						width={slot}
						height={sparkHeight}
						fill="transparent"
					>
						<title>{`${sparkLabel(series, point.start)}: ${formatMoney(point.amountCents, currency)}`}</title>
					</rect>
				))}
			</svg>
			<div class="spax" data-test="report-spark-axis">
				<span>{monthAndDay(from)}</span>
				{previous && <span>dashed: previous period</span>}
				<span>{monthAndDay(series.through)}</span>
			</div>
		</>
	);
}

// ---- The finance admin's and the owner's Reports.

const kpis: Array<{
	item: string;
	label: string;
	icon: IconName;
	drill: LedgerDrill;
	field: "income" | "refunds" | "fees" | "paidOut";
}> = [
	{
		item: "income",
		label: "Income",
		icon: "coin",
		drill: "income",
		field: "income",
	},
	{
		item: "refund",
		label: "Refunds",
		icon: "undo",
		drill: "refund",
		field: "refunds",
	},
	{
		item: "fees",
		label: "Stripe fees",
		icon: "receipt",
		drill: "fees",
		field: "fees",
	},
	{
		item: "payout",
		label: "Paid out",
		icon: "bank",
		drill: "payout",
		field: "paidOut",
	},
];

/** The statement's rows (mockup `stmt`): its label, its amount, the drill-down it opens (none for Net) and how it is
 * drawn. */
const statementRows: Array<{
	line: string;
	label: string;
	field: keyof StatementAmounts;
	drill: LedgerDrill | null;
	indented: boolean;
	bold: boolean;
	negative: boolean;
}> = [
	{
		line: "memberships",
		label: "Memberships",
		field: "memberships",
		drill: "memb",
		indented: true,
		bold: false,
		negative: false,
	},
	{
		line: "bookings",
		label: "Bookings and events",
		field: "bookings",
		drill: "book",
		indented: true,
		bold: false,
		negative: false,
	},
	{
		line: "discounts",
		label: "Discounts given",
		field: "discounts",
		drill: "disc",
		indented: true,
		bold: false,
		negative: true,
	},
	{
		line: "income",
		label: "Income",
		field: "income",
		drill: "income",
		indented: false,
		bold: true,
		negative: false,
	},
	{
		line: "refunds",
		label: "Refunds",
		field: "refunds",
		drill: "refund",
		indented: false,
		bold: false,
		negative: true,
	},
	{
		line: "fees",
		label: "Stripe fees",
		field: "fees",
		drill: "fees",
		indented: false,
		bold: false,
		negative: true,
	},
	{
		line: "net",
		label: "Net",
		field: "net",
		drill: null,
		indented: false,
		bold: true,
		negative: false,
	},
];

/** "▲ $X vs <period>": the server's change of the line, signed; the UI formats it and never subtracts. */
const changeText = (change: number, currency: string, label: string): string =>
	`${change >= 0 ? "▲" : "▼"} ${formatMoney(Math.abs(change), currency)} vs ${label}`;

function StatementBody({
	statement,
	period,
	onDrill,
	onPromos,
}: {
	statement: IncomeStatement;
	period: Period;
	onDrill: (drill: LedgerDrill) => void;
	onPromos: () => void;
}): JSX.Element {
	const { amounts, currency, previous, giftsOutstanding, counts, unit } =
		statement;
	const money = (cents: number): string => formatMoney(cents, currency);
	const before = previous
		? {
				period: { from: previous.from, to: previous.to },
				changes: previous.changes,
			}
		: null;
	const gifts = giftsOutstanding
		? `${money(giftsOutstanding.amountCents)}${
				giftsOutstanding.credits > 0
					? ` + ${giftsOutstanding.credits} ${giftsOutstanding.credits === 1 ? unit.one : unit.other}`
					: ""
			}`
		: notAvailableText;
	return (
		<>
			<p class="okline" data-test="report-status">
				{statement.matchesStripe === null ? (
					<span class="mut" data-test="report-stripe-unchecked">
						Not checked against Stripe yet.
					</span>
				) : statement.matchesStripe ? (
					<>
						<span class="ok">
							<Icon name="check" /> Matches Stripe
						</span>
						{` · ${counts.payments} payment${counts.payments === 1 ? "" : "s"}, ${counts.refunds} refund${counts.refunds === 1 ? "" : "s"}, ${counts.payouts} payout${counts.payouts === 1 ? "" : "s"}`}
					</>
				) : (
					<span class="mut">
						Partial month: summed from daily totals. The hledger report and the
						Stripe match run on whole months.
					</span>
				)}{" "}
				<span class="badge">
					<Icon name="scale" />
					{statement.basis.kind === "cash"
						? "Cash basis"
						: `Deferred from ${monthAndDay(statement.basis.from)}`}
				</span>
			</p>
			<div
				class="card"
				id="spark"
				data-test="report-spark"
				style="margin-bottom:10px"
			>
				<Spark
					series={statement.income}
					previous={previous?.income ?? null}
					from={period.from}
					currency={currency}
				/>
			</div>
			<div class="kpis">
				{kpis.map(({ item, label, icon, drill, field }) => (
					<button
						key={item}
						type="button"
						class="stat"
						data-test="report-kpi"
						data-item={item}
						title={drillTitle}
						onClick={() => onDrill(drill)}
					>
						<small>
							<Icon name={icon} />{" "}
							<span data-test="report-kpi-label">{label}</span>
						</small>
						<b
							class={amounts[field] < 0 ? "neg" : undefined}
							data-test="report-kpi-value"
						>
							{money(amounts[field])}
						</b>
						{before && (
							<i class="s" data-test="report-kpi-change">
								{changeText(
									before.changes[field],
									currency,
									periodLabel(before.period),
								)}
							</i>
						)}
					</button>
				))}
				<button
					type="button"
					class="stat"
					data-test="report-kpi"
					data-item="gifts"
					title="Open promos"
					onClick={onPromos}
				>
					<small>
						<Icon name="gift" />{" "}
						<span data-test="report-kpi-label">
							Gift certificates outstanding
						</span>
					</small>
					<b data-test="report-kpi-value">{gifts}</b>
					<i class="s" data-test="report-kpi-change">
						{giftsOutstanding
							? `${giftsOutstanding.count} unredeemed gift${giftsOutstanding.count === 1 ? "" : "s"} (a liability)`
							: "Not available yet"}
					</i>
				</button>
			</div>
		</>
	);
}

function Statement({
	statement,
	period,
	onDrill,
}: {
	statement: IncomeStatement;
	period: Period;
	onDrill: (drill: LedgerDrill) => void;
}): JSX.Element {
	const { amounts, currency } = statement;
	const rows = statementRows.map((row) => {
		const drillable = row.drill !== null;
		const label = row.bold ? <b>{row.label}</b> : row.label;
		return (
			<tr
				key={row.line}
				data-test="report-line"
				data-line={row.line}
				data-dd={row.drill ?? undefined}
				title={drillable ? drillTitle : undefined}
				onClick={() => {
					if (row.drill) onDrill(row.drill);
				}}
			>
				<td
					class={row.indented ? "mut" : undefined}
					style={row.indented ? "padding-left:20px" : undefined}
					data-test="report-line-label"
				>
					{drillable ? (
						<button type="button" class="drill">
							{label}
						</button>
					) : (
						label
					)}
				</td>
				<td class={row.negative ? "r neg" : "r"} data-test="report-line-amount">
					{row.bold && row.line === "net" ? (
						<b>{statementAmount(amounts[row.field], currency)}</b>
					) : (
						statementAmount(amounts[row.field], currency)
					)}
				</td>
			</tr>
		);
	});
	return (
		<table id="stmt">
			<tbody>
				<tr>
					<th colSpan={2} data-test="report-statement-title">
						{`Income statement · ${periodLabel(period)}`}
					</th>
				</tr>
				{rows}
				<tr
					data-test="report-line"
					data-line="gifts"
					data-dd="gift"
					title={drillTitle}
					onClick={() => onDrill("gift")}
				>
					<td class="mut" colSpan={2} style="padding-top:10px">
						<button type="button" class="drill">
							{amounts.giftsSold === null
								? "Not income: gift certificates sold: not available yet"
								: `Not income: gift certificates sold ${formatMoney(amounts.giftsSold, currency)} (held as a liability until redeemed)`}
						</button>
					</td>
				</tr>
			</tbody>
		</table>
	);
}

// ---- The audience's document: Public, Member and Governance.

function DocumentBody({
	document,
	currency,
}: {
	document: AudienceReport;
	currency: string;
}): JSX.Element {
	const { audience, grain, figures } = document;
	const name = audienceNames[audience];
	const figure = documentFigure(document, currency);
	const numbers = document.periods.flatMap(({ income }) =>
		typeof income === "number" ? [income] : [],
	);
	const highest = Math.max(1, ...numbers);
	return (
		<>
			<p class="okline" data-test="report-status">
				<span class="mut">{`${name} document · ${document.periodLabel}:`}</span>{" "}
				<Figure
					cell={document.payments}
					money={false}
					currency={currency}
					whole={false}
					noun="payers"
				/>
				{" payments · Reconciliation with Stripe: "}
				<span class="khid" data-hid="no_grant" title="Finance admins only">
					<Icon name="lock" />
					Finance admins and the owner see this
				</span>
			</p>
			<div
				class="card"
				id="spark"
				data-test="report-spark"
				style="margin-bottom:10px"
			>
				<div class="sphead">
					<h5 style="margin:0" data-test="report-grain">
						{`Income by ${grain}`}
					</h5>
					<span class="mut" data-test="report-grain-note">
						{`${whoSees[audience]} ${grainWords[grain]}. Days show to finance admins and the owner.`}
					</span>
				</div>
				{document.periods.map(({ label, income }) => {
					const waiting =
						typeof income === "object" &&
						"hidden" in income &&
						income.hidden === "embargoed";
					return (
						<div
							key={label}
							class={`krow kp${waiting ? " kwait" : ""}${label === document.periodLabel ? " kon" : ""}`}
							data-test="report-period"
						>
							<span>{label}</span>
							<div class="t">
								{typeof income === "number" && (
									<i
										style={{
											width: `${(income / highest) * 100}%`,
											background: "var(--primary)",
										}}
									/>
								)}
							</div>
							<b>{figure(income)}</b>
						</div>
					);
				})}
			</div>
			<div class="kpis">
				{kpis.map(({ item, label, icon, field }) => (
					<button
						key={item}
						type="button"
						class="stat"
						disabled
						data-test="report-kpi"
						data-item={item}
						title={financeOnlyTitle}
					>
						<small>
							<Icon name={icon} />{" "}
							<span data-test="report-kpi-label">{label}</span>
						</small>
						<b data-test="report-kpi-value">{figure(figures[field])}</b>
					</button>
				))}
				<button
					type="button"
					class="stat"
					disabled
					data-test="report-kpi"
					data-item="gifts"
					title="Finance admins only"
				>
					<small>
						<Icon name="gift" />{" "}
						<span data-test="report-kpi-label">
							Gift certificates outstanding
						</span>
					</small>
					<b data-test="report-kpi-value">{figure(figures.giftsOutstanding)}</b>
					<i class="s">a liability</i>
				</button>
			</div>
		</>
	);
}

function DocumentStatement({
	document,
	currency,
}: {
	document: AudienceReport;
	currency: string;
}): JSX.Element {
	const { audience, grain, figures, rounding } = document;
	const figure = documentFigure(document, currency);
	const lines: Array<{
		line: string;
		label: string;
		cell: ReportCell;
		indented: boolean;
		bold: boolean;
	}> = [
		{
			line: "memberships",
			label: "Memberships",
			cell: figures.memberships,
			indented: true,
			bold: false,
		},
		...document.tiers.map(({ name, income }) => ({
			line: "tier",
			label: `· ${name}`,
			cell: income,
			indented: true,
			bold: false,
		})),
		{
			line: "bookings",
			label: "Bookings and events",
			cell: figures.bookings,
			indented: true,
			bold: false,
		},
		{
			line: "discounts",
			label: "Discounts given",
			cell: figures.discounts,
			indented: true,
			bold: false,
		},
		{
			line: "income",
			label: "Income",
			cell: figures.income,
			indented: false,
			bold: true,
		},
		{
			line: "refunds",
			label: "Refunds",
			cell: figures.refunds,
			indented: false,
			bold: false,
		},
		{
			line: "fees",
			label: "Stripe fees",
			cell: figures.fees,
			indented: false,
			bold: false,
		},
		{
			line: "net",
			label: "Net",
			cell: figures.net,
			indented: false,
			bold: true,
		},
	];
	const roundingText = rounding
		? `money rounded to ${formatMoney(rounding.unitCents, currency, true)} (${rounding.size} school)`
		: "exact";
	return (
		<table id="stmt">
			<tbody>
				<tr>
					<th colSpan={3} data-test="report-statement-title">
						{`Income statement · ${document.periodLabel} · ${audienceNames[audience]} document`}
					</th>
				</tr>
				{lines.map(({ line, label, cell, indented, bold }) => (
					<tr key={`${line}${label}`} data-test="report-line" data-line={line}>
						<td
							class={indented ? "mut" : undefined}
							style={indented ? "padding-left:20px" : undefined}
							data-test="report-line-label"
						>
							{bold ? <b>{label}</b> : label}
						</td>
						<td class="r" data-test="report-line-amount">
							{bold && line === "net" ? <b>{figure(cell)}</b> : figure(cell)}
						</td>
						<td class="r kddc">
							<button
								type="button"
								class="link kdd"
								disabled
								title="Finance admins only"
								aria-label={`Rows behind ${label}`}
							>
								›
							</button>
						</td>
					</tr>
				))}
				<tr>
					<td
						class="mut"
						colSpan={3}
						style="padding-top:10px"
						data-test="report-doc-note"
					>
						<Icon name="info" />
						{` Figures from the ${audienceNames[audience]} document: ${grainWords[grain]}, ${roundingText}. A figure inside its delay shows when it publishes.`}
					</td>
				</tr>
			</tbody>
		</table>
	);
}

// ---- Rules in force.

function Rules({
	rules,
	unit,
	canEdit,
	onEdit,
}: {
	rules: SchoolRules;
	unit: CreditUnit;
	canEdit: boolean;
	onEdit: () => void;
}): JSX.Element {
	const rows = [
		{
			rule: "cutoff",
			label: "Cancel cutoff (default)",
			value: `${rules.cancelCutoffHours} hours before`,
		},
		{
			rule: "no-show",
			label: "No-show",
			value: `${unit.other} are ${rules.noShow === "spend" ? "spent" : "released"}`,
		},
		{
			rule: "late-cancel",
			label: "Late cancel",
			value: `${unit.other} are ${rules.lateCancel === "spend" ? "forfeited" : "released"}`,
		},
	];
	return (
		<div class="card" data-test="report-rules">
			<h5>
				<Icon name="clock" /> Rules in force
			</h5>
			<table>
				<tbody>
					{rows.map(({ rule, label, value }) => (
						<tr key={rule} data-test="report-rule" data-rule={rule}>
							<td>{label}</td> <td class="r">{value}</td>
						</tr>
					))}
				</tbody>
			</table>
			<p class="mut" style="margin:8px 0 0">
				School policy: every audience sees it. An item can set its own cutoff.
			</p>
			{canEdit && (
				<button
					type="button"
					class="link"
					style="margin-top:6px"
					data-test="report-rules-edit"
					onClick={onEdit}
				>
					<Icon name="ext" />
					Edit in school settings
				</button>
			)}
		</div>
	);
}

// ---- The tab.

/** The Reports tab (mockup `reports()`). Finance admins and the owner get the period's income statement, with the
 * drill-downs into the Ledger; Public, Member and Governance get their audience's document, at its grain, with the
 * figures the cell rules and the delay allow. */
export function Reports({
	reader,
	writer,
	school,
	clock,
	route,
	navigate,
	onRendered,
	onToast,
}: BooksPaneProps): JSX.Element | null {
	const { query } = route;
	const { audience, admin } = useViewing().option;
	const documentAudience =
		audience === "finance" || audience === "owner" ? null : audience;
	const pinLocked = query.get("pin") === "locked" && needsPin(audience);
	const period = parsePeriod(query.get("month"), clock.today);
	const compare = query.get("compare") === "1";
	const key = [school.id, audience, period.from, period.to, compare, pinLocked]
		.map(String)
		.join("|");
	const [loaded, , status] = useLoaded(key, async () => {
		if (pinLocked) return null;
		const [rules, donors] = await Promise.all([
			reader.schoolRules(school.id),
			reader.donors({
				school: school.id,
				audience,
				year: Number(clock.today.slice(0, 4)),
			}),
		]);
		const common = { rules, donors };
		return documentAudience === null
			? {
					...common,
					statement: await reader.incomeStatement({
						school: school.id,
						from: period.from,
						to: period.to,
						compare,
					}),
					document: null,
				}
			: {
					...common,
					statement: null,
					document: await reader.audienceReport({
						school: school.id,
						audience: documentAudience,
						from: period.from,
						to: period.to,
					}),
				};
	});
	useLayoutEffect(() => {
		if (pinLocked || loaded || status.failed) onRendered();
	});

	if (pinLocked)
		return (
			<PinLock
				key={audience}
				levelName={audienceNames[audience]}
				onUnlock={() => {
					navigate(withQuery(route, "pin", null));
					onToast("Books unlocked for this session.");
				}}
			/>
		);
	if (status.failed)
		return <LoadFailed what="the report" onRetry={status.retry} />;
	if (!loaded) return null;

	const { rules, donors, statement, document } = loaded;
	const openLedger = (drill: LedgerDrill): void =>
		navigate(ledgerRoute(route, drill));
	const download = statement ? (
		<DownloadButton<StatementCsvRow>
			writer={writer}
			onToast={onToast}
			test="report-download"
			className="btn"
			title="Download the income statement as CSV"
			label="Download"
			name={csvFileNames.statement(statement.from, statement.to)}
			columns={statementColumns(statement)}
			rows={statementLines.map(([line, field]) => ({
				line,
				amountCents: statement.amounts[field],
			}))}
		/>
	) : null;
	return (
		<>
			<div class="tools">
				<span class="sp" />
				{download}
				{document && (
					<DownloadButton<DocumentRow>
						writer={writer}
						onToast={onToast}
						test="report-download"
						className="btn"
						title={`Download the ${audienceNames[document.audience]} document's figures as CSV (aggregates only)`}
						label="Download"
						name={`books-${document.audience}-${slug(document.periodLabel)}.csv`}
						columns={documentColumns(document)}
						rows={documentRows(document, school.currency)}
					/>
				)}
			</div>
			{statement && (
				<StatementBody
					statement={statement}
					period={period}
					onDrill={openLedger}
					onPromos={() => navigate({ ...route, tab: "promos" })}
				/>
			)}
			{document && (
				<DocumentBody document={document} currency={school.currency} />
			)}
			<div class="two2">
				<div class="card">
					{statement && (
						<Statement
							statement={statement}
							period={period}
							onDrill={openLedger}
						/>
					)}
					{document && (
						<DocumentStatement document={document} currency={school.currency} />
					)}
				</div>
				<Rules
					rules={rules.rules}
					unit={rules.unit}
					canEdit={admin}
					onEdit={() => onToast("Opening school settings in buzz-school…")}
				/>
			</div>
			<div class="card" data-test="donors" style="margin-top:10px">
				<Donors
					report={donors}
					audience={audience}
					currency={school.currency}
					today={clock.today}
					writer={writer}
					onToast={onToast}
				/>
			</div>
		</>
	);
}

/** The Ledger with a drill-down (mockup `drill`): the period stays, the type goes back to All. */
const ledgerRoute = (route: Route, drill: LedgerDrill): Route => ({
	...withQuery(
		withQuery(withQuery(route, "drill", drill), "type", null),
		"promo",
		null,
	),
	tab: "ledger",
});

const documentColumns = (
	document: AudienceReport,
): Array<CsvColumn<DocumentRow>> => [
	{ header: "line", kind: "text", value: (row) => row.line },
	{ header: "kpi", kind: "text", value: (row) => row.kpi },
	{ header: "value", kind: "text", value: (row) => row.value },
	{ header: "hidden", kind: "text", value: (row) => row.hidden },
	{ header: "audience", kind: "text", value: () => document.audience },
	{ header: "period", kind: "text", value: () => document.periodLabel },
];

/** The document's six figures as `reportDocCsv` lists them. */
function documentRows(
	document: AudienceReport,
	currency: string,
): DocumentRow[] {
	const { figures } = document;
	const whole = document.rounding !== null;
	const lines: Array<{
		line: string;
		kpi: string;
		cell: ReportCell;
		money: boolean;
	}> = [
		{
			line: "Income",
			kpi: "gross_collected",
			cell: figures.income,
			money: true,
		},
		{ line: "Refunds", kpi: "refunds", cell: figures.refunds, money: true },
		{
			line: "Stripe fees",
			kpi: "stripe_fees",
			cell: figures.fees,
			money: true,
		},
		{ line: "Net", kpi: "net_income", cell: figures.net, money: true },
		{ line: "Paid out", kpi: "payouts", cell: figures.paidOut, money: true },
		{
			line: "Payments",
			kpi: "payments_count",
			cell: document.payments,
			money: false,
		},
	];
	return lines.map(({ line, kpi, cell, money }) => ({
		line,
		kpi,
		...cellText(cell, money, currency, whole),
	}));
}
