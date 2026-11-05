/**
 * Feasibility spike: can the ledger's log (outbox, shipper, folder store, DuckDB) carry `usage.recorded` events,
 * aggregate and rate them, dedupe, handle late events and re-rate from the raw events, and describe its own Parquet?
 * Small data on purpose (a few thousand events, a few seconds). The numbers at 100k to 10M events are in the spike
 * report; the generator and the SQL here are what produced them.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { bunSqlite } from "../../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../../src/handler/schema.js";
import { listEventFiles, readEvents } from "../../src/ledger/files.js";
import { ulidTime } from "../../src/ledger/ids.js";
import { buildJournal } from "../../src/ledger/journal.js";
import { appendToOutbox } from "../../src/ledger/outbox.js";
import { ledgerEvent } from "../../src/ledger/postings.js";
import { shipOutbox } from "../../src/ledger/ship.js";
import { canonicalize } from "../../src/ledger/util.js";
import { validateEvent } from "../../src/ledger/validate.js";
import { FolderStore } from "../../src/store/folder-store.js";
import { putOnce, utf8 } from "../../src/store/store.js";
import type { AtmEvent } from "../../src/types.js";
import { hasDuckdb, tmp } from "../helpers.js";
import { type GeneratedUsage, generateUsage } from "./usage-events.js";
import {
	buildUsageManifest,
	manifestKey,
	usageReadSql,
} from "./usage-manifest.js";
import {
	createPricesSql,
	dailyRollupSql,
	dedupeSql,
	invoiceLinesSql,
	rawEventsSql,
	V1_PAYLOAD,
	V2_PAYLOAD,
} from "./usage-sql.js";

const SCHOOL = "sch_acme";
const HOLDERS = 40;
const EVENTS_PER_MONTH = 2500;
const INVOICE_TIME = "2026-10-02 00:00:00+00";
const PICO_PER_CENT = 10_000_000_000n;
const HALF_CENT = 5_000_000_000n;

const month = (
	name: string,
	seed: number,
	extra: { schemaVersion?: 1 | 2 } = {},
) => [
	...generateUsage({
		events: EVENTS_PER_MONTH,
		holders: HOLDERS,
		month: name,
		seed,
		lateRate: 0.05,
		duplicateRate: 0.02,
		...extra,
	}),
];
const september = month("2026-09", 2);
const october = month("2026-10", 1);
const all: GeneratedUsage[] = [...september, ...october];

const PRICE_ROWS = [
	["xl-2", 15_000_000, 75_000_000],
	["lg-2", 3_000_000, 15_000_000],
	["md-2", 1_000_000, 5_000_000],
	["sm-2", 250_000, 1_250_000],
	["embed-2", 100_000, 0],
] as const;
const prices = (
	overrides: { smOutput?: number; mdInputFromMid?: number } = {},
) =>
	createPricesSql([
		...PRICE_ROWS.flatMap(([model, input, output]) => [
			{
				model,
				direction: "input" as const,
				microUsdPerMillion: input,
				validFrom: "2026-01-01",
			},
			{
				model,
				direction: "output" as const,
				microUsdPerMillion:
					model === "sm-2" ? (overrides.smOutput ?? output) : output,
				validFrom: "2026-01-01",
			},
		]),
		...(overrides.mdInputFromMid === undefined
			? []
			: [
					{
						model: "md-2",
						direction: "input" as const,
						microUsdPerMillion: overrides.mdInputFromMid,
						validFrom: "2026-10-16",
					},
				]),
	]);

/** Runs SQL in the `duckdb` CLI and returns the last statement's rows (HUGEINT and DECIMAL come back as numbers or strings). */
const duck = async (
	sql: string,
	cwd?: string,
): Promise<Record<string, unknown>[]> => {
	const result = Bun.spawnSync(
		["duckdb", "-json", "-c", `SET TimeZone='UTC'; ${sql}`],
		{
			stdout: "pipe",
			stderr: "pipe",
			cwd,
		},
	);
	if (result.exitCode !== 0)
		throw new Error(
			`duckdb failed: ${result.stderr.toString()}\n${sql.slice(0, 400)}`,
		);
	const text = result.stdout.toString().trim();
	return text ? (JSON.parse(text) as Record<string, unknown>[]) : [];
};

const outboxOf = (events: readonly GeneratedUsage[]) => {
	const db = bunSqlite(new Database(":memory:"));
	db.exec(HANDLER_DDL);
	const parsed = events.map((e) => JSON.parse(e.line) as AtmEvent);
	const inserted = db.transaction(() => appendToOutbox(db, parsed));
	return { db, inserted };
};

/** Ships every event through the real outbox and shipper into a fresh folder; returns the folder. */
const shipped = async (events: readonly GeneratedUsage[]) => {
	const root = await tmp("usage");
	const { db, inserted } = outboxOf(events);
	const result = await shipOutbox({
		db,
		store: new FolderStore({ root }),
		school: SCHOOL,
		nowMs: () => 1_700_000_000_000,
	});
	return { root, inserted, result, db };
};

/** The first copy of each idem, in stream order: the one the outbox keeps. */
const distinct = (events: readonly GeneratedUsage[]) => {
	const seen = new Map<string, GeneratedUsage>();
	for (const e of events) if (!seen.has(e.idem)) seen.set(e.idem, e);
	return [...seen.values()];
};

/** Tokens in cents with the same rule as the SQL, in BigInt: sum per line, one rounding per line, half away from zero. */
const centsOf = (pico: bigint) =>
	(pico < 0n ? -1n : 1n) *
	(((pico < 0n ? -pico : pico) + HALF_CENT) / PICO_PER_CENT);

describe("generator", () => {
	test("lines are the outbox's canonical bytes and carry the envelope's own rules", () => {
		const sample = october.slice(0, 300);
		for (const e of sample) {
			const event = JSON.parse(e.line) as AtmEvent;
			expect(e.line).toBe(canonicalize(event));
			expect(ulidTime(event.id)).toBe(Date.parse(event.event_time));
			expect(event.date).toBe(event.event_time.slice(0, 10));
			expect(event.postings).toEqual([]);
			expect(Object.keys(event.labels).sort()).toEqual([
				"feature",
				"model",
				"region",
			]);
		}
		expect(october.filter((e) => e.duplicate).length).toBeGreaterThan(0);
		const late = october.filter((e) => e.late);
		expect(late.length).toBeGreaterThan(0);
		for (const e of late)
			expect(e.ingestMs - e.eventMs).toBeGreaterThanOrEqual(86_400_000);
		// heavy tail: the biggest holder carries far more than an even share
		const counts = new Map<string, number>();
		for (const e of distinct(october))
			counts.set(e.holder, (counts.get(e.holder) ?? 0) + 1);
		expect(Math.max(...counts.values())).toBeGreaterThan(
			(3 * EVENTS_PER_MONTH) / HOLDERS,
		);
	});
});

describe("fit with the existing code", () => {
	test("the envelope's event_type enum and the postings builders refuse usage.recorded", () => {
		const event = JSON.parse((october[0] as GeneratedUsage).line) as AtmEvent;
		const verdict = validateEvent(event);
		expect(verdict.ok).toBe(false);
		expect(verdict.errors.map((error) => error.path)).toEqual(["/event_type"]);
		expect(() =>
			ledgerEvent({
				type: "usage.recorded" as never,
				school: SCHOOL,
				tz: "UTC",
				eventTime: Date.now(),
				key: "cus_x",
				idem: "req_x",
			}),
		).toThrow(/engine event/);
	});

	test("books: postings-free usage events add no transaction to the journal", () => {
		const events = october
			.slice(0, 50)
			.map((e) => JSON.parse(e.line) as AtmEvent);
		expect(buildJournal({ events, month: "2026-10" }).transactions).toBe(0);
	});

	test("outbox, shipper and folder store take the events as they are; the reader drops duplicates by idem", async () => {
		const { root, inserted, result } = await shipped(all);
		const unique = distinct(all);
		expect(inserted).toBe(unique.length);
		expect(result.conflicts).toEqual([]);
		expect(result.shipped).toBe(unique.length);
		// one object per event date, create-only keys from the first id and the content hash
		const dates = new Set(unique.map((e) => e.eventDate));
		expect(result.batches.length).toBe(dates.size);
		const files = await listEventFiles(root, SCHOOL);
		expect(
			files.every((file) =>
				/^events\/date=\d{4}-\d{2}-\d{2}\/batch-[0-9A-Z]{26}-[0-9a-f]{16}\.jsonl$/.test(
					file,
				),
			),
		).toBe(true);
		const read = await readEvents(root, SCHOOL);
		expect(read.events.length).toBe(unique.length);
		const lineOf = new Map(unique.map((e) => [e.idem, e.line]));
		for (const event of read.events.slice(0, 200))
			expect(canonicalize(event)).toBe(lineOf.get(event.idem) ?? "");
	});

	test("shipping twice writes nothing new", async () => {
		const { root, db } = await shipped(october);
		const before = await listEventFiles(root, SCHOOL);
		const again = await shipOutbox({
			db,
			store: new FolderStore({ root }),
			school: SCHOOL,
			nowMs: () => 1,
		});
		expect(again.shipped).toBe(0);
		expect(await listEventFiles(root, SCHOOL)).toEqual(before);
	});
});

describe.skipIf(!hasDuckdb)("DuckDB over the shipped folder", () => {
	const events = (root: string) =>
		rawEventsSql({
			glob: join(root, "schools", SCHOOL, "events", "*", "batch-*.jsonl"),
			schema: "explicit",
		});

	test("dedupe by idem, aggregate, and match the generator's own totals", async () => {
		const { root } = await shipped(all);
		const unique = distinct(all);
		const [counts] = await duck(
			`SELECT count(*)::BIGINT AS raw_rows, count(DISTINCT idem)::BIGINT AS idems, (SELECT count(*) FROM (${dedupeSql(events(root))}))::BIGINT AS deduped FROM ${events(root)}`,
		);
		// the outbox already refused repeats by (school, idem), so the files hold each idem once; the SQL dedupe is for re-sends the outbox never saw
		expect(counts).toEqual({
			raw_rows: unique.length,
			idems: unique.length,
			deduped: unique.length,
		});
		const truth = new Map<string, number>();
		for (const e of unique) {
			const key = `${e.holder}|${e.model}`;
			truth.set(key, (truth.get(key) ?? 0) + e.inputTokens + e.outputTokens);
		}
		const rows = await duck(
			`SELECT key, labels.model AS model, (sum(payload.input_tokens) + sum(payload.output_tokens))::BIGINT AS tokens FROM (${dedupeSql(events(root))}) GROUP BY ALL`,
		);
		expect(rows.length).toBe(truth.size);
		for (const row of rows)
			expect(row.tokens).toBe(
				truth.get(`${String(row.key)}|${String(row.model)}`),
			);
	});

	test("the SQL dedupe drops re-sends that carry a later ingest_time (files written outside the outbox)", async () => {
		const dir = await tmp("usage-dup");
		const folder = join(dir, "schools", SCHOOL, "events", "date=2026-10-05");
		await mkdir(folder, { recursive: true });
		const sample = october
			.filter((e) => e.eventDate === "2026-10-05" && !e.duplicate)
			.slice(0, 20);
		const resent = sample
			.slice(0, 5)
			.map((e) =>
				e.line.replace(
					/"ingest_time":"[^"]+"/,
					'"ingest_time":"2026-10-06T00:00:00.000Z"',
				),
			);
		await Bun.write(
			join(folder, "batch-a.jsonl"),
			`${sample.map((e) => e.line).join("\n")}\n`,
		);
		await Bun.write(
			join(folder, "late-2026-10-06.jsonl"),
			`${resent.join("\n")}\n`,
		);
		const source = rawEventsSql({
			glob: join(dir, "schools", SCHOOL, "events", "*", "*.jsonl"),
			schema: "explicit",
		});
		const [row] = await duck(
			`SELECT (SELECT count(*) FROM ${source})::BIGINT AS rows, (SELECT count(*) FROM (${dedupeSql(source)}))::BIGINT AS kept, (SELECT count(*) FROM (${dedupeSql(source)}) WHERE ingest_time >= TIMESTAMPTZ '2026-10-06 00:00:00+00')::BIGINT AS kept_late_copy`,
		);
		expect(row).toEqual({ rows: 25, kept: 20, kept_late_copy: 0 });
	});

	test("rating: lines match a BigInt calculation, and re-rating twice gives identical cents", async () => {
		const { root } = await shipped(all);
		const rollup = `(${dailyRollupSql(`(${dedupeSql(events(root))})`)})`;
		const rate = (extra = "") =>
			`${prices()}\n${extra}SELECT holder, model, direction, tokens::VARCHAR AS tokens, pico::VARCHAR AS pico, cents::BIGINT AS cents FROM (${invoiceLinesSql({ rollup, from: "2026-10-01", to: "2026-11-01" })}) ORDER BY holder, model, direction`;
		const first = await duck(rate());
		const second = await duck(rate());
		expect(second).toEqual(first);
		expect(first.length).toBeGreaterThan(50);
		// independent integer arithmetic over the same distinct events
		const tokens = new Map<string, bigint>();
		for (const e of distinct(all).filter((x) =>
			x.eventDate.startsWith("2026-10"),
		)) {
			tokens.set(
				`${e.holder}|${e.model}|input`,
				(tokens.get(`${e.holder}|${e.model}|input`) ?? 0n) +
					BigInt(e.inputTokens),
			);
			tokens.set(
				`${e.holder}|${e.model}|output`,
				(tokens.get(`${e.holder}|${e.model}|output`) ?? 0n) +
					BigInt(e.outputTokens),
			);
		}
		const price = new Map<string, bigint>(
			PRICE_ROWS.flatMap(
				([model, input, output]) =>
					[
						[`${model}|input`, BigInt(input)],
						[`${model}|output`, BigInt(output)],
					] as const,
			),
		);
		for (const line of first) {
			const sum =
				tokens.get(
					`${String(line.holder)}|${String(line.model)}|${String(line.direction)}`,
				) ?? 0n;
			const pico =
				sum *
				(price.get(`${String(line.model)}|${String(line.direction)}`) ?? 0n);
			expect(line.pico).toBe(pico.toString());
			expect(BigInt(line.cents as number)).toBe(centsOf(pico));
		}
	});

	test("a price change re-rates the whole month from raw events and the totals differ by exactly the changed lines", async () => {
		const { root } = await shipped(all);
		const rollup = `(${dailyRollupSql(`(${dedupeSql(events(root))})`)})`;
		const total = async (priceSql: string) => {
			const [row] = await duck(
				`${priceSql}\nSELECT sum(cents)::BIGINT AS cents FROM (${invoiceLinesSql({ rollup, from: "2026-10-01", to: "2026-11-01" })})`,
			);
			return Number(row?.cents);
		};
		const before = await total(prices());
		const corrected = await total(prices({ smOutput: 1_500_000 }));
		const split = await total(prices({ mdInputFromMid: 900_000 }));
		expect(corrected).toBeGreaterThan(before);
		expect(split).toBeLessThan(before);
		expect(await total(prices())).toBe(before);
	});

	test("a closed period: invoice as issued, then the late events become an adjustment that makes the lines add up again", async () => {
		const { root } = await shipped(all);
		const sepOnly = `(SELECT * FROM ${events(root)} WHERE date >= DATE '2026-09-01' AND date < DATE '2026-10-01')`;
		const lines = (source: string) =>
			invoiceLinesSql({
				rollup: `(${dailyRollupSql(`(${dedupeSql(source)})`)})`,
				from: "2026-09-01",
				to: "2026-10-01",
			});
		const issued = lines(
			`(SELECT * FROM ${sepOnly} WHERE ingest_time < TIMESTAMPTZ '${INVOICE_TIME}')`,
		);
		const now = lines(sepOnly);
		const [row] = await duck(`${prices()}
WITH i AS (${issued}), n AS (${now}),
d AS (SELECT coalesce(n.holder, i.holder) holder, coalesce(n.model, i.model) model, coalesce(n.direction, i.direction) direction, coalesce(n.price_from, i.price_from) price_from, coalesce(i.cents, 0) issued_cents, coalesce(n.cents, 0) now_cents, coalesce(n.cents, 0) - coalesce(i.cents, 0) adjustment FROM n FULL JOIN i USING (holder, model, direction, price_from))
SELECT sum(issued_cents)::BIGINT issued, sum(now_cents)::BIGINT now, sum(adjustment)::BIGINT adjustment, count(*) FILTER (WHERE adjustment <> 0)::BIGINT adjusted_lines FROM d`);
		const lateInSeptember = distinct(all).filter(
			(e) =>
				e.eventDate.startsWith("2026-09") &&
				e.ingestMs >= Date.parse("2026-10-02T00:00:00Z"),
		);
		expect(lateInSeptember.length).toBeGreaterThan(0);
		expect(Number(row?.adjustment)).toBeGreaterThan(0);
		expect(Number(row?.issued) + Number(row?.adjustment)).toBe(
			Number(row?.now),
		);
		expect(Number(row?.adjusted_lines)).toBeGreaterThan(0);
	});
});

describe.skipIf(!hasDuckdb)("self-describing Parquet and manifest", () => {
	const PREFIX = `schools/${SCHOOL}/usage`;
	const flatSql = (source: string, schemaVersion: 1 | 2) =>
		`SELECT key AS holder, date, event_time, ingest_time, idem, labels.model AS model, labels.feature AS feature, labels.region AS region, payload.input_tokens AS input_tokens, payload.output_tokens AS output_tokens, payload.cached_input_tokens AS cached_input_tokens${schemaVersion === 2 ? ", payload.reasoning_tokens AS reasoning_tokens" : ""}, ${schemaVersion}::INTEGER AS schema_version, ${schemaVersion}::INTEGER AS mapping_version FROM (${dedupeSql(source)})`;

	test("a reader with only the folder and duckdb recovers the column meanings, checks the files, and reads old and new schemas together", async () => {
		const root = await tmp("usage-parquet");
		const store = new FolderStore({ root });
		const eventsDir = await tmp("usage-events");
		const oldEvents = october.slice(0, 1200);
		const newEvents = month("2026-10", 3, { schemaVersion: 2 }).slice(0, 1200);
		const write = async (name: string, list: readonly GeneratedUsage[]) => {
			await mkdir(join(eventsDir, name), { recursive: true });
			await Bun.write(
				join(eventsDir, name, "e.jsonl"),
				`${list.map((e) => e.line).join("\n")}\n`,
			);
		};
		await write("old", oldEvents);
		await write("new", newEvents);
		const parquet = async (
			name: string,
			schemaVersion: 1 | 2,
			rows: number,
		) => {
			const source = rawEventsSql({
				glob: join(eventsDir, name, "e.jsonl"),
				schema: "explicit",
				payloadType: schemaVersion === 2 ? V2_PAYLOAD : V1_PAYLOAD,
			});
			const out = join(eventsDir, `${name}.parquet`);
			await duck(
				`COPY (${flatSql(source, schemaVersion)}) TO '${out}' (FORMAT parquet, COMPRESSION zstd, KV_METADATA {schema_version: '${schemaVersion}', mapping_version: '${schemaVersion}', mapping: 'usage-normalize'})`,
			);
			const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
			const key = `${PREFIX}/date=2026-10/part-${name}.parquet`;
			await putOnce(store, key, bytes);
			return { key, bytes, rows, schemaVersion, mappingVersion: schemaVersion };
		};
		const oldFile = await parquet("old", 1, distinct(oldEvents).length);
		const glob = `${PREFIX}/date=*/part-*.parquet`;
		const manifest = (version: number, files: (typeof oldFile)[]) =>
			buildUsageManifest({
				school: SCHOOL,
				manifestVersion: version,
				generatedAt: `2026-11-0${version}T00:00:00Z`,
				files,
				glob,
			});
		await putOnce(
			store,
			manifestKey(PREFIX, 1),
			utf8(`${JSON.stringify(manifest(1, [oldFile]), null, 2)}\n`),
		);

		// the file carries its own schema and versions
		const own = join(root, oldFile.key);
		const meta = await duck(
			`SELECT key::VARCHAR AS k, value::VARCHAR AS v FROM parquet_kv_metadata('${own}') ORDER BY k`,
		);
		expect(meta).toEqual([
			{ k: "mapping", v: "usage-normalize" },
			{ k: "mapping_version", v: "1" },
			{ k: "schema_version", v: "1" },
		]);
		const schema = await duck(
			`SELECT name, duckdb_type FROM parquet_schema('${own}') WHERE name IN ('input_tokens', 'date', 'event_time')`,
		);
		expect(schema).toEqual([
			{ name: "date", duckdb_type: "DATE" },
			{ name: "event_time", duckdb_type: "TIMESTAMP WITH TIME ZONE" },
			{ name: "input_tokens", duckdb_type: "BIGINT" },
		]);

		// schema change: a new file with reasoning_tokens, and manifest version 2
		const newFile = await parquet("new", 2, distinct(newEvents).length);
		await putOnce(
			store,
			manifestKey(PREFIX, 2),
			utf8(`${JSON.stringify(manifest(2, [oldFile, newFile]), null, 2)}\n`),
		);

		// the outside reader: no atm imports below this line, only the folder, node:crypto and the duckdb CLI
		const folder = join(root, PREFIX);
		const manifests = (await readdir(join(folder, "_manifest"))).sort();
		const current = JSON.parse(
			await readFile(
				join(folder, "_manifest", manifests.at(-1) as string),
				"utf8",
			),
		) as {
			manifest_version: number;
			files: { key: string; sha256: string; schema_version: number }[];
			dataset: { read_sql: string };
		};
		expect(current.manifest_version).toBe(2);
		for (const file of current.files)
			expect(
				createHash("sha256")
					.update(await readFile(join(root, file.key)))
					.digest("hex"),
			).toBe(file.sha256);
		const meanings = await duck(
			`SELECT c.name AS name, c.meaning AS meaning, c.since_schema_version AS since FROM (SELECT unnest(dataset.columns) AS c FROM read_json('${join(folder, "_manifest", manifests.at(-1) as string)}')) WHERE c.name IN ('reasoning_tokens', 'input_tokens')`,
		);
		expect(meanings.find((m) => m.name === "reasoning_tokens")?.since).toBe(2);
		expect(
			String(meanings.find((m) => m.name === "input_tokens")?.meaning),
		).toContain("not counting cache reads");
		expect(current.dataset.read_sql).toBe(usageReadSql(glob));

		const merged = await duck(
			`SELECT count(*)::BIGINT AS n, count(reasoning_tokens)::BIGINT AS with_reasoning, count(*) FILTER (WHERE schema_version = 1)::BIGINT AS v1_rows FROM (${current.dataset.read_sql})`,
			root,
		);
		expect(merged[0]?.n).toBe(oldFile.rows + newFile.rows);
		expect(merged[0]?.v1_rows).toBe(oldFile.rows);
		expect(Number(merged[0]?.with_reasoning)).toBeGreaterThan(0);
		expect(Number(merged[0]?.with_reasoning)).toBeLessThanOrEqual(newFile.rows);
		// the trap union_by_name avoids: without it DuckDB takes the first file's columns, so reading the old file first drops reasoning_tokens
		const naive = await duck(
			`SELECT * FROM read_parquet(['${oldFile.key}', '${newFile.key}']) LIMIT 1`,
			root,
		);
		expect(Object.keys(naive[0] ?? {})).not.toContain("reasoning_tokens");
		const safe = await duck(
			`SELECT * FROM read_parquet(['${oldFile.key}', '${newFile.key}'], union_by_name = true) LIMIT 1`,
			root,
		);
		expect(Object.keys(safe[0] ?? {})).toContain("reasoning_tokens");
	});
});
