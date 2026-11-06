# Before University demo mart

Rebuild everything: `./build.sh` (needs bun, duckdb, python3; reads atm at `$ATM`, default the scenario-parity worktree on dev).
The build fails if any preset's fixture or KPI hash differs from `tests/golden/scenarios/<preset>.json`, or if any mart KPI cell differs from atm's own export.

Inputs (golden-backed): `events/<preset>/events.jsonl` (the event stream the fixture hash covers), `events/<preset>/menu.json`, `events/manifest.json`, and `kpis/<preset>/kpis.{json,parquet}` from `atm scenario kpis`.

## Views (`out/*.parquet`, all money in integer cents)

| File | Grain | Source | Reconciled with atm |
|---|---|---|---|
| `kpi_long` | preset x KPI x month | atm export, hashed | is the golden |
| `fact_payments` | one paid invoice | `payment.succeeded` | gross, fees, payments, paying members, revenue by tier |
| `fact_refunds` | one refund | `payment.refunded` | refunds, refunds count |
| `fact_disputes` | one dispute, with won/lost/open | `payment.disputed` + `dispute.closed` | disputes opened, dispute fees |
| `fact_payouts` | one payout | `payout.paid` | payouts |
| `fact_credits` | one credit event per holder | `credit.*` | credits expired |
| `holder_months` | holder x month covered, MRR contribution | derived | no atm KPI (see limits) |
| `mv_mrr_monthly` | month: MRR, ARR, new/expansion/contraction/churned, active/new/churned members | derived | no atm KPI |
| `mv_tier_monthly` | month x tier: payers, gross, largest holder share | facts | gross by tier |
| `mv_contributions` | KPI cell: distinct holders, largest share | facts | feeds the suppression rules |
| `mv_contributions_ytd` | KPI x month, year to date (January through that month, each holder summed over the span): distinct holders, largest share | facts | feeds the year-total rule; December is the whole year |
| `mv_bookings_daily` | day x service: sessions, holders | `credit.held` (start = lock expiry - 2h) | no atm KPI |
| `mv_cohort` | first-paid cohort x age: active, size | derived | no atm KPI |
| `mv_credits_outstanding` | month x feature: avail + held units | postings | matches atm's own closing balances, which are wrong (below) |
| `mv_cash_monthly` | month: Stripe balance, payouts | postings | no atm KPI |

`out/bundle.json` is the dashboard's cache (one object per preset, with hashes and reconcile counts); `out/dashboard.html` inlines it.
Per preset, `contrib[kpi][i]` is `[holders, largest share]` for period `i`, and `contribYtd[kpi][i]` the same over the year to date through period `i` (null before the year's first contributor). A year total over the closed months through `i` takes the cell rule (at least 5 holders, largest at most 60%) from `contribYtd[kpi][i]`.

## Limits

- Holder ids are pseudonymous (`h001`) and exist only because this is synthetic demo data. A real school's export never carries them (spec v3).
- MRR is derived: yearly = a payment of at least 10x the tier's monthly menu price; one-time add-ons on a first invoice count toward MRR because the ledger folds add-ons into the tier's income line.
- Credits outstanding goes negative (monthly-members class: -91 at 2026-12) because a renewal that resets a balance books only `plan.changed`, no credit posting. atm's `closing_balance_credits` shows the same. Not usable until atm posts renewal resets.
- free-only and non-usd have no USD payments, so money views are empty for them.
