import type {
	Menu,
	MenuFeature,
	MenuVersionBody,
	MenuVersions,
	PlanSummary,
} from "../data/plans.ts";

/** What the fixture Reader returns for the Plans tab: the mockup's `SC.<school>.pl` as buzz-school menu bodies
 * (amounts in cents), and the counts its headless run shows on 2026-11-05. Vibes of Light also has a saved,
 * unpublished v4 (Glow $65.00 to $70.00 a month), as its Plans tab badge says. Earlier versions are listed but never
 * opened. */
export type SchoolPlans = {
	versions: MenuVersions;
	bodies: Record<number, MenuVersionBody>;
	summary: PlanSummary;
};

const feature = (id: string, name: string, one: string): MenuFeature => ({
	id,
	name,
	unit: { one, other: id },
});
const sessions = feature("sessions", "Sessions", "session");
const credits = feature("credits", "Credits", "credit");
const classes = feature("classes", "Classes", "class");

const vibesLive: Menu = {
	currency: "usd",
	timeZone: "America/Denver",
	features: [sessions],
	tiers: [
		{
			id: "sparkle",
			name: "Sparkle",
			blurb: "A little time, every month",
			public: true,
			prices: [
				{ interval: "month", amount: 3250 },
				{ interval: "year", amount: 35000 },
			],
			grants: [
				{
					featureId: "sessions",
					amount: 8,
					every: "month",
					rollover: { months: 1 },
				},
			],
			quantities: [1, 2, 4],
		},
		{
			id: "shine",
			name: "Shine",
			blurb: "Regular sessions",
			public: true,
			prices: [
				{ interval: "month", amount: 3000 },
				{ interval: "year", amount: 32400 },
			],
			grants: [
				{
					featureId: "sessions",
					amount: 6,
					every: "month",
					rollover: { months: 1 },
				},
			],
			quantities: [2, 4],
		},
		{
			id: "glow",
			name: "Glow",
			blurb: "One big plan",
			public: true,
			prices: [
				{ interval: "month", amount: 6500 },
				{ interval: "year", amount: 70200 },
			],
			grants: [{ featureId: "sessions", amount: 24, every: "month" }],
		},
	],
	addons: [
		{
			id: "pack8",
			name: "Top-up pack",
			price: { amount: 4000, every: "once" },
			grants: [{ featureId: "sessions", amount: 8, every: "month" }],
		},
		{
			id: "pack16",
			name: "Big top-up pack",
			price: { amount: 7200, every: "once" },
			grants: [{ featureId: "sessions", amount: 16, every: "month" }],
		},
	],
};

/** The saved draft: Glow at $70.00 a month. */
const vibesDraft: Menu = {
	...vibesLive,
	tiers: vibesLive.tiers.map((tier) =>
		tier.id === "glow"
			? {
					...tier,
					prices: [
						{ interval: "month", amount: 7000 },
						{ interval: "year", amount: 70200 },
					],
				}
			: tier,
	),
};

const b4uLive: Menu = {
	currency: "usd",
	timeZone: "America/Chicago",
	features: [credits],
	tiers: [
		{
			id: "sparkle",
			name: "Sparkle",
			blurb: "Starter",
			public: true,
			prices: [{ interval: "month", amount: 2000 }],
			grants: [
				{
					featureId: "credits",
					amount: 8,
					every: "month",
					rollover: { months: 1 },
				},
			],
		},
		{
			id: "shine",
			name: "Shine",
			blurb: "Regular",
			public: true,
			prices: [{ interval: "month", amount: 4500 }],
			grants: [
				{
					featureId: "credits",
					amount: 12,
					every: "month",
					rollover: { months: 1 },
				},
			],
			quantities: [1, 2],
		},
		{
			id: "board",
			name: "Board",
			blurb: "For board members. Not for sale: the owner gives it.",
			public: false,
			prices: [],
			grants: [{ featureId: "credits", amount: 2, every: "month" }],
			audience: "governance",
		},
	],
	addons: [],
};

/** Harbor Arts Academy (mockup `SC.har.pl`): Studio and Ensemble on sale, Board given by the owner. */
const harborArtsLive: Menu = {
	currency: "usd",
	timeZone: "America/New_York",
	features: [credits],
	tiers: [
		{
			id: "studio",
			name: "Studio",
			blurb: "Weekly studio time",
			public: true,
			prices: [{ interval: "month", amount: 12000 }],
			grants: [
				{
					featureId: "credits",
					amount: 8,
					every: "month",
					rollover: { months: 1 },
				},
			],
		},
		{
			id: "ensemble",
			name: "Ensemble",
			blurb: "Ensemble and lessons",
			public: true,
			prices: [{ interval: "month", amount: 24000 }],
			grants: [
				{
					featureId: "credits",
					amount: 16,
					every: "month",
					rollover: { months: 1 },
				},
			],
		},
		{
			id: "board",
			name: "Board",
			blurb: "For trustees. Not for sale: the owner gives it.",
			public: false,
			prices: [],
			grants: [{ featureId: "credits", amount: 2, every: "month" }],
			audience: "governance",
		},
	],
	addons: [],
};

const maplePilatesLive: Menu = {
	currency: "cad",
	timeZone: "America/Toronto",
	features: [classes],
	tiers: [
		{
			id: "glow",
			name: "Glow",
			blurb: "Unlimited feel",
			public: true,
			prices: [{ interval: "month", amount: 8500 }],
			grants: [{ featureId: "classes", amount: 24, every: "month" }],
		},
	],
	addons: [],
};

export const plansBySchool: Record<string, SchoolPlans> = {
	vol: {
		versions: {
			versions: [
				{ version: 4, publishedAt: null, savedAt: 1793808300 },
				{ version: 3, publishedAt: 1788278400, savedAt: 1788276660 },
				{ version: 2, publishedAt: 1781535600, savedAt: 1781535120 },
				{ version: 1, publishedAt: 1772470800, savedAt: 1772469600 },
			],
		},
		bodies: {
			3: {
				version: 3,
				publishedAt: 1788278400,
				savedAt: 1788276660,
				menu: vibesLive,
				stripe: {
					products: ["t:sparkle", "t:shine", "t:glow", "a:pack8", "a:pack16"],
					prices: [
						"t:sparkle:month",
						"t:sparkle:year",
						"t:shine:month",
						"t:shine:year",
						"t:glow:month",
						"t:glow:year",
						"a:pack8:once",
						"a:pack16:once",
					],
					portal: true,
				},
			},
			4: {
				version: 4,
				publishedAt: null,
				savedAt: 1793808300,
				menu: vibesDraft,
				stripe: { products: [], prices: [], portal: false },
			},
		},
		summary: {
			activeMembers: 5,
			endingSoon: 1,
			collected: { period: "2026-11", amount: 28700 },
			tiers: [
				{ tierId: "sparkle", active: 3, ending: 0, activeUnits: 7 },
				{ tierId: "shine", active: 1, ending: 1, activeUnits: 4 },
				{ tierId: "glow", active: 1, ending: 0, activeUnits: 1 },
			],
			features: [sessions],
			stripeConnected: true,
			purchaseLinkShared: true,
		},
	},
	b4u: {
		versions: {
			versions: [
				{ version: 3, publishedAt: 1787583600, savedAt: 1787580600 },
				{ version: 2, publishedAt: 1775487600, savedAt: 1775486700 },
				{ version: 1, publishedAt: 1768230000, savedAt: 1768227600 },
			],
		},
		bodies: {
			3: {
				version: 3,
				publishedAt: 1787583600,
				savedAt: 1787580600,
				menu: b4uLive,
				stripe: {
					products: ["t:sparkle", "t:shine"],
					prices: ["t:sparkle:month", "t:shine:month"],
					portal: true,
				},
			},
		},
		summary: {
			activeMembers: 7,
			endingSoon: 0,
			collected: { period: "2026-06", amount: 62300 },
			tiers: [
				{ tierId: "sparkle", active: 4, ending: 0, activeUnits: 4 },
				{ tierId: "shine", active: 2, ending: 0, activeUnits: 3 },
				{ tierId: "board", active: 1, ending: 0, activeUnits: 1 },
			],
			features: [credits],
			stripeConnected: true,
			purchaseLinkShared: true,
		},
	},
	map: {
		versions: {
			versions: [
				{ version: 3, publishedAt: 1789394400, savedAt: 1789391700 },
				{ version: 2, publishedAt: 1777903200, savedAt: 1777902600 },
				{ version: 1, publishedAt: 1770040800, savedAt: 1770039000 },
			],
		},
		bodies: {
			3: {
				version: 3,
				publishedAt: 1789394400,
				savedAt: 1789391700,
				menu: maplePilatesLive,
				stripe: {
					products: ["t:glow"],
					prices: ["t:glow:month"],
					portal: false,
				},
			},
		},
		summary: {
			activeMembers: 2,
			endingSoon: 1,
			collected: { period: "2026-11", amount: 8500 },
			tiers: [{ tierId: "glow", active: 2, ending: 1, activeUnits: 2 }],
			features: [classes],
			stripeConnected: true,
			purchaseLinkShared: false,
		},
	},
	har: {
		versions: {
			versions: [
				{ version: 3, publishedAt: 1790683200, savedAt: 1790681400 },
				{ version: 2, publishedAt: 1779192000, savedAt: 1779190200 },
				{ version: 1, publishedAt: 1767268800, savedAt: 1767267000 },
			],
		},
		bodies: {
			3: {
				version: 3,
				publishedAt: 1790683200,
				savedAt: 1790681400,
				menu: harborArtsLive,
				stripe: {
					products: ["t:studio", "t:ensemble", "t:board"],
					prices: ["t:studio:month", "t:ensemble:month"],
					portal: true,
				},
			},
		},
		summary: {
			activeMembers: 4,
			endingSoon: 0,
			collected: { period: "2026-11", amount: 36000 },
			tiers: [
				{ tierId: "studio", active: 2, ending: 0, activeUnits: 2 },
				{ tierId: "ensemble", active: 1, ending: 0, activeUnits: 1 },
				{ tierId: "board", active: 1, ending: 0, activeUnits: 1 },
			],
			features: [credits],
			stripeConnected: true,
			purchaseLinkShared: true,
		},
	},
	nw: {
		versions: { versions: [] },
		bodies: {},
		summary: {
			activeMembers: 0,
			endingSoon: 0,
			collected: null,
			tiers: [],
			features: [classes],
			stripeConnected: false,
			purchaseLinkShared: false,
		},
	},
};
