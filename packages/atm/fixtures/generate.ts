#!/usr/bin/env bun
/** Usage: bun fixtures/generate.ts [--seed 1] [--out fixtures/vibes-year] */
import { resolve } from "node:path";
import { writeFixture } from "./write.js";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const seed = Number(arg("seed", "1"));
const out = resolve(arg("out", `${import.meta.dir}/vibes-year`));
const written = await writeFixture({ seed, outDir: out });
console.log(`seed ${seed}: ${written.length} files under ${out}`);
