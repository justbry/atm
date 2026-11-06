/**
 * Every preset's events shipped to staging R2 through atm's real write path and read back from it. Skipped unless the staging
 * bucket's variables are set (the same as `store-r2.test.ts`, plus `ATM_R2_SESSION_TOKEN` for temporary credentials):
 *
 *   ATM_R2_ENDPOINT, ATM_R2_BUCKET, ATM_R2_ACCESS_KEY_ID, ATM_R2_SECRET_ACCESS_KEY, [ATM_R2_SESSION_TOKEN]
 *
 * Each preset writes under `scenario-roundtrip/<run>/<preset>/` and deletes it again. A connection can drop after a few hundred
 * PUTs, so shipping retries (the shipper is idempotent: an object already there is a success) and a preset is its own test, so a
 * run that stops can be repeated and only the missing presets redone. What it checks, per preset: the R2 object tree equals the
 * tree a folder holds for the same events, the events read back from R2 are all of them, and the three KPI channels on those
 * events have the golden's KPI hash.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { readEvents } from "../src/ledger/files.js";
import { appendToOutbox } from "../src/ledger/outbox.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { buildFixture } from "../src/scenario/fixture.js";
import { runParity } from "../src/scenario/parity.js";
import { PROFILE_NAMES } from "../src/scenario/profiles.js";
import { FolderStore } from "../src/store/folder-store.js";
import { R2Store } from "../src/store/r2-store.js";
import type { Store } from "../src/types.js";

const endpoint = process.env.ATM_R2_ENDPOINT;
const bucket = process.env.ATM_R2_BUCKET;
const accessKeyId = process.env.ATM_R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.ATM_R2_SECRET_ACCESS_KEY;
const sessionToken = process.env.ATM_R2_SESSION_TOKEN;
const hasR2 = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

const PRESET_TIMEOUT_MS = 600_000;
const SHIP_ATTEMPTS = 8;
const RETRY_PAUSE_MS = 2000;
const SHIPPED_AT = 1_700_000_000_000;

const sha = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");

const keysOf = async (store: Store): Promise<string[]> => {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await store.list(cursor ? { cursor } : {});
		keys.push(...page.objects.map((object) => object.key));
		cursor = page.next ?? undefined;
	} while (cursor);
	return keys.sort();
};

const treeOf = async (store: Store, keys: string[]): Promise<string> =>
	sha(
		(
			await Promise.all(
				keys.map(
					async (key) =>
						`${key} ${sha(new Uint8Array((await store.get(key)).body))}`,
				),
			)
		).join("\n"),
	);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ships with retries: a dropped connection fails one try, and the next finds the objects already put. */
const shipWithRetries = async (
	db: ReturnType<typeof bunSqlite>,
	store: Store,
	school: string,
): Promise<void> => {
	let last: unknown;
	for (let attempt = 1; attempt <= SHIP_ATTEMPTS; attempt++) {
		try {
			const shipped = await shipOutbox({
				db,
				store,
				school,
				nowMs: () => SHIPPED_AT,
			});
			if (shipped.conflicts.length > 0)
				throw new Error(`ship conflicts: ${JSON.stringify(shipped.conflicts)}`);
			return;
		} catch (error) {
			last = error;
			await pause(RETRY_PAUSE_MS * attempt);
		}
	}
	throw last;
};

const run = `scenario-roundtrip/${randomUUID()}`;

describe.skipIf(!hasR2)("generated events through staging R2", () => {
	for (const profile of PROFILE_NAMES)
		test(
			`${profile}: R2 holds what a folder holds, and the channels agree on what comes back`,
			async () => {
				const fixture = buildFixture({ profile });
				const school = fixture.events[0]?.school as string;
				const outbox = () => {
					const db = bunSqlite(new Database(":memory:"));
					db.exec(HANDLER_DDL);
					appendToOutbox(db, fixture.events, "live");
					return db;
				};
				const folderRoot = mkdtempSync(join(tmpdir(), "r2-folder-"));
				const readRoot = mkdtempSync(join(tmpdir(), "r2-read-"));
				const r2 = new R2Store({
					endpoint: endpoint as string,
					bucket: bucket as string,
					prefix: `${run}/${profile}`,
					accessKeyId: accessKeyId as string,
					secretAccessKey: secretAccessKey as string,
					...(sessionToken ? { sessionToken } : {}),
				});
				try {
					const folder = new FolderStore({ root: folderRoot });
					await shipWithRetries(outbox(), folder, school);
					await shipWithRetries(outbox(), r2, school);
					const folderKeys = await keysOf(folder);
					const r2Keys = await keysOf(r2);
					expect(r2Keys).toEqual(folderKeys);
					expect(await treeOf(r2, r2Keys)).toBe(
						await treeOf(folder, folderKeys),
					);
					for (const key of r2Keys) {
						const body = new Uint8Array((await r2.get(key)).body);
						await mkdir(dirname(join(readRoot, key)), { recursive: true });
						await writeFile(join(readRoot, key), body);
					}
					const back = (await readEvents(readRoot, school)).events;
					expect(back.length).toBe(fixture.events.length);
					const parity = await runParity({
						events: back,
						periods: fixture.periods,
					});
					expect(parity.equal).toBe(true);
					const golden = JSON.parse(
						await readFile(
							join(import.meta.dir, `golden/scenarios/${profile}.json`),
							"utf8",
						),
					) as { kpisHash: string };
					for (const channel of parity.runs)
						if (channel.status === "ok")
							expect(channel.hash, channel.name).toBe(golden.kpisHash);
				} finally {
					for (const key of await keysOf(r2).catch(() => [])) {
						const body = await r2.get(key).catch(() => null);
						if (body) await r2.delete(key, sha(new Uint8Array(body.body)));
					}
					rmSync(folderRoot, { recursive: true, force: true });
					rmSync(readRoot, { recursive: true, force: true });
				}
			},
			PRESET_TIMEOUT_MS,
		);
});
