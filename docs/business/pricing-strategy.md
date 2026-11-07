# Trifold pricing strategy

Status: draft, updated 2026-11-06 after reviewing Airtight's pricing (section 9). All prices are starting points to test with design partners, not decisions. Market data and sources are in `market-research.md`. The plan this serves is `business-plan.md`.

## 1. The rule

**Anything a school can do on its own is free to self-host. Anything that needs Trifold to act as the trusted third party is paid.**

A receipt the school signs itself is a strong two-party record. An independent witness adds a third party's signature on top. A self-hosted fork can't produce Trifold's witness signature, so the premium tier protects itself without a strict license.

Paid tiers sell five things: automation and scheduling, teams and collaboration, AI, views across many schools, and Trifold as witness.

## 2. Never paywall

Keeping these free keeps trust, avoids a fork, and keeps the word "open" true:

1. Verifying receipts and seals, for anyone: families, CPAs, auditors.
2. Data export. The school owns its books.
3. Erasure and privacy tools.
4. Correctness and security fixes.
5. The standards: the receipt, seal and KPI specs.

## 3. Pricing units

| Unit | Fits the value? | Fits the cost? | Can the owner predict it? | Works outside schools? | Use |
|---|---|---|---|---|---|
| Per family or student | partly | partly | yes | no (gyms have members, studios clients) | Only as a translation on the pricing page |
| Storage (GB) | no | barely | no | yes | Free, with a fair-use cap |
| Compute | no | barely | no | yes | Free, with a fair-use cap |
| **Ledger events per month** | yes | yes | roughly, with an estimate at signup | yes | **The limit between tiers** |
| **AI credits** | yes | yes (token cost) | yes, with caps | yes | **Metered** |
| **Witnessed receipts and seals** | yes | ops and liability | yes, one per payment | yes | **Metered through credits** |
| % of payment volume | yes | no | yes | yes | Avoid: it stacks on Stripe's fees |
| Per seat | no | no | yes | yes | Unlimited seats |

**Why not storage or compute.** The golden-year fixture (`packages/atm/fixtures/vibes-year`) has one active family making 81 events a year, about 1.7 KB each, 139 KB a year. A 100-family school projects to about 700 events a month and 14 MB a year, which costs well under a cent a month to store on R2 at about $0.015/GB-month. Billing for that means pennies, or an arbitrary markup owners would notice. This is one fixture family; replace the estimate with real customer data.

## 4. The rate card

| Tier | Price | Limits | For whom | What's in it |
|---|---|---|---|---|
| **Community** | $0, self-hosted | None | Developers, technical schools | The whole engine and `tfd` CLI (the `atm` command until the rename lands), including `simulate` and `reconcile`. Self-signed receipts and seals |
| **Free** (cloud) | $0 | 1,000 events, 200 credits, 2 seats | First-time small schools | Hosted books, **signed receipts on every plan, even Free**, one Pricing Lab scenario a month |
| **Starter** | $29/mo | 5,000 events, 1,000 credits, 5 seats | Businesses keeping QuickBooks or Xero | **Sync to QuickBooks or Xero**, signed receipts on top of the books they already have |
| **Pro** | $79/mo | 25,000 events, 5,000 credits, unlimited seats, **up to 3 organizations** | Stripe-native businesses ready to replace QuickBooks; small school networks and fiscal sponsors | Pricing Lab, daily reconcile with alerts, scheduled close, **bank-statement import (CSV/OFX)**, multi-user ledger UI with roles and CPA seats, Rifo |
| **Witnessed** | $149/mo | 25,000 events, 8,000 credits | Schools that need provable books (state programs, audits, investors) | Pro, plus Trifold's countersignature, the transparency log, the per-event chain, daily Stripe matching, the auditor portal |
| **Witnessed + Bookkeeper** | ~$349/mo | As Witnessed | Owners who want the month closed for them | A partner bookkeeper does the close, on provable books |
| **Compliance pack** | $15–30/mo per state program | | Schools in state education programs | Itemised receipts for that program, kept current as the rules change |
| **Platform / Enterprise** | Metered or custom | | School networks, franchises, vertical software | Rollups across schools, network revenue share, SSO/SAML, SLA, embedding rights |
| **Witness API** | First 500 receipts a month free, then $0.03–0.05 each | | Self-hosters and platforms | The witness alone |

**No per-seat fees. No per-transaction fees. No surprise bills.** This is the line on the pricing page; Airtight leads with the same promise ("Pricing you can actually read"), so our pricing has to read at least as simply.

Over the event limit: the event limit is a **soft limit** on Free, Starter, Pro and Witnessed. The books never stop and nothing is billed automatically; after two months over, the owner is asked to move up a tier. Platform pays about $1 per 10,000 events. (This replaces the earlier $2 per 10,000 overage: a metered overage contradicts "no surprise bills" and would cost more in trust than it earns.)

**What the pricing page shows.** Cards show the plan, its features and "about N families". Events and credits appear only in the comparison matrix and the FAQ. Developers and platforms see the metered view.

Annual billing: two months free (Starter $290/yr, Pro $790/yr, Witnessed $1,490/yr).

**Included credits and margin.** Included credits are a cost if they're used: 8,000 credits is $80 at face value on a $149 plan. Price credits so AI token cost stays under about a third of their face value, and watch actual use per tier.

### Why these prices (summary of `market-research.md`)

- **Starter at $29** fills the gap between $0 and $79. Most businesses keep QuickBooks ($38) or Xero ($27) at first and need a cheap tier that adds to their books instead of replacing them.
- **Pro at $79** sits just under QuickBooks Essentials ($85, 3 users) and near Digits ($65) and Puzzle Core ($60), with unlimited seats. It has to replace QuickBooks; stacked on top, the total is $117–164.
- **Witnessed at $149**, down from a first draft of $199. At $199 it was priced like Pilot's service ($199) without a human behind it, and $50–100 above Digits Pro and Puzzle Complete.
- **The bookkeeper bundle at ~$349** undercuts human bookkeeping ($349–849+) and the books are provable. Most of it passes through to the partner, so count only Trifold's share as revenue.
- **Against Airtight** (section 9): their AUD $49 / $99 / $199 plans are roughly US$32 / $65 / $130. Pro at $79 and Witnessed at $149 sit a little above, which the free tier, non-profit pricing, Stripe-native books and payer-held receipts justify. Don't cut prices to match.

## 4a. Billing policies

Published on the pricing page and in the FAQ. Airtight publishes the same set, and owners now expect it.

| Policy | Rule |
|---|---|
| Refunds | Full refund within 30 days of the first paid charge |
| Cancelling | Two clicks in settings; no retention call or email |
| Plan changes | Any time. Upgrades are prorated to the day; downgrades credit the next invoice |
| Onboarding | Included on every paid plan; no setup fee |
| Data on leaving | Export everything, in open formats, before and after cancelling (export is never paywalled, section 2) |
| Annual billing | Two months free (about 17% off) |

## 4b. Non-profits and co-ops

Verified 501(c) organizations (IRS determination letter or EIN check) and cooperatives (articles or bylaws) pay about half:

| Tier | Standard | Non-profit / co-op |
|---|---|---|
| Starter | $29 | $15 |
| Pro | $79 | $39 |
| Witnessed | $149 | $79 |
| Witnessed + Bookkeeper | ~$349 | ~$249 |

- Non-profits with gross receipts of $50,000 or less get Witnessed free on the Free plan (up to about 200 witnessed receipts a month), once the witness ships.
- Donation acknowledgments use no credits; board, member and auditor seats are unlimited.
- Add-on packs ($15–25/mo): the non-profit pack (donation acknowledgments, restricted funds, grant reports, a Form 990 package) and the co-op pack (member capital accounts, patronage allocation, 1099-PATR export).
- The annual discount stacks with the non-profit price (to decide; the draft pricing page stacks them).
- Airtight has no non-profit pricing; this is a clear difference.

## 4c. Accounting firms

Published rule, not case-by-case discounts (Airtight sets firm discounts by hand):
- The firm's own seats are free and unlimited on every client's books.
- Clients a firm brings get 20% off their first year (to test).
- A partner directory, with a stated policy that Trifold pays no referral fees to tax preparers, matching the disclosure Airtight publishes.

## 5. Credits

1 credit = $0.01. Unused credits roll over for one month, then expire. tfd's own rollover and expiry rules can run this.

| Action | Credits | Why |
|---|---|---|
| Rifo question or explanation | 2–10 | Passes on the token cost with margin |
| Rifo monthly close (categorize, reconcile, write the summary) | 500–1,500 | Replaces hours of bookkeeper time; still far below a service |
| Pricing Lab forecast or scenario run | 25 | Replays a year of events and forecasts |
| Witnessed receipt | 3 | The viral object: kept cheap on purpose |
| Witnessed month seal | 25 | |
| Self-signed receipt, seal, `verify`, CLI `simulate` | **0, always** | Free to self-host; format and verifier are Apache-2.0 |

### Rules that make credits safe for small businesses

1. **Running out never stops the books.** Payments still book, journals still build, receipts are still self-signed. Only Rifo and new witness signatures pause. Receipts made while out of credits are witnessed once credits return, and the transparency log shows the later time honestly.
2. **A hard cap by default**, with alerts at 80% and 100%. Overage is opt-in, so there are no surprise bills.
3. **Estimates at signup:** "A school with about 50 families makes about 350 events a month, and Free covers it."
4. **School owners see a flat plan.** Events and credits stay in the background, with defaults that rarely run out. Developers and platforms see pure usage.

## 6. Features by tier

Free is the Community column, hosted, within Free's limits. Starter is Free plus the QuickBooks and Xero sync and higher limits.

| Feature (what exists in tfd today) | Community | Pro | Witnessed | Platform |
|---|---|---|---|---|
| Billing engine: credits, plans, bookings, codes, membership status, deduction order | ✅ all | | | |
| Event log, `ship`, stored inputs, `inputs ship` | ✅ | Managed storage, backups, retention | | Data residency |
| `journal` (hledger), `report` | ✅ | Scheduled monthly close, CPA package | | Consolidation across schools |
| `reconcile` (Stripe matching) | ✅ on demand | Daily automatic run plus alerts | Matches enter the witnessed record | |
| `simulate`, both modes | ✅ | **Pricing Lab** (section 7) | | Network-wide pricing tests |
| `scenarios`, KPI spec, parity, parquet export | ✅ (the KPI spec is part of the open standard) | KPI dashboards; anonymous benchmarks against peer schools | | Network rollup |
| `share` (revenue-share statement) | ✅ | | | Network revenue-share billing |
| Receipts, seals, `verify` | ✅ self-signed | | Trifold countersignature, transparency log, per-event chain, auditor portal | White-label verify page |
| Ledger UI | Single-user, read-only viewer | Multiple users, roles, CPA seats, approvals | Auditor role | SSO, audit log |
| Rifo agent | Small monthly quota | ✅, with approval modes: **Off**, **Ask first** (default) and **Auto within limits**. Rifo drafts, you approve, the engine does the math | | Custom agents and API |
| Bank-statement import (CSV/OFX) | CLI import | ✅ hosted, with matching rules | | |
| Organizations per account | 1 | Up to 3 | | Unlimited, with consolidation |
| Erasure and privacy tools | ✅ never paywalled | | | |
| State program receipts | | Compliance packs | | |
| QuickBooks and Xero | CSV and hledger export | Managed sync (also in Starter) | | |

**SSO:** charging extra for single sign-on is widely criticized as an "SSO tax." Basic Google sign-in goes in Pro; SAML stays in Platform.

## 7. Pricing Lab: what `simulate` becomes in Pro

The `simulate` engine and CLI stay free. They were already published under Apache-2.0, they're a strong developer hook (exit code 1 lets CI block a pricing change), and they run on the core billing engine. Pro sells what the CLI can't do:

| Free `simulate` | Paid Pricing Lab |
|---|---|
| Replays the past under a new menu or deduction order | Forward forecast: next quarter's revenue and credit liability under new prices, with churn and price-response assumptions |
| What-if on grant rules from stored inputs (`--inputs`) | Saved scenarios side by side, shareable with an owner or board |
| JSON diff and exit codes | Visual diff: which families pay more or less, by month |
| USD totals fixed (Stripe's charges can't be replayed) | Revenue impact estimate under the new menu |
| A developer runs it locally | Rifo suggests and explains prices |
| A developer wires up the CI gate | Hosted GitHub check; staged rollout from a date, or to new families only |

## 8. Licensing that supports the pricing

Decided by the owner on 2026-11-06. `justbry/atm` is a public fork of Autumn under Apache-2.0. Every version published so far stays Apache-2.0 for good; a change applies only to future versions. Autumn-derived code keeps its Apache license and notices. All tfd code so far has one author, so changing the license now is easy. The full table and reasoning are in `business-plan.md` section 5.

| Part | License |
|---|---|
| tfd engine and CLI (`packages/atm`, except the parts below) | **FSL-1.1-ALv2** (Functional Source License 1.1, Apache-2.0 future license). Free to use, modify and self-host for your own books, for non-commercial education and research, and for professional services to a licensee. Not allowed: offering it to others as a commercial product or service that competes with Trifold. Each release becomes Apache-2.0 two years after it ships |
| Receipt and seal format, spec and verifier (schemas, `docs/receipts.md`, receipt, seal, sign and canonicalisation code, the website's in-browser verifier) | **Apache-2.0** |
| Test vectors (golden receipt files) | **CC0-1.0** (public domain) |
| Autumn code this repo forks (`balance-engine`, `shared`, and so on) | **Apache-2.0** (upstream license, unchanged) |
| Hosted Trifold service, Rifo, the witness | Proprietary (a service; the code is never distributed) |
| Names | Trademark policy: "Trifold" and "Witnessed by Trifold" are reserved; a fork may say it is based on tfd but may not use the Trifold names |

**Open items:** contributor terms (DCO or CLA) before accepting outside contributions; whether the event envelope schema should also be Apache-2.0; whether accounting firms hosting tfd for many clients need a grant beyond FSL's professional-services clause.

**Claim rule.** An FSL engine can't be called "open source." Say "source-available," "Fair Source" or "free to self-host." "Open format," "open spec," "open standard" and "open verifier" are fine, because those parts are Apache-2.0.

**Why FSL and not Apache everywhere.** Apache everywhere would give the most adoption and the least protection. The hosted engine is what a cheap competitor would copy, so the engine carries FSL. Checking stays unrestricted because the format, verifier and vectors are Apache-2.0 or CC0. Each release turns Apache-2.0 after two years, which backs the promise that the code stays available if Trifold disappears.

| License | Internal use | Competitor can host? | OSI open source? | Opens up later? | Track record |
|---|---|---|---|---|---|
| Apache-2.0 / MIT | yes | yes | yes | n/a | Maximum adoption, no protection |
| AGPL-3.0 + commercial | yes | yes, must publish changes | yes | n/a | Grafana, Plausible. Many company lawyers ban AGPL |
| **FSL-1.1 (chosen for the engine)** | yes | no | no ("Fair Source") | Apache or MIT after 2 years (Apache here) | Sentry and others; low backlash |
| BSL 1.1 | yes, within its usage grant | per the grant | no | after up to 4 years | MariaDB, HashiCorp (whose 2023 switch led to the OpenTofu fork) |
| Elastic License 2.0 | yes | no managed service | no | never | Elastic |
| SSPL | yes | only if the whole stack is published | no | never | MongoDB; seen as hostile |

## 9. What Airtight's pricing taught us

Airtight (airtight.one) sells triple-entry accounting with Ed25519 receipts to Australian and Gulf-region businesses, with an AI assistant, Bella. Reviewed 2026-11-06 from its own pricing and home pages; its claims aren't independently verified.

| Plan (AUD/mo) | Foundation $49 | Plus $99 | Scale $199 | Enterprise $499+ |
|---|---|---|---|---|
| Unit | 1 entity | 3 entities, payroll for 5 | 10 entities, payroll for 50, read-only auditor access | Unlimited entities |

No free tier or trial; 17% off annual; no seat or transaction fees; $0 auditor seats; firm discounts set by hand; 30-day refund; two-click cancel.

**Adopted here:** the "no seat fees, no transaction fees" promise (section 4), soft event limits instead of overage, published billing policies (4a), approval modes for Rifo (section 6), bank-statement import and up to 3 organizations in Pro, a published accounting-firm rule (4c).

**Where Trifold differs, and says so on comparison pages:**
- Airtight signs a receipt for each entry it posts, kept in its own system. Trifold gives the signed receipt to **the person who paid**, so both sides hold the record, and anyone can check it with a free verifier and an open format.
- A free hosted plan and a self-hostable engine; Airtight has neither.
- Signed receipts on every plan, even Free; Airtight's cheapest plan is about US$32 a month.
- Auditor seats free on every hosted plan; Airtight includes auditor access from Scale ($199 AUD).
- Non-profit and co-op pricing; Airtight has none.
- Stripe-native and US-first; Airtight is bank-feed-first in Australia and the Gulf.

**What it costs us:** Airtight already says "triple-entry" and claims a SHA-256 hash chain. Trifold doesn't use the term at all. Milestones 2 and 3 still matter, because they back the hash-chain claim.

Sources: https://airtight.one/pricing/ and https://airtight.one/

## 10. Risks

- **Stack fatigue.** Pro only wins if it replaces QuickBooks. Starter's sync is the bridge while Pro proves it can replace them.
- **Witnessed needs Rifo to close reliably.** Until it does, the bookkeeper bundle carries the premium value.
- **The "triple-entry" claim.** Never use it for Trifold. Say "signed receipts and sealed books" until the per-event chain and daily Stripe matching ship (milestones 2 and 3).
- **Credit confusion.** Mitigated by flat plans, hard caps and generous defaults (section 5).

## 11. Open decisions

1. ~~Engine license~~ Decided 2026-11-06: FSL-1.1-ALv2 for the engine, Apache-2.0 for the format and verifier, CC0-1.0 for vectors (section 8). Still open: the licensor legal entity name (the LICENSE says "Trifold" until a company is formed); whether accounting firms hosting tfd for many clients need an extra grant (decide before the accountant partner program); contributor terms (DCO or CLA); whether the event envelope schema should also be Apache-2.0.
2. Is "Trifold as witness" the paid line, or are Stripe matching or Rifo also paid-only?
3. Final prices, after testing with the design-partner schools.
4. Whether the annual and non-profit discounts stack.
5. The accounting-firm client discount (20% for the first year is a placeholder).
