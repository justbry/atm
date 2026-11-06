/**
 * `runViews`: read the events from a store, build the views as of `asOf`, write them. And what the objects it leaves may
 * and may not hold: every object is in the manifest and verifies, and none holds a name, an email or a billing field.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogPublishedEvent } from "../src/ledger/catalog.js";
import { readEvents } from "../src/ledger/files.js";
import { runViews } from "../src/ledger/run-views.js";
import {
	buildViews,
	manifestKey,
	readViewsFromStore,
} from "../src/ledger/views.js";
import { FolderStore } from "../src/store/folder-store.js";
import { putOnce, sha256Hex, utf8 } from "../src/store/store.js";
import type { AtmCatalogRow } from "../src/types.js";
import {
	handBuiltLog,
	catalog as handCatalog,
	menu as handMenu,
} from "./ledger-read-log.js";

const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const SCHOOL = "sch_vol";
const AS_OF = new Date("2026-12-28T17:00:00Z");

let root = "";
let store: FolderStore;
let catalog: AtmCatalogRow[];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "atm-run-views-"));
	await cp(FIXTURE, root, { recursive: true });
	store = new FolderStore({ root });
	catalog = JSON.parse(
		await readFile(join(FIXTURE, "catalog.json"), "utf8"),
	) as AtmCatalogRow[];
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const viewKeys = async (): Promise<string[]> => {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await store.list({
			prefix: `schools/${SCHOOL}/views/`,
			cursor,
		});
		keys.push(...page.objects.map((object) => object.key));
		cursor = page.next ?? undefined;
	} while (cursor !== undefined);
	return keys.sort();
};

describe("runViews", () => {
	test("reads, builds and writes what buildViews and writeViews would, with every object in the manifest", async () => {
		const run = await runViews(store, SCHOOL, AS_OF, { catalog });
		if (!run.ok) throw new Error(JSON.stringify(run.error));
		const { events } = await readEvents(FIXTURE, SCHOOL);
		const built = buildViews(events, { school: SCHOOL, asOf: AS_OF, catalog });
		if (!built.ok) throw new Error("the build failed");
		expect(run.eventCount).toBe(events.length);
		expect(run.views).toEqual(built.views);
		expect(run.written.stale).toBe(false);

		const keys = await viewKeys();
		const reader = await readViewsFromStore(store, SCHOOL);
		if (!reader.ok) throw new Error(JSON.stringify(reader));
		expect(keys).toEqual(
			[...Object.keys(reader.manifest.objects), manifestKey(SCHOOL)].sort(),
		);
		for (const key of Object.keys(reader.manifest.objects))
			expect(sha256Hex((await store.get(key)).body)).toBe(
				reader.manifest.objects[key] as string,
			);
		expect(keys.some((key) => key.includes("/views/finance/months/"))).toBe(
			true,
		);
		expect(keys.some((key) => key.includes("/views/finance/members/"))).toBe(
			true,
		);
		expect(keys.some((key) => key.includes("/views/kpi/contributions/"))).toBe(
			true,
		);
	});

	test("a second run with the same asOf writes nothing", async () => {
		await runViews(store, SCHOOL, AS_OF, { catalog });
		const again = await runViews(store, SCHOOL, AS_OF, { catalog });
		if (!again.ok) throw new Error(JSON.stringify(again.error));
		expect(again.written.created).toEqual([]);
		expect(again.written.replaced).toEqual([]);
		expect(again.written.unchanged.length).toBeGreaterThan(0);
	});

	test("a run older than the stored manifest is stale and changes nothing", async () => {
		await runViews(store, SCHOOL, AS_OF, { catalog });
		const manifest = await readFile(join(root, manifestKey(SCHOOL)), "utf8");
		const older = await runViews(
			store,
			SCHOOL,
			new Date("2026-06-01T00:00:00Z"),
			{ catalog },
		);
		if (!older.ok) throw new Error(JSON.stringify(older.error));
		expect(older.written.stale).toBe(true);
		expect(await readFile(join(root, manifestKey(SCHOOL)), "utf8")).toBe(
			manifest,
		);
	});

	test("a log that cannot be replayed gives the reason and writes nothing", async () => {
		const run = await runViews(store, SCHOOL, AS_OF);
		expect(run).toMatchObject({ ok: false, error: { kind: "no-catalog" } });
		expect(await viewKeys()).toEqual([]);
	});
});

describe("runViews on a log that records its own catalog", () => {
	test("the latest catalog.published event is the catalog, and the views equal those built with its rows", async () => {
		const { events } = handBuiltLog();
		const published = catalogPublishedEvent({
			school: "sch_hand",
			menu: handMenu,
			version: 1,
			eventTime: Date.UTC(2026, 0, 1),
		});
		const log = [published, ...events];
		await putOnce(
			store,
			"schools/sch_hand/events/date=2026-01-15/batch-1.jsonl",
			utf8(`${log.map((event) => JSON.stringify(event)).join("\n")}\n`),
		);
		const asOf = new Date("2026-03-01T00:00:00Z");
		const run = await runViews(store, "sch_hand", asOf);
		if (!run.ok) throw new Error(JSON.stringify(run.error));
		const built = buildViews(log, {
			school: "sch_hand",
			asOf,
			catalog: handCatalog,
		});
		if (!built.ok) throw new Error("the build failed");
		expect(run.eventCount).toBe(log.length);
		expect(run.views.members).toEqual(built.views.members);
		expect(run.views.finance).toEqual(built.views.finance);
		expect(Object.keys(run.views.members)).toContain("family:fam_hand");
	});
});

describe("no view object holds a name, an email or a billing field", () => {
	test("over the golden year, whose payments carry billing_email and billing_name", async () => {
		const { events } = await readEvents(FIXTURE, SCHOOL);
		const personal = new Set<string>();
		for (const event of events)
			for (const field of ["billing_email", "billing_name"] as const) {
				const value = event.payload[field];
				if (typeof value === "string" && value.length > 0) personal.add(value);
			}
		expect(personal.size).toBeGreaterThan(0);
		await runViews(store, SCHOOL, AS_OF, { catalog });
		const keys = await viewKeys();
		for (const key of keys) {
			const text = new TextDecoder().decode((await store.get(key)).body);
			for (const value of personal)
				expect(text, `${key} holds ${value}`).not.toContain(value);
			expect(text, key).not.toContain("billing_");
			expect(text, key).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
			// the Stripe customer id is a person's too: no object carries it
			expect(text, key).not.toContain("cus_");
		}
	});

	test("an object name never holds a family id", async () => {
		await runViews(store, SCHOOL, AS_OF, { catalog });
		for (const key of await viewKeys()) expect(key).not.toContain("fam_");
	});
});
