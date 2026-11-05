# atm roadmap

`- [x]` is built and tested in the PR stack that lands on `dev` (or already merged). `- [ ]` is not. What is built is described in `README.md`. Competitor behaviour comes from the vendors' public docs as read on 2026-11-04, not from running their products.

## Done

### Foundation checks
- [x] Test suite, `tsc`, Biome and the build are green. The 18 failures first seen were already fixed on `claude/atm-cli`; the later property-test failures were fixed there too.

### Stripe coverage
- [x] `customer.subscription.created/updated/deleted` record a `membership` in the grants state: status (`subscriptionStatus`), the tier and interval the menu names for the subscription's price items (lookup key, else price id), renewal or end date, and the event time. Nothing is granted from them; credits still come only from paid invoices.
- [x] An event about another subscription than the holder's, a replay, and an older event change nothing.
- [x] By design (B4 Uni "Default billing rules"): a partial refund and an open dispute change nothing; only a full refund and a lost dispute take unused credits back.
- [ ] The `2025-10-29.clover` API-version pin is still UNVERIFIED; it needs a Stripe test account and recorded test-mode payloads.

### Deduction order and expiry
- [x] The engine's real draw order is documented in the README (buckets, the full row sort, rollovers).
- [x] `balance-engine`: opt-in `org.config.deduction_order: "expiry"` (soonest-lapsing row first, then oldest grant); the default is unchanged. Listed in `UPSTREAM.md`.
- [x] `BillingPolicy.deductionOrder` (default `expiry`, or `engine`) and `commandOrg(policy)`, which the caller puts on every `track`, `check` and `finalize`.
- [x] `credit.expiration_changed`: a row's credits stay but their end date moved (a cancelled plan). No postings.
- [x] The not-yet-paid membership status is named `incomplete`.

### Object store and the webhook path (slice 6)
- [x] `Store` interface (`putIfAbsent`, `putIfMatch`, `get`, `head`, `list`, `delete` by expected sha256, `presign`), typed errors, and the 412 rules (`putOnce`, `replaceIfMatch`).
- [x] `FolderStore` and `R2Store` (on `aws4fetch`).
- [x] The contract suite, passing on the folder store and on SeaweedFS 4.48; staging R2 is gated on credentials.
- [x] Reference webhook handler for Bun/Node: verify signature, claim the event id (a stale claim is taken over), then rows, outbox events and the claim's done mark in one SQLite transaction.
- [x] No per-subject compare-and-swap on R2 (1 write per second per key, and latency on every booking): live balances stay in the caller's SQLite.

### Bugs found and fixed on the way
- [x] `lapse:` idem included no holder, so a second family's `credit.expired` event collided with the first's.
- [x] The same flaw in the new expiry event's idem.
- [x] `handleStripeEvent` accepted Stripe's `evt_` id as `eventId`, so its events failed envelope validation (`cause` must be a ULID). It now refuses a non-ULID.
- [x] A cancel for an older subscription overwrote the live subscription's membership.

### Scope
- [x] The README states atm is a credits and flat-subscription engine; metered usage pricing is out of scope today.

## Next, in the owner's order

### Simulation or what-if
- [ ] `atm billing simulate --menu <file> --policy <file> --events <dir>`: replay the log against a candidate menu or policy, then diff the journals and per-holder balances against the current ones. No writes.
- [ ] State the limit in the output: a replay re-decides credits only. It cannot change what Stripe already charged.
- Why it is cheap here: the engine is pure, the ledger is deterministic, and `replayEvents` already reproduces balances (the fixture year is a golden test). Orb runs up to five pricing scenarios against historical events and subscriptions.

### Bitemporal, small
- [ ] A `correction` event type that names the event it supersedes (`supersedes: <id>`); never delete.
- [ ] The late-event grace window as one config value (default 1 hour, matching the daily combine).
- [ ] Document the effect of a backfill on issued documents: a new version, never an overwrite.

### Ledger export (slice 10)
- [ ] Parquet on R2 from DuckDB: `COPY (... ORDER BY ...)` with `SET threads = 1`, compared by a hash of the rows, not the file bytes. Do it once the log path below is in place.

### Decouple, the cheap parts
- [ ] A metadata prefix in the policy instead of the hardcoded `b4u_`.
- [ ] Menu limits (4 tiers, 6 add-ons, 12 features) moved into the policy.
- [ ] A generic `holderId` in atm's own types instead of `family_id`.
- [ ] `env` is fixed to `"live"` in `handle.ts` and `grants.ts`. The owner's note says it is hardcoded in the B4 Uni family service, not in atm: check which and fix where it is.
- Separate task, not here: tree-shaking the ~1,200 `@autumn/shared` files the engine pulls in.

### Outbound webhooks and alerts
- [ ] `credit.depleted` and `credit.low` (threshold in the policy) as ledger events. atm emits events only; delivery stays with the caller.
- [ ] Not decided: a reference deliverer beside the webhook handler that signs and sends webhooks from the outbox, with retries and a dedupe key per event. Orb has `customer.credit_balance_depleted` and `subscription.usage_exceeded` alerts and signs its webhooks (names from third-party docs, not Orb's own reference).

## The log path to R2 (rest of phase 1)

- [ ] The shipper: outbox rows into batches (plan, then put with `If-None-Match: *`), `day.jsonl` combine, `late-*` batches.
- [ ] The signed monthly manifest (Ed25519) with history, replaced with `If-Match`.
- [ ] Run the contract suite against staging R2: the 429 behaviour, 20 racing `If-Match` puts, scoped session credentials. Never run so far.
- [ ] Run the contract suite under Node. Only Bun has run.
- [ ] Replace the third-party PyPI SeaweedFS wheel with the official release, pinned by version and checksum, before CI depends on it.
- [ ] Handle `invoice_payment.paid` in the webhook handler. API `2025-10-29.clover` puts no payment intent on the invoice, so refunds and disputes find their invoice through a caller hook until then.
- [ ] Check whether R2 honours `If-Match` on DELETE (undocumented; production code does not depend on it).
- [ ] A Worker version of the handler. Blocked: Workers refuse `new Function`, which `ajv` uses.
- [ ] Reported, not verified by me: `replayEvents` refuses a multi-feature create (for example sparkle-4) because `eventsOf` records a per-feature slice of the mutation.

## Possible directions, not planned

### Usage invoicing
- Metered usage pricing is out of scope today; atm is a credits and flat-subscription engine. This is listed so the decision stays visible.
- What it would be: events become a quantity per metric, the quantity is priced (unit, tiered, volume, package), and the result is an invoice. Late events need a grace window before the invoice is final; the vendors differ (Orb 12 hours, Stripe 1 hour up to 72, Metronome a 34-day backdating window).
- Open decision: pass usage to Stripe meters (Stripe rates and invoices; atm keeps credits as the drawdown), or rate it in atm. The first keeps Stripe the system of record for money; the second makes atm compete with Stripe Billing.
- Builds on the event log and replay, and on `policy.deductionOrder`.

### Credit ledger depth (from the Orb, Metronome and OpenMeter comparison)
- Not built: drawdown by priority and by cost basis (zero cost basis first), and a `pending_payment`-style hold on credits whose invoice is unpaid. atm draws by expiry then oldest grant, and `incomplete` is a membership status only.

## Ruled out
- Per-subject compare-and-swap on R2 (owner decision).
- Rebuilding Stripe Billing's subscription lifecycle (checkout, proration, renewals, retries, trials) or Autumn's server: Stripe Billing owns that, atm owns credits (ledger storage spec).

## Deferred by trigger (ledger storage spec)
- DuckLake, a copy in a school's own bucket, and a Durable Object per school: each waits for its trigger in the spec.

## Release 0.3.0
- [x] Upgrade note from 0.1.0: `UPGRADING.md`.
- [x] `atm --version` reads `package.json` (it was hardcoded `0.0.1`).
- [ ] Tier quantities (`quantities` on a tier, per-unit price and grants, same-tier upgrades): capture real quantity-change invoices from the sandbox first, then build.
- [ ] Bump `package.json` to 0.3.0 once quantities have landed; `just release-dry`, then `just release` from a clean, pushed `HEAD`. `release.ts` has no draft mode.
- [ ] An atm test workflow in `.github/workflows` (none runs atm's tests today; only knip and build do).
- [ ] The contract suite under Node (only Bun has run).
