/**
 * A resolved scenario into an event stream. Families join, renew, use credits, get refunded, are disputed and leave on a
 * schedule drawn from the seed; every Stripe event goes through the real `handleStripeEvent` (one in-memory store per
 * family, as the family service keeps one subject per family) and the school's payouts through a store of their own. The
 * log is what those calls wrote, merged in event order. No clock is read: every instant is computed from `start`.
 */

import { makeRng } from "../../fixtures/rng.js";
import { addUtcMonths } from "../billing/grants.js";
import {
	addonPriceKey,
	lookupKeyOf,
	tierPriceKey,
} from "../billing/stripe-menu.js";
import type { Menu } from "../billing/types.js";
import type { AtmEvent } from "../types.js";
import type { ResolvedScenario } from "./profiles.js";
import {
	BEFORE_UNIVERSITY_MENU,
	FEATURES,
	SCHOOL_ID,
	SERVICES,
} from "./school.js";
import { createStore, type Store } from "./store.js";
import {
	chargeRefunded,
	disputeEvent,
	type EventLine,
	invoicePaid,
	payoutPaid,
	type RawEvent,
	subscriptionDeleted,
} from "./stripe-events.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DISPUTE_FEE = 1500;

export class ScenarioRunError extends Error {}

export type GenerateStats = {
	families: number;
	invoices: number;
	paidInvoices: number;
	refunds: number;
	disputes: number;
	cancellations: number;
	payouts: number;
	bookings: number;
	/** Money lines the books left out, by reason (`non_usd`): the `money.skipped` markers. */
	skipped: Record<string, number>;
};

export type Generated = {
	events: AtmEvent[];
	periods: string[];
	stats: GenerateStats;
	menu: Menu;
};

const weighted = (
	rng: ReturnType<typeof makeRng>,
	weights: Record<string, number>,
	keys: readonly string[],
): string => {
	const entries = keys.map((k) => [k, weights[k] ?? 0] as const);
	const total = entries.reduce((n, [, w]) => n + w, 0);
	let draw = rng.next() * total;
	for (const [key, w] of entries) {
		draw -= w;
		if (draw < 0 && w > 0) return key;
	}
	return (entries.find(([, w]) => w > 0) ?? entries[0])?.[0] as string;
};

export const generateScenario = (scenario: ResolvedScenario): Generated => {
	const p = scenario.params;
	const menu: Menu = { ...BEFORE_UNIVERSITY_MENU, currency: p.currency };
	const [startYear, startMonth] = p.start.split("-").map(Number) as [
		number,
		number,
	];
	const startMs = Date.UTC(startYear, startMonth - 1, 1);
	const endMs = addUtcMonths(startMs, p.months);
	const monthStart = (k: number) => addUtcMonths(startMs, k);

	const ops: { at: number; order: number; run: () => void }[] = [];
	const at = (t: number, run: () => void) => {
		if (t < endMs) ops.push({ at: t, order: ops.length, run });
	};
	const stores = new Map<string, Store>();
	const school = createStore({ menu, school: SCHOOL_ID, family: "school" });
	const stats: GenerateStats = {
		families: 0,
		invoices: 0,
		paidInvoices: 0,
		refunds: 0,
		disputes: 0,
		cancellations: 0,
		payouts: 0,
		bookings: 0,
		skipped: {},
	};
	let cash = 0;

	const send = (
		store: Store,
		event: RawEvent,
		t: number,
		extra: { fee?: number; school?: string } = {},
	) => {
		const before = store.events.length;
		const result = store.handle(event, t, extra);
		if (result.refused)
			throw new ScenarioRunError(
				`${event.type} ${event.id} was refused: ${result.refused.reason}: ${result.refused.message}`,
			);
		for (const e of store.events.slice(before))
			for (const posting of e.postings)
				if (posting.account === "assets:stripe")
					cash += Math.round(Number(posting.amount) * 100);
		return result;
	};
	const metadataOf = (family: string) => ({
		b4u_school: SCHOOL_ID,
		family_id: family,
	});
	const recurring = (every: "month" | "year") =>
		menu.addons.find((a) => a.price.every === every);
	const once = menu.addons.filter((a) => a.price.every === "once");

	const families: { joinAt: number }[] = [];
	for (let i = 0; i < p.members; i++) families.push({ joinAt: -1 });
	for (let k = 1; k < p.months; k++)
		for (let i = 0; i < p.newMembersPerMonth; i++)
			families.push({ joinAt: -k });

	families.forEach((entry, index) => {
		const family = `fam_${String(index).padStart(3, "0")}`;
		const rng = makeRng(`${scenario.seed}/${family}`);
		const cohort = entry.joinAt === -1 ? 0 : -entry.joinAt;
		const joinAt =
			monthStart(cohort) +
			rng.int(0, 26) * DAY +
			rng.int(9, 20) * HOUR +
			rng.int(0, 59) * 60_000;
		const tierId = weighted(
			rng,
			p.tierMix,
			menu.tiers.map((t) => t.id),
		);
		const tier = menu.tiers.find(
			(t) => t.id === tierId,
		) as Menu["tiers"][number];
		const canYear = tier.prices.some((x) => x.interval === "year");
		const interval: "month" | "year" =
			canYear && rng.next() < p.yearlyShare ? "year" : "month";
		const price = tier.prices.find((x) => x.interval === interval)
			?.amount as number;
		const quantities = tier.quantities;
		const quantity = quantities ? (rng.pick(quantities) as number) : undefined;
		const free = rng.next() < p.freeShare;
		const addonChoice =
			rng.next() < p.addonRate
				? rng.pick(
						[recurring(interval), ...once].filter(Boolean) as Menu["addons"],
					)
				: null;
		stats.families += 1;
		const store = createStore({ menu, school: SCHOOL_ID, family });
		stores.set(family, store);

		const tierLine = (): EventLine => ({
			lookupKey: lookupKeyOf(
				SCHOOL_ID,
				tierPriceKey(tierId, interval),
				price,
				menu.currency,
			),
			amount: price * (quantity ?? 1),
			interval,
			...(quantity === undefined ? {} : { quantity }),
		});
		const addonLine = (a: Menu["addons"][number]): EventLine => ({
			lookupKey: lookupKeyOf(
				SCHOOL_ID,
				addonPriceKey(a.id, a.price.every, a.gift),
				a.price.amount,
				menu.currency,
			),
			amount: a.price.amount,
			interval: a.price.every === "once" ? null : a.price.every,
		});

		const sub = `sub_${family}`;
		const sliceCount = interval === "year" ? 12 : 1;
		let periodStart = joinAt;
		let cycle = 0;
		const churn =
			interval === "month" ? p.churnRate : 1 - (1 - p.churnRate) ** 12;
		while (periodStart < endMs) {
			const invoiceId = `in_${family}_${cycle}`;
			const paidAt =
				cycle === 0 ? periodStart : periodStart + rng.int(0, 3) * HOUR;
			const periodEnd = addUtcMonths(periodStart, interval === "year" ? 12 : 1);
			const lines = [tierLine()];
			if (addonChoice && (cycle === 0 || addonChoice.price.every !== "once"))
				lines.push(addonLine(addonChoice));
			const gross = lines.reduce((n, l) => n + l.amount, 0);
			const paid = free ? 0 : gross;
			const fee =
				paid > 0 && p.currency === "usd"
					? Math.min(
							paid,
							Math.round((paid * p.feePercent) / 100) + p.feeFixedCents,
						)
					: 0;
			at(paidAt, () => {
				stats.invoices += 1;
				const event = invoicePaid({
					eventId: `evt_${invoiceId}`,
					invoiceId,
					at: paidAt,
					subscriptionId: sub,
					reason: cycle === 0 ? "subscription_create" : "subscription_cycle",
					periodStart,
					periodEnd,
					lines,
					metadata: metadataOf(family),
					amountPaid: paid,
				});
				event.data.object.currency = p.currency;
				send(store, event, paidAt, { fee });
				if (paid > 0) stats.paidInvoices += 1;
			});

			// credits used inside this period, month by month
			const thisStart = periodStart;
			let cancelsAt = Number.POSITIVE_INFINITY;
			const leaves = rng.next() < churn;
			if (leaves) cancelsAt = periodEnd;
			for (let s = 0; s < sliceCount; s++) {
				const sliceStart = addUtcMonths(thisStart, s);
				const classCredits =
					tier.grants.find((g) => g.featureId === "class")?.amount ?? 0;
				const wanted = Math.min(3, Math.max(1, classCredits * (quantity ?? 1)));
				if (rng.next() >= p.usageRate) continue;
				for (let u = 0; u < rng.int(1, wanted); u++) {
					const holdAt =
						sliceStart + rng.int(1, 24) * DAY + rng.int(8, 19) * HOUR;
					const spendAt = holdAt + rng.int(1, 2) * DAY;
					const service = rng.pick(SERVICES);
					if (
						holdAt >= Math.max(paidAt, 0) + 0 &&
						spendAt < Math.min(cancelsAt, endMs)
					)
						at(holdAt, () => {
							if (store.consume({ feature: "class", service, holdAt, spendAt }))
								stats.bookings += 1;
						});
				}
			}

			// a refund or a dispute of this payment (not both)
			if (paid > 0) {
				const chargeId = `ch_${invoiceId}`;
				if (rng.next() < p.refundRate) {
					const refundAt =
						paidAt + rng.int(1, 20) * DAY + rng.int(0, 12) * HOUR;
					const partial = rng.next() < p.partialRefundShare;
					const amount = partial ? Math.max(1, Math.floor(paid / 2)) : paid;
					at(refundAt, () => {
						stats.refunds += 1;
						const event = chargeRefunded({
							eventId: `evt_re_${invoiceId}`,
							chargeId,
							invoiceId,
							amount,
							chargeAmount: paid,
							refundedTotal: amount,
							at: refundAt,
						});
						event.data.object.currency = p.currency;
						send(store, event, refundAt);
					});
				} else if (rng.next() < p.disputeRate) {
					const openAt = paidAt + rng.int(3, 30) * DAY + rng.int(0, 12) * HOUR;
					const closeAt = openAt + rng.int(20, 60) * DAY;
					const lost = rng.next() < p.disputeLostShare;
					const disputeId = `dp_${invoiceId}`;
					const common = {
						disputeId,
						chargeId,
						invoiceId,
						amount: paid,
						openedAt: openAt,
						withdrawal: { fee: DISPUTE_FEE },
						withdrawnAt: openAt,
					};
					at(openAt, () => {
						stats.disputes += 1;
						const event = disputeEvent({
							...common,
							type: "charge.dispute.created",
							eventId: `evt_dpc_${invoiceId}`,
							status: "needs_response",
							at: openAt,
						});
						event.data.object.currency = p.currency;
						send(store, event, openAt);
					});
					at(closeAt, () => {
						const event = disputeEvent({
							...common,
							type: "charge.dispute.closed",
							eventId: `evt_dpx_${invoiceId}`,
							status: lost ? "lost" : "won",
							reversed: !lost,
							reversedAt: closeAt - 1000,
							at: closeAt,
						});
						event.data.object.currency = p.currency;
						send(store, event, closeAt);
					});
				}
			}

			if (leaves) {
				at(periodEnd, () => {
					stats.cancellations += 1;
					send(
						store,
						subscriptionDeleted({
							eventId: `evt_sd_${family}`,
							subscriptionId: sub,
							tierId,
							interval,
							periodStart: thisStart,
							periodEnd,
							at: periodEnd,
						}),
						periodEnd,
					);
				});
				break;
			}
			periodStart = periodEnd;
			cycle += 1;
		}
	});

	// the cron books lapsed credits at each month's start; Stripe pays the cash out on the 2nd
	for (let k = 1; k <= p.months; k++) {
		const t = monthStart(k);
		at(t - 60_000, () => {
			for (const store of stores.values())
				for (const feature of FEATURES) store.lapse(feature, t - 60_000);
		});
		at(t + 2 * DAY, () => {
			if (cash <= 0) return;
			stats.payouts += 1;
			const amount = cash;
			const event = payoutPaid({
				eventId: `evt_po_${k}`,
				payoutId: `po_${k}`,
				amount,
				currency: p.currency,
				at: t + 2 * DAY,
			});
			send(school, event, t + 2 * DAY, { school: SCHOOL_ID });
			// `send` adds the payout's own negative cash line
		});
	}

	ops.sort((a, b) => a.at - b.at || a.order - b.order);
	for (const op of ops) op.run();

	const events = [school, ...stores.values()]
		.flatMap((s) => s.events)
		.sort((a, b) =>
			a.event_time === b.event_time
				? a.id < b.id
					? -1
					: 1
				: a.event_time < b.event_time
					? -1
					: 1,
		);
	for (const e of events)
		if (e.event_type === "money.skipped") {
			const reason = String(e.payload.reason);
			stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
		}
	const periods = Array.from({ length: p.months }, (_, i) => {
		const d = new Date(monthStart(i));
		return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
	});
	return { events, periods, stats, menu };
};
