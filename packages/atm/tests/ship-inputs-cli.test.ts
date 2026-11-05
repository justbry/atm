/**
 * `atm inputs ship` as a schedule runs it: exit 0 done, 1 a conflict or an erasure still pending, 2 any other error with one
 * stderr line, `--json` as one line, the destination flags and the environment (credentials from the environment only), and
 * the UTC batch day under other process time zones. The shipping itself is `ship-inputs.test.ts`. The R2 path is not run
 * against R2: these tests only prove what the command refuses and what it reads from where.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { eraseStoredInputs, readInputs } from "../src/handler/inputs.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import {
	InputsDestinationError,
	resolveInputsDestination,
} from "../src/ledger/inputs-destination.js";
import { planInputs } from "../src/ledger/ship-inputs.js";
import { FolderStore } from "../src/store/folder-store.js";
import { sha256Hex, utf8 } from "../src/store/store.js";
import { harness, SCHOOL } from "./handler-harness.js";
import { readTree, tmp } from "./helpers.js";
import {
	buildWorld,
	deliverFor,
	KEPT,
	subjectKeyOf,
} from "./ship-inputs-world.js";

const BIN = join(import.meta.dir, "../src/bin.ts");
const STACK_FRAME = /\n\s+at /;
const scope = { school: SCHOOL, env: "live" as const };

let folder = "";
let databaseFile = "";
let root = "";

const directories: string[] = [];
afterAll(async () => {
	for (const directory of directories)
		await rm(directory, { recursive: true, force: true });
});

/** A handler database file with the world's four inputs (a seed for one family). */
const makeDatabase = (file = databaseFile) => {
	const raw = new Database(file, { create: true });
	buildWorld(raw);
	raw.close();
};

const atm = (args: string[], env: Record<string, string> = {}) =>
	Bun.spawnSync([process.execPath, BIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...Object.fromEntries(
				Object.entries(process.env).filter(
					([name]) => !name.startsWith("ATM_R2_"),
				),
			),
			...env,
		},
	});

const ship = (extra: string[] = [], env: Record<string, string> = {}) =>
	atm(
		[
			"inputs",
			"ship",
			"--db",
			databaseFile,
			"--school",
			SCHOOL,
			"--env",
			"live",
			"--root",
			root,
			...extra,
		],
		env,
	);

const jsonLine = (stdout: string): Record<string, unknown> => {
	const lines = stdout.trimEnd().split("\n");
	expect(lines).toHaveLength(1);
	return JSON.parse(lines[0] as string) as Record<string, unknown>;
};

/** An error is exactly one line on stderr, with no stack trace. */
const oneLine = (stderr: string): string => {
	expect(stderr.endsWith("\n")).toBe(true);
	expect(stderr.trimEnd().split("\n")).toHaveLength(1);
	expect(stderr).not.toMatch(STACK_FRAME);
	return stderr.trimEnd();
};

beforeEach(async () => {
	folder = await tmp("ship-inputs-cli");
	directories.push(folder);
	databaseFile = join(folder, "handler.sqlite");
	root = join(folder, "log");
	await mkdir(root);
});

describe("atm inputs ship: exit 0", () => {
	test("--json prints one line, the world ships in two batches with a context and a seed, and a rerun says zero", () => {
		makeDatabase();
		const run = ship(["--json"]);
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
		expect(jsonLine(run.stdout.toString())).toEqual({
			ok: true,
			school: SCHOOL,
			env: "live",
			batches: 2,
			shipped: 4,
			contexts: 1,
			seeds: 1,
			conflicts: [],
			erasuresSettled: 0,
			erasuresPending: 0,
			unshipped: 0,
			oldestUnshippedAgeMs: null,
		});
		const again = ship(["--json"]);
		expect(again.exitCode).toBe(0);
		expect(jsonLine(again.stdout.toString())).toMatchObject({
			ok: true,
			batches: 0,
			shipped: 0,
			contexts: 0,
			seeds: 0,
		});
	});

	test("without --json it prints a line per batch and a summary", () => {
		makeDatabase();
		const run = ship();
		expect(run.exitCode).toBe(0);
		const lines = run.stdout.toString().trimEnd().split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(
			/^created schools\/sch_vol\/inputs\/live\/date=2026-02-15\/batch-000000000002-[0-9a-f]{16}\.jsonl: 3 inputs$/,
		);
		expect(lines[2]).toBe(
			"4 inputs shipped in 2 batches, 1 contexts, 1 seeds; 0 conflicts; erasures settled 0, pending 0",
		);
	});

	test("a school with no stored input yet (an empty table) exits 0", () => {
		const raw = new Database(databaseFile, { create: true });
		raw.exec(HANDLER_DDL);
		raw.close();
		const run = ship(["--json"]);
		expect(run.exitCode).toBe(0);
		expect(jsonLine(run.stdout.toString())).toMatchObject({
			ok: true,
			batches: 0,
		});
	});
});

describe("atm inputs ship: exit 1", () => {
	test("a key that holds other bytes: a conflict line on stderr, ok false in --json, the stranger left alone", async () => {
		makeDatabase();
		const raw = new Database(databaseFile);
		const rows = readInputs(bunSqlite(raw), scope).inputs;
		raw.close();
		const [day15] = planInputs({
			...scope,
			rows: rows.filter((row) => row.appliedOrder <= 4),
		});
		await new FolderStore({ root }).putIfAbsent(
			day15?.key as string,
			utf8("planted\n"),
		);
		const run = ship(["--json"]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr.toString()).toStartWith(`conflict ${day15?.key}: `);
		expect(jsonLine(run.stdout.toString())).toMatchObject({
			ok: false,
			batches: 1,
			shipped: 1,
			unshipped: 3,
			conflicts: [{ key: day15?.key }],
		});
		expect((await readTree(root))[day15?.key as string]).toBe("planted\n");
	});

	test("an erasure that cannot finish: exit 1 with a line that says so, then 0 when the cause is gone", async () => {
		makeDatabase();
		expect(ship().exitCode).toBe(0);
		const raw = new Database(databaseFile);
		const db = bunSqlite(raw);
		eraseStoredInputs(db, {
			...scope,
			subjectKey: subjectKeyOf("fam_erased"),
			nowMs: Date.now(),
		});
		const rows = readInputs(db, scope).inputs;
		raw.close();
		const oldKey = rows[0]?.batchKey as string;
		const [rewrite] = planInputs({
			...scope,
			rows: rows.filter((row) => row.batchKey === oldKey),
		});
		await new FolderStore({ root }).putIfAbsent(
			rewrite?.key as string,
			utf8("planted\n"),
		);
		const stuck = ship(["--json"]);
		expect(stuck.exitCode).toBe(1);
		expect(stuck.stderr.toString()).toContain("erasure pending: 1");
		expect(jsonLine(stuck.stdout.toString())).toMatchObject({
			ok: false,
			erasuresPending: 1,
			erasuresSettled: 1,
		});
		await new FolderStore({ root }).delete(
			rewrite?.key as string,
			sha256Hex(utf8("planted\n")),
		);
		const fixed = ship(["--json"]);
		expect(fixed.exitCode).toBe(0);
		expect(jsonLine(fixed.stdout.toString())).toMatchObject({
			ok: true,
			erasuresSettled: 1,
			erasuresPending: 0,
		});
	});
});

describe("atm inputs ship: exit 2", () => {
	const refused = (run: ReturnType<typeof ship>, expected: string | RegExp) => {
		expect(run.exitCode).toBe(2);
		expect(oneLine(run.stderr.toString())).toMatch(expected);
	};

	test("a bad --env, a root that is not a folder, a school that is not there, a missing database, a database from before inputs", () => {
		makeDatabase();
		const withEnv = atm([
			"inputs",
			"ship",
			"--db",
			databaseFile,
			"--school",
			SCHOOL,
			"--env",
			"prod",
			"--root",
			root,
		]);
		refused(withEnv, "--env must be live or test");
		refused(
			ship(["--root", join(folder, "typo")]),
			/is not an existing folder/,
		);
		refused(
			atm([
				"inputs",
				"ship",
				"--db",
				databaseFile,
				"--school",
				"sch_typo",
				"--env",
				"live",
				"--root",
				root,
			]),
			/--school sch_typo has no rows in atm_event_inputs .* schools there: sch_vol/,
		);
		refused(
			atm([
				"inputs",
				"ship",
				"--db",
				join(folder, "missing.sqlite"),
				"--school",
				SCHOOL,
				"--env",
				"live",
				"--root",
				root,
			]),
			/^atm inputs ship failed: /,
		);
		const old = join(folder, "old.sqlite");
		const raw = new Database(old, { create: true });
		raw.exec("CREATE TABLE ledger_outbox (id TEXT)");
		raw.close();
		refused(
			atm([
				"inputs",
				"ship",
				"--db",
				old,
				"--school",
				SCHOOL,
				"--env",
				"live",
				"--root",
				root,
			]),
			/HANDLER_DDL/,
		);
	});

	test("--json adds {ok:false,error} on stdout to the one line on stderr", () => {
		makeDatabase();
		const run = ship(["--json", "--root", join(folder, "typo")]);
		expect(run.exitCode).toBe(2);
		const message = oneLine(run.stderr.toString());
		expect(jsonLine(run.stdout.toString())).toEqual({
			ok: false,
			error: message,
		});
		// a missing option is commander's one line, nothing on stdout
		const missing = atm(["inputs", "ship", "--db", databaseFile]);
		expect(missing.exitCode).toBe(2);
		expect(missing.stdout.toString()).toBe("");
		expect(oneLine(missing.stderr.toString())).toContain("required option");
	});

	test("no destination, both destinations, a bucket without an endpoint, no credentials: refused before anything is shipped", () => {
		makeDatabase();
		const base = [
			"inputs",
			"ship",
			"--db",
			databaseFile,
			"--school",
			SCHOOL,
			"--env",
			"live",
		];
		refused(atm(base), "give --root <folder>, or --r2-bucket");
		refused(atm([...base, "--root", root, "--r2-bucket", "b"]), "not both");
		refused(
			atm([...base, "--r2-bucket", "b"]),
			"--r2-bucket needs --r2-endpoint",
		);
		refused(
			atm([...base, "--r2-bucket", "b", "--r2-endpoint", "https://x.example"]),
			"set ATM_R2_ACCESS_KEY_ID and ATM_R2_SECRET_ACCESS_KEY (there is no flag for them)",
		);
		refused(
			atm([...base, "--r2-bucket", "b", "--r2-endpoint", "https://x.example"], {
				ATM_R2_ACCESS_KEY_ID: "id-only",
			}),
			"set ATM_R2_SECRET_ACCESS_KEY (there",
		);
	});

	test("a flag named like a secret is refused, with its value kept out of the log", () => {
		makeDatabase();
		const base = [
			"inputs",
			"ship",
			"--db",
			databaseFile,
			"--school",
			SCHOOL,
			"--env",
			"live",
			"--r2-bucket",
			"b",
			"--r2-endpoint",
			"https://x.example",
		];
		for (const flag of [
			["--r2-secret-access-key=SUPERSECRETVALUE"],
			["--r2-secret-access-key", "SUPERSECRETVALUE"],
			["--r2-access-key-id=SUPERSECRETVALUE"],
			["--r2-session-token", "SUPERSECRETVALUE"],
			["--secret=SUPERSECRETVALUE"],
		]) {
			const run = atm([...base, ...flag], {
				ATM_R2_ACCESS_KEY_ID: "id",
				ATM_R2_SECRET_ACCESS_KEY: "secret",
			});
			expect(run.exitCode).toBe(2);
			const line = oneLine(run.stderr.toString());
			expect(line).toContain("unknown option");
			expect(line).not.toContain("SUPERSECRETVALUE");
			expect(run.stdout.toString()).toBe("");
		}
		// nothing was shipped by any of them
		const raw = new Database(databaseFile);
		expect(
			raw
				.query(
					`SELECT COUNT(*) AS n FROM atm_event_inputs WHERE shipped_at IS NOT NULL`,
				)
				.get(),
		).toEqual({ n: 0 });
		raw.close();
	});

	test("with the destination from the environment the command reaches the store, and a failure there names no credential", () => {
		makeDatabase();
		const run = atm(
			[
				"inputs",
				"ship",
				"--db",
				databaseFile,
				"--school",
				SCHOOL,
				"--env",
				"live",
			],
			{
				ATM_R2_BUCKET: "bucket",
				ATM_R2_ENDPOINT: "http://127.0.0.1:1",
				ATM_R2_ACCESS_KEY_ID: "AKIDENTIFIERFORTEST",
				ATM_R2_SECRET_ACCESS_KEY: "SECRETFORTESTONLY",
			},
		);
		expect(run.exitCode).toBe(2);
		const line = oneLine(run.stderr.toString());
		expect(line).not.toContain("AKIDENTIFIERFORTEST");
		expect(line).not.toContain("SECRETFORTESTONLY");
	}, 60_000);
});

describe("the destination: flags, then the environment; credentials from the environment only", () => {
	const credentials = {
		ATM_R2_ACCESS_KEY_ID: "id",
		ATM_R2_SECRET_ACCESS_KEY: "secret",
	};

	test("--root wins and the environment is not read", () => {
		expect(
			resolveInputsDestination({ root: "/data" }, { ATM_R2_BUCKET: "b" }),
		).toEqual({ kind: "folder", root: "/data" });
		expect(() =>
			resolveInputsDestination({ root: "/data", r2Prefix: "p" }, {}),
		).toThrow(InputsDestinationError);
	});

	test("a flag overrides the variable for the same value, and the variable fills what the flag leaves out", () => {
		const env = {
			...credentials,
			ATM_R2_BUCKET: "env-bucket",
			ATM_R2_ENDPOINT: "https://env.example",
			ATM_R2_PREFIX: "env-prefix",
			ATM_R2_SESSION_TOKEN: "token",
		};
		expect(resolveInputsDestination({}, env)).toEqual({
			kind: "r2",
			options: {
				bucket: "env-bucket",
				endpoint: "https://env.example",
				prefix: "env-prefix",
				accessKeyId: "id",
				secretAccessKey: "secret",
				sessionToken: "token",
			},
		});
		expect(
			resolveInputsDestination(
				{ r2Bucket: "flag-bucket", r2Endpoint: "http://127.0.0.1:8333" },
				env,
			),
		).toEqual({
			kind: "r2",
			options: {
				bucket: "flag-bucket",
				endpoint: "http://127.0.0.1:8333",
				prefix: "env-prefix",
				accessKeyId: "id",
				secretAccessKey: "secret",
				sessionToken: "token",
			},
		});
		expect(
			resolveInputsDestination(
				{ r2Bucket: "b", r2Endpoint: "https://e.example", r2Prefix: "flag" },
				credentials,
			),
		).toMatchObject({ options: { prefix: "flag" } });
	});

	test("credentials are never taken from a flag value, an empty variable is a missing one, and the endpoint must be a URL", () => {
		expect(() =>
			resolveInputsDestination(
				{ r2Bucket: "b", r2Endpoint: "https://e.example" },
				{ ATM_R2_ACCESS_KEY_ID: "", ATM_R2_SECRET_ACCESS_KEY: "secret" },
			),
		).toThrow("set ATM_R2_ACCESS_KEY_ID (there is no flag");
		expect(() =>
			resolveInputsDestination(
				{ r2Bucket: "b", r2Endpoint: "bucket.example" },
				credentials,
			),
		).toThrow("http:// or https://");
		expect(() => resolveInputsDestination({}, credentials)).toThrow(
			"give --root <folder>",
		);
		expect(
			resolveInputsDestination(
				{ r2Bucket: "b", r2Endpoint: "https://e.example" },
				credentials,
			),
		).toEqual({
			kind: "r2",
			options: {
				bucket: "b",
				endpoint: "https://e.example",
				accessKeyId: "id",
				secretAccessKey: "secret",
			},
		});
	});
});

describe("the batch day is UTC under any process time zone", () => {
	/** A database with one input committed at 23:59:59Z and one at 00:00:00Z (the world's B2 is committed at 00:00:20Z the next day). */
	const boundaryDatabase = (file: string) => {
		const raw = new Database(file, { create: true });
		const h = harness({ in_x1: 784, in_x2: 784 }, { raw });
		deliverFor(h, KEPT, "in_x1", Date.parse("2026-01-15T23:59:39Z"));
		deliverFor(
			h,
			KEPT,
			"in_x2",
			Date.parse("2026-01-15T23:59:40Z"),
			"subscription_cycle",
		);
		raw.close();
	};

	test("the same database ships to the same names under UTC, America/Denver and Pacific/Auckland", async () => {
		boundaryDatabase(databaseFile);
		const trees: Record<string, string>[] = [];
		for (const zone of ["UTC", "America/Denver", "Pacific/Auckland"]) {
			const database = join(folder, `${zone.replace("/", "-")}.sqlite`);
			await cp(databaseFile, database);
			const zoneRoot = join(folder, zone.replace("/", "-"));
			await mkdir(zoneRoot);
			const run = atm(
				[
					"inputs",
					"ship",
					"--db",
					database,
					"--school",
					SCHOOL,
					"--env",
					"live",
					"--root",
					zoneRoot,
					"--json",
				],
				{ TZ: zone },
			);
			expect(run.exitCode).toBe(0);
			expect(jsonLine(run.stdout.toString())).toMatchObject({
				batches: 2,
				shipped: 2,
			});
			trees.push(await readTree(zoneRoot));
		}
		const names = Object.keys(trees[0] ?? {})
			.filter((key) => key.includes("/batch-"))
			.map((key) => key.split("/")[4])
			.sort();
		// 23:59:59Z is the 15th and 00:00:00Z is the 16th, in every zone
		expect(names).toEqual(["date=2026-01-15", "date=2026-01-16"]);
		expect(trees[1]).toEqual(trees[0]);
		expect(trees[2]).toEqual(trees[0]);
	});
});
