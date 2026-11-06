# Trifold: brand kit and messaging

Status: draft, 2026-11-05. Names, domains and trademarks were checked on that date and must be checked again before anything is bought or filed.

## What Trifold is

**For customers:** Trifold runs your memberships, bookings and books, and an AI agent keeps them closed and tax-ready.

**For technical readers:** Trifold is an agentic financial data mart. Every payment, credit and booking lands in one triple-entry ledger that can be replayed and checked, and an AI agent reads it, reconciles it and reports on it.

**What "three sides" means:** every dollar is recorded three ways. The business's books, the customer's signed receipt and the payment processor's record all agree, and anyone can check that they do. We explain this in plain words and never call it a blockchain.

## Name architecture

| Layer | Name | Where it appears |
|---|---|---|
| Company, customer brand and managed service | **Trifold** | Website, app, emails, receipts, contracts; the legal name |
| Engine | **atm** | The engine Trifold maintains and runs as a managed service: "built on atm" on developer, accountant and trust pages; self-hosters run it directly |
| Command-line tool | **`tfd`** | Docs, terminal, npm package `@trifold/cli` |
| AI agent | **Rifo** (`@rifo`) | In the app, chat and `tfd ask`; it always cites the ledger behind each answer |

### The agent: Rifo

Rifo is the middle of tRIFOld, so the agent sounds like part of the brand. Say it "REE-foh", and print the pronunciation once on the agent's intro card so people don't say "RYE-foh". In Italian, *rifò* means "I redo", which fits an agent that redoes the books every day.

- Short and friendly, and works as a persona: "Ask Rifo."
- Speech-to-text may hear it as "Reefo" or "Rio". Add "Rifo" to the custom vocabulary of any voice feature, and also respond to "Trifold".
- In Spanish, *rifo* means "I raffle". This is harmless but worth knowing before a Spanish-language launch.

```text
@rifo why did Ava's visits drop to 1?
@rifo draft Q4 estimated taxes for Vibes of Light
$ tfd ask "which members renew next week?"
```

Why Trifold leads: it is warm, a real word, and speech-to-text hears it correctly. atm is the engine's plain product name; it is too generic to register as a trademark, so the trademark protection sits on Trifold. (An earlier draft named the engine "Trivalance"; that name was dropped on 2026-11-06.)

### What `tfd` stands for

| Layer | Meaning | Use |
|---|---|---|
| Official | **TriFolD** | `tfd --help`, docs |
| Brand promise | **Trusted Financial Data** | Trust page, accountant pitch, the triple-entry story |
| Marketing line | **tfd: Taxes, Finally Done.** | Homepage, ads, the tax-season campaign |
| Easter egg | **Totally Freaking Done** | `tfd --why`, the month-close success message, stickers. Not on formal pages |

```text
$ tfd close --month 2026-10
✓ 214 events · books balanced · 212/214 matched to Stripe
✓ October closed. Totally Freaking Done.
```

## Taglines

- Main: **Three sides of every dollar.**
- Tax season: **Taxes, Finally Done.** The first time it appears on a page, always pair it with a qualifier, such as "Tax-ready books, CPA-signed" (see Claim rules).
- Supporting lines:
  - Books that close themselves.
  - Every dollar, folded into one truth.
  - Your books closed all year. Your CPA signs in an afternoon.

## Brand kit

### Logo

Three panels folding into a triangle: a receipt folded in thirds, which also suggests the three records. Shown flat, it becomes a three-bar mark for small sizes and the favicon.

### Colour

| Role | Name | Hex |
|---|---|---|
| Primary (trust) | Ink navy | `#1E2A44` |
| Background (receipts, calm) | Paper cream | `#F6F1E7` |
| Positive (balanced, matched) | Ledger green | `#2F7D5B` |
| Accent (warmth, calls to action) | Saffron | `#E8A33D` |
| Warnings only | Clay red | `#B5533C` |

Check every text and background pair for WCAG AA contrast before shipping. Saffron is an accent colour; don't use it for body text on cream.

### Type

- Headings: **Fraunces**, a warm serif that suggests books.
- Body: **Inter**.
- Numbers and code: **JetBrains Mono**, with tabular figures so columns of money line up.

### Imagery

Folded paper, real studio and classroom scenes, ledger lines. Avoid stock photos of people in suits, glowing AI brains, coins and chains.

### Interface motifs

- A three-column fold layout.
- Every total opens to show the events behind it.
- Each transaction shows three checks: **Books ✓ Receipt ✓ Stripe ✓**.

## Voice

Calm, plain and exact. We sound like a trusted bookkeeper, not a hype-driven startup. We use short sentences and real numbers.

| Use | Avoid |
|---|---|
| books, receipts, close, balance, proof, members, sessions, credits | blockchain, crypto, web3, disrupt, revolutionary |
| "tax-ready", "CPA-signed" | "automated taxes", "we file your taxes" |
| "matched against Stripe" | "signed by Stripe" |
| "replayable", "audited" | "100% accurate", "unhackable" |

Rifo speaks in the same voice and always shows its source, for example: "From 14 payments in October · view ledger".

## Website outline

1. **Home**
   - Hero: *Memberships, bookings and books that close themselves.* Subhead: *Sell plans, packs and paid sessions. Trifold records every dollar three ways, and an AI agent keeps your books tax-ready.* Buttons: "Start free" and "See a live ledger".
   - Logo strip: B4 Uni schools, Vibes of Light.
   - The three folds: **Sell** (plans, add-ons, packs, bookings) · **Record** (ledger, signed receipts) · **Close** (the agent reconciles, reports and builds the tax package).
   - Agent demo: "How did October go?", with an answer that cites the ledger.
   - One section per audience (below), a CPA partner block, a pricing preview and an FAQ.
2. **Product:** Billing and memberships · Bookings and credits · The Ledger · The Agent · Tax-ready
3. **Solutions:** Studios · Micro-schools and tutoring · Nonprofit schools · Platforms and developers
4. **Accountants:** partner programme, read-only seats, the year-end package
5. **Developers:** `tfd` CLI, API, MCP server, webhooks, docs
6. **Trust:** how the three records work, `tfd verify`, security, data ownership (export to Parquet or hledger at any time)
7. **Pricing**
8. **About, blog, changelog**

## Ideal customer profiles

### 1. Studio owner

Yoga, light therapy, sauna or Pilates; 50 to 500 members.

- **Message:** Sell packs and memberships your way. Know who has visits left. Never do the books again.
- **Cares about:** members running out of visits, failed payments, time at month-end, simple pricing changes (1, 2 or 4 sessions a month), looking professional.
- **Doesn't care about:** ledgers, triple-entry, APIs, how the data is stored.
- **Proof:** the Vibes of Light case study, "N visits left" alerts, no spreadsheets at year-end.
- **Objection and answer:** "I already use Mindbody." Keep booking where you like and let Trifold close the books, or switch fully for less.
- **Channels:** studio-owner communities, Instagram, referrals from bookkeepers.

### 2. Micro-school or tutoring director

B4 Uni schools; 10 to 150 families.

- **Message:** Tuition, sessions and receipts families can use at tax time, handled.
- **Cares about:** itemised receipts per child for tax credits and education savings accounts, families with several children, fair refunds, few admin hours.
- **Doesn't care about:** usage-pricing jargon, dashboards for their own sake.
- **Proof:** a sample signed receipt with the child's name, hours and the school's EIN; built into B4 Uni.
- **Objection and answer:** "Will it satisfy our state?" Receipts are designed against the state's requirements, and your CPA confirms them.
- **Channels:** inside B4 Uni, homeschool and micro-school networks, state education-choice groups.

### 3. Nonprofit school treasurer or board

- **Message:** Open books, at the right level of detail for each person.
- **Cares about:** transparency, separating restricted funds, donor privacy, board reports, the audit trail, Form 990.
- **Doesn't care about:** booking features, the agent's personality.
- **Proof:** detail levels by viewer (public, members, board, finance), a replayable ledger, an audit log of who read what.
- **Objection and answer:** "Is our donor data safe?" Names are visible only to the owner and the finance admin, and every read is logged.
- **Channels:** nonprofit finance communities, board-training groups, CPA partners.

### 4. Bookkeeper or CPA partner

Serves 10 to 100 small businesses.

- **Message:** Clients whose books arrive closed. You review and sign.
- **Cares about:** clean reconciliation to Stripe; exports to QuickBooks, Xero, hledger and CSV; an audit trail; fewer client emails; recurring revenue.
- **Doesn't care about:** the booking interface, member alerts.
- **Proof:** a year-end package, every number traced to an event, a read-only partner seat, `tfd verify`.
- **Objection and answer:** "Will AI replace me?" No. The agent prepares and you sign, so you can serve more clients per hour.
- **Channels:** accounting communities, a partner programme with a revenue share, CPE webinars.

### 5. Developer building a membership or credits product

SaaS founders and platform teams.

- **Message:** Credits, plans and a provable ledger as an API, with an agent that answers finance questions.
- **Cares about:** a deterministic engine (same input, same result), idempotent webhooks, Stripe-native billing, a good CLI, MCP, self-hosting, no lock-in.
- **Doesn't care about:** studio-specific features, marketing polish.
- **Proof:** the open-source engine, the `tfd` CLI, replay tests, export to Parquet and DuckDB.
- **Objection and answer:** "Why not Stripe Billing, Orb or Metronome?" Trifold puts credits, rollovers and a provable ledger in one engine, not only invoices.
- **Channels:** GitHub, Hacker News, developer content, the Autumn community.

## The triple-entry story

The idea comes from Ian Grigg (2005): every transaction gets a third record, a receipt signed with public-key cryptography that both parties hold, so neither side can quietly change its own books.

| Record | Whose | In Trifold |
|---|---|---|
| 1. The books | The business's | Double-entry postings in a hash-chained ledger |
| 2. The receipt | The customer's | A signed receipt the customer keeps and can verify |
| 3. The witness | The processor's | Stripe's record of the charge, matched every day |

### How each side is kept honest

| Attempt | What catches it |
|---|---|
| The business edits an old charge | The customer's signed receipt no longer matches, and the hash chain breaks |
| The business deletes a charge | The chain has a gap, and the customer still holds the receipt |
| A customer forges or inflates a receipt | The signature fails against the business's published key |
| A refund or correction | A new signed receipt that names the one it replaces. Nothing is ever edited |
| Trifold rewrites history | The published daily fingerprint no longer matches, and customers still hold their copies |

### What exists and what is to build

What exists today, in `packages/atm`:
- Postings must balance to zero in each currency (`src/ledger/validate.ts`).
- The same event always gets the same canonical bytes and id (`src/ledger/postings.ts`, `src/ledger/ids.ts`).
- Duplicate events are recorded only once (`idem`).
- Balances can be replayed from events and checked (`src/ledger/replay.ts`).
- Each month's close has a hash of its inputs (`inputsHash` in `src/ledger/journal.ts`).
- Batches are written once, with their hash in the key (`src/ledger/ship.ts`).
- Stripe signatures are checked on ingest (`src/handler/stripe-signature.ts`).
- Journals can be read by hledger.

To build:
1. Link every ledger event to its Stripe source (event id, charge, invoice, sha256 of the raw body).
2. Chain events by hash per business (`prev_hash`, `hash`), and record the latest event's hash in each batch and month close.
3. Sign batches and month closes with Ed25519 keys, and publish the public keys at `/.well-known/trifold-keys.json`.
4. Signed customer receipts (`receiptOf`), with a verify page and `tfd verify receipt`. This also needs the open receipt decisions in `packages/atm/ROADMAP.md`.
5. Match every event daily against Stripe's balance transactions and payouts.
6. Optional: publish each day's summary hash to a public transparency log.
7. An open-source `tfd verify` that checks the chain, signatures, balances, replay, the Stripe matches and receipts.

Where the code goes: atm stays pure. `receiptOf`, the canonical receipt bytes and `verifyReceipt` live in atm. Signing with a stored key and delivering receipts belong to the caller.

## Claim rules

What we may say depends on what has shipped.

| After | We may say |
|---|---|
| Today | "Double-entry, append-only, replayable books" |
| Steps 1 to 3 | "Tamper-evident books" |
| Steps 4 and 5 | "Triple-entry accounting: your books, your customer's receipt and Stripe's record, signed and matched" |
| Steps 6 and 7 | "Independently verifiable: check our math yourself with `tfd verify`" |

We never claim that Trifold files taxes. Filing needs an authorised e-file provider and a human who signs, and who is liable when an AI makes a filing error is unsettled. "Taxes, Finally Done" always comes with "tax-ready" or "CPA-signed" on first use, because the FTC treats an implied claim like an explicit one.

Also not to claim yet: usage-based pricing (not built), itemised receipts (not built), and tax amounts on invoices (not built).

## Names, domains and trademarks

As checked on 2026-11-05:

| Item | Result |
|---|---|
| gettrifold.com | Free |
| trifold.com, .ai, .io | Registered by others |
| npm `trifold`, `tfd` | Not checked as packages; publish under `@trifold/cli` |
| `tfd` command | No clash found on PATH or Homebrew |
| Samsung Galaxy Z TriFold | Dominates search for "trifold". An SEO problem; have a lawyer check Samsung's filings |
| Old TRIFOLD filings | A dead class 9 application (serial 77941454) and a "tri fold" class 42 filing of unknown status (77000614). Check in USPTO TSDR |

Next steps:
1. Register gettrifold.com (and usetrifold.com to redirect).
2. Claim the npm scope `@trifold`, the GitHub organisation and the main social handles.
3. Get a trademark clearance search for TRIFOLD in classes 9, 36 and 42.
