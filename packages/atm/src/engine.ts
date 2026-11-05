import {
	computeCheck,
	computeConfirmExpiredLock,
	computeDeleteBalance,
	computeFinalize,
	computeRecalculateBalance,
	computeReset,
	computeTrack,
	computeUpdateBalance,
	parseCheckCommand,
	parseConfirmExpiredLockCommand,
	parseDeleteBalanceCommand,
	parseFinalizeCommand,
	parseRecalculateBalanceCommand,
	parseResetCommand,
	parseTrackCommand,
	parseUpdateBalanceCommand,
	type WorkerFullSubject,
} from "@autumn/balance-engine";

/** The engine commands atm runs. Each is pure: subject + command in, decision or mutation out, nothing written. */
const runners = {
	check: (fullSubject: WorkerFullSubject, input: unknown) =>
		computeCheck({ fullSubject, command: parseCheckCommand({ input }) }),
	finalize: (fullSubject: WorkerFullSubject, input: unknown) =>
		computeFinalize({ fullSubject, command: parseFinalizeCommand({ input }) }),
	confirmExpiredLock: (fullSubject: WorkerFullSubject, input: unknown) =>
		computeConfirmExpiredLock({
			fullSubject,
			command: parseConfirmExpiredLockCommand({ input }),
		}),
	reset: (fullSubject: WorkerFullSubject, input: unknown) =>
		computeReset({ fullSubject, command: parseResetCommand({ input }) }),
	recalculateBalance: (fullSubject: WorkerFullSubject, input: unknown) =>
		computeRecalculateBalance({
			fullSubject,
			command: parseRecalculateBalanceCommand({ input }),
		}),
	track: (fullSubject: WorkerFullSubject, input: unknown) =>
		computeTrack({ fullSubject, command: parseTrackCommand({ input }) }),
	updateBalance: (fullSubject: WorkerFullSubject, input: unknown) =>
		computeUpdateBalance({
			fullSubject,
			command: parseUpdateBalanceCommand({ input }),
		}),
	deleteBalance: (fullSubject: WorkerFullSubject, input: unknown) =>
		computeDeleteBalance({
			fullSubject,
			command: parseDeleteBalanceCommand({ input }),
		}),
} as const;

export type EngineCommandType = keyof typeof runners;

export const engineCommandTypes = Object.keys(runners) as EngineCommandType[];

export const runEngineCommand = ({
	fullSubject,
	command,
}: {
	fullSubject: WorkerFullSubject;
	command: { type?: unknown };
}) => {
	const type = command.type;
	if (typeof type !== "string" || !(type in runners)) {
		throw new Error(
			`unsupported command type ${JSON.stringify(type)}; atm runs: ${engineCommandTypes.join(", ")}`,
		);
	}
	return runners[type as EngineCommandType](fullSubject, command);
};
