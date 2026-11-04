import type { WorkerFullSubject } from "@autumn/balance-engine";
import { engineCommandTypes, runEngineCommand as run } from "./engine.js";
import type {
	AtmCommand,
	AtmCommandType,
	AtmResultFor,
	AtmSubject,
} from "./types.js";

export type * from "./types.js";

export const commandTypes: readonly AtmCommandType[] = engineCommandTypes;

/** Runs one engine command against a subject. Pure: nothing is read or written outside the arguments. */
export const runEngineCommand = <T extends AtmCommandType>({
	subject,
	command,
}: {
	subject: AtmSubject;
	command: AtmCommand & { type: T };
}): AtmResultFor<T> =>
	run({
		fullSubject: subject as unknown as WorkerFullSubject,
		command,
	}) as AtmResultFor<T>;
