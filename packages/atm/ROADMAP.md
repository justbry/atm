# atm roadmap

Status as of 2026-11-05. `- [x]` is built and tested; `- [ ]` is not. What is built is described in `README.md`; what a caller of 0.1.0 has to change is in `UPGRADING.md`. Competitor behaviour comes from the vendors' public docs as read on 2026-11-04, not from running their products.

**Where the work is.** Everything through tier quantities is merged into `dev` (PRs #9 to #16, merge commits, bottom-up, on 2026-11-05; tier quantities in #17). 0.3.0 is released (tag `atm-v0.3.0`; the bump was #18). After the release, four more PRs merged the same day (#21 to #24: the yearly and plan-switch raise fix, `portalConfigOf`, the raise rule as `prorationPair` and `raiseUnits`, and the caller-adoption helper). CI did not start on them (all checks sat queued with no runner), so they were merged on local gates (tests, `tsc`, Biome, build, knip, each run on the head and again on `dev`). None of that is in a tag yet. What is left is the release of those changes, the verification items below and the `buzz-school` side.

## Priority: the B4 Uni update and Vibes of Light membership

The critical path. Simulation, corrections, the Parquet export, decoupling and the R2 log path are lower priority and sit below.

### In atm
- [x] The billing layer, the reference webhook handler, the real-payload fixes, refund and dispute linkage, `credit.low` and `credit.depleted`, and the deduction order (details under Done).
- [x] Review each slice, push the branches, open the PRs, and merge bottom-up with merge commits (PRs #9 to #16). All eight slices were reviewed (see Review below); the findings are fixed in each slice.
- [x] **Tier quantities.** Vibes of Light sells three tiers at 1, 2 or 4 sessions a month; as separate tiers that is 9, past `MAX_TIERS = 4`. A tier gets `quantities` with its price and grants per unit (details in `UPGRADING.md`). Built from real quantity payloads captured in the sandbox (`fixtures/billing/stripe/recorded/`). Left out of 0.3.0: a quantity member in the replay fixture year (`fixtures/vibes-year`); the grants tests cover raise, decrease, renewal, yearly refund and the two-item subscription.
  - [x] Verified with real data (2026-11-05, sandbox, real webhook deliveries; the events are in `fixtures/billing/stripe/recorded/delivered/`, replayed by `tests/stripe-recorded-delivered.test.ts`): a tier change and a quantity change in one update (sparkle x2 to shine x4 on day 10) grants 2, the one-visit-per-unit difference prorated up, and moves the membership to shine; a raise 2 to 4 on a yearly plan 90 days in grants 19 (2 extra units x 12 x 275/365, rounded up) on top of the 24 of the create; a decrease 4 to 2 through a subscription schedule (`phases[].duration`; `iterations` is gone) leaves the credits alone until the renewal, which resets to 2; a raise and a decrease made in the hosted billing portal behave the same (a raise charged at once, a decrease only a schedule).
  - [x] A raise after a plan switch between monthly and yearly used the old plan's cycle dates (`if (interval !== state.interval)` ran after `moveTier` had already set the new interval): a raise 1 to 2 forty days after a monthly to yearly switch granted 0, and a yearly to monthly one prorated over the old year. Fixed (#21). A plain yearly raise already granted correctly.
  - [ ] Owner decision (`policy.upgradeGrant`): the invoice of the switch itself still prorates over the OLD cycle (a monthly sparkle-4 x2 moved to yearly x4 grants 128 = 192 x 20/30, though the new yearly period starts at the change). Whether a switch should grant the whole 192 is not decided.
  - [ ] Known limits of the raise baseline (`GrantsState.quantity`): two raise invoices delivered out of order (3 to 4 first, then 2 to 3) grant 3 in total where the dev code before #23 gave 2 + 2, because the late one sees the credits already at 4; atm has no ordering guarantee for invoices, and closing it needs per-invoice history. A refund of a raise does not roll `state.quantity` back (same as before). `raiseUnits` does not validate its inputs (NaN, a cycle in seconds against `at` in milliseconds, a null `oldQuantity` from plain JavaScript): add checks before the next release since it is public API.
  - [ ] Open findings of the 2026-11-05 review of #22 to #24 (`code-review high`; its fixes are in the PR that adds this line):
    - #22 (`portalConfigOf`): the portal lists only the tier products, so a member who also holds a recurring add-on may not be offered the update (Stripe's rule is unverified; try it in the sandbox). The quantity is a range, so a tier sold in [1, 2, 4] lets a member pick 3, and nothing flags a quantity outside `quantities`. A member on an older price (after a price change) is not in `products[].prices`.
    - #23 (raise rule): a tier change at a lower count while a decrease is pending computes the old amount from `state.quantity` (what the credits hold) and can grant 0 or too little; untested. `prorationPair` picks the credit line with no tier or interval check and falls back to the first credit when the charge has no `periodStart`, so a caller that reads `oldQuantity` can get a stale pair's.
    - #24 (adoption; owner decisions): an older lot with no expiry, or one still in the future, becomes a rollover row even when the grant has no rollover; a lapsed newest lot keeps its `adjustment` and `additional_balance`; an add-on invoice with some lots removed and some not is read as not removed; an add-on lot with `every: "once"` is accepted onto a refilling row; `cycleStart` is cycleEnd minus one UTC interval, which differs from Stripe's period start at a month end. An endpoint left on an older API version now has its b4u invoices refused with 422 and retried by Stripe; the dashboard is the only signal.
  - [x] A raise after a pending decrease compared against Stripe's old count and over-granted; it now compares against `GrantsState.quantity`, what the credits reflect (`membership.quantity` stays Stripe's).
  - [x] The raise rule is exported as pure functions, `prorationPair` and `raiseUnits`, and `invoiceToCommands` calls them, so the family service (which uses only `runEngineCommand`) reuses it instead of copying it (justbry/buzz-school#1285's stopgap, #1307's `raiseLots`). Still to do in `buzz-school`: replace that copy once this is released.
  - [x] `portalConfigOf(menu, { products, prices })`: the billing portal configuration for a tier sold in quantities (a raise billed at once, a decrease at the renewal, quantity-only updates, cancel at the period end), matching the family service's own `portalFieldsOf` (justbry/buzz-school#1307) field for field, except that a tier with a product but none of its prices published is left out (Stripe requires `prices` on each product), where `portalFieldsOf` would send it with none. Created in a real Stripe account (2026-11-05, API `2025-10-29.clover`): every field was accepted, and Stripe validates `products` (a missing product, a price of another product, an `adjustable_quantity` maximum below the minimum are refused); it also refuses subscription updates with `payment_method_update` off, which `portalConfigOf` has on. The API never returns `features.subscription_update.products` (nor `adjustable_quantity`) on a read, at `2025-10-29.clover`, `2025-03-31.basil` or `2024-06-20`, so the stored limits cannot be read back; the hosted portal does enforce them (driven in a browser: a quantity-only stepper with no tier switch, stopping at 1 and at 4, 3 reachable; a raise 2 to 4 charged at once, a decrease "updated at the end of your current billing period" with a schedule). Still to do in `buzz-school`: replace `portalFieldsOf` with it.
  - [ ] `portalConfigOf` puts `metadata[b4u_key]` after the products, `portalFieldsOf` before them: if the family service's `fieldsHash` depends on key order, switching creates a new configuration once (harmless), but check it. A tier with a product but no published price is left out (Stripe requires `prices`), where the reference sent a request Stripe refuses. The field names were checked against a real account at `2025-10-29.clover` (see above).
- [x] **Release 0.3.0**: tag `atm-v0.3.0` at `98f2488034e145260c3f9e8a2948160461665ef5` (2026-11-05), the tag-push workflow `Release atm` passed. Tarball `https://github.com/justbry/atm/releases/download/atm-v0.3.0/atm-0.3.0.tgz`, sha512 `sha512-nEBqWX7STue4O9U2bCrRr308yWgUkX8t+Cc2MPI4vgSTyv89lcdgOEMT1ASxCBx/Mksl8rbiS7e2dNTT1NIjOg==`. Built with bun 1.4.2 (the release script refuses another version). Still to do in `buzz-school`: pin it in `bun.lock`.
- [ ] **Next release** (0.4.0 or 0.3.1): the changes of #21 to #24 are on `dev` but not in `atm-v0.3.0`, so the family service cannot pin `portalConfigOf`, the raise rule, the plan-switch fix or the adoption helper. Bump `package.json`, `just release-dry` under the pinned bun (the repo now pins 1.4.4 via #20), then `just release`. Do it after the `raiseUnits` input checks above, or say why not.
- [x] Webhook delivery at the pinned version verified (2026-11-05): a sandbox endpoint with `api_version: "2025-10-29.clover"`, subscribed to the eight events in `UPGRADING.md`, reached the reference handler through a cloudflared quick tunnel; every event carried `api_version: 2025-10-29.clover` and a valid signature. Refunds and disputes too: a full refund and a lost dispute took the credits back, a partial refund and a won dispute changed nothing. The ordering race is real and frequent: in the refund and dispute run `invoice_payment.paid` beat its `invoice.paid` for all four families and each refund or dispute then answered 409 `unmatched_payment`; Stripe's sandbox retry had not fired two minutes later, so the events were resent by hand in order, after which they applied (a live endpoint retries with backoff for up to three days; check how soon, since a refund waits on it). The events are recorded in `fixtures/billing/stripe/recorded/delivered/`.
- [x] An atm test workflow, `.github/workflows/atm-tests.yml`: tests (`--timeout 60000`), `tsc`, Biome and the build of `packages/atm` on a pull request that touches atm, the engine or `shared`, and on a push to `dev`; a draft runs nothing until it is ready. It runs where B4 Uni's CI does: the repository variable `CI_RUNNER` (a JSON label list such as `["self-hosted","b4u-sprite"]`) sends it to a Sprite box, unset it uses `ubuntu-latest`. Cause of the queued checks on 2026-11-05: `knip.yml` and the other inherited Autumn workflows ask for `peak-ubuntu-24.04-*` or `blacksmith-*` runners that this repository does not have, so every check of every PR sat queued. Still to do: [ ] register a Sprite box to THIS repository (runners are per repository under a user account; buzz-school's `deploy/sprite/ci-runner/add-box.sh`) and set `CI_RUNNER`; [ ] point `knip.yml` at the same runner switch, and disable or repoint the inherited workflows that cannot run here.
- [ ] The contract suite under Node (only Bun has run) and against staging R2 (never run).

- [x] **Adoption by a caller with its own grants** (the family service's move onto `handleStripeEvent`, without regranting): `grantsStateFromCallerRows` builds a member's atm rows from `school_memberships` and `school_credit_lots`; a renewal after it is tested against the caller's rule (`tests/billing-adopt.test.ts`). Details and the list of what the rows do not carry in `UPGRADING.md`. Not released yet: it needs a version bump.
  - [x] An event from another Stripe API version is refused with the endpoint's version and the fix (recreate it at `2025-10-29.clover`) rather than read in a second, unchecked shape.
  - [ ] Owner decisions, from `UPGRADING.md`: the rollover cap (the caller has none), rollover months on the school's calendar against the UTC calendar (an hour at a clock change), what a lapsed cycle that is not renewed does, whether a yearly grant on a monthly plan (the retreat) should be restored (the caller's lot expires with the first month), and `invoiceIds` for payments made before the import.
  - [ ] Try the import on a copy of the family service's database before any member is moved.
  - [x] Found in review (#24): the reference webhook handler answered 200 `ignored` to an older-API `invoice.paid` (its family metadata sits on `invoice.subscription_details`); it now answers 422 naming the endpoint's version and the fix. A missing `api_version` no longer reads as an empty version.
  - [ ] Differences the import cannot hide, from the #24 review (the first group is in `UPGRADING.md`): a session gift bought after the import expires after `policy.giftSessionMonths` (6), where the caller's lot has no expiry without rollover; a refund of a pre-import invoice needs rows in BOTH `atm_payment_index` and `atm_invoice_index`; the caller grants with `school_billing.time_zone` while the import uses `menu.timeZone` (they can differ after a zone change; the result is a refusal, not a silent error); a downgrade not yet paid reads as a higher quantity from the newest lot's allowance; if a tier ever lists two grants of one feature and interval, atm sums them where the caller's lot id keeps only the first (check that menu validation forbids it).

- [x] **Invoice links and the one-time checkout** (spike on "invoices in the app, receipts", not built in `buzz-school`; the Idaho tutoring brief needs an itemised, dated, per-student receipt). Details in `README.md` ("Invoices and receipts") and `UPGRADING.md`. Merged into `dev` (#27); not released yet.
  - [x] A subscription-mode Checkout on a connected account already makes an invoice with a hosted page and a PDF; for a direct charge the connected account is the issuer, so `checkoutParams` gains no `issuer` or `on_behalf_of` (read from Stripe's Connect invoicing and receipts docs; not run against a real connected account).
  - [x] `oneTimeCheckoutParams`: a payment-mode Checkout for one-time add-ons with `invoice_creation` on and our metadata on the invoice. Without it a gift or pack sold on its own makes no invoice and atm cannot credit it. `buzz-school` has no payment-mode school checkout yet (its one `mode=payment` is the platform's own Go Learn plan), so this is ahead of its caller. Not run against Stripe: field names are from the API docs, not checked against a response; post-payment invoices for Checkout are priced apart from Invoicing.
  - [x] `BillingInvoice.number`, `hostedInvoiceUrl`, `invoicePdf` from the `invoice.paid` mapping.
  - [ ] Verify against a real connected account: that a subscription Checkout invoice prints the school's name, address and `us_ein` tax ID, and that `invoice_creation` on a payment-mode session on a connected account gives an `invoice.paid` with our metadata on the invoice (the recorded fixtures come from a plain sandbox account).
  - [ ] **Owner decision: the itemised receipt (`receiptOf`) is not built.** A pure function from a paid invoice's facts plus the school's details (name, EIN, address) and the student's legal name to rows and totals, with no PDF or HTML, is easy to write once these are settled; none can be read from what atm knows:
    1. What the receipt is for. A per-INVOICE receipt (what was bought: a month's membership, a pack) is what atm's facts hold. The brief's "subject, dates, hours" reads like what was DELIVERED, per session on a date, which is the family service's bookings (atm only sees `track` spends). Options: per invoice; per session from bookings (atm takes a list of sessions the caller supplies); or both, the invoice receipt for payment and a statement of sessions for the credit.
    2. Subject and hours. A menu tier or add-on has an id, a name and a count of sessions; no subject and no session length. Options: caller-supplied per line (a `details` map by line or by tier id), or new optional fields on the menu (`subject`, `minutesPerSession`) that `validateMenu` checks.
    3. Tax. The normalized invoice has none (`total_taxes` and each line's `taxes` are arrays). Options: add `taxAmount` (for a tax-exclusive invoice, `total` minus `total_excluding_tax`, both plain integers a mapping can read; tax-inclusive invoices differ) and a per-line amount, or say a school's tuition is untaxed and print none. Needs the Tax Commission's answer (the brief says to confirm with it before any claim).
    4. The student. One family invoice may cover several children (add-ons carry `profile_id` in the metadata, a family membership has one). Options: one receipt per `profile_id` (atm splits by the metadata), or the caller splits and calls once per student.
    5. Amounts. A line's `amount` is Stripe's line `amount` (whether it is before or after discounts and tax was not checked); a member-code discount and a proration credit (a negative line) change what a line shows. Options: print Stripe's lines as they are, or net the proration pairs (`prorationPair`) into one line. `amountPaid` is the invoice's total.
    6. How and when paid. `paidAt` is known; the method (card, last four) is not on the invoice mapping (it sits on the charge). Options: print "paid by card" from the charge, or `paidAt` only.
    7. A refunded invoice: a receipt after a full refund should say so, or not be issued; atm knows the refund (`BillingRefund`) but the receipt would need it as input.
    8. Who owns the document: Stripe's hosted invoice and PDF already carry number, date, lines, the school's name and EIN, and (for a customer set up with the child's name, or `invoice_data.custom_fields`) a name field. If that clears the Tax Commission, atm needs nothing more than the links above.

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
- **Replay of the log works** (#29, merged into `dev`). It had failed even on a plain create, renew, cancel of a one-feature tier. Three causes, three fixes: event ids are time-based, so a `reset` at the period start sorted before the `applyBillingPlan` at payment time (replay now runs each subject's commands in revision order, `replayOrder`); commands that moved no credits were not logged (each is now a `plan.changed` with its command and mutation, and every handler event carries `payload.complete`); and each per-feature event recorded only its own slice of the mutation (every event now records the whole mutation, with `payload.slice` naming the changes it is made from). The replay golden gained the `plan.changed` events; the envelope is unchanged; the `credit.*` payload schemas gain optional `slice` and `complete`. Owner decisions: `payload.mutation.changes` holds all changes and a reader uses `payload.slice`; `plan.changed` for every command that moves no credits (no `plan.attached`); replay tolerates a revision gap in a log whose writer marked `complete` (logging grants-only writes would close it). **Logs written by 0.3.0** are read, not rewritten: mutations are reassembled by `mutation.id` and checked as a subset of what the engine decides; a log with a revision gap stops with `ReplayGapError` (the lost cycle-end update cannot be told from a grants-only write); a log without one replays and reports `lossySubjects`. What remains: a 0.3.0 log cannot be rebuilt past its first gap. Closing that needs the stored rows at that revision (the handler's `atm_rows`) or a one-off migration that appends the missing commands, neither built. Review of #29 found and fixed three more defects before the merge (a state-order mismatch after the thirteenth monthly payment of a tier with a yearly feature, a 0.3.0 mutation booked per feature, a bad `payload.slice`), and the replay cache is keyed by subject and `commandId`. Left as they are: `complete` is trusted, not checked (a forged marker or a deleted middle event of a complete log is not reported); the replay-order chain is quadratic (about 0.85 s for 40,000 events); `buildJournal`'s `inputsHash` changes each month because of the `plan.changed` events.

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
- [x] A subscription-mode Checkout that carries a one-time gift line, verified in a real hosted Checkout (2026-11-05, test card): one `invoice.paid` has both lines (the gift line is `quantity 1`, `proration: false`, with a period equal to the first cycle's) and the handler grants the tier's credits and a separate gift lot of 1 visit that expires after `giftSessionMonths`; the gift line is not on the subscription's items. Webhook delivery and the schedule downgrade are verified above.

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
- [x] Fix replay of the log (see the Review section): every command is recorded once with its full mutation and replayed in subject-revision order; 0.3.0 logs replay up to their first lost command. `simulate`, parity and any rebuild-from-log depend on it; `tests/replay-log.test.ts` (a sparkle-4 create, create, renew, cancel on sparkle-2), 60 random histories, the fixture year and `tests/replay-old-log.test.ts` (logs made with the 0.3.0 writer, `fixtures/log-0.3.0/`) check it.

### Ledger export
- [ ] Parquet on R2 from DuckDB (`COPY (... ORDER BY ...)`, `SET threads = 1`), compared by a hash of the rows. After the log path.

### Decouple, the cheap parts
- [ ] A metadata prefix in the policy instead of the hardcoded `b4u_`; menu limits (4 tiers, 6 add-ons, 12 features) in the policy; a generic `holderId` instead of `family_id`.
- [ ] `env` is fixed to `"live"` in `handle.ts` and `grants.ts`. The owner's note says it is hardcoded in the B4 Uni family service: check which and fix where it is.
- Separate task: tree-shaking the ~1,200 `@autumn/shared` files the engine pulls in.

### Kept from the quantities and adoption work
- [ ] Split `src/billing/grants.ts` (about 1,600 lines) by concern; the raise rule already moved to `raise.ts` and the caller-row import to `adopt.ts`.
- [ ] Menu-level policy overrides (a policy per menu or tier instead of one per school); today `resolvePolicy` merges one school's overrides over the defaults.
- [ ] Record the remaining sandbox cases: a tier change plus a quantity change in one update, a yearly raise, and a decrease through a subscription schedule (see the verification item above).

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
- Tax, invoice PDFs, the customer portal itself (atm only builds the configuration for tiers sold in quantities: `portalConfigOf`), admin UI, REST API, multi-tenant auth: left to Stripe and the caller.
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
