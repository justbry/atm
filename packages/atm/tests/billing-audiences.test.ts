/**
 * Audiences: one merchant's menu sold to several kinds of buyer (B4 Uni's own plans for families, guides, schools and
 * organizers, `plans/b4uni-merchant/PLAN.md`). The limits are per audience, `publicMenu` gives one audience's page,
 * checkout keeps an audience's add-ons on its own tiers, and the books are one ledger with a holder per group.
 */
import { describe, expect, test } from "bun:test";
import b4uni from "../fixtures/billing/menu/b4uni-merchant.json";
import vibes from "../fixtures/billing/menu/vibes-menu.json";
import {
	MAX_ADDONS,
	MAX_AUDIENCES,
	MAX_TIERS,
	publicMenu,
	validateMenu,
} from "../src/billing/menu.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	addonPriceKey,
	checkoutParams,
	lookupKeyOf,
	menuToStripe,
	oneTimeCheckoutParams,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type { Menu, MenuAddon, MenuTier } from "../src/billing/types.js";
import { createStore } from "../src/scenario/store.js";
import { invoicePaid } from "../src/scenario/stripe-events.js";

const MERCHANT = "b4uni";
const menu = (): Menu => structuredClone(b4uni) as Menu;
const problems = (m: unknown): string[] => {
	const result = validateMenu(m);
	if (result.ok) throw new Error("expected problems");
	return result.problems;
};
const tierOf = (m: Menu, id: string) =>
	m.tiers.find((t) => t.id === id) as MenuTier;
const addonOf = (m: Menu, id: string) =>
	m.addons.find((a) => a.id === id) as MenuAddon;
const copies = <T extends { id: string; name: string }>(
	item: T,
	count: number,
	over: Partial<T> = {},
): T[] =>
	Array.from({ length: count }, (_, i) => ({
		...structuredClone(item),
		id: `${item.id}-${i}`,
		name: `${item.name} ${i}`,
		...over,
	}));

describe("validateMenu: audiences", () => {
	test("B4 Uni's own menu is valid: 9 tiers and 9 add-ons, none over the per-audience limits", () => {
		const result = validateMenu(menu());
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.menu).toEqual(menu());
		expect(menu().tiers.length).toBeGreaterThan(MAX_TIERS);
		expect(menu().addons.length).toBeGreaterThan(MAX_ADDONS);
	});

	test("a menu with no audiences keeps the limits it had: 4 tiers, 6 add-ons", () => {
		const m = structuredClone(vibes) as Menu;
		const tier = m.tiers[0] as MenuTier;
		m.tiers = copies(tier, MAX_TIERS + 1);
		expect(problems(m)).toEqual(["tiers"]);
		m.tiers = copies(tier, MAX_TIERS);
		m.addons = copies(m.addons[0] as MenuAddon, MAX_ADDONS + 1);
		expect(problems(m)).toEqual(["addons"]);
	});

	test("each audience may have 4 tiers and 6 add-ons", () => {
		const m = menu();
		const tier = tierOf(m, "go_build");
		const pack = addonOf(m, "credits_50");
		m.tiers = [
			...copies(tier, MAX_TIERS, { audience: "families" }),
			...copies(tier, MAX_TIERS, { audience: "guides", id: "g" }).map(
				(t, i) => ({ ...t, id: `g-${i}`, name: `Guide ${i}` }),
			),
		];
		m.addons = copies(pack, MAX_ADDONS);
		// the early-prepay code and the holder prefixes name tiers and audiences replaced here
		delete m.codes;
		delete m.holderPrefixes;
		expect(validateMenu(m).ok).toBe(true);
		m.tiers.push({ ...tier, id: "fifth", name: "Fifth" });
		expect(problems(m)).toEqual(["tiers"]);
	});

	test("an item with no audience counts toward every audience", () => {
		const m = menu();
		const shared = { ...addonOf(m, "vetting"), audience: undefined };
		delete shared.audience;
		// families sell four packs and Go Learn; two shared add-ons make seven for them
		m.addons = [
			...m.addons,
			...copies(shared, 2).map((a, i) => ({ ...a, id: `shared-${i}` })),
		];
		expect(problems(m)).toEqual(["addons"]);
		m.addons.pop();
		expect(validateMenu(m).ok).toBe(true);
	});

	test(`at most ${MAX_AUDIENCES} audiences`, () => {
		const m = menu();
		const tier = tierOf(m, "basecamp");
		// families and six more audiences, counted in the order they first appear
		m.tiers = [
			...m.tiers.slice(0, 2),
			...copies(tier, 6).map((t, i) => ({ ...t, audience: `a${i}` })),
		];
		m.addons = m.addons.filter((a) => a.audience === "families");
		delete m.holderPrefixes;
		expect(problems(m)).toEqual(["tiers.7.audience"]);
		m.tiers.pop();
		expect(validateMenu(m).ok).toBe(true);
	});

	test("an audience is an id", () => {
		const m = menu();
		tierOf(m, "academy").audience = "Schools!";
		expect(problems(m)).toEqual(["tiers.6.audience"]);
	});
});

describe("publicMenu: one audience's page", () => {
	test("an audience sees its own tiers and add-ons, and those with no audience", () => {
		const m = menu();
		const shared = structuredClone(addonOf(m, "trip_leader_check"));
		delete shared.audience;
		m.addons.push({ ...shared, id: "shared" });
		tierOf(m, "guide_studio").public = false;
		const guides = publicMenu(m, "guides");
		expect(guides.tiers.map((t) => t.id)).toEqual(["guide_pro"]);
		expect(guides.addons.map((a) => a.id)).toEqual([
			"vetting",
			"vetting_pro",
			"shared",
		]);
		expect(publicMenu(m, "nobody").tiers).toEqual([]);
	});

	test("without an audience it is the whole public menu, as before", () => {
		const m = menu();
		expect(publicMenu(m).tiers).toHaveLength(m.tiers.length);
		expect(publicMenu(m).addons).toEqual(m.addons);
	});
});

describe("checkoutParams: audiences", () => {
	const checkout = (
		tierId: string,
		addonIds: string[],
		m = menu(),
		familyId = "fam_1",
	) =>
		checkoutParams({
			schoolId: MERCHANT,
			menu: m,
			tierId,
			interval: "month",
			addonIds,
			familyId,
			menuVersion: 1,
			returnUrls: { success: "https://x/ok", cancel: "https://x/no" },
			policy: { ...DEFAULT_POLICY, memberCode: null },
		});

	test("an add-on of another audience is refused", () => {
		expect(checkout("go_build", ["extra_school"])).toEqual({
			ok: false,
			reason: "addon_audience_mismatch",
			addonId: "extra_school",
		});
		expect(checkout("academy", ["extra_school"], menu(), "school-9").ok).toBe(
			true,
		);
		expect(checkout("go_build", ["credits_100"]).ok).toBe(true);
	});

	test("an add-on with no audience goes with any tier", () => {
		const m = menu();
		delete addonOf(m, "extra_school").audience;
		expect(checkout("go_build", ["extra_school"], m).ok).toBe(true);
	});

	test("a tier with no audience takes any audience's add-on, as publicMenu shows them together", () => {
		const m = menu();
		delete tierOf(m, "go_build").audience;
		expect(publicMenu(m, "schools").tiers.map((t) => t.id)).toContain(
			"go_build",
		);
		expect(checkout("go_build", ["extra_school"], m).ok).toBe(true);
	});

	test("a one-time checkout keeps to one audience", () => {
		const oneTime = (addonIds: string[], m = menu()) =>
			oneTimeCheckoutParams({
				schoolId: MERCHANT,
				menu: m,
				addonIds,
				familyId: "fam_1",
				menuVersion: 1,
				returnUrls: { success: "https://x/ok", cancel: "https://x/no" },
			});
		expect(oneTime(["credits_50", "vetting"])).toEqual({
			ok: false,
			reason: "addon_audience_mismatch",
			addonId: "vetting",
		});
		expect(oneTime(["credits_50", "credits_100"]).ok).toBe(true);
		const m = menu();
		delete addonOf(m, "vetting").audience;
		expect(oneTime(["credits_50", "vetting"], m).ok).toBe(true);
	});

	test("the holder id must have the prefix of the tier's audience", () => {
		expect(checkout("guide_pro", [], menu(), "fam_1")).toEqual({
			ok: false,
			reason: "holder_not_in_audience",
			familyId: "fam_1",
		});
		expect(checkout("guide_pro", [], menu(), "guide-u42").ok).toBe(true);
		// the prefix alone names nobody
		expect(checkout("guide_pro", [], menu(), "guide-").ok).toBe(false);
		expect(checkout("basecamp", [], menu(), "org-3").ok).toBe(true);
		expect(checkout("academy", [], menu(), "school_9").ok).toBe(false);
	});

	test("an audience with no prefix, or a menu with none, takes any holder id", () => {
		const m = menu();
		delete m.holderPrefixes?.guides;
		expect(checkout("guide_pro", [], m, "u42").ok).toBe(true);
		delete m.holderPrefixes;
		expect(checkout("academy", [], m, "fam_1").ok).toBe(true);
	});
});

describe("validateMenu: holder prefixes", () => {
	test("B4 Uni's frozen ids: school b4uni, fam_, guide-, school-, org-", () => {
		expect(MERCHANT).toBe("b4uni");
		expect(menu().holderPrefixes).toEqual({
			families: "fam_",
			guides: "guide-",
			schools: "school-",
			organizers: "org-",
		});
	});

	test("a prefix names an audience of the menu and ends in _ or -", () => {
		const m = menu();
		(m.holderPrefixes as Record<string, string>).travelers = "trav-";
		expect(problems(m)).toEqual(["holderPrefixes.travelers"]);
		const bad = menu();
		(bad.holderPrefixes as Record<string, string>).guides = "guide";
		expect(problems(bad)).toEqual(["holderPrefixes.guides"]);
	});

	test("no prefix starts another, so a holder id has one audience", () => {
		const m = menu();
		(m.holderPrefixes as Record<string, string>).organizers = "fam_";
		expect(problems(m)).toEqual([
			"holderPrefixes.families",
			"holderPrefixes.organizers",
		]);
	});
});

describe("menuToStripe: audiences publish nothing", () => {
	test("adding audiences to a published menu makes no Stripe step", () => {
		const before = menu();
		for (const item of [...before.tiers, ...before.addons])
			delete item.audience;
		const params = {
			schoolId: MERCHANT,
			policy: { ...DEFAULT_POLICY, memberCode: null },
		};
		const first = menuToStripe({ ...params, menu: menu(), previous: null });
		expect(first.length).toBeGreaterThan(0);
		expect(menuToStripe({ ...params, menu: menu(), previous: before })).toEqual(
			[],
		);
	});
});

describe("one merchant's books: a holder per group", () => {
	const at = Date.UTC(2026, 10, 23, 17);
	const month = 30 * 24 * 3_600_000;
	const line = (
		m: Menu,
		key: string,
		amount: number,
		interval: "month" | null,
	) => ({
		lookupKey: lookupKeyOf(MERCHANT, key, amount, m.currency),
		amount,
		interval,
	});

	test("a family's credit pack and a guide's plan book to one merchant, each to its own holder", () => {
		const m = menu();
		const family = createStore({ menu: m, school: MERCHANT, family: "fam_7" });
		const guide = createStore({
			menu: m,
			school: MERCHANT,
			family: "guide-u42",
		});
		const pack = addonOf(m, "credits_250");
		const packResult = family.handle(
			invoicePaid({
				eventId: "evt_pack",
				invoiceId: "in_pack",
				at,
				subscriptionId: null,
				reason: "manual",
				periodStart: at,
				periodEnd: at,
				lines: [
					line(m, addonPriceKey(pack.id, "once"), pack.price.amount, null),
				],
				metadata: { b4u_school: MERCHANT, family_id: "fam_7" },
			}),
			at,
		);
		expect(packResult.refused ?? null).toBeNull();
		expect(family.avail(at, "credits")).toBe(250);

		const pro = tierOf(m, "guide_pro");
		const proResult = guide.handle(
			invoicePaid({
				eventId: "evt_pro",
				invoiceId: "in_pro",
				at,
				subscriptionId: "sub_pro",
				reason: "subscription_create",
				periodStart: at,
				periodEnd: at + month,
				lines: [line(m, tierPriceKey(pro.id, "month"), 1900, "month")],
				metadata: { b4u_school: MERCHANT, family_id: "guide-u42" },
			}),
			at,
		);
		expect(proResult.refused ?? null).toBeNull();
		expect(guide.avail(at, "credits")).toBe(0);

		const payments = [...family.events, ...guide.events].filter(
			(e) => e.event_type === "payment.succeeded",
		);
		expect(payments.map((e) => e.school)).toEqual([MERCHANT, MERCHANT]);
		expect(payments.map((e) => e.key)).toEqual([
			"family:fam_7",
			"family:guide-u42",
		]);
		const income = payments.flatMap((e) =>
			e.postings
				.filter((p) => p.account.startsWith("income:"))
				.map((p) => p.account),
		);
		expect(income).toEqual([
			"income:billing:addon:credits_250",
			"income:billing:membership:guide_pro",
		]);
	});
});
