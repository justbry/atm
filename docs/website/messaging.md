# Trifold messaging and positioning

Status: draft, round 2, 2026-11-06. Round 1 reviews: `reviews/round-1-sonnet.md` (conversion, GTM) and `reviews/round-1-fable.md` (brand, narrative, motion). What changed and why: `decisions.md`.

Names, voice and claim rules come from `docs/brand/trifold-brand-and-messaging.md` (PR #121). Prices come from `docs/business/pricing-strategy.md` (PR #140).

## 1. The question we lead with

Owners want AI to do their books but don't trust it with money. Intuit's 2026 AI Impact Report found bookkeeping trails other uses of AI because owners name privacy, accuracy and trust as the top barriers; Simply Business's 2026 outlook found trust drops as the stakes rise.

On the homepage we don't quote the stat. We ask the question: **"AI can do your books. How would you know it did them right?"** The stat lives on `/trust`.

## 2. Positioning

For schools and membership businesses that take payments through Stripe, **Trifold** keeps books that show their work: every payment becomes a receipt the payer can check, every month is sealed, and the records outlive any app, including ours. Most finance software asks you to trust it. Trifold lets anyone check it, with an open standard and a free verifier.

- **Category label:** provable books. Used as a label and in technical copy. In plain copy say "books anyone can check".
- **What we own that rivals don't** (Airtight already claims "triple-entry" and Ed25519): *who* can check (anyone, free, no account) and *for how long* (open formats, a self-hostable engine, seals that verify after we're gone).

## 3. Core message

| Slot | Copy |
|---|---|
| Eyebrow | For schools and membership businesses on Stripe |
| Headline | **Books that show their work.** |
| Subhead | Every payment becomes a receipt your families can check. Every month is sealed. And the records outlive any app, including ours. |
| Primary CTA | **Get early access** (design-partner program: founder onboarding, free during the pilot) |
| Secondary CTA | **Verify a sample receipt** |
| Developer CTA | **Install the CLI, free** (the only "free" button; it's true today) |
| Tagline | Three sides of every dollar. |
| Closing line | Every dollar, three ways. Every month, sealed. |

Headline alternatives kept for testing: "Don't trust the books. Check them." · "Signed, sealed, checkable." · "Proof, not promises."

## 4. Four kinds of trust

The owner's direction: trust means **durable, fast and resilient**, and on top of all three, **provable**. Each claim uses only what exists today. Each is folded into the homepage chapter that proves it, not shown as a separate card grid.

| Trust | Promise | Proof that exists today | Homepage chapter |
|---|---|---|---|
| **Durable** | Your books outlive any app, including ours | Append-only events; write-once batches; export to Parquet, hledger, CSV; the engine is free to self-host | 02 Books |
| **Provable** | Anyone can check any number, without asking us | Signed receipts; sealed months; free verifier; open spec | 03 Proof |
| **Resilient** | Lose everything but the events and rebuild it all, exactly | Replay rebuilds balances and journals byte-for-byte; seals still verify after a key rotation | 03 Proof |
| **Fast** | A year of books rebuilt in seconds | Replay and Pricing Lab run a year of events locally in seconds; the month-close by Rifo is marked Next | 04 Close |

The sentence to carry everywhere: **"Not even Trifold can quietly change your books."** It's true of what's shipped: receipts are held by payers and seals chain month to month.

Low cost appears only as a fact on the pricing page.

## 5. One story: money in to finance

The homepage, the roadmap and the product all follow the same six chapters. **Lit** chapters are shipped. **Ember** is next. **Outlined** is later. The visual staging is the honesty.

| # | Chapter | What | State |
|---|---|---|---|
| 01 | **Money in** | Stripe payments, tuition, memberships, credits, bookings arrive as events | Lit |
| 02 | **Books** | Each event becomes balanced double-entry books, append-only and replayable; open formats | Lit |
| 03 | **Proof** | A signed receipt for every payment; a sealed month; a free verifier | Lit |
| 04 | **Close** | Rifo reconciles, explains and closes the month; daily matching to Stripe payouts; Trifold as independent witness | Ember (Next) |
| 05 | **Taxes** | Tax-ready packages for your CPA; donation acknowledgments; 1099 exports | Outlined (Later) |
| 06 | **Finance** | Your own finance warehouse: open tables you query with SQL; cash forecasts; agents for payables and receivables | Outlined (Later) |

**Rifo** never computes a number. The deterministic engine computes; Rifo reads, explains and proposes, and always cites the events behind an answer.

**The warehouse**, in our words: "your financial history in open tables that last". Durable object storage, open formats (Parquet, Iceberg), SQL, no lock-in. Never "cheap storage".

## 6. Who can check

The human version of the trust story. One line each, same Verify button.

- **A parent at tax time** checks the tuition receipt their state program asked for.
- **A treasurer before the board meeting** shows a sealed month instead of a spreadsheet.
- **A CPA in January** traces every number to the payment behind it.
- **An auditor with no account** verifies a seal in seconds.
- **A donor** checks that their gift was acknowledged and recorded.

## 7. Audiences

Two front doors for launch: **owners** (schools first) and **their accountants**. Others get a page but not a homepage tab.

| Audience | They hear | CTA | Proof they need | Page |
|---|---|---|---|---|
| **School owners** (microschools, private schools; Idaho and Utah first) | Every tuition payment, a receipt your families can check, and books your CPA can sign fast. | Get early access | A sample receipt with child, hours and school EIN; the state-program question answered honestly | `/for/schools` |
| **Accountants and bookkeepers** | Clients whose books arrive closed and traceable. You review and sign. | Become a partner | Year-end package; every number traced to an event; free partner seats | `/for/accountants` |
| Studios, gyms, tutoring | Sell plans and packs; know who has visits left; books close themselves. | Get early access | Vibes of Light story | `/for/studios` |
| Non-profits and co-ops | Open books donors, board and members can check. | See non-profit pricing | Donation acknowledgments; open-books page (Next) | `/for/nonprofits` |
| Developers and platforms | A provable ledger for credits, plans and bookings; open spec; free verifier. | Install the CLI, free | Engine, CLI, spec, test vectors | `/for/developers` |
| Verifiers (families, auditors, grantors) | Check any receipt or seal in seconds. No account. | Verify | The page itself | `/verify` |

## 8. Objections, answered on the site

| Objection | Answer | Where |
|---|---|---|
| "Will my state program accept these receipts?" | We're designing receipts against each program's published rules and confirming with CPAs. Until a program confirms, we say "designed for," not "accepted by." | Schools page, FAQ |
| "You're new. Will you exist next year?" | You don't need us to. The engine is free to self-host, your data exports in open formats, and every receipt and seal verifies without Trifold. | FAQ, Trust |
| "I already use QuickBooks or Mindbody." | Keep them. Trifold adds proof on top and syncs out; switch fully only when you want to. | FAQ, Pricing |
| "What happens to my data if you go away?" | It's already yours: open formats, downloadable any time, verifiable forever. | FAQ, Trust |
| "Is AI touching my numbers?" | No. The engine computes deterministically; Rifo explains and proposes, and you approve. | Close chapter, FAQ |
| "What does it cost?" | Design partners: free during the pilot. Published plans on `/pricing`. | FAQ, Pricing |

## 9. Competitive frame (comparison pages only, sourced and dated)

| Them | Their pitch | Our line |
|---|---|---|
| QuickBooks, Xero with AI | AI inside your existing books | Keep them; add books that show their work. |
| Digits, Puzzle, Basis | AI-native bookkeeping | Fast, but you trust their output. Ours anyone can check. |
| Airtight | Triple-entry with cryptographic receipts | Open standard and free verifier anyone can run, Stripe-native, self-hostable engine. |
| Pilot and bookkeeping services | A human closes your month | Witnessed + Bookkeeper: a human closes it on books anyone can check. |

## 10. Go-to-market, in order

1. **Founder-led outreach to 30 named microschools** in Idaho and Utah, through buzz-school and B4 Uni. Utah's ESA program drew about 27,000 applicants for 10,000 scholarships, so owners are looking for help with records.
2. **Microschool networks and state education-choice groups**: talks, a receipt checklist, co-branded guides.
3. **Idaho and Utah CPA firms that serve schools**: free partner seats, a year-end package, recurring revenue share later.
4. **The receipt is the ad**: every receipt carries a plain "Verify this receipt" link; verify-page visits are the top-of-funnel metric. The verify page must work for a parent in 10 seconds.
5. **Month-end proof moment**: "October sealed · 214 payments · verified", shareable with the bookkeeper.
6. **Developer credibility**: source-available engine (FSL, free to self-host), `tfd` CLI, Apache-2.0 spec and verifier, CC0 test vectors on GitHub; one Show HN when the verifier is polished.
7. **Non-profit loop**: free Witnessed for non-profits under $50K once the witness ships; every donation acknowledgment is a verify link.
8. **Public changelog and roadmap**: chapters light up as they ship.

## 11. Words

| Use | Avoid |
|---|---|
| check, verify, signed, sealed, matched, show their work, open, durable | blockchain, crypto, immutable (say "append-only"), unhackable, 100% accurate |
| books, receipts, close, families, members | "AI magic", "autopilot", "set and forget" |
| "tax-ready", "with your CPA" | "we do your taxes", "automated filing" |
| "signed receipts and sealed books" | "triple-entry accounting", "witnessed" as a present-tense claim (until shipped) |
| "Get early access", "design partner" | "Start free" for the hosted product (until Cloud ships) |

## 12. Sources

- Intuit 2026 AI Impact Report, via a secondary summary: https://beancount.io/blog/2026/07/13/quickbooks-ai-impact-report-small-business-trust-guide
- Simply Business 2026 Small Business AI Outlook: https://www.simplybusiness.com/small-businesses-are-using-ai-but-theyre-not-letting-it-run-the-show-2026-outlook/
- Airtight (vendor material): https://airtight-marketing.pages.dev/ and https://airtight-pitch.pages.dev/en/
- Basis Series B: https://ai2.work/blog/basis-raises-100m-at-1-15b-valuation-to-automate-accounting-2026
- Accounting-tech GTM and CPA partners: https://www.saashero.net/strategy/accounting-tech-gtm-strategy/ and https://www.saashero.net/strategy/marketing-accounting-software-to-cpas/
- Utah ESA demand: https://www.marketscale.com/industries/education-technology/with-esa-demand-outpacing-supply-how-can-utah-expand-microschool-access
- Waitlist pages: https://getlaunchlist.com/blog/waitlist-landing-page-examples-that-convert
