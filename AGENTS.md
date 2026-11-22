# AGENTS.md

Decisions and rules for anyone, human or agent, working in this repo. Git and code-style rules are in `.claude/CLAUDE.md`. Decided 2026-11-06 unless noted.

## Names

| Name | What it is |
|---|---|
| **Trifold** | The company and the managed (hosted) service. |
| **tfd** | The code base, package and CLI. The package is named `tfd`; its directory is still `packages/atm`, and the `atm` command still works beside `tfd`. It replaces the name "atm". In prose the engine may also be called "the Trifold engine". |
| **Rifo** | Trifold's AI agent. It drafts, explains and proposes; the engine computes every number; a person approves. Not shipped yet. |

"Trivalance" is dropped; don't use it.

### The atm → tfd rename is phased

`plans/tfd-rename.md` has the steps; `packages/atm/docs/frozen-identifiers.md` lists the names that never change, with the reasons. Until a step lands:
- In prose, say **tfd**; command examples say `tfd`.
- Keep literal paths (`packages/atm/...`), the repo name `justbry/atm` in `UPSTREAM.md` and release URLs (old `atm-v*` releases, up to `atm-v0.10.0`, stay there; `release.ts` still publishes there), and existing `ATM_*` environment variables as they are. The working repository is `justbry/tfd` since 2026-11-07: new PRs go there, against `dev`.
- Never change bytes inside signed or golden data (receipts, seals, key ids such as `atm-test-1`, schema `$id`s) to rename anything. Signatures and test vectors depend on them.
- Stored identifiers that contain "atm" stay frozen: mapping labels `atm/booking` and `atm/session-gift-code@v1`, Stripe idempotency keys prefixed `atm:`, the `.atm-tmp-` temp prefix, and `atm_version` in shipped input lines. Renaming them breaks replay, idempotency or existing data.

## Licensing

| Part | License | Where |
|---|---|---|
| Autumn code this repo forks (`packages/balance-engine`, `shared`, and the rest of the upstream tree) | **Apache-2.0**, unchanged | `LICENSE`, `UPSTREAM.md` |
| tfd engine and CLI (`packages/atm`, except the next two rows) | **FSL-1.1-ALv2**: source-available; no Competing Use; each release becomes Apache-2.0 two years after it ships | `packages/atm/LICENSE.md` |
| Receipt and seal format, spec and verifier (`schema/receipt.v1.json`, `schema/seal.v1.json`, `docs/receipts.md`, `src/ledger/{receipt,seal,sign,util}.ts`) | **Apache-2.0** | SPDX headers; `packages/atm/REUSE.toml` |
| Receipt test vectors (`packages/atm/tests/golden/receipt/`) | **CC0-1.0** | `packages/atm/REUSE.toml` |
| The website (`apps/trifold-site`): all of it, code, copy, design, images | **Proprietary**, all rights reserved | `apps/trifold-site/LICENSE` |
| Trifold's plan catalog (`catalog/trifold`): its menus, policy and the code that reads them | **Proprietary**, all rights reserved | `catalog/trifold/LICENSE` |
| The pitch brief (`apps/trifold-brief`): the password-protected, multi-audience decks, their sources, scripts and rendered pages | **Proprietary**, all rights reserved; embedded fonts under the SIL OFL 1.1 | `apps/trifold-brief/LICENSE` |
| Logo concepts (`docs/brand/logo/`): SVGs, animations, favicons, previews | **Proprietary**, all rights reserved | `docs/brand/logo/LICENSE` |
| The verifier SDK `tfd-verify` (`packages/verify`): tfd's receipt and seal checks for browsers and other WebCrypto runtimes; the website's verifier comes from it | **Apache-2.0** | SPDX headers; `packages/verify/LICENSE`, `packages/verify/REUSE.toml` |
| The promissory-note engine `tfd-notes` (`packages/tfd-notes`): schedule, interest and two-party balance statements; its golden vectors (`tests/golden/`) are CC0-1.0. Apache-2.0 so anyone can recompute a statement; decided 2026-11-12 | **Apache-2.0**; vectors **CC0-1.0** | SPDX headers; `packages/tfd-notes/LICENSE`, `packages/tfd-notes/REUSE.toml` |
| Hosted service, Rifo, the witness | Proprietary, not in this repo | — |

`packages/atm/LICENSING.md` explains the package's licenses in prose. `REUSE.toml` is the machine-readable map: keep both in step when files move.

**Why.** "Anyone can check, forever" needs checking that can never be restricted, so the format, the verifier and the vectors are permissive from day one. FSL stops a hosted clone of the engine; the two-year conversion backs up the promise that the records outlive the company. The owner considered three years on 2026-11-07 and kept FSL with its fixed two years (three years would mean BUSL-1.1 with a custom grant). tfd 0.10.0 (2026-11-07) is the first FSL release; releases up to 0.9.0 stay Apache-2.0.

**Rules for code:**
- A new file that implements receipt or seal *verification* or the format belongs with the Apache-2.0 files: give it an `SPDX-License-Identifier: Apache-2.0` header and add it to `LICENSING.md` and `REUSE.toml`. It must not import FSL code.
- Apache-2.0 files under `packages/atm` must import only other Apache-2.0 files, or third-party packages.
- `packages/verify` is Apache-2.0 throughout and must not import from `packages/atm`. Verification code the website needs goes there, not into `apps/trifold-site`, which keeps no Apache-2.0 files.
- The website's build ships third-party code, so it writes `/licenses.txt` (`apps/trifold-site/third-party-notices.ts`) with every bundled package's license text; the legal page links to it.
- `packages/tfd-notes` is Apache-2.0 throughout and must not import from `packages/atm` or any FSL code. `packages/atm` may import it (FSL code may use Apache-2.0 code), and so may `packages/verify`.
- Don't copy FSL code into Apache-2.0 files, or into other packages.
- Mark an Autumn file you modify at its top and list it in `UPSTREAM.md` (Apache-2.0 section 4).

**Rules for words (docs, site, marketing):**
- Never call tfd "open source" (FSL isn't OSI-approved). Say "source-available", "Fair Source", or "free to self-host".
- "Open format", "open spec", "open standard" and "open verifier" are fine.
- Fine: "The verifier and receipt format are Apache-2.0." "Every tfd release becomes Apache-2.0 two years after it ships."

### Open licensing items

1. **Licensor name.** `LICENSE.md` says "Trifold" until a legal entity exists; then put the entity's name there.
2. **Accounting firms.** FSL allows "professional services" on a client's own install. A firm hosting tfd for many clients may be a Competing Use. Decide whether to add a grant before the accountant partner program launches. The tradeoffs are in `docs/business/pricing-strategy.md` §4c.
3. ~~**Contributor terms.**~~ **Decided 2026-11-07: a CLA** (individual and corporate, adapted from the Apache ICLA and CCLA, licensing contributions to Trifold under any terms). See `CONTRIBUTING.md`; the v0.1 drafts and the setup checklist are in `legal/cla/`. Outside contributions wait until a lawyer has reviewed the text and it is published.
4. **Event envelope schema.** Decide whether `schema/envelope.v1.json` and the payload schemas should also be Apache-2.0, so other ledgers can adopt the full standard. The KPI spec (`schema/kpis.v1.json`, `kpis/`) is FSL too, so don't call it part of the open standard unless it moves.
5. **Other Trifold code.** New code outside `packages/atm`, such as `packages/ledger-ui`, falls under the root Apache-2.0 `LICENSE` by default. Decide whether parts of it should be FSL or move to a private repo.

## Trademarks

`TRADEMARKS.md` governs the names Trifold, Witnessed by Trifold, tfd and Rifo, and the logo. In short:
- The code licenses grant no trademark rights.
- Forks and hosted services must rename.
- "Witnessed by Trifold" goes only on a record that carries a valid Trifold witness signature.
- Marks take ™, never ®, until they are registered.

## Claims

What the site and docs may say depends on what has shipped.
- Never "triple-entry" for Trifold. Whether it may ever be used, once milestones 2 and 3 ship, is open: this rule said "until milestones 2 and 3 ship" while the business plan, pricing strategy and brand doc say never. Until the owner decides, don't use it.
- Say "signed receipts and sealed books" for what milestone 1 built. Say that tfd signs receipts and seals months; don't say schools or families use them until a school issues real receipts.
- Never "Not even Trifold can quietly change your books."
- No speed numbers.
- Rifo, the witness, daily payout matching and tax packages are **Next** or **Later**. Never describe them as shipped.
