import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import envelope from "../schema/envelope.v1.json";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { duckdbDdl } from "../src/ledger/duckdb.js";
import { ulidTime } from "../src/ledger/ids.js";
import { appendToOutbox } from "../src/ledger/outbox.js";
import { localDate } from "../src/ledger/util.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { SqlDatabase } from "../src/types.js";
import {
	assertNoDrift,
	collapseRepeats,
	describeUsageError,
	LabelCardinalityGuard,
	loadUsageMapping,
	mappingDigest,
	normalizeUsage,
	rawDigest,
	redactUsage,
	rederiveFact,
	shapeDrift,
	sumQuantity,
	type UsageContext,
	type UsageEventContext,
	type UsageMapping,
	UsageMappingError,
	unwrapUsage,
	usageLedgerEvent,
} from "./spikes/usage-mapping.js";

const root = join(import.meta.dir, "..");
// biome-ignore lint/suspicious/noExplicitAny: raw JSON events and mapping files are untyped in this spike test
type Loose = any;
const readJson = (path: string): Loose =>
	JSON.parse(readFileSync(join(root, path), "utf8"));
const clone = <T>(value: T): T => structuredClone(value);

const rawMapping = (name: string) =>
	readJson(`schema/mapping/usage.${name}.v1.json`);
const openai = loadUsageMapping(rawMapping("openai.llm.completion"));
const openaiV2 = loadUsageMapping(
	readJson("schema/mapping/usage.openai.llm.completion.v2.json"),
);
const anthropic = loadUsageMapping(rawMapping("anthropic.llm.completion"));
const grok = loadUsageMapping(rawMapping("grok.llm.completion"));
const storage = loadUsageMapping(rawMapping("storage.snapshot"));

type Sample = { name: string; event: Record<string, Loose> };
const llmSamples: Sample[] = readJson(
	"tests/spikes/usage-samples/openai.llm.completion.json",
);
const storageSamples: Sample[] = readJson(
	"tests/spikes/usage-samples/storage.snapshot.json",
);
const streamSamples: Sample[] = readJson(
	"tests/spikes/usage-samples/anthropic.streaming.json",
);
const providers = readJson("tests/spikes/usage-samples/providers.json");

const sample = (samples: Sample[], prefix: string): Sample["event"] => {
	const found = samples.find((entry) => entry.name.startsWith(prefix));
	if (!found) throw new Error(`no sample named ${prefix}`);
	return found.event;
};

const INGEST = Date.parse("2026-01-01T12:00:00Z");
const ctx = (extra: Partial<UsageContext> = {}): UsageContext => ({
	school: "school_a",
	ingestMs: INGEST,
	...extra,
});
const fact = (
	mapping: UsageMapping,
	event: unknown,
	extra: Partial<UsageContext> = {},
) => unwrapUsage(normalizeUsage(event, mapping, ctx(extra)));
const ledgerOf = (
	mapping: UsageMapping,
	event: unknown,
	extra: Partial<UsageEventContext> = {},
) =>
	usageLedgerEvent(fact(mapping, event), {
		school: "school_a",
		tz: "America/Denver",
		ingestMs: INGEST,
		mapping,
		raw: event,
		...extra,
	});
const errorOf = (
	mapping: UsageMapping,
	event: unknown,
	extra: Partial<UsageContext> = {},
): string => {
	const result = normalizeUsage(event, mapping, ctx(extra));
	if (result.ok) throw new Error("expected the event to be refused");
	return describeUsageError(result.error);
};

describe("the mapping files", () => {
	test("the four example mappings pass usage.schema.json and the soundness checks", () => {
		for (const name of [
			"openai.llm.completion",
			"anthropic.llm.completion",
			"grok.llm.completion",
			"storage.snapshot",
		])
			expect(() => loadUsageMapping(rawMapping(name))).not.toThrow();
	});

	test("a mapping that fails the schema is refused, each way", () => {
		const bad: [string, (m: Loose) => void, RegExp][] = [
			[
				"an extra property",
				(m) => {
					m.target = "Invoice";
				},
				/additional properties/,
			],
			[
				"a label with values and no onUnknown",
				(m) => {
					delete m.labels.model.onUnknown;
				},
				/onUnknown/,
			],
			[
				"a free label with no maxDistinct",
				(m) => {
					delete m.labels.region.maxDistinct;
				},
				/maxDistinct/,
			],
			[
				"a quantity with no meaning",
				(m) => {
					delete m.quantities.input_tokens.meaning;
				},
				/meaning/,
			],
			[
				"a decimal with no scale",
				(m) => {
					delete m.quantities.cost_usd.scale;
				},
				/scale/,
			],
			[
				"an int with a scale",
				(m) => {
					m.quantities.input_tokens.scale = 2;
				},
				/not|must/,
			],
			[
				"a label named like an envelope field",
				(m) => {
					m.labels.mapping = { path: "$.x", maxDistinct: 2 };
				},
				/not|valid/,
			],
			[
				"more than eight labels",
				(m) => {
					for (let i = 0; i < 9; i++)
						m.labels[`axis_${i}`] = { path: `$.a${i}`, maxDistinct: 2 };
				},
				/8|properties/,
			],
			[
				"a path outside the subset",
				(m) => {
					m.labels.region.path = "$.a[*].b";
				},
				/pattern/,
			],
			[
				"the stripe source",
				(m) => {
					m.source = "stripe";
				},
				/not|valid/,
			],
			[
				"no personal list",
				(m) => {
					delete m.personal;
				},
				/personal/,
			],
		];
		for (const [, change, message] of bad) {
			const mapping = rawMapping("openai.llm.completion");
			change(mapping);
			expect(() => loadUsageMapping(mapping)).toThrow(UsageMappingError);
			expect(() => loadUsageMapping(mapping)).toThrow(message);
		}
	});

	test("a mapping the schema allows but that is unsound is refused", () => {
		const unsound: [(m: Loose) => void, RegExp][] = [
			[
				(m) => {
					m.personal.push("$.usage");
				},
				/under a personal path/,
			],
			[
				(m) => {
					m.labels.who = { path: "$.user.id", maxDistinct: 5 };
				},
				/idem and key, never in labels/,
			],
			[
				(m) => {
					m.labels.req = { path: "$.request_id", maxDistinct: 5 };
				},
				/idem and key, never in labels/,
			],
			[
				(m) => {
					m.quantities.input_tokens.minus = ["nope"];
				},
				/unknown nope/,
			],
			[
				(m) => {
					m.labels.model.default = "nope";
				},
				/default is not one of values/,
			],
		];
		for (const [change, message] of unsound) {
			const mapping = rawMapping("openai.llm.completion");
			change(mapping);
			expect(() => loadUsageMapping(mapping)).toThrow(message);
		}
	});
});

describe("openai.llm.completion samples", () => {
	test("the full event becomes a fact with holder, idem, time, labels and quantities", () => {
		expect(fact(openai, sample(llmSamples, "full"))).toEqual({
			source: "openai",
			event: "llm.completion",
			mapping: "openai/llm.completion@v1",
			holder: "family:fam_8k2",
			idem: "usage:openai/llm.completion:req_001",
			requestId: "req_001",
			eventTimeMs: 1767225600000,
			labels: { model: "gpt-x", region: "us-east", usage_feature: "tutor" },
			quantities: {
				cache_read_tokens: 1000,
				cache_write_tokens: 0,
				cost_usd: "0.004200",
				duration_ms: 1800,
				input_tokens: 200,
				output_tokens: 200,
				reasoning_tokens: 100,
			},
			units: {
				cache_read_tokens: "token",
				cache_write_tokens: "token",
				cost_usd: "USD",
				duration_ms: "ms",
				input_tokens: "token",
				output_tokens: "token",
				reasoning_tokens: "token",
			},
		});
	});

	test("a missing optional label is left out, a missing defaulted label takes its default", () => {
		const result = fact(openai, sample(llmSamples, "missing optional"));
		expect(result.labels).toEqual({ model: "claude-y", usage_feature: "chat" });
		expect(result.quantities.cost_usd).toBeUndefined();
		expect(result.quantities.input_tokens).toBe(50);
	});

	test("an unknown model lands in the other bucket", () => {
		const result = fact(openai, sample(llmSamples, "unknown model"));
		expect(result.labels.model).toBe("other");
	});

	test("the reject variant refuses an unknown model with a message naming the field, path and value", () => {
		const strict = clone(rawMapping("openai.llm.completion"));
		strict.labels.model.onUnknown = "reject";
		delete strict.labels.model.other;
		const mapping = loadUsageMapping(strict);
		expect(() => fact(mapping, sample(llmSamples, "unknown model"))).toThrow(
			/\$\.model \(the mapping's labels\.model\) holds "gpt-z-preview", which is not in the mapping's values/,
		);
		expect(() => fact(mapping, sample(llmSamples, "full"))).not.toThrow();
	});

	test("the other bucket can be renamed", () => {
		const renamed = clone(rawMapping("openai.llm.completion"));
		renamed.labels.model.other = "unlisted";
		expect(
			fact(loadUsageMapping(renamed), sample(llmSamples, "unknown model"))
				.labels.model,
		).toBe("unlisted");
	});

	test("a duplicate request id gives the same idem, and the outbox keeps the first", () => {
		const first = fact(openai, sample(llmSamples, "full"));
		const again = fact(openai, sample(llmSamples, "duplicate"));
		expect(again.idem).toBe(first.idem);
		expect(again.eventTimeMs).not.toBe(first.eventTimeMs); // the retry carries another timestamp

		const db = new Database(":memory:");
		db.exec(HANDLER_DDL);
		const sql = sqlDatabase(db);
		const a = ledgerOf(openai, sample(llmSamples, "full"));
		const b = ledgerOf(openai, sample(llmSamples, "duplicate"));
		expect(appendToOutbox(sql, [a])).toBe(1);
		expect(appendToOutbox(sql, [b])).toBe(0);
		const rows = db.query("SELECT id, idem FROM ledger_outbox").all() as {
			id: string;
			idem: string;
		}[];
		expect(rows).toEqual([{ id: a.id, idem: first.idem }]);
		// Another school with the same request id is a different event.
		const other = ledgerOf(openai, sample(llmSamples, "full"), {
			school: "school_b",
		});
		expect(appendToOutbox(sql, [other])).toBe(1);
	});

	test("a late event keeps its old event time, is flagged, and can be rejected instead", () => {
		const late = fact(openai, sample(llmSamples, "late"));
		expect(late.late).toBe(true);
		expect(late.eventTimeMs).toBe(1735689600000);
		expect(fact(openai, sample(llmSamples, "full")).late).toBeUndefined();

		const strict = clone(rawMapping("openai.llm.completion"));
		strict.time.late.policy = "reject";
		expect(() =>
			fact(loadUsageMapping(strict), sample(llmSamples, "late")),
		).toThrow(
			/\$\.created \(the mapping's time\) is \d+ seconds old at ingest/,
		);
	});

	test("an event from the future is refused", () => {
		const event = clone(sample(llmSamples, "full"));
		event.created = INGEST / 1000 + 3600;
		expect(errorOf(openai, event)).toMatch(
			/\$\.created \(the mapping's time\) is in the future/,
		);
	});

	test("personal fields are stripped from any kept copy and never reach the fact", () => {
		const event = sample(llmSamples, "personal");
		const before = clone(event);
		const redacted = redactUsage(event, openai) as typeof event;
		expect(event).toEqual(before); // the input is untouched
		expect(redacted.user).toEqual({ id: "fam_8k2" });
		expect(redacted.messages).toBeUndefined();
		expect(redacted.response).toEqual({}); // the path is removed, its (now empty) parent stays
		expect(JSON.stringify(redacted)).not.toMatch(/Ada|parent@example|halves/);

		const direct = fact(openai, event);
		expect(JSON.stringify(direct)).not.toMatch(/Ada|parent@example|halves/);
		expect(fact(openai, redacted)).toEqual(direct); // the redacted copy still normalizes to the same fact
	});

	test("a malformed quantity is refused with a message naming the field and the path", () => {
		expect(
			errorOf(openai, sample(llmSamples, "malformed quantity: prompt_tokens")),
		).toBe(
			"$.usage.prompt_tokens (the mapping's quantities.input_tokens) is not a int",
		);
		expect(
			errorOf(openai, sample(llmSamples, "malformed quantity: cached")),
		).toBe(
			"$.usage.prompt_tokens (the mapping's quantities.input_tokens) is below 0 after subtracting cache_read_tokens",
		);
		expect(
			errorOf(openai, sample(llmSamples, "malformed quantity: cost")),
		).toBe(
			"$.usage.cost_usd (the mapping's quantities.cost_usd) has more than 6 decimal places (refused, not rounded)",
		);
		for (const bad of [12.5, -4, null, true, {}, 2 ** 60]) {
			const event = clone(sample(llmSamples, "full"));
			event.usage.completion_tokens = bad;
			expect(errorOf(openai, event)).toMatch(/\$\.usage\.completion_tokens/);
		}
	});

	test("an email where the user id should be is refused and the message does not repeat it", () => {
		const message = errorOf(openai, sample(llmSamples, "an email"));
		expect(message).toMatch(/\$\.user\.id \(the mapping's holder\)/);
		expect(message).not.toContain("parent@example.org");
	});

	test("a missing required path, and another source version, are refused by name", () => {
		const noModel = clone(sample(llmSamples, "full"));
		delete noModel.model;
		expect(errorOf(openai, noModel)).toBe(
			"the event has nothing at $.model (the mapping's labels.model)",
		);
		const moved = clone(sample(llmSamples, "full"));
		moved.schema = "gateway-log-2026-09";
		expect(errorOf(openai, moved)).toMatch(
			/not at source version gateway-log-2026-01 \(read at \$\.schema\)/,
		);
	});

	test("the same input gives the same output", () => {
		for (const entry of llmSamples) {
			const a = normalizeUsage(entry.event, openai, ctx());
			const b = normalizeUsage(clone(entry.event), openai, ctx());
			expect(JSON.stringify(b)).toBe(JSON.stringify(a));
		}
		const first = JSON.stringify(fact(openai, sample(llmSamples, "full")));
		// Key order in the raw event does not change the bytes.
		const shuffled = Object.fromEntries(
			Object.entries(sample(llmSamples, "full")).reverse(),
		);
		expect(JSON.stringify(fact(openai, shuffled))).toBe(first);
	});
});

describe("storage.snapshot samples (a second usage kind with another label set)", () => {
	test("the good samples normalize; levels are quantities, bucket_class and region are labels", () => {
		const full = fact(storage, sample(storageSamples, "full"));
		expect(full.labels).toEqual({
			bucket_class: "standard",
			region: "us-east",
		});
		expect(full.quantities).toEqual({
			gb_month_cost: "0.123456",
			object_count: 1204,
			stored_bytes: 5368709120,
		});
		expect(full.idem).toBe("usage:storage/storage.snapshot:snap_001");
		expect(
			fact(storage, sample(storageSamples, "missing optional")).quantities
				.gb_month_cost,
		).toBeUndefined();
		expect(fact(storage, sample(storageSamples, "duplicate")).idem).toBe(
			full.idem,
		);
		expect(
			JSON.stringify(fact(storage, sample(storageSamples, "personal data"))),
		).not.toContain("example.org");
	});

	test("a mapping that rejects unknown values refuses the unknown class, a required label must be present", () => {
		expect(errorOf(storage, sample(storageSamples, "unknown class"))).toMatch(
			/\$\.class \(the mapping's labels\.bucket_class\) holds "glacier-deep"/,
		);
		expect(errorOf(storage, sample(storageSamples, "missing required"))).toBe(
			"the event has nothing at $.region (the mapping's labels.region)",
		);
	});

	test("malformed quantities are refused by name", () => {
		expect(
			errorOf(
				storage,
				sample(storageSamples, "malformed quantity: stored_bytes"),
			),
		).toBe(
			"$.stored_bytes (the mapping's quantities.stored_bytes) is not a int",
		);
		expect(
			errorOf(storage, sample(storageSamples, "malformed quantity: negative")),
		).toBe(
			"$.objects (the mapping's quantities.object_count) is below the minimum 0",
		);
	});
});

describe("token semantics (agentlake lesson 1)", () => {
	test("cached input counted inside prompt tokens and reported separately normalize to the same quantities", () => {
		const fromOpenai = fact(openai, providers.openai); // prompt_tokens 1200 includes 1000 cached
		const fromAnthropic = fact(anthropic, providers.anthropic); // input_tokens 200 and cache_read 1000 apart
		const fromGrok = fact(grok, providers.grok); // inputTokens 1200 includes 1000 cached
		for (const produced of [fromOpenai, fromAnthropic, fromGrok]) {
			expect(produced.quantities.input_tokens).toBe(200);
			expect(produced.quantities.cache_read_tokens).toBe(1000);
			expect(produced.quantities.cache_write_tokens).toBe(0);
			// Anthropic does not split thinking out of output, so only output + reasoning is comparable.
			expect(
				(produced.quantities.output_tokens as number) +
					(produced.quantities.reasoning_tokens as number),
			).toBe(300);
			const total = [
				"input_tokens",
				"cache_read_tokens",
				"cache_write_tokens",
				"output_tokens",
				"reasoning_tokens",
			].reduce((sum, name) => sum + (produced.quantities[name] as number), 0);
			expect(total).toBe(1500); // the quantities are disjoint: their sum is what the provider billed on
		}
		expect(fromOpenai.quantities.reasoning_tokens).toBe(100);
		expect(fromAnthropic.quantities.reasoning_tokens).toBe(0);
	});

	test("every quantity names its meaning, and the LLM mappings share one vocabulary", () => {
		for (const mapping of [openai, anthropic, grok]) {
			for (const spec of Object.values(mapping.quantities))
				expect(spec.meaning.length).toBeGreaterThan(8);
			for (const name of [
				"input_tokens",
				"output_tokens",
				"cache_read_tokens",
				"cache_write_tokens",
				"reasoning_tokens",
			])
				expect(mapping.quantities[name]).toBeDefined();
			expect(mapping.quantities.input_tokens?.meaning).toMatch(/UNCACHED/);
		}
	});
});

describe("repeats while streaming (agentlake lesson 2)", () => {
	const streamFacts = (mapping: UsageMapping) =>
		streamSamples.map((entry) => fact(mapping, entry.event));

	test("one response id logged three times with growing counts is one fact at the final count under onRepeat max", () => {
		const facts = streamFacts(anthropic);
		expect(facts.map((entry) => entry.idem).slice(0, 3)).toEqual(
			Array(3).fill("usage:anthropic/llm.completion:msg_s1"),
		);
		expect(facts.map((entry) => entry.quantities.output_tokens)).toEqual([
			1, 120, 480, 12,
		]);

		const collapsed = collapseRepeats(facts, anthropic);
		expect(collapsed.conflicts).toEqual([]);
		expect(
			collapsed.facts.map((entry) => [
				entry.requestId,
				entry.quantities.output_tokens,
			]),
		).toEqual([
			["msg_s1", 480],
			["msg_s2", 12],
		]);
		// Summed per response, not per line: 480 + 12, not 1 + 120 + 480 + 12.
		expect(sumQuantity(collapsed.facts, "output_tokens")).toBe("492");
		expect(sumQuantity(facts, "output_tokens")).toBe("613");
	});

	test("first (the ledger's own idem rule) would keep the first delta, which is why max is a mapping rule", () => {
		const first = clone(rawMapping("anthropic.llm.completion"));
		first.id.onRepeat = "first";
		const mapping = loadUsageMapping(first);
		const collapsed = collapseRepeats(streamFacts(mapping), mapping);
		expect(collapsed.facts[0]?.quantities.output_tokens).toBe(1);
	});

	test("max does not depend on arrival order, and a count that goes down is reported", () => {
		const facts = streamFacts(anthropic).slice(0, 3);
		const reversed = collapseRepeats([...facts].reverse(), anthropic);
		expect(reversed.facts[0]?.quantities.output_tokens).toBe(480);
		expect(
			reversed.conflicts.map((entry) => [entry.quantity, entry.from, entry.to]),
		).toEqual([
			["output_tokens", 480, 120],
			["output_tokens", 480, 1],
		]);
	});

	test("the raw timestamps differ per delta but the idem and the id come from the response id only", () => {
		const times = new Set(
			streamFacts(anthropic)
				.slice(0, 3)
				.map((entry) => entry.eventTimeMs),
		);
		expect(times.size).toBe(3);
	});
});

describe("numbers (agentlake lesson 3): quantities are exact, labels are never numbers", () => {
	const grokFact = (ticks: number, turn: string) => {
		const event = clone(providers.grok);
		event.update.turnId = turn;
		event.update.usage.costUsdTicks = ticks;
		return fact(grok, event);
	};

	test("a derived cost carries 10^-10 dollars exactly where the float sum drifts", () => {
		expect(grokFact(42000000, "t0").quantities.cost_usd).toBe("0.0042000000");
		expect(grokFact(7, "t1").quantities.cost_usd).toBe("0.0000000007");
		const ticks = [1_000_000_000, 2_000_000_000, 1_234_567_891, 7];
		const facts = ticks.map((value, index) => grokFact(value, `t${index}`));
		expect(sumQuantity(facts, "cost_usd", 10)).toBe("0.4234567898");
		// The DOUBLE route agentlake takes: ticks / 1e10, summed as floats.
		expect(1_000_000_000 / 1e10 + 2_000_000_000 / 1e10).not.toBe(0.3);
		expect(sumQuantity(facts.slice(0, 2), "cost_usd", 10)).toBe("0.3000000000");
	});

	test("a decimal from a string or a plain number is exact; excess places and exponents are refused, never rounded", () => {
		const withCost = (cost: unknown) => {
			const event = clone(sample(llmSamples, "full"));
			event.usage.cost_usd = cost;
			return event;
		};
		expect(fact(openai, withCost("0.1")).quantities.cost_usd).toBe("0.100000");
		expect(fact(openai, withCost(0.5)).quantities.cost_usd).toBe("0.500000");
		expect(fact(openai, withCost("12")).quantities.cost_usd).toBe("12.000000");
		expect(fact(openai, withCost("0.1234560")).quantities.cost_usd).toBe(
			"0.123456",
		); // zeros past the scale are fine
		expect(errorOf(openai, withCost("0.1234567"))).toMatch(
			/more than 6 decimal places/,
		);
		expect(errorOf(openai, withCost(1e-7))).toMatch(/not a plain decimal/);
		expect(errorOf(openai, withCost("-1"))).toMatch(/below the minimum 0/);
		expect(errorOf(openai, withCost("abc"))).toMatch(/not a plain decimal/);
	});

	test("a fact is JSON-safe: integers are numbers, decimals are strings, no label is a number", () => {
		const produced = fact(openai, sample(llmSamples, "full"));
		expect(Number.isInteger(produced.quantities.input_tokens)).toBe(true);
		expect(typeof produced.quantities.cost_usd).toBe("string");
		for (const value of Object.values(produced.labels))
			expect(typeof value).toBe("string");
		const numberLabel = clone(rawMapping("openai.llm.completion"));
		numberLabel.labels.tier = { path: "$.tier", type: "int", maxDistinct: 4 };
		const event = clone(sample(llmSamples, "full"));
		event.tier = 3;
		expect(fact(loadUsageMapping(numberLabel), event).labels.tier).toBe("3");
	});
});

describe("cardinality guard (label explosion)", () => {
	const limited = (max: number, onUnknown?: "other") => {
		const raw = clone(rawMapping("openai.llm.completion"));
		raw.labels.region.maxDistinct = max;
		if (onUnknown) raw.labels.region.onUnknown = onUnknown;
		return loadUsageMapping(raw);
	};
	const inRegion = (region: string, id: string) => {
		const event = clone(sample(llmSamples, "full"));
		event.region = region;
		event.request_id = id;
		return event;
	};

	test("a free-form label takes at most maxDistinct values per school; the next new one is quarantined", () => {
		const mapping = limited(3);
		const guard = new LabelCardinalityGuard();
		for (const region of ["r1", "r2", "r3"])
			expect(
				fact(mapping, inRegion(region, region), { guard }).labels.region,
			).toBe(region);
		expect(errorOf(mapping, inRegion("r4", "x4"), { guard })).toBe(
			"$.region (the mapping's labels.region) would be a new value past the limit of 3 distinct values per school; the event is quarantined, not recorded",
		);
		expect(
			fact(mapping, inRegion("r2", "again"), { guard }).labels.region,
		).toBe("r2"); // a known value is still fine
		expect(guard.distinct("school_a", "region")).toBe(3);
	});

	test("with onUnknown other the overflow is bucketed instead of refused", () => {
		const mapping = limited(2, "other");
		const guard = new LabelCardinalityGuard();
		fact(mapping, inRegion("r1", "a"), { guard });
		fact(mapping, inRegion("r2", "b"), { guard });
		expect(fact(mapping, inRegion("r3", "c"), { guard }).labels.region).toBe(
			"other",
		);
		expect(guard.distinct("school_a", "region")).toBe(2);
	});

	test("the cap is per school, and a refused event does not use up a slot", () => {
		const mapping = limited(1);
		const guard = new LabelCardinalityGuard();
		const broken = inRegion("r1", "bad");
		broken.usage.prompt_tokens = "many";
		expect(errorOf(mapping, broken, { guard })).toMatch(
			/quantities\.input_tokens/,
		);
		expect(guard.distinct("school_a", "region")).toBe(0);
		fact(mapping, inRegion("r1", "ok"), { guard });
		expect(errorOf(mapping, inRegion("r2", "no"), { guard })).toMatch(
			/past the limit of 1/,
		);
		expect(
			fact(mapping, inRegion("r2", "other-school"), {
				guard,
				school: "school_b",
			}).labels.region,
		).toBe("r2");
	});

	test("what must not be a label is kept out: ids by the loader, free text and emails by the character set, the number of axes by the schema", () => {
		const mapping = limited(5);
		const guard = new LabelCardinalityGuard();
		expect(
			errorOf(mapping, inRegion("parent@example.org", "e1"), { guard }),
		).toMatch(/has characters outside/);
		expect(
			errorOf(mapping, inRegion("a long sentence with spaces", "e2"), {
				guard,
			}),
		).toMatch(/has characters outside/);
		expect(errorOf(mapping, inRegion("x".repeat(65), "e3"), { guard })).toMatch(
			/too long/,
		);
		expect(guard.distinct("school_a", "region")).toBe(0);
		// The ids are in idem (and key), not labels.
		const produced = fact(mapping, inRegion("r1", "req_77"), { guard });
		expect(produced.idem).toContain("req_77");
		expect(JSON.stringify(produced.labels)).not.toContain("req_77");
		expect(JSON.stringify(produced.labels)).not.toContain("fam_8k2");
	});
});

describe("the ledger envelope", () => {
	const school = "school_a";
	const tz = "America/Denver";
	const built = () => ledgerOf(openai, sample(llmSamples, "full"));

	const payloadSchema = readJson(
		"schema/payload-proposed/usage.recorded.v1.json",
	);
	const proposed = (event: Loose) => {
		const ajv = new Ajv2020({ allErrors: true, strict: false });
		const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
		ajv.addFormat(
			"date-time",
			(text) => instant.test(text) && !Number.isNaN(Date.parse(text)),
		);
		ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
		ajv.addFormat("decimal", /^-?\d+(\.\d+)?$/);
		const widened = clone(envelope) as Loose;
		widened.properties.event_type.enum.push("usage.recorded");
		const errors = [
			...(ajv.validate(widened, event) ? [] : (ajv.errors ?? [])),
			...(ajv.validate(payloadSchema, event.payload)
				? []
				: (ajv.errors ?? []).map((error) => ({
						...error,
						instancePath: `/payload${error.instancePath}`,
					}))),
		];
		// The two rules a schema cannot say, as validateEvent applies them.
		if (ulidTime(event.id) !== Date.parse(event.event_time))
			errors.push({
				instancePath: "/id",
				message: "id time is not event_time",
			} as never);
		if (event.date !== localDate(Date.parse(event.event_time), event.tz))
			errors.push({
				instancePath: "/date",
				message: "date is not event_time in tz",
			} as never);
		return errors.map((error) => `${error.instancePath} ${error.message}`);
	};

	test("buildEvent takes the usage fact as it is: no postings, string labels, idem from the request id, quantities in the payload", () => {
		const event = built();
		expect(event.event_type as string).toBe("usage.recorded");
		expect(event.postings).toEqual([]);
		expect(event.key).toBe("family:fam_8k2");
		expect(event.source).toBe("openai");
		expect(event.idem).toBe("usage:openai/llm.completion:req_001");
		expect(event.labels).toEqual({
			mapping: "openai/llm.completion@v1",
			model: "gpt-x",
			region: "us-east",
			usage_feature: "tutor",
		});
		expect(event.payload).toEqual({
			payload_schema: 1,
			mapping_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
			raw_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			mapping: "openai/llm.completion@v1",
			request_id: "req_001",
			quantities: {
				cache_read_tokens: 1000,
				cache_write_tokens: 0,
				cost_usd: "0.004200",
				duration_ms: 1800,
				input_tokens: 200,
				output_tokens: 200,
				reasoning_tokens: 100,
			},
			units: {
				cache_read_tokens: "token",
				cache_write_tokens: "token",
				cost_usd: "USD",
				duration_ms: "ms",
				input_tokens: "token",
				output_tokens: "token",
				reasoning_tokens: "token",
			},
		});
		expect(event.date).toBe("2025-12-31"); // 2026-01-01T00:00Z in Denver
		expect(event.event_time).toBe("2026-01-01T00:00:00Z");
		expect(event.ingest_time).toBe("2026-01-01T12:00:00Z");
	});

	test("the existing validator refuses it for ONE reason: usage.recorded is not in the event_type enum", () => {
		const result = validateEvent(built());
		expect(result.ok).toBe(false);
		expect(result.errors.map((error) => error.path)).toEqual(["/event_type"]);
		expect(result.errors[0]?.message).toMatch(/allowed values/);
	});

	test("with the enum widened and usage.recorded.v1.json added, the event validates", () => {
		expect(proposed(built())).toEqual([]);
		const late = ledgerOf(openai, sample(llmSamples, "late"));
		expect(proposed(late)).toEqual([]);
		expect(late.payload.late).toBe(true);
		expect(late.event_time).toBe("2025-01-01T00:00:00Z");
		expect(late.ingest_time).toBe("2026-01-01T12:00:00Z");
	});

	test("every example sample that normalizes builds a valid event", () => {
		const cases: [UsageMapping, Sample[]][] = [
			[openai, llmSamples],
			[storage, storageSamples],
			[anthropic, streamSamples],
		];
		let built = 0;
		for (const [mapping, samples] of cases)
			for (const entry of samples) {
				const result = normalizeUsage(entry.event, mapping, ctx());
				if (!result.ok) continue;
				expect(
					proposed(
						usageLedgerEvent(result.value, {
							school,
							tz,
							ingestMs: INGEST,
							mapping,
							raw: entry.event,
						}),
					),
				).toEqual([]);
				built += 1;
			}
		expect(built).toBe(14);
	});

	test("the payload schema refuses a float quantity, a unit-less quantity, a command key and unknown keys", () => {
		const base = built();
		const withPayload = (change: (payload: Loose) => void) => {
			const event = clone(base) as Loose;
			change(event.payload);
			return proposed(event);
		};
		expect(
			withPayload((payload) => {
				payload.quantities.input_tokens = 1.5;
			}).join(),
		).toMatch(/payload\/quantities\/input_tokens/);
		expect(
			withPayload((payload) => {
				payload.quantities.cost_usd = "1e-7";
			}).join(),
		).toMatch(/payload\/quantities\/cost_usd/);
		expect(
			withPayload((payload) => {
				payload.command = { type: "track" };
			}).join(),
		).toMatch(/payload/);
		expect(
			withPayload((payload) => {
				payload.messages = [];
			}).join(),
		).toMatch(/additional properties/);
		expect(
			withPayload((payload) => {
				delete payload.units;
			}).join(),
		).toMatch(/units/);
	});

	test("labels are strings only: a number label is stringified by the mapping, a number in the envelope labels is refused", () => {
		const event = clone(built()) as Loose;
		event.labels.tokens = 5;
		expect(proposed(event).join()).toMatch(/labels\/tokens/);
	});

	test("the payload is a small fraction of the raw event: prompts and messages never enter the ledger", () => {
		const event = clone(sample(llmSamples, "personal"));
		event.messages = Array.from({ length: 40 }, (_, index) => ({
			role: "user",
			content: `message ${index} ${"x".repeat(500)}`,
		}));
		const rawBytes = JSON.stringify(event).length;
		const ledgerBytes = JSON.stringify(ledgerOf(openai, event)).length;
		expect(rawBytes).toBeGreaterThan(20000);
		expect(ledgerBytes).toBeLessThan(1500);
		expect(JSON.stringify(redactUsage(event, openai)).length).toBeLessThan(
			rawBytes / 10,
		); // a kept raw copy loses its messages too
	});

	// ---- provenance and re-mapping ----

	const goodLlm = llmSamples.filter(
		(entry) => !/^(malformed|an email)/.test(entry.name),
	);
	const registryOf = (...mappings: UsageMapping[]) =>
		new Map(
			mappings.map((mapping) => [
				`${mapping.source}/${mapping.event}@v${mapping.v}`,
				mapping,
			]),
		);
	/** The stored redacted raw, by hash: what an input store (one R2 object per hash) would hold. */
	const rawStoreOf = (mapping: UsageMapping, events: unknown[]) =>
		new Map(
			events.map((event) => [
				rawDigest(event, mapping),
				redactUsage(event, mapping),
			]),
		);

	test("provenance: payload_schema, mapping, mapping digest and raw hash are in the payload; mapping is also a label", () => {
		const event = built();
		const payload = event.payload as Record<string, unknown>;
		expect(payload.payload_schema).toBe(1);
		expect(payload.mapping).toBe("openai/llm.completion@v1");
		expect(event.labels.mapping).toBe(payload.mapping as string);
		expect(payload.mapping_digest).toBe(mappingDigest(openai));
		expect(payload.raw_sha256).toBe(
			rawDigest(sample(llmSamples, "full"), openai),
		);
		expect(proposed(event)).toEqual([]);
		expect(mappingDigest(openaiV2)).not.toBe(mappingDigest(openai));
		// A payload that does not say which schema or mapping made it is refused.
		for (const missing of [
			"payload_schema",
			"mapping",
			"mapping_digest",
			"raw_sha256",
		]) {
			const broken = clone(event) as Loose;
			delete broken.payload[missing];
			expect(proposed(broken).join()).toContain(missing);
		}
	});

	test("a reader with the events, the stored redacted raw and the mapping files re-derives every fact", () => {
		const rawStore = rawStoreOf(
			openai,
			goodLlm.map((entry) => entry.event),
		);
		const registry = registryOf(openai, openaiV2);
		expect(JSON.stringify([...rawStore.values()])).not.toMatch(
			/parent@example|Ada Lovelace|halves/,
		);
		for (const entry of goodLlm) {
			const event = ledgerOf(openai, entry.event);
			const again = rederiveFact(event, registry, rawStore);
			expect(again.quantities).toEqual(
				event.payload.quantities as Record<string, number | string>,
			);
			expect(again.units).toEqual(
				event.payload.units as Record<string, string>,
			);
			expect(again.labels).toEqual(
				Object.fromEntries(
					Object.entries(event.labels).filter(([name]) => name !== "mapping"),
				),
			);
			expect(again.idem).toBe(event.idem);
			expect(again.eventTimeMs).toBe(Date.parse(event.event_time));
			expect(again.late === true).toBe(event.payload.late === true); // lateness reproduces: it uses the event's own ingest_time
		}
	});

	test("re-mapping the same stored raw through v2 gives a different fact under a new mapping version; v1 stays reproducible", () => {
		const events = [
			sample(llmSamples, "full"),
			sample(llmSamples, "unknown model"),
		];
		const rawStore = rawStoreOf(openai, events);
		const registry = registryOf(openai, openaiV2);
		const [fullV1, unknownV1] = events.map((event) => ledgerOf(openai, event));
		if (!fullV1 || !unknownV1) throw new Error("events");
		const before = JSON.stringify(rederiveFact(fullV1, registry, rawStore));

		const fullV2 = rederiveFact(fullV1, registry, rawStore, openaiV2);
		expect(fullV2.mapping).toBe("openai/llm.completion@v2");
		expect(fullV2.quantities.output_tokens).toBe(300); // v1: 200 (reasoning subtracted)
		expect(fullV1.payload.quantities).toMatchObject({ output_tokens: 200 });
		expect(
			rederiveFact(unknownV1, registry, rawStore, openaiV2).labels.model,
		).toBe("gpt-z-preview"); // v1: other
		expect(unknownV1.labels.model).toBe("other");

		// v1 is unchanged by v2 existing, and a v1 event still checks its own file.
		expect(JSON.stringify(rederiveFact(fullV1, registry, rawStore))).toBe(
			before,
		);
		expect(
			JSON.stringify(rederiveFact(fullV1, registryOf(openai), rawStore)),
		).toBe(before);
	});

	test("a v2 event for the same request has the same idem and is dropped, so a re-map is a new event that points at the original", () => {
		const raw = sample(llmSamples, "full");
		const v1 = ledgerOf(openai, raw);
		const sameIdem = ledgerOf(openaiV2, raw);
		expect(sameIdem.idem).toBe(v1.idem);
		const db = new Database(":memory:");
		db.exec(HANDLER_DDL);
		const sql = sqlDatabase(db);
		expect(appendToOutbox(sql, [v1])).toBe(1);
		expect(appendToOutbox(sql, [sameIdem])).toBe(0); // the outbox keeps the first write of an idem

		const remap = ledgerOf(openaiV2, raw, { remapOf: v1 });
		expect(remap.idem).toBe(`${v1.idem}#remap@v2`);
		expect(remap.cause).toBe(v1.id);
		expect(remap.payload.mapping).toBe("openai/llm.completion@v2");
		expect(remap.payload.mapping_digest).not.toBe(v1.payload.mapping_digest);
		expect(remap.payload.raw_sha256).toBe(v1.payload.raw_sha256); // same stored raw
		expect(remap.event_time).toBe(v1.event_time);
		expect(proposed(remap)).toEqual([]);
		expect(appendToOutbox(sql, [remap])).toBe(1);

		// Both are now in the log, so a reader must take the highest mapping version per request, or it counts the call twice.
		const all = [v1, remap];
		const version = (event: { payload: Record<string, unknown> }) =>
			Number(String(event.payload.mapping).split("@v")[1]);
		const latest = new Map<string, (typeof all)[number]>();
		for (const event of all) {
			const key = String(event.payload.request_id);
			const kept = latest.get(key);
			if (!kept || version(event) > version(kept)) latest.set(key, event);
		}
		const outputOf = (events: Iterable<(typeof all)[number]>) =>
			[...events].reduce(
				(sum, event) =>
					sum +
					(event.payload.quantities as { output_tokens: number }).output_tokens,
				0,
			);
		expect(outputOf(all)).toBe(500); // double counted
		expect(outputOf(latest.values())).toBe(300);
	});

	test("a mapping file that is not the one that ran, or a missing raw, is refused loudly", () => {
		const raw = sample(llmSamples, "full");
		const event = ledgerOf(openai, raw);
		const rawStore = rawStoreOf(openai, [raw]);
		const edited = clone(rawMapping("openai.llm.completion"));
		edited.labels.model.values.push("sneaky");
		expect(() =>
			rederiveFact(event, registryOf(loadUsageMapping(edited)), rawStore),
		).toThrow(
			/is not the file that ran: digest [0-9a-f]{64} is not [0-9a-f]{64}/,
		);
		expect(() => rederiveFact(event, registryOf(openai), new Map())).toThrow(
			/no stored raw event [0-9a-f]{64}/,
		);
		expect(() => rederiveFact(event, new Map(), rawStore)).toThrow(
			/no mapping file for openai\/llm.completion@v1/,
		);
	});

	test("the envelope alternative: a top-level mapping or payload_schema is refused today and needs the envelope, the DDL and its drift test to change", () => {
		const withTopLevel = {
			...built(),
			mapping: "openai/llm.completion@v1",
			payload_schema: 1,
		};
		const result = validateEvent(withTopLevel);
		expect(result.errors.map((error) => error.message).join()).toMatch(
			/additional properties \(mapping\)/,
		);

		const widened = clone(envelope) as Loose;
		widened.properties.mapping = { type: "string", minLength: 1 };
		widened.properties.payload_schema = { type: "integer" };
		const ddl = duckdbDdl(widened);
		expect(ddl).toContain("\tmapping VARCHAR,\n");
		expect(ddl).toContain("\tpayload_schema BIGINT\n");
		expect(ddl).not.toBe(
			readFileSync(join(root, "schema/duckdb/envelope.v1.sql"), "utf8"),
		); // the committed DDL (and its drift test) must be regenerated

		// What works with no envelope change: the label is already a queryable column.
		expect(duckdbDdl(envelope)).toContain(
			"labels MAP(VARCHAR, VARCHAR) NOT NULL",
		);
	});
});

describe("format contract (agentlake lesson 5): a changed provider payload fails loudly", () => {
	test("every good sample of every mapping has no unknown and no missing keys", () => {
		const cases: [UsageMapping, unknown[]][] = [
			[openai, llmSamples.map((entry) => entry.event)],
			[storage, storageSamples.map((entry) => entry.event)],
			[
				anthropic,
				[...streamSamples.map((entry) => entry.event), providers.anthropic],
			],
			[grok, [providers.grok]],
		];
		for (const [mapping, events] of cases)
			for (const event of events) {
				// samples that are broken on purpose lack required keys; only unknown keys matter for them
				const drift = shapeDrift(event, mapping);
				expect(drift.unknown).toEqual([]);
			}
		for (const entry of llmSamples.filter(
			(entry) =>
				!entry.name.startsWith("malformed") &&
				!entry.name.startsWith("an email"),
		))
			expect(shapeDrift(entry.event, openai)).toEqual({
				unknown: [],
				missing: [],
			});
	});

	test("a renamed field and a new field are both named", () => {
		const event = clone(sample(llmSamples, "full"));
		event.usage.input_tokens = event.usage.prompt_tokens;
		delete event.usage.prompt_tokens;
		event.user.phone = "+1 555 0100";
		const drift = shapeDrift(event, openai);
		expect(drift.unknown).toEqual(["$.usage.input_tokens", "$.user.phone"]);
		expect(drift.missing).toEqual(["$.usage.prompt_tokens"]);
		expect(() => assertNoDrift(event, openai)).toThrow(
			/openai\/llm\.completion@v1 format drift: unknown keys \[\$\.usage\.input_tokens, \$\.user\.phone\], missing required \[\$\.usage\.prompt_tokens\]/,
		);
		expect(() =>
			assertNoDrift(sample(llmSamples, "full"), openai),
		).not.toThrow();
	});

	test("keys under a personal path are known (prompts may change shape freely), a new key beside them is not", () => {
		const event = clone(sample(llmSamples, "personal"));
		event.messages.push({
			role: "tool",
			tool_calls: [{ id: "x", arguments: "{}" }],
		});
		expect(shapeDrift(event, openai).unknown).toEqual([]);
		event.attachments = [{ name: "homework.pdf" }];
		expect(shapeDrift(event, openai).unknown).toEqual([
			"$.attachments",
			"$.attachments[].name",
		]);
	});

	test("a source version change is refused by the mapping, so a provider cannot change shape silently", () => {
		const event = clone(sample(llmSamples, "full"));
		event.schema = "gateway-log-2026-09";
		expect(errorOf(openai, event)).toMatch(
			/source version gateway-log-2026-01/,
		);
	});
});

const sqlDatabase = (db: Database): SqlDatabase => ({
	exec: (sql) => {
		db.exec(sql);
	},
	all: <T>(sql: string, params: readonly unknown[] = []) =>
		db.query(sql).all(...(params as never[])) as T[],
	run: (sql, params = []) => ({
		changes: db.query(sql).run(...(params as never[])).changes,
	}),
	transaction: (fn) => db.transaction(fn)(),
});
