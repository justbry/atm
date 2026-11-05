/**
 * `env` in the keys of the handler's `atm_event_claims`, `atm_invoice_index`, `atm_payment_index` and `ledger_outbox`,
 * and the migration of a database made before it was: the same Stripe id under live and under test, a redelivery under
 * one env, and a database built from the OLD `HANDLER_DDL` (release 0.6.0, copied below) migrated with its data and its
 * behaviour intact.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL, migrateHandlerSchema } from "../src/index.js";
import { readEvents } from "../src/ledger/files.js";
import { appendToOutbox } from "../src/ledger/outbox.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { FolderStore } from "../src/store/folder-store.js";
import type { AtmEvent } from "../src/types.js";
import {
	GROSS,
	HOUR,
	harness,
	linked,
	paid,
	refund,
	SCHOOL,
	SHIPPED_AT,
	T0,
} from "./handler-harness.js";
import { tmp } from "./helpers.js";
import type { RawEvent } from "./stripe-events.js";

/** `HANDLER_DDL` as release 0.6.0 had it (`packages/atm/src/handler/schema.ts` at `23bf828a2`), byte for byte. */
const OLD_HANDLER_DDL = `
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

-- One row per Stripe event id (evt_...): who is handling it, or that it is handled.
-- claimed: a worker took it at claimed_at; done: its effects are committed (outcome: 'applied' or 'ignored').
CREATE TABLE IF NOT EXISTS atm_event_claims (
  event_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'done')),
  claimed_at INTEGER NOT NULL,
  claimed_by TEXT NOT NULL,
  done_at INTEGER,
  outcome TEXT
);

-- Which subject an invoice paid: written in the transaction that applies its invoice.paid (the invoice carries the
-- family in its metadata; a payment or a refund does not).
CREATE TABLE IF NOT EXISTS atm_invoice_index (
  invoice_id TEXT PRIMARY KEY,
  subject_key TEXT NOT NULL
);

-- Which invoice a payment intent or charge paid: written in the transaction that handles the invoice_payment.paid event
-- (or, for the caller's optional paymentRefs hook, the invoice.paid that names them). A refund or dispute names only
-- the payment: payment_ref -> invoice_id here, then invoice_id -> subject_key in atm_invoice_index.
CREATE TABLE IF NOT EXISTS atm_payment_index (
  payment_ref TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL
);

-- The decision events, waiting to be shipped to the ledger. body is the event's canonical serialized line, fixed at
-- insert. The insert is ON CONFLICT (school_id, idem) DO NOTHING. A shipper (not part of the handler) sets
-- batch_key and shipped_at.
CREATE TABLE IF NOT EXISTS ledger_outbox (
  school_id TEXT NOT NULL,
  id TEXT NOT NULL,
  idem TEXT NOT NULL,
  date TEXT NOT NULL,
  body TEXT NOT NULL,
  batch_key TEXT,
  shipped_at INTEGER,
  PRIMARY KEY (school_id, id),
  UNIQUE (school_id, idem)
);
`;

const HANDLER_TABLES = [
	"atm_subjects",
	"atm_rows",
	"atm_event_claims",
	"atm_invoice_index",
	"atm_payment_index",
	"ledger_outbox",
] as const;

/** Every row of every handler table, sorted by its JSON so that two databases compare whatever their column order. */
const dumpOf = (raw: Database) =>
	Object.fromEntries(
		HANDLER_TABLES.map((table) => [
			table,
			(raw.query(`SELECT * FROM ${table}`).all() as object[])
				.map((row) => JSON.stringify(Object.entries(row).sort()))
				.sort(),
		]),
	);

const oldDatabase = (): Database => {
	const raw = new Database(":memory:");
	raw.exec(OLD_HANDLER_DDL);
	return raw;
};

const columnsOf = (raw: Database, table: string): string[] =>
	(
		raw.query(`SELECT name FROM pragma_table_info('${table}')`).all() as {
			name: string;
		}[]
	).map((column) => column.name);

/** The rows of a current database as an old one would hold them: the same columns minus `env`. */
const asOldDatabase = (current: Database): Database => {
	const old = oldDatabase();
	for (const table of HANDLER_TABLES) {
		const columns = columnsOf(old, table);
		const rows = current
			.query(`SELECT ${columns.join(", ")} FROM ${table}`)
			.all() as Record<string, string | number | null>[];
		for (const row of rows)
			old
				.query(
					`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
				)
				.run(...columns.map((column) => row[column] as string | number | null));
	}
	return old;
};

/** What a table's keys are, as SQLite reports them: the columns with their primary key position, and the unique indexes. */
const shapeOf = (raw: Database, table: string) => ({
	columns: raw
		.query(
			`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}') ORDER BY cid`,
		)
		.all(),
	uniques: (
		raw
			.query(
				`SELECT name FROM pragma_index_list('${table}') WHERE "unique" = 1`,
			)
			.all() as { name: string }[]
	)
		.map(
			(index) =>
				raw
					.query(
						`SELECT name FROM pragma_index_info('${index.name}') ORDER BY seqno`,
					)
					.all() as { name: string }[],
		)
		.map((columns) => columns.map((column) => column.name))
		.sort(),
});

describe("the same Stripe ids under live and under test", () => {
	test("each env claims, indexes and books them once", () => {
		const raw = new Database(":memory:");
		const live = harness(undefined, { raw });
		const test = harness(undefined, { raw, env: "test" });

		expect(live.deliver(paid()).body.outcome).toBe("applied");
		// Before env was a key this was answered `duplicate` and the test subject never existed.
		expect(test.deliver(paid()).body.outcome).toBe("applied");

		expect(
			raw
				.query(`SELECT env, event_id, state FROM atm_event_claims ORDER BY env`)
				.all(),
		).toEqual([
			{ env: "live", event_id: "evt_in_1", state: "done" },
			{ env: "test", event_id: "evt_in_1", state: "done" },
		]);
		expect(
			raw
				.query(
					`SELECT env, invoice_id, subject_key FROM atm_invoice_index ORDER BY env`,
				)
				.all(),
		).toEqual([
			{
				env: "live",
				invoice_id: "in_1",
				subject_key: "sch_vol|live|family:fam_8k2",
			},
			{
				env: "test",
				invoice_id: "in_1",
				subject_key: "sch_vol|test|family:fam_8k2",
			},
		]);
		const eventsOf = (env: string) =>
			raw
				.query(`SELECT id, idem FROM ledger_outbox WHERE env = ? ORDER BY id`)
				.all(env) as { id: string; idem: string }[];
		expect(eventsOf("live").length).toBeGreaterThan(0);
		// the same events, decided in each env: same ids and idems, one row each per env
		expect(eventsOf("test")).toEqual(eventsOf("live"));

		// the payment link, then a refund through the TEST endpoint only
		expect(live.deliver(linked("in_1")).body.outcome).toBe("applied");
		expect(test.deliver(linked("in_1")).body.outcome).toBe("applied");
		expect(
			raw
				.query(
					`SELECT env, payment_ref, invoice_id FROM atm_payment_index ORDER BY env`,
				)
				.all(),
		).toEqual([
			{ env: "live", payment_ref: "pi_in_1", invoice_id: "in_1" },
			{ env: "test", payment_ref: "pi_in_1", invoice_id: "in_1" },
		]);
		const subjectRows = (env: string) =>
			raw
				.query(
					`SELECT table_name, row_id, data FROM atm_rows WHERE subject_key = ? ORDER BY table_name, row_id`,
				)
				.all(`sch_vol|${env}|family:fam_8k2`);
		const liveBefore = subjectRows("live");
		const testBefore = subjectRows("test");
		expect(testBefore).toEqual(liveBefore);
		expect(test.deliver(refund(GROSS), T0 + HOUR).body.outcome).toBe("applied");
		expect(subjectRows("live")).toEqual(liveBefore);
		expect(subjectRows("test")).not.toEqual(testBefore);
		expect(
			raw
				.query(
					`SELECT env FROM ledger_outbox WHERE body LIKE '%"event_type":"payment.refunded"%'`,
				)
				.all(),
		).toEqual([{ env: "test" }]);
	});

	test("a redelivery under the same env is claimed once, in either env", () => {
		const raw = new Database(":memory:");
		const live = harness(undefined, { raw });
		const test = harness(undefined, { raw, env: "test" });
		for (const endpoint of [live, test]) {
			expect(endpoint.deliver(paid()).body.outcome).toBe("applied");
			const before = dumpOf(raw);
			expect(endpoint.deliver(paid()).body.outcome).toBe("duplicate");
			expect(dumpOf(raw)).toEqual(before);
		}
		expect(
			(
				raw.query(`SELECT COUNT(*) AS n FROM atm_event_claims`).get() as {
					n: number;
				}
			).n,
		).toBe(2);
	});

	test("a non-USD delivery under each env writes its own claim row with outcome non_usd, and a redelivery in the same env is a duplicate", () => {
		const raw = new Database(":memory:");
		const live = harness(undefined, { raw });
		const test = harness(undefined, { raw, env: "test" });
		const inEuros = (): RawEvent => {
			const event = paid();
			event.data.object.currency = "eur";
			return event;
		};
		for (const endpoint of [live, test]) {
			endpoint.deps.warn = () => undefined;
			expect(endpoint.deliver(inEuros()).body.outcome).toBe("non_usd");
		}
		const claimRows = () =>
			raw
				.query(
					`SELECT env, event_id, state, outcome FROM atm_event_claims ORDER BY env`,
				)
				.all();
		expect(claimRows()).toEqual([
			{
				env: "live",
				event_id: "evt_in_1",
				state: "done",
				outcome: "non_usd",
			},
			{
				env: "test",
				event_id: "evt_in_1",
				state: "done",
				outcome: "non_usd",
			},
		]);
		for (const endpoint of [live, test]) {
			expect(endpoint.deliver(inEuros()).body.outcome).toBe("duplicate");
		}
		expect(claimRows()).toHaveLength(2);
	});

	test("an invoice linked only in the live env is unmatched for a refund in the test env", () => {
		const raw = new Database(":memory:");
		const live = harness(undefined, { raw });
		const test = harness(undefined, { raw, env: "test" });
		live.deliver(paid());
		live.deliver(linked("in_1"));
		const before = dumpOf(raw);
		const response = test.deliver(refund(GROSS), T0 + HOUR);
		expect(response.status).toBe(409);
		expect(response.body.outcome).toBe("unmatched_payment");
		expect(dumpOf(raw)).toEqual(before);
	});
});

describe("the outbox insert", () => {
	test("drops a repeat of an idem within one env and keeps the same idem decided in the other", () => {
		const db = bunSqlite(new Database(":memory:"));
		db.exec(HANDLER_DDL);
		const event = {
			school: "sch_vol",
			id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
			idem: "stripe:in_1",
			date: "2026-01-15",
		} as unknown as AtmEvent;
		expect(appendToOutbox(db, [event], "live")).toBe(1);
		expect(appendToOutbox(db, [event], "live")).toBe(0);
		expect(appendToOutbox(db, [event], "test")).toBe(1);
		expect(appendToOutbox(db, [event], "test")).toBe(0);
		expect(
			db.all("SELECT env, id, idem FROM ledger_outbox ORDER BY env"),
		).toEqual([
			{ env: "live", id: event.id, idem: "stripe:in_1" },
			{ env: "test", id: event.id, idem: "stripe:in_1" },
		]);
	});
});

describe("the shipper on an outbox that holds the same ids under both envs", () => {
	test("ships every row once, marks both envs' rows shipped, and the reader drops the repeated idem", async () => {
		const raw = new Database(":memory:");
		const live = harness(undefined, { raw });
		const test = harness(undefined, { raw, env: "test" });
		live.deliver(paid());
		test.deliver(paid());
		const rows = (
			raw.query(`SELECT COUNT(*) AS n FROM ledger_outbox`).get() as {
				n: number;
			}
		).n;
		expect(rows).toBeGreaterThan(0);
		expect(rows % 2).toBe(0);

		const root = await tmp("env-keys-ship");
		const store = new FolderStore({ root });
		const shipped = await shipOutbox({
			db: bunSqlite(raw),
			store,
			school: SCHOOL,
			nowMs: () => SHIPPED_AT,
		});
		expect(shipped.conflicts).toEqual([]);
		expect(shipped.shipped).toBe(rows);
		expect(
			raw
				.query(
					`SELECT COUNT(*) AS n FROM ledger_outbox WHERE shipped_at IS NULL`,
				)
				.get(),
		).toEqual({ n: 0 });
		// a second run ships nothing
		expect(
			(
				await shipOutbox({
					db: bunSqlite(raw),
					store,
					school: SCHOOL,
					nowMs: () => SHIPPED_AT,
				})
			).shipped,
		).toBe(0);
		// the log has no env: the reader keeps one event for each idem, so each event of the pair is read once
		const { events } = await readEvents(root, SCHOOL);
		expect(events).toHaveLength(rows / 2);
	});
});

describe("migrating a database made by the old HANDLER_DDL", () => {
	/** The events of one family's life through the handler: create, link, a repeat of the create, then a full refund. */
	const history: [RawEvent, number][] = [
		[paid(), T0],
		[linked("in_1"), T0],
		[paid(), T0 + 1000],
		[refund(GROSS), T0 + HOUR],
	];

	test("the old tables have no env, and HANDLER_DDL leaves them as they are", () => {
		const raw = oldDatabase();
		raw.exec(HANDLER_DDL);
		for (const table of [
			"atm_event_claims",
			"atm_invoice_index",
			"atm_payment_index",
			"ledger_outbox",
		])
			expect(columnsOf(raw, table)).not.toContain("env");
	});

	test("an old database with data migrates to the shape of a new one, with every row intact", () => {
		const raw = oldDatabase();
		raw.exec(`
			INSERT INTO atm_subjects VALUES ('sch_vol|live|family:f1', 4);
			INSERT INTO atm_rows VALUES ('sch_vol|live|family:f1', 'grants', 'g1', '{"a":1}');
			INSERT INTO atm_event_claims VALUES ('evt_done', 'done', 10, 'worker-a', 11, 'applied');
			INSERT INTO atm_event_claims VALUES ('evt_busy', 'claimed', 20, 'worker-b', NULL, NULL);
			INSERT INTO atm_event_claims VALUES ('evt_ignored', 'done', 30, 'worker-a', 30, 'ignored');
			INSERT INTO atm_invoice_index VALUES ('in_live', 'sch_vol|live|family:f1');
			INSERT INTO atm_invoice_index VALUES ('in_test', 'sch_vol|test|family:f2');
			INSERT INTO atm_invoice_index VALUES ('in_entity', 'sch_vol|test|family:f3|child1');
			INSERT INTO atm_invoice_index VALUES ('in_lookalike', 'sch_vol|testing|family:f4');
			INSERT INTO atm_payment_index VALUES ('pi_live', 'in_live');
			INSERT INTO atm_payment_index VALUES ('pi_test', 'in_test');
			INSERT INTO atm_payment_index VALUES ('pi_orphan', 'in_not_indexed');
			INSERT INTO ledger_outbox VALUES ('sch_vol', 'ev1', 'idem-1', '2026-01-15', '{"id":"ev1"}', 'schools/sch_vol/b1.jsonl', 99);
			INSERT INTO ledger_outbox VALUES ('sch_vol', 'ev2', 'idem-2', '2026-01-16', '{"id":"ev2"}', NULL, NULL);
			INSERT INTO ledger_outbox VALUES ('sch_other', 'ev1', 'idem-1', '2026-01-15', '{"id":"ev1"}', NULL, NULL);
		`);
		const counts = (db: Database) =>
			Object.fromEntries(
				HANDLER_TABLES.map((table) => [
					table,
					(
						db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
							n: number;
						}
					).n,
				]),
			);
		const before = counts(raw);

		const result = migrateHandlerSchema(bunSqlite(raw));
		expect(result.rebuilt.sort()).toEqual([
			"atm_event_claims",
			"atm_invoice_index",
			"atm_payment_index",
			"ledger_outbox",
		]);
		expect(counts(raw)).toEqual(before);

		// the same keys and defaults as a database made by the new DDL
		const fresh = new Database(":memory:");
		fresh.exec(HANDLER_DDL);
		for (const table of HANDLER_TABLES)
			expect(shapeOf(raw, table)).toEqual(shapeOf(fresh, table));
		// nothing left behind
		expect(
			(
				raw
					.query(
						`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%with_env%'`,
					)
					.all() as unknown[]
			).length,
		).toBe(0);
		expect(raw.query(`PRAGMA integrity_check`).all()).toEqual([
			{ integrity_check: "ok" },
		]);

		// existing rows read as live, except an index row whose subject key says test
		expect(
			raw
				.query(
					`SELECT env, event_id, state, claimed_at, claimed_by, done_at, outcome FROM atm_event_claims ORDER BY event_id`,
				)
				.all(),
		).toEqual([
			{
				env: "live",
				event_id: "evt_busy",
				state: "claimed",
				claimed_at: 20,
				claimed_by: "worker-b",
				done_at: null,
				outcome: null,
			},
			{
				env: "live",
				event_id: "evt_done",
				state: "done",
				claimed_at: 10,
				claimed_by: "worker-a",
				done_at: 11,
				outcome: "applied",
			},
			{
				env: "live",
				event_id: "evt_ignored",
				state: "done",
				claimed_at: 30,
				claimed_by: "worker-a",
				done_at: 30,
				outcome: "ignored",
			},
		]);
		expect(
			raw
				.query(`SELECT * FROM atm_invoice_index ORDER BY env, invoice_id`)
				.all(),
		).toEqual([
			{
				env: "live",
				invoice_id: "in_live",
				subject_key: "sch_vol|live|family:f1",
			},
			{
				env: "live",
				invoice_id: "in_lookalike",
				subject_key: "sch_vol|testing|family:f4",
			},
			{
				env: "test",
				invoice_id: "in_entity",
				subject_key: "sch_vol|test|family:f3|child1",
			},
			{
				env: "test",
				invoice_id: "in_test",
				subject_key: "sch_vol|test|family:f2",
			},
		]);
		expect(
			raw.query(`SELECT * FROM atm_payment_index ORDER BY payment_ref`).all(),
		).toEqual([
			{ env: "live", payment_ref: "pi_live", invoice_id: "in_live" },
			{ env: "live", payment_ref: "pi_orphan", invoice_id: "in_not_indexed" },
			{ env: "test", payment_ref: "pi_test", invoice_id: "in_test" },
		]);
		expect(
			raw
				.query(
					`SELECT school_id, env, id, idem, date, body, batch_key, shipped_at FROM ledger_outbox ORDER BY school_id, id`,
				)
				.all(),
		).toEqual([
			{
				school_id: "sch_other",
				env: "live",
				id: "ev1",
				idem: "idem-1",
				date: "2026-01-15",
				body: '{"id":"ev1"}',
				batch_key: null,
				shipped_at: null,
			},
			{
				school_id: "sch_vol",
				env: "live",
				id: "ev1",
				idem: "idem-1",
				date: "2026-01-15",
				body: '{"id":"ev1"}',
				batch_key: "schools/sch_vol/b1.jsonl",
				shipped_at: 99,
			},
			{
				school_id: "sch_vol",
				env: "live",
				id: "ev2",
				idem: "idem-2",
				date: "2026-01-16",
				body: '{"id":"ev2"}',
				batch_key: null,
				shipped_at: null,
			},
		]);
		// the subject tables are untouched
		expect(raw.query(`SELECT * FROM atm_subjects`).all()).toEqual([
			{ subject_key: "sch_vol|live|family:f1", revision: 4 },
		]);

		// the new keys hold: the same id under the other env is a row of its own, under the same env it is a conflict
		raw.exec(
			`INSERT INTO atm_event_claims (env, event_id, state, claimed_at, claimed_by) VALUES ('test', 'evt_done', 'claimed', 1, 'w')`,
		);
		expect(() =>
			raw.exec(
				`INSERT INTO atm_event_claims (env, event_id, state, claimed_at, claimed_by) VALUES ('live', 'evt_done', 'claimed', 1, 'w')`,
			),
		).toThrow();
		expect(() =>
			raw.exec(
				`INSERT INTO atm_event_claims (env, event_id, state, claimed_at, claimed_by) VALUES ('prod', 'evt_x', 'claimed', 1, 'w')`,
			),
		).toThrow();
	});

	test("it is safe to run again, and in either order with HANDLER_DDL", () => {
		const first = oldDatabase();
		const db = bunSqlite(first);
		expect(migrateHandlerSchema(db).rebuilt).toHaveLength(4);
		first.exec(HANDLER_DDL);
		const afterOnce = dumpOf(first);
		expect(migrateHandlerSchema(db).rebuilt).toEqual([]);
		expect(dumpOf(first)).toEqual(afterOnce);

		const second = oldDatabase();
		second.exec(HANDLER_DDL);
		expect(migrateHandlerSchema(bunSqlite(second)).rebuilt).toHaveLength(4);
		for (const table of HANDLER_TABLES)
			expect(shapeOf(second, table)).toEqual(shapeOf(first, table));

		// a database with no handler tables at all, and a current one, are left alone
		const empty = new Database(":memory:");
		expect(migrateHandlerSchema(bunSqlite(empty)).rebuilt).toEqual([]);
		const current = new Database(":memory:");
		current.exec(HANDLER_DDL);
		expect(migrateHandlerSchema(bunSqlite(current)).rebuilt).toEqual([]);
	});

	test("a failure rolls every table back: the old database is exactly as it was", () => {
		const raw = oldDatabase();
		raw.exec(`
			INSERT INTO atm_event_claims VALUES ('evt_done', 'done', 10, 'worker-a', 11, 'applied');
			INSERT INTO atm_invoice_index VALUES ('in_test', 'sch_vol|test|family:f2');
			INSERT INTO atm_payment_index VALUES ('pi_test', 'in_test');
			INSERT INTO ledger_outbox VALUES ('sch_vol', 'ev1', 'idem-1', '2026-01-15', '{"id":"ev1"}', NULL, NULL);
			-- a view in the name the outbox's copy would take: DROP TABLE refuses it, which fails the LAST table's rebuild,
			-- after the first three were already rebuilt
			CREATE VIEW ledger_outbox_with_env AS SELECT 1 AS decoy;
		`);
		const before = dumpOf(raw);
		expect(() => migrateHandlerSchema(bunSqlite(raw))).toThrow();
		expect(dumpOf(raw)).toEqual(before);
		for (const table of [
			"atm_event_claims",
			"atm_invoice_index",
			"atm_payment_index",
			"ledger_outbox",
		])
			expect(columnsOf(raw, table)).not.toContain("env");
		expect(
			(
				raw
					.query(
						`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%with_env%'`,
					)
					.all() as unknown[]
			).length,
		).toBe(0);
	});

	test("the handler on an old database stops before it touches anything, naming the fix", () => {
		const raw = oldDatabase();
		const endpoint = harness(undefined, { raw });
		const before = dumpOf(raw);
		expect(() => endpoint.deliver(paid())).toThrow(/migrateHandlerSchema/);
		expect(dumpOf(raw)).toEqual(before);
	});

	test("a family served before the migration is served after it exactly as one that never needed it", () => {
		// Reference: the whole history on a database made by the new DDL.
		const reference = new Database(":memory:");
		const straight = harness(undefined, { raw: reference });
		for (const [event, at] of history) straight.deliver(event, at);

		// Migrated: the first two events on a new database, its tables copied into the OLD shape, migrated, and the rest of
		// the history delivered to the migrated database.
		const before = new Database(":memory:");
		const early = harness(undefined, { raw: before });
		for (const [event, at] of history.slice(0, 2)) early.deliver(event, at);
		const old = asOldDatabase(before);
		expect(columnsOf(old, "atm_event_claims")).not.toContain("env");
		expect(migrateHandlerSchema(bunSqlite(old)).rebuilt).toHaveLength(4);
		expect(dumpOf(old)).toEqual(dumpOf(before));

		const late = harness(undefined, { raw: old });
		// a redelivery of the create invoice the old database already handled is a duplicate, as it was before
		const repeat = history[2] as [RawEvent, number];
		expect(late.deliver(repeat[0], repeat[1]).body.outcome).toBe("duplicate");
		expect(straight.deliver(repeat[0], repeat[1]).body.outcome).toBe(
			"duplicate",
		);
		// the refund finds its payment and invoice through the migrated index rows
		const last = history[3] as [RawEvent, number];
		expect(late.deliver(last[0], last[1]).body.outcome).toBe("applied");

		expect(dumpOf(old)).toEqual(dumpOf(reference));
		expect(late.outbox()).toEqual(straight.outbox());
	});
});

describe("review of the migration and the shipper", () => {
	test("an index the caller made on a rebuilt table is made again on the new one", () => {
		const raw = oldDatabase();
		raw.exec(`
			CREATE INDEX ledger_outbox_open ON ledger_outbox (school_id) WHERE shipped_at IS NULL;
			CREATE INDEX atm_event_claims_open ON atm_event_claims (state, claimed_at);
			INSERT INTO ledger_outbox VALUES ('sch_vol', 'ev1', 'idem-1', '2026-01-15', '{"id":"ev1"}', NULL, NULL);
		`);
		const indexesOf = () =>
			raw
				.query(
					`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`,
				)
				.all();
		const before = indexesOf();
		expect(before).toHaveLength(2);
		migrateHandlerSchema(bunSqlite(raw));
		expect(indexesOf()).toEqual(before);
		// the partial index is usable: the planner may name it, and the rows are still there
		expect(
			(
				raw.query(`SELECT COUNT(*) AS n FROM ledger_outbox`).get() as {
					n: number;
				}
			).n,
		).toBe(1);
	});

	test("a row of the other env that arrives with the same id between the plan and the mark is not marked shipped", async () => {
		const raw = new Database(":memory:");
		raw.exec(HANDLER_DDL);
		const id = "01KF1D0X80000017P7TD9N052W";
		const bodyOf = (env: string) =>
			JSON.stringify({ id, idem: "stripe:in_1", date: "2026-01-15", env });
		const insert = (env: string) =>
			raw
				.query(
					`INSERT INTO ledger_outbox (school_id, env, id, idem, date, body) VALUES (?, ?, ?, 'stripe:in_1', '2026-01-15', ?)`,
				)
				.run(SCHOOL, env, id, bodyOf(env));
		insert("live");
		const root = await tmp("env-keys-race");
		const store = new FolderStore({ root });
		const racing = Object.create(store) as FolderStore;
		racing.putIfAbsent = async (key, body) => {
			const result = await store.putIfAbsent(key, body);
			insert("test");
			return result;
		};
		const first = await shipOutbox({
			db: bunSqlite(raw),
			store: racing,
			school: SCHOOL,
			nowMs: () => SHIPPED_AT,
		});
		expect(first.shipped).toBe(1);
		expect(
			raw.query(`SELECT env, shipped_at FROM ledger_outbox ORDER BY env`).all(),
		).toEqual([
			{ env: "live", shipped_at: SHIPPED_AT },
			{ env: "test", shipped_at: null },
		]);
		const second = await shipOutbox({
			db: bunSqlite(raw),
			store,
			school: SCHOOL,
			nowMs: () => SHIPPED_AT,
		});
		expect(second.shipped).toBe(1);
	});

	test("the family service's outbox calls on an old database name the migration too", () => {
		const raw = oldDatabase();
		const event = {
			school: SCHOOL,
			id: "01KF1D0X80000017P7TD9N052W",
			idem: "stripe:in_1",
			date: "2026-01-15",
		} as unknown as AtmEvent;
		expect(() => appendToOutbox(bunSqlite(raw), [event], "live")).toThrow(
			/migrateHandlerSchema/,
		);
		expect(
			(
				raw.query(`SELECT COUNT(*) AS n FROM ledger_outbox`).get() as {
					n: number;
				}
			).n,
		).toBe(0);
	});
});

describe("the DDL stays portable", () => {
	test("no trigger and no RAISE, and every statement is IF NOT EXISTS (the family service's schema-portable test reads Litestream's SQLite)", () => {
		expect(HANDLER_DDL).not.toMatch(/TRIGGER|RAISE/i);
		const creates = HANDLER_DDL.match(/CREATE TABLE/g) ?? [];
		const guarded = HANDLER_DDL.match(/CREATE TABLE IF NOT EXISTS/g) ?? [];
		expect(creates.length).toBe(6);
		expect(guarded.length).toBe(creates.length);
	});
});
