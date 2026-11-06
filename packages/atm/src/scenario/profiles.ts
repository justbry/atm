/** Named, seeded scenarios: each is a seed and knobs over `DEFAULT_PARAMS`, nothing written by hand. */
import {
	checkResolvedParams,
	checkScenarioInput,
	DEFAULT_PARAMS,
	type ScenarioInput,
	type ScenarioParams,
} from "./params.js";

export type Profile = {
	name: string;
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
	profile: string | null;
	name: string;
	seed: number;
	params: ScenarioParams;
};

/** Preset knobs, then the input's over them; `seed` of the input wins over the preset's. An ad-hoc scenario with no preset starts from `DEFAULT_PARAMS` and seed 1. */
export const resolveScenario = (raw: unknown): ResolvedScenario => {
	const input: ScenarioInput = checkScenarioInput(raw, PROFILE_NAMES);
	const preset = input.profile ? profileByName(input.profile) : null;
	const params = {
		...DEFAULT_PARAMS,
		...(preset?.params ?? {}),
		...(input.params ?? {}),
	} as ScenarioParams;
	// a tier mix named in part replaces the preset's whole (a missing tier has weight 0)
	checkResolvedParams(params);
	return {
		profile: input.profile ?? null,
		name: input.name ?? input.profile ?? "ad-hoc",
		seed: input.seed ?? preset?.seed ?? 1,
		params,
	};
};
