import type { HandlerMigrationResult, SqlDatabase } from "../types.js";

/**
 * The columns of the four tables that carry the Stripe mode. Stripe's ids differ between test and live mode, but nothing
 * in Stripe forbids a caller from using one id under both, so each of these tables is keyed by `(env, id)`:
 * `env` is the handler's `WebhookDeps.env` (`"live"` when it names none). The default keeps a plain insert, written
 * before `env` existed, a live row.
 */
const ENV_COLUMN = `env TEXT NOT NULL DEFAULT 'live' CHECK (env IN ('live', 'test'))`;

const CLAIMS_TABLE = `(
  ${ENV_COLUMN},
  event_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'done')),
  claimed_at INTEGER NOT NULL,
  claimed_by TEXT NOT NULL,
  done_at INTEGER,
  outcome TEXT,
  PRIMARY KEY (env, event_id)
)`;

const INVOICE_INDEX_TABLE = `(
  ${ENV_COLUMN},
  invoice_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  PRIMARY KEY (env, invoice_id)
)`;

const PAYMENT_INDEX_TABLE = `(
  ${ENV_COLUMN},
  payment_ref TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  PRIMARY KEY (env, payment_ref)
)`;

const OUTBOX_TABLE = `(
  school_id TEXT NOT NULL,
  ${ENV_COLUMN},
  id TEXT NOT NULL,
  idem TEXT NOT NULL,
  date TEXT NOT NULL,
  body TEXT NOT NULL,
  batch_key TEXT,
  shipped_at INTEGER,
  PRIMARY KEY (school_id, env, id),
  UNIQUE (school_id, env, idem)
)`;

/**
 * The tables the handler writes, in SQLite. Run `db.exec(HANDLER_DDL)` once at start; every statement is
 * `IF NOT EXISTS`. The first two are `schema/storage/rows.v1.sql` as it is.
 *
 * A database made by an earlier release has the last four tables without `env`, and `IF NOT EXISTS` leaves them as they
 * are: call `migrateHandlerSchema(db)` once at start too (before or after this; it does nothing on tables that already
 * have `env`), or the handler stops with an error that says so, before it touches anything.
 */
export const HANDLER_DDL = `
CREATE TABLE IF NOT EXISTS atm_subjects (
  subject_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS atm_rows (
  subject_key TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (subject_key, table_name, row_id)
) WITHOUT ROWID;

-- One row per Stripe event id (evt_...) and env: who is handling it, or that it is handled.
-- claimed: a worker took it at claimed_at; done: its effects are committed (outcome: 'applied' or 'ignored').
CREATE TABLE IF NOT EXISTS atm_event_claims ${CLAIMS_TABLE};

-- Which subject an invoice paid: written in the transaction that applies its invoice.paid (the invoice carries the
-- family in its metadata; a payment or a refund does not). The subject key carries the env too; the column lets the key
-- be unique per env.
CREATE TABLE IF NOT EXISTS atm_invoice_index ${INVOICE_INDEX_TABLE};

-- Which invoice a payment intent or charge paid: written in the transaction that handles the invoice_payment.paid event
-- (or, for the caller's optional paymentRefs hook, the invoice.paid that names them). A refund or dispute names only
-- the payment: payment_ref -> invoice_id here, then invoice_id -> subject_key in atm_invoice_index, in the same env.
CREATE TABLE IF NOT EXISTS atm_payment_index ${PAYMENT_INDEX_TABLE};

-- The decision events, waiting to be shipped to the ledger. body is the event's canonical serialized line, fixed at
-- insert. The insert is ON CONFLICT (school_id, env, idem) DO NOTHING. A shipper (not part of the handler) sets
-- batch_key and shipped_at. The shipper reads a school's rows whatever their env.
CREATE TABLE IF NOT EXISTS ledger_outbox ${OUTBOX_TABLE};
`;

/**
 * One table of the migration: its definition in the new shape, its columns before `env`, and the SQL that tells which
 * env an existing row belongs to (`rowEnv`, with the old table in scope as `prior`).
 */
type TableMigration = {
	table: string;
	definition: string;
	columns: string[];
	rowEnv: string;
};

/** `school|env|customer`: the second segment of a subject key is its env (the parts may not contain `|`). */
const SUBJECT_KEY_ENV = `CASE WHEN substr(subject_key, instr(subject_key, '|') + 1) LIKE 'test|%' THEN 'test' ELSE 'live' END`;

const INVOICE_INDEX = "atm_invoice_index";
const PAYMENT_INDEX = "atm_payment_index";

/**
 * What env the invoice a payment paid belongs to: its row in the invoice index, which is old (it has only a subject key) or
 * already migrated. A payment whose invoice is not indexed (it cannot happen through the handler) reads as live.
 */
const paymentEnv = (invoiceIndexHasEnv: boolean): string =>
	`COALESCE((SELECT ${invoiceIndexHasEnv ? "i.env" : SUBJECT_KEY_ENV.replaceAll("subject_key", "i.subject_key")} FROM ${INVOICE_INDEX} AS i WHERE i.invoice_id = prior.invoice_id), 'live')`;

const MIGRATED_TABLES: readonly string[] = [
	"atm_event_claims",
	INVOICE_INDEX,
	PAYMENT_INDEX,
	"ledger_outbox",
];

const hasEnvColumn = (db: SqlDatabase, table: string): boolean =>
	db.all<{ name: string }>(
		`SELECT name FROM pragma_table_info('${table}') WHERE name = 'env'`,
	).length > 0;

const tableExists = (db: SqlDatabase, table: string): boolean =>
	db.all<{ name: string }>(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
		[table],
	).length > 0;

/**
 * The handler's tables that exist but have no `env` column: made by a release before env was a key. Empty for a current
 * database, and for one where the tables are not made yet.
 */
export const tablesWithoutEnv = (db: SqlDatabase): string[] =>
	db
		.all<{ name: string }>(
			`SELECT m.name AS name FROM sqlite_master AS m WHERE m.type = 'table' AND m.name IN (${MIGRATED_TABLES.map(() => "?").join(", ")}) AND NOT EXISTS (SELECT 1 FROM pragma_table_info(m.name) AS c WHERE c.name = 'env')`,
			MIGRATED_TABLES,
		)
		.map((row) => row.name)
		.sort();

const migrationsFor = (db: SqlDatabase): TableMigration[] => [
	// The payment index first: its env is read from the invoice index, which is still in the old shape at this point.
	{
		table: PAYMENT_INDEX,
		definition: PAYMENT_INDEX_TABLE,
		columns: ["payment_ref", "invoice_id"],
		rowEnv: paymentEnv(
			tableExists(db, INVOICE_INDEX) && hasEnvColumn(db, INVOICE_INDEX),
		),
	},
	{
		table: INVOICE_INDEX,
		definition: INVOICE_INDEX_TABLE,
		columns: ["invoice_id", "subject_key"],
		rowEnv: SUBJECT_KEY_ENV,
	},
	// A claim names no subject, and an outbox row's body does not say which env decided it: both were written by a handler
	// that knew no env, and read as live.
	{
		table: "atm_event_claims",
		definition: CLAIMS_TABLE,
		columns: [
			"event_id",
			"state",
			"claimed_at",
			"claimed_by",
			"done_at",
			"outcome",
		],
		rowEnv: "'live'",
	},
	{
		table: "ledger_outbox",
		definition: OUTBOX_TABLE,
		columns: [
			"school_id",
			"id",
			"idem",
			"date",
			"body",
			"batch_key",
			"shipped_at",
		],
		rowEnv: "'live'",
	},
];

const countOf = (db: SqlDatabase, table: string): number =>
	db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0;

/**
 * Brings a database made by an earlier release to the shape of `HANDLER_DDL`: `atm_event_claims`, `atm_invoice_index`,
 * `atm_payment_index` and `ledger_outbox` gain an `env` column and a primary key (and unique key) that starts from it.
 * SQLite cannot change a primary key, so each table that lacks `env` is rebuilt: a new table is made, every row copied,
 * the old table dropped and the new one renamed, all in ONE transaction (an error, including a row count that differs
 * after the copy, rolls everything back and leaves the database as it was). A table that already has `env`, or does not
 * exist yet, is left alone, so it is safe to run on every start, before or after `HANDLER_DDL`, and twice.
 *
 * Which env the existing rows belong to: an invoice index row's, from its subject key (`school|env|customer`), and a
 * payment index row's, from its invoice; every claim and every outbox row reads as `"live"`, because nothing in them
 * says otherwise. A database that only ever served live traffic is therefore migrated with every row live, as before.
 * A database that served a test endpoint keeps that endpoint's refunds working (its index rows read as test), while its
 * old claims and outbox rows read as live: a test-mode event delivered again after the migration is claimed again,
 * decided as a replay (the rows it wrote are already in the subject) and its outbox events inserted once more under
 * `test`; the log's reader drops the repeat by `idem`.
 *
 * Take a copy or a Litestream snapshot first: after the commit the old tables are gone. The outbox is copied row by
 * row inside the transaction, so on a large one run it while the handler is stopped.
 */
export const migrateHandlerSchema = (
	db: SqlDatabase,
): HandlerMigrationResult => {
	if (tablesWithoutEnv(db).length === 0) return { rebuilt: [] };
	return db.transaction(() => {
		const rebuilt: string[] = [];
		// Decided before the first rebuild: `migrationsFor` reads the shape of the invoice index.
		const migrations = migrationsFor(db);
		const pending = new Set(tablesWithoutEnv(db));
		for (const { table, definition, columns, rowEnv } of migrations) {
			if (!pending.has(table)) continue;
			const next = `${table}_with_env`;
			const list = columns.join(", ");
			const selected = columns.map((column) => `prior.${column}`).join(", ");
			db.exec(`DROP TABLE IF EXISTS ${next}`);
			db.exec(`CREATE TABLE ${next} ${definition}`);
			db.run(
				`INSERT INTO ${next} (env, ${list}) SELECT ${rowEnv}, ${selected} FROM ${table} AS prior`,
			);
			const before = countOf(db, table);
			const after = countOf(db, next);
			if (before !== after)
				throw new Error(
					`migrateHandlerSchema: ${table} had ${before} rows and its copy ${after}; nothing was changed`,
				);
			db.exec(`DROP TABLE ${table}`);
			db.exec(`ALTER TABLE ${next} RENAME TO ${table}`);
			rebuilt.push(table);
		}
		return { rebuilt };
	});
};
