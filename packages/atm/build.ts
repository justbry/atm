/**
 * Builds the CLI (dist/atm.js), the library (dist/index.js + index.d.ts + types.d.ts) and the Worker entry (dist/worker.js
 * + worker.d.ts, the `atm/worker` subpath), each one file with the engine bundled in. The declarations must import
 * nothing but ./types.js, so a consumer needs no engine, zod or @autumn/shared types. `worker.d.ts` is the declarations
 * of the modules `src/worker.ts` re-exports, inlined into one file (they import only `../types.js` and each other).
 * Usage: bun build.ts [outDir]
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
await bundle("src/worker.ts", "node", "worker.js");

const LOCAL_IMPORT =
	/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";?\n/gm;
const LOCAL_REEXPORT = /^export\s+\*\s+from\s+"([^"]+)";?\n/gm;

/** One declaration file from an entry's `.d.ts` and the local ones it imports or re-exports, in dependency order. */
const inlineDeclarations = async (root: string, entry: string) => {
	const typesFile = join(root, "types.d.ts");
	const seen = new Set<string>();
	const bodies: string[] = [];
	const typeNames = new Set<string>();
	const visit = async (file: string): Promise<void> => {
		if (seen.has(file)) return;
		seen.add(file);
		let text = await readFile(file, "utf8");
		const followed: string[] = [];
		const follow = (names: string | null, specifier: string) => {
			const target = resolve(
				dirname(file),
				specifier.replace(/\.js$/, ".d.ts"),
			);
			if (target !== typesFile) {
				followed.push(target);
				return;
			}
			for (const name of (names ?? "").split(",")) {
				const bare = name.trim().replace(/^type\s+/, "");
				if (bare) typeNames.add(bare);
			}
		};
		text = text
			.replace(LOCAL_IMPORT, (_all, names, specifier) => {
				if (specifier.startsWith(".")) follow(names, specifier);
				return specifier.startsWith(".") ? "" : _all;
			})
			.replace(LOCAL_REEXPORT, (_all, specifier) => {
				follow(null, specifier);
				return "";
			});
		for (const target of followed) await visit(target);
		bodies.push(text.trim());
	};
	await visit(entry);
	const header = `import type { ${[...typeNames].sort().join(", ")} } from "./types.js";`;
	return `${header}\n\n${bodies.filter(Boolean).join("\n\n")}\n`;
};

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

const declarationRoot = join(declarations, "atm/src");
for (const file of ["index.d.ts", "types.d.ts", "worker.d.ts"]) {
	const text =
		file === "worker.d.ts"
			? await inlineDeclarations(declarationRoot, join(declarationRoot, file))
			: await readFile(join(declarationRoot, file), "utf8");
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

console.log(
	`built ${outDir}: atm.js, index.js, index.d.ts, types.d.ts, worker.js, worker.d.ts`,
);
