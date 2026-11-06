import type { Writer } from "../data/writer.ts";

/** The fixture Writer: records every call in `calls`; in `hold` mode each call stays pending until `release()`. */
export function createFixtureWriter(options: {
	mode: "instant" | "hold";
}): Writer & {
	calls: Array<{ method: string; args: unknown[] }>;
	release(): void;
} {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	let held: Array<() => void> = [];
	const record = async <Result>(
		method: string,
		args: unknown[],
		result: Result,
	): Promise<Result> => {
		calls.push({ method, args });
		if (options.mode === "hold")
			await new Promise<void>((resolve) => held.push(resolve));
		return result;
	};
	return {
		calls,
		release: () => {
			for (const resolve of held) resolve();
			held = [];
		},
		recordOutcome: (request) =>
			record("recordOutcome", [request], { creditEffect: "not_wired" }),
		cancelBooking: (request) => record("cancelBooking", [request], undefined),
	};
}
