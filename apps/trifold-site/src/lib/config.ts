/**
 * Site-wide constants. SITE_ORIGIN is a placeholder until the domain is registered: change it here and the canonical
 * links, Open Graph URLs, sitemap.xml and robots.txt all follow.
 */
export const SITE_ORIGIN = "https://tfd-ledger.pages.dev";
export const SITE_NAME = "Trifold";
export const DEFAULT_DESCRIPTION =
	"Books that show their work. Every Stripe payment becomes a signed receipt your families can check, and every sealed month shows any later change.";

export const GITHUB_URL = "https://github.com/justbry/atm";
/** Where "Install the CLI" points: the engine's package in the repo. */
export const CLI_URL = "https://github.com/justbry/atm/tree/dev/packages/atm";
/**
 * The live demo: Honeycomb Hill Academy, a sample school's dashboard on synthetic data, computed by the engine. Every
 * demo link reads this constant (a test fails if another file in src/ spells the URL). Switch it to
 * https://b4uni.com/for/schools/dashboard once B4 Uni deploys to production; until then that address is a 404. The
 * demo's CSP only lets its own origin frame it, so link to it (new tab); never iframe it.
 */
export const DEMO_URL = "https://staging.b4uni.com/for/schools/dashboard";
/** Placeholder contact address, used as the early-access fallback when no form endpoint is configured. */
export const CONTACT_EMAIL = "hello@gettrifold.com";

/**
 * Where the early-access form posts. Set PUBLIC_FORM_ENDPOINT at build time; unset shows a mailto fallback. `env?.`
 * because vite.config.ts imports this file (through the comparisons) before Vite provides import.meta.env.
 */
export const FORM_ENDPOINT: string =
	(import.meta.env?.PUBLIC_FORM_ENDPOINT as string | undefined)?.trim() ?? "";

export const OG_IMAGE = "/og.png";

export type NavItem = { href: string; label: string };

/** An audience page, with the one line the "Who it's for" menu shows under its name. */
export type Audience = NavItem & { description: string };

/** Who it's for: the header menu, the mobile menu, the footer and the /for hub all read these groups. */
export const AUDIENCE_GROUPS: { title: string; items: Audience[] }[] = [
	{
		title: "Everyone",
		items: [
			{
				href: "/for",
				label: "Everyone",
				description: "Every organization paid through Stripe",
			},
		],
	},
	{
		title: "Organizations",
		items: [
			{
				href: "/for/schools",
				label: "Schools",
				description: "Tuition receipts families can check",
			},
			{
				href: "/for/churches",
				label: "Churches",
				description: "Giving records your treasurer can trust",
			},
			{
				href: "/for/nonprofits",
				label: "Non-profits and co-ops",
				description: "Open books for donors, members and the board",
			},
		],
	},
	{
		title: "Membership businesses",
		items: [
			{
				href: "/for/studios",
				label: "Studios and gyms",
				description: "Memberships, class packs and credits",
			},
			{
				href: "/for/saas",
				label: "SaaS and digital products",
				description: "Seats, plans and usage credits",
			},
			{
				href: "/for/creators",
				label: "Creators and online courses",
				description: "Memberships, courses and launches",
			},
		],
	},
	{
		title: "Partners",
		items: [
			{
				href: "/for/accountants",
				label: "Accountants",
				description: "Clients whose books arrive sealed",
			},
			{
				href: "/for/developers",
				label: "Developers",
				description: "A provable ledger and a free CLI",
			},
		],
	},
];
export const AUDIENCES: Audience[] = AUDIENCE_GROUPS.flatMap(
	(group) => group.items,
);

/** The header. `menu` marks the item whose label links to /for and whose button opens the audience menu. */
export const NAV: (NavItem & { menu?: true })[] = [
	{ href: "/how-it-works", label: "How it works" },
	{ href: "/for", label: "Who it's for", menu: true },
	{ href: "/pricing", label: "Pricing" },
	{ href: "/proof", label: "Proof" },
	{ href: "/verify", label: "Verify" },
];

export const FOOTER: {
	title: string;
	items: (NavItem & { external?: boolean })[];
}[] = [
	{
		title: "Product",
		items: [
			{ href: "/how-it-works", label: "How it works" },
			{ href: "/roadmap", label: "Roadmap" },
			{ href: "/pricing", label: "Pricing" },
		],
	},
	{
		title: "For",
		items: AUDIENCES.map(({ href, label }) => ({ href, label })),
	},
	{
		title: "Trust",
		items: [
			{ href: "/trust", label: "Trust" },
			{ href: "/proof", label: "Proof" },
			{ href: "/verify", label: "Verify" },
			{ href: GITHUB_URL, label: "GitHub", external: true },
		],
	},
	{
		title: "Company",
		items: [
			{ href: "/about", label: "About" },
			{ href: "/early-access", label: "Early access" },
			{ href: "/brand", label: "Brand" },
			{ href: "/legal", label: "Legal" },
		],
	},
];

/**
 * Every prerendered page, for sitemap.xml and llms.txt (scripts/agent-files.ts fails the build if a page is missing).
 * The one-on-one comparisons under /compare are added from src/lib/compare/competitors.ts.
 */
export const PAGES = [
	"/",
	"/how-it-works",
	"/trust",
	"/proof",
	"/verify",
	"/roadmap",
	"/pricing",
	"/for",
	"/for/schools",
	"/for/churches",
	"/for/nonprofits",
	"/for/studios",
	"/for/saas",
	"/for/creators",
	"/for/accountants",
	"/for/developers",
	"/compare",
	"/about",
	"/early-access",
	"/brand",
	"/legal",
] as const;

/** Pages with a markdown mirror but left out of llms.txt and llms-full.txt. */
export const AGENT_EXCLUDED: readonly string[] = ["/brand"];
