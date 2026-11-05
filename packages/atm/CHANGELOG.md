# atm changelog

Newest first. The version history before 0.3.0 and what a caller has to change for each release are in `UPGRADING.md`. Open work is in `ROADMAP.md`; detail, findings and reference material are in `docs/` (index: `docs/README.md`; how a release is made: `docs/releasing.md`).

**How the tables below were made.**

- **What is on `dev` since 0.3.0, with the merge commit and the first version that holds it** (a merge commit on `dev`, from `git log --first-parent`; `atm-v0.3.0` is `98f248803`, `atm-v0.4.0` is `170ec1a8c`, `atm-v0.5.0` is `0152d7a1c`). `dev` was at `f76c1a21c` when this was written. `package.json` said 0.5.0 then; #51 bumped it to 0.6.0 and `atm-v0.6.0` was tagged afterwards.

*Added when the roadmap was split (2026-11-05, from `git log --first-parent atm-v0.5.0..origin/dev`, not from the old roadmap text):* the sentence above was written when `dev` was at `f76c1a21c`. Since then four more pull requests merged into `dev`: #44, #50, #52 and #51 (rows in the 0.6.0 table below). #51 bumped `package.json` to 0.6.0. `atm-v0.6.0` was tagged at `a0e31d0be` after #58 to #61 and the other PRs below had merged.

  **How each was checked:** every PR above was merged on local gates (tests with `--timeout 60000`, `tsc`, Biome, the build, `knip`), run on the head and again on the tree with `dev` merged in; the inherited Autumn workflows never ran. The atm workflow ran on #43's head (`ea198874c`, run 42067266463, ubuntu-latest): hledger 1.52.1 installed with a matching sha256, 1061 pass, 51 skip, 0 fail, and the three `hledger agrees` tests passed (none skipped). Locally, on the merged tree of each: #41 1090 pass, #42 1094, #49 1124, #46 1138, #47 1166, #48 1223 (50 skipped, 0 failed in each). #41 to #49 had not run in CI when merged; `dev`'s own runs are the first. The skips are the staging R2 and SeaweedFS contract suites and the DuckDB DDL test (no credentials, no `weed`, no `duckdb`). Four of them (#46 to #49) were each reviewed with a high-effort pass that found and fixed real bugs before the merge.

## Unreleased

On `dev` after `atm-v0.8.0`, not released.

| PR | Merge commit | What |
|---|---|---|
| (this PR) | | scenario fixtures and KPI parity: the demo school Before University, eight seeded presets and ad-hoc scenarios (`atm simulate --profile`, `atm scenarios list\|describe\|schema\|kpis`), a fixture hash, a KPI spec (`kpis/school.v1.json`, `schema/kpis.v1.json`) computed by the atm fold, hledger and DuckDB with equal hashes, goldens in `tests/golden/scenarios/`, a `kpis.json` and `kpis.parquet` export. Details and what was dropped: `docs/scenarios.md`. The Stripe event builders and the in-memory store moved from `tests/` to `src/scenario/` (tests re-export them) |
| #77 | `534a55f52` | a non-USD dispute that moved money is answered 200 `non_usd` and leaves a `money.skipped` marker (`kind: "dispute"`) |
| #72 | `d186b73fc` | an end-to-end reconciliation matrix (tests and `docs/e2e-reconciliation.md` only, no source change): each case runs the handler, journal and `atm reconcile` against hand-computed numbers, and records six open discrepancies, D1 to D6 |

## 0.8.0

**Release 0.8.0**: bookable items, paid bookings and codes, with the fixes made on `dev` since 0.6.0. There is no 0.7.0 (the number is held by the open design PR #65). Tag `atm-v0.8.0` at `6e0dbaf752bd6f69cb9727bb8b1f9c33a7709727` (2026-11-05; the merge of #79 on `dev`). Tarball `https://github.com/justbry/atm/releases/download/atm-v0.8.0/atm-0.8.0.tgz`, sha256 `e62dbc30fee01d7673e247834f6b3c2d6a34a6bf45431f8afe54691ae4b3b52d`, sha512 `sha512-ASfl407z51lHWUHSrf5jxaVmq7eHXyf3erMP2ulDgfHOi6cjuvBUBQ5ROqKveRjTilBrqxlYX32SWHhFmvtMFw==` (checked by downloading the published asset: the sha256 matches and the sha512 starts the same; built with bun 1.4.4; a second pack of the same commit gave the same bytes). #79 is the release PR (version bump and notes). What a caller has to change: `UPGRADING.md`, "Moving to 0.8.0 from 0.6.0".

Everything on `dev` after the `atm-v0.6.0` tag (`a0e31d0be`):

| PR | Merge commit | What |
|---|---|---|
| #63 | `34deea3e4` | a cycle or update tier line of a subscription that is not the holder's is refused, 422 `tier_on_other_subscription` |
| #64 | `ca801dacc` | a feature id that spells `USD` is refused (the money commodity) |
| #69 | `2a65a90b2` | `env` in the keys of the handler's claims, indexes and outbox, with `migrateHandlerSchema` |
| #68 | `c964c7554` | a non-USD invoice, refund or payout is answered 200 `non_usd` and counted |
| #66 | `bc4cda27f` | the handler books a dispute and Stripe's dispute fee |
| #67 | `0d412924d` | the 0.8.0 design note, shared types and three policy fields (`cancelCutoffHours`, `noShow`, `lateCancel`) |
| #70 | `c99bd32d0` | bookable items: `validateBilling`, `quoteBooking`, hold, confirm, release, cancel, no-show and expired-hold commands |
| #71 | `b2afeb6ff` | a booking paid with one-time Checkout: `bookingCheckoutParams`, and the handler's `booking` outcome for the session and its refund (real sandbox fixtures) |
| #73 | `269e4862e` | `menu.codes` (member codes), discounts on invoice lines, `dollarGiftOps`, session gift codes |
| #74 | `b284c26d5` | real discounted invoices recorded: a line's `amount` is gross, so a discount never changes credits |
| #75 | `ae0890897` | review fixes: two gift codes never share a credit row; a dollar gift has an upper limit |
| #78 | `9d7256a9d` | review fixes: a refund of held credits is not undone by a release; a hold across a renewal or a lapse does not give back last cycle's credits; no cancel after the start; ex-members can book with gift and pack credits; `labels.booking` is the booking id |

**How the bookings and codes work was checked:** each part was merged on local gates (tests with `--timeout 60000`, `tsc`, Biome, the build, `knip`; the inherited Autumn workflows never ran), then an Opus reviewer hunted money edge cases (double spend under a held lock, release after expiry, refund after spend, a code redeemed twice, a discount with a quantity, rounding) and proved eight problems with failing tests; #75 and #78 fix them and add those tests. The merged tree (`9d7256a9d`) ran 1707 pass, 50 skip, 0 fail, with `hledger check --strict` on the booking events. Not verified: nothing was run against a real caller, a hosted Checkout, a delayed payment method or a non-USD booking (`ROADMAP.md`, "In atm after 0.8.0").

### Disputes' money lines (#66)

- **The handler books a dispute and Stripe's dispute fee**. `charge.dispute.created` makes a `payment.disputed` (`assets:stripe` -(amount + fee), `expenses:billing:disputes` +amount, `expenses:billing:dispute-fees` +fee) when Stripe withdrew money; `charge.dispute.closed` makes a `dispute.closed` (lost: nothing more; won: the amount comes back, the fee does not). The fee is in the dispute's own `balance_transactions` (recorded: amount 26000, fee 1500), so it is read from the event, not passed by the caller. `reconcile` counts the new account with the payment fees. Tested through the real handler with hand-computed amounts, shipper, journal and hledger (`check balanced accounts commodities`), and `reconcile` (`tests/handler-disputes.test.ts`). Not built: `charge.dispute.updated` / `funds_withdrawn`, closing statuses other than won and lost, non-USD (`docs/financial-reports.md`, "Disputes and Stripe's dispute fee").

### Non-USD is loud (#68)

- **A non-USD invoice, refund or payout is answered 200 `non_usd`, not `applied`**. Before, it was answered 200 `applied` with no money line and nothing said. Now the credits are granted as before (a refusal would hold back a paying family, and Stripe would retry a currency that cannot change), the response says `non_usd` with `body.skipped`, each line left out writes a `money.skipped` event (no postings), the claim keeps the outcome, `deps.warn` (default stderr) is called, and `reconcile` (`result.skipped`) and `atm report` (stderr) count them. Tested through the real handler for an invoice, its refund and a payout, with the shipper, `reconcile`, the CLI and hledger (`tests/handler-non-usd.test.ts`). Not built: books in another currency. `docs/financial-reports.md`, "Non-USD".

## 0.6.0

**Release 0.6.0**: tag `atm-v0.6.0` at `a0e31d0be95cefadb3ae45683bc649fb375d3710` (2026-11-05; the merge of #61 on `dev`). Tarball `https://github.com/justbry/atm/releases/download/atm-v0.6.0/atm-0.6.0.tgz`, sha256 `e55e2ac150a144a0bc9620c2429d2af0a5236817cb8018aa17fb19f887d62b82`, sha512 `sha512-iVpVLpFkX+av6e0BaUuarxdyLyfB+424i3U+sVO18LZJnvuLqbbVDw3oFbeqi5IzYDK/VUmfaUhZ96sGxV4pZQ==` (checked by downloading the published asset; a second pack gave the same bytes). Built with bun 1.4.4. Local gate on that commit before tagging: 1393 pass, 50 skip, 0 fail across 1443 tests; `tsc`, Biome, the build and `knip` clean; `bun run schema` left a clean tree. `UPGRADING.md` has "Moving to 0.6.0 from 0.5.0". Still to do in `buzz-school`: pin it in `bun.lock`, and see the first section of that upgrade note for what the family service does with the new pieces.

Everything on `dev` after the `atm-v0.5.0` tag (`0152d7a1c`):

| PR | Merge commit | First in | What |
|---|---|---|---|
  | #43 | `4f0151750` | 0.6.0 | CI installs hledger 1.52.1 (sha256-checked), so the hledger tests run there |
  | #41 | `4c0abe123` | 0.6.0 | the folder shipper: `shipOutbox`, `planOutbox`, `atm ship` |
  | #42 | `acee2e6d5` | 0.6.0 | hledger report tests on the golden year |
  | #39 | `557f974e8` | 0.6.0 | roadmap: R2 ignores `If-Match` on DELETE (checked against a staging bucket) |
  | #45 | `7184bf188` | after 0.5.0 | roadmap: release 0.5.0 |
  | #49 | `cbe774ffd` | 0.6.0 | the handler books `payment.succeeded`, `payment.refunded` and `payout.paid`; an optional `paymentFee` dependency supplies the fee |
  | #46 | `db745a526` | 0.6.0 | `recordEngineCommand` and `recordLapse`: the family service's own commands go into the outbox |
  | #47 | `a9479d7d3` | 0.6.0 | `atm report`, a cron-friendly `atm ship` (exit codes, `--json`), `outboxStatus`, the operations recipe |
  | #48 | `f76c1a21c` | 0.6.0 | `reconcile` and `atm reconcile`: a school's log against Stripe's records |
| #44 | `d0cf190dd` | 0.6.0 | roadmap: what shipped after 0.5.0 with merge commits; what reports from the log still need |
| #50 | `5729b4286` | 0.6.0 | several subscriptions on one customer: what works, what does not (docs) |
| #52 | `8acc2bbf6` | 0.6.0 | `reconcile` matches the refunds a handler-made log holds (the nearest equal Stripe refund, not the earliest) |
| #58 | `341799cca` | 0.6.0 | `lapseAlertEvents` calls `drawnAfter` once per lapse instant (with `I - 1`) and adds it to both totals, so a draw at exactly the lapse instant is no longer counted on one side only; its meaning is documented |
| #51 | `5f0a5aad8` | 0.6.0 | the 0.6.0 release commit: `package.json` 0.6.0 and the upgrade notes (`UPGRADING.md`, "Moving to 0.6.0 from 0.5.0") |
| #61 | `a0e31d0be` | 0.6.0 | `tests/overage-renewal.test.ts`: a renewal invoice for a holder in overage is refused 422 `rejected` (verified through the handler; docs and one roadmap line, no code change) |
| #53 | `23d047877` | 0.6.0 | docs: usage events as a ledger source (three feasibility spikes, with numbers) |
| #54 | `136172c0e` | 0.6.0 | a second golden year (12 families, disputes, a year boundary, a late event) and the refusal of a menu with colliding credit commodities |
| #55 | `942f7f20c` | 0.6.0 | `simulate` and `atm simulate`: a what-if replay of the log against a candidate catalog or draw order |
| #56 | `9d88af3d7` | 0.6.0 | docs: the roadmap split into `ROADMAP.md`, `CHANGELOG.md` and `docs/` |
| #57 | `ccb0e2774` | 0.6.0 | docs: local paths and an unsupported parity claim removed from the usage spikes |
| #59 | `5a320187c` | 0.6.0 | docs: pricing and positioning, and the decision to wait on usage events |
| #60 | `cefa43511` | 0.6.0 | the handler refuses a paid recurring add-on that nothing would grant (422 `addon_only_subscription`) |

- **A recurring add-on paid on its own subscription is refused, not recorded with no credits** (#60, `cefa43511`, in 0.6.0). The handler answers 422 `refused` with the new reason `addon_only_subscription` for a paid invoice with a recurring add-on line and no tier line, when the subscription is not the holder's own tier subscription (or the holder has none), and writes nothing. Before it, the sandbox spike of 2026-11-05 was answered 200 `applied` with no credits. What a caller does: `UPGRADING.md`, "Moving to 0.6.0 from 0.5.0".

### Built, with the detail

The text of the built items for #39 and #41 to #49, as the roadmap held it. The open to-dos that sat under them are in `ROADMAP.md` (one line each) and in `docs/log-and-r2.md` and `docs/financial-reports.md` (full text).

- [x] The folder shipper (`shipOutbox`, `planOutbox`, `atm ship`; outbox rows into one `batch-*.jsonl` per event date, plan then create-only put with `If-None-Match: *`, then mark `batch_key` and `shipped_at`). `atm journal` works end to end on a plain folder with no R2. Tested with `FolderStore`: determinism, rerun, crash between put and mark, two shippers, a conflicting key, and the real handler through `journalMonth` and hledger (`tests/ship.test.ts`). Details in `README.md` and `UPGRADING.md`.
- [x] Check whether R2 honours `If-Match` on DELETE. It does not (2026-11-05, a staging bucket through the S3 endpoint with a key scoped to it): a DELETE with a wrong ETag on an existing key answered 204 and removed the object; a right ETag, `If-Match: *` and `If-None-Match: *` also answered 204, and a wrong ETag on a missing key answered 204. Cloudflare's S3 compatibility page lists no conditional header for DeleteObject, so this was not a surprise. Production code did not depend on it: `R2Store.delete` reads the object, compares its SHA-256 and deletes unconditionally, so it guards against a wrong key, not a race (a writer that puts new bytes between the check and the delete loses them). A caller must delete only keys it owns, or use write-once keys. Not checked: `DeleteObjects` (the batch form) and the Workers binding's `delete()`.
- [x] **The handler's log had no money lines at all; now it has them** (#49, `cbe774ffd`, in 0.6.0). Before it, on `dev` at `acee2e6d5`, the handler wrote only `credit.*` and `plan.changed`; the postings for payments, refunds and payouts existed and only the golden year's generator used them, so the golden-year reports (2,138.54 USD in `assets:clearing:stripe-payouts`, 71.46 of fees) showed more than a handler-made log held. (An earlier version of this item said cash stayed in `assets:stripe` at the gross amount; that was wrong.) Now `invoice.paid` makes a `payment.succeeded`, a `charge.refunded` of a handled invoice a `payment.refunded`, and `payout.paid` (a new mapping) a `payout.paid`, checked end to end with the real handler, `atm ship`, `journalMonth` and hledger (260.00 income, 50.00 refunds, 7.84 fees, 202.16 in the payout clearing account). The review of #49 fixed an upgrade invoice booking its income to the old tier and a refund booking against a payment that was never booked.
- [x] **The family service's own commands can go in the outbox** (#46, `db745a526`, in 0.6.0): `recordEngineCommand` (track, finalize, `confirmExpiredLock`, `updateBalance`) and `recordLapse`, inside the caller's transaction, with the handler's event shapes (replay reproduces a log that mixes both). Each command needs its own id, unique across the school (a repeated id throws instead of dropping an event); `reset` and `applyBillingPlan` are refused (handler only). Review of #46 fixed three bugs in id handling and the acceptance of a multi-feature `reset`.
- [x] **A reconciliation against Stripe** (#48, `f76c1a21c`, in 0.6.0): `reconcile` and `atm reconcile --root --school --month --stripe <dir>` compare paid invoices, refunds, disputes, payouts, fees and the net with Stripe's list output; exit 0 clean, 1 differences, 2 bad input (a missing Stripe file exits 2). It compares money, not credit balances or grants. The review of #48 fixed seven bugs, among them a missing file passing silently.

## 0.5.0

**Release 0.5.0**: tag `atm-v0.5.0` at `0152d7a1c999eac25bfa16ce1fe3d0510fc4e572` (2026-11-05; first called 0.4.1; a minor release because the handler now refuses a `livemode` that disagrees with `env`). Tarball `https://github.com/justbry/atm/releases/download/atm-v0.5.0/atm-0.5.0.tgz`, sha256 `731b26d16f03d8ffff4a209f83dd2ff8d3c6bd9301c03cd66358814a22a330da`, sha512 `sha512-UJ4ZfdzdhuJhNBAmI9eeKNAyehJLqmJcmyBs69qttDY95iQOdRHKDGBOe1DSXVZWSLrxnzB1E9mNoHoNnY7Ehg==` (checked by downloading the published asset). Built with bun 1.4.4. It fixes the four findings of the `code-review high` of 0.4.0 (`lapseAlertEvents` judged a past instant on today's balances, so it now takes `drawnAfter`, replacing the `buzz-school` to-do above about giving it the lapse-time state; the webhook engine no longer throws on a malformed proration, and the public checks read only the lines they use; the handler refuses a `livemode` that disagrees with `env`). `UPGRADING.md` has "Moving to 0.5.0 from 0.4.0". The five smaller findings are fixed in it too: the unit heuristic in `raiseUnits` is gone (a fractional `perUnit` is still refused: menu allowances are whole, and allowing one would need a round-up in the engine's `upgradeUnits`), the alert sorts after the expiry (`revision + 1`), the `credit.depleted` schema keeps the two shapes exclusive, `env` is resolved once per public entry point, and `isTierPrice` runs once per line. Still to do in `buzz-school`: pin it (`buzz-school` #1318 pins 0.4.0 and has not been moved to 0.5.0 on purpose, for now) and pass `billingKeyMode` as `env`.

| PR | Merge commit | First in | What |
|---|---|---|---|
  | #38 | `896e28a6a` | after 0.4.0 | roadmap: release 0.4.0 |
  | #40 | `0152d7a1c` | 0.5.0 (tag `atm-v0.5.0`) | fixes from the review of 0.4.0 (lapse alert, webhook throws, `livemode`, five smaller) |

## 0.4.0

**Release 0.4.0**: tag `atm-v0.4.0` at `170ec1a8c5904e632a00f48180219d82e5d3b7f6` (2026-11-05). Tarball `https://github.com/justbry/atm/releases/download/atm-v0.4.0/atm-0.4.0.tgz`, sha256 `96e631c3e6cdb9e2bececfe2dea2957ee90cc167d0b1c44e3cf9c4daf4c34f8a`, sha512 `sha512-dSBJrJ4bk8Av6diVvj8+xiz8fMQIAA7xX4MddlXmRbqmEM+Ik5Xjn6d3NlwWPcsrUzQ0HVFxxi/eGwxPqR2pqQ==` (checked by downloading the published asset). Built with bun 1.4.4. It holds #21 to #37: the raise rule and its input checks, `portalConfigOf`, the caller-row import, `env`, `lapseAlertEvents`, replay of 0.3.0 logs, invoice links. `UPGRADING.md` has "Moving to 0.4.0 from 0.3.0". Still to do in `buzz-school`: pin it in `bun.lock`, pass `billingKeyMode` as `env`, and make the cron give `lapseAlertEvents` the state it gave `lapsedRows`.

| PR | Merge commit | First in | What |
|---|---|---|---|
  | #19, #20 | `da9b5aea3`, `54eb3172c` | 0.4.0 | roadmap after 0.3.0; bun 1.4.4 pinned on the release path |
  | #21 | `c5a4fe2b3` | 0.4.0 | a raise after a month/year plan switch; yearly raises pinned |
  | #22 | `2d28b4c50` | 0.4.0 | `portalConfigOf` |
  | #23 | `7b8efbae6` | 0.4.0 | `prorationPair`, `raiseUnits`; a raise after a pending decrease |
  | #24 | `fc5bae4fd` | 0.4.0 | caller-row import (`grantsStateFromCallerRows`); non-clover API versions refused |
  | #25, #32, #34 | `e3402d1ab`, `8c53b496a`, `1ad017780` | 0.4.0 | roadmap updates |
  | #26 | `e48a51904` | 0.4.0 | the atm test workflow in CI |
  | #27 | `e5822f1ed` | 0.4.0 | invoice links; `oneTimeCheckoutParams` |
  | #28 | `f0332fe04` | 0.4.0 | real Stripe deliveries replayed |
  | #29 | `1d50d5389` | 0.4.0 | replay reproduces what `handleStripeEvent` writes; reads 0.3.0 logs as far as they go |
  | #30 | `7a2adf231` | 0.4.0 | review fixes for #22 to #24 |
  | #31 | `778d6fd92` | 0.4.0 | tier change with a decrease pending |
  | #33 | `011b6bcf4` | 0.4.0 | `raiseUnits` and `prorationPair` throw on bad input |
  | #35 | `41758cbf7` | 0.4.0 | a pack that lapses unused makes `credit.depleted` |
  | #36 | `cbeda5a67` | 0.4.0 | optional `env` on the subject key |
  | #37 | `170ec1a8c` | 0.4.0 | the 0.4.0 release (tag `atm-v0.4.0`) |

### Built, with the detail

The text of the built items for #21 to #36, as the roadmap held it. `portalConfigOf` (#22) and the sandbox checks of the delivered events (#28) are written up in `docs/stripe-findings.md` ("portalConfigOf: validation and portal behaviour"; "Tier quantities verified with real data"). The replay fix (#29) is also described in `docs/review-findings.md` ("The eight-slice review").

- [x] A raise after a plan switch between monthly and yearly used the old plan's cycle dates (`if (interval !== state.interval)` ran after `moveTier` had already set the new interval): a raise 1 to 2 forty days after a monthly to yearly switch granted 0, and a yearly to monthly one prorated over the old year. Fixed (#21). A plain yearly raise already granted correctly.
- [x] A raise after a pending decrease compared against Stripe's old count and over-granted; it now compares against `GrantsState.quantity`, what the credits reflect (`membership.quantity` stays Stripe's).
- [x] The raise rule is exported as pure functions, `prorationPair` and `raiseUnits`, and `invoiceToCommands` calls them, so the family service (which uses only `runEngineCommand`) reuses it instead of copying it (justbry/buzz-school#1285's stopgap, #1307's `raiseLots`). Still to do in `buzz-school`: replace that copy once this is released.
- [x] An atm test workflow, `.github/workflows/atm-tests.yml`: tests (`--timeout 60000`), `tsc`, Biome and the build of `packages/atm` on a pull request that touches atm, the engine or `shared`, and on a push to `dev`; a draft runs nothing until it is ready. It runs where B4 Uni's CI does: the repository variable `CI_RUNNER` (a JSON label list such as `["self-hosted","b4u-sprite"]`) sends it to a Sprite box, unset it uses `ubuntu-latest`. Cause of the queued checks on 2026-11-05: `knip.yml` and the other inherited Autumn workflows ask for `peak-ubuntu-24.04-*` or `blacksmith-*` runners that this repository does not have, so every check of every PR sat queued. Still to do: [ ] register a Sprite box to THIS repository (runners are per repository under a user account; buzz-school's `deploy/sprite/ci-runner/add-box.sh`) and set `CI_RUNNER`; [ ] point `knip.yml` at the same runner switch, and disable or repoint the inherited workflows that cannot run here.
- [x] Fix replay of the log (#29; see the Review section). Every command is logged once with its whole mutation and replayed in each subject's revision order. Logs written by 0.3.0 are read, not rewritten: a log with a lost command (a revision gap) stops there with `ReplayGapError` (its `prefix` is the replay up to it), and a log without a gap replays and names the subjects whose last command may have a lost one after it (`lossySubjects`). What 0.3.0 never logged is not recovered. Checked by `tests/replay-log.test.ts`, `tests/replay-inputs.test.ts` (the fixture year) and `tests/replay-old-log.test.ts` (logs made with the 0.3.0 writer, `fixtures/log-0.3.0/`).
- [x] `env` is fixed to `"live"` in `handle.ts` and `grants.ts`. It was atm's (five sites: `handle.ts`, `stripe-webhook.ts` and three in `grants.ts`); it is now an option that defaults to `"live"` on `handleStripeEvent`, the grants functions, `menuCatalogRows` and `WebhookDeps`. The family service has `billingKeyMode` and still has to pass it; it has not yet.
- [x] Record the remaining sandbox cases: a tier change plus a quantity change in one update, a yearly raise and a decrease through a subscription schedule (#28). The events are in `fixtures/billing/stripe/recorded/delivered/` (`tier-and-quantity-change`, `yearly-raise`, `schedule-decrease`), replayed by `tests/stripe-recorded-delivered.test.ts`.

## 0.3.0

**Release 0.3.0**: tag `atm-v0.3.0` at `98f2488034e145260c3f9e8a2948160461665ef5` (2026-11-05), the tag-push workflow `Release atm` passed. Tarball `https://github.com/justbry/atm/releases/download/atm-v0.3.0/atm-0.3.0.tgz`, sha512 `sha512-nEBqWX7STue4O9U2bCrRr308yWgUkX8t+Cc2MPI4vgSTyv89lcdgOEMT1ASxCBx/Mksl8rbiS7e2dNTT1NIjOg==`. Built with bun 1.4.2 (the release script refuses another version). Still to do in `buzz-school`: pin it in `bun.lock`.

**Where the work was** (the status paragraph of the roadmap when 0.3.0 had just been released):

Everything through tier quantities is merged into `dev` (PRs #9 to #16, merge commits, bottom-up, on 2026-11-05; tier quantities in #17). 0.3.0 is released (tag `atm-v0.3.0`; the bump was #18). After the release, four more PRs merged the same day (#21 to #24: the yearly and plan-switch raise fix, `portalConfigOf`, the raise rule as `prorationPair` and `raiseUnits`, and the caller-adoption helper). CI did not start on them (all checks sat queued with no runner), so they were merged on local gates (tests, `tsc`, Biome, build, knip, each run on the head and again on `dev`). None of that is in a tag yet. What is left is the release of those changes, the verification items below and the `buzz-school` side.

## Before 0.3.0

### Priority items in atm

The built items that came before the tables above.

- [x] The billing layer, the reference webhook handler, the real-payload fixes, refund and dispute linkage, `credit.low` and `credit.depleted`, and the deduction order (details under Done).
- [x] Review each slice, push the branches, open the PRs, and merge bottom-up with merge commits (PRs #9 to #16). All eight slices were reviewed (see Review below); the findings are fixed in each slice.
- [x] **Tier quantities.** Vibes of Light sells three tiers at 1, 2 or 4 sessions a month; as separate tiers that is 9, past `MAX_TIERS = 4`. A tier gets `quantities` with its price and grants per unit (details in `UPGRADING.md`). Built from real quantity payloads captured in the sandbox (`fixtures/billing/stripe/recorded/`). Left out of 0.3.0: a quantity member in the replay fixture year (`fixtures/vibes-year`); the grants tests cover raise, decrease, renewal, yearly refund and the two-item subscription.

#### Adoption by a caller with its own grants

- [x] **Adoption by a caller with its own grants** (the family service's move onto `handleStripeEvent`, without regranting): `grantsStateFromCallerRows` builds a member's atm rows from `school_memberships` and `school_credit_lots`; a renewal after it is tested against the caller's rule (`tests/billing-adopt.test.ts`). Details and the list of what the rows do not carry in `UPGRADING.md`. Not released yet: it needs a version bump.
  - [x] An event from another Stripe API version is refused with the endpoint's version and the fix (recreate it at `2025-10-29.clover`) rather than read in a second, unchecked shape.
  - [x] Found in review (#24): the reference webhook handler answered 200 `ignored` to an older-API `invoice.paid` (its family metadata sits on `invoice.subscription_details`); it now answers 422 naming the endpoint's version and the fix. A missing `api_version` no longer reads as an empty version.

#### Invoice links and the one-time checkout

(The same four items are in `docs/receipts.md`, with the open checks and the receipt decision.)

- [x] **Invoice links and the one-time checkout** (spike on "invoices in the app, receipts", not built in `buzz-school`; the Idaho tutoring brief needs an itemised, dated, per-student receipt). Details in `README.md` ("Invoices and receipts") and `UPGRADING.md`. Merged into `dev` (#27); in 0.4.0.
  - [x] A subscription-mode Checkout on a connected account already makes an invoice with a hosted page and a PDF; for a direct charge the connected account is the issuer, so `checkoutParams` gains no `issuer` or `on_behalf_of` (read from Stripe's Connect invoicing and receipts docs; not run against a real connected account).
  - [x] `oneTimeCheckoutParams`: a payment-mode Checkout for one-time add-ons with `invoice_creation` on and our metadata on the invoice. Without it a gift or pack sold on its own makes no invoice and atm cannot credit it. `buzz-school` has no payment-mode school checkout yet (its one `mode=payment` is the platform's own Go Learn plan), so this is ahead of its caller. Not run against Stripe: field names are from the API docs, not checked against a response; post-payment invoices for Checkout are priced apart from Invoicing.
  - [x] `BillingInvoice.number`, `hostedInvoiceUrl`, `invoicePdf` from the `invoice.paid` mapping.

### Done

(The section "Done" of the roadmap, whole.)

#### Foundation
- [x] Test suite, `tsc`, Biome and the build are green (the early failures were already fixed on `claude/atm-cli`).

#### Stripe coverage
- [x] `customer.subscription.created/updated/deleted` record a `membership` in the grants state (status, the tier and interval the menu names for the price items, renewal or end date, event time). Nothing is granted from them; credits still come only from paid invoices. An event about another subscription, a replay, and an older event change nothing.
- [x] By design (B4 Uni "Default billing rules"): a partial refund and an open dispute change nothing; only a full refund and a lost dispute take unused credits back.
- [x] Mapping shapes checked against real payloads from a Stripe sandbox at API `2025-10-29.clover` (objects fetched at that version; the event envelope was rebuilt around them, see `fixtures/billing/stripe/recorded/README.md`). Three bugs the OpenAPI check and the synthetic fixtures had hidden are fixed:
  - [x] `charge.refunded`: a real charge has no `refunds` list, so every refund was refused and no credits were ever taken back.
  - [x] Invoice metadata: with checkout's `subscription_data.metadata` the invoice's own metadata is empty; it is on `parent.subscription_details.metadata`. Every real subscription invoice was refused as `missing_metadata`.
  - [x] Renewal period: a `subscription_cycle` invoice's own period is the previous one; the lines carry the new one. A real renewal reset a month early and granted nothing.
- [x] `invoice_payment.paid` links a payment to its invoice, so a refund or lost dispute finds its subject; ordering races answer a retryable 409.
- [x] A subscription-mode Checkout that carries a one-time gift line, verified in a real hosted Checkout (2026-11-05, test card): one `invoice.paid` has both lines (the gift line is `quantity 1`, `proration: false`, with a period equal to the first cycle's) and the handler grants the tier's credits and a separate gift lot of 1 visit that expires after `giftSessionMonths`; the gift line is not on the subscription's items. Webhook delivery and the schedule downgrade are verified above.

#### Deduction order and expiry
- [x] The engine's real draw order is documented in the README.
- [x] `balance-engine`: opt-in `org.config.deduction_order: "expiry"`; the default is unchanged. Listed in `UPSTREAM.md`.
- [x] `BillingPolicy.deductionOrder` (`expiry` default, or `engine`) and `commandOrg(policy)`.
- [x] `credit.expiration_changed`: a row's credits stay but their end date moved. The not-yet-paid membership status is named `incomplete`.

#### Alerts
- [x] `credit.low` and `credit.depleted` ledger events by crossing, with `BillingPolicy.lowCreditThreshold` (default 2, 0 turns `credit.low` off). Delivery stays with the caller.
- [x] Expiries by the clock make `credit.depleted` (not `credit.low`, on purpose, for now): `lapseAlertEvents` returns one event, `cause: "expired"`, for each instant rows lapse that take the feature's total from above 0 to 0 or below. Opt-in by the cron calling it; `lapseEvent` is unchanged.

#### Object store and the webhook handler
- [x] `Store`, typed errors and the 412 rules; `FolderStore` and `R2Store` (on `aws4fetch`); a contract suite that passes on the folder store and SeaweedFS 4.48.
- [x] Reference webhook handler for Bun/Node: verify the signature, claim the event id (a stale claim is taken over), then rows, outbox events and the claim's done mark in one SQLite transaction.
- [x] No per-subject compare-and-swap on R2: live balances stay in the caller's SQLite.

#### Bugs found on the way
- [x] `lapse:` and the expiry event's idem had no holder, so a second family's event collided with the first's.
- [x] `handleStripeEvent` accepted Stripe's `evt_` id as `eventId`, so its events failed envelope validation. It now refuses a non-ULID.
- [x] A cancel for an older subscription overwrote the live subscription's membership.

#### Packaging and scope
- [x] The README states atm is a credits and flat-subscription engine; `UPGRADING.md` lists what a 0.1.0 caller must change; `atm --version` reads `package.json`.
