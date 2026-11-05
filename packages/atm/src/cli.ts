import { Database } from "bun:sqlite";
import { readFile, stat } from "node:fs/promises";
import type { WorkerFullSubject } from "@autumn/balance-engine";
import { Command } from "commander";
import packageJson from "../package.json";
import { engineCommandTypes, runEngineCommand } from "./engine.js";
import { bunSqlite } from "./handler/bun-sqlite.js";
import { journalMonth } from "./ledger/files.js";
import { shipOutbox } from "./ledger/ship.js";
import { FolderStore } from "./store/folder-store.js";

/** How long `atm ship` waits for the handler's write lock on a busy database. */
const BUSY_TIMEOUT_MS = 5000;

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
