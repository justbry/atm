/**
 * DuckDB DDL from the envelope's JSON Schema (spec, "Journal generator"): `date-time` -> TIMESTAMPTZ,
 * `date` -> DATE, decimal strings -> DECIMAL(18,2), `labels` -> MAP(VARCHAR, VARCHAR), `postings` ->
 * STRUCT(account VARCHAR, amount DECIMAL(18,2), commodity VARCHAR)[], `payload` and `redacted` -> JSON.
 */
type Schema = {
	type?: string;
	format?: string;
	const?: unknown;
	$ref?: string;
	properties?: Record<string, Schema>;
	additionalProperties?: Schema | boolean;
	items?: Schema;
	required?: string[];
	$defs?: Record<string, Schema>;
};

export const duckdbDdl = (envelope: Record<string, unknown>): string => {
	const root = envelope as Schema;
	const resolve = (s: Schema): Schema => {
		if (!s.$ref) return s;
		const name = s.$ref.replace("#/$defs/", "");
		const target = root.$defs?.[name];
		if (!target) throw new Error(`unresolved ${s.$ref}`);
		return resolve(target);
	};
	const typeOf = (s0: Schema, path: string): string => {
		const s = resolve(s0);
		if (s.const !== undefined)
			return typeof s.const === "number" ? "INTEGER" : "VARCHAR";
		if (s.type === "string") {
			if (s.format === "date-time") return "TIMESTAMPTZ";
			if (s.format === "date") return "DATE";
			if (s.format === "decimal") return "DECIMAL(18,2)";
			return "VARCHAR";
		}
		if (s.type === "integer") return "BIGINT";
		if (s.type === "number") return "DOUBLE";
		if (s.type === "boolean") return "BOOLEAN";
		if (s.type === "array" && s.items)
			return `${typeOf(s.items, `${path}[]`)}[]`;
		if (s.type === "object") {
			if (s.properties) {
				const fields = Object.entries(s.properties).map(
					([k, v]) => `${k} ${typeOf(v, `${path}.${k}`)}`,
				);
				return `STRUCT(${fields.join(", ")})`;
			}
			const extra = s.additionalProperties;
			if (
				extra &&
				typeof extra === "object" &&
				resolve(extra).type === "string"
			)
				return "MAP(VARCHAR, VARCHAR)";
			return "JSON";
		}
		// enum without type
		return "VARCHAR";
	};
	const props = root.properties ?? {};
	const required = new Set(root.required ?? []);
	const cols = Object.entries(props).map(([name, s]) => {
		const t = typeOf(s, name);
		return `\t${name} ${t}${required.has(name) ? " NOT NULL" : ""}`;
	});
	return [
		"-- Generated from schema/envelope.v1.json by `bun schema/build.ts`. Do not edit.",
		"CREATE TABLE IF NOT EXISTS events (",
		cols.join(",\n"),
		");",
		"",
		"-- One row per posting, the shape the parity query reads.",
		"CREATE OR REPLACE VIEW ledger_postings AS",
		"SELECT e.id, e.school, e.event_type, e.event_time, e.date, e.key, e.labels,",
		"       t.p.account AS account, t.p.amount AS amount, t.p.commodity AS commodity",
		"FROM events e, UNNEST(e.postings) AS t(p);",
		"",
	].join("\n");
};
