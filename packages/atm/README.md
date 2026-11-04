# atm

Autumn's balance engine (`@autumn/balance-engine`) as a local CLI and a TypeScript library. It runs one engine command against a subject and returns what the engine decides; it reads and writes nothing else.

Commands it runs: `check`, `finalize`, `confirmExpiredLock`, `reset`, `recalculateBalance`.

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

- The result type follows `command.type`: `AtmCheckResult` for `check`, `AtmMutation` (row changes guarded by `revision.before`) for `finalize` and `confirmExpiredLock`, `AtmMutation | null` for `reset`.
- Inside this workspace, Bun imports the source (`exports` condition `bun`); anywhere else, the built files.

## Build

```bash
bun run --cwd packages/atm build   # or: bun build.ts <outDir>
```

| File | What |
|---|---|
| `dist/atm.js` | the CLI, one file, engine bundled (about 2 MB) |
| `dist/index.js` | the library, one ESM file, engine bundled; runs under Bun and Node with no `node_modules` |
| `dist/index.d.ts`, `dist/types.d.ts` | the library's types; they import nothing else (the build fails if they would) |

The public types (`src/types.ts`) are atm's own JSON shapes, not the engine's zod types, so a consumer needs no engine, zod or `@autumn/shared` types. `tests/types.test.ts` stops compiling if the engine's types stop fitting them; `tests/dist.test.ts` builds into an empty directory and typechecks and runs the result there.

Next, from the B4 Uni ledger spec: `journal`, `parity`, `replay`, `verify`, `plans push`, `inbox check`, `load`. Provenance and changes to upstream: `../../UPSTREAM.md`.
