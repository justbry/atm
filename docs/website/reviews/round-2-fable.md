# Round 2 review: narrative coherence and the homepage copy deck

Reviewer: Fable. Scope: `decisions.md`, `brand-guide.md`, `messaging.md`, `sitemap.md` (round 2). Drafts not edited.

## Part 1: does the spine hold? (under 250 words)

**The spine works for both readers.** To the owner it is the school year: money arrives, it's recorded, families get receipts, the month closes, taxes. To the CPA it is the accounting cycle in order. One gap: the chapter the owner wants most, 05 Taxes, is outlined. Its body must name what serves tax time *today* (signed receipts, hledger and Parquet export) and mark only the package as Later. Done below.

**Headline: keep "Books that show their work."** The alternatives are sharper and colder; a parent understands this one. Change the eyebrow: "membership businesses" is jargon. Use "For schools, studios and non-profits that take payments on Stripe."

**Brand-guide problems that remain:**

1. The saffron fold line is in every viewport, so the signature effect breaks "never two glow colors in one viewport". Exempt unglowing hairlines under 2px.
2. 03 (green) meets 04 (ember) on tall screens. Add a neutral spacer band.
3. Light `--fg-dim #A8AFC0` on paper is about 2:1. Fine for outlines; chapter 05/06 titles take `--fg-muted`.
4. Hero F4 ends on `212/214 MATCHED`, then F5 seals. A CPA reads "sealed with two unmatched". The label must tick to `214/214` before the seal.
5. Light-mode foil: freeze the angle under `prefers-reduced-motion`; clamp to about 30° against trackpad flicker.
6. Receipt v1 carries no child name by design (`key: family:fam_…`). The sample card shows child and hours as itemised invoice lines, signed fields separate. Done below.

---

## Part 2: homepage copy deck

Order follows `sitemap.md` "Home". Chapter state is in brackets. Anything not shipped carries **Next** or **Later** in the visible copy, not only in the styling. Square-bracketed `[…]` items are placeholders the build must fill or remove.

### 1. Hero

**Eyebrow** (mono, tracked)
`FOR SCHOOLS, STUDIOS AND NON-PROFITS THAT TAKE PAYMENTS ON STRIPE`

**Headline**
Books that show their work.

**Subhead**
Every payment becomes a receipt your families can check. Every month is sealed. The records outlive any app, including ours.

**Primary CTA:** Get early access
**Secondary CTA:** Verify a sample receipt

**Hero animation micro-labels** (real DOM, mono, top-left; one at a time)

| Frame | Label |
|---|---|
| F1 | `STRIPE EVENTS · 214` |
| F2 | `BOOKS · BALANCED` |
| F3 | `RECEIPTS · 214 SIGNED` |
| F4 (start) | `STRIPE · 212/214 MATCHED` |
| F4 (after resolve) | `STRIPE · 214/214 MATCHED` |
| F5 | `OCTOBER 2026 · SEALED` |

**Sample pill** (under the hero; opens the sample ledger)
`● SAMPLE LEDGER · 214 PAYMENTS · OCTOBER SEALED`

**Reduced-motion / static frame caption** (visually hidden, for screen readers)
"Illustration: 214 Stripe events become balanced books, 214 signed receipts, 214 of 214 matched to Stripe, and one sealed month."

### 2. The question

**Large line**
AI can do your books. How would you know it did them right?

**Answer**
Because every number shows its work. Each total opens to the payments behind it. Each payment has a receipt the payer keeps. Each month is sealed, and anyone can check the seal without asking us.

### 3. Chapters

Fold line runs down the margin. One pinned ledger panel changes state through 01–03 on desktop.

#### 01 · MONEY IN [lit]

**Label:** `01 · MONEY IN`
**Headline:** Payments arrive as events.
**Body:** Tuition, memberships, class packs and bookings come in through Stripe. Each one lands as an event with a time, an amount and the Stripe record it came from. Nothing is typed in by hand.
**Panel state:** a column of dim rows: `payment.succeeded · $800.00 · 2026-10-03 · in_1SGq…3Qa7`
**Micro-label:** `214 EVENTS · OCTOBER 2026`

#### 02 · BOOKS [lit]

**Label:** `02 · BOOKS`
**Headline:** Every event becomes balanced books.
**Body:** Each payment posts as a debit and a credit, so the books always balance. Events are append-only: a correction is a new event, never an edit. Replay the events and you get the same books, byte for byte.
**Durable line (small, with a ✓):** Durable. Export to Parquet, hledger or CSV any time. The engine, atm, is open and free to run yourself.
**Panel state:** rows pair into debit and credit with a hairline between them. Footer: `DEBITS 171,400.00 · CREDITS 171,400.00 · BALANCED`
**Micro-label:** `BOOKS · BALANCED · REPLAYABLE`

#### 03 · PROOF [lit]

**Label:** `03 · PROOF`
**Headline:** A signed receipt for every payment. A seal on every month.
**Body:** Each payment gets a receipt signed with the school's key. The family keeps it. If the books are changed later, the receipt no longer matches. At month end the whole month is sealed, and each seal is chained to the month before it.
**Carry line (set apart):** Not even Trifold can quietly change your books.
**Resilient line (small, with a ✓):** Resilient. Lose everything but the events and rebuild it all, exactly. Seals keep verifying after a key rotation.

**The sample receipt card** (two layers; the itemised lines come from the Stripe invoice, the signed record is what the signature covers)

```
JUNIPER MICROSCHOOL                                  RECEIPT · SAMPLE
1420 W Idaho St, Boise, ID 83702
EIN 84-3921047

Paid by      The Kessler family
Student      Mara Kessler
For          Tutoring · October 2026 · 32 hours · $25.00/hr
Amount       $800.00 USD
Paid         2026-10-03 · Visa ···· 4242
Stripe       in_1SGq4m2eZvKYlo2C9bXk3Qa7

SIGNED RECORD
event        01K6W4Q2M8H3V0J7D1S9PXR5TC
event hash   a81f0c3e…9d2ec2e4
signed by    Juniper Microschool · key juniper-2026-09
sealed in    October 2026 · seal 2026-10
sig          MEUCIQDk…pRw   (Ed25519)

[ Verify this receipt ]   [ Try a tampered copy ]
```

Card footnote (small): "Sample data. Names and amounts are invented. The signature is real and verifies against the sample key."

**Inline verifier: messages**

Pass (sample):
> ✓ **Verifies.**
> Signed by Juniper Microschool, key `juniper-2026-09`.
> $800.00 · 2026-10-03 · event `01K6W4Q2…R5TC`.
> Found in the school's books, unchanged. Sealed in October 2026.

Fail, tampered copy (amount edited to $1,200.00):
> ✗ **Does not verify.**
> The signature doesn't match this receipt. It was changed after it was signed, or it was never signed with this key.
> Nothing in it can be trusted as issued.

Other fail states (the verifier never guesses; one line each):
- `malformed`: ✗ This isn't a Trifold receipt. The file is missing fields or isn't valid JSON.
- `unknown_key`: ✗ Unknown key `[key_id]`. The receipt names a key this school hasn't published.
- `bad_signature`: ✗ The signature doesn't match this receipt.
- `missing_event`: ⚠ Signature valid, but the school's books have no event `[event_id]`.
- `event_changed`: ⚠ Signature valid, but the event in the school's books differs from this receipt.
- `not_receipted`: ⚠ Signature valid, but this event type doesn't get a receipt.

Box: **What a pass proves, and what it doesn't**
- Proves: this receipt was signed with the named key; it hasn't changed since; the amount, date and Stripe record are as signed; the school's books hold the same event; the month it's in is sealed.
- Doesn't prove: that the school delivered the hours; that a state program accepts it; that the key belongs to the school unless you got the key from the school or from Trifold.

**Proof sweep caption** (during verification): `CHECKING SIGNATURE · CHECKING BOOKS · CHECKING SEAL`

**Micro-label:** `214 RECEIPTS · 1 SEAL · 0 CHANGED`

#### 04 · CLOSE [ember · NEXT]

**Label:** `04 · CLOSE · NEXT`
**Headline:** The month closes itself. Next.
**Body:** Today you reconcile against Stripe on demand and seal the month yourself. Next, Rifo reads the books, matches each day to its Stripe payout, explains any gap and proposes the close. You approve. Rifo never computes a number; the engine does. Every answer cites the events behind it.
**Fast line (small, with a ✓):** Fast. Replay rebuilds a year of books locally in seconds, today. `[MEASURE: n events in n s on a laptop; publish the command]`
**Also next (dim list):** Daily payout matching · Trifold as independent witness to each seal.
**Micro-label:** `NEXT · ON THE ROADMAP`

#### 05 · TAXES [outline · LATER]

**Label:** `05 · TAXES · LATER`
**Headline:** Tax time with nothing to find.
**Body:** Today your CPA gets signed receipts and books that export to hledger and Parquet, every number traced to a payment. Later: a tax-ready package built for your CPA, donation acknowledgments, 1099 exports. We say "tax-ready, with your CPA". We don't file your taxes.
**Micro-label:** `LATER`

#### 06 · FINANCE [outline · LATER]

**Label:** `06 · FINANCE · LATER`
**Headline:** Your numbers, in tables that last.
**Body:** Later: your financial history in open tables you can query with SQL. Cash forecasts. Agents for payables and receivables. Open formats, no lock-in.
**Micro-label:** `LATER`

### 4. Who can check

**Headline:** Anyone can check. No account.
**Intro line:** The same Verify button, five people.

- **A parent at tax time** checks the tuition receipt their state program asked for.
- **A treasurer before the board meeting** shows a sealed month instead of a spreadsheet.
- **A CPA in January** traces every number to the payment behind it.
- **An auditor with no account** verifies a seal in seconds.
- **A donor** checks that their gift was acknowledged and recorded. *(Acknowledgments: Later. Today a donor can verify the payment receipt.)*

**CTA:** Verify a sample receipt

### 5. Built for schools first

**Label:** `BUILT FOR SCHOOLS FIRST`
**Headline:** Receipts your families can use. Books your CPA can sign.
**Body:** We're starting with microschools and private schools in Idaho and Utah. Families need itemised receipts: the child, the hours, the dates, the school's EIN. Owners need a month that closes without a spreadsheet. CPAs need numbers that trace to payments. One record does all three.
**Receipt callout:** the sample card from chapter 03, collapsed to the itemised layer.
**State-program line (plain, honest):** Receipts are designed against each program's published rules and reviewed with CPAs. Until a program confirms, we say "designed for", not "accepted by".
**CTA:** Get early access · *Design partners: founder onboarding, free during the pilot.*
**Also for line:** Also for studios and gyms · non-profits and co-ops · accountants · developers.

### 6. People

**Label:** `WHO'S BEHIND IT`
**Headline:** People first. Then proof.
**Body placeholder:** `[Founder name], founder. [One sentence: why books that show their work.]`
**Design partners placeholder:** `[B4 Uni · Vibes of Light, logos and one quote each, with written permission. Remove this block until approved.]`
**Line under it:** Trifold provides atm, the open engine. The code, the spec and the verifier are on GitHub.

### 7. FAQ

**Will my state program accept these receipts?**
We design receipts against each program's published rules and review them with CPAs. Until a program confirms in writing, we say "designed for", not "accepted by". Ask us which programs we've reviewed.

**You're new. Will you exist next year?**
You don't need us to. The engine is free to self-host, your data exports in open formats, and every receipt and seal verifies without Trifold.

**I already use QuickBooks or Mindbody.**
Keep them. Trifold adds signed receipts and sealed books on top of your Stripe payments and exports out. Switch fully only if you want to.

**What happens to my data if you go away?**
It's already yours. Open formats, downloadable any time, verifiable forever with the free verifier.

**Is AI touching my numbers?**
No. The engine computes deterministically and replays the same way every time. Rifo, when it ships, reads and explains; it never computes a number, and you approve every close.

**What does it cost?**
Design partners pay nothing during the pilot. Published plans are on the pricing page.

### 8. Closing CTA

**Headline:** Every dollar, three ways. Every month, sealed.
**Line:** Books ✓ · Receipt ✓ · Stripe ✓
**Primary CTA:** Get early access
**Secondary (text):** Verify a sample receipt
**Footer tag:** Trifold provides atm, the open engine.

---

## Part 3: `/for/*` hero copy

### /for/schools

**Headline:** Every tuition payment, a receipt your families can check.
**Subhead:** Trifold turns your Stripe payments into signed, itemised receipts and sealed monthly books. Built first for microschools in Idaho and Utah.
- Receipts with the child, the hours, the dates and your EIN, signed so they can't be quietly changed.
- A month that closes from your Stripe events, not from a spreadsheet.
- Books your CPA can trace to the payment behind every number.
**CTA:** Get early access

### /for/accountants

**Headline:** Clients whose books arrive closed and traceable.
**Subhead:** Every number traces to a Stripe event. Every month is sealed. You review and sign; you don't rebuild.
- A year-end export in hledger, Parquet or CSV, with every entry linked to its payment.
- Replay the events on your own machine and get the same books, byte for byte.
- Free partner seats during the pilot. Verify any receipt or seal with the free CLI.
**CTA:** Become a partner

### /for/studios

**Headline:** Sell plans and packs. Know who has visits left. Books that show their work.
**Subhead:** Memberships, class packs and drop-ins through Stripe, recorded as balanced books with a signed receipt for every payment.
- Plans, packs and credits priced your way, pushed to Stripe from one menu.
- A signed receipt for every payment, a sealed month at the end.
- Keep your booking app. Trifold adds the books and syncs out.
**CTA:** Get early access

### /for/nonprofits

**Headline:** Open books your donors, board and members can check.
**Subhead:** Every gift and due becomes a signed receipt and a line in sealed, replayable books. Anyone can verify, no account.
- A sealed month for every board meeting, not a spreadsheet.
- Receipts donors can verify themselves. *Acknowledgment letters: Later.*
- Open formats: your auditor gets the events and rebuilds the books.
**CTA:** See non-profit pricing

### /for/developers

**Headline:** A provable ledger for credits, plans and bookings.
**Subhead:** atm is an open engine that replays Stripe events into double-entry books, signs Ed25519 receipts and seals months. Free CLI, open spec, test vectors.
- Deterministic: same events in, same books and signatures out, byte for byte.
- Export to Parquet and hledger; verify receipts and seals with `tfd` or your own code.
- Hosted cloud, hash chain per event and witness are on the roadmap, marked Next.
**CTA:** Install the CLI, free
