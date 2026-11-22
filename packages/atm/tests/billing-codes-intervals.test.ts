/**
 * A member code limited to intervals (`MenuCode.intervals`): B4 Uni's early price, `EARLY2027`, is 30% off yearly
 * family plans only. Stripe cannot restrict a code by price, so `checkoutParams` enforces it.
 */
import { describe, expect, test } from "bun:test";
import b4uni from "../fixtures/billing/menu/b4uni-merchant.json";
import { validateMenu } from "../src/billing/menu.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { checkoutParams, menuToStripe } from "../src/billing/stripe-menu.js";
import type { Interval, Menu } from "../src/billing/types.js";

const MERCHANT = "b4uni";
const POLICY = { ...DEFAULT_POLICY, memberCode: null };
const menu = (): Menu => structuredClone(b4uni) as Menu;
const checkout = (interval: Interval, code?: string, m = menu()) =>
	checkoutParams({
		schoolId: MERCHANT,
		menu: m,
		tierId: "go_build",
		interval,
		familyId: "fam_7",
		menuVersion: 1,
		returnUrls: { success: "https://x/ok", cancel: "https://x/no" },
		policy: POLICY,
		...(code === undefined ? {} : { code }),
	});

describe("validateMenu: code intervals", () => {
	test("EARLY2027 is limited to yearly checkouts", () => {
		expect(validateMenu(menu()).ok).toBe(true);
		expect(menu().codes?.[0]?.intervals).toEqual(["year"]);
	});

	test("a code limited to an interval none of its tiers is priced at is refused", () => {
		const m = menu();
		const tier = m.tiers.find((t) => t.id === "go_build");
		const code = m.codes?.[0];
		if (!(tier && code)) throw new Error("fixture changed");
		code.tierIds = ["go_build"];
		tier.prices = tier.prices.filter((p) => p.interval === "month");
		const result = validateMenu(m);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.problems).toContain("codes.0.intervals");
	});

	test("a code for another tier opens no typing on a monthly checkout", () => {
		const m = menu();
		m.codes?.push({
			id: "other",
			kind: "member",
			code: "OTHER10",
			percentOff: 10,
			tierIds: ["go_hive"],
		});
		const monthly = checkout("month", undefined, m);
		expect(monthly.ok).toBe(true);
		if (monthly.ok)
			expect(monthly.params).not.toHaveProperty("allow_promotion_codes");
	});

	test("intervals are month or year, at least one, no repeats", () => {
		for (const intervals of [[], ["week"], ["year", "year"]]) {
			const m = menu() as unknown as { codes: { intervals: unknown }[] };
			(m.codes[0] as { intervals: unknown }).intervals = intervals;
			const result = validateMenu(m);
			expect(result.ok).toBe(false);
		}
	});
});

describe("checkoutParams: code intervals", () => {
	test("the code applies on a yearly checkout", () => {
		const result = checkout("year", "early2027");
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(result.params.discounts).toEqual([{ promotionCode: "EARLY2027" }]);
	});

	test("on a monthly checkout it is not applicable", () => {
		expect(checkout("month", "EARLY2027")).toEqual({
			ok: false,
			reason: "code_not_applicable",
			code: "EARLY2027",
		});
	});

	test("a monthly checkout offers no typing when no code is valid for it; a yearly one does", () => {
		const monthly = checkout("month");
		const yearly = checkout("year");
		expect(monthly.ok).toBe(true);
		if (monthly.ok)
			expect(monthly.params).not.toHaveProperty("allow_promotion_codes");
		expect(yearly.ok && yearly.params.allow_promotion_codes).toBe(true);
	});

	test("a code with no intervals still applies, and offers typing, at every interval", () => {
		const m = menu();
		delete m.codes?.[0]?.intervals;
		expect(checkout("month", "EARLY2027", m).ok).toBe(true);
		const monthly = checkout("month", undefined, m);
		expect(monthly.ok && monthly.params.allow_promotion_codes).toBe(true);
	});
});

describe("menuToStripe: intervals publish nothing", () => {
	test("limiting a published code to yearly makes no Stripe step", () => {
		const before = menu();
		delete before.codes?.[0]?.intervals;
		expect(
			menuToStripe({
				schoolId: MERCHANT,
				menu: menu(),
				previous: before,
				policy: POLICY,
			}),
		).toEqual([]);
	});
});
