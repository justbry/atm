import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const stylesheet = readFileSync(
	join(import.meta.dir, "../../src/theme.css"),
	"utf8",
);
const collapse = (css: string): string => css.replace(/\s+/g, " ");

/** The body of every `@media (max-width: 600px)` block, braces balanced. */
const phoneRules = (): string[] => {
	const blocks: string[] = [];
	const opener = "@media (max-width: 600px) {";
	for (
		let start = stylesheet.indexOf(opener);
		start !== -1;
		start = stylesheet.indexOf(opener, start + 1)
	) {
		let depth = 1;
		let index = start + opener.length;
		while (depth > 0 && index < stylesheet.length) {
			if (stylesheet[index] === "{") depth += 1;
			if (stylesheet[index] === "}") depth -= 1;
			index += 1;
		}
		blocks.push(collapse(stylesheet.slice(start + opener.length, index - 1)));
	}
	return blocks;
};

test("at phone widths a right-aligned popover is pinned inside the viewport", () => {
	const phone = phoneRules().join(" ");
	expect(phone).toContain(".pw:has(> .pop.r) { position: static; }");
	expect(phone).toContain(
		".pop.r { top: auto; left: 12px; right: 12px; min-width: 0; max-width: calc(100vw - 24px);",
	);
});

test("wider widths keep the right-aligned popover hanging from its trigger", () => {
	expect(collapse(stylesheet)).toContain(".pop.r { left: auto; right: 0; }");
	expect(collapse(stylesheet)).toContain(".pw { position: relative; }");
});
