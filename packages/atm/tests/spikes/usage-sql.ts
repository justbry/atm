/**
 * Spike helper: the DuckDB SQL for reading, deduping, aggregating and rating `usage.recorded` events. Pure strings, so
 * the same text runs from the spike test and from the benchmark drivers in /tmp.
 *
 * Money rule: prices are integer micro-dollars per 1M tokens. An invoice line is one holder, one model, one direction
 * and one price version; its exact amount is `tokens * micro_usd_per_million` in pico-dollars (1e-12 USD, a HUGEINT,
 * never a float), and it is rounded to a whole cent ONCE, half away from zero, never per event. The invoice total is
 * the sum of the rounded lines, so the lines always add up to the total.
 */

const PICO_PER_CENT = "10000000000";
const HALF_CENT_PICO = "5000000000";

export const V1_PAYLOAD =
	"STRUCT(input_tokens BIGINT, output_tokens BIGINT, cached_input_tokens BIGINT)";
export const V2_PAYLOAD =
	"STRUCT(input_tokens BIGINT, output_tokens BIGINT, cached_input_tokens BIGINT, reasoning_tokens BIGINT, schema_version INTEGER)";

/** Only the columns the usage queries read; `read_json` then skips parsing the rest of each line. */
export const explicitColumns = (payloadType: string = V1_PAYLOAD): string => `{
	idem: 'VARCHAR',
	id: 'VARCHAR',
	key: 'VARCHAR',
	date: 'DATE',
	event_time: 'TIMESTAMPTZ',
	ingest_time: 'TIMESTAMPTZ',
	labels: 'STRUCT(feature VARCHAR, model VARCHAR, region VARCHAR)',
	payload: '${payloadType}'
}`;

/** Raw events from newline-delimited JSON files, with an explicit schema (fast) or inferred (`read_json_auto`). */
export const rawEventsSql = ({
	glob,
	schema,
	payloadType,
}: {
	glob: string | readonly string[];
	schema: "explicit" | "auto";
	payloadType?: string;
}): string => {
	const files =
		typeof glob === "string"
			? `'${glob}'`
			: `[${glob.map((g) => `'${g}'`).join(", ")}]`;
	return schema === "explicit"
		? `read_json(${files}, format = 'newline_delimited', columns = ${explicitColumns(payloadType)})`
		: `read_json_auto(${files}, format = 'newline_delimited')`;
};

/** One row per `idem`: the earliest ingested copy wins, ties by id. */
export const dedupeSql = (source: string): string =>
	`SELECT * FROM ${source} QUALIFY row_number() OVER (PARTITION BY idem ORDER BY ingest_time, id) = 1`;

/** Same result as `dedupeSql` when copies are identical apart from `ingest_time`: DuckDB's `DISTINCT ON`. */
export const dedupeDistinctOnSql = (source: string): string =>
	`SELECT DISTINCT ON (idem) * FROM ${source} ORDER BY idem, ingest_time, id`;

/** Daily rollup: one row per holder, day and model, tokens by direction. Rebuildable from the raw events at any time. */
export const dailyRollupSql = (deduped: string): string =>
	`SELECT key AS holder, date AS day, labels.model AS model, sum(payload.input_tokens)::BIGINT AS input_tokens, sum(payload.output_tokens)::BIGINT AS output_tokens, count(*)::BIGINT AS requests
FROM ${deduped}
GROUP BY ALL`;

export const createPricesSql = (
	rows: readonly {
		model: string;
		direction: "input" | "output";
		microUsdPerMillion: number;
		validFrom: string;
	}[],
): string =>
	`CREATE OR REPLACE TABLE price (model VARCHAR, direction VARCHAR, micro_usd_per_million BIGINT, valid_from DATE);
INSERT INTO price VALUES ${rows
		.map(
			(r) =>
				`('${r.model}', '${r.direction}', ${r.microUsdPerMillion}, DATE '${r.validFrom}')`,
		)
		.join(", ")};`;

/**
 * Invoice lines for one period from a daily rollup: each day is priced by the latest `price` row at or before it
 * (ASOF JOIN), tokens are summed per holder, model, direction and price version, and each line is rounded once.
 */
export const invoiceLinesSql = ({
	rollup,
	from,
	to,
}: {
	rollup: string;
	from: string;
	to: string;
}): string =>
	`SELECT holder, model, direction, price_from, micro_usd_per_million, tokens, tokens * micro_usd_per_million AS pico,
	sign(tokens * micro_usd_per_million)::HUGEINT * ((abs(tokens * micro_usd_per_million) + ${HALF_CENT_PICO}) // ${PICO_PER_CENT}) AS cents
FROM (
	SELECT d.holder, d.model, d.direction, p.valid_from AS price_from, p.micro_usd_per_million::HUGEINT AS micro_usd_per_million,
		sum(d.tokens)::HUGEINT AS tokens
	FROM (
		SELECT holder, day, model, t.direction, t.tokens
		FROM ${rollup}, UNNEST([{direction: 'input', tokens: input_tokens}, {direction: 'output', tokens: output_tokens}]) AS u(t)
	) d ASOF JOIN price p ON d.model = p.model AND d.direction = p.direction AND d.day >= p.valid_from
	WHERE d.day >= DATE '${from}' AND d.day < DATE '${to}'
	GROUP BY d.holder, d.model, d.direction, p.valid_from, p.micro_usd_per_million
)`;
