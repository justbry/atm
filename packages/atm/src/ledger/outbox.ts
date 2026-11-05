import type {
	SubjectState,
	SubjectStateMutation,
} from "@autumn/balance-engine";
import type {
	AtmEvent,
	RecordEngineCommandInput,
	RecordedEvents,
	RecordLapseInput,
	SqlDatabase,
} from "../types.js";
import {
	lapseAlertEvents,
	lapsedRows,
	lapseEvent,
	mutationToEvents,
	planChangedEvent,
} from "./postings.js";
import { canonicalize } from "./util.js";

/**
 * The one insert into `ledger_outbox`, for the handler and for the family service alike: the event's own school, id, idem
 * and date, its canonical line as the body, and `ON CONFLICT (school_id, idem) DO NOTHING`, so an event the outbox already
 * holds (a retry, a second run of a cron) is left as it was. Runs in the caller's transaction. Returns the rows inserted.
 */
export const appendToOutbox = (
	db: SqlDatabase,
	events: readonly AtmEvent[],
): number => {
	let inserted = 0;
	for (const event of events)
		inserted += db.run(
			`INSERT INTO ledger_outbox (school_id, id, idem, date, body, batch_key, shipped_at) VALUES (?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT (school_id, idem) DO NOTHING`,
			[event.school, event.id, event.idem, event.date, canonicalize(event)],
		).changes;
	return inserted;
};

/** The command did not move the subject: the engine decided nothing, or it rejected the command (a track or finalize short of balance). */
const decidedNothing = (mutation: SubjectStateMutation | null): boolean =>
	mutation === null ||
	(mutation.result as { status?: string } | undefined)?.status === "rejected";

/**
 * The events of one engine command the family service ran, as the handler would book it, appended to the outbox. The
 * whole mutation is on every event; a command that moves no credits is a `plan.changed`. `idem` is
 * `engine:<commandId>:<suffix>` (`plan:<commandId>` for the `plan.changed`), so the same command recorded twice, or run
 * again on a retried request, is one event. Nothing is written for a command the engine decided nothing for (null) or
 * rejected, which change no rows either.
 *
 * This takes the caller's `db` and opens no transaction of its own: call it inside the transaction that writes the
 * subject's rows (after the revision check), so the rows and the events of a command commit together or not at all.
 */
export const recordEngineCommand = ({
	db,
	mutation,
	before,
	context,
	logsEveryCommand = false,
}: RecordEngineCommandInput): RecordedEvents => {
	const decided = mutation as unknown as SubjectStateMutation | null;
	if (decided === null || decidedNothing(decided))
		return { events: [], inserted: 0 };
	const credits = mutationToEvents({
		mutation: decided,
		context: {
			...context,
			school: decided.identity.orgId,
			before,
			...(logsEveryCommand ? { payload: { complete: true } } : {}),
		},
	});
	const events =
		credits.length > 0
			? credits
			: [
					planChangedEvent({
						mutation: decided,
						tz: context.tz,
						cause: context.cause,
						labels: context.labels,
						complete: logsEveryCommand,
					}),
				];
	return { events, inserted: appendToOutbox(db, events) };
};

/**
 * The `credit.expired` events for the rows of one feature that lapsed by `atMs` (`lapsedRows` then `lapseEvent`), and
 * with `drawnAfter` the `credit.depleted` events of `lapseAlertEvents`, appended to the outbox. `idem` names the holder,
 * the row and its expiry, so a cron that runs again on the same state books nothing new. Same transaction rule as
 * `recordEngineCommand`: call it where the cron writes its own marks.
 */
export const recordLapse = ({
	db,
	state,
	featureOf,
	feature,
	atMs,
	tz,
	drawnAfter,
	labels,
}: RecordLapseInput): RecordedEvents => {
	const subject = state as unknown as SubjectState;
	const { identity, revision } = subject;
	const key = identity.customerId;
	const holder = identity.entityId ?? identity.customerId;
	const expired = lapsedRows({
		state: subject,
		featureOf,
		feature,
		atMs,
	}).map((row) =>
		lapseEvent({
			row,
			holder,
			key,
			feature,
			school: identity.orgId,
			tz,
			revision,
			labels,
		}),
	);
	const depleted =
		drawnAfter === undefined
			? []
			: lapseAlertEvents({
					state: subject,
					featureOf,
					feature,
					atMs,
					drawnAfter,
					key,
					school: identity.orgId,
					tz,
					revision,
					labels,
				});
	const events = [...expired, ...depleted];
	return { events, inserted: appendToOutbox(db, events) };
};
