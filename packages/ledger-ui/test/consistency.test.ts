import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { canonicalize, sha256Hex } from "../../atm/src/ledger/util.ts";
import {
	type DisclosureFixture,
	importRows,
	namedRow,
	type Provenance,
	plan,
} from "../scripts/import-mart.ts";
import type { Audience } from "../src/data/disclosure.ts";
import {
	type Cell,
	cellKind,
	type KpiDocument,
	type KpiFormat,
	type KpiQuery,
	type KpiTable,
	type TableGrain,
} from "../src/data/kpi-document.ts";
import type { Reader } from "../src/data/reader.ts";

/**
 * Gate C (protocol §5): one chain from atm's fixtures to the UI's pixels, hashed with atm's own canonicalize and
 * sha256Hex. C1 and C2 need only data; C3 checks every school's and audience's document against the oracle, the
 * committed provenance, atm's goldens and the disclosure object; C4 mounts the Dashboard on every document a school's
 * viewer may preview. The parts that need the S1b build (the fixture Reader's `kpiDocument` on the audiences) skip
 * until it exists.
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
type KpiReader = Reader & {
	kpiDocument?: (
		query: KpiQuery,
	) => Promise<KpiDocument | undefined> | KpiDocument | undefined;
};

const packageRoot = join(import.meta.dir, "..");
const mart = join(packageRoot, "src/fixtures/mart");
const readJson = <T>(path: string): T =>
	JSON.parse(readFileSync(path, "utf8")) as T;
const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
const dashboardViews: readonly DashboardView[] = ["money", "members", "risk"];
const committedRows = readJson<Record<string, KpiRow[]>>(
	join(mart, "rows.json"),
);
const committedDocuments = readJson<Record<string, KpiDocument>>(
	join(mart, "documents.json"),
);
const committedProvenance = readJson<Record<string, Provenance>>(
	join(mart, "provenance.json"),
);
const disclosure = readJson<DisclosureFixture>(
	join(packageRoot, "src/fixtures/disclosure.json"),
);
const { rows: importedRows, sources } = importRows();
const plans = plan(importedRows, sources);
/** The KPIs each Dashboard view must render for its selected period, per audience (test/golden/S1.json `views`). */
const viewKpis = readJson<{
	views: Record<Audience, Record<DashboardView, string[]>>;
}>(join(import.meta.dir, "golden", "S1.json")).views;

/** The fixture adapters load lazily: the Reader is the builder's, and the gate must not fall over when it lags. */
const loaded = await Promise.all([
	import("../src/app/mount.tsx"),
	import("../src/fixtures/reader.ts"),
	import("../src/fixtures/writer.ts"),
]).catch(() => null);
const fixtureReader = (): KpiReader | null =>
	loaded ? (loaded[1].createFixtureReader({ clock }) as KpiReader) : null;
/** The Reader answers the audience query (not a books level). */
const hasKpiDocument = await (async () => {
	const reader = fixtureReader();
	if (typeof reader?.kpiDocument !== "function") return false;
	const answer = await reader.kpiDocument({
		school: "b4u",
		preset: "monthly-members",
		audience: "public",
		pinLocked: false,
	});
	return answer?.audience === "public";
})();

describe("C3: every school's and audience's document equals the oracle, its provenance and the disclosure", () => {
	test("one document per planned key, and provenance for each", () => {
		const keys = plans.map(({ key }) => key).sort();
		expect(new Set(keys).size).toBe(keys.length);
		expect(Object.keys(committedDocuments).sort()).toEqual(keys);
		expect(Object.keys(committedProvenance).sort()).toEqual(keys);
	});
	test("no document carries a hash", () => {
		expect(
			/[0-9a-f]{64}/.test(readFileSync(join(mart, "documents.json"), "utf8")),
		).toBe(false);
	});
	test("the mockup schools come from the frozen mockup", () => {
		const mockupSha256 = sha256Hex(
			readFileSync(
				join(repositoryRoot, "plans/ledger-ui/design/mockup.html"),
				"utf8",
			),
		);
		expect(
			readJson<{ mockupSha256: string }>(
				join(packageRoot, "gates/mockup-schools.json"),
			).mockupSha256,
		).toBe(mockupSha256);
	});
	for (const preset of presets)
		test(`${preset}: the rows are atm's export rows of school-level KPIs`, () => {
			const exported = readExport(preset).rows.filter((row) =>
				namedRow(row.kpiId),
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
	const groups = [
		...new Set(plans.map((entry) => `${entry.school}/${entry.preset ?? ""}`)),
	];
	for (const group of groups)
		test(`${group}: every audience's document equals the oracle now, traces to its sources and follows the disclosure`, () => {
			for (const entry of plans.filter(
				(candidate) =>
					`${candidate.school}/${candidate.preset ?? ""}` === group,
			)) {
				const committed = committedDocuments[entry.key];
				expect({ key: entry.key, document: committed }).toEqual({
					key: entry.key,
					document: entry.build(),
				});
				const recorded = committedProvenance[entry.key];
				expect({ key: entry.key, provenance: recorded }).toEqual({
					key: entry.key,
					provenance: entry.provenance(sha256Hex(canonicalize(committed))),
				});
				if (recorded && "fixtureHash" in recorded) {
					const golden = readJson<KpiExport>(
						join(goldens, `${recorded.preset}.json`),
					);
					expect({
						key: entry.key,
						fixtureHash: recorded.fixtureHash,
						kpisHash: recorded.kpisHash,
					}).toEqual({
						key: entry.key,
						fixtureHash: golden.fixtureHash,
						kpisHash: golden.kpisHash,
					});
				}
				const view =
					disclosure.schools[entry.school]?.views[
						committed?.audience ?? "public"
					];
				expect({
					key: entry.key,
					roundTo: committed?.roundTo,
					cellRules: committed?.cellRules,
					live: committed?.live,
					size: committed?.size,
				}).toEqual({
					key: entry.key,
					roundTo: view?.roundTo,
					cellRules: view?.cellRules,
					live: view?.live,
					size: disclosure.schools[entry.school]?.size,
				});
				if (committed && !committed.live)
					expect({
						key: entry.key,
						periods: committed.periods.map(
							({ period, label, state, title }) => ({
								period,
								label,
								state,
								title,
							}),
						),
					}).toEqual({
						key: entry.key,
						periods: (view?.periods ?? []).map(
							({ period, label, state, title }) => ({
								period,
								label,
								state,
								title,
							}),
						),
					});
			}
		});
	test.if(hasKpiDocument)(
		"the fixture Reader returns exactly the committed documents",
		async () => {
			const reader = fixtureReader();
			for (const entry of plans) {
				const committed = committedDocuments[entry.key];
				if (!committed) continue;
				expect({
					key: entry.key,
					document: await reader?.kpiDocument?.({
						school: entry.school,
						preset: entry.preset ?? "monthly-members",
						audience: committed.audience,
						pinLocked: committed.pinLocked,
					}),
				}).toEqual({ key: entry.key, document: committed });
			}
		},
	);
});

/** The mockup's `kusd`, `kusd0` and `kpct`, and String for counts (kpi-document.ts `KpiFormat`). */
const money = (cents: number, symbol: string, decimals: boolean): string =>
	`${cents < 0 ? "−" : ""}${symbol}${
		decimals
			? (Math.abs(cents) / 100).toLocaleString("en-US", {
					minimumFractionDigits: 2,
					maximumFractionDigits: 2,
				})
			: Math.round(Math.abs(cents) / 100).toLocaleString("en-US")
	}`;
const isMoney = (format: KpiFormat): boolean =>
	format === "money" || format === "money0";
const cellText = (cell: Cell, format: KpiFormat, symbol: string): string => {
	if (typeof cell === "number") {
		if (isMoney(format)) return money(cell, symbol, format === "money");
		if (format === "percent1") return `${(cell * 100).toFixed(1)}%`;
		return String(cell);
	}
	if ("lt" in cell)
		return isMoney(format)
			? `under ${money(cell.lt, symbol, false)}`
			: `<${cell.lt}`;
	if ("approx" in cell) return String(cell.approx);
	return cell.hidden === "suppressed" ? "—" : cell.text;
};
const cellTitle = (cell: Cell): string | null => {
	if (typeof cell === "number") return null;
	if ("hidden" in cell)
		return cell.hidden === "future" ||
			cell.hidden === "locked" ||
			cell.hidden === "not_computed"
			? null
			: cell.text;
	return cell.why ? `Rounded to the nearest 10: ${cell.why}` : null;
};
const grainOfPeriod = (period: string): TableGrain =>
	/^\d{4}$/.test(period)
		? "year"
		: /-Q\d$/.test(period)
			? "quarter"
			: /^\d{4}-\d{2}$/.test(period)
				? "month"
				: "day";
const monthParameter = (document: KpiDocument, period: string): string => {
	const found = document.periods.find((entry) => entry.period === period);
	if (!found) return period;
	return document.grain === "month" ? period : `${found.from}..${found.to}`;
};
const dashboardRoute = (
	document: KpiDocument,
	view: DashboardView,
	period: string,
): string =>
	`#/${document.school}/dashboard?${document.source.kind === "mart" ? `preset=${document.source.preset}&` : ""}as=${document.audience}${document.pinLocked ? "&pin=locked" : ""}&view=${view}&month=${monthParameter(document, period)}`;
/** The KPIs the view must render for the selected period (S1.json `views`); the donor rows only once a donor shows,
 * the funds that have a gift, every day of the month on the live audiences' Money view. */
const requiredKpis = (
	document: KpiDocument,
	view: DashboardView,
	period: string,
): Array<{ selector: string; what: string }> => {
	if (document.empty || document.pinLocked) return [];
	const table = document.tables[grainOfPeriod(period)];
	if (!table) return [];
	const index = table.periods.indexOf(period);
	const donors = table.series.donors_count?.[index];
	const showsDonors = typeof donors === "number" && donors > 0;
	const ids = viewKpis[document.audience][view].flatMap((id) => {
		const listed = id.endsWith(":*")
			? Object.keys(table.series).filter((kpi) =>
					kpi.startsWith(id.slice(0, -1)),
				)
			: id in table.series
				? [id]
				: [];
		return listed.filter((kpi) => {
			if (kpi.startsWith("donors_")) return showsDonors;
			if (kpi.startsWith("donations_by_fund:"))
				return (table.order?.donations_by_fund?.[index] ?? []).includes(kpi);
			return true;
		});
	});
	const cells = ids.map((kpi) => ({
		selector: `[data-kpi="${kpi}"][data-period="${period}"]`,
		what: `${kpi}@${period}`,
	}));
	const days =
		view === "money" && document.live
			? (document.tables.day?.periods ?? [])
					.filter((day) => day.startsWith(`${period}-`))
					.map((day) => ({
						selector: `[data-kpi="gross_collected"][data-day="${day}"]`,
						what: `gross_collected@${day}`,
					}))
			: [];
	return [...cells, ...days];
};
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
const normalize = (text: string | null): string =>
	(text ?? "").replace(/\s+/g, " ").trim();
const checkRender = (
	root: HTMLElement,
	document: KpiDocument,
	view: DashboardView,
	period: string,
	hash: string,
): string[] => {
	const problems: string[] = [];
	const lookup = (table: KpiTable | undefined, kpi: string, at: string) => {
		const index = table?.periods.indexOf(at) ?? -1;
		return index < 0 ? undefined : table?.series[kpi]?.[index];
	};
	for (const element of root.querySelectorAll(
		"[data-kpi][data-period]:not([data-day])",
	)) {
		const kpi = element.getAttribute("data-kpi") ?? "";
		const at = element.getAttribute("data-period") ?? "";
		const cell = lookup(document.tables[grainOfPeriod(at)], kpi, at);
		const meta = document.meta[kpi];
		if (cell === undefined || !meta) {
			problems.push(`${hash}: ${kpi}@${at} is not in the document`);
			continue;
		}
		const expected = {
			cell: cellKind(cell),
			text: cellText(cell, meta.format, document.symbol),
			...(cellTitle(cell) ? { title: cellTitle(cell) } : {}),
		};
		const rendered = {
			cell: element.getAttribute("data-cell"),
			text: normalize(element.textContent),
			...("title" in expected ? { title: element.getAttribute("title") } : {}),
		};
		if (JSON.stringify(expected) !== JSON.stringify(rendered))
			problems.push(
				`${hash}: ${kpi}@${at} rendered ${JSON.stringify(rendered)}, the document has ${JSON.stringify(expected)}`,
			);
	}
	for (const element of root.querySelectorAll("[data-kpi][data-day]")) {
		const kpi = element.getAttribute("data-kpi") ?? "";
		const day = element.getAttribute("data-day") ?? "";
		const cell = lookup(document.tables.day, kpi, day);
		if (cell === undefined) {
			problems.push(`${hash}: ${kpi}@${day} is not in the document`);
			continue;
		}
		const expected = {
			cell: cellKind(cell),
			...(typeof cell === "number" ? { value: String(cell) } : {}),
		};
		const rendered = {
			cell: element.getAttribute("data-cell"),
			...("value" in expected
				? { value: element.getAttribute("data-value") }
				: {}),
		};
		if (JSON.stringify(expected) !== JSON.stringify(rendered))
			problems.push(
				`${hash}: ${kpi}@${day} rendered ${JSON.stringify(rendered)}, the document has ${JSON.stringify(expected)}`,
			);
	}
	for (const { selector, what } of requiredKpis(document, view, period))
		if (!root.querySelector(selector))
			problems.push(`${hash}: ${what} is not rendered`);
	return problems;
};
/** The documents a school's viewer can reach: the audiences of the View as rows they hold (mockup vaAllowed). */
const reachable = (document: KpiDocument): boolean =>
	(disclosure.schools[document.school]?.viewAs ?? []).some(
		(option) => option.value === document.audience && option.held,
	);

/** C4 budget (protocol §5): all mounts and their renders. */
const c4BudgetMilliseconds = 120_000;
let c4Milliseconds = 0;
let c4Renders = 0;
describe("C4: the Dashboard renders every document cell it shows exactly, for every audience a viewer may preview", () => {
	const schools = [...new Set(plans.map((entry) => entry.school))];
	for (const school of schools)
		test.if(hasKpiDocument)(
			school,
			async () => {
				if (!loaded) return;
				const [{ mountApp }, , { createFixtureWriter }] = loaded;
				const started = performance.now();
				const problems: string[] = [];
				for (const entry of plans.filter(
					(candidate) => candidate.school === school,
				)) {
					const expected = committedDocuments[entry.key];
					if (!expected || !reachable(expected)) continue;
					const shown = expected.periods
						.filter((period) => period.state === "shown")
						.map((period) => period.period);
					if (shown.length === 0) continue;
					window.location.hash = dashboardRoute(
						expected,
						"money",
						shown[0] ?? "",
					);
					const root = document.createElement("div");
					root.id = "app";
					document.body.appendChild(root);
					const reader = fixtureReader();
					if (!reader) continue;
					const app = mountApp(root, {
						reader,
						writer: createFixtureWriter({ mode: "instant" }),
						clock,
					});
					try {
						for (const view of dashboardViews)
							for (const period of shown) {
								const hash = dashboardRoute(expected, view, period);
								window.location.hash = hash;
								c4Renders += 1;
								if (!(await settle(root))) {
									problems.push(
										`${hash}: the app reported ${root.dataset.route ?? "no route"}`,
									);
									continue;
								}
								if (
									!window.location.hash.startsWith(
										`#/${expected.school}/dashboard?`,
									)
								) {
									problems.push(
										`${hash}: the app opened ${window.location.hash} instead`,
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
