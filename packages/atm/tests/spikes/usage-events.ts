/**
 * Spike helper: synthetic `usage.recorded` events in the ledger envelope, as the outbox would hold them.
 *
 * Every line is `canonicalize(event)` (keys sorted), the same bytes `appendToOutbox` stores as `body`. The id is the
 * real `deterministicUlid`, so `ulidTime(id) === event_time` and the envelope's other rules hold. `event_type` is
 * `usage.recorded`, which the envelope's enum does not list: the spike test shows that. Holders are heavy-tailed
 * (Zipf), the ingest stream is time-ordered over one month, `lateRate` of the events carry an event time 1 to 40 days
 * before their ingest time, and `duplicateRate` of the events are sent a second time later (same `idem`, same id, a
 * later `ingest_time`).
 */
import { deterministicUlid } from "../../src/ledger/ids.js";
import { canonicalize } from "../../src/ledger/util.js";

export const USAGE_EVENT_TYPE = "usage.recorded";

export const USAGE_MODELS = [
	{ model: "xl-2", weight: 8, embedding: false },
	{ model: "lg-2", weight: 22, embedding: false },
	{ model: "md-2", weight: 40, embedding: false },
	{ model: "sm-2", weight: 25, embedding: false },
	{ model: "embed-2", weight: 5, embedding: true },
] as const;
export const USAGE_FEATURES = [
	{ name: "chat", weight: 60 },
	{ name: "search", weight: 30 },
	{ name: "summarize", weight: 10 },
] as const;
export const USAGE_REGIONS = [
	{ name: "us-east", weight: 55 },
	{ name: "eu-west", weight: 30 },
	{ name: "ap-south", weight: 15 },
] as const;

const DAY_MS = 86_400_000;
const MAX_LATE_DAYS = 40;
const ZIPF_EXPONENT = 1.1;
const MAX_ARRIVAL_JITTER_MS = 5000;
const UINT32 = 4_294_967_296;
const BASE36 = 36;
const HOLDER_DIGITS = 6;
const REQUEST_ID_CHARS = 20;

export type UsageGenOptions = {
	/** Distinct events (duplicates come on top). */
	events: number;
	holders: number;
	seed?: number;
	/** The ingest month, `YYYY-MM`; late events reach back into earlier months. */
	month?: string;
	school?: string;
	duplicateRate?: number;
	lateRate?: number;
	/** When set, the payload carries `schema_version`; version 2 also carries `reasoning_tokens` (about a fifth of the tokens spent on non-embedding models). Unset: the payload has neither, the shape the benchmarks used. */
	schemaVersion?: 1 | 2;
};

export type GeneratedUsage = {
	line: string;
	id: string;
	idem: string;
	holder: string;
	model: string;
	eventMs: number;
	ingestMs: number;
	/** `YYYY-MM-DD` of the event time (tz UTC): the shipper's partition. */
	eventDate: string;
	ingestDate: string;
	late: boolean;
	duplicate: boolean;
	inputTokens: number;
	outputTokens: number;
};

/** A small deterministic PRNG (mulberry32): the same seed gives the same stream on every machine. */
export const makeRandom = (seed: number): (() => number) => {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / UINT32;
	};
};

const cumulative = (weights: readonly number[]): number[] => {
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let running = 0;
	return weights.map((weight) => {
		running += weight / total;
		return running;
	});
};

const pick = (cdf: readonly number[], draw: number): number => {
	let low = 0;
	let high = cdf.length - 1;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((cdf[mid] ?? 1) < draw) low = mid + 1;
		else high = mid;
	}
	return low;
};

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const holderId = (index: number): string =>
	`cus_${index.toString(BASE36).padStart(HOLDER_DIGITS, "0")}`;

const REQUEST_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

/**
 * The events in ingest order. Each `GeneratedUsage.line` is one outbox body. A duplicate is the same event sent again
 * with a later `ingest_time`, so it lands in a later batch of the same event date.
 */
export function* generateUsage(
	options: UsageGenOptions,
): Generator<GeneratedUsage> {
	const {
		events,
		holders,
		seed = 1,
		month = "2026-10",
		school = "sch_acme",
		duplicateRate = 0.01,
		lateRate = 0.01,
		schemaVersion,
	} = options;
	const random = makeRandom(seed);
	const monthStart = Date.parse(`${month}-01T00:00:00Z`);
	const [year, monthNumber] = month.split("-").map(Number);
	const monthEnd = Date.UTC(year ?? 1970, monthNumber ?? 1, 1);
	const monthMs = monthEnd - monthStart;
	const holderCdf = cumulative(
		Array.from({ length: holders }, (_, rank) => (rank + 1) ** -ZIPF_EXPONENT),
	);
	const modelCdf = cumulative(USAGE_MODELS.map((m) => m.weight));
	const featureCdf = cumulative(USAGE_FEATURES.map((f) => f.weight));
	const regionCdf = cumulative(USAGE_REGIONS.map((r) => r.weight));
	const gaussian = (): number =>
		Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
	const resends = new Map<number, GeneratedUsage[]>();
	const resendWindow = Math.max(1, Math.floor(events / 30));

	const make = (ingestMs: number, ordinal: number): GeneratedUsage => {
		const late = random() < lateRate;
		const eventMs = late
			? ingestMs - Math.floor((1 + random() * (MAX_LATE_DAYS - 1)) * DAY_MS)
			: ingestMs - Math.floor(random() * MAX_ARRIVAL_JITTER_MS);
		const holder = holderId(pick(holderCdf, random()));
		const model = USAGE_MODELS[pick(modelCdf, random())] ?? USAGE_MODELS[0];
		const feature = USAGE_FEATURES[pick(featureCdf, random())]?.name ?? "chat";
		const region = USAGE_REGIONS[pick(regionCdf, random())]?.name ?? "us-east";
		const inputTokens = Math.max(1, Math.round(Math.exp(6 + 1.2 * gaussian())));
		const outputTokens = model.embedding
			? 0
			: Math.max(1, Math.round(Math.exp(5.2 + gaussian())));
		const cachedTokens = Math.floor(inputTokens * random() * 0.6);
		// Drawn only for version 2, so the stream of the unversioned benchmark data is unchanged.
		const reasoningTokens =
			schemaVersion === 2 && !model.embedding
				? Math.floor(outputTokens * random() * 0.2)
				: 0;
		let requestId = "req_";
		for (let i = 0; i < REQUEST_ID_CHARS; i++)
			requestId += REQUEST_ALPHABET[Math.floor(random() * 32)];
		const idem = `${requestId}${ordinal.toString(BASE36)}`;
		const id = deterministicUlid({
			timeMs: eventMs,
			revision: 0,
			seed: canonicalize([school, idem]),
		});
		return {
			line: lineOf({
				school,
				id,
				idem,
				holder,
				eventMs,
				ingestMs,
				model: model.model,
				feature,
				region,
				inputTokens,
				outputTokens,
				cachedTokens,
				reasoningTokens,
			}),
			id,
			idem,
			holder,
			model: model.model,
			eventMs,
			ingestMs,
			eventDate: isoDate(eventMs),
			ingestDate: isoDate(ingestMs),
			late,
			duplicate: false,
			inputTokens,
			outputTokens,
		};
	};

	const lineOf = (fields: {
		school: string;
		id: string;
		idem: string;
		holder: string;
		eventMs: number;
		ingestMs: number;
		model: string;
		feature: string;
		region: string;
		inputTokens: number;
		outputTokens: number;
		cachedTokens: number;
		reasoningTokens: number;
	}): string => {
		const eventTime = new Date(fields.eventMs).toISOString();
		// Keys in sorted order, exactly what canonicalize() prints for the envelope.
		return `{"date":"${eventTime.slice(0, 10)}","event_time":"${eventTime}","event_type":"${USAGE_EVENT_TYPE}","id":"${fields.id}","idem":"${fields.idem}","ingest_time":"${new Date(fields.ingestMs).toISOString()}","key":"${fields.holder}","labels":{"feature":"${fields.feature}","model":"${fields.model}","region":"${fields.region}"},"payload":{"cached_input_tokens":${fields.cachedTokens},"input_tokens":${fields.inputTokens},"output_tokens":${fields.outputTokens}${schemaVersion === 2 ? `,"reasoning_tokens":${fields.reasoningTokens}` : ""}${schemaVersion === undefined ? "" : `,"schema_version":${schemaVersion}`}},"postings":[],"school":"${fields.school}","source":"usage","text":"usage recorded","tz":"UTC","v":1}`;
	};

	const arrivalMs = (ordinal: number): number =>
		monthStart +
		Math.floor((ordinal * monthMs) / events) +
		Math.floor(random() * Math.max(1, monthMs / events));

	for (let ordinal = 0; ordinal < events; ordinal++) {
		const due = resends.get(ordinal);
		if (due) {
			resends.delete(ordinal);
			yield* due;
		}
		const event = make(arrivalMs(ordinal), ordinal);
		yield event;
		if (random() >= duplicateRate) continue;
		const release = ordinal + 1 + Math.floor(random() * resendWindow);
		const resentMs = arrivalMs(release);
		const resentIso = new Date(resentMs).toISOString();
		const resent: GeneratedUsage = {
			...event,
			duplicate: true,
			ingestMs: resentMs,
			ingestDate: resentIso.slice(0, 10),
			line: event.line.replace(
				/"ingest_time":"[^"]+"/,
				`"ingest_time":"${resentIso}"`,
			),
		};
		resends.set(release, [...(resends.get(release) ?? []), resent]);
	}
	for (const [, due] of [...resends].sort(([a], [b]) => a - b)) yield* due;
}
