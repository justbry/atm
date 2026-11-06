import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { canonicalize, sha256Hex } from "../../atm/src/ledger/util.ts";

/**
 * Gate C (protocol §5): one chain from atm's fixtures to the UI's pixels, hashed with atm's own canonicalize and
 * sha256Hex. C1 and C2 need only data and run from S0; C3 and C4 join in S1 with the fixture documents.
 */
type KpiRow = { kpiId: string; period: string; value: number };
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
