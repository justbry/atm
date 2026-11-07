/**
 * Month seals (`src/ledger/seal.ts`): each closed month's events signed at `sealed_at` and chained to the seal before it,
 * on the golden year (`fixtures/vibes-year`). A seal names its events by id: an edit or deletion breaks it; an event it
 * does not name (a late delivery, an outbox row shipped after it, or an insertion) is listed as late, not as tampering.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import { buildJournal } from "../src/ledger/journal.js";
import { sealOf, signSeal, verifySeals } from "../src/ledger/seal.js";
import { canonicalize, sha256Hex } from "../src/ledger/util.js";
import type { AtmEvent, AtmSignedSeal } from "../src/types.js";
import { otherSigner, testKeys, testSigner } from "./signing-keys.js";

const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const SCHOOL = "sch_vol";
const OCTOBER_SEALED_AT = "2026-11-07T00:00:00Z";
const NOVEMBER_SEALED_AT = "2026-12-07T00:00:00Z";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let events: AtmEvent[] = [];

beforeAll(async () => {
	({ events } = await readEvents(FIXTURE, SCHOOL));
});

const seal = (
	month: string,
	sealedAt: string,
	previous: AtmSignedSeal | null,
	from: readonly AtmEvent[] = events,
): AtmSignedSeal =>
	signSeal(
		sealOf({ school: SCHOOL, month, events: from, sealedAt, previous }),
		testSigner,
	);

/** October, then November chained to it. */
const chain = (): AtmSignedSeal[] => {
	const october = seal("2026-10", OCTOBER_SEALED_AT, null);
	return [october, seal("2026-11", NOVEMBER_SEALED_AT, october)];
};

const verdicts = (
	seals: readonly unknown[],
	from: readonly AtmEvent[] = events,
) => verifySeals(seals, from, testKeys).seals.map((row) => row.verdict);

const october = (from: readonly AtmEvent[]) =>
	from.filter((event) => event.date.startsWith("2026-10-"));

/** Another October event, after the fixture's: a copy of its first with a new id and idem. */
const extraOctober = (idem: string, ingestTime: string): AtmEvent => ({
	...clone(october(events)[0] as AtmEvent),
	id: "01M57W11S000001VXEECV0TTZZ",
	idem,
	ingest_time: ingestTime,
});

describe("sealOf", () => {
	test("counts the month's events and hashes them as buildJournal's inputsHash does", () => {
		const [first, second] = chain() as [AtmSignedSeal, AtmSignedSeal];
		const build = buildJournal({ events, month: "2026-10" });
		expect(first.seal).toEqual({
			v: 1,
			school: SCHOOL,
			month: "2026-10",
			events: october(events).length,
			event_ids: october(events)
				.map((event) => event.id)
				.sort(),
			transactions: build.transactions,
			events_hash: build.inputsHash,
			sealed_at: OCTOBER_SEALED_AT,
			prev_seal_hash: null,
		});
		expect(second.seal.prev_seal_hash).toBe(sha256Hex(canonicalize(first)));
		expect(verifySeals(chain(), events, testKeys)).toEqual({
			ok: true,
			seals: [
				{ month: "2026-10", sealed_at: OCTOBER_SEALED_AT, verdict: "ok" },
				{ month: "2026-11", sealed_at: NOVEMBER_SEALED_AT, verdict: "ok" },
			],
			unsealedLate: [],
		});
	});

	test("is deterministic given the same events, sealedAt and previous seal", () => {
		expect(canonicalize(chain())).toBe(canonicalize(chain()));
		expect(
			canonicalize(
				seal("2026-10", OCTOBER_SEALED_AT, null, clone(events).reverse()),
			),
		).toBe(canonicalize(chain()[0]));
	});

	test("covers every month event, whatever its ingest_time; throws on a bad month, instant, school or a repeated id", () => {
		const stampedLater = extraOctober("stamped-later", "2027-01-01T00:00:00Z");
		const covered = seal("2026-10", OCTOBER_SEALED_AT, null, [
			...events,
			stampedLater,
		]);
		expect(covered.seal.event_ids).toContain(stampedLater.id);
		expect(() => seal("2026-13", OCTOBER_SEALED_AT, null)).toThrow("YYYY-MM");
		expect(() => seal("2026-10", "yesterday", null)).toThrow("ISO instant");
		const sameId = {
			...extraOctober("same-id", "2026-10-20T00:00:00Z"),
			id: (october(events)[0] as AtmEvent).id,
		};
		expect(() =>
			seal("2026-10", OCTOBER_SEALED_AT, null, [...events, sameId]),
		).toThrow("share the id");
		expect(() =>
			sealOf({
				school: "sch_other",
				month: "2026-11",
				events,
				sealedAt: NOVEMBER_SEALED_AT,
				previous: chain()[0] as AtmSignedSeal,
			}),
		).toThrow("sch_vol");
	});
});

describe("verifySeals", () => {
	test("changing or deleting an event in a sealed month is events_changed", () => {
		const target = october(events)[0] as AtmEvent;
		const changed = events.map((event) =>
			event.id === target.id
				? { ...clone(event), text: `${event.text} (edited)` }
				: event,
		);
		const deleted = events.filter((event) => event.id !== target.id);
		for (const edited of [changed, deleted])
			expect(verdicts(chain(), edited)).toEqual(["events_changed", "ok"]);
		expect(verifySeals(chain(), deleted, testKeys).ok).toBe(false);
	});

	test("removing or reordering a seal is broken_link", () => {
		const [first, second] = chain() as [AtmSignedSeal, AtmSignedSeal];
		expect(verdicts([second])).toEqual(["broken_link"]);
		expect(verdicts([second, first])).toEqual(["broken_link", "broken_link"]);
		const third = seal("2026-12", "2027-01-07T00:00:00Z", second);
		expect(verdicts([first, third])).toEqual(["ok", "broken_link"]);
	});

	test("an event after the month's seal is unsealed late, and sealing the month again covers it", () => {
		const first = seal("2026-10", OCTOBER_SEALED_AT, null);
		const late = extraOctober("late", "2026-11-09T00:00:00Z");
		const withLate = [...events, late];
		expect(verifySeals([first], withLate, testKeys)).toEqual({
			ok: true,
			seals: [
				{ month: "2026-10", sealed_at: OCTOBER_SEALED_AT, verdict: "ok" },
			],
			unsealedLate: [
				{ month: "2026-10", event_id: late.id, ingest_time: late.ingest_time },
			],
		});
		const again = seal("2026-10", "2026-11-10T00:00:00Z", first, withLate);
		expect(again.seal.events).toBe(first.seal.events + 1);
		expect(verifySeals([first, again], withLate, testKeys)).toMatchObject({
			ok: true,
			unsealedLate: [],
		});
		expect(verdicts([first, again], withLate)).toEqual(["ok", "ok"]);
	});

	test("an event stamped before the seal but shipped after it is late, not tampering", () => {
		const shippedLate = extraOctober("shipped-late", "2026-10-20T00:00:00Z");
		const report = verifySeals(
			[seal("2026-10", OCTOBER_SEALED_AT, null)],
			[...events, shippedLate],
			testKeys,
		);
		expect(report.seals.map((row) => row.verdict)).toEqual(["ok"]);
		expect(report.unsealedLate.map((late) => late.event_id)).toEqual([
			shippedLate.id,
		]);
	});

	test("a seal whose ids are unsorted, repeated or not as many as its events is malformed", () => {
		const { seal: first } = chain()[0] as AtmSignedSeal;
		const ids = first.event_ids;
		for (const change of [
			{ event_ids: [...ids].reverse() },
			{ event_ids: ids.slice(1) },
			{ event_ids: [ids[0] as string, ...ids.slice(0, -1)] },
		])
			expect(verdicts([signSeal({ ...first, ...change }, testSigner)])).toEqual(
				["malformed"],
			);
	});

	test("a bad signature, an unknown key or a malformed line fails that seal", () => {
		const [first, second] = chain() as [AtmSignedSeal, AtmSignedSeal];
		const tampered = clone(first);
		tampered.seal.transactions += 1;
		expect(verdicts([tampered])).toEqual(["bad_signature"]);
		const byOther = signSeal(first.seal, otherSigner);
		expect(verdicts([byOther])).toEqual(["unknown_key"]);
		expect(verdicts(["not json", { seal: first.seal }, null])).toEqual([
			"malformed",
			"malformed",
			"malformed",
		]);
		const report = verifySeals(
			[first, { ...second, extra: 1 }],
			events,
			testKeys,
		);
		expect(report.ok).toBe(false);
		expect(report.seals[1]).toEqual({
			month: "2026-11",
			sealed_at: NOVEMBER_SEALED_AT,
			verdict: "malformed",
		});
	});
});
