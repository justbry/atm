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
| `payout.paid.json` | `payout.paid` | Automatic payout of 245.00 USD, from Stripe's documented payout object |
| `payout.failed.json` | `payout.failed` | The same payout (`po_SYNTH_0001`, 245.00 USD) failing a day after the `payout.paid` event: `status` `failed`, a `failure_code`, a `failure_message` and a `failure_balance_transaction`. **Synthetic**: written by hand from the shape of `payout.paid.json` and the pruned OpenAPI spec, not recorded from any account; every id in it is invented |
| `customer.subscription.created.json` | `customer.subscription.created` | Active monthly subscription |
| `customer.subscription.updated.json` | `customer.subscription.updated` | Cancel at period end |
| `customer.subscription.deleted.json` | `customer.subscription.deleted` | Canceled |

`api_version` is `2025-10-29.clover` in every file. That pin is **UNVERIFIED** against a real account: no account's real API version is recorded in the repository yet. The shapes are checked against Stripe's published OpenAPI spec for that version (`schema/stripe/objects.clover.json`, pruned by `bun schema/stripe/build.ts <spec3.json>`; `tests/stripe-shape.test.ts`): no field the spec lacks, none of the wrong type. So an invoice line has no `price` object and no `proration` (it names its price by id in `pricing.price_details.price`, and proration sits on `parent.subscription_item_details`), and a charge or dispute names its `payment_intent`, not an `invoice`. The spec cannot say which optional fields a real event omits, or in what order events arrive: `recorded/` holds scrubbed test-mode payloads from a real account at this version (see its README); where the two differ, the recorded ones are right. The synthetic charge has no `refunds` list and the invoice carries checkout's metadata at `parent.subscription_details.metadata`, as the recorded ones do.
