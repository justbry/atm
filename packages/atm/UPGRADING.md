# Upgrading atm

## Moving to 0.3.0 from 0.1.0

0.1.0 was the engine as a CLI and a library: `runEngineCommand` and the engine's own types, nothing else. Everything billing-related is new to a 0.1.0 caller: the menu, Stripe mappings, grants, the webhook handler, the object store and the ledger events. `runEngineCommand` and the CLI work as before. `README.md` describes each piece; this lists what a caller has to provide and the behaviours that are easy to get wrong.

### Stripe

- **API version.** The mappings read Stripe API `2025-10-29.clover`; an event from any other version is refused (`unknown_mapping`). A school's webhook endpoint must be created with `api_version: "2025-10-29.clover"` (the endpoint's version, not the request header, decides the shape of the events it receives), and every API call should send the same `Stripe-Version`.
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

### Storage

- `Store` and its errors, `FolderStore` and `R2Store` (on `aws4fetch`) are exported, with a contract suite that runs against the folder and SeaweedFS. Live balances stay in the caller's SQLite; the object store holds the append-only log.
- Both stores validate keys and byte ranges strictly and refuse what they cannot serve; no caller should rely on a looser reading. `FolderStore` treats reserved names case-insensitively, as a case-insensitive filesystem does.
- `balance-engine` has one opt-in change (`org.config.deduction_order`), listed in `UPSTREAM.md`.

### Not in this release

Tier quantities, the shipper that moves the outbox to R2, simulation, corrections, the Parquet export and webhook delivery. See `ROADMAP.md`.
