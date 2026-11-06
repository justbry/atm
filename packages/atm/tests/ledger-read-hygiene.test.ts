/**
 * The Worker read path (`read.ts`, `summary.ts`, `views.ts`) must not reach what a Cloudflare Worker cannot run: the
 * file system, child processes, DuckDB, and Ajv (which compiles schemas with `new Function`). This walks the static
 * import graph from each entry and fails on a forbidden module.
 *
 * Known, narrow exception: `summary.ts` and `views.ts` build on `replay.ts`, whose graph imports `billing/menu.ts`
 * (through `billing/grants.ts`, for the pure `commodityProblems`), and `menu.ts` imports Ajv at the top for `validateMenu`.
 * The import is never run on the read path (the schema compiles inside `validateMenu` only, which no module of the graph
 * calls): the last test proves it by watching `Ajv2020.prototype.compile`. The allowance below is exactly that edge, and
 * the test after it fails once the edge is gone, so the exception cannot outlive its cause.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readEvents } from "../src/ledger/files.js";
import { membersOf } from "../src/ledger/summary.js";
import { buildViews } from "../src/ledger/views.js";
import type { AtmCatalogRow } from "../src/types.js";

const PACKAGE = resolve(import.meta.dir, "..");
const ENTRIES = [
	"src/ledger/read.ts",
	"src/ledger/summary.ts",
	"src/ledger/views.ts",
];

const FORBIDDEN = [
	/^ajv(\/|$)/,
	/^(node:)?fs(\/|$)/,
	/^(node:)?path(\/|$)/,
	/^(node:)?child_process$/,
	/^duckdb/,
	/^@duckdb\//,
	/^bun:/,
];
const NODE_CRYPTO = "node:crypto";
/**
 * The files of THIS package that import `node:crypto`, reached from the entries: `ids.ts` and `util.ts` hash, `store.ts`
 * hashes object bytes. A new importer in the walk fails the test below until it is added here on purpose.
 *
 * What this walk does not see: it follows relative imports inside `packages/atm` only. A bare specifier is recorded and
 * not entered, so the workspace packages behind `@autumn/balance-engine` (and through it `@autumn/shared`) are not
 * checked. They are not clean: an independent review found `shared/utils/chatState.ts` importing `node:crypto` and a
 * module-level `process.env.NODE_ENV` read in `checkoutToUrl.ts`, both reached through `@autumn/shared`. Walking the
 * bundle, not the sources, is the follow-up's job (whole-bundle hygiene).
 */
const CRYPTO_IMPORTERS_IN_PACKAGE = [
	"src/ledger/ids.ts",
	"src/ledger/util.ts",
	"src/store/store.ts",
];
/** The one allowed edge to a forbidden module: Ajv, imported by `billing/menu.ts` and never run by the read path. */
const KNOWN_EDGES = [
	{ module: "ajv/dist/2020.js", from: "src/billing/menu.ts" },
];

// `import type` and `export type` are erased; the rest of `import`/`export ... from`, bare `import "x"` and `import("x")` load.
const SPECIFIER =
	/(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|[^\w.]import\(\s*["']([^"']+)["']\s*\)/g;

type Reach = {
	files: Set<string>;
	external: { module: string; from: string }[];
};

const reachFrom = (entry: string): Reach => {
	const files = new Set<string>();
	const external: Reach["external"] = [];
	const visit = (file: string): void => {
		const name = relative(PACKAGE, file);
		if (files.has(name)) return;
		files.add(name);
		if (!file.endsWith(".ts")) return;
		for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
			const specifier = match[1] ?? match[2] ?? match[3];
			if (specifier === undefined) continue;
			if (!specifier.startsWith(".")) {
				external.push({ module: specifier, from: name });
				continue;
			}
			const base = resolve(dirname(file), specifier);
			const asSource = base.replace(/\.js$/, ".ts");
			visit(existsSync(asSource) ? asSource : base);
		}
	};
	visit(resolve(PACKAGE, entry));
	return { files, external };
};

const unlistedCryptoImporters = (importers: readonly string[]) =>
	importers.filter((file) => !CRYPTO_IMPORTERS_IN_PACKAGE.includes(file));

const forbidden = (reach: Reach) =>
	reach.external.filter((e) =>
		FORBIDDEN.some((pattern) => pattern.test(e.module)),
	);
const isKnown = (e: { module: string; from: string }) =>
	KNOWN_EDGES.some((k) => k.module === e.module && k.from === e.from);

describe("the Worker read path's import graph", () => {
	for (const entry of ENTRIES) {
		test(`${entry} reaches no file system, child process, DuckDB or Ajv (but the known edge)`, () => {
			const reach = reachFrom(entry);
			expect(reach.files.size).toBeGreaterThan(0);
			expect(forbidden(reach).filter((e) => !isKnown(e))).toEqual([]);
		});
	}

	test("read.ts imports nothing at run time but order.ts, which imports nothing", () => {
		const reach = reachFrom("src/ledger/read.ts");
		expect([...reach.files]).toEqual([
			"src/ledger/read.ts",
			"src/ledger/order.ts",
		]);
		expect(reach.external).toEqual([]);
	});

	test("within this package, node:crypto is imported by exactly the listed files (a Worker needs `nodejs_compat` for them)", () => {
		const importers = new Set<string>();
		for (const entry of ENTRIES)
			for (const e of reachFrom(entry).external)
				if (e.module === NODE_CRYPTO) importers.add(e.from);
		expect(unlistedCryptoImporters([...importers])).toEqual([]);
		expect([...importers].sort()).toEqual(CRYPTO_IMPORTERS_IN_PACKAGE);
	});

	test("(control) an importer that is not on the list is reported", () => {
		expect(
			unlistedCryptoImporters([...CRYPTO_IMPORTERS_IN_PACKAGE, "src/x.ts"]),
		).toEqual(["src/x.ts"]);
	});

	test("the known Ajv edge is still the only reason summary.ts and views.ts reach Ajv: remove the exception when this fails", () => {
		for (const entry of ["src/ledger/summary.ts", "src/ledger/views.ts"]) {
			const edges = forbidden(reachFrom(entry));
			expect(edges).toEqual(
				KNOWN_EDGES.map((k) => ({ module: k.module, from: k.from })),
			);
		}
	});
});

describe("running the read path", () => {
	afterEach(() => {
		compile?.mockRestore();
	});
	let compile: ReturnType<typeof spyOn> | undefined;

	test("(control) the spy sees a compile", () => {
		compile = spyOn(Ajv2020.prototype, "compile");
		new Ajv2020().compile({ type: "object" });
		expect(compile).toHaveBeenCalledTimes(1);
	});

	test("never compiles a schema, so Ajv's `new Function` is never reached", async () => {
		compile = spyOn(Ajv2020.prototype, "compile");
		const root = resolve(PACKAGE, "fixtures/vibes-multi");
		const events = (await readEvents(root, "sch_multi")).events;
		const catalog = JSON.parse(
			readFileSync(resolve(root, "catalog.json"), "utf8"),
		) as AtmCatalogRow[];
		const asOf = new Date("2027-03-01T00:00:00Z");
		expect(membersOf(events, asOf, { catalog }).ok).toBe(true);
		expect(buildViews(events, { school: "sch_multi", asOf, catalog }).ok).toBe(
			true,
		);
		expect(compile).not.toHaveBeenCalled();
	});
});
