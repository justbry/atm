# Usage metering spikes (2026-11-05)

Three feasibility spikes on holding AI token usage and other usage events in R2 beside atm's credit ledger. `ROADMAP.md` ("Usage events as a ledger source") has the summary and the decisions; these files have the full reports.

| Report | Branch (pushed, not merged) | Verdict |
|---|---|---|
| [01-mapping-spike.md](01-mapping-spike.md) | `claude/atm-usage-mapping-spike`, head `f985c316a` | Feasible, 7 to 9 days to productionize. |
| [02-pipeline-spike.md](02-pipeline-spike.md) | `claude/atm-usage-pipeline-spike`, head `e292cbe2b` | Yes for the raw store, aggregation, rating, re-rating. The SQLite outbox and the shipper are the first bottleneck. |
| [03-track-spike.md](03-track-spike.md) | `claude/atm-usage-track-spike`, head `9d815769c` | Partly: a correct wallet if the gateway batches; overage is not reportable yet. |

- `results/`: raw benchmark output from the pipeline and `track` spikes.
- `scripts/`: the benchmark scripts as written, with a `.txt` suffix so lint and type checks skip them. They were run from `/tmp` against the spike branches' test helpers (`<spike-branch-checkout>` in their imports stands for a checkout of the spike branch) and are kept for reproducibility, not as maintained code.
- The mapping spike's schema, example mappings and samples are only on its branch (`schema/mapping/usage.*`, `tests/spikes/usage-samples/`).

Numbers are from one Apple M5 Pro laptop under load, mostly single runs; treat ratios as reliable and absolute figures as about 2x noisy. PII stripping and the raw input store were punted.
