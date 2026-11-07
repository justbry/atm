/**
 * Each demo org's own words for the KPI dashboard demos (`scripts/org-demos`): what a payer, a plan and a credit are
 * called there, and which presets its page shows. The ledger model's synonyms are generic (a holder is "holder, family,
 * payer, subject, customer" for every org), so the per-org words live here, beside the registry (`orgs.ts`). Every name
 * is invented.
 */
import { ORGS, type OrgKind } from "./orgs.js";

type Noun = { one: string; other: string };

export type OrgLabels = {
	/** The name the website shows: the school is Before University in the fixtures and Honeycomb Hill Academy online. */
	displayName: string;
	/** Who pays. */
	holder: Noun;
	/** What a tier is called. */
	plan: Noun;
	/** What one credit is (the credit KPIs sum every feature's credits). */
	credit: Noun;
	/** The title of `revenue_by_kind:membership`: what the org's income is. */
	income: string;
	/** The presets the org's page shows, first the default, with the switcher's label. */
	presets: Array<{ name: string; label: string }>;
};

export const ORG_LABELS: Record<OrgKind, OrgLabels> = {
	school: {
		displayName: "Honeycomb Hill Academy",
		holder: { one: "family", other: "families" },
		plan: { one: "membership", other: "memberships" },
		credit: { one: "class credit", other: "class credits" },
		income: "Memberships",
		presets: [
			{ name: "monthly-members", label: "Monthly members" },
			{ name: "growth-12mo", label: "Growth over 12 months" },
		],
	},
	studio: {
		displayName: ORGS.studio.name,
		holder: { one: "member", other: "members" },
		plan: { one: "membership", other: "memberships" },
		credit: { one: "class", other: "classes" },
		income: "Memberships and class packs",
		presets: [
			{ name: "studio-members", label: "Memberships" },
			{ name: "studio-class-packs", label: "Class packs" },
		],
	},
	church: {
		displayName: ORGS.church.name,
		holder: { one: "giver", other: "givers" },
		plan: { one: "giving level", other: "giving levels" },
		credit: { one: "retreat seat", other: "retreat seats" },
		income: "Giving",
		presets: [{ name: "church-giving", label: "A year of giving" }],
	},
	saas: {
		displayName: ORGS.saas.name,
		holder: { one: "customer", other: "customers" },
		plan: { one: "plan", other: "plans" },
		credit: { one: "API-call block", other: "API-call blocks" },
		income: "Subscriptions and seats",
		presets: [
			{ name: "saas-seats", label: "Seats, monthly and annual" },
			{ name: "saas-annual", label: "Annual prepay" },
		],
	},
	creator: {
		displayName: ORGS.creator.name,
		holder: { one: "member", other: "members" },
		plan: { one: "membership", other: "memberships" },
		credit: { one: "cook-along seat", other: "cook-along seats" },
		income: "Memberships and course sales",
		presets: [{ name: "creator-launch", label: "Launch year" }],
	},
};

const capitalized = (text: string): string =>
	`${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * The org's titles for the KPIs whose catalog title names a member, a plan or a credit; a plan's KPI takes the menu's
 * tier name. A KPI not named here keeps the document's own title, so a KPI the catalog adds shows up as the catalog
 * titles it.
 */
export const orgKpiTitles = (kind: OrgKind): Record<string, string> => {
	const { holder, credit, income } = ORG_LABELS[kind];
	const credits = capitalized(credit.other);
	return {
		paying_members: `Paying ${holder.other}`,
		new_paying_members: `New paying ${holder.other}`,
		arpa: `Avg per paying ${holder.one}`,
		"revenue_by_kind:membership": income,
		credits_granted: `${credits} granted`,
		credits_consumed: `${credits} used`,
		credits_expired: `${credits} expired`,
		...Object.fromEntries(
			ORGS[kind].menu.tiers.map((tier) => [
				`revenue_by_tier:${tier.id}`,
				tier.name,
			]),
		),
	};
};
