# Trifold competitor research

Status: research notes, checked 2026-11-06, not for publication as-is.

Conventions: every vendor fact has a source URL; all were fetched 2026-11-06 unless marked otherwise. "UNVERIFIED" means the public page did not state it or the source was secondary. Prices are USD unless noted. Page text was summarised by a fetch tool, so re-check prices before any page ships.

Trifold shipped today (for contrast): Stripe events to balanced double-entry books (append-only, replayable, rebuild byte-for-byte); an Ed25519 signed receipt per payment, verifiable in a free browser verifier with no account; sealed months (hash-chained seals that verify after key rotation); export to Parquet, hledger, CSV; self-hostable engine. Next (not shipped): Rifo agent (proposes, you approve; never computes numbers), daily payout matching, independent witness. Later: CPA tax packages, 1099s, finance warehouse. Hosted product is pre-launch.

---

## 1. Airtight (airtight.one)

- **Tagline:** "Triple-entry accounting for Australian businesses." Hero: "Let's get you Airtight." (https://airtight.one)
- **Built for:** sole traders, freelancers, landlords; SMEs of 1-200 staff and multi-entity; accountant firms managing 10-2,000 client books. Australia first, Gulf (GCC e-invoicing on Plus). (https://airtight.one, https://airtight.one/pricing)
- **Pricing (AUD/month; billed in local currency at checkout; annual saves 17%):** Foundation $49 (1 entity), Plus $99 (up to 3 entities, 5 employees payroll), Scale $199 (up to 10 entities, 50 employees, R&DTI, SMSF, trust accounting), Enterprise $499+ (sales-led). (https://airtight.one/pricing)
  - Free tier / trial: none.
  - Seats: "No per-seat multiplier." Auditor seat $0, read-only, scoped, unlimited, addable on any plan.
  - Refund: full refund if emailed within 30 days of first charge, first-time paid subscribers only.
- **AI:** "Bella" with modes labelled "Auto · Guarded · Off". The homepage says "She drafts, you approve"; what Auto actually does is UNVERIFIED (modes not explained on the page). (https://airtight.one)
- **Proof/verifiability:** every posted entry gets an Ed25519-signed receipt linked by SHA-256 into a linear hash chain ("not a Merkle tree"). Verification is described as happening "inside Airtight". Whether a third party can verify without an account is UNVERIFIED (the security page does not say; it refers questions to security@airtight.one). Append-only audit log and period locks exist; the page admits "Not every module records every action yet." Drafts, bank lines and imports are not receipted until posted. (https://airtight.one/security)
- **Export / lock-in:** export formats, portability and self-hosting are not described (UNVERIFIED). Imports from Xero, QuickBooks, MYOB, CSV, OFX. Data hosted on AWS Sydney. (https://airtight.one, https://airtight.one/security)
- **Stripe:** Stripe payment links in invoicing; example of Stripe AU payout reconciliation. Depth of ingestion UNVERIFIED. (https://airtight.one)
- **Compliance:** SOC 2 Type II "working toward Q4 2026" (not yet certified as of the page); ISO 27001 targeted Q1 2027. (https://airtight.one/security)
- **Where Airtight is strongest:** payroll, multi-entity, trust/SMSF/R&DTI, BAS/GST for Australia, GCC e-invoicing, accountant/auditor-firm workflow, $0 auditor seats, human support SLAs, bank import. Australian tax fit that Trifold has none of.
- **Where Trifold differs (shipped):** free tier; receipt verifiable in a public browser verifier with no account (Airtight: UNVERIFIED); open export (Parquet/hledger/CSV) and self-hostable engine; byte-for-byte rebuild from events; sealed months that survive key rotation; US schools/studios/non-profits focus, Stripe-first. Next: independent witness.
- **Choose Airtight if:** you are an Australian or Gulf business or accountancy needing local tax, payroll and multi-entity today.
- **Choose Trifold if:** you are a US school, studio or non-profit on Stripe who wants a free start, open export, self-hosting, and receipts a payer can check without logging in.

## 2. QuickBooks Online (Intuit)

- **Tagline:** not captured from the pricing page (UNVERIFIED). Intuit markets AI "agents" / "virtual team" and Intuit Assist.
- **Built for:** small businesses broadly, plus accountants and mid-market (Intuit Enterprise Suite). (https://quickbooks.intuit.com/pricing/)
- **Pricing (monthly list; promo 50% off for 3 months):** Free $0 (1 user, no mobile/integrations), Simple Start $38, Essentials $85, Plus $140, Advanced $340. Users: 1 / 3 / 5 / 25. Accountant access: up to 2 accountants (3 on Advanced). Extra-user fees and payroll price not stated on page (UNVERIFIED). 30-day trial mentioned, plan coverage unclear. The "Free" row appears on the page as fetched; confirm it is a real permanent free plan before citing (UNVERIFIED). (https://quickbooks.intuit.com/pricing/)
- **AI:** Intuit Assist plus agents. Page lists AI chat (beta), expense categorisation, Accounting AI (cleanup), Payments AI, Business Tax AI, Sales Tax AI, anomaly detection, Project Management AI, Finance AI, by tier. Secondary sources: agents launched 2025 for lead management, payment tracking, invoicing, reconciliation; 2026 added Payroll and Sales Tax agents; Agent Studio pilot. (Pricing page; https://www.cpapracticeadvisor.com/?p=163868, https://www.usecarly.com/blog/quickbooks-ai, both secondary). Whether agents post entries on their own vs. propose for approval: UNVERIFIED; do not characterise.
- **Proof/verifiability:** audit log and closing date exist in product, visible to account users. No signed-receipt or public-verifier equivalent found. Detail not fetched (help-article URL 404): UNVERIFIED.
- **Export / lock-in:** report export to Excel/CSV/PDF and a data export feature are common knowledge but not confirmed from a fetched page (UNVERIFIED). Not self-hostable.
- **Stripe:** via third-party apps/connectors; native status UNVERIFIED.
- **Compliance:** UNVERIFIED (not fetched).
- **Where QuickBooks is strongest:** by far the largest ecosystem; payroll, bank feeds, sales tax, 1099s, invoicing, mobile apps, multi-user roles, huge accountant/ProAdvisor base, app marketplace, scale of AI investment (reported 3M+ customers using agents, Q2 FY26 earnings call via secondary source).
- **Where Trifold differs (shipped):** no per-seat fees, accountant seats free; payer-verifiable signed receipts; open export formats and self-host; deterministic rebuild from events. Next: AI proposes, never computes.
- **Choose QuickBooks if:** you need payroll, 1099s, tax, bank feeds, and an accountant who already uses it.
- **Choose Trifold if:** you want verifiable records of Stripe payments, no per-seat pricing, and the ability to leave with open files.

## 3. Xero

- **Tagline:** not captured (UNVERIFIED). Xero markets JAX ("Just Ask Xero") as an "AI business companion". (https://www.xero.com/jax search title)
- **Built for:** small businesses and their accountants/bookkeepers; Partner Program for advisors. (https://www.xero.com/us/pricing-plans/)
- **Pricing (US, monthly, USD):** Early $27, Growing $59, Established $97; intro offers (e.g. $5.40/$11.80/$19.40 for first 3 months, 80% off). Early: 20 invoices and 5 bills limit. Auto-reconcile add-on $5 on Early. Multi-currency, projects, expense claims only on Established. Payroll add-on $36/month + $6 per employee/contractor. No per-user license fees. Accountant access by plan not stated (UNVERIFIED). No standard free trial described. (https://www.xero.com/us/pricing-plans/) Note: UK pricing reportedly changes 2026-09-01 (secondary source, irrelevant to US).
- **AI:** JAX answers questions, makes charts, handles admin like creating invoices/quotes. Xero's JAX page says it "only does something when you open it and ask"; no background action. Whether it asks approval before actions: UNVERIFIED. Included with subscription now, Xero reserves right to charge. Beta status inconsistent across pages. (https://www.xero.com/jax, https://www.xero.com/za/ai-in-accounting/jax/ via search)
- **Proof/verifiability:** audit/history and period locks are in-product for users; no public verifier found. Not fetched: UNVERIFIED.
- **Export / lock-in:** UNVERIFIED (not fetched). Not self-hostable.
- **Stripe:** Stripe app: pay-by-card on invoices, Stripe bank feed, one-click reconcile; 2.9% + $0.30 domestic listed; user rating 2.5/5 (384 reviews), complaints about fees and payout holds. (https://apps.xero.com/us/app/stripe)
- **Compliance:** UNVERIFIED.
- **Where Xero is strongest:** bank feeds, invoicing, multi-currency, payroll add-on, large app marketplace, accountant partner network, global footprint, mature product.
- **Where Trifold differs (shipped):** payer-verifiable receipts; open export/self-host; Stripe ingestion as events into balanced books rather than bank-feed matching; free tier.
- **Choose Xero if:** you want mature invoicing, bank feeds and multi-currency, or your accountant uses Xero.
- **Choose Trifold if:** Stripe is your main money flow and you want cryptographic proof per payment and open data.

## 4. Digits

- **Tagline:** "Accounting software—that works for you." Subhead: "the first AI-native general ledger for business owners and accountants." The page uses "AI-native general ledger" and "Agentic General Ledger(TM)", NOT "autonomous general ledger". (https://digits.com, https://digits.com/pricing)
- **Built for:** business owners and accountants; startups and small businesses; separate firm plans billed per client.
- **Pricing:** Essentials $65/mo, Core $100/mo, Pro $250/mo ("coming soon"). Free tier: none listed. Per-seat: not stated (UNVERIFIED). Accountant access cost: UNVERIFIED. (https://digits.com/pricing)
- **AI:** 24/7 AI bookkeeping and reconciliation, AI Bill Pay and Invoicing, Ask Digits, AI Quality Review, "Agentic Close". Whether entries post without review: not stated on the page (UNVERIFIED); "Human in the loop" appears under Managed accounting.
- **Proof/verifiability:** audit trail and third-party verification not described (UNVERIFIED).
- **Export / lock-in:** not described (UNVERIFIED); Developer API and MCP offered. Not self-hostable.
- **Stripe:** named as an import source (with Ramp, Gusto, BILL, CSV). Bank/card/payroll connections to 12,000+ providers.
- **Compliance:** states SOC 2 Type II compliant (https://digits.com/security, trust.digits.com).
- **Where Digits is strongest:** SOC 2 Type II today, broad bank/card/payroll connectivity, polished AI close workflow, API/MCP, tax package, managed accounting option.
- **Where Trifold differs (shipped):** free tier; Starter at $19 planned (vs $65); payer-verifiable receipts; open export/self-host; replayable ledger. Next: Rifo proposes and never computes numbers.
- **Choose Digits if:** you want an AI-first ledger with broad connectivity and SOC 2 now and accept hosted-only.
- **Choose Trifold if:** verifiability, open formats and low price matter more than breadth of connectors.

## 5. Puzzle (puzzle.io)

- **Tagline:** "Introducing Puzzle 2.0: AI-native accounting software + Puzzle accounting services." Elsewhere "Accurate books. At AI speed." (https://puzzle.io, https://puzzle.io/pricing)
- **Built for:** "startups, small businesses and the accounting firms that serve them."
- **Pricing (software, monthly):** Starter $30, Core $72, Complete $120 (most popular), Scale $360. Core + Expert Reviewed $171/mo (up to $10K monthly expenses). Full service price depends on a slider not captured. Free tier: none described; "Try for free" buttons, terms UNVERIFIED. AI credits: 25 lifetime (Starter/Core), 100/mo (Complete), 300/mo (Scale). Per-seat fees and accountant access cost: UNVERIFIED. (https://puzzle.io/pricing)
- **AI:** AI Suite (Chat, Cowork, Close). "Nothing changes in your books until you approve it"; MCP-proposed updates need confirmation. Proposes for approval. (https://puzzle.io)
- **Proof/verifiability:** page nav says "Accuracy you can audit" but no audit trail detail (UNVERIFIED). No public verifier found.
- **Export / lock-in:** not described (UNVERIFIED); QuickBooks/Xero migration add-on exists. Integrations are read-only. US-hosted. Not self-hostable.
- **Stripe:** direct integration, daily sync. (https://puzzle.io)
- **Compliance:** SOC 2 not mentioned (UNVERIFIED); AES-256 encryption; bug bounty. (https://puzzle.io/security)
- **Where Puzzle is strongest:** AI-native workflow aimed at startups, direct Stripe/Ramp/Mercury/Brex/Gusto integrations, expert-reviewed and full-service tiers with human accountants, board-ready statements.
- **Where Trifold differs (shipped):** free tier; payer-verifiable receipts; open export/self-host; deterministic rebuild. Rifo (Next) has the same approve-first posture, so do not claim it as a differentiator.
- **Choose Puzzle if:** you are a venture-style startup wanting AI books plus optional accountants.
- **Choose Trifold if:** you are a school/studio/non-profit with Stripe revenue and want low price and open records.

## 6. Pilot (pilot.com)

- **Tagline:** hero "If you're buried in bookkeeping, who's leading the company?"; model "50/50 people and software". (https://pilot.com)
- **Built for:** startups, small and growing businesses, professional-services firms; 3,500+ customers cited.
- **Pricing:** Bookkeeping Essentials $99/mo (up to $100K monthly expenses); Core listed as "starting at $0/mo billed annually" (unexplained, UNVERIFIED); Custom via sales. Tax from $1,000+/yr (single-member LLC), $2,000+/yr (partnerships/S-corps), $2,450+/yr (C-corps), must be bought with bookkeeping. CFO $1,750 / $3,150 / $5,250 per month. Operations by volume. Free tier: none. Per-seat: n/a (service). (https://pilot.com/pricing)
- **AI:** AI categorisation, reconciliation, monthly close, Q&A, scenario planning; human/AI split not described.
- **Proof/verifiability:** service model, books are Pilot-managed; no public verification found (UNVERIFIED).
- **Export / lock-in:** UNVERIFIED. Not self-hostable.
- **Stripe:** not mentioned on the pricing page ("payment platforms" only) (UNVERIFIED).
- **Compliance:** SOC 2 not mentioned on fetched pages (UNVERIFIED).
- **Where Pilot is strongest:** done-for-you US bookkeeper, tax filing, CFO services, R&D credit, payroll/bill pay operations, stock administration. This is what Trifold explicitly does not do (tax packages are Later).
- **Where Trifold differs (shipped):** software you can inspect and self-host; far lower price; no minimum expenses; free tier. Not a service.
- **Choose Pilot if:** you want a human to do bookkeeping and file taxes and can pay $99+/mo (taxes extra).
- **Choose Trifold if:** a volunteer treasurer or admin runs the books and needs trustworthy automation and receipts.

## 7. Wave

- **Tagline:** "Clear books. Confident decisions." Also "Plans to make your plans happen." (https://www.waveapps.com, https://www.waveapps.com/pricing)
- **Built for:** freelancers, solopreneurs, contractors, consultants; "not accountants".
- **Pricing (USD):** Starter free (unlimited estimates, invoices, bills, bookkeeping records; manual bank entry). Pro $19/mo ($190/yr) with bank import via Plaid. Wave Advisors from $149/$199 (discounts shown, mapping unclear). Payroll add-on $25-$40/mo. Receipts add-on $8-$11/mo (mapping unclear). Card fees: 2.9% + $0.60 (Starter), 2.9% + $0 for first 10 transactions then same as Starter (Pro). Accountant access: Starter free "tax pro"/payroll roles; Pro admin/editor/viewer roles. User limits: UNVERIFIED. (https://www.waveapps.com/pricing)
- **AI:** none found on fetched pages (UNVERIFIED).
- **Proof/verifiability:** UNVERIFIED; no public verifier known.
- **Export / lock-in:** not on fetched pages (UNVERIFIED). Not self-hostable.
- **Stripe:** not mentioned; Wave has its own payment processing (UNVERIFIED whether Stripe is supported).
- **Compliance:** UNVERIFIED.
- **Where Wave is strongest:** truly free invoicing/bookkeeping, simple UX, mobile app, receipt scanning, payroll add-on, paid advisor service, accountant roles on free tier.
- **Where Trifold differs (shipped):** event-sourced double-entry from Stripe, signed receipts, sealed months, open export; built for orgs not solo freelancers.
- **Choose Wave if:** you are a solo operator who needs free invoicing and simple books.
- **Choose Trifold if:** you collect tuition/dues/class fees via Stripe and need reconciled books that others can verify.

## 8. A spreadsheet (Excel / Google Sheets)

All items common knowledge, no web research (UNVERIFIED in the citation sense).
- **What it is:** the default tool of microschools and small non-profits: a ledger tab plus a Stripe CSV export pasted in monthly.
- **Pricing:** free (Google Sheets) or bundled with an existing Microsoft 365 or Google Workspace subscription; zero marginal cost.
- **Seats:** shared by link; no per-seat fee on Sheets.
- **AI:** spreadsheet copilots exist (Gemini in Sheets, Copilot in Excel); they edit cells directly with no accounting controls.
- **Proof/verifiability:** none by default. Version history exists but cells can be edited silently; no signed receipts, no period lock enforcement. Be careful: sheet protection and version history do exist.
- **Export/lock-in:** fully open (CSV/XLSX). Not self-hosted but you hold the file.
- **Stripe:** manual CSV export, or via third-party connectors.
- **Where a spreadsheet is strongest:** free, flexible, everyone already knows it, no migration, total control of layout, works for 20-student schools.
- **Where Trifold differs (shipped):** double-entry always balances, books rebuild byte-for-byte from events, per-payment signed receipt, sealed months, and exports to the same CSV so you can still open it in a sheet.
- **Choose a spreadsheet if:** you have a handful of payments a month and one trusted person.
- **Choose Trifold if:** payments exceed what one person can reconcile by hand, or a board, auditor or parent will ask "how do I know this is right?"

---

## Summary comparison

| Competitor | Price from | Free tier | Per-seat fees | AI posts on its own? | Third-party verifiable without account? | Open export | Self-host | Stripe |
|---|---|---|---|---|---|---|---|---|
| Trifold (planned) | $19/mo Starter (Free plan) | Yes | No; accountant seats free | No (Rifo proposes; Next) | Yes, browser verifier (shipped) | Parquet, hledger, CSV | Engine yes | Native, event-based |
| Airtight | AUD $49/mo | No | No ($0 auditor seats) | UNVERIFIED ("drafts, you approve"; Auto mode unexplained) | UNVERIFIED (verify "inside Airtight") | UNVERIFIED | No evidence | Payment links; payout recon example |
| QuickBooks Online | $38/mo list (promo $19); Free plan row on page, confirm | Possibly (UNVERIFIED) | Tiered user caps; extra-user fee UNVERIFIED | UNVERIFIED | No evidence found | UNVERIFIED (reports export likely) | No | Via apps (UNVERIFIED) |
| Xero | $27/mo | No standard trial | No per-user license fee | UNVERIFIED (JAX on request only) | No evidence found | UNVERIFIED | No | Via Stripe app |
| Digits | $65/mo | No | UNVERIFIED | UNVERIFIED | No evidence found | UNVERIFIED (API/MCP) | No | Import source |
| Puzzle | $30/mo | No (trial UNVERIFIED) | UNVERIFIED | No (approve-first) | No evidence found | UNVERIFIED | No | Direct integration |
| Pilot | $99/mo | No | n/a (service) | UNVERIFIED | No evidence found | UNVERIFIED | No | Not mentioned |
| Wave | $0 (Starter); Pro $19 | Yes | UNVERIFIED limits | No AI found | No evidence found | UNVERIFIED | No | Not mentioned |
| Spreadsheet | $0 | Yes | None on Sheets | Copilot edits cells directly | No | Yes (CSV/XLSX) | You hold the file | Manual CSV |

"No evidence found" means we did not find a public feature; it does not prove absence.

---

## Claims we must not make

- That QuickBooks, Xero or any other vendor's data "can't be audited". They have audit logs and period locks; the accurate statement is that these are visible to account users, and we found no public, no-account verifier for them.
- That Airtight cannot be verified without an account. Their docs only say verification happens "inside Airtight"; it is UNVERIFIED either way.
- That Trifold is the "only" or "first" signed-receipt or triple-entry product. Airtight claims Ed25519 receipts and a SHA-256 chain.
- That Airtight lacks export or self-hosting. The page is silent, not negative.
- That competitors' AI posts entries on its own, or can't be trusted. Intuit, Digits, Airtight Auto mode are unconfirmed; Puzzle and Xero describe approval-first or ask-first behaviour.
- That Digits uses an "autonomous general ledger". Its wording is "AI-native" and "Agentic General Ledger".
- That Rifo exists today, or that Trifold has independent witness, daily payout matching, tax packages, 1099s or a finance warehouse. These are Next/Later.
- That Trifold has payroll, bank feeds, multi-currency, invoicing, a mobile app, or tax filing. It does not.
- That Trifold is SOC 2 certified, or any compliance claim we have not earned. Digits states SOC 2 Type II; Airtight targets Q4 2026.
- Any price as current without rechecking. Promos change (QuickBooks 50% off, Xero 80% off, Wave promo expired 2026-01-06).
- That competitors "lock you in". Say what we offer (open export, self-host) instead of what we can't confirm they lack.
- That spreadsheets are unsafe or that errors are inevitable. They are fine for low volume.
- "Free forever" or final plan prices for Trifold. Pricing is planned, hosted product is pre-launch.
