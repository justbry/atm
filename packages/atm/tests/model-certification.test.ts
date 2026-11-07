/**
 * Certifies the ledger model (`model/ledger.v1.json`) against what atm generates: every relationship the model says holds
 * is read back from every scenario preset's events (the 15 school presets and the 6 org presets beside them, which reuse
 * the school's billing shape, atm identifiers and `school.v1` KPI spec), every entity key is present on its events, every measure resolves
 * to the KPI spec and to the rows the evaluator produces, the `capped` flag agrees with the disclosure file, and a model
 * that names a term that does not exist is refused.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import modelJson from "../model/ledger.v1.json";
import {
	type Audience,
	classRule,
	type DetailStep,
	type DisclosureDelay,
	type DisclosureFile,
	type DisclosureGrain,
	detailSteps,
	disclosureGrains,
	type KpiClass,
	type ResolvedRule,
	ruledAudiences,
} from "../src/ledger/kpi-disclosure.js";
import { LEDGER_MODEL, parseLedgerModel } from "../src/model/ledger-model.js";
import {
	type LedgerModel,
	LedgerModelError,
	type ModelEntity,
	type ModelRelationship,
} from "../src/model/resolve.js";
import { atmChannel } from "../src/scenario/channels/atm.js";
import { buildFixture, type Fixture } from "../src/scenario/fixture.js";
import { evaluateKpis, kpiRootId } from "../src/scenario/kpi-evaluate.js";
import { SCHOOL_KPIS } from "../src/scenario/kpis.js";
import { DEFAULT_ORG, ORG_KINDS } from "../src/scenario/orgs.js";
import { PROFILE_NAMES, PROFILES } from "../src/scenario/profiles.js";
import type { AtmEvent } from "../src/types.js";

const UI_DISCLOSURE_PATH = join(
	import.meta.dir,
	"../../ledger-ui/src/fixtures/disclosure.json",
);

/** Built once per preset: `buildFixture` is not free. */
const fixtures: ReadonlyMap<string, Fixture> = new Map(
	PROFILE_NAMES.map((name) => [name, buildFixture({ profile: name })]),
);
const eventsOf = (preset: string): readonly AtmEvent[] =>
	(fixtures.get(preset) as Fixture).events;

const model: LedgerModel = LEDGER_MODEL.model;

// ---------------------------------------------------------------------------------------------------------------------
// Field paths

const isPresent = (value: unknown): boolean =>
	value !== undefined && value !== null && value !== "";

/** The values of a non-posting field path on an event: one value, or none when the event does not have it. */
const readField = (event: AtmEvent, path: string): string | undefined => {
	if (path === "posting.account")
		throw new Error("posting.account is read per posting, not per event");
	let value: unknown;
	if (path.startsWith("labels."))
		value = event.labels[path.slice("labels.".length)];
	else if (path.startsWith("payload."))
		value = event.payload[path.slice("payload.".length)];
	else value = (event as unknown as Record<string, unknown>)[path];
	return isPresent(value) ? String(value) : undefined;
};

/** A tuple of field values, or null when any field is missing. */
const readTuple = (
	event: AtmEvent,
	paths: readonly string[],
): string[] | null => {
	const values: string[] = [];
	for (const path of paths) {
		const value = readField(event, path);
		if (value === undefined) return null;
		values.push(value);
	}
	return values;
};

// ---------------------------------------------------------------------------------------------------------------------
// Relationship joins

type JoinFailure = {
	preset: string;
	relationship: string;
	event: string;
	tuple: string;
	problem: string;
};

type JoinCount = { rows: number; byJoin: number[] };

const describeFailure = (failure: JoinFailure): string =>
	`${failure.preset} / ${failure.relationship} / event ${failure.event} / tuple ${failure.tuple}: ${failure.problem}`;

const certifiedRelationships = model.relationships.filter(
	(relationship) =>
		relationship.certifiedBy === "presets" ||
		relationship.certifiedBy === "presets-vacuous",
);

/** The first join whose `when` field the row has; a join without `when` always applies. */
const applicableJoin = (relationship: ModelRelationship, event: AtmEvent) =>
	(relationship.joins ?? []).findIndex(
		(join) =>
			join.when === undefined || readField(event, join.when) !== undefined,
	);

const certifyRelationship = (
	preset: string,
	relationship: ModelRelationship,
): { failures: JoinFailure[]; count: JoinCount } => {
	const events = eventsOf(preset);
	const joins = relationship.joins ?? [];
	const fromTypes = new Set(relationship.fromEvents ?? []);
	const toTypes = new Set(relationship.toEvents ?? []);
	const failures: JoinFailure[] = [];
	const count: JoinCount = { rows: 0, byJoin: joins.map(() => 0) };

	// For each join, the `to` rows by their `to` tuple.
	const toRowsByJoin = joins.map((join) => {
		const index = new Map<string, AtmEvent[]>();
		for (const event of events) {
			if (!toTypes.has(event.event_type)) continue;
			const tuple = readTuple(event, join.to);
			if (!tuple) continue;
			const key = JSON.stringify(tuple);
			index.set(key, [...(index.get(key) ?? []), event]);
		}
		return index;
	});

	const fromRowOf = new Map<string, string>();
	for (const event of events) {
		if (!fromTypes.has(event.event_type)) continue;
		const joinIndex = applicableJoin(relationship, event);
		const fail = (tuple: string, problem: string) =>
			failures.push({
				preset,
				relationship: relationship.id,
				event: event.id,
				tuple,
				problem,
			});
		if (joinIndex < 0) {
			fail(
				"(no join applies)",
				`${event.event_type} has no field any join's when asks for`,
			);
			continue;
		}
		const join = joins[joinIndex] as (typeof joins)[number];
		const tuple = readTuple(event, join.from);
		if (!tuple) {
			fail(
				`${join.from.join(",")} (a field is missing)`,
				`join ${joinIndex} applies but the from tuple is incomplete`,
			);
			continue;
		}
		const matches = (toRowsByJoin[joinIndex] as Map<string, AtmEvent[]>).get(
			JSON.stringify(tuple),
		);
		const tupleText = JSON.stringify(tuple);
		if (!matches || matches.length !== 1) {
			fail(
				tupleText,
				`resolves to ${matches?.length ?? 0} to-rows, not exactly one`,
			);
			continue;
		}
		const target = (matches[0] as AtmEvent).id;
		if (relationship.cardinality === "one-to-one") {
			const earlier = fromRowOf.get(target);
			if (earlier !== undefined) {
				fail(tupleText, `${earlier} and ${event.id} both resolve to ${target}`);
				continue;
			}
			fromRowOf.set(target, event.id);
		}
		count.rows += 1;
		count.byJoin[joinIndex] = (count.byJoin[joinIndex] as number) + 1;
	}
	return { failures, count };
};

const joinResults = new Map(
	certifiedRelationships.map((relationship) => {
		const perPreset = PROFILE_NAMES.map((preset) =>
			certifyRelationship(preset, relationship),
		);
		const total: JoinCount = {
			rows: perPreset.reduce((sum, result) => sum + result.count.rows, 0),
			byJoin: (relationship.joins ?? []).map((_, index) =>
				perPreset.reduce(
					(sum, result) => sum + (result.count.byJoin[index] ?? 0),
					0,
				),
			),
		};
		return [
			relationship.id,
			{ failures: perPreset.flatMap((result) => result.failures), total },
		] as const;
	}),
);

const orgOfPreset = (name: string): string =>
	PROFILES.find((profile) => profile.name === name)?.org ?? DEFAULT_ORG;

describe("relationship joins on every preset", () => {
	test("there are 21 presets: 15 of the school, 6 of the other orgs, every org with at least one", () => {
		expect(PROFILE_NAMES).toHaveLength(21);
		const schoolPresets = PROFILE_NAMES.filter(
			(name) => orgOfPreset(name) === DEFAULT_ORG,
		);
		expect(schoolPresets).toHaveLength(15);
		expect(PROFILE_NAMES.length - schoolPresets.length).toBe(6);
		for (const kind of ORG_KINDS)
			expect(PROFILE_NAMES.some((name) => orgOfPreset(name) === kind)).toBe(
				true,
			);
	});

	for (const relationship of certifiedRelationships) {
		test(`${relationship.id} (${relationship.cardinality}, ${relationship.certifiedBy}): every from row resolves to exactly one to row`, () => {
			const { failures } = joinResults.get(relationship.id) as {
				failures: JoinFailure[];
			};
			expect(failures.map(describeFailure)).toEqual([]);
		});

		test(`${relationship.id}: ${relationship.certifiedBy === "presets" ? "at least one preset has a joined row" : "no preset has a joined row yet"}`, () => {
			const { total } = joinResults.get(relationship.id) as {
				total: JoinCount;
			};
			if (relationship.certifiedBy === "presets")
				expect(total.rows).toBeGreaterThan(0);
			else expect(total.rows).toBe(0);
		});
	}

	test("each certified relationship names events and joins that exist in the model", () => {
		for (const relationship of certifiedRelationships) {
			expect(relationship.fromEvents?.length ?? 0).toBeGreaterThan(0);
			expect(relationship.toEvents?.length ?? 0).toBeGreaterThan(0);
			expect(relationship.joins?.length ?? 0).toBeGreaterThan(0);
		}
	});

	test("the payment_intent joins are unexercised: no preset payment carries one", () => {
		for (const preset of PROFILE_NAMES)
			for (const event of eventsOf(preset))
				if (event.event_type === "payment.succeeded")
					expect(readField(event, "payload.payment_intent")).toBeUndefined();
		for (const relationship of certifiedRelationships) {
			const { total } = joinResults.get(relationship.id) as {
				total: JoinCount;
			};
			(relationship.joins ?? []).forEach((join, index) => {
				if (join.when === "payload.payment_intent")
					expect(total.byJoin[index]).toBe(0);
			});
		}
	});

	test("a refund and a dispute resolve by invoice: every one carries an invoice", () => {
		for (const preset of PROFILE_NAMES)
			for (const event of eventsOf(preset))
				if (
					event.event_type === "payment.refunded" ||
					event.event_type === "payment.disputed"
				)
					expect(readField(event, "payload.invoice")).toBeDefined();
	});
});

describe("bookings", () => {
	test("every credit.held carries labels.booking", () => {
		const missing: string[] = [];
		for (const preset of PROFILE_NAMES)
			for (const event of eventsOf(preset))
				if (
					event.event_type === "credit.held" &&
					!readField(event, "labels.booking")
				)
					missing.push(`${preset} / ${event.id}`);
		expect(missing).toEqual([]);
	});

	test("(key, labels.booking) is unique among credit.held on every preset", () => {
		const duplicates: string[] = [];
		for (const preset of PROFILE_NAMES) {
			const seen = new Map<string, string>();
			for (const event of eventsOf(preset)) {
				if (event.event_type !== "credit.held") continue;
				const tuple = JSON.stringify([event.key, event.labels.booking]);
				const earlier = seen.get(tuple);
				if (earlier !== undefined)
					duplicates.push(`${preset} / ${tuple} / ${earlier} and ${event.id}`);
				seen.set(tuple, event.id);
			}
		}
		expect(duplicates).toEqual([]);
	});

	test("at least one preset holds credits for a booking", () => {
		const holds = PROFILE_NAMES.flatMap((preset) =>
			eventsOf(preset).filter((event) => event.event_type === "credit.held"),
		);
		expect(holds.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// Entity keys

const memberKeyPattern = new RegExp(
	(model.entities.find((entity) => entity.id === "Member") as ModelEntity).key
		?.pattern as string,
);

/** The postings of an event that a `posting.account` key reads: those the pattern matches, with its first capture. */
const capturesOf = (event: AtmEvent, pattern: RegExp): string[] =>
	event.postings.flatMap((posting) => {
		const match = pattern.exec(posting.account);
		return match ? [match[1] ?? ""] : [];
	});

const keyedEntities = model.entities.filter((entity) => entity.key);

/**
 * For a `posting.account` key, the accounts it is meant to read. A matching posting yields a capture; a posting under
 * this prefix that does not match is a failure.
 */
const accountPrefixesOfEntity: Record<string, string[]> = {
	Tier: ["income:billing:membership:"],
	Account: [""],
	CreditLot: ["credits:avail:", "credits:held:"],
};

describe("entity keys on every preset", () => {
	for (const entity of keyedEntities) {
		const key = entity.key as NonNullable<ModelEntity["key"]>;
		const eventTypes = key.eventTypes ?? entity.eventTypes;

		test(`${entity.id}: the key ${key.fields.join(" + ")} is present on every ${eventTypes ? eventTypes.join(" / ") : "event"}`, () => {
			const problems: string[] = [];
			const pattern = key.pattern ? new RegExp(key.pattern) : null;
			const usesPosting = key.fields.includes("posting.account");
			if (usesPosting) {
				expect(key.fields).toEqual(["posting.account"]);
				expect(pattern).not.toBeNull();
				expect(accountPrefixesOfEntity).toHaveProperty(entity.id);
			}
			for (const preset of PROFILE_NAMES)
				for (const event of eventsOf(preset)) {
					if (eventTypes && !eventTypes.includes(event.event_type)) continue;
					// A payout is the school's, not a member's: its key is `stripe:payouts` (asserted below).
					if (entity.id === "Member" && event.event_type === "payout.paid")
						continue;
					if (usesPosting) {
						const prefixes = accountPrefixesOfEntity[entity.id] as string[];
						for (const posting of event.postings) {
							if (
								!prefixes.some((prefix) => posting.account.startsWith(prefix))
							)
								continue;
							const match = (pattern as RegExp).exec(posting.account);
							if (!match?.[1])
								problems.push(
									`${preset} / ${event.id} / posting ${posting.account} yields no key`,
								);
						}
						continue;
					}
					const tuple = readTuple(event, key.fields);
					if (!tuple) {
						problems.push(
							`${preset} / ${event.id} / ${event.event_type} lacks ${key.fields.join(",")}`,
						);
						continue;
					}
					if (
						pattern &&
						key.fields.length === 1 &&
						!pattern.test(tuple[0] as string)
					)
						problems.push(
							`${preset} / ${event.id} / ${tuple[0]} does not match ${key.pattern}`,
						);
				}
			expect(problems).toEqual([]);
		});
	}

	test("a payment has at most one membership tier posting, and some payment on some preset has one", () => {
		const tier = model.entities.find(
			(entity) => entity.id === "Tier",
		) as ModelEntity;
		const pattern = new RegExp(tier.key?.pattern as string);
		let withTier = 0;
		for (const preset of PROFILE_NAMES)
			for (const event of eventsOf(preset)) {
				if (event.event_type !== "payment.succeeded") continue;
				const tiers = capturesOf(event, pattern);
				expect(tiers.length).toBeLessThanOrEqual(1);
				withTier += tiers.length;
			}
		expect(withTier).toBeGreaterThan(0);
	});

	test("a credits: account is the lot's balance (avail, held) or one of the school's issuer, spend, expiry and adjustment sides", () => {
		const kinds = new Set<string>();
		for (const preset of PROFILE_NAMES)
			for (const event of eventsOf(preset))
				for (const posting of event.postings)
					if (posting.account.startsWith("credits:"))
						kinds.add(posting.account.split(":")[1] as string);
		expect([...kinds].sort()).toEqual([
			"adjust",
			"avail",
			"expired",
			"held",
			"issued",
			"spent",
		]);
	});

	test("every event's key is a member key, except the exact set of non-member holders", () => {
		const nonMemberKeys = new Set<string>();
		for (const preset of PROFILE_NAMES)
			for (const event of eventsOf(preset))
				if (!memberKeyPattern.test(event.key)) nonMemberKeys.add(event.key);
		expect([...nonMemberKeys].sort()).toEqual(["stripe:payouts"]);
	});

	test("a non-member holder carries only payout events", () => {
		const types = new Set<string>();
		for (const preset of PROFILE_NAMES)
			for (const event of eventsOf(preset))
				if (!memberKeyPattern.test(event.key)) types.add(event.event_type);
		expect([...types].sort()).toEqual(["payout.paid"]);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// Measures

describe("measures resolve", () => {
	const { measures } = LEDGER_MODEL;
	const measureIds = new Set(measures.map((measure) => measure.id));

	test("the model parses and has the counts it is expected to", () => {
		expect(model.entities).toHaveLength(19);
		expect(model.relationships).toHaveLength(8);
		expect(model.dimensions).toHaveLength(5);
		expect(model.measures).toHaveLength(29);
		expect(measures).toHaveLength(29);
	});

	test("every kpiSpec measure is a KPI of the spec, and every spec KPI has a kpiSpec measure", () => {
		const specIds = new Set(SCHOOL_KPIS.kpis.map((kpi) => kpi.id));
		const specMeasures = measures.filter(
			(measure) => measure.source === "kpiSpec",
		);
		for (const measure of specMeasures)
			expect(specIds.has(measure.id)).toBe(true);
		expect(specMeasures.map((measure) => measure.id).sort()).toEqual(
			[...specIds].sort(),
		);
		expect(specMeasures).toHaveLength(SCHOOL_KPIS.kpis.length);
	});

	test("no other measure shares an id with a spec KPI", () => {
		const specIds = new Set(SCHOOL_KPIS.kpis.map((kpi) => kpi.id));
		for (const measure of measures)
			if (measure.source !== "kpiSpec")
				expect(specIds.has(measure.id)).toBe(false);
	});

	test("each measure's inputs and disclosure.ruleOf are measures", () => {
		for (const measure of measures) {
			for (const input of measure.inputs)
				expect(measureIds.has(input)).toBe(true);
			if (measure.disclosure.ruleOf)
				expect(measureIds.has(measure.disclosure.ruleOf)).toBe(true);
		}
	});

	test("each measure's dimensions and entity are in the model", () => {
		const dimensionIds = new Set(
			model.dimensions.map((dimension) => dimension.id),
		);
		const entityIds = new Set(model.entities.map((entity) => entity.id));
		for (const measure of measures) {
			expect(entityIds.has(measure.entity)).toBe(true);
			for (const dimension of measure.dimensions)
				expect(dimensionIds.has(dimension)).toBe(true);
		}
	});

	for (const preset of PROFILE_NAMES) {
		test(`${preset}: every KPI row id is a model measure, and a :value part only on a measure with a dimension`, () => {
			const { events, periods } = fixtures.get(preset) as Fixture;
			const rows = evaluateKpis({
				spec: SCHOOL_KPIS,
				base: atmChannel.base({ events, spec: SCHOOL_KPIS, periods }),
				periods,
			});
			expect(rows.length).toBeGreaterThan(0);
			const problems: string[] = [];
			for (const row of rows) {
				const measure = measures.find(
					(candidate) => candidate.id === kpiRootId(row.kpiId),
				);
				if (!measure) {
					problems.push(`${row.kpiId} is not a measure`);
					continue;
				}
				if (row.kpiId !== measure.id && measure.dimensions.length === 0)
					problems.push(
						`${row.kpiId} has a value part, but ${measure.id} has no dimension`,
					);
			}
			expect([...new Set(problems)]).toEqual([]);
		});
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// Disclosure meaning

const disclosureFile = (
	JSON.parse(readFileSync(UI_DISCLOSURE_PATH, "utf8")) as {
		file: DisclosureFile;
	}
).file;

const AVERAGE_MONTH_DAYS = 30.44;
const WEEK_DAYS = 7;
const delayDays = (delay: DisclosureDelay | null): number => {
	if (!delay) return 0;
	const [count = "0", unit = ""] = delay.split(" ");
	return (
		Number(count) * (unit.startsWith("week") ? WEEK_DAYS : AVERAGE_MONTH_DAYS)
	);
};
const detailRank = (detail: DetailStep): number => detailSteps.indexOf(detail);
const grainRank = (grain: DisclosureGrain): number =>
	disclosureGrains.indexOf(grain);

/** Whether `own` gives an audience more than `other`: a rule where the other gives none, or finer detail, a finer grain or a shorter delay. */
const moreOpen = (
	own: ResolvedRule | null,
	other: ResolvedRule | null,
): boolean => {
	if (!own) return false;
	if (!other) return true;
	return (
		detailRank(own.detail) > detailRank(other.detail) ||
		grainRank(own.every) > grainRank(other.every) ||
		delayDays(own.after) < delayDays(other.after)
	);
};

const classOfMeasure = (id: string): KpiClass =>
	LEDGER_MODEL.measures.find((measure) => measure.id === id)?.disclosure
		.class as KpiClass;

const audiencesWhereMoreOpen = (
	measureId: string,
	inputId: string,
): Audience[] =>
	ruledAudiences.filter((audience) =>
		moreOpen(
			classRule(disclosureFile, classOfMeasure(measureId), audience),
			classRule(disclosureFile, classOfMeasure(inputId), audience),
		),
	);

describe("disclosure meaning of capped", () => {
	const derived = LEDGER_MODEL.measures.filter(
		(measure) => measure.source === "kpiSpec" && measure.inputs.length > 0,
	);

	test("the derived kpiSpec measures are the five the disclosure file lists", () => {
		expect(derived.map((measure) => measure.id).sort()).toEqual([
			"arpa",
			"breakage_rate",
			"dispute_rate",
			"net_income",
			"refund_rate",
		]);
	});

	for (const measure of derived) {
		test(`${measure.id}: capped exactly when its class is more open than an input's for a ruled audience`, () => {
			const stricterInputs = measure.inputs.filter(
				(input) => audiencesWhereMoreOpen(measure.id, input).length > 0,
			);
			const reasons = stricterInputs.map(
				(input) =>
					`${input}: ${audiencesWhereMoreOpen(measure.id, input).join(",")}`,
			);
			expect({
				id: measure.id,
				capped: measure.disclosure.capped === true,
				reasons,
			}).toEqual({
				id: measure.id,
				capped: stricterInputs.length > 0,
				reasons,
			});
		});
	}

	test("net_income and arpa are capped; refund_rate, dispute_rate and breakage_rate are not", () => {
		const capped = (id: string) =>
			LEDGER_MODEL.measures.find((measure) => measure.id === id)?.disclosure
				.capped === true;
		expect(["net_income", "arpa"].map(capped)).toEqual([true, true]);
		expect(
			["refund_rate", "dispute_rate", "breakage_rate"].map(capped),
		).toEqual([false, false, false]);
	});

	test("no measure other than a derived kpiSpec one is capped", () => {
		const derivedIds = new Set(derived.map((measure) => measure.id));
		for (const measure of LEDGER_MODEL.measures)
			if (!derivedIds.has(measure.id))
				expect(measure.disclosure.capped).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// Refusals

type Mutable = {
	prefixes: Record<string, string>;
	entities: { id: string; links?: { closeMatch?: string[] } }[];
	dimensions: unknown[];
	measures: {
		id: string;
		entity: string;
		dimensions: string[];
		format: string;
		title?: string;
		disclosure: { class: string; ruleOf?: string };
	}[];
};

const cloneModel = (): Mutable =>
	structuredClone(modelJson) as unknown as Mutable;
const measureOf = (clone: Mutable, id: string) =>
	clone.measures.find(
		(measure) => measure.id === id,
	) as Mutable["measures"][number];

const refusalMessage = (clone: Mutable): string => {
	try {
		parseLedgerModel(clone);
	} catch (error) {
		expect(error).toBeInstanceOf(LedgerModelError);
		return (error as Error).message;
	}
	throw new Error("parseLedgerModel accepted a broken model");
};

describe("parseLedgerModel refuses a broken model", () => {
	test("the unbroken clone is accepted", () => {
		expect(() => parseLedgerModel(cloneModel())).not.toThrow();
	});

	test("a measure naming an unknown entity", () => {
		const clone = cloneModel();
		measureOf(clone, "refunds").entity = "Nonesuch";
		const message = refusalMessage(clone);
		expect(message).toContain("measure refunds");
		expect(message).toContain("Nonesuch");
	});

	test("an unknown dimension", () => {
		const clone = cloneModel();
		measureOf(clone, "revenue_by_kind").dimensions = ["nonesuch_dimension"];
		const message = refusalMessage(clone);
		expect(message).toContain("measure revenue_by_kind");
		expect(message).toContain("nonesuch_dimension");
	});

	test("a spec KPI removed from the measures", () => {
		const clone = cloneModel();
		clone.measures = clone.measures.filter(
			(measure) => measure.id !== "payouts",
		);
		const message = refusalMessage(clone);
		expect(message).toContain("KPI payouts");
	});

	test("a kpiSpec measure given a title that restates the spec", () => {
		const clone = cloneModel();
		const index = clone.measures.findIndex(
			(measure) => measure.id === "refunds",
		);
		clone.measures[index] = {
			...measureOf(clone, "refunds"),
			title: "Refunds again",
		};
		const message = refusalMessage(clone);
		// The schema refuses it; its message names the measure by position, not by id.
		expect(message).toContain("schema/model.v1.json");
		expect(message).toContain(`/measures/${index}`);
	});

	test("format percent1 on a cents KPI", () => {
		const clone = cloneModel();
		measureOf(clone, "gross_collected").format = "percent1";
		const message = refusalMessage(clone);
		expect(message).toContain("measure gross_collected");
		expect(message).toContain("percent1");
		expect(message).toContain("cents");
	});

	test("ruleOf pointing at a measure of another class", () => {
		const clone = cloneModel();
		measureOf(clone, "dispute_cost").disclosure.ruleOf = "paying_members";
		const message = refusalMessage(clone);
		expect(message).toContain("measure dispute_cost");
		expect(message).toContain("ruleOf paying_members");
	});

	test("a CURIE with an undeclared prefix", () => {
		const clone = cloneModel();
		const tier = clone.entities.find(
			(entity) => entity.id === "Tier",
		) as Mutable["entities"][number];
		tier.links = { closeMatch: ["nonesuch:Thing"] };
		const message = refusalMessage(clone);
		expect(message).toContain("entity Tier");
		expect(message).toContain("nonesuch:Thing");
		expect(message).toContain("prefix nonesuch");
	});

	test("no prefix mapping to the namespace", () => {
		const clone = cloneModel();
		const { ledger: _ledger, ...others } = clone.prefixes;
		clone.prefixes = others;
		const message = refusalMessage(clone);
		expect(message).toContain(`namespace ${modelJson.namespace}`);
		expect(message).toContain("0 prefixes map to it (none)");
	});

	test("two prefixes mapping to the namespace", () => {
		const clone = cloneModel();
		clone.prefixes.books = modelJson.namespace;
		const message = refusalMessage(clone);
		expect(message).toContain(`namespace ${modelJson.namespace}`);
		expect(message).toContain("2 prefixes map to it (ledger, books)");
	});

	test("the namespace's prefix may have any name", () => {
		const clone = cloneModel();
		const { ledger, ...others } = clone.prefixes;
		clone.prefixes = { ...others, books: ledger as string };
		expect(() => parseLedgerModel(clone)).not.toThrow();
	});
});
