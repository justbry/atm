/**
 * Builds the CLI (dist/atm.js) and the library (dist/index.js + index.d.ts + types.d.ts), each one file with the
 * engine bundled in. The declarations must import nothing but ./types.js, so a consumer needs no engine, zod or
 * @autumn/shared types. Usage: bun build.ts [outDir]
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = import.meta.dir;
const outDir = resolve(process.argv[2] ?? join(here, "dist"));

const bundle = async (entry: string, target: "bun" | "node", name: string) => {
	const result = await Bun.build({
		entrypoints: [join(here, entry)],
		target,
		format: "esm",
		naming: name,
		outdir: outDir,
	});
	if (!result.success)
		throw new AggregateError(result.logs, `bundling ${entry} failed`);
};

await bundle("src/bin.ts", "bun", "atm.js");
await bundle("src/index.ts", "node", "index.js");

const declarations = await mkdtemp(join(tmpdir(), "atm-dts-"));
const tsc = Bun.spawnSync(
	[
		process.execPath,
		require.resolve("typescript/bin/tsc"),
		"-p",
		join(here, "tsconfig.json"),
		"--noEmit",
		"false",
		"--declaration",
		"--emitDeclarationOnly",
		"--outDir",
		declarations,
	],
	{ stdout: "inherit", stderr: "inherit" },
);
if (tsc.exitCode !== 0) throw new Error("declaration emit failed");

for (const file of ["index.d.ts", "types.d.ts"]) {
	const text = await readFile(join(declarations, "atm/src", file), "utf8");
	const imports = [
		...text.matchAll(/from\s+"([^"]+)"|import\("([^"]+)"\)/g),
	].map((m) => m[1] ?? m[2]);
	const foreign = imports.filter((spec) => spec !== "./types.js");
	if (foreign.length > 0) {
		throw new Error(
			`${file} imports ${foreign.join(", ")}: the public types must stand alone`,
		);
	}
	await writeFile(join(outDir, file), text);
}
await rm(declarations, { recursive: true, force: true });

console.log(`built ${outDir}: atm.js, index.js, index.d.ts, types.d.ts`);
