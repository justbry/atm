# Ledger admin UI loop: protocol v2

Precise form of `plans/ledger-ui/GOAL.md` sections 2 to 7. GOAL.md wins on any conflict. `W=/Users/jmac/.t3/worktrees/atm/claude-ledger-ui-loop` (orchestrator worktree). `L=W/plans/ledger-ui/loop`. `E=L/evidence`, `R=L/runs`.

Changes from v1 (round 1 failed: overall below 9) are marked (Δ2). Each reviewer finding is answered in §12.

## 1. Roles and isolation

- **Orchestrator** (this thread, Opus 5.5): owns the protocol, golden files, gates, package config, the mart snapshot, the evidence pack, PRs and `state.json`. Writes no UI code (components, styles, adapters, fixtures other than the mart snapshot).
- **Builder**: one `delegate_task` per build or gate fix, `role:"implementation"`, `isolation:"worktree"` (Δ2: its own checkout made from the slice head, so it cannot touch `W`'s untracked state, runs or evidence). Opus 5.5 `{effort:"high"}` for S0 and S1, Sonnet 5.5 `{effort:"high"}` from S2. It commits exactly once on the checkout's branch, never pushes, never opens a PR, and ends with `COMMIT <sha>` as its last line. The orchestrator brings the commit into `W` with `git merge --ff-only <sha>` (the checkouts share one object store).
- **Reviewers**: three `delegate_task` per panel, `role:"review"`, `isolation:"worktree"` (Δ2: a fresh checkout of the slice head; anything a reviewer writes stays in its own checkout), started in one turn, prompts that name no other reviewer and no score. Models: `claude-opus-5-5` `{effort:"high"}`, `claude-fable-5-1` `{effort:"high"}`, provider `grok` model `grok-4.7` `{reasoningEffort:"high"}`. They may only read: the paths listed in their prompt, `git diff`, `git log`, `git show`, `grep`, `cat`, PNGs. Raw panel outputs are written to `R` only after all three of the panel have returned (Δ2), so no reviewer can read a sibling's output of the same panel.
- Timeouts (Δ2): a builder run longer than 90 minutes or a reviewer run longer than 30 minutes is cancelled with `task_cancel`. A cancelled build counts as a red gate; a cancelled review is re-asked once and the re-ask counts as a run.

## 2. Package and stack

`packages/ledger-ui`, a standalone Bun package (own `package.json` and `bun.lock`, not in the root `workspaces`: a root install pulls the whole Autumn monorepo; the standalone install is 23 packages in about 1.3 s, measured).

| Piece | Choice |
|---|---|
| Build and dev | Vite 7.1.12; `bun run dev` (port 5181); `bun run build` to `dist/`, static assets a Worker serves in S8 |
| Language | TypeScript 5.8.3, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Rendering | Preact 10 with JSX (`jsxImportSource: "preact"`), hooks only; no router, no state library |
| Styles | one `src/theme.css` with the mockup's custom properties by token name; dark via `.dark` on `#app` (as the mockup), `theme=system` follows `prefers-color-scheme` |
| Data | `src/data/types.ts` (route shapes from briefs A to D and the v3 KPI document), `src/data/reader.ts`, `src/data/writer.ts`, `src/fixtures/` adapters |
| Tests | `bun test` with `@happy-dom/global-registrator` and Preact's `render` |
| Lint | `@biomejs/biome` 2.2.2 as a package devDependency, the same pin as the root `package.json` (Δ2) |
| Runtime deps | `preact` only |

Why (10 lines):
1. The mockup is plain DOM and CSS; Preact renders the same markup with a 4 KB runtime.
2. Keyed diffing keeps focus in inputs (member search, plan editor) that a hand-rolled re-render loses.
3. JSX escapes text, so route-provided names never reach `innerHTML`.
4. No router: the UI state is one `Route` object serialized in `location.hash`, which also gives deep links for tests and screenshots.
5. No state library: one `useReducer` at the root plus pane-local state.
6. Vite emits static assets with no server code, which is what a Cloudflare Worker serves (no `node:fs`, no `new Function`, no Ajv).
7. `bun test` plus happy-dom is the `design/smoke.mjs` pattern, headless, in about a second.
8. A standalone package keeps install, test, typecheck and Biome inside the package.
9. `Reader` and `Writer` are the only seam: fixtures now, the R2 reader and the buzz-school routes in S8.
10. No zod: route payloads are typed in `types.ts` and checked by small guards only at the S8 adapter boundary.

Fixed contracts (the golden runner depends on them):

- `src/app/mount.tsx` exports `mountApp(root: HTMLElement, options: { reader: Reader; writer: Writer; clock: Clock }): { unmount(): void }`. The route lives in `location.hash`.
- Hash grammar: `#/<schoolId>/<tab>?view=&month=&viewer=&preset=&grain=&period=&member=&theme=`. Tabs `plans dashboard members bookings promos ledger reports all`. `viewer`: `owner finance admin locked demo`. `theme`: `light dark system`.
- `Clock = { today: "YYYY-MM-DD"; now: string }`; fixtures use the mockup's `TODAY="2026-11-05"`, `NOW="2026-11-05T12:00"`. No `Date.now()`, no argument-less `new Date()`.
- KPI cells (Δ2): `data-kpi="<kpiId>" data-period="<period>" data-cell="value|lt|suppressed|locked|not_computed|open_period"`. A banded count is an `lt` cell. Text rules, checked on every rendered cell: `value` equals the golden text exactly; `lt` matches `^<N$` with the document's N; the four hidden kinds contain no digit and carry a visible reason label from the golden file.
- `data-test="<name>"` hooks: exactly the names the slice's golden file lists, no others.
- Fixture writer: `createFixtureWriter({ mode: "instant" | "hold" })`; in `hold` every call stays pending until the golden step `release`.

## 3. Branches, files, protection

- `claude/ledger-ui-loop` from `dev`, commit L0: `plans/ledger-ui/GOAL.md`, `plans/ledger-ui/design/` (verbatim `mockup.html`, `smoke.mjs`, `buzz-school-briefs.md`, `dashboard-lockdown-spec-v3.md`), `L/protocol-v*.md`, `L/phase0/*.json`, `L/tools/`, `L/.gitignore`.
- Orchestrator commit G<k> on each slice branch before its first build (Δ2: G0 also holds all package config): `packages/ledger-ui/{package.json,bun.lock,tsconfig.json,bunfig.toml,vite.config.ts}`, `gates/**`, `test/golden/S<k>.json`, `test/golden/probes.ts`, `test/golden.test.ts`, `test/hygiene.test.ts`, and from S1 `src/fixtures/mart/**` and `scripts/import-mart.ts`. If a builder needs a dependency or config change it says so in its report and the orchestrator decides and commits it.
- Slice branches `claude/ledger-ui-s<k>-<slug>` (restarts suffix `-r2`, `-r3`). S0 is cut from `claude/ledger-ui-loop`, PR to `dev` (so the design artifacts and protocol land with S0, as GOAL.md section 0 asks). S<k> is cut from S<k-1>'s passing head, PR to S<k-1>'s branch.
- Untracked in `W`, ignored by `L/.gitignore`: `state.json`, `runs/`, `evidence/`.

Protected paths (gate P): every orchestrator-owned path above, plus `plans/ledger-ui/**`, `packages/ledger-ui/test/**` except `test/s<k>/` for the current slice (Δ2: slice tests live only in `test/s<k>/`), `biome.json`, any `**/biome.json*` below the repo root, root `package.json`, `.github/**`.

## 4. Golden files

`packages/ledger-ui/test/golden/S<k>.json`, orchestrator-written before the slice's first build. One file describes each screen once, including whether it is shot (Δ2: v1's separate matrix file is merged in).

```json
{
  "slice": "S1",
  "required": { "views": ["money", "members", "risk"], "viewers": ["owner", "finance", "admin", "locked", "demo"], "grains": ["month", "quarter"] },
  "entries": [{
    "id": "dash-mm-owner-money-2026-06",
    "source": "mockup smoke.mjs 'b4u jun gross' + 'b4u jun net'",
    "route": "#/b4u/dashboard?view=money&month=2026-06&viewer=owner&preset=monthly-members&theme=light",
    "covers": { "view": "money", "viewer": "owner", "grain": "month" },
    "writer": "instant",
    "steps": [{ "click": "[data-test=month-prev]" }, { "fill": "[data-test=search]", "value": "ann" }, { "key": "[data-test=search]", "key": "Enter" }, { "release": true }],
    "expect": {
      "text": { "[data-test=kpi-card]:first-of-type [data-test=kpi-value]": "$623.00" },
      "contains": { "[data-test=dash-badge]": ["Fixture data"] },
      "count": { "[data-test=kpi-card]": 5 },
      "cells": { "gross_collected@2026-06": { "cell": "value", "text": "$623.00" }, "refunds_count@2026-06": { "cell": "suppressed", "label": "Hidden: fewer than 5 families" } },
      "cellsComplete": true
    },
    "shot": { "full": true, "mockupSteps": "document.querySelector('.tab[data-p=dash]').click()" }
  }]
}
```

Runner `test/golden.test.ts` (orchestrator-owned), for every `S*.json` up to the current slice (older slices keep running: regressions fail):

1. Completeness (Δ2): every combination in `required` is covered by at least one entry's `covers`, else fail.
2. Mount with fixture adapters and the entry's writer mode, set the hash, run `steps` (`click`, `fill` sets value and dispatches `input`, `key` dispatches `keydown`, `release`), awaiting two macrotasks after each.
3. `text`: exact normalized `textContent` of the first match. `contains`: substrings within that selector's scope only. `count`: exact match counts. Missing selector fails.
4. `cells`: each listed cell exists with that `data-cell` and the exact text or label. With `cellsComplete:true` every rendered `[data-kpi]` must be listed (no unexpected cells, so a wrong number anywhere fails). The §2 per-kind text rules run on every rendered cell of every entry.
5. Global absent list on `#app`: `NaN`, `undefined`, `null`, `[object Object]`, `Infinity`.

Probes (Δ2, `test/golden/probes.ts`, orchestrator-owned): documents built by mutating the fixture document after the adapter, mounted through a probe `Reader`:
- **No derivation**: set every server-derived cell (`net_income`, `refund_rate`, `arpa`, `dispute_rate`, `breakage_rate`) to a sentinel value that no arithmetic on the shown inputs gives (for example 1234567 cents); the UI must show the sentinel text exactly.
- **Null is not zero**: replace one amount and one count cell per view with each hidden kind and with `{lt:3}`; the cell must render that kind, never `0`, `$0.00` or a digit.
- **Unknown series**: drop a KPI from `series`; the card renders `not_computed`, not zero.

Golden sources: (a) the mockup, run headless by `L/tools/mockup-text.mjs <steps.json>` (happy-dom from `/tmp/ledger-smoke/node_modules`, the `smoke.mjs` pattern, prints normalized text per selector); (b) from S1 the mart snapshot through `L/tools/golden-from-mart.mjs` (§5), an implementation of the v3 cell rule written independently of the builder's adapter; (c) for spec-only states, spec v3 applied by hand with the rule cited in `source`.

## 5. Mart fixture source (Δ2, used from S1)

From the coordinating atm session (t3-de2004b5-1d). `/tmp/atm-mart` is read-only for this loop and ephemeral; a backup of its `out/`, `README.md`, `build.sh` and `scripts/` is in `R/mart-snapshot/`. At backup: `bundle.json` sha256 `b30adc2883efec15444dc44d082db5a23a0db11b22eb6e09fc0754c09f6c81a4` (computed with `shasum -a 256`), reconcile 1308/1308, all eight presets `hashes.ok`, built from atm `b8dab4aec3b3e86905ecd9657aa94835ff3552ac` (clean). Spot check against the mockup: `monthly-members` June gross 62300, net 59204, paying 23; `annual-prepay` January gross 573500, all equal to `smoke.mjs`.

1. **Snapshot** (orchestrator, G1, protected): `packages/ledger-ui/src/fixtures/mart/bundle.json` (verbatim) and `provenance.json` `{ source, generated, reconcile: "1308/1308", atmCommit, sha256, importedAt, presets }`, written only by `bun scripts/import-mart.ts [--from <dir>] [--atm <path>]`: refuses unless `reconcile.ok == reconcile.cells` and every preset `hashes.ok`; copies the file; computes sha256 with `Bun.CryptoHasher` and the atm commit with `git -C <atm> rev-parse HEAD` (never typed). `test/golden/mart-provenance.test.ts` recomputes the hash of the committed file. When S3 to S5 switch to facts, the script exports the needed `out/*.parquet` views with `duckdb -json` to `fixtures/mart/facts/<view>.json` and records each hash.
2. **Fixture adapter** (builder, `src/fixtures/kpi-document.ts`): one function `kpiDocument(bundle, { preset, viewer, clock }): KpiDocument` produces the v3 document `{ school, year, basis:"cash", currency, tz, kpiSpecVersion, grain, asOf, lagMinutes, partialPeriods, rules:{ minContributors:5, maxShare:0.6 }, periods, series, meta, notComputed }`, cells `number | { lt: N } | { hidden: "suppressed" | "locked" | "not_computed" | "open_period" }`. It stands in for the server; no UI component applies the rule or derives a number. Every state comes from this function (none hand-written):
   - `owner`: exact cells, open month (2026-11 on the fixture clock) included.
   - `finance`: cell rule from `contrib` (at least 5 holders and largest share at most 0.6, else `suppressed`), complementary suppression, a derived cell hidden when any input is, open month included.
   - `admin` (no grant): amounts `locked`, counts `{lt:N}` banded by the rule, open month `open_period`.
   - `locked` (PIN locked): amounts `locked`, counts as owner.
   - `grain:"quarter"` (4 periods) when a preset has fewer than 10 active payers over the rolling 12 months, computed, not chosen.
   - `demo`: preset switcher and demo badge.
   Months after the clock's month are not in the document.
3. **Caveats (golden-checked)**: (a) MRR, ARR and churn are derived, not atm KPIs: only `viewer=demo` shows them, labelled "derived, demo only"; every other viewer gets them in `notComputed`. (b) Credits outstanding is wrong in atm today (renewal resets are not posted; the series goes negative): the card is always blocked with a visible reason, never a number. (c) Ledger, Members and Plans use the mockup's invented schools until §5.5 decides otherwise.
4. **Second reference**: `/tmp/atm-mart/out/dashboard.html` (backup in `R/mart-snapshot/`). `mockup.html` is the lockup. Before the S1 build the orchestrator writes `R/S1/reference-diff.md` (each difference: what the mockup shows, what `dashboard.html` shows) and reports it to the owner. Where the mockup has the screen, the builder follows it. Where only `dashboard.html` has a state that spec v3 requires, the builder may follow it and the entry's `source` says so. Conflicts wait for the owner; the mockup holds meanwhile.
5. **S3 to S5 data source**: before each, the orchestrator records `slices.S<k>.dataSource` (`mockup` or `mart`) and `dataSourceReason` in `state.json`. If `mart`: the mockup layout stays, the school is Before University, the tab's golden entries are regenerated from mart facts and the mockup-valued entries for that tab are replaced in the same G commit.

## 6. Gates (orchestrator only; any red gate goes back to a builder, never to a panel)

Preconditions (Δ2): `git -C W status --porcelain` is empty, HEAD descends from `roundBase`, HEAD's tree is exported fresh with `git archive HEAD packages/ledger-ui | tar -x -C /tmp/ledger-ui-gates/<sha>`, and the gates run there by file path: `cd /tmp/ledger-ui-gates/<sha>/packages/ledger-ui && bun gates/run.ts --slice S<k> --base <sliceBase> --round-base <roundBase> --repo W`. Output to `R/S<k>/r<n>/gates.txt`. Stop at the first red gate.

| Id | Gate | Rule |
|---|---|---|
| P | paths | `git -C W diff --name-only <roundBase>..HEAD` touches no protected path (§3) |
| I | install | `bun install --frozen-lockfile` |
| T | tests | `bun test` (unit `test/s*/`, golden, probes, provenance, hygiene); golden reported separately with the count of passing entries and covered combinations |
| Y | types | `bunx tsc --noEmit -p gates/tsconfig.gates.json` (orchestrator-owned, standalone strict options, `include: ["src", "test"]`) |
| B | Biome | from `W`: `git diff --name-only --diff-filter=d <sliceBase>...HEAD -- packages/ledger-ui`, filtered to `.ts .tsx .js .mjs .json .css`, passed to `packages/ledger-ui/node_modules/.bin/biome check --no-errors-on-unmatched <files>` (Δ2: package-pinned 2.2.2, the gate asserts `biome --version` equals the root pin; repo-relative paths from the repo root; never a bare `./`) |
| H | hygiene | `test/hygiene.test.ts`. Source (every file in the package except `test/`, `gates/`, `scripts/`, `node_modules/`, `dist/`): `ajv`, `node:`, `new Function`, `eval(`, `console.`, `debugger`, `dangerouslySetInnerHTML`, `innerHTML`, `localStorage`, `sessionStorage`, `indexedDB`, `zod`, `Date.now(`, `new Date()`. Built `dist/` (Δ2: only what matters on a Worker, since Preact's runtime itself contains `innerHTML`): `new Function`, `eval(`, `node:`, `ajv`, `zod` |
| S | size | `bun run build` with the orchestrator's `vite.config.ts`, whose `manualChunks` puts every module under `src/fixtures/` in a `fixtures` chunk (Δ2: by module path, not a builder-chosen name). Measured: gzip bytes of `dist/assets/*.{js,css}` except the `fixtures` chunk. `gates/budget.json`, written in G0 after measuring the bare scaffold: `{ "S0": <measured>, "allowance": { "S1": 6144, "S2": 4096, "S3": 5120, "S4": 5120, "S5": 5120, "S6": 5120, "S7": 2048, "S8": 4096 } }`. A slice fails if its size exceeds `(S0 + sum of allowances up to S<k>) × 1.10` (Δ2: GOAL's "set in S0, fail beyond 10 percent"). At most one raise per slice, written with a reason in `state.json` and the PR body (visible to reviewers) |

## 7. Evidence pack (after green gates)

`E/S<k>/r<n>/`: `gates.txt`; `diff.patch` (`git diff <sliceBase>...HEAD -- packages/ledger-ui`); `diffstat.txt`; `dom/<entryId>.txt` (normalized `#app` text per golden entry, `bun gates/run.ts --dump dom`); `shots/<entryId>-<width>-<theme>.png`.

Mockup side, once per slice (Δ2: the mockup never changes): `E/S<k>/mock/` with `text/<entryId>.txt` from `mockup-text.mjs` and `shots/<entryId>-<width>-<theme>.png`, made when G<k> is written and reused every round.

Screenshot recipe (T3 preview tools, orchestrator only):
1. `cd W/packages/ledger-ui && bun run dev -- --port 5181 --strictPort` in the background; for the mockup side `python3 -m http.server 5182 -d W/plans/ledger-ui/design`.
2. `preview_open {url:"http://localhost:5181/", open:false, reuseExistingTab:false}` (and the mockup tab when shooting the mockup).
3. Width outer loop: `preview_resize {mode:"freeform", width, height:900}` once per width; then per shot `preview_evaluate {expression:"location.hash='<route with theme>'"}` and `preview_snapshot {save:true}`, copying `screenshotPath` into `E`. Mockup: `preview_evaluate` with `location.reload()`, then `theme='<light|dark>';applyTheme();` (Δ2: the mockup has no `prefers-color-scheme`; dark is `#app.dark`) plus the entry's `mockupSteps`.
4. Which shots: `shot.full` entries (at most 3 per slice, one per view) at 1100, 728, 390 in light and dark; other `shot` entries (at most 9) at 1100 light. Round 1 shoots all; later rounds re-shoot only entries whose `dom/` text changed plus any shot a mustFix names (Δ2).
5. Cap (Δ2): 70 preview calls per round; recorded in `state.json`. If a preview call fails twice the round continues with DOM text only and the prompt says so.
6. `t3_preview_close`; stop the servers.

## 8. Review panel

Prompt `R/S<k>/r<n>/review-prompt.md`, identical for the three: the slice goal; the evidence paths as a list of `shots/x.png` ↔ `mock/shots/x.png` pairs (Δ2: no HTML index); the golden file; the slice's mockup sections as `grep -n` line ranges in `design/mockup.html`; from round 2 the deduped mustFix list the builder received, each item to be marked `fixed | not_fixed | regressed` (Δ2: no moving target; a new mustFix after round 1 must be something that would by itself hold an axis at 8 or less); the rubric and schema below.

Rubric anchors: 10 indistinguishable from the mockup and simpler than expected; 9 ship it, nitpicks only; 8 one real issue; 7 several; 6 or less redesign. Axes: `fidelity` (layout, copy and states match the mockup; for states the mockup lacks, match spec v3 and the cited `source`, Δ2), `aesthetics` (spacing, type, contrast, both themes, three widths), `simplicity` (UX: fewest concepts on screen; code: no dead code, no premature abstraction, every abstraction used at least twice), `correctness` (numbers, states, null handling, Writer effects, GOAL.md section 0 constraints), `accessibility` (semantic elements, labels, keyboard, focus, contrast).

Output, the only content of the final message:

```json
{
  "scores": { "fidelity": 9, "aesthetics": 9, "simplicity": 9, "correctness": 9, "accessibility": 9 },
  "overall": 9,
  "imagesViewed": true,
  "priorItems": [{ "item": "", "status": "fixed" }],
  "blockers": [{ "where": "", "what": "", "why": "", "designLevel": false }],
  "mustFix": [{ "where": "", "what": "", "why": "" }],
  "wouldChange": ["", "", ""],
  "evidence": [{ "axis": "fidelity", "cites": "shots/x-1100-light.png vs mock/shots/x-1100-light.png", "observation": "" }]
}
```

Validity (orchestrator-checked; an invalid answer is re-asked once with the reason, the re-ask counts as a run): `overall` = min of `scores`; three `wouldChange`; at least one `evidence` per axis at 9 or more, each citing a real evidence file or `file:line`; an axis at 8 or less has a `mustFix` or `blocker`. `imagesViewed:false` (Δ2) is allowed but reported; if a reviewer cannot read PNGs in the S0 panel, the orchestrator tells the owner before S1.

## 9. Loop per slice (Δ2: explicit branches)

```
on slice start: write G<k>, shoot the mockup side, push the branch, open a DRAFT PR now (so close always has a PR)
n = 1; best = null                        # best = { commit, mean, mustFix }
ROUND:
  if panels(slice) + 1 > 6 or runs + 3 > 150: STOP, report scores to the owner
  roundBase = HEAD
  build: builder gets slice goal, mockup ranges, golden path, contracts, and
         n == 1 ? nothing : (best.mustFix if HEAD was reset to best else this round's deduped mustFix)
  GATES:
    red  -> gate fix (new builder run with gates.txt only), up to 3; still red -> round fails:
            n += 1; if n > 4: CLOSE; else goto ROUND        # no panel used
  evidence; push; panel (3 runs)
  if all overall >= 9 and no blockers: PASS
  if max(overall) - min(overall) > 2 and no objection round yet in this slice:
      objection round (each gets the others' blockers and mustFix text, no scores; re-scores; 1 panel)
      if all overall >= 9 and no blockers: PASS
  if two reviewers mark designLevel blockers about the same thing: CLOSE
  mean = average overall
  if best and mean < best.mean: git reset --hard best.commit; push --force-with-lease   # compare to the best kept, not the previous round
  else: best = { commit: HEAD, mean, mustFix: dedupe(this panel) }
  n += 1; if n > 4: CLOSE; goto ROUND
PASS: gh pr ready; PR body = score table (reviewer x axis x round), gate summary, evidence path, any size raise;
      state.json; report to the owner; cut the next slice from this head
CLOSE: gh pr close <n> --delete-branch --comment "<postmortem: approach, scores per round, reason, what the restart changes>";
       restarts < 2 and panels left -> restart on -r<m> from the slice base with a changed approach in the build prompt;
       otherwise STOP and ask the owner
```

dedupe: same `where` and intent merged; order blockers, then items named by two or more reviewers, then the rest. Panels across restarts of one slice share the 6-panel cap (Δ2: so the cap, not the round count, bounds cost; with gate-red rounds using no panel, 4 rounds plus 1 objection round is at most 5 panels).

## 10. state.json

```json
{
  "phase": "phase0 | slices | done | stopped",
  "protocolVersion": 2,
  "budget": { "reviewerRuns": 0, "reviewerRunsMax": 150, "builderRuns": 0, "gateFixRuns": 0, "previewCalls": 0 },
  "mart": { "sha256": "", "atmCommit": "", "reconcile": "" },
  "phase0": { "rounds": [{ "version": 1, "scores": { "opus": 0, "fable": 0, "grok": 0 } }] },
  "slices": { "S1": {
    "status": "pending | building | gates | review | passed | closed | blocked | stopped",
    "branch": "", "base": "", "pr": null, "restarts": 0, "panels": 0, "objectionRoundUsed": false,
    "dataSource": "mockup | mart", "dataSourceReason": "",
    "size": { "bytes": null, "raise": null },
    "best": { "commit": "", "mean": 0, "round": 0 },
    "rounds": [{ "n": 1, "roundBase": "", "commit": "", "builderTaskId": "", "gates": "pass | fail", "gateFixes": 0,
      "scores": { "opus": { "overall": 0, "axes": {} }, "fable": {}, "grok": {} }, "blockers": 0, "mean": 0,
      "mustFixPath": "runs/S1/r1/mustfix.json", "reverted": false }],
    "closed": [{ "pr": 0, "branch": "", "reason": "" }]
  } },
  "updatedAt": "ISO time"
}
```

Written after every step. A resuming thread reads it, then `git log` of the slice branch, and continues from `status`.

## 11. Definition of done

As GOAL.md section 7. S8 is passed or `blocked` with a written reason (buzz-school #1330 to #1333 or the atm read slice not merged).

## 12. Round 1 findings and where v2 answers them

| Round 1 finding | Answer |
|---|---|
| No-digit rule rejects `<N` and banded cells | §2 per-kind text rules; banded is `lt` |
| Gate H fails on Preact's runtime in `dist` | §6 H: `dist` only for Worker strings |
| Package config unprotected, gates run on a dirty shared tree | §3 config in G commits and protected; §6 clean tree, fresh `git archive` export, runner by file path, gates tsconfig |
| Builders and reviewers can touch `W`'s state, runs, evidence; reviewers can read siblings | §1 `isolation:"worktree"` for both; panel outputs written after all return |
| Page-wide substring checks, no derivation or null test, fixtures tunable | §4 exact scoped `text`, `cellsComplete`, probes; mart snapshot protected and hash-checked |
| No completeness rule | §4 `required` and runner step 1 |
| PASS not re-checked after objection; revert vs previous instead of best; gate-red falls to panel; PR opened late; mustFix union ping-pong | §9 |
| 6-panel cap versus 4 rounds and restarts; moving target | §9 panels shared across restarts, gate-red uses no panel; §8 prior items and the bar for new mustFix |
| Dark mockup shots wrong | §7 step 3 `applyTheme()` |
| Biome paths and machine-specific binary | §6 B |
| Size caps invented and chunk name gameable | §6 S: measured S0, per-slice allowances set in G0, 10 percent, fixtures by module path, one written raise |
| Mockup re-shot each round; unbounded shots; no timeouts | §7 mockup once per slice, shot caps, 70-call cap, re-shoot only changed; §1 timeouts |
| Evidence index.html unusable | removed |
| Tool paths and happy-dom location | §4 `L/tools/`, `/tmp/ledger-smoke/node_modules` |
| Golden step kinds | §4 `fill`, `key` |
| Slice tests prefix gameable | §3 `test/s<k>/` only |
| Grok PNG reading unknown | §8 `imagesViewed` |
| Count builder runs and preview calls | §10 budget |
| Spec-only states have no fidelity target | §8 fidelity axis |
