# Ledger admin UI loop: protocol v3

Precise form of `plans/ledger-ui/GOAL.md` sections 2 to 7; GOAL.md wins on conflict. `W=/Users/jmac/.t3/worktrees/atm/claude-ledger-ui-loop` (orchestrator worktree), `L=W/plans/ledger-ui/loop`, `R=L/runs`, `E=L/evidence`. Changes from v2 are marked (Δ3); §13 maps every round 2 finding to its answer. Companion file: `L/cell-rules.v1.json` (the cell rule table, §5.3).

## 1. Roles and trust

- **Orchestrator** (this thread, Opus 5.5): owns the protocol, `cell-rules`, golden and holdout files, gates, all package config, the mart snapshot, evidence, PRs, `state.json`. Writes no UI code (components, styles, the fixture adapter).
- **Builder**: one `delegate_task` per build or gate fix, `role:"implementation"`, `isolation:"worktree"` (its own checkout of the slice head). Opus 5.5 `{effort:"high"}` for S0 and S1, Sonnet 5.5 `{effort:"high"}` from S2. It commits once, never pushes, never opens a PR. Its last lines are `COMMIT <sha>` and zero or more `GOLDEN-DISPUTE <entryId> <reason>` (Δ3). The orchestrator brings the commit in with `git -C W merge --ff-only <sha>`.
- **Reviewers**: three `delegate_task` per panel, `role:"review"`, `isolation:"worktree"`, started in one turn: `claude-opus-5-5 {effort:"high"}`, `claude-fable-5-1 {effort:"high"}`, provider `grok` `grok-4.7 {reasoningEffort:"high"}`. Prompts name no other reviewer and no score. They read only their own checkout and the review pack (§7). Raw outputs are written to `R` only after all three have returned.
- Children get relative paths and the review pack path only; their prompts say not to open `W` (Δ3). A worktree is not a sandbox, so the orchestrator checks instead of trusting (Δ3): before starting any child it records `shasum -a 256` of every file under `L` (excluding `evidence/`) in its own context; after the child returns it recomputes, and any difference it did not make is reverted from that record and reported. `git -C W status --porcelain` must also be empty again.
- Timeouts: builder 90 minutes, reviewer 30 minutes, then `task_cancel`.

## 2. Package and stack

`packages/ledger-ui`, a standalone Bun package (own `package.json` and `bun.lock`, not in the root `workspaces`; the root workspaces list is explicit, and a root install pulls the whole Autumn monorepo, while the standalone install is 23 packages in about 1.3 s, measured).

| Piece | Choice |
|---|---|
| Build and dev | Vite 7.1.12; `bun run dev` (port 5181); `bun run build` emits static assets a Worker serves in S8 |
| Language | TypeScript 5.8.3: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Rendering | Preact 10 with JSX (`jsxImportSource: "preact"`), hooks only; no router, no state library |
| Styles | one `src/theme.css` with the mockup's custom properties by token name; dark is `.dark` on `#app` as in the mockup; `theme=system` follows `prefers-color-scheme` |
| Data | `src/data/types.ts` (route shapes from briefs A to D, the v3 KPI document), `src/data/reader.ts`, `src/data/writer.ts`, `src/fixtures/` |
| Tests | `bun test` with `@happy-dom/global-registrator` and Preact's `render` |
| Lint | `@biomejs/biome` 2.2.2 as a package devDependency, equal to the root pin |
| Runtime deps | `preact` only |

Why (10 lines):
1. The mockup is plain DOM and CSS; Preact renders the same markup with a 4 KB runtime.
2. Keyed diffing keeps focus in inputs (member search, plan editor) that a hand-rolled re-render loses.
3. JSX escapes text, so route-provided names never reach `innerHTML`.
4. No router: UI state is one `Route` object in `location.hash`, which also gives deep links for tests and screenshots.
5. No state library: one `useReducer` at the root plus pane-local state.
6. Vite emits static assets and no server code, which is what a Worker serves (no `node:fs`, no `new Function`, no Ajv).
7. `bun test` plus happy-dom is the `design/smoke.mjs` pattern, headless, in about a second.
8. A standalone package keeps install, test, typecheck and Biome inside the package.
9. `Reader` and `Writer` are the only seam: fixtures now, the R2 reader and buzz-school routes in S8.
10. No zod: payloads typed in `types.ts`, checked by small guards only at the S8 adapter boundary.

Fixed contracts:

- `src/app/mount.tsx` exports `mountApp(root: HTMLElement, options: { reader: Reader; writer: Writer; clock: Clock }): { unmount(): void }`. The app reads `location.hash` at mount and on `hashchange` (Δ3), and after each render commit sets `root.dataset.route` to the hash it rendered (the paint signal for tests and screenshots).
- Hash: `#/<schoolId>/<tab>?view=&month=&viewer=&preset=&grain=&period=&member=&theme=`. Tabs `plans dashboard members bookings promos ledger reports all`; `viewer` `owner finance admin locked demo`; `grain` `month quarter`; `theme` `light dark system`.
- `Clock = { today: "YYYY-MM-DD"; now: string }`; fixtures use the mockup's `TODAY="2026-11-05"`, `NOW="2026-11-05T12:00"`. No `Date.now()`, no argument-less `new Date()`.
- KPI cell (Δ3): the document cell is `number | { lt: number } | { hidden: "suppressed" | "locked" | "not_computed" | "open_period" }`. This is spec v3's `number | {lt} | null` with the reason carried inside the value; banded counts are `lt`. The S8 adapter maps the route's `null` plus reason to `{hidden}`. A raw `null` or `undefined` cell reaching the UI renders as `not_computed`, never 0. DOM: `data-kpi="<kpiId>" data-period="<period>" data-cell="value|lt|suppressed|locked|not_computed|open_period"`. Text, checked on every rendered cell: `value` equals the golden text; `lt` equals `<N`; a hidden kind equals that kind's label from `cell-rules` exactly (Δ3: labels may contain digits, such as "fewer than 5 families").
- `data-test` hooks: exactly the names listed in the slice's golden `hooks` array; the runner fails on any other `data-test` (Δ3).
- Fixture writer: `createFixtureWriter({ mode: "instant" | "hold" })`; in `hold` every call stays pending until the golden step `release`.
- Import rule (Δ3, gate H): `src/fixtures/**` imports only `src/data/**` and `src/fixtures/**`; outside `src/fixtures/`, only `src/main.tsx` imports from `src/fixtures/`.

## 3. Branches, files, protection

- `claude/ledger-ui-loop` from `dev`, commit L0: `plans/ledger-ui/GOAL.md`, `plans/ledger-ui/design/` (verbatim `mockup.html`, `smoke.mjs`, `buzz-school-briefs.md`, `dashboard-lockdown-spec-v3.md`), `L/protocol-v*.md`, `L/cell-rules.v*.json`, `L/phase0/*.json`, `L/tools/`, `L/.gitignore`.
- Orchestrator commit G<k> on each slice branch before its first build. G0: `packages/ledger-ui/{package.json,bun.lock,tsconfig.json,bunfig.toml,vite.config.ts,index.html}`, `gates/**`, `test/golden.test.ts`, `test/hygiene.test.ts`, `test/golden/probes.ts`, `test/golden/S0.json`. G1 adds `test/golden/cell-rules.json` (copy of `L/cell-rules.v1.json`), `src/fixtures/mart/{bundle.json,provenance.json}`, `scripts/import-mart.ts`, `test/golden/mart-provenance.test.ts`, `test/golden/S1.json`. A builder that needs a config or dependency change asks in its report; the orchestrator decides and commits.
- Slice branches `claude/ledger-ui-s<k>-<slug>` (restarts `-r2`, `-r3`). S0 is cut from `claude/ledger-ui-loop`, PR to `dev`, so the design artifacts and protocol land with S0 (GOAL.md section 0). S<k> is cut from S<k-1>'s passing head, PR to S<k-1>'s branch.
- Untracked in `W` (ignored by `L/.gitignore`): `state.json`, `runs/`, `evidence/`.
- Protected (gate P): every orchestrator path above; `plans/ledger-ui/**`; `packages/ledger-ui/test/**` except `test/s<k>/` of the current slice (slice tests live only there); `biome.json` and any `**/biome.json*`; root `package.json`; `.github/**`.

## 4. Golden and holdout files

`test/golden/S<k>.json` (orchestrator, before the first build):

```json
{
  "slice": "S1",
  "hooks": ["kpi-card", "kpi-value", "month-prev", "viewer-chip", "dash-badge", "search"],
  "required": {
    "views": ["money", "members", "risk"],
    "viewers": ["owner", "finance", "admin", "locked", "demo"],
    "grains": ["month", "quarter"],
    "cellKinds": ["value", "lt", "suppressed", "locked", "not_computed", "open_period"],
    "presets": ["monthly-members", "free-only"]
  },
  "entries": [{
    "id": "dash-mm-finance-money-2026-06",
    "source": "smoke.mjs 'b4u jun gross'; cell-rules refunds_count policy contrib",
    "route": "#/b4u/dashboard?view=money&month=2026-06&viewer=finance&preset=monthly-members&theme=light",
    "covers": { "view": "money", "viewer": "finance", "grain": "month", "preset": "monthly-members" },
    "writer": "instant",
    "steps": [
      { "click": "[data-test=month-prev]" },
      { "fill": "[data-test=search]", "value": "ann" },
      { "key": "Enter", "target": "[data-test=search]" },
      { "release": true }
    ],
    "expect": {
      "text": { "[data-test=kpi-card]:first-of-type [data-test=kpi-value]": "$623.00" },
      "contains": { "[data-test=dash-badge]": ["Fixture data"] },
      "count": { "[data-test=kpi-card]": 5 },
      "cells": {
        "gross_collected@2026-06": { "cell": "value", "text": "$623.00" },
        "refunds_count@2026-06": { "cell": "suppressed" }
      },
      "cellsComplete": true
    },
    "shot": { "full": true, "mockupSteps": "document.querySelector('.tab[data-p=dash]').click()" }
  }]
}
```

(The example's steps show the grammar; a real entry lists only steps that apply.)

Runner `test/golden.test.ts` (orchestrator), over every `S*.json` up to the current slice plus the holdout file when present (older slices keep running, so regressions fail):

1. Completeness: every value in each `required` list is covered by some entry's `covers`, and every `cellKinds` value appears in some entry's `cells` (Δ3).
2. Mount with fixture adapters and the entry's writer mode; set the hash; after each step wait until `root.dataset.route` equals the hash and two macrotasks have passed. Steps: `click`; `fill` (set value, dispatch `input`); `key` (dispatch `keydown` with `key` on `target`); `release`.
3. Normalization (Δ3): `textContent.replace(/\s+/g, " ").trim()`, the `smoke.mjs` rule. `text` is exact on the first match; `contains` looks only inside its selector; `count` is exact; a missing selector fails.
4. `cells` exact per §2; with `cellsComplete:true` every rendered `[data-kpi]` must be listed. The §2 per-kind rule runs on every rendered cell of every entry.
5. Absent on `#app`: `NaN`, `undefined`, `null`, `[object Object]`, `Infinity`.
6. Hooks: any `data-test` not in `hooks` fails.

Probes (`test/golden/probes.ts`, orchestrator), documents made by mutating the adapter's output, served by a probe `Reader`:
- No derivation: each derived KPI gets a sentinel no arithmetic on the shown inputs gives, per unit (Δ3): amounts 123456789 cents (`$1,234,567.89`), rates 0.777 (`77.7%`); the UI shows exactly the sentinel text.
- Null is not zero (Δ3): per view, one amount and one count cell set to raw `null`, to each `{hidden}` kind, and to `{lt:3}`; each renders its kind and label (raw `null` as `not_computed`), never `0` or `$0.00`.
- Missing series: a KPI dropped from `series` renders `not_computed`.

Holdout (Δ3): `R/S<k>/holdout.json`, same schema, about 20 percent of the mart-derived entries (other months and presets), never given to builders, copied into the gate export only. A builder that fits only the visible golden file fails it.

Literal check (Δ3, gate H): every golden or holdout `text` value that contains a digit must not occur as a literal anywhere in `src/` outside `src/fixtures/`.

Golden sources: (a) the mockup through `L/tools/mockup-text.mjs` (happy-dom from `/tmp/ledger-smoke/node_modules`, the `smoke.mjs` pattern); (b) from S1 `L/tools/golden-from-mart.mjs`, written by the orchestrator from `cell-rules` independently of the builder's adapter; (c) spec v3 by hand for states neither has, the rule cited in `source`.

Disputes (Δ3): a `GOLDEN-DISPUTE` is settled by the orchestrator before the round is scored: either a new G commit fixes the golden file or `cell-rules` (the review pack lists the change) or a written rejection goes to the next build. A round whose gates went red only on entries the orchestrator later fixed does not count toward the four.

## 5. Mart fixture source (from S1)

From the coordinating atm session (t3-de2004b5-1d). `/tmp/atm-mart` is read-only for this loop and ephemeral; `R/mart-snapshot/` holds a backup of `out/`, `README.md`, `build.sh`, `scripts/`.

1. **Pinned snapshot** (Δ3): the bytes to import are the backup `R/mart-snapshot/bundle.json`, sha256 `b30adc2883efec15444dc44d082db5a23a0db11b22eb6e09fc0754c09f6c81a4`, reconcile 1308/1308, all eight presets `hashes.ok`, built from atm `b8dab4aec3b3e86905ecd9657aa94835ff3552ac` (the build script's `ATM` default, clean at backup). The live file was later rebuilt (sha256 `70fb44d5…`) with equal content per preset but different serialization; the pin does not follow it. Spot check against the mockup: `monthly-members` June gross 62300, net 59204, paying 23; `annual-prepay` January gross 573500, all equal to `smoke.mjs`.
2. **Import**: `bun scripts/import-mart.ts --from <file> --sha256 <expected> --atm-commit <sha> --atm-repo <path>`, all required. It refuses unless the file's computed sha256 (`Bun.CryptoHasher`) equals `--sha256` (the orchestrator passes `state.json mart.sha256`), `reconcile.ok == reconcile.cells`, every preset `hashes.ok`, and `git -C <atm-repo> cat-file -e <atm-commit>` succeeds. It writes `src/fixtures/mart/bundle.json` (verbatim) and `provenance.json` `{ source, sha256, reconcile, atmCommit, generated, importedAt, presets }`. The committed G1 copy is the durable source from then on. `mart-provenance.test.ts` recomputes the committed file's hash against `provenance.json`. When S3 to S5 use facts, the script exports the needed `out/*.parquet` views with `duckdb -json` to `fixtures/mart/facts/<view>.json` with per-file hashes, under the same refusals.
3. **Cell rules** (Δ3): `cell-rules.json` is the one written spec both the orchestrator's golden generator and the builder's adapter follow. Per KPI: kind (amount or count), policy (`contrib` with its contrib key, `self`, `derived` with inputs and denominator, `blocked`, `demo-only`), format. Also the viewer table, band formula (`{lt: 5*(floor(v/5)+1)}`), complementary group (tier revenue under gross), quarter rules, hidden-kind labels, number formats. Highlights: a zero cell is exact; a null contrib with a non-zero value is `not_computed`; a derived cell is suppressed when an input is hidden and `not_computed` when its denominator is 0.
4. **Fixture adapter** (builder, `src/fixtures/kpi-document.ts`): one function `kpiDocument(bundle, rules, { preset, viewer, grain, clock }): KpiDocument` returns the v3 document `{ school, year, basis:"cash", currency, tz, kpiSpecVersion, grain, asOf, lagMinutes, partialPeriods, rules:{ minContributors, maxShare }, periods, series, meta, notComputed }`. Every state comes from it; none is hand-written. Viewers per `cell-rules.viewers`: `owner` exact with the open month; `finance` the cell rule with the open month; `admin` amounts `locked`, counts banded, open month `open_period`; `locked` (PIN locked) amounts `locked`, counts exact, open month `open_period`; `demo` the cell rule, open month `open_period`, preset switcher, demo badge. Months after the clock's month are not in the document. Grain: `quarter` when the preset has fewer than 10 active payers over the rolling 12 months or when the route asks `grain=quarter` (the "small school" state; Δ3: no preset with real payments is under 10 payers, so the state is requested, and its cells follow `cell-rules.quarter`: summed amounts and event counts, distinct counts `not_computed`, a quarter passes only if each of its months passes). It stands in for the server: no UI component applies the rule or derives a number.
5. **Caveats** (golden-checked): MRR, ARR and churned members are derived, not atm KPIs: only `viewer=demo` shows them, labelled "derived, demo only"; other viewers get them in `notComputed`. Credits outstanding is always `blocked` with its reason. Ledger, Members and Plans use the mockup's invented schools until §5.6 decides otherwise.
6. **Second reference**: `/tmp/atm-mart/out/dashboard.html` (backup in `R/mart-snapshot/`). `mockup.html` is the lockup. Before the S1 build the orchestrator writes `R/S1/reference-diff.md` (each difference, both sides) and reports it to the owner (known now: `dashboard.html` bands counts as ranges such as `5–9`, the cell shape here has only `<N`; it has Credits and bookings tabs the mockup's dashboard lacks). The builder follows the mockup where it has the screen, may follow `dashboard.html` for spec-required states the mockup lacks (the entry's `source` says so), and conflicts wait for the owner while the mockup holds.
7. **S3 to S5 data source**: before each, `slices.S<k>.dataSource` (`mockup` or `mart`) and `dataSourceReason` go into `state.json`. If `mart`: the layout stays, the school is Before University, and that tab's golden entries are regenerated from mart facts in the same G commit, replacing the mockup-valued ones.

## 6. Gates (orchestrator only)

Before the first build of a slice the orchestrator runs every gate on G<k> itself and fixes its own files until green (Δ3). A red gate whose failing paths are all protected is an orchestrator fix: no builder run, no round (Δ3).

Preconditions: `git -C W status --porcelain` empty; HEAD descends from `roundBase`; `git archive HEAD packages/ledger-ui | tar -x -C /tmp/ledger-ui-gates/<sha>`; copy `R/S<k>/holdout.json` into the export's `test/golden/`. Run: `cd /tmp/ledger-ui-gates/<sha>/packages/ledger-ui && bun gates/run.ts --slice S<k> --repo W --base <sliceBase> --round-base <roundBase>`, output to `R/S<k>/r<n>/gates.txt`, stop at the first red gate.

| Id | Gate | Rule |
|---|---|---|
| P | paths | `git -C W diff --name-only <roundBase>..HEAD` touches no protected path |
| I | install | `bun install --frozen-lockfile` in the export |
| T | tests | `bun test` in the export: `test/s*/`, golden, holdout, probes, provenance, hygiene; the golden count and covered combinations are printed |
| Y | types | `bunx tsc --noEmit -p gates/tsconfig.gates.json` (standalone strict options, `include: ["src", "test"]`) |
| B | Biome | file list from `git -C W diff --name-only --diff-filter=d <sliceBase>...HEAD -- packages/ledger-ui`, filtered to `.ts .tsx .js .mjs .json .css`, minus `src/fixtures/mart/**`, `bun.lock`, `test/golden/*.json` (Δ3: verbatim or generated orchestrator data); checked in the export by the export's `node_modules/.bin/biome check --no-errors-on-unmatched <paths relative to the package>` (Δ3), after asserting `biome --version` equals the root `package.json` pin. Never a bare `./` |
| H | hygiene | `test/hygiene.test.ts`. Source (package files except `test/`, `gates/`, `scripts/`, `node_modules/`, `dist/`): `ajv`, `node:`, `new Function`, `eval(`, `console.`, `debugger`, `dangerouslySetInnerHTML`, `innerHTML`, `localStorage`, `sessionStorage`, `indexedDB`, `zod`, `Date.now(`, `new Date()`; the §2 import rule; the §4 literal check. Built `dist/`: `new Function`, `eval(`, `node:`, `ajv`, `zod` (Preact's runtime itself contains `innerHTML`) |
| S | size | Δ3, one rule: `bun run build:size` builds the orchestrator's `gates/size-entry.tsx`, which mounts `mountApp` with `gates/null-adapters.ts` and imports nothing from `src/fixtures/`, so no exclusion is needed and nothing can hide. Size = gzip bytes of all emitted `.js` and `.css`. G0 measures the scaffold `S0` and writes `gates/budget.json` `{ "S0": <bytes>, "budget": 4 * S0 }`. A slice fails if it grows more than `0.10 * budget` over the previous slice's recorded size, or if the total exceeds `budget`. No raises: a slice that needs more is a blocker for the owner |

## 7. Evidence and review pack

After green gates, in `E/S<k>/r<n>/`: `gates.txt`, `diff.patch` (`git diff <sliceBase>...HEAD -- packages/ledger-ui`), `diffstat.txt`, `dom/<entryId>.txt` (`bun gates/run.ts --dump dom`), `shots/<entryId>-<width>-<theme>.png`, `shots/manifest.json` `{ commit, takenAt, files }` (Δ3). Mockup side once per slice, made with G<k>: `E/S<k>/mock/text/<entryId>.txt` and `E/S<k>/mock/shots/*.png`.

Review pack (Δ3): `cp -R` of this round's `E/S<k>/r<n>/`, the slice's `mock/`, the golden file, `cell-rules.json` and the review prompt into `/tmp/ledger-ui-review/S<k>-r<n>/`. Reviewers get only that absolute path and their checkout. Nothing with scores or earlier reviews is in the pack.

Screenshot recipe (T3 preview tools, orchestrator):
1. `cd W/packages/ledger-ui && bun run dev -- --port 5181 --strictPort` (background); for the mockup side `python3 -m http.server 5182 -d W/plans/ledger-ui/design` (background).
2. `preview_open {url:"http://localhost:5181/", open:false, reuseExistingTab:false}`.
3. Per width (outer loop) `preview_resize {mode:"freeform", width, height:900}`; per shot `preview_evaluate {expression:"location.hash='<route with theme>'"}`, `preview_wait_for {selector:"#app[data-route='<hash>']"}` (Δ3), `preview_snapshot {save:true}`, copy `screenshotPath`. Mockup tab: `location.reload()`, `preview_wait_for {selector:".tab"}`, then `theme='<light|dark>';applyTheme();` (the mockup has no `prefers-color-scheme`; dark is `#app.dark`) and the entry's `mockupSteps`.
4. Every round shoots every `shot.full` entry (at most 3 per slice) at 1100, 728, 390 in light and dark (Δ3: no stale full shots), and other `shot` entries (at most 9) at 1100 light when round 1, when their `dom/` text changed, or when a mustFix names them.
5. Caps: 70 preview calls per round, 90 for the once-per-slice mockup side (Δ3); counted in `state.json`. A preview call that fails twice ends the shooting; that round's panel is skipped as a red gate (screens are required evidence).
6. `t3_preview_close`; stop the servers.

PASS needs `shots/manifest.json.commit` equal to HEAD (Δ3).

## 8. Review panel

Prompt `R/S<k>/r<n>/review-prompt.md`, identical for the three: slice goal; the pack path and the list of `shots/x.png` ↔ `mock/shots/x.png` pairs; the slice's mockup sections as `grep -n` ranges in `design/mockup.html`; from round 2, the deduped list the builder received, each item to mark `fixed | not_fixed | regressed`; any golden changes from disputes; rubric; schema.

Rubric anchors: 10 indistinguishable from the mockup and simpler than expected; 9 ship it, nitpicks only; 8 one real issue; 7 several; 6 or less redesign. Axes: `fidelity` (layout, copy, states match the mockup; for states the mockup lacks, spec v3, `cell-rules` and the entry `source`), `aesthetics` (spacing, type, contrast, both themes, three widths), `simplicity` (UX: fewest concepts on screen; code: no dead code, no premature abstraction, every abstraction used at least twice), `correctness` (numbers, states, null handling, Writer effects, GOAL.md section 0), `accessibility` (semantic elements, labels, keyboard, focus, contrast). A new mustFix after round 1 must be something that by itself holds an axis at 8 or less.

Output, the final message only:

```json
{
  "scores": { "fidelity": 9, "aesthetics": 9, "simplicity": 9, "correctness": 9, "accessibility": 9 },
  "overall": 9,
  "imagesViewed": true,
  "priorItems": [{ "item": "", "status": "fixed | not_fixed | regressed", "waived": "" }],
  "blockers": [{ "where": "", "what": "", "why": "", "designLevel": false }],
  "mustFix": [{ "where": "", "what": "", "why": "" }],
  "wouldChange": ["", "", ""],
  "evidence": [{ "axis": "fidelity", "cites": "shots/x-1100-light.png vs mock/shots/x-1100-light.png", "observation": "" }]
}
```

Validity (orchestrator-checked): `overall` = min of `scores`; three `wouldChange`; at least one `evidence` per axis at 9 or more citing a real pack file or `file:line`; an axis at 8 or less has a `mustFix` or `blocker`; `imagesViewed` is true (Δ3); overall 9 or more with a prior item `not_fixed` or `regressed` needs a non-empty `waived` saying why it no longer costs a point (Δ3). An invalid answer is re-asked once with the reason (counts as a run). A second invalid answer or a second timeout fails the round with no pass (Δ3). If a reviewer twice reports `imagesViewed:false` in S0, the loop stops and asks the owner.

## 9. Loop (Δ3: structured, every exit returns)

```
runSlice(k):
  attempt = 1
  while true:
    result = runAttempt(k, attempt)            # PASS | CLOSED | STOP
    if result == PASS: return PASS
    if result == STOP: return STOP
    # CLOSED: the PR was closed with a postmortem
    if attempt == 3: return STOP               # 2 restarts used: ask the owner
    attempt += 1                                # new branch -r<attempt> from the slice base, changed approach

runAttempt(k, attempt):
  write G<k> (attempt 1) or re-apply it on the new branch; run gates on it until green (orchestrator fixes)
  shoot the mockup side (attempt 1); push; open a DRAFT PR now
  n = 1; best = null; reverted = null
  while n <= 4:
    if not budgetAllows(1): return STOP
    roundBase = HEAD
    build(n, best, reverted)                   # see below
    if not gatesGreen(): n += 1; continue      # a failed round, no panel
    evidence(); push
    panel = runPanel()                         # three valid reviews or FAILED
    if panel == FAILED: n += 1; continue
    if passes(panel): return markPass()
    if spread(panel) > 2 and not objectionUsed(k):
      if not budgetAllows(1): return STOP
      panel = runObjectionPanel(panel)          # each sees the others' blockers and mustFix text, no scores
      if panel != FAILED and passes(panel): return markPass()
    if panel != FAILED and twoDesignBlockersSameThing(panel): return close()
    if panel != FAILED:
      if best and mean(panel) < best.mean:
        reverted = { diffstat: this round, axesThatFell, mustFix: dedupe(panel) }
        git reset --hard best.commit; push --force-with-lease
      else:
        best = { commit: HEAD, mean: mean(panel), mustFix: dedupe(panel) }; reverted = null
    n += 1
  return close()

build(n, best, reverted): n == 1: goal only. Else best.mustFix, plus if reverted: "the last attempt
  (diffstat) lowered <axes>; do not repeat it; its new findings: <reverted.mustFix minus best.mustFix>".
  Gate fix: up to 3 builder runs given gates.txt only; still red -> gatesGreen() is false.
passes(panel): all three overall >= 9, no blockers, no prior item 'regressed', gates green, manifest commit == HEAD.
budgetAllows(p): slicePanels + p <= 6 and sliceRuns + 3p <= 18 and runs + 3p <= 150
  and sliceBuilderRuns <= 12 and slice wall time <= 10 hours.   # re-asks count toward sliceRuns
markPass(): gh pr ready; PR body = score table (reviewer x axis x round), gates, evidence path; state.json; report to the owner.
close(): gh pr close <pr> --delete-branch --comment "<postmortem: approach, scores per round, reason, what the restart changes>"; return CLOSED.
```

dedupe: same `where` and intent merged; ordered blockers, then items from two or more reviewers, then the rest. Caps are shared across the attempts of one slice, so a restart runs only on what is left; if `budgetAllows` fails, the loop stops and reports.

## 10. Resume

A resuming thread reads `state.json`, then `git log` of the slice branch, then re-reads every reviewer result of the current slice by its `taskId` with `task_status` and rebuilds the pass decision from those results (Δ3: `status` alone is never trusted). A slice is passed only if three valid results from the three named models pass §9 `passes` for the PR's head commit.

## 11. state.json

```json
{
  "phase": "phase0 | slices | done | stopped",
  "protocolVersion": 3,
  "budget": { "reviewerRuns": 0, "reviewerRunsMax": 150, "builderRuns": 0, "gateFixRuns": 0, "previewCalls": 0 },
  "mart": { "sha256": "b30adc28…", "atmCommit": "b8dab4ae…", "reconcile": "1308/1308" },
  "phase0": { "rounds": [{ "version": 1, "scores": {}, "taskIds": {} }] },
  "slices": { "S1": {
    "status": "pending | building | gates | review | passed | closed | blocked | stopped",
    "attempt": 1, "branch": "", "base": "", "pr": null,
    "panels": 0, "runs": 0, "builderRuns": 0, "startedAt": "", "objectionUsed": false,
    "dataSource": "mockup | mart", "dataSourceReason": "",
    "size": { "bytes": null },
    "best": { "commit": "", "mean": 0, "round": 0 },
    "rounds": [{ "n": 1, "roundBase": "", "commit": "", "builderTaskId": "", "gates": "pass | fail", "gateFixes": 0,
      "reviewTaskIds": { "opus": "", "fable": "", "grok": "" },
      "scores": { "opus": { "overall": 0, "axes": {} }, "fable": {}, "grok": {} },
      "blockers": 0, "mean": 0, "mustFixPath": "runs/S1/r1/mustfix.json", "reverted": false, "disputes": [] }],
    "closed": [{ "pr": 0, "branch": "", "reason": "" }]
  } },
  "updatedAt": "ISO time"
}
```

Written after every step.

## 12. Definition of done

As GOAL.md section 7. S8 is passed or `blocked` with a written reason (buzz-school #1330 to #1333, or atm PR #98 and its Worker export, not merged; facts in `R/S8/atm-read-slice-notes.md`).

## 13. Round 2 findings and answers

| Finding | Answer |
|---|---|
| Cell rule implemented twice with no full spec; no way to dispute a golden | §5.3 `cell-rules.json`; §4 disputes |
| Gate B lints orchestrator data; Biome binary not installed where B looked | §6 B: exclusions, runs in the export; §6 orchestrator pre-runs gates on G<k> |
| Hidden label has digits but the rule forbade digits | §2 exact labels per kind |
| CLOSE did not return; restart did not reset; second invalid review had no branch | §9 functions, per-attempt reset, FAILED panel |
| Objection panel and re-asks bypassed the caps; no builder or wall-time cap | §9 `budgetAllows` before every panel; slice runs, builder runs, wall time |
| Stale screenshots could pass; no paint wait | §7 full shots every round, manifest commit, `data-route` wait |
| Worktree is not a sandbox; `state.json` could be forged | §1 hash check of `L` around every child; §10 rebuild from reviewer task results |
| Spec cell shape and open month per viewer; no raw-null probe | §2 mapping; §5.4 viewers; §4 raw-null probes |
| Quarterly grain only reachable by empty presets | §5.4 requested grain, `cell-rules.quarter` |
| Live bundle differs from the pin; importer did not check | §5.1 pin to the backup; §5.2 required `--sha256` and `--atm-commit` |
| Builders see all goldens, literals can be hard-coded, hooks unenforced | §4 holdout, literal check, hooks rule |
| Fixture directory could hide UI code from the size gate; two-knob size rule | §2 import rule; §6 S size entry without fixtures, one rule |
| `imagesViewed:false` and unfixed prior items could still pass | §8 validity |
| Revert dropped the reverted round's findings | §9 `build` with `reverted` |
| Coverage of the empty preset and every cell kind; normalization; `hashchange` | §4 `required`, normalization, §2 contract |
| Duplicate JSON key; owner example with a suppressed cell; per-unit sentinels | §4 example, probes |
