import { Database } from "bun:sqlite";
import { readFile, stat } from "node:fs/promises";
import type { WorkerFullSubject } from "@autumn/balance-engine";
import { Command } from "commander";
import packageJson from "../package.json";
import { engineCommandTypes, runEngineCommand } from "./engine.js";
import { bunSqlite } from "./handler/bun-sqlite.js";
import { journalMonth } from "./ledger/files.js";
import { ReconcileInputError } from "./ledger/reconcile.js";
import {
	formatReconcile,
	reconcileFolder,
	STRIPE_FILES,
} from "./ledger/reconcile-files.js";
import { shipOutbox } from "./ledger/ship.js";
import { FolderStore } from "./store/folder-store.js";

/** How long `atm ship` waits for the handler's write lock on a busy database. */
const BUSY_TIMEOUT_MS = 5000;

/** Exit status of `atm reconcile` for input it cannot use; 1 is for differences found. */
const RECONCILE_BAD_INPUT = 2;

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

program
	.command("journal")
	.description(
		"build a school's hledger journal for one month from its event files: ledger/b4u/YYYY-MM.journal, ledger/accounts.journal, main.journal and ledger/build.json (a file is rewritten only when its bytes change)",
	)
	.requiredOption("--root <folder>", "the folder that holds schools/<id>/")
	.requiredOption("--school <id>", "school id, as in schools/<id>/")
	.requiredOption(
		"--month <YYYY-MM>",
		"month, by the events' school-local date",
	)
	.action(async (opts: { root: string; school: string; month: string }) => {
		const run = await journalMonth(opts);
		const note = run.unchanged
			? "unchanged"
			: `wrote ${run.written.join(", ")}`;
		process.stdout.write(
			`${opts.month}: ${run.build.transactions} transactions; ${note}\n`,
		);
	});

program
	.command("ship")
	.description(
		"ship a school's unshipped ledger_outbox rows from the handler's SQLite file to <root>/schools/<id>/events/date=YYYY-MM-DD/batch-*.jsonl, create-only, safe to rerun; exits 1 when a batch's key already holds different bytes",
	)
	.requiredOption("--db <file>", "the SQLite file the webhook handler writes")
	.requiredOption("--root <folder>", "the folder that holds schools/<id>/")
	.requiredOption("--school <id>", "school id, as in schools/<id>/")
	.action(async (opts: { db: string; root: string; school: string }) => {
		// A typo in --root would otherwise make a new folder and mark every row shipped into it.
		const root = await stat(opts.root).catch(() => null);
		if (!root?.isDirectory()) {
			process.stderr.write(
				`--root ${opts.root} is not an existing folder; create it first (atm ship does not create the root, so that a typo in it ships nothing)\n`,
			);
			process.exitCode = 1;
			return;
		}
		const database = new Database(opts.db, { readwrite: true });
		try {
			database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
			// A typo in --school would otherwise ship nothing and exit 0.
			const schools = bunSqlite(database)
				.all<{ school_id: string }>(
					"SELECT DISTINCT school_id FROM ledger_outbox ORDER BY school_id",
				)
				.map((row) => row.school_id);
			if (!schools.includes(opts.school)) {
				process.stderr.write(
					`--school ${opts.school} has no rows in ledger_outbox of ${opts.db}; schools there: ${schools.length > 0 ? schools.join(", ") : "none"}\n`,
				);
				process.exitCode = 1;
				return;
			}
			const result = await shipOutbox({
				db: bunSqlite(database),
				store: new FolderStore({ root: opts.root }),
				school: opts.school,
				nowMs: Date.now,
			});
			for (const batch of result.batches)
				process.stdout.write(
					`${batch.status} ${batch.key}: ${batch.events} events\n`,
				);
			for (const conflict of result.conflicts)
				process.stderr.write(`conflict ${conflict.key}: ${conflict.message}\n`);
			process.stdout.write(
				`${result.shipped} events shipped in ${result.batches.length} batches; ${result.conflicts.length} conflicts\n`,
			);
			if (result.conflicts.length > 0) process.exitCode = 1;
		} finally {
			database.close();
		}
	});

program
	.command("reconcile")
	.description(
		"compare a school's events for a month (or a range of days) with Stripe's records for the same period: paid invoices, refunds, disputes, payouts, fees and the net. Prints a summary, or --json; exits 0 when nothing differs, 1 when something does, 2 for input it cannot use",
	)
	.option("--root <folder>", "the folder that holds schools/<id>/")
	.option("--school <id>", "school id, as in schools/<id>/")
	.option("--month <YYYY-MM>", "the period, by the school's calendar")
	.option("--from <YYYY-MM-DD>", "first day of a range, instead of --month")
	.option("--to <YYYY-MM-DD>", "last day of a range (inclusive)")
	.option(
		"--stripe <folder>",
		"folder of the JSON that `stripe <resource> list` prints: invoices.json, refunds.json, disputes.json, payouts.json, balance_transactions.json (a missing file is reported as not supplied and exits 2)",
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
