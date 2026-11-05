/**
 * `atm ship` and `atm journal` as a schedule runs them: exit 0 done, 1 a conflict, 2 any other error with one line and no
 * stack trace, and `--json` as one machine-readable line. The shipping itself is `ship.test.ts`.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { planOutbox } from "../src/ledger/ship.js";
import { FolderStore } from "../src/store/folder-store.js";
import { utf8 } from "../src/store/store.js";
import { tmp } from "./helpers.js";

const SCHOOL = "sch_vol";
const BIN = join(import.meta.dir, "../src/bin.ts");
const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const STACK_FRAME = /\n\s+at /;

const bodyOf = (id: string, date: string) =>
	`{"id":"${id}","idem":"idem-${id}","date":"${date}"}`;

const ROWS = [
	{ id: "evt_a", date: "2026-01-15" },
	{ id: "evt_b", date: "2026-01-15" },
	{ id: "evt_c", date: "2026-02-15" },
];

let folder = "";
let databaseFile = "";
let root = "";

/** A handler database file with the rows in its outbox (none when `rows` is empty). */
const makeDatabase = (rows: typeof ROWS) => {
	const database = new Database(databaseFile, { create: true });
	const db = bunSqlite(database);
	db.exec(HANDLER_DDL);
	for (const row of rows)
		db.run(
			`INSERT INTO ledger_outbox (school_id, id, idem, date, body) VALUES (?, ?, ?, ?, ?)`,
			[SCHOOL, row.id, `idem-${row.id}`, row.date, bodyOf(row.id, row.date)],
		);
	database.close();
};

const atm = (args: string[], env: Record<string, string> = {}) =>
	Bun.spawnSync([process.execPath, BIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});

const ship = (...extra: string[]) =>
	atm([
		"ship",
		"--db",
		databaseFile,
		"--root",
		root,
		"--school",
		SCHOOL,
		...extra,
	]);

/** The one line `--json` prints: exactly one, valid JSON. */
const jsonLine = (stdout: string): Record<string, unknown> => {
	const lines = stdout.trimEnd().split("\n");
	expect(lines).toHaveLength(1);
	return JSON.parse(lines[0] as string) as Record<string, unknown>;
};

beforeEach(async () => {
	folder = await tmp("ship-cli-unattended");
	databaseFile = join(folder, "handler.sqlite");
	root = join(folder, "log");
	await mkdir(root);
});

afterEach(async () => {
	await rm(folder, { recursive: true, force: true });
});

describe("atm ship --json", () => {
	test("prints one line with the batches, the events shipped and nothing left, and exits 0", () => {
		makeDatabase(ROWS);
		const run = ship("--json");
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
		expect(jsonLine(run.stdout.toString())).toEqual({
			ok: true,
			school: SCHOOL,
			batches: 2,
			shipped: 3,
			conflicts: [],
			unshipped: 0,
			oldestUnshippedDate: null,
			oldestUnshippedAgeMs: null,
		});
	});

	test("with nothing to ship it exits 0 and says zero", () => {
		makeDatabase(ROWS);
		expect(ship().exitCode).toBe(0);
		const run = ship("--json");
		expect(run.exitCode).toBe(0);
		expect(jsonLine(run.stdout.toString())).toMatchObject({
			ok: true,
			batches: 0,
			shipped: 0,
			conflicts: [],
			unshipped: 0,
		});
	});

	test("an outbox with no row at all exits 0 too, with or without the flag", () => {
		makeDatabase([]);
		const human = ship();
		expect(human.exitCode).toBe(0);
		expect(human.stdout.toString()).toBe(
			"0 events shipped in 0 batches; 0 conflicts\n",
		);
		expect(ship("--json").exitCode).toBe(0);
	});

	test("a conflict exits 1, names its key and message on stdout and on stderr, and says what still waits", async () => {
		makeDatabase(ROWS);
		const [january] = planOutbox({
			school: SCHOOL,
			rows: ROWS.filter((row) => row.date === "2026-01-15").map((row) => ({
				...row,
				idem: `idem-${row.id}`,
				body: bodyOf(row.id, row.date),
			})),
		});
		const key = january?.key ?? "";
		await new FolderStore({ root }).putIfAbsent(
			key,
			utf8("not what the handler decided\n"),
		);
		const run = ship("--json");
		expect(run.exitCode).toBe(1);
		expect(run.stderr.toString()).toContain(`conflict ${key}:`);
		const summary = jsonLine(run.stdout.toString());
		expect(summary).toMatchObject({
			ok: false,
			batches: 1,
			shipped: 1,
			unshipped: 2,
			oldestUnshippedDate: "2026-01-15",
		});
		expect(summary.conflicts).toEqual([
			{ key, message: expect.stringContaining("different bytes") },
		]);
	});

	test("an error that is not a conflict exits 2 with one line and no stack trace", () => {
		const missing = ship("--json");
		expect(missing.exitCode).toBe(2);
		const message = missing.stderr.toString();
		expect(message.trimEnd().split("\n")).toHaveLength(1);
		expect(message).not.toMatch(STACK_FRAME);
		expect(jsonLine(missing.stdout.toString())).toMatchObject({ ok: false });
	});

	test("an error without the flag is the same one line on stderr and nothing on stdout", () => {
		const missing = ship();
		expect(missing.exitCode).toBe(2);
		expect(missing.stdout.toString()).toBe("");
		expect(missing.stderr.toString().trimEnd().split("\n")).toHaveLength(1);
	});

	test("a --root that is not a folder exits 2 and --json says why", () => {
		makeDatabase(ROWS);
		const run = atm([
			"ship",
			"--db",
			databaseFile,
			"--root",
			join(folder, "lgo"),
			"--school",
			SCHOOL,
			"--json",
		]);
		expect(run.exitCode).toBe(2);
		const summary = jsonLine(run.stdout.toString());
		expect(summary.ok).toBe(false);
		expect(summary.error).toContain("is not an existing folder");
	});

	test("a missing option exits 2, not 1, so it is not taken for a conflict", () => {
		const run = atm(["ship", "--db", databaseFile]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr.toString()).toContain("--root");
	});

	test("--help still exits 0", () => {
		expect(atm(["ship", "--help"]).exitCode).toBe(0);
	});
});

describe("atm journal --json", () => {
	test("prints one line with the month's transactions and what it wrote, then says unchanged", async () => {
		await cp(FIXTURE, root, { recursive: true });
		const args = [
			"journal",
			"--root",
			root,
			"--school",
			SCHOOL,
			"--month",
			"2026-03",
			"--json",
		];
		const first = atm(args);
		expect(first.exitCode).toBe(0);
		const built = jsonLine(first.stdout.toString());
		expect(built).toMatchObject({
			ok: true,
			month: "2026-03",
			unchanged: false,
		});
		expect(built.transactions).toBeGreaterThan(0);
		expect(built.written).toContain("main.journal");
		expect(jsonLine(atm(args).stdout.toString())).toMatchObject({
			ok: true,
			unchanged: true,
			written: [],
		});
	});

	test("without the flag it prints the sentence it always did", async () => {
		await cp(FIXTURE, root, { recursive: true });
		const run = atm([
			"journal",
			"--root",
			root,
			"--school",
			SCHOOL,
			"--month",
			"2026-03",
		]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout.toString()).toMatch(
			/^2026-03: \d+ transactions; wrote .*main\.journal/,
		);
	});

	test("a school with no events exits 2 with one line and no stack trace", () => {
		const run = atm([
			"journal",
			"--root",
			root,
			"--school",
			"sch_none",
			"--month",
			"2026-03",
		]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr.toString()).toContain("no events under");
		expect(run.stderr.toString()).not.toMatch(STACK_FRAME);
		expect(run.stderr.toString().trimEnd().split("\n")).toHaveLength(1);
	});
});
