/**
 * The disclosure rules the KPI document applies (the B4 Uni file, the school's override, a class's or a KPI's rule for an
 * audience): a Worker-safe copy of the pure rule functions in `packages/ledger-ui/src/data/disclosure.ts`, so the
 * document builder in `atm/worker` imports nothing from the UI package. `gates/oracle.ts` keeps reading the UI's own
 * file; the equality test (`tests/kpi-document-oracle.test.ts`) fails if the two drift.
 */
import { derivedKpiCatalog } from "./kpi-catalog.js";

export const audiences = [
	"public",
	"member",
	"governance",
	"finance",
	"owner",
] as const;
/** Each audience includes those before it: `finance` holds `governance`, `member` and `public` too. */
export type Audience = (typeof audiences)[number];
/** The audiences a school's file may give rules to; `finance` and `owner` always see everything, live. */
export const ruledAudiences = ["public", "member", "governance"] as const;
export type RuledAudience = (typeof ruledAudiences)[number];

export const audienceNames: Record<Audience, string> = {
	public: "Public",
	member: "Member",
	governance: "Governance",
	finance: "Finance admin",
	owner: "Owner",
};

/** The levels of detail, coarse to fine; each includes the ones before it. `rows` and `names` are identities. */
export const detailSteps = [
	"total",
	"categories",
	"breakdown",
	"spread",
	"rows",
	"names",
] as const;
export type DetailStep = (typeof detailSteps)[number];
export const disclosureGrains = ["year", "quarter", "month", "day"] as const;
export type DisclosureGrain = (typeof disclosureGrains)[number];
/** How long after a period closes its figures publish; absent, at close. A month closes 7 days after it ends. */
export const disclosureDelays = [
	"6 weeks",
	"3 months",
	"12 months",
	"24 months",
] as const;
export type DisclosureDelay = (typeof disclosureDelays)[number];

export const kpiClasses = [
	"income",
	"losses",
	"cash",
	"people",
	"activity",
	"personal",
] as const;
/** The six KPI classes. `personal` has no rule: only the identity audiences see it. */
export type KpiClass = (typeof kpiClasses)[number];
export type RuledClass = Exclude<KpiClass, "personal">;
export const kpiClassNames: Record<KpiClass, string> = {
	income: "Income",
	losses: "Losses",
	cash: "Cash",
	people: "People",
	activity: "Activity",
	personal: "Personal",
};

export type DisclosureRule = {
	detail: DetailStep;
	every: DisclosureGrain;
	after?: DisclosureDelay;
};
export type AudienceDefinition = {
	parent?: Audience;
	fixed?: true;
	identities?: true;
};
/** Rounding units in minor units of the school's currency (10000 is $100); 0 is exact. */
export type RoundingUnits = { public: number; member: number };
export type SchoolSize = "small" | "large";

/** The disclosure file, as buzz-school stores it. */
export type DisclosureFile = {
	version: 1;
	catalog: "school.v1";
	audiences: Record<Audience, AudienceDefinition>;
	classes: Record<KpiClass, string[]>;
	disclose: Partial<
		Record<RuledClass, Partial<Record<RuledAudience, DisclosureRule>>>
	>;
	rounding: { small: RoundingUnits; large: RoundingUnits; largeFrom: number };
	counts: { failingRoundTo: number };
};

/** A rule key of an override: `<class>.<audience>`. */
export type RuleKey = `${RuledClass}.${RuledAudience}`;
/** A school's stored differences (`school_books_disclosure`): KPIs moved between classes, rules set or removed
 * (`null`), rounding made coarser. */
export type DisclosureOverride = {
	moves?: Record<string, KpiClass>;
	rules?: Partial<Record<RuleKey, DisclosureRule | null>>;
	rounding?: Partial<Record<SchoolSize, Partial<RoundingUnits>>>;
};

/** Derived KPIs and their inputs (atm's catalog, computed from the ledger model). A `capped` one sits in a more open
 * class and takes its inputs' rule (spec rule 3); the others must not be more open than their inputs. */
export const derivedKpis: Record<
	string,
	{ inputs: string[]; capped: boolean }
> = derivedKpiCatalog;

const detailRank = (detail: DetailStep): number => detailSteps.indexOf(detail);
const grainRank = (grain: DisclosureGrain): number =>
	disclosureGrains.indexOf(grain);
const averageMonthDays = 30.44;
const weekDays = 7;
const delayDays = (delay: DisclosureDelay | null | undefined): number => {
	if (!delay) return 0;
	const [count = "0", unit = ""] = delay.split(" ");
	const days = unit.startsWith("week") ? weekDays : averageMonthDays;
	return Number(count) * days;
};

/** The effective file: the B4 Uni file with the school's override applied. */
export function applyOverride(
	file: DisclosureFile,
	override: DisclosureOverride,
): DisclosureFile {
	const classes = Object.fromEntries(
		kpiClasses.map((kpiClass) => [kpiClass, [...file.classes[kpiClass]]]),
	) as Record<KpiClass, string[]>;
	for (const [kpi, target] of Object.entries(override.moves ?? {})) {
		for (const kpiClass of kpiClasses)
			classes[kpiClass] = classes[kpiClass].filter((id) => id !== kpi);
		classes[target].push(kpi);
	}
	const disclose: DisclosureFile["disclose"] = {};
	for (const [kpiClass, rules] of Object.entries(file.disclose))
		disclose[kpiClass as RuledClass] = { ...rules };
	for (const [key, rule] of Object.entries(override.rules ?? {})) {
		const [kpiClass, audience] = key.split(".") as [RuledClass, RuledAudience];
		const rules = disclose[kpiClass] ?? {};
		if (rule === null || rule === undefined) delete rules[audience];
		else rules[audience] = { ...rule };
		disclose[kpiClass] = rules;
	}
	const rounding = {
		small: { ...file.rounding.small, ...override.rounding?.small },
		large: { ...file.rounding.large, ...override.rounding?.large },
		largeFrom: file.rounding.largeFrom,
	};
	return { ...file, classes, disclose, rounding };
}

/** A class's rule for an audience: its own, else its nearest parent's (`from` says whose). Identity audiences get
 * everything, live; `personal` and unknown classes have none below them. */
export type ResolvedRule = {
	detail: DetailStep;
	every: DisclosureGrain;
	after: DisclosureDelay | null;
	live: boolean;
	kpiClass: KpiClass | null;
	from: Audience | null;
};
export function classRule(
	file: DisclosureFile,
	kpiClass: KpiClass | undefined,
	audience: Audience,
): ResolvedRule | null {
	if (file.audiences[audience].identities)
		return {
			detail: "names",
			every: "day",
			after: null,
			live: true,
			kpiClass: null,
			from: null,
		};
	if (!kpiClass || kpiClass === "personal") return null;
	for (
		let current: Audience | undefined = audience;
		current;
		current = file.audiences[current].parent
	) {
		if (current === "finance" || current === "owner") continue;
		const rule = file.disclose[kpiClass]?.[current];
		if (rule)
			return {
				detail: rule.detail,
				every: rule.every,
				after: rule.after ?? null,
				live: false,
				kpiClass,
				from: current,
			};
	}
	return null;
}

export const classOf = (
	file: DisclosureFile,
	kpi: string,
): KpiClass | undefined =>
	kpiClasses.find((kpiClass) => file.classes[kpiClass].includes(kpi));

/** A KPI's rule for an audience: its class's, capped by every input's (a derived figure is never more open than an
 * input), or null when the audience does not see it. */
export function kpiRule(
	file: DisclosureFile,
	audience: Audience,
	kpi: string,
): ResolvedRule | null {
	const own = classRule(file, classOf(file, kpi), audience);
	if (!own || own.live) return own;
	const rule = { ...own };
	for (const input of derivedKpis[kpi]?.inputs ?? []) {
		const inputRule = kpiRule(file, audience, input);
		if (!inputRule) return null;
		if (detailRank(inputRule.detail) < detailRank(rule.detail))
			rule.detail = inputRule.detail;
		if (grainRank(inputRule.every) < grainRank(rule.every))
			rule.every = inputRule.every;
		if (delayDays(inputRule.after) > delayDays(rule.after))
			rule.after = inputRule.after;
	}
	return rule;
}

/** What the document needs of a school's `Disclosure`: its size, the B4 Uni file and the school's override. The UI's
 * `Disclosure` (viewer and views too) is assignable to it. */
export type KpiDisclosure = {
	size: SchoolSize;
	file: DisclosureFile;
	override: DisclosureOverride;
};
