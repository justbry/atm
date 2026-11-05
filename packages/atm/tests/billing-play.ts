/** A seeded random history of one family through `handleStripeEvent` (see billing-properties.test.ts), shared with the tests of `simulate`. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRng } from "../fixtures/rng.js";
import { addUtcMonths } from "../src/billing/grants.js";
import {
	addonPriceKey,
	lookupKeyOf,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import type { Store } from "./billing-store.js";
import {
	chargeRefunded,
	disputeEvent,
	type EventLine,
	invoicePaid,
	subscriptionDeleted,
} from "./stripe-events.js";

export const SCHOOL = "sch_vol";
export const FAMILY = "fam_prop";
export const HOUR = 3_600_000;
export const menu = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../fixtures/billing/grants/menu.json"),
		"utf8",
	),
) as Menu;
const TIERS = ["sparkle-1", "sparkle-2", "sparkle-4"] as const;
const metadata = { b4u_school: SCHOOL, family_id: FAMILY };

const tierPrice = (tierId: string) =>
	menu.tiers
		.find((t) => t.id === tierId)
		?.prices.find((p) => p.interval === "month")?.amount as number;
const tierLine = (
	tierId: string,
	over: Partial<EventLine> = {},
): EventLine => ({
	lookupKey: lookupKeyOf(
		SCHOOL,
		tierPriceKey(tierId, "month"),
		tierPrice(tierId),
		menu.currency,
	),
	amount: tierPrice(tierId),
	interval: "month",
	...over,
});
const giftLine = (addonId: string): EventLine => {
	const addon = menu.addons.find(
		(a) => a.id === addonId,
	) as Menu["addons"][number];
	return {
		lookupKey: lookupKeyOf(
			SCHOOL,
			addonPriceKey(addon.id, addon.price.every, addon.gift),
			addon.price.amount,
			menu.currency,
		),
		amount: addon.price.amount,
	};
};

type Sub = {
	id: string;
	tier: (typeof TIERS)[number];
	pending: (typeof TIERS)[number] | null;
	start: number;
	end: number;
	ended: boolean;
};
type Paid = { id: string; amount: number };

/** A random but valid history of one family, applied to `store`; returns every raw event it sent. */
export const play = ({
	seed,
	steps,
	store,
}: {
	seed: number;
	steps: number;
	store: Store;
}) => {
	const rng = makeRng(`prop-${seed}`);
	const sent: { event: unknown; at: number }[] = [];
	const check = (violations: string[]) => {
		for (const r of store.rows) {
			if (r.table === "customerEntitlements" && (r.data.balance as number) < 0)
				violations.push(`${r.id} balance ${String(r.data.balance)}`);
			if (r.table === "rollovers" && (r.data.balance as number) < 0)
				violations.push(`${r.id} balance ${String(r.data.balance)}`);
		}
	};
	const violations: string[] = [];
	let t = Date.UTC(2026, 0, 3, 15, rng.int(0, 59), rng.int(0, 59));
	let sub = null as Sub | null;
	let serial = 0;
	const invoices: Paid[] = [];
	/** Refunded so far per invoice (cents). */
	const refunded = new Map<string, number>();
	const send = (event: unknown, at: number) => {
		sent.push({ event, at });
		const result = store.handle(event, at);
		if (result.refused)
			throw new Error(
				`seed ${seed}: refused ${result.refused.reason}: ${result.refused.message}`,
			);
		check(violations);
		return result;
	};
	const invoice = (over: {
		reason:
			| "subscription_create"
			| "subscription_cycle"
			| "subscription_update"
			| "manual";
		subscriptionId: string | null;
		start: number;
		end: number;
		lines: EventLine[];
		at: number;
	}) => {
		serial += 1;
		const id = `in_${serial}`;
		const amount = over.lines.reduce((n, l) => n + l.amount, 0);
		send(
			invoicePaid({
				eventId: `evt_${id}`,
				invoiceId: id,
				at: over.at,
				subscriptionId: over.subscriptionId,
				reason: over.reason,
				periodStart: over.start,
				periodEnd: over.end,
				lines: over.lines,
				metadata,
			}),
			over.at,
		);
		invoices.push({ id, amount });
	};

	for (let step = 0; step < steps; step++) {
		t += rng.int(1, 120) * HOUR;
		const active: Sub | null = sub && !sub.ended ? sub : null;
		const op = rng.pick([
			"pay",
			"renew",
			"renew",
			"renew",
			"upgrade",
			"downgrade",
			"refund",
			"refund",
			"dispute",
			"cancel",
			"gift",
			"spend",
			"spend",
			"late",
		] as const);

		if (op === "pay" && sub === null) {
			const tier = rng.pick(TIERS);
			sub = {
				id: "sub_1",
				tier,
				pending: null,
				start: t,
				end: addUtcMonths(t, 1),
				ended: false,
			};
			invoice({
				reason: "subscription_create",
				subscriptionId: sub.id,
				start: sub.start,
				end: sub.end,
				lines: [tierLine(tier)],
				at: t,
			});
		} else if (op === "renew" && active) {
			t = Math.max(t, active.end) + rng.int(0, 3) * HOUR;
			const tier = active.pending ?? active.tier;
			const start = active.end;
			const next: Sub = {
				...active,
				tier,
				pending: null,
				start,
				end: addUtcMonths(start, 1),
			};
			sub = next;
			invoice({
				reason: "subscription_cycle",
				subscriptionId: next.id,
				start,
				end: next.end,
				lines: [tierLine(tier)],
				at: t,
			});
		} else if (
			op === "upgrade" &&
			active &&
			active.tier !== "sparkle-4" &&
			t < active.end
		) {
			const to = TIERS[TIERS.indexOf(active.tier) + 1] as Sub["tier"];
			const left = active.end - t;
			const span = active.end - active.start;
			const credit = -Math.floor((tierPrice(active.tier) * left) / span);
			const charge = Math.floor((tierPrice(to) * left) / span);
			sub = { ...active, tier: to, pending: null };
			invoice({
				reason: "subscription_update",
				subscriptionId: active.id,
				start: t,
				end: active.end,
				lines: [
					tierLine(active.tier, { amount: credit, proration: true }),
					tierLine(to, { amount: charge, proration: true }),
				],
				at: t,
			});
		} else if (op === "downgrade" && active && active.tier !== "sparkle-1") {
			sub = {
				...active,
				pending: TIERS[TIERS.indexOf(active.tier) - 1] as Sub["tier"],
			};
		} else if (op === "refund" && invoices.length > 0) {
			const paid = rng.pick(invoices);
			// A charge's refunds add up: Stripe's amount_refunded is the total so far, and the refund that brings it to the
			// charge's amount is the full one.
			const left = paid.amount - (refunded.get(paid.id) ?? 0);
			if (left > 0) {
				serial += 1;
				const amount =
					rng.next() < 0.6 ? left : Math.max(1, Math.floor(left / 2));
				const total = (refunded.get(paid.id) ?? 0) + amount;
				refunded.set(paid.id, total);
				send(
					chargeRefunded({
						eventId: `evt_re_${serial}`,
						refundId: `re_${serial}`,
						chargeId: `ch_${paid.id}`,
						invoiceId: paid.id,
						amount,
						chargeAmount: paid.amount,
						refundedTotal: total,
						at: t,
					}),
					t,
				);
			}
		} else if (op === "dispute" && invoices.length > 0) {
			const paid = rng.pick(invoices);
			serial += 1;
			const kind = rng.pick(["open", "won", "lost"] as const);
			send(
				disputeEvent({
					type:
						kind === "open"
							? "charge.dispute.created"
							: "charge.dispute.closed",
					eventId: `evt_dp_${serial}`,
					disputeId: `dp_${serial}`,
					chargeId: `ch_${paid.id}`,
					invoiceId: paid.id,
					status: kind === "open" ? "needs_response" : kind,
					at: t,
				}),
				t,
			);
		} else if (op === "cancel" && active) {
			sub = { ...active, ended: true };
			serial += 1;
			send(
				subscriptionDeleted({
					eventId: `evt_sd_${serial}`,
					subscriptionId: active.id,
					tierId: active.tier,
					interval: "month",
					periodStart: active.start,
					periodEnd: active.end,
					at: t,
				}),
				t,
			);
		} else if (op === "gift") {
			invoice({
				reason: "manual",
				subscriptionId: null,
				start: t,
				end: t,
				lines: [giftLine(rng.pick(["gift-visit", "gift-dollars"]))],
				at: t,
			});
		} else if (op === "spend") {
			const avail = store.avail(t);
			if (avail > 0) {
				store.spend(rng.int(1, avail), t);
				check(violations);
			}
		} else if (op === "late" && sub?.ended) {
			// a renewal still paid after the subscription ended
			const start = sub.end;
			invoice({
				reason: "subscription_cycle",
				subscriptionId: sub.id,
				start,
				end: addUtcMonths(start, 1),
				lines: [tierLine(sub.tier)],
				at: Math.max(t, start),
			});
			t = Math.max(t, start);
		}
	}
	return { sent, violations };
};
