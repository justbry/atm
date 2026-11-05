/**
 * Storage-agnostic rows for one billing subject (a family or a person): the engine's own tables a mutation
 * touches, one `{ table, id, data }` per row, plus a per-subject revision. The family service keeps these in
 * SQLite (`schema/storage/rows.v1.sql`) and never builds an engine subject itself:
 *
 *   rows -> subjectFromRows -> engine command -> mutation -> rowChangesFromMutation -> write upserts/deletes
 *
 * Pure: no I/O, no clock. The rows ARE the engine's SubjectState, split by table, so the engine (not the caller)
 * decides expiry, rollovers and locks. `rowChangesFromMutation` applies the engine's own `applyMutation` to the
 * current rows and diffs, so what is written equals what the engine would hold, by construction.
 */
import {
	applyMutation,
	type SubjectState,
	type SubjectStateMutation,
	subjectStateToFullSubject,
} from "@autumn/balance-engine";
import { toCatalog } from "../ledger/run.js";
import type {
	AtmCatalogRow,
	AtmIdentity,
	AtmMutation,
	AtmSubject,
	BillingRow,
	GrantsState,
	RowChanges,
	RowData,
	RowKey,
	RowTable,
	SubjectRows,
} from "../types.js";
import { EMPTY_GRANTS_STATE } from "./grants.js";

export type { BillingRow, RowChanges, RowData, RowKey, RowTable, SubjectRows };

/** The table and id of the one row that holds a subject's `GrantsState`. */
export const GRANTS_TABLE = "atm_grants" as const satisfies RowTable;
export const GRANTS_ROW_ID = "grants";

/** The engine's state tables, in the order rows are listed. `openLocks` holds the open locks' ids (the engine keeps no more in memory). */
export const ROW_TABLES = [
	"customer",
	"entity",
	"customerProducts",
	"customerPrices",
	"customerEntitlements",
	"rollovers",
	"replaceables",
	"usageWindows",
	"openLocks",
	"pooledBalances",
	"customerLicenses",
] as const satisfies readonly RowTable[];

/** Every table a subject's rows may use: the engine's, then the grants row. */
const LISTED_TABLES: readonly RowTable[] = [...ROW_TABLES, GRANTS_TABLE];
const isEngineTable = (table: RowTable) => table !== GRANTS_TABLE;
const engineRows = (rows: readonly BillingRow[]): BillingRow[] =>
	rows.filter((r) => isEngineTable(r.table));

/** Thrown when the stored revision is not the one a mutation was computed against: re-read, recompute, retry. */
export class StaleRevision extends Error {
	constructor(
		readonly expected: number,
		readonly actual: number,
		readonly subjectKey?: string,
	) {
		super(
			`stale subject${subjectKey ? ` ${subjectKey}` : ""}: expected revision ${expected}, store holds ${actual}`,
		);
		this.name = "StaleRevision";
	}
}

/** Stable string for a subject: `<orgId>|<env>|<customerId>` plus `|<entityId>` for an entity. Fields may not contain `|`. */
export const subjectKey = (identity: AtmIdentity): string => {
	for (const part of [
		identity.orgId,
		identity.env,
		identity.customerId,
		identity.entityId,
	]) {
		if (part?.includes("|"))
			throw new Error(`identity part ${JSON.stringify(part)} contains "|"`);
	}
	return [
		identity.orgId,
		identity.env,
		identity.customerId,
		...(identity.entityId === null ? [] : [identity.entityId]),
	].join("|");
};

/** Throws StaleRevision unless `actual === expected`. Call inside the write transaction, before applying changes. */
export const assertRevision = ({
	expected,
	actual,
	subjectKey: key,
}: {
	expected: number;
	actual: number;
	subjectKey?: string;
}): void => {
	if (expected !== actual) throw new StaleRevision(expected, actual, key);
};

const jsonSafe = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const singletonTables = new Set<RowTable>(["customer", "entity"]);

const rowId = (table: RowTable, data: RowData): string => {
	const id =
		table === "customer" || table === "entity"
			? (data.internal_id ?? data.id)
			: data.id;
	if (typeof id !== "string" || id === "")
		throw new Error(`${table} row has no string id`);
	return id;
};

const byKey = (a: RowKey, b: RowKey) =>
	a.table === b.table
		? a.id < b.id
			? -1
			: a.id > b.id
				? 1
				: 0
		: LISTED_TABLES.indexOf(a.table) - LISTED_TABLES.indexOf(b.table);

/** Rows in canonical order: table order, then id. */
export const sortRows = (rows: readonly BillingRow[]): BillingRow[] =>
	[...rows].sort(byKey);

/** A state split into rows (canonical order, JSON-safe). Everything the engine holds for the subject, nothing more. */
export const rowsFromState = (state: SubjectState): BillingRow[] => {
	const out: BillingRow[] = [];
	const add = (table: RowTable, data: unknown) =>
		out.push({
			table,
			id: rowId(table, data as RowData),
			data: jsonSafe(data as RowData),
		});
	add("customer", state.customer);
	if (state.entity) add("entity", state.entity);
	for (const table of ROW_TABLES) {
		if (singletonTables.has(table)) continue;
		for (const r of state[table as keyof SubjectState] as RowData[])
			add(table, r);
	}
	return sortRows(out);
};

/** The billing rules' state stored with the subject; no grants row is the empty state. */
export const grantsFromRows = (rows: readonly BillingRow[]): GrantsState => {
	const row = rows.find((r) => r.table === GRANTS_TABLE);
	if (!row) return jsonSafe(EMPTY_GRANTS_STATE);
	const state = { ...EMPTY_GRANTS_STATE, ...jsonSafe(row.data) } as GrantsState;
	if (state.v !== 1)
		throw new Error(`grants row has version ${String(state.v)}, expected 1`);
	// A membership stored before quantities existed was one unit.
	if (state.membership && state.membership.quantity === undefined)
		state.membership = { ...state.membership, quantity: 1 };
	return state;
};

/** The grants row for a state: store it with the engine's rows, under the same revision. */
export const grantsRow = (state: GrantsState): BillingRow => ({
	table: GRANTS_TABLE,
	id: GRANTS_ROW_ID,
	data: jsonSafe(state) as unknown as RowData,
});

/** Rows back to a state. No engine rows is no state (null): the subject has not been created. The grants row is not engine state. */
export const stateFromRows = ({
	identity,
	revision,
	rows: allRows,
}: SubjectRows): SubjectState | null => {
	const rows = engineRows(allRows);
	if (rows.length === 0) return null;
	const sorted = sortRows(rows);
	const of = (t: RowTable) =>
		sorted.filter((r) => r.table === t).map((r) => jsonSafe(r.data));
	const customer = of("customer")[0];
	if (!customer) throw new Error("rows hold no customer row");
	return {
		schemaVersion: 1,
		identity,
		revision,
		customer,
		customerProducts: of("customerProducts"),
		customerPrices: of("customerPrices"),
		customerEntitlements: of("customerEntitlements"),
		rollovers: of("rollovers"),
		replaceables: of("replaceables"),
		usageWindows: of("usageWindows"),
		openLocks: of("openLocks"),
		pooledBalances: of("pooledBalances"),
		customerLicenses: of("customerLicenses"),
		entity: of("entity")[0] ?? null,
	} as unknown as SubjectState;
};

/**
 * The engine's subject for a command: the rows joined with the catalog (`catalog` is the published catalog rows,
 * as `replayEvents` takes them). Throws when there are no rows (nothing to run a command against).
 */
export const subjectFromRows = ({
	identity,
	revision,
	rows,
	catalog,
}: SubjectRows & { catalog: readonly AtmCatalogRow[] }): AtmSubject => {
	const state = stateFromRows({ identity, revision, rows });
	if (!state) throw new Error("no rows: the subject has no plan yet");
	return subjectStateToFullSubject({
		state,
		catalog: toCatalog(catalog),
		entityId: identity.entityId,
	}) as unknown as AtmSubject;
};

const sameData = (a: RowData, b: RowData) =>
	JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

const sortKeys = (v: unknown): unknown =>
	Array.isArray(v)
		? v.map(sortKeys)
		: v && typeof v === "object"
			? Object.fromEntries(
					Object.entries(v as RowData)
						.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
						.map(([k, x]) => [k, sortKeys(x)]),
				)
			: v;

/** What differs between two row sets: rows new or changed (upserts) and rows gone (deletes). */
export const diffRows = (
	before: readonly BillingRow[],
	after: readonly BillingRow[],
): { upserts: BillingRow[]; deletes: RowKey[] } => {
	const k = (r: RowKey) => `${r.table}\u0000${r.id}`;
	const was = new Map(before.map((r) => [k(r), r]));
	const now = new Map(after.map((r) => [k(r), r]));
	const upserts = sortRows(
		after.filter((r) => {
			const b = was.get(k(r));
			return !b || !sameData(b.data, r.data);
		}),
	);
	const deletes = before
		.filter((r) => !now.has(k(r)))
		.map(({ table, id }) => ({ table, id }))
		.sort(byKey);
	return { upserts, deletes };
};

/**
 * The writes a mutation makes to the stored rows. `rows` and `revision` are what the store holds now; the mutation
 * must have been computed against that revision (else StaleRevision). Runs the engine's `applyMutation` and
 * diffs, so every change kind (insert, update, increment, delete, lock) is covered and the result equals the
 * engine's own next state. Apply in one transaction: check the revision, upsert, delete, set the revision.
 */
export const rowChangesFromMutation = ({
	mutation,
	rows,
	revision,
}: {
	mutation: AtmMutation | SubjectStateMutation;
	rows: readonly BillingRow[];
	revision: number;
}): RowChanges => {
	const m = mutation as SubjectStateMutation;
	const key = subjectKey(m.identity);
	assertRevision({
		expected: m.revision.before,
		actual: revision,
		subjectKey: key,
	});
	// The grants row is not the engine's: it is neither read into the state nor deleted for being absent from it.
	const state = stateFromRows({ identity: m.identity, revision, rows });
	const next = applyMutation({ state, mutation: m });
	const { upserts, deletes } = diffRows(engineRows(rows), rowsFromState(next));
	return {
		subjectKey: key,
		expectedRevision: m.revision.before,
		nextRevision: m.revision.after,
		upserts,
		deletes,
	};
};

/** Applies row changes to a row list in memory (tests, and stores that keep rows in an array). Refuses a stale revision. */
export const applyRowChanges = ({
	rows,
	revision,
	changes,
}: {
	rows: readonly BillingRow[];
	revision: number;
	changes: RowChanges;
}): { rows: BillingRow[]; revision: number } => {
	assertRevision({
		expected: changes.expectedRevision,
		actual: revision,
		subjectKey: changes.subjectKey,
	});
	const k = (r: RowKey) => `${r.table}\u0000${r.id}`;
	const map = new Map(rows.map((r) => [k(r), r]));
	for (const d of changes.deletes) map.delete(k(d));
	for (const u of changes.upserts) map.set(k(u), jsonSafe(u));
	return { rows: sortRows([...map.values()]), revision: changes.nextRevision };
};
