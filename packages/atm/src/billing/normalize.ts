/**
 * Raw Stripe webhook events → normalized billing facts (see `./types.ts`), driven by declarative mapping files in
 * `schema/mapping/`. A mapping pins one Stripe event type to one API version and says where each target field sits in
 * the raw JSON (a small JSONPath subset: `$.a.b`, `$.a[0]`). A Stripe API change means a new mapping file, not new code.
 *
 * Pure: no clock, no network, no randomness. The same input always gives the same output.
 */
import { MAPPING_FILES } from "../../schema/mapping/index.js";
import type {
	BillingInvoice,
	BillingFact as Fact,
	FactSource,
	FieldSpec,
	FieldType,
	InvoiceLine,
	LineItem,
	Mapping,
	NormalizeContext,
	NormalizeError,
	NormalizeResult as Result,
} from "./types.js";

export type PathToken = string | number;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: NormalizeError): { ok: false; error: NormalizeError } => ({
	ok: false,
	error,
});

/** Parses `$.a.b[0].c`. Throws on anything outside that subset (no filters, wildcards or quotes). */
export function parsePath(path: string): PathToken[] {
	if (!path.startsWith("$")) throw new Error(`path must start with $: ${path}`);
	const tokens: PathToken[] = [];
	const re = /\.([A-Za-z0-9_]+)|\[(\d+)\]/y;
	let i = 1;
	while (i < path.length) {
		re.lastIndex = i;
		const m = re.exec(path);
		if (!m) throw new Error(`unsupported JSONPath syntax at ${i} in ${path}`);
		tokens.push(m[1] !== undefined ? m[1] : Number(m[2]));
		i = re.lastIndex;
	}
	return tokens;
}

const tryParse = (path: string): PathToken[] | null => {
	try {
		return parsePath(path);
	} catch {
		return null;
	}
};

/** The value at a path, or undefined when a step is missing. `null` counts as missing. */
export function getPath(root: unknown, path: string | PathToken[]): unknown {
	const tokens = typeof path === "string" ? parsePath(path) : path;
	let cur: unknown = root;
	for (const t of tokens) {
		if (cur === null || typeof cur !== "object") return undefined;
		if (typeof t === "number") {
			if (!Array.isArray(cur) || t >= cur.length) return undefined;
			cur = cur[t];
		} else {
			if (Array.isArray(cur) || !Object.hasOwn(cur, t)) return undefined;
			cur = (cur as Record<string, unknown>)[t];
		}
	}
	return cur === null ? undefined : cur;
}

function convert(
	root: unknown,
	field: string,
	spec: FieldSpec,
	raw: unknown,
): Result<unknown> {
	const bad = (expected: FieldType) =>
		fail({ kind: "bad_type", field, path: spec.path, expected });
	switch (spec.type) {
		case "string": {
			if (typeof raw !== "string") return bad("string");
			if (!spec.values) return ok(raw);
			if (Object.hasOwn(spec.values, raw)) return ok(spec.values[raw]);
			if ("fallback" in spec) return ok(spec.fallback);
			return fail({ kind: "bad_value", field, path: spec.path });
		}
		case "int":
			return Number.isInteger(raw) ? ok(raw) : bad("int");
		case "seconds":
			// Stripe sends Unix seconds; the facts are Unix milliseconds.
			return Number.isInteger(raw)
				? ok((raw as number) * 1000)
				: bad("seconds");
		case "bool": {
			if (!spec.equalsPath)
				return typeof raw === "boolean" ? ok(raw) : bad("bool");
			const tokens = tryParse(spec.equalsPath);
			if (!tokens)
				return fail({ kind: "bad_path", field, path: spec.equalsPath });
			const other = getPath(root, tokens);
			if (other === undefined)
				return fail({ kind: "missing_path", field, path: spec.equalsPath });
			if (!Number.isInteger(raw) || !Number.isInteger(other)) return bad("int");
			return ok(raw === other);
		}
		case "map": {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw))
				return bad("map");
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(raw)) {
				if (typeof v !== "string") return bad("map");
				out[k] = v;
			}
			return ok(out);
		}
	}
}

function readField(
	root: unknown,
	field: string,
	spec: FieldSpec,
): Result<unknown> {
	const tokens = tryParse(spec.path);
	if (!tokens) return fail({ kind: "bad_path", field, path: spec.path });
	const raw = getPath(root, tokens);
	if (raw === undefined) {
		if (!spec.optional)
			return fail({ kind: "missing_path", field, path: spec.path });
		return ok(spec.default); // undefined when there is no default: the caller leaves the key out
	}
	return convert(root, field, spec, raw);
}

function buildFields(
	root: unknown,
	fields: Record<string, FieldSpec>,
): Result<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const [name, spec] of Object.entries(fields)) {
		const r = readField(root, name, spec);
		if (!r.ok) return r;
		if (r.value !== undefined) out[name] = r.value;
	}
	return ok(out);
}

/** `stripe/invoice.paid@v1`: the label a fact's `source.mapping` carries. */
export function mappingLabel(mapping: Mapping): string {
	return `${mapping.source}/${mapping.event}@v${mapping.v}`;
}

/** The envelope labels for a mapping: what the ledger records next to each fact. */
export function mappingLabels(mapping: Mapping): {
	mapping: string;
	stripe_api_version: string;
} {
	return {
		mapping: mappingLabel(mapping),
		stripe_api_version: mapping.stripeApiVersion,
	};
}

/**
 * Normalizes one raw Stripe event with a mapping. Refuses an event whose type or `api_version` is not the mapping's.
 * `ctx.eventId` is the stored input event's id; it goes into `source` on the fact.
 */
export function normalize(
	event: unknown,
	mapping: Mapping,
	ctx: NormalizeContext,
): Result<Fact> {
	const type = getPath(event, "$.type");
	if (type !== mapping.event)
		return fail({
			kind: "event_type",
			expected: mapping.event,
			got: type ?? null,
		});
	const apiVersion = getPath(event, "$.api_version");
	if (apiVersion !== mapping.stripeApiVersion)
		return fail({
			kind: "api_version",
			expected: mapping.stripeApiVersion,
			got: apiVersion ?? null,
		});

	const fields = buildFields(event, mapping.fields);
	if (!fields.ok) return fields;
	const source: FactSource = {
		eventId: ctx.eventId,
		mapping: mappingLabel(mapping),
		stripeApiVersion: mapping.stripeApiVersion,
	};
	const body: Record<string, unknown> = { source, ...fields.value };

	if (mapping.lines) {
		const rawLines = getPath(event, mapping.lines.path);
		if (!Array.isArray(rawLines))
			return fail({
				kind: "missing_path",
				field: "lines",
				path: mapping.lines.path,
			});
		const lines: InvoiceLine[] = [];
		for (const raw of rawLines) {
			const line = buildFields(raw, mapping.lines.fields);
			if (!line.ok) return line;
			// A line (API 2025-10-29.clover) has no interval of its own; the menu says it once the line is matched.
			lines.push({
				kind: "unknown",
				interval: null,
				...line.value,
			} as InvoiceLine);
		}
		body.lines = lines;
	}
	return ok(body as unknown as Fact);
}

/**
 * Applies the menu to invoice lines: a line matches a menu item by its lookup key, else by its price id (the caller puts
 * both kinds of key in `itemByKey`). The lookup key and price id stay on the line. A line that matches nothing stays
 * `kind: "unknown"`.
 */
export function resolveLines(
	lines: readonly InvoiceLine[],
	itemByKey: ReadonlyMap<string, LineItem>,
): InvoiceLine[] {
	return lines.map((line): InvoiceLine => {
		const { tierId: _tier, addonId: _addon, ...rest } = line;
		const item =
			(line.lookupKey ? itemByKey.get(line.lookupKey) : undefined) ??
			(line.priceId ? itemByKey.get(line.priceId) : undefined);
		if (!item) return { ...rest, kind: "unknown" };
		// What the line lacks, the menu's item gives: its price's lookup key, interval and gift kind.
		const known = {
			...rest,
			lookupKey: line.lookupKey ?? item.lookupKey ?? null,
			interval: line.interval ?? item.interval,
			...(item.kind === "addon" && item.gift
				? { gift: line.gift ?? item.gift }
				: {}),
		};
		return item.kind === "tier"
			? { ...known, kind: "tier", tierId: item.tierId }
			: { ...known, kind: "addon", addonId: item.addonId };
	});
}

/** An invoice with its lines resolved against the menu. */
export function resolveInvoice(
	invoice: BillingInvoice,
	itemByKey: ReadonlyMap<string, LineItem>,
): BillingInvoice {
	return { ...invoice, lines: resolveLines(invoice.lines, itemByKey) };
}

const removeAt = (root: unknown, tokens: PathToken[]): void => {
	const last = tokens[tokens.length - 1];
	if (last === undefined) return;
	const parent = getPath(root, tokens.slice(0, -1));
	if (parent === null || typeof parent !== "object") return;
	if (typeof last === "number") {
		if (Array.isArray(parent) && last < parent.length) parent.splice(last, 1);
	} else {
		delete (parent as Record<string, unknown>)[last];
	}
};

/**
 * A deep copy of the raw event with exactly the mapping's `personal` paths removed. The input is not changed. Throws on a
 * malformed personal path, which is a bad mapping file (the tests check every mapping).
 */
export function redactPersonal(payload: unknown, mapping: Mapping): unknown {
	const out = structuredClone(payload);
	for (const p of mapping.personal) {
		const tokens = tryParse(p);
		if (!tokens)
			throw new Error(`bad personal path in ${mappingLabel(mapping)}: ${p}`);
		removeAt(out, tokens);
	}
	return out;
}

/** The mapping for an event type and Stripe API version. An unknown pair is refused, never guessed. */
export function mappingFor(
	eventType: string,
	apiVersion: string,
): Result<Mapping> {
	const hit = MAPPINGS.find(
		(m) => m.event === eventType && m.stripeApiVersion === apiVersion,
	);
	if (hit) return ok(hit);
	return fail({
		kind: "unknown_mapping",
		event: eventType,
		apiVersion,
		known: MAPPINGS.filter((m) => m.event === eventType).map(
			(m) => m.stripeApiVersion,
		),
	});
}

/** Every mapping file this package ships (generated index: `bun schema/mapping/build.ts`). */
export const MAPPINGS: readonly Mapping[] =
	MAPPING_FILES as unknown as readonly Mapping[];

export type {
	Fact,
	FieldSpec,
	FieldType,
	LineItem,
	Mapping,
	NormalizeContext,
	NormalizeError,
	Result,
};
