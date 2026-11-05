# Upgrading atm

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

- `credit.low` and `credit.depleted` fire only for draws by `track` or `finalize`, that is customer activity (holds and spends). A refund or dispute clawback and an admin edit do not raise them.
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

### Not in this release

The shipper that moves the outbox to R2, simulation, corrections, the Parquet export and webhook delivery. See `ROADMAP.md`.
