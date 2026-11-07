/**
 * The agent files (scripts/agent-files.ts): the converter on a small page, then what `bun run build` wrote into build/.
 * The build checks need a fresh build; run `bun run build` first.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BUILD,
	mirrorOf,
	pathOf,
	readPages,
	toMarkdown,
} from "../scripts/agent-files";
import { COMPETITORS, compareHref } from "../src/lib/compare/competitors";
import { AGENT_EXCLUDED, PAGES, SITE_ORIGIN } from "../src/lib/config";
import { AGENT_PROMPT } from "../src/lib/content/agents";
import { ANNUAL_MONTHS_CHARGED, PLANS } from "../src/lib/pricing/data";

const TRIPLE_ENTRY = /triple[- ]entry/i;
/** The trust page's claims table, where it sits in the "We don't say yet" column. */
const NOT_CLAIMED = /^\| [^|]+ \| “Triple-entry accounting” \|/;
const AGENT_NOTE = "Every page here is clean markdown";

describe("converter", () => {
	const html = `<html><head><title>X · Trifold</title></head><body><header>nav</header><main>
		<h1>Title</h1><div data-agent="skip"><canvas></canvas>Toggle</div><script>SCRIPT_BODY()</script>
		<p>See <a href="/pricing">pricing</a> and <a href="#faq">the FAQ</a>.</p>
		<svg><text>icon</text></svg><button>Copy</button>
		<div data-agent-md="plans"><p>Card that shows one state</p></div>
	</main><footer>${AGENT_NOTE}</footer></body></html>`;
	const markdown = toMarkdown(html, "/pricing");

	test("keeps <main> only and drops skipped, script, svg and button content", () => {
		expect(markdown).toStartWith("# Title");
		for (const gone of [
			"Toggle",
			"SCRIPT_BODY",
			"icon",
			"Copy",
			"nav",
			AGENT_NOTE,
			"<",
		])
			expect(markdown).not.toContain(gone);
	});

	test("makes links absolute", () => {
		expect(markdown).toContain(`[pricing](${SITE_ORIGIN}/pricing)`);
		expect(markdown).toContain(`[the FAQ](${SITE_ORIGIN}/pricing#faq)`);
	});

	test("replaces data-agent-md with every price from the pricing data", () => {
		expect(markdown).not.toContain("Card that shows one state");
		for (const plan of PLANS.filter((entry) => entry.price.std > 0)) {
			expect(markdown).toContain(`$${plan.price.std}/mo`);
			expect(markdown).toContain(`$${plan.price.np}/mo`);
			expect(markdown).toContain(
				`billed $${(plan.price.std * ANNUAL_MONTHS_CHARGED).toLocaleString("en-US")} a year`,
			);
		}
	});

	test("paths and mirrors", () => {
		expect(pathOf("index.html")).toBe("/");
		expect(pathOf("for/schools.html")).toBe("/for/schools");
		expect(mirrorOf("/")).toBe("index.md");
		expect(mirrorOf("/compare/trifold-vs-airtight")).toBe(
			"compare/trifold-vs-airtight.md",
		);
	});
});

describe("build output", () => {
	if (!existsSync(join(BUILD, "llms.txt")))
		throw new Error("No build/llms.txt: run `bun run build` before `bun test`");
	const read = (file: string) => readFileSync(join(BUILD, file), "utf8");
	const llms = read("llms.txt");
	const full = read("llms-full.txt");
	const comparePaths = [
		"/compare",
		...COMPETITORS.map((competitor) => compareHref(competitor.slug)),
	];
	const allPaths = [...PAGES, ...comparePaths.slice(1)];
	const mirrorUrl = (path: string) => `${SITE_ORIGIN}/${mirrorOf(path)}`;

	test("llms.txt follows llmstxt.org: H1, summary, sections", () => {
		expect(llms).toStartWith("# Trifold\n\n> ");
		for (const section of [
			"## Pages",
			"## Compare",
			"## Verify",
			"## Optional",
		])
			expect(llms).toContain(`\n${section}\n`);
		expect(llms).toContain(`${SITE_ORIGIN}/llms-full.txt`);
		expect(llms).toContain(`${SITE_ORIGIN}/samples/receipt.json`);
	});

	test("llms.txt lists every public page and every comparison, and not the excluded ones", () => {
		for (const path of allPaths) {
			const listed = llms.includes(`](${mirrorUrl(path)}): `);
			expect({ path, listed }).toEqual({
				path,
				listed: !AGENT_EXCLUDED.includes(path),
			});
		}
		const compare = llms.slice(
			llms.indexOf("## Compare"),
			llms.indexOf("## Verify"),
		);
		for (const path of comparePaths) expect(compare).toContain(mirrorUrl(path));
	});

	test("every page has a clean mirror, identical to a fresh conversion", async () => {
		const pages = await readPages();
		expect(pages.map((page) => page.path).sort()).toEqual([...allPaths].sort());
		for (const page of pages) {
			const mirror = read(mirrorOf(page.path));
			expect(mirror).toBe(page.markdown);
			expect(mirror).not.toContain("<script");
			expect(mirror).not.toContain(AGENT_NOTE);
			expect(mirror).not.toContain(AGENT_PROMPT);
			expect(mirror.length).toBeGreaterThan(200);
		}
	});

	test('"triple-entry" only describes a competitor, or what Trifold does not claim', () => {
		const words = COMPETITORS.flatMap((competitor) => [
			competitor.name,
			competitor.tagline,
		]);
		const files = [...allPaths.map(mirrorOf), "llms.txt", "llms-full.txt"];
		for (const file of files) {
			for (const line of read(file)
				.split("\n")
				.filter((text) => TRIPLE_ENTRY.test(text))) {
				const allowed =
					NOT_CLAIMED.test(line) || words.some((word) => line.includes(word));
				expect({ file, line, allowed }).toEqual({ file, line, allowed: true });
			}
		}
	});

	test("llms.txt carries the agent note once; llms-full.txt has every listed page once", () => {
		expect(llms.split("Start here, not the marketing pages").length).toBe(2);
		expect(full).not.toContain(AGENT_NOTE);
		for (const path of allPaths.filter(
			(entry) => !AGENT_EXCLUDED.includes(entry),
		)) {
			const url = `${SITE_ORIGIN}${path === "/" ? "/" : path}`;
			expect(full.split(`\nSource: ${url}\n`).length).toBe(2);
		}
	});

	test("pricing.md shows monthly, annual and non-profit prices", () => {
		const pricing = read("pricing.md");
		for (const plan of PLANS.filter((entry) => entry.price.std > 0)) {
			expect(pricing).toContain(`| ${plan.name} | $${plan.price.std}/mo |`);
			expect(pricing).toContain(
				`billed $${(plan.price.np * ANNUAL_MONTHS_CHARGED).toLocaleString("en-US")} a year`,
			);
		}
	});

	test("_headers marks every mirror as markdown and noindex", () => {
		const headers = read("_headers");
		for (const path of allPaths) {
			expect(headers).toContain(
				`/${mirrorOf(path)}\n  Content-Type: text/markdown; charset=utf-8\n  X-Robots-Tag: noindex`,
			);
		}
		expect(headers.split("# Markdown mirrors").length).toBe(2);
	});

	test("each page links its mirror", () => {
		for (const path of allPaths) {
			const html = read(path === "/" ? "index.html" : `${path.slice(1)}.html`);
			expect(html).toContain(
				`<link rel="alternate" type="text/markdown" href="${mirrorUrl(path)}"`,
			);
		}
	});
});
