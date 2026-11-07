import type { Cell } from "./kpi-document.ts";
import type { Clock } from "./types.ts";

/**
 * The Ledger, Reports and Promos contract (S5, orchestrator-owned, protected; protocol §4). The Reader and the Writer
 * of `reader.ts` and `writer.ts` extend `LedgerReader` and `LedgerWriter`.
 *
 * Read side. The Ledger is atm's event log as the read slice exposes it (`readEventsFromStore` in
 * `packages/atm/src/ledger/read.ts`, one `AtmEvent` per line; `buildViews` in `views.ts` for the month money), joined
 * with buzz-school brief A item 1's members list by `key` for the names. Reports is the income statement over one
 * period, the school's rules in force and the "Donors and payers" report; below `finance` it is the audience's
 * document instead (spec v2 "Documents and routes"). Promos have no buzz-school route yet (the briefs leave promo codes
 * out of scope, and brief A item 4 answers `createPromo` with `not_built`): the shapes follow the mockup, and S8's
 * adapter leaves the tab on fixtures until a route exists.
 *
 * Write side. Promo create and disable, and the CSV downloads: every file the UI saves goes through
 * `Writer.download`, so a test sees its exact bytes.
 *
 * The UI derives no number: day totals, counts, statement lines, peaks, payer counts and disclosed cells come from the
 * Reader. What the UI may work out is exported here: the event labels, the promo mask, `expiresSoon`, the audience
 * rules for what a tab shows, and the one CSV helper.
 */

// ---- Audiences (spec v2). The same five names as `Audience` in `src/data/disclosure.ts` (S7); this file names them
// here so the S5 contract stands on its own, and moves to `import type { Audience }` once both are on one branch.

export type ViewerAudience =
	| "public"
	| "member"
	| "governance"
	| "finance"
	| "owner";

const audienceOrder: readonly ViewerAudience[] = [
	"public",
	"member",
	"governance",
	"finance",
	"owner",
];

/** The audience a route shows: `as=` when it is one of the five at or below the signed-in person's own (mockup
 * `vaAllowed`: nobody previews above themselves, so a finance admin's `as=owner` shows Finance admin), else their own
 * (the School's `booksLevel`, with cell-rules' `finance_admin` read as `finance`). */
export const audienceOf = (
	asParameter: string | null,
	ownLevel: string,
): ViewerAudience => {
	const own: ViewerAudience =
		ownLevel === "finance_admin" ? "finance" : (ownLevel as ViewerAudience);
	const asked = audienceOrder.find((audience) => audience === asParameter);
	return asked !== undefined &&
		audienceOrder.indexOf(asked) <= audienceOrder.indexOf(own)
		? asked
		: own;
};

/** A preview (an audience other than the signed-in person's own) acts on nothing: its writes are disabled with the
 * title `Exit preview to act`. */
export const isPreview = (shown: ViewerAudience, ownLevel: string): boolean =>
	shown !== audienceOf(null, ownLevel);

/** Spec v2: `rows` and `names` (identities) show to `finance` and `owner` only, through `ViewIdentities`, each read
 * audited. The Ledger, the full income statement and the Donors and payers table are identities. */
export const seesIdentities = (audience: ViewerAudience): boolean =>
	audience === "finance" || audience === "owner";

/** Spec v2 audience table: the PIN opens the books from `governance` up (`pin=locked` in the route). */
export const needsPin = (audience: ViewerAudience): boolean =>
	audience === "governance" || seesIdentities(audience);

/** How the lock panels and the audience document name an audience (v2 mockup `AUD_NAME`). */
export const audienceNames: Record<ViewerAudience, string> = {
	public: "Public",
	member: "Member",
	governance: "Governance",
	finance: "Finance admin",
	owner: "Owner",
};

// ---- atm's event (packages/atm/src/types.ts `AtmEvent`), copied: `src/**` may not import `packages/atm`.

export type LedgerEventType =
	| "payment.succeeded"
	| "payment.refunded"
	| "payment.disputed"
	| "dispute.closed"
	| "payout.paid"
	| "plan.attached"
	| "plan.changed"
	| "plan.canceled"
	| "credit.granted"
	| "credit.held"
	| "credit.released"
	| "credit.spent"
	| "credit.refunded"
	| "credit.forfeited"
	| "credit.expired"
	| "credit.adjusted"
	| "credit.expiration_changed"
	| "credit.low"
	| "credit.depleted"
	| "fundraise.received"
	| "fundraise.paid_out"
	| "subject.erased"
	| "share.charged"
	| "referral.qualified"
	| "referral.rewarded"
	| "catalog.published"
	| "policy.published"
	| "share.accrued"
	| "share.reversed"
	| "share.settled"
	| "money.skipped";

/** One line of a transaction: `amount` is a decimal string (two places for USD, none for credits). */
export type LedgerPosting = {
	account: string;
	amount: string;
	commodity: string;
};

/** `AtmEvent` as `readEventsFromStore` returns it. */
export type LedgerEvent = {
	v: 1;
	/** A ULID. */
	id: string;
	school: string;
	/** Where it came from: `stripe`, `family` (the family service), `cron`, `admin`. */
	source: string;
	event_type: LedgerEventType;
	/** UTC instant, ISO 8601 with `Z`. */
	event_time: string;
	ingest_time: string;
	/** The school's local day, `YYYY-MM-DD`. */
	date: string;
	tz: string;
	/** The atm customer id, `family:<familyId>` (brief A item 1's `key`). */
	key: string;
	/** `booking` (a booking id), `code` (a promo id), `kind` (`membership`, `booking`, `gift`, `gift_redeemed`). */
	labels: Record<string, string>;
	idem: string;
	cause?: string;
	text: string;
	postings: LedgerPosting[];
	payload: Record<string, unknown>;
	redacted?: Record<string, unknown>;
};

// ---- The Ledger tab

/** The type chips (mockup `#lchips`, `okT`): `payment` and `credit` match the event type's prefix, `payout` too;
 * `booking` an event with a `booking` label, `code` one with a `code` label, `admin` one whose source is `admin`. */
export type LedgerTypeFilter =
	| "payment"
	| "credit"
	| "booking"
	| "code"
	| "payout"
	| "admin";

/** A Reports drill-down (mockup `DD`): the statement line or KPI whose events the Ledger lists. */
export type LedgerDrill =
	| "income"
	| "memb"
	| "book"
	| "disc"
	| "refund"
	| "fees"
	| "payout"
	| "gift";

/** The filter chip a drill-down shows: `Filter: <label> ×` (mockup `DD`). A promo's Redemptions shows
 * `Promo <masked code> ×` instead. */
export const drillLabels: Record<LedgerDrill, string> = {
	income: "Income",
	memb: "Memberships",
	book: "Bookings and events",
	disc: "Discounts given",
	refund: "Refunds",
	fees: "Payments (fees apply)",
	payout: "Payouts",
	gift: "Gift certificates sold",
};

/** One read of the Ledger: the events dated `from` to `to` (inclusive, the school's local days) that match every
 * filter given, plus every pending one. Filters are applied by the Reader. */
export type LedgerQuery = {
	school: string;
	from: string;
	to: string;
	type: LedgerTypeFilter | null;
	drill: LedgerDrill | null;
	/** A promo id: the events labelled with that code (the promo's Redemptions). */
	promo: string | null;
};

/** The member an event is about, from brief A's list joined by `key`: `id` is what the Member column shows after the
 * name (the mockup's member id), `name` the nickname, else the family name. */
export type LedgerMember = { key: string; id: string; name: string };

/** The credit unit's words, as the school names its credits (`session` / `sessions`). */
export type CreditUnit = { one: string; other: string };

export type LedgerEntry = {
	event: LedgerEvent;
	/** Written by the UI and not yet shipped (the outbox): shown under "Waiting to ship" with a pending badge and
	 * "just now". */
	pending: boolean;
	/** `event_time` as the school's local wall time, `YYYY-MM-DDTHH:MM`; the Time column shows `HH:MM`. */
	localTime: string;
	/** null for an event about no member (a gift sold to a guest, a payout): the Member column shows `—`. */
	member: LedgerMember | null;
	/** Signed whole credits this event moves for the member (`+24`, `−1`), or null when it moves none. */
	credits: number | null;
	/** Signed minor units of money (`+65.00`, `−50.00`; a payout is positive and shown without a sign), or null. */
	amountCents: number | null;
	/** The Stripe payment this event is about (`payment.succeeded`, `payment.refunded`), else null. */
	paymentId: string | null;
	/** The promo the event is labelled with, for "· promo <masked code>". */
	promo: { id: string; code: string } | null;
};

/** One day group (mockup `tr.day`): `<Wkd> <Mon> <d> · <count> event(s)`, then the summed credits (empty when 0)
 * and the summed money of the day's events other than payouts (empty when 0), both from the Reader. */
export type LedgerDay = {
	date: string;
	count: number;
	credits: number;
	amountCents: number;
	entries: LedgerEntry[];
};

export type LedgerPage = {
	school: string;
	from: string;
	to: string;
	/** The school's time zone, currency and credit unit come from its latest published menu: null when it has none. */
	timeZone: string | null;
	/** ISO 4217. */
	currency: string | null;
	unit: CreditUnit | null;
	/** Every event the page holds, pending ones included: `<count> events · <timeZone>`. */
	count: number;
	/** Shown first, under "Waiting to ship (<n>) · each ships within 5 min". */
	pending: LedgerEntry[];
	/** Newest day first; within a day, the order the table shows. */
	days: LedgerDay[];
};

/** The Event column's label (mockup `lab` and `L`): `{U}` is the unit's plural capitalised, `{u}` the plural. */
export const ledgerLabels: Partial<Record<LedgerEventType, string>> = {
	"payment.succeeded": "Payment",
	"credit.granted": "{U} granted",
	"credit.spent": "{U} used",
	"credit.held": "{U} held",
	"credit.released": "Hold released",
	"credit.forfeited": "{U} forfeited",
	"credit.depleted": "Out of {u}",
	"payout.paid": "Payout",
	"payment.refunded": "Refund",
	"credit.refunded": "{U} returned",
	"credit.expired": "{U} expired",
	"credit.adjusted": "Adjustment",
	"catalog.published": "Plans published",
};

const capitalise = (word: string): string =>
	`${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;

export const ledgerLabel = (entry: LedgerEntry, unit: CreditUnit): string => {
	const { event_type: type, labels } = entry.event;
	if (type === "payment.succeeded")
		return labels.kind === "booking"
			? "Booking payment"
			: labels.kind === "gift"
				? "Gift sold"
				: "Payment";
	if (type === "payment.refunded")
		return labels.kind === "booking" ? "Booking refund" : "Refund";
	if (type === "credit.granted" && labels.kind === "gift_redeemed")
		return "Gift redeemed";
	return (ledgerLabels[type] ?? type)
		.replace("{U}", capitalise(unit.other))
		.replace("{u}", unit.other);
};

// ---- Reports

export type IncomeStatementQuery = {
	school: string;
	from: string;
	to: string;
	/** `compare=1` in the route (the period dialog's "Compare with previous period"): also answer `previous`. */
	compare: boolean;
};

/** The statement's lines in minor units, signed as shown: discounts, refunds and fees are negative. */
export type StatementAmounts = {
	memberships: number;
	bookings: number;
	/** Null when the source records no discounts (no atm event carries one yet). */
	discounts: number | null;
	income: number;
	refunds: number;
	fees: number;
	net: number;
	/** "Not income: gift certificates sold …": a liability until redeemed. */
	giftsSold: number | null;
	paidOut: number;
};

/** The sparkline (mockup `series`): daily points for up to 62 days, else weekly, from `from` to the earlier of `to`
 * and the clock's today; empty when the period starts after today. */
export type IncomeSeries = {
	step: "day" | "week";
	points: Array<{ start: string; amountCents: number }>;
	/** The last day drawn. */
	through: string;
	totalCents: number;
	/** The first point with the largest amount. */
	peak: { start: string; amountCents: number } | null;
};

export type SchoolRules = {
	cancelCutoffHours: number;
	/** `spend`: "<units> are spent"; `release`: "<units> are released". */
	noShow: "spend" | "release";
	/** `spend`: "<units> are forfeited"; `release`: "<units> are released". */
	lateCancel: "spend" | "release";
};

/** Finance and owner: the period's income statement (mockup `reports`, `calc`). */
export type IncomeStatement = {
	school: string;
	from: string;
	to: string;
	currency: string;
	unit: CreditUnit;
	basis: { kind: "cash" } | { kind: "deferred"; from: string };
	/** True when the period is whole months and atm's reconciliation matches Stripe: "Matches Stripe · …"; otherwise
	 * the "Partial month" line. */
	matchesStripe: boolean | null;
	counts: { payments: number; refunds: number; payouts: number };
	amounts: StatementAmounts;
	/** Active dollar gifts' value, active credit gifts' credits, and how many gifts that is. */
	giftsOutstanding: {
		amountCents: number;
		credits: number;
		count: number;
	} | null;
	income: IncomeSeries;
	/** The previous period of the same length, when `compare`. */
	previous: {
		from: string;
		to: string;
		amounts: StatementAmounts;
		/** Each line of this period less the same line of the previous one (the KPI tiles' "▲ $X vs <period>"),
		 * worked out by the server: the UI formats it and never subtracts. */
		changes: StatementAmounts;
		income: IncomeSeries;
	} | null;
};

/** A figure of an audience's document (spec v2): a number, `{ lt }` below a rounding unit, or hidden with the
 * spec's reason. S7's `Disclosure` cells replace this when they land; until then the fixture fills it from the
 * documents of `documents.json` at the matching level. */
export type ReportCell =
	| Cell
	| { hidden: "embargoed"; until: string }
	| { hidden: "members_only" | "no_grant"; who: string };

export type AudienceReportQuery = {
	school: string;
	audience: "public" | "member" | "governance";
	from: string;
	to: string;
};

/** Public, member and governance: Reports shows the audience's document (v2 mockup `reportsDoc`). */
export type AudienceReport = {
	audience: "public" | "member" | "governance";
	grain: "year" | "quarter" | "month";
	/** The document period the statement shows: `2024`, `Q2 2026`, `Jun 2026`. */
	periodLabel: string;
	payments: ReportCell;
	/** "Income by <grain>": every period of the grain, in order. */
	periods: Array<{ label: string; income: ReportCell }>;
	figures: {
		memberships: ReportCell;
		bookings: ReportCell;
		discounts: ReportCell;
		income: ReportCell;
		refunds: ReportCell;
		fees: ReportCell;
		net: ReportCell;
		paidOut: ReportCell;
		giftsOutstanding: ReportCell;
	};
	/** Governance: the statement's plan lines. */
	tiers: Array<{ name: string; income: ReportCell }>;
	/** Money rounded to this many minor units for this audience and school size, or null for exact. */
	rounding: { unitCents: number; size: "small" | "large" } | null;
};

export type DonorsQuery = {
	school: string;
	audience: ViewerAudience;
	year: number;
};

export type DonorRow = {
	/** A member's id, or a donor's opaque id (`d_7041`). */
	id: string;
	/** "Anonymous" to the finance admin when the donor asked (spec v2); the owner gets the name. */
	name: string;
	kind: "member" | "donor";
	fund: string | null;
	payments: number;
	totalCents: number;
	lastPaymentOn: string;
	anonymous: boolean;
};

/** "Donors and payers" (mockup `bkDonors`). `identified` for finance and owner: every row, largest total first (the
 * card shows the first 15); `spread` for governance (no names, no rows); `none` below. */
export type DonorsReport =
	| {
			kind: "identified";
			year: number;
			donorCount: number;
			payerCount: number;
			rows: DonorRow[];
	  }
	| {
			kind: "spread";
			/** The last closed month, `YYYY-MM`. */
			through: string;
			donors: ReportCell;
			buckets: Array<{ label: string; donors: ReportCell; why: string | null }>;
			medianCents: ReportCell;
	  }
	| { kind: "none" };

// ---- Promos

/** `member`: a percent off membership tiers; `dollar`: a one-use gift certificate worth money; `session`: a one-use
 * gift of credits. */
export type PromoType = "member" | "dollar" | "session";
export type PromoStatus = "active" | "disabled" | "redeemed";

/** How many times a promo was used, as the audience may see it (spec v2 small counts): exact for finance and owner;
 * below, `{ lt: 10 }` for 1 to 9 under the cell rules ("<10"), and hidden below governance (a breakdown). */
export type PromoUses = number | { lt: number } | { hidden: "no_grant" };

export type Promo = {
	id: string;
	code: string;
	type: PromoType;
	/** Percent for `member`, minor units for `dollar`, credits for `session`. */
	value: number;
	used: PromoUses;
	/** Uses allowed; null for no limit (the Used column then shows the count alone). */
	maxUses: number | null;
	expiresOn: string;
	status: PromoStatus;
};

export type PromosQuery = { school: string; audience: ViewerAudience };
export type PromoList = { promos: Promo[]; currency: string; unit: CreditUnit };

/** Create promo (mockup `ACT.code`): owner only. `value` as in `Promo`; the note is required (3 characters or more).
 * The Writer answers the created promo, with its code; the fixture answers `CODE1000`, `GIFT1000` or `SESS1000`
 * (the mockup's prefix and the lowest number of its random range) and id `c_new`. */
export type CreatePromo = {
	school: string;
	type: PromoType;
	value: number;
	expiresOn: string;
	note: string;
};
/** Disable (mockup `[data-dis]`): the code stops working at checkout. The Writer answers the promo, now disabled. */
export type DisablePromo = { school: string; promoId: string };

/** A code longer than 6 characters is shown masked: its first 3, `•••`, its last 2 (mockup `mask`). */
export const maskCode = (code: string): string =>
	code.length > 6 ? `${code.slice(0, 3)}•••${code.slice(-2)}` : code;

const dayMilliseconds = 86_400_000;
/** The `soon` badge (mockup `codes`): an active gift (not a member discount) that expires within 30 days. */
export const expiresSoon = (promo: Promo, clock: Clock): boolean =>
	promo.type !== "member" &&
	promo.status === "active" &&
	(Date.parse(`${promo.expiresOn}T00:00:00Z`) -
		Date.parse(`${clock.today}T00:00:00Z`)) /
		dayMilliseconds <=
		30;

// ---- Downloads and the one CSV helper (mockup `kCell`, `kCsv`, `kName`, `kSave`)

export const csvMediaType = "text/csv;charset=utf-8";
/** A JSON file the UI saves (the member audit's report). */
export const jsonMediaType = "application/json;charset=utf-8";

/** A file the UI saves: the real Writer makes a Blob URL and clicks a hidden link; the fixture records it. Then the
 * UI toasts `Downloaded <n> row(s)`. */
export type DownloadFile = {
	name: string;
	type: typeof csvMediaType | typeof jsonMediaType;
	text: string;
};

/** A column: its header, and its value for a row. `money` values are minor units, written with two decimals and a
 * `-` sign; `number` values are written with two decimals; `text` values are written as they are, guarded. */
export type CsvColumn<Row> = {
	header: string;
	kind: "text" | "money" | "number";
	value: (row: Row) => string | number | null;
};

const formulaStart = /^[=+\-@\t\r]/;
const needsQuotes = /[",\r\n]/;

const minorUnits = (value: number): string => {
	const sign = value < 0 ? "-" : "";
	const absolute = Math.abs(Math.round(value));
	return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
};

/** One cell: numbers per the column's kind (never guarded); text with a leading `'` when it starts with `=`, `+`,
 * `-`, `@`, a tab or a carriage return (formula injection); quoted, with quotes doubled, when it holds a quote, a
 * comma or a line end (RFC 4180). An empty or null value is empty. */
export const csvCell = (
	value: string | number | null,
	kind: CsvColumn<unknown>["kind"],
): string => {
	if (typeof value === "number" && kind === "money") return minorUnits(value);
	if (typeof value === "number" && kind === "number") return value.toFixed(2);
	let text = value === null ? "" : String(value);
	if (kind === "text" && formulaStart.test(text)) text = `'${text}`;
	return needsQuotes.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** The file's text: a UTF-8 byte order mark, the header line, one line per row, every line ended by CRLF. */
export const toCsv = <Row>(
	columns: ReadonlyArray<CsvColumn<Row>>,
	rows: ReadonlyArray<Row>,
): string =>
	`﻿${[
		columns.map((column) => csvCell(column.header, "text")),
		...rows.map((row) =>
			columns.map((column) => csvCell(column.value(row), column.kind)),
		),
	]
		.map((cells) => `${cells.join(",")}\r\n`)
		.join("")}`;

/** The portal's payment history (S6) and the member drawer's Payments: one row per invoice or payment. */
export type HistoryCsvRow = {
	date: string;
	/** The family member the row is for; the column is written only for a guardian's family export. */
	member: string;
	description: string;
	amountCents: number | null;
	currency: string;
	status: string;
	invoiceId: string;
	paymentId: string;
};

export const historyColumns = (
	withMember: boolean,
): Array<CsvColumn<HistoryCsvRow>> => [
	{ header: "date", kind: "text", value: (row) => row.date },
	...(withMember
		? [
				{
					header: "member",
					kind: "text",
					value: (row: HistoryCsvRow) => row.member,
				} as const,
			]
		: []),
	{ header: "description", kind: "text", value: (row) => row.description },
	{ header: "amount", kind: "money", value: (row) => row.amountCents },
	{ header: "currency", kind: "text", value: (row) => row.currency },
	{ header: "status", kind: "text", value: (row) => row.status },
	{ header: "invoice_id", kind: "text", value: (row) => row.invoiceId },
	{ header: "payment_id", kind: "text", value: (row) => row.paymentId },
];

/** The Ledger's rows in the order the table shows them, pending first: `status` is `Pending` or `Posted`, `member`
 * the shown id or `—`, `invoice_id` empty, `credits` with two decimals (mockup `kLedgerCsv`). */
export const ledgerColumns = (
	currency: string,
): Array<CsvColumn<LedgerEntry>> => [
	{ header: "date", kind: "text", value: (entry) => entry.event.date },
	{
		header: "member",
		kind: "text",
		value: (entry) => entry.member?.id ?? "—",
	},
	{ header: "description", kind: "text", value: (entry) => entry.event.text },
	{ header: "amount", kind: "money", value: (entry) => entry.amountCents },
	{ header: "currency", kind: "text", value: () => currency },
	{
		header: "status",
		kind: "text",
		value: (entry) => (entry.pending ? "Pending" : "Posted"),
	},
	{ header: "invoice_id", kind: "text", value: () => "" },
	{ header: "payment_id", kind: "text", value: (entry) => entry.paymentId },
	{ header: "event", kind: "text", value: (entry) => entry.event.event_type },
	{ header: "credits", kind: "number", value: (entry) => entry.credits },
];

/** The income statement's eight lines (mockup `kReportCsv`), in this order. */
export const statementLines: ReadonlyArray<
	readonly [string, keyof StatementAmounts]
> = [
	["Memberships", "memberships"],
	["Bookings and events", "bookings"],
	["Discounts given", "discounts"],
	["Income", "income"],
	["Refunds", "refunds"],
	["Stripe fees", "fees"],
	["Net", "net"],
	["Gift certificates sold (not income)", "giftsSold"],
];

export type StatementCsvRow = { line: string; amountCents: number | null };

export const statementColumns = (
	statement: Pick<IncomeStatement, "currency" | "from" | "to">,
): Array<CsvColumn<StatementCsvRow>> => [
	{ header: "line", kind: "text", value: (row) => row.line },
	{ header: "amount", kind: "money", value: (row) => row.amountCents },
	{ header: "currency", kind: "text", value: () => statement.currency },
	{ header: "period_from", kind: "text", value: () => statement.from },
	{ header: "period_to", kind: "text", value: () => statement.to },
];

/** Every row of the identified report, not only the 15 shown (mockup `kDonorsCsv`). */
export const donorsColumns = (currency: string): Array<CsvColumn<DonorRow>> => [
	{ header: "name", kind: "text", value: (row) => row.name },
	{
		header: "kind",
		kind: "text",
		value: (row) => (row.kind === "donor" ? "Donor" : "Member"),
	},
	{ header: "id", kind: "text", value: (row) => row.id },
	{ header: "fund", kind: "text", value: (row) => row.fund },
	{ header: "payments", kind: "text", value: (row) => row.payments },
	{ header: "total", kind: "money", value: (row) => row.totalCents },
	{ header: "currency", kind: "text", value: () => currency },
	{ header: "last_payment", kind: "text", value: (row) => row.lastPaymentOn },
];

/** File names (mockup `kName` and the export functions). */
export const csvFileNames = {
	ledger: (from: string, to: string): string => `ledger-${from}_${to}.csv`,
	statement: (from: string, to: string): string =>
		`income-statement-${from}_${to}.csv`,
	donors: (today: string): string => `donors-${today}.csv`,
	/** `invoices-<member>-<first date>-<last date>.csv`, the dates of the rows exported (the clock's today when
	 * there are none). */
	history: (
		memberId: string,
		dates: ReadonlyArray<string>,
		today: string,
	): string => {
		const sorted = [...dates].sort();
		return `invoices-${memberId}-${sorted[0] ?? today}-${sorted.at(-1) ?? today}.csv`;
	},
};

/** The toast after a download (mockup `kSave`). */
export const downloadedToast = (rows: number): string =>
	`Downloaded ${rows} row${rows === 1 ? "" : "s"}`;

// ---- The interfaces the Reader and the Writer extend

export interface LedgerReader {
	/** Finance and owner only (the UI shows the lock panel below and does not read). */
	ledger(query: LedgerQuery): Promise<LedgerPage>;
	/** Finance and owner only. */
	incomeStatement(query: IncomeStatementQuery): Promise<IncomeStatement>;
	/** Public, member and governance. */
	audienceReport(query: AudienceReportQuery): Promise<AudienceReport>;
	donors(query: DonorsQuery): Promise<DonorsReport>;
	promos(query: PromosQuery): Promise<PromoList>;
	/** The school's rules in force (every audience sees them, v2 "School policy: every audience sees it."). */
	schoolRules(
		school: string,
	): Promise<{ rules: SchoolRules; unit: CreditUnit }>;
}

export interface LedgerWriter {
	download(file: DownloadFile): Promise<void>;
	createPromo(request: CreatePromo): Promise<Promo>;
	disablePromo(request: DisablePromo): Promise<Promo>;
}
