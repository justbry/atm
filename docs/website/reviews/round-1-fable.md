# Round 1 review: brand, narrative and motion

Reviewer: Fable. Scope: `brand-guide.md`, `messaging.md`, `sitemap.md`, against the balnce.ai reference and the shipped/unshipped line.

## Top 5 changes, by impact

1. **Make "proof is light" carry the roadmap, not just the hero.** The guide's own rule ("we never use light as decoration alone") is broken by two of its five effects (aurora band, spotlight cursor). Fix it by giving the idea one more job: *shipped glows, roadmap is unlit.* Homepage chapters become `01 MONEY IN · 02 BOOKS · 03 PROOF · 04 CLOSE · 05 TAXES · 06 FINANCE`; 01–03 are lit, 04 (Rifo) is a warm ember "Next", 05–06 are outlined and dim. Honest staging becomes the visual signature and the roadmap stops being a separate story.

2. **Fix the hero's claim problem.** The guide's fourth state is "a witnessed seal throws a halo"; witness, hash chain and payout matching are not shipped. The animation must end on what exists today: events → balanced books → signed receipt → Stripe matched → sealed month. The halo belongs in the dim "Next" chapter.

3. **Do not fake liveness on a trust brand.** `● LEDGER BALANCED · OCT SEALED` with no hosted product, and "Start free" routing to a waitlist, are where a sceptical CPA catches you. The pill reads a real sealed demo ledger (verify link on click) or is labelled `DEMO`. Primary CTA becomes "Get early access" until Cloud ships; "Start free" stays for the CLI, which *is* free today.

4. **Give light mode its own physics, not a dimmed copy.** "Shadow and sheen" is a hand-wave; coloured drop shadows on cream read as 2014 Material. Light mode's proof is **ink and foil**: unproven events are grey pencil, matched events are stamped green ink (hard edge, slight bleed), the seal is saffron foil whose gradient angle tracks scroll so it catches light as you move. Only the foil is additive; everything else is `multiply`. Token it: `--proof-blend: screen | multiply`, `--seal-surface: glow | foil`.

5. **Put a person in the proof.** The four pillars are engineer-true and emotionally flat. Add a chapter, "Who can check": *a parent at tax time · a treasurer before the board · a CPA in January · an auditor with no account*, one line each and the same Verify button. Trust is felt when the reader sees someone like them checking, not when they read "Ed25519".

## brand-guide.md

**Concept.** "Records are dark until proven" has a hole: the entire dark-mode canvas is then "unproven". Reword to *dark is the stream, light is the check*: the unlit field is money arriving, not money in doubt.

**Effects to cut or re-tie.** Spotlight cursor: no meaning, no touch equivalent, the most copied Linear/AI-startup tic going. Cut. Aurora band: a gradient wash with no referent. Replace with the **fold line**: a single thin saffron line that travels down the left margin as you scroll and creases at each chapter (the trifold itself). Proof sweep and seal breathing stay; the status dot should pulse *once per verified event in the demo*, not on a timer.

**Colour.** Green and saffron glowing in adjacent sections reads as traffic light. Enforce "one accent per section" with a layout rule: never two glow colours within one viewport. Blue is reserved for the witness, which doesn't exist yet, so blue must not also be the link colour or every link inherits "independent". Links: `--fg` with a `--line` underline. Light-mode saffron `#C98A22` on paper is about 3:1; fine as a fill behind dark text, never as text or an icon-only state. Add `--fg-dim` (dark `#4A5268`, light `#A8AFC0`) for unlit roadmap chapters.

**Type.** Fraunces + Inter + JetBrains Mono is right; only Fraunces carries personality, so use it harder: display weight 300–400, optical size 144, `SOFT` up, `WONK` on for the hero only. Subset to Latin and freeze unused axes; the full file is ~200 KB. Mono labels at `0.12em` tracking need `font-feature-settings: "tnum"` on every number, not just tables.

**Motion.** Replace the blur reveal with opacity+`translateY` only; blur on 20 staggered cards janks on mid-range Android. Pinned chapters stack on mobile (no `sticky` under 768px). Add `prefers-contrast: more` (no glows, solid borders). Cap canvas DPR at 1.5 and pre-render the glow sprite; 600 particles with per-frame `shadowBlur` will not hold 60 fps.

**Hero storyboard (replace section 5 row 1).**
- F0 (0–0.8s): page paints with headline, subhead, CTAs and a static SVG of the final frame underneath, so LCP and reduced-motion are both the end state.
- F1 (0.8–2.5s): ~300 dim points fall slowly from the top as a loose stream; mono label fades in at the top left: `STRIPE EVENTS · 214`.
- F2 (2.5–4s): the stream parts into **two** columns, labelled `DEBIT` and `CREDIT`; the points pair off horizontally and each pair's line goes from grey to faint white. Label: `BOOKS · BALANCED`.
- F3 (4–5.5s): a third column peels off to the right, one point per pair, and each of those points flares green with a ✓: `RECEIPTS · SIGNED`. One point is followed brighter than the rest the whole way through; this is "your" dollar.
- F4 (5.5–6.5s): a proof sweep runs across all three columns left to right; the few points that don't match stay clay for a beat, then resolve: `STRIPE · 212/214 MATCHED`.
- F5 (6.5–8s): columns compress into a single horizontal bar that folds in thirds (the logo gesture) and settles as a saffron seal: `OCTOBER · SEALED`. The seal breathes. Hold; no loop. Scrolling 40 px fades the seal into the status pill.
Everything here is 2D canvas plus CSS; the labels are real DOM so they're readable and selectable.

## messaging.md

The homepage headline. "Books you can prove." is correct but it's a category label, and "prove" is Airtight's word too. Five alternatives, strongest first:
1. **Books that show their work.** (plain, human, claims nothing unshipped)
2. **Don't trust the books. Check them.**
3. **Signed, sealed, checkable.**
4. **Every dollar, three ways.** (owns the tagline; leaves "triple-entry" to Airtight)
5. **Proof, not promises.**

Keep "Every dollar, proven." as the final CTA only if the hero is 1 or 4, so the page bookends.

Voice is consistent; two slips. "a parent" is the best word on the page and is buried in a parenthesis; lead with it. "Not even Trifold" (Resilient pillar) is the most trust-building sentence in the doc; promote it to the hero subhead.

The problem section opens with a research stat, a mood break after a cinematic hero. Keep the stat for `/trust`; on the homepage ask only: "AI can do your books. How would you know?"

## sitemap.md

Homepage chapters are RECORD/PROVE/CLOSE; the end-to-end story appears only on `/roadmap`. Adopt the six chapters from change 1 so the roadmap is the long form of the same spine. Drop the separate pillar cards; fold each into the chapter it proves (Durable → BOOKS, Provable and Resilient → PROOF, Fast → CLOSE). Fewer sections, one story.

`/rifo` needs the `NEXT` badge above the fold, in the dim treatment. The live receipt with an in-browser verifier is the best thing on the page; move it into chapter 03, where the animation just promised it.
