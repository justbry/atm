/**
 * Spike harness: atm's spend path (`track`, `check`, `finalize`) as a usage wallet, in the reference handler's SQLite
 * layout (`atm_subjects` + `atm_rows`, WAL, one revision per subject). Nothing here is shipped; it measures.
 *
 * One spend is: read the subject's rows, decode them to an engine subject, run the engine command, diff the mutation
 * against the rows (`rowChangesFromMutation`), write the changes under the revision check. `spend` times each phase.
 * `loadSubject` and `writeRows` copy the private ones in `src/handler/stripe-webhook.ts`.
 *
 * The file is also its own contention worker: `bun usage-track-harness.ts '<json>'` runs `workerMain`.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
	applyMutation,
	type Catalog,
	subjectStateToFullSubject,
} from "@autumn/balance-engine";
import { menuCatalogRows } from "../../src/billing/grants.js";
import { commandOrg, DEFAULT_POLICY } from "../../src/billing/policy.js";
import {
	type BillingRow,
	rowChangesFromMutation,
	StaleRevision,
	stateFromRows,
	subjectFromRows,
	subjectKey,
} from "../../src/billing/rows.js";
import type { Menu } from "../../src/billing/types.js";
import { bunSqlite } from "../../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../../src/handler/schema.js";
import type { SqlDatabase } from "../../src/handler/types.js";
import { runEngineCommand } from "../../src/index.js";
import { recordEngineCommand } from "../../src/ledger/outbox.js";
import { runOnState, toCatalog } from "../../src/ledger/run.js";
import type {
	AtmCatalogRow,
	AtmIdentity,
	AtmMutation,
	RowChanges,
} from "../../src/types.js";

export const SCHOOL = "usage-school";
export const FEATURE = "credit";
export const INTERNAL_FEATURE = "feat_credit";
const TEMPLATE = "TEMPLATE";
const T = Date.UTC(2026, 0, 5, 17, 0, 0);
const DAY = 86_400_000;
const MS_PER_SECOND = 1000;
const BUSY_TIMEOUT_MS = 5000;

// ---- Catalog and a holder's rows ----

const baseMenu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;

/** The fixture menu with one feature, `credit`, and one tier that grants a million a month. */
const usageMenu: Menu = {
	...baseMenu,
	features: [
		{
			id: FEATURE,
			name: "Credit",
			unit: { one: "credit", other: "credits" },
		},
	],
	tiers: [
		{
			id: "metered",
			name: "Metered",
			blurb: "A million credits a month",
			public: true,
			prices: [{ interval: "month", amount: 9900 }],
			grants: [
				{
					featureId: FEATURE,
					amount: 1_000_000,
					every: "month",
					rollover: { max: 200_000, months: 1 },
				},
			],
		},
	],
	addons: [],
} as unknown as Menu;

export const catalogRows: AtmCatalogRow[] = menuCatalogRows({
	menu: usageMenu,
	school: SCHOOL,
});
/** The built catalog, kept: `subjectFromRows` rebuilds it on every call, a caller would not. */
export const catalog: Catalog = toCatalog(catalogRows);
const org = commandOrg(DEFAULT_POLICY);

const tierEntitlement = (): { id: string; internal_product_id: string } => {
	const found = catalogRows.find(
		(r) =>
			r.table === "entitlements" &&
			(r.row as { internal_feature_id: string }).internal_feature_id ===
				INTERNAL_FEATURE &&
			(r.row as { internal_product_id: string | null }).internal_product_id !==
				null,
	);
	if (!found) throw new Error("no tier entitlement for the credit feature");
	return found.row as unknown as { id: string; internal_product_id: string };
};

export type HolderShape = {
	/** Credits on the tier row. */
	balance: number;
	/** A leftover rollover and a pack row beside the tier row, as a long-lived member has. */
	rich?: boolean;
	/** `usage_allowed` on the tier row: the row itself lets the balance go below zero. */
	usageAllowed?: boolean;
	/** Credits in the rollover (when `rich`). */
	rollover?: number;
	/** Credits in the pack row (when `rich`). */
	pack?: number;
};

const identityOf = (customerId: string): AtmIdentity => ({
	orgId: SCHOOL,
	env: "live",
	customerId,
	entityId: null,
});

let commandCount = 0;
const nextCommandId = (prefix: string): string => {
	commandCount += 1;
	return `${prefix}_${commandCount}`;
};

const baseCommand = (type: string, customerId: string, at: number) => {
	const commandId = nextCommandId(type);
	return {
		schemaVersion: 1,
		type,
		org,
		commandId,
		requestId: commandId,
		identity: identityOf(customerId),
		occurredAt: at,
	};
};

/** The rows of one holder, as the template holder's plan makes them (the engine decides, not this file). */
const templateRows = (shape: HolderShape): BillingRow[] => {
	const tier = tierEntitlement();
	const rowBase = (id: string, balance: number) => ({
		id,
		customer_product_id: "cp_1",
		entitlement_id: tier.id,
		internal_customer_id: `cus_${TEMPLATE}`,
		internal_entity_id: null,
		internal_feature_id: INTERNAL_FEATURE,
		balance,
		adjustment: 0,
		additional_balance: 0,
		unlimited: false,
		usage_allowed: shape.usageAllowed ?? false,
		next_reset_at: T + 30 * DAY,
		reset_cycle_anchor: null,
		expires_at: null,
		external_id: null,
		created_at: T,
	});
	const ops: Record<string, unknown>[] = [
		{
			op: "insert",
			table: "customer",
			row: {
				internal_id: `cus_${TEMPLATE}`,
				id: TEMPLATE,
				config: null,
				spend_limits: null,
				overage_allowed: null,
				usage_limits: null,
				usage_alerts: null,
				processor: null,
			},
		},
		{
			op: "insert",
			table: "customerProducts",
			row: {
				id: "cp_1",
				internal_customer_id: `cus_${TEMPLATE}`,
				internal_product_id: tier.internal_product_id,
				internal_entity_id: null,
				status: "active",
				options: [],
				quantity: 1,
				created_at: T,
				starts_at: T,
				access_starts_at: null,
				ended_at: null,
				customer_license_link_id: null,
			},
		},
		{
			op: "insert",
			table: "customerEntitlements",
			row: rowBase("ce_credit", shape.balance),
		},
	];
	if (shape.rich) {
		ops.push(
			{
				op: "insert",
				table: "customerEntitlements",
				row: {
					...rowBase("ce_pack", shape.pack ?? 0),
					next_reset_at: null,
					expires_at: T + 90 * DAY,
				},
			},
			{
				op: "insert",
				table: "rollovers",
				row: {
					id: "roll_1",
					cus_ent_id: "ce_credit",
					balance: shape.rollover ?? 0,
					usage: 0,
					expires_at: T + 20 * DAY,
					entities: {},
				},
			},
		);
	}
	const command = {
		...baseCommand("applyBillingPlan", TEMPLATE, T),
		entityIds: [],
		expiringPooledBalanceIds: [],
		ops,
	};
	const made = runOnState({ state: null, catalog, command });
	const state = made.state;
	if (!state) throw new Error("the template plan made no state");
	const rows: BillingRow[] = [];
	for (const [table, value] of Object.entries(state)) {
		if (table === "customer" || table === "entity") {
			if (value) rows.push(rowOf(table, value));
		} else if (Array.isArray(value))
			for (const data of value) rows.push(rowOf(table, data));
	}
	return rows;
};

const rowOf = (table: string, data: unknown): BillingRow => {
	const record = data as Record<string, unknown>;
	const id = (record.internal_id ?? record.id) as string;
	return { table, id, data: record } as unknown as BillingRow;
};

// ---- SQLite ----

export type Sync = "NORMAL" | "FULL";

/** A file (or `:memory:`) database in the reference layout. WAL, because the handler's writers must not block readers. */
export const openDatabase = (
	path: string,
	{ sync = "NORMAL" as Sync, setWal = true } = {},
): { raw: Database; db: SqlDatabase } => {
	const raw = new Database(path, { create: true });
	// first, so that the pragmas below wait for another process's WAL recovery instead of failing
	raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
	// WAL is stored in the file: the process that makes the file sets it, later openers (the workers) must not race a recovery.
	if (path !== ":memory:" && setWal) raw.exec("PRAGMA journal_mode = WAL");
	raw.exec(`PRAGMA synchronous = ${sync}`);
	const db = bunSqlite(raw);
	db.exec(HANDLER_DDL);
	return { raw, db };
};

export const holderId = (index: number): string => `u${index}`;
const keyOf = (index: number): string =>
	subjectKey(identityOf(holderId(index)));

/** Holders 0..count-1, each with the template's rows under its own subject key, written in one transaction. */
export const seedHolders = (
	db: SqlDatabase,
	count: number,
	shape: HolderShape,
): { rowsPerHolder: number } => {
	const rows = templateRows(shape);
	const texts = rows.map((row) => ({
		table: row.table,
		id: row.id,
		json: JSON.stringify(row.data),
	}));
	db.transaction(() => {
		for (let index = 0; index < count; index += 1) {
			const key = keyOf(index);
			db.run(`INSERT INTO atm_subjects (subject_key, revision) VALUES (?, 1)`, [
				key,
			]);
			const holder = holderId(index);
			for (const row of texts)
				db.run(
					`INSERT INTO atm_rows (subject_key, table_name, row_id, data) VALUES (?, ?, ?, ?)`,
					[
						key,
						row.table,
						row.id.replaceAll(TEMPLATE, holder),
						row.json.replaceAll(TEMPLATE, holder),
					],
				);
		}
	});
	return { rowsPerHolder: rows.length };
};

/** Copy of the handler's `loadSubject`. */
export const loadSubject = (
	db: SqlDatabase,
	key: string,
): { rows: BillingRow[]; revision: number } => {
	const [subject] = db.all<{ revision: number }>(
		`SELECT revision FROM atm_subjects WHERE subject_key = ?`,
		[key],
	);
	const stored = db.all<{ table_name: string; row_id: string; data: string }>(
		`SELECT table_name, row_id, data FROM atm_rows WHERE subject_key = ? ORDER BY table_name, row_id`,
		[key],
	);
	return {
		revision: subject?.revision ?? 0,
		rows: stored.map((row) => ({
			table: row.table_name,
			id: row.row_id,
			data: JSON.parse(row.data),
		})) as BillingRow[],
	};
};

/** Copy of the handler's `writeRows`: the revision check, then the upserts and deletes. */
export const writeRows = (db: SqlDatabase, changes: RowChanges): void => {
	const { subjectKey: key, expectedRevision, nextRevision } = changes;
	let moved = db.run(
		`UPDATE atm_subjects SET revision = ? WHERE subject_key = ? AND revision = ?`,
		[nextRevision, key, expectedRevision],
	).changes;
	if (moved === 0 && expectedRevision === 0)
		moved = db.run(
			`INSERT INTO atm_subjects (subject_key, revision) VALUES (?, ?) ON CONFLICT (subject_key) DO NOTHING`,
			[key, nextRevision],
		).changes;
	if (moved === 0) {
		const [current] = db.all<{ revision: number }>(
			`SELECT revision FROM atm_subjects WHERE subject_key = ?`,
			[key],
		);
		throw new StaleRevision(expectedRevision, current?.revision ?? 0, key);
	}
	for (const upsert of changes.upserts)
		db.run(
			`INSERT INTO atm_rows (subject_key, table_name, row_id, data) VALUES (?, ?, ?, ?) ON CONFLICT (subject_key, table_name, row_id) DO UPDATE SET data = excluded.data`,
			[key, upsert.table, upsert.id, JSON.stringify(upsert.data)],
		);
	for (const removed of changes.deletes)
		db.run(
			`DELETE FROM atm_rows WHERE subject_key = ? AND table_name = ? AND row_id = ?`,
			[key, removed.table, removed.id],
		);
};

// ---- Commands ----

export type OverageBehavior = "cap" | "reject" | "overflow";

export const trackCommand = ({
	holder,
	value,
	overageBehavior = "reject",
	lockId,
	commandId,
	at = T,
}: {
	holder: string;
	value: number;
	overageBehavior?: OverageBehavior;
	/** A hold: the track keeps its deduction open to a later `finalize`. */
	lockId?: string;
	commandId?: string;
	at?: number;
}) => {
	const base = baseCommand("track", holder, at);
	const id = commandId ?? base.commandId;
	return {
		...base,
		commandId: id,
		requestId: id,
		featureId: FEATURE,
		internalFeatureId: INTERNAL_FEATURE,
		value,
		overageBehavior,
		properties: null,
		usageEvent: null,
		...(lockId
			? {
					lock: {
						id: `lk_${lockId}`,
						lockId,
						expiresAt: at + 2 * DAY,
						expiryAction: "confirm",
					},
				}
			: {}),
	};
};

export const checkCommand = ({
	holder,
	required,
	at = T,
}: {
	holder: string;
	required: number;
	at?: number;
}) => ({
	...baseCommand("check", holder, at),
	featureId: FEATURE,
	internalFeatureId: INTERNAL_FEATURE,
	requiredBalance: required,
	properties: null,
});

/** The cycle refill: sets every due row back to its grant (an overdrawn row too, unless the org keeps free overage). */
export const resetCommand = ({
	holder,
	at,
	persistOverage = false,
}: {
	holder: string;
	at: number;
	persistOverage?: boolean;
}) => {
	const base = baseCommand("reset", holder, at);
	return {
		...base,
		org: {
			config: { ...base.org.config, persist_free_overage: persistOverage },
		},
	};
};

export const finalizeCommand = ({
	holder,
	lock,
	finalValue,
	at = T,
}: {
	holder: string;
	lock: unknown;
	finalValue: number | null;
	at?: number;
}) => ({
	...baseCommand("finalize", holder, at),
	lock,
	internalFeatureId: INTERNAL_FEATURE,
	finalValue,
	properties: null,
});

/** The lock row a held `track` inserted: the caller keeps it to finalize later. */
export const lockOf = (mutation: AtmMutation): unknown =>
	(
		mutation as unknown as {
			changes: { table: string; op: string; row?: unknown }[];
		}
	).changes.find((c) => c.table === "locks" && c.op === "insert")?.row;

// ---- One spend, timed by phase ----

export type Timing = {
	read: number;
	decode: number;
	engine: number;
	diff: number;
	write: number;
	total: number;
};

export const emptyTiming = (): Timing => ({
	read: 0,
	decode: 0,
	engine: 0,
	diff: 0,
	write: 0,
	total: 0,
});

export type SpendOptions = {
	/** `public`: `subjectFromRows` as exported (rebuilds the catalog per call). `cached`: the built catalog is reused. */
	decode?: "public" | "cached";
	/** Also book the command's ledger events into `ledger_outbox`, in the same transaction (a held `track` or a `finalize`). */
	outbox?: { service: string } | null;
	timing?: Timing;
	counts?: SpendCounts;
};

export type SpendCounts = {
	spends: number;
	rowsRead: number;
	rowsUpserted: number;
	rowsDeleted: number;
	outboxInserted: number;
};

export const emptyCounts = (): SpendCounts => ({
	spends: 0,
	rowsRead: 0,
	rowsUpserted: 0,
	rowsDeleted: 0,
	outboxInserted: 0,
});

export type SpendResult = {
	mutation: AtmMutation | null;
	decision: unknown;
	changes: RowChanges | null;
};

const now = (): number => performance.now();

const decodeSubject = (
	identity: AtmIdentity,
	snapshot: { rows: BillingRow[]; revision: number },
	mode: "public" | "cached",
) => {
	if (mode === "public")
		return subjectFromRows({
			identity,
			revision: snapshot.revision,
			rows: snapshot.rows,
			catalog: catalogRows,
		});
	const state = stateFromRows({
		identity,
		revision: snapshot.revision,
		rows: snapshot.rows,
	});
	if (!state) throw new Error("no rows");
	return subjectStateToFullSubject({
		state,
		catalog,
		entityId: identity.entityId,
	}) as unknown as ReturnType<typeof subjectFromRows>;
};

/** What the engine decided, and the row changes to write; nothing is written. `timing` gets decode, engine and diff. */
export const decide = ({
	command,
	snapshot,
	options = {},
}: {
	command: { type: string; identity: AtmIdentity };
	snapshot: { rows: BillingRow[]; revision: number };
	options?: SpendOptions;
}): SpendResult => {
	const timing = options.timing;
	const t0 = now();
	const subject = decodeSubject(
		command.identity,
		snapshot,
		options.decode ?? "cached",
	);
	const t1 = now();
	const decision = runEngineCommand({
		subject,
		command: command as never,
	}) as unknown;
	const t2 = now();
	const isMutation =
		decision !== null &&
		typeof decision === "object" &&
		(decision as { type?: string }).type === "mutation";
	const mutation = isMutation ? (decision as AtmMutation) : null;
	const rejected =
		(mutation?.result as { status?: string } | undefined)?.status ===
		"rejected";
	const changes =
		mutation && !rejected
			? rowChangesFromMutation({
					mutation,
					rows: snapshot.rows,
					revision: snapshot.revision,
				})
			: null;
	const t3 = now();
	if (timing) {
		timing.decode += t1 - t0;
		timing.engine += t2 - t1;
		timing.diff += t3 - t2;
	}
	return { mutation, decision, changes };
};

/** The handler's pattern: one IMMEDIATE transaction holds the read, the engine and the write, so the revision never moves under it. */
export const spend = ({
	db,
	command,
	options = {},
}: {
	db: SqlDatabase;
	command: { type: string; identity: AtmIdentity };
	options?: SpendOptions;
}): SpendResult => {
	const { timing, counts } = options;
	const start = now();
	const key = subjectKey(command.identity);
	const result = db.transaction(() => {
		const r0 = now();
		const snapshot = loadSubject(db, key);
		if (timing) timing.read += now() - r0;
		if (counts) counts.rowsRead += snapshot.rows.length;
		const decided = decide({ command, snapshot, options });
		const { changes, mutation } = decided;
		if (changes) {
			const w0 = now();
			writeRows(db, changes);
			if (options.outbox && mutation) {
				const recorded = recordEngineCommand({
					db,
					mutation,
					before: stateFromRows({
						identity: command.identity,
						revision: snapshot.revision,
						rows: snapshot.rows,
					}) as never,
					context: {
						tz: "UTC",
						feature: FEATURE,
						service: options.outbox.service,
						lowCreditThreshold: DEFAULT_POLICY.lowCreditThreshold,
					},
				});
				if (counts) counts.outboxInserted += recorded.inserted;
			}
			if (timing) timing.write += now() - w0;
			if (counts) {
				counts.rowsUpserted += changes.upserts.length;
				counts.rowsDeleted += changes.deletes.length;
			}
		}
		return decided;
	});
	if (timing) timing.total += now() - start;
	if (counts) counts.spends += 1;
	return result;
};

/** The optimistic pattern: read outside any transaction, decide, then write under the revision check; `StaleRevision` means read again. */
export const spendOptimistic = ({
	db,
	command,
	options = {},
	thinkMs = 0,
}: {
	db: SqlDatabase;
	command: { type: string; identity: AtmIdentity };
	options?: SpendOptions;
	/** Time between the read and the write (a network round trip to a remote store, the gateway's own work). */
	thinkMs?: number;
}): { result: SpendResult; attempts: number; busy: number } => {
	const key = subjectKey(command.identity);
	let attempts = 0;
	let busy = 0;
	for (;;) {
		attempts += 1;
		const snapshot = loadSubject(db, key);
		const decided = decide({ command, snapshot, options });
		if (thinkMs > 0) sleepSync(thinkMs);
		if (!decided.changes) return { result: decided, attempts, busy };
		try {
			const { changes } = decided;
			db.transaction(() => writeRows(db, changes));
			return { result: decided, attempts, busy };
		} catch (error) {
			if (error instanceof StaleRevision) continue;
			if ((error as { code?: string }).code === "SQLITE_BUSY") {
				busy += 1;
				continue;
			}
			throw error;
		}
	}
};

const sleepSync = (ms: number): void => {
	const view = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(view, 0, 0, ms);
};

/** Credits left on every row of the holder (tier row, pack, rollovers), and the revision. Negative is overage. */
export const balancesOf = (
	db: SqlDatabase,
	index: number,
): { revision: number; rows: Record<string, number>; total: number } => {
	const { rows, revision } = loadSubject(db, keyOf(index));
	const out: Record<string, number> = {};
	let total = 0;
	for (const row of rows) {
		if (row.table !== "customerEntitlements" && row.table !== "rollovers")
			continue;
		const balance = (row.data as { balance: number }).balance;
		out[row.id] = balance;
		total += balance;
	}
	return { revision, rows: out, total };
};

export { applyMutation, keyOf };

// ---- Statistics and workloads ----

export const percentile = (sorted: Float64Array, fraction: number): number =>
	sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
	0;

export const summarize = (
	samples: Float64Array,
): { p50: number; p99: number; max: number; mean: number } => {
	const sorted = Float64Array.from(samples).sort();
	let sum = 0;
	for (const value of sorted) sum += value;
	return {
		p50: percentile(sorted, 0.5),
		p99: percentile(sorted, 0.99),
		max: sorted[sorted.length - 1] ?? 0,
		mean: sum / Math.max(1, sorted.length),
	};
};

/** mulberry32: a seeded uniform in [0, 1). */
export const seededRandom = (seed: number): (() => number) => {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** Holder picker with a Zipf tail (weight 1/(rank+1)^exponent): a few hot holders, a long cold tail. */
export const zipfPicker = (
	count: number,
	exponent: number,
	random: () => number,
): (() => number) => {
	const cumulative = new Float64Array(count);
	let total = 0;
	for (let rank = 0; rank < count; rank += 1) {
		total += 1 / (rank + 1) ** exponent;
		cumulative[rank] = total;
	}
	return () => {
		const target = random() * total;
		let low = 0;
		let high = count - 1;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if ((cumulative[mid] as number) < target) low = mid + 1;
			else high = mid;
		}
		return low;
	};
};

export type Workload = {
	label: string;
	holders: number;
	tracks: number;
	value: number;
	pick: "single" | "round-robin" | "zipf";
	shape?: HolderShape;
	decode?: "public" | "cached";
	sync?: Sync;
	/** `memory` times the engine and codec only (`:memory:`); a path runs on that file. */
	path?: string;
	/** Hold and settle each call: two commands, two revisions, two ledger events. */
	holdAndSettle?: boolean;
};

export type WorkloadReport = {
	label: string;
	tracksPerSecond: number;
	totalMs: number;
	latencyMs: { p50: number; p99: number; max: number; mean: number };
	phaseMeanMs: Omit<Timing, "total"> & { total: number };
	rowsReadPerTrack: number;
	rowsUpsertedPerTrack: number;
	rowsDeletedPerTrack: number;
	outboxPerTrack: number;
	topTenShare?: number;
};

/** Runs a workload single-threaded and reports throughput, latency percentiles, phase means and row counts. */
export const runWorkload = (workload: Workload): WorkloadReport => {
	const { db } = openDatabase(workload.path ?? ":memory:", {
		sync: workload.sync,
	});
	const shape = workload.shape ?? { balance: 1e12 };
	seedHolders(db, workload.holders, shape);
	const random = seededRandom(7);
	const zipf =
		workload.pick === "zipf"
			? zipfPicker(workload.holders, 1.1, random)
			: () => 0;
	const timing = emptyTiming();
	const counts = emptyCounts();
	const options: SpendOptions = {
		decode: workload.decode ?? "cached",
		timing,
		counts,
		outbox: workload.holdAndSettle ? { service: "llm" } : null,
	};
	const latencies = new Float64Array(workload.tracks);
	let hot = 0;
	const begin = now();
	for (let call = 0; call < workload.tracks; call += 1) {
		const index =
			workload.pick === "single"
				? 0
				: workload.pick === "round-robin"
					? call % workload.holders
					: zipf();
		if (index < 10) hot += 1;
		const holder = holderId(index);
		const callStart = now();
		if (workload.holdAndSettle) {
			const lockId = `bk${call}`;
			const held = spend({
				db,
				command: trackCommand({
					holder,
					value: workload.value,
					lockId,
					commandId: `h${call}`,
				}),
				options,
			});
			if (!held.mutation) throw new Error("hold decided nothing");
			spend({
				db,
				command: finalizeCommand({
					holder,
					lock: lockOf(held.mutation),
					finalValue: workload.value,
				}),
				options,
			});
		} else {
			spend({
				db,
				command: trackCommand({ holder, value: workload.value }),
				options,
			});
		}
		latencies[call] = now() - callStart;
	}
	const totalMs = now() - begin;
	const n = workload.tracks;
	return {
		label: workload.label,
		tracksPerSecond: (n / totalMs) * MS_PER_SECOND,
		totalMs,
		latencyMs: summarize(latencies),
		phaseMeanMs: {
			read: timing.read / counts.spends,
			decode: timing.decode / counts.spends,
			engine: timing.engine / counts.spends,
			diff: timing.diff / counts.spends,
			write: timing.write / counts.spends,
			total: timing.total / counts.spends,
		},
		rowsReadPerTrack: counts.rowsRead / counts.spends,
		rowsUpsertedPerTrack: counts.rowsUpserted / counts.spends,
		rowsDeletedPerTrack: counts.rowsDeleted / counts.spends,
		outboxPerTrack: counts.outboxInserted / counts.spends,
		topTenShare: workload.pick === "zipf" ? hot / n : undefined,
	};
};

/** The engine alone: decode once, run `track` on the same subject `runs` times (no row diff, no database). */
export const runEngineOnly = ({
	runs,
	value,
	shape = { balance: 1e12 },
}: {
	runs: number;
	value: number;
	shape?: HolderShape;
}): {
	perRunMs: { p50: number; p99: number; mean: number };
	runsPerSecond: number;
} => {
	const { db } = openDatabase(":memory:");
	seedHolders(db, 1, shape);
	const snapshot = loadSubject(db, keyOf(0));
	const command = trackCommand({ holder: holderId(0), value });
	const subject = decodeSubject(command.identity, snapshot, "cached");
	const samples = new Float64Array(runs);
	const begin = now();
	for (let run = 0; run < runs; run += 1) {
		const t0 = now();
		runEngineCommand({ subject, command: command as never });
		samples[run] = now() - t0;
	}
	const totalMs = now() - begin;
	const stats = summarize(samples);
	return {
		perRunMs: { p50: stats.p50, p99: stats.p99, mean: stats.mean },
		runsPerSecond: (runs / totalMs) * MS_PER_SECOND,
	};
};

// ---- Contention: K processes against one SQLite file ----

export type WorkerArgs = {
	path: string;
	worker: number;
	/** `same`: every worker hits holder 0. `spread`: each worker round-robins over its own holders. */
	holders: "same" | "spread";
	spreadPerWorker: number;
	pattern: "immediate" | "optimistic";
	thinkMs: number;
	value: number;
	startAt: number;
	durationMs: number;
};

export type WorkerReport = {
	worker: number;
	committed: number;
	attempts: number;
	stale: number;
	busy: number;
	endedAt: number;
	latenciesMs: number[];
};

export const workerMain = (args: WorkerArgs): WorkerReport => {
	const { db } = openDatabase(args.path, { setWal: false });
	const latencies: number[] = [];
	let committed = 0;
	let attempts = 0;
	let stale = 0;
	let busy = 0;
	while (Date.now() < args.startAt) {
		// spin until the shared start, so the workers overlap
	}
	const stopAt = args.startAt + args.durationMs;
	let call = 0;
	while (Date.now() < stopAt) {
		const index =
			args.holders === "same"
				? 0
				: args.worker * args.spreadPerWorker + (call % args.spreadPerWorker);
		call += 1;
		const command = trackCommand({
			holder: holderId(index),
			value: args.value,
		});
		const callStart = now();
		if (args.pattern === "optimistic") {
			const done = spendOptimistic({
				db,
				command,
				thinkMs: args.thinkMs,
			});
			attempts += done.attempts;
			stale += done.attempts - 1 - done.busy;
			busy += done.busy;
			committed += 1;
		} else {
			attempts += 1;
			try {
				spend({ db, command });
				committed += 1;
			} catch (error) {
				if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
				busy += 1;
			}
		}
		latencies.push(now() - callStart);
	}
	return {
		worker: args.worker,
		committed,
		attempts,
		stale,
		busy,
		endedAt: Date.now(),
		latenciesMs: latencies,
	};
};

export type ContentionReport = {
	workers: number;
	holders: "same" | "spread";
	pattern: "immediate" | "optimistic";
	thinkMs: number;
	committed: number;
	attempts: number;
	stale: number;
	busy: number;
	tracksPerSecond: number;
	staleRate: number;
	retriesPerTrack: number;
	latencyMs: { p50: number; p99: number; max: number; mean: number };
	revisionOk: boolean;
	balanceOk: boolean;
};

/** Spawns `workers` bun processes on one database file and merges what they report. The holders are seeded first. */
export const runContention = async ({
	path,
	workers,
	holders,
	pattern,
	thinkMs = 0,
	value = 1,
	durationMs = 2000,
	startDelayMs = 1500,
}: {
	path: string;
	workers: number;
	holders: "same" | "spread";
	pattern: "immediate" | "optimistic";
	thinkMs?: number;
	value?: number;
	durationMs?: number;
	/** Time for the workers to start and open the file before the shared start. */
	startDelayMs?: number;
}): Promise<ContentionReport> => {
	const spreadPerWorker = 100;
	const startBalance = 1e12;
	const holderCount = holders === "same" ? 1 : workers * spreadPerWorker;
	const { db, raw } = openDatabase(path);
	seedHolders(db, holderCount, { balance: startBalance });
	raw.close();
	const startAt = Date.now() + startDelayMs;
	const processes = Array.from({ length: workers }, (_, worker) => {
		const args: WorkerArgs = {
			path,
			worker,
			holders,
			spreadPerWorker,
			pattern,
			thinkMs,
			value,
			startAt,
			durationMs,
		};
		return Bun.spawn(["bun", import.meta.path, JSON.stringify(args)], {
			stdout: "pipe",
			stderr: "inherit",
			env: { ...process.env, TZ: "UTC" },
		});
	});
	const reports: WorkerReport[] = [];
	for (const child of processes) {
		const text = await new Response(child.stdout).text();
		await child.exited;
		reports.push(JSON.parse(text) as WorkerReport);
	}
	const committed = reports.reduce((sum, r) => sum + r.committed, 0);
	const attempts = reports.reduce((sum, r) => sum + r.attempts, 0);
	const stale = reports.reduce((sum, r) => sum + r.stale, 0);
	const busy = reports.reduce((sum, r) => sum + r.busy, 0);
	const endedAt = Math.max(...reports.map((r) => r.endedAt));
	const latencies = Float64Array.from(reports.flatMap((r) => r.latenciesMs));
	const check = openDatabase(path, { setWal: false });
	let revisionSum = 0;
	let balanceSum = 0;
	for (let index = 0; index < holderCount; index += 1) {
		const state = balancesOf(check.db, index);
		revisionSum += state.revision - 1;
		balanceSum += startBalance - state.total;
	}
	check.raw.close();
	return {
		workers,
		holders,
		pattern,
		thinkMs,
		committed,
		attempts,
		stale,
		busy,
		tracksPerSecond: (committed / (endedAt - startAt)) * MS_PER_SECOND,
		staleRate: attempts === 0 ? 0 : stale / attempts,
		retriesPerTrack: committed === 0 ? 0 : (attempts - committed) / committed,
		latencyMs: summarize(latencies),
		revisionOk: revisionSum === committed,
		balanceOk: balanceSum === committed * value,
	};
};

if (import.meta.main) {
	const args = JSON.parse(process.argv[2] ?? "null") as WorkerArgs | null;
	if (!args)
		throw new Error("usage: bun usage-track-harness.ts '<WorkerArgs json>'");
	process.stdout.write(JSON.stringify(workerMain(args)));
}
