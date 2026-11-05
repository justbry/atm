/**
 * The family service in miniature, for tests: one subject's stored rows and revision, the event log, and one write per
 * Stripe event, exactly as the caller of `handleStripeEvent` does it.
 */
import { menuCatalogRows } from "../src/billing/grants.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	applyRowChanges,
	type BillingRow,
	rowChangesFromMutation,
	stateFromRows,
} from "../src/billing/rows.js";
import { menuLineItems } from "../src/billing/stripe-menu.js";
import type { Menu, StripeEventResult } from "../src/billing/types.js";
import { deterministicUlid } from "../src/ledger/ids.js";
import { mutationToEvents } from "../src/ledger/postings.js";
import { balancesOf } from "../src/ledger/replay.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import { canonicalize } from "../src/ledger/util.js";
import type { AtmEvent } from "../src/types.js";
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
	menuVersion = 1,
	policyVersion = 1,
	start,
}: {
	menu: Menu;
	school: string;
	family: string;
	menuVersion?: number;
	policyVersion?: number;
	/** The stored rows and revision to carry on from (a subject written earlier). */
	start?: { rows: BillingRow[]; revision: number };
}) => {
	const holder = `family:${family}`;
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
	let rows: BillingRow[] = start?.rows ?? [];
	let revision = start?.revision ?? 0;
	let spends = 0;
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
		handle(event: unknown, at: number) {
			const raw = event as {
				id: string;
				type: string;
				data: { object: { id: string } };
			};
			if (raw.type === "invoice.paid")
				invoiceIds[paymentIntentOf(raw.data.object.id)] = raw.data.object.id;
			const result = handleStripeEvent({
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
			});
			results.push(result);
			if (result.rowChanges)
				({ rows, revision } = applyRowChanges({
					rows,
					revision,
					changes: result.rowChanges,
				}));
			events.push(...result.events);
			return result;
		},
		/** The family service takes `n` visits out (a booking, short of the hold and finalize steps). */
		spend(n: number, at: number) {
			spends += 1;
			const command = {
				schemaVersion: 1,
				type: "updateBalance",
				org: { config: {} },
				commandId: `spend_${spends}`,
				requestId: `spend_${spends}`,
				identity,
				occurredAt: at,
				featureId: "visit",
				internalFeatureId: "feat_visit",
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
						feature: "visit",
						reason: "visit taken",
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
