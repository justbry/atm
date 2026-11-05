# Pricing and positioning (2026-11-05)

Written to help decide whether to build usage events and how atm could be sold as a service. The competitor prices below come from web search results on 2026-11-05, mostly third-party and competitor pages, NOT the vendors' own price pages; a figure marked "conflicting" or "low" is a lead to check, not a quote. The technology facts (costs, throughput, what atm can and cannot do) are from the repo and the three usage spikes (`spikes/usage/`). How the other systems behave is in `comparisons.md`; the usage design is in `usage-metering.md`.

## What atm is, for pricing purposes

- A credits and flat-subscription engine over Stripe: it grants credits from paid fixed-price invoices, spends them (`track`), keeps a replayable ledger, and ships a reference webhook handler, a Stripe menu publisher, `portalConfigOf`, `reconcile` and hledger reports. It does not price metered usage or invoice (`README.md` "Scope"; `usage-metering.md`).
- Licence: Apache-2.0, a fork of Autumn's code from before it went private (`UPSTREAM.md`; there is no upstream `NOTICE` file). Anyone may host it, so a hosted service sells operations, support and tooling, not the code. Confirm the licence terms before committing to a commercial model.
- Its infrastructure cost is small: at 300M usage events a month the R2 side is about $0 to $35 a month depending on worker count and flush interval (`usage-metering.md`, "Gateway write path"), and a membership school's billing events are a tiny fraction of that.

## Competitors

| Product | Type | What it is | Pricing found | Confidence |
|---|---|---|---|---|
| **atm (today)** | Open (Apache-2.0) | Credits and flat-subscription engine over Stripe, with a ledger | none yet | n/a |
| **Autumn** (atm's upstream) | Open-source infrastructure, reportedly private now | Credits, entitlements and usage billing over Stripe | a free plan is listed by a directory; nothing else found | low |
| **Lago** | Open (AGPLv3) | Metering and usage-based billing, self-host or cloud | self-host free; Premium and Cloud by quote; no trials for Premium; cloud price depends on annual billing volume, monthly event volume, plan and support | medium |
| **OpenMeter** | Open, bought by Kong (announced 2025-09-03) | Metering and billing, folded into Kong Konnect | not found | low |
| **Flexprice** | Open (AGPL-3.0 core) | Usage, credits, wallets, hybrid pricing | one competitor's page says $199 a month plus 0.5% of billed volume; Flexprice's own pages say flat per plan, never a percentage | conflicting |
| **Polar** | Proprietary, merchant of record | Payments, tax and usage billing for developers | 4% + 40 cents on older pages; 5% + 50 cents per its newer docs, with optional paid plans, plus payout and currency-conversion fees | conflicting |
| **Stripe Billing** | Proprietary | Subscriptions, invoices, basic metering | 0.7% of billing volume; up to 100M metering events a month included (third-party sources) | medium |
| **Metronome** | Proprietary, now Stripe's | Enterprise usage billing | one source: 0.8% plus $0.04 per 1,000 events; others differ | low |
| **Orb** | Proprietary | Usage billing, pricing iteration, credits, invoicing | not public; contact sales | n/a |

Not researched: Chargebee, Recurly, Paddle, m3ter, Amberflo, Kill Bill's current terms.

## A worked example

One school with 1,000 families paying $50 a month: $600,000 a year over 12,000 payments. Annual cost of the billing layer, using the figures above (assumptions, not quotes):

| Option | Calculation | Per year |
|---|---|---|
| Stripe Billing | 0.7% of $600k | about $4,200 |
| Metronome | 0.8% of $600k, before event fees | about $4,800 |
| Flexprice (the $199 + 0.5% reading) | 12 x $199 + 0.5% of $600k | about $5,400 |
| Polar | 5% of $600k + 12,000 x $0.50 (it is a merchant of record carrying tax and compliance, so not like for like) | about $36,000 |
| atm self-hosted | infrastructure only | well under $1,000 |
| atm hosted at 0.2% of managed volume | 0.2% of $600k | **about $1,200** |

At 0.2% the example school pays about $1,200 a year, a sixth of Stripe Billing's 0.7%, and the same order as a flat fee of about $0.10 per active family per month (1,000 x 12 x $0.10 = $1,200).

## Positioning options

| Option | Who pays | Price shape | Competes with | View |
|---|---|---|---|---|
| **A. Membership billing for schools and clubs** (the B4 Uni shape) | schools | per school per month plus a fee per active family | Stripe Billing plus custom code; school and club software | the one with a proven reference customer |
| **B. Credit wallet and entitlements over Stripe** | any app with plans, packs and gifts | per active holder, or a low percentage of volume | Autumn, Flexprice, Polar | crowded; Autumn is the same idea |
| **C. Usage events and rating, plus the wallet** | AI and API products | percentage of billed usage plus events | Stripe meters, Metronome, Orb, Lago | hardest: the leader is bundled with Stripe, and atm does not invoice |

## Pricing stance (a judgement, not market data)

- **Keep the code open (Apache-2.0) and charge for hosting, support and the Stripe publishing tooling, as Lago does** (open source free to self-host; a paid Premium and Cloud for the operated product and support).
- Undercut Stripe Billing's 0.7%, because atm does not invoice, run tax or collect payment: about 0.1% to 0.3% of managed volume, or a small per-active-holder fee. At 0.2% the example school pays about $1,200 a year.
- Charge for what is hard to run, not for events: the Stripe menu publish and `portalConfigOf` tooling, the webhook handler's operation, `reconcile` against Stripe, the hledger and ledger exports, and support when a webhook or a renewal misbehaves.
- Do not price per event: the infrastructure cost is close to nothing (see above), and per-event pricing invites a comparison with Stripe's included 100M events a month.
- A hosted tier needs, at least: a backup and retention story for the log (`financial-reports.md`, "Keeping the folder"), the family-service integration done on the customer side, and an incident path for the 422 and 409 outcomes in `UPGRADING.md`.

## Decision: wait on usage events (2026-11-05)

Do not build usage events yet.

- The reference customer, B4 Uni, needs memberships, not metering; nothing on its list asks for usage events.
- The segment that does is the best served: Stripe bundles meters and Metronome sits behind them; Orb and Lago specialise in it. atm's edge, a strongly consistent wallet, matters only to a product that must answer "may this customer spend now" on every AI call, and the `track` spike found it needs per-customer batching to do that (`spikes/usage/03-track-spike.md`).
- Waiting is cheap: the three spikes, the mapping schema, the gateway write path and the cost arithmetic are in the repo, and the mapping spike estimated 7 to 9 days to build.

**Revisit when** one AI or API product commits as a design partner (or a customer asks for per-call credit spending with overage billed through Stripe meters), or when Stripe's own metering stops fitting a customer. If it is built, the order in `usage-metering.md` holds: the gateway writer and its dedupe rule, then the envelope and mapping edits, then the batched wallet; and overage must be made reportable first (`usage-metering.md`, spike 3).

**Build instead:** option A: the hosted service and the family-service integration (`ROADMAP.md`, "In `buzz-school`"), `reconcile` and the money lines, and the add-on-only refusal.

## Open questions

- The vendors' own current prices (Stripe Billing, Metronome, Lago Cloud, Flexprice, Polar, Orb, Autumn): look them up before quoting any of the figures above.
- Whether schools and clubs outside B4 Uni want this at all: nothing here is tested with a second customer.
- Who operates a hosted service and carries the incident load; the spikes measured throughput, not operations.
- The licence terms (above) before charging for a hosted derivative.
