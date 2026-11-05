#!/usr/bin/env bun
/**
 * Writes `schema/stripe/objects.clover.json`: the parts of Stripe's published OpenAPI spec that the webhook mappings read,
 * as plain JSON Schema 2020-12. The tests check every raw event atm is tested with, and every path a mapping reads,
 * against it, so a mapping or a synthetic fixture cannot name a field Stripe's API version does not have.
 *
 *   bun schema/stripe/build.ts <spec3.json>
 *
 * Get the spec for the API version the mappings pin (`2025-10-29.clover`) from github.com/stripe/openapi: tag `v2105`,
 * `openapi/spec3.json` (its `info.version` says which API version it is). The output is committed; the full spec (8 MB)
 * is not. Pruning: top-level resources other than the roots (customer, account, payment_intent, ...) become `{}` (any
 * value), `description`, `example` and `x-*` keys are dropped, `nullable` becomes `anyOf [..., null]`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The objects a webhook event's `data.object` can be, and the nested ones the mappings read. */
export const ROOTS = {
	invoice: "invoice",
	charge: "charge",
	dispute: "dispute",
	subscription: "subscription",
	invoice_payment: "invoice_payment",
	payout: "payout",
	checkout_session: "checkout.session",
} as const;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const REF = "#/components/schemas/";

export function trimSpec(spec: Json): Json {
	const schemas = (spec.components as { schemas: Record<string, Json> })
		.schemas;
	// A top-level API resource (it has `x-resourceId`) that is not a root is a reference the event may expand: any value.
	const cut = (name: string) =>
		schemas[name]?.["x-resourceId"] !== undefined &&
		!Object.values(ROOTS).includes(name as never) &&
		name !== "line_item" &&
		name !== "subscription_item" &&
		name !== "price" &&
		name !== "refund";
	const kept = new Map<string, unknown>();
	const visit = (name: string) => {
		if (kept.has(name) || cut(name) || !schemas[name]) return;
		kept.set(name, null);
		kept.set(name, convert(schemas[name]));
	};
	const convert = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(convert);
		if (!isObject(node)) return node;
		const { nullable, ...rest } = node;
		const out: Json = {};
		for (const [key, value] of Object.entries(rest)) {
			if (key === "description" || key === "example" || key === "title")
				continue;
			if (key.startsWith("x-")) continue;
			if (key === "$ref" && typeof value === "string") {
				const name = value.slice(REF.length);
				visit(name);
				if (cut(name) || !schemas[name])
					return nullable ? { anyOf: [{}, { type: "null" }] } : {};
				out.$ref = `#/$defs/${name}`;
				continue;
			}
			// a property called "description" or "example" is data, not a keyword
			if (key === "properties" && isObject(value)) {
				out.properties = Object.fromEntries(
					Object.entries(value).map(([k, v]) => [k, convert(v)]),
				);
				continue;
			}
			out[key] = convert(value);
		}
		return nullable ? { anyOf: [out, { type: "null" }] } : out;
	};
	for (const name of [
		...Object.values(ROOTS),
		"line_item",
		"subscription_item",
		"price",
		"refund",
	])
		visit(name);
	const defs = Object.fromEntries(
		[...kept.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		title: "The Stripe objects atm reads, pruned from Stripe's OpenAPI spec",
		stripeApiVersion: (spec.info as { version: string }).version,
		roots: ROOTS,
		$defs: defs,
	};
}

if (import.meta.main) {
	const path = process.argv[2];
	if (!path) throw new Error("usage: bun schema/stripe/build.ts <spec3.json>");
	const out = trimSpec(JSON.parse(readFileSync(path, "utf8")) as Json);
	const target = join(import.meta.dir, "objects.clover.json");
	writeFileSync(target, `${JSON.stringify(out)}\n`);
	console.log(`wrote ${target} (${out.stripeApiVersion})`);
}
