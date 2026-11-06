# Simulating the grant rules: stored inputs (design for the next release (number not yet chosen))

Status: design only, every open item decided by the owner on 2026-11-05 (phase 1, revised the same day after the owner's decisions, then checked against the tree after the 0.8.0 release). No code is written by this document. The work releases as **the next release (number not yet chosen)**: 0.8.0 (tag `atm-v0.8.0`) is out without it, and so is 0.9.0 (the revenue share), which another session released. Section "What changed in 0.8.0 that this design had to absorb" lists what the release changed under it. Three implementers share it: A builds the storage (the tables, the writer, the erasure hook, the SQLite reader), C builds the shipper that copies stored inputs to a folder or R2 and the reader for that copy, and B builds the replay and the `atm simulate --inputs` mode. The section "Interfaces" is the contract between them and section "The PR split" says which can run in parallel. The roadmap line it answers is "Simulation or what-if" in `ROADMAP.md`; the 0.6.0 command-level mode it extends is described in `README.md` ("What if (simulate)") and `src/ledger/simulate.ts`. (Booking addendum.) The Stripe events of a paid booking are stored too, in phase 1; the last section, "Addendum: booking events are stored", is the decided state and the spots it replaced are marked "(booking addendum)". A1, the pure refactor, is PR #85.

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
| 8 | Booking checkout events (0.8.0) (booking addendum) | Stored in phase 1 (decided 2026-11-05, reversing this document's earlier recommendation). The reference handler does not decide them and the refund needs an index only the family service holds, so the family service's endpoint records them in its own transaction: `recordInput` is exported, `CheckoutSessionFact` joins `ReplayFact` (done in A1), and `booking_refs` and `input_id` columns carry `bookingIds` and the ULID the endpoint passed. A paid, expired or refunded booking replays exactly. A holder with credit-hold commands is `not_replayable` with the reason `booking_writes` only from the first invoice-removing input (full refund, lost dispute) that follows one of its booking commands (decision 19, narrowed). Owner decisions 18 and 19; the last section has the evidence. |

## What changed in 0.8.0 that this design had to absorb

The design was first written against the tree of #69 and #68. 0.8.0 (the tag `atm-v0.8.0`) added disputes that book money (#66), bookable items with paid bookings and holds, gift and member codes and discounts. Re-checked on the merged tree: every `src/` line cited here (listed in the last section) was re-read, the byte measurements and the proof run were repeated. What moved or was wrong:

- **Line numbers.** `stripe-webhook.ts` is unchanged by 0.8.0, so its citations stand, except `deterministicUlid` is at `:618-622` (the design said `:617-621`, one line off from the start). `handle.ts` grew 15 lines: the mapping and normalization step is `614-626` (was cited as `598-611`), the `b4u_school` read is `:121` (was `:120`). `grants.ts`: `:665-666` and `:1551-1552` (were `:664-665` and `:1521-1522`). `money.ts:155` (was `:153`). `schema.ts`, `ship.ts`, `cli.ts:218`, `outbox.ts`, `replay.ts` and `run.ts` names and lines hold.
- **A second read of the raw event, `handle.ts:347`.** The dispute rule decides whether the event is `charge.dispute.closed` by reading `input.event.type`. `handleStripeFact` has no raw event, so the refactor in section 7 must read the `type` it already takes (`StripeFactInput.type`) there, and `decide` must be handed it. Left as it is, the line would read the type of an event that is not there: it throws on a missing event, and if it were given a stub it would decide every dispute as a `created` one (no `dispute.closed` line), so the baseline fails on the dispute fixtures. A test feeds every dispute fixture through both entry points.
- **Disputes are decisions, not carried events.** A dispute that moved money now makes `payment.disputed` (the amount withdrawn plus Stripe's dispute fee) and, when it closes, `dispute.closed` (`disputeEvents`, `src/billing/money.ts`), inside `handleStripeEvent`, with the input's ULID as `cause`. So the baseline compares them as the input's decisions (section 5 said they were carried; corrected there). The fact grew to carry what the lines are made from (`amount`, `currency`, `openedAt`, `withdrawn`, `fee`, `withdrawnAt`, `reversedAt`, `invoiceId`): the replay fact of a `created` is 255 bytes (was 160) and of a `closed` 288 (was 160); the totals in section 1 are re-measured. Rows 18 to 22 of the fidelity table are new.
- **The `booking` outcome.** `StripeEventResult` has a new optional `booking` (`BookingPaymentOutcome`: `paid`, `refunded`, `partly_refunded`, `expired`) for a payment-mode Checkout Session made by `bookingCheckoutParams` and for the refund of its charge. It is not a `WebhookOutcome` (the handler's outcomes, and `atm_event_claims.outcome`, are as before: `applied`, `non_usd`, `ignored`, ...). **(Booking addendum, rewritten.) Decision (2026-11-05, owner): stored inputs include these events in phase 1.** The first draft recommended against it, on three premises that the tree no longer supports or that the decision changed; the corrected facts, in short (the evidence is in the last section):
  - The reference handler does not decide them: `HANDLED_TYPES` (`stripe-webhook.ts:163-173`) has no `checkout.session.*` (200 `ignored`, no claim), and a booking charge's refund answers 409 `unmatched_payment` before `handleStripeEvent` runs (`UPGRADING.md`, "A booking paid in money", item 4). Only the family service's own endpoint calls `handleStripeEvent` for them, in its own transaction, so that endpoint calls the exported `recordInput`.
  - Their decision is not empty any more. Since #84 `decideCheckoutSession` and `decideBookingRefund` (`src/billing/booking-events.ts`) return the money lines: `payment.succeeded` for a paid booking, `payment.refunded` (or a `money.skipped` marker) for a refund, with the input's ULID as `cause`. The replay re-decides them and the baseline compares them by `idem`, as for an invoice. They still read no menu or policy content (verified by a run, with two exceptions: `menu.timeZone` and the two version labels).
  - The refund's input is not in the event: it needs `StripeEventInput.bookingIds` (payment intent or charge id to booking), an index only the family service keeps. It is stored as `booking_refs`.
  - The cost the first draft named, a revision gap with no input, is what storing them removes: a paid or refunded booking is an input with a `revision_before` like any other.
- **A refund now reads open holds.** `removeInvoice` (`grants.ts`) asks `heldOnRows` (`src/billing/booking-holds.ts`) what open credit holds keep on the invoice's rows and records what it could not take back as the invoice's `owed`; a release later settles it. So the grant decision for a refund depends on `grants.bookings`, which the family service's booking commands (`holdBooking`, `confirmBooking`, `cancelBooking`, `noShowBooking`, `settleExpiredHold`, `releaseBooking`) write, and which `runOnState` on the engine rows alone does not reproduce. The interleave of section 4 would replay the holds' engine rows and still decide the refund on a grants row without the booking records. (Booking addendum, rewritten.) Rule: only `removeInvoice` reads the booking records (`grants.ts:1400-1405`), and the booking commands are carried, not stored, so their grants-row half is not reproduced. A holder is `not_replayable` with the reason `booking_writes` from the first input that can call `removeInvoice` (a full refund of an invoice's charge, a lost dispute) that comes after a carried command labelled with a booking (`labels.booking`), its decisions from there on carried over unchanged and counted. Everything before replays. The first draft flagged the whole holder, and a seed with `bookings` or `owed`; a seed holds the grants row whole and is right until a booking command changes it, and a paid booking is an input now. Owner decision 19, narrowed in the last section (A.5).
- **Seeds and contexts grow, by themselves.** The grants row has new members (`bookings`, `redeemed`, the invoices' `owed`) and the menu has bookable items' `billing` and `codes`, the policy has the booking and gift settings; the seed stores the grants row whole and the context stores the menu and policy whole, so nothing in the design changes. The cost figures for a context (0.013 ms to hash a 2.1 KB menu) were not re-measured for a menu with codes.
- **Gift and member codes, discounts.** Member codes are in the menu (the context). The invoice's discount amounts are in the fact and no grant rule reads them (`UPGRADING.md`, "Discounts do not change credits"), so a discounted invoice replays like a full-price one (the six `discount/` fixtures are in the byte table). `redeemSessionGiftCode` and `dollarGiftOps` are the caller's calls, not Stripe inputs: a redemption is a carried command (its credit row is an engine mutation); `GrantsState.redeemed` is read by no grant rule, only by booking quotes, so a missing entry cannot change a Stripe decision.
- **Re-run on the merged tree.** The 8 recorded delivery scenarios, through the real handler and then through `handleStripeEvent` on mapped paths only: 8 of 8 outboxes identical (the dispute scenarios included, with their new `payment.disputed` and `dispute.closed` lines), the same outbox hashes under UTC, America/Denver, Pacific/Auckland and Asia/Kolkata. The applied order differs from the created order in 6 of 8, as before. As before, no fixture has a closed dispute delivered before its created, a hold or a gift code: those are designed from the code, not run. (Booking addendum.) The six recorded booking events were run through `handleStripeEvent` one by one, and through `handleStripeFact` by A1's test, not through the handler or storage; a booking history with holds and a refund does not exist as a fixture (last section, A.7).

## 1. What to store: measured evidence

The measurements are on the 64 Stripe events of the handler's own types in `fixtures/billing/stripe/recorded/` (the 14 top-level events, the 6 discounted invoices of `discount/` and the 44 events of `delivered/`, all at API `2025-10-29.clover`; the six `booking/` fixtures, four checkout-session events and two refunds of a booking's charge, are left out of these totals because the reference webhook handler does not decide them; they are measured in the last section, A.3 (booking addendum): replay fact 230 to 321 bytes, mean 280), with throwaway scripts that were not committed (method in the last section).

### Bytes per event

| Event type | n | raw JSON, mean bytes | raw minus the mapping's `personal` paths | normalized fact (`normalize()` output) | replay fact (trimmed, see below) |
|---|---|---|---|---|---|
| `invoice.paid` | 24 | 4,242 | 4,085 | 873 | 618 |
| `customer.subscription.created` | 10 | 4,021 | 4,021 | 600 | 459 |
| `customer.subscription.updated` | 8 | 4,754 | 4,754 | 586 | 445 |
| `customer.subscription.deleted` | 1 | 3,608 | 3,608 | 463 | 322 |
| `charge.refunded` | 3 | 2,644 | 2,438 | 334 | 207 |
| `charge.dispute.created` | 3 | 2,162 | 1,237 | 389 | 255 |
| `charge.dispute.closed` | 2 | 2,540 | 1,566 | 421 | 288 |
| `invoice_payment.paid` | 13 | 655 | 655 | 294 | 162 |
| all 64 | 64 | 3,307 | 3,165 | 608 | 428 |

Totals: raw 211,671 bytes; raw after `redactPersonal` 202,554 (95.7% of raw); normalized 38,927 (18.4%); replay fact 27,363 (12.9%). The largest replay fact is an `invoice.paid` at 862 bytes. The size of the stored and the shipped row is in section 3.

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
- **The normalized fact is nearly clean, not clean.** The fields the grant rules read hold no name, email, address or card. But the normalized invoice also carries `hostedInvoiceUrl`, `invoicePdf` and `number` (nothing under `src/` outside the mapping and the type reads them), and `metadata` copies every string pair of the checkout metadata (the caller sets those). The grant rules read only `b4u_school` and `family_id` from it (`src/billing/grants.ts:665-666` and `:1551-1552`, `src/billing/handle.ts:121`). The fact keeps `customerId` (`cus_...`) because `src/billing/money.ts:155` copies it into `payment.succeeded`. So the stored fact is an allowlist: the normalized fact minus `source`, `number`, `hostedInvoiceUrl`, `invoicePdf`, with `metadata` cut to the two keys. If `replayFactOf` proves hard to keep in step with the mappings, the owner's fallback is the full normalized fact with those four removed by the same rule; the `{"v":1,"fact":...}` shape does not change.

### Does the decision depend on anything the normalized fact lacks?

Proven by a throwaway script, not only by reading `src/billing/handle.ts` (now `handle.ts:614-626`, which reads only `type` and `api_version` from the raw event and then `normalize()`s; the one other read of the raw event is `handle.ts:347`, see "What changed in 0.8.0"). For the 44 delivered events (8 scenarios) the script replayed, through `handleStripeEvent` with an in-memory store that evolves its rows, events cut down to exactly the paths their mapping reads (11 to 25 KB of raw JSON per scenario, down to 2.5 to 5.6 KB). The outbox it produced equaled the real handler's outbox (every body, every id) in 8 of 8 scenarios, re-run on the tree after the env-key change (#69) and the non-USD change, and again on the 0.8.0 tree (disputes that book money, bookable items): 8 of 8 again, the same outbox hashes under UTC, America/Denver, Pacific/Auckland and Asia/Kolkata. So the grant decision is a function of the mapped fields; everything else in a raw event is not needed for replay.

### What is lost by storing the fact and not the raw event

- A later change to the mapping (a new field, a corrected path) cannot be replayed from facts. A fact is the output of `stripe/<event>@v<n>`; the row records that label, and a new mapping version is a new label. A mapping bug that mis-read a field is baked into the stored fact; the SHA-256 of the raw body lets an operator check a re-fetched Stripe event against the row, but the re-fetch itself is out of scope (Stripe lists events only for a limited time, 30 days from memory, not checked here).
- Facts the mapping does not extract today cannot be asked later: tax lines, the customer's country, the payment method. (Discounts are extracted: the invoice's and each line's discount amounts are in the fact, as numbers; no grant rule reads them and the coupon or promotion code text is not in the fact.) `ROADMAP.md` already lists "no tax lines" under Taxes; if the receipt or revenue-timing work needs them, storing starts only after they are mapped.
- It is consistent with the roadmap decision of 2026-11-05 to store no raw payload for usage events ("Decisions taken"): atm keeps no raw third-party payload anywhere.

### Decision: the replay fact plus side inputs plus a hash

Store, per input: the replay fact (JSON, 428 bytes on average), the columns that are not in any event (below), and `raw_sha256` of the verified payload. Not stored: the raw JSON, any name, email, address, card detail, receipt or invoice link, the invoice number, and any metadata key but the two. Every event the handler applies is stored, including one that books only money (a refund, a payout, an `invoice_payment.paid`) or books nothing (the owner's decision: no skipping of types). The only deliveries without a row are the ones the handler itself did not handle (table below).

### Retention and erasure

- **Retention (decided):** no automatic prune. Applied inputs live as long as the database and its outbox, because they explain the outbox rows. An opt-in `atm inputs prune --before <date>` is a later item: a prune in the middle of a holder's history breaks the state continuity replay needs, so it would have to write a new seed per holder and delete shipped objects; it is not part of this design.
- **Erasure.** Today an erasure is a ledger event, `subject.erased`, with a payload `objects` listing the rewritten objects by id (`schema/payload/subject.erased.v1.json`); no code in `src/` performs it (only the type and the schema exist), and `tests/hledger-multi.test.ts` (the test "no personal data of the erased family ...", about line 593) pins that after it no event file or journal holds the erased family's personal fields while the money stays booked. Stored inputs follow the same rule: when `subject.erased` is booked for a holder, the operator calls `eraseStoredInputs` in the same transaction. It turns every input and seed of that subject into a tombstone (decided): `body`, `payment_refs`, `booking_refs`, `subject_key`, `raw_sha256` and `fee` are set to NULL, `erased_at` is set, and the seed row is deleted. The tombstone keeps `env`, `event_id`, `school_id`, `type`, `api_version`, `mapping`, `stripe_created`, `outcome`, `applied_order`, `atm_version`, `batch_key`, which name no person. Replay then excludes that holder and reports `erased: n inputs`; its recorded events (already redacted by the erasure) are carried over unchanged. The ledger's money stays; so do the stored inputs of other holders. What erasure does to objects already shipped is section 3.
- A stored fact holds pseudonymous ids (`family_id`, `cus_...`). They count as personal data only while the family service can map them to a person; that mapping is the family service's to delete, and `eraseStoredInputs` removes the facts that carry the ids.

## 2. Where: the table, the transaction, the columns

### The transaction

`handleStripeWebhook` already commits claim done, rows and outbox rows in one transaction (`src/handler/stripe-webhook.ts`, `applyOnce` from line 593; the commit is `deps.db.transaction` in `settle`, line 740). The input row is written inside the same transaction:

| Where | Line (`stripe-webhook.ts` is unchanged by 0.8.0; checked) | Write |
|---|---|---|
| `applyOnce`, after the outbox append (648) and the index writes (649-662), before `finishClaim` (664) | `applied` (also an `applied` that ends `non_usd`) | the input row with outcome `applied`, the seed if it is the holder's first stored input, the context row if new |
| `applyOnce`, the `result.refused` branch (637-640) | a 422 refusal | an upsert with outcome `refused` and `reason`; not for the retryable 409 reasons (`unmatched_invoice`, `unknown_subscription`), which are waits and become `applied` on the retry |
| `recordPaymentOnce`, before `finishClaim` (825) | `invoice_payment.paid` applied | the input row (it teaches the payment index, so it is part of the history) |
| the family service's endpoint, in its own transaction (booking addendum) | a booking's `checkout.session.*` and the refund of a booking's charge, which the reference handler never reaches (it answers `ignored` and 409 `unmatched_payment`) | the same input row, written by the exported `recordInput` after the endpoint's rows and `appendToOutbox`; the same `refused` rule for a 422-type refusal; see the last section, A.2 |
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
  -- (booking addendum) input_id: the ULID the endpoint passed as eventId (the handler's is inputCauseId); booking_refs:
  -- the caller's bookingIds entries for this fact's payment intent and charge.
  input_id TEXT NOT NULL,
  booking_refs TEXT CHECK (booking_refs IS NULL OR json_valid(booking_refs)),
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
| `stripe_created` | the decision clock: `now = event.created * 1000` (`stripe-webhook.ts:630`); also the seed of the event's ULID (`:618-622`). |
| `received_at` | `deps.nowMs()` at commit; information only (it decides nothing), and the day a shipped batch is filed under. |
| `outcome`, `reason`, `attempts` | `applied`, or `refused` with the 422 reason code (`unmatched_line`, `addon_only_subscription`, `tier_on_other_subscription`, `missing_metadata`, `rejected`, `bad_event`; `unmatched_booking` exists since 0.8.0; the reference handler cannot reach it, the family service's endpoint can, through `recordInput`: booking addendum, A.3); how often Stripe has retried it. The message is not stored (it quotes event content). |
| `revision_before`, `revision_after` | the holder's revision when the input was handled and after its write. The replay checks that its own revision equals `revision_before` at every step; a mismatch means a write that is not a Stripe input happened in between (a spend, a lapse, an import), which the driver then interleaves from the log or reports (section 4). |
| `atm_version` | the package version that decided it, so a baseline mismatch is attributable to a code change. |
| `context_hash`, `menu_version`, `policy_version` | the menu and policy in force (`deps.context(school)` is called inside the transaction at every event, `stripe-webhook.ts:609`). The versions end up in event labels (`menu_version`, `policy_version`), so they matter for identity. |
| `fee` | the result of the caller's `paymentFee(raw)` hook: an outside read of Stripe the fact does not contain. |
| `payment_refs` | the payment intent and charge ids the invoice paid with, from the `paymentRefs` hook or the expanded `invoice.payments` (`invoiceRefsOf`, `:275`): they feed `atm_payment_index`, which later finds the invoice of a refund. Not in the normalized fact. |
| `input_id` (booking addendum) | the ULID the input was decided under, whose `cause` every line names. For the handler it is `inputCauseId(school, event id, created)`; a caller of `recordInput` may pass any ULID (`handle.ts:611`), so it is stored, not recomputed. Names no person. |
| `booking_refs` (booking addendum) | the booking index entries (payment intent or charge id to booking id) the refund's decision was given. NULL for every other input. Nulled by an erasure. |
| `raw_sha256` | proof of provenance without keeping the payload. |
| `body` | the replay fact: `{"v":1,"fact":{...}}`. |
| `erased_at` | the tombstone mark. |
| `batch_key`, `shipped_at` | where and when the shipper put the row; NULL until shipped. After an erasure rewrite `batch_key` points at the replacement object. |

### The writer in one sentence per piece

- One normalization: `handleStripeEvent` and the handler share `normalizeStripeEvent` (extracted from `handle.ts:614-626`), so the fact the handler stores is the fact the rules decided on.
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
- Size: a shipped line averages about 1.2 KB (the 428-byte fact plus about 750 bytes of column names and values; one measured `invoice.paid` line was 1,518 bytes with a 763-byte fact). At three events per family-month (an assumption) 1,000 families ship about 3.6 MB a month, 43 MB a year, in at most 24 objects a day; reading a year back is about 9 `list` pages of 1,000 keys and up to 8,760 `get` calls, which is why the combine matters later.

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

**Rewrite with a tombstone, decided (2026-11-05).** The batch is rewritten and filed under a new key; nothing is ever overwritten.

1. `eraseStoredInputs` (in the transaction that books `subject.erased`) tombstones the rows in SQLite as in section 1, deletes the seed, and queues one `atm_input_erasures` row for every shipped batch that held one of the holder's rows (found by `batch_key`) and for the holder's shipped seed object. The SQLite change is atomic and final; nothing is left in SQLite.
2. The next `atm inputs ship` settles the queue before anything else. For each batch: read the old object; replace each line whose `(env, event_id)` is now a tombstone in SQLite with the tombstone line; the new text has a new hash, so a new key `batch-<same first order>-<new hash>`; `putOnce` it (create-only; an equal object left by a crashed run is "existing"); in one SQLite transaction point `batch_key` of every row of that batch (other holders' rows included) at the new key and set `replacement_key`; then `store.delete(oldKey, oldSha256)` (it checks the sha, then deletes; R2 has no conditional delete, which is fine for a key atm owns) and set `done_at`. A seed object is simply deleted the same way.
3. **Atomicity.** There is none across the two objects, and the design does not pretend there is. The order put-new, then re-point, then delete-old means a crash at any point leaves either the old object only (queue row not done, retried), both (queue row has `replacement_key`, the delete is retried), or the new object only (done). The retry is idempotent: `putOnce` finds the new object, the delete of a missing key returns false. While both exist the old object's bytes still hold the facts. The reader rule (an erased line beats an unerased one) means no consumer reads them as live, but the bytes are on the disk or bucket until the delete lands. That window is one ship run, accepted by the owner on the condition that versioning and replication are off for the `inputs/` prefix (a deployment precondition and an item for the ops checklist); `atm inputs ship` exits 1 while a queue row is open, so a cron alerts, and `inputsShipStatus` reports the count and age.
4. Cost: one `get`, one `put`, one `delete` per batch the holder has rows in (a holder with three events a month for three years touches at most about 100 batches).

A "versioned overwrite" of the same key, `Store.putIfMatch(key, body, etag)`, would be atomic per object (one request, no second copy, no delete) and is the alternative. It was not chosen: it breaks the key-names-its-content rule (the hash in the name stops matching), it leans on conditional PUT semantics on R2 that this repository has not exercised (the contract suite has never run against R2), and the reader and the shipper's conflict check were written for immutable objects.

**Crypto-shredding, rejected (2026-11-05).** Ship the subject's ids encrypted or pseudonymized under a per-holder key kept in SQLite and erase by deleting the key. It would make an erasure one atomic SQLite delete with no rewrite. Checked against what a stored fact holds, on the 64 recorded facts (`ids.ts`, throwaway):

| What is in the line | Count |
|---|---|
| facts that carry `family_id` or a `cus_` id | 43 of 64 (67%) |
| facts that carry at least one other Stripe id (`in_`, `sub_`, `pi_`, `ch_`, `evt_`) | 64 of 64 (100%) |
| bytes of the facts that are Stripe ids (without the family id) | 5,798 of 24,794 (23%) |

- Pseudonymizing only `family_id` and `cus_` leaves every line joinable to the customer by anyone who holds the school's Stripe account (`in_`, `sub_`, `pi_`, `ch_` and `evt_` resolve there), and the amounts and times are quasi-identifiers on top. To make a line unlinkable the ids, amounts and times must all be encrypted, which is almost the whole body (`type`, `env`, `school` and the order would stay clear).
- A salted hash does not work: replay must reproduce the recorded decision events and those embed the raw ids (`idem` is `stripe:<id>`, `src/billing/money.ts`; `payment.succeeded` carries the customer id). So the fields would have to be reversibly encrypted, and a replay from the folder then needs the key table in SQLite: the shipped copy stops being an independent record, `atm simulate --inputs <folder>` stops working without the database, and losing the table loses every shipped input.
- The keys live in the database, so they live in its Litestream snapshots until those expire: the shredding is as strong as backup retention.
- A per-school salt, as first suggested, cannot erase one holder (deleting it erases everyone), so it would have to be per holder in any case.

**The privacy consequence, measured honestly.** Under either choice the shipped inputs are not more identifying than the log already shipped: every event in `schools/<id>/events/` carries the holder's key (`family:<id>`) and an `idem` of `stripe:<invoice, event or payout id>`, and the existing erasure leaves those and the money (`tests/hledger-multi.test.ts`). A shipped input line holds those same ids, plus the price ids, quantities and times of the Stripe event. What erasure removes from the inputs is therefore the same class of data it removes from the events (the personal fields), and more (the facts that tie the ids to a holder). The rewrite chosen here goes further than the events do; crypto-shredding would go further still and cost the replay. Two limits apply to both: a bucket with versioning, replication or backups keeps deleted objects (that must be off for the inputs prefix, or purged as part of the erasure), and the SQLite file's own backups keep the facts until they expire.

### (e) Ordering and consistency between SQLite and the shipped copy

- **SQLite is the source of truth; the folder is a one-way replica.** The shipper reads the unshipped rows with a plain select (only committed rows are visible), so it never ships a row that a rolled-back transaction wrote.
- **Erased rows ship as tombstones, never as facts.** A row erased before it was shipped is read as a tombstone and shipped as one; the shipper selects `body` only for rows with `erased_at IS NULL`.
- **Crash between put and mark.** The batch key and bytes depend on the rows alone, so a rerun finds its object ("existing") and marks. If rows were committed for the same day meanwhile, the rerun puts a second, overlapping batch under another key; the reader reduces repeated `(env, event_id)` lines (equal bytes for the same row), so replay is right and the files hold some lines twice until a combine, as `docs/log-and-r2.md#two-shippers` describes for events.
- **Order of commit and order of application.** With `BEGIN IMMEDIATE` (`bunSqlite`) one writer runs at a time, so `applied_order` is also the commit order. The reader does not depend on that: it sorts every line by `applied_order` across all batches.
- **Lag.** The log and the inputs are shipped by separate runs. `simulate` over a folder reports a recorded handler decision with no shipped input as `not_replayable` with the reason `inputs_not_stored` and the hint "or not shipped yet: run `atm inputs ship`"; running the inputs shipper before the events shipper keeps that from happening for events that are in the log.
- **Erasure queue.** A queue row stays until `done_at`; until then the consumer rule above holds and the shipper reports it.

### (f) Correction: where the shipper as built differs from the text above (PR C)

The code is the record where these differ.

- **`batch_key` is written before the put.** The shipper assigns the planned key to the unshipped rows (`batch_key` set, `shipped_at` null) in one transaction, then puts, then sets `shipped_at` after checking that the rows still plan to the same key. Text above says the mark is `batch_key` and `shipped_at` together after the put. Why: with the key written afterwards, an erasure between the put and the mark finds no `batch_key`, queues nothing, and the object that landed keeps the holder's facts; and rows that arrive between a crash and the rerun would make a second, overlapping object (the same facts twice). With the key written first, `eraseStoredInputs` (which queues by `batch_key IS NOT NULL`) finds the object, and a rerun puts the same batch again whatever arrived meanwhile. The mark is by the batch's key and no longer by `applied_order` and an unchanged `body`.
- **The rewrite takes its lines from SQLite, not from the old object.** The rows that point at the old key give the new text (tombstones for the erased rows). It needs no read of the old object, works when the old object never landed, and ends the same. The old object is still deleted by its sha256. A rewrite that finds a row erased between the plan and the repoint deletes the object it just put and starts over on the next run. A group of unshipped rows that no longer plans to its own key (a row erased after the key was written, or a changed line format) is queued as a batch and settled the same way.
- **`SettleInputErasuresResult` has a `conflicts` list** (a rewrite key that holds other bytes, an old object whose sha256 changed); `settleInputErasures` is `{ settled, pending, conflicts }`. `shipInputs` runs the settle twice (before and after the batches) and `erasures.pending` is the count after the second.
- **A context or seed object that holds other bytes holds back the batches that refer to it** (its rows stay unshipped, a conflict is reported), so that no shipped line points at a context the reader would reject.
- **Gaps are `inputOrderGaps(read)`, a function, not a field of `InputsRead`.** A refusal takes an `applied_order` and is never shipped, so a gap in a folder is not always a loss; orders of `read.refused` (SQLite) count as present. Only gaps between the first and last input read are reported. The "keeps `applied_order` gapless" remark in decision 16 holds among applied and erased rows, not across refusals.
- **An erased refusal is never shipped** (the shipper selects `outcome = 'applied'`); a refused row has no tombstone line.
- **The reader** sets `batchKey` to the object a line was read from and `shippedAt` to null; a line of another school or env, a context that is not what its name says (its hash is checked) and a line without its fact throw, naming the object.
- **The destination variables** fill each value a flag leaves out (the flag wins per value), and are read only when `--root` is not given. Commander echoes `--flag=value` of an unknown flag; the command removes the value from that message, so a secret passed by mistake is not logged.
- **A seed object is queued whenever the holder has a seed row** (review of PR C), shipped or not: a put that landed without its mark (a crash) leaves an object nothing else points at, and `eraseStoredInputs` now queues it (`queued` counts it). The queue is re-armed (`done_at` cleared) when the same object key is queued again, so a holder that comes back, gets a new seed under the same name and is erased again is not skipped. Deleting an object that was never put is nothing to do.
- **A shipper that planned before an erasure can put after another shipper settled it.** When the mark finds the rows no longer plan to the batch just put, the key is queued again, so the settle that follows deletes or rewrites it. Two shippers settling one queue row never delete the object the rows point at (the one that loses the race keeps it).
- **Not run:** the R2 path (`R2Store` through `shipInputs`) has not been run against R2 or SeaweedFS.

## 4. Replay fidelity

To reproduce a decision the replay needs the same inputs, the same order, the same clock, and the menu and policy in force. `handleStripeEvent` is pure (`src/billing/handle.ts:1-12`: no clock read). The table lists every source of non-determinism found in `handleStripeEvent`, `invoiceToCommands` and what the handler passes in, and how replay controls it. Rows 1 to 17 are from the first draft and were re-checked on the 0.8.0 tree; rows 18 to 22 are new in 0.8.0 (rows 20 to 22 rewritten for the booking addendum, and rows 23 to 28 added after them).

| # | Source | Where | How replay controls it |
|---|---|---|---|
| 1 | The clock | the handler reads `deps.nowMs()` for claims, signature tolerance and `done_at` only. The engine gets `now: event.created * 1000` (`stripe-webhook.ts:630`). | Replay uses `stripe_created * 1000`. No clock is read. Proven: the handler ran with a clock set to created + 1 s and the replay with none, same outbox. |
| 2 | The input event id (`cause` of every decision event, id of every command) | `deterministicUlid({ timeMs: created*1000, revision: 0, seed: canonicalize([school, eventId]) })` (`:618-622`); unchanged by #69, no env in the seed | Recomputed from `(school_id, event_id, stripe_created)` by `inputCauseId`. Not stored. |
| 3 | The decision events' own ids | `deterministicUlid` includes 24 bits of the holder's revision, so an event's id depends on how many writes the holder had before it. | The revision must match at every step: `revision_before` is checked. (Seen in the experiment: one refused event lowered a revision and changed 1 character of the ids that followed.) |
| 4 | Random rollover ids | the engine mints random KSUIDs for rollover rows | `canonicalRolloverIds` (`src/ledger/run.ts`) rewrites each to `roll_<commandId>_<n>` in every mutation. Already done on both sides. |
| 5 | The process time zone | the engine adds months in local time | `withUtc` (`run.ts`) pins `TZ=UTC` around each engine call. Proven: the outbox hash of all 8 scenarios is the same under TZ UTC, America/Denver, Pacific/Auckland and Asia/Kolkata. |
| 6 | The runtime's time zone database | `wallMs` in `grants.ts` uses `Intl.DateTimeFormat` with `menu.timeZone`; since 0.8.0 also `addZonedMonths` (a gift code's expiry) and `addUtcMonths` (a rollover kept by a release) | Not controlled; the same runtime gives the same result. A replay on a newer ICU could differ across a changed zone rule. Reported as uncertain; `atm_version` does not capture it. |
| 7 | Payment fee | `deps.paymentFee(raw)`, an outside read | Stored in `fee`; replay passes it as `input.fee`. |
| 8 | Payment refs | `deps.paymentRefs(raw)` and `invoice.payments` of the raw event | Stored in `payment_refs`; replay writes its own index from them. |
| 9 | The payment and invoice index tables | `atm_invoice_index`, `atm_payment_index`, read in `locateSubject` (`:372`) to give `invoiceIds` to a refund or dispute, now inside one env | Replay keeps its own two maps per env, written in the order of replay by the same rules as the handler: first write wins (`ON CONFLICT DO NOTHING`); an `invoice.paid` indexes the invoice and its `payment_refs`; an `invoice_payment.paid` indexes its refs. |
| 10 | `hits[0]` of an unordered join in `locateSubject` | `:408` | Only used when all hits name one subject (more than one is `ambiguous_payment`), so the order does not matter. Replay does the same. |
| 11 | The menu, policy, versions, catalog and price ids in force | `deps.context(school)`, read per event | The context row (`context_hash`) holds the menu, policy and price ids; the catalog is `menuCatalogRows({ menu, school, env })`, rebuilt. Baseline uses each input's own context; the candidate replaces it (from `--effective-from` or from the start). |
| 12 | The holder's rows and revision | loaded from `atm_rows` | Replay evolves its own rows from the seed (or from none) with `applyRowChanges`. |
| 13 | Writes that are not Stripe inputs | the family service's `track`, `finalize`, `confirmExpiredLock`, `updateBalance`, `recordLapse` (`recordEngineCommand`, `src/ledger/outbox.ts`); the caller-row import | These change the rows a later `reset` or refund reads (a reset rolls over what is left), so a replay from Stripe inputs alone drifts. Detected by `revision_before` and handled by interleaving the log's own commands (below). Since 0.8.0 the booking commands also write the grants row, which the interleave does not reproduce (row 20); a paid or refunded booking is a stored input now (row 21). |
| 14 | The order of handling | Stripe order races (above) | `applied_order`. |
| 15 | Repeat deliveries | the claim `ON CONFLICT (env, event_id) DO NOTHING`; the outbox `ON CONFLICT (school_id, env, idem) DO NOTHING` | One input row per `(env, event_id)`; replay drops a repeated `idem`, first wins. |
| 16 | The code | the grant rules change between releases | `atm_version` per row. A baseline mismatch under a newer version is a finding (a code change would have decided differently), reported as drift. |
| 17 | A non-USD money line | a `money.skipped` marker replaces the line (`stripe-webhook.ts`, outcome `non_usd`) | Pure in the facts (`currency` is in the fact), so replay makes the same marker. A dispute in another currency (or with no withdrawal, as an inquiry) makes neither a line nor a marker (`disputeEvents` returns nothing), so it is answered `applied`, not `non_usd`; replay does the same. |
| 18 | A dispute's opening line has two makers | `charge.dispute.created` and `charge.dispute.closed` both make `payment.disputed` with the same `idem` `stripe:<dispute id>` and the same instant; each names its own input as `cause`. The outbox keeps the first applied and drops the other (`ON CONFLICT (school_id, env, idem) DO NOTHING`), so a `closed` delivered first owns the line | `applied_order` says which came first; replay dedupes by `idem`, first wins (row 15), so the same copy survives, with the same `cause`. The baseline compares by `idem`, so a dropped duplicate is not a difference. A `closed` before a `created` is not in the recorded fixtures: it is a test (section 10). |
| 19 | What a dispute line is made from, and the "ours" test | the amount, fee, `openedAt`, `withdrawnAt`, `reversedAt`, currency and status come from the event's own balance transactions, so nothing is asked of the caller (unlike the payment fee, row 7). The lines are made only when `grants.invoices[invoiceId].paid` is set, which depends on the holder's rows (`handle.ts` dispute branch). The type test at `handle.ts:347` reads the raw event | In the stored fact (every field is in `Omit<BillingDispute, "source">`). The "ours" test reads the replay's own evolving rows and its own invoice index (row 9). `handleStripeFact` reads the type from `StripeFactInput.type`. |
| 20 | (booking addendum) Credit holds, hold times, their expiry and the sweep (0.8.0) | `holdBooking`, `confirmBooking`, `cancelBooking`, `noShowBooking`, `releaseBooking` and `settleExpiredHold` take `now`, `startsAt` and `expiresAt` from the caller; the engine never runs a lock's expiry action by itself and the caller's cron (`expiredHolds({ rows, now })`) reads the clock. They write the engine rows and `grants.bookings`. A refund of an invoice reads the open holds (`heldOnRows`) and records `owed` | Not Stripe inputs: carried commands (row 13), recorded in the log with their own times (`payload.command.occurredAt`, the lock's `expiresAt`, command ids `bk:<id>:<step>`). `startsAt` is in no event and is not needed to replay a recorded settle. The grants-row half is not reproduced by `runOnState`, so a refund that follows a booking command can decide differently in a candidate: the holder is `not_replayable`, reason `booking_writes`, from that refund on (A.5). |
| 21 | (booking addendum) Booking ids, the booking index, the booking payment (0.8.0) | the booking id is the caller's (a UUID in the family service) or, for a paid session, `metadata.booking_id`; a refund finds its booking through `StripeEventInput.bookingIds` (caller's index of payment intent or charge to booking) or the charge's metadata; the fee is the caller's `input.fee`. The reference handler passes none of them | Stored: the fact keeps `booking_id`; `booking_refs` holds the index entries used; `fee` holds the fee. A paid or refunded booking is a stored input and replays, its `payment.succeeded` / `payment.refunded` lines re-decided and compared by `idem`. |
| 22 | Gift codes, member codes and discounts (0.8.0) | a gift code's id and `issuedAt`/`now` are the caller's; its credit row id is derived (`ce_gift_code_<length of id>_<id>_<feature>`, so no two pairs meet); `createHash` in `codes.ts` only names Stripe objects. Member codes are in the menu; an invoice's discount amounts are in the fact | Redemptions and code creation are not Stripe inputs: carried (the credit row is an engine mutation). No code reads a clock or random source (checked: nothing under `src/billing` has `Date.now`, `new Date()`, `Math.random` or `randomUUID`). Menu `codes` are in the context row. Discounts change no credit (`UPGRADING.md`), and the fact holds the amounts. |
| 23 | (booking addendum) What the booking decisions read | `menu.timeZone` (`money.ts:83`) and the two versions (`booking-events.ts:115-116`); no other menu or policy content, and not `input.now` | The context row. A candidate menu's time zone moves the lines' date; the versions only the labels (A.4). A test pins this. |
| 24 | (booking addendum) The ULID a non-handler caller passes as `eventId` | `handle.ts:611` accepts any ULID | Stored as `input_id`, read by replay. |
| 25 | (booking addendum) A booking money line's id | `ledgerEvent` is given no revision (`postings.ts:323`) | Independent of the holder's revision, unlike a credit event (row 3). |
| 26 | (booking addendum) Which writer applied an event first | the handler and the family service's endpoint both write inputs | One table, one `AUTOINCREMENT` in write-serialized transactions (`BEGIN IMMEDIATE`): the contract in A.2. |
| 27 | (booking addendum) The caller's `invoiceIds` for a booking's charge | a hit sends the refund to the invoice rules (`booking-events.ts:278`) | Replay's invoice map holds invoice refs only (a booking input stores no `payment_refs`), so a booking's refs cannot hit it. |
| 28 | (booking addendum) Time zone database for a booking line | as row 6 (`tz` is applied to the instant) | Not controlled, as row 6. |

### The proof run (throwaway, not committed)

A script built the real handler over each of the 8 `delivered/` scenarios (retrying 409s as Stripe does, remembering the order of application), then replayed the stored inputs through `handleStripeEvent` with an in-memory store: the rows evolve with `applyRowChanges`, the two index maps are rebuilt, the decision events are deduped by `idem`. Result: in 8 of 8 scenarios the replayed events equal the handler's outbox byte for byte, run twice and under four time zones, before and after the merge of #69 and again on the 0.8.0 tree. Replaying in Stripe's created order instead of the applied order also matched on these fixtures, but that is not evidence that order is irrelevant: the script did not model the handler's waits (its driver indexed a payment before its invoice, and refused one dispute that had no link yet), and the fixtures hold no out-of-order raise invoices, which `ROADMAP.md` says do depend on order. The stored order is `applied_order`, not `stripe_created`.

### The log's own commands are interleaved

Replay of Stripe inputs alone is exact only for a holder whose every write was an input. When the family service also spent credits, a later `reset` or refund ran on rows the replay would not have. The design does not give up on those holders. Each stored input records `revision_before`. The log's events carry the engine mutation with `revision.before` and `revision.after` (`src/ledger/replay.ts`, `recordedMutations`). So per holder the driver builds one timeline:

1. Items are the stored inputs (applied) and the log's commands whose `cause` is not the `input_id` of a stored input (the carried commands: spends, lapses, adjustments, and (booking addendum) the booking commands, `bk:<id>:<step>`, whose engine half runs like any other; their grants-row half is not reproduced, which is what `booking_writes` is about, see below).
2. They are ordered by the recorded revision (`revision_before` of an input, `revision.before` of a command), ties by `applied_order`, then the log's order. The order is fixed from the recorded history; the candidate then evolves its own revision.
3. An input runs through `handleStripeFact` on the candidate's rows. A carried command runs through the same engine path `simulate()` uses (`runOnState` with `withPolicy`) on the same rows, converted with `stateFromRows` and written back with `rowChangesFromMutation`.

B may ship this in two steps: first holders with no carried commands (every `revision_before` matches), reporting the others as `not_replayable` with the reason `non_input_writes`, then the interleave. The baseline test below decides when a holder counts as replayable: its baseline must equal the log.

### What cannot be replayed

- Inputs not stored (handled before the upgrade, or foreign, or never normalized, or not yet shipped when reading a folder): `not_replayable`, with a count.
- A holder whose pre-upgrade rows are not in a seed (should not occur once A is deployed; a seed is taken at the first stored input).
- Erased holders (tombstones).
- (Booking addendum, rewritten.) A holder whose timeline reaches an input that can call `removeInvoice` (a full refund of an invoice's charge, a lost dispute) after a carried command labelled with a booking (`labels.booking`, command id `bk:...`): from that input on, reason `booking_writes`; its decisions from there on are carried over unchanged and counted. Earlier history replays. Only that input reads the booking records the interleave does not reproduce (A.4, A.5). It is conservative in one way (a hold already settled before the refund still counts) and the first improvement once a school with credit holds needs the what-if on refunds.
- (Booking addendum.) A holder whose paid or refunded booking was written before the upgrade, or by an endpoint that did not call `recordInput`, left a revision gap with no log event or stored input: `non_input_writes`, as for the caller-row import. After the upgrade a booking decision is a stored input and leaves no such gap.
- The caller-row import (`grantsStateFromCallerRows`, `src/billing/adopt.ts`) writes rows with no input: for a holder imported after its seed it is a revision gap with no carried command in the log, reported as `non_input_writes`.

## 5. The simulate mode

`simulate()` and `atm simulate` of 0.6.0 stay as they are, byte for byte (same function, same flags, same golden files). A new function and a new set of flags select the inputs mode.

### What it does

For one school and one env:

1. Read the log events (`--root`, `--school`, as in 0.6.0) and the stored inputs (`--inputs`, `--env`): from a SQLite file or a shipped folder, through the same `InputsSource`.
2. Classify: the log's events whose `cause` is the `input_id` of a stored input (booking addendum: stored, not recomputed; for the handler it is the `inputCauseId`) are decisions of that input. Other events are carried (the family service's commands: spends, holds, lapses, gift-code redemptions). The money lines an input made (payment, refund, payout, dispute and `dispute.closed`, `money.skipped`) name that input as `cause`, so they are its decisions and the baseline compares them; a dispute's opening line made by two inputs belongs to the first applied (row 18). The log has no env (`docs/log-and-r2.md`): serve each env from its own database and shipper, as the docs recommend, or the other env's events are carried as if they were the family service's.
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
what-if on the grant rules covers only history after 2026-11-12 (the first delivery handled by the next release (number not yet chosen)).
```

### Out of scope

- What Stripe charged: payments, refunds, payouts, disputes and fees are replayed from the same facts and come out the same; no USD total moves, only credit units and the postings that follow from them (as in 0.6.0).
- (Booking addendum, rewritten.) A what-if on the booking calls themselves: `cancelCutoffHours`, `noShow`, `lateCancel` (the booking commands are carried as recorded; reported as `notSimulated`, A.4), a bookable item's price or quote (a caller's call, not a Stripe input), and a holder's history from the first invoice-removing input after a credit-hold command (`booking_writes`). Bookings paid in money are in scope: their events are stored and replayed.
- Events whose inputs were not stored before this change, and events of erased holders: `not_replayable`, counted, carried over.
- A different mapping (a later change to `schema/mapping/` cannot be replayed from facts).
- `lowCreditThreshold` alerts and the cron's expiries beyond what `simulate()` already does (README, "What it cannot", items 3 to 5).
- Changing the order of delivery or inventing deliveries.

## 6. Migration of existing databases

A database that predates the storage has no `atm_event_inputs` table and no stored input. The feature is unavailable for its earlier history, and the CLI says so:

- `inputsStatus` returns `{ available: false, reason: "no_table" }` (the table does not exist yet: the handler of this version creates it on start) or `reason: "empty"` (the table exists and holds nothing for the school and env).
- `atm simulate --inputs` on such a database exits 2 with: `this database holds no stored inputs for school <id> (live): the handler stores them from atm 0.9.0, so a what-if on the grant rules covers only the history after that; run atm simulate without --inputs for the command-level what-if on the whole log`. On a folder: `no inputs under <folder>/schools/<id>/inputs/live: run atm inputs ship, or point --inputs at the handler's database`.
- After the upgrade, every delivery is stored, and each holder that already had rows gets a seed at its first stored input, so its later history is replayable without the history before it. Earlier decisions of that holder are carried over unchanged and counted.
- Nothing is backfilled: the raw events are not in the database and re-fetching them from Stripe is out of scope.
- A database from before #69 is rebuilt by `migrateHandlerSchema` as before; the order of the two does not matter (`HANDLER_DDL` creates the new tables whether or not the four older ones are current).

## 7. Interfaces

Shared by A (storage), C (ship) and B (simulate). Names are the contract; fields may gain optional members, not lose any. Types live in `src/types.ts` with the other public declarations; code in the files named.

### Shared pieces (A creates; B and C import)

```ts
// src/handler/inputs.ts

export const REPLAY_METADATA_KEYS = ["b4u_school", "family_id"] as const;

/**
 * A BillingFact without what the rules never read: its source, the invoice number and the bearer links. (Booking
 * addendum.) It includes `Omit<CheckoutSessionFact, "source">`, a booking's payment, with metadata cut to
 * `b4u_school`, `family_id`, `booking_id`. A1 (#85) has this in `src/types.ts` (with `StoredFactBody`, `NormalizedStripeEvent`
 * and `StripeFactInput`) and `replayFactOf`, `inputCauseId`, `contextHashOf`, `REPLAY_METADATA_KEYS` in this file.
 */
export type ReplayFact =
  | Omit<BillingInvoice, "source" | "number" | "hostedInvoiceUrl" | "invoicePdf">
  | Omit<BillingRefund, "source">
  | Omit<BillingDispute, "source">
  | Omit<SubscriptionFact, "source">
  | Omit<InvoicePaymentFact, "source">
  | Omit<StripePayout, "source">
  | Omit<CheckoutSessionFact, "source">; // booking addendum

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
// src/billing/handle.ts (A, small refactor of lines 614-626, plus the one read at line 347; no behaviour change)

export type NormalizedStripeEvent =
  | { ok: true; target: MappingTarget; mappingLabel: string; apiVersion: string; type: string; fact: BillingFact }
  | { ok: false; refusal: StripeEventRefusal };

/** The mapping and normalization step of handleStripeEvent, exported so the handler stores the fact the rules will decide on. */
export const normalizeStripeEvent = (event: unknown, eventId: string): NormalizedStripeEvent;

export type StripeFactInput = Omit<StripeEventInput, "event"> & {
  /** The stored replay fact, with `source` rebuilt by the caller. */
  fact: ReplayFact;
  target: MappingTarget;
  /** The event type. The dispute rule (`handle.ts:347`) reads it to tell `charge.dispute.closed` from `.created`; it must not read `input.event`, which does not exist here. */
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
  inputId: string;            // booking addendum: the ULID passed as eventId; names the lines' `cause`
  bookingRefs: Record<string, string> | null; // booking addendum: payment intent or charge id to booking id; null after erasure
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

/**
 * Writer. Runs in the caller's transaction (it opens none); throws on a storage error so the transaction rolls back.
 * (Booking addendum.) Exported from the package: the family service's endpoint calls it for a booking's session and
 * refund, after its rows and `appendToOutbox`, in the same write-serialized transaction. Returns "existing" and writes
 * nothing when `(env, event_id)` already has an applied row.
 */
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
  paymentRefs: readonly string[] | null;   // invoice inputs only
  inputId: string;                         // booking addendum: the ULID passed to handleStripeEvent as eventId
  bookingRefs: Readonly<Record<string, string>> | null; // booking addendum: the bookingIds entries the decision used
  nowMs: number;
  atmVersion: string;                      // the constant `atm --version` prints
}): "stored" | "existing";

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
  reason: "inputs_not_stored" | "non_input_writes" | "booking_writes" | "erased" | "context_missing";
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

(Booking addendum.) Bookings in the split: A1 (#85, in review) already covers the checkout session and the booking refund in `normalizeStripeEvent`, `handleStripeFact`, `replayFactOf` and `ReplayFact`, and tests the six recorded booking events through both entry points. A2 adds the exported `recordInput` (with `inputId` and `bookingRefs`), the two columns, the erasure of `booking_refs` and the endpoint recipe in `UPGRADING.md`; C adds the two columns to the shipped line and nothing else; B adds the narrowed `booking_writes`, `notSimulated`, `DecisionSummary.booking` and the booking commands in the interleave. Detail and the tests that are missing: last section, A.7.

PR A is the storage: the tables, the write, the helpers and the erasure hook (no salt: crypto-shredding was not chosen). It may be one PR; splitting the pure refactor out as A1 (about 150 lines, no database) lets B start earlier. PR C ships and reads the shipped copy and depends on A2 for the columns and types. PR B replays and diffs and reads through `InputsSource`.

What can run in parallel:

- **A1 first**, alone, small: B cannot compile `replayInputs` without `handleStripeFact`, and A2 and C need the fact types.
- **A2, C and B in parallel after A1**, because this document fixes the DDL and the signatures: A2 writes the tables and the handler; C develops against the DDL and the `StoredInput` type, with its tests inserting rows by hand until A2 lands; B develops against an in-memory `InputsRead` built by a test helper from the recorded fixtures.
- **Merge order:** A1, then A2, then C and B in either order. B's end-to-end baseline test (real handler, real stored inputs) needs A2 merged; B's folder source needs C. B ships with the SQLite source first and adds `--inputs <folder>` when C has landed, which is one `InputsSource` and one CLI branch.
- A2 and C both touch `src/cli.ts` (C adds the `inputs` command group, B adds flags to `simulate`) and `src/types.ts`; those are the merge conflicts to expect.

## 9. OWNER DECISIONS

All items are decided. The reasoning that led to each is kept in the sections cited.

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
| 11 | **Erasure of the shipped objects** | DECIDED 2026-11-05 | Rewrite with a tombstone: a new content-addressed key for the rewritten batch, create-only; re-point SQLite; delete the old object; a queue makes it resumable; `atm inputs ship` exits 1 while one is open. Crypto-shredding is rejected: it leaves every line joinable through the other Stripe ids (100% of the 64 recorded facts carry one), it needs a key table that makes the shipped copy depend on SQLite and its backups, and it cannot use salted hashes because the recorded events embed the raw ids. Section 3. |
| 12 | Accept the window in which the old object still holds the facts | DECIDED 2026-11-05 | Yes, accepted: it ends at the next ship run (hourly), `atm inputs ship` exits 1 while it lasts, and readers prefer the tombstone. Condition, a deployment precondition and an item for the ops checklist: bucket versioning and replication are off for the `inputs/` prefix (or the old versions are purged as part of the erasure). |
| 13 | Are the ids left in shipped lines acceptable? | DECIDED 2026-11-05 | Yes: Stripe ids and family or customer ids in shipped lines are accepted. The shipped events log already carries `family:<id>` and `stripe:<id>` idems for every holder and the existing erasure leaves them; the inputs add the same class of ids. If ids are ever to go from shipped inputs after an erasure, that is a decision for the events too. |
| 14 | Ship refused rows? | DECIDED 2026-11-05 | No: refused rows are not shipped. They change (attempts, replaced when applied) and a shipped copy is the immutable record of what was decided. The SQLite source alone has the `newly_applied` view; a folder source has none. |
| 15 | R2 flags and credentials on the CLI in the first release | DECIDED 2026-11-05 | The first `atm inputs ship` release takes the non-secret R2 flags (bucket, endpoint, prefix) and reads credentials from the environment only; no configuration file; the PR states that it has not been run against R2 (as for `atm ship`). |
| 16 | Ship tombstones | DECIDED 2026-11-05 | Yes: they carry no personal data and keep `applied_order` gapless, so a replay can say "n inputs of an erased holder". |
| 17 | Ship cadence | DECIDED 2026-11-05 | Hourly (at most 24 objects a day per env), inputs shipped before events; a `day.jsonl`-style combine for inputs waits for the events combine. |
| 18 | Store booking checkout events (`checkout.session.*`, the refund of a booking's charge) | DECIDED 2026-11-05 (reverses the earlier recommendation of no) | Yes, stored in phase 1. (Booking addendum, rewritten.) The reference handler ignores them and the refund needs the family service's `bookingIds`; so the family service's endpoint stores them in its own transaction: export `recordInput`, add `CheckoutSessionFact` to `ReplayFact` (done in A1), and `booking_refs` and `input_id` columns. Their decision reads no menu or policy content (only `menu.timeZone` and the two versions, as labels) and, since #84, makes money lines that replay re-decides. The fact is trimmed like the others (no email, name, address, payment-method details or receipt links; metadata cut to `b4u_school`, `family_id`, `booking_id`). |
| 19 | Holders with credit holds | DECIDED 2026-11-05 before decision 18's reversal; re-derived in the addendum, to be confirmed | (Booking addendum, rewritten.) `booking_writes` stays but narrowed: from the first invoice-removing input (full refund of an invoice's charge, lost dispute) that follows a booking-labelled carried command. Paid and refunded bookings are inputs and replay; a seed alone no longer flags a holder. The booking records' recovery from the log was checked: of a hold's record, everything but `startsAt` is readable from its logged command (`value`, feature, `occurredAt`, the lock's `expiresAt` and `expiryAction`), its mutation (the lock row) and the replayed state (`resetsAt`), by reading the code, not by a rebuild that was run; `startsAt` is in no event (A.4). Last section, A.5. |

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
- Disputes: every dispute fixture and the `dispute-won` and `dispute-lost` scenarios through both entry points give equal results, `closed` included (a `handleStripeFact` that reads the type from a missing `input.event` fails here); a `charge.dispute.closed` delivered before its `created` makes the opening line once, owned by the first applied, in the handler and in the replay.
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

- **Holds.** (Booking addendum, rewritten.) A holder with a `holdBooking` and then a full refund of the invoice that granted the held credits (the `owed` case) is reported `not_replayable` with `booking_writes` from the refund on, and identical before it, not replayed into a wrong refund; a holder with a `holdBooking` and no refund after it is replayable; a holder with a paid booking session is replayable (its session is an input and leaves no revision gap); a paid booking written without `recordInput` leaves a gap and is `non_input_writes`; the other holders of the same database are replayed and identical. The booking tests in the last section (A.7) add the rest.

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
- skip the `idem` dedupe (fails a duplicate-delivery history and the dispute that two events make);
- read the event type from the raw event in the dispute rule (fails the dispute fixtures through `handleStripeFact`);
- replay a refund that follows a booking command as if the commands were engine-only (fails the refund-with-a-hold case); flag a holder for a booking command alone (fails the replayable-hold case);
- a CLI that exits 0 on a baseline mismatch (fails the exit-code test).

### CLI (B)

Exit 0 with no candidate and a matching baseline, 1 with a differing candidate, 2 for each bad input in section 5 (no table, no inputs, a folder without the prefix, bad menu, bad policy, a baseline mismatch, a missing `--env`); the 0.6.0 tests in `tests/simulate.test.ts` pass unchanged; the output names the not-replayable count.

## 11. How the numbers were measured, and what is not verified

Throwaway scripts, kept in `/tmp`, not committed (they import the package's own `normalize`, `redactPersonal`, `handleStripeWebhook` and `handleStripeEvent` from the worktree):

1. **Bytes.** For each JSON event of the handler's types under `fixtures/billing/stripe/recorded/` (not `booking/`): `JSON.stringify` length of the raw event, of `redactPersonal(raw, mapping)`, of `normalize(raw, mapping)`, and of that fact without `source`, `number`, `hostedInvoiceUrl`, `invoicePdf` and with metadata cut to the two keys (the metadata cut changes nothing on these fixtures, which carry only those two).
2. **Personal fields.** A walk of every path of every raw event matching name, email, address, phone, card, receipt, link and description patterns, counting non-null values per event type.
3. **Replay equality.** The real handler over the 8 `delivered/` scenarios; the order of the 200 answers; a replay driver (in-memory rows, `applyRowChanges`, its own two index maps, dedupe by `idem`) over those inputs, whole and cut to the mapped paths; comparison of the sorted canonical event bodies; repeated under four `TZ` values; re-run after merging `dev` with #69, and again on the 0.8.0 tree.
4. **Identifiers.** A walk of every string of the 64 trimmed facts, counting `family_id` values and Stripe ids by prefix (`evt_`, `in_`, `sub_`, `cus_`, `pi_`, `ch_`, `price_`) and their bytes.
5. **Line size.** One canonicalized shipped line built for an `invoice.paid` with every column filled with a realistic value.
6. **Hash cost.** 2,000 runs of `sha256(canonicalize({ menu, policy, priceIds }))` for the recorded menu.

Not verified, or only read:

- Everything is on scrubbed sandbox fixtures (test mode, one API version). Real live events carry more personal fields than the counts show, and a larger variety of invoices.
- No fixture has a payout, a family-service spend or hold (the year fixtures have the family's own engine `track` and `finalize` with locks, no `holdBooking`), a gift code, a paid booking in a history (six recorded booking events exist, one family's, run one by one: A.7), a closed dispute delivered before its created, a caller-row import or a seed; the interleave and the seed are designed from the code, not run. The first test of B on `fixtures/vibes-year` is where they get proven.
- The shipper, the erasure rewrite and both readers are designed from `ship.ts`, `store.ts` and `files.ts`, not run. Nothing in this design has been run against R2 or SeaweedFS; `R2Store` delete is "read the sha, then delete" (`docs/log-and-r2.md`), not conditional.
- The ICU time zone database (row 6 of the fidelity table) is not controlled.
- That Stripe lists events for 30 days, and that Stripe retries a non-2xx for three days (the latter is the handler's own comment), were not checked against Stripe.
- The size figures for 1,000 families assume three events per family-month; the storage and shipping PRs should measure real rows.
- `AUTOINCREMENT`, a partial index and `json_valid` in `CHECK` were not run through the family service's Litestream; `json_valid` is used by `atm_rows`, the others are plain SQLite. `AUTOINCREMENT` makes SQLite keep a `sqlite_sequence` table: check that a Litestream restore keeps it.
- Whether a bucket's versioning, replication or lifecycle rules apply to the inputs prefix is a deployment fact this repository cannot see.

## Addendum: booking events are stored

Decided by the owner on 2026-11-05 (this reverses the earlier recommendation, decision 18): the Stripe events of a paid booking are stored as inputs in phase 1, like every other handled input. This section is the decided state. Where the rest of the document said the opposite it has been rewritten and the spot is marked "(booking addendum)". Everything here was checked on the tree at `origin/dev` `21641e901`, which contains #84 (a booking's payment and refund are booked as money lines) and not A1 (#85, in review at `19726c2bc`); A1's signatures were read from that branch. Line numbers are of the `dev` tree. Throwaway scripts (kept in `/tmp`, not committed) made the measurements; what was only read is said so.

### A.1 Which events are booking events, and how each is processed today

A booking event is a Stripe event that `handleStripeEvent` decides through `decideCheckoutSession` or `decideBookingRefund` (`src/billing/booking-events.ts`), called from `decideAndRun` (`src/billing/handle.ts:672-687` on `dev`). Four mappings feed the first (`schema/mapping/stripe.checkout.session.{completed,async_payment_succeeded,expired}.v1.json`, target `CheckoutSessionFact`; the `charge.refunded` mapping, target `BillingRefund`, feeds the second and also reads `metadata.booking_id` from the charge).

| Stripe event | What atm decides | Rows written | Decision events | Outcome for the caller |
|---|---|---|---|---|
| `checkout.session.completed` or `.async_payment_succeeded`, payment mode, with `metadata.booking_id`, `status: complete`, `payment_status: paid` | `decideCheckoutSession` (`booking-events.ts:129-257`) | the grants row only, revision + 1 (`writeGrants`, `:73-98`): `bookings[bookingId]` with state `paid` and the payment (`:216-232`); a subject with no rows gets a holder from the metadata (`:233-238`) | `payment.succeeded` (gross `amount_total`, income `income:billing:booking`, idem `stripe:<payment intent id>`, `fee` from the caller's `StripeEventInput.fee`), or a `money.skipped` of kind `booking` for a non-USD session (`money.ts:236-290`) | `booking.action: "paid"` |
| the same event for a booking that is already paid, held or spent by another session | refused `rejected` (`:185-194`) | none | none | refusal (stored as `refused`) |
| the same event again, or the same session again | `nothing` (`:176`) | none | none | none |
| `checkout.session.completed` with `payment_status: unpaid` (a delayed payment method) | `nothing` (`:174-175`); its `async_payment_succeeded` decides | none | none | none |
| `checkout.session.expired`, payment mode, with `booking_id` | outcome only (`:153-171`); `nothing` when the booking was paid by another session (`:155`) | none | none | `booking.action: "expired"` |
| a session without `b4u_school`/`family_id` for a booking whose holder is unknown | refused `missing_metadata` (`:147-151`) | none | none | refusal |
| `charge.refunded` of a booking's charge (not an invoice's: `:278-279`; the booking is named by `bookingIds` on the payment intent or charge, else by the charge's own `metadata.booking_id`: `:280-283`) | `decideBookingRefund` (`:264-347`) | the grants row only, revision + 1: the record's `payment.refunded` running total moves up, and its state becomes `refunded` on a full refund | `payment.refunded` for what the charge's running total rose by, idem `stripe:<event id>`, or a `money.skipped` of kind `refund` (`money.ts:297-375`) | `booking.action: "refunded"` or `"partly_refunded"` |
| a booking refund that arrives before the booking's payment, or names another payment intent | refused `unmatched_booking` (`:288-302`) | none | none | refusal: the caller answers 409 and Stripe retries |
| a booking refund that raises nothing (a redelivery, an older smaller total) or whose booking is already `refunded` | `nothing` (`:305-307`) | none | none | none |
| subscription- or setup-mode session, or payment mode without `booking_id` | `nothing` (`:141`), decided from the fact alone | none | none | none |
| `charge.refunded` of an invoice's charge | not a booking event: `decideBookingRefund` returns null and the invoice rules go on | | | |
| `charge.dispute.*` on a booking's charge, `checkout.session.async_payment_failed` | not mapped for bookings (`docs/financial-reports.md`, "Not covered"; `ROADMAP.md`, "The reference webhook handler has no booking index") | | | |

**Who calls `handleStripeEvent` for them.** The reference handler never does. `HANDLED_TYPES` (`src/handler/stripe-webhook.ts:163-173`) has no `checkout.session.*`, so they answer 200 `ignored` with no claim (`:958`, `ignoreUnmapped`). A booking charge's `charge.refunded` is in `HANDLED_TYPES`, but `locateSubject` finds its subject only through `atm_payment_index` joined to `atm_invoice_index` (`:395-425`), which a booking charge is not in, so it answers 409 `unmatched_payment` before any claim (`:986-990`). Nothing under `src/handler/` mentions a booking (checked: no match for `booking` in `src/handler/*.ts`), `WebhookResponse.body` has no field for the `booking` outcome, and the handler passes no `bookingIds` and reads the fee only for `invoice.paid` (`feeOf`, `:578-582`). By contract the caller is the family service's own endpoint: "Call `handleStripeEvent` for them, with `bookingIds` ... write the rows and act on the outcome in one transaction" (`UPGRADING.md:65`), and the module header says the same (`booking-events.ts:23-24`). **No such caller exists yet:** `buzz-school` pins `atm-v0.6.0` (`packages/family-service/package.json:47`, read at `9f34793c5`) and the booking integration is still an open `buzz-school` item (`ROADMAP.md`, "In `buzz-school`"). So "the family service's endpoint" below is a contract to build against, not code that was read.

**The money lines are decisions, not carried events.** Since #84 a paid booking and its refund make `payment.succeeded` / `payment.refunded` / `money.skipped` inside the same decision, with the input's ULID as `cause` (`bookerOf`, `money.ts:78-85`). Replay therefore re-decides them (it does not carry them) and the baseline compares them by `idem` and canonical body, exactly as for an invoice. The text of the first draft, that these decisions return `events: []`, was true only before #84 (`UPGRADING.md:7-8`) and is withdrawn. A booking's payment is keyed by its payment intent (`stripe:pi_...`), so a second event for the same payment under another event id leaves one line, which the dedupe by `idem` (row 15) reproduces.

### A.2 Where storage happens

**Chosen: the family service's endpoint calls the exported `recordInput` in its own transaction.** (Decision 18 stands.) Reasons, each from the code:

1. The caller has to act on the `booking` outcome (confirm the booking, store the payment intent into its `bookingIds`, free the slot, cancel) in the same transaction as the rows (`UPGRADING.md:65`). The reference handler has no way to hand the outcome out (`WebhookResponse` has no field, and `src/handler/` knows no booking), and the booking tables are the family service's.
2. The refund needs `bookingIds`, an index only the caller keeps (`StripeEventInput.bookingIds`, `types.ts` "Booking ids by payment intent id"). The handler would need a new table of its own.
3. The fee of a booking's payment is read by the caller from Stripe's balance transaction; the handler's `paymentFee` hook is called only for `invoice.paid` (`stripe-webhook.ts:578-582`).

**The minimal change if the owner later wants the reference handler to do it** (not chosen), and its risk:

- add `checkout.session.completed`, `.async_payment_succeeded`, `.expired` to `HANDLED_TYPES` (`:163-173`) and a branch in `locateSubject` (`:377-381`) that reads the holder from the session's `metadata` (`holderMetadata` already returns `object.metadata` for any type that is not `invoice.paid`, `:302-304`);
- a new table `atm_booking_index` (payment intent or charge to booking and subject), written in `applyOnce` after the outbox append (`:648`) when `result.booking?.action === "paid"`, and read in `locateSubject` for a `charge.refunded` that has no payment-index hit (`:395-413`), passing `bookingIds`;
- `WebhookResponse.body.booking`, and a `paymentFee` call for the session event.

Risk: it changes the answer an existing deployment gets for events it already sends. A school that subscribed its endpoint to the three session types today gets 200 `ignored` and no row; after the change it would claim them, write rows and outbox lines for a booking the handler cannot confirm, and answer 422 `missing_metadata` or 409 where it answered 200. A booking refund goes from a 409 that Stripe retries for three days to an applied write. The goldens that mention these events are the unit tests in `tests/booking-pay-events.test.ts` and `tests/booking-money.test.ts`, which call `handleStripeEvent` and not the handler; no handler test (`tests/webhook-handler.test.ts`, `tests/handler-*.test.ts`) names `checkout.session` or `bookingIds` (checked by `grep`), so no existing golden would move, but `UPGRADING.md` would need a section. It also doubles the places that must keep the booking index in step with the family service's. Not worth it for phase 1.

**What the chosen path needs from the caller** (the contract the PR for A2 writes into `UPGRADING.md`):

1. One transaction, serialized for writes (`BEGIN IMMEDIATE`, as `bunSqlite` does), so that `applied_order` is the commit order across the handler's writes and the endpoint's: load the subject's rows and revision, call `handleStripeEvent` with the same `eventId` rule as the handler, write the rows (revision-checked), `appendToOutbox`, write its own booking tables, then `recordInput`. A throw rolls all of it back; Stripe retries.
2. Route before the reference handler: `checkout.session.*` always to the endpoint's own code; a `charge.refunded` to the endpoint's code first when its `bookingIds` knows the payment intent or charge (or the charge's `metadata.booking_id` is set), else to `handleStripeWebhook`. A refund answered by both would be a double decision; `recordInput` returns `"existing"` and writes nothing when `(env, event_id)` already has an applied row, so a double call cannot store twice (the rows and the outbox are still the caller's to guard; the outbox drops a repeated `idem`).
3. The `eventId` it passes must be a ULID (`handle.ts:611`). The reference handler passes `inputCauseId(...)`. Because any ULID is accepted, `recordInput` stores the one it was given (new column `input_id`, A.3), and replay reads it from there instead of recomputing it. Recommendation: use `inputCauseId` anyway, so that the value is derivable.
4. `recordInput` is called for every session or booking refund the endpoint handled and that has a holder (a `b4u_school` or `family_id` in the metadata, as `ignoreForeign` tests for invoices), with outcome `applied`, or `refused` for a 422-type refusal (`missing_metadata`, `bad_event`, `rejected`, `unmatched_booking`); not for a refusal the endpoint answers as a wait without a claim, as in the table in section 2. This includes the sessions that decide nothing (subscription mode, unpaid, expired after paid): they cost about 0.3 KB, and it keeps the rule "every handled input" (decision 6) without a special case. If the owner wants those left out, the cut is one condition: `fact.mode === "payment" && fact.metadata.booking_id` (`booking-events.ts:141` decides every other session from the fact alone).

### A.3 The stored fact, the side inputs, the columns

**The fact.** `ReplayFact` gains `Omit<CheckoutSessionFact, "source">`; A1 has done it (`src/types.ts`, #85), with `replayFactOf` keeping `booking_id` beside `b4u_school` and `family_id` for a session (`src/handler/inputs.ts`, `CHECKOUT_METADATA_KEYS`). Field by field, for a session:

| Field | Read by the booking decision | Kept |
|---|---|---|
| `id` (the event, `evt_...`) | no | yes (the fact's allowlist is "everything but `source`") |
| `sessionId` | yes (`:176`, the record and the outcome) | yes |
| `mode`, `status`, `paymentStatus` | yes (`:141`, `:153`, `:174`) | yes |
| `paymentIntentId`, `amountTotal`, `currency` | yes (`:177-182`, the record, the money line) | yes |
| `at` | yes (the money line's time, `:209`) | yes |
| `metadata` | `booking_id`, `b4u_school`, `family_id` (`:140`, `:144-146`) | cut to those three; `b4u_kind` and `profile_id` (a child's profile id) are dropped, and in the subscription-mode fixture `addon_ids`, `interval`, `menu_version`, `tier_id` |
| `source` | `source.mapping` for the label (`:212`) | rebuilt by `handleStripeFact` from `eventId`, `mapping`, `apiVersion` |

Personal data: the mapping's `personal` list covers `customer_details`, `customer_email` and `collected_information` (`stripe.checkout.session.completed.v1.json`), and none of them is a field of the normalized fact, which is built only from the mapping's `fields`. So the fact holds no name, email, address or card detail; what the cut removes is the free-form metadata (the caller sets it). For a refund the `BillingRefund` fact is as in section 1 (no card, no receipt link; it adds `bookingId`, which is the id the charge's metadata carries). Measured on the six recorded booking events with a throwaway script: raw 2,601 to 2,918 bytes, normalized 332 to 474, replay fact 278 to 321 for a session (321, 321, 297 expired, 278 subscription) and 230 and 231 for the two refunds, mean 280 bytes, well inside the 500-byte budget.

**Side inputs, stored beside the fact.**

| Input | Where the decision reads it | Stored in |
|---|---|---|
| the fee of the payment | `input.fee`, `booking-events.ts:195,211` | `fee` (existing column; the endpoint passes it for the paid session) |
| the booking index | `input.bookingIds` for the payment intent or the charge (`:280-283`) | **new** `booking_refs`: JSON object `{ "<payment intent or charge id>": "<booking id>" }`, only the entries for the refs of this fact (null when none was used) |
| the invoice index | `input.invoiceIds` (`:278`: a hit sends the refund to the invoice rules) | not stored: replay keeps its own two maps (row 9). Booking inputs write no `payment_refs`, so a booking's payment intent never enters the replay's invoice index |
| the ULID passed as `eventId` | `cause` of every line, `bookerOf` (`money.ts:84`) | **new** `input_id` (all inputs; for the handler it equals `inputCauseId`) |
| the holder's grants row and revision | `grants.bookings`, `input.revision` (`:90-91`) | `revision_before`, `revision_after`, the seed |
| menu time zone, menu and policy versions | `bookerOf` (`input.menu.timeZone`), `labelsOf` (`:115-116`) | the context row, as for every input |

The refund's `booking_refs` is what the caller's index returned, not what replay would derive: replay can derive `bookingIds[paymentIntentId]` from earlier stored paid sessions (the outcome says so), but the caller's index is the ground truth and may hold entries from before storage began. B compares the two and reports a difference as information, not as a baseline failure. A refund the charge's metadata names needs no entry (the fixtures' refunds are of that kind).

**Columns and values.** `atm_event_inputs` gains `input_id TEXT NOT NULL` and `booking_refs TEXT CHECK (booking_refs IS NULL OR json_valid(booking_refs))` (the DDL in section 2 is updated). `outcome` stays `applied | refused`: a paid, expired, refunded or partly refunded booking is `applied`, and so is a decision that is `nothing`, with `revision_after = revision_before` when it wrote no rows; a non-USD booking is `applied` (the marker is an event). `reason` for a `refused` booking input is one of `missing_metadata`, `bad_event`, `rejected`, `unmatched_booking` (now reachable, through `recordInput`). The `booking.action` is not a column: replay recomputes it, and B reports it in the delivery's `DecisionSummary` (new member `booking: "paid" | "expired" | "refunded" | "partly_refunded" | null`). Erasure (`eraseStoredInputs`) nulls `booking_refs` with the other holder-specific columns; `input_id` names no person (a hash of the school and the Stripe id) and stays. `subject_key` of a refused refund can be unknown to the endpoint: it stays NULL, and such a row is never replayed (and, as every refused row, never shipped).

### A.4 Replay of a booking input

**What the two decisions read** (checked by reading every `input.*` use in `booking-events.ts` and `money.ts`, and by a run): `revision`, `menuVersion`, `policyVersion`, `fee`, `invoiceIds`, `bookingIds`, `env`, `eventId`, `menu.timeZone`, and the grants row of `rows`. They read neither `input.now` (the time is `fact.at`), nor the menu's tiers, prices, bookable items or codes, nor the catalog, nor `priceIds`, nor any policy field. The earlier analysis is therefore verified with two exceptions it missed, both of which reach the lines only as labels or the time zone:

- run on the six recorded events (a refund first, a subscription session, a paid session twice, a second booking, the expired session, the partial and the full refund, and the full one again; nine calls): the results with the grants menu and `DEFAULT_POLICY`, and with a menu with no tiers or add-ons and every one of the policy's twelve fields changed (`upgradeGrant`, the two `removeOn...`, the gift settings, `memberCode`, `deductionOrder`, `lowCreditThreshold`, `cancelCutoffHours`, `noShow`, `lateCancel`) are byte-identical: events, ids, refusals, outcomes and revisions;
- changing only `menu.timeZone` (`America/Denver` to `Pacific/Auckland`) changes the lines' `tz` (the instant `event_time` is the same), and with it the school-local date, so the month a booking's payment is booked to can move: that is a real effect of the candidate and replay reproduces it;
- changing only `menuVersion` and `policyVersion` (3, 1 to 4, 2) changes only the labels `menu_version` and `policy_version`; the ids are the same.

So **a what-if on the grant rules (`upgradeGrant`, the refund and dispute switches, gift amounts, a menu's prices and tiers) changes no booking decision**; it changes a booking line only through `timeZone` and the version labels. The baseline for booking inputs is therefore as strict as for any input, and a candidate run of them is almost always `same`. They still have to be in the replay: they write the grants row (revision + 1), so leaving them out is a revision gap, and the refund of a paid booking is `unmatched_booking` without the paid session before it.

**Forward warning.** The revenue-share design (`ROADMAP.md`, "The share") has the handler make a `share.accrued` for each payment it books, an invoice's and a booking's, from a `policy.revenueShare`. When that is built, "a booking decision reads no policy" stops being true. A test that pins it (below) will fail then, on purpose, and the replay will need the policy for booking inputs without any other change, since `contextFor` already supplies it.

**Replay mechanics.** For a stored booking input B calls `handleStripeFact` with `fact`, `target` (`CheckoutSessionFact` or `BillingRefund`), `type`, `apiVersion`, `mapping`, `fee`, `bookingIds` from `booking_refs`, `invoiceIds` from its own map, `eventId` from `input_id`, `rows` and `revision` from its evolving state, the context from the input's `context_hash` or the candidate. It applies `rowChanges` with `applyRowChanges`, and keeps the outcome. Dedupe by `idem` as for every line.

**Interleave with the booking commands.** `holdBooking`, `confirmBooking`, `releaseBooking`, `cancelBooking`, `noShowBooking` and `settleExpiredHold` are not Stripe inputs and are not stored. Their events carry no `cause` (checked: a hold's `credit.held` has none) and a `labels.booking`, so the classification of section 5 (cause is an `input_id`: a decision; otherwise carried) puts them with the carried commands; the commands are named `bk:<booking id>:<step>` with `<step>` one of `hold`, `confirm`, `release`, `cancel`, `late_cancel`, `no_show`, `expiry`, and `<step>:rollover:<row id>` for the follow-up that moves released units into a rollover (`booking-commands.ts:112-115,546-548,580-585`); that is not the handler's `<ULID>:<n>` (`replay.ts:229`), so `replayEvents` treats them as the family service's. Each event carries `payload.command` (the engine command with `occurredAt`, the lock with `expiresAt` and `expiryAction`, `value`) and `payload.mutation` with its revisions, and `complete: true` (`booking-commands.ts:318`), which lets the replay step over the revision gap a grants-row-only write leaves. So the interleave of section 4 works for the engine half of a booking command with no change: sort by recorded revision, run the logged command on the candidate's engine rows.

**What the interleave cannot do: the grants-row half.** Every booking command also writes `grants.bookings[bookingId]` (the record: state, cost, `startsAt`, `expiresAt`, `expiryAction`, the whole lock row, `resetsAt`, `heldAt`, `settledBy`) and a release or a confirm updates the owed units of refunded invoices (`settleOwed`). `runOnState` on the engine rows does not write those. Only one Stripe rule reads them: `removeInvoice` (`grants.ts:1372-1476`), through `heldOnRows` and `owedOnRows` (`:1400-1405`), reached from `refundToCommands` for a full refund (`:1657-1675`) and `disputeToCommands` for a lost dispute (`:1677-1696`); nothing else in the grant rules reads `bookings` or `owed` (checked: the only uses in `grants.ts`, `handle.ts`, `raise.ts`, `adopt.ts` are those two lines; `redeemed` is read only by `codes.ts` and by a quote, `bookable.ts:241`). What the missing record costs, run with a hold of 3 credits and a full refund of the invoice that granted them: with the record, the refund writes `invoices.in_p.owed = {ce_tier_visit_month: 2, ce_once_in_p_pack_visit: 1}`; with the same engine rows and the grants row stripped of `bookings`, it writes no `owed`. The refund's own events are the same (one `credit.adjusted` of -1) and its row changes are not. The release that follows then withholds the owed units in the real run (`credit.adjusted`, `tests/billing-bookable-review-refund.test.ts`); in a replay without the record it would be the recorded `finalize` that runs, against rows that no longer match (from reading `releasePlan`, `booking-commands.ts:741-748`; not run). A baseline cannot catch that: the refund's events agree. It would be wrong only in a candidate, silently. That is why decision 19 survives in a narrow form (A.5).

**What a what-if on `cancelCutoffHours`, `noShow` and `lateCancel` can and cannot change.** In phase 1, nothing: the booking commands are carried as they were recorded, so the choice they made (release or spend, `bk:<id>:cancel` or `late_cancel`) stays. The log cannot take it further for all three:

- `cancelCutoffHours`: `cancelBooking` compares the call's `now` with `record.startsAt - cutoff` (`booking-commands.ts:869-873`). `startsAt` is in the booking record and in `HoldBookingInput`, and in no event field (checked: no `startsAt` in `src/` outside `booking-commands.ts`, `bookable.ts` and the types). **Not computable from the log**, now or later, unless `startsAt` is stored (open question 1).
- `lateCancel`: computable only when the cutoff is unchanged: a recorded `late_cancel` step says the call was after the recorded cutoff, and the candidate's `lateCancel` then picks spend or release (`:875-881`).
- `noShow`: computable: `noShowBooking` reads only `policy.noShow` (`:885-891`) and the step name and `occurredAt` are in the log. It also sets the hold's `expiryAction` (`:400-402`), so a candidate `noShow` changes what the cron's `settleExpiredHold` does.

Both computable cases need the booking record to be rebuilt in the replay and a settle entry point that takes the recorded intent (`booking-commands.ts` exports no function that settles with a forced `by`): a later phase, with the lifting of `booking_writes`. Until then B must not pretend. Recommended rule: with `--inputs`, a candidate policy that differs from the recorded one in any of the three fields is reported under `notSimulated: [...]` (text and `--json`), the differences are computed on the rest, and when those three fields are the only difference B exits 2 with "cancelCutoffHours, noShow and lateCancel are decided by booking calls, which are not stored: nothing to simulate" instead of 0 (a CI gate must not pass on a change it did not look at). Open question 2.

### A.5 Decision 19, re-derived

Decision 19 gave `booking_writes` to every holder with a booking-labelled command or a seed with `bookings` or `owed`, **because paid and refunded bookings were revision gaps**. They are inputs now, so they replay exactly, and a holder with only paid, expired or refunded bookings is fully replayable. What remains is the credit holds' grants-row half, and it matters only to `removeInvoice`. The conditions that make a holder `not_replayable` now, with the reason each gets, in the order B checks them:

| Reason | Exact condition | Counted from |
|---|---|---|
| `erased` | the holder's inputs are tombstones (section 1) | the first tombstone |
| `inputs_not_stored` | a recorded decision names an `input_id` that is in no stored input (handled before the upgrade; a booking decided by an endpoint that did not call `recordInput`; not yet shipped when reading a folder); or the holder has rows before its first stored input and no seed | the first such decision |
| `context_missing` | an input's `context_hash` has no context object (folder source) | that input |
| `non_input_writes` | a revision gap with no stored input and no carried command: the caller-row import, or a paid or refunded booking written before the upgrade (a gap that *is* a booking write is no longer a case after it) | the gap |
| **`booking_writes` (narrowed)** | **the holder's timeline contains a stored input that can call `removeInvoice` (a `BillingRefund` with `full` true that resolves to an invoice and not to a booking, or a `BillingDispute` with status `lost`), and at least one carried command with `labels.booking` (or `bk:` command id) comes before it in the revision order** | **that input, inclusive** |

The input is chosen by shape (the fact's `full` or `status`, and the invoice link in replay's own index), not by whether the baseline removed credits, so that a candidate with `removeOnFullRefund` flipped is covered too. The holder's earlier history replays; from that input on its decisions are carried over unchanged and counted. What this deletes from the old rule: the seed test (a seed's grants row is stored whole, `bookings` and `owed` included, and is right until a carried booking command changes it, so a seed alone needs no flag); the paid-booking case (inputs); a booking-labelled command alone, with no removal after it (nothing reads the record). `booking_writes` is **not deleted**: lifting it needs the rebuilt record (A.4). The rule is recorded as the first thing to lift once a school with credit holds asks for the what-if on refunds.

### A.6 Nondeterminism: rows 20 to 22 rewritten, rows 23 to 28 added

The table in section 4 now carries them (marked "(booking addendum)"). In short:

| # | Source | How replay controls it |
|---|---|---|
| 20 | hold times: `now`, `expiresAt` (caller's), `startsAt` (caller's) | `now` is the command's `occurredAt` and `expiresAt` the lock's, both in the logged command; `startsAt` is in no event and is not needed to replay a recorded settle (the step name carries the choice). It is what makes the cutoff what-if impossible (A.4) |
| 20b | the expiry sweep's `now` and its pick of holds | each `settleExpiredHold` is a logged command with its own `occurredAt`; the pick is not re-decided |
| 21 | booking ids and the booking index | the id is the caller's (a UUID) and reaches replay in the fact's `metadata.booking_id`, the refund's `bookingId`, `labels.booking` and the command ids; the index is stored as `booking_refs`. Nothing random: `booking-commands.ts` makes every id from the booking id, and no file under `src/billing` reads a clock or a random source (checked: no `Date.now`, `new Date()`, `Math.random`, `randomUUID`) |
| 22 | gift codes, member codes, discounts | as before; a redemption is a carried engine command, `GrantsState.redeemed` is read by no Stripe rule (`codes.ts:149`, `bookable.ts:241`) |
| 23 | the booking decisions' own inputs | A.4: only `menu.timeZone` and the two versions, from the context |
| 24 | the ULID a non-handler caller passes as `eventId` | stored as `input_id` |
| 25 | the booking money lines' ids | `ledgerEvent` gets no revision (`postings.ts:323`: `revision ?? 0`), so a booking line's id does not depend on the holder's revision; the credit events' ids still do (row 3) |
| 26 | which of the two writers applied an event first | one table, one `AUTOINCREMENT` under one write-serialized transaction (A.2, item 1) |
| 27 | the caller's `invoiceIds` for a booking refund | never present for a booking's charge; replay's map holds only invoice refs, so a booking's refs cannot hit it |
| 28 | the time zone database | as row 6 |
| (21) | the fee of a booking's payment | `fee` column, under row 21 |

### A.7 The PR split and the tests

**A1 (#85, in review at `19726c2bc`)** already covers bookings: `normalizeStripeEvent` and `handleStripeFact(StripeFactInput)` are in `src/billing/handle.ts` (the decide step takes `Omit<StripeEventInput, "event">`, also `booking-events.ts`), `ReplayFact` includes `Omit<CheckoutSessionFact, "source">`, `replayFactOf` keeps `booking_id` for a session, `inputCauseId` and `contextHashOf` are in `src/handler/inputs.ts`, `handleStripeFact` rebuilds `source`, and `tests/replay-fact.test.ts` drives the six recorded booking events through both entry points (with the booking index learned from the paid outcome) and checks that dropping `booking_id` is caught. Nothing more is needed in A1 for bookings. (The types are in `src/types.ts`, not in `inputs.ts` as the interfaces of section 7 first had them.)

**A2 (storage)** adds for bookings: `recordInput` exported from the package (the endpoint calls it), with the new arguments `inputId` and `bookingRefs` and the result `"stored" | "existing"`; the two columns; `StoredInput.inputId` and `.bookingRefs`; `eraseStoredInputs` nulling `booking_refs`; no change to `HANDLED_TYPES` or the handler's transaction; a section in `UPGRADING.md` for the endpoint's recipe (A.2). Knip has to see the export used (a test calls it).

**C (ship)** adds nothing special: the line carries `input_id` and `booking_refs` (canonical, snake case), tombstones null `booking_refs`, the reader reduces by `(env, event_id)` as before. Its tests add booking lines to the leak check and to the erasure rewrite.

**B (simulate)** adds: routing a stored fact by `target` (nothing new beyond A1, since `handleStripeFact` routes), `bookingIds` from `booking_refs` and `eventId` from `input_id`, `DecisionSummary.booking`, the narrowed `booking_writes` (A.5), the `notSimulated` rule for the three policy fields (A.4), carrying booking commands through the interleave by `bk:` command id, and a baseline that compares the booking lines by `idem`.

**Tests to add** (the first four are baseline identity, B; the rest follow the section they test):

- Baseline over the six recorded booking events (`fixtures/billing/stripe/recorded/booking/`) through a SQLite-backed "family service in miniature" that does what A.2 says (claim or dedupe, load rows, `handleStripeEvent` with `bookingIds` and a fee, write rows, `appendToOutbox`, `recordInput`, one transaction); `replayInputs` must equal the outbox row for row, from SQLite and from a shipped folder.
- Orders: a refund before its paid session (refused `unmatched_booking`, stored `refused`, then replaced when applied and given a new `applied_order`), a redelivery of each event, the older smaller refund after the larger, a booking refunded in full and paid again by a new session (`booking-pay-events.test.ts` has these as pure calls; none is run through storage).
- A seeded booking history, which does not exist: Stripe invoices plus `holdBooking`, `confirmBooking`, `cancelBooking` before and after the cutoff, `noShowBooking`, an expired hold swept by `settleExpiredHold`, a paid booking and its partial and full refund, and an invoice refund while a hold is open; for this the replay is `booking_writes` from the refund on and identical before it.
- The decision pin: `handleStripeFact` on the booking events under a different menu (same time zone) and all policy fields gives identical results; under another `timeZone` only `tz` and the date differ; under other versions only the two labels differ. It is the test that fails when the revenue share reads the policy.
- No personal data: a session event built with an email, a name, an address, `client_reference_id`, `profile_id` and `b4u_kind`; none of those strings is in the database file or in a shipped line.
- A mutation for each new rule: ignore `booking_refs` (fails the refund-by-index case); use the current time zone instead of the context's (fails a context change); treat a booking-labelled command alone as `booking_writes` (fails a replayable holder), and drop the flag (fails the refund-with-a-hold case); store the payment intent of a booking in `payment_refs` (the replay's invoice index then sends a booking refund to the invoice rules).

**What is missing today** (checked): no fixture or test drives a booking event through SQLite, the outbox or a shipper (`tests/booking-money.test.ts` and `tests/booking-pay-events.test.ts` use an in-memory `world()`; `tests/handler-harness.ts` drives only `handleStripeWebhook`); no seeded history mixes Stripe invoices with the booking commands or a paid booking: `tests/billing-play.ts` and `tests/billing-store.ts` play Stripe events only, `fixtures/vibes-year` and `fixtures/vibes-multi` (via `tests/replay-inputs.ts`) have the family's own engine `track`/`finalize` commands with locks but no `holdBooking`, no `BookingRecord` and no paid booking, and the e2e matrix files name no booking. The six recorded events are one family's, from `stripe trigger` plus added metadata, not from `bookingCheckoutParams`; there is no recorded `async_payment_succeeded` (an edited copy), no non-USD or delayed-payment booking, and no refund that only the index can name (the recorded charges carry `booking_id`).

### A.8 Open questions for the owner

1. **Store `startsAt`?** Without it `cancelCutoffHours` can never be a what-if, and `lateCancel` only with an unchanged cutoff. Storing it means recording the booking calls (the hold's `startsAt` at least) as inputs of their own, which is a Stripe-free input kind the document does not have. Phase 1 says no.
2. **A candidate that only changes `cancelCutoffHours`, `noShow` or `lateCancel`**: exit 2 with a message (recommended) or exit 0 with a `notSimulated` note?
3. **Sessions that decide nothing** (subscription mode, unpaid): stored (recommended, one rule) or skipped (one condition)?
4. **`input_id` as a column.** It keeps replay independent of how the endpoint made its ULID. Alternative: require `inputCauseId` in the contract and drop the column; a caller that does not comply then breaks the baseline silently.
5. **Reference handler.** Keep it out of bookings (chosen), or build the booking index into it later (A.2) so that a school without its own endpoint gets bookings too?
6. **Decision 19 as narrowed (A.5).** It was decided before the reversal of decision 18; the narrowed condition is this addendum's proposal, not yet the owner's.
