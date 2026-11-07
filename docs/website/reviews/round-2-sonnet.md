# Round 2 review: claims audit and audience paths (Sonnet)

Verdict: the round-1 fixes landed. The remaining risk is a handful of sentences that say more than the shipped list supports. Fix the wording below; the structure can stay.

## 1. Claims audit

| Claim (where) | Problem a CPA or journalist would raise | Safer wording |
|---|---|---|
| "Not even Trifold can quietly change your books." (messaging §4, home ch.03) | False as written. No per-event chain, no witness, and Trifold would hold the signing key, so it could rewrite events and re-sign. Edits inside an open month are undetectable. | "Change a sealed month and the seal stops matching. Keep your copies and you can show it." (Receipts and seals held outside our servers are the real protection. Say that.) Keep the punchy version only after the witness ships. |
| "records outlive any app, including ours" (subhead, positioning) | Overreach as a promise. True parts: open-format export, receipts and seals verify with a free tool. License is undecided, so "free to self-host" and "open standard/spec" may not hold. | "Your books export in open formats. Receipts and seals check with a free tool, with or without us." Say "open" or "self-host" only after the license and spec are published. |
| "rebuilt byte-for-byte" (§4 Resilient) | Only defensible if a golden test proves it. "Lose everything but the events" omits that the events must survive somewhere. | "Lose the books, keep the events, and replay gives the same balances and journals." Add "Back up your events" in /trust. Drop "byte-for-byte" unless the test is linked. |
| "A year of books rebuilt in seconds" (§4, home ch.04) | Volume-dependent, unmeasured, and placed under the unshipped Close chapter. | "A small school's year replays in seconds on a laptop (measured: N events, N seconds)." Publish the benchmark or cut it. |
| "every payment becomes a receipt" | Only Stripe payments; cash and checks sit outside. | "Every Stripe payment." |
| "Every month is sealed" | Shipped is sealing on request. Automatic monthly sealing needs the hosted service. | "Each month can be sealed." Use "is sealed" once Cloud runs it. |
| "books arrive closed" (accountants) | "Closed" implies the Rifo close, which is Next. | "Books arrive sealed and traceable." |
| "Year-end package", "free partner seats" (accountants proof) | A tax package and hosted seats don't exist. | "Sample export: hledger, CSV and a sealed month you can verify." |
| "tax-ready" (§11 Use column) | Tax packages are unshipped. | Move to Avoid until they ship. |
| "matched" (§11 Use column) | Daily payout matching is unshipped; on-demand reconcile is. | "reconciled on request." |
| Donor "checks that their gift was acknowledged" (§6) | Donation acknowledgments are Later. | "A donor verifies a receipt for their gift." |
| Parent "checks the receipt their state program asked for" (§6) | Implies program acceptance, which §8 disclaims. | "A parent checks any tuition receipt." |
| "Trifold syncs out" to QuickBooks/Xero (§8) | Sync isn't shipped. | "Export to CSV and hledger." |
| "Is AI touching my numbers? No… you approve" | Describes an unbuilt agent. | See FAQ 5. |
| Sample receipt "child, hours, EIN" | Confirm the receipt schema carries these. A child's name on a signed artifact is also a privacy question. | Confirm, then state that checking runs in the browser and sends nothing. |
| Names (B4 Uni, Vibes of Light) | No approvals. | Ship placeholders only. |
| Intuit and Utah stats | Secondary sources. | Fine on /trust with dates. Don't put them on the homepage. |

"Verify a sample receipt" and the inline verifier need the in-browser verifier, which is unbuilt. It is a launch blocker. Without it, the secondary CTA and chapter 03 have nothing to show.

## 2. Audience paths

- **School owner.** Hero, eyebrow, "Get early access", form. Clear. Missing: what happens after submitting (reply time, who replies), a sample receipt on `/for/schools` (not only the homepage), a one-line plain definition of "sealed", and trackable links for the 30 named schools (`?src=`). Also decide whether the owner sees prices before the form.
- **Accountant.** CTA "Become a partner" has nothing to partner on yet. Make it "Review a sample client file": downloadable export plus a sealed month. Say plainly what you review and that you aren't attesting anything.
- **Studio.** Rests on an unapproved story. Until approved, lead with credits and packs balances (check this ships) and use the school sample.
- **Non-profit.** "See non-profit pricing" before any product is a dead end. Use "Get early access". Pricing for a free tier needs the witness; mark it "planned".
- **Developer.** "Install the CLI, free" is right, but the first question is the license. Publish it, or say "license being finalized" on the page. Never say "open source" under FSL; say "source-available".
- **Parent verifying.** The weakest path and the best funnel. A parent won't paste JSON. The receipt link must open `/verify` with the receipt prefilled (URL fragment, no upload). No sales nav or early-access banner on arrival. Show a plain result: "Signed by [school], $X, [date], unaltered." Include "What a pass proves, and what it doesn't" and "Questions? Ask your school." Add the CTA only below the fold.

## 3. Round-1 concerns

Addressed: headline and audience, CTA honesty, FAQ, people block, GTM order, verifier moved up, status pill relabelled, Airtight differentiation, unshipped proofs removed, witness moved to Next.

Not addressed, with verdict:
- **14 pages, not 9.** Justified. The owner asked for pricing, roadmap and audience pages. Condition: studios, non-profits and developers pages stay one screen each at launch.
- **Four pillars including Fast.** Justified by the owner's wording, but Fast has no benchmark yet. Publish one or demote it to a detail line.
- **Full pricing page (slider, matrix) before Cloud.** Partly justified (owner requested). Add "Planned pricing at launch, subject to change. Design partners: free during the pilot." Don't show a live checkout feel.
- **Roadmap on the homepage.** Justified by the owner's end-to-end vision. Label chapters in text ("Today", "Next", "Later"), not colour alone.
- **Trust missing from the nav** though trust is the message. Put "Trust" in the nav, replacing "Accountants" under a "For" menu, or add it as a sixth link.

## 4. FAQ copy (final)

**1. Will my state program accept these receipts?**
We don't know yet, so we won't say yes. Each program sets its own rules. We're building receipts to the published rules and checking them with CPAs. Until a program confirms, we say "designed for", never "accepted by". Ask your program before you rely on any record, ours included.

**2. Will you be around next year?**
We plan to be, but you don't have to bet on it. Your books export in open formats (Parquet, hledger, CSV). Receipts and sealed months can be checked with a free tool that doesn't need us. [Add once the license is settled: You can also run the engine yourself.]

**3. I already use QuickBooks or Mindbody.**
Keep them. Trifold doesn't replace them. It builds a second set of books from your Stripe payments, with receipts and sealed months, that you can export for your accountant. Direct sync to QuickBooks and Xero isn't built yet.

**4. What happens to my data if you go away?**
It's yours to download any time, in open formats. Receipts and sealed months stay checkable with the free verifier, with or without Trifold. What you'd lose is the hosted service, not your records.

**5. Is AI touching my numbers?**
No. Today every number comes from fixed rules: the same payments always give the same books. Rifo, our AI assistant, isn't live. When it is, it will explain and suggest, cite the payments behind each answer, and never change a number without your approval.

**6. What does it cost?**
Design partners pay nothing during the pilot and get onboarding from the founders. Planned prices are on the pricing page and may change before launch. Checking a receipt or a seal is always free.
