# End-to-end reconciliation matrix

Does the money the reference handler books agree with what hledger reports, with what Stripe says, and with arithmetic done by hand? This is the answer for every handler path that moves money, case by case, where it does not, and why. Written for someone who has not read the code. Related: `docs/financial-reports.md` (what exists and what is missing), `docs/log-and-r2.md` (the shipper), `docs/README.md`.

The matrix is a test, not a report: `tests/e2e-reconcile.test.ts` runs it, `tests/e2e-cases.ts` and `tests/e2e-recorded-cases.ts` hold the cases, and `tests/golden/e2e/<case>/` holds what each case printed. `UPDATE_GOLDEN=1 bun test tests/e2e-reconcile.test.ts` rewrites the goldens after a deliberate change. It needs hledger (1.52.1 is what the goldens were made with) and skips without it.

## What each case does

Each case delivers signed Stripe events to the real handler (`handleStripeWebhook`, an in-memory SQLite), then follows the money three ways.

1. **The handler's own books.** The outbox goes through `atm ship` into a folder, `atm journal` and `atm report` (`reportMonth`: income statement, balance sheet, credits) make the journals and hledger prints the reports, and the refunds and disputes registers come from `hledger reg`. Checked: `hledger check balanced accounts commodities` passes; every credit commodity sums to zero over the whole book; the credit balances of the replayed log (`replayEvents`) are the credit register's `credits:avail:*` and `credits:held:*`.
2. **`atm reconcile` against a Stripe side built by hand.** Stripe's invoices, refunds (with their own `re_` ids, charge and payment intent), payouts, disputes and balance transactions (amount, fee, net) are written out in the case, in Stripe's documented shapes, per month. They are never derived from the events. The shipped folder and the Stripe files go through `reconcileFolder`, the code behind `atm reconcile --root --school --month --stripe`. As a check on the oracle itself, the test also asserts that the case's Stripe balance transactions add up to the hand numbers (Stripe's balance, fees, refunds).
3. **Hand numbers.** Every case lists, in its body, what the books must say: income by account, refunds, disputes, fees, `assets:stripe`, the payout clearing account, net income and credit balances, with the arithmetic in a comment (for example `260.00 - 50.00 - 7.84 = 202.16`). A case that crosses a month also has the hand numbers of each month's column of the monthly income statement. Goldens are the output of the code, so they are not trusted on their own: the hand numbers are asserted first.

A case with a defect (`DISCREPANCY`) or one another branch is fixing (`KNOWN`) asserts today's behaviour: its `pinned` numbers must be exactly what the books say, and must differ from the hand numbers (so a fix makes the test fail, and the failure says which pin is stale); its `reconcile` list names the differences `atm reconcile` must print. The comment `// DISCREPANCY: <id>` marks each one in `tests/e2e-cases.ts`. No case is skipped (the file as a whole skips only when hledger is not installed, like the other hledger tests), and nothing in `src/` was changed.

Each case directory holds: `events.csv` (the handler's decisions, one line each: date, type, idem, postings), `income-statement.csv`, `balance-sheet.csv`, `credits.csv`, `refunds-register.csv` and `disputes-register.csv` (only when not empty), `income-statement-monthly.csv` and `balance-sheet-monthly.csv` (cases that cross a month) and `reconcile.txt` (`atm reconcile`'s own text for each month). `tests/golden/e2e/matrix.csv` is the table below in cents-and-dollars, hand beside report, one row per book.

## The result

Of 38 cases (39 books; one case has two schools), 26 are OK, 6 are KNOWN and 6 are DISCREPANCY. Every path that moves money through a payment, a refund (partial, two, to full, full), a payout, a duplicate, a retry, a link arriving early or late, a month boundary, a yearly invoice, a second school and an erasure agrees three ways. The discrepancies are: disputes (KNOWN K1), other currencies (KNOWN K2), and six more found here (D1 to D6): no fee unless the caller passes one, a refund event without `previous_attributes`, a payout that fails, a refused invoice, another product's invoice in reconcile, and one income account for a whole invoice.

How to read the table: dollars; `-` is zero; **bold `a / b`** is where the books differ, `a` what the hand number says and `b` what the handler's books say. `non-usd` is in euro on both sides. `Stripe` is `assets:stripe`, `clearing` is `assets:clearing:stripe-payouts`. `booked at` is where in `src/` the number is made (`money.ts` is `src/billing/money.ts`, `postings.ts` and `reconcile.ts` are in `src/ledger/`, `handle.ts` and `grants.ts` in `src/billing/`, `stripe-webhook.ts` in `src/handler/`). The `recorded-*` cases deliver Stripe's own scrubbed sandbox events (`fixtures/billing/stripe/recorded/delivered`), in the order Stripe sent them, 409 retries included.

| case | what | income | refunds | disputes | fees | Stripe | clearing | net | reconcile | verdict | booked at (src/) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| create | subscription create invoice | 260.00 | - | - | 7.84 | 252.16 | - | 252.16 | clean | OK | money.ts:64 -> postings.ts:195 |
| renewal | monthly cycle renewal | 520.00 | - | - | 15.68 | 504.32 | - | 504.32 | clean | OK | money.ts:64 -> postings.ts:195; grants.ts:776 |
| upgrade | upgrade invoice: sparkle-2 to sparkle-4 ten days in (proration) | 436.13 | - | - | 13.25 | 422.88 | - | 422.88 | clean | OK | money.ts:45 (income kind), money.ts:64 |
| quantity-raise | quantity raise: two units to four ten days in | 872.26 | - | - | 25.90 | 846.36 | - | 846.36 | clean | OK | money.ts:64; grants.ts:776 |
| quantity-decrease | quantity decrease at renewal: four units to two | 1560.00 | - | - | 45.84 | 1514.16 | - | 1514.16 | clean | OK | money.ts:64; grants.ts:776 |
| addon-recurring | add-on purchase: glow bought ten days into the cycle | 293.87 | - | - | 9.12 | 284.75 | - | 284.75 | clean | OK | money.ts:45, money.ts:64 |
| create-with-addon | one invoice for a tier and a recurring add-on | 310.00 | - | - | 9.29 | 300.71 | - | 300.71 | clean | DISCREPANCY D6 | money.ts:45-62 (one income account per payment) |
| addon-once | add-on purchase: a one-time pack, no subscription | 90.00 | - | - | 2.91 | 87.09 | - | 87.09 | clean | OK | money.ts:45, money.ts:64 |
| refund-partial | partial refund | 260.00 | 50.00 | - | 7.84 | 202.16 | - | 202.16 | clean | OK | money.ts:112 -> postings.ts:205 |
| refund-two-partials | two partial refunds of one payment | 260.00 | 80.00 | - | 7.84 | 172.16 | - | 172.16 | clean | OK | money.ts:123 (amount less previous) |
| refund-partials-to-full | two partial refunds that add up to the whole charge | 260.00 | 260.00 | - | 7.84 | -7.84 | - | -7.84 | clean | OK | money.ts:123; grants.ts:1599 (credits) |
| refund-full | full refund | 260.00 | 260.00 | - | 7.84 | -7.84 | - | -7.84 | clean | OK | money.ts:112; grants.ts:1599 (credits) |
| refund-before-link | refund before its payment is linked: 409, then the retry | 260.00 | 50.00 | - | 7.84 | 202.16 | - | 202.16 | clean | OK | stripe-webhook.ts:394 (409 unmatched_payment), money.ts:112 |
| link-before-invoice | invoice_payment.paid before invoice.paid | 260.00 | 50.00 | - | 7.84 | 202.16 | - | 202.16 | clean | OK | stripe-webhook.ts:726 (409 unmatched_invoice), money.ts:112 |
| duplicate-delivery | duplicate deliveries of every event type | 260.00 | 50.00 | - | 7.84 | - | 202.16 | 202.16 | clean | OK | stripe-webhook.ts:437 (claim done), handle.ts:213, outbox.ts:33 (idem) |
| failed-delivery-retry | failed delivery, then the retry | 260.00 | - | - | 7.84 | 252.16 | - | 252.16 | clean | OK | stripe-webhook.ts:552 (feeOf throws), :439 (takeover) |
| dispute-opened | dispute opened | 260.00 | - | **260.00 / 0.00** | **22.84 / 7.84** | **-22.84 / 252.16** | - | **-22.84 / 252.16** | 3 differences | KNOWN K1 | handle.ts:289-302 (money: []); postings.ts:210 never reached |
| dispute-lost | dispute lost | 260.00 | - | **260.00 / 0.00** | **22.84 / 7.84** | **-22.84 / 252.16** | - | **-22.84 / 252.16** | 4 differences | KNOWN K1 | handle.ts:289-302; grants.ts:1619 (credits only) |
| dispute-won | dispute won | 260.00 | - | - | **22.84 / 7.84** | **237.16 / 252.16** | - | **237.16 / 252.16** | 4 differences | KNOWN K1 | handle.ts:289-302; postings.ts:215 never reached |
| payout-with-fees | payout.paid after a payment with a fee | 260.00 | - | - | 7.84 | - | 252.16 | 252.16 | clean | OK | money.ts:155 -> postings.ts:223 |
| payout-several-payments | one payout covering three payments of three families | 650.00 | - | - | 19.75 | - | 630.25 | 630.25 | clean | OK | money.ts:155 -> postings.ts:223 |
| payout-across-months | a payout created in January that arrives in February | 260.00 | - | - | 7.84 | - | 252.16 | 252.16 | clean | OK | money.ts:155 (dated by the event, `created`) |
| month-boundary | month boundary: Denver's 31 January is UTC's 1 February | 390.00 | 50.00 | - | 11.91 | - | 328.09 | 328.09 | clean | OK | postings.ts:78 (`date: localDate(eventMs, tz)`) |
| yearly | yearly invoice | 2600.00 | - | - | 75.70 | 2524.30 | - | 2524.30 | clean | OK | money.ts:64 (cash basis); grants.ts:112 (12 x allowance) |
| second-school | the same family in a second school | 260.00 | - | - | 7.84 | - | 252.16 | 252.16 | clean | OK | stripe-webhook.ts:334 (school_mismatch) |
| second-school (sch_two) | the same family in a second school | 130.00 | - | - | 4.07 | - | 125.93 | 125.93 | clean | OK | stripe-webhook.ts:334 (school_mismatch) |
| erasure | erasure after payments | 260.00 | 50.00 | - | 7.84 | - | 202.16 | 202.16 | clean | OK | postings.ts:246 (subject.erased: no postings) |
| non-usd | non-USD invoice and payout | **260.00 / 0.00** | - | - | **7.84 / 0.00** | **52.16 / 0.00** | **200.00 / 0.00** | **252.16 / 0.00** | 2 differences | KNOWN K2 | money.ts:77 (invoice), money.ts:162 (payout) |
| fee-unknown | payment booked without a fee (the caller passes none) | 260.00 | - | - | **7.84 / 0.00** | **0.00 / 7.84** | 252.16 | **252.16 / 260.00** | 1 difference | DISCREPANCY D1 | money.ts:78, stripe-webhook.ts:552 |
| refund-no-previous | two refunds of an event without previous_attributes | 260.00 | **80.00 / 130.00** | - | 7.84 | **172.16 / 122.16** | - | **172.16 / 122.16** | 2 differences | DISCREPANCY D2 | money.ts:123 |
| payout-failed | payout.paid, then the payout fails | 260.00 | - | - | 7.84 | **252.16 / 0.00** | **0.00 / 252.16** | 252.16 | 1 difference | DISCREPANCY D3 | stripe-webhook.ts:155-165 (`payout.failed` not handled) |
| refused-invoice | a paid invoice the menu does not know | **260.00 / 0.00** | - | - | **7.84 / 0.00** | **252.16 / 0.00** | - | **252.16 / 0.00** | 3 differences | DISCREPANCY D4 | handle.ts:123-135 (422 unmatched_line) |
| foreign-invoice | another product's invoice on the same Stripe account | - | - | - | - | - | - | - | 3 differences | DISCREPANCY D5 | reconcile.ts:506 (every Stripe invoice is compared) |
| zero-invoice | an invoice that paid nothing (100% discount) | - | - | - | - | - | - | - | clean | OK | money.ts:77 |
| subscription-canceled | subscription canceled after a payment | 260.00 | - | - | 7.84 | 252.16 | - | 252.16 | clean | OK | grants.ts:1426 (credits only) |
| recorded-full-refund | recorded: full refund, the link and the refund arriving before the invoice | 260.00 | 260.00 | - | 7.84 | -7.84 | - | -7.84 | clean | OK | money.ts:112; grants.ts:1599 |
| recorded-partial-refund | recorded: partial refund of 50.00 | 260.00 | 50.00 | - | 7.84 | 202.16 | - | 202.16 | clean | OK | money.ts:112 |
| recorded-dispute-lost | recorded: dispute opened and lost | 260.00 | - | **260.00 / 0.00** | **22.84 / 7.84** | **-22.84 / 252.16** | - | **-22.84 / 252.16** | 4 differences | KNOWN K1 | handle.ts:289-302 |
| recorded-dispute-won | recorded: dispute opened and won, the fee not returned | 260.00 | - | - | **22.84 / 7.84** | **237.16 / 252.16** | - | **237.16 / 252.16** | 4 differences | KNOWN K1 | handle.ts:289-302 |

`foreign-invoice` is an empty book: the school's own books are right (nothing is booked) and only reconcile is noisy (D5).

## Discrepancies

Product bugs are reported here, not fixed. `K1` and `K2` are being fixed on other branches; the goldens of their cases are the only lines a rebase onto those branches should change (see the end of this section).

### K1 (KNOWN): a dispute moves no money in the books, and its fee is never booked

- **Cases:** `dispute-opened`, `dispute-lost`, `dispute-won`, `recorded-dispute-lost`, `recorded-dispute-won`.
- **Where:** `src/billing/handle.ts:289-302` (the `BillingDispute` decision returns `money: []`; only a lost dispute takes credits back, `src/billing/grants.ts:1619`). The posting rules for `payment.disputed` and `dispute.closed` exist (`src/ledger/postings.ts:210-222`) and are used by the golden fixtures, but no handler path makes either event. `src/handler/stripe-webhook.ts` says so in its header ("Not built: ... disputes' money lines").
- **Why:** the handler maps a dispute to a credit decision only. Stripe takes the disputed amount out of the balance when the dispute opens and charges a dispute fee (a recorded dispute, `fixtures/billing/stripe/recorded/delivered/dispute-lost/04-charge.dispute.created.json`, carries a balance transaction of -26,000 with a fee of 1,500). A win returns the 26,000 and not the fee (`dispute-won/05-charge.dispute.closed.json`: +26,000, fee 0).
- **Impact in money, per dispute of 260.00:** open or lost, `assets:stripe` and net income are 275.00 too high (260.00 not taken out, 15.00 fee not booked); the dispute and the income stay in the books as if the payment had stood. Won: 15.00 too high (the fee). A lost dispute also takes the family's credits back, so the credits say "refunded" while the money says "paid". `atm reconcile` does notice: `missing_in_log dispute`, and the fees and net totals differ.
- **Fix, being built on `claude/atm-dispute-fee`:** book `payment.disputed` when the dispute opens and the fee from the dispute's balance transaction (`expenses:billing:stripe-fees`, which is where reconcile compares fees), and `dispute.closed` with `won` returning the amount only. The posting rules are ready.
- **Rebase guide:** each dispute case pins its numbers in its own `pinned` block and its differences in its `reconcile` list (all marked `// DISCREPANCY: K1`). When the fix lands: delete `pinned`, set `reconcile` to `[]`, change the verdict to `"OK"` and drop `discrepancies`, then `UPDATE_GOLDEN=1`. Only the five dispute directories change (`events.csv` gains the dispute lines, `balance-sheet.csv` and `income-statement.csv` the money, `disputes-register.csv` appears, `reconcile.txt` goes clean), plus their rows in `matrix.csv`.

### K2 (KNOWN): a non-USD invoice or payout is booked nowhere, and answered 200 applied

- **Case:** `non-usd` (a 260.00 EUR invoice with a 7.84 fee and a 200.00 EUR payout).
- **Where:** `src/billing/money.ts:77` (`invoice.currency !== USD` makes no event) and `:162` (`payout.currency === USD`); `src/billing/handle.ts` still grants the credits. The answer is `200 applied`.
- **Why:** postings are USD only.
- **Impact:** every cent of foreign-currency revenue and every foreign payout is missing from the books while the member receives their credits (260.00 EUR of income, 7.84 EUR of fees, 200.00 EUR of cash in the case). Nothing says so except `atm reconcile` (`missing_in_log invoice`, `not_in_log payout`).
- **Fix, being built on `claude/atm-non-usd-loud`:** answer loudly instead of 200. The rebase touches the `non-usd` directory and its row only.

### D1: no fee unless the caller passes one

- **Case:** `fee-unknown`.
- **Where:** `src/billing/money.ts:78` (`fee ?? 0`) and `src/handler/stripe-webhook.ts:552` (`feeOf`: no `paymentFee` dependency, no fee). Documented in `docs/financial-reports.md` ("The fee is the caller's").
- **Why:** no webhook event carries Stripe's fee; it is on the charge's balance transaction, which the family service has to read first. Without it the payment is booked gross (`fee_known: false`) and a fee learned later is not booked.
- **Impact:** about 3% of every payment (7.84 on 260.00). Net income is 7.84 too high per payment, and `assets:stripe` can never reach zero after a payout: it keeps the fees for ever (7.84 in the case). `atm reconcile` notices (`not_in_log fees`).
- **Fix:** make the fee not optional in live mode (answer 5xx until the balance transaction is readable, which the documented family-service recipe already does), or book a later fee as its own event (`payment.fee_adjusted`).

### D2: `charge.refunded` without `previous_attributes` books the running total

- **Case:** `refund-no-previous` (a refund of 50.00 and one of 30.00, whose events say 50.00 and 80.00 refunded in all).
- **Where:** `src/billing/money.ts:123` (`refund.amount - (refund.previousAmount ?? 0)`).
- **Why:** the amount of one refund is the charge's refunded total less what it was before the event; with no `previous_attributes` the "before" is taken as 0. Documented as "Not built" in `docs/financial-reports.md`.
- **Impact:** the second refund is booked at 80.00 instead of 30.00: refunds 50.00 too high, `assets:stripe` and net income 50.00 too low in the case. Latent: every recorded `charge.refunded` carries `previous_attributes`; whether live Stripe ever omits it is not known. `atm reconcile` notices (`amount_differs refund`, `amount_differs net`).
- **Fix:** keep the refunded total per charge in the holder's grants row and book the difference, or refuse (422 `bad_event`) a `charge.refunded` that carries no `previous_attributes` when the charge has had a refund.

### D3: a payout that fails after `payout.paid` is not reversed

- **Case:** `payout-failed`.
- **Where:** `src/handler/stripe-webhook.ts:155-165` (`payout.failed` is not in `HANDLED_TYPES`: answered `200 ignored`, nothing recorded). Documented as "Not built".
- **Why:** only `payout.paid` is mapped.
- **Impact:** the payout stays in the clearing account as if it had reached the bank: 252.16 in the case, with `assets:stripe` 252.16 too low. If Stripe pays the money out again in a new payout (not checked), that is booked a second time, so the clearing account would be 252.16 too high. `atm reconcile` notices (`missing_in_stripe payout`).
- **Fix:** map `payout.failed` to a reversing `payout.paid`-shaped event (clearing back to `assets:stripe`, idem `stripe:<po>:failed`).

### D4: a paid invoice the handler refuses is not in the books until a human fixes it

- **Case:** `refused-invoice` (an invoice line whose price the menu does not know: `422 refused unmatched_line`).
- **Where:** `src/billing/handle.ts:123-135` refuses the whole invoice; the handler releases the claim and writes nothing (`src/handler/stripe-webhook.ts`, the "refused" answers).
- **Why:** by design, the answer is the alarm and the owner re-sends the event once the menu is fixed. The money and the credits are decided together, so a refusal drops the payment fact too.
- **Impact:** the family has paid and has no credits, and the books lack the whole payment (260.00 income, 7.84 fee, 252.16 cash in the case) for as long as nobody notices, and the same for `addon_only_subscription`. `atm reconcile` notices (`missing_in_log invoice`, plus the fee and net totals).
- **Fix (a design choice):** book the payment fact (to `income:billing:other`) before the grant decision, and refuse only the grant, so the books never lag Stripe; or surface the 422 count in `outboxStatus`.

### D5: reconcile on a shared Stripe account reports another product's invoices as missing

- **Case:** `foreign-invoice` (a 50.00 invoice with no `b4u_*` metadata: `200 ignored`, correctly not booked).
- **Where:** `src/ledger/reconcile.ts:506` pairs every Stripe invoice with the log; a Stripe invoice record does not carry the metadata that says whose it is.
- **Impact:** a false alarm per payment of another product (3 differences for one invoice, no money wrong). Documented in the handler's header ("keep the families on their own account").
- **Fix:** let the invoice record carry its metadata and reconcile only the school's invoices, or keep the documented rule of one Stripe account per school.

### D6: one payment, one income account

- **Case:** `create-with-addon` (a tier of 260.00 and a recurring add-on of 50.00 on one invoice).
- **Where:** `src/billing/money.ts:45-62` (`incomeKindOf`: "an invoice that pays for both books all of it under the tier").
- **Why:** a `payment.succeeded` has one income posting, named after one product.
- **Impact:** none on net income, cash or fees. Revenue by product is wrong: 50.00 of add-on revenue is booked as membership on that invoice and on every renewal that carries the add-on, so `income:billing:addon:*` is understated and `income:billing:membership:*` overstated by the same amount. The totals and reconcile agree (no difference), which is why only the per-account hand numbers show it.
- **Fix:** one income posting per resolved invoice line group (the tier, each add-on), with an invoice-level discount shared in proportion.

### What is not a discrepancy but should be known

- **Revenue is booked when paid.** A yearly invoice of 2,600.00 is 2,600.00 of income in the month it is paid, and its 24 visits (12 monthly allowances) are granted at once. That is the documented cash basis (`docs/financial-reports.md#revenue-timing`); the case checks the cash-basis numbers.
- **The month is the school's calendar, not Stripe's.** A payment at 03:00 UTC on 1 February is booked on 31 January in Denver. Stripe's dashboard (UTC) puts it in February. `atm reconcile` uses the school's calendar for both sides, so it agrees; a person comparing the books with the dashboard by month will see the difference (`month-boundary`).
- **A payout is dated by its arrival** (the `payout.paid` event), Stripe's payout object by its creation. A payout created on 30 January that arrives on 2 February is February's in the books; reconcile pairs them by id (`payout-across-months`), and the balance sheet shows the money in Stripe's balance at the end of January.
- **A refund keeps Stripe's fee**: the fee stays an expense when a payment is refunded, and a fully refunded payment leaves `assets:stripe` at -7.84 (`refund-full`).

## Handler branches no case reaches

From a coverage run of the matrix alone (`bun test --coverage tests/e2e-reconcile.test.ts`). The other test files reach most of these; the matrix does not.

- `src/handler/stripe-webhook.ts`: `401 bad_signature` and `400 bad_request`; `422 livemode_mismatch`; `422 ambiguous_payment`; `422 missing_metadata` (half a holder); `422 unknown_school`; `409 stale_revision`; the compare-and-set race on a stale claim (`409 busy` from a lost takeover) and the `ClaimLost` paths (these need two workers); an `invoice_payment.paid` that normalises badly or names an invoice of another school; the payment links learned from `deps.paymentRefs` or an expanded `invoice.payments`; the older-API metadata fallback.
- `src/billing/handle.ts`: `addon_only_subscription` (422); `unknown_subscription` (409, a cancel before any invoice); a subscription item the menu does not know; `unlinkedInvoice` (a full refund or a lost dispute with no handled invoice; the webhook answers 409 before it); a bad ULID, type or mapping; a payout without a school; the engine rejecting a command (reached only by mutation M3 below). `src/billing/money.ts:37`: an invalid fee (422 `bad_event`).
- Postings the handler never makes, so no case can book them: `payment.disputed` and `dispute.closed` (K1), `fundraise.*`, `share.charged`, `credit.held`, `credit.spent` and the rest of the family service's own events (`recordEngineCommand`, `recordLapse`). The credit side of the matrix is therefore grants, rollover, upgrades, refunds and cancellation; a spend or a lapse is covered by the other suites.
- `src/ledger/reconcile.ts`: bad periods and time zones, test-mode filtering, refunds that moved no money, `period_differs` and `duplicate_in_log` (covered in `tests/reconcile*.test.ts`).
- Not run through the handler: Stripe's instant payouts and their fee, Connect payouts, tax lines, customer-balance credit on an invoice (`amount_paid` is what is booked), and the two recorded scenarios `yearly-raise` and `tier-and-quantity-change`, whose sandbox test clock paid the second invoice weeks after the event announced it (the books date a payment by `paid_at`).

## Mutations

The matrix must catch a wrong book, not only describe a right one. Each change below was made in `src/`, run with `bun test tests/e2e-reconcile.test.ts` and reverted (`git checkout -- src`); the tree was clean afterwards. All were caught.

| # | Injected bug | File | Cases that failed | First check to fail |
|---|---|---|---|---|
| M1 | refund booked to `expenses:billing:disputes` instead of `income:billing:refunds` | `src/ledger/postings.ts` | 12 (every case with a refund) | hand `refunds` 50.00, report 0.00 |
| M2 | Stripe's fee dropped from the payment (cash booked gross), so a payout that is net of it leaves the fee behind | `src/ledger/postings.ts` | 33 (every case with a fee) | hand `fees` 7.84, report 0.00 |
| M3 | a second delivery of the same invoice under a new event id granted again (both "already granted" guards removed) | `src/billing/handle.ts`, `src/billing/grants.ts` | 1 (`duplicate-delivery`) | the engine rejects the second grant: the answer is `422 refused rejected`, not `200 applied` |
| M3b | every `credit.granted` written to the outbox twice | `src/ledger/outbox.ts` | 36 | hand credits 2, report and replay 4 |
| M4 | the event's date taken in UTC, not the school's zone | `src/ledger/postings.ts` | 1 (`month-boundary`) | hand January column of the monthly income statement: sparkle-1 130.00, report 0.00 (the to-date totals do not move, so only the monthly numbers, reconcile's `period_differs` and the monthly goldens see it) |
| M5a | reconcile compares the gross where it should compare the net, so the wrong side of Stripe's transaction | `src/ledger/reconcile.ts` | 36 | reconcile prints `amount_differs net` on a clean month |
| M5b | reconcile compares the log's amount with itself | `src/ledger/reconcile.ts` | 1 (`refund-no-previous`) | the pinned difference is gone (no case that should be clean notices; a case that must differ does) |
| M6 | the upgrade invoice's income given to the tier left, not the tier moved to | `src/billing/money.ts` | 1 (`upgrade`) | hand `income:membership:sparkle-2` 260.00, report 436.13 |
| M7 | a full refund keeps the credits | `src/billing/grants.ts` | 3 | hand credits 0, report and replay 2 |
| M8 | a payout credits `assets:stripe` instead of the clearing account | `src/ledger/postings.ts` | 9 (every payout) | hand `stripe` 0.00, report 252.16 |
| M9 | a partial refund books the running total, not its own amount | `src/billing/money.ts` | 2 | hand `refunds` 80.00, report 130.00 |
| M10 | the shipper keeps only the first event of a day | `src/ledger/ship.ts` | 34 | hand credits (the second event of the day never reaches the books) |

M5b shows the limit of a reconcile mutation: reconcile is "clean" for most cases, so only a case that expects a difference sees the comparison break. The `fee-unknown`, `refund-no-previous`, `payout-failed`, `refused-invoice`, `foreign-invoice` and dispute cases are those.

## How the oracle was kept honest

Two hand numbers were wrong the first time and were corrected from evidence, not from the code's output: the credits of a yearly invoice (24, not 2: the README says a yearly plan paid once grants twelve monthly allowances per unit), and the dispute fee on a win (Stripe's recorded won dispute returns 26,000 with a fee of 0, so the 15.00 is not given back; the first hand number assumed it was). The fee on each payment is the 2.9% + 30 cents of Stripe's list price, rounded to the cent, and is the number the caller is assumed to pass; the matrix does not test the caller's fee lookup.

## Uncertain

- The dispute balance transactions and the no-fee-back on a win come from test-mode recordings; live rules may differ.
- Whether the `payout.paid` event is made at the payout's arrival (so its date is later than the payout's creation) was taken from Stripe's documentation, not from a live account. A payout that fails and is re-paid as a new payout (D3) was not checked.
- D2 is latent: no recorded `charge.refunded` lacks `previous_attributes`.
- `subject.erased` has no implementation in atm (only the event type and its payload schema); the `erasure` case records one after real payments and shows that the money lines do not move and that no personal data (the name and address Stripe's synthetic events carry) is in any shipped file or journal, because the handler never writes it. The rewrite of objects that an erasure means is the family service's and is not run here.
- Nothing here runs against a live account or the family service. The Stripe side is hand-built from documented and recorded shapes. The goldens are hledger 1.52.1's output.
