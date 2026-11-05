/**
 * The DuckDB channel: the KPI spec as SQL over the `events` table and the `ledger_postings` view of
 * `schema/duckdb/envelope.v1.sql`, run with the `duckdb` CLI; and the Parquet writer for a table of KPI rows.
 *
 * The atm channel (`atm.ts`) is the reference for the base aggregates; this one must return the same values. The SQL is
 * generated from the spec, one SELECT per base KPI, joined by UNION ALL into one query.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import envelope from "../../../schema/envelope.v1.json";
import { duckdbDdl } from "../../ledger/duckdb.js";
import type { AtmEvent } from "../../types.js";
import {
	type BaseKpi,
	type BaseValues,
	isBase,
	type KpiChannel,
	type KpiRow,
} from "../kpis.js";

const lit = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** Whether the `duckdb` CLI runs. */
export const duckdbAvailable = (): boolean => {
	try {
		return (
			Bun.spawnSync(["duckdb", "--version"], {
				stdout: "pipe",
				stderr: "pipe",
			}).exitCode === 0
		);
	} catch {
		return false;
	}
};

const runDuckdb = (
	args: string[],
): { stdout: string; stderr: string; exitCode: number } => {
	const run = Bun.spawnSync(["duckdb", "-no-init", "-bail", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		stdout: run.stdout.toString(),
		stderr: run.stderr.toString(),
		exitCode: run.exitCode,
	};
};

/** The `events` columns with the types the DDL declares, for `read_json(columns=...)`. */
const eventColumns = (ddl: string): [string, string][] => {
	const table = /CREATE TABLE IF NOT EXISTS events \(\n([\s\S]*?)\n\);/.exec(
		ddl,
	);
	if (!table) throw new Error("the events table is not in the DuckDB DDL");
	return (table[1] as string).split("\n").map((line) => {
		const m = /^\t(\w+) (.+?)(?: NOT NULL)?,?$/.exec(line);
		if (!m) throw new Error(`cannot read the DDL column line ${line}`);
		return [m[1] as string, m[2] as string];
	});
};

const MONTH = "strftime(date, '%Y-%m')";

type Compute = BaseKpi["compute"];

/** The dimension of `source` (a SQL expression): the pattern's first group when the pattern matches, else NULL. */
const dimensionSql = (by: NonNullable<Compute["by"]>, source: string): string =>
	`CASE WHEN regexp_matches(${source}, ${lit(by.pattern)}) THEN regexp_extract(${source}, ${lit(by.pattern)}, 1) END`;

/** Conditions on the event that do not depend on a posting. */
const eventConditions = (where: Compute["where"]): string[] => {
	const out: string[] = [];
	if (where.eventType)
		out.push(`event_type IN (${where.eventType.map(lit).join(", ")})`);
	if (where.label)
		out.push(
			`regexp_matches(labels[${lit(where.label.name)}], ${lit(where.label.pattern)})`,
		);
	return out;
};

const sqlFor = (kpi: BaseKpi, periods: readonly string[]): string => {
	const c = kpi.compute;
	const periodList = periods.map(lit).join(", ");
	const idOf = (dim: string) =>
		c.by ? `${lit(`${kpi.id}:`)} || ${dim}` : lit(kpi.id);
	if (c.op === "sum") {
		const dim = c.by
			? dimensionSql(
					c.by,
					c.by.from === "account"
						? "account"
						: `labels[${lit(c.by.from.slice("label:".length))}]`,
				)
			: "NULL";
		const conditions = [
			c.commodity === "usd" ? "commodity = 'USD'" : "commodity <> 'USD'",
			...(c.where.account
				? [`regexp_matches(account, ${lit(c.where.account)})`]
				: []),
			...eventConditions(c.where),
			...(c.by ? [`${dim} IS NOT NULL`] : []),
		];
		// whole cents without float drift: the DECIMAL times 100 is exact; credit units must already be whole
		const units =
			c.commodity === "usd"
				? "CAST(amount * 100 AS BIGINT)"
				: `CASE WHEN amount = trunc(amount) THEN CAST(amount AS BIGINT) ELSE error('credit amount is not a whole number') END`;
		const postings = `SELECT ${MONTH} AS month, ${idOf(dim)} AS id, ${c.sign} * ${units} AS v FROM ledger_postings WHERE ${conditions.join(" AND ")}`;
		if (c.cumulative)
			return `SELECT m.id AS id, p.period AS period, CAST(sum(m.v) AS BIGINT) AS value FROM (${postings}) m JOIN (VALUES ${periods.map((p) => `(${lit(p)})`).join(", ")}) p(period) ON m.month <= p.period GROUP BY m.id, p.period`;
		return `SELECT id, month AS period, CAST(sum(v) AS BIGINT) AS value FROM (${postings}) WHERE month IN (${periodList}) GROUP BY id, month`;
	}
	// count and distinct work on the event: it needs one posting matching the account, and the dimension is read from
	// a label (an account dimension has no event-level meaning: the atm channel leaves such events out, so does this)
	const dim = c.by
		? c.by.from === "account"
			? "NULL"
			: dimensionSql(c.by, `labels[${lit(c.by.from.slice("label:".length))}]`)
		: "NULL";
	const conditions = [
		...(c.where.account
			? [
					`len(list_filter(postings, lambda p: regexp_matches(p.account, ${lit(c.where.account)}))) > 0`,
				]
			: []),
		...eventConditions(c.where),
		...(c.by ? [`${dim} IS NOT NULL`] : []),
	];
	const events = `SELECT ${MONTH} AS month, ${idOf(dim)} AS id, key FROM events WHERE ${["TRUE", ...conditions].join(" AND ")} AND ${MONTH} IN (${periodList})`;
	if (c.op === "count")
		return `SELECT id, month AS period, CAST(count(*) AS BIGINT) AS value FROM (${events}) GROUP BY id, month`;
	if (c.first)
		// the first period (of those asked for) a holder matches, per id
		return `SELECT id, month AS period, CAST(count(*) AS BIGINT) AS value FROM (SELECT id, key, min(month) AS month FROM (${events}) GROUP BY id, key) GROUP BY id, month`;
	return `SELECT id, month AS period, CAST(count(DISTINCT key) AS BIGINT) AS value FROM (${events}) GROUP BY id, month`;
};

/** The SQL that creates the events table and loads the JSON lines file at `eventsPath`. */
const loadSql = (eventsPath: string): string => {
	const ddl = duckdbDdl(envelope as Record<string, unknown>);
	const columns = eventColumns(ddl)
		.map(([name, type]) => `${lit(name)}: ${lit(type)}`)
		.join(", ");
	return [
		ddl,
		`INSERT INTO events BY NAME SELECT * FROM read_json(${lit(eventsPath)}, format = 'newline_delimited', columns = {${columns}});`,
	].join("\n");
};

export const duckdbChannel: KpiChannel = {
	name: "duckdb",
	base: async ({ events, spec, periods }) => {
		const out: BaseValues = {};
		const queries = spec.kpis.filter(isBase).map((kpi) => sqlFor(kpi, periods));
		if (queries.length === 0 || periods.length === 0) return out;
		const dir = await mkdtemp(join(tmpdir(), "atm-duckdb-"));
		try {
			const eventsPath = join(dir, "events.jsonl");
			await writeFile(
				eventsPath,
				events.map((event: AtmEvent) => JSON.stringify(event)).join("\n") +
					(events.length > 0 ? "\n" : ""),
			);
			if (events.length === 0) return out;
			const run = runDuckdb([
				"-json",
				":memory:",
				"-c",
				loadSql(eventsPath),
				"-c",
				queries.join("\nUNION ALL\n"),
			]);
			if (run.exitCode !== 0)
				throw new Error(`duckdb failed: ${run.stderr.trim()}`);
			const text = run.stdout.trim();
			const rows = (text === "" ? [] : JSON.parse(text)) as {
				id: string;
				period: string;
				value: number | string;
			}[];
			for (const row of rows) {
				const values = out[row.id] ?? {};
				values[row.period] = Number(row.value);
				out[row.id] = values;
			}
			return out;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
};

/**
 * KPI rows as a Parquet file in long format: `profile, kpi_id, period (YYYY-MM), value DOUBLE, unit`, sorted by kpi_id
 * then period. When the `duckdb` binary is missing nothing is written and the reason is returned.
 */
export const writeKpiParquet = async ({
	rows,
	profile,
	path,
}: {
	rows: readonly KpiRow[];
	profile: string;
	path: string;
}): Promise<{ written: boolean; reason?: string }> => {
	if (!duckdbAvailable())
		return { written: false, reason: "the duckdb binary is not installed" };
	const dir = await mkdtemp(join(tmpdir(), "atm-parquet-"));
	try {
		const jsonPath = join(dir, "rows.jsonl");
		await writeFile(
			jsonPath,
			rows
				.map((r) =>
					JSON.stringify({
						profile,
						kpi_id: r.kpiId,
						period: r.period,
						value: r.value,
						unit: r.unit,
					}),
				)
				.join("\n") + (rows.length > 0 ? "\n" : ""),
		);
		const source =
			rows.length > 0
				? `read_json(${lit(jsonPath)}, format = 'newline_delimited', columns = {profile: 'VARCHAR', kpi_id: 'VARCHAR', period: 'VARCHAR', value: 'DOUBLE', unit: 'VARCHAR'})`
				: `(SELECT NULL::VARCHAR AS profile, NULL::VARCHAR AS kpi_id, NULL::VARCHAR AS period, NULL::DOUBLE AS value, NULL::VARCHAR AS unit WHERE false)`;
		const run = runDuckdb([
			":memory:",
			"-c",
			`COPY (SELECT profile, kpi_id, period, value, unit FROM ${source} ORDER BY kpi_id, period) TO ${lit(path)} (FORMAT PARQUET);`,
		]);
		if (run.exitCode !== 0)
			return { written: false, reason: `duckdb failed: ${run.stderr.trim()}` };
		return { written: true };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};
