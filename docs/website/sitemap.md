# Trifold website: sitemap and page outlines

Status: draft, round 2, 2026-11-06. Messaging: `messaging.md`. Look and motion: `brand-guide.md`. Changes from round 1: `decisions.md`.

## Sitemap

```
/                      Home: the six chapters
/how-it-works          One payment, three records, the monthly seal, what it catches
/trust                 Durable, provable, resilient, fast; security; data ownership; claim rules
/verify                Verify a receipt or seal in the browser (no account)
/roadmap               Now · Next · Later, the same six chapters in depth
/pricing               Pricing (monthly/annual, for-profit/non-profit), design-partner banner
/for/schools           Microschools and private schools (first market)
/for/accountants       Accountants and bookkeepers (partner program)
/for/studios           Studios, gyms, tutoring
/for/nonprofits        Non-profits and co-ops
/for/developers        Developers and platforms
/about                 Why Trifold, principles, licensing, team
/early-access          The design-partner form (one form, one action)
/legal                 Terms, privacy, trademark policy (stubs until a lawyer drafts them)
```

Deferred until after launch: `/rifo` (folded into Close and Roadmap), `/standard` (link to the spec repo from `/for/developers`), `/changelog`, comparison pages.

**Header nav:** How it works · Schools · Accountants · Pricing · Verify · [mode toggle] · **Get early access**.
"More" lives in the footer: Studios, Non-profits, Developers, Roadmap, Trust, About.

**Footer:** Product (How it works, Roadmap, Pricing) · For (Schools, Accountants, Studios, Non-profits, Developers) · Trust (Trust, Verify, GitHub) · Company (About, Early access, Legal) · "Verify a receipt" link · "Trifold provides tfd, the engine behind it. Source-available on GitHub; each release becomes Apache-2.0 after two years."

## Calls to action

| CTA | Style | Where | Goes to |
|---|---|---|---|
| **Get early access** | Primary (saffron) | Header, hero, every page end | `/early-access` |
| **Verify a sample receipt** | Secondary (outline) | Hero, Proof chapter, footer | `/verify` (or the inline verifier) |
| **Become a partner** | Primary on accountant page | `/for/accountants` | `/early-access?role=accountant` |
| **Install the CLI, free** | Mono, code-styled | `/for/developers`, footer | GitHub / docs |
| **See non-profit pricing** | Secondary | `/for/nonprofits` | `/pricing?org=np` |
| **Talk to us** | Text link | Platform tier, networks | `/early-access?role=network` |

## Home (`/`)

1. **Hero.** Eyebrow "For schools and membership businesses on Stripe". Headline "Books that show their work." Subhead. CTAs: Get early access · Verify a sample receipt. The hero animation (storyboard in `brand-guide.md` §5). A sample-ledger pill under it: `● SAMPLE LEDGER · 214 PAYMENTS · OCTOBER SEALED`, which opens the sample on click.
2. **The question.** One line, large: "AI can do your books. How would you know it did them right?" Answer below: "Because every number shows its work."
3. **Chapters 01–06** with the fold line running down the margin. One pinned visual (a ledger panel) changes state through 01–03; 04–06 are cards in ember and outline.
   - **01 · MONEY IN** (lit): tuition, memberships, packs, bookings, through Stripe.
   - **02 · BOOKS** (lit): balanced, append-only, replayable. Durable: export to Parquet, hledger, CSV; self-host the engine.
   - **03 · PROOF** (lit): a signed receipt for every payment, a sealed month. **Inline verifier** with a sample receipt and a tampered one. Resilient: rebuild everything from the events. "Not even Trifold can quietly change your books."
   - **04 · CLOSE** (ember, NEXT): Rifo reconciles and closes; daily payout matching; Trifold as witness. Fast: a year rebuilt in seconds today.
   - **05 · TAXES** (outline, LATER): tax-ready packages for your CPA.
   - **06 · FINANCE** (outline, LATER): your finance warehouse, forecasts, agents.
4. **Who can check.** Parent, treasurer, CPA, auditor, donor; one line each.
5. **Built for schools first.** The school story, a sample receipt (child, hours, EIN), and an "Also for" line linking studios, non-profits, accountants, developers.
6. **People.** Design partners (B4 Uni, Vibes of Light, with permission) and the founder. Placeholder until approved.
7. **FAQ.** The six objections from `messaging.md` §8.
8. **Closing CTA.** "Every dollar, three ways. Every month, sealed." Get early access.

## How it works (`/how-it-works`)

The three sides (books, receipt, Stripe) · one payment step by step · the monthly seal · what catches what (edits, deletions, forgeries, refunds) · what's shipped and what's next · CTA.

## Trust (`/trust`)

The research question and stat · four kinds of trust in depth · "what we claim and what we don't yet" (the claim-rules table, published) · security (keys, rotation, where data lives) · data ownership and export · the licensing table (FSL engine, Apache-2.0 format and verifier, CC0 vectors) · verify us yourself.

## Verify (`/verify`)

Paste or drop a receipt JSON → result: signature valid, signed by key, amount, date, sealed month. Buttons to load a sample and a tampered sample. A box: "What a pass proves, and what it doesn't." Runs entirely in the browser.

## Roadmap (`/roadmap`)

The six chapters as columns lit, ember and outlined, each with its items. The end-to-end diagram. A note that dates aren't promised.

## Pricing (`/pricing`)

Banner: "Design partners: free during the pilot." Then the full page from `docs/business/pricing-page.html`: toggles, size slider, cards, matrix, add-ons, credits, never-paywalled, FAQ.

## For pages (`/for/*`)

Each: their headline · their three pains · how Trifold answers each (citing the chapters) · proof · FAQ for them · their CTA.

## About (`/about`)

Why Trifold exists · principles (show the work, open formats, never paywall verification, durable over clever) · Trifold provides tfd · the founder · contact.

## Early access (`/early-access`)

One form: name, email, organization, role (school, studio, non-profit, accountant, developer, network), number of families or members, Stripe yes/no. What design partners get: founder onboarding, free during the pilot, a say in the roadmap, named in the case study (optional). Static site: the form posts to a form endpoint chosen at deploy time (see the site README).
