import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp } from "../src/app/mount.tsx";
import { createFixtureReader } from "../src/fixtures/reader.ts";
import { createFixtureWriter } from "../src/fixtures/writer.ts";

/**
 * The golden runner (protocol §7). Runs every golden file up to the slice under test, so earlier slices are regression
 * tests. Contracts it relies on: `mountApp`, `createFixtureReader({ clock })`, and `createFixtureWriter({ mode })`
 * returning a Writer that also exposes `calls` (every call as `{ method, args }`) and `release()`.
 */
type Step =
	| { click: string; expect?: Expectation }
	| { fill: string; value: string; expect?: Expectation }
	| { key: string; target: string; expect?: Expectation }
	| { release: true; expect?: Expectation };
type Expectation = {
	text?: Record<string, string>;
	contains?: Record<string, string[]>;
	count?: Record<string, number>;
	hash?: string;
	writes?: Array<{ method: string; args: unknown[] }>;
	absent?: string[];
};
type Entry = {
	id: string;
	source: string;
	route: string;
	writer?: "instant" | "hold";
	covers?: Record<string, string>;
	steps?: Step[];
	expect: Expectation;
};
type GoldenFile = {
	slice: string;
	hooks: string[];
	matrix?: Record<string, string[]>;
	entries: Entry[];
};

const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
const globallyAbsent = [
	"NaN",
	"undefined",
	"null",
	"[object Object]",
	"Infinity",
];
const goldenDirectory = join(import.meta.dir, "golden");
const sliceLimit = Number((process.env.LEDGER_SLICE ?? "S99").slice(1));
const files: GoldenFile[] = readdirSync(goldenDirectory)
	.filter(
		(name) =>
			/^S\d+\.json$/.test(name) && Number(name.slice(1, -5)) <= sliceLimit,
	)
	.sort(
		(first, second) => Number(first.slice(1, -5)) - Number(second.slice(1, -5)),
	)
	.map(
		(name) =>
			JSON.parse(
				readFileSync(join(goldenDirectory, name), "utf8"),
			) as GoldenFile,
	);
const allowedHooks = new Set(files.flatMap((file) => file.hooks));

const normalize = (value: string | null | undefined): string =>
	(value ?? "").replace(/\s+/g, " ").trim();
const macrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (root: HTMLElement): Promise<void> => {
	for (
		let attempt = 0;
		attempt < 400 && root.dataset.route !== window.location.hash;
		attempt += 1
	)
		await macrotask();
	await macrotask();
	await macrotask();
};
const required = (selector: string): Element => {
	const element = document.querySelector(selector);
	if (!element) throw new Error(`no element matches ${selector}`);
	return element;
};

const check = (
	root: HTMLElement,
	expectation: Expectation,
	writerCalls: ReadonlyArray<unknown>,
): void => {
	for (const [selector, text] of Object.entries(expectation.text ?? {})) {
		expect({
			selector,
			text: normalize(required(selector).textContent),
		}).toEqual({ selector, text });
	}
	for (const [selector, parts] of Object.entries(expectation.contains ?? {})) {
		const matches = [...document.querySelectorAll(selector)];
		expect({ selector, found: matches.length > 0 }).toEqual({
			selector,
			found: true,
		});
		const text = normalize(
			matches.map((element) => element.textContent).join(" "),
		);
		for (const part of parts)
			expect({ selector, contains: part, ok: text.includes(part) }).toEqual({
				selector,
				contains: part,
				ok: true,
			});
	}
	for (const [selector, count] of Object.entries(expectation.count ?? {})) {
		expect({
			selector,
			count: document.querySelectorAll(selector).length,
		}).toEqual({ selector, count });
	}
	if (expectation.hash !== undefined)
		expect(window.location.hash).toContain(expectation.hash);
	if (expectation.writes) expect(writerCalls).toEqual(expectation.writes);
	const pageText = normalize(root.textContent);
	for (const word of [...globallyAbsent, ...(expectation.absent ?? [])]) {
		expect({ absent: word, present: pageText.includes(word) }).toEqual({
			absent: word,
			present: false,
		});
	}
	const unknownHooks = [...document.querySelectorAll("[data-test]")]
		.map((element) => element.getAttribute("data-test") ?? "")
		.filter((hook) => !allowedHooks.has(hook));
	expect(unknownHooks).toEqual([]);
};

let unmount: (() => void) | null = null;
afterEach(() => {
	unmount?.();
	unmount = null;
	document.body.innerHTML = "";
	window.location.hash = "";
});

for (const file of files) {
	describe(`golden ${file.slice}`, () => {
		test("covers its matrix combination by combination", () => {
			const axes = Object.entries(file.matrix ?? {});
			if (axes.length === 0) return;
			const combinations = axes.reduce<Array<Record<string, string>>>(
				(partial, [axis, values]) =>
					partial.flatMap((combination) =>
						values.map((value) => ({ ...combination, [axis]: value })),
					),
				[{}],
			);
			const missing = combinations.filter(
				(combination) =>
					!file.entries.some((entry) =>
						Object.entries(combination).every(
							([axis, value]) => entry.covers?.[axis] === value,
						),
					),
			);
			expect(missing).toEqual([]);
		});
		for (const entry of file.entries) {
			test(entry.id, async () => {
				window.location.hash = entry.route;
				const root = document.createElement("div");
				root.id = "app";
				document.body.appendChild(root);
				const writer = createFixtureWriter({ mode: entry.writer ?? "instant" });
				unmount = mountApp(root, {
					reader: createFixtureReader({ clock }),
					writer,
					clock,
				}).unmount;
				await settle(root);
				for (const step of entry.steps ?? []) {
					if ("click" in step) (required(step.click) as HTMLElement).click();
					else if ("fill" in step) {
						const input = required(step.fill) as HTMLInputElement;
						input.value = step.value;
						input.dispatchEvent(new Event("input", { bubbles: true }));
					} else if ("key" in step) {
						required(step.target).dispatchEvent(
							new KeyboardEvent("keydown", { key: step.key, bubbles: true }),
						);
					} else writer.release();
					await settle(root);
					if (step.expect) check(root, step.expect, writer.calls);
				}
				check(root, entry.expect, writer.calls);
			});
		}
	});
}
