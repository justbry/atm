# Simulating the grant rules: stored inputs (design for atm 0.7.0)

Status: design only (phase 1, 2026-11-05, revised the same day after the owner's decisions). No code is written by this document. Three implementers share it: A builds the storage (the tables, the writer, the erasure hook, the SQLite reader), C builds the shipper that copies stored inputs to a folder or R2 and the reader for that copy, and B builds the replay and the `atm simulate --inputs` mode. The section "Interfaces" is the contract between them and section "The PR split" says which can run in parallel. The roadmap line it answers is "Simulation or what-if" in `ROADMAP.md`; the 0.6.0 command-level mode it extends is described in `README.md` ("What if (simulate)") and `src/ledger/simulate.ts`.

## The problem, in one paragraph

`atm simulate` (0.6.0) replays the log's recorded commands under a candidate catalog or deduction order. It cannot answer a what-if on the grant rules (`policy.upgradeGrant`, the rollover and gift amounts, what an invoice grants, a candidate menu's prices and tiers), because those decisions are made in `invoiceToCommands` (`src/billing/grants.ts`) from Stripe events before a command is recorded, and the handler keeps only event ids (`atm_event_claims`), not the events. Three pieces are needed: (A) durable storage of each handled input, (C) a way to ship those inputs off the handler's disk like the events, and (B) a simulate mode that replays the stored inputs through the same grant rules with a candidate menu and policy and sets the result against what was decided.

## The decisions, summarized

| # | Question | Decision |
|---|---|---|
| 1 | What to store | The normalized fact, trimmed to what the grant rules read (no `source`, no bearer links, no invoice number, metadata cut to `b4u_school` and `family_id`), plus the side inputs the handler took from elsewhere (the fee, the payment refs), plus a SHA-256 of the raw body. Not the raw Stripe JSON. Every handled input is stored, whatever it books. |
| 2 | Where | New table `atm_event_inputs`, keyed `(env, event_id)`, written in the same transaction as the claim's done mark and the outbox rows. Helper tables `atm_input_contexts` (menu and policy in force), `atm_input_seeds` (a holder's rows before its first stored input) and `atm_input_erasures` (shipped objects still to be rewritten after an erasure). |
| 3 | Shipping | Inputs ship like events, through the same `Store` interface (`FolderStore` now, `R2Store` by the same call): `schools/<id>/inputs/<env>/date=<UTC commit day>/batch-<first applied order>-<16 hex>.jsonl`, create-only, then `batch_key` and `shipped_at` marked in SQLite. `atm inputs ship`. |
| 4 | Erasure of shipped objects | Rewrite with a tombstone: the batch is rewritten without the erased holder's facts under a new content-addressed key (create-only), SQLite is re-pointed, the old object is deleted; a queue makes it resumable. Not crypto-shredding (section 3 has the numbers). |
| 5 | Fidelity | The decision clock is the event's `created`, not `nowMs`; ids are derived; the engine's random ids are canonicalized; the sources that were not controlled (fee, payment refs, menu and policy in force, order of handling, writes that are not Stripe inputs) are stored or detected. The baseline run must equal the recorded outbox: that identity is the first test. |
| 6 | Simulate | `atm simulate --inputs <handler sqlite file or shipped folder> --env <live\|test> ...` next to the unchanged 0.6.0 log mode. Exit 0 no difference, 1 difference, 2 bad input; a baseline that does not reproduce the log is exit 2 unless `--allow-baseline-drift`. |
| 7 | Migration | Inputs exist from the first delivery after the upgrade. A holder that already had rows is replayed from a stored seed of those rows; earlier history is `not_replayable` and the CLI says so with a count. |

## 1. What to store: measured evidence

The measurements are on the 64 Stripe events of the handler's own types in `fixtures/billing/stripe/recorded/` (the 14 top-level events, the 6 discounted invoices of `discount/` and the 44 events of `delivered/`, all at API `2025-10-29.clover`; the four `booking/` checkout-session events are not handled by the webhook handler and are left out), with throwaway scripts that were not committed (method in the last section).

### Bytes per event

| Event type | n | raw JSON, mean bytes | raw minus the mapping's `personal` paths | normalized fact (`normalize()` output) | replay fact (trimmed, see below) |
|---|---|---|---|---|---|
| `invoice.paid` | 24 | 4,242 | 4,085 | 873 | 618 |
| `customer.subscription.created` | 10 | 4,021 | 4,021 | 600 | 459 |
| `customer.subscription.updated` | 8 | 4,754 | 4,754 | 586 | 445 |
| `customer.subscription.deleted` | 1 | 3,608 | 3,608 | 463 | 322 |
| `charge.refunded` | 3 | 2,644 | 2,438 | 334 | 207 |
| `charge.dispute.created` | 3 | 2,162 | 1,237 | 294 | 160 |
| `charge.dispute.closed` | 2 | 2,540 | 1,566 | 293 | 160 |
| `invoice_payment.paid` | 13 | 655 | 655 | 294 | 162 |
| all 64 | 64 | 3,307 | 3,165 | 600 | 419 |

Totals: raw 211,671 bytes; raw after `redactPersonal` 202,554 (95.7% of raw); normalized 38,385 (18.1%); replay fact 26,821 (12.7%). The largest replay fact is an `invoice.paid` at 862 bytes. The size of the stored and the shipped row is in section 3.

### Personal data in the raw event

The recorded fixtures are scrubbed (see `fixtures/billing/stripe/recorded/README.md`), so the counts below understate what a live event holds. Where a path is present and non-null in the fixtures:

| Event | Path | Non-null / present | Covered by the mapping's `personal` list? |
|---|---|---|---|
| `invoice.paid` | `customer_name` | 22 / 24 | yes |
| `invoice.paid` | `customer_email` | 2 / 24 | yes |
| `invoice.paid` | `customer_address` (country, postal code) | 2 / 24 | yes |
| `invoice.paid` | `hosted_invoice_url`, `invoice_pdf` (bearer links to a document that shows the name and address) | 24 / 24 | no |
| `invoice.paid` | `lines.data[].description` (free text built from the product) | 33 / 33 lines | no |
| `invoice.paid` | `account_name` (the school's name) | 24 / 24 | no |
| `charge.refunded` | `payment_method_details.card` (`last4`, `fingerprint`, `exp_month`, `exp_year`) | 3 / 3 | no (the dispute mappings list `payment_method_details`; this one lists only `billing_details`, `receipt_email`, `shipping`) |
| `charge.refunded` | `receipt_url` | 3 / 3 | no |
| `charge.dispute.closed` | `evidence.customer_name` | 2 / 2 (0 / 3 on `created`) | yes (`evidence`) |

The mapping lists are in `schema/mapping/stripe.*.v1.json` (`personal`). Two consequences:

- **Raw minus the `personal` paths is not a safe store.** `redactPersonal` saves 4.3% of the bytes and still leaves a card's last four digits, fingerprint and expiry in every refund event, the receipt link, and the invoice bearer links. It is a denylist; a Stripe field added tomorrow is kept.
- **The normalized fact is nearly clean, not clean.** The fields the grant rules read hold no name, email, address or card. But the normalized invoice also carries `hostedInvoiceUrl`, `invoicePdf` and `number` (nothing under `src/` outside the mapping and the type reads them), and `metadata` copies every string pair of the checkout metadata (the caller sets those). The grant rules read only `b4u_school` and `family_id` from it (`src/billing/grants.ts:664-665` and `:1521-1522`, `src/billing/handle.ts:120`). The fact keeps `customerId` (`cus_...`) because `src/billing/money.ts:153` copies it into `payment.succeeded`. So the stored fact is an allowlist: the normalized fact minus `source`, `number`, `hostedInvoiceUrl`, `invoicePdf`, with `metadata` cut to the two keys. If `replayFactOf` proves hard to keep in step with the mappings, the owner's fallback is the full normalized fact with those four removed by the same rule; the `{"v":1,"fact":...}` shape does not change.

### Does the decision depend on anything the normalized fact lacks?

Proven by a throwaway script, not only by reading `src/billing/handle.ts:598-611` (which reads only `type` and `api_version` from the raw event and then `normalize()`s). For the 44 delivered events (8 scenarios) the script replayed, through `handleStripeEvent` with an in-memory store that evolves its rows, events cut down to exactly the paths their mapping reads (11 to 25 KB of raw JSON per scenario, down to 2.5 to 5.6 KB). The outbox it produced equaled the real handler's outbox (every body, every id) in 8 of 8 scenarios, re-run on the tree after the env-key change (#69) and the non-USD change. So the grant decision is a function of the mapped fields; everything else in a raw event is not needed for replay.

### What is lost by storing the fact and not the raw event

- A later change to the mapping (a new field, a corrected path) cannot be replayed from facts. A fact is the output of `stripe/<event>@v<n>`; the row records that label, and a new mapping version is a new label. A mapping bug that mis-read a field is baked into the stored fact; the SHA-256 of the raw body lets an operator check a re-fetched Stripe event against the row, but the re-fetch itself is out of scope (Stripe lists events only for a limited time, 30 days from memory, not checked here).
- Facts the mapping does not extract today cannot be asked later: tax lines, discounts, the customer's country, the payment method. `ROADMAP.md` already lists "no tax lines" under Taxes; if the receipt or revenue-timing work needs them, storing starts only after they are mapped.
- It is consistent with the roadmap decision of 2026-11-05 to store no raw payload for usage events ("Decisions taken"): atm keeps no raw third-party payload anywhere.

### Decision: the replay fact plus side inputs plus a hash

Store, per input: the replay fact (JSON, 419 bytes on average), the columns that are not in any event (below), and `raw_sha256` of the verified payload. Not stored: the raw JSON, any name, email, address, card detail, receipt or invoice link, the invoice number, and any metadata key but the two. Every event the handler applies is stored, including one that books only money (a refund, a payout, an `invoice_payment.paid`) or books nothing (the owner's decision: no skipping of types). The only deliveries without a row are the ones the handler itself did not handle (table below).

### Retention and erasure

- **Retention (decided):** no automatic prune. Applied inputs live as long as the database and its outbox, because they explain the outbox rows. An opt-in `atm inputs prune --before <date>` is a later item: a prune in the middle of a holder's history breaks the state continuity replay needs, so it would have to write a new seed per holder and delete shipped objects; it is not part of this design.
- **Erasure.** Today an erasure is a ledger event, `subject.erased`, with a payload `objects` listing the rewritten objects by id (`schema/payload/subject.erased.v1.json`); no code in `src/` performs it (only the type and the schema exist), and `tests/hledger-multi.test.ts` (the test "no personal data of the erased family ...", about line 593) pins that after it no event file or journal holds the erased family's personal fields while the money stays booked. Stored inputs follow the same rule: when `subject.erased` is booked for a holder, the operator calls `eraseStoredInputs` in the same transaction. It turns every input and seed of that subject into a tombstone (decided): `body`, `payment_refs`, `subject_key`, `raw_sha256` and `fee` are set to NULL, `erased_at` is set, and the seed row is deleted. The tombstone keeps `env`, `event_id`, `school_id`, `type`, `api_version`, `mapping`, `stripe_created`, `outcome`, `applied_order`, `atm_version`, `batch_key`, which name no person. Replay then excludes that holder and reports `erased: n inputs`; its recorded events (already redacted by the erasure) are carried over unchanged. The ledger's money stays; so do the stored inputs of other holders. What erasure does to objects already shipped is section 3.
- A stored fact holds pseudonymous ids (`family_id`, `cus_...`). They count as personal data only while the family service can map them to a person; that mapping is the family service's to delete, and `eraseStoredInputs` removes the facts that carry the ids.

## 2. Where: the table, the transaction, the columns

### The transaction

`handleStripeWebhook` already commits claim done, rows and outbox rows in one transaction (`src/handler/stripe-webhook.ts`, `applyOnce` from line 593; the commit is `deps.db.transaction` in `settle`, line 740). The input row is written inside the same transaction:

| Where | Line (at the merge of #69 and #68) | Write |
|---|---|---|
| `applyOnce`, after the outbox append (648) and the index writes (649-662), before `finishClaim` (664) | `applied` (also an `applied` that ends `non_usd`) | the input row with outcome `applied`, the seed if it is the holder's first stored input, the context row if new |
| `applyOnce`, the `result.refused` branch (637-640) | a 422 refusal | an upsert with outcome `refused` and `reason`; not for the retryable 409 reasons (`unmatched_invoice`, `unknown_subscription`), which are waits and become `applied` on the retry |
| `recordPaymentOnce`, before `finishClaim` (825) | `invoice_payment.paid` applied | the input row (it teaches the payment index, so it is part of the history) |
| not stored | `ignoreUnmapped`, `ignoreForeign` (another product's event; it has no family and decides nothing, and storing it would copy another product's data), pre-claim refusals (`school_mismatch`, `ambiguous_payment`, `livemode_mismatch`, `bad_request`, `bad_signature`), 409 waits, an event that does not normalize | nothing to decide or nothing to replay; `atm_event_claims` still records the foreign ones |

A storage error throws inside the transaction: nothing is committed, the claim stays `claimed`, the handler answers 500 and Stripe retries (the same rule as any error in `applyOnce`). The invariant "every applied event has its input" is worth that.

### Stripe order races and the applied order

`invoice_payment.paid` can beat `invoice.paid` (409 `unmatched_invoice` until the invoice is indexed) and a refund answers 409 `unmatched_payment` until its payment is linked (the table at the top of `src/handler/stripe-webhook.ts`). So the order Stripe created events in is not the order the handler applied them in. In the recorded deliveries the applied order differs from the created order in 6 of 8 scenarios. `applied_order` (an `AUTOINCREMENT` rowid assigned inside the write transaction, which `BEGIN IMMEDIATE` serializes) is the order of replay. A refused row that is later applied is deleted and re-inserted, so it gets its new order. Order matters for the rules too: `ROADMAP.md` records that two raise invoices delivered out of order grant 3 in total where in order they grant 2 + 2.

### The exact DDL

Added to `HANDLER_DDL` in `src/handler/schema.ts`, in the same shape #69 gave the other four tables: `env` is a column with `CHECK (env IN ('live', 'test'))` and part of every key. Every statement is `IF NOT EXISTS`, so the new tables are additive on an existing database and `migrateHandlerSchema` (which rebuilds only the four older tables) needs no new step. Plain SQL only (no `STRICT`, no generated columns, no trigger, no `RAISE`), as the family service's Litestream requires (`buzz-school` `packages/family-service/AGENTS.md` and the header of its migration 0081); `json_valid` in a `CHECK` is already used by `atm_rows`.

```sql
-- One row per handled Stripe input: what the grant rules need to decide it again. env is part of the key (the same
-- Stripe id can arrive under both modes). applied_order is the order the handler applied the inputs in (a refused row
-- takes a new one when it is applied). body is the replay fact, never the raw event. batch_key and shipped_at are the
-- shipper's marks, as on ledger_outbox.
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
  batch_key TEXT,
  shipped_at INTEGER,
  UNIQUE (env, event_id),
  CHECK ((outcome = 'refused') = (reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS atm_event_inputs_subject
  ON atm_event_inputs (env, school_id, subject_key, applied_order);
CREATE INDEX IF NOT EXISTS atm_event_inputs_unshipped
  ON atm_event_inputs (env, school_id, applied_order) WHERE shipped_at IS NULL;

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
  shipped_at INTEGER,
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
  shipped_at INTEGER,
  PRIMARY KEY (env, subject_key)
) WITHOUT ROWID;

-- Shipped objects that hold an erased holder's facts and are still to be rewritten or deleted (section 3). One row per
-- object; done_at is set when the old object is gone.
CREATE TABLE IF NOT EXISTS atm_input_erasures (
  env TEXT NOT NULL CHECK (env IN ('live', 'test')),
  school_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('batch', 'seed')),
  queued_at INTEGER NOT NULL,
  replacement_key TEXT,
  done_at INTEGER,
  PRIMARY KEY (env, school_id, object_key)
) WITHOUT ROWID;
```

### Why each column

| Column | Why it is there |
|---|---|
| `applied_order` | the replay order (above). |
| `env`, `event_id` | the key, as in #69: the same Stripe id under both modes is two rows. |
| `school_id`, `subject_key` | which holder the input belonged to (`<school>\|<env>\|family:<id>`; a payout uses `stripe:payouts`), resolved by `locateSubject` at handling time. NULL after erasure. |
| `type`, `api_version`, `mapping`, `livemode` | which mapping read the event (`stripe/invoice.paid@v1`), so a fact is attributable to the code that made it. |
| `stripe_created` | the decision clock: `now = event.created * 1000` (`stripe-webhook.ts:630`); also the seed of the event's ULID (`:617-621`). |
| `received_at` | `deps.nowMs()` at commit; information only (it decides nothing), and the day a shipped batch is filed under. |
| `outcome`, `reason`, `attempts` | `applied`, or `refused` with the 422 reason code (`unmatched_line`, `addon_only_subscription`, `tier_on_other_subscription`, `missing_metadata`, `rejected`, `bad_event`); how often Stripe has retried it. The message is not stored (it quotes event content). |
| `revision_before`, `revision_after` | the holder's revision when the input was handled and after its write. The replay checks that its own revision equals `revision_before` at every step; a mismatch means a write that is not a Stripe input happened in between (a spend, a lapse, an import), which the driver then interleaves from the log or reports (section 4). |
| `atm_version` | the package version that decided it, so a baseline mismatch is attributable to a code change. |
| `context_hash`, `menu_version`, `policy_version` | the menu and policy in force (`deps.context(school)` is called inside the transaction at every event, `stripe-webhook.ts:609`). The versions end up in event labels (`menu_version`, `policy_version`), so they matter for identity. |
| `fee` | the result of the caller's `paymentFee(raw)` hook: an outside read of Stripe the fact does not contain. |
| `payment_refs` | the payment intent and charge ids the invoice paid with, from the `paymentRefs` hook or the expanded `invoice.payments` (`invoiceRefsOf`, `:275`): they feed `atm_payment_index`, which later finds the invoice of a refund. Not in the normalized fact. |
| `raw_sha256` | proof of provenance without keeping the payload. |
| `body` | the replay fact: `{"v":1,"fact":{...}}`. |
| `erased_at` | the tombstone mark. |
| `batch_key`, `shipped_at` | where and when the shipper put the row; NULL until shipped. After an erasure rewrite `batch_key` points at the replacement object. |

### The writer in one sentence per piece

- One normalization: `handleStripeEvent` and the handler share `normalizeStripeEvent` (extracted from `handle.ts:598-611`), so the fact the handler stores is the fact the rules decided on.
- The context row is written when its `(env, school_id, context_hash)` is new. Hashing a 2.1 KB menu, policy and price-id map costs 0.013 ms per event (measured, 2,000 runs), so it is hashed on every event.
- The seed is written when the holder has rows (`loadSubject`, `:522`, already loaded in `applyOnce`) and no stored input or seed yet.

### The env keys and the migration: done in #69

The correctness PR (#69) is merged: `atm_event_claims`, `atm_invoice_index` and `atm_payment_index` are keyed `(env, id)` and `ledger_outbox` `(school_id, env, id)` with `UNIQUE (school_id, env, idem)`, `env` is `CHECK (env IN ('live', 'test'))` with `DEFAULT 'live'`, and `migrateHandlerSchema(db): HandlerMigrationResult` rebuilds an older database table by table in one transaction (new table, copy, count check, drop, rename; a no-op on a current database; `assertCurrentSchema` and `tablesWithoutEnv` are its guards, `appendToOutbox(db, events, env)` its writer). This design follows it:

- The new tables use the same `env` column and the same key shape; they are created by `HANDLER_DDL` and need no rebuild. `migrateHandlerSchema` is not changed.
- The writer takes the handler's `env` (`resolveEnv(deps.env)`) for every statement, as the claim and index statements do, and reads rows with `WHERE env = ?`.
- #69 did not put `env` into the derived ULID (`deterministicUlid` over `[school, event.id]` is unchanged, `docs/log-and-r2.md#env-on-the-handlers-tables`), so `inputCauseId` below is that same computation in one place and takes no `env`.
- #69 leaves open that the events log has no env (a school's test and live events share `schools/<id>/events/`). The inputs do not inherit that: they are shipped under `inputs/<env>/`.
- The old databases carry no inputs, so nothing in `migrateHandlerSchema` has to move them (section 6).

## 3. Shipping the inputs

Decision of the owner: stored inputs ship like events, to a local folder first and to R2 by the same call, through the `Store` interface (`src/store/store.ts`: `putIfAbsent`, `get`, `head`, `list`, `delete(key, expectedSha256)`). The pattern is `shipOutbox` (`src/ledger/ship.ts`): plan the unshipped rows as batches, create-only put each (`putOnce`: equal bytes already there is an earlier try that landed, different bytes is a `Conflict` that alerts and never overwrites), then mark the rows. What differs from events is that inputs can be erased and that a replay needs them in a total order.

### (a) Object layout and names

Under the school's prefix, next to `events/` and never inside it (`listEventFiles` reads only `schools/<id>/events`, so the journal and every 0.6.0 reader are untouched):

```
schools/<school>/inputs/<env>/date=<YYYY-MM-DD>/batch-<first applied_order, 12 digits>-<16 hex of sha256 of the text>.jsonl
schools/<school>/inputs/<env>/contexts/ctx-<context_hash>.json
schools/<school>/inputs/<env>/seeds/seed-<16 hex of sha256 of the subject_key>.json
```

- **A prefix per env** (`inputs/<env>/`), unlike events: the inputs are keyed by env in SQLite, a test and a live endpoint can reuse a Stripe id, and a replay of one env must not read the other's. (The events log has no env, which #69 left open.)
- **The day is the UTC date of `received_at`, the commit time, not the event date.** Events are partitioned by the school-local event date because the journal is by month. A replay needs the order the handler applied them in, and a day of commit times is a contiguous run of `applied_order`; the first order in the name makes `list` order (date, then name) the replay order. It also needs no time zone (the shipper does not load the menu), and a row can never arrive for a day that has closed.
- **One batch per ship run per day**, the unshipped rows of that commit day in `applied_order`, as the outbox shipper plans them. The key carries the first order and the first 16 hex digits of the SHA-256 of the text, so the same rows give the same key and bytes on every try and on every shipper, and different rows another key (two honest shippers do not conflict). A cron every 5 minutes would make up to 288 objects a day; the recommendation is an hourly run (at most 24 a day per env). There is no `day.jsonl` combine for inputs in this design; the events combine is still open (`docs/log-and-r2.md`) and inputs wait for it.
- **A line is a row**: the table's columns under their names, `body` replaced by the parsed `fact`, `batch_key` and `shipped_at` left out (local bookkeeping), canonicalized (`canonicalize` from `src/ledger/util.ts`: sorted keys, no spaces) so the bytes are stable, one line per input, no newline inside. An erased row ships as a tombstone line: the same columns with `fact`, `subject_key`, `payment_refs`, `fee` and `raw_sha256` null and `erased_at` set. The planner refuses, as `planOutbox` does, a line with a newline, a date that is not `YYYY-MM-DD`, or an id that is not plain characters.
- **Contexts and seeds are separate objects**, written before the batches that refer to them. A context is immutable and named by its hash (create-only is exact); a seed is written once and named by a hash of its holder so the file name does not carry the family id. Both are created only when their `shipped_at` is NULL.
- Size: a shipped line averages about 1.2 KB (the 419-byte fact plus about 750 bytes of column names and values; one measured `invoice.paid` line was 1,518 bytes with a 763-byte fact). At three events per family-month (an assumption) 1,000 families ship about 3.6 MB a month, 43 MB a year, in at most 24 objects a day; reading a year back is about 9 `list` pages of 1,000 keys and up to 8,760 `get` calls, which is why the combine matters later.

### (b) The command, the flags and the configuration

`atm inputs ship` mirrors `atm ship` (`src/cli.ts`: `ship` at line 218, exit codes 0 done, 1 conflict, 2 any other error, cron-friendly, `--json` one line):

```bash
atm inputs ship --db <handler.sqlite> --school <id> --env <live|test> --root <folder>            [--json]
atm inputs ship --db <handler.sqlite> --school <id> --env <live|test> --r2-bucket <b> --r2-endpoint <url> [--r2-prefix <p>] [--json]
```

- **Destination.** Exactly one of `--root <folder>` (a `FolderStore`; like `atm ship` the folder must exist, so that a typo ships nothing) or `--r2-bucket` (an `R2Store`). Both given is exit 2. The R2 flags are the non-secret parts of `R2StoreOptions` (`endpoint`, `bucket`, `prefix`).
- **Configuration and precedence.** The CLI reads no configuration file and no environment variable today, and this design adds neither a file nor a secret flag. Precedence, highest first: (1) the flags above; (2) environment variables for the same non-secret values (`ATM_R2_ENDPOINT`, `ATM_R2_BUCKET`, `ATM_R2_PREFIX`), used only when neither `--root` nor `--r2-bucket` is given; (3) nothing, which is exit 2. The R2 credentials come only from the environment (`ATM_R2_ACCESS_KEY_ID`, `ATM_R2_SECRET_ACCESS_KEY`, optional `ATM_R2_SESSION_TOKEN`), never from a flag (a flag shows in the process list). The library takes any `Store`, so a service that already holds an `R2Store` calls `shipInputs` directly, as it calls `shipOutbox`.
- **Build order and honesty.** The folder path is built and tested first. The R2 flags use the same `shipInputs` call; as for `atm ship` it has not been run against R2 or SeaweedFS, and the contract suite has never run against staging R2 (`ROADMAP.md`). The PR that adds the R2 flags says so.
- **One run does, in order:** settle the erasure queue (below); put the unshipped contexts; the unshipped seeds; the unshipped input batches; mark each batch's rows with the key and `shipped_at` in one transaction, only rows still unshipped, by `applied_order` and unchanged `body` (as the outbox shipper marks by id and body). Exit 0 when done or nothing to do; 1 when a key already holds different bytes (conflict line on stderr, rows left unshipped) or an erasure is still pending after the run; 2 otherwise.
- **Cron order:** `atm inputs ship` before `atm ship`, so that every event in the log has its input already shipped.

### (c) The reader for a folder (and a store) behind the same interface

`atm simulate --inputs <path>` takes either a handler SQLite file or a shipped folder (a file is read as SQLite, a directory as a store root). Both are an `InputsSource` that returns the same `InputsRead` (section 7), so the replay does not know which it got:

- **Folder or any `Store`:** list `schools/<school>/inputs/<env>/date=*/` in key order, read every `batch-*.jsonl`, list and read `contexts/` and `seeds/`; build `InputsRead`. Several lines for one `(env, event_id)` (a crash between put and mark, a rewrite window) are reduced by one rule: an erased line beats an unerased one, an `applied` line beats a `refused` one, else the lowest `applied_order`. A line whose `context_hash` has no context object is kept and the holder is reported `not_replayable` with the reason `context_missing`. Refused rows are not shipped (OWNER DECISIONS), so `refused` is empty from a folder.
- **SQLite:** the same shape from the tables (including refused rows).
- The folder source is read-only and lists the whole prefix; no manifest is needed because every object is create-only and content-addressed, apart from the erasure rewrite below.

### (d) Erasure of shipped objects

Events are append-only and an erasure of an event is a rewrite of the object (`subject.erased` names the objects it rewrote). For inputs the erasure has to reach the shipped batches that hold the holder's facts, and the create-only put stands in the way of overwriting a key. Two ways were weighed.

**Rewrite with a tombstone, recommended.** The batch is rewritten and filed under a new key; nothing is ever overwritten.

1. `eraseStoredInputs` (in the transaction that books `subject.erased`) tombstones the rows in SQLite as in section 1, deletes the seed, and queues one `atm_input_erasures` row for every shipped batch that held one of the holder's rows (found by `batch_key`) and for the holder's shipped seed object. The SQLite change is atomic and final; nothing is left in SQLite.
2. The next `atm inputs ship` settles the queue before anything else. For each batch: read the old object; replace each line whose `(env, event_id)` is now a tombstone in SQLite with the tombstone line; the new text has a new hash, so a new key `batch-<same first order>-<new hash>`; `putOnce` it (create-only; an equal object left by a crashed run is "existing"); in one SQLite transaction point `batch_key` of every row of that batch (other holders' rows included) at the new key and set `replacement_key`; then `store.delete(oldKey, oldSha256)` (it checks the sha, then deletes; R2 has no conditional delete, which is fine for a key atm owns) and set `done_at`. A seed object is simply deleted the same way.
3. **Atomicity.** There is none across the two objects, and the design does not pretend there is. The order put-new, then re-point, then delete-old means a crash at any point leaves either the old object only (queue row not done, retried), both (queue row has `replacement_key`, the delete is retried), or the new object only (done). The retry is idempotent: `putOnce` finds the new object, the delete of a missing key returns false. While both exist the old object's bytes still hold the facts. The reader rule (an erased line beats an unerased one) means no consumer reads them as live, but the bytes are on the disk or bucket until the delete lands. That window is one ship run; `atm inputs ship` exits 1 while a queue row is open, so a cron alerts, and `inputsShipStatus` reports the count and age.
4. Cost: one `get`, one `put`, one `delete` per batch the holder has rows in (a holder with three events a month for three years touches at most about 100 batches).

A "versioned overwrite" of the same key, `Store.putIfMatch(key, body, etag)`, would be atomic per object (one request, no second copy, no delete) and is the alternative. It is not recommended: it breaks the key-names-its-content rule (the hash in the name stops matching), it leans on conditional PUT semantics on R2 that this repository has not exercised (the contract suite has never run against R2), and the reader and the shipper's conflict check were written for immutable objects.

**Crypto-shredding, not recommended.** Ship the subject's ids encrypted or pseudonymized under a per-holder key kept in SQLite and erase by deleting the key. It would make an erasure one atomic SQLite delete with no rewrite. Checked against what a stored fact holds, on the 64 recorded facts (`ids.ts`, throwaway):

| What is in the line | Count |
|---|---|
| facts that carry `family_id` or a `cus_` id | 43 of 64 (67%) |
| facts that carry at least one other Stripe id (`in_`, `sub_`, `pi_`, `ch_`, `evt_`) | 64 of 64 (100%) |
| bytes of the facts that are Stripe ids (without the family id) | 5,798 of 24,794 (23%) |

- Pseudonymizing only `family_id` and `cus_` leaves every line joinable to the customer by anyone who holds the school's Stripe account (`in_`, `sub_`, `pi_`, `ch_` and `evt_` resolve there), and the amounts and times are quasi-identifiers on top. To make a line unlinkable the ids, amounts and times must all be encrypted, which is almost the whole body (`type`, `env`, `school` and the order would stay clear).
- A salted hash does not work: replay must reproduce the recorded decision events and those embed the raw ids (`idem` is `stripe:<id>`, `src/billing/money.ts`; `payment.succeeded` carries the customer id). So the fields would have to be reversibly encrypted, and a replay from the folder then needs the key table in SQLite: the shipped copy stops being an independent record, `atm simulate --inputs <folder>` stops working without the database, and losing the table loses every shipped input.
- The keys live in the database, so they live in its Litestream snapshots until those expire: the shredding is as strong as backup retention.
- A per-school salt, as first suggested, cannot erase one holder (deleting it erases everyone), so it would have to be per holder in any case.

**The privacy consequence, measured honestly.** Under either choice the shipped inputs are not more identifying than the log already shipped: every event in `schools/<id>/events/` carries the holder's key (`family:<id>`) and an `idem` of `stripe:<invoice, event or payout id>`, and the existing erasure leaves those and the money (`tests/hledger-multi.test.ts`). A shipped input line holds those same ids, plus the price ids, quantities and times of the Stripe event. What erasure removes from the inputs is therefore the same class of data it removes from the events (the personal fields), and more (the facts that tie the ids to a holder). The rewrite recommended here goes further than the events do; crypto-shredding would go further still and cost the replay. Two limits apply to both: a bucket with versioning, replication or backups keeps deleted objects (that must be off for the inputs prefix, or purged as part of the erasure), and the SQLite file's own backups keep the facts until they expire.

### (e) Ordering and consistency between SQLite and the shipped copy

- **SQLite is the source of truth; the folder is a one-way replica.** The shipper reads the unshipped rows with a plain select (only committed rows are visible), so it never ships a row that a rolled-back transaction wrote.
- **Erased rows ship as tombstones, never as facts.** A row erased before it was shipped is read as a tombstone and shipped as one; the shipper selects `body` only for rows with `erased_at IS NULL`.
- **Crash between put and mark.** The batch key and bytes depend on the rows alone, so a rerun finds its object ("existing") and marks. If rows were committed for the same day meanwhile, the rerun puts a second, overlapping batch under another key; the reader reduces repeated `(env, event_id)` lines (equal bytes for the same row), so replay is right and the files hold some lines twice until a combine, as `docs/log-and-r2.md#two-shippers` describes for events.
- **Order of commit and order of application.** With `BEGIN IMMEDIATE` (`bunSqlite`) one writer runs at a time, so `applied_order` is also the commit order. The reader does not depend on that: it sorts every line by `applied_order` across all batches.
- **Lag.** The log and the inputs are shipped by separate runs. `simulate` over a folder reports a recorded handler decision with no shipped input as `not_replayable` with the reason `inputs_not_stored` and the hint "or not shipped yet: run `atm inputs ship`"; running the inputs shipper before the events shipper keeps that from happening for events that are in the log.
- **Erasure queue.** A queue row stays until `done_at`; until then the consumer rule above holds and the shipper reports it.

## 4. Replay fidelity

To reproduce a decision the replay needs the same inputs, the same order, the same clock, and the menu and policy in force. `handleStripeEvent` is pure (`src/billing/handle.ts:1-12`: no clock read). The table lists every source of non-determinism found in `handleStripeEvent`, `invoiceToCommands` and what the handler passes in, and how replay controls it.

| # | Source | Where | How replay controls it |
|---|---|---|---|
| 1 | The clock | the handler reads `deps.nowMs()` for claims, signature tolerance and `done_at` only. The engine gets `now: event.created * 1000` (`stripe-webhook.ts:630`). | Replay uses `stripe_created * 1000`. No clock is read. Proven: the handler ran with a clock set to created + 1 s and the replay with none, same outbox. |
| 2 | The input event id (`cause` of every decision event, id of every command) | `deterministicUlid({ timeMs: created*1000, revision: 0, seed: canonicalize([school, eventId]) })` (`:617-621`); unchanged by #69, no env in the seed | Recomputed from `(school_id, event_id, stripe_created)` by `inputCauseId`. Not stored. |
| 3 | The decision events' own ids | `deterministicUlid` includes 24 bits of the holder's revision, so an event's id depends on how many writes the holder had before it. | The revision must match at every step: `revision_before` is checked. (Seen in the experiment: one refused event lowered a revision and changed 1 character of the ids that followed.) |
| 4 | Random rollover ids | the engine mints random KSUIDs for rollover rows | `canonicalRolloverIds` (`src/ledger/run.ts`) rewrites each to `roll_<commandId>_<n>` in every mutation. Already done on both sides. |
| 5 | The process time zone | the engine adds months in local time | `withUtc` (`run.ts`) pins `TZ=UTC` around each engine call. Proven: the outbox hash of all 8 scenarios is the same under TZ UTC, America/Denver, Pacific/Auckland and Asia/Kolkata. |
| 6 | The runtime's time zone database | `wallMs` in `grants.ts` uses `Intl.DateTimeFormat` with `menu.timeZone` | Not controlled; the same runtime gives the same result. A replay on a newer ICU could differ across a changed zone rule. Reported as uncertain; `atm_version` does not capture it. |
| 7 | Payment fee | `deps.paymentFee(raw)`, an outside read | Stored in `fee`; replay passes it as `input.fee`. |
| 8 | Payment refs | `deps.paymentRefs(raw)` and `invoice.payments` of the raw event | Stored in `payment_refs`; replay writes its own index from them. |
| 9 | The payment and invoice index tables | `atm_invoice_index`, `atm_payment_index`, read in `locateSubject` (`:372`) to give `invoiceIds` to a refund or dispute, now inside one env | Replay keeps its own two maps per env, written in the order of replay by the same rules as the handler: first write wins (`ON CONFLICT DO NOTHING`); an `invoice.paid` indexes the invoice and its `payment_refs`; an `invoice_payment.paid` indexes its refs. |
| 10 | `hits[0]` of an unordered join in `locateSubject` | `:408` | Only used when all hits name one subject (more than one is `ambiguous_payment`), so the order does not matter. Replay does the same. |
| 11 | The menu, policy, versions, catalog and price ids in force | `deps.context(school)`, read per event | The context row (`context_hash`) holds the menu, policy and price ids; the catalog is `menuCatalogRows({ menu, school, env })`, rebuilt. Baseline uses each input's own context; the candidate replaces it (from `--effective-from` or from the start). |
| 12 | The holder's rows and revision | loaded from `atm_rows` | Replay evolves its own rows from the seed (or from none) with `applyRowChanges`. |
| 13 | Writes that are not Stripe inputs | the family service's `track`, `finalize`, `confirmExpiredLock`, `updateBalance`, `recordLapse` (`recordEngineCommand`, `src/ledger/outbox.ts`); the caller-row import | These change the rows a later `reset` or refund reads (a reset rolls over what is left), so a replay from Stripe inputs alone drifts. Detected by `revision_before` and handled by interleaving the log's own commands (below). |
| 14 | The order of handling | Stripe order races (above) | `applied_order`. |
| 15 | Repeat deliveries | the claim `ON CONFLICT (env, event_id) DO NOTHING`; the outbox `ON CONFLICT (school_id, env, idem) DO NOTHING` | One input row per `(env, event_id)`; replay drops a repeated `idem`, first wins. |
| 16 | The code | the grant rules change between releases | `atm_version` per row. A baseline mismatch under a newer version is a finding (a code change would have decided differently), reported as drift. |
| 17 | A non-USD money line | a `money.skipped` marker replaces the line (`stripe-webhook.ts`, outcome `non_usd`) | Pure in the facts (`currency` is in the fact), so replay makes the same marker. |

### The proof run (throwaway, not committed)

A script built the real handler over each of the 8 `delivered/` scenarios (retrying 409s as Stripe does, remembering the order of application), then replayed the stored inputs through `handleStripeEvent` with an in-memory store: the rows evolve with `applyRowChanges`, the two index maps are rebuilt, the decision events are deduped by `idem`. Result: in 8 of 8 scenarios the replayed events equal the handler's outbox byte for byte, run twice and under four time zones, before and after the merge of #69. Replaying in Stripe's created order instead of the applied order also matched on these fixtures, but that is not evidence that order is irrelevant: the script did not model the handler's waits (its driver indexed a payment before its invoice, and refused one dispute that had no link yet), and the fixtures hold no out-of-order raise invoices, which `ROADMAP.md` says do depend on order. The stored order is `applied_order`, not `stripe_created`.

### The log's own commands are interleaved

Replay of Stripe inputs alone is exact only for a holder whose every write was an input. When the family service also spent credits, a later `reset` or refund ran on rows the replay would not have. The design does not give up on those holders. Each stored input records `revision_before`. The log's events carry the engine mutation with `revision.before` and `revision.after` (`src/ledger/replay.ts`, `recordedMutations`). So per holder the driver builds one timeline:

1. Items are the stored inputs (applied) and the log's commands whose `cause` is not the `inputCauseId` of a stored input (the carried commands: spends, lapses, adjustments).
2. They are ordered by the recorded revision (`revision_before` of an input, `revision.before` of a command), ties by `applied_order`, then the log's order. The order is fixed from the recorded history; the candidate then evolves its own revision.
3. An input runs through `handleStripeFact` on the candidate's rows. A carried command runs through the same engine path `simulate()` uses (`runOnState` with `withPolicy`) on the same rows, converted with `stateFromRows` and written back with `rowChangesFromMutation`.

B may ship this in two steps: first holders with no carried commands (every `revision_before` matches), reporting the others as `not_replayable` with the reason `non_input_writes`, then the interleave. The baseline test below decides when a holder counts as replayable: its baseline must equal the log.

### What cannot be replayed

- Inputs not stored (handled before the upgrade, or foreign, or never normalized, or not yet shipped when reading a folder): `not_replayable`, with a count.
- A holder whose pre-upgrade rows are not in a seed (should not occur once A is deployed; a seed is taken at the first stored input).
- Erased holders (tombstones).
- The caller-row import (`grantsStateFromCallerRows`, `src/billing/adopt.ts`) writes rows with no input: for a holder imported after its seed it is a revision gap with no carried command in the log, reported as `non_input_writes`.

## 5. The simulate mode

`simulate()` and `atm simulate` of 0.6.0 stay as they are, byte for byte (same function, same flags, same golden files). A new function and a new set of flags select the inputs mode.

### What it does

For one school and one env:

1. Read the log events (`--root`, `--school`, as in 0.6.0) and the stored inputs (`--inputs`, `--env`): from a SQLite file or a shipped folder, through the same `InputsSource`.
2. Classify: the log's events whose `cause` is an `inputCauseId` of a stored input are decisions of that input. Other events are carried (money, payouts, disputes, and the family service's commands). The log has no env (`docs/log-and-r2.md`): serve each env from its own database and shipper, as the docs recommend, or the other env's events are carried as if they were the family service's.
3. **Baseline.** Replay every replayable holder's timeline with each input's own recorded context. The decision events must equal the log's, by `idem` and canonical body. The result is `baseline: { identical, inputs, differing: [...] }`. Not identical is exit 2 (the replay cannot be trusted as a basis for a what-if) unless `--allow-baseline-drift`, which keeps going and reports the drift next to the diff. This is the owner's decision.
4. **Candidate.** Replay again with the candidate menu and policy replacing the recorded context, from `--effective-from` (default: from the beginning). No candidate flags at all is the identity: exit 0 if the baseline holds.
5. **Diff**, three views:
   - **per delivery:** for each stored input, what was decided (from the log: events, units granted and taken back per feature, the refusal) against what the candidate decides, with `kind`: `same`, `changed`, `newly_refused`, `newly_applied` (a stored 422 refusal the candidate accepts; only from a SQLite source), `no_longer_applied`;
   - **per holder:** balance by feature, recorded against candidate (`AtmBalance`, as 0.6.0);
   - **journal:** posting totals by month, account and commodity, and the transaction count per month (the 0.6.0 shapes `AtmSimulatePostingChange` and `transactions`).

A candidate that makes a command the engine refuses, or an input that the grant rules refuse, is listed with its reason; the holder's replay goes on from the state before it, as in 0.6.0, and everything after the first one is the candidate's own history.

### The CLI

```bash
atm simulate --root <folder> --school <id> --inputs <handler.sqlite | shipped folder> --env live \
  [--menu candidate-menu.json] [--policy candidate-policy.json] \
  [--effective-from 2026-03-01T00:00:00Z] \
  [--current-menu menu.json] [--current-policy policy.json] \
  [--month 2026-05] [--allow-baseline-drift] [--json]
```

- `--inputs` takes the handler's SQLite file (opened `readonly`) or a directory that is a store root with `schools/<id>/inputs/<env>/` (a `FolderStore` read). A file is SQLite, a directory is a folder. An R2 source is the library's `storeInputsSource(new R2Store(...))`; the CLI flags for it follow the ones `atm inputs ship` proves.
- `--env` is required with `--inputs`.
- `--current-menu` and `--current-policy` override the recorded context for the baseline (the log's side); normally unneeded.
- The 0.6.0 flags `--catalog` and `--current-catalog` are refused with `--inputs` (the catalog follows the menu).
- Exit codes: **0** no difference; **1** a difference (a CI check can gate a menu or policy change on it); **2** input it cannot use, one line on stderr, `{"ok":false,"error":...}` with `--json`: missing option, unreadable file, no `atm_event_inputs` table, no stored inputs for that school and env, a folder with no `inputs/<env>/` prefix, a candidate that fails `validateMenu` or `resolvePolicy`, a log `replayEvents` refuses, a baseline that does not equal the log (unless `--allow-baseline-drift`).

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

## 6. Migration of existing databases

A database that predates the storage has no `atm_event_inputs` table and no stored input. The feature is unavailable for its earlier history, and the CLI says so:

- `inputsStatus` returns `{ available: false, reason: "no_table" }` (the table does not exist yet: the handler of this version creates it on start) or `reason: "empty"` (the table exists and holds nothing for the school and env).
- `atm simulate --inputs` on such a database exits 2 with: `this database holds no stored inputs for school <id> (live): the handler stores them from atm 0.7.0, so a what-if on the grant rules covers only the history after that; run atm simulate without --inputs for the command-level what-if on the whole log`. On a folder: `no inputs under <folder>/schools/<id>/inputs/live: run atm inputs ship, or point --inputs at the handler's database`.
- After the upgrade, every delivery is stored, and each holder that already had rows gets a seed at its first stored input, so its later history is replayable without the history before it. Earlier decisions of that holder are carried over unchanged and counted.
- Nothing is backfilled: the raw events are not in the database and re-fetching them from Stripe is out of scope.
- A database from before #69 is rebuilt by `migrateHandlerSchema` as before; the order of the two does not matter (`HANDLER_DDL` creates the new tables whether or not the four older ones are current).

## 7. Interfaces

Shared by A (storage), C (ship) and B (simulate). Names are the contract; fields may gain optional members, not lose any. Types live in `src/types.ts` with the other public declarations; code in the files named.

### Shared pieces (A creates; B and C import)

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

/**
 * The ULID a decision event names as its `cause`; the one place it is computed (replaces the inline call in
 * stripe-webhook.ts). Unchanged by #69: `deterministicUlid` of the school and the Stripe event id, no env in the seed.
 */
export const inputCauseId = (args: {
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
// src/billing/handle.ts (A, small refactor of lines 598-611; no behaviour change)

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
  batchKey: string | null;    // set by the shipper
  shippedAt: number | null;   // set by the shipper
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
      unshipped: number;                       // applied or erased rows with shipped_at NULL
      firstStoredAt: number; lastStoredAt: number; // received_at, ms
      schools: string[]; envs: AtmEnv[]; atmVersions: string[];
    };

/** What a database holds, never throws on an older database (no table is `available: false`). */
export const inputsStatus = (db: SqlDatabase, filter?: { env?: AtmEnv; school?: string }): InputsStatus;

export type InputsRead = {
  inputs: StoredInput[];                       // applied and erased, ordered by appliedOrder
  refused: StoredInput[];                      // 422 refusals, ordered by stripeCreated; empty from a shipped folder
  seeds: Map<string, StoredSeed>;              // by subjectKey
  contexts: Map<string, StoredContext>;        // by contextHash
  /** Where it came from, for messages: a file path, a folder, or "store". */
  origin: string;
};

/** What B reads; the SQLite, the folder and any Store implement it, so the replay does not know which it got. */
export interface InputsSource {
  read(filter: { env: AtmEnv; school: string }): Promise<InputsRead>;
}

export const sqliteInputsSource = (db: SqlDatabase): InputsSource;

/** Erasure hook. Call in the transaction that books `subject.erased` for the holder. Idempotent. */
export const eraseStoredInputs = (db: SqlDatabase, args: {
  env: AtmEnv; school: string; subjectKey: string; nowMs: number;
}): { inputs: number; seeds: number; queued: number };
```

`HANDLER_DDL` gains the four tables. `WebhookDeps` gains nothing required; `atmVersion` is a module constant, not a dependency.

### Shipping (C)

```ts
// src/ledger/ship-inputs.ts

/** What a shipped line holds: the row's columns under their names, `body` as `fact`; no batch_key, no shipped_at. */
export type ShippedInputLine = Omit<StoredInput, "batchKey" | "shippedAt">; // serialized with snake_case column names, canonicalized

export type InputsBatch = {
  /** schools/<school>/inputs/<env>/date=<UTC day of receivedAt>/batch-<first appliedOrder, 12 digits>-<16 hex>.jsonl */
  key: string;
  date: string;
  orders: number[];
  text: string;
  sha256: string;
};

export const inputObjectKey: {
  batch(args: { school: string; env: AtmEnv; date: string; firstOrder: number; sha256: string }): string;
  context(args: { school: string; env: AtmEnv; contextHash: string }): string;
  seed(args: { school: string; env: AtmEnv; subjectKey: string }): string;
  prefix(args: { school: string; env: AtmEnv }): string; // schools/<school>/inputs/<env>/
};

/** Plan: the unshipped rows as batches, one per commit day, each a pure function of its rows. Throws as planOutbox does. */
export const planInputs = (args: { school: string; env: AtmEnv; rows: readonly StoredInput[] }): InputsBatch[];

export type ShipInputsInput = {
  db: SqlDatabase;
  store: Store;                    // FolderStore, R2Store, any Store
  school: string;
  env: AtmEnv;
  nowMs: () => number;
};

export type ShipInputsResult = {
  batches: { key: string; date: string; inputs: number; status: "created" | "existing" }[];
  contexts: number;
  seeds: number;
  shipped: number;                 // input rows marked
  conflicts: ShipConflict[];       // as ShipOutboxResult
  erasures: { settled: number; pending: number };
};

/** Settle the erasure queue, then put contexts, seeds and batches create-only, then mark. Safe to rerun. */
export const shipInputs = (input: ShipInputsInput): Promise<ShipInputsResult>;

/** The erasure step alone (shipInputs runs it first): rewrite or delete the queued objects. */
export const settleInputErasures = (input: ShipInputsInput): Promise<{ settled: number; pending: number }>;

export type InputsShipStatus = {
  unshipped: number;
  oldestUnshippedAgeMs: number | null;
  erasuresPending: number;
  oldestErasurePendingAgeMs: number | null;
};
export const inputsShipStatus = (args: { db: SqlDatabase; school: string; env: AtmEnv; nowMs: () => number }): InputsShipStatus;

/** The folder and the store readers: the same InputsRead as the SQLite one. */
export const storeInputsSource = (store: Store): InputsSource;
export const folderInputsSource = (root: string): InputsSource; // FolderStore over root
```

```ts
// src/cli.ts (C): atm inputs ship
//   --db <file> --school <id> --env <live|test>  (--root <folder> | --r2-bucket <b> --r2-endpoint <url> [--r2-prefix <p>])  [--json]
//   R2 credentials: ATM_R2_ACCESS_KEY_ID, ATM_R2_SECRET_ACCESS_KEY, ATM_R2_SESSION_TOKEN (environment only);
//   non-secret R2 values fall back to ATM_R2_ENDPOINT, ATM_R2_BUCKET, ATM_R2_PREFIX when no destination flag is given.
//   Exit 0 done or nothing to ship; 1 a conflict or an erasure still pending; 2 any other error (one line on stderr).
//   --json: { ok, school, env, batches, shipped, contexts, seeds, conflicts: [{key, message}], erasuresSettled, erasuresPending,
//             unshipped, oldestUnshippedAgeMs }
```

### Replay and diff (B)

```ts
// src/ledger/simulate-inputs.ts

export type InputsSimulateInput = {
  events: readonly AtmEvent[];            // the log (as 0.6.0)
  inputs: InputsRead;                     // from any InputsSource.read
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
//   --inputs <sqlite file | folder>  --env <live|test>  --effective-from <ISO instant>  --current-policy <file>  --allow-baseline-drift
// Exit codes: 0 no difference, 1 differences (a drift found with --allow-baseline-drift is reported, not counted), 2 bad input.
// --json prints { ok, school, env, baseline, deliveries (changes only), balanceChanges, postingChanges, transactions,
//                  notReplayable, replayed, refused, unaffected, differences, asOf, summary } on one line.
```

## 8. The PR split

| Piece | A1: pure refactor | A2: storage | C: ship | B: simulate |
|---|---|---|---|---|
| `normalizeStripeEvent`, `handleStripeFact`, `replayFactOf`, `inputCauseId`, `contextHashOf`, the fact types | yes | uses | uses | uses |
| `HANDLER_DDL` tables, `recordInput`, the writes in `stripe-webhook.ts`, `inputsStatus`, `sqliteInputsSource`, `eraseStoredInputs` (tombstones, seeds, queue rows) | no | yes | uses | `sqliteInputsSource` |
| `planInputs`, `shipInputs`, `settleInputErasures`, `inputsShipStatus`, `storeInputsSource`, `folderInputsSource`, `atm inputs ship` | no | no | yes | `folderInputsSource` |
| `replayInputs`, `simulateFromInputs`, the CLI flags | no | no | no | yes |
| README, UPGRADING, CHANGELOG notes | no | the storage, the erasure rule, the new tables | the shipper, the layout, the flags | the mode and flags |

PR A is the storage: the tables, the write, the helpers and the erasure hook (no salt: crypto-shredding was not chosen). It may be one PR; splitting the pure refactor out as A1 (about 150 lines, no database) lets B start earlier. PR C ships and reads the shipped copy and depends on A2 for the columns and types. PR B replays and diffs and reads through `InputsSource`.

What can run in parallel:

- **A1 first**, alone, small: B cannot compile `replayInputs` without `handleStripeFact`, and A2 and C need the fact types.
- **A2, C and B in parallel after A1**, because this document fixes the DDL and the signatures: A2 writes the tables and the handler; C develops against the DDL and the `StoredInput` type, with its tests inserting rows by hand until A2 lands; B develops against an in-memory `InputsRead` built by a test helper from the recorded fixtures.
- **Merge order:** A1, then A2, then C and B in either order. B's end-to-end baseline test (real handler, real stored inputs) needs A2 merged; B's folder source needs C. B ships with the SQLite source first and adds `--inputs <folder>` when C has landed, which is one `InputsSource` and one CLI branch.
- A2 and C both touch `src/cli.ts` (C adds the `inputs` command group, B adds flags to `simulate`) and `src/types.ts`; those are the merge conflicts to expect.

## 9. OWNER DECISIONS

Decided items show the owner's answer. Open items have a recommendation.

| # | Decision | Status | Answer or recommendation |
|---|---|---|---|
| 1 | Retention of stored inputs | DECIDED | No automatic prune. An opt-in `atm inputs prune --before <date>` may come later; it is described as a later item only. |
| 2 | Personal data stored | DECIDED | The trimmed fact only (fallback: the full normalized fact if `replayFactOf` proves hard). `family_id` and `cus_...` stay as pseudonymous ids. |
| 3 | Ship inputs to a folder or R2 like events? | DECIDED (changed from this document's first recommendation of no) | Yes, through the existing `Store` interface: folder first, R2 by the same call. Section 3. |
| 4 | Store 422 refusals | DECIDED | Yes, as `refused` rows, replaced when the event is applied. |
| 5 | Seed a holder's rows (`atm_input_seeds`) and snapshot the menu and policy (`atm_input_contexts`) | DECIDED | Keep the two helper tables. They ship too (section 3). |
| 6 | Store every handled input | DECIDED | Yes: no skipping of money-only types. (Events the handler did not handle, such as another product's, have no row.) |
| 7 | A baseline that does not equal the log | DECIDED | Fatal: exit 2 unless `--allow-baseline-drift`. |
| 8 | Erasure shape in SQLite | DECIDED | Tombstone. |
| 9 | `--effective-from` in version 1 | DECIDED | Yes. |
| 10 | Env migration | DECIDED and DONE | The rebuild, merged as #69 (`migrateHandlerSchema`); the tables are env-keyed; this design follows it. |
| 11 | **Erasure of the shipped objects** | OPEN | Recommend rewrite with a tombstone: a new content-addressed key for the rewritten batch, create-only; re-point SQLite; delete the old object; a queue makes it resumable; `atm inputs ship` exits 1 while one is open. Alternative: crypto-shredding, not recommended: it leaves every line joinable through the other Stripe ids (100% of the 64 recorded facts carry one), it needs a key table that makes the shipped copy depend on SQLite and its backups, and it cannot use salted hashes because the recorded events embed the raw ids. Section 3. |
| 12 | Accept the window in which the old object still holds the facts | OPEN | Recommend yes: it ends at the next ship run (hourly), `atm inputs ship` exits 1 while it lasts, and readers prefer the tombstone. It requires that versioning and replication are off for `inputs/` in the bucket, or purged. |
| 13 | Are the ids left in shipped lines acceptable? | OPEN | Recommend yes: the shipped events log already carries `family:<id>` and `stripe:<id>` idems for every holder and the existing erasure leaves them; the inputs add the same class of ids. If the owner wants ids gone from shipped inputs after an erasure, that is a decision for the events too. |
| 14 | Ship refused rows? | OPEN | Recommend no: they change (attempts, replaced when applied) and a shipped copy is the immutable record of what was decided. A folder source then has no `newly_applied` view; the SQLite source has it. |
| 15 | R2 flags and credentials on the CLI in the first release | OPEN | Recommend flags for the non-secret values, credentials only from the environment, no configuration file, and a line in the PR that it has not been run against R2 (as for `atm ship`). Alternative: the library only for R2. |
| 16 | Ship tombstones | OPEN | Recommend yes: they carry no personal data and keep `applied_order` gapless, so a replay can say "n inputs of an erased holder". |
| 17 | Ship cadence | OPEN | Recommend hourly (at most 24 objects a day per env) and inputs before events; a `day.jsonl`-style combine for inputs waits for the events combine. |

## 10. Test plan

### Storage (A)

- Atomicity: a throw after `appendToOutbox` leaves no input row, no outbox row, claim still `claimed` (`tests/webhook-handler.test.ts` holds the claim and takeover tests this follows).
- One input per delivery: a second delivery (`duplicate`) writes no row; the same Stripe id under `env: "live"` and `env: "test"` makes two rows.
- A 422 refusal makes a `refused` row with `attempts` rising on retry; after the cause is fixed and the event re-sent, the row is replaced and `applied_order` is new; a 409 wait writes nothing; `ignoreForeign` and `ignoreUnmapped` write nothing; a `non_usd` delivery writes its input like any other.
- Every handled type: one input per event of each type in the recorded fixtures, including a payout and an `invoice_payment.paid`.
- Order: for each `delivered/` scenario `applied_order` is the order of the 200 answers, and differs from `created` order where the handler waited (6 of 8).
- No personal data: events built with `tests/stripe-events.ts` carrying a name, an email, an address, a card last4, receipt and invoice links, an extra metadata key; read the whole database file (and a `.dump`) and assert none of the strings is there (the `leaks()` pattern of `tests/hledger-multi.test.ts`), with a control that the same strings are in the raw payload. Size budget: mean body at most 500 bytes over the recorded fixtures (419 measured).
- Erasure: after `eraseStoredInputs` no fact, subject, ref, hash or seed of the holder remains; the other holders' rows are untouched; calling it twice is a no-op; `inputsStatus` counts the tombstones; queue rows are made for exactly the shipped batches and seed that held the holder.
- DDL: `db.exec(HANDLER_DDL)` twice is a no-op; a database from before #69 migrated by `migrateHandlerSchema` and then `HANDLER_DDL` gains the new tables without losing rows (either order); the new DDL has no `STRICT`, no generated column, no trigger, no `RAISE`.
- `handleStripeEvent` is unchanged by the `normalizeStripeEvent` / `handleStripeFact` split: the existing tests stay green and a new test feeds each recorded fixture through both entry points and compares results.
- `replayFactOf`: keeps every field the grant rules read (a property test: for random facts from `tests/billing-properties.test.ts` generators, `handleStripeFact` on the trimmed fact equals `handleStripeEvent` on the raw event).

### Shipping (C)

- Plan: deterministic bytes and key for the same rows; a row with a newline, a bad date or a bad id is refused for the whole school before any put; batches are one per commit day.
- Ship with `FolderStore`, as `tests/ship.test.ts` does for events: first run creates, rerun writes nothing, a crash between put and mark (a store that throws after the put) is repaired by the rerun, two shippers on one database do not conflict, a key holding other bytes is a conflict with the rows left unshipped and exit 1.
- Contexts and seeds are put before the batches that refer to them; each is created once.
- The layout: keys are under `inputs/<env>/`, `listEventFiles` and `readEvents` read none of them, and the journal of a folder with inputs equals the journal without.
- Erased before shipped ships a tombstone and no fact; the shipped bytes of a tombstone contain none of the holder's strings.
- Erasure after shipping: the batch is rewritten under a new key, the old object is gone, SQLite points at the new key for every row of the batch, other holders' lines are byte-identical; a crash after the put, after the re-point and after the delete each recovers on the next run (a fault-injecting store); `atm inputs ship` exits 1 while a queue row is open and 0 after; a seed object is deleted.
- The reader: `folderInputsSource` and `storeInputsSource` return the same `InputsRead` as `sqliteInputsSource` for the same database (a property test over the recorded scenarios); a duplicated line and an erased-versus-unerased pair reduce by the stated rule; a missing context object makes the holder `not_replayable` with `context_missing`.
- CLI: exit 0, 1 and 2 as listed, `--root` with an `--r2-*` flag is exit 2, a typo in `--root` ships nothing, credentials are never read from a flag, `--json` one line.
- R2: the same tests against a fake S3 (`R2Store` takes a `fetch`), not against R2.

### Baseline identity (B), the first test

- **Recorded fixtures.** The 8 `delivered/` scenarios through the real handler into an in-memory database (A's writer), then `replayInputs` with the recorded contexts: the decision events equal `ledger_outbox` row for row (body and id). (This design's throwaway proved it with raw events; the test proves it with stored facts.) Run in four `TZ` values in separate processes and compare a hash of the events.
- **From each source.** The same baseline, with the inputs read from SQLite, from a `FolderStore` after `shipInputs`, and from the folder after an erasure rewrite of another holder: identical results.
- **Seeded histories.** The golden year (`fixtures/vibes-year`, via `tests/replay-inputs.ts`: raw Stripe events plus the family's own bookings) and the twelve-family `fixtures/vibes-multi`: build the handler database by delivering the inputs (and `recordEngineCommand` for the bookings), then baseline must be identical, including with carried commands interleaved by revision.
- **Order.** Shuffle the delivery order with retries 100 times (a seeded generator): the baseline is identical every time because the replay follows `applied_order`.
- **Seeds.** Start the handler on a database that already has rows for a holder, deliver inputs, baseline identical from the seed.
- **Menu change mid-history.** Change the menu between two deliveries: the baseline uses each input's context and is identical; without the context rows it is not.

### What-if goldens (B)

`tests/golden/simulate-inputs/*.json`, rewritten with `UPDATE_GOLDEN=1` like `tests/golden/simulate/`:

- `upgradeGrant: "prorated"` to a full grant on the yearly-raise and the tier-and-quantity-change scenarios (the owner decision in `ROADMAP.md`: a switch that grants 128 under the old rule and 192 under the new);
- `removeOnFullRefund: false` on `full-refund` (the credits stay); `removeOnLostDispute: false` on `dispute-lost`;
- a larger and a smaller allowance on the tier in `vibes-year`;
- a candidate menu that adds a price: the stored 422 refusal becomes `newly_applied` (SQLite source);
- `--effective-from` halfway through `vibes-multi`: deliveries before it are `same`.

Each golden pins the per-delivery kinds, the per-holder balance change and the posting changes by month; the identity candidate (no flags) pins exit 0. The same goldens must come out of the folder source.

### Mutations (each must fail a test)

- replay in `stripe_created` order instead of `applied_order` (fails the out-of-order raise case and the id check);
- ignore `revision_before` (fails the carried-command history);
- drop the carried commands (fails `vibes-year`);
- ignore `fee` or `payment_refs` (fails the money lines and the refund link);
- use the current menu for the baseline (fails the menu-change test);
- skip the seed (fails the seeded-holder test);
- read `nowMs` instead of `stripe_created` (fails the TZ-and-clock test);
- let the writer store the raw event (fails the no-personal-data test);
- ship a fact of an erased row, or delete the old batch before the new one is put (fails the erasure and fault tests);
- let the reader prefer the unerased line (fails the rewrite-window test);
- skip the `idem` dedupe (fails a duplicate-delivery history);
- a CLI that exits 0 on a baseline mismatch (fails the exit-code test).

### CLI (B)

Exit 0 with no candidate and a matching baseline, 1 with a differing candidate, 2 for each bad input in section 5 (no table, no inputs, a folder without the prefix, bad menu, bad policy, a baseline mismatch, a missing `--env`); the 0.6.0 tests in `tests/simulate.test.ts` pass unchanged; the output names the not-replayable count.

## 11. How the numbers were measured, and what is not verified

Throwaway scripts, kept in `/tmp`, not committed (they import the package's own `normalize`, `redactPersonal`, `handleStripeWebhook` and `handleStripeEvent` from the worktree):

1. **Bytes.** For each JSON event of the handler's types under `fixtures/billing/stripe/recorded/` (not `booking/`): `JSON.stringify` length of the raw event, of `redactPersonal(raw, mapping)`, of `normalize(raw, mapping)`, and of that fact without `source`, `number`, `hostedInvoiceUrl`, `invoicePdf` and with metadata cut to the two keys (the metadata cut changes nothing on these fixtures, which carry only those two).
2. **Personal fields.** A walk of every path of every raw event matching name, email, address, phone, card, receipt, link and description patterns, counting non-null values per event type.
3. **Replay equality.** The real handler over the 8 `delivered/` scenarios; the order of the 200 answers; a replay driver (in-memory rows, `applyRowChanges`, its own two index maps, dedupe by `idem`) over those inputs, whole and cut to the mapped paths; comparison of the sorted canonical event bodies; repeated under four `TZ` values; re-run after merging `dev` with #69.
4. **Identifiers.** A walk of every string of the 64 trimmed facts, counting `family_id` values and Stripe ids by prefix (`evt_`, `in_`, `sub_`, `cus_`, `pi_`, `ch_`, `price_`) and their bytes.
5. **Line size.** One canonicalized shipped line built for an `invoice.paid` with every column filled with a realistic value.
6. **Hash cost.** 2,000 runs of `sha256(canonicalize({ menu, policy, priceIds }))` for the recorded menu.

Not verified, or only read:

- Everything is on scrubbed sandbox fixtures (test mode, one API version). Real live events carry more personal fields than the counts show, and a larger variety of invoices.
- No fixture has a payout, a family-service spend, a caller-row import or a seed; the interleave and the seed are designed from the code, not run. The first test of B on `fixtures/vibes-year` is where they get proven.
- The shipper, the erasure rewrite and both readers are designed from `ship.ts`, `store.ts` and `files.ts`, not run. Nothing in this design has been run against R2 or SeaweedFS; `R2Store` delete is "read the sha, then delete" (`docs/log-and-r2.md`), not conditional.
- The ICU time zone database (row 6 of the fidelity table) is not controlled.
- That Stripe lists events for 30 days, and that Stripe retries a non-2xx for three days (the latter is the handler's own comment), were not checked against Stripe.
- The size figures for 1,000 families assume three events per family-month; the storage and shipping PRs should measure real rows.
- `AUTOINCREMENT`, a partial index and `json_valid` in `CHECK` were not run through the family service's Litestream; `json_valid` is used by `atm_rows`, the others are plain SQLite. `AUTOINCREMENT` makes SQLite keep a `sqlite_sequence` table: check that a Litestream restore keeps it.
- Whether a bucket's versioning, replication or lifecycle rules apply to the inputs prefix is a deployment fact this repository cannot see.
