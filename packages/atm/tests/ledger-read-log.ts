/** A small log built by hand for the read-side tests: one family, one plan, two bookings, one refunded visit. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import type { AtmCatalogRow, AtmEvent } from "../src/types.js";
import { createStore } from "./billing-store.js";
import { invoicePaid } from "./stripe-events.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const SCHOOL = "sch_hand";
export const FAMILY = "fam_hand";
export const HOLDER = `family:${FAMILY}`;
export const PLAN = "sparkle-2@v1";
export const T0 = Date.parse("2026-01-15T18:00:00Z");
const PERIOD = 30 * DAY;

export const menu = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../fixtures/billing/grants/menu.json"),
		"utf8",
	),
) as Menu;
export const catalog: AtmCatalogRow[] = menuCatalogRows({
	menu,
	school: SCHOOL,
});

export type HandBuiltLog = {
	events: AtmEvent[];
	/** The instants of the bookings and the refund, for choosing an `asOf` between them. */
	at: {
		paid: number;
		firstSpent: number;
		secondSpent: number;
		refunded: number;
	};
};

/** A plan payment (grants the tier's visits), two bookings (a hold and a spend each), then one visit refunded. */
export const handBuiltLog = (): HandBuiltLog => {
	const store = createStore({ menu, school: SCHOOL, family: FAMILY });
	const price = menu.tiers
		.find((tier) => tier.id === "sparkle-2")
		?.prices.find((entry) => entry.interval === "month")?.amount as number;
	const paidAt = T0 + 10_000;
	store.handle(
		invoicePaid({
			eventId: "evt_in_hand",
			invoiceId: "in_hand",
			at: paidAt,
			subscriptionId: "sub_hand",
			reason: "subscription_create",
			periodStart: T0,
			periodEnd: T0 + PERIOD,
			lines: [
				{
					lookupKey: lookupKeyOf(
						SCHOOL,
						tierPriceKey("sparkle-2", "month"),
						price,
						menu.currency,
					),
					amount: price,
					interval: "month",
				},
			],
			metadata: { b4u_school: SCHOOL, family_id: FAMILY },
		}),
		paidAt,
	);
	const firstSpent = T0 + 2 * DAY;
	const secondSpent = T0 + 4 * DAY;
	const refunded = T0 + 6 * DAY;
	for (const [holdAt, spendAt] of [
		[firstSpent - HOUR, firstSpent],
		[secondSpent - HOUR, secondSpent],
	] as const)
		if (!store.consume({ feature: "visit", service: "yoga", holdAt, spendAt }))
			throw new Error("the hand-built log has no visit to book");
	store.serviceCommand({
		type: "updateBalance",
		at: refunded,
		fields: {
			featureId: "visit",
			internalFeatureId: "feat_visit",
			addToBalance: 1,
		},
		context: { as: "refunded", service: "yoga", reason: "refund" },
	});
	return {
		events: store.events,
		at: { paid: paidAt, firstSpent, secondSpent, refunded },
	};
};
