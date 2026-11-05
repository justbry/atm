# `track` path as a usage wallet spike: report

Date: 2026-11-05. Written by a sub-agent, saved here in full. The summary is in `docs/usage-metering.md` ("Usage events as a ledger source"); `ROADMAP.md` keeps the verdicts. Raw benchmark outputs are in `results/track/`, the scripts in `scripts/track/` (as `.txt` so lint and type checks skip them).

Branch `claude/atm-usage-track-spike`, head `9d815769c404235831fc710f073b3b0c074b81af`, pushed, no PR. Files, under `packages/atm/tests/spikes/`: `usage-track-harness.ts` (seeding, `spend`, `spendOptimistic`, `runWorkload`, `runContention`; it also acts as its own worker process via `import.meta.main`) and `usage-track.test.ts`.

## Verdict: partly

atm can be a correct, race-free credit wallet for LLM usage if the gateway batches. As a per-call wallet it has a hard ceiling and several gaps. The engine is cheap. The costs are the SQLite read-modify-write and the single revision per holder.

**Machine:** Apple M5 Pro, 15 cores, 48 GB, macOS (Darwin 25.3.0), Bun 1.4.4. The machine was shared and busy (load average 6 to 13), so timings are noisy. Runs are medians of 3, and where two sessions disagreed both are given. SQLite is a file in `/tmp` with WAL and `synchronous=NORMAL`, using the real `atm_rows` layout and revision check.

## 1. Spend path throughput (single thread, 30k tracks)

Each track is one transaction: read the holder's rows, decode, run the engine, diff the mutation against the rows, write under the revision check.

| Workload | tracks/s | p50 | p99 |
|---|---|---|---|
| Engine only (`runEngineCommand`, prebuilt subject) | about 125k to 145k | 6 to 8 us | 15 to 22 us |
| (a) 1 holder, 1 credit | 15.6k to 23.8k | 36 to 42 us | 65 to 277 us |
| (a) 1 holder, 1,000,000 credits | 23k | 37 us | 76 us |
| (b) 1,000 holders round-robin, 1 credit | 19k to 21k | 40 to 43 us | 70 to 140 us |
| (b) 1,000 holders round-robin, 1,000,000 credits | 20k to 21k | 41 to 42 us | 70 to 141 us |
| (c) 20,000 holders, Zipf (top 10 get 39% of tracks), 1 credit | 15k to 16k | 43 to 46 us | 123 to 163 us |
| (c) 20,000 holders, Zipf, 1,000,000 credits | 15k to 17k | 43 to 47 us | 73 to 123 us |

- **Quantity does not matter.** 1 credit and 1,000,000 credits cost the same.
- **Where the time goes** (about 42 to 65 us per track): read 2 to 7 us, decode 2 to 3, engine 8 to 12, diff (`rowChangesFromMutation`) 11 to 13, row write 2 to 6, BEGIN/COMMIT 16 to 28.
- **Pure engine is about 8 us.** The diff costs more than the engine, because it re-runs `applyMutation` and a JSON compare.
- **Disk settings:**

  | Setting | tracks/s | p50 |
  |---|---|---|
  | `:memory:` | 35k | 27 us |
  | WAL, `synchronous=FULL` | 11.5k to 12.6k | 74 to 79 us |

  `FULL` costs about 50 us of commit per track. Even so, macOS's fsync is lighter than Linux's.
- **Rows per track** (lean holder, 3 rows: customer, product, one balance row): 3 read, 1 upserted, 0 deleted, plus one `atm_subjects` revision update. A holder with a rollover and a pack row has 5 rows: 5 read, 1 upserted. It runs 17k to 19k/s on one holder and 10k to 15k/s across 1,000 holders.
- **Draw order:** rollover is drained first, then the tier row, as the README says.
- **`subjectFromRows` as exported** rebuilds the catalog on every call, but this cost only about 5% here (20.6k vs 22.9k/s). A cached catalog is not essential.
- **Audited path (hold + settle, 2 commands per LLM call, with `recordEngineCommand` writing to `ledger_outbox` in the same transaction):** 3.6k to 4.2k calls/s, about 8k commands/s. p50 is 176 to 199 us and p99 2.6 to 3.3 ms. The outbox write adds about 35 to 40 us per command. Each event is about 2.6 KB.

## 2. Hot-holder contention (K processes, one SQLite file, 1.5 s runs)

Two write patterns:

- **Immediate:** the reference handler's pattern, with read, engine and write inside one `BEGIN IMMEDIATE`. There are no stale revisions. Waiting is SQLite's busy-handler polling.
- **Optimistic:** read outside any transaction, decide, then write under the revision check and retry on `StaleRevision`. This is what you need if the store is remote or the read and write are separated by I/O.

Medians of 3 runs; "runs" is the spread across the 3 runs:

| Pattern | Holders | K | commits/s | stale rate | retries/track | p99 | runs |
|---|---|---|---|---|---|---|---|
| immediate | same | 1 | 23.3k | 0 | 0 | 94 us | 23.3k to 23.5k |
| immediate | same | 2 | 10.7k | 0 | 0 | 0.5 ms | 8.0k to 10.9k |
| immediate | same | 4 | 5.2k | 0 | 0 | 6.4 ms | 4.5k to 7.3k |
| immediate | same | 8 | 4.3k | 0 | 0 | 10.6 ms | 3.2k to 4.4k |
| immediate | spread | 2 | 7.3k | 0 | 0 | 0.8 ms | 6.7k to 10.1k |
| immediate | spread | 4 | 3.8k | 0 | 0 | 5.4 ms | 3.6k to 4.9k |
| immediate | spread | 8 | 2.5k | 0 | 0 | 17.6 ms | 2.1k to 2.8k |
| optimistic | same | 1 | 9.2k (second run: 18.7k) | 0 | 0 | 0.76 ms | 4.2k to 12.3k |
| optimistic | same | 2 | 5.2k (7.4k) | 33 to 35% | 0.5 | 2.0 to 2.7 ms | 4.2k to 6.8k |
| optimistic | same | 4 | 4.0k (4.2k) | 67 to 68% | 2.0 to 2.2 | 5 to 6.6 ms | 3.7k to 4.5k |
| optimistic | same | 8 | 2.4k (2.9k) | 78 to 80% | 3.6 to 3.9 | 19 to 28 ms | 2.3k to 3.2k |
| optimistic | spread | 2 | 5.3k (6.7k) | 0 | 0 | 2.2 ms | 4.0k to 9.2k |
| optimistic | spread | 4 | 7.6k (7.2k) | 0 | 0 | 1.6 to 3.3 ms | 5.1k to 11.9k |
| optimistic | spread | 8 | 6.2k | 0 | 0 | 5.4 ms | 4.9k to 7.0k |
| optimistic, 1 ms between read and write | same | 1 | 705 | 0 | 0 | 4 ms | 701 to 800 |
| optimistic, 1 ms between read and write | same | 2 | 743 | 50% | 1.0 | 27 ms | 619 to 791 |
| optimistic, 1 ms between read and write | same | 4 | 723 | 75% | 3.0 | 93 ms | 585 to 800 |
| optimistic, 1 ms between read and write | same | 8 | 573 | 87% | 6.9 | 186 ms | 551 to 621 |
| optimistic, 1 ms between read and write | spread | 8 | 2.9k | 0 | 0 | 9.2 ms | 2.8k to 3.7k |

**Notes:**

- Every run kept the invariants: the revision equals the commits, and the balance equals the total tracked. There were no lost updates.
- **More writers on one holder makes it slower, not faster.** Each holder is serialized by its revision.
- **Spreading over holders does not fix it for immediate mode.** SQLite allows one writer per database file, so 8 writers on 8 different holders in the same file still collapse to about 2.5k/s.
- **A remote or async store is the worst case.** If the read-to-write window is 1 ms, one holder tops out at about its own 1/RTT, about 700 commits/s, and the retry rate climbs steeply with K.

**Ceiling for one holder:** about 15k to 23k tracks/s from a single in-process writer (`immediate` or `optimistic` K=1, 18.7k to 23.3k). Across multiple processes on a shared file it drops to 4k to 10k/s. With a read-to-write window of about 1 ms it drops to a few hundred commits per second.

For an AI gateway, one customer making hundreds of calls per second is fine if all calls for that customer go through one writer (same process or shard). Many gateway workers racing on one customer is not fine. Either route each customer to a single writer, or batch.

## 3. Batching (one holder, file WAL, 137-credit calls)

Under heavy load (about 11) the run-to-run noise is large, so treat these as order of magnitude.

| M calls | M separate tracks | 1 summed track | Speedup |
|---|---|---|---|
| 1 | 0.35 ms | 0.16 ms | about 1x (the difference is noise) |
| 10 | 2.2 ms | 0.11 ms | about 20x |
| 100 | 13.6 ms | 0.077 ms | about 180x |
| 1000 | 111 ms | 0.052 ms | about 2,100x |

A summed track costs about one track (50 to 160 us) however many calls it covers. The speedup is therefore about M.

**Exact boundary behaviour** (balance 100, 13 calls x 10 = 130):

| Mode | Result |
|---|---|
| Per-call, `reject` | 10 applied, 3 rejected, balance 0. Exact boundary. |
| Batch 130, `reject` | Whole batch `rejected` (`insufficient_balance`), nothing deducted, no write, balance stays 100. |
| Batch 130, `cap` | `status: "applied"`, only 100 deducted, balance 0. The 30 excess is silently dropped. There is no `remaining` field. The caller must compute requested minus the sum of deltas. |
| Batch 130, `overflow` | All 130 applied, balance -30. |
| Row `usage_allowed: true`, any behaviour | Same as `overflow`. atm's own rows are always `usage_allowed: false`. |
| Customer-row `overage_allowed: [{feature_id:"credit", enabled:true}]` | Allows overage, no catalog change. |
| Same plus `spend_limits: [{... overage_limit: 20}]` | `reject` rejects the whole batch. `cap` applies 120 and ends at -20. |

The `check` command returns `{allowed, reason, limitType, requiredBalance, fundingFeatureId, isFlag}`. It does not return the balance, and it writes nothing. `check` 100 returns true. `check` 101 and 130 return false with `insufficient_balance`. On an overage-allowed row, `check` 130 returns true.

**What batching loses:**

- Per-call audit: one revision and one `commandId` per batch.
- Per-call idempotency: no `idempotency` handling in the engine ("Dedup is the writer's job").
- Partial failure: a rejected batch rejects every call in it.
- Boundary precision under `reject` or `cap`.

Usage that has already happened (post-hoc LLM tokens) cannot be un-served. Batches therefore need `overflow` or an overage-allowed row, with `check` or a reservation before the call.

**Recommended rule:**

- Flush per holder every about 250 ms or at 100 buffered calls or N credits (whichever comes first), as one `track` of the summed quantity.
- Do a `check` or a held `track` first when you must block before serving.
- Flush on shutdown and when `check` shows the balance below a threshold.
- Send the raw per-call usage event to R2 independent of atm: call id, timestamp, model, input/output tokens, computed credit cost, the batch's `commandId`, and the idempotency key.
- atm holds only balance and aggregate. R2 is the audit and billing source.

## 4. Overage and meters

**What `track` returns.** The mutation's `result` is `{type:"track", status: "applied"|"rejected", reason: "insufficient_balance"|null, deltas[], deductions[], fundingFeatureId, fundingCreditCost, ...}`.

- `deltas[].balanceDelta` and `valueDelta` are per row, with rollovers first. That is the only record of how a call split across rows.
- There is no `overage` field and no remaining balance. Overage is simply a negative row balance.
- The overage quantity right now is `-(sum of negative customerEntitlements balances)`. Rollovers never go negative.
- Per call, overage is `max(0, value - available before)`. That has to be derived from the `deltas` and the prior row state.

**Events are not usable for overage as they are.**

- `mutationToEvents` throws `"a spend books a hold first: track with a lock"` for a plain `track`. Only a held `track` (lock) produces `credit.held`. Settling is a `finalize`, which produces `credit.spent` or `credit.released`.
- `credit.held` units include overage and no field separates it. Only the full mutation is in the payload.
- `finalize` above its lock throws `"a finalize above its lock deducts more; not mapped to an event"`. An LLM call that costs more than its estimate cannot be settled and logged.
- A fractional hold throws in the ledger: `"credits are whole units"`.

**The 100-credit test** (five held `overflow` calls: 40, 40, 19, 1, 30). It is the first test in `usage-track.test.ts`.

- Final `ce_credit` is -30, so overage is 30, and the revision follows the calls.
- Events: five `credit.held` (40, 40, 19, 1, 30), one `credit.low` (20 to 1, threshold 2), one `credit.depleted` (`available` 0, `previous_available` 1).
- No event fires when the balance is already at or below 0, so the move from 0 to -30 gives no event.
- `lowCreditThreshold` is opt-in. The harness passes the policy's value (2).
- In a separate run with 40, 40, 30, 20: `credit.depleted` fires once, at the crossing (`available` -10, `previous_available` 20).

**Reset forgives overage, and the ledger cannot book it.**

- A `reset` at the cycle end sets the row back to the grant (-30 becomes 1,000,000). `persist_free_overage` is off in `commandOrg`; turning it on gives 999,970.
- The overage amount survives only in that mutation's `before` guard, and in the `reset` mutation payload.
- `mutationToEvents` throws `"a reset cannot add more than it refills (-30)"` in both cases.
- In `handleStripeEvent`, a throw inside `decideAndRun` becomes a refusal (`refuse("rejected", ...)`). The conclusion that a renewal invoice for a holder in overage is refused is inferred from this and the proven throw, not run end to end through the handler. Verify this before relying on overage rows.

**Missing for a "report overage to a Stripe meter" job:**

- A per-period overage reader (the negative balance now, plus a record of the amount at reset).
- A durable idempotent cursor (period start, last reported quantity or high-water mark, Stripe meter-event identifier).
- A reset path that records overage before it is forgiven, and that the ledger can book.
- An overage field on events and the `track` result.
- A usage idempotency key per call on the engine side.
- A way to settle above the lock.
- Mapping of credit units to meter units.

None of it was built.

## 5. Decimals and units

**Engine arithmetic is exact, but the stored balance is a JS double.**

- Deduction uses `decimal.js`. `0.1` ten times from 1 gives exactly 0. `0.1+0.2` from 0.3 gives 0. `1000 x 0.137` from 1000 gives exactly 863. A naive float sum of the same calls gives 137.00000000000043.
- Fractions: 0.5, 1e-6 and 1e-9 work when the balance is small.
- Fraction below the double's resolution at the balance's size: `1e-6` from `1e12` returns `status: "applied"` and the balance stays 1e12. The deduction is silently lost.
- Below `CREDIT_RATE_EPSILON` (1e-10): `1e-21` from 1 is `rejected` (balance unchanged).
- `1/3` three times from 1 leaves 1e-16.
- Large values: `1e12` works. Integers are exact to 2^53; 1e300 under `overflow` is accepted (balance becomes -1e+300).
- NaN and Infinity are rejected by the schema. Negative values refund. Zero is a no-op.
- Ledger postings reject non-integers outright.

**Recommendation: use whole units.**

- Track integers, e.g. 1 credit = 1,000 tokens (or smaller).
- Round up per call for the shown charge (prevents free tokens); for large call counts, round at the batch level.
- Keep exact token counts in the R2 usage events.
- Keep every balance and track under 2^53.

## Gate tails (from `packages/atm` unless noted)

- New spike test, `bun test tests/spikes`: `9 pass, 0 fail, 42 expect() calls, Ran 9 tests across 1 file. [1224.00ms]`
- Full `bun test`: `1232 pass, 50 skip, 0 fail, 13476 expect() calls, Ran 1282 tests across 52 files. [52.11s]`
- `bunx tsc --noEmit`: no output, clean.
- Biome on the two touched files: `Checked 2 files in 9ms. No fixes applied.`
- Repo-root `bunx knip`: exit 0. Only the existing "Configuration hints (11)" are printed, none from the new files.
- `bun.lock` is unchanged. `bun install --frozen-lockfile` was run once because the worktree had no `node_modules`.

## Not measured or limited

- **Real durability:** only macOS APFS was measured. Linux `fsync` costs and an NVMe server were not.
- **Remote or async stores:** a networked store (D1, Postgres, Durable Object) was not measured. The 1 ms "think" case only simulates the window.
- **Multi-thread engine:** the engine alone was timed single-threaded.
- **A genuinely quiet machine:** none was available, so absolute numbers vary by roughly 2x. The ratios and the pinned behaviours are reliable.
- **Reset through `handleStripeEvent` end to end:** not run. Only `mutationToEvents` throwing on the reset mutation is proven.
- **Long-run effects:** outbox growth, WAL checkpoints, vacuum, and the p99 spikes in the hold+settle path (2.6 to 3.3 ms, cause unconfirmed) were not studied.
- **Multi-feature or entity-scoped holders,** and **rate cards or credit-system pricing,** were not measured.
