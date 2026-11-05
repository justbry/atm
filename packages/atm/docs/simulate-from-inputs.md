# Simulating the grant rules: stored inputs (design for atm 0.7.0)

Status: design only (phase 1, 2026-11-05). No code is written by this document. Two implementers share it: A builds the storage (the table, the writer, the erasure hook, the read helpers), B builds the replay and the `atm simulate --inputs` mode. The section "Interfaces" is the contract between them. The roadmap line it answers is "Simulation or what-if" in `ROADMAP.md`; the 0.6.0 command-level mode it extends is described in `README.md` ("What if (simulate)") and `src/ledger/simulate.ts`.

## The problem, in one paragraph

`atm simulate` (0.6.0) replays the log's recorded commands under a candidate catalog or deduction order. It cannot answer a what-if on the grant rules (`policy.upgradeGrant`, the rollover and gift amounts, what an invoice grants, a candidate menu's prices and tiers), because those decisions are made in `invoiceToCommands` (`src/billing/grants.ts`) from Stripe events before a command is recorded, and the handler keeps only event ids (`atm_event_claims`), not the events. Two pieces are needed: (A) durable storage of each handled input, and (B) a simulate mode that replays the stored inputs through the same grant rules with a candidate menu and policy and sets the result against what was decided.

## The decisions, summarized

| # | Question | Decision |
|---|---|---|
| 1 | What to store | The normalized fact, trimmed to what the grant rules read (no `source`, no bearer links, no invoice number, metadata cut to `b4u_school` and `family_id`), plus the side inputs the handler took from elsewhere (the fee, the payment refs), plus a SHA-256 of the raw body. Not the raw Stripe JSON. |
| 2 | Where | New table `atm_event_inputs` in `HANDLER_DDL`, keyed `(env, event_id)`, written in the same transaction as the claim's done mark and the outbox rows. Two small helper tables: `atm_input_contexts` (the menu and policy in force) and `atm_input_seeds` (a holder's rows before its first stored input). |
| 3 | Fidelity | The decision clock is the event's `created`, not `nowMs`; ids are derived; the engine's random ids are canonicalized; the only non-controlled inputs were the fee, the payment refs, the menu and policy in force, the order of handling and the writes that are not Stripe inputs. Each is stored or detected. The baseline run must equal the recorded outbox: that identity is the first test. |
| 4 | Simulate | `atm simulate --inputs <handler sqlite file> --env <live\|test> ...` next to the unchanged 0.6.0 log mode. Exit 0 no difference, 1 difference, 2 bad input. |
| 5 | Migration | Inputs exist from the first delivery after the upgrade. A holder that already had rows is replayed from a stored seed of those rows; earlier history is `not_replayable` and the CLI says so with a count. |

## 1. What to store: measured evidence

The measurements are on the 58 Stripe events in `fixtures/billing/stripe/recorded/` (14 top-level files and the 44 events of `delivered/`, all at API `2025-10-29.clover`), with throwaway scripts that were not committed (method in the last section).

### Bytes per event

| Event type | n | raw JSON, mean bytes | raw minus the mapping's `personal` paths | normalized fact (`normalize()` output) | replay fact (trimmed, see below) |
|---|---|---|---|---|---|
| `invoice.paid` | 18 | 4,177 | 4,017 | 885 | 635 |
| `customer.subscription.created` | 10 | 4,021 | 4,021 | 600 | 459 |
| `customer.subscription.updated` | 8 | 4,754 | 4,754 | 586 | 445 |
| `customer.subscription.deleted` | 1 | 3,608 | 3,608 | 463 | 322 |
| `charge.refunded` | 3 | 2,644 | 2,438 | 334 | 207 |
| `charge.dispute.created` | 3 | 2,162 | 1,237 | 294 | 160 |
| `charge.dispute.closed` | 2 | 2,540 | 1,566 | 293 | 160 |
| `invoice_payment.paid` | 13 | 655 | 655 | 294 | 162 |
| all 58 | 58 | 3,190 | 3,049 | 575 | 404 |

Totals: raw 185,039 bytes; raw after `redactPersonal` 176,822 (95.6% of raw); normalized 33,373 (18.0%); replay fact 23,435 (12.7%). The largest replay fact is an `invoice.paid` at 862 bytes. At three events per family-month (an assumption, not measured: `invoice.paid`, `invoice_payment.paid`, one subscription update) and about 300 bytes of columns per row, 1,000 families make about 2 MB a month of stored inputs where raw JSON would be about 10 MB.

### Personal data in the raw event

The recorded fixtures are scrubbed (see `fixtures/billing/stripe/recorded/README.md`), so the counts below understate what a live event holds. Where a path is present and non-null in the fixtures:

| Event | Path | Non-null / present | Covered by the mapping's `personal` list? |
|---|---|---|---|
| `invoice.paid` | `customer_name` | 16 / 18 | yes |
| `invoice.paid` | `customer_email` | 2 / 18 | yes |
| `invoice.paid` | `customer_address` (country, postal code) | 2 / 18 | yes |
| `invoice.paid` | `hosted_invoice_url`, `invoice_pdf` (bearer links to a document that shows the name and address) | 18 / 18 | no |
| `invoice.paid` | `lines.data[].description` (free text built from the product) | 26 / 26 lines | no |
| `invoice.paid` | `account_name` (the school's name) | 18 / 18 | no |
| `charge.refunded` | `payment_method_details.card` (`last4`, `fingerprint`, `exp_month`, `exp_year`) | 3 / 3 | no (the dispute mappings list `payment_method_details`; this one lists only `billing_details`, `receipt_email`, `shipping`) |
| `charge.refunded` | `receipt_url` | 3 / 3 | no |
| `charge.dispute.closed` | `evidence.customer_name` | 2 / 5 dispute events | yes (`evidence`) |

The mapping lists are in `schema/mapping/stripe.*.v1.json` (`personal`). Two consequences:

- **Raw minus the `personal` paths is not a safe store.** `redactPersonal` saves 4.4% of the bytes and still leaves a card's last four digits, fingerprint and expiry in every refund event, the receipt link, and the invoice bearer links. It is a denylist; a Stripe field added tomorrow is kept.
- **The normalized fact is nearly clean, not clean.** The fields the grant rules read hold no name, email, address or card. But the normalized invoice also carries `hostedInvoiceUrl`, `invoicePdf` and `number` (nothing under `src/` outside the mapping and the type reads them: `grep` finds no use), and `metadata` copies every string pair of the checkout metadata (the caller sets those). The grant rules read only `b4u_school` and `family_id` from it (`src/billing/grants.ts:664-665` and `:1492-1493`, `src/billing/handle.ts:112`). The fact keeps `customerId` (`cus_...`) because `src/billing/money.ts:101` copies it into `payment.succeeded`. So the stored fact is an allowlist: the normalized fact minus `source`, `number`, `hostedInvoiceUrl`, `invoicePdf`, with `metadata` cut to the two keys.

### Does the decision depend on anything the normalized fact lacks?

Proven by a throwaway script, not only by reading `src/billing/handle.ts:555-577` (which reads only `type` and `api_version` from the raw event and then `normalize()`s). For the 44 delivered events (8 scenarios) the script replayed, through `handleStripeEvent` with an in-memory store that evolves its rows, events cut down to exactly the paths their mapping reads (11 to 25 KB of raw JSON per scenario, down to 2.5 to 5.6 KB). The outbox it produced equaled the real handler's outbox (every body, every id) in 8 of 8 scenarios. So the grant decision is a function of the mapped fields; everything else in a raw event is not needed for replay.

### What is lost by storing the fact and not the raw event

- A later change to the mapping (a new field, a corrected path) cannot be replayed from facts. A fact is the output of `stripe/<event>@v<n>`; the row records that label, and a new mapping version is a new label. A mapping bug that mis-read a field is baked into the stored fact; the SHA-256 of the raw body lets an operator check a re-fetched Stripe event against the row, but the re-fetch itself is out of scope (Stripe lists events only for a limited time, 30 days from memory, not checked here).
- Facts the mapping does not extract today cannot be asked later: tax lines, discounts, the customer's country, the payment method. `ROADMAP.md` already lists "no tax lines" under Taxes; if the receipt or revenue-timing work needs them, storing starts only after they are mapped.
- It is consistent with the roadmap decision of 2026-11-05 to store no raw payload for usage events ("Decisions taken"): atm keeps no raw third-party payload anywhere.

### Decision: the replay fact plus side inputs plus a hash

Store, per input: the replay fact (JSON, about 400 bytes), the columns that are not in any event (below), and `raw_sha256` of the verified payload. Not stored: the raw JSON, any name, email, address, card detail, receipt or invoice link, the invoice number, and any metadata key but the two.

### Retention and erasure

- **Retention (recommended, see OWNER DECISIONS):** applied inputs live as long as the database and its outbox, because they explain the outbox rows. There is no automatic prune in version 1. A prune in the middle of a holder's history would break the state continuity replay needs (it would need a new seed); it is left out.
- **Erasure.** Today an erasure is a ledger event, `subject.erased`, with a payload `objects` listing the rewritten objects by id (`schema/payload/subject.erased.v1.json`); no code in `src/` performs it (only the type and the schema exist), and `tests/hledger-multi.test.ts` (the test "no personal data of the erased family ...", about line 593) pins that after it no event file or journal holds the erased family's personal fields while the money stays booked. Stored inputs follow the same rule: when `subject.erased` is booked for a holder, the operator calls `eraseStoredInputs` in the same transaction. It turns every input and seed of that subject into a tombstone: `body`, `payment_refs`, `subject_key`, `raw_sha256` and `fee` are set to NULL, `erased_at` is set, and the seed row is deleted. The tombstone keeps `env`, `event_id`, `school_id`, `type`, `api_version`, `mapping`, `stripe_created`, `outcome`, `applied_order`, `atm_version`, which name no person. Replay then excludes that holder from the replay and reports `erased: n inputs`; its recorded events (already redacted by the erasure) are carried over unchanged. The ledger's money stays; so do the stored inputs of other holders.
- A stored fact holds pseudonymous ids (`family_id`, `cus_...`). They count as personal data only while the family service can map them to a person; that mapping is the family service's to delete, and `eraseStoredInputs` removes the facts that carry the ids.

## 2. Where: the table, the transaction, the columns

### The transaction

`handleStripeWebhook` already commits claim done, rows and outbox rows in one transaction (`src/handler/stripe-webhook.ts`, `applyOnce`, lines 558-634; the commit is `deps.db.transaction` at line 656). The input row is written inside the same transaction:

| Where | Line (at 0.6.0) | Write |
|---|---|---|
| `applyOnce`, after the outbox append (613) and the index writes (614-627), before `finishClaim` (628) | `applied` | the input row with outcome `applied`, the seed if it is the holder's first stored input, the context row if new |
| `applyOnce`, the `result.refused` branch (602-605) | a 422 refusal | an upsert with outcome `refused` and `reason`; not for the retryable 409 reasons (`unmatched_invoice`, `unknown_subscription`), which are waits and become `applied` on the retry |
| `recordPaymentOnce`, before `finishClaim` (739) | `invoice_payment.paid` applied | the input row (it teaches the payment index, so it is part of the history) |
| not stored | `ignoreUnmapped`, `ignoreForeign` (another product's event), pre-claim refusals (`school_mismatch`, `ambiguous_payment`, `livemode_mismatch`, `bad_request`, `bad_signature`), 409 waits, an event that does not normalize | nothing to decide or nothing to replay; `atm_event_claims` still records the foreign ones |

A storage error throws inside the transaction: nothing is committed, the claim stays `claimed`, the handler answers 500 and Stripe retries (the same rule as any error in `applyOnce`). The invariant "every applied event has its input" is worth that.

### Stripe order races and the applied order

`invoice_payment.paid` can beat `invoice.paid` (409 `unmatched_invoice` until the invoice is indexed) and a refund answers 409 `unmatched_payment` until its payment is linked (the table at `src/handler/stripe-webhook.ts:54-59`). So the order Stripe created events in is not the order the handler applied them in. In the recorded deliveries the applied order differs from the created order in 6 of 8 scenarios. `applied_order` (an `AUTOINCREMENT` rowid assigned inside the write transaction, which `BEGIN IMMEDIATE` serializes) is the order of replay. A refused row that is later applied is deleted and re-inserted, so it gets its new order. Order matters for the rules too: `ROADMAP.md` records that two raise invoices delivered out of order grant 3 in total where in order they grant 2 + 2.

### The exact DDL

Added to `HANDLER_DDL` in `src/handler/schema.ts`. Every statement is `IF NOT EXISTS`, so the new tables are additive on an existing database. Plain SQL only (no `STRICT`, no generated columns), as the family service's Litestream requires (`buzz-school` `packages/family-service/AGENTS.md` and the header of its migration 0081); `json_valid` in a `CHECK` is already used by `atm_rows`.

```sql
-- One row per handled Stripe input: what the grant rules need to decide it again. env is part of the key (the same
-- Stripe id can arrive under both modes). applied_order is the order the handler applied the inputs in (a refused row
-- takes a new one when it is applied). body is the replay fact, never the raw event.
CREATE TABLE IF NOT EXISTS atm_event_inputs (
  applied_order INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL CHECK (env IN ('live', 'test')),
  event_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  subject_key TEXT,
  type TEXT NOT NULL,
  api_version TEXT NOT NULL,
  mapping TEXT NOT NULL,
  livemode INTEGER CHECK (livemode IS NULL OR livemode IN (0, 1)),
  stripe_created INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'refused')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  revision_before INTEGER,
  revision_after INTEGER,
  atm_version TEXT NOT NULL,
  context_hash TEXT,
  menu_version TEXT,
  policy_version TEXT,
  fee INTEGER,
  payment_refs TEXT CHECK (payment_refs IS NULL OR json_valid(payment_refs)),
  raw_sha256 TEXT,
  body TEXT CHECK (body IS NULL OR json_valid(body)),
  erased_at INTEGER,
  UNIQUE (env, event_id),
  CHECK ((outcome = 'refused') = (reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS atm_event_inputs_subject
  ON atm_event_inputs (env, school_id, subject_key, applied_order);

-- The menu, the policy and the Stripe price ids in force when inputs were handled, one row per distinct content (the
-- hash is of their canonical JSON). Lets the baseline replay use what was in force, not what is current.
CREATE TABLE IF NOT EXISTS atm_input_contexts (
  env TEXT NOT NULL CHECK (env IN ('live', 'test')),
  school_id TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  menu_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  first_used_at INTEGER NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body)),
  PRIMARY KEY (env, school_id, context_hash)
) WITHOUT ROWID;

-- A holder's rows (the engine rows and the grants row) and revision as they were just before its first stored input,
-- written once, only when the holder already had rows. Replay of that holder starts here.
CREATE TABLE IF NOT EXISTS atm_input_seeds (
  env TEXT NOT NULL CHECK (env IN ('live', 'test')),
  subject_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  taken_at INTEGER NOT NULL,
  first_event_id TEXT NOT NULL,
  rows TEXT NOT NULL CHECK (json_valid(rows)),
  PRIMARY KEY (env, subject_key)
) WITHOUT ROWID;
```

### Why each column

| Column | Why it is there |
|---|---|
| `applied_order` | the replay order (above). |
| `env`, `event_id` | the key. After the env correctness PR the claims, invoice index, payment index and outbox keys carry `env`; this table is designed in that shape and joins to them on `(env, event_id)`. |
| `school_id`, `subject_key` | which holder the input belonged to (`<school>\|<env>\|family:<id>`; a payout uses `stripe:payouts`), resolved by `locateSubject` at handling time. NULL after erasure. |
| `type`, `api_version`, `mapping`, `livemode` | which mapping read the event (`stripe/invoice.paid@v1`), so a fact is attributable to the code that made it. |
| `stripe_created` | the decision clock: `now = event.created * 1000` (`stripe-webhook.ts:595`); also the seed of the event's ULID (`:583-587`). |
| `received_at` | `deps.nowMs()` at commit; information only (it decides nothing). |
| `outcome`, `reason`, `attempts` | `applied`, or `refused` with the 422 reason code (`unmatched_line`, `addon_only_subscription`, `missing_metadata`, `rejected`, `bad_event`); how often Stripe has retried it. The message is not stored (it quotes event content). |
| `revision_before`, `revision_after` | the holder's revision when the input was handled and after its write. The replay checks that its own revision equals `revision_before` at every step; a mismatch means a write that is not a Stripe input happened in between (a spend, a lapse, an import), which the driver then interleaves from the log or reports (section 3). |
| `atm_version` | the package version that decided it, so a baseline mismatch is attributable to a code change. |
| `context_hash`, `menu_version`, `policy_version` | the menu and policy in force (`deps.context(school)` is called inside the transaction at every event, `stripe-webhook.ts:574`). The versions end up in event labels (`menu_version`, `policy_version`), so they matter for identity. |
| `fee` | the result of the caller's `paymentFee(raw)` hook: an outside read of Stripe the fact does not contain. |
| `payment_refs` | the payment intent and charge ids the invoice paid with, from the `paymentRefs` hook or the expanded `invoice.payments` (`invoiceRefsOf`, `:258-276`): they feed `atm_payment_index`, which later finds the invoice of a refund. Not in the normalized fact. |
| `raw_sha256` | proof of provenance without keeping the payload. |
| `body` | the replay fact: `{"v":1,"fact":{...}}`. |
| `erased_at` | the tombstone mark. |

### The writer in one sentence per piece

- One normalization: `handleStripeEvent` and the handler share `normalizeStripeEvent` (extracted from `handle.ts:555-577`), so the fact the handler stores is the fact the rules decided on.
- The context row is written when its `(env, school_id, context_hash)` is new. Hashing a 2.1 KB menu, policy and price-id map costs 0.013 ms per event (measured, 2,000 runs), so it is hashed on every event.
- The seed is written when the holder has rows (`loadSubject`, `:496-516`, already loaded in `applyOnce`) and no stored input or seed yet.

### Migration of the existing tables (the env correctness PR lands first)

A separate PR adds `env` to the keys of `atm_event_claims`, `atm_invoice_index`, `atm_payment_index` and `ledger_outbox` (`docs/log-and-r2.md#env-on-the-handlers-tables`) before A starts. What that migration is expected to look like, and what A depends on:

- `HANDLER_DDL` cannot do it: `CREATE TABLE IF NOT EXISTS` does not change a primary key and SQLite cannot alter one. The options are a table rebuild (create `x_new` with the new key, `INSERT INTO x_new SELECT 'live', ... FROM x`, `DROP TABLE x`, `ALTER TABLE x_new RENAME TO x`, in one transaction) or additive new tables with a backfill and a read of both. The recommendation is the rebuild: it leaves one copy and one read path. It is the pattern the family service's migrations already use (`migrations/0010.sql`, `0040.sql`, `0046.sql`, `0081.sql`: `_new`, `INSERT ... SELECT`, `DROP`, `RENAME`).
- What the family service's schema test allows. `packages/family-service/test/schema-portable.test.ts` checks one thing: every `RAISE(...)` in the schema has a literal message, because Litestream's bundled SQLite cannot parse the others. So a migration may contain anything Litestream's SQLite parses; the house rule (header of migration 0081) is plain SQL: no `STRICT`, no generated columns, literal `RAISE`. A rebuild and an `AUTOINCREMENT` column are within it.
- The old rows carry no env. The invoice index can be checked (its `subject_key` has the env), the claims and the outbox cannot. So the migration takes the env the old rows were handled under from the caller (`migrateHandlerTables(db, { assumeEnv })`), refuses a database whose invoice index says otherwise, and records the step in a one-row `atm_schema` table so it runs once.
- `buzz-school` has no atm handler tables yet (a search of its `migrations/`, `src/` and `worker/` for `atm_rows`, `ledger_outbox` and `handleStripeWebhook` finds none), so for the family service the new shape is simply what `HANDLER_DDL` creates. Only databases created by earlier atm releases (tests, sandbox spikes) need the rebuild.
- Effect on this design: the ULID that ties a decision event to its input is `deterministicUlid` over `[school, event_id]` (`:583-587`). If the env PR adds `env` to that seed, the shared helper `inputCauseId` below must change with it, in one place; A makes the handler call the helper, B calls it too.

A's own DDL is additive and needs no rebuild.

## 3. Replay fidelity

To reproduce a decision the replay needs the same inputs, the same order, the same clock, and the menu and policy in force. `handleStripeEvent` is pure (`src/billing/handle.ts:1-12`: no clock read). The table lists every source of non-determinism found in `handleStripeEvent`, `invoiceToCommands` and what the handler passes in, and how replay controls it.

| # | Source | Where | How replay controls it |
|---|---|---|---|
| 1 | The clock | the handler reads `deps.nowMs()` for claims, signature tolerance and `done_at` only. The engine gets `now: event.created * 1000` (`stripe-webhook.ts:595`). | Replay uses `stripe_created * 1000`. No clock is read. Proven: the handler ran with a clock set to created + 1 s and the replay with none, same outbox. |
| 2 | The input event id (`cause` of every decision event, id of every command) | `deterministicUlid({ timeMs: created*1000, revision: 0, seed: canonicalize([school, eventId]) })` (`:583-587`) | Recomputed from `(school_id, event_id, stripe_created)` by `inputCauseId`. Not stored. |
| 3 | The decision events' own ids | `deterministicUlid` includes 24 bits of the holder's revision, so an event's id depends on how many writes the holder had before it. | The revision must match at every step: `revision_before` is checked. (Seen in the experiment: one refused event lowered a revision and changed 1 character of the ids that followed.) |
| 4 | Random rollover ids | the engine mints random KSUIDs for rollover rows | `canonicalRolloverIds` (`src/ledger/run.ts`) rewrites each to `roll_<commandId>_<n>` in every mutation. Already done on both sides. |
| 5 | The process time zone | the engine adds months in local time | `withUtc` (`run.ts`) pins `TZ=UTC` around each engine call. Proven: the outbox hash of all 8 scenarios is the same under TZ UTC, America/Denver, Pacific/Auckland and Asia/Kolkata. |
| 6 | The runtime's time zone database | `wallMs` in `grants.ts` uses `Intl.DateTimeFormat` with `menu.timeZone` | Not controlled; the same runtime gives the same result. A replay on a newer ICU could differ across a changed zone rule. Reported as uncertain; `atm_version` does not capture it. |
| 7 | Payment fee | `deps.paymentFee(raw)`, an outside read | Stored in `fee`; replay passes it as `input.fee`. |
| 8 | Payment refs | `deps.paymentRefs(raw)` and `invoice.payments` of the raw event | Stored in `payment_refs`; replay writes its own index from them. |
| 9 | The payment and invoice index tables | `atm_invoice_index`, `atm_payment_index`, read in `locateSubject` (`:378-407`) to give `invoiceIds` to a refund or dispute | Replay keeps its own two maps, written in the order of replay by the same rules as the handler: first write wins (`ON CONFLICT DO NOTHING`); an `invoice.paid` indexes the invoice and its `payment_refs`; an `invoice_payment.paid` indexes its refs. |
| 10 | `hits[0]` of an unordered join in `locateSubject` | `:380-391` | Only used when all hits name one subject (more than one is `ambiguous_payment`), so the order does not matter. Replay does the same. |
| 11 | The menu, policy, versions, catalog and price ids in force | `deps.context(school)`, read per event | The context row (`context_hash`) holds the menu, policy and price ids; the catalog is `menuCatalogRows({ menu, school, env })`, rebuilt. Baseline uses each input's own context; the candidate replaces it (from `--effective-from` or from the start). |
| 12 | The holder's rows and revision | loaded from `atm_rows` | Replay evolves its own rows from the seed (or from none) with `applyRowChanges`. |
| 13 | Writes that are not Stripe inputs | the family service's `track`, `finalize`, `confirmExpiredLock`, `updateBalance`, `recordLapse` (`recordEngineCommand`, `src/ledger/outbox.ts`); the caller-row import | These change the rows a later `reset` or refund reads (a reset rolls over what is left), so a replay from Stripe inputs alone drifts. Detected by `revision_before` and handled by interleaving the log's own commands (below). |
| 14 | The order of handling | Stripe order races (above) | `applied_order`. |
| 15 | Repeat deliveries | `ON CONFLICT (event_id) DO NOTHING` on the claim; the outbox `ON CONFLICT (school_id, idem) DO NOTHING` | One input row per `(env, event_id)`; replay drops a repeated `idem`, first wins. |
| 16 | The code | the grant rules change between releases | `atm_version` per row. A baseline mismatch under a newer version is a finding (a code change would have decided differently), reported as drift. |

### The proof run (throwaway, not committed)

A script built the real handler over each of the 8 `delivered/` scenarios (retrying 409s as Stripe does, remembering the order of application), then replayed the stored inputs through `handleStripeEvent` with an in-memory store: the rows evolve with `applyRowChanges`, the two index maps are rebuilt, the decision events are deduped by `idem`. Result: in 8 of 8 scenarios the replayed events equal the handler's outbox byte for byte, run twice and under four time zones. Replaying in Stripe's created order instead of the applied order also matched on these fixtures, but that is not evidence that order is irrelevant: the script did not model the handler's waits (its driver indexed a payment before its invoice, and refused one dispute that had no link yet), and the fixtures hold no out-of-order raise invoices, which `ROADMAP.md` says do depend on order. The stored order is `applied_order`, not `stripe_created`.

### The log's own commands are interleaved

Replay of Stripe inputs alone is exact only for a holder whose every write was an input. When the family service also spent credits, a later `reset` or refund ran on rows the replay would not have. The design does not give up on those holders. Each stored input records `revision_before`. The log's events carry the engine mutation with `revision.before` and `revision.after` (`src/ledger/replay.ts`, `recordedMutations`). So per holder the driver builds one timeline:

1. Items are the stored inputs (applied) and the log's commands whose `cause` is not the `inputCauseId` of a stored input (the carried commands: spends, lapses, adjustments).
2. They are ordered by the recorded revision (`revision_before` of an input, `revision.before` of a command), ties by `applied_order`, then the log's order. The order is fixed from the recorded history; the candidate then evolves its own revision.
3. An input runs through `handleStripeFact` on the candidate's rows. A carried command runs through the same engine path `simulate()` uses (`runOnState` with `withPolicy`) on the same rows, converted with `stateFromRows` and written back with `rowChangesFromMutation`.

B may ship this in two steps: first holders with no carried commands (every `revision_before` matches), reporting the others as `not_replayable` with the reason `non_input_writes`, then the interleave. The baseline test below decides when a holder counts as replayable: its baseline must equal the log.

### What cannot be replayed

- Inputs not stored (handled before the upgrade, or foreign, or never normalized): `not_replayable`, with a count.
- A holder whose pre-upgrade rows are not in a seed (should not occur once A is deployed; a seed is taken at the first stored input).
- Erased holders (tombstones).
- The caller-row import (`grantsStateFromCallerRows`, `src/billing/adopt.ts`) writes rows with no input: for a holder imported after its seed it is a revision gap with no carried command in the log, reported as `non_input_writes`.

## 4. The simulate mode

`simulate()` and `atm simulate` of 0.6.0 stay as they are, byte for byte (same function, same flags, same golden files). A new function and a new set of flags select the inputs mode.

### What it does

For one school and one env:

1. Read the log events (`--root`, `--school`, as in 0.6.0) and the stored inputs (`--inputs`, `--env`).
2. Classify: the log's events whose `cause` is an `inputCauseId` of a stored input are decisions of that input. Other events are carried (money, payouts, disputes, and the family service's commands).
3. **Baseline.** Replay every replayable holder's timeline with each input's own recorded context. The decision events must equal the log's, by `idem` and canonical body. The result is `baseline: { identical, inputs, differing: [...] }`. Not identical is exit 2 (the replay cannot be trusted as a basis for a what-if) unless `--allow-baseline-drift`, which keeps going and reports the drift next to the diff.
4. **Candidate.** Replay again with the candidate menu and policy replacing the recorded context, from `--effective-from` (default: from the beginning). No candidate flags at all is the identity: exit 0 if the baseline holds.
5. **Diff**, three views:
   - **per delivery:** for each stored input, what was decided (from the log: events, units granted and taken back per feature, the refusal) against what the candidate decides, with `kind`: `same`, `changed`, `newly_refused`, `newly_applied` (a stored 422 refusal the candidate accepts), `no_longer_applied`;
   - **per holder:** balance by feature, recorded against candidate (`AtmBalance`, as 0.6.0);
   - **journal:** posting totals by month, account and commodity, and the transaction count per month (the 0.6.0 shapes `AtmSimulatePostingChange` and `transactions`).

A candidate that makes a command the engine refuses, or an input that the grant rules refuse, is listed with its reason; the holder's replay goes on from the state before it, as in 0.6.0, and everything after the first one is the candidate's own history.

### The CLI

```bash
atm simulate --root <folder> --school <id> --inputs <handler.sqlite> --env live \
  [--menu candidate-menu.json] [--policy candidate-policy.json] \
  [--effective-from 2026-03-01T00:00:00Z] \
  [--current-menu menu.json] [--current-policy policy.json] \
  [--month 2026-05] [--allow-baseline-drift] [--json]
```

- `--inputs` takes the handler's SQLite file (read only; opened `readonly`). A folder of exported inputs is not part of version 1 (OWNER DECISIONS).
- `--env` is required with `--inputs`.
- `--current-menu` and `--current-policy` override the recorded context for the baseline (the log's side); normally unneeded.
- The 0.6.0 flags `--catalog` and `--current-catalog` are refused with `--inputs` (the catalog follows the menu).
- Exit codes: **0** no difference; **1** a difference (a CI check can gate a menu or policy change on it); **2** input it cannot use, one line on stderr, `{"ok":false,"error":...}` with `--json`: missing option, unreadable file, no `atm_event_inputs` table, no stored inputs for that school and env, a candidate that fails `validateMenu` or `resolvePolicy`, a log `replayEvents` refuses, a baseline that does not equal the log (unless `--allow-baseline-drift`).

### The output when history is missing

Always printed, text and `--json` (`notReplayable`):

```
inputs: 412 stored for school sch_x (live), 2026-11-12 to 2026-12-03; 87 holders replayed.
not replayable: 1,340 decisions of 203 holders predate the stored inputs and were carried over unchanged. A
what-if on the grant rules covers only history after 2026-11-12 (the first delivery handled by atm 0.7.0).
```

### Out of scope

- What Stripe charged: payments, refunds, payouts, disputes and fees are carried over unchanged; no USD total moves, only credit units and the postings that follow from them (as in 0.6.0).
- Events whose inputs were not stored before this change, and events of erased holders: `not_replayable`, counted, carried over.
- A different mapping (a later change to `schema/mapping/` cannot be replayed from facts).
- `lowCreditThreshold` alerts and the cron's expiries beyond what `simulate()` already does (README, "What it cannot", items 3 to 5).
- Changing the order of delivery or inventing deliveries.

## 5. Migration of existing databases

A database that predates the storage has no `atm_event_inputs` table and no stored input. The feature is unavailable for its earlier history, and the CLI says so:

- `inputsStatus` returns `{ available: false, reason: "no_table" }` (the table does not exist yet: the handler of this version creates it on start) or `reason: "empty"` (the table exists and holds nothing for the school and env).
- `atm simulate --inputs` on such a database exits 2 with: `this database holds no stored inputs for school <id> (live): the handler stores them from atm 0.7.0, so a what-if on the grant rules covers only the history after that; run atm simulate without --inputs for the command-level what-if on the whole log`.
- After the upgrade, every delivery is stored, and each holder that already had rows gets a seed at its first stored input, so its later history is replayable without the history before it. Earlier decisions of that holder are carried over unchanged and counted.
- Nothing is backfilled: the raw events are not in the database and re-fetching them from Stripe is out of scope.

## 6. Interfaces

Shared by A (storage) and B (simulate from inputs). Names are the contract; fields may gain optional members, not lose any. Types live in `src/types.ts` with the other public declarations; code in the files named.

### Shared pieces (A creates; B imports)

```ts
// src/handler/inputs.ts

export const REPLAY_METADATA_KEYS = ["b4u_school", "family_id"] as const;

/** A BillingFact without what the rules never read: its source, the invoice number and the bearer links. */
export type ReplayFact =
  | Omit<BillingInvoice, "source" | "number" | "hostedInvoiceUrl" | "invoicePdf">
  | Omit<BillingRefund, "source">
  | Omit<BillingDispute, "source">
  | Omit<SubscriptionFact, "source">
  | Omit<InvoicePaymentFact, "source">
  | Omit<StripePayout, "source">;

/** The stored `body`. v is the version of this shape. */
export type StoredFactBody = { v: 1; fact: ReplayFact };

/** The ULID a decision event names as its `cause`; the one place it is computed (replaces the inline call in stripe-webhook.ts). */
export const inputCauseId = (args: {
  env: AtmEnv;
  school: string;
  eventId: string;
  stripeCreated: number; // whole seconds, as Stripe's `created`
}): string;

/** The fact the rules read, from a normalized fact: drops source, number, links; cuts metadata to REPLAY_METADATA_KEYS. */
export const replayFactOf = (fact: BillingFact): ReplayFact;

/** `sha256(canonicalize({ menu, policy, priceIds }))` as hex, the context hash. */
export const contextHashOf = (context: Pick<WebhookContext, "menu" | "policy" | "priceIds">): string;
```

```ts
// src/billing/handle.ts (A, small refactor of lines 555-577; no behaviour change)

export type NormalizedStripeEvent =
  | { ok: true; target: MappingTarget; mappingLabel: string; apiVersion: string; type: string; fact: BillingFact }
  | { ok: false; refusal: StripeEventRefusal };

/** The mapping and normalization step of handleStripeEvent, exported so the handler stores the fact the rules will decide on. */
export const normalizeStripeEvent = (event: unknown, eventId: string): NormalizedStripeEvent;

export type StripeFactInput = Omit<StripeEventInput, "event"> & {
  /** The stored replay fact, with `source` rebuilt by the caller. */
  fact: ReplayFact;
  target: MappingTarget;
  type: string;
  apiVersion: string;
  mapping: string; // `stripe/invoice.paid@v1`
};

/** handleStripeEvent from step "decide" on; handleStripeEvent = normalizeStripeEvent + handleStripeFact. Same result type. */
export const handleStripeFact = (input: StripeFactInput): StripeEventResult;
```

### Storage (A)

```ts
// src/handler/inputs.ts

export type InputOutcome = "applied" | "refused";

export type StoredInput = {
  appliedOrder: number;
  env: AtmEnv;
  eventId: string;            // Stripe's evt_...
  schoolId: string;
  subjectKey: string | null;  // null after erasure
  type: string;
  apiVersion: string;
  mapping: string;
  livemode: boolean | null;
  stripeCreated: number;      // seconds
  receivedAt: number;         // ms
  outcome: InputOutcome;
  reason: StripeEventRefusal["reason"] | null;
  attempts: number;
  revisionBefore: number | null;
  revisionAfter: number | null;
  atmVersion: string;
  contextHash: string | null;
  menuVersion: string | null;
  policyVersion: string | null;
  fee: number | null;
  paymentRefs: string[] | null;
  rawSha256: string | null;   // null after erasure
  fact: ReplayFact | null;    // null after erasure
  erasedAt: number | null;
};

export type StoredContext = {
  env: AtmEnv; schoolId: string; contextHash: string;
  menuVersion: string; policyVersion: string; firstUsedAt: number;
  menu: Menu; policy: BillingPolicy; priceIds: Record<string, string>;
};

export type StoredSeed = {
  env: AtmEnv; subjectKey: string; revision: number; takenAt: number;
  firstEventId: string; rows: BillingRow[];
};

/** Writer. Runs in the caller's transaction (it opens none); throws on a storage error so the transaction rolls back. */
export const recordInput = (db: SqlDatabase, args: {
  env: AtmEnv;
  schoolId: string;
  event: { id: string; type: string; created: number; apiVersion: string; livemode: boolean | null };
  rawBody: string;                         // hashed, never stored
  normalized: Extract<NormalizedStripeEvent, { ok: true }>;
  outcome: InputOutcome;
  reason: StripeEventRefusal["reason"] | null;
  subjectKey: string | null;
  revisionBefore: number | null;
  revisionAfter: number | null;
  rowsBefore: readonly BillingRow[];       // the loaded rows; written as the seed if first and non-empty
  context: WebhookContext;
  fee: number | null;
  paymentRefs: readonly string[] | null;
  nowMs: number;
  atmVersion: string;                      // the constant `atm --version` prints
}): void;

export type InputsStatus =
  | { available: false; reason: "no_table" | "empty" }
  | {
      available: true;
      applied: number; refused: number; erased: number; seeds: number;
      firstStoredAt: number; lastStoredAt: number; // received_at, ms
      schools: string[]; envs: AtmEnv[]; atmVersions: string[];
    };

/** What a database holds, never throws on an older database (no table is `available: false`). */
export const inputsStatus = (db: SqlDatabase, filter?: { env?: AtmEnv; school?: string }): InputsStatus;

export type InputsRead = {
  inputs: StoredInput[];                       // applied, ordered by appliedOrder
  refused: StoredInput[];                      // 422 refusals, ordered by stripeCreated
  seeds: Map<string, StoredSeed>;              // by subjectKey
  contexts: Map<string, StoredContext>;        // by contextHash
};

/** Reader B consumes. Read only. */
export const readInputs = (db: SqlDatabase, filter: { env: AtmEnv; school: string }): InputsRead;

/** Erasure hook. Call in the transaction that books `subject.erased` for the holder. Idempotent. */
export const eraseStoredInputs = (db: SqlDatabase, args: {
  env: AtmEnv; school: string; subjectKey: string; nowMs: number;
}): { inputs: number; seeds: number };
```

`HANDLER_DDL` gains the three tables. `WebhookDeps` gains nothing required; `atmVersion` is a module constant, not a dependency.

### Replay and diff (B)

```ts
// src/ledger/simulate-inputs.ts

export type InputsSimulateInput = {
  events: readonly AtmEvent[];            // the log (as 0.6.0)
  inputs: InputsRead;                     // from readInputs
  env: AtmEnv;
  school: string;
  /** The candidate; neither is the identity. */
  candidate: { menu?: Menu; policy?: BillingPolicy };
  /** The candidate applies from this instant (ms) on; default from the start. */
  effectiveFrom?: number;
  /** Overrides of the recorded side; default the stored contexts. */
  current?: { menu?: Menu; policy?: BillingPolicy };
  month?: string;                         // YYYY-MM
  asOf?: string;
  allowBaselineDrift?: boolean;
};

export type DecisionSummary = {
  refused: { reason: StripeEventRefusal["reason"] } | null;
  events: number;
  /** Units issued per feature, and units taken back per feature, summed from the credit postings. */
  granted: Record<string, number>;
  removed: Record<string, number>;
  /** `canonicalize` of the row changes (engine rows and grants row), for equality. */
  rowsDigest: string;
};

export type InputsDeliveryChange = {
  eventId: string; type: string; appliedOrder: number | null;
  subjectKey: string; at: string;         // the event's `created`, ISO
  kind: "same" | "changed" | "newly_refused" | "newly_applied" | "no_longer_applied";
  recorded: DecisionSummary;
  candidate: DecisionSummary;
};

export type InputsBaselineMismatch = {
  eventId: string; subjectKey: string;
  reason: "events_differ" | "revision_gap" | "refused_differently" | "context_missing";
  recordedIdems: string[]; replayedIdems: string[];
};

export type NotReplayable = {
  subjectKey: string | null;
  reason: "inputs_not_stored" | "non_input_writes" | "erased" | "context_missing";
  decisions: number;                      // recorded decisions carried over unchanged
  firstDecisionAt: string | null;
};

export type InputsSimulation = Pick<
  AtmSimulation,
  "balances" | "balanceChanges" | "postingChanges" | "transactions" | "asOf" | "unaffected"
> & {
  events: AtmEvent[];                     // the candidate's events (left out of --json), for building its journal
  baseline: { identical: boolean; inputs: number; mismatches: InputsBaselineMismatch[] };
  deliveries: InputsDeliveryChange[];     // all of them; the CLI lists only the ones that are not "same"
  notReplayable: { decisions: number; holders: number; firstStoredAt: string | null; items: NotReplayable[] };
  replayed: { holders: number; inputs: number; carriedCommands: number };
  /** Commands the candidate's engine refused (as AtmSimulation.refused). */
  refused: AtmSimulateRefusal[];
  /** sum of delivery changes that are not "same", balanceChanges, postingChanges and refused. */
  differences: number;
  summary: string;
};

/** Replays the stored inputs (and the log's carried commands) twice, baseline and candidate, and diffs them. Writes nothing. Throws InputsSimulateError (the CLI's exit 2) for bad input. */
export const simulateFromInputs = (input: InputsSimulateInput): InputsSimulation;

export class InputsSimulateError extends Error {}

/** One run, the driver both sides use: the inputs in applied order with the log's carried commands interleaved by revision. */
export type ReplayInputsOptions = {
  events: readonly AtmEvent[]; inputs: InputsRead; env: AtmEnv; school: string;
  /** Which menu and policy to decide with, per input: the recorded context or a replacement. */
  contextFor: (input: StoredInput, recorded: StoredContext | undefined) => { menu: Menu; menuVersion: string | number; policy: BillingPolicy; policyVersion: string | number; priceIds: Record<string, string> };
};
export type ReplayInputsResult = {
  events: AtmEvent[];                     // decision events and carried events, deduped by idem (first wins)
  byInput: Map<string, { events: AtmEvent[]; refused: StripeEventRefusal | null; rowsDigest: string }>;
  rows: Map<string, { rows: BillingRow[]; revision: number }>;
  notReplayable: NotReplayable[];
  refused: AtmSimulateRefusal[];
};
export const replayInputs = (options: ReplayInputsOptions): ReplayInputsResult;
```

```ts
// src/cli.ts (B): simulate gains, with --inputs, these options; the 0.6.0 behaviour without --inputs is unchanged
//   --inputs <file>  --env <live|test>  --effective-from <ISO instant>  --current-policy <file>  --allow-baseline-drift
// Exit codes: EXIT 0 no difference, 1 differences (also a drift found with --allow-baseline-drift is reported, not counted), 2 bad input.
// --json prints { ok, school, env, baseline, deliveries (changes only), balanceChanges, postingChanges, transactions,
//                  notReplayable, replayed, refused, unaffected, differences, asOf, summary } on one line.
```

### Who owns what

| Piece | A (storage PR) | B (simulate PR) |
|---|---|---|
| `HANDLER_DDL` tables, `recordInput`, writes in `stripe-webhook.ts` | yes | no |
| `inputCauseId`, `replayFactOf`, `contextHashOf`, `normalizeStripeEvent` | yes | uses |
| `handleStripeFact` | yes (the split, with a test that `handleStripeEvent` is unchanged) | uses |
| `inputsStatus`, `readInputs`, `eraseStoredInputs` | yes | uses the first two |
| `replayInputs`, `simulateFromInputs`, CLI | no | yes |
| README, UPGRADING, CHANGELOG notes | the storage, the erasure rule, the new tables | the mode and flags |

A can be merged and shipped alone: it only writes. B depends on A's reader and `handleStripeFact`.

## 7. OWNER DECISIONS

Each has a recommendation; nothing here is decided by this document.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | **Retention** of stored inputs. | Keep applied inputs for the life of the database and the outbox; no automatic prune in version 1; refused rows stay until the event applies (the row is replaced) or an operator deletes them. | They explain the outbox rows, which the books keep for as long as the finance records. Pruning the middle of a history would need a new seed per holder. At about 2 MB a month per 1,000 families the cost is small. |
| 2 | **Personal data** stored. | The trimmed fact only: no names, emails, addresses, card details, receipt or invoice links, invoice numbers, and only the two metadata keys. Accept `family_id` and `cus_...` as stored pseudonymous ids, erased with the holder. | Measured above: the fact is 12.7% of the raw size and holds none of the personal fields in the recorded events. The `personal` denylist leaves a card's last four digits and bearer links in refund events, so storing the raw event minus those paths is not safe. A raw copy (encrypted, with a short life) is possible and would make mapping changes replayable; it is not recommended while the roadmap decision "atm stores no raw payload" stands. |
| 3 | **Ship inputs to the folder or R2** like events? | No. Inputs stay in the handler's SQLite file (backed up with it); `atm simulate --inputs` reads that file. An export for another machine is a later `atm inputs export` writing NDJSON, not shipped by `atm ship`. | The folder and R2 are the shareable, append-only record, and erasure there is a rewrite of objects. Inputs are working data, pseudonymous, and need exact deletion. Keeping them out of immutable files keeps `eraseStoredInputs` a single database transaction. |
| 4 | **Store 422 refusals** (`unmatched_line`, `addon_only_subscription`, ...)? | Yes, as `refused` rows, replaced when the event is later applied. | The most useful what-if is "would a menu that knows this price accept the invoices we refused", and a refused event writes nothing today (the claim is released, `:602-605`). Cost: one upsert per Stripe retry. |
| 5 | **Seed a holder's rows** at its first stored input? | Yes (`atm_input_seeds`). | Without it every holder that exists at the upgrade is unreplayable until it has a full history of stored inputs, which can be years. The seed holds engine rows and the grants row (no names), erased with the holder. |
| 6 | **Snapshot the menu and policy** (`atm_input_contexts`)? | Yes. | The baseline needs the menu and policy in force. The handler's `context()` callback returns whatever is current, and the handler writes no `catalog.published` or `policy.published` event; without the snapshot the baseline fails after the first menu edit. |
| 7 | **A baseline that does not equal the log**: fatal? | Exit 2 by default; `--allow-baseline-drift` to look anyway. | A what-if on a replay that cannot reproduce today is not evidence. The drift is itself a useful report (code changed between releases). |
| 8 | **Erasure shape**: tombstone or delete the rows? | Tombstone (clear body, subject, refs, fee, hash, seed; keep the non-personal columns). | The replay can then say "n inputs of an erased holder" instead of silently losing the order, and `applied_order` stays gapless. |
| 9 | **Env migration** (the PR before this one): rebuild or additive tables. | Rebuild the four tables once, guarded by an `atm_schema` row, `assumeEnv` supplied by the caller. | See section 2; one copy and one read path; the family service has no handler tables yet. This is the coordinator's PR to decide. |
| 10 | **`--effective-from`** in version 1? | Yes, it is small. | "What if we had changed on 1 March" is the question owners ask; without it a candidate rewrites the whole history. |

## 8. Test plan

### Storage (A)

- Atomicity: a throw after `appendToOutbox` leaves no input row, no outbox row, claim still `claimed` (`tests/webhook-handler.test.ts` holds the claim and takeover tests this follows).
- One input per delivery: a second delivery (`duplicate`) writes no row; the same Stripe id under `env: "live"` and `env: "test"` makes two rows.
- A 422 refusal makes a `refused` row with `attempts` rising on retry; after the cause is fixed and the event re-sent, the row is replaced and `applied_order` is new; a 409 wait writes nothing; `ignoreForeign` and `ignoreUnmapped` write nothing.
- Order: for each `delivered/` scenario `applied_order` is the order of the 200 answers, and differs from `created` order where the handler waited (6 of 8).
- No personal data: events built with `tests/stripe-events.ts` carrying a name, an email, an address, a card last4, receipt and invoice links, an extra metadata key; read the whole database file (and a `.dump`) and assert none of the strings is there (the `leaks()` pattern of `tests/hledger-multi.test.ts`), with a control that the same strings are in the raw payload. Size budget: mean body at most 500 bytes over the recorded fixtures (404 measured).
- Erasure: after `eraseStoredInputs` no fact, subject, ref, hash or seed of the holder remains; the other holders' rows are untouched; calling it twice is a no-op; `inputsStatus` counts the tombstones.
- DDL: `db.exec(HANDLER_DDL)` twice is a no-op; an old database (the 0.6.0 DDL plus data) gains the tables without losing rows; the new DDL passes the family service's rule (no `STRICT`, no generated column, no `RAISE`).
- `handleStripeEvent` is unchanged by the `normalizeStripeEvent` / `handleStripeFact` split: the existing 1,393 tests stay green and a new test feeds each recorded fixture through both entry points and compares results.
- `replayFactOf`: keeps every field the grant rules read (a property test: for random facts from `tests/billing-properties.test.ts` generators, `handleStripeFact` on the trimmed fact equals `handleStripeEvent` on the raw event).

### Baseline identity (B), the first test

- **Recorded fixtures.** The 8 `delivered/` scenarios through the real handler into an in-memory database (A's writer), then `replayInputs` with the recorded contexts: the decision events equal `ledger_outbox` row for row (body and id). (This design's throwaway proved it with raw events; the test proves it with stored facts.) Run in four `TZ` values in separate processes and compare a hash of the events.
- **Seeded histories.** The golden year (`fixtures/vibes-year`, via `tests/replay-inputs.ts`: raw Stripe events plus the family's own bookings) and the twelve-family `fixtures/vibes-multi`: build the handler database by delivering the inputs (and `recordEngineCommand` for the bookings), then baseline must be identical, including with carried commands interleaved by revision.
- **Order.** Shuffle the delivery order with retries 100 times (a seeded generator): the baseline is identical every time because the replay follows `applied_order`.
- **Seeds.** Start the handler on a database that already has rows for a holder, deliver inputs, baseline identical from the seed.
- **Menu change mid-history.** Change the menu between two deliveries: the baseline uses each input's context and is identical; without the context rows it is not.

### What-if goldens (B)

`tests/golden/simulate-inputs/*.json`, rewritten with `UPDATE_GOLDEN=1` like `tests/golden/simulate/`:

- `upgradeGrant: "prorated"` to a full grant on the yearly-raise and the tier-and-quantity-change scenarios (the owner decision in `ROADMAP.md`: a switch that grants 128 under the old rule and 192 under the new);
- `removeOnFullRefund: false` on `full-refund` (the credits stay); `removeOnLostDispute: false` on `dispute-lost`;
- a larger and a smaller allowance on the tier in `vibes-year`;
- a candidate menu that adds a price: the stored 422 refusal becomes `newly_applied`;
- `--effective-from` halfway through `vibes-multi`: deliveries before it are `same`.

Each golden pins the per-delivery kinds, the per-holder balance change and the posting changes by month; the identity candidate (no flags) pins exit 0.

### Mutations (each must fail a test)

- replay in `stripe_created` order instead of `applied_order` (fails the out-of-order raise case and the id check);
- ignore `revision_before` (fails the carried-command history);
- drop the carried commands (fails `vibes-year`);
- ignore `fee` or `payment_refs` (fails the money lines and the refund link);
- use the current menu for the baseline (fails the menu-change test);
- skip the seed (fails the seeded-holder test);
- read `nowMs` instead of `stripe_created` (fails the TZ-and-clock test);
- let the writer store the raw event (fails the no-personal-data test);
- skip the `idem` dedupe (fails a duplicate-delivery history);
- a CLI that exits 0 on a baseline mismatch (fails the exit-code test).

### CLI (B)

Exit 0 with no candidate and a matching baseline, 1 with a differing candidate, 2 for each bad input in section 4 (no table, no inputs, bad menu, bad policy, a baseline mismatch, a missing `--env`); the 0.6.0 tests in `tests/simulate.test.ts` pass unchanged; the output names the not-replayable count.

## 9. How the numbers were measured, and what is not verified

Throwaway scripts, kept in `/tmp`, not committed (they import the package's own `normalize`, `redactPersonal`, `handleStripeWebhook` and `handleStripeEvent` from the worktree):

1. **Bytes.** For each JSON event under `fixtures/billing/stripe/recorded/` that has `type` and `data`: `JSON.stringify` length of the raw event, of `redactPersonal(raw, mapping)`, of `normalize(raw, mapping)`, and of that fact without `source`, `number`, `hostedInvoiceUrl`, `invoicePdf`.
2. **Personal fields.** A walk of every path of every raw event matching name, email, address, phone, card, receipt, link and description patterns, counting non-null values per event type.
3. **Replay equality.** The real handler over the 8 `delivered/` scenarios; the order of the 200 answers; a replay driver (in-memory rows, `applyRowChanges`, its own two index maps, dedupe by `idem`) over those inputs, whole and cut to the mapped paths; comparison of the sorted canonical event bodies; repeated under four `TZ` values.
4. **Hash cost.** 2,000 runs of `sha256(canonicalize({ menu, policy, priceIds }))` for the recorded menu.

Not verified, or only read:

- Everything here is on scrubbed sandbox fixtures (test mode, one API version). Real live events carry more personal fields than the counts show, and a larger variety of invoices.
- No fixture has a payout, a family-service spend, a caller-row import or a seed; the interleave and the seed are designed from the code, not run. The first test of B on `fixtures/vibes-year` is where they get proven.
- The ICU time zone database (row 6) is not controlled.
- That Stripe lists events for 30 days, and that Stripe retries a non-2xx for three days (the latter is the handler's own comment), were not checked against Stripe.
- The size estimate for 1,000 families assumes three events per family-month and 300 bytes of columns; the storage PR should measure a real row.
- `AUTOINCREMENT`, `json_valid` in `CHECK` and a rowid alias were not run through the family service's Litestream; the first two are used by the family service's own schema or by `atm_rows`, the third is plain SQLite. `AUTOINCREMENT` makes SQLite keep a `sqlite_sequence` table: check that a Litestream restore keeps it.
- A rebuild migration for the env PR was designed from the family service's earlier migrations, not tried on a copy of its database.
