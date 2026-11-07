# Org KPI dashboard demos

No-login KPI dashboards for the five demo orgs (`packages/atm/docs/scenario-orgs.md`), as self-contained static pages for the Trifold website. Every name and number is invented, and every page says "demo, synthetic data".

| File | Org | Presets |
|---|---|---|
| `index.html` | the gallery: all five orgs, the school first and highlighted | |
| `school.html` | Honeycomb Hill Academy (Before University in the fixtures) | `monthly-members`, `growth-12mo` |
| `studio.html` | Ironbark Studio | `studio-members`, `studio-class-packs` |
| `church.html` | Cedar Hill Community Church | `church-giving` |
| `saas.html` | Lumen Notes | `saas-seats`, `saas-annual` (2026 and 2027) |
| `creator.html` | Night Kitchen Courses | `creator-launch` |

## Regenerate

```sh
cd packages/atm && bun run org-demos
```

`scripts/org-demos/build.ts` runs each preset's scenario, sends its events through atm's write path (`roundTripEvents`) and the atm KPI channel (`runParity`, as `tfd simulate` does), and builds the owner and governance KPI documents with `kpiDocument`, the Worker's builder. The document's clock is the day after the year's last simulated month closes (the year's last day when that month is December). The disclosure is the B4 Uni file (`packages/ledger-ui/src/fixtures/disclosure.json`), a small school, no override.

`tests/org-demos.test.ts` fails when a fresh generation differs from these files by one byte. It also checks that each preset's `kpisHash` and `fixtureHash` equal `tests/golden/scenarios/<preset>.json` (the parity golden), and that each embedded document hashes (sha256 of `canonicalize`) to the hash the page prints. After a change to the generator, the billing engine, the KPI spec or the goldens, regenerate and commit.

## How a page works

The page embeds `{ org, words, titles, presets: [{ kpisHash, fixtureHash, years: [{ year, documents: { owner, governance } }] }] }` as JSON (`#tfd-data`). `dashboard.client.js` draws the document's cells in the school mockup's layout (`../dashboard.html`): tiles, then bar and line charts in tabs. It derives no figure. A tile is the last closed period's cell, and its change line is the document's own `changes`. A cell that is not a number shows its own text (for example "Hidden: fewer than 5 payers"), and the chart hatches it.

- **New KPIs show up by themselves.** Tabs come from each KPI's disclosure class: Money (income and cash), the org's payers (people), Risk (losses), and Payments and credits (activity). A class the page does not know gets an "Other" tab. When the catalog gains MRR, its document entry moves from `notComputed` (shown in the footer today) into `meta` and the tables, and the page draws it in its class's tab with no change to the page. Regenerate the pages.
- **The org's own words.** `src/scenario/org-labels.ts`, beside the org registry, holds each org's words: families and memberships at the school, members and class packs at the studio, givers and recurring giving at the church, customers and seats at the SaaS, and members and course sales at the creator. Plans take the menu's tier names. The ledger model's synonyms are the same for every org, so they cannot supply these words.

## Include it on the website

- **Copy in:** copy the six `.html` files into the site's static folder, keeping them together (each page links back to `index.html`). Nothing else is needed: no fonts, scripts or requests outside the file. Figtree and Graduate are used when the host page provides them, and system fonts otherwise.
- **Iframe:** `<iframe src="/demos/kpi/church.html?embed=1&theme=auto" title="Cedar Hill Community Church KPIs, demo" style="width:100%;border:0"></iframe>`. With `embed=1` the page hides its "All demos" link. After each render the page posts `{ type: "tfd-demo:height", height }` to its parent, so the host can size the frame.
- **Query parameters:** `preset=<name>`, `year=<yyyy>`, `viewer=owner|governance`, `tab=money|people|risk|activity`, `theme=light|dark` (absent: the reader's setting; the button flips it).
- **Theme:** dark and light both follow the mockup's palette. A host that inlines the page can set `--tfd-background`, `--tfd-foreground`, `--tfd-muted`, `--tfd-border`, `--tfd-chart-1` to `--tfd-chart-5`, `--tfd-radius` and `--tfd-font` (`plans/atm-ontology/dashboards.md`, "Theming").

## Where this differs from `plans/atm-ontology/dashboards.md`

- **No `dashboard.v1.json`.** The layout comes from the KPI classes, not from a dashboard definition. The demos predate the schema, so a new KPI needs no new tile.
- **A static page, not the `<trifold-dashboard>` element or the Worker route.** The documents are built at generation time and embedded. There is no token, because there is no real school.
- **Owner and governance only.** The design never embeds finance or owner, because their documents carry names. These documents are synthetic and carry no names, so the owner view is shown, as on the live school demo. Public and member are left out because their earlier years are invented from the current year (open decision 6). For a 2027 document, that would invent 2026 at a scale of 0.
- **Charts keep the mockup's hover tooltips.** There is no "Show as table" button yet. Each chart is an `<svg role="img">` with a label that names the series and the period range.
