# Licensing

tfd (this package, still named `atm` until rename step 4) is source-available. Each file falls under one of these licenses; `REUSE.toml` is the machine-readable version of this table.

| What | License | Text |
|---|---|---|
| The engine and CLI: everything in this package not listed below | **FSL-1.1-ALv2** (Functional Source License 1.1, Apache 2.0 future license) | `LICENSE.md` |
| The receipt and seal format and their verifier: `schema/receipt.v1.json`, `schema/seal.v1.json`, `docs/receipts.md`, `src/ledger/receipt.ts`, `src/ledger/seal.ts`, `src/ledger/sign.ts`, `src/ledger/util.ts` | **Apache-2.0** | `LICENSES/Apache-2.0.txt` |
| The receipt test vectors: `tests/golden/receipt/` | **CC0-1.0** (public domain) | `LICENSES/CC0-1.0.txt` |
| Autumn's code this package builds on and bundles into `dist/` (`@autumn/balance-engine`, `@autumn/shared` and their dependencies) | **Apache-2.0**, unchanged from upstream | `LICENSES/Apache-2.0.txt`; see `UPSTREAM.md` at the repo root |

## What FSL allows

You may use, copy, modify and redistribute tfd for any purpose except a **Competing Use**: making it available to others in a commercial product or service that substitutes for tfd or for Trifold's hosted service, or offers substantially the same functionality.

Allowed, for example:
- Running tfd for your own organization's books, on your own machines.
- Non-commercial education and research.
- An accountant or bookkeeper working on a client's own tfd install.

**Each release becomes Apache-2.0 on the second anniversary of its release**, with no further action from anyone. The Apache-2.0 parts above are Apache-2.0 from day one, so anyone can check a receipt or a seal, forever, without asking.

## Why

The promise is that anyone can check the books, and that the records outlive the company. Checking can never be restricted, so the format, the verifier and the test vectors are permissively licensed now. The engine is protected from a hosted clone for two years, then opens up too.

## Contributing

Outside contributions wait until the contributor terms (DCO or CLA) are decided; see `AGENTS.md` at the repo root.
