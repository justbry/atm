/**
 * Reads a school's event log through a `Store` (R2 in a Cloudflare Worker, a folder in tests). The Worker-safe twin of
 * `readEvents` in `files.ts`: no `node:fs`, no `node:path`, and no runtime import but `order.ts` (which imports nothing),
 * so a bundle that pulls in this file pulls in nothing else.
 */
import type { AtmEvent, Store } from "../types.js";
import { byEventId, byText } from "./order.js";

/** An inclusive range of event dates (`YYYY-MM-DD`, the `date=` partition, which is the school's local day). */
export type EventDateRange = { from?: string; to?: string };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SCHOOL_PATTERN = /^[0-9A-Za-z_-]+$/;
/** What follows the school's events prefix in an event object key: the day's `date=` segment and the batch file name directly under it, nothing deeper (as `listEventFiles` in files.ts reads). */
const EVENT_KEY_TAIL_PATTERN = /^date=(\d{4}-\d{2}-\d{2})\/([^/]+)$/;
const COMBINED_DAY_NAME = "day.jsonl";
const LATE_PREFIX = "late-";
/** Batch objects fetched at once: a Worker's open subrequests are limited, and the order of results does not depend on it. */
const FETCH_CONCURRENCY = 8;

/** Every key under `prefix`, page after page: the store may truncate, and `next` is the cursor for the rest. */
const listAllKeys = async (store: Store, prefix: string): Promise<string[]> => {
	const keys: string[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await store.list({ prefix, cursor });
		for (const object of page.objects) keys.push(object.key);
		if (page.next === null) return keys;
		if (page.next === cursor)
			throw new Error(`listing ${prefix} returned the cursor it was given`);
		cursor = page.next;
	}
};

const checkDate = (name: string, value: string | undefined): void => {
	if (value !== undefined && !DATE_PATTERN.test(value))
		throw new Error(`${name} ${JSON.stringify(value)} is not YYYY-MM-DD`);
};

/**
 * The event object keys to read, in read order, from every key listed under the school's events prefix. Groups the keys by
 * day (the `date=` segment), keeps the days in `range`, and applies the same rule as `listEventFiles` (files.ts) to each
 * day: a day that has a `day.jsonl` is that file plus its `late-*` batches (the batches it combined are not read twice);
 * otherwise it is every `.jsonl` batch.
 */
const eventKeysIn = (
	keys: readonly string[],
	prefix: string,
	range: EventDateRange,
): string[] => {
	const days = new Map<string, string[]>();
	for (const key of keys) {
		// anchored at the school's own prefix by `startsWith`, so no school id needs escaping into a pattern
		if (!key.startsWith(prefix)) continue;
		const match = EVENT_KEY_TAIL_PATTERN.exec(key.slice(prefix.length));
		if (match === null) continue;
		const date = match[1];
		const name = match[2];
		if (date === undefined || name === undefined || !name.endsWith(".jsonl"))
			continue;
		if (range.from !== undefined && date < range.from) continue;
		if (range.to !== undefined && date > range.to) continue;
		const names = days.get(date) ?? [];
		days.set(date, names);
		names.push(key);
	}
	const out: string[] = [];
	for (const date of [...days.keys()].sort(byText)) {
		const dayKeys = (days.get(date) ?? []).sort(byText);
		const combined = dayKeys.some((key) =>
			key.endsWith(`/${COMBINED_DAY_NAME}`),
		);
		for (const key of dayKeys) {
			const name = key.slice(key.lastIndexOf("/") + 1);
			if (
				combined &&
				name !== COMBINED_DAY_NAME &&
				!name.startsWith(LATE_PREFIX)
			)
				continue;
			out.push(key);
		}
	}
	return out;
};

const parseBatch = (key: string, text: string): AtmEvent[] => {
	const events: AtmEvent[] = [];
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		if (line.length === 0) continue;
		try {
			events.push(JSON.parse(line) as AtmEvent);
		} catch {
			throw new Error(`${key} line ${index + 1} is not JSON`);
		}
	}
	return events;
};

/** `map` over `items` with at most `limit` running at once; the results keep the order of `items`. */
const mapLimited = async <Item, Result>(
	items: readonly Item[],
	limit: number,
	map: (item: Item) => Promise<Result>,
): Promise<Result[]> => {
	const results: Result[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await map(items[index] as Item);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return results;
};

/**
 * The school's events under `schools/<school>/events/`, from the days in `range` (all days when absent). Ordered and
 * deduplicated exactly as `readEvents` (files.ts): sorted by id, and a second event with an `idem` already seen is
 * dropped (the first by id wins), so a batch shipped twice under two keys reads once. `from` and `to` are inclusive
 * `YYYY-MM-DD` days of the `date=` partition. Throws on a bad range or school, a batch that is not JSONL, or any
 * store error (a half-read log would give wrong balances, so nothing is returned for it).
 *
 * Subrequests: one paged flat listing of the school's events prefix (no listing per day, so a year of days costs the
 * listing pages, not 365 calls), then one get per batch, `FETCH_CONCURRENCY` at a time.
 *
 * A `range` reads a PARTIAL log. Feeding it to `membersOf` or `buildViews` replays only those days: a member whose
 * grants were booked before `range.from` has a replay gap or wrong balances. Use a `range` for the month views of the
 * log, never for balances. (`membersOf` cannot detect that the log starts late, so it does not try.)
 */
export const readEventsFromStore = async (
	store: Store,
	school: string,
	range: EventDateRange = {},
): Promise<AtmEvent[]> => {
	if (!SCHOOL_PATTERN.test(school))
		throw new Error(`school ${JSON.stringify(school)} is not a plain id`);
	checkDate("range.from", range.from);
	checkDate("range.to", range.to);
	const prefix = `schools/${school}/events/`;
	const keys = await listAllKeys(store, prefix);
	const decoder = new TextDecoder();
	const batches = await mapLimited(
		eventKeysIn(keys, prefix, range),
		FETCH_CONCURRENCY,
		async (key) => parseBatch(key, decoder.decode((await store.get(key)).body)),
	);
	const events = batches.flat();
	events.sort(byEventId);
	const seen = new Set<string>();
	return events.filter((event) => {
		if (seen.has(event.idem)) return false;
		seen.add(event.idem);
		return true;
	});
};
