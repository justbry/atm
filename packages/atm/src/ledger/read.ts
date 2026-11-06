/**
 * Reads a school's event log through a `Store` (R2 in a Cloudflare Worker, a folder in tests). The Worker-safe twin of
 * `readEvents` in `files.ts`: no `node:fs`, no `node:path`, and no runtime import at all (only types), so a bundle that
 * pulls in this file pulls in nothing else.
 */
import type { AtmEvent, Store } from "../types.js";

/** An inclusive range of event dates (`YYYY-MM-DD`, the `date=` partition, which is the school's local day). */
export type EventDateRange = { from?: string; to?: string };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SCHOOL_PATTERN = /^[0-9A-Za-z_-]+$/;
const DAY_PREFIX_PATTERN = /\/date=(\d{4}-\d{2}-\d{2})\/$/;
const COMBINED_DAY_NAME = "day.jsonl";
const LATE_PREFIX = "late-";
/** Batch objects fetched at once: a Worker's open subrequests are limited, and the order of results does not depend on it. */
const FETCH_CONCURRENCY = 6;

/** Every page of a listing: the store may truncate, and `next` is the cursor for the rest. */
const listAll = async (
	store: Store,
	options: { prefix: string; delimiter?: string },
): Promise<{ keys: string[]; prefixes: string[] }> => {
	const keys: string[] = [];
	const prefixes: string[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await store.list({ ...options, cursor });
		for (const object of page.objects) keys.push(object.key);
		prefixes.push(...page.prefixes);
		if (page.next === null) return { keys, prefixes };
		if (page.next === cursor)
			throw new Error(
				`listing ${options.prefix} returned the cursor it was given`,
			);
		cursor = page.next;
	}
};

const checkDate = (name: string, value: string | undefined): void => {
	if (value !== undefined && !DATE_PATTERN.test(value))
		throw new Error(`${name} ${JSON.stringify(value)} is not YYYY-MM-DD`);
};

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The event object keys of one day, in read order. The same rule as `listEventFiles` (files.ts): a day that has a
 * `day.jsonl` is that file plus its `late-*` batches (the batches it combined are not read twice); otherwise it is
 * every `.jsonl` batch.
 */
const dayKeys = (prefix: string, keys: readonly string[]): string[] => {
	const names = keys
		.filter((key) => key.startsWith(prefix))
		.map((key) => key.slice(prefix.length))
		.filter((name) => name.endsWith(".jsonl") && !name.includes("/"))
		.sort(byText);
	const combined = names.includes(COMBINED_DAY_NAME);
	return names
		.filter(
			(name) =>
				!combined || name === COMBINED_DAY_NAME || name.startsWith(LATE_PREFIX),
		)
		.map((name) => `${prefix}${name}`);
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
	const base = `schools/${school}/events/`;
	const { prefixes } = await listAll(store, { prefix: base, delimiter: "/" });
	const days = prefixes
		.flatMap((prefix) => {
			const date = DAY_PREFIX_PATTERN.exec(prefix)?.[1];
			if (date === undefined || !prefix.startsWith(base)) return [];
			if (range.from !== undefined && date < range.from) return [];
			if (range.to !== undefined && date > range.to) return [];
			return [{ date, prefix }];
		})
		.sort((a, b) => byText(a.date, b.date));
	const batchKeys: string[] = [];
	for (const { prefix } of days) {
		const { keys } = await listAll(store, { prefix });
		batchKeys.push(...dayKeys(prefix, keys));
	}
	const decoder = new TextDecoder();
	const batches = await mapLimited(batchKeys, FETCH_CONCURRENCY, async (key) =>
		parseBatch(key, decoder.decode((await store.get(key)).body)),
	);
	const events = batches.flat();
	events.sort((a, b) => byText(a.id, b.id));
	const seen = new Set<string>();
	return events.filter((event) => {
		if (seen.has(event.idem)) return false;
		seen.add(event.idem);
		return true;
	});
};
