# Upgrading atm

## Moving to 0.4.0 from 0.3.0

Everything is additive: a 0.3.0 caller that changes nothing gets the same rows, keys and events. What is new, and what a caller has to do to use it:

- **The raise rule as functions.** `prorationPair` reads Stripe's pair of proration lines and `raiseUnits` turns a raise into the units to grant; `invoiceToCommands` calls both. Both now throw an `Error` naming the field on bad input (not a finite number, a negative or fractional count, `cycleEnd` before `cycleStart`, a cycle in seconds against `at` in milliseconds) instead of returning a wrong number. A yearly raise grants the prorated year (a raise 2 to 4 ninety days in grants 19), not 0. The baseline is `GrantsState.quantity`, what the credits reflect, not Stripe's count: pass that to `raiseUnits`.
- **`portalConfigOf(menu, { products, prices })`** makes the billing portal configuration for a tier sold in quantities (a raise billed at once, a decrease at the renewal). A member who also holds a recurring add-on is not offered the update by the portal, whatever the configuration lists (checked in the sandbox), so the caller needs its own route for them. See `README.md`, "Billing portal".
- **Importing a caller's own rows.** `grantsStateFromCallerRows` turns a caller's existing lots into atm's rows and `GrantsState` (see "Moving an existing caller onto `handleStripeEvent`" below); it throws, naming every problem, rather than guess.
- **`env`.** `handleStripeEvent`, `handleStripeWebhook` (as `WebhookDeps.env`) and `menuCatalogRows` take an optional `env` (`"live"` or `"test"`, default `"live"`; anything else throws). It is part of the subject key, `<school>|<env>|family:<id>`. A school with a Stripe test endpoint and a live one must pass it, or both land on the live subject. The family service has `billingKeyMode` and has to pass that. The handler's claim, invoice index, payment index and outbox keys carry no env: Stripe's ids differ between modes, so two endpoints sharing a database do not collide, but the same id under both would be claimed once (closing it changes the DDL; `ROADMAP.md`).
- **Expiry alerts.** `lapseAlertEvents` makes a `credit.depleted` (payload `cause: "expired"`) when a lapse takes a feature's credits from above 0 to 0, one per instant however many rows lapse then. Calling it is the opt-in; `lapseEvent` is unchanged. **The cron must pass it the same state it gave `lapsedRows`**, before it books anything later: the state does not record when a row was made, so a late run on a state that already holds a newer live row would count it and hide the depletion. There is no `credit.low` on a lapse.
- **Replay** reads logs written by 0.3.0 and stops at what they lost (see "Replaying a log" below). **Invoice links and the one-time checkout** are described under "Invoices and receipts" below. An endpoint left on an API version older than `2025-10-29.clover` has its b4u invoices refused with 422, which Stripe retries; the dashboard is the only signal.

## Moving to 0.3.0 from 0.1.0

0.1.0 was the engine as a CLI and a library: `runEngineCommand` and the engine's own types, nothing else. Everything billing-related is new to a 0.1.0 caller: the menu, Stripe mappings, grants, the webhook handler, the object store and the ledger events. `runEngineCommand` and the CLI work as before. `README.md` describes each piece; this lists what a caller has to provide and the behaviours that are easy to get wrong.

### Stripe

- **API version.** The mappings read Stripe API `2025-10-29.clover`; an event from any other version is refused (`unknown_mapping`), with a message that names the endpoint's version (`event.api_version`) and the fix, which is to recreate the endpoint with `api_version: "2025-10-29.clover"`. atm does not read a second layout (an older endpoint sends `line.price.id` and `line.proration`): the mappings are checked against the pinned version's OpenAPI spec, and a second shape would be unchecked. A school's webhook endpoint must be created with `api_version: "2025-10-29.clover"` (the endpoint's version, not the request header, decides the shape of the events it receives), and every API call should send the same `Stripe-Version`.
- **Events to subscribe to:** `invoice.paid`, `invoice_payment.paid`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`. Without `invoice_payment.paid` a refund or dispute cannot find its invoice and answers 409 until Stripe gives up.
- **Checkout metadata.** Put `b4u_school` and `family_id` in `subscription_data.metadata`. On the invoice they arrive at `parent.subscription_details.metadata`; atm reads both and the invoice's own keys win.
- Shapes were checked against real payloads from a Stripe sandbox (`fixtures/billing/stripe/recorded/`). The pin is still unverified against a school's own account.

### Handling an event

- **One entry point:** `handleStripeEvent(input)` turns a raw Stripe event and the subject's stored rows into row changes and ledger events. It reads no clock and writes nothing. The caller verifies the signature, dedupes on Stripe's event id, checks the revision and writes the result in one transaction.
- **`eventId` must be a ULID**, the id of the stored input event, not Stripe's `evt_` id. Anything else comes back `refused` as `bad_event`. Derive it from the Stripe id with `deterministicUlid` (exported from `atm`) so a replay gets the same id. The reference handler uses:

  ```ts
  const eventId = deterministicUlid({ timeMs: event.created * 1000, revision: 0, seed: JSON.stringify([schoolId, event.id]) });
  ```

  `timeMs` is the event's own instant (Stripe's `created` in milliseconds); `revision` is the subject's revision, or `0` as here (it fills 24 bits of the id so events in one millisecond sort in the order they were decided); `seed` is any string that is stable for the event and unique to it across schools (the handler seeds with its canonical JSON of `[schoolId, stripeEventId]`). The same three inputs always give the same id.
- **Reference handler.** For Bun or Node, `handleStripeWebhook(deps, request)` verifies the signature, claims the event id in its own short transaction (a stale claim is taken over), then writes rows, events, the indexes and the done mark in one SQLite transaction. Create its tables with `HANDLER_DDL`. A caller with its own handler must provide the same three things: the claim, the invoice-to-subject index and the payment-to-invoice index.
- **One school per endpoint.** `deps.schoolId` is required: the school this endpoint and its signing secret belong to. An event whose `b4u_school` names another school is refused (422 `school_mismatch`) before anything is claimed.
- **Answers.** What Stripe sees decides whether it retries, so the handler sorts every outcome into one of three kinds:

  | Answer | Outcome (`reason`) | Meaning |
  | --- | --- | --- |
  | 409, retryable | `refused` (`unmatched_invoice`), `refused` (`unknown_subscription`), `unmatched_payment`, `busy`, `stale_revision` | The link or the earlier event has not arrived yet, or another delivery holds the claim. Stripe retries; nothing needs fixing. `unmatched_payment` is its own outcome (a refund or dispute whose payment is not in the payment index yet), not a refusal reason. |
  | 422, needs a human | `refused` (`unmatched_line`, `missing_metadata`, `unknown_mapping`, `bad_event`, `rejected`), `unknown_school`, `school_mismatch`, `ambiguous_payment` | Retrying gives the same answer. `missing_metadata` is metadata that is half filled (for example `b4u_school` without `family_id`); `unknown_mapping` is an event from another API version; `unknown_school` is a school with no context; `ambiguous_payment` is a payment that links to more than one invoice. |
  | 200, done | `applied`, `duplicate`, `ignored` | `ignored` is an event type atm does not handle, and an event with no `b4u_school` at all (not one of ours, for example another product on the same Stripe account). |

  A 401 (`bad_signature`) and a 400 (`bad_request`) answer a delivery that never reaches the rules.

### Credits

- **Deduction order.** Put `commandOrg(policy)` on every `track`, `check` and `finalize`. `policy.deductionOrder` is `expiry` (default: the row that lapses soonest first, then the oldest grant) or `engine` (Autumn's own order). A caller that sends its own org config gets the engine's order.
- **Stored state.** A subject's billing state is one JSON row (`atm_grants`) beside the engine's rows, under the same revision. It holds each grant's `holder` and `retired` flag and the subject's `membership`.
- **Membership status** has the value `incomplete` (not yet paid), and `customer.subscription.*` events record the membership without granting anything: credits still come only from paid invoices.
- **Policy.** `deductionOrder` and `lowCreditThreshold` are policy fields; a school's policy that leaves them out gets the defaults.

### Events

Ledger event types include `credit.expiration_changed` (a row's credits stay but their end date moved), `credit.low` and `credit.depleted`. Delivery of "N visits left" notices stays with the caller.

- `credit.low` and `credit.depleted` fire only for draws by `track` or `finalize`, that is customer activity (holds and spends). A refund or dispute clawback and an admin edit do not raise them. The one other source is the clock: a cron that calls `lapseAlertEvents` gets a `credit.depleted` (`cause: "expired"`) when rows lapse and the feature's total goes to 0.
- They are judged on availability including holds, so a hold can take a family under the threshold before any visit is spent.
- atm does not remember that it already alerted. The family service should dedupe its notices per holder, feature and grant or cycle.
- They are opt-in per call. `handleStripeEvent` never makes them (it runs only billing commands). The family service passes `policy.lowCreditThreshold` as `lowCreditThreshold` in the context it gives `mutationToEvents` for its own `track` and `finalize` mutations. Without it no alert is made at all; a threshold of 0 makes `credit.depleted` only.

### What surprised us on real Stripe data

These are facts about the API at `2025-10-29.clover`, checked against sandbox payloads. They are why the mappings read what they read.

- A subscription's tier and interval come from its price items (`SubscriptionFact.items`: price id, lookup key, interval), not from checkout metadata, which goes stale after a plan change in the portal.
- A real charge carries no refund list. `BillingRefund.id` is the Stripe event id and `amount` is the charge's total refunded after the event.
- A renewal invoice's own period is the previous one. The renewal's period comes from the tier line.
- With checkout's `subscription_data.metadata` the invoice's own metadata is empty; it is on `parent.subscription_details.metadata`.
- A charge or dispute does not name its invoice; `invoice_payment.paid` is what links them.

### Tier quantities

A studio sells one tier at several counts (Vibes of Light: Shine at 1, 2 or 4 sessions a month) with `quantities` on the menu tier instead of one tier per count.

- **Menu.** `MenuTier.quantities`: 1 to 6 unique whole counts from 1 to 50, ascending; absent means `[1]`. Prices and grant amounts are per unit. A price times its largest count must stay under 99,999,999 (Stripe's line cap). Editing `quantities` makes no `menuToStripe` step.
- **Checkout.** `checkoutParams` takes `quantity` (default 1). A count the tier does not offer comes back `{ reason: "quantity_not_offered", quantity }`; answer 400 with `fields: ["quantity"]`. `line_items` is now a tuple: the tier line first (at the quantity), add-ons after at 1. The subscription metadata carries `quantity` only when it is not 1, and only for information: the item's quantity at Stripe is the truth.
- **Normalized events.** Subscription items and invoice lines carry `quantity` (an integer 0 to 99,999,999; a missing one reads as 1; a negative, fractional or larger one is refused `bad_value`). A line or item with quantity 0 is dropped by the grants rules, never counted as 1.
- **State.** `GrantsState.quantity` is what the credits reflect and moves only with paid invoices; `MembershipRecord.quantity` is what Stripe says and moves with `customer.subscription.*`. A stored state from 0.2.0 loads with both at 1.
- **Credits.** Create and renewal grant the per-unit allowance times the tier line's quantity (a yearly payment on a monthly grant: times 12). A raise on the same tier grants the extra units, prorated per `policy.upgradeGrant`, counted from the quantity the credits reflect (`GrantsState.quantity`), not from Stripe's old count: after a decrease that waits for the renewal, a raise back up to the count the credits still hold grants nothing, and one above it only the units past it. A decrease grants nothing and takes effect at the renewal. Rollover `max` scales with the quantity, and the engine has one cap per row, so after a decrease the carry-over cap follows the lower count.
- **The rule without the state.** A caller that keeps its own credits and has no `GrantsState` reuses the raise rule instead of copying it: `prorationPair(lines, isTierPrice)` reads Stripe's pair of proration lines and `raiseUnits({ perUnit, oldQuantity, newQuantity, at, cycleStart, cycleEnd, policy })` gives the units to grant (README, Billing, "Quantity raises without the grants state"). `invoiceToCommands` calls both. Pass the quantity your credits reflect as `oldQuantity`.
- **The family service must:** make a raise with `proration_behavior: "always_invoice"` (otherwise Stripe bills it at the renewal and nothing is granted until then); schedule a decrease for the renewal; and read `quantity` from the subscription item, not from metadata. `portalConfigOf(menu, { products, prices })` (added after 0.3.0, so not in that tarball) makes both settings for the billing portal: post its fields to `/v1/billing_portal/configurations` and pass the id it makes as `configuration` on each portal session (`README.md`, "Billing portal"). It returns `null` for a menu without quantities, where the school's default portal applies. A caller that changes quantities through its own API calls instead must set `always_invoice` and the scheduled decrease itself.
- A tier change and a quantity change in one update grant `newAmount x newQuantity - oldAmount x oldQuantity`, not below 0. This case is not checked against real payloads.
- **A raise on a yearly plan grants too** (it does not grant 0). A monthly grant on a yearly plan counts 12 per unit, so the extra units carry a year of it, prorated per `policy.upgradeGrant` by the share of the year left (2 -> 4 of a 2-a-month tier, ten days in: 2 x 12 x 2 = 48, x 355/365, rounded up: 47; `full` 48; `none` 0). A yearly grant on a monthly plan (a retreat a year) grants nothing at a raise: its next refill is already at the new count. Only synthetic fixtures pin this; no real yearly raise payload has been recorded.

### Invoices and receipts (after 0.3.0)

What a family service caller changes:

- **Link a receipt.** `BillingInvoice` has `number`, `hostedInvoiceUrl` and `invoicePdf` (`string | null`, absent on a fact built by hand). `handleStripeEvent`'s result does not carry them (the grants state keeps no invoice facts), so read them from `normalize` of the same `invoice.paid` event (or from the raw event), then store or show the number and the two links. The URLs are bearer links: give them only to the family the invoice belongs to and keep them out of logs.
- **Selling a gift certificate or a pack with no membership.** Do not build the Checkout by hand in `mode=payment` without `invoice_creation`: Stripe then makes no invoice and no `invoice.paid` arrives, so nothing is credited. Call `oneTimeCheckoutParams` (it returns payment-mode parameters with `invoice_creation[enabled]=true` and our metadata in `invoice_data.metadata`), then `withPriceIds` and `toStripeForm`, as you do for a membership. The webhook endpoint is the same (`invoice.paid`). A one-time add-on bought together with a membership needs nothing new: it rides the subscription's first invoice, as before.
- **`checkoutParams` is unchanged.** Same output for the same input; still subscription mode only. `withPriceIds` now also accepts `oneTimeCheckoutParams`'s result (typed by overload; a membership's call still returns `CheckoutParamsWithPrices | null`).
- **School setup, not code.** The invoice shows the school's name, address, branding and tax ID from the school's own Stripe account (the connected account is the issuer of a direct charge). The EIN prints only if the school has it as a tax ID on that account (`us_ein`) and as a default account tax ID. Idaho's itemised receipt also needs the child's legal name, subject, hours and tax, which the Stripe invoice does not hold; atm does not build that receipt yet (`ROADMAP.md`).

### Storage

- `Store` and its errors, `FolderStore` and `R2Store` (on `aws4fetch`) are exported, with a contract suite that runs against the folder and SeaweedFS. Live balances stay in the caller's SQLite; the object store holds the append-only log.
- Both stores validate keys and byte ranges strictly and refuse what they cannot serve; no caller should rely on a looser reading. `FolderStore` treats reserved names case-insensitively, as a case-insensitive filesystem does.
- `balance-engine` has one opt-in change (`org.config.deduction_order`), listed in `UPSTREAM.md`.

### Moving an existing caller onto `handleStripeEvent`

For a caller that already grants credits on its own and has paying members (B4 Uni's family service: `school_memberships`, `school_credit_lots`, rules in `src/school-billing/grant.ts`). It uses only `runEngineCommand` today; this is how to move it onto `handleStripeEvent` without regranting anything.

1. **Create each school's webhook endpoint with `api_version` `2025-10-29.clover`** (see Stripe above). An event from any other version is refused (`unknown_mapping`) with a message that names the endpoint's version and says to recreate it.
2. **Import each member once**, in one transaction, with the member's lots and the menu their invoices were granted against:

   ```ts
   const { state, rows } = grantsStateFromCallerRows({ membership, lots, menu, now });
   // write `rows` (engine rows and the atm_grants row) for the subject <school>|live|family:<family_id>, at one revision
   ```

   `membership` and `lots` are the `SELECT *` rows (`CallerMembershipRow`, `CallerCreditLotRow`): the membership's instants are Unix seconds, the lots' are milliseconds. `now` is the instant of the import: a lot past its `expires_at` holds nothing and is not carried over. The subject is `family:<family_id>` at the membership's school, the identity the caller already uses.
3. **Stop the caller's own grants and takebacks at the same moment** (the `grantForInvoice` and `removeForInvoice` calls), and hand `handleStripeEvent` only events the caller has not applied: an invoice the caller granted is found in `state.invoices` and grants nothing, but an event the caller handled that left no lot (an upgrade proration, a manual invoice) is not known to atm and would be decided afresh. Start from the caller's `school_stripe_events` cutoff.
4. **Pass `invoiceIds` for payments made before the import.** A refund or dispute names its charge and payment intent, not its invoice; atm learns the link from `invoice_payment.paid`, which it has not seen for the old invoices. Without it a refund of one of them is refused `unmatched_invoice` (409, retried until Stripe gives up). The caller has the link (the invoice's `payment_intent`). The reference handler finds the subject of a refund by joining two tables, so each old invoice needs a row in both: `atm_payment_index` (payment intent to invoice id) and `atm_invoice_index` (invoice id to the subject key, `<school>|live|family:<family_id>`). With only the first, the refund is answered 409 `unmatched_payment`.

What the import reads from the rows, and what it does not:

- **Read:** the holder (`school_id`, `family_id`), the subscription, the tier, interval and add-ons, the quantity the credits reflect (the newest tier lot's `allowance` over the menu's per-unit amount; the membership's own `quantity` goes to `membership.quantity`), the cycle (read back from the lots' `expires_at`, minus the rollover months on the school's calendar), each lot's balance, expiry and removal, and the decided invoices.
- **Refused, naming each problem** (one error lists them all): a tier, add-on or feature the menu does not have; a tier the menu does not price at the membership's interval; a lot that is no grant of the membership's tier, or is for an add-on the membership no longer has; a lot of another member or with a source that is not `tier` or `addon:<id>`; a tier grant or a recurring add-on with no lot (atm refills only rows it holds, so it would silently stop granting it); credit rows on different cycles (a renewal granted to some and not others); a lot that is not a whole number of the menu's per-unit amount. A membership with no lots yet imports as just the membership: the first invoice then grants as for a new member.
- **Not in the rows (the owner decides):**
  - `GrantsState.anchor` (the first invoice's period start) is `null`; no rule reads it.
  - `cycleStart` is the cycle end minus one interval, not the invoice's own start; only the proration of a mid-cycle upgrade reads it.
  - A yearly grant on a monthly plan (Shine's retreat) has no refill date in the rows: its next refill is set a year after its lot's creation. The caller's own rule gives such a lot `expires_at` = the end of the first month's period (it has no rollover), so by the second month the lot holds nothing and the import carries that balance of 0; atm then refills it a year after the first invoice. Decide whether the retreat should be restored for current members.
  - `GrantsState.tierId` is the membership row's tier. A plan change Stripe made that no invoice has paid yet cannot be told apart in the rows.

Where atm's rules differ from the caller's, so a renewal after the import is not always the same (each is pinned in `tests/billing-adopt.test.ts`):

- **Rollover cap.** The caller never caps a rollover (a lot keeps its balance until it expires); atm carries over at most the grant's `rollover.max` (times the quantity). A leftover above the cap is lost at the renewal. The imported rows themselves are not capped.
- **Rollover months on the school's calendar.** The caller adds rollover months on the school's time zone; the engine adds them on the UTC calendar. Across a clock change the rollover of a cycle lapses a whole hour from the caller's lot (Denver, a January cycle: 17:00Z against 18:00Z).
- **A cycle not renewed.** The caller's lot lapses at the cycle end plus the rollover months. atm's refilling row stays until the next invoice or the cancellation (`subscriptionEndedToCommands` sets its expiry).
- **Session gifts.** The caller's gift lot lasts until its own rollover months, or keeps if the grant has none; atm gives a gift of sessions an expiry `policy.giftSessionMonths` after payment (six months by default). Gifts imported keep the caller's expiry; a gift bought after the import gets atm's.
- **What an invoice grants.** The caller grants on `subscription_create`, `subscription_cycle` and `subscription_threshold` only. atm also grants a mid-cycle upgrade or a raise in quantity (a `subscription_update` invoice, per `policy.upgradeGrant`), which the caller does not.

### Replaying a log (after 0.3.0)

`replayEvents` now reproduces what `handleStripeEvent` writes. What a caller needs to know:

- **New events.** `handleStripeEvent` records every event of a command with the whole mutation (`payload.slice` lists the positions in `mutation.changes` an event is made from, when one mutation is booked as several events by feature and plan, so `payload.mutation.changes` is no longer the event's own part), a command that moves no credits as a `plan.changed` with no postings, and `payload.complete: true` on every one of them. The envelope and the event types are unchanged; the payload schemas gain optional `slice` and `complete`. A caller that ships `result.events` as they are changes nothing; one that reads `payload.mutation.changes` of a `credit.*` event as that event's own changes must read `payload.slice`.
- **Order.** A subject's commands replay in revision order, not id order (a reset runs at the start of the period it refills, so its id can sort before the plan at payment time). `lastEventId` and `snapshot.lastEventId` are places in that order: pass the same events each time.
- **Revision gaps.** The stored revision also moves on a write of the grants row alone (a dollar gift, a membership event). For a log whose writer marked `complete`, replay reads the next mutation's `revision.before` and steps over the gap. `complete` is a claim by the writer, not something replay can check: a log writer that sets it on a log that lost a command, or a middle event deleted from a `complete` log, replays with no `ReplayGapError` and no `lossySubjects`. Keep the log append-only and write `complete` only from `handleStripeEvent`.
- **Logs written by 0.3.0.** They have no `plan.changed`, no `slice` and no `complete`, and a mutation booked per feature holds only each event's own changes. Replay reads them: it reassembles a mutation from the events that name its `mutation.id`, runs the recorded command in the engine, and checks the changes the log holds against the engine's (all of them when the log has all, else that each is among the engine's). What it cannot do is invent a command the log does not hold. 0.3.0 did not log the cycle-end update after a renewal (an `applyBillingPlan` that puts a refilled row's next reset on Stripe's cycle end; it changes a row only after a month end, Jan 31 to Feb 28 to Mar 31, and is a no-op otherwise), and a write of the grants row alone leaves the same revision gap, so the two cannot be told apart. Therefore:
  - a log with no revision gap replays, and its result has `lossySubjects` naming each subject whose last handler command was written by 0.3.0: the command the writer ran after the last one logged, if any, is not in the replayed rows;
  - a log with a gap stops at the first event after it with `ReplayGapError` (exported from `atm`; a `ReplayError` with `eventId`, `gap: { subject, after, before }` and `prefix`, the replay of everything before the gap, snapshot and balances). The message says the log was written by 0.3.0 and cannot be rebuilt past that point. Rebuilding past it needs the rows as the handler stored them at that revision, which the log does not hold;
  - a log of 0.3.0 events followed by current ones replays through when no command was lost between them, and stops with the same error at the boundary when one was.
- Nothing rewrites stored events. Handler events of a subject that is carried on after the upgrade are the current shape from the first write on.

### Shipping the outbox to a folder (after 0.4.0)

Additive: nothing changes for a caller that does not call it. Until now the handler's events stayed in `ledger_outbox` and nothing wrote the files `atm journal` reads. New exports:

- `shipOutbox({ db, store, school, nowMs })` takes the school's rows with `shipped_at IS NULL` and puts one object per event date, `schools/<school>/events/date=YYYY-MM-DD/batch-<first id>-<16 hex of the text's sha256>.jsonl` (the bodies, one per line, in id order, as the handler stored them), with `putOnce`. An equal object already there counts as shipped; different bytes under the key is a `conflicts` entry and the rows stay unshipped (it never overwrites). It then sets `batch_key` and `shipped_at` on those rows in one transaction. It returns `{ batches, conflicts, shipped }`. It works on any `Store`; only `FolderStore` is tested. `planOutbox({ school, rows })` is the pure plan it runs, with the types `OutboxRow`, `OutboxBatch`, `ShipOutboxInput` and `ShipOutboxResult`.
- **What a family-service caller changes.** After the handler has answered (or on a timer, or from a cron), call `shipOutbox` with the same `SqlDatabase` the handler uses and a store for the log. Any number of runs, and more than one shipper, are safe: a rerun finds nothing, a crash between the put and the mark is repaired by the next run (same rows, same key, same bytes), and two shippers on the same rows write one file. Alert on a non-empty `conflicts`. Then `atm journal` (or `journalMonth`) over the folder builds the journals.
- `atm ship --db <handler sqlite file> --root <folder> --school <id>` runs it from a shell (Bun only, as the rest of the CLI; it opens the file read-write and waits up to 5 s for the handler's lock). It exits 1 on a conflict.
- Not built: R2 batches (the call works against `R2Store`, untested there), the `day.jsonl` combine, the signed manifest and Parquet. A batch is named `batch-*`, never `day.jsonl` or `late-*`; once the combine exists, a batch shipped to a day that already has its `day.jsonl` is not read (the reader keeps only `late-*` beside it), so the combine step has to decide that case.

### Not in this release

The `day.jsonl` combine, the R2 shipper and manifest, simulation, corrections, the Parquet export and webhook delivery. See `ROADMAP.md`.
