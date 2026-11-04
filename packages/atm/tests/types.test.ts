import { expect, test } from "bun:test";
import type {
	CheckCommand,
	CheckResult,
	SubjectStateMutation,
	WorkerFullSubject,
} from "@autumn/balance-engine";
import { engineCommandTypes } from "../src/engine.js";
import { commandTypes } from "../src/index.js";
import type {
	AtmCheckResult,
	AtmCommand,
	AtmCommandType,
	AtmMutation,
	AtmSubject,
} from "../src/types.js";

/* Compile-time drift checks, run by `bun run ts`: each line stops compiling if the engine's type stops fitting atm's. */
const subjectFits = (s: WorkerFullSubject): AtmSubject => s;
const checkCommandFits = (c: CheckCommand): AtmCommand => c;
const checkResultFits = (r: CheckResult): AtmCheckResult => r;
const mutationFits = (m: SubjectStateMutation): AtmMutation => m;
const commandTypesMatch = (
	t: (typeof engineCommandTypes)[number],
): AtmCommandType => t;

test("atm's command types are the engine's", () => {
	expect([...commandTypes].sort()).toEqual([...engineCommandTypes].sort());
	expect([
		subjectFits,
		checkCommandFits,
		checkResultFits,
		mutationFits,
		commandTypesMatch,
	]).toHaveLength(5);
});
