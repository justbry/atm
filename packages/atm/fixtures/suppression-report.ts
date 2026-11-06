/**
 * Writes docs/suppression-report.md: what the default suppression rules (5 holders, 60% dominance, complement, paired
 * fees, derived inputs, quarterly under 10 payers) hide in every scenario preset. Spec v3, "Export content and
 * suppression": the report is the check of the fixtures side's estimates against the evaluator.
 *
 * Run: `bun run suppression-report` (from packages/atm). The text is deterministic (no dates, no run ids) and
 * tests/suppression-report.test.ts fails when docs/suppression-report.md differs from `suppressionReport()`.
 * It names no holder and carries no hash of unsuppressed data: only counts, shares and periods.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFixture } from "../src/scenario/fixture.js";
import { type KpiRow, SCHOOL_KPIS } from "../src/scenario/kpis.js";
import { PROFILES, type Profile } from "../src/scenario/profiles.js";
import {
	type Contributions,
	contributionsFromEvents,
	type SuppressedCellInfo,
	type SuppressedDocument,
	suppressKpis,
} from "../src/scenario/suppress.js";
import type { AtmEvent } from "../src/types.js";

export const REPORT_PATH = fileURLToPath(
	new URL("../docs/suppression-report.md", import.meta.url),
);

export type PresetAnalysis = {
	profile: Profile;
	/** The fixture's months (the document's periods are these, or their quarters). */
	months: string[];
	events: AtmEvent[];
	/** The unsuppressed monthly rows. */
	rows: KpiRow[];
	contributions: Contributions;
	activePayers: number;
	document: SuppressedDocument;
};

export const analysePreset = async (name: string): Promise<PresetAnalysis> => {
	const profile = PROFILES.find((candidate) => candidate.name === name);
	if (!profile) throw new Error(`no profile ${name}`);
	const fixture = buildFixture({ profile: name });
	const shares = await contributionsFromEvents({
		events: fixture.events,
		spec: SCHOOL_KPIS,
		periods: fixture.periods,
	});
	return {
		profile,
		months: fixture.periods,
		events: fixture.events,
		rows: shares.rows,
		contributions: shares.contributions,
		activePayers: shares.activePayers,
		document: suppressKpis({
			spec: SCHOOL_KPIS,
			rows: shares.rows,
			contributions: shares.contributions,
			activePayers: shares.activePayers,
		}),
	};
};

const HOLDER_ID_IN_TEXT = /`(family|profile):[^`]*`/g;

/** A preset's summary may mention an id prefix; the report must contain none. */
const withoutHolderIds = (text: string): string =>
	text.replace(HOLDER_ID_IN_TEXT, "a $1 id");

const percent = (part: number, whole: number): string =>
	whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`;

const countsOf = (document: SuppressedDocument) => {
	let total = 0;
	for (const cells of Object.values(document.series)) total += cells.length;
	const hidden = document.hiddenCells.length;
	return { total, hidden, shown: total - hidden };
};

/** `a, b..d, f`: consecutive periods collapsed to ranges. */
const periodList = (hiddenPeriods: string[], all: string[]): string => {
	if (hiddenPeriods.length === all.length) return `all ${all.length}`;
	const indexes = hiddenPeriods.map((period) => all.indexOf(period));
	const parts: string[] = [];
	let start = 0;
	for (let i = 1; i <= indexes.length; i++) {
		if (i < indexes.length && indexes[i] === (indexes[i - 1] as number) + 1)
			continue;
		const first = hiddenPeriods[start] as string;
		const last = hiddenPeriods[i - 1] as string;
		parts.push(first === last ? first : `${first}..${last}`);
		start = i;
	}
	return parts.join(", ");
};

const reasonCounts = (cells: SuppressedCellInfo[]): string => {
	const counts = new Map<string, number>();
	for (const cell of cells)
		counts.set(cell.reason, (counts.get(cell.reason) ?? 0) + 1);
	return [...counts]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([reason, count]) => `${reason} ${count}`)
		.join(", ");
};

const hiddenByKpi = (document: SuppressedDocument) => {
	const byKpi = new Map<string, SuppressedCellInfo[]>();
	for (const cell of document.hiddenCells)
		byKpi.set(cell.kpiId, [...(byKpi.get(cell.kpiId) ?? []), cell]);
	return [...byKpi].sort(([a], [b]) => (a < b ? -1 : 1));
};

const presetSection = (analysis: PresetAnalysis): string => {
	const { document, profile } = analysis;
	const { total, shown, hidden } = countsOf(document);
	const lines = [
		`### ${profile.name}`,
		"",
		withoutHolderIds(profile.summary),
		"",
		`Grain **${document.grain}**, ${document.periods.length} periods, ${analysis.activePayers} active payers over the last 12 months. Cells: ${total} total, ${shown} shown, ${hidden} hidden (${percent(hidden, total)}).`,
		"",
	];
	if (hidden === 0) return [...lines, "Nothing is hidden.", ""].join("\n");
	lines.push(
		"| KPI | hidden | periods hidden | reasons |",
		"|---|---:|---|---|",
	);
	for (const [kpiId, cells] of hiddenByKpi(document))
		lines.push(
			`| \`${kpiId}\` | ${cells.length} of ${document.periods.length} | ${periodList(
				cells.map((cell) => cell.period),
				document.periods,
			)} | ${reasonCounts(cells)} |`,
		);
	return [...lines, ""].join("\n");
};

const rawValue = (
	analysis: PresetAnalysis,
	kpiId: string,
	period: string,
): number =>
	analysis.rows.find((row) => row.kpiId === kpiId && row.period === period)
		?.value ?? 0;

const cellState = (
	analysis: PresetAnalysis,
	kpiId: string,
	period: string,
): { shown: boolean; reason: string | null } => {
	const index = analysis.document.periods.indexOf(period);
	return {
		shown: analysis.document.series[kpiId]?.[index] !== null,
		reason: analysis.document.reasons[kpiId]?.[index] ?? null,
	};
};

/** Months where the raw monthly cell is nonzero, and how many of them the suppressed document hides. */
const hiddenWhereActive = (analysis: PresetAnalysis, kpiId: string) => {
	const active = analysis.months.filter(
		(month) => rawValue(analysis, kpiId, month) !== 0,
	);
	const hidden = active.filter(
		(month) => !cellState(analysis, kpiId, month).shown,
	);
	return { active, hidden };
};

const verdict = (holds: boolean): string =>
	holds ? "**confirmed**" : "**not confirmed**";

const range = (values: number[]): string =>
	values.length === 0
		? "none"
		: `${Math.min(...values)}..${Math.max(...values)}`;

const membershipPayersByMonth = (
	events: AtmEvent[],
	tier: string,
): Map<string, Set<string>> => {
	const byMonth = new Map<string, Set<string>>();
	for (const event of events) {
		if (event.event_type !== "payment.succeeded") continue;
		if (
			!event.postings.some(
				(posting) => posting.account === `income:billing:membership:${tier}`,
			)
		)
			continue;
		const month = event.date.slice(0, 7);
		const payers = byMonth.get(month) ?? new Set<string>();
		payers.add(event.key);
		byMonth.set(month, payers);
	}
	return byMonth;
};

const findingFellowTier = (analysis: PresetAnalysis): string => {
	const kpiId = "revenue_by_tier:fellow";
	const { active, hidden } = hiddenWhereActive(analysis, kpiId);
	const payers = membershipPayersByMonth(analysis.events, "fellow");
	const counts = [...payers.values()].map((set) => set.size);
	const reasons = reasonCounts(
		analysis.document.hiddenCells.filter((cell) => cell.kpiId === kpiId),
	);
	return `- \`${kpiId}\` hidden monthly in \`monthly-members\` (about 3 payers): ${verdict(
		active.length > 0 && hidden.length === active.length,
	)}. Hidden in ${hidden.length} of the ${active.length} months with fellow revenue (${reasons}). Distinct fellow payers per month: ${range(counts)}.`;
};

const findingRefunds = (analysis: PresetAnalysis): string => {
	const amounts = hiddenWhereActive(analysis, "refunds");
	const counts = hiddenWhereActive(analysis, "refunds_count");
	const perMonth = analysis.months.map((month) =>
		rawValue(analysis, "refunds_count", month),
	);
	const holds =
		counts.active.length > 0 &&
		counts.hidden.length === counts.active.length &&
		amounts.hidden.length === amounts.active.length;
	return `- Refund counts and amounts hidden monthly at a 2% refund rate (\`monthly-members\`): ${verdict(
		holds,
	)}. \`refunds_count\` is hidden in ${counts.hidden.length} of ${counts.active.length} months that have a refund and \`refunds\` in ${amounts.hidden.length} of ${amounts.active.length}. Refunds per month: ${range(perMonth)} (the rule needs 5 distinct holders).`;
};

const findingDisputes = (analysis: PresetAnalysis): string => {
	const opened = hiddenWhereActive(analysis, "disputes_opened");
	const lost = hiddenWhereActive(analysis, "disputes_lost");
	const fees = hiddenWhereActive(analysis, "dispute_fees");
	const perMonth = analysis.months.map((month) =>
		rawValue(analysis, "disputes_opened", month),
	);
	const holds =
		opened.active.length > 0 &&
		opened.hidden.length === opened.active.length &&
		lost.hidden.length === lost.active.length &&
		fees.hidden.length === fees.active.length;
	return `- Disputes hidden monthly even in \`disputes\` (about 2 a month): ${verdict(
		holds,
	)}. \`disputes_opened\` is hidden in ${opened.hidden.length} of ${opened.active.length} months with a dispute, \`disputes_lost\` in ${lost.hidden.length} of ${lost.active.length}, \`dispute_fees\` in ${fees.hidden.length} of ${fees.active.length}. Disputes opened per month: ${range(perMonth)}.`;
};

const findingGrowth = (analysis: PresetAnalysis): string => {
	const firstQuarter = analysis.months.slice(0, 3);
	const lastQuarter = analysis.months.slice(-3);
	const hiddenIn = (months: string[]): number =>
		analysis.document.hiddenCells.filter((cell) => months.includes(cell.period))
			.length;
	const startPayers = analysis.months
		.slice(0, 3)
		.map((month) => rawValue(analysis, "paying_members", month));
	return `- \`growth-12mo\` starts quarterly: ${verdict(
		analysis.document.grain === "quarter",
	)}. The grain is one choice for the whole document, from the active payers over the rolling 12 months ending at the last period: ${analysis.activePayers} against a threshold of 10, so the grain is **${analysis.document.grain}**. The early months are small (paying members in the first 3 months: ${startPayers.join(", ")}), and the cells show it: ${hiddenIn(firstQuarter)} hidden cells in the first 3 months against ${hiddenIn(lastQuarter)} in the last 3.`;
};

const findingAnnual = (analysis: PresetAnalysis): string => {
	const kpiId = "gross_collected";
	const paying = analysis.months.filter(
		(month) => rawValue(analysis, kpiId, month) > 0,
	);
	const details = paying.map((month) => {
		const shares = Object.values(
			analysis.contributions[kpiId]?.[month] ?? {},
		).map(Math.abs);
		const largest = Math.max(0, ...shares);
		const sum = shares.reduce((n, value) => n + value, 0);
		const state = cellState(analysis, kpiId, month);
		return {
			month,
			holders: shares.length,
			share: sum === 0 ? 0 : largest / sum,
			state,
		};
	});
	const dominantHidden = details.filter(
		(detail) => detail.state.reason === "dominant_holder",
	);
	const renewals = details.slice(1);
	const worst = Math.max(0, ...details.map((detail) => detail.share));
	const lines = details.map(
		(detail) =>
			`${detail.month}: ${detail.holders} payers, largest share ${(detail.share * 100).toFixed(1)}%, ${
				detail.state.shown ? "shown" : `hidden (${detail.state.reason})`
			}`,
	);
	return `- The renewal month in \`annual-prepay\` may fail the dominance rule: ${verdict(
		dominantHidden.length > 0,
	)}. \`gross_collected\` has payments in ${paying.length} of ${analysis.months.length} months (${renewals.length === 0 ? "no renewal month" : `${renewals.length} after the first`}); the largest single share in any of them is ${(worst * 100).toFixed(1)}% against a 60% limit. ${lines.join("; ")}.`;
};

const findings = (analyses: Map<string, PresetAnalysis>): string => {
	const get = (name: string): PresetAnalysis => {
		const found = analyses.get(name);
		if (!found) throw new Error(`no analysis for ${name}`);
		return found;
	};
	return [
		'Spec v3 ("Export content and suppression") lists what the fixtures side expected. Each line is checked against the evaluator\'s output above.',
		"",
		findingFellowTier(get("monthly-members")),
		findingRefunds(get("monthly-members")),
		findingDisputes(get("disputes")),
		findingGrowth(get("growth-12mo")),
		findingAnnual(get("annual-prepay")),
	].join("\n");
};

const HOW_TO_READ = [
	"Each preset is generated from its seed, its KPIs are evaluated, each holder's share of each cell is computed (the atm channel run on that holder's events alone) and `suppressKpis` is run with the default rules: a cell needs 5 distinct holders and its largest holder at most 60% of the cell; the paired fees (`stripe_fees` with `payments_count`, `dispute_fees` with `disputes_opened`) and the sums (complement) are hidden together; a derived KPI is hidden when any input is; under 10 active payers the whole document is quarterly.",
	"",
	"- **grain**: `month` (12 or 24 periods) or `quarter`, chosen once per document from the active payers over the last 12 months.",
	"- **cells**: every exported KPI times every period. A cell nobody contributes to whose amount is 0 is shown as 0 (it discloses nothing), so a quiet month counts as shown.",
	"- **hidden**: the cell is `null` in the document. The reasons: `few_holders` (under 5 holders, or an amount with no contribution data), `dominant_holder` (the largest holder is over 60%, or the cell nets to 0 with contributors), `complement` (a term hidden to protect a hidden sibling of a visible sum), `derived_input` (a ratio or combine with a hidden input), `paired_fee` (the fee or count paired with a hidden one), `few_providers` and `dominant_provider` (no event carries a provider label, so these do not occur).",
	"- **periods hidden**: `all N` when every period, else the hidden periods (`a..b` is a run of consecutive ones).",
	"- **% hidden**: hidden cells over all cells, zeros included, so it understates how much of the *informative* data is hidden in a quiet preset.",
	"",
	"The report carries counts, shares and periods only: no holder id and no hash of unsuppressed data.",
].join("\n");

export const suppressionReport = async (): Promise<string> => {
	const analyses = new Map<string, PresetAnalysis>();
	for (const profile of PROFILES)
		analyses.set(profile.name, await analysePreset(profile.name));
	const ordered = [...analyses.values()];
	const summary = [
		"| preset | grain | active payers | periods | cells shown | cells hidden | % hidden |",
		"|---|---|---:|---:|---:|---:|---:|",
		...ordered.map((analysis) => {
			const { total, shown, hidden } = countsOf(analysis.document);
			return `| ${analysis.profile.name} | ${analysis.document.grain} | ${analysis.activePayers} | ${analysis.document.periods.length} | ${shown} | ${hidden} | ${percent(hidden, total)} |`;
		}),
	].join("\n");
	return `${[
		"# Suppression report",
		"",
		"Generated by `bun run suppression-report` (fixtures/suppression-report.ts); tests/suppression-report.test.ts fails when this file is stale (`UPDATE_GOLDEN=1` rewrites it).",
		"",
		"## Summary",
		"",
		summary,
		"",
		"## How to read it",
		"",
		HOW_TO_READ,
		"",
		"## Findings",
		"",
		findings(analyses),
		"",
		"## Per preset",
		"",
		ordered.map(presetSection).join("\n"),
	]
		.join("\n")
		.trimEnd()}\n`;
};

if (import.meta.main) {
	writeFileSync(REPORT_PATH, await suppressionReport());
	console.log(`wrote ${REPORT_PATH}`);
}
