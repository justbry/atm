/**
 * Checks raw Stripe events and mapping paths against `schema/stripe/objects.clover.json`, the pruned OpenAPI spec of the
 * API version the mappings pin. Two checks:
 *  - `shapeProblems(event)`: every field the event has is a field of Stripe's object at that place, with a value of the
 *    right type. Required fields are not demanded (the synthetic events are partial on purpose); extra and mistyped ones fail.
 *  - `pathProblems(mapping)`: every path a mapping reads exists in Stripe's object, so a mapping cannot name a field the
 *    API version does not have.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { MAPPINGS, parsePath } from "../src/billing/normalize.js";
import type { Mapping } from "../src/billing/types.js";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const spec = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../schema/stripe/objects.clover.json"),
		"utf8",
	),
) as { stripeApiVersion: string; $defs: Record<string, Json> };

export const SPEC_VERSION = spec.stripeApiVersion;

/** Which Stripe object an event type carries in `data.object`. */
export const OBJECT_OF_EVENT: Record<string, string> = {
	"invoice.paid": "invoice",
	"charge.refunded": "charge",
	"charge.dispute.created": "dispute",
	"charge.dispute.closed": "dispute",
	"customer.subscription.created": "subscription",
	"customer.subscription.updated": "subscription",
	"customer.subscription.deleted": "subscription",
};

/** The spec made strict about names: no `required`, and no field an object does not list. */
const strict = (node: unknown): unknown => {
	if (Array.isArray(node)) return node.map(strict);
	if (!isObject(node)) return node;
	const out: Json = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "required") continue;
		out[key] =
			key === "properties" && isObject(value)
				? Object.fromEntries(
						Object.entries(value).map(([k, v]) => [k, strict(v)]),
					)
				: strict(value);
	}
	if (isObject(out.properties) && out.additionalProperties === undefined)
		out.additionalProperties = false;
	return out;
};

const ajv = new Ajv2020({
	allErrors: true,
	strict: false,
	validateFormats: false,
});
ajv.addSchema({
	$id: "stripe",
	$defs: Object.fromEntries(
		Object.entries(spec.$defs).map(([k, v]) => [k, strict(v)]),
	),
});

const ENVELOPE_FIELDS = new Set([
	"id",
	"object",
	"api_version",
	"created",
	"type",
	"livemode",
	"data",
	"pending_webhooks",
	"request",
	"account",
	"context",
]);

/** What is wrong with the event's shape against Stripe's object, as `path: problem` lines; empty when it fits. */
export const shapeProblems = (event: Json): string[] => {
	const type = String(event.type);
	const object = OBJECT_OF_EVENT[type];
	if (!object) return [`no Stripe object known for ${type}`];
	const problems: string[] = [];
	for (const key of Object.keys(event))
		if (!ENVELOPE_FIELDS.has(key))
			problems.push(`event.${key}: not an event field`);
	const validate = ajv.getSchema(`stripe#/$defs/${object}`);
	if (!validate) throw new Error(`no schema for ${object}`);
	const data = (event.data as { object?: unknown } | undefined)?.object;
	if (!validate(data)) {
		for (const e of validate.errors ?? []) {
			// anyOf branches repeat the same problem; keep the ones that name a field or a type
			if (e.keyword === "anyOf" || e.keyword === "oneOf") continue;
			const extra =
				e.keyword === "additionalProperties"
					? `.${String((e.params as { additionalProperty: string }).additionalProperty)}`
					: "";
			problems.push(
				`${object}${e.instancePath.replaceAll("/", ".")}${extra}: ${e.message}`,
			);
		}
	}
	return [...new Set(problems)];
};

// ---- paths -------------------------------------------------------------------------------------------------------

const resolve = (schema: unknown): Json[] => {
	if (!isObject(schema)) return [];
	if (typeof schema.$ref === "string") {
		const name = schema.$ref.slice("#/$defs/".length);
		const target = spec.$defs[name];
		return target ? resolve(target) : [{}];
	}
	const branches = ["anyOf", "oneOf", "allOf"].flatMap((k) =>
		Array.isArray(schema[k]) ? (schema[k] as unknown[]).flatMap(resolve) : [],
	);
	return branches.length > 0 ? branches : [schema];
};

/**
 * The schemas a path can end at inside `schema`; empty when no branch has the path. A webhook event sends a reference
 * field (`customer`, `payment_intent`, `charge`) as a plain id string, so a path cannot go deeper through a place that may
 * be a string, nor through a pruned `{}` (any value); either can only be the end of a path.
 */
const walk = (schema: unknown, tokens: (string | number)[]): Json[] => {
	let current = resolve(schema);
	for (const token of tokens) {
		if (current.some((s) => s.type === "string")) return [];
		current = current.flatMap((s) => {
			if (Object.keys(s).length === 0) return [];
			if (typeof token === "number") return s.items ? resolve(s.items) : [];
			const props = s.properties as Json | undefined;
			if (props && token in props) return resolve(props[token]);
			if (isObject(s.additionalProperties))
				return resolve(s.additionalProperties);
			if (s.additionalProperties === true) return [{}];
			return [];
		});
		if (current.length === 0) return [];
	}
	return current;
};

/** Paths a mapping reads that Stripe's object for its event does not have. */
export const pathProblems = (mapping: Mapping): string[] => {
	const object = OBJECT_OF_EVENT[mapping.event];
	if (!object) return [`no Stripe object known for ${mapping.event}`];
	const root = { $ref: `#/$defs/${object}` };
	const problems: string[] = [];
	const check = (
		label: string,
		path: string,
		base: unknown,
		prefix: string,
	) => {
		const tokens = parsePath(path);
		const dataObject = tokens[0] === "data" && tokens[1] === "object";
		const relative =
			base === root ? (dataObject ? tokens.slice(2) : null) : tokens;
		if (relative === null) {
			// event-level paths ($.type, $.created, ...): one field, nothing under it
			if (tokens.length !== 1 || !ENVELOPE_FIELDS.has(String(tokens[0])))
				problems.push(`${label}: ${path} is not an event field`);
			return;
		}
		if (walk(base, relative).length === 0)
			problems.push(`${label}: ${prefix}${path} is not in Stripe's ${object}`);
	};
	for (const [name, field] of Object.entries(mapping.fields)) {
		check(`${mapping.event} ${name}`, field.path, root, "");
		if (field.equalsPath)
			check(`${mapping.event} ${name}`, field.equalsPath, root, "");
	}
	if (mapping.lines) {
		const linesPath = parsePath(mapping.lines.path).slice(2);
		const lineSchema = walk(root, [...linesPath, 0]);
		if (lineSchema.length === 0)
			problems.push(
				`${mapping.event} lines: ${mapping.lines.path} is not in Stripe's ${object}`,
			);
		for (const [name, field] of Object.entries(mapping.lines.fields)) {
			const tokens = parsePath(field.path);
			if (!lineSchema.some((line) => walk(line, tokens).length > 0))
				problems.push(
					`${mapping.event} line ${name}: ${field.path} is not in Stripe's line item`,
				);
		}
	}
	return problems;
};

export const allMappingProblems = (): string[] =>
	(MAPPINGS as readonly Mapping[]).flatMap(pathProblems);
