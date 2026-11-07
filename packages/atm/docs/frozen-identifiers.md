# Frozen identifiers

The engine is being renamed from `atm` to Trifold (the product and the managed service) and `tfd` (the CLI, and later the package). Some names with "atm" in them must not change in any rename step, because they are inside bytes that are already hashed, stored or sent to Stripe. Others can move, but only on a schedule. This page lists both. Checked against the tree on 2026-11-06.

## Frozen: never rename

| Identifier | Where | Why it is frozen | What a rename would break |
|---|---|---|---|
| `labels.mapping` values `atm/booking` and `atm/session-gift-code@v1` | `src/billing/booking-commands.ts:79` (`BOOKING_MAPPING`), `src/billing/codes.ts:45` (`CODE_MAPPING`) | They are written into each event's labels, so they are part of the event's canonical bytes. They are versioned identifiers (`@v1`), not prose. | Events written before and after the rename would carry different labels for the same rule. The bytes feed a receipt's `event_hash` (`src/ledger/receipt.ts:74`) and a seal's `events_hash` (`src/ledger/seal.ts:45`), so the old events cannot be rewritten to match. A new rule gets a new version, never a new prefix. |
| Stripe idempotency keys `atm:<school>:<op>:<sha>` | `src/billing/stripe-menu.ts:204` (`menuToStripe`), `src/billing/codes.ts:312` (`dollarGiftOps`) | Stripe dedupes a request by its key. Stripe keeps a key for at least 24 hours, and a caller may hold a planned step and retry it later. | A step sent again under a new prefix inside that window is a new request to Stripe: a duplicate product, price, coupon or promotion code. |
| Folder store temp prefix `.atm-tmp-` | `src/store/folder-store.ts:96` (`TEMP_PREFIX`; also takeover markers, line 480) | The store reserves names that start with it: it never lists them and refuses them as keys (line 112). A crash can leave such files beside the keys. | Under a new prefix only, a temp file or takeover marker left by an older version becomes a listable object, and the reader or shipper reads junk as data. A rename must reserve both prefixes forever, and a key that already starts with the new prefix would vanish from listings. |
| `atm_version` in shipped input lines | written by `src/ledger/ship-inputs.ts:153`, read at line 751; the stored row in `src/handler/inputs.ts` (lines 135 and 275) | It is a field in the batches `tfd inputs ship` has put in folders and R2, which are create-only and named by their content. | A reader that wants a new field name cannot read the batches already shipped. Readers must keep accepting `atm_version`; a new name could only be added beside it. |

## Rename only before the first deployment, by a migration, or never

| Identifier | Where | Status |
|---|---|---|
| The handler's SQLite names: `atm_subjects`, `atm_rows`, `atm_event_claims`, `atm_invoice_index`, `atm_payment_index`, `atm_event_inputs` (and its indexes `atm_event_inputs_subject`, `atm_event_inputs_unshipped`), `atm_input_contexts`, `atm_input_seeds`, `atm_input_erasures`, and the column `atm_version` | `src/handler/schema.ts` (lines 62 to 166; `atm_version` at 116) | No known deployment has these tables yet. Once a database has them, a rename needs a migration in `migrateHandlerSchema`. |
| The grants row table `atm_grants` | `src/billing/rows.ts:37`, exported as `GRANTS_TABLE` | Stored as the `table` of a subject's grants row. Same rule as the SQLite names. |

These names are also committed in goldens and fixtures: `atm_version` in `tests/golden/simulate/inputs-*.json`, and `atm_grants` in the 0.3.0 log fixtures (`fixtures/log-0.3.0/*/rows.json`). A rename rewrites the simulate goldens; the 0.3.0 fixtures are a record of what 0.3.0 wrote and stay as they are, so a reader must keep accepting `atm_grants` there.

## Renameable later, with the goldens

- The `"atm"` channel key in `fixtures/scenarios/*/hashes.json` (and the `atm` value of `--channels`). It names the engine's own KPI fold; it is not inside any hashed bytes. It can be renamed in step 4, together with the goldens that hold it.

## Never rewrite: provenance

- `plans/ledger-ui/design/mart/bundle.json` says `"generated":"from /tmp/atm-mart (atm dev, scenario goldens)"`, and its sha256 is pinned in `plans/ledger-ui/design/mart/SNAPSHOT.md`. Editing the string breaks the pin.
- The ledger UI goldens (`packages/ledger-ui/test/golden/*.json`) and `packages/ledger-ui/gates/` cite `atm dev <sha>` as the commit they were read at. That is history.

## Cross-repo contracts: move only with a compatibility window

These are not frozen forever, but each has a consumer outside this package. They move in step 3, with a window in which both names work.

- **The release.** buzz-school pins the tarball `https://github.com/justbry/atm/releases/download/atm-v<version>/atm-<version>.tgz` by URL and sha512 (`bun.lock`), and imports from `"atm"`. The tags `atm-v0.1.0` to `atm-v0.9.0` (0.2.0 and 0.7.0 were never tagged) stay as they are.
- **The ledger JWT audience** `atm-ledger` (`plans/ledger-ui/S8-contract.md`): the token from `POST /school-admin/ledger-token` carries it, and the ledger Worker refuses any other `aud`.
- **The environment variables** `ATM_R2_ENDPOINT`, `ATM_R2_BUCKET`, `ATM_R2_PREFIX`, `ATM_R2_ACCESS_KEY_ID`, `ATM_R2_SECRET_ACCESS_KEY`, `ATM_R2_SESSION_TOKEN` (`src/ledger/inputs-destination.ts`): set in deployments and cron lines.
- **The log prefixes** `atm: …` of `deps.warn` (`src/handler/stripe-webhook.ts`: `atm: non_usd:`, `atm: fee_unknown:`) and `atm report: …` (`src/ledger/report.ts`): a log alert may match on them.
