# S8 contract: real adapters for the ledger UI (atm, buzz-school, the Worker, the UI)

Status: draft, 2026-11-06. This is the interface between the repos and between the agents that build S8. A child agent codes against this file; a change to it goes through the S8 thread, never between children.

The UI side of the interface is [`S8-ui-needs.md`](S8-ui-needs.md): every call of `packages/ledger-ui/src/data/`, its source and its status. This file does not restate it. It adds the transport rules, the R2 layout, the emission design, the work split, and the corrections found by checking both repos on 2026-11-06 (atm `origin/dev`, buzz-school `origin/main`).

## 1. Ownership and rules for every child

- `packages/ledger-ui/src/data/` and `src/fixtures/` belong to the ledger-ui loop's orchestrator. **No S8 child edits them.** A child that needs a shape changed says so in its report; the S8 thread tells the orchestrator, who changes the contract and the fixtures together so the golden and consistency gates stay green.
- atm children: branch `claude/s8-<slice>`, PR against `dev`, never `main`. buzz-school children: branch `claude/<slug>`, PR against the repo's default integration branch (`gh repo view --json defaultBranchRef`), never `main` and never merged by the child. Local gates only; do not wait on GitHub Actions. Biome only on touched files.
- buzz-school work is done by buzz-school children, not from the atm session. New files where possible, routes registered with the smallest diff, migration numbers checked against what is free at the time.
- Final line of every child report: `PR <full URL>, head <SHA>, local gates <pass/fail list>`, then a short "Gaps found" list (not done, assumptions, anything that contradicts this file).
- The log carries `key = family:<familyId>` and a Stripe customer id, and no name, email or profile id. No S8 code may put one in an event, a view object or a log line. `sub` (profile id) is never written to R2.

## 2. Transport and gating

| Path | Carries | Auth |
| --- | --- | --- |
| browser → `api.b4uni.com` | every write, and every buzz-school read | `b4u_session` cookie (host-only, `SameSite=Lax`; same-site with `ledger.b4uni.com`), CSRF, `Idempotency-Key` on writes. Only paths in `LEDGER_ROUTES` get CORS for the ledger origin. |
| browser → ledger Worker | every read of atm data | `Authorization: Bearer <ledger token>` (5 minutes) |

The browser gets the token from `POST /school-admin/ledger-token` and refreshes it before `exp`. A `503 school_api_unavailable` means "try again", never "no schools".

The Worker, on every request:

1. Verifies the token against `/.well-known/ledger-jwks.json` (cached for its `max-age`, `kid` looked up there, never a key the token carries): `alg` is `EdDSA`, `iss` is this environment's `API_BASE`, `aud` is exactly the string `atm-ledger`, `iat` present and not in the future, `exp - iat <= 300`, `nbf` and `exp` valid. `src/ledger/jwt.ts` `verifyJwt` and `test/ledger-jwt.test.ts` in buzz-school are the reference and the case list.
2. Refuses a school that is not in `schools[]` (same 404 as an unknown school).
3. Serves **raw books data** (ledger rows, income statement lines, members' money, donor rows, payment history) only when the school's entry has `finance: true`. These objects live under `schools/<id>/views/finance/`.
4. Serves a **KPI document** for any listed school, computed on the server from aggregates at an audience no finer than the caller may view (section 4). The Worker reads finance aggregates to build a coarser document; what it returns, never what it reads, is what the audience gate limits. A `finance:false` caller therefore cannot get a row or an exact figure, only the document of their level.
5. Returns the manifest `asOf` on every read, so the UI can show the ship lag and the pending state.

## 3. R2 layout

Under `schools/<id>/`, per environment bucket (decision D2):

```
events/date=YYYY-MM-DD/{batch-*.jsonl, day.jsonl, late-*.jsonl}   existing, written by the shipper
views/manifest.json                                                existing
views/months/YYYY-MM.json                                          existing (S8a removes `money` from it; it moves to finance)
views/members/<hash>.json, views/members/index.json              existing
views/finance/months/YYYY-MM.json                                  new (S8a): money, income by account and plan, fees, refunds, disputes, payouts, fundraising by campaign
views/finance/members/<hash>.json                                  new (S8a): a member's payments, refunds, last payment (no names)
views/kpi/contributions/YYYY-MM.json                               new (S8a): per KPI cell, distinct holders and the largest holder's share (what the cell rules need)
```

Every object is in `manifest.objects` with its sha256, so `readViewsFromStore` verifies it. A change to an existing object's bytes changes the fixtures' golden hashes: S8a tells the S8 thread before it lands so the orchestrator regenerates them in the same PR.

## 4. Audiences and the disclosure

The audiences are public, member, governance, finance, owner (`S8-ui-needs.md`, disclosure; buzz-school spec `docs/superpowers/specs/2026-11-05-school-books-disclosure-design.md`, status `draft`, nothing built).

- **Token to audience.** `role: owner` is owner; `finance: true` is finance. An admin without the grant reads like anyone else (spec: highest of owner, finance, the tier's `books` level, public). The token carries no membership level, so by default (D7) an admin with `finance:false` gets **public**, and "View as" can only go down. The orchestrator confirms whether the UI expects governance for that admin.
- **The disclosure read.** `disclosure(school)` is a buzz-school read (`books` setting plus the B4 Uni defaults file). It does not exist. Until S8d-bz adds it, the Worker applies the B4 Uni defaults file shipped with the UI/oracle (`src/fixtures/disclosure.json` semantic) and the adapter reports the school as "defaults". The Worker, not the UI, applies it.
- **The document.** `kpiDocument(rows, contributions, disclosure, audience, pin)` is a pure function in `atm/worker` (S8b), moved from `packages/ledger-ui/gates/oracle.ts`. The oracle stays in `gates/` as the independent implementation; the consistency gate compares the two on the same inputs. S8b also carries what the oracle now emits: `tables.month.changes`, `order.revenue_by_tier`, the `dispute_cost` KPI, and `KpiTable.changes`/`order`.

## 5. Event emission (S8d, buzz-school)

Today buzz-school writes no atm event: it imports only `runEngineCommand` (`school-billing/grant.ts`, `adjust.ts`), keeps the revision and the credit lots (`apply.ts`) and drops the engine's event. Its school webhook (`routes/school-billing.ts`, `school-billing/webhook.ts`) writes memberships, lots, claims and audit rows only. It already ships other data to R2 on timers (`journal/ship.ts` with `S3Store` on `aws4fetch`, `records/shipper.ts`, started in `server.ts`), which is the pattern to follow.

What atm offers: `SqlDatabase` (minimal, synchronous, `BEGIN IMMEDIATE` transactions), `HANDLER_DDL` and `migrateHandlerSchema`, `recordEngineCommand`, `recordLapse`, `appendToOutbox(db, events, env)`, `handleStripeWebhook(deps, request)` (the full handler with claims and outbox), the pure `handleStripeEvent`, `planOutbox`/`shipOutbox` (exported from `"."` only), and `R2Store` (S3). No builder for `catalog.published` exists.

**S8d starts with a design spike, in writing, before any code:** does atm's handler keep its own engine state (customer and balance rows) in the SQLite it is given? If it does, running it beside buzz-school's `school_credit_lots` makes two sources of truth. The spike chooses one of: (a) run atm's handler as a ledger-only shadow in its own tables, reading the same verified Stripe event; (b) feed `appendToOutbox` events built by buzz-school's own handler from the lots it already writes; (c) port the posting rules. It names the dual-write risk and how a drift is detected. Default if the spike finds nothing worse: (a), because the postings, refund matching and fee handling are already tested in atm.

Whatever the choice, S8d delivers:

- payment, refund, dispute and fee events for each school, under that school's id and the right env (`live`/`test` from `billingKeyMode`);
- credit events for every engine command buzz-school runs (grant, adjust, forfeit, expire), recorded in the same transaction as the lots they change;
- a `catalog.published` event on menu publish (atm adds the builder, S8a; payload needs `plans`, `menu`, `version`);
- a shipper job per environment writing `schools/<id>/events/` to that environment's bucket (D2), and the views job (section 6, S8c) reading it;
- no Zeffy/donation events (buzz-school stores none; D5).

`shipOutbox` has no env filter and the log has no env: a test-mode and a live event with one idem would collide. D2 (one bucket and one shipper per env) is what keeps them apart.

## 6. Slices

| Slice | Repo | Delivers | Depends on |
| --- | --- | --- | --- |
| **S8a** | atm | Month views split: `views/finance/` objects (section 3); income by account and plan; fundraising by campaign; `views/kpi/contributions`; `ledgerRows(events, filter, cursor)`; income statement with `previous` and `previous.changes`; `membersIncome`; a `catalog.published` builder; `runViews(store, school, asOf)` composing read, build and write; export of `shipOutbox`/`planOutbox` from `atm/worker` only if S8d needs it (decision D3). All Worker-safe: no `node:fs`, no Ajv, no hledger. | this file |
| **S8b** | atm | `kpiDocument(...)` as in section 4, and a Worker-safe export of the suppression path (`suppressKpis` reaches Ajv through `scenario/kpis.ts` and `node:crypto` today; Ajv's `new Function` fails in a Worker). Equality test against `gates/oracle.ts` over the 15 presets and the five audiences. | this file; S8a for the contributions view |
| **S8d-bz** | buzz-school | Add to `LEDGER_ROUTES`: `POST .../billing/menu`, `POST .../billing/menu/publish`, `POST .../billing/stripe-key`(`/remove`), `POST /school-admin/key-create`/`key-revoke`. A read for the school's display name (plus time zone, currency, credit unit in one answer). Fix `capabilities` so `publishMenu` is not `built` while its route is unreachable, and add `audit` and `resendReceipt` as `not_built`. Route table test updated. | none |
| **S8d** | buzz-school | Section 5. Spike first. | S8a's builder; the spike's decision |
| **S8c** | atm (or a new package) | The ledger Worker: wrangler config (`nodejs_compat`, R2 binding per env, cron trigger for `runViews`), token verification, school and finance gating, the read endpoints behind the `Reader` calls marked atm in `S8-ui-needs.md`. `dashboardOptions` returns no presets. Tests in Miniflare over seeded R2 built from the 15 presets' events (the `tests/worker-fixture` pattern). | S8a, S8b |
| **S8e** | atm `packages/ledger-ui` | `HttpReader`/`HttpWriter` behind the existing seam. Writes add CSRF and an `Idempotency-Key`, and `publishMenu` asks for the PIN first (the route needs the PIN only, not the mailed-link step-up; `POST /family/pin/verify` is already reachable from the ledger origin). A write shows pending until the manifest `asOf` passes it, and the pending state survives a reload (`S8-ui-needs.md`, "Rules the adapters must keep"). **Gate:** the consistency gates C1–C5 (`gates/run.ts`, `bun run test`) run against this adapter on the Miniflare Worker, as they do against the fixtures. | S8c, S8d-bz |
| **S8f** | both | `ledger-staging.b4uni.com` against a staging bucket, token round trip, one refund and one booking cancel end to end. | all |

S8a, S8b and S8d-bz can run in parallel.

### Status (2026-11-06)

| Slice | PR | State |
| --- | --- | --- |
| S8b | atm #138 | built, mergeable, checked. `kpiDocument(rows, contributions, disclosure, audience, pinLocked, context)`: a sixth `context` argument (`school`, `currency`, `clock`, `preset?`, `plans?`, `donors?`, `days?`, `invented?`). `contributions` is accepted but not read yet: the oracle counts the period's paying members, not per-cell holders (open question for the ledger-ui orchestrator, D9). |
| S8a | atm #139 (stacked on #138) | built, mergeable, checked. Removes `MonthView.money` from `views/months/`, so month objects and every manifest change bytes: the orchestrator regenerates the mart snapshots and goldens in the PR that merges it (`S8a-hash-changes.md`). Finance month objects carry `grossByDay` and `income.planOrder`; contributions use the `KpiContributions` object form. |
| S8d-bz | buzz-school #1348 | built and self-reviewed: `LEDGER_ROUTES` additions, `GET .../ledger/school`, `capabilities` fix, and `docs/features/ledger-ui-gaps.md` (the plan for every other buzz-school gap). |
| S8d, S8c, S8e, S8f | | not started. S8c waits on #138 and #139 merging. |

## 7. Corrections to `S8-ui-needs.md` (checked 2026-11-06)

| Row | Was | Now |
| --- | --- | --- |
| `schools()` | school read: gap | Time zone is on `bookings` (`timeZone`); currency, credit unit and tier data on `billing/menu/versions/<n>`. **Only the display name has no ledger-callable route.** |
| `planSummary` per-tier route | confirm | `GET .../billing/members` (counts only) exists but is **not** in `LEDGER_ROUTES`; the ledger origin gets no CORS on it. Add it (S8d-bz) or join members-list in the adapter. |
| `invoiceItems`, `switchTiers` | confirm | The published menu body (`versions/<n>`) holds tiers and add-ons: exists. |
| `schoolRules` | confirm | **Gap.** buzz-school has a per-event `change_cutoff_min` only; no school-level late-cancel or no-show rule. Booking credit hold and spend wait for atm 0.8.0. |
| `settings` reads | confirm | `GET .../billing` (account name, Stripe state) exists, not in `LEDGER_ROUTES`. No `books` setting, no accounting basis, no Zeffy key anywhere. |
| `saveMenu`, `publishMenu` | exists | The routes exist and are **not reachable from the ledger origin** (`LEDGER_ROUTES` needs the literal `versions`). `capabilities` says `publishMenu` is built. Fixed by S8d-bz. |
| `saveStripeKey`, `removeStripeKey` | confirm | Routes exist (`billing/stripe-key`, `/remove`), not in `LEDGER_ROUTES`. |
| `createKey`, `revokeKey` | confirm | Exist at `/school-admin/key-create`, `/key-revoke` (owner, school in the body), not in `LEDGER_ROUTES`. |
| `saveZeffyKey`, `removeZeffyKey`, `saveAccountingBasis`, `saveDisclosure` | confirm | **Not found** in buzz-school. Gaps. |
| `changeRole` | gap | Partly: `POST /school-admin/admins/remove` and admin invites exist; make-admin of an existing member and remove-owner do not. |
| `resumeMembership`, `resendReceipt` | gap | Confirmed not found; `capabilities` does not list them. |
| `donors` | names: gap | Totals by campaign: atm already has `fundraise.received` / `fundraise.paid_out` (accounts `income:fundraising:<campaign>`). Names: no source in atm (events carry none) or buzz-school (no donor or Zeffy storage). |
| `membersSummary`, `people`, `memberDetail` | gap | Unchanged. The member event has `key` and Stripe `customer` only; names come from members-list by `key`. |
| `kpiDocument` | gap | KPI math is pure TypeScript, not DuckDB. The blockers are Ajv and `node:crypto` in the suppression path and the missing contributions view. |

## 8. Decisions, with the default each child assumes

| # | Decision | Default |
| --- | --- | --- |
| D1 | How buzz-school emits events | Spike in S8d, default (a), the shadow handler. |
| D2 | Environments | One bucket (or one prefix root) and one shipper per environment. `ledger-staging.b4uni.com` reads staging only. |
| D3 | Where the shipper runs | In the family service next to the existing journal shipper (Bun, `R2Store`). `atm/worker` exports `shipOutbox` only if the Cloudflare move (PR #1273) puts the shipper in a Worker. |
| D4 | Erasure | Open (buzz-school spec E11). `family:<id>` is in an append-only log. atm has a `subject.erased` event type; S8d reads how it works and reports. No claim is made here that it solves erasure. |
| D5 | Donors | Totals by campaign only. Names stay unavailable. |
| D6 | Member portal | Read-only preview in S8; portal writes stay on fixtures. The member routes are deliberately outside `LEDGER_ROUTES`. |
| D7 | Admin without the finance grant | Public audience (spec rule). The orchestrator confirms what the UI expects. |
| D8 | Promos, remindHost, changeRole, switchTier, cancel/resume membership, resendReceipt, audit | Stay on fixtures behind `not_built` capabilities until a route exists. |
| D9 | KPI cell rules: per-cell holders (spec) or the period's paying members (oracle `bkFig`, G1g) | Open. Until the ledger-ui orchestrator answers, the oracle rules. If the spec rule wins, the oracle changes first, then `kpiDocument` reads `contributions`. |
| D10 | Refund permission | Open. Briefs B and C say owner only (Cedar `MoneyWrite` covers refund, invoice and adjust as one action); the mockup lets a finance admin refund. Options in `ledger-ui-gaps.md`: keep it, open it to finance admins, or split a `Refund` action. Default: keep owner only. |
| D11 | `bookingRules` / `schoolRules` | No source (buzz-school has a per-event cutoff only; credit hold and spend wait for atm 0.8.0). Answer `null`; the UI contract allows it. |

## 9. Open risks

- Two sources of truth for credit state if the atm handler runs beside buzz-school's lots (section 5). The spike decides; a drift check ships with whichever is chosen.
- The cell rules and the contributions view carry small-school re-identification risk. S8a's contributions object holds counts and a share, never a key.
- The views lag the log by the shipper interval plus the cron interval. The UI already shows a stale chip; the Worker returns `asOf`.
- PR #1273 moves the family service to Cloudflare. If it lands first, D3 and the shipper job change.
- `adjust.ts` says the credit note and kind "belong to the engine's ledger event". Nothing stores that event today, so the comment is true only after S8d.

## 10. Remaining buzz-school gaps: build list

The plan is `docs/features/ledger-ui-gaps.md` in buzz-school (PR #1348): for each gap, what exists, the proposed route and shape matched to the UI contract's field names, the Cedar action, the source, migration and size. It builds nothing. Groups, each one reviewable PR against `main` (M: needs a migration, O: needs an owner decision, S8d: waits on the emission design, C: needs a UI contract change):

| # | Group | Contents | Size | Marks |
| --- | --- | --- | --- | --- |
| 1 | S8d-bz2 | `granted`, `rolledOver` on members-list; `ending`, `activeUnits`, `monthlyMinor` on `billing/members` (`monthlyMinor` behind `ViewFinancials`); `ledger/members-summary` | S | C |
| 2 | S8d-bz3 | `seriesLabel` on bookings; `POST .../bookings/<id>/remind` | S | |
| 3 | S8d-bz4 | `ledger/people`; `POST ledger/roles` (`changeRole`) | M | O |
| 4 | S8d-bz5 | `ledger/members/<person>/money` (payments, refundable, `stripeDashboardUrl`); `resendReceipt` | M | O |
| 5 | S8d-bz6 | admin cancel, resume and switch | L | S8d, O |
| 6 | S8d-bz7 | `ledger/settings` read | M | C |
| 7 | S8d-bz8 | member portal preview read | L | S8d, O |
| 8 | S8d-bz9 | disclosure: file, validator, `school_books_disclosure`, tier `audience`, `GET/POST ledger/disclosure` with step-up | L | M, O, C |
| 9 | S8d-bz10 | `audit-facts` read | M | after S8c, S8d |
| 10 | S8d-bz11 | accounting basis, booking rules | M | M, O |
| later | | promos, Zeffy, portal writes for the embed | L each | O |

Groups 8 and 10 need a migration, and so does a gift-code table if promos are built. Which groups are built, and in what order, is decided by the S8 thread with the orchestrator, not by a child.

Contract changes the plan asks for (the orchestrator changes `src/data/` and the fixtures together):
- allow `null` for `expiringGifts`, `bookingRules`, `settings.basis`, `settings.zeffy` and `stripe.missing`;
- `Disclosure.year`, `size` and `views` need income, so the Worker assembles them from buzz-school's file, the school's override and the viewer;
- `PlanTierCount` wants `ending` and `activeUnits`;
- `MembersSummary` lacks `cancelCutoffHours`;
- `Booking.billing` and `auditMember` belong in atm and the Worker (credit holds, replay), fed by a buzz-school facts read.

Not verified by that plan, to check before building: the Stripe dashboard URL format for a live key, and whether setting `receipt_email` on a charge resends a receipt.
