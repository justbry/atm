# Trifold website: open questions

Status: draft, 2026-11-06. This lists what is still unknown before the Trifold marketing website can be fully built and launched. It is a research doc, not a decision record. Nothing here has been bought, registered, built or deployed.

Inputs: `../brand/trifold-brand-and-messaging.md` (PR #121, not merged), `business-plan.md`, `pricing-strategy.md`, `market-research.md`, the repo itself, `whois`, and web searches (sources at the end).

**Who decides** uses four owners:
- **Owner**: the founder. A product or business call.
- **Lawyer**: needs legal review before it goes on a public page.
- **Research**: a fact to find out (search, call, interview, primary source).
- **Engineering**: a build or infrastructure fact.

Priority: **P0** blocks any public page, even a waitlist page. **P1** blocks the full site. **P2** can follow launch.

## Decide first

These block almost everything else. Settle them in this order.

1. **What "launch" means.** A one-page waitlist and verifier on a real domain, or the full site from the brand doc's outline. Every page in the outline except Trust and Developers describes things that don't exist yet (cloud, Rifo, Pricing Lab, compliance packs, bookings). **Default:** launch a waitlist page plus the open-standard pages first; ship the full site with cloud Free (phase 1 in `business-plan.md`).
2. **The primary domain.** Trifold is the company and the managed service; tfd is the engine and CLI, replacing the name atm in prose (the name Trivalance was dropped on 2026-11-06). gettrifold.com and usetrifold.com look unregistered; trifold.com and trifold.ai are taken (trifold.ai is listed for sale). This decides the email sender domain, the receipt "Verify at …" link (which gets printed on every receipt and is hard to change), the DNS owner, and SEO. **Default:** buy the free ones now; Trifold is the site's name, with gettrifold.com as the primary site and a short, permanent verify host (see section 2).
3. **Which audience the homepage leads with.** The brand doc's hero is studio-shaped ("memberships, bookings and books"); the business plan's first market is Idaho and Utah microschools, and Trifold has no booking product. **Default:** lead with microschools, keep studios as a secondary solution page.
4. **The claim baseline for launch day.** The brand doc and business plan disagree on the ladder ("tamper-evident" after steps 1–3 in the brand doc vs "signed receipts and sealed books" until milestones 2 and 3 in the plan), and signed receipts are built on `dev` but not released or deployed at buzz-school (`packages/atm/ROADMAP.md`, unchecked items). **Default:** use only "double-entry, append-only, replayable books" and "open receipt standard (preview)" until receipts ship to a real school; never "triple-entry accounting" for Trifold.
5. **The engine licence.** Decided 2026-11-06: FSL-1.1-ALv2 for the engine, Apache-2.0 for the receipt and seal format, spec and verifier, CC0-1.0 for test vectors, proprietary for the hosted service, Rifo and the witness. The site never calls the engine "open source"; it says "source-available" or "free to self-host". `LICENSE` at the repo root is still Apache-2.0 until the per-package `LICENSE` files land. See `business-plan.md` section 5.
6. **Fresh site or rebrand Autumn's `apps/website`.** See section 13 for the facts. **Default:** a fresh, small site; reuse only patterns (markdown-for-agents, `llms.txt`, sitemap), not content.
7. **Legal entity and the lawyer.** Privacy policy, terms, witness terms and the trademark policy all need a named legal entity (Trifold, Inc.? an LLC?) and an address. The engine `LICENSE` says "Trifold" until the company is formed (8.10a). Nothing public can carry terms without it.
8. **Trademark clearance before the logo and the name go public.** The Samsung Galaxy Z TriFold dominates search for "trifold", and old TRIFOLD filings need checking (section "Naming collisions found"). Spending on a logo and domain before a clearance search risks a rename.

## 1. Brand and assets

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 1.1 (P0) | Final logo files (mark, wordmark, favicon, social card) | The brand doc describes the folded-receipt triangle in words only; no SVG exists in the repo | Owner (designer) | Commission after trademark clearance (Decide first 8); ship the three-bar flat mark as favicon first | Brief a designer with the brand doc's logo, colour and type sections |
| 1.2 (P1) | Product screenshots | No cloud UI exists. The only UI is `packages/ledger-ui` (single-tenant, for ledger.b4uni.com, B4 Uni data) | Owner, Engineering | Use real CLI output (`tfd journal`, `tfd verify`) and an anonymised ledger-ui view built from `packages/atm/fixtures/vibes-year`; label mockups as "preview" | Decide which views are real; render them from fixtures, never from live family data |
| 1.3 (P1) | "See a live ledger" demo | The hero button in the brand doc promises it; nothing hosts a public, anonymised ledger | Owner, Engineering | A static, read-only ledger-ui build over the vibes-year fixture | Check the fixture has no real names; decide hosting with section 13 |
| 1.4 (P1) | Illustrations and photos ("real studio and classroom scenes") | Real classroom photos of children need releases; stock is banned by the brand doc | Owner, Lawyer | Folded-paper illustrations only at launch; no photos of identifiable children | Get written photo releases from design-partner schools if photos are wanted later |
| 1.5 (P1) | Contrast of the palette pairs | The brand doc says check WCAG AA; saffron on cream likely fails for text | Engineering | Check every pair with a contrast tool before building components | Run the pairs through a checker, record results in the brand doc |
| 1.6 (P2) | Font licensing and hosting | Fraunces, Inter and JetBrains Mono are OFL, so fine; self-host vs Google Fonts affects privacy (EU rulings on Google Fonts IP leaks) | Engineering | Self-host the woff2 files | — |
| 1.7 (P2) | Rifo's visual identity (avatar, intro card) | The brand doc wants the pronunciation on the intro card; Rifo doesn't exist yet | Owner | Don't show Rifo on the site until it works; one "coming" mention | Revisit when Rifo has a demo |

## 2. Domain and naming

Whois results, 2026-11-06. **Whois is a signal, not a guarantee.** A "no match" can still be reserved, premium-priced, or registered between now and purchase; a registered domain may be for sale. Prices weren't checked.

| Domain | Whois result | Registrar / dates | Notes |
|---|---|---|---|
| trivalance.com | No match (unregistered) | — | |
| trivalance.ai | Domain not found (unregistered) | — | |
| trivalance.io | Domain not found (unregistered) | — | |
| trifold.com | Registered | GoDaddy; created 1998-02-26; expires 2027-02-25 | Serves a near-empty page (parked or unused) |
| gettrifold.com | No match (unregistered) | — | |
| trifold.ai | Registered | Spaceship; created 2024-09-11; expires 2028-09-11 | Site says "trifold.ai for sale \| Spaceship.com"; aftermarket price unknown |
| tfd.dev | Registered (via the Google registry's RDAP; plain `whois` returned only the IANA TLD record) | Cloudflare Registrar; created **2026-11-01**; expires 2027-11-01 | Live: a Vercel app redirecting to a WorkOS AuthKit (staging) sign-in. Registered five days ago; **confirm whether it is yours** |
| usetrifold.com | No match (unregistered) | — | |
| trifold.io (extra check) | Registered | GoDaddy; created 2025-10-30; expires 2027-10-30 | |

Other handles checked: npm `trivalance` free; npm `trifold` taken (a React swipe-layout library, v0.2.0); npm `tfd` was unpublished on 2024-02-01 and may be claimable; npm `@trifold/cli` not published (the scope's availability is unconfirmed). GitHub user `trifold` exists (since 2021), so the `trifold` org name is taken; `trivalance` and `gettrifold` are free; `tfd-dev` was created 2026-10-24 (confirm whether yours).

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 2.1 (P0) | Which domain is the primary site | Email deliverability, SEO, every link and the receipt link | Owner | gettrifold.com for the site; redirect usetrifold.com to it. The trivalance.* domains are no longer needed | Register the free ones together; decide before writing the email setup |
| 2.2 (P0) | The permanent verify host printed on receipts | A receipt lives for years; its URL can't move. The brand loop ("Verify at trifold…") depends on it | Owner, Engineering | A dedicated host such as `verify.gettrifold.com`, or a neutral domain for the standard (not chosen or checked) so other issuers can use it | Decide whether the verifier belongs to Trifold or to the open standard (section 6) |
| 2.3 (P0) | Where `/.well-known/trifold-keys.json` is served | `packages/atm/ROADMAP.md` puts it on buzz-school; a Trifold cloud needs its own; the website must not break it | Engineering | Per issuer, on the issuer's domain; Trifold's own on the primary domain | Settle with the key-id owner decision in ROADMAP |
| 2.4 (P1) | How tfd appears on the site | Buyers see Trifold; developers need the engine's name | Owner | Trifold everywhere; "Trifold provides tfd, the engine behind it" on the Developers and Trust pages and in the footer | Decided 2026-11-06: Trivalance dropped |
| 2.5 (P1) | Buy trifold.ai or trifold.com later? | Owning the exact match helps SEO and stops confusion | Owner | Don't buy now; ask for a price once revenue justifies it | Get a broker quote (Spaceship listing for .ai; a GoDaddy broker for .com) |
| 2.6 (P1) | Whether tfd.dev and GitHub `tfd-dev` are already the owner's | If not, `tfd` docs need another host | Owner | — | Check the Cloudflare account and GitHub |
| 2.7 (P1) | npm name for the CLI (`npx tfd verify`) | The brand doc promises `npx tfd verify`; today the binary answers to `tfd` and `atm`, the package is `private: true`, and releases ship as a GitHub tarball (`.github/workflows/release-atm.yml`) | Owner, Engineering | Claim the `@trifold` scope and try `tfd`; until published, the site shows the GitHub install | Try to create the npm org; check npm's name-similarity rules for `tfd` |
| 2.8 (P1) | GitHub org name | `trifold` is taken | Owner | An org such as `gettrifold` (free when checked) for tfd and the standard | Create it |

## 3. Positioning and audiences

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 3.1 (P0) | Homepage lead audience | See Decide first 3 | Owner | Microschools in Idaho and Utah | Five design-partner interviews; test two hero lines |
| 3.2 (P0) | Is Trifold "books" or "billing, memberships and bookings"? | The brand doc's hero and "Sell" fold describe a billing and booking product; the plan describes books built from Stripe events. Booking isn't a product today | Owner | Books, receipts and close; billing via Stripe (the engine runs credits and plans, but there's no hosted billing product) | Owner decision; then rewrite the hero |
| 3.3 (P1) | Per-audience pages at launch | The outline has four solution pages, accountants and developers | Owner | Launch: Microschools, Accountants, Developers. Later: Studios, Nonprofits | — |
| 3.4 (P1) | "Taxes, Finally Done" in a market where families claim tax credits | Families may read it as "Trifold does my tax credit" | Owner, Lawyer | Don't use it on school/family pages; keep it for the owner tax-season campaign with "tax-ready books, CPA-signed" | Lawyer review of the line and qualifier |
| 3.5 (P2) | Spanish-language site | Rifo means "I raffle" in Spanish; Idaho and Utah have Spanish-speaking families | Owner | English only at launch | Revisit with family-facing receipt pages |

## 4. Claims and proof

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 4.1 (P0) | The claim ladder (brand doc vs plan disagree) | One table must govern all copy | Owner | Use the plan's rule and merge into one table: today "double-entry, append-only, replayable"; after receipts ship to a school "signed receipts and sealed months"; after milestones 2 and 3 a per-event chain and daily matching claim (never "triple-entry"); after the open verifier "independently verifiable" | Edit both docs to one table |
| 4.2 (P0) | Whether "signed receipts" is claimable at launch | Built on `dev`, not released; buzz-school rollout unchecked in ROADMAP | Owner, Engineering | Claim only once a design-partner school issues real receipts | Track the ROADMAP buzz-school checklist |
| 4.3 (P0) | Receipt claims for state programs | Idaho's Tax Commission says receipts must show the provider, the expense, the amount, and when and by whom it was paid, and that it "can't prequalify expenses". Utah Fits All was ruled unconstitutional in April 2025 and runs pending a Utah Supreme Court appeal. Itemised receipts aren't built | Lawyer, Research | Never say "accepted by", "approved for" or "compliant with" a program. Say "receipts that show what [program] asks parents to keep" only after the itemised receipt ships and a CPA has checked it. Avoid naming Utah Fits All until the appeal resolves | Read the Idaho statute and Tax Commission guidance, and Odyssey's provider rules, from primary sources; CPA review of a sample receipt |
| 4.4 (P0) | Logo strip: B4 Uni schools, Vibes of Light | These are the owner's own or related businesses; the FTC treats an undisclosed material connection as deceptive, and the fake-review rule (effective Oct 2024) bans insider testimonials without clear disclosure | Lawyer, Owner | Show them as "built with" or "design partner (operated by our founder)", not as independent customers | Written permission from each school; disclosure wording from the lawyer |
| 4.5 (P1) | Testimonials and case studies | None exist; Autumn's site has Autumn's (Firecrawl, Mintlify, T3) which must not carry over | Owner | None at launch; collect from design partners with signed consent | Design-partner agreement with a testimonial clause |
| 4.6 (P1) | Numbers ("214 events", "212/214 matched") | Brand copy uses example numbers; FTC requires substantiation for objective claims | Owner | Label as example output from the fixture | Generate from `fixtures/vibes-year` so they are real |
| 4.7 (P1) | Security and AI claims | "audited", "replayable" are fine; anything about SOC 2, encryption at rest or "AI that closes your books" needs proof | Owner, Lawyer | No certification claims; no Rifo capability claims until it works | — |
| 4.8 (P1) | "Open source" wording | An FSL engine can't be called open source | Owner | Decided 2026-11-06: say "source-available", "Fair Source" or "free to self-host" for the engine; "open standard", "open spec" and "open verifier" are fine because those parts are Apache-2.0 | Done (Decide first 5) |

## 5. Pricing page

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 5.1 (P0) | Show prices publicly before cloud exists? | Prices are "assumptions to test"; publishing anchors them | Owner | At waitlist launch, show Community ($0) and "cloud from $0, paid plans from $29 (early access)" only | Design-partner price tests first (`business-plan.md` section 11) |
| 5.2 (P1) | Which tiers show a price vs "contact us" | Platform, Witness API and the bookkeeper bundle need partner terms | Owner | Price Community, Free, Starter, Pro; "early access" for Witnessed; "talk to us" for Platform and the bundle | — |
| 5.3 (P1) | Witnessed tier on the page before the witness exists | Selling an unbuilt product invites FTC and refund problems | Owner, Lawyer | Waitlist only, labelled "planned" | — |
| 5.4 (P1) | Annual toggle | Plan gives Pro $790/yr and Witnessed $1,490/yr | Owner | Show monthly only at launch | — |
| 5.5 (P1) | How to explain events and credits | The plan says owners should see a flat plan; developers see usage | Owner | Owner view: "for schools up to about N families"; a "how limits work" accordion; developer view on a separate page | Get real events-per-family numbers from design partners (the 81 events/family estimate is one fixture family) |
| 5.6 (P1) | Comparison table naming QuickBooks, Xero, Digits, Puzzle, Pilot | The FTC's comparative-advertising policy (16 CFR 14.15) allows truthful, named comparisons; competitor prices change and most figures came from aggregators | Lawyer, Research | Allowed; cite the vendor's own page and date on the page; compare objective facts only (price, user caps); no logos | Recheck vendor pages the week of launch; add a dated footnote |
| 5.7 (P1) | Compliance pack price ($15–30 per program) | The product isn't built and program rules are unsettled | Owner | Not on the page at launch | — |
| 5.8 (P2) | Sales tax on SaaS (Idaho, Utah and others) | Affects whether prices show "+ tax" | Research, Lawyer | Show "plus applicable tax" | Check SaaS taxability per state before the first paid signup |

## 6. Product state, docs and the open standard

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 6.1 (P0) | What is live vs waitlist | Cloud doesn't exist. What exists: the self-hosted engine and the `tfd` CLI (0.9.0, GitHub tarball), receipts and seals on `dev`, ledger-ui for one tenant | Owner | Every page marks features as Available (self-hosted), Preview, or Planned | One status table on the site, updated per release |
| 6.2 (P0) | "Start free" button target | No cloud Free tier | Owner | "Join the waitlist" and "Self-host it" | — |
| 6.3 (P1) | Where the spec lives | Plan phase 0: spec v1 in its own repo with test vectors; not done | Owner, Engineering | A receipt-spec repo in the Trifold GitHub org; the site links to it | Create when the spec is frozen |
| 6.4 (P1) | Docs site stack and host | `apps/docs/mintlify` is Autumn's Mintlify docs (`"name": "Autumn"`, Autumn logos); the website redirects `/docs` to docs.useautumn.com | Owner, Engineering | New docs for `tfd` only, from `packages/atm/README.md` and `docs/`; Mintlify or a static generator | Decide whether to pay for Mintlify; don't reuse Autumn's docs |
| 6.5 (P1) | CLI name on the site | The CLI already answers to `tfd` as well as `atm`; the package and directory rename comes after open PRs land | Owner, Engineering | Decided 2026-11-06: the site shows `tfd` commands and says "the `atm` command until the rename lands" once | Package and directory rename task in `packages/atm` |
| 6.6 (P1) | Changelog and roadmap pages | `packages/atm/ROADMAP.md` and release notes exist | Owner | Publish a changelog from GitHub releases; no public dated roadmap | — |
| 6.7 (P2) | MCP server and API pages | The brand outline lists them; neither exists for Trifold | Owner | Leave out | — |

## 7. The public "verify a receipt" page

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 7.1 (P0) | Does the page exist at launch? | It's the growth loop and the proof; ROADMAP says "not planned here: a verify web page" | Owner, Engineering | Yes, as the one real product page: paste or drop a receipt file, check it in the browser | Build from `verifyReceipt` in tfd (pure, never throws) |
| 7.2 (P0) | Client-side only, or upload to a server? | Receipts hold amounts and possibly a child's name later; privacy and FERPA exposure | Engineering, Lawyer | Verify entirely in the browser; nothing sent; say so on the page | — |
| 7.3 (P1) | Key discovery for other issuers | Verifying a buzz-school receipt needs its `keys.json`; other issuers need a lookup rule | Engineering | The receipt names its issuer's domain; the page fetches `/.well-known/trifold-keys.json` from there (needs CORS) | Add to the spec |
| 7.4 (P1) | What a "valid" result promises | "Signature valid" ≠ "the money moved" (no Stripe matching yet) | Lawyer, Owner | Result text: "Signed by [issuer] and unchanged since." Nothing about payment or tax eligibility | Lawyer review of result wording |
| 7.5 (P1) | Neutral or Trifold-branded verifier | A standard others adopt needs a neutral verifier; the plan's loop wants a Trifold link | Owner | Trifold hosts it with "works for any issuer using the open receipt standard" | — |

## 8. Legal pages

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 8.1 (P0) | Legal entity name and address | Needed for every legal page and the footer | Owner, Lawyer | — | Form or confirm the entity |
| 8.2 (P0) | Privacy policy | Required by CalOPPA for any site collecting personal data from Californians, by app stores and Stripe's marketplace, and by most state laws. Autumn's policy ("Autumn (Rebase, Inc.)") is in `apps/website/app/privacy` and must not be reused | Lawyer | A short policy covering the site, waitlist, analytics and email; a separate one for the product at cloud launch | Lawyer drafts; list every processor (email, analytics, host) first |
| 8.3 (P0) | Terms of use for the site and waitlist | Contract terms for signups | Lawyer | Short site terms now; full SaaS terms at cloud launch | — |
| 8.4 (P1) | State privacy law applicability | Utah's UCPA applies only above $25M revenue plus data thresholds, so it likely doesn't apply yet; Texas and Nebraska have no revenue threshold; Idaho not researched | Lawyer, Research | Write the policy to the stricter common baseline anyway | Lawyer checks Idaho and the states of early customers |
| 8.5 (P1) | Cookie consent | Needed under GDPR/ePrivacy for non-essential cookies for EU visitors; avoidable with cookieless analytics | Owner, Engineering | No non-essential cookies, so no banner; geo-limited banner only if marketing pixels are added | Pick analytics (section 10) |
| 8.6 (P1) | Data processing agreement (DPA) | Schools and businesses will ask; B2B buyers expect one | Lawyer | Publish a standard DPA at cloud launch | — |
| 8.7 (P1) | Student data and FERPA statement | FERPA binds schools that receive federal education funds, not vendors directly; vendors act under the "school official" exception by contract. Many private microschools take no federal funds. Utah's third-party contractor rules (53E-9-309) seem aimed at public entities; Idaho not checked | Lawyer, Research | A "Student data" page: no student personal data in signed receipts; Trifold acts as the school's service provider; no sale of data | Lawyer confirms per school type; check Utah 53E-9-301 definitions and Idaho's student data act |
| 8.8 (P1) | Tax-prep disclaimer | Paid preparers need a PTIN; Trifold never signs returns | Lawyer | Footer and pricing note: "Trifold prepares tax-ready books. It doesn't prepare or file tax returns or give tax advice." | Lawyer wording |
| 8.9 (P1) | Witness terms | What "Trifold saw this record at time T" promises and limits liability | Lawyer | Not public until Witnessed exists | Lawyer drafts with the plan's narrow definition |
| 8.10 (P1) | Licensing page | Explains the Apache-2.0 format and verifier, the FSL engine (each release becomes Apache-2.0 after two years), CC0 test vectors, the proprietary cloud, and contributor terms | Owner, Lawyer | One plain page with the licensing table from `business-plan.md` section 5 | — |
| 8.10a (P1) | Licensor legal entity name | The engine's `LICENSE` names "Trifold" until a company is formed | Owner, Lawyer | Keep "Trifold" until the entity exists, then update every `LICENSE` and the site footer | Decided together with Decide first 7 |
| 8.10b (P1) | Accounting firms hosting tfd for many clients | FSL allows professional services to a licensee (an accountant on a client's own install) but may not cover a firm hosting many clients | Owner, Lawyer | Decide whether an extra grant is needed before the accountant partner program starts | Lawyer reads the FSL clause against the partner program terms |
| 8.10c (P1) | Contributor terms | No outside contributions yet | Owner, Lawyer | DCO or CLA, chosen before the first outside contribution | — |
| 8.10d (P2) | Event envelope schema license | The receipt and seal schemas are Apache-2.0; the envelope schema is under the engine's FSL | Owner | Consider Apache-2.0 so other ledgers can adopt the full standard | — |
| 8.11 (P1) | Trademark policy page | Reserves Trifold and "Witnessed by Trifold"; forks must rename | Lawyer | Publish with `TRADEMARKS.md` after clearance; use ™ not ® until registered | Clearance search, then filing |
| 8.12 (P1) | Accessibility statement | No binding federal Title III web rule for private businesses, but courts and settlements use WCAG 2.1 AA, and website ADA suits rose to about 3,100 in 2025 | Owner, Engineering | Build to WCAG 2.1 AA; publish a statement with a contact | Audit before launch (section 15) |
| 8.13 (P2) | COPPA | The site targets adults; COPPA matters only if children use a product page | Lawyer | State the site isn't directed to children under 13 | — |

## 9. Signup, waitlist, CRM and email

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 9.1 (P0) | Waitlist form: what fields, where stored | Personal data, consent, CRM import later | Owner, Engineering | Email, role (school owner, CPA, developer), state, family count; store in a simple DB or form tool | — |
| 9.2 (P0) | Email sending and domain auth | SPF, DKIM, DMARC on the chosen domain; CAN-SPAM needs a postal address and unsubscribe | Engineering | A transactional sender on a subdomain (e.g. `mail.gettrifold.com`) | Depends on 2.1 and 8.1 |
| 9.3 (P1) | CRM | Design partners and CPA partners need tracking | Owner | A spreadsheet or lightweight CRM until 100 leads | — |
| 9.4 (P1) | Newsletter tool | Tax-season campaign, changelog | Owner | Defer; one tool for both waitlist and newsletter | — |
| 9.5 (P1) | Double opt-in | Better deliverability and consent records | Owner | Yes | — |
| 9.6 (P2) | CPA partner application form | The Accountants page needs a call to action | Owner | Simple form into the CRM | — |

## 10. Analytics and privacy

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 10.1 (P0) | Which analytics | Autumn's site loads RB2B (person-level visitor identification, using Autumn's key `4N210HX5V56Z` in `apps/website/components/reb2b.tsx`) and a Bydefault tracker (`apps/website/proxy.ts`). Visitor de-anonymisation contradicts "calm, plain, exact" and a privacy-first schools pitch | Owner | No RB2B; cookieless, aggregate analytics (e.g. Plausible, Cloudflare Web Analytics or Vercel Analytics) | Owner choice; list the processor in the privacy policy |
| 10.2 (P1) | Ad pixels (Meta, Google) for the studio and Instagram channel | Pixels need cookie consent and a privacy notice update | Owner | None at launch | — |
| 10.3 (P1) | Conversion events to track | Waitlist signup, verify-page use, GitHub clicks | Owner | Those three | — |

## 11. Hosting, stack and DNS

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 11.1 (P0) | Who owns DNS and in which account | Domains, email auth and keys.json all depend on it | Owner | One Cloudflare account owned by the company, not a personal one (Cloudflare already hosts the `atmn.lol` QA zone and ledger.b4uni.com) | Check which account holds tfd.dev and b4uni.com |
| 11.2 (P0) | Stack and deploy target | Autumn's site is Next.js 16 targeting Vercel; the repo's newer work (ledger-ui, qa-envs) runs on Cloudflare Workers | Engineering, Owner | A static site (Astro, or Preact/Vite like ledger-ui) on Cloudflare Workers static assets; the verifier as a client-side island | Owner picks Vercel or Cloudflare once |
| 11.3 (P1) | Monorepo or separate repo | `justbry/atm` is a public Autumn fork; the site could live in `apps/` or its own repo | Owner | Its own small repo, or `apps/trifold-site` here; don't edit `apps/website` (keeps the upstream merge clean, per `UPSTREAM.md`) | — |
| 11.4 (P1) | CI and previews | No workflow deploys `apps/website` today | Engineering | Preview per PR, production on merge to the default branch | — |
| 11.5 (P2) | CMS for blog and pages | Markdown in git is enough at first | Owner | MDX in git | — |

## 12. SEO and content

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 12.1 (P1) | Ranking for "Trifold" | The Samsung Galaxy Z TriFold phone, trifold brochures and Trifork (a fintech IT company) dominate results | Research, Owner | Target phrases, not the brand alone: "signed receipts for microschools", "Idaho parental choice tax credit receipts", "Stripe books for schools" | Keyword research before writing pages |
| 12.2 (P1) | Comparison pages ("Trifold vs QuickBooks") | Good SEO; must be truthful and dated (5.6) | Owner, Lawyer | Two at launch at most: QuickBooks and Xero | — |
| 12.3 (P1) | Blog at launch | Autumn's 25 posts in `apps/website/content/blog` are Autumn's and must not be reused | Owner | Three posts: the triple-entry idea (Grigg 2005) in plain words, how a signed receipt works, a state-program receipt explainer (after legal review) | — |
| 12.4 (P2) | `llms.txt` and markdown-for-agents | Autumn's site does this (`app/llms.txt`, `proxy.ts` content negotiation); fits the developer audience | Engineering | Keep the pattern | — |
| 12.5 (P2) | Program-specific landing pages | High intent, but legally sensitive (4.3) | Owner, Lawyer | After CPA-reviewed receipts exist | — |

## 13. The existing website app in the repo (facts)

- `apps/website` is **Autumn's marketing site**, package `@autumn/website` v0.1.0: Next.js 16.2.4, React 19, Tailwind 4, MDX, GSAP, Lottie and motion animations; dev on port 3004.
- It is Autumn-branded throughout: `app/layout.tsx` hard-codes `https://useautumn.com`; `app/privacy` and `app/terms` are Autumn's legal pages ("Autumn (Rebase, Inc.)"); `content/blog` holds 25 Autumn posts; `public/images/customers` holds Autumn customer photos (Firecrawl, Mintlify, T3); `next.config.mjs` redirects `/docs` to `https://docs.useautumn.com`.
- Tracking: RB2B visitor identification with Autumn's key (`components/reb2b.tsx`, CSP hosts in `next.config.mjs`), a Bydefault tracker in `proxy.ts` (no-op without `BYDEFAULT_TOKEN`), `@vercel/analytics` listed as a dependency but not imported.
- Hosting: Vercel-oriented (README, `@bydefault/vercel`), with no `vercel.json` in `apps/website` and no GitHub workflow that deploys it. The repo's other Vercel configs are `vite/vercel.json` and `apps/checkout/vercel.json`.
- Cloudflare: `apps/twd/qa-envs/wrangler.jsonc` (QA envs on the `atmn.lol` zone). `packages/ledger-ui` is Preact on Vite, "served as static assets by a Worker" for ledger.b4uni.com (no wrangler file in the package).
- Docs: `apps/docs/mintlify` is Autumn's Mintlify docs (`docs.json` `"name": "Autumn"`, Autumn logos).
- No file under `apps/` mentions Trifold or Trivalance. The names appear only in `docs/business/*`, `packages/atm` (README, ROADMAP, UPGRADING, `src/cli.ts` default key id `trifold-YYYY-MM`, types, a test).
- **Conclusion:** a Trifold site is a fresh build, not a rebrand. Rebranding `apps/website` would mean replacing every page, asset, legal text and tracker, and would conflict with upstream merges. **Risk:** deploying `apps/website` as it is would send visitor data to Autumn's RB2B account.

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 13.1 (P1) | Keep or delete `apps/website` in the fork | Dead weight, and a risk if deployed by mistake | Owner | Leave it (upstream parity); never deploy it | Note in `UPSTREAM.md` |

## 14. Support, status and security

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 14.1 (P1) | Support channel | Stripe's marketplace requires valid contact info; families will write in about receipts | Owner | `support@` email; GitHub Discussions for developers | — |
| 14.2 (P1) | Who answers families vs schools | A family's receipt question belongs to the school | Owner | The verify page says "questions about a payment go to your school" | — |
| 14.3 (P1) | Security page and disclosure | Developers and CPAs expect `security.txt` and a disclosure address; the key-compromise plan is in the business plan | Owner, Engineering | `/.well-known/security.txt`, a security page describing keys, revocation and what's not yet built; no certifications claimed | — |
| 14.4 (P2) | Status page | Matters once cloud exists | Owner | None until cloud; then a hosted status page | — |

## 15. Accessibility

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 15.1 (P1) | Target standard | See 8.12 | Owner | WCAG 2.1 AA, aiming at 2.2 AA | — |
| 15.2 (P1) | Animation | Autumn's site is animation-heavy; motion needs `prefers-reduced-motion` | Engineering | Minimal motion; respect reduced motion | — |
| 15.3 (P1) | Audit before launch | Contrast (1.5), keyboard, screen reader on the verifier | Engineering | Automated checks plus a manual pass | Run axe or Lighthouse and a screen-reader pass |

## 16. Stripe App (if the site promises one)

The plan lists a Stripe App in phase 1. If the site mentions it before it is listed:

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 16.1 (P1) | Whether to mention the Stripe App before approval | Review takes about 4 business days per submission and can be refused | Owner | Say "Works with Stripe", never "Stripe App" or "Stripe partner" until listed | — |
| 16.2 (P1) | Listing name | App names are capped at 35 characters and can't include "Stripe", "app", "free" or "paid"; one app per Stripe account | Owner | "Trifold" | — |
| 16.3 (P1) | Website requirements Stripe checks | Stripe's review requires the website to represent the value proposition accurately, with valid contact info; pricing must be transparent and match off-marketplace pricing | Owner | Have the pricing page and contact page live first | Read Stripe's publish-app and review-requirements pages before submitting |
| 16.4 (P1) | Use of Stripe's name and logo | Stripe's marks policy limits use; the brand doc already bans "signed by Stripe" | Lawyer | Text "matched against Stripe" only; no Stripe logo without following Stripe's brand guidelines | Read Stripe's marks usage page |
| 16.5 (P2) | Custom cryptography in the app | Stripe's review forbids custom crypto in Stripe Apps; Ed25519 must come from a vetted library | Engineering | Use Node's built-in crypto or a vetted library, as tfd does | — |

## 17. Launch plan and timing

| # | Unknown | Why it matters | Who decides | Recommended default | How to resolve |
|---|---|---|---|---|---|
| 17.1 (P0) | What launch means | Decide first 1 | Owner | Stage A (month 0–1): waitlist, verify page, standard and licensing pages, legal basics. Stage B (with cloud Free, phase 1): full site, pricing, solutions, docs | — |
| 17.2 (P1) | Launch date anchor | Tax season (Jan–Apr) suits "Taxes, Finally Done"; Idaho tax-credit receipt reconciliation runs to Dec 31, 2027 | Owner | Stage A before January 2027, so receipts can circulate in tax season | — |
| 17.3 (P1) | Launch channels | Hacker News and GitHub for the standard; Idaho and Utah school networks for schools | Owner | Launch the standard to developers first; schools through design partners | — |
| 17.4 (P1) | Who writes copy and who approves claims | Claims need one gatekeeper | Owner | Owner writes; lawyer reviews legal pages and the state-program, tax and witness lines | — |

## Naming collisions found

- **Samsung Galaxy Z TriFold** (foldable phone): dominates search for "trifold"; an SEO problem, not likely a trademark conflict in software services, but a lawyer should check Samsung's filings.
- **Trifork** (Swiss-listed IT company with a FinTech practice): similar name in software and fintech.
- **npm `trifold`**: a React swipe-layout library.
- **GitHub `trifold`**: an existing user account (since 2021).
- **TRIFOLD trademarks**: aggregator sites show a dead class 9 application (Incipio, serial 77941454) and a "tri fold" class 42 filing (serial 77000614, status unknown). Confirm in USPTO TSDR.
- **TRIBALANCE** and **"Trivalence"** no longer matter: the name Trivalance was dropped on 2026-11-06.
- No software or fintech company named "Trifold" turned up in web searches. That is a weak signal, not a clearance search.

## Sources

Repo (paths relative to the repo root): `apps/website/package.json`, `apps/website/next.config.mjs`, `apps/website/proxy.ts`, `apps/website/app/layout.tsx`, `apps/website/app/privacy/page.tsx`, `apps/website/components/reb2b.tsx`, `apps/website/content/blog/`, `apps/docs/mintlify/docs.json`, `apps/twd/qa-envs/wrangler.jsonc`, `packages/ledger-ui/package.json`, `packages/atm/package.json`, `packages/atm/ROADMAP.md`, `packages/atm/README.md`, `.github/workflows/release-atm.yml`, `LICENSE`.

Domain and handle checks, 2026-11-06: `whois` for each domain; Google registry RDAP for tfd.dev (https://pubapi.registry.google/rdap/domain/tfd.dev); `curl` for live sites; `npm view` for package names; `gh api users/<name>` for GitHub handles.

Naming:
- Trifork: https://inderes.fi/en/companies/Trifork-Group, https://trifork.com/?p=32206
- Samsung Galaxy Z TriFold: https://tech.yahoo.com/phones/articles/yes-samsung-z-trifold-real-181135204.html
- TRIFOLD trademark records (aggregators): https://markinton.com/trademark/trifold-77941454, https://markinton.com/trademark/tri-fold-77000614
- "Trivalence": https://skyeng.ru/vocabulary/trivalence/

State programs:
- Idaho Tax Commission, Parental Choice Tax Credit and Advance Payment: https://tax.idaho.gov/taxes/income-tax/individual-income/popular-credits-and-deductions/parental-choice-tax-credit-and-advance-payment/
- Idaho 2026 bills S1281 and H0934 (passage not confirmed): https://legislature.idaho.gov/wp-content/uploads/sessioninfo/2026/legislation/S1281.pdf, https://legislature.idaho.gov/wp-content/uploads/sessioninfo/2026/legislation/H0934.pdf
- Utah Fits All providers (Odyssey): https://support.withodyssey.com/hc/en-us/articles/37494425843611-Who-can-be-a-Utah-Fits-All-Scholarship-provider
- Utah Fits All ruling and appeal: https://www.deseret.com/politics/2025/04/18/utah-judge-strikes-down-scholarship-program-school-choice, https://utahnewsdispatch.com/?p=10111, https://kutv.com/news/local/families-await-utah-supreme-court-decision-on-school-voucher-program
- Utah 2026 HB 467 (enrolled): https://le.utah.gov/Session/2026/bills/enrolled/HB0467.pdf

Legal and advertising:
- FTC rule on fake reviews and testimonials (Aug 2024): https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/ftc-finalizes-rule-on-fake-reviews, https://maynardnexsen.com/publication-ftc-issues-final-rule-banning-fake-reviews-and-testimonials
- FTC comparative advertising policy, 16 CFR 14.15: https://www.law.cornell.edu/cfr/text/16/14.15, https://www.ftc.gov/node/52436
- ADA and WCAG for private sites: https://www.boia.org/blog/is-wcag-required-by-the-ada, https://www.levelaccess.com/ada-compliance-how-does-the-ada-apply-to-a-website/, https://testparty.ai/blog/ada-compliance-2026
- SaaS legal pages (secondary): https://merge.rocks/resources/websites-playbook/what-legal-compliance-pages-should-a-saas-website-include, https://termly.io/resources/website-checklist, https://secureprivacy.ai/blog/cookie-consent-for-saas-companies
- State privacy thresholds: https://perkinscoie.com/sites/default/files/2025-11/11.2025%20threshold-requirements.pdf, https://www.ropesgray.com/en/sites/state-privacy-law-tracker/states/utah
- FERPA and vendors: https://blog.promise.legal/edtech-school-district-vendor-agreement/, https://www.mwe.com/?p=292945 (primary text: 34 CFR 99.31, https://studentprivacy.ed.gov)
- Utah student data, third-party contractors: https://law.counselstack.com/statute/ut/53E-9-309, https://le.utah.gov/Session/2026/bills/enrolled/HB0055.pdf

Stripe Apps:
- Publish an app: https://docs.stripe.com/stripe-apps/publish-app
- Quality and review requirements: https://docs.stripe.com/stripe-apps/review-requirements
- Distribution options: https://docs.stripe.com/stripe-apps/distribution-options

Not yet researched (open): Idaho's consumer privacy and student data laws; SaaS sales tax by state; Stripe marks guidelines; the current text of Utah 53E-9-301; whether Idaho S1281 or H0934 passed.
