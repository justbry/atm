# B4 Uni as its own merchant on tfd

Owner decision, 2026-11-22: B4 Uni sells its own family, Guide, school and organizer plans on its own Stripe account,
through the same tfd handler that schools use. Prices come from buzz-school's `docs/design/pricing.json` (on `main`,
updated 2026-11-21; the file calls its numbers placeholders). Checked against `origin/dev` at `3f1f769bf2` (tfd 0.11.1
plus #104).

## Fit, checked against the code

| Need | Today | Where |
|---|---|---|
| Tiers with month and year prices | Yes. At least 50¢ each, at most two prices (one per interval) | `schema/catalog/menu.v1.json` |
| One menu per audience under one merchant | **No, until this PR.** A menu held at most 4 tiers and 6 add-ons. B4 Uni's paid plans are 7 tiers and 8 add-ons. Splitting them across several school ids doesn't work: one endpoint serves one `schoolId` (other schools get 422 `school_mismatch`, which Stripe retries), and payouts book to `deps.schoolId`, so the books would split across ledgers. | `handler/stripe-webhook.ts:14-20, 381, 485` |
| Credit packs ($5–$50, 10 credits per $1) | Yes. One-time add-ons that grant a `credits` feature, sold by `oneTimeCheckoutParams` | `stripe-menu.ts:515` |
| Spending credits (Gumbee 1, Goldee 2) | Yes. `track` and `check` with `addToBalance: -n`; buzz-school chooses n | engine |
| Full refund takes back unused credits | Yes. Policy `removeOnFullRefund` | `policy.ts` |
| Daily allowance (10 a day on Free, 100 on Go Build) | No. A grant's `every` is `month` or `year`. Free has no invoice to grant from. | schema `interval` |
| Early-prepay price until Dec 1 | Partly. A member code with `percentOff`, `tierIds` and `expiresAt` (Stripe's promotion code stops working then). It can't be limited to yearly checkouts: when a menu has codes, `checkoutParams` lets a buyer type one. | `stripe-menu.ts:447-497` |
| One plan per group (the cart) | Yes, if the holder is the group. tfd keeps one tier subscription per holder (`grants.ts:792-796`); the holder is whatever `family_id` buzz-school puts in the metadata | `handle.ts:136` |
| Treasurer at $8 a month on Listed | Not as an add-on: Listed is free, and a recurring add-on is granted only on a tier subscription (`addon_only_subscription`). Sell it as a tier, "Listed with Treasurer" | `handle.ts:213, 290` |
| Extra school at $25 a month | Yes, as a monthly add-on on the Academy subscription. One per checkout: add-ons have no quantity, so a second extra school is a change on the subscription itself (as the quote is) | `stripe-menu.ts:433` |
| Go Learn, pay what you can | No. A price that isn't on the menu, with B4 Uni's metadata, is refused 422 `unmatched_line`. The money is still booked once as `income:billing:other`, but Stripe retries for three days. Without the metadata it is `ignored` and not booked at all. | `handle.ts:135-160` (tested) |
| Pay later (up to 4 payments) | No | — |
| Guide fee by tier (20%, 14%, 8%) | Partly. `policy.revenueShare` is one rate per seller, booked in the seller's ledger and invoiced afterwards. A tier changes it only when buzz-school writes a new policy version. | `share.ts` |
| Fee taken at checkout (Connect `application_fee`) | No | — |
| Receipts and invoices on demand | Partly. Stripe's hosted invoice and PDF are on every `BillingInvoice`; `receiptOfV2` and `signReceipt` sign a proof of payment. buzz-school calls neither. No itemised receipt. | README "Invoices and receipts" |
| Free tiers at $0 | Not as a tier (a price is at least 50¢). "No subscription" means Free, as `catalog/trifold` does it | `catalog/trifold/index.ts:4` |

## Design

**One merchant, one menu, one endpoint.** B4 Uni is one school id in tfd, `b4uni`, though any id works if it never
changes. Its Stripe account gets one clover endpoint (`createCloverEndpoint` with B4 Uni's own restricted key) and its
own D1/SQLite for the handler. `deps.schoolId` is `b4uni`, and `deps.context` returns B4 Uni's menu and policy. This
uses the existing B4 Uni mapping, not the cloud's merchant mode. Merchant mode in `plans/trifold-cloud/PLAN.md` is for
payments that carry no metadata (Payment Links, bare payment intents), and every B4 Uni sale goes through tfd's
checkout with metadata. The account should have only B4 Uni's own sales on it. If schools connect to B4 Uni's
platform, their events go to a Connect endpoint, not this one.

**Audiences (built in this PR).** A tier or add-on may name an `audience` (`families`, `guides`, `schools`,
`organizers`). The limits apply per audience: 4 tiers and 6 add-ons each, at most 6 audiences. An item with no audience
is sold to every audience. `publicMenu(menu, audience)` gives one audience's page. `checkoutParams` refuses an add-on of
another audience (`addon_audience_mismatch`). Lookup keys don't change, so adding audiences to a published menu makes no
Stripe step. A school's menu, which has no audiences, has the same limits as before. The fixture is
`packages/atm/fixtures/billing/menu/b4uni-merchant.json`.

**Holders are groups.** `family_id` holds the group id: `fam_<id>` for a family, `guide-<userId>` for a Guide,
`school-<id>`, `org-<id>`. Each is a separate subject (`b4uni|live|family:<group>`), with its own subscription, its own
credits and its own money lines, all in B4 Uni's one ledger. The `family:` prefix is a frozen label, not a claim that
the group is a family.

**Reading a family's plan.** The plan is in the grants row of the subject: `grantsFromRows(rows)` gives `tierId`,
`interval`, `membership.status` (`active`, `past_due` and so on) and `cycleEnd`. No row, or an `ended` status, means
Free. Credits come from `balancesOf` (or the engine's `check`) on the same rows. buzz-school reads these from its
`atm_rows`, which the handler writes.

## Gaps tfd should close (in order)

1. **Audiences.** Done in this PR.
2. **Pay what you can, as a menu add-on.** An add-on with a minimum price that the buyer raises (Stripe Price
   `custom_unit_amount`), published by `menuToStripe` and matched by price id. It is booked to
   `income:billing:addon:<id>` and grants nothing. It needs a new field on `price.create` and on `toStripeForm`. Small,
   but it changes the publish op, so it waits for the owner's go-ahead (decision 2).
3. **A code limited to an interval** (`codes[].intervals: ["year"]`). `checkoutParams` would refuse it on a monthly
   checkout and stop offering typed codes there. Too late for Dec 1, 2026; worth it if early prices come back.
4. **Revenue share from the seller's tier.** An optional `revenueShare` on B4 Uni's Guide and school tiers, plus a
   helper that gives the rate for a seller's current tier. buzz-school then writes the seller's policy version from it.
   This waits on decision 3.

## Gaps that stay outside tfd

- **Daily allowance.** A per-day counter in buzz-school, keyed by learner and day in the family's zone, with the limit
  from the plan read above (10, 100, or none). When the counter runs out, buzz-school spends credits with `track`. Daily
  grants in tfd would book about 365 credit events a year per family into sealed books, for something that isn't money,
  and Free has no invoice to grant from.
- **Pay later.** Stripe Checkout with Affirm or Klarna, which is a payment method, needs no tfd change. Instalments that
  B4 Uni carries itself would be a subscription schedule; that is an owner decision first.
- **The Dec 1 early price.** Use a member code now: `EARLY2027`, 30% off, `tierIds` for the family tiers,
  `expiresAt` 2026-12-01 in Denver. buzz-school applies it only to yearly checkouts. Accept that a buyer could type it
  on a monthly checkout until Dec 1.
- **Receipts.** Show `hostedInvoiceUrl` and `invoicePdf` to the family (they are bearer links, so keep them out of
  logs). Sign with `receiptOfV2` once B4 Uni has a signing key. The itemised receipt is still the owner decision in
  `docs/receipts.md`.
- **District and Summit quotes.** A Stripe invoice or subscription made by hand, on a price that isn't on the menu,
  without B4 Uni's metadata. It is `ignored`, so it isn't booked by tfd, or decision 2's add-on books it.

## Decisions for the owner

1. **School id and holder ids.** Use `b4uni` for the merchant, and `guide-`, `school-` and `org-` prefixes on
   `family_id` for the groups? These are frozen once the first event is booked.
2. **Go Learn.** Build the pay-what-you-can add-on (gap 2)? Or sell it as fixed one-time add-ons ($12, $48, $96)?
   Or keep it outside the books for now?
3. **Guide and school fees.** Book them after the sale with `revenueShare` and invoice monthly, as today? Or take them
   at checkout with Connect `application_fee_amount`? Taking them at checkout needs Connect and a different tfd money
   path.
4. **Treasurer on Listed.** Sell it as a tier, "Listed with Treasurer", $8 a month (assumed in the fixture)?
5. **Pay later.** Stripe's buy-now-pay-later methods, or B4 Uni's own instalments?
