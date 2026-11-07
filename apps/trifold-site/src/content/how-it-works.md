## The three sides of every dollar

Every payment is recorded three ways, and the three should agree.

| Side | Whose | What it is | Status |
|---|---|---|---|
| The books | The school's | Double-entry postings built from Stripe events, append-only and replayable | Today |
| The receipt | The payer's | A record of the payment, signed with the school's Ed25519 key, that the family keeps | Today |
| Stripe's record | The processor's | The charge as Stripe saw it. Today the books are reconciled against Stripe when you ask; daily matching to payouts is next | Today, on request · daily matching Next |

## One payment, step by step

1. **A family pays.** The Kessler family pays $800.00 of October tutoring through Stripe. Stripe sends a signed webhook, and the engine checks Stripe's signature before it accepts anything.
2. **It lands as an event.** The payment becomes one event: its time, its amount, the family's timeline id (no name, no email) and the Stripe invoice it came from. If Stripe sends the same thing twice, it is recorded once.
3. **It posts to the books.** Debit `assets:stripe` 776.50 and `expenses:billing:stripe-fees` 23.50; credit `income:billing:tuition` 800.00. Postings must balance to zero in each currency, or the event is refused.
4. **A receipt is made and signed.** The receipt is made from the event alone, so the books can make the same receipt again at any time. It carries a sha256 hash of the event, so it points at exactly one entry in the books, and it is signed with the school's key.
5. **The family keeps it.** Anyone can check it on the [verify page](/verify): the signature, then (when the school shares its books) that the books still hold the same event.

## The monthly seal

"Sealed", in plain words: **a signed fingerprint of the month as it stood.**

At month end the school runs one command. It signs the list of the month's event ids, how many there are, and a hash of all of them, and chains that seal to the month before. If an event in a sealed month is changed or deleted later, the fingerprint stops matching, and anyone holding a copy of the seal can show it.

Events that arrive after a month was sealed (Stripe is sometimes late) are listed as late, not called tampering, and the month can be sealed again to cover them.

## What catches what

Only what ships today is in the first four rows.

| If someone… | What catches it | Status |
|---|---|---|
| Edits a payment in a sealed month | The seal stops matching, and the family's receipt no longer matches the event in the books | Today |
| Deletes a payment from a sealed month | The seal names every event by id, so a missing one fails the check. The family still holds the receipt | Today |
| Forges or inflates a receipt | The signature fails against the school's key | Today |
| Refunds a payment | A refund is a new event with its own receipt, which names the payment it reverses. Nothing is edited | Today |
| Edits a payment before its month is sealed | Only a receipt the family already holds shows it. A hash chain per event is planned | Next |
| Rewrites history and re-signs it with the school's own key | Copies of receipts and seals kept outside the books show it. An independent witness to each seal is planned | Next |

## Shipped, and next

**Today:** books from Stripe events · append-only events · replay to the same balances and journals · signed receipts · sealed months, chained · the in-browser verifier · reconcile against Stripe on request · export to hledger, Parquet and CSV.

**Next:** Rifo, the AI assistant that reads, explains and proposes the close (it never computes a number) · daily matching to Stripe payouts · a hash chain per event · Trifold as an independent witness · the hosted service.

**Later:** a year-end package for your CPA · donation acknowledgments · 1099 exports · a finance warehouse in open tables.

See the [roadmap](/roadmap) for the whole story.
