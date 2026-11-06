/**
 * Writes the hand-authored gap bundles (`tests/gap/*.ts`, each exporting `CASES: Case[]`) into `fixtures/scenarios`.
 * Run: `bun tests/author-gap-bundles.ts [case-id ...]` (no ids: every case). Then freeze the hashes of what you wrote:
 * `bun src/bin.ts scenario check <id> --update`.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { writeCaseBundle } from "./author-bundles.js";
import type { Case } from "./e2e-matrix.js";

const wanted = new Set(process.argv.slice(2));
const directory = join(import.meta.dir, "gap");
for (const name of (await readdir(directory))
	.filter((n) => n.endsWith(".ts"))
	.sort()) {
	const { CASES } = (await import(join(directory, name))) as { CASES: Case[] };
	for (const c of CASES) {
		if (wanted.size > 0 && !wanted.has(c.id)) continue;
		console.log(`wrote ${await writeCaseBundle(c)}`);
	}
}
