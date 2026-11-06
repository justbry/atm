import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Gate H (protocol §6): Worker-safe, no logging, no storage, no clock reads, and the §3 import rule. */
const packageRoot = join(import.meta.dir, "..");
const sourceRoot = join(packageRoot, "src");

const forbiddenInSource: ReadonlyArray<readonly [string, RegExp]> = [
	["ajv", /\bajv\b/],
	["node: import", /["']node:/],
	["new Function", /new\s+Function\s*\(/],
	["eval(", /\beval\s*\(/],
	["console.", /\bconsole\./],
	["debugger", /\bdebugger\b/],
	["innerHTML", /\binnerHTML\b/],
	["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
	["localStorage", /\blocalStorage\b/],
	["sessionStorage", /\bsessionStorage\b/],
	["indexedDB", /\bindexedDB\b/],
	["zod", /["']zod["']/],
	["Date.now(", /Date\.now\s*\(/],
	["new Date()", /new\s+Date\s*\(\s*\)/],
];
const forbiddenInBuild: ReadonlyArray<readonly [string, RegExp]> = [
	["new Function", /new\s+Function\s*\(/],
	["eval(", /\beval\s*\(/],
	["node: import", /["']node:/],
	["ajv", /\bajv\b/],
	["zod", /["']zod["']/],
];
const importPattern =
	/(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
const allowedPackages = new Set([
	"preact",
	"preact/hooks",
	"preact/jsx-runtime",
]);

const filesUnder = (directory: string): string[] => {
	if (!existsSync(directory)) return [];
	const files: string[] = [];
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) files.push(...filesUnder(path));
		else files.push(path);
	}
	return files;
};

const sourceFiles = filesUnder(sourceRoot).filter((file) =>
	/\.(ts|tsx|js|mjs|css)$/.test(file),
);

describe("gate H: source", () => {
	test("the app has source files", () => {
		expect(sourceFiles.length).toBeGreaterThan(0);
	});
	for (const file of sourceFiles) {
		const name = relative(packageRoot, file);
		const text = readFileSync(file, "utf8");
		test(`${name} has no forbidden construct`, () => {
			const found = forbiddenInSource
				.filter(([, pattern]) => pattern.test(text))
				.map(([label]) => label);
			expect(found).toEqual([]);
		});
		if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
		test(`${name} follows the import rule`, () => {
			const problems: string[] = [];
			const inFixtures = relative(sourceRoot, file).startsWith("fixtures/");
			const isMain = relative(sourceRoot, file) === "main.tsx";
			for (const match of text.matchAll(importPattern)) {
				const specifier = match[1] ?? match[2] ?? match[3] ?? "";
				if (!specifier.startsWith(".")) {
					if (!allowedPackages.has(specifier))
						problems.push(`package ${specifier}`);
					continue;
				}
				const target = relative(sourceRoot, join(file, "..", specifier));
				if (target.startsWith("..")) problems.push(`outside src: ${specifier}`);
				else if (
					inFixtures &&
					!target.startsWith("fixtures/") &&
					!target.startsWith("data/")
				)
					problems.push(
						`fixtures may import only data and fixtures: ${specifier}`,
					);
				else if (!inFixtures && !isMain && target.startsWith("fixtures/"))
					problems.push(`only src/main.tsx may import fixtures: ${specifier}`);
			}
			expect(problems).toEqual([]);
		});
	}
});

describe("gate H: build", () => {
	const buildFiles = filesUnder(join(packageRoot, "dist-size")).filter((file) =>
		/\.(js|css)$/.test(file),
	);
	test.if(buildFiles.length > 0)(
		"the size build has no Worker-unsafe construct",
		() => {
			const found = buildFiles.flatMap((file) => {
				const text = readFileSync(file, "utf8");
				return forbiddenInBuild
					.filter(([, pattern]) => pattern.test(text))
					.map(([label]) => `${relative(packageRoot, file)}: ${label}`);
			});
			expect(found).toEqual([]);
		},
	);
});
