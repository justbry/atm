/**
 * `atm report` on the golden year (`fixtures/vibes-year`): the same hledger reports `hledger-reports.test.ts` checks, run
 * through the command, with the same numbers. The cases that need hledger skip without it; the case that says hledger
 * is missing runs everywhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { journalMonth, readEvents } from "../src/ledger/files.js";
import { hasHledger, readTree, tmp } from "./helpers.js";

const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const BIN = join(import.meta.dir, "../src/bin.ts");
const SCHOOL = "sch_vol";
const YEAR_NET = "2138.54 USD";
const STACK_FRAME = /\n\s+at /;

const atm = (args: string[], env: Record<string, string> = {}) =>
	Bun.spawnSync([process.execPath, BIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});

const report = (root: string, month: string, ...extra: string[]) =>
	atm([
		"report",
		"--root",
		root,
		"--school",
		SCHOOL,
		"--month",
		month,
		...extra,
	]);

/** The cells of the CSV row labelled `label`: hledger quotes every cell and our accounts have no quote in them. */
const row = (csv: string, label: string): string[] | undefined =>
	csv
		.split("\n")
		.map((line) => [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]))
		.find((cells) => cells[0] === label) as string[] | undefined;

describe("atm report", () => {
	let root = "";
	let months: string[] = [];
	// the journals of every month but the last are built once; each test builds the last through the command
	beforeAll(async () => {
		root = await tmp("report");
		await cp(FIXTURE, root, { recursive: true });
		const { events } = await readEvents(root, SCHOOL);
		months = [...new Set(events.map((event) => event.date.slice(0, 7)))].sort();
		for (const month of months.slice(0, -1))
			await journalMonth({ root, school: SCHOOL, month });
	});
	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test.skipIf(!hasHledger)(
		"builds the month's journal, then the income statement's net for the year is the golden 2,138.54 USD",
		async () => {
			const run = report(
				root,
				months.at(-1) as string,
				"--report",
				"income-statement",
				"--format",
				"csv",
			);
			expect(run.stderr.toString()).toBe("");
			expect(run.exitCode).toBe(0);
			expect(row(run.stdout.toString(), "Net:")?.[1]).toBe(YEAR_NET);
			// the month it was asked for was built by the command, not before it
			expect(
				(await readdir(join(root, "schools", SCHOOL, "ledger/b4u"))).sort(),
			).toEqual(months.map((month) => `${month}.journal`));
		},
	);

	test.skipIf(!hasHledger)(
		"the balance sheet's cash is that net, and the credit accounts sum to nothing",
		() => {
			const month = months.at(-1) as string;
			const sheet = report(
				root,
				month,
				"--report",
				"balance-sheet",
				"--format",
				"csv",
			);
			expect(sheet.exitCode).toBe(0);
			expect(row(sheet.stdout.toString(), "Net:")?.[1]).toBe(YEAR_NET);
			expect(
				row(sheet.stdout.toString(), "assets:clearing:stripe-payouts")?.[1],
			).toBe(YEAR_NET);
			const credits = report(
				root,
				month,
				"--report",
				"credits",
				"--format",
				"csv",
			);
			expect(credits.exitCode).toBe(0);
			expect(row(credits.stdout.toString(), "Total:")?.[1]).toBe("0");
		},
	);

	test.skipIf(!hasHledger)(
		"with no --report it prints all three, as the default table",
		() => {
			const run = report(root, months.at(-1) as string);
			expect(run.exitCode).toBe(0);
			const text = run.stdout.toString();
			expect(text).toContain("Income Statement");
			expect(text).toContain("Balance Sheet");
			expect(text).toContain("credits:");
			expect(text).toContain("2,138.54 USD");
		},
	);

	test.skipIf(!hasHledger)("a second run changes no file", async () => {
		const month = months.at(-1) as string;
		const books = join(root, "schools", SCHOOL);
		expect(report(root, month, "--report", "credits").exitCode).toBe(0);
		const before = await readTree(books);
		const again = report(root, month, "--report", "credits");
		expect(again.exitCode).toBe(0);
		expect(again.stderr.toString()).toBe("");
		expect(await readTree(books)).toEqual(before);
	});

	test("a --report or --format it does not know exits 2 and builds nothing", async () => {
		const fresh = await tmp("report-bad-option");
		await cp(FIXTURE, fresh, { recursive: true });
		const badReport = report(fresh, "2026-03", "--report", "cashflow");
		expect(badReport.exitCode).toBe(2);
		expect(badReport.stderr.toString()).toContain("--report cashflow");
		const badFormat = report(fresh, "2026-03", "--format", "pdf");
		expect(badFormat.exitCode).toBe(2);
		expect(badFormat.stderr.toString()).toContain("--format pdf");
		expect(await readdir(join(fresh, "schools", SCHOOL))).toEqual(["events"]);
		await rm(fresh, { recursive: true, force: true });
	});

	test("says clearly and exits 2, writing nothing, when hledger is not on PATH", async () => {
		const fresh = await tmp("report-no-hledger");
		await cp(FIXTURE, fresh, { recursive: true });
		const emptyPath = join(fresh, "empty-bin");
		await mkdir(emptyPath);
		const run = atm(
			["report", "--root", fresh, "--school", SCHOOL, "--month", "2026-03"],
			{ PATH: emptyPath },
		);
		expect(run.exitCode).toBe(2);
		expect(run.stdout.toString()).toBe("");
		const message = run.stderr.toString();
		expect(message).toContain("hledger is not installed or not on PATH");
		expect(message).not.toMatch(STACK_FRAME);
		expect(message.trimEnd().split("\n")).toHaveLength(1);
		expect(await readdir(join(fresh, "schools", SCHOOL))).toEqual(["events"]);
		await rm(fresh, { recursive: true, force: true });
	});

	test("an hledger that fails without a word on stderr still gives a one-line message and exit 2", async () => {
		const fresh = await tmp("report-silent-hledger");
		await cp(FIXTURE, fresh, { recursive: true });
		const fakeBin = join(fresh, "fake-bin");
		await mkdir(fakeBin);
		const fake = join(fakeBin, "hledger");
		await Bun.write(
			fake,
			'#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexit 3\n',
		);
		await chmod(fake, 0o755);
		const run = atm(
			["report", "--root", fresh, "--school", SCHOOL, "--month", "2026-03"],
			{ PATH: `${fakeBin}:${process.env.PATH}` },
		);
		expect(run.exitCode).toBe(2);
		expect(run.stdout.toString()).toBe("");
		expect(run.stderr.toString().trimEnd().split("\n")).toEqual([
			"hledger income-statement failed: no message",
		]);
		await rm(fresh, { recursive: true, force: true });
	});

	test("a school with no events exits 2 with one line", () => {
		const run = atm([
			"report",
			"--root",
			root,
			"--school",
			"sch_none",
			"--month",
			"2026-03",
		]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr.toString()).not.toMatch(STACK_FRAME);
	});
});
