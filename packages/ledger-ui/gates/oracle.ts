/**
 * The KPI oracle (protocol §4, §5 C3, §11b): the KPI document for one preset, books level and PIN state, computed
 * from atm's own export rows, the mart bundle (`contrib`, `tiers`, `params.currency`) and `cell-rules` v3 (which also
 * carries the mockup's invented fixtures: earlier years, the daily split, B4 Uni's donors). Pure: no I/O, no clock
 * reads. `scripts/import-mart.ts` writes its output as the fixtures; `test/consistency.test.ts` recomputes it.
 */
import type {
	BooksLevel,
	Cell,
	Grain,
	HiddenKind,
	KpiDocument,
	KpiFormat,
	KpiMeta,
	LagClass,
	PeriodInfo,
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
};
type Kind = "amount" | "count" | "rate";
type Policy = "contrib" | "self" | "derived" | "blocked" | "distribution";
type Step = "G1" | "G2" | "G3" | "G4";
type KpiRule = {
	kind: Kind;
	policy: Policy;
	step: Step;
	lag: LagClass;
	contrib?: string;
	format?: KpiFormat;
	inputs?: string[];
	denominator?: string;
	rateOf?: "amount" | "count";
	aggregate?: "max" | "not_computed";
};
type LevelRule = {
	name: string;
	steps: "G2" | "G4" | "G6";
	grain: "year" | "quarter" | "month" | "month and day";
	years: number[];
	delay: { closeDays: number; money: number; usage: number } | null;
	roundTo: number;
	cellRules: "all" | "G3 and G4" | "off";
	pin: boolean;
	openPeriod: "never" | "shown";
};
type Gift = { amount: number; date: string; fund: string };
/** The parts of `cell-rules.v3.json` the oracle reads. */
export type CellRules = {
	rule: { minContributors: number; maxShare: number };
	levels: Record<BooksLevel, LevelRule>;
	kpis: Record<string, KpiRule>;
	notComputed: Record<string, string>;
	complementary: Array<{ total: string; terms: string }>;
	captions: Record<
		| "aggregate"
		| "aggregateNone"
		| "governance"
		| "next"
		| "full"
		| "ownerOnly",
		string
	>;
	waiting: Record<
		"title" | "when" | "public.money" | "public.usage" | "member",
		string
	>;
	reasons: {
		fewer: string;
		share: string;
		complementary: string;
		derived: string;
	};
	invented: {
		years: { scale: Record<string, number> };
		donors: {
			buckets: Array<{ id: string; title: string; below: number | null }>;
			funds: Array<{ id: string; title: string }>;
			gifts: Gift[];
		};
	};
};
export type KpiDocumentInput = {
	rows: readonly KpiRow[];
	bundle: PresetBundle;
	rules: CellRules;
	preset: string;
	level: BooksLevel;
	pinLocked: boolean;
	clock: { today: string; now: string };
};

/** A cell before its hidden kinds are resolved: every reason it is hidden, why if suppressed, its value if any. */
type Draft = {
	hidden: Set<HiddenKind>;
	why: string | undefined;
	value: number | undefined;
};
/** One month of a period: the 2026 month whose rows it reads, and the factor of an invented year. */
type SourceMonth = { month: string; factor: number };
type Period = {
	period: string;
	label: string;
	invented: boolean;
	end: string;
	months: SourceMonth[];
	containsClock: boolean;
};

const precedence: readonly HiddenKind[] = [
	"blocked",
	"not_yet",
	"locked",
	"not_computed",
	"suppressed",
];
const stepRank: Record<string, number> = {
	G1: 1,
	G2: 2,
	G3: 3,
	G4: 4,
	G5: 5,
	G6: 6,
};
/** atm's ratio precision for refund, dispute and breakage rates (`kpis/school.v1.json`). */
const ratioPrecision = 4;
const schoolName = "Before University";
const timeZone = "America/Denver";
const kpiSpecVersion = "school.v1";
const lagMinutes = 2;
const monthNames = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
/** atm's KPI titles (`packages/atm/kpis/school.v1.json`) and the invented donor KPIs. */
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
	donors_count: "Donors",
	donors_median_gift: "Median gift",
};

// ---- Dates (UTC calendar arithmetic on ISO dates; no clock reads)
const isoOf = (time: number): string =>
	new Date(time).toISOString().slice(0, 10);
const lastDay = (year: number, monthIndex: number): string =>
	isoOf(Date.UTC(year, monthIndex + 1, 0));
const daysIn = (year: number, monthIndex: number): number =>
	new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
const addDays = (iso: string, days: number): string =>
	isoOf(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000);
const addMonths = (iso: string, months: number): string => {
	const [year = 0, month = 1, day = 1] = iso.split("-").map(Number);
	return isoOf(Date.UTC(year, month - 1 + months, day));
};
const monthYearLabel = (iso: string): string =>
	`${monthNames[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const monthDayLabel = (iso: string): string =>
	`${monthNames[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

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
const capitalized = (text: string): string =>
	`${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const formatMoney0 = (cents: number, currency: string): string =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: currency.toUpperCase(),
		minimumFractionDigits: 0,
		maximumFractionDigits: 0,
	}).format(cents / 100);

/** Everything the oracle knows about the books level (cell-rules v3 `levels`). The rest of the oracle reads only
 * this. */
type LevelPolicy = {
	rule: LevelRule;
	grain: Grain;
	hasDays: boolean;
	/** The KPI's step is within the level's ceiling. */
	shows: (rule: KpiRule) => boolean;
	/** The cell rule applies to the KPI's step. */
	ruled: (step: Step) => boolean;
	/** The PIN-locked variant locks the KPI. */
	locks: (rule: KpiRule) => boolean;
	showsOpen: boolean;
	pinLocked: boolean;
};
const levelPolicy = (
	rules: CellRules,
	level: BooksLevel,
	pinLocked: boolean,
): LevelPolicy => {
	const rule = rules.levels[level];
	if (pinLocked && !rule.pin)
		throw new Error(`${level} has no PIN-locked variant`);
	const ceiling = stepRank[rule.steps] ?? 0;
	return {
		rule,
		grain: rule.grain === "month and day" ? "month" : rule.grain,
		hasDays: rule.grain === "month and day",
		shows: (kpi) => (stepRank[kpi.step] ?? 99) <= ceiling,
		ruled: (step) =>
			rule.cellRules === "all" ||
			(rule.cellRules === "G3 and G4" && (step === "G3" || step === "G4")),
		locks: (kpi) =>
			pinLocked &&
			(kpi.kind === "amount" ||
				(kpi.kind === "rate" && kpi.rateOf === "amount")),
		showsOpen: rule.openPeriod === "shown",
		pinLocked,
	};
};

/** The document's KPI ids in `cell-rules` order, a `<kpi>:*` entry expanded over its dimensions. */
const expandIds = (
	rules: CellRules,
	bundle: PresetBundle,
): Array<{ id: string; rule: KpiRule; title: string }> =>
	Object.entries(rules.kpis).flatMap(([key, rule]) => {
		if (!key.endsWith(":*"))
			return [{ id: key, rule, title: titles[key] ?? key }];
		const prefix = key.slice(0, -1);
		const dimensions =
			prefix === "revenue_by_tier:"
				? Object.keys(bundle.tiers)
						.sort()
						.map((tier) => ({ id: tier, title: capitalized(tier) }))
				: prefix === "donations_by_fund:"
					? rules.invented.donors.funds
					: rules.invented.donors.buckets;
		return dimensions.map((dimension) => {
			const contrib = rule.contrib?.replace(/<[^>]+>/, dimension.id);
			return {
				id: `${prefix}${dimension.id}`,
				rule: contrib === undefined ? rule : { ...rule, contrib },
				title: dimension.title,
			};
		});
	});

const resolve = (draft: Draft, rule: KpiRule, roundTo: number): Cell => {
	const reason = precedence.find((kind) => draft.hidden.has(kind));
	if (reason)
		return reason === "suppressed" && draft.why
			? { hidden: reason, why: draft.why }
			: { hidden: reason };
	const value = draft.value;
	if (value === undefined) return { hidden: "not_computed" };
	if (value === 0) return 0;
	if (rule.kind !== "amount" || roundTo === 0) return value;
	const rounded = Math.sign(value) * Math.round(Math.abs(value) / roundTo);
	if (rounded === 0) return value > 0 ? { lt: roundTo } : 0;
	return rounded * roundTo;
};

export function kpiDocument(input: KpiDocumentInput): KpiDocument {
	const { rows, bundle, rules, preset, level, pinLocked, clock } = input;
	const policy = levelPolicy(rules, level, pinLocked);
	const year = Number(clock.today.slice(0, 4));
	const clockMonth = clock.today.slice(0, 7);
	const currency = bundle.params.currency ?? "usd";
	const { minContributors, maxShare } = rules.rule;
	const realMonths = bundle.periods.filter(
		(month) => month.startsWith(`${year}-`) && month <= clockMonth,
	);
	const allMonths = bundle.periods.filter((month) =>
		month.startsWith(`${year}-`),
	);
	const hasClockMonth = bundle.periods.includes(clockMonth);

	// ---- Periods of the level's grain; earlier years are invented from this year's months
	const sourceMonths = (
		periodYear: number,
		monthIndexes: number[],
	): SourceMonth[] => {
		const invented = periodYear !== year;
		const factor = invented
			? rules.invented.years.scale[String(periodYear)]
			: 1;
		if (factor === undefined)
			throw new Error(`no scale for invented year ${periodYear}`);
		const pool = invented ? allMonths : realMonths;
		return monthIndexes
			.map((index) => `${year}-${String(index + 1).padStart(2, "0")}`)
			.filter((month) => pool.includes(month))
			.map((month) => ({ month, factor }));
	};
	const clockMonthIndex = Number(clockMonth.slice(5, 7)) - 1;
	const periods: Period[] =
		policy.grain === "year"
			? policy.rule.years.map((periodYear) => ({
					period: String(periodYear),
					label: String(periodYear),
					invented: periodYear !== year,
					end: lastDay(periodYear, 11),
					months: sourceMonths(periodYear, [...Array(12).keys()]),
					containsClock: periodYear === year,
				}))
			: policy.grain === "quarter"
				? policy.rule.years.flatMap((periodYear) =>
						[0, 1, 2, 3]
							.filter(
								(quarter) =>
									periodYear < year || 3 * quarter <= clockMonthIndex,
							)
							.map((quarter) => ({
								period: `${periodYear}-Q${quarter + 1}`,
								label: `Q${quarter + 1} ${periodYear}`,
								invented: periodYear !== year,
								end: lastDay(periodYear, 3 * quarter + 2),
								months: sourceMonths(periodYear, [
									3 * quarter,
									3 * quarter + 1,
									3 * quarter + 2,
								]),
								containsClock:
									periodYear === year &&
									Math.floor(clockMonthIndex / 3) === quarter,
							})),
					)
				: realMonths.map((month) => {
						const index = Number(month.slice(5, 7)) - 1;
						return {
							period: month,
							label: monthNames[index] ?? month,
							invented: false,
							end: lastDay(year, index),
							months: [{ month, factor: 1 }],
							containsClock: month === clockMonth,
						};
					});

	// ---- Delay: when each period shows, per lag class
	const shownFrom = (period: Period, lag: LagClass): string | null => {
		const delay = policy.rule.delay;
		if (!delay) return null;
		const from = addMonths(addDays(period.end, delay.closeDays), delay[lag]);
		return from <= clock.today ? null : from;
	};
	const fromLabel = (iso: string): string =>
		policy.grain === "month" ? monthDayLabel(iso) : monthYearLabel(iso);
	const waitingWhy = (lag: LagClass): string =>
		level === "public"
			? rules.waiting[lag === "usage" ? "public.usage" : "public.money"]
			: level === "member"
				? rules.waiting.member
				: "A month shows once it has closed, 7 days after it ends.";
	const partialPeriod =
		policy.showsOpen && hasClockMonth
			? periods.find((period) => period.containsClock)
			: undefined;
	const periodInfo: PeriodInfo[] = periods.map((period) => {
		const from = {
			money: shownFrom(period, "money"),
			usage: shownFrom(period, "usage"),
		};
		const label = (lag: LagClass): string | null => {
			const iso = from[lag];
			return iso ? fromLabel(iso) : null;
		};
		const waiting = (lag: LagClass) => {
			const when = label(lag);
			return when
				? {
						title: rules.waiting.title.replace("{label}", period.label),
						when: rules.waiting.when
							.replace("{label}", period.label)
							.replace("{shownFromLabel}", when),
						why: waitingWhy(lag),
					}
				: null;
		};
		return {
			period: period.period,
			label: period.label,
			invented: period.invented,
			partial: period === partialPeriod,
			shownFrom: from,
			shownFromLabel: { money: label("money"), usage: label("usage") },
			waiting: { money: waiting("money"), usage: waiting("usage") },
		};
	});
	const infoOf = new Map(periodInfo.map((info) => [info.period, info]));

	// ---- Rows, scaled for invented months
	const rowValue = new Map(
		rows.map((row) => [`${row.kpiId}@${row.period}`, row.value]),
	);
	const monthValue = (id: string, source: SourceMonth): number | undefined => {
		const value = rowValue.get(`${id}@${source.month}`);
		if (value === undefined) return undefined;
		return source.factor === 1 ? value : Math.round(value * source.factor);
	};
	const raw = (
		id: string,
		period: Period,
		how: "sum" | "max" = "sum",
	): number | undefined => {
		if (period.months.length === 0) return undefined;
		let total = how === "max" ? Number.NEGATIVE_INFINITY : 0;
		for (const source of period.months) {
			const value = monthValue(id, source);
			if (value === undefined) return undefined;
			total = how === "max" ? Math.max(total, value) : total + value;
		}
		return total;
	};

	const kpis = expandIds(rules, bundle).filter(({ rule }) =>
		policy.shows(rule),
	);
	const ruleOf = new Map(kpis.map((kpi) => [kpi.id, kpi]));
	const reason = (template: string, noun: string): string =>
		template
			.replace("{noun}", noun)
			.replace("{noun, singular}", noun.replace(/s$/, ""));

	/** Whether one source month passes the cell rule, or why not. */
	const monthCheck = (
		id: string,
		rule: KpiRule,
		source: SourceMonth,
	): { kind: HiddenKind; why?: string } | null => {
		const value = monthValue(id, source);
		if (value === undefined) return { kind: "not_computed" };
		if (value === 0) return null;
		if (rule.policy === "self")
			return value >= minContributors
				? null
				: { kind: "suppressed", why: reason(rules.reasons.fewer, "payers") };
		const entry =
			bundle.contrib[rule.contrib ?? id]?.[
				bundle.periods.indexOf(source.month)
			];
		if (!entry) return { kind: "not_computed" };
		const [holders, largestShare] = entry;
		if (holders < minContributors)
			return { kind: "suppressed", why: reason(rules.reasons.fewer, "payers") };
		if (largestShare > maxShare)
			return { kind: "suppressed", why: reason(rules.reasons.share, "payers") };
		return null;
	};

	const drafts = new Map<string, Draft>();
	const draftOf = (id: string, period: Period): Draft => {
		const key = `${id}@${period.period}`;
		const known = drafts.get(key);
		if (known) return known;
		const kpi = ruleOf.get(id);
		if (!kpi) throw new Error(`${id} is not in this level's KPIs`);
		const draft = computeDraft(id, kpi.rule, period);
		drafts.set(key, draft);
		return draft;
	};
	const computeDraft = (id: string, rule: KpiRule, period: Period): Draft => {
		const draft: Draft = {
			hidden: new Set(),
			why: undefined,
			value: undefined,
		};
		const hide = (kind: HiddenKind, why?: string): void => {
			draft.hidden.add(kind);
			if (kind === "suppressed" && why && !draft.why) draft.why = why;
		};
		if (rule.policy === "blocked") {
			hide("blocked");
			return draft;
		}
		if (infoOf.get(period.period)?.shownFrom[rule.lag]) hide("not_yet");
		if (policy.locks(rule)) hide("locked");
		const aggregated = policy.grain !== "month";
		if (rule.policy === "derived") {
			for (const inputId of rule.inputs ?? []) {
				const input = draftOf(inputId, period);
				for (const kind of input.hidden)
					if (kind !== "blocked")
						hide(
							kind,
							rules.reasons.derived.replace(
								"{input title, lower case}",
								(ruleOf.get(inputId)?.title ?? inputId).toLowerCase(),
							),
						);
			}
			const denominator = rule.denominator
				? raw(rule.denominator, period)
				: undefined;
			if (rule.denominator && denominator === 0) hide("not_computed");
			if (!aggregated)
				draft.value = rowValue.get(`${id}@${period.months[0]?.month}`);
			else if (rule.aggregate === "not_computed") hide("not_computed");
			else if (rule.kind !== "rate") draft.value = raw(id, period);
			else {
				const numerator = rule.inputs?.[0]
					? raw(rule.inputs[0], period)
					: undefined;
				if (
					numerator !== undefined &&
					denominator !== undefined &&
					denominator !== 0
				)
					draft.value = roundedRatio(numerator, denominator);
			}
			return draft;
		}
		if (aggregated && rule.aggregate === "not_computed") {
			hide("not_computed");
			return draft;
		}
		draft.value = raw(
			id,
			period,
			aggregated && rule.aggregate === "max" ? "max" : "sum",
		);
		if (draft.value === undefined) hide("not_computed");
		if (policy.ruled(rule.step))
			for (const source of period.months) {
				const failure = monthCheck(id, rule, source);
				if (failure) hide(failure.kind, failure.why);
			}
		return draft;
	};

	const series: Record<string, Cell[]> = {};
	const roundTo = policy.rule.roundTo;
	for (const { id, rule } of kpis) {
		if (rule.policy === "distribution") continue;
		series[id] = periods.map((period) =>
			resolve(draftOf(id, period), rule, roundTo),
		);
	}

	// ---- Complementary suppression (cell-rules `complementary`), where the terms' step is ruled
	const isSuppressed = (cell: Cell | undefined): boolean =>
		typeof cell === "object" &&
		"hidden" in cell &&
		cell.hidden === "suppressed";
	for (const { total, terms } of rules.complementary) {
		const prefix = terms.endsWith("*") ? terms.slice(0, -1) : terms;
		const termIds = kpis
			.filter(
				({ id, rule }) => id.startsWith(prefix) && policy.ruled(rule.step),
			)
			.map(({ id }) => id);
		periods.forEach((period, index) => {
			if (typeof series[total]?.[index] !== "number") return;
			const suppressed = termIds.filter((id) =>
				isSuppressed(series[id]?.[index]),
			);
			if (suppressed.length !== 1) return;
			const next = termIds
				.map((id) => ({ id, value: series[id]?.[index] }))
				.filter(
					(term): term is { id: string; value: number } =>
						typeof term.value === "number" && term.value !== 0,
				)
				.sort((first, second) => first.value - second.value)[0];
			if (!next)
				throw new Error(
					`${preset} ${level} ${period.period}: ${suppressed[0]} is the only non-zero term of ${total}`,
				);
			const cells = series[next.id];
			if (cells)
				cells[index] = {
					hidden: "suppressed",
					why: rules.reasons.complementary,
				};
		});
	}

	// ---- The invented donors (G3 funds, G4 distribution), cumulative from January
	const donorKpis = kpis.filter(({ rule }) => rule.policy === "distribution");
	if (donorKpis.length > 0) {
		const { buckets, funds, gifts } = rules.invented.donors;
		const donorNoun = "donors";
		for (const { id } of donorKpis) series[id] = [];
		type Item = {
			id: string;
			count: number;
			sum: number;
			top: number;
			order: number;
			why: string;
		};
		const applyRules = (items: Item[], by: "count" | "sum"): void => {
			for (const item of items)
				item.why =
					item.count === 0
						? ""
						: item.count < minContributors
							? reason(rules.reasons.fewer, donorNoun)
							: item.sum > 0 && item.top / item.sum > maxShare
								? reason(rules.reasons.share, donorNoun)
								: "";
			const hidden = items.filter((item) => item.why);
			if (hidden.length !== 1) return;
			const next = items
				.filter((item) => !item.why && item.count > 0)
				.sort(
					(first, second) =>
						first[by] - second[by] || first.order - second.order,
				)[0];
			if (next) next.why = rules.reasons.complementary;
		};
		const itemOf = (id: string, chosen: Gift[], order: number): Item => ({
			id,
			count: chosen.length,
			sum: chosen.reduce((total, gift) => total + gift.amount, 0),
			top: Math.max(0, ...chosen.map((gift) => gift.amount)),
			order,
			why: "",
		});
		for (const period of periods) {
			const given = gifts.filter((gift) => gift.date <= period.end);
			const count = given.length;
			const sorted = given.map((gift) => gift.amount).sort((a, b) => a - b);
			const median =
				count === 0
					? undefined
					: count % 2
						? sorted[(count - 1) / 2]
						: ((sorted[count / 2 - 1] ?? 0) + (sorted[count / 2] ?? 0)) / 2;
			const bucketItems = buckets.map((bucket, order) => {
				const lower = buckets[order - 1]?.below ?? 0;
				return itemOf(
					`donors_by_size:${bucket.id}`,
					given.filter(
						(gift) =>
							gift.amount >= lower &&
							(bucket.below === null || gift.amount < bucket.below),
					),
					order,
				);
			});
			const fundItems = funds
				.map((fund, order) =>
					itemOf(
						`donations_by_fund:${fund.id}`,
						given.filter((gift) => gift.fund === fund.title),
						order,
					),
				)
				.sort(
					(first, second) =>
						second.sum - first.sum || first.order - second.order,
				)
				.map((item, order) => ({ ...item, order }));
			const distributionRuled = policy.ruled("G4");
			if (distributionRuled) applyRules(bucketItems, "count");
			if (policy.ruled("G3")) applyRules(fundItems, "sum");
			const tooFew = distributionRuled && count > 0 && count < minContributors;
			const values = new Map<
				string,
				{ value: number | undefined; why: string }
			>([
				[
					"donors_count",
					{
						value: count,
						why: tooFew ? reason(rules.reasons.fewer, donorNoun) : "",
					},
				],
				[
					"donors_median_gift",
					{
						value: median,
						why: tooFew ? reason(rules.reasons.fewer, donorNoun) : "",
					},
				],
				...bucketItems.map(
					(item) =>
						[
							item.id,
							{
								value: item.count,
								why: tooFew ? reason(rules.reasons.fewer, donorNoun) : item.why,
							},
						] as const,
				),
				...fundItems.map(
					(item) => [item.id, { value: item.sum, why: item.why }] as const,
				),
			]);
			for (const { id, rule } of donorKpis) {
				const found = values.get(id);
				const draft: Draft = {
					hidden: new Set(),
					why: found?.why || undefined,
					value: found?.value,
				};
				if (infoOf.get(period.period)?.shownFrom[rule.lag])
					draft.hidden.add("not_yet");
				if (policy.locks(rule)) draft.hidden.add("locked");
				if (found?.why) draft.hidden.add("suppressed");
				series[id]?.push(resolve(draft, rule, roundTo));
			}
		}
	}

	// ---- Days (finance admin and owner): the mockup's split of each month's gross
	const days = policy.hasDays
		? (() => {
				const dayPeriods: string[] = [];
				const cells: Cell[] = [];
				const grossRule = ruleOf.get("gross_collected")?.rule;
				if (!grossRule) throw new Error("no gross_collected rule");
				for (const period of periods) {
					const monthIndex = Number(period.period.slice(5, 7)) - 1;
					const count = daysIn(year, monthIndex);
					const last = period.containsClock
						? Number(clock.today.slice(8, 10))
						: count;
					const gross = rowValue.get(`gross_collected@${period.period}`);
					const weights = [...Array(count).keys()].map((day) =>
						day < last ? 1 + ((day * 7 + monthIndex * 3) % 5) : 0,
					);
					const totalWeight =
						weights.reduce((sum, weight) => sum + weight, 0) || 1;
					let left = gross ?? 0;
					for (let day = 0; day < count; day += 1) {
						dayPeriods.push(
							`${period.period}-${String(day + 1).padStart(2, "0")}`,
						);
						const draft: Draft = {
							hidden: new Set(),
							why: undefined,
							value: undefined,
						};
						if (day >= last) draft.hidden.add("not_yet");
						if (policy.locks(grossRule)) draft.hidden.add("locked");
						if (gross === undefined) draft.hidden.add("not_computed");
						else if (day < last - 1) {
							draft.value = Math.round(
								(gross * (weights[day] ?? 0)) / totalWeight,
							);
							left -= draft.value;
						} else if (day === last - 1) draft.value = left;
						cells.push(resolve(draft, grossRule, 0));
					}
				}
				return { periods: dayPeriods, series: { gross_collected: cells } };
			})()
		: null;

	// ---- Captions, one per lag class
	const caption = (lag: LagClass): string => {
		const next = periodInfo.find((info) => info.shownFromLabel[lag]);
		const nextText = next
			? rules.captions.next
					.replace("{label}", next.label)
					.replace("{shownFromLabel}", next.shownFromLabel[lag] ?? "")
			: "";
		if (level === "public" || level === "member")
			return rules.captions.aggregate
				.replace("{Level}", policy.rule.name)
				.replace("{grain}", policy.grain)
				.replace("{roundTo}", formatMoney0(roundTo, currency))
				.replace("{next}", nextText || rules.captions.aggregateNone);
		if (level === "governance")
			return rules.captions.governance.replace("{next}", nextText).trim();
		return rules.captions.full
			.replace("{Level}", policy.rule.name)
			.replace(
				"{ownerOnly}",
				level === "owner" ? rules.captions.ownerOnly : "",
			);
	};

	const meta: Record<string, KpiMeta> = {};
	for (const { id, rule, title } of kpis) {
		const format: KpiFormat =
			rule.kind === "amount" && roundTo > 0
				? "money0"
				: (rule.format ??
					(rule.kind === "amount"
						? "money"
						: rule.kind === "count"
							? "integer"
							: "percent1"));
		const entry: KpiMeta = {
			title,
			unit:
				rule.kind === "amount"
					? "cents"
					: rule.kind === "count"
						? "count"
						: "ratio",
			precision: format === "money" ? 2 : format === "percent1" ? 1 : 0,
			format,
			step: rule.step,
			lag: rule.lag,
			derived: rule.policy === "derived",
			invented: rule.policy === "distribution",
		};
		if (policy.grain !== "month" && rule.aggregate === "max")
			entry.note = "most in one month of the period";
		else if (rule.policy === "distribution")
			entry.note = "2026 from January to the end of the period";
		meta[id] = entry;
	}

	const notComputed = [
		...Object.entries(rules.notComputed).map(([id, text]) => ({
			id,
			reason: text,
		})),
		...(policy.grain !== "month"
			? kpis
					.filter(({ rule }) => rule.aggregate === "not_computed")
					.map(({ id }) => ({
						id,
						reason: "needs distinct paying members per period",
					}))
			: []),
	];
	const notes = [
		...(periods.some((period) => period.invented)
			? [
					"Years before the clock's are invented from 2026's months, scaled (cell-rules invented.years); their periods are marked invented.",
				]
			: []),
		...(donorKpis.length
			? [
					"Donors and donations are the mockup's B4 Uni fixture, the same for every preset (cell-rules invented.donors).",
				]
			: []),
		...(days
			? [
					"Days split each month's gross by the mockup's weights (cell-rules invented.days).",
				]
			: []),
		...(policy.grain !== "month"
			? [
					"Each period is rounded on its own, so a year is not the sum of its rounded quarters.",
				]
			: []),
	];

	return {
		school: schoolName,
		preset,
		level,
		pinLocked,
		year,
		basis: "cash",
		currency,
		tz: timeZone,
		kpiSpecVersion,
		grain: policy.grain,
		asOf: clock.now,
		lagMinutes,
		partialPeriods: partialPeriod ? [partialPeriod.period] : [],
		rules: { minContributors, maxShare },
		policy: {
			steps: policy.rule.steps,
			roundTo,
			cellRules: policy.rule.cellRules,
			pin: policy.rule.pin,
		},
		caption: { money: caption("money"), usage: caption("usage") },
		periods: periods.map((period) => period.period),
		periodInfo,
		series,
		meta,
		days,
		notComputed,
		notes,
		verified: true,
	};
}

/** Every document the fixtures hold: one per books level, and the PIN-locked variant where the level has a PIN. */
export const documentVariants = (
	rules: CellRules,
): Array<{ level: BooksLevel; pinLocked: boolean }> =>
	(Object.keys(rules.levels) as BooksLevel[]).flatMap((level) =>
		rules.levels[level].pin
			? [
					{ level, pinLocked: false },
					{ level, pinLocked: true },
				]
			: [{ level, pinLocked: false }],
	);
export const documentKey = (
	preset: string,
	level: BooksLevel,
	pinLocked: boolean,
): string => `${preset}.${level}${pinLocked ? ".pin-locked" : ""}`;
