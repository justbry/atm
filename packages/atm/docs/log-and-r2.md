# The log path to R2

The outbox, the folder shipper, shipping to R2, the combine, the manifest, replay of the log, and the open items around them. Moved here from `ROADMAP.md` in the roadmap split; the wording is the original. The built items (#29, #39, #41) are also in `CHANGELOG.md`; `ROADMAP.md` keeps each open item as one line. Related: `docs/financial-reports.md` (what the log feeds), `docs/usage-metering.md` (the R2 layer for usage events), `docs/review-findings.md` (the replay decisions), `docs/README.md`.

## The folder shipper (#41)

- The folder shipper (`shipOutbox`, `planOutbox`, `atm ship`; outbox rows into one `batch-*.jsonl` per event date, plan then create-only put with `If-None-Match: *`, then mark `batch_key` and `shipped_at`). `atm journal` works end to end on a plain folder with no R2. Tested with `FolderStore`: determinism, rerun, crash between put and mark, two shippers, a conflicting key, and the real handler through `journalMonth` and hledger (`tests/ship.test.ts`). Details in `README.md` and `UPGRADING.md`.

## Shipping to R2

- Shipping to R2 (`R2Store`): the same call takes it, but it is not run against R2 or SeaweedFS.

## The day.jsonl combine and late batches

- The `day.jsonl` combine and `late-*` batches. Open for it: the reader keeps only `late-*` beside a `day.jsonl`, so the shipper reports a day that has one as a conflict (rows stay unshipped) rather than put a `batch-*` that would not be read; the combine (or the shipper's naming, `late-*`) has to settle how such a day takes later rows.

## Two shippers

- Two shippers that read different rows at the same moment, or a crash between put and mark followed by new rows for the same day, write two overlapping batches (different keys); the reader drops the repeated events by `idem`, so the journal is right, but the files hold some events twice until a combine.

## The signed monthly manifest

- The signed monthly manifest (Ed25519) with history, replaced with `If-Match`.

## The SeaweedFS wheel

- Replace the third-party PyPI SeaweedFS wheel with the official release, pinned by version and checksum, before CI depends on it.

## R2 ignores If-Match on DELETE (#39)

- Check whether R2 honours `If-Match` on DELETE. It does not (2026-11-05, a staging bucket through the S3 endpoint with a key scoped to it): a DELETE with a wrong ETag on an existing key answered 204 and removed the object; a right ETag, `If-Match: *` and `If-None-Match: *` also answered 204, and a wrong ETag on a missing key answered 204. Cloudflare's S3 compatibility page lists no conditional header for DeleteObject, so this was not a surprise. Production code did not depend on it: `R2Store.delete` reads the object, compares its SHA-256 and deletes unconditionally, so it guards against a wrong key, not a race (a writer that puts new bytes between the check and the delete loses them). A caller must delete only keys it owns, or use write-once keys. Not checked: `DeleteObjects` (the batch form) and the Workers binding's `delete()`.

## A Worker version of the handler

- A Worker version of the handler. Blocked: Workers refuse `new Function`, which `ajv` uses.

## Replay of the log (#29)

- Fix replay of the log (#29; see the Review section). Every command is logged once with its whole mutation and replayed in each subject's revision order. Logs written by 0.3.0 are read, not rewritten: a log with a lost command (a revision gap) stops there with `ReplayGapError` (its `prefix` is the replay up to it), and a log without a gap replays and names the subjects whose last command may have a lost one after it (`lossySubjects`). What 0.3.0 never logged is not recovered. Checked by `tests/replay-log.test.ts`, `tests/replay-inputs.test.ts` (the fixture year) and `tests/replay-old-log.test.ts` (logs made with the 0.3.0 writer, `fixtures/log-0.3.0/`).

## The contract suite under Node and against staging R2

- The contract suite under Node (only Bun has run) and against staging R2 (never run).

## Env on the handler's tables

- `env` is fixed to `"live"` in `handle.ts` and `grants.ts`. It was atm's (five sites: `handle.ts`, `stripe-webhook.ts` and three in `grants.ts`); it is now an option that defaults to `"live"` on `handleStripeEvent`, the grants functions, `menuCatalogRows` and `WebhookDeps`. The family service has `billingKeyMode` and still has to pass it; it has not yet.
- **Done after 0.6.0: the keys carry env.** `atm_event_claims` and `atm_invoice_index` and `atm_payment_index` are keyed `(env, id)` and `ledger_outbox` `(school_id, env, id)` with `UNIQUE (school_id, env, idem)`; `env` is `CHECK (env IN ('live', 'test'))` and `DEFAULT 'live'` (a plain insert written before env existed is a live row). The handler passes its `WebhookDeps.env` to every claim, index and outbox statement, and the refund's payment-to-invoice join stays inside one env. The same Stripe event, invoice and payment ids delivered under both envs are now claimed, indexed and booked once each; a redelivery under one env is still `duplicate`.
- **The event id atm derives is NOT changed** (`deterministicUlid` of the school and Stripe's event id, unchanged for live and for test), and nor is any `idem`. Evidence: with `env` in the outbox key the two envs' rows coexist whatever their ids; the shipper reads `WHERE school_id = ?` and marks each row it planned by `school_id`, `id` and `body` (the bodies of the two envs differ in the env they name), so the rows of one id in both envs ship in one batch and are marked together, while a row of the other env that arrives after the plan is left for the next run; `refuseReusedCommandId` and `recordEngineCommand`/`recordLapse` take the env from the command's identity. Changing the id for `test` would put test-mode events into the school's log under ids of their own, which is the wrong direction: the log has no env (see below). Changing it for `live` would rewrite every stored id and the goldens.
- **Migration: `migrateHandlerSchema(db)`.** `IF NOT EXISTS` leaves an old table as it is, and SQLite cannot change a primary key, so a database made by 0.6.0 or earlier is rebuilt table by table (new table, copy, count check, drop, rename) in ONE transaction: an error rolls every table back. It is a no-op on a current database or one with no handler tables, so it can run at every start, before or after `HANDLER_DDL`. Existing rows read as `live`, except a row of the two index tables whose subject key (`school|env|customer`) says `test`, and a payment whose invoice does (so a refund through an existing test endpoint still finds its invoice); claims and outbox rows carry nothing that names an env and read as `live`. An index a caller added to one of the four tables is made again on the rebuilt table. Without the migration the handler (and `recordEngineCommand`, `recordLapse`) throws before it touches anything, naming `migrateHandlerSchema`. Constraints read from the family service's `test/schema-portable.test.ts` and `test/migration-guard.test.ts` (buzz-school, read only): the schema has no trigger and no `RAISE` (Litestream's bundled SQLite must read it), and the rebuild drops no table that another refers to by foreign key (none of these has any). Proved with a database built from the 0.6.0 DDL text in the test, and once more with a database written by the 0.6.0 handler's own code (a one-off run, not committed): rows intact, an old `evt_` redelivered is `duplicate`, a refund finds its payment and invoice through the migrated rows, `PRAGMA integrity_check` ok.
- **Still open: the log does not separate envs.** A school's test and live events both ship to `schools/<id>/events/` and the reader drops a repeated `idem`, so a test event with a live event's idem is shipped too, and the reader keeps the one with the lower id (the events are sorted by id, then the first of each idem is kept): when the two ids are equal that is the live row in practice (the shipper reads a school's rows in key order, live first), but when the test event's id is lower (a test delivery of a reused Stripe id with an earlier `created`) the test event is the one in the journal and the live event is dropped; and a test endpoint's events are in the live books whenever the two share an outbox. Real Stripe never repeats an id across modes, so the first needs a caller that reuses ids; the second is the same as before this change. Options for the owner: (a) one database and one shipper per env (what the docs recommend: serve each env from its own endpoint); (b) `atm ship --env` shipping one env only, test rows left unshipped; (c) an env in the log path (`schools/<id>/<env>/events/`), which changes the reader and every journal.

## The Parquet export

- Parquet on R2 from DuckDB (`COPY (... ORDER BY ...)`, `SET threads = 1`), compared by a hash of the rows. After the log path.
