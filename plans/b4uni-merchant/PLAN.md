# B4 Uni as its own merchant on tfd

Owner decision, 2026-11-22: B4 Uni sells its own family, Guide, school and organizer plans on its own Stripe account,
through the same tfd handler that schools use. Prices come from buzz-school's `docs/design/pricing.json` (on `main`,
updated 2026-11-21; the file calls its numbers placeholders). Checked against `origin/dev` at `3f1f769bf2` (tfd 0.11.1
plus #104). The owner approved decisions 1 to 4 on 2026-11-22; they are built into PR #105, or written down here where
no code was needed.

## Fit, checked against the code

| Need | Today | Where |
|---|---|---|
| Tiers with month and year prices | Yes. At least 50¢ each, at most two prices (one per interval) | `schema/catalog/menu.v1.json` |
| One menu per audience under one merchant | **Built in #105.** A menu held at most 4 tiers and 6 add-ons. B4 Uni's paid plans are 7 tiers and 9 add-ons. Splitting them across several school ids doesn't work: one endpoint serves one `schoolId` (other schools get 422 `school_mismatch`, which Stripe retries), and payouts book to `deps.schoolId`, so the books would split across ledgers. | `handler/stripe-webhook.ts:14-20, 381, 485` |
| Credit packs ($5–$50, 10 credits per $1) | Yes. One-time add-ons that grant a `credits` feature, sold by `oneTimeCheckoutParams` | `stripe-menu.ts:515` |
| Spending credits (Gumbee 1, Goldee 2) | Yes. `track` and `check` with `addToBalance: -n`; buzz-school chooses n | engine |
| Full refund takes back unused credits | Yes. Policy `removeOnFullRefund` | `policy.ts` |
| Daily allowance (10 a day on Free, 100 on Go Build) | No. A grant's `every` is `month` or `year`. Free has no invoice to grant from. | schema `interval` |
| Early-prepay price until Dec 15 (decided) | Partly. A member code with `percentOff`, `tierIds` and `expiresAt` (Stripe's promotion code stops working then). It can't be limited to yearly checkouts: when a menu has codes, `checkoutParams` lets a buyer type one. | `stripe-menu.ts:447-497` |
| One plan per group (the cart) | Yes, if the holder is the group. tfd keeps one tier subscription per holder (`grants.ts:792-796`); the holder is whatever `family_id` buzz-school puts in the metadata | `handle.ts:136` |
| Treasurer at $8 a month on Listed | Not as an add-on: Listed is free, and a recurring add-on is granted only on a tier subscription (`addon_only_subscription`). **Decided:** a tier, "Listed with Treasurer" | `handle.ts:213, 290` |
| Extra school at $25 a month | Yes, as a monthly add-on on the Academy subscription. One per checkout: add-ons have no quantity, so a second extra school is a change on the subscription itself (as the quote is) | `stripe-menu.ts:433` |
| Go Learn, pay what you can | **Built in #105**, as a pay-what-you-can add-on. Before it, a price that wasn't on the menu, with B4 Uni's metadata, was refused 422 `unmatched_line` (Stripe retried for three days), and without the metadata it was `ignored`. | `menu.v1.json` `payWhatYouCan` |
| Pay later (up to 4 payments) | Decided: a tfd-notes note, each instalment a tfd checkout (decision 5) | `billing/pay-later.ts` (#107) |
| Guide fee by tier (20%, 14%, 8%) | **Yes, with no code change.** `policy.revenueShare` is one rate per seller, booked in the seller's ledger and invoiced afterwards. Each payment keeps the rate it was booked at, so a rate change mid-month is right on the statement | `share.ts`, `ledger/share-statement.ts:88` |
| Fee taken at checkout (Connect `application_fee`) | No. Out of scope (decision 3); on the roadmap | — |
| Receipts and invoices on demand | Partly. Stripe's hosted invoice and PDF are on every `BillingInvoice`; `receiptOfV2` and `signReceipt` sign a proof of payment. buzz-school calls neither. No itemised receipt. | README "Invoices and receipts" |
| Free tiers at $0 | Not as a tier (a price is at least 50¢). "No subscription" means Free, as `catalog/trifold` does it | `catalog/trifold/index.ts:4` |

## Design

**One merchant, one menu, one endpoint.** B4 Uni is one school id in tfd, `b4uni`. Its Stripe account gets one clover endpoint (`createCloverEndpoint` with B4 Uni's own restricted key) and its
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
`packages/atm/fixtures/billing/menu/b4uni-merchant.json`, generated from buzz-school's `b4uniMenu(D)`
(`docs/design/pricing-render.js` on `main`, built from `pricing.json`), the menu's source of truth, plus the early-price
code. Its ids are frozen once booked: `go_build`, `go_hive`, `passport`, `odyssey`, `guide_pro`, `guide_studio`,
`academy`, `listed_treasurer`, `basecamp`; add-ons `credits_50`, `credits_100`, `credits_250`, `credits_500`,
`go_learn`, `vetting`, `vetting_pro`, `extra_school`, `trip_leader_check`.

**Fixed ids (decision 1, frozen 2026-11-22).** These are never changed once the first event is booked:

| What | Id |
|---|---|
| The merchant's school id | `b4uni` |
| A family | `fam_<id>` |
| A Guide | `guide-<uid>` |
| A school | `school-<id>` |
| An organizer | `org-<id>` |

`family_id` in the checkout metadata holds the group id. Each group is a separate subject (`b4uni|live|family:<group>`),
with its own subscription, its own credits and its own money lines, all in B4 Uni's one ledger. The `family:` part is a
frozen label, not a claim that the group is a family. The menu's `holderPrefixes` maps each audience to its prefix, and
both checkouts refuse a holder id without the prefix of the audience it buys from (`holder_not_in_audience`). The
webhook doesn't check it, so an event Stripe already took money for is never refused for its id.

**Go Learn (decision 2).** It is an add-on with `price.payWhatYouCan`, in the families audience. The buyer pays at least
`amount` (50¢, the schema's least), at most `maximum` ($500 in the fixture), and Checkout starts at `preset` ($48).
`menuToStripe` makes a one-time Stripe price with `custom_unit_amount` (`unitAmount: null`, plus `customUnitAmount`).
Its lookup key names the maximum and preset, so a change to either is a new price. Stripe sells such a price alone, at
quantity 1, with no coupon. So `oneTimeCheckoutParams` sells it only on its own, `checkoutParams` refuses it
(`addon_sold_alone`), and a dollar gift can't pay for it. The handler matches the line by price id and books what the
buyer chose to `income:billing:addon:go-learn`, with no credits. Not checked in a Stripe account: that a session with
`invoice_creation` accepts a `custom_unit_amount` price (Stripe's docs don't say).

**Fees on sales (decision 3).** These are booked after each sale with `revenueShare` and invoiced monthly from
`shareStatement`. Every seller is its own tfd school, on its own Stripe account and endpoint, so its rate is its own
policy's. buzz-school sets `revenueShare.percent` in the seller's policy from the seller's B4 Uni plan, read from the
seller's subject in B4 Uni's ledger (below). It writes a new policy version when the plan changes: on the paid
invoice, and when the subscription ends, back to the free rate. No code change was needed. Connect `application_fee`
stays on the roadmap.

| Seller | No plan (free) | Paid tiers |
|---|---|---|
| Guide | Guide Free 20% | Guide Pro 14%, Guide Studio 8% |
| School | Listed 20% (a school with no tuition sells nothing, so it owes nothing) | Listed with Treasurer 20%, Academy 12%, District per quote |
| Organizer | Day Pack 12% | Basecamp 8%, Summit per quote |

The rates are `pricing.json`'s `feeFree`, `feePro`, `feeStudio`, `shareListed`, `shareAcademy`, `shareDayPack` and
`shareBasecamp`. The file calls them placeholders. Listed with Treasurer takes Listed's rate, an assumption.

**School tiers (decision 4).** "Listed with Treasurer" at $8 a month and Academy are the schools audience's tiers.
Listed itself is free, so it is no tier: a price is at least 50¢, and "no subscription" means Listed, as "no
subscription" means Free for families. District is a quote, outside the menu. The add-on left for schools is the extra
school at $25 a month, on the Academy subscription.

**Reading a family's plan.** The plan is in the grants row of the subject: `grantsFromRows(rows)` gives `tierId`,
`interval`, `membership.status` (`active`, `past_due` and so on) and `cycleEnd`. No row, or an `ended` status, means
Free. Credits come from `balancesOf` (or the engine's `check`) on the same rows. buzz-school reads these from its
`atm_rows`, which the handler writes.

## Gaps tfd should close (in order)

1. **Audiences.** Done in #105.
2. **Pay what you can, as a menu add-on.** Done in #105.
3. **Holder prefixes per audience.** Done in #105.
4. **A code limited to an interval** (`codes[].intervals: ["year"]`). Done: `checkoutParams` refuses it on a monthly
   checkout and offers no typed codes there. Stripe cannot restrict a code by price, so a monthly checkout that offers
   typing for another code could still take it; B4 Uni has no other code (set `policy.memberCode` to `null`).
5. **Fees taken at checkout** (Connect `application_fee_amount`). Out of scope by decision 3; on the roadmap.

## Gaps that stay outside tfd

- **Daily allowance.** A per-day counter in buzz-school, keyed by learner and day in the family's zone, with the limit
  from the plan read above (10, 100, or none). When the counter runs out, buzz-school spends credits with `track`. Daily
  grants in tfd would book about 365 credit events a year per family into sealed books, for something that isn't money,
  and Free has no invoice to grant from.
- **The early price.** A member code: `EARLY2027`, 30% off Go Build and Go Unlimited, `expiresAt` the end of
  2026-12-15 in Denver (2026-12-16T07:00:00Z), `intervals: ["year"]`, so tfd's checkout takes it on yearly checkouts
  only.
- **Receipts.** Show `hostedInvoiceUrl` and `invoicePdf` to the family (they are bearer links, so keep them out of
  logs). Sign with `receiptOfV2` once B4 Uni has a signing key. The itemised receipt is still the owner decision in
  `docs/receipts.md`.
- **District and Summit quotes.** A Stripe invoice or subscription made by hand, on a price that isn't on the menu,
  without B4 Uni's metadata. It is `ignored`, so tfd doesn't book it.

## Decisions

Taken on 2026-11-22: 1, the fixed ids; 2, Go Learn as a pay-what-you-can add-on; 3, fees booked afterwards with
`revenueShare`; 4, Treasurer on Listed as a tier. Decision 5:

Pay later = tfd-notes: each instalment is a tfd one-time checkout tied to a note (zero interest, at most 4 instalments until counsel reviews Regulation Z).

Settled later on 2026-11-22 (buzz-school PR #1502):

6. **Early price.** Launch day is Dec 1, 2026. The 30% yearly early price ends 14 days later, at the end of Dec 15, 2026
   in America/Denver; the fixture's `EARLY2027` expires then.
7. **Guides sell on their own Stripe.** Each Guide is their own tfd school id; B4 Uni never holds a tutor's money. B4
   Uni's fee (20%, 14% or 8% by Guide tier) is booked with the Guide's `revenueShare` and invoiced monthly from B4 Uni's
   own Stripe. Connect comes later.
