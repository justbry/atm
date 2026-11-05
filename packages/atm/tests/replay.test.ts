import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateYear } from "../fixtures/vibes.js";
import { ReplayError, replayEvents } from "../src/ledger/replay.js";
import type { AtmEvent } from "../src/types.js";

const GOLDEN = join(import.meta.dir, "../fixtures/vibes-year");
const fixture = generateYear({ seed: 1 });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const replayWith = (events: AtmEvent[]) =>
	replayEvents({ events, catalog: fixture.catalog });

describe("replay", () => {
	test("the year replays to the generator's final balances (committed expected.json)", () => {
		const expected = JSON.parse(
			readFileSync(join(GOLDEN, "expected.json"), "utf8"),
		);
		const r = replayWith(fixture.events);
		expect(r.balances).toEqual(expected.balances);
		expect(r.applied).toBe(expected.eventCount);
		expect(r.lastEventId).toBe(expected.lastEventId);
		expect(r.asOf).toBe(expected.asOf);
	});

	test("replayed balances equal the sum of the year's postings", () => {
		const r = replayWith(fixture.events);
		const totals = fixture.expected.postingTotals;
		const [b] = r.balances;
		expect(Number(totals[`credits:avail:${b?.holder}:visit VISIT`])).toBe(
			b?.avail as number,
		);
		expect(Number(totals[`credits:held:${b?.holder}:visit VISIT`])).toBe(
			b?.held as number,
		);
	});

	test("events given out of order replay in id order", () => {
		const shuffled = [...fixture.events].reverse();
		expect(replayWith(shuffled).balances).toEqual(fixture.expected.balances);
	});

	test("stops at lastEventId; resuming from the snapshot reaches the same end", () => {
		const mid = fixture.events[
			Math.floor(fixture.events.length / 2)
		] as AtmEvent;
		const part = replayEvents({
			events: fixture.events,
			catalog: fixture.catalog,
			lastEventId: mid.id,
		});
		expect(part.lastEventId).toBe(mid.id);
		expect(part.applied).toBeLessThan(fixture.events.length);
		const rest = replayEvents({
			events: fixture.events,
			catalog: fixture.catalog,
			snapshot: part.snapshot,
		});
		expect(rest.balances).toEqual(fixture.expected.balances);
		expect(rest.applied + part.applied).toBe(fixture.events.length);
	});

	test("the engine's decisions are the recorded ones: a changed command is caught", () => {
		const events = clone(fixture.events);
		const hold = events.find((e) => e.event_type === "credit.held") as AtmEvent;
		(hold.payload.command as { value: number }).value = 2;
		expect(() => replayWith(events)).toThrow(ReplayError);
	});

	test("a changed posting is caught", () => {
		const events = clone(fixture.events);
		const spent = events.find(
			(e) => e.event_type === "credit.spent",
		) as AtmEvent;
		spent.postings = spent.postings.map((p) => ({
			...p,
			account: p.account.replace("credits:spent:", "credits:forfeited:"),
		}));
		expect(() => replayWith(events)).toThrow(/differs/);
	});

	test("a changed event time is caught (the engine runs at the event's own time)", () => {
		const events = clone(fixture.events);
		const reset = events.find(
			(e) => e.event_type === "credit.granted" && e.source === "cron",
		) as AtmEvent;
		// an hour early: the cycle is not due yet, so the engine decides nothing
		const t = Date.parse(reset.event_time) - 3_600_000 * 24 * 40;
		reset.event_time = new Date(t).toISOString().replace(".000", "");
		expect(() => replayWith(events)).toThrow(ReplayError);
	});

	test("a dropped event breaks the replay: the next command meets a state it did not expect", () => {
		const events = clone(fixture.events);
		const i = events.findIndex((e) => e.event_type === "credit.released");
		events.splice(i, 1);
		// the release is gone, so the later events no longer line up with the recorded revisions
		expect(() => replayWith(events)).toThrow();
	});

	test("a lapsed row that does not match the state is caught", () => {
		const events = clone(fixture.events);
		const lapse = events.find((e) => e.payload.lapsed) as AtmEvent;
		const first = (lapse.payload.lapsed as { balance: number }[])[0];
		if (first) first.balance = 5;
		expect(() => replayWith(events)).toThrow(/lapsed/);
	});
});
