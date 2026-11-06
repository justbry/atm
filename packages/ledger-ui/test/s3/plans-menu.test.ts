import { expect, test } from "bun:test";
import {
	canonical,
	diffMenus,
	grantText,
	money,
	priceText,
	problems,
	slug,
	withAddon,
	withTier,
} from "../../src/app/plans-menu.ts";
import { audienceView } from "../../src/app/view-as.ts";
import type { Menu, MenuTier } from "../../src/data/plans.ts";
import type { School } from "../../src/data/types.ts";
import { plansBySchool } from "../../src/fixtures/plans.ts";

const menuOf = (schoolId: string, version: number): Menu => {
	const body = plansBySchool[schoolId]?.bodies[version];
	if (!body) throw new Error(`no ${schoolId} v${version}`);
	return body.menu;
};
const live = menuOf("vol", 3);
const glow = live.tiers[2] as MenuTier;
const sparkle = live.tiers[0] as MenuTier;
const withGlow = (change: Partial<MenuTier>): Menu =>
	withTier(live, { ...glow, ...change }, "glow");

test("the live menu has no changes against itself, and key order does not matter", () => {
	expect(diffMenus(live, live)).toEqual([]);
	const reordered = JSON.parse(JSON.stringify(live), (_key, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).reverse())
			: value,
	) as Menu;
	expect(canonical(reordered)).toBe(canonical(live));
	expect(diffMenus(live, reordered)).toEqual([]);
});

test("a changed price names both prices and what it does on Stripe", () => {
	const [change] = diffMenus(
		live,
		withGlow({
			prices: [
				{ interval: "month", amount: 7000 },
				{ interval: "year", amount: 70200 },
			],
		}),
	);
	expect(change).toEqual({
		id: "glow",
		name: "Glow",
		kind: "tiers",
		status: "changed",
		lines: [
			{
				title: "Monthly price $65.00 → $70.00",
				detail: "Create a $70.00/month price and archive the $65.00 one",
			},
		],
	});
});

test("every kind of change has its mockup text", () => {
	const titles = (draft: Menu): string[] =>
		diffMenus(live, draft).flatMap(({ lines }) =>
			lines.map(({ title }) => title),
		);
	expect(titles(withGlow({ name: "Shimmer" }))).toEqual([
		'Name "Glow" → "Shimmer"',
	]);
	expect(titles(withGlow({ blurb: "More" }))).toEqual(["Description changed"]);
	expect(
		titles(withGlow({ prices: [{ interval: "month", amount: 6500 }] })),
	).toEqual(["Yearly price $702.00 → none"]);
	expect(titles(withGlow({ audience: "public" }))).toEqual([
		"Audience Member → Public",
	]);
	expect(titles(withGlow({ quantities: [1, 2] }))).toEqual([
		"Sold in 1, 2 (was one size)",
	]);
	expect(titles(withGlow({ public: false }))).toEqual(["Now hidden"]);
	expect(
		titles(
			withGlow({
				grants: [{ featureId: "sessions", amount: 30, every: "month" }],
			}),
		),
	).toEqual(["What members get changed"]);
	expect(
		titles(
			withAddon(
				live,
				{
					...(live.addons[0] as Menu["addons"][number]),
					price: { amount: 4500, every: "once" },
				},
				"pack8",
			),
		),
	).toEqual(["Price $40.00 one time → $45.00 one time"]);
});

test("a plan the draft adds is new, and one it leaves out is removed", () => {
	const added = withTier(
		live,
		{ ...glow, id: "bloom", name: "Bloom", audience: "governance" },
		null,
	);
	expect(diffMenus(live, added)).toEqual([
		{
			id: "bloom",
			name: "Bloom",
			kind: "tiers",
			status: "new",
			lines: [
				{ title: "New plan", detail: "Create a Stripe product and its prices" },
				{
					title: "Audience: Governance",
					detail:
						"Starts a new version; existing members keep theirs. No Stripe change",
				},
			],
		},
	]);
	const removed = { ...live, tiers: live.tiers.slice(0, 2) };
	expect(
		diffMenus(live, removed).map(({ id, status }) => [id, status]),
	).toEqual([["glow", "removed"]]);
});

test("an unpublished school's every plan is new", () => {
	const empty: Menu = { ...live, tiers: [], addons: [] };
	expect(diffMenus(empty, live)).toHaveLength(5);
	expect(new Set(diffMenus(empty, live).map(({ status }) => status))).toEqual(
		new Set(["new"]),
	);
});

test("problems are the mockup's, each once, and a hidden tier may have no price", () => {
	expect(problems(live)).toEqual([]);
	expect(problems(menuOf("b4u", 3))).toEqual([]);
	expect(
		problems(
			withGlow({
				prices: [
					{ interval: "month", amount: 0 },
					{ interval: "year", amount: 70200 },
				],
			}),
		),
	).toEqual(["Glow: monthly price must be above 0."]);
	expect(problems(withGlow({ prices: [] }))).toEqual([
		"Glow: monthly price must be above 0.",
	]);
	expect(problems(withGlow({ public: false, prices: [] }))).toEqual([]);
	expect(problems(withGlow({ name: " " }))).toEqual(["A plan needs a name."]);
	expect(problems(withGlow({ quantities: [1, 1] }))).toEqual([
		"Glow: sizes must be 1 to 6 different whole numbers from 1 to 50.",
	]);
	expect(
		problems(
			withGlow({
				grants: [{ featureId: "sessions", amount: 0, every: "month" }],
			}),
		),
	).toEqual(["Glow: each grant needs a whole number above 0."]);
	expect(problems(withTier(live, { ...glow, id: "sparkle" }, null))).toContain(
		"Glow: another plan has the same id.",
	);
	const five = [
		...live.tiers,
		...live.tiers.map((tier) => ({ ...tier, id: `${tier.id}-2` })),
	];
	expect(problems({ ...live, tiers: five })[0]).toBe("At most 4 memberships.");
});

test("prices and grants read as the mockup's priceTxt and grantTxt", () => {
	expect(priceText(live, sparkle)).toBe(
		"$32.50 per session / month · $350.00 / year",
	);
	expect(priceText(live, glow)).toBe("$65.00 / month · $702.00 / year");
	expect(priceText(live, live.addons[0] as Menu["addons"][number])).toBe(
		"$40.00 one time",
	);
	const board = menuOf("b4u", 3);
	expect(priceText(board, board.tiers[2] as MenuTier)).toBe("Not for sale");
	const grant = sparkle.grants[0];
	if (!grant) throw new Error("no grant");
	expect(grantText(live, grant, { perUnit: true, once: false })).toBe(
		"8 sessions per unit each month, rolls over 1 mo",
	);
	expect(grantText(live, grant, { perUnit: false, once: true }, 4)).toBe(
		"32 sessions once, rolls over 1 mo",
	);
	expect(
		grantText(
			live,
			{ ...grant, amount: 1, rollover: { months: 0 } },
			{ perUnit: false, once: false },
		),
	).toBe("1 session each month");
	expect(money(28700, "usd")).toBe("$287.00");
	expect(money(8500, "cad")).toBe("CA$85.00");
});

test("a new plan's id is its name as a slug", () => {
	expect(slug("Trial pack")).toBe("trial-pack");
	expect(slug("  Big  Top-up!  ")).toBe("big-top-up");
	expect(slug("x".repeat(60))).toHaveLength(40);
	expect(slug("")).toBe("");
});

const person = (
	role: School["role"],
	booksLevel: School["booksLevel"],
): School => ({ role, booksLevel }) as School;

test("a person previews only the audiences at or below their own", () => {
	const owner = person("owner", "owner");
	const finance = person("admin", "finance_admin");
	const admin = person("admin", "member");
	expect(audienceView(owner, null)).toEqual({
		audience: "owner",
		preview: false,
		admin: true,
		finance: true,
	});
	expect(audienceView(owner, "admin")).toEqual({
		audience: "admin",
		preview: true,
		admin: true,
		finance: false,
	});
	expect(audienceView(owner, "public").admin).toBe(false);
	expect(audienceView(finance, null).audience).toBe("finance");
	expect(audienceView(finance, "owner").audience).toBe("finance");
	expect(audienceView(finance, "admin").preview).toBe(true);
	expect(audienceView(admin, null).audience).toBe("admin");
	expect(audienceView(admin, "finance").audience).toBe("admin");
	expect(audienceView(admin, "governance").audience).toBe("admin");
	expect(audienceView(admin, "member").audience).toBe("member");
	expect(audienceView(owner, "nonsense").audience).toBe("owner");
});
