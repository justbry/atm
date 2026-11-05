-- Reference SQLite DDL for atm's billing rows (src/billing/rows.ts). Portable: no triggers, no RAISE.
-- One subject per atm_subjects row (key from subjectKey()); its rows are the engine's tables a mutation touches,
-- plus one JSON row, table_name = 'atm_grants' and row_id = 'grants', that holds the billing rules' GrantsState
-- (which invoices were paid and what they granted). It is written in the same transaction under the same revision,
-- so the one revision check in step 1 covers the engine rows and the grants together: two writers never both
-- apply a payment. It is not engine state: stateFromRows and subjectFromRows leave it out, and rowChangesFromMutation
-- never deletes it. Read it with grantsFromRows(rows); handleStripeEvent returns its upsert with the engine rows.
-- A write is one transaction:
--   1. UPDATE atm_subjects SET revision = :next WHERE subject_key = :key AND revision = :expected;
--      (a new subject: INSERT with revision :next when :expected = 0 and no row exists); zero rows changed = StaleRevision.
--   2. INSERT ... ON CONFLICT(subject_key, table_name, row_id) DO UPDATE SET data = excluded.data   for each upsert
--   3. DELETE FROM atm_rows WHERE subject_key = :key AND table_name = :t AND row_id = :id           for each delete

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
