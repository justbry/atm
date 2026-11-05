/**
 * Spike helper: the manifest written next to the usage Parquet files in the same folder store. A reader that has only
 * the folder and `duckdb` reads it to learn what each column means, which schema and mapping version each file was
 * written under, and the exact SQL to open the files together; it checks each file's sha256 against it.
 *
 * Layout: `<prefix>/_manifest/<NNNN>.json`, create-only, the highest number is current. Parquet files carry the same
 * two versions in their own key/value metadata (`COPY ... KV_METADATA`) and in two constant columns.
 */
import { sha256Hex } from "../../src/store/store.js";

export type UsageColumn = {
	name: string;
	type: string;
	meaning: string;
	/** Where the value comes from in the event, so a reader can re-derive it from the raw object. */
	source: string;
	since_schema_version: number;
};

/** Payload schema per version of `usage.recorded`. Version 2 added `reasoning_tokens`. */
export const USAGE_PAYLOAD_SCHEMAS: Record<number, Record<string, unknown>> = {
	1: {
		type: "object",
		required: ["input_tokens", "output_tokens"],
		additionalProperties: false,
		properties: {
			schema_version: { const: 1 },
			input_tokens: { type: "integer", minimum: 0 },
			output_tokens: { type: "integer", minimum: 0 },
			cached_input_tokens: { type: "integer", minimum: 0 },
		},
	},
	2: {
		type: "object",
		required: ["input_tokens", "output_tokens"],
		additionalProperties: false,
		properties: {
			schema_version: { const: 2 },
			input_tokens: { type: "integer", minimum: 0 },
			output_tokens: { type: "integer", minimum: 0 },
			cached_input_tokens: { type: "integer", minimum: 0 },
			reasoning_tokens: { type: "integer", minimum: 0 },
		},
	},
};

export const USAGE_COLUMNS: readonly UsageColumn[] = [
	{
		name: "holder",
		type: "VARCHAR",
		meaning: "the billed customer (envelope key)",
		source: "key",
		since_schema_version: 1,
	},
	{
		name: "date",
		type: "DATE",
		meaning: "event date in the school's tz (the billing day)",
		source: "date",
		since_schema_version: 1,
	},
	{
		name: "event_time",
		type: "TIMESTAMPTZ",
		meaning: "when the request happened (UTC)",
		source: "event_time",
		since_schema_version: 1,
	},
	{
		name: "ingest_time",
		type: "TIMESTAMPTZ",
		meaning:
			"when the ledger received it; a late event has ingest_time much later than event_time",
		source: "ingest_time",
		since_schema_version: 1,
	},
	{
		name: "idem",
		type: "VARCHAR",
		meaning: "the request id; unique per school, duplicates are dropped by it",
		source: "idem",
		since_schema_version: 1,
	},
	{
		name: "model",
		type: "VARCHAR",
		meaning: "model the request ran on (price key)",
		source: "labels.model",
		since_schema_version: 1,
	},
	{
		name: "feature",
		type: "VARCHAR",
		meaning: "product feature that made the request",
		source: "labels.feature",
		since_schema_version: 1,
	},
	{
		name: "region",
		type: "VARCHAR",
		meaning: "serving region",
		source: "labels.region",
		since_schema_version: 1,
	},
	{
		name: "input_tokens",
		type: "BIGINT",
		meaning: "billable input tokens, not counting cache reads",
		source: "payload.input_tokens",
		since_schema_version: 1,
	},
	{
		name: "output_tokens",
		type: "BIGINT",
		meaning: "billable output tokens",
		source: "payload.output_tokens",
		since_schema_version: 1,
	},
	{
		name: "cached_input_tokens",
		type: "BIGINT",
		meaning: "input tokens served from cache (not rated)",
		source: "payload.cached_input_tokens",
		since_schema_version: 1,
	},
	{
		name: "reasoning_tokens",
		type: "BIGINT",
		meaning: "tokens spent reasoning, billed as output",
		source: "payload.reasoning_tokens",
		since_schema_version: 2,
	},
	{
		name: "schema_version",
		type: "INTEGER",
		meaning: "payload schema version the event was written under",
		source: "payload.schema_version",
		since_schema_version: 1,
	},
	{
		name: "mapping_version",
		type: "INTEGER",
		meaning: "version of the usage-normalize mapping that produced this row",
		source: "mapping",
		since_schema_version: 1,
	},
];

export type ManifestFile = {
	key: string;
	sha256: string;
	bytes: number;
	rows: number;
	schema_version: number;
	mapping_version: number;
};

export type UsageManifest = {
	manifest_version: number;
	generated_at: string;
	school: string;
	envelope: { schema: string; version: number };
	event_types: Record<
		string,
		{ payload_schemas: Record<string, Record<string, unknown>> }
	>;
	mapping: { name: string; versions: Record<string, string> };
	dataset: {
		name: string;
		columns: readonly UsageColumn[];
		ddl: string;
		read_sql: string;
	};
	files: ManifestFile[];
};

export const usageDdl = (): string =>
	`CREATE TABLE usage (\n${USAGE_COLUMNS.map((c) => `\t${c.name} ${c.type}`).join(",\n")}\n);`;

/** The SQL a reader runs; `union_by_name` is what lets old files (no `reasoning_tokens`) and new ones be read together. */
export const usageReadSql = (glob: string): string =>
	`SELECT * FROM read_parquet('${glob}', union_by_name = true)`;

export const buildUsageManifest = ({
	school,
	manifestVersion,
	generatedAt,
	files,
	glob,
}: {
	school: string;
	manifestVersion: number;
	generatedAt: string;
	files: {
		key: string;
		bytes: Uint8Array;
		rows: number;
		schemaVersion: number;
		mappingVersion: number;
	}[];
	glob: string;
}): UsageManifest => ({
	manifest_version: manifestVersion,
	generated_at: generatedAt,
	school,
	envelope: {
		schema: "https://b4uni.com/_schema/envelope.v1.json",
		version: 1,
	},
	event_types: {
		"usage.recorded": {
			payload_schemas: Object.fromEntries(
				Object.entries(USAGE_PAYLOAD_SCHEMAS).map(([version, schema]) => [
					version,
					schema,
				]),
			),
		},
	},
	mapping: {
		name: "usage-normalize",
		versions: {
			"1": "labels.{model,feature,region} and payload.{input,output,cached_input}_tokens promoted to typed columns",
			"2": "as 1, plus payload.reasoning_tokens",
		},
	},
	dataset: {
		name: "usage",
		columns: USAGE_COLUMNS,
		ddl: usageDdl(),
		read_sql: usageReadSql(glob),
	},
	files: files.map((f) => ({
		key: f.key,
		sha256: sha256Hex(f.bytes),
		bytes: f.bytes.byteLength,
		rows: f.rows,
		schema_version: f.schemaVersion,
		mapping_version: f.mappingVersion,
	})),
});

export const manifestKey = (prefix: string, manifestVersion: number): string =>
	`${prefix}/_manifest/${String(manifestVersion).padStart(4, "0")}.json`;
