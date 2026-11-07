# Dashboards over the KPI document (design)

Status: draft, 2026-11-06. Design only; nothing here ships. This is the sibling of [`custom-metrics.md`](custom-metrics.md): a custom metric adds a series to the KPI document, and a dashboard chooses how to show series that are already in it. This file reuses that file's terms (the definition pins, `answerable`, the error codes, the catalog) and links to them; it does not restate them.

The owner's question: how do people make a dashboard and put it on their own site, easily, without a new way around the disclosure?

The figures in section 2 come from the real `kpiDocument` of `atm/worker`, run on the mart snapshot rows (`plans/ledger-ui/design/mart/kpis/<preset>.json.gz`) with the UI's disclosure fixture (school `b4u`, small, no override) and the oracle test's clock (`today 2026-11-05`). These are the inputs [`worked-examples.ts`](worked-examples.ts) uses. They were computed for this file by a throwaway script that is not checked in. Build step 1 (section 10) adds them to a script.

## 1. Scope and the one rule

A dashboard is a named, versioned layout of tiles. Each tile shows one series of the KPI document, or one family of series, as a number, a small chart or a table.

**The one rule: a dashboard reads the KPI document and nothing else.** The document comes from the Worker, which has already applied the disclosure for one audience (audience, delay, rounding, grain, detail, the cell rules and the complementary rule). The browser never gets books, events or rows. The renderer computes no figure: it does not add, subtract, average or difference cells. A number on screen is `cellText` of a cell the document holds, or it is not shown.

Not in scope:

- New figures. A tile that needs a figure the document lacks needs a catalog KPI or a custom metric first.
- Finance and owner analysis tools. Those are section 8.

Why no BI tool for the school-facing audiences: Metabase, Superset and Cube filter by row (row-level security). The disclosure here works per cell. A school's figure hides when the period has fewer than 5 paying members (decision D9, `S8-contract.md`). A plan's cell hides so that it can't be worked out from the total and the cells beside it. Months are delayed and money is rounded per audience. A BI tool that queries the books would apply a row filter and skip all of that. Cube's row-level security is a signed security context checked in the semantic layer ([Cube security context](https://cube.dev/docs/product/auth/context), [Cube embedded analytics](https://cube.dev/embedded-analytics)). Superset's is per dataset, with guest tokens ([Databrain](https://www.usedatabrain.com/blog/apache-superset-alternatives)). Metabase's per-tenant row-level security is an Enterprise feature, and limited ([Knowi](https://www.knowi.com/blog/metabase-alternatives/)). None of them has a "this cell hides because the cell beside it would give it away" rule.

## 2. The definition: `dashboard.v1.json`

A dashboard is one JSON object:

| Part | What it says |
| --- | --- |
| `id`, `version`, `title`, `description` | as a custom metric; its address is `id@version` |
| `model`, `kpiSpec` | the pins it was validated against (`ledger.v1`, `school.v1`) |
| `audience` | the floor: the lowest audience the Worker serves it to |
| `grain`, `period` | the dashboard's grain (`year`, `quarter`, `month`) and its period: `latest` or a fixed `YYYY`, `YYYY-Qn`, `YYYY-MM` |
| `tiles` | 1 to 12 tiles, laid out in order on a 12-column grid (`width` 3, 4, 6 or 12) |
| tile `show` | `{ measure }`: a model measure (`ledger:gross_collected` in the model's JSON-LD), or `{ metric: "<id>@<version>" }`: a catalog custom metric. `value` picks one dimension value (`revenue_by_tier`, `value: "scholar"`) |
| tile `by` | one dimension of the measure, for `breakdown` and `table` |
| tile `chart` | one of `stat`, `sparkline`, `line`, `bar`, `breakdown` (a bar list), `table` |
| tile `grain`, `periods` | for charts and tables over time: the tile's grain (default the dashboard's) and how many periods, ending with the dashboard's period |
| tile `compare` | `previousPeriod` or `samePeriodLastYear`, read from the document's changes (section 3), never computed |
| tile `headline` | for a sparkline: `latest` (its last point) or `periodTotal` (the dashboard period's own cell) |

`latest` is the latest period, at the dashboard's grain, whose strip periods (`KpiDocument.periods`) are all `shown`. Choosing a period is not a figure, so the renderer may work it out from the strip.

### JSON Schema sketch (`schema/dashboard.v1.json`, in the style of `kpis.v1.json`)

```json
{
	"$schema": "https://json-schema.org/draft/2020-12/schema",
	"$id": "https://b4uni.com/_schema/dashboard.v1.json",
	"title": "Dashboard v1",
	"description": "A layout of tiles over one school's KPI document. Every tile names a measure of the pinned model or a catalog custom metric (id@version) and a chart kind from a closed list. The renderer reads the document the Worker built for the viewer's audience and computes no figure. Published definitions are immutable: a change is a new version.",
	"type": "object",
	"required": ["id", "version", "title", "model", "kpiSpec", "audience", "grain", "period", "tiles"],
	"additionalProperties": false,
	"properties": {
		"$schema": { "type": "string" },
		"id": { "$ref": "#/$defs/snakeId" },
		"version": { "type": "integer", "minimum": 1 },
		"title": { "type": "string", "minLength": 1, "maxLength": 80 },
		"description": { "type": "string", "maxLength": 280 },
		"model": { "type": "string", "pattern": "^ledger\\.v[0-9]+(\\.[0-9]+)?$" },
		"kpiSpec": { "type": "string", "pattern": "^school\\.v[0-9]+(\\.[0-9]+)?$" },
		"audience": {
			"enum": ["public", "member", "governance", "finance", "owner"],
			"description": "The floor. Below it the Worker serves no document for this dashboard."
		},
		"grain": { "enum": ["year", "quarter", "month"] },
		"period": {
			"oneOf": [
				{ "const": "latest" },
				{ "type": "string", "pattern": "^[0-9]{4}(-Q[1-4]|-(0[1-9]|1[0-2]))?$" }
			],
			"description": "latest: the last period of the dashboard's grain whose strip periods are all shown."
		},
		"tiles": { "type": "array", "minItems": 1, "maxItems": 12, "items": { "$ref": "#/$defs/tile" } }
	},
	"$defs": {
		"snakeId": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,59}$" },
		"value": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{0,59}$" },
		"metricRef": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,59}@[1-9][0-9]{0,5}$" },
		"show": {
			"oneOf": [
				{
					"type": "object",
					"required": ["measure"],
					"additionalProperties": false,
					"properties": { "measure": { "$ref": "#/$defs/snakeId" }, "value": { "$ref": "#/$defs/value" } }
				},
				{
					"type": "object",
					"required": ["metric"],
					"additionalProperties": false,
					"properties": { "metric": { "$ref": "#/$defs/metricRef" }, "value": { "$ref": "#/$defs/value" } }
				}
			]
		},
		"tile": {
			"type": "object",
			"required": ["id", "show", "chart"],
			"additionalProperties": false,
			"properties": {
				"id": { "$ref": "#/$defs/snakeId" },
				"title": { "type": "string", "minLength": 1, "maxLength": 60, "description": "Absent: the document's meta title." },
				"show": { "$ref": "#/$defs/show" },
				"by": { "$ref": "#/$defs/snakeId", "description": "A dimension the measure carries; breakdown and table only." },
				"chart": { "enum": ["stat", "sparkline", "line", "bar", "breakdown", "table"] },
				"grain": { "enum": ["year", "quarter", "month"] },
				"periods": { "type": "integer", "minimum": 2, "maximum": 24 },
				"compare": { "enum": ["previousPeriod", "samePeriodLastYear"] },
				"headline": { "enum": ["latest", "periodTotal"] },
				"width": { "enum": [3, 4, 6, 12] }
			}
		}
	}
}
```

As for metrics, the schema checks shape only. In the Worker it is a precompiled validator or none (custom-metrics section 2).

### How a tile shows each kind of cell

| Cell | Stat tile | Chart point | Table cell |
| --- | --- | --- | --- |
| number | `figureText` in the meta format | drawn | figure |
| `{lt}` | `<10` or "under $100", with its `why` on the line below | not drawn: a gap with a low stub | text, `why` in a footnote |
| `{approx}` | the rounded count, with its `why` | not drawn | text, `why` in a footnote |
| `suppressed` | "—", with the reason visible below ("Hidden: fewer than 5 payers") | not drawn, the column hatched | "—", the reason in a footnote |
| `embargoed` | clock icon, "Published after 7 Jan 2027" | hatched | the text |
| `members_only`, `no_grant` | lock icon, "Members see this", "Governance and up see this", "Finance admins and the owner see this" | none | the text |
| `not_computed`, `future`, `locked` | "Not computed", "not yet", "Locked" | gap | the text |

A tile is never blank, and a non-number is never drawn as 0. Today's UI puts a suppressed cell's reason in the `title` attribute. Tiles show the reason as visible text too, because a `title` is not read by most screen readers.

A period the document marks `invented` (`DocumentPeriod.invented`, `KpiMeta.invented`) carries an "Invented" badge on every tile that shows it. The document's caption for the period's year is the dashboard's footnote, so readers see the rules it was built with.

### Example 1: "Our year in numbers" (public)

```json
{
	"id": "our_year_in_numbers",
	"version": 1,
	"title": "Our year in numbers",
	"description": "Income, members and payments for the last published year.",
	"model": "ledger.v1",
	"kpiSpec": "school.v1",
	"audience": "public",
	"grain": "year",
	"period": "latest",
	"tiles": [
		{ "id": "gross", "show": { "measure": "gross_collected" }, "chart": "stat", "compare": "previousPeriod", "width": 3 },
		{ "id": "members", "show": { "measure": "paying_members" }, "chart": "stat", "width": 3 },
		{ "id": "new_members", "show": { "measure": "new_paying_members" }, "chart": "stat", "width": 3 },
		{ "id": "payments", "show": { "measure": "payments_count" }, "chart": "stat", "width": 3 },
		{ "id": "members_by_quarter", "show": { "measure": "paying_members" }, "chart": "sparkline", "grain": "quarter", "periods": 4, "headline": "latest", "width": 4 },
		{ "id": "income_by_kind", "show": { "measure": "revenue_by_kind" }, "by": "kind", "chart": "breakdown", "width": 4 },
		{ "id": "refund_rate", "show": { "measure": "refund_rate" }, "chart": "stat", "width": 4 }
	]
}
```

The validator accepts it, with one warning: `refund_rate` is not shown at the floor (section 3).

What each audience sees on 2026-11-05 (preset `heavy-refunds`, and `tiny-school` for the suppressed cells):

| Tile | Public (period 2024) | Public, `tiny-school` | Member (period 2025) |
| --- | --- | --- | --- |
| `gross` | $3,400, Invented; no comparison (no 2023 in the document) | "—", "Hidden: fewer than 5 payers" | $4,900, Invented; no comparison |
| `members` | 14 | `<10`, "fewer than 5 payers" | 20 |
| `new_members` | 14 | `<10`, "fewer than 5 payers" | 20 |
| `payments` | 140 | 10 (`approx`), "fewer than 5 payers" | 199 |
| `members_by_quarter` | 14, 12, 12, 10 (2024-Q1 to Q4), headline 10 | no point drawn: `<10`, `<10`, "Not computed", "Not computed"; the table view lists them; headline "Not computed" | 20, 17, 16, 15 (2025-Q1 to Q4) |
| `income_by_kind` | Memberships $3,400 (one row) | Memberships "—", "Hidden: fewer than 5 payers" | Memberships $4,900 |
| `refund_rate` | lock, "Members see this" | lock, "Members see this" | 14.7%, Invented |

Two facts in this table come from the document as it is today:

- **The public's only published year is invented.** Public income is published 12 months after the year closes. So 2026 reads "Published after 7 Jan 2028" and 2025 reads "Published after 7 Jan 2027", which leaves 2024. `kpiDocument` invents 2024 and 2025 from 2026's months (`yearScale`). It does this for every school, not only for fixtures, because `sourceOf` reads only the current year's rows. The member's 2025 is invented the same way. Decision 6.
- **Governance, finance and owner get no year table.** Their documents have only `month` (and `day` when live). Today every tile of this board would read "Not computed" for them. Decision 2.

### Example 2: "Monthly books" (governance)

```json
{
	"id": "monthly_books",
	"version": 1,
	"title": "Monthly books",
	"description": "Money in, refunds and members, month by month, with income by plan.",
	"model": "ledger.v1",
	"kpiSpec": "school.v1",
	"audience": "governance",
	"grain": "month",
	"period": "latest",
	"tiles": [
		{ "id": "gross", "show": { "measure": "gross_collected" }, "chart": "stat", "compare": "previousPeriod", "width": 4 },
		{ "id": "refund_rate", "show": { "measure": "refund_rate" }, "chart": "stat", "width": 4 },
		{ "id": "members", "show": { "measure": "paying_members" }, "chart": "stat", "compare": "previousPeriod", "width": 4 },
		{ "id": "gross_trend", "show": { "measure": "gross_collected" }, "chart": "line", "periods": 12, "width": 6 },
		{ "id": "income_by_plan", "show": { "measure": "revenue_by_tier" }, "by": "tier", "chart": "breakdown", "width": 6 },
		{ "id": "plans_by_month", "show": { "measure": "revenue_by_tier" }, "by": "tier", "chart": "table", "periods": 6, "width": 12 }
	]
}
```

Preset `one-payer-tier`: 20 families on four plans, books from January to June 2026, and the fellow plan has one payer. The table is for `period="2026-06"` (the embed's `period` attribute). With `latest`, the board would show September, whose cells read "Not computed" because the preset has no rows after June.

| Tile | Public, member | Governance (June 2026) | Finance, owner (June 2026) |
| --- | --- | --- | --- |
| whole board | not served: "Governance and up see this" | | |
| `gross` | | $481.00, "Same as May" | $481.00, "Same as May" |
| `refund_rate` | | 0.0%, with no comparison (the document has no change for rates) | 0.0% |
| `members` | | 20, "Same as May" | 20, "Same as May" |
| `gross_trend` | | Jan $566.00, then $481.00 to June; July to September gaps ("Not computed"); October to December hatched ("Published after 7 Nov 2026", "7 Dec 2026", "7 Jan 2027") | the same to June; July to November "Not computed"; December "Not computed" (the strip calls it "Not started yet") |
| `income_by_plan` | | Scholar $237, Seminar $113, Fellow "—", Audit "—"; reason line "Fellow: fewer than 5 payers · Audit: fewer than 5 payers" | Scholar $237, Fellow $59, Seminar $113, Audit $72 |
| `plans_by_month` | | Scholar $267, then $237; Seminar $128, then $113; Fellow and Audit "—" in every month, with one footnote | every cell a figure |

In February, `gross` reads "▼ $85 vs Jan" (the document's change, −8500). Audit hides at governance although the plan has 6 payers. This is the D9 rule as decided: a plan's payers are estimated as its revenue over the average per paying member, here round(7200 / 2405) = 3 (custom-metrics 8.1, "What D9 changes"). If the floor were lowered to member, every tile would read "Governance and up see this". That is the member document's own text for a month cell, and the document carries no `revenue_by_tier` series for member at all (decision 3).

## 3. Validation

The validator runs before any data is read. It needs the model, the KPI spec, the custom-metric catalog and the disclosure file, and it returns every problem at once, as custom-metrics section 3 does.

Reused codes: `unknown_term` (with the model's synonyms and the document's `notComputed` reasons), `dimension_not_carried`, `identity_dimension`, `personal`, `stale` (a pinned metric or a measure fingerprint changed).

Dashboard codes:

| Code | Refused when | Example |
| --- | --- | --- |
| `unknown_chart` | the kind is not in the list | `pie` → "pie is not a chart kind; for parts of a total use breakdown" |
| `chart_unit` | the kind does not fit the unit | a `breakdown` of a ratio (rates by plan are not parts of a whole); a `bar` of a rate (use `line`) |
| `chart_rollup` | the kind or headline does not fit the rollup | `headline: periodTotal` on `paying_members` (rollup `max`: a year's cell is its busiest month, not a total; use `latest`); a `breakdown` of a measure without `partitionOf` (custom-metrics section 3) |
| `dimension_required` | `breakdown` with no `by` | |
| `dimension_not_allowed` | `by` on `stat`, `sparkline`, `line` or `bar` (use `show.value` for one value) | |
| `too_many_tiles` | more than 12 tiles, or a row wider than 12 columns after wrapping | |
| `duplicate_tile` | two tiles with one `id` | |
| `field_not_allowed` | `periods` or `headline` on a `stat` or `breakdown`, `compare` on a chart over time | |
| `identity_audience` | the floor is `finance` or `owner` on a dashboard marked embeddable (section 5) | |

Warnings, which are accepted but shown to the author before publication:

| Code | When | Example |
| --- | --- | --- |
| `not_shown_at_floor` | `answerable` says a tile is not shown at the floor | `refund_rate` on a public board: "public: not shown → Members see this" |
| `no_comparison` | the document carries no change for the tile's series at an audience | a rate; any quarter or year table today (decision 4) |

`answerable` is custom-metrics' check, applied to each tile at each audience from the floor up:

```
validate our_year_in_numbers@1: accepted, 1 warning
  public: 6 of 7 tiles shown; refund_rate -> {"hidden":"members_only","text":"Members see this"}
  member: 7 of 7
  governance, finance, owner: 7 of 7 once month documents carry a year table (decision 2); today none
  warning not_shown_at_floor [refund_rate]: public reads "Members see this"
  definition sha256 <computed at publication>
```

## 4. Rendering in ledger-ui

ledger-ui is Preact 10.29.8 on Vite (`packages/ledger-ui/package.json`). The size gate measures first-load gzip bytes: the entry chunk, its static imports and their CSS. The last recorded size is 22,256 B (S2 to S7). The next slice may grow by 10%, to 24,481 B, under a ceiling of 30,720 B (`gates/budget.json`). That leaves about 2.2 KB.

What is reused. `Dashboard` already draws everything the tiles need, from the same document:

| Tile | Today's code (`src/app/`) |
| --- | --- |
| `stat` | `Card`, `Change` (`dashboard.tsx`), `KpiValue`, `cellText`, `figureText` (`kpi-cell.tsx`) |
| `breakdown` | `Breakdown` and `Reasons` |
| `line`, `bar` | `Line`, `Bars`, `Axis`, `Column` (SVG, scaled to the largest number shown, a tooltip per column) |
| `table` | `SeriesRows`, plus a plain `<table>` |
| `sparkline` | new: `Line` without axis or threshold, about 40 lines |

These components take `Books` (the dashboard's state) today. Step 3 moves them to `src/app/tiles/`, with props `(document, grain, kpi, period)`, and `Dashboard` calls them from there. The shared code moves rather than grows. The new code is the sparkline, the stat layout and the grid, under 1 KB gzip. The authoring view (catalog, preview, embed snippet) is a lazy chunk, so it does not count toward the first load. Colors are the theme's `--chart-1` to `--chart-5`.

The visual patterns are Tremor's and shadcn's: stat cards with a delta line, sparklines and bar lists. Their code is not used, because it is React plus Recharts, a dependency stack ledger-ui does not carry ([PkgPulse comparison](https://www.pkgpulse.com/guides/recharts-v3-vs-tremor-vs-nivo-react-charting-2026)).

**Why not the Vega-Lite runtime.** Measured from jsDelivr on 2026-11-06: `vega` 6.4.0's `vega.min.js` is 179,615 B gzip, and `vega-lite.min.js` is 81,919 B. Together that is about 261 KB, ten times ledger-ui's whole first-load budget. Six chart kinds over cells that are already computed need none of Vega's data flow. It could come back for finance-only exploratory views (section 8), loaded on demand behind the finance sign-in, where the first-load budget does not apply and cell rules are off.

## 5. Embedding

### The element

```html
<script type="module" src="https://embed.b4uni.com/v1/trifold-dashboard.js"></script>
<trifold-dashboard school="sch_before_university" dashboard="our_year_in_numbers@1"></trifold-dashboard>

<!-- Members or governance: the token comes from the school's server -->
<trifold-dashboard school="sch_before_university" dashboard="monthly_books@1" token="eyJ..." period="2026-06" theme="auto"></trifold-dashboard>
```

| Attribute | Meaning |
| --- | --- |
| `school`, `dashboard` | the school id and `id@version`. A version is required, so a host never changes meaning silently |
| `token` | absent: the public audience. Present: an embed token (below). The `tokenProvider` property (a function returning a promise of a token) refreshes it before `exp` |
| `period` | optional; the spec's `period` otherwise |
| `theme` | `light`, `dark` or `auto` |

The element is a separate Vite entry, built from the same tile components: Preact (4,827 B gzip, measured from `preact.min.js`), the tiles and a fetch. Proposed budget: 12 KB gzip, in its own gate. It renders into an open shadow root. The host's CSS cannot reach inside, and the document's own texts, including every "Hidden: …", are shown exactly as in ledger-ui.

The pattern is Luzmo's: the customer's backend makes a short-lived embed authorization with its secret key, and the page passes the result to a web component (`<luzmo-embed-dashboard authKey authToken>`) ([Luzmo: generating an authorization token](https://developer.luzmo.com/guide/dashboard-embedding--generating-an-authorization-token), [Luzmo: embed into an application](https://developer.luzmo.com/guide/dashboard-embedding--embed-into-application)). Here, the data never leaves the Worker for a vendor.

**Iframe fallback**, for hosts that cannot add a script: `<iframe src="https://embed.b4uni.com/v1/d/<school>/<id>@<version>" sandbox="allow-scripts allow-same-origin" title="…">`. `allow-same-origin` is safe here because the frame's origin is `embed.b4uni.com`, never the host's. A token is sent with `postMessage` after load, never in the URL, where it would end up in logs. The embed page sets `frame-ancestors` to the school's embed origins.

### The token

buzz-school, the school's server, already knows who is signed in and at what level, and it already mints the ledger token. It mints the embed token too:

| Claim | Value |
| --- | --- |
| `alg`, `kid`, `iss` | as the ledger token: EdDSA, the same `/.well-known/ledger-jwks.json`, `iss` the environment's `API_BASE` |
| `aud` | `atm-embed`, a different audience from `atm-ledger`, so neither token is accepted where the other is. Rename step 3 (`plans/tfd-rename.md`) adds `tfd-embed`, and both are accepted during the window |
| `school`, `dashboard` | one school and one `id@version` |
| `audience` | `member` or `governance`: at most the signed-in person's audience, and at least the dashboard's floor |
| `iat`, `exp` | `exp − iat ≤ 300`, as the ledger token |

Finance and owner are never embedded. Their documents carry names, and every identified read is audited (the document's own caption). They use ledger-ui.

### The Worker route (an addition to S8c)

`GET /v1/schools/<school>/dashboards/<id>@<version>?period=<p>`

- No `Authorization` header: the public audience. This works only if the school has enabled the dashboard as public (section 7); otherwise 404, the same answer as an unknown school.
- `Authorization: Bearer <embed token>`, or the ledger token from ledger-ui: the claimed audience. The token's `dashboard` must equal the path.
- Response: `{ definition: { id, version, sha256 }, dashboard, document, asOf }`. `document` is `kpiDocument` for that audience, built whole (so the complementary rule sees every split) and then pruned to the tiles' series, `periods`, `captions`, `notes` and their `meta`.

### Caching

Below finance, a document holds no identity, so every viewer of one audience gets the same bytes. The key is `(school, dashboard@version, audience, manifest asOf, today)`. `today` is in the key because the "Published after …" dates are days.

| Audience | Headers | Worker cache |
| --- | --- | --- |
| public | `Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`; `ETag` the sha256 of the canonical response; `Access-Control-Allow-Origin: *` | Cache API, by the key |
| member, governance | `Cache-Control: private, max-age=60`; `Vary: Authorization`; CORS for the school's embed origins only | Cache API, by the key, after the token is verified |

### CSP for the host

`script-src https://embed.b4uni.com; style-src https://embed.b4uni.com; connect-src <the Worker origin>`. The element needs no `eval`, no inline script and no inline `<style>`. Its stylesheet is a file on the same origin, linked inside the shadow root. Preact's style properties are set through the CSSOM, which `style-src` does not block. Versioned files (`/v1.3.0/trifold-dashboard.js`) are immutable and can carry `integrity`. `/v1/` floats.

### Theming

Theming is through CSS custom properties only, which reach through the shadow root. No arbitrary CSS and no `::part`.

| Property | Default (ledger-ui `theme.css`) |
| --- | --- |
| `--tfd-font` | `--font-sans` |
| `--tfd-background`, `--tfd-foreground`, `--tfd-muted`, `--tfd-border` | `--card`, `--foreground`, `--muted-foreground`, `--border` |
| `--tfd-accent` | `--primary` |
| `--tfd-chart-1` to `--tfd-chart-5` | `--chart-1` to `--chart-5` |
| `--tfd-radius` | `--radius` |

Hidden-cell texts use `--tfd-muted`. The authoring view checks a theme's contrast before giving out a snippet, because a host could make "Hidden: fewer than 5 payers" unreadable.

### Accessibility

- Every chart is an `<svg role="img">` with a label that names the series and the period range. A "Show as table" button under it switches to a real `<table>` with the same cell texts, hidden reasons included. Today's chart tooltips are SVG `<title>`s, which a keyboard cannot reach.
- Every control is a `<button>` in tab order, and the element traps no focus. Embargoed and hidden cells carry a text, a pattern and an icon, never color alone. Nothing animates.
- The element sets `lang` from the host and reads the caption as its footnote.

## 6. Drafting with an LLM

A person types a sentence: "Show families how the year went: income by kind, how many members, and refunds." An LLM drafts a `dashboard.v1.json` and the validator accepts or refuses it. No LLM writes a figure, sees a document or runs code.

1. **Prompt in.** The model's measures and dimensions (id, title, synonyms, format, rollup, the dimensions each carries), the catalog's custom metrics (id@version, title, description), the chart list with its fit rules, the floor the author picked, and the schema. No school data.
2. **Spec out.** JSON constrained to the schema (structured output or a tool's input schema).
3. **Validator.** Its errors, with codes, go back to the model for at most two repair rounds. This is VegaChat's loop: declarative Vega-Lite specs, checked against the schema and heuristics, with feedback to the model, which the authors argue is safer and easier to edit than generated code ([VegaChat](https://arxiv.org/html/2601.15385v1)). chat2plot makes the same choice: the LLM writes a JSON plot spec, not Python, "more secure execution, as LLM does not directly generate code" ([chat2plot](https://pypi.org/project/chat2plot/0.0.9/)).
4. **Refusals the author sees**, in the validator's words:

| Asked | Answer |
| --- | --- |
| "MRR by plan" | `unknown_term [mrr]`: "MRR is not computed: cash basis, a yearly payer counts in the month paid" |
| "members per plan" | `dimension_not_carried`: paying_members has no tier dimension (custom-metrics 8.1 proposes `paying_members_by_tier`) |
| "a pie of refund rate by plan" | `unknown_chart [pie]`, and `chart_unit`: a rate does not split into parts of a total |
| "each family's balance" | `personal`, `identity_dimension` |
| "refunds" on a public board | accepted, with `not_shown_at_floor`: public reads "Members see this" |

5. **Preview.** ledger-ui renders the draft against the documents it already has: the author's own and the "View as" audiences below it. The draft is not stored by the Worker. Publication follows custom-metrics decision 2: B4 Uni reviews and publishes into the catalog.

## 7. Storage and versioning

This follows custom-metrics section 7, option A.

- **Catalog.** B4 Uni-wide templates live in `packages/atm/dashboards/<id>@<version>.json` (under `packages/tfd/` after rename step 4), beside the metric catalog, and are imported as JSON. CI validates each one against the model and renders it on the 15 presets × 5 audiences. It asserts that every tile shows a figure or a document text, and that every number on screen is the `cellText` of a document cell: the "no figure invented" gate.
- **A school's choice.** Stored in buzz-school next to the disclosure override (`school_books_disclosure`), as references only:

```json
{ "dashboards": [{ "ref": "our_year_in_numbers@1", "public": true, "origins": ["https://www.beforeuniversity.org"] }] }
```

- **Immutability.** A published `id@version` never changes. Its sha256 is computed over canonical JSON (`canonicalize`, keys sorted) and goes in the response's `definition` and in the `ETag`. A tile pins a custom metric by `id@version`. If that metric goes `stale`, the tile shows the metric's own cell, "Not computed: definition stale" (custom-metrics section 6). When the model changes, CI revalidates every dashboard. A tile whose measure is renamed makes the dashboard `stale`, and it is never re-pointed silently.

## 8. Finance and owner: BI as code

Finance and the owner see everything live, with cell rules off. There is no disclosure to bypass, so a BI tool is fine for their own analysis, as long as it stays behind their sign-in. Two tools fit atm's existing DuckDB and Parquet outputs: the `kpis.parquet` long format (`profile, kpi_id, period, value, unit`, `docs/scenarios.md`) and the envelope table (`schema/duckdb/envelope.v1.sql`). The case for BI as code on DuckDB is made in [MotherDuck](https://motherduck.com/blog/the-future-of-bi-bi-as-code-duckdb-impact.md) and [Evidence](https://evidence.dev/blog/business-intelligence-tools).

- **Evidence**: Markdown pages with SQL blocks, built to a static site. It suits fixed monthly reports.
- **Rill**: metrics views in YAML over DuckDB, with exploration. A Rill project can be generated from the model, so it does not become a second, hand-written meaning of each KPI:

```yaml
# generated from ledger.v1 by `tfd dashboard rill` (sketch; check against https://docs.rilldata.com/reference/project-files/metrics-views)
type: metrics_view
model: kpi_rows            # kpis.parquet: kpi_id, period, value
timeseries: period_date    # period as a date
dimensions:
  - name: tier
    expression: "CASE WHEN kpi_id LIKE 'revenue_by_tier:%' THEN split_part(kpi_id, ':', 2) END"
measures:
  - name: gross_collected            # rollup sum
    expression: "SUM(value) FILTER (WHERE kpi_id = 'gross_collected')"
  - name: paying_members             # rollup max: the most in one month, as figureOf
    expression: "MAX(value) FILTER (WHERE kpi_id = 'paying_members')"
  - name: refund_rate                # rollup recompute: from its inputs, never summed
    expression: "SUM(value) FILTER (WHERE kpi_id = 'refunds') / NULLIF(SUM(value) FILTER (WHERE kpi_id = 'gross_collected'), 0)"
```

A parity test on the presets holds the generated measures to the document's finance cells, as DuckDB is held to the atm fold today. Either tool is served only behind the finance or owner sign-in (the ledger token with `finance: true`, or Cloudflare Access), never from `embed.b4uni.com`.

## 9. Ruled out

| Option | Why not |
| --- | --- |
| Metabase | Row-level, not per cell. Per-tenant row-level security is Enterprise and limited ([Knowi](https://www.knowi.com/blog/metabase-alternatives/)). It would query the books. |
| Superset | Row-level security per dataset, with guest tokens ([Databrain](https://www.usedatabrain.com/blog/apache-superset-alternatives)). The same gap, plus a Python service to run. |
| Cube as the source of truth | A good semantic layer, but its security context filters rows ([Cube](https://cube.dev/docs/product/auth/context)). It would be a second implementation of the KPI math and of the disclosure. It could sit downstream for finance only. |
| Luzmo, Embeddable | Paid and closed, and the data leaves the Worker for the vendor. Their row-level security is row-level. Luzmo's token pattern is borrowed. |
| Explo | A competitor's page claims Explo was acquired and sunset. That is not confirmed here. Either way it is paid and closed. |
| Vega-Lite runtime | About 261 KB gzip (section 4). Possible later for finance-only exploration. |
| React plus Recharts or Tremor | ledger-ui is Preact. Borrow the look, not the stack. |
| LLM-written chart code | It can't be validated against the model, and it runs. Specs only (section 6). |
| Adding up cells in the browser | Any sum, difference or average the renderer makes is a figure the document did not certify, and it can undo a hidden cell. |

## 10. Build order and open decisions

1. **Spec and validator** in the Trifold engine: the schema, the model checks, `answerable` per tile and the chart fit rules. `tfd dashboard validate <file>`, the two examples above in the catalog, and a script that prints section 2's tables.
2. **Document changes** for decisions 2, 3, 4 and 6, in `kpiDocument` and the oracle together. They must stay equal.
3. **Three tile components** in ledger-ui: `stat`, `breakdown`, `sparkline`, extracted from `dashboard.tsx`, then `line`, `bar` and `table`. A Dashboards view with a "View as" preview. Inside the size budget.
4. **The S8c route, the embed token and the element**: buzz-school's mint endpoint, the custom element, the iframe page, and Miniflare tests over the seeded presets, including the "no figure invented" gate on the element's output.
5. **LLM drafting** in the authoring view.
6. **Optional**: the Rill export (`tfd dashboard rill`).

### Open decisions

1. **Where dashboards live and who authors them.** Options: the catalog in the repo; per school in buzz-school; schools draft and B4 Uni publishes. Default: the catalog, with each school's choice (references, the public flag, embed origins) in buzz-school beside the disclosure override; school drafts later, through the same CI.
2. **Coarser tables for month documents.** Governance, finance and owner documents have only month (and day) tables, so a year or quarter tile has nothing to read. Options: (a) the Worker adds year and quarter tables to every document, under the same gate; (b) dashboards stay at the audience's own grain; (c) the renderer adds months up (refused, section 9). Default: (a).
3. **Series the document leaves out.** Below governance the document carries no `revenue_by_tier` or donor series, so a tile has no hidden text to show. Options: (a) the document carries a `withheld` entry per left-out family, with the `whoSees` text ("Governance and up see this"); (b) the Worker's route adds the validator's `answerable` text; (c) such tiles read "Not computed". Default: (a), which keeps the one rule.
4. **Comparisons.** `changes` exist only in the month table, against the month before, for money and counts. There are none for rates, quarters or years, and none against the year before. Options: (a) the Worker adds `changes` to every table plus a year-ago change, under custom-metrics rule 8 (both sides figures of the audience's own grain, never an invented year); (b) comparisons only through a custom metric's `compare`; (c) month only. Default: (a).
5. **Who may be embedded, and where.** Options: public only; public, member and governance; all five. And for tokens: buzz-school's own pages only, or also a school's own site, through a school API key scoped to `embed`. Default: public anywhere without a token; member and governance with a token, on buzz-school's pages first and a school's own site when one asks; never finance or owner. A governance embed follows the school's PIN lock ("Locked").
6. **Invented years.** On 2026-11-05 the public's only published year, 2024, is invented from 2026's months, for every school. Options: (a) the Worker reads the school's earlier rows and drops invented years for schools whose books come from events; (b) keep them and badge every invented period; (c) a public board shows "No published year yet". Default: (a) for event schools and (b) for fixtures. This is needed before any public embed goes live.
7. **Limits and the chart list.** Default: 12 tiles, 6 chart kinds, 24 periods per chart; no pie, donut, gauge, map or scatter.
8. **Where the drafting LLM runs.** Options: a buzz-school endpoint holding the key; a Trifold service; none (templates only). Default: a buzz-school endpoint, for owner and finance admins. The prompt holds no school data.
9. **Finance BI as code.** Options: none; Evidence; Rill generated from the model. Default: none until a finance user asks, then Rill, generated, behind the finance sign-in.
10. **Vega-Lite for finance exploration.** Options: never; on demand behind the finance sign-in. Default: defer until decision 9 is taken.

### What dashboards need from the model and the document

Checked against `ledger.v1.json` and `kpi-document.ts` on 2026-11-06. Decisions 2, 3, 4 and 6 cover the first four.

1. Month documents carry no year or quarter table (decision 2).
2. Series left out below governance carry no hidden text (decision 3).
3. `changes` exist only for the month table, against the previous month, for money and counts (decision 4).
4. Earlier years are invented for every school (decision 6).
5. `partitionOf` (custom-metrics section 3) is needed by `breakdown` too: a bar list says "parts of a total", and only a partition is one. `donations_by_fund` is a year-to-date running total in the document, though the model says `grain: day, rollup: sum` (custom-metrics section 9, item 4), so the rollup check would misjudge it.
6. The `kind` dimension's values are `membership`, `addon` and `booking`. The document titles `membership`, `booking` and `discount`. `discount` is no kind of the model, and `addon` would read "Addon". No preset has income other than memberships, so `income_by_kind` has one row on 13 presets and none on 2 (`free-only`, `non-usd`), and no preset tests a bar list of kinds.
7. `KpiMeta` names no measure. A renderer finds a series' measure by cutting the id at `:`. `meta.measure` (the model id) would make that explicit. `KpiTable.order` covers `revenue_by_tier` and `donations_by_fund` only, not `revenue_by_kind`.
