/**
 * The contributions view: per KPI cell, distinct holders and the largest holder's share. It must give the cell rules the
 * verdict `suppressKpis` reaches from the per-holder shares (`contributionsFromEvents`), for every cell of the fifteen
 * presets, monthly and quarterly, and it must carry counts and a share only: no holder key.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildContributions,
	type ContributionCell,
	cellPasses,
	SCHOOL_KPI_SPEC,
} from "../src/ledger/contributions.js";
import {
	buildViews,
	readViewsFromStore,
	writeViews,
} from "../src/ledger/views.js";
import { generateScenario } from "../src/scenario/generate.js";
import { periodsFrom, SCHOOL_KPIS } from "../src/scenario/kpis.js";
import { PROFILES, resolveScenario } from "../src/scenario/profiles.js";
import {
	contributionsFromEvents,
	DEFAULT_RULES,
	isExportableKpiId,
	suppressKpis,
} from "../src/scenario/suppress.js";
import { testShares } from "../src/scenario/suppress-core.js";
import { FolderStore } from "../src/store/folder-store.js";
import type { AtmEvent } from "../src/types.js";
import { handBuiltLog, catalog as handCatalog } from "./ledger-read-log.js";

const SHARE_TOLERANCE = 0.0001;

const monthsFrom = (events: readonly AtmEvent[]): string[] => {
	const sorted = [...new Set(events.map((e) => e.date.slice(0, 7)))].sort();
	const first = sorted[0] as string;
	const last = sorted.at(-1) as string;
	const count =
		(Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
		Number(last.slice(5, 7)) -
		Number(first.slice(5, 7)) +
		1;
	return periodsFrom(first, count);
};

describe("the spec the view reads", () => {
	test("is the committed spec the Ajv-checked SCHOOL_KPIS parses", () => {
		expect(SCHOOL_KPI_SPEC).toEqual(SCHOOL_KPIS);
	});
});

describe("cellPasses", () => {
	const rules = DEFAULT_RULES;
	test("needs 5 holders and the largest at or under 60%", () => {
		expect(cellPasses({ holders: 5, largestShare: 0.6 }, rules)).toBe(true);
		expect(cellPasses({ holders: 5, largestShare: 0.600001 }, rules)).toBe(
			false,
		);
		expect(cellPasses({ holders: 4, largestShare: 0.25 }, rules)).toBe(false);
		expect(cellPasses(undefined, rules)).toBe(false);
	});
});

describe("the contributions view equals the cell rules' own verdict over every preset", () => {
	for (const { name } of PROFILES) {
		test(name, async () => {
			const events = generateScenario(
				resolveScenario({ profile: name }),
			).events;
			const periods = monthsFrom(events);
			const source = await contributionsFromEvents({
				events,
				spec: SCHOOL_KPIS,
				periods,
			});
			const view = buildContributions(events);
			expect(Object.keys(view)).toEqual(
				[...new Set(events.map((e) => e.date.slice(0, 7)))].sort(),
			);
			const rowValue = (id: string, period: string) =>
				source.rows.find((r) => r.kpiId === id && r.period === period)?.value ??
				0;
			for (const [month, monthView] of Object.entries(view)) {
				for (const [id, byPeriod] of Object.entries(monthView.contributions)) {
					const cell = byPeriod[month] as ContributionCell;
					expect(Object.keys(byPeriod)).toEqual([month]);
					expect(isExportableKpiId(id)).toBe(true);
					const shares = source.contributions[id]?.[month] ?? {};
					const verdict = testShares({
						shares,
						total: rowValue(id, month),
						rules: DEFAULT_RULES,
						reasons: { few: "few_holders", dominant: "dominant_holder" },
					});
					expect(cell.holders, `${id} ${month} holders`).toBe(
						verdict.contributors,
					);
					expect(
						Math.abs(cell.largestShare - verdict.largestShare),
						`${id} ${month} share`,
					).toBeLessThanOrEqual(SHARE_TOLERANCE);
					expect(cellPasses(cell, DEFAULT_RULES), `${id} ${month} passes`).toBe(
						verdict.reason === null,
					);
				}
				// a cell the source has and the view lacks is an exportable cell with no holder
				for (const [id, byPeriod] of Object.entries(source.contributions))
					if (
						isExportableKpiId(id) &&
						Object.keys(byPeriod[month] ?? {}).length > 0
					)
						expect(
							monthView.contributions[id],
							`${id} ${month} present`,
						).toBeDefined();
			}
		});
	}

	test("the hidden cells suppressKpis reports are the cells the view fails, monthly and quarterly", async () => {
		let hiddenSeen = 0;
		let quarterly = 0;
		for (const { name } of PROFILES) {
			const events = generateScenario(
				resolveScenario({ profile: name }),
			).events;
			const periods = monthsFrom(events);
			const source = await contributionsFromEvents({
				events,
				spec: SCHOOL_KPIS,
				periods,
			});
			const document = suppressKpis({
				spec: SCHOOL_KPIS,
				rows: source.rows,
				contributions: source.contributions,
				activePayers: source.activePayers,
			});
			const view = buildContributions(events);
			const holderReasons = new Set(["few_holders", "dominant_holder"]);
			if (document.grain === "quarter") quarterly += 1;
			for (const hidden of document.hiddenCells) {
				if (!holderReasons.has(hidden.reason)) continue;
				hiddenSeen += 1;
				const cells =
					document.grain === "quarter"
						? Object.values(view).find(
								(v) => v.quarter?.period === hidden.period,
							)?.quarter?.contributions
						: view[hidden.period]?.contributions;
				const cell = cells?.[hidden.kpiId]?.[hidden.period];
				expect(
					cellPasses(cell, DEFAULT_RULES),
					`${name} ${hidden.kpiId} ${hidden.period}`,
				).toBe(false);
				expect(
					cell?.holders ?? 0,
					`${name} ${hidden.kpiId} ${hidden.period}`,
				).toBe(hidden.contributors ?? 0);
				if (cell !== undefined && hidden.largestShare !== null)
					expect(
						Math.abs(cell.largestShare - hidden.largestShare),
					).toBeLessThanOrEqual(SHARE_TOLERANCE);
			}
		}
		expect(hiddenSeen).toBeGreaterThan(0);
		expect(quarterly).toBeGreaterThan(0);
	});
});

describe("what the view carries", () => {
	test("counts and a share only: no holder key, no name, no amount field", () => {
		const events = generateScenario(
			resolveScenario({ profile: "growth-12mo" }),
		).events;
		const text = JSON.stringify(buildContributions(events));
		for (const event of events.slice(0, 200)) {
			expect(text).not.toContain(event.key);
			expect(text).not.toContain("profile:");
		}
		expect(text).not.toContain("family:");
		for (const view of Object.values(buildContributions(events)))
			for (const cell of Object.values(view.contributions).flatMap((byPeriod) =>
				Object.values(byPeriod),
			))
				expect(Object.keys(cell).sort()).toEqual(["holders", "largestShare"]);
	});

	test("one holder is one holder and the whole cell", () => {
		const events = handBuiltLog().events;
		const view = buildContributions(events);
		for (const monthView of Object.values(view))
			for (const cell of Object.values(monthView.contributions).flatMap(
				(byPeriod) => Object.values(byPeriod),
			)) {
				expect(cell.holders).toBe(1);
				expect(cell.largestShare).toBe(1);
			}
	});

	test("quarter cells are on the quarter's last month and the log's last month", () => {
		const events = generateScenario(
			resolveScenario({ profile: "growth-12mo" }),
		).events;
		const view = buildContributions(events);
		const months = Object.keys(view);
		for (const month of months) {
			const expected =
				Number(month.slice(5, 7)) % 3 === 0 || month === months.at(-1);
			expect(view[month]?.quarter !== undefined, month).toBe(expected);
		}
	});

	test("the objects are written, listed in the manifest and read back verified", async () => {
		const { events } = handBuiltLog();
		const built = buildViews(events, {
			school: "sch_hand",
			asOf: new Date("2026-03-01T00:00:00Z"),
			catalog: handCatalog,
		});
		if (!built.ok) throw new Error(JSON.stringify(built.error));
		const root = await mkdtemp(join(tmpdir(), "atm-contrib-"));
		try {
			const store = new FolderStore({ root });
			await writeViews(store, "sch_hand", built.views);
			const reader = await readViewsFromStore(store, "sch_hand");
			if (!reader.ok) throw new Error(JSON.stringify(reader));
			const month = Object.keys(built.views.contributions)[0] as string;
			const read = await reader.contributions(month);
			if (!read.ok) throw new Error(JSON.stringify(read));
			expect(read.value).toEqual({
				school: "sch_hand",
				month,
				...built.views.contributions[month],
			});
			expect(
				Object.keys(reader.manifest.objects).filter((key) =>
					key.includes("/views/kpi/contributions/"),
				),
			).toEqual([`schools/sch_hand/views/kpi/contributions/${month}.json`]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
