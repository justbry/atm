import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { canonicalize, sha256Hex } from "../../atm/src/ledger/util.ts";
import {
	type CellRules,
	kpiDocument,
	type PresetBundle,
} from "../gates/oracle.ts";
import { mountApp } from "../src/app/mount.tsx";
import {
	type Cell,
	cellKind,
	type Grain,
	type KpiDocument,
	type KpiFormat,
	type KpiQuery,
	type Viewer,
} from "../src/data/kpi-document.ts";
import type { Reader } from "../src/data/reader.ts";
import { createFixtureReader } from "../src/fixtures/reader.ts";
import { createFixtureWriter } from "../src/fixtures/writer.ts";

/**
 * Gate C (protocol §5): one chain from atm's fixtures to the UI's pixels, hashed with atm's own canonicalize and
 * sha256Hex. C1 and C2 need only data and run from S0; C3 and C4 join in S1 with the fixture documents. The parts that
 * need the S1 build (the fixture Reader's `kpiDocument`) skip until it exists.
 */
type KpiRow = { kpiId: string; period: string; unit: string; value: number };
type KpiExport = {
	fixtureHash: string;
	kpisHash: string;
	profile: string;
	rows: KpiRow[];
};
type ViewsManifest = { objects: Record<string, string> };
type MonthView = {
	month: string;
	money?: { grossCents: number; refundedCents: number; feeCents: number };
};

const repositoryRoot = join(import.meta.dir, "..", "..", "..");
const snapshot = join(repositoryRoot, "plans/ledger-ui/design/mart");
const goldens = join(repositoryRoot, "packages/atm/tests/golden/scenarios");
const byId = (first: KpiRow, second: KpiRow): number =>
	first.kpiId < second.kpiId
		? -1
		: first.kpiId > second.kpiId
			? 1
			: first.period < second.period
				? -1
				: first.period > second.period
					? 1
					: 0;
/** atm's kpiHash (packages/atm/src/scenario/kpis.ts), reproduced with atm's own canonicalize and sha256Hex. */
const kpiHash = (rows: readonly KpiRow[]): string =>
	sha256Hex(
		canonicalize(
			[...rows]
				.sort(byId)
				.map(({ kpiId, period, value }) => ({ kpiId, period, value })),
		),
	);
const readExport = (preset: string): KpiExport =>
	JSON.parse(
		gunzipSync(
			readFileSync(join(snapshot, "kpis", `${preset}.json.gz`)),
		).toString("utf8"),
	) as KpiExport;

const presets = readdirSync(join(snapshot, "kpis"))
	.filter((name) => name.endsWith(".json.gz"))
	.map((name) => name.slice(0, -".json.gz".length))
	.sort();

describe("C1: atm export equals atm's goldens", () => {
	test("the snapshot has the 15 presets", () => {
		expect(presets.length).toBe(15);
	});
	for (const preset of presets) {
		test(preset, () => {
			const exported = readExport(preset);
			const golden = JSON.parse(
				readFileSync(join(goldens, `${preset}.json`), "utf8"),
			) as KpiExport;
			expect({
				fixtureHash: exported.fixtureHash,
				kpisHash: exported.kpisHash,
			}).toEqual({
				fixtureHash: golden.fixtureHash,
				kpisHash: golden.kpisHash,
			});
			expect(kpiHash(exported.rows)).toBe(exported.kpisHash);
		});
	}
});

describe("C2: atm's read-slice views agree with the export", () => {
	const withViews = presets.filter((preset) =>
		existsSync(join(snapshot, "views", preset)),
	);
	test("five presets replay in atm's read slice", () => {
		expect(withViews).toEqual([
			"child-only",
			"fee-oracle",
			"free-only",
			"one-payer-tier",
			"tiny-school",
		]);
	});
	for (const preset of withViews) {
		test(preset, () => {
			const schools = readdirSync(join(snapshot, "views", preset, "schools"));
			expect(schools.length).toBe(1);
			const root = join(snapshot, "views", preset);
			const viewsDirectory = join(root, "schools", schools[0] ?? "", "views");
			const manifest = JSON.parse(
				readFileSync(join(viewsDirectory, "manifest.json"), "utf8"),
			) as ViewsManifest;
			for (const [key, hash] of Object.entries(manifest.objects)) {
				expect({
					key,
					hash: sha256Hex(readFileSync(join(root, key), "utf8")),
				}).toEqual({ key, hash });
			}
			const value = new Map(
				readExport(preset).rows.map((row) => [
					`${row.kpiId}@${row.period}`,
					row.value,
				]),
			);
			for (const name of readdirSync(join(viewsDirectory, "months"))) {
				const view = JSON.parse(
					readFileSync(join(viewsDirectory, "months", name), "utf8"),
				) as MonthView;
				const rows = {
					grossCents: value.get(`gross_collected@${view.month}`) ?? 0,
					refundedCents: value.get(`refunds@${view.month}`) ?? 0,
					feeCents: value.get(`stripe_fees@${view.month}`) ?? 0,
				};
				const money = {
					grossCents: view.money?.grossCents ?? 0,
					refundedCents: view.money?.refundedCents ?? 0,
					feeCents: view.money?.feeCents ?? 0,
				};
				expect({ month: view.month, ...money }).toEqual({
					month: view.month,
					...rows,
				});
			}
		});
	}
});

type DashboardView = "money" | "members" | "risk";
type CellLabels = Record<
	"suppressed" | "locked" | "not_computed" | "open_period" | "blocked",
	string
>;
type KpiReader = Reader & {
	kpiDocument?: (query: KpiQuery) => KpiDocument | Promise<KpiDocument>;
};

const mart = join(import.meta.dir, "..", "src/fixtures/mart");
const readJson = <T>(path: string): T =>
	JSON.parse(readFileSync(path, "utf8")) as T;
const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
const viewers: readonly Viewer[] = [
	"owner",
	"finance",
	"admin",
	"locked",
	"demo",
];
const grains: readonly Grain[] = ["month", "quarter"];
const dashboardViews: readonly DashboardView[] = ["money", "members", "risk"];
const committedRules = readJson<CellRules & { labels: CellLabels }>(
	join(mart, "cell-rules.json"),
);
const committedRows = readJson<Record<string, KpiRow[]>>(
	join(mart, "rows.json"),
);
const committedDocuments = readJson<Record<string, KpiDocument>>(
	join(mart, "documents.json"),
);
const bundle = readJson<{ profiles: Record<string, PresetBundle> }>(
	join(snapshot, "bundle.json"),
);
/** The KPIs each Dashboard view must render for its selected period (test/golden/S1.json `views`). */
const viewKpis = readJson<{ views: Record<DashboardView, string[]> }>(
	join(import.meta.dir, "golden", "S1.json"),
).views;
const documentKey = (preset: string, viewer: Viewer, grain: Grain): string =>
	`${preset}.${viewer}.${grain}`;
const fixtureReader = (): KpiReader =>
	createFixtureReader({ clock }) as KpiReader;
const hasKpiDocument = typeof fixtureReader().kpiDocument === "function";

describe("C3: the fixture documents equal the oracle on atm's rows", () => {
	test("the committed cell rules are cell-rules.v2.json", () => {
		expect(committedRules).toEqual(
			readJson(join(repositoryRoot, "plans/ledger-ui/loop/cell-rules.v2.json")),
		);
	});
	test("one document per preset, viewer and grain", () => {
		expect(Object.keys(committedDocuments).sort()).toEqual(
			presets
				.flatMap((preset) =>
					viewers.flatMap((viewer) =>
						grains.map((grain) => documentKey(preset, viewer, grain)),
					),
				)
				.sort(),
		);
	});
	test("no document carries a hash", () => {
		expect(
			/[0-9a-f]{64}/.test(readFileSync(join(mart, "documents.json"), "utf8")),
		).toBe(false);
	});
	for (const preset of presets) {
		test(`${preset}: the rows are atm's export rows of the KPIs cell-rules names`, () => {
			const named = (kpiId: string): boolean =>
				kpiId in committedRules.kpis ||
				(kpiId.includes(":") &&
					`${kpiId.slice(0, kpiId.indexOf(":"))}:*` in committedRules.kpis);
			const exported = readExport(preset).rows.filter((row) =>
				named(row.kpiId),
			);
			const byKey = new Map(
				exported.map((row) => [`${row.kpiId}@${row.period}`, row]),
			);
			const rows = committedRows[preset] ?? [];
			expect(rows.length).toBe(exported.length);
			expect(
				rows.filter((row) => {
					const source = byKey.get(`${row.kpiId}@${row.period}`);
					return (
						!source || source.value !== row.value || source.unit !== row.unit
					);
				}),
			).toEqual([]);
			expect(
				rows.filter((row) =>
					/closing_balance|family:|profile:/.test(row.kpiId),
				),
			).toEqual([]);
		});
		test(`${preset}: every document equals the oracle now`, () => {
			const presetBundle = bundle.profiles[preset];
			expect(presetBundle).toBeDefined();
			if (!presetBundle) return;
			for (const viewer of viewers)
				for (const grain of grains) {
					const key = documentKey(preset, viewer, grain);
					expect({ key, document: committedDocuments[key] }).toEqual({
						key,
						document: kpiDocument({
							rows: committedRows[preset] ?? [],
							bundle: presetBundle,
							rules: committedRules,
							preset,
							viewer,
							grain,
							clock,
						}),
					});
				}
		});
	}
	test.if(hasKpiDocument)(
		"the fixture Reader returns exactly the committed documents",
		async () => {
			const reader = fixtureReader();
			for (const preset of presets)
				for (const viewer of viewers)
					for (const grain of grains) {
						const key = documentKey(preset, viewer, grain);
						expect({
							key,
							document: await reader.kpiDocument?.({ preset, viewer, grain }),
						}).toEqual({ key, document: committedDocuments[key] });
					}
		},
	);
});

/** cell-rules `formats`; percents through Intl with one decimal so a half rounds the same way everywhere. */
const numberFormats = new Map<string, Intl.NumberFormat>();
const numberFormat = (
	format: KpiFormat,
	currency: string,
): Intl.NumberFormat => {
	const key = `${format}:${currency}`;
	const known = numberFormats.get(key);
	if (known) return known;
	const made =
		format === "money"
			? new Intl.NumberFormat("en-US", {
					style: "currency",
					currency: currency.toUpperCase(),
				})
			: format === "integer"
				? new Intl.NumberFormat("en-US")
				: new Intl.NumberFormat("en-US", {
						style: "percent",
						minimumFractionDigits: 1,
						maximumFractionDigits: 1,
					});
	numberFormats.set(key, made);
	return made;
};
const cellText = (cell: Cell, format: KpiFormat, currency: string): string =>
	typeof cell === "number"
		? numberFormat(format, currency).format(
				format === "money" ? cell / 100 : cell,
			)
		: "lt" in cell
			? `<${cell.lt}`
			: committedRules.labels[cell.hidden];
/** test/golden/S1.json `empty`: no payment in any closed period, so the Dashboard shows its "No payments yet" state. */
const isEmpty = (document: KpiDocument): boolean =>
	(document.series.payments_count ?? []).every(
		(cell) =>
			cell === 0 ||
			(typeof cell === "object" &&
				"hidden" in cell &&
				cell.hidden === "open_period"),
	);
const requiredKpis = (document: KpiDocument, view: DashboardView): string[] =>
	viewKpis[view].flatMap((id) =>
		id.endsWith(":*")
			? Object.keys(document.series).filter((kpi) =>
					kpi.startsWith(id.slice(0, -1)),
				)
			: [id],
	);
const dashboardRoute = (
	preset: string,
	viewer: Viewer,
	grain: Grain,
	view: DashboardView,
	period: string,
): string =>
	`#/b4u/dashboard?preset=${preset}&viewer=${viewer}&grain=${grain}&view=${view}&month=${period}`;
const macrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
/** Waits for the app to report the hash it rendered (protocol §3), then two more turns as the golden runner does. */
const settle = async (root: HTMLElement): Promise<boolean> => {
	for (
		let attempt = 0;
		attempt < 400 && root.dataset.route !== window.location.hash;
		attempt += 1
	)
		await macrotask();
	await macrotask();
	await macrotask();
	return root.dataset.route === window.location.hash;
};
const checkRender = (
	root: HTMLElement,
	document: KpiDocument,
	view: DashboardView,
	period: string,
	hash: string,
): string[] => {
	const problems: string[] = [];
	const indexOf = new Map(document.periods.map((at, index) => [at, index]));
	for (const element of root.querySelectorAll("[data-kpi][data-period]")) {
		const kpi = element.getAttribute("data-kpi") ?? "";
		const at = element.getAttribute("data-period") ?? "";
		const index = indexOf.get(at);
		const cell =
			index === undefined ? undefined : document.series[kpi]?.[index];
		const meta = document.meta[kpi];
		if (cell === undefined || !meta) {
			problems.push(`${hash}: ${kpi}@${at} is not in the document`);
			continue;
		}
		const expected = {
			cell: cellKind(cell),
			text: cellText(cell, meta.format, document.currency),
		};
		const rendered = {
			cell: element.getAttribute("data-cell"),
			text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
		};
		if (expected.cell !== rendered.cell || expected.text !== rendered.text)
			problems.push(
				`${hash}: ${kpi}@${at} rendered ${JSON.stringify(rendered)}, the document has ${JSON.stringify(expected)}`,
			);
	}
	if (!isEmpty(document))
		for (const kpi of requiredKpis(document, view))
			if (!root.querySelector(`[data-kpi="${kpi}"][data-period="${period}"]`))
				problems.push(`${hash}: ${kpi}@${period} is not rendered`);
	return problems;
};

/** C4 budget (protocol §5): all 150 mounts and their renders. */
const c4BudgetMilliseconds = 120_000;
let c4Milliseconds = 0;
let c4Renders = 0;
describe("C4: the Dashboard renders every document cell it shows exactly", () => {
	for (const preset of presets)
		test.if(hasKpiDocument)(
			preset,
			async () => {
				const started = performance.now();
				const problems: string[] = [];
				for (const viewer of viewers)
					for (const grain of grains) {
						const key = documentKey(preset, viewer, grain);
						const expected = committedDocuments[key];
						if (!expected) {
							problems.push(`${key}: no document`);
							continue;
						}
						window.location.hash = dashboardRoute(
							preset,
							viewer,
							grain,
							"money",
							expected.periods[0] ?? "",
						);
						const root = document.createElement("div");
						root.id = "app";
						document.body.appendChild(root);
						const app = mountApp(root, {
							reader: fixtureReader(),
							writer: createFixtureWriter({ mode: "instant" }),
							clock,
						});
						try {
							for (const view of dashboardViews)
								for (const period of expected.periods) {
									const hash = dashboardRoute(
										preset,
										viewer,
										grain,
										view,
										period,
									);
									window.location.hash = hash;
									c4Renders += 1;
									if (!(await settle(root))) {
										problems.push(
											`${hash}: the app reported ${root.dataset.route ?? "no route"}`,
										);
										continue;
									}
									problems.push(
										...checkRender(root, expected, view, period, hash),
									);
								}
						} finally {
							app.unmount();
							root.remove();
							window.location.hash = "";
						}
					}
				c4Milliseconds += performance.now() - started;
				expect(problems.slice(0, 25)).toEqual([]);
			},
			c4BudgetMilliseconds,
		);
	test.if(hasKpiDocument)("the matrix runs within its budget", () => {
		process.stdout.write(
			`C4: ${c4Renders} renders in ${(c4Milliseconds / 1000).toFixed(1)} s (budget ${c4BudgetMilliseconds / 1000} s)\n`,
		);
		expect(c4Milliseconds).toBeLessThanOrEqual(c4BudgetMilliseconds);
	});
});
