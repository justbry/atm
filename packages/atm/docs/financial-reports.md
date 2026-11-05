# Financial reports from the log

What exists, and what is still missing, for hledger journals, reports and a reconciliation made from the log. Moved here from `ROADMAP.md` in the roadmap split; the wording is the original. The built items (#46, #48, #49) are also in `CHANGELOG.md` (Unreleased); `ROADMAP.md` keeps each open item as one line. Related: `docs/log-and-r2.md` (the shipper, R2, the manifest), `docs/receipts.md` (tax lines), `docs/releasing.md`, `docs/README.md`.

## What exists

The pieces that exist on `dev` (not released): the handler writes decision and money events to the outbox (#49), the family service can write its own commands there (#46), `atm ship` puts them in the folder (#41), `atm journal` makes hledger journals, `atm report` prints the reports (#47; checked on the golden year, #42), `atm reconcile` compares them with Stripe (#48). Not yet true end to end, found by reading the code on `dev` at `acee2e6d5`:

## The money lines (#49)

- **The handler's log had no money lines at all; now it has them** (#49, `cbe774ffd`, on `dev`, not released). Before it, on `dev` at `acee2e6d5`, the handler wrote only `credit.*` and `plan.changed`; the postings for payments, refunds and payouts existed and only the golden year's generator used them, so the golden-year reports (2,138.54 USD in `assets:clearing:stripe-payouts`, 71.46 of fees) showed more than a handler-made log held. (An earlier version of this item said cash stayed in `assets:stripe` at the gross amount; that was wrong.) Now `invoice.paid` makes a `payment.succeeded`, a `charge.refunded` of a handled invoice a `payment.refunded`, and `payout.paid` (a new mapping) a `payout.paid`, checked end to end with the real handler, `atm ship`, `journalMonth` and hledger (260.00 income, 50.00 refunds, 7.84 fees, 202.16 in the payout clearing account). The review of #49 fixed an upgrade invoice booking its income to the old tier and a refund booking against a payment that was never booked.
  - [ ] The fee is the caller's: the family service passes `paymentFee` (it reads the charge's balance transaction before calling the handler, and answers 5xx when that lookup fails, so Stripe retries). Without it the payment books gross and says `fee_known: false`. A fee that arrives later is not booked.
  - [ ] Not built: money lines for disputes, a reversal of a payout that fails after `payout.paid`, non-USD (a non-USD invoice or payout is answered 200 `applied` with no money line, credits still granted), tax or customer-balance effects separated from the amount paid, and a `charge.refunded` without `previous_attributes.amount_refunded` books the whole running total. Real Stripe behaviour (`previous_attributes`, upgrade-invoice line order, Connect payout events) was not checked.

## The family service's own commands in the outbox (#46)

- **The family service's own commands can go in the outbox** (#46, `db745a526`, on `dev`, not released): `recordEngineCommand` (track, finalize, `confirmExpiredLock`, `updateBalance`) and `recordLapse`, inside the caller's transaction, with the handler's event shapes (replay reproduces a log that mixes both). Each command needs its own id, unique across the school (a repeated id throws instead of dropping an event); `reset` and `applyBillingPlan` are refused (handler only). Review of #46 fixed three bugs in id handling and the acceptance of a multi-feature `reset`.
  - [ ] The family service has to call them (`buzz-school`); until it does the log lacks the credit spend.

## The family service does not call the handler, the shipper or the recorders

- [ ] **The family service does not call atm's handler, the shipper or the new recorders.** atm's side is done (#47, `a9479d7d3`, on `dev`, not released): `atm ship` exits 0 done, 1 a conflict, 2 any other error, with `--json`; `outboxStatus` for a lag alert; `atm report`; the "Running it" recipe in the README and an adoption section in `UPGRADING.md`. Moving off its own grant rules (`school-billing/grant.ts`) is `buzz-school` work and open. The recipe's claims about `buzz-school`'s runtime were read, not run, and these were not verified: that Stripe retries on 409 and stops on 422 and 200, that `scheduleJob` accepts the README's snippet, that the handler's DDL passes its migration check under Litestream, the cron one-liner (it leaves `alert` and `$SCHOOL` undefined), and that hledger can be installed in its image (the recipe runs `atm report` off the machine).

## Reconciliation against Stripe (#48) and its known mismatch

- **A reconciliation against Stripe** (#48, `f76c1a21c`, on `dev`, not released): `reconcile` and `atm reconcile --root --school --month --stripe <dir>` compare paid invoices, refunds, disputes, payouts, fees and the net with Stripe's list output; exit 0 clean, 1 differences, 2 bad input (a missing Stripe file exits 2). It compares money, not credit balances or grants. The review of #48 fixed seven bugs, among them a missing file passing silently.
  - [ ] **Known mismatch, found by running the handler from #49 and reading its ids (not by running reconcile on it):** a handler-made `payment.refunded` carries the Stripe EVENT id (`payload.id` is `evt_…`, `idem` is `stripe:evt_…`), while `reconcile` matches refunds on the refund id (`re_…`). On a handler-made log every refund would show as a difference. Fix: the refund event should carry the charge or invoice id (and the refund id when Stripe gives one), and `reconcile` should match on it. Invoices (`in_…`) and payouts (`po_…`) match.
  - [ ] The `stripe` CLI commands in the README were not run; `--stripe-account` on `list` and some resource names are unconfirmed.

## Revenue timing

- [ ] **Revenue is booked when the invoice is paid.** A yearly plan's 12 months land as income at once and there is no deferred-revenue account, so the income statement is cash-basis. Credits are counted in units, not dollars, so the balance sheet shows no liability for unused credits. Owner decision: cash basis is enough, or book deferred revenue (and a dollar value for credits).

## Taxes

- [ ] **Taxes.** The normalized invoice has no tax lines (see the `receiptOf` questions); the reports show gross amounts.

## Real data

- [ ] **Real data.** Everything was run on fixtures and on one sandbox account. Run a month of a real school's outbox (a copy) through ship, journal and hledger, and compare its totals with Stripe's dashboard.

## The SQL side

- [ ] **The SQL side** (DuckDB over the log) has a schema and a skipped DDL test, no tested report, and nothing runs `duckdb` in CI.

## Keeping the folder

- [ ] **Keeping the folder.** `atm ship` writes to a folder on the host's disk: it needs a backup, or the R2 batches and the signed manifest above, before it is the record.

## The version of hledger

- [ ] **The version of hledger.** The report CSV goldens are the output of 1.52.1; CI pins it (#43). `atm report` (#47) prints the standard reports; it needs hledger installed and exits 2 when it is not.
