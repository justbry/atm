import type {
	SubjectState,
	SubjectStateMutation,
} from "@autumn/balance-engine";
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

const DERIVED_LABELS = new Set([
	"feature",
	"entity",
	"plan",
	"service",
	"booking",
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
]);

/** Everything the postings need that is not in the mutation was written into the event; read it back. */
const contextFromEvent = (
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
			Object.entries(payload).filter(([k]) => !DERIVED_PAYLOAD.has(k)),
		),
		idemPrefix: e.idem.split(":")[0],
	};
};

type Cached = { mutation: SubjectStateMutation; before: SubjectState | null };

/**
 * Events back through the engine. Starting from `snapshot` (or nothing), in id order, each event's command runs
 * with the event's own time as `occurredAt`; the mutation it decides must equal the one recorded, and the
 * events derived from it (postings included) must equal the recorded events. Any difference throws a ReplayError
 * naming the event. Stops after `lastEventId`. Balances are as of `asOf` (default: the last event applied).
 *
 * Not yet replayable from a `handleStripeEvent` log: a write whose commands run out of time order (a reset at the
 * period start after a plan at payment time), a command that derives no event (the cycle-end update after a
 * renewal), or a mutation booked as one event per feature (each event records only its feature's changes).
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
	const sorted = [...events].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	const cache = new Map<string, Cached>();
	let applied = 0;
	let last: AtmEvent | null = null;

	for (const e of sorted) {
		if (from !== null && e.id <= from) continue;
		if (lastEventId !== undefined && e.id > lastEventId) break;
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
			const recorded = payload.mutation as {
				revision: { after: number };
			} & Record<string, unknown>;
			let entry = cache.get(cmd.commandId);
			const current =
				(states[key] as unknown as SubjectState | undefined) ?? null;
			if (
				!entry &&
				(current === null || current.revision < recorded.revision.after)
			) {
				const before = current ? clone(current) : null;
				let run: ReturnType<typeof runOnState>;
				try {
					run = runOnState({
						state: current,
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
				if (canonicalize(decided) !== canonicalize(recorded)) {
					throw new ReplayError(
						e.id,
						"the engine decides differently from the recorded mutation",
					);
				}
				states[key] = run.state as unknown as AtmSubjectState;
				entry = { mutation: run.mutation, before };
				cache.set(cmd.commandId, entry);
			}
			if (entry && !e.event_type.startsWith("plan.")) {
				const derived = mutationToEvents({
					mutation: entry.mutation,
					context: contextFromEvent(e, entry.before),
				});
				const match = derived.find((d) => d.idem === e.idem);
				if (!match || canonicalize(match) !== canonicalize(e)) {
					throw new ReplayError(
						e.id,
						"the recorded event differs from the one the mutation derives",
					);
				}
			}
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
	};
};
