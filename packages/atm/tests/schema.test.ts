import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateYear } from "../fixtures/vibes.js";
import { writeFixture } from "../fixtures/write.js";
import envelope from "../schema/envelope.v1.json";
import { duckdbDdl } from "../src/ledger/duckdb.js";
import { payloadSchemas } from "../src/ledger/schemas.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent } from "../src/types.js";
import { hasDuckdb, tmp } from "./helpers.js";

const schemaDir = join(import.meta.dir, "../schema");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const events = generateYear({ seed: 1 }).events;
const first = (type: string) =>
	events.find((e) => e.event_type === type) as AtmEvent;

describe("schema files", () => {
	test("the DuckDB DDL regenerated from envelope.v1.json is the committed file", () => {
		expect(duckdbDdl(envelope)).toBe(
			readFileSync(join(schemaDir, "duckdb/envelope.v1.sql"), "utf8"),
		);
	});

	test("there is one payload schema per event type, and the library carries them all", () => {
		const types = (envelope.properties.event_type as { enum: string[] }).enum;
		const files = readdirSync(join(schemaDir, "payload"))
			.map((f) => f.replace(".v1.json", ""))
			.sort();
		expect(files).toEqual([...types].sort());
		expect(Object.keys(payloadSchemas).sort()).toEqual(files);
	});

	test("the DDL maps the spec's types", () => {
		const sql = duckdbDdl(envelope);
		expect(sql).toContain("event_time TIMESTAMPTZ NOT NULL");
		expect(sql).toContain("date DATE NOT NULL");
		expect(sql).toContain("labels MAP(VARCHAR, VARCHAR) NOT NULL");
		expect(sql).toContain(
			"postings STRUCT(account VARCHAR, amount DECIMAL(18,2), commodity VARCHAR)[] NOT NULL",
		);
		expect(sql).toContain("payload JSON NOT NULL");
		expect(sql).toContain("redacted JSON\n");
	});
});

describe("validateEvent", () => {
	test("every event of several seeds' years validates", () => {
		for (const seed of [1, 2, 3, 99]) {
			for (const e of generateYear({ seed }).events) {
				const r = validateEvent(e);
				expect(r.errors, `${e.event_type} ${e.id}`).toEqual([]);
			}
		}
	});

	const broken: [string, (e: AtmEvent) => unknown, string?][] = [
		[
			"a missing required field",
			(e) => {
				const { tz: _tz, ...rest } = e;
				return rest;
			},
			"tz",
		],
		["an unknown envelope field", (e) => ({ ...e, extra: 1 }), "extra"],
		["version 2", (e) => ({ ...e, v: 2 })],
		["a lower-case id", (e) => ({ ...e, id: e.id.toLowerCase() }), "/id"],
		[
			"an event_time without Z",
			(e) => ({ ...e, event_time: "2026-01-01T00:00:00" }),
			"/event_time",
		],
		[
			"a date that is not a date",
			(e) => ({ ...e, date: "2026-13-45" }),
			"/date",
		],
		[
			"an unknown event type",
			(e) => ({ ...e, event_type: "credit.minted" }),
			"/event_type",
		],
		[
			"a float amount",
			(e) => ({
				...e,
				postings: e.postings.map((p, i) =>
					i === 0 ? { ...p, amount: 1.5 } : p,
				),
			}),
			"/postings/0/amount",
		],
		[
			"a label that is not a string",
			(e) => ({ ...e, labels: { ...e.labels, n: 1 } }),
			"/labels",
		],
		[
			"a payload that is not an object",
			(e) => ({ ...e, payload: "x" }),
			"/payload",
		],
	];
	for (const [name, mutate, path] of broken) {
		test(`refuses ${name}`, () => {
			const r = validateEvent(mutate(clone(first("credit.held"))));
			expect(r.ok).toBe(false);
			if (path) expect(JSON.stringify(r.errors)).toContain(path);
		});
	}

	test("refuses postings that do not sum to zero", () => {
		const e = clone(first("credit.held"));
		(e.postings[0] as { amount: string }).amount = "-2";
		const r = validateEvent(e);
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r.errors)).toContain("not zero");
	});

	test("refuses a single posting", () => {
		const e = clone(first("credit.held"));
		e.postings = [e.postings[0] as never];
		expect(JSON.stringify(validateEvent(e).errors)).toContain(
			"none or at least two",
		);
	});

	test("refuses the wrong number of decimal places", () => {
		const e = clone(first("payment.succeeded"));
		(e.postings[0] as { amount: string }).amount = "252.1";
		expect(validateEvent(e).ok).toBe(false);
		const c = clone(first("credit.held"));
		c.postings = c.postings.map((p) => ({
			...p,
			amount: p.amount.startsWith("-") ? "-1.00" : "1.00",
		}));
		expect(validateEvent(c).ok).toBe(false);
	});

	test("refuses a payload that breaks its event type's schema", () => {
		const e = clone(first("credit.adjusted"));
		delete (e.payload as { reason?: string }).reason;
		const r = validateEvent(e);
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r.errors)).toContain("/payload");
		const p = clone(first("payment.succeeded"));
		(p.payload as { fee: unknown }).fee = "7.84";
		expect(validateEvent(p).ok).toBe(false);
	});

	test("refuses an id whose time is not the event time, and a date not in the zone", () => {
		const e = clone(first("credit.held"));
		e.event_time = "2026-01-01T00:00:00Z";
		const r = validateEvent(e);
		expect(JSON.stringify(r.errors)).toContain("/id");
		const d = clone(first("credit.held"));
		d.date = "2001-01-01";
		expect(JSON.stringify(validateEvent(d).errors)).toContain("/date");
	});
});

describe.skipIf(!hasDuckdb)("the DDL in DuckDB", () => {
	test("loads the fixture and its postings sum to the generator's totals", async () => {
		const dir = await tmp("duck");
		await writeFixture({ seed: 1, outDir: dir });
		const sql = [
			readFileSync(join(schemaDir, "duckdb/envelope.v1.sql"), "utf8"),
			`INSERT INTO events BY NAME SELECT * FROM read_json('${dir}/schools/sch_vol/events/*/*.jsonl', format='newline_delimited', union_by_name=true);`,
			"COPY (SELECT account, commodity, sum(amount) AS amount FROM ledger_postings GROUP BY ALL ORDER BY ALL) TO '/dev/stdout' (FORMAT csv, HEADER false);",
		].join("\n");
		const run = Bun.spawnSync(["duckdb", ":memory:", "-c", sql], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.stderr.toString()).toBe("");
		const got: Record<string, number> = {};
		for (const line of run.stdout.toString().trim().split("\n")) {
			const [account, commodity, amount] = line.split(",");
			got[`${account} ${commodity}`] = Number(amount);
		}
		const expected = JSON.parse(
			readFileSync(join(dir, "expected.json"), "utf8"),
		).postingTotals as Record<string, string>;
		for (const [k, v] of Object.entries(expected))
			expect(got[k] ?? 0).toBeCloseTo(Number(v), 2);
		expect(Object.keys(got).length).toBe(Object.keys(expected).length);
	});
});
