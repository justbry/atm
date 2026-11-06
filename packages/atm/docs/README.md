# atm docs

Reference material, findings and detail that used to sit in `ROADMAP.md`. The roadmap lists open work only; `CHANGELOG.md` holds what shipped, release by release. `README.md` says what atm is and `UPGRADING.md` what a caller has to change.

- `stripe-findings.md`: what was verified against a real Stripe sandbox or real deliveries (tier quantities, webhook delivery, payload shapes, the gift-line Checkout, `portalConfigOf`, the portal's limits, several subscriptions on one customer).
- `review-findings.md`: the eight-slice review and the open findings of the later reviews (raise rule, #22 to #24, adoption differences).
- `receipts.md`: invoice links, the one-time Checkout, and the open `receiptOf` decision with its eight questions.
- `financial-reports.md`: the log as a source of hledger reports and a reconciliation with Stripe: what exists and what is missing.
- `e2e-reconciliation.md`: the end-to-end matrix: every handler path that moves money followed through the outbox, hledger and `atm reconcile` against hand numbers and a hand-built Stripe side; the discrepancies it found, the branches it does not reach, and the bugs it was shown to catch.
- `log-and-r2.md`: the outbox, the folder shipper, shipping to R2, the combine, the manifest, replay, the Worker handler, the Parquet export.
- `usage-metering.md`: usage invoicing and usage events as a ledger source (summary and decisions of the three spikes).
- `spikes/usage/`: the full reports, raw results and scripts of the three usage spikes (`README.md` there).
- `pricing-and-positioning.md`: how atm could be priced and positioned next to open and proprietary competitors, a worked example, and the decision to wait on usage events.
- `comparisons.md`: credit ledger depth and the comparison with open-source billing systems.
- `scenarios.md`: seeded school fixtures (the demo school Before University), ad-hoc scenarios, the fixture hash, the KPI spec and its parity across the atm fold, hledger and DuckDB, the goldens and the `kpis.json`/`kpis.parquet` export; what was dropped and why.
- `scenario-bundles.md`: the portable e2e scenario bundles (`fixtures/scenarios/<id>/`: menu, Stripe deliveries in order, Stripe's side, hand numbers, hashes), the H1 to H8 hash checkpoints and `atm scenario check`, how to author a bundle, and how a consumer replays them.
- `suppression-report.md`: which KPI cells the dashboard suppression rules (spec v3) hide in every preset, and why.
- `simulate-from-inputs.md`: design (atm 0.9.0, not built) for storing each handled Stripe input and shipping them like events and replaying them through the grant rules with a candidate menu or policy (`atm simulate --inputs`): what is stored and why, the tables, shipping and erasure, replay fidelity, the interfaces, the PR split, owner decisions, the test plan.
- `releasing.md`: how a release is made and checked.
