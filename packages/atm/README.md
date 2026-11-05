# atm

Autumn's balance engine (`@autumn/balance-engine`) as a local CLI and a TypeScript library. It runs one engine command against a subject and returns what the engine decides; it reads and writes nothing else.

**Scope.** atm is a credits and flat-subscription engine: it grants credits from paid fixed-price invoices (tiers, add-ons, gifts) and a `track` spends them. It does not price metered usage or invoice it, and it does not deliver webhooks or email. What is planned or ruled out is in `ROADMAP.md`.

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

- Policy: `DEFAULT_POLICY`, `resolvePolicy` (a school's overrides over the defaults), `commandOrg(policy)` (the `org` for every command that draws; see Deduction order).
- Menu: `validateMenu`, `publishProblems`, `publicMenu`, `validTimeZone`, `MAX_TIERS`, `MAX_ADDONS`, `MAX_FEATURES`.
- Menu to Stripe: `menuToStripe` (idempotent steps that make Stripe match a menu), `checkoutParams`, `withPriceIds`, `toStripeForm`, `lookupKeyOf`, `portalConfigOf` (the billing portal for tiers sold in quantities: see Billing portal).
  - Quantities: a tier with `quantities` (1 to 6 unique whole counts from 1 to 50, ascending, e.g. `[1, 2, 4]` sessions a month) is sold in one of them, so a studio sells "Shine" at 1, 2 or 4 a month as one tier, not three (`MAX_TIERS` is 4). Its prices and grant amounts are per unit; a tier without `quantities` is sold one at a time. `checkoutParams` takes `quantity` (default 1): one of the tier's counts, else `{ reason: "quantity_not_offered", quantity }` (the family service answers 400 `fields: ["quantity"]`). The tier's line is at that quantity, add-ons at one, and the subscription's metadata says `quantity` unless it is the default 1 (informational: the item's quantity at Stripe is the truth). Lookup keys and Stripe prices are per unit, so changing a tier's `quantities` makes no `menuToStripe` step, and the member code takes its percentage off each unit. Credits follow paid invoices: a raise (same tier, more units) grants the extra units' share of the cycle left per `policy.upgradeGrant`, and needs the subscription update made with `proration_behavior: "always_invoice"` so Stripe bills it at once; a decrease grants nothing and takes effect at the next renewal (schedule it, so the lower count is not billed early), where the allowance refills at the new count and the rollover cap, one per row in the engine, follows the new lower count. A line with a quantity below 1 is dropped, never counted as 1. A yearly plan paid once grants twelve monthly allowances per unit.
- Stripe events to facts: `normalize`, `mappingFor`, `mappingLabels`, `MAPPINGS` (declarative mappings in `schema/mapping/`, bundled; regenerate the index with `bun schema/mapping/build.ts`), `resolveLines`, `resolveInvoice`, `resolveSubscriptionPlan`, `redactPersonal`, `subscriptionStatus`.
- Facts to credits: `menuCatalogRows`, `invoiceToCommands`, `refundToCommands`, `disputeToCommands`, `subscriptionToCommands`, `subscriptionEndedToCommands`, `EMPTY_GRANTS_STATE`, then `runOnState` to run the commands (an invoice makes an `applyBillingPlan`, which `runEngineCommand` does not run). A refund or dispute reads what each credit row holds from the subject (`subjectFromRows`), so it never takes a balance below zero and also takes back the rolled-over leftovers of the invoice it refunds. A canceled subscription stops the refills and lets its last cycle's unused credits lapse at their own expiry.
  - Every `customer.subscription.created/updated/deleted` also records `membership` in the grants state: the status (`subscriptionStatus`), the tier and interval the menu names for the subscription's price items (by lookup key, else price id; the checkout metadata goes stale after a portal change and is not read), the renewal or end date, and the event time. It grants nothing: credits come from paid invoices, so `tierId` and `interval` in the grants state move only with an invoice, and a change Stripe has made that no invoice has paid yet shows as `membership.tierId` differing from `tierId`. An older event than the one on record, or a replay, changes nothing. A subscription seen before its first invoice names the family in its metadata and makes a grants-only write.
  - By design (B4 Uni "Default billing rules"): a partial refund and an open dispute change nothing; only a full refund and a lost dispute take unused credits back.
- Storage rows: `subjectKey`, `subjectFromRows`, `rowChangesFromMutation`, `applyRowChanges`, `stateFromRows`, `rowsFromState`, `ROW_TABLES`, `assertRevision`, `StaleRevision`. The billing rules' `GrantsState` is one more JSON row of the subject (`GRANTS_TABLE`, `grantsFromRows`, `grantsRow`) under the same revision.
- **One entry point**: `handleStripeEvent({ event, eventId, menu, menuVersion, policy, policyVersion, rows, revision, catalog, now, priceIds, invoiceIds })` gives `{ rowChanges, events, refused? }`. The caller verifies the signature, dedupes on the event id, loads the subject's rows, calls it and writes `rowChanges` and `events` in one transaction. Replaying an event gives `rowChanges: null`; an event atm cannot decide comes back `refused` with nothing to write. Two things a Stripe event (API `2025-10-29.clover`) does not carry are the caller's: `priceIds` (lookup key to Stripe price id, from publishing the menu: a line names its price by id only) and `invoiceIds` (payment intent to invoice id, from `invoice_payment.paid`: a charge or dispute does not name its invoice).
- Shapes: `schema/stripe/objects.clover.json` is Stripe's OpenAPI spec for the pinned API version, pruned to the objects the mappings read (`bun run stripe-spec <spec3.json>`). The tests check every mapping path and every synthetic event against it.

### Billing portal

`portalConfigOf(menu, { products, prices })` returns the form fields for `POST /v1/billing_portal/configurations` (the flattened `features[...]` shape `toStripeForm` makes), or `null` when no tier is sold in quantities (the school's default portal then applies). `products` and `prices` hold the Stripe ids the publish made, by the menu's keys: `products["t:<tierId>"]` and `prices["t:<tierId>:<interval>"]`. The caller makes the request, stores the configuration's id, and passes it as `configuration` on every `POST /v1/billing_portal/sessions`.

- A **raise** is billed at once (`features[subscription_update][proration_behavior]=always_invoice`), so its paid invoice grants the extra units now; a **decrease** is scheduled for the renewal (`schedule_at_period_end` with `decreasing_item_amount`) and grants nothing. Without this configuration, Stripe bills a raise at the renewal and nothing is granted until then.
- Only the quantity can change (`default_allowed_updates=[quantity]`): one `products[]` entry for each public tier with more than one count in `quantities` and a published product, with its published prices and `adjustable_quantity` from its smallest to its largest count. A tier switch is not offered. A tier with one count, a tier that is not public, a tier with no product id and a tier with none of its prices published (Stripe requires `prices` on each product) are left out. Stripe takes the quantity as a range, not a list: a tier sold in `[1, 2, 4]` also lets a member pick 3 in the portal (`checkoutParams` refuses 3 as `quantity_not_offered`), and the credits follow the quantity per unit.
- Cancel is at the period end; the payment method and the invoice history are enabled. The configuration is marked `metadata[b4u_key]=portal`.
- Field names are from Stripe's API reference for portal configurations. atm's pruned OpenAPI spec (`schema/stripe/`) holds only the objects the mappings read, so the request is not checked against it.

### Deduction order

A `track` takes from a holder's credit rows for one feature in this order (Autumn's engine, `balance-engine/src/deduction/deduct.ts`):

1. **Unlimited** rows.
2. **Rollovers**, soonest-expiring first, rollovers without an expiry last. A rollover is always spent before the row it came from, whatever the order below.
3. **Included** rows, in the order below.
4. **Overage** (only where the plan allows it).

`policy.deductionOrder` sets the order inside step 3. The caller puts `commandOrg(policy)` on every command that draws: `track`, `check`, `finalize`, `updateBalance` (the gap to a target balance, or the amount, is drawn like a `track`), `deleteBalance` (the usage moves to the rows left) and `recalculateBalance` (it redraws the usage); a caller that sends its own org config gets `engine` (the second line below), because the engine reads the setting from the command, not from atm.

- `expiry` (default): the row whose unused credits lapse soonest goes first, then the oldest grant (`created_at`). A refilling row lapses at its `next_reset_at` (what is left rolls over within its `max`, or is lost); a one-off row (gift, pack, a cancelled plan's last cycle) at its `expires_at`; a row that never lapses goes last. The engine keeps its earlier groupings (listed balances, entity level, boolean, credit systems, unlimited) and reorders only within each.
- `engine`: Autumn's own order. Rows that refill (have a `next_reset_at`) first, then the shorter reset interval, then soonest `expires_at` (none last), then add-ons after the main plan, then prepaid before pay-per-use, then oldest first. `reverse_deduction_order` (off in `commandOrg`) flips the first two steps; under `expiry` it has no effect.

So a gift that lapses before the tier's next reset is spent first under `expiry` and after the tier row under `engine` (`tests/billing-handle.test.ts`, "deduction order"). The engine option (`org.config.deduction_order`, off unless set) is listed in `../../UPSTREAM.md`.

### Credit events that are not a balance change

`credit.expiration_changed` says a row's credits stay but their end date moved (a cancelled plan's rows stop refilling and lapse at the last cycle's end plus the rollover months). It carries the row, `previous_expires_at`, `expires_at` and `refills_ended`, has no postings, and is emitted only when the date changes without a balance change in the same write.

`credit.low` ("N visits left") and `credit.depleted` ("pack used up") say a draw by the family took a holder's available balance of a feature across a line. atm emits them; the family service delivers the mails. Only a `track` (a booking's hold) or a `finalize` makes them: never the rules' own take-backs (a refund or lost-dispute clawback is an `applyBillingPlan`, labelled `credit.adjusted`), an `updateBalance`, `deleteBalance` or `recalculateBalance` by hand, or a reset, so `handleStripeEvent` makes none. `credit.depleted` is a balance that goes from above 0 to 0; `credit.low` is one that goes from above `policy.lowCreditThreshold` (default 2; 0 turns it off) to at most it, and not to 0 (a draw straight from 5 to 0 is only `credit.depleted`). Each is made once per crossing, never while the balance stays below, and never when it does not go down (a grant, a refund, a reset). The balance is the sum over all the feature's live rows and rollovers, so a pack on top of a tier counts, and it is the balance after holds: a booking's hold is the draw, a cancel (`credit.released`) gives the credits back with no event, and booking again crosses, and alerts, again. atm does not remember that it already alerted: the family service dedupes its notices per holder, feature and grant or cycle. The labels have `feature` but no `plan` (the crossing is judged on the feature's total over every plan). The payload is `feature`, `available`, `threshold` (null on `credit.depleted`) and `previous_available`, beside the command and mutation; there are no postings; the idem is `<prefix>:<mutation id>:low:<feature>` or `...:depleted:<feature>`. `mutationToEvents` makes them only when the context has `lowCreditThreshold` (the caller passes the policy's on its `track` and `finalize` events) and the `before` state; a lapse by the clock (`lapseEvent`) does not make them yet.

### Membership status

`incomplete` means the first payment is not finished (Stripe `incomplete`); the other values are `active`, `past_due`, `ended` and `inactive` (`status.ts`).

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

## Recipes

`just` (in `packages/atm`, or `just atm <recipe>` from the repo root) lists them: `test`, `ts`, `lint`, `fix`, `build`, `knip`, `check` (the whole gate before a commit), `golden`, `fixtures`, `schema`, `mappings`, `stripe-spec`, `cli`, `release-dry` and `release`.

## Release

B4 Uni's family service depends on atm by a pinned release URL, not a vendored bundle: `"atm": "https://github.com/justbry/atm/releases/download/atm-v<version>/atm-<version>.tgz"` in its `packages/family-service/package.json`, with the tarball's sha512 in its `bun.lock`. The tarball holds `package/package.json`, `package/dist/index.js`, `package/dist/index.d.ts`, `package/dist/types.d.ts`, `package/LICENSE` and `package/README.md`, and nothing else (the engine is inlined, so no dependencies).

1. Bump `version` in `packages/atm/package.json` (the workspace package stays `"private": true`; it is never published to npm), commit and push.
2. `just release-dry` (`bun run --cwd packages/atm release --dry-run`) builds from that commit, runs the dist checks, packs, and prints the file list, sha256 and the sha512 integrity bun.lock will record. It prints, without stopping, what a real run would refuse on.
3. `just release` (`bun run --cwd packages/atm release`, after a confirmation) does the same and creates the GitHub release `atm-v<version>` at HEAD with the tarball. It refuses unless the working tree is clean, HEAD is on origin, neither the tag nor a release for it exists, and the bun running it is the one the repo pins (`packageManager`), because the bundle and the pack are part of the bytes. The same commit on that bun gives the same tarball.
4. Pushing a tag `atm-v*` runs `.github/workflows/release-atm.yml`, which builds the tag and creates the release if it is missing, or checks that an existing release's asset is exactly this build.
5. In buzz-school, change the URL in `packages/family-service/package.json` and run `bun install`; `bun.lock` gets the new sha512.

Local development: `bun link` here and `bun link atm` in the family service. `bun install` there undoes the link. Never commit while linked.

## Ledger (slices 1-5)

- `atm journal --root <folder> --school <id> --month YYYY-MM`: events under `<folder>/schools/<id>/events/` to `ledger/b4u/YYYY-MM.journal`, `ledger/accounts.journal`, `main.journal`, `ledger/build.json`; a file is rewritten only if its bytes change.
- Library: `mutationToEvents`, `ledgerEvent`, `lapsedRows`/`lapseEvent`, `validateEvent`, `replayEvents`, `buildJournal`.
- `schema/`: `envelope.v1.json`, `payload/<event_type>.v1.json`, `duckdb/envelope.v1.sql` (regenerate with `bun run schema`).
- `fixtures/`: a seeded year of one member (`bun run fixtures -- --seed 1 --out <dir>`); `fixtures/vibes-year` is seed 1.
- The engine reads the process time zone for rollover expiry; ledger runs pin UTC around each engine call.

Next, from the B4 Uni ledger spec: `parity`, `verify`, `plans push`, `inbox check`, `load`. Provenance and changes to upstream: `../../UPSTREAM.md`.
