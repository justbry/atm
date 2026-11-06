# Trifold business plan

Status: draft, 2026-11-06. Prices and projections are assumptions to test, not decisions.

Detail lives in the companion docs in this folder:

| Doc | What's in it |
|---|---|
| `pricing-strategy.md` | Tiers, pricing units, credits, features by tier, licensing |
| `market-research.md` | Competitor prices with sources, the first market, research gaps |
| `financial-model.md` | How to model 1–3 years with atm's scenario generator, what it lacks, and how to add expenses |
| `website-open-questions.md` | What must be decided or researched before the website can be built and launched |
| `../brand/trifold-brand-and-messaging.md` | Names, voice, website outline, customer profiles (PR #121) |

## 1. Summary

**Trifold** keeps the books for small businesses that bill through Stripe: memberships, usage, paid bookings, add-ons. Its engine, **Trivalance** (the `atm` package), builds the books from the payment events themselves. Every payment gets a signed receipt the customer keeps. Every closed month is sealed. Anyone can verify both with an open, free verifier.

The business is **open core**:
- The standard and the verifier are open.
- The engine is free to self-host.
- Customers pay for the hosted service, the Rifo agent, automation, and **Trifold acting as an independent witness**. The witness is the third entry in triple-entry accounting, and the premium tier.

The first market is microschools in Idaho and Utah. Families in state education programs need payment records that hold up, and Trifold already serves these schools through buzz-school.

## 2. Problem

- Small membership and booking businesses run on Stripe, spreadsheets and a bookkeeper. Closing a month is manual and slow.
- The books can be changed quietly, and nobody outside can tell.
- Families get a Stripe email, not a receipt that proves anything to a state program, an auditor or a court.
- Accounting software is getting more expensive. QuickBooks, Xero and FreshBooks all raised prices in 2026; QuickBooks caps users at every tier (`market-research.md`).

## 3. Solution

| Piece | What it does | Status |
|---|---|---|
| Books from events | Every Stripe event and booking becomes a ledger event, then a journal, reports and a Stripe reconciliation | Built (atm 0.9.0 and `dev`) |
| Signed receipts | Ed25519 receipt per payment and refund; regenerated from the books, so an edit shows | Built (milestone 1, #123 and #137) |
| Sealed months | A signed, chained seal per closed month | Built (milestone 1) |
| Pricing what-ifs | `atm simulate`: replay the books under new prices | Built |
| Rifo | Agent that closes the month and answers questions | Planned |
| Per-event chain | Hash chain over every event in the webhook transaction | Milestone 2 |
| Daily Stripe matching | Events matched to Stripe's balance transactions every day | Milestone 3 |
| Trifold witness | Trifold countersigns receipts and seals and logs them in a public transparency log | Planned (premium) |

**Claim rule.** Say "signed receipts and sealed books" until milestones 2 and 3 ship. Only then say "triple-entry accounting."

## 4. Customers

**First:** microschools and small private schools (about 10–150 families) that bill through Stripe, starting in Idaho and Utah.

**Next:** businesses with the same shape (memberships, credits, bookings): studios, tutoring, camps, gyms.

**Channels:**
- CPAs and bookkeepers, who get free auditor seats and a partner listing.
- Vertical software (Jackrabbit, Pike13 and Mindbody-style tools), which can embed Trifold through the Witness API.
- Developers, through the `tfd` CLI and a Stripe App.

Customer profiles and messaging: `../brand/trifold-brand-and-messaging.md`.

## 5. Product and open core

The rule: **anything a school can do on its own is open. Anything that needs Trifold as the trusted third party is paid.**

Never paywalled: verification, data export, erasure and privacy tools, security fixes, the standards.

Licensing (detail and alternatives in `pricing-strategy.md` section 8):
- Standard, verifier and SDKs: Apache-2.0.
- Engine: FSL-1.1-ALv2. Free to use and modify, no competing hosted service, becomes Apache-2.0 after two years.
- Cloud and witness: proprietary.
- A trademark policy reserves the names.

## 6. Pricing

| Tier | Price | In one line |
|---|---|---|
| Community | $0, self-hosted | The whole engine and CLI |
| Free | $0 cloud | 1,000 events and 200 credits a month |
| Starter | $29 | Signed receipts on top of QuickBooks or Xero |
| Pro | $79 | Replaces QuickBooks: Pricing Lab, daily reconcile, Rifo, unlimited seats |
| Witnessed | $149 | Trifold as witness, auditor portal, transparency log |
| Witnessed + Bookkeeper | ~$349 | A partner bookkeeper closes the month on provable books |
| Compliance pack | $15–30 per state program | Itemised receipts for state programs |
| Platform / Witness API | Metered | For networks and vertical software |

Tiers are limited by ledger events per month, plus credits for AI and witness signatures. Storage and compute are included. Full rate card, credit prices and reasoning: `pricing-strategy.md`.

## 7. Go-to-market

The plan is built for adoption. Three loops spread the product:
1. **Receipts carry a "Verify at trifold…" link.** Every payment a family makes shows them the product.
2. **Others adopt the standard.** Every platform that issues receipts in the format extends the verifier's reach and can buy the Witness API.
3. **CPAs refer clients.** Free auditor seats bring them in.

| Phase | When | Goal | What ships | Proof it worked |
|---|---|---|---|---|
| 0. Foundations | Now to month 3 | A credible standard | Spec v1 in its own repo, test vectors, verifiers in three languages; license split; domains and trademark filings; 5–10 design-partner schools | Design partners issuing real receipts |
| 1. Wedge | Months 3–9 | Win microschools in Idaho and Utah | Cloud Free, Starter and Pro; CPA partner pilot; Stripe App | 100 schools on cloud, 20 paying, ~10 CPA partners |
| 2. Premium | Months 9–18 | Make Witnessed real | Milestones 2 and 3, transparency log, Witness API; then the "triple-entry" claim | Witnessed is 25%+ of paying schools; 3 outside issuers |
| 3. Expand | Month 18+ | Adjacent verticals and platforms | Studios, tutoring, camps, gyms; embedded deals; tfd Tax | Platform revenue; net retention above 110% |

## 8. Financial outlook (illustrative)

These are assumptions, not forecasts. `financial-model.md` describes how to run this through atm's scenario generator and where it falls short.

**Assumed mix of paying schools:** 40% Starter, 35% Pro, 20% Witnessed, 5% bundle (counting only Trifold's ~$149 share of the bundle). That gives about $76 a school per month in subscription (0.40 × $29 + 0.35 × $79 + 0.20 × $149 + 0.05 × $149), plus a little credit-pack revenue that isn't recurring and is left out below (included credits are generous and overage is opt-in, so assume about $2–3). **Subscription revenue is about $76 a month per paying school.**

| | End of year 1 | End of year 2 | End of year 3 |
|---|---|---|---|
| Free cloud and self-hosted schools (adoption, not revenue) | 300 | 2,000 | 8,000 |
| Paying schools | 50 | 300 | 1,000 |
| Annual recurring revenue (paying × $76 × 12, before annual-billing discounts) | ~$46K | ~$275K | ~$910K |
| Platform and Witness API | — | small | 10–20% on top |

**Costs to model** (`financial-model.md`, "Expenses"):
- Stripe fees on Trifold's own revenue.
- AI tokens per credit used.
- Hosting: Workers and R2, small.
- Partner bookkeeper payouts on the bundle.
- Support.
- Legal: license, trademarks, witness terms, tax-prep partner contracts.
- People.

**Why schools upgrade:** for features (QuickBooks sync, Pricing Lab, Rifo, the witness), not limits. A family makes about 7 events a month, so Free's 1,000 events covers about 140 families.

**What would change the outlook most:** how many free schools convert to paid, whether Rifo can close a month reliably (that decides Witnessed's value), and how many platforms adopt the standard.

## 9. Moat, strongest first

1. The witness network and its transparency log. It can't be forked.
2. Owning the open standard.
3. The trademark.
4. Rifo and the workflows on top of the books.
5. The FSL license.

## 10. Risks

| Risk | How it's handled |
|---|---|
| License backlash | FSL with its 2-year conversion, decided now while there's one author; standard and verifier fully open |
| The "triple-entry" claim | Not used until milestones 2 and 3 ship |
| Tax preparation is regulated (paid preparers need an IRS PTIN) | File through licensed CPAs or enrolled agents; Trifold prepares the books, never signs returns |
| What the witness promises | Defined narrowly: "Trifold saw this exact record at time T," not "the money moved"; terms of service reviewed by a lawyer |
| Student data (FERPA, state privacy laws) | Checked per school type; personal data kept out of signed receipts, as it is today |
| Key compromise | Keys in a managed key service, a dated revocation list, old keys kept verifiable |
| Erasure breaks receipts | Owner decision before release (`packages/atm/ROADMAP.md`): keep personal data out of hashed fields, or delete keys instead of editing events |
| Trademark conflict | TRIBALANCE (Reg. 4374077, class 36) is the closest mark; clearance search before filing Trivalance in classes 9 and 42 |
| Competitors' deep discounts | Compete with the free core and provable books, not on price |

## 11. Next 90 days

1. Merge the brand kit (#121) and this plan.
2. Decide the engine license; add `LICENSE` files per package, `TRADEMARKS.md` and a CLA.
3. Register the domains; order a trademark clearance search.
4. Move the receipt and seal spec to its own repo with test vectors.
5. Recruit 5–10 design-partner schools; test prices with them.
6. Answer the open questions for the website, starting with its "decide first" list (`website-open-questions.md`).
7. Settle the open owner decisions in `packages/atm/ROADMAP.md`: erasure, key id format, refunds on receipts, disputes, when to seal.

## 12. Open decisions

1. Engine license: FSL (recommended) or Apache everywhere.
2. The paid line: is it only "Trifold as witness," or also Stripe matching or Rifo?
3. First market: microschools in Idaho and Utah, or broader membership businesses from the start.
4. Final prices, after design-partner tests.
