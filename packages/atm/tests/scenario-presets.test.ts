/**
 * The presets that make a privacy suppression case exist exactly (one payer on a tier, four families, one refund, one
 * yearly payer, a fee on every payment, three quantities, children as holders), and the knobs behind them: each promise
 * is read back from the generated events, not from the knobs.
 */
import { describe, expect, test } from "bun:test";
import { buildFixture } from "../src/scenario/fixture.js";
import { ScenarioRunError } from "../src/scenario/generate.js";
import {
	DEFAULT_PARAMS,
	parseSets,
	ScenarioInputError,
} from "../src/scenario/params.js";
import { BEFORE_UNIVERSITY_MENU } from "../src/scenario/school.js";
import type { AtmEvent } from "../src/types.js";

const MEMBERSHIP = "income:billing:membership:";
const cents = (amount: string) => Math.round(Number(amount) * 100);

const payments = (events: readonly AtmEvent[]) =>
	events
		.filter((e) => e.event_type === "payment.succeeded")
		.map((e) => {
			const income = e.postings.find((p) => p.account.startsWith(MEMBERSHIP));
			return {
				holder: e.key,
				tier: income?.account.slice(MEMBERSHIP.length) as string,
				amount: -cents(income?.amount ?? "0"),
				fee: cents(
					e.postings.find((p) => p.account === "expenses:billing:stripe-fees")
						?.amount ?? "0",
				),
				month: e.date.slice(0, 7),
			};
		});

const payersByTier = (events: readonly AtmEvent[]) => {
	const out: Record<string, Set<string>> = {};
	for (const pay of payments(events)) {
		const holders = out[pay.tier] ?? new Set<string>();
		holders.add(pay.holder);
		out[pay.tier] = holders;
	}
	return Object.fromEntries(
		Object.entries(out).map(([tier, holders]) => [tier, holders.size]),
	);
};

const refunds = (events: readonly AtmEvent[]) =>
	events.filter((e) => e.event_type === "payment.refunded");

const priceOf = (tier: string, interval: "month" | "year") =>
	BEFORE_UNIVERSITY_MENU.tiers
		.find((t) => t.id === tier)
		?.prices.find((p) => p.interval === interval)?.amount as number;

describe("one-payer-tier", () => {
	const { events } = buildFixture({ profile: "one-payer-tier" });
	test("the fellow tier has exactly one payer and every other tier several", () => {
		const payers = payersByTier(events);
		expect(payers.fellow).toBe(1);
		expect(payers.audit).toBe(6);
		expect(payers.scholar).toBe(8);
		expect(payers.seminar).toBe(5);
	});
	test("the fellow payer is there every month (nobody leaves)", () => {
		const months = new Set(
			payments(events)
				.filter((p) => p.tier === "fellow")
				.map((p) => p.month),
		);
		expect(months.size).toBe(6);
	});
});

describe("tiny-school", () => {
	test("four families, so no cell can have five holders", () => {
		const fixture = buildFixture({ profile: "tiny-school" });
		expect(fixture.stats.families).toBe(4);
		const holders = new Set(payments(fixture.events).map((p) => p.holder));
		expect(holders.size).toBe(4);
	});
});

describe("single-refund-month", () => {
	test("exactly one refund event in the whole run, in one month", () => {
		const fixture = buildFixture({ profile: "single-refund-month" });
		const found = refunds(fixture.events);
		expect(found).toHaveLength(1);
		expect(fixture.stats.refunds).toBe(1);
		expect(new Set(found.map((e) => e.date.slice(0, 7))).size).toBe(1);
		expect(
			fixture.events.filter((e) => e.event_type === "payment.disputed"),
		).toHaveLength(0);
	});
	test("the refund lands on a paid invoice, whatever the seed", () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			const fixture = buildFixture({ profile: "single-refund-month", seed });
			expect(refunds(fixture.events)).toHaveLength(1);
		}
	});
});

describe("yearly-solo", () => {
	const { events } = buildFixture({ profile: "yearly-solo" });
	const yearlyPrices = ["audit", "scholar", "fellow"].map((tier) =>
		priceOf(tier, "year"),
	);
	test("exactly one payment is a yearly price, from one holder; every other is monthly", () => {
		const yearly = payments(events).filter((p) =>
			yearlyPrices.includes(p.amount),
		);
		expect(yearly).toHaveLength(1);
		const monthly = payments(events).filter(
			(p) => p.amount === priceOf(p.tier, "month"),
		);
		expect(monthly.length).toBe(payments(events).length - 1);
		expect(
			monthly.every(
				(p) => p.holder !== (yearly[0] as { holder: string }).holder,
			),
		).toBe(true);
	});
	test("the yearly payer is a spike in one month's membership money", () => {
		const yearly = payments(events).find((p) =>
			yearlyPrices.includes(p.amount),
		);
		expect(yearly).toBeDefined();
		const inMonth = payments(events).filter(
			(p) => p.month === yearly?.month && p.holder !== yearly?.holder,
		);
		const biggestOther = Math.max(...inMonth.map((p) => p.amount));
		expect(yearly?.amount as number).toBeGreaterThan(biggestOther);
	});
});

describe("fee-oracle", () => {
	const { events } = buildFixture({ profile: "fee-oracle" });
	test("every payment is the same amount on one tier, with a fee, and no refund, dispute or free invoice", () => {
		const paid = payments(events);
		expect(paid.length).toBeGreaterThan(20);
		expect(new Set(paid.map((p) => p.tier)).size).toBe(1);
		expect(new Set(paid.map((p) => p.amount)).size).toBe(1);
		expect(refunds(events)).toHaveLength(0);
		expect(
			events.filter((e) =>
				["payment.disputed", "dispute.closed"].includes(e.event_type),
			),
		).toHaveLength(0);
	});
	test("fees total exactly the payment count times the fee on one payment", () => {
		const paid = payments(events);
		const amount = (paid[0] as { amount: number }).amount;
		const feeOne =
			Math.round((amount * DEFAULT_PARAMS.feePercent) / 100) +
			DEFAULT_PARAMS.feeFixedCents;
		expect(paid.every((p) => p.fee === feeOne)).toBe(true);
		expect(paid.reduce((n, p) => n + p.fee, 0)).toBe(paid.length * feeOne);
	});
});

describe("seminar-quantities", () => {
	test("payments of 1, 2 and 4 seats all occur, and nothing else is sold", () => {
		const { events } = buildFixture({ profile: "seminar-quantities" });
		const unit = priceOf("seminar", "month");
		const seats = new Set(payments(events).map((p) => p.amount / unit));
		expect([...seats].sort()).toEqual([1, 2, 4]);
		expect(new Set(payments(events).map((p) => p.tier))).toEqual(
			new Set(["seminar"]),
		);
	});
});

describe("child-only", () => {
	const { events, stats } = buildFixture({ profile: "child-only" });
	test("every holder is a profile and none is a family, in the keys, accounts and payloads", () => {
		expect(stats.families).toBe(12);
		const holders = new Set(
			events.filter((e) => e.source !== "stripe").map((e) => e.key),
		);
		expect(holders.size).toBe(12);
		for (const key of holders) expect(key).toMatch(/^profile:prof_\d{3}$/);
		for (const pay of payments(events)) expect(pay.holder).toMatch(/^profile:/);
		expect(JSON.stringify(events)).not.toContain("family:");
	});
	test("a tier of children: all four tiers have payers", () => {
		expect(Object.keys(payersByTier(events)).sort()).toEqual([
			"audit",
			"fellow",
			"scholar",
			"seminar",
		]);
	});
});

describe("profile holders through the whole billing path", () => {
	// refunds, disputes, lapse, bookings and renewals all on a profile holder
	const { events } = buildFixture({
		profile: "heavy-refunds",
		params: { childShare: 1, disputeRate: 0.1, months: 8 },
	});
	test("each kind of event is written for the profile and none for a family", () => {
		const kinds = new Set<string>(events.map((e) => e.event_type));
		for (const kind of [
			"payment.refunded",
			"payment.disputed",
			"dispute.closed",
			"credit.held",
			"credit.spent",
			"credit.expired",
			"credit.adjusted",
			"payout.paid",
		])
			expect(kinds.has(kind)).toBe(true);
		expect(JSON.stringify(events)).not.toContain("family:");
		for (const e of events)
			if (e.event_type !== "payout.paid") expect(e.key).toMatch(/^profile:/);
	});
	test("a share of children mixes the two holders and moves only who holds", () => {
		const mixed = buildFixture({
			profile: "monthly-members",
			params: { childShare: 0.5 },
		});
		const plain = buildFixture({ profile: "monthly-members" });
		const keys = new Set(mixed.events.map((e) => e.key.split(":")[0]));
		expect(keys.has("profile")).toBe(true);
		expect(keys.has("family")).toBe(true);
		const shape = (events: readonly AtmEvent[]) =>
			events
				.map(
					(e) =>
						`${e.event_type} ${e.event_time} ${e.postings.map((p) => p.amount).join(",")}`,
				)
				.sort();
		expect(shape(mixed.events)).toEqual(shape(plain.events));
	});
});

describe("exact-count knobs", () => {
	test("tierCounts is exact whatever the seed, and the rest draw from the tiers it does not name", () => {
		for (const seed of [1, 2, 3]) {
			const { events } = buildFixture({
				seed,
				params: {
					members: 20,
					months: 3,
					churnRate: 0,
					tierCounts: { fellow: 2, seminar: 3 },
					tierMix: { audit: 1, scholar: 1, fellow: 50, seminar: 50 },
				},
			});
			const payers = payersByTier(events);
			expect(payers.fellow).toBe(2);
			expect(payers.seminar).toBe(3);
			expect((payers.audit ?? 0) + (payers.scholar ?? 0)).toBe(15);
		}
	});
	test("yearlyCount makes that many yearly payers whatever yearlyShare says", () => {
		const { events } = buildFixture({
			seed: 5,
			params: {
				members: 15,
				months: 3,
				addonRate: 0,
				yearlyShare: 1,
				yearlyCount: 3,
				churnRate: 0,
				tierMix: { audit: 1, scholar: 1, seminar: 1 },
			},
		});
		const yearly = new Set(
			payments(events)
				.filter((p) => p.amount === priceOf(p.tier, "year"))
				.map((p) => p.holder),
		);
		expect(yearly.size).toBe(3);
	});
	test("refundCount is exact however many invoices there are, and 0 leaves refundRate in charge", () => {
		for (const refundCount of [1, 4, 9]) {
			const { events } = buildFixture({
				seed: 3,
				params: { members: 12, months: 5, refundCount, disputeRate: 0 },
			});
			expect(refunds(events)).toHaveLength(refundCount);
		}
		const byRate = buildFixture({
			params: { members: 12, months: 5, refundRate: 0.3 },
		});
		expect(refunds(byRate.events).length).toBeGreaterThan(0);
	});
	test("a count that cannot be met says which knob and the fix", () => {
		const message = (input: unknown) => {
			try {
				buildFixture(input);
			} catch (error) {
				return (error as Error).message;
			}
			return "";
		};
		expect(
			message({ params: { members: 4, tierCounts: { fellow: 3, audit: 3 } } }),
		).toContain("tierCounts");
		expect(
			message({
				params: {
					members: 4,
					tierCounts: { fellow: 1 },
					tierMix: { fellow: 1 },
				},
			}),
		).toContain("no weight is above 0");
		expect(message({ params: { members: 3, yearlyCount: 5 } })).toContain(
			"yearlyCount=5",
		);
		expect(
			message({
				params: { members: 3, tierMix: { seminar: 1 }, yearlyCount: 1 },
			}),
		).toContain("yearly price");
		expect(
			message({ params: { members: 2, months: 2, refundCount: 50 } }),
		).toContain("refundCount=50");
		expect(message({ params: { tierCounts: { fello: 1 } } })).toContain(
			'did you mean "fellow"',
		);
		expect(message({ params: { childShare: 5 } })).toContain("share");
	});
	test("the error classes are the ones the CLI handles", () => {
		expect(() =>
			buildFixture({ params: { members: 2, yearlyCount: 9 } }),
		).toThrow(ScenarioInputError);
		expect(() =>
			buildFixture({
				params: { members: 3, tierMix: { seminar: 1 }, yearlyCount: 1 },
			}),
		).toThrow(ScenarioRunError);
	});
	test("--set reaches a single count", () => {
		expect(parseSets(["tierCounts.fellow=1", "refundCount=2"])).toEqual({
			tierCounts: { fellow: 1 },
			refundCount: 2,
		});
	});
});
