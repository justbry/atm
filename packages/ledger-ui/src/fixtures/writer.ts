import type { Writer } from "../data/writer.ts";

/** The fixture Writer: records every call in `calls`; in `hold` mode each call stays pending until `release()`.
 * S0's Writer has no methods, so nothing is recorded or held yet; the first slice with a write adds that here. */
export function createFixtureWriter(_options: {
	mode: "instant" | "hold";
}): Writer & {
	calls: Array<{ method: string; args: unknown[] }>;
	release(): void;
} {
	return { calls: [], release: () => undefined };
}
