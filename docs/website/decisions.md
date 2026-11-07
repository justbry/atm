# Website decisions log

How each review round changed the plan. Reviews are in `reviews/`.

## Round 1 → round 2 (2026-11-06)

Reviewers: Sonnet (conversion and go-to-market), Fable (brand, narrative and motion).

| Change | From | Why |
|---|---|---|
| Hero headline "Books that show their work." with eyebrow "For schools and membership businesses on Stripe" | "Books you can prove." | Both: "prove" is a category label (and Airtight's word). Sonnet: owners must see themselves in 5 seconds, hence the eyebrow. Fable: plain, human, claims nothing unshipped |
| Primary CTA "Get early access" (design-partner offer); "Install the CLI, free" for developers | "Start free" everywhere | Both: Cloud isn't live; a trust brand can't promise what it can't deliver |
| Homepage built on six chapters: Money in · Books · Proof · Close · Taxes · Finance, lit / ember / outlined | Record · Prove · Close plus a separate roadmap teaser | Fable: one spine for home and roadmap; honest staging becomes the visual signature. It also carries the owner's end-to-end vision without overclaiming |
| Trust pillars folded into chapters; each proof uses only shipped features; "Fast" proven by replay speed, not by Rifo | Four pillar cards citing a status page, key rotation demo and a Rifo close | Sonnet: unshipped proofs and overlapping pillars. Kept all four because the owner named durable, fast and resilient explicitly |
| Hero animation ends at the sealed month; witness halo moves to the "Next" chapter | Ended on a witnessed seal | Both: witness isn't shipped |
| Sample pill labelled `SAMPLE LEDGER`; no status page | Live-sounding `LEDGER BALANCED` pill | Both: don't fake liveness |
| Inline verifier inside chapter 03, linked from the hero | Live receipt as section 6 | Sonnet: the only concrete proof, move it up. Fable: put it where the animation promises it |
| "Who can check" chapter (parent, treasurer, CPA, auditor, donor) | — | Fable: the trust story needs people |
| FAQ with six objections; people block | — | Sonnet: unanswered objections; pre-launch trust is people |
| Spotlight cursor and aurora band cut; fold line added | Five effects | Both: decoration breaks the guide's own rule |
| Light mode "ink and foil" with blend and seal tokens | "Shadow and sheen" | Fable: colored shadows go flat |
| Blue reserved for the witness; links use `--fg` | Blue links | Fable: links shouldn't mean "independent" |
| Reveal without blur; no pinning under 768px; DPR cap; glow sprite; `prefers-contrast` | — | Fable: performance and accessibility |
| Nav: How it works · Schools · Accountants · Pricing · Verify | Five-way Solutions menu | Sonnet: two front doors for launch |
| GTM reordered: 30 named schools, school networks, ID/UT CPA firms first; Show HN later | Developer-led first | Sonnet: GTM must match the first market |
| Kept `/pricing`, `/roadmap` and the three secondary `/for/*` pages; cut `/rifo`, `/standard`, `/changelog` | Sonnet proposed 9 pages | The owner asked for pricing, roadmap and audience pages; Rifo isn't shipped |

## Licensing and the tfd rename (2026-11-06)

Owner decisions, final.

| Change | From | Why |
|---|---|---|
| The engine and CLI are named `tfd` in all copy; "(the `atm` command until the rename lands)" appears once per page or doc | "atm" for the engine, `tfd` as the planned CLI name | The CLI already answers to `tfd`; the package and directory rename comes after open PRs land. Literal paths (`packages/atm/...`) and `github.com/justbry/atm` stay |
| Engine license: FSL-1.1-ALv2 (source-available, free to self-host, each release becomes Apache-2.0 two years after it ships) | "License being finalised" | Protects the engine from a hosted clone, and the public conversion date backs the durability promise |
| Receipt and seal format, spec and verifier: Apache-2.0; test vectors: CC0-1.0; hosted service, Rifo and the witness: proprietary; forked Autumn code stays Apache-2.0 | — | "Anyone can check, forever" needs checking to be unrestrictable |
| Copy never says "open source" for the engine; it says "source-available", "Fair Source" or "free to self-host". "Open formats", "open spec" and "open verifier" stay | "Open core", "open engine" | FSL isn't OSI-approved. Only the Apache-2.0 and CC0 parts can be called open |
| `// SPDX-License-Identifier: Apache-2.0` on `src/lib/verify/*.ts`; the licensing table on Trust, About and Developers; the footer line names the license | — | The in-browser verifier is part of the Apache-2.0 verifier |

Open: the licensor's legal entity name (the LICENSE says "Trifold" until a company is formed); whether accounting firms hosting tfd for many clients need a grant beyond FSL's professional-services clause (before the accountant partner program); contributor terms (DCO or CLA); whether the event envelope schema should also be Apache-2.0.
