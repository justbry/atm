/**
 * The family service in miniature, for tests: one subject's stored rows and revision, the event log, and one write per
 * Stripe event, exactly as the caller of `handleStripeEvent` does it.
 */
import { EMPTY_GRANTS_STATE, menuCatalogRows } from "../billing/grants.js";
import { handleStripeEvent } from "../billing/handle.js";
import { DEFAULT_POLICY } from "../billing/policy.js";
import {
	applyRowChanges,
	type BillingRow,
	grantsRow,
	rowChangesFromMutation,
	stateFromRows,
} from "../billing/rows.js";
import { menuLineItems } from "../billing/stripe-menu.js";
import type {
	Menu,
	StripeEventInput,
	StripeEventResult,
} from "../billing/types.js";
import { deterministicUlid } from "../ledger/ids.js";
import {
	lapsedRows,
	lapseEvent,
	mutationToEvents,
} from "../ledger/postings.js";
import { balancesOf } from "../ledger/replay.js";
import { runOnState, toCatalog } from "../ledger/run.js";
import { canonicalize } from "../ledger/util.js";
import type { AtmEvent, AtmEventContext } from "../types.js";
import { paymentIntentOf, priceIdOf } from "./stripe-events.js";

/**
 * The engine's rows of a subject as one comparable string: the revision left out (the stored one also moves on a write of
 * the grants row alone) and each table in id order.
 */
export const engineRowsOf = (state: unknown): string => {
	const { revision: _revision, ...tables } = state as Record<string, unknown>;
	const byId = (a: unknown, b: unknown) =>
		(a as { id: string }).id < (b as { id: string }).id ? -1 : 1;
	return canonicalize(
		Object.fromEntries(
			Object.entries(tables).map(([table, value]) => [
				table,
				Array.isArray(value) ? [...value].sort(byId) : value,
			]),
		),
	);
};

export const createStore = ({
	menu,
	school,
	family,
	profile,
	menuVersion = 1,
	policyVersion = 1,
	start,
	onHandled,
}: {
	menu: Menu;
	school: string;
	family: string;
	/**
	 * A child's own profile id: the store's holder is `profile:<id>` instead of `family:<family>`. The invoices still name
	 * the family (`family_id`, as checkout does); the holder is seeded in the stored grants row, which the handler obeys
	 * before it reads the metadata.
	 */
	profile?: string;
	menuVersion?: number;
	policyVersion?: number;
	/** The stored rows and revision to carry on from (a subject written earlier). */
	start?: { rows: BillingRow[]; revision: number };
	/** Called with each input and its result, before the rows move on: a test checks another path against `handleStripeEvent`. */
	onHandled?: (input: StripeEventInput, result: StripeEventResult) => void;
}) => {
	const holder =
		profile === undefined ? `family:${family}` : `profile:${profile}`;
	const identity = {
		orgId: school,
		env: "live",
		customerId: holder,
		entityId: null,
	};
	const catalogRows = menuCatalogRows({ menu, school });
	const catalog = toCatalog(catalogRows);
	const priceIds = Object.fromEntries(
		[...menuLineItems(school, menu).keys()].map((key) => [key, priceIdOf(key)]),
	);
	const invoiceIds: Record<string, string> = {};
	const seededRows: BillingRow[] =
		profile === undefined
			? []
			: [
					grantsRow({
						...EMPTY_GRANTS_STATE,
						holder: { orgId: school, customerId: holder },
					}),
				];
	let rows: BillingRow[] = start?.rows ?? seededRows;
	let revision = start?.revision ?? 0;
	let spends = 0;
	let bookings = 0;
	const lapsed = new Set<string>();
	const events: AtmEvent[] = [];
	const results: StripeEventResult[] = [];

	const state = () => stateFromRows({ identity, revision, rows });
	return {
		holder,
		get rows() {
			return rows;
		},
		get revision() {
			return revision;
		},
		/** The engine's state as the stored rows hold it now. */
		engineState: state,
		events,
		results,
		/** One raw Stripe event at `at`; the stored input event's id is a ULID decided by the event. */
		handle(
			event: unknown,
			at: number,
			extra: { fee?: number; school?: string } = {},
		) {
			const raw = event as {
				id: string;
				type: string;
				data: { object: { id: string } };
			};
			if (raw.type === "invoice.paid")
				invoiceIds[paymentIntentOf(raw.data.object.id)] = raw.data.object.id;
			const input: StripeEventInput = {
				event,
				eventId: deterministicUlid({
					timeMs: at,
					revision: 0,
					seed: canonicalize([school, raw.id]),
				}),
				menu,
				menuVersion,
				policy: DEFAULT_POLICY,
				policyVersion,
				rows,
				revision,
				catalog: catalogRows,
				now: at,
				priceIds,
				invoiceIds,
				...extra,
			};
			const result = handleStripeEvent(input);
			onHandled?.(input, result);
			results.push(result);
			if (result.rowChanges)
				({ rows, revision } = applyRowChanges({
					rows,
					revision,
					changes: result.rowChanges,
				}));
			// The outbox's key is (school, idem): an event the log already holds is not written again (a refund's money line
			// comes back with the same idem when the refund is handled twice).
			const known = new Set(events.map((e) => e.idem));
			events.push(...result.events.filter((e) => !known.has(e.idem)));
			return result;
		},
		/** The family service takes `n` visits out (a booking, short of the hold and finalize steps). */
		spend(n: number, at: number, feature = "visit") {
			spends += 1;
			const command = {
				schemaVersion: 1,
				type: "updateBalance",
				org: { config: {} },
				// `idem` is `engine:<commandId>:<kind>` and unique per school, so a command id names its subject too
				commandId: `${holder}:spend_${spends}`,
				requestId: `${holder}:spend_${spends}`,
				identity,
				occurredAt: at,
				featureId: feature,
				internalFeatureId: `feat_${feature}`,
				addToBalance: -n,
			};
			const before = state();
			const run = runOnState({ state: before, catalog, command });
			if (!run.mutation) return;
			// the family service logs its own commands as it runs them, so the log holds every one
			events.push(
				...mutationToEvents({
					mutation: run.mutation,
					context: {
						school,
						tz: menu.timeZone,
						feature,
						reason: `${feature} taken`,
						before: before as never,
					},
				}),
			);
			const changes = rowChangesFromMutation({
				mutation: run.mutation as never,
				rows,
				revision,
			});
			({ rows, revision } = applyRowChanges({ rows, revision, changes }));
		},
		/**
		 * Any other command the family service runs (a hold, a finalize, a refund), recorded as `recordEngineCommand` does:
		 * the engine decides it, the rows are written and the mutation's events join the log. Returns the mutation.
		 */
		serviceCommand({
			type,
			at,
			fields,
			context = {},
		}: {
			type: string;
			at: number;
			fields: Record<string, unknown>;
			context?: Partial<AtmEventContext>;
		}) {
			spends += 1;
			const command = {
				schemaVersion: 1,
				type,
				org: { config: {} },
				commandId: `${holder}:${type}_${spends}`,
				requestId: `${holder}:${type}_${spends}`,
				identity,
				occurredAt: at,
				...fields,
			};
			const before = state();
			const { mutation } = runOnState({ state: before, catalog, command });
			if (!mutation) throw new Error(`${type} decided nothing`);
			events.push(
				...mutationToEvents({
					mutation,
					context: {
						school,
						tz: menu.timeZone,
						feature: "visit",
						before: before as never,
						...context,
					},
				}),
			);
			const changes = rowChangesFromMutation({
				mutation: mutation as never,
				rows,
				revision,
			});
			({ rows, revision } = applyRowChanges({ rows, revision, changes }));
			return mutation;
		},
		/**
		 * The family service books one unit of `feature` the way a booking does: a `track` that holds it under a lock, then a
		 * `finalize` that spends it (a `credit.held`, then a `credit.spent` on `service`). Returns false when none is available.
		 */
		consume({
			feature,
			service,
			holdAt,
			spendAt,
		}: {
			feature: string;
			service: string;
			holdAt: number;
			spendAt: number;
		}) {
			if (this.avail(holdAt, feature) < 1) return false;
			bookings += 1;
			const lockId = `lock_${bookings}`;
			const held = this.serviceCommand({
				type: "track",
				at: holdAt,
				fields: {
					featureId: feature,
					internalFeatureId: `feat_${feature}`,
					value: 1,
					overageBehavior: "reject",
					properties: null,
					usageEvent: null,
					lock: {
						id: lockId,
						lockId: `bk_${bookings}`,
						expiresAt: spendAt + 2 * 3_600_000,
						expiryAction: "confirm",
					},
				},
				context: { feature, service },
			});
			const lock = held.changes.find(
				(c) => c.table === "locks" && c.op === "insert",
			);
			if (lock?.op !== "insert") return false;
			this.serviceCommand({
				type: "finalize",
				at: spendAt,
				fields: {
					lock: lock.row,
					internalFeatureId: `feat_${feature}`,
					finalValue: null,
					properties: null,
				},
				context: { feature, service },
			});
			return true;
		},
		/** The cron books the expiry of every lot of `feature` that has lapsed by `at`, once. */
		lapse(feature: string, at: number) {
			const current = state();
			if (!current) return;
			const featureOf = (internal: string) => catalog.features[internal]?.id;
			for (const row of lapsedRows({
				state: current as never,
				featureOf,
				feature,
				atMs: at,
			})) {
				const key = `${row.id}:${row.expires_at}`;
				if (lapsed.has(key)) continue;
				lapsed.add(key);
				events.push(
					lapseEvent({
						row,
						holder,
						key: holder,
						feature,
						school,
						tz: menu.timeZone,
						revision: current.revision ?? revision,
					}),
				);
			}
		},
		/** Units of `feature` the engine counts as available at `asOf`. */
		avail(asOf: number, feature = "visit") {
			const current = state();
			if (!current) return 0;
			return (
				balancesOf({
					states: { [holder]: current as never },
					holds: {},
					catalog,
					asOfMs: asOf,
				}).find((b) => b.feature === feature)?.avail ?? 0
			);
		},
	};
};

export type Store = ReturnType<typeof createStore>;
