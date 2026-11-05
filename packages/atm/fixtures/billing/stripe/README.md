# Synthetic Stripe webhook fixtures

These JSON files are **synthetic**: hand-written to match the shape of Stripe's documented event and object formats. They contain no real customer, card, or account data. Ids (`evt_SYNTH_…`, `in_SYNTH_…`, `cus_SYNTH_…`), emails (`@example.test`) and addresses are invented.

One event per file, for each event type that `schema/mapping/` covers:

| File | Event | Notes |
|---|---|---|
| `invoice.paid.json` | `invoice.paid` | New monthly join: tier line plus an add-on line |
| `invoice.paid.upgrade.json` | `invoice.paid` | Mid-cycle upgrade: two proration lines |
| `charge.refunded.json` | `charge.refunded` | Full refund |
| `charge.dispute.created.json` | `charge.dispute.created` | Dispute opened |
| `charge.dispute.closed.json` | `charge.dispute.closed` | Dispute won |
| `customer.subscription.created.json` | `customer.subscription.created` | Active monthly subscription |
| `customer.subscription.updated.json` | `customer.subscription.updated` | Cancel at period end |
| `customer.subscription.deleted.json` | `customer.subscription.deleted` | Canceled |

`api_version` is `2025-10-29.clover` in every file. That pin is **UNVERIFIED**: no account's real API version is recorded in the repository yet. Shapes follow the basil-era layout (subscription period fields on the subscription item, subscription id under `invoice.parent`, price on `lines.data[].pricing`). Replace the fixtures with recorded test-mode payloads once the account's version is confirmed.
