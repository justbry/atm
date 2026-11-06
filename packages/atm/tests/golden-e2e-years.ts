/**
 * S2: the two golden logs (`fixtures/vibes-year`, one school and a year; `fixtures/vibes-multi`, twelve families across a year
 * boundary) put into a handler database file as outbox rows, then shipped, journaled, reported and reconciled by the `atm`
 * command line, and compared byte for byte with `golden/journal`, `golden/reports` and `golden/multi`.
 *
 * These fixtures are logs, not Stripe inputs: there is nothing for `atm inputs ship` or `atm simulate --inputs` to read, and
 * the run says so (an empty inputs ship exits 0, a simulate exits 2 with its sentence).
 */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { readEvents } from "../src/ledger/files.js";
import { appendToOutbox } from "../src/ledger/outbox.js";
import { canonicalize } from "../src/ledger/util.js";
import type { AtmEvent, ReconcileStripe } from "../src/types.js";
import { type RunOptions, readOnly, step } from "./golden-e2e-cases.js";
import {
	createWalDatabase,
	differences,
	fingerprint,
	fingerprintHash,
	firstDifference,
	makeWorld,
	Outcomes,
	objectsOnly,
	type World,
	writeStripeSide,
} from "./golden-e2e-lib.js";
import { stripeSideOf } from "./stripe-side.js";

const FIXTURES = join(import.meta.dir, "../fixtures");
const GOLDEN = join(import.meta.dir, "golden");
const JOURNAL_MONTH = "2026-03";

export type LogFixtureName = "vibes-year" | "vibes-multi";

const SCHOOL_OF: Record<LogFixtureName, string> = {
	"vibes-year": "sch_vol",
	"vibes-multi": "sch_multi",
};

const golden = (...parts: string[]): string =>
	readFileSync(join(GOLDEN, ...parts), "utf8");

const hledger = (books: string, args: readonly string[]): string => {
	const run = Bun.spawnSync(["hledger", "-f", "main.journal", ...args], {
		cwd: books,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (run.exitCode !== 0 || run.stderr.toString() !== "")
		throw new Error(`hledger ${args.join(" ")}: ${run.stderr.toString()}`);
	return run.stdout.toString();
};

/** A tree of text files under `dir`, relative path -> text. */
const textTree = (dir: string, rel = ""): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) Object.assign(out, textTree(dir, path));
		else out[path] = readFileSync(join(dir, path), "utf8");
	}
	return out;
};

/** The handler database of a school that only has a log: the outbox holds the fixture's events, nothing else. */
export const buildOutboxWorld = (
	events: readonly AtmEvent[],
	world: World,
	school: string,
): void => {
	const file = world.databaseFor(school);
	createWalDatabase(file);
	const raw = new Database(file);
	const db = bunSqlite(raw);
	db.exec(HANDLER_DDL);
	db.transaction(() => appendToOutbox(db, events, "live"));
	raw.close();
};

const monthsOf = (events: readonly AtmEvent[]): string[] =>
	[...new Set(events.map((event) => event.date.slice(0, 7)))].sort();

/** build.json minus the files: the shipper writes one batch per day under its own name, the fixture several files a day. */
const buildRecord = (text: string): unknown => {
	const record = JSON.parse(text) as {
		months: Record<
			string,
			{
				inputs_hash: string;
				transactions: number;
				events: { key: string; sha256: string; lines: number }[];
			}
		>;
	};
	return Object.fromEntries(
		Object.entries(record.months).map(([month, entry]) => [
			month,
			{
				transactions: entry.transactions,
				eventLines: entry.events.reduce((total, file) => total + file.lines, 0),
			},
		]),
	);
};

export const checkLogFixture = async (
	name: LogFixtureName,
	options: RunOptions,
): Promise<Outcomes> => {
	const rec = new Outcomes(name);
	const school = SCHOOL_OF[name];
	const fixture = join(FIXTURES, name);
	const world = await makeWorld(name);
	try {
		const { events } = await readEvents(fixture, school);
		buildOutboxWorld(events, world, school);
		const database = world.databaseFor(school);

		// ---- inputs ship and simulate --inputs have nothing to read, and say so ----
		const emptyShip = step(
			rec,
			"inputs ship (a log with no stored inputs)",
			[
				"inputs",
				"ship",
				"--db",
				database,
				"--school",
				school,
				"--env",
				"live",
				"--root",
				world.root,
				"--json",
			],
			options,
		);
		rec.expect(
			"inputs ship: ships nothing and says ok",
			emptyShip.stdout.includes('"ok":true') &&
				emptyShip.stdout.includes('"shipped":0'),
			() => emptyShip.stdout.slice(0, 300),
		);

		// ---- ship: the outbox to a folder ----
		const shipArgs = [
			"ship",
			"--db",
			database,
			"--root",
			world.root,
			"--school",
			school,
			"--json",
		];
		const shipped = step(rec, "ship", shipArgs, options);
		const afterShip = fingerprint(world.root);
		const again = step(rec, "ship rerun", shipArgs, options);
		rec.expect(
			"ship rerun: nothing added",
			differences(afterShip, fingerprint(world.root)).length === 0 &&
				again.stdout.includes('"shipped":0'),
			() => again.stdout.slice(0, 200),
		);
		const back = await readEvents(world.root, school);
		rec.expect(
			`ship: the shipped log reads back as the fixture's ${events.length} events, byte for byte`,
			back.events.length === events.length &&
				back.events.every(
					(event, index) =>
						canonicalize(event) === canonicalize(events[index] as AtmEvent),
				),
			() => `${back.events.length} events; ${shipped.stdout.slice(0, 200)}`,
		);

		// ---- journal: the golden month first, so main.journal includes only it, as the golden does ----
		if (name === "vibes-year") {
			step(
				rec,
				`journal ${JOURNAL_MONTH}`,
				[
					"journal",
					"--root",
					world.root,
					"--school",
					school,
					"--month",
					JOURNAL_MONTH,
				],
				options,
			);
			const tree = textTree(join(world.root, "schools", school));
			const want = textTree(join(GOLDEN, "journal"));
			for (const path of Object.keys(want).sort()) {
				if (path === "ledger/build.json") {
					rec.expect(
						"golden journal ledger/build.json: same months, transactions and event lines (the files differ by design: the shipper writes one batch per day)",
						JSON.stringify(buildRecord(tree[path] as string)) ===
							JSON.stringify(buildRecord(want[path] as string)),
						() =>
							firstDifference(
								JSON.stringify(buildRecord(tree[path] as string)),
								JSON.stringify(buildRecord(want[path] as string)),
							),
					);
					continue;
				}
				rec.expect(
					`golden journal ${path}: byte for byte`,
					tree[path] === want[path],
					() => firstDifference(tree[path] ?? "", want[path] ?? ""),
				);
			}
		}
		const months = monthsOf(events);
		for (const month of months)
			step(
				rec,
				`journal ${month}`,
				["journal", "--root", world.root, "--school", school, "--month", month],
				options,
			);
		const last = months.at(-1) as string;
		const report = (reportName: string): string =>
			step(
				rec,
				`report ${reportName}`,
				[
					"report",
					"--root",
					world.root,
					"--school",
					school,
					"--month",
					last,
					"--report",
					reportName,
					"--format",
					"csv",
				],
				options,
			).stdout;
		const books = join(world.root, "schools", school);
		const compare = (file: string, got: string, want: string) =>
			rec.expect(`golden ${file}: byte for byte`, got === want, () =>
				firstDifference(got, want),
			);
		if (name === "vibes-year") {
			compare(
				"reports/income-statement-monthly.csv",
				hledger(books, ["is", "-M", "-O", "csv"]),
				golden("reports", "income-statement-monthly.csv"),
			);
			compare(
				"reports/balance-sheet.csv",
				report("balance-sheet"),
				golden("reports", "balance-sheet.csv"),
			);
			compare(
				"reports/credits.csv",
				report("credits"),
				golden("reports", "credits.csv"),
			);
			compare(
				"reports/refunds-register.csv",
				hledger(books, ["reg", "income:billing:refunds", "-O", "csv"]),
				golden("reports", "refunds-register.csv"),
			);
			report("income-statement");
		} else {
			const expected = JSON.parse(
				await readFile(join(fixture, "expected.json"), "utf8"),
			) as { holders: { holder: string }[] };
			const alerted = expected.holders[4]?.holder as string;
			compare(
				"multi/income-statement-monthly.csv",
				hledger(books, ["is", "-M", "-O", "csv"]),
				golden("multi", "income-statement-monthly.csv"),
			);
			compare(
				"multi/balance-sheet.csv",
				report("balance-sheet"),
				golden("multi", "balance-sheet.csv"),
			);
			compare(
				"multi/credits.csv",
				report("credits"),
				golden("multi", "credits.csv"),
			);
			compare(
				"multi/credit-register-alerted-family.csv",
				hledger(books, ["reg", `credits:avail:${alerted}:visit`, "-O", "csv"]),
				golden("multi", "credit-register-alerted-family.csv"),
			);
			compare(
				"multi/disputes-register.csv",
				hledger(books, ["reg", "expenses:billing:disputes", "-O", "csv"]),
				golden("multi", "disputes-register.csv"),
			);
			report("income-statement");
		}

		// ---- reconcile against a Stripe side built from the fixture's own records ----
		const stripe: ReconcileStripe =
			name === "vibes-year"
				? stripeSideOf(back.events)
				: ((
						JSON.parse(
							await readFile(join(fixture, "expected.json"), "utf8"),
						) as { stripe: ReconcileStripe }
					).stripe as ReconcileStripe);
		await writeStripeSide(world.stripeFor(school), stripe);
		const periods =
			name === "vibes-year"
				? months.map((month) => ["--month", month])
				: [
						["--from", "2026-11-01", "--to", "2027-03-31"],
						...months.map((month) => ["--month", month]),
					];
		for (const period of periods) {
			const run = readOnly(
				rec,
				world,
				`reconcile ${period.join(" ")}`,
				[
					"reconcile",
					"--root",
					world.root,
					"--school",
					school,
					"--stripe",
					world.stripeFor(school),
					...period,
					"--json",
				],
				options,
				[0, 1],
			);
			let found = -1;
			try {
				found = (JSON.parse(run.stdout) as { differences: unknown[] })
					.differences.length;
			} catch {
				found = -1;
			}
			rec.expect(
				`reconcile ${period.join(" ")}: no differences (exit 0)`,
				found === 0 && run.code === 0,
				() =>
					`${found} differences, exit ${run.code}: ${run.stdout.slice(0, 300)}`,
			);
		}

		// ---- simulate --inputs on a log with no stored inputs: a sentence, exit 2, nothing written ----
		const simulate = readOnly(
			rec,
			world,
			"simulate --inputs (no stored inputs)",
			[
				"simulate",
				"--root",
				world.root,
				"--school",
				school,
				"--inputs",
				database,
				"--env",
				"live",
				"--json",
			],
			options,
			[2],
		);
		rec.expect(
			"simulate --inputs (no stored inputs): says so",
			simulate.stdout.includes("holds no stored inputs") ||
				simulate.stderr.includes("holds no stored inputs") ||
				simulate.stdout.includes("no stored inputs"),
			() => `${simulate.stdout.slice(0, 300)} ${simulate.stderr.slice(0, 300)}`,
		);
		rec.facts.folder = fingerprintHash(objectsOnly(fingerprint(world.root)));
	} finally {
		await world.dispose();
	}
	return rec;
};
