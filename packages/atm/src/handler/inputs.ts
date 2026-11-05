/**
 * Stored inputs. The pure pieces, shared by whatever stores, ships or replays one: the id a decision event names as its
 * `cause`, the trimmed fact the grant rules decide on, and the hash of the context they decided under (they read no clock
 * and no database). Then the storage in the handler's SQLite (`atm_event_inputs` and its helper tables, see
 * `HANDLER_DDL`): `recordInput` writes one input in the caller's transaction, `inputsStatus` and `readInputs` read them,
 * `eraseStoredInputs` is the erasure hook. The decision and its design: `docs/simulate-from-inputs.md`.
 */
import packageJson from "../../package.json";
import { deterministicUlid } from "../ledger/ids.js";
import { canonicalize, sha256Hex } from "../ledger/util.js";
import type {
	AtmEnv,
	BillingFact,
	BillingRow,
	InputOutcome,
	InputsRead,
	InputsSource,
	InputsStatus,
	RecordInputArgs,
	ReplayFact,
	SqlDatabase,
	StoredContext,
	StoredFactBody,
	StoredInput,
	StoredSeed,
	WebhookContext,
} from "../types.js";
import { assertInputTables } from "./schema.js";

/** The package version a stored input records as `atm_version`: what `atm --version` prints. */
export const ATM_VERSION: string = packageJson.version;

/** The only metadata keys the grant rules read (who the holder is). Every other key is dropped from a stored fact. */
export const REPLAY_METADATA_KEYS = ["b4u_school", "family_id"] as const;

/** A checkout session's metadata also names the booking it pays for, which the booking rules read. */
const CHECKOUT_METADATA_KEYS = [...REPLAY_METADATA_KEYS, "booking_id"] as const;

/** Members of a fact that no rule reads: where it came from, and an invoice's number and bearer links. */
const DROPPED_MEMBERS: ReadonlySet<string> = new Set([
	"source",
	"number",
	"hostedInvoiceUrl",
	"invoicePdf",
]);

const MS_PER_SECOND = 1000;

/**
 * The ULID a decision event names as its `cause` (and the id of every command): the one place it is computed. The seed is
 * the school and Stripe's event id, with no env; the instant is Stripe's `created`, so no clock is read.
 */
export const inputCauseId = ({
	school,
	eventId,
	stripeCreated,
}: {
	school: string;
	eventId: string;
	/** Whole seconds, as Stripe's `created`. */
	stripeCreated: number;
}): string =>
	deterministicUlid({
		timeMs: stripeCreated * MS_PER_SECOND,
		revision: 0,
		seed: canonicalize([school, eventId]),
	});

const pick = (
	metadata: unknown,
	keys: readonly string[],
): Record<string, string> => {
	const kept: Record<string, string> = {};
	if (typeof metadata !== "object" || metadata === null) return kept;
	const from = metadata as Record<string, unknown>;
	for (const key of keys) {
		const value = from[key];
		if (typeof value === "string") kept[key] = value;
	}
	return kept;
};

/**
 * The fact the rules read, from a normalized fact: drops `source`, the invoice number and the bearer links, and cuts
 * `metadata` to `REPLAY_METADATA_KEYS` (a checkout session's also keeps `booking_id`). Every other member is kept, in
 * order, so `handleStripeFact` decides what `handleStripeEvent` did.
 */
export const replayFactOf = (fact: BillingFact): ReplayFact => {
	const isCheckout = "sessionId" in fact;
	const keys = isCheckout ? CHECKOUT_METADATA_KEYS : REPLAY_METADATA_KEYS;
	const kept: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(fact)) {
		if (DROPPED_MEMBERS.has(name)) continue;
		kept[name] = name === "metadata" ? pick(value, keys) : value;
	}
	return kept as ReplayFact;
};

/** `sha256(canonicalize({ menu, policy, priceIds }))` as hex: names the menu, policy and price ids a decision ran under. */
export const contextHashOf = (
	context: Pick<WebhookContext, "menu" | "policy" | "priceIds">,
): string =>
	sha256Hex(
		canonicalize({
			menu: context.menu,
			policy: context.policy,
			priceIds: context.priceIds,
		}),
	);

// ---- Storage ----

const BOOL_TRUE = 1;
const BOOL_FALSE = 0;
/** Hex digits of a hash kept in a shipped object's name. */
const SHIPPED_NAME_HEX = 16;

type InputRow = {
	applied_order: number;
	env: AtmEnv;
	event_id: string;
	school_id: string;
	subject_key: string | null;
	type: string;
	api_version: string;
	mapping: string;
	livemode: number | null;
	stripe_created: number;
	received_at: number;
	outcome: InputOutcome;
	reason: StoredInput["reason"];
	attempts: number;
	revision_before: number | null;
	revision_after: number | null;
	atm_version: string;
	context_hash: string | null;
	menu_version: string | null;
	policy_version: string | null;
	fee: number | null;
	payment_refs: string | null;
	input_id: string;
	booking_refs: string | null;
	raw_sha256: string | null;
	body: string | null;
	erased_at: number | null;
	batch_key: string | null;
	shipped_at: number | null;
};

/** The context as it is hashed and stored: price ids are always an object, so a context without them hashes as one with none. */
const storedContextOf = (
	context: WebhookContext,
): Pick<StoredContext, "menu" | "policy" | "priceIds"> => ({
	menu: context.menu,
	policy: context.policy,
	priceIds: { ...(context.priceIds ?? {}) },
});

/** Writes the context row when its content is new for the school and env; returns its hash. */
const recordContext = (
	db: SqlDatabase,
	args: RecordInputArgs,
	context: WebhookContext,
): string => {
	const stored = storedContextOf(context);
	const contextHash = contextHashOf(stored);
	const [known] = db.all<{ found: number }>(
		`SELECT 1 AS found FROM atm_input_contexts WHERE env = ? AND school_id = ? AND context_hash = ?`,
		[args.env, args.schoolId, contextHash],
	);
	if (!known)
		db.run(
			`INSERT INTO atm_input_contexts (env, school_id, context_hash, menu_version, policy_version, first_used_at, body, shipped_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (env, school_id, context_hash) DO NOTHING`,
			[
				args.env,
				args.schoolId,
				contextHash,
				String(context.menuVersion),
				String(context.policyVersion),
				args.nowMs,
				canonicalize(stored),
			],
		);
	return contextHash;
};

/**
 * Writes the holder's rows as its seed when this is the first stored applied input of a holder that already has state
 * (rows, or a revision above 0): a replay of the holder starts from them. A refused input takes no seed, because the rows
 * can still change before the input that is applied. Nothing is written for a holder with no state yet, or one that has a seed.
 */
const recordSeed = (db: SqlDatabase, args: RecordInputArgs): void => {
	const { subjectKey } = args;
	if (args.outcome !== "applied" || subjectKey === null) return;
	if (args.rowsBefore.length === 0 && (args.revisionBefore ?? 0) === 0) return;
	const [stored] = db.all<{ found: number }>(
		`SELECT 1 AS found FROM atm_input_seeds WHERE env = ? AND subject_key = ? UNION ALL SELECT 1 FROM atm_event_inputs WHERE env = ? AND school_id = ? AND subject_key = ? AND outcome = 'applied' LIMIT 1`,
		[args.env, subjectKey, args.env, args.schoolId, subjectKey],
	);
	if (stored) return;
	db.run(
		`INSERT INTO atm_input_seeds (env, subject_key, revision, taken_at, first_event_id, rows, shipped_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
		[
			args.env,
			subjectKey,
			args.revisionBefore ?? 0,
			args.nowMs,
			args.event.id,
			JSON.stringify(args.rowsBefore),
		],
	);
};

const livemodeColumn = (livemode: boolean | null): number | null =>
	livemode === null ? null : livemode ? BOOL_TRUE : BOOL_FALSE;

/** A fee is stored only when it is a whole number; anything else was refused as `bad_event` and is not worth a column. */
const feeColumn = (fee: number | null): number | null =>
	typeof fee === "number" && Number.isInteger(fee) ? fee : null;

/**
 * Writes one handled Stripe input: the trimmed fact (`replayFactOf` of the normalized one, never the raw event), the
 * SHA-256 of the raw body, the side inputs the fact does not hold (`fee`, `paymentRefs`, `bookingRefs`), the context it was
 * decided under (one row per distinct content) and, for a holder's first stored applied input, the holder's rows as its seed.
 *
 * It runs in the caller's transaction and opens none, so it commits or rolls back with the claim's done mark, the rows and
 * the outbox. It throws on a storage error: the transaction must roll back (the claim stays `claimed` and Stripe retries).
 * The reference handler calls it for what it applies and for a 422 refusal. The family service's own endpoint calls it for
 * what the handler never decides (a booking's `checkout.session.*` and the refund of a booking's charge), after its rows and
 * `appendToOutbox`, in the same write-serialized transaction.
 *
 * `(env, event_id)` is the key. An event already stored as `applied` is left as it was and the answer is `"existing"`. A
 * refusal is stored as `refused` with its reason; handled again and refused again it counts one more attempt and keeps its
 * `applied_order`; applied later it replaces the refused row and takes a new `applied_order`, its `attempts` one above the
 * refusals before it.
 */
export const recordInput = (
	db: SqlDatabase,
	args: RecordInputArgs,
): "stored" | "existing" => {
	assertInputTables(db);
	const [prior] = db.all<{
		outcome: InputOutcome;
		attempts: number;
		applied_order: number;
	}>(
		`SELECT outcome, attempts, applied_order FROM atm_event_inputs WHERE env = ? AND event_id = ?`,
		[args.env, args.event.id],
	);
	if (prior?.outcome === "applied") return "existing";
	const contextHash = args.context
		? recordContext(db, args, args.context)
		: null;
	recordSeed(db, args);
	if (prior)
		db.run(`DELETE FROM atm_event_inputs WHERE env = ? AND event_id = ?`, [
			args.env,
			args.event.id,
		]);
	const refs = args.paymentRefs ? JSON.stringify([...args.paymentRefs]) : null;
	const bookings =
		args.bookingRefs && Object.keys(args.bookingRefs).length > 0
			? canonicalize(args.bookingRefs)
			: null;
	const body: StoredFactBody = {
		v: 1,
		fact: replayFactOf(args.normalized.fact),
	};
	db.run(
		`INSERT INTO atm_event_inputs (applied_order, env, event_id, school_id, subject_key, type, api_version, mapping, livemode, stripe_created, received_at, outcome, reason, attempts, revision_before, revision_after, atm_version, context_hash, menu_version, policy_version, fee, payment_refs, input_id, booking_refs, raw_sha256, body, erased_at, batch_key, shipped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
		[
			// A refusal refused again keeps its place; one that is applied takes the next order (the key assigns it).
			args.outcome === "refused" ? (prior?.applied_order ?? null) : null,
			args.env,
			args.event.id,
			args.schoolId,
			args.subjectKey,
			args.event.type,
			args.normalized.apiVersion,
			args.normalized.mappingLabel,
			livemodeColumn(args.event.livemode),
			args.event.created,
			args.nowMs,
			args.outcome,
			args.reason,
			(prior?.attempts ?? 0) + 1,
			args.revisionBefore,
			args.revisionAfter,
			args.atmVersion ?? ATM_VERSION,
			contextHash,
			args.context ? String(args.context.menuVersion) : null,
			args.context ? String(args.context.policyVersion) : null,
			feeColumn(args.fee),
			refs,
			args.inputId,
			bookings,
			sha256Hex(args.rawBody),
			canonicalize(body),
		],
	);
	return "stored";
};

// ---- Reading ----

const tableExists = (db: SqlDatabase, table: string): boolean =>
	db.all<{ name: string }>(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
		[table],
	).length > 0;

const parseOrNull = <T>(text: string | null): T | null =>
	text === null ? null : (JSON.parse(text) as T);

const storedInputOf = (row: InputRow): StoredInput => {
	const body = parseOrNull<StoredFactBody>(row.body);
	return {
		appliedOrder: row.applied_order,
		env: row.env,
		eventId: row.event_id,
		schoolId: row.school_id,
		subjectKey: row.subject_key,
		type: row.type,
		apiVersion: row.api_version,
		mapping: row.mapping,
		livemode: row.livemode === null ? null : row.livemode === BOOL_TRUE,
		stripeCreated: row.stripe_created,
		receivedAt: row.received_at,
		outcome: row.outcome,
		reason: row.reason,
		attempts: row.attempts,
		revisionBefore: row.revision_before,
		revisionAfter: row.revision_after,
		atmVersion: row.atm_version,
		contextHash: row.context_hash,
		menuVersion: row.menu_version,
		policyVersion: row.policy_version,
		fee: row.fee,
		paymentRefs: parseOrNull<string[]>(row.payment_refs),
		inputId: row.input_id,
		bookingRefs: parseOrNull<Record<string, string>>(row.booking_refs),
		rawSha256: row.raw_sha256,
		fact: body?.fact ?? null,
		erasedAt: row.erased_at,
		batchKey: row.batch_key,
		shippedAt: row.shipped_at,
	};
};

type Filter = { env?: AtmEnv; school?: string };

/** `WHERE` text and parameters for a filter on the columns `env` and `school_id` (or the SQL given for the school). */
const whereOf = (filter: Filter | undefined, schoolColumn = "school_id") => {
	const clauses: string[] = [];
	const params: string[] = [];
	if (filter?.env !== undefined) {
		clauses.push("env = ?");
		params.push(filter.env);
	}
	if (filter?.school !== undefined) {
		clauses.push(`${schoolColumn} = ?`);
		params.push(filter.school);
	}
	return {
		where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
		params,
	};
};

/** The school of a subject key (`<school>|<env>|<customer>`), as SQL: seeds have no school column. */
const SEED_SCHOOL = "substr(subject_key, 1, instr(subject_key, '|') - 1)";

type Count = { n: number };

/**
 * What a database holds, for the filter given (both parts optional). Never throws on an older database: no table is
 * `available: false` with `reason: "no_table"`, and a table with nothing for the filter is `"empty"`. `applied` and
 * `refused` count the rows that are not erased; `erased` the tombstones (any outcome); `unshipped` the applied or erased
 * rows not yet shipped (a refused row is never shipped).
 */
export const inputsStatus = (
	db: SqlDatabase,
	filter?: Filter,
): InputsStatus => {
	if (!tableExists(db, "atm_event_inputs"))
		return { available: false, reason: "no_table" };
	const { where, params } = whereOf(filter);
	const [totals] = db.all<{
		applied: number | null;
		refused: number | null;
		erased: number | null;
		unshipped: number | null;
		total: number;
		first: number | null;
		last: number | null;
	}>(
		`SELECT COUNT(*) AS total, SUM(erased_at IS NULL AND outcome = 'applied') AS applied, SUM(erased_at IS NULL AND outcome = 'refused') AS refused, SUM(erased_at IS NOT NULL) AS erased, SUM(outcome = 'applied' AND shipped_at IS NULL) AS unshipped, MIN(received_at) AS first, MAX(received_at) AS last FROM atm_event_inputs ${where}`,
		params,
	);
	if (
		!totals ||
		totals.total === 0 ||
		totals.first === null ||
		totals.last === null
	)
		return { available: false, reason: "empty" };
	const column = (name: string) =>
		db
			.all<{ value: string }>(
				`SELECT DISTINCT ${name} AS value FROM atm_event_inputs ${where} ORDER BY value`,
				params,
			)
			.map((row) => row.value);
	const seedFilter = whereOf(filter, SEED_SCHOOL);
	const seeds = tableExists(db, "atm_input_seeds")
		? (db.all<Count>(
				`SELECT COUNT(*) AS n FROM atm_input_seeds ${seedFilter.where}`,
				seedFilter.params,
			)[0]?.n ?? 0)
		: 0;
	return {
		available: true,
		applied: totals.applied ?? 0,
		refused: totals.refused ?? 0,
		erased: totals.erased ?? 0,
		seeds,
		unshipped: totals.unshipped ?? 0,
		firstStoredAt: totals.first,
		lastStoredAt: totals.last,
		schools: column("school_id"),
		envs: column("env") as AtmEnv[],
		atmVersions: column("atm_version"),
	};
};

/**
 * Everything stored for one school and env, the shape a replay reads (`InputsRead`): applied and erased inputs in applied
 * order, refusals by Stripe's `created`, the seeds by holder and the contexts by hash. An older database with no tables
 * reads as empty. Synchronous; `sqliteInputsSource` is the same behind the `InputsSource` interface.
 */
export const readInputs = (
	db: SqlDatabase,
	filter: { env: AtmEnv; school: string },
	origin = "sqlite",
): InputsRead => {
	const read: InputsRead = {
		inputs: [],
		refused: [],
		seeds: new Map(),
		contexts: new Map(),
		origin,
	};
	if (!tableExists(db, "atm_event_inputs")) return read;
	const rows = db.all<InputRow>(
		`SELECT * FROM atm_event_inputs WHERE env = ? AND school_id = ? ORDER BY applied_order`,
		[filter.env, filter.school],
	);
	for (const row of rows) {
		const input = storedInputOf(row);
		(input.outcome === "applied" ? read.inputs : read.refused).push(input);
	}
	read.refused.sort(
		(a, b) =>
			a.stripeCreated - b.stripeCreated || a.appliedOrder - b.appliedOrder,
	);
	for (const seed of db.all<{
		subject_key: string;
		revision: number;
		taken_at: number;
		first_event_id: string;
		rows: string;
	}>(
		`SELECT subject_key, revision, taken_at, first_event_id, rows FROM atm_input_seeds WHERE env = ? AND ${SEED_SCHOOL} = ? ORDER BY subject_key`,
		[filter.env, filter.school],
	))
		read.seeds.set(seed.subject_key, {
			env: filter.env,
			subjectKey: seed.subject_key,
			revision: seed.revision,
			takenAt: seed.taken_at,
			firstEventId: seed.first_event_id,
			rows: JSON.parse(seed.rows) as BillingRow[],
		} satisfies StoredSeed);
	for (const context of db.all<{
		context_hash: string;
		menu_version: string;
		policy_version: string;
		first_used_at: number;
		body: string;
	}>(
		`SELECT context_hash, menu_version, policy_version, first_used_at, body FROM atm_input_contexts WHERE env = ? AND school_id = ? ORDER BY first_used_at, context_hash`,
		[filter.env, filter.school],
	)) {
		const stored = JSON.parse(context.body) as Pick<
			StoredContext,
			"menu" | "policy" | "priceIds"
		>;
		read.contexts.set(context.context_hash, {
			env: filter.env,
			schoolId: filter.school,
			contextHash: context.context_hash,
			menuVersion: context.menu_version,
			policyVersion: context.policy_version,
			firstUsedAt: context.first_used_at,
			...stored,
		});
	}
	return read;
};

/** The handler's SQLite behind the `InputsSource` interface the replay reads through. */
export const sqliteInputsSource = (
	db: SqlDatabase,
	origin = "sqlite",
): InputsSource => ({
	read: (filter) => Promise.resolve(readInputs(db, filter, origin)),
});

// ---- Erasure ----

/**
 * The name of a holder's shipped seed object: `schools/<school>/inputs/<env>/seeds/seed-<16 hex of the sha256 of the subject
 * key>.json`. The file name does not carry the family id. The shipper uses this name and an erasure queues it.
 */
export const shippedSeedKey = (args: {
	school: string;
	env: AtmEnv;
	subjectKey: string;
}): string =>
	`schools/${args.school}/inputs/${args.env}/seeds/seed-${sha256Hex(args.subjectKey).slice(0, SHIPPED_NAME_HEX)}.json`;

/**
 * The erasure hook: call it in the transaction that books `subject.erased` for a holder (atm books no `subject.erased` itself;
 * the operator's erasure does, and calls this beside it). Every stored input of the holder becomes a tombstone: `body`,
 * `subject_key`, `payment_refs`, `booking_refs`, `fee` and `raw_sha256` are cleared and `erased_at` is set; the row keeps
 * what names no person (`env`, `event_id`, `school_id`, `type`, `mapping`, `stripe_created`, `outcome`, `applied_order`,
 * `input_id`, `batch_key`, ...). The holder's seed is deleted. Every shipped batch that held one of its rows, and its shipped
 * seed object, is queued in `atm_input_erasures` for the shipper to rewrite or delete. Other holders' inputs, the contexts
 * and the ledger's money events are not touched. Idempotent: the second call finds nothing and returns zeros.
 */
export const eraseStoredInputs = (
	db: SqlDatabase,
	args: { env: AtmEnv; school: string; subjectKey: string; nowMs: number },
): { inputs: number; seeds: number; queued: number } => {
	assertInputTables(db);
	const { env, school, subjectKey, nowMs } = args;
	let queued = 0;
	const queue = (objectKey: string, kind: "batch" | "seed") => {
		queued += db.run(
			`INSERT INTO atm_input_erasures (env, school_id, object_key, kind, queued_at, replacement_key, done_at) VALUES (?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT (env, school_id, object_key) DO NOTHING`,
			[env, school, objectKey, kind, nowMs],
		).changes;
	};
	for (const { batch_key } of db.all<{ batch_key: string }>(
		`SELECT DISTINCT batch_key FROM atm_event_inputs WHERE env = ? AND school_id = ? AND subject_key = ? AND batch_key IS NOT NULL ORDER BY batch_key`,
		[env, school, subjectKey],
	))
		queue(batch_key, "batch");
	const [seed] = db.all<{ shipped_at: number | null }>(
		`SELECT shipped_at FROM atm_input_seeds WHERE env = ? AND subject_key = ?`,
		[env, subjectKey],
	);
	if (seed && seed.shipped_at !== null)
		queue(shippedSeedKey({ school, env, subjectKey }), "seed");
	const inputs = db.run(
		`UPDATE atm_event_inputs SET body = NULL, subject_key = NULL, payment_refs = NULL, booking_refs = NULL, fee = NULL, raw_sha256 = NULL, erased_at = ? WHERE env = ? AND school_id = ? AND subject_key = ?`,
		[nowMs, env, school, subjectKey],
	).changes;
	const seeds = db.run(
		`DELETE FROM atm_input_seeds WHERE env = ? AND subject_key = ?`,
		[env, subjectKey],
	).changes;
	return { inputs, seeds, queued };
};
