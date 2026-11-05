/**
 * The ledger helpers the CLI uses and a library caller needs too (0.9.0), called through `src/index.ts`: one real call
 * each, on the golden year (`fixtures/vibes-year`) or on small values worked by hand.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import envelope from "../schema/envelope.v1.json";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import {
	type AtmCatalogRow,
	type AtmEvent,
	appendToOutbox,
	balancesOf,
	canonicalize,
	decimalToUnits,
	duckdbDdl,
	HledgerError,
	journalMonth,
	ledgerEvent,
	localDate,
	REPORT_NAMES,
	readEvents,
	replayEvents,
	reportMonth,
} from "../src/index.js";
import { hasHledger, tmp } from "./helpers.js";

const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const SCHOOL = "sch_vol";
const YEAR_NET = "2138.54 USD";

let root = "";
let months: string[] = [];
let events: AtmEvent[] = [];

beforeAll(async () => {
	root = await tmp("sdk-exports");
	await cp(FIXTURE, root, { recursive: true });
	({ events } = await readEvents(root, SCHOOL));
	months = [...new Set(events.map((event) => event.date.slice(0, 7)))].sort();
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("reading a school's folder", () => {
	test("readEvents returns the events sorted by id, once per idem, with each file's line count", async () => {
		const read = await readEvents(root, SCHOOL);
		expect(read.events.length).toBe(81);
		expect(read.events.map((event) => event.id)).toEqual(
			read.events.map((event) => event.id).sort(),
		);
		expect(new Set(read.events.map((event) => event.idem)).size).toBe(81);
		expect(read.files.reduce((sum, file) => sum + file.lines, 0)).toBe(81);
	});

	test("journalMonth writes the month's journal, then a second run writes nothing", async () => {
		const month = months[0] as string;
		const first = await journalMonth({ root, school: SCHOOL, month });
		expect(first.unchanged).toBe(false);
		expect(first.written).toContain(`ledger/b4u/${month}.journal`);
		expect(first.build.month).toBe(month);
		const again = await journalMonth({ root, school: SCHOOL, month });
		expect(again.unchanged).toBe(true);
		expect(again.written).toEqual([]);
	});

	test("journalMonth throws for a school with no events", async () => {
		await expect(
			journalMonth({ root, school: "sch_none", month: "2026-01" }),
		).rejects.toThrow("no events under");
	});

	test("reportMonth throws a HledgerError that names the tool, and writes nothing, when hledger is not on PATH", async () => {
		const fresh = await tmp("sdk-exports-no-hledger");
		await cp(FIXTURE, fresh, { recursive: true });
		// a child process: Bun resolves a binary against the PATH it started with, so a changed process.env.PATH here would not hide hledger
		const script = [
			`import { HledgerError, reportMonth } from ${JSON.stringify(join(import.meta.dir, "../src/index.js"))};`,
			`try { await reportMonth({ root: ${JSON.stringify(fresh)}, school: ${JSON.stringify(SCHOOL)}, month: ${JSON.stringify(months[0])} }); }`,
			"catch (error) { console.log(JSON.stringify({ isHledgerError: error instanceof HledgerError, message: error.message })); }",
		].join("\n");
		const run = Bun.spawnSync([process.execPath, "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: await tmp("sdk-exports-empty-path") },
		});
		expect(run.stderr.toString()).toBe("");
		const outcome = JSON.parse(run.stdout.toString()) as {
			isHledgerError: boolean;
			message: string;
		};
		expect(outcome.isHledgerError).toBe(true);
		expect(outcome.message).toContain(
			"hledger is not installed or not on PATH",
		);
		await expect(
			readFile(join(fresh, "schools", SCHOOL, "main.journal")),
		).rejects.toThrow();
		await rm(fresh, { recursive: true, force: true });
	});

	test.skipIf(!hasHledger)(
		"reportMonth runs the three reports over the year: net 2,138.54 USD",
		async () => {
			for (const month of months.slice(0, -1))
				await journalMonth({ root, school: SCHOOL, month });
			const run = await reportMonth({
				root,
				school: SCHOOL,
				month: months.at(-1) as string,
				report: "income-statement",
				format: "csv",
			});
			expect(run.reports.map((report) => report.report)).toEqual([
				"income-statement",
			]);
			expect(run.reports[0]?.text).toContain(YEAR_NET);
			expect(run.skippedNonUsd).toEqual({ inMonth: 0, total: 0 });
			const all = await reportMonth({
				root,
				school: SCHOOL,
				month: months.at(-1) as string,
			});
			expect(all.reports.map((report) => report.report)).toEqual([
				...REPORT_NAMES,
			]);
			expect(all.journal.unchanged).toBe(true);
		},
	);

	test("REPORT_NAMES lists the three reports", () => {
		expect([...REPORT_NAMES]).toEqual([
			"income-statement",
			"balance-sheet",
			"credits",
		]);
	});

	test("HledgerError is an Error a caller can catch by class", () => {
		const error = new HledgerError("hledger is not installed");
		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(HledgerError);
		expect(error.message).toBe("hledger is not installed");
	});
});

describe("balances and event helpers", () => {
	test("balancesOf over a replay's snapshot is the replay's own balances", async () => {
		const catalog = JSON.parse(
			await readFile(join(FIXTURE, "catalog.json"), "utf8"),
		) as AtmCatalogRow[];
		const replay = replayEvents({ events, catalog });
		expect(replay.balances.length).toBeGreaterThan(0);
		const balances = balancesOf({
			states: replay.snapshot.states,
			holds: replay.snapshot.holds,
			catalog,
			asOfMs: Date.parse(replay.asOf as string),
		});
		expect(balances).toEqual(replay.balances);
	});

	test("balancesOf leaves out a row past its expiry and counts a hold as held", () => {
		const holds = {
			lock: { holder: "family:fam_x", feature: "visit", units: 2 },
		};
		expect(balancesOf({ states: {}, holds, catalog: [], asOfMs: 0 })).toEqual([
			{ holder: "family:fam_x", feature: "visit", avail: 0, held: 2 },
		]);
	});

	test("canonicalize sorts keys at every depth and drops undefined fields", () => {
		expect(
			canonicalize({ b: 1, a: { d: [{ z: 1, y: undefined, x: 2 }], c: 0 } }),
		).toBe('{"a":{"c":0,"d":[{"x":2,"z":1}]},"b":1}');
		expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
	});

	test("localDate takes the date in the school's zone, across the UTC day", () => {
		const instant = Date.parse("2026-11-03T03:30:00Z");
		expect(localDate(instant, "UTC")).toBe("2026-11-03");
		expect(localDate(instant, "America/Denver")).toBe("2026-11-02");
	});

	test("decimalToUnits reads a posting's amount as whole units and refuses a fraction it would lose", () => {
		expect(decimalToUnits("130.00", 2)).toBe(13000n);
		expect(decimalToUnits("-0.5", 2)).toBe(-50n);
		expect(decimalToUnits("7", 0)).toBe(7n);
		expect(() => decimalToUnits("1.005", 2)).toThrow(
			"more than 2 decimal places",
		);
		expect(() => decimalToUnits("abc", 2)).toThrow("not a decimal string");
	});

	test("duckdbDdl makes the events table from the envelope schema", () => {
		const sql = duckdbDdl(envelope);
		expect(sql).toContain("event_time TIMESTAMPTZ NOT NULL");
		expect(sql).toContain("labels MAP(VARCHAR, VARCHAR) NOT NULL");
	});
});

describe("appendToOutbox", () => {
	const payout = (idem: string): AtmEvent =>
		ledgerEvent({
			school: SCHOOL,
			tz: "America/Denver",
			eventTime: "2026-11-03T17:02:11Z",
			key: "school:sch_vol",
			type: "payout.paid",
			amount: 1000,
			idem,
			revision: 1,
		});

	test("inserts a ledgerEvent's line once per idem and env, and reports the rows inserted", () => {
		const db = bunSqlite(new Database(":memory:"));
		db.exec(HANDLER_DDL);
		const event = payout("payout:po_1");
		expect(appendToOutbox(db, [event], "live")).toBe(1);
		expect(appendToOutbox(db, [event], "live")).toBe(0);
		expect(appendToOutbox(db, [event], "test")).toBe(1);
		const rows = db.all<{ env: string; body: string }>(
			"SELECT env, body FROM ledger_outbox ORDER BY env",
		);
		expect(rows.map((row) => row.env)).toEqual(["live", "test"]);
		expect(rows[0]?.body).toBe(canonicalize(event));
	});
});
