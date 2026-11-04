import { readFile } from "node:fs/promises";
import type { WorkerFullSubject } from "@autumn/balance-engine";
import { Command } from "commander";
import { engineCommandTypes, runEngineCommand } from "./engine.js";

const readJson = async (path: string) =>
	JSON.parse(
		path === "-" ? await Bun.stdin.text() : await readFile(path, "utf8"),
	);

export const program = new Command()
	.name("atm")
	.description("Autumn's balance engine as a local CLI")
	.version("0.0.1");

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
