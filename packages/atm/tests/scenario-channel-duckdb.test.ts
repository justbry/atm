import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import { atmChannel } from "../src/scenario/channels/atm.js";
import {
	duckdbAvailable,
	duckdbChannel,
	writeKpiParquet,
} from "../src/scenario/channels/duckdb.js";
import {
	diffKpis,
	evaluateKpis,
	isBase,
	type KpiChannel,
	type KpiRow,
	periodsFrom,
	SCHOOL_KPIS,
} from "../src/scenario/kpis.js";
import type { AtmEvent } from "../src/types.js";
import { hasDuckdb, tmp } from "./helpers.js";

const fixtures = join(import.meta.dir, "../fixtures");

const schoolsOf = (fixture: string) =>
	readdirSync(join(fixtures, fixture, "schools"));

const cases = [
	...schoolsOf("vibes-year").map((school) => ({
		fixture: "vibes-year",
		school,
	})),
	...schoolsOf("vibes-multi").map((school) => ({
		fixture: "vibes-multi",
		school,
	})),
];

/** Every month from the first event's to the last event's. */
const periodsOf = (events: readonly AtmEvent[]): string[] => {
	const months = events.map((e) => e.date.slice(0, 7)).sort();
	const first = months[0] as string;
	const last = months.at(-1) as string;
	const [fy, fm] = first.split("-").map(Number) as [number, number];
	const [ly, lm] = last.split("-").map(Number) as [number, number];
	return periodsFrom(first, (ly - fy) * 12 + (lm - fm) + 1);
};

const rowsOf = async (
	channel: KpiChannel,
	events: AtmEvent[],
	periods: string[],
): Promise<KpiRow[]> =>
	evaluateKpis({
		spec: SCHOOL_KPIS,
		base: await channel.base({ events, spec: SCHOOL_KPIS, periods }),
		periods,
	});

const baseIds = new Set(SCHOOL_KPIS.kpis.filter(isBase).map((kpi) => kpi.id));

describe.skipIf(!hasDuckdb)("the DuckDB channel", () => {
	for (const { fixture, school } of cases) {
		describe(`${fixture} ${school}`, () => {
			test("every KPI, closing balances included, is identical to the atm channel", async () => {
				const { events } = await readEvents(join(fixtures, fixture), school);
				expect(events.length).toBeGreaterThan(10);
				const periods = periodsOf(events);
				const atm = await rowsOf(atmChannel, events, periods);
				const duck = await rowsOf(duckdbChannel, events, periods);
				expect(
					diffKpis({ name: "atm", rows: atm }, { name: "duckdb", rows: duck }),
				).toEqual([]);
				// something is measured
				expect(
					duck.some((r) => r.kpiId === "gross_collected" && r.value > 0),
				).toBe(true);
				expect(duck.some((r) => r.kpiId === "new_members" && r.value > 0)).toBe(
					true,
				);
				expect(baseIds.size).toBeGreaterThan(10);
			});
		});
	}

	test("the closing balances at the last month are the generator's posting totals", async () => {
		const root = join(fixtures, "vibes-year");
		const { events } = await readEvents(root, "sch_vol");
		const periods = periodsOf(events);
		const rows = await rowsOf(duckdbChannel, events, periods);
		const totals = JSON.parse(
			await Bun.file(join(root, "expected.json")).text(),
		).postingTotals as Record<string, string>;
		const last = periods.at(-1) as string;
		const got = new Map<string, number>();
		for (const r of rows) {
			if (r.period !== last) continue;
			const m = /^closing_balance_(usd|credits):(.+)$/.exec(r.kpiId);
			if (m) got.set(`${m[2]} ${m[1] === "usd" ? "USD" : "*"}`, r.value);
		}
		let checked = 0;
		for (const [key, total] of Object.entries(totals)) {
			const [account, commodity] = key.split(" ") as [string, string];
			const usd = commodity === "USD";
			const value = got.get(`${account} ${usd ? "USD" : "*"}`) ?? 0;
			expect(value).toBe(Math.round(Number(total) * (usd ? 100 : 1)));
			checked++;
		}
		expect(checked).toBeGreaterThan(5);
	});

	test("a window that starts after the first event still sums the earlier postings into a closing balance", async () => {
		const { events } = await readEvents(
			join(fixtures, "vibes-year"),
			"sch_vol",
		);
		const all = periodsOf(events);
		const late = all.slice(all.length - 3);
		const full = await rowsOf(duckdbChannel, events, all);
		const window = await rowsOf(duckdbChannel, events, late);
		const closing = (rows: KpiRow[], period: string) =>
			rows.filter(
				(r) =>
					r.kpiId.startsWith("closing_balance_usd:") && r.period === period,
			);
		const lastPeriod = late.at(-1) as string;
		expect(
			diffKpis(
				{ name: "full", rows: closing(full, lastPeriod) },
				{ name: "window", rows: closing(window, lastPeriod) },
			),
		).toEqual([]);
	});

	test("no events: no values", async () => {
		expect(
			await duckdbChannel.base({
				events: [],
				spec: SCHOOL_KPIS,
				periods: ["2026-01"],
			}),
		).toEqual({});
	});
});

describe.skipIf(!hasDuckdb)("the KPI Parquet file", () => {
	const rows: KpiRow[] = [
		{ kpiId: "refund_rate", period: "2026-02", value: 0.0125, unit: "ratio" },
		{ kpiId: "gross_collected", period: "2026-02", value: 4200, unit: "cents" },
		{ kpiId: "gross_collected", period: "2026-01", value: 1999, unit: "cents" },
		{
			kpiId: "active_members_by_tier:sparkle-2",
			period: "2026-01",
			value: 3,
			unit: "count",
		},
	];

	test("is long format, typed and sorted by KPI then period", async () => {
		const dir = await tmp("parquet");
		try {
			const path = join(dir, "kpis.parquet");
			expect(duckdbAvailable()).toBe(true);
			expect(await writeKpiParquet({ rows, profile: "vibes", path })).toEqual({
				written: true,
			});
			const read = (sql: string) => {
				const run = Bun.spawnSync(["duckdb", "-json", ":memory:", "-c", sql], {
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(run.stderr.toString()).toBe("");
				return JSON.parse(run.stdout.toString()) as Record<string, unknown>[];
			};
			expect(
				read(`DESCRIBE SELECT * FROM read_parquet('${path}')`).map((c) => [
					c.column_name,
					c.column_type,
				]),
			).toEqual([
				["profile", "VARCHAR"],
				["kpi_id", "VARCHAR"],
				["period", "VARCHAR"],
				["value", "DOUBLE"],
				["unit", "VARCHAR"],
			]);
			const back = read(`SELECT * FROM read_parquet('${path}')`);
			const sorted = [...rows].sort((a, b) =>
				a.kpiId !== b.kpiId
					? a.kpiId < b.kpiId
						? -1
						: 1
					: a.period < b.period
						? -1
						: 1,
			);
			expect(back).toEqual(
				sorted.map((r) => ({
					profile: "vibes",
					kpi_id: r.kpiId,
					period: r.period,
					value: r.value,
					unit: r.unit,
				})),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an empty table still has the columns", async () => {
		const dir = await tmp("parquet-empty");
		try {
			const path = join(dir, "kpis.parquet");
			expect(
				(await writeKpiParquet({ rows: [], profile: "p", path })).written,
			).toBe(true);
			const run = Bun.spawnSync(
				[
					"duckdb",
					"-json",
					":memory:",
					"-c",
					`DESCRIBE SELECT * FROM read_parquet('${path}')`,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(
				(JSON.parse(run.stdout.toString()) as { column_name: string }[]).map(
					(c) => c.column_name,
				),
			).toEqual(["profile", "kpi_id", "period", "value", "unit"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
