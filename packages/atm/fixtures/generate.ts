#!/usr/bin/env bun
/**
 * Usage: bun fixtures/generate.ts [--seed 1] [--out fixtures/vibes-year] [--multi-out fixtures/vibes-multi] [--only year|multi]
 * Writes both golden fixtures by default: the one family's year (`vibes-year`) and the twelve families' four months
 * (`vibes-multi`). `--seed` is for both; `--only` writes one. `--out` without `--multi-out` or `--only` writes the year only,
 * as it always did (a caller that names a directory for the year must not find a second fixture written beside the repo's).
 */
import { resolve } from "node:path";
import { writeFixture } from "./write.js";
import { writeMultiFixture } from "./write-multi.js";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const seed = Number(arg("seed", "1"));
// `--out` alone is the old call, which wrote the year and nothing else: it still does
const only = arg(
	"only",
	args.includes("--out") && !args.includes("--multi-out") ? "year" : "all",
);
if (!["all", "year", "multi"].includes(only))
	throw new Error(`--only is year or multi, got ${only}`);
if (only !== "multi") {
	const out = resolve(arg("out", `${import.meta.dir}/vibes-year`));
	const written = await writeFixture({ seed, outDir: out });
	console.log(`seed ${seed}: ${written.length} files under ${out}`);
}
if (only !== "year") {
	const out = resolve(arg("multi-out", `${import.meta.dir}/vibes-multi`));
	const written = await writeMultiFixture({ seed, outDir: out });
	console.log(`seed ${seed}: ${written.length} files under ${out}`);
}
