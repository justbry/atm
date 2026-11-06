# buzz-school work for the ledger admin UI (four briefs, A to D)

Source: a Haiku audit of buzz-school (2026-11-05) against the admin web UI mockup (`plans/ledger-ui/mockup.html`, a very large single file: grep, never read whole). The UI will live on `ledger.b4uni.com` (same site as `api.b4uni.com`) for school owners and admins. buzz-school is the system of record for names, plans, memberships, bookings and money writes; atm holds the event log (R2). Audit spot-checked: no `/v1/refunds` call, no JWT/JWKS, buzz-school writes no atm events today.

## Shared rules (all four)

- Repo: github.com/justbry/buzz-school, code in `packages/family-service`. First run `git rev-parse --show-toplevel && git remote -v` and stop if it is not justbry/buzz-school.
- New branch `claude/<slug>`, ONE PR per brief (base: the repo's default integration branch, check `gh repo view --json defaultBranchRef`). Never push to main, never merge.
- Local gates for what you touch (bun test on touched tests, package typecheck, lint including `lint:zod`: no zod). Do not wait on GitHub Actions.
- Follow the repo's Cedar pattern: Cedar decides from facts TypeScript passes in, explicit forbids with `@id`, any Cedar fault is a refusal, parity tests. Same contracts as today: a non-admin or unknown school gets the same 404; owner-only routes give admins 403 `owner_only`. Admin JSON: `Cache-Control: private, no-store`. Ids only in audit rows and logs.
- Put new code in NEW files and register routes with the smallest diff, so parallel work merges cleanly. Migration numbers: next free is 0136. B owns 0136, D owns 0137. A and C need none (stop and ask if you do).
- Out of scope for everyone: emitting atm events or shipping to R2 (decided separately; see PR #1273 and the Cloudflare refactor), credit hold/spend for bookings (waits for atm 0.8.0), tier switch, promo codes, admin cancel/resume/quantity.
- Final report line: `PR <full URL>, head <SHA>, local gates <pass/fail list>`, plus a short "Gaps found" list (not done, assumptions, anything that contradicts the brief).
- Update the relevant `docs/features/*.md` page: what exists now, what is still not built.

## A. Admin read routes (read-only, no migration)

Read first: docs/features/school-billing.md, bookings.md; `src/routes/school-billing.ts` (the `admin()` guard ~:69, members counts ~:200, menu draft ~:155, public menu ~:217); `src/routes/school-admin.ts`; `src/school/admin-auth.ts`; migrations 0106/0119/0129/0131/0134. All GET, admin or owner via `requireSchoolAdmin`, per-person rate limit like the other school-admin routes.

1. `GET /school-admin/schools/<id>/billing/members-list?status=&cursor=&limit=` returns `{ members:[{ key:"family:<familyId>", familyId, profileId|null, name /* nickname, else family name */, tierId, tierName, quantity, interval, status, currentPeriodEnd /*unix s*/, cancelAtPeriodEnd, menuVersion, balances:[{featureId, featureName, unit:{one,other}, available, held, expiresAt|null}] }], nextCursor }`. `key` MUST equal the atm customer id (`src/school-billing/subject.ts`: `family:<familyId>`); the UI joins this list to ledger events by it. Live lots only, same rules as `GET /family/memberships`. Page cap 100.
2. `GET /school-admin/schools/<id>/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD` (range max 62 days, in the school's time zone) returns `{ bookings:[{ id, eventId, service, startsAt, endsAt, hosts:[{id,name}], attendee:{key,name}|null, guest:boolean, state, cutoffMinutes /* booking_events.change_cutoff_min */, seriesId|null }] }`. No billing fields exist yet; do not invent any.
3. `GET .../billing/menu/versions` (version, publishedAt|null, savedAt) and `GET .../billing/menu/versions/<n>` (full body including non-public tiers; stripe id presence only).
4. `GET .../ledger/capabilities` returns `{ role, stripeConnected, actions:{ <action>:{ allowed, reason? } } }` for: refund, invoice, adjustCredits, releaseBooking, recordOutcome, cancelMembership, changeQuantity, switchTier, publishMenu, createPromo. Today's rules; anything unbuilt is `reason:"not_built"`. Keep the table in ONE small module so sibling PRs flip entries in one line.

Tests: identical 404 for non-admin and unknown school; owner vs admin; pagination; range cap; `key` format equals subject.ts; no query touches another school's rows.

## B. Ledger token, JWKS, Cedar `ledger` area, finance grants (migration 0136)

Why: the UI's Cloudflare Worker must learn which schools a person may see, with what role. Read first: docs/features/school-admin-roles.md (Cedar slice 7), `src/policy/school-admin/*`, `test/policy-school-admin-parity.test.ts`, `src/school/admin-auth.ts`, `src/creator/relay.ts` (rosterOf, listing), `src/http.ts` (cookie `b4u_session`: host-only, SameSite=Lax; CORS `WEB_ORIGINS`), `src/config.ts` ~:735, and the gateway secret-rotation `PREV` pattern in the repo.

1. `POST /school-admin/ledger-token` (cookie session, CSRF, adult, PIN set): returns `{ token, expiresAt, schools:[{ id, role:"owner"|"admin", finance:boolean }] }`. Token: <= 5 min EdDSA (Ed25519) JWT, `iss` per environment, `aud:"atm-ledger"`, `kid`, opaque `sub` (never an email), claim `schools`. Schools come from the live roster; find and state the cost of listing every school a person administers. Rate limit, audit row, key from a secret with `PREV` support.
2. `GET /.well-known/ledger-jwks.json` (public, cacheable), current and previous keys.
3. New Cedar area `src/policy/ledger/` (additive only): ViewLedger (owner or admin), ViewFinancials (owner, or admin with finance grant), MoneyWrite (refund, invoice, adjust credits: owner only, door open for a grant), ManageBookings (owner or admin). Facts: role, finance_grant, pin_open. Parity test.
4. Migration 0136 `school_admin_grants(school_id, subject, grant, granted_by, granted_at, revoked_at)`; owner-only `GET/POST/DELETE /school-admin/schools/<id>/finance-grants` with PIN and step-up. A removed grant applies at the next token mint and the next read (state the 5 min bound).
5. Document and test that `ledger.b4uni.com` and `ledger-staging.b4uni.com` are in `WEB_ORIGINS` per environment. Do not add frame-ancestors to the family service; note where framing headers would go for the web app.

Tests: token verifies against JWKS; expired, wrong aud/iss, tampered, unknown kid; roster removal; PIN-locked session; non-admin same 404; grant add/revoke; Cedar parity table; key rotation.

## C. Admin money writes (no migration)

Real money: owner-only, idempotent, audited, Stripe fakes only, never a live key. Read first: school-billing.md, `src/routes/school-billing.ts`, `src/school-billing/{connect,grant,webhook,apply,subject,publish}.ts`, `src/school/admin-auth.ts` (`{owner:true}`, step-up, PIN). Until B's Cedar lands, put authorization in ONE function `requireMoneyAdmin(c, schoolId, action)` (owner-only, PIN open, step-up) with a comment that B's MoneyWrite replaces its body. All POST, CSRF, per-school rate limit, `Idempotency-Key` required and passed to Stripe.

1. `POST /school-admin/schools/<id>/billing/refunds {paymentIntentId|chargeId, amountCents, reason, note}`: charge must belong to this school's Stripe account and a membership/invoice of this school; amount > 0 and <= refundable remainder read from Stripe; answers `{refundId, status, refundedCents, remainingCents}`. Do NOT change credit behavior (full refund claws back via the webhook, partial changes none): add a test that the webhook still handles the event, document the rule. Add `Refunds: write` to `packages/web/src/lib/school-billing/validate.ts` and make the server check it on first use with 409 `stripe_permission_missing`.
2. `POST .../billing/credits/adjust {membershipId, featureId, amount, kind:"goodwill"|"gift"|"correction", note}`: owner-only, through the engine like `grant.ts`, never below zero, gift positive, note required (>= 3 chars) stored in the audit row, replay-safe.
3. `POST .../billing/invoices {familyId, addonId, memo?}`: Stripe invoice for ONE published add-on for that member, finalized and sent, metadata (b4u_school, family_id, addon_id, source:"admin_invoice"); grant only when PAID (extend the webhook minimally if needed). If this is more than about a day, ship 1 and 2 and leave 3 as a named TODO with a `not_built` reason.

Tests with the repo's Stripe fake: refund full/partial/over-refund/other school's charge/missing permission/idempotent retry; adjust below zero/gift negative/missing note/replay; invoice paid then replayed; admin gets 403; non-admin 404.

## D. Booking admin writes (migration 0137)

Bookings involve minors: read the safeguarding rules first; change NO learner-, teen- or guardian-facing default and no member-side route (stop and report if you think you must). Read first: bookings.md, migrations 0106/0119/0129, `src/bookings/{store,who}.ts`, `src/routes/bookings.ts` (~:248, ~:374, `partyBooking` ~:132), `src/routes/booking-events.ts`, `src/policy/bookings/*`.

1. Migration 0137 `booking_attendance(booking_id PK/FK, state CHECK IN ('attended','no_show'), recorded_by, recorded_at, note NULL)`; upsert within 30 days with an audit row.
2. `POST /school-admin/schools/<id>/bookings/<bookingId>/outcome {state, note?}`: admin or owner; booking belongs to THIS school, is `confirmed` and has started. No credit effect: respond `creditEffect:"not_wired"`.
3. `POST .../bookings/<bookingId>/cancel {reason, waiveCutoff?}`: reuse the existing end/cancel path with an admin actor (`writeEnd` ~:374-391), `cancelled_by` records the admin; notify parties exactly as the member cancel does, no new messages to minors. Add any new Cedar action (e.g. AdminCancel) to `policy/bookings` additively with a parity-style test.
4. Export `attendanceFor(bookingIds)` so A's bookings list can include attendance; do not edit A's files.

Tests: attended and no_show; future booking rejected; unconfirmed rejected; another school's booking 404; non-admin 404; upsert inside and after 30 days; existing member booking tests still pass.
