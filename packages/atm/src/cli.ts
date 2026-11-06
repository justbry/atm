import { Database } from "bun:sqlite";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { WorkerFullSubject } from "@autumn/balance-engine";
import { Command } from "commander";
import packageJson from "../package.json";
import { validateMenu } from "./billing/menu.js";
import { resolvePolicy } from "./billing/policy.js";
import type { BillingPolicy, Menu } from "./billing/types.js";
import { engineCommandTypes, runEngineCommand } from "./engine.js";
import { bunSqlite } from "./handler/bun-sqlite.js";
import { inputsStatus, sqliteInputsSource } from "./handler/inputs.js";
import { assertInputTables } from "./handler/schema.js";
import { journalMonth, readEvents } from "./ledger/files.js";
import {
	InputsDestinationError,
	R2_ENV,
	resolveInputsDestination,
} from "./ledger/inputs-destination.js";
import { ReconcileInputError } from "./ledger/reconcile.js";
import {
	formatReconcile,
	reconcileFolder,
	STRIPE_FILES,
} from "./ledger/reconcile-files.js";

import {
	HledgerError,
	REPORT_CHOICES,
	REPORT_FORMATS,
	reportMonth,
	skippedNote,
} from "./ledger/report.js";
import {
	formatShareStatement,
	shareStatement,
} from "./ledger/share-statement.js";
import { shipOutbox } from "./ledger/ship.js";
import {
	folderInputsSource,
	inputsShipStatus,
	shipInputs,
} from "./ledger/ship-inputs.js";
import { simulate } from "./ledger/simulate.js";
import {
	InputsSimulateError,
	simulateFromInputs,
} from "./ledger/simulate-inputs.js";
import { outboxStatus } from "./ledger/status.js";
import { addScenarioCommands, runScenarioSimulate } from "./scenario/cli.js";
import { FolderStore } from "./store/folder-store.js";
import { R2Store } from "./store/r2-store.js";
import type { AtmCatalogRow, AtmEnv } from "./types.js";

/** How long `atm ship` waits for the handler's write lock on a busy database. */
const BUSY_TIMEOUT_MS = 5000;

/** Exit status of `atm reconcile` for input it cannot use; 1 is for differences found. */
const RECONCILE_BAD_INPUT = 2;

/** Exit codes of `atm ship`, `atm journal` and `atm report`: 0 done, 1 a conflict (`atm ship` only), 2 any other error. */
const EXIT_CONFLICT = 1;
const EXIT_ERROR = 2;

/** A refusal whose message is already the one line for the operator (a bad option, a typo guard). */
class InputError extends Error {}

const readJson = async (path: string) =>
	JSON.parse(
		path === "-" ? await Bun.stdin.text() : await readFile(path, "utf8"),
	);

export const program = new Command()
	.name("atm")
	.description("Autumn's balance engine as a local CLI")
	.version(packageJson.version);

program
	.command("run")
	.description(
		`run one engine command against a subject and print the result as JSON (${engineCommandTypes.join(", ")}); writes nothing`,
	)
	.requiredOption("--subject <file>", "WorkerFullSubject JSON, or - for stdin")
	.requiredOption("--command <file>", "engine command JSON with its `type`")
	.action(async (opts: { subject: string; command: string }) => {
		if (opts.subject === "-" && opts.command === "-") {
			throw new Error("only one of --subject and --command can read stdin");
		}
		const fullSubject = (await readJson(opts.subject)) as WorkerFullSubject;
		const command = await readJson(opts.command);
		const result = runEngineCommand({ fullSubject, command });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	});

/** A message on one line: a stack trace and a multi-line message are not for a cron mail or an alert. */
const oneLine = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error))
		.trim()
		.replace(/\s*\n\s*/g, " ");

/**
 * Runs an unattended command: any error becomes one line on stderr (and, with `--json`, `{"ok":false,"error":...}` on
 * stdout) and exit code 2, so a wrapper can tell it from a conflict (1) and from success (0). No stack trace.
 */
const unattended = async (
	name: string,
	json: boolean,
	run: () => Promise<void>,
): Promise<void> => {
	try {
		await run();
	} catch (error) {
		const message =
			error instanceof InputError || error instanceof HledgerError
				? oneLine(error)
				: `atm ${name} failed: ${oneLine(error)}`;
		process.stderr.write(`${message}\n`);
		if (json)
			process.stdout.write(
				`${JSON.stringify({ ok: false, error: message })}\n`,
			);
		process.exitCode = EXIT_ERROR;
	}
};

/**
 * An option commander refuses (a missing one, an unknown flag) exits 2 too, not 1: 1 means a conflict. Help and version
 * still exit 0. Commander's "(Did you mean ...?)" second line is off, so the refusal is one stderr line.
 */
const exitTwoOnUsageError = (command: Command): Command =>
	command
		.showSuggestionAfterError(false)
		.exitOverride((error) =>
			process.exit(error.exitCode === 0 ? 0 : EXIT_ERROR),
		);

const writeJson = (value: unknown): void => {
	process.stdout.write(`${JSON.stringify(value)}\n`);
};

const scenarioKit = { unattended, exitTwoOnUsageError, writeJson, InputError };

const journalCommand = program
	.command("journal")
	.description(
		"build a school's hledger journal for one month from its event files: ledger/b4u/YYYY-MM.journal, ledger/accounts.journal, main.journal and ledger/build.json (a file is rewritten only when its bytes change); an error is one line on stderr and exit 2",
	)
	.requiredOption("--root <folder>", "the folder that holds schools/<id>/")
	.requiredOption("--school <id>", "school id, as in schools/<id>/")
	.requiredOption(
		"--month <YYYY-MM>",
		"month, by the events' school-local date",
	)
	.option(
		"--json",
		"print one JSON line ({ok, month, transactions, written, unchanged}) instead of the sentence",
	)
	.action(
		async (opts: {
			root: string;
			school: string;
			month: string;
			json?: boolean;
		}) =>
			unattended("journal", opts.json === true, async () => {
				const run = await journalMonth(opts);
				if (opts.json) {
					writeJson({
						ok: true,
						month: opts.month,
						transactions: run.build.transactions,
						written: run.written,
						unchanged: run.unchanged,
					});
					return;
				}
				const note = run.unchanged
					? "unchanged"
					: `wrote ${run.written.join(", ")}`;
				process.stdout.write(
					`${opts.month}: ${run.build.transactions} transactions; ${note}\n`,
				);
			}),
	);
exitTwoOnUsageError(journalCommand);

const reportCommand = program
	.command("report")
	.description(
		`build a school's journal for one month (as atm journal does), then print hledger's income statement, balance sheet and credit balances from its main.journal, to date over every month journaled so far; needs hledger on PATH and exits 2 saying so when it is missing`,
	)
	.requiredOption("--root <folder>", "the folder that holds schools/<id>/")
	.requiredOption("--school <id>", "school id, as in schools/<id>/")
	.requiredOption(
		"--month <YYYY-MM>",
		"the month to build before reporting, by the events' school-local date",
	)
	.option("--report <name>", `${REPORT_CHOICES.join(", ")}`, "all")
	.option("--format <format>", REPORT_FORMATS.join(" or "), "table")
	.action(
		async (opts: {
			root: string;
			school: string;
			month: string;
			report: string;
			format: string;
		}) =>
			unattended("report", false, async () => {
				const report = REPORT_CHOICES.find((name) => name === opts.report);
				if (report === undefined)
					throw new InputError(
						`--report ${opts.report} is not one of ${REPORT_CHOICES.join(", ")}`,
					);
				const format = REPORT_FORMATS.find((name) => name === opts.format);
				if (format === undefined)
					throw new InputError(
						`--format ${opts.format} is not one of ${REPORT_FORMATS.join(", ")}`,
					);
				const run = await reportMonth({
					root: opts.root,
					school: opts.school,
					month: opts.month,
					report,
					format,
				});
				process.stdout.write(
					run.reports.map((output) => output.text).join("\n"),
				);
				const note = skippedNote({ ...run, month: opts.month });
				if (note !== null) process.stderr.write(note);
			}),
	);
exitTwoOnUsageError(reportCommand);

const shareCommand = program
	.command("share")
	.description(
		"print a school's revenue-share statement for one month from its event files: a row per payment that accrued or reversed a share, the totals and the balance owed B4 Uni at the month's end, as CSV-style text or --json; reads only, writes nothing; an error is one line on stderr and exit 2",
	)
	.requiredOption("--root <folder>", "the folder that holds schools/<id>/")
	.requiredOption("--school <id>", "school id, as in schools/<id>/")
	.requiredOption(
		"--month <YYYY-MM>",
		"month, by the events' school-local date",
	)
	.option(
		"--time-zone <iana>",
		"date the events in this zone instead of each event's own date",
	)
	.option(
		"--json",
		"print the statement as one JSON line ({ok, school, month, rows, settlements, totals, balanceOwed})",
	)
	.action(
		async (opts: {
			root: string;
			school: string;
			month: string;
			timeZone?: string;
			json?: boolean;
		}) =>
			unattended("share", opts.json === true, async () => {
				const { events } = await readEvents(opts.root, opts.school);
				if (events.length === 0)
					throw new InputError(
						`no events under ${opts.root}/schools/${opts.school}/events`,
					);
				const statement = shareStatement({
					events,
					school: opts.school,
					month: opts.month,
					...(opts.timeZone ? { tz: opts.timeZone } : {}),
				});
				if (opts.json) writeJson({ ok: true, ...statement });
				else process.stdout.write(formatShareStatement(statement));
			}),
	);
exitTwoOnUsageError(shareCommand);

type ShipOptions = {
	db: string;
	root: string;
	school: string;
	json?: boolean;
};

const ship = async (opts: ShipOptions): Promise<void> => {
	// A typo in --root would otherwise make a new folder and mark every row shipped into it.
	const root = await stat(opts.root).catch(() => null);
	if (!root?.isDirectory())
		throw new InputError(
			`--root ${opts.root} is not an existing folder; create it first (atm ship does not create the root, so that a typo in it ships nothing)`,
		);
	const database = new Database(opts.db, { readwrite: true });
	try {
		database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		const db = bunSqlite(database);
		// A typo in --school would otherwise ship nothing and exit 0. An outbox with no row at all has nothing to lose to a typo, and a
		// school that has not had an event yet is not an error for a schedule: that ships nothing and exits 0.
		const schools = db
			.all<{ school_id: string }>(
				"SELECT DISTINCT school_id FROM ledger_outbox ORDER BY school_id",
			)
			.map((row) => row.school_id);
		if (schools.length > 0 && !schools.includes(opts.school))
			throw new InputError(
				`--school ${opts.school} has no rows in ledger_outbox of ${opts.db}; schools there: ${schools.join(", ")}`,
			);
		const result = await shipOutbox({
			db,
			store: new FolderStore({ root: opts.root }),
			school: opts.school,
			nowMs: Date.now,
		});
		for (const conflict of result.conflicts)
			process.stderr.write(`conflict ${conflict.key}: ${conflict.message}\n`);
		if (opts.json) {
			const status = outboxStatus({
				db,
				school: opts.school,
				nowMs: Date.now,
			});
			writeJson({
				ok: result.conflicts.length === 0,
				school: opts.school,
				batches: result.batches.length,
				shipped: result.shipped,
				conflicts: result.conflicts.map(({ key, message }) => ({
					key,
					message,
				})),
				unshipped: status.unshipped,
				oldestUnshippedDate: status.oldestUnshippedDate,
				oldestUnshippedAgeMs: status.oldestUnshippedAgeMs,
			});
		} else {
			for (const batch of result.batches)
				process.stdout.write(
					`${batch.status} ${batch.key}: ${batch.events} events\n`,
				);
			process.stdout.write(
				`${result.shipped} events shipped in ${result.batches.length} batches; ${result.conflicts.length} conflicts\n`,
			);
		}
		if (result.conflicts.length > 0) process.exitCode = EXIT_CONFLICT;
	} finally {
		database.close();
	}
};

const shipCommand = program
	.command("ship")
	.description(
		"ship a school's unshipped ledger_outbox rows from the handler's SQLite file to <root>/schools/<id>/events/date=YYYY-MM-DD/batch-*.jsonl, create-only, safe to rerun, run it from cron; exits 0 when done (also when there was nothing to ship), 1 when a batch's key already holds different bytes (conflict lines on stderr), 2 on any other error (one line on stderr)",
	)
	.requiredOption("--db <file>", "the SQLite file the webhook handler writes")
	.requiredOption("--root <folder>", "the folder that holds schools/<id>/")
	.requiredOption("--school <id>", "school id, as in schools/<id>/")
	.option(
		"--json",
		"print one JSON line on stdout ({ok, school, batches, shipped, conflicts: [{key, message}], unshipped, oldestUnshippedDate, oldestUnshippedAgeMs}) instead of the lines per batch",
	)
	.action((opts: ShipOptions) =>
		unattended("ship", opts.json === true, () => ship(opts)),
	);
exitTwoOnUsageError(shipCommand);

// ---- atm inputs ship (stored inputs, part C) ----

type InputsShipOptions = {
	db: string;
	school: string;
	env: string;
	root?: string;
	r2Bucket?: string;
	r2Endpoint?: string;
	r2Prefix?: string;
	json?: boolean;
};

/** The folder or the bucket the objects go to; a refusal in the options is one line, exit 2. */
const inputsStore = async (opts: InputsShipOptions) => {
	let destination: ReturnType<typeof resolveInputsDestination>;
	try {
		destination = resolveInputsDestination(opts, process.env);
	} catch (error) {
		if (error instanceof InputsDestinationError)
			throw new InputError(error.message);
		throw error;
	}
	if (destination.kind === "r2") return new R2Store(destination.options);
	// A typo in --root would otherwise make a new folder and mark every row shipped into it.
	const root = await stat(destination.root).catch(() => null);
	if (!root?.isDirectory())
		throw new InputError(
			`--root ${destination.root} is not an existing folder; create it first (atm inputs ship does not create the root, so that a typo in it ships nothing)`,
		);
	return new FolderStore({ root: destination.root });
};

const inputsShip = async (opts: InputsShipOptions): Promise<void> => {
	if (opts.env !== "live" && opts.env !== "test")
		throw new InputError("--env must be live or test");
	const env = opts.env;
	const store = await inputsStore(opts);
	const database = new Database(opts.db, { readwrite: true });
	try {
		database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		const db = bunSqlite(database);
		assertInputTables(db);
		// A typo in --school would otherwise ship nothing and exit 0; an empty table has nothing to lose to one.
		const schools = db
			.all<{ school_id: string }>(
				"SELECT DISTINCT school_id FROM atm_event_inputs ORDER BY school_id",
			)
			.map((row) => row.school_id);
		if (schools.length > 0 && !schools.includes(opts.school))
			throw new InputError(
				`--school ${opts.school} has no rows in atm_event_inputs of ${opts.db}; schools there: ${schools.join(", ")}`,
			);
		const result = await shipInputs({
			db,
			store,
			school: opts.school,
			env,
			nowMs: Date.now,
		});
		for (const conflict of result.conflicts)
			process.stderr.write(`conflict ${conflict.key}: ${conflict.message}\n`);
		if (result.erasures.pending > 0)
			process.stderr.write(
				`erasure pending: ${result.erasures.pending} shipped object(s) of an erased holder are not rewritten or deleted yet; run atm inputs ship again\n`,
			);
		const status = inputsShipStatus({
			db,
			school: opts.school,
			env,
			nowMs: Date.now,
		});
		if (opts.json)
			writeJson({
				ok: result.conflicts.length === 0 && result.erasures.pending === 0,
				school: opts.school,
				env,
				batches: result.batches.length,
				shipped: result.shipped,
				contexts: result.contexts,
				seeds: result.seeds,
				conflicts: result.conflicts.map(({ key, message }) => ({
					key,
					message,
				})),
				erasuresSettled: result.erasures.settled,
				erasuresPending: result.erasures.pending,
				unshipped: status.unshipped,
				oldestUnshippedAgeMs: status.oldestUnshippedAgeMs,
			});
		else {
			for (const batch of result.batches)
				process.stdout.write(
					`${batch.status} ${batch.key}: ${batch.inputs} inputs\n`,
				);
			process.stdout.write(
				`${result.shipped} inputs shipped in ${result.batches.length} batches, ${result.contexts} contexts, ${result.seeds} seeds; ${result.conflicts.length} conflicts; erasures settled ${result.erasures.settled}, pending ${result.erasures.pending}\n`,
			);
		}
		if (result.conflicts.length > 0 || result.erasures.pending > 0)
			process.exitCode = EXIT_CONFLICT;
	} finally {
		database.close();
	}
};

/**
 * Commander echoes an unknown flag with its attached value (`--flag=value`, `-fvalue`); a secret given that way, quotes in it
 * included, must not reach the log.
 */
const UNKNOWN_LONG_OPTION_VALUE = /(unknown option '--[^='\n]+)=[^\n]*'$/m;
const UNKNOWN_SHORT_OPTION_VALUE = /(unknown option '-[^-'\n])[^\n]*'$/m;
const redactUnknownOptionValue = (text: string): string =>
	text
		.replace(UNKNOWN_LONG_OPTION_VALUE, "$1'")
		.replace(UNKNOWN_SHORT_OPTION_VALUE, "$1'");

const inputsCommand = program
	.command("inputs")
	.description(
		"the stored Stripe inputs the webhook handler keeps (see: inputs ship)",
	);
exitTwoOnUsageError(inputsCommand);

const inputsShipCommand = inputsCommand
	.command("ship")
	.description(
		`ship a school's unshipped stored inputs (atm_event_inputs) from the handler's SQLite file to <root>/schools/<id>/inputs/<env>/date=YYYY-MM-DD/batch-*.jsonl (UTC commit day), with the contexts/ and seeds/ they refer to, create-only, safe to rerun, run it from cron before \`atm ship\`. First settles the erasure queue: a shipped batch that held an erased holder's facts is rewritten under a new key with the tombstone and the old object deleted. Exits 0 when done (also when there was nothing to ship), 1 when a key already holds different bytes (conflict lines on stderr) or an erasure is still pending, 2 on any other error (one line on stderr). R2 credentials are read from the environment only (${R2_ENV.accessKeyId}, ${R2_ENV.secretAccessKey}, optional ${R2_ENV.sessionToken}); the R2 path has not been run against R2`,
	)
	.requiredOption("--db <file>", "the SQLite file the webhook handler writes")
	.requiredOption("--school <id>", "school id, as in schools/<id>/")
	.requiredOption("--env <live|test>", "the Stripe mode whose inputs to ship")
	.option(
		"--root <folder>",
		"an existing folder that holds (or will hold) schools/<id>/",
	)
	.option(
		"--r2-bucket <name>",
		`an R2 bucket, instead of --root (or ${R2_ENV.bucket})`,
	)
	.option(
		"--r2-endpoint <url>",
		`the bucket's S3 endpoint, with --r2-bucket (or ${R2_ENV.endpoint})`,
	)
	.option(
		"--r2-prefix <prefix>",
		`keep every key under this prefix (or ${R2_ENV.prefix})`,
	)
	.option(
		"--json",
		"print one JSON line ({ok, school, env, batches, shipped, contexts, seeds, conflicts: [{key, message}], erasuresSettled, erasuresPending, unshipped, oldestUnshippedAgeMs}) instead of the lines per batch",
	)
	.configureOutput({
		outputError: (text, write) => write(redactUnknownOptionValue(text)),
	})
	.action((opts: InputsShipOptions) =>
		unattended("inputs ship", opts.json === true, () => inputsShip(opts)),
	);
exitTwoOnUsageError(inputsShipCommand);

program
	.command("reconcile")
	.description(
		"compare a school's events for a month (or a range of days) with Stripe's records for the same period: paid invoices, a booking's one-time payments, refunds, disputes, payouts, fees and the net. Prints a summary, or --json; exits 0 when nothing differs, 1 when something does, 2 for input it cannot use",
	)
	.option("--root <folder>", "the folder that holds schools/<id>/")
	.option("--school <id>", "school id, as in schools/<id>/")
	.option("--month <YYYY-MM>", "the period, by the school's calendar")
	.option("--from <YYYY-MM-DD>", "first day of a range, instead of --month")
	.option("--to <YYYY-MM-DD>", "last day of a range (inclusive)")
	.option(
		"--stripe <folder>",
		"folder of the JSON that `stripe <resource> list` prints: invoices.json, refunds.json, disputes.json, payouts.json, balance_transactions.json (a missing file is reported as not supplied and exits 2), and payment_intents.json, which a school whose log holds a booking payment must add",
	)
	.option(
		"--time-zone <iana>",
		"the school's zone for dating Stripe's records (default: the latest event's)",
	)
	.option(
		"--mode <live|test>",
		"ignore Stripe objects of the other mode",
		"live",
	)
	.option("--json", "print the result as JSON")
	.exitOverride((error) => {
		// Commander's own errors (an unknown option) exit 1, which here would read as "differences found".
		process.exit(error.exitCode === 0 ? 0 : RECONCILE_BAD_INPUT);
	})
	.action(
		async (opts: {
			root?: string;
			school?: string;
			month?: string;
			from?: string;
			to?: string;
			stripe?: string;
			timeZone?: string;
			mode: string;
			json?: boolean;
		}) => {
			try {
				const { root, school, stripe } = opts;
				if (!root || !school || !stripe)
					throw new ReconcileInputError(
						"--root, --school and --stripe are required",
					);
				if (opts.mode !== "live" && opts.mode !== "test")
					throw new ReconcileInputError("--mode must be live or test");
				const range = opts.from !== undefined || opts.to !== undefined;
				if (opts.month !== undefined && range)
					throw new ReconcileInputError(
						"give --month, or --from and --to, not both",
					);
				if (opts.month === undefined && !(opts.from && opts.to))
					throw new ReconcileInputError(
						"give --month YYYY-MM, or both --from and --to",
					);
				const period =
					opts.month !== undefined
						? { month: opts.month }
						: { from: opts.from as string, to: opts.to as string };
				const result = await reconcileFolder({
					root,
					school,
					period,
					stripeDirectory: stripe,
					timeZone: opts.timeZone,
					mode: opts.mode,
				});
				process.stdout.write(
					opts.json
						? `${JSON.stringify(result, null, 2)}\n`
						: formatReconcile(result),
				);
				if (result.differences.length > 0) process.exitCode = 1;
				// A list that was not read ran none of its checks, so "no differences" would be a half-truth: the result is printed, and the exit says the input was incomplete.
				if (result.notSupplied.length > 0) {
					process.stderr.write(
						`atm reconcile: ${result.notSupplied.map((list) => STRIPE_FILES[list]).join(", ")} not in ${stripe}, so their checks did not run (a list with nothing in it is [])\n`,
					);
					process.exitCode = RECONCILE_BAD_INPUT;
				}
			} catch (error) {
				if (!(error instanceof ReconcileInputError)) throw error;
				process.stderr.write(`atm reconcile: ${error.message}\n`);
				process.exitCode = RECONCILE_BAD_INPUT;
			}
		},
	);

type SimulateOptions = {
	root?: string;
	school?: string;
	profile?: string;
	scenario?: string;
	set?: string[];
	seed?: string;
	channels?: string;
	month?: string;
	menu?: string;
	catalog?: string;
	policy?: string;
	currentMenu?: string;
	currentCatalog?: string;
	inputs?: string;
	env?: string;
	effectiveFrom?: string;
	currentPolicy?: string;
	allowBaselineDrift?: boolean;
	json?: boolean;
};

const readInputFile = async (flag: string, path: string): Promise<unknown> => {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new InputError(
			`${flag} ${path} cannot be read as JSON: ${oneLine(error)}`,
		);
	}
};

const menuFrom = async (flag: string, path: string): Promise<Menu> => {
	const checked = validateMenu(await readInputFile(flag, path));
	if (!checked.ok)
		throw new InputError(
			`${flag} ${path} is not a valid menu: ${checked.problems.join(", ")}`,
		);
	return checked.menu;
};

const catalogFrom = async (
	flag: string,
	path: string,
): Promise<AtmCatalogRow[]> => {
	const rows = await readInputFile(flag, path);
	const isRow = (row: unknown) =>
		typeof row === "object" &&
		row !== null &&
		typeof (row as { table?: unknown }).table === "string" &&
		typeof (row as { row?: unknown }).row === "object" &&
		(row as { row?: unknown }).row !== null;
	if (!Array.isArray(rows) || !rows.every(isRow))
		throw new InputError(
			`${flag} ${path} is not a list of catalog rows ({table, row}), as menuCatalogRows makes`,
		);
	return rows as AtmCatalogRow[];
};

const policyFrom = async (
	path: string,
	flag = "--policy",
): Promise<BillingPolicy> => {
	const overrides = await readInputFile(flag, path);
	try {
		return resolvePolicy(overrides);
	} catch (error) {
		throw new InputError(`${flag} ${path}: ${oneLine(error)}`);
	}
};

const SIMULATE_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const assertSchoolFolder = (school: string): void => {
	// `--school ..` or `a/../b` would read some other folder's events as the school's (as `atm reconcile` refuses).
	if (
		school === "" ||
		school === "." ||
		school === ".." ||
		basename(school) !== school
	)
		throw new InputError(
			`--school ${JSON.stringify(school)} must be one folder name under schools/`,
		);
};

/** The handler's SQLite, opened read-only, behind the `InputsSource` the replay reads through. Nothing is written. */
const readStoredInputs = async (path: string, env: AtmEnv, school: string) => {
	const found = await stat(path).catch(() => null);
	if (!found) throw new InputError(`--inputs ${path} does not exist`);
	if (found.isDirectory()) {
		// a shipped copy of the inputs (`atm inputs ship`): the same InputsRead, from a store root
		const read = await folderInputsSource(path).read({ env, school });
		if (read.inputs.length === 0 && read.refused.length === 0)
			throw new InputError(
				`no inputs under ${path}/schools/${school}/inputs/${env}: run atm inputs ship, or point --inputs at the handler's database`,
			);
		return read;
	}
	let database: Database;
	try {
		database = new Database(path, { readonly: true });
	} catch (error) {
		throw new InputError(
			`--inputs ${path} cannot be opened as SQLite: ${oneLine(error)}`,
		);
	}
	try {
		const db = bunSqlite(database);
		let status: ReturnType<typeof inputsStatus>;
		try {
			status = inputsStatus(db, { env, school });
		} catch (error) {
			throw new InputError(
				`--inputs ${path} cannot be read as the handler's database: ${oneLine(error)}`,
			);
		}
		if (!status.available)
			throw new InputError(
				`${path} holds no stored inputs for school ${school} (${env}): the handler stores them from atm 0.9.0, so a what-if on the grant rules covers only the history after that; run atm simulate without --inputs for the command-level what-if on the whole log`,
			);
		return await sqliteInputsSource(db, path).read({ env, school });
	} finally {
		database.close();
	}
};

const runSimulateFromInputs = async (
	opts: SimulateOptions & { root: string; school: string },
): Promise<void> => {
	assertSchoolFolder(opts.school);
	if (opts.env !== "live" && opts.env !== "test")
		throw new InputError("--env must be live or test with --inputs");
	const env: AtmEnv = opts.env;
	if (opts.catalog || opts.currentCatalog)
		throw new InputError(
			"--catalog and --current-catalog are not used with --inputs: the catalog follows the menu",
		);
	if (opts.month !== undefined && !SIMULATE_MONTH.test(opts.month))
		throw new InputError(`--month ${opts.month} is not YYYY-MM`);
	let effectiveFrom: number | undefined;
	if (opts.effectiveFrom !== undefined) {
		effectiveFrom = Date.parse(opts.effectiveFrom);
		if (Number.isNaN(effectiveFrom))
			throw new InputError(
				`--effective-from ${opts.effectiveFrom} is not an ISO instant (2026-03-01T00:00:00Z)`,
			);
	}
	const candidate = {
		menu: opts.menu ? await menuFrom("--menu", opts.menu) : undefined,
		policy: opts.policy ? await policyFrom(opts.policy) : undefined,
	};
	const current = {
		menu: opts.currentMenu
			? await menuFrom("--current-menu", opts.currentMenu)
			: undefined,
		policy: opts.currentPolicy
			? await policyFrom(opts.currentPolicy, "--current-policy")
			: undefined,
	};
	const { events } = await readEvents(opts.root, opts.school);
	if (events.length === 0)
		throw new InputError(
			`no events under ${opts.root}/schools/${opts.school}/events`,
		);
	const stored = await readStoredInputs(
		opts.inputs as string,
		env,
		opts.school,
	);
	let result: ReturnType<typeof simulateFromInputs>;
	try {
		result = simulateFromInputs({
			events,
			inputs: stored,
			env,
			school: opts.school,
			candidate,
			current,
			...(effectiveFrom === undefined ? {} : { effectiveFrom }),
			month: opts.month,
			allowBaselineDrift: opts.allowBaselineDrift === true,
		});
	} catch (error) {
		if (error instanceof InputsSimulateError)
			throw new InputError(error.message);
		throw error;
	}
	if (opts.json) {
		const {
			events: _candidateEvents,
			balances: _balances,
			deliveries,
			...rest
		} = result;
		writeJson({
			ok: true,
			school: opts.school,
			env,
			...rest,
			deliveries: deliveries.filter((d) => d.kind !== "same"),
		});
	} else process.stdout.write(`${result.summary}\n`);
	if (result.differences > 0) process.exitCode = EXIT_CONFLICT;
};

const runSimulate = async (opts: SimulateOptions): Promise<void> => {
	if (opts.profile || opts.scenario) {
		if (opts.root || opts.school || opts.inputs)
			throw new InputError(
				"--profile and --scenario generate a scenario; --root, --school and --inputs replay a log. Give one or the other",
			);
		return runScenarioSimulate(opts, scenarioKit);
	}
	if (!(opts.root && opts.school))
		throw new InputError(
			"give --root and --school to replay a log, or --profile <name> (atm scenarios list) to simulate a scenario",
		);
	if (opts.inputs !== undefined)
		return runSimulateFromInputs({
			...opts,
			root: opts.root,
			school: opts.school,
		});
	for (const [flag, value] of [
		["--env", opts.env],
		["--effective-from", opts.effectiveFrom],
		["--current-policy", opts.currentPolicy],
		["--allow-baseline-drift", opts.allowBaselineDrift],
	] as const)
		if (value !== undefined) throw new InputError(`${flag} is for --inputs`);
	assertSchoolFolder(opts.school);
	if (opts.menu && opts.catalog)
		throw new InputError("give --menu or --catalog, not both");
	if (opts.currentMenu && opts.currentCatalog)
		throw new InputError("give --current-menu or --current-catalog, not both");
	if (!(opts.menu || opts.catalog || opts.policy))
		throw new InputError(
			"give at least one of --menu, --catalog and --policy to try",
		);
	if (!(opts.currentMenu || opts.currentCatalog))
		throw new InputError(
			"give --current-menu or --current-catalog: the menu (or catalog rows) the log was written under",
		);
	if (opts.month !== undefined && !SIMULATE_MONTH.test(opts.month))
		throw new InputError(`--month ${opts.month} is not YYYY-MM`);
	const candidate = {
		menu: opts.menu ? await menuFrom("--menu", opts.menu) : undefined,
		catalog: opts.catalog
			? await catalogFrom("--catalog", opts.catalog)
			: undefined,
		policy: opts.policy ? await policyFrom(opts.policy) : undefined,
	};
	const currentMenu = opts.currentMenu
		? await menuFrom("--current-menu", opts.currentMenu)
		: undefined;
	const currentCatalog = opts.currentCatalog
		? await catalogFrom("--current-catalog", opts.currentCatalog)
		: undefined;
	const { events } = await readEvents(opts.root, opts.school);
	if (events.length === 0)
		throw new InputError(
			`no events under ${opts.root}/schools/${opts.school}/events`,
		);
	const { events: _candidateEvents, ...result } = simulate({
		events,
		menu: currentMenu,
		catalog: currentCatalog,
		school: opts.school,
		candidate,
		month: opts.month,
	});
	if (opts.json) writeJson({ ok: true, school: opts.school, ...result });
	else process.stdout.write(`${result.summary}\n`);
	if (result.differences > 0) process.exitCode = EXIT_CONFLICT;
};

const simulateCommand = program
	.command("simulate")
	.description(
		"a what-if: replay a school's event log against a candidate menu or policy and diff balances, posting totals (by month and account) and the commands' decisions against the log; writes nothing. It re-decides credits only: it cannot change what Stripe charged, and the grant rules (upgrade grants, amounts from invoices) are not in the log's commands. Needs the menu or catalog rows the log was written under. Exits 0 with no differences, 1 with differences, 2 for input it cannot use (one line on stderr). With --inputs (the handler's stored Stripe inputs) it is a what-if on the grant rules instead: see the options below",
	)
	.option("--root <folder>", "the folder that holds schools/<id>/")
	.option("--school <id>", "school id, as in schools/<id>/")
	.option(
		"--profile <name>",
		"instead of a log: simulate a seeded scenario of the demo school Before University (presets: atm scenarios list), replay it through the atm, hledger and DuckDB KPI channels and compare their hashes",
	)
	.option(
		"--scenario <file>",
		'with --profile mode: an ad-hoc scenario JSON, like {"profile":"heavy-refunds","params":{"refundRate":0.2}}; "-" reads stdin',
	)
	.option(
		"--set <key=value>",
		"with --profile or --scenario: override a knob, repeatable (--set refundRate=0.2)",
		(value: string, previous: string[] = []) => [...previous, value],
	)
	.option("--seed <n>", "with --profile or --scenario: the seed")
	.option(
		"--channels <list>",
		"with --profile or --scenario: comma list of atm, hledger, duckdb (default all that run)",
	)
	.option("--menu <file>", "the candidate menu (menu.v1 JSON)")
	.option(
		"--catalog <file>",
		"the candidate catalog rows (JSON list of {table, row}, as menuCatalogRows makes), instead of --menu",
	)
	.option(
		"--policy <file>",
		"the candidate policy (policy.v1 JSON, over the defaults); its deductionOrder sets the draw order of every command that carries an org",
	)
	.option("--current-menu <file>", "the menu the log was written under")
	.option(
		"--current-catalog <file>",
		"the catalog rows the log was written under, instead of --current-menu",
	)
	.option(
		"--month <YYYY-MM>",
		"report only this month's posting totals and commands (balances stay as of the last event)",
	)
	.option(
		"--inputs <sqlite file | folder>",
		"the handler's SQLite database, or a folder `atm inputs ship` shipped them to: decide the stored Stripe inputs again (the grant rules: upgradeGrant, what an invoice grants, a menu's prices and tiers) with the recorded menu and policy, which must reproduce the log, and then with the candidate. Opened read-only; writes nothing. Needs --env. --menu and --policy are optional (none is the identity); --current-menu and --current-policy replace the recorded ones; --catalog and --current-catalog are not used",
	)
	.option("--env <live|test>", "with --inputs: the Stripe mode of the inputs")
	.option(
		"--effective-from <ISO instant>",
		"with --inputs: the candidate applies to inputs created from this instant on (default: from the start)",
	)
	.option(
		"--current-policy <file>",
		"with --inputs: the policy the inputs were decided under, instead of the stored one",
	)
	.option(
		"--allow-baseline-drift",
		"with --inputs: go on when the replay with the recorded menu and policy does not reproduce the log (exit 2 otherwise); the drift is reported, not counted",
	)
	.option(
		"--json",
		"print one JSON line ({ok, school, balances, balanceChanges, postingChanges, transactions, changed, refused, unaffected, differences, asOf, summary}; with --inputs: {ok, school, env, baseline, deliveries (the changes), balanceChanges, postingChanges, transactions, notReplayable, replayed, refused, notSimulated, unaffected, differences, asOf, summary}) instead of the summary",
	)
	.action((opts: SimulateOptions) =>
		unattended("simulate", opts.json === true, () => runSimulate(opts)),
	);
exitTwoOnUsageError(simulateCommand);
addScenarioCommands(program, scenarioKit);
