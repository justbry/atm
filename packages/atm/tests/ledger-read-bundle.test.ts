/**
 * The whole Worker bundle, not just atm's own import graph (`ledger-read-hygiene.test.ts` stops at the first package
 * import): `src/worker.ts` is bundled with esbuild the way Wrangler would, so `@autumn/balance-engine`, `@autumn/shared`
 * and everything they pull in are in the output. The bundle must hold none of what a Worker cannot run, and every
 * `node:*` built-in left in it is named here, because each one is a `nodejs_compat` requirement.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { bundleWorker, type WorkerBundle } from "./worker-fixture/bundle.js";

/** Node built-ins that no Worker provides (or provides only for a disk or a child process). */
const FORBIDDEN_BUILTINS = [
	"node:fs",
	"node:fs/promises",
	"node:path",
	"node:child_process",
	"node:os",
	"node:net",
	"node:http",
	"node:https",
];
const FORBIDDEN_PACKAGES = [
	"ajv",
	"duckdb",
	"@duckdb/node-api",
	"@duckdb/node-bindings",
];
/** `node:crypto` (ids, util, the store's sha256, shared's chatState) and `node:util` (the engine) need `nodejs_compat`. */
const EXPECTED_BUILTINS = ["node:crypto", "node:util"];
/** A direct `eval(` call or `new Function(`: a Worker refuses both, so a bundle that runs one fails at run time. */
const DYNAMIC_CODE = /(?:^|[^\w$.])eval\s*\(|new\s+Function\s*\(/g;

describe("the atm/worker bundle", () => {
	let bundle: WorkerBundle;
	beforeAll(async () => {
		bundle = await bundleWorker("src/worker.ts");
	}, 60_000);

	test("bundles whole: the engine and the shared package are inside", () => {
		expect(bundle.packages).toContain("zod");
		const inputs = Object.keys(bundle.metafile.inputs);
		expect(inputs.some((input) => input.includes("balance-engine"))).toBe(true);
		expect(inputs.some((input) => input.startsWith("../../shared/"))).toBe(
			true,
		);
	});

	test("holds no Ajv, DuckDB, file system, path or child process", () => {
		const inputs = Object.keys(bundle.metafile.inputs);
		expect(
			bundle.packages.filter((name) => FORBIDDEN_PACKAGES.includes(name)),
		).toEqual([]);
		expect(
			inputs.filter((input) => /\/node_modules\/ajv\//.test(input)),
		).toEqual([]);
		expect(
			bundle.nodeBuiltins.filter((name) => FORBIDDEN_BUILTINS.includes(name)),
		).toEqual([]);
		expect(inputs.filter((input) => input === "src/ledger/duckdb.ts")).toEqual(
			[],
		);
	});

	test("runs no eval and no `new Function`", () => {
		expect([...bundle.text.matchAll(DYNAMIC_CODE)].map((m) => m[0])).toEqual(
			[],
		);
	});

	test("the Node built-ins left are exactly the `nodejs_compat` requirement", () => {
		const processEnv = [
			...new Set(bundle.text.match(/process\.env(?:\.\w+)?/g) ?? []),
		].sort();
		console.info(
			`node:* built-ins left in the atm/worker bundle (need nodejs_compat): ${bundle.nodeBuiltins.join(", ")}\n` +
				`process.env reads: ${processEnv.join(", ")}\n` +
				`bundle: ${bundle.text.length} bytes from ${Object.keys(bundle.metafile.inputs).length} inputs`,
		);
		expect(bundle.nodeBuiltins).toEqual(EXPECTED_BUILTINS);
	});
});
