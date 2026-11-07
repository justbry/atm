import type { Clock } from "./types.ts";

/**
 * The member portal contract (S6, orchestrator-owned, protected; protocol §4). The portal is what one member of a
 * school sees, opened by an owner or admin as a preview from the Members tab (mockup `drawVM`, "View as member") and,
 * later, embedded on the school's own site. It is family-scoped: an adult sees the family's people, bookings and
 * payments; a teen or a child sees only their own. One read, `memberPortal`, returns everything the portal shows for
 * one person, already scoped by the server, so that document can be checked on its own (consistency check C5: no
 * other family's key or amount is in it). The Reader and the Writer of `reader.ts` and `writer.ts` extend
 * `PortalReader` and `PortalWriter`.
 *
 * Field names follow buzz-school brief A item 1 (`GET .../billing/members-list`: `key`, `familyId`, `profileId`,
 * `name`, `tierId`, `tierName`, `quantity`, `interval`, `status`, `currentPeriodEnd`, `cancelAtPeriodEnd`,
 * `menuVersion`, `balances[]` with `featureId`, `featureName`, `unit`, `available`, `held`, `expiresAt`), brief A
 * item 2 for bookings and brief A item 3 for menu prices. A field no brief has is marked "not in the briefs" with
 * where S8 gets it; no buzz-school route returns the whole document today (S8: a member-scoped route or the embed's
 * `portalSession`, both not built).
 *
 * The UI derives no number the server should derive: prices are per quantity as the menu sells them, balances are
 * the ledger's. The School books card reads the existing `Reader.kpiDocument` (see `PortalBooks`). The history CSV is
 * built by the shared CSV helper of `src/data/ledger.ts` (S5, the mockup's `kCsv`) with the columns and the file name
 * below.
 */

/** The five audiences of school books (disclosure spec v2): the same names, in rank order, as `Audience` of
 * `src/data/disclosure.ts` (S7), which this alias becomes once that file is on the branch. A person's audience is
 * computed by the server ("A person's audiences"): owner, admin with the finance grant, an adult's live tier's
 * `audience`, else public. A teen or a child never holds member or governance. */
export type PortalAudience =
	| "public"
	| "member"
	| "governance"
	| "finance"
	| "owner";

/** One portal: the school and the person whose portal it is (the mockup's member id, `s_21`). */
export type PortalQuery = { school: string; profileId: string };

/** A profile's place in its family (not in the briefs: buzz-school's family profiles). */
export type FamilyRole = "adult" | "teen" | "child";

/** brief A item 1 `balances[].unit`: the school's credit noun, `{ one: "credit", other: "credits" }`. */
export type PortalUnit = { one: string; other: string };

/** brief A item 1 `balances[]`, plus `used`. */
export type PortalBalance = {
	featureId: string;
	featureName: string;
	unit: PortalUnit;
	available: number;
	/** Held for upcoming bookings. */
	held: number;
	/** Unix seconds, or null when the lot does not expire. */
	expiresAt: number | null;
	/** Not in the briefs: spent this billing cycle (atm's `credit.spent` since the cycle began; S8). The bar is
	 * used, held and available side by side ("used 0, held 2, available 10"). */
	used: number;
};

/** One way the tier is sold (brief A item 3, the published menu): a quantity and its price per `interval`. */
export type QuantityOption = { quantity: number; priceCents: number };

/** A person in the portal: brief A item 1's row for their membership, with their family role and the menu's price. */
export type PortalMember = {
	/** The atm customer id, `family:<familyId>` (brief A: it MUST equal `src/school-billing/subject.ts`). Every
	 * person of one portal document has the same key. */
	key: string;
	familyId: string;
	/** The person (the mockup's `s_21`). */
	profileId: string;
	/** The nickname, else the family name (brief A). */
	name: string;
	/** null when the account has no family (a family of one): the portal says "No family on this account". */
	familyRole: FamilyRole | null;
	tierId: string;
	/** The plan as the menu names it ("Shine"); the UI writes the quantity after it: "Shine ×2". */
	tierName: string;
	quantity: number;
	interval: "month" | "year";
	status: "active" | "past_due" | "canceled";
	/** Unix seconds; the UI writes it in the school's time zone, "Dec 1". When the membership ends (`canceled`, or
	 * `cancelAtPeriodEnd`), it is the day it ends ("Ends Nov 11"). */
	currentPeriodEnd: number;
	cancelAtPeriodEnd: boolean;
	menuVersion: number;
	balances: PortalBalance[];
	/** brief A item 3: the price per `interval` at `quantity`, in minor units of the school's currency. */
	priceCents: number;
	/** brief A item 3: every quantity the tier is sold in with its price, in menu order; null when it is sold in one
	 * size (Change amount is then disabled, "This plan is sold in one size"). */
	quantityOptions: QuantityOption[] | null;
	/** Not in the briefs: a membership change the member asked for has not shipped yet (the mockup's pending
	 * `membership.changed` event; S8 from atm). The plan card then says "A change is on its way. It can take a few
	 * minutes." and Change amount, Cancel and Resume are disabled. */
	pendingChange: boolean;
};

/** A booking of a person in the portal: brief A item 2's fields, with whose it is and what it holds. Only bookings
 * not done (no recorded outcome, not cancelled) are in the document. */
export type PortalBooking = {
	id: string;
	/** Whose booking it is (brief A's `attendee` carries only the family key and a name). */
	profileId: string;
	service: string;
	/** The school's local wall time, `YYYY-MM-DDTHH:MM`, as `Clock.now` (as S2's `Booking.startsAt`). */
	startsAt: string;
	hosts: Array<{ id: string; name: string }>;
	state: "requested" | "confirmed";
	/** `booking_events.change_cutoff_min` (brief A). */
	cutoffMinutes: number;
	/** Not in the briefs: credits held for it (atm's `credit.held` joined by booking id; S8), 0 when none. */
	held: number;
	/** Not in the briefs: what was paid for it in minor units (atm's `payment.succeeded` with this booking), or null
	 * when nothing was paid. A paid booking reads "Contact the school to cancel". */
	paidCents: number | null;
};

/** The statuses of an invoice, a payment or a refund in the history (mockup `kLive`, `kFixture`), and their
 * labels (the pill and the CSV's `status`). */
export type PaymentStatus =
	| "paid"
	| "refunded"
	| "partly_refunded"
	| "failed"
	| "open";
export const paymentStatusLabels: Record<PaymentStatus, string> = {
	paid: "Paid",
	refunded: "Refunded",
	partly_refunded: "Partly refunded",
	failed: "Failed",
	open: "Open",
};

/** One row of "Invoices and payments" (mockup `kHist`): an invoice, a payment or a refund. Not in the briefs: Stripe
 * invoices and charges of the family's memberships (S8, not built); the fixtures carry the mockup's `kFixture`
 * history. */
export type PortalHistoryRow = {
	/** Whose row it is; the adult's view names the person under the description. */
	profileId: string;
	/** `YYYY-MM-DD` in the school's time zone. */
	date: string;
	description: string;
	/** Signed minor units: a refund is negative. */
	amountCents: number;
	/** ISO 4217, upper case (`USD`), as the CSV writes it. */
	currency: string;
	status: PaymentStatus;
	/** Stripe ids, or "" when there is none (an unpaid invoice has no payment). */
	invoiceId: string;
	paymentId: string;
	/** A refund of this payment has not shipped yet: the row adds "refund pending". */
	refundPending: boolean;
};

/** A one-off add-on the member can buy (brief A item 3, published add-ons): "Top-up pack · 8 sessions · $40.00". */
export type PortalAddon = {
	id: string;
	name: string;
	priceCents: number;
	/** Credits it grants. */
	grants: number;
};

/** The School books card (mockup `mpBooks`): the viewed person's audience. A teen or a child is `public` with
 * `guardian` set ("Your guardian (Dana W.) sees school books."), and its card shows no figure. For an adult at
 * `member` or `public`, the card shows the latest period that audience's document publishes:
 * `Reader.kpiDocument({ preset: <the first preset of dashboardOptions()>, level: <the audience>, pinLocked: false })`,
 * the last of `periodInfo` whose `waiting.money` is null, its `gross_collected` and `net_income` cells as S1 formats
 * cells (a hidden cell is its label, never 0). Governance and up show no figure on the card. */
export type PortalBooks = {
	audience: PortalAudience;
	/** The adult on the account, for a teen or a child; null otherwise. */
	guardian: { profileId: string; name: string } | null;
};

/** Everything the portal shows for one person, scoped by the server. */
export type MemberPortal = {
	school: string;
	/** The person whose portal it is. */
	profileId: string;
	/** `family` for an adult of a family (everyone in `people`); `own` for a teen, a child or a family of one. */
	scope: "family" | "own";
	/** The family, or null when the account has no family. `members` names each profile and its role for the
	 * preview's "Viewing as: Adult Teen Child" switch only (no balances or amounts of anyone outside `people`). */
	family: {
		familyId: string;
		/** "Wu family". */
		label: string;
		members: Array<{
			profileId: string;
			name: string;
			familyRole: FamilyRole;
		}>;
	} | null;
	/** For `family`, everyone in family order (the adult, then the learners as the family lists them), whoever is
	 * viewed; for `own`, only the viewed person. */
	people: PortalMember[];
	/** Every booking of `people` not done yet, `startsAt` ascending. The Bookings tab lists the viewed person's; the
	 * Family tab each person's. */
	bookings: PortalBooking[];
	/** Every row of `people`, newest first (date descending; on one day a refund before a payment, else family
	 * order), the order the card and the CSV keep. */
	history: PortalHistoryRow[];
	addons: PortalAddon[];
	books: PortalBooks;
};

export interface PortalReader {
	/** The portal of one person, or undefined when the school has no such person with a membership (mockup: "No plan,
	 * so there is no member portal to view"). */
	memberPortal(query: PortalQuery): Promise<MemberPortal | undefined>;
}

/** Change amount (mockup `vAct('qty')`): the new quantity, one of `quantityOptions`. */
export type ChangeQuantity = {
	school: string;
	profileId: string;
	quantity: number;
};
/** A decrease takes effect at the renewal (the card then says "Switches to Shine ×1 on Dec 1."); an increase is
 * charged now, prorated by the server, and grants the difference once it ships. */
export type QuantityChanged =
	| { at: "renewal" }
	| { at: "now"; chargedCents: number; granted: number };
/** Cancel membership (mockup `vAct('cancel')`): a member cancels at the end of the period only; `reason` is the
 * optional text, sent only when not empty after trimming. */
export type CancelMembership = {
	school: string;
	profileId: string;
	reason?: string;
};
/** Resume membership (mockup `vAct('resume')`). */
export type ResumeMembership = { school: string; profileId: string };
/** Cancel booking on the portal's Bookings tab (mockup `[data-act=release]` there). */
export type CancelPortalBooking = {
	school: string;
	profileId: string;
	bookingId: string;
};

/** The portal's writes. They are the member's own requests (buzz-school's member routes), not the admin actions of the
 * Members tab's ⋯ menu, so they are separate methods. Buy, Update (card) and Open school books write nothing: they
 * hand off to Stripe Checkout, Stripe's billing portal and the books, and only say so in a toast. While previewing
 * an audience other than one's own (`as=`), every one of them is disabled, title "Exit preview to act". */
export interface PortalWriter {
	portalChangeQuantity(request: ChangeQuantity): Promise<QuantityChanged>;
	portalCancelMembership(request: CancelMembership): Promise<void>;
	portalResumeMembership(request: ResumeMembership): Promise<void>;
	portalCancelBooking(request: CancelPortalBooking): Promise<void>;
}

/** The history card shows this many rows until "Show all history". */
export const historyShortRows = 5;
/** The history period filter (mockup `K_HF`): every row, the clock's year, or the year before it. */
export type HistoryPeriod = "all" | "this" | "last";
export const historyPeriods: ReadonlyArray<{
	id: HistoryPeriod;
	label: string;
}> = [
	{ id: "all", label: "All" },
	{ id: "this", label: "This year" },
	{ id: "last", label: "Last year" },
];
/** The rows of one history period (mockup `kFilter`), order kept. */
export const historyRowsIn = (
	rows: ReadonlyArray<PortalHistoryRow>,
	period: HistoryPeriod,
	clock: Clock,
): PortalHistoryRow[] => {
	if (period === "all") return [...rows];
	const year = Number(clock.today.slice(0, 4)) - (period === "last" ? 1 : 0);
	return rows.filter((row) => row.date.startsWith(`${year}-`));
};

/** The CSV's columns (mockup `K_COLS`), for the shared helper: `member` (the row's `profileId`) only in an adult's
 * family export. Amounts are signed decimals with two places ("-40.00"); status is its label. */
export const historyCsvColumns = (family: boolean): string[] => [
	"date",
	...(family ? ["member"] : []),
	"description",
	"amount",
	"currency",
	"status",
	"invoice_id",
	"payment_id",
];
/** The download's name (mockup `kName`): `invoices-<profileId>-<first date>-<last date>.csv` over the exported rows
 * (the button is disabled when there are none). */
export const historyCsvFileName = (
	profileId: string,
	rows: ReadonlyArray<PortalHistoryRow>,
): string => {
	const dates = rows.map((row) => row.date).sort();
	return `invoices-${profileId}-${dates[0] ?? ""}-${dates[dates.length - 1] ?? ""}.csv`;
};

/** The site themes of the portal preview (mockup `THEMES`), in the "Site theme" menu's order; the route's
 * `siteTheme`, absent `b4u`. */
export type SiteThemeId = "b4u" | "host" | "dark";
export type SiteTheme = {
	name: string;
	background: string;
	foreground: string;
	card: string;
	muted: string;
	border: string;
	primary: string;
	onPrimary: string;
	warn: string;
	radius: string;
	font: string;
};
export const siteThemes: Readonly<Record<SiteThemeId, SiteTheme>> = {
	b4u: {
		name: "B4 Uni (buzz-school look)",
		background: "#fbf7f0",
		foreground: "#2a2530",
		card: "#ffffff",
		muted: "#7a7385",
		border: "#e8dfd0",
		primary: "#3f8068",
		onPrimary: "#ffffff",
		warn: "#b45309",
		radius: "14px",
		font: "'Bricolage Grotesque',Figtree,system-ui,sans-serif",
	},
	host: {
		name: "Host site: warm serif",
		background: "#ffffff",
		foreground: "#1c1917",
		card: "#f7f5f2",
		muted: "#6d6560",
		border: "#e4dfd9",
		primary: "#c2410c",
		onPrimary: "#ffffff",
		warn: "#a16207",
		radius: "3px",
		font: "Georgia,'Times New Roman',serif",
	},
	dark: {
		name: "Host site: dark",
		background: "#101014",
		foreground: "#ececf0",
		card: "#18181d",
		muted: "#9a9aa6",
		border: "#2a2a32",
		primary: "#7aa2ff",
		onPrimary: "#0b0b0d",
		warn: "#f0a020",
		radius: "10px",
		font: "var(--font-sans)",
	},
};
export const siteThemeIds: ReadonlyArray<SiteThemeId> = ["b4u", "host", "dark"];

/** The portal frame's custom properties (mockup `themeVars`), set on the frame element. */
export const portalFrameVariables = (
	theme: SiteTheme,
): Record<string, string> => ({
	"--mp-bg": theme.background,
	"--mp-fg": theme.foreground,
	"--mp-card": theme.card,
	"--mp-muted": theme.muted,
	"--mp-border": theme.border,
	"--mp-pri": theme.primary,
	"--mp-prifg": theme.onPrimary,
	"--mp-warn": theme.warn,
	"--mp-rad": theme.radius,
	"--mp-font": theme.font,
});

/** The school's name as the embed snippet's `data-school` (mockup `slug`): "B4 Uni" is `b4-uni`. */
export const schoolSlug = (name: string): string =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);

/** The embed modal's four snippets (mockup `embedModal`), as the `pre` blocks show them. Copy snippet puts
 * `page` on the clipboard. The theme block is the CSS a host page sets with `data-theme="inherit"`; the font is
 * written as CSS, without the mockup's backslashes before its quotes. `books` embeds the public school-books
 * document, the only one that may be embedded (disclosure spec v2, `GET /public/schools/<id>/books/<year>`), for
 * `publicYear`: the last period the public KPI document shows (2024 at the mockup's clock). */
export const embedSnippets = (
	schoolName: string,
	theme: SiteTheme,
	publicYear: string,
): { page: string; server: string; theme: string; books: string } => ({
	books: [
		'<script src="https://books.b4uni.com/embed.js"',
		`  data-src="GET /public/schools/${schoolSlug(schoolName)}/books/${publicYear}"></script>`,
	].join("\n"),
	page: [
		'<div id="b4-portal"></div>',
		'<script src="https://portal.b4uni.com/embed.js"',
		`  data-school="${schoolSlug(schoolName)}"`,
		'  data-session-url="/api/b4-portal-session"',
		'  data-theme="inherit"></script>',
	].join("\n"),
	server: [
		"// server only. Uses your b4u_sk_ key, never the browser.",
		"const { token } = await school.portalSession({",
		"  member: user.memberId,",
		'  returnUrl: "https://yoursite.com/account",',
		"});",
		"return Response.json({ token });",
	].join("\n"),
	theme: [
		":root {",
		`  --b4-bg: ${theme.background};`,
		`  --b4-fg: ${theme.foreground};`,
		`  --b4-card: ${theme.card};`,
		`  --b4-muted: ${theme.muted};`,
		`  --b4-border: ${theme.border};`,
		`  --b4-primary: ${theme.primary};`,
		`  --b4-on-primary: ${theme.onPrimary};`,
		`  --b4-radius: ${theme.radius};`,
		`  --b4-font: ${theme.font};`,
		"}",
	].join("\n"),
});

/** The embed modal's "School books on your site" Document select lists every audience in rank order with this
 * text; only `public` is enabled and selected. */
export const embedBooksAudienceLabels: Readonly<
	Record<PortalAudience, string>
> = {
	public: "Public (no cookie, Cache-Control: public)",
	member: "Member: needs a session, can't be embedded",
	governance: "Governance: needs a session, can't be embedded",
	finance: "Finance admin: needs a session, can't be embedded",
	owner: "Owner: needs a session, can't be embedded",
};

/** The embed modal's "Allowed sites (sets frame-ancestors)" field starts with this. */
export const embedAllowedSitesDefault = "https://vibes.example.com";
