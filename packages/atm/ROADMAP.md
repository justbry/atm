# atm roadmap

Status as of 2026-11-05. `- [x]` is built and tested; `- [ ]` is not. This file lists open work only: finished items are in `CHANGELOG.md` (what shipped, release by release, with PR numbers and merge commits), and detail, findings and reference material are in `docs/` (index: `docs/README.md`). What is built is described in `README.md`; what a caller has to change is in `UPGRADING.md`. Competitor behaviour: `docs/comparisons.md`.

**Where the work is.** Everything merged is in `CHANGELOG.md`. What is left is the release of what is on `dev` (see "Unreleased" there), the verification items below and the `buzz-school` side. How a release is made: `docs/releasing.md`.

## Priority: the B4 Uni update and Vibes of Light membership

The critical path. Simulation, corrections, the Parquet export, decoupling and the R2 log path are lower priority and sit below.

### In atm
- [ ] Owner decision (`policy.upgradeGrant`): the invoice of the switch itself still prorates over the OLD cycle (a monthly sparkle-4 x2 moved to yearly x4 grants 128 = 192 x 20/30). Whether a switch should grant the whole 192 is not decided. (detail: docs/review-findings.md#raise-rule-owner-decision-and-known-limits)
- [ ] Known limits of the raise baseline (`GrantsState.quantity`): two raise invoices delivered out of order grant 3 in total where the code before #23 gave 2 + 2 (atm has no ordering guarantee for invoices; closing it needs per-invoice history); a refund of a raise does not roll `state.quantity` back. (detail: docs/review-findings.md#raise-rule-owner-decision-and-known-limits)
- [ ] Open findings of the 2026-11-05 review of #22 to #24 (`code-review high`; its fixes are in the PR that adds this line). (detail: docs/review-findings.md#open-findings-of-the-review-of-22-to-24)
  - #22 (`portalConfigOf`): the portal offers no quantity update to a member who also holds a recurring add-on (verified in the sandbox; listing the add-on's product does not fix it), and nothing flags a quantity outside `quantities`. (detail: docs/stripe-findings.md#portal-limits-found-in-the-sandbox-add-ons-and-older-prices)
  - #23 (raise rule): with a decrease pending, a tier change grants against what the credits hold, less than Stripe charged for, by design; `prorationPair` picks the credit line with no tier or interval check. (detail: docs/review-findings.md#open-findings-of-the-review-of-22-to-24)
  - #24 (adoption; owner decisions): five differences between the import and the caller's lots (no-expiry lots as rollover rows, a lapsed newest lot, partly removed add-on lots, `every: "once"` on a refilling row, `cycleStart` at a month end), and an older-API endpoint's invoices are refused 422 and retried, with only the dashboard as a signal. (detail: same section)
- [ ] **Several subscriptions on one customer** (sandbox spike 2026-11-05, real deliveries to the handler with `env: "test"`): a subscription that holds only a recurring add-on is now refused (422 `addon_only_subscription`) instead of recorded with no credits; supporting one (grant, refill, retire on cancel) is not built. To do: (1) done, refusal; (2) decide between add-ons on the tier subscription with the family service's own quantity page, and engine support for add-on subscriptions; (3) a router helper if several schools share one account. (detail: docs/stripe-findings.md#several-subscriptions-on-one-customer)
  - [ ] Found while reviewing #60 (not caused by it, not fixed): `invoiceToCommands` applies a cycle or update invoice that has a tier line from ANY subscription of the family, not only the holder's own; a tier line on a `manual` or `threshold` invoice still drops its add-on silently; a second purchase of an add-on the member already holds grants nothing; and an update invoice that arrives before its create invoice answers 422 "needs a human" although a retry cures it (the 409 family would fit). (detail: docs/stripe-findings.md)
- [ ] `portalConfigOf` puts `metadata[b4u_key]` after the products, `portalFieldsOf` before them: if the family service's `fieldsHash` depends on key order, switching creates a new configuration once (harmless), but check it. (detail: docs/stripe-findings.md#open-portalconfigof-key-order)
- [ ] The atm test workflow's runner: register a Sprite box to THIS repository (runners are per repository under a user account; buzz-school's `deploy/sprite/ci-runner/add-box.sh`) and set `CI_RUNNER`; point `knip.yml` at the same runner switch, and disable or repoint the inherited workflows that cannot run here. (detail: CHANGELOG.md, 0.4.0, #26)
- [ ] The contract suite under Node (only Bun has run) and against staging R2 (never run). (detail: docs/log-and-r2.md#the-contract-suite-under-node-and-against-staging-r2)
- [ ] Owner decisions, from `UPGRADING.md`: the rollover cap (the caller has none), rollover months on the school's calendar against the UTC calendar, what a lapsed cycle that is not renewed does, whether a yearly grant on a monthly plan (the retreat) should be restored, and `invoiceIds` for payments made before the import. (detail: docs/review-findings.md#adoption-owner-decisions-and-differences-the-import-cannot-hide)
- [ ] Try the import on a copy of the family service's database before any member is moved. (detail: same section)
- [ ] Differences the import cannot hide, from the #24 review (the first group is in `UPGRADING.md`): a post-import session gift expires after `policy.giftSessionMonths` where the caller's lot does not; a refund of a pre-import invoice needs rows in both index tables; `time_zone` against `menu.timeZone`; a downgrade not yet paid; two grants of one feature and interval. (detail: same section)
- [ ] Verify against a real connected account: that a subscription Checkout invoice prints the school's name, address and `us_ein` tax ID, and that `invoice_creation` on a payment-mode session on a connected account gives an `invoice.paid` with our metadata. (detail: docs/receipts.md#invoice-links-and-the-one-time-checkout)
- [ ] **Owner decision: the itemised receipt (`receiptOf`) is not built.** A pure function from a paid invoice's facts plus the school's details and the student's legal name to rows and totals is easy once eight questions are settled: what the receipt is for (per invoice, per session, or both), subject and hours, tax, the student, amounts, how and when paid, a refunded invoice, who owns the document. None can be read from what atm knows; the Tax Commission's answer is needed first. (detail: docs/receipts.md#owner-decision-the-itemised-receipt-receiptof)

### In `buzz-school` (not atm; listed because atm's release waits on it)
- [ ] Move the family service off its own grant rules (`school-billing/grant.ts`, which grants only on create and cycle invoices) onto atm's `handleStripeEvent` or the reference handler, pinned to `atm-v0.3.0`.
- [ ] Credit-spending bookings (`price_mode`, hold then book then cancel refund, no-show forfeit) with `commandOrg(policy)` on every `track`, `check` and `finalize`.
- [ ] The light-bed resource and the back-to-back add-on.
- [ ] Create each school's webhook endpoint with `api_version` `2025-10-29.clover`, subscribe it to `invoice_payment.paid` and the rest, and send the same `Stripe-Version` on every call.
- [ ] Deliver "N visits left" and "pack used up" notices from `credit.low` and `credit.depleted`.
- [ ] Pin the latest release in `bun.lock` (`buzz-school` #1318 pins 0.4.0 and was left there on purpose, for now) and pass `billingKeyMode` as `env`. (detail: CHANGELOG.md, 0.5.0 and 0.4.0)
- [ ] Replace its copies of atm's rules once released: the raise stopgap (justbry/buzz-school#1285, `raiseLots` in #1307) with `prorationPair` and `raiseUnits`, and `portalFieldsOf` with `portalConfigOf`. (detail: docs/stripe-findings.md#portalconfigof-validation-and-portal-behaviour)

## Lower priority, after 0.3.0

### Simulation or what-if
- [ ] `atm billing simulate --menu <file> --policy <file> --events <dir>`: replay the log against a candidate menu or policy and diff journals and per-holder balances against the current ones. No writes. A replay re-decides credits only; it cannot change what Stripe already charged. Orb runs up to five scenarios against historical events.

### Bitemporal, small
- [ ] A `correction` event that names the event it supersedes (`supersedes: <id>`); never delete.
- [ ] The late-event grace window as one config value (default 1 hour, matching the daily combine).
- [ ] Document the effect of a backfill on issued documents: a new version, never an overwrite.

### The log path to R2 (rest of phase 1)
- [ ] Shipping to R2 (`R2Store`): the same call takes it, but it is not run against R2 or SeaweedFS. (detail: docs/log-and-r2.md#shipping-to-r2)
- [ ] The `day.jsonl` combine and `late-*` batches. Open for it: the reader keeps only `late-*` beside a `day.jsonl`, so the shipper reports a day that has one as a conflict (rows stay unshipped); the combine (or the shipper's naming) has to settle how such a day takes later rows. (detail: docs/log-and-r2.md#the-dayjsonl-combine-and-late-batches)
- [ ] Two shippers that read different rows at the same moment, or a crash between put and mark followed by new rows for the same day, write two overlapping batches; the journal is right (repeats dropped by `idem`) but the files hold some events twice until a combine. (detail: docs/log-and-r2.md#two-shippers)
- [ ] The signed monthly manifest (Ed25519) with history, replaced with `If-Match`. (detail: docs/log-and-r2.md#the-signed-monthly-manifest)
- [ ] Replace the third-party PyPI SeaweedFS wheel with the official release, pinned by version and checksum, before CI depends on it. (detail: docs/log-and-r2.md#the-seaweedfs-wheel)
- [ ] A Worker version of the handler. Blocked: Workers refuse `new Function`, which `ajv` uses. (detail: docs/log-and-r2.md#a-worker-version-of-the-handler)

### Financial reports from the log: what is still missing
What exists (#41 to #49, on `dev`, not released) is in `CHANGELOG.md` (Unreleased); the detail of what is missing is in `docs/financial-reports.md`.
- [ ] The fee is the caller's: the family service passes `paymentFee` (it reads the charge's balance transaction first, and answers 5xx when that lookup fails, so Stripe retries). Without it a payment books gross and says `fee_known: false`; a fee that arrives later is not booked. (detail: docs/financial-reports.md#the-money-lines-49)
- [ ] Not built: money lines for disputes, a reversal of a payout that fails after `payout.paid`, non-USD, tax or customer-balance effects separated from the amount paid; a `charge.refunded` without `previous_attributes.amount_refunded` books the whole running total; real Stripe behaviour was not checked. (detail: same section)
- [ ] The family service has to call them (`buzz-school`); until it does the log lacks the credit spend (`recordEngineCommand` and `recordLapse`, #46). (detail: docs/financial-reports.md#the-family-services-own-commands-in-the-outbox-46)
- [ ] **The family service does not call atm's handler, the shipper or the new recorders.** atm's side is done (#47); moving off its own grant rules is `buzz-school` work. The recipe's claims about its runtime (Stripe retry codes, `scheduleJob`, the DDL under Litestream, the cron one-liner, hledger in its image) were read, not run. (detail: docs/financial-reports.md#the-family-service-does-not-call-the-handler-the-shipper-or-the-recorders)
- [ ] **Known mismatch, found by running the handler from #49 and reading its ids (not by running reconcile on it):** a handler-made `payment.refunded` carries the Stripe EVENT id (`evt_...`) while `reconcile` matched refunds on the refund id (`re_...`). #52 (merged into `dev` after this line was written) makes `reconcile` pair such a refund with Stripe's refunds by payment intent or charge and amount; confirm and close. (detail: docs/financial-reports.md#reconciliation-against-stripe-48-and-its-known-mismatch)
- [ ] The `stripe` CLI commands in the README were not run; `--stripe-account` on `list` and some resource names are unconfirmed. (detail: same section)
- [ ] **Revenue is booked when the invoice is paid.** A yearly plan's 12 months land as income at once, with no deferred-revenue account; credits are counted in units, so the balance sheet shows no liability for them. Owner decision: cash basis is enough, or book deferred revenue (and a dollar value for credits). (detail: docs/financial-reports.md#revenue-timing)
- [ ] **Taxes.** The normalized invoice has no tax lines (see the `receiptOf` questions); the reports show gross amounts. (detail: docs/financial-reports.md#taxes)
- [ ] **Real data.** Everything was run on fixtures and on one sandbox account. Run a month of a real school's outbox (a copy) through ship, journal and hledger, and compare its totals with Stripe's dashboard. (detail: docs/financial-reports.md#real-data)
- [ ] **The SQL side** (DuckDB over the log) has a schema and a skipped DDL test, no tested report, and nothing runs `duckdb` in CI. (detail: docs/financial-reports.md#the-sql-side)
- [ ] **Keeping the folder.** `atm ship` writes to a folder on the host's disk: it needs a backup, or the R2 batches and the signed manifest, before it is the record. (detail: docs/financial-reports.md#keeping-the-folder)
- [ ] **The version of hledger.** The report CSV goldens are the output of 1.52.1; CI pins it (#43). `atm report` needs hledger installed and exits 2 when it is not. (detail: docs/financial-reports.md#the-version-of-hledger)

### Ledger export
- [ ] Parquet on R2 from DuckDB (`COPY (... ORDER BY ...)`, `SET threads = 1`), compared by a hash of the rows. After the log path. (detail: docs/log-and-r2.md#the-parquet-export)

### Decouple, the cheap parts
- [ ] A metadata prefix in the policy instead of the hardcoded `b4u_`; menu limits (4 tiers, 6 add-ons, 12 features) in the policy; a generic `holderId` instead of `family_id`.
- [ ] The handler's `atm_event_claims`, `atm_invoice_index`, `atm_payment_index` and `ledger_outbox` keys carry no env: the same Stripe id delivered under both envs would be claimed once. Closing it changes the DDL, so it waits for a schema version. (detail: docs/log-and-r2.md#env-on-the-handlers-tables)
- Separate task: tree-shaking the ~1,200 `@autumn/shared` files the engine pulls in.

### Kept from the quantities and adoption work
- [ ] Split `src/billing/grants.ts` (about 1,600 lines) by concern; the raise rule already moved to `raise.ts` and the caller-row import to `adopt.ts`.
- [ ] Menu-level policy overrides (a policy per menu or tier instead of one per school); today `resolvePolicy` merges one school's overrides over the defaults.

### Webhook delivery
- [ ] Not decided: a reference deliverer beside the webhook handler that signs and sends webhooks from the outbox, with retries and a dedupe key per event.

### Referral codes and reconciliation
- [ ] The ledger has `referral.qualified` and `referral.rewarded` events and postings, but no referral-code table or rules (single use, no self-referral). The B4 Uni purpose-built estimate counts gift and referral codes (220 to 380 lines).
- [ ] A reconciliation query: atm's balances and grants against Stripe's paid invoices, run nightly by the caller. Nothing in `src/` does this yet.

## Decisions taken
- 2026-11-05: PII stripping and a raw input store for usage events are punted; atm stores no raw usage payload and no redacted copy. (docs/usage-metering.md#usage-events-as-a-ledger-source-spike-2026-11-05-decision-pending-on-whether-to-build)
- 2026-11-05: a usage ledger event is an allowlist of the mapping's declared fields (no prompt or message text); `personal` stays a denylist backstop plus the drift check. (same section)
- 2026-11-05: the R2 layer for usage events uses typed quantities as real columns for the hot fields and a manifest written beside the data. (same section)
- 2026-11-05: usage events are written by each gateway worker to a local append-only file (fsynced, not SQLite), closed at about 1,000 to 5,000 events or about 30 seconds, uploaded with a create-only PUT and deleted after success; the daily job dedupes by `idem` and writes Parquet. (detail: docs/usage-metering.md#gateway-write-path-decision-2026-11-05)

## Possible directions, not planned

- **Usage invoicing.** Metered usage pricing is out of scope; atm is a credits and flat-subscription engine. Open decision: pass usage to Stripe meters, or rate it in atm (the second makes atm compete with Stripe Billing). (detail: docs/usage-metering.md#usage-invoicing)
- **Usage events as a ledger source** (three spikes, 2026-11-05; reports in `docs/spikes/usage/`). Decision pending: build it or not. atm stays the credit wallet; Stripe or a separate job prices and invoices.
  - Spike 1, mapping and schema: feasible (about 7 to 9 days to productionize).
  - Spike 2, R2 pipeline: yes for the raw store, aggregation, rating and re-rating; partly for the existing outbox and shipper, which do not scale to this volume.
  - Spike 3, the `track` path as a usage wallet: partly feasible; correct and race-free if the gateway batches, with a hard per-call ceiling; overage is not reportable yet.
  - Punted: PII stripping and the raw input store (see Decisions taken). Open items: the list under "Still open after spike 1" and the "Missing for a report overage to a Stripe meter job" list. (detail: docs/usage-metering.md#usage-events-as-a-ledger-source-spike-2026-11-05-decision-pending-on-whether-to-build)
- **Credit ledger depth.** Not built: drawdown by priority and by cost basis, and a `pending_payment`-style hold on credits whose invoice is unpaid. (detail: docs/comparisons.md#credit-ledger-depth-from-the-orb-metronome-and-openmeter-comparison)
- **Compared with open-source billing** (Lago, OpenMeter, Flexprice, Kill Bill, Polar): written from memory, not run; what atm lacks (prepaid wallets and auto top-up, other payment providers, revenue analytics, SOC 2 and a DPA, and more) is listed there. (detail: docs/comparisons.md#compared-with-open-source-billing-lago-openmeter-flexprice-kill-bill-polar)

## Ruled out
- Per-subject compare-and-swap on R2 (owner decision).
- Rebuilding Stripe Billing's subscription lifecycle (checkout, proration, renewals, retries, trials) or Autumn's server: Stripe Billing owns that, atm owns credits.

## Deferred by trigger (ledger storage spec)
- DuckLake, a copy in a school's own bucket, and a Durable Object per school.
