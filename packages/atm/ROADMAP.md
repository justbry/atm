# atm roadmap

What is not built yet. What is built is in `README.md`. Order is not a commitment. Competitor behaviour below comes from the vendors' public docs as read on 2026-11-04 (research notes in the session that wrote this), not from running their products.

## Usage invoicing

- **Today:** atm grants credits from paid flat-price invoices (tiers, add-ons, gifts) and never prices usage. Metered usage pricing is out of scope; atm is a credits and flat-subscription engine.
- **What it would be:** bill usage at the end of a period: events become a quantity per metric, the quantity is priced (unit, tiered, volume, package), and the result is an invoice. Late events need a grace window before the invoice is final; the vendors differ (Orb 12 hours, Stripe 1 hour up to 72, Metronome a 34-day backdating window).
- **Open decision:** pass usage to Stripe meters (Stripe rates and invoices; atm keeps credits as the drawdown), or rate it in atm. The first keeps Stripe the system of record for money; the second makes atm compete with Stripe Billing.
- **Builds on:** the deterministic event log and replay, and the credit ledger's drawdown order (`policy.deductionOrder`).

## Simulation or what-if

- **What:** replay the event log against a candidate menu or policy and diff the journals and per-holder balances against the current ones. No writes. Planned command: `atm billing simulate --menu <file> --policy <file> --events <dir>`.
- **Why it is cheap here:** the engine is pure and the ledger is deterministic; `replayEvents` already reproduces balances (the fixture year is a golden test).
- **Limits to state in the output:** a replay re-decides credits only. It cannot change what Stripe already charged, and a changed menu changes the credits a payment would have granted, not the prices paid.
- **Reference:** Orb runs up to five pricing scenarios against historical events and subscriptions.

## Outbound webhooks and alerts

- **Today:** atm writes ledger events; nothing is delivered. Delivery belongs to the caller.
- **Planned in atm:** the events only. `credit.depleted` and `credit.low` (threshold in the policy) as ledger events. Webhook and email delivery stay with the caller.
- **Not decided:** a reference deliverer beside the Bun/Node webhook handler that signs and sends webhooks from the outbox, with retries and a dedupe key per event.
- **Reference:** Orb has `customer.credit_balance_depleted` and `subscription.usage_exceeded` alerts and signs its webhooks; those names come from third-party docs, not Orb's own webhook reference.
