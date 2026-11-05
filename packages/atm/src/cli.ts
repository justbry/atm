import { readFile } from "node:fs/promises";
import type { WorkerFullSubject } from "@autumn/balance-engine";
import { Command } from "commander";
import packageJson from "../package.json";
import { engineCommandTypes, runEngineCommand } from "./engine.js";
import { journalMonth } from "./ledger/files.js";

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
