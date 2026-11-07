/**
 * The no-login KPI dashboard demos, one static page per demo org (`src/scenario/orgs.ts`) and a gallery: each preset's
 * scenario is generated, round-tripped through atm's write path and folded by the atm channel (`runParity`, as `tfd
 * simulate` does), and its rows go through `kpiDocument` (the Worker's builder) for the owner and governance audiences.
 * The page embeds the documents as built and draws only their cells (`dashboard.client.js`), in the school mockup's
 * design (`plans/ledger-ui/design/mart/dashboard.html`). Run `bun run org-demos` in packages/atm; see the output's README.
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { KpiDisclosure } from "../../src/ledger/kpi-disclosure.js";
import { kpiDocument } from "../../src/ledger/kpi-document.js";
import type { KpiDocument } from "../../src/ledger/kpi-document-types.js";
import { canonicalize, sha256Hex } from "../../src/ledger/util.js";
import { buildFixture } from "../../src/scenario/fixture.js";
import { ORG_LABELS, orgKpiTitles } from "../../src/scenario/org-labels.js";
import { ORG_KINDS, ORGS, type OrgKind } from "../../src/scenario/orgs.js";
import { runParity } from "../../src/scenario/parity.js";
import { roundTripEvents } from "../../src/scenario/roundtrip.js";

const REPOSITORY = resolve(import.meta.dir, "../../../..");
export const OUTPUT_DIR = join(REPOSITORY, "plans/ledger-ui/design/mart/orgs");
/** The B4 Uni disclosure file as buzz-school stores it; a demo org stores no override and is small. */
const DISCLOSURE_PATH = join(
	REPOSITORY,
	"packages/ledger-ui/src/fixtures/disclosure.json",
);
export const DEMO_AUDIENCES = ["owner", "governance"] as const;
const SCHOOL_LIVE_DEMO = "https://staging.b4uni.com/for/schools/dashboard";

/** The gallery's one script: `?theme=light|dark` as the dashboards read it. */
const GALLERY_THEME = `const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
`;
const readAsset = (name: string): string =>
	readFileSync(join(import.meta.dir, name), "utf8");

/** One audience's document, with the sha256 of its canonical JSON. */
export type DemoDocument = { hash: string; document: KpiDocument };
export type DemoPreset = {
	name: string;
	label: string;
	seed: number;
	members: number;
	fixtureHash: string;
	/** The atm channel's KPI hash: the parity hash `tests/golden/scenarios/<preset>.json` holds. */
	kpisHash: string;
	years: Array<{
		year: number;
		documents: Record<(typeof DEMO_AUDIENCES)[number], DemoDocument>;
	}>;
};
export type DemoPage = {
	kind: OrgKind;
	name: string;
	label: string;
	words: {
		holder: { one: string; other: string };
		plan: { one: string; other: string };
		credit: { one: string; other: string };
	};
	titles: Record<string, string>;
	presets: DemoPreset[];
};

const monthEnd = (year: number, month: number): string =>
	new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
/** The clock a year's document is read at: the 8th of the month after the year's last simulated month (the day it
 * closes), or the year's last day when that month is December. */
const clockOf = (
	year: number,
	periods: readonly string[],
): { today: string; now: string } => {
	const last = periods.filter((period) => period.startsWith(`${year}-`)).at(-1);
	const month = Number(last?.slice(5, 7) ?? 12);
	const today =
		month === 12
			? monthEnd(year, 12)
			: `${year}-${String(month + 1).padStart(2, "0")}-08`;
	return { today, now: `${today}T12:00` };
};

const disclosure = (): KpiDisclosure => {
	const { file } = JSON.parse(readFileSync(DISCLOSURE_PATH, "utf8")) as {
		file: KpiDisclosure["file"];
	};
	return { size: "small", file, override: {} };
};

const demoPreset = async (
	kind: OrgKind,
	name: string,
	label: string,
): Promise<DemoPreset> => {
	const fixture = buildFixture({ profile: name });
	if ((fixture.scenario.org ?? "school") !== kind)
		throw new Error(`${name} is not a ${kind} preset`);
	const parity = await runParity({
		events: await roundTripEvents(fixture.events),
		periods: fixture.periods,
		channels: ["atm"],
	});
	const run = parity.runs[0];
	if (run?.status !== "ok")
		throw new Error(`${name}: the atm channel did not run`);
	const ids = new Set(run.rows.map((row) => row.kpiId));
	const plans = ORGS[kind].menu.tiers
		.map((tier) => tier.id)
		.filter((id) => ids.has(`revenue_by_tier:${id}`));
	const books = disclosure();
	const years = [
		...new Set(fixture.periods.map((period) => Number(period.slice(0, 4)))),
	];
	return {
		name,
		label,
		seed: fixture.scenario.seed,
		members: fixture.stats.families,
		fixtureHash: fixture.hash,
		kpisHash: run.hash,
		years: years.map((year) => ({
			year,
			documents: Object.fromEntries(
				DEMO_AUDIENCES.map((audience) => {
					const document = kpiDocument(run.rows, {}, books, audience, false, {
						school: ORGS[kind].id,
						currency: fixture.scenario.params.currency,
						clock: clockOf(year, fixture.periods),
						preset: name,
						plans,
					});
					return [
						audience,
						{ hash: sha256Hex(canonicalize(document)), document },
					];
				}),
			) as DemoPreset["years"][number]["documents"],
		})),
	};
};

export const demoPage = async (kind: OrgKind): Promise<DemoPage> => {
	const labels = ORG_LABELS[kind];
	const presets: DemoPreset[] = [];
	for (const preset of labels.presets)
		presets.push(await demoPreset(kind, preset.name, preset.label));
	return {
		kind,
		name: labels.displayName,
		label: ORGS[kind].label,
		words: {
			holder: labels.holder,
			plan: labels.plan,
			credit: labels.credit,
		},
		titles: orgKpiTitles(kind),
		presets,
	};
};

const escapeHtml = (text: string): string =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
/** JSON inside `<script type="application/json">`: no `<` may close the element early. */
const scriptJson = (value: unknown): string =>
	JSON.stringify(value).replaceAll("<", "\\u003c");

const head = (title: string, css: string): string =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>\n${css}</style></head>`;

/** An org's page: the documents as JSON, the mockup's layout, the client that draws them. */
export const pageHtml = (page: DemoPage): string =>
	`${head(`${page.name} KPIs · demo, synthetic data`, readAsset("dashboard.css"))}<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="transparent"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--mu)" stroke-width="1.2" opacity=".55"/></pattern></defs></svg>
<header><h1>${escapeHtml(page.name)} <span>KPIs · demo, synthetic data</span></h1><a class="back" href="index.html">All demos</a></header>
<div class="bar"><label for="prof">Preset</label><select id="prof"></select><select id="year" aria-label="Year"></select><span class="vw"><span class="lbl">Viewer</span><span id="viewers"></span></span><button id="theme" type="button"></button></div>
<div class="bar" id="tabs"></div>
<p class="note" id="note"></p>
<div class="tiles" id="tiles"></div><div class="grid" id="grid"></div>
<footer id="foot"></footer><div class="tip" id="tip"></div>
<script type="application/json" id="tfd-data">${scriptJson(page)}</script>
<script>
${readAsset("dashboard.client.js")}</script></body></html>
`;

/** The gallery: every org, the school first and highlighted. */
export const galleryHtml = (pages: readonly DemoPage[]): string => {
	const cards = pages
		.map((page) => {
			const school = page.kind === "school";
			const presets = page.presets.map((preset) => preset.label).join(" · ");
			const live = school
				? `<a class="live" href="${SCHOOL_LIVE_DEMO}" target="_blank" rel="noopener">Live demo</a>`
				: "";
			return `<li class="card${school ? " featured" : ""}"><a class="go" href="${page.kind}.html"><span class="kind">${escapeHtml(capitalized(page.label))}</span><b>${escapeHtml(page.name)}</b><span class="words">${escapeHtml(capitalized(page.words.holder.other))}, ${escapeHtml(page.words.plan.other)} and ${escapeHtml(page.words.credit.other)}</span><span class="presets">${escapeHtml(presets)}</span></a>${live}</li>`;
		})
		.join("\n");
	return `${head("Trifold KPI demos · demo, synthetic data", readAsset("dashboard.css"))}<body class="gallery">
<header><h1>Trifold KPI demos <span>demo, synthetic data</span></h1></header>
<p class="note">Five invented organizations, each with months of simulated billing run through the Trifold engine. Every dashboard draws atm's KPI document as built from that org's events, with no login. Every name and number is invented.</p>
<ul class="cards">
${cards}
</ul>
<footer>Synthetic data. Regenerate with <code>bun run org-demos</code> in packages/atm.</footer>
<script>
${GALLERY_THEME}</script></body></html>
`;
};

const capitalized = (text: string): string =>
	`${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** Every output file, by name. */
export const buildOrgDemos = async (): Promise<Record<string, string>> => {
	const pages: DemoPage[] = [];
	for (const kind of ORG_KINDS) pages.push(await demoPage(kind));
	return {
		"index.html": galleryHtml(pages),
		...Object.fromEntries(
			pages.map((page) => [`${page.kind}.html`, pageHtml(page)]),
		),
	};
};

if (import.meta.main) {
	const files = await buildOrgDemos();
	await mkdir(OUTPUT_DIR, { recursive: true });
	for (const [name, text] of Object.entries(files)) {
		await writeFile(join(OUTPUT_DIR, name), text);
		process.stdout.write(`wrote ${join(OUTPUT_DIR, name)}\n`);
	}
}
