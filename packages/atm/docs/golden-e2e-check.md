# The golden end-to-end check

The golden fixtures put through the whole ledger pipeline with the real `atm` command line, every command a separate process, on a file-backed WAL SQLite database and a folder. Run on 2026-11-05 on an Apple M5 Pro, Bun 1.4.4, hledger 1.52.1, from the tree that holds this document. The check is repeatable: `tests/golden-e2e-check.test.ts` (S1 to S6) and `scripts/golden-e2e-scale.ts` (S7). Related: `docs/e2e-reconciliation.md` (the matrix this check re-runs through the command line), `docs/simulate-from-inputs.md` (sections 3 and 4 are what S3, S4 and S1's simulate check against), `docs/log-and-r2.md` (the shipper), `docs/README.md`.

## What the golden fixtures stand in for, and what that does and does not prove

No real school database was available and no credential was used: nothing here reads `~/.config`, calls Stripe or touches R2. The fixtures stand in for real data:

- the 46 scenario bundles (`fixtures/scenarios/`: 39 of the matrix and 7 more) are Stripe events written by hand from Stripe's documented shapes, or recorded in a Stripe sandbox (`recorded-*`, and the 8 `fixtures/billing/stripe/recorded/delivered` scenarios used by S1's what-ifs and S7), with a Stripe side written by hand;
- `fixtures/vibes-year` and `fixtures/vibes-multi` are generated event logs (one school and a year; twelve families across a year boundary), not Stripe events.

It proves that, for these inputs, the command line in this tree ships, journals, reports, reconciles and simulates as the committed goldens and the design say; that the commands do not write what they should not; that the shippers survive SIGKILL at every operation they make; that an erasure leaves no personal string and no fact in the shipped folder or the tables; and how the shippers scale on one machine. It does **not** prove anything about real data. See the last section.

## What was run

All commands are `bun ./src/bin.ts ...` (the source entry), with `dist/atm.js` (the built bundle) for one bundle, in a fresh temporary directory per scenario that holds `db/<school>.sqlite` (WAL), `log/` (the `--root` folder) and `stripe/<school>/` (the hand-built Stripe side). The reference handler (`handleStripeWebhook`, through `tests/handler-harness.ts` and `runBundle`) writes the database file; after that only commands touch it, except for S3's one `eraseStoredInputs` call (there is no command for it) and the checks that read an answer back to compare it.

```
bun test --timeout 60000 tests/golden-e2e-check.test.ts                 # a sample, about two minutes
ATM_GOLDEN_E2E=full bun test --timeout 1200000 tests/golden-e2e-check.test.ts   # all 46 bundles, all kill points
ATM_GOLDEN_E2E=full ATM_GOLDEN_E2E_SHARD=1/6 ...                         # a sixth of the run (six processes at once); CI splits the sample in two
ATM_GOLDEN_E2E_TZ=Asia/Tokyo ...                                          # every process, the handler included, in that zone
bun scripts/golden-e2e-scale.ts --copies 20,100,300 [--ship-index]        # S7
```

The test is skipped with a message when hledger is missing. The full run reported here was six shards at once, once with the machine's zone (America/Denver) and once with `ATM_GOLDEN_E2E_TZ=Asia/Tokyo`.

Per bundle and school (S1) the commands, in the cron order the design asks for:

```
atm inputs ship --db D --school S --env E --root R --json     # twice: the second ships nothing and changes no object
atm ship        --db D --school S --root R --json             # twice
atm journal     --root R --school S --month M                 # every month but the last, each twice
atm report      --root R --school S --month LAST --report income-statement|balance-sheet|credits --format csv   # each twice
atm reconcile   --root R --school S --stripe T --month M      # every month of the hand numbers
atm simulate    --root R --school S --inputs D|R --env E --json [--policy P | --menu M]   # D = the database, R = the shipped folder
```

The candidates: `upgradeGrant` prorated, full and none; every tier's prices 10% up; a rollover capped at 1 (where the menu has a rollover). hledger is run directly (`-M`, the refunds and disputes registers) where the goldens are not `atm report` output.

## Results

| Scenario | What | Result |
|---|---|---|
| S1 | 46 bundles through ship, inputs ship, journal, report, reconcile, simulate; goldens of the matrix; balances | 44 PASS, 2 FINDING (F1), under both time zones |
| S1 | 8 golden what-ifs (`golden/simulate/inputs-*.json`) through `atm simulate --inputs` | PASS (46 checks) |
| S2 | `vibes-year` and `vibes-multi`: ship, journal, report, reconcile against `golden/{journal,reports,multi}` | PASS (69 and 40 checks) |
| S3 | erasure drill, three families, one erased | PASS on the fixtures; FINDING F2 (erased facts stay in the `-wal` until a checkpoint) |
| S4 | SIGKILL of `atm inputs ship`, `atm ship` and the erasure settle, then a rerun | PASS: 72 trials (62 kills landed), 72 reruns identical to an uninterrupted run |
| S5 | database and folder hashed around every read-only command | PASS (inside S1 to S4); one exception explained (the WAL index, below) |
| S6 | America/Denver and Asia/Tokyo, S1 and S2 | PASS, byte-identical to the goldens under both; shipped folder identical across zones |
| S7 | scale probe to 44,000 inputs | FINDING F3 (`atm ship` is super-quadratic), F4 (memory), numbers below |

3,418 checks in the Denver run and 3,146 in the Tokyo run (the Tokyo run leaves out the zone and dist tests), 0 unexpected findings. A finding is pinned in the test (`KNOWN_FINDINGS`), so the test fails when one appears or goes away.

### S1: the bundles

Every bundle is delivered to the reference handler into one WAL database file per school, the outbox is left unshipped, and the commands above run. Per bundle the run checks, among others: each command's exit code; `ship` and `inputs ship` rerun add and change no object; the shipped log holds the outbox's lines once each; `events.csv`, `income-statement.csv`, `balance-sheet.csv`, `credits.csv`, the refunds and disputes registers, the monthly statements and `reconcile.txt` equal `tests/golden/e2e/<case>/` byte for byte (the 39 matrix cases; the other 7 have no goldens); `hledger check balanced accounts commodities`; the credit balances of a replay of the shipped log equal those of the engine rows in the handler's database (`balancesOf` over `atm_rows`); `atm simulate --inputs` with no candidate exits 0 with `baseline.identical`, no difference and no balance or posting change, and with `upgradeGrant: prorated` (the default) prints exactly the same; the database and the folder print the same JSON for the identity and for every candidate; no personal string of the bundle is in any file, the database or its `-wal`.

| Bundle | Checks | Denver | Tokyo |
|---|---|---|---|
| addon-once | 64 | PASS | PASS |
| addon-recurring | 64 | PASS | PASS |
| bookings | 57 | PASS | PASS |
| codes | 64 | PASS | PASS |
| create | 64 | PASS | PASS |
| create-with-addon | 64 | PASS | PASS |
| credit-expiry | 76 | PASS | PASS |
| dispute-lost | 64 | PASS | PASS |
| dispute-opened | 64 | PASS | PASS |
| dispute-redelivered | 64 | PASS | PASS |
| dispute-won | 64 | PASS | PASS |
| duplicate-delivery | 64 | PASS | PASS |
| erasure | 65 | PASS | PASS |
| failed-delivery-retry | 64 | PASS | PASS |
| fee-unknown | 64 | PASS | PASS |
| foreign-invoice | 7 | PASS | PASS |
| late-events | 57 | PASS | PASS |
| link-before-invoice | 64 | PASS | PASS |
| month-boundary | 73 | PASS | PASS |
| non-usd | 64 | PASS | PASS |
| out-of-order | 64 | PASS | PASS |
| payout-across-months | 73 | PASS | PASS |
| payout-failed | 64 | PASS | PASS |
| payout-several-payments | 64 | PASS | PASS |
| payout-with-fees | 64 | PASS | PASS |
| quantity-decrease | 73 | PASS | PASS |
| quantity-raise | 64 | PASS | PASS |
| recorded-dispute-lost | 64 | PASS | PASS |
| recorded-dispute-won | 64 | PASS | PASS |
| recorded-full-refund | 64 | PASS | PASS |
| recorded-partial-refund | 64 | PASS | PASS |
| refund-before-link | 64 | PASS | PASS |
| refund-full | 64 | PASS | PASS |
| refund-no-previous | 64 | PASS | PASS |
| refund-partial | 64 | PASS | PASS |
| refund-partials-to-full | 64 | PASS | PASS |
| refund-two-partials | 64 | PASS | PASS |
| refused-invoice | 64 | FINDING F1 | FINDING F1 |
| renewal | 73 | PASS | PASS |
| renewal-before-create | 64 | FINDING F1 | FINDING F1 |
| second-school | 128 | PASS | PASS |
| subscription-canceled | 64 | PASS | PASS |
| upgrade | 64 | PASS | PASS |
| yearly | 64 | PASS | PASS |
| yearly-quantity-raise | 71 | PASS | PASS |
| zero-invoice | 64 | PASS | PASS |

`foreign-invoice` has 7 checks because its only delivery is another school's: the school has no events, so nothing is journaled; the run checks that both shippers say so and exit 0. The 8 what-ifs of `simulate-inputs-whatif.test.ts` (`upgradeGrant` prorated, full and none on a plan switch; a price and allowance change and a rollover cap on a renewal; `full`, `none` and a dearer menu on the recorded `yearly-raise`) are rebuilt in file databases, shipped, and asked of the command from the database and from the folder: both print the same, every field the command's JSON keeps equals the committed golden (`balances` and the unchanged deliveries are left out of the JSON by the command), and the exit code is 1 exactly when the golden has differences.

### S2: the golden year and the multi-school fixture

The fixtures are logs: their events are put in `ledger_outbox` of a WAL database, and `atm ship`, `atm journal`, `atm report` and `atm reconcile` run on that.

- The shipped log reads back as the fixture's events, line for line (`canonicalize`), 81 events for the year. `atm journal --month 2026-03` writes `ledger/b4u/2026-03.journal`, `ledger/accounts.journal` and `main.journal` byte for byte equal to `tests/golden/journal`. `ledger/build.json` is equal in months, transaction counts and event lines per month, not in file names or hashes: the shipper writes one `batch-*` file a day, the fixture several files a day, and the build record names them.
- After every month is journaled: `golden/reports/{income-statement-monthly,balance-sheet,credits,refunds-register}.csv` and `golden/multi/{income-statement-monthly,balance-sheet,credits,credit-register-alerted-family,disputes-register}.csv` equal what `atm report` and hledger print, byte for byte.
- `atm reconcile` against a Stripe side built from the fixture's own records (the year: `tests/stripe-side.ts`; the multi fixture: `expected.json`): no difference for every month, and for the multi fixture the whole range `2026-11-01` to `2027-03-31`; the multi fixture's late batch and its second delivery of `po_1` are read as the golden says.
- These fixtures hold no stored inputs: `atm inputs ship` exits 0 and ships nothing, and `atm simulate --inputs` exits 2 with the sentence that the database holds no stored inputs.

### S3: the erasure drill

Three families are made from the golden `erasure` bundle (each copy with its own family id, Stripe customer, ids, e-mail, name and address, on three different days), delivered, shipped (`inputs ship`, `ship`). Family 1 (`family:fam_8k2_c1`) is erased with `eraseStoredInputs` in a transaction, `atm inputs ship` settles the queue (exit 0, one object rewritten and one deleted), and then every file of the world and every table of the database is searched for the family's strings and ids, computed from the raw fixtures (five personal strings: e-mail, name, street, city, postal code; and the family id, the Stripe customer id, the holder key).

| What | Before the erasure | After erase and settle |
|---|---|---|
| the five personal strings | nowhere (never stored) | nowhere |
| `fam_8k2_c1` | `-wal` x188, `events/` x14, `inputs/` x4, tables `atm_subjects`, `atm_rows` (4), `atm_invoice_index`, `ledger_outbox` (3), `atm_event_inputs` (3) | `-wal` x188, `events/` x14, `atm_subjects`, `atm_rows` (4), `atm_invoice_index`, `ledger_outbox` (3) |
| `cus_SYNTH_0001_c1` | `-wal` x16, `events/` x1, `inputs/` x1, `ledger_outbox` (1), `atm_event_inputs` (1) | `-wal` x16, `events/` x1, `ledger_outbox` (1) |
| `family:fam_8k2_c1` | like the family id, `inputs/` x3 | like the family id, `inputs/` none |

- **The personal strings never reach the database or the folder**: the control before the erasure finds none either. The handler stores a replay fact, not the raw event, so there is nothing of them to erase. (That is a property of these synthetic events. Real events carry more; see the last section.)
- **The ids are gone from the stored inputs and the shipped inputs**: no file under `inputs/` and no row of `atm_event_inputs`, `atm_input_seeds` or `atm_input_contexts` holds the family id, the customer id or the holder key any more; the old batch objects are deleted, and the replacement holds tombstone lines. The control before the erasure finds them in all of these, so the search can see them.
- **What the erasure hook does not touch, as its documentation says**: the family id stays in the log (`events/`, `ledger_outbox`: `family:<id>` is the key of every event, and the money stays), and in the engine's own rows (`atm_rows`, `atm_subjects`, `atm_invoice_index`), which the family service erases. A deployment that erases a family has to do that part too; nothing in atm does it.
- **F2, in the SQLite `-wal`**: right after the erasure the six signatures of the erased rows (3 fact bodies and 3 `raw_sha256` values, read before the erasure) are all still in the `-wal` file (6 of 6), in the earlier frames of the pages the `UPDATE` rewrote. After `PRAGMA wal_checkpoint(TRUNCATE)` none of them is in any file; `VACUUM` was not needed. In this run the main database file never held them, because the `-wal` had not been checkpointed since the facts were written; when a checkpoint ran between the shipping and the erasure, the old page is in the main file instead (`secure_delete` is `2`, fast, in this Bun/SQLite) until a checkpoint copies the erase's frame over it, and a PASSIVE checkpoint does that but leaves the old frames in the `-wal` file. Either way the residue lasts until a checkpoint. See F2.
- `atm simulate --inputs` afterwards (database and folder print the same): the erased holder is `not_replayable` with the reason `erased` (3 decisions carried over), 3 holders replayed, the baseline is identical for them, no difference. Before the erasure all 4 holders replayed (the three families and a fourth holder the payout events create).

### S4: SIGKILL and rerun

`scripts/golden-e2e-kill.ts` is the real command line with the folder store counting its `putIfAbsent` and `delete` calls and killing the process with SIGKILL at the n-th, before it starts or after it has finished and before the shipper marks its rows; the test also kills the real `src/bin.ts` by timer. After each kill the folder holds no object under a name the uninterrupted run does not make and no object with other bytes; then the command runs again to the end, and the folder must equal an uninterrupted run (same object names and bytes, hashed) with every row marked shipped.

| Drill | Kills | Landed | Rerun equals the uninterrupted run | Objects |
|---|---|---|---|---|
| `atm inputs ship`, 8 families on 8 days (before and after each of the first 10 puts, and 8 timers 25 to 260 ms) | 28 | 28 | 28 | 11 |
| `atm ship`, `vibes-multi` (before and after 11 sampled puts of the 78, the last two included, and 8 timers) | 30 | 30 | 30 | 78 |
| erasure settle, put (before and after the rewrite's put) | 8 | 2 | 8 | 6 |
| erasure settle, delete (before and after the delete of the old batch) | 6 | 2 | 6 | 6 |

"Landed" is a kill that happened (a kill point past the last operation is a normal run). No duplicate and no missing object, no leftover `.atm-tmp-*` or `.lock` file, no unshipped row, same bytes. The erasure settle converges to the same bytes whichever of its two steps was cut.

### S5: nothing is written by a command that reads

Around every `reconcile` and every `simulate` (over a thousand runs in the full run), the whole world (the database file with its `-wal`, the folder, the Stripe side) is hashed before and after: nothing changes. `atm journal` and `atm report` change only `ledger/*` and `main.journal` the first time, and nothing the second time. One thing was excluded on purpose: the `-shm` file (the WAL index) is shared memory a reader updates by design; its bytes change under any read-only connection (the first run of this check found `simulate` changing it), so the check keeps only whether it exists. The database file and the `-wal` are byte for byte unchanged.

### S6: time zones

The whole S1 and S2 run under the machine's zone (America/Denver) and, with every process and the handler in that zone, under Asia/Tokyo: every golden byte-identical, no finding other than F1. The S3 and S4 drills ran in the machine's zone only. A separate test also compares the hash of the shipped folder of `create` and `vibes-multi` across the machine's zone, America/Denver and Asia/Tokyo: equal.

## Findings

**No privacy leak of a personal string and no baseline non-identity (identity replay with no candidate, database source) was found on these fixtures.** F1 is a divergence between the two sources of the same what-if; F2 is a privacy residue of the erasure in a file that backups carry.

| | Finding | Where | Why | Money / privacy impact |
|---|---|---|---|---|
| F1 | `atm simulate --inputs <folder>` does not print what `--inputs <database>` prints when the history holds a refused input (2 of 46 bundles: `refused-invoice`, `renewal-before-create`) | `src/handler/inputs.ts:526` (`readUnshippedInputs` selects `outcome = 'applied'` only), so the shipper never ships a refusal; the reader at `src/cli.ts:716` then says `no inputs under ...: run atm inputs ship` (exit 2) when the refusal was the only input, or reports the refused invoice's decision as `not_replayable` with `inputs_not_stored` (and the hint that it may be "not shipped yet") when others exist | A refusal (a 422 the handler stored, such as an invoice for a tier the menu did not sell) is not shipped by design (`docs/simulate-from-inputs.md`, OWNER DECISIONS). Its effect: a folder cannot answer `newly_applied` (a candidate menu that would accept the refused invoice), and the message blames a missing run of `atm inputs ship` that will never fix it | No money moves (read-only what-if). The folder answer is the less complete one, with a wrong hint |
| F2 | The facts of an erased holder remain in the SQLite `-wal` after `eraseStoredInputs` and `atm inputs ship` | `src/handler/inputs.ts:599` (the `UPDATE ... SET body = NULL, ...` rewrites the page; WAL keeps the earlier frames until a checkpoint) | A `UPDATE` in WAL mode appends a frame; the old frame holds the old row until the next checkpoint truncates it. Seen: 6 of 6 signatures in the `-wal` immediately after; none after `wal_checkpoint(TRUNCATE)`; the main file never held them | Privacy: the erased fact bodies (ids, amounts, times, price ids; no name, e-mail or address, which are never stored) are in the `-wal`, and so in any Litestream segment or copy of it, until a checkpoint. The design already accepts "the SQLite file's own backups keep the facts until they expire"; this adds that the live file does too until a checkpoint, and a deployment that checkpoints rarely (or never `TRUNCATE`s) keeps them |
| F3 | `atm ship` is super-quadratic in the school's outbox size | `src/ledger/ship.ts:173`: `UPDATE ledger_outbox ... WHERE school_id = ? AND id = ? AND body = ? AND shipped_at IS NULL`. The primary key is `(school_id, env, id)` and the statement has no `env`, so SQLite plans `SEARCH ... USING INDEX sqlite_autoindex_ledger_outbox_2 (school_id=?)` (checked with `EXPLAIN QUERY PLAN`): every updated row scans every row of the school, shipped or not (a bare SQLite loop of the same UPDATE over 2,000, 4,000 and 8,000 rows: 154, 595 and 2,390 ms, quadratic; with `AND env = ?` or the extra index: 1, 3 and 7 ms). The fix is both halves: the shipper's `SELECT` does not read `env` (it reads a school's rows whatever their env), so it has to read it and the `UPDATE` has to use it; the body test already keeps the other env's row of the same id out, so the result does not change | Measured: 3,900 events 7.4 s; 11,700 events 162 s (three times the rows, 22 times the time); 19,500 events did not finish in 150 s. With one extra index on `(school_id, id)` (an experiment, not the product): 11,700 events 1.1 s, 19,500 1.0 s, 39,000 1.8 s | No money. Operational: a first `atm ship` over a year of 1,000 families' backlog, or a rerun after the shipper was down for weeks, runs for tens of minutes to hours; the hourly steady state (a few hundred new rows against 40,000 old: the cost is the rows to ship times the rows of the school) costs seconds to tens of seconds |
| F4 | `atm simulate --inputs` peak memory is about 50 KB per stored input | `src/ledger/simulate-inputs.ts` (the replay holds the log, the inputs and the replayed rows in memory; not profiled) | Measured below: 1.2 GB at 22,000 inputs, 2.2 GB at 44,000, from the database or the folder (about 50 KB per input counting the process's own 190 MB; about 40 KB per input between the runs) | A year of 1,000 families (about 36,000 inputs) needs about 2 GB; a 1 GB container is killed. Not a correctness problem |

Not findings, recorded because they came up:

- `knip` already exited 1 on `origin/dev` before this work: `knip.json` had `packages/atm` twice, so the second key won and `tests/gap/*.ts` lost its entry (7 unused files). This branch merges the two keys (`knip.json`, a one-line config change) so the gate is green.
- `runBundle` (`src/scenario/bundle-run.ts`) had a hard-coded `:memory:` database; it now takes an optional `databaseFor(school)` in `RunBundleOptions` (default unchanged) so a caller can drive the real commands over what the handler wrote. This is the only change under `src/`.
- `atm reconcile` of a school whose env is `test` (the `recorded-*` bundles) is run without `--mode`, as the matrix runs it ("live mode" in the golden text):  Passing `--mode test` there gave exit 1 (differences) in the first attempt of this check; not investigated.
- The engine rows and the invoice index keep the erased family's id (see S3): that is the family service's erasure, outside the hook's documented scope.

## S7: the scale probe

`scripts/golden-e2e-scale.ts`: the 8 recorded sandbox scenarios (8 families, 44 Stripe events) repeated `--copies` times with new ids (a suffix on every Stripe id and family id) and the time moved 0 to 299 days from copy to copy, delivered to the reference handler into a WAL file (so the inputs fall on up to 300 UTC days), then the commands run under `/usr/bin/time -l` (wall seconds, peak resident memory). One machine (Apple M5 Pro, 48 GB), a warm cache, nothing else running except where a run says so. `ship*` is `atm ship` with the experiment index of F3.

| Copies | Stored inputs | Log events | Holders | Database | `inputs/` folder | `events/` folder | Journals |
|---|---|---|---|---|---|---|---|
| 20 | 880 | 780 | 160 | 3.9 MB | 0.9 MB | 1.3 MB | 0.2 MB |
| 100 | 4,400 | 3,900 | 800 | 19.0 MB | 4.7 MB | 6.6 MB | 1.1 MB |
| 300 | 13,200 | 11,700 | 2,400 | 57.3 MB | 14.2 MB | 19.7 MB | 3.4 MB |
| 500 | 22,000 | 19,500 | 4,000 | 96.3 MB | 23.7 MB | 32.9 MB | 5.6 MB |
| 1000 | 44,000 | 39,000 | 8,000 | 192.2 MB | 47.5 MB | 65.8 MB | 11.1 MB |

| Command | 20 | 100 | 300 | 500 | 1000 |
|---|---|---|---|---|---|
| handler delivers the events | 0.4 s | 1.7 s | 5.0 s | 9.3 s | 30.7 s |
| `atm inputs ship` | 0.35 s, 227 MB | 0.58 s, 269 MB | 5.8 s, 356 MB | 5.2 s, 469 MB | 13.3 s, 774 MB |
| `atm ship` (as shipped) | 0.42 s, 196 MB | 7.4 s, 236 MB | 162 s, 297 MB | stopped at 150 s | not run |
| `atm ship*` (with the index) | - | - | 1.1 s, 301 MB | 1.0 s, 341 MB | 1.8 s, 501 MB |
| `atm journal` (all months) | 0.9 s, 208 MB | 2.3 s, 238 MB | 4.7 s, 270 MB | 5.5 s, 332 MB | 6.3 s, 461 MB |
| `atm report --report credits` | 0.4 s, 194 MB | 0.6 s, 236 MB | 1.7 s, 282 MB | 3.7 s, 339 MB | 12.5 s, 458 MB |
| `atm simulate --inputs <db>` | 0.53 s, 348 MB | 1.3 s, 616 MB | 3.8 s, 943 MB | 6.7 s, 1,173 MB | 18.0 s, 2,169 MB |
| `atm simulate --inputs <folder>` | 0.53 s, 355 MB | 1.4 s, 435 MB | 4.0 s, 1,021 MB | 6.2 s, 1,165 MB | 14.1 s, 2,207 MB |
| `atm simulate --inputs <db> --policy` (upgradeGrant full) | 0.54 s, 355 MB | 1.3 s, 471 MB | 3.7 s, 915 MB | 7.4 s, 1,204 MB | 16.0 s, 1,915 MB |

The smallest runs sit at about 190 MB resident, so they measure the process, not the data. The `ship*` figures of the 300-copy column come from a second run of the same history (its `inputs ship` took 3.1 s against 5.8 s in the first run, so assume run-to-run noise of that size).

**Extrapolation to 1,000 families by 12 months, honestly.** The design assumes three events per family-month: 36,000 stored inputs and about 32,000 log events. That is the size of the 1000-copy run (44,000 and 39,000), so the figures are near measured ones, but the probe has 8,000 holders with about 5 inputs each where the target has 1,000 holders with 36 each, and nothing here shows whether a replay is linear in the history of one holder:

- storage: the database about 160 to 190 MB (4.4 KB per input, the engine rows and the outbox included); `inputs/` about 40 MB a year (the design predicted 43 MB); `events/` about 55 MB; journals about 10 MB;
- `atm inputs ship` and `atm journal` and the reports: seconds to tens of seconds, hundreds of MB; fine;
- `atm simulate --inputs`: about 15 to 18 s and about 1.8 to 2.2 GB (F4), from either source;
- `atm ship`: fine in the steady state; a first ship or a backlog of tens of thousands of rows is F3: hours as the code stands;
- the hourly cron of `inputs ship` then `ship` costs seconds when the backlog is a few hundred rows.

## What this does not prove

- **The inputs are synthetic or sandbox.** The bundles are written from Stripe's documented shapes, and the `recorded-*` ones come from a sandbox; the vibes fixtures are generated logs. Real events carry many more personal fields than the five these carry (a name and address on a customer, a card's last four and brand, a receipt e-mail, shipping, a description a parent typed, metadata a school added). The check shows that none of the five reaches the database or a folder, and the design says the handler stores a replay fact; it does not show that no field of a real event does.
- **No real school database.** The handler's tables here are written by the reference handler on a fresh file. A real database has years of rows written by earlier versions, the family service's own writes (`track`, `finalize`, a lapse), caller-row imports and migrations, and holders whose history started before the inputs were stored (the `non_input_writes` and `inputs_not_stored` cases). The carried-command interleave is exercised only by the few bundles that have a `lapse` or a booking.
- **R2 never ran.** Everything is `FolderStore`. `R2Store`, its conditional puts, listing order and eventual consistency, a delete that does not honour `If-Match` (`docs/log-and-r2.md`), versioning and replication of the `inputs/` prefix (the erasure design's precondition) are untested here. The kill points are those of a filesystem store: a put is atomic (a hard link) and a crash leaves at most a temp file; an object store fails differently (a timeout whose put landed, a delete that did not).
- **Real Stripe ordering and timing.** Deliveries are in the order each bundle wrote, with the retries the runner models (a 409 delivered again an hour later). Real Stripe reorders more, repeats, delays by days and sends events of a mode or an API version the fixtures do not have. The out-of-order and duplicate bundles cover the shapes the design knows.
- **One process at a time.** No two shippers, no handler running while the shipper runs (the handler's connection in the test process stays open, which only shows that a reader and the writer coexist), no concurrent erasure and shipping. Only SIGKILL of one shipper was tried, never a kill of the handler mid-transaction.
- **The oracle is the repository's own.** The goldens were written by this code and checked against hand numbers by the matrix; this run shows the command line reproduces them, not that they are right for a school. The Stripe side is hand-built from the same understanding of Stripe as the handler.
- **S7 is one machine and one shape.** Eight holders' worth of history repeated, not 1,000 real holders; a warm cache; no concurrent load; hledger 1.52.1. The big-O of F3 is the statement plan, not a measurement of a real backlog.
- **The time zone drill** changes `TZ`, not the runtime's time-zone database (design row 6); a different ICU could differ across a changed zone rule.
- **What the test cannot fail on.** The checks that compare with goldens fail when the output changes; the S3 search has a positive control; the S4 drills compare against an uninterrupted run made the same way. The drills were not run against a mutated product (a shipper that marks before it puts, a settle that deletes first); the design's own tests do that (`ship-inputs-review.test.ts`), this check does not repeat it.
