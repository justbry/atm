# Custom metrics over the ledger model (phase 2 design)

Status: draft, 2026-11-06. Design only; nothing here ships in atm's runtime. Phase 1 is the ledger model (`packages/atm/model/ledger.v1.json`, schema `schema/model.v1.json`, loader `src/model/ledger-model.ts`). This file says how a school or B4 Uni would define its own metrics and reports over that model without a new way around the disclosure.

Every figure in section 8 comes from [`worked-examples.ts`](worked-examples.ts). Rerun it from the repository root:

```
bun plans/atm-ontology/worked-examples.ts                 # the cells and the validator's answers
bun plans/atm-ontology/worked-examples.ts --definitions   # the example definitions as JSON
```

The script rebuilds the 15 presets with `buildFixture` and the atm fold and stops unless each fixture hash and KPI hash equals the mart snapshot's (`plans/ledger-ui/design/mart/kpis/<preset>.json.gz`). It calls the real `kpiDocument` of `atm/worker` with the UI's disclosure fixture (school `b4u`, small, no override) and the oracle test's clock (`today 2026-11-05`). The validator and the custom cells are a prototype inside the script, not atm code. It reads `LEDGER_MODEL`, so it fails if the model on disk does not load.

## 1. Scope

A custom metric is a named, versioned composition of the model's measures. It is evaluated by the Worker inside `kpiDocument`, for one audience, with the same rules as every catalog KPI. It is never a query. It has:

- no raw event access, no account regex, no free-form expression;
- no figure of its own: an input it cannot see, it cannot show;
- one meaning for every school that enables it.

Not in scope: new base aggregates. A metric that needs a base aggregate the KPI spec does not compute (example 1) needs a model and spec revision first, through the normal atm release.

## 2. The definition format

A definition is one JSON object. It composes measures only:

| Part | What it may say |
| --- | --- |
| `compute` | `value` of one term; `sum` of 2 to 6 signed terms; `ratio` of two sides (a term or a sum) |
| term | `{ measure, where? }`. `where` names one dimension the measure carries: `"tier": "fellow"` or `"tier": { "in": [...] }` |
| `groupBy` | one dimension every term carries; the metric gets one cell per value (`<id>@<version>:<value>`) |
| `window` | `{ "trailing": n }` months ending with the period, or `{ "toDate": "year" }` |
| `compare` | `{ "with": "previousPeriod" \| "samePeriodLastYear", "as": "difference" \| "ratio" }` |
| pins | `model` and `kpiSpec` the definition was validated against |

Example (section 8.2):

```json
{
	"id": "refund_rate_trailing_3_months",
	"version": 1,
	"title": "Refund rate, trailing three months",
	"description": "Refunds over gross collected, both summed over the three months ending with the period.",
	"model": "ledger.v1",
	"kpiSpec": "school.v1",
	"unit": "ratio",
	"format": "percent1",
	"compute": {
		"op": "ratio",
		"numerator": { "measure": "refunds" },
		"denominator": { "measure": "gross_collected" }
	},
	"window": { "trailing": 3 }
}
```

### JSON Schema sketch (`schema/metric.v1.json`, in the style of `kpis.v1.json`)

```json
{
	"$schema": "https://json-schema.org/draft/2020-12/schema",
	"$id": "https://b4uni.com/_schema/metric.v1.json",
	"title": "Custom metric v1",
	"description": "A metric composed from the ledger model's measures and dimensions. It names no event, account or regex: every term is a measure of the pinned model, every filter a dimension value. The Worker evaluates it inside the KPI document, under the disclosure of its inputs (custom-metrics.md section 4). Published definitions are immutable: a change is a new version.",
	"type": "object",
	"required": ["id", "version", "title", "description", "model", "kpiSpec", "unit", "format", "compute"],
	"additionalProperties": false,
	"properties": {
		"$schema": { "type": "string" },
		"id": { "$ref": "#/$defs/snakeId" },
		"version": { "type": "integer", "minimum": 1 },
		"title": { "type": "string", "minLength": 1, "maxLength": 80 },
		"description": { "type": "string", "minLength": 1 },
		"model": {
			"type": "string",
			"pattern": "^ledger\\.v[0-9]+(\\.[0-9]+)?$",
			"description": "The model the definition was validated against."
		},
		"kpiSpec": { "type": "string", "pattern": "^school\\.v[0-9]+(\\.[0-9]+)?$" },
		"unit": {
			"enum": ["cents", "count", "ratio"],
			"description": "Declared, and checked against the unit the terms give (section 3)."
		},
		"format": { "enum": ["money", "money0", "integer", "percent1"] },
		"compute": { "$ref": "#/$defs/compute" },
		"groupBy": {
			"$ref": "#/$defs/snakeId",
			"description": "A dimension every term carries; one cell per value."
		},
		"window": {
			"oneOf": [
				{
					"type": "object",
					"required": ["trailing"],
					"additionalProperties": false,
					"properties": { "trailing": { "type": "integer", "minimum": 2, "maximum": 24 } },
					"description": "The months ending with the period. Evaluated only at the audience's grain ends; the length must be a multiple of the grain."
				},
				{
					"type": "object",
					"required": ["toDate"],
					"additionalProperties": false,
					"properties": { "toDate": { "const": "year" } },
					"description": "From 1 January of the period's year to the period's end."
				}
			]
		},
		"compare": {
			"type": "object",
			"required": ["with", "as"],
			"additionalProperties": false,
			"properties": {
				"with": { "enum": ["previousPeriod", "samePeriodLastYear"] },
				"as": { "enum": ["difference", "ratio"] }
			},
			"description": "Against another period of the audience's own grain. Both sides must be figures."
		}
	},
	"$defs": {
		"snakeId": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,59}$" },
		"value": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{0,59}$" },
		"filter": {
			"oneOf": [
				{ "$ref": "#/$defs/value" },
				{
					"type": "object",
					"required": ["in"],
					"additionalProperties": false,
					"properties": {
						"in": { "type": "array", "minItems": 1, "maxItems": 20, "uniqueItems": true, "items": { "$ref": "#/$defs/value" } }
					}
				}
			]
		},
		"term": {
			"type": "object",
			"required": ["measure"],
			"additionalProperties": false,
			"properties": {
				"measure": { "$ref": "#/$defs/snakeId" },
				"where": {
					"type": "object",
					"maxProperties": 1,
					"propertyNames": { "$ref": "#/$defs/snakeId" },
					"additionalProperties": { "$ref": "#/$defs/filter" },
					"description": "The one dimension the measure carries (a measure has at most one), and the values kept."
				}
			}
		},
		"sum": {
			"type": "object",
			"required": ["op", "terms"],
			"additionalProperties": false,
			"properties": {
				"op": { "const": "sum" },
				"terms": {
					"type": "array",
					"minItems": 2,
					"maxItems": 6,
					"items": {
						"type": "object",
						"required": ["sign", "of"],
						"additionalProperties": false,
						"properties": { "sign": { "enum": [1, -1] }, "of": { "$ref": "#/$defs/term" } }
					}
				}
			}
		},
		"side": { "oneOf": [{ "$ref": "#/$defs/term" }, { "$ref": "#/$defs/sum" }] },
		"compute": {
			"oneOf": [
				{
					"type": "object",
					"required": ["op", "of"],
					"additionalProperties": false,
					"properties": { "op": { "const": "value" }, "of": { "$ref": "#/$defs/term" } }
				},
				{ "$ref": "#/$defs/sum" },
				{
					"type": "object",
					"required": ["op", "numerator", "denominator"],
					"additionalProperties": false,
					"properties": {
						"op": { "const": "ratio" },
						"numerator": { "$ref": "#/$defs/side" },
						"denominator": { "$ref": "#/$defs/side" }
					},
					"description": "numerator / denominator in the same period; not computed when the denominator is 0 (never shown as 0)."
				}
			]
		}
	}
}
```

The schema cannot see the model, so it checks shape only. Everything that needs the model is the validator's (section 3). In the Worker the schema check is a precompiled validator or none (Ajv's `new Function` fails in a deployed Worker, spec v3 "Validation on Workers").

## 3. Validation against the model

The validator runs before anything is computed and needs no data. It reads the model, the KPI spec and the disclosure file. It returns every problem at once, each with a code and the term named.

| Code | Refused when | Example (section 8) |
| --- | --- | --- |
| `unknown_term` | a measure, dimension or closed-list value is not in the pinned model. A suggestion comes from the model's `synonyms`; a term the document lists as not computed says why | `revenue` → did you mean `gross_collected`; `mrr` → "MRR is not computed: cash basis, a yearly payer counts in the month paid" |
| `dimension_not_carried` | a `where` or `groupBy` names a dimension a term's measure does not carry | `paying_members` by `tier` |
| `identity_dimension` | the split is to `rows` or `names` (`account`) | `closing_balance_credits` by `account` |
| `personal` | a term is in the `personal` class | `closing_balance_credits` |
| `unit_mismatch` | the declared unit is not the terms' unit, or the algebra has no result | `paying_members / gross_collected` |
| `rollup` | a `recompute` measure is added, windowed or divided (use its inputs); a `last` measure is windowed; a sum mixes rollups or adds a `max` measure | three months of `refund_rate` added |
| `complementary_difference` | a sum gives opposite signs to two terms of one partition family (a total and its own split cells) | `gross_collected − revenue_by_tier:fellow` |
| `stale` | the pinned model or a term's fingerprint is not the catalog's (section 6) | `refunds` renamed in a later model |

Unit algebra:

| Operation | Result |
| --- | --- |
| cents ± cents, count ± count | same unit |
| cents / cents, count / count | ratio |
| cents / count | cents (per member, two decimals as `arpa`) |
| count / cents, anything with a ratio input, cents ± count | refused |

Rollup rules follow the model's `rollup`. A `sum` measure adds over months, windows and quarters. A `max` measure (`paying_members`) takes the most in one month, as `figureOf` does, and may only stand alone or as a whole ratio side. A `recompute` measure is never added: the validator names its inputs (`refund_rate` → `refunds, gross_collected`). A `last` measure is a balance and is never windowed.

### The static complementary check

The model needs one new fact per split measure: which cell its values add up to. Proposed field `partitionOf`:

| Measure | `partitionOf` | Holds on the presets |
| --- | --- | --- |
| `revenue_by_kind` | `gross_collected` | 150 of 150 preset months |
| `revenue_by_tier` | `revenue_by_kind:membership` | 150 of 150 |
| `paying_members_by_tier` (proposed) | `paying_members` | 150 of 150 |

(Script, section 0. A model test would assert these on the presets, as `certifiedBy: presets` does for joins.)

Each term then has a family, its chain of totals up to a root (`revenue_by_tier < revenue_by_kind:membership < gross_collected`). A sum that adds one member of a family and subtracts another is refused. The difference of a total and some of its split cells is the rest of the split: a cell the document may hide. `gross − Σ other tiers` normalizes to the fellow tier alone, so it is refused for the same reason. Sums across families (`gross_collected − refunds`) are allowed: they are what `net_income` is. The rule refuses some harmless sums too (`net_income − gross_collected`); those can be written from their parts.

The static rule does not catch a positive partial sum (`revenue_by_tier where tier in [audit, scholar, seminar]`). That is caught at evaluation (section 4, rule 4).

### The `answerable` check

For each audience the validator says, before any data is read, whether the metric can be shown and how:

```
validate refund_rate_trailing_3_months@1: accepted
  unit ratio, needs total
  public: not shown (no rule for an input) -> {"hidden":"no_grant","text":"Members see this"}
  member: {"every":"quarter","detail":"total","after":"6 weeks","cellRules":"on","evaluatedAt":"quarter ends, published 6 weeks after the period closes"}
  governance: {"every":"month","detail":"breakdown","after":null,"cellRules":"breakdown and spread","evaluatedAt":"month ends, at close"}
  finance: {"every":"day","detail":"names","after":null,"cellRules":"off","evaluatedAt":"every month, the open month included"}
  owner: {"every":"day","detail":"names","after":null,"cellRules":"off","evaluatedAt":"every month, the open month included"}
```

The rule is `kpiRule` applied to the inputs and capped the way `kpiRule` caps a derived KPI: the finest detail every input allows, the coarsest grain, the longest delay. The detail the metric needs is the finest of its `groupBy` dimension's `need`, any filtered dimension's `need` (one plan's figure is a breakdown cell) and the measures' `document.need`. An audience whose capped detail is coarser, or whose grain does not divide the window's length, gets "not shown" and the document's own `whoSees` text.

## 4. A custom metric never bypasses the disclosure

These rules are the evaluation, in order. They are the document's existing rules (`gate`, `failure`, `roundCount`, `finish`, `complementPlans`) applied to custom cells, plus four for what compositions add.

1. **Rule and class.** The metric takes the capped rule of its inputs for the audience (section 3). Its class for display is its strictest input's. A school cannot make it more open: it is not in the disclosure file's `classes` (decision 5).
2. **Gate.** The cell is hidden before any value is read, by grain, detail or delay, with the document's texts ("Governance and up see this", "Published after 18 Nov 2026"). The open month shows only to finance and the owner, as today. A PIN-locked document locks custom cells too.
3. **Inputs as the audience sees them.** Each term's cells are first worked out as the audience's document would show them, with the cell rules and the complementary rule on every catalog split. If any input cell is not a plain number (hidden, `{lt}`, `{approx}`), the custom cell is `{ "hidden": "suppressed", "text": "Hidden: a figure it is worked out from is hidden" }`. The value itself is computed from exact inputs and rounded once at the end, as spec v3 asks of `arpa` and `refund_rate`.
4. **Partial sums.** A term with an `in` filter over a split is a visible partial sum. Its complement within the partition total must pass the cell rules as one cell, or the custom cell is hidden with the document's complementary text ("hidden so the cell beside it can't be worked out from the total").
5. **Own cell rules.** The custom cell takes the cell rules on its own contributors: at least 5 distinct holders, the largest at most 60% of an amount. Counts that fail are banded (`{lt: 10}` or the nearest 10). This needs D9 resolved to per-cell holders (decision 4); under the oracle rule (the period's paying members) a per-plan count of 1 passes, see 8.1.
6. **Windows at the audience's grain only.** A window cell exists only at the end of a period of the audience's grain, and a trailing length must be a multiple of that grain (3 for quarters, 12 for years). Stepping monthly at a quarter-grain audience leaks months: T(m) − T(m−1) is the month entering less the month leaving (8.2 computes one). A window that starts before the books' first month is not computed.
7. **Windows across suppressed periods.** Two shown window cells difference to the periods between them. A window cell shows only when its change since the last shown window cell (the periods entering, and those leaving) passes the cell rules as one cell. Otherwise it is suppressed. 8.3 shows the year-to-date donor table needs this today.
8. **Comparisons.** A comparison is computed only between two figures of the audience's own grain, after rules 1 to 7. A hidden or embargoed side keeps the comparison hidden or embargoed. It never compares against an invented year (the document scales 2026 into 2024 and 2025 for Public and Member).
9. **Finish.** Money rounds to the audience's `roundTo` ($100 for member and public at a small school), a positive amount that rounds to 0 is `{lt}`, as `finish` does.

Evaluation is deterministic and server-side. The Worker computes every custom cell from the school's KPI rows and the contributions view, in `kpiDocument`. The document is the only output. No LLM writes a figure. An LLM may draft a definition from a question, using the model's titles and synonyms. The draft goes through the same validator and is published by a person (decision 2). An assistant that answers from a document reads cells the audience already has.

## 5. Evaluation in the Worker

- `kpiDocument(rows, contributions, disclosure, audience, pinLocked, context)` gains `context.metrics`: the compiled definitions the school has enabled. The function stays pure and Ajv-free.
- Series ids are `<id>@<version>` and `<id>@<version>:<value>`. The `@` keeps them apart from catalog ids, which are snake case.
- `meta[<id>@<version>]` adds `definition: { id, version, sha256, model, kpiSpec }`. The document lists every enabled metric that is stale in `notComputed`, with the reason.
- Rules 3 to 7 need per-cell holders and largest shares for cells the month contributions view does not hold: quarters, windows, years to date, partial sums. Distinct holders over a window cannot be added up from monthly counts. The views job (S8c cron) has the events and writes them, keyed by metric and period, next to `views/kpi/contributions/`. The mart already does this for the year to date (`contribYtd`).
- The document's canonical hash covers the custom series, so the signed manifest covers them.

## 6. Versioning and provenance

- A published definition is immutable. Its address is `id@version`. A change is a new version; the old one stays readable until no school enables it.
- A definition pins `model` and `kpiSpec`. At publication the catalog also stores a fingerprint per referenced measure: sha256 of its resolved facts (unit, rollup, class, `ruleOf`, dimensions, `partitionOf`, and the spec KPI's `compute`).
- When the model or spec changes, CI revalidates every published definition. All fingerprints equal: the definition stays valid on the new revision. Any measure renamed, removed or changed: the definition is `stale`. Its cells read `{ "hidden": "not_computed", "text": "Not computed: definition stale" }` and `notComputed` says which term changed. It is never silently recomputed under a new meaning. The script shows the answer for a renamed measure:

```
validate refund_rate_trailing_3_months@1: refused
  stale: pinned to model ledger.v1, the catalog is on ledger.v2
  unknown_term [refunds]: refunds is not a measure of ledger.v2
```

- Provenance: the definition hash is sha256 of the definition's canonical JSON (atm's `canonicalize`, keys sorted). It goes in the document's `meta`, so a reader can tell two versions apart and tie a figure to its exact definition. The hashes of the examples are in section 8.

## 7. Storage

| Option | For | Against |
| --- | --- | --- |
| **A. B4 Uni-wide catalog in atm**, `packages/atm/metrics/<id>@<version>.json` next to the model, imported as JSON and resolved in-process as the KPI catalog is (`src/model/resolve.ts`) | reviewed in a PR; CI validates against the model and evaluates on all 15 presets with the rebuild-a-holder test; immutability is git plus the hash; no validator in the Worker; one meaning across schools | a school waits for an atm release to get a new metric |
| B. Per school in buzz-school, next to the disclosure override (`school_books_disclosure`) | schools author their own; changes need no release | a runtime validator in buzz-school or the Worker; each school's metric needs its own leak review; the same name means different things per school |
| C. R2 beside the views | the Worker reads it with the views | R2 holds what the job writes, not a source of truth; no writer, no review, no audit trail |

**Recommendation: A**, with the per-school selection (which catalog metrics a school shows) stored in buzz-school next to the disclosure override, as ids only. The leak checks in section 4 are only as good as the review and the preset tests behind them, and those exist in atm's CI and nowhere else. School-authored definitions can come later as drafts that go through the same CI (decision 2).

## 8. Worked examples

All cells are in the `Cell` shape of `kpi-document-types.ts`: `number | {lt} | {approx, why} | {hidden, text}`. Money is in cents. "x5" in the script's output means the same cell five times in a row.

### 8.1 Revenue per paying member, by plan (`one-payer-tier`)

The preset has 20 families on four plans, nobody leaves, January to June 2026. The fellow plan has exactly one payer.

**Against model v1 this is not answerable.** `paying_members` has no `tier` dimension. The spec cannot add one: `parseKpiSpec` refuses `count` and `distinct` split by account ("an event has several postings; use a label"), and the atm fold skips such a split (`dimensionOf` gets no text, so every event is left out).

```json
{
	"id": "revenue_per_paying_member_by_tier",
	"version": 1,
	"title": "Revenue per paying member, by plan",
	"description": "Membership revenue of a plan over the plan's paying members, per month (cash basis).",
	"model": "ledger.v1",
	"kpiSpec": "school.v1",
	"unit": "cents",
	"format": "money0",
	"compute": {
		"op": "ratio",
		"numerator": { "measure": "revenue_by_tier" },
		"denominator": { "measure": "paying_members" }
	},
	"groupBy": "tier"
}
```

```
validate revenue_per_paying_member_by_tier@1: refused
  dimension_not_carried [paying_members by tier]: paying_members has no tier dimension (it has none)
  definition sha256 e98e40accbbd3184884dfe428f93a0610bd3522edc3a7efc0f308d996dae881e
```

**Proposed model v1.1 base measure** `paying_members_by_tier`: distinct holders with a `payment.succeeded` membership posting to `income:billing:membership:<tier>` in the month. Class `people`, `ruleOf: paying_members`, dimension `tier`, rollup `max`, `partitionOf: paying_members`. It is well defined because a membership payment has at most one membership posting: on the 15 presets, 1910 membership payments, none with two (script, section 0). In the spec it needs decision 3. The definition above, repinned to `ledger.v1.1` with `paying_members_by_tier` as the denominator, is accepted (sha256 `ee036b53…b632b5`; the refused draft was never published, so `@1` is still free). Answer: public and member not shown ("Governance and up see this": the split needs `breakdown`, their capped detail is `total`); governance month, breakdown, cell rules on; finance and owner live.

The proposed measure's figures, counted by the script from the preset events (not an atm figure today), beside atm's `revenue_by_tier`:

| Plan | Payers (proposed) | Revenue Jan / Feb–Jun | Largest holder's share Jan / Feb–Jun |
| --- | --- | --- | --- |
| scholar | 8 | 26700 / 23700 | 0.165 / 0.143 |
| fellow | 1 | 5900 / 5900 | 1 / 1 |
| seminar | 5 | 12800 / 11300 | 0.398 / 0.319 |
| audit | 6 | 11200 / 7200 | 0.464 / 0.167 |

**Governance, month table, D9 resolved to per-cell holders** (the same cell in January to June unless shown):

| Series | Jan | Feb–Jun |
| --- | --- | --- |
| `paying_members_by_tier:fellow` | `{"lt":10,"why":"fewer than 5 payers"}` | same |
| `paying_members_by_tier:seminar` | `{"lt":10,"why":"rounded so the cell beside it can't be worked out from the total"}` | same |
| `revenue_by_tier:fellow` | `{"hidden":"suppressed","text":"Hidden: fewer than 5 payers"}` | same |
| `revenue_by_tier:audit` | `{"hidden":"suppressed","text":"Hidden: hidden so the cell beside it can't be worked out from the total"}` | same |
| `revenue_per_paying_member_by_tier@1:scholar` | `3337.5` | `2962.5` |
| `revenue_per_paying_member_by_tier@1:fellow` | `{"hidden":"suppressed","text":"Hidden: fewer than 5 payers"}` | same |
| `revenue_per_paying_member_by_tier@1:seminar` | `{"hidden":"suppressed","text":"Hidden: a figure it is worked out from is hidden"}` | same |
| `revenue_per_paying_member_by_tier@1:audit` | `{"hidden":"suppressed","text":"Hidden: a figure it is worked out from is hidden"}` | same |

The preset has no rows after June. From atm's document: July to September are `{"hidden":"not_computed","text":"Not computed"}`, and October to December are embargoed ("Published after 7 Nov 2026", "7 Dec 2026", "7 Jan 2027"), because the gate runs before any value is read. One small plan costs two more: fellow fails, the complementary rule then hides the smallest other plan in each input split (audit's revenue, seminar's payer count), and rule 3 hides their ratios. Only scholar shows. `compare previousPeriod` for scholar in February is −375; for fellow it stays hidden.

**Member, quarter table:** every cell `{"hidden":"no_grant","text":"Governance and up see this"}`. atm's member document carries no `revenue_by_tier` series either.

**What D9 changes.** atm's governance document today uses the oracle rule: a plan's payers are estimated as round(revenue / `arpa`). For audit that is round(7200 / 2405) = 3, so atm hides `revenue_by_tier:audit` although the plan has 6 payers. Under that rule the custom cells would show scholar (3337.5, then 2962.5) and seminar (2560, then 2260). But the proposed `paying_members_by_tier:fellow` would print 1: the oracle rule counts the period's 20 paying members, and 20 passes. So the new measure cannot ship under the oracle rule.

### 8.2 Refund rate, trailing three months (`heavy-refunds`)

One paid invoice in five is refunded; the books run January to December 2026. Definition in section 2 (sha256 `ee7f610a…6494e5`). The capped rule takes `losses` (refunds) and `income` (gross collected): member gets total, quarter, 6 weeks; governance gets month, no delay; public has no `losses` rule.

**Governance, month table** (cell rules apply to breakdowns and spreads only, so a total is not ruled):

| Month | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov | Dec |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| trailing 3 months | NC | NC | 0.0974 | 0.0937 | 0.1677 | 0.1256 | 0.1678 | 0.1237 | 0.1994 | E 7 Nov 2026 | E 7 Dec 2026 | E 7 Jan 2027 |
| atm's `refund_rate` | 0.0667 | 0.1 | 0.1334 | 0.0474 | 0.3221 | 0 | 0.1719 | 0.1992 | 0.228 | E 7 Nov 2026 | E 7 Dec 2026 | E 7 Jan 2027 |

NC is `{"hidden":"not_computed","text":"Not computed: the window starts before the books"}`. E is `{"hidden":"embargoed","text":"Published after …"}`, taken from atm's document.

**Member, quarter table** (evaluated at quarter ends only, where the window is the quarter):

| Quarter | 2026-Q1 | 2026-Q2 | 2026-Q3 | 2026-Q4 |
| --- | --- | --- | --- | --- |
| trailing 3 months | 0.0974 | 0.1256 | `{"hidden":"embargoed","text":"Published after 18 Nov 2026"}` | `{"hidden":"embargoed","text":"Published after 18 Feb 2027"}` |

These equal atm's member `refund_rate` quarter cells exactly (the script checks it). Q1 is 16300 / 167300 and Q2 18700 / 148900. Both pass the cell rules either way D9 goes: the period's paying members are 24 and 21 (oracle rule); the refunds come from 10 and 9 distinct holders, the largest 0.178 and 0.155 of the refunds (per-cell rule). `compare previousPeriod` in Q2 is +0.0282; Q3 stays embargoed. `samePeriodLastYear` in Q1 is `{"hidden":"not_computed","text":"Not computed: no books for 2025-Q1"}`. The member document does show 2025-Q1 at 0.0974, but its note says the years before 2026 are invented from 2026's months.

**Why the member document never steps the window monthly.** The windows ending in April and May are not quarters, and consecutive windows difference to month figures:

```
  window 2026-01..2026-03: refunds 16300, gross 167300, rate 0.0974
  window 2026-02..2026-04: refunds 14450, gross 154200, rate 0.0937
  window 2026-03..2026-05: refunds 25450, gross 151800, rate 0.1677
  window 2026-04..2026-06: refunds 18700, gross 148900, rate 0.1256
  T(Apr) - T(Mar) of refunds = refunds(Apr) - refunds(Jan) = -1850 (2400 - 4250), a month-grain fact
  T(May) - T(Jun) of refunds = refunds(Mar) - refunds(Jun) = 6750; June had 0 in refunds, so a member who knows June was quiet learns March exactly (6750)
```

The member's $100 rounding blurs the money windows of a small school. It does not remove the leak: a large school's figures, or a rate (rates are not rounded), keep it. So the validator refuses the step (rule 6), not just the rounding.

### 8.3 A campaign total (fixture gifts, `b4u`)

Donors are fixture-only. The 62 gifts are the mockup's (`packages/ledger-ui/gates/mockup-schools.json` `donors.b4u`, 2026-01-01 to 2026-08-25). `fundraise.received` exists in the schema, but no preset has one. The measure is `donations_by_fund` (source `fixture`, dimension `campaign`, `ruleOf: revenue_by_tier`, so it takes the income breakdown rule). The document builds it from `context.donors`; the script pairs the gifts with the `monthly-members` preset's rows, as the oracle test does.

```json
{
	"id": "scholarships_campaign_total",
	"version": 1,
	"title": "Scholarships campaign",
	"description": "Gifts received for the Scholarships campaign, per month.",
	"model": "ledger.v1",
	"kpiSpec": "school.v1",
	"unit": "cents",
	"format": "money0",
	"compute": {
		"op": "value",
		"of": { "measure": "donations_by_fund", "where": { "campaign": "scholarships" } }
	}
}
```

`scholarships_campaign_to_date@1` is the same with `"window": { "toDate": "year" }`. Both are accepted (sha256 `e2e88dbf…2c7f` and `549fff5f…0b29`). Answer: public and member not shown ("Governance and up see this": the campaign filter needs `breakdown`, their income detail is `categories`); governance month, cell rules on; finance and owner live.

Gifts per month, January to September:

| Fund | Gifts | Cents |
| --- | --- | --- |
| scholarships | 3, 2, 2, 2, 3, 3, 3, 3, 0 | 34000, 23000, 18000, 11500, 258000, 96000, 56000, 45000, 0 |
| general | 5, 5, 6, 5, 5, 5, 4, 5, 0 | 93500, 63000, 147000, 94500, 73000, 48500, 38500, 175000, 0 |
| building-fund | 0, 1, 0, 0, 0, 0, 0, 0, 0 | 0, 500000, 0 … |

**Governance, design cells, January to September:**

| Series | Jan | Feb | Mar–Jun | Jul | Aug | Sep |
| --- | --- | --- | --- | --- | --- | --- |
| `scholarships_campaign_total@1` | S5 | S5 | S5 | S5 | S5 | `0` |
| `scholarships_campaign_to_date@1` | SΔ | `57000` | SΔ | `496500` | SΔ | SΔ |

S5 is `{"hidden":"suppressed","text":"Hidden: fewer than 5 donors"}`. SΔ is `{"hidden":"suppressed","text":"Hidden: the change since the last figure has fewer than 5 donors or one over 60%"}` (rule 7). February's 57000 is January and February together: 5 gifts, none over 60%. July's 496500 adds March to July: 13 gifts, the largest 250000 of 439500 (57%). A one-gift building fund month is S5.

**Finance and owner:** live, cell rules off: to date 34000, 57000, 75000, 86500, 344500, 440500, 496500, 541500, 541500. **Public and member:** every cell `{"hidden":"no_grant","text":"Governance and up see this"}`.

**What atm's document does today.** Governance's `donations_by_fund` is the year to date. Scholarships is hidden every month (fewer than 5 donors, one over 60%, or as the pair of the hidden building fund). General shows from February: 156500, 303500, 398000, 471000, 519500, 558000, 733000, 733000. Those consecutive figures difference to single months that fail the cell rules:

```
  donations_by_fund:general 2026-03: 303500 - 156500 = 147000, the month's 6 gift(s) [1000,2000,4000,5000,35000,100000]
  donations_by_fund:general 2026-04: 398000 - 303500 = 94500, the month's 5 gift(s) [1500,3500,4500,25000,60000]
  donations_by_fund:general 2026-05: 471000 - 398000 = 73000, the month's 5 gift(s) [1000,3000,4000,20000,45000]
  donations_by_fund:general 2026-06: 519500 - 471000 = 48500, the month's 5 gift(s) [500,2500,3500,12000,30000]
  donations_by_fund:general 2026-07: 558000 - 519500 = 38500, the month's 4 gift(s) [2500,3500,7500,25000]
  donations_by_fund:general 2026-08: 733000 - 558000 = 175000, the month's 5 gift(s) [2000,3000,5000,15000,150000]
```

July has 4 gifts; the other five months have one gift over 60% of the month. This is fixture data at governance, and the oracle does the same (the two documents are equal). It is the reason for rule 7, and decision 9 asks whether to fix the catalog table too.

### 8.4 Refused: membership revenue without the fellow plan (`one-payer-tier`)

```json
{
	"id": "membership_revenue_without_fellow",
	"version": 1,
	"title": "Membership revenue, fellow excluded",
	"description": "Gross collected less the fellow plan's revenue.",
	"model": "ledger.v1",
	"kpiSpec": "school.v1",
	"unit": "cents",
	"format": "money0",
	"compute": {
		"op": "sum",
		"terms": [
			{ "sign": 1, "of": { "measure": "gross_collected" } },
			{ "sign": -1, "of": { "measure": "revenue_by_tier", "where": { "tier": "fellow" } } }
		]
	}
}
```

```
validate membership_revenue_without_fellow@1: refused
  complementary_difference [revenue_by_tier:fellow]: subtracts revenue_by_tier:fellow from gross_collected, cells of one total (revenue_by_tier < revenue_by_kind:membership < gross_collected): the difference is the rest of the split, a cell the document may hide
```

What it would print at governance if it were allowed: in February `gross_collected` shows 48100 and `revenue_by_tier:fellow` shows `{"hidden":"suppressed","text":"Hidden: fewer than 5 payers"}`. The metric would show 42200, and 48100 − 42200 = 5900, the single fellow payer's payment. The same goes for `revenue_by_kind:membership − revenue_by_tier in [audit, scholar, seminar]` (`fellow_by_difference@1`, refused with the same code). The positive-only rewrite, `revenue_by_tier where tier in [audit, scholar, seminar]`, passes the static check. At evaluation its complement within `revenue_by_kind:membership` is 5900 from 1 payer, so rule 4 hides it: `{"hidden":"suppressed","text":"Hidden: hidden so the cell beside it can't be worked out from the total"}`.

Other refusals the script checks:

| Definition | Answer |
| --- | --- |
| `mrr` by tier | `unknown_term [mrr]`: "MRR is not computed: cash basis, a yearly payer counts in the month paid" (the document's `notComputed`) |
| `revenue` | `unknown_term [revenue]` (did you mean `gross_collected`?) |
| `paying_members` grouped by `tier`, on v1 | `dimension_not_carried` |
| `closing_balance_credits` by `account` | `personal` and `identity_dimension` (per-holder credit accounts; spec v3 export rule 1) |
| `refund_rate` over a trailing window | `rollup`: use its inputs (refunds, gross_collected) |
| `paying_members / gross_collected` | `unit_mismatch`: count / cents |

## 9. What phase 2 needs from the model

Checked against `packages/atm/model/ledger.v1.json` on 2026-11-06:

1. **No per-plan member count.** `paying_members` has no `tier`, and the spec has no way to add one (decision 3). `paying_members_by_tier` is the proposed v1.1 measure.
2. **No partition facts.** Nothing says `revenue_by_tier` adds up to `revenue_by_kind:membership` or `revenue_by_kind` to `gross_collected`. The static complementary check and rule 4 need `partitionOf`. It holds on 150 of 150 preset months.
3. **No contributor per measure.** The cell rules need to know whose holders count: payers for income, refunded holders for refunds, gifts for donations, providers for booking KPIs (spec v3 export rule 2b). Today the document counts the period's paying members for every figure. The model has no provider entity.
4. **The donor measures do not say what the document shows.** `donations_by_fund` is `grain: day, rollup: sum`, but the document's figure is a year-to-date running total. The document's fund ids are slugs of the fixture's titles (`building-fund`); the `Campaign` key is `payload.campaign` (`spring-appeal`), with no mapping between them. There is no donations total to partition. `donors_count` counts gifts, not donors, under the name "Donors".
5. **The schema cannot express a revision.** `model.v1.json` fixes `version: 1`, `id: "ledger.v1"` and `kpiSpec: "school.v1"` as constants, so a v1.1 needs a schema change before any pin can name it.
6. **No measure fingerprint.** Staleness (section 6) needs a stable hash per resolved measure; `bun model/build.ts` could generate it.
7. **Relationships no measure uses.** `refund_payment` and `payment_tier` exist, but no measure carries `tier` for refunds or payment counts, so "refund rate by plan" is not answerable. A spec join op would be new; a `tier` label on refund events would not.

## 10. Open decisions

1. **Where definitions live.** Options: atm catalog next to the model; buzz-school per school; R2 beside the views. Default: the atm catalog, with each school's selection (ids only) in buzz-school next to the disclosure override.
2. **Who may author.** Options: B4 Uni only; schools draft and B4 Uni publishes; schools publish. Default: B4 Uni authors and publishes; schools pick from the catalog. School drafts later, through the same CI.
3. **Distinct-by-account as a spec op.** Options: (a) allow `distinct` split by account when the `where` selects at most one posting per event, and a channel refuses an event with two; (b) a `tier` label on membership payments, which the spec already allows for `distinct` (needs the event producer, S8d, and leaves old events out); (c) no per-plan member counts. Default: (a), because it works on the events already in the log (1910 of 1910 preset membership payments have one membership posting). All three channels must implement it.
4. **D9 and custom cells.** Options: per-cell holders (spec); the period's paying members (oracle `bkFig`). Default: custom cells use per-cell holders from the start, whatever the catalog does. `paying_members_by_tier` cannot ship under the oracle rule (it would print the fellow plan's 1). The oracle rule also hides `revenue_by_tier:audit` on `one-payer-tier` although the plan has 6 payers.
5. **Custom metrics in the disclosure file's `classes`.** Options: not listed, always derived from the inputs; listed, and a school may move one to a stricter class only. Default: not listed. A school that wants one stricter turns it off.
6. **OpenAPI and JSON-LD.** Options: mint IRIs `<namespace>metric/<id>@<version>` in the generated JSON-LD context and tag custom series with `x-measure`; expose nothing until a reader asks. Default: mint the IRIs and add `x-measure` on custom series ids in the generated OpenAPI components; no per-metric path.
7. **Apache Ossie (Open Semantic Interchange) export.** Options: export the catalog's definitions, never figures, with the disclosure as metadata; defer. Default: defer until the catalog has a handful of published definitions.
8. **Limits.** Default: 50 enabled metrics per school, 6 terms, one dimension, windows up to 24 months, one comparison. The Worker's cost is small (terms × periods × values over monthly rows). The views job's cost is the contributions for windows and partial sums, which grows with every enabled metric.
9. **The catalog's year-to-date donor table.** Options: apply rule 7 to it; show donations per month instead; leave it, since donors are fixture-only. Default: apply rule 7 in the oracle first, then in `kpiDocument` (the D9 path). It must be fixed before real donations are booked.
10. **Model revisions.** Options: additive minor revisions (`ledger.v1.1`) that keep every v1 definition valid when its fingerprints are unchanged; a new major per change. Default: additive minors, with the schema constants loosened to a pattern.
