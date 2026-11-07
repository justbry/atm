/** Named, seeded scenarios: each is an org, a seed and knobs over the org's defaults (`defaultParamsOf`), nothing written by hand. */
import { DEFAULT_ORG, type OrgKind, tierIdsOf } from "./orgs.js";
import {
	checkResolvedParams,
	checkScenarioInput,
	defaultParamsOf,
	OPTIONAL_KNOBS,
	type ScenarioInput,
	type ScenarioParams,
} from "./params.js";

export type Profile = {
	name: string;
	/** The org it simulates; absent: the school. */
	org?: OrgKind;
	summary: string;
	seed: number;
	params: Partial<ScenarioParams>;
};

export const PROFILES: readonly Profile[] = [
	{
		name: "free-only",
		summary:
			"Every family is on a 100%-discounted invoice: credits are granted and used, no money moves.",
		seed: 101,
		params: {
			members: 20,
			freeShare: 1,
			addonRate: 0,
			refundRate: 0,
			disputeRate: 0,
		},
	},
	{
		name: "monthly-members",
		summary:
			"The baseline school: 24 monthly families across all four tiers, light refunds and rare disputes.",
		seed: 102,
		params: {},
	},
	{
		name: "annual-prepay",
		summary:
			"Everyone pays a year up front (no seminar seats: that tier has no yearly price), over 24 months so the renewals show.",
		seed: 103,
		params: {
			months: 24,
			yearlyShare: 1,
			tierMix: { audit: 3, scholar: 4, fellow: 1 },
			churnRate: 0.02,
		},
	},
	{
		name: "heavy-refunds",
		summary:
			"One paid invoice in five is refunded, two in five of those partly.",
		seed: 104,
		params: { refundRate: 0.2, partialRefundShare: 0.4 },
	},
	{
		name: "disputes",
		summary: "Card disputes on one paid invoice in twelve, half of them lost.",
		seed: 105,
		params: { disputeRate: 0.08, disputeLostShare: 0.5 },
	},
	{
		name: "non-usd",
		summary:
			"A euro menu: credits are granted, the USD books leave every money line out and count it as skipped.",
		seed: 106,
		params: { currency: "eur" },
	},
	{
		name: "growth-12mo",
		summary:
			"Six founding families and five new ones a month for a year, little churn.",
		seed: 107,
		params: { members: 6, newMembersPerMonth: 5, churnRate: 0.02 },
	},
	{
		name: "churn-spike",
		summary:
			"Forty families and a quarter of them leave at each renewal, for six months.",
		seed: 108,
		params: { members: 40, months: 6, churnRate: 0.25 },
	},
	{
		name: "one-payer-tier",
		summary:
			"Twenty families, nobody leaves: the fellow tier has exactly one payer, the other three tiers have several (6, 8 and 5).",
		seed: 109,
		params: {
			members: 20,
			months: 6,
			churnRate: 0,
			tierCounts: { audit: 6, scholar: 8, seminar: 5, fellow: 1 },
		},
	},
	{
		name: "tiny-school",
		summary: "Four families, six months: every cell has at most four holders.",
		seed: 110,
		params: { members: 4, months: 6 },
	},
	{
		name: "single-refund-month",
		summary:
			"Exactly one refund in the whole run, so one month holds a refund and every other month holds none.",
		seed: 111,
		params: { months: 6, refundCount: 1, disputeRate: 0 },
	},
	{
		name: "yearly-solo",
		summary:
			"Exactly one family pays yearly (a one-month spike in the money); everyone else pays monthly.",
		seed: 112,
		params: {
			members: 10,
			tierMix: { audit: 3, scholar: 4, fellow: 1 },
			yearlyCount: 1,
			addonRate: 0,
			refundRate: 0,
			disputeRate: 0,
		},
	},
	{
		name: "fee-oracle",
		summary:
			"Every payment is the same amount on one tier, with no add-ons, refunds, disputes or free invoices: Stripe's fees total exactly the payment count times the fee on one payment.",
		seed: 113,
		params: {
			members: 12,
			months: 6,
			tierMix: { scholar: 1 },
			addonRate: 0,
			refundRate: 0,
			disputeRate: 0,
		},
	},
	{
		name: "seminar-quantities",
		summary:
			"Everyone is on the seminar tier, sold in 1, 2 or 4 seats: payments of three sizes, so a month's total is a subset-sum puzzle.",
		seed: 114,
		params: {
			members: 12,
			months: 6,
			tierMix: { seminar: 1 },
			addonRate: 0,
			refundRate: 0,
			disputeRate: 0,
		},
	},
	{
		name: "child-only",
		summary:
			"Every membership is a child's own profile (holder `profile:prof_NNN`, never `family:`), across all four tiers.",
		seed: 115,
		params: { members: 12, months: 6, childShare: 1 },
	},
	{
		name: "studio-members",
		org: "studio",
		summary:
			"Ironbark Studio's year: forty founding members and three new ones a month across off-peak, core, class-pack and all-access memberships, some paid annually; drop-ins, ten-class packs and PT intros as add-ons; unused classes roll over or expire; one member in sixteen cancels each month.",
		seed: 201,
		params: {
			members: 40,
			newMembersPerMonth: 3,
			yearlyShare: 0.15,
			addonRate: 0.45,
			churnRate: 0.06,
			usageRate: 0.85,
			refundRate: 0.015,
			disputeRate: 0.004,
		},
	},
	{
		name: "studio-class-packs",
		org: "studio",
		summary:
			"Ironbark Studio sells mostly class packs (five classes each, bought one or two at a time, rolling over for two months before they expire), with ten-class packs and drop-ins on top; some buy a second pack mid-month, some drop back to one at renewal, and members come and go faster than on a membership.",
		seed: 202,
		params: {
			members: 24,
			newMembersPerMonth: 2,
			months: 9,
			tierMix: { "off-peak": 1, core: 1, "class-pack": 6 },
			addonRate: 0.6,
			churnRate: 0.1,
			usageRate: 0.7,
			seatChangeRate: 0.2,
		},
	},
	{
		name: "church-giving",
		org: "church",
		summary:
			"Cedar Hill Community Church's giving: sixty households give monthly or yearly at $25, $50, $100 or $250, with one-time gifts, the new roof campaign and family retreat registrations on top; a few mistaken gifts are refunded, disputes are rare, and the nonprofit card rate applies.",
		seed: 301,
		params: {
			members: 60,
			newMembersPerMonth: 2,
			yearlyShare: 0.25,
			addonRate: 0.5,
			churnRate: 0.015,
			refundRate: 0.012,
			partialRefundShare: 0.3,
			disputeRate: 0.001,
			usageRate: 0.9,
			feePercent: 2.2,
		},
	},
	{
		name: "saas-seats",
		org: "saas",
		summary:
			"Lumen Notes over a year: solo plans and per-seat team and business plans, a third prepaid annually; teams add seats mid-month (prorated at once) or drop them at renewal, some customers move up a plan, and API-call credits are used each month with boost packs on top.",
		seed: 401,
		params: {
			members: 45,
			newMembersPerMonth: 4,
			yearlyShare: 0.3,
			addonRate: 0.3,
			churnRate: 0.03,
			refundRate: 0.01,
			disputeRate: 0.003,
			usageRate: 0.9,
			seatChangeRate: 0.12,
			upgradeRate: 0.04,
		},
	},
	{
		name: "saas-annual",
		org: "saas",
		summary:
			"Lumen Notes sold annually: every customer prepays a year on a solo, team or business plan, over 24 months so the renewals show; API-call credits are used each month, and little churn.",
		seed: 402,
		params: {
			months: 24,
			members: 20,
			yearlyShare: 1,
			tierMix: { solo: 2, team: 3, business: 2 },
			addonRate: 0.25,
			churnRate: 0.01,
			refundRate: 0.01,
			disputeRate: 0,
		},
	},
	{
		name: "creator-launch",
		org: "creator",
		summary:
			"Night Kitchen Courses launches: ninety members join the paid community in the launch month, then four a month; many buy a course or the recipe pack at sign-up, refunds run high, and one member in twelve leaves each month.",
		seed: 501,
		params: {
			members: 90,
			newMembersPerMonth: 4,
			yearlyShare: 0.1,
			addonRate: 0.55,
			churnRate: 0.08,
			refundRate: 0.07,
			partialRefundShare: 0.2,
			disputeRate: 0.006,
			usageRate: 0.5,
		},
	},
];

export const PROFILE_NAMES = PROFILES.map((p) => p.name);

export const profileByName = (name: string): Profile => {
	const found = PROFILES.find((p) => p.name === name);
	if (!found)
		throw new Error(`no profile ${name}; presets: ${PROFILE_NAMES.join(", ")}`);
	return found;
};

/** A scenario with every knob and the seed filled in. This, not the input, is what is hashed and generated from. */
export type ResolvedScenario = {
	/** The org simulated; absent for the school (so a school scenario hashes as it did before orgs). */
	org?: OrgKind;
	profile: string | null;
	name: string;
	seed: number;
	params: ScenarioParams;
};

/** Preset knobs, then the input's over them; `seed` of the input wins over the preset's. An ad-hoc scenario with no preset starts from `DEFAULT_PARAMS` and seed 1. */
export const resolveScenario = (raw: unknown): ResolvedScenario => {
	const input: ScenarioInput = checkScenarioInput(
		raw,
		PROFILE_NAMES,
		(name) => profileByName(name).org ?? DEFAULT_ORG,
	);
	const preset = input.profile ? profileByName(input.profile) : null;
	const org = input.org ?? preset?.org ?? DEFAULT_ORG;
	const params = {
		...defaultParamsOf(org),
		...(preset?.params ?? {}),
		...(input.params ?? {}),
	} as ScenarioParams;
	// a knob added after the goldens is left out at its default, so the scenarios before it hash as they did
	for (const [knob, value] of Object.entries(OPTIONAL_KNOBS))
		if (params[knob as keyof typeof OPTIONAL_KNOBS] === value)
			delete params[knob as keyof typeof OPTIONAL_KNOBS];
	// a tier mix named in part replaces the preset's whole (a missing tier has weight 0)
	checkResolvedParams(params, tierIdsOf(org));
	return {
		...(org === DEFAULT_ORG ? {} : { org }),
		profile: input.profile ?? null,
		name: input.name ?? input.profile ?? "ad-hoc",
		seed: input.seed ?? preset?.seed ?? 1,
		params,
	};
};
