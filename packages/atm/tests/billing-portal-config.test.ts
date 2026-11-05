import { describe, expect, test } from "bun:test";
import quantitiesFixture from "../fixtures/billing/grants/menu-quantities.json";
import vibes from "../fixtures/billing/menu/vibes-menu.json";
import { portalConfigOf } from "../src/index.js";
import type { Menu, PortalConfigIds } from "../src/types.js";

const MENU = quantitiesFixture as Menu;
const clone = <T>(value: T): T => structuredClone(value);

const idsFor = (menu: Menu): PortalConfigIds => {
	const products: Record<string, string> = {};
	const prices: Record<string, string> = {};
	for (const tier of menu.tiers) {
		products[`t:${tier.id}`] = `prod_${tier.id}`;
		for (const price of tier.prices)
			prices[`t:${tier.id}:${price.interval}`] =
				`price_${tier.id}_${price.interval}`;
	}
	return { products, prices };
};

type ReferenceIds = {
	products: Record<string, string>;
	prices: Record<string, string>;
};

/**
 * `portalFieldsOf` from justbry/buzz-school#1307 (packages/family-service/src/school-billing/publish.ts), copied as it
 * was written (with `quantitiesOf` inlined): the output atm's `portalConfigOf` has to match so the family service can
 * switch.
 */
function portalFieldsOf(
	menu: Menu,
	ids: ReferenceIds,
): Record<string, string> | null {
	const quantitiesOf = (tier: Menu["tiers"][number]) => tier.quantities ?? [1];
	const tiers = menu.tiers.filter(
		(t) => t.public && quantitiesOf(t).length > 1 && ids.products[`t:${t.id}`],
	);
	if (tiers.length === 0) return null;
	const f: Record<string, string> = {
		"features[invoice_history][enabled]": "true",
		"features[payment_method_update][enabled]": "true",
		"features[subscription_cancel][enabled]": "true",
		"features[subscription_cancel][mode]": "at_period_end",
		"features[subscription_update][enabled]": "true",
		"features[subscription_update][default_allowed_updates][0]": "quantity",
		"features[subscription_update][proration_behavior]": "always_invoice",
		"features[subscription_update][schedule_at_period_end][conditions][0][type]":
			"decreasing_item_amount",
		"metadata[b4u_key]": "portal",
	};
	tiers.forEach((t, i) => {
		const q = quantitiesOf(t);
		const k = `features[subscription_update][products][${i}]`;
		f[`${k}[product]`] = ids.products[`t:${t.id}`] as string;
		// Dense indexes: Stripe refuses a form array with a gap.
		t.prices
			.map((p) => ids.prices[`t:${t.id}:${p.interval}`])
			.filter((x): x is string => !!x)
			.forEach((price, j) => {
				f[`${k}[prices][${j}]`] = price;
			});
		f[`${k}[adjustable_quantity][enabled]`] = "true";
		f[`${k}[adjustable_quantity][minimum]`] = String(Math.min(...q));
		f[`${k}[adjustable_quantity][maximum]`] = String(Math.max(...q));
	});
	return f;
}

describe("portalConfigOf", () => {
	test("a menu with quantities: the form fields the family service's portalFieldsOf made", () => {
		const ids = idsFor(MENU);
		expect(portalConfigOf(MENU, ids)).toEqual(portalFieldsOf(MENU, ids));
	});

	test("the fields: quantity-only updates, a raise billed at once, a decrease at the renewal, cancel at the period end", () => {
		const fields = portalConfigOf(MENU, idsFor(MENU));
		expect(fields).toMatchObject({
			"features[subscription_update][enabled]": "true",
			"features[subscription_update][default_allowed_updates][0]": "quantity",
			"features[subscription_update][proration_behavior]": "always_invoice",
			"features[subscription_update][schedule_at_period_end][conditions][0][type]":
				"decreasing_item_amount",
			"features[subscription_cancel][enabled]": "true",
			"features[subscription_cancel][mode]": "at_period_end",
			"features[payment_method_update][enabled]": "true",
			"features[invoice_history][enabled]": "true",
			"features[subscription_update][products][0][product]": "prod_sparkle",
			"features[subscription_update][products][0][prices][0]":
				"price_sparkle_month",
			"features[subscription_update][products][0][prices][1]":
				"price_sparkle_year",
			"features[subscription_update][products][0][adjustable_quantity][enabled]":
				"true",
			"features[subscription_update][products][0][adjustable_quantity][minimum]":
				"1",
			"features[subscription_update][products][0][adjustable_quantity][maximum]":
				"4",
			"features[subscription_update][products][2][product]": "prod_radiate",
		});
		expect(
			(fields as Record<string, string>)[
				"features[subscription_update][products][3][product]"
			],
		).toBeUndefined();
	});

	test("a menu without quantities gives null, as does a menu no product of which is published", () => {
		const plain = vibes as Menu;
		expect(portalConfigOf(plain, idsFor(plain))).toBeNull();
		expect(portalFieldsOf(plain, idsFor(plain))).toBeNull();
		expect(portalConfigOf(MENU, { products: {}, prices: {} })).toBeNull();
	});

	test("a tier with one count, or one that is not public, is left out; each tier's own smallest and largest count bound it", () => {
		const menu = clone(MENU);
		const [first, second, third] = menu.tiers;
		if (!first || !second || !third) throw new Error("fixture changed");
		first.quantities = [3];
		second.public = false;
		third.quantities = [2, 5, 8];
		const ids = idsFor(menu);
		const fields = portalConfigOf(menu, ids);
		expect(fields).toEqual(portalFieldsOf(menu, ids));
		expect(fields).toMatchObject({
			"features[subscription_update][products][0][product]": "prod_radiate",
			"features[subscription_update][products][0][adjustable_quantity][minimum]":
				"2",
			"features[subscription_update][products][0][adjustable_quantity][maximum]":
				"8",
		});
		expect(
			(fields as Record<string, string>)[
				"features[subscription_update][products][1][product]"
			],
		).toBeUndefined();
	});

	test("a price not published yet is left out of its tier's prices, without a gap in the list", () => {
		const ids = idsFor(MENU);
		const prices = { ...ids.prices };
		delete prices["t:sparkle:month"];
		const fields = portalConfigOf(MENU, { products: ids.products, prices });
		expect(fields).toEqual(
			portalFieldsOf(MENU, { products: ids.products, prices }),
		);
		expect(fields).toMatchObject({
			"features[subscription_update][products][0][prices][0]":
				"price_sparkle_year",
		});
		expect(
			(fields as Record<string, string>)[
				"features[subscription_update][products][0][prices][1]"
			],
		).toBeUndefined();
	});

	test("a tier whose product is published but none of its prices is left out: Stripe requires prices on every product", () => {
		const ids = idsFor(MENU);
		const prices = Object.fromEntries(
			Object.entries(ids.prices).filter(
				([key]) => !key.startsWith("t:sparkle:"),
			),
		);
		const fields = portalConfigOf(MENU, { products: ids.products, prices });
		const form = fields as Record<string, string>;
		const productIds = Object.entries(form)
			.filter(([key]) => key.endsWith("[product]"))
			.map(([, value]) => value);
		expect(productIds).toEqual(["prod_shine", "prod_radiate"]);
		for (const [key, value] of Object.entries(form))
			if (key.endsWith("[product]")) {
				const prefix = key.slice(0, -"[product]".length);
				expect(form[`${prefix}[prices][0]`]).toBeDefined();
				expect(value).not.toBe("prod_sparkle");
			}
	});

	test("no tier has a published price: null, as when no product is published", () => {
		const ids = idsFor(MENU);
		expect(
			portalConfigOf(MENU, { products: ids.products, prices: {} }),
		).toBeNull();
	});

	test("the inputs are not changed", () => {
		const menu = clone(MENU);
		const ids = idsFor(menu);
		const before = structuredClone({ menu, ids });
		portalConfigOf(menu, ids);
		expect({ menu, ids }).toEqual(before);
	});
});
