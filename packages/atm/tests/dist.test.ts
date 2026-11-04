import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCheck } from "@autumn/balance-engine";
import {
	createCheckCommand,
	createState,
	createSubjectFor,
} from "../../balance-engine/tests/unit/engineFixtures.js";

/** Builds dist into an empty directory and uses it the way a consumer outside this workspace would. */
let dir: string;
const command = createCheckCommand();
const subject = createSubjectFor({
	state: createState(),
	entityId: command.identity.entityId,
});
const expected = JSON.parse(
	JSON.stringify(computeCheck({ fullSubject: subject, command })),
);

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "atm-consumer-"));
	const build = Bun.spawnSync([
		"bun",
		join(import.meta.dir, "../build.ts"),
		join(dir, "dist"),
	]);
	if (build.exitCode !== 0) throw new Error(build.stderr.toString());
	await writeFile(join(dir, "subject.json"), JSON.stringify(subject));
	await writeFile(join(dir, "command.json"), JSON.stringify(command));
	await writeFile(
		join(dir, "consumer.mjs"),
		[
			'import { readFileSync } from "node:fs";',
			'import { runEngineCommand } from "./dist/index.js";',
			'const read = (f) => JSON.parse(readFileSync(f, "utf8"));',
			'console.log(JSON.stringify(runEngineCommand({ subject: read("subject.json"), command: read("command.json") })));',
		].join("\n"),
	);
}, 120_000);

const run = (cmd: string[]) => {
	const out = Bun.spawnSync(cmd, {
		cwd: dir,
		env: { PATH: process.env.PATH ?? "" },
	});
	if (out.exitCode !== 0)
		throw new Error(out.stdout.toString() + out.stderr.toString());
	return out.stdout.toString();
};

describe("built library", () => {
	test("typechecks against its own declarations alone", async () => {
		await writeFile(
			join(dir, "typed.ts"),
			[
				'import { runEngineCommand, type AtmCheckResult, type AtmCommand, type AtmMutation, type AtmSubject } from "./dist/index.js";',
				"declare const subject: AtmSubject;",
				'declare const check: AtmCommand & { type: "check" };',
				'declare const finalize: AtmCommand & { type: "finalize" };',
				"const decision: AtmCheckResult = runEngineCommand({ subject, command: check });",
				"const mutation: AtmMutation = runEngineCommand({ subject, command: finalize });",
				"export { decision, mutation };",
			].join("\n"),
		);
		await writeFile(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					module: "nodenext",
					moduleResolution: "nodenext",
					target: "es2022",
					types: [],
					noEmit: true,
				},
				files: ["typed.ts"],
			}),
		);
		run([
			process.execPath,
			require.resolve("typescript/bin/tsc"),
			"-p",
			"tsconfig.json",
		]);
	}, 60_000);

	test("runs under Bun with no node_modules", () => {
		expect(JSON.parse(run(["bun", "consumer.mjs"]))).toEqual(expected);
	});

	test("runs under Node", () => {
		expect(JSON.parse(run(["node", "consumer.mjs"]))).toEqual(expected);
	});

	test("the CLI bundle runs alone", () => {
		expect(
			JSON.parse(
				run([
					"bun",
					"dist/atm.js",
					"run",
					"--subject",
					"subject.json",
					"--command",
					"command.json",
				]),
			),
		).toEqual(expected);
	});
});
