/**
 * The generator's events must survive atm's real write path: `appendToOutbox` keeps one row per `(school, env, idem)`, so two
 * events that share an idem (two subjects' commands with the same command id) lose all but one on the way to the log, and
 * nothing in memory notices. Every preset's events go in, ship to a folder and are read back: all of them, the same ones.
 */
import { describe, expect, test } from "bun:test";
import { buildFixture } from "../src/scenario/fixture.js";
import { PROFILE_NAMES } from "../src/scenario/profiles.js";
import { RoundTripError, roundTripEvents } from "../src/scenario/roundtrip.js";
import type { AtmEvent } from "../src/types.js";

describe("generated events through the outbox, the shipper and the reader", () => {
	for (const profile of PROFILE_NAMES)
		test(`${profile}: events in equal events read back`, async () => {
			const { events } = buildFixture({ profile });
			expect(new Set(events.map((e) => e.idem)).size, "distinct idems").toBe(
				events.length,
			);
			const back = await roundTripEvents(events);
			expect(back.length).toBe(events.length);
			const byId = (list: readonly AtmEvent[]) =>
				[...list].sort((a, b) => (a.id < b.id ? -1 : 1)).map((e) => e.id);
			expect(byId(back)).toEqual(byId(events));
		});

	test("events that share an idem are reported, not dropped without a word", async () => {
		const { events } = buildFixture({ profile: "tiny-school" });
		const [first] = events as [AtmEvent];
		const twin: AtmEvent = { ...first, id: `${first.id.slice(0, -1)}0` };
		await expect(
			roundTripEvents([first, { ...twin, idem: first.idem }]),
		).rejects.toThrow(RoundTripError);
	});
});
