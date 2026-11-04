# atm

Autumn's balance engine (`@autumn/balance-engine`) as a local CLI. It runs engine commands against a subject you give it and prints what the engine decides; it writes nothing.

```bash
bun install                      # at the repository root
bun run --cwd packages/atm atm run --subject subject.json --command check.json
```

- `--subject`: a `WorkerFullSubject` (customer, entity, products, entitlements, pools, usage windows, open locks).
- `--command`: an engine command with its `type`. Validated by the engine's own parser.
- Either may be `-` to read stdin.

Commands it runs now: `check`, `finalize`, `confirmExpiredLock`, `reset`, `recalculateBalance`.

Next, from the B4 Uni ledger spec: `load` (R2 JSONL → `school.duckdb`), `journal` (→ hledger), `parity`, `replay`, `plans push`, `books check`. Provenance and changes to upstream: `../../UPSTREAM.md`.
