/** A scenario made into a fixture: its events, its periods and one content hash of the input and the output. */
import { canonicalize, sha256Hex } from "../ledger/util.js";
import type { AtmEvent } from "../types.js";
import { type GenerateStats, generateScenario } from "./generate.js";
import { type ResolvedScenario, resolveScenario } from "./profiles.js";

export type Fixture = {
	scenario: ResolvedScenario;
	periods: string[];
	events: AtmEvent[];
	stats: GenerateStats;
	/** sha256 of the canonical JSON of `{ scenario, events }`: keys sorted, amounts and dates as the events carry them (two-place decimal strings, UTC `Z` instants and local `YYYY-MM-DD`). */
	hash: string;
};

export const fixtureHash = (
	scenario: ResolvedScenario,
	events: readonly AtmEvent[],
): string => sha256Hex(canonicalize({ scenario, events }));

/** Resolves an input (a preset name, knobs, a seed) and generates it. Throws `ScenarioInputError` for a bad input, with one line per problem. */
export const buildFixture = (input: unknown): Fixture => {
	const scenario = resolveScenario(input);
	const { events, periods, stats } = generateScenario(scenario);
	return {
		scenario,
		periods,
		events,
		stats,
		hash: fixtureHash(scenario, events),
	};
};
