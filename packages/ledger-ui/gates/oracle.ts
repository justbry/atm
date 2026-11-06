/**
 * The KPI oracle (protocol §4, §5 C3): the v3 KPI document for one preset, viewer and grain, computed from atm's own
 * export rows, the mart bundle (`contrib`, `tiers`, `mrr`, `params.currency`) and `cell-rules`. Pure: no I/O, no clock
 * reads. `scripts/import-mart.ts` writes its output as the fixtures; `test/consistency.test.ts` recomputes it.
 */
import type {
	Cell,
	Grain,
	HiddenKind,
	KpiDocument,
	KpiFormat,
	KpiMeta,
	Viewer,
} from "../src/data/kpi-document.ts";

export type KpiRow = {
	kpiId: string;
	period: string;
	unit: string;
	value: number;
};
/** `[distinct holders, largest holder's share]` for one period, or null when the mart has none. */
export type ContribEntry = [number, number] | null;
/** One preset of `M/bundle.json`; arrays are indexed like `periods`. */
export type PresetBundle = {
	periods: string[];
	params: { currency?: string };
	contrib: Record<string, ContribEntry[] | undefined>;
	tiers: Record<string, number[]>;
	mrr: { mrr_cents: number[]; churned_members: number[] };
};
type Kind = "amount" | "count" | "rate";
type Policy = "contrib" | "self" | "derived" | "blocked" | "demo-only";
type KpiRule = {
	kind: Kind;
	policy: Policy;
	contrib?: string;
	format?: KpiFormat;
	inputs?: string[];
	denominator?: string;
	rateOf?: "amount" | "count";
	source?: string;
};
type ViewerRule = {
	amount: string;
	count: string;
	rate: string;
	openPeriod: string;
};
/** The parts of `cell-rules.v2.json` the oracle reads. */
export type CellRules = {
	rule: { minContributors: number; maxShare: number };
	kpis: Record<string, KpiRule>;
	viewers: Record<Viewer, ViewerRule>;
	quarter: { distinctCounts: string[]; distinctCountsCell: string };
	complementary: Array<{ total: string; terms: string }>;
};
export type KpiDocumentInput = {
	rows: readonly KpiRow[];
	bundle: PresetBundle;
	rules: CellRules;
	preset: string;
	viewer: Viewer;
	grain: Grain;
	clock: { today: string; now: string };
};

type Mode = "exact" | "rule" | "band" | "locked";
/** A cell before its hidden kinds are resolved: every reason it is hidden, and its value when it has one. */
type Draft = { hidden: Set<HiddenKind>; value: number | undefined };

/** Spec v3 and protocol §5 C3: the strongest reason wins. */
const precedence: readonly HiddenKind[] = [
	"blocked",
	"open_period",
	"locked",
	"not_computed",
	"suppressed",
];
/** `cell-rules.band.formula`: `value == 0 ? 0 : { lt: 5 * (floor(value / 5) + 1) }`. */
const bandWidth = 5;
/** atm's ratio precision for refund, dispute and breakage rates (`kpis/school.v1.json`). */
const ratioPrecision = 4;
const schoolName = "Before University";
const timeZone = "America/Denver";
const kpiSpecVersion = "school.v1";
const lagMinutes = 2;

/** atm's KPI titles (`packages/atm/kpis/school.v1.json`), plus the mart-derived demo KPIs. */
const titles: Record<string, string> = {
	gross_collected: "Gross collected",
	stripe_fees: "Stripe fees",
	payouts: "Payouts",
	refunds: "Refunds",
	refunds_count: "Refunds issued",
	disputes_lost: "Disputes lost",
	dispute_fees: "Dispute fees",
	disputes_opened: "Disputes opened",
	paying_members: "Paying members",
	payments_count: "Payments",
	new_paying_members: "New paying members",
	credits_granted: "Credits granted",
	credits_consumed: "Credits consumed",
	credits_expired: "Credits expired",
	net_income: "Net income",
	arpa: "Gross collected per paying member",
	refund_rate: "Refund rate",
	dispute_rate: "Dispute rate",
	breakage_rate: "Breakage rate",
	credits_outstanding: "Credits outstanding",
	mrr: "MRR",
	arr: "ARR",
	churned_members: "Churned members",
};

/** atm's `roundedRatio` (`packages/atm/src/scenario/kpis.ts`): half up, away from zero, on integers. */
const roundedRatio = (numerator: number, denominator: number): number => {
	if (!Number.isInteger(numerator) || !Number.isInteger(denominator))
		throw new Error(`ratio of non-integers ${numerator}/${denominator}`);
	const scale = 10n ** BigInt(ratioPrecision);
	const scaled = BigInt(numerator) * scale;
	const divisor = BigInt(denominator);
	const negative = scaled < 0n !== divisor < 0n;
	const absolute = (value: bigint): bigint => (value < 0n ? -value : value);
	const quotient =
		(2n * absolute(scaled) + absolute(divisor)) / (2n * absolute(divisor));
	return Number(negative ? -quotient : quotient) / Number(scale);
};

const quarterOf = (month: string): string =>
	`${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`;

/** Everything the oracle knows about the viewer. The rest of the oracle reads only this, so a different viewer model
 * (for example per-level access with its own grain, delay and rounding) replaces this one function. */
type ViewerPolicy = {
	/** How a KPI's own value is shown: exact, through the cell rule, banded, or locked. */
	mode: (rule: KpiRule) => Mode;
	/** The open period comes back as `open_period`. */
	hidesOpenPeriod: boolean;
	/** Demo-only KPIs are shown (otherwise not_computed and listed in notComputed). */
	showsDemoOnly: boolean;
};
/** cell-rules `viewers`: one row per viewer, read as written. */
const viewerPolicy = (rules: CellRules, viewer: Viewer): ViewerPolicy => {
	const row = rules.viewers[viewer];
	if (row.openPeriod !== "shown" && row.openPeriod !== "open_period")
		throw new Error(`unknown open-period policy for ${viewer}`);
	return {
		mode: (rule) => {
			const text =
				rule.kind === "amount"
					? row.amount
					: rule.kind === "count"
						? row.count
						: row.rate;
			if (text === "locked if rateOf amount, else exact")
				return rule.rateOf === "amount" ? "locked" : "exact";
			if (text === "band" && rule.kind !== "count")
				throw new Error(`band applies to counts only (${viewer})`);
			if (
				text === "exact" ||
				text === "rule" ||
				text === "band" ||
				text === "locked"
			)
				return text;
			throw new Error(`unknown viewer policy ${viewer}.${rule.kind}: ${text}`);
		},
		hidesOpenPeriod: row.openPeriod === "open_period",
		showsDemoOnly: viewer === "demo",
	};
};

const formatOf = (rule: KpiRule): KpiFormat =>
	rule.format ??
	(rule.kind === "amount"
		? "money"
		: rule.kind === "count"
			? "integer"
			: "percent1");

const metaOf = (id: string, rule: KpiRule): KpiMeta => {
	const format = formatOf(rule);
	const dimension = id.includes(":") ? id.slice(id.indexOf(":") + 1) : "";
	return {
		title:
			titles[id] ??
			(dimension
				? `${dimension.charAt(0).toUpperCase()}${dimension.slice(1)}`
				: id),
		unit:
			rule.kind === "amount"
				? "cents"
				: rule.kind === "count"
					? "count"
					: "ratio",
		precision: format === "money" ? 2 : format === "percent1" ? 1 : 0,
		format,
		derived: rule.policy === "derived" || rule.policy === "demo-only",
		demoOnly: rule.policy === "demo-only",
	};
};

/** The document's KPI ids in `cell-rules` order, a `<kpi>:*` entry expanded over the bundle's tiers. */
const expandIds = (
	rules: CellRules,
	bundle: PresetBundle,
): Array<{ id: string; rule: KpiRule }> =>
	Object.entries(rules.kpis).flatMap(([key, rule]) => {
		if (!key.endsWith(":*")) return [{ id: key, rule }];
		const prefix = key.slice(0, -1);
		return Object.keys(bundle.tiers)
			.sort()
			.map((tier) => {
				const contrib = rule.contrib?.replace(/<[^>]+>/, tier);
				return {
					id: `${prefix}${tier}`,
					rule: contrib === undefined ? rule : { ...rule, contrib },
				};
			});
	});

const resolve = (draft: Draft, mode: Mode): Cell => {
	const reason = precedence.find((kind) => draft.hidden.has(kind));
	if (reason) return { hidden: reason };
	const value = draft.value;
	if (value === undefined) return { hidden: "not_computed" };
	if (mode === "band" && value !== 0)
		return { lt: bandWidth * (Math.floor(value / bandWidth) + 1) };
	return value;
};

export function kpiDocument(input: KpiDocumentInput): KpiDocument {
	const { rows, bundle, rules, preset, viewer, grain, clock } = input;
	const year = Number(clock.today.slice(0, 4));
	const clockMonth = clock.today.slice(0, 7);
	const months = bundle.periods.filter(
		(period) => period.startsWith(`${year}-`) && period <= clockMonth,
	);
	const hasOpen = bundle.periods.includes(clockMonth);
	const periods =
		grain === "month" ? months : [...new Set(months.map(quarterOf))];
	const openPeriod = hasOpen
		? grain === "month"
			? clockMonth
			: quarterOf(clockMonth)
		: null;
	const monthsOf = (period: string): string[] =>
		grain === "month"
			? [period]
			: months.filter((month) => quarterOf(month) === period);
	const policy = viewerPolicy(rules, viewer);

	const rowValue = new Map(
		rows.map((row) => [`${row.kpiId}@${row.period}`, row.value]),
	);
	const kpis = expandIds(rules, bundle);
	const ruleOf = new Map(kpis.map(({ id, rule }) => [id, rule]));
	const distinct = new Set(rules.quarter.distinctCounts);
	const { minContributors, maxShare } = rules.rule;

	/** The summed rows of the period's months; undefined when any month has no row. */
	const raw = (id: string, period: string): number | undefined => {
		let total = 0;
		for (const month of monthsOf(period)) {
			const value = rowValue.get(`${id}@${month}`);
			if (value === undefined) return undefined;
			total += value;
		}
		return total;
	};
	/** Whether one month passes the cell rule (cell-rules `policies`), or why not. */
	const monthCheck = (
		id: string,
		rule: KpiRule,
		month: string,
	): HiddenKind | null => {
		const value = rowValue.get(`${id}@${month}`);
		if (value === undefined) return "not_computed";
		if (value === 0) return null;
		if (rule.policy === "self")
			return value >= minContributors ? null : "suppressed";
		const entry =
			bundle.contrib[rule.contrib ?? id]?.[bundle.periods.indexOf(month)];
		if (!entry) return "not_computed";
		const [holders, largestShare] = entry;
		return holders >= minContributors && largestShare <= maxShare
			? null
			: "suppressed";
	};

	const drafts = new Map<string, Draft>();
	const draftOf = (id: string, period: string): Draft => {
		const key = `${id}@${period}`;
		const known = drafts.get(key);
		if (known) return known;
		const rule = ruleOf.get(id);
		if (!rule) throw new Error(`${id} is not in cell-rules`);
		const draft = computeDraft(id, rule, period);
		drafts.set(key, draft);
		return draft;
	};
	const computeDraft = (id: string, rule: KpiRule, period: string): Draft => {
		const hidden = new Set<HiddenKind>();
		if (rule.policy === "blocked")
			return { hidden: new Set(["blocked"]), value: undefined };
		if (policy.hidesOpenPeriod && period === openPeriod)
			hidden.add("open_period");
		if (rule.policy === "demo-only") {
			if (
				!policy.showsDemoOnly ||
				(grain === "quarter" && rule.kind !== "count")
			)
				return { hidden: new Set(["not_computed"]), value: undefined };
			let total = 0;
			for (const month of monthsOf(period)) {
				const index = bundle.periods.indexOf(month);
				const value =
					id === "churned_members"
						? bundle.mrr.churned_members[index]
						: bundle.mrr.mrr_cents[index];
				if (value === undefined) hidden.add("not_computed");
				else total += id === "arr" ? 12 * value : value;
			}
			return { hidden, value: total };
		}
		const mode = policy.mode(rule);
		if (mode === "locked") hidden.add("locked");
		if (rule.policy === "derived") {
			for (const inputId of rule.inputs ?? [])
				for (const kind of draftOf(inputId, period).hidden)
					if (kind !== "blocked") hidden.add(kind);
			const denominator = rule.denominator
				? raw(rule.denominator, period)
				: undefined;
			if (rule.denominator && denominator === 0) hidden.add("not_computed");
			if (grain === "month")
				return { hidden, value: rowValue.get(`${id}@${period}`) };
			if (rule.kind !== "rate") return { hidden, value: raw(id, period) };
			const [numeratorId] = rule.inputs ?? [];
			const numerator = numeratorId ? raw(numeratorId, period) : undefined;
			return {
				hidden,
				value:
					numerator === undefined || denominator === undefined
						? undefined
						: denominator === 0
							? undefined
							: roundedRatio(numerator, denominator),
			};
		}
		if (grain === "quarter" && distinct.has(id)) {
			hidden.add("not_computed");
			return { hidden, value: undefined };
		}
		const value = raw(id, period);
		if (value === undefined) hidden.add("not_computed");
		if (mode === "rule")
			for (const month of monthsOf(period)) {
				const failure = monthCheck(id, rule, month);
				if (failure) hidden.add(failure);
			}
		return { hidden, value };
	};

	const series: Record<string, Cell[]> = {};
	for (const { id, rule } of kpis) {
		const mode =
			rule.policy === "contrib" ||
			rule.policy === "self" ||
			rule.policy === "derived"
				? policy.mode(rule)
				: "exact";
		series[id] = periods.map((period) => resolve(draftOf(id, period), mode));
	}

	for (const { total, terms } of rules.complementary) {
		const prefix = terms.endsWith("*") ? terms.slice(0, -1) : terms;
		const termIds = kpis
			.map(({ id }) => id)
			.filter((id) => id.startsWith(prefix));
		periods.forEach((period, index) => {
			if (typeof series[total]?.[index] !== "number") return;
			const suppressed = termIds.filter((id) => {
				const cell = series[id]?.[index];
				return (
					typeof cell === "object" &&
					"hidden" in cell &&
					cell.hidden === "suppressed"
				);
			});
			if (suppressed.length !== 1) return;
			const shown = termIds
				.map((id) => ({ id, value: series[id]?.[index] }))
				.filter(
					(term): term is { id: string; value: number } =>
						typeof term.value === "number" && term.value !== 0,
				)
				.sort((first, second) => first.value - second.value);
			const next = shown[0];
			if (!next)
				throw new Error(
					`${preset} ${viewer} ${period}: ${suppressed[0]} is the only non-zero term of ${total}, so complementary suppression cannot hide it`,
				);
			const cells = series[next.id];
			if (cells) cells[index] = { hidden: "suppressed" };
		});
	}

	const notComputed: Array<{ id: string; reason: string }> = [];
	for (const { id, rule } of kpis) {
		if (rule.policy === "demo-only" && !policy.showsDemoOnly)
			notComputed.push({
				id,
				reason: "derived from the mart, shown in the demo only",
			});
		else if (
			rule.policy === "demo-only" &&
			grain === "quarter" &&
			rule.kind !== "count"
		)
			notComputed.push({
				id,
				reason: "a monthly rate: not computed per quarter",
			});
		else if (grain === "quarter" && distinct.has(id))
			notComputed.push({
				id,
				reason: rules.quarter.distinctCountsCell.replace(
					/^not_computed:\s*/,
					"",
				),
			});
		else if (grain === "quarter" && rule.policy === "derived") {
			const needs = (rule.inputs ?? []).find((inputId) =>
				distinct.has(inputId),
			);
			if (needs)
				notComputed.push({
					id,
					reason: `needs ${needs}, which is not computed per quarter`,
				});
		}
	}

	return {
		school: schoolName,
		preset,
		viewer,
		year,
		basis: "cash",
		currency: bundle.params.currency ?? "usd",
		tz: timeZone,
		kpiSpecVersion,
		grain,
		asOf: clock.now,
		lagMinutes,
		partialPeriods: openPeriod ? [openPeriod] : [],
		rules: { minContributors, maxShare },
		periods,
		series,
		meta: Object.fromEntries(
			kpis.map(({ id, rule }) => [id, metaOf(id, rule)]),
		),
		notComputed,
		verified: true,
	};
}
