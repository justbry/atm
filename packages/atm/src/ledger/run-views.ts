/**
 * One scheduled run of the views, as a cron-triggered Worker does it: read the school's events from the store, build the
 * views as of `asOf`, write them (changed objects only, manifest last). Worker-safe: `readEventsFromStore`,
 * `buildViews` and `writeViews` need no disk, no Ajv, no hledger.
 */
import type { Store } from "../types.js";
import { readEventsFromStore } from "./read.js";
import type { SummaryOptions, SummaryProblem } from "./summary.js";
import {
	buildViews,
	type Views,
	type WriteViewsResult,
	writeViews,
} from "./views.js";

export type RunViewsResult =
	| {
			ok: true;
			/** The events read: the whole log, whatever `asOf`. */
			eventCount: number;
			views: Views;
			written: WriteViewsResult;
	  }
	| { ok: false; error: SummaryProblem };

/**
 * Reads `schools/<school>/events/` from `store`, builds the views as of `asOf` and writes them under
 * `schools/<school>/views/`. `options.catalog` is the catalog rows the log was written under; without it the latest
 * `catalog.published` event in the log is the catalog. A log that cannot be replayed gives the reason and writes
 * nothing. A run whose `asOf` is older than the stored manifest's writes nothing (`written.stale`).
 */
export const runViews = async (
	store: Store,
	school: string,
	asOf: Date,
	options: SummaryOptions = {},
): Promise<RunViewsResult> => {
	const events = await readEventsFromStore(store, school);
	const built = buildViews(events, { ...options, school, asOf });
	if (!built.ok) return built;
	const written = await writeViews(store, school, built.views);
	return {
		ok: true,
		eventCount: events.length,
		views: built.views,
		written,
	};
};
