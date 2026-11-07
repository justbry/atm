# Round 1 review: conversion and go-to-market (Sonnet)

Verdict: the trust thesis is right and the brand work is strong, but the site is written for a skeptical fintech buyer, not for the person you named as the first market: a microschool owner in Idaho or Utah. That owner will bounce on "Books you can prove." Fix who the page talks to, what the button does, and how much you build before launch.

## Top 5 changes, ranked by impact

1. **Make the homepage speak to the first market, not the category.** "Books you can prove" is a category line for CPAs and developers. A microschool owner (the brand doc's ICP 2: "itemised receipts per child for tax credits and ESAs") reads it as abstract and does not know it is for them. Headline must name the job and the person. Keep "provable" as the second beat. 5-second test fails today: no school, no family, no Stripe, no outcome above the fold.
2. **Replace "Start free" with an honest waitlist or design-partner CTA, and change the label.** Cloud is not live. "Start free" in the header, hero and every page end promises something you cannot deliver and then lands on a form. That is a trust leak for a trust brand. Use "Join the design-partner list" (specific offer: onboarding by the founders, free during pilot, named in the case study). One action, one form. Single-purpose pages convert better and a vague waitlist underperforms a concrete offer ([LaunchList](https://getlaunchlist.com/blog/waitlist-landing-page-examples-that-convert)). Do not offer self-serve you cannot serve.
3. **Cut the v1 sitemap from 18 pages to about 9.** Pre-launch with one ICP, you cannot keep five `/for/*` pages, `/rifo`, `/standard`, `/changelog` and `/roadmap` honest and current. Details in the proposed sitemap below. Rifo is not shipped; a whole page on it is a promise page.
4. **Prove it with one real receipt before anything else.** The best asset is the receipt a family gets and the verify button. Move the live receipt up to section 2, right under the hero. It is the only thing that makes "provable" concrete, and it is the one thing Airtight cannot show from your repo. Today it is section 6, after a problem section and a scroll chapter that are all assertion.
5. **Reframe the category and differentiation, because Airtight owns "triple-entry + Ed25519."** "Provable books" is acceptable but thin: it is a feature claim, and Airtight is already within one search of it. Your durable differentiator is *who can check, and for how long*: a free verifier anyone can run, open formats, and your books outliving Trifold. Own "books that outlive any app, including ours" as the lead proof and make the open verifier the demo. Also the messaging doc says to avoid "triple-entry" until shipped but the brand doc's tagline is "Three sides of every dollar"; keep the tagline, drop the triple-entry explainer from v1.

## Other findings

- **Four pillars are not distinct.** Provable and Resilient overlap (replay and seal verification are both "you can check it"); Fast is not trust at all and is the weakest, with no shipped proof ("closed in minutes" depends on unshipped Rifo and Cloud). Collapse to three that map to shipped things: **Provable** (receipts, seals, verifier), **Durable** (open formats, export, self-host, replay), **Yours** (you can leave with everything). Make Fast a proof detail, not a pillar. Four with one unproven reads as padding.
- **The pillars' "Proof on the site" cites unshipped things** (status page, key rotation demo, 214-event animated close with Rifo). Each is a claim you cannot show. Replace with what exists: `tfd verify`, Parquet export, hledger file.
- **Objections unanswered:** (a) "Will my state accept these receipts?" is in the brand doc but not on any page; for Idaho/Utah it is the first question, and I found no authoritative public source for current Utah ESA or Idaho credit documentation rules, so confirm with the programs and a CPA before claiming anything ([Savvy Learning](https://savvylearning.com/blog/microschools-and-esa/) is only a vendor blog). (b) "Who are you, and will you exist next year?" for a pre-launch startup that sells durability. (c) "I already have QuickBooks / Mindbody." (d) "What happens to my data if you go away?" (answer is your best story; it is buried in `/trust`). (e) "What does it cost?" The owner wants to know without a slider.
- **No social proof.** Brand doc names B4 Uni and Vibes of Light as a logo strip; the website plan drops it. Real names beat any pillar. Add them, with permission and a quote.
- **GTM is thin for the stated market.** Ideas 1, 2 and 4 serve developers and trust-curious buyers, not microschool owners. Missing: partnering with microschool networks and state choice groups (the brand doc lists them as channels, messaging.md omits them), Idaho/Utah CPA firms that serve schools, ESA vendor-list placement, and founder-led outreach to 30 named schools. Idea 7 (month-end email) is good; idea 1 (receipt as ad) is the best loop, but only if a receipt shows a human-readable "Verify" link and the page works for a parent in 10 seconds. Utah ESA demand is strong (about 27,000 applicants for 10,000 scholarships per [MarketScale](https://www.marketscale.com/industries/education-technology/with-esa-demand-outpacing-supply-how-can-utah-expand-microschool-access)), so owners are actively seeking compliance help; lead with that.
- **Audience paths:** five doors is too many for pre-launch. Two doors are enough: owners and their CPAs. Developers get the repo link in the footer. Verifiers need only `/verify`.
- **Hero stat in problem section** quotes Intuit via a secondary summary; the audience is small-business owners generally, not microschool owners. It is a category stat that costs a full scroll chapter. Cut to one line or drop for v1.
- **Design risk to conversion:** pinned scroll chapters, 600-point canvas, spotlight cursor and aurora fight "calm, plain, exact." The brand guide's own principle is fast and readable; the LCP < 1.5s target is right. Ship hero + one pinned chapter for v1; skip aurora and spotlight cursor.

## Line-level suggestions

**messaging.md**

- Line 20, `Headline: Books you can prove.` Replace with: **"Every tuition payment, a receipt your families can check."** Subhead: "Trifold turns your Stripe payments into signed receipts and sealed monthly books, so tax time, your CPA and your state program stop being a scramble." Keep "Books you can prove" as the section 2 label.
- Line 13: "an open standard, a free verifier, and an independent witness." The witness is not shipped. Replace with "an open standard and a free verifier anyone can run."
- Line 57, `Start free` for owners. Replace with `Join the design-partner list`.
- Line 15, `Category: provable books.` Add: "Say it as 'books that anyone can check' in plain copy. Use 'provable' as a label, not the whole message."
- Line 14: "Unlike AI bookkeeping tools that ask you to trust their output" is the right contrast but never state it on the homepage (you rule out naming competitors). Use: "Most software asks you to trust it. This lets you check."
- Line 35, "Low cost appears only as a fact in pricing." Fine, but the pricing teaser section (Free tier, $29) will read as the offer. Do not show prices before cloud exists; show "Design partners: free during pilot."
- Line 91 vs 94: "witness" is in the Use column but not shipped. Move to Avoid until milestone.
- Lines 78-85 GTM: add schools-network partnerships, Idaho/Utah CPA firms and 30 named-school outreach as items 1 to 3; demote HN to 6.

**sitemap.md**

- Line 27 header: "How it works · Trust · Pricing · Solutions · Verify · [toggle] · Start free". Replace with: `How it works · Schools · Verify · For CPAs · [toggle] · Join the pilot`. Cut Pricing and Trust from nav until cloud ships.
- Line 35, CTA `Start free ... Waitlist / design-partner form until Cloud ships`. This admits the problem. Fix the label, not only the destination.
- Home section 2, "The problem": cut or merge into the hero.
- Home section 5, "Built for" five audience tabs: replace with the school story plus one "Also for" line.
- Home section 7-8, Roadmap and Pricing teasers: remove for v1. A roadmap strip on the homepage tells the owner what does not work yet.
- Add a **FAQ block** to the homepage covering the five objections above, and a **people block** (founder photo, B4 Uni, Vibes of Light). Pre-launch trust is people.

**brand-guide.md**

- Line 89 status pill `● LEDGER BALANCED · 214 EVENTS · OCT SEALED` on the hero implies live product. Label it "Sample" or show it inside the demo receipt card, never as a site-wide live status.
- Line 106: components list includes "status pill" in footer ("status pill" in sitemap line 29). No status page exists. Remove.
- Section 6: drop the aurora band and spotlight cursor for v1; they carry no meaning by your own rule (line 16).

## Proposed v1 sitemap (9 pages)

```
/               Home: hero (school headline) → live receipt + Verify →
                what happens to one payment (3 chapters, one pin) →
                three pillars → people / B4 Uni + Vibes of Light →
                FAQ → design-partner form
/schools        The microschool page (state receipts, ESAs, families, CPA)
/how-it-works   One payment, three records, the monthly seal; what it
                catches; what it does not yet (honest Now/Next)
/verify         Free verifier (no account)
/accountants    One page, partner interest form, year-end package
/trust          Data ownership, export, open formats, security, claim rules
/about          Founders, why Trifold, open core
/legal          Terms, privacy
GitHub / docs   Footer link out, for developers; no /for/developers page
```

Deferred until after launch: `/pricing` (show design-partner terms on `/schools`), `/rifo`, `/roadmap` (fold a 3-line Now/Next into `/how-it-works`), `/standard` (link the spec repo), `/changelog`, `/for/studios`, `/for/nonprofits`, `/for/developers`. Studios and non-profits get a "Join the list for studios" checkbox on the form, not pages.

Sources: [LaunchList waitlist examples](https://getlaunchlist.com/blog/waitlist-landing-page-examples-that-convert), [MarketScale on Utah ESA demand](https://www.marketscale.com/industries/education-technology/with-esa-demand-outpacing-supply-how-can-utah-expand-microschool-access), [Savvy Learning microschool ESA records](https://savvylearning.com/blog/microschools-and-esa/).
