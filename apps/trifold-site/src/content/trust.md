## The question we started from

Owners want help with their books, but they don't trust software with money. Intuit's 2026 AI Impact Report found bookkeeping trails other uses of AI because owners name privacy, accuracy and trust as the top barriers ([secondary summary, July 2026](https://beancount.io/blog/2026/07/13/quickbooks-ai-impact-report-small-business-trust-guide)). Simply Business's 2026 outlook found trust drops as the stakes rise ([2026 outlook](https://www.simplybusiness.com/small-businesses-are-using-ai-but-theyre-not-letting-it-run-the-show-2026-outlook/)).

Most finance software answers that by asking you to trust it. We'd rather you check.

## Four kinds of trust

Each uses only what ships today.

### Provable

Anyone can check a receipt or a sealed month without asking us. Receipts are signed with Ed25519 over a fixed, documented byte form; months are sealed with a signed fingerprint of their events, chained month to month. The [verifier](/verify) runs in your browser and sends nothing.

### Durable

Export in open formats any time: hledger journals, Parquet and CSV. Receipts and seals check with a free tool, with or without us. Events are append-only: a correction is a new event, never an edit.

### Resilient

Lose the books, keep the events, and replay gives the same balances and journals. Retired signing keys stay in the key list, so old receipts and seals keep verifying after a key rotation.

**Back up your events.** They are the source of everything else. Keep a copy somewhere we don't control.

### Fast

Rebuild any month's books from its events with one command. A month-close that runs itself, by Rifo, is marked Next.

## What we claim, and what we don't yet

We publish our own claim rules. What we may say depends on what has shipped.

| We say today | We don't say yet | Why not |
|---|---|---|
| Double-entry, append-only, replayable books | "Tamper-evident books" | That needs a hash chain per event, which is next |
| Signed receipts and sealed months | "Triple-entry accounting" | That also needs daily matching to Stripe, which is next |
| Anyone can verify a receipt or a seal, free | "Independently witnessed" | Trifold as a witness is next |
| Reconciled against Stripe on request | "Matched every day" | Daily matching is next |
| Designed against each program's published rules | "Accepted by" any state program | Until a program confirms in writing |
| Records ready for your CPA | "We file your taxes" | Never. Filing needs an authorised provider and a person who signs |

## Security

- **Keys.** Receipts and seals are signed with Ed25519. When you run the engine yourself, your school holds its own private key; the tool writes it with owner-only file permissions. Where keys live in the hosted service will be published before it opens.
- **Rotation.** A new key is added beside the old ones, which keep checking what they signed.
- **What a receipt carries.** The payment, the date, the Stripe record and a hash of the event. No name, no email: a receipt may be shown to anyone.
- **Personal data.** Events keep a copy with personal fields removed, so personal data can be erased without breaking the books.
- **Ingest.** Stripe's webhook signature is checked before any event is accepted.

## Your data

It's yours. Download it any time, in open formats. If Trifold went away, what you'd lose is the hosted service, not your records: receipts and sealed months stay checkable with the free verifier.

## The engine and its license

Trifold provides tfd, the engine behind it. **The engine's source is public on GitHub and free to self-host.** It is source-available under the Functional Source License (FSL-1.1-ALv2), not open source: you can use and change it for your own books, for non-commercial education and research, and for professional services to a licensee, but not sell it as a competing service. Every tfd release becomes Apache-2.0 two years after it ships, so even if Trifold disappears, the code becomes Apache-2.0.

The verifier and receipt format are Apache-2.0, and the test vectors are public domain, so checking can never be restricted. The verifier on this site is a faithful copy of the engine's own check.

| Part | License |
|---|---|
| tfd engine and CLI | FSL-1.1-ALv2. Source-available and free to self-host. Each release becomes Apache-2.0 two years after it ships |
| Receipt and seal format, spec and verifier | Apache-2.0 |
| Test vectors | CC0-1.0 (public domain) |
| Hosted Trifold service, Rifo and the witness | Proprietary |


## Verify us yourself

Load the sample receipt on the [verify page](/verify), then the tampered copy. Run the simulator and read what the end-to-end check found on the [proof page](/proof). Read the [engine's source](https://github.com/justbry/atm/tree/dev/packages/atm). Ask us anything at the address on the [about page](/about).
