# Trifold market research

Status: research notes, 2026-11-06. This collects the market data behind `pricing-strategy.md` and `business-plan.md` (both in this folder).

**How reliable the numbers are.** Most prices come from third-party aggregators, not from the vendors' own pages, and some sources disagree. Treat a figure as accurate to within a few dollars. Recheck the vendor's own page before publishing any comparison. Where sources conflict, the table gives the most recent figure and says so in a note.

## 1. Who Trifold competes with

Trifold sits between four groups. None of them offers books a third party can verify.

| Group | What customers buy it for | How it prices | Where Trifold fits |
|---|---|---|---|
| General accounting software | Books, invoices, tax-time reports | Flat tiers capped by users or features | Replace it for Stripe-native businesses (Pro), or feed it (Starter) |
| AI-native accounting | Books kept automatically, few seats | Flat tiers, no per-user fee | Same buyers. Trifold adds a source-available engine (free to self-host) and provable books |
| Bookkeeping services | Someone else closes the month | Monthly fee that rises with expenses | Witnessed + Bookkeeper bundle, sold through partners |
| Vertical software for schools and studios | Scheduling, enrollment, billing | Per student, or tiers | Partner and embed (Witness API). They run operations; Trifold keeps the books |

## 2. Prices, November 2026

### General accounting

| Product | Monthly list price | Notes | Source |
|---|---|---|---|
| QuickBooks Online | $38 / $85 / $140 / $340 | Simple Start, Essentials, Plus, Advanced. Raised for renewals from Aug 1 2026 (Essentials $75 to $85, Plus $115 to $140, Advanced $275 to $340). Hard user caps of 1 / 3 / 5 / 25. Payroll is extra. Introductory offers of about 50% off fade after a few months | [NerdWallet](https://www.nerdwallet.com/business/software/learn/quickbooks-pricing), [Dancing Numbers](https://www.dancingnumbers.com/how-much-is-quickbooks-online-per-month/) |
| Xero (US) | $27 / $59 / $97 | Early, Growing, Established, from Oct 1 2026 (were $25 / $55 / $90). Some aggregators show older, lower figures. Has run 90%-off-for-6-months offers | [Xero update](https://www.xero.com/us/pricing-plans/update/), [saascrmreview](https://saascrmreview.com/xero-review/) |
| FreshBooks | $23 / $43 / $70 | Raised Jan 27 2026 | [agentdeals](https://agentdeals.dev/accounting-software-pricing-2026) |
| Wave | Free / Pro $19 | Automatic bank imports moved from free to Pro | [agentdeals](https://agentdeals.dev/accounting-software-pricing-2026) |
| Zoho Books | Free (under $50K revenue) / Standard $15–20 | Free includes one user and one accountant seat | [agentdeals](https://agentdeals.dev/accounting-software-pricing-2026) |

### AI-native accounting

| Product | Monthly price | Notes | Source |
|---|---|---|---|
| Puzzle | ~$25 / $60 / $120 / $360 | Starter, Core, Complete, Scale. The free Starter promotion ended Sep 2026. Software plus a partner bookkeeper from $171 (up to $10K monthly expenses) | [Puzzle pricing FAQ](https://help.puzzle.io/en/articles/8891734-faq-pricing), [usagepricing](https://www.usagepricing.com/blueprint/activity/puzzle-2026-09-20-promo-ends-free-starter-removed) |
| Digits | $65 / $100 / Pro ~$250 | Essentials, Core, Pro (quoted). No per-user fee. Firms get per-client rates | [Digits pricing](https://www.digits.com/pricing), [softwarefinder](https://softwarefinder.com/accounting-software/digits) |

### Bookkeeping services

| Product | Monthly price | Notes | Source |
|---|---|---|---|
| Pilot | $199 entry; $99 AI-only; human-led $349–849+ | QuickBooks is required and billed separately. Onboarding fee about one month | [Capterra](https://www.capterra.com/p/186313/Pilot/pricing/), [Eightx](https://eightx.co/blog/compare/how-much-does-pilot-cost) |

### Vertical software for schools, studios and tutoring

| Product | Monthly price | Notes | Source |
|---|---|---|---|
| Jackrabbit Class | $49–245 | **By student count** at month end (0–100, 101–250, 251–500, 501–1,000, more) | [Jackrabbit](https://www.jackrabbitclass.com/pricing), [G2](https://www.g2.com/products/jackrabbit-class/pricing) |
| Pike13 | $139–249 | Essential, Advanced, Premium. No annual billing | [Pike13](https://www.pike13.com/pricing) |
| Mindbody | ~$99–349+ | Payment processing and marketplace fees on top | [G2 compare](https://www.g2.com/compare/mindbody-vs-pike13) |
| Teachworks | $16.49 + $0.32 per student lesson | Tutoring and lesson businesses | [ustechautomations](https://ustechautomations.com/resources/blog/brightwheel-alternatives-for-tutoring-businesses-2026) |
| Brightwheel | Not public | Childcare. Card processing 2.9% + $0.30 | [pebbledesk](https://pebbledesk.pages.dev/compare/pricing/brightwheel) (a competitor's page) |

### Stripe

| Product | Price | Notes | Source |
|---|---|---|---|
| Stripe Billing | 0.7% of billing volume | Pay-as-you-go. Replaced the 0.5% and 0.8% tiers in 2024 | [Stripe support](https://support.stripe.com/questions/july-2024-changes-to-stripe-billing) |
| Stripe Revenue Recognition | 0.25% of volume | Whether it is still charged separately in 2026 is unconfirmed | [Stripe docs](https://docs.stripe.com/revenue-recognition/pricing) |

### Open-source accounting

| Product | License | Hosted price | Source |
|---|---|---|---|
| Akaunting | Open source | Self-host free; cloud $12 / $36 / $84 / $218 | [toolradar](https://toolradar.com/tools/akaunting/pricing) |
| Bigcapital | AGPL-3.0 | ~$20 | [gappsy](https://gappsy.com/tools/bigcapital/) |
| ERPNext / Frappe Cloud | GPL-3.0 (one source says MIT) | ~$10–50 per site (unconfirmed) | [ecosire](https://ecosire.com/blog/erpnext-pricing-explained-2026) |

### AI priced per outcome

| Product | Price | Source |
|---|---|---|
| Intercom Fin | $0.99 per resolution; $49/mo base with 50 resolutions when run on another help desk | [sitegpt](https://sitegpt.ai/blog/intercom-fin-ai-review) |

## 3. What the data says

1. **Prices are rising.** QuickBooks, Xero and FreshBooks all raised prices in 2026, and Puzzle dropped its free tier. A free core, a flat price and unlimited seats stand out right now.
2. **User caps hurt.** QuickBooks caps users at every tier, so a school that adds its CPA or a second admin has to upgrade. Unlimited seats is a selling point.
3. **This vertical prices per student.** Jackrabbit charges by student count and Teachworks per lesson, so owners understand per-student pricing. Trifold meters ledger events underneath but can say "for schools up to about 100 students" on its pricing page.
4. **Owners pay the most for having it done.** Human bookkeeping costs $349–849+ a month, against $60–140 for software. The money is in closing the month, so Rifo's close and the bookkeeper bundle are where premium pricing works.
5. **Nobody offers provable books.** None of the products above offers signed receipts, sealed months or an independent witness. That's Trifold's opening, and the reason vertical tools are partners rather than competitors.
6. **Discounts are common.** Xero and QuickBooks lead with deep introductory offers. Trifold shouldn't race them on discounts; it competes with a free core and with provable books.

## 4. Why the first market is microschools in Idaho and Utah

- Trifold already serves these schools through buzz-school and b4uni, which gives it design partners and real data.
- Families using state programs such as Idaho's parental choice tax credit or Utah Fits All need payment records that hold up. **Check each program's current receipt rules before building on this.** The itemised-receipt questions are open in `packages/atm/docs/receipts.md`.
- Microschools run on Stripe and spreadsheets and usually pay a bookkeeper. That's the exact problem Trifold solves.

## 5. Gaps in this research

- **Market size.** Not researched here: how many microschools, studios and tutoring businesses there are, and how many use Stripe. Do a bottom-up count by state before raising money.
- **Willingness to pay.** No customer interviews yet. Test the price points with the 5–10 design-partner schools.
- **State program rules.** The receipt requirements for each state program need checking from primary sources.
- **Competitors' AI pricing.** How Digits and Puzzle meter AI, if they do, wasn't found.
