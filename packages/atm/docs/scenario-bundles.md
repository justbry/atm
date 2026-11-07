# Scenario bundles and hash checkpoints

A bundle is one end-to-end case as plain data, in `fixtures/scenarios/<id>/`. Any consumer can load it, replay it through its own handler and compare what it wrote, stage by stage, with the committed hashes. buzz-school's family service can run them as a contract test against the release of the Trifold engine it pins.

## The files

| File | Holds |
|---|---|
| `scenario.json` | `id`, `school`, the school's `menu` (it passes buzz-school's Menu rules), the case's `title` and handler `path`, `env`, the caller's `fees` lookup by invoice id, `priceIds` of recorded deliveries, `personal` strings no file may hold, `schools` (several books), `order` (its place in the matrix doc). A generated profile names `profile`, `seed` and `params` instead of deliveries |
| `deliveries.jsonl` | one line per step, in delivery order. A delivery is a whole Stripe event with `atMs` (the delivery clock) and optionally `school` and `feeFails`. Duplicates and reorders are written out, nothing is shuffled at load time. Between them the family service acts: `erase`, `ship` (`late` puts the rows in `late-*` files beside a combined day), `combine` (a day's batches into `day.jsonl`), `lapse` (the cron books expired credits), `journal` (`tfd journal` for a month mid-story) |
| `stripe-side.json` | the reconcile oracle per school: invoices, refunds, disputes, payouts, balance transactions (and payment intents), written by hand from Stripe's documented shapes |
| `expected.json` | hand-written, never computed: the handler's answer to each delivery, each book's `hand` numbers (and `pinned` where today's behaviour differs, with `discrepancies`), the expected reconcile differences per month, `notes` on how the numbers were worked out |
| `hashes.json` | the golden H1 to H8 checkpoints. `stages/` (git-ignored, not in the package) holds the readable canonical text of each stage, only for the diff `tfd scenario check` prints; it is a pure function of the other files, so `tfd scenario check --snapshots` rebuilds it |

## The checkpoints (`src/ledger/checkpoints.ts`)

| Stage | Canonicalizer | What it covers |
|---|---|---|
| H1 | `canonicalDeliveries` | the deliveries as written |
| H2 | `canonicalMutations` | the handler's answers, its stored decision for each input in applied order, and every engine row it wrote, in order (taken from the handler database; no change to the handler) |
| H3 | `canonicalOutbox` | the decision events waiting to ship, in id order |
| H4 | `canonicalLedgerTree` | the shipped event files: sorted paths, lines in id order |
| H5 | `canonicalJournal` | the rest of the school's folder: journals, accounts, build record |
| H6 | `canonicalReports` | per channel (`atm`, hledger, DuckDB): the base aggregates the channel computed |
| H7 | `canonicalKpis` | per channel: the evaluated KPI rows; the same text `kpiHash` hashes |
| H8 | `canonicalReconcile` | what `tfd reconcile` found for each month |

Canonical form: object keys sorted, whole numbers only (a fraction is refused, except a ratio KPI's value), instants as ISO 8601 UTC, volatile fields (`shippedAt`, `received_at`, claim and run ids) left out. Each hash is the sha256 of that text.

**These hashes are internal to tests, CI and the export job.** Never put one in anything a viewer can read: hidden cells have small value sets, so a hash of unsuppressed KPI data can be brute-forced.

## `tfd scenario check <dir|id> [--update]`

Replays the bundle in a temporary folder (handler, outbox, ship, journal, the three KPI channels, reconcile), prints a table of stage, expected, actual and status, and on the first mismatch a diff of that stage only. Exit 0 when all match, 1 otherwise, 2 for a bundle it cannot find. With no argument it checks every committed bundle. `--update` rewrites `hashes.json` (and `stages/`); it refuses while the KPI channels disagree or the handler's answers differ from `expected.json`. `--snapshots` writes `stages/` from a run that matches the goldens (refused otherwise), so a later mismatch has text to diff against; without it a mismatch prints the table and says how to get one. A channel whose binary is missing is skipped, not failed.

## Consumers

`loadScenarioBundles(directory?)` and `loadScenarioBundle(directory)` return the bundles; `canonicalDeliveries`, `canonicalMutations`, `canonicalOutbox`, `canonicalLedgerTree`, `canonicalJournal`, `canonicalReports`, `canonicalKpis` and `canonicalReconcile` are the stage functions. Replay `bundle.steps` through your handler, build each stage's input from what it wrote, and compare `.hash` with `bundle.hashes`. H2 reads the handler's own tables, so a consumer with a different store will compare H1, H3 to H8 and the answers.

## Authoring a bundle

Write a `Case` in `tests/gap/<name>.ts` with the helpers in `tests/e2e-events.ts` and `tests/e2e-matrix.ts`, every number by hand, then `bun tests/author-gap-bundles.ts <id>` writes the four data files and `bun src/bin.ts scenario check <id> --update` freezes the hashes. `tests/scenario-bundles.test.ts` asserts the hand numbers against hledger's reports for every bundle outside the matrix.

## Tests

- `e2e-reconcile.test.ts`: the matrix (bundles with an `order`), goldens included, byte-identical to before the conversion.
- `scenario-bundles.test.ts`: every bundle's checkpoints equal its hashes; hand numbers for those outside the matrix.
- `scenario-order.test.ts`: any shuffle of the deliveries (with 409 and 422 answers redelivered as Stripe does) leaves H4 to H8 unchanged, except the cases pinned as order-sensitive (D7 and relatives in `e2e-reconciliation.md`).
- `checkpoints.test.ts`: canonical form, volatile fields, `tfd scenario check`.
