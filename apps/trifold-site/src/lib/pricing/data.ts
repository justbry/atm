/**
 * Planned prices, ported from docs/business/pricing-page.html (draft, 2026-11-06). Proposals, not offers. CTAs follow
 * the site's rule: nothing says "Start free" for the hosted product, which isn't open yet.
 */
import { CLI_URL } from "#lib/config";

export const ANNUAL_MONTHS_CHARGED = 10;
export const EVENTS_PER_FAMILY = 7;

export type Org = "std" | "np";
export type Feature =
	| string
	| { text: string; soon?: boolean; np?: boolean; plus?: boolean };

export type Plan = {
	id: string;
	name: string;
	tagline: string;
	price: Record<Org, number>;
	events: number;
	/** What the card shows instead of events, credits and seats (those live in the matrix only). */
	families: string;
	cta: { label: string; href: string; external?: boolean };
	badge?: string;
	featured?: boolean;
	witness?: boolean;
	features: Feature[];
};

const EARLY = { label: "Get early access", href: "/early-access" };

export const PLANS: Plan[] = [
	{
		id: "free",
		name: "Free",
		tagline: "Hosted books for small organizations getting started.",
		price: { std: 0, np: 0 },
		events: 1000,
		families: "About 140 families",
		cta: EARLY,
		features: [
			"Books built from your Stripe events",
			"Signed receipts on every plan, even Free",
			"Sealed months",
			"Reports and on-demand reconcile",
			"1 Pricing Lab forecast a month",
			{
				text: "Witnessed free for non-profits under $50K a year",
				np: true,
				plus: true,
				soon: true,
			},
		],
	},
	{
		id: "starter",
		name: "Starter",
		tagline: "Signed receipts on top of the books you already keep.",
		price: { std: 29, np: 15 },
		events: 5000,
		families: "About 700 families",
		cta: EARLY,
		features: [
			"Everything in Free",
			{ text: "QuickBooks or Xero sync", soon: true },
			"Email support",
			"Free seats for your CPA",
		],
	},
	{
		id: "pro",
		name: "Pro",
		tagline: "Your month closes on a schedule.",
		price: { std: 79, np: 39 },
		badge: "Recommended",
		featured: true,
		events: 25000,
		families: "About 3,500 families",
		cta: EARLY,
		features: [
			"Everything in Starter",
			"Up to 3 organizations",
			"Pricing Lab: forecasts and saved scenarios",
			"Daily reconcile with alerts",
			"Scheduled monthly close",
			"Roles, approvals and Google sign-in",
			{ text: "Bank-statement import (CSV/OFX)", soon: true },
			{
				text: "Rifo drafts. You approve. The engine does the math.",
				soon: true,
			},
			{ text: 'Public "open books" page', np: true, soon: true },
		],
	},
	{
		id: "witnessed",
		name: "Witnessed",
		tagline: "Books an auditor, grantor or state program can verify.",
		price: { std: 149, np: 79 },
		badge: "Early access",
		witness: true,
		events: 25000,
		families: "About 3,500 families",
		cta: EARLY,
		features: [
			"Everything in Pro",
			{
				text: "Trifold countersigns every receipt and seal",
				soon: true,
				plus: true,
			},
			{ text: "Public transparency log", soon: true, plus: true },
			{ text: "Auditor portal", soon: true, plus: true },
			{ text: "Daily matching to Stripe payouts", soon: true, plus: true },
			"Priority support",
			{ text: "Donation receipts use no credits", np: true, plus: true },
			{ text: "Unlimited board and member seats", np: true, plus: true },
		],
	},
];

export const SIDE_PLANS = [
	{
		id: "community",
		name: "Community · self-hosted",
		body: "The tfd engine and its CLI on your own machine: receipts, seals, reconcile, simulate. The source is public on GitHub and free to self-host (FSL-1.1-ALv2).",
		cta: { label: "Install the CLI", href: CLI_URL, external: true },
	},
	{
		id: "platform",
		name: "Platform",
		body: "For school networks, fiscal sponsors, federations and software vendors. Rollups across organizations, SSO, SLA, white-label verify.",
		cta: {
			label: "Talk to us",
			href: "/early-access?role=network",
			external: false,
		},
	},
];

export const ADDONS: {
	name: string;
	price: Record<Org, string>;
	body: string;
	npOnly?: boolean;
}[] = [
	{
		name: "Witnessed + Bookkeeper",
		price: { std: "~$349/mo", np: "~$249/mo" },
		body: "A partner bookkeeper closes your month on witnessed books. Less than most bookkeeping services alone.",
	},
	{
		name: "State program pack",
		price: { std: "$15–30/mo per program", np: "$15–30/mo per program" },
		body: "Itemised receipts for education savings and tax-credit programs, kept current as the rules change.",
	},
	{
		name: "Non-profit pack",
		price: { std: "$15–25/mo", np: "$15–25/mo" },
		npOnly: true,
		body: "Signed donation acknowledgments, restricted funds, grant reports, and a Form 990 package for your CPA.",
	},
	{
		name: "Co-op pack",
		price: { std: "$15–25/mo", np: "$15–25/mo" },
		npOnly: true,
		body: "Member capital accounts, patronage allocation, and 1099-PATR export.",
	},
	{
		name: "Credit top-ups",
		price: { std: "$10 = 1,000 credits", np: "$10 = 1,000 credits" },
		body: "For heavy Rifo use or a busy month of witnessed receipts. Opt-in only.",
	},
	{
		name: "Witness API",
		price: {
			std: "500/mo free, then $0.03–0.05",
			np: "500/mo free, then $0.03–0.05",
		},
		body: "Just the witness, for self-hosters and platforms that issue their own receipts.",
	},
];

export type Cell =
	| boolean
	| string
	| { value: boolean | string; soon: true }
	| { std: Cell; np: Cell };
const SOFT_LIMIT = "Soft limit: books keep running; we'll suggest an upgrade";
const S = (value: boolean | string): Cell => ({ value, soon: true });
const N = (std: Cell, np: Cell): Cell => ({ std, np });

export const COLUMNS: {
	id: string;
	name: string;
	price?: Record<Org, number>;
	self?: boolean;
	custom?: boolean;
}[] = [
	{ id: "community", name: "Community", self: true },
	{ id: "free", name: "Free", price: { std: 0, np: 0 } },
	{ id: "starter", name: "Starter", price: { std: 29, np: 15 } },
	{ id: "pro", name: "Pro", price: { std: 79, np: 39 } },
	{ id: "witnessed", name: "Witnessed", price: { std: 149, np: 79 } },
	{ id: "platform", name: "Platform", custom: true },
];

export const MATRIX: [string, [string, string, Cell[]][]][] = [
	[
		"Limits",
		[
			[
				"Ledger events a month",
				"",
				["Unlimited", "1,000", "5,000", "25,000", "25,000", "Custom"],
			],
			[
				"Roughly how many families",
				"At about 7 events each",
				["Any", "~140", "~700", "~3,500", "~3,500", "Any"],
			],
			[
				"Credits a month",
				"For Rifo and witness signatures",
				["—", "200", "1,000", "5,000", "8,000", "Pooled"],
			],
			[
				"Seats",
				"CPA and auditor seats never count",
				["Yours", "2", "5", "Unlimited", "Unlimited", "Unlimited"],
			],
			[
				"Storage and compute",
				"",
				[
					"Your own",
					"Included",
					"Included",
					"Included",
					"Included",
					"Included",
				],
			],
			[
				"Over the event limit",
				"No metered overage",
				["—", SOFT_LIMIT, SOFT_LIMIT, SOFT_LIMIT, SOFT_LIMIT, "~$1 / 10K"],
			],
		],
	],
	[
		"Books",
		[
			[
				"Billing engine",
				"Credits, plans, bookings, codes, memberships",
				[true, true, true, true, true, true],
			],
			[
				"Books built from Stripe events",
				"Event log and journal",
				[true, true, true, true, true, true],
			],
			["Financial reports", "", [true, true, true, true, true, true]],
			[
				"Hosted, backed-up books",
				"",
				[false, true, true, true, true, "+ data residency"],
			],
			["Scheduled monthly close", "", [false, false, false, true, true, true]],
			[
				"Month-end package for your CPA",
				"",
				["CLI", false, false, true, true, true],
			],
			[
				"Consolidation across organizations",
				"",
				[false, false, false, false, false, true],
			],
		],
	],
	[
		"Receipts and seals",
		[
			[
				"Signed receipt for every payment",
				"",
				[
					"Self-signed",
					"Self-signed",
					"Self-signed",
					"Self-signed",
					S("Countersigned"),
					S("Countersigned"),
				],
			],
			[
				"Sealed months",
				"",
				[
					"Self-signed",
					"Self-signed",
					"Self-signed",
					"Self-signed",
					S("Countersigned"),
					S("Countersigned"),
				],
			],
			["Anyone can verify, free", "", [true, true, true, true, true, true]],
			[
				"Trifold as independent witness",
				"",
				[false, N(false, S("Under $50K")), false, false, S(true), S(true)],
			],
			[
				"Public transparency log",
				"",
				[false, false, false, false, S(true), S(true)],
			],
			[
				"Per-event hash chain",
				"",
				[false, false, false, false, S(true), S(true)],
			],
			["Auditor portal", "", [false, false, false, false, S(true), S(true)]],
			[
				"White-label verify page",
				"",
				[false, false, false, false, false, true],
			],
		],
	],
	[
		"Reconcile",
		[
			["Stripe reconcile on demand", "", [true, true, true, true, true, true]],
			[
				"Daily automatic reconcile with alerts",
				"",
				[false, false, false, true, true, true],
			],
			[
				"Daily matching to Stripe payouts",
				"Recorded in the witnessed books",
				[false, false, false, false, S(true), S(true)],
			],
		],
	],
	[
		"Pricing Lab",
		[
			[
				"Replay the past under new prices",
				"",
				["CLI", true, true, true, true, true],
			],
			[
				"Forecast revenue under new prices",
				"",
				[false, "1 a month", "1 a month", true, true, true],
			],
			[
				"Saved, shareable scenarios",
				"Side by side, for an owner or board",
				[false, false, false, true, true, true],
			],
			[
				"Hosted CI check and staged rollouts",
				"",
				[false, false, false, true, true, true],
			],
			[
				"Network-wide pricing tests",
				"",
				[false, false, false, false, false, true],
			],
		],
	],
	[
		"Rifo AI",
		[
			[
				"Ask Rifo about your books",
				"Uses credits",
				[false, S("Small quota"), S(true), S(true), S(true), S(true)],
			],
			[
				"Rifo closes your month",
				"Uses credits",
				[false, false, false, S(true), S(true), S(true)],
			],
			[
				"Custom agents and API",
				"",
				[false, false, false, false, false, S(true)],
			],
		],
	],
	[
		"Team and access",
		[
			[
				"Ledger web app",
				"",
				["Read-only viewer", true, true, true, true, true],
			],
			[
				"Free CPA and bookkeeper seats",
				"",
				[false, true, true, true, true, true],
			],
			["Roles and approvals", "", [false, false, false, true, true, true]],
			["Google sign-in", "", [false, false, false, true, true, true]],
			["Auditor role", "", [false, false, false, false, S(true), S(true)]],
			[
				"SAML single sign-on and audit log",
				"",
				[false, false, false, false, false, true],
			],
		],
	],
	[
		"Integrations",
		[
			["CSV and hledger export", "", [true, true, true, true, true, true]],
			[
				"QuickBooks or Xero sync",
				"",
				[false, false, S(true), S(true), S(true), S(true)],
			],
			[
				"Witness API",
				"",
				[
					"Metered",
					"Metered",
					"Metered",
					"Metered",
					S("Included"),
					S("Included"),
				],
			],
		],
	],
	[
		"Non-profits and co-ops",
		[
			[
				"Signed donation acknowledgments",
				"Written to IRS acknowledgment rules",
				[
					false,
					N(false, S("Under $50K")),
					S("Pack"),
					S("Pack"),
					N(S("Pack"), S("Included, 0 credits")),
					S(true),
				],
			],
			[
				"Restricted funds and grant reports",
				"",
				[false, false, S("Pack"), S("Pack"), S("Pack"), S(true)],
			],
			[
				"Form 990 package for your CPA",
				"",
				[false, false, false, S("Pack"), S("Pack"), S(true)],
			],
			[
				"Member capital accounts and patronage",
				"",
				[
					false,
					false,
					S("Co-op pack"),
					S("Co-op pack"),
					S("Co-op pack"),
					S(true),
				],
			],
			[
				"1099-PATR export",
				"",
				[
					false,
					false,
					S("Co-op pack"),
					S("Co-op pack"),
					S("Co-op pack"),
					S(true),
				],
			],
			[
				'Public "open books" page',
				"",
				[false, false, false, S(true), S(true), S(true)],
			],
			[
				"Unlimited board and member viewer seats",
				"",
				[false, false, false, N(false, true), true, true],
			],
		],
	],
	[
		"Support",
		[
			["Community forum and GitHub", "", [true, true, true, true, true, true]],
			["Email support", "", [false, false, true, true, true, true]],
			["Priority support", "", [false, false, false, false, true, true]],
			["Uptime SLA", "", [false, false, false, false, false, true]],
		],
	],
	[
		"Never paywalled",
		[
			["Verify receipts and seals", "", [true, true, true, true, true, true]],
			["Export all your data", "", [true, true, true, true, true, true]],
			["Erasure and privacy tools", "", [true, true, true, true, true, true]],
			["Security fixes", "", [true, true, true, true, true, true]],
		],
	],
];

export const CREDITS: [string, string, string][] = [
	["Ask Rifo a question", "2–10", "Passes on the AI cost"],
	[
		"Rifo closes your month",
		"500–1,500",
		"Categorize, reconcile, write the summary",
	],
	["Pricing Lab forecast", "25", "Replays a year of events under new prices"],
	["Witnessed receipt", "3", "Kept cheap on purpose: one per payment"],
	["Witnessed month seal", "25", "Once a month"],
	[
		"Donation acknowledgment (verified non-profits)",
		"0",
		"Every donor's receipt carries a verify link",
	],
	[
		"Self-signed receipt or seal, verifying, CLI simulate",
		"0, always",
		"Free for everyone",
	],
];

export const PROMISE =
	"No per-seat fees. No per-transaction fees. No surprise bills.";

export const NEVER: [string, string][] = [
	[
		"Verify anything",
		"Families, CPAs and auditors check receipts and seals for free.",
	],
	["Export everything", "Your books are yours, in open formats."],
	["Erasure & privacy", "Delete personal data without breaking your books."],
	["Security fixes", "For every plan and every self-hosted install."],
	["Open formats", "The receipt and seal formats are open to anyone."],
];

export const PRICING_FAQ = [
	{
		q: "Are these prices final?",
		a: "No. They are planned prices, published so you can see where we're headed, and they may change before launch. Design partners pay nothing during the pilot.",
	},
	{
		q: "What's a ledger event?",
		a: "One thing that happened to your money: a payment, a refund, a credit used, a booking. A typical family or member makes about 7 a month, so Free's 1,000 events covers about 140 families. Most organizations upgrade for features, not limits.",
	},
	{
		q: "What happens if I go over my limit?",
		a: "Nothing stops and nothing is billed. Event limits are soft on Free, Starter, Pro and Witnessed: your books keep running, and if you stay over for a while we'll suggest a plan that fits. There is no metered overage. Only Platform pays per event, about $1 per 10,000.",
	},
	{
		q: "Can I get a refund?",
		a: "Yes. A full refund within 30 days of your first paid charge.",
	},
	{
		q: "How do I cancel?",
		a: "Two clicks in settings. No retention call, no email chain.",
	},
	{
		q: "Can I change plans?",
		a: "Any time. Upgrades are prorated to the day; downgrades credit your next invoice.",
	},
	{
		q: "Is onboarding extra?",
		a: "No. Onboarding is included on every paid plan, with no setup fee.",
	},
	{
		q: "What happens to my data if I cancel?",
		a: "Export everything in open formats, before and after cancelling. Export is never behind a paywall.",
	},
	{
		q: "Who qualifies for non-profit & co-op pricing?",
		a: "US 501(c) organizations (we check your IRS determination letter or EIN), and cooperatives (we check your articles or bylaws). The plan for non-profits with gross receipts of $50,000 or less is Witnessed free on the Free plan, with up to about 200 witnessed receipts a month, once the witness ships.",
	},
	{
		q: "Do the annual and non-profit discounts stack?",
		a: "Yes. Annual billing is ten months' price for twelve months, applied to whichever price you qualify for.",
	},
	{
		q: 'What will "Witnessed" mean? Is it an audit?',
		a: "It isn't an audit. Once it ships, Trifold will countersign each receipt and monthly seal and log it publicly, which proves Trifold saw that exact record at that time and that nobody changed it afterwards. It doesn't prove the money moved or that the books are complete. That makes your auditor's job faster, not unnecessary.",
	},
	{
		q: "I'm an accountant. What do I pay?",
		a: "Nothing for your own seats: a firm's seats are free on every client's books. Planned: clients a firm brings get 20% off their first year. Trifold pays no referral fees to tax preparers.",
	},
	{
		q: "Can I run it myself?",
		a: "The engine's source and its CLI are public on GitHub, including receipts, seals, reconcile and simulate. The license is the Functional Source License: free to use and change for your own books, but not to sell as a competing service. Every release becomes Apache-2.0 two years after it ships. The verifier and receipt format are Apache-2.0.",
	},
	{
		q: "Does Trifold file my taxes?",
		a: "No. Trifold keeps books that show their work and prepares the records your CPA or enrolled agent needs. Partner bookkeepers can close the month for you.",
	},
];
