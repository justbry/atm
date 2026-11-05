import { describe, expect, test } from "bun:test";
import { subscriptionStatus } from "../src/billing/status.js";
import type { SubscriptionFact } from "../src/billing/types.js";

const fact = (over: Partial<SubscriptionFact>): SubscriptionFact => ({
	source: {
		eventId: "evt_1",
		mapping: "stripe.subscription.v1",
		stripeApiVersion: "2025-01-27.acacia",
	},
	id: "sub_1",
	customerId: "cus_1",
	status: "active",
	items: [
		{ priceId: "price_1", lookupKey: null, interval: "month", quantity: 1 },
	],
	currentPeriodStart: 1_000,
	currentPeriodEnd: 2_000,
	cancelAtPeriodEnd: false,
	at: 1_500,
	metadata: {},
	...over,
});

describe("subscriptionStatus", () => {
	const table: [SubscriptionFact["status"], string, boolean, number | null][] =
		[
			["active", "active", true, 2_000],
			["trialing", "active", true, 2_000],
			["past_due", "past_due", false, 2_000],
			["unpaid", "past_due", false, 2_000],
			["incomplete", "incomplete", false, null],
			["incomplete_expired", "ended", false, null],
			["canceled", "ended", false, null],
			["paused", "inactive", false, null],
		];
	test.each(table)(
		"%s -> %s (active %p, renewsAt %p)",
		(status, expected, active, renewsAt) => {
			expect(subscriptionStatus(fact({ status }))).toEqual({
				status: expected as never,
				renewsAt,
				cancelAtPeriodEnd: false,
				endsAt: null,
				active,
			});
		},
	);

	test("set to cancel at period end: no renewal, an end date", () => {
		expect(subscriptionStatus(fact({ cancelAtPeriodEnd: true }))).toEqual({
			status: "active",
			renewsAt: null,
			cancelAtPeriodEnd: true,
			endsAt: 2_000,
			active: true,
		});
	});

	test("an ended subscription never shows cancel-at-period-end", () => {
		const s = subscriptionStatus(
			fact({ status: "canceled", cancelAtPeriodEnd: true }),
		);
		expect(s).toMatchObject({
			status: "ended",
			cancelAtPeriodEnd: false,
			renewsAt: null,
			endsAt: null,
			active: false,
		});
	});

	test("is deterministic", () => {
		const f = fact({ status: "trialing" });
		expect(subscriptionStatus(f)).toEqual(subscriptionStatus({ ...f }));
	});
});
