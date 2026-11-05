import { describe, expect, test } from "bun:test";
import vibes from "../fixtures/billing/menu/vibes-menu.json";
import {
	checkoutParams,
	lookupKeyOf,
	menuToStripe,
	oneTimeCheckoutParams,
	toStripeForm,
	withPriceIds,
} from "../src/billing/stripe-menu.js";
import type { BillingPolicy, Menu, StripeOp } from "../src/billing/types.js";

type Tier = Menu["tiers"][number];
type Addon = Menu["addons"][number];

const SCHOOL = "0c1d2e3f-aaaa-bbbb-cccc-111122223333";
const clone = <T>(v: T): T => structuredClone(v);
const MENU = vibes as Menu;
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
	cancelCutoffHours: 24,
	noShow: "spend",
	lateCancel: "spend",
};
const MEMBER: BillingPolicy = {
	...POLICY,
	memberCode: { code: "MEMBER15", percentOff: 15 },
};
const publish = (
	menu: Menu,
	previous: Menu | null,
	policy = POLICY,
	previousPolicy?: BillingPolicy | null,
) => menuToStripe({ schoolId: SCHOOL, menu, previous, policy, previousPolicy });
const noKeys = (ops: StripeOp[]) =>
	ops.map(({ idempotencyKey: _k, ...rest }) => rest);
const lk = (priceKey: string, amount: number) =>
	lookupKeyOf(SCHOOL, priceKey, amount, "usd");

describe("lookupKeyOf", () => {
	test("school prefix, price key, amount, currency", () => {
		expect(lookupKeyOf(SCHOOL, "t:sparkle:month", 13000, "usd")).toBe(
			"b4u_0c1d2e3f_t_sparkle_month_13000_usd",
		);
	});
});

describe("menuToStripe", () => {
	test("a gift add-on's price carries the gift kind in its metadata and its key; flipping the kind is a new price", () => {
		const menu = clone(MENU);
		const feature = menu.features[0]?.id as string;
		menu.addons = [
			{
				id: "gift",
				name: "Gift",
				price: { amount: 9000, every: "once" },
				grants: [{ featureId: feature, amount: 1, every: "month" }],
			},
		];
		const plain = noKeys(publish(menu, null)).filter(
			(o) => o.op === "price.create" && o.productKey === "a:gift",
		);
		expect(plain).toEqual([
			expect.objectContaining({
				lookupKey: lk("a:gift:once", 9000),
				metadata: { b4u_school: SCHOOL, b4u_key: "a:gift:once" },
			}),
		]);
		const gifted = clone(menu);
		(gifted.addons[0] as Addon).gift = "sessions";
		const created = noKeys(publish(gifted, null)).filter(
			(o) => o.op === "price.create" && o.productKey === "a:gift",
		);
		expect(created).toEqual([
			expect.objectContaining({
				lookupKey: lk("a:gift:once:gift-sessions", 9000),
				metadata: {
					b4u_school: SCHOOL,
					b4u_key: "a:gift:once:gift-sessions",
					b4u_gift: "sessions",
				},
			}),
		]);
		const flipped = noKeys(publish(gifted, menu)).filter(
			(o) => o.op === "price.create" || o.op === "price.archive",
		);
		expect(flipped.map((o) => o.op)).toEqual(["price.create", "price.archive"]);
		expect(publish(gifted, gifted)).toEqual([]);
		const checkout = checkoutParams({
			schoolId: SCHOOL,
			menu: gifted,
			tierId: gifted.tiers[0]?.id as string,
			interval: gifted.tiers[0]?.prices[0]?.interval as "month",
			addonIds: ["gift"],
			familyId: "fam_1",
			menuVersion: 1,
			returnUrls: { success: "https://x/ok", cancel: "https://x/no" },
			policy: POLICY,
		});
		expect(
			checkout.ok && checkout.params.line_items.map((l) => l.lookupKey),
		).toContain(lk("a:gift:once:gift-sessions", 9000));
	});

	test("first publish of the fixture menu: golden ops", () => {
		const ops = noKeys(publish(MENU, null));
		expect(ops).toEqual([
			{
				op: "product.create",
				key: "t:sparkle",
				name: "Sparkle",
				description: "90-minute deep tissue massage",
				metadata: {
					b4u_school: SCHOOL,
					b4u_key: "t:sparkle",
					b4u_group: "membership",
					b4u_tier: "sparkle",
				},
			},
			{
				op: "product.create",
				key: "t:shine",
				name: "Shine",
				description: "Massage, 30-minute light therapy, energy work",
				metadata: {
					b4u_school: SCHOOL,
					b4u_key: "t:shine",
					b4u_group: "membership",
					b4u_tier: "shine",
				},
			},
			{
				op: "product.create",
				key: "a:light-30",
				name: "Add-on: Light therapy",
				description: "Add-on: Light therapy",
				metadata: {
					b4u_school: SCHOOL,
					b4u_key: "a:light-30",
					b4u_group: "addon",
					b4u_addon: "light-30",
				},
			},
			{
				op: "product.create",
				key: "a:energy-work",
				name: "Add-on: Energy work",
				description: "Add-on: Energy work",
				metadata: {
					b4u_school: SCHOOL,
					b4u_key: "a:energy-work",
					b4u_group: "addon",
					b4u_addon: "energy-work",
				},
			},
			{
				op: "product.create",
				key: "a:workshop-seat",
				name: "Add-on: Workshop seat",
				description: "Add-on: Workshop seat",
				metadata: {
					b4u_school: SCHOOL,
					b4u_key: "a:workshop-seat",
					b4u_group: "addon",
					b4u_addon: "workshop-seat",
				},
			},
			{
				op: "price.create",
				productKey: "t:sparkle",
				lookupKey: "b4u_0c1d2e3f_t_sparkle_month_13000_usd",
				currency: "usd",
				unitAmount: 13000,
				recurring: { interval: "month" },
				metadata: { b4u_school: SCHOOL, b4u_key: "t:sparkle:month" },
			},
			{
				op: "price.create",
				productKey: "t:sparkle",
				lookupKey: "b4u_0c1d2e3f_t_sparkle_year_144000_usd",
				currency: "usd",
				unitAmount: 144000,
				recurring: { interval: "year" },
				metadata: { b4u_school: SCHOOL, b4u_key: "t:sparkle:year" },
			},
			{
				op: "price.create",
				productKey: "t:shine",
				lookupKey: lookupKeyOf(SCHOOL, "t:shine:month", 18000, "usd"),
				currency: "usd",
				unitAmount: 18000,
				recurring: { interval: "month" },
				metadata: { b4u_school: SCHOOL, b4u_key: "t:shine:month" },
			},
			{
				op: "price.create",
				productKey: "t:shine",
				lookupKey: lookupKeyOf(SCHOOL, "t:shine:year", 204000, "usd"),
				currency: "usd",
				unitAmount: 204000,
				recurring: { interval: "year" },
				metadata: { b4u_school: SCHOOL, b4u_key: "t:shine:year" },
			},
			{
				op: "price.create",
				productKey: "a:light-30",
				lookupKey: "b4u_0c1d2e3f_a_light-30_month_2000_usd",
				currency: "usd",
				unitAmount: 2000,
				recurring: { interval: "month" },
				metadata: { b4u_school: SCHOOL, b4u_key: "a:light-30:month" },
			},
			{
				op: "price.create",
				productKey: "a:energy-work",
				lookupKey: "b4u_0c1d2e3f_a_energy-work_year_3000_usd",
				currency: "usd",
				unitAmount: 3000,
				recurring: { interval: "year" },
				metadata: { b4u_school: SCHOOL, b4u_key: "a:energy-work:year" },
			},
			{
				op: "price.create",
				productKey: "a:workshop-seat",
				lookupKey: "b4u_0c1d2e3f_a_workshop-seat_once_2500_usd",
				currency: "usd",
				unitAmount: 2500,
				recurring: null,
				metadata: { b4u_school: SCHOOL, b4u_key: "a:workshop-seat:once" },
			},
		]);
	});

	test("a tier that is not public is never published", () => {
		const ops = publish(MENU, null);
		expect(JSON.stringify(ops)).not.toContain("radiate");
	});

	test("publishing the same menu twice makes no ops", () => {
		expect(publish(MENU, clone(MENU))).toEqual([]);
		expect(publish(MENU, clone(MENU), MEMBER, MEMBER)).toEqual([]);
	});

	test("same input, identical output, and idempotency keys name the school and are all distinct", () => {
		const a = publish(MENU, null, MEMBER);
		expect(a).toEqual(publish(clone(MENU), null, clone(MEMBER)));
		const keys = a.map((o) => o.idempotencyKey);
		expect(new Set(keys).size).toBe(keys.length);
		for (const k of keys) expect(k.startsWith(`atm:${SCHOOL}:`)).toBe(true);
		expect(
			menuToStripe({
				schoolId: "other",
				menu: MENU,
				previous: null,
				policy: MEMBER,
			})[0]?.idempotencyKey,
		).not.toBe(keys[0]);
	});

	test("a price change is a new price, then the old one archived", () => {
		const next = clone(MENU);
		((next.tiers[0] as Tier).prices[0] as Tier["prices"][number]).amount =
			14000;
		const ops = noKeys(publish(next, MENU));
		expect(ops).toEqual([
			{
				op: "price.create",
				productKey: "t:sparkle",
				lookupKey: lk("t:sparkle:month", 14000),
				currency: "usd",
				unitAmount: 14000,
				recurring: { interval: "month" },
				metadata: { b4u_school: SCHOOL, b4u_key: "t:sparkle:month" },
			},
			{ op: "price.archive", lookupKey: lk("t:sparkle:month", 13000) },
		]);
	});

	test("a rename or blurb change updates the product; other changes make nothing", () => {
		const next = clone(MENU);
		(next.tiers[0] as Tier).name = "Sparkle plus";
		(next.tiers[0] as Tier).blurb = "changed";
		(next.tiers[0] as Tier).grants = [];
		expect(noKeys(publish(next, MENU))).toEqual([
			{
				op: "product.update",
				key: "t:sparkle",
				name: "Sparkle plus",
				description: "changed",
				active: true,
			},
		]);
		const grantsOnly = clone(MENU);
		(grantsOnly.tiers[0] as Tier).grants = [];
		expect(publish(grantsOnly, MENU)).toEqual([]);
	});

	test("an add-on that changes interval gets a new price and the old is archived", () => {
		const next = clone(MENU);
		(next.addons[0] as Addon).price.every = "once";
		const ops = noKeys(publish(next, MENU));
		expect(ops.map((o) => o.op)).toEqual(["price.create", "price.archive"]);
		expect(ops[0]).toMatchObject({
			lookupKey: lk("a:light-30:once", 2000),
			recurring: null,
		});
		expect(ops[1]).toEqual({
			op: "price.archive",
			lookupKey: lk("a:light-30:month", 2000),
		});
	});

	test("a currency change re-prices everything", () => {
		const next = clone(MENU);
		next.currency = "cad";
		const ops = publish(next, MENU);
		expect(ops.filter((o) => o.op === "price.create").length).toBe(7);
		expect(ops.filter((o) => o.op === "price.archive").length).toBe(7);
	});

	test("removing a tier archives its prices, then its product", () => {
		const next = clone(MENU);
		next.tiers = next.tiers.filter((t) => t.id !== "shine");
		expect(noKeys(publish(next, MENU))).toEqual([
			{ op: "price.archive", lookupKey: lk("t:shine:month", 18000) },
			{ op: "price.archive", lookupKey: lk("t:shine:year", 204000) },
			{
				op: "product.update",
				key: "t:shine",
				name: "Shine",
				description: "Massage, 30-minute light therapy, energy work",
				active: false,
			},
		]);
	});

	test("making a tier non-public archives it like removing it; making one public creates it", () => {
		const hidden = clone(MENU);
		(hidden.tiers[1] as Tier).public = false;
		const gone = noKeys(publish(hidden, MENU));
		expect(gone.map((o) => o.op)).toEqual([
			"price.archive",
			"price.archive",
			"product.update",
		]);
		const back = noKeys(publish(MENU, hidden));
		expect(back.map((o) => o.op)).toEqual([
			"product.create",
			"price.create",
			"price.create",
		]);
	});

	test("dropping a price interval or an add-on archives just that", () => {
		const next = clone(MENU);
		(next.tiers[0] as Tier).prices = [
			(next.tiers[0] as Tier).prices[0] as Tier["prices"][number],
		];
		next.addons = next.addons.filter((a) => a.id !== "workshop-seat");
		expect(noKeys(publish(next, MENU))).toEqual([
			{ op: "price.archive", lookupKey: lk("t:sparkle:year", 144000) },
			{ op: "price.archive", lookupKey: lk("a:workshop-seat:once", 2500) },
			{
				op: "product.update",
				key: "a:workshop-seat",
				name: "Add-on: Workshop seat",
				description: "Add-on: Workshop seat",
				active: false,
			},
		]);
	});

	test("an item without a usable price is never published", () => {
		const next = clone(MENU);
		next.addons.push({
			id: "hot-towels",
			name: "Hot towels",
			price: { amount: 0, every: "month" },
			grants: [],
		});
		next.tiers.push({
			id: "empty",
			name: "Empty",
			blurb: "",
			public: true,
			prices: [],
			grants: [],
		});
		next.tiers.push({
			id: "free",
			name: "Free",
			blurb: "",
			public: true,
			prices: [{ interval: "month", amount: 0 }],
			grants: [],
		});
		expect(publish(next, MENU)).toEqual([]);
		expect(JSON.stringify(publish(next, null))).not.toMatch(
			/hot-towels|empty|free/,
		);
	});

	test("member code: one coupon on the tier products only, one promotion code", () => {
		const ops = noKeys(publish(MENU, null, MEMBER));
		const tail = ops.slice(-2);
		const couponId = (tail[0] as { id: string }).id;
		expect(couponId).toMatch(/^b4u_0c1d2e3f_member_15_[0-9a-f]{8}$/);
		expect(tail).toEqual([
			{
				op: "coupon.ensure",
				id: couponId,
				percentOff: 15,
				appliesToProductKeys: ["t:shine", "t:sparkle"],
			},
			{
				op: "promotion_code.ensure",
				code: "MEMBER15",
				couponId,
				firstTimeOnly: true,
			},
		]);
		expect(JSON.stringify(tail)).not.toContain("a:");
	});

	test("no member code, no coupon; adding one later adds only the coupon and code", () => {
		expect(publish(MENU, null).some((o) => o.op === "coupon.ensure")).toBe(
			false,
		);
		expect(
			noKeys(publish(MENU, MENU, MEMBER, POLICY)).map((o) => o.op),
		).toEqual(["coupon.ensure", "promotion_code.ensure"]);
	});

	test("a renamed code: old code off, same coupon, new code", () => {
		const renamed: BillingPolicy = {
			...MEMBER,
			memberCode: { code: "FRIEND15", percentOff: 15 },
		};
		const ops = noKeys(publish(MENU, MENU, renamed, MEMBER));
		expect(ops.map((o) => o.op)).toEqual([
			"promotion_code.deactivate",
			"promotion_code.ensure",
		]);
		expect(ops[0]).toEqual({
			op: "promotion_code.deactivate",
			code: "MEMBER15",
		});
		expect(ops[1]).toMatchObject({ code: "FRIEND15", firstTimeOnly: true });
	});

	test("a new rate or tier set: old code off, old coupon archived, new coupon and code", () => {
		const oldId = (
			noKeys(publish(MENU, null, MEMBER)).find(
				(o) => o.op === "coupon.ensure",
			) as { id: string }
		).id;
		const richer: BillingPolicy = {
			...MEMBER,
			memberCode: { code: "MEMBER15", percentOff: 20 },
		};
		const ops = noKeys(publish(MENU, MENU, richer, MEMBER));
		expect(ops.map((o) => o.op)).toEqual([
			"promotion_code.deactivate",
			"coupon.archive",
			"coupon.ensure",
			"promotion_code.ensure",
		]);
		expect(ops[1]).toEqual({ op: "coupon.archive", id: oldId });
		const fewer = clone(MENU);
		fewer.tiers = fewer.tiers.filter((t) => t.id !== "shine");
		const ops2 = publish(fewer, MENU, MEMBER, MEMBER);
		expect(ops2.map((o) => o.op)).toEqual([
			"price.archive",
			"price.archive",
			"product.update",
			"promotion_code.deactivate",
			"coupon.archive",
			"coupon.ensure",
			"promotion_code.ensure",
		]);
	});

	test("dropping the member code turns off the code and archives the coupon", () => {
		const ops = noKeys(publish(MENU, MENU, POLICY, MEMBER));
		expect(ops.map((o) => o.op)).toEqual([
			"promotion_code.deactivate",
			"coupon.archive",
		]);
		expect(ops[0]).toEqual({
			op: "promotion_code.deactivate",
			code: "MEMBER15",
		});
	});

	test("a menu with no tier product gets no coupon", () => {
		const m = clone(MENU);
		m.tiers = [];
		expect(publish(m, null, MEMBER).some((o) => o.op === "coupon.ensure")).toBe(
			false,
		);
	});
});

describe("checkoutParams", () => {
	const base = {
		schoolId: SCHOOL,
		menu: MENU,
		tierId: "sparkle",
		interval: "month" as const,
		familyId: "fam1",
		menuVersion: 7,
		returnUrls: {
			success: "https://b4uni.com/s?joined=1",
			cancel: "https://b4uni.com/s?canceled=1",
		},
		policy: POLICY,
	};

	test("monthly tier", () => {
		expect(checkoutParams(base)).toEqual({
			ok: true,
			params: {
				mode: "subscription",
				client_reference_id: "fam1",
				success_url: "https://b4uni.com/s?joined=1",
				cancel_url: "https://b4uni.com/s?canceled=1",
				line_items: [{ lookupKey: lk("t:sparkle:month", 13000), quantity: 1 }],
				metadata: {
					b4u_school: SCHOOL,
					family_id: "fam1",
					tier_id: "sparkle",
					interval: "month",
					menu_version: "7",
				},
				subscription_data: {
					metadata: {
						b4u_school: SCHOOL,
						family_id: "fam1",
						tier_id: "sparkle",
						interval: "month",
						menu_version: "7",
					},
				},
			},
		});
	});

	test("annual tier with a one-time add-on", () => {
		const r = checkoutParams({
			...base,
			interval: "year",
			addonIds: ["workshop-seat"],
		});
		expect(r.ok && r.params.line_items).toEqual([
			{ lookupKey: lk("t:sparkle:year", 144000), quantity: 1 },
			{ lookupKey: lk("a:workshop-seat:once", 2500), quantity: 1 },
		]);
		expect(r.ok && r.params.metadata.addon_ids).toBe("workshop-seat");
	});

	test("recurring add-on only on the same interval", () => {
		const monthly = checkoutParams({
			...base,
			addonIds: ["light-30", "workshop-seat"],
		});
		expect(monthly.ok && monthly.params.line_items.length).toBe(3);
		expect(
			checkoutParams({ ...base, interval: "year", addonIds: ["light-30"] }),
		).toEqual({
			ok: false,
			reason: "addon_interval_mismatch",
			addonId: "light-30",
		});
		expect(checkoutParams({ ...base, addonIds: ["energy-work"] })).toEqual({
			ok: false,
			reason: "addon_interval_mismatch",
			addonId: "energy-work",
		});
		const yearly = checkoutParams({
			...base,
			interval: "year",
			addonIds: ["energy-work"],
		});
		expect(yearly.ok).toBe(true);
	});

	test("unknown add-on; duplicates are bought once", () => {
		expect(checkoutParams({ ...base, addonIds: ["nope"] })).toEqual({
			ok: false,
			reason: "addon_not_found",
			addonId: "nope",
		});
		const r = checkoutParams({ ...base, addonIds: ["light-30", "light-30"] });
		expect(r.ok && r.params.line_items.length).toBe(2);
	});

	test("missing tier, non-public tier, and an interval the tier does not sell are all tier_not_found", () => {
		expect(checkoutParams({ ...base, tierId: "nope" })).toEqual({
			ok: false,
			reason: "tier_not_found",
		});
		expect(checkoutParams({ ...base, tierId: "radiate" })).toEqual({
			ok: false,
			reason: "tier_not_found",
		});
		expect(
			checkoutParams({ ...base, tierId: "radiate", interval: "year" }),
		).toEqual({ ok: false, reason: "tier_not_found" });
	});

	test("buying for a child puts the profile in the metadata, on the session and the subscription", () => {
		const r = checkoutParams({ ...base, forProfileId: "kid-uuid" });
		expect(r.ok && r.params.metadata.profile_id).toBe("kid-uuid");
		expect(r.ok && r.params.subscription_data.metadata.profile_id).toBe(
			"kid-uuid",
		);
		const own = checkoutParams({ ...base, forProfileId: null });
		expect(own.ok && "profile_id" in own.params.metadata).toBe(false);
	});

	test("promotion codes are allowed only when the school has a member code", () => {
		const none = checkoutParams(base);
		expect(none.ok && "allow_promotion_codes" in none.params).toBe(false);
		const some = checkoutParams({ ...base, policy: MEMBER });
		expect(some.ok && some.params.allow_promotion_codes).toBe(true);
	});

	test("deterministic and does not mutate the menu", () => {
		const before = clone(MENU);
		expect(checkoutParams(base)).toEqual(
			checkoutParams({ ...base, menu: clone(MENU) }),
		);
		expect(MENU).toEqual(before);
	});

	test("lookup keys match the ones menuToStripe publishes", () => {
		const published = new Set(
			publish(MENU, null).flatMap((o) =>
				o.op === "price.create" ? [o.lookupKey] : [],
			),
		);
		const r = checkoutParams({
			...base,
			addonIds: ["light-30", "workshop-seat"],
		});
		for (const l of r.ok ? r.params.line_items : [])
			expect(published.has(l.lookupKey)).toBe(true);
	});
});

describe("withPriceIds / toStripeForm", () => {
	const r = checkoutParams({
		schoolId: SCHOOL,
		menu: MENU,
		tierId: "sparkle",
		interval: "month",
		addonIds: ["light-30"],
		familyId: "fam1",
		menuVersion: 1,
		returnUrls: { success: "s", cancel: "c" },
		policy: MEMBER,
	});
	if (!r.ok) throw new Error("setup");

	test("swaps lookup keys for price ids, or null when one is missing", () => {
		const ids = {
			[lk("t:sparkle:month", 13000)]: "price_1",
			[lk("a:light-30:month", 2000)]: "price_2",
		};
		expect(withPriceIds(r.params, ids)?.line_items).toEqual([
			{ price: "price_1", quantity: 1 },
			{ price: "price_2", quantity: 1 },
		]);
		expect(
			withPriceIds(r.params, { [lk("t:sparkle:month", 13000)]: "price_1" }),
		).toBeNull();
	});

	test("form encoding", () => {
		const priced = withPriceIds(r.params, {
			[lk("t:sparkle:month", 13000)]: "price_1",
			[lk("a:light-30:month", 2000)]: "price_2",
		});
		if (!priced) throw new Error("price ids missing");
		const form = toStripeForm(priced);
		expect(form).toMatchObject({
			mode: "subscription",
			client_reference_id: "fam1",
			"line_items[0][price]": "price_1",
			"line_items[0][quantity]": "1",
			"line_items[1][price]": "price_2",
			"metadata[tier_id]": "sparkle",
			"subscription_data[metadata][tier_id]": "sparkle",
			allow_promotion_codes: "true",
		});
	});
});

describe("oneTimeCheckoutParams", () => {
	const base = {
		schoolId: SCHOOL,
		menu: MENU,
		addonIds: ["workshop-seat"],
		familyId: "fam1",
		menuVersion: 7,
		returnUrls: {
			success: "https://b4uni.com/ok",
			cancel: "https://b4uni.com/no",
		},
	};
	const workshopKey = lk("a:workshop-seat:once", 2500);

	test("payment mode with invoice_creation on, and our metadata on the invoice itself", () => {
		const metadata = {
			b4u_school: SCHOOL,
			family_id: "fam1",
			menu_version: "7",
			addon_ids: "workshop-seat",
		};
		expect(oneTimeCheckoutParams(base)).toEqual({
			ok: true,
			params: {
				mode: "payment",
				client_reference_id: "fam1",
				success_url: "https://b4uni.com/ok",
				cancel_url: "https://b4uni.com/no",
				line_items: [{ lookupKey: workshopKey, quantity: 1 }],
				metadata,
				invoice_creation: { enabled: true, invoice_data: { metadata } },
			},
		});
	});

	test("the lookup key is the one menuToStripe publishes", () => {
		const published = publish(MENU, null).flatMap((op) =>
			op.op === "price.create" ? [op.lookupKey] : [],
		);
		expect(published).toContain(workshopKey);
	});

	test("a profile, an invoice description and footer, and repeated add-ons", () => {
		const result = oneTimeCheckoutParams({
			...base,
			addonIds: ["workshop-seat", "workshop-seat"],
			forProfileId: "kid-uuid",
			invoice: { description: "Workshop seat", footer: "Thank you" },
		});
		if (!result.ok) throw new Error("setup");
		expect(result.params.line_items).toHaveLength(1);
		expect(result.params.metadata.profile_id).toBe("kid-uuid");
		expect(result.params.invoice_creation.invoice_data).toMatchObject({
			description: "Workshop seat",
			footer: "Thank you",
			metadata: { profile_id: "kid-uuid", family_id: "fam1" },
		});
	});

	test("refuses no add-ons, an unknown add-on and one that repeats", () => {
		expect(oneTimeCheckoutParams({ ...base, addonIds: [] })).toEqual({
			ok: false,
			reason: "no_addons",
		});
		expect(oneTimeCheckoutParams({ ...base, addonIds: ["nope"] })).toEqual({
			ok: false,
			reason: "addon_not_found",
			addonId: "nope",
		});
		expect(
			oneTimeCheckoutParams({
				...base,
				addonIds: ["workshop-seat", "light-30"],
			}),
		).toEqual({
			ok: false,
			reason: "addon_not_one_time",
			addonId: "light-30",
		});
	});

	test("a membership's checkout is unchanged: still subscription mode, no invoice_creation", () => {
		const result = checkoutParams({
			schoolId: SCHOOL,
			menu: MENU,
			tierId: "sparkle",
			interval: "month",
			addonIds: ["workshop-seat"],
			familyId: "fam1",
			menuVersion: 7,
			returnUrls: base.returnUrls,
			policy: POLICY,
		});
		if (!result.ok) throw new Error("setup");
		expect(result.params.mode).toBe("subscription");
		expect("invoice_creation" in result.params).toBe(false);
	});

	test("withPriceIds and toStripeForm give Stripe's form fields", () => {
		const result = oneTimeCheckoutParams({
			...base,
			invoice: { footer: "Thank you" },
		});
		if (!result.ok) throw new Error("setup");
		expect(withPriceIds(result.params, {})).toBeNull();
		const priced = withPriceIds(result.params, { [workshopKey]: "price_w" });
		if (!priced) throw new Error("price ids missing");
		expect(priced.line_items).toEqual([{ price: "price_w", quantity: 1 }]);
		expect(toStripeForm(priced)).toEqual({
			mode: "payment",
			client_reference_id: "fam1",
			success_url: "https://b4uni.com/ok",
			cancel_url: "https://b4uni.com/no",
			"line_items[0][price]": "price_w",
			"line_items[0][quantity]": "1",
			"metadata[b4u_school]": SCHOOL,
			"metadata[family_id]": "fam1",
			"metadata[menu_version]": "7",
			"metadata[addon_ids]": "workshop-seat",
			"invoice_creation[enabled]": "true",
			"invoice_creation[invoice_data][metadata][b4u_school]": SCHOOL,
			"invoice_creation[invoice_data][metadata][family_id]": "fam1",
			"invoice_creation[invoice_data][metadata][menu_version]": "7",
			"invoice_creation[invoice_data][metadata][addon_ids]": "workshop-seat",
			"invoice_creation[invoice_data][footer]": "Thank you",
		});
	});
});
