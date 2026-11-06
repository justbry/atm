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

type Rng = ReturnType<typeof makeRng>;

/** A seeded Fisher-Yates shuffle: the same items and rng give the same order. */
const shuffled = <T>(items: readonly T[], rng: Rng): T[] => {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = rng.int(0, i);
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
};

/** What a family is before the run: the draws of its own stream, then the exact-count knobs over them. */
type FamilyPlan = {
	family: string;
	/** The child's own profile id when the membership is held by one. */
	profile: string | undefined;
	rng: Rng;
	joinAt: number;
	tierId: string;
	interval: "month" | "year";
	quantity: number | undefined;
	free: boolean;
	addonChoice: Menu["addons"][number] | null;
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
	const school = createStore({
		menu,
		school: SCHOOL_ID,
		family: "school",
		commandPrefix: "school_",
	});
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
	const metadataOf = (family: string, profile?: string) => ({
		b4u_school: SCHOOL_ID,
		family_id: family,
		...(profile === undefined ? {} : { profile_id: profile }),
	});
	const recurring = (every: "month" | "year") =>
		menu.addons.find((a) => a.price.every === every);
	const once = menu.addons.filter((a) => a.price.every === "once");

	const joins: number[] = [];
	for (let i = 0; i < p.members; i++) joins.push(-1);
	for (let k = 1; k < p.months; k++)
		for (let i = 0; i < p.newMembersPerMonth; i++) joins.push(-k);

	const tierOf = (id: string) =>
		menu.tiers.find((t) => t.id === id) as Menu["tiers"][number];
	const canYear = (tier: Menu["tiers"][number]) =>
		tier.prices.some((x) => x.interval === "year");

	// the draws of each family's own stream, in the order they were always made, so a scenario with no exact-count knob
	// keeps its events to the byte
	const plans: FamilyPlan[] = joins.map((joinMonth, index) => {
		const suffix = String(index).padStart(3, "0");
		const family = `fam_${suffix}`;
		const rng = makeRng(`${scenario.seed}/${family}`);
		const cohort = joinMonth === -1 ? 0 : -joinMonth;
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
		const tier = tierOf(tierId);
		const interval: "month" | "year" =
			canYear(tier) && rng.next() < p.yearlyShare ? "year" : "month";
		const quantity = tier.quantities
			? (rng.pick(tier.quantities) as number)
			: undefined;
		const free = rng.next() < p.freeShare;
		const addonChoice =
			rng.next() < p.addonRate
				? rng.pick(
						[recurring(interval), ...once].filter(Boolean) as Menu["addons"],
					)
				: null;
		// a child's own membership: a stream of its own, so the share moves nothing else
		const child =
			makeRng(`${scenario.seed}/${family}/child`).next() < p.childShare;
		return {
			family,
			profile: child ? `prof_${suffix}` : undefined,
			rng,
			joinAt,
			tierId,
			interval,
			quantity,
			free,
			addonChoice,
		};
	});

	// A family moved to another tier keeps what still fits it; the rest is drawn from a stream of its own.
	const moveToTier = (plan: FamilyPlan, tierId: string) => {
		if (plan.tierId === tierId) return;
		const tier = tierOf(tierId);
		const moved = makeRng(`${scenario.seed}/${plan.family}/tier`);
		plan.tierId = tierId;
		if (!canYear(tier)) setInterval(plan, "month");
		plan.quantity = tier.quantities
			? tier.quantities.includes(plan.quantity as number)
				? plan.quantity
				: (moved.pick(tier.quantities) as number)
			: undefined;
	};
	// A recurring add-on follows the interval it is bought on.
	const setInterval = (plan: FamilyPlan, interval: "month" | "year") => {
		if (plan.interval === interval) return;
		plan.interval = interval;
		const addon = plan.addonChoice;
		if (addon && addon.price.every !== "once")
			plan.addonChoice = recurring(interval) ?? null;
	};

	const countedTiers = Object.keys(p.tierCounts);
	if (countedTiers.length > 0) {
		const openTiers = menu.tiers
			.map((t) => t.id)
			.filter((id) => !countedTiers.includes(id));
		const order = shuffled(
			plans.map((_, index) => index),
			makeRng(`${scenario.seed}/tierCounts`),
		);
		let next = 0;
		for (const tier of menu.tiers) {
			const count = p.tierCounts[tier.id] ?? 0;
			for (let n = 0; n < count; n++)
				moveToTier(plans[order[next++] as number] as FamilyPlan, tier.id);
		}
		// the families not placed draw from the tiers that are not counted (keeping a draw that already fell there)
		for (const index of order.slice(next)) {
			const plan = plans[index] as FamilyPlan;
			if (openTiers.includes(plan.tierId)) continue;
			moveToTier(
				plan,
				weighted(
					makeRng(`${scenario.seed}/${plan.family}/open-tier`),
					p.tierMix,
					openTiers,
				),
			);
		}
	}
	if (p.yearlyCount > 0) {
		const eligible = plans.filter((plan) => canYear(tierOf(plan.tierId)));
		if (eligible.length < p.yearlyCount)
			throw new ScenarioRunError(
				`yearlyCount=${p.yearlyCount} but only ${eligible.length} families are on a tier with a yearly price. Lower yearlyCount, raise members, or put families on audit, scholar or fellow (tierMix, tierCounts).`,
			);
		const yearly = new Set(
			shuffled(eligible, makeRng(`${scenario.seed}/yearlyCount`)).slice(
				0,
				p.yearlyCount,
			),
		);
		for (const plan of plans)
			setInterval(plan, yearly.has(plan) ? "year" : "month");
	}

	// refunds by count: the paid invoices a refund could land on, drawn from once the run is built
	const refundable: {
		store: Store;
		invoiceId: string;
		paid: number;
		refundAt: number;
		partial: boolean;
	}[] = [];
	const scheduleRefund = ({
		store,
		invoiceId,
		paid,
		refundAt,
		partial,
	}: (typeof refundable)[number]) => {
		const chargeId = `ch_${invoiceId}`;
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
	};

	for (const plan of plans) {
		const { family, profile, rng, joinAt, tierId, interval, free } = plan;
		const { addonChoice, quantity } = plan;
		const tier = tierOf(tierId);
		const price = tier.prices.find((x) => x.interval === interval)
			?.amount as number;
		stats.families += 1;
		const store = createStore({
			menu,
			school: SCHOOL_ID,
			family,
			profile,
			commandPrefix: `${family}_`,
		});
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
			const invoiceCycle = cycle;
			const invoiceStart = periodStart;
			at(paidAt, () => {
				stats.invoices += 1;
				const event = invoicePaid({
					eventId: `evt_${invoiceId}`,
					invoiceId,
					at: paidAt,
					subscriptionId: sub,
					reason:
						invoiceCycle === 0 ? "subscription_create" : "subscription_cycle",
					periodStart: invoiceStart,
					periodEnd,
					lines,
					metadata: metadataOf(family, profile),
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
				if (p.refundCount === 0 && rng.next() < p.refundRate) {
					const refundAt =
						paidAt + rng.int(1, 20) * DAY + rng.int(0, 12) * HOUR;
					scheduleRefund({
						store,
						invoiceId,
						paid,
						refundAt,
						partial: rng.next() < p.partialRefundShare,
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
				} else if (p.refundCount > 0) {
					// the refunds are counted, not drawn: this payment is one a refund could land on
					const chosen = makeRng(`${scenario.seed}/refund/${invoiceId}`);
					const refundAt =
						paidAt + chosen.int(1, 20) * DAY + chosen.int(0, 12) * HOUR;
					if (refundAt < endMs)
						refundable.push({
							store,
							invoiceId,
							paid,
							refundAt,
							partial: chosen.next() < p.partialRefundShare,
						});
				}
			}

			if (leaves) {
				at(periodEnd, () => {
					stats.cancellations += 1;
					const event = subscriptionDeleted({
						eventId: `evt_sd_${family}`,
						subscriptionId: sub,
						tierId,
						interval,
						periodStart: thisStart,
						periodEnd,
						at: periodEnd,
					});
					if (profile !== undefined)
						event.data.object.metadata.profile_id = profile;
					send(store, event, periodEnd);
				});
				break;
			}
			periodStart = periodEnd;
			cycle += 1;
		}
	}

	if (p.refundCount > 0) {
		if (refundable.length < p.refundCount)
			throw new ScenarioRunError(
				`refundCount=${p.refundCount} but only ${refundable.length} paid invoices can be refunded inside the run. Lower refundCount, add members or months, or lower disputeRate.`,
			);
		for (const refund of shuffled(
			refundable,
			makeRng(`${scenario.seed}/refundCount`),
		).slice(0, p.refundCount))
			scheduleRefund(refund);
	}

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
