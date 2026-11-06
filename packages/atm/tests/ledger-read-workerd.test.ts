/**
 * Runs the read path inside workerd (Cloudflare's Worker runtime, through Miniflare) over an R2 bucket binding, the way
 * the admin UI will. A Worker bundled from `tests/worker-fixture/worker.ts` reads the `vibes-year` event log from R2,
 * summarizes its members, builds the views and writes them back; its answers must equal what Node computes from the same
 * folder. A second Worker without `nodejs_compat` records what the flag is for.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { readEvents } from "../src/ledger/files.js";
import { membersOf } from "../src/ledger/summary.js";
import { buildViews, writeViews } from "../src/ledger/views.js";
import { FolderStore } from "../src/store/folder-store.js";
import type { AtmCatalogRow } from "../src/types.js";
import { bundleWorker } from "./worker-fixture/bundle.js";

const ROOT = join(import.meta.dir, "../fixtures/vibes-year");
const SCHOOL = "sch_vol";
const AS_OF = "2026-12-28T17:00:00Z";
const COMPATIBILITY_DATE = "2026-07-01";
const BUCKET = "BUCKET";

const filesUnder = async (directory: string): Promise<string[]> => {
	const found: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...(await filesUnder(path)));
		else found.push(path);
	}
	return found.sort();
};

const workerOptions = (
	script: string,
	compatibilityFlags: string[],
): MiniflareOptions => ({
	modules: [{ type: "ESModule", path: "worker.js", contents: script }],
	compatibilityDate: COMPATIBILITY_DATE,
	compatibilityFlags,
	r2Buckets: [BUCKET],
});

/** The part of the bucket these tests use: Miniflare types it from `@cloudflare/workers-types`, which the package does not install. */
type TestBucket = {
	put(key: string, value: Uint8Array): Promise<unknown>;
	get(key: string): Promise<{ text(): Promise<string> } | null>;
};
const bucketOf = async (miniflare: Miniflare): Promise<TestBucket> =>
	(await miniflare.getR2Bucket(BUCKET)) as unknown as TestBucket;

const seed = async (miniflare: Miniflare): Promise<void> => {
	const bucket = await bucketOf(miniflare);
	for (const path of await filesUnder(ROOT)) {
		const key = relative(ROOT, path);
		if (key === "expected.json") continue;
		await bucket.put(key, await readFile(path));
	}
};

const query = `/?school=${SCHOOL}&asOf=${encodeURIComponent(AS_OF)}`;

let script: string;
beforeAll(async () => {
	script = (await bundleWorker("tests/worker-fixture/worker.ts")).text;
}, 60_000);

describe("the read path in workerd", () => {
	let miniflare: Miniflare;
	beforeAll(async () => {
		miniflare = new Miniflare(workerOptions(script, ["nodejs_compat"]));
		await seed(miniflare);
	}, 60_000);
	afterAll(async () => {
		await miniflare.dispose();
	});

	test("with nodejs_compat, reads R2, summarizes members and writes views as Node does", async () => {
		const response = await miniflare.dispatchFetch(`http://worker${query}`);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.error).toBeUndefined();
		expect(response.status).toBe(200);

		const asOf = new Date(AS_OF);
		const catalog = JSON.parse(
			await readFile(join(ROOT, "catalog.json"), "utf8"),
		) as AtmCatalogRow[];
		const { events } = await readEvents(ROOT, SCHOOL);
		const members = membersOf(events, asOf, { catalog });
		const built = buildViews(events, { school: SCHOOL, asOf, catalog });
		if (!(members.ok && built.ok)) throw new Error("the Node run failed");
		expect(Object.keys(members.members).length).toBeGreaterThan(0);

		expect(body.eventCount).toBe(events.length);
		expect(body.members).toEqual(JSON.parse(JSON.stringify(members)));
		expect(body.views).toEqual(JSON.parse(JSON.stringify(built.views)));
		// run.ts pins TZ to UTC around a replay and puts it back: workerd's process.env starts without one
		expect(body.timeZone).toBeNull();

		// the objects workerd wrote are the objects Node writes
		const folder = new FolderStore({
			root: await mkdtemp(join(tmpdir(), "atm-workerd-")),
		});
		const nodeWritten = await writeViews(folder, SCHOOL, built.views);
		expect(nodeWritten.created.length).toBeGreaterThan(0);
		const written = body.written as { created: string[]; unchanged: string[] };
		expect(written.created).toEqual(nodeWritten.created);
		expect((body.rewritten as { created: string[] }).created).toEqual([]);
		const bucket = await bucketOf(miniflare);
		for (const key of nodeWritten.created) {
			const stored = await bucket.get(key);
			expect(stored).not.toBeNull();
			expect(await stored?.text()).toBe(
				new TextDecoder().decode((await folder.get(key)).body),
			);
		}
	}, 60_000);
});

/** What workerd does with a script, as the text of the failure (a start-up error or the response of a request). */
const outcomeOf = async (
	scriptText: string,
	compatibilityFlags: string[],
): Promise<string> => {
	const miniflare = new Miniflare(
		workerOptions(scriptText, compatibilityFlags),
	);
	try {
		const response = await miniflare.dispatchFetch(`http://worker${query}`);
		return `status ${response.status}: ${await response.text()}`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		await miniflare.dispose().catch(() => undefined);
	}
};

describe("without nodejs_compat", () => {
	test("the bundled Worker does not load: workerd has no node:crypto", async () => {
		const message = await outcomeOf(script, []);
		console.info(`without nodejs_compat: ${message}`);
		expect(message).toContain('No such module "node:crypto"');
	}, 60_000);

	test("and `process` is not defined, so the `process.env.TZ` of run.ts could not run either", async () => {
		const message = await outcomeOf(
			"export default { fetch: () => new Response(String(process.env.TZ)) };",
			[],
		);
		console.info(`process.env.TZ without nodejs_compat: ${message}`);
		expect(message).toContain("process is not defined");
	}, 60_000);
});
