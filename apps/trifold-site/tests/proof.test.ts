/**
 * The proof page, the live demo link and the simulated verticals: claim rules checked on the source and on what
 * `bun run build` wrote into build/. Run `bun run build` first.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BUILD } from "../scripts/agent-files";
import { DEMO_URL, SITE_ORIGIN } from "../src/lib/config";
import { type Preset, VERTICALS } from "../src/lib/verticals";

const SRC = join(import.meta.dir, "../src");
const CONFIG = "lib/config.ts";
const DEMO_HOST = new URL(DEMO_URL).host;

/** Claims the site must never make, in any built page, mirror or agent file. */
const BANNED: [string, RegExp][] = [
	["a speed or duration number", /\b\d+\s*(seconds?|minutes?|mins?)\b/i],
	["600/600", /600\/600/],
	["the view-hash count", /256 view/i],
	["S3", /\bS3\b/],
	["DuckDB over R2", /duckdb over r2/i],
	["a fourth path", /fourth path/i],
	["the wrong school name", /honeycomb hollow/i],
	["MRR, except saying there is none", /(?<!no )\bMRR\b/],
	["pledges, except saying there are none", /(?<!no )\bpledges?\b/i],
	["win-back", /win-back/i],
	["refund windows", /refund window/i],
	["giver retention", /giver retention/i],
	["a vertical still coming", /simulation coming/i],
];
/** Words for what the generator doesn't model, or KPIs the engine doesn't compute: never in vertical copy. */
const NOT_MODELLED =
	/win-back|pledge|refund window|failed payment|retention|\bMRR\b|recurring revenue|seat changes|coming/i;

/** The verified runs on atm dev (10a447d6), as the coordinator recorded them: verticals.ts must match. */
const VERIFIED: Record<string, Omit<Preset, "name" | "what" | "payingNote">> = {
	"studio-members": {
		seed: 201,
		months: "2026-01..2026-12",
		members: 73,
		invoices: 512,
		refunds: 3,
		disputes: 1,
		grossCollected: "$47,527",
		payingLastMonth: 45,
		hash: "c315b659…ca91",
	},
	"studio-class-packs": {
		seed: 202,
		months: "2026-01..2026-09",
		members: 40,
		invoices: 199,
		refunds: 1,
		disputes: 2,
		grossCollected: "$17,771.63",
		payingLastMonth: 22,
		hash: "cdbb0c6d…587e",
	},
	"church-giving": {
		seed: 301,
		months: "2026-01..2026-12",
		members: 82,
		invoices: 608,
		refunds: 5,
		disputes: 0,
		grossCollected: "$68,050",
		payingLastMonth: 52,
		hash: "b87fa3cb…7904",
	},
	"saas-seats": {
		seed: 401,
		months: "2026-01..2026-12",
		members: 89,
		invoices: 515,
		refunds: 3,
		disputes: 1,
		grossCollected: "$69,521",
		payingLastMonth: 49,
		hash: "cd0acf28…69f6",
	},
	"saas-annual": {
		seed: 402,
		months: "2026-01..2027-12",
		members: 20,
		invoices: 38,
		refunds: 0,
		disputes: 0,
		grossCollected: "$52,993",
		payingLastMonth: 0,
		hash: "84d6c33c…3f36",
	},
	"creator-launch": {
		seed: 501,
		months: "2026-01..2026-12",
		members: 134,
		invoices: 851,
		refunds: 61,
		disputes: 6,
		grossCollected: "$25,297",
		payingLastMonth: 66,
		hash: "38e8325c…62ad",
	},
};
const PRESETS = VERTICALS.flatMap((vertical) => vertical.presets);
const presetByName = new Map(PRESETS.map((preset) => [preset.name, preset]));
const SIMULATED = VERTICALS.filter(
	(vertical) => vertical.status === "simulated",
);
const NEAR_VERTICAL = /customers?|used by|trusted by/i;
/** Characters either side of a vertical's name that must stay clear of customer language. */
const NEAR_WINDOW = 400;
const TAG = /<[^>]*>/g;
const CARD =
	/<article\b[^>]*data-vertical="([^"]+)"[^>]*data-status="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g;
/** A preset's numbers as rendered: a /proof table row, or a card's stats (up to the end of its list). */
const PRESET_BLOCK =
	/<(tr|div)\b[^>]*data-preset="([^"]+)"[^>]*>([\s\S]*?)<\/(?:tr|dl)>/g;
/** A block's text as space-separated tokens, padded so `includes(" 45 ")` matches whole tokens. */
const tokens = (html: string) =>
	` ${html
		.replace(TAG, " ")
		.replace(/&nbsp;|\u00a0/g, " ")
		.replace(/\s+/g, " ")
		.trim()} `;

function files(dir: string, keep: (file: string) => boolean): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.filter(keep);
}

describe("source", () => {
	test("the demo URL is spelled only in config.ts; everything else reads DEMO_URL", () => {
		const spelled = files(SRC, (file) =>
			/\.(ts|svelte|md|json|css|html)$/.test(file),
		)
			.filter((file) => readFileSync(file, "utf8").includes(DEMO_HOST))
			.map((file) => relative(SRC, file));
		expect(spelled).toEqual([CONFIG]);
	});

	test("only the school links a dashboard; the simulated orgs have presets and no demo link", () => {
		expect(
			VERTICALS.filter((vertical) => vertical.demoUrl).map(
				(vertical) => vertical.slug,
			),
		).toEqual(["schools"]);
		expect(
			VERTICALS.filter((vertical) => vertical.status === "dashboard").map(
				(vertical) => vertical.slug,
			),
		).toEqual(["schools"]);
		expect(VERTICALS[0]?.demoUrl).toBe(DEMO_URL);
		for (const vertical of SIMULATED)
			expect({
				slug: vertical.slug,
				presets: vertical.presets.length > 0,
			}).toEqual({ slug: vertical.slug, presets: true });
	});

	test("every preset's numbers match the verified runs", () => {
		expect(PRESETS.map((preset) => preset.name).sort()).toEqual(
			Object.keys(VERIFIED).sort(),
		);
		for (const preset of PRESETS) {
			const { name, what: _what, payingNote: _note, ...numbers } = preset;
			expect({ name, ...numbers }).toEqual({ name, ...VERIFIED[name] });
		}
	});

	test("vertical copy describes only what's modelled and only KPIs the engine computes", () => {
		for (const vertical of VERTICALS) {
			const copy = [
				...vertical.vocabulary,
				...vertical.simulates,
				...vertical.kpis,
				...Object.values(vertical.labels ?? {}),
			];
			for (const line of copy)
				expect({
					slug: vertical.slug,
					line,
					match: NOT_MODELLED.exec(line)?.[0] ?? null,
				}).toMatchObject({ match: null });
		}
	});

	test("the church vertical speaks of givers and recurring giving, never members or MRR", () => {
		const nonprofit = VERTICALS.find((entry) => entry.slug === "churches");
		// The church's own words; the engine's KPI names (new_paying_members) are shown beside them, not instead.
		const text = JSON.stringify([
			nonprofit?.name,
			nonprofit?.vocabulary,
			nonprofit?.simulates,
			nonprofit?.kpis,
			Object.values(nonprofit?.labels ?? {}),
		]);
		expect(text).toContain("giver");
		expect(text).toMatch(/recurring giving/i);
		expect(text).not.toMatch(/\bMRR\b|\bmembers?\b/i);
	});
});

describe("build output", () => {
	if (!existsSync(join(BUILD, "llms.txt")))
		throw new Error("No build/llms.txt: run `bun run build` before `bun test`");
	const read = (file: string) => readFileSync(join(BUILD, file), "utf8");
	const built = files(
		BUILD,
		(file) => /\.(html|md|txt)$/.test(file) && !file.includes("/_app/"),
	);

	test("llms.txt lists /proof, the live demo and every simulation", () => {
		const llms = read("llms.txt");
		expect(llms).toContain(`](${SITE_ORIGIN}/proof.md): `);
		expect(llms).toContain(DEMO_URL);
		expect(llms).toContain("\n## Simulations\n");
		for (const vertical of VERTICALS)
			expect(llms).toContain(`- ${vertical.name}: ${vertical.org}`);
		for (const preset of PRESETS) {
			const line =
				llms
					.split("\n")
					.find((text) =>
						text.includes(`\`${preset.name}\` (seed ${preset.seed}`),
					) ?? "";
			for (const value of [
				preset.grossCollected,
				preset.hash,
				`${preset.members} new paying members`,
				`${preset.invoices} payments`,
			])
				expect({
					preset: preset.name,
					value,
					found: line.includes(value),
				}).toMatchObject({ found: true });
		}
		expect(llms).toContain("Where the simulations simplify: ");
	});

	test("no banned claim in any built page, mirror or agent file", () => {
		expect(built.length).toBeGreaterThan(20);
		for (const file of built) {
			const raw = readFileSync(file, "utf8");
			// Text only: class names such as "mt-1.5 min-h-[22px]" aren't claims.
			const text = file.endsWith(".html") ? raw.replace(TAG, " ") : raw;
			for (const [what, pattern] of BANNED) {
				const match = pattern.exec(text)?.[0] ?? null;
				expect({ file: relative(BUILD, file), what, match }).toEqual({
					file: relative(BUILD, file),
					what,
					match: null,
				});
			}
		}
	});

	test("only the school's card links the dashboard; simulated cards have no demo link and nothing unmodelled", () => {
		const seen: Record<string, number> = {};
		for (const file of built.filter((entry) => entry.endsWith(".html"))) {
			for (const [, slug = "", status = "", inner = ""] of read(
				relative(BUILD, file),
			).matchAll(CARD)) {
				seen[status] = (seen[status] ?? 0) + 1;
				const where = { file: relative(BUILD, file), slug };
				if (slug !== "schools")
					expect({ ...where, demo: inner.includes(DEMO_HOST) }).toEqual({
						...where,
						demo: false,
					});
				if (status === "simulated")
					expect({
						...where,
						match: NOT_MODELLED.exec(tokens(inner))?.[0] ?? null,
					}).toEqual({ ...where, match: null });
			}
		}
		// Simulated: the homepage gallery (4), and one card each on /for/studios, /churches, /nonprofits, /saas and /creators.
		expect(seen).toEqual({ dashboard: 1, simulated: SIMULATED.length + 5 });
	});

	test("every number shown for a preset equals verticals.ts, and /proof has a row for each", () => {
		const rows = new Set<string>();
		for (const file of built.filter((entry) => entry.endsWith(".html"))) {
			for (const [, kind = "", name = "", inner = ""] of read(
				relative(BUILD, file),
			).matchAll(PRESET_BLOCK)) {
				const preset = presetByName.get(name);
				expect({ name, known: Boolean(preset) }).toEqual({ name, known: true });
				if (!preset) continue;
				if (kind === "tr" && file.endsWith("proof.html")) rows.add(name);
				const shown =
					kind === "tr"
						? [
								preset.members,
								preset.invoices,
								preset.refunds,
								preset.disputes,
								preset.grossCollected,
								preset.payingLastMonth,
								preset.hash,
								preset.months,
							]
						: [
								preset.grossCollected,
								preset.members,
								preset.payingLastMonth,
								preset.seed,
								preset.months,
							];
				const text = tokens(inner);
				for (const value of shown)
					expect({
						file: relative(BUILD, file),
						name,
						value,
						found: text.includes(` ${value} `),
					}).toMatchObject({ found: true });
			}
		}
		expect([...rows].sort()).toEqual([...presetByName.keys()].sort());
	});

	test("no customer, used-by or trusted-by language near a vertical's name", () => {
		const mirrors = [
			"index.md",
			"proof.md",
			...readdirSync(join(BUILD, "for"))
				.filter((file) => file.endsWith(".md"))
				.map((file) => `for/${file}`),
		];
		for (const file of mirrors) {
			const text = read(file);
			for (const name of VERTICALS.flatMap((vertical) => [
				vertical.name,
				vertical.org,
			])) {
				const vertical = { name };
				let at = text.indexOf(vertical.name);
				while (at !== -1) {
					const near = text.slice(
						Math.max(0, at - NEAR_WINDOW),
						at + vertical.name.length + NEAR_WINDOW,
					);
					const match = NEAR_VERTICAL.exec(near)?.[0] ?? null;
					expect({ file, vertical: vertical.name, match }).toEqual({
						file,
						vertical: vertical.name,
						match: null,
					});
					at = text.indexOf(vertical.name, at + 1);
				}
			}
		}
	});

	test("the churches page says giver and recurring giving, never MRR or members", () => {
		const page = read("for/churches.md");
		expect(page).toContain("giver");
		expect(page).toMatch(/recurring giving/i);
		expect(page).toContain("Giving collected");
		expect(page).not.toMatch(/\bMRR\b|\bmembers?\b/i);
	});

	test("the homepage shows the diagram once and the demo with its caption", () => {
		const home = read("index.html");
		expect(home.split("One sample school year").length).toBe(2);
		expect(home).toContain(
			"Honeycomb Hill Academy is a sample school with synthetic data.",
		);
		const demoLinks = [...home.matchAll(/<a\b[^>]*>/g)]
			.map(([tag]) => tag)
			.filter((tag) => tag.includes(`href="${DEMO_URL}"`));
		expect(demoLinks.length).toBeGreaterThan(0);
		for (const tag of demoLinks) {
			expect(tag).toContain('rel="noopener"');
			expect(tag).toContain('target="_blank"');
		}
		expect(home).not.toContain("<iframe");
	});
});
