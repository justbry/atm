# Scenarios: seeded school fixtures and KPI parity across channels

What it is: a seeded generator for **Before University**, a public, open-access demo school (invented names, prices and ids; no real data and no key), run through atm's own billing rules, then replayed through three channels that each compute the same KPIs from the same events. If the channels' KPI hashes differ, something in the books or in a reader is wrong, and the diff says which KPI in which month.

- **Events**: `handleStripeEvent` decides every Stripe event (`invoice.paid`, `charge.refunded`, disputes, `payout.paid`, `customer.subscription.deleted`) and the family service's booking commands (`track` then `finalize`), as the family service would. One in-memory subject per family. No clock is read.
- **Channels**: `atm` (a TypeScript fold over the events), `hledger` (the events as a journal, summed by hledger), `duckdb` (the events loaded into DuckDB, answered by generated SQL). hledger and DuckDB are skipped, never failed, when the binary is missing.
- **Spec**: `kpis/school.v1.json`, checked against `schema/kpis.v1.json`. The base KPIs (sum, count, distinct) are computed by each channel from the spec; the derived ones (ratio, combine) are evaluated once, in `src/scenario/kpis.ts`, from the base values.

## Copy-paste

```sh
atm scenarios list
atm scenarios describe heavy-refunds                 # knobs that differ from the defaults, and commands
atm simulate --profile heavy-refunds                 # fixture hash, one KPI hash per channel, parity
atm simulate --profile heavy-refunds --set refundRate=0.2 --seed 7 --json
atm simulate --profile annual-prepay --set months=14 --set tierMix.fellow=0 --channels atm,duckdb
echo '{"name":"tiny","params":{"members":3,"months":2,"currency":"gbp"}}' | atm simulate --scenario - --json
atm scenarios schema                                 # the JSON Schema of --scenario
atm scenario kpis --profile disputes --out ./out     # ./out/disputes/kpis.json and kpis.parquet
```

`atm scenarios` and `atm scenario` are the same command. `atm simulate` without `--profile` is the log what-if of 0.6.0, unchanged.

Exit codes: 0 every channel that ran agrees, 1 they differ (a per-KPI diff follows), 2 input it cannot use (one line on stderr with every problem and its fix, and `{"ok":false,"error":...}` on stdout with `--json`).

## Presets

| Preset | Seed | What it exercises |
|---|---|---|
| `free-only` | 101 | 100%-discounted invoices: credits granted and used, no money |
| `monthly-members` | 102 | the baseline: 24 monthly families, all four tiers, light refunds, rare disputes |
| `annual-prepay` | 103 | yearly payments over 24 months (no seminar seats: that tier has no yearly price) |
| `heavy-refunds` | 104 | one paid invoice in five refunded, two in five of those partly |
| `disputes` | 105 | one paid invoice in twelve disputed, half lost |
| `non-usd` | 106 | a euro menu: credits granted, every money line skipped |
| `growth-12mo` | 107 | six founding families, five new a month |
| `churn-spike` | 108 | forty families, a quarter leave at each renewal, six months |
| `one-payer-tier` | 109 | twenty families, nobody leaves: exactly one payer on `fellow`, 6 on `audit`, 8 on `scholar`, 5 on `seminar` |
| `tiny-school` | 110 | four families, six months: no cell can have five holders |
| `single-refund-month` | 111 | exactly one refund in the whole run (so one month with a refund, five without) |
| `yearly-solo` | 112 | exactly one yearly payer, no add-ons, everyone else monthly: a one-month spike |
| `fee-oracle` | 113 | one tier, one amount, no add-ons, refunds, disputes or free invoices: Stripe's fees total exactly payments x the fee on one payment |
| `seminar-quantities` | 114 | everyone on `seminar`, sold in 1, 2 and 4 seats: payments of three sizes (a subset-sum case) |
| `child-only` | 115 | every membership is a child's own profile: holder `profile:prof_NNN`, never `family:`, across all four tiers |

The last seven exist so the dashboard export's privacy suppression has a small-cell case that exists exactly, not by luck of a seed. Each promise is asserted from the generated events in `tests/scenario-presets.test.ts` (payers per tier, refund events, payment amounts, holder keys), not from the knobs.

A preset is a seed and knobs over the defaults (`src/scenario/profiles.ts`); nothing is written by hand. The knobs are `months`, `start`, `members`, `newMembersPerMonth`, `tierMix`, `yearlyShare`, `addonRate`, `freeShare`, `churnRate`, `refundRate`, `partialRefundShare`, `disputeRate`, `disputeLostShare`, `usageRate`, `currency`, `feePercent`, `feeFixedCents`, `childShare`, `tierCounts`, `yearlyCount`, `refundCount`; `atm scenarios describe <preset>` lists each with its range and meaning.

The last four make a scenario exact (the weighted knobs above them only make it likely). Each is off at its default (`0`, `0`, `{}`, `0`) and then changes nothing: an existing preset's events are byte-identical with or without them in the resolved knobs.

- `childShare` (0 to 1): the share of families whose membership is a child's own profile. The holder is `profile:prof_NNN` instead of `family:fam_NNN` in every key, account and payload; the invoice and subscription metadata carry `profile_id` beside `family_id`. It is drawn from a stream of its own, so it moves nothing but who holds. (The store seeds the holder in the subject's grants row, which the billing handler obeys before it reads the metadata; no production code changes.)
- `tierCounts` (e.g. `{"fellow":1,"audit":6}`): the exact number of families on a tier, instead of the weighted draw; which families is a seeded shuffle. A tier named here, even at 0, is left out of `tierMix` for the families not named, so the count is exact; the others draw from `tierMix` over the tiers not named. `--set tierCounts.fellow=1`. Counts above the family count, or no weight left for the rest, are an input error. Set `freeShare` 0 to make every counted family a payer.
- `yearlyCount`: the exact number of yearly payers, a seeded choice among families whose tier has a yearly price (`seminar` has none); everyone else pays monthly and `yearlyShare` is ignored. 0 = use `yearlyShare`.
- `refundCount`: the exact number of refunds in the whole run, each on a different paid, undisputed invoice whose refund falls inside the run (a seeded choice); `refundRate` is ignored. 0 = use `refundRate`.

An ad-hoc scenario is `{ "name"?, "profile"?, "seed"?, "params"? }`: the preset's knobs, then the scenario's `params`, then `--set`; `--seed` wins over both. Errors name the knob, what was given, what is allowed and a fix (`refundrate` → `Did you mean "refundRate"?`; `refundRate=20` → it is a share, 20 would be 0.2).

## Before University and buzz-school's `Menu`

`fixtures/billing/menu/before-university.json`: four tiers (Audit, Scholar, Seminar sold in 1, 2 or 4 seats, Fellow), three credit features, four add-ons (monthly, yearly and two one-time), monthly and yearly prices, rollover with and without `max`. It uses only the shape of buzz-school's `Menu` (`docs/features/school-billing.md`: at most 4 tiers, 6 add-ons, 12 features; ids `[a-z0-9_-]`, amounts 50 to 10,000,000 cents, grants naming a menu feature). `tests/scenario-fixtures.test.ts` checks it against atm's `validateMenu` and against those rules restated (buzz-school is not a dependency).

Shape drift against buzz-school's pinned atm 0.6.0 that these fixtures do not use: atm 0.8.0 adds `gift` on add-ons, member and gift `codes`, bookable items with `billing`, and the booking and gift settings in the policy (`UPGRADING.md`, "Moving to 0.8.0 from 0.6.0"). The fixtures also assume what 0.8.0 does and 0.6.0 does not: dispute money lines, `non_usd` markers, the optional `fee` on a payment.

## The fixture hash

`sha256` of the canonical JSON of `{ scenario, events }`: keys sorted, `scenario` the resolved one (every knob and the seed filled in), `events` in event order. Amounts are two-place decimal strings, instants UTC `Z`, dates the school's local `YYYY-MM-DD`, as the events carry them. The same seed and knobs give the same hash on every run and in every time zone (`tests/scenario-fixtures.test.ts` runs three times and under three zones).

## The KPIs

Month grain (the event's local date). Money in cents, credits in units. Cash basis: a payment is revenue the day it is booked. `ratio` KPIs are rounded half up in integer arithmetic, so the channels cannot differ by a float.

| Group | KPIs |
|---|---|
| Money | `gross_collected`, `revenue_by_kind:<kind>`, `revenue_by_tier:<tier>`, `refunds`, `disputes_lost`, `dispute_fees`, `stripe_fees`, `net_income`, `payouts` |
| Counts | `payments_count`, `refunds_count`, `disputes_opened` |
| Rates | `refund_rate`, `dispute_rate`, `breakage_rate`, `arpa` |
| Members | `paying_members` (a membership payment booked in the month), `new_paying_members` |
| Credits | `credits_granted`, `credits_consumed`, `credits_expired` |
| Balances | `closing_balance_usd:<account>`, `closing_balance_credits:<account>`, `credits_outstanding` |

`closing_balance_credits:<account>` has one value per credit account, including each holder's `credits:avail:` and `credits:held:` account, so holder ids (`family:`, `profile:`) appear as dimension names. `credits_outstanding` is the one school-wide total for an export that must carry no holder: available plus held, every feature and holder, cumulative to the month's end, no dimension. It is a plain cumulative `sum` over `^credits:(avail|held):`, so the three channels compute it with no new operation, and `tests/scenario-parity.test.ts` checks every channel against the postings' sum for every preset, `child-only` included.

Add a KPI by adding it to `kpis/school.v1.json`; no channel code changes unless it needs an operation the spec language lacks (`sum`, `count`, `distinct`, `ratio`, `combine`). The schema documents each field and the regex dialect (the POSIX ERE subset hledger, DuckDB and JavaScript share). The hash of a KPI table is the sha256 of the canonical JSON of its `{kpiId, period, value}` rows sorted by id then period.

### Dropped, and why

The books are cash basis and carry no interval or period on a payment, so these cannot be derived the same way in every channel (or at all). They are not in the spec:

- **Deferred revenue and accounts receivable**: no such accounts exist (owner decision open in `ROADMAP.md`, "Revenue is booked when the invoice is paid"). Inventing them here would make the parity meaningless.
- **MRR (new, expansion, contraction, churned), ARR and logo churn**: they need a payment's interval (month or year) and period. `payment.succeeded` has neither, so a yearly payment is indistinguishable from a monthly one of the same size. `revenue_by_tier` and `paying_members` are the cash-basis stand-ins, and a yearly member counts only in the month it is paid (the `annual-prepay` golden shows it: paying members fall to 0 in months with no renewal). A proposed fix, not made here: an `interval` (and `period_end`) label on `payment.succeeded`.
- **Skipped non-USD lines as a KPI**: a `money.skipped` event has no postings, so it is not a journal transaction and hledger cannot count it. The count is kept in the golden (`skippedNonUsd`) and in the CLI's `stats`, from the fixture.

## Channel discrepancies found

- **Fixed with the bundles change: the generator handled every renewal with the family's last cycle.** The `at(paidAt, ...)` callback of an invoice read the loop's `let` `periodStart` and `cycle` when it ran, after the loop had finished, so each invoice was handled with the family's final period and cycle and renewal grants piled up at the last renewal (`credits_outstanding` went negative from about month 4 in most presets, in every channel). The two values are now captured per iteration. Every preset's events and goldens moved with it; `credits_outstanding` is positive in every preset (e.g. `monthly-members` 87 to 371).

- **A renewal that moves nothing leaves no credit event.** When a renewal resets a balance to its allowance without raising it (the member used nothing, or the reset lands first), the engine's command moves no credits, so the log holds a `plan.changed` with no postings and no `credit.granted`. Members counted from credit grants fell to 0 in most months for a school that bills them every month; `paying_members` counts from `payment.succeeded` instead, and members on zero invoices are not countable at all after their first month. `credits_granted` is therefore top-ups, not allowances, and a monthly breakage rate (`credits_expired` / `credits_granted`) can pass 1. Found by rendering the first dashboard.
- hledger drops every event without postings (`money.skipped`, `plan.changed`, `credit.expiration_changed`): any KPI over those would differ. See above.
- The hledger channel cannot make hledger's regexes case-sensitive; it throws if a filter would match differently with and without case. A label value's comma or line break is a space in the journal (`journal.ts`), so a KPI keyed on such a label would differ from the raw event. Neither occurs in the fixtures.
- hledger cannot add different commodities, so a `credits` sum over several credit features is added in TypeScript per cell. The demo school's three features are three commodities; this is exercised by every credit KPI.
- Found by the harness while it was being built, and fixed: the atm fold returned a month's movement instead of a running balance for the closing-balance KPIs. DuckDB and hledger had it right, and the final balances match `fixtures/vibes-year/expected.json`.

## Goldens

`tests/golden/scenarios/<name>.json` per preset and per ad-hoc scenario in `tests/scenario-parity.test.ts`: the resolved knobs, the fixture hash, the KPI hash (equal for every channel), event and period counts, and window totals of the additive KPIs. A new knob moves every golden's `params` and `fixtureHash` (the resolved scenario is hashed) without moving a single event; a new KPI moves `kpisHash`. A change that moves a hash fails the test; rewrite after an intended change and review the diff:

```sh
cd packages/atm && UPDATE_GOLDEN=1 bun test tests/scenario-parity.test.ts   # or: just golden
```

`tests/scenario-parity.test.ts` also moves one payment by a cent in one channel's input at a time and asserts the diff names the KPI (`Gross collected`, `Net income`) and both values.

## The export

`atm scenario kpis --profile <p> --out <dir>` writes:

- `<dir>/<name>/kpis.json`: canonical JSON, `{ version, profile, seed, fixtureHash, kpisHash, rows: [{ kpiId, period, unit, value }] }`. `kpisHash` is the sha256 of the canonical JSON of the rows without `unit`.
- `<dir>/<name>/kpis.parquet`: the same rows by DuckDB `COPY`, long format, columns `profile VARCHAR, kpi_id VARCHAR, period VARCHAR (YYYY-MM), value DOUBLE, unit VARCHAR`, sorted by `kpi_id` then `period`. Skipped (and said so) when `duckdb` is missing. A dimensioned KPI's id is `<kpi>:<dimension>` (`revenue_by_tier:scholar`).

The command exits 1 and writes nothing when the channels disagree.
