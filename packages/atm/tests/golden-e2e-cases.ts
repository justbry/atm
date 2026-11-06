/**
 * The per-scenario checks of the golden end-to-end run (S1, S2, S5, S6): each takes a world built from a golden fixture, drives
 * the real `atm` command line over it, and records what it found. `golden-e2e-check.test.ts` runs them and pins the findings;
 * nothing here asserts, so the same code can print a table.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { stateFromRows } from "../src/billing/rows.js";
import type { Menu } from "../src/billing/types.js";
import { readEvents } from "../src/ledger/files.js";
import { balancesOf, replayEvents } from "../src/ledger/replay.js";
import { toCatalog } from "../src/ledger/run.js";
import { bundleSchools } from "../src/scenario/bundle.js";
import type {
	AtmEnv,
	AtmEvent,
	AtmSubjectState,
	ScenarioBundle,
} from "../src/types.js";
import { eventsCsv } from "./e2e-matrix.js";
import {
	atm,
	buildBundleWorld,
	type Cli,
	differences,
	fingerprint,
	fingerprintHash,
	firstDifference,
	Outcomes,
	objectsOnly,
	type World,
} from "./golden-e2e-lib.js";

export const GOLDEN_E2E = join(import.meta.dir, "golden/e2e");
const LEDGER_FILES = /(^|\/)(ledger\/|main\.journal$)/;

export type RunOptions = {
	/** `src/bin.ts` or the built `dist/atm.js`. */
	bin?: string;
	/** The time zone of every `atm` process, to see whether anything depends on it. */
	tz?: string;
};

const cli = (args: readonly string[], options: RunOptions): Cli =>
	atm(args, {
		...(options.bin ? { bin: options.bin } : {}),
		...(options.tz ? { env: { TZ: options.tz } } : {}),
	});

/** Runs a command and records that it exited as expected; returns what it printed. */
export const step = (
	rec: Outcomes,
	label: string,
	args: readonly string[],
	options: RunOptions,
	expectedCodes: readonly number[] = [0],
): Cli => {
	const run = cli(args, options);
	rec.expect(
		`${label}: exit ${expectedCodes.join(" or ")}`,
		expectedCodes.includes(run.code ?? -1),
		() => `exit ${run.code}; stderr: ${run.stderr.slice(0, 300)}`,
	);
	return run;
};

/**
 * A command that must change nothing (S5): the fingerprint of the whole world, the database file with its `-wal` and `-shm`
 * included, before and after.
 */
export const readOnly = (
	rec: Outcomes,
	world: World,
	label: string,
	args: readonly string[],
	options: RunOptions,
	expectedCodes: readonly number[] = [0],
): Cli => {
	const before = fingerprint(world.dir);
	const run = step(rec, label, args, options, expectedCodes);
	const changed = differences(before, fingerprint(world.dir));
	rec.expect(`${label}: writes nothing`, changed.length === 0, () =>
		changed.slice(0, 5).join("; "),
	);
	return run;
};

/**
 * `atm journal` and `atm report` write the journals (the first time) and nothing else: the database and the shipped objects are
 * what they were, and a second run changes no byte.
 */
const journalWrites = (
	rec: Outcomes,
	world: World,
	label: string,
	args: readonly string[],
	options: RunOptions,
): Cli => {
	const before = fingerprint(world.dir);
	const first = step(rec, label, args, options);
	const afterFirst = fingerprint(world.dir);
	const stray = differences(before, afterFirst).filter(
		(line) => !LEDGER_FILES.test(line.split(": ")[0] ?? ""),
	);
	rec.expect(
		`${label}: first run writes only the journals`,
		stray.length === 0,
		() => stray.slice(0, 5).join("; "),
	);
	const second = step(rec, `${label} (rerun)`, args, options);
	const again = differences(afterFirst, fingerprint(world.dir));
	rec.expect(`${label}: second run writes nothing`, again.length === 0, () =>
		again.slice(0, 5).join("; "),
	);
	rec.expect(
		`${label}: second run says unchanged or prints the same`,
		second.stdout.includes("unchanged") || first.stdout === second.stdout,
		() => firstDifference(first.stdout, second.stdout),
	);
	return first;
};

const hledger = (books: string, args: readonly string[]): string => {
	const run = Bun.spawnSync(["hledger", "-f", "main.journal", ...args], {
		cwd: books,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (run.exitCode !== 0 || run.stderr.toString() !== "")
		throw new Error(
			`hledger ${args.join(" ")}: ${run.exitCode} ${run.stderr.toString()}`,
		);
	return run.stdout.toString();
};

const monthsOf = (events: readonly AtmEvent[]): string[] =>
	[...new Set(events.map((event) => event.date.slice(0, 7)))].sort();

const readGolden = (dir: string, name: string): string | null => {
	const path = join(dir, name);
	return existsSync(path) ? readFileSync(path, "utf8") : null;
};

/** hledger prints a register with nothing in it as nothing, or as its header line alone. */
const registerText = (csv: string): string =>
	csv.trim().split("\n").length <= 1 ? "" : csv;

const compareGolden = (
	rec: Outcomes,
	dir: string,
	name: string,
	got: string,
): void => {
	const want = readGolden(dir, name);
	if (want === null) {
		rec.expect(
			`golden ${name}: none committed, none produced`,
			got === "",
			() => "the run produced a file the goldens do not have",
		);
		return;
	}
	rec.expect(`golden ${name}: byte for byte`, got === want, () =>
		firstDifference(got, want),
	);
};

/** The one finding that the database and the folder differ where a stored refusal exists (S1). */
export const REFUSED_NOT_IN_FOLDER =
	"simulate --inputs: the folder differs from the database where an input was refused (refusals are not shipped)";

export type Candidate = { name: string; args: string[] };

/** The candidates tried on every school: the policy's three rules for an upgrade, the prices 10% up, a rollover capped at 1. */
export const writeCandidates = async (
	dir: string,
	menu: Menu,
): Promise<Candidate[]> => {
	await mkdir(dir, { recursive: true });
	const out: Candidate[] = [];
	for (const rule of ["prorated", "full", "none"]) {
		const file = join(dir, `policy-${rule}.json`);
		await writeFile(file, JSON.stringify({ upgradeGrant: rule }));
		out.push({ name: `upgradeGrant ${rule}`, args: ["--policy", file] });
	}
	const dearer: Menu = {
		...menu,
		tiers: menu.tiers.map((tier) => ({
			...tier,
			prices: tier.prices.map((price) => ({
				...price,
				amount: Math.round(price.amount * 1.1),
			})),
		})),
	};
	const priceFile = join(dir, "menu-price-up.json");
	await writeFile(priceFile, JSON.stringify(dearer));
	out.push({ name: "price +10%", args: ["--menu", priceFile] });
	let capped = false;
	const rollover: Menu = {
		...menu,
		tiers: menu.tiers.map((tier) => ({
			...tier,
			grants: tier.grants.map((grant) => {
				if (!grant.rollover) return grant;
				capped = true;
				return { ...grant, rollover: { ...grant.rollover, max: 1 } };
			}),
		})),
	};
	if (capped) {
		const file = join(dir, "menu-rollover-1.json");
		await writeFile(file, JSON.stringify(rollover));
		out.push({ name: "rollover cap 1", args: ["--menu", file] });
	}
	return out;
};

/** The numbers of a simulate `--json` line. */
type SimulateJson = {
	ok: boolean;
	baseline?: { identical: boolean; mismatches: unknown[] };
	differences?: number;
	balanceChanges?: unknown[];
	postingChanges?: unknown[];
	notReplayable?: { decisions: number; holders: number; items: unknown[] };
	error?: string;
};

export const parseJson = (text: string): SimulateJson | null => {
	try {
		return JSON.parse(text) as SimulateJson;
	} catch {
		return null;
	}
};

/**
 * `atm simulate --inputs` from the database and from the shipped folder, with no candidate (the identity) and with each
 * candidate: the same JSON from both sources, the identity unchanged, nothing written.
 */
export const refusedInputs = (databaseFile: string): number => {
	const database = new Database(databaseFile, { readonly: true });
	try {
		return (
			database
				.query(
					"SELECT COUNT(*) AS n FROM atm_event_inputs WHERE outcome = 'refused'",
				)
				.get() as { n: number }
		).n;
	} catch {
		return 0;
	} finally {
		database.close();
	}
};

export const checkSimulate = async (args: {
	rec: Outcomes;
	world: World;
	school: string;
	env: AtmEnv;
	menu: Menu;
	options: RunOptions;
	candidates: Candidate[];
}): Promise<void> => {
	const { rec, world, school, env, options } = args;
	const database = world.databaseFor(school);
	const common = (source: string) => [
		"simulate",
		"--root",
		world.root,
		"--school",
		school,
		"--inputs",
		source,
		"--env",
		env,
		"--json",
	];
	const refused = refusedInputs(database);
	const identity = readOnly(
		rec,
		world,
		`simulate identity (db) ${school}`,
		common(database),
		options,
		[0, 1, 2],
	);
	const parsed = parseJson(identity.stdout);
	rec.expect(
		`simulate identity ${school}: exit 0, baseline identical, no change`,
		identity.code === 0 &&
			parsed?.baseline?.identical === true &&
			parsed.differences === 0 &&
			(parsed.balanceChanges ?? []).length === 0 &&
			(parsed.postingChanges ?? []).length === 0,
		() =>
			`exit ${identity.code}; ${identity.stdout.slice(0, 400)} ${identity.stderr.slice(0, 300)}`,
	);
	// the same questions asked of the database and of the shipped folder
	const unequal: string[] = [];
	const ask = (name: string, extra: readonly string[]): Cli => {
		const fromDatabase =
			name === "identity"
				? identity
				: readOnly(
						rec,
						world,
						`simulate ${name} (db) ${school}`,
						[...common(database), ...extra],
						options,
						[0, 1, 2],
					);
		const fromStore = readOnly(
			rec,
			world,
			`simulate ${name} (folder) ${school}`,
			[...common(world.root), ...extra],
			options,
			[0, 1, 2],
		);
		if (
			fromDatabase.stdout !== fromStore.stdout ||
			fromDatabase.code !== fromStore.code
		)
			unequal.push(
				`${name}: exit ${fromDatabase.code} vs ${fromStore.code}; ${firstDifference(fromDatabase.stdout, fromStore.stdout).slice(0, 400)}`,
			);
		return fromDatabase;
	};
	ask("identity", []);
	for (const candidate of args.candidates) {
		const fromDatabase = ask(candidate.name, candidate.args);
		const result = parseJson(fromDatabase.stdout);
		rec.expect(
			`simulate ${candidate.name} ${school}: a result, not an error (exit 0 or 1)`,
			(fromDatabase.code === 0 || fromDatabase.code === 1) &&
				result?.ok === true,
			() => `exit ${fromDatabase.code}; ${fromDatabase.stdout.slice(0, 300)}`,
		);
		if (candidate.name === "upgradeGrant prorated")
			rec.expect(
				`simulate upgradeGrant prorated ${school}: the default rule is the identity`,
				fromDatabase.stdout === identity.stdout,
				() => firstDifference(fromDatabase.stdout, identity.stdout),
			);
	}
	if (unequal.length === 0)
		rec.pass(
			`simulate ${school}: database and folder print the same, every question`,
		);
	else if (refused > 0)
		rec.finding(
			REFUSED_NOT_IN_FOLDER,
			`${school} has ${refused} refused input(s), which the shipper does not ship; ${unequal.length} of ${args.candidates.length + 1} questions differ between the database and the folder. ${unequal[0]}`,
		);
	else
		rec.finding(
			`simulate ${school}: database and folder print the same`,
			unequal.join(" | "),
		);
};

/** The avail balance per holder and feature, from the engine rows in the handler's database. */
export const balancesFromRows = (args: {
	databaseFile: string;
	school: string;
	env: AtmEnv;
	menu: Menu;
	asOfMs: number;
}): Record<string, number> => {
	const database = new Database(args.databaseFile, { readonly: true });
	try {
		const subjects = database
			.query("SELECT subject_key, revision FROM atm_subjects")
			.all() as { subject_key: string; revision: number }[];
		const states: Record<string, AtmSubjectState> = {};
		for (const subject of subjects) {
			const [school, env, customerId] = subject.subject_key.split("|") as [
				string,
				string,
				string,
			];
			if (school !== args.school || env !== args.env) continue;
			const rows = (
				database
					.query(
						"SELECT table_name, row_id, data FROM atm_rows WHERE subject_key = ?",
					)
					.all(subject.subject_key) as {
					table_name: string;
					row_id: string;
					data: string;
				}[]
			).map((row) => ({
				table: row.table_name,
				id: row.row_id,
				data: JSON.parse(row.data),
			}));
			const state = stateFromRows({
				identity: {
					orgId: school,
					env: args.env,
					customerId,
					entityId: null,
				},
				revision: subject.revision,
				rows: rows as never,
			});
			if (state) states[customerId] = state as unknown as AtmSubjectState;
		}
		const balances = balancesOf({
			states,
			holds: {},
			catalog: toCatalog(
				menuCatalogRows({
					menu: args.menu,
					school: args.school,
					env: args.env,
				}),
			),
			asOfMs: args.asOfMs,
		});
		return Object.fromEntries(
			balances
				.filter((balance) => balance.avail !== 0)
				.map((balance) => [
					`${balance.holder}:${balance.feature}`,
					balance.avail,
				]),
		);
	} finally {
		database.close();
	}
};

const availOfLog = (
	events: readonly AtmEvent[],
	menu: Menu,
	school: string,
	env: AtmEnv,
): { avail: Record<string, number>; asOfMs: number } => {
	const replayed = replayEvents({
		events,
		catalog: menuCatalogRows({ menu, school, env }),
	});
	return {
		avail: Object.fromEntries(
			replayed.balances
				.filter((balance) => balance.avail !== 0)
				.map((balance) => [
					`${balance.holder}:${balance.feature}`,
					balance.avail,
				]),
		),
		asOfMs: replayed.asOf ? Date.parse(replayed.asOf) : 0,
	};
};

/** The shipped log of a school is the handler's outbox: the same lines, once each. */
const outboxLines = (databaseFile: string, school: string): string[] => {
	const database = new Database(databaseFile, { readonly: true });
	try {
		return (
			database
				.query("SELECT body FROM ledger_outbox WHERE school_id = ? ORDER BY id")
				.all(school) as { body: string }[]
		)
			.map((row) => row.body)
			.sort();
	} finally {
		database.close();
	}
};

const shippedLines = async (
	root: string,
	school: string,
): Promise<string[]> => {
	const { listEventFiles } = await import("../src/ledger/files.js");
	const out: string[] = [];
	for (const key of await listEventFiles(root, school))
		out.push(
			...(await readFile(join(root, "schools", school, key), "utf8"))
				.split("\n")
				.filter((line) => line.length > 0),
		);
	return out.sort();
};

/** The whole world's text, to search for a string that must not be there: every file, and the database with its `-wal` read as bytes. */
export const worldText = (world: World): Map<string, string> => {
	const out = new Map<string, string>();
	for (const path of Object.keys(fingerprint(world.dir)))
		out.set(path, readFileSync(join(world.dir, path)).toString("latin1"));
	return out;
};

/**
 * S1 for one bundle: the handler (a file-backed WAL database per school), then `atm inputs ship`, `atm ship`, `atm journal`,
 * `atm report`, `atm reconcile` and `atm simulate --inputs` as processes, with the goldens of the matrix (`golden/e2e/<id>`)
 * where the bundle has them, the no-write checks of S5, and the balances of the log against those of the database.
 */
export const checkBundle = async (
	bundle: ScenarioBundle,
	world: World,
	options: RunOptions,
): Promise<Outcomes> => {
	const rec = new Outcomes(bundle.id);
	await buildBundleWorld(bundle, world);
	const env: AtmEnv = bundle.scenario.env ?? "live";
	const schools = bundleSchools(bundle.scenario);
	const hasGoldens = existsSync(join(GOLDEN_E2E, bundle.id));
	const candidates = await writeCandidates(
		join(world.dir, "candidates"),
		bundle.scenario.menu,
	);
	for (const school of schools) {
		const database = world.databaseFor(school);
		const book = bundle.expected.books.find((b) => b.school === school);
		const where = schools.length > 1 ? ` ${school}` : "";
		const goldenDir =
			schools[0] === school
				? join(GOLDEN_E2E, bundle.id)
				: join(GOLDEN_E2E, bundle.id, school);

		// ---- ship: inputs first, then events (the cron order) ----
		const inputsShip = step(
			rec,
			`inputs ship${where}`,
			[
				"inputs",
				"ship",
				"--db",
				database,
				"--school",
				school,
				"--env",
				env,
				"--root",
				world.root,
				"--json",
			],
			options,
			[0, 2],
		);
		const hasInputs = inputsShip.code === 0;
		if (!hasInputs)
			rec.pass(
				`inputs ship${where}: refused cleanly`,
				inputsShip.stderr.trim().slice(0, 200),
			);
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
		const shipped = step(rec, `ship${where}`, shipArgs, options);
		const shippedAll = fingerprint(world.root);
		const again = step(rec, `ship rerun${where}`, shipArgs, options);
		if (hasInputs)
			step(
				rec,
				`inputs ship rerun${where}`,
				[
					"inputs",
					"ship",
					"--db",
					database,
					"--school",
					school,
					"--env",
					env,
					"--root",
					world.root,
					"--json",
				],
				options,
			);
		const rerunChanges = differences(shippedAll, fingerprint(world.root));
		rec.expect(
			`ship and inputs ship rerun${where}: no object added or changed`,
			rerunChanges.length === 0 && again.stdout.includes('"shipped":0'),
			() =>
				`${rerunChanges.slice(0, 3).join("; ")} ${again.stdout.slice(0, 200)}`,
		);
		rec.expect(
			`ship${where}: the log holds the outbox's lines, once each`,
			JSON.stringify(await shippedLines(world.root, school)) ===
				JSON.stringify(outboxLines(database, school)) ||
				// a second delivery of an idem is dropped by the reader, not by the files
				new Set(await shippedLines(world.root, school)).size ===
					new Set(outboxLines(database, school)).size,
			() => `shipped ${shipped.stdout.slice(0, 200)}`,
		);

		const { events } = await readEvents(world.root, school);
		if (events.length === 0) {
			rec.pass(`no events${where}: nothing to journal`);
			continue;
		}
		if (hasGoldens && book)
			compareGolden(rec, goldenDir, "events.csv", eventsCsv(events));

		// ---- journal and report ----
		const months = monthsOf(events);
		for (const month of months.slice(0, -1))
			journalWrites(
				rec,
				world,
				`journal ${month}${where}`,
				["journal", "--root", world.root, "--school", school, "--month", month],
				options,
			);
		const last = months.at(-1) as string;
		const reports: Record<string, string> = {};
		for (const name of ["income-statement", "balance-sheet", "credits"]) {
			const run = journalWrites(
				rec,
				world,
				`report ${name}${where}`,
				[
					"report",
					"--root",
					world.root,
					"--school",
					school,
					"--month",
					last,
					"--report",
					name,
					"--format",
					"csv",
				],
				options,
			);
			reports[name] = run.stdout;
		}
		const books = join(world.root, "schools", school);
		const checks = Bun.spawnSync(
			[
				"hledger",
				"-f",
				"main.journal",
				"check",
				"balanced",
				"accounts",
				"commodities",
			],
			{ cwd: books, stdout: "pipe", stderr: "pipe" },
		);
		rec.expect(
			`hledger check balanced accounts commodities${where}`,
			checks.exitCode === 0,
			() => checks.stderr.toString().slice(0, 300),
		);
		if (hasGoldens) {
			for (const name of Object.keys(reports))
				compareGolden(rec, goldenDir, `${name}.csv`, reports[name] as string);
			compareGolden(
				rec,
				goldenDir,
				"refunds-register.csv",
				registerText(
					hledger(books, ["reg", "income:billing:refunds", "-O", "csv"]),
				),
			);
			compareGolden(
				rec,
				goldenDir,
				"disputes-register.csv",
				registerText(
					hledger(books, ["reg", "expenses:billing:disputes", "-O", "csv"]),
				),
			);
			if (book?.monthly) {
				compareGolden(
					rec,
					goldenDir,
					"income-statement-monthly.csv",
					hledger(books, ["is", "-M", "-O", "csv"]),
				);
				compareGolden(
					rec,
					goldenDir,
					"balance-sheet-monthly.csv",
					hledger(books, ["bs", "-M", "-O", "csv"]),
				);
			}
		}

		// ---- reconcile against the hand-built Stripe side ----
		if (book) {
			const reconcileMonths = Object.keys(book.reconcile).sort();
			const texts: string[] = [];
			for (const month of reconcileMonths) {
				const differs = (book.reconcile[month] ?? []).length > 0;
				const run = readOnly(
					rec,
					world,
					`reconcile ${month}${where}`,
					[
						"reconcile",
						"--root",
						world.root,
						"--school",
						school,
						"--stripe",
						world.stripeFor(school),
						"--month",
						month,
					],
					options,
					[differs ? 1 : 0],
				);
				texts.push(run.stdout.replace(/\n$/, ""));
			}
			if (hasGoldens && reconcileMonths.length > 0) {
				const joined = texts.map((text) => `${text}\n`).join("\n");
				const wantText = readGolden(goldenDir, "reconcile.txt");
				if (wantText !== null) {
					rec.expect(
						`golden reconcile.txt${where}: byte for byte`,
						joined === wantText || texts.join("\n") === wantText,
						() => firstDifference(texts.join("\n"), wantText),
					);
				}
			}
		}

		// ---- balances: the log's replay, the database's rows ----
		const logged = availOfLog(events, bundle.scenario.menu, school, env);
		const fromRows = balancesFromRows({
			databaseFile: database,
			school,
			env,
			menu: bundle.scenario.menu,
			asOfMs: logged.asOfMs,
		});
		rec.expect(
			`balances${where}: replay of the log equals the handler's engine rows`,
			JSON.stringify(sortKeys(logged.avail)) ===
				JSON.stringify(sortKeys(fromRows)),
			() =>
				`log ${JSON.stringify(sortKeys(logged.avail))} rows ${JSON.stringify(sortKeys(fromRows))}`,
		);

		// ---- simulate ----
		await checkSimulate({
			rec,
			world,
			school,
			env,
			menu: bundle.scenario.menu,
			options,
			candidates,
		});
	}

	rec.facts.folder = fingerprintHash(objectsOnly(fingerprint(world.root)));
	// ---- personal strings are in no file and no database ----
	const personal = bundle.scenario.personal ?? [];
	if (personal.length > 0) {
		const text = worldText(world);
		const holding = [...text]
			.filter(([, body]) => personal.some((needle) => body.includes(needle)))
			.map(([path]) => path);
		rec.expect(
			`personal strings (${personal.length}) are in no file or database`,
			holding.length === 0,
			() => holding.join(", "),
		);
	}
	return rec;
};

const sortKeys = (record: Record<string, number>): Record<string, number> =>
	Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)),
	);
