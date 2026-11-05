/**
 * The reports hledger prints from the journals atm builds out of the golden year (`fixtures/vibes-year`). `journal.test.ts`
 * checks the journals; these check what a school's books say: the income statement, the balance sheet and the credit
 * balances, against the totals the fixture's own generator recorded (`expected.json`) and against committed CSV.
 * `UPDATE_GOLDEN=1` rewrites the CSV.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { journalMonth, readEvents } from "../src/ledger/files.js";
import { decimalToUnits } from "../src/ledger/util.js";
import { hasHledger, tmp } from "./helpers.js";

const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const GOLDEN = join(import.meta.dir, "golden/reports");
const SCHOOL = "sch_vol";
const CENTS = 2;

type Expected = { postingTotals: Record<string, string> };
const expected = (await Bun.file(
	join(FIXTURE, "expected.json"),
).json()) as Expected;

/** `postingTotals` entry for an account and commodity, in minor units (cents for USD, whole credits otherwise). */
const total = (account: string, commodity: string): bigint => {
	const text = expected.postingTotals[`${account} ${commodity}`];
	if (text === undefined)
		throw new Error(`no total for ${account} ${commodity}`);
	return decimalToUnits(text, commodity === "USD" ? CENTS : 0);
};

/** A copy of the fixture with every month journaled: `root` is the copy (to delete), `books` the school's directory hledger reads. */
const build = async (): Promise<{ root: string; books: string }> => {
	const root = await tmp("hledger-reports");
	await cp(FIXTURE, root, { recursive: true });
	const { events } = await readEvents(root, SCHOOL);
	const months = [
		...new Set(events.map((event) => event.date.slice(0, 7))),
	].sort();
	for (const month of months)
		await journalMonth({ root, school: SCHOOL, month });
	return { root, books: join(root, "schools", SCHOOL) };
};

const hledger = (cwd: string, args: string[]): string => {
	const run = Bun.spawnSync(["hledger", "-f", "main.journal", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(run.stderr.toString()).toBe("");
	expect(run.exitCode).toBe(0);
	return run.stdout.toString();
};

/** A CSV line of quoted cells. hledger quotes every cell and our accounts have no quote or comma in them. */
const cells = (line: string): string[] =>
	[...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] as string);

/** "2138.54 USD" -> 213854n; "0" -> 0n. */
const units = (amount: string, commodity: string): bigint => {
	if (amount === "0") return 0n;
	const [number, found] = amount.split(" ") as [string, string];
	expect(found).toBe(commodity);
	return decimalToUnits(
		number.replace(/,/g, ""),
		commodity === "USD" ? CENTS : 0,
	);
};

/** The rows of a one-column CSV report, by label (the first row of a label wins, so use a unique account name). */
const column = (csv: string): Map<string, string> => {
	const rows = new Map<string, string>();
	for (const line of csv.trim().split("\n")) {
		const [label, value] = cells(line);
		if (label !== undefined && value !== undefined && !rows.has(label))
			rows.set(label, value);
	}
	return rows;
};

const recordedAccounts = new Set(
	Object.keys(expected.postingTotals).map((key) => key.split(" ")[0]),
);

/**
 * Each account `rows` lists is a recorded one, and every recorded account under a prefix of `signs` has its recorded total times
 * the prefix's sign (hledger shows income negated). hledger drops an account whose balance is zero from a report,
 * so a missing row is zero: a recorded total that is not zero cannot hide, and neither can an account the generator never recorded.
 */
const expectRecorded = (
	rows: Map<string, string>,
	signs: Record<string, bigint>,
): void => {
	const prefixes = Object.keys(signs);
	for (const label of rows.keys()) {
		// the section headings have no colon, and "Total:" and "Net:" end in one: what is left is an account
		if (!label.includes(":") || label.endsWith(":")) continue;
		expect(
			prefixes.some((prefix) => label.startsWith(prefix)) &&
				recordedAccounts.has(label),
			`${label} is in the report but is not a recorded account`,
		).toBe(true);
	}
	for (const key of Object.keys(expected.postingTotals)) {
		const [account, commodity] = key.split(" ") as [string, string];
		const prefix = prefixes.find((candidate) => account.startsWith(candidate));
		if (prefix === undefined) continue;
		const shown = rows.get(account);
		expect(
			shown === undefined ? 0n : units(shown, commodity),
			`${account} ${commodity}`,
		).toBe((signs[prefix] as bigint) * total(account, commodity));
	}
};

const golden = async (name: string, csv: string) => {
	const path = join(GOLDEN, name);
	if (process.env.UPDATE_GOLDEN) {
		await mkdir(GOLDEN, { recursive: true });
		await writeFile(path, csv);
	}
	expect(csv).toBe(await Bun.file(path).text());
};

describe.skipIf(!hasHledger)("hledger reports on the golden year", () => {
	let root = "";
	let books = "";
	// the reports only read the journals: build them once and delete the copy
	beforeAll(async () => {
		({ root, books } = await build());
	});
	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("the income statement lines are the fixture's recorded totals, with the sign hledger gives each", async () => {
		const rows = column(hledger(books, ["is", "-O", "csv"]));
		// revenue accounts are credits (negative postings) that hledger shows as positive; a refund is a debit, shown negative
		expectRecorded(rows, { "income:": -1n, "expenses:": 1n });
		const revenue =
			-total("income:billing:membership:sparkle-1", "USD") -
			total("income:billing:membership:sparkle-2", "USD") -
			total("income:billing:refunds", "USD");
		expect(units(rows.get("Net:") as string, "USD")).toBe(
			revenue - total("expenses:billing:stripe-fees", "USD"),
		);
	});

	test("the balance sheet's cash is the income statement's net, and nothing is owed in dollars", async () => {
		const sheet = column(hledger(books, ["bs", "-O", "csv"]));
		const statement = column(hledger(books, ["is", "-O", "csv"]));
		// no liability is recorded, so none may be listed
		expectRecorded(sheet, { "assets:": 1n, "liabilities:": 1n });
		expect(sheet.get("assets:clearing:stripe-payouts")).toBe(
			statement.get("Net:"),
		);
		expect(sheet.get("Net:")).toBe(statement.get("Net:"));
	});

	test("credit balances are the recorded totals and the credit accounts sum to nothing", async () => {
		const rows = column(
			hledger(books, ["bal", "credits:", "--flat", "-O", "csv"]),
		);
		expectRecorded(rows, { "credits:": 1n });
		// every credit that was issued is available, held, spent, expired, forfeited or adjusted away: nothing is made or lost
		expect(rows.get("Total:")).toBe("0");
	});

	test("the monthly income statement, the balance sheet and the credit balances match the committed CSV", async () => {
		await golden(
			"income-statement-monthly.csv",
			hledger(books, ["is", "-M", "-O", "csv"]),
		);
		await golden("balance-sheet.csv", hledger(books, ["bs", "-O", "csv"]));
		await golden(
			"credits.csv",
			hledger(books, ["bal", "credits:", "--flat", "-O", "csv"]),
		);
		await golden(
			"refunds-register.csv",
			hledger(books, ["reg", "income:billing:refunds", "-O", "csv"]),
		);
	});
});
