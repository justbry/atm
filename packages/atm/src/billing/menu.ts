/**
 * The school's menu: validation and the public view. Pure. The JSON Schema (`schema/catalog/menu.v1.json`) carries the
 * limits of the family service's `MenuSchema`; `validateMenu` adds the rules a schema cannot say (the family service's
 * `menuProblems`, plus the web editor's duplicate-name rules).
 */
import {
	Ajv2020,
	type ErrorObject,
	type ValidateFunction,
} from "ajv/dist/2020.js";
import menuSchema from "../../schema/catalog/menu.v1.json";
import type { Menu, MenuTier, MenuValidation } from "./types.js";

export const MAX_TIERS = 4;
export const MAX_ADDONS = 6;
export const MAX_FEATURES = 12;
/** A tier sold in quantities offers at most this many counts, each from 1 to `MAX_QUANTITY`. */
export const MAX_QUANTITIES = 6;
export const MAX_QUANTITY = 50;
/**
 * Stripe refuses an amount above 99,999,999 (in the currency's smallest unit). A tier's price is per unit, so the largest
 * count it is sold in has to keep the line's total under it, or the checkout is refused at Stripe, not here.
 */
export const MAX_LINE_TOTAL = 99_999_999;

/** The counts a tier is sold in: its `quantities`, else one at a time. */
export const quantitiesOf = (tier: MenuTier): readonly number[] =>
	tier.quantities ?? [1];

let compiled: ValidateFunction | null = null;
const validator = (): ValidateFunction => {
	compiled ??= new Ajv2020({ allErrors: true, strict: false }).compile(
		menuSchema,
	);
	return compiled;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const trimStr = (v: unknown): unknown => (typeof v === "string" ? v.trim() : v);

/** Copy with the text fields trimmed (the family service trims on decode); anything not the right shape is left for the schema to refuse. */
function trimmed(input: unknown): unknown {
	if (!isObj(input)) return input;
	const each = (
		v: unknown,
		f: (o: Record<string, unknown>) => Record<string, unknown>,
	) => (Array.isArray(v) ? v.map((x) => (isObj(x) ? f(x) : x)) : v);
	return {
		...input,
		currency:
			typeof input.currency === "string"
				? input.currency.trim().toLowerCase()
				: input.currency,
		features: each(input.features, (f) => ({
			...f,
			name: trimStr(f.name),
			unit: isObj(f.unit)
				? { ...f.unit, one: trimStr(f.unit.one), other: trimStr(f.unit.other) }
				: f.unit,
		})),
		tiers: each(input.tiers, (t) => ({
			...t,
			name: trimStr(t.name),
			blurb: trimStr(t.blurb),
		})),
		addons: each(input.addons, (a) => ({ ...a, name: trimStr(a.name) })),
	};
}

const pathOf = (e: ErrorObject): string => {
	const base = e.instancePath.split("/").slice(1).join(".");
	const extra =
		e.keyword === "required"
			? String((e.params as { missingProperty: string }).missingProperty)
			: e.keyword === "additionalProperties"
				? String(
						(e.params as { additionalProperty: string }).additionalProperty,
					)
				: "";
	return [base, extra].filter(Boolean).join(".") || "menu";
};

/** An IANA zone the runtime knows (`Intl` throws for any other name). */
export function validTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

const dup = (xs: string[]) => new Set(xs).size !== xs.length;

/** The rules a schema cannot say, on a menu that passed the schema. Dotted paths of what fails. */
function crossProblems(m: Menu): string[] {
	const bad: string[] = [];
	if (!validTimeZone(m.timeZone)) bad.push("timeZone");
	if (dup(m.features.map((f) => f.id))) bad.push("features");
	m.features.forEach((f, i) => {
		if (
			m.features.findIndex(
				(g) => g.name.toLowerCase() === f.name.toLowerCase(),
			) !== i
		)
			bad.push(`features.${i}.name`);
	});
	if (dup(m.tiers.map((t) => t.id))) bad.push("tiers");
	m.tiers.forEach((t, i) => {
		if (
			m.tiers.findIndex(
				(g) => g.name.toLowerCase() === t.name.toLowerCase(),
			) !== i
		)
			bad.push(`tiers.${i}.name`);
	});
	if (dup(m.addons.map((a) => a.id))) bad.push("addons");
	const featureIds = new Set(m.features.map((f) => f.id));
	const grants = (base: string, gs: Menu["tiers"][number]["grants"]) => {
		if (gs.some((g) => !featureIds.has(g.featureId))) bad.push(base);
		if (dup(gs.map((g) => g.featureId))) bad.push(base);
	};
	m.tiers.forEach((t, i) => {
		if (dup(t.prices.map((p) => p.interval))) bad.push(`tiers.${i}.prices`);
		grants(`tiers.${i}.grants`, t.grants);
		// The schema has each count unique and in range; the order is for the buyer's picker and stable diffs.
		const counts = t.quantities ?? [];
		if (counts.some((q, j) => j > 0 && q <= (counts[j - 1] ?? 0)))
			bad.push(`tiers.${i}.quantities`);
		const largest = Math.max(1, ...counts);
		t.prices.forEach((p, j) => {
			if (typeof p.amount === "number" && p.amount * largest > MAX_LINE_TOTAL)
				bad.push(`tiers.${i}.prices.${j}.amount`);
		});
	});
	m.addons.forEach((a, i) => {
		grants(`addons.${i}.grants`, a.grants);
		if (!a.gift) return;
		// A gift is one purchase: sessions are the grants, a dollar certificate holds none.
		if (a.price.every !== "once") bad.push(`addons.${i}.gift`);
		if ((a.gift === "sessions") === (a.grants.length === 0))
			bad.push(`addons.${i}.grants`);
	});
	return bad;
}

/** Checks an unknown value against the menu schema and the cross-field rules. On success the menu has trimmed text. */
export function validateMenu(input: unknown): MenuValidation {
	const value = trimmed(input);
	const validate = validator();
	if (!validate(value))
		return {
			ok: false,
			problems: [...new Set((validate.errors ?? []).map(pathOf))],
		};
	const menu = value as Menu;
	const bad = [...new Set(crossProblems(menu))];
	return bad.length ? { ok: false, problems: bad } : { ok: true, menu };
}

/** What stops a valid menu from being published: nothing to sell, or no public tier. Dotted paths. */
export function publishProblems(menu: Menu): string[] {
	return menu.tiers.some((t) => t.public) ? [] : ["tiers"];
}

/** What a visitor may see: tiers the school did not make public are drafts, left out and never sold. */
export const publicMenu = (m: Menu): Menu => ({
	...m,
	tiers: m.tiers.filter((t) => t.public),
});

export type { MenuValidation };
