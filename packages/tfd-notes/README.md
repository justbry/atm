<!-- SPDX-License-Identifier: Apache-2.0 -->
# tfd-notes

The promissory-note engine behind tfd's note records: from an append-only stream of events, it computes a payment
schedule, the interest, and a balance statement for each party. Pure functions, no clock, no store, no network, zero
dependencies, no `node:*` imports. The source is TypeScript and runs in Bun, Workers and browsers (through a bundler); Node needs a TypeScript loader. Not on npm yet (`private: true`).

It is a calculator and a record-keeper. It is not legal advice, and a record it produces is not claimed to be
enforceable. Whether a note holds up depends on the note, the law where the parties are, and a lawyer's review.

## Entry points

| Export | What it does |
|---|---|
| `generateSchedule` | Terms to schedule rows (`amortized`, `custom` or `none`). |
| `replayBalance` | Terms, the payments a view counts and a date to that view's balance. |
| `statement` | Events and an `as_of` date to the schedule, both views, the itemised difference, expected vs paid and days overdue. `statusLabel` gives the plain wording for each status. |
| `parseNoteEvent` | Checks one untrusted event against `schema/note-event.v1.json`. |
| `parseNoteTerms` | Checks a note's terms alone (what `note.created` carries), with the same rules and messages. |
| `validateStream` | Checks a whole stream: `seq` without gaps or repeats, references that resolve, disputes with a counter-amount and a reason. |

## Money, rates and dates

- Money crosses the JSON boundary as an **integer count of minor units in a digit string** (`"1000000"` for 10,000.00
  at exponent 2). The currency code and its exponent (0 to 4) are in the note's terms.
- A rate is a **decimal string of at most 6 places** (`"0.0525"`; `"0"` is allowed), parsed exactly.
- Inside the engine both are `bigint` and exact rationals. No float touches a money or rate path.
- Dates are civil `YYYY-MM-DD`. The engine does no time-zone work.

## Interest

Simple interest, daily, **actual days over 365**, on the principal outstanding. Interest never accrues on interest.
The interest due at an installment date or in a report is the exact accrued amount **rounded half up** to a minor unit; a payment
covers it first, and the exact remainder carries forward. A schedule is what a statement shows if every row's payment is
made on its due date. A payment goes to accrued unpaid interest first, then principal.

## Two views

A statement shows what the lender's records say and what the borrower's say, and lists the difference.

- A fact **against the recorder's interest** counts in both views at once (a lender recording a payment received
  from the borrower, a borrower recording a reversal of their own payment).
- A fact that **helps the recorder** counts in the recorder's view only until the other party confirms it.
- A dispute names a counter-amount and a reason, and moves only the disputing party's view. A resolution counts only when both
  parties file it with the same agreed amount.
- A reversal (a bounced check) undoes one whole payment; the statement then reads as if it was never made.
- No timer confirms anything. An unanswered event shows as unanswered, with its age.

Statements say "confirmed", "claimed by lender", "claimed by borrower" or "disputed".

## License

Apache-2.0 (`LICENSE`), so anyone can recompute a statement with it. The golden test vectors in `tests/golden/` are
CC0-1.0 and are the cross-language contract: a second implementation must reproduce each expected value exactly. The
machine-readable map is `REUSE.toml`. This package imports nothing from tfd (`packages/atm`, FSL-1.1-ALv2).
