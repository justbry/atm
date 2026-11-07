# Comparisons with other billing systems

How the Trifold engine stands against Orb, Metronome, OpenMeter, Lago, Flexprice, Kill Bill and Polar. Moved here from `ROADMAP.md` in the roadmap split; the wording is the original. Related: `docs/usage-metering.md` (metered usage, ruled out as a product), `docs/README.md`.

## How this was read

Competitor behaviour comes from the vendors' public docs as read on 2026-11-04, not from running their products. (From the status line of the roadmap.) The section on open-source billing below was written from memory and not run: see its first line.

## Credit ledger depth (from the Orb, Metronome and OpenMeter comparison)

- Not built: drawdown by priority and by cost basis, and a `pending_payment`-style hold on credits whose invoice is unpaid. The Trifold engine draws by expiry then oldest grant.

## Compared with open-source billing (Lago, OpenMeter, Flexprice, Kill Bill, Polar)

Written 2026-11-05 from memory of their public docs, not read or run; check a row before acting on it. What the Trifold engine lacks that they have, and where it stands here:
- Metered usage rating and invoicing: ruled out above.
- Prepaid wallets and auto top-up (Lago, Flexprice): not built. The Autumn monorepo has an `auto-topup` package that the Trifold engine does not use.
- Other payment providers (Lago, Kill Bill, Flexprice): the Trifold engine is Stripe only. Not planned.
- Own subscription lifecycle (proration, trials, dunning, coupons): left to Stripe, see Ruled out.
- Tax, invoice PDFs, the customer portal itself (the Trifold engine only builds the configuration for tiers sold in quantities: `portalConfigOf`), admin UI, REST API, multi-tenant auth: left to Stripe and the caller.
- Revenue analytics (MRR and similar): only the ledger export; the Parquet export and any dashboard are not built.
- Expiry alerts by the clock: see Alerts above.
- Rebuild from the log: `replayEvents` now reproduces what `handleStripeEvent` wrote (see Review above); `simulate` and a rebuild of a subject's rows from a stored log are not built.
- Reuse outside B4 Uni: see "Decouple, the cheap parts" (prefix, `family_id`, `env`, menu limits), and the Worker handler blocked on `ajv`.
- SOC 2, a DPA and subprocessor list: none; the caller writes them.
