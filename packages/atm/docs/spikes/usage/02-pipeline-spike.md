# R2 usage pipeline spike: report

Date: 2026-11-05. Written by a sub-agent, saved here in full. The summary is in `docs/usage-metering.md` ("Usage events as a ledger source"); `ROADMAP.md` keeps the verdicts. Raw benchmark outputs are in `results/pipeline/`, the scripts in `scripts/pipeline/` (as `.txt` so lint and type checks skip them).

Branch `claude/atm-usage-pipeline-spike`, head `e292cbe2be9246318c9bf936f0cd2eb4ef4f52b3`, pushed, no PR. Files, all under `packages/atm/tests/spikes/`: `usage-events.ts` (generator), `usage-sql.ts`, `usage-manifest.ts`, `usage-pipeline.test.ts`.

## Verdict

Yes for the raw store, aggregation, rating and re-rating. Partly for the existing outbox and shipper, which do not accept `usage.recorded` as it stands and do not scale to this volume.

DuckDB over zstd JSONL or Parquet on R2-style files handled 10M events in seconds. The first thing that breaks is the SQLite outbox and shipper, well before DuckDB.

## Machine and data

- **Machine:** Apple M5 Pro, 15 cores, 48 GB RAM, macOS (Darwin 25.3), DuckDB v1.5.6 (default 15 threads), Bun 1.4.4.
- **Event counts:** all event counts are distinct events. 1% duplicates and about 1% late events (1 to 40 days old) come on top.
- **Holders:** 20,000 holders, Zipf-skewed. The top 10 holders carry 39% of revenue and the top 200 carry 69%.
- Two thirds of the numbers come from a single run each, with roughly +-40% run-to-run variance (dedupe showed 1.5 to 2.5 s). The page cache was warm; true cold-disk reads were not measured.

## Bytes per stored line

| Format | Bytes per stored line |
|---|---|
| JSONL raw (the outbox body, keys sorted) | 456 |
| JSONL gzip -6 / zstd -3, per file | 63 to 69 / 64 to 70 |
| Parquet, full envelope (payload as JSON) | 45 |
| Parquet, envelope plus promoted typed columns | 47 |
| Parquet, flat (typed columns only) | 28.7 |

- **Storage cost:** R2 at $0.015 per GB-month is an assumption to verify.
  - 10M events as raw JSONL: 4.6 GB, about $0.069 per month.
  - 10M events as Parquet: 0.45 GB, about $0.007 per month.
  - 300M events per month (10M per day): 13.5 GB per month of Parquet, about $0.20 per month for each month retained. A full year is about 162 GB, about $2.43 per month.
  - Request pricing and egress were not measured.
- **What takes the space:** `idem` is 14.5 B and `id` is 13 B per event in Parquet. Both are random, and `id` is derivable from the school, `idem` and event time. Sorting by holder made the file larger (48.5 vs 45 B). Time order is better.

## Timings

All times are seconds on this machine. "Cold" is the first query in a fresh process with a warm OS page cache.

| Query | 1M events | 10M events |
|---|---|---|
| Per holder, month and model sum, JSONL (explicit schema) | 0.23 cold / 0.07 warm, 368 MB | 0.61 / 0.61, 891 MB |
| Same, `read_json_auto` | 0.07 / 0.07 | 0.61 cold / 0.89 warm |
| Same, Parquet envelope (payload JSON) | 0.07 | 0.57 / 0.61, 581 MB |
| Same, Parquet typed or flat | 0.01 | 0.07 to 0.09 |
| Single heavy-holder month, JSONL / Parquet by day | 0.07 / 0.02 | 0.55 / 0.12 |
| Whole-school month rollup, JSONL | 0.06 | 0.55 |
| Same per-holder sum with dedupe, JSONL | 0.15 to 0.18 | 1.6 to 1.7, 3.2 GB |
| Dedupe alone (`QUALIFY row_number`), net of reading | +0 | +1.3 s (about 2.5 s total vs 1.3 s plain load); other runs 1.5 to 1.8 s |
| Dedupe via `arg_min` group by | 0.22 | 1.5 |
| Dedupe via `DISTINCT ON` | 0.34 | 6.0, 8.5 GB (worst) |
| Dedupe per event-date partition, summed over 71 days | 1.3 | 4.2 (largest day 0.24) |
| Rollup from raw (dedupe plus group) | 0.20 | 2.0, 3.2 GB (2.8 s on 4 threads, 8.7 s on 1 thread) |
| Rate one month from the daily rollup | 0.21 | 0.65 |
| Full re-rate from raw JSONL (dedupe, rollup, rate) | 0.31 | 2.25 |
| Full re-rate from raw Parquet | 0.33 | 1.75 |

- **`read_json_auto` vs an explicit schema:** the cost is negligible at 10M because DuckDB infers from a sample. The risk is a wrong inference when the sample is unrepresentative, so use the explicit schema.
- **Memory limits:** `QUALIFY` dedupe at 10M ran under memory limits of 1, 2 and 4 GB (spilling). `arg_min` ran out of memory at 1 GB.
- **Parity checks:** the 10M result matched the generator's own totals with 0 mismatching cells (`results/pipeline/rate-10m.txt`: 112,690 expected cells, 0 mismatches). At 1M the saved ground-truth check failed with a SQL parse error (`rate-1m.txt`), so 1M is checked only against itself: the JSONL and Parquet rollups differ in 0 rows. Re-rating from raw JSONL, raw Parquet and the rollup gave identical lines at both sizes.

## Rating, rounding and late events

- **Rating rule:** prices are in integer micro-dollars per 1M tokens. A line is holder, model, direction and price version, joined to the price table by an `ASOF JOIN` on `valid_from`. The exact amount is `tokens x price`, an integer in pico-dollars (1e-12 USD). It is rounded to whole cents once per line, half away from zero. No floats are involved.
- **Float-drift proof:** re-rating twice gives identical lines and cents. At 10M that is 5,368,815 cents both times. The spike test also checks every line against an independent BigInt calculation.
- **Price change at 10M:**
  - Raising `sm-2` output (a retroactive correction) adds $189.53.
  - Cutting `md-2` input from 2026-10-16 (which splits the October lines) subtracts $180.58.
  - The school total moves from $53,688.15 to $53,697.10 and 8,034 holders change.
- **Rounding choice, at 10M with v2 prices:** rounding per event gives 4,057,877 cents, 24% too low, because most events are under half a cent. Rounding per line gives 5,369,710. Exact is 5,374,405 (floor), and rounding once per invoice (holder and period) gives 5,374,437. Per line loses about 0.09% against per invoice. Recommendation: per invoice, with lines shown for display.
- **Late events:** the shipper names batches `batch-<first id>-<hash>`, one per event date per ship run, and late events land in the old event-date partition.
  - If that day already has a `day.jsonl`, the shipper reports a `ShipConflict` and the rows stay unshipped. So late events after a combine cannot ship today.
  - With the proposed combine layout they go to `late-<ingest date>.jsonl` inside the event-date partition.
- **Closed-period test at 10M:** September was invoiced at 2026-10-02.
  - The as-issued lines come from `ingest_time < invoice time`; that took 2.6 s.
  - Recomputing September now took 2.5 s.
  - Reading only the `late-*` files took 0.44 s and found 55,938 late events. Their 46,497,047 input tokens match now minus issued exactly.
  - The adjustment was +$305.47 over 7,038 lines and 3,529 of 20,000 holders.
- **Recommendation for an event after its period was invoiced:** put it on the next invoice as an adjustment line referencing the original period, computed as current lines minus as-issued lines. Use a credit note only if the net adjustment is negative or the customer disputes it. Duplicates stay consistent because the earliest ingest wins.

## Fit with the existing code

- **Accepted unchanged:** the outbox (`appendToOutbox`), `shipOutbox`, the folder store, `readEvents`, and the journal builder. The journal adds 0 transactions for events with no postings.
- **Refused:**
  - The envelope `event_type` enum rejects `usage.recorded`, and `validateEvent` fails at `/event_type`.
  - `ledgerEvent` throws "engine event" for the type.
  - The payload schema registry has no entry for it.
  - Fixing these needs edits under `src/` (listed in the mapping spike report), which this spike did not make.
  - `replayEvents` on usage events was not tested.
- **Outbox insert rate** (`bun:sqlite`, events per second):

| Mode | Batch 1 | Batch 100 | Batch 1000 |
|---|---|---|---|
| In memory | 164k | 258k | 270k |
| File, WAL, `synchronous=NORMAL` | 21.9k | 58k | 117k |
| File, default journal, `synchronous=FULL` | 2.6k | 27k | 100k |
| File, WAL, `synchronous=FULL` | 10k | 59k | 133k |

  - **Ceiling:** about 100k to 130k per second, batched, on a small database.
  - **Growth effect:** it fell to about 24k per second when filling 1M rows (62k per second at 100k rows). The cause is the random index on `idem`, so a 10k per second target is close to the limit once the table is deep.
  - **Fsync caveat:** macOS fsync is optimistic, so the `FULL` numbers will be lower on a server.
  - **Row size:** each outbox row is about 686 B, and rows are never pruned. At 10M per day that is about 6.9 GB per day inside the transactional family database, which Litestream replicates.
- **Real shipper:**
  - 1M rows across dates: 9.7 s, 1.27 GB RSS, 71 batches, and the largest batch was 32k events.
  - 1M rows on one date: 6.6 s, 2.1 GB RSS.
  - 2.5M rows on one date: 26 s, 5.1 GB RSS.
  - 5M rows on one date failed with "Out of memory" at 6.5 GB RSS.
  - So one date's batch is limited to roughly 2.5M to 5M events. It is a single in-memory string, with about 2 KB of memory per event, and there is no size cap.

## Recommended layout and daily job

- **Layout:** `schools/<school>/usage/date=YYYY-MM-DD/` holding `day.parquet` (zstd) plus `late-<ingest date>.parquet`, with the full envelope and promoted typed columns (47 B per event). Cut files at about 100 to 500 MB or 5M rows. Partition only by date. Keep the model, feature and region labels as columns.
  - **Why not the hourly shipper layout:** it makes 29.5k files for 10M events against 1.3k combined, and was 1.5 to 2.4 times slower locally.
  - **Not measured:** file-count cost over real R2 HTTP (no R2 access), and a 10M-event single-day partition.
- **Daily job:**
  1. Combine the day's batches and dedupe by `idem` within the event date: about 2 s at 10M events with 15 threads, 8.7 s on one thread.
  2. Write Parquet (about 5 s for 10M JSON to Parquet, 7 GB RSS).
  3. Build the daily rollup (a few seconds).
  4. Rate (under 1 s from the rollup).
  5. Emit one Stripe meter event (or invoice item) per holder, day, model and direction, with `identifier = usage:<school>:<day>:<holder>:<model>:<direction>:<revision>`. That is about 33k rollup rows per day at this density.
  6. Rebuild affected closed days from the `late-*` files.
- **Runtime at 10M events per day:** about 10 s on this machine (not measured end to end), roughly 30 to 40 s on a 4-core box by the thread scaling above.
- **Stripe meter rate limit:** not checked. Recalled as about 1,000 per second; an assumption.
- **First bottleneck:** not DuckDB. It is the SQLite outbox (index growth, single writer, and 6.9 GB per day inside the Litestream-replicated family database), and then the shipper's whole-day in-memory batch. Usage should use its own outbox file or write batches straight to the store, with a size cap.

## Typed, self-describing, raw

**Typed vs JSON** (per holder, month and model sum, Parquet; file size and time are at 10M, memory at 1M and 10M):

| Variant | Bytes | Time (cold / warm) | RSS at 1M / 10M |
|---|---|---|---|
| JSON payload column | 454 MB | 0.44 / 0.45 s | 210 / 582 MB |
| Payload as a typed STRUCT, labels as MAP | 421 MB | 0.13 / 0.11 s | 98 / 357 MB |
| Envelope plus promoted columns | 475 MB | 0.06 / 0.06 s | 92 / 345 MB |
| Flat, promoted columns only | 290 MB | 0.06 / 0.05 s | 87 / 329 MB |

- **Result:** promoting fields is about 7 to 8 times faster, for about 4% more bytes than JSON alone.
- **Promote:** holder (`key`), `event_time`, `date`, `ingest_time`, `idem`, model, feature, region, and the input, output, cached and reasoning token counts. Money would be DECIMAL.
- **Keep as JSON or STRUCT:** the remaining payload, `redacted`, `text` and `postings`.

**Self-describing R2:** a DuckDB-written Parquet file carries its schema (`parquet_schema`) and custom key/value metadata via `COPY ... KV_METADATA {schema_version, mapping_version}`.

- **Manifest:** the spike test builds `<prefix>/_manifest/NNNN.json`, create-only, with the highest number current.
  - It holds the envelope version, the payload schema per version, the mapping name and versions, the DDL, the read SQL, the column meanings with their source paths, and the sha256, bytes, rows and versions of each file.
  - A reader using only the folder, `node:crypto` and the `duckdb` CLI verified the hashes, read the column meanings and opened the data.
- **Recording the version:** an event needs `payload.schema_version`. That is not in the benchmark payloads. It costs about 19 B raw, about 2.4 B in zstd JSONL, and roughly nothing in Parquet. The Parquet carries `schema_version` and `mapping_version` as constant columns and in the file metadata.
- **Adding `reasoning_tokens`:** the test reads old and new Parquet files together with `union_by_name = true`, and old rows get NULL.
  - Without that flag, DuckDB silently takes the first file's columns. Reading the old file first drops the new column, so the manifest's read SQL must always carry the flag.

**Raw layer:** a PII-stripped provider `usage` object plus ids (about 304 B uncompressed, with random message and request ids) adds 44.6 B per event in Parquet (47.1 to 91.7 B). That is about $0.007 per month per 10M events. Re-mapping from the raw column measured 0.18 s at 1M, so about 2 s at 10M (extrapolated). (The PII-stripping itself is punted, see the roadmap.)

## Not measured

- Cold-disk reads (the page cache was warm).
- R2 or HTTP file-listing and request costs, and real R2 prices.
- A 10M-event single day. The 10M run is one month of about 330k events per day.
- The Stripe API rate limit and meter-event emission.
- `replayEvents` on usage events.
- A 4-core or single-thread run of the aggregation queries. Only dedupe, rollup, rating, adjustment and delta were run on 4 and 1 threads.
- A shipper run at 10M rows. It was extrapolated from the 1M to 5M runs.

## Gates and disk

- Spike test: `11 pass, 0 fail, 2803 expect() calls`, 1.3 s.
- Full `bun test`: `1234 pass, 50 skip, 0 fail, 16237 expect() calls`, 62 s.
- `bunx tsc --noEmit`: no output (clean).
- Biome on the four touched files: `Checked 4 files ... No fixes applied.`
- `bunx knip`: exit 0, no unused files or exports, only the 11 existing configuration hints.
- `bun.lock` is unchanged.
- Peak scratch use was about 31 GB. The 10M datasets were deleted as soon as their numbers were recorded, then `data` and `work`.
