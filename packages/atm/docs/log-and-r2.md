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
- The handler's `atm_event_claims`, `atm_invoice_index`, `atm_payment_index` and `ledger_outbox` keys carry no env (nor does the event id atm derives from the school and Stripe's id). Stripe's ids differ between test and live mode, so two endpoints sharing one database do not collide; the same id delivered under both envs would be claimed once. Closing it changes the DDL, so it waits for a schema version.

## The Parquet export

- Parquet on R2 from DuckDB (`COPY (... ORDER BY ...)`, `SET threads = 1`), compared by a hash of the rows. After the log path.
