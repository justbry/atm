# Ledger admin UI loop: protocol v1

Precise form of `plans/ledger-ui/GOAL.md` sections 2 to 7. Where this file and GOAL.md disagree, GOAL.md wins and this file is revised. Paths are relative to the worktree root `W=/Users/jmac/.t3/worktrees/atm/claude-ledger-ui-loop` unless absolute.

## 1. Roles

- **Orchestrator** (this thread, Opus 5.5): owns the protocol, the golden files, the gates, the evidence pack, the PRs, `state.json`. Writes no UI code.
- **Builder** (one `delegate_task` per round, `role:"implementation"`, `isolation:"shared"`): Opus 5.5 effort high for S0 and S1, Sonnet 5.5 effort high from S2. Works in `W` on the slice branch the orchestrator checked out, makes exactly one commit per round, never pushes, never opens PRs.
- **Reviewers** (three `delegate_task` per panel, `role:"review"`, `isolation:"shared"`, started in the same turn, each prompt names no other reviewer and no other score): `claude-opus-5-5` `{effort:"high"}`, `claude-fable-5-1` `{effort:"high"}`, provider `grok` model `grok-4.7` `{reasoningEffort:"high"}`. Read-only: they may run `cat`, `grep`, `git diff`, `git log`, `ls` and read PNGs; they run nothing that writes (no `bun install`, no `bun test`, no `vite`, no git writes). A builder never runs while a panel runs.

## 2. Package and stack

`packages/ledger-ui`, a standalone Bun package (its own `package.json` and `bun.lock`, not in the root `workspaces`: a root install pulls the whole Autumn monorepo; a standalone install is 23 packages in about 1.3 s, measured).

| Piece | Choice |
|---|---|
| Build and dev | Vite 7.1.12, `bun run dev` (port 5181), `bun run build` to `dist/` (static assets a Worker serves in S8) |
| Language | TypeScript 5.8.3, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Rendering | Preact 10 (JSX via `jsxImportSource: "preact"`), hooks only, no router library, no state library |
| Styles | one `src/theme.css`: the mockup's CSS custom properties (light, `.dark`, and `prefers-color-scheme`), copied by token name |
| Data | `src/data/reader.ts` and `src/data/writer.ts` interfaces; `src/data/types.ts` route shapes from briefs A to D and the spec v3 KPI document; `src/fixtures/` fixture adapters |
| Tests | `bun test` with `happy-dom` (`@happy-dom/global-registrator`) and Preact's `render` |
| Runtime deps | `preact` only |

Why (10 lines):
1. The mockup is plain DOM and CSS; Preact renders the same markup with a 4 KB runtime.
2. Keyed diffing keeps focus in inputs (member search, plan editor) that a hand-rolled re-render loses.
3. JSX escapes text by default, so route-provided names never reach `innerHTML`.
4. No router: the whole UI state is one `Route` object serialized in `location.hash`, which also gives deep links for screenshots and tests.
5. No state library: one `useReducer` at the app root plus per-pane local state.
6. Vite gives static assets with no server code, which is what a Cloudflare Worker serves (no `node:fs`, no `new Function`, no Ajv anywhere).
7. `bun test` plus happy-dom runs the same smoke pattern as `design/smoke.mjs`, headless, in about a second.
8. A standalone package keeps install, test and typecheck in the package and away from the monorepo's unformatted drift.
9. The `Reader` and `Writer` interfaces are the only seam: fixtures now, the R2 reader and buzz-school routes in S8.
10. No zod: route payloads are typed by `types.ts` and checked by small hand-written guards only at the S8 adapter boundary.

Fixed contracts every slice must keep (the golden runner depends on them):

- `src/app/mount.tsx` exports `mountApp(root: HTMLElement, options: { reader: Reader; writer: Writer; clock: Clock }): { unmount(): void }`. The app reads its route from `location.hash` and writes it back on every navigation.
- Hash grammar: `#/<schoolId>/<tab>` with optional query `?view=&month=&viewer=&preset=&grain=&period=&member=&theme=`. Tabs: `plans`, `dashboard`, `members`, `bookings`, `promos`, `ledger`, `reports`, plus `all` (all schools). `viewer` is one of `owner`, `finance`, `admin`, `locked`, `demo` (fixture only).
- `Clock` is `{ today: "YYYY-MM-DD"; now: string }`; fixtures use the mockup's `TODAY="2026-11-05"`, `NOW="2026-11-05T12:00"`. No code calls `Date.now()` or `new Date()` without an argument.
- KPI cells render with `data-kpi="<kpiId>" data-period="<period>" data-cell="value|lt|suppressed|banded|locked|not_computed|open_period"`. A non-`value` cell never shows a digit; `null` is never shown as `0`, `$0.00` or a blank that reads as zero.
- `data-test="<name>"` hooks named in each slice's golden file must exist; the builder adds no other `data-test`.
- Fixture writer: `createFixtureWriter({ mode: "instant" | "hold" })`; in `hold` mode every call stays pending until `release()`, so pending states are testable.

## 3. Branches and files

- `claude/ledger-ui-loop` (from `dev`): commit L0 holds `plans/ledger-ui/GOAL.md`, `plans/ledger-ui/design/` (verbatim copies of `mockup.html`, `smoke.mjs`, `buzz-school-briefs.md`, `dashboard-lockdown-spec-v3.md`), `plans/ledger-ui/loop/protocol-v*.md`, `plans/ledger-ui/loop/phase0/*.json` (all Phase 0 scores), `plans/ledger-ui/loop/.gitignore`.
- Before each slice the orchestrator adds an orchestrator commit Gk on the slice branch: `packages/ledger-ui/test/golden/S<k>.json`, the gate scripts (S0 only, later only threshold bookkeeping), the evidence matrix `plans/ledger-ui/loop/matrix/S<k>.json`.
- Slice branches: `claude/ledger-ui-s<k>-<slug>` (restart: suffix `-r2`, `-r3`). S0 is cut from `claude/ledger-ui-loop` and its PR targets `dev`, so the design artifacts and protocol land with S0 as GOAL.md section 0 asks. S<k> is cut from S<k-1>'s branch head at its pass and its PR targets S<k-1>'s branch.
- Untracked, ignored by `plans/ledger-ui/loop/.gitignore`, kept on disk in `W` across branch switches: `state.json`, `runs/` (prompts, raw reviewer JSON, gate logs), `evidence/`.

Protected paths (gate P, section 5): a builder commit fails if it touches any of
`plans/ledger-ui/**`, `packages/ledger-ui/gates/**`, `packages/ledger-ui/test/golden/**`, `packages/ledger-ui/test/hygiene.test.ts`, `packages/ledger-ui/test/golden.test.ts`, `packages/ledger-ui/test/s<j>-*` for every `j` other than the current slice, `biome.json`, `package.json` (root), `.github/**`.

## 4. Golden files (the expected values the builder cannot edit)

`packages/ledger-ui/test/golden/S<k>.json`, written by the orchestrator before the slice's first build. Values come from (a) running `plans/ledger-ui/design/mockup.html` headless with `plans/ledger-ui/loop/tools/mockup-text.mjs` (the `smoke.mjs` pattern; prints the normalized text of a pane after a list of clicks) and (b) for states the mockup lacks (viewer chip states, hatched open month, suppressed cells, quarterly grain), the spec v3 rules applied by hand to the fixture document, with the rule cited per entry.

```json
{
  "slice": "S1",
  "entries": [
    {
      "id": "dash-b4u-owner-money-2026-06",
      "source": "mockup: smoke.mjs 'b4u jun gross' | spec v3 §The document",
      "route": "#/b4u/dashboard?view=money&month=2026-06&viewer=owner",
      "writer": "instant",
      "steps": [{ "click": "[data-test=month-prev]" }, { "release": true }],
      "expect": {
        "texts": ["$623.00", "$592.04"],
        "absent": ["NaN", "undefined", "null", "[object Object]"],
        "count": { "[data-test=kpi-card]": 5 },
        "cells": { "net_income@2026-06": "value", "refund_count@2026-06": "suppressed" }
      }
    }
  ]
}
```

`packages/ledger-ui/test/golden.test.ts` (orchestrator-owned, written in S0) loads every `test/golden/S*.json` up to the current slice, mounts the app with fixture adapters per entry, sets the hash, runs the steps (after each step it awaits two macrotasks), and asserts every `expect` field. It also asserts, for every entry, that every element with `data-cell` other than `value` has no digit in its text. Older slices' golden files keep running in later slices (no regressions).

## 5. Gates (orchestrator runs them; any failure goes back to the builder, no panel)

One command: `cd packages/ledger-ui && bun run gates` runs `gates/run.ts`, which runs in order and stops at the first failure, writing `runs/S<k>/r<n>/gates.txt`:

| Id | Gate | Command or rule |
|---|---|---|
| I | install | `bun install --frozen-lockfile` |
| T | tests | `bun test` (all tests: unit, golden, hygiene) |
| Y | types | `bunx tsc --noEmit -p tsconfig.json` |
| B | Biome | `git diff --name-only --diff-filter=d origin/dev...HEAD -- . ':!plans/ledger-ui/design'` filtered to `.ts .tsx .js .mjs .json .css`, passed to `/Users/jmac/repos/atm/node_modules/.bin/biome check --no-errors-on-unmatched <files>` (Biome 2.2.2, the repo pin; never a bare `./`) |
| S | size | `bun run build`, then gzip size of every `dist/assets/*.{js,css}` except chunks named `fixtures-*`. Budget in `gates/budget.json`: `{ "totalBytes": 81920, "perSliceBytes": 8192, "slices": { "S0": <measured> } }`. Fail if the slice adds more than `perSliceBytes` (10 percent of the 80 KB total) over the previous slice's recorded size, or the total exceeds `totalBytes`. The orchestrator records the passing size. |
| H | hygiene | `test/hygiene.test.ts` scans `src/**` and `dist/**` for `ajv`, `node:`, `new Function`, `eval(`, `console.`, `debugger`, `dangerouslySetInnerHTML`, `innerHTML`, `localStorage`, `sessionStorage`, `indexedDB`, `zod`, `Date.now(`, `new Date()`; fails on any hit outside `src/fixtures/` (fixtures may not use them either except dates with arguments) |
| P | paths | `git diff --name-only <roundBase>..HEAD` against the protected list in section 3; `<roundBase>` is the commit the builder started from |
| G | golden | part of T, reported separately in `gates.txt` with the count of passing entries |

## 6. Evidence pack (orchestrator produces it after green gates)

Directory `evidence/S<k>/r<n>/` (untracked):

- `gates.txt` (from section 5), `diff.patch` = `git diff <sliceBase>...HEAD -- packages/ledger-ui`, `diffstat.txt`.
- `dom/<entryId>.txt`: normalized `textContent` of `#app` per golden entry, dumped by `bun run gates --dump dom` (same runner, no assertions).
- `mock/<shotId>.txt`: the mockup's text for the same screen from `tools/mockup-text.mjs`.
- `shots/<shotId>-<width>-<theme>.png` (implementation) and `mockshots/<shotId>-<width>-<theme>.png` (mockup).
- `index.html`: a page with each pair side by side, generated by `tools/evidence-index.mjs`.

Screenshot recipe (T3 preview tools, orchestrator only):

1. `cd packages/ledger-ui && bun run dev -- --port 5181 --strictPort` in the background; `python3 -m http.server 5182 -d plans/ledger-ui/design` in the background.
2. `preview_open {url:"http://localhost:5181/", open:false, reuseExistingTab:false}` and a second tab for `http://localhost:5182/mockup.html`.
3. For each shot in `plans/ledger-ui/loop/matrix/S<k>.json` (`{ id, route, mockupSteps: "<JS that clicks the mockup into the same screen>", full: boolean }`): implementation tab `preview_evaluate {expression:"location.hash='<route>'"}`; mockup tab `preview_evaluate {expression:"location.reload()"}` then `preview_evaluate {expression:mockupSteps}`.
4. Widths: `full:true` shots (one per view, its default state) at 1100, 728 and 390 by `preview_resize {mode:"freeform", width, height:900}`, each in light and dark by `preview_set_appearance`; other shots at 1100 light only (their states are covered by golden tests and DOM dumps). Then `preview_snapshot {save:true}` and copy `screenshotPath` to the evidence name.
5. `t3_preview_close` both tabs; stop both servers.

## 7. Review panel

Prompt (one file per slice, `runs/S<k>/r<n>/review-prompt.md`, identical for the three reviewers): the slice goal, the paths of the evidence pack, the golden file, the slice's mockup sections (by `grep -n` line ranges in `design/mockup.html`), the rubric below, the JSON schema below, and the rules (read-only; score the work, not the effort; no reviewer sees another's output except in the objection round).

Rubric anchors (all axes): 10 indistinguishable from the mockup and simpler than expected; 9 ship it, nitpicks only; 8 one real issue; 7 several; 6 or less redesign. Axes: `fidelity` (matches the mockup's layout, copy, states), `aesthetics` (spacing, type, contrast, both themes, three widths), `simplicity` (UX: fewest concepts on screen; code: no dead code, no premature abstraction, every abstraction used at least twice), `correctness` (numbers, states, null handling, Writer effects, constraints in GOAL.md section 0), `accessibility` (semantic elements, labels, keyboard, focus, contrast).

Reviewer output, the only content of the final message, one JSON object:

```json
{
  "scores": { "fidelity": 9, "aesthetics": 9, "simplicity": 9, "correctness": 9, "accessibility": 9 },
  "overall": 9,
  "blockers": [{ "where": "file:line or shot id", "what": "", "why": "", "designLevel": false }],
  "mustFix": [{ "where": "", "what": "", "why": "" }],
  "wouldChange": ["", "", ""],
  "evidence": [{ "axis": "fidelity", "cites": "shots/dash-money-1100-light.png vs mockshots/...", "observation": "" }]
}
```

Validity (the orchestrator checks; an invalid answer is re-asked once with the reason, and the re-ask counts as a run): `overall` equals the minimum of `scores`; exactly three `wouldChange`; at least one `evidence` item per axis scored 9 or more, each citing a real evidence file or `file:line`; a score of 8 or less has at least one `mustFix` or `blocker`.

Phase 0 uses the same shape with axes `testability`, `convergence`, `antiGaming`, `simplicity`, `cost`, and cites lines of this protocol.

## 8. Loop per slice

```
round n = 1
loop:
  checkout slice branch; roundBase = HEAD
  build: delegate builder (prompt: slice goal, mockup line ranges, golden file path, interfaces, the deduped mustFix list from round n-1 if any)
  gates (section 5); on failure: a new builder delegate gets gates.txt and fixes only that (a gate fix, no panel, not a round);
    after 3 gate fixes still red: the round fails with no panel and counts toward the close rule
  evidence (section 6)
  if n == 1: push branch, open a draft PR (base per section 3)
  panel (section 7), 3 runs
  if all overall >= 9 and no blockers and gates green: PASS
  if max(overall) - min(overall) > 2 and no objection round yet this slice: objection round (each reviewer gets the others' blockers and mustFix text, no scores, and re-scores; counts as a panel)
  close check (below)
  mean(overall) < previous round's mean: git reset --hard <previous round's commit>, push --force-with-lease; the next builder gets the union of both rounds' mustFix
  dedupe mustFix (same where + same intent merged, ordered: blockers, then items named by 2+ reviewers, then the rest)
  n += 1
```

PASS: `gh pr ready <n>`; PR body gets the score table (reviewer x axis, per round), the gate summary and the evidence index path; `state.json` updated; a short report to the owner in this thread; the next slice branch is cut from this head.

Close rule (mandatory): after 4 rounds without a pass, or when two reviewers in one panel mark a `blocker` with `designLevel:true` about the same thing, run `gh pr close <n> --delete-branch --comment "<postmortem: what was tried, scores per round, the design-level reason, what the restart changes>"`, then restart the slice on `-r2` from the slice base with a changed approach written into the builder prompt. At most 2 restarts per slice; a third failure stops the loop and asks the owner.

Budget: per slice at most 6 panels (18 runs, re-asks included); overall 150 reviewer runs (Phase 0 included). The orchestrator checks the budget before every panel; if the next panel would exceed it, stop and report the scores so far.

## 9. state.json

```json
{
  "phase": "phase0" | "slices" | "done" | "stopped",
  "protocolVersion": 1,
  "budget": { "reviewerRuns": 0, "reviewerRunsMax": 150 },
  "phase0": { "rounds": [{ "version": 1, "scores": { "opus": 0, "fable": 0, "grok": 0 }, "taskIds": {} }] },
  "slices": {
    "S0": {
      "status": "pending" | "building" | "gates" | "review" | "passed" | "closed" | "blocked",
      "branch": "", "base": "", "pr": null, "restarts": 0, "panels": 0,
      "sizeBytes": null,
      "rounds": [{
        "n": 1, "roundBase": "", "commit": "", "builderTaskId": "",
        "gates": "pass" | "fail", "gateFixes": 0,
        "scores": { "opus": { "overall": 0, "axes": {} }, "fable": {}, "grok": {} },
        "blockers": 0, "mustFixPath": "runs/S0/r1/mustfix.json", "mean": 0
      }],
      "closed": [{ "pr": 0, "branch": "", "reason": "" }]
    }
  },
  "updatedAt": "ISO time"
}
```

Written after every step (build started, gates, evidence, each panel, pass, close). A resuming thread reads it, then `git log` on the slice branch, then continues from `status`.

## 10. Definition of done

As GOAL.md section 7. S8 is either passed or marked `blocked` with the reason (buzz-school PRs #1330 to #1333 or the atm read slice not merged).
