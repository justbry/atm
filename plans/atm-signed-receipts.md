# atm: signed receipts and sealed months (triple-entry, milestone 1)

Status: built. Milestone 1 landed on `dev` in #123 (2026-11-06); #137 brings it in line with this spec (seals list `event_ids`, the `atm seal` lock). #124 was a parallel build of the same spec and is closed. Brand context: `docs/brand/trifold-brand-and-messaging.md` ("The triple-entry story").

## Goal

Every paid or refunded payment gets a third record: a receipt signed with public-key cryptography that the family keeps and anyone can verify. If the school's books are later edited, the receipt no longer matches. Every closed month gets a signature too, chained to the previous month, so any edit or deletion in a sealed month shows up, and an event added to it later is listed.

This milestone covers most of the value of triple-entry accounting with about 15% of the full plan's code (see "Size").

## Non-goals

These are left for later milestones.

- A hash chain over every single event, written inside the webhook transaction. Milestone 1 seals per month, so the open month is not yet protected.
- Per-school keys, a cloud key service, automatic key rotation.
- Daily matching of events against Stripe's balance transactions. Stripe acts as a witness by reference only: the receipt carries the Stripe object id.
- An itemised receipt: tax, the student, subject and hours, the payment method. These are the owner decisions listed in `packages/atm/ROADMAP.md` under "the itemised receipt".
- PDF rendering, email, a verify web page. These belong to the caller.
- Receipts for credit events (a visit used), co-signing by the family, a public transparency log.

## Design

### The key idea: a receipt is a pure function of its event

- atm's events are deterministic data.
- Ed25519 signatures are deterministic (RFC 8032): the same bytes and key always give the same signature.

So a receipt never needs to be stored. The family keeps the signed copy, and the school's books can regenerate it byte for byte at any time. If the event behind it was edited or deleted, the regenerated receipt differs from the family's copy, or can't be produced at all.

As a result, this milestone adds no table, no signing worker and no change to the webhook transaction.

### Where the code goes

atm stays pure. `receiptOf`, `sealOf` and the `verify*` functions take everything as arguments: no I/O, no clock. Signing is a synchronous call to `node:crypto` with a key the caller passes in. Storing the key, delivering receipts and publishing the public keys are the caller's job.

## The receipt

### Which events get one

`payment.succeeded` and `payment.refunded`. Every other event type returns `null`.

`payment.disputed` and `dispute.closed` get no receipt. A dispute is between the family and its bank, not an agreement between school and family. Revisit this in a later milestone.

### `AtmReceipt` v1

```ts
export type AtmReceipt = {
	v: 1;
	school: string;
	/** The family's timeline, e.g. `family:fam_8k2`. No name or email: a receipt may be shown to anyone. */
	key: string;
	event_id: string;
	event_type: "payment.succeeded" | "payment.refunded";
	event_time: string; // UTC ISO, from the event
	date: string; // school-local YYYY-MM-DD, from the event
	/** Cents. `amount_paid` on a payment, `amount` on a refund. */
	amount: number;
	currency: string;
	/** The Stripe object the event came from: the invoice id on a payment, the payload's `id` on a refund. */
	stripe_id: string;
	/** The event that caused this one (a refund's payment), when the event names it. */
	cause: string | null;
	/** sha256 (hex) of the event's canonical form. This is the link to the school's books. */
	event_hash: string;
};

export type AtmSignedReceipt = {
	receipt: AtmReceipt;
	/** Which public key verifies `sig`, e.g. `trifold-2026-11`. */
	key_id: string;
	/** Ed25519 over `canonicalize(receipt)`, base64url without padding. */
	sig: string;
};
```

Where each field comes from (checked against `schema/payload/payment.succeeded.v1.json` and `payment.refunded.v1.json`):

| Field | `payment.succeeded` | `payment.refunded` |
|---|---|---|
| `amount` | `payload.amount_paid` (required) | `payload.amount` (required) |
| `currency` | `payload.currency` (required) | `payload.currency` (required) |
| `stripe_id` | `payload.id` (required; the invoice id) | `payload.id` (required) |
| `cause` | `event.cause ?? null` | `event.cause ?? null` |

`receiptOf` throws an `Error` naming the field when a required field is missing or has the wrong type. It never returns a receipt with a guessed value.

### What `event_hash` is computed over

`event_hash = sha256Hex(canonicalize(event))`, using `canonicalize` from `src/ledger/util.ts`: keys sorted, `undefined` dropped, then `JSON.stringify`.

**Why the canonical form and not the stored line:** readers parse events (`readEvents` in `src/ledger/files.ts` keeps no raw lines), and `buildJournal`'s `inputsHash` already uses `canonicalize(event)`. Using the same form everywhere means a receipt can be checked from any copy of the events.

**This makes `canonicalize` part of the receipt format.** Freeze it as "canonical v1". A golden test pins the exact bytes and hash of a fixed event and receipt. Changing the hash input requires receipt v2; v1 receipts must keep verifying for ever.

### Signing

```ts
export type AtmSigner = { keyId: string; privateKeyPem: string }; // Ed25519, PKCS#8 PEM

export const signReceipt = (receipt: AtmReceipt, signer: AtmSigner): AtmSignedReceipt;
```

- `sig = crypto.sign(null, utf8(canonicalize(receipt)), createPrivateKey(pem))`, encoded as base64url.
- If the key is not an Ed25519 private key, throw naming the key type. Never fall back to another algorithm.

### Verifying

```ts
export type AtmPublicKeys = Record<string, string>; // key_id -> SPKI PEM

export type ReceiptVerdict =
	| { ok: true }
	| { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" };

export const verifyReceipt = (signed: unknown, keys: AtmPublicKeys): ReceiptVerdict;

export type LedgerVerdict =
	| { ok: true }
	| { ok: false; reason: "missing_event" | "event_changed" | "not_receipted" };

export const checkReceiptAgainstEvents = (
	signed: AtmSignedReceipt,
	events: readonly AtmEvent[],
): LedgerVerdict;
```

- `verifyReceipt` takes `unknown`, because a file from a family is untrusted input. It checks the shape against `schema/receipt.v1.json`, then the key id, then the signature. It never throws on bad input.
- `checkReceiptAgainstEvents` finds the event by `event_id`, regenerates the receipt with `receiptOf`, and compares canonical bytes:
  - event not found → `missing_event`;
  - the event's type no longer gets a receipt → `not_receipted`;
  - any other difference → `event_changed`.

### What a receipt does and doesn't prove

- **It proves:** the school's key signed these facts; the books held this exact event when the receipt was made; the Stripe object to check.
- **It doesn't prove** that Stripe moved the money. That needs Stripe matching, a later milestone. Copy must say "signed receipt", not "verified by Stripe".

## Month seals

### `AtmSeal` v1

```ts
export type AtmSeal = {
	v: 1;
	school: string;
	month: string; // YYYY-MM, by the events' school-local `date`
	/** How many events the seal covers: the month's events in the folder when it was made. */
	events: number;
	/** Their ids, sorted. A month event not listed here reached the folder after the seal. */
	event_ids: string[];
	/** Events among them with postings, as `buildJournal` counts transactions. */
	transactions: number;
	/** sha256 of the covered events' canonical forms, sorted by id and joined by "\n". The same formula as `inputsHash`. */
	events_hash: string;
	sealed_at: string; // UTC ISO, passed in by the caller (atm reads no clock)
	/** sha256 of the canonical form of the previous signed seal for this school, or null for the first. */
	prev_seal_hash: string | null;
};

export type AtmSignedSeal = { seal: AtmSeal; key_id: string; sig: string };

export const sealOf = (input: {
	school: string;
	month: string;
	events: readonly AtmEvent[]; // all the school's events; sealOf picks the month's
	sealedAt: string;
	previous: AtmSignedSeal | null;
}): AtmSeal;

export const signSeal = (seal: AtmSeal, signer: AtmSigner): AtmSignedSeal;
```

- The events are already de-duplicated by `idem`, as `readEvents` does.
- `sealOf` covers every month event it is given. `sealedAt` is recorded, not used to pick events.

### The chain, and events that arrive late

Seals form one append-only chain per school, in the order they were made. **A month may be sealed more than once.** A Stripe event delivered after a month was sealed still lands in that month (its `date` comes from `event_time`), so the month can be sealed again to cover it.

Each seal lists the ids of the events it covers. Membership is by id, not by `ingest_time`, because the webhook handler stamps `ingest_time` when it writes the outbox row, before `atm ship` puts the event in the folder. A cutoff on `ingest_time` would leave out an event that was stamped before the seal but shipped after it, and the seal would later read as tampered. (An earlier draft of this spec used that cutoff; the code review of the implementation found the false alarm.) So:
- an earlier seal of a month **keeps verifying** after more events reach the folder;
- a later seal of the same month covers them too;
- any month event that the month's latest seal does not list is reported as **unsealed late**, not as tampering.

Seal after `atm ship` has run. `atm seal` holds a lock file per school (`ledger/seals.jsonl.lock`) while it reads the chain and appends, so two seals at once are refused instead of both linking to the same previous seal.

### Verifying seals

```ts
export type SealReport = {
	ok: boolean;
	seals: {
		month: string;
		sealed_at: string;
		verdict: "ok" | "bad_signature" | "unknown_key" | "broken_link" | "events_changed";
	}[];
	/** Month events that the month's latest seal does not list. */
	unsealedLate: { month: string; event_id: string; ingest_time: string }[];
};

export const verifySeals = (
	seals: readonly unknown[],
	events: readonly AtmEvent[],
	keys: AtmPublicKeys,
): SealReport;
```

For each seal, in chain order:
1. Check its shape and signature.
2. Check that `prev_seal_hash` matches the seal before it. A missing or reordered seal gives `broken_link`.
3. Look up each listed id and recompute `events_hash` and `transactions`. An edited event or a missing one gives `events_changed`.

### Known gap

An event inserted into a sealed month afterwards looks like a real late event. It isn't hidden: `verifySeals` lists every event the latest seal doesn't cover, so a reviewer sees it. Closing this gap needs the per-event chain written at ingest (a later milestone). A seal's size grows with the month's event count (about 30 bytes an id).

## CLI

The commands are added to `src/cli.ts`, read from the same folder layout as `atm journal` and `atm ship`, and keep the `atm` name for now. A rename to `tfd` is a separate change.

```bash
atm keys new --out <dir> [--id <key_id>]
#   writes <key_id>.private.pem (mode 0600) and <key_id>.public.pem, plus keys.json ({ key_id: public PEM }).
#   The default id is trifold-YYYY-MM. Refuses to overwrite an existing file.

atm receipt --root <folder> --school <id> --key <private.pem> --key-id <id> [--event <event_id>]
#   prints signed receipts as JSON lines: one event, or every receipted event of the school.

atm verify receipt <file|-> --keys <keys.json> [--root <folder> --school <id>]
#   checks the signature; with --root it also checks the receipt against the books.
#   Exits 0 if valid, 1 if not, printing the reason.

atm seal --root <folder> --school <id> --month <YYYY-MM> --key <private.pem> --key-id <id>
#   reads the chain from schools/<id>/ledger/seals.jsonl, appends the new signed seal, prints it.
#   sealed_at is now; that is the CLI's clock, not atm's.

atm verify seals --root <folder> --school <id> --keys <keys.json>
#   prints the SealReport. Exits 1 if any seal fails; unsealed late events alone exit 0.
```

`ledger/seals.jsonl` sits beside `ledger/build.json`. It's append-only: one signed seal per line, and lines are never rewritten.

## Schemas

- `schema/receipt.v1.json`: `AtmSignedReceipt`, with `additionalProperties: false` at every level.
- `schema/seal.v1.json`: `AtmSignedSeal`, likewise.
- Add both to `src/ledger/schemas.ts` beside the envelope and payload schemas.

## Files

| File | Change | Estimated lines |
|---|---|---|
| `src/ledger/receipt.ts` | New: `receiptOf`, `signReceipt`, `verifyReceipt`, `checkReceiptAgainstEvents` | ~130 |
| `src/ledger/seal.ts` | New: `sealOf`, `signSeal`, `verifySeals` | ~120 |
| `src/ledger/sign.ts` | New: shared `signBytes` / `verifyBytes`, key loading, the Ed25519 type check | ~40 |
| `src/cli.ts` | `keys new`, `receipt`, `verify receipt`, `seal`, `verify seals` | ~110 |
| `src/types.ts` | Receipt, seal, signer, key and verdict types | ~60 |
| `src/index.ts` | Exports | ~10 |
| `src/ledger/schemas.ts` | Register the two schemas | ~6 |
| `schema/receipt.v1.json`, `schema/seal.v1.json` | New | ~90 JSON |
| `tests/receipt.test.ts` | New | ~250 |
| `tests/seal.test.ts` | New | ~200 |
| `tests/cli-receipt.test.ts` | New: the CLI end to end over a temporary folder | ~120 |
| `tests/golden/receipt/` | New: a fixed event, receipt, signed receipt and a test key pair | fixtures |
| `README.md`, `UPGRADING.md`, `ROADMAP.md` | A "Receipts and seals" section and the roadmap entry | ~60 |

**Total: about 480 source lines plus 90 lines of JSON schema, about 570 test lines, 9 new files and 6 changed files.**

The full plan (per-event chain, key service, Stripe matching, itemised receipts, transparency log) is about 2,200 source lines and 2,850 test lines.

**Test keys:** the golden key pair is generated in the test, or stored as a fixture that is plainly a test key. Follow the repository's note on secret scanners: a committed PEM may trip them, so prefer generating the key at test time and pin only the public key's fingerprint.

## Tests

Receipts:
1. **Determinism:** the same event gives byte-identical receipts, and with the same key, identical signatures, across runs and processes.
2. **Golden:** a fixed event gives a pinned `event_hash`, pinned receipt bytes and a pinned signature. This catches any drift in `canonicalize`.
3. **Field mapping:**
   - a payment uses `amount_paid` and the invoice id;
   - a refund uses `amount` and its `id`;
   - `cause` passes through;
   - the receipt contains no `billing_email` or `billing_name`.
4. **Missing fields:** a missing or wrongly typed required payload field throws, naming the field.
5. **Types without receipts:** every other event type returns `null`, checked across the whole `AtmEventType` list so a new type isn't missed.
6. **Tampering:** changing `amount`, `event_time`, `stripe_id` or `event_hash` in a signed receipt gives `bad_signature`.
7. **Keys:** an unknown `key_id` gives `unknown_key`; a non-Ed25519 key passed to `signReceipt` throws.
8. **Untrusted input:** garbage, a missing field, an extra field or a wrong type gives `malformed`, never an exception.
9. **Against the ledger:**
   - an unchanged event → `ok`;
   - an edited amount or payload field → `event_changed`;
   - a deleted event → `missing_event`;
   - an event whose type was changed to one without receipts → `not_receipted`.

Seals:
10. Sealing, then changing or deleting an event in that month, gives `events_changed`.
11. Sealing October and November, then removing or reordering a seal, gives `broken_link`.
12. **Late events:** after sealing October, a new October event (whatever its `ingest_time`, including one stamped before the seal) gives `ok` for the first seal and one `unsealedLate` entry. Sealing October again covers it, and both seals verify.
13. A seal whose ids are unsorted or don't match its count is malformed; a second `atm seal` while the lock is held is refused.
14. Seals are deterministic given the same events, `sealedAt` and previous seal.

CLI:
15. End to end over a temporary folder: `keys new`, then `ship` the fixtures, then `receipt`, then `verify receipt` against the books passes. After editing an event file, `verify receipt` exits 1 with `event_changed`.

## The caller (buzz-school; not in this milestone's atm PR)

About 100 lines:

1. Generate one platform key with `atm keys new`. Store the private PEM as a secret, and publish `keys.json` at `/.well-known/trifold-keys.json`.
2. When the family service writes a `payment.succeeded` or `payment.refunded` event, call `receiptOf` and `signReceipt` and attach `receipt.json` to the family's payment email. Offer it in the portal under "Signed receipt".
3. A monthly cron, 7 days after the month ends (the close rule in KPI spec v4), runs `atm seal`, and again if late events have arrived since.
4. Publish the latest seal per month to the school's finance admin and, if wanted, the CPA, so copies exist outside the platform.

## Rollout

1. Land the atm PR against `dev`, after the local checks: `bun test --timeout 60000`, `tsc`, Biome on the changed files, the build and knip.
2. Release it in the next atm version, with the new exports described in `UPGRADING.md`.
3. Caller work in buzz-school.
4. Backfill: run `atm receipt` over history if past families should get receipts, and seal each closed month in order, oldest first.

## Risks and open decisions

1. **Erasing a family's personal data must not rewrite events.** If an erasure (`subject.erased`) ever edits stored payloads, for example to remove `billing_email`, every receipt and seal over those events breaks. Decision needed: personal data stays out of hashed fields, or erasure deletes keys rather than editing events, or seals hash `redacted` instead. Check what the family service does today before release.
2. **One platform key.** If it leaks, someone can forge receipts. Mitigations: keep it in a secret store, and support rotation through `key_id` (`keys.json` holds old keys so old receipts still verify). If a key is compromised, a list of revoked keys with dates is a later addition.
3. **The open month isn't sealed until it closes**, and insertions into a sealed month show up only as "late". This is the main limit of this milestone.
4. **Freezing the canonical form.** Pinned by the golden test. Any change to `canonicalize` needs a new receipt version.
5. **Wording in marketing:** after this milestone, say "signed receipts and sealed books". Don't say "triple-entry accounting" until Stripe matching ships (`docs/brand/trifold-brand-and-messaging.md`, "Claim rules").
6. **Owner decisions:**
   - the key id format;
   - whether refunds and the payment they refund appear together on a receipt;
   - whether disputes ever get a receipt;
   - whether the seal waits 7 days after the month ends.
