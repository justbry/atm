# Goal: build the ledger admin UI as a PR stack, hill-climbed until Opus, Fable and Grok all score it 9/10

You are the orchestrator. You do not write the UI yourself: you run the loop below. Never push to `main`, never merge a PR (the owner merges). Local gates only (do not wait on GitHub Actions). Biome only on files touched. Stop and ask the owner if the budget below is exceeded or a blocker appears.

## 0. Artifacts (the "lockup")

All in `/Users/jmac/.t3/worktrees/atm/t3-121098cf/plans/ledger-ui/` (copy what you need into your worktree in slice 0 and commit it as design artifacts):

- `mockup.html`: the approved HTML mockup (about 158 KB single file; grep, never read whole). Tabs: Plans (Edit/Preview), Dashboard (Money, Members, Risk), Members, Bookings (period filter, bulk confirm), Promos, Ledger, Reports; member drawer; "View as member" portal with themes and an embed modal; settings; light/dark.
- `smoke.mjs`: headless happy-dom test of the mockup (29 checks). Run with happy-dom installed in a temp dir (`/tmp/ledger-smoke`).
- `buzz-school-briefs.md`: the four buzz-school briefs (routes the UI will call). Their PRs: buzz-school #1330 (A reads), #1331 (D booking admin), #1332 (B token/JWKS/Cedar), #1333 (C money writes). Read them for the real route shapes.
- `/tmp/dashboard-lockdown-spec-v3.md`: the dashboard privacy spec (cell types, open-month lock, suppression, quarterly grain). Mockup states to add on top of the mockup: viewer chip (owner, finance admin, admin without grant, PIN locked, demo), hatched open month, suppressed cells, quarterly grain.
- atm read slice (in flight, a PR on atm `dev`): store-based reader, member summary, views. Until it merges, the UI talks to a `Reader` interface with a fixture adapter.

Hard constraints: Cloudflare Worker deployable (no node:fs, no ajv, no `new Function`); the UI never derives a number the server should derive and never renders `null` as 0; no names or ids beyond what a route returns; Biome clean; strict TypeScript; no zod; full words not abbreviations; no `console.log`.

## 1. Phase 0: agree on this workflow (hill climb on the protocol itself)

1. Create a branch `claude/ledger-ui-loop` from `dev` and write `plans/ledger-ui/loop/protocol-v1.md` = this file's sections 2 to 7 made precise (exact commands, exact JSON schemas for reviewer output, the screenshot recipe, state file format, where the UI package lives and its stack). Pick the simplest stack that satisfies the constraints (suggest `packages/ledger-ui`, Vite, TypeScript, a tiny component layer, `Reader` and `Writer` interfaces with fixture adapters). Justify it in 10 lines.
2. Ask THREE read-only reviewers to score the protocol 1 to 10 and list blockers: Claude Opus 5.5 (`claude-opus-5-5`, effort high), Claude Fable 5.1 (`claude-fable-5-1`, effort high), Grok 4.7 (provider `grok`, model `grok-4.7`, reasoningEffort high). Use `delegate_task` with `role:"review"`, `target` set to each model, started in parallel, each blind to the others. They score: testability, convergence (will the loop terminate), anti-gaming, simplicity, cost. Overall = lowest of the five.
3. Revise and repeat until all three give 9 or more, at most 3 rounds. If still short after 3, summarize the disagreement to the owner and stop. Save every version and every score in `plans/ledger-ui/loop/`.

## 2. The slice stack

Each slice is one PR whose base is the previous slice's branch (the first targets `dev`). Order, each working end to end on fixtures:

- S0 scaffold: package, theme tokens (light and dark), shell (school switcher, tabs, period controls), Reader and Writer interfaces, fixture adapters, test harness, screenshot script, CI-free gates.
- S1 Dashboard: Money, Members, Risk on the v3 KPI document shape, all viewer states and quarterly grain, from fixture docs (the four fixture presets plus synthetic state docs).
- S2 Bookings: period filter (default this week), day groups, overdue, bulk confirm, row actions through the Writer fake, pending state.
- S3 Plans: Edit and Preview, draft and publish review, live versus draft.
- S4 Members: list with attention sort, three-segment balance bar, member drawer, actions with pending effect.
- S5 Ledger and Reports.
- S6 Member portal ("View as member"), themes, embed modal.
- S7 Settings.
- S8 Real adapters: R2 reader (atm read slice) and the buzz-school admin routes (A to D), behind the same interfaces.

## 3. The loop for each slice

1. Build: delegate to a builder agent (Claude Sonnet 5.5 high, or Opus for S0 and S1) with the slice's mockup sections, the interfaces and the previous slice's code. The builder writes code, tests and the screenshot script entries.
2. Deterministic gates (you run them, not the builder): `bun test` for the package, typecheck, Biome on touched files, bundle size budget (set in S0, fail on growth beyond 10 percent per slice), hygiene test (no ajv, no node:fs, no `new Function`, no `console.*`), state-matrix tests (for each viewer state and each view, key texts and numbers from the mockup and fixtures exist, `null` is never rendered as 0). Any failure goes back to the builder without calling reviewers.
3. Evidence pack (you produce it): screenshots of the slice's views at 1100, 728 and 390 px wide in light and dark, side by side with the same screens from `mockup.html`; the DOM text dump of each state; the diff; the test output.
4. Review panel: the same three models, blind to each other, read-only. Each gets the evidence pack and the rubric and returns JSON: `{scores:{fidelity, aesthetics, simplicity, correctness, accessibility}, overall /* integer, the lowest axis */, blockers:[], mustFix:[{where, what, why}], wouldChange:[3 items even at 9 or more]}`. Anchors: 10 indistinguishable from the mockup and simpler than expected; 9 ship it, nitpicks only; 8 one real issue; 7 several; 6 or less redesign. "Simplicity" covers both UX (fewest concepts on screen) and code (no dead code, no premature abstraction, every abstraction used at least twice). Score the work, not the effort. Reviewers must run nothing that writes.
5. Pass rule: all three overall are 9 or more AND no blockers AND gates green. Then mark the PR ready and write the score table into the PR description.
6. Otherwise hill climb: dedupe the mustFix lists into one ordered list, send it to the builder, rebuild. Keep the best commit: if the mean overall drops against the previous round, revert that round's commit. Disagreement of more than 2 points between reviewers triggers one round where each sees the others' written objections (not scores) and re-scores.
7. Close rule (do not be afraid to close): after 4 rounds without a pass, or if two reviewers call the same design-level blocker, CLOSE the PR with a postmortem comment, delete the branch, and restart the slice from a fresh branch with a changed approach (at most 2 restarts per slice). Failing tests, wrong design, poor aesthetics and needless complexity all count. If a slice still fails after 2 restarts, stop and ask the owner.

## 4. Anti-gaming

Builders cannot edit the rubric, the mockup, the fixtures' expected values, the gate thresholds or other slices' tests (a gate checks the diff paths). Reviewers receive evidence you generated, not builder-written summaries. Every reviewer must name three things they would change. A 9 or more without evidence lines is rejected and re-asked.

## 5. State and resume

Keep `plans/ledger-ui/loop/state.json` (slice, round, PR numbers, per-reviewer scores, commits, budget used) updated after every step so any thread can resume. Post a short summary in your own thread after each slice passes.

## 6. Budget

At most 6 review panels (18 reviewer runs) per slice and 150 reviewer runs overall. Reviewers run with effort high. Builders Sonnet 5.5 high unless noted. If the budget is hit, stop and report scores so far.

## 7. Definition of done

S0 to S7 each passed by all three reviewers at 9 or more on fixtures, stacked as PRs, with a runnable `bun dev` that shows the whole mockup behaviour on fixture data; S8 either passed or blocked with a written reason (buzz-school PR not merged, atm slice not merged). Final summary to the owner: PR list in stack order, score table, closed PRs and why, what remains.
