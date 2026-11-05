/** The scenario presets: they run, they are deterministic, the demo menu is valid, and a bad input says how to fix it. */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { publishProblems, validateMenu } from "../src/billing/menu.js";
import { buildFixture } from "../src/scenario/fixture.js";
import { parseSets, ScenarioInputError } from "../src/scenario/params.js";
import { PROFILE_NAMES, resolveScenario } from "../src/scenario/profiles.js";
import { BEFORE_UNIVERSITY_MENU } from "../src/scenario/school.js";

/** buzz-school's `Menu` rules (docs/features/school-billing.md and packages/family-service/src/school-billing/menu.ts), restated: that package is not a dependency. */
const buzzSchoolMenuProblems = (m: typeof BEFORE_UNIVERSITY_MENU): string[] => {
	const bad: string[] = [];
	const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
	const dup = (ids: string[]) => new Set(ids).size !== ids.length;
	const between = (n: number, lo: number, hi: number) =>
		Number.isInteger(n) && n >= lo && n <= hi;
	if (!/^[a-z]{3}$/.test(m.currency)) bad.push("currency");
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: m.timeZone });
	} catch {
		bad.push("timeZone");
	}
	if (m.features.length > 12) bad.push("features>12");
	if (m.tiers.length > 4) bad.push("tiers>4");
	if (m.addons.length > 6) bad.push("addons>6");
	if (
		dup(m.features.map((f) => f.id)) ||
		dup(m.tiers.map((t) => t.id)) ||
		dup(m.addons.map((a) => a.id))
	)
		bad.push("duplicate id");
	const featureIds = new Set(m.features.map((f) => f.id));
	for (const f of m.features)
		if (
			!ID.test(f.id) ||
			f.name.length > 60 ||
			f.unit.one.length > 30 ||
			f.unit.other.length > 30
		)
			bad.push(`feature ${f.id}`);
	const grantProblems = (
		where: string,
		grants: (typeof m.tiers)[number]["grants"],
	) => {
		if (grants.length > 12 || dup(grants.map((g) => g.featureId)))
			bad.push(`${where} grants`);
		for (const g of grants) {
			if (!featureIds.has(g.featureId) || !between(g.amount, 1, 100_000))
				bad.push(`${where} grant ${g.featureId}`);
			if (
				g.rollover &&
				(!between(g.rollover.months, 1, 24) ||
					(g.rollover.max !== undefined &&
						!between(g.rollover.max, 1, 1_000_000)))
			)
				bad.push(`${where} rollover ${g.featureId}`);
		}
	};
	for (const t of m.tiers) {
		if (!ID.test(t.id) || t.name.length > 60 || t.blurb.length > 300)
			bad.push(`tier ${t.id}`);
		if (
			t.prices.length < 1 ||
			t.prices.length > 2 ||
			dup(t.prices.map((p) => p.interval))
		)
			bad.push(`tier ${t.id} prices`);
		for (const p of t.prices)
			if (!between(p.amount, 50, 10_000_000)) bad.push(`tier ${t.id} price`);
		if (
			t.quantities &&
			(t.quantities.length < 1 ||
				t.quantities.length > 6 ||
				dup(t.quantities.map(String)) ||
				t.quantities.some((q) => !between(q, 1, 50)))
		)
			bad.push(`tier ${t.id} quantities`);
		grantProblems(`tier ${t.id}`, t.grants);
	}
	for (const a of m.addons) {
		if (
			!ID.test(a.id) ||
			a.name.length > 60 ||
			!between(a.price.amount, 50, 10_000_000)
		)
			bad.push(`addon ${a.id}`);
		grantProblems(`addon ${a.id}`, a.grants);
	}
	return bad;
};

describe("Before University", () => {
	test("its menu passes atm's validation and buzz-school's Menu rules", () => {
		expect(validateMenu(BEFORE_UNIVERSITY_MENU).ok).toBe(true);
		expect(publishProblems(BEFORE_UNIVERSITY_MENU)).toEqual([]);
		expect(buzzSchoolMenuProblems(BEFORE_UNIVERSITY_MENU)).toEqual([]);
	});

	test("it covers the menu's features: a quantity tier, rollover, monthly and yearly prices, once and recurring add-ons", () => {
		const m = BEFORE_UNIVERSITY_MENU;
		expect(m.tiers.some((t) => t.quantities)).toBe(true);
		expect(m.tiers.some((t) => t.grants.some((g) => g.rollover))).toBe(true);
		expect(
			m.tiers.some((t) => t.prices.some((p) => p.interval === "year")),
		).toBe(true);
		expect(
			m.tiers.some((t) => t.prices.every((p) => p.interval === "month")),
		).toBe(true);
		for (const every of ["once", "month", "year"])
			expect(m.addons.some((a) => a.price.every === every)).toBe(true);
	});

	test("it uses only the shape buzz-school's menu has (no gift, codes or bookable billing)", () => {
		const json = JSON.stringify(BEFORE_UNIVERSITY_MENU);
		for (const field of ['"gift"', '"codes"', '"billing"', '"bookable"'])
			expect(json).not.toContain(field);
	});
});

describe("the presets", () => {
	for (const name of PROFILE_NAMES) {
		test(`${name} runs, and its fixture hash is the same on three runs`, () => {
			const runs = [1, 2, 3].map(() => buildFixture({ profile: name }));
			expect(runs[0]?.events.length).toBeGreaterThan(50);
			expect(new Set(runs.map((r) => r.hash)).size).toBe(1);
			expect(runs[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
		});
	}

	test("the hash does not depend on the process's time zone", () => {
		const here = buildFixture({ profile: "disputes" }).hash;
		for (const tz of ["Asia/Kolkata", "Pacific/Auckland"]) {
			const run = Bun.spawnSync(
				[
					process.execPath,
					"-e",
					`import { buildFixture } from ${JSON.stringify(join(import.meta.dir, "../src/scenario/fixture.ts"))}; process.stdout.write(buildFixture({ profile: "disputes" }).hash)`,
				],
				{ env: { ...process.env, TZ: tz }, stdout: "pipe", stderr: "pipe" },
			);
			expect(run.stdout.toString()).toBe(here);
		}
	});

	test("the seed and the knobs move the hash; the same ones do not", () => {
		const base = buildFixture({ profile: "heavy-refunds" }).hash;
		expect(buildFixture({ profile: "heavy-refunds", seed: 7 }).hash).not.toBe(
			base,
		);
		expect(buildFixture({ profile: "heavy-refunds", seed: 7 }).hash).toBe(
			buildFixture({ profile: "heavy-refunds", seed: 7 }).hash,
		);
		expect(
			buildFixture({ profile: "heavy-refunds", params: { refundRate: 0.25 } })
				.hash,
		).not.toBe(base);
		expect(
			buildFixture({ profile: "heavy-refunds", params: { refundRate: 0.2 } })
				.hash,
		).toBe(base);
	});

	test("the presets differ in what they exercise", () => {
		const count = (name: string, type: string) =>
			buildFixture({ profile: name }).events.filter(
				(e) => e.event_type === type,
			).length;
		expect(count("free-only", "payment.succeeded")).toBe(0);
		expect(count("free-only", "credit.granted")).toBeGreaterThan(0);
		expect(count("heavy-refunds", "payment.refunded")).toBeGreaterThan(
			count("monthly-members", "payment.refunded"),
		);
		expect(count("disputes", "payment.disputed")).toBeGreaterThan(5);
		expect(count("non-usd", "money.skipped")).toBeGreaterThan(50);
		expect(count("non-usd", "payment.succeeded")).toBe(0);
	});
});

describe("a bad input says how to fix it", () => {
	const problems = (input: unknown): string => {
		try {
			resolveScenario(input);
		} catch (error) {
			expect(error).toBeInstanceOf(ScenarioInputError);
			return (error as ScenarioInputError).problems.join("\n");
		}
		throw new Error("accepted");
	};

	test("an unknown knob suggests the nearest one and lists the rest", () => {
		const text = problems({ profile: "disputes", params: { refundrate: 0.1 } });
		expect(text).toContain('unknown knob "refundrate"');
		expect(text).toContain('Did you mean "refundRate"?');
	});

	test("a knob at the top level is told to go under params", () => {
		expect(problems({ refundRate: 0.1 })).toContain('put it under "params"');
	});

	test("a percentage where a share is wanted is explained", () => {
		const text = problems({ profile: "disputes", params: { refundRate: 20 } });
		expect(text).toContain("refundRate=20");
		expect(text).toContain("a number from 0 to 1");
		expect(text).toContain("0.2");
	});

	test("an unknown preset and tier name suggest the nearest", () => {
		expect(problems({ profile: "heavy-refund" })).toContain(
			'Did you mean "heavy-refunds"?',
		);
		expect(
			problems({ profile: "disputes", params: { tierMix: { schollar: 1 } } }),
		).toContain('did you mean "scholar"?');
	});

	test("every problem is reported at once", () => {
		const text = problems({
			profile: "nope",
			seed: -1,
			params: { months: 99, currency: "usdd" },
		});
		expect(text.split("\n").length).toBeGreaterThanOrEqual(4);
	});

	test("--set parsing: numbers, JSON, dotted keys, and a missing =", () => {
		expect(
			parseSets(["refundRate=0.2", "currency=eur", "tierMix.audit=5"]),
		).toEqual({ refundRate: 0.2, currency: "eur", tierMix: { audit: 5 } });
		expect(() => parseSets(["refundRate"])).toThrow("key=value");
	});
});
