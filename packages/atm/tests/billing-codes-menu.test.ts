/**
 * Member codes (0.8.0): `Menu.codes` validated, published as Stripe coupons and promotion codes by `menuToStripe`, and
 * applied or offered by `checkoutParams` and `withPriceIds`. `policy.memberCode` stays and means one code.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateMenu } from "../src/billing/menu.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	checkoutParams,
	lookupKeyOf,
	menuToStripe,
	tierPriceKey,
	withPriceIds,
} from "../src/billing/stripe-menu.js";
import type {
	BillingPolicy,
	Menu,
	MenuCode,
	StripeOp,
} from "../src/billing/types.js";

const SCHOOL = "0c1d2e3f-aaaa-bbbb-cccc-111122223333";
const RETURN = { success: "https://x.test/ok", cancel: "https://x.test/no" };
const base = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
const NO_CODE: BillingPolicy = { ...DEFAULT_POLICY, memberCode: null };
const withCodes = (codes: MenuCode[] | undefined, menu: Menu = base): Menu => ({
	...menu,
	...(codes ? { codes } : {}),
});
const spring: MenuCode = {
	id: "spring",
	kind: "member",
	code: "SPRING20",
	percentOff: 20,
};
const sparkleOnly: MenuCode = {
	id: "sparkle",
	kind: "member",
	code: "SPARKLE10",
	percentOff: 10,
	tierIds: ["sparkle-2", "sparkle-4"],
};
const noKeys = (ops: StripeOp[]) =>
	ops.map(({ idempotencyKey: _key, ...rest }) => rest);
const publish = (
	menu: Menu,
	previous: Menu | null,
	policy: BillingPolicy = NO_CODE,
	previousPolicy?: BillingPolicy | null,
) => menuToStripe({ schoolId: SCHOOL, menu, previous, policy, previousPolicy });
/** The code and coupon steps only: product and price steps are not what these tests are about. */
const codeOps = (ops: StripeOp[]) =>
	ops.filter(
		(op) => op.op.startsWith("coupon.") || op.op.startsWith("promotion_code."),
	);
const checkout = (menu: Menu, extra: { code?: string; tierId?: string } = {}) =>
	checkoutParams({
		schoolId: SCHOOL,
		menu,
		tierId: extra.tierId ?? "sparkle-2",
		interval: "month",
		familyId: "fam_1",
		menuVersion: 1,
		returnUrls: RETURN,
		policy: NO_CODE,
		...(extra.code === undefined ? {} : { code: extra.code }),
	});

describe("validateMenu: codes", () => {
	test("a menu with no codes is as valid as before, and one with codes keeps them", () => {
		expect(validateMenu(base).ok).toBe(true);
		const result = validateMenu(withCodes([spring, sparkleOnly]));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.menu.codes).toEqual([spring, sparkleOnly]);
	});

	test("a code is 2 to 40 letters, digits, - and _", () => {
		for (const code of ["A", "has space", "a".repeat(41), "x$y", ""]) {
			const result = validateMenu(withCodes([{ ...spring, code }]));
			expect(result.ok, code).toBe(false);
		}
		for (const code of ["AB", "a_b-9", "A".repeat(40)])
			expect(validateMenu(withCodes([{ ...spring, code }])).ok, code).toBe(
				true,
			);
	});

	test("percent off is above 0 and at most 100", () => {
		for (const percentOff of [0, -5, 100.5, 101])
			expect(validateMenu(withCodes([{ ...spring, percentOff }])).ok).toBe(
				false,
			);
		for (const percentOff of [0.5, 12.5, 100])
			expect(validateMenu(withCodes([{ ...spring, percentOff }])).ok).toBe(
				true,
			);
	});

	test("ids are unique and codes are unique without regard to case", () => {
		const sameId = validateMenu(
			withCodes([spring, { ...sparkleOnly, id: "spring" }]),
		);
		expect(sameId).toEqual({ ok: false, problems: ["codes"] });
		const sameText = validateMenu(
			withCodes([spring, { ...sparkleOnly, code: "spring20" }]),
		);
		expect(sameText).toEqual({ ok: false, problems: ["codes.1.code"] });
	});

	test("tierIds name tiers of the menu", () => {
		const result = validateMenu(
			withCodes([{ ...spring, tierIds: ["sparkle-2", "nope"] }]),
		);
		expect(result).toEqual({ ok: false, problems: ["codes.0.tierIds"] });
		// an add-on id is not a tier id
		expect(validateMenu(withCodes([{ ...spring, tierIds: ["pack"] }])).ok).toBe(
			false,
		);
	});

	test("expiresAt is a positive whole number; the list is capped at 10; only member codes exist", () => {
		for (const expiresAt of [0, -1, 1.5])
			expect(validateMenu(withCodes([{ ...spring, expiresAt }])).ok).toBe(
				false,
			);
		expect(validateMenu(withCodes([{ ...spring, expiresAt: 5 }])).ok).toBe(
			true,
		);
		const many = Array.from({ length: 11 }, (_, i) => ({
			...spring,
			id: `c${i}`,
			code: `CODE${i}X`,
		}));
		expect(validateMenu(withCodes(many)).ok).toBe(false);
		expect(validateMenu(withCodes(many.slice(0, 10))).ok).toBe(true);
		const gift = { ...spring, kind: "gift" } as unknown as MenuCode;
		expect(validateMenu(withCodes([gift])).ok).toBe(false);
	});

	test("an empty tierIds, an unknown key or a missing field is refused", () => {
		expect(validateMenu(withCodes([{ ...spring, tierIds: [] }])).ok).toBe(
			false,
		);
		const extra = { ...spring, grants: [] } as unknown as MenuCode;
		expect(validateMenu(withCodes([extra])).ok).toBe(false);
		const { percentOff: _gone, ...missing } = spring;
		expect(validateMenu(withCodes([missing as MenuCode])).ok).toBe(false);
	});
});

describe("menuToStripe: member codes", () => {
	const published = publish(withCodes([spring]), null, NO_CODE);

	test("a menu with no codes and no policy code gives no coupon or code step", () => {
		expect(codeOps(publish(base, null, NO_CODE))).toEqual([]);
	});

	test("a code is a coupon on the tier products and a promotion code for it", () => {
		const [coupon, promotion] = codeOps(published);
		expect(coupon).toMatchObject({
			op: "coupon.ensure",
			percentOff: 20,
			appliesToProductKeys: ["t:sparkle-1", "t:sparkle-2", "t:sparkle-4"],
		});
		expect(coupon?.op === "coupon.ensure" && coupon.id).toMatch(
			/^b4u_0c1d2e3f_code_spring_20_[0-9a-f]{8}$/,
		);
		expect(promotion).toMatchObject({
			op: "promotion_code.ensure",
			code: "SPRING20",
			firstTimeOnly: true,
		});
		// no expiry on the step when the code has none
		expect(Object.hasOwn(promotion as object, "expiresAt")).toBe(false);
		for (const op of codeOps(published))
			expect(op.idempotencyKey).toMatch(/^atm:/);
	});

	test("a code limited to tiers is limited to those tiers' products; add-ons are never covered", () => {
		const [coupon] = codeOps(publish(withCodes([sparkleOnly]), null));
		expect(coupon).toMatchObject({
			appliesToProductKeys: ["t:sparkle-2", "t:sparkle-4"],
		});
		for (const op of published)
			if (op.op === "coupon.ensure")
				for (const key of op.appliesToProductKeys)
					expect(key.startsWith("t:")).toBe(true);
	});

	test("firstTimeOnly defaults to true and can be turned off; an expiry is on the step", () => {
		const open: MenuCode = {
			...spring,
			firstTimeOnly: false,
			expiresAt: 1_900_000_000_000,
		};
		const [, promotion] = codeOps(publish(withCodes([open]), null));
		expect(promotion).toMatchObject({
			firstTimeOnly: false,
			expiresAt: 1_900_000_000_000,
		});
	});

	test("republishing the same menu gives no steps", () => {
		const menu = withCodes([spring, sparkleOnly]);
		expect(publish(menu, menu)).toEqual([]);
		expect(publish(menu, structuredClone(menu))).toEqual([]);
	});

	test("two codes make two coupons and two promotion codes, in menu order", () => {
		const steps = noKeys(
			codeOps(publish(withCodes([spring, sparkleOnly]), null)),
		);
		expect(steps.map((s) => s.op)).toEqual([
			"coupon.ensure",
			"promotion_code.ensure",
			"coupon.ensure",
			"promotion_code.ensure",
		]);
	});

	test("changing the percentage is a new coupon: the old code and coupon go first, then the new ones", () => {
		const before = withCodes([spring]);
		const after = withCodes([{ ...spring, percentOff: 25 }]);
		const steps = noKeys(codeOps(publish(after, before)));
		expect(steps.map((s) => s.op)).toEqual([
			"promotion_code.deactivate",
			"coupon.archive",
			"coupon.ensure",
			"promotion_code.ensure",
		]);
		expect(steps[0]).toEqual({
			op: "promotion_code.deactivate",
			code: "SPRING20",
		});
		expect(steps[2]).toMatchObject({ percentOff: 25 });
	});

	test("removing a code deactivates it and archives its coupon, and leaves the other alone", () => {
		const before = withCodes([spring, sparkleOnly]);
		const after = withCodes([sparkleOnly]);
		const steps = noKeys(codeOps(publish(after, before)));
		expect(steps.map((s) => s.op)).toEqual([
			"promotion_code.deactivate",
			"coupon.archive",
		]);
		expect(steps[0]).toMatchObject({ code: "SPRING20" });
		// all codes removed
		expect(codeOps(publish(base, before)).map((s) => s.op)).toEqual([
			"promotion_code.deactivate",
			"promotion_code.deactivate",
			"coupon.archive",
			"coupon.archive",
		]);
	});

	test("changing only the code text keeps the coupon and moves the code", () => {
		const before = withCodes([spring]);
		const after = withCodes([{ ...spring, code: "SPRING25" }]);
		const steps = noKeys(codeOps(publish(after, before)));
		expect(steps.map((s) => s.op)).toEqual([
			"promotion_code.deactivate",
			"promotion_code.ensure",
		]);
	});

	test("changing a code's expiry replaces the promotion code (Stripe cannot change it) and keeps the coupon", () => {
		const before = withCodes([{ ...spring, expiresAt: 1_900_000_000_000 }]);
		const after = withCodes([{ ...spring, expiresAt: 1_950_000_000_000 }]);
		const steps = noKeys(codeOps(publish(after, before)));
		expect(steps.map((s) => s.op)).toEqual([
			"promotion_code.deactivate",
			"promotion_code.ensure",
		]);
	});

	test("changing a code's tiers is a new coupon (the product list cannot change in Stripe)", () => {
		const before = withCodes([sparkleOnly]);
		const after = withCodes([{ ...sparkleOnly, tierIds: ["sparkle-2"] }]);
		expect(codeOps(publish(after, before)).map((s) => s.op)).toEqual([
			"promotion_code.deactivate",
			"coupon.archive",
			"coupon.ensure",
			"promotion_code.ensure",
		]);
	});

	test("a code whose tiers are not on sale makes nothing", () => {
		const menu = withCodes([{ ...spring, tierIds: ["sparkle-1"] }], {
			...base,
			tiers: base.tiers.map((t) =>
				t.id === "sparkle-1" ? { ...t, public: false } : t,
			),
		});
		expect(codeOps(publish(menu, null))).toEqual([]);
	});

	test("policy.memberCode is published as in 0.6.0, beside the menu's codes", () => {
		const member: BillingPolicy = {
			...NO_CODE,
			memberCode: { code: "MEMBER15", percentOff: 15 },
		};
		const alone = codeOps(publish(base, null, member));
		const [coupon] = alone;
		expect(coupon?.op === "coupon.ensure" && coupon.id).toMatch(
			/^b4u_0c1d2e3f_member_15_[0-9a-f]{8}$/,
		);
		const both = codeOps(publish(withCodes([spring]), null, member));
		expect(both.map((s) => s.op)).toEqual([
			"coupon.ensure",
			"promotion_code.ensure",
			"coupon.ensure",
			"promotion_code.ensure",
		]);
		expect(
			both.flatMap((s) => (s.op === "promotion_code.ensure" ? [s.code] : [])),
		).toEqual(["SPRING20", "MEMBER15"]);
		// republishing both is quiet
		expect(publish(withCodes([spring]), withCodes([spring]), member)).toEqual(
			[],
		);
	});

	test("a menu code with the same text as the policy's wins, once", () => {
		const member: BillingPolicy = {
			...NO_CODE,
			memberCode: { code: "member15", percentOff: 15 },
		};
		const menu = withCodes([
			{ ...spring, id: "member", code: "MEMBER15", percentOff: 30 },
		]);
		const steps = codeOps(publish(menu, null, member));
		expect(steps).toHaveLength(2);
		expect(steps[0]).toMatchObject({ op: "coupon.ensure", percentOff: 30 });
		expect(steps[1]).toMatchObject({ code: "MEMBER15" });
	});

	test("a menu with no codes publishes byte for byte what 0.6.0 did", () => {
		const member: BillingPolicy = {
			...NO_CODE,
			memberCode: { code: "MEMBER15", percentOff: 15 },
		};
		const oldWay = publish(base, null, member);
		const sameWithEmptyList = publish(withCodes([]), null, member);
		expect(sameWithEmptyList).toEqual(oldWay);
		const tail = oldWay.slice(-2);
		expect(tail[0]).toMatchObject({
			op: "coupon.ensure",
			percentOff: 15,
			appliesToProductKeys: ["t:sparkle-1", "t:sparkle-2", "t:sparkle-4"],
		});
		expect(tail[1]).toMatchObject({
			op: "promotion_code.ensure",
			code: "MEMBER15",
			firstTimeOnly: true,
		});
		expect(Object.hasOwn(tail[1] as object, "expiresAt")).toBe(false);
	});
});

describe("checkoutParams: codes", () => {
	test("no code, no gift: nothing is offered", () => {
		const menu: Menu = {
			...base,
			addons: base.addons.filter((a) => a.gift !== "dollars"),
		};
		const result = checkout(menu);
		expect(result.ok && result.params.allow_promotion_codes).toBeUndefined();
		expect(result.ok && result.params.discounts).toBeUndefined();
	});

	test("a menu code or the policy's lets the buyer type a code", () => {
		const menu: Menu = {
			...base,
			addons: base.addons.filter((a) => a.gift !== "dollars"),
		};
		const typed = checkout(withCodes([spring], menu));
		expect(typed.ok && typed.params.allow_promotion_codes).toBe(true);
		const viaPolicy = checkoutParams({
			schoolId: SCHOOL,
			menu,
			tierId: "sparkle-2",
			interval: "month",
			familyId: "fam_1",
			menuVersion: 1,
			returnUrls: RETURN,
			policy: DEFAULT_POLICY,
		});
		expect(viaPolicy.ok && viaPolicy.params.allow_promotion_codes).toBe(true);
	});

	test("a dollar gift add-on on the menu lets the buyer type its code", () => {
		expect(base.addons.some((a) => a.gift === "dollars")).toBe(true);
		const result = checkout(base);
		expect(result.ok && result.params.allow_promotion_codes).toBe(true);
	});

	test("a code is applied by its text, found without case, and allow_promotion_codes is left off", () => {
		const result = checkout(withCodes([spring]), { code: "spring20" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.params.discounts).toEqual([{ promotionCode: "SPRING20" }]);
		expect(Object.hasOwn(result.params, "allow_promotion_codes")).toBe(false);
	});

	test("the policy's member code can be applied too", () => {
		const result = checkoutParams({
			schoolId: SCHOOL,
			menu: base,
			tierId: "sparkle-2",
			interval: "month",
			familyId: "fam_1",
			menuVersion: 1,
			returnUrls: RETURN,
			policy: DEFAULT_POLICY,
			code: " member15 ",
		});
		expect(result.ok && result.params.discounts).toEqual([
			{ promotionCode: "MEMBER15" },
		]);
	});

	test("an unknown code is code_not_found, and a gift code atm does not know is too", () => {
		expect(checkout(withCodes([spring]), { code: "NOPE99" })).toEqual({
			ok: false,
			reason: "code_not_found",
			code: "NOPE99",
		});
		expect(checkout(base, { code: "ANYTHING" })).toMatchObject({
			ok: false,
			reason: "code_not_found",
		});
	});

	test("a code that leaves the tier out is code_not_applicable", () => {
		expect(
			checkout(withCodes([sparkleOnly]), {
				code: "SPARKLE10",
				tierId: "sparkle-1",
			}),
		).toEqual({ ok: false, reason: "code_not_applicable", code: "SPARKLE10" });
		expect(
			checkout(withCodes([sparkleOnly]), {
				code: "SPARKLE10",
				tierId: "sparkle-4",
			}).ok,
		).toBe(true);
	});

	test("the other refusals still come first", () => {
		expect(
			checkout(withCodes([spring]), { code: "SPRING20", tierId: "zzz" }),
		).toEqual({
			ok: false,
			reason: "tier_not_found",
		});
	});

	test("the params never carry both discounts and allow_promotion_codes", () => {
		for (const code of [undefined, "SPRING20"]) {
			const result = checkout(withCodes([spring]), code ? { code } : {});
			if (!result.ok) throw new Error("refused");
			const both =
				Object.hasOwn(result.params, "discounts") &&
				Object.hasOwn(result.params, "allow_promotion_codes");
			expect(both).toBe(false);
		}
	});
});

describe("withPriceIds: promotion codes", () => {
	const priceIds = (menu: Menu) =>
		Object.fromEntries(
			menu.tiers.flatMap((tier) =>
				tier.prices.map((p) => {
					const key = lookupKeyOf(
						SCHOOL,
						tierPriceKey(tier.id, p.interval),
						p.amount,
						menu.currency,
					);
					return [key, `price_${key}`] as const;
				}),
			),
		);
	const params = (code?: string) => {
		const result = checkout(withCodes([spring]), code ? { code } : {});
		if (!result.ok) throw new Error("refused");
		return result.params;
	};

	test("without a code it works as it did, with and without the new argument", () => {
		const out = withPriceIds(params(), priceIds(base));
		expect(out?.line_items[0].price).toMatch(/^price_/);
		expect(Object.hasOwn(out ?? {}, "discounts")).toBe(false);
		expect(withPriceIds(params(), priceIds(base), {})).toEqual(out);
		expect(out?.allow_promotion_codes).toBe(true);
	});

	test("the promotion code's text is swapped for Stripe's id, found without case", () => {
		const out = withPriceIds(params("SPRING20"), priceIds(base), {
			spring20: "promo_abc",
		});
		expect(out?.discounts).toEqual([{ promotion_code: "promo_abc" }]);
		expect(out?.line_items[0].price).toMatch(/^price_/);
	});

	test("a code with no id yet (or no map) is null, as a price that is not published is", () => {
		expect(withPriceIds(params("SPRING20"), priceIds(base), {})).toBeNull();
		expect(withPriceIds(params("SPRING20"), priceIds(base))).toBeNull();
		expect(withPriceIds(params(), {})).toBeNull();
	});
});
