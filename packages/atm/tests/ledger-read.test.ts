import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import { readEventsFromStore } from "../src/ledger/read.js";
import { FolderStore } from "../src/store/folder-store.js";
import type {
	AtmEvent,
	ListOptions,
	ListPage,
	Store,
	StoreGet,
} from "../src/types.js";

const FIXTURES = join(import.meta.dir, "../fixtures");
const SCHOOLS = [
	{ dir: "vibes-year", school: "sch_vol" },
	{ dir: "vibes-multi", school: "sch_multi" },
];

describe("readEventsFromStore over a folder", () => {
	for (const { dir, school } of SCHOOLS) {
		test(`${dir}: the same events, in the same order, as readEvents`, async () => {
			const root = join(FIXTURES, dir);
			const onDisk = await readEvents(root, school);
			const fromStore = await readEventsFromStore(
				new FolderStore({ root }),
				school,
			);
			expect(onDisk.events.length).toBeGreaterThan(10);
			expect(fromStore).toEqual(onDisk.events);
		});
	}

	test("an unknown school has no events", async () => {
		const store = new FolderStore({ root: join(FIXTURES, "vibes-year") });
		expect(await readEventsFromStore(store, "sch_none")).toEqual([]);
	});
});

/** A store of in-memory objects whose listing truncates at `pageSize`, to prove the reader follows the cursor. */
const memoryStore = (pageSize: number) => {
	const objects = new Map<string, string>();
	const gets: string[] = [];
	const lists: ListOptions[] = [];
	const unsupported = () => {
		throw new Error("not used by the reader");
	};
	const store: Store = {
		putIfAbsent: unsupported,
		putIfMatch: unsupported,
		head: unsupported,
		delete: unsupported,
		presign: unsupported,
		async get(key) {
			gets.push(key);
			const text = objects.get(key);
			if (text === undefined) throw new Error(`no ${key}`);
			return { key, body: new TextEncoder().encode(text) } as StoreGet;
		},
		async list(options = {}): Promise<ListPage> {
			lists.push(options);
			const prefix = options.prefix ?? "";
			const entries: { key: string; prefix: boolean }[] = [];
			for (const key of [...objects.keys()].sort()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				const at = options.delimiter ? rest.indexOf(options.delimiter) : -1;
				const entry =
					at >= 0
						? { key: `${prefix}${rest.slice(0, at + 1)}`, prefix: true }
						: { key, prefix: false };
				if (!entries.some((e) => e.key === entry.key)) entries.push(entry);
			}
			const start = options.cursor ? Number(options.cursor) : 0;
			const page = entries.slice(start, start + pageSize);
			const end = start + pageSize;
			return {
				objects: page
					.filter((e) => !e.prefix)
					.map((e) => ({ key: e.key, size: 0, etag: "" })),
				prefixes: page.filter((e) => e.prefix).map((e) => e.key),
				next: end < entries.length ? String(end) : null,
			};
		},
	};
	return { store, objects, gets, lists };
};

const sampleEvents = async (): Promise<AtmEvent[]> =>
	(await readEvents(join(FIXTURES, "vibes-year"), "sch_vol")).events.slice(
		0,
		40,
	);

const lineOf = (event: AtmEvent) => JSON.stringify(event);
const batchKey = (school: string, date: string, name: string) =>
	`schools/${school}/events/date=${date}/${name}.jsonl`;

describe("readEventsFromStore over an in-memory store", () => {
	test("filters by the date partition, inclusive, across truncated listings", async () => {
		const events = await sampleEvents();
		const { store, objects, lists } = memoryStore(2);
		const days = [...new Set(events.map((e) => e.date))].sort();
		expect(days.length).toBeGreaterThan(4);
		for (const date of days)
			objects.set(
				batchKey("sch_x", date, `batch-${date}`),
				`${events
					.filter((e) => e.date === date)
					.map(lineOf)
					.join("\n")}\n`,
			);
		const from = days[1] as string;
		const to = days[3] as string;
		const got = await readEventsFromStore(store, "sch_x", { from, to });
		const expected = events.filter((e) => e.date >= from && e.date <= to);
		expect(expected.length).toBeGreaterThan(0);
		expect(got).toEqual(expected);
		expect(lists.some((o) => o.cursor !== undefined)).toBe(true);
		expect((await readEventsFromStore(store, "sch_x")).length).toBe(
			events.length,
		);
		expect(
			await readEventsFromStore(store, "sch_x", { from: "2999-01-01" }),
		).toEqual([]);
	});

	test("a batch shipped twice under two keys reads once, and ids order the result", async () => {
		const events = await sampleEvents();
		const day = events.filter((e) => e.date === events[0]?.date);
		expect(day.length).toBeGreaterThan(1);
		const { store, objects } = memoryStore(100);
		const date = day[0]?.date as string;
		const text = `${day.map(lineOf).join("\n")}\n`;
		objects.set(batchKey("sch_x", date, "batch-b"), text);
		objects.set(
			batchKey("sch_x", date, "batch-a"),
			`${[...day].reverse().map(lineOf).join("\n")}\n`,
		);
		const got = await readEventsFromStore(store, "sch_x");
		expect(got).toEqual(day);
	});

	test("beside a day.jsonl only the late-* batches are read, as the disk reader does", async () => {
		const events = await sampleEvents();
		const date = events[0]?.date as string;
		const [first, second, third] = events.filter((e) => e.date === date);
		expect(third).toBeDefined();
		const { store, objects, gets } = memoryStore(100);
		objects.set(
			batchKey("sch_x", date, "day"),
			`${lineOf(first as AtmEvent)}\n`,
		);
		objects.set(
			batchKey("sch_x", date, "batch-combined"),
			`${lineOf(second as AtmEvent)}\n`,
		);
		objects.set(
			batchKey("sch_x", date, "late-1"),
			`${lineOf(third as AtmEvent)}\n`,
		);
		objects.set("schools/sch_x/events/date=2020-01-01/notes.txt", "x");
		const got = await readEventsFromStore(store, "sch_x");
		expect(got.map((e) => e.id)).toEqual(
			[first, third].map((e) => (e as AtmEvent).id),
		);
		expect(gets).not.toContain(batchKey("sch_x", date, "batch-combined"));
	});

	test("a key nested deeper than date=D/<file>, or under another prefix, is ignored, as the disk reader ignores it", async () => {
		const events = await sampleEvents();
		const [first, second, third] = events;
		const date = (first as AtmEvent).date;
		const { store, objects, gets } = memoryStore(100);
		objects.set(
			batchKey("sch_x", date, "batch-a"),
			`${lineOf(first as AtmEvent)}\n`,
		);
		const nested = `schools/sch_x/events/archive/date=${date}/batch-nested.jsonl`;
		const deeper = `schools/sch_x/events/date=${date}/sub/batch-deeper.jsonl`;
		const otherSchool = `schools/sch_x/events/other/schools/sch_y/events/date=${date}/batch-other.jsonl`;
		objects.set(nested, `${lineOf(second as AtmEvent)}\n`);
		objects.set(deeper, `${lineOf(third as AtmEvent)}\n`);
		objects.set(otherSchool, `${lineOf(third as AtmEvent)}\n`);
		const got = await readEventsFromStore(store, "sch_x");
		expect(got.map((e) => e.id)).toEqual([(first as AtmEvent).id]);
		expect(gets).not.toContain(nested);
		expect(gets).not.toContain(deeper);
		expect(gets).not.toContain(otherSchool);
	});

	test("refuses a bad range, a school with a slash, and a batch that is not JSONL", async () => {
		const { store, objects } = memoryStore(10);
		await expect(
			readEventsFromStore(store, "sch_x", { from: "2026-1-1" }),
		).rejects.toThrow(/YYYY-MM-DD/);
		await expect(readEventsFromStore(store, "sch_x/../sch_y")).rejects.toThrow(
			/plain id/,
		);
		objects.set(batchKey("sch_x", "2026-01-01", "batch-bad"), "{}\nnot json\n");
		await expect(readEventsFromStore(store, "sch_x")).rejects.toThrow(
			/batch-bad.jsonl line 2 is not JSON/,
		);
	});
});

describe("readEventsFromStore subrequests", () => {
	const fillDays = async (objects: Map<string, string>, count: number) => {
		const events = (
			await readEvents(join(FIXTURES, "vibes-year"), "sch_vol")
		).events.slice(0, count);
		for (const [index, event] of events.entries())
			objects.set(
				batchKey(
					"sch_x",
					event.date,
					`batch-${String(index).padStart(3, "0")}`,
				),
				`${lineOf(event)}\n`,
			);
		return events;
	};

	test("one flat paged listing of the events prefix, whatever the range: no listing per day", async () => {
		const { store, objects, lists } = memoryStore(5);
		const events = await fillDays(objects, 60);
		const days = new Set(events.map((e) => e.date));
		expect(days.size).toBeGreaterThan(8);
		const from = [...days].sort()[2] as string;
		await readEventsFromStore(store, "sch_x", { from });
		expect(lists.every((o) => o.prefix === "schools/sch_x/events/")).toBe(true);
		expect(lists.every((o) => o.delimiter === undefined)).toBe(true);
		// 60 objects, 5 to a page: 12 pages, not 12 plus one per day
		expect(lists.length).toBe(12);
	});

	test("batches are fetched at most 8 at a time, and more than one at a time", async () => {
		const { store, objects } = memoryStore(1000);
		await fillDays(objects, 40);
		let open = 0;
		let peak = 0;
		const slow: Store = {
			...store,
			async get(key) {
				open += 1;
				peak = Math.max(peak, open);
				await new Promise((resolve) => setTimeout(resolve, 2));
				try {
					return await store.get(key);
				} finally {
					open -= 1;
				}
			},
		};
		const got = await readEventsFromStore(slow, "sch_x");
		expect(got.length).toBe(40);
		expect(peak).toBe(8);
	});

	test("a range reads only the batches of its days", async () => {
		const { store, objects, gets } = memoryStore(1000);
		const events = await fillDays(objects, 40);
		const days = [...new Set(events.map((e) => e.date))].sort();
		const day = days[3] as string;
		await readEventsFromStore(store, "sch_x", { from: day, to: day });
		expect(gets.length).toBeGreaterThan(0);
		for (const key of gets) expect(key).toContain(`/date=${day}/`);
	});
});
