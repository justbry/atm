# S8: what the ledger UI needs from atm and buzz-school

Input to `plans/ledger-ui/S8-contract.md`, the S8 interface between the two repos. This file is the UI side of that interface. It lists every call of the UI's data seam (`packages/ledger-ui/src/data/`, the `Reader` and `Writer` the fixtures implement today) and where S8 should get each one.

**Sources.** The "Source" column comes from one of two places:
- the contract files' own comments, which cite the buzz-school briefs in `plans/ledger-ui/design/buzz-school-briefs.md`;
- the S8 thread's check of both repos on 2026-11-06 (atm `origin/dev`, buzz-school `origin/main`).

**Statuses.**

| Status | Meaning |
| --- | --- |
| **exists** | The route or export is there today. |
| **gap** | Nothing provides it yet. |
| **confirm** | A route is named in the contract, but I have not checked that it exists. |

**Fallback.** What the UI does while a source is missing. The UI never derives a books figure and never shows a missing value as 0.

## Transport (from the S8 thread's plan)

- **Reads of atm data:** browser → ledger Worker, with the 5-minute ledger token (`POST /school-admin/ledger-token`, EdDSA, JWKS) as a bearer. The Worker reads R2 under `schools/<id>/` for the schools in the token only. Money objects sit under a separate finance prefix that a `finance:false` token never reads.
- **Reads of buzz-school data, and every write:** browser → `api.b4uni.com` with the `b4u_session` cookie, CSRF, and an `Idempotency-Key` on writes (`members.ts`: "the S8 adapter adds the CSRF token and the Idempotency-Key").

## Reads

| Reader call | UI file | Source | Status | Fallback / note |
| --- | --- | --- | --- | --- |
| `schools()` | `reader.ts` | Ledger token `schools[{id, role, finance}]`, plus school name, time zone, currency and credit unit | token: exists; school read: **gap** (S8 thread's "school-name read") | Switcher needs a name per school. |
| `dashboardOptions()` | `reader.ts` | Fixture presets only | n/a | Real data has one dataset per school: return no presets, so the scenario control does not render. |
| `kpiDocument(query)` | `kpi-document.ts` | atm Worker: `kpiDocument(rows, contributions, disclosure, audience, pin)`, moved from `gates/oracle.ts` into `atm/worker`. Needs the contributions view (holders per cell, largest share) and `tables.month.changes`, `order.revenue_by_tier`, `dispute_cost`. | **gap** (S8b) | Keep `gates/oracle.ts` as the independent check: the consistency gate compares the two. |
| `disclosure(school)` | `disclosure.ts` | buzz-school disclosure file (`books/disclosure.v1.json`) plus the school's stored override, and the viewer's audiences worked out at the clock | **gap** (design is a draft spec in buzz-school) | Every audience gate and lock reads this. Without it only the owner view is honest. |
| `bookings(query)` | `bookings.ts` | brief A2 `GET /school-admin/schools/<id>/bookings?from=&to=` joined with brief D `attendanceFor(bookingIds)` | exists (S8 thread) | Omits `billing` and `seriesLabel`: see gaps. |
| `menuVersions`, `menuVersion` | `plans.ts` | brief A3 `GET .../billing/menu/versions`, `.../versions/<n>` (with `stripe` facts per item) | exists | — |
| `planSummary(schoolId)` | `plans.ts` | `GET .../billing/members` per tier + members list (quantities) + atm collected, joined in the adapter | confirm | `PlanTierCount.monthlyMinor` (Monthly column at the prices members bought) is a **gap**: a server sum, never a UI multiply. `collected` is for one month only, so a quarter view names the server's month. |
| `members`, `people`, `membersSummary` | `members.ts` | brief A1 `GET .../billing/members-list`; people and roles (owners, admins) and the summary strip are not one route | members-list: exists; people, summary: **gap** | `MemberBalance.granted` and `rolledOver` are not in A1 (**gap**; the UI leaves "rollover N" out when absent). |
| `membersIncome(from, to)` | `members.ts` | atm finance view: income for a range | **gap** (S8a finance month view) | Finance and owner only. |
| `capabilities` | `members.ts` | brief A4 | exists | Must add `audit` and `resendReceipt` (as `not_built` until routes exist). |
| `financeGrants` | `members.ts` | brief B4 `GET/POST/DELETE .../finance-grants` | exists | — |
| `memberDetail(person)` | `members.ts` | Bookings (A2), payment history and refundable payments (Stripe or atm finance view), history (atm events) | **gap** as one read | `stripeDashboardUrl` is a **gap**; `null` disables "View in Stripe". |
| `invoiceItems`, `switchTiers` | `members.ts` | Published add-ons and tiers from the menu (A3) | confirm | `SwitchTier.monthlyCents` is per unit. |
| `auditMember(person)` | `members.ts` | Server replay of the person's events vs live balance and Stripe | **gap** | Capability `audit` = `not_built` disables the item ("Not available yet"). |
| `ledger(query)` | `ledger.ts` | atm Worker: `ledgerRows(events, filter, cursor)` over `readEventsFromStore`, names joined from members-list by `key` | **gap** (S8a) | Finance and owner only. |
| `incomeStatement(query)` | `ledger.ts` | atm finance month view with income by account and plan (the Worker cannot run hledger), plus `previous` and `previous.changes` when `compare` | **gap** (S8a) | `changes` is server-computed; the UI never subtracts. |
| `audienceReport(query)` | `ledger.ts` | The audience's `kpiDocument` (fix round 7 made Reports read it) | follows `kpiDocument` | The query has no preset; real data needs none. |
| `donors(query)` | `ledger.ts` | Totals by campaign: atm `fundraise.received` and `fundraise.paid_out`. Names: no source anywhere. | totals: atm events exist, view **gap**; names: **gap** | Below finance: the spread. Names stay unavailable until donor identity has a home. |
| `promos(query)` | `ledger.ts` | No route (briefs leave promo codes out; A4 answers `createPromo` with `not_built`) | **gap** | Tab stays on fixtures. |
| `schoolRules(school)` | `ledger.ts` | Cancel cutoff, no-show and late-cancel rules (also carried as `membersSummary.bookingRules` and `SchoolSettings.bookingRules`) | confirm | Bookings' waive dialog depends on `lateCancel`. |
| `memberPortal(query)` | `portal.ts` | A member-scoped route or the embed's `portalSession`; neither exists | **gap** | Balance `used` (spent this cycle), plan `pendingChange`, booking `held` and `paidCents`, and history rows come from atm events. Consistency check C5: no other family's key or amount. |
| `settings(school)` | `settings.ts` | The family service's school-admin settings route | confirm | — |

## Writes

| Writer call | UI file | Route | Status | Note |
| --- | --- | --- | --- | --- |
| `recordOutcome`, `cancelBooking` (Bookings) | `bookings.ts` | brief D admin outcome and admin cancel | exists | `waiveCutoff` only after the dialog, inside the cutoff, when `lateCancel` is `spend`. |
| `remindHost` | `bookings.ts` | — | **gap** | UI toasts only after the server accepts. |
| `refund`, `adjustCredits`, `sendInvoice` | `members.ts` | brief C money writes | exists | Refund is owner-only per briefs B and C; the mockup lets a finance admin refund (open ruling, S4). |
| `cancelBooking`, `recordOutcome` (Members) | `members.ts` | brief D | exists | Same routes as Bookings. |
| `grantFinance`, `revokeFinance` | `members.ts` | brief B4 | exists | — |
| `changeRole` | `members.ts` | — (not in the briefs) | **gap** | Make or remove admin, remove owner role. |
| `switchTier`, `cancelMembership`, `resumeMembership` | `members.ts` | brief A4 lists them as `not_built` | **gap** | — |
| `resendReceipt` | `members.ts` | — | **gap** | — |
| `saveMenu`, `publishMenu` | `plans.ts` | `POST .../billing/menu`, `POST .../billing/menu/publish` | exists | The typed PIN reaches `Plans.publish` but no route takes it: buzz-school checks the PIN on the session, so S8 opens the step-up before `publishMenu`. |
| `createPromo`, `disablePromo` | `ledger.ts` | — | **gap** | — |
| `download(file)` | `ledger.ts` | Browser save, no route | n/a | CSV and the audit's JSON report. |
| `portalChangeQuantity`, `portalCancelMembership`, `portalResumeMembership`, `portalCancelBooking` | `portal.ts` | Member-scoped writes | **gap** | — |
| `saveAccountingBasis`, `createKey`, `revokeKey`, `saveStripeKey`, `removeStripeKey`, `saveZeffyKey`, `removeZeffyKey`, `saveDisclosure` | `settings.ts` | The family service's school-admin routes | confirm | `saveDisclosure` answers `step_up` for a more-open Public change: PIN plus a mailed link. |

## Fields the UI carries that no source has yet

These ride on existing reads. The fixtures fill them; a real adapter leaves each one out, and the UI already handles its absence.

| Field | Contract | Where it should come from |
| --- | --- | --- |
| `Booking.billing` (free, held credits, paid) | `bookings.ts` | atm `credit.held` joined by booking id; `payment.succeeded` for a paid booking |
| `Booking.seriesLabel` ("weekly · 3 left") | `bookings.ts` | buzz-school's booking series, worded by the server |
| `PlanTierCount.monthlyMinor` | `plans.ts` | A server sum at the prices members bought |
| `MemberBalance.granted`, `rolledOver` | `members.ts` | atm credit lots (granted this period, carried in) |
| `MemberDetail.stripeDashboardUrl` | `members.ts` | Stripe customer id → dashboard URL, server-side |
| `IncomeStatement.previous.changes` | `ledger.ts` | The atm finance view, current less previous per line |
| `KpiTable.changes`, `order`, `dispute_cost` | `kpi-document.ts` | The atm KPI document builder (today in `gates/oracle.ts`) |
| Stripe product and price ids in the Plans Code view | `plans.ts` | Not needed: the UI shows which items are on Stripe from `MenuVersionBody.stripe` keys (parity N/A, line 367) |

## Rules the adapters must keep

- **Derived figures:** the UI derives no books figure. Every number, rounding, band (`<10`), hidden reason and change comes from the server. `gates/oracle.ts` and the consistency gate (C1–C5) are how the fixtures prove it; S8 should run the same checks against the real adapter.
- **Gating:** `Audience` gating is the server's (`disclosure`), not the UI's. A read the audience may not make must fail or return the lock, never data that the UI then hides.
- **Pending state:** every write shows as pending until the ledger ships (about 5 minutes). Reads must say when something is pending (the portal plan's `pendingChange`; a booking cancelled but not shipped), or the UI loses the "on its way" state on reload.
