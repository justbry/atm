/**
 * The membership and `tierIds` limit the credits of the tier and recurring add-ons only. Credits the holder was given or
 * bought once (a pack, a session gift, a redeemed gift code) still count when the membership has ended.
 */
import { expect, test } from "bun:test";
import { holdBooking, quoteBooking } from "../src/billing/bookable.js";
import {
	createSessionGiftCode,
	redeemSessionGiftCode,
} from "../src/billing/codes.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	applyRowChanges,
	type BillingRow,
	grantsFromRows,
} from "../src/billing/rows.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type { Billing, GrantsState } from "../src/billing/types.js";
import { deterministicUlid } from "../src/ledger/ids.js";
import {
	catalogRows,
	DAY,
	HOLDER,
	member,
	menu,
	PAID_AT,
} from "./billing-bookable-world.js";
import { subscriptionEvent } from "./stripe-events.js";

const ENDED_AT = PAID_AT + 10 * DAY;
const NOW = PAID_AT + 60 * DAY;

const included: Billing = { kind: "included", featureId: "visit", credits: 1 };
const includedOrPrice: Billing = {
	kind: "included_or_price",
	featureId: "visit",
	credits: 1,
	amount: 4000,
	currency: "usd",
};

const quote = (billing: Billing, grants: GrantsState, available?: number) =>
	quoteBooking({
		billing,
		menu,
		policy: DEFAULT_POLICY,
		grants,
		available,
		now: NOW,
	});

/** A sparkle-2 member (with `invoices`) whose subscription Stripe then ended. */
const exMember = (invoices: string[] = ["inv-create-s2"]) => {
	const booked = member({ invoices });
	const key = lookupKeyOf(
		"sch_vol",
		tierPriceKey("sparkle-2", "month"),
		26000,
		"usd",
	);
	const ended = subscriptionEvent({
		type: "customer.subscription.deleted",
		eventId: "evt_sub_del",
		subscriptionId: "sub_1",
		status: "canceled",
		items: [{ lookupKey: key, interval: "month" }],
		periodStart: PAID_AT,
		periodEnd: PAID_AT + 31 * DAY,
		at: ENDED_AT,
		metadata: { b4u_school: "sch_vol", family_id: "fam_8k2" },
	});
	const result = handleStripeEvent({
		event: ended,
		eventId: deterministicUlid({ timeMs: ENDED_AT, revision: 0, seed: "end" }),
		menu,
		menuVersion: 1,
		policy: DEFAULT_POLICY,
		policyVersion: 1,
		rows: booked.rows,
		revision: booked.revision,
		catalog: catalogRows,
		now: ENDED_AT,
		priceIds: { [key]: `price_${key}` },
	});
	if (result.refused) throw new Error(result.refused.message);
	return {
		booked,
		...applyRowChanges({
			rows: booked.rows,
			revision: booked.revision,
			changes: result.rowChanges as never,
		}),
	};
};

const redeemGift = (rows: BillingRow[], revision: number) => {
	const code = createSessionGiftCode({
		id: "gc1",
		code: "GIFT-ABCDEF",
		featureId: "visit",
		credits: 4,
		createdAt: NOW - DAY,
		redeemBy: NOW + DAY,
		menu,
		policy: DEFAULT_POLICY,
	});
	if (!code.ok) throw new Error(code.reason);
	const redeemed = redeemSessionGiftCode({
		code: code.code,
		entered: "GIFT-ABCDEF",
		holder: { orgId: "sch_vol", customerId: HOLDER },
		menu,
		menuVersion: 1,
		policy: DEFAULT_POLICY,
		policyVersion: 1,
		rows,
		revision,
		catalog: catalogRows,
		now: NOW - DAY,
	});
	if (!redeemed.ok) throw new Error(redeemed.reason);
	return applyRowChanges({
		rows,
		revision,
		changes: redeemed.rowChanges as never,
	});
};

test("an ex-member with nothing but the tier's credits is refused as before", () => {
	const { rows } = exMember();
	const grants = grantsFromRows(rows);
	expect(quote(included, grants)).toMatchObject({
		ok: false,
		reason: "membership_not_active",
	});
	expect(quote(includedOrPrice, grants)).toMatchObject({
		ok: true,
		cost: { kind: "price", amount: 4000 },
		via: "price",
	});
});

test("an ex-member who redeemed a session gift code books with it", () => {
	const ended = exMember();
	const { rows, revision } = redeemGift(ended.rows, ended.revision);
	const grants = grantsFromRows(rows);
	expect(quote(included, grants, 4)).toEqual({
		ok: true,
		cost: { kind: "credits", featureId: "visit", credits: 1 },
	});
	expect(quote(includedOrPrice, grants, 4)).toMatchObject({
		ok: true,
		cost: { kind: "credits" },
		via: "included",
	});
	const held = holdBooking({
		...ended.booked.ctx(NOW),
		rows,
		revision,
		bookingId: "b1",
		featureId: "visit",
		credits: 1,
		startsAt: NOW + 5 * DAY,
		expiresAt: NOW + 6 * DAY,
	});
	expect(held.ok).toBe(true);
});

test("an ex-member who bought a pack books with it; available still decides", () => {
	const { rows } = exMember(["inv-create-s2-pack"]);
	const grants = grantsFromRows(rows);
	expect(quote(included, grants)).toMatchObject({
		ok: true,
		cost: { kind: "credits" },
	});
	expect(quote(included, grants, 0)).toMatchObject({
		ok: false,
		reason: "insufficient_credits",
	});
	expect(quote(includedOrPrice, grants, 0)).toMatchObject({
		cost: { kind: "price" },
		via: "price",
	});
});

test("tierIds limits the tier's credits only: a member of another tier books with a pack", () => {
	const booked = member({ invoices: ["inv-create-s2-pack"] });
	const grants = booked.grants;
	const forOtherTier: Billing = { ...included, tierIds: ["sparkle-4"] };
	expect(quote(forOtherTier, grants)).toMatchObject({
		ok: true,
		cost: { kind: "credits" },
	});
	const withoutPack = member().grants;
	expect(quote(forOtherTier, withoutPack)).toMatchObject({
		ok: false,
		reason: "tier_not_included",
	});
});

test("a refunded pack no longer counts for an ex-member", () => {
	const { rows } = exMember(["inv-create-s2-pack"]);
	const grants = grantsFromRows(rows);
	const refunded: GrantsState = {
		...grants,
		invoices: Object.fromEntries(
			Object.entries(grants.invoices).map(([id, record]) => [
				id,
				{ ...record, removed: true },
			]),
		),
	};
	expect(quote(included, refunded)).toMatchObject({
		ok: false,
		reason: "membership_not_active",
	});
});
