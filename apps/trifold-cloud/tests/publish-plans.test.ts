import { describe, expect, test } from "bun:test";
import {
	type PublishedPlans,
	priceFormOf,
	publishPlans,
	type StripeCall,
} from "../scripts/publish-plans";
import { PUBLISHED } from "../src/billing/plans";

/** A test-mode Stripe in memory: products searched by metadata, prices listed by lookup key. */
const fakeStripe = (livemode = false) => {
	const products: Record<string, unknown>[] = [];
	const prices: Record<string, unknown>[] = [];
	const portals: Record<string, unknown>[] = [];
	const writes: string[] = [];
	const call: StripeCall = async (method, path, params) => {
		const field = (name: string) =>
			params.find(([key]) => key === name)?.[1] as string;
		const metadata = Object.fromEntries(
			params
				.filter(([key]) => key.startsWith("metadata["))
				.map(([key, value]) => [key.slice(9, -1), value]),
		);
		if (method === "GET" && path === "/v1/products/search") {
			const query = field("query");
			return {
				data: products.filter((product) =>
					query.includes(
						`'${(product.metadata as Record<string, string>).b4u_key}' AND metadata['b4u_school']:'${(product.metadata as Record<string, string>).b4u_school}'`,
					),
				),
			};
		}
		if (method === "GET" && path === "/v1/prices")
			return {
				data: prices.filter(
					(price) => price.lookup_key === field("lookup_keys[]"),
				),
			};
		if (method === "GET" && path === "/v1/billing_portal/configurations")
			return { data: portals };
		writes.push(`${method} ${path}`);
		if (path.startsWith("/v1/billing_portal/configurations")) {
			const form = Object.fromEntries(params);
			const existing = portals.find((portal) => path.endsWith(`/${portal.id}`));
			if (existing) {
				Object.assign(existing, { form, metadata });
				return existing;
			}
			const portal = {
				id: `bpc_${portals.length + 1}`,
				livemode,
				active: true,
				form,
				metadata,
			};
			portals.push(portal);
			return portal;
		}
		if (path === "/v1/products") {
			const product = {
				id: `prod_${products.length + 1}`,
				livemode,
				metadata,
			};
			products.push(product);
			return product;
		}
		if (path === "/v1/prices") {
			const price = {
				id: `price_${prices.length + 1}`,
				livemode,
				active: true,
				lookup_key: field("lookup_key"),
				product: field("product"),
				unit_amount: Number(field("unit_amount")),
				recurring: { interval: field("recurring[interval]") },
			};
			prices.push(price);
			return price;
		}
		throw new Error(`unexpected ${method} ${path}`);
	};
	return { call, products, prices, portals, writes };
};

describe("publishing Trifold's menus to Stripe test mode", () => {
	test("the first publish makes two products and four prices per school; a rerun makes nothing and writes the same file", async () => {
		const stripe = fakeStripe();
		const first = await publishPlans({
			stripe: stripe.call,
			previous: null,
			stripeAccount: "acct_test",
		});
		expect(stripe.products.length).toBe(4);
		expect(stripe.prices.length).toBe(8);
		expect(Object.keys(first.schools)).toEqual(["tf-std", "tf-np"]);
		expect(first.schools["tf-std"]?.products).toEqual({
			"t:audited": expect.stringMatching(/^prod_/),
			"t:starter": expect.stringMatching(/^prod_/),
		});
		expect(Object.keys(first.schools["tf-std"]?.priceIds ?? {})).toEqual([
			"b4u_tf-std_t_starter_month_2900_usd",
			"b4u_tf-std_t_starter_year_29000_usd",
			"b4u_tf-std_t_audited_month_14900_usd",
			"b4u_tf-std_t_audited_year_149000_usd",
		]);
		// No Pro (a draft) and no coupon (no member code).
		expect(JSON.stringify(stripe.prices)).not.toContain("_pro_");
		// One portal per school: invoices, the payment method, cancel at the period end; no tier or quantity change
		// (`portalConfigOf` is null: no Trifold tier is sold in quantities).
		expect(stripe.portals.length).toBe(2);
		expect(first.schools["tf-std"]?.portalConfiguration).toBe("bpc_1");
		expect(first.schools["tf-np"]?.portalConfiguration).toBe("bpc_2");
		const form = stripe.portals[0]?.form as Record<string, string>;
		expect(form).toMatchObject({
			"features[invoice_history][enabled]": "true",
			"features[payment_method_update][enabled]": "true",
			"features[subscription_cancel][enabled]": "true",
			"features[subscription_cancel][mode]": "at_period_end",
			"metadata[b4u_key]": "portal",
			"metadata[b4u_school]": "tf-std",
		});
		expect(Object.keys(form).join()).not.toContain("subscription_update");
		const writes = stripe.writes.length;

		const again = await publishPlans({
			stripe: stripe.call,
			previous: first,
			stripeAccount: "acct_test",
		});
		expect(stripe.writes.length).toBe(writes);
		expect(again).toEqual(first);

		// Lost the file: everything is found again by b4u_key and lookup key, nothing is made twice.
		const lost = await publishPlans({
			stripe: stripe.call,
			previous: null,
			stripeAccount: "acct_test",
		});
		expect(stripe.writes.length).toBe(writes);
		expect(lost).toEqual(first);

		// A portal whose version is not the form's is updated in place, not made again.
		(stripe.portals[0]?.metadata as Record<string, string>).b4u_portal_version =
			"old";
		const updated = await publishPlans({
			stripe: stripe.call,
			previous: first,
			stripeAccount: "acct_test",
		});
		expect(stripe.writes.slice(writes)).toEqual([
			"POST /v1/billing_portal/configurations/bpc_1",
		]);
		expect(updated).toEqual(first);
	});

	test("a live-mode answer stops the publish", async () => {
		const stripe = fakeStripe(true);
		await expect(
			publishPlans({
				stripe: stripe.call,
				previous: null,
				stripeAccount: "acct_test",
			}),
		).rejects.toThrow("LIVE-mode");
	});

	test("the committed file is a test-mode publish of the current catalog", async () => {
		expect(PUBLISHED.livemode).toBe(false);
		const stripe = fakeStripe();
		const fresh: PublishedPlans = await publishPlans({
			stripe: stripe.call,
			previous: null,
			stripeAccount: PUBLISHED.stripeAccount,
		});
		for (const [schoolId, school] of Object.entries(fresh.schools)) {
			const committed = PUBLISHED.schools[schoolId];
			expect(committed?.menuVersion).toBe(school.menuVersion);
			expect(committed?.menu).toEqual(school.menu);
			expect(committed?.policy).toEqual(school.policy);
			expect(Object.keys(committed?.priceIds ?? {})).toEqual(
				Object.keys(school.priceIds),
			);
			expect(committed?.portalConfiguration).toMatch(/^bpc_/);
		}
	});
});

describe("priceFormOf", () => {
	const base = {
		op: "price.create" as const,
		productKey: "a:go-learn",
		lookupKey: "lk",
		currency: "usd",
		recurring: null,
		metadata: { b4u_key: "a:go-learn:once" },
		idempotencyKey: "k",
	};

	test("a fixed price sends unit_amount", () => {
		expect(priceFormOf({ ...base, unitAmount: 500 }, "prod_1")).toContainEqual([
			"unit_amount",
			"500",
		]);
	});

	test("a pay-what-you-can price sends custom_unit_amount and no unit_amount", () => {
		const form = priceFormOf(
			{
				...base,
				unitAmount: null,
				customUnitAmount: { minimum: 50, maximum: 50000, preset: 4800 },
			},
			"prod_1",
		);
		expect(form.map(([key]) => key)).not.toContain("unit_amount");
		expect(form).toEqual(
			expect.arrayContaining([
				["custom_unit_amount[enabled]", "true"],
				["custom_unit_amount[minimum]", "50"],
				["custom_unit_amount[maximum]", "50000"],
				["custom_unit_amount[preset]", "4800"],
			]),
		);
	});
});
