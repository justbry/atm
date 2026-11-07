/**
 * The Worker read slice over every scenario preset: each preset's generated log (the one its golden's `fixtureHash`
 * names) replays through `buildViews` and `membersOf` at its last event, and the views round-trip through a store.
 * Ten presets cancel a membership at a period's end, which sets a grant's expiry to that instant; the cron books the
 * lapse later, at the same `event_time` as the cancellation, and replay must check it after that command.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { deterministicUlid } from "../src/ledger/ids.js";
import { replayOrder } from "../src/ledger/replay.js";
import { membersOf } from "../src/ledger/summary.js";
import {
	buildViews,
	manifestKey,
	readViewsFromStore,
	writeViews,
} from "../src/ledger/views.js";
import { fixtureHash } from "../src/scenario/fixture.js";
import { generateScenario } from "../src/scenario/generate.js";
import { PROFILES, resolveScenario } from "../src/scenario/profiles.js";
import { FolderStore } from "../src/store/folder-store.js";
import { sha256Hex } from "../src/store/store.js";
import type { AtmEvent } from "../src/types.js";

const GOLDEN = join(import.meta.dir, "golden/scenarios");
const PRESET_COUNT = 21;

const presetLog = (profile: string) => {
	const scenario = resolveScenario({ profile });
	const { events, menu } = generateScenario(scenario);
	const golden = JSON.parse(
		readFileSync(join(GOLDEN, `${profile}.json`), "utf8"),
	) as { fixtureHash: string };
	expect(fixtureHash(scenario, events)).toBe(golden.fixtureHash);
	const school = (events[0] as AtmEvent).school;
	const asOf = new Date(
		events
			.map((event) => event.event_time)
			.sort()
			.at(-1) as string,
	);
	return {
		events,
		school,
		asOf,
		catalog: menuCatalogRows({ menu, school }),
	};
};

describe("the read slice replays every scenario preset", () => {
	test("there are twenty-one presets", () => {
		expect(PROFILES.length).toBe(PRESET_COUNT);
	});

	for (const { name } of PROFILES) {
		test(name, async () => {
			const { events, school, asOf, catalog } = presetLog(name);
			const members = membersOf(events, asOf, { catalog });
			if (!members.ok) throw new Error(JSON.stringify(members.error));
			const built = buildViews(events, { school, asOf, catalog });
			if (!built.ok) throw new Error(JSON.stringify(built.error));
			const { views } = built;
			expect(views.members).toEqual(members.members);
			expect(views.generatedFrom.eventCount).toBe(events.length);

			const root = await mkdtemp(join(tmpdir(), "atm-presets-"));
			try {
				const store = new FolderStore({ root });
				const written = await writeViews(store, school, views);
				expect(written.stale).toBe(false);
				const reader = await readViewsFromStore(store, school);
				if (!reader.ok) throw new Error(JSON.stringify(reader));
				expect(reader.manifest.asOf).toBe(views.asOf);
				expect(reader.manifest.generatedFrom).toEqual(views.generatedFrom);
				const keys = Object.keys(reader.manifest.objects).sort();
				expect(keys).toEqual(
					written.created.filter((key) => key !== manifestKey(school)).sort(),
				);
				for (const key of keys)
					expect(sha256Hex((await store.get(key)).body)).toBe(
						reader.manifest.objects[key] as string,
					);
				for (const [month, view] of Object.entries(views.months)) {
					const read = await reader.month(month);
					if (!read.ok) throw new Error(JSON.stringify(read));
					expect(read.value).toEqual({ school, month, ...view });
				}
				for (const [key, summary] of Object.entries(views.members)) {
					const read = await reader.member(key);
					if (!read.ok) throw new Error(JSON.stringify(read));
					expect(read.value).toEqual({ school, ...summary });
				}
				const index = await reader.membersIndex();
				if (!index.ok) throw new Error(JSON.stringify(index));
				expect(index.value.members.map((member) => member.key).sort()).toEqual(
					Object.keys(views.members).sort(),
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}
});

describe("replayOrder: a lapse by the clock at the instant of a command", () => {
	const AT = Date.parse("2027-01-05T16:03:00Z");
	const KEY = "family:fam_x";
	const command = (after: number): AtmEvent =>
		({
			id: deterministicUlid({ timeMs: AT, revision: after, seed: `c${after}` }),
			key: KEY,
			event_type: "plan.changed",
			event_time: new Date(AT).toISOString(),
			payload: { mutation: { revision: { before: after - 1, after } } },
		}) as unknown as AtmEvent;
	const lapse = (revision: number): AtmEvent =>
		({
			id: deterministicUlid({ timeMs: AT, revision, seed: "lapse" }),
			key: KEY,
			source: "cron",
			event_type: "credit.expired",
			event_time: new Date(AT).toISOString(),
			payload: { lapsed: [] },
		}) as unknown as AtmEvent;
	const replayed = (events: AtmEvent[]) =>
		replayOrder(events).map((event) =>
			event.event_type === "credit.expired" ? "lapse" : event.id,
		);

	test("comes after the commands up to the revision it was judged at, before the later ones", () => {
		const twenty = command(20);
		const twentyOne = command(21);
		expect(replayed([twentyOne, lapse(20), twenty])).toEqual([
			twenty.id,
			"lapse",
			twentyOne.id,
		]);
		expect(replayed([twenty, lapse(19), twentyOne])).toEqual([
			"lapse",
			twenty.id,
			twentyOne.id,
		]);
	});
});
