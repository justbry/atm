/** `atm scenarios ...` and `atm simulate --profile ...` as a caller runs them: exit codes, JSON, errors an agent can act on. */
import { afterAll, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "../src/ledger/util.js";
import { hasDuckdb, tmp } from "./helpers.js";

const BIN = join(import.meta.dir, "../src/bin.ts");
const atm = (args: string[], stdin?: string) => {
	const run = Bun.spawnSync([process.execPath, BIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
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

describe("atm scenarios", () => {
	test("list names every preset", () => {
		const run = atm(["scenarios", "list", "--json"]);
		expect(run.code).toBe(0);
		const names = (
			JSON.parse(run.out) as { profiles: { name: string }[] }
		).profiles.map((p) => p.name);
		expect(names).toContain("heavy-refunds");
		expect(names.length).toBeGreaterThanOrEqual(8);
	});

	test("describe shows the knobs that differ and copy-paste commands; `scenario` is an alias", () => {
		const run = atm(["scenario", "describe", "heavy-refunds"]);
		expect(run.code).toBe(0);
		expect(run.out).toContain("* refundRate = 0.2");
		expect(run.out).toContain("atm simulate --profile heavy-refunds");
	});

	test("describe of an unknown preset exits 2 and suggests the list", () => {
		const run = atm(["scenarios", "describe", "heavy-refund"]);
		expect(run.code).toBe(2);
		expect(run.err).toContain("presets:");
	});

	test("schema prints a JSON Schema of the ad-hoc input", () => {
		const schema = JSON.parse(atm(["scenarios", "schema"]).out) as {
			properties: { params: { properties: Record<string, unknown> } };
		};
		expect(Object.keys(schema.properties.params.properties)).toContain(
			"refundRate",
		);
	});
});

describe("atm simulate --profile", () => {
	test("runs a preset with --set and --seed and prints one JSON document", () => {
		const run = atm([
			"simulate",
			"--profile",
			"heavy-refunds",
			"--set",
			"refundRate=0.2",
			"--seed",
			"7",
			"--json",
		]);
		expect(run.code).toBe(0);
		const doc = JSON.parse(run.out) as {
			ok: boolean;
			seed: number;
			params: { refundRate: number };
			fixtureHash: string;
			kpisHash: string;
			parity: { equal: boolean; channels: { name: string }[] };
		};
		expect(doc.ok).toBe(true);
		expect(doc.seed).toBe(7);
		expect(doc.params.refundRate).toBe(0.2);
		expect(doc.fixtureHash).toMatch(/^[0-9a-f]{64}$/);
		expect(doc.parity.equal).toBe(true);
		expect(doc.parity.channels.map((c) => c.name)).toEqual([
			"atm",
			"hledger",
			"duckdb",
		]);
		// the same call twice gives the same hashes
		const again = JSON.parse(
			atm([
				"simulate",
				"--profile",
				"heavy-refunds",
				"--set",
				"refundRate=0.2",
				"--seed",
				"7",
				"--json",
			]).out,
		);
		expect(again.fixtureHash).toBe(doc.fixtureHash);
		expect(again.kpisHash).toBe(doc.kpisHash);
	}, 60_000);

	test("an ad-hoc scenario from stdin", () => {
		const run = atm(
			["simulate", "--scenario", "-", "--channels", "atm", "--json"],
			JSON.stringify({ name: "tiny", params: { members: 3, months: 2 } }),
		);
		expect(run.code).toBe(0);
		expect(JSON.parse(run.out).name).toBe("tiny");
	});

	test("a bad knob exits 2 with a line that names the fix, and --json carries it too", () => {
		const run = atm([
			"simulate",
			"--profile",
			"heavy-refunds",
			"--set",
			"refundrate=0.2",
			"--json",
		]);
		expect(run.code).toBe(2);
		expect(run.err).toContain('Did you mean "refundRate"?');
		expect(JSON.parse(run.out)).toMatchObject({ ok: false });
	});

	test("the log mode still needs --root and --school, and the two modes do not mix", () => {
		expect(atm(["simulate"]).err).toContain("--profile");
		expect(atm(["simulate", "--profile", "disputes", "--root", "."]).code).toBe(
			2,
		);
	});

	test("--channels rejects a name it does not know", () => {
		const run = atm([
			"simulate",
			"--profile",
			"disputes",
			"--channels",
			"atm,sqlite",
		]);
		expect(run.code).toBe(2);
		expect(run.err).toContain("sqlite");
	});
});

describe("atm scenario kpis", () => {
	test("writes kpis.json whose hash can be checked, and kpis.parquet when DuckDB is installed", async () => {
		const out = await tmp("kpis-export");
		dirs.push(out);
		const run = atm([
			"scenario",
			"kpis",
			"--profile",
			"free-only",
			"--out",
			out,
			"--json",
		]);
		expect(run.code).toBe(0);
		const doc = JSON.parse(
			await readFile(join(out, "free-only", "kpis.json"), "utf8"),
		) as {
			profile: string;
			kpisHash: string;
			fixtureHash: string;
			rows: { kpiId: string; period: string; value: number; unit: string }[];
		};
		expect(doc.profile).toBe("free-only");
		expect(doc.rows.length).toBeGreaterThan(100);
		const recomputed = sha256Hex(
			canonicalize(
				doc.rows.map(({ kpiId, period, value }) => ({ kpiId, period, value })),
			),
		);
		expect(recomputed).toBe(doc.kpisHash);
		expect(JSON.parse(run.out).kpisHash).toBe(doc.kpisHash);
		if (hasDuckdb) {
			const parquet = join(out, "free-only", "kpis.parquet");
			expect(await Bun.file(parquet).exists()).toBe(true);
			const read = Bun.spawnSync(
				[
					"duckdb",
					":memory:",
					"-json",
					"-c",
					`SELECT profile, kpi_id, period, value, unit FROM read_parquet('${parquet}') ORDER BY kpi_id, period LIMIT 1`,
				],
				{ stdout: "pipe" },
			);
			const row = (
				JSON.parse(read.stdout.toString()) as Record<string, unknown>[]
			)[0];
			expect(row?.profile).toBe("free-only");
			expect(Object.keys(row ?? {})).toEqual([
				"profile",
				"kpi_id",
				"period",
				"value",
				"unit",
			]);
		}
	}, 60_000);
});
