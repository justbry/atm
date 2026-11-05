import { expect, test } from "bun:test";
import type {
	CheckCommand,
	CheckResult,
	DeleteBalanceCommand,
	SubjectState,
	SubjectStateMutation,
	TrackCommand,
	UpdateBalanceCommand,
	WorkerFullSubject,
} from "@autumn/balance-engine";
import {
	type ROW_TABLES,
	StaleRevision as StaleRevisionImpl,
} from "../src/billing/rows.js";
import { engineCommandTypes } from "../src/engine.js";
import { commandTypes } from "../src/index.js";
import type {
	AtmCheckResult,
	AtmCommand,
	AtmCommandType,
	AtmMutation,
	AtmResultFor,
	AtmSubject,
	AtmSubjectState,
	RowTable,
	StaleRevisionConstructor,
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

const stateFits = (s: SubjectState): AtmSubjectState => s;
const stateFitsBack = (s: AtmSubjectState): SubjectState =>
	s as unknown as SubjectState;
const rowTablesFit = (t: (typeof ROW_TABLES)[number]): RowTable => t;
const rowTablesFitBack = (t: RowTable): (typeof ROW_TABLES)[number] => t;
const staleRevisionFits = (
	c: typeof StaleRevisionImpl,
): StaleRevisionConstructor => c;

test("billing row types are the engine's", () => {
	expect([
		stateFits,
		stateFitsBack,
		rowTablesFit,
		rowTablesFitBack,
		staleRevisionFits,
	]).toHaveLength(5);
	expect(new StaleRevisionImpl(1, 2)).toBeInstanceOf(Error);
});

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
