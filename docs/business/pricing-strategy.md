# Trifold pricing strategy

Status: draft, 2026-11-06. All prices are starting points to test with design partners, not decisions. Market data and sources are in `market-research.md`. The plan this serves is `business-plan.md`.

## 1. The rule

**Anything a school can do on its own is open. Anything that needs Trifold to act as the trusted third party is paid.**

A receipt the school signs itself is a strong two-party record. The third entry in triple-entry accounting is an independent witness. A self-hosted fork can't produce Trifold's witness signature, so the premium tier protects itself without a strict license.

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
| **Community** | $0, self-hosted | None | Developers, technical schools | The whole engine and `tfd` CLI, including `simulate` and `reconcile`. Self-signed receipts and seals |
| **Free** (cloud) | $0 | 1,000 events, 200 credits, 2 seats | First-time small schools | Hosted books, self-signed receipts, one Pricing Lab scenario a month |
| **Starter** | $29/mo | 5,000 events, 1,000 credits | Businesses keeping QuickBooks or Xero | **Sync to QuickBooks or Xero**, signed receipts on top of the books they already have |
| **Pro** | $79/mo | 25,000 events, 5,000 credits, unlimited seats | Stripe-native businesses ready to replace QuickBooks | Pricing Lab, daily reconcile with alerts, scheduled close, multi-user ledger UI with roles and CPA seats, Rifo |
| **Witnessed** | $149/mo | 25,000 events, 8,000 credits | Schools that need provable books (state programs, audits, investors) | Pro, plus Trifold's countersignature, the transparency log, the per-event chain, daily Stripe matching, the auditor portal |
| **Witnessed + Bookkeeper** | ~$349/mo | As Witnessed | Owners who want the month closed for them | A partner bookkeeper does the close, on provable books |
| **Compliance pack** | $15–30/mo per state program | | Schools in state education programs | Itemised receipts for that program, kept current as the rules change |
| **Platform / Enterprise** | Metered or custom | | School networks, franchises, vertical software | Rollups across schools, network revenue share, SSO/SAML, SLA, embedding rights |
| **Witness API** | First 500 receipts a month free, then $0.03–0.05 each | | Self-hosters and platforms | The witness alone |

Over the event limit: Free gets a read-only warning (the books never stop); Starter, Pro and Witnessed pay $2 per extra 10,000 events. Platform pays about $1 per 10,000.

Annual billing: two months free (Starter $290/yr, Pro $790/yr, Witnessed $1,490/yr).

**Included credits and margin.** Included credits are a cost if they're used: 8,000 credits is $80 at face value on a $149 plan. Price credits so AI token cost stays under about a third of their face value, and watch actual use per tier.

### Why these prices (summary of `market-research.md`)

- **Starter at $29** fills the gap between $0 and $79. Most businesses keep QuickBooks ($38) or Xero ($27) at first and need a cheap tier that adds to their books instead of replacing them.
- **Pro at $79** sits just under QuickBooks Essentials ($85, 3 users) and near Digits ($65) and Puzzle Core ($60), with unlimited seats. It has to replace QuickBooks; stacked on top, the total is $117–164.
- **Witnessed at $149**, down from a first draft of $199. At $199 it was priced like Pilot's service ($199) without a human behind it, and $50–100 above Digits Pro and Puzzle Complete.
- **The bookkeeper bundle at ~$349** undercuts human bookkeeping ($349–849+) and the books are provable. Most of it passes through to the partner, so count only Trifold's share as revenue.

## 5. Credits

1 credit = $0.01. Unused credits roll over for one month, then expire. atm's own rollover and expiry rules can run this.

| Action | Credits | Why |
|---|---|---|
| Rifo question or explanation | 2–10 | Passes on the token cost with margin |
| Rifo monthly close (categorize, reconcile, write the summary) | 500–1,500 | Replaces hours of bookkeeper time; still far below a service |
| Pricing Lab forecast or scenario run | 25 | Replays a year of events and forecasts |
| Witnessed receipt | 3 | The viral object: kept cheap on purpose |
| Witnessed month seal | 25 | |
| Self-signed receipt, seal, `verify`, CLI `simulate` | **0, always** | Open core |

### Rules that make credits safe for small businesses

1. **Running out never stops the books.** Payments still book, journals still build, receipts are still self-signed. Only Rifo and new witness signatures pause. Receipts made while out of credits are witnessed once credits return, and the transparency log shows the later time honestly.
2. **A hard cap by default**, with alerts at 80% and 100%. Overage is opt-in, so there are no surprise bills.
3. **Estimates at signup:** "A school with about 50 families makes about 350 events a month, and Free covers it."
4. **School owners see a flat plan.** Events and credits stay in the background, with defaults that rarely run out. Developers and platforms see pure usage.

## 6. Features by tier

Free is the Community column, hosted, within Free's limits. Starter is Free plus the QuickBooks and Xero sync and higher limits.

| Feature (what exists in atm today) | Community | Pro | Witnessed | Platform |
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
| Rifo agent | Small monthly quota | ✅ | | Custom agents and API |
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

`justbry/atm` is a public fork of Autumn under Apache-2.0. Every published version stays Apache-2.0 for good; a change applies only to future versions. Autumn-derived code keeps its Apache license and notices. All atm code so far has one author, so changing the license now is easy. Decide before accepting outside contributions.

| Layer | License |
|---|---|
| Open standard (receipt, seal and KPI specs, schemas, test vectors) | Apache-2.0, spec text CC-BY-4.0, with a patent pledge (Open Web Foundation agreement) |
| Verifier and SDKs | Apache-2.0 |
| Core engine (atm) | **FSL-1.1-ALv2** (Functional Source License): use and modify freely, including internally; no competing hosted service; each version becomes Apache-2.0 after two years |
| Cloud, Witness, enterprise code | Proprietary (a service; the code is never distributed) |
| Names | Trademark policy: "Trifold", "Trivalance" and "Witnessed by Trifold" are reserved; forks must rename |
| Contributions | CLA for the engine; DCO for the spec and verifier |

**Claim rule.** An FSL engine can't be called "open source." Say "open standard, open verifier, fair-source engine."

**The alternative** is Apache everywhere, with the witness network and the trademark as the moat. That gives the most adoption and the least protection. FSL is recommended because the hosted engine is what a cheap competitor would copy.

| License | Internal use | Competitor can host? | OSI open source? | Opens up later? | Track record |
|---|---|---|---|---|---|
| Apache-2.0 / MIT | yes | yes | yes | n/a | Maximum adoption, no protection |
| AGPL-3.0 + commercial | yes | yes, must publish changes | yes | n/a | Grafana, Plausible. Many company lawyers ban AGPL |
| FSL-1.1 | yes | no | no ("Fair Source") | Apache or MIT after 2 years | Sentry and others; low backlash |
| BSL 1.1 | yes, within its usage grant | per the grant | no | after up to 4 years | MariaDB, HashiCorp (whose 2023 switch led to the OpenTofu fork) |
| Elastic License 2.0 | yes | no managed service | no | never | Elastic |
| SSPL | yes | only if the whole stack is published | no | never | MongoDB; seen as hostile |

## 9. Risks

- **Stack fatigue.** Pro only wins if it replaces QuickBooks. Starter's sync is the bridge while Pro proves it can replace them.
- **Witnessed needs Rifo to close reliably.** Until it does, the bookkeeper bundle carries the premium value.
- **The "triple-entry" claim.** Don't use it until the per-event chain and daily Stripe matching ship (milestones 2 and 3). Until then, say "signed receipts and sealed books."
- **Credit confusion.** Mitigated by flat plans, hard caps and generous defaults (section 5).

## 10. Open decisions

1. Engine license: FSL (recommended) or Apache everywhere?
2. Is "Trifold as witness" the paid line, or are Stripe matching or Rifo also paid-only?
3. Final prices, after testing with the design-partner schools.
