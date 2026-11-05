/**
 * Review tests for the inputs shipper: erasure leaks that need a crash or a racing shipper to show.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	eraseStoredInputs,
	sqliteInputsSource,
} from "../src/handler/inputs.js";
import type { SqlDatabase } from "../src/handler/types.js";
import { folderInputsSource, shipInputs } from "../src/ledger/ship-inputs.js";
import { FolderStore } from "../src/store/folder-store.js";
import type { Store } from "../src/types.js";
import { HOUR, SCHOOL, T1 } from "./handler-harness.js";
import { readTree, tmp } from "./helpers.js";
import {
	buildWorld,
	deliverFor,
	ERASED,
	KEPT,
	subjectKeyOf,
} from "./ship-inputs-world.js";

const ENV = "live" as const;
const SHIP_TIME = 1_800_000_000_000;
const ERASE_TIME = 1_800_000_001_000;
const scope = { school: SCHOOL, env: ENV };

const directories: string[] = [];
afterAll(async () => {
	for (const directory of directories)
		await rm(directory, { recursive: true, force: true });
});
const folder = async () => {
	const root = await tmp("ship-inputs-review");
	directories.push(root);
	return { root, store: new FolderStore({ root }) };
};
type World = ReturnType<typeof buildWorld>;
const shipArgs = (h: World, store: Store, nowMs = SHIP_TIME) => ({
	db: h.db,
	store,
	...scope,
	nowMs: () => nowMs,
});
const crashing = (
	base: SqlDatabase,
	match: RegExp,
	armed: () => boolean,
): SqlDatabase => ({
	exec: (sql) => base.exec(sql),
	all: (sql, params) => base.all(sql, params),
	run: (sql, params) => {
		if (armed() && match.test(sql)) throw new Error("injected crash");
		return base.run(sql, params);
	},
	transaction: (fn) => base.transaction(fn),
});
const everythingIn = async (root: string) =>
	Object.values(await readTree(root)).join("\n");
const erase = (h: World, at = ERASE_TIME) =>
	eraseStoredInputs(h.db, {
		...scope,
		subjectKey: subjectKeyOf(ERASED),
		nowMs: at,
	});

describe("review: erasure leaks", () => {
	test("a seed whose put landed and whose mark did not, then the holder is erased", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		let crash = true;
		await expect(
			shipInputs({
				...shipArgs(h, store),
				db: crashing(
					h.db,
					/UPDATE atm_input_seeds SET shipped_at/,
					() => crash,
				),
			}),
		).rejects.toThrow("injected crash");
		expect(await everythingIn(root)).toContain(ERASED);
		erase(h);
		crash = false;
		const result = await shipInputs(shipArgs(h, store, ERASE_TIME + 1000));
		expect(result.erasures.pending).toBe(0);
		expect(await everythingIn(root)).not.toContain(ERASED);
	});

	test("a holder erased twice (a new seed after the first erasure) has the second seed object deleted too", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		await shipInputs(shipArgs(h, store));
		erase(h);
		await shipInputs(shipArgs(h, store, ERASE_TIME + 1000));
		expect(await everythingIn(root)).not.toContain(ERASED);
		// the holder comes back with ledger rows: a new first applied input seeds again (same subject key, same object name)
		h.raw.run(
			`INSERT INTO atm_input_seeds (env, subject_key, revision, taken_at, first_event_id, rows, shipped_at) VALUES ('live', ?, 1, 5, 'evt_back', '[{"x":"fam_erased_again"}]', NULL)`,
			[subjectKeyOf(ERASED)],
		);
		await shipInputs(shipArgs(h, store, ERASE_TIME + 2000));
		expect(await everythingIn(root)).toContain("fam_erased_again");
		const second = erase(h, ERASE_TIME + 3000);
		expect(second.seeds).toBe(1);
		await shipInputs(shipArgs(h, store, ERASE_TIME + 4000));
		expect(await everythingIn(root)).not.toContain("fam_erased_again");
	});

	test("a shipper that planned before an erasure and puts after another shipper settled it does not leave the batch with the facts", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		let armed = true;
		const slow: Store = {
			putIfAbsent: async (key, body) => {
				if (armed && key.includes("/date=2026-02-15/")) {
					armed = false;
					// the holder is erased and a second shipper runs to the end, between this shipper's plan and its put
					erase(h);
					await shipInputs(shipArgs(h, store, ERASE_TIME + 500));
				}
				return store.putIfAbsent(key, body);
			},
			putIfMatch: (key, body, etag) => store.putIfMatch(key, body, etag),
			get: (key, range) => store.get(key, range),
			head: (key) => store.head(key),
			list: (options) => store.list(options),
			delete: (key, expected) => store.delete(key, expected),
			presign: (key, options) => store.presign(key, options),
		};
		await shipInputs(shipArgs(h, slow));
		// one more run of either shipper
		const result = await shipInputs(shipArgs(h, store, ERASE_TIME + 2000));
		expect(result.erasures.pending).toBe(0);
		const tree = await readTree(root);
		const leaked = Object.keys(tree).filter((key) =>
			tree[key]?.includes(ERASED),
		);
		expect(leaked).toEqual([]);
	});
});

/** A store and a database that throw on the n-th write (a put, a delete, or a statement that writes). */
const failingAt = (h: World, store: Store, failAt: number) => {
	let count = 0;
	const tick = (what: string) => {
		count += 1;
		if (count === failAt)
			throw new Error(`injected crash at ${count}: ${what}`);
	};
	const db: SqlDatabase = {
		exec: (sql) => h.db.exec(sql),
		all: (sql, params) => h.db.all(sql, params),
		run: (sql, params) => {
			tick(sql.slice(0, 40));
			return h.db.run(sql, params);
		},
		transaction: (fn) => h.db.transaction(fn),
	};
	const wrapped: Store = {
		putIfAbsent: (key, body) => {
			tick(`put ${key}`);
			return store.putIfAbsent(key, body);
		},
		putIfMatch: (key, body, etag) => store.putIfMatch(key, body, etag),
		get: (key, range) => store.get(key, range),
		head: (key) => store.head(key),
		list: (options) => store.list(options),
		delete: (key, expected) => {
			tick(`delete ${key}`);
			return store.delete(key, expected);
		},
		presign: (key, options) => store.presign(key, options),
	};
	return { db, store: wrapped, writes: () => count };
};

const FOLDER_NEEDLES = [
	ERASED,
	"pi_in_a2",
	"pi_in_a3",
	"ch_in_a2",
	"ch_in_a3",
	'"id":"in_a2"',
	'"id":"in_a3"',
	`sub_${ERASED}`,
	`cus_family:${ERASED}`,
];

describe("review: a crash at every write", () => {
	// Without erasure first: crash anywhere in the first ship, then the holder is erased, then the next run.
	test("crash at the n-th write of the first ship, then erase, then one run: nothing of the holder is in any file", async () => {
		let n = 1;
		for (;;) {
			const h = buildWorld();
			const { root, store } = await folder();
			const failing = failingAt(h, store, n);
			let crashed = false;
			try {
				await shipInputs({
					...shipArgs(h, store),
					db: failing.db,
					store: failing.store,
				});
			} catch {
				crashed = true;
			}
			if (!crashed) break;
			erase(h);
			const result = await shipInputs(shipArgs(h, store, ERASE_TIME + 1000));
			const left = await everythingIn(root);
			for (const needle of FOLDER_NEEDLES)
				expect(`${n}:${needle}:${left.includes(needle)}`).toBe(
					`${n}:${needle}:false`,
				);
			expect(`${n}:${result.erasures.pending}`).toBe(`${n}:0`);
			n += 1;
			expect(n).toBeLessThan(200);
		}
		expect(n).toBeGreaterThan(10);
	});

	// Erasure after a complete ship: crash anywhere in the settling run, then a clean run.
	test("crash at the n-th write of the run that settles the erasure, then a clean run: nothing is left, and the other holder's lines are byte for byte as they were", async () => {
		let n = 1;
		let reference: Record<string, string> | null = null;
		for (;;) {
			const h = buildWorld();
			const { root, store } = await folder();
			await shipInputs(shipArgs(h, store));
			const before = await readTree(root);
			erase(h);
			const failing = failingAt(h, store, n);
			let crashed = false;
			try {
				await shipInputs({
					...shipArgs(h, store, ERASE_TIME + 1000),
					db: failing.db,
					store: failing.store,
				});
			} catch {
				crashed = true;
			}
			const result = await shipInputs(shipArgs(h, store, ERASE_TIME + 2000));
			expect(`${n}:${result.erasures.pending}`).toBe(`${n}:0`);
			const after = await readTree(root);
			const left = Object.values(after).join("\n");
			for (const needle of FOLDER_NEEDLES)
				expect(`${n}:${needle}:${left.includes(needle)}`).toBe(
					`${n}:${needle}:false`,
				);
			// the same end state however the run was interrupted
			reference ??= after;
			expect(Object.keys(after).sort()).toEqual(Object.keys(reference).sort());
			// the kept holder's lines are the same bytes as before the erasure
			const keptLines = (tree: Record<string, string>) =>
				Object.values(tree)
					.flatMap((text) => text.split("\n"))
					.filter((line) => line.includes("fam_kept"))
					.sort();
			expect(keptLines(after)).toEqual(keptLines(before));
			if (!crashed) break;
			n += 1;
			expect(n).toBeLessThan(200);
		}
		expect(n).toBeGreaterThan(5);
	});
});

describe("review: an erasure that lands between any two writes of a run", () => {
	test("erase at the n-th write of a ship, let the run finish, run once more: no file holds the holder", async () => {
		let n = 1;
		for (;;) {
			const h = buildWorld();
			const { root, store } = await folder();
			let count = 0;
			let fired = false;
			const hook = (): void => {
				count += 1;
				if (count === n && !fired) {
					fired = true;
					erase(h);
				}
			};
			const db: SqlDatabase = {
				exec: (sql) => h.db.exec(sql),
				all: (sql, params) => h.db.all(sql, params),
				run: (sql, params) => {
					hook();
					return h.db.run(sql, params);
				},
				transaction: (fn) => h.db.transaction(fn),
			};
			const hooked: Store = {
				putIfAbsent: (key, body) => {
					hook();
					return store.putIfAbsent(key, body);
				},
				putIfMatch: (key, body, etag) => store.putIfMatch(key, body, etag),
				get: (key, range) => store.get(key, range),
				head: (key) => store.head(key),
				list: (options) => store.list(options),
				delete: (key, expected) => {
					hook();
					return store.delete(key, expected);
				},
				presign: (key, options) => store.presign(key, options),
			};
			await shipInputs({ ...shipArgs(h, store), db, store: hooked });
			if (!fired) break;
			const result = await shipInputs(shipArgs(h, store, ERASE_TIME + 5000));
			const left = await everythingIn(root);
			for (const needle of FOLDER_NEEDLES)
				expect(`${n}:${needle}:${left.includes(needle)}`).toBe(
					`${n}:${needle}:false`,
				);
			expect(`${n}:${result.erasures.pending}`).toBe(`${n}:0`);
			n += 1;
			expect(n).toBeLessThan(200);
		}
		expect(n).toBeGreaterThan(10);
	});
});

describe("review: a secret given on the command line never reaches the output", () => {
	const BIN = join(import.meta.dir, "../src/bin.ts");
	const SECRET_PARTS = ["TOPSECRETPART", "AFTERQUOTE", "SHORTSECRET"];
	test("an unknown flag with a value, with or without a quote in it, is echoed without the value", () => {
		const base = [
			"inputs",
			"ship",
			"--db",
			"/nonexistent.sqlite",
			"--school",
			SCHOOL,
			"--env",
			"live",
		];
		const cases = [
			["--r2-secret-access-key=TOPSECRETPART"],
			["--r2-secret-access-key=TOPSECRETPART'AFTERQUOTE"],
			["--r2-secret-access-key=TOPSECRETPART'AFTERQUOTE'x", "--json"],
			["-sSHORTSECRET"],
			["--r2-secret-access-key", "TOPSECRETPART"],
		];
		for (const extra of cases) {
			const run = Bun.spawnSync([process.execPath, BIN, ...base, ...extra], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const output = `${run.stdout.toString()}${run.stderr.toString()}`;
			expect(run.exitCode).toBe(2);
			for (const part of SECRET_PARTS)
				expect(`${extra.join(" ")}: ${output.includes(part)}`).toBe(
					`${extra.join(" ")}: false`,
				);
			expect(run.stderr.toString().trim().split("\n")).toHaveLength(1);
		}
	});
});

describe("review: booking inputs", () => {
	test("booking refs and a missing fee round-trip through the folder, and an erasure removes the erased holder's refs", async () => {
		const h = buildWorld();
		h.raw.run(
			`UPDATE atm_event_inputs SET booking_refs = '{"pi_bk_erased":"bk_secret_erased"}', fee = NULL WHERE event_id = 'evt_in_a2'`,
		);
		h.raw.run(
			`UPDATE atm_event_inputs SET booking_refs = '{"pi_bk_kept":"bk_secret_kept"}', fee = NULL WHERE event_id = 'evt_in_b1'`,
		);
		const { root, store } = await folder();
		await shipInputs(shipArgs(h, store));
		const strip = (
			read: Awaited<ReturnType<ReturnType<typeof folderInputsSource>["read"]>>,
		) => read.inputs.map(({ shippedAt, ...rest }) => rest);
		const folderRead = await folderInputsSource(root).read(scope);
		const sqliteRead = await sqliteInputsSource(h.db).read(scope);
		expect(strip(folderRead)).toEqual(strip(sqliteRead));
		expect(
			folderRead.inputs.find((i) => i.eventId === "evt_in_b1")?.bookingRefs,
		).toEqual({
			pi_bk_kept: "bk_secret_kept",
		});
		expect(await everythingIn(root)).toContain("bk_secret_erased");
		erase(h);
		await shipInputs(shipArgs(h, store, ERASE_TIME + 1000));
		const left = await everythingIn(root);
		expect(left).not.toContain("bk_secret_erased");
		expect(left).not.toContain("pi_bk_erased");
		expect(left).toContain("bk_secret_kept");
	});
});

describe("review: rows that arrive after a crash", () => {
	test("crash at the n-th write, a new input lands, a clean run: every event is in exactly one line, and the folder reads as SQLite does", async () => {
		let n = 1;
		for (;;) {
			const h = buildWorld();
			const { root, store } = await folder();
			const failing = failingAt(h, store, n);
			let crashed = false;
			try {
				await shipInputs({
					...shipArgs(h, store),
					db: failing.db,
					store: failing.store,
				});
			} catch {
				crashed = true;
			}
			deliverFor(h, KEPT, "in_b3", T1 + 3 * HOUR, "subscription_cycle");
			await shipInputs(shipArgs(h, store, SHIP_TIME + 1000));
			await shipInputs(shipArgs(h, store, SHIP_TIME + 2000));
			const tree = await readTree(root);
			const ids = Object.entries(tree)
				.filter(([key]) => key.endsWith(".jsonl"))
				.flatMap(([, text]) =>
					text.split("\n").filter((line) => line.length > 0),
				)
				.map((line) => (JSON.parse(line) as { event_id: string }).event_id);
			expect(`${n}:${ids.length}:${new Set(ids).size}`).toBe(`${n}:5:5`);
			const folderRead = await folderInputsSource(root).read(scope);
			const sqliteRead = await sqliteInputsSource(h.db).read(scope);
			const strip = (read: typeof folderRead) =>
				read.inputs.map(({ shippedAt, ...rest }) => rest);
			expect(strip(folderRead)).toEqual(strip(sqliteRead));
			if (!crashed) break;
			n += 1;
			expect(n).toBeLessThan(200);
		}
	});
});

describe("review: two shippers settling the same erasure", () => {
	test("both run at once: the object the rows point at is still there, and the old one is gone", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		await shipInputs(shipArgs(h, store));
		erase(h);
		await Promise.all([
			shipInputs(shipArgs(h, store, ERASE_TIME + 1000)),
			shipInputs(shipArgs(h, store, ERASE_TIME + 1000)),
		]);
		await shipInputs(shipArgs(h, store, ERASE_TIME + 2000));
		const tree = await readTree(root);
		const keys = new Set(Object.keys(tree));
		const pointed = h.raw
			.query(`SELECT DISTINCT batch_key FROM atm_event_inputs`)
			.all() as { batch_key: string }[];
		for (const { batch_key } of pointed)
			expect(`${batch_key}:${keys.has(batch_key)}`).toBe(`${batch_key}:true`);
		expect(Object.values(tree).join("\n")).not.toContain(ERASED);
		const folderRead = await folderInputsSource(root).read(scope);
		expect(folderRead.inputs.map((i) => i.eventId)).toEqual([
			"evt_in_a2",
			"evt_in_b1",
			"evt_in_a3",
			"evt_in_b2",
		]);
	});
});
