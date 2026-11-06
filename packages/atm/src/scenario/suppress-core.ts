/**
 * KPI suppression for a school's dashboard document (spec "Export content and suppression"). A pure function over the
 * long KPI rows and the per-holder shares behind each base cell. Worker-safe: it imports no Ajv and no event fold (`kpi-evaluate.ts`,
 * not `kpis.ts`), so `atm/worker` exports it; `suppress.ts` re-exports it and adds the event fold.
 *
 * Rules, in the order they run:
 * 1. Cell rules: a base cell is shown only if at least `minContributors` distinct holders contribute (nonzero share) and
 *    the largest holder's absolute share is at most `maxShare` of the cell's absolute amount (integer math, no floats).
 *    A cell nobody contributes to and whose amount is 0 is empty: it is shown as 0 (it discloses nothing) unless
 *    `hideEmptyCells`. A nonzero cell with no contribution data is hidden (`few_holders`). Contributors but a total of 0
 *    (offsetting signs) cannot be tested for dominance, so it is hidden as `dominant_holder`; a negative total is tested
 *    on its absolute value, and a holder whose absolute share exceeds the total's (mixed signs) is dominant.
 * 2. Provider rule: the cells in `providerRuleKpis` also need both tests on distinct providers, when provider
 *    contributions are supplied.
 * 3. Paired fees: each pair in `pairedKpis` is hidden together, in both directions.
 * 4. Complementary suppression, to a fixed point: where the total of a sum is shown and exactly one term is hidden, the
 *    smallest visible term is hidden too (a term with a nonzero amount before an empty one), so the hidden one cannot be
 *    recovered by subtraction. Sums come from `sumGroups` (default: each `combine` KPI over its terms, plus
 *    `DEFAULT_FAMILY_SUMS`: revenue by kind sums to gross collected, revenue by tier to the membership kind).
 * 5. Derived KPIs (ratio, combine) are hidden when any input of the same period is hidden.
 * 6. Grain: under `minActivePayers` active payers the document is quarterly: base values and shares are aggregated per
 *    quarter first (a cumulative balance takes the quarter's last month, a distinct count is the union of holders) and the
 *    derived KPIs are evaluated from the aggregated base, then every rule above runs on the quarters.
 *
 * The result carries no holder or provider id. `hiddenCells` is for the job's own report: its contributor counts and
 * shares describe cells the viewer must not learn, so it is never served.
 */
import {
	type BaseValues,
	evaluateKpis,
	isBase,
	type KpiRow,
	type KpiSpec,
	kpiRootId,
} from "./kpi-evaluate.js";

export type SuppressionReason =
	| "few_holders"
	| "dominant_holder"
	| "few_providers"
	| "dominant_provider"
	| "complement"
	| "derived_input"
	| "paired_fee";

/** Each contributor's (holder's or provider's) share of one cell's amount; a count for count and distinct KPIs. */
export type Shares = Record<string, number>;
/** `<kpiId>` or `<kpiId>:<dimension>` to period to shares. */
export type Contributions = Record<string, Record<string, Shares>>;

/** `null` is a suppressed cell (the document's reason is `suppressed`; `SuppressedDocument.reasons` has the detail). */
export type SuppressedCell = number | null;

export type SuppressionRules = { minContributors: number; maxShare: number };
export const DEFAULT_RULES: SuppressionRules = {
	minContributors: 5,
	maxShare: 0.6,
};
export const MIN_ACTIVE_PAYERS = 10;
export const ROLLING_MONTHS = 12;

/** The cells whose providers (tutors) are protected too. */
export const PROVIDER_RULE_KPIS: readonly string[] = [
	"credits_consumed",
	"revenue_by_kind:booking",
];
/** Pairs hidden together: a fee gives away its count (a dispute fee is a fixed amount). */
export const PAIRED_KPIS: readonly (readonly [string, string])[] = [
	["stripe_fees", "payments_count"],
	["dispute_fees", "disputes_opened"],
];

/** A total and the terms that add up to it: a KPI id, or every dimension of a family. */
export type SumGroup = {
	total: string;
	terms: readonly string[] | { family: string };
};
/** Dimensioned families that add up to a total the spec does not state: its `by` patterns split the same payments. */
export const DEFAULT_FAMILY_SUMS: readonly { total: string; family: string }[] =
	[
		{ total: "gross_collected", family: "revenue_by_kind" },
		{ total: "revenue_by_kind:membership", family: "revenue_by_tier" },
	];

const LEDGER_ACCOUNT_CLASSES = /^(assets|income|expenses):/;
const HOLDER_ID = /(family|profile):/;

/** Closing balances of credit accounts name holders and are not exported; USD balances only for asset, income and expense accounts. */
export const isExportableKpiId = (id: string): boolean => {
	if (HOLDER_ID.test(id)) return false;
	const [root = "", ...rest] = id.split(":");
	if (root === "closing_balance_credits") return false;
	if (root === "closing_balance_usd")
		return LEDGER_ACCOUNT_CLASSES.test(rest.join(":"));
	return true;
};

export type SuppressedCellInfo = {
	kpiId: string;
	period: string;
	reason: SuppressionReason;
	/** Distinct contributors the test counted (providers for a provider reason); null for a derived cell. */
	contributors: number | null;
	/** The largest contributor's share of the cell, 4 decimals; null for a derived cell. */
	largestShare: number | null;
};

export type SuppressedDocument = {
	grain: "month" | "quarter";
	periods: string[];
	rules: SuppressionRules;
	activePayers: number;
	series: Record<string, SuppressedCell[]>;
	/** Parallel to `series`: why a cell is null, else null. */
	reasons: Record<string, (SuppressionReason | null)[]>;
	hiddenCells: SuppressedCellInfo[];
};

export type SuppressInput = {
	spec: KpiSpec;
	rows: readonly KpiRow[];
	contributions: Contributions;
	providerContributions?: Contributions;
	/** Distinct holders with a payment over the rolling 12 months. */
	activePayers: number;
	rules?: Partial<SuppressionRules>;
	minActivePayers?: number;
	providerRuleKpis?: readonly string[];
	pairedKpis?: readonly (readonly [string, string])[];
	sumGroups?: readonly SumGroup[];
	hideEmptyCells?: boolean;
	isExportable?: (kpiId: string) => boolean;
};

const SCALE = 1_000_000;

const toBig = (n: number): bigint => {
	if (!Number.isInteger(n))
		throw new Error(`suppression needs whole-number amounts, got ${n}`);
	return BigInt(n);
};

const roundShare = (n: number): number => Math.round(n * 10_000) / 10_000;

const quarterOf = (period: string): string => {
	const [year, month] = period.split("-") as [string, string];
	return `${year}-Q${Math.floor((Number(month) - 1) / 3) + 1}`;
};

/** What the two tests say about one cell's shares: the first failing reason, else null. */
const testShares = ({
	shares,
	total,
	rules,
	reasons,
}: {
	shares: Shares;
	total: number;
	rules: SuppressionRules;
	reasons: { few: SuppressionReason; dominant: SuppressionReason };
}): {
	reason: SuppressionReason | null;
	contributors: number;
	largestShare: number;
} => {
	const amounts = Object.values(shares).filter((n) => n !== 0);
	const contributors = amounts.length;
	const largest = amounts.reduce((m, n) => Math.max(m, Math.abs(n)), 0);
	const absoluteTotal = Math.abs(total);
	const largestShare =
		absoluteTotal > 0
			? roundShare(largest / absoluteTotal)
			: contributors > 0
				? 1
				: 0;
	if (contributors < rules.minContributors)
		return { reason: reasons.few, contributors, largestShare };
	const maxScaled = BigInt(Math.round(rules.maxShare * SCALE));
	const dominant =
		absoluteTotal === 0 ||
		toBig(largest) * BigInt(SCALE) > toBig(absoluteTotal) * maxScaled;
	return {
		reason: dominant ? reasons.dominant : null,
		contributors,
		largestShare,
	};
};

type Aggregated = {
	rows: KpiRow[];
	contributions: Contributions;
	providerContributions: Contributions | undefined;
	periods: string[];
};

const baseOf = (spec: KpiSpec, rows: readonly KpiRow[]): BaseValues => {
	const baseIds = new Set(spec.kpis.filter(isBase).map((kpi) => kpi.id));
	const out: BaseValues = {};
	for (const row of rows) {
		if (!baseIds.has(kpiRootId(row.kpiId))) continue;
		const values = out[row.kpiId] ?? {};
		out[row.kpiId] = values;
		values[row.period] = row.value;
	}
	return out;
};

const aggregateShares = ({
	contributions,
	spec,
	months,
}: {
	contributions: Contributions;
	spec: KpiSpec;
	months: Map<string, string[]>;
}): Contributions => {
	const kpiById = new Map(spec.kpis.map((kpi) => [kpi.id, kpi]));
	const out: Contributions = {};
	for (const [id, byPeriod] of Object.entries(contributions)) {
		const kpi = kpiById.get(kpiRootId(id));
		if (!kpi || !isBase(kpi)) continue;
		const compute = kpi.compute;
		const cumulative = compute.op === "sum" && compute.cumulative;
		const aggregated: Record<string, Shares> = {};
		for (const [quarter, quarterMonths] of months) {
			const merged: Shares = {};
			if (cumulative) {
				const last = quarterMonths.at(-1) as string;
				for (const [holder, n] of Object.entries(byPeriod[last] ?? {}))
					if (n !== 0) merged[holder] = n;
			} else
				for (const month of quarterMonths)
					for (const [holder, n] of Object.entries(byPeriod[month] ?? {})) {
						const next =
							compute.op === "distinct" ? 1 : (merged[holder] ?? 0) + n;
						if (next === 0) delete merged[holder];
						else merged[holder] = next;
					}
			aggregated[quarter] = merged;
		}
		out[id] = aggregated;
	}
	return out;
};

/** Monthly rows and shares to quarterly ones; the derived KPIs are re-evaluated from the aggregated base. */
const toQuarters = ({
	spec,
	rows,
	contributions,
	providerContributions,
	periods,
}: {
	spec: KpiSpec;
	rows: readonly KpiRow[];
	contributions: Contributions;
	providerContributions: Contributions | undefined;
	periods: string[];
}): Aggregated => {
	const months = new Map<string, string[]>();
	for (const period of periods) {
		const quarter = quarterOf(period);
		months.set(quarter, [...(months.get(quarter) ?? []), period]);
	}
	const quarters = [...months.keys()];
	const holders = aggregateShares({ contributions, spec, months });
	const providers = providerContributions
		? aggregateShares({ contributions: providerContributions, spec, months })
		: undefined;
	const kpiById = new Map(spec.kpis.map((kpi) => [kpi.id, kpi]));
	const monthly = baseOf(spec, rows);
	const base: BaseValues = {};
	for (const [id, byPeriod] of Object.entries(monthly)) {
		const compute = (
			kpiById.get(kpiRootId(id)) as {
				compute: { op: string; cumulative?: boolean };
			}
		).compute;
		const values: Record<string, number> = {};
		for (const [quarter, quarterMonths] of months) {
			if (compute.op === "sum" && compute.cumulative)
				values[quarter] = byPeriod[quarterMonths.at(-1) as string] ?? 0;
			else if (compute.op === "distinct" && holders[id])
				values[quarter] = Object.keys(holders[id][quarter] ?? {}).length;
			else
				values[quarter] = quarterMonths.reduce(
					(n, month) => n + (byPeriod[month] ?? 0),
					0,
				);
		}
		base[id] = values;
	}
	return {
		rows: evaluateKpis({ spec, base, periods: quarters }),
		contributions: holders,
		providerContributions: providers,
		periods: quarters,
	};
};

const keyOf = (id: string, period: string) => `${id}\u0000${period}`;

export const suppressKpis = (input: SuppressInput): SuppressedDocument => {
	const rules: SuppressionRules = { ...DEFAULT_RULES, ...input.rules };
	const minActivePayers = input.minActivePayers ?? MIN_ACTIVE_PAYERS;
	const providerRuleKpis = new Set(
		input.providerRuleKpis ?? PROVIDER_RULE_KPIS,
	);
	const pairedKpis = input.pairedKpis ?? PAIRED_KPIS;
	const isExportable = input.isExportable ?? isExportableKpiId;
	const monthlyPeriods = [...new Set(input.rows.map((r) => r.period))].sort();
	const grain = input.activePayers < minActivePayers ? "quarter" : "month";

	// evaluating again from the base rows keeps month and quarter on one path
	const monthly: Aggregated = {
		rows: evaluateKpis({
			spec: input.spec,
			base: baseOf(input.spec, input.rows),
			periods: monthlyPeriods,
		}),
		contributions: input.contributions,
		providerContributions: input.providerContributions,
		periods: monthlyPeriods,
	};
	const { rows, contributions, providerContributions, periods } =
		grain === "quarter"
			? toQuarters({
					spec: input.spec,
					rows: input.rows,
					contributions: input.contributions,
					providerContributions: input.providerContributions,
					periods: monthlyPeriods,
				})
			: monthly;

	const amountOf = new Map<string, number>();
	const ids: string[] = [];
	for (const row of rows) {
		if (!isExportable(row.kpiId)) continue;
		amountOf.set(keyOf(row.kpiId, row.period), row.value);
		if (!ids.includes(row.kpiId)) ids.push(row.kpiId);
	}

	const hidden = new Map<string, SuppressedCellInfo>();
	const hide = (info: SuppressedCellInfo): boolean => {
		const key = keyOf(info.kpiId, info.period);
		if (hidden.has(key)) return false;
		hidden.set(key, info);
		return true;
	};
	const infoOf = new Map<
		string,
		{ contributors: number; largestShare: number }
	>();

	const baseIds = ids.filter((id) => {
		const kpi = input.spec.kpis.find((k) => k.id === kpiRootId(id));
		return kpi !== undefined && isBase(kpi);
	});

	// 1 and 2: the cell rules
	for (const id of baseIds)
		for (const period of periods) {
			const total = amountOf.get(keyOf(id, period)) as number;
			const shares = contributions[id]?.[period] ?? {};
			const holders = testShares({
				shares,
				total,
				rules,
				reasons: { few: "few_holders", dominant: "dominant_holder" },
			});
			infoOf.set(keyOf(id, period), holders);
			if (holders.contributors === 0 && total === 0) {
				if (input.hideEmptyCells)
					hide({
						kpiId: id,
						period,
						reason: "few_holders",
						contributors: holders.contributors,
						largestShare: holders.largestShare,
					});
				continue;
			}
			if (holders.reason) {
				hide({
					kpiId: id,
					period,
					reason: holders.reason,
					contributors: holders.contributors,
					largestShare: holders.largestShare,
				});
				continue;
			}
			if (providerContributions && providerRuleKpis.has(id)) {
				const providers = testShares({
					shares: providerContributions[id]?.[period] ?? {},
					total,
					rules,
					reasons: { few: "few_providers", dominant: "dominant_provider" },
				});
				if (providers.reason)
					hide({
						kpiId: id,
						period,
						reason: providers.reason,
						contributors: providers.contributors,
						largestShare: providers.largestShare,
					});
			}
		}

	// 3 and 4: paired fees and the sums, until nothing more is hidden
	const groups = [...(input.sumGroups ?? defaultSumGroups(input.spec))];
	const termsOf = (group: SumGroup): string[] =>
		"family" in group.terms
			? ids.filter((id) =>
					id.startsWith(`${(group.terms as { family: string }).family}:`),
				)
			: [...group.terms];
	const hideDerived = (id: string, period: string, reason: SuppressionReason) =>
		hide({
			kpiId: id,
			period,
			reason,
			contributors: infoOf.get(keyOf(id, period))?.contributors ?? null,
			largestShare: infoOf.get(keyOf(id, period))?.largestShare ?? null,
		});
	const pair = (): boolean => {
		let changed = false;
		for (const [left, right] of pairedKpis)
			for (const period of periods) {
				if (
					!(
						amountOf.has(keyOf(left, period)) &&
						amountOf.has(keyOf(right, period))
					)
				)
					continue;
				const leftHidden = hidden.has(keyOf(left, period));
				const rightHidden = hidden.has(keyOf(right, period));
				if (leftHidden && !rightHidden)
					changed = hideDerived(right, period, "paired_fee") || changed;
				else if (rightHidden && !leftHidden)
					changed = hideDerived(left, period, "paired_fee") || changed;
			}
		return changed;
	};
	const complement = (): boolean => {
		let changed = false;
		for (const group of groups) {
			const terms = termsOf(group);
			for (const period of periods) {
				if (!amountOf.has(keyOf(group.total, period))) continue;
				if (hidden.has(keyOf(group.total, period))) continue;
				const present = terms.filter((id) => amountOf.has(keyOf(id, period)));
				const hiddenTerms = present.filter((id) =>
					hidden.has(keyOf(id, period)),
				);
				if (hiddenTerms.length !== 1) continue;
				// the smallest visible term, a nonzero one before an empty one (hiding a zero protects least)
				const [next] = present
					.filter((id) => !hidden.has(keyOf(id, period)))
					.map((id) => ({
						id,
						amount: Math.abs(amountOf.get(keyOf(id, period)) as number),
					}))
					.sort(
						(a, b) =>
							Number(a.amount === 0) - Number(b.amount === 0) ||
							a.amount - b.amount ||
							(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
					);
				if (next)
					changed = hideDerived(next.id, period, "complement") || changed;
			}
		}
		return changed;
	};
	let changed = true;
	while (changed) {
		changed = pair();
		changed = complement() || changed;
	}

	// 5: a derived cell is hidden when any input of its period is
	for (const kpi of input.spec.kpis) {
		const compute = kpi.compute;
		if (compute.op !== "ratio" && compute.op !== "combine") continue;
		const inputs =
			compute.op === "ratio"
				? [compute.num, compute.den]
				: compute.terms.map((term) => term.kpi);
		for (const period of periods)
			if (
				amountOf.has(keyOf(kpi.id, period)) &&
				inputs.some((id) => hidden.has(keyOf(id, period)))
			)
				hide({
					kpiId: kpi.id,
					period,
					reason: "derived_input",
					contributors: null,
					largestShare: null,
				});
	}

	const series: Record<string, SuppressedCell[]> = {};
	const reasons: Record<string, (SuppressionReason | null)[]> = {};
	for (const id of ids) {
		series[id] = periods.map((period) =>
			hidden.has(keyOf(id, period))
				? null
				: (amountOf.get(keyOf(id, period)) as number),
		);
		reasons[id] = periods.map(
			(period) => hidden.get(keyOf(id, period))?.reason ?? null,
		);
	}
	const hiddenCells = [...hidden.values()].sort(
		(a, b) =>
			(a.kpiId < b.kpiId ? -1 : a.kpiId > b.kpiId ? 1 : 0) ||
			(a.period < b.period ? -1 : a.period > b.period ? 1 : 0),
	);
	return {
		grain,
		periods,
		rules,
		activePayers: input.activePayers,
		series,
		reasons,
		hiddenCells,
	};
};

/** The sums of the spec: each `combine` over its terms, and the default families whose KPIs the spec has. */
export const defaultSumGroups = (spec: KpiSpec): SumGroup[] => {
	const known = new Set(spec.kpis.map((kpi) => kpi.id));
	const groups: SumGroup[] = [];
	for (const kpi of spec.kpis)
		if (kpi.compute.op === "combine")
			groups.push({
				total: kpi.id,
				terms: kpi.compute.terms.map((term) => term.kpi),
			});
	for (const { total, family } of DEFAULT_FAMILY_SUMS)
		if (known.has(kpiRootId(total)) && known.has(family))
			groups.push({ total, terms: { family } });
	return groups;
};
