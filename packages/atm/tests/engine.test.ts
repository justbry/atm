import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeCheck,
	computeDeleteBalance,
	computeTrack,
	computeUpdateBalance,
} from "@autumn/balance-engine";
import {
	createCheckCommand,
	createDeleteBalanceCommand,
	createState,
	createSubjectFor,
	createTrackCommand,
	createUpdateBalanceCommand,
} from "../../balance-engine/tests/unit/engineFixtures.js";
import { runEngineCommand } from "../src/engine.js";

const subjectAndCommand = () => {
	const command = createCheckCommand();
	const fullSubject = createSubjectFor({
		state: createState(),
		entityId: command.identity.entityId,
	});
	return { command, fullSubject };
};

describe("atm run", () => {
	test("a check gives what the engine gives", () => {
		const { command, fullSubject } = subjectAndCommand();
		expect(runEngineCommand({ fullSubject, command })).toEqual(
			computeCheck({ fullSubject, command }),
		);
	});

	test("a track gives what the engine gives", () => {
		const command = createTrackCommand({ value: 5, overageBehavior: "cap" });
		const fullSubject = createSubjectFor({
			state: createState({ balance: 100 }),
			entityId: command.identity.entityId,
		});
		const result = runEngineCommand({ fullSubject, command });
		expect(result).toEqual(computeTrack({ fullSubject, command }));
		expect((result as { type: string }).type).toBe("mutation");
	});

	test("an updateBalance gives what the engine gives", () => {
		const command = createUpdateBalanceCommand({ addToBalance: 10 });
		const fullSubject = createSubjectFor({
			state: createState({ balance: 100 }),
			entityId: command.identity.entityId,
		});
		const result = runEngineCommand({ fullSubject, command });
		expect(result).toEqual(computeUpdateBalance({ fullSubject, command }));
		expect(result).not.toBeNull();
	});

	test("an updateBalance that moves nothing gives null", () => {
		const command = createUpdateBalanceCommand();
		const fullSubject = createSubjectFor({
			state: createState(),
			entityId: command.identity.entityId,
		});
		expect(runEngineCommand({ fullSubject, command })).toBeNull();
	});

	test("a deleteBalance gives what the engine gives", () => {
		const command = createDeleteBalanceCommand();
		const fullSubject = createSubjectFor({
			state: createState({ balance: 100 }),
			entityId: command.identity.entityId,
		});
		expect(runEngineCommand({ fullSubject, command })).toEqual(
			computeDeleteBalance({ fullSubject, command }),
		);
	});

	test("an unknown command type is refused", () => {
		const { fullSubject } = subjectAndCommand();
		expect(() =>
			runEngineCommand({ fullSubject, command: { type: "evict" } }),
		).toThrow(/unsupported command type "evict"/);
	});

	test("a command the engine's parser rejects is refused", () => {
		const { fullSubject } = subjectAndCommand();
		expect(() =>
			runEngineCommand({ fullSubject, command: { type: "check" } }),
		).toThrow();
	});

	test("the CLI prints the decision as JSON", async () => {
		const { command, fullSubject } = subjectAndCommand();
		const dir = await mkdtemp(join(tmpdir(), "atm-"));
		const subjectPath = join(dir, "subject.json");
		const commandPath = join(dir, "command.json");
		await writeFile(subjectPath, JSON.stringify(fullSubject));
		await writeFile(commandPath, JSON.stringify(command));

		const run = Bun.spawnSync([
			"bun",
			join(import.meta.dir, "../src/bin.ts"),
			"run",
			"--subject",
			subjectPath,
			"--command",
			commandPath,
		]);

		expect(run.exitCode).toBe(0);
		expect(JSON.parse(run.stdout.toString())).toEqual(
			JSON.parse(JSON.stringify(computeCheck({ fullSubject, command }))),
		);
	});
});
