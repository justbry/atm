# Upgrading atm

## From 0.1.0 to 0.3.0

0.1.0 was the engine as a CLI and a library (`runEngineCommand`). Everything below is new. `README.md` describes each piece; this lists what a caller has to change or provide.

### Stripe

- **API version.** The mappings read Stripe API `2025-10-29.clover`; an event from any other version is refused (`unknown_mapping`). A school's webhook endpoint must be created with `api_version: "2025-10-29.clover"` (the endpoint's version, not the request header, decides the shape of the events it receives), and every API call should send the same `Stripe-Version`.
- **Events to subscribe to:** `invoice.paid`, `invoice_payment.paid`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`. Without `invoice_payment.paid` a refund or dispute cannot find its invoice and answers 409 until Stripe gives up.
- **Checkout metadata.** Put `b4u_school` and `family_id` in `subscription_data.metadata`. On the invoice they arrive at `parent.subscription_details.metadata`; atm reads both and the invoice's own keys win.
- Shapes were checked against real payloads from a Stripe sandbox (`fixtures/billing/stripe/recorded/`). The pin is still unverified against a school's own account.

### Handling an event

- **One entry point:** `handleStripeEvent(input)` turns a raw Stripe event and the subject's stored rows into row changes and ledger events. It reads no clock and writes nothing. The caller verifies the signature, dedupes on Stripe's event id, checks the revision and writes the result in one transaction.
- **`eventId` must be a ULID**, the id of the stored input event, not Stripe's `evt_` id. Anything else comes back `refused` as `bad_event`. Derive it from the Stripe id with `deterministicUlid` so a replay gets the same id.
- **Reference handler.** For Bun or Node, `handleStripeWebhook(deps, request)` does verify, claim (a stale claim is taken over), rows, events and the done mark in one SQLite transaction. Create its tables with `HANDLER_DDL`. A caller with its own handler must provide the same three things: the claim, the invoice-to-subject index and the payment-to-invoice index.
- **Refusals.** `unmatched_invoice` and `unmatched_payment` are retryable (the link has not arrived yet); `unmatched_line`, `missing_metadata`, `unknown_mapping` and `bad_event` need a human.

### Credits

- **Deduction order.** Put `commandOrg(policy)` on every `track`, `check` and `finalize`. `policy.deductionOrder` is `expiry` (default: the row that lapses soonest first, then the oldest grant) or `engine` (Autumn's own order). A caller that sends its own org config gets the engine's order.
- **Stored state.** The grants row gains `holder`, `retired` and `membership`. A grants row stored before these fields existed loads with defaults; nothing to migrate.
- **Membership status** has the value `incomplete` (not yet paid), and `customer.subscription.*` events record the membership without granting anything: credits still come only from paid invoices.
- **Policy.** New fields `deductionOrder` and `lowCreditThreshold`. A stored policy without them gets the defaults.

### Events

Three new ledger event types: `credit.expiration_changed` (a row's credits stay but their end date moved), `credit.low` and `credit.depleted`. Delivery of "N visits left" notices stays with the caller. `credit.depleted` also fires when a refund takes the last credits; filter on `payload.command.type` if that is not wanted.

### Fact shapes that changed

- `SubscriptionFact.items` (price id, lookup key, interval) replaces `tierId` and `interval`, which came from checkout metadata that goes stale after a plan change.
- `BillingRefund.id` is the Stripe event id and `amount` is the charge's total refunded after the event (a real charge carries no refund list).
- A renewal's period comes from the tier line, not the invoice (a real renewal invoice's own period is the previous one).

### Storage

- `Store` and its errors, `FolderStore` and `R2Store` (on `aws4fetch`) are exported, with a contract suite that runs against the folder and SeaweedFS. Live balances stay in the caller's SQLite; the object store holds the append-only log.
- `balance-engine` has one opt-in change (`org.config.deduction_order`), listed in `UPSTREAM.md`.

### Not in this release

Tier quantities, the shipper that moves the outbox to R2, simulation, corrections, the Parquet export and webhook delivery. See `ROADMAP.md`.
