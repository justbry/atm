# Ledger admin UI loop: protocol v7

The precise form of `plans/ledger-ui/GOAL.md` sections 2 to 7 and the owner's order of 2026-11-05; the owner's order wins, then GOAL.md. v7 is v6 with the round 5 findings answered (§14); v6's §13 answered round 4. Companion: `L/cell-rules.v2.json`.

Names: `W` is the orchestrator worktree (absolute path only in `state.json`), `L = W/plans/ledger-ui/loop`, `R = L/runs` (untracked), `M = plans/ledger-ui/design/mart` (the snapshot).

## 1. Owner's order (2026-11-05)

Loop until the fixtures, the dashboards and the hashed results agree, and the mockup and the web UI score 9/10 similarity from all three reviewers; ship it as a stack of PRs. Phase 0 gets up to 6 rounds. No stop for the owner until done, except: a budget cap (§10), two failed attempts of one slice, a blocker outside this repository's UI work (for example atm's own data disagreeing with itself), or a preview tool failing twice in a row. Each slice PR is merged into `dev` with a merge commit when it passes; never `main`. GitHub Actions is not waited on; only local gates count.

## 2. Roles

- **Orchestrator** (this thread, Opus 5.5): owns the protocol, `cell-rules`, golden files, gates, oracle, package config, the snapshot, evidence, PRs and `state.json`. Writes no UI code.
- **Builder**: one `delegate_task` per build or gate fix, `role:"implementation"`, `isolation:"worktree"`; Opus 5.5 `{effort:"high"}` for S0 and S1, Sonnet 5.5 `{effort:"high"}` from S2. One commit, no push, no PR; last lines `COMMIT <sha>` and any `GOLDEN-DISPUTE <entryId> <reason>`. Timeouts: build 90 minutes, gate fix 30.
- **Reviewers**: three `delegate_task` per panel, `role:"review"`, `isolation:"worktree"`, started together: `claude-opus-5-5 {effort:"high"}`, `claude-fable-5-1 {effort:"high"}`, provider `grok` `grok-4.7 {reasoningEffort:"high"}`. Each reads only its own pack (§8). Timeout 30 minutes.
- Child prompts carry repository-relative paths and the pack path, nothing about `W`. On resume no `status` is trusted: the pass decision is rebuilt from the reviewer results by task id.

## 3. Package and stack

`packages/ledger-ui`, a standalone Bun package (own `package.json`, `bun.lock`; not in the root `workspaces`, so its install is 23 packages in about 1.3 s, measured). Vite 7.1.12, TypeScript 5.8.3 (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Preact 10 (JSX, hooks; no router, no state library), one `src/theme.css` (the mockup's tokens plus the three host tokens of `plans/ledger-ui/design/mockup-host.css`), `bun test` with `@happy-dom/global-registrator`, `@biomejs/biome` 2.2.2 as pinned at the root. Runtime dependency: `preact` only.

Why: Preact renders the mockup's plain DOM with a 4 KB runtime, keeps input focus across renders and escapes text (no `innerHTML`); one hash route is the whole UI state and doubles as deep links for tests and screenshots; Vite emits static assets a Worker serves (no `node:fs`, no `new Function`, no Ajv); `bun test` with happy-dom is the `design/smoke.mjs` pattern; `Reader` and `Writer` are the only seam (fixtures now, R2 and buzz-school routes in S8); no zod.

Contracts:

- `src/app/mount.tsx`: `mountApp(root, { reader, writer, clock }): { unmount(): void }`; reads `location.hash` at mount and on `hashchange`; after each commit sets `root.dataset.route` to the hash it rendered.
- Hash `#/<schoolId>/<tab>?view=&month=&viewer=&preset=&grain=&member=&theme=`; tabs `plans dashboard members bookings promos ledger reports all`; viewers `owner finance admin locked demo`; grains `month quarter`; themes `light dark system`.
- `Clock = { today, now }`, fixtures at the mockup's `2026-11-05` and `2026-11-05T12:00`; no `Date.now()`, no argument-less `new Date()`.
- KPI cell: `number | { lt: number } | { hidden: "suppressed" | "locked" | "not_computed" | "open_period" | "blocked" }` (spec v3's `number | {lt} | null` with the reason inside; the S8 adapter maps a route's `null` plus reason to `{hidden}`; a raw `null` reaching the UI renders `not_computed`). The document holds no hash of unsuppressed data (spec v3: that would be an oracle for hidden cells). Periods after the clock's month are not in the document. DOM: `data-kpi`, `data-period`, `data-cell`; text: a value in its `cell-rules` format, `lt` as `<N`, a hidden kind as its `cell-rules.labels` text.
- `data-test` hooks: only those listed in the golden files up to the current slice.
- `createFixtureWriter({ mode: "instant" | "hold" })` records every call; `hold` keeps calls pending until a `release` step.
- Imports: `src/**` imports only `src/**`, `preact` and `preact/hooks` (so the UI cannot reach the oracle or the gates); only `src/main.tsx` imports `src/fixtures/`.

## 4. Files and branches

- Design artifacts in `plans/ledger-ui/design/` (verbatim): `mockup.html`, `smoke.mjs`, `buzz-school-briefs.md`, `dashboard-lockdown-spec-v3.md`, `mockup-host.css`, and `mart/` written only by `L/tools/snapshot-mart.ts` (merged in PR #111).
- Each slice branch `claude/ledger-ui-s<k>-<slug>` is cut from `dev` after the previous slice merged; its PR targets `dev`; a restart is `-r2`.
- Orchestrator commit G<k> first on each slice branch. G0: package config (`package.json`, `bun.lock`, `tsconfig.json`, `bunfig.toml`, `vite.config.ts`, `index.html`), `gates/**` (runner, oracle, mockup text tool, size entry, null adapters, gates tsconfig, budget), `test/golden.test.ts`, `test/hygiene.test.ts`, `test/consistency.test.ts`, `test/golden/S0.json`. G1 adds `src/fixtures/mart/` and `test/golden/S1.json`. `src/fixtures/mart/` is written by `scripts/import-mart.ts`: one `kpis/<preset>.json` per preset holding only the allowlisted KPI rows of atm's export, and one `docs/<preset>.<viewer>.<grain>.json` per state, the v3 document `gates/oracle.ts` computes from those rows, `M/bundle.json` (`contrib`, tiers, MRR, `params.currency`) and `cell-rules` (Δ7: the fake server is the orchestrator's; the builder's fixture `Reader` only returns these files and implements no rule). All of it is protected. A builder that needs a config change asks; the orchestrator commits it.
- Protected (gate P, on the builder's commits since `roundBase`): every G path, `plans/ledger-ui/**`, `packages/ledger-ui/test/**` except `test/s<k>/`, `packages/atm/**`, any `biome.json*`, root `package.json`, `.github/**`.

## 5. Consistency gate C: one chain from fixture to pixels

The owner's chain: (a) atm's seeded scenario fixtures on `dev` and their hashes, (b) atm's read slice (`buildViews`/`writeViews`, a sha256 per object in `views/manifest.json`), (c) the KPI documents built from the snapshot, (d) what the UI renders. No second hashing scheme: the gate imports `canonicalize` and `sha256Hex` from `packages/atm/src/ledger/util.ts` (its only import is `node:crypto`) and reproduces `kpiHash` as `packages/atm/src/scenario/kpis.ts:218` defines it (rows `{kpiId, period, value}` sorted by `kpiId` then `period`, canonical JSON, sha256).

The preset set is the 15 presets in `M/SNAPSHOT.md`; all 15 have `contrib` in `M/bundle.json`; 5 have read-slice views (child-only, fee-oracle, free-only, one-payer-tier, tiny-school); the other 10 fail replay inside atm, which is atm's open bug and is listed, not hidden.

`test/consistency.test.ts` (orchestrator, part of gate T from G1 on):

| Link | Check |
|---|---|
| C1 a | per preset: `M/kpis/<p>.json.gz` (gunzipped) has `fixtureHash` and `kpisHash` equal to `packages/atm/tests/golden/scenarios/<p>.json` on the commit under test, and `kpiHash(rows)` equals `kpisHash`; every row in `src/fixtures/mart/kpis/<p>.json` equals the row of the same `kpiId` and `period` in the export |
| C2 b | per preset with views: each object's sha256 equals `manifest.objects[key]`, and each month view with a `money` object has `grossCents`, `refundedCents`, `feeCents` equal to that month's `gross_collected`, `refunds`, `stripe_fees` rows, and a month view without one has those rows absent or 0 (Δ7: free-only has no money; measured before G1: 0 mismatches) |
| C3 c | per preset × viewer × grain: `src/fixtures/mart/docs/<p>.<v>.<g>.json` equals `gates/oracle.ts` run on the committed rows now (so the committed documents cannot drift from the rules), and the fixture `Reader` returns exactly that file. The oracle: `contrib` and `self` cells carry the row value or their hidden kind; `derived`, `blocked` and `demo-only` cells follow their policy; a period without a row is `not_computed`, never 0; hidden kinds take precedence `blocked` > `open_period` > `locked` > `not_computed` > `suppressed`; the open period is the clock's month only if the preset has it (presets that end in 2026-06 have none); periods after the clock's month are dropped; currency is `bundle.profiles[p].params.currency` |
| C5 | from the slice that adds the member portal: every member-facing fixture document (the family-scoped `Reader` for one member) contains no family key and no amount belonging to another family; checked by listing every `family:` key and every amount-bearing record in the document and comparing with that member's own family |
| C4 d | per preset × viewer × grain, one mount, then by hash every view × period the dashboard can show: every rendered `[data-kpi]` cell has the document's kind and exact text, and every document cell the view lists is rendered. Size: 15 × 5 × 2 = 150 mounts, at most 15 × 5 × 2 × 3 × 12 = 5,400 renders; timed in G1, budget 120 s; over budget is red with the timing in `gates.txt` |

Any mismatch is a red gate. A C1 mismatch on the orchestrator's own G commit first means the snapshot is stale against `dev`: the orchestrator reruns `L/tools/snapshot-mart.ts` in its own PR. A mismatch on a fresh snapshot, or a C2 mismatch, means atm disagrees with itself: an outside blocker (§1). C4 makes hard-coding a KPI number cost the whole matrix, which the reviewers see in the diff.

## 6. Gates (orchestrator only; red goes back to the builder, never to reviewers)

In `W` (Δ7: no export): `git status --porcelain` must be empty; the orchestrator itself runs P (`git diff --name-only <roundBase>..HEAD` against the protected list) and refuses the round on any hit, before any builder-touched code runs; P passing means `gates/**` and the test runners are the orchestrator's own. Then `git diff --name-only dev...HEAD > R/S<k>/r<n>/changed.txt` and, in `packages/ledger-ui`, `bun install --frozen-lockfile && bun gates/run.ts --slice S<k> --changed <that file> --head <HEAD sha>`. Gates that need the app (T, S, C) run from the slice's first build; before that the orchestrator makes P, I, Y, B and H green on its G commit.

| Id | Gate | Rule |
|---|---|---|
| P | paths | the builder commit touches no protected path |
| I | install | `bun install --frozen-lockfile` |
| T | tests | two runs (Δ7: a builder test cannot patch globals the orchestrator's suites use): `bun test test/s<k>` for the builder's tests, then `bun test test/golden.test.ts test/consistency.test.ts test/hygiene.test.ts` with every golden file S0 to S<k> |
| Y | types | `bunx tsc --noEmit -p gates/tsconfig.gates.json` (strict, `src` and `test`) |
| B | Biome | the `changed.txt` `.ts .tsx .js .mjs .json .css` files under `packages/ledger-ui` except `src/fixtures/mart/**`, `bun.lock` and `test/golden/*.json`, with the export's pinned `biome check --no-errors-on-unmatched <files>`; never a bare `./` |
| H | hygiene | `src/**`: no `ajv`, `node:`, `new Function`, `eval(`, `console.`, `debugger`, `innerHTML`, `dangerouslySetInnerHTML`, `localStorage`, `sessionStorage`, `indexedDB`, `zod`, `Date.now(`, `new Date()`; the §3 import rule. `dist/`: no `new Function`, `eval(`, `node:`, `ajv`, `zod` |
| S | size | gzip bytes of the `gates/size-entry.tsx` build (null adapters, no fixtures). S0 at most 30720; S<k> at most `1.10 × size(S<k-1>)`. S0 therefore carries the mockup's whole stylesheet and the shared primitives (table, card, chip, drawer, modal, toast) |

## 7. Golden files

`test/golden/S<k>.json` (orchestrator, before the first build) holds what C does not: mockup copy, layout counts, interactions, non-KPI data. Entry `{ id, source, route, writer, steps, expect, shot }`. Steps `click`, `fill` (+`value`), `key` (+`target`), `release`; any step may carry `expect`. `expect`: `text` (exact, first match, whitespace collapsed and trimmed as in `smoke.mjs`), `contains` (scoped), `count`, `writes` (the writer's recorded calls), `absent`. Every entry also gets the absent list `NaN`, `undefined`, `null`, `[object Object]`, `Infinity`. The file's `matrix` (views × viewers × grains where the slice has them) must be covered combination by combination. Values come from the mockup run headless (`gates/mockup-text.ts`, the `smoke.mjs` pattern) or from a spec rule cited in `source`.

Moving data (the holdout for non-KPI data): the golden file lists `moves.fields`, the `Reader` fields typed as amounts or counts and the name fields (Δ7: never ids, dates, times or indexes). A `text` expectation the orchestrator marks `"moves": true` is checked a second time inside the gate, after the commit, through a `Reader` that multiplies only the listed numeric fields by a factor from `--head` (2 to 9) and appends `·` to only the listed name fields; a marked text must then exist, pass the absent list, and differ from its golden value. Every S2 to S7 entry that shows fixture numbers carries at least one marked text (the orchestrator's duty; reviewers see the golden file).

A `GOLDEN-DISPUTE` is settled before the round is scored: a G commit fixes the golden (kept on the branch and listed in the review pack) or a written rejection goes to the next build. The round counts like any other.

## 8. Screenshots and review pack

T3 preview tools, orchestrator only. App: `bun run dev -- --port 5181 --strictPort`; mockup: `python3 -m http.server 5182 -d plans/ledger-ui/design`. Each round shoots exactly the `shot.full` entries (at most 3 per slice) at 1100, 728 and 390 in light and dark: 18 shots. Per width one `preview_resize {mode:"freeform", width, height:900}`; after each resize one `preview_evaluate` returning `innerWidth`, which must equal the width (Δ7: a resize that has not applied is retried); per shot one `preview_evaluate` that sets the hash, awaits `#app.dataset.route` equal to it and writes the round's random 4-character nonce into a fixed corner element outside `#app`, then one `preview_snapshot {save:true}`. That is 1 + 6 + 36 + 1 = 44 calls per round. The mockup side is shot once per slice with three calls per shot (a `preview_navigate` for a fresh page, one `preview_evaluate` that awaits `.tab`, injects `mockup-host.css`, sets `theme`, calls `applyTheme()`, runs `mockupSteps` and writes the nonce, and the `preview_snapshot`): 1 + 6 + 54 + 1 = 62 calls. A preview call that fails is retried once; a second failure is an outside blocker (§1). `shots/manifest.json` records the commit; a pass needs it equal to HEAD. The nonce exists only in the pixels: never in the prompt, `shots/manifest.json` or `dom/*.txt` (which dump `#app` only). The recipe and image delivery were proven before v7: a mockup shot with nonce `K7QX` was read back correctly by all three reviewer models through `delegate_task` (Δ7).

Pack: one read-only copy per reviewer, `/tmp/ledger-ui-review/S<k>-r<n>/<reviewer>/`: `gates.txt`, `diff.patch`, `dom/<entry>.txt`, `shots/`, `mock/`, the golden file, `cell-rules.json`, the prompt. Prompt: slice goal; the shot pairs; the mockup's line ranges; the settled overrides reviewers score as correct, `cell-rules` winning over spec v3 prose where they differ (owner counts exact; bands as `<N`, with `dashboard.html`'s `5–9` ranges a listed difference; demo-only MRR, ARR and churn; credits outstanding blocked; `not_computed` on a zero denominator); from round 2 the list the builder got, each item to mark `fixed | not_fixed | regressed`.

## 9. Review

Axes, integers 1 to 10: `fidelity` (similarity to the mockup: layout, copy, states; spec-only states against spec v3 and `cell-rules`), `aesthetics` (spacing, type, contrast, both themes, three widths), `simplicity` (fewest concepts on screen; no dead code or one-use abstraction), `correctness` (numbers, states, null handling, Writer effects, GOAL.md section 0), `accessibility`. Anchors: 10 indistinguishable from the mockup and simpler than expected; 9 ship it, nitpicks only; 8 one real issue; 7 several; 6 or less redesign. After round 1 a new mustFix must be something that alone holds an axis at 8 or less.

Output, the final message only: `{ scores, overall, nonce, blockers:[{where,what,why,designLevel}], mustFix:[{where,what,why}], priorItems:[{item,status,waived}], wouldChange:[3], evidence:[{axis,cites,observation}] }`. Valid when: integer axes; `overall` is their minimum; `nonce` equals the round's nonce (read from a screenshot); three `wouldChange`; one `evidence` per full-shot entry and one per axis at 9 or more, each naming a pack file; an axis at 8 or less has a `mustFix` or `blocker`; a 9 with a prior item `not_fixed` or `regressed` gives a `waived` reason. An invalid answer is re-asked once (counts as a run); a second invalid answer or timeout fails the panel.

Spread = max(overall) − min(overall). Over 2: one objection round per slice (each reviewer sees the others' blockers and mustFix text, no scores, and re-scores); its scores replace the round's. "Same design blocker": two `designLevel` blockers naming the same screen and defect, as judged by the orchestrator and written into `state.json`.

## 10. Loop and budget

```
runSlice(k): r = runAttempt(k, 1); if r == CLOSED and panelsLeft >= 2: r = runAttempt(k, 2)
             return r == CLOSED ? STOP : r
runAttempt(k, a):
  branch from dev (-r2 on a restart, whose build prompt carries the postmortem); G<k>; P I Y B H green on it;
  mockup shots (once per slice); push; open the PR
  n = 1; best = none
  while n <= 3:
    budget check; roundBase = HEAD
    build (goal; best's mustFix plus every item a reviewer marked regressed; the last red gates)
      no commit, timeout or failed merge -> reset to roundBase; n += 1; next
    gates; up to 2 gate fixes; still red -> reset to roundBase; n += 1; next
    evidence; push; budget check; panel
      failed panel -> rerun once on the same HEAD; failed again -> n += 1; next
    pass -> merge; return PASS
    spread > 2 and objection unused -> objection round (its scores replace the round's); pass -> merge; return PASS
    same design blocker -> close; return CLOSED
    mean below best -> reset to best, cherry-pick the G commits made since, force-push
    else best = this round
    n += 1
  close; return CLOSED
pass: all three overall >= 9, no blockers, no unwaived regressed item, gates green, shots of HEAD
merge: PR body gets the score table; gh pr merge --merge --match-head-commit <HEAD>; record; report to the owner
close: gh pr close --delete-branch with a postmortem comment
budget per slice: <= 6 panels, <= 18 reviewer runs, <= 12 builder runs, <= 10 hours per attempt; overall <= 150 reviewer runs
```

Re-asks, reruns and objection rounds count. A failed panel gets one rerun in its round. One attempt uses at most 3 panels plus 1 objection round plus reruns; a restart runs only with at least 2 panels left. A cap that would be crossed stops the loop and reports to the owner.

## 11. State

`L/state.json` after every step: phase, protocol version, budget counters, snapshot hashes, per slice `{ status, attempt, branch, pr, gCommits, panels, runs, builderRuns, best, rounds[{ n, roundBase, commit, outcome, gates, reviewTaskIds, scores, mean, mustFixPath }] }`.

## 11a. Roles and the mockup change of 2026-11-05 (owner)

Members include admins: a role (`owner`, `admin`, `member`), not a plan. Owners and admins see the dashboard and everyone's data; other members get a member portal scoped to their own and their family's data (an adult sees the family's rows, a learner only their own). The mockup is being changed on `claude/ledger-mockup-roles` (role column and filter in Members, admins listed with "no plan", never 0, the Finance chip, owner-only role actions with a last-owner guard, a viewer-role note on the Dashboard, the member portal's scope banner and family section). Until that PR merges, no golden entry, screenshot or matrix is frozen for Members, the Dashboard's viewer chip and role note, or View as member; S0, S1's KPI cells and the other tabs go first. When it merges, slices rebase onto `dev` and the new mockup is the lockup. Data: `Reader` gains `people` (role, `financeGrant`, `planHolder`, family key) beside the members list, and a separate family-scoped `Reader` for the member portal (own and family only). Real sources in S8: buzz-school's roster for admins and grants, the family service for member scope (not atm's R2).

## 11b. Books access levels (owner, 2026-11-05; spec `R/books-levels/school-books-access-spec.md`)

Five levels replace the v2 viewers: `public`, `member`, `governance`, `finance_admin`, `owner`, each with a granularity ceiling (G1 totals to G6 identified), a grain (year, quarter, month, month and day), a delay and rounding ($1,000 public, $100 member). Finance admin now sees exactly what the owner sees (no rule, no band, no hidden cell, open month live); governance sees exact numbers to G4 with no personal data. The mockup change is on `claude/ledger-mockup-books-levels`; until it merges nothing is frozen for the Dashboard viewer states, Settings, the Plans tier editor, the Members Books chip or the portal. After it merges: `cell-rules` v3 expresses the five levels; the per-level KPI documents are regenerated (from the atm coordinating session, which owns the KPI documents and spec v4, or derived deterministically from the same exports) and gate C keeps tracing each level's document to atm's hashes; the types gain the school's per-level `books` policy, a tier's `books?: "member" | "governance"`, a person's `booksLevel`, and the Cedar actions `ViewBooks` and `ViewIdentities` (real source in S8: buzz-school's Cedar ledger area, not built yet).

## 12. Slices and done

S0 scaffold (shell: school switcher, tabs, period controls; tokens and the whole stylesheet; shared primitives; `Reader`, `Writer`, fixture adapters; gates); S1 Dashboard (Money, Members, Risk for all 15 presets, every viewer, both grains, stale banner, verified badge, the snapshot caveats); S2 Bookings; S3 Plans; S4 Members; S5 Ledger, Reports and Promos; S6 member portal; S7 Settings; S8 real adapters (atm's merged read slice and buzz-school routes A to D; may block on: no owner for buzz-school → R2 event emission, `catalog.published` not emitted, Worker wrangler config, atm's replay bug). Before S3, S4 and S5 the orchestrator records whether the tab uses the mockup's schools or the snapshot's Before University (`dataSource` and reason). Done: S0 to S7 merged at 9 or more from all three, C green on all 15 presets, `bun run dev` showing the mockup's behaviour on fixtures; S8 merged or blocked with a written reason.

## 13. Round 4 findings and answers (v6)

| Finding | Answer |
|---|---|
| Shot caps below the allowed shot set; cap hit stopped the slice | §8 exactly 18 full shots per round, 41 calls; mockup 59 once; only a twice-failed tool call stops |
| Holdout false reds on zeros, ratios, dates, counters | §7 only texts marked `moves` must move |
| C3's "owner × month equals the row" contradicted `cell-rules` | §5 C3 follows `cell-rules` policies |
| Golden-only red reset past its fix and did not advance | §7 the fix commit is kept; the round counts |
| Gate command ran from the wrong directory; files misnamed | §6 runs in `packages/ledger-ui` of the export; §5 `.json.gz` names |
| Client document carried unsuppressed hashes (an oracle) | §3 no hash in the document; C1 checks the file the Reader imports |
| `src` could import the oracle | §3 import rule for all of `src` |
| Budget could not fund the attempts | §10 3 rounds per attempt, one restart only with 2 panels left |
| Waived regressions blocked the pass without reaching the builder | §10 pass ignores waived items; regressed items go to the builder |
| Image viewing self-reported | §8 nonce in every shot; §9 answer must quote it |
| Objection fall-through, preset set, Promos owner, overrides in the prompt, restart postmortem, file-hashing ritual | §9, §5, §12, §8, §10; ritual dropped (worktrees and gate P cover it) |

## 14. Round 5 findings and answers (v7)

| Finding | Answer |
|---|---|
| The gate export had no `.git` and ran the runner from the builder's commit | §6 no export; the orchestrator runs P in `W` first, then the runner with `changed.txt` and `--head` |
| The builder had to re-implement `cell-rules` in the fixture `Reader` | §4 `import-mart.ts` writes the oracle's documents; the `Reader` only returns them; C3 checks they still equal the oracle |
| Moving data perturbed ids and dates; a crashed view could pass | §7 only `moves.fields`; a marked text must exist and pass the absent list |
| C2 on a month view with no money object | §5 C2 |
| Image reading by all three reviewers was unproven | §8 proven: all three read `K7QX` from a mockup PNG |
| Hidden-kind precedence, presets ending before the clock, currency source | §5 C3 |
| Builder tests could patch the orchestrator's suites; regressions only by reviewers | §6 T two runs, every golden file every slice |
| Stale snapshot read as atm disagreeing; C4 over budget; rerun count; nonce leaks; mockup call count; resize not applied; cell-rules over spec prose | §5, §10, §8 |
