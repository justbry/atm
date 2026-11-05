import type {
	SubjectState,
	SubjectStateMutation,
} from "@autumn/balance-engine";
import { resolveEnv } from "../billing/env.js";
import { assertCurrentSchema } from "../handler/schema.js";
import type {
	AtmEnv,
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
 * The one insert into `ledger_outbox`, for the handler and for the family service alike: the Stripe mode the events were
 * decided in (`env`), the event's own school, id, idem and date, its canonical line as the body, and `ON CONFLICT
 * (school_id, env, idem) DO NOTHING`, so an event the outbox already holds in that env (a retry, a second run of a cron)
 * is left as it was, while the same idem decided in the other env is a row of its own. Runs in the caller's transaction.
 * Returns the rows inserted.
 */
export const appendToOutbox = (
	db: SqlDatabase,
	events: readonly AtmEvent[],
	env: AtmEnv,
): number => {
	assertCurrentSchema(db);
	let inserted = 0;
	for (const event of events)
		inserted += db.run(
			`INSERT INTO ledger_outbox (school_id, env, id, idem, date, body, batch_key, shipped_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT (school_id, env, idem) DO NOTHING`,
			[
				event.school,
				env,
				event.id,
				event.idem,
				event.date,
				canonicalize(event),
			],
		).changes;
	return inserted;
};

/** The command did not move the subject: the engine decided nothing, or it rejected the command (a track or finalize short of balance). */
const decidedNothing = (mutation: SubjectStateMutation | null): boolean =>
	mutation === null ||
	(mutation.result as { status?: string } | undefined)?.status === "rejected";

/** Commands that move rows of several features at once (and make rollover rows): the events are cut by feature and plan, which only the handler does. */
const HANDLER_ONLY_COMMANDS = new Set(["reset", "applyBillingPlan"]);

/**
 * `idem` is by command id for the whole school, and an event the outbox already holds under it is left as it was. So a
 * command id that names a second command (another family's, or this subject's next step) would have its events dropped
 * while its rows were written, and a log that lost them no longer replays to the rows. Only the same command at the same
 * revision may find its events held (a second record of one command); anything else is refused, and the caller's
 * transaction rolls back the rows with it.
 */
const refuseReusedCommandId = (
	db: SqlDatabase,
	mutation: SubjectStateMutation,
): void => {
	assertCurrentSchema(db);
	const { id: commandId, revision } = mutation;
	const { orgId, customerId } = mutation.identity;
	const held = db.all<{ body: string }>(
		`SELECT body FROM ledger_outbox WHERE school_id = ? AND env = ? AND ((idem >= ? AND idem < ?) OR idem = ?)`,
		[
			orgId,
			resolveEnv(mutation.identity.env),
			`engine:${commandId}:`,
			`engine:${commandId};`,
			`plan:${commandId}`,
		],
	);
	for (const { body } of held) {
		const event = JSON.parse(body) as AtmEvent;
		const recorded = event.payload.mutation as
			| { id?: string; revision?: { after?: number } }
			| undefined;
		if (recorded?.id !== commandId) continue;
		if (event.key !== customerId || recorded.revision?.after !== revision.after)
			throw new Error(
				`recordEngineCommand: command id ${commandId} is already in the outbox for ${event.key} at revision ${String(recorded.revision?.after)}; this command is for ${customerId} at revision ${revision.after}. A command id names one command: use a new one for each command, and do not run the engine again for a request that already committed`,
			);
	}
};

/**
 * The events of one engine command the family service ran, as the handler would book it, appended to the outbox. The
 * whole mutation is on every event; a command that moves no credits is a `plan.changed`. `idem` is
 * `engine:<commandId>:<suffix>` (`plan:<commandId>` for the `plan.changed`), so the same command recorded twice is one
 * event, and a command id another command already used throws (`refuseReusedCommandId`). Nothing is written for a command the engine decided nothing for (null) or
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
	const type = (decided.command as { type: string }).type;
	if (HANDLER_ONLY_COMMANDS.has(type))
		throw new Error(
			`recordEngineCommand: a ${type} moves several features and is the handler's to record, not the family service's`,
		);
	refuseReusedCommandId(db, decided);
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
						source: context.source,
						ingestTime: context.ingestTime,
						complete: logsEveryCommand,
					}),
				];
	return {
		events,
		inserted: appendToOutbox(db, events, resolveEnv(decided.identity.env)),
	};
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
	return {
		events,
		inserted: appendToOutbox(db, events, resolveEnv(identity.env)),
	};
};
