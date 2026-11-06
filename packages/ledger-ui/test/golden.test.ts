import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp } from "../src/app/mount.tsx";
import type { Reader } from "../src/data/reader.ts";
import { createFixtureReader } from "../src/fixtures/reader.ts";
import { createFixtureWriter } from "../src/fixtures/writer.ts";

/**
 * The golden runner (protocol §7). Runs every golden file up to the slice under test, so earlier slices are regression
 * tests. Contracts it relies on: `mountApp`, `createFixtureReader({ clock })`, and `createFixtureWriter({ mode })`
 * returning a Writer that also exposes `calls` (every call as `{ method, args }`) and `release()`.
 *
 * The moving-data holdout (from S2): a `text` expectation written `{ "text": …, "moves": true }` is checked again in a
 * second run of its entry through a Reader that multiplies the file's `moves.fields` that hold numbers by
 * `2 + (parseInt(head.slice(0, 2), 16) % 8)` (head from LEDGER_HEAD, default "00") and appends `·` to those that hold
 * names. There each marked text must exist, pass the absent lists and differ from its golden value, so a UI that
 * prints the fixture's values instead of the Reader's fails.
 */
type Step =
	| { click: string; expect?: Expectation }
	| { fill: string; value: string; expect?: Expectation }
	| { key: string; target: string; expect?: Expectation }
	| { release: true; expect?: Expectation };
type TextExpectation = string | { text: string; moves: true };
type Expectation = {
	text?: Record<string, TextExpectation>;
	contains?: Record<string, string[]>;
	count?: Record<string, number>;
	hash?: string;
	writes?: Array<{ method: string; args: unknown[] }>;
	absent?: string[];
	/** Form controls: each part is a substring of the first match's raw `value` (a textarea's text is not its
	 * textContent). */
	value?: Record<string, string[]>;
	/** `text` selectors the moving-data run checks again (protocol §7); this runner does not read it. */
	moves?: string[];
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
	source?: string;
	hooks: string[];
	matrix?: Record<string, string[]>;
	/** Reader field paths, `<method>.<property>…`, with `[]` after a segment that is a list, e.g.
	 * `bookings.bookings[].attendee.name` or `schools[].name`. Amounts, counts and names only. */
	moves?: { fields: string[] };
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

const head = process.env.LEDGER_HEAD ?? "00";
const movesFactor = 2 + (Number.parseInt(head.slice(0, 2), 16) % 8);
const nameMark = "·";
const fieldPathPattern = /^[A-Za-z]+(\[\])?(\.[A-Za-z]+(\[\])?)*$/;
/** Ids, keys, dates, times and indexes never move: the UI may rightly print them as they are. */
const fixedFieldPattern =
	/^(id|key|index|date|time|from|to)$|(Id|Key|At|Date|Time|Index|Minutes)$/;

const normalize = (value: string | null | undefined): string =>
	(value ?? "").replace(/\s+/g, " ").trim();
const goldenText = (expected: TextExpectation): string =>
	typeof expected === "string" ? expected : expected.text;
const moves = (expected: TextExpectation): boolean =>
	typeof expected !== "string" && expected.moves === true;
const expectationsOf = (entry: Entry): Expectation[] => [
	...(entry.steps ?? []).flatMap((step) => (step.expect ? [step.expect] : [])),
	entry.expect,
];
const hasMovingText = (entry: Entry): boolean =>
	expectationsOf(entry).some((expectation) =>
		Object.values(expectation.text ?? {}).some(moves),
	);
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

/** One step of a field path: a property, or every item of a list. */
type FieldStep = { property: string } | { each: true };
/** `bookings.bookings[].attendee.name` is the method `bookings`, then `bookings`, every item, `attendee`, `name`. */
const parseField = (field: string): { method: string; steps: FieldStep[] } => {
	const [first = "", ...rest] = field.split(".");
	const listStep = (segment: string): FieldStep[] =>
		segment.endsWith("[]") ? [{ each: true }] : [];
	return {
		method: first.replace("[]", ""),
		steps: [
			...listStep(first),
			...rest.flatMap((segment) => [
				{ property: segment.replace("[]", "") },
				...listStep(segment),
			]),
		],
	};
};
const moveValue = (
	value: unknown,
	steps: FieldStep[],
	field: string,
): unknown => {
	if (value === null || value === undefined) return value;
	const [step, ...rest] = steps;
	if (!step) {
		if (typeof value === "number") return value * movesFactor;
		if (typeof value === "string") return `${value}${nameMark}`;
		throw new Error(`${field} is not an amount, a count or a name`);
	}
	if ("each" in step) {
		if (!Array.isArray(value)) throw new Error(`${field}: not a list`);
		return value.map((item) => moveValue(item, rest, field));
	}
	if (typeof value !== "object")
		throw new Error(`${field}: ${step.property} is not on an object`);
	const record = value as Record<string, unknown>;
	return {
		...record,
		[step.property]: moveValue(record[step.property], rest, field),
	};
};
/** The fixture Reader with every listed field moved; methods with no listed field answer as they are. */
const movingReader = (reader: Reader, fields: string[]): Reader => {
	const parsed = fields.map((field) => ({ field, ...parseField(field) }));
	const wrapped: Record<string, unknown> = {};
	for (const [name, member] of Object.entries(reader)) {
		const own = parsed.filter((path) => path.method === name);
		wrapped[name] =
			typeof member === "function" && own.length > 0
				? async (...args: unknown[]) => {
						let value: unknown = await member.apply(reader, args);
						for (const path of own)
							value = moveValue(value, path.steps, path.field);
						return value;
					}
				: member;
	}
	return wrapped as unknown as Reader;
};

const checkAbsent = (root: HTMLElement, expectation: Expectation): void => {
	const pageText = normalize(root.textContent);
	for (const word of [...globallyAbsent, ...(expectation.absent ?? [])]) {
		expect({ absent: word, present: pageText.includes(word) }).toEqual({
			absent: word,
			present: false,
		});
	}
};

const check = (
	root: HTMLElement,
	expectation: Expectation,
	writerCalls: ReadonlyArray<unknown>,
): void => {
	for (const [selector, expected] of Object.entries(expectation.text ?? {})) {
		const text = goldenText(expected);
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
	for (const [selector, parts] of Object.entries(expectation.value ?? {})) {
		const control = required(selector) as HTMLInputElement;
		for (const part of parts)
			expect({
				selector,
				value: part,
				ok: control.value.includes(part),
			}).toEqual({ selector, value: part, ok: true });
	}
	if (expectation.hash !== undefined)
		expect(window.location.hash).toContain(expectation.hash);
	if (expectation.writes) expect(writerCalls).toEqual(expectation.writes);
	checkAbsent(root, expectation);
	const unknownHooks = [...document.querySelectorAll("[data-test]")]
		.map((element) => element.getAttribute("data-test") ?? "")
		.filter((hook) => !allowedHooks.has(hook));
	expect(unknownHooks).toEqual([]);
};

/** The holdout's check: only the marked texts, which must exist and differ, and the absent lists. */
const checkMoved = (root: HTMLElement, expectation: Expectation): void => {
	for (const [selector, expected] of Object.entries(expectation.text ?? {})) {
		if (!moves(expected)) continue;
		const golden = goldenText(expected);
		const text = normalize(required(selector).textContent);
		expect({ selector, golden, moved: text !== golden }).toEqual({
			selector,
			golden,
			moved: true,
		});
	}
	checkAbsent(root, expectation);
};

let unmount: (() => void) | null = null;
afterEach(() => {
	unmount?.();
	unmount = null;
	document.body.innerHTML = "";
	window.location.hash = "";
});

/** Mounts the entry's route, runs its steps and hands each step's expectation, then the entry's, to `verify`. */
const runEntry = async (
	entry: Entry,
	reader: Reader,
	verify: (
		root: HTMLElement,
		expectation: Expectation,
		writerCalls: ReadonlyArray<unknown>,
	) => void,
): Promise<void> => {
	window.location.hash = entry.route;
	const root = document.createElement("div");
	root.id = "app";
	document.body.appendChild(root);
	const writer = createFixtureWriter({ mode: entry.writer ?? "instant" });
	unmount = mountApp(root, { reader, writer, clock }).unmount;
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
		if (step.expect) verify(root, step.expect, writer.calls);
	}
	verify(root, entry.expect, writer.calls);
};

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
		const movingEntries = file.entries.filter(hasMovingText);
		const fields = file.moves?.fields ?? [];
		test("moves fields are amounts, counts or names", () => {
			expect(Number.isNaN(movesFactor)).toBe(false);
			if (movingEntries.length > 0) expect(fields.length).toBeGreaterThan(0);
			const malformed = fields.filter(
				(field) => !fieldPathPattern.test(field) || !field.includes("."),
			);
			const fixed = fields.filter((field) =>
				fixedFieldPattern.test(
					(field.split(".").pop() ?? "").replace("[]", ""),
				),
			);
			expect({ malformed, fixed }).toEqual({ malformed: [], fixed: [] });
		});
		for (const entry of file.entries) {
			test(entry.id, () =>
				runEntry(entry, createFixtureReader({ clock }), check),
			);
		}
		for (const entry of movingEntries) {
			test(`${entry.id} (moves ×${movesFactor})`, () =>
				runEntry(
					entry,
					movingReader(createFixtureReader({ clock }), fields),
					checkMoved,
				));
		}
	});
}
