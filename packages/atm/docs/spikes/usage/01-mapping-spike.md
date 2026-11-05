# Usage mapping spike: report

Date: 2026-11-05. Written by a sub-agent, saved here verbatim in substance. The summary is in `docs/usage-metering.md` ("Usage events as a ledger source"); `ROADMAP.md` keeps the verdicts.

Branch `claude/atm-usage-mapping-spike`, head `f985c316a1f849988ee2e3f9bd70f8de8e70fa60`, pushed, no PR. The branch adds files only. `src/`, existing schemas, `bun.lock`, ROADMAP, README and UPGRADING are untouched.

## Verdict: yes, with a bounded amount of new work

The path walk, optional/default handling, enumerated values and `personal` redaction carry over. The ledger takes a usage event as it is, apart from three registry edits. The new parts are:

- decimal handling
- cross-quantity subtraction
- a cardinality guard
- a repeat rule for streaming responses
- a format-drift check

## Reused versus new

**Reused unchanged:**

- `parsePath`, `getPath` and `redactPersonal` from `src/billing/normalize.ts`. `redactPersonal` reads only `source`, `event`, `v` and `personal`, so a shim object works.
- `decimalToUnits`, `unitsToDecimal`, `canonicalize` and `sha256Hex` from `src/ledger/util.ts`.
- `ledgerEvent`, `appendToOutbox`, and the Ajv envelope validation.

**Stripe-specific, not used:** `target` enum, `stripeApiVersion`, `lines`, `FieldType` (`seconds`/`map`/`bool`), and the closed `NormalizeError` union.

**Not importable:** `convert`, `readField` and `buildFields` are not exported, so the spike reimplemented about 120 lines. To share them, extract `readField(root, spec)` and a pluggable type table from `normalize.ts`.

**Schema decision:** a separate `usage.schema.json`, not a union.

- `mapping.schema.json` pins `source: const "stripe"` and requires `target` and `stripeApiVersion`.
- A union would loosen the Stripe schema for no gain.
- The `path` definition is duplicated (one regex). The index builder only globs `^stripe\.`, so usage files do not disturb `MAPPING_FILES`.

## Schema as proposed

`packages/atm/schema/mapping/usage.schema.json` (draft 2020-12, `additionalProperties: false` throughout). Example mappings sit beside it as `usage.<source>.<event>.v<N>.json`.

- `v`, `source` (not `stripe`), `event`.
- `sourceVersion {path, equals}`. A mismatch is refused, as `stripeApiVersion` is.
- `id {path, type, onRepeat: first|max}`. It becomes `idem` as `usage:<source>/<event>:<id>`.
- `time {path, type: seconds|millis|iso, late {afterSeconds, policy: flag|reject}}`.
- `holder {path, prefix, type}`. This becomes the envelope `key`. The school comes from the authenticated ingest context, never the payload.
- `labels`: at most 8 axes. Each has `values` (array) plus `onUnknown: other|reject` and an optional `other` name. Free-form labels need `maxDistinct`. `default` and `optional` work as in the Stripe schema. The names `mapping`, `source`, `school`, `key` and `idem` are reserved.
- `quantities`: `type: int|decimal`, `unit` and `meaning` are required. Optional keys are `scale`, `rawPlaces`, `minus [names]`, `default`, `min`, `max`. A quantity with no `path` is a declared constant.
- `personal` and `ignore` path lists.

**Examples:**

- `usage.openai.llm.completion.v1.json`
- `usage.openai.llm.completion.v2.json`
- `usage.anthropic.llm.completion.v1.json`
- `usage.grok.llm.completion.v1.json`
- `usage.storage.snapshot.v1.json`

Raw samples are in `tests/spikes/usage-samples/`:

- `openai.llm.completion.json`: 10 events.
- `storage.snapshot.json`: 8 events.
- `anthropic.streaming.json`: 4 events.
- `providers.json`: the same call written by three providers.

The samples cover a missing optional label, an unknown model value, a duplicate request id, a late event with an old timestamp, a payload containing PII fields and a malformed quantity.

The soundness checks the loader adds beyond the schema:

- A read path may not sit under a `personal` path.
- A label may not read the id or holder path.
- `minus` must name a real int quantity.
- A label `default` must be in `values`.

The label is named `usage_feature`, not `feature`. Credit events already use `labels.feature` (and `replay.ts` reads it), so reports grouped by `feature` would mix credit features with AI features.

## Decimal decision

- **Whole numbers** are safe-integer JSON integers. A string like `"1200"` or a float is refused.
- **Decimals** are decimal strings with a fixed `scale`. They match the envelope's own "decimal string, never a float" convention.
- **Parsing:** the raw value may be a string or a plain number. Exponents and extra places are refused, never rounded.
- **Arithmetic** runs in BigInt units.
- **Why not integer micro-units:** the unit is then implicit in the field name. A string stays self-describing, and DuckDB sums it exactly. `CAST(... AS DECIMAL(18,6))` on payload JSON works with no DDL change (spot-checked by hand).
- **Derived cost:** `rawPlaces` handles Grok's `costUsdTicks` (integer, 10^-10 dollars) as exact integer-to-decimal conversion. The test sums 4 tick values to `"0.4234567898"` exactly. As a demonstration, `0.1 + 0.2` as floats does not equal `0.3`, which is the drift in agentlake's `::DOUBLE` sums.
- **Money-like fractions** do not belong in postings. Postings are 2-place USD, and the DuckDB DDL maps `format: decimal` to `DECIMAL(18,2)`. Usage costs carry 6 to 10 places. Rating usage into dollars should be a later event.

## Where the envelope and registry do NOT fit, and the exact change for each

1. **`event_type` enum** in `schema/envelope.v1.json` rejects `usage.recorded`. This is the only error `validateEvent` returns for the built event, and the test asserts it. Change: add `"usage.recorded"` to the enum.
2. **`AtmEventType` union** in `src/types.ts`. Add the member.
3. **`moneyPostings` default branch** in `src/ledger/postings.ts` throws for unknown types. Add `case "usage.recorded": return [];`. The spike builds a `policy.published` event and renames it, which works because the id seed is school and idem.
4. **Payload registry** `src/ledger/schemas.ts` is generated by `bun schema/build.ts`. Move `schema/payload-proposed/usage.recorded.v1.json` to `schema/payload/` and rerun `bun schema/build.ts`.
5. **The drift test** in `schema.test.ts` requires payload files to equal the enum. This is why the draft sits in `payload-proposed/`: placing it in `payload/` without the enum change fails that test.
6. **`defaultSource`** returns `"family"` for unknown types. Pass `source` explicitly (the spike does).

**What fits as-is:**

- `postings: []` passes the "none or at least two" rule.
- String-only labels work. Numbers become strings via the label `type`.
- `key` holds the holder, and `idem` the request id.
- `replay.ts` skips events with no `payload.command`, so the payload schema forbids `command`.
- The journal ignores events without postings.
- The DuckDB DDL needs no change.

**Where numbers live:** quantities go in `payload.quantities` (integers as numbers, decimals as strings) with a `units` map. Labels carry only bounded axes.

## Cardinality guard (tested)

- Enumerated labels (`values` plus `other` or `reject`) need no state.
- Free-form labels need `maxDistinct`, with at most 1000 values per label per school.
- `LabelCardinalityGuard` is keyed by school and label. The next new value is quarantined (error) or bucketed (`onUnknown: other`). Known values still pass.
- A refused event does not consume a slot, and the cap is per school.
- Label values are limited to `[A-Za-z0-9_.:/-]{1,64}`. An email, a sentence or an over-long string is refused, and the error does not echo the value.
- A label may not read the id or holder path.
- Request ids go in `idem` and `payload.request_id`. User ids go in `key`.
- In production the guard state needs a table `(school, label, value)` written in the outbox transaction. The stored label value is already the post-guard value, so replay does not re-run the guard.

## Agentlake lessons

1. **Token meaning is named per quantity.** Every quantity has a required `meaning`. The convention is that `input_tokens` is uncached input, `cache_read_tokens`, `cache_write_tokens` and `reasoning_tokens` are separate, and `output_tokens` excludes reasoning, so the quantities are disjoint and sum to the billed total. `minus` expresses "cached counted inside the prompt" (OpenAI, Grok). Anthropic reports cache apart from input, and a declared-constant quantity gives it `reasoning_tokens = 0`. The test shows three providers writing the same call normalize to `input 200`, `cache_read 1000`, `cache_write 0`, `output + reasoning 300` and a total of 1500. Grok's reasoning-in-output relationship is unconfirmed upstream, so the mapping says so and does not subtract. A mapping cannot fix a provider whose docs are silent.
2. **Streaming repeats need `id.onRepeat: max`.**
   - The test logs one response id three times with `output_tokens` 1, 120, 480. Under `max` it collapses to 480, so the sum is 492 and not 613.
   - `max` is order-independent. A count that goes down is reported as a conflict.
   - The ledger cannot do this itself. `ON CONFLICT (school_id, idem) DO NOTHING` keeps the first write, i.e. the 1. So `max` is a collapse stage before the ledger.
   - Agentlake takes the first line and flags it as "nothing to check them against". `max` is recommended because counts only grow within a response.
   - The open design question is when a stream is complete (a final-event signal, or a quiet window).
3. **Numbers sit in `quantities`.** Integers are exact and decimals are strings with BigInt sums. Labels are strings only. A stringified numeric label is available (`type: int`) but not summable.
4. **Size and PII.**
   - The ledger payload is built from the mapping's declared fields only. That is an allowlist, not a copy of the raw event.
   - In the test, a raw event over 20 KB became a ledger event under 1.5 KB.
   - The raw event is not stored in the ledger. A redacted copy (personal paths removed) goes in an input store, keyed by `sha256`, as agentlake does for blobs. (The input store and PII stripping are punted, see `docs/usage-metering.md`.)
   - Agentlake's 3.2 GB of logs becoming a 3.0 GB database comes from storing `payload.raw` as JSON text. A usage ledger should not repeat that.
   - `personal` is a denylist. The drift check below is the backstop for a new PII key.
5. **Format contract (tested).**
   - `keyPaths` prints key structure with no content. This is the equivalent of agentlake's probes.
   - `shapeDrift` compares an event with the paths the mapping reads, `personal` or `ignore`, and `assertNoDrift` throws a message naming the unknown and missing keys.
   - A rename, a new field such as `user.phone`, and a new key beside `messages` are all caught. Keys under a personal path are known, so prompts can change shape freely.
   - A `sourceVersion` bump is refused.
   - Run it in CI on committed samples, and on a sampled live event on a schedule.

## Provenance and re-mapping

**Decision:** provenance goes inside `payload` plus the existing `mapping` label. No envelope field is added. Four required payload fields:

- `payload_schema` is a `const 1` tied to the file name.
- `mapping` is `openai/llm.completion@v1`, also set as `labels.mapping`. The Stripe mappings already do this through `mappingLabels`.
- `mapping_digest` is the sha256 of the mapping file's canonical JSON. It proves which bytes ran, since `@v1` could be edited in place.
- `raw_sha256` is the hash of the redacted raw copy, which is stored apart under that hash.

**The envelope-field alternative** also works but costs more. Today a top-level `mapping` is refused with "additional properties (mapping)". Widening the envelope with optional `mapping` and `payload_schema` makes `duckdbDdl` emit `mapping VARCHAR` and `payload_schema BIGINT`. That requires regenerating `schema/duckdb/envelope.v1.sql` and its drift test. The label already lands in the DuckDB `MAP` column, so it was not taken.

**Re-derive test:** a reader with only the events, the stored redacted raw and the mapping files reproduces every fact. This includes `late`, because it uses the event's own `ingest_time`. A mapping file that differs from the digest, a missing raw object or a missing mapping each fail with a specific message.

**Re-mapping test:** the same stored raw through v2 (which stops subtracting reasoning and adds a model value) gives `output_tokens` 300 instead of 200, and an unknown-model label `gpt-z-preview` instead of `other`. The mapping becomes `@v2`, and v1 stays byte-reproducible afterwards.

**Finding:** a v2 event for the same request has the same `idem`, so the outbox drops it. A re-map has to be a new event with:

- idem suffix `#remap@v2`
- `cause` set to the original event's id (the envelope field already exists)
- the same `event_time`

Both then sit in the log. Readers must take the highest mapping version per request, or the call is counted twice. The test shows 500 against 300 tokens.

**Missing infrastructure:**

- There is no input store for redacted raw events, and `atm_event_claims` keeps none. This is a prerequisite (punted).
- Mapping files must be published next to the log (an R2 prefix) for a reader of R2 alone.

## Effort to productionize

About 7 to 9 days:

- 1 day for envelope, type, postings and payload-registry edits plus tests.
- 2 days to extract the shared reader from `normalize.ts`.
- 1.5 days for a persistent cardinality guard and quarantine table.
- 1.5 days for the collapse stage with a stream-completion rule.
- 1.5 days for the input store, mapping publication and the remap and latest-version reader rule.
- 1 day for the contract CI and probe command.
- 1 day for docs, UPGRADING and release.

## Risks

- **Stream completion:** `max` needs a signal for when a stream is complete.
- **Guard state:** the guard decision depends on arrival order, so it must be persisted.
- **Remap double counting:** remaps create two events per request. Every usage report needs the latest-version rule.
- **Provider semantics:** token meanings change silently, and some are unconfirmed (Grok reasoning, the 10^10 ticks assumption). The drift contract catches shape changes, not meaning changes. Pinned fixtures need review.
- **Denylist PII:** `personal` is a denylist.
- **`feature` label collision** with credit events, and `format: decimal` meaning 2 places in the DuckDB DDL, if anyone puts usage decimals in postings.
- **Future events** are refused with a hard-coded 5-minute skew that is not in the schema.
- **DuckDB** was only spot-checked by hand (integer and decimal sums over payload JSON). There is no committed DuckDB test.
- **Unrun:** hledger journal output for usage events (it ignores them since they have no postings).

## Gates (from `packages/atm` unless noted)

- `bun test tests/usage-mapping-spike.test.ts`: `49 pass, 0 fail, 348 expect() calls`
- Full `bun test`: `1272 pass, 50 skip, 0 fail, 13782 expect() calls, Ran 1322 tests across 52 files`
- `bunx tsc --noEmit`: no output, clean
- Biome on touched files: `Checked 13 files ... No fixes applied.`
- `bunx knip` (repo root): exit 0, only pre-existing configuration hints

## Key files (on the spike branch)

- `packages/atm/schema/mapping/usage.schema.json`
- `packages/atm/schema/mapping/usage.*.v*.json`
- `packages/atm/schema/payload-proposed/usage.recorded.v1.json`
- `packages/atm/tests/spikes/usage-mapping.ts`
- `packages/atm/tests/usage-mapping-spike.test.ts`
- `packages/atm/tests/spikes/usage-samples/*.json`
