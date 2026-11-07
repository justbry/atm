/**
 * The gate runner (protocol §6). The orchestrator runs gate P itself in its worktree before this script, so this file
 * is the orchestrator's own. Usage, from packages/ledger-ui:
 *   bun gates/run.ts --slice S<k> --changed <file of repo-relative paths> --head <sha>
 * Runs I, Y, B, S, T (builder tests, then the orchestrator suites, then every test group as `bun run test` runs it),
 * then R (parity with smoke.mjs), and stops at the first red gate.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const argument = (name: string): string => {
	const index = process.argv.indexOf(name);
	const value = index > 0 ? process.argv[index + 1] : undefined;
	if (!value) throw new Error(`missing ${name}`);
	return value;
};
const slice = argument("--slice");
const changedFile = argument("--changed");
const head = argument("--head");
const sliceNumber = Number(slice.slice(1));
const packageRoot = join(import.meta.dir, "..");
const repositoryRoot = join(packageRoot, "..", "..");

type Budget = {
	S0Ceiling: number;
	growth: number;
	sizes: Record<string, number>;
};

const run = (
	gate: string,
	command: string,
	args: string[],
	options: { cwd?: string; env?: Record<string, string> } = {},
): void => {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? packageRoot,
		env: { ...process.env, ...options.env },
		encoding: "utf8",
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (result.status !== 0) {
		process.stdout.write(
			`${gate} red: ${command} ${args.join(" ")}\n${output}\n`,
		);
		process.exit(1);
	}
	const tail = output.split("\n").slice(-3).join(" | ");
	process.stdout.write(`${gate} green${tail ? `: ${tail}` : ""}\n`);
};

const filesUnder = (directory: string): string[] =>
	existsSync(directory)
		? readdirSync(directory).flatMap((name) => {
				const path = join(directory, name);
				return statSync(path).isDirectory() ? filesUnder(path) : [path];
			})
		: [];

process.stdout.write(`slice ${slice} head ${head}\n`);
run("I install", "bun", ["install", "--frozen-lockfile"]);
if (existsSync(join(packageRoot, "scripts/import-mart.ts")))
	run("F fixtures", "bun", ["scripts/import-mart.ts"]);
run("Y types", "bunx", ["tsc", "--noEmit", "-p", "gates/tsconfig.gates.json"]);

const lintable = readFileSync(changedFile, "utf8")
	.split("\n")
	.map((line) => line.trim())
	.filter(
		(path) =>
			path.startsWith("packages/ledger-ui/") &&
			/\.(ts|tsx|js|mjs|json|css)$/.test(path),
	)
	.filter((path) => !path.startsWith("packages/ledger-ui/src/fixtures/mart/"))
	.filter(
		(path) => !/^packages\/ledger-ui\/test\/golden\/[^/]+\.json$/.test(path),
	)
	.filter((path) => path !== "packages/ledger-ui/bun.lock")
	.filter((path) => existsSync(join(repositoryRoot, path)));
const biome = join(packageRoot, "node_modules/.bin/biome");
const pinned = JSON.parse(
	readFileSync(join(repositoryRoot, "package.json"), "utf8"),
).devDependencies["@biomejs/biome"];
const version = spawnSync(biome, ["--version"], {
	encoding: "utf8",
}).stdout.trim();
if (!version.endsWith(pinned)) {
	process.stdout.write(
		`B red: biome ${version} is not the root pin ${pinned}\n`,
	);
	process.exit(1);
}
if (lintable.length)
	run("B biome", biome, ["check", "--no-errors-on-unmatched", ...lintable], {
		cwd: repositoryRoot,
	});
else process.stdout.write("B green: no lintable changed files\n");

run("S build", "bun", ["run", "build:size"]);
/** First-load size (owner default, 2026-11-06): the entry chunk, its static imports and their CSS; panes loaded on demand are not counted. */
type ManifestChunk = {
	file: string;
	css?: string[];
	imports?: string[];
	isEntry?: boolean;
};
const manifest = JSON.parse(
	readFileSync(join(packageRoot, "dist-size/.vite/manifest.json"), "utf8"),
) as Record<string, ManifestChunk>;
const firstLoad = new Set<string>();
const visit = (key: string): void => {
	const chunk = manifest[key];
	if (!chunk || firstLoad.has(chunk.file)) return;
	firstLoad.add(chunk.file);
	for (const css of chunk.css ?? []) firstLoad.add(css);
	for (const imported of chunk.imports ?? []) visit(imported);
};
for (const [key, chunk] of Object.entries(manifest))
	if (chunk.isEntry) visit(key);
const bytes = [...firstLoad].reduce(
	(total, file) =>
		total +
		gzipSync(readFileSync(join(packageRoot, "dist-size", file)), { level: 9 })
			.length,
	0,
);
const budget = JSON.parse(
	readFileSync(join(import.meta.dir, "budget.json"), "utf8"),
) as Budget;
/** The last recorded slice before this one, and how many slices lie between (each may grow by `growth`). */
const recorded = Array.from(
	{ length: sliceNumber },
	(_, index) => sliceNumber - 1 - index,
).find((number) => budget.sizes[`S${number}`] !== undefined);
const previous =
	recorded === undefined ? undefined : budget.sizes[`S${recorded}`];
const limit =
	sliceNumber === 0
		? budget.S0Ceiling
		: previous === undefined || recorded === undefined
			? Number.NaN
			: Math.floor(previous * budget.growth ** (sliceNumber - recorded));
if (!(bytes <= limit)) {
	process.stdout.write(`S red: ${bytes} gzip bytes, limit ${limit}\n`);
	process.exit(1);
}
process.stdout.write(`S green: ${bytes} gzip bytes, limit ${limit}\n`);

const builderTests = join(packageRoot, "test", slice.toLowerCase());
if (!existsSync(builderTests)) {
	process.stdout.write(
		`T red: no builder tests in test/${slice.toLowerCase()}\n`,
	);
	process.exit(1);
}
run("T builder", "bun", ["test", `test/${slice.toLowerCase()}`]);
run(
	"T orchestrator",
	"bun",
	[
		"test",
		"test/golden.test.ts",
		"test/consistency.test.ts",
		"test/hygiene.test.ts",
	],
	{
		env: { LEDGER_SLICE: slice, LEDGER_HEAD: head },
	},
);
/** The package's own `bun run test`, every test group in its own process, as a person runs it (scripts/test-all.ts). */
run("T all", "bun", ["scripts/test-all.ts"]);
/** Gate R (protocol v9 addendum §3): smoke.mjs run against the UI; every check owned by a slice up to this one passes
 * or is na with a reason. Prints the per-slice coverage either way. */
const parity = spawnSync("bun", ["test/parity/run.ts", "--slice", slice], {
	cwd: packageRoot,
	encoding: "utf8",
});
process.stdout.write(`${parity.stdout ?? ""}${parity.stderr ?? ""}`);
if (parity.status !== 0) process.exit(1);
process.stdout.write(`all gates green; size ${bytes}\n`);
