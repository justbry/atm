# atm roadmap

Status as of 2026-11-05. `- [x]` is built and tested; `- [ ]` is not. What is built is described in `README.md`; what a caller of 0.1.0 has to change is in `UPGRADING.md`. Competitor behaviour comes from the vendors' public docs as read on 2026-11-04, not from running their products.

**Where the work is.** Everything through tier quantities is merged into `dev` (PRs #9 to #16, merge commits, bottom-up, on 2026-11-05; tier quantities in #17). 0.3.0 is released (tag `atm-v0.3.0`; the bump was #18). What is left is the verification items below and the `buzz-school` side.

## Priority: the B4 Uni update and Vibes of Light membership

The critical path. Simulation, corrections, the Parquet export, decoupling and the R2 log path are lower priority and sit below.

### In atm
- [x] The billing layer, the reference webhook handler, the real-payload fixes, refund and dispute linkage, `credit.low` and `credit.depleted`, and the deduction order (details under Done).
- [x] Review each slice, push the branches, open the PRs, and merge bottom-up with merge commits (PRs #9 to #16). All eight slices were reviewed (see Review below); the findings are fixed in each slice.
- [x] **Tier quantities.** Vibes of Light sells three tiers at 1, 2 or 4 sessions a month; as separate tiers that is 9, past `MAX_TIERS = 4`. A tier gets `quantities` with its price and grants per unit (details in `UPGRADING.md`). Built from real quantity payloads captured in the sandbox (`fixtures/billing/stripe/recorded/`). Left out of 0.3.0: a quantity member in the replay fixture year (`fixtures/vibes-year`); the grants tests cover raise, decrease, renewal, yearly refund and the two-item subscription.
  - [ ] Verify with real data: a tier change and a quantity change in one update; a raise on a yearly plan (grants 0 today); a decrease through a subscription schedule.
  - [ ] Align with the family service's stopgap, justbry/buzz-school#1285.
- [x] **Release 0.3.0**: tag `atm-v0.3.0` at `98f2488034e145260c3f9e8a2948160461665ef5` (2026-11-05), the tag-push workflow `Release atm` passed. Tarball `https://github.com/justbry/atm/releases/download/atm-v0.3.0/atm-0.3.0.tgz`, sha512 `sha512-nEBqWX7STue4O9U2bCrRr308yWgUkX8t+Cc2MPI4vgSTyv89lcdgOEMT1ASxCBx/Mksl8rbiS7e2dNTT1NIjOg==`. Built with bun 1.4.2 (the release script refuses another version). Still to do in `buzz-school`: pin it in `bun.lock`.
- [ ] Verify webhook delivery at the pinned version: create a sandbox webhook endpoint with `api_version: "2025-10-29.clover"` that reaches a URL we control (the CLI's `listen` offers only the account default or the newest version), subscribed to the eight events in `UPGRADING.md`.
- [ ] An atm test workflow in `.github/workflows`. Today no workflow runs atm's tests on a PR: `knip.yml` runs on PRs to main, staging and dev; `build.yml` runs on pushes to main, staging and dev (it type-checks, and builds the server image only on main or a manual dispatch); `release-atm.yml` runs on an `atm-v*` tag push and calls `release --ci`, which builds the package and runs `tests/dist.test.ts` against the built output.
- [ ] The contract suite under Node (only Bun has run) and against staging R2 (never run).

### In `buzz-school` (not atm; listed because atm's release waits on it)
- [ ] Move the family service off its own grant rules (`school-billing/grant.ts`, which grants only on create and cycle invoices) onto atm's `handleStripeEvent` or the reference handler, pinned to `atm-v0.3.0`.
- [ ] Credit-spending bookings (`price_mode`, hold then book then cancel refund, no-show forfeit) with `commandOrg(policy)` on every `track`, `check` and `finalize`.
- [ ] The light-bed resource and the back-to-back add-on.
- [ ] Create each school's webhook endpoint with `api_version` `2025-10-29.clover`, subscribe it to `invoice_payment.paid` and the rest, and send the same `Stripe-Version` on every call.
- [ ] Deliver "N visits left" and "pack used up" notices from `credit.low` and `credit.depleted`.

## Review

All eight slices were reviewed by sub-agents and the findings fixed slice by slice (see the PRs for each fix). Decisions that came out of it:

- **Handler `schoolId` binding.** The webhook handler's deps carry a required `schoolId`, the school an endpoint and its secret belong to. An event naming another school is refused (422 `school_mismatch`); an event with no `b4u_school` at all is answered 200 `ignored`; half-filled metadata stays 422 `missing_metadata`; an unmapped event type answers 200 `ignored`; a payment linked to more than one invoice answers 422 `ambiguous_payment`.
- **Alerts only for `track` and `finalize` draws.** `credit.low` and `credit.depleted` follow customer activity (holds and spends), not refund or dispute clawbacks or admin edits. They are judged on availability including holds. atm does not remember it already alerted, so the family service dedupes per holder, feature and grant or cycle.
- **`FolderStore` reserved names are case-insensitive**, and both object stores validate keys and ranges more strictly.
- **Equal-second membership ordering.** Membership events that carry the same second now have a defined order (see the PR for the rule).
- **`deterministicUlid` is exported** so a caller can derive `eventId` as the handler does.
- **Replay of the log works for what `handleStripeEvent` writes.** It had failed even on a plain create, renew, cancel of a one-feature tier. Three causes, three fixes: event ids are time-based, so a `reset` at the period start sorted before the `applyBillingPlan` at payment time (replay now runs each subject's commands in revision order, `replayOrder`); commands that moved no credits were not logged (each is now a `plan.changed` with its command and mutation, and a stored revision that moved without an engine command is read from the next mutation's `revision.before`); and each per-feature event recorded only its own slice of the mutation (every event now records the whole mutation, with `payload.slice` naming the changes it is made from). The replay golden moved (the added `plan.changed` events). Logs the earlier code wrote (0.3.0) still do not replay.

## Done

### Foundation
- [x] Test suite, `tsc`, Biome and the build are green (the early failures were already fixed on `claude/atm-cli`).

### Stripe coverage
- [x] `customer.subscription.created/updated/deleted` record a `membership` in the grants state (status, the tier and interval the menu names for the price items, renewal or end date, event time). Nothing is granted from them; credits still come only from paid invoices. An event about another subscription, a replay, and an older event change nothing.
- [x] By design (B4 Uni "Default billing rules"): a partial refund and an open dispute change nothing; only a full refund and a lost dispute take unused credits back.
- [x] Mapping shapes checked against real payloads from a Stripe sandbox at API `2025-10-29.clover` (objects fetched at that version; the event envelope was rebuilt around them, see `fixtures/billing/stripe/recorded/README.md`). Three bugs the OpenAPI check and the synthetic fixtures had hidden are fixed:
  - [x] `charge.refunded`: a real charge has no `refunds` list, so every refund was refused and no credits were ever taken back.
  - [x] Invoice metadata: with checkout's `subscription_data.metadata` the invoice's own metadata is empty; it is on `parent.subscription_details.metadata`. Every real subscription invoice was refused as `missing_metadata`.
  - [x] Renewal period: a `subscription_cycle` invoice's own period is the previous one; the lines carry the new one. A real renewal reset a month early and granted nothing.
- [x] `invoice_payment.paid` links a payment to its invoice, so a refund or lost dispute finds its subject; ordering races answer a retryable 409.
- [ ] Still unverified: webhook delivery at the pinned version (see above), the downgrade through a subscription schedule, and a subscription-mode Checkout that carries a one-time gift line.

### Deduction order and expiry
- [x] The engine's real draw order is documented in the README.
- [x] `balance-engine`: opt-in `org.config.deduction_order: "expiry"`; the default is unchanged. Listed in `UPSTREAM.md`.
- [x] `BillingPolicy.deductionOrder` (`expiry` default, or `engine`) and `commandOrg(policy)`.
- [x] `credit.expiration_changed`: a row's credits stay but their end date moved. The not-yet-paid membership status is named `incomplete`.

### Alerts
- [x] `credit.low` and `credit.depleted` ledger events by crossing, with `BillingPolicy.lowCreditThreshold` (default 2, 0 turns `credit.low` off). Delivery stays with the caller.
- [ ] Expiries by the clock (`lapseEvent`, the cron) do not make alerts yet.

### Object store and the webhook handler
- [x] `Store`, typed errors and the 412 rules; `FolderStore` and `R2Store` (on `aws4fetch`); a contract suite that passes on the folder store and SeaweedFS 4.48.
- [x] Reference webhook handler for Bun/Node: verify the signature, claim the event id (a stale claim is taken over), then rows, outbox events and the claim's done mark in one SQLite transaction.
- [x] No per-subject compare-and-swap on R2: live balances stay in the caller's SQLite.

### Bugs found on the way
- [x] `lapse:` and the expiry event's idem had no holder, so a second family's event collided with the first's.
- [x] `handleStripeEvent` accepted Stripe's `evt_` id as `eventId`, so its events failed envelope validation. It now refuses a non-ULID.
- [x] A cancel for an older subscription overwrote the live subscription's membership.

### Packaging and scope
- [x] The README states atm is a credits and flat-subscription engine; `UPGRADING.md` lists what a 0.1.0 caller must change; `atm --version` reads `package.json`.

## Lower priority, after 0.3.0

### Simulation or what-if
- [ ] `atm billing simulate --menu <file> --policy <file> --events <dir>`: replay the log against a candidate menu or policy and diff journals and per-holder balances against the current ones. No writes. A replay re-decides credits only; it cannot change what Stripe already charged. Orb runs up to five scenarios against historical events.

### Bitemporal, small
- [ ] A `correction` event that names the event it supersedes (`supersedes: <id>`); never delete.
- [ ] The late-event grace window as one config value (default 1 hour, matching the daily combine).
- [ ] Document the effect of a backfill on issued documents: a new version, never an overwrite.

### The log path to R2 (rest of phase 1)
- [ ] The shipper (outbox rows into batches, plan then put with `If-None-Match: *`), the `day.jsonl` combine and `late-*` batches.
- [ ] The signed monthly manifest (Ed25519) with history, replaced with `If-Match`.
- [ ] Replace the third-party PyPI SeaweedFS wheel with the official release, pinned by version and checksum, before CI depends on it.
- [ ] Check whether R2 honours `If-Match` on DELETE (undocumented; production code does not depend on it).
- [ ] A Worker version of the handler. Blocked: Workers refuse `new Function`, which `ajv` uses.
- [x] Fix replay of the log (see the Review section): every command is recorded once with its full mutation and replayed in subject-revision order. `simulate`, parity and any rebuild-from-log depend on it; `tests/replay-log.test.ts` (a sparkle-4 create, create, renew, cancel on sparkle-2), 60 random histories and the fixture year check it.

### Ledger export
- [ ] Parquet on R2 from DuckDB (`COPY (... ORDER BY ...)`, `SET threads = 1`), compared by a hash of the rows. After the log path.

### Decouple, the cheap parts
- [ ] A metadata prefix in the policy instead of the hardcoded `b4u_`; menu limits (4 tiers, 6 add-ons, 12 features) in the policy; a generic `holderId` instead of `family_id`.
- [ ] `env` is fixed to `"live"` in `handle.ts` and `grants.ts`. The owner's note says it is hardcoded in the B4 Uni family service: check which and fix where it is.
- Separate task: tree-shaking the ~1,200 `@autumn/shared` files the engine pulls in.

### Webhook delivery
- [ ] Not decided: a reference deliverer beside the webhook handler that signs and sends webhooks from the outbox, with retries and a dedupe key per event.

### Referral codes and reconciliation
- [ ] The ledger has `referral.qualified` and `referral.rewarded` events and postings, but no referral-code table or rules (single use, no self-referral). The B4 Uni purpose-built estimate counts gift and referral codes (220 to 380 lines).
- [ ] A reconciliation query: atm's balances and grants against Stripe's paid invoices, run nightly by the caller. Nothing in `src/` does this yet.

## Possible directions, not planned

### Usage invoicing
- Metered usage pricing is out of scope; atm is a credits and flat-subscription engine. Listed so the decision stays visible.
- What it would be: events become a quantity per metric, the quantity is priced (unit, tiered, volume, package), the result is an invoice. Late events need a grace window; the vendors differ (Orb 12 hours, Stripe 1 hour up to 72, Metronome a 34-day backdating window).
- Open decision: pass usage to Stripe meters, or rate it in atm. The first keeps Stripe the system of record for money; the second makes atm compete with Stripe Billing.

### Credit ledger depth (from the Orb, Metronome and OpenMeter comparison)
- Not built: drawdown by priority and by cost basis, and a `pending_payment`-style hold on credits whose invoice is unpaid. atm draws by expiry then oldest grant.

### Compared with open-source billing (Lago, OpenMeter, Flexprice, Kill Bill, Polar)
Written 2026-11-05 from memory of their public docs, not read or run; check a row before acting on it. What atm lacks that they have, and where it stands here:
- Metered usage rating and invoicing: ruled out above.
- Prepaid wallets and auto top-up (Lago, Flexprice): not built. The Autumn monorepo has an `auto-topup` package that atm does not use.
- Other payment providers (Lago, Kill Bill, Flexprice): atm is Stripe only. Not planned.
- Own subscription lifecycle (proration, trials, dunning, coupons): left to Stripe, see Ruled out.
- Tax, invoice PDFs, customer portal, admin UI, REST API, multi-tenant auth: left to Stripe and the caller.
- Revenue analytics (MRR and similar): only the ledger export; the Parquet export and any dashboard are not built.
- Expiry alerts by the clock: see Alerts above.
- Rebuild from the log: `replayEvents` now reproduces what `handleStripeEvent` wrote (see Review above); `simulate` and a rebuild of a subject's rows from a stored log are not built.
- Reuse outside B4 Uni: see "Decouple, the cheap parts" (prefix, `family_id`, `env`, menu limits), and the Worker handler blocked on `ajv`.
- SOC 2, a DPA and subprocessor list: none; the caller writes them.

## Ruled out
- Per-subject compare-and-swap on R2 (owner decision).
- Rebuilding Stripe Billing's subscription lifecycle (checkout, proration, renewals, retries, trials) or Autumn's server: Stripe Billing owns that, atm owns credits.

## Deferred by trigger (ledger storage spec)
- DuckLake, a copy in a school's own bucket, and a Durable Object per school.
