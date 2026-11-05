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

## Discounted invoices (recorded 2026-11-05)

`discount/` holds six real discounted invoices. They settle what the earlier synthetic files (`../synthetic/invoice.paid.discount_15pct.json`, `../synthetic/invoice.paid.discount_100pct.json`) only assumed: **an invoice line's `amount` is GROSS** (price x quantity, before any discount). What a coupon took off is in the line's `discount_amounts`; the invoice's `subtotal` is the sum of its lines' `amount`, `total` is `subtotal` less the discount, and `amount_due` and `amount_paid` follow `total`. atm's reading (`InvoiceLine.discount` and `BillingInvoice.discount` are the sums of `discount_amounts` and `total_discount_amounts`; the grant rules never read them) matches Stripe, so no code changed. `tests/stripe-recorded-discount.test.ts` checks it on these files.

### Provenance

- Same Stripe sandbox (test mode, `livemode: false`; the CLI said `sandbox` and every object had `livemode: false` before anything was created), the Stripe CLI at API `2025-10-29.clover` (`--stripe-version`), 2026-11-05. A script made a product with a monthly 1500 USD price, three coupons (`percent_off` 15, `amount_off` 500 cents, `percent_off` 100, each `duration: forever`), and a test clock per group of customers (a clock holds at most three). Each customer had `pm_card_visa` as its default payment method, so the first invoice paid at once. Four subscriptions of **2** units each were created with `discounts[0][coupon]`: 15%, 500 off, 100%, and a second 15% one for the raise. On the second clock the 15% subscription was raised 2 to 4 ten days into the cycle (`proration_behavior: always_invoice`), then the clock was advanced past the renewal.
- Every invoice was re-read from the API (`stripe get /v1/invoices/<id>` with `expand[]=payments`) at the pinned version. All the test objects were deleted afterwards (clocks with their customers and subscriptions, the coupons) or archived (the price and the product, which Stripe cannot delete).
- **Real:** every `data.object`: ids (after scrubbing), amounts, quantities, periods, `discount_amounts`, `total_discount_amounts`, `discountable`, the `payments` list.
- **Reconstructed:** the event envelope. These are API objects, not webhook deliveries: `id` is invented (`evt_1ScrubDiscount...`), `created` is the invoice's own `created`, `api_version` is the pinned one, `livemode` is `false`, `pending_webhooks` is `0`, `request` is `{id: null, idempotency_key: null}`.
- **Scrubbed** as above: the account-specific tail of every id became `ScrubTest0`, hosted invoice and PDF links became `example.test` links, `account_name` became `Example Account`, `customer_name` (a probe name) became `Example Customer`. Coupon ids appear nowhere in an invoice (only the discount's `di_...` id does). The probe subscriptions carry `b4u_school: sch_probe` and `family_id: fam_pct15`, `fam_amt500`, `fam_pct100`, `fam_raise`.

### What the real shape is (cents)

| Case | Line `amount` | Line `discount_amounts` | `subtotal` | `total` = `amount_due` = `amount_paid` |
|---|---|---|---|---|
| 2 x 1500, 15% off | 3000 | 450 | 3000 | 2550 |
| 2 x 1500, 500 off | 3000 | 500 | 3000 | 2500 |
| 2 x 1500, 100% off | 3000 | 3000 | 3000 | 0 (and the invoice has no `payments`) |
| Raise 2 to 4, 15% coupon | -1700 and 3400 | 0 and 0 | 1700 | 1700 |
| Renewal at 4 x 1500, 15% coupon | 6000 | 900 | 6000 | 5100 |

Other things the files show:

- A line's own `discounts` list is **empty**; the discount's id is on the invoice's `discounts` (a list of ids) and in each `discount_amounts[].discount`. The line also has `pretax_credit_amounts` (type `discount`) and the invoice `total_pretax_credit_amounts`.
- A **proration line is not discountable** (`discountable: false`): on the raise invoice the coupon is listed with `amount: 0` on both proration lines and on the invoice, so the proration pair and the amount paid are the same as at full price. The `sum` field type leaves a total of 0 out, so those lines and that invoice carry no `discount` key in the normalized fact. The renewal's tier line is discounted again (900 of 6000).
- With a 100% coupon the invoice is `paid` with `amount_paid: 0`, and `payments.data` is empty: there was no payment to link. (Nothing in atm needs one: the handler grants from the invoice.)
- Credits do not depend on the discount: with each discount stripped from a copy (lists emptied, `total` and `amount_paid` at the subtotal), the handler stores the same engine rows and balance for the create (15%, 500 off, 100%), and for the create, raise and renewal chain.

| File | Shows |
|---|---|
| `discount/invoice.paid.discount_pct15_create.json` | `subscription_create`, 2 units, 15% coupon |
| `discount/invoice.paid.discount_amt500_create.json` | the same with a 500-cent `amount_off` coupon |
| `discount/invoice.paid.discount_pct100_create.json` | the same with a 100% coupon: paid 0 |
| `discount/invoice.paid.discount_pct15_raise_create.json` | the create of the subscription the raise and the renewal belong to (15%) |
| `discount/invoice.paid.discount_pct15_raise.json` | the raise 2 to 4 under that coupon: two proration lines, not discounted |
| `discount/invoice.paid.discount_pct15_cycle.json` | the renewal of that subscription at 4 units: 6000 gross, 900 off |

### The synthetic files

`../synthetic/invoice.paid.discount_15pct.json` and `../synthetic/invoice.paid.discount_100pct.json` are still hand-made (a real invoice with discount fields added). They were right in what they assumed about the amounts; they **differ** from Stripe in giving a line a non-empty `discounts` list, and `tests/billing-codes-discount.test.ts` still uses them for the edge cases the recordings cannot make (several discounts on one line, a coupon on a proration line). The recorded files above are the evidence; do not cite the synthetic ones as Stripe output.

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
