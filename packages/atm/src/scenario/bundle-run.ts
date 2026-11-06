/**
 * Replays a bundle through the whole pipeline in a temporary folder: each delivery goes to the reference handler (an
 * in-memory SQLite database, a signed request, the school's own endpoint), the outbox is shipped to a folder, the folder is
 * journaled, and the log is reconciled against the bundle's Stripe side and replayed through every KPI channel. What comes
 * back is every stage's raw material; `bundle-check.ts` turns it into the H1 to H8 checkpoints.
 *
 * Nothing here knows the right answer: the hand numbers are in `expected.json`, read by whoever compares. The runner needs
 * Bun (`bun:sqlite`) and is not part of the library bundle.
 */
import { Database } from "bun:sqlite";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { menuCatalogRows } from "../billing/grants.js";
import { handleStripeEvent, normalizeStripeEvent } from "../billing/handle.js";
import { DEFAULT_POLICY } from "../billing/policy.js";
import {
	type BillingRow,
	StaleRevision,
	stateFromRows,
	subjectKey,
} from "../billing/rows.js";
import { menuLineItems } from "../billing/stripe-menu.js";
import { bunSqlite } from "../handler/bun-sqlite.js";
import { inputCauseId, recordInput } from "../handler/inputs.js";
import { HANDLER_DDL } from "../handler/schema.js";
import { signStripePayload } from "../handler/stripe-signature.js";
import { handleStripeWebhook } from "../handler/stripe-webhook.js";
import { journalMonth, readEvents } from "../ledger/files.js";
import { appendToOutbox } from "../ledger/outbox.js";
import { lapsedRows, lapseEvent, ledgerEvent } from "../ledger/postings.js";
import { reconcile } from "../ledger/reconcile.js";
import { reconcileFolder } from "../ledger/reconcile-files.js";
import { toCatalog } from "../ledger/run.js";
import { planOutbox, shipOutbox } from "../ledger/ship.js";
import { FolderStore } from "../store/folder-store.js";
import type {
	AtmEnv,
	AtmEvent,
	BundleAnswer,
	BundleStep,
	FileTree,
	OutboxCheckpointRow,
	ReconcileResult,
	ReconcileStripe,
	RowChanges,
	ScenarioBundle,
	SqlDatabase,
	WebhookDeps,
} from "../types.js";
import { bundleSchools } from "./bundle.js";
import { type BaseValues, periodsFrom } from "./kpis.js";
import { type ChannelRun, runParity } from "./parity.js";
import { priceIdOf } from "./stripe-events.js";

const MS_PER_SECOND = 1000;
const DELIVERY_LAG_MS = 20_000;
const SIGNING_SECRET = "whsec_unit_test_secret";
/** The clock the shipper stamps rows with: fixed, and stripped from every checkpoint as volatile. */
const SHIPPED_AT = 1_700_000_000_000;
const WORKER = "worker-a";
const MENU_VERSION = 3;
const POLICY_VERSION = 1;

const STRIPE_LISTS = {
	invoices: "invoices.json",
	refunds: "refunds.json",
	disputes: "disputes.json",
	payouts: "payouts.json",
	balanceTransactions: "balance_transactions.json",
	paymentIntents: "payment_intents.json",
} as const;

const MUTATION_LOG = `
CREATE TABLE IF NOT EXISTS bundle_mutation_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_key TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL,
  before TEXT,
  after TEXT
);
CREATE TRIGGER IF NOT EXISTS bundle_rows_insert AFTER INSERT ON atm_rows BEGIN
  INSERT INTO bundle_mutation_log (subject_key, table_name, row_id, op, before, after)
  VALUES (new.subject_key, new.table_name, new.row_id, 'insert', NULL, new.data);
END;
CREATE TRIGGER IF NOT EXISTS bundle_rows_update AFTER UPDATE ON atm_rows BEGIN
  INSERT INTO bundle_mutation_log (subject_key, table_name, row_id, op, before, after)
  VALUES (new.subject_key, new.table_name, new.row_id, 'update', old.data, new.data);
END;
CREATE TRIGGER IF NOT EXISTS bundle_rows_delete AFTER DELETE ON atm_rows BEGIN
  INSERT INTO bundle_mutation_log (subject_key, table_name, row_id, op, before, after)
  VALUES (old.subject_key, old.table_name, old.row_id, 'delete', old.data, NULL);
END;
`;

/**
 * The family service's own booking tables: booking -> holder, and payment intent or charge -> booking. The reference
 * handler never decides a booking's events; the service's endpoint does, and keeps these beside the handler's tables.
 */
const BOOKING_TABLES = `
CREATE TABLE IF NOT EXISTS bk_bookings (booking_id TEXT PRIMARY KEY, subject_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bk_index (ref TEXT PRIMARY KEY, booking_id TEXT NOT NULL);
`;

export type SchoolRun = {
	school: string;
	/** The log as the reader sees it (idem-deduplicated, id order). */
	events: AtmEvent[];
	/** What each stage of the handler wrote, for H2: the stored inputs in applied order and every engine row write. */
	decisions: unknown[];
	mutations: unknown[];
	outbox: OutboxCheckpointRow[];
	/** The school's folder after shipping and journaling: events, journals, the build record. */
	tree: FileTree;
	periods: string[];
	channels: ChannelRun[];
	reconciled: Record<string, ReconcileResult>;
};

export type BundleRun = {
	answers: BundleAnswer[];
	/** The lines the handler warned with (`deps.warn`), in order. */
	warnings: string[];
	schools: SchoolRun[];
	/** The temporary log folder (`schools/<school>/…`) and the Stripe side written beside it, until `dispose`. */
	root: string;
	stripeDirectory: (school: string) => string;
	dispose: () => Promise<void>;
};

type Endpoint = {
	school: string;
	raw: Database;
	db: SqlDatabase;
	deps: WebhookDeps;
	clock: { now: number };
	fees: { failing: boolean };
};

const makeEndpoint = (bundle: ScenarioBundle, school: string): Endpoint => {
	const { scenario } = bundle;
	const { menu, priceIds, env: explicitEnv } = scenario;
	const env: AtmEnv = explicitEnv ?? "live";
	const raw = new Database(":memory:");
	const db = bunSqlite(raw);
	db.exec(HANDLER_DDL);
	db.exec(BOOKING_TABLES);
	raw.exec(MUTATION_LOG);
	const clock = { now: 0 };
	const fees = { failing: false };
	const feeTable = scenario.fees;
	const deps: WebhookDeps = {
		db,
		secret: SIGNING_SECRET,
		schoolId: school,
		nowMs: () => clock.now,
		workerId: WORKER,
		...(explicitEnv === undefined ? {} : { env }),
		context: () => ({
			menu,
			menuVersion: MENU_VERSION,
			policy: DEFAULT_POLICY,
			policyVersion: POLICY_VERSION,
			catalog: menuCatalogRows({ menu, school, env }),
			priceIds:
				priceIds ??
				Object.fromEntries(
					[...menuLineItems(school, menu).keys()].map((key) => [
						key,
						priceIdOf(key),
					]),
				),
		}),
		...(feeTable
			? {
					paymentFee: (event: unknown) => {
						if (fees.failing) throw new Error("the fee lookup failed");
						const invoiceId = (event as { data: { object: { id: string } } })
							.data.object.id;
						return feeTable[invoiceId];
					},
				}
			: {}),
	};
	return { school, raw, db, deps, clock, fees };
};

const outboxOf = (endpoint: Endpoint): OutboxCheckpointRow[] =>
	endpoint.raw
		.query(`SELECT id, idem, date, body FROM ledger_outbox ORDER BY id`)
		.all() as OutboxCheckpointRow[];

const parseOrNull = (text: string | null): unknown =>
	text === null ? null : (JSON.parse(text) as unknown);

const decisionsOf = (endpoint: Endpoint): unknown[] =>
	(
		endpoint.raw
			.query(
				`SELECT applied_order, env, event_id, school_id, subject_key, type, api_version, mapping, livemode, stripe_created, outcome, reason, attempts, revision_before, revision_after, context_hash, menu_version, policy_version, fee, payment_refs, input_id, booking_refs, body FROM atm_event_inputs ORDER BY applied_order`,
			)
			.all() as Record<string, unknown>[]
	).map((row) => ({
		...row,
		payment_refs: parseOrNull(row.payment_refs as string | null),
		booking_refs: parseOrNull(row.booking_refs as string | null),
		body: parseOrNull(row.body as string | null),
	}));

const mutationsOf = (endpoint: Endpoint): unknown[] =>
	(
		endpoint.raw
			.query(
				`SELECT seq, subject_key, table_name, row_id, op, before, after FROM bundle_mutation_log ORDER BY seq`,
			)
			.all() as Record<string, unknown>[]
	).map(({ seq, before, after, ...rest }) => ({
		...rest,
		order: seq,
		before: parseOrNull(before as string | null),
		after: parseOrNull(after as string | null),
	}));

type StripeObject = {
	id?: string;
	payment_intent?: string | null;
	metadata?: { booking_id?: string; b4u_school?: string; family_id?: string };
};

const textOrNull = (value: unknown): string | null =>
	typeof value === "string" && value !== "" ? value : null;

const loadSubject = (
	db: SqlDatabase,
	key: string,
): { rows: BillingRow[]; revision: number } => {
	const [subject] = db.all<{ revision: number }>(
		`SELECT revision FROM atm_subjects WHERE subject_key = ?`,
		[key],
	);
	const rows = db
		.all<{ table_name: string; row_id: string; data: string }>(
			`SELECT table_name, row_id, data FROM atm_rows WHERE subject_key = ? ORDER BY table_name, row_id`,
			[key],
		)
		.map((row) => ({
			table: row.table_name,
			id: row.row_id,
			data: JSON.parse(row.data),
		})) as BillingRow[];
	return { rows, revision: subject?.revision ?? 0 };
};

/** The revision-checked rows write of `schema/storage/rows.v1.sql`, as the family service does it. */
const writeRows = (db: SqlDatabase, changes: RowChanges): void => {
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
	if (moved === 0) throw new StaleRevision(expectedRevision, 0, key);
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

/** A refusal Stripe should deliver again: the cause may arrive on its own. */
const BOOKING_WAITS: ReadonlySet<string> = new Set([
	"unmatched_booking",
	"unmatched_invoice",
]);

/**
 * Whether the family service's booking endpoint, not the reference handler, decides this event: a Checkout Session, or a
 * refund of a charge no invoice paid that the service's index or the charge's own metadata names as a booking's.
 */
const isBookingEvent = (
	endpoint: Endpoint,
	event: { type: string; data: { object: StripeObject } },
	env: AtmEnv,
): boolean => {
	if (event.type.startsWith("checkout.session.")) return true;
	if (event.type !== "charge.refunded") return false;
	const object = event.data.object;
	const refs = [object.payment_intent, object.id].filter(
		(ref): ref is string => textOrNull(ref) !== null,
	);
	if (refs.length === 0) return false;
	const marks = refs.map(() => "?").join(", ");
	const invoiceBacked =
		endpoint.db.all(
			`SELECT 1 FROM atm_payment_index WHERE env = ? AND payment_ref IN (${marks})`,
			[env, ...refs],
		).length > 0;
	if (invoiceBacked) return false;
	const indexed =
		endpoint.db.all(`SELECT 1 FROM bk_index WHERE ref IN (${marks})`, refs)
			.length > 0;
	return indexed || textOrNull(object.metadata?.booking_id) !== null;
};

/**
 * The family service's booking endpoint, in miniature, as `tests/stored-inputs-booking.test.ts` has it: ONE transaction that
 * loads the holder's rows, decides with `handleStripeEvent` (with its booking index and the fee read from Stripe), writes the
 * rows, appends the decision events, writes its own booking tables and calls `recordInput`. The decisions are the library's;
 * nothing of a booking's rules is repeated here. The claim and the livemode check are the reference handler's, not applied.
 */
const deliverBooking = (
	endpoint: Endpoint,
	event: Record<string, unknown> & {
		id: string;
		type: string;
		created: number;
		livemode?: boolean;
		data: { object: StripeObject };
	},
	env: AtmEnv,
	fees: Record<string, number | null> | undefined,
): BundleAnswer => {
	const { db, deps } = endpoint;
	const school = endpoint.school;
	const context = deps.context(school);
	if (!context) throw new Error(`no menu context for ${school}`);
	const object = event.data.object;
	const inputId = inputCauseId({
		school,
		eventId: event.id,
		stripeCreated: event.created,
	});
	return db.transaction((): BundleAnswer => {
		const bookingRefs: Record<string, string> = {};
		for (const ref of [
			object.payment_intent,
			event.type === "charge.refunded" ? object.id : null,
		]) {
			if (typeof ref !== "string") continue;
			const [hit] = db.all<{ booking_id: string }>(
				`SELECT booking_id FROM bk_index WHERE ref = ?`,
				[ref],
			);
			if (hit) bookingRefs[ref] = hit.booking_id;
		}
		let holder: string | null = null;
		if (event.type.startsWith("checkout.session.")) {
			holder = subjectKey({
				orgId: object.metadata?.b4u_school ?? school,
				env,
				customerId: `family:${object.metadata?.family_id}`,
				entityId: null,
			});
		} else {
			const bookingId =
				Object.values(bookingRefs)[0] ?? object.metadata?.booking_id ?? null;
			const [known] = db.all<{ subject_key: string }>(
				`SELECT subject_key FROM bk_bookings WHERE booking_id = ?`,
				[bookingId],
			);
			holder = known?.subject_key ?? null;
		}
		if (holder === null) return [409, "unmatched_booking"];
		// the caller's fee lookup, by payment intent (a booking has no invoice)
		const intent = textOrNull(object.payment_intent);
		const readsFee = event.type.startsWith("checkout.session.") && intent;
		if (readsFee && endpoint.fees.failing)
			throw new Error("the fee lookup failed");
		const fee = readsFee ? fees?.[intent] : undefined;
		const { rows, revision } = loadSubject(db, holder);
		const result = handleStripeEvent({
			event,
			eventId: inputId,
			menu: context.menu,
			menuVersion: context.menuVersion,
			policy: context.policy,
			policyVersion: context.policyVersion,
			rows,
			revision,
			catalog: context.catalog,
			now: event.created * MS_PER_SECOND,
			priceIds: context.priceIds,
			bookingIds: bookingRefs,
			env,
			school,
			...(fee === undefined || fee === null ? {} : { fee }),
		});
		const normalized = normalizeStripeEvent(event, inputId);
		if (!normalized.ok)
			throw new Error(`the booking event ${event.id} does not normalize`);
		const common = {
			env,
			schoolId: school,
			event: {
				id: event.id,
				type: event.type,
				created: event.created,
				apiVersion: normalized.apiVersion,
				livemode: event.livemode ?? null,
			},
			rawBody: JSON.stringify(event),
			normalized,
			subjectKey: holder,
			revisionBefore: revision,
			rowsBefore: rows,
			context,
			fee: fee ?? null,
			paymentRefs: null,
			inputId,
			bookingRefs: Object.keys(bookingRefs).length > 0 ? bookingRefs : null,
			nowMs: endpoint.clock.now,
		} as const;
		if (result.refused) {
			const { reason } = result.refused;
			// a wait is answered 409 and stores nothing; any other refusal is a 422 and is stored
			if (BOOKING_WAITS.has(reason)) return [409, "refused", reason];
			recordInput(db, {
				...common,
				outcome: "refused",
				reason,
				revisionAfter: revision,
			});
			return [422, "refused", reason];
		}
		if (result.rowChanges) writeRows(db, result.rowChanges);
		appendToOutbox(db, result.events, env);
		if (result.booking?.action === "paid") {
			db.run(
				`INSERT INTO bk_bookings (booking_id, subject_key) VALUES (?, ?) ON CONFLICT (booking_id) DO NOTHING`,
				[result.booking.bookingId, holder],
			);
			if (result.booking.paymentIntentId)
				db.run(
					`INSERT INTO bk_index (ref, booking_id) VALUES (?, ?) ON CONFLICT (ref) DO NOTHING`,
					[result.booking.paymentIntentId, result.booking.bookingId],
				);
		}
		const stored = recordInput(db, {
			...common,
			outcome: "applied",
			reason: null,
			revisionAfter: result.rowChanges?.nextRevision ?? revision,
		});
		return stored === "existing" ? [200, "duplicate"] : [200, "applied"];
	});
};

const deliver = (
	endpoint: Endpoint,
	step: Extract<BundleStep, { atMs: number; event: Record<string, unknown> }>,
	env: AtmEnv,
	explicitEnv: boolean,
	fees: Record<string, number | null> | undefined,
): { answer: BundleAnswer; threw: boolean } => {
	endpoint.fees.failing = step.feeFails === true;
	endpoint.clock.now = step.atMs + DELIVERY_LAG_MS;
	const payload = JSON.stringify(
		explicitEnv && env === "test"
			? { ...step.event, livemode: false }
			: step.event,
	);
	try {
		const parsed = JSON.parse(payload) as Parameters<typeof isBookingEvent>[1] &
			Parameters<typeof deliverBooking>[1];
		if (isBookingEvent(endpoint, parsed, env))
			return {
				answer: deliverBooking(endpoint, parsed, env, fees),
				threw: false,
			};
		const { status, body } = handleStripeWebhook(endpoint.deps, {
			payload,
			signatureHeader: signStripePayload({
				payload,
				secret: SIGNING_SECRET,
				timestampSeconds: Math.floor(endpoint.clock.now / MS_PER_SECOND),
			}),
		});
		return {
			answer: body.reason
				? [status, body.outcome, body.reason]
				: [status, body.outcome],
			threw: false,
		};
	} catch {
		// the handler lets an error out: the caller answers 500 and Stripe retries
		return { answer: [500, "threw"], threw: true };
	} finally {
		endpoint.fees.failing = false;
	}
};

const eventsDirectory = (root: string, school: string, date: string): string =>
	join(root, "schools", school, "events", `date=${date}`);

/** Combines a day's batches into `day.jsonl` (lines in id order) and removes them, as the log's combiner does. */
const combineDay = async (
	root: string,
	school: string,
	date: string,
): Promise<void> => {
	const directory = eventsDirectory(root, school, date);
	const names = (await readdir(directory).catch(() => []))
		.filter((name) => name.endsWith(".jsonl") && name !== "day.jsonl")
		.sort();
	const lines: { id: string; line: string }[] = [];
	for (const name of names)
		for (const line of (await readFile(join(directory, name), "utf8"))
			.split("\n")
			.filter((l) => l.length > 0))
			lines.push({ id: (JSON.parse(line) as { id: string }).id, line });
	lines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	await writeFile(
		join(directory, "day.jsonl"),
		`${lines.map((l) => l.line).join("\n")}\n`,
	);
	for (const name of names) await rm(join(directory, name));
};

/** Ships the school's unshipped rows as `late-*` files (a day already combined takes only these). */
const shipLate = async (
	endpoint: Endpoint,
	root: string,
	school: string,
): Promise<void> => {
	const rows = endpoint.db.all<{
		id: string;
		idem: string;
		date: string;
		body: string;
	}>(
		`SELECT id, idem, date, body FROM ledger_outbox WHERE school_id = ? AND shipped_at IS NULL ORDER BY date, id`,
		[school],
	);
	for (const batch of planOutbox({ school, rows })) {
		const name = batch.key.slice(batch.key.lastIndexOf("/") + 1);
		const directory = eventsDirectory(root, school, batch.date);
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, name.replace(/^batch-/, "late-")),
			batch.text,
		);
		endpoint.db.run(
			`UPDATE ledger_outbox SET batch_key = ?, shipped_at = ? WHERE school_id = ? AND date = ? AND shipped_at IS NULL`,
			[batch.key, SHIPPED_AT, school, batch.date],
		);
	}
};

const readTree = async (
	directory: string,
	relative = "",
): Promise<Record<string, string>> => {
	const out: Record<string, string> = {};
	const entries = await readdir(join(directory, relative), {
		withFileTypes: true,
	}).catch(() => []);
	for (const entry of entries) {
		const path = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory())
			Object.assign(out, await readTree(directory, path));
		else out[path] = await readFile(join(directory, path), "utf8");
	}
	return out;
};

const writeStripeFolder = async (
	folder: string,
	stripe: ReconcileStripe,
): Promise<void> => {
	await mkdir(folder, { recursive: true });
	for (const [list, file] of Object.entries(STRIPE_LISTS)) {
		const records = stripe[list as keyof ReconcileStripe];
		// the payment intents are asked for only of a school whose log holds a booking's payment: a file for any other
		// would make `reconcile` count (and print) a list the school never supplied
		if (records === undefined && list === "paymentIntents") continue;
		await writeFile(join(folder, file), JSON.stringify(records ?? []));
	}
};

/** Months from the first event's to the last's, every one in between included. */
const periodsOf = (events: readonly AtmEvent[]): string[] => {
	if (events.length === 0) return [];
	const months = events.map((event) => event.date.slice(0, 7)).sort();
	const first = months[0] as string;
	const last = months.at(-1) as string;
	const [firstYear, firstMonth] = first.split("-").map(Number) as [
		number,
		number,
	];
	const [lastYear, lastMonth] = last.split("-").map(Number) as [number, number];
	return periodsFrom(
		first,
		(lastYear - firstYear) * 12 + (lastMonth - firstMonth) + 1,
	);
};

/** Stripe delivers again after any answer outside 2xx. */
const RETRY_FROM_STATUS = 400;
const RETRY_AFTER_MS = 3_600_000;
const MAX_REDELIVERY_PASSES = 20;

export type RunBundleOptions = {
	/**
	 * Deliver the way Stripe does when it is not in order: a delivery the handler answers with an error status (409 wait, 422 refusal) is
	 * delivered again after the rest, an hour later each pass, until every one is applied or a pass changes nothing. The
	 * `answers` then hold every attempt, in the order made. Default false: each step once, as the bundle wrote it.
	 */
	redeliver?: boolean;
	/** Which KPI channels to run (default all; a missing hledger or duckdb is skipped, not failed). */
	channels?: readonly ("atm" | "hledger" | "duckdb")[];
};

/** Runs the bundle end to end in a temporary folder. Call `dispose()` when the run's files are no longer needed. */
export const runBundle = async (
	bundle: ScenarioBundle,
	options: RunBundleOptions = {},
): Promise<BundleRun> => {
	const { scenario } = bundle;
	const schools = bundleSchools(scenario);
	const env: AtmEnv = scenario.env ?? "live";
	const explicitEnv = scenario.env !== undefined;
	const endpoints = new Map(
		[...new Set([scenario.school, ...schools])].map((school) => [
			school,
			makeEndpoint(bundle, school),
		]),
	);
	const endpointOf = (school: string | undefined): Endpoint => {
		const found = endpoints.get(school ?? scenario.school);
		if (!found) throw new Error(`the bundle has no endpoint for ${school}`);
		return found;
	};
	const answers: BundleAnswer[] = [];
	const warnings: string[] = [];
	for (const endpoint of endpoints.values())
		endpoint.deps.warn = (line) => warnings.push(line);

	const root = await mkdtemp(join(tmpdir(), "atm-bundle-"));
	const dispose = () => rm(root, { recursive: true, force: true });
	try {
		const store = new FolderStore({ root });
		const lapsed = new Set<string>();
		const deferred: {
			endpoint: Endpoint;
			step: Extract<BundleStep, { event: Record<string, unknown> }>;
		}[] = [];
		const ship = async (endpoint: Endpoint, late: boolean) => {
			if (late) return shipLate(endpoint, root, endpoint.school);
			const shipped = await shipOutbox({
				db: endpoint.db,
				store,
				school: endpoint.school,
				nowMs: () => SHIPPED_AT,
			});
			if (shipped.conflicts.length > 0)
				throw new Error(`ship conflicts: ${JSON.stringify(shipped.conflicts)}`);
		};

		for (const step of bundle.steps) {
			const endpoint = endpointOf(step.school);
			if (step.kind === "erase") {
				const own = (
					endpoint.raw
						.query(`SELECT body FROM ledger_outbox ORDER BY id`)
						.all() as { body: string }[]
				)
					.map((row) => JSON.parse(row.body) as AtmEvent)
					.filter(
						(event) =>
							event.key === `family:${step.family}` &&
							event.event_type.startsWith("payment."),
					);
				appendToOutbox(
					endpoint.db,
					[
						ledgerEvent({
							type: "subject.erased",
							school: endpoint.school,
							tz: scenario.menu.timeZone,
							eventTime: step.atMs,
							key: `family:${step.family}`,
							idem: `erase:${step.family}`,
							payload: { objects: own.map((event) => `event:${event.id}`) },
						}),
					],
					env,
				);
			} else if (step.kind === "ship") {
				await ship(endpoint, step.late === true);
			} else if (step.kind === "journal") {
				await journalMonth({
					root,
					school: endpoint.school,
					month: step.month,
				});
			} else if (step.kind === "combine") {
				await combineDay(root, endpoint.school, step.date);
			} else if (step.kind === "lapse") {
				const holder = `family:${step.family}`;
				const subjectKey = `${endpoint.school}|${env}|${holder}`;
				const rows = endpoint.db
					.all<{ table_name: string; row_id: string; data: string }>(
						`SELECT table_name, row_id, data FROM atm_rows WHERE subject_key = ?`,
						[subjectKey],
					)
					.map((row) => ({
						table: row.table_name,
						id: row.row_id,
						data: JSON.parse(row.data),
					}));
				const revision =
					endpoint.db.all<{ revision: number }>(
						`SELECT revision FROM atm_subjects WHERE subject_key = ?`,
						[subjectKey],
					)[0]?.revision ?? 0;
				const state = stateFromRows({
					identity: {
						orgId: endpoint.school,
						env,
						customerId: holder,
						entityId: null,
					},
					revision,
					rows: rows as never,
				});
				if (!state) continue;
				const catalog = toCatalog(
					menuCatalogRows({
						menu: scenario.menu,
						school: endpoint.school,
						env,
					}),
				);
				for (const row of lapsedRows({
					state: state as never,
					featureOf: (internal) => catalog.features[internal]?.id,
					feature: step.feature,
					atMs: step.atMs,
				})) {
					const key = `${endpoint.school}:${row.id}:${row.expires_at}`;
					if (lapsed.has(key)) continue;
					lapsed.add(key);
					appendToOutbox(
						endpoint.db,
						[
							lapseEvent({
								row,
								holder,
								key: holder,
								feature: step.feature,
								school: endpoint.school,
								tz: scenario.menu.timeZone,
								revision,
							}),
						],
						env,
					);
				}
			} else {
				const { answer } = deliver(
					endpoint,
					step,
					env,
					explicitEnv,
					scenario.fees,
				);
				answers.push(answer);
				if (options.redeliver && answer[0] >= RETRY_FROM_STATUS)
					deferred.push({ endpoint, step });
			}
		}
		for (
			let pass = 1;
			deferred.length > 0 && pass <= MAX_REDELIVERY_PASSES;
			pass++
		) {
			const before = deferred.length;
			const waiting = deferred.splice(0, deferred.length);
			for (const { endpoint, step } of waiting) {
				const retry = { ...step, atMs: step.atMs + pass * RETRY_AFTER_MS };
				const { answer } = deliver(
					endpoint,
					retry,
					env,
					explicitEnv,
					scenario.fees,
				);
				answers.push(answer);
				if (answer[0] >= RETRY_FROM_STATUS) deferred.push({ endpoint, step });
			}
			if (deferred.length === before && pass > 1) break;
		}
		for (const endpoint of endpoints.values()) await ship(endpoint, false);

		const results: SchoolRun[] = [];
		for (const school of schools) {
			const endpoint = endpointOf(school);
			const hasLog =
				(await readdir(join(root, "schools", school)).catch(() => [])).length >
				0;
			const { events } = hasLog
				? await readEvents(root, school)
				: { events: [] as AtmEvent[] };
			const months = [
				...new Set(events.map((event) => event.date.slice(0, 7))),
			].sort();
			for (const month of months) await journalMonth({ root, school, month });
			const stripe = bundle.stripeSide[school] ?? {};
			const folder = join(root, `stripe-${school}`);
			await writeStripeFolder(folder, stripe);
			const book = bundle.expected.books.find((b) => b.school === school);
			const reconciled: Record<string, ReconcileResult> = {};
			for (const month of Object.keys(book?.reconcile ?? {}).sort())
				reconciled[month] =
					events.length === 0
						? reconcile({
								events,
								stripe,
								period: { month },
								timeZone: scenario.menu.timeZone,
							})
						: await reconcileFolder({
								root,
								school,
								period: { month },
								stripeDirectory: folder,
							});
			const periods = periodsOf(events);
			const parity =
				events.length === 0
					? { runs: [] as ChannelRun[] }
					: await runParity({
							events,
							periods,
							...(options.channels ? { channels: options.channels } : {}),
						});
			results.push({
				school,
				events,
				decisions: decisionsOf(endpoint),
				mutations: mutationsOf(endpoint),
				outbox: outboxOf(endpoint),
				tree: hasLog ? await readTree(join(root, "schools", school)) : {},
				periods,
				channels: parity.runs,
				reconciled,
			});
		}
		return {
			answers,
			warnings,
			schools: results,
			root,
			stripeDirectory: (school) => join(root, `stripe-${school}`),
			dispose,
		};
	} catch (error) {
		await dispose();
		throw error;
	}
};

export type { BaseValues };
