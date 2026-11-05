/**
 * One customer, two subscriptions of the same school and family, through the real handler: a cycle or update invoice
 * that has a tier line is the holder's only when it is the holder's own subscription's. (Found while reviewing #60:
 * `invoiceToCommands` applied the tier line of ANY subscription of the family.)
 */
import { describe, expect, test } from "bun:test";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import {
	HOUR,
	harness,
	menu,
	paid,
	SCHOOL,
	T0,
	T1,
} from "./handler-harness.js";
import {
	invoicePaid,
	type RawEvent,
	subscriptionDeleted,
} from "./stripe-events.js";

const FAMILY = "fam_8k2";
const metadata = { b4u_school: SCHOOL, family_id: FAMILY };
const T2 = Date.parse("2026-03-15T18:00:00Z");

const tierKey = (tierId: string) => {
	const price = menu.tiers
		.find((t) => t.id === tierId)
		?.prices.find((p) => p.interval === "month");
	return lookupKeyOf(
		SCHOOL,
		tierPriceKey(tierId, "month"),
		price?.amount as number,
		menu.currency,
	);
};

/** The renewal of a subscription, for the tier named. */
const cycle = (subscriptionId: string, tierId: string, id: string): RawEvent =>
	invoicePaid({
		eventId: `evt_${id}`,
		invoiceId: id,
		at: T1,
		subscriptionId,
		reason: "subscription_cycle",
		periodStart: T1,
		periodEnd: T2,
		lines: [{ lookupKey: tierKey(tierId), amount: 52_000, interval: "month" }],
		metadata,
	});

/** A mid-cycle move from one tier to another on a subscription: Stripe's credit line and its charge line. */
const upgrade = (
	subscriptionId: string,
	from: string,
	to: string,
	id: string,
): RawEvent =>
	invoicePaid({
		eventId: `evt_${id}`,
		invoiceId: id,
		at: T0 + 24 * HOUR,
		subscriptionId,
		reason: "subscription_update",
		periodStart: T0 + 24 * HOUR,
		periodEnd: T1,
		lines: [
			{
				lookupKey: tierKey(from),
				amount: -9000,
				interval: "month",
				proration: true,
			},
			{
				lookupKey: tierKey(to),
				amount: 18_000,
				interval: "month",
				proration: true,
			},
		],
		metadata,
	});

/** The whole of what the handler holds for the school: rows, revisions, the outbox, the indexes and the claims. */
const stored = (h: ReturnType<typeof harness>) => ({
	rows: h.db.all(`SELECT * FROM atm_rows ORDER BY table_name, row_id`),
	subjects: h.db.all(`SELECT * FROM atm_subjects`),
	outbox: h.outbox(),
	invoices: h.db.all(`SELECT * FROM atm_invoice_index ORDER BY invoice_id`),
	claims: h.db.all(`SELECT event_id FROM atm_event_claims ORDER BY event_id`),
});

describe("an invoice with a tier line of another subscription than the holder's", () => {
	test("a renewal of the other subscription is refused 422, nothing is written, the claim is released", () => {
		const h = harness();
		expect(h.deliver(paid()).body.outcome).toBe("applied");
		const before = stored(h);

		const response = h.deliver(cycle("sub_2", "sparkle-4", "in_other"), T1);
		expect(response.status).toBe(422);
		expect(response.body).toMatchObject({
			outcome: "refused",
			reason: "tier_on_other_subscription",
			stripeEventId: "evt_in_other",
		});
		// It names the invoice, the subscription it is on and the one that is the holder's.
		expect(response.body.message).toContain("in_other");
		expect(response.body.message).toContain("sub_2");
		expect(response.body.message).toContain("sub_1");
		expect(h.claim("evt_in_other")).toBeNull();
		expect(stored(h)).toEqual(before);
		// Not recorded as decided: the same delivery gets the same answer.
		expect(h.deliver(cycle("sub_2", "sparkle-4", "in_other"), T1).status).toBe(
			422,
		);
	});

	test("an upgrade of the other subscription is refused 422 and moves nobody's tier", () => {
		const h = harness();
		h.deliver(paid());
		const before = stored(h);

		const response = h.deliver(
			upgrade("sub_2", "sparkle-2", "sparkle-4", "in_up2"),
			T0 + 24 * HOUR,
		);
		expect(response.status).toBe(422);
		expect(response.body).toMatchObject({
			outcome: "refused",
			reason: "tier_on_other_subscription",
		});
		expect(h.claim("evt_in_up2")).toBeNull();
		expect(stored(h)).toEqual(before);
	});

	test("the holder's own subscription still renews and upgrades, before and after the refusal", () => {
		const h = harness();
		h.deliver(paid());
		expect(h.deliver(cycle("sub_2", "sparkle-4", "in_other"), T1).status).toBe(
			422,
		);
		const own = h.deliver(cycle("sub_1", "sparkle-2", "in_renew"), T1);
		expect(own.status).toBe(200);
		expect(own.body.outcome).toBe("applied");
		expect(own.body.events).toBeGreaterThan(0);
		const up = h.deliver(
			upgrade("sub_1", "sparkle-2", "sparkle-4", "in_up1"),
			T1 + HOUR,
		);
		expect(up.status).toBe(200);
		expect(up.body.outcome).toBe("applied");
	});

	test("a renewal of another subscription does not refill a holder whose own subscription ended", () => {
		const h = harness();
		h.deliver(paid());
		h.deliver(
			subscriptionDeleted({
				eventId: "evt_sd",
				subscriptionId: "sub_1",
				tierId: "sparkle-2",
				interval: "month",
				periodStart: T0,
				periodEnd: T1,
				at: T0 + 24 * HOUR,
			}),
			T0 + 24 * HOUR,
		);
		const before = stored(h);
		const response = h.deliver(cycle("sub_2", "sparkle-2", "in_other"), T1);
		expect(response.status).toBe(422);
		expect(response.body.reason).toBe("tier_on_other_subscription");
		expect(stored(h)).toEqual(before);
	});

	test("a holder who has no subscription yet takes the first tier invoice it is sent, as before", () => {
		const h = harness();
		const first = h.deliver(cycle("sub_2", "sparkle-4", "in_first"), T1);
		expect(first.status).toBe(200);
		expect(first.body.outcome).toBe("applied");
	});
});
