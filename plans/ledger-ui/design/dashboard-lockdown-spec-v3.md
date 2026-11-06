# Locking up the KPI dashboards: spec v3 (v2 plus the atm fixtures session's feedback; no code)

Status: draft, nothing built. v2 is /tmp/dashboard-lockdown-spec-v2.md; v1, v0 and the Opus and Fable reviews are in /tmp. Changes from v2 are marked (Δ3); earlier marks (Δ2) are kept.

Owner answers on v3 (via the coordinating atm session): (1) the unsuppressed hash is dropped from the manifest; (2) atm runs the suppression estimates once the new presets exist, in the atm Task 3 session; (3) v3 is with the ledger-UI session for review, and no new mockup until that feedback is in. Facts taken from the coordinating atm session and the ledger-UI session and not checked in the buzz-school repo from here are marked (unverified).

## Decisions (Δ2, all four decided; the ledger-UI session agrees)

- **D1** Suppression and banding protect against non-owner viewers only: non-finance admins, platform staff, embeds, the demo. The owner is the controller of their school's money.
- **D2** Money is owner-only, with a per-admin finance grant.
- **D3** The demo is served from a separate cookieless origin before any public iframe. No iframe until then.
- **D4** Real schools get JSON only. Parquet and DuckDB-WASM are for the demo only.

## Premise

- The ledger export is not built (`school-billing.md` "Not built"; the ledger design is a draft). This spec is for a view over a future log. The log is JSONL events through atm's `Store` into per-environment buckets; only `reports/` files are Parquet.
- The ledger design lets the School API read R2 directly with scoped temporary credentials, and a school's readers get full payloads. So hiding holders is not a safeguard against the school's own owner (D1).
- Real holder ids are `family:<uuid>` and `profile:<uuid>`. `fam_005` is atm fixture style.
- atm's `scenario kpis` export (long rows: `kpiId, period, value, unit`) is the **job's input**, not the wire format (Δ2).

## Principals and policy names

| Principal | Demo | Counts | Amounts | Another school | Holder rows |
|---|---|---|---|---|---|
| Anonymous, learner, solo teen, guardian, non-admin teacher | yes | no | no | no | no |
| Admin without finance grant | yes | banded or `{lt}` | locked | no | no |
| Admin with finance grant, PIN open | yes | exact when the cell rules pass | yes, suppression rules | no | no |
| School owner, PIN open | yes | exact when the cell rules pass | yes | no | no (not in this view) |
| `/v1` School API key, AI tutor agents, handlers, non-person roster members | yes | no | no | no | no |
| Platform staff | yes | via `/platform/kpis` on `requirePlatformAdmin` (step-up, audit before send, enum reason) | same | same, audited | no |
| Third-party iframe | demo only | no | no | no | no |

Policy vocabulary (Δ2, aligned with the buzz-school policy agent; unverified here): facts `role`, `finance_grant`, `pin_open`; actions `ViewLedger`, `ViewFinancials`, `MoneyWrite`, `ManageBookings`. Mapping: counts need `ViewLedger`; any amount needs `ViewFinancials` = (owner, or `finance_grant`) and `pin_open`. The finance grant lives in a **new table, not on the relay roster** (unverified). `MoneyWrite` and `ManageBookings` are not used by the KPI view.

Existing contract kept: a non-admin, a homeschool, a non-school and an unknown id all get the same 404; a learner or solo teen on an adult route gets 403 `adult_only` or `pin_required`.

## Delivery

1. **One path (Δ2).** KPI documents are served only by the family-service school-admin route: one auth, one audit row, the same policy engine. `ledger.b4uni.com` is same-site with `api.b4uni.com`, so it calls the route with credentials once its origin is in `WEB_ORIGINS` (unverified; needs credentialed CORS, `Vary: Origin`, and the CSRF check on the `POST`). The ledger token (`POST /school-admin/ledger-token` plus JWKS, claims `schools[{id,role,finance}]`, being built by another buzz-school agent) is only for views that read R2 directly. It is never a second way to fetch a KPI document.
2. **One document per school per year (Δ2, was per period range).** Switching months must not refetch. One read is one `POST` returning the whole year. No Range, no HEAD, no listing, no Parquet or DuckDB-WASM for real schools.
3. `file` and `period` (year) are closed enums validated server-side. The enum now includes `manifest` (Δ2). The R2 key is built on the server from the roster-checked school id only.
4. Admin and grant checks run before any R2 read. A missing document, another school's and a non-admin all return the same 404 with no R2 latency difference.
5. Rate limits: school-admin 60 per hour and the per-key 120 per minute both apply; one audit row (ids only) per document read, written before the answer.
6. Amounts need the PIN open. Counts for an admin without the finance grant do not, and are banded.
7. Responses: `Cache-Control: private, no-store`, `Vary: Cookie, Origin`, `X-Content-Type-Options: nosniff`. The staging edge Worker (`b4u-api-staging`) never caches `/school-admin/*` or `/platform/*` (test it). The web worker never fetches KPI data server-side; the browser fetches it.
8. The browser holds the document in memory only: no IndexedDB, OPFS or localStorage; cleared on sign-out, profile switch or PIN lock.
9. Switch `school_kpis`, off by default, reported by `GET /features` only when `school_billing`, `school_api` and the R2 settings all hold; a row in `test/flag-gates`.
10. **Bookings by day is out of the KPI document (Δ2).** It needs member names, so it reads a live buzz-school admin route under `ManageBookings`. KPI documents are aggregates only.

## The document

One per school per year, written by the job, served unchanged apart from per-viewer suppression applied by the route:

```
{ school, year, basis: "cash", currency, tz,
  kpiSpecVersion,                            // (Δ3) so the UI's meta matches the definitions
  grain: "month" | "quarter",                // (Δ3) quarter for small schools, see the rules
  asOf, lagMinutes, partialPeriods,
  rules: { minContributors, maxShare },      // (Δ3) replaces minCell: 5 and 0.6, so the UI can explain a hidden cell
  periods: [ "YYYY-MM" or "YYYY-Qn" ],       // 12 or 4
  series:  { kpiId: [ cell x periods ] },    // dimensioned ids are "<kpi>:<dimension>"
  meta:    { kpiId: { title, unit, precision, derived } },
  notComputed: [ { id, reason } ] }
```

- **Cell type.** A cell is `number | {lt: N} | null`, with a reason: `suppressed | banded | locked | not_computed | open_period` (Δ3: `open_period`).
- **The server computes every derived value** (`net_income`, `refund_rate`, `arpa`, `dispute_rate`) from unsuppressed inputs. If any input is suppressed, the derived cell is suppressed too. The UI never derives anything and never reads `null` as 0.
- **`notComputed`** always lists MRR (new, expansion, contraction, churned), ARR, churn, NRR, deferred revenue, AR, gift liability. The cash-basis caveat ships as data: `basis: "cash"` and a note that a yearly payer counts only in the month paid.
- **Freshness and the open month (Δ3, BLOCKER from the fixtures side).** The open month is recomputed hourly, so a viewer comparing two versions of it could isolate a single payment. The open month is shown **only to the owner and to finance-grant viewers**. Everyone else gets closed months only, and the open month's cells come back as `null` with reason `open_period`. Closed months are written once and listed in the manifest. The UI shows a stale banner when `lagMinutes` exceeds 15.
- **Demo.** Same schema: `demo/<preset>/<year>.json` for `monthly-members`, `annual-prepay`, `disputes`, `heavy-refunds`. The preset switcher exists in the demo only.

## Manifest and integrity (Δ3)

`manifest` is a file in the enum, Ed25519-signed, verified in the browser with WebCrypto, shown as a "verified" badge to the owner and admins. It lists the year's closed-month files with the **content hash of each suppressed document as served**, plus `kpiSpecVersion`, the atm version, and `parity: "equal across atm, hledger, duckdb"`.

- **The job refuses to publish** a document when the three channels disagree.
- **No hash of the unsuppressed document in the manifest.** The fixtures session proposed putting `kpisHash` (over the unsuppressed data) in it. That is an oracle: an attacker knows every shown cell, the suppressed cells have a tiny domain (counts under 5, amounts fixed by public prices), so they can enumerate the possibilities until one matches the hash and recover the suppressed values exactly. The unsuppressed `kpisHash`, `fixtureHash`, seed and the H1 to H8 checkpoints stay inside the job and CI. If a signed proof over the unsuppressed data is ever wanted, use an HMAC with a key only the job holds, so it cannot be tested offline.
- Fixture hashes and seeds never appear for a real school.

## Export content and suppression

1. **Allowlist by account class (Δ3, BLOCKER from the fixtures side).** `closing_balance_credits:<account>` gives one value per credit account, including per-holder `credits:avail:` and `credits:held:` accounts, so family and profile ids would appear as dimension names. It is **not exported** for a real school. Instead the job adds a school-wide total (credits outstanding) computed before export; that needs a new non-dimensioned KPI in `kpis/school.v1.json` (an atm follow-up). `closing_balance_usd:<account>` exports only asset, income and expense accounts. A test fails if any key or value in any output matches a holder-id pattern (`family:`, `profile:`).
2. **Cell rules replace the percentage threshold (Δ3).** The v2 rule `minCell = max(5, ceil(0.2 × P))` is dropped: a percentage hides more in big schools, which is backwards. A cell is shown only if:
   - **(a)** at least 5 distinct holders contribute to it, and
   - **(b)** the largest holder is at most 60% of the cell's amount (a dominance rule). For booking KPIs (`credits_consumed`, `revenue_by_kind:booking`), the same two tests also apply to distinct providers (tutors), because one child's or one tutor's bookings would otherwise show (a minors issue).
   - **Complementary suppression:** if exactly one term of a visible sum (total, "Other") is hidden, the next smallest term is hidden too.
   - **School level:** under 10 active payers over a rolling 12 months, the document's grain is quarterly.
   - The job knows contributor counts and shares (it runs in Node on the log) and writes only the result.
   - Expected effect on the presets (the fixtures side's estimates; run them to confirm): `revenue_by_tier:fellow` hidden monthly in `monthly-members` (about 3 payers); refund counts and amounts at a 2% rate hidden monthly; disputes hidden monthly even in the `disputes` preset (about 2 a month); `growth-12mo` starts quarterly; the single renewal month in `annual-prepay` may fail the dominance rule.
3. **KPIs that cannot be shown raw in a suppressed view (Δ3).**
   - `stripe_fees` and `dispute_fees` give away counts (a dispute fee is a fixed $15): suppress them together with their counts.
   - `arpa`, `refund_rate`, `dispute_rate` are derived: suppress whenever any input is.
   - `new_paying_members` is usually under 5 and reveals when a family joined: cell rules apply, and it is quarterly at best for small schools.
   - `credits_expired`: the timing reveals one holder's lapse date (period end plus rollover): cell rules apply.
   - `credits_consumed` and `revenue_by_kind:booking`: provider rule above.
4. Fees, tier revenue, refund and dispute amounts are suppressed with their counts. Public prices and Stripe's fee formula turn any of them back into a count.
5. **Acceptance test.** The rebuild-a-holder property test over seeded scenarios. Attacker model (Δ3): the public menu prices plus Stripe's 2.9% + 30 cents fee, solving subset-sum over the monthly totals. The assertion is that **at least k holder assignments fit every published cell**, not just that the true one is not printed. Presets to add in atm for it to bite (Δ3): `one-payer-tier` (fellow with exactly one payer), `tiny-school` (4 families), `single-refund-month`, `yearly-solo` (one yearly payer, a visible one-month spike), `fee-oracle` (a fee passed on every payment), `seminar-quantities` (1/2/4 seats, a subset-sum case). `child-only` (a tier of children) is **blocked**: the generator only creates `family:` holders (`store.ts` holder is `family:${family}`), so `profile:` holders must be added first.
6. Erasure keeps amounts and drops only identifiers; past months are not rewritten.

## Validation on Workers (Δ2)

Ajv compiles schemas with `new Function`, which deployed Workers refuse (`EvalError`; local dev hides it). atm uses Ajv2020 in `src/ledger/validate.ts`, `src/billing/menu.ts`, `src/billing/policy.ts`, `src/scenario/kpis.ts` and `src/scenario/params.ts`. Each compiles lazily on first call, so importing atm in a Worker is safe and calling those functions is not.

- **(a) Recommended.** The dashboard path does no validation in the Worker. Only the Node job validates and writes; routes only serve the bytes the job wrote, after authorization. The route checks the enums by plain comparison.
- **(b)** If a Worker ever must validate: Ajv standalone validators generated at build time. Supply the custom formats (`currency`, `decimal`, `unix-time`, and the `date-time` and `date` formats `validate.ts` adds), replace `node:crypto` with `crypto.subtle` (note this makes hashing async), and add a parity test of precompiled against runtime validation over the whole fixture corpus.
- **(c)** Fallback: `@cfworker/json-schema`. Check custom-format support first; do not assume it.

## Job and environments

1. The export job runs in `b4u-jobs` (or another Node machine), not inside the family service, with a write-only token for the KPI bucket.
2. Separate buckets and tokens for staging and production. The environment is stamped in each object's metadata and the route refuses an object whose environment differs from `API_BASE`. Production writes are gated on Stripe's `livemode` per event, not on `BILLING_KEY_MODE`.

## Embedding

1. Real-school data is never embedded (the session cookie is `SameSite=Lax`; a third-party iframe cannot carry it). `ledger.b4uni.com` is not an embed: it is a first-party same-site client (Δ2).
2. The demo is the only embeddable dashboard, from a separate cookieless origin. `postMessage` carries theme and height only, with a pinned target origin and an origin check. Framing headers belong in `hooks.server.ts` or `live-headers.ts`; there is no CSP in the repo today.
3. A school that wants to embed its own numbers gets a later server-side `/v1` endpoint for an owner-chosen public subset, never an iframe carrying a session.

## Not a safeguarding default

Nothing here changes a learner-facing default. A change that touches who can see a learner's or child's data is a `SAFEGUARDING:` pull request.

## Tests, in order

1. File and year enums: path traversal, encoded slashes, another school's key.
2. Non-admin, unknown school, no document: identical 404, same timing.
3. Roster removal between two reads; PIN-locked switched session; finance grant removed.
4. Staging credential on the production URL; environment mismatch refused.
5. Edge Worker and web worker never cache the response; no persisted browser storage.
6. The rebuild-a-holder property test; no holder id in any output; `null` never rendered as 0 (Δ2); a derived cell is suppressed when any input is (Δ2).
7. Framing and `postMessage` on the demo origin.
8. Manifest signature verifies in WebCrypto; a tampered file fails (Δ2).
9. Credentialed CORS from `ledger.b4uni.com` works and from any other origin does not (Δ2).
10. The Worker bundle imports atm without calling Ajv (Δ2).
11. A non-finance admin never receives the open month, and two reads an hour apart cannot be differenced (Δ3).
12. The job refuses to publish when the channels disagree; the manifest holds no unsuppressed hash (Δ3).
13. No `closing_balance_credits:` dimension and no holder id in any document; the school-wide credits total is present (Δ3).
14. Cell rules: the dominance rule (largest holder over 60%) hides a cell; under 10 payers the grain is quarterly; complementary cells are hidden (Δ3).

## Mockup implications (Δ2)

States per dashboard (Δ3: plus the open-month `locked` state for non-finance viewers and a quarterly-grain state for small schools): owner (exact), owner PIN-locked, admin without grant (banded or `{lt}`, amounts locked), small school (suppressed with complementary cells), demo (preset switcher, "demo data"). Every chart takes the cell type, shows `<N` and "not computed" distinctly from 0, never derives a number, and shows a stale banner and a "verified" badge. No new mockup until the owner has seen the v1 to v2 diff.
