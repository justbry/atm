/**
 * The second golden fixture (`fixtures/vibes-multi`): twelve families of one school from November 2026 to February 2027, with
 * a year boundary, school-day boundary payments, disputes won and lost, a fundraise, a cancel, an erasure, credit alerts and a
 * late event. `expected.json` is the generator's own ledger (see `fixtures/vibes-multi.ts`: money from its own arithmetic,
 * credits from the engine's events, never from `buildJournal`), so these tests are not circular.
 *
 * Each family of assertion is a function that returns its problems, and the suite runs it on the real books (no problem) and on
 * books with one thing broken (a problem): a check that cannot fail proves nothing. The CSV under `golden/multi` is rewritten
 * with `UPDATE_GOLDEN=1`, as the other goldens are. A last test builds 400 families by 12 months through the real handler.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MultiFixture } from "../fixtures/vibes-multi.js";
import { writeMultiFixture } from "../fixtures/write-multi.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { journalMonth, readEvents } from "../src/ledger/files.js";
import { buildJournal } from "../src/ledger/journal.js";
import { redactPayload } from "../src/ledger/postings.js";
import { reconcile } from "../src/ledger/reconcile.js";
import { decimalToUnits } from "../src/ledger/util.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent, ReconcileStripe } from "../src/types.js";
import { createStore } from "./billing-store.js";
import { hasHledger, readTree, tmp } from "./helpers.js";
import { invoicePaid } from "./stripe-events.js";

const FIXTURE = join(import.meta.dir, "../fixtures/vibes-multi");
const GOLDEN = join(import.meta.dir, "golden/multi");
const SCHOOL = "sch_multi";
const CENTS = 2;
const PERIOD = { from: "2026-11-01", to: "2027-03-31" };

type Expected = MultiFixture["expected"];
const expected = (await Bun.file(
	join(FIXTURE, "expected.json"),
).json()) as Expected;

const places = (commodity: string): number => (commodity === "USD" ? CENTS : 0);

/** `postingTotals` (or one month's) entry for an account and commodity, in minor units. */
const unitsOf = (
	totals: Record<string, string>,
	account: string,
	commodity: string,
): bigint => {
	const text = totals[`${account} ${commodity}`];
	return text === undefined ? 0n : decimalToUnits(text, places(commodity));
};
const total = (account: string, commodity: string): bigint =>
	unitsOf(expected.postingTotals, account, commodity);

const recordedAccounts = new Set(
	Object.keys(expected.postingTotals).map((key) => key.split(" ")[0]),
);

/** A fixture's events as `readEvents` reads them (the late batch included, a second delivery dropped). */
const eventsOf = async (root: string): Promise<AtmEvent[]> =>
	(await readEvents(root, SCHOOL)).events;

/** A copy of the fixture, every month journaled by `journalMonth`: `root` is the copy, `books` the school's directory hledger reads. */
const build = async (): Promise<{
	root: string;
	books: string;
	events: AtmEvent[];
	months: string[];
}> => {
	const root = await tmp("hledger-multi");
	await cp(FIXTURE, root, { recursive: true });
	const events = await eventsOf(root);
	const months = [
		...new Set(events.map((event) => event.date.slice(0, 7))),
	].sort();
	for (const month of months)
		await journalMonth({ root, school: SCHOOL, month });
	return { root, books: join(root, "schools", SCHOOL), events, months };
};

/** The journals of `events` as `buildJournal` makes them, written under a fresh directory: for books with one thing broken. */
const booksOf = async (events: readonly AtmEvent[]): Promise<string> => {
	const root = await tmp("hledger-multi-broken");
	const months = [...new Set(events.map((event) => event.date.slice(0, 7)))];
	for (const month of months) {
		const { files } = buildJournal({ events, month });
		for (const [path, text] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), text);
		}
	}
	return root;
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

/** The quoted cells of one CSV line. hledger quotes every cell and these accounts have no quote or comma in them. */
const cells = (line: string): string[] =>
	[...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] as string);

/** "2138.54 USD" -> 213854n; "1,300.00 USD" too; "0" -> 0n. */
const unitsFromCell = (cell: string, commodity: string): bigint => {
	if (cell === "0" || cell === "") return 0n;
	const [number, found] = cell.split(" ") as [string, string];
	if (found !== commodity) throw new Error(`${cell} is not in ${commodity}`);
	return decimalToUnits(number.replace(/,/g, ""), places(commodity));
};

/** The rows of a CSV report by their first cell (the first row of a label wins). */
const rowsOf = (csv: string): string[][] =>
	csv
		.trim()
		.split("\n")
		.map((line) => cells(line));

/** A report's account rows: labels with a colon that do not end in one (headings and "Total:" and "Net:" are not accounts). */
const isAccountRow = (label: string | undefined): label is string =>
	typeof label === "string" && label.includes(":") && !label.endsWith(":");

const commodityOfAccount = (account: string): string =>
	account.startsWith("credits:") ? "VISIT" : "USD";

// ---- the assertions: each returns what is wrong -------------------------------------------------------------------

/**
 * `hledger bal`: every account hledger lists is a recorded one, and every recorded account has its recorded total (an account
 * hledger drops has a zero balance, so a recorded total that is not zero cannot hide).
 */
const balProblems = (books: string): string[] => {
	const problems: string[] = [];
	const shown = new Map<string, string>();
	for (const [label, value] of rowsOf(
		hledger(books, ["bal", "--flat", "--no-total", "-O", "csv"]),
	).slice(1))
		if (label !== undefined && value !== undefined) shown.set(label, value);
	for (const account of shown.keys())
		if (!recordedAccounts.has(account))
			problems.push(`${account} is in the books but was never recorded`);
	for (const key of Object.keys(expected.postingTotals)) {
		const [account, commodity] = key.split(" ") as [string, string];
		const cell = shown.get(account);
		const got = cell === undefined ? 0n : unitsFromCell(cell, commodity);
		if (got !== total(account, commodity))
			problems.push(
				`${key}: books ${got}, recorded ${total(account, commodity)}`,
			);
	}
	return problems;
};

/**
 * The income statement, balance sheet and credit balances against the recorded totals. hledger shows income as a positive
 * number, so a prefix carries its sign; a liability and an asset are as recorded.
 */
const statementProblems = (books: string): string[] => {
	const problems: string[] = [];
	const check = (
		csv: string,
		signs: Record<string, bigint>,
		columnIndex = 1,
	) => {
		const rows = rowsOf(csv);
		const prefixes = Object.keys(signs);
		const shown = new Map<string, string>();
		for (const row of rows)
			if (isAccountRow(row[0]) && !shown.has(row[0] as string))
				shown.set(row[0] as string, row[columnIndex] as string);
		for (const account of shown.keys())
			if (
				!prefixes.some((prefix) => account.startsWith(prefix)) ||
				!recordedAccounts.has(account)
			)
				problems.push(
					`${account} is in the report but is not a recorded account`,
				);
		for (const key of Object.keys(expected.postingTotals)) {
			const [account, commodity] = key.split(" ") as [string, string];
			const prefix = prefixes.find((candidate) =>
				account.startsWith(candidate),
			);
			if (prefix === undefined) continue;
			const cell = shown.get(account);
			const got = cell === undefined ? 0n : unitsFromCell(cell, commodity);
			const want = (signs[prefix] as bigint) * total(account, commodity);
			if (got !== want)
				problems.push(`${key}: report ${got}, recorded ${want}`);
		}
		return rows;
	};
	const statement = check(hledger(books, ["is", "-O", "csv"]), {
		"income:": -1n,
		"expenses:": 1n,
	});
	const revenue =
		-total("income:billing:membership:sparkle-1", "USD") -
		total("income:billing:membership:sparkle-2", "USD") -
		total("income:billing:refunds", "USD") -
		total("income:fundraising:fall-fair", "USD");
	const net =
		revenue -
		total("expenses:billing:stripe-fees", "USD") -
		total("expenses:billing:disputes", "USD");
	const shownNet = statement.find((row) => row[0] === "Net:")?.[1] as string;
	if (unitsFromCell(shownNet, "USD") !== net)
		problems.push(`net income ${shownNet}, recorded ${net}`);
	check(hledger(books, ["bs", "-O", "csv"]), {
		"assets:": 1n,
		"liabilities:": 1n,
	});
	const credits = check(
		hledger(books, ["bal", "credits:", "--flat", "-O", "csv"]),
		{ "credits:": 1n },
	);
	// every credit issued is available, held, spent, expired, forfeited or adjusted away: the accounts sum to nothing
	if (credits.find((row) => row[0] === "Total:")?.[1] !== "0")
		problems.push("the credit accounts do not sum to nothing");
	return problems;
};

/** `is -M`: each month's income and expense accounts against what the generator booked in that school-local month. */
const monthlyProblems = (books: string): string[] => {
	const problems: string[] = [];
	const rows = rowsOf(hledger(books, ["is", "-M", "-O", "csv"]));
	const header = rows.find((row) => row[0] === "Account") as string[];
	const months = header.slice(1);
	const byAccount = new Map<string, string[]>();
	for (const row of rows)
		if (isAccountRow(row[0]) && !byAccount.has(row[0] as string))
			byAccount.set(row[0] as string, row.slice(1));
	for (const account of byAccount.keys())
		if (!recordedAccounts.has(account))
			problems.push(`${account} is in the report but was never recorded`);
	for (const [index, month] of months.entries()) {
		const recorded = expected.postingTotalsByMonth[month] ?? {};
		for (const account of [...recordedAccounts] as string[]) {
			const sign = account.startsWith("income:")
				? -1n
				: account.startsWith("expenses:")
					? 1n
					: 0n;
			if (sign === 0n) continue;
			const cell = byAccount.get(account)?.[index];
			const got = cell === undefined ? 0n : unitsFromCell(cell, "USD");
			const want = sign * unitsOf(recorded, account, "USD");
			if (got !== want)
				problems.push(`${month} ${account}: ${got}, recorded ${want}`);
		}
	}
	// a month the generator booked income in must be a column
	for (const month of Object.keys(expected.postingTotalsByMonth))
		if (
			Object.keys(expected.postingTotalsByMonth[month] ?? {}).some((key) =>
				key.startsWith("income:"),
			) &&
			!months.includes(month)
		)
			problems.push(`${month} is not a column`);
	return problems;
};

const codeOf = /^\d{4}-\d{2}-\d{2} \* \(([0-9A-Z]{26})\)/gm;
/** The transaction codes `hledger print` shows, with the date each is printed on. */
const printed = (books: string): Map<string, string> =>
	new Map(
		[...hledger(books, ["print"]).matchAll(codeOf)].map((match) => [
			match[1] as string,
			match[0].slice(0, 10),
		]),
	);

/** Transactions are the events with postings and no others, and each is on the day the event says. */
const transactionProblems = (
	books: string,
	events: readonly AtmEvent[],
): string[] => {
	const problems: string[] = [];
	const shown = printed(books);
	const withPostings = events.filter((event) => event.postings.length > 0);
	for (const event of events) {
		const day = shown.get(event.id);
		if (event.postings.length === 0 && day !== undefined)
			problems.push(
				`${event.event_type} ${event.id} has no postings but is a transaction`,
			);
		if (event.postings.length > 0 && day !== event.date)
			problems.push(`${event.id} is on ${day}, the event says ${event.date}`);
	}
	if (shown.size !== withPostings.length)
		problems.push(
			`${shown.size} transactions, ${withPostings.length} events with postings`,
		);
	return problems;
};

/** Each boundary payment is on the school-local day and in the school-local month's file, and in no other month's. */
const boundaryProblems = async (
	books: string,
	events: readonly AtmEvent[],
): Promise<string[]> => {
	const problems: string[] = [];
	const files = new Map<string, string>();
	for (const name of await readdir(join(books, "ledger/b4u")))
		files.set(
			name.replace(".journal", ""),
			await readFile(join(books, "ledger/b4u", name), "utf8"),
		);
	for (const item of expected.boundary) {
		const event = events.find((candidate) => candidate.idem === item.idem);
		if (!event) {
			problems.push(`${item.idem} is not in the log`);
			continue;
		}
		if (event.date !== item.localDate)
			problems.push(
				`${item.idem} is dated ${event.date}, local day ${item.localDate}`,
			);
		for (const [month, text] of files) {
			const has = text.includes(`(${event.id})`);
			if (has !== (month === item.month))
				problems.push(
					`${item.idem} ${has ? "is" : "is not"} in ${month}'s journal, local month ${item.month}`,
				);
		}
		const day = printed(books).get(event.id);
		if (day !== item.localDate)
			problems.push(
				`hledger prints ${item.idem} on ${day}, local day ${item.localDate}`,
			);
	}
	return problems;
};

/** Every file under `dir`, as text, for a search. */
const allText = async (dir: string): Promise<Map<string, string>> =>
	new Map(Object.entries(await readTree(dir)));

const leaks = (files: Map<string, string>, needles: string[]): string[] =>
	[...files].flatMap(([path, text]) =>
		needles
			.filter((needle) => text.includes(needle))
			.map((needle) => `${needle} is in ${path}`),
	);

const golden = async (name: string, csv: string) => {
	const path = join(GOLDEN, name);
	if (process.env.UPDATE_GOLDEN) {
		await mkdir(GOLDEN, { recursive: true });
		await writeFile(path, csv);
	}
	expect(csv).toBe(await Bun.file(path).text());
};

/** The events with `change` applied to the one with `idem`. */
const withEvent = (
	events: readonly AtmEvent[],
	idem: string,
	change: (event: AtmEvent) => AtmEvent | null,
): AtmEvent[] =>
	events.flatMap((event) => {
		if (event.idem !== idem) return [event];
		const changed = change(event);
		return changed ? [changed] : [];
	});

describe("the multi fixture's files", () => {
	let built: Awaited<ReturnType<typeof build>>;
	beforeAll(async () => {
		built = await build();
	});
	afterAll(async () => {
		await rm(built.root, { recursive: true, force: true });
	});

	test("it is what the generator writes: same seed, same bytes, in this process and in another time zone; the committed files are seed 1", async () => {
		const here = await tmp("multi-here");
		const there = await tmp("multi-there");
		const golden1 = await tmp("multi-golden");
		await writeMultiFixture({ seed: 3, outDir: here });
		const run = Bun.spawnSync(
			[
				"bun",
				join(import.meta.dir, "../fixtures/generate.ts"),
				"--only",
				"multi",
				"--seed",
				"3",
				"--multi-out",
				there,
			],
			{ env: { ...process.env, TZ: "America/Denver" } },
		);
		expect(run.exitCode).toBe(0);
		expect(await readTree(there)).toEqual(await readTree(here));
		await writeMultiFixture({ seed: 1, outDir: golden1 });
		expect(await readTree(golden1)).toEqual(await readTree(FIXTURE));
		const other = await tmp("multi-other");
		await writeMultiFixture({ seed: 2, outDir: other });
		expect(await readTree(other)).not.toEqual(await readTree(here));
	}, 60_000);

	test("twelve families, two tiers, four months and a March cron run; every event is valid and the log has the events the expected file counts", () => {
		expect(expected.holders).toHaveLength(12);
		expect(new Set(expected.holders.map((h) => h.tier))).toEqual(
			new Set(["sparkle-1", "sparkle-2"]),
		);
		expect(built.events).toHaveLength(expected.eventCount);
		expect(built.months).toEqual([
			"2026-11",
			"2026-12",
			"2027-01",
			"2027-02",
			"2027-03",
		]);
		for (const event of built.events)
			expect(validateEvent(event).errors, event.id).toEqual([]);
		const counts: Record<string, number> = {};
		for (const event of built.events)
			counts[event.event_type] = (counts[event.event_type] ?? 0) + 1;
		expect(counts).toEqual(expected.eventCountsByType);
		// what the fixture is there to catch is in it
		for (const type of [
			"payment.succeeded",
			"payment.refunded",
			"payment.disputed",
			"dispute.closed",
			"payout.paid",
			"fundraise.received",
			"fundraise.paid_out",
			"plan.canceled",
			"subject.erased",
			"credit.low",
			"credit.depleted",
			"credit.expiration_changed",
			"credit.forfeited",
		])
			expect(counts[type], type).toBeGreaterThan(0);
		const closed = built.events
			.filter((event) => event.event_type === "dispute.closed")
			.map((event) => event.payload.status)
			.sort();
		expect(closed).toEqual(["lost", "won"]);
		const holders = new Set(
			built.events
				.filter((event) => event.event_type === "payment.succeeded")
				.map((event) => event.key),
		);
		expect(holders.size).toBe(12);
	});

	test("expected.json is what the events' postings add up to, per account, commodity and school-local month", () => {
		const sum = (list: readonly AtmEvent[]) => {
			const out = new Map<string, bigint>();
			for (const event of list)
				for (const posting of event.postings) {
					const key = `${posting.account} ${posting.commodity}`;
					out.set(
						key,
						(out.get(key) ?? 0n) +
							decimalToUnits(posting.amount, places(posting.commodity)),
					);
				}
			return out;
		};
		const text = (map: Map<string, bigint>) =>
			Object.fromEntries(
				[...map].map(([key, units]) => [
					key,
					units === 0n
						? places(key.split(" ")[1] as string)
							? "0.00"
							: "0"
						: key.endsWith(" USD")
							? `${units < 0n ? "-" : ""}${(units < 0n ? -units : units) / 100n}.${String((units < 0n ? -units : units) % 100n).padStart(2, "0")}`
							: String(units),
				]),
			);
		expect(text(sum(built.events))).toEqual(expected.postingTotals);
		for (const [month, totals] of Object.entries(expected.postingTotalsByMonth))
			expect(
				text(
					sum(
						built.events.filter((event) => event.date.startsWith(`${month}-`)),
					),
				),
			).toEqual(totals);
		const transactions = Object.fromEntries(
			built.months.map((month) => [
				month,
				built.events.filter(
					(event) =>
						event.date.startsWith(`${month}-`) && event.postings.length > 0,
				).length,
			]),
		);
		expect(transactions).toEqual(expected.transactionsByMonth);
	});

	test("every payment at the school's midnight is on its local day and in its local month, which is not always the UTC one", async () => {
		expect(await boundaryProblems(built.books, built.events)).toEqual([]);
		const instants = expected.boundary.map((item) => item.instant);
		// the two the brief names: 23:30 on 31 December and 00:30 on 1 January, Denver (UTC-7)
		expect(instants).toContain("2027-01-01T06:30:00Z");
		expect(instants).toContain("2027-01-01T07:30:00Z");
		const dec31 = expected.boundary.find(
			(item) => item.instant === "2027-01-01T06:30:00Z",
		);
		expect(dec31).toMatchObject({
			localDate: "2026-12-31",
			utcDate: "2027-01-01",
			month: "2026-12",
			utcMonth: "2027-01",
		});
		const jan1 = expected.boundary.find(
			(item) => item.instant === "2027-01-01T07:30:00Z",
		);
		expect(jan1).toMatchObject({ localDate: "2027-01-01", month: "2027-01" });
		// the last evening of every month is the next month in UTC, and the journal keeps it in its own
		const crossing = expected.boundary.filter(
			(item) => item.month !== item.utcMonth,
		);
		expect(crossing.map((item) => item.month)).toEqual([
			"2026-11",
			"2026-11",
			"2026-12",
			"2026-12",
			"2027-01",
			"2027-01",
			"2027-02",
			"2027-02",
		]);
	});

	test("the boundary check fires: a payment dated by its UTC day lands in the wrong month's journal", async () => {
		const target = expected.boundary.find(
			(item) => item.instant === "2027-01-01T06:30:00Z",
		);
		const events = withEvent(built.events, target?.idem as string, (event) => ({
			...event,
			date: event.event_time.slice(0, 10),
		}));
		const broken = await booksOf(events);
		try {
			const problems = await boundaryProblems(broken, events);
			expect(problems.length).toBeGreaterThan(0);
			expect(problems.join("\n")).toContain("2027-01");
		} finally {
			await rm(broken, { recursive: true, force: true });
		}
	});

	test("no personal data of the erased family is in any event file or journal, and the rest of the families' is in the events and in no journal", async () => {
		const { personal, holder, objects } = expected.erased;
		const root = built.root;
		const events = await allText(join(root, "schools", SCHOOL, "events"));
		const journals = await allText(join(root, "schools", SCHOOL, "ledger"));
		expect(events.size).toBeGreaterThan(50);
		expect(journals.size).toBeGreaterThan(5);
		expect(leaks(events, personal)).toEqual([]);
		expect(leaks(journals, personal)).toEqual([]);
		// the control: the others' name and email are in the event payloads, so the search can find them, and not in a journal
		const others = Object.values(expected.personalByHolder).flat();
		expect(others.length).toBeGreaterThan(20);
		for (const needle of others) {
			expect(leaks(events, [needle]).length, needle).toBeGreaterThan(0);
			expect(leaks(journals, [needle]), needle).toEqual([]);
		}
		// the erased family's payments are what an erasure leaves: no personal field, and nothing left to redact
		const payments = built.events.filter(
			(event) =>
				event.key === holder && event.event_type === "payment.succeeded",
		);
		expect(payments).toHaveLength(4);
		for (const payment of payments) {
			expect(payment.payload).not.toHaveProperty("billing_email");
			expect(payment.payload).not.toHaveProperty("billing_name");
			expect(payment.redacted).toBeUndefined();
			expect(
				redactPayload(payment.event_type, payment.payload),
			).toBeUndefined();
		}
		// ... the money is still booked: erasure rewrites objects, it does not unwrite the books
		expect(total("income:billing:membership:sparkle-1", "USD")).toBe(-325000n);
		// the erasure event names the objects it rewrote, by id only
		const erasure = built.events.find(
			(event) => event.event_type === "subject.erased",
		);
		expect(erasure?.payload.objects).toEqual(objects);
		expect(erasure?.postings).toEqual([]);
		expect(objects).toEqual(payments.map((payment) => `event:${payment.id}`));
		// the others' payments keep a redacted copy without the personal fields
		const kept = built.events.filter(
			(event) =>
				event.event_type === "payment.succeeded" && event.key !== holder,
		);
		for (const payment of kept) {
			expect(payment.payload.billing_name).toBeString();
			expect(payment.redacted).toBeDefined();
			expect(payment.redacted).not.toHaveProperty("billing_name");
		}
	});

	test("the leak check fires: a name in an event's text reaches the journal", async () => {
		const [name] = expected.erased.personal as [string];
		const events = built.events.map((event) =>
			event.idem === expected.late.idem
				? { ...event, text: `membership payment from ${name}` }
				: event,
		);
		const broken = await booksOf(events);
		try {
			const found = leaks(await allText(join(broken, "ledger")), [name]);
			expect(found.length).toBeGreaterThan(0);
		} finally {
			await rm(broken, { recursive: true, force: true });
		}
	});

	test("the late payment is in a closed month's file only, a rerun writes nothing, and its second delivery of an event already in the log is dropped", async () => {
		const root = await tmp("multi-late");
		try {
			await cp(FIXTURE, root, { recursive: true });
			const lateFile = join(root, expected.late.file);
			const lateText = await readFile(lateFile, "utf8");
			expect(lateText.split("\n").filter(Boolean)).toHaveLength(2);
			await rm(lateFile);
			const beforeEvents = await eventsOf(root);
			expect(beforeEvents).toHaveLength(expected.eventCount - 1);
			const months = [
				...new Set(beforeEvents.map((event) => event.date.slice(0, 7))),
			].sort();
			expect(months).toContain(expected.late.month);
			for (const month of months)
				await journalMonth({ root, school: SCHOOL, month });
			const before = await readTree(join(root, "schools", SCHOOL));
			expect(Object.keys(before).some((path) => path.includes("late-"))).toBe(
				false,
			);

			// the late batch arrives, dated in a month already journaled
			await mkdir(dirname(lateFile), { recursive: true });
			await writeFile(lateFile, lateText);
			const afterEvents = await eventsOf(root);
			// two lines in the batch, one event added: the second delivery has the idem of an event the log already had
			expect(afterEvents).toHaveLength(expected.eventCount);
			expect(
				afterEvents.filter(
					(event) => event.idem === expected.late.duplicateIdem,
				),
			).toHaveLength(1);
			const written: string[] = [];
			for (const month of months)
				written.push(
					...(await journalMonth({ root, school: SCHOOL, month })).written.map(
						(path) => `${month}:${path}`,
					),
				);
			// only the late month's journal and the build record (which names its event files) change
			expect(written.sort()).toEqual([
				`${expected.late.month}:ledger/b4u/${expected.late.month}.journal`,
				`${expected.late.month}:ledger/build.json`,
			]);
			const after = await readTree(join(root, "schools", SCHOOL));
			const changed = Object.keys(after).filter(
				(path) => !path.startsWith("events/") && before[path] !== after[path],
			);
			expect(changed.sort()).toEqual([
				"ledger/b4u/2026-11.journal",
				"ledger/build.json",
			]);
			const lateEvent = afterEvents.find(
				(event) => event.id === expected.late.eventId,
			);
			expect(before[`ledger/b4u/${expected.late.month}.journal`]).not.toContain(
				`(${expected.late.eventId})`,
			);
			expect(after[`ledger/b4u/${expected.late.month}.journal`]).toContain(
				`(${expected.late.eventId})`,
			);
			expect(lateEvent?.date).toBe("2026-11-12");
			// the payout it re-delivered is one transaction, not two
			const payout = afterEvents.find(
				(event) => event.idem === expected.late.duplicateIdem,
			) as AtmEvent;
			expect(
				after[`ledger/b4u/${payout.date.slice(0, 7)}.journal`]?.split(
					`(${payout.id})`,
				),
			).toHaveLength(2);
			// a rerun of every month writes nothing
			for (const month of months)
				expect(
					(await journalMonth({ root, school: SCHOOL, month })).written,
				).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);
});

describe.skipIf(!hasHledger)("hledger on the multi fixture", () => {
	let built: Awaited<ReturnType<typeof build>>;
	beforeAll(async () => {
		built = await build();
	});
	afterAll(async () => {
		await rm(built.root, { recursive: true, force: true });
	});

	/** One broken copy of the events: the books built from it, the check run on them, the copy deleted. */
	const broken = async <T>(
		events: readonly AtmEvent[],
		run: (books: string) => T | Promise<T>,
	): Promise<T> => {
		const books = await booksOf(events);
		try {
			return await run(books);
		} finally {
			await rm(books, { recursive: true, force: true });
		}
	};

	test("hledger's check of balance, accounts and commodities passes, with one commodity per credit feature", () => {
		const run = Bun.spawnSync(
			[
				"hledger",
				"-f",
				"main.journal",
				"check",
				"balanced",
				"accounts",
				"commodities",
			],
			{ cwd: built.books, stdout: "pipe", stderr: "pipe" },
		);
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
		// twelve families on one commodity: the credit accounts are in VISIT and money is in USD, nothing else
		const commodities = hledger(built.books, ["commodities"])
			.trim()
			.split("\n");
		expect(commodities.sort()).toEqual(["USD", "VISIT"]);
	});

	test("check fails when a transaction does not balance (the check has teeth)", async () => {
		const events = withEvent(built.events, expected.late.idem, (event) => ({
			...event,
			postings: [
				...event.postings.slice(0, -1),
				{
					...(event.postings.at(-1) as AtmEvent["postings"][number]),
					amount: "-129.99",
				},
			],
		}));
		await broken(events, (books) => {
			const run = Bun.spawnSync(
				["hledger", "-f", "main.journal", "check", "balanced"],
				{ cwd: books, stdout: "pipe", stderr: "pipe" },
			);
			expect(run.exitCode).not.toBe(0);
		});
	});

	test("bal: every account's balance is its recorded total, and every account hledger lists was recorded", async () => {
		expect(balProblems(built.books)).toEqual([]);
		// a payment dropped from the books: its three accounts no longer match
		const dropped = withEvent(built.events, expected.late.idem, () => null);
		const problems = await broken(dropped, balProblems);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems.join("\n")).toContain(
			"income:billing:membership:sparkle-1 USD",
		);
		// an account nobody recorded: one posting moved to another account
		const stray = withEvent(built.events, expected.late.idem, (event) => ({
			...event,
			postings: event.postings.map((posting) =>
				posting.account === "assets:stripe"
					? { ...posting, account: "assets:stripe-typo" }
					: posting,
			),
		}));
		const strayProblems = await broken(stray, balProblems);
		expect(strayProblems.join("\n")).toContain(
			"assets:stripe-typo is in the books but was never recorded",
		);
	});

	test("the income statement, balance sheet and credit balances are the recorded totals, and the credit accounts sum to nothing", async () => {
		expect(statementProblems(built.books)).toEqual([]);
		// the lost dispute's debit is the only thing in expenses:billing:disputes, and income was not given back
		expect(total("expenses:billing:disputes", "USD")).toBe(26000n);
		expect(total("income:billing:refunds", "USD")).toBe(5000n);
		// a refund that is not booked: the income statement no longer agrees
		const refund = built.events.find(
			(event) => event.event_type === "payment.refunded",
		) as AtmEvent;
		const problems = await broken(
			withEvent(built.events, refund.idem, () => null),
			statementProblems,
		);
		expect(problems.length).toBeGreaterThan(0);
		// a credit grant whose offset went to a non-credit account: the credit accounts no longer sum to nothing
		const grant = built.events.find(
			(event) => event.event_type === "credit.granted",
		) as AtmEvent;
		const credits = await broken(
			withEvent(built.events, grant.idem, (event) => ({
				...event,
				postings: event.postings.map((posting) =>
					posting.account.startsWith("credits:issued:")
						? { ...posting, account: "equity:oops" }
						: posting,
				),
			})),
			statementProblems,
		);
		expect(credits.join("\n")).toContain("do not sum to nothing");
	});

	test("is -M: each month's income and expenses are what the generator booked in that school-local month", async () => {
		expect(monthlyProblems(built.books)).toEqual([]);
		// the 23:30 payment of 31 December filed under its UTC day moves 260.00 of income from December to January
		const target = expected.boundary.find(
			(item) => item.instant === "2027-01-01T06:30:00Z",
		) as { idem: string };
		const events = withEvent(built.events, target.idem, (event) => ({
			...event,
			date: event.event_time.slice(0, 10),
		}));
		const problems = await broken(events, monthlyProblems);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems.join("\n")).toMatch(
			/2026-12 income:billing:membership:sparkle-\d/,
		);
		expect(problems.join("\n")).toMatch(
			/2027-01 income:billing:membership:sparkle-\d/,
		);
	});

	test("events with no postings are not transactions; the rest are, each on its own day", async () => {
		const quiet = built.events.filter((event) => event.postings.length === 0);
		expect(new Set(quiet.map((event) => event.event_type))).toEqual(
			new Set([
				"credit.depleted",
				"credit.expiration_changed",
				"credit.low",
				"dispute.closed",
				"plan.attached",
				"plan.canceled",
				"subject.erased",
			]),
		);
		expect(transactionProblems(built.books, built.events)).toEqual([]);
		expect(printed(built.books).size).toBe(
			Object.values(expected.transactionsByMonth).reduce((a, b) => a + b, 0),
		);
		// a journal that prints an alert as a transaction is caught
		const alert = quiet.find(
			(event) => event.event_type === "credit.low",
		) as AtmEvent;
		const file = join(
			built.books,
			"ledger/b4u",
			`${alert.date.slice(0, 7)}.journal`,
		);
		const original = await readFile(file, "utf8");
		try {
			await writeFile(
				file,
				`${original}\n${alert.date} * (${alert.id}) credit.low | ${alert.text}\n    credits:expired  0 VISIT\n    credits:expired  0 VISIT\n`,
			);
			expect(
				transactionProblems(built.books, built.events).join("\n"),
			).toContain("has no postings but is a transaction");
		} finally {
			await writeFile(file, original);
		}
	});

	test("the lost dispute leaves its debit and the won one returns the money, on different families", () => {
		const disputes = built.events.filter(
			(event) => event.event_type === "payment.disputed",
		);
		const closed = built.events.filter(
			(event) => event.event_type === "dispute.closed",
		);
		expect(disputes).toHaveLength(2);
		expect(new Set(disputes.map((event) => event.key)).size).toBe(2);
		const lost = closed.find(
			(event) => event.payload.status === "lost",
		) as AtmEvent;
		const won = closed.find(
			(event) => event.payload.status === "won",
		) as AtmEvent;
		expect(lost.postings).toEqual([]);
		expect(won.postings.map((posting) => posting.account).sort()).toEqual([
			"assets:stripe",
			"expenses:billing:disputes",
		]);
		const register = hledger(built.books, [
			"reg",
			"expenses:billing:disputes",
			"-O",
			"csv",
		]);
		// debit 260.00 (lost), debit 260.00 and credit 260.00 (won): the account ends at 260.00
		const amounts = rowsOf(register)
			.slice(1)
			.map((row) => row[5]);
		expect(amounts.sort()).toEqual(["-260.00 USD", "260.00 USD", "260.00 USD"]);
		expect(rowsOf(register).at(-1)?.[6]).toBe("260.00 USD");
	});

	test("the fundraise is received and paid out through Zeffy's clearing account, with a gift after the payout left in it", () => {
		expect(total("assets:clearing:zeffy-payouts", "USD")).toBe(19500n);
		expect(total("assets:clearing:zeffy", "USD")).toBe(4000n);
		expect(total("income:fundraising:fall-fair", "USD")).toBe(-23500n);
	});

	test("the cancel family's credits are all gone by the end, as an expiry the books show, with its alerts and expiry change as quiet events", () => {
		const canceled = built.events.find(
			(event) => event.event_type === "plan.canceled",
		) as AtmEvent;
		const holder = canceled.key;
		const mine = built.events.filter((event) => event.key === holder);
		expect(
			mine.filter((event) => event.event_type === "credit.expiration_changed"),
		).toHaveLength(1);
		expect(
			mine.filter((event) => event.event_type === "payment.succeeded"),
		).toHaveLength(2);
		expect(total(`credits:avail:${holder}:visit`, "VISIT")).toBe(0n);
		expect(
			mine.filter((event) => event.event_type === "credit.expired").length,
		).toBeGreaterThan(0);
	});

	test("monthly income statement, balance sheet, credit balances and a family's credit register match the committed CSV", async () => {
		await golden(
			"income-statement-monthly.csv",
			hledger(built.books, ["is", "-M", "-O", "csv"]),
		);
		await golden(
			"balance-sheet.csv",
			hledger(built.books, ["bs", "-O", "csv"]),
		);
		await golden(
			"credits.csv",
			hledger(built.books, ["bal", "credits:", "--flat", "-O", "csv"]),
		);
		// the first family to be alerted: two sessions held one after another in November
		const alerted = expected.holders[4]?.holder as string;
		await golden(
			"credit-register-alerted-family.csv",
			hledger(built.books, [
				"reg",
				`credits:avail:${alerted}:visit`,
				"-O",
				"csv",
			]),
		);
		await golden(
			"disputes-register.csv",
			hledger(built.books, ["reg", "expenses:billing:disputes", "-O", "csv"]),
		);
	});
});

describe("reconcile on the multi fixture", () => {
	let events: AtmEvent[];
	beforeAll(async () => {
		events = await eventsOf(FIXTURE);
	});
	const stripe = (): ReconcileStripe =>
		structuredClone(expected.stripe) as ReconcileStripe;
	const run = (log: readonly AtmEvent[], side: ReconcileStripe = stripe()) =>
		reconcile({ events: log, stripe: side, period: PERIOD });
	const kinds = (differences: ReturnType<typeof run>["differences"]) =>
		differences.map((difference) => `${difference.kind} ${difference.object}`);
	const idOf = (type: AtmEvent["event_type"], index = 0): string =>
		events.filter((event) => event.event_type === type)[index]?.payload
			.id as string;

	test("the log reconciles clean against a Stripe side the generator built from its own decisions", () => {
		const result = run(events);
		expect(result.differences).toEqual([]);
		expect(result.notSupplied).toEqual([]);
		expect(result.period.timeZone).toBe("America/Denver");
		expect(result.counts.invoice).toEqual({ stripe: 47, log: 47 });
		expect(result.counts.refund).toEqual({ stripe: 1, log: 1 });
		expect(result.counts.dispute).toEqual({ stripe: 2, log: 2 });
		expect(result.counts.payout).toEqual({ stripe: 5, log: 5 });
		expect(result.counts.fees.log).toBe(47);
	});

	test("each month of the span reconciles clean by itself, the year boundary and the late payment included", () => {
		for (const month of ["2026-11", "2026-12", "2027-01", "2027-02"]) {
			const result = reconcile({ events, stripe: stripe(), period: { month } });
			expect(result.differences, month).toEqual([]);
		}
	});

	test("a dropped payment is reported, and the fee and net totals follow", () => {
		const id = idOf("payment.succeeded", 3);
		const dropped = events.filter((event) => event.payload.id !== id);
		const result = run(dropped);
		expect(kinds(result.differences)).toEqual([
			"missing_in_log invoice",
			"amount_differs fees",
			"amount_differs net",
		]);
		expect(
			result.differences.find((d) => d.kind === "missing_in_log"),
		).toMatchObject({
			id,
			eventType: "payment.succeeded",
		});
	});

	test("a changed refund is reported with both amounts", () => {
		const id = idOf("payment.refunded");
		const changed = events.map((event) =>
			event.payload.id === id
				? { ...event, payload: { ...event.payload, amount: 4999 } }
				: event,
		);
		const result = run(changed);
		const difference = result.differences.find((d) => d.object === "refund");
		expect(difference).toMatchObject({
			kind: "amount_differs",
			id,
			stripe: { amount: 5000 },
			log: { amount: 4999 },
		});
	});

	test("a dropped payout is reported", () => {
		const id = idOf("payout.paid", 2);
		const dropped = events.filter((event) => event.payload.id !== id);
		const result = run(dropped);
		expect(
			result.differences.map((d) => `${d.kind} ${d.object} ${d.id}`),
		).toContain(`missing_in_log payout ${id}`);
	});

	test("a dispute outcome that differs is reported", () => {
		const id = idOf("payment.disputed", 0);
		const flipped = events.map((event) =>
			event.event_type === "dispute.closed" && event.payload.id === id
				? { ...event, payload: { ...event.payload, status: "won" } }
				: event,
		);
		expect(kinds(run(flipped).differences).join()).toContain(
			"outcome_differs dispute",
		);
	});

	test("an event the late batch brought is needed: without it Stripe's payment is missing_in_log", () => {
		const without = events.filter(
			(event) => event.id !== expected.late.eventId,
		);
		const result = run(without);
		expect(kinds(result.differences)).toContain("missing_in_log invoice");
		expect(
			result.differences.find((d) => d.kind === "missing_in_log")?.log,
		).toBeNull();
	});
});

describe("scale: 400 families by 12 months through the real handler", () => {
	const FAMILIES = 400;
	const MONTHS = 12;
	const GROSS = 26_000;
	const TIME_BOUND_MS = 20_000;
	/** sparkle-2 refills two visits at each of its twelve payments; nothing is spent. */
	const GRANTED_PER_MONTH = 2;
	const feeOf = (cents: number) => Math.round(cents * 0.029) + 30;
	const menu = JSON.parse(
		readFileSync(
			join(import.meta.dir, "../fixtures/billing/grants/menu.json"),
			"utf8",
		),
	) as Menu;
	const sparkle2 = menu.tiers.find((tier) => tier.id === "sparkle-2");
	const lookupKey = lookupKeyOf(
		SCHOOL,
		tierPriceKey("sparkle-2", "month"),
		sparkle2?.prices.find((price) => price.interval === "month")
			?.amount as number,
		menu.currency,
	);

	test("the books balance, every account is what was generated, and it is built in well under the bound", async () => {
		const started = performance.now();
		const events: AtmEvent[] = [];
		const holders: string[] = [];
		for (let family = 0; family < FAMILIES; family++) {
			const familyId = `fam_scale${String(family).padStart(3, "0")}`;
			const store = createStore({ menu, school: SCHOOL, family: familyId });
			for (let month = 0; month < MONTHS; month++) {
				const at = Date.UTC(2026, month, 15, 18, family % 60);
				const periodEnd = Date.UTC(2026, month + 1, 15, 18, family % 60);
				store.handle(
					invoicePaid({
						eventId: `evt_${familyId}_${month}`,
						invoiceId: `in_${familyId}_${month}`,
						at,
						subscriptionId: `sub_${familyId}`,
						reason: month === 0 ? "subscription_create" : "subscription_cycle",
						periodStart: at,
						periodEnd,
						lines: [{ lookupKey, amount: GROSS, interval: "month" }],
						metadata: { b4u_school: SCHOOL, family_id: familyId },
					}),
					at,
					{ fee: feeOf(GROSS) },
				);
			}
			events.push(...store.events);
			holders.push(store.holder);
		}

		// no event twice, every event's postings sum to nothing per commodity
		expect(new Set(events.map((event) => event.idem)).size).toBe(events.length);
		const sums = new Map<string, bigint>();
		for (const event of events) {
			const perCommodity = new Map<string, bigint>();
			for (const posting of event.postings)
				perCommodity.set(
					posting.commodity,
					(perCommodity.get(posting.commodity) ?? 0n) +
						decimalToUnits(posting.amount, places(posting.commodity)),
				);
			for (const [commodity, units] of perCommodity)
				expect(units, `${event.id} ${commodity}`).toBe(0n);
			for (const posting of event.postings) {
				const key = `${posting.account} ${posting.commodity}`;
				sums.set(
					key,
					(sums.get(key) ?? 0n) +
						decimalToUnits(posting.amount, places(posting.commodity)),
				);
			}
		}
		// what was generated: 4,800 payments of 260.00, each with its fee
		const payments = BigInt(FAMILIES * MONTHS);
		const gross = payments * BigInt(GROSS);
		const fees = payments * BigInt(feeOf(GROSS));
		expect(sums.get("income:billing:membership:sparkle-2 USD")).toBe(-gross);
		expect(sums.get("expenses:billing:stripe-fees USD")).toBe(fees);
		expect(sums.get("assets:stripe USD")).toBe(gross - fees);

		// the journals, month by month, from the real engine's events
		const months = [
			...new Set(events.map((event) => event.date.slice(0, 7))),
		].sort();
		expect(months).toHaveLength(MONTHS);
		const root = await tmp("multi-scale");
		try {
			for (const month of months) {
				const { files } = buildJournal({ events, month });
				for (const [path, text] of Object.entries(files)) {
					await mkdir(dirname(join(root, path)), { recursive: true });
					await writeFile(join(root, path), text);
				}
			}
			const journaled = performance.now();
			expect(journaled - started).toBeLessThan(TIME_BOUND_MS);
			if (!hasHledger) return;
			const check = Bun.spawnSync(
				[
					"hledger",
					"-f",
					"main.journal",
					"check",
					"balanced",
					"accounts",
					"commodities",
				],
				{ cwd: root, stdout: "pipe", stderr: "pipe" },
			);
			expect(check.stderr.toString()).toBe("");
			expect(check.exitCode).toBe(0);
			const rows = rowsOf(
				hledger(root, ["bal", "--flat", "--no-total", "-O", "csv"]),
			).slice(1);
			const shown = new Map(
				rows.map((row) => [row[0] as string, row[1] as string]),
			);
			for (const [key, units] of sums) {
				const [account, commodity] = key.split(" ") as [string, string];
				const cell = shown.get(account);
				expect(
					cell === undefined ? 0n : unitsFromCell(cell, commodity),
					key,
				).toBe(units);
			}
			for (const account of shown.keys())
				expect(
					sums.has(`${account} ${commodityOfAccount(account)}`),
					account,
				).toBe(true);
			// 400 families: each has a credit account of its own, holding what the plan granted it (2 a month, 12 months)
			expect(
				[...shown.keys()].filter((account) =>
					account.startsWith("credits:avail:"),
				),
			).toHaveLength(FAMILIES);
			for (const holder of holders) {
				const cell = shown.get(`credits:avail:${holder}:visit`);
				expect(
					cell === undefined ? 0n : unitsFromCell(cell, "VISIT"),
					holder,
				).toBe(BigInt(GRANTED_PER_MONTH * MONTHS));
			}
			expect(shown.get("credits:issued:sparkle-2@v1")).toBe(
				`-${GRANTED_PER_MONTH * MONTHS * FAMILIES} VISIT`,
			);
			// the end-to-end time, with hledger's own passes
			expect(performance.now() - started).toBeLessThan(TIME_BOUND_MS);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 120_000);
});
