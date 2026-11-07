# Ledger admin UI loop: protocol v5

The precise form of `plans/ledger-ui/GOAL.md` sections 2 to 7 plus the owner's order of 2026-11-05. Where they conflict the owner's order wins, then GOAL.md. v5 is smaller than v4 on purpose (the owner: "a smaller protocol that terminates beats a perfect one"). It adds the consistency gate C (§5) and settles the v4 open questions (§12). Companion: `L/cell-rules.v2.json`.

Names: `W` is the orchestrator worktree (its absolute path is only in `state.json`), `L = W/plans/ledger-ui/loop`, `R = L/runs` (untracked).

## 1. Owner's order (2026-11-05)

Loop until the fixtures, the dashboards and the hashed results agree, and the mockup and the web UI score 9/10 similarity from all three reviewers; ship it as a stack of PRs. Phase 0 gets up to 6 rounds. No stop for the owner until done, except: a budget cap (§9), a preview cap (§7), a slice that fails 3 attempts, or a blocker outside this repository's UI work. Each slice PR is merged into `dev` with a merge commit when it passes; never `main`. GitHub Actions is not waited on (path-filtered workflows stay queued; only local gates count).

## 2. Roles

- **Orchestrator** (this thread, Opus 5.5): owns the protocol, `cell-rules`, golden files, gates, package config, the mart snapshot, evidence, PRs and `state.json`. Writes no UI code.
- **Builder**: one `delegate_task` per build or gate fix, `role:"implementation"`, `isolation:"worktree"`. Opus 5.5 `{effort:"high"}` for S0 and S1, Sonnet 5.5 `{effort:"high"}` from S2. One commit, no push, no PR. Last lines: `COMMIT <sha>` and any `GOLDEN-DISPUTE <entryId> <reason>`. Timeout 90 minutes for a build, 30 for a gate fix.
- **Reviewers**: three `delegate_task` per panel, `role:"review"`, `isolation:"worktree"`, started in one turn: `claude-opus-5-5 {effort:"high"}`, `claude-fable-5-1 {effort:"high"}`, provider `grok` `grok-4.7 {reasoningEffort:"high"}`. No reviewer sees another's output (except the objection round, §8). Timeout 30 minutes.
- Trust: child prompts carry repository-relative paths and a pack path only. Before each child the orchestrator hashes every file under `L`; after it, any change it did not make is restored and recorded. `git status --porcelain` in `W` must be empty before gates.

## 3. Package and stack

`packages/ledger-ui`: a standalone Bun package (own `package.json`, `bun.lock`; not in the root `workspaces`, so installing it does not install the monorepo; measured 23 packages in about 1.3 s). Vite 7.1.12, TypeScript 5.8.3 (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Preact 10 (JSX, hooks, no router, no state library), one `src/theme.css` (the mockup's tokens plus the three host tokens in `plans/ledger-ui/design/mockup-host.css`), `bun test` with `@happy-dom/global-registrator`, `@biomejs/biome` 2.2.2 pinned as in the root. Runtime dependency: `preact` only.

Why: Preact renders the mockup's plain DOM with a 4 KB runtime, keeps input focus across renders, and escapes text (no `innerHTML`); one hash route is the whole UI state and doubles as deep links for tests and screenshots; Vite emits static assets a Worker serves (no `node:fs`, no `new Function`, no Ajv); `bun test` with happy-dom is the `design/smoke.mjs` pattern; `Reader` and `Writer` are the only seam (fixtures now, R2 and buzz-school routes in S8); no zod.

Contracts:

- `src/app/mount.tsx`: `mountApp(root, { reader, writer, clock }): { unmount(): void }`; reads `location.hash` at mount and on `hashchange`; after each commit sets `root.dataset.route` to the hash it rendered.
- Hash `#/<schoolId>/<tab>?view=&month=&viewer=&preset=&grain=&member=&theme=`; tabs `plans dashboard members bookings promos ledger reports all`; viewers `owner finance admin locked demo`; grains `month quarter`; themes `light dark system`.
- `Clock = { today, now }`, fixtures at the mockup's `2026-11-05` and `2026-11-05T12:00`; no `Date.now()`, no argument-less `new Date()`.
- KPI cell: `number | { lt: number } | { hidden: "suppressed" | "locked" | "not_computed" | "open_period" | "blocked" }` (spec v3's `number | {lt} | null` with the reason inside; the S8 adapter maps a route's `null` plus reason to `{hidden}`; a raw `null` reaching the UI renders `not_computed`). DOM: `data-kpi`, `data-period`, `data-cell`. Text: a value in its `cell-rules` format, `lt` as `<N`, a hidden kind as its `cell-rules.labels` text.
- The KPI document carries `source: { preset, fixtureHash, kpisHash }`, copied from the atm export it was built from.
- `data-test` hooks: only those listed in the golden files up to the current slice.
- `createFixtureWriter({ mode: "instant" | "hold" })` records every call; `hold` keeps calls pending until a `release` step.
- `src/fixtures/**` imports only `src/data/**` and `src/fixtures/**`; only `src/main.tsx` imports `src/fixtures/`.

## 4. Files and branches

- Design artifacts, verbatim, in `plans/ledger-ui/design/`: `mockup.html`, `smoke.mjs`, `buzz-school-briefs.md`, `dashboard-lockdown-spec-v3.md`, `mockup-host.css`, and `mart/` (§5).
- Each slice branch `claude/ledger-ui-s<k>-<slug>` is cut from `dev` after the previous slice merged; its PR targets `dev`. A restart uses `-r2`, `-r3`.
- Orchestrator commit G<k> first on each slice branch. G0: the package config (`package.json`, `bun.lock`, `tsconfig.json`, `bunfig.toml`, `vite.config.ts`, `index.html`), `gates/**`, `test/golden.test.ts`, `test/hygiene.test.ts`, `test/consistency.test.ts`, `test/golden/S0.json`. G1 adds `src/fixtures/mart/**` (written by `scripts/import-mart.ts`), `test/golden/S1.json`. A builder that needs a config change asks; the orchestrator commits it.
- Protected (gate P on the builder's own commit): every G path, `plans/ledger-ui/**`, `packages/ledger-ui/test/**` except `test/s<k>/`, `packages/atm/**`, any `biome.json*`, root `package.json`, `.github/**`.
- Untracked in `W`: `L/state.json`, `L/runs/`, `L/evidence/`.

## 5. Consistency gate C: one chain from fixture to pixels

The owner's chain: (a) atm's seeded scenario fixtures on `dev` with their hashes, (b) the atm read slice (`readEventsFromStore`, `membersOf`, `buildViews`/`writeViews` with a sha256 per object in `views/manifest.json`), (c) the KPI documents built from the mart snapshot, (d) what the UI renders. No second hashing scheme: the gate imports atm's own `canonicalize` and `sha256Hex` from `packages/atm/src/ledger/util.ts` (its only import is `node:crypto`) and reproduces `kpiHash` exactly as `packages/atm/src/scenario/kpis.ts` defines it (rows `{kpiId, period, value}` sorted by `kpiId` then `period`, canonical JSON, sha256).

The mart snapshot (`plans/ledger-ui/design/mart/`, refreshed as its own PR whenever it is stale against `dev`): `bundle.json` from the coordinating atm session's mart (`contrib`, tiers, MRR, cash, bookings, cohorts); `kpis/<preset>.json` = atm's own `scenario kpis` export per preset (rows, `fixtureHash`, `kpisHash`); `views/<preset>/` = the objects and `manifest.json` that atm's `writeViews` writes for the preset's event log, for presets atm can replay; `SNAPSHOT.md` with the atm commit and file hashes.

`test/consistency.test.ts` (orchestrator, runs in gate T, every slice):

| Link | Check |
|---|---|
| C1 a | for every preset in the snapshot: `kpis/<p>.json` `fixtureHash` and `kpisHash` equal `packages/atm/tests/golden/scenarios/<p>.json` on the commit under test, and `kpiHash(rows)` recomputed equals `kpisHash` |
| C2 b | for every preset with views: each object's sha256 equals `manifest.objects[key]`, and each month view's `money.grossCents`, `refundedCents`, `feeCents` equal that month's `gross_collected`, `refunds`, `stripe_fees` rows. Presets atm cannot replay are listed in `SNAPSHOT.md` with atm's error and skipped by name (not silently) |
| C3 c | for every preset × viewer × grain: the document the fixture `Reader` returns has `source` equal to the export's hashes, and every cell equals the independent oracle `gates/oracle.ts` (cell-rules applied to the export rows and `contrib`; for `owner` × `month` every cell equals its row value; a period with no row is `not_computed`, never 0) |
| C4 d | for every preset × view × viewer × grain × period the dashboard can show (from S1): mount, navigate, and every rendered `[data-kpi]` cell has the document's kind and exact text; every document cell the view lists is rendered; no hidden or `lt` cell shows a digit other than its label or bound |

C runs in seconds (happy-dom, no network). Any mismatch is a red gate. Because C4 checks every reachable state, it is also the holdout for KPI data: nothing hard-coded survives it. Before S1, C1 to C3 run in G1 and must be green on the orchestrator's own commit.

## 6. Gates (orchestrator only; red goes back to the builder, never to reviewers)

Run on a clean tree, in a fresh export: `git archive HEAD packages/ledger-ui packages/atm/src/ledger/util.ts packages/atm/tests/golden/scenarios plans/ledger-ui/design biome.json | tar -x -C /tmp/ledger-ui-gates/<sha>`, then `bun gates/run.ts --slice S<k> --round-base <sha> --builder-commit <sha>`. Before the first build of a slice the orchestrator makes every gate green on G<k>; a red gate on protected paths only is the orchestrator's fix, not a round.

| Id | Gate | Rule |
|---|---|---|
| P | paths | the builder commit touches no protected path |
| I | install | `bun install --frozen-lockfile` |
| T | tests | `bun test`: slice tests, golden (§7), consistency (§5), hygiene |
| Y | types | `bunx tsc --noEmit -p gates/tsconfig.gates.json` (strict, `src` and `test`) |
| B | Biome | the slice's changed `.ts .tsx .js .mjs .json .css` files except `src/fixtures/mart/**`, `bun.lock` and `test/golden/*.json`, with the export's pinned `biome check --no-errors-on-unmatched <files>`; never a bare `./` |
| H | hygiene | `src/**` has no `ajv`, `node:`, `new Function`, `eval(`, `console.`, `debugger`, `innerHTML`, `dangerouslySetInnerHTML`, `localStorage`, `sessionStorage`, `indexedDB`, `zod`, `Date.now(`, `new Date()`, and keeps the import rule; `dist/` has no `new Function`, `eval(`, `node:`, `ajv`, `zod` |
| S | size | gzip bytes of the `gates/size-entry.tsx` build (the app with null adapters, no fixtures). S0 at most 30720. S<k> at most `1.10 × size(S<k-1>)` (owner's choice). S0 therefore carries the mockup's whole stylesheet and the shared primitives (table, card, chip, drawer, modal, toast), so later slices add views, not styles |

## 7. Golden files and screenshots

`test/golden/S<k>.json` (orchestrator, before the first build) holds what C does not: mockup copy, layout counts, interactions. Entry: `{ id, source, route, writer, steps, expect, shot }`. Steps: `click`, `fill` (+`value`), `key` (+`target`), `release`; any step may carry `expect`. `expect`: `text` (exact, first match, whitespace collapsed and trimmed like `smoke.mjs`), `contains` (scoped), `count` (exact), `writes` (the writer's recorded calls), `absent`. Global absent list on every entry: `NaN`, `undefined`, `null`, `[object Object]`, `Infinity`. The file's `matrix` (views × viewers × grains, where the slice has them) must be covered combination by combination, or the runner fails. Values come from the mockup run headless (`gates/mockup-text.ts`, the `smoke.mjs` pattern) or, for spec-only states, from the spec rule cited in `source`. Moving-data holdout (for slices whose data is not covered by C): entries with `"data": true` run a second time inside the gate, after the commit, through a `Reader` that scales every numeric field the routes return by a factor drawn from the HEAD sha (2 to 9) and appends `·` to every name; each digit-bearing `text` of such an entry must then differ from its golden value, and the page must still pass the absent list. A number that does not move with its data is hard-coded. A `GOLDEN-DISPUTE` is settled before the round is scored: a G commit fixes the golden (listed in the review pack) or a written rejection goes to the next build; a round red only on entries then fixed does not count.

Screenshots (T3 preview tools, orchestrator). Dev server `bun run dev -- --port 5181 --strictPort`; mockup by `python3 -m http.server 5182 -d plans/ledger-ui/design`. Per width one `preview_resize {mode:"freeform", width, height:900}`. Per app shot one `preview_evaluate` that sets the hash and awaits `#app.dataset.route` equal to it, then `preview_snapshot {save:true}`. Per mockup shot one `preview_navigate`, one `preview_evaluate` that awaits `.tab`, injects `mockup-host.css`, sets `theme` and calls `applyTheme()`, runs the entry's `mockupSteps` and awaits two frames, then `preview_snapshot`. Shots: the entries marked `shot.full` (at most 3 per slice) at 1100, 728 and 390 in light and dark every round; up to 6 more entries at 1100 light in round 1 and when a mustFix names them. The mockup side is shot once per slice. Caps (`s` shots, `w` widths): app `2 + w + 2s`, mockup `2 + w + 3s`, at most 50 and 74. A failed preview call is retried once; a cap hit or a second failure stops the slice for the owner (§1). `shots/manifest.json` records the commit; a pass needs it equal to HEAD.

## 8. Review panel

Pack: one read-only copy per reviewer at `/tmp/ledger-ui-review/S<k>-r<n>/<reviewer>/` with `gates.txt`, `diff.patch`, `dom/<entry>.txt`, `shots/`, `mock/`, the golden file, `cell-rules.json`, and the prompt; re-hashed after the panel. Prompt: slice goal, shot pairs (`shots/x.png` ↔ `mock/shots/x.png`), the mockup's line ranges, the `cell-rules` decisions that override the mockup (demo-only MRR, ARR and churn; credits outstanding blocked; `not_computed` on a zero denominator), and from round 2 the list the builder got, each item to mark `fixed | not_fixed | regressed`.

Axes, integers 1 to 10: `fidelity` (similarity to the mockup: layout, copy, states; spec-only states against spec v3 and `cell-rules`), `aesthetics` (spacing, type, contrast, both themes, three widths), `simplicity` (fewest concepts on screen; no dead code or one-use abstraction), `correctness` (numbers, states, null handling, Writer effects, GOAL.md section 0), `accessibility`. Anchors: 10 indistinguishable from the mockup and simpler than expected; 9 ship it, nitpicks only; 8 one real issue; 7 several; 6 or less redesign. After round 1 a new mustFix must be something that alone holds an axis at 8 or less.

Output, the final message only: `{ scores, overall, imagesViewed, blockers:[{where,what,why,designLevel}], mustFix:[{where,what,why}], priorItems:[{item,status,waived}], wouldChange:[3], evidence:[{axis,cites,observation}] }`. Valid when: integer axes; `overall` is their minimum; three `wouldChange`; one cited `evidence` per axis at 9 or more, naming a file in the pack; `imagesViewed` true with at least one `evidence` per full shot pair; an axis at 8 or less has a `mustFix` or `blocker`; a 9 with a prior item `not_fixed` or `regressed` gives a `waived` reason. An invalid answer is re-asked once (counts as a run); a second invalid answer or timeout fails the panel.

Spread = max(overall) − min(overall). Over 2 triggers one objection round per slice (each reviewer sees the others' blockers and mustFix text, no scores, and re-scores). "Same design blocker" = two `designLevel` blockers naming the same screen and defect, judged by the orchestrator and written into `state.json`.

## 9. Loop and budget

```
runSlice(k): for attempt in 1..3: r = runAttempt(k, attempt); if r != CLOSED: return r
             return STOP
runAttempt(k, attempt):
  G<k> on a fresh branch from dev (-r<attempt>); gates green on it; mockup shots (attempt 1); push; open the PR
  n = 1; best = none
  while n <= 4:
    budget check (builder); roundBase = HEAD
    build (goal; best's mustFix; the last red gates; what a reverted round broke)
      no commit, timeout, failed merge or tamper -> reset to roundBase; n += 1; next
    gates; up to 3 gate fixes (budget-checked); still red -> reset to roundBase;
      n += 1 unless red only on golden entries the orchestrator then fixed; next
    evidence; push; budget check (panel); panel
      failed panel -> rerun once on the same HEAD (budget-checked); failed again -> n += 1; next
    pass -> merge (below); return PASS
    spread > 2 and objection unused -> objection round (budget-checked); pass -> merge; return PASS
    same design blocker from two reviewers -> close; return CLOSED
    mean below best -> reset to best, cherry-pick the G commits made since, force-push; keep best
    else best = this round
    n += 1
  close; return CLOSED
pass: all three overall >= 9, no blockers, no prior item regressed, gates green, shots of HEAD
merge: PR body gets the score table; gh pr merge --merge --match-head-commit <HEAD>; record; report to the owner
close: gh pr close --delete-branch with a postmortem comment
budget: per slice <= 6 panels, <= 18 reviewer runs, <= 12 builder runs, <= 10 hours per attempt; <= 150 reviewer runs overall
```

Re-asks, objection rounds and reruns count. A cap that would be crossed stops the loop and reports to the owner.

## 10. State and resume

`L/state.json` after every step: phase, protocol version, budget counters, mart hashes, per slice `{ status, attempt, branch, pr, gCommits, panels, runs, builderRuns, best, rounds[{ n, roundBase, commit, outcome, gates, reviewTaskIds, scores, mean, mustFixPath }] }`. A resuming thread trusts no `status`: it re-reads the reviewer results by task id and rebuilds the pass decision.

## 11. Slices and done

S0 scaffold (shell, tokens, the whole stylesheet, shared primitives, `Reader` and `Writer`, fixture adapters, gates); S1 Dashboard (Money, Members, Risk on the v3 document for every preset in the snapshot, all viewer states, quarterly grain, stale banner, verified badge, the mart caveats); S2 Bookings; S3 Plans; S4 Members; S5 Ledger and Reports; S6 member portal; S7 Settings; S8 real adapters (the merged atm read slice and buzz-school routes A to D; may block on: no owner for buzz-school → R2 event emission, `catalog.published` not emitted, Worker wrangler config). Before S3, S4 and S5 the orchestrator records whether the tab uses the mockup's schools or the mart's Before University (`dataSource` and reason in `state.json`). Done: S0 to S7 merged at 9 or more from all three, C green on every preset, `bun run dev` showing the mockup's behaviour on fixtures; S8 merged or blocked with a written reason.

## 12. Decisions settled for v5

- Size: 10 percent over the previous slice (owner). Owner counts: exact (spec D1; the owner is the controller of their school's money). Banding: `<N` (the cell shape given by the owner); `dashboard.html`'s `5–9` ranges are listed in `R/S1/reference-diff.md` as a difference. Host tokens: the three values in `design/mockup-host.css`.
- Dropped from v4 as superseded by gate C or not worth their cost: the literal check, the sampled holdout file (replaced by C4 for KPI data and the moving-data holdout for the rest), the per-shot observation list, the 90-call mockup budget.
