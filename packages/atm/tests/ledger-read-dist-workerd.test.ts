/**
 * Runs the SHIPPED `dist/worker.js` (what `atm/worker` resolves to for a consumer: built by `build.ts` with Bun's `node`
 * target, the engine inlined) inside workerd under `nodejs_compat`, over an R2 bucket binding. The other workerd test
 * bundles the source with esbuild, which is not what a consumer loads; this one loads the built file as is. With
 * `ATM_DIST` set (the release script does) it tests that directory instead of building one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { readEvents } from "../src/ledger/files.js";
import { membersOf } from "../src/ledger/summary.js";
import { buildViews } from "../src/ledger/views.js";
import type { AtmCatalogRow } from "../src/types.js";
import { seedBucket, workerOptions } from "./worker-fixture/miniflare.js";

const ROOT = join(import.meta.dir, "../fixtures/vibes-year");
const SCHOOL = "sch_vol";
const AS_OF = "2026-12-28T17:00:00Z";
const DIST_MODULE = "atm-worker.js";

/** The Worker a consumer would write against the built `atm/worker`: events from the binding, members, views, then verify. */
const CONSUMER = `
import {
	R2BindingStore,
	buildViews,
	membersOf,
	readEventsFromStore,
	readViewsFromStore,
	runViews,
} from "./${DIST_MODULE}";

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const school = url.searchParams.get("school");
		const asOf = new Date(url.searchParams.get("asOf"));
		const store = new R2BindingStore(env.BUCKET);
		try {
			const catalog = JSON.parse(new TextDecoder().decode((await store.get("catalog.json")).body));
			const events = await readEventsFromStore(store, school);
			const members = membersOf(events, asOf, { catalog });
			const built = buildViews(events, { school, asOf, catalog });
			const run = await runViews(store, school, asOf, { catalog });
			const reader = await readViewsFromStore(store, school);
			const reads = reader.ok
				? [
						await reader.membersIndex(),
						...(await Promise.all(Object.keys(built.views.months).map((month) => reader.month(month)))),
						...(await Promise.all(Object.keys(built.views.members).map((key) => reader.member(key)))),
						...(await Promise.all(Object.keys(built.views.finance.months).map((month) => reader.financeMonth(month)))),
						...(await Promise.all(Object.keys(built.views.finance.members).map((key) => reader.financeMember(key)))),
						...(await Promise.all(Object.keys(built.views.contributions).map((month) => reader.contributions(month)))),
					]
				: [];
			return json({
				eventCount: events.length,
				members,
				views: built.views,
				created: run.written.created.length,
				opened: reader.ok,
				objectCount: reader.ok ? reader.manifest.objectCount : null,
				checked: reads.length,
				failures: reads.filter((read) => !read.ok),
			});
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : String(error) }, 500);
		}
	},
};
`;

let distWorker: string;
let miniflare: Miniflare;
beforeAll(async () => {
	const dist = join(await mkdtemp(join(tmpdir(), "atm-dist-worker-")), "dist");
	if (process.env.ATM_DIST) {
		cpSync(process.env.ATM_DIST, dist, { recursive: true });
	} else {
		const build = Bun.spawnSync([
			"bun",
			join(import.meta.dir, "../build.ts"),
			dist,
		]);
		if (build.exitCode !== 0) throw new Error(build.stderr.toString());
	}
	distWorker = await readFile(join(dist, "worker.js"), "utf8");
	miniflare = new Miniflare(
		workerOptions(
			[
				{ type: "ESModule", path: "worker.js", contents: CONSUMER },
				{ type: "ESModule", path: DIST_MODULE, contents: distWorker },
			],
			["nodejs_compat"],
		),
	);
	await seedBucket(miniflare, ROOT);
}, 180_000);
afterAll(async () => {
	await miniflare.dispose();
});

describe("the built dist/worker.js in workerd", () => {
	test("is one self-contained module that loads under nodejs_compat", () => {
		// nothing but node:* built-ins is imported from outside the file: a bare package import would not resolve in a Worker
		const imports = [
			...distWorker.matchAll(/^import\s[^"']*["']([^"']+)["']/gm),
		]
			.map((match) => match[1])
			.filter((specifier) => !specifier?.startsWith("node:"));
		expect(imports).toEqual([]);
	});

	test("reads R2, summarizes members, writes views and verifies them, as Node does", async () => {
		const query = `?school=${SCHOOL}&asOf=${encodeURIComponent(AS_OF)}`;
		const response = await miniflare.dispatchFetch(`http://worker/${query}`);
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

		expect(body.eventCount).toBe(events.length);
		expect(body.members).toEqual(JSON.parse(JSON.stringify(members)));
		expect(body.views).toEqual(JSON.parse(JSON.stringify(built.views)));
		// the objects plus the manifest were written, and every one of the objects verifies against the manifest
		const objects =
			Object.keys(built.views.months).length +
			Object.keys(built.views.members).length +
			Object.keys(built.views.finance.months).length +
			Object.keys(built.views.finance.members).length +
			Object.keys(built.views.contributions).length +
			1;
		expect(body.created).toBe(objects + 1);
		expect(body.opened).toBe(true);
		expect(body.objectCount).toBe(objects);
		expect(body.checked).toBe(objects);
		expect(body.failures).toEqual([]);
	}, 60_000);
});
