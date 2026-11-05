# Recorded Stripe payloads (test mode, API 2025-10-29.clover)

These files are real Stripe objects, scrubbed. They show the shapes the synthetic fixtures one directory up only imitate.

## Provenance

- Source: a Stripe sandbox account in **test mode**, driven with the Stripe CLI (`stripe trigger ...`, `stripe test_helpers test_clocks ...`) on 2026-11-05.
- The account's API version is pinned to `2025-10-29.clover` (the version every mapping in `schema/mapping/` reads).

## Reconstruction caveat (read this before trusting an envelope)

The envelopes are **not verbatim webhook deliveries**.

- The events came from `stripe listen --latest`, which delivered them at API version `2026-10-28.endive`, not the pinned one.
- Each `data.object` was re-fetched from the API with `Stripe-Version: 2025-10-29.clover` and the event envelope was rebuilt around it (`id`, `created`, `type`, `request` as recorded; `api_version` set to `2025-10-29.clover`). `charge.refunded` keeps the `data.previous_attributes` of the recorded event (its `receipt_url` scrubbed).
- The `subscription_cycle` invoice was read straight from the API (a test clock advanced one month) and wrapped as an `invoice.paid` event here: its event id is invented and `request` is empty.
- `invoice.with-subscription-metadata.json` is a plain API invoice, not an event.

So the `data.object` of every file is real at the pinned version; the envelope around it is a faithful reconstruction, not a recording.

## Scrubbing

Every id of this account ended in an account-specific tail; the tail, the account id (`acct_...`), the hosted invoice / PDF / receipt links (which embed the account id), the card fingerprint, authorization code, network transaction id, account name and statement descriptor were replaced consistently. The files carry no real account id, email, name, address or phone (the recorded objects had none: those fields are null). Shapes, types and numbers are untouched. Customer ids (`cus_...`) and product ids are otherwise as recorded: they belong to disposable test-mode objects.

## What each file shows

| File | Shows |
|---|---|
| `invoice.paid.subscription_create.json` | A `subscription_create` invoice: `parent.subscription_details` names the subscription; the line has `pricing.price_details.price` and its own `period`; top-level `metadata` and subscription metadata are both `{}` (this subscription was created without any). |
| `invoice.paid.subscription_cycle.json` | A `subscription_cycle` renewal. The invoice's own `period_start`/`period_end` are the **previous** period; the new period is on the **line** (`lines.data[0].period`). |
| `invoice.with-subscription-metadata.json` | An invoice from a subscription created with metadata: the invoice's `metadata` is `{}` and the data (`b4u_school`, `family_id`) sits at `parent.subscription_details.metadata`. A plain API object (see above). |
| `customer.subscription.created.json` / `.updated.json` | One active monthly subscription (metadata `{foo: bar}`); the period sits on the item (`items.data[0].current_period_start/end`), and `price.lookup_key` is null. |
| `customer.subscription.deleted.json` | A canceled subscription. |
| `charge.refunded.json` | A full refund: the charge has **no `refunds` list**; only `amount`, `amount_refunded`, `refunded`, `payment_intent` and the event's `previous_attributes.amount_refunded`. |
| `charge.dispute.created.json` | A dispute opened (`warning_needs_response`); it names its `charge` and `payment_intent`, not an invoice. |

`tests/stripe-recorded.test.ts` normalizes each file and checks the key facts.

Scrubbed too: each event's `request.idempotency_key` (a random request id, replaced by `scrubbed-idempotency-key` so a secret scanner does not mistake it for a key).
