// SPDX-License-Identifier: Apache-2.0
/**
 * Portability and licensing guard for tfd-notes (R-17, AC-11). The library must run unchanged in Bun, Node, Workers and
 * browsers, must stay Apache-2.0 throughout, and must be recomputable by anyone without FSL code. This test reads the
 * source files as text; it is the only place in the package that may use `node:`.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src");
const LICENSE_LINE = "// SPDX-License-Identifier: Apache-2.0";

const sourceFiles = readdirSync(SRC_DIR, {
	recursive: true,
	withFileTypes: false,
})
	.map(String)
	.filter((name) => name.endsWith(".ts"))
	.sort()
	.map((name) => ({ name, text: readFileSync(join(SRC_DIR, name), "utf8") }));

/** Lines that hold code: prose in comments may name a banned thing (for example to say it is banned). */
function codeOf(text: string): string {
	return text
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
		.join("\n");
}

/** Each ban has its reason (R-17): the library must run in every runtime and give every runtime the same figures. */
const BANNED: { label: string; pattern: RegExp; reason: string }[] = [
	{
		label: "node: import",
		pattern: /from\s+["']node:/,
		reason: "node:* does not exist in browsers or Workers",
	},
	{
		label: "require(",
		pattern: /\brequire\(/,
		reason:
			"CommonJS loading is Node-only and hides imports from the checks below",
	},
	{
		label: "Buffer",
		pattern: /\bBuffer\b/,
		reason: "Buffer is a Node global; browsers and Workers lack it",
	},
	{
		label: "eval(",
		pattern: /\beval\(/,
		reason:
			"dynamic code is blocked in Workers and browsers with a strict CSP, and cannot be audited",
	},
	{
		label: "new Function",
		pattern: /new\s+Function\b/,
		reason: "same as eval: dynamic code is blocked and cannot be audited",
	},
	{
		label: "parseFloat(",
		pattern: /parseFloat\(/,
		reason:
			"money and rates are exact integers and rationals (R-2, R-3); a float path rounds differently across inputs",
	},
	{
		label: "Number(",
		pattern: /\bNumber\(/,
		reason:
			"Number is a float: it loses digits past 2^53 and would let a float into a money or rate path (R-3)",
	},
	{
		label: "toFixed(",
		pattern: /toFixed\(/,
		reason: "toFixed rounds a float, not half up on an exact value (R-5)",
	},
];

/** The FSL package, Autumn code and anything reached by a path through `atm` is off limits: this package is Apache-2.0. */
const FORBIDDEN_IMPORT =
	/(^|\/)packages\/atm(\/|$)|^@autumn\/|^tfd($|\/)|(^|\/)atm(\/|$)/;
const IMPORT_SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

test("src files import no Node module and use no float or dynamic-code path", () => {
	const failures: string[] = [];
	for (const { name, text } of sourceFiles) {
		const code = codeOf(text);
		for (const { label, pattern, reason } of BANNED) {
			if (pattern.test(code)) {
				failures.push(`${name}: ${label} (${reason})`);
			}
		}
	}
	expect(failures).toEqual([]);
});

test("every src file starts with the Apache-2.0 SPDX line", () => {
	// The license line is what REUSE.toml and AGENTS.md promise; a file without it has no stated license.
	const missing = sourceFiles
		.filter(({ text }) => text.split("\n", 1)[0] !== LICENSE_LINE)
		.map(({ name }) => name);
	expect(missing).toEqual([]);
});

test("src files import nothing from packages/atm, Autumn or the FSL tfd package", () => {
	// FSL code may use this package, never the other way round, so the calculator stays free for anyone to recompute with.
	const failures: string[] = [];
	for (const { name, text } of sourceFiles) {
		for (const match of text.matchAll(IMPORT_SPECIFIER)) {
			const specifier = match[1] ?? "";
			if (FORBIDDEN_IMPORT.test(specifier)) {
				failures.push(`${name}: imports ${specifier}`);
			}
		}
	}
	expect(failures).toEqual([]);
});
