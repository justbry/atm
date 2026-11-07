/**
 * The ledger's rows: a pure function from a school's events to the rows a ledger table shows, newest first, in pages with
 * a stable cursor. It is the whole of the read side of the ledger tab except the names, which are not its job: a row
 * carries the holder's key and the adapter joins the name from the members list by that key.
 *
 * A row never carries a personal field. The event in it is the event with its `redacted` payload (or, with none, its
 * payload less the `x-personal` fields the payment schemas name: `billing_email`, `billing_name`).
 *
 * Worker-safe: no `node:fs`, no Ajv, no hledger. `Intl` gives the school's local time.
 */
import type { AtmEvent } from "../types.js";
import { byText } from "./order.js";
import { MONEY_COMMODITY } from "./postings.js";
import { decimalToUnits } from "./util.js";

const MONEY_DECIMALS = 2;
const CREDIT_DECIMALS = 0;
const AVAILABLE_PREFIX = "credits:avail:";
const HELD_PREFIX = "credits:held:";
const BILLING_INCOME = "income:billing:";
const FAMILY_KEY = /^family:/;
/** Events about the school's money or settings, not a member's, whatever key they were written under. */
const NO_MEMBER_TYPES: ReadonlySet<string> = new Set([
	"payout.paid",
	"fundraise.received",
	"fundraise.paid_out",
	"catalog.published",
	"policy.published",
	"share.charged",
	"share.accrued",
	"share.reversed",
	"share.settled",
	"money.skipped",
]);
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const CURSOR_SEPARATOR = "|";
const PERSONAL_FIELDS = ["billing_email", "billing_name"] as const;

/** The type chips: `payment`, `credit` and `payout` match the event type's prefix; `booking` and `code` a label; `admin` the source. */
export type LedgerTypeFilter =
	| "payment"
	| "credit"
	| "booking"
	| "code"
	| "payout"
	| "admin";

/** A drill-down from the reports: the statement line whose events the ledger lists. */
export type LedgerDrill =
	| "income"
	| "memb"
	| "book"
	| "disc"
	| "refund"
	| "fees"
	| "payout"
	| "gift";

export type LedgerRowFilter = {
	/** `YYYY-MM-DD`, the school's local day, inclusive. */
	from: string;
	to: string;
	type?: LedgerTypeFilter | null;
	drill?: LedgerDrill | null;
	/** A promo id: the events labelled `code` with it. */
	promo?: string | null;
};

/** An event as a row carries it: without `redacted`, and its payload without a personal field. */
export type LedgerRowEvent = Omit<AtmEvent, "redacted">;

export type LedgerRow = {
	event: LedgerRowEvent;
	/** `event_time` as the school's local wall time, `YYYY-MM-DDTHH:MM`. */
	localTime: string;
	/** The holder, `family:<id>`, to join the name by; null for an event about no member (a payout, a Zeffy gift, a catalog, the school's share). */
	holderKey: string | null;
	/**
	 * Signed whole credits the event moves for the holder: the postings to the holder's available credits (a grant is `+24`,
	 * a hold `-1`, a release `+1`, an expiry `-n`), and for a spend or a forfeit the units taken off the held credits
	 * (`-n`). Null when it moves none.
	 */
	credits: number | null;
	/**
	 * Signed cents: a payment is positive, a refund and a dispute negative, a payout positive (negative when it failed
	 * and came back), a Zeffy gift positive, a won dispute positive. Null for an event that moves no money.
	 */
	amountCents: number | null;
	/** The Stripe payment intent, else the invoice or payment id, of a payment or a refund; else null. */
	paymentId: string | null;
	/** The promo id in the event's `code` label. */
	promoId: string | null;
};

export type LedgerRowsPage = {
	rows: LedgerRow[];
	/** Pass it back as the cursor for the next page; null on the last page. */
	next: string | null;
	/** Every event matching the filter, whatever the page. */
	count: number;
};

const localParts = new Map<string, Intl.DateTimeFormat>();

const localTimeOf = (event: AtmEvent): string => {
	let format = localParts.get(event.tz);
	if (!format) {
		try {
			format = new Intl.DateTimeFormat("en-CA", {
				timeZone: event.tz,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hourCycle: "h23",
			});
		} catch {
			// a zone this runtime does not know: the event's own date and the UTC time of day
			return `${event.date}T${event.event_time.slice(11, 16)}`;
		}
		localParts.set(event.tz, format);
	}
	const parts = Object.fromEntries(
		format
			.formatToParts(new Date(event.event_time))
			.map((p) => [p.type, p.value]),
	);
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

const cents = (amount: string): number =>
	Number(decimalToUnits(amount, MONEY_DECIMALS));

const creditsOf = (event: AtmEvent): number | null => {
	const postings = event.postings.filter(
		(posting) => posting.commodity !== MONEY_COMMODITY,
	);
	if (postings.length === 0) return null;
	const sum = (prefix: string) =>
		postings
			.filter((posting) => posting.account.startsWith(prefix))
			.reduce(
				(total, posting) =>
					total + Number(decimalToUnits(posting.amount, CREDIT_DECIMALS)),
				0,
			);
	const moved =
		event.event_type === "credit.spent" ||
		event.event_type === "credit.forfeited"
			? sum(HELD_PREFIX)
			: sum(AVAILABLE_PREFIX);
	return moved === 0 ? null : moved;
};

const postedTo = (event: AtmEvent, account: string): number | null => {
	const posting = event.postings.find((p) => p.account === account);
	return posting ? cents(posting.amount) : null;
};

const amountOf = (event: AtmEvent): number | null => {
	switch (event.event_type) {
		case "payment.succeeded": {
			const income = event.postings.find((p) =>
				p.account.startsWith(BILLING_INCOME),
			);
			return income ? -cents(income.amount) : null;
		}
		case "payment.refunded": {
			const refunds = postedTo(event, "income:billing:refunds");
			return refunds === null ? null : -refunds;
		}
		case "payment.disputed": {
			const disputed = postedTo(event, "expenses:billing:disputes");
			return disputed === null ? null : -disputed;
		}
		case "dispute.closed": {
			const returned = postedTo(event, "assets:stripe");
			return returned;
		}
		case "payout.paid":
			return postedTo(event, "assets:clearing:stripe-payouts");
		case "fundraise.received":
			return postedTo(event, "assets:clearing:zeffy");
		default:
			return null;
	}
};

const textOf = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

const paymentIdOf = (event: AtmEvent): string | null =>
	event.event_type === "payment.succeeded" ||
	event.event_type === "payment.refunded"
		? (textOf(event.payload.payment_intent) ?? textOf(event.payload.id))
		: null;

/** The payload a row may carry: the redacted one, else the payload less the personal fields. */
const payloadOf = (event: AtmEvent): Record<string, unknown> => {
	if (event.redacted) return event.redacted;
	if (!PERSONAL_FIELDS.some((field) => field in event.payload))
		return event.payload;
	return Object.fromEntries(
		Object.entries(event.payload).filter(
			([name]) => !(PERSONAL_FIELDS as readonly string[]).includes(name),
		),
	);
};

/** The kind of a sale: the `kind` label when the writer set one, else what the income account says. */
const kindOf = (event: AtmEvent): string | null => {
	if (event.labels.kind !== undefined) return event.labels.kind;
	const income = event.postings.find((p) =>
		p.account.startsWith(BILLING_INCOME),
	);
	if (!income) return null;
	const tail = income.account.slice(BILLING_INCOME.length);
	if (tail.startsWith("membership:")) return "membership";
	return tail === "booking" ? "booking" : null;
};

const isSale = (event: AtmEvent) => event.event_type === "payment.succeeded";

const typeFilters: Record<LedgerTypeFilter, (event: AtmEvent) => boolean> = {
	payment: (event) => event.event_type.startsWith("payment"),
	credit: (event) => event.event_type.startsWith("credit"),
	booking: (event) => event.labels.booking !== undefined,
	code: (event) => event.labels.code !== undefined,
	payout: (event) => event.event_type.startsWith("payout"),
	admin: (event) => event.source === "admin",
};

/**
 * `disc` (discounts given) matches nothing: no atm event records a discount, so the question has no answer in the log
 * and an empty list is the honest one.
 */
const drillFilters: Record<LedgerDrill, (event: AtmEvent) => boolean> = {
	income: (event) => isSale(event) && kindOf(event) !== "gift",
	memb: (event) =>
		isSale(event) && (kindOf(event) ?? "membership") === "membership",
	book: (event) => isSale(event) && kindOf(event) === "booking",
	disc: () => false,
	refund: (event) => event.event_type === "payment.refunded",
	fees: isSale,
	payout: (event) => event.event_type === "payout.paid",
	gift: (event) => kindOf(event) === "gift",
};

type Keyed = { row: LedgerRow; order: string };

/** Newest first: the local time, then the event id (a ULID), both descending. */
const newestFirst = (a: Keyed, b: Keyed): number => byText(b.order, a.order);

const orderOf = (localTime: string, id: string): string =>
	`${localTime}${CURSOR_SEPARATOR}${id}`;

const rowOf = (event: AtmEvent): LedgerRow => {
	const { redacted: _redacted, ...rest } = event;
	return {
		event: { ...rest, payload: payloadOf(event) },
		localTime: localTimeOf(event),
		holderKey:
			FAMILY_KEY.test(event.key) && !NO_MEMBER_TYPES.has(event.event_type)
				? event.key
				: null,
		credits: creditsOf(event),
		amountCents: amountOf(event),
		paymentId: paymentIdOf(event),
		promoId: event.labels.code ?? null,
	};
};

const checkCursor = (cursor: string): void => {
	const at = cursor.indexOf(CURSOR_SEPARATOR);
	if (at <= 0 || at === cursor.length - 1)
		throw new Error(
			`cursor ${JSON.stringify(cursor)} is not one this function returned`,
		);
};

/**
 * The rows of `events` that match `filter`, newest first (local time, then event id), `limit` at a time. `cursor` is null
 * for the first page, else the `next` of the page before: the next page holds the rows strictly after the one it names,
 * so a page does not move when events are added, and a row is never listed twice or skipped. A `limit` is 1 to 1000
 * (default 100). `count` is every matching event, whatever the page.
 */
export const ledgerRows = (
	events: readonly AtmEvent[],
	filter: LedgerRowFilter,
	cursor: string | null = null,
	limit: number = DEFAULT_PAGE_SIZE,
): LedgerRowsPage => {
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
		throw new Error(
			`limit ${limit} is not a whole number from 1 to ${MAX_PAGE_SIZE}`,
		);
	if (cursor !== null) checkCursor(cursor);
	const matching: Keyed[] = [];
	for (const event of events) {
		if (event.date < filter.from || event.date > filter.to) continue;
		if (filter.type && !typeFilters[filter.type](event)) continue;
		if (filter.drill && !drillFilters[filter.drill](event)) continue;
		if (filter.promo && event.labels.code !== filter.promo) continue;
		const row = rowOf(event);
		matching.push({ row, order: orderOf(row.localTime, event.id) });
	}
	matching.sort(newestFirst);
	const start =
		cursor === null
			? 0
			: matching.findIndex((keyed) => byText(keyed.order, cursor) < 0);
	const rest = start < 0 ? [] : matching.slice(start);
	const page = rest.slice(0, limit);
	const last = page.at(-1);
	return {
		rows: page.map((keyed) => keyed.row),
		next: rest.length > limit && last ? last.order : null,
		count: matching.length,
	};
};
