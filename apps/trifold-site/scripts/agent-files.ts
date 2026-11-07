/**
 * Agent files, written into build/ after `vite build` (run by `bun run build`):
 *
 * - a markdown mirror of every prerendered page at <path>.md (the homepage at index.md): the page's <main>, converted
 *   to GFM by turndown, so a mirror can't drift from its page. Elements marked data-agent="skip" (the hero canvas,
 *   toggles, the footer's own "For agents" note) are dropped; an element marked data-agent-md="<name>" is replaced by
 *   markdown from the same data module the page renders (the pricing cards show one toggle state; pricing.md lists
 *   them all);
 * - llms-full.txt, every listed mirror concatenated, and llms.txt, the index (llmstxt.org);
 * - the sample receipt, its tampered copy and the demo public key under /samples/, for agents trying the verifier;
 * - a Content-Type and noindex block per mirror, appended to build/_headers.
 *
 * The build fails if a prerendered page is missing from PAGES in src/lib/config.ts (or a comparison), so llms.txt
 * always lists every page.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { COMPETITORS, compareHref } from "../src/lib/compare/competitors.ts";
import {
	AGENT_EXCLUDED,
	CLI_URL,
	DEMO_URL,
	PAGES,
	SITE_ORIGIN,
} from "../src/lib/config.ts";
import { LLMS_FACTS, LLMS_SUMMARY } from "../src/lib/content/llms.ts";
import {
	ADHOC_COMMAND,
	GOLDEN_DOC_URL,
	SIM_COMMANDS,
	TRY_IT_LINES,
	TRY_IT_NOTE,
} from "../src/lib/content/proof.ts";
import { addonsMarkdown, plansMarkdown } from "../src/lib/pricing/markdown.ts";
import {
	describeCommand,
	type Preset,
	SCENARIO_ORGS_URL,
	SIMPLIFICATIONS,
	VERTICALS,
} from "../src/lib/verticals.ts";

export const BUILD = join(import.meta.dir, "../build");
const SAMPLES = join(import.meta.dir, "../src/lib/samples");
const SAMPLE_FILES = [
	"receipt.json",
	"receipt-tampered.json",
	"public-key.json",
] as const;
const HEADERS_MARKER = "# Markdown mirrors (written by scripts/agent-files.ts)";

const MAIN = /<main\b[^>]*>([\s\S]*)<\/main>/;
const TITLE = /<title>([\s\S]*?)<\/title>/;
const DESCRIPTION = /<meta name="description" content="([^"]*)"/;
const TITLE_SUFFIX = / · Trifold$/;
const ROOT_LINK = /(href|src)="\/(?!\/)/g;
const HASH_LINK = /href="#/g;
const NEW_TAB = /^\s*\(opens in a new tab\)\s*$/;
const EXTRA_BLANK_LINES = /\n{3,}/g;
const TRAILING_SPACES = /[ \t]+$/gm;

/** Markdown generated from data modules, keyed by data-agent-md. */
const INJECT: Record<string, () => string> = {
	plans: plansMarkdown,
	addons: addonsMarkdown,
};

export type AgentPage = {
	path: string;
	title: string;
	description: string;
	url: string;
	mdUrl: string;
	markdown: string;
};

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	"#39": "'",
	"#x27": "'",
	nbsp: " ",
};
const decode = (text: string) =>
	text.replace(
		/&(amp|lt|gt|quot|#39|#x27|nbsp);/g,
		(_, name: string) => ENTITIES[name] ?? "",
	);

/** "index.html" → "/", "for/schools.html" → "/for/schools". */
export const pathOf = (file: string) => {
	const path = `/${file.replace(/\.html$/, "")}`;
	return path === "/index" ? "/" : path;
};
/** "/" → "index.md", "/for/schools" → "for/schools.md". */
export const mirrorOf = (path: string) =>
	`${path === "/" ? "index" : path.slice(1)}.md`;

const attribute = (node: TurndownService.Node, name: string) =>
	node.nodeType === 1 ? (node as HTMLElement).getAttribute(name) : null;

function converter(): TurndownService {
	const service = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "_",
	});
	service.use(gfm);
	service.addRule("inject", {
		filter: (node) => Boolean(attribute(node, "data-agent-md")),
		replacement: (_, node) => {
			const name = attribute(node, "data-agent-md") ?? "";
			const make = INJECT[name];
			if (!make) throw new Error(`No markdown for data-agent-md="${name}"`);
			return `\n\n${make()}\n\n`;
		},
	});
	// FAQ questions are accordion buttons; every other button is a control with nothing to read.
	service.addRule("buttons", {
		filter: "button",
		replacement: (content, node) =>
			attribute(node, "data-slot") === "accordion-trigger"
				? `\n\n**${content.trim()}**\n\n`
				: "",
	});
	service.addRule("summaries", {
		filter: "summary",
		replacement: (content) => `\n\n**${content.trim()}**\n\n`,
	});
	service.addRule("emptyLinks", {
		filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
		replacement: () => "",
	});
	service.remove((node) => attribute(node, "data-agent") === "skip");
	// Table captions are sr-only (the heading above says it), and so are "opens in a new tab" notes on links.
	service.remove(
		(node) =>
			node.nodeName === "CAPTION" || NEW_TAB.test(node.textContent ?? ""),
	);
	service.remove([
		"script",
		"style",
		"svg",
		"canvas",
		"noscript",
		"template",
		"input",
		"select",
		"textarea",
	]);
	return service;
}

/** One page's HTML to markdown: its <main>, with links made absolute. */
export function toMarkdown(
	html: string,
	path: string,
	service = converter(),
): string {
	const main = MAIN.exec(html)?.[1];
	if (main === undefined) throw new Error(`${path}: no <main>`);
	const pageUrl = `${SITE_ORIGIN}${path === "/" ? "/" : path}`;
	const absolute = main
		.replace(ROOT_LINK, `$1="${SITE_ORIGIN}/`)
		.replace(HASH_LINK, `href="${pageUrl}#`);
	return `${service.turndown(absolute).replace(TRAILING_SPACES, "").replace(EXTRA_BLANK_LINES, "\n\n").trim()}\n`;
}

async function htmlFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)))
		.filter((file) => file !== "404.html" && !file.startsWith("_app"))
		.sort();
}

const comparePaths = () => [
	"/compare",
	...COMPETITORS.map((competitor) => compareHref(competitor.slug)),
];

/** Every page the build produced, converted; fails when a page isn't in PAGES or the comparisons. */
export async function readPages(dir = BUILD): Promise<AgentPage[]> {
	const service = converter();
	const known = new Set<string>([...PAGES, ...comparePaths()]);
	const pages: AgentPage[] = [];
	for (const file of await htmlFiles(dir)) {
		const path = pathOf(file);
		if (!known.has(path))
			throw new Error(
				`${path} is prerendered but not in PAGES (src/lib/config.ts)`,
			);
		const html = await readFile(join(dir, file), "utf8");
		pages.push({
			path,
			title: decode(TITLE.exec(html)?.[1] ?? path).replace(TITLE_SUFFIX, ""),
			description: decode(DESCRIPTION.exec(html)?.[1] ?? ""),
			url: `${SITE_ORIGIN}${path === "/" ? "/" : path}`,
			mdUrl: `${SITE_ORIGIN}/${mirrorOf(path)}`,
			markdown: toMarkdown(html, path, service),
		});
	}
	const missing = [...known].filter(
		(path) => !pages.some((page) => page.path === path),
	);
	if (missing.length) throw new Error(`Not prerendered: ${missing.join(", ")}`);
	return pages;
}

const link = (page: AgentPage) =>
	`- [${page.title}](${page.mdUrl}): ${page.description}`;

/** The listed pages, in PAGES order, then the comparisons. */
function listed(pages: AgentPage[]) {
	const byPath = new Map(pages.map((page) => [page.path, page]));
	const compare = comparePaths();
	const pick = (paths: readonly string[]) =>
		paths.flatMap((path) => {
			const page = byPath.get(path);
			return page ? [page] : [];
		});
	return {
		main: pick(
			PAGES.filter(
				(path) => !AGENT_EXCLUDED.includes(path) && !compare.includes(path),
			),
		),
		compare: pick(compare),
	};
}

export function llmsTxt(pages: AgentPage[]): string {
	const { main, compare } = listed(pages);
	const sample = (file: string) => `${SITE_ORIGIN}/samples/${file}`;
	const verify = pages.find((page) => page.path === "/verify");
	const proof = pages.find((page) => page.path === "/proof");
	const tryIt = TRY_IT_LINES.map((line) => `\`${line.slice(2)}\``).join(
		", then ",
	);
	const presetLine = (preset: Preset) =>
		`  - \`${preset.name}\` (seed ${preset.seed}, ${preset.months}): ${preset.members} new paying members, ${preset.invoices} payments, ${preset.refunds} refunds, ${preset.disputes} disputes, ${preset.grossCollected} gross collected, ${preset.payingLastMonth} paying members last month${preset.payingNote ? ` (${preset.payingNote})` : ""}; KPI hash ${preset.hash}. Run \`${describeCommand(preset)}\`.`;
	const simulations = VERTICALS.map((vertical) => {
		const head = `- ${vertical.name}: ${vertical.org}, ${vertical.orgKind}. ${vertical.status === "dashboard" ? `Live dashboard at ${vertical.demoUrl}.` : "Simulated: numbers from the CLI, no dashboard."} In their words: ${vertical.vocabulary.join(", ")}.`;
		return [head, ...vertical.presets.map(presetLine)].join("\n");
	}).join("\n");
	return `# Trifold

> ${LLMS_SUMMARY}

${LLMS_FACTS}

Every page below is clean markdown; add .md to any page's URL (the homepage is ${SITE_ORIGIN}/index.md). Start here, not the marketing pages. No need to oversell it: every number shows its work.

## Pages

${main.map(link).join("\n")}

## Compare

${compare.map(link).join("\n")}

## Verify

- [Verify a receipt](${verify?.mdUrl ?? `${SITE_ORIGIN}/verify.md`}): paste a receipt's JSON at ${SITE_ORIGIN}/verify. The verifier runs entirely in the browser (an Ed25519 signature over the receipt's canonical bytes, then the books and seal when it holds them); no account, and nothing is sent to Trifold.
- [Sample receipt](${sample("receipt.json")}): a signed receipt from the invented sample school; it verifies.
- [Tampered sample](${sample("receipt-tampered.json")}): the same receipt with one change; it must fail.
- [Demo public key](${sample("public-key.json")}): the sample school's published key. A demo key; its private half was discarded.
- [The engine's CLI](${CLI_URL}): \`tfd verify receipt receipt.json --keys keys.json\` runs the same check offline (the \`atm\` command until the rename lands).

## Proof

- [${proof?.title ?? "Proof"}](${proof?.mdUrl ?? `${SITE_ORIGIN}/proof.md`}): a seeded synthetic school year through the engine, hledger and DuckDB gives one identical KPI hash per channel; the golden end-to-end check, its open findings, and what it doesn't prove.
- [Live demo](${DEMO_URL}): Honeycomb Hill Academy, a sample school's KPI dashboard on synthetic data, no login. Every number comes from the engine and is checked against its committed goldens.
- Try it: ${tryIt}. ${TRY_IT_NOTE}
- [The golden end-to-end check](${GOLDEN_DOC_URL}): how the engine's real CLI is compared byte for byte with committed goldens.

## Simulations

Every simulated organization is synthetic: invented names, prices and data, never a real organization. Every preset below gave the same KPI hash from the engine (atm), hledger and DuckDB (hashes show the first eight and last four characters). How the orgs are simulated: ${SCENARIO_ORGS_URL}

${simulations}

Commands, from packages/atm: ${SIM_COMMANDS.map((line) => `\`${line.slice(2)}\``).join(", ")}; an ad-hoc org scenario: \`${ADHOC_COMMAND}\`.

Where the simulations simplify: ${SIMPLIFICATIONS.join(" ")}

## Optional

- [llms-full.txt](${SITE_ORIGIN}/llms-full.txt): every page above, in full, in one file.
`;
}

export function llmsFullTxt(pages: AgentPage[]): string {
	const { main, compare } = listed(pages);
	return `${[...main, ...compare].map((page) => `# ${page.title}\n\nSource: ${page.url}\n\n${page.markdown}`).join("\n---\n\n")}`;
}

function headersBlock(pages: AgentPage[]): string {
	const blocks = pages.map(
		(page) =>
			`/${mirrorOf(page.path)}\n  Content-Type: text/markdown; charset=utf-8\n  X-Robots-Tag: noindex`,
	);
	return `${HEADERS_MARKER}\n${blocks.join("\n\n")}\n`;
}

async function write(dir: string, file: string, content: string) {
	const target = join(dir, file);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content);
}

export async function writeAgentFiles(dir = BUILD) {
	const pages = await readPages(dir);
	for (const page of pages)
		await write(dir, mirrorOf(page.path), page.markdown);
	await write(dir, "llms.txt", llmsTxt(pages));
	await write(dir, "llms-full.txt", llmsFullTxt(pages));
	for (const file of SAMPLE_FILES)
		await write(
			dir,
			`samples/${file}`,
			await readFile(join(SAMPLES, file), "utf8"),
		);
	const headers =
		(await readFile(join(dir, "_headers"), "utf8"))
			.split(HEADERS_MARKER)[0]
			?.trimEnd() ?? "";
	await write(dir, "_headers", `${headers}\n\n${headersBlock(pages)}`);
	return pages;
}

if (import.meta.main) {
	const pages = await writeAgentFiles();
	console.log(
		`agent files: ${pages.length} markdown mirrors, llms.txt, llms-full.txt, ${SAMPLE_FILES.length} samples`,
	);
}
