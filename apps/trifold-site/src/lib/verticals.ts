/**
 * The simulated verticals: one demo org per kind of organization, run through the same engine and the same three-way
 * KPI check (the engine's fold, hledger, DuckDB). Every org is synthetic: invented names, prices and ids, never a
 * customer. Source: packages/atm/docs/scenario-orgs.md (SCENARIO_ORGS_URL).
 *
 * The school has a live dashboard (DEMO_URL). The other four are "simulated": numbers from the CLI, no dashboard and
 * no demo link. Preset numbers are copied from verified runs on atm dev; tests/proof.test.ts checks them against that
 * run and against every page and llms.txt that shows them. Copy rules: describe only what the generator models (no
 * win-back, pledges, refund windows or failed payments) and use only KPIs the engine computes (no MRR, no retention).
 */
import { DEMO_URL, GITHUB_URL } from "#lib/config";

export const SCENARIO_ORGS_URL = `${GITHUB_URL}/blob/dev/packages/atm/docs/scenario-orgs.md`;

/** One verified preset run. `hash` is the KPI hash, first eight and last four characters. */
export type Preset = {
	name: string;
	seed: number;
	months: string;
	/** new_paying_members */
	members: number;
	/** payments_count */
	invoices: number;
	refunds: number;
	disputes: number;
	/** gross_collected, as the CLI prints it in dollars. */
	grossCollected: string;
	/** paying_members_last_month */
	payingLastMonth: number;
	/** Why paying_members_last_month reads as it does, when it needs saying. */
	payingNote?: string;
	hash: string;
	what: string;
};

export type StatKey = "grossCollected" | "members" | "payingLastMonth";
/** A headline number's label and the engine's KPI name, shown beside it in mono. */
export const STATS: Record<StatKey, { label: string; kpi: string }> = {
	grossCollected: { label: "Gross collected", kpi: "gross_collected" },
	members: { label: "New paying members", kpi: "new_paying_members" },
	payingLastMonth: {
		label: "Paying members last month",
		kpi: "paying_members_last_month",
	},
};
export const STAT_KEYS: StatKey[] = [
	"grossCollected",
	"members",
	"payingLastMonth",
];

/** The KPIs every simulated preset produces (the engine's own list; nothing else is claimed). */
export const SIMULATED_KPIS = [
	"Gross collected",
	"Net income",
	"Refunds",
	"Disputes",
	"Stripe fees",
	"Payouts",
	"Payments",
	"New paying members",
	"Paying members last month",
	"Credits granted, consumed and expired",
];

export type Vertical = {
	slug: string;
	name: string;
	/** The demo org's invented name. */
	org: string;
	/** "a simulated studio": how the org is introduced after its name. */
	orgKind: string;
	/** The organization's own words, in the order a reader meets them. */
	vocabulary: string[];
	/** What the scenario models, honestly. */
	simulates: string[];
	/** For "dashboard": what the demo shows. For "simulated": SIMULATED_KPIS, in the org's words where they differ. */
	kpis: string[];
	status: "dashboard" | "simulated";
	demoUrl?: string;
	/** The audience page, when there is one. */
	forPage?: string;
	/** Verified preset runs; the first is the headline. */
	presets: Preset[];
	/** Labels in the org's own words, where a KPI's name doesn't fit (a church has givers and giving). */
	labels?: Partial<Record<StatKey, string>>;
};

export const VERTICALS: Vertical[] = [
	{
		slug: "schools",
		name: "Schools",
		org: "Honeycomb Hill Academy",
		orgKind: "a sample school",
		vocabulary: ["families", "tiers", "class credits", "yearly prepay"],
		simulates: [
			"Families on tiers",
			"Class credits",
			"Add-ons",
			"Yearly prepay",
			"Refunds",
			"Disputes",
		],
		kpis: ["Collected", "Net income", "Stripe fees", "Payouts"],
		status: "dashboard",
		demoUrl: DEMO_URL,
		forPage: "/for/schools",
		presets: [],
	},
	{
		slug: "studios",
		name: "Studios and gyms",
		org: "Ironbark Studio",
		orgKind: "a simulated studio",
		vocabulary: ["members", "memberships", "class packs", "drop-ins"],
		simulates: [
			"Four memberships: off-peak (4 classes a month), core (12, up to 4 carry over), class pack and all access",
			"About 1 in 7 pays annually",
			"Drop-ins, ten-class packs and PT intro sessions as add-ons",
			"Unused classes roll over or expire",
			"About 1 in 16 cancels each month",
		],
		kpis: SIMULATED_KPIS,
		status: "simulated",
		forPage: "/for/studios",
		presets: [
			{
				name: "studio-members",
				seed: 201,
				months: "2026-01..2026-12",
				members: 73,
				invoices: 512,
				refunds: 3,
				disputes: 1,
				grossCollected: "$47,527",
				payingLastMonth: 45,
				hash: "c315b659…ca91",
				what: "A year of memberships, add-ons and class credits.",
			},
			{
				name: "studio-class-packs",
				seed: 202,
				months: "2026-01..2026-09",
				members: 40,
				invoices: 199,
				refunds: 1,
				disputes: 2,
				grossCollected: "$17,771.63",
				payingLastMonth: 22,
				hash: "cdbb0c6d…587e",
				what: "Nine months of five-class packs, bought one or two at a time; unused classes roll over two months, then expire.",
			},
		],
	},
	{
		slug: "churches",
		name: "Churches",
		org: "Cedar Hill Community Church",
		orgKind: "a simulated church",
		vocabulary: ["givers", "recurring giving", "gifts", "roof campaign"],
		simulates: [
			"Sixty households give $25, $50, $100 or $250 a month, or the same yearly",
			"About a quarter give yearly",
			"Some add a one-time gift, a roof-campaign gift or a retreat registration",
			"A few mistaken gifts refunded, often in part",
			"A nonprofit card rate: 2.2% + 30¢",
		],
		// The engine's KPIs in a church's words; each label's KPI name is shown beside its number.
		kpis: [
			"Giving collected",
			"Net income",
			"Refunds",
			"Disputes",
			"Stripe fees",
			"Payouts",
			"Payments",
			"New givers",
			"Givers giving last month",
			"Credits granted, consumed and expired",
		],
		status: "simulated",
		forPage: "/for/churches",
		labels: {
			grossCollected: "Giving collected",
			members: "New givers",
			payingLastMonth: "Givers giving last month",
		},
		presets: [
			{
				name: "church-giving",
				seed: 301,
				months: "2026-01..2026-12",
				members: 82,
				invoices: 608,
				refunds: 5,
				disputes: 0,
				grossCollected: "$68,050",
				payingLastMonth: 52,
				hash: "b87fa3cb…7904",
				what: "A year of recurring giving at four fixed levels, with one-time and roof-campaign gifts.",
			},
		],
	},
	{
		slug: "saas",
		name: "SaaS and digital products",
		org: "Lumen Notes",
		orgKind: "a simulated SaaS product",
		vocabulary: ["seats", "plans", "proration", "usage credits"],
		simulates: [
			"Solo, team (3, 5 or 10 seats) and business (10, 25 or 50 seats), priced per seat",
			"About a third prepay annually",
			"Seats added mid-month, billed at once with proration; dropped at renewal",
			"Upgrades from solo to team to business",
			"API usage as credit blocks of 1,000 calls",
			"Boost packs and support add-ons",
		],
		kpis: SIMULATED_KPIS,
		status: "simulated",
		forPage: "/for/saas",
		presets: [
			{
				name: "saas-seats",
				seed: 401,
				months: "2026-01..2026-12",
				members: 89,
				invoices: 515,
				refunds: 3,
				disputes: 1,
				grossCollected: "$69,521",
				payingLastMonth: 49,
				hash: "cd0acf28…69f6",
				what: "A year of seat plans, seats added and dropped, upgrades and API credits.",
			},
			{
				name: "saas-annual",
				seed: 402,
				months: "2026-01..2027-12",
				members: 20,
				invoices: 38,
				refunds: 0,
				disputes: 0,
				grossCollected: "$52,993",
				payingLastMonth: 0,
				payingNote: "every plan is yearly, so nobody pays in a given month",
				hash: "84d6c33c…3f36",
				what: "Everyone prepays a year, over 24 months so the renewals show.",
			},
		],
	},
	{
		slug: "creators",
		name: "Creators and online courses",
		org: "Night Kitchen Courses",
		orgKind: "a simulated course creator",
		vocabulary: ["members", "courses", "launch month", "cook-alongs"],
		simulates: [
			"90 members join the paid community in the launch month, then four a month",
			"Many buy a course (sourdough, knife skills) or the recipe pack at sign-up",
			"Members book live cook-alongs",
			"Refunds on about 7% of payments",
			"About 1 in 12 leaves each month",
		],
		kpis: SIMULATED_KPIS,
		status: "simulated",
		forPage: "/for/creators",
		presets: [
			{
				name: "creator-launch",
				seed: 501,
				months: "2026-01..2026-12",
				members: 134,
				invoices: 851,
				refunds: 61,
				disputes: 6,
				grossCollected: "$25,297",
				payingLastMonth: 66,
				hash: "38e8325c…62ad",
				what: "A launch month, a steady trickle after it, course sales and refunds.",
			},
		],
	},
];

export const verticalBySlug = (slug: string): Vertical => {
	const vertical = VERTICALS.find((entry) => entry.slug === slug);
	if (!vertical) throw new Error(`No vertical "${slug}"`);
	return vertical;
};

/** A headline number as shown: the org's label, the KPI's name, and the value. */
export const statOf = (vertical: Vertical, preset: Preset, key: StatKey) => ({
	label: vertical.labels?.[key] ?? STATS[key].label,
	kpi: STATS[key].kpi,
	value: key === "grossCollected" ? preset.grossCollected : String(preset[key]),
});

/** A preset as a card shows it: its run and its three headline numbers in the org's words. */
export type PresetView = {
	name: string;
	seed: number;
	months: string;
	stats: ReturnType<typeof statOf>[];
};
export const presetView = (vertical: Vertical, preset: Preset): PresetView => ({
	name: preset.name,
	seed: preset.seed,
	months: preset.months,
	stats: STAT_KEYS.map((key) => statOf(vertical, preset, key)),
});

/**
 * The homepage gallery's cards: only what a compact card shows. vite.config.ts inlines them as __GALLERY__
 * (src/lib/gallery.ts), so the homepage doesn't ship this module.
 */
export type GalleryCard = Pick<
	Vertical,
	"slug" | "name" | "org" | "orgKind" | "status" | "demoUrl" | "forPage"
> & {
	vocabulary?: string[];
	simulates?: string[];
	kpis?: string[];
	preset?: PresetView;
};
export const galleryCards = (): GalleryCard[] =>
	VERTICALS.map((vertical) => {
		const {
			slug,
			name,
			org,
			orgKind,
			status,
			demoUrl,
			forPage,
			vocabulary,
			simulates,
			kpis,
			presets,
		} = vertical;
		const [headline] = presets;
		return {
			slug,
			name,
			org,
			orgKind,
			status,
			demoUrl,
			forPage,
			...(status === "dashboard" ? { vocabulary, simulates, kpis } : {}),
			...(headline ? { preset: presetView(vertical, headline) } : {}),
		};
	});

export const describeCommand = (preset: Preset) =>
	`bun ./src/bin.ts scenarios describe ${preset.name}`;

/** Where the simulations are the closest honest fit, not an exact one (scenario-orgs.md). */
export const SIMPLIFICATIONS = [
	"Everyone who pays is a member.",
	"A one-time purchase (a gift, a course, a drop-in) comes only with a member's first invoice, and each member has one add-on at most.",
	"Add-on money is booked to the member's tier, not a separate income line.",
	"Church giving is four fixed recurring amounts: no pledges, no custom amounts, no campaign goals.",
	"SaaS usage is counted in blocks of 1,000 calls.",
	"A launch spike is the founding month.",
	"There's no MRR KPI yet.",
];
