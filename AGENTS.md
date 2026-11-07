# AGENTS.md

Decisions and rules for anyone, human or agent, working in this repo. Git and code-style rules are in `.claude/CLAUDE.md`. Decided 2026-11-06 unless noted.

## Names

| Name | What it is |
|---|---|
| **Trifold** | The company and the managed (hosted) service. |
| **tfd** | The code base, package and CLI (today `packages/atm`; the `tfd` command ships beside `atm`). It replaces the name "atm". In prose the engine may also be called "the Trifold engine". |
| **Rifo** | Trifold's AI agent. It drafts, explains and proposes; the engine computes every number; a person approves. Not shipped yet. |

"Trivalance" is dropped; don't use it.

### The atm → tfd rename is phased

`plans/tfd-rename.md` has the steps; `packages/atm/docs/frozen-identifiers.md` lists the names that never change, with the reasons. Until a step lands:
- In prose, say **tfd**; command examples say `tfd`.
- Keep literal paths (`packages/atm/...`), the package name `atm`, the repo name `justbry/atm` in `UPSTREAM.md` and release URLs, and existing `ATM_*` environment variables as they are.
- Never change bytes inside signed or golden data (receipts, seals, key ids such as `atm-test-1`, schema `$id`s) to rename anything. Signatures and test vectors depend on them.
- Stored identifiers that contain "atm" stay frozen: mapping labels `atm/booking` and `atm/session-gift-code@v1`, Stripe idempotency keys prefixed `atm:`, the `.atm-tmp-` temp prefix, and `atm_version` in shipped input lines. Renaming them breaks replay, idempotency or existing data.

## Licensing

| Part | License | Where |
|---|---|---|
| Autumn code this repo forks (`packages/balance-engine`, `shared`, and the rest of the upstream tree) | **Apache-2.0**, unchanged | `LICENSE`, `UPSTREAM.md` |
| tfd engine and CLI (`packages/atm`, except the next two rows) | **FSL-1.1-ALv2**: source-available; no Competing Use; each release becomes Apache-2.0 two years after it ships | `packages/atm/LICENSE.md` |
| Receipt and seal format, spec and verifier (`schema/receipt.v1.json`, `schema/seal.v1.json`, `docs/receipts.md`, `src/ledger/{receipt,seal,sign,util}.ts`) | **Apache-2.0** | SPDX headers; `packages/atm/REUSE.toml` |
| Receipt test vectors (`packages/atm/tests/golden/receipt/`) | **CC0-1.0** | `packages/atm/REUSE.toml` |
| The website's in-browser verifier (`apps/trifold-site/src/lib/verify/`) | **Apache-2.0** | SPDX headers |
| Hosted service, Rifo, the witness | Proprietary, not in this repo | — |

`packages/atm/LICENSING.md` explains the package's licenses in prose. `REUSE.toml` is the machine-readable map: keep both in step when files move.

**Why.** "Anyone can check, forever" needs checking that can never be restricted, so the format, the verifier and the vectors are permissive from day one. FSL stops a hosted clone of the engine; the two-year conversion backs up the promise that the records outlive the company.

**Rules for code:**
- A new file that implements receipt or seal *verification* or the format belongs with the Apache-2.0 files: give it an `SPDX-License-Identifier: Apache-2.0` header and add it to `LICENSING.md` and `REUSE.toml`. It must not import FSL code.
- Apache-2.0 files under `packages/atm` must import only other Apache-2.0 files, or third-party packages.
- Don't copy FSL code into Apache-2.0 files, or into other packages.
- Mark an Autumn file you modify at its top and list it in `UPSTREAM.md` (Apache-2.0 section 4).

**Rules for words (docs, site, marketing):**
- Never call tfd "open source" (FSL isn't OSI-approved). Say "source-available", "Fair Source", or "free to self-host".
- "Open format", "open spec", "open standard" and "open verifier" are fine.
- Fine: "The verifier and receipt format are Apache-2.0." "Every tfd release becomes Apache-2.0 two years after it ships."

### Open licensing items

1. **Licensor name.** `LICENSE.md` says "Trifold" until a legal entity exists; then put the entity's name there.
2. **Accounting firms.** FSL allows "professional services" on a client's own install. A firm hosting tfd for many clients may be a Competing Use. Decide whether to add a grant before the accountant partner program launches.
3. **Contributor terms.** Choose DCO or CLA before accepting outside contributions. A CLA keeps relicensing possible.
4. **Event envelope schema.** Decide whether `schema/envelope.v1.json` and the payload schemas should also be Apache-2.0, so other ledgers can adopt the full standard.
5. **Other Trifold code.** New code outside `packages/atm`, such as `packages/ledger-ui`, falls under the root Apache-2.0 `LICENSE` by default. Decide whether parts of it should be FSL or move to a private repo.

## Claims

What the site and docs may say depends on what has shipped.
- Never "triple-entry" for Trifold until milestones 2 and 3 ship.
- Never "Not even Trifold can quietly change your books."
- No speed numbers.
- Rifo, the witness, daily payout matching and tax packages are **Next** or **Later**. Never describe them as shipped.
