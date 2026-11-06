/**
 * Read models for the admin UI, built from the event log and written next to it, all under `schools/<school>/views/`:
 * `months/YYYY-MM.json`, `members/<hash>.json`, `members/index.json` and `manifest.json`. `buildViews` is pure;
 * `writeViews` puts the objects through a `Store` and `readViewsFromStore` reads them back, verified. All three are the
 * Worker-safe side of atm (no `node:fs`, no `ajv`).
 *
 * A member's object name is a hash of the school and the holder key, never the key: an object listing (or a log line of
 * a path) does not carry a family id. The body holds the key, and `members/index.json` lists every member's object name
 * with its key and `lastEventAt`, so a reader opens one object for the list instead of listing the prefix and opening
 * every body. The bodies hold no names or emails.
 *
 * The month, member and index objects are content only: they hold nothing about the run (no `asOf`), so the same events
 * give the same bytes and a scheduled run rewrites only what changed. What the run was is in `manifest.json`: its `asOf`,
 * the events it read, and `objects`, the SHA-256 of the bytes of every object the run meant to leave (by object key).
 *
 * What the manifest does and does not promise. Object keys are stable: a run overwrites the same key in place (no
 * content-addressed keys, so there is nothing to collect). The manifest is written last, but that does not make it a
 * snapshot: while a run is in flight, or after one failed partway, objects are NEWER than the manifest; and when an older
 * run's writes land after a newer run's manifest (the stale check below cannot see a writer already past it), they are
 * OLDER than it. The manifest names what the objects should hold; it does not say they hold it. A reader checks:
 * `readViewsFromStore` hashes the bytes of each object it returns and answers `view-mismatch` for one that differs from
 * the manifest. A mismatch means a run is in flight or died; the reader retries or falls back, and the next complete run
 * (any `asOf` not older than the manifest's) rewrites the objects and so clears it.
 */
import {
	AlreadyExists,
	Conflict,
	NotFound,
	putOnce,
	replaceIfMatch,
	Stale,
	sha256Hex,
	utf8,
} from "../store/store.js";
import type { AtmEvent, Store } from "../types.js";
import { byText } from "./order.js";
import { MONEY_COMMODITY } from "./postings.js";
import {
	eventsAsOf,
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

/** Which events a run read: those up to `asOf`, as many as `eventCount`, the last by id `lastEventId` (null for none). */
export type GeneratedFrom = { lastEventId: string | null; eventCount: number };

export type Views = {
	school: string;
	asOf: string;
	generatedFrom: GeneratedFrom;
	months: Record<string, MonthView>;
	members: Record<string, MemberSummary>;
};

export type ViewsResult =
	| { ok: true; views: Views }
	| { ok: false; error: SummaryProblem };

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
 * The month and member views of a log as of `asOf`: of the events up to it (`eventsAsOf`: by `event_time`), so months,
 * members and `generatedFrom` all describe the same cut of the log. Months are every `YYYY-MM` those events' dates fall
 * in, ascending. Members are `membersOf`'s; a log that cannot be replayed gives the reason (`ok: false`), and no views.
 */
export const buildViews = (
	allEvents: readonly AtmEvent[],
	{ school, asOf, ...options }: { school: string; asOf: Date } & SummaryOptions,
): ViewsResult => {
	const events = eventsAsOf(allEvents, asOf);
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
	let lastEventId: string | null = null;
	for (const event of events)
		if (lastEventId === null || byText(lastEventId, event.id) < 0)
			lastEventId = event.id;
	return {
		ok: true,
		views: {
			school,
			asOf: isoInstant(asOf.getTime()),
			generatedFrom: { lastEventId, eventCount: events.length },
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

export const memberIndexKey = (school: string): string =>
	`schools/${school}/views/members/index.json`;

export const manifestKey = (school: string): string =>
	`schools/${school}/views/manifest.json`;

const SAVE_ATTEMPTS = 3;

type Saved = "created" | "replaced" | "unchanged";

const readCurrent = async (
	store: Store,
	key: string,
): Promise<Awaited<ReturnType<Store["get"]>> | null> => {
	try {
		return await store.get(key);
	} catch (error) {
		if (error instanceof NotFound) return null;
		throw error;
	}
};

const isRetryable = (error: unknown): boolean =>
	error instanceof Stale ||
	error instanceof Conflict ||
	error instanceof AlreadyExists;

/**
 * Writes the object only when its bytes would change (as `journalMonth` does on disk): "unchanged" when it already
 * holds them, "created" for a new key (create-only, so a racing writer that made other bytes is re-read, not
 * overwritten), "replaced" after a conditional put on the ETag just read (`replaceIfMatch`).
 */
const saveIfChanged = async (
	store: Store,
	key: string,
	text: string,
): Promise<Saved> => {
	const body = utf8(text);
	for (let attempt = 1; ; attempt += 1) {
		const current = await readCurrent(store, key);
		try {
			if (current === null) {
				await putOnce(store, key, body);
				return "created";
			}
			if (new TextDecoder().decode(current.body) === text) return "unchanged";
			await replaceIfMatch(store, key, body, current.etag);
			return "replaced";
		} catch (error) {
			if (!isRetryable(error) || attempt >= SAVE_ATTEMPTS) throw error;
		}
	}
};

/**
 * What a run records about itself, written last as `manifest.json`. It is the run's intent, checked by readers (see the
 * header): `objects` maps each object key the run produced (the months, the members and the member index, not the
 * manifest) to the hex SHA-256 of its bytes.
 */
export type ViewsManifest = {
	asOf: string;
	generatedFrom: GeneratedFrom;
	/** The size of `objects`. */
	objectCount: number;
	objects: Record<string, string>;
};

const storedAsOfMs = (current: { body: Uint8Array } | null): number | null => {
	if (current === null) return null;
	try {
		const { asOf } = JSON.parse(new TextDecoder().decode(current.body)) as {
			asOf?: unknown;
		};
		const ms = typeof asOf === "string" ? Date.parse(asOf) : Number.NaN;
		return Number.isNaN(ms) ? null : ms;
	} catch {
		return null;
	}
};

/** The stored manifest is from a later `asOf` than this run's: a newer run has already published, this one is stale. */
const isNewerThan = (current: { body: Uint8Array } | null, asOf: string) => {
	const stored = storedAsOfMs(current);
	return stored !== null && stored > Date.parse(asOf);
};

/**
 * Puts the manifest unless a newer one is stored: "stale" then, and the object stays. The ETag read here is the one the
 * conditional put sends, so a newer run that lands between the read and the put makes the put `Stale`; the loop reads
 * again and answers "stale".
 */
const saveManifest = async (
	store: Store,
	key: string,
	manifest: ViewsManifest,
): Promise<Saved | "stale"> => {
	const text = `${canonicalize(manifest)}\n`;
	const body = utf8(text);
	for (let attempt = 1; ; attempt += 1) {
		const current = await readCurrent(store, key);
		if (isNewerThan(current, manifest.asOf)) return "stale";
		try {
			if (current === null) {
				await putOnce(store, key, body);
				return "created";
			}
			if (new TextDecoder().decode(current.body) === text) return "unchanged";
			await replaceIfMatch(store, key, body, current.etag);
			return "replaced";
		} catch (error) {
			if (!isRetryable(error) || attempt >= SAVE_ATTEMPTS) throw error;
		}
	}
};

export type WriteViewsResult = {
	created: string[];
	replaced: string[];
	unchanged: string[];
	/** True when a manifest of a later `asOf` is stored: this run's manifest was not written (and usually nothing else was). */
	stale: boolean;
};

/**
 * Writes the views as canonical JSON (sorted keys, one line, trailing newline), so the same views are the same bytes and
 * a second run writes nothing:
 *
 * 1. If the stored `manifest.json` has a later `asOf` than `views.asOf`, returns `stale: true` and writes nothing (an
 *    older run must not put older numbers over a newer run's).
 * 2. Each month and member object and `members/index.json` (changed ones only; none holds `asOf`), in place under the
 *    same keys. Nothing is rolled back: a run that fails here leaves the objects it already wrote under the OLD manifest.
 * 3. `manifest.json` last, conditionally on the ETag read just before (`putIfMatch`), and only if it differs; a newer
 *    manifest that landed since step 1 wins (`stale: true`, though step 2 has by then written this run's objects over
 *    that newer run's). Its `objects` hold the hash of every object's bytes, which is what `readViewsFromStore` verifies.
 *
 * So the manifest is not a snapshot: objects can be newer or older than it, and only a reader that verifies sees which.
 *
 * Month and member objects of an earlier run that the log no longer produces are left alone.
 */
export const writeViews = async (
	store: Store,
	school: string,
	views: Views,
): Promise<WriteViewsResult> => {
	const result: WriteViewsResult = {
		created: [],
		replaced: [],
		unchanged: [],
		stale: false,
	};
	const manifestPath = manifestKey(school);
	if (isNewerThan(await readCurrent(store, manifestPath), views.asOf)) {
		result.stale = true;
		return result;
	}
	const memberNames = Object.entries(views.members).map(([key, summary]) => ({
		name: memberViewName(school, key),
		key,
		lastEventAt: summary.lastEventAt,
	}));
	const objects: [string, unknown][] = [
		...Object.entries(views.months).map(([month, view]): [string, unknown] => [
			monthViewKey(school, month),
			{ school, month, ...view },
		]),
		...Object.entries(views.members).map(
			([key, summary]): [string, unknown] => [
				memberViewKey(school, key),
				{ school, ...summary },
			],
		),
		[
			memberIndexKey(school),
			{ school, members: memberNames.sort((a, b) => byText(a.name, b.name)) },
		],
	];
	const texts = objects
		.map(([key, body]): [string, string] => [key, `${canonicalize(body)}\n`])
		.sort(([a], [b]) => byText(a, b));
	for (const [key, text] of texts) {
		const outcome = await saveIfChanged(store, key, text);
		result[outcome].push(key);
	}
	const outcome = await saveManifest(store, manifestPath, {
		asOf: views.asOf,
		generatedFrom: views.generatedFrom,
		objectCount: texts.length,
		objects: Object.fromEntries(
			texts.map(([key, text]) => [key, sha256Hex(utf8(text))]),
		),
	});
	if (outcome === "stale") result.stale = true;
	else result[outcome].push(manifestPath);
	return result;
};

/** The member index object: every member's object name, key and `lastEventAt`. */
export type MemberIndexObject = {
	school: string;
	members: {
		name: string;
		key: string;
		lastEventAt: MemberSummary["lastEventAt"];
	}[];
};

/** A month object: the month's `MonthView` with the school and the `YYYY-MM`. */
export type MonthObject = { school: string; month: string } & MonthView;

/** A member object: the member's `MemberSummary` with the school. */
export type MemberObject = { school: string } & MemberSummary;

/**
 * Why a read of the views gave no value. Values, not throws, so the UI decides: `view-mismatch` (the object's bytes are
 * not the ones the manifest names, or the object is gone: a run is in flight or died) is a retry or a fall back to the
 * log; `not-in-manifest` (no such month or member in the generation) is a plain not-found; `no-manifest` means no run
 * has published; `bad-manifest` is a manifest this code cannot read (an older format).
 */
export type ViewReadError =
	| { ok: false; error: "no-manifest" }
	| { ok: false; error: "bad-manifest" }
	| { ok: false; error: "view-mismatch"; key: string }
	| { ok: false; error: "not-in-manifest"; key: string };

export type ViewRead<Value> = { ok: true; value: Value } | ViewReadError;

/** An open generation of the views: the manifest read, and readers of its objects that verify what they return. */
export type ViewsReader = {
	ok: true;
	school: string;
	manifest: ViewsManifest;
	membersIndex: () => Promise<ViewRead<MemberIndexObject>>;
	/** The member whose holder key is `key` (for example `family:fam_x`). */
	member: (key: string) => Promise<ViewRead<MemberObject>>;
	/** The month `YYYY-MM`. */
	month: (month: string) => Promise<ViewRead<MonthObject>>;
};

const isManifest = (value: unknown): value is ViewsManifest => {
	if (typeof value !== "object" || value === null) return false;
	const { asOf, generatedFrom, objectCount, objects } = value as Record<
		string,
		unknown
	>;
	return (
		typeof asOf === "string" &&
		typeof generatedFrom === "object" &&
		generatedFrom !== null &&
		typeof objectCount === "number" &&
		typeof objects === "object" &&
		objects !== null &&
		Object.values(objects).every((hash) => typeof hash === "string")
	);
};

const parseManifest = (body: Uint8Array): ViewsManifest | null => {
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
		return isManifest(parsed) ? parsed : null;
	} catch {
		return null;
	}
};

/**
 * Opens the school's published views: reads `manifest.json`, and hands back readers for the members index, a member and
 * a month. Each reader gets the object's bytes once, compares their SHA-256 with the one the manifest lists for that
 * key, and parses those same bytes: an object that differs gives `{ ok: false, error: "view-mismatch", key }`. Objects are
 * overwritten in place by `writeViews`, so a mismatch is expected while a run is in flight; see the header for what the
 * manifest does and does not promise. Store failures other than a missing object throw.
 */
export const readViewsFromStore = async (
	store: Store,
	school: string,
): Promise<ViewsReader | ViewReadError> => {
	const stored = await readCurrent(store, manifestKey(school));
	if (stored === null) return { ok: false, error: "no-manifest" };
	const manifest = parseManifest(stored.body);
	if (manifest === null) return { ok: false, error: "bad-manifest" };
	const verified = async <Value>(key: string): Promise<ViewRead<Value>> => {
		const expected = Object.hasOwn(manifest.objects, key)
			? manifest.objects[key]
			: undefined;
		if (expected === undefined)
			return { ok: false, error: "not-in-manifest", key };
		const current = await readCurrent(store, key);
		if (current === null || sha256Hex(current.body) !== expected)
			return { ok: false, error: "view-mismatch", key };
		return {
			ok: true,
			value: JSON.parse(new TextDecoder().decode(current.body)) as Value,
		};
	};
	return {
		ok: true,
		school,
		manifest,
		membersIndex: () => verified<MemberIndexObject>(memberIndexKey(school)),
		member: (key) => verified<MemberObject>(memberViewKey(school, key)),
		month: (month) => verified<MonthObject>(monthViewKey(school, month)),
	};
};
