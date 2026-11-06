# Ledger admin UI loop: protocol v4

Precise form of `plans/ledger-ui/GOAL.md` sections 2 to 7; GOAL.md wins on conflict. Status: written after Phase 0 stopped at round 3 (7/7/7); not yet scored. It answers every round 3 finding and the code review of commit `70c79698d` (§14). Changes from v3 are marked (Δ4). Companion: `L/cell-rules.v2.json`.

Names: `W` is the orchestrator worktree (its absolute path is in `state.json`, never in a child prompt or a committed file, Δ4), `L=W/plans/ledger-ui/loop`, `R=L/runs`, `E=L/evidence`.

## 1. Roles and trust

- **Orchestrator** (this thread, Opus 5.5): owns the protocol, `cell-rules`, golden files, gates, golden tools, package config, the mart snapshot, evidence, PRs, `state.json`. Writes no UI code (components, styles, the fixture adapter).
- **Builder**: one `delegate_task` per build or gate fix, `role:"implementation"`, `isolation:"worktree"` (its own checkout of the slice head). Opus 5.5 `{effort:"high"}` for S0 and S1, Sonnet 5.5 `{effort:"high"}` from S2. It commits once, never pushes, never opens a PR; its last lines are `COMMIT <sha>` and zero or more `GOLDEN-DISPUTE <entryId> <reason>`. The orchestrator brings the commit in with `git merge --ff-only <sha>` in `W`.
- **Reviewers**: three `delegate_task` per panel, `role:"review"`, `isolation:"worktree"`, started in one turn: `claude-opus-5-5 {effort:"high"}`, `claude-fable-5-1 {effort:"high"}`, provider `grok` `grok-4.7 {reasoningEffort:"high"}`. Prompts name no other reviewer and no score. Each reads its own checkout and its own read-only pack (§7). Raw outputs are written to `R` only after all three have returned.
- Child prompts contain relative repository paths and the pack path only (Δ4). A worktree is not a sandbox, so the orchestrator verifies: before each child it records `shasum -a 256` of every file under `L` (minus `evidence/`); afterwards it recomputes, restores any file it did not change from that record, and reports the tamper in `state.json`. `git status --porcelain` in `W` must be empty again.
- Timeouts (Δ4): build 90 minutes, gate fix 30 minutes, review 30 minutes, then `task_cancel`.

## 2. Package and stack

`packages/ledger-ui`, a standalone Bun package (own `package.json` and `bun.lock`, not in the root `workspaces`; the root list is explicit, and a root install pulls the whole Autumn monorepo, while the standalone install is 23 packages in about 1.3 s, measured).

| Piece | Choice |
|---|---|
| Build and dev | Vite 7.1.12; `bun run dev` (port 5181); `bun run build` emits static assets a Worker serves in S8 |
| Language | TypeScript 5.8.3: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Rendering | Preact 10 with JSX (`jsxImportSource: "preact"`), hooks only; no router, no state library |
| Styles | one `src/theme.css` with the mockup's custom properties by token name plus the host tokens of §7 (Δ4); dark is `.dark` on `#app` as in the mockup; `theme=system` follows `prefers-color-scheme` |
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

- `src/app/mount.tsx` exports `mountApp(root: HTMLElement, options: { reader: Reader; writer: Writer; clock: Clock }): { unmount(): void }`. The app reads `location.hash` at mount and on `hashchange`, and after each render commit sets `root.dataset.route` to the hash it rendered (the paint signal).
- Hash: `#/<schoolId>/<tab>?view=&month=&viewer=&preset=&grain=&period=&member=&theme=`. Tabs `plans dashboard members bookings promos ledger reports all`; `viewer` `owner finance admin locked demo`; `grain` `month quarter`; `theme` `light dark system`.
- `Clock = { today: "YYYY-MM-DD"; now: string }`; fixtures use the mockup's `TODAY="2026-11-05"`, `NOW="2026-11-05T12:00"`. No `Date.now()`, no argument-less `new Date()`.
- KPI cell: `number | { lt: number } | { hidden: "suppressed" | "locked" | "not_computed" | "open_period" | "blocked" }` (Δ4: `blocked` added for credits outstanding). This is spec v3's `number | {lt} | null` with the reason inside the value; banded counts are `lt`. The S8 adapter maps a route's `null` plus reason to `{hidden}`. A raw `null` or `undefined` reaching the UI renders as `not_computed`, never 0. DOM: `data-kpi="<kpiId>" data-period="<period>" data-cell="value|lt|suppressed|locked|not_computed|open_period|blocked"`. Text on every rendered cell: `value` matches its `cell-rules` format (exact text when the golden lists the cell, the format's pattern otherwise, Δ4); `lt` equals `<N`; a hidden kind equals that kind's label in `cell-rules.labels` exactly.
- `data-test` hooks: the union of `hooks` over every golden file up to the current slice (Δ4: so earlier slices' entries do not fail); any other `data-test` fails.
- Fixture writer: `createFixtureWriter({ mode: "instant" | "hold" })` records every call as `{ method, args }`; in `hold` each call stays pending until the golden step `release`.
- Import rule (gate H): `src/fixtures/**` imports only `src/data/**` and `src/fixtures/**`; outside `src/fixtures/`, only `src/main.tsx` imports from `src/fixtures/`.

## 3. Branches, files, protection

- `claude/ledger-ui-loop` from `dev`: `plans/ledger-ui/GOAL.md`; `plans/ledger-ui/design/` (verbatim `mockup.html`, `smoke.mjs`, `buzz-school-briefs.md`, `dashboard-lockdown-spec-v3.md`, and Δ4 `mart/` with the pinned `bundle.json`, the mart `README.md` and `SNAPSHOT.md`, so the pin no longer depends on `/tmp` or an untracked folder); `L/protocol-v*.md`, `L/cell-rules.v*.json`, `L/phase0/*.json`, `L/.gitignore`.
- Orchestrator commit G<k> on each slice branch before its first build. G0: `packages/ledger-ui/{package.json,bun.lock,tsconfig.json,bunfig.toml,vite.config.ts,index.html}`, `gates/**` (Δ4: the golden tools live here: `gates/mockup-text.ts`, `gates/golden-from-mart.ts`, `gates/holdout.ts`, `gates/run.ts`, `gates/size-entry.tsx`, `gates/null-adapters.ts`, `gates/tsconfig.gates.json`, `gates/budget.json`), `test/golden.test.ts`, `test/hygiene.test.ts`, `test/golden/probes.ts`, `test/golden/S0.json`. G1 adds `src/fixtures/mart/{bundle.json,provenance.json,cell-rules.json}` (Δ4: the one copy of the rules, read by both the adapter and the golden tools), `scripts/import-mart.ts`, `test/golden/mart-provenance.test.ts`, `test/golden/S1.json`. A builder that needs a config or dependency change asks in its report; the orchestrator decides and commits.
- Slice branches `claude/ledger-ui-s<k>-<slug>` (restarts `-r2`, `-r3`). S0 is cut from `claude/ledger-ui-loop`, PR to `dev`. S<k> is cut from S<k-1>'s passing head, PR to S<k-1>'s branch.
- Untracked in `W` (ignored by `L/.gitignore`): `state.json`, `runs/`, `evidence/`.
- Protected (gate P): every orchestrator path above; `plans/ledger-ui/**`; `packages/ledger-ui/test/**` except `test/s<k>/` of the current slice; `biome.json` and any `**/biome.json*`; root `package.json`; `.github/**`. Gate P checks only the builder's own commits (`<roundBase>..<builder sha>`), so orchestrator dispute commits between rounds never trip it (Δ4).

## 4. Golden files

`test/golden/S<k>.json` (orchestrator, before the first build):

```json
{
  "slice": "S1",
  "hooks": ["kpi-card", "kpi-value", "month-prev", "viewer-chip", "dash-badge", "stale-banner", "verified-badge"],
  "matrix": { "view": ["money", "members", "risk"], "viewer": ["owner", "finance", "admin", "locked", "demo"], "grain": ["month", "quarter"] },
  "required": { "cellKinds": ["value", "lt", "suppressed", "locked", "not_computed", "open_period", "blocked"], "presets": ["monthly-members", "free-only", "non-usd"], "states": ["stale", "verified"] },
  "probes": ["derived", "null", "missing-series"],
  "entries": [{
    "id": "dash-mm-finance-money-2026-06",
    "source": "smoke.mjs 'b4u jun gross'; cell-rules refunds_count policy contrib",
    "data": true,
    "route": "#/b4u/dashboard?view=money&month=2026-07&viewer=finance&preset=monthly-members&grain=month&theme=light",
    "covers": { "view": "money", "viewer": "finance", "grain": "month", "preset": "monthly-members" },
    "writer": "instant",
    "steps": [{ "click": "[data-test=month-prev]" }],
    "expect": {
      "text": { "[data-test=kpi-value]": "$623.00" },
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

(Δ4: the example now starts at July and steps back to June; `cellsComplete:true` entries list every rendered cell, abbreviated here; selectors take the first match, no `:first-of-type`.)

Step grammar (Δ4): `{ "click": sel }`, `{ "fill": sel, "value": v }` (set value, dispatch `input`), `{ "key": k, "target": sel }` (dispatch `keydown`), `{ "release": true }`, and any step may carry its own `expect` checked right after it, so pending states in `hold` mode are testable. `expect.writes` (Δ4) is the exact list of `{ method, args }` the fixture writer recorded so far (for example bulk confirm sending the two overdue booking ids).

Runner `test/golden.test.ts` (orchestrator), over every `S*.json` up to the current slice plus the holdout (older slices keep running, so regressions fail):

1. Completeness (Δ4): every combination in the cartesian product of `matrix` is covered by one entry's `covers`; every `required.cellKinds` value appears in some entry's `cells`; every `required.presets` and `required.states` value is covered; every mart dashboard entry has `cellsComplete:true`.
2. Mount with fixture adapters and the entry's writer mode; set the hash; after each step wait until `root.dataset.route` equals the hash and two macrotasks have passed.
3. Normalization: `textContent.replace(/\s+/g, " ").trim()` (the `smoke.mjs` rule). `text` is exact on the first match; `contains` looks only inside its selector; `count` is exact; a missing selector fails.
4. `cells` exact per §2; with `cellsComplete:true` every rendered `[data-kpi]` must be listed. The §2 per-kind rule runs on every rendered cell.
5. Absent on `#app`: `NaN`, `undefined`, `null`, `[object Object]`, `Infinity`.
6. Hooks: any `data-test` outside the union fails.

Probes (`test/golden/probes.ts`, orchestrator), named per slice in `probes` (Δ4: every slice, not only S1). S0 runs none. Each mutates the adapter's output and serves it through a probe `Reader`:
- `derived`: every field the server derives gets a sentinel no arithmetic on the shown inputs gives, per unit: amounts 123456789 minor units (`$1,234,567.89`), rates 0.777 (`77.7%`), counts 4242. The UI shows exactly the sentinel. Fields per slice: S1 the derived KPIs in `cell-rules`; S2 to S5 the aggregate fields the slice's routes return (briefs A to D: balances `available`/`held`, booking counts, ledger and report totals), listed in the golden file.
- `null`: per view, one amount and one count field set to raw `null`, to each `{hidden}` kind, and to `{lt:3}`; each renders its kind and label (raw `null` as `not_computed`), never `0` or `$0.00`.
- `missing-series`: a KPI or field dropped renders `not_computed`.

Holdout (Δ4): no holdout file exists before the gate. Inside the gate export, `gates/holdout.ts --seed <HEAD sha>` draws 20 percent of the slice's possible mart-derived entries (other months, presets, viewers) with `gates/golden-from-mart.ts` and runs them. The builder's copy of `gates.txt` shows only `holdout: N of M failed`; ids and expected texts stay in the orchestrator's copy. (A builder can run the generator itself; the holdout's job is to catch hard-coding of the visible entries, not to hide the rules.)

Literal check (Δ4, gate H): for every golden entry with `"data": true`, each `text` and `cells.*.text` value that contains a digit and is at least 4 characters long must not appear as a string literal or template literal text in `src/**` outside `src/fixtures/mart/**` (the builder's adapter is checked too). Copy from the mockup (entries without `data`) is exempt, so required text such as "Enter an amount above 0." passes.

Golden sources: (a) the mockup through `gates/mockup-text.ts` (happy-dom, the `smoke.mjs` pattern); (b) from S1 `gates/golden-from-mart.ts`, written by the orchestrator from `cell-rules` independently of the builder's adapter; (c) spec v3 by hand for states neither has, the rule cited in `source`.

Disputes: a `GOLDEN-DISPUTE` is settled before the round is scored, by a G commit that fixes the golden file or `cell-rules` (listed in the review pack) or by a written rejection for the next build. A round that failed only on entries the orchestrator then fixed is `discounted`: it does not count toward the four (§9).

## 5. Mart fixture source (from S1)

From the coordinating atm session (t3-de2004b5-1d). `/tmp/atm-mart` is read-only for this loop and ephemeral.

1. **Pinned snapshot**: `plans/ledger-ui/design/mart/bundle.json` (Δ4: committed on the loop branch), sha256 `b30adc2883efec15444dc44d082db5a23a0db11b22eb6e09fc0754c09f6c81a4`, reconcile 1308/1308, all eight presets `hashes.ok`, built from atm `b8dab4aec3b3e86905ecd9657aa94835ff3552ac` (the build script's `ATM` default, clean at backup). The live file was later rebuilt (sha256 `70fb44d5…`) with equal content per preset but different serialization; the pin does not follow it. Spot check against the mockup: `monthly-members` June gross 62300, net 59204, paying 23; `annual-prepay` January gross 573500, equal to `smoke.mjs`.
2. **Import**: `bun scripts/import-mart.ts --from <file> --sha256 <expected> --atm-commit <sha> --atm-repo <path>`, all required. It refuses unless the computed sha256 (`Bun.CryptoHasher`) equals `--sha256`, `reconcile.ok == reconcile.cells`, every preset `hashes.ok`, and `git -C <atm-repo> cat-file -e <atm-commit>` succeeds. It writes `src/fixtures/mart/bundle.json` (verbatim) and `provenance.json` `{ source, sha256, reconcile, atmCommit, generated, importedAt, presets }`. `mart-provenance.test.ts` recomputes the committed file's hash. For S3 to S5 facts, the script exports `out/*.parquet` views with `duckdb -json` to `fixtures/mart/facts/<view>.json` with per-file hashes, under the same refusals (the parquet files are in the mart snapshot's source; if `/tmp/atm-mart` is gone, the coordinating session is asked to rebuild).
3. **Cell rules**: `cell-rules.v2.json` (copied to `src/fixtures/mart/cell-rules.json` in G1) is the one written spec. Per KPI: kind (`amount`, `count`, `rate` with `rateOf`), policy (`contrib` with its key, `self`, `derived` with inputs and denominator, `blocked`, `demo-only`), format. Also the viewer table, band (`0` exact, else `{lt: 5*(floor(v/5)+1)}`, counts only, Δ4), complementary group, quarter rules, labels, formats (money follows the document currency, Δ4).
4. **Fixture adapter** (builder, `src/fixtures/kpi-document.ts`): one function `kpiDocument(bundle, rules, { preset, viewer, grain, clock }): KpiDocument` returns the v3 document `{ school, year, basis:"cash", currency, tz, kpiSpecVersion, grain, asOf, lagMinutes, partialPeriods, rules:{ minContributors, maxShare }, periods, series, meta, notComputed, verified }`. Every state comes from it; none is hand-written. Viewers per `cell-rules.viewers`. Months after the clock's month are not in the document. Grain `quarter` when the preset has fewer than 10 active payers over the rolling 12 months or when the route asks `grain=quarter` (no preset with real payments is under 10 payers, so the small-school state is requested; its cells follow `cell-rules.quarter`). A `stale` state sets `lagMinutes` above 15 (Δ4). It stands in for the server: no UI component applies the rule or derives a number.
5. **Caveats** (golden-checked): MRR, ARR and churned members only for `viewer=demo`, labelled "derived, demo only"; credits outstanding always `blocked` with its label; the stale banner when `lagMinutes > 15` and the verified badge (Δ4, spec v3 "Mockup implications"); Ledger, Members and Plans use the mockup's invented schools until §5.7 decides otherwise.
6. **Second reference**: `/tmp/atm-mart/out/dashboard.html` (backup in `R/mart-snapshot/`). `mockup.html` is the lockup. Before the S1 build the orchestrator writes `R/S1/reference-diff.md` and reports it to the owner, including the open questions: banding as `<N` versus ranges such as `5–9`; owner counts exact (spec D1) versus "exact when the cell rules pass" (the spec's principal table); the host tokens of §7. The builder follows the mockup where it has the screen and may follow `dashboard.html` for spec-required states the mockup lacks (the entry's `source` says so); conflicts wait for the owner while the mockup holds.
7. **S3 to S5 data source**: before each, `slices.S<k>.dataSource` (`mockup` or `mart`) and `dataSourceReason` go into `state.json`. If `mart`: the layout stays, the school is Before University, and that tab's golden entries are regenerated from mart facts in the same G commit.

## 6. Gates (orchestrator only)

Before the first build of a slice the orchestrator runs every gate on G<k> itself and fixes its own files until green. A red gate whose failing paths are all protected is an orchestrator fix: no builder run, no round.

Preconditions: `git status --porcelain` empty in `W`; HEAD descends from `roundBase`; `git archive HEAD packages/ledger-ui biome.json | tar -x -C /tmp/ledger-ui-gates/<sha>` (Δ4: the root `biome.json` comes along, so Biome uses the repo config). Run: `cd /tmp/ledger-ui-gates/<sha>/packages/ledger-ui && bun gates/run.ts --slice S<k> --repo <W> --base <sliceBase> --round-base <roundBase> --builder-commit <sha>`. Output: the full `R/S<k>/r<n>/gates.txt` and the redacted `gates.builder.txt` (§4 holdout). Stop at the first red gate.

| Id | Gate | Rule |
|---|---|---|
| P | paths | `git diff --name-only <roundBase>..<builder sha>` touches no protected path |
| I | install | `bun install --frozen-lockfile` in the export |
| T | tests | `bun test` in the export: `test/s*/`, golden, holdout, probes, provenance, hygiene; prints entry and combination counts |
| Y | types | `bunx tsc --noEmit -p gates/tsconfig.gates.json` (standalone strict options, `include: ["src", "test"]`) |
| B | Biome | file list from `git diff --name-only --diff-filter=d <sliceBase>...HEAD -- packages/ledger-ui`, filtered to `.ts .tsx .js .mjs .json .css`, minus `src/fixtures/mart/**`, `bun.lock`, `test/golden/*.json`; checked in the export with its `node_modules/.bin/biome check --no-errors-on-unmatched <paths>` after asserting `biome --version` equals the root pin. Never a bare `./` |
| H | hygiene | `test/hygiene.test.ts`. Source (package files except `test/`, `gates/`, `scripts/`, `node_modules/`, `dist/`): `ajv`, `node:`, `new Function`, `eval(`, `console.`, `debugger`, `dangerouslySetInnerHTML`, `innerHTML`, `localStorage`, `sessionStorage`, `indexedDB`, `zod`, `Date.now(`, `new Date()`; the §2 import rule; the §4 literal check. Built `dist/`: `new Function`, `eval(`, `node:`, `ajv`, `zod` (Preact's runtime contains `innerHTML`) |
| S | size | Δ4, GOAL.md's rule as written: `bun run build:size` builds `gates/size-entry.tsx` (mounts `mountApp` with `gates/null-adapters.ts`, imports nothing from `src/fixtures/`). Size = gzip bytes of all emitted `.js` and `.css`. S0 must stay under the absolute ceiling `gates/budget.json.S0Ceiling = 30720`. At each pass the orchestrator records the slice's size; S<k> fails if its size exceeds `1.10 × size(S<k-1>)`. Owner question (open): if a slice that adds a whole tab cannot fit in 10 percent, the rule is a blocker for the owner, not something the orchestrator relaxes |

## 7. Evidence and review pack

After green gates, in `E/S<k>/r<n>/`: `gates.txt`, `diff.patch` (`git diff <sliceBase>...HEAD -- packages/ledger-ui`), `diffstat.txt`, `dom/<entryId>.txt` (`bun gates/run.ts --dump dom`), `shots/<entryId>-<width>-<theme>.png`, `shots/manifest.json` `{ commit, takenAt, files: { name: sha256 } }`. Mockup side once per slice, with G<k>: `E/S<k>/mock/text/<entryId>.txt`, `E/S<k>/mock/shots/*.png` with its own manifest.

Review packs (Δ4): one copy per reviewer, `/tmp/ledger-ui-review/S<k>-r<n>/<opus|fable|grok>/`, containing this round's `E/S<k>/r<n>/`, the slice's `mock/`, the golden file, `cell-rules.json` and the prompt, then `chmod -R a-w`. After the panel the orchestrator re-hashes each copy against the manifests; a changed copy invalidates that reviewer's answer (re-asked once on a fresh copy).

Host tokens (Δ4): the mockup uses `--font-sans`, `--font-mono` and `--radius` without defining them and has colours only under `.app.light` and `.app.dark` (it expects its chat host to supply the rest). `plans/ledger-ui/design/mockup-host.css` defines `--font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`, `--font-mono: ui-monospace, SFMono-Regular, Menlo, monospace`, `--radius: 10px`; the screenshot evaluate injects it, and `src/theme.css` uses the same three values. Listed for the owner in `R/S1/reference-diff.md` as a decision taken.

Screenshot recipe (T3 preview tools, orchestrator), Δ4: one evaluate per shot that waits for paint itself:
1. `cd <W>/packages/ledger-ui && bun run dev -- --port 5181 --strictPort` (background); mockup side `python3 -m http.server 5182 -d <W>/plans/ledger-ui/design` (background).
2. `preview_open {url, open:false, reuseExistingTab:false}`.
3. Per width (outer loop) one `preview_resize {mode:"freeform", width, height:900}`. Per app shot one `preview_evaluate` that sets `location.hash` and awaits a Promise resolving when `#app.dataset.route` equals it (`awaitPromise` defaults to true), then one `preview_snapshot {save:true}` and a copy of `screenshotPath`. Per mockup shot one `preview_navigate` to the mockup URL (fresh state), one `preview_evaluate` that awaits `.tab`, injects `mockup-host.css`, runs `theme='<light|dark>';applyTheme();` and the entry's `mockupSteps`, and awaits two animation frames, then one `preview_snapshot`.
4. Every round shoots every `shot.full` entry (at most 3 per slice) at 1100, 728, 390 in light and dark, and other `shot` entries (at most 9) at 1100 light when round 1, when their `dom/` text changed, or when a mustFix names them.
5. Call caps as formulas (Δ4), with `s` = shots this round and `w` = widths: app `2 + w + 2s` (at most `2 + 3 + 2 × 27 = 59`), mockup `2 + w + 3s` (at most `86`), counted in `state.json`. Hitting a cap or a preview call failing twice is an orchestrator fault: re-shoot once, no round counted; a second fault stops the slice for the owner.
6. `t3_preview_close`; stop the servers.

PASS needs `shots/manifest.json.commit` equal to HEAD.

## 8. Review panel

Prompt `R/S<k>/r<n>/review-prompt.md`, identical for the three: slice goal; the pack path and the list of `shots/x.png` ↔ `mock/shots/x.png` pairs; the slice's mockup sections as `grep -n` ranges in `design/mockup.html`; from round 2, the deduped list the builder received, each item to mark `fixed | not_fixed | regressed`; any golden changes from disputes; `cell-rules` decisions that override the mockup (demo-only MRR, ARR and churn; `not_computed` breakage on a zero denominator; credits outstanding `blocked`), which reviewers score as correct (Δ4); rubric; schema.

Rubric anchors: 10 indistinguishable from the mockup and simpler than expected; 9 ship it, nitpicks only; 8 one real issue; 7 several; 6 or less redesign. Axes, each an integer 1 to 10 (Δ4): `fidelity` (layout, copy, states match the mockup; for states the mockup lacks, spec v3, `cell-rules` and the entry `source`), `aesthetics` (spacing, type, contrast, both themes, three widths), `simplicity` (UX: fewest concepts on screen; code: no dead code, no premature abstraction, every abstraction used at least twice), `correctness` (numbers, states, null handling, Writer effects, GOAL.md section 0), `accessibility` (semantic elements, labels, keyboard, focus, contrast). A new mustFix after round 1 must be something that by itself holds an axis at 8 or less.

Output, the final message only:

```json
{
  "scores": { "fidelity": 9, "aesthetics": 9, "simplicity": 9, "correctness": 9, "accessibility": 9 },
  "overall": 9,
  "imagesViewed": true,
  "shotObservations": [{ "pair": "x-1100-light", "element": "the third KPI card's value", "observation": "" }],
  "priorItems": [{ "item": "", "status": "fixed | not_fixed | regressed", "waived": "" }],
  "blockers": [{ "where": "", "what": "", "why": "", "designLevel": false }],
  "mustFix": [{ "where": "", "what": "", "why": "" }],
  "wouldChange": ["", "", ""],
  "evidence": [{ "axis": "fidelity", "cites": "shots/x-1100-light.png vs mock/shots/x-1100-light.png", "observation": "" }]
}
```

Validity (orchestrator-checked): integer axes; `overall` = min of `scores`; three `wouldChange`; at least one `evidence` per axis at 9 or more, citing a file in the pack's manifests or a `file:line` (Δ4); `imagesViewed` true and one `shotObservations` item per full pair naming a concrete visible element (Δ4); an axis at 8 or less has a `mustFix` or `blocker`; overall 9 or more with a prior item `not_fixed` or `regressed` needs a non-empty `waived`. An invalid answer is re-asked once with the reason (counts as a run). A second invalid answer or a second timeout makes the panel `FAILED`. If a reviewer twice reports `imagesViewed:false` in the S0 panel, the loop stops and asks the owner.

Definitions (Δ4): `spread(panel)` = max(overall) − min(overall). `twoDesignBlockersSameThing` = two reviewers with `designLevel:true` blockers whose `where` names the same file or screen and whose `what` the orchestrator judges the same defect (the judgment is written into `state.json`).

## 9. Loop (Δ4: every outcome has a branch)

```
runSlice(k):
  for attempt in 1..3:
    result = runAttempt(k, attempt)            # PASS | CLOSED | STOP
    if result != CLOSED: return result
  return STOP                                   # 2 restarts used: ask the owner

runAttempt(k, attempt):
  write G<k> (attempt 1) or re-apply it on the new branch -r<attempt> from the slice base
  run gates on G<k>; orchestrator fixes until green
  attempt 1: shoot the mockup side; push; open a DRAFT PR now
  n = 1; best = null; reverted = null; lastGates = null
  while n <= 4:
    if not budgetAllows(panels=0, builders=1): return STOP
    roundBase = HEAD
    outcome = build(n, best, reverted, lastGates)        # OK(sha) | TIMEOUT | NO_COMMIT
    if outcome != OK: git reset --hard roundBase; n += 1; continue      # counts as a red round
    if git merge --ff-only sha fails: orchestrator fault; retry the merge once, else return STOP
    if tamper(): restore L, record it, git reset --hard roundBase; n += 1; continue
    gates = runGates()
    while gates red on builder paths and gateFixes < 3 and budgetAllows(0, 1):
      gateFix(gates.builderCopy); gates = runGates()
    if gates red:
      lastGates = gates.builderCopy; git reset --hard roundBase    # drop the red commit
      if discounted(gates): continue                                  # red only on entries the orchestrator then fixed
      n += 1; continue
    evidence(); push
    if not budgetAllows(panels=1, builders=0): return STOP
    panel = runPanel()
    if panel == FAILED:
      if budgetAllows(1, 0): panel = runPanel()                       # same HEAD, n unchanged
      if panel == FAILED: n += 1; continue
    if passes(panel): return markPass()
    if spread(panel) > 2 and not objectionUsed(k) and budgetAllows(1, 0):
      objection = runObjectionPanel(panel)       # each sees the others' blockers and mustFix text, no scores
      if objection != FAILED: panel = objection
      if passes(panel): return markPass()
    if twoDesignBlockersSameThing(panel): return close()
    if best and mean(panel) < best.mean:
      reverted = { diffstat, axesThatFell, mustFix: dedupe(panel) }
      git reset --hard best.commit; git cherry-pick <G commits made since best.commit>   # keeps dispute fixes
      push --force-with-lease
    else:
      best = { commit: HEAD, mean: mean(panel), mustFix: dedupe(panel) }; reverted = null
    lastGates = null; n += 1
  return close()

build(n, best, reverted, lastGates): the slice goal always; plus best.mustFix if best; plus lastGates if the last
  round was red; plus, if reverted, "the last attempt (diffstat) lowered <axes>; do not repeat it; its new findings:
  <reverted.mustFix minus best.mustFix>".
passes(panel): all three overall >= 9, no blockers, no prior item 'regressed', gates green, manifest commit == HEAD.
budgetAllows(p, b): slicePanels + p <= 6 and sliceRuns + 3p <= 18 and runs + 3p <= 150
  and sliceBuilderRuns + b <= 12 and attempt wall time <= 10 hours.        # checked before every panel and every builder run
markPass(): gh pr ready; PR body = score table (reviewer x axis x round), gates, evidence path; record size; state.json; report to the owner.
close(): gh pr close <pr> --delete-branch --comment "<postmortem: approach, scores per round, reason, what the restart changes>"; return CLOSED.
```

dedupe: same `where` and intent merged; ordered blockers, then items from two or more reviewers, then the rest. Panel, run and builder caps are shared across a slice's attempts; wall time is per attempt (Δ4). `state.json` records which commits are G commits.

## 10. Resume

A resuming thread reads `state.json`, then `git log` of the slice branch, then re-reads every reviewer result of the current slice by its `taskId` with `task_status` and rebuilds the pass decision from those results. A slice is passed only if three valid results from the three named models pass §9 `passes` for the PR's head commit.

## 11. state.json

```json
{
  "phase": "phase0 | slices | done | stopped",
  "protocolVersion": 4,
  "worktree": "<absolute W>",
  "budget": { "reviewerRuns": 0, "reviewerRunsMax": 150, "builderRuns": 0, "gateFixRuns": 0, "previewCalls": 0 },
  "mart": { "sha256": "b30adc28…", "atmCommit": "b8dab4ae…", "reconcile": "1308/1308", "path": "plans/ledger-ui/design/mart/bundle.json" },
  "phase0": { "rounds": [{ "version": 1, "scores": {}, "taskIds": {} }] },
  "slices": { "S1": {
    "status": "pending | building | gates | review | passed | closed | blocked | stopped",
    "attempt": 1, "attemptStartedAt": "", "branch": "", "base": "", "pr": null, "gCommits": [],
    "panels": 0, "runs": 0, "builderRuns": 0, "objectionUsed": false,
    "dataSource": "mockup | mart", "dataSourceReason": "",
    "size": { "bytes": null },
    "best": { "commit": "", "mean": 0, "round": 0 },
    "rounds": [{ "n": 1, "roundBase": "", "commit": "", "builderTaskId": "", "outcome": "ok | timeout | no_commit | tamper | red | discounted",
      "gates": "pass | fail", "gateFixes": 0, "reviewTaskIds": { "opus": "", "fable": "", "grok": "" },
      "scores": { "opus": { "overall": 0, "axes": {} }, "fable": {}, "grok": {} },
      "blockers": 0, "mean": 0, "mustFixPath": "runs/S1/r1/mustfix.json", "reverted": false, "disputes": [], "sameThingJudgment": "" }],
    "closed": [{ "pr": 0, "branch": "", "reason": "" }]
  } },
  "updatedAt": "ISO time"
}
```

Written after every step.

## 12. Definition of done

As GOAL.md section 7. S8 is passed or `blocked` with a written reason (buzz-school #1330 to #1333, or atm PR #98 and its Worker export, not merged; facts in `R/S8/atm-read-slice-notes.md`).

## 13. Open owner questions

1. Phase 0: run a fourth round on v4 (GOAL.md allows three), accept v4 unscored, or lower the bar.
2. Size: §6 S applies GOAL.md literally (10 percent over the previous slice); a slice that adds a whole tab may not fit.
3. Owner counts: exact (spec D1) or "exact when the cell rules pass" (the spec's principal table).
4. Banding: `<N` (this cell shape) or ranges such as `5–9` (`dashboard.html`).
5. Host tokens: the three values in §7 were chosen here; the mockup's chat host may have used others.

## 14. Round 3 and code review findings and answers

| Finding | Answer |
|---|---|
| Preview caps below the recipe's own count; no consequence at the cap | §7 one evaluate per shot, caps as formulas, cap hit is an orchestrator fault |
| Completeness was a union, not the views × viewers × grains matrix | §4 `matrix` cartesian product; `cellsComplete` on every mart dashboard entry |
| Pending states and writer calls could not be asserted | §4 per-step `expect`, `expect.writes`; §2 the writer records calls |
| Literal check banned required copy and exempted the builder's adapter | §4 data entries only, 4+ characters with a digit, only `src/fixtures/mart/**` exempt |
| Revert dropped dispute fixes | §9 cherry-pick G commits since best; `gCommits` in state |
| Holdout readable before the gate and leaked through gates.txt | §4 drawn in the export with the HEAD seed; redacted builder copy; no absolute `W` in prompts or committed files |
| Probes only for S1 | §4 `probes` per slice with route aggregate fields |
| Builder timeout, failed merge, tamper, failed panel, failed gates had no branch; dispute rounds still counted; red commit stayed on HEAD; round 2 after a red round dereferenced `best` | §9 explicit outcomes, `discounted`, reset to `roundBase`, `lastGates`, panel re-run on the same HEAD |
| Builder and wall caps checked only at round start; gate fixes had a 90 minute timeout | §9 `budgetAllows` before every builder run and panel; §1 30 minute gate fix; wall time per attempt |
| Size rule did not match GOAL.md; G0 could not measure S0 | §6 S literal rule, S0 absolute ceiling, sizes recorded at pass |
| Root `biome.json` missing from the export | §6 archived with the package |
| One writable review pack for three reviewers; `imagesViewed` self-reported | §7 per-reviewer read-only copies, re-hashed; §8 `shotObservations`, citations checked against manifests |
| Adapter could not read `cell-rules` without breaking the import rule | §3 the one copy in `src/fixtures/mart/cell-rules.json` |
| Rates banded as counts; zero band contradicted `zeroIsExact` | `cell-rules.v2`: `rate` kind, band counts only, zero exact |
| Credits outstanding had no cell kind | §2 `blocked` kind and label |
| Hooks from earlier slices failed later regression runs | §2 union of hooks |
| Mockup tokens undefined, so reference shots render in fallback fonts | §7 host tokens, injected, same values in `theme.css`, owner question 5 |
| `L/tools/` missing; mart pin only in an untracked folder | §3 tools are in `gates/`; the snapshot is committed under `design/mart/` |
| Money format hard-wired to `$` | `cell-rules.v2` money follows the document currency; `non-usd` required |
| Owner-exact versus principal table; stale banner and verified badge missing | §5.6 owner question; §4 `required.states`, §5.5 |
| Example inconsistent; `:first-of-type`; value cells without golden text | §4 example, first match; §2 format pattern |
| Integer axes, spread and same-thing undefined | §8 definitions |
