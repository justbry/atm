import { describe, expect, test } from "bun:test";
import vibes from "../fixtures/billing/menu/vibes-menu.json";
import { menuCatalogRows } from "../src/billing/grants.js";
import {
	publicMenu,
	publishProblems,
	validateMenu,
} from "../src/billing/menu.js";
import type { Menu } from "../src/billing/types.js";

const clone = <T>(v: T): T => structuredClone(v);
// biome-ignore lint/suspicious/noExplicitAny: tests poke arbitrary bad values into a clone of the fixture
type Loose = any;
const menu = (): Loose => clone(vibes);
const problems = (m: unknown): string[] => {
	const r = validateMenu(m);
	if (r.ok) throw new Error("expected problems");
	return r.problems;
};

describe("validateMenu", () => {
	test("the fixture menu is valid and comes back equal", () => {
		const r = validateMenu(menu());
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.menu).toEqual(vibes as Menu);
	});

	test("an empty menu is valid (publishing refuses it separately)", () => {
		expect(
			validateMenu({
				currency: "usd",
				timeZone: "UTC",
				features: [],
				tiers: [],
				addons: [],
			}).ok,
		).toBe(true);
	});

	test("not an object, or missing parts", () => {
		expect(problems(null)).toEqual(["menu"]);
		expect(problems("x")).toEqual(["menu"]);
		expect(problems({ currency: "usd" })).toEqual([
			"timeZone",
			"features",
			"tiers",
			"addons",
		]);
	});

	test("unknown properties are refused", () => {
		const m = menu();
		m.tiers[0].extra = 1;
		expect(problems(m)).toEqual(["tiers.0.extra"]);
	});

	test("currency: three lowercase letters", () => {
		for (const c of ["us", "usdd", "", "u1d", 5]) {
			const m = menu();
			m.currency = c;
			expect(problems(m)).toEqual(["currency"]);
		}
	});

	test("an uppercase currency is lowercased in the returned menu", () => {
		const m = menu();
		m.currency = " USD ";
		const r = validateMenu(m);
		expect(r.ok && r.menu.currency).toBe("usd");
	});

	test("time zone: required, at most 64, and a real IANA zone", () => {
		for (const tz of ["", "x".repeat(65)]) {
			const m = menu();
			m.timeZone = tz;
			expect(problems(m)).toEqual(["timeZone"]);
		}
		const m = menu();
		m.timeZone = "Mars/Olympus";
		expect(problems(m)).toEqual(["timeZone"]);
	});

	test("limits: 4 tiers, 6 add-ons, 12 features", () => {
		let m = menu();
		m.tiers = Array.from({ length: 5 }, (_, i) => ({
			...clone(m.tiers[0]),
			id: `t${i}`,
			name: `T${i}`,
		}));
		expect(problems(m)).toEqual(["tiers"]);
		m = menu();
		m.addons = Array.from({ length: 7 }, (_, i) => ({
			...clone(m.addons[0]),
			id: `a${i}`,
		}));
		expect(problems(m)).toEqual(["addons"]);
		m = menu();
		m.features = Array.from({ length: 13 }, (_, i) => ({
			// letters differ (feature-a ... feature-m): ids that differ only by digits would share a commodity
			id: `feature-${"abcdefghijklm"[i]}`,
			name: `F${i}`,
			unit: { one: "a", other: "b" },
		}));
		m.tiers = [];
		m.addons = [];
		expect(problems(m)).toEqual(["features"]);
		m.features.pop();
		expect(validateMenu(m).ok).toBe(true);
		// the boundaries themselves are fine
		m = menu();
		m.tiers = Array.from({ length: 4 }, (_, i) => ({
			...clone(m.tiers[0]),
			id: `t${i}`,
			name: `T${i}`,
		}));
		m.addons = Array.from({ length: 6 }, (_, i) => ({
			...clone(m.addons[0]),
			id: `a${i}`,
		}));
		expect(validateMenu(m).ok).toBe(true);
	});

	test("ids: lowercase letters, digits, - and _, 1 to 40, not starting with - or _", () => {
		for (const id of ["", "Sparkle", "-a", "_a", "a b", "a".repeat(41), "é"]) {
			const m = menu();
			m.tiers[0].id = id;
			expect(problems(m)).toEqual(["tiers.0.id"]);
		}
		const m = menu();
		m.tiers[0].id = "a".repeat(40);
		expect(validateMenu(m).ok).toBe(true);
		m.tiers[0].id = "0_a-b";
		expect(validateMenu(m).ok).toBe(true);
	});

	test("text is trimmed, then must be 1..60 (names), 0..300 (blurb), 1..30 (unit words)", () => {
		const m = menu();
		m.tiers[0].name = "  Sparkle  ";
		m.tiers[0].blurb = "  hi  ";
		m.features[0].unit.one = " massage ";
		const r = validateMenu(m);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.menu.tiers[0]?.name).toBe("Sparkle");
			expect(r.menu.tiers[0]?.blurb).toBe("hi");
			expect(r.menu.features[0]?.unit.one).toBe("massage");
		}
		const blank = menu();
		blank.tiers[0].name = "   ";
		blank.features[0].name = "";
		blank.features[0].unit.other = "x".repeat(31);
		blank.addons[0].name = "n".repeat(61);
		blank.tiers[1].blurb = "b".repeat(301);
		expect(problems(blank).sort()).toEqual(
			[
				"addons.0.name",
				"features.0.name",
				"features.0.unit.other",
				"tiers.0.name",
				"tiers.1.blurb",
			].sort(),
		);
		const ok = menu();
		ok.tiers[0].blurb = "";
		ok.tiers[1].blurb = "b".repeat(300);
		ok.tiers[1].name = "n".repeat(60);
		expect(validateMenu(ok).ok).toBe(true);
	});

	test("amounts: whole cents from 50 to 10,000,000", () => {
		for (const a of [0, 49, 10_000_001, 100.5, "100", -5]) {
			const m = menu();
			m.tiers[0].prices[0].amount = a;
			m.addons[0].price.amount = a;
			expect(problems(m).sort()).toEqual([
				"addons.0.price.amount",
				"tiers.0.prices.0.amount",
			]);
		}
		const m = menu();
		m.tiers[0].prices[0].amount = 50;
		m.addons[0].price.amount = 10_000_000;
		expect(validateMenu(m).ok).toBe(true);
	});

	test("tier prices: 1 or 2, month or year, one per interval", () => {
		let m = menu();
		m.tiers[0].prices = [];
		expect(problems(m)).toEqual(["tiers.0.prices"]);
		m = menu();
		m.tiers[0].prices = [
			{ interval: "month", amount: 100 },
			{ interval: "year", amount: 1000 },
			{ interval: "month", amount: 200 },
		];
		expect(problems(m)).toEqual(["tiers.0.prices"]);
		m = menu();
		m.tiers[0].prices = [
			{ interval: "month", amount: 100 },
			{ interval: "month", amount: 200 },
		];
		expect(problems(m)).toEqual(["tiers.0.prices"]);
		m = menu();
		m.tiers[0].prices[0].interval = "week";
		expect(problems(m)).toEqual(["tiers.0.prices.0.interval"]);
	});

	test("add-on price every: once, month or year", () => {
		const m = menu();
		m.addons[0].price.every = "week";
		expect(problems(m)).toEqual(["addons.0.price.every"]);
	});

	test("grants: amount 1..100000, every month or year, rollover months 1..24 and max 1..1,000,000", () => {
		for (const [path, set, bad] of [
			[
				"tiers.0.grants.0.amount",
				(g: Loose, v: unknown) => {
					g.amount = v;
				},
				0,
			],
			[
				"tiers.0.grants.0.amount",
				(g: Loose, v: unknown) => {
					g.amount = v;
				},
				100_001,
			],
			[
				"tiers.0.grants.0.amount",
				(g: Loose, v: unknown) => {
					g.amount = v;
				},
				1.5,
			],
			[
				"tiers.0.grants.0.every",
				(g: Loose, v: unknown) => {
					g.every = v;
				},
				"once",
			],
			[
				"tiers.0.grants.0.rollover.months",
				(g: Loose, v: unknown) => {
					g.rollover.months = v;
				},
				0,
			],
			[
				"tiers.0.grants.0.rollover.months",
				(g: Loose, v: unknown) => {
					g.rollover.months = v;
				},
				25,
			],
			[
				"tiers.0.grants.0.rollover.max",
				(g: Loose, v: unknown) => {
					g.rollover.max = v;
				},
				0,
			],
			[
				"tiers.0.grants.0.rollover.max",
				(g: Loose, v: unknown) => {
					g.rollover.max = v;
				},
				1_000_001,
			],
		] as const) {
			const m = menu();
			set(m.tiers[0].grants[0], bad);
			expect(problems(m)).toEqual([path]);
		}
		const m = menu();
		m.tiers[0].grants[0].amount = 100_000;
		m.tiers[0].grants[0].rollover = { months: 24 };
		expect(validateMenu(m).ok).toBe(true);
	});

	test("grant lists hold at most 12", () => {
		const m = menu();
		m.tiers[0].grants = Array.from({ length: 13 }, () => ({
			featureId: "massage",
			amount: 1,
			every: "month",
		}));
		expect(problems(m)).toContain("tiers.0.grants");
	});

	test("cross-field: duplicate ids", () => {
		let m = menu();
		m.features.push({ ...clone(m.features[0]), name: "Another name" });
		expect(problems(m)).toContain("features");
		m = menu();
		m.tiers[1].id = m.tiers[0].id;
		expect(problems(m)).toEqual(["tiers"]);
		m = menu();
		m.addons[1].id = m.addons[0].id;
		expect(problems(m)).toEqual(["addons"]);
	});

	test("cross-field: a grant names a feature of the menu, once per tier", () => {
		let m = menu();
		m.tiers[0].grants[0].featureId = "nope";
		expect(problems(m)).toEqual(["tiers.0.grants"]);
		m = menu();
		m.addons[0].grants[0].featureId = "nope";
		expect(problems(m)).toEqual(["addons.0.grants"]);
		m = menu();
		m.tiers[1].grants.push({ featureId: "massage", amount: 3, every: "year" });
		expect(problems(m)).toEqual(["tiers.1.grants"]);
	});

	test("gifts: a one-time add-on; sessions need grants, dollars have none", () => {
		const check = (over: Record<string, unknown>): string[] => {
			const m = menu();
			m.addons = [
				{
					id: "gift",
					name: "Gift",
					price: { amount: 9000, every: "once" },
					grants: [{ featureId: m.features[0].id, amount: 1, every: "month" }],
					gift: "sessions",
					...over,
				},
			];
			const r = validateMenu(m);
			return r.ok ? [] : r.problems;
		};
		expect(check({})).toEqual([]);
		expect(check({ gift: "dollars", grants: [] })).toEqual([]);
		expect(check({ price: { amount: 9000, every: "month" } })).toEqual([
			"addons.0.gift",
		]);
		expect(check({ grants: [] })).toEqual(["addons.0.grants"]);
		expect(check({ gift: "dollars" })).toEqual(["addons.0.grants"]);
		expect(check({ gift: "voucher" })).toEqual(["addons.0.gift"]);
	});

	test("web rules: names are unique (case-insensitive) among credits and among tiers", () => {
		let m = menu();
		m.features[1].name = "MASSAGE";
		expect(problems(m)).toEqual(["features.1.name"]);
		m = menu();
		m.tiers[1].name = "sparkle";
		expect(problems(m)).toEqual(["tiers.1.name"]);
	});

	test("paths are deduplicated and deterministic", () => {
		const m = menu();
		m.tiers[0].grants[0].featureId = "nope";
		m.tiers[0].grants.push({ featureId: "nope", amount: 1, every: "month" });
		expect(problems(m)).toEqual(problems(clone(m)));
		expect(problems(m)).toEqual(["tiers.0.grants"]);
	});

	test("does not mutate the input", () => {
		const m = menu();
		m.tiers[0].name = "  Sparkle ";
		const before = clone(m);
		validateMenu(m);
		expect(m).toEqual(before);
	});
});

/** The messages of a refused menu whose features are `ids`. */
const refusedFeatures = (ids: string[]) => {
	const m = menu();
	m.features = ids.map((id) => ({
		id,
		name: `Feature ${id}`,
		unit: { one: "a", other: "b" },
	}));
	// the grants name features by id: the tiers keep none, so only the features are under test
	for (const t of m.tiers) t.grants = [];
	m.addons = [];
	return { menu: m, result: validateMenu(m) };
};

describe("validateMenu: credit commodities", () => {
	test("features that differ only by digits or punctuation share a commodity and are refused, naming both ids", () => {
		for (const [first, second, commodity] of [
			["light-60", "light-90", "LIGHT"],
			["visit", "visit-2", "VISIT"],
			["a-b", "ab", "AB"],
			["k9", "k", "K"],
		] as const) {
			const { result } = refusedFeatures([first, second]);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.problems).toEqual(["features.1.id"]);
			expect(result.messages).toHaveLength(1);
			const [message] = result.messages as string[];
			expect(message).toContain(JSON.stringify(first));
			expect(message).toContain(JSON.stringify(second));
			expect(message).toContain(commodity);
		}
	});

	test("every later feature on a taken commodity is named against the first owner", () => {
		const { result } = refusedFeatures([
			"light",
			"light-60",
			"energy",
			"light-90",
		]);
		if (result.ok) throw new Error("expected problems");
		expect(result.problems).toEqual(["features.1.id", "features.3.id"]);
		expect(result.messages?.[1]).toContain('"light" and "light-90"');
	});

	test("an id with no letter has no commodity and is refused", () => {
		for (const id of ["2026", "1", "0-0", "9_9"]) {
			const { result } = refusedFeatures([id]);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.problems).toEqual(["features.0.id"]);
			expect(result.messages?.[0]).toContain(JSON.stringify(id));
			expect(result.messages?.[0]).toContain("no letter");
		}
	});

	test("ids whose letters differ are accepted, even with digits and punctuation in them", () => {
		// LIGHT, MASSAGE, KDOGS and K
		const { result } = refusedFeatures([
			"light-60",
			"massage-90",
			"k9-dogs",
			"k9",
		]);
		expect(result.ok).toBe(true);
	});

	test("a refused menu from other rules carries no commodity message", () => {
		const m = menu();
		m.tiers = [];
		m.addons = [];
		m.features.push({ ...clone(m.features[0]), name: "Another name" });
		const result = validateMenu(m);
		if (result.ok) throw new Error("expected problems");
		expect(result.problems).toEqual(["features"]);
		expect(result.messages).toBeUndefined();
	});

	test("menuCatalogRows refuses the same menus, so a stored menu cannot reach the books", () => {
		const { menu: colliding } = refusedFeatures(["light-60", "light-90"]);
		expect(() => menuCatalogRows({ menu: colliding, school: "sch_x" })).toThrow(
			/"light-60" and "light-90" both become the credit commodity LIGHT/,
		);
		const { menu: letterless } = refusedFeatures(["2026"]);
		expect(() =>
			menuCatalogRows({ menu: letterless, school: "sch_x" }),
		).toThrow(/no letter/);
		expect(
			menuCatalogRows({ menu: vibes as Menu, school: "sch_x" }).length,
		).toBeGreaterThan(0);
	});
});

describe("publicMenu / publishProblems", () => {
	test("drops tiers that are not public, keeps the rest", () => {
		const p = publicMenu(vibes as Menu);
		expect(p.tiers.map((t) => t.id)).toEqual(["sparkle", "shine"]);
		expect(p.addons).toEqual(vibes.addons as Menu["addons"]);
		expect(p.features).toEqual(vibes.features as Menu["features"]);
		expect((vibes as Menu).tiers.length).toBe(3);
	});

	test("publishing needs a public tier", () => {
		expect(publishProblems(vibes as Menu)).toEqual([]);
		const m = clone(vibes as Menu);
		for (const t of m.tiers) t.public = false;
		expect(publishProblems(m)).toEqual(["tiers"]);
		expect(publishProblems({ ...m, tiers: [] })).toEqual(["tiers"]);
	});
});
