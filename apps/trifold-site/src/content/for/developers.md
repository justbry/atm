## What's in the repository

- **The engine (tfd):** Stripe events in, double-entry books out, deterministic and replayable. Its source is public on GitHub and free to self-host, under FSL-1.1-ALv2 (source-available). Each release becomes Apache-2.0 two years after it ships.
- **Signed receipts and sealed months:** Ed25519 over a fixed canonical form (JSON with sorted keys). Receipts carry a sha256 of the event they came from; seals chain month to month.
- **Open formats:** JSON schemas for receipts and seals (Apache-2.0), golden test vectors (CC0-1.0), hledger journals and Parquet exports.
- **A free CLI:** make keys, print signed receipts, seal a month, verify receipts and seal chains, reconcile against Stripe.

The verifier on this site is a line-for-line port of the engine's check to the browser, tested against the engine on the same samples. The verifier and receipt format are Apache-2.0.

## Licenses

| Part | License |
|---|---|
| tfd engine and CLI | FSL-1.1-ALv2. Source-available and free to self-host. Each release becomes Apache-2.0 two years after it ships |
| Receipt and seal format, spec and verifier | Apache-2.0 |
| Test vectors | CC0-1.0 (public domain) |
| Hosted Trifold service, Rifo and the witness | Proprietary |


## On the roadmap

The hosted service, a hash chain per event and Trifold as an independent witness are marked Next. The CLI is `tfd` (the `atm` command until the rename lands).
