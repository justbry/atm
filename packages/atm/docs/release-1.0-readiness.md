# Release 1.0 readiness

An audit of what a 1.0.0 of `packages/atm` would promise, what is missing, and the shortest honest path. Written 2026-11-05 against `dev` at `fed0d6c08` (`package.json` says 0.9.0, `atm-v0.9.0` is the last release). The owner decided the next release is **1.0.0**, not 0.10.0; this document does not reopen that, it says what 1.0.0 has to be true. Sources read: `ROADMAP.md` (79 unchecked lines, counted with `grep -c '- \[ \]'`; the brief said 70), `UPGRADING.md`, `CHANGELOG.md`, `docs/releasing.md`, `src/index.ts`, `src/worker.ts`, `src/types.ts`, `package.json`, `release.ts`, `schema/`, `src/handler/{schema,stripe-webhook}.ts`, `src/cli.ts`, `src/ledger/{validate,files,read,ship,ship-inputs}.ts`, `docs/{review-findings,stripe-findings,log-and-r2,e2e-reconciliation,financial-reports,simulate-from-inputs}.md`. Line numbers are of `fed0d6c08`; several line numbers quoted in `ROADMAP.md` and `docs/e2e-reconciliation.md` have drifted (D2 is at `src/billing/money.ts:310` and `:345`, not `:209` and `:177`; `fee ?? 0` is at `:145`; `incomeKindOf` is at `:105`, used at `:202`).

Related: `docs/releasing.md` (how a release is made), `UPGRADING.md`, `ROADMAP.md`.

## The short answer

- **The pure core is ready to be promised; the wiring around it has not been run by anyone.** The grant rules, the ledger events, the handler's answers, the hledger reports and the reconcile logic have 2,865 passing tests, goldens, a 39-case end-to-end matrix and hand-computed numbers. But the one consumer, `buzz-school`, does not call the handler, the shipper or the recorders (`ROADMAP.md:134`, `:78`), no byte has gone to real R2 through atm's shipper (`ROADMAP.md:107`, `:118`, `:70`), nothing has run on a copy of a real school (`ROADMAP.md:108`, `:139`), and the contract suite has only run under Bun (`ROADMAP.md:70`). A 1.0 says "this API is what you integrate against"; today that claim has no integrator behind it.
- **What is not true yet and would be promised:** an `event_type` enum nothing can extend safely (section 1b), a release tarball that does not contain the `atm/worker` subpath that #99 added (section 1a, B1), a wholesale `export type *` of 255 types as public API, and three open money bugs (D2, D6, reclass-on-retry) whose fixes may change booked amounts.
- **The smallest honest 1.0.0** is: the BLOCKER rows of section 2.1 closed (B1 to B4, B6 to B8, the `payout.failed` decision and the env-in-the-log decision), everything else in the public surface labelled `experimental` in the release notes and in `README.md`, and the real-data check done once. It does not need the revenue-share invoicing, Connect, referral codes, receipts, deferred revenue or the Parquet export. If the owner cannot get B6 (consumer wiring) and B7 (real-data run) done, the honest alternatives are a `1.0.0-rc.1` tag first (`release.ts` takes any string from `package.json`; a prerelease version has not been tried, so run `just release-dry` with one before relying on it) or keeping 0.x. The owner decides.

## State at the audit

- **#98, #99 and #103 are already merged** (merge commits `da64abfb9`, `b87d28191`, `26fbba509`), not open as the brief said. #99's effect on the surface: `package.json` `exports` now has `"./worker"` (`package.json:13-17`), `src/worker.ts` re-exports `ledger/read`, `ledger/summary`, `ledger/views` and `store/r2-binding-store`, and `commodityProblems` was moved from `billing/menu.ts` to `billing/commodity.ts` so the read graph stays Ajv-free. **`release.ts` was not changed:** `PACKAGE_FILES` (`release.ts:43-50`) and `publishManifest` (`release.ts:65-67`) list only `dist/index.*` and `dist/types.d.ts` with `exports: { ".": ... }`, so **the published tarball has no `atm/worker`**. `build.ts` does build `dist/worker.js` and `dist/worker.d.ts`; they are just not packed. Two newer commits (#107 knip config, #108 `membersOf` answers `no-catalog` instead of throwing) are on `dev` too.
- **Gates on this tree**, local only: Biome `Checked 432 files ... No fixes applied`; `bunx tsc --noEmit` clean; `bun ./build.ts` built `atm.js, index.js, index.d.ts, types.d.ts, worker.js, worker.d.ts`; `bun run schema` rewrote `duckdb/envelope.v1.sql` and `src/ledger/schemas.ts` with no diff; `bun run knip` at the root reports only configuration hints (and 7 unused `tests/gap` files on the tree before #107, fixed by it). `bun test --timeout 60000 tests` on the final tree (with #107 and #108): **2865 pass, 25 skip, 0 fail** (2890 tests, 127 files, 403 s). An earlier full run, on the tree before #107/#108 and on a machine that stalled for most of an hour (one test was reported as 3,359,798 ms), had 2840 pass, 25 skip and 2 fail: `tests/store-r2-binding.test.ts` (Miniflare could not bind a port, `EADDRNOTAVAIL`) and `tests/reconcile-cli.test.ts` (a CLI child killed by a signal, exit 143). Both passed when run alone (42 pass) and in the final full run, so they are sensitive to a loaded or sandboxed machine.
- **The 25 skips** are all in `tests/store-r2.test.ts` (`describe.skipIf(!hasR2)`, needs `ATM_R2_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, and for check 16 `ATM_R2_ACCOUNT_ID` and `ATM_R2_API_TOKEN`) and `tests/store-seaweedfs.test.ts` (`skipIf(!hasSeaweedfs)`, needs a `weed` binary). They are the **Store contract** (create-only puts, `If-Match`, listing, the 412 rules, key validation, concurrent writers) run against the two real S3-compatible servers. With hledger 1.52.1 and DuckDB 1.5.6 installed (as here) no hledger or DuckDB test skips; on a runner without them about 25 more skip (the `skipIf(!hasHledger)` and `skipIf(!hasDuckdb)` tests in 30 files; `ROADMAP.md:140`: nothing runs `duckdb` in CI, and the CI workflow installs hledger for Linux x86_64 only, `.github/workflows/atm-tests.yml:67-88`). What the skipped tests would cover: whether `R2Store` (the `aws4fetch` path used by `atm ship`, `atm inputs ship` and `shipOutbox`) behaves on a real bucket as its fake S3 in `tests/r2-store.test.ts` says. The fake-S3 unit tests, the folder-store contract and the `R2BindingStore` contract in Miniflare/workerd (`tests/store-r2-binding.test.ts`) did run.

## 1. The stability contract a 1.0 would promise

Rules proposed for every surface (so the tables can be short):

- **Stable** = covered by a semver promise: no removal, no rename, no meaning change, no new required input, in 1.x. Additive output fields and new optional input fields are allowed. A change that is not additive waits for 2.0, or for an opt-in flag.
- **Experimental** = shipped, tested, but not proven by a consumer or known to be incomplete; may change in a minor release, with an `UPGRADING.md` entry. The release notes name the list.
- **Internal** = exported only because the CLI, a test, a scenario tool or another session needed it. Not covered; ideally removed from `index.ts` or tagged `@internal`. Moving them out before 1.0 costs nothing; after 1.0 it is a major.

### 1a. The TypeScript API

`src/index.ts` exports **149 values** (counted at runtime with `Object.keys(await import("./src/index.ts"))`) and `export type * from "./types.js"` (`src/index.ts:224`), which makes **all 255 exported types of the 3,451-line `src/types.ts`** public. That wholesale type export is the biggest single contract problem: any rename of an internal helper type is a major version. Recommendation: before 1.0, list the types a caller needs (the arguments and results of the stable functions below, plus `AtmEvent`, `AtmEventType`, `Menu`, `BillingPolicy`, `GrantsState`, `BillingRow`, `Store`, `SqlDatabase`, `WebhookDeps/Request/Response/Outcome`) in `index.ts` by name and drop the `export type *`; the others stay importable inside the repo and are not promised. (The published `dist/types.d.ts` is one file that `index.d.ts` re-exports, so the narrowing must be done in `build.ts`/`index.ts`, not by deleting declarations.)

Also in the contract: **`engine` types**. `runEngineCommand`, `runOnState`, `mutationToEvents` and `commandTypes` take and return `@autumn/balance-engine` shapes (`WorkerFullSubject`, the command types), and `dist/types.d.ts` inlines them. The engine is a fork that tracks Autumn upstream (`UPSTREAM.md`), so those shapes move when the engine does.

| Group (exports) | Evidence | Verdict | Recommendation |
|---|---|---|---|
| **The integration point:** `handleStripeEvent`, `StripeEventInput/Result/Refusal`, `resolvePolicy`, `DEFAULT_POLICY`, `commandOrg`, `menuCatalogRows`, `validateMenu`, `publishProblems`, `publicMenu`, `validTimeZone`, `quantitiesOf`, `MAX_*` | `index.ts:515`, `:428-447`, `:468`, `:535-557` | **stable**, with one rule: input types gain only optional fields | `BillingPolicy` gained required keys in 0.8.0 (`cancelCutoffHours`, `noShow`, `lateCancel`) and 0.9.0 (`revenueShare`), and `UPGRADING.md` told callers to add `revenueShare: null` to a literal: that is a type break. From 1.0 a new policy field is optional in the type (`resolvePolicy` fills the default) and a result type may gain fields but callers must not exhaustively match them (say so in the notes) |
| **Menu to Stripe:** `menuToStripe`, `checkoutParams`, `oneTimeCheckoutParams`, `withPriceIds`, `toStripeForm`, `portalConfigOf`, `lookupKeyOf`, `subscriptionStatus`, `StripeOp`, `GiftStripeOp` | `index.ts:560-626` | **stable** for the functions; the Stripe op shapes are stable but the family service's executor must handle every op kind, so a new op kind is a breaking change for it | New op kinds only behind an explicit opt-in (as `codes` was in 0.8.0). `portalConfigOf` key order is an open question (`ROADMAP.md:68`); settle it before 1.0 |
| **Rules below `handleStripeEvent`:** `invoiceToCommands`, `refundToCommands`, `disputeToCommands`, `subscriptionToCommands`, `subscriptionEndedToCommands`, `prorationPair`, `raiseUnits` | `index.ts:477-533` | **experimental** | They were exported for the adoption work and `buzz-school`'s stopgap (`ROADMAP.md:85` replaces its copies of `prorationPair`/`raiseUnits`). A caller using `handleStripeEvent` needs none. Promise only `prorationPair` and `raiseUnits` if `buzz-school` really calls them; mark the rest internal |
| **Stripe normalizer:** `normalize`, `describeNormalizeError`, `mappingFor`, `mappingLabels`, `resolveLines`, `resolveInvoice`, `resolveSubscriptionPlan`, `redactPersonal`, `MAPPINGS` | `index.ts:629-677` | **internal** | The mapping files (`schema/mapping/*.v1.json`) are the contract with Stripe's payloads, tied to API version `2025-10-29.clover`; the functions around them are plumbing. Keep out of 1.0 |
| **Rows and revisions:** `ROW_TABLES`, `GRANTS_TABLE`, `GRANTS_ROW_ID`, `EMPTY_GRANTS_STATE`, `grantsFromRows`, `grantsRow`, `StaleRevision`, `subjectKey`, `assertRevision`, `rowsFromState`, `stateFromRows`, `subjectFromRows`, `rowChangesFromMutation`, `applyRowChanges`, `GrantsState` | `index.ts:680-748` | **stable**; `GrantsState` is stored JSON | The persisted shape is the promise: optional keys only, an old state loads and saves byte for byte (`tests/billing-state-compat.test.ts`). `subjectKey` is the key format `school\|env\|customer`: stable |
| `grantsStateFromCallerRows` | `index.ts:727`, `src/billing/adopt.ts` | **experimental**, transitional | The import of the family service's old lots; a deprecation candidate once all members have moved (`ROADMAP.md:71-73` decisions are open) |
| **Engine:** `runEngineCommand`, `runOnState`, `mutationToEvents`, `commandTypes`, `lapsedRows`, `lapseEvent`, `lapseAlertEvents` | `index.ts:226-330` | **experimental** | Shapes belong to the forked engine. `ledgerEvent`, `deterministicUlid` and `validateEvent` (below) are separate and stable |
| **Events and validation:** `ledgerEvent`, `deterministicUlid`, `validateEvent`, `AtmEvent`, `AtmEventType` | `index.ts:257`, `:332`, `:339` | **stable** after the enum policy of 1b | `AtmEventType` is a closed union: adding a member breaks an exhaustive `switch`. State in the notes that new members arrive in minors |
| **Reading and reports:** `readEvents`, `buildJournal`, `journalMonth`, `reportMonth`, `REPORT_NAMES`, `HledgerError`, `shareStatement`, `formatShareStatement`, `balancesOf`, `reconcile`, `ReconcileResult`, `ReportRun`, `JournalRun` | `index.ts:339-425`, `:1100-1160` | **stable** functions; result types **additive only** | Result objects already grew (`ReconcileResult.feeUnknown` in #105, `ReportRun.feeUnknown`); `UPGRADING.md` records that a caller comparing the whole object with `toEqual` broke. Say so: results gain fields |
| `replayEvents`, `ReplayError`, `ReplayGapError`, `simulate`, `simulateFromInputs`, `replayInputs`, `InputsSimulateError` | `index.ts:343-390` | **experimental** | `replayEvents` rejects some out-of-order handler logs (about 1 in 135 seeded histories, `ROADMAP.md:110`); `simulate*` result shapes (`notReplayable` reasons, `baseline.carriedPayments`) are new and heuristic |
| **Small helpers the CLI uses:** `canonicalize`, `localDate`, `decimalToUnits`, `duckdbDdl`, `sha256Hex`, `utf8`, `identify` | `index.ts:1158-1175`, `:772-778` | **internal** | Added in 0.9.0 because "the CLI uses them and a library caller needs them too". Cheap to keep, but then they are promised; recommend not |
| **Object store:** `Store` (type), `StoreError` and its subclasses (`AlreadyExists`, `Stale`, `NotFound`, `Transient`, `ShaMismatch`, `Conflict`, `Unsupported`), `FolderStore`, `putOnce`, `replaceIfMatch` | `index.ts:750-799` | **stable** (`Store` interface and the 412 rules are what both servers were tested against) | |
| `R2Store` | `index.ts:799` | **experimental** until the contract suite has run on R2 (B4) | Promise it only after B4; the 2026-11-05 manual probe found R2 ignores `If-Match` on DELETE (`docs/log-and-r2.md`) |
| **The handler:** `HANDLER_DDL`, `migrateHandlerSchema`, `handleStripeWebhook`, `verifyStripeSignature`, `WebhookDeps/Request/Response/Outcome`, `SqlDatabase` | `index.ts:801-834` | **stable** after the freeze of 1c and 1d | `signStripePayload` (`index.ts:821`) is a test helper: **internal** |
| **Outbox and recorders:** `appendToOutbox`, `shipOutbox`, `outboxStatus`, `recordEngineCommand`, `recordLapse` | `index.ts:967-1017`, `:1178` | `appendToOutbox`, `shipOutbox`, `outboxStatus`: **stable**. `recordEngineCommand`, `recordLapse`: **experimental** | The recorders are not called by the family service yet (`ROADMAP.md:133`); `planOutbox` is **internal** |
| **Stored inputs:** `recordInput`, `inputCauseId`, `normalizeStripeEvent`, `eraseStoredInputs`, `inputsStatus`, `readInputs`, `sqliteInputsSource`, `shipInputs`, `settleInputErasures`, `inputsShipStatus`, `storeInputsSource`, `folderInputsSource` | `index.ts:836-965` | **experimental** | Built in #95 to #97 (this release cycle), no consumer; the table set (`atm_event_inputs` and three) is additive and can still change. `planInputs`, `inputObjectKey`, `inputOrderGaps` are **internal** |
| **Bookings and codes:** `validateBilling`, `quoteBooking`, `holdBooking`, `confirmBooking`, `releaseBooking`, `cancelBooking`, `noShowBooking`, `expiredHolds`, `settleExpiredHold`, `bookingCheckoutParams`, `createSessionGiftCode`, `redeemSessionGiftCode`, `dollarGiftOps` | `index.ts:1019-1099` | **experimental** | Released in 0.8.0 and never called by `buzz-school` (`ROADMAP.md:79-80`); known limits in `ROADMAP.md:88-93` (booking ids unique per school and env, no booking index in the reference handler, fixtures are `stripe trigger` plus metadata). Do not freeze what no consumer has used |
| **Scenario tooling:** `loadScenarioBundle(s)`, `canonicalDeliveries/Mutations/Outbox/LedgerTree/Journal/Reports/Kpis/Reconcile` | `index.ts:1184-1239` | **experimental** | Conformance tooling for a consumer; the hash checkpoints H1 to H8 pin canonical forms, so changing a canonical form changes every bundle's hashes (`docs/scenario-bundles.md`). Useful to promise as a test kit, not as API |
| **`atm/worker`:** `R2BindingStore`, `readEventsFromStore`, `membersOf`, `memberSummary`, `buildViews`, `writeViews`, `readViewsFromStore`, `eventsAsOf`, `manifestKey`, `memberIndexKey`, `memberViewKey`, `memberViewName` | `src/worker.ts`, `package.json:13-17` | **experimental**, and **not in the tarball** | The ledger admin UI is the only consumer, in this repo's design (`plans/ledger-ui/`). Either pack `dist/worker.*` and add the `./worker` export to `publishManifest` and `PACKAGE_FILES` (then `tests/dist.test.ts` and `tests/release.test.ts` change), or say in the notes that `atm/worker` is a workspace-only entry. Needs `nodejs_compat` (`README.md:73`) and bundles to about 2.1 MB because the engine imports `@autumn/shared` |

Delivery of the CLI: the tarball holds the library only (`README.md:344`); `atm journal|report|ship|reconcile|simulate` run from a checkout (`bun packages/atm/src/bin.ts`). `dist/atm.js` is built but not released. 1e below is therefore a promise about a checkout, not about a download.

### 1b. Event envelope, payload schemas, and the closed event-type enum

What is fixed: `schema/envelope.v1.json` has `v: const 1`, `additionalProperties: false` at the top level (`:6`), required `v, id, school, source, event_type, event_time, ingest_time, date, tz, key, labels, idem, text, postings, payload`, and `event_type` as an enum of 31 values (`:42-72`). There are 31 payload schemas in `schema/payload/`, none with `additionalProperties: false`.

| Part | Verdict | Why |
|---|---|---|
| Envelope fields and meaning (`id` ULID whose time is `event_time`, `date` is `event_time` in `tz`, `idem` unique per school, postings none or at least two and sum to zero per commodity, USD has 2 places and credits 0) | **stable** | Checked by `validateEvent` (`src/ledger/validate.ts:71-150`) and by hledger. A new envelope field is a `v: 2` |
| Account names (section 1g) | **stable** | Reports and the KPIs read them |
| Payload fields that exist | **stable** | |
| New **optional** payload fields | allowed in 1.x | Payload schemas do not forbid extras; `payout.paid.failed` (#104), `payment.succeeded.booking/session/payment_intent` (0.9.0) were added this way |
| Extending a payload **enum** (`money.skipped.kind` gained `"booking"` in 0.9.0 and `"dispute"` before it; `reason` is `["non_usd"]`) | **breaking for strict validators**; not allowed in 1.x without the policy below | Same failure as a new event type |
| A new **event type** | the problem this section is about | |
| The 31 types, of which `share.charged`, `referral.qualified`, `referral.rewarded`, `fundraise.received`, `fundraise.paid_out`, `policy.published`, `plan.attached` have a posting rule in `src/ledger/postings.ts` and no producer in `src/` | **experimental** | 1.0 would freeze their payload schemas before anyone has emitted one. Mark them reserved in the notes (a producer may still change the payload) |

**What the closed enum really breaks (measured, not assumed).** `UPGRADING.md` (0.8.0, 0.9.0, "Unreleased") says that every new type "makes an older log reader reject the log". I put an event with an unknown `event_type` and no postings into a copy of `fixtures/vibes-year` and ran the 0.9.x readers on it:

- `validateEvent` returns `ok: false` with `/event_type must be equal to one of the allowed values` (`src/ledger/validate.ts:74`: the Ajv envelope check).
- `readEvents` (`src/ledger/files.ts:40`), `readEventsFromStore` (`src/ledger/read.ts:136`), `buildJournal` and `replayEvents` **accept it**: none of them calls `validateEvent` (`grep` finds no caller in `src/` outside the definition), and an event with balanced postings is journaled by the generic posting path. The DuckDB DDL has `event_type VARCHAR` with no enum (`schema/duckdb/envelope.v1.sql:7`).
- So the log is refused only by (1) `validateEvent`, (2) any outside validator pinned to a copy of `envelope.v1.json` (the schema's `$id` is `https://b4uni.com/_schema/envelope.v1.json`, published; a consumer could be validating against it and atm cannot see that), and (3) a reader that switches exhaustively on `AtmEventType`.
- What an old reader gets **wrong** without refusing is the real hazard, and it is semantic: #104's `payout.failed` is a valid `payout.paid` (`failed: true`), so an old `reconcile` counts it as a payout and reports `duplicate_in_log` and `missing_in_stripe` (`UPGRADING.md`, "A payout that fails ..." item 4). #68 `money.skipped`, #104, D1 option B and the share events all met this wall.

**Recommended 1.0 policy ("ignore what you do not know, and say what you changed").**

1. **Readers must ignore unknown event types** (and unknown payload fields), keep their postings in the journal if present, and not count them in anything they do not understand. This is already how `readEvents`, `buildJournal` and `replayEvents` behave; 1.0 makes it a promise and tests it.
2. **`validateEvent` stops refusing an unknown type by default.** An unknown type passes the envelope check (every other rule, balanced postings, id time, date, still applies) and the result gains `warnings: [{ path: "/event_type", message: "unknown event type; payload not checked" }]`. A `strict: true` option keeps today's behaviour for atm's own writers and tests. This needs: `schema/envelope.v1.json` `event_type` changed from the 31-value enum to `{ "type": "string", "pattern": "^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$" }` plus a separate generated `schema/event-types.v1.json` that lists the known ones (so the enum stays machine-readable); `schema/build.ts` and `src/ledger/schemas.ts` regenerated; `src/ledger/validate.ts` (look the payload schema up, skip when absent); `AtmValidation` (`src/types.ts:407`) gains an optional `warnings` on the `ok: true` arm (additive); `tests/schema.test.ts` and the DuckDB DDL (no change, already a VARCHAR). **This edits a published `v1` schema, so it must land before 1.0.0**: after 1.0 the envelope is frozen and any outside validator holding the old enum can never be told.
3. **A new type, or a new value in a payload enum, ships only in a minor release, never in a patch, with an `UPGRADING.md` item headed "upgrade readers first"**, and **is produced only after an explicit act of the operator** where it changes how existing totals read: subscribing the endpoint to a new Stripe event (as `payout.failed`), or setting a policy field (as `revenueShare`). The handler does not start emitting a new type on upgrade alone.
4. **A change that would make an existing type mean something different is not additive** and waits for 2.0 (or a new type). The `payout.failed`-reuses-`payout.paid` choice (`ROADMAP.md:129`) is the example to avoid: a reversal that old readers count as a payout. Decide before 1.0 whether to keep it (it makes `reconcile` and the mart count `failed: true` rows differently, and that is then the contract) or give the reversal its own type now, while the enum is still free to change.
5. **Not recommended:** a versioned enum with a compatibility window (`event_types_v: 3`). It needs a negotiation channel between writer and reader that does not exist (the reader is whoever opens the folder), and the log has no header.

**Also decide in this section:** `payout.paid.failed`, `refund`-by-event-id vs refund id (`ROADMAP.md:135`), and `payment.succeeded` lacking `interval` and `period_end` (`ROADMAP.md:100`, MRR/ARR/logo churn not computable). Adding optional labels later is allowed; if the owner wants MRR in the first 1.x, put the labels in before 1.0, since old payments will lack them forever.

### 1c. Handler DDL and migrations

| Item | Evidence | Verdict | Recommendation |
|---|---|---|---|
| `HANDLER_DDL` tables: `atm_subjects`, `atm_rows`, `atm_event_claims`, `atm_invoice_index`, `atm_payment_index`, `ledger_outbox` (keys carry `env`), `atm_event_inputs`, `atm_input_contexts`, `atm_input_seeds`, `atm_input_erasures` | `src/handler/schema.ts:61-175` | table and column names and primary keys: **stable** for the first six; the four stored-input tables **experimental** | All statements are `IF NOT EXISTS`, so an existing table is never altered |
| `migrateHandlerSchema` | `src/handler/schema.ts:345` | **stable as a one-time rebuild for pre-0.8.0 databases**; no more steps | It detects an old shape by introspection and rebuilds four tables in one transaction. There is **no schema version marker** (`grep user_version\|schema_version` finds nothing). So 1.0 cannot say "migrate from 1.x.y to 1.x.z"; it can only say "tables are never altered in 1.x" |
| Promise for 1.x | | **additive only: new tables with `IF NOT EXISTS`; no new column on an existing table, no key change, no trigger, no `STRICT`, no generated column** | A new column would need `ALTER TABLE`, which `IF NOT EXISTS` DDL does not do, and the code has no migration framework. State this limit in the notes, or add `PRAGMA user_version` plus an ordered migration list before 1.0 (small; recommended, because the first 1.x that needs a column otherwise forces a 2.0) |
| Litestream and `buzz-school` constraints | `docs/log-and-r2.md` ("Env on the handler's tables"); `UPGRADING.md` stored-inputs item 1 | **stable constraints** | The schema has no trigger and no `RAISE` (Litestream's bundled SQLite must read it), the rebuild drops no table another refers to by foreign key (none does), a table with `AUTOINCREMENT` keeps `sqlite_sequence` (check the restore keeps it), `migrateHandlerSchema` is run with the handler stopped and after a snapshot. These were read from `buzz-school`'s tests, not run against Litestream (`ROADMAP.md:134`) |
| A handler on a database without the new tables | `UPGRADING.md` | stable behaviour | It stops with an error naming `HANDLER_DDL` before touching anything (a 5xx; Stripe retries) |

### 1d. The webhook answer contract

`WebhookOutcome` (`src/types.ts:2833`) and the table in `src/handler/stripe-webhook.ts:97-124`. A caller (and `buzz-school`'s alerting) will switch on these; the set must be closed per major, and it is *not* mechanically closed today (the union gained `non_usd` in 0.8.0).

| Status | `outcome` | `reason` / body fields | Retry by Stripe? |
|---|---|---|---|
| 200 | `applied` | `events`, `wroteRows`; `feeUnknown?: string[]` when a payment is booked gross (#105) | no |
| 200 | `non_usd` | `skipped: string[]` (`<kind> <id> <amount> <currency>`) | no |
| 200 | `duplicate`, `ignored` | `ignored`: an unmapped type, or an invoice/subscription event with no family metadata (recorded done) | no |
| 400 | `bad_request` | | yes |
| 401 | `bad_signature` | `reason` | yes |
| 409 | `busy`, `unmatched_payment`, `unmatched_invoice`, `stale_revision`, `refused` (`unmatched_invoice`, `unknown_subscription`) | `unmatched_payment` also answers a `payout.failed` whose `payout.paid` is not booked | yes, up to 3 days |
| 422 | `refused` (`unmatched_line`, `missing_metadata`, `addon_only_subscription`, `tier_on_other_subscription`, `unknown_mapping`, `bad_event`, `rejected`), `unknown_school`, `school_mismatch`, `livemode_mismatch`, `ambiguous_payment` | `reason`, `message` | yes; a human fixes it, then re-sends |

Verdict: **stable** for the status-to-outcome mapping and for the existing `reason` strings; **experimental** for `message` text (callers must not match it; `UPGRADING.md` already told them `toContain`), and the `body` may gain fields (`skipped`, `feeUnknown` were added in 0.8.0 and #105). Rules for 1.x: a new `outcome` value or a new `reason` is a minor with an `UPGRADING.md` item (the caller's switch needs a default branch, and the notes say so); no existing refusal turns into a 200 or the reverse. Known ambiguity to settle before 1.0: a rare 409/422 split is judged "for the owner to review" in the file header (`stripe-webhook.ts` comment), including 409 for a refund of a charge that is not ours (retries for three days).

### 1e. CLI commands, flags, exit codes, `--json` shapes

Commands in `src/cli.ts` and `src/scenario/cli.ts`: `run`, `journal`, `report`, `share`, `ship`, `inputs ship`, `reconcile`, `simulate`, `scenarios list|describe|schema|check|parity|kpis` (alias `scenario`). Exit codes: `0` done; `1` a conflict (`ship`, `inputs ship`) or differences found (`reconcile`, `scenarios check/parity`, `simulate`); `2` any other error, a usage error, or a baseline that does not equal the log (`simulate --inputs` without `--allow-baseline-drift`) (`src/cli.ts:60-64`, `exitTwoOnUsageError`). With `--json`, an error prints `{"ok":false,"error":"..."}` on stdout (`src/cli.ts:44-60`).

| Part | Verdict | Recommendation |
|---|---|---|
| Names and required flags of `journal`, `report`, `share`, `ship`, `reconcile`, `inputs ship` (`--root`, `--school`, `--month`, `--db`, `--env`, `--stripe`, `--json`, `--report`, `--format table\|csv`) | **stable** | These are in cron lines in the README recipe (`README.md:369`) |
| Exit codes 0/1/2 and the error JSON | **stable** | The alerting contract |
| `--json` shapes of `ship`, `reconcile`, `share`, `inputs ship` | **stable, additive only** | `reconcile` already grew `feeUnknown` |
| `simulate` (library-backed what-if; `--inputs`, `--allow-baseline-drift`, `--profile`, `--scenario`), `scenarios *`, `run` | **experimental** | Result schemas are new; `run` is a dev tool for the engine |
| Where it runs | | Only from a checkout (`bun packages/atm/src/bin.ts ...`); `report` needs hledger installed and exits 2 without (`ROADMAP.md:142`). A 1.0 CLI promise must say "from the repo at tag `atm-v1.0.0`" or the release must also ship `dist/atm.js` (it is built, `release.ts` does not pack it) |

### 1f. Log and R2 layout

| Part | Evidence | Verdict | Recommendation |
|---|---|---|---|
| Events: `schools/<school>/events/date=<YYYY-MM-DD>/batch-<first event id>-<16 hex of sha256>.jsonl`, one JSON event per line, canonical serialization, create-only put (`If-None-Match: *`) | `src/ledger/ship.ts:90`, `docs/log-and-r2.md` | **stable** | The name is derived from the content; a rerun produces the same key. Readers sort by `id` and drop a repeated `idem` (first by id wins), `files.ts:40-58`, `read.ts:136` |
| `day.jsonl` (the combine) and `late-*` | `ship.ts:22`, `read.ts:16-17`; `ROADMAP.md:119` | **reserved, not built** | Reader semantics are fixed (only `late-*` beside a `day.jsonl`); the shipper reports a conflict instead of writing next to one. Promise only the reader rule |
| Overlapping batches from two shippers or a crash between put and mark | `ROADMAP.md:120` | **stable**: the journal is right, the files may hold an event twice until a combine | |
| Inputs: `schools/<school>/inputs/<env>/date=<YYYY-MM-DD>/batch-<12-digit order>-<16 hex>.jsonl`, plus contexts and seeds, under a prefix `events/` readers never list | `src/ledger/ship-inputs.ts:49-83` | **experimental** | Erasure rewrites a batch under a new key and deletes the old object; this needs the bucket's versioning off for `inputs/` (a precondition atm cannot check, `UPGRADING.md`) |
| The log has **no env** | `ROADMAP.md:155`, `docs/log-and-r2.md` | **a gap to close before freezing the path** | A school's test and live events share `schools/<id>/events/`. After 1.0 putting an env into the path changes every reader. Options in the doc: (a) one database and shipper per env (the documented workaround), (b) `atm ship --env`, (c) env in the path. Recommend (c) or (b) decided before 1.0; (a) is fine if the notes forbid sharing one folder between envs |
| Signed monthly manifest (Ed25519, `If-Match`) | `ROADMAP.md:121` | **not built**; do not mention in the promises | |
| Backup of the folder | `ROADMAP.md:141` | operator duty | |

### 1g. hledger reports, CSV goldens, account names

`REPORT_NAMES` is `income-statement`, `balance-sheet`, `credits` (`src/ledger/report.ts:13-17`) over hledger commands `is`, `bs`, `bal credits: --flat` after `-f main.journal`; formats `table` and `csv`. Goldens in `tests/golden/reports/` (`income-statement-monthly.csv`, `balance-sheet.csv`, `credits.csv`, `refunds-register.csv`) are the output of **hledger 1.52.1** (`ROADMAP.md:142`; the CI workflow pins it).

| Part | Verdict | Recommendation |
|---|---|---|
| Account names the postings use: `assets:stripe`, `assets:clearing:stripe-payouts`, `assets:clearing:b4uni-payments`, `assets:clearing:zeffy`, `assets:clearing:zeffy-payouts`, `income:billing:<kind>` (`membership:<tier>`, `booking`, `refunds`, `other`), `income:fundraising:<campaign>`, `expenses:billing:stripe-fees`, `expenses:billing:disputes`, `expenses:billing:dispute-fees`, `liabilities:b4uni`, `credits:avail\|held\|issued\|spent\|expired\|forfeited\|adjust:...` | **stable** | Renaming an account re-bases every report and the KPI spec. New accounts may be added |
| The hledger CSV shapes | **stable only as "equal to hledger 1.52.1's output for the same journal"** | The bytes belong to hledger, not atm. Promise the journal (`ledger/*.journal`), not the CSV text; the golden tests pin 1.52.1. A different hledger can change a header or rounding and break the golden without atm changing |
| The journal text (`buildJournal`) | **stable** | `tests/golden/journal` |
| The KPI spec `kpis/school.v1.json` and `kpis.json` | **experimental** | Spec v3 suppression rules and the cash-basis limits (MRR, ARR, logo churn not computable, `ROADMAP.md:100`) are not final |
| Taxes, deferred revenue, a non-USD books | **not promised** | Cash basis, USD only, gross of tax (`ROADMAP.md:130`, `:137`, `:138`). The notes must say it in one sentence: **the books are a cash-basis USD ledger, not an accrual one** |

## 2. 1.0 blockers and not-blockers

**Definitions.** BLOCKER: a 1.0 promise would be false or a fix would break callers once the promise exists. SHOULD: fix soon, and document it as a known limit in the 1.0 notes. LATER: independent of the surface; ship in a 1.x.

### 2.1 The specific assessments

| Item | Class | Why (one line) |
|---|---|---|
| **B1. `atm/worker` not in the tarball** (`release.ts:43-67`) | BLOCKER | The only consumer of the worker subpath (the ledger UI) cannot install it from the release; either pack it or declare it workspace-only before the surface is frozen |
| **B2. Closed event-type enum / `validateEvent` policy** (section 1b) | BLOCKER | Editing a published v1 schema is only possible before the freeze; every later money event (D1 option B, share, referrals) hits it |
| **B3. `export type *` of 255 types and the required-field policy for inputs** (section 1a) | BLOCKER | After 1.0 renaming any of them is a major; `BillingPolicy` already broke callers twice by adding required keys |
| **B4. R2 never run: `R2Store`, `atm ship`, `atm inputs ship`, the contract suite** (`ROADMAP.md:70`, `:107`, `:118`) | BLOCKER for promising R2; SHOULD if 1.0 promises the folder only | The shipper to a bucket is the point of the log path; only a manual `DELETE`/`If-Match` probe was done on staging (2026-11-05). Run the 25 skipped contract tests against the staging bucket, and `atm ship`/`inputs ship` against it (the Store contract did pass once on SeaweedFS 4.48, `CHANGELOG.md`, "Before 0.3.0"; the shipper and `inputs ship` have not run on either), before the notes say "ships to R2". The `If-Match`-on-DELETE finding already shows R2 differs from the mock |
| **B5. Contract suite under Node** (`ROADMAP.md:70`) | SHOULD | The release bundle is `target: node` and the README promises Node for the library; the tests only ran on Bun. Run the library test subset with Node once (the dist test loads `dist/index.js`) or state "tested on Bun 1.4.4 only" |
| **B6. `buzz-school` does not call the handler, shipper or recorders** (`ROADMAP.md:78`, `:134`, `:133`; it still pins 0.4.0, `:84`) | BLOCKER for calling the integration API stable | The API is "not proven by its consumer". Minimum: `buzz-school` staging calls `handleStripeWebhook` + `shipOutbox` for one school for a month, and the pin moves to the 1.0.0 candidate. Without it, mark the handler/shipper/recorders experimental and call the release 0.10.0 after all (the owner decided otherwise) |
| **B7. Real-data check** (`ROADMAP.md:108`, `:139`, `:72`): `atm inputs ship` + `atm simulate --inputs` + reports on a copy of a real school, and the import on a copy of the family service database | BLOCKER | Everything ran on fixtures and one sandbox account; D1 to D6 were found by a matrix, not by data. One real month compared with Stripe's dashboard is the cheapest test of the whole claim |
| **B8. D2: `charge.refunded` without `previous_attributes` books the running total** (`src/billing/money.ts:310`, `:345`) | BLOCKER (small) | Money is wrong by the earlier refunds if Stripe ever omits the field (latent; not known). Fix: with no `previous_attributes` the handler has the charge's refunded total and the books' running total for the payment (`refunded` on the payment record): book `amount_refunded - alreadyBooked`; or refuse 422. It changes booked amounts only in the case that is wrong today |
| **D6: add-on revenue booked to the tier's income account** (`money.ts:105`, `:202`) | BLOCKER if reports by product are promised; else SHOULD | A `payment.succeeded` has one income posting. Splitting it (several income postings, one per line) is additive to the payload but changes the postings of every renewal with an add-on, so the goldens and the KPI hashes of those cases change. Do it before 1.0 or write "revenue by product is exact only for single-product invoices" |
| **Reclass on retry** (`ROADMAP.md:144`) | SHOULD | A refused invoice books its payment as `income:billing:other` and keeps it there. Needs a reclass event (a new type: B2 first). Document the manual fix |
| **D1 and option B: booking a late fee** (`ROADMAP.md:127-128`) | SHOULD | The loud signal is built; the fix needs a `payment.fee_adjusted` type (B2 first) or a 5xx on a missing fee. Recommendation stands: wire `paymentFee` in `buzz-school` (part of B6), then there is nothing to reclass |
| **D5: `reconcile` on a shared Stripe account** (`reconcile.ts:454`) | SHOULD | Books are right; reconcile is noisy. The handler's header already says one account per school; put it in the 1.0 notes as a requirement |
| **`payout.failed` reusing `payout.paid`** (`ROADMAP.md:129`) | BLOCKER to decide, not to build | Whichever is chosen is frozen at 1.0 (section 1b, point 4). The mart's `fact_payouts` (`plans/ledger-ui/design/mart/README.md`) must net or filter on `failed`; if the UI is built against the current shape, keep it |
| **The stored-inputs "carried payment" workaround** (`ROADMAP.md:103`, `simulate-inputs.ts:266`, `:554`) | LATER | It is inside `simulate --inputs`, which is experimental; the fix (keep the refusal's context in the stored inputs) adds a column or row to tables that are experimental anyway |
| **`booking_writes` conservatism** (`ROADMAP.md:109`, `simulate-inputs.ts:632`) | LATER | It halts a holder's what-if, never a booked amount; costs coverage, not correctness |
| **Skipped tests that need credentials or duckdb** | see B4 and the State section | The R2/SeaweedFS 25 are B4. The hledger/duckdb ones run locally and in CI for hledger; nothing runs duckdb in CI (`ROADMAP.md:140`): SHOULD add it, it is the third KPI channel |
| **Non-additive items in `UPGRADING.md`** | see 2.3 | None blocks 1.0 by itself; 1.0.0 is the moment to make them one section ("From 0.x to 1.0") so a caller reads it once |

### 2.2 Every unchecked `ROADMAP.md` line

Numbers are the lines of `ROADMAP.md` at `fed0d6c08`. "Owner" means it needs an owner decision (listed again in section 4).

| Lines | What | Class | Justification |
|---|---|---|---|
| 45 | A lost dispute reverses no revenue share | LATER | Opt-in feature, per-school; a rule can be added without changing existing events |
| 46, 47, 149 | Collecting statements; Stripe Connect | LATER | Business model, outside the library surface |
| 58 | `policy.upgradeGrant`: the invoice of a plan switch prorates over the old cycle (owner) | SHOULD | Changes credits granted; the policy value already exists, so a new value is additive. Decide the default before 1.0, since changing a default later changes callers' credits |
| 59 | Raise baseline: out-of-order raise invoices; a refund of a raise does not roll `state.quantity` back | SHOULD | Edge cases with a stated limit; document |
| 60 | Open findings of the review of #22-#24 | SHOULD | Mixed; none changes a promised shape (`docs/review-findings.md`) |
| 64, 66 | Several subscriptions on one customer; add-on-only subscription refused (422) | SHOULD | The refusal is the contract; supporting it later is additive. The three sub-findings (manual/threshold invoice drops its add-on, a second purchase of a held add-on grants nothing, update-before-create answers 422 not 409) are wrong answers a school can hit: fix or document |
| 67 | A renewal for a holder in overage is refused 422 | SHOULD | Document "do not set `overage_allowed`" in the notes; a booking rule needs a new event type (B2) |
| 68 | `portalConfigOf` key order | SHOULD | Harmless (one extra configuration) but settle before freezing the function |
| 69 | The atm test workflow's runner | LATER | CI plumbing; the owner's rule is local gates |
| 70 | Contract suite under Node and against staging R2 | B4, B5 | above |
| 71 | Owner decisions: rollover cap, rollover month calendar, lapsed cycle not renewed, yearly grant on a monthly plan, `invoiceIds` before the import | SHOULD (owner) | They change credits for adopted members; only matter if the import is used (B6/B7). Decide before the first member moves, not before the tag |
| 72, 73 | Try the import on a copy; differences the import cannot hide | BLOCKER only through B7; else SHOULD | Part of the real-data check |
| 74 | Receipt/Checkout verified on a real connected account | LATER | Stripe behaviour check, not a surface |
| 75 | `receiptOf` (itemised receipt) | LATER (owner, Tax Commission) | Not built; do not promise it |
| 78 | Family service moves onto atm's handler | B6 | |
| 79, 80 | Booking and code wiring in `buzz-school` | LATER (SHOULD to keep bookings experimental) | Bookings stay experimental until used |
| 81 | The light-bed resource | LATER | |
| 82 | Webhook endpoints with `api_version` `2025-10-29.clover` | SHOULD | The mapping files pin one version per type; a wrong version is a 422 forever (`describeNormalizeError`). Put it in the integration checklist |
| 83 | "N visits left" notices from `credit.low`/`credit.depleted` | LATER | |
| 84, 85 | Pin the latest release; replace the copies of atm's rules | B6 | |
| 88 | The reference handler has no booking index | SHOULD | Stated limit: bookings go through `handleStripeEvent` |
| 89 | Booking fixtures are not from `bookingCheckoutParams` | SHOULD | Part of why bookings stay experimental |
| 90 | Asks from the ledger UI session (labels, `cause` chain, admin source, gift liability account) | LATER, but each is a new label/account, additive | Depends on the cash-basis decision |
| 91, 92, 93 | Booking ids unique per school and env; coupon id edge cases; member code expiry unchecked | SHOULD | Document as limits; the first (idem made from the booking id alone) loses a `credit.held` silently, so the notes must say "use a UUID" |
| 94, 167 | Referral codes | LATER | Reserved event types; do not promise |
| 100 | KPIs the cash-basis books cannot carry (MRR, ARR, churn) | SHOULD (owner) | Adding `interval` and `period_end` labels to `payment.succeeded` is additive but old payments never get them: decide before 1.0 if MRR is wanted |
| 101 | `atm billing simulate` | LATER | Superseded by `atm simulate` (built); delete the line |
| 103 to 106, 109, 110 | Stored-inputs follow-ups (carried payment, `candidate.priceIds`, prune, `startsAt`, `booking_writes`, `replayEvents` out-of-order 1 in 135) | LATER; the `replayEvents` one SHOULD | All inside experimental surfaces; the 1-in-135 case means `replayEvents` can throw on a valid handler log: fix or document |
| 107, 118 | R2 path of inputs ship / `R2Store` never run; FolderStore `.atm-tmp-*` sweep | B4; the sweep LATER | |
| 108, 139 | Real-data check | B7 | |
| 113, 114, 115 | `correction` event with `supersedes`; late-event grace window; document the backfill effect | LATER (113 needs B2) | |
| 119 | `day.jsonl` combine and `late-*` | LATER | Reader rule is fixed; no producer |
| 120 | Overlapping batches | LATER | Journal is right |
| 121 | Signed monthly manifest | LATER | Do not promise |
| 122 | Replace the PyPI SeaweedFS wheel | LATER | Only matters when CI uses SeaweedFS (part of B4) |
| 123 | A Worker version of the handler | LATER | The read side is done (#98, #99); the write side needs Ajv-free validation |
| 127, 128 | D1 and option B | SHOULD | above |
| 129 | `payout.failed` design | BLOCKER to decide | above |
| 130 | Non-USD books; tax separation | LATER | Cash basis, USD; stated |
| 131 | D2 | BLOCKER (B8) | above |
| 133, 134 | Family service must call recorders, handler, shipper | B6 | |
| 135 | Handler `payment.refunded` carries the Stripe event id while reconcile matched the refund id (#52 says it now pairs by payment intent or charge and amount) | SHOULD | "confirm and close": a one-line check against a handler-made log, then delete the line |
| 136 | The `stripe` CLI commands in the README were not run | SHOULD | The reconcile input contract is the `stripe ... list` output; run it once (B7) |
| 137 | Revenue booked when the invoice is paid; no deferred revenue (owner) | SHOULD (owner) | Cash basis is a valid 1.0 if stated plainly. Switching to accrual later changes every report: the choice is frozen at 1.0 in effect |
| 138 | Taxes absent | LATER | Stated |
| 140 | Nothing runs duckdb in CI | SHOULD | |
| 141 | The shipped folder needs a backup | LATER (operator duty) | Document |
| 142 | hledger version | SHOULD | The CSV goldens depend on 1.52.1; state the version in the notes |
| 144, 145, 146 | Reclass on retry, D5, D6 | above | |
| 152 | Parquet on R2 | LATER | |
| 155 | A metadata prefix in the policy instead of `b4u_`; menu limits in the policy; generic `holderId` | SHOULD (owner) | `b4u_school`, `family_id` are in every fixture and mapping and in Stripe metadata on live objects; renaming after 1.0 breaks real data. Decide: keep `b4u_*`/`family_id` as the 1.0 names and say so, or add the policy now |
| 156 | The log does not separate envs | BLOCKER to decide (owner) | Path change is a reader change (section 1f) |
| 160, 161 | Split `grants.ts`; menu-level policy overrides | LATER | Internal / additive |
| 164 | A reference deliverer for outbox webhooks | LATER | |
| 168 | A nightly reconciliation query | LATER | `atm reconcile` exists |
| 186 | Before selling atm as a hosted service | LATER | Not a library concern |

### 2.3 Non-additive items in `UPGRADING.md` (what a 0.9 caller sees)

| Item (`UPGRADING.md`) | Needs |
|---|---|
| A refused paid invoice books a `payment.succeeded` (`On dev since 0.9.0`) | One "From 0.x" entry: a caller asserting that a 422 writes nothing is wrong |
| `payout.failed` reversal; subscribe to `payout.failed`; upgrade `reconcile` first | Same entry; and the B2 decision |
| `feeUnknown` in the `applied` body and `ReconcileResult`/`ReportRun` fields | Result types gain fields |
| A paid booking's payment and refund make money lines (0.9.0); `reconcile` needs `payment_intents` for such a school | In the entry |
| `BillingPolicy` gains `revenueShare` (literal needs `revenueShare: null`) | Type-break precedent, B3 |
| New event types make an older reader reject the log (0.8.0, 0.9.0) | Rewritten by the B2 policy |
| `non_usd` outcome, `warn` dependency, `money.skipped` (0.8.0) | In the entry |
| `migrateHandlerSchema` required for databases from 0.6.0 and earlier (0.8.0) | Keep; the notes should say a database that has never been migrated must be migrated with the handler stopped |
| A feature id whose letters spell `USD` is refused; a tier line of another subscription is refused (0.8.0) | In the entry |
| The handler stores each input (four new tables, `HANDLER_DDL` before the handler) | Additive but a hard stop if missing |

## 3. A concrete plan to 1.0.0

Owner key: **agent** (a Claude session, code and docs in this repo), **owner** (needs a decision or an account), **buzz-school** (the family-service repo, another session).

1. **Owner decisions** (section 4). The later steps wait on O1 to O6 below. *owner*
2. **Schema and surface freeze PR** (blocks everything that changes a published shape): the event-type policy (`envelope.v1.json`, `event-types.v1.json`, `validate.ts`, `AtmValidation.warnings`, tests and schema regeneration), the named type export instead of `export type *`, `internal` tags or removal of the exports marked internal in 1a, optional-field rule for `BillingPolicy`, a handler schema version (`PRAGMA user_version` plus an ordered migration list), and the `payout.failed` decision. *agent, review: owner.*
3. **Release tarball PR:** pack `dist/worker.js` and `worker.d.ts` with the `./worker` export (or declare it workspace-only), update `PACKAGE_FILES`, `publishManifest`, `tests/dist.test.ts`, `tests/release.test.ts`, the README line; decide whether `dist/atm.js` is also an asset. *agent.*
4. **Money fixes:** D2 (B8) and, if the owner wants revenue by product, D6; goldens and the e2e matrix updated; D5 and D1 documented as requirements. *agent, review: owner.*
5. **R2 run** (B4): staging bucket variables set, `bun test tests/store-r2.test.ts` with them, SeaweedFS (`weed mini`) on a machine that has it (`tests/store-seaweedfs.test.ts`), then `atm ship` and `atm inputs ship` to the staging bucket from a copy of a handler database; close `ROADMAP.md:70, 107, 118`. The R2 token and bucket are the owner's. *owner supplies credentials, agent runs it.* In parallel, a Node run of the library subset (B5). *agent.*
6. **Real-data run** (B7): `buzz-school` copy of one school's database; `atm inputs ship`, `atm simulate --inputs`, `atm ship`, `atm journal`, `atm report`, `atm reconcile --stripe` on a month, compared with the Stripe dashboard; the import on the same copy (`ROADMAP.md:72`). Output: a short findings file in `docs/`. *owner provides the copy, agent runs it.*
7. **Consumer wiring** (B6): `buzz-school` calls `handleStripeWebhook`, `shipOutbox`, `recordEngineCommand`/`recordLapse` (or the owner declares them experimental), passes `paymentFee` and `billingKeyMode` as `env`, creates endpoints with `api_version` `2025-10-29.clover`, and moves its `bun.lock` pin to the release candidate (a prerelease tag or a commit-pinned tarball from `just release-dry`). *buzz-school.*
8. **Documentation PR:** one "Moving to 1.0 from 0.9" section in `UPGRADING.md` that merges the "Unreleased" and non-additive items (2.3) into a checklist; the "what 1.0 promises" and "experimental" lists in `README.md`; `CHANGELOG.md` "1.0.0" table; `ROADMAP.md` lines closed or rewritten; a deprecation list (see below). *agent.*
9. **Review:** an independent review of the freeze PR, the money fixes and the tarball PR (what `code-review high` was for in #22 to #24); run `just check` and `just release-dry` on the head. *owner chooses the reviewer.*
10. **Release** (below). *owner confirms, agent runs.*

**Deprecations to announce in the 1.0 notes (nothing removed before 2.0):** `grantsStateFromCallerRows` (until the import is done), every export tagged internal in 1a, `policy.memberCode` in favour of `menu.codes` (it still works, `UPGRADING.md` 0.8.0), the `export type *` wholesale surface, and `atm billing simulate` in `ROADMAP.md` (delete the line). Each gets one `UPGRADING.md` bullet with the replacement.

**PRs that belong to other sessions** and how they touch the surface (not judged here): #98 (read slice: `ledger/read`, `summary`, `views` and the member summaries: the `atm/worker` group above), #99 (the `atm/worker` subpath, Ajv-free read graph, `commodityProblems` moved to `billing/commodity.ts`: no change to `src/index.ts` values, but the tarball gap B1), #103 (scenario bundles, `atm scenario check`, `loadScenarioBundle(s)` and `canonical*` exported). All three are merged; there is nothing open that changes the surface except what step 2 and 3 above add.

### The release steps for 1.0.0 (from `docs/releasing.md`, adapted)

The release is a tarball `atm-1.0.0.tgz` on a GitHub release with tag `atm-v1.0.0`, built on the pinned bun (`packageManager`, bun 1.4.4; `release.ts` refuses another version).

1. **One release PR** to `dev` (never `main`), changes:
   1. Bump `version` in `packages/atm/package.json` from `0.9.0` to `1.0.0`. This is the only version file: `release.ts` reads it, the publish manifest copies it (`release.ts:53`), and the README text inside the tarball is generated.
   2. `bun.lock`: at the audit `bun.lock` on `dev` records the `packages/atm` workspace at **`0.9.0`** (`bun.lock:394-396`), so it needs a one-line change to `1.0.0`. (The coordinator's note expected `0.0.1`; this is what `dev` holds. If the line says something else when the PR is made, the instruction is the same.) Procedure: run `bun install` at the repo root; `git add -p bun.lock` and stage **only** the `packages/atm` `version` line; revert the rest of `bun.lock` with `git checkout -p bun.lock` or `git checkout bun.lock` after staging (a local `bun install` re-hoists unrelated packages: PR #109 was exactly that accident, `zod-validation-error` to 4.0.2, `better-auth`, `@autumn/ui`, `@autumn/vite`, `xo`; it was closed and its branch deleted); then confirm with `bun install --frozen-lockfile` on a **clean checkout** of the PR head: it must exit 0 and leave no change in `git status`. The tag-push workflow runs `bun install --frozen-lockfile` (`.github/workflows/release-atm.yml:33`), so a lockfile that does not match fails the release.
   3. `UPGRADING.md` "Moving to 1.0 from 0.9", `CHANGELOG.md` (the 1.0.0 table, with the merge commit column filled for PRs already merged), `README.md` promise and experimental lists, `ROADMAP.md` updates.
   Tooling note: the husky pre-commit hook runs `infisical scan git-changes --staged` (`.husky/pre-commit:5`) and `bun install` runs `prepare: husky`; **`/opt/homebrew/bin` must be on `PATH`** or the hook fails (`infisical` lives there). Agents' worktrees have hit this. Never `--no-verify`.
2. **Local gates on the PR head**, not Actions: from `packages/atm`, `just check` (lint, `tsc`, tests with `--timeout 60000`, build, knip) or the individual commands; `bun run schema` clean; repo-root `bun run knip`. Run the R2 suite with the staging variables set (step 5 above) so nothing is skipped for lack of credentials.
3. **Merge to `dev`** (the owner merges; agents do not). Pull `dev` so HEAD is a commit that is on `origin`.
4. **Dry run:** from `packages/atm`, `just release-dry` (= `bun ./release.ts --dry-run`). It builds into a temp directory, runs the dist checks and `tests/dist.test.ts`, stages the package, packs it and prints the sha256 and the sha512 integrity. Run it twice and compare: the same commit must give the same bytes. Check the file list printed is exactly `PACKAGE_FILES` (including `dist/worker.*` if step 3 of the plan put them in).
5. **Release:** `just release` (asks to confirm; needs a clean tree, HEAD on a branch of `origin`, and no tag or release `atm-v1.0.0`). It creates the release at HEAD. The tag-push workflow `Release atm` then runs `release --ci` on the tag and accepts the existing release when its asset is byte-for-byte what it builds.
6. **Verify the published asset:** download `https://github.com/justbry/atm/releases/download/atm-v1.0.0/atm-1.0.0.tgz` and compare its sha256 and sha512 with what the script printed (the records of 0.4.0, 0.5.0 and 0.9.0 say "checked by downloading the published asset"). Also install it in a scratch directory and import `atm` (and `atm/worker` if packed) to see the exports.
7. **Record in `CHANGELOG.md`:** tag, commit, date, tarball URL, sha256 and sha512, the bun version, and the PR table. A follow-up docs PR to `dev`.
8. **Pin in `buzz-school`:** the family service's `bun.lock` records the tarball's sha512; the pin moves from `0.4.0` to `1.0.0` in its own PR (its owner).

### What the release notes should say 1.0 promises

Proposed text, to be edited by the owner:

- **Stable (semver):** the TypeScript functions and types listed as stable in 1a; envelope v1 and the payload schemas (additive fields only; unknown event types are to be ignored by readers); the handler's `HANDLER_DDL` tables (new tables only) and the `WebhookOutcome` mapping to HTTP codes; the log path `schools/<school>/events/date=<date>/batch-*.jsonl`; the account names; the `journal`/`report`/`ship`/`reconcile` commands, flags, exit codes 0/1/2.
- **Cash basis:** the books record money when Stripe collects it; USD only (other currencies are counted, not booked); gross of tax; revenue by product is exact only if D6 was fixed; no deferred revenue.
- **Experimental (may change in a minor release):** bookings and codes, stored inputs and `simulate --inputs`, `simulate`, scenarios and bundles, the revenue-share statement, `atm/worker`, `R2Store` (until the contract run), the engine commands.
- **Requirements:** one Stripe account per school; endpoints created with API version `2025-10-29.clover`; subscribe to the listed events including `payout.failed`; pass `paymentFee` (otherwise payments book gross); booking ids are UUIDs; Bun 1.4.4 for the CLI and hledger 1.52.1 for reports; `nodejs_compat` for `atm/worker`.
- **Not in 1.0:** referral codes, receipts, Connect, deferred revenue, the signed manifest, Parquet on R2, the `day.jsonl` combine.

## 4. Owner decisions needed

Each with a recommendation. O1 to O6 block steps 2 to 4. (`D1` to `D7` elsewhere in this file are the findings of `docs/e2e-reconciliation.md`.)

| # | Decision | Recommendation |
|---|---|---|
| O1 | Event-type policy | Readers ignore unknown types; `validateEvent` warns instead of failing by default; new types only in minors with "upgrade readers first" and an operator opt-in (section 1b). Do it before 1.0 |
| O2 | `payout.failed`: keep `payout.paid` with `failed: true`, or its own type | Keep it, freeze it, and document that a reader summing `payout.paid` must skip `failed: true`. A new type now costs a payload schema and the mart, a new type later costs the policy of D1 |
| O3 | Env in the log: one database and folder per env, `atm ship --env`, or env in the path | `atm ship --env live` as the default (test rows never reach the live folder) and a hard rule in the notes that a folder holds one env; env in the path only if test books are wanted |
| O4 | Keep `b4u_*` metadata and `family_id` as the 1.0 names | Keep and document; they are on live Stripe objects. Add the policy prefix as an optional field later |
| O5 | Is "1.0.0" a stable promise for the integration API (needs B6 and B7), or for the pure library only | Smallest honest 1.0: promise the pure library, schemas, handler contract and reports, label the rest experimental, and do not tag before one real month ran (B7) and `buzz-school` staging calls the handler (B6). If that cannot happen soon, tag `1.0.0-rc.1` (O14) or keep 0.x. This is the owner's call; the numbering was decided, the readiness was not |
| O6 | Pack `atm/worker` in the tarball | Yes: the ledger UI is the reason it exists. Cost: `release.ts`, two tests and the README |
| O7 | Cash basis for 1.0 (no deferred revenue, `ROADMAP.md:137`) | Yes, and say it in the first paragraph of the notes. Accrual later is a new report set, not a change of these |
| O8 | `policy.upgradeGrant` switch-invoice default (`ROADMAP.md:58`) | Decide only if a school uses a monthly to yearly switch; otherwise keep the current default and list it as a limit |
| O9 | Rollover cap, rollover calendar, lapsed cycle, retreat, `invoiceIds` before the import (`ROADMAP.md:71`) | Decide before the first member is imported, not before the tag; if the import is not used in 1.0, mark `grantsStateFromCallerRows` deprecated |
| O10 | Finding D6 (revenue by product) before 1.0 | Fix if the ledger UI or the school's reports will show revenue by product at launch; otherwise ship with the stated limit |
| O11 | Finding D1 option B (`payment.fee_adjusted`) | Not before 1.0: wire `paymentFee` in `buzz-school` instead; adding the type later is a minor under D1 |
| O12 | Receipts (`receiptOf`), referral codes, per-subject compare-and-swap on R2, Connect | None in 1.0; list as not promised. A per-subject CAS is only needed if the handler moves off SQLite |
| O13 | Does the release also ship `dist/atm.js` | Optional; if not, say the CLI runs from the repo at the tag |
| O14 | `1.0.0-rc.1` first | Yes if O5 cannot be satisfied in one step: it lets `buzz-school` pin a candidate (plan step 7) before the final number |
