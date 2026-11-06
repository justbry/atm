/**
 * Sealed months (`src/ledger/seal.ts`): a signature over a month's events, chained per school, that late events do not break.
 * Keys are made at test time.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import { buildJournal } from "../src/ledger/journal.js";
import { sealOf, signSeal, verifySeals } from "../src/ledger/seal.js";
import { generateSigningKey } from "../src/ledger/sign.js";
import type { AtmEvent, AtmSignedSeal, AtmSigner } from "../src/types.js";

const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const SCHOOL = "sch_vol";
const KEY_ID = "test-key-1";
/** After every fixture event was written. */
const SEALED_AT = "2027-01-08T00:00:00Z";
const LATER = "2027-02-01T00:00:00Z";

let events: AtmEvent[] = [];
let signer: AtmSigner;
let keys: Record<string, string>;

const seal = (
	month: string,
	previous: AtmSignedSeal | null,
	from: readonly AtmEvent[] = events,
	sealedAt = SEALED_AT,
): AtmSignedSeal =>
	signSeal(
		sealOf({ school: SCHOOL, month, events: from, sealedAt, previous }),
		signer,
	);

/** October then November, chained. */
const chain = (from: readonly AtmEvent[] = events): AtmSignedSeal[] => {
	const october = seal("2026-10", null, from);
	return [october, seal("2026-11", october, from)];
};

/** Another id in the same instant as `id`: its last character changed. */
const siblingId = (id: string): string =>
	`${id.slice(0, -1)}${id.endsWith("Z") ? "Y" : "Z"}`;

const octoberEvent = (): AtmEvent => {
	const event = events.find((e) => e.date.startsWith("2026-10-"));
	if (!event) throw new Error("the fixture has no October event");
	return event;
};

beforeAll(async () => {
	({ events } = await readEvents(FIXTURE, SCHOOL));
	const pair = generateSigningKey();
	signer = { keyId: KEY_ID, privateKeyPem: pair.privateKeyPem };
	keys = { [KEY_ID]: pair.publicKeyPem };
});

describe("sealOf", () => {
	test("counts the month's events with the journal's formula", () => {
		const { seal: october } = seal("2026-10", null);
		const build = buildJournal({ events, month: "2026-10" });
		expect(october.events_hash).toBe(build.inputsHash);
		expect(october.transactions).toBe(build.transactions);
		expect(october.events).toBe(
			events.filter((e) => e.date.startsWith("2026-10-")).length,
		);
		expect(october.prev_seal_hash).toBeNull();
	});

	test("is deterministic", () => {
		expect(JSON.stringify(seal("2026-10", null))).toBe(
			JSON.stringify(seal("2026-10", null)),
		);
	});

	test("refuses to seal before a month event was written, and a bad month or time", () => {
		const written = octoberEvent().ingest_time;
		const before = new Date(Date.parse(written) - 1000).toISOString();
		expect(() => seal("2026-10", null, events, before)).toThrow(
			"after sealedAt",
		);
		expect(() => seal("2026-13x", null)).toThrow("YYYY-MM");
		expect(() => seal("2026-10", null, events, "yesterday")).toThrow(
			"UTC ISO instant",
		);
	});
});

describe("verifySeals", () => {
	test("an untouched chain verifies", () => {
		const report = verifySeals(chain(), events, keys);
		expect(report.ok).toBe(true);
		expect(report.seals.map((s) => s.verdict)).toEqual(["ok", "ok"]);
		expect(report.unsealedLate).toEqual([]);
	});

	test("an edit, a deletion or a backdated insertion in a sealed month is events_changed", () => {
		const signed = chain();
		const target = octoberEvent();
		const others = events.filter((e) => e.id !== target.id);
		const editedEvent = {
			...target,
			payload: { ...target.payload, tampered: true },
		};
		const backdated = {
			...target,
			id: siblingId(target.id),
			idem: "forged",
		};
		for (const books of [
			[...others, editedEvent],
			others,
			[...events, backdated],
		]) {
			const report = verifySeals(signed, books, keys);
			expect(report.ok).toBe(false);
			expect(report.seals[0]?.verdict).toBe("events_changed");
			expect(report.seals[1]?.verdict).toBe("ok");
		}
	});

	test("a removed, reordered or forged seal breaks the chain", () => {
		const [october, november] = chain();
		expect(verifySeals([november], events, keys).seals[0]?.verdict).toBe(
			"broken_link",
		);
		expect(
			verifySeals([november, october], events, keys).seals.map(
				(s) => s.verdict,
			),
		).toEqual(["broken_link", "broken_link"]);
		const forged = {
			...november,
			seal: { ...november?.seal, events: 0 },
		};
		expect(verifySeals([october, forged], events, keys).seals[1]?.verdict).toBe(
			"bad_signature",
		);
	});

	test("a late event keeps the old seal valid, is listed, and a second seal covers it", () => {
		const first = seal("2026-10", null);
		const late: AtmEvent = {
			...octoberEvent(),
			id: siblingId(octoberEvent().id),
			idem: "late-delivery",
			ingest_time: "2027-01-20T00:00:00Z",
		};
		const books = [...events, late];
		const report = verifySeals([first], books, keys);
		expect(report.ok).toBe(true);
		expect(report.unsealedLate).toEqual([
			{ month: "2026-10", event_id: late.id, ingest_time: late.ingest_time },
		]);
		const second = seal("2026-10", first, books, LATER);
		const after = verifySeals([first, second], books, keys);
		expect(after.seals.map((s) => s.verdict)).toEqual(["ok", "ok"]);
		expect(after.unsealedLate).toEqual([]);
		expect(second.seal.events).toBe(first.seal.events + 1);
	});

	test("an unknown key or a malformed line is reported, never thrown", () => {
		const [october] = chain();
		const report = verifySeals(
			[{ ...october, key_id: "nope" }, "not json", { seal: {} }],
			events,
			keys,
		);
		expect(report.seals.map((s) => s.verdict)).toEqual([
			"unknown_key",
			"malformed",
			"malformed",
		]);
		expect(report.ok).toBe(false);
	});
});
