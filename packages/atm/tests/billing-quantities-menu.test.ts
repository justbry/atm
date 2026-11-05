import { describe, expect, test } from "bun:test";
import quantitiesFixture from "../fixtures/billing/grants/menu-quantities.json";
import menuSchema from "../schema/catalog/menu.v1.json";
import {
	MAX_LINE_TOTAL,
	MAX_QUANTITIES,
	MAX_QUANTITY,
	publishProblems,
	quantitiesOf,
	validateMenu,
} from "../src/billing/menu.js";
import {
	checkoutParams,
	lookupKeyOf,
	menuToStripe,
	toStripeForm,
	withPriceIds,
} from "../src/billing/stripe-menu.js";
import type {
	BillingPolicy,
	CheckoutInput,
	Menu,
} from "../src/billing/types.js";

const SCHOOL = "0c1d2e3f-aaaa-bbbb-cccc-111122223333";
const MENU = quantitiesFixture as Menu;
const clone = <T>(value: T): T => structuredClone(value);
// biome-ignore lint/suspicious/noExplicitAny: tests poke arbitrary bad values into a clone of the fixture
type Loose = any;
const looseMenu = (): Loose => clone(quantitiesFixture);
const problems = (input: unknown): string[] => {
	const result = validateMenu(input);
	if (result.ok) throw new Error("expected problems");
	return result.problems;
};
const POLICY: BillingPolicy = {
	v: 1,
	upgradeGrant: "prorated",
	removeOnFullRefund: true,
	removeOnLostDispute: true,
	giftSessionMonths: 6,
	giftDollarMinimum: 2500,
	giftDollarMonths: 12,
	memberCode: null,
	deductionOrder: "expiry",
	lowCreditThreshold: 2,
};
const MEMBER: BillingPolicy = {
	...POLICY,
	memberCode: { code: "MEMBER15", percentOff: 15 },
};
const lookupKey = (priceKey: string, amount: number) =>
	lookupKeyOf(SCHOOL, priceKey, amount, "usd");
const base: CheckoutInput = {
	schoolId: SCHOOL,
	menu: MENU,
	tierId: "sparkle",
	interval: "month",
	familyId: "fam1",
	menuVersion: 3,
	returnUrls: { success: "s", cancel: "c" },
	policy: POLICY,
};
/** The fixture with one tier's `quantities` replaced (or removed, for undefined). */
const withQuantities = (
	menu: Menu,
	tierId: string,
	quantities: number[] | undefined,
): Menu => ({
	...menu,
	tiers: menu.tiers.map((tier) => {
		if (tier.id !== tierId) return tier;
		const { quantities: _old, ...rest } = tier;
		return quantities ? { ...rest, quantities } : rest;
	}),
});

describe("menu quantities: validateMenu", () => {
	test("the Vibes of Light fixture is valid, comes back equal and can be published", () => {
		const result = validateMenu(looseMenu());
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.menu).toEqual(MENU);
		expect(publishProblems(MENU)).toEqual([]);
		expect(MENU.tiers.map((tier) => [tier.id, tier.quantities])).toEqual([
			["sparkle", [1, 2, 4]],
			["shine", [1, 2, 4]],
			["radiate", [1, 2, 4]],
		]);
	});

	test("absent, a single count, and the limits are fine", () => {
		const accepted: (number[] | undefined)[] = [
			undefined,
			[1],
			[7],
			[MAX_QUANTITY],
			Array.from({ length: MAX_QUANTITIES }, (_, index) => index + 1),
			[1, 10, 20, 30, 40, MAX_QUANTITY],
		];
		for (const quantities of accepted)
			expect(validateMenu(withQuantities(MENU, "shine", quantities)).ok).toBe(
				true,
			);
	});

	test("empty, more than six, duplicates, unsorted and not a list name the tier's quantities", () => {
		const refused: unknown[] = [
			[],
			[1, 2, 3, 4, 5, 6, 7],
			[2, 2],
			[1, 2, 2, 4],
			[4, 2, 1],
			[1, 4, 2],
			"1,2,4",
			3,
			null,
		];
		for (const quantities of refused) {
			const menu = looseMenu();
			menu.tiers[1].quantities = quantities;
			expect(problems(menu)).toEqual(["tiers.1.quantities"]);
		}
	});

	test("a count out of 1..50 or not a whole number names that count", () => {
		const refused: [unknown[], string][] = [
			[[0, 1], "tiers.0.quantities.0"],
			[[1, 51], "tiers.0.quantities.1"],
			[[-1], "tiers.0.quantities.0"],
			[[1, 2.5], "tiers.0.quantities.1"],
			[[1, "2"], "tiers.0.quantities.1"],
			[[null], "tiers.0.quantities.0"],
		];
		for (const [quantities, path] of refused) {
			const menu = looseMenu();
			menu.tiers[0].quantities = quantities;
			expect(problems(menu)).toEqual([path]);
		}
	});

	test("an add-on has no quantities: the key is refused like any unknown one", () => {
		const menu = looseMenu();
		menu.addons[0].quantities = [1, 2];
		expect(problems(menu)).toEqual(["addons.0.quantities"]);
	});

	test("quantitiesOf: the tier's counts, else one at a time", () => {
		const [sparkle] = MENU.tiers;
		if (!sparkle) throw new Error("fixture has tiers");
		expect(quantitiesOf(sparkle)).toEqual([1, 2, 4]);
		const { quantities: _quantities, ...single } = sparkle;
		expect(quantitiesOf(single)).toEqual([1]);
	});
});

describe("menu quantities: checkoutParams", () => {
	test("the tier's line is at the quantity bought, add-on lines stay one", () => {
		const result = checkoutParams({
			...base,
			quantity: 2,
			addonIds: ["glow", "pack"],
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.params.line_items).toEqual([
			{ lookupKey: lookupKey("t:sparkle:month", 13000), quantity: 2 },
			{ lookupKey: lookupKey("a:glow:month", 5000), quantity: 1 },
			{ lookupKey: lookupKey("a:pack:once", 9000), quantity: 1 },
		]);
	});

	test("every offered count is accepted, at the same per-unit price", () => {
		for (const quantity of [1, 2, 4]) {
			const result = checkoutParams({ ...base, interval: "year", quantity });
			expect(result.ok && result.params.line_items).toEqual([
				{ lookupKey: lookupKey("t:sparkle:year", 144000), quantity },
			]);
		}
	});

	test("no quantity is 1, which a tier sold in quantities must offer", () => {
		const result = checkoutParams(base);
		expect(result.ok && result.params.line_items[0].quantity).toBe(1);
		const menu = withQuantities(MENU, "sparkle", [2, 4]);
		expect(checkoutParams({ ...base, menu })).toEqual({
			ok: false,
			reason: "quantity_not_offered",
			quantity: 1,
		});
	});

	test("a count the tier does not offer is refused, naming the quantity", () => {
		for (const quantity of [3, 0, -1, 5, 2.5, 51])
			expect(checkoutParams({ ...base, quantity })).toEqual({
				ok: false,
				reason: "quantity_not_offered",
				quantity,
			});
	});

	test("a tier without quantities is sold one at a time", () => {
		const menu = withQuantities(MENU, "sparkle", undefined);
		expect(checkoutParams({ ...base, menu, quantity: 2 })).toEqual({
			ok: false,
			reason: "quantity_not_offered",
			quantity: 2,
		});
		const one = checkoutParams({ ...base, menu, quantity: 1 });
		expect(one.ok && one.params.line_items[0].quantity).toBe(1);
		expect(checkoutParams({ ...base, menu })).toEqual(one);
	});

	test("a missing tier is tier_not_found before the quantity is looked at", () => {
		expect(checkoutParams({ ...base, tierId: "nope", quantity: 3 })).toEqual({
			ok: false,
			reason: "tier_not_found",
		});
	});

	test("the subscription's metadata carries the quantity unless it is the default 1; the session's never does", () => {
		const one = checkoutParams({ ...base, quantity: 1 });
		if (!one.ok) throw new Error(one.reason);
		expect("quantity" in one.params.subscription_data.metadata).toBe(false);
		const omitted = checkoutParams(base);
		if (!omitted.ok) throw new Error(omitted.reason);
		expect("quantity" in omitted.params.subscription_data.metadata).toBe(false);

		const result = checkoutParams({ ...base, quantity: 4 });
		if (!result.ok) throw new Error(result.reason);
		expect(result.params.subscription_data.metadata).toEqual({
			b4u_school: SCHOOL,
			family_id: "fam1",
			tier_id: "sparkle",
			interval: "month",
			menu_version: "3",
			quantity: "4",
		});
		expect("quantity" in result.params.metadata).toBe(false);
	});

	test("withPriceIds and toStripeForm keep the quantities", () => {
		const result = checkoutParams({
			...base,
			quantity: 4,
			addonIds: ["glow"],
		});
		if (!result.ok) throw new Error(result.reason);
		const priceIds = {
			[lookupKey("t:sparkle:month", 13000)]: "price_tier",
			[lookupKey("a:glow:month", 5000)]: "price_glow",
		};
		const priced = withPriceIds(result.params, priceIds);
		expect(priced?.line_items).toEqual([
			{ price: "price_tier", quantity: 4 },
			{ price: "price_glow", quantity: 1 },
		]);
		expect(
			withPriceIds(result.params, {
				[lookupKey("t:sparkle:month", 13000)]: "price_tier",
			}),
		).toBeNull();
		expect(
			withPriceIds(result.params, {
				[lookupKey("a:glow:month", 5000)]: "price_glow",
			}),
		).toBeNull();
		if (!priced) throw new Error("price ids missing");
		const form = toStripeForm(priced);
		expect(form).toMatchObject({
			"line_items[0][price]": "price_tier",
			"line_items[0][quantity]": "4",
			"line_items[1][price]": "price_glow",
			"line_items[1][quantity]": "1",
			"subscription_data[metadata][quantity]": "4",
		});
		expect(form["metadata[quantity]"]).toBeUndefined();
	});

	test("a member code at quantity 4: promotion codes allowed, the coupon covers the tier's per-unit price", () => {
		const result = checkoutParams({ ...base, policy: MEMBER, quantity: 4 });
		if (!result.ok) throw new Error(result.reason);
		expect(result.params.allow_promotion_codes).toBe(true);
		expect(result.params.line_items).toEqual([
			{ lookupKey: lookupKey("t:sparkle:month", 13000), quantity: 4 },
		]);
		const ops = menuToStripe({
			schoolId: SCHOOL,
			menu: MENU,
			previous: null,
			policy: MEMBER,
		});
		const coupon = ops.find((op) => op.op === "coupon.ensure");
		expect(
			coupon?.op === "coupon.ensure" && coupon.appliesToProductKeys,
		).toEqual(["t:radiate", "t:shine", "t:sparkle"]);
		const published = new Set(
			ops.flatMap((op) => (op.op === "price.create" ? [op.lookupKey] : [])),
		);
		expect(published.has(result.params.line_items[0].lookupKey)).toBe(true);
	});
});

describe("menu quantities: menuToStripe", () => {
	const publish = (menu: Menu, previous: Menu | null, policy = POLICY) =>
		menuToStripe({ schoolId: SCHOOL, menu, previous, policy });

	test("prices are per unit: adding, changing or removing a tier's quantities publishes nothing", () => {
		const without: Menu = {
			...MENU,
			tiers: MENU.tiers.map(({ quantities: _quantities, ...tier }) => tier),
		};
		const changed = withQuantities(MENU, "shine", [1, 3, 6]);
		const pairs: [Menu, Menu][] = [
			[without, MENU],
			[MENU, without],
			[MENU, changed],
			[changed, MENU],
			[MENU, withQuantities(MENU, "radiate", undefined)],
		];
		for (const policy of [POLICY, MEMBER])
			for (const [previous, menu] of pairs) {
				expect(publish(previous, null, policy).length).toBeGreaterThan(0);
				expect(publish(menu, previous, policy)).toEqual([]);
			}
	});

	test("the first publish is the same with or without quantities", () => {
		const without: Menu = {
			...MENU,
			tiers: MENU.tiers.map(({ quantities: _quantities, ...tier }) => tier),
		};
		expect(publish(MENU, null, MEMBER)).toEqual(publish(without, null, MEMBER));
	});
});

describe("limits", () => {
	const quantitiesSchema = (
		menuSchema.$defs.tier.properties as unknown as Record<
			string,
			{ maxItems?: number; items?: { maximum?: number; minimum?: number } }
		>
	).quantities;

	test("the constants match the JSON schema", () => {
		expect(quantitiesSchema?.maxItems).toBe(MAX_QUANTITIES);
		expect(quantitiesSchema?.items?.maximum).toBe(MAX_QUANTITY);
		expect(quantitiesSchema?.items?.minimum).toBe(1);
	});

	test("a price whose total at the largest count passes Stripe's cap is refused", () => {
		const menu = structuredClone(quantitiesFixture) as unknown as Menu;
		const tier = menu.tiers[0] as Menu["tiers"][number];
		tier.quantities = [1, 50];
		const price = tier.prices[0] as Menu["tiers"][number]["prices"][number];
		price.amount = Math.floor(MAX_LINE_TOTAL / 50);
		expect(validateMenu(menu).ok).toBe(true);
		price.amount = Math.floor(MAX_LINE_TOTAL / 50) + 1;
		const refused = validateMenu(menu);
		expect(refused.ok).toBe(false);
		if (!refused.ok)
			expect(refused.problems).toContain("tiers.0.prices.0.amount");
	});

	test("without quantities the cap is the single price, as before", () => {
		const menu = structuredClone(quantitiesFixture) as unknown as Menu;
		const tier = menu.tiers[0] as Menu["tiers"][number];
		tier.quantities = undefined;
		(tier.prices[0] as Menu["tiers"][number]["prices"][number]).amount =
			10_000_000;
		expect(validateMenu(menu).ok).toBe(true);
	});

	test("subscription metadata is a copy of the session's at the default quantity", () => {
		const result = checkoutParams({ ...base, quantity: 1 });
		if (!result.ok) throw new Error(result.reason);
		expect(result.params.subscription_data.metadata).not.toBe(
			result.params.metadata,
		);
	});
});
