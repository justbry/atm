# Trifold brand guide: look, light and motion

Status: draft, round 2, 2026-11-06. Builds on `docs/brand/trifold-brand-and-messaging.md` (PR #121), which sets names, voice and claim rules. Changes from round 1: `decisions.md`.

Reference: balnce.ai (studied 2026-11-06). We take its feel: a near-black canvas, light that seems to come from inside the product, scroll that tells a story in chapters, small mono labels that make the page read like an instrument. We don't take its purple "AI magic" gradients, decorative particles or a phone as the hero.

## 1. The idea: dark is the stream, light is the check

Money arrives as a dim stream. **Each check gives off light.**

- An arriving event is a dim point.
- Balanced books draw a faint line between each debit and credit.
- A signed receipt flares ledger green.
- A sealed month settles into a warm saffron seal.

The idea carries the roadmap too: **shipped chapters are lit, the next chapter glows like an ember, later chapters are unlit outlines.** Honest staging is the visual signature. Light is never decoration: every glow on the site stands for a check that exists.

## 2. Modes

Both modes are first-class. The site follows the system setting, with a header toggle that remembers the choice. Each mode has its own physics.

| | Dark: "the vault at night" | Light: "ink and foil" |
|---|---|---|
| Feel | A quiet vault lit from inside by proofs | A ledger page on a sunlit desk, stamped and foiled |
| Background | Deep ink `#07090F`, raised ink navy `#0E1424` | Paper `#F7F3EA`, cards `#FFFDF8` |
| Unproven | Dim points | Grey pencil marks |
| Proven | Green light, additive (`screen`) | Green ink stamp: hard edge, slight bleed (`multiply`) |
| Sealed | Molten saffron glow that breathes | Saffron foil whose gradient angle tracks scroll, so it catches the light as you move |
| Blend token | `--proof-blend: screen` | `--proof-blend: multiply` |
| Seal token | `--seal-surface: glow` | `--seal-surface: foil` |

Only the foil is additive in light mode. Everything else multiplies, like ink.

## 3. Color tokens

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#07090F` | `#F7F3EA` | Page |
| `--bg-raised` | `#0E1424` | `#FFFDF8` | Cards, panels |
| `--fg` | `#E9ECF4` | `#16203A` | Text, links (with a `--line` underline) |
| `--fg-muted` | `#9AA3B8` | `#5B6680` | Secondary text |
| `--fg-dim` | `#4A5268` | `#A8AFC0` | Unlit roadmap chapters (never body text) |
| `--line` | `#FFFFFF14` | `#E4DCCB` | Borders |
| `--proof` (ledger green) | `#5BE3A1` | `#2F7D5B` | Matched, verified, ✓ |
| `--seal` (saffron) | `#F2B447` | `#C98A22` | Sealed months, primary CTA fill |
| `--ember` | `#FF9B54` | `#C2672A` | The "Next" chapter |
| `--witness` (dawn blue) | `#7FB8FF` | `#2D6BC4` | Reserved for the independent witness. Not links |
| `--alert` (clay) | `#E07A5F` | `#B5533C` | Mismatches, warnings only |

Rules:
- **Never two glow colors in one viewport.** Green says checked, saffron says sealed or act, ember says next.
- WCAG AA for all text (4.5:1 body). Light-mode saffron is a fill behind dark text, never text or an icon-only state.
- No purple.
- `prefers-contrast: more`: no glows, solid borders, full-strength text.

## 4. Type

| Role | Font | Notes |
|---|---|---|
| Display | **Fraunces** (variable) | Weight 300–400 for big headlines, optical size high, `SOFT` up; `WONK` on in the hero only. Subset to Latin |
| Body and UI | **Inter** (variable) | 16–18px |
| Labels, numbers, code | **JetBrains Mono** | `font-feature-settings: "tnum"` on every number; uppercase labels tracked 0.12em, e.g. `03 · PROOF` |

Self-host fonts. Headlines use `clamp()`; the hero reaches about 88px on desktop.

## 5. The hero animation

A 2D `<canvas>` behind real DOM labels. The page first paints a static SVG of the final frame, so the largest paint and reduced-motion both show the end state; the canvas fades in over it.

| Frame | Time | What happens | DOM label |
|---|---|---|---|
| F0 | 0–0.8s | Headline, subhead, CTAs and the static final frame paint | — |
| F1 | 0.8–2.5s | About 300 dim points fall slowly as a loose stream | `STRIPE EVENTS · 214` |
| F2 | 2.5–4s | The stream parts into two columns; points pair off and a faint line joins each pair | `BOOKS · BALANCED` |
| F3 | 4–5.5s | A third column peels off to the right, one point per pair, each flaring green. One point is brighter throughout: "your" dollar | `RECEIPTS · SIGNED` |
| F4 | 5.5–6.5s | A proof sweep crosses all three columns; two points stay clay for a beat, then resolve | `STRIPE · 212/214 MATCHED` |
| F5 | 6.5–8s | The columns compress into a bar that folds in thirds (the logo gesture) and settles as a saffron seal that breathes. Hold; no loop | `OCTOBER · SEALED` |

Only shipped steps appear. The witness halo appears later, in the dim "Next" chapter.

Performance: cap device pixel ratio at 1.5; draw glows from a pre-rendered sprite, not per-frame `shadowBlur`; pause when offscreen or the tab is hidden.

## 6. Lighting effects

| Effect | Means | How |
|---|---|---|
| Hero field | Events become books, receipts, a seal | Canvas, §5 |
| **Fold line** | The trifold: the story folding into one record | A thin saffron line down the left margin that draws as you scroll and creases (a small chevron) at each chapter |
| Seal glow / foil | A sealed month | Dark: radial core plus two blurred layers, 6s breathing. Light: foil gradient tied to scroll |
| Proof sweep | Verification running | A highlight that crosses a receipt or row once, 1.2s, when verification runs |
| Chapter lighting | Shipped vs. next vs. later | Lit chapters full color; ember chapter warm low glow; later chapters outlined in `--fg-dim` |

Cut from round 1: the spotlight cursor and the aurora band (decoration with no meaning).

## 7. Motion

1. **Motion explains.** Each animation shows a product step.
2. **Calm.** Ease-out `cubic-bezier(0.16, 1, 0.3, 1)`; 400–900ms reveals; slow ambient loops (6s+).
3. **Scroll tells the story.** Chapters with mono labels; one pinned ledger visual through chapters 01–03 on desktop. **No pinning under 768px**: chapters stack.
4. **Respect the visitor.** `prefers-reduced-motion` shows final states instantly. Nothing important appears only through animation.
5. **Fast first.** Readable before any script. Homepage JS under 60 KB; LCP under 1.5s.

Patterns:
- **Reveal:** opacity and 16px `translateY` only (no blur; it janks on mid-range phones), 60ms stagger.
- **Number roll:** totals count up once in tabular mono.
- **Sample pill:** `● SAMPLE LEDGER · 214 PAYMENTS · OCTOBER SEALED`. The dot pulses once per verified event in the hero, then rests. Never implies a live service.
- **Hover:** cards lift 2px; buttons brighten their own glow.

## 8. Logo and marks

- Wordmark: "Trifold" in Fraunces; the dot of the "i" can become a tiny seal.
- Mark: three panels folding into a triangle (PR #121). The hero's final fold is this gesture.
- The three-check row: **Books ✓ · Receipt ✓ · Stripe ✓**.

## 9. Imagery

Product truth over illustration: real receipts, real ledger rows, real `tfd` output. Abstract light only when it stands for a check. Avoid glowing brains, robots, coins, chains, blockchain cubes, suits, phones as hero objects.

## 10. Components

Header (sticky, blurred, mono nav, mode toggle, "Get early access") · sample pill · chapter (label, state: lit/ember/outline) · fold line · receipt card · inline verifier · ledger panel · three-check row · terminal block · who-can-check list · FAQ · pricing table · footer.
