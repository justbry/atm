import type {
	SubjectState,
	SubjectStateMutation,
} from "@autumn/balance-engine";
import { rowsFromState, stateFromRows } from "../billing/rows.js";
import type {
	AtmBalance,
	AtmCatalogRow,
	AtmEvent,
	AtmEventContext,
	AtmHold,
	AtmReplayResult,
	AtmSnapshot,
	AtmSubjectState,
} from "../types.js";
import { ULID_PATTERN } from "./ids.js";
import { mutationToEvents } from "./postings.js";
import { runOnState, toCatalog } from "./run.js";
import { canonicalize, isoInstant } from "./util.js";

export class ReplayError extends Error {
	constructor(
		readonly eventId: string,
		message: string,
	) {
		super(`event ${eventId}: ${message}`);
		this.name = "ReplayError";
	}
}

/**
 * The log has a hole the replay cannot step over: engine commands between two revisions of a subject that no event
 * records, in a log a writer that did not log every command (atm 0.3.0) wrote. A write of the grants row alone leaves the
 * same gap and is harmless, but the two cannot be told apart, and a lost command (the cycle-end update after a renewal)
 * changes rows. `prefix` is the replay of everything before the gap, so a caller can read the state it reached.
 */
export class ReplayGapError extends ReplayError {
	constructor(
		eventId: string,
		readonly gap: { subject: string; after: number; before: number },
		readonly prefix: AtmReplayResult,
	) {
		super(
			eventId,
			`the log has no event for revisions ${gap.after + 1} to ${gap.before} of ${gap.subject}: an engine command the writer did not log (atm 0.3.0 did not log the cycle-end update after a renewal) or a write of the grants row alone, and the two cannot be told apart. The log was written by 0.3.0 and cannot be rebuilt past this point; the replay up to it is the error's prefix`,
		);
		this.name = "ReplayGapError";
	}
}

type Catalog = ReturnType<typeof toCatalog>;

/** Available balance per holder and feature as the engine counts it at `asOfMs`: grants and rollovers not yet past their expiry. */
export const balancesOf = ({
	states,
	holds,
	catalog,
	asOfMs,
}: {
	states: Record<string, AtmSubjectState>;
	holds: Record<string, AtmHold>;
	catalog: Catalog;
	asOfMs: number;
}): AtmBalance[] => {
	const out = new Map<string, AtmBalance>();
	const slot = (holder: string, feature: string) => {
		const k = `${holder}\u0000${feature}`;
		let b = out.get(k);
		if (!b) {
			b = { holder, feature, avail: 0, held: 0 };
			out.set(k, b);
		}
		return b;
	};
	const live = (e: unknown) =>
		e === null || e === undefined || (e as number) > asOfMs;
	for (const [holder, raw] of Object.entries(states)) {
		const state = raw as unknown as SubjectState;
		const featureOfRow = new Map<string, string>();
		for (const r of state.customerEntitlements) {
			const feature =
				catalog.features[r.internal_feature_id]?.id ?? r.internal_feature_id;
			featureOfRow.set(r.id, feature);
			const b = slot(holder, feature);
			if (live(r.expires_at)) b.avail += r.balance;
		}
		for (const r of state.rollovers) {
			const feature = featureOfRow.get(r.cus_ent_id);
			if (feature && live(r.expires_at))
				slot(holder, feature).avail += r.balance;
		}
	}
	for (const h of Object.values(holds))
		slot(h.holder, h.feature).held += h.units;
	return [...out.values()].sort((a, b) =>
		a.holder === b.holder
			? a.feature < b.feature
				? -1
				: 1
			: a.holder < b.holder
				? -1
				: 1,
	);
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// `booking` is not derived: a booking command names the caller's booking id there, over the lock id the mutation names.
const DERIVED_LABELS = new Set([
	"feature",
	"entity",
	"plan",
	"service",
	"rolled_over",
	"expires_at",
]);
const DERIVED_PAYLOAD = new Set([
	"command",
	"mutation",
	"leftover",
	"rolled_over",
	"held",
	"reason",
	"lapsed",
	"row_id",
	"previous_expires_at",
	"expires_at",
	"refills_ended",
	"slice",
]);

/** What `credit.low` and `credit.depleted` add to the payload; read from the mutation and the state, not from the context. */
const ALERT_PAYLOAD = new Set([
	"feature",
	"available",
	"threshold",
	"previous_available",
]);
const isAlert = (type: string) =>
	type === "credit.low" || type === "credit.depleted";

/** Everything the postings need that is not in the mutation was written into the event; read it back. */
export const contextFromEvent = (
	e: AtmEvent,
	before: SubjectState | null,
): AtmEventContext => {
	const feature = e.labels.feature;
	if (!feature) throw new ReplayError(e.id, "no labels.feature");
	const payload = e.payload as Record<string, unknown>;
	return {
		school: e.school,
		tz: e.tz,
		feature,
		plan: e.labels.plan,
		service: e.labels.service,
		as: e.event_type === "credit.refunded" ? "refunded" : undefined,
		reason: payload.reason as string | undefined,
		held: payload.held as number | undefined,
		settleAs: e.event_type === "credit.forfeited" ? "forfeited" : "spent",
		source: e.source,
		cause: e.cause,
		ingestTime: e.ingest_time,
		labels: Object.fromEntries(
			Object.entries(e.labels).filter(([k]) => !DERIVED_LABELS.has(k)),
		),
		before: before as unknown as AtmSubjectState | null,
		payload: Object.fromEntries(
			Object.entries(payload).filter(
				([k]) =>
					!DERIVED_PAYLOAD.has(k) &&
					!(isAlert(e.event_type) && ALERT_PAYLOAD.has(k)),
			),
		),
		idemPrefix: e.idem.split(":")[0],
		slice: payload.slice as number[] | undefined,
		// The alerts are made only when the caller gives a threshold: the one `credit.low` was made under; 0 for `credit.depleted`, which has none.
		lowCreditThreshold: isAlert(e.event_type)
			? ((payload.threshold as number | null | undefined) ?? 0)
			: undefined,
	};
};

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type MutationRevision = { before: number; after: number };

export const mutationRevision = (e: AtmEvent): MutationRevision | null => {
	const mutation = (e.payload as { mutation?: { revision?: MutationRevision } })
		.mutation;
	return typeof mutation?.revision?.after === "number"
		? mutation.revision
		: null;
};

/**
 * The order a log replays in. A subject's commands run in the order of its revisions: the engine ran a reset at the
 * start of the period it refills, hours before the plan at payment time that came first, so the event times (and so the
 * ids) of one write can run backwards. An event that carries a mutation takes the latest time its subject's earlier
 * revisions reached; the events without one (an expiry by the clock, a payment) keep their own time and come before the
 * commands of the same instant. A log whose revisions never run backwards in time is in id order, as before.
 */
export const replayOrder = (events: readonly AtmEvent[]): AtmEvent[] => {
	const commands = new Map<string, AtmEvent[]>();
	for (const e of events) {
		if (mutationRevision(e) === null) continue;
		commands.set(e.key, [...(commands.get(e.key) ?? []), e]);
	}
	const reached = new Map<AtmEvent, number>();
	for (const chain of commands.values()) {
		chain.sort(
			(a, b) =>
				(mutationRevision(a)?.after as number) -
					(mutationRevision(b)?.after as number) || compareIds(a.id, b.id),
		);
		let latest = Number.NEGATIVE_INFINITY;
		for (const e of chain) {
			latest = Math.max(latest, Date.parse(e.event_time));
			reached.set(e, latest);
		}
	}
	const rank = (e: AtmEvent) => mutationRevision(e)?.after ?? -1;
	const time = (e: AtmEvent) => reached.get(e) ?? Date.parse(e.event_time);
	return [...events].sort(
		(a, b) => time(a) - time(b) || rank(a) - rank(b) || compareIds(a.id, b.id),
	);
};

/** What the handler writes names its command `<ULID of the stored input event>:<step>`; the family service's own commands do not. */
export const HANDLER_COMMAND = new RegExp(`${ULID_PATTERN.slice(0, -1)}:\\d+$`);

export type RecordedMutation = {
	id: string;
	revision: MutationRevision;
	changes: unknown[];
} & Record<string, unknown>;

/**
 * The mutation of each command as the log holds it: the changes of every event that names the same `mutation.id`, put
 * together. atm 0.3.0 booked a mutation as one event per feature and plan, each recording only its own changes (and a
 * mutation that moved no credits in none), so the whole mutation may be more than the log holds; an event with a
 * `payload.slice` is the current shape, which records it whole.
 */
export const recordedMutations = (events: readonly AtmEvent[]) => {
	const byMutation = new Map<
		string,
		{ mutation: RecordedMutation; sliced: boolean }
	>();
	for (const e of events) {
		const mutation = (e.payload as { mutation?: RecordedMutation }).mutation;
		if (!mutation || typeof mutation.id !== "string") continue;
		const id = `${e.key}\u0000${mutation.id}`;
		const sliced = Array.isArray((e.payload as { slice?: unknown }).slice);
		const known = byMutation.get(id);
		if (!known) {
			byMutation.set(id, {
				mutation: { ...mutation, changes: [...mutation.changes] },
				sliced,
			});
			continue;
		}
		known.sliced ||= sliced;
		const have = new Set(known.mutation.changes.map((c) => canonicalize(c)));
		for (const change of mutation.changes)
			if (!have.has(canonicalize(change))) known.mutation.changes.push(change);
	}
	return byMutation;
};

/**
 * `same`: the changes are the decided ones; `partial`: some of them (an old log's booking); `differs`: not. The order
 * does not count: the events of an old booking are put together in the order they are in, which is not the engine's.
 * (A whole event's own order is held to by the comparison of the event itself.)
 */
export const compareChanges = (
	decided: readonly unknown[],
	recorded: readonly unknown[],
): "same" | "partial" | "differs" => {
	const want = decided.map((c) => canonicalize(c));
	const got = recorded.map((c) => canonicalize(c));
	if (got.length === want.length)
		return [...got].sort().join("\u0000") === [...want].sort().join("\u0000")
			? "same"
			: "differs";
	if (got.length > want.length) return "differs";
	const left = [...want];
	for (const c of got) {
		const at = left.indexOf(c);
		if (at < 0) return "differs";
		left.splice(at, 1);
	}
	return "partial";
};

/** Where an event's own changes sit in the decided mutation's: the cut an old booking was made from. */
const positionsIn = (
	decided: readonly unknown[],
	own: readonly unknown[],
): number[] => {
	const taken = new Set<number>();
	const want = decided.map((c) => canonicalize(c));
	return own.map((c) => {
		const key = canonicalize(c);
		const at = want.findIndex((w, i) => w === key && !taken.has(i));
		taken.add(at);
		return at;
	});
};

/**
 * The state the way the stored rows give it back: each table in id order. The engine lists changes in the order of the
 * rows it holds, and a write path runs every command on rows read from storage, so a replay that carried the engine's
 * own row order on (the order the rows were inserted in) would decide the same mutation with its changes in another
 * order, and fail on the first command that moves two rows (a reset of a monthly and a yearly row together).
 */
export const inStoredOrder = (state: SubjectState): SubjectState =>
	stateFromRows({
		identity: state.identity,
		revision: state.revision,
		rows: rowsFromState(state),
	}) ?? state;

type Cached = {
	mutation: SubjectStateMutation;
	before: SubjectState | null;
};

/**
 * Events back through the engine. Starting from `snapshot` (or nothing), in `replayOrder` (each subject's commands in
 * revision order), each event's command runs with the event's own time as `occurredAt`; the mutation it decides must
 * equal the one recorded, and the events derived from it (postings included) must equal the recorded events. Any
 * difference throws a ReplayError naming the event. `lastEventId` and `snapshot.lastEventId` are places in that order, so
 * give the same events (at least those from the cursor on) each time; a cursor the events do not have is compared by id.
 * Stops after `lastEventId`. Balances are as of `asOf` (default: the last event applied).
 *
 * What the log must hold for this: every command the engine ran, once, with its whole mutation (`handleStripeEvent`
 * records a command that moves no credits as a `plan.changed`). A stored revision that moved without an engine command
 * (a write of the grants row alone) is read from the next mutation's `revision.before`.
 */
export const replayEvents = ({
	events,
	catalog: catalogRows,
	snapshot,
	lastEventId,
	asOf,
}: {
	events: readonly AtmEvent[];
	catalog: readonly AtmCatalogRow[];
	snapshot?: AtmSnapshot;
	lastEventId?: string;
	asOf?: string;
}): AtmReplayResult => {
	const catalog = toCatalog(catalogRows);
	const states: Record<string, AtmSubjectState> = clone(snapshot?.states ?? {});
	const holds: Record<string, AtmHold> = clone(snapshot?.holds ?? {});
	const from = snapshot?.lastEventId ?? null;
	const ordered = replayOrder(events);
	// A cursor is a place in the replay order, which is not the id order: where the events given have it, use that place.
	const placeOf = (id: string) => ordered.findIndex((e) => e.id === id);
	const fromPlace = from === null ? -1 : placeOf(from);
	const stopPlace = lastEventId === undefined ? -1 : placeOf(lastEventId);
	const cache = new Map<string, Cached>();
	const whole = recordedMutations(events);
	/** Subjects whose latest handler command was written by a writer that did not log every command (0.3.0). */
	const lossy = new Set<string>();
	const noteWriter = (e: AtmEvent) => {
		const command = (e.payload as { command?: { commandId?: string } }).command;
		if (!command?.commandId || !HANDLER_COMMAND.test(command.commandId)) return;
		if ((e.payload as { complete?: unknown }).complete === true)
			lossy.delete(e.key);
		else lossy.add(e.key);
	};
	let applied = 0;
	let last: AtmEvent | null = null;
	const result = (): AtmReplayResult => {
		const asOfMs = asOf
			? Date.parse(asOf)
			: last
				? Date.parse(last.event_time)
				: 0;
		return {
			snapshot: { states, holds, lastEventId: last ? last.id : from },
			balances: balancesOf({ states, holds, catalog, asOfMs }),
			asOf: asOf ?? (last ? last.event_time : null),
			applied,
			lastEventId: last ? last.id : from,
			...(lossy.size > 0 ? { lossySubjects: [...lossy].sort() } : {}),
		};
	};

	for (const [place, e] of ordered.entries()) {
		if (from !== null && (fromPlace >= 0 ? place <= fromPlace : e.id <= from)) {
			noteWriter(e);
			continue;
		}
		if (
			lastEventId !== undefined &&
			(stopPlace >= 0 ? place > stopPlace : e.id > lastEventId)
		)
			break;
		const ms = Date.parse(e.event_time);
		const payload = e.payload as Record<string, unknown>;
		const cmd = payload.command as
			| (Record<string, unknown> & {
					type: string;
					commandId: string;
					identity: { customerId: string; entityId: string | null };
			  })
			| undefined;

		const lapsed = payload.lapsed as
			| { table: string; id: string; balance: number; expires_at: number }[]
			| undefined;
		if (e.event_type === "credit.expired" && lapsed) {
			const state = states[e.key] as unknown as SubjectState | undefined;
			for (const row of lapsed) {
				const found = (
					row.table === "rollovers"
						? state?.rollovers
						: state?.customerEntitlements
				)?.find((r) => r.id === row.id);
				if (
					!found ||
					found.balance !== row.balance ||
					found.expires_at !== row.expires_at ||
					row.expires_at > ms
				) {
					throw new ReplayError(
						e.id,
						`the lapsed ${row.table} row ${row.id} is not ${row.balance} past ${isoInstant(row.expires_at)} in the replayed state`,
					);
				}
			}
		}

		if (cmd) {
			if (cmd.identity.entityId !== null)
				throw new ReplayError(e.id, "entity-level states are not replayed yet");
			const key = cmd.identity.customerId;
			const own = payload.mutation as RecordedMutation;
			const gathered = whole.get(`${e.key}\u0000${own.id}`) ?? {
				mutation: own,
				sliced: false,
			};
			const recorded = gathered.mutation;
			const cacheKey = `${key}\u0000${cmd.commandId}`;
			let entry = cache.get(cacheKey);
			const current =
				(states[key] as unknown as SubjectState | undefined) ?? null;
			if (
				!entry &&
				(current === null || current.revision < recorded.revision.after)
			) {
				// Revisions the log has no command for: a write of the grants row alone moved the stored revision on with no
				// engine command, and that is all a writer that logs every command can leave. A log from one that did not
				// (0.3.0) leaves the same gap where a command changed rows, so it is not stepped over.
				const gap =
					current !== null && current.revision < recorded.revision.before;
				const loggedAll =
					!HANDLER_COMMAND.test(cmd.commandId) || payload.complete === true;
				if (current !== null && gap && (lossy.has(key) || !loggedAll))
					throw new ReplayGapError(
						e.id,
						{
							subject: key,
							after: current.revision,
							before: recorded.revision.before,
						},
						result(),
					);
				// the engine ran at the stored revision
				const start =
					current && gap
						? { ...current, revision: recorded.revision.before }
						: current;
				const before = start ? clone(start) : null;
				let run: ReturnType<typeof runOnState>;
				try {
					run = runOnState({
						state: start,
						catalog,
						command: { ...cmd, occurredAt: ms },
					});
				} catch (err) {
					throw new ReplayError(
						e.id,
						`the engine refused: ${(err as Error).message}`,
					);
				}
				if (!run.mutation || !run.state)
					throw new ReplayError(e.id, "the engine decided nothing");
				const { command: _c, ...decided } = run.mutation as unknown as Record<
					string,
					unknown
				>;
				const fit = compareChanges(
					decided.changes as unknown[],
					recorded.changes,
				);
				const sameRest =
					canonicalize({ ...decided, changes: null }) ===
					canonicalize({ ...recorded, changes: null });
				// Fewer changes than the engine decides are an old booking's own cut, never one of the current shape (whole, or sliced).
				if (
					!sameRest ||
					fit === "differs" ||
					(fit === "partial" && gathered.sliced)
				) {
					throw new ReplayError(
						e.id,
						"the engine decides differently from the recorded mutation",
					);
				}
				states[key] = inStoredOrder(
					run.state as SubjectState,
				) as unknown as AtmSubjectState;
				entry = { mutation: run.mutation, before };
				cache.set(cacheKey, entry);
			}
			if (entry && !e.event_type.startsWith("plan.")) {
				const named = payload.slice;
				const changeCount = entry.mutation.changes.length;
				if (
					named !== undefined &&
					(!Array.isArray(named) ||
						named.some(
							(position) =>
								!Number.isInteger(position) ||
								position < 0 ||
								position >= changeCount,
						))
				)
					throw new ReplayError(
						e.id,
						`the slice of the recorded event is not positions among the ${changeCount} changes of the mutation`,
					);
				const context = contextFromEvent(e, entry.before);
				// An event of the old shape holds fewer changes than the mutation: its own cut, whichever its siblings are.
				const cut =
					!Array.isArray(payload.slice) &&
					own.changes.length < entry.mutation.changes.length
						? positionsIn(entry.mutation.changes, own.changes)
						: undefined;
				if (cut?.includes(-1))
					throw new ReplayError(
						e.id,
						"the changes of the recorded event are not among the ones the engine decides",
					);
				const derived = mutationToEvents({
					mutation: entry.mutation,
					context: cut ? { ...context, slice: cut } : context,
				});
				const made = derived.find((d) => d.idem === e.idem);
				// An old booking recorded its own cut as its mutation, and no `slice` beside it.
				const match =
					made && cut
						? {
								...made,
								payload: {
									...Object.fromEntries(
										Object.entries(made.payload).filter(([k]) => k !== "slice"),
									),
									mutation: own,
								},
							}
						: made;
				if (!match || canonicalize(match) !== canonicalize(e)) {
					throw new ReplayError(
						e.id,
						"the recorded event differs from the one the mutation derives",
					);
				}
			}
			noteWriter(e);
			if (e.event_type === "credit.held") {
				const lock = (
					recorded.changes as {
						table: string;
						op: string;
						row?: { id: string };
					}[]
				).find((c) => c.table === "locks" && c.op === "insert");
				const units = Number(
					e.postings.find((p) => p.account.startsWith("credits:held:"))?.amount,
				);
				if (lock?.row)
					holds[lock.row.id] = {
						holder: cmd.identity.customerId,
						feature: e.labels.feature as string,
						units,
					};
			} else if (
				["credit.released", "credit.spent", "credit.forfeited"].includes(
					e.event_type,
				)
			) {
				const lock = (cmd as { lock?: { id: string } }).lock;
				if (lock) delete holds[lock.id];
			}
		}
		applied += 1;
		last = e;
	}

	return result();
};
