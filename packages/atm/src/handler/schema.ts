/**
 * The tables the handler writes, in SQLite. Run `db.exec(HANDLER_DDL)` once at start; every statement is
 * `IF NOT EXISTS`. The first two are `schema/storage/rows.v1.sql` as it is.
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

-- One row per Stripe event id (evt_...): who is handling it, or that it is handled.
-- claimed: a worker took it at claimed_at; done: its effects are committed (outcome: 'applied', 'non_usd' or 'ignored'; no CHECK on the column).
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
