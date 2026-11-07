/**
 * The org KPI dashboard demos (`scripts/org-demos/build.ts`): generating them again gives the committed bytes, and every
 * page carries documents that hash to what they claim, built from KPI rows whose hash is the preset's parity golden.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildOrgDemos,
	type DemoPage,
	demoPage,
	OUTPUT_DIR,
	pageHtml,
} from "../scripts/org-demos/build.js";
import { canonicalize, sha256Hex } from "../src/ledger/util.js";
import { ORG_LABELS } from "../src/scenario/org-labels.js";
import { ORG_KINDS } from "../src/scenario/orgs.js";

const GENERATE_TIMEOUT_MS = 300_000;
const DATA_PATTERN =
	/<script type="application\/json" id="tfd-data">(.*?)<\/script>/s;
const golden = (preset: string): { kpisHash: string; fixtureHash: string } =>
	JSON.parse(
		readFileSync(
			join(import.meta.dir, "golden/scenarios", `${preset}.json`),
			"utf8",
		),
	);
const committed = (name: string): string =>
	readFileSync(join(OUTPUT_DIR, name), "utf8");
const dataOf = (html: string): DemoPage => {
	const json = DATA_PATTERN.exec(html)?.[1];
	if (!json) throw new Error("no #tfd-data in the page");
	return JSON.parse(json) as DemoPage;
};

describe("org KPI demos", () => {
	test(
		"a fresh generation is byte-identical to the committed pages (run `bun run org-demos` when it is not)",
		async () => {
			const files = await buildOrgDemos();
			expect(Object.keys(files).sort()).toEqual(
				readdirSync(OUTPUT_DIR)
					.filter((name) => name.endsWith(".html"))
					.sort(),
			);
			for (const [name, text] of Object.entries(files))
				expect(text, name).toBe(committed(name));
		},
		GENERATE_TIMEOUT_MS,
	);

	test(
		"one org generated twice in a process gives the same bytes",
		async () => {
			const first = pageHtml(await demoPage("church"));
			const second = pageHtml(await demoPage("church"));
			expect(second).toBe(first);
		},
		GENERATE_TIMEOUT_MS,
	);

	test("every page's documents hash as they claim, from rows whose hash is the parity golden", () => {
		for (const kind of ORG_KINDS) {
			const html = committed(`${kind}.html`);
			expect(html).toContain("demo, synthetic data");
			const page = dataOf(html);
			expect(page.presets.map((preset) => preset.name)).toEqual(
				ORG_LABELS[kind].presets.map((preset) => preset.name),
			);
			for (const preset of page.presets) {
				const expected = golden(preset.name);
				expect(preset.kpisHash, `${preset.name} kpisHash`).toBe(
					expected.kpisHash,
				);
				expect(preset.fixtureHash, `${preset.name} fixtureHash`).toBe(
					expected.fixtureHash,
				);
				for (const { year, documents } of preset.years)
					for (const [audience, { hash, document }] of Object.entries(
						documents,
					)) {
						expect(
							sha256Hex(canonicalize(document)),
							`${preset.name} ${year} ${audience}`,
						).toBe(hash);
						expect(document.source).toEqual({
							kind: "mart",
							preset: preset.name,
						});
						expect(document.year).toBe(year);
					}
			}
		}
	});

	test("the gallery lists the five orgs, the school first and highlighted", () => {
		const html = committed("index.html");
		expect(html).toContain("demo, synthetic data");
		const links = [
			...html.matchAll(
				/class="card( featured)?"><a class="go" href="(\w+)\.html"/g,
			),
		];
		expect(links.map((link) => link[2])).toEqual([...ORG_KINDS]);
		expect(links[0]?.[1]).toBe(" featured");
		expect(links.slice(1).every((link) => link[1] === undefined)).toBe(true);
	});
});
