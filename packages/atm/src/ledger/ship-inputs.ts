/**
 * Shipping the stored inputs (`atm_event_inputs` and its helper tables) off the handler's disk, and reading them back from
 * the copy. The shape is `shipOutbox`'s: plan the rows as batches, put each create-only (`putOnce`), mark the rows. What
 * differs from events: an input can be erased, so a shipped object may have to be rewritten under a new key with the
 * holder's line turned into a tombstone, and a replay needs the lines in a total order (`applied_order`).
 * Layout, rules and the reasons: `docs/simulate-from-inputs.md`, "Shipping the inputs".
 *
 * Run order: `atm inputs ship` before `atm ship`, so that every event in the log has its input already shipped.
 */
import {
	contextHashOf,
	readInputsOfBatch,
	readUnshippedInputs,
	shippedSeedKey,
} from "../handler/inputs.js";
import { assertInputTables } from "../handler/schema.js";
import { FolderStore } from "../store/folder-store.js";
import {
	Conflict,
	identify,
	NotFound,
	putOnce,
	ShaMismatch,
	sha256Hex as sha256OfBytes,
	utf8,
} from "../store/store.js";
import type {
	AtmEnv,
	BillingRow,
	InputsBatch,
	InputsRead,
	InputsShipStatus,
	InputsSource,
	SettleInputErasuresResult,
	ShipConflict,
	ShipInputsInput,
	ShipInputsResult,
	SqlDatabase,
	Store,
	StoredContext,
	StoredInput,
	StoredSeed,
} from "../types.js";
import { canonicalize } from "./util.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[0-9A-Za-z_-]+$/;
const KEY_HASH_LENGTH = 16;
const ORDER_DIGITS = 12;
const UTC_DAY_LENGTH = 10;
const LIST_PAGE = 1000;
const BATCH_REST = /^date=\d{4}-\d{2}-\d{2}\/batch-\d{12}-[0-9a-f]{16}\.jsonl$/;
const CONTEXT_REST = /^contexts\/ctx-([0-9a-f]{64})\.json$/;
const SEED_REST = /^seeds\/seed-[0-9a-f]{16}\.json$/;
/** The school of a seed's subject key (`<school>|<env>|<holder>`): seeds have no school column. */
const SEED_SCHOOL = "substr(subject_key, 1, instr(subject_key, '|') - 1)";

// ---- Names ----

const prefixOf = ({ school, env }: { school: string; env: AtmEnv }): string => {
	if (school.length === 0 || school.includes("/"))
		throw new Error(`school ${JSON.stringify(school)} cannot be a key prefix`);
	return `schools/${school}/inputs/${env}/`;
};

/**
 * The names of the shipped objects, under the school's prefix and never inside `events/`. A prefix per env: a test and a live
 * endpoint can reuse a Stripe id and a replay of one must not read the other.
 */
export const inputObjectKey: {
	batch(args: {
		school: string;
		env: AtmEnv;
		date: string;
		firstOrder: number;
		sha256: string;
	}): string;
	context(args: { school: string; env: AtmEnv; contextHash: string }): string;
	seed(args: { school: string; env: AtmEnv; subjectKey: string }): string;
	prefix(args: { school: string; env: AtmEnv }): string;
} = {
	batch: ({ school, env, date, firstOrder, sha256 }) =>
		`${prefixOf({ school, env })}date=${date}/batch-${String(firstOrder).padStart(ORDER_DIGITS, "0")}-${sha256.slice(0, KEY_HASH_LENGTH)}.jsonl`,
	context: ({ school, env, contextHash }) =>
		`${prefixOf({ school, env })}contexts/ctx-${contextHash}.json`,
	seed: ({ school, env, subjectKey }) => {
		prefixOf({ school, env });
		return shippedSeedKey({ school, env, subjectKey });
	},
	prefix: prefixOf,
};

// ---- Lines ----

/** The columns of a shipped line, as JSON names them: the table's names, `body` as `fact`, no `batch_key`, no `shipped_at`. */
type InputLine = {
	applied_order: number;
	env: AtmEnv;
	event_id: string;
	school_id: string;
	subject_key: string | null;
	type: string;
	api_version: string;
	mapping: string;
	livemode: boolean | null;
	stripe_created: number;
	received_at: number;
	outcome: StoredInput["outcome"];
	reason: StoredInput["reason"];
	attempts: number;
	revision_before: number | null;
	revision_after: number | null;
	atm_version: string;
	context_hash: string | null;
	menu_version: string | null;
	policy_version: string | null;
	fee: number | null;
	payment_refs: string[] | null;
	input_id: string;
	booking_refs: Record<string, string> | null;
	raw_sha256: string | null;
	fact: StoredInput["fact"];
	erased_at: number | null;
};

/**
 * A row as it is shipped. An erased row is a tombstone whatever the object in hand still carries: the fact, the holder's
 * key, the refs, the fee and the raw body's hash are dropped here, so that no caller can ship them for an erased row.
 */
const lineOf = (row: StoredInput): InputLine => {
	const erased = row.erasedAt !== null;
	if (!erased && row.fact === null)
		throw new Error(
			`input ${row.eventId} is not erased but has no fact; it cannot be shipped`,
		);
	return {
		applied_order: row.appliedOrder,
		env: row.env,
		event_id: row.eventId,
		school_id: row.schoolId,
		subject_key: erased ? null : row.subjectKey,
		type: row.type,
		api_version: row.apiVersion,
		mapping: row.mapping,
		livemode: row.livemode,
		stripe_created: row.stripeCreated,
		received_at: row.receivedAt,
		outcome: row.outcome,
		reason: row.reason,
		attempts: row.attempts,
		revision_before: row.revisionBefore,
		revision_after: row.revisionAfter,
		atm_version: row.atmVersion,
		context_hash: row.contextHash,
		menu_version: row.menuVersion,
		policy_version: row.policyVersion,
		fee: erased ? null : row.fee,
		payment_refs: erased ? null : row.paymentRefs,
		input_id: row.inputId,
		booking_refs: erased ? null : row.bookingRefs,
		raw_sha256: erased ? null : row.rawSha256,
		fact: erased ? null : row.fact,
		erased_at: row.erasedAt,
	};
};

const utcDay = (ms: number): string =>
	new Date(ms).toISOString().slice(0, UTC_DAY_LENGTH);

/**
 * Plan: the rows as batches, one per commit day (the UTC date of `receivedAt`, never the event's date), each a pure function
 * of its rows: the lines are canonical JSON in `appliedOrder`, the key carries the first order and the first 16 hex digits
 * of the text's sha256, so the same rows give the same key and bytes on every try and on every shipper, and different
 * rows another key. A refused row is never shipped; an erased row becomes a tombstone. Throws, before anything is put, on a
 * row of another school or env, a refusal, an event id that is not plain characters, a repeated `appliedOrder`, a row that is
 * neither erased nor holds a fact, or a line that holds a newline.
 */
export const planInputs = ({
	school,
	env,
	rows,
}: {
	school: string;
	env: AtmEnv;
	rows: readonly StoredInput[];
}): InputsBatch[] => {
	const days = new Map<string, { order: number; text: string }[]>();
	for (const row of rows) {
		if (row.schoolId !== school || row.env !== env)
			throw new Error(
				`input ${row.eventId} belongs to ${row.schoolId}/${row.env}, not ${school}/${env}`,
			);
		if (row.outcome !== "applied")
			throw new Error(
				`input ${row.eventId} was refused (${row.reason}); a refusal is never shipped`,
			);
		if (!ID_PATTERN.test(row.eventId))
			throw new Error(
				`input event id ${row.eventId} is not letters, digits, _ or -`,
			);
		if (!Number.isSafeInteger(row.appliedOrder) || row.appliedOrder < 1)
			throw new Error(
				`input ${row.eventId} has applied order ${row.appliedOrder}, not a positive integer`,
			);
		const date = utcDay(row.receivedAt);
		if (!DATE_PATTERN.test(date))
			throw new Error(
				`input ${row.eventId} has received_at ${row.receivedAt}, which is not a date`,
			);
		const text = canonicalize(lineOf(row));
		if (text.includes("\n"))
			throw new Error(`input ${row.eventId} holds a newline in its line`);
		const day = days.get(date) ?? [];
		day.push({ order: row.appliedOrder, text });
		days.set(date, day);
	}
	return [...days.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([date, day]) => {
			const sorted = [...day].sort((a, b) => a.order - b.order);
			const first = sorted[0];
			if (!first) throw new Error("a day with no input");
			for (let i = 1; i < sorted.length; i += 1)
				if (sorted[i]?.order === sorted[i - 1]?.order)
					throw new Error(`applied order ${sorted[i]?.order} is used twice`);
			const text = `${sorted.map((line) => line.text).join("\n")}\n`;
			const sha256 = sha256OfBytes(utf8(text));
			return {
				key: inputObjectKey.batch({
					school,
					env,
					date,
					firstOrder: first.order,
					sha256,
				}),
				date,
				orders: sorted.map((line) => line.order),
				text,
				sha256,
			};
		});
};

// ---- Contexts and seeds ----

type ContextRow = {
	context_hash: string;
	menu_version: string;
	policy_version: string;
	first_used_at: number;
	body: string;
};

type SeedRow = {
	subject_key: string;
	revision: number;
	taken_at: number;
	first_event_id: string;
	rows: string;
};

/** A context is immutable and named by its hash. Its bytes: the table's columns with `body` spread (`menu`, `policy`, `price_ids`). */
const contextObject = (
	args: { school: string; env: AtmEnv },
	row: ContextRow,
): { key: string; text: string } => {
	const body = JSON.parse(row.body) as {
		menu: unknown;
		policy: unknown;
		priceIds: unknown;
	};
	return {
		key: inputObjectKey.context({ ...args, contextHash: row.context_hash }),
		text: `${canonicalize({
			context_hash: row.context_hash,
			env: args.env,
			school_id: args.school,
			menu_version: row.menu_version,
			policy_version: row.policy_version,
			first_used_at: row.first_used_at,
			menu: body.menu,
			policy: body.policy,
			price_ids: body.priceIds,
		})}\n`,
	};
};

/** A seed is written once and named by a hash of its holder, so the file name does not carry the family id. */
const seedObject = (
	args: { school: string; env: AtmEnv },
	row: SeedRow,
): { key: string; text: string } => ({
	key: inputObjectKey.seed({ ...args, subjectKey: row.subject_key }),
	text: `${canonicalize({
		env: args.env,
		subject_key: row.subject_key,
		revision: row.revision,
		taken_at: row.taken_at,
		first_event_id: row.first_event_id,
		rows: JSON.parse(row.rows),
	})}\n`,
});

// ---- Shipping ----

type Group = { key: string | null; rows: StoredInput[] };

/** The unshipped rows grouped by the batch they are assigned to (`null`: not assigned yet), each group in applied order. */
const unshippedGroups = (
	db: SqlDatabase,
	args: { env: AtmEnv; school: string },
): Group[] => {
	const groups = new Map<string | null, StoredInput[]>();
	for (const row of readUnshippedInputs(db, args)) {
		const group = groups.get(row.batchKey) ?? [];
		group.push(row);
		groups.set(row.batchKey, group);
	}
	return [...groups.entries()].map(([key, rows]) => ({ key, rows }));
};

/** The one batch a group plans to; throws when its rows span days, which no assignment makes. */
const planGroup = (
	args: { env: AtmEnv; school: string },
	rows: readonly StoredInput[],
): InputsBatch => {
	const [batch, ...rest] = planInputs({ ...args, rows });
	if (!batch || rest.length > 0)
		throw new Error(
			`inputs assigned to one batch span ${rest.length + 1} commit days`,
		);
	return batch;
};

const queueBatch = (
	db: SqlDatabase,
	args: { env: AtmEnv; school: string; key: string; nowMs: number },
): void => {
	db.run(
		`INSERT INTO atm_input_erasures (env, school_id, object_key, kind, queued_at, replacement_key, done_at) VALUES (?, ?, ?, 'batch', ?, NULL, NULL) ON CONFLICT (env, school_id, object_key) DO UPDATE SET queued_at = excluded.queued_at, replacement_key = NULL, done_at = NULL WHERE atm_input_erasures.done_at IS NOT NULL`,
		[args.env, args.school, args.key, args.nowMs],
	);
};

/** Deletes an object by its own sha256 (a wrong key is refused); a missing object is nothing to do. */
const deleteObject = async (store: Store, key: string): Promise<void> => {
	let sha256: string;
	try {
		sha256 = await identify(store, key);
	} catch (error) {
		if (error instanceof NotFound) return;
		throw error;
	}
	await store.delete(key, sha256);
};

const conflictOf = (
	key: string,
	message: string,
	extra: { date?: string; ids?: string[] } = {},
): ShipConflict => ({
	key,
	date: extra.date ?? "",
	ids: extra.ids ?? [],
	message,
});

/** Marks a batch's rows shipped, but only if its rows still plan to the same key (none was erased since the plan). */
const markBatch = (
	db: SqlDatabase,
	args: { env: AtmEnv; school: string; batch: InputsBatch; nowMs: number },
): number =>
	db.transaction(() => {
		const rows = readInputsOfBatch(db, { ...args, batchKey: args.batch.key });
		if (rows.length === 0 || planGroup(args, rows).key !== args.batch.key)
			return 0;
		return db.run(
			`UPDATE atm_event_inputs SET shipped_at = ? WHERE env = ? AND school_id = ? AND batch_key = ? AND shipped_at IS NULL`,
			[args.nowMs, args.env, args.school, args.batch.key],
		).changes;
	});

type OpenErasure = {
	object_key: string;
	kind: "batch" | "seed";
	replacement_key: string | null;
};

const openErasures = (
	db: SqlDatabase,
	args: { env: AtmEnv; school: string },
): OpenErasure[] =>
	db.all<OpenErasure>(
		`SELECT object_key, kind, replacement_key FROM atm_input_erasures WHERE env = ? AND school_id = ? AND done_at IS NULL ORDER BY queued_at, object_key`,
		[args.env, args.school],
	);

const closeErasure = (
	db: SqlDatabase,
	args: { env: AtmEnv; school: string; key: string; nowMs: number },
): void => {
	db.run(
		`UPDATE atm_input_erasures SET done_at = ? WHERE env = ? AND school_id = ? AND object_key = ?`,
		[args.nowMs, args.env, args.school, args.key],
	);
};

/**
 * The erasure step of a ship run, alone: for each queued object (`eraseStoredInputs` queues the shipped batches that held
 * an erased holder's facts, and its shipped seed). A seed object is deleted. A batch is rewritten, never overwritten: the
 * lines of the rows that point at it (tombstones for the erased ones, the others as they were) make a new text, so a new
 * key `batch-<same first order>-<new hash>`; it is put create-only (equal bytes already there is a crashed earlier try);
 * in one transaction the rows are pointed at the new key (only if no row changed since the plan, else the new object is
 * deleted again and the next run plans anew) and `replacement_key` is set; then the old object is deleted by its sha256 and
 * `done_at` is set. A crash at any point is repaired by the next run: only the old object, both, or only the new one.
 * While the old object exists its bytes still hold the facts: that window is one ship run (bucket versioning and
 * replication must be off for the `inputs/` prefix). A key that holds other bytes than the rewrite, or an old object whose
 * sha256 changed, is reported in `conflicts` and stays queued. A store error other than those propagates.
 */
export const settleInputErasures = async (
	input: ShipInputsInput,
): Promise<SettleInputErasuresResult> => {
	const { db, school, env, nowMs } = input;
	assertInputTables(db);
	const scope = { env, school };
	const conflicts: ShipConflict[] = [];
	let settled = 0;
	for (const queued of openErasures(db, scope)) {
		const oldKey = queued.object_key;
		try {
			const outcome =
				queued.kind === "batch" && queued.replacement_key === null
					? await rewriteBatch(input, oldKey)
					: "delete";
			if (outcome === "retry") continue;
			if (outcome === "delete") await deleteObject(input.store, oldKey);
			closeErasure(db, { ...scope, key: oldKey, nowMs: nowMs() });
			settled += 1;
		} catch (error) {
			if (error instanceof Conflict || error instanceof ShaMismatch) {
				conflicts.push(conflictOf(oldKey, error.message));
				continue;
			}
			throw error;
		}
	}
	return { settled, pending: openErasures(db, scope).length, conflicts };
};

/**
 * The rewrite of one queued batch: puts the new object and points the rows at it. "delete": the old object is still to be
 * deleted (also when nothing refers to it any more). "keep": the object already holds what the rows say, so it must not be
 * deleted. "retry": a row changed after the plan, the new object was taken away again and the next run plans anew.
 */
const rewriteBatch = async (
	{ db, store, school, env, nowMs }: ShipInputsInput,
	oldKey: string,
): Promise<"delete" | "keep" | "retry"> => {
	const scope = { env, school };
	const rows = readInputsOfBatch(db, { ...scope, batchKey: oldKey });
	if (rows.length === 0) return "delete";
	const rewrite = planGroup(scope, rows);
	if (rewrite.key === oldKey) return "keep";
	await putOnce(store, rewrite.key, utf8(rewrite.text));
	const repointed = db.transaction(() => {
		const fresh = readInputsOfBatch(db, { ...scope, batchKey: oldKey });
		if (fresh.length === 0 || planGroup(scope, fresh).key !== rewrite.key)
			return false;
		db.run(
			`UPDATE atm_event_inputs SET batch_key = ?, shipped_at = COALESCE(shipped_at, ?) WHERE env = ? AND school_id = ? AND batch_key = ?`,
			[rewrite.key, nowMs(), env, school, oldKey],
		);
		db.run(
			`UPDATE atm_input_erasures SET replacement_key = ? WHERE env = ? AND school_id = ? AND object_key = ?`,
			[rewrite.key, env, school, oldKey],
		);
		return true;
	});
	if (repointed) return "delete";
	// A row was erased after the plan: the object just put holds its fact. Take it away.
	await deleteObject(store, rewrite.key);
	return "retry";
};

/** Puts the unshipped contexts, then the unshipped seeds, each create-only, and marks them. */
const shipHelpers = async (
	input: ShipInputsInput,
): Promise<{
	contexts: number;
	seeds: number;
	conflicts: ShipConflict[];
	blockedContexts: Set<string>;
	blockedSubjects: Set<string>;
}> => {
	const { db, store, school, env, nowMs } = input;
	const scope = { env, school };
	const conflicts: ShipConflict[] = [];
	const blockedContexts = new Set<string>();
	const blockedSubjects = new Set<string>();
	let contexts = 0;
	let seeds = 0;
	for (const row of db.all<ContextRow>(
		`SELECT context_hash, menu_version, policy_version, first_used_at, body FROM atm_input_contexts WHERE env = ? AND school_id = ? AND shipped_at IS NULL ORDER BY first_used_at, context_hash`,
		[env, school],
	)) {
		const object = contextObject(scope, row);
		try {
			await putOnce(store, object.key, utf8(object.text));
		} catch (error) {
			if (!(error instanceof Conflict)) throw error;
			conflicts.push(
				conflictOf(object.key, error.message, { ids: [row.context_hash] }),
			);
			blockedContexts.add(row.context_hash);
			continue;
		}
		contexts += db.run(
			`UPDATE atm_input_contexts SET shipped_at = ? WHERE env = ? AND school_id = ? AND context_hash = ? AND shipped_at IS NULL`,
			[nowMs(), env, school, row.context_hash],
		).changes;
	}
	for (const row of db.all<SeedRow>(
		`SELECT subject_key, revision, taken_at, first_event_id, rows FROM atm_input_seeds WHERE env = ? AND ${SEED_SCHOOL} = ? AND shipped_at IS NULL ORDER BY subject_key`,
		[env, school],
	)) {
		const object = seedObject(scope, row);
		try {
			await putOnce(store, object.key, utf8(object.text));
		} catch (error) {
			if (!(error instanceof Conflict)) throw error;
			conflicts.push(conflictOf(object.key, error.message));
			blockedSubjects.add(row.subject_key);
			continue;
		}
		const marked = db.run(
			`UPDATE atm_input_seeds SET shipped_at = ? WHERE env = ? AND subject_key = ? AND shipped_at IS NULL`,
			[nowMs(), env, row.subject_key],
		).changes;
		seeds += marked;
		const [stillThere] = db.all<{ found: number }>(
			`SELECT 1 AS found FROM atm_input_seeds WHERE env = ? AND subject_key = ?`,
			[env, row.subject_key],
		);
		// The holder was erased between the read and the mark: nothing queued this object, so take it away now.
		if (!stillThere) await deleteObject(store, object.key);
	}
	return { contexts, seeds, conflicts, blockedContexts, blockedSubjects };
};

/**
 * Ship: settle the erasure queue first; put the unshipped contexts and seeds; then the unshipped inputs as batches, create-only
 * (`putOnce`: equal bytes already there is an earlier try that landed, different bytes is a `ShipConflict`, nothing written and
 * the rows left unshipped for an alert); then mark the batch's rows (`shipped_at`) in one transaction. Only committed rows are
 * read, so a row a rolled-back transaction wrote is never shipped; a refusal never is; an erased row ships as a tombstone.
 *
 * Before the put, the planned `batch_key` is written on the rows (`shipped_at` stays null): an erasure that comes between the
 * put and the mark then finds the batch by its key and queues it, and a rerun puts the same batch again (the rows keep their
 * key, so rows that arrived in between never change the bytes, and two shippers plan the same objects). A crash between put and
 * mark is repaired by running it again. Rows that no longer plan to their key (one was erased since) are left for the erasure
 * settle, which runs again at the end. A context or seed that conflicts holds its rows back. A store error other than a
 * conflict propagates; batches already marked stay marked. Run it before `shipOutbox`.
 */
export const shipInputs = async (
	input: ShipInputsInput,
): Promise<ShipInputsResult> => {
	const { db, store, school, env, nowMs } = input;
	assertInputTables(db);
	const scope = { env, school };
	// A group that no longer plans to its own key (a row erased after the key was written, or a changed line format) is
	// rewritten by the settle, which is what keeps its old object from holding what it should not.
	for (const group of unshippedGroups(db, scope))
		if (group.key !== null && planGroup(scope, group.rows).key !== group.key)
			queueBatch(db, { ...scope, key: group.key, nowMs: nowMs() });
	const conflicts: ShipConflict[] = [];
	const early = await settleInputErasures(input);
	const helpers = await shipHelpers(input);
	conflicts.push(...helpers.conflicts);

	const [fresh] = unshippedGroups(db, scope).filter(
		(group) => group.key === null,
	);
	if (fresh)
		db.transaction(() => {
			for (const batch of planInputs({ ...scope, rows: fresh.rows }))
				for (const order of batch.orders)
					db.run(
						`UPDATE atm_event_inputs SET batch_key = ? WHERE env = ? AND school_id = ? AND applied_order = ? AND batch_key IS NULL AND shipped_at IS NULL`,
						[batch.key, env, school, order],
					);
		});

	const batches: ShipInputsResult["batches"] = [];
	let shipped = 0;
	for (const group of unshippedGroups(db, scope)) {
		if (group.key === null) continue;
		const batch = planGroup(scope, group.rows);
		if (batch.key !== group.key) continue;
		const ids = group.rows.map((row) => row.eventId);
		const held = group.rows.some(
			(row) =>
				(row.contextHash !== null &&
					helpers.blockedContexts.has(row.contextHash)) ||
				(row.subjectKey !== null &&
					helpers.blockedSubjects.has(row.subjectKey)),
		);
		if (held) continue;
		let status: "created" | "existing";
		try {
			status = await putOnce(store, batch.key, utf8(batch.text));
		} catch (error) {
			if (!(error instanceof Conflict)) throw error;
			conflicts.push(
				conflictOf(batch.key, error.message, { date: batch.date, ids }),
			);
			continue;
		}
		const marked = markBatch(db, { ...scope, batch, nowMs: nowMs() });
		shipped += marked;
		batches.push({ key: batch.key, date: batch.date, inputs: marked, status });
	}

	const late = await settleInputErasures(input);
	// A conflict of the first settle that is still there for the second is one conflict.
	const seen = new Set<string>();
	for (const conflict of [...early.conflicts, ...late.conflicts]) {
		const identity = `${conflict.key}\n${conflict.message}`;
		if (seen.has(identity)) continue;
		seen.add(identity);
		conflicts.push(conflict);
	}
	return {
		batches,
		contexts: helpers.contexts,
		seeds: helpers.seeds,
		shipped,
		conflicts,
		erasures: {
			settled: early.settled + late.settled,
			pending: late.pending,
		},
	};
};

/**
 * What a health check reads: the applied inputs not yet shipped (and how old the oldest is, by when it was committed), and
 * the erasure queue still open (and how old its oldest row is). Alert when `erasuresPending` is above 0 past a ship
 * interval: until it is 0 an erased holder's facts may still be in a shipped object. Writes nothing.
 */
export const inputsShipStatus = ({
	db,
	school,
	env,
	nowMs,
}: {
	db: SqlDatabase;
	school: string;
	env: AtmEnv;
	nowMs: () => number;
}): InputsShipStatus => {
	assertInputTables(db);
	const [inputs] = db.all<{ n: number; oldest: number | null }>(
		`SELECT COUNT(*) AS n, MIN(received_at) AS oldest FROM atm_event_inputs WHERE env = ? AND school_id = ? AND outcome = 'applied' AND shipped_at IS NULL`,
		[env, school],
	);
	const [erasures] = db.all<{ n: number; oldest: number | null }>(
		`SELECT COUNT(*) AS n, MIN(queued_at) AS oldest FROM atm_input_erasures WHERE env = ? AND school_id = ? AND done_at IS NULL`,
		[env, school],
	);
	const now = nowMs();
	return {
		unshipped: inputs?.n ?? 0,
		oldestUnshippedAgeMs:
			inputs?.oldest == null ? null : Math.max(0, now - inputs.oldest),
		erasuresPending: erasures?.n ?? 0,
		oldestErasurePendingAgeMs:
			erasures?.oldest == null ? null : Math.max(0, now - erasures.oldest),
	};
};

// ---- Reading a shipped copy ----

const fail = (key: string, what: string): never => {
	throw new Error(`${key}: ${what}`);
};

const objectOf = (key: string, text: string): Record<string, unknown> => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return fail(key, "is not JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return fail(key, "is not a JSON object");
	return parsed as Record<string, unknown>;
};

const inputOfLine = (
	key: string,
	number: number,
	text: string,
	filter: { env: AtmEnv; school: string },
): StoredInput => {
	const where = `${key} line ${number}`;
	const line = objectOf(where, text) as Partial<InputLine>;
	if (!Number.isSafeInteger(line.applied_order))
		fail(where, "has no applied_order");
	if (typeof line.event_id !== "string") fail(where, "has no event_id");
	if (line.env !== filter.env || line.school_id !== filter.school)
		fail(
			where,
			`belongs to ${line.school_id}/${line.env}, not ${filter.school}/${filter.env}`,
		);
	if (line.outcome !== "applied" && line.outcome !== "refused")
		fail(where, "has no outcome");
	if (line.erased_at !== null && typeof line.erased_at !== "number")
		fail(where, "has no erased_at");
	if (line.erased_at === null && (line.fact ?? null) === null)
		fail(where, "is not erased and has no fact");
	return {
		appliedOrder: line.applied_order as number,
		env: filter.env,
		eventId: line.event_id as string,
		schoolId: filter.school,
		subjectKey: line.subject_key ?? null,
		type: line.type as string,
		apiVersion: line.api_version as string,
		mapping: line.mapping as string,
		livemode: line.livemode ?? null,
		stripeCreated: line.stripe_created as number,
		receivedAt: line.received_at as number,
		outcome: line.outcome as StoredInput["outcome"],
		reason: line.reason ?? null,
		attempts: line.attempts as number,
		revisionBefore: line.revision_before ?? null,
		revisionAfter: line.revision_after ?? null,
		atmVersion: line.atm_version as string,
		contextHash: line.context_hash ?? null,
		menuVersion: line.menu_version ?? null,
		policyVersion: line.policy_version ?? null,
		fee: line.fee ?? null,
		paymentRefs: line.payment_refs ?? null,
		inputId: line.input_id as string,
		bookingRefs: line.booking_refs ?? null,
		rawSha256: line.raw_sha256 ?? null,
		fact: line.fact ?? null,
		erasedAt: line.erased_at as number | null,
		batchKey: key,
		shippedAt: null,
	};
};

/**
 * Which of two lines for one event is read: an erased line beats an unerased one, an `applied` line beats a `refused` one,
 * else the lowest `appliedOrder`. Several lines for one event come from a crash between put and mark and from the window of an
 * erasure rewrite.
 */
const better = (candidate: StoredInput, kept: StoredInput): boolean => {
	const candidateErased = candidate.erasedAt !== null;
	const keptErased = kept.erasedAt !== null;
	if (candidateErased !== keptErased) return candidateErased;
	const candidateApplied = candidate.outcome === "applied";
	const keptApplied = kept.outcome === "applied";
	if (candidateApplied !== keptApplied) return candidateApplied;
	return candidate.appliedOrder < kept.appliedOrder;
};

const list = async (store: Store, prefix: string): Promise<string[]> => {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await store.list({
			prefix,
			maxKeys: LIST_PAGE,
			...(cursor === undefined ? {} : { cursor }),
		});
		for (const object of page.objects) keys.push(object.key);
		cursor = page.next ?? undefined;
	} while (cursor !== undefined);
	return keys.sort();
};

const textOf = async (store: Store, key: string): Promise<string> =>
	new TextDecoder().decode((await store.get(key)).body);

const contextOfObject = (
	key: string,
	text: string,
	filter: { env: AtmEnv; school: string },
	nameHash: string,
): StoredContext => {
	const object = objectOf(key, text) as {
		context_hash?: string;
		menu_version?: string;
		policy_version?: string;
		first_used_at?: number;
		menu?: StoredContext["menu"];
		policy?: StoredContext["policy"];
		price_ids?: StoredContext["priceIds"];
	};
	const context = {
		menu: object.menu as StoredContext["menu"],
		policy: object.policy as StoredContext["policy"],
		priceIds: object.price_ids as StoredContext["priceIds"],
	};
	if (object.context_hash !== nameHash || contextHashOf(context) !== nameHash)
		fail(key, "does not hold the context its name says");
	return {
		env: filter.env,
		schoolId: filter.school,
		contextHash: nameHash,
		menuVersion: object.menu_version as string,
		policyVersion: object.policy_version as string,
		firstUsedAt: object.first_used_at as number,
		...context,
	};
};

const seedOfObject = (
	key: string,
	text: string,
	filter: { env: AtmEnv; school: string },
): StoredSeed => {
	const object = objectOf(key, text) as {
		env?: AtmEnv;
		subject_key?: string;
		revision?: number;
		taken_at?: number;
		first_event_id?: string;
		rows?: BillingRow[];
	};
	if (object.env !== filter.env || typeof object.subject_key !== "string")
		fail(key, "is not a seed of this env");
	const subjectKey = object.subject_key as string;
	if (key !== inputObjectKey.seed({ ...filter, subjectKey }))
		fail(key, "does not hold the seed its name says");
	return {
		env: filter.env,
		subjectKey,
		revision: object.revision as number,
		takenAt: object.taken_at as number,
		firstEventId: object.first_event_id as string,
		rows: object.rows as BillingRow[],
	};
};

/**
 * Any `Store` behind the `InputsSource` interface: lists `schools/<school>/inputs/<env>/`, reads every batch, context and
 * seed object, and returns what `sqliteInputsSource` returns for the same history (`inputs` in applied order, the contexts
 * by hash, the seeds by holder), with `refused` empty, `batchKey` the object a line was read from and `shippedAt` null. Lines
 * for one event reduce by `better`. It reads, and writes nothing. A line of another school or env, a context that is not what
 * its name says, or a line without its order or fact throws, naming the object. Use `inputOrderGaps` for the orders missing.
 */
export const storeInputsSource = (
	store: Store,
	origin = "store",
): InputsSource => ({
	read: async (filter) => {
		const prefix = inputObjectKey.prefix(filter);
		const keys = await list(store, prefix);
		const kept = new Map<string, StoredInput>();
		const read: InputsRead = {
			inputs: [],
			refused: [],
			seeds: new Map(),
			contexts: new Map(),
			origin,
		};
		const contexts: StoredContext[] = [];
		for (const key of keys) {
			const rest = key.slice(prefix.length);
			if (BATCH_REST.test(rest)) {
				const lines = (await textOf(store, key)).split("\n");
				for (const [index, line] of lines.entries()) {
					if (line.length === 0) continue;
					const input = inputOfLine(key, index + 1, line, filter);
					const prior = kept.get(input.eventId);
					if (!prior || better(input, prior)) kept.set(input.eventId, input);
				}
				continue;
			}
			const context = CONTEXT_REST.exec(rest);
			if (context?.[1]) {
				contexts.push(
					contextOfObject(key, await textOf(store, key), filter, context[1]),
				);
				continue;
			}
			if (SEED_REST.test(rest)) {
				const seed = seedOfObject(key, await textOf(store, key), filter);
				read.seeds.set(seed.subjectKey, seed);
			}
		}
		for (const input of kept.values())
			(input.outcome === "applied" ? read.inputs : read.refused).push(input);
		read.inputs.sort((a, b) => a.appliedOrder - b.appliedOrder);
		read.refused.sort(
			(a, b) =>
				a.stripeCreated - b.stripeCreated || a.appliedOrder - b.appliedOrder,
		);
		contexts.sort(
			(a, b) =>
				a.firstUsedAt - b.firstUsedAt ||
				(a.contextHash < b.contextHash ? -1 : 1),
		);
		for (const context of contexts)
			read.contexts.set(context.contextHash, context);
		const seeds = [...read.seeds.values()].sort((a, b) =>
			a.subjectKey < b.subjectKey ? -1 : 1,
		);
		read.seeds = new Map(seeds.map((seed) => [seed.subjectKey, seed]));
		return read;
	},
});

/** A folder that is a store root (`FolderStore` over `root`) behind the `InputsSource` interface. */
export const folderInputsSource = (root: string): InputsSource =>
	storeInputsSource(new FolderStore({ root }), root);

/**
 * The `appliedOrder` values missing between the first and the last input read, as inclusive ranges. A refusal takes an order
 * too and is never shipped, so a gap in a shipped folder is not always a loss: orders of `read.refused` (from SQLite) are
 * counted as present. Order numbers are the handler's `AUTOINCREMENT` and start at 1.
 */
export const inputOrderGaps = (
	read: Pick<InputsRead, "inputs" | "refused">,
): { from: number; to: number }[] => {
	const orders = [...read.inputs, ...read.refused]
		.map((input) => input.appliedOrder)
		.sort((a, b) => a - b);
	const gaps: { from: number; to: number }[] = [];
	for (let i = 1; i < orders.length; i += 1) {
		const before = orders[i - 1] as number;
		const after = orders[i] as number;
		if (after - before > 1) gaps.push({ from: before + 1, to: after - 1 });
	}
	return gaps;
};
