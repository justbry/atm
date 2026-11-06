# Ledger admin UI loop: protocol v8

The loop as it runs. GOAL.md sections 2 to 7 and the owner's orders win over this file. Phase 0 closed after its six allowed rounds (scores 7, 8, 8 on v7; every finding asked for the text to match what runs); v8 is that text, unscored, and the owner's order is to keep going. History: `L/phase0/` and git. Contract files: `L/cell-rules.v3.json` (access, cells, formats), `plans/ledger-ui/design/mockup.html` (the lockup).

`W` = the orchestrator worktree (its path is only in `state.json`); `L = W/plans/ledger-ui/loop`; `R = L/runs` and `E = L/evidence` (both untracked).

## 1. Owner's order

Loop until the fixtures, the dashboards and the hashed results agree and the mockup and the web UI score 9/10 similarity from all three reviewers; ship a stack of PRs. No stop for the owner except: a budget cap (§9), two failed attempts of a slice, a blocker outside this repository's UI work, a tool failing twice. Each slice PR merges into its base with a merge commit when it passes; never `main`; only local gates count.

## 2. Roles

Orchestrator (this thread): owns this file, `cell-rules`, golden files, gates, oracle, package config, fixtures data, evidence, PRs, `state.json`; writes no UI code. Builder: one run per build or gate fix, own worktree, Opus 5.5 high for S0 and S1, Sonnet 5.5 high after; one commit, ends `COMMIT <sha>` and any `GOLDEN-DISPUTE <entry> <reason>`; 90 minutes per build, 30 per fix. Reviewers: three blind runs per panel (`claude-opus-5-5`, `claude-fable-5-1`, `grok-4.7`, effort high), each with its own read-only pack, 30 minutes. A resumed thread rebuilds pass decisions from reviewer results by task id, never from a status field.

## 3. Package and contracts

`packages/ledger-ui`: standalone Bun package (not in the root workspaces), Vite 7, strict TypeScript, Preact (the only runtime dependency), one `src/theme.css` = the mockup's whole stylesheet plus `design/mockup-host.css`, `bun test` with happy-dom, Biome 2.2.2 pinned as at the root.

- `mountApp(root, { reader, writer, clock })`; state is `location.hash` (`#/<school>/<tab>?…`); `root.dataset.route` is set when the route's data is on screen. Clock `2026-11-05T12:00`; no `Date.now()`, no argument-less `new Date()`.
- Access is defined by `cell-rules.v3.json` only: five books levels (`public`, `member`, `governance`, `finance_admin`, `owner`), a PIN-locked variant from governance up, per-level granularity, grain, delay, rounding and cell rules. Roles (owner, admin, member) are a person's role, not a plan; the member portal is family-scoped.
- A KPI cell is a number, `{ lt }` or `{ hidden: kind }` with the kinds and labels of `cell-rules.v3.json`; a missing or hidden value is never shown as 0. The UI formats cells from the document's `meta` and never derives a number.
- `src/**` imports only `src/**`, `preact`, `preact/hooks`; only `src/main.tsx` imports `src/fixtures/`. Hooks: only those the golden files list.

## 4. Branches and files

Slices stack: S<k>'s branch is cut from S<k-1>'s head and its PR targets S<k-1>'s branch until that merges, then `dev`; `changed.txt` is `git diff --name-only <base>...HEAD` for that base. Orchestrator commits G<k> come first on a slice branch. Protected for builders (checked by the orchestrator on the builder's commits before any builder code runs): package config, `gates/**`, `scripts/**`, `test/**` except `test/s<k>/`, `src/fixtures/mart/**`, `src/data/kpi-document.ts`, `plans/**`, `packages/atm/**`, Biome configs, root `package.json`, `.github/**`.

When a mockup PR merges into `dev`, open slices rebase onto it and treat it as the lockup; a merged slice whose screens it changed gets a delta slice S<k>b, run like any slice with its own budget.

## 5. Consistency gate C

One chain from atm to pixels, hashed with atm's own `canonicalize` and `sha256Hex` (`packages/atm/src/ledger/util.ts`) and atm's `kpiHash` recipe (`packages/atm/src/scenario/kpis.ts`).

- **C1** for each of the snapshot's 15 presets: atm's export (`design/mart/kpis/<p>.json.gz`) has `fixtureHash` and `kpisHash` equal to `packages/atm/tests/golden/scenarios/<p>.json`, and `kpiHash(rows)` equals `kpisHash`. A mismatch on an orchestrator commit first means a stale snapshot: rerun `L/tools/snapshot-mart.ts` in its own PR.
- **C2** for the presets atm's read slice can replay (5 today; atm's replay bug blocks the other 10): every view object's sha256 equals atm's `views/manifest.json`, and each month view's money equals the export's rows.
- **C3** every committed document (`src/fixtures/mart/documents.json`, keyed `<preset>.<level>[.pin-locked]`) equals `gates/oracle.ts` recomputed now; its sha256 equals `provenance.json`, whose source hashes equal atm's goldens; the fixture Reader returns exactly the committed document. Every number in a document is an atm row or a `cell-rules.v3` formula over the same preset's rows (scaled earlier years included); a value only the mockup has (B4 Uni's donors) is allowed only where `cell-rules.v3` names it as mockup-sourced, and the document's `meta` says so.
- **C4** for every preset, level, PIN state, view and period the dashboard can show: every rendered `[data-kpi][data-period]` has the document's kind and exact text, and every KPI the view lists is rendered. Budget 120 s.
- **C5** from the member portal's slice: a member-facing document holds no other family's key or amounts.

## 6. Gates

In `W` with a clean tree: P first (the builder's commits touch no protected path), then in `packages/ledger-ui`: `bun gates/run.ts --slice S<k> --changed <file> --head <sha>`, which runs I (frozen install), Y (types), B (Biome on changed files), S (size), T (builder tests, then the orchestrator's golden, consistency and hygiene suites in a separate run). Red goes back to a builder, never to reviewers; red only on protected paths is the orchestrator's fix.

S, size: gzip bytes of what the first page load downloads (entry chunk, its static imports, their CSS, from Vite's manifest of `gates/size-entry.tsx` built with null adapters); panes loaded on demand are not counted. S0 at most 30,720; S<k> at most 1.10 × the size recorded for the previous slice in `gates/budget.json`, which the merge step writes. (Owner default of 2026-11-06, reversible.)

## 7. Golden files

`test/golden/S<k>.json` holds what C does not: mockup copy, counts, interactions, non-KPI data, from the mockup run headless (`L/tools/s0-text.mjs`, `s1-text.mjs`) or a cited rule. Steps `click`, `fill`, `key`, `release`, each with an optional `expect`; expectations `text` (exact), `contains`, `count`, `hash`, `writes`, `absent`; a global absent list (`NaN`, `undefined`, `null`, `[object Object]`, `Infinity`); the file's `matrix` covered combination by combination; every earlier slice's file still runs. From S2, a text marked `moves` is checked again through a Reader that multiplies the golden file's `moves.fields` by `2 + (parseInt(head.slice(0, 2), 16) % 8)`; it must exist, pass the absent list and differ. A dispute is settled before scoring by a G commit or a written rejection.

## 8. Evidence and pack

Shots with `L/tools/shoot.mjs` (headless Chromium; the T3 preview tools are equivalent when reachable): each `shot.full` entry (at most 3 per slice) at 1100, 728 and 390 px in light and dark; the app by hash route plus the entry's click steps; the mockup by a fresh page, `mockup-host.css`, an explicit theme and the entry's `mockupSteps`; the viewport width is asserted; a random 4-character nonce is drawn into every app shot, and appears in no text file. DOM dumps with `L/tools/dom-dump.mjs`. The mockup side is reshot whenever the lockup changes. Pack, one read-only copy per reviewer in `/tmp/ledger-ui-review/S<k>-r<n>/<reviewer>/`: shots, mockup shots, DOM dumps, gate output, the golden file, and `diff.patch` without `src/fixtures/mart/**` (its sha256 and provenance listed instead).

## 9. Review, loop, budget

Axes, integers 1 to 10: fidelity (similarity to the mockup), aesthetics, simplicity, correctness, accessibility; overall = the minimum. Anchors: 10 indistinguishable and simpler than expected; 9 ship it; 8 one real issue; 7 several; 6 or less redesign. A valid answer quotes the nonce, gives evidence per full-shot entry and per axis at 9 or more, three `wouldChange`, and a `mustFix` or blocker for any axis at 8 or less; from round 2 it marks each prior item fixed, not fixed or regressed. Where the mockup itself is wrong (a defect a reviewer names in both shots), the orchestrator decides once per slice: follow the mockup, or fix it in the app and say so in the next prompt.

Pass: all three at 9 or more, no blockers, no unwaived regression, gates green, shots of HEAD. Then the PR body gets the score table, the slice merges, its size is recorded, and the owner gets a report. Otherwise: up to 3 rounds per attempt, one objection round per slice when the spread exceeds 2, reset to the best round when the mean drops, close and restart once on a design blocker named by two reviewers or after 3 rounds. Caps per slice: 6 panels, 18 reviewer runs, 12 builder runs, 10 hours per attempt; overall 150 reviewer runs.

## 10. Slices and done

S0 shell; S1 Dashboard (five books levels); S2 Bookings; S3 Plans (tier "Books access"); S4 Members (roles, Finance and Books chips, role actions); S5 Ledger, Reports ("Donors and payers"), Promos; S6 member portal (family scope, School books card); S7 Settings ("School books" policy); S8 real adapters (atm read slice, buzz-school routes; may block on atm's replay bug, no `catalog.published`, buzz-school's Cedar ledger area and R2 emission). Done: S0 to S7 merged at 9 or more, gate C green, `bun run dev` showing the mockup's behaviour; S8 merged or blocked with a written reason.
