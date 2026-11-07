/**
 * The knobs of a scenario. One table (`PARAMS`) says each knob's type, range, default and meaning; the JSON Schema that
 * validates an ad-hoc scenario, the `--set` parser, the error messages and `atm scenarios describe` are all made from it.
 * Every error says which knob, what was given, what is allowed and a fix, so an agent can correct itself in one step.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import {
	DEFAULT_ORG,
	isOrgKind,
	ORG_KINDS,
	ORGS,
	type OrgKind,
	tierIdsOf,
} from "./orgs.js";
import { BEFORE_UNIVERSITY_MENU } from "./school.js";

export type ScenarioParams = {
	months: number;
	start: string;
	members: number;
	newMembersPerMonth: number;
	tierMix: Record<string, number>;
	yearlyShare: number;
	addonRate: number;
	freeShare: number;
	churnRate: number;
	refundRate: number;
	partialRefundShare: number;
	disputeRate: number;
	disputeLostShare: number;
	usageRate: number;
	currency: "usd" | "eur" | "gbp" | "cad";
	feePercent: number;
	feeFixedCents: number;
	childShare: number;
	tierCounts: Record<string, number>;
	yearlyCount: number;
	refundCount: number;
	/** Off unless set: see `OPTIONAL_KNOBS`. */
	seatChangeRate?: number;
	/** Off unless set: see `OPTIONAL_KNOBS`. */
	upgradeRate?: number;
};

type Def =
	| { kind: "int" | "number"; min: number; max: number; doc: string }
	| { kind: "string"; pattern: string; example: string; doc: string }
	| { kind: "enum"; values: readonly string[]; doc: string }
	| { kind: "weights"; keys: readonly string[]; doc: string }
	| { kind: "counts"; keys: readonly string[]; max: number; doc: string };

export const TIER_IDS = BEFORE_UNIVERSITY_MENU.tiers.map((t) => t.id);

export const PARAMS: { [K in keyof ScenarioParams]-?: Def } = {
	months: {
		kind: "int",
		min: 1,
		max: 36,
		doc: "Months simulated, from `start`.",
	},
	start: {
		kind: "string",
		pattern: "^\\d{4}-(0[1-9]|1[0-2])$",
		example: "2026-01",
		doc: "First month, YYYY-MM.",
	},
	members: {
		kind: "int",
		min: 0,
		max: 200,
		doc: "Families that join in the first month.",
	},
	newMembersPerMonth: {
		kind: "int",
		min: 0,
		max: 50,
		doc: "Families that join in each later month.",
	},
	tierMix: {
		kind: "weights",
		keys: TIER_IDS,
		doc: "Relative weight of each tier a new family picks; weights are not percentages, at least one above 0.",
	},
	yearlyShare: {
		kind: "number",
		min: 0,
		max: 1,
		doc: "Share of families that pay yearly (a tier with no yearly price stays monthly).",
	},
	addonRate: {
		kind: "number",
		min: 0,
		max: 1,
		doc: "Chance a family buys an add-on at sign-up (the recurring one for its interval, or a one-time one).",
	},
	freeShare: {
		kind: "number",
		min: 0,
		max: 1,
		doc: "Share of families whose invoices are 100% discounted: credits, no money.",
	},
	churnRate: {
		kind: "number",
		min: 0,
		max: 1,
		doc: "Chance a family cancels at a monthly renewal (a yearly one gets the same chance per month, compounded).",
	},
	refundRate: {
		kind: "number",
		min: 0,
		max: 1,
		doc: "Chance a paid invoice is refunded.",
	},
	partialRefundShare: {
		kind: "number",
		min: 0,
		max: 1,
		doc: "Share of refunds that are partial (half the charge).",
	},
	disputeRate: {
		kind: "number",
		min: 0,
		max: 1,
		doc: "Chance a paid invoice that was not refunded is disputed.",
	},
	disputeLostShare: {
		kind: "number",
		min: 0,
		max: 1,
		doc: "Share of closed disputes that are lost.",
	},
	usageRate: {
		kind: "number",
		min: 0,
		max: 1,
		doc: "Chance a family books a class in a month, per class credit it holds (capped at 3 a month).",
	},
	currency: {
		kind: "enum",
		values: ["usd", "eur", "gbp", "cad"],
		doc: "The menu's currency. The books are USD only: another currency grants credits and leaves `money.skipped` markers.",
	},
	feePercent: {
		kind: "number",
		min: 0,
		max: 10,
		doc: "Stripe's percentage fee on a payment.",
	},
	feeFixedCents: {
		kind: "int",
		min: 0,
		max: 100,
		doc: "Stripe's fixed fee on a payment, cents.",
	},
	childShare: {
		kind: "number",
		min: 0,
		max: 1,
		doc: "Share of families whose membership is a child's own profile: the holder is `profile:prof_NNN` instead of `family:fam_NNN`, and the invoice metadata carries `profile_id` beside `family_id`. Drawn from a stream of its own, so 0 changes nothing else.",
	},
	tierCounts: {
		kind: "counts",
		keys: TIER_IDS,
		max: 200,
		doc: "Exact number of families on a tier, instead of the weighted draw. Which families get them is a seeded shuffle of all families. A tier named here (even at 0) is left out of `tierMix` for the families not named, so the count is exact; the rest draw from `tierMix` over the other tiers (which then needs a weight above 0). The counts must not add up to more than the families (members + newMembersPerMonth x (months - 1)). A family moved to a tier without a yearly price pays monthly; with no quantities, buys none. Families on a free invoice still count: set `freeShare` 0 to make them payers.",
	},
	yearlyCount: {
		kind: "int",
		min: 0,
		max: 200,
		doc: "Exact number of families that pay yearly, chosen by a seeded shuffle among those whose tier has a yearly price; every other family pays monthly and `yearlyShare` is ignored. 0 = use `yearlyShare`.",
	},
	refundCount: {
		kind: "int",
		min: 0,
		max: 200,
		doc: "Exact number of refunds in the whole run, each on a different paid invoice that is not disputed, chosen by a seeded shuffle among those whose refund falls inside the run; `refundRate` is ignored. 0 = use `refundRate`.",
	},
	seatChangeRate: {
		kind: "number",
		min: 0,
		max: 1,
		doc: "Chance, in each monthly period (a day from the 3rd to the 20th of it, the sign-up month included), that a family on a tier sold in quantities changes its count to the next one up or down: a raise is billed at once on a prorated `subscription_update` invoice, a decrease takes effect at the next renewal. Drawn from a stream of its own; 0 (the default) changes nothing.",
	},
	upgradeRate: {
		kind: "number",
		min: 0,
		max: 1,
		doc: "Chance, in each monthly period (a day from the 3rd to the 20th of it, the sign-up month included), that a family on a monthly price moves to the next tier down the menu list that costs more a month, billed at once on a prorated `subscription_update` invoice. Drawn from a stream of its own; 0 (the default) changes nothing.",
	},
};

/**
 * Knobs added after the presets' goldens were pinned. A resolved scenario carries one only when it is not at its
 * default, so every earlier scenario resolves (and hashes) as it did.
 */
export const OPTIONAL_KNOBS = { seatChangeRate: 0, upgradeRate: 0 } as const;

export const DEFAULT_PARAMS: ScenarioParams = {
	months: 12,
	start: "2026-01",
	members: 24,
	newMembersPerMonth: 0,
	tierMix: { audit: 3, scholar: 4, seminar: 2, fellow: 1 },
	yearlyShare: 0,
	addonRate: 0.25,
	freeShare: 0,
	churnRate: 0.03,
	refundRate: 0.02,
	partialRefundShare: 0.5,
	disputeRate: 0.005,
	disputeLostShare: 0.6,
	usageRate: 0.6,
	currency: "usd",
	feePercent: 2.9,
	feeFixedCents: 30,
	childShare: 0,
	tierCounts: {},
	yearlyCount: 0,
	refundCount: 0,
};

/** The defaults of an org's scenario: `DEFAULT_PARAMS` with the org's own tier weights. */
export const defaultParamsOf = (org: OrgKind): ScenarioParams =>
	org === DEFAULT_ORG
		? DEFAULT_PARAMS
		: { ...DEFAULT_PARAMS, tierMix: { ...ORGS[org].tierMix } };

/** A scenario to run: an org (optional), a preset (optional), a seed (optional) and knobs that override the preset's. */
export type ScenarioInput = {
	name?: string;
	org?: OrgKind;
	profile?: string;
	seed?: number;
	params?: Partial<ScenarioParams>;
};

export class ScenarioInputError extends Error {
	constructor(readonly problems: string[]) {
		super(problems.join("\n"));
	}
}

const jsonSchemaOf = (def: Def): Record<string, unknown> => {
	switch (def.kind) {
		case "int":
			return { type: "integer", minimum: def.min, maximum: def.max };
		case "number":
			return { type: "number", minimum: def.min, maximum: def.max };
		case "string":
			return { type: "string", pattern: def.pattern };
		case "enum":
			return { enum: [...def.values] };
		case "weights":
			return {
				type: "object",
				additionalProperties: false,
				properties: Object.fromEntries(
					def.keys.map((k) => [
						k,
						{ type: "number", minimum: 0, maximum: 1000 },
					]),
				),
			};
		case "counts":
			return {
				type: "object",
				additionalProperties: false,
				properties: Object.fromEntries(
					def.keys.map((k) => [
						k,
						{ type: "integer", minimum: 0, maximum: def.max },
					]),
				),
			};
	}
};

/** The JSON Schema of a scenario input, made from `PARAMS` (printed by `atm scenarios schema`). */
export const scenarioSchema = (profiles: readonly string[]) => ({
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://b4uni.com/_schema/scenario.v1.json",
	title: "atm scenario input v1",
	type: "object",
	additionalProperties: false,
	properties: {
		name: { type: "string", minLength: 1, maxLength: 60 },
		org: { enum: [...ORG_KINDS] },
		profile: { enum: [...profiles] },
		seed: { type: "integer", minimum: 0, maximum: 2 ** 31 - 1 },
		params: {
			type: "object",
			additionalProperties: false,
			// a tier weight or count may name any org's tier; the org's own tiers are checked by `checkScenarioInput`
			properties: Object.fromEntries(
				Object.entries(PARAMS).map(([k, d]) => [
					k,
					jsonSchemaOf(
						d.kind === "weights" || d.kind === "counts"
							? { ...d, keys: [...new Set(ORG_KINDS.flatMap(tierIdsOf))] }
							: d,
					),
				]),
			),
		},
	},
});

/** Edit distance, for "did you mean". */
const distance = (a: string, b: string): number => {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0] as number;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = row[j] as number;
			row[j] = Math.min(
				(row[j] as number) + 1,
				(row[j - 1] as number) + 1,
				prev + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			prev = tmp;
		}
	}
	return row[b.length] as number;
};

export const nearest = (
	word: string,
	options: readonly string[],
): string | null => {
	let best: string | null = null;
	let bestDistance = Math.max(2, Math.floor(word.length / 3));
	for (const option of options) {
		const d = distance(word.toLowerCase(), option.toLowerCase());
		if (d <= bestDistance) {
			best = option;
			bestDistance = d;
		}
	}
	return best;
};

const allowed = (def: Def): string => {
	switch (def.kind) {
		case "int":
			return `a whole number from ${def.min} to ${def.max}`;
		case "number":
			return `a number from ${def.min} to ${def.max}`;
		case "string":
			return `text like ${JSON.stringify(def.example)}`;
		case "enum":
			return `one of ${def.values.join(", ")}`;
		case "weights":
			return `an object of weights, keys from: ${def.keys.join(", ")}`;
		case "counts":
			return `an object of whole numbers from 0 to ${def.max}, keys from: ${def.keys.join(", ")}`;
	}
};

/**
 * Checks an ad-hoc scenario against the schema and the rules a schema cannot say, and throws `ScenarioInputError` with
 * one line per problem (knob, what was given, what is allowed, the fix). `profiles` are the preset names; `orgOfProfile`
 * names a preset's org, whose menu's tiers are the keys `tierMix` and `tierCounts` may use.
 */
export const checkScenarioInput = (
	input: unknown,
	profiles: readonly string[],
	orgOfProfile: (profile: string) => OrgKind = () => DEFAULT_ORG,
): ScenarioInput => {
	if (typeof input !== "object" || input === null || Array.isArray(input))
		throw new ScenarioInputError([
			'a scenario is a JSON object, like {"profile":"heavy-refunds","params":{"refundRate":0.2}}',
		]);
	const problems: string[] = [];
	const record = input as Record<string, unknown>;
	const top = ["name", "org", "profile", "seed", "params"];
	for (const key of Object.keys(record).filter((k) => !top.includes(k))) {
		const near = nearest(key, [...top, ...Object.keys(PARAMS)]);
		const hint = near
			? Object.keys(PARAMS).includes(near)
				? ` ${near} is a knob: put it under "params"`
				: ` did you mean "${near}"?`
			: ` allowed: ${top.join(", ")}`;
		problems.push(`unknown field "${key}".${hint}`);
	}
	if (
		record.profile !== undefined &&
		!profiles.includes(record.profile as string)
	) {
		const near = nearest(String(record.profile), profiles);
		problems.push(
			`profile ${JSON.stringify(record.profile)} is not a preset.${near ? ` Did you mean "${near}"?` : ""} Presets: ${profiles.join(", ")} (list them: atm scenarios list)`,
		);
	}
	const presetOrg =
		typeof record.profile === "string" && profiles.includes(record.profile)
			? orgOfProfile(record.profile)
			: undefined;
	if (record.org !== undefined && !isOrgKind(record.org)) {
		const near = nearest(String(record.org), ORG_KINDS);
		problems.push(
			`org ${JSON.stringify(record.org)} is not an org.${near ? ` Did you mean "${near}"?` : ""} Orgs: ${ORG_KINDS.join(", ")}`,
		);
	} else if (
		record.org !== undefined &&
		presetOrg !== undefined &&
		record.org !== presetOrg
	)
		problems.push(
			`org ${JSON.stringify(record.org)} does not match preset ${JSON.stringify(record.profile)}, which simulates ${presetOrg}. Drop "org", or pick a preset of ${record.org} (atm scenarios list)`,
		);
	const org: OrgKind = isOrgKind(record.org)
		? record.org
		: (presetOrg ?? DEFAULT_ORG);
	if (
		record.seed !== undefined &&
		!(
			Number.isInteger(record.seed) &&
			(record.seed as number) >= 0 &&
			(record.seed as number) <= 2 ** 31 - 1
		)
	)
		problems.push(
			`seed ${JSON.stringify(record.seed)} must be a whole number from 0 to ${2 ** 31 - 1}`,
		);
	const params = record.params;
	if (params !== undefined) {
		if (typeof params !== "object" || params === null || Array.isArray(params))
			problems.push(
				'"params" must be an object of knobs, like {"refundRate":0.2}',
			);
		else {
			const known = Object.keys(PARAMS);
			for (const [key, value] of Object.entries(params)) {
				const knob = PARAMS[key as keyof ScenarioParams];
				const def: Def | undefined =
					knob?.kind === "weights" || knob?.kind === "counts"
						? { ...knob, keys: tierIdsOf(org) }
						: knob;
				if (!def) {
					const near = nearest(key, known);
					problems.push(
						`unknown knob "${key}".${near ? ` Did you mean "${near}"?` : ""} Knobs: ${known.join(", ")} (describe them: atm scenarios describe <profile>)`,
					);
					continue;
				}
				const probe = new Ajv2020({ allErrors: true, strict: false }).compile(
					jsonSchemaOf(def),
				);
				if (!probe(value))
					problems.push(
						`${key}=${JSON.stringify(value)} is not valid: it must be ${allowed(def)}.${hintFor(key, value, def)}`,
					);
				else if (def.kind === "weights") {
					const w = Object.values(value as Record<string, number>);
					if (w.length === 0 || w.every((n) => n === 0))
						problems.push(
							`${key} needs at least one weight above 0, got ${JSON.stringify(value)}`,
						);
				}
			}
		}
	}
	if (problems.length > 0) throw new ScenarioInputError(problems);
	return input as ScenarioInput;
};

/** Families a scenario creates: the founding ones, then `newMembersPerMonth` in each later month. */
export const familyCountOf = (
	params: Pick<ScenarioParams, "members" | "newMembersPerMonth" | "months">,
): number => params.members + params.newMembersPerMonth * (params.months - 1);

/**
 * The rules between knobs that no schema can say, checked on the knobs a scenario resolved to. Throws
 * `ScenarioInputError` with one line per problem (knob, what was given, what is allowed, the fix).
 */
export const checkResolvedParams = (
	params: ScenarioParams,
	tierIds: readonly string[] = TIER_IDS,
): void => {
	const problems: string[] = [];
	const families = familyCountOf(params);
	const counted = Object.values(params.tierCounts).reduce((n, c) => n + c, 0);
	if (counted > families)
		problems.push(
			`tierCounts=${JSON.stringify(params.tierCounts)} puts ${counted} families on tiers but the scenario has ${families} (members ${params.members} + newMembersPerMonth ${params.newMembersPerMonth} x ${params.months - 1} later months). Lower the counts or raise members.`,
		);
	else if (counted < families) {
		const open = tierIds.filter((id) => !(id in params.tierCounts));
		if (!open.some((id) => (params.tierMix[id] ?? 0) > 0))
			problems.push(
				`tierCounts=${JSON.stringify(params.tierCounts)} places ${counted} of ${families} families, and the other families draw from tierMix over the tiers tierCounts does not name (${open.join(", ") || "none"}), where no weight is above 0 (tierMix=${JSON.stringify(params.tierMix)}). Name every family in tierCounts, or give an unnamed tier a weight.`,
			);
	}
	if (params.yearlyCount > families)
		problems.push(
			`yearlyCount=${params.yearlyCount} is more than the ${families} families. Lower it or raise members.`,
		);
	if (params.refundCount > 0 && params.disputeRate >= 1)
		problems.push(
			`refundCount=${params.refundCount} needs paid invoices that are not disputed, and disputeRate=${params.disputeRate} disputes every one. Lower disputeRate.`,
		);
	if (problems.length > 0) throw new ScenarioInputError(problems);
};

const hintFor = (key: string, value: unknown, def: Def): string => {
	if (
		def.kind === "number" &&
		typeof value === "number" &&
		value > def.max &&
		def.max === 1
	)
		return ` It is a share between 0 and 1: ${value} would be ${value / 100} as a share.`;
	if (def.kind === "enum" && typeof value === "string") {
		const near = nearest(value, def.values);
		return near ? ` Did you mean "${near}"?` : "";
	}
	if (
		(def.kind === "weights" || def.kind === "counts") &&
		typeof value === "object" &&
		value !== null
	) {
		const bad = Object.keys(value).filter((k) => !def.keys.includes(k));
		return bad.length
			? ` Unknown tier(s) ${bad.map((b) => `"${b}"${nearest(b, def.keys) ? ` (did you mean "${nearest(b, def.keys)}"?)` : ""}`).join(", ")}.`
			: "";
	}
	return key === "start" ? ' Write the month as "2026-01".' : "";
};

/** `--set key=value` pairs into knobs. A value is JSON when it parses (`0.2`, `{"audit":1}`), else text; `tierMix.audit=3` sets one weight. */
export const parseSets = (sets: readonly string[]): Partial<ScenarioParams> => {
	const out: Record<string, unknown> = {};
	const problems: string[] = [];
	for (const set of sets) {
		const eq = set.indexOf("=");
		if (eq <= 0) {
			problems.push(
				`--set ${JSON.stringify(set)} must look like key=value, for example --set refundRate=0.2`,
			);
			continue;
		}
		const key = set.slice(0, eq).trim();
		const raw = set.slice(eq + 1).trim();
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			value = raw;
		}
		const dot = key.indexOf(".");
		if (dot > 0) {
			const head = key.slice(0, dot);
			const sub = out[head] ?? {};
			(sub as Record<string, unknown>)[key.slice(dot + 1)] = value;
			out[head] = sub;
		} else out[key] = value;
	}
	if (problems.length > 0) throw new ScenarioInputError(problems);
	return out as Partial<ScenarioParams>;
};
