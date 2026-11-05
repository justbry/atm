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

## Quantity payloads (added 2026-11-05)

Six more files about quantity: a subscription created with two units, raised to four mid-cycle, a renewal that carries leftover proration lines, and a subscription with two items.

### Provenance

- Same Stripe sandbox (test mode, API `2025-10-29.clover`), captured on 2026-11-05 with a script (`capture.py`) that creates a test clock, a monthly 1500 USD per-unit price (and a 500 USD add-on price) and subscriptions on it, then advances the clock: the raise 2 to 4 ten days into the period (`proration_behavior=always_invoice`), a decrease 4 to 2 three days later (`create_prorations`), and a renewal one day after the period ended.
- The prices are per unit, so the tier line's `amount` is `quantity x 1500`. Money below is in cents.

### Which fields are real and which are reconstructed

- **Real:** every `data.object` (the invoice or subscription, read from the API at `2025-10-29.clover`), including all ids, timestamps, amounts, quantities, line periods and the `payments` list on the invoices.
- **Reconstructed:** the event envelope. These are API objects, not webhook deliveries. `id` is invented (`evt_...`, fresh, same scrubbed look as the others), `api_version` is set to `2025-10-29.clover`, `created` is the object's own `created` (for the subscription update, the time of the raise), `livemode` is `false`, `pending_webhooks` is `0` and `request` is `{id: null, idempotency_key: null}`.
- **Scrubbed** like the files above: the account-specific tail of every id became `ScrubTest0`, the hosted invoice and PDF links became `example.test` links, `account_name` became `Example Account`, and `customer_name` (a probe name) became `Example Customer`. Customer email, address and phone were already null; there was no card fingerprint in these objects.

### What each file shows

| File | Shows |
|---|---|
| `invoice.paid.quantity_create.json` | `subscription_create` for a subscription of **2** units: one line, quantity 2, amount 3000, `proration: false`, period one month. Invoice `period_start` = `period_end` = the creation time. |
| `invoice.paid.quantity_raise.json` | The raise 2 to 4, `always_invoice`: a `subscription_update` invoice, paid at once (2000), with **two proration lines on the same price**: quantity **2**, amount **-2000** (the old quantity credited, `proration_details.credited_items` names the create invoice and its line) and quantity **4**, amount **+4000** (the new *total*, not the delta of 2). Both lines' periods run from the time of the change to the cycle end; the invoice's own period is the part already elapsed (cycle start to the change), so the lines start later than the invoice. |
| `invoice.paid.quantity_cycle_with_prorations.json` | The renewal after a decrease 4 to 2 with `create_prorations`: a `subscription_cycle` invoice (own period = the old cycle) with the **tier line** (quantity 2, 3000, `proration: false`, new cycle) plus two **proration lines** left over from the decrease (quantity 4, -3400; quantity 2, +1700; period = the tail of the old cycle). Total 1300. So a cycle invoice can hold proration lines. |
| `customer.subscription.updated.quantity_raise.json` | The subscription after the raise: one item with quantity **4**, item period unchanged, `latest_invoice` = the raise invoice, metadata kept. No `previous_attributes` (the object was re-read, see above). |
| `customer.subscription.created.two_items.json` | A subscription with two items, in creation order: the tier price (quantity **3**) then the add-on price (quantity **1**), metadata `b4u_school` / `family_id`. |
| `invoice.paid.two_items_create.json` | Its create invoice: two lines in the same order (3 x 1500 = 4500, 1 x 500 = 500, total 5000). The invoice's own `metadata` is `{}`; `b4u_school` / `family_id` sit at `parent.subscription_details.metadata`. |

`tests/stripe-recorded-quantity.test.ts` normalizes each file, checks these facts, and runs the no-leak and OpenAPI shape checks on them (the files are listed by name there).

## Delivered events (added 2026-11-05)

`delivered/` holds whole webhook events, one directory per scenario, as Stripe delivered them to an endpoint created with `api_version: "2025-10-29.clover"` (through a cloudflared tunnel to the reference handler). Unlike the files above, the **envelope is real** (`id`, `created`, `api_version`, `request`, `pending_webhooks`); only the scrubbing below was applied. `tests/stripe-recorded-delivered.test.ts` replays each directory through `handleStripeWebhook` (signed, in `created` order, retrying the 409s as Stripe does) and checks the credits.

### Provenance

- Same Stripe sandbox as above (test mode), driven on 2026-11-05 with test clocks (the tier, yearly and schedule scenarios), plain API calls (the refunds and disputes: card `pm_card_createDispute`, then dispute evidence `losing_evidence` or `winning_evidence`) and a real hosted Checkout and billing portal opened in a browser (the gift scenario, a test card, the portal's stepper).
- Files are named `NN-<type>.json`, in `created` order (a whole second; events created in the same second sort by id, so a file's number is not always the order of delivery). `invoice_payment.paid` often arrives before its `invoice.paid`, and the handler then answers 409 `unmatched_invoice` until the invoice is in; the test retries such 409s the way Stripe does.
- `menu.json` is the menu the prices were published from (the quantities menu plus the two gift add-ons); `prices.json` maps each of its price keys (`b4u_key`) to the scrubbed Stripe price id, so a test can build the handler's `priceIds` without writing a lookup key.

### Scrubbing

Same rules as above, applied by a script: the account-specific tail of every id became `ScrubTest0`, `acct_...` became `acct_Scrubbed`, hosted links (invoice, receipt, portal) became `https://example.test/<host>`, emails became `member@example.test`, and the card fingerprint, authorization code, network transaction id, account name, customer name and request idempotency key were replaced by fixed words. A price's `lookup_key` (which names the school and the amount) became `scrubbed-lookup-key-<tier>-<interval>`; atm reads prices by id, not by lookup key. Customer, product and price ids are otherwise as recorded. The school is `spike-school` and the families `fam_B`, `fam_C`, `fam_D2`, `fam_Eb`, `fam_E2b`, `fam_Fb`, `fam_F2b`, `fam_G`.

### Scenarios

| Directory | Subscription | What the handler does |
|---|---|---|
| `tier-and-quantity-change` | sparkle x2, then shine x4 in one update on day 10 (`always_invoice`) | grants 2 (4 x 1 less 2 x 1 visits, prorated up), the membership moves to shine; balance 4 |
| `yearly-raise` | yearly sparkle x2, then x4 on day 90 | grants 24 for the create and 19 for the raise (2 units x 12 x 275/365, rounded up); balance 43 |
| `schedule-decrease` | monthly shine x4; a subscription schedule lowers it to x2 at the renewal | nothing until the renewal; the renewal resets to 2 |
| `full-refund`, `partial-refund` | monthly sparkle x2, refunded in full or by 5000 | the full refund takes the 2 credits back (balance 0); the partial one changes nothing |
| `dispute-lost`, `dispute-won` | the same, paid by a card that opens a dispute on the first charge | lost: balance 0; won: balance 2 |
| `gift-checkout-and-portal` | a hosted Checkout of sparkle x2 plus a one-time gift visit, then a portal raise to x4, then a portal decrease to x2 | the create grants 2 and a gift lot of 1 (it expires after `giftSessionMonths`); the raise adds 2; the decrease makes a schedule and changes nothing; balance 4, gift 1 |

### What the run showed

- In the refund and dispute run, the first delivery of `invoice_payment.paid` answered 409 `unmatched_invoice` for all four families (it beat its `invoice.paid`), and then each refund or dispute answered 409 `unmatched_payment` because the link was not in yet. The same happened to the raise's `invoice_payment.paid` in the gift scenario. Stripe's sandbox retry of a 409 had not fired two minutes later; the events were resent by hand, in order, and then applied. A live-mode retry backs off over up to three days, so how soon a refund lands depends on it.
- A portal configuration's `products` (and `adjustable_quantity`) is accepted and validated by Stripe but never returned on a read; the hosted portal still enforced 1 to 4.
- A gift line in a subscription Checkout comes on the first invoice as `quantity 1`, `proration: false`, with a period equal to the first cycle's.

## SYNTHETIC / UNVERIFIED: discounted invoices (added 2026-11-05, 0.8.0)

**Nothing in this directory shows a discounted invoice, and none was recorded.** `../synthetic/invoice.paid.discount_15pct.json` and `../synthetic/invoice.paid.discount_100pct.json` are `invoice.paid.subscription_create.json` (real) with the discount fields added by hand, in the shape Stripe documents for the pinned API version: the line's `discount_amounts` and `discounts`, the invoice's `discounts` and `total_discount_amounts`, and `total`, `amount_due` and `amount_paid` lowered by the discount (15%: 225 of 1500; 100%: 1500, paid 0). The envelope and event ids are invented (`evt_SynthDiscount...`). They are not Stripe output; do not cite them as such.

What is assumed and not verified: that a real discounted invoice line keeps its **gross** `amount` (the price times the quantity, with `subtotal` equal to it) and lists what a coupon took off in `discount_amounts`. Stripe documents `subtotal` as "before any discounts or taxes" and does not say in so many words that `amount` is the same; every recorded line here has no discount, so `amount` equals `subtotal` and cannot tell the two readings apart. `normalize` maps `amount` as before and adds `InvoiceLine.discount` and `BillingInvoice.discount` (the sums of the `discount_amounts` and `total_discount_amounts`), and the grant rules never read them, so credits are the same either way unless Stripe's `amount` turns out to be net of the discount (then a 100% off line would read as 0 and a recurring add-on's `amount > 0` check would skip it). To close it: record a test-mode invoice from a subscription with a coupon (`stripe` CLI, a test-mode sandbox only) and compare `amount`, `subtotal` and `discount_amounts` of its lines. `tests/billing-codes-discount.test.ts` names these cases `SYNTHETIC / UNVERIFIED`.

## Booking payments: Checkout Session and refund (added 2026-11-05)

`booking/` holds the events of a one-time payment for a booking (`checkout.session.completed` and `.expired` in payment mode, and the `charge.refunded` of the charge, full and partial), plus one `checkout.session.completed` in subscription mode. `tests/booking-pay-events.test.ts` runs each through `handleStripeEvent`.

### Provenance

- Same Stripe sandbox (test mode, `livemode: false`), 2026-11-05, with the Stripe CLI: `stripe trigger checkout.session.completed` and `checkout.session.expired` (the CLI's own fixtures create a product, a price and a payment-mode session, and confirm it server-side with a test card), with `--add checkout_session:metadata[...]` for `booking_id`, `b4u_school`, `family_id`, `b4u_kind` and `--add checkout_session:payment_intent_data[metadata][booking_id]`; then `stripe refunds create --payment-intent <pi>` (full: 3000) and with `--amount 1000` (partial). The subscription-mode session is the real one the gift scenario above made (a hosted Checkout in a browser).
- **What is real:** every `data.object` (re-read with `Stripe-Version: 2025-10-29.clover`), with its ids, amounts, `payment_status`, `status`, `mode` and metadata. **Finding:** a payment intent's metadata is copied to its charge, so the `charge.refunded` object carries `metadata.booking_id`; the session's own metadata is not copied to the charge.
- **What is reconstructed:** the envelope, as in the files above. Stripe stored the events at the account's default API version (`2022-11-15`), so `api_version` is set to `2025-10-29.clover` and the object is the re-read one; `id`, `created`, `type` and `livemode` are the stored event's. `charge.refunded` keeps the stored event's `data.previous_attributes` (its `receipt_url` scrubbed).
- **What is NOT the real flow:** these sessions were made by the CLI's fixtures, not by `bookingCheckoutParams`. They have the fixture's own price line (3000 USD, not an inline `price_data`), no `client_reference_id`, and the charge carries `booking_id` only (the fixtures put no other key on the payment intent). A session made by `bookingCheckoutParams` gives its payment intent the same metadata as the session, so its charge should carry all of it, but that was not recorded. The sandbox delivered no `checkout.session.async_payment_succeeded`: it is not recorded, and the test that uses one builds it from a recorded `completed` event and is named `unverified fixture`.
- **Scrubbing:** as above (`ScrubTest0`, `acct_Scrubbed`, links to `https://example.test/<host>`, fixed words for fingerprint, authorization code, network transaction id, idempotency key, emails and names), plus the session ids (`cs_test_ScrubSession<n>`, in order of first appearance), the account's display name, its statement descriptor, and the CLI fixture's sample customer address.

| File | Shows |
|---|---|
| `booking/checkout.session.completed.json` | A paid payment-mode session: `mode: payment`, `status: complete`, `payment_status: paid`, `payment_intent`, `amount_total`, `currency`, our metadata (booking `bk_trig1`). |
| `booking/checkout.session.completed.second.json` | Another one (booking `bk_trig2`), the partly refunded one. |
| `booking/checkout.session.expired.json` | The session expired unpaid: `status: expired`, `payment_status: unpaid`, `payment_intent: null`. |
| `booking/checkout.session.completed.subscription.json` | A subscription-mode session, which atm must not decide on (the invoice does). |
| `booking/charge.refunded.full.json` | The full refund of `bk_trig1`'s charge: `refunded: true`, `amount_refunded` 3000, `metadata.booking_id`. |
| `booking/charge.refunded.partial.json` | A partial refund (1000 of 3000) of `bk_trig2`'s charge: `refunded: false`. |
