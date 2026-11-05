import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { generateYear } from "../fixtures/vibes.js";
import { writeFixture } from "../fixtures/write.js";
import { readTree, tmp } from "./helpers.js";

const GOLDEN = join(import.meta.dir, "../fixtures/vibes-year");

describe("fixture generator", () => {
	test("the same seed gives byte-identical files", async () => {
		const a = await tmp("fx-a");
		const b = await tmp("fx-b");
		await writeFixture({ seed: 7, outDir: a });
		await writeFixture({ seed: 7, outDir: b });
		const ta = await readTree(a);
		const tb = await readTree(b);
		expect(Object.keys(ta).length).toBeGreaterThan(10);
		expect(tb).toEqual(ta);
	});

	test("the same seed gives the same bytes in another process time zone", async () => {
		const here = await tmp("fx-here");
		const there = await tmp("fx-there");
		await writeFixture({ seed: 3, outDir: here });
		const run = Bun.spawnSync(
			[
				"bun",
				join(import.meta.dir, "../fixtures/generate.ts"),
				"--seed",
				"3",
				"--out",
				there,
			],
			{
				env: { ...process.env, TZ: "America/Denver" },
			},
		);
		expect(run.exitCode).toBe(0);
		expect(await readTree(there)).toEqual(await readTree(here));
	});

	test("a different seed gives a different year", () => {
		const a = generateYear({ seed: 1 })
			.events.map((e) => e.id)
			.join();
		const b = generateYear({ seed: 2 })
			.events.map((e) => e.id)
			.join();
		expect(a).not.toBe(b);
	});

	test("the committed fixture is what seed 1 generates", async () => {
		const out = await tmp("fx-golden");
		await writeFixture({ seed: 1, outDir: out });
		expect(await readTree(out)).toEqual(await readTree(GOLDEN));
	});

	test("files sit at schools/<id>/events/date=YYYY-MM-DD/<first>-<last>.jsonl, lines in id order", async () => {
		const tree = await readTree(GOLDEN);
		const keys = Object.keys(tree).filter((k) => k.startsWith("schools/"));
		expect(keys.length).toBeGreaterThan(30);
		for (const key of keys) {
			const m =
				/^schools\/sch_vol\/events\/date=(\d{4}-\d{2}-\d{2})\/([0-7][0-9A-Z]{25})-([0-7][0-9A-Z]{25})\.jsonl$/.exec(
					key,
				);
			expect(m).not.toBeNull();
			const events = (tree[key] as string)
				.trimEnd()
				.split("\n")
				.map((l) => JSON.parse(l));
			expect(events[0].id).toBe(m?.[2]);
			expect(events[events.length - 1].id).toBe(m?.[3]);
			expect(events.map((e) => e.id)).toEqual(events.map((e) => e.id).sort());
			for (const e of events) expect(e.date).toBe(m?.[1] as string);
		}
	});

	test("the year holds every story the brief names, and expected balances", () => {
		const { events, expected } = generateYear({ seed: 1 });
		const types = new Set(events.map((e) => e.event_type));
		for (const t of [
			"payment.succeeded",
			"payment.refunded",
			"payout.paid",
			"plan.attached",
			"plan.changed",
			"credit.granted",
			"credit.held",
			"credit.spent",
			"credit.released",
			"credit.forfeited",
			"credit.expired",
			"credit.refunded",
			"credit.adjusted",
		]) {
			expect(types.has(t as never)).toBe(true);
		}
		// a gift, and a rollover carried at a reset
		expect(
			events.some(
				(e) => e.event_type === "credit.granted" && e.labels.plan === "gift",
			),
		).toBe(true);
		expect(events.some((e) => e.labels.rolled_over !== undefined)).toBe(true);
		// the downgrade moves no credits
		const change = events.find((e) => e.event_type === "plan.changed");
		expect(change?.postings).toEqual([]);
		expect(expected.balances).toEqual([
			{ holder: expected.holder, feature: "visit", avail: 0, held: 1 },
		]);
		expect(expected.eventCount).toBe(events.length);
	});
});
