/**
 * FEASIBILITY SPIKE, test helper only (not public API, nothing in `src/` changes): a loader and applier for the
 * proposed usage mapping (`schema/mapping/usage.schema.json`). It reuses what `src/billing/normalize.ts` already
 * exports (`parsePath`, `getPath`, `redactPersonal`) and `src/ledger/util.ts` (`decimalToUnits`, `unitsToDecimal`);
 * everything else here is the part a real implementation would add. Pure: no clock (the caller passes `ingestMs`),
 * no network, no randomness. The one piece of state is the cardinality guard the caller owns.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import usageSchema from "../../schema/mapping/usage.schema.json";
import {
	getPath,
	type Mapping,
	type PathToken,
	parsePath,
	redactPersonal,
} from "../../src/billing/normalize.js";
import { ledgerEvent } from "../../src/ledger/postings.js";
import {
	canonicalize,
	decimalToUnits,
	sha256Hex,
	unitsToDecimal,
} from "../../src/ledger/util.js";
import type { AtmEvent, AtmEventType } from "../../src/types.js";

// ---- the mapping file ----

type Path = string;
type LabelSpec = {
	path: Path;
	type?: "string" | "int" | "bool";
	optional?: boolean;
	default?: string | number | boolean;
	values?: string[];
	onUnknown?: "other" | "reject";
	other?: string;
	maxDistinct?: number;
	maxLength?: number;
};
type QuantitySpec = {
	path?: Path;
	type: "int" | "decimal";
	unit: string;
	meaning: string;
	scale?: number;
	rawPlaces?: number;
	minus?: string[];
	optional?: boolean;
	default?: number | string;
	min?: number | string;
	max?: number | string;
};
export type UsageMapping = {
	v: number;
	source: string;
	event: string;
	sourceVersion?: { path: Path; equals: string };
	id: { path: Path; type?: "string" | "int"; onRepeat?: "first" | "max" };
	time: {
		path: Path;
		type: "seconds" | "millis" | "iso";
		late?: { afterSeconds: number; policy: "flag" | "reject" };
	};
	holder: { path: Path; prefix: string; type?: "string" | "int" };
	labels: Record<string, LabelSpec>;
	quantities: Record<string, QuantitySpec>;
	personal: Path[];
	ignore?: Path[];
};

export class UsageMappingError extends Error {}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(usageSchema);

const tryParse = (path: string): PathToken[] | null => {
	try {
		return parsePath(path);
	} catch {
		return null;
	}
};

/** Whether `path` is `ancestor` or lies under it. */
const isUnder = (path: PathToken[], ancestor: PathToken[]): boolean =>
	ancestor.length <= path.length &&
	ancestor.every((token, index) => token === path[index]);

/** Every path a mapping reads, with whether the event must have it. */
const readPaths = (
	mapping: UsageMapping,
): { field: string; path: Path; required: boolean }[] => {
	const reads = [
		...(mapping.sourceVersion
			? [{ field: "sourceVersion", path: mapping.sourceVersion.path }]
			: []),
		{ field: "id", path: mapping.id.path },
		{ field: "time", path: mapping.time.path },
		{ field: "holder", path: mapping.holder.path },
	].map((read) => ({ ...read, required: true }));
	for (const [name, spec] of Object.entries(mapping.labels))
		reads.push({
			field: `labels.${name}`,
			path: spec.path,
			required: !spec.optional && spec.default === undefined,
		});
	for (const [name, spec] of Object.entries(mapping.quantities))
		if (spec.path)
			reads.push({
				field: `quantities.${name}`,
				path: spec.path,
				required: !spec.optional && spec.default === undefined,
			});
	return reads;
};

/** What the JSON schema cannot say. Empty when the mapping is sound. */
const mappingIssues = (mapping: UsageMapping): string[] => {
	const issues: string[] = [];
	const personalTokens = mapping.personal
		.map((path) => tryParse(path))
		.filter((tokens): tokens is PathToken[] => tokens !== null);
	for (const read of readPaths(mapping)) {
		const tokens = tryParse(read.path);
		if (!tokens) {
			issues.push(`${read.field}: malformed path ${read.path}`);
			continue;
		}
		if (personalTokens.some((hidden) => isUnder(tokens, hidden)))
			issues.push(
				`${read.field} reads ${read.path}, which is under a personal path: it would not survive redaction`,
			);
	}
	for (const [name, spec] of Object.entries(mapping.labels))
		if (spec.path === mapping.id.path || spec.path === mapping.holder.path)
			issues.push(
				`labels.${name} reads the id or holder path ${spec.path}: request ids and user ids go in idem and key, never in labels`,
			);
	for (const path of [...mapping.personal, ...(mapping.ignore ?? [])])
		if (!tryParse(path)) issues.push(`malformed path ${path}`);
	for (const [name, spec] of Object.entries(mapping.labels)) {
		if (spec.values && typeof spec.default === "string") {
			if (!spec.values.includes(spec.default))
				issues.push(`labels.${name}: default is not one of values`);
		}
		if (spec.other !== undefined && spec.values?.includes(spec.other))
			issues.push(
				`labels.${name}: the other bucket is also an enumerated value`,
			);
	}
	for (const [name, spec] of Object.entries(mapping.quantities)) {
		if (spec.type === "decimal" && (spec.scale ?? 0) < (spec.rawPlaces ?? 0))
			issues.push(`quantities.${name}: scale is below rawPlaces`);
		for (const other of spec.minus ?? []) {
			const target = mapping.quantities[other];
			if (!target)
				issues.push(`quantities.${name}: minus names unknown ${other}`);
			else if (target.minus?.length)
				issues.push(
					`quantities.${name}: minus ${other}, which itself has minus`,
				);
			else if (target.type !== "int" || spec.type !== "int")
				issues.push(`quantities.${name}: minus works on int quantities only`);
		}
	}
	return issues;
};

/** The mapping, or a UsageMappingError that lists every reason it is refused. */
export const loadUsageMapping = (raw: unknown): UsageMapping => {
	if (!validateSchema(raw)) {
		const reasons = (validateSchema.errors ?? []).map(
			(error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`,
		);
		throw new UsageMappingError(
			`usage mapping fails usage.schema.json: ${reasons.join("; ")}`,
		);
	}
	const mapping = raw as unknown as UsageMapping;
	const issues = mappingIssues(mapping);
	if (issues.length > 0)
		throw new UsageMappingError(
			`usage mapping is unsound: ${issues.join("; ")}`,
		);
	return mapping;
};

/** `openai/llm.completion@v1`: the `mapping` label and payload field. */
export const usageMappingLabel = (mapping: UsageMapping): string =>
	`${mapping.source}/${mapping.event}@v${mapping.v}`;

// ---- cardinality ----

/**
 * Remembers the distinct values each free-form label has taken per school, and refuses a new one past the label's
 * `maxDistinct`. Enumerated labels (`values`) need no memory: they cannot grow. In production this is a table
 * (school, label, value) with a primary key, in the same transaction as the outbox insert; here it is a Map.
 */
export class LabelCardinalityGuard {
	private readonly seen = new Map<string, Set<string>>();
	private bucket(school: string, label: string): Set<string> {
		const key = `${school}\u0000${label}`;
		let values = this.seen.get(key);
		if (!values) {
			values = new Set();
			this.seen.set(key, values);
		}
		return values;
	}
	canAdmit(school: string, label: string, value: string, max: number): boolean {
		const values = this.bucket(school, label);
		return values.has(value) || values.size < max;
	}
	record(school: string, label: string, value: string): void {
		this.bucket(school, label).add(value);
	}
	distinct(school: string, label: string): number {
		return this.bucket(school, label).size;
	}
}

// ---- the fact ----

export type UsageFact = {
	source: string;
	event: string;
	mapping: string;
	holder: string;
	idem: string;
	requestId: string;
	eventTimeMs: number;
	late?: true;
	labels: Record<string, string>;
	/** Whole numbers as JSON integers; decimals as strings with the mapping's number of places. */
	quantities: Record<string, number | string>;
	units: Record<string, string>;
};

export type UsageError =
	| { kind: "missing_path"; field: string; path: string }
	| { kind: "bad_type"; field: string; path: string; expected: string }
	| { kind: "bad_value"; field: string; path: string; reason: string }
	| {
			kind: "unknown_label_value";
			field: string;
			path: string;
			value: string | null;
	  }
	| { kind: "cardinality"; field: string; path: string; max: number }
	| { kind: "source_version"; path: string; expected: string }
	| { kind: "too_late"; field: string; path: string; ageSeconds: number };

export type UsageResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: UsageError };

export type UsageContext = {
	school: string;
	ingestMs: number;
	guard?: LabelCardinalityGuard;
};

const ok = <T>(value: T): UsageResult<T> => ({ ok: true, value });
const fail = (error: UsageError): { ok: false; error: UsageError } => ({
	ok: false,
	error,
});

/** A label value, id or holder may use only these characters: no `@`, space, comma or newline, so an email cannot ride in one and hledger tags stay whole. */
const SAFE_TOKEN = /^[A-Za-z0-9_.:/-]+$/;
const MAX_ID_LENGTH = 128;
const DEFAULT_LABEL_LENGTH = 64;
const OTHER_BUCKET = "other";
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const describeValue = (value: string): string | null =>
	SAFE_TOKEN.test(value) && value.length <= DEFAULT_LABEL_LENGTH ? value : null;

const readToken = (
	event: unknown,
	field: string,
	path: string,
	type: "string" | "int" | undefined,
): UsageResult<string> => {
	const raw = getPath(event, path);
	if (raw === undefined) return fail({ kind: "missing_path", field, path });
	const text =
		type === "int"
			? Number.isSafeInteger(raw)
				? String(raw)
				: null
			: typeof raw === "string"
				? raw
				: null;
	if (text === null)
		return fail({ kind: "bad_type", field, path, expected: type ?? "string" });
	if (
		text.length === 0 ||
		text.length > MAX_ID_LENGTH ||
		!SAFE_TOKEN.test(text)
	)
		return fail({
			kind: "bad_value",
			field,
			path,
			reason:
				"empty, too long or has characters outside A-Z a-z 0-9 _ . : / - (value not shown)",
		});
	return ok(text);
};

const readTime = (
	event: unknown,
	mapping: UsageMapping,
	ctx: UsageContext,
): UsageResult<{ ms: number; late: boolean }> => {
	const { path, type, late } = mapping.time;
	const raw = getPath(event, path);
	if (raw === undefined)
		return fail({ kind: "missing_path", field: "time", path });
	let ms: number | null = null;
	if (type === "iso") {
		if (typeof raw === "string" && ISO_INSTANT.test(raw)) {
			const parsed = Date.parse(raw);
			ms = Number.isNaN(parsed) ? null : parsed;
		}
	} else if (Number.isSafeInteger(raw)) {
		ms = type === "seconds" ? (raw as number) * 1000 : (raw as number);
	}
	if (ms === null || ms <= 0)
		return fail({ kind: "bad_type", field: "time", path, expected: type });
	if (ms > ctx.ingestMs + MAX_FUTURE_SKEW_MS)
		return fail({
			kind: "bad_value",
			field: "time",
			path,
			reason: "is in the future",
		});
	const ageSeconds = Math.floor((ctx.ingestMs - ms) / 1000);
	const isLate = late !== undefined && ageSeconds > late.afterSeconds;
	if (isLate && late.policy === "reject")
		return fail({ kind: "too_late", field: "time", path, ageSeconds });
	return ok({ ms, late: isLate });
};

type Pending = { label: string; value: string };

const readLabel = (
	event: unknown,
	name: string,
	spec: LabelSpec,
	ctx: UsageContext,
	pending: Pending[],
): UsageResult<string | undefined> => {
	const field = `labels.${name}`;
	const raw = getPath(event, spec.path);
	let text: string;
	if (raw === undefined) {
		if (spec.default !== undefined) text = String(spec.default);
		else if (spec.optional) return ok(undefined);
		else return fail({ kind: "missing_path", field, path: spec.path });
	} else {
		const type = spec.type ?? "string";
		const converted =
			type === "string" && typeof raw === "string"
				? raw
				: type === "int" && Number.isSafeInteger(raw)
					? String(raw)
					: type === "bool" && typeof raw === "boolean"
						? String(raw)
						: null;
		if (converted === null)
			return fail({ kind: "bad_type", field, path: spec.path, expected: type });
		text = converted;
	}
	const maxLength = spec.maxLength ?? DEFAULT_LABEL_LENGTH;
	if (text.length === 0 || text.length > maxLength || !SAFE_TOKEN.test(text))
		return fail({
			kind: "bad_value",
			field,
			path: spec.path,
			reason:
				"empty, too long or has characters outside A-Z a-z 0-9 _ . : / - (value not shown)",
		});
	const bucket = spec.other ?? OTHER_BUCKET;
	if (spec.values) {
		if (spec.values.includes(text)) return ok(text);
		if (spec.onUnknown === "other") return ok(bucket);
		return fail({
			kind: "unknown_label_value",
			field,
			path: spec.path,
			value: describeValue(text),
		});
	}
	const max = spec.maxDistinct as number;
	if (ctx.guard && !ctx.guard.canAdmit(ctx.school, name, text, max)) {
		if (spec.onUnknown === "other") return ok(bucket);
		return fail({ kind: "cardinality", field, path: spec.path, max });
	}
	pending.push({ label: name, value: text });
	return ok(text);
};

type Units = bigint;

const decimalUnits = (
	field: string,
	spec: QuantitySpec,
	raw: unknown,
): UsageResult<Units> => {
	const path = spec.path ?? "(constant)";
	const scale = spec.scale as number;
	if (spec.rawPlaces !== undefined) {
		if (!Number.isSafeInteger(raw))
			return fail({ kind: "bad_type", field, path, expected: "integer ticks" });
		return ok(BigInt(raw as number) * 10n ** BigInt(scale - spec.rawPlaces));
	}
	const text =
		typeof raw === "string"
			? raw
			: typeof raw === "number" && Number.isFinite(raw)
				? String(raw)
				: null;
	if (text === null || !PLAIN_DECIMAL.test(text))
		return fail({
			kind: "bad_type",
			field,
			path,
			expected: "plain decimal (a string, or a number without exponent)",
		});
	try {
		return ok(decimalToUnits(text, scale));
	} catch {
		return fail({
			kind: "bad_value",
			field,
			path,
			reason: `has more than ${scale} decimal places (refused, not rounded)`,
		});
	}
};

const readQuantity = (
	event: unknown,
	name: string,
	spec: QuantitySpec,
	done: Record<string, number | string>,
): UsageResult<number | string> => {
	const field = `quantities.${name}`;
	const path = spec.path ?? "(constant)";
	const raw = spec.path ? getPath(event, spec.path) : undefined;
	let value: unknown = raw;
	if (raw === undefined) {
		if (spec.default === undefined) {
			if (!spec.optional) return fail({ kind: "missing_path", field, path });
			return ok(Number.NaN); // optional, no default: the caller leaves the key out
		}
		value = spec.default;
	}
	if (spec.type === "int") {
		if (!Number.isSafeInteger(value))
			return fail({ kind: "bad_type", field, path, expected: "int" });
		let result = value as number;
		for (const other of spec.minus ?? []) result -= done[other] as number;
		const min = typeof spec.min === "number" ? spec.min : 0;
		if (result < min)
			return fail({
				kind: "bad_value",
				field,
				path,
				reason:
					(spec.minus?.length ?? 0) > 0
						? `is below ${min} after subtracting ${(spec.minus ?? []).join(", ")}`
						: `is below the minimum ${min}`,
			});
		if (typeof spec.max === "number" && result > spec.max)
			return fail({
				kind: "bad_value",
				field,
				path,
				reason: `is above ${spec.max}`,
			});
		return ok(result);
	}
	const units = decimalUnits(field, spec, value);
	if (!units.ok) return units;
	const scale = spec.scale as number;
	const min = decimalToUnits(String(spec.min ?? "0"), scale);
	if (units.value < min)
		return fail({
			kind: "bad_value",
			field,
			path,
			reason: `is below the minimum ${spec.min ?? 0}`,
		});
	if (
		spec.max !== undefined &&
		units.value > decimalToUnits(String(spec.max), scale)
	)
		return fail({
			kind: "bad_value",
			field,
			path,
			reason: `is above ${spec.max}`,
		});
	return ok(unitsToDecimal(units.value, scale));
};

const byKey = <T>(record: Record<string, T>): Record<string, T> =>
	Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);

/**
 * One raw usage event to a fact. The school comes from `ctx` (the authenticated ingest endpoint), never from the
 * payload. An event that fails is not partly applied: the cardinality guard only learns the labels of events that
 * succeed.
 */
export const normalizeUsage = (
	event: unknown,
	mapping: UsageMapping,
	ctx: UsageContext,
): UsageResult<UsageFact> => {
	if (mapping.sourceVersion) {
		const got = getPath(event, mapping.sourceVersion.path);
		if (got !== mapping.sourceVersion.equals)
			return fail({
				kind: "source_version",
				path: mapping.sourceVersion.path,
				expected: mapping.sourceVersion.equals,
			});
	}
	const id = readToken(event, "id", mapping.id.path, mapping.id.type);
	if (!id.ok) return id;
	const holder = readToken(
		event,
		"holder",
		mapping.holder.path,
		mapping.holder.type,
	);
	if (!holder.ok) return holder;
	const time = readTime(event, mapping, ctx);
	if (!time.ok) return time;

	const pending: Pending[] = [];
	const labels: Record<string, string> = {};
	for (const [name, spec] of Object.entries(mapping.labels)) {
		const label = readLabel(event, name, spec, ctx, pending);
		if (!label.ok) return label;
		if (label.value !== undefined) labels[name] = label.value;
	}

	// Quantities that subtract others come second, so what they subtract is already read.
	const names = Object.keys(mapping.quantities);
	const ordered = [
		...names.filter((name) => !mapping.quantities[name]?.minus?.length),
		...names.filter((name) => mapping.quantities[name]?.minus?.length),
	];
	const quantities: Record<string, number | string> = {};
	const units: Record<string, string> = {};
	for (const name of ordered) {
		const spec = mapping.quantities[name] as QuantitySpec;
		const quantity = readQuantity(event, name, spec, quantities);
		if (!quantity.ok) return quantity;
		if (typeof quantity.value === "number" && Number.isNaN(quantity.value))
			continue;
		quantities[name] = quantity.value;
		units[name] = spec.unit;
	}

	if (ctx.guard)
		for (const { label, value } of pending)
			ctx.guard.record(ctx.school, label, value);

	return ok({
		source: mapping.source,
		event: mapping.event,
		mapping: usageMappingLabel(mapping),
		holder: `${mapping.holder.prefix}${holder.value}`,
		idem: `usage:${mapping.source}/${mapping.event}:${id.value}`,
		requestId: id.value,
		eventTimeMs: time.value.ms,
		...(time.value.late ? { late: true as const } : {}),
		labels: byKey(labels),
		quantities: byKey(quantities),
		units: byKey(units),
	});
};

/** The fact, or an Error whose message names the field and the path. */
export const unwrapUsage = (result: UsageResult<UsageFact>): UsageFact => {
	if (!result.ok) throw new Error(describeUsageError(result.error));
	return result.value;
};

export const describeUsageError = (error: UsageError): string => {
	switch (error.kind) {
		case "missing_path":
			return `the event has nothing at ${error.path} (the mapping's ${error.field})`;
		case "bad_type":
			return `${error.path} (the mapping's ${error.field}) is not a ${error.expected}`;
		case "bad_value":
			return `${error.path} (the mapping's ${error.field}) ${error.reason}`;
		case "unknown_label_value":
			return `${error.path} (the mapping's ${error.field}) holds ${error.value === null ? "a value that is not shown" : JSON.stringify(error.value)}, which is not in the mapping's values and the mapping rejects unknown values`;
		case "cardinality":
			return `${error.path} (the mapping's ${error.field}) would be a new value past the limit of ${error.max} distinct values per school; the event is quarantined, not recorded`;
		case "source_version":
			return `the event is not at source version ${error.expected} (read at ${error.path}); atm does not guess a second shape`;
		case "too_late":
			return `${error.path} (the mapping's ${error.field}) is ${error.ageSeconds} seconds old at ingest, past the mapping's late limit`;
	}
};

// ---- redaction (reuses the Stripe path remover) ----

/** A copy of the raw event with the mapping's `personal` paths removed. `redactPersonal` reads only `source`, `event`, `v` and `personal`. */
export const redactUsage = (event: unknown, mapping: UsageMapping): unknown =>
	redactPersonal(event, {
		v: mapping.v,
		source: mapping.source,
		event: mapping.event,
		personal: mapping.personal,
	} as unknown as Mapping);

// ---- repeats (streaming): collapse before the ledger ----

export type UsageConflict = {
	idem: string;
	quantity: string;
	from: number | string;
	to: number | string;
};

/**
 * Several facts with one idem become one. `first` keeps the first (what the ledger's outbox would do anyway); `max`
 * takes each quantity's largest value, so a response whose usage is logged three times with growing counts is
 * counted once at its final count. A later value below an earlier one is reported as a conflict (usage should only
 * grow within a response). Order of first appearance is kept.
 */
export const collapseRepeats = (
	facts: readonly UsageFact[],
	mapping: UsageMapping,
): { facts: UsageFact[]; conflicts: UsageConflict[] } => {
	const byIdem = new Map<string, UsageFact>();
	const conflicts: UsageConflict[] = [];
	for (const fact of facts) {
		const kept = byIdem.get(fact.idem);
		if (!kept) {
			byIdem.set(fact.idem, fact);
			continue;
		}
		if (mapping.id.onRepeat !== "max") continue;
		const merged: Record<string, number | string> = { ...kept.quantities };
		for (const [name, value] of Object.entries(fact.quantities)) {
			const before = kept.quantities[name];
			if (before === undefined) {
				merged[name] = value;
				continue;
			}
			const spec = mapping.quantities[name] as QuantitySpec;
			const scale = spec.scale ?? 0;
			const larger =
				typeof value === "number"
					? value > (before as number)
					: decimalToUnits(value, scale) >
						decimalToUnits(before as string, scale);
			if (larger) merged[name] = value;
			else if (value !== before)
				conflicts.push({
					idem: fact.idem,
					quantity: name,
					from: before,
					to: value,
				});
		}
		byIdem.set(fact.idem, { ...kept, quantities: byKey(merged) });
	}
	return { facts: [...byIdem.values()], conflicts };
};

// ---- exact sums ----

/** Sums a quantity over facts without a float: whole numbers as BigInt, decimals in units of 10^-scale. */
export const sumQuantity = (
	facts: readonly UsageFact[],
	name: string,
	scale = 0,
): string => {
	let total = 0n;
	for (const fact of facts) {
		const value = fact.quantities[name];
		if (value === undefined) continue;
		total +=
			typeof value === "number" ? BigInt(value) : decimalToUnits(value, scale);
	}
	return unitsToDecimal(total, scale);
};

// ---- the ledger envelope ----

/**
 * The ledger event for a fact. `ledgerEvent` is the public builder over `buildEvent`, but its type is a closed union and
 * its `moneyPostings` throws on a type it does not know, so the spike builds a no-posting event (`policy.published`)
 * and renames it. The id does not depend on the type (seed: school and idem), so the rename changes nothing else.
 */
/** The ledger payload schema version this helper writes (`schema/payload-proposed/usage.recorded.v1.json`). */
export const USAGE_PAYLOAD_SCHEMA = 1;

/** sha256 of the mapping file's canonical JSON: `mapping` names the file, the digest proves which bytes ran. */
export const mappingDigest = (mapping: UsageMapping): string =>
	sha256Hex(canonicalize(mapping));

/** sha256 of the raw event with the mapping's personal paths removed: the key of the stored, redacted raw copy. */
export const rawDigest = (raw: unknown, mapping: UsageMapping): string =>
	sha256Hex(canonicalize(redactUsage(raw, mapping)));

export type UsageEventContext = {
	school: string;
	tz: string;
	ingestMs: number;
	/** The mapping that made the fact and the raw event it was made from: both only for the provenance fields. */
	mapping: UsageMapping;
	raw: unknown;
	/** Set when this event re-maps an earlier one: its idem gets a suffix (the original's idem is taken) and `cause` is the original's id. */
	remapOf?: AtmEvent;
};

/**
 * The ledger event for a fact. `ledgerEvent` is the public builder over `buildEvent`, but its type is a closed union and
 * its `moneyPostings` throws on a type it does not know, so the spike builds a no-posting event (`policy.published`)
 * and renames it. The id does not depend on the type (seed: school and idem), so the rename changes nothing else.
 *
 * Provenance lives in the payload (`payload_schema`, `mapping`, `mapping_digest`, `raw_sha256`) and `mapping` is also
 * a label, as the Stripe mappings already do (`mappingLabels`): the envelope itself needs no new field.
 */
export const usageLedgerEvent = (
	fact: UsageFact,
	ctx: UsageEventContext,
): AtmEvent => {
	const base = ledgerEvent({
		type: "policy.published",
		school: ctx.school,
		tz: ctx.tz,
		eventTime: fact.eventTimeMs,
		ingestTime: ctx.ingestMs,
		source: fact.source,
		key: fact.holder,
		idem: ctx.remapOf ? `${fact.idem}#remap@v${ctx.mapping.v}` : fact.idem,
		...(ctx.remapOf ? { cause: ctx.remapOf.id } : {}),
		labels: { mapping: fact.mapping, ...fact.labels },
		text: `usage ${fact.event}`,
		payload: {
			payload_schema: USAGE_PAYLOAD_SCHEMA,
			mapping: fact.mapping,
			mapping_digest: mappingDigest(ctx.mapping),
			raw_sha256: rawDigest(ctx.raw, ctx.mapping),
			request_id: fact.requestId,
			quantities: fact.quantities,
			units: fact.units,
			...(fact.late ? { late: true } : {}),
		},
	});
	return { ...base, event_type: "usage.recorded" as unknown as AtmEventType };
};

/**
 * Re-derives an event's fact from what is stored: the mapping named in its payload (looked up by label in `registry`,
 * digest-checked) and the stored redacted raw (looked up by `raw_sha256` in `rawStore`), at the event's own ingest
 * time (so `late` reproduces). Throws if the mapping is missing, its digest differs, or the raw is missing.
 */
export const rederiveFact = (
	event: AtmEvent,
	registry: ReadonlyMap<string, UsageMapping>,
	rawStore: ReadonlyMap<string, unknown>,
	mappingOverride?: UsageMapping,
): UsageFact => {
	const payload = event.payload as {
		mapping: string;
		mapping_digest: string;
		raw_sha256: string;
	};
	const mapping = mappingOverride ?? registry.get(payload.mapping);
	if (!mapping) throw new Error(`no mapping file for ${payload.mapping}`);
	if (!mappingOverride && mappingDigest(mapping) !== payload.mapping_digest)
		throw new Error(
			`${payload.mapping} is not the file that ran: digest ${mappingDigest(mapping)} is not ${payload.mapping_digest}`,
		);
	if (!rawStore.has(payload.raw_sha256))
		throw new Error(`no stored raw event ${payload.raw_sha256}`);
	return unwrapUsage(
		normalizeUsage(rawStore.get(payload.raw_sha256), mapping, {
			school: event.school,
			ingestMs: Date.parse(event.ingest_time),
		}),
	);
};

// ---- the format contract (the agentlake "probe", as a check) ----

const normalizePathTokens = (tokens: PathToken[]): string[] =>
	tokens.map((token) => (typeof token === "number" ? "[]" : token));

/**
 * The key paths of an event, no values: `$.usage.prompt_tokens`, `$.messages[].content`. Array indexes collapse to
 * `[]` and the children of all elements merge. This is what a probe may print about a live event without leaking
 * content.
 */
export const keyPaths = (event: unknown): string[] => {
	const found = new Set<string>();
	const walk = (value: unknown, path: string): void => {
		if (Array.isArray(value)) {
			for (const item of value) walk(item, `${path}[]`);
			return;
		}
		if (value === null || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			found.add(`${path}.${key}`);
			walk(child, `${path}.${key}`);
		}
	};
	walk(event, "$");
	return [...found].sort();
};

const asKey = (path: string): string[] =>
	normalizePathTokens(tryParse(path) ?? []);

const startsWith = (path: string[], prefix: string[]): boolean =>
	prefix.length <= path.length &&
	prefix.every((part, index) => part === path[index]);

/** Splits a key path from `keyPaths` into tokens (`[]` stays one token). */
const splitKeyPath = (path: string): string[] =>
	path
		.slice(1)
		.replace(/\[\]/g, ".[]")
		.split(".")
		.filter((part) => part !== "");

export type ShapeDrift = {
	/** Keys the event has that the mapping neither reads, ignores nor marks personal. */
	unknown: string[];
	/** Required paths the event lacks. */
	missing: string[];
};

/**
 * Compares an event's key structure with what the mapping knows: paths it reads, `personal`, `ignore`. A key under
 * a known path (or a container of one) is known; any other key is `unknown`, which is how a provider's new field
 * (possibly personal) or a rename shows up. A required path that is absent is `missing`.
 */
export const shapeDrift = (
	event: unknown,
	mapping: UsageMapping,
): ShapeDrift => {
	const known = [
		...readPaths(mapping).map((read) => asKey(read.path)),
		...mapping.personal.map(asKey),
		...(mapping.ignore ?? []).map(asKey),
	];
	const unknown = keyPaths(event).filter((path) => {
		const parts = splitKeyPath(path);
		return !known.some(
			(entry) => startsWith(parts, entry) || startsWith(entry, parts),
		);
	});
	const missing = readPaths(mapping)
		.filter((read) => read.required && getPath(event, read.path) === undefined)
		.map((read) => read.path);
	return { unknown, missing };
};

/** Throws a message that lists the drift, for a contract test or a scheduled probe. */
export const assertNoDrift = (event: unknown, mapping: UsageMapping): void => {
	const { unknown, missing } = shapeDrift(event, mapping);
	if (unknown.length === 0 && missing.length === 0) return;
	throw new Error(
		`${usageMappingLabel(mapping)} format drift: unknown keys [${unknown.join(", ")}], missing required [${missing.join(", ")}]`,
	);
};
