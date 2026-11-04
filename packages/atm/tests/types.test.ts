import { expect, test } from "bun:test";
import type {
	CheckCommand,
	CheckResult,
	DeleteBalanceCommand,
	SubjectStateMutation,
	TrackCommand,
	UpdateBalanceCommand,
	WorkerFullSubject,
} from "@autumn/balance-engine";
import { engineCommandTypes } from "../src/engine.js";
import { commandTypes } from "../src/index.js";
import type {
	AtmCheckResult,
	AtmCommand,
	AtmCommandType,
	AtmMutation,
	AtmResultFor,
	AtmSubject,
} from "../src/types.js";

/* Compile-time drift checks, run by `bun run ts`: each line stops compiling if the engine's type stops fitting atm's. */
const subjectFits = (s: WorkerFullSubject): AtmSubject => s;
const checkCommandFits = (c: CheckCommand): AtmCommand => c;
const checkResultFits = (r: CheckResult): AtmCheckResult => r;
const trackCommandFits = (c: TrackCommand): AtmCommand => c;
const updateBalanceCommandFits = (c: UpdateBalanceCommand): AtmCommand => c;
const deleteBalanceCommandFits = (c: DeleteBalanceCommand): AtmCommand => c;
const updateBalanceResultFits = (
	m: SubjectStateMutation | null,
): AtmResultFor<"updateBalance"> => m;
const trackResultFits = (m: SubjectStateMutation): AtmResultFor<"track"> => m;
const deleteBalanceResultFits = (
	m: SubjectStateMutation,
): AtmResultFor<"deleteBalance"> => m;
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
		trackCommandFits,
		updateBalanceCommandFits,
		deleteBalanceCommandFits,
		trackResultFits,
		updateBalanceResultFits,
		deleteBalanceResultFits,
		mutationFits,
		commandTypesMatch,
	]).toHaveLength(11);
});
