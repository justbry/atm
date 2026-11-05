# atm

Autumn's balance engine (`@autumn/balance-engine`) as a local CLI and a TypeScript library. It runs one engine command against a subject and returns what the engine decides; it reads and writes nothing else.

Commands it runs: `check`, `finalize`, `confirmExpiredLock`, `reset`, `recalculateBalance`, `track`, `updateBalance`, `deleteBalance`. Not run: `evict`, `initialize` and `applyBillingPlan` take a `SubjectState` (and a catalog or entities), not a subject.

## CLI

```bash
bun install                      # at the repository root
bun run --cwd packages/atm atm run --subject subject.json --command check.json
```

- `--subject`: a `WorkerFullSubject` (customer, entity, products, entitlements, pools, usage windows, open locks).
- `--command`: an engine command with its `type`, validated by the engine's own parser.
- Either may be `-` to read stdin. The result is printed as JSON; an error exits non-zero.

## Library

```ts
import { runEngineCommand, type AtmCheckResult } from "atm";

const decision: AtmCheckResult = runEngineCommand({ subject, command }); // command.type === "check"
```

- The result type follows `command.type`: `AtmCheckResult` for `check`, `AtmMutation` (row changes guarded by `revision.before`) for `finalize` and `confirmExpiredLock`, `AtmMutation | null` for `reset` and `updateBalance` (null when nothing moves), `AtmMutation` for `track` and `deleteBalance`.
- Inside this workspace, Bun imports the source (`exports` condition `bun`); anywhere else, the built files.

## Billing

Pure rules for a school's menu, its Stripe facts, credit grants and storage rows. No I/O, no clock: every function takes its time and state as arguments, so the family service only does I/O around them (read rows, call Stripe, write rows) and the same input always gives the same output.

- Policy: `DEFAULT_POLICY`, `resolvePolicy` (a school's overrides over the defaults).
- Menu: `validateMenu`, `publishProblems`, `publicMenu`, `validTimeZone`, `MAX_TIERS`, `MAX_ADDONS`, `MAX_FEATURES`.
- Menu to Stripe: `menuToStripe` (idempotent steps that make Stripe match a menu), `checkoutParams`, `withPriceIds`, `toStripeForm`, `lookupKeyOf`.
- Stripe events to facts: `normalize`, `mappingFor`, `mappingLabels`, `MAPPINGS` (declarative mappings in `schema/mapping/`, bundled; regenerate the index with `bun schema/mapping/build.ts`), `resolveLines`, `resolveInvoice`, `redactPersonal`, `subscriptionStatus`.
- Facts to credits: `menuCatalogRows`, `invoiceToCommands`, `refundToCommands`, `disputeToCommands`, `subscriptionEndedToCommands`, `EMPTY_GRANTS_STATE`, then `runOnState` to run the commands (an invoice makes an `applyBillingPlan`, which `runEngineCommand` does not run). A refund or dispute reads what each credit row holds from the subject (`subjectFromRows`), so it never takes a balance below zero and also takes back the rolled-over leftovers of the invoice it refunds. A canceled subscription stops the refills and lets its last cycle's unused credits lapse at their own expiry.
- Storage rows: `subjectKey`, `subjectFromRows`, `rowChangesFromMutation`, `applyRowChanges`, `stateFromRows`, `rowsFromState`, `ROW_TABLES`, `assertRevision`, `StaleRevision`. The billing rules' `GrantsState` is one more JSON row of the subject (`GRANTS_TABLE`, `grantsFromRows`, `grantsRow`) under the same revision.
- **One entry point**: `handleStripeEvent({ event, eventId, menu, menuVersion, policy, policyVersion, rows, revision, catalog, now, priceIds, invoiceIds })` gives `{ rowChanges, events, refused? }`. The caller verifies the signature, dedupes on the event id, loads the subject's rows, calls it and writes `rowChanges` and `events` in one transaction. Replaying an event gives `rowChanges: null`; an event atm cannot decide comes back `refused` with nothing to write. Two things a Stripe event (API `2025-10-29.clover`) does not carry are the caller's: `priceIds` (lookup key to Stripe price id, from publishing the menu: a line names its price by id only) and `invoiceIds` (payment intent to invoice id, from `invoice_payment.paid`: a charge or dispute does not name its invoice).
- Shapes: `schema/stripe/objects.clover.json` is Stripe's OpenAPI spec for the pinned API version, pruned to the objects the mappings read (`bun run stripe-spec <spec3.json>`). The tests check every mapping path and every synthetic event against it.

## Build

```bash
bun run --cwd packages/atm build   # or: bun build.ts <outDir>
```

| File | What |
|---|---|
| `dist/atm.js` | the CLI, one file, engine bundled (about 2 MB) |
| `dist/index.js` | the library (about 2.3 MB), one ESM file, engine, ajv and the JSON schemas and mappings bundled; runs under Bun and Node with no `node_modules` |
| `dist/index.d.ts`, `dist/types.d.ts` | the library's types; they import nothing else (the build fails if they would) |

The public types (`src/types.ts`) are atm's own JSON shapes, not the engine's zod types, so a consumer needs no engine, zod or `@autumn/shared` types. `tests/types.test.ts` stops compiling if the engine's types stop fitting them; `tests/dist.test.ts` builds into an empty directory and typechecks and runs the result there.

## Ledger (slices 1-5)

- `atm journal --root <folder> --school <id> --month YYYY-MM`: events under `<folder>/schools/<id>/events/` to `ledger/b4u/YYYY-MM.journal`, `ledger/accounts.journal`, `main.journal`, `ledger/build.json`; a file is rewritten only if its bytes change.
- Library: `mutationToEvents`, `ledgerEvent`, `lapsedRows`/`lapseEvent`, `validateEvent`, `replayEvents`, `buildJournal`.
- `schema/`: `envelope.v1.json`, `payload/<event_type>.v1.json`, `duckdb/envelope.v1.sql` (regenerate with `bun run schema`).
- `fixtures/`: a seeded year of one member (`bun run fixtures -- --seed 1 --out <dir>`); `fixtures/vibes-year` is seed 1.
- The engine reads the process time zone for rollover expiry; ledger runs pin UTC around each engine call.

Next, from the B4 Uni ledger spec: `parity`, `verify`, `plans push`, `inbox check`, `load`. Provenance and changes to upstream: `../../UPSTREAM.md`.
