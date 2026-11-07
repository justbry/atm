/**
 * "Who it's for": the header's audience menu, the /for hub and the audience pages, checked on what `bun run build`
 * wrote into build/. Run `bun run build` first.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD, mirrorOf } from "../scripts/agent-files";
import { AUDIENCES, PAGES, SITE_ORIGIN } from "../src/lib/config";
import { verticalBySlug } from "../src/lib/verticals";

const ROLES = [
	"school",
	"church",
	"nonprofit",
	"studio",
	"saas",
	"creator",
	"accountant",
	"developer",
];
/** MRR, except when saying there is none. */
const MRR = /(?<!no )\bMRR\b/;
const HEADER = /<header\b[\s\S]*?<\/header>/;
/** The menu panel's own tag, then everything to the end of the header. */
const MENU = /<div\b[^>]*id="audience-menu"[^>]*>[\s\S]*$/;
const MENU_TAG = /<div\b[^>]*id="audience-menu"[^>]*>/;
/** The site footer is the page's last <footer> (the ledger panel has one of its own). */
const siteFooter = (page: string) => page.slice(page.lastIndexOf("<footer"));

describe("build output", () => {
	if (!existsSync(join(BUILD, "llms.txt")))
		throw new Error("No build/llms.txt: run `bun run build` before `bun test`");
	const read = (file: string) => readFileSync(join(BUILD, file), "utf8");
	const html = (path: string) =>
		read(path === "/" ? "index.html" : `${path.slice(1)}.html`);
	const audiencePaths = AUDIENCES.map((audience) => audience.href);

	test("the menu lists Everyone and the eight audience pages", () => {
		expect(audiencePaths[0]).toBe("/for");
		expect(audiencePaths.length).toBe(9);
	});

	test("the header has the disclosure, its label links to /for, and the menu is in the static HTML", () => {
		for (const path of ["/", "/pricing", "/for/churches"]) {
			const header = HEADER.exec(html(path))?.[0] ?? "";
			expect(header).toContain('href="/for"');
			expect(header).toMatch(
				/<button\b[^>]*aria-expanded="false"[^>]*aria-controls="audience-menu"/,
			);
			const menu = MENU.exec(header)?.[0] ?? "";
			const tag = MENU_TAG.exec(menu)?.[0] ?? "";
			expect(tag).toMatch(/\shidden(=""|\s|>)/);
			expect(tag).toContain('data-agent="skip"');
			for (const href of audiencePaths)
				expect({
					path,
					href,
					inMenu: menu.includes(`href="${href}"`),
				}).toMatchObject({ inMenu: true });
		}
	});

	test("every /for page is in PAGES, the sitemap, the footer and llms.txt, and has a .md mirror", () => {
		const sitemap = read("sitemap.xml");
		const footer = siteFooter(html("/"));
		const llms = read("llms.txt");
		for (const path of audiencePaths) {
			const where = {
				path,
				pages: (PAGES as readonly string[]).includes(path),
				sitemap: sitemap.includes(`<loc>${SITE_ORIGIN}${path}</loc>`),
				footer: footer.includes(`href="${path}"`),
				llms: llms.includes(`](${SITE_ORIGIN}/${mirrorOf(path)}): `),
				mirror: existsSync(join(BUILD, mirrorOf(path))),
			};
			expect(where).toEqual({
				path,
				pages: true,
				sitemap: true,
				footer: true,
				llms: true,
				mirror: true,
			});
		}
	});

	test("the new pages show their org's simulated numbers from verticals.ts", () => {
		const pages: [string, string][] = [
			["/for/churches", "churches"],
			["/for/saas", "saas"],
			["/for/creators", "creators"],
			["/for/studios", "studios"],
		];
		for (const [path, slug] of pages) {
			const vertical = verticalBySlug(slug);
			const page = html(path);
			expect(page).toContain(vertical.org);
			for (const preset of vertical.presets) {
				expect({
					path,
					preset: preset.name,
					shown: page.includes(`data-preset="${preset.name}"`),
				}).toMatchObject({ shown: true });
				expect(page).toContain(preset.grossCollected);
				expect(page).toContain(`scenarios describe ${preset.name}`);
			}
		}
	});

	test("the churches page marks year-end giving statements as Later", () => {
		const lines = read("for/churches.md")
			.split("\n")
			// Statements, not the FAQ question that asks about them.
			.filter(
				(line) =>
					/giving statement/i.test(line) && !line.trim().endsWith("?**"),
			);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines)
			expect({
				line,
				later: /later/i.test(line) || /not yet/i.test(line),
			}).toMatchObject({ later: true });
	});

	test("the SaaS page claims no MRR", () => {
		expect(read("for/saas.md")).not.toMatch(MRR);
		expect(read("for/saas.md")).toContain("no MRR KPI yet");
	});

	test("early access offers every audience's role", () => {
		const page = html("/early-access");
		for (const role of ROLES)
			expect({ role, offered: page.includes(`value="${role}"`) }).toMatchObject(
				{ offered: true },
			);
	});
});
