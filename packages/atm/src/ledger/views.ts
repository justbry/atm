/**
 * Read models for the admin UI, built from the event log and written next to it:
 * `schools/<school>/views/months/YYYY-MM.json` and `schools/<school>/views/members/<hash>.json`. `buildViews` is pure;
 * `writeViews` puts the objects through a `Store`. Both are the Worker-safe side of atm (no `node:fs`, no `ajv`).
 *
 * A member's object name is a hash of the school and the holder key, never the key: an object listing (or a log line of
 * a path) does not carry a family id. The body holds the key, so a reader that lists the prefix can still show it.
 * The bodies hold no names or emails.
 */
import {
	Conflict,
	NotFound,
	putOnce,
	replaceIfMatch,
	Stale,
	sha256Hex,
	utf8,
} from "../store/store.js";
import type { AtmEvent, Store } from "../types.js";
import {
	type MemberSummary,
	membersOf,
	type SummaryOptions,
	type SummaryProblem,
} from "./summary.js";
import { canonicalize, decimalToUnits, isoInstant } from "./util.js";

/** What one month of the log held, by the events' `date` (the school's local day). */
export type MonthView = {
	/** Events by `event_type`. */
	counts: Record<string, number>;
	/** Dollars, in cents, from the USD postings of the month's payment events. Absent when the month has none. */
	money?: {
		/** Cash taken before fees: the credits to `income:billing:*` other than refunds. */
		grossCents: number;
		/** Cash given back: the postings to `income:billing:refunds`. */
		refundedCents: number;
		/** Stripe's fees: the postings to `expenses:billing:stripe-fees`. */
		feeCents: number;
		/** `grossCents - refundedCents - feeCents`. */
		netCents: number;
	};
	/** Units by credit commodity (`VISIT`), from the postings of the credit events; each is in whole credits. */
	credits: Record<
		string,
		{ granted: number; spent: number; forfeited: number; expired: number }
	>;
	/** Holders that booked credits in the month: a distinct `key` with a `credit.held`, `credit.released`, `credit.spent`, `credit.forfeited` or `credit.refunded` event. */
	activeHolders: number;
};

export type Views = {
	school: string;
	asOf: string;
	months: Record<string, MonthView>;
	members: Record<string, MemberSummary>;
};

export type ViewsResult =
	| { ok: true; views: Views }
	| { ok: false; error: SummaryProblem };

const MONEY_COMMODITY = "USD";
const MONEY_DECIMALS = 2;
const CREDIT_DECIMALS = 0;
const INCOME_PREFIX = "income:billing:";
const REFUNDS_ACCOUNT = "income:billing:refunds";
const FEES_ACCOUNT = "expenses:billing:stripe-fees";
const ACTIVITY_TYPES = new Set([
	"credit.held",
	"credit.released",
	"credit.spent",
	"credit.forfeited",
	"credit.refunded",
]);

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const sortedRecord = <Value>(record: Record<string, Value>) =>
	Object.fromEntries(Object.entries(record).sort(([a], [b]) => byText(a, b)));

const monthOf = (event: AtmEvent) => event.date.slice(0, 7);

type MonthAccumulator = {
	counts: Record<string, number>;
	grossCents: bigint;
	refundedCents: bigint;
	feeCents: bigint;
	hasMoney: boolean;
	credits: MonthView["credits"];
	active: Set<string>;
};

const addPostings = (month: MonthAccumulator, event: AtmEvent): void => {
	for (const posting of event.postings) {
		if (posting.commodity === MONEY_COMMODITY) {
			const cents = decimalToUnits(posting.amount, MONEY_DECIMALS);
			if (posting.account === REFUNDS_ACCOUNT) {
				month.refundedCents += cents;
				month.hasMoney = true;
			} else if (posting.account.startsWith(INCOME_PREFIX)) {
				month.grossCents -= cents;
				month.hasMoney = true;
			} else if (posting.account === FEES_ACCOUNT) {
				month.feeCents += cents;
				month.hasMoney = true;
			}
			continue;
		}
		const units = Number(decimalToUnits(posting.amount, CREDIT_DECIMALS));
		const slot = month.credits[posting.commodity] ?? {
			granted: 0,
			spent: 0,
			forfeited: 0,
			expired: 0,
		};
		month.credits[posting.commodity] = slot;
		if (posting.account.startsWith("credits:issued:")) slot.granted -= units;
		else if (posting.account.startsWith("credits:spent:")) slot.spent += units;
		else if (posting.account === "credits:forfeited") slot.forfeited += units;
		else if (posting.account === "credits:expired") slot.expired += units;
	}
};

/**
 * The month and member views of a log as of `asOf`. Months are every `YYYY-MM` the events' dates fall in, ascending.
 * Members are `membersOf`'s; a log that cannot be replayed gives the reason (`ok: false`), and no views.
 */
export const buildViews = (
	events: readonly AtmEvent[],
	{ school, asOf, ...options }: { school: string; asOf: Date } & SummaryOptions,
): ViewsResult => {
	const members = membersOf(events, asOf, options);
	if (!members.ok) return members;
	const months = new Map<string, MonthAccumulator>();
	for (const event of events) {
		const month = monthOf(event);
		let accumulator = months.get(month);
		if (!accumulator) {
			accumulator = {
				counts: {},
				grossCents: 0n,
				refundedCents: 0n,
				feeCents: 0n,
				hasMoney: false,
				credits: {},
				active: new Set(),
			};
			months.set(month, accumulator);
		}
		accumulator.counts[event.event_type] =
			(accumulator.counts[event.event_type] ?? 0) + 1;
		addPostings(accumulator, event);
		if (ACTIVITY_TYPES.has(event.event_type)) accumulator.active.add(event.key);
	}
	return {
		ok: true,
		views: {
			school,
			asOf: isoInstant(asOf.getTime()),
			months: sortedRecord(
				Object.fromEntries(
					[...months].map(([month, accumulator]) => {
						const netCents =
							accumulator.grossCents -
							accumulator.refundedCents -
							accumulator.feeCents;
						const view: MonthView = {
							counts: sortedRecord(accumulator.counts),
							...(accumulator.hasMoney
								? {
										money: {
											grossCents: Number(accumulator.grossCents),
											refundedCents: Number(accumulator.refundedCents),
											feeCents: Number(accumulator.feeCents),
											netCents: Number(netCents),
										},
									}
								: {}),
							credits: sortedRecord(accumulator.credits),
							activeHolders: accumulator.active.size,
						};
						return [month, view];
					}),
				),
			),
			members: members.members,
		},
	};
};

/**
 * The object name segment of a member: the hex SHA-256 of `<school>\0<key>`. A Worker computes the same with
 * `crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${school}\u0000${key}`))`.
 */
export const memberViewName = (school: string, key: string): string =>
	sha256Hex(utf8(`${school}\u0000${key}`));

export const memberViewKey = (school: string, key: string): string =>
	`schools/${school}/views/members/${memberViewName(school, key)}.json`;

export const monthViewKey = (school: string, month: string): string =>
	`schools/${school}/views/months/${month}.json`;

const SAVE_ATTEMPTS = 3;

/**
 * Writes the object only when its bytes would change (as `journalMonth` does on disk): "unchanged" when it already
 * holds them, "created" for a new key (create-only, so a racing writer that made other bytes is re-read, not
 * overwritten), "replaced" after a conditional put on the ETag just read (`replaceIfMatch`).
 */
const saveIfChanged = async (
	store: Store,
	key: string,
	text: string,
): Promise<"created" | "replaced" | "unchanged"> => {
	const body = utf8(text);
	for (let attempt = 1; ; attempt += 1) {
		let current: Awaited<ReturnType<Store["get"]>> | null = null;
		try {
			current = await store.get(key);
		} catch (error) {
			if (!(error instanceof NotFound)) throw error;
		}
		try {
			if (current === null) {
				await putOnce(store, key, body);
				return "created";
			}
			if (new TextDecoder().decode(current.body) === text) return "unchanged";
			await replaceIfMatch(store, key, body, current.etag);
			return "replaced";
		} catch (error) {
			const retryable = error instanceof Stale || error instanceof Conflict;
			if (!retryable || attempt >= SAVE_ATTEMPTS) throw error;
		}
	}
};

export type WriteViewsResult = {
	created: string[];
	replaced: string[];
	unchanged: string[];
};

/**
 * `schools/<school>/views/months/YYYY-MM.json` for each month and `schools/<school>/views/members/<hash>.json` for each
 * member, as canonical JSON (sorted keys, one line, trailing newline), so the same views are the same bytes and a second
 * run writes nothing. Month and member objects of an earlier run that the log no longer produces are left alone.
 */
export const writeViews = async (
	store: Store,
	school: string,
	views: Views,
): Promise<WriteViewsResult> => {
	const result: WriteViewsResult = { created: [], replaced: [], unchanged: [] };
	const objects: [string, unknown][] = [
		...Object.entries(views.months).map(([month, view]): [string, unknown] => [
			monthViewKey(school, month),
			{ school, asOf: views.asOf, month, ...view },
		]),
		...Object.entries(views.members).map(
			([key, summary]): [string, unknown] => [
				memberViewKey(school, key),
				{ school, asOf: views.asOf, ...summary },
			],
		),
	];
	for (const [key, body] of objects.sort(([a], [b]) => byText(a, b))) {
		const outcome = await saveIfChanged(store, key, `${canonicalize(body)}\n`);
		result[outcome].push(key);
	}
	return result;
};
