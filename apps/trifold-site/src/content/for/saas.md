## Three things that make SaaS books hard

### 1. Seat changes and proration that are hard to reconcile

Teams add seats mid-month and drop them at renewal. Upgrades bill at once, with a credit for the old plan and a charge for the new one.

**How Trifold answers it** (chapters 01 and 02, Money in and Books): every invoice Stripe sends, prorated seat changes and upgrades included, lands as an event and posts as balanced books. Reconcile against Stripe's records on request.

### 2. Usage credits that drift from what was billed

**How Trifold answers it** (chapter 02, Books): credits are balances built from the same events as the money. Credits granted, used and expired are counted from the invoices and the usage, so the two can't drift apart unseen.

### 3. Investors or auditors asking where revenue came from

**How Trifold answers it** (chapter 03, Proof): every number traces to the Stripe payment behind it, each payment has a signed receipt, and sealed months show any later change. Replay the events and you get the same books.

What it doesn't do: Trifold doesn't recognise revenue or make ASC 606 claims, and there's no MRR KPI yet. It keeps the books of what Stripe charged, collected and refunded.
