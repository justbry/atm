import { describe, expect, test } from "bun:test";
import { quoteBooking, validateBilling } from "../src/billing/bookable.js";
import { EMPTY_GRANTS_STATE } from "../src/billing/grants.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import type {
	Billing,
	GrantsState,
	MembershipRecord,
	QuoteInput,
} from "../src/billing/types.js";
import { menu } from "./billing-bookable-world.js";

const NOW = Date.UTC(2026, 0, 20);

const active: MembershipRecord = {
	subscriptionId: "sub_1",
	status: "active",
	tierId: "sparkle-2",
	interval: "month",
	quantity: 1,
	renewsAt: null,
	cancelAtPeriodEnd: false,
	endsAt: null,
	at: NOW - 1,
};

/** A sparkle-2 member (two visits a month) whose subscription Stripe says is active. */
const memberState: GrantsState = {
	...EMPTY_GRANTS_STATE,
	identity: { orgId: "sch_vol", customerId: "family:fam_8k2" },
	holder: { orgId: "sch_vol", customerId: "family:fam_8k2" },
	tierId: "sparkle-2",
	membership: active,
};

const quote = (
	billing: unknown,
	over: Partial<QuoteInput> = {},
): ReturnType<typeof quoteBooking> =>
	quoteBooking({
		billing: billing as Billing,
		menu,
		policy: DEFAULT_POLICY,
		grants: memberState,
		now: NOW,
		...over,
	});

describe("validateBilling", () => {
	test("each kind passes and comes back as a clean copy", () => {
		const inputs: Billing[] = [
			{ kind: "free" },
			{ kind: "included", featureId: "visit", credits: 1 },
			{
				kind: "included",
				featureId: "visit",
				credits: 2,
				tierIds: ["sparkle-2"],
			},
			{ kind: "price", amount: 4500, currency: "usd" },
			{
				kind: "included_or_price",
				featureId: "visit",
				credits: 1,
				tierIds: ["sparkle-2", "sparkle-4"],
				amount: 9000,
				currency: "usd",
			},
		];
		for (const input of inputs) {
			const result = validateBilling(input, menu);
			expect(result).toEqual({ ok: true, billing: input });
			if (result.ok) expect(result.billing).not.toBe(input);
		}
	});

	test("refuses what is not an object, an unknown kind and an unknown key, by path", () => {
		expect(validateBilling(null, menu)).toMatchObject({
			ok: false,
			problems: ["billing"],
		});
		expect(validateBilling([], menu)).toMatchObject({ problems: ["billing"] });
		expect(validateBilling({ kind: "gratis" }, menu)).toMatchObject({
			problems: ["kind"],
		});
		expect(validateBilling({}, menu)).toMatchObject({ problems: ["kind"] });
		expect(validateBilling({ kind: "free", credits: 1 }, menu)).toMatchObject({
			problems: ["credits"],
		});
		expect(
			validateBilling(
				{ kind: "price", amount: 100, currency: "usd", featureId: "visit" },
				menu,
			),
		).toMatchObject({ problems: ["featureId"] });
	});

	test("credits are a whole number of 1 or more", () => {
		for (const credits of [0, -1, 1.5, "2", null, Number.NaN, undefined]) {
			expect(
				validateBilling(
					{ kind: "included", featureId: "visit", credits },
					menu,
				),
			).toMatchObject({ ok: false, problems: ["credits"] });
		}
	});

	test("the feature must be on the menu", () => {
		expect(
			validateBilling(
				{ kind: "included", featureId: "nope", credits: 1 },
				menu,
			),
		).toMatchObject({ problems: ["featureId"] });
		expect(
			validateBilling({ kind: "included", credits: 1 }, menu),
		).toMatchObject({ problems: ["featureId"] });
	});

	test("the amount is whole cents above 0 and the currency is the menu's", () => {
		for (const amount of [0, -5, 12.5, "100", undefined]) {
			expect(
				validateBilling({ kind: "price", amount, currency: "usd" }, menu),
			).toMatchObject({ ok: false, problems: ["amount"] });
		}
		expect(
			validateBilling({ kind: "price", amount: 100, currency: "eur" }, menu),
		).toMatchObject({ problems: ["currency"] });
		expect(
			validateBilling(
				{ kind: "price", amount: 100_000_000, currency: "usd" },
				menu,
			),
		).toMatchObject({ problems: ["amount"] });
	});

	test("every tier id must exist, once, and the list is not empty", () => {
		const base = { kind: "included", featureId: "visit", credits: 1 };
		expect(
			validateBilling({ ...base, tierIds: ["sparkle-2", "gold"] }, menu),
		).toMatchObject({ problems: ["tierIds.1"] });
		expect(
			validateBilling({ ...base, tierIds: ["sparkle-2", "sparkle-2"] }, menu),
		).toMatchObject({ problems: ["tierIds.1"] });
		expect(validateBilling({ ...base, tierIds: [] }, menu)).toMatchObject({
			problems: ["tierIds"],
		});
		expect(
			validateBilling({ ...base, tierIds: "sparkle-2" }, menu),
		).toMatchObject({
			problems: ["tierIds"],
		});
		expect(validateBilling({ ...base, tierIds: [3] }, menu)).toMatchObject({
			problems: ["tierIds.0"],
		});
	});

	test("lists every problem, each path once, with a message for each", () => {
		const result = validateBilling(
			{
				kind: "included_or_price",
				featureId: "nope",
				credits: 0,
				amount: 0,
				currency: "eur",
				extra: true,
			},
			menu,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.problems.sort()).toEqual([
			"amount",
			"credits",
			"currency",
			"extra",
			"featureId",
		]);
		expect(result.messages).toHaveLength(5);
	});
});

describe("quoteBooking", () => {
	test("free is free for anyone, even with no subject", () => {
		expect(quote({ kind: "free" })).toEqual({
			ok: true,
			cost: { kind: "free" },
		});
		expect(quote({ kind: "free" }, { grants: EMPTY_GRANTS_STATE })).toEqual({
			ok: true,
			cost: { kind: "free" },
		});
	});

	test("included is credits for an active member of a tier that has the feature", () => {
		expect(quote({ kind: "included", featureId: "visit", credits: 2 })).toEqual(
			{
				ok: true,
				cost: { kind: "credits", featureId: "visit", credits: 2 },
			},
		);
	});

	test("included refuses a holder with no subject, a lapsed membership and a plan without the feature", () => {
		const item = { kind: "included", featureId: "visit", credits: 1 };
		expect(quote(item, { grants: EMPTY_GRANTS_STATE })).toMatchObject({
			ok: false,
			reason: "not_a_member",
		});
		for (const status of [
			"past_due",
			"incomplete",
			"ended",
			"inactive",
		] as const)
			expect(
				quote(item, {
					grants: { ...memberState, membership: { ...active, status } },
				}),
			).toMatchObject({ ok: false, reason: "membership_not_active" });
		expect(
			quote(item, { grants: { ...memberState, endedAt: NOW - 1 } }),
		).toMatchObject({ reason: "membership_not_active" });
		expect(
			quote({ kind: "included", featureId: "retreat", credits: 1 }),
		).toMatchObject({ reason: "feature_not_in_plan" });
	});

	test("tierIds limits the credits to those tiers", () => {
		const item = {
			kind: "included",
			featureId: "visit",
			credits: 1,
			tierIds: ["sparkle-4"],
		};
		expect(quote(item)).toMatchObject({
			ok: false,
			reason: "tier_not_included",
		});
		expect(quote(item, { tierId: "sparkle-4" })).toMatchObject({
			ok: true,
			cost: { kind: "credits" },
		});
		expect(
			quote(item, {
				grants: { ...memberState, tierId: null, membership: null },
			}),
		).toMatchObject({ reason: "tier_not_included" });
	});

	test("a held add-on, a pack or a gift gives the feature a tier lacks", () => {
		const retreat = { kind: "included", featureId: "retreat", credits: 1 };
		const withAddon: GrantsState = {
			...memberState,
			addonIds: ["retreat-pass"],
		};
		const menuWithAddon = {
			...menu,
			addons: [
				...menu.addons,
				{
					id: "retreat-pass",
					name: "Retreat pass",
					price: { amount: 20000, every: "month" as const },
					grants: [
						{ featureId: "retreat", amount: 1, every: "month" as const },
					],
				},
			],
		};
		expect(
			quote(retreat, { grants: memberState, menu: menuWithAddon }),
		).toMatchObject({
			reason: "feature_not_in_plan",
		});
		expect(
			quote(retreat, { grants: withAddon, menu: menuWithAddon }),
		).toMatchObject({
			ok: true,
		});
		expect(quote(retreat, { tierId: "sparkle-4" })).toMatchObject({ ok: true });
		const withPack: GrantsState = {
			...memberState,
			invoices: {
				in_p: {
					paidAt: NOW,
					removed: false,
					granted: [
						{
							invoiceId: "in_p",
							rowId: "ce_once_in_p_retreat",
							feature: "retreat",
							units: 1,
							epoch: 0,
							rolloverExpiresAt: null,
						},
					],
				},
			},
		};
		expect(quote(retreat, { grants: withPack })).toMatchObject({ ok: true });
		expect(
			quote(retreat, {
				grants: {
					...withPack,
					invoices: {
						in_p: { ...withPack.invoices.in_p, removed: true } as never,
					},
				},
			}),
		).toMatchObject({ reason: "feature_not_in_plan" });
		expect(
			quote(retreat, {
				grants: {
					...memberState,
					redeemed: {
						gift_1: {
							codeId: "gift_1",
							feature: "retreat",
							credits: 1,
							at: NOW,
							rowId: "ce_gift_retreat_gift_1",
							expiresAt: null,
						},
					},
				},
			}),
		).toMatchObject({ ok: true });
	});

	test("available below the cost is insufficient_credits; enough, or not read, is credits", () => {
		const item = { kind: "included", featureId: "visit", credits: 2 };
		expect(quote(item, { available: 1 })).toMatchObject({
			ok: false,
			reason: "insufficient_credits",
		});
		expect(quote(item, { available: 2 })).toMatchObject({ ok: true });
		expect(quote(item, { available: null })).toMatchObject({ ok: true });
		expect(quote(item, { available: 0 })).toMatchObject({
			reason: "insufficient_credits",
		});
	});

	test("price is the price", () => {
		expect(quote({ kind: "price", amount: 4500, currency: "usd" })).toEqual({
			ok: true,
			cost: { kind: "price", amount: 4500, currency: "usd" },
		});
		expect(
			quote(
				{ kind: "price", amount: 4500, currency: "usd" },
				{ grants: EMPTY_GRANTS_STATE },
			),
		).toMatchObject({ ok: true });
	});

	test("a price in another currency than the menu's is currency_mismatch; anything else wrong is invalid_billing", () => {
		expect(
			quote({ kind: "price", amount: 4500, currency: "eur" }),
		).toMatchObject({
			ok: false,
			reason: "currency_mismatch",
		});
		expect(quote({ kind: "price", amount: 0, currency: "eur" })).toMatchObject({
			reason: "invalid_billing",
		});
		expect(
			quote({ kind: "included", featureId: "nope", credits: 1 }),
		).toMatchObject({
			reason: "invalid_billing",
		});
		expect(quote(null)).toMatchObject({ reason: "invalid_billing" });
	});

	test("included_or_price is credits when eligible and affordable, else the price, and says which", () => {
		const item = {
			kind: "included_or_price",
			featureId: "visit",
			credits: 1,
			amount: 9000,
			currency: "usd",
		};
		const credits = {
			kind: "credits",
			featureId: "visit",
			credits: 1,
		} as const;
		const price = { kind: "price", amount: 9000, currency: "usd" } as const;
		expect(quote(item)).toEqual({ ok: true, cost: credits, via: "included" });
		expect(quote(item, { available: 1 })).toMatchObject({ via: "included" });
		expect(quote(item, { available: 0 })).toEqual({
			ok: true,
			cost: price,
			via: "price",
		});
		expect(quote(item, { grants: EMPTY_GRANTS_STATE })).toEqual({
			ok: true,
			cost: price,
			via: "price",
		});
		expect(
			quote(item, {
				grants: {
					...memberState,
					membership: { ...active, status: "past_due" },
				},
			}),
		).toMatchObject({ via: "price" });
	});

	test("included_or_price with tierIds: credits for those tiers, the price for others and non-members", () => {
		const item = {
			kind: "included_or_price",
			featureId: "visit",
			credits: 1,
			tierIds: ["sparkle-2"],
			amount: 9000,
			currency: "usd",
		};
		expect(quote(item)).toMatchObject({ via: "included" });
		expect(quote(item, { tierId: "sparkle-1" })).toMatchObject({
			via: "price",
			cost: { kind: "price" },
		});
		expect(quote(item, { grants: EMPTY_GRANTS_STATE })).toMatchObject({
			via: "price",
		});
	});

	test("a tier given by the caller overrides the stored one", () => {
		const item = { kind: "included", featureId: "retreat", credits: 1 };
		expect(quote(item)).toMatchObject({ reason: "feature_not_in_plan" });
		expect(quote(item, { tierId: "sparkle-4" })).toMatchObject({ ok: true });
		expect(quote(item, { tierId: null })).toMatchObject({
			reason: "feature_not_in_plan",
		});
	});

	test("the same input twice is the same answer, and the input is not changed", () => {
		const input: QuoteInput = {
			billing: { kind: "included", featureId: "visit", credits: 1 },
			menu,
			policy: DEFAULT_POLICY,
			grants: memberState,
			now: NOW,
		};
		const before = JSON.stringify(input);
		expect(quoteBooking(input)).toEqual(quoteBooking(input));
		expect(JSON.stringify(input)).toBe(before);
	});
});
