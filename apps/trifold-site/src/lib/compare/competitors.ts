/**
 * One-on-one comparisons. Adding an entry to COMPETITORS is all it takes: /compare, /compare/trifold-vs-<slug>, the
 * footer's Compare column, sitemap.xml and llms.txt all derive from this array. Only the /compare pages ship it to
 * the browser; the footer gets just the names (links.ts).
 *
 * Rules: every claim about a competitor comes from a page listed in its `sources`, checked on `checked`; quote their
 * own words for taglines, and leave `tagline` out when we haven't captured it; list prices first, promos after;
 * "Not stated" means their public pages don't say, not that they lack it. Never say a competitor's records can't be
 * audited: their audit trail is for account users, a Trifold receipt can be checked by anyone. Trifold's own prices
 * come from the pricing data module, so a price change can't leave a comparison behind.
 */
import { ANNUAL_MONTHS_CHARGED, PLANS } from "#lib/pricing/data";

/** A summary-matrix cell: true renders ✓, false renders ✗, a string renders as text. */
export type Mark = boolean | string;

export type Summary = {
	priceFrom: string;
	freeTier: Mark;
	perSeat: Mark;
	aiPostsOnItsOwn: Mark;
	verifiableWithoutAccount: Mark;
	openExport: Mark;
	selfHost: Mark;
	stripe: Mark;
};

export type Competitor = {
	slug: string;
	name: string;
	/** Their own words, quoted. Left out when we haven't captured them from their own page. */
	tagline?: string;
	/** "Trifold vs <them>: ..." meta description. */
	oneLine: string;
	/** Fair: what both do, where each is strongest. */
	intro: string;
	theyAreStrongest: { title: string; body: string }[];
	trifoldDiffers: { title: string; body: string; status: "shipped" | "next" }[];
	facts: { label: string; trifold: string; them: string }[];
	summary: Summary;
	chooseThem: string;
	chooseTrifold: string;
	sources: { label: string; url: string }[];
	/** When there's no vendor page to cite (a spreadsheet), what the facts rest on instead. */
	basis?: string;
	/** ISO date the sources were last checked. */
	checked: string;
};

export const SUMMARY_COLUMNS: { key: keyof Summary; label: string }[] = [
	{ key: "priceFrom", label: "Paid plans from" },
	{ key: "freeTier", label: "Free plan" },
	{ key: "perSeat", label: "Per-seat fees" },
	{ key: "aiPostsOnItsOwn", label: "AI posts on its own" },
	{
		key: "verifiableWithoutAccount",
		label: "Receipts checkable without an account",
	},
	{ key: "openExport", label: "Open export" },
	{ key: "selfHost", label: "Self-host" },
	{ key: "stripe", label: "Stripe" },
];

const paid = PLANS.filter((plan) => plan.price.std > 0);
const dollars = (amount: number) => `$${amount}`;

/** Trifold's planned prices, from the pricing data module. */
export const TRIFOLD_PRICES = {
	list: `Free, then ${paid.map((plan) => `${plan.name} ${dollars(plan.price.std)}`).join(", ")} a month`,
	nonProfit: paid.map((plan) => dollars(plan.price.np)).join(" / "),
	from: `${dollars(paid[0]?.price.std ?? 0)}/mo`,
	annual: `Pay ${ANNUAL_MONTHS_CHARGED} months for 12`,
};

export const TRIFOLD_SUMMARY: Summary = {
	priceFrom: `${TRIFOLD_PRICES.from} (planned)`,
	freeTier: "Planned",
	perSeat: "None",
	aiPostsOnItsOwn: "No: Rifo drafts, you approve (Next)",
	verifiableWithoutAccount: true,
	openExport: "Parquet, hledger, CSV",
	selfHost: "The engine",
	stripe: "Native: books built from Stripe events",
};

/** Trifold's side of the facts tables, said the same way on every comparison. */
const TRIFOLD = {
	builtFor:
		"Schools, studios, non-profits and other organizations paid through Stripe",
	usPrices: "United States; prices in USD",
	price: `${TRIFOLD_PRICES.list}, planned. Non-profit and co-op: ${TRIFOLD_PRICES.nonProfit}`,
	free: "Planned. The hosted service is early access; design partners are free during the pilot",
	seats: "No per-seat fees; CPA and bookkeeper seats free (planned)",
	verify: "Anyone, in a free browser verifier or the CLI, with no account",
	ai: "Rifo, Next (not shipped): drafts and explains, you approve, the engine does the math",
	export: "Parquet, hledger and CSV, on every plan",
	selfHost: "The engine is self-hostable",
	stripe:
		"Native: books built from Stripe events, Stripe's webhook signature checked",
	payroll: "None. A year-end package for your CPA is Later",
	bank: "None today; bank-statement import (CSV/OFX) is planned",
	soc2: "Target date to be announced",
};

const VERIFY = {
	title: "Anyone can check a receipt, with no account",
	body: "A family, CPA or auditor pastes a receipt into the free verifier at /verify. It runs in their browser and sends nothing to us; the CLI does the same check offline.",
	status: "shipped",
} as const;
const OPEN = {
	title: "Open formats and an engine you can run yourself",
	body: "Export the books to Parquet, hledger or CSV whenever you like. The receipt and seal formats are open, and the engine is self-hostable, with its source public on GitHub.",
	status: "shipped",
} as const;
const REPLAY = {
	title: "Books you can rebuild, months that stay sealed",
	body: "Every Stripe event is kept. Replay them and you get the same balances and journals, and a sealed month shows any later change.",
	status: "shipped",
} as const;
const RIFO = {
	title: "Rifo drafts. You approve. The engine does the math.",
	body: "Rifo will read your books, explain them and propose the month's close, citing the events behind every answer. It never computes a number and never posts on its own.",
	status: "next",
} as const;
/** The fair version: their audit trail is for people inside the account; a Trifold receipt is for anyone. */
const verifyVersus = (owner: string) => ({
	...VERIFY,
	body: `${owner} audit trail is for people with access to the account. A Trifold receipt can be checked by anyone, free, in the browser verifier or the CLI, with no account and nothing sent to us.`,
});

export const compareHref = (slug: string) => `/compare/trifold-vs-${slug}`;

export const COMPETITORS: Competitor[] = [
	{
		slug: "airtight",
		name: "Airtight",
		tagline: "Triple-entry accounting for Australian businesses.",
		oneLine:
			"Trifold vs Airtight: both sign receipts. Airtight is a full ledger for Australian and Gulf businesses and their accountants; Trifold builds checkable books from Stripe payments for US schools, studios and non-profits.",
		intro:
			"Trifold and Airtight both put a signed receipt behind the books, so a later change shows. Airtight is a full accounting ledger for Australian and Gulf businesses and the firms that keep their books, with payroll, multi-entity books and local e-invoicing. Trifold is narrower: books built from Stripe payments for US schools, studios and non-profits, with receipts anyone can check in a free browser verifier.",
		theyAreStrongest: [
			{
				title: "Local compliance in Australia and the Gulf",
				body: "Australian payroll with STP records on Plus and up, GCC e-invoice preparation, and an Arabic interface. Trifold has none of this.",
			},
			{
				title: "A whole ledger, for many entities and the firms behind them",
				body: "From one entity to ten and more, with consolidation, bank connections through open banking, and plans built for firms managing 10 to 2,000 client books. Auditor seats are $0, read-only and unlimited.",
			},
			{
				title: "Signed receipts in a product you can buy today",
				body: "Every posted entry gets an Ed25519-signed receipt in a SHA-256 hash chain, on paid plans with a 30-day refund and two-click cancel. Trifold's receipts ship in the source-available engine today, but the hosted service is still early access.",
			},
		],
		trifoldDiffers: [VERIFY, OPEN, RIFO],
		facts: [
			{
				label: "Where",
				trifold: "United States; prices in USD",
				them: "Australia and New Zealand, and the Gulf region; data hosted on AWS in Sydney",
			},
			{
				label: "Built for",
				trifold:
					"Schools, studios, non-profits and other organizations paid through Stripe",
				them: "Sole traders, SMEs of 1–200 staff, multi-entity groups, and accounting firms",
			},
			{
				label: "Monthly price",
				trifold: `${TRIFOLD_PRICES.list}, planned. Non-profit and co-op: ${TRIFOLD_PRICES.nonProfit}`,
				them: "A$49 / A$99 / A$199 / A$499+ (about US$32 / $65 / $130 for the first three)",
			},
			{
				label: "Free plan",
				trifold:
					"Planned. The hosted service is early access; design partners are free during the pilot",
				them: "None; plans start at A$49 a month",
			},
			{
				label: "Annual billing",
				trifold: `${TRIFOLD_PRICES.annual} (about 17% off), planned`,
				them: "Saves 17%",
			},
			{
				label: "Seats",
				trifold: "No per-seat fees; CPA and bookkeeper seats free (planned)",
				them: "No per-seat multiplier; auditor seats $0, read-only and unlimited",
			},
			{
				label: "Refunds and cancelling",
				trifold: "Planned: full refund within 30 days, cancel in two clicks",
				them: "Full refund within 30 days of a first paid subscription; cancel in two clicks",
			},
			{
				label: "The books",
				trifold:
					"Balanced double-entry books built from Stripe events; corrections are new events, never edits",
				them: 'What Airtight calls a "triple-entry ledger": debit, credit and a receipt on every posted entry',
			},
			{
				label: "Receipts",
				trifold:
					"An Ed25519-signed receipt for every Stripe payment and refund",
				them: "An Ed25519-signed receipt for every posted entry, linked in a SHA-256 hash chain",
			},
			{
				label: "Who can check a receipt",
				trifold:
					"Anyone, in a free browser verifier or the CLI, with no account",
				them: "Shown as verified in the product; how someone outside it checks is not stated",
			},
			{
				label: "Month end",
				trifold: "Sealed months, chained month to month",
				them: "Not stated",
			},
			{
				label: "AI",
				trifold:
					"Rifo, Next (not shipped): drafts and explains, you approve, the engine does the math",
				them: "Bella drafts entries, invoices and returns for approval; modes Auto, Guarded and Off (not explained on the page)",
			},
			{
				label: "Export",
				trifold: "Parquet, hledger and CSV, on every plan",
				them: "Data stays exportable while the account is active; formats not stated",
			},
			{
				label: "Self-hosting",
				trifold: "The engine is self-hostable",
				them: "Not stated",
			},
			{
				label: "Stripe",
				trifold:
					"Native: books built from Stripe events, Stripe's webhook signature checked",
				them: "Stripe payment links in invoicing",
			},
			{
				label: "Payroll and tax",
				trifold: "None. A year-end package for your CPA is Later",
				them: "Australian payroll (STP records) on Plus and up; GCC e-invoice preparation",
			},
			{
				label: "Entities",
				trifold:
					"Up to 3 organizations on Pro; consolidation on Platform (planned)",
				them: "1, 3 or 10 entities by plan, 10+ on Enterprise, with consolidation",
			},
			{
				label: "SOC 2",
				trifold: "Target date to be announced",
				them: "Type II, working toward Q4 2026",
			},
		],
		summary: {
			priceFrom: "A$49/mo (about US$32)",
			freeTier: false,
			perSeat: "None; auditor seats $0",
			aiPostsOnItsOwn: "Not stated (has an Auto mode)",
			verifiableWithoutAccount: "Not stated",
			openExport: "Formats not stated",
			selfHost: "Not stated",
			stripe: "Payment links in invoicing",
		},
		chooseThem:
			"You're an Australian, New Zealand or Gulf business or accounting firm that needs local payroll, e-invoicing and multi-entity books today, in a product that's on sale now.",
		chooseTrifold:
			"You're a US school, studio or non-profit paid through Stripe, and you want receipts families can check without an account, open exports, and the option to run the engine yourself.",
		sources: [
			{ label: "Airtight pricing", url: "https://airtight.one/pricing/" },
			{
				label: "Airtight homepage",
				url: "https://airtight-marketing.pages.dev/",
			},
		],
		checked: "2026-11-06",
	},
	{
		slug: "quickbooks",
		name: "QuickBooks Online",
		oneLine:
			"Trifold vs QuickBooks Online: QuickBooks is a full small-business accounting suite with payroll, bank feeds and a huge accountant base; Trifold builds checkable books from Stripe payments for US schools, studios and non-profits.",
		intro:
			"QuickBooks Online and Trifold both keep books an accountant can work from. QuickBooks is the broad one: Intuit's small-business accounting suite, with payroll, bank feeds, sales tax and the largest accountant network there is. Trifold does one narrow job: it turns Stripe payments into balanced books and a signed receipt for every payment, which anyone can check in a free browser verifier.",
		theyAreStrongest: [
			{
				title: "The biggest ecosystem in small-business accounting",
				body: "Payroll, bank feeds, invoicing, sales tax and 1099s in one product, with mobile apps and an app marketplace. Trifold has no payroll, no bank feeds and no invoicing.",
			},
			{
				title: "Your accountant probably already uses it",
				body: "A huge ProAdvisor and accountant base, and accountant access on every plan: up to 2 accountants, 3 on Advanced.",
			},
			{
				title: "AI across the whole product",
				body: "Intuit Assist and AI features by tier, from expense categorisation and cleanup to sales tax and anomaly detection.",
			},
		],
		trifoldDiffers: [
			verifyVersus("QuickBooks'"),
			{
				title: "No per-seat fees, and records you can take with you",
				body: "Trifold's planned plans charge no per-seat fees, and CPA seats never count. The books export to Parquet, hledger and CSV, and the engine is self-hostable.",
				status: "shipped",
			},
			RIFO,
		],
		facts: [
			{
				label: "Built for",
				trifold: TRIFOLD.builtFor,
				them: "Small businesses broadly, plus accountants and mid-market companies",
			},
			{
				label: "Monthly price",
				trifold: TRIFOLD.price,
				them: "Simple Start $38, Essentials $85, Plus $140, Advanced $340 a month list (intro offer: 50% off for 3 months)",
			},
			{ label: "Free plan", trifold: TRIFOLD.free, them: "Not stated" },
			{
				label: "Seats",
				trifold: TRIFOLD.seats,
				them: "1, 3, 5 or 25 users by plan; up to 2 accountants (3 on Advanced); extra-user fees not stated",
			},
			{
				label: "Who can check the records",
				trifold: TRIFOLD.verify,
				them: "People with access to the account, through its audit log; a public verifier is not stated",
			},
			{
				label: "AI",
				trifold: TRIFOLD.ai,
				them: "Intuit Assist and AI features by tier (chat in beta, categorisation, cleanup, sales tax, anomaly detection); whether its agents post on their own is not stated",
			},
			{ label: "Export", trifold: TRIFOLD.export, them: "Not stated" },
			{
				label: "Self-hosting",
				trifold: TRIFOLD.selfHost,
				them: "No; hosted only",
			},
			{
				label: "Stripe",
				trifold: TRIFOLD.stripe,
				them: "Through third-party apps; native support not stated",
			},
			{
				label: "Payroll and tax",
				trifold: TRIFOLD.payroll,
				them: "Payroll, sales tax and 1099s; payroll price not stated",
			},
			{ label: "SOC 2", trifold: TRIFOLD.soc2, them: "Not stated" },
		],
		summary: {
			priceFrom: "$38/mo list (50% off for 3 months)",
			freeTier: "Not stated",
			perSeat: "User caps by plan",
			aiPostsOnItsOwn: "Not stated",
			verifiableWithoutAccount: "Not stated",
			openExport: "Not stated",
			selfHost: false,
			stripe: "Via third-party apps",
		},
		chooseThem:
			"You need payroll, 1099s, sales tax and bank feeds in one place, or your accountant already works in QuickBooks.",
		chooseTrifold:
			"Families or members pay you through Stripe, and you want a signed receipt for every payment that anyone can check, no per-seat fees, and books you can leave with in open files.",
		sources: [
			{
				label: "QuickBooks pricing",
				url: "https://quickbooks.intuit.com/pricing/",
			},
		],
		checked: "2026-11-06",
	},
	{
		slug: "xero",
		name: "Xero",
		oneLine:
			"Trifold vs Xero: Xero is mature small-business accounting with bank feeds, invoicing and a large accountant network; Trifold builds checkable books from Stripe payments for US schools, studios and non-profits.",
		intro:
			"Xero and Trifold both keep the books from the money that comes in. Xero is a mature accounting product for small businesses and their accountants: bank feeds, invoicing, multi-currency, a payroll add-on and a large app marketplace. Trifold takes Stripe payments in as events, posts them as balanced books, and signs a receipt for each one that anyone can check for free.",
		theyAreStrongest: [
			{
				title: "Bank feeds, invoicing and multi-currency",
				body: "A mature product for invoicing and bank reconciliation, with multi-currency, projects and expense claims on Established. Trifold has no bank feeds, invoicing or multi-currency.",
			},
			{
				title: "An accountant network and a big app marketplace",
				body: "Xero's Partner Program connects you with advisors who already work in it. Its marketplace includes a Stripe app with card payments on invoices, a Stripe bank feed and one-click reconcile.",
			},
			{
				title: "No per-user licence fees, and payroll when you need it",
				body: "Plans charge no per-user licence fees, and a payroll add-on is $36 a month plus $6 per employee or contractor.",
			},
		],
		trifoldDiffers: [
			verifyVersus("Xero's"),
			{
				title: "Stripe payments as events, not bank lines",
				body: "Each Stripe payment and refund arrives as an event, Stripe's webhook signature checked, and posts as balanced double-entry books that replay to the same balances.",
				status: "shipped",
			},
			OPEN,
		],
		facts: [
			{
				label: "Built for",
				trifold: TRIFOLD.builtFor,
				them: "Small businesses and their accountants and bookkeepers",
			},
			{
				label: "Monthly price",
				trifold: TRIFOLD.price,
				them: "Early $27, Growing $59, Established $97 a month list, US (intro offer: 80% off for 3 months)",
			},
			{
				label: "Plan limits",
				trifold: "Soft event limits by plan; the books keep running",
				them: "Early: 20 invoices and 5 bills; auto-reconcile is a $5 add-on on Early",
			},
			{
				label: "Free plan",
				trifold: TRIFOLD.free,
				them: "None listed; no standard free trial described",
			},
			{
				label: "Seats",
				trifold: TRIFOLD.seats,
				them: "No per-user licence fees; accountant access by plan not stated",
			},
			{
				label: "Who can check the records",
				trifold: TRIFOLD.verify,
				them: "People with access to the account; a public verifier is not stated",
			},
			{
				label: "AI",
				trifold: TRIFOLD.ai,
				them: "JAX answers questions and handles admin like invoices and quotes; it only acts when you open it and ask",
			},
			{ label: "Export", trifold: TRIFOLD.export, them: "Not stated" },
			{
				label: "Self-hosting",
				trifold: TRIFOLD.selfHost,
				them: "No; hosted only",
			},
			{
				label: "Stripe",
				trifold: TRIFOLD.stripe,
				them: "Stripe app: card payments on invoices, a Stripe bank feed and one-click reconcile; 2.9% + 30¢ per domestic card payment",
			},
			{
				label: "Payroll",
				trifold: TRIFOLD.payroll,
				them: "Add-on: $36 a month plus $6 per employee or contractor",
			},
			{ label: "SOC 2", trifold: TRIFOLD.soc2, them: "Not stated" },
		],
		summary: {
			priceFrom: "$27/mo list (80% off for 3 months)",
			freeTier: false,
			perSeat: "None",
			aiPostsOnItsOwn: "No: acts when you ask",
			verifiableWithoutAccount: "Not stated",
			openExport: "Not stated",
			selfHost: false,
			stripe: "Stripe app: bank feed, invoice payments",
		},
		chooseThem:
			"You want mature invoicing, bank feeds and multi-currency, or your accountant works in Xero.",
		chooseTrifold:
			"Stripe is your main money flow, and you want books built straight from Stripe events, a signed receipt for every payment, and open data.",
		sources: [
			{
				label: "Xero US pricing",
				url: "https://www.xero.com/us/pricing-plans/",
			},
			{ label: "Xero JAX", url: "https://www.xero.com/jax" },
			{
				label: "Xero's Stripe app",
				url: "https://apps.xero.com/us/app/stripe",
			},
		],
		checked: "2026-11-06",
	},
	{
		slug: "digits",
		name: "Digits",
		tagline: "Accounting software—that works for you.",
		oneLine:
			"Trifold vs Digits: Digits is an AI-native general ledger with broad bank, card and payroll connections and SOC 2 Type II; Trifold builds checkable books from Stripe payments for US schools, studios and non-profits.",
		intro:
			"Digits and Trifold both build books from the systems money already moves through. Digits calls itself the first AI-native general ledger for business owners and accountants: AI bookkeeping, reconciliation and close across connections to more than 12,000 banks, cards and payroll providers. Trifold is narrower: Stripe payments become balanced books by fixed rules, with a signed receipt for each payment that anyone can check.",
		theyAreStrongest: [
			{
				title: "SOC 2 Type II today",
				body: "Digits states it is SOC 2 Type II compliant. Trifold has no SOC 2 report yet; its target date is still to be announced.",
			},
			{
				title: "Connected to almost everything",
				body: "Bank, card and payroll connections to more than 12,000 providers, with Stripe, Ramp, Gusto and BILL as import sources, plus a developer API and MCP.",
			},
			{
				title: "A full AI close, with people if you want them",
				body: "AI bookkeeping and reconciliation around the clock, AI bill pay and invoicing, an agentic close, and a managed accounting option with a human in the loop.",
			},
		],
		trifoldDiffers: [VERIFY, OPEN, RIFO],
		facts: [
			{
				label: "Built for",
				trifold: TRIFOLD.builtFor,
				them: "Business owners and accountants: startups and small businesses, with firm plans billed per client",
			},
			{
				label: "Monthly price",
				trifold: TRIFOLD.price,
				them: "Essentials $65, Core $100 a month; Pro $250 is coming soon",
			},
			{ label: "Free plan", trifold: TRIFOLD.free, them: "None listed" },
			{ label: "Seats", trifold: TRIFOLD.seats, them: "Not stated" },
			{
				label: "Who can check the records",
				trifold: TRIFOLD.verify,
				them: "Not stated",
			},
			{
				label: "AI",
				trifold: TRIFOLD.ai,
				them: "AI bookkeeping and reconciliation, Ask Digits, AI Quality Review and an agentic close; whether entries post without review is not stated",
			},
			{
				label: "Export",
				trifold: TRIFOLD.export,
				them: "Not stated; a developer API and MCP are offered",
			},
			{
				label: "Self-hosting",
				trifold: TRIFOLD.selfHost,
				them: "No; hosted only",
			},
			{
				label: "Stripe",
				trifold: TRIFOLD.stripe,
				them: "An import source, alongside Ramp, Gusto, BILL and CSV",
			},
			{
				label: "Bank and card connections",
				trifold: TRIFOLD.bank,
				them: "12,000+ bank, card and payroll providers",
			},
			{ label: "SOC 2", trifold: TRIFOLD.soc2, them: "Type II, stated" },
		],
		summary: {
			priceFrom: "$65/mo",
			freeTier: false,
			perSeat: "Not stated",
			aiPostsOnItsOwn: "Not stated",
			verifiableWithoutAccount: "Not stated",
			openExport: "Not stated (API, MCP)",
			selfHost: false,
			stripe: "Import source",
		},
		chooseThem:
			"You want an AI-first ledger connected to your banks, cards and payroll, with SOC 2 Type II now, and hosted-only is fine.",
		chooseTrifold:
			"Most of your money comes through Stripe, and you'd rather have numbers from fixed rules, receipts anyone can check, open formats and a lower planned price.",
		sources: [
			{ label: "Digits homepage", url: "https://digits.com" },
			{ label: "Digits pricing", url: "https://digits.com/pricing" },
			{ label: "Digits security", url: "https://digits.com/security" },
		],
		checked: "2026-11-06",
	},
	{
		slug: "puzzle",
		name: "Puzzle",
		tagline: "Accurate books. At AI speed.",
		oneLine:
			"Trifold vs Puzzle: Puzzle is AI-native accounting for startups, with accountants on hand if you want them; Trifold builds checkable books from Stripe payments for US schools, studios and non-profits.",
		intro:
			"Puzzle and Trifold both connect straight to Stripe and keep AI on a short leash: in Puzzle, nothing changes in your books until you approve it. Puzzle is AI-native accounting for startups and small businesses, with expert-reviewed and full-service tiers staffed by accountants. Trifold is built for schools, studios and non-profits: Stripe payments become balanced books and a signed receipt anyone can check.",
		theyAreStrongest: [
			{
				title: "Accountants on hand",
				body: "Expert-reviewed and full-service tiers add human accountants to the software; Core + Expert Reviewed is $171 a month for up to $10K in monthly expenses. Trifold has no bookkeeping service.",
			},
			{
				title: "Built around a startup's stack",
				body: "Direct integrations with Stripe (synced daily), Ramp, Mercury, Brex and Gusto, and board-ready statements.",
			},
			{
				title: "AI that asks first",
				body: "Puzzle's AI Suite (Chat, Cowork, Close) proposes and waits: “Nothing changes in your books until you approve it.” Rifo, once it ships, works the same way, so this isn't a difference.",
			},
		],
		trifoldDiffers: [VERIFY, OPEN, REPLAY],
		facts: [
			{
				label: "Built for",
				trifold: TRIFOLD.builtFor,
				them: "Startups, small businesses and the accounting firms that serve them",
			},
			{
				label: "Monthly price",
				trifold: TRIFOLD.price,
				them: "Software: Starter $30, Core $72, Complete $120, Scale $360 a month",
			},
			{
				label: "Free plan",
				trifold: TRIFOLD.free,
				them: "None described; terms of “Try for free” not stated",
			},
			{ label: "Seats", trifold: TRIFOLD.seats, them: "Not stated" },
			{
				label: "Who can check the records",
				trifold: TRIFOLD.verify,
				them: "Not stated",
			},
			{
				label: "AI",
				trifold: TRIFOLD.ai,
				them: "AI Suite proposes; nothing changes until you approve. AI credits: 25 lifetime on Starter and Core, 100 or 300 a month on Complete and Scale",
			},
			{
				label: "Export",
				trifold: TRIFOLD.export,
				them: "Not stated; integrations are read-only",
			},
			{
				label: "Self-hosting",
				trifold: TRIFOLD.selfHost,
				them: "No; hosted in the US",
			},
			{
				label: "Stripe",
				trifold: TRIFOLD.stripe,
				them: "Direct integration, synced daily",
			},
			{
				label: "Bookkeeping service",
				trifold: "None; Trifold is software",
				them: "Expert-reviewed and full-service tiers",
			},
			{
				label: "SOC 2",
				trifold: TRIFOLD.soc2,
				them: "Not stated (AES-256 encryption and a bug bounty are)",
			},
		],
		summary: {
			priceFrom: "$30/mo",
			freeTier: "Not stated",
			perSeat: "Not stated",
			aiPostsOnItsOwn: "No: you approve first",
			verifiableWithoutAccount: "Not stated",
			openExport: "Not stated",
			selfHost: false,
			stripe: "Direct, synced daily",
		},
		chooseThem:
			"You're a venture-style startup that wants AI-native books, with accountants available when you need them.",
		chooseTrifold:
			"You're a school, studio or non-profit with Stripe revenue, and you want a low planned price, receipts anyone can check, and open records.",
		sources: [
			{ label: "Puzzle homepage", url: "https://puzzle.io" },
			{ label: "Puzzle pricing", url: "https://puzzle.io/pricing" },
			{ label: "Puzzle security", url: "https://puzzle.io/security" },
		],
		checked: "2026-11-06",
	},
	{
		slug: "pilot",
		name: "Pilot",
		tagline: "If you're buried in bookkeeping, who's leading the company?",
		oneLine:
			"Trifold vs Pilot: Pilot is a done-for-you bookkeeping, tax and CFO service; Trifold is software that builds checkable books from Stripe payments for US schools, studios and non-profits.",
		intro:
			"Pilot and Trifold both take work off whoever keeps your books, in different ways. Pilot is a service, “50/50 people and software”: a bookkeeping team, with tax filing and CFO services on top. Trifold is software: it turns Stripe payments into balanced books and a signed receipt for every payment, which anyone can check.",
		theyAreStrongest: [
			{
				title: "People who do the books for you",
				body: "A bookkeeping team keeps your books; Bookkeeping Essentials is $99 a month for up to $100K in monthly expenses. Trifold is software: someone on your side still runs it.",
			},
			{
				title: "Tax filing and a CFO",
				body: "Business tax filing from $1,000 a year (bought with bookkeeping) and CFO services from $1,750 a month. Trifold doesn't file taxes; a year-end package for your CPA is Later.",
			},
			{
				title: "Operations beyond the books",
				body: "R&D credits, payroll and bill pay operations, and stock administration.",
			},
		],
		trifoldDiffers: [VERIFY, OPEN, REPLAY],
		facts: [
			{
				label: "Built for",
				trifold: TRIFOLD.builtFor,
				them: "Startups, small and growing businesses, and professional-services firms",
			},
			{
				label: "What it is",
				trifold:
					"Software: a hosted service (early access) or the self-hosted engine",
				them: "A service: “50/50 people and software”",
			},
			{
				label: "Monthly price",
				trifold: TRIFOLD.price,
				them: "Bookkeeping Essentials $99 a month (up to $100K monthly expenses); custom plans through sales",
			},
			{
				label: "Tax",
				trifold: "Doesn't file taxes; a year-end package for your CPA is Later",
				them: "From $1,000+ a year (single-member LLC) to $2,450+ (C-corps), bought with bookkeeping",
			},
			{
				label: "CFO",
				trifold: "None",
				them: "$1,750, $3,150 or $5,250 a month",
			},
			{ label: "Free plan", trifold: TRIFOLD.free, them: "None" },
			{
				label: "Who can check the records",
				trifold: TRIFOLD.verify,
				them: "Not stated",
			},
			{
				label: "AI",
				trifold: TRIFOLD.ai,
				them: "AI categorisation, reconciliation, close and Q&A; how work splits between AI and people is not stated",
			},
			{ label: "Export", trifold: TRIFOLD.export, them: "Not stated" },
			{
				label: "Self-hosting",
				trifold: TRIFOLD.selfHost,
				them: "No; a service",
			},
			{ label: "Stripe", trifold: TRIFOLD.stripe, them: "Not stated" },
			{ label: "SOC 2", trifold: TRIFOLD.soc2, them: "Not stated" },
		],
		summary: {
			priceFrom: "$99/mo (a service)",
			freeTier: false,
			perSeat: "n/a (a service)",
			aiPostsOnItsOwn: "Not stated",
			verifiableWithoutAccount: "Not stated",
			openExport: "Not stated",
			selfHost: false,
			stripe: "Not stated",
		},
		chooseThem:
			"You want people to do your bookkeeping and file your taxes, and $99 a month and up (taxes extra) fits the budget.",
		chooseTrifold:
			"A volunteer treasurer or an admin keeps the books, and you want trustworthy automation from Stripe and receipts anyone can check.",
		sources: [
			{ label: "Pilot homepage", url: "https://pilot.com" },
			{ label: "Pilot pricing", url: "https://pilot.com/pricing" },
		],
		checked: "2026-11-06",
	},
	{
		slug: "wave",
		name: "Wave",
		tagline: "Clear books. Confident decisions.",
		oneLine:
			"Trifold vs Wave: Wave is free invoicing and bookkeeping for freelancers and solo operators; Trifold builds checkable books from Stripe payments for US schools, studios and non-profits.",
		intro:
			"Wave and Trifold both want small organizations to start without a bill: Wave's Starter plan is free today, and Trifold's free plan is planned. Wave is invoicing and bookkeeping for freelancers, solopreneurs and contractors, with its own payment processing, a payroll add-on and paid advisors. Trifold is for organizations paid through Stripe: payments become balanced books and a signed receipt for each payment that anyone can check.",
		theyAreStrongest: [
			{
				title: "Free today",
				body: "The Starter plan is free: unlimited estimates, invoices, bills and bookkeeping records. Trifold's free plan is planned; the hosted service is early access.",
			},
			{
				title: "Simple, with help when you need it",
				body: "Pro is $19 a month and adds bank import through Plaid. Add payroll ($25–40 a month), receipt scanning ($8–11 a month) or a paid Wave Advisor.",
			},
			{
				title: "Accountant roles on the free plan",
				body: "Starter includes free tax-pro and payroll roles; Pro adds admin, editor and viewer roles.",
			},
		],
		trifoldDiffers: [
			VERIFY,
			{
				title: "Books built from Stripe events",
				body: "Every Stripe payment and refund arrives as an event and posts as balanced double-entry books, with Stripe's record id on each one. Nothing is typed in by hand.",
				status: "shipped",
			},
			{
				title: "Sealed months and open formats",
				body: "Seal each month so a later change shows, export to Parquet, hledger or CSV, and run the engine yourself if you like.",
				status: "shipped",
			},
		],
		facts: [
			{
				label: "Built for",
				trifold: TRIFOLD.builtFor,
				them: "Freelancers, solopreneurs, contractors and consultants",
			},
			{
				label: "Monthly price",
				trifold: TRIFOLD.price,
				them: "Starter free; Pro $19 a month ($190 a year)",
			},
			{ label: "Free plan", trifold: TRIFOLD.free, them: "Yes: Starter" },
			{
				label: "Seats",
				trifold: TRIFOLD.seats,
				them: "Free tax-pro and payroll roles on Starter; user limits not stated",
			},
			{
				label: "Payments",
				trifold: "Uses your own Stripe account",
				them: "Its own payment processing: 2.9% + 60¢ per card payment on Starter",
			},
			{
				label: "Bank import",
				trifold: TRIFOLD.bank,
				them: "Through Plaid, on Pro",
			},
			{
				label: "Payroll",
				trifold: TRIFOLD.payroll,
				them: "Add-on, $25–40 a month",
			},
			{
				label: "Who can check the records",
				trifold: TRIFOLD.verify,
				them: "Not stated",
			},
			{ label: "AI", trifold: TRIFOLD.ai, them: "Not stated" },
			{ label: "Export", trifold: TRIFOLD.export, them: "Not stated" },
			{
				label: "Self-hosting",
				trifold: TRIFOLD.selfHost,
				them: "No; hosted only",
			},
			{ label: "Stripe", trifold: TRIFOLD.stripe, them: "Not stated" },
		],
		summary: {
			priceFrom: "$19/mo",
			freeTier: true,
			perSeat: "Not stated",
			aiPostsOnItsOwn: "Not stated",
			verifiableWithoutAccount: "Not stated",
			openExport: "Not stated",
			selfHost: false,
			stripe: "Not stated (own processing)",
		},
		chooseThem:
			"You're a solo operator who needs free invoicing and simple books.",
		chooseTrifold:
			"You collect tuition, dues or class fees through Stripe and need reconciled books that others can check.",
		sources: [
			{ label: "Wave homepage", url: "https://www.waveapps.com" },
			{ label: "Wave pricing", url: "https://www.waveapps.com/pricing" },
		],
		checked: "2026-11-06",
	},
	{
		slug: "spreadsheet",
		name: "Spreadsheets",
		oneLine:
			"Trifold vs Spreadsheets: a spreadsheet is free, flexible and fine at low volume; Trifold builds balanced books and checkable receipts from Stripe payments as the volume grows.",
		intro:
			"Plenty of microschools and small non-profits keep their books in Excel or Google Sheets: a ledger tab, with a Stripe CSV pasted in each month. It works, and at low volume it's often the right call. Trifold does the same job from the Stripe events themselves: balanced books, a signed receipt for every payment and sealed months, exported to the same CSV whenever you want a sheet.",
		theyAreStrongest: [
			{
				title: "Free, and everyone knows it",
				body: "Google Sheets is free and Excel comes with Microsoft 365. Nobody needs training, and there's nothing to migrate.",
			},
			{
				title: "Total control",
				body: "Lay it out however you like. For a 20-student school with one trusted person on the books, it's often enough.",
			},
			{
				title: "Your file, in open formats",
				body: "CSV and XLSX open anywhere, and you hold the file. Version history and sheet protection are there if you use them.",
			},
		],
		trifoldDiffers: [
			{
				title: "Books that always balance",
				body: "Every Stripe payment posts as a debit and a credit, so the books balance by construction, and replaying the events gives the same balances and journals.",
				status: "shipped",
			},
			{
				title: "A receipt for every payment, a seal on every month",
				body: "Each payment gets a signed receipt anyone can check with no account, and a sealed month shows any later change.",
				status: "shipped",
			},
			{
				title: "It still opens in a spreadsheet",
				body: "Export to CSV (or Parquet and hledger) any time, so the sheet you know is one download away.",
				status: "shipped",
			},
		],
		facts: [
			{
				label: "Cost",
				trifold: TRIFOLD.price,
				them: "Free (Google Sheets), or part of a Microsoft 365 or Google Workspace subscription",
			},
			{
				label: "Seats",
				trifold: TRIFOLD.seats,
				them: "Shared by link; no per-seat fee on Sheets",
			},
			{
				label: "The books",
				trifold:
					"Balanced double-entry books built from Stripe events; corrections are new events, never edits",
				them: "Whatever the sheet's formulas do; nothing makes it balance",
			},
			{
				label: "Stripe",
				trifold: TRIFOLD.stripe,
				them: "A CSV export pasted in, or a third-party connector",
			},
			{
				label: "Checks",
				trifold: `Signed receipts and sealed months; ${TRIFOLD.verify.toLowerCase()}`,
				them: "Version history and sheet protection; no signed receipts or enforced period locks",
			},
			{
				label: "AI",
				trifold: TRIFOLD.ai,
				them: "Gemini in Sheets and Copilot in Excel can edit cells, without accounting controls",
			},
			{ label: "Export", trifold: TRIFOLD.export, them: "CSV and XLSX" },
			{
				label: "Where it lives",
				trifold: TRIFOLD.selfHost,
				them: "You hold the file",
			},
		],
		summary: {
			priceFrom: "$0 (Sheets)",
			freeTier: true,
			perSeat: "None on Sheets",
			aiPostsOnItsOwn: "Copilots can edit cells",
			verifiableWithoutAccount: false,
			openExport: "CSV, XLSX",
			selfHost: "You hold the file",
			stripe: "Manual CSV export",
		},
		chooseThem:
			"You take a handful of payments a month and one trusted person keeps the books.",
		chooseTrifold:
			"Payments outgrow what one person can reconcile by hand, or a board, auditor or parent will ask how you know the numbers are right.",
		sources: [],
		basis: "General knowledge of Excel and Google Sheets, not a vendor page.",
		checked: "2026-11-06",
	},
];

/** The most recent check across every comparison, for the index page's note. */
export const LAST_CHECKED =
	COMPETITORS.map((competitor) => competitor.checked)
		.sort()
		.at(-1) ?? "";
