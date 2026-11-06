/**
 * School books: audiences and disclosure (spec v2, `plans/ledger-ui/loop/runs/disclosure-v2/school-books-disclosure-spec-v2.md`).
 * The orchestrator's contract, shared by every slice and protected (protocol §4). One `Disclosure` per school drives
 * what each audience sees: the B4 Uni disclosure file (buzz-school `packages/family-service/src/books/disclosure.v1.json`),
 * the school's stored override, the signed-in person's audiences, and, worked out by the server at the clock, the
 * periods, presets, summaries and lock panels the UI shows. The Reader of `reader.ts` extends `DisclosureReader`.
 *
 * What is being viewed is the hash parameter `as=owner|finance|admin|governance|member|public` (the mockup's View as
 * rows, S2's hash grammar). `admin` is a role, not an audience: an admin without the finance grant, whose books follow
 * their own membership (`ViewAsOption.audience`). Absent, or naming a row the signed-in person may not preview
 * (mockup `vaAllowed`), it is their own (`viewer.viewAs`): see `resolveViewAs`. Components read it
 * from the route; the top bar's View as dropdown only writes it. A gated surface renders the viewed option's
 * `LockPanel`, never an empty table or a 0.
 *
 * The functions below are the spec's rules as the settings table and its override editor need them (the effective
 * file, a class's rule with inheritance, the validator's checks): the same rules the server applies, so the editor
 * shows what the server will answer. They derive no figure.
 */

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

/** Why a figure or a surface is not shown: `embargoed` (inside its delay: "Published after 7 Jan 2027"),
 * `members_only` (a public viewer: "Members see this"), `no_grant` (an audience further up sees it). */
export type HiddenReason = "embargoed" | "members_only" | "no_grant";
/** A lock panel's code: a hidden reason, or `admins_only` (owners and admins only, not a books surface). */
export type LockReason = HiddenReason | "admins_only";
/** What a gated surface shows instead of its figures: `who` may see it (the panel's heading, e.g. "Governance and up
 * see this") and `when` (the line under it: how fine and how soon they see it, or the day it publishes). */
export type LockPanel = { reason: LockReason; who: string; when: string };
/** The gated surfaces whose lock panels the fixtures carry: the Dashboard's "By plan or fund" (revenue_by_tier at
 * breakdown), the Plans tab's members and revenue per plan (revenue_by_tier at breakdown), and the Settings drawer's
 * School books table. */
export const gatedSurfaces = [
	"dashboard-plan",
	"plans-revenue",
	"settings-books",
] as const;
export type GatedSurface = (typeof gatedSurfaces)[number];

/** A period the period selector offers an audience below `finance` (its grain, mockup `pList`): `YYYY`, `YYYY-Qn` or
 * `YYYY-MM`, its label (`2024`, `Q1 2025`, `Jan 2026`) and dates. An embargoed or future one is listed but disabled
 * with its `title` ("Published after 7 Jan 2027", "Not started yet"). */
export type PeriodGate = {
	period: string;
	label: string;
	from: string;
	to: string;
	state: "shown" | "embargoed" | "future";
	title: string | null;
};
/** The period selector's presets (S0 `periodPresets`, by label) for an audience: hidden with the reason and title
 * the mockup gives ("Governance and up see this: Public sees years"), or embargoed with its publish line. A hidden
 * preset's second line is "—", an embargoed one's its title. */
export type PresetGate = {
	label: "This month" | "Last month" | "Last 3 months" | "Year to date";
	state: "shown" | "hidden" | "embargoed";
	reason: HiddenReason | null;
	title: string | null;
};

/** One audience as this school's documents give it, worked out by the server at the clock. */
export type AudienceView = {
	name: string;
	/** The View as option's second line (mockup `vaSummary`). */
	summary: string;
	/** Finance and owner read live: every period, months and days, the open month included. */
	live: boolean;
	identities: boolean;
	/** The finest detail any class gives this audience. */
	detail: DetailStep;
	/** The grain and delay of its income figures (the period selector's grain); `day` when live. */
	grain: DisclosureGrain;
	delay: DisclosureDelay | null;
	/** Money rounding for this school's size and year, minor units; 0 is exact. */
	roundTo: number;
	/** Below `finance`, a count that fails the cell rules (fewer than `fewerThan` holders) shows rounded to `roundTo`,
	 * 1 to 9 as `under`; null when the rules are off. */
	smallCounts: { fewerThan: number; roundTo: number; under: string } | null;
	cellRules: "on" | "breakdown and spread" | "off";
	/** The audience opens the books with the family PIN. */
	pin: boolean;
	/** "Public sees years": the tail of a hidden preset's title and of the period-changed toast. */
	sees: string;
	/** The selector's line under its label, after "Previewing " when the audience is a preview: "Public: years only.
	 * One period for Dashboard, Reports, Ledger and Members." */
	periodNote: string;
	/** The custom range's note when the audience has no days ("Days show to finance admins and the owner. Public sees
	 * years."); null when live (the date inputs show). */
	customRangeNote: string | null;
	presets: PresetGate[];
	/** Empty when live. */
	periods: PeriodGate[];
};

/** What View as previews: an audience, or the Admin role. */
export const viewAsValues = [
	"owner",
	"finance",
	"admin",
	"governance",
	"member",
	"public",
] as const;
export type ViewAs = (typeof viewAsValues)[number];
/** One row of the View as dropdown, in the mockup's order (Owner, Finance admin, Admin, Governance, Member, Public;
 * then the disabled "Custom audiences: later" row, which is copy, not data). */
export type ViewAsOption = {
	value: ViewAs;
	/** "Finance admin"; the UI adds " (you)" on the viewer's own row. */
	name: string;
	/** The row's sees and can't-see line (mockup `vaSummary`). */
	summary: string;
	/** The viewer may preview it (Cedar ReadDisclosure: never above what they hold); a row that is not held is
	 * disabled with the title "You do not hold this audience". */
	held: boolean;
	/** The books audience it shows: itself, or for Admin the admin's own (`member` when an owner or a finance admin
	 * previews it). */
	audience: Audience;
	/** Owner, Finance admin and Admin see the roster, plans, bookings and settings; the others see only what their
	 * document gives. */
	admin: boolean;
	/** The lock panel of each gated surface this row may not see. */
	locks: Partial<Record<GatedSurface, LockPanel>>;
};

/** The signed-in person at the school (spec "A person's audiences"). */
export type Viewer = {
	id: string;
	name: string;
	role: "owner" | "admin" | "member";
	financeGrant: boolean;
	/** The highest audience held. */
	audience: Audience;
	/** Every audience held, public first: the only ones View as offers. */
	audiences: Audience[];
	/** Why (mockup `audOf`): "Owner on the roster", "Admin with the finance grant". */
	why: string;
	/** Their own View as row: `owner`, `finance`, or `admin` for an admin without the finance grant. */
	viewAs: ViewAs;
};

/** Everything the UI needs to gate one school's books. */
export type Disclosure = {
	school: string;
	/** The year the rounding size is fixed for (on its first day, from the last closed year's income). */
	year: number;
	size: SchoolSize;
	/** The B4 Uni file, unchanged; the effective file is `applyOverride(file, override)`. */
	file: DisclosureFile;
	override: DisclosureOverride;
	viewer: Viewer;
	views: Record<Audience, AudienceView>;
	viewAs: ViewAsOption[];
};

export interface DisclosureReader {
	/** The school's disclosure (buzz-school's school-books routes in S8), as of the Reader's clock. */
	disclosure(school: string): Promise<Disclosure>;
}

/** What a person is, as the roster and the memberships say (spec "A person's audiences"). */
export type PersonFacts = {
	role: "owner" | "admin" | "member";
	financeGrant: boolean;
	adult: boolean;
	/** The `audience` of each tier of the family's memberships at the school that are `active` or `past_due`
	 * (a tier without one names `member`). */
	liveTierAudiences: Audience[];
};

const rank = (audience: Audience): number => audiences.indexOf(audience);

/** The audiences a person holds, public first, computed live at each read: the owner `owner`; an admin with the
 * finance grant `finance`; an adult the highest audience of their live tiers (never `finance` or `owner`); everyone
 * `public`; each with every audience below it. A child never holds more than `public`: the guardian does. */
export function audiencesOf(person: PersonFacts): Audience[] {
	let top: Audience = "public";
	if (person.role === "owner") top = "owner";
	else if (person.role === "admin" && person.financeGrant) top = "finance";
	else if (person.adult)
		for (const audience of person.liveTierAudiences)
			if (
				audience !== "finance" &&
				audience !== "owner" &&
				rank(audience) > rank(top)
			)
				top = audience;
	return audiences.filter((audience) => rank(audience) <= rank(top));
}

/** What a route views: `as=` when it names a row the viewer holds, else the viewer's own row. `preview` is true
 * when it is not their own: the banner shows and every write is off. */
export function resolveViewAs(
	asked: string | null,
	disclosure: Pick<Disclosure, "viewer" | "viewAs">,
): { option: ViewAsOption; preview: boolean } {
	const own = disclosure.viewAs.find(
		(option) => option.value === disclosure.viewer.viewAs,
	);
	const chosen = disclosure.viewAs.find(
		(option) => option.value === asked && option.held,
	);
	const option = chosen ?? own;
	if (!option) throw new Error("the viewer's own View as row is missing");
	return { option, preview: option.value !== disclosure.viewer.viewAs };
}

/** Derived KPIs and their inputs (atm's catalog). A `capped` one sits in a more open class and takes its inputs'
 * rule (spec rule 3); the others must not be more open than their inputs. */
export const derivedKpis: Record<
	string,
	{ inputs: string[]; capped: boolean }
> = {
	net_income: {
		inputs: [
			"gross_collected",
			"refunds",
			"stripe_fees",
			"disputes_lost",
			"dispute_fees",
		],
		capped: true,
	},
	refund_rate: { inputs: ["refunds", "gross_collected"], capped: false },
	dispute_rate: {
		inputs: ["disputes_opened", "payments_count"],
		capped: false,
	},
	arpa: { inputs: ["gross_collected", "paying_members"], capped: true },
	breakage_rate: {
		inputs: ["credits_expired", "credits_granted"],
		capped: false,
	},
};

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

/** A cell of the Settings drawer's School books table (mockup `bkSettings`): "—" when the audience sees nothing of
 * the class, "names · live" for the identity audiences, else "<detail> · <every> · <after or 'at close'>", with
 * " (as <parent>)" when the rule is inherited. */
export function disclosureCell(
	file: DisclosureFile,
	kpiClass: KpiClass,
	audience: Audience,
): string {
	if (kpiClass === "personal" && !file.audiences[audience].identities)
		return "—";
	const rule = classRule(file, kpiClass, audience);
	if (!rule) return "—";
	if (rule.live) return "names · live";
	const inherited =
		rule.from && rule.from !== audience
			? ` (as ${audienceNames[rule.from]})`
			: "";
	return `${rule.detail} · ${rule.every} · ${rule.after ?? "at close"}${inherited}`;
}

const moreOpen = (
	next: ResolvedRule | null,
	before: ResolvedRule | null,
): boolean => {
	if (!next) return false;
	if (!before) return true;
	return (
		detailRank(next.detail) > detailRank(before.detail) ||
		grainRank(next.every) > grainRank(before.every) ||
		delayDays(next.after) < delayDays(before.after)
	);
};
const sameRule = (
	first: ResolvedRule | null,
	second: ResolvedRule | null,
): boolean =>
	JSON.stringify(first && { ...first, after: first.after ?? null }) ===
	JSON.stringify(second && { ...second, after: second.after ?? null });

/** The kind of a change, for the PIN dialog and the step-up: `public_open` needs the mailed link (it publishes). */
export type DisclosureChange = "none" | "stricter" | "open" | "public_open";
export type DisclosureError = {
	code: "below_floor" | "more_open_than_input" | "order";
	text: string;
};
export type DisclosureCheck = {
	errors: DisclosureError[];
	change: DisclosureChange;
};

/** The validator's line for a valid draft, by change (mockup `#dval`); with no draft, `noChange` (plus
 * `savedOverrideSuffix` before the period when the school has a saved override). */
export const disclosureMessages = {
	noChange: "No changes. The school uses the B4 Uni file.",
	savedOverrideSuffix: " plus its saved override",
	public_open:
		"Valid. More open for Public: your PIN and a mailed-link confirmation (it publishes).",
	open: "Valid. More open for members or governance: your PIN.",
	stricter:
		"Valid. Stricter: your PIN. Already-published documents still inside their delay are withdrawn.",
} as const;

const changeOrder: Record<DisclosureChange, number> = {
	none: 0,
	stricter: 1,
	open: 2,
	public_open: 3,
};

/** The spec's validator over a draft override (`400 below_floor`, `400 more_open_than_input`, `400 order`) and the
 * kind of change against the saved one. `formatMoney` writes minor units as the school's money without decimals. */
export function checkOverride(
	file: DisclosureFile,
	saved: DisclosureOverride,
	draft: DisclosureOverride,
	formatMoney: (minorUnits: number) => string,
): DisclosureCheck {
	const before = applyOverride(file, saved);
	const next = applyOverride(file, draft);
	const errors: DisclosureError[] = [];
	for (const [kpiClass, rules] of Object.entries(next.disclose) as Array<
		[RuledClass, Partial<Record<RuledAudience, DisclosureRule>>]
	>)
		for (const [audience, rule] of Object.entries(rules) as Array<
			[RuledAudience, DisclosureRule]
		>) {
			if (detailRank(rule.detail) >= detailRank("rows"))
				errors.push({
					code: "below_floor",
					text: `${kpiClassNames[kpiClass]} for ${audienceNames[audience]}: rows and names are for finance and the owner only`,
				});
			const money = ["income", "losses", "cash"].includes(kpiClass);
			if (
				audience === "public" &&
				money &&
				detailRank(rule.detail) > detailRank("categories")
			)
				errors.push({
					code: "below_floor",
					text: `Money for Public is at most categories (${kpiClass} at ${rule.detail})`,
				});
			if (
				audience === "public" &&
				kpiClass === "activity" &&
				detailRank(rule.detail) > detailRank("breakdown")
			)
				errors.push({
					code: "below_floor",
					text: "Activity for Public is at most breakdown",
				});
		}
	for (const [kpi, { inputs, capped }] of Object.entries(derivedKpis)) {
		if (capped) continue;
		for (const input of inputs) {
			const kpiClass = classOf(next, kpi);
			const inputClass = classOf(next, input);
			const opener = ruledAudiences.some((audience) =>
				moreOpen(
					classRule(next, kpiClass, audience),
					classRule(next, inputClass, audience),
				),
			);
			if (opener)
				errors.push({
					code: "more_open_than_input",
					text: `${kpi} (${kpiClass}) would be more open than its input ${input} (${inputClass})`,
				});
		}
	}
	if (classOf(next, "closing_balance_credits") !== "personal")
		errors.push({
			code: "below_floor",
			text: "closing_balance_credits is personal: only finance and the owner see it",
		});
	for (const kpiClass of kpiClasses)
		for (const audience of ["member", "governance"] as const) {
			if (kpiClass === "personal") continue;
			const parent = next.audiences[audience].parent;
			const rule = next.disclose[kpiClass]?.[audience];
			const parentRule = parent ? classRule(next, kpiClass, parent) : null;
			if (!(rule && parent && parentRule)) continue;
			const own = classRule(next, kpiClass, audience);
			if (moreOpen(parentRule, own))
				errors.push({
					code: "order",
					text: `${kpiClassNames[kpiClass]}: ${audienceNames[audience]} would be stricter than ${audienceNames[parent]}`,
				});
		}
	for (const size of ["small", "large"] as const)
		for (const audience of ["public", "member"] as const)
			if (next.rounding[size][audience] < file.rounding[size][audience])
				errors.push({
					code: "below_floor",
					text: `Money for ${audienceNames[audience]} (${size} school) can be rounded coarser, never finer than ${formatMoney(file.rounding[size][audience])}`,
				});
	let change: DisclosureChange = "none";
	const bump = (kind: DisclosureChange): void => {
		if (changeOrder[kind] > changeOrder[change]) change = kind;
	};
	const kpis = kpiClasses.flatMap((kpiClass) => file.classes[kpiClass]);
	for (const audience of ruledAudiences)
		for (const kpi of kpis) {
			const was = kpiRule(before, audience, kpi);
			const will = kpiRule(next, audience, kpi);
			if (sameRule(was, will)) continue;
			if (!moreOpen(will, was)) bump("stricter");
			else bump(audience === "public" ? "public_open" : "open");
		}
	for (const size of ["small", "large"] as const)
		for (const audience of ["public", "member"] as const) {
			const was = before.rounding[size][audience];
			const will = next.rounding[size][audience];
			if (will === was) continue;
			if (will > was) bump("stricter");
			else bump(audience === "public" ? "public_open" : "open");
		}
	return { errors, change };
}

/** The override editor's selection (mockup `dov`): the KPI to move, and the class and audience whose rule the
 * Detail, Every and After fields edit. It opens on refund_rate, Income and Member. */
export type OverrideSelection = {
	kpi: string;
	ruleClass: RuledClass;
	ruleAudience: RuledAudience;
};
export const initialOverrideSelection: OverrideSelection = {
	kpi: "refund_rate",
	ruleClass: "income",
	ruleAudience: "member",
};
/** One edit of the override editor (mockup `dovEdit`): `class` moves the selected KPI (back to its file class
 * removes the move); `detail` "" removes the rule (`null`); `detail`, `every` and `after` ("" is at close) set the
 * selected rule from the draft's effective one, or from total by quarter when there is none; `round` sets Public's
 * rounding for the school's size. */
export type OverrideEdit =
	| { field: "class"; value: KpiClass }
	| { field: "detail"; value: DetailStep | "" }
	| { field: "every"; value: DisclosureGrain }
	| { field: "after"; value: DisclosureDelay | "" }
	| { field: "round"; value: number };
export function editOverride(
	file: DisclosureFile,
	draft: DisclosureOverride,
	selection: OverrideSelection,
	size: SchoolSize,
	edit: OverrideEdit,
): DisclosureOverride {
	const next: DisclosureOverride = {
		...draft,
		...(draft.moves && { moves: { ...draft.moves } }),
		...(draft.rules && { rules: { ...draft.rules } }),
		...(draft.rounding && { rounding: { ...draft.rounding } }),
	};
	if (edit.field === "class") {
		const moves = { ...next.moves };
		if (classOf(file, selection.kpi) === edit.value)
			delete moves[selection.kpi];
		else moves[selection.kpi] = edit.value;
		return { ...next, moves };
	}
	if (edit.field === "round") {
		const rounding = { ...next.rounding };
		rounding[size] = { ...rounding[size], public: edit.value };
		return { ...next, rounding };
	}
	const key: RuleKey = `${selection.ruleClass}.${selection.ruleAudience}`;
	if (edit.field === "detail" && edit.value === "")
		return { ...next, rules: { ...next.rules, [key]: null } };
	const current = applyOverride(file, next).disclose[selection.ruleClass]?.[
		selection.ruleAudience
	] ?? { detail: "total", every: "quarter" };
	const rule: DisclosureRule = { ...current };
	if (edit.field === "detail" && edit.value !== "") rule.detail = edit.value;
	if (edit.field === "every") rule.every = edit.value;
	if (edit.field === "after") {
		if (edit.value === "") delete rule.after;
		else rule.after = edit.value;
	}
	return { ...next, rules: { ...next.rules, [key]: rule } };
}
