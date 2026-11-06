/** The hash checkpoints: canonical form, volatile fields, the KPI hash they share with parity, and `atm scenario check`. */
import { afterAll, describe, expect, test } from "bun:test";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	canonicalDeliveries,
	canonicalJournal,
	canonicalKpis,
	canonicalLedgerTree,
	canonicalMutations,
	canonicalOutbox,
	canonicalReconcile,
	canonicalReports,
} from "../src/ledger/checkpoints.js";
import { canonicalize, sha256Hex } from "../src/ledger/util.js";
import {
	loadScenarioBundle,
	loadScenarioBundles,
} from "../src/scenario/bundle.js";
import { textDiff } from "../src/scenario/bundle-check.js";
import { type KpiRow, kpiHash } from "../src/scenario/kpis.js";
import { tmp } from "./helpers.js";

const BIN = join(import.meta.dir, "../src/bin.ts");
const BUNDLES = join(import.meta.dir, "../fixtures/scenarios");
const atm = (args: string[]) => {
	const run = Bun.spawnSync([process.execPath, BIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: run.exitCode,
		out: run.stdout.toString(),
		err: run.stderr.toString(),
	};
};

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("canonical form", () => {
	test("keys are sorted, so the order a producer wrote them in does not matter", () => {
		const a = canonicalOutbox({
			s: [{ id: "1", idem: "x", date: "2026-01-01", body: '{"b":1,"a":2}' }],
		});
		const b = canonicalOutbox({
			s: [{ id: "1", idem: "x", date: "2026-01-01", body: '{"a":2,"b":1}' }],
		});
		expect(a.hash).toBe(b.hash);
	});

	test("an instant is written as ISO UTC", () => {
		const { canonical } = canonicalDeliveries([
			{ atMs: Date.parse("2026-01-15T18:00:00Z"), event: {} },
		]);
		expect(canonical).toContain('"at":"2026-01-15T18:00:00Z"');
		expect(canonical).not.toContain("atMs");
	});

	test("volatile fields never reach the text, so two runs at other times agree", () => {
		const row = (shipped: number, worker: string) =>
			canonicalMutations({
				s: {
					answers: [[200, "applied"]],
					decisions: [
						{
							event_id: "evt_1",
							received_at: shipped,
							claimed_by: worker,
							shipped_at: shipped,
						},
					],
					mutations: [{ shippedAt: shipped, runId: worker, table_name: "t" }],
				},
			});
		expect(row(1, "a").hash).toBe(row(2, "b").hash);
		expect(row(1, "a").canonical).not.toContain("shipped");
	});

	test("money is whole minor units: a fraction is refused, a ratio KPI may have one", () => {
		expect(() =>
			canonicalReports({ atm: { gross: { "2026-01": 12.5 } } }),
		).toThrow("whole minor units");
		expect(() =>
			canonicalKpis({
				atm: [{ kpiId: "refund_rate", period: "2026-01", value: 0.05 }],
			}),
		).not.toThrow();
	});

	test("the log lines of a day are read in id order, whatever order the batch holds them", () => {
		const line = (id: string) => JSON.stringify({ id, idem: id });
		const forward = canonicalLedgerTree({
			s: {
				"events/date=2026-01-01/batch-a.jsonl": `${line("1")}\n${line("2")}\n`,
			},
		});
		const backward = canonicalLedgerTree({
			s: {
				"events/date=2026-01-01/batch-a.jsonl": `${line("2")}\n${line("1")}\n`,
			},
		});
		expect(forward.hash).toBe(backward.hash);
	});

	test("H4 holds the event files and H5 everything else", () => {
		const tree = {
			"events/date=2026-01-01/day.jsonl": '{"id":"1"}\n',
			"main.journal": "include x\n",
			"ledger/build.json": '{"b":1,"a":2}',
		};
		expect(canonicalLedgerTree({ s: tree }).canonical).not.toContain(
			"main.journal",
		);
		const journal = canonicalJournal({ s: tree }).canonical;
		expect(journal).toContain("main.journal");
		expect(journal).not.toContain("day.jsonl");
		expect(journal).toContain('{"a":2,"b":1}');
	});

	test("H7 is the text kpiHash hashes, so a channel's checkpoint equals the parity hash", () => {
		const rows: KpiRow[] = [
			{ kpiId: "b", period: "2026-01", value: 3, unit: "count" },
			{ kpiId: "a", period: "2026-02", value: 5, unit: "cents" },
			{ kpiId: "a", period: "2026-01", value: 7, unit: "cents" },
		];
		expect(canonicalKpis({ atm: rows }).atm?.hash).toBe(kpiHash(rows));
		expect(canonicalKpis({ atm: rows }).atm?.hash).toBe(
			sha256Hex(
				canonicalize(
					[...rows]
						.sort((x, y) => (x.kpiId + x.period < y.kpiId + y.period ? -1 : 1))
						.map(({ kpiId, period, value }) => ({ kpiId, period, value })),
				),
			),
		);
	});

	test("the reconcile verdict says clean or lists the differences", () => {
		const clean = { differences: [], counts: {}, ignored: {}, skipped: {} };
		const dirty = {
			...clean,
			differences: [
				{
					kind: "amount_differs",
					object: "invoice",
					id: "in_1",
					period: "2026-01",
					stripe: 1,
					log: 2,
				},
			],
		};
		expect(canonicalReconcile({ s: { "2026-01": clean } }).canonical).toContain(
			'"clean":true',
		);
		expect(canonicalReconcile({ s: { "2026-01": dirty } }).canonical).toContain(
			'"clean":false',
		);
	});
});

describe("the committed bundles", () => {
	test("each has the five files and a golden for every stage", async () => {
		const bundles = await loadScenarioBundles();
		expect(bundles.length).toBeGreaterThanOrEqual(39);
		for (const bundle of bundles) {
			for (const stage of [
				"H1",
				"H2",
				"H3",
				"H4",
				"H5",
				"H6",
				"H7",
				"H8",
			] as const)
				expect(bundle.hashes[stage], `${bundle.id} ${stage}`).toBeDefined();
			expect(bundle.steps.length, bundle.id).toBeGreaterThan(0);
		}
	});

	test("a delivery of a bundle is a whole Stripe event with its clock", async () => {
		const bundle = await loadScenarioBundle(join(BUNDLES, "renewal"));
		for (const step of bundle.steps)
			if (step.kind === undefined) {
				expect(step.atMs).toBeGreaterThan(0);
				expect(step.event.type).toBeString();
			}
	});
});

describe("textDiff", () => {
	test("shows the first differing region with context", () => {
		const diff = textDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
		expect(diff).toContain("- c");
		expect(diff).toContain("+ X");
		expect(diff).toContain("@@ line 3 @@");
	});
});

describe("atm scenario check", () => {
	test("a bundle that matches exits 0 and prints the table", () => {
		const run = atm(["scenario", "check", "create"]);
		expect(run.code).toBe(0);
		expect(run.out).toContain("stage");
		expect(run.out).toContain("H8 reconcile");
	});

	test("a changed delivery fails at H1 and prints the diff of that stage", async () => {
		const copy = await tmp("bundle-check");
		dirs.push(copy);
		await cp(join(BUNDLES, "create"), copy, { recursive: true });
		// the stage snapshots are not committed: write them from the unchanged bundle, then change a delivery
		expect(atm(["scenario", "check", copy, "--snapshots"]).code).toBe(0);
		const path = join(copy, "deliveries.jsonl");
		const text = await readFile(path, "utf8");
		await writeFile(path, text.replace('"atMs":', '"atMs":1'));
		const run = atm(["scenario", "check", copy]);
		expect(run.code).toBe(1);
		expect(run.out).toMatch(/H1 deliveries\s+\w+\s+\w+\s+mismatch/);
		expect(run.out).toContain("H1 (deliveries) differs");
		expect(run.out).toContain("- ");
	});

	test("a mismatch with no snapshot says how to get one, and --snapshots refuses a run that does not match", async () => {
		const copy = await tmp("bundle-check");
		dirs.push(copy);
		await cp(join(BUNDLES, "create"), copy, { recursive: true });
		await rm(join(copy, "stages"), { recursive: true, force: true });
		const path = join(copy, "deliveries.jsonl");
		await writeFile(
			path,
			(await readFile(path, "utf8")).replace('"atMs":', '"atMs":1'),
		);
		const run = atm(["scenario", "check", copy]);
		expect(run.code).toBe(1);
		expect(run.out).toContain("--snapshots");
		const refused = atm(["scenario", "check", copy, "--snapshots"]);
		expect(refused.code).not.toBe(0);
	});

	test("an unknown bundle exits 2", () => {
		expect(atm(["scenario", "check", "no-such-bundle"]).code).toBe(2);
	});
});
