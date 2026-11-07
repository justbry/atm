/**
 * The demo orgs beside the school: each menu is valid and invented, a school scenario resolves and hashes as it did
 * before orgs, a tier knob is checked against the org's own menu, and each org's presets do what their summary says,
 * read back from the generated events.
 */
import { describe, expect, test } from "bun:test";
import { publishProblems, validateMenu } from "../src/billing/menu.js";
import { buildFixture } from "../src/scenario/fixture.js";
import { ORG_KINDS, ORGS, tierIdsOf } from "../src/scenario/orgs.js";
import { ScenarioInputError } from "../src/scenario/params.js";
import { PROFILES, resolveScenario } from "../src/scenario/profiles.js";
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
				invoice: String((e.payload as { id?: unknown }).id),
				tier: income?.account.slice(MEMBERSHIP.length) as string,
				amount: -cents(income?.amount ?? "0"),
				fee: cents(
					e.postings.find((p) => p.account === "expenses:billing:stripe-fees")
						?.amount ?? "0",
				),
				month: e.date.slice(0, 7),
			};
		});

const count = (events: readonly AtmEvent[], type: string) =>
	events.filter((e) => e.event_type === type).length;

const problemsOf = (input: unknown): string => {
	try {
		resolveScenario(input);
	} catch (error) {
		expect(error).toBeInstanceOf(ScenarioInputError);
		return (error as ScenarioInputError).problems.join("\n");
	}
	throw new Error("accepted");
};

describe("the org menus", () => {
	for (const kind of ORG_KINDS)
		test(`${kind}: valid, publishable, and only the shape the school's menu has`, () => {
			const { menu } = ORGS[kind];
			expect(validateMenu(menu).ok).toBe(true);
			expect(publishProblems(menu)).toEqual([]);
			const json = JSON.stringify(menu);
			for (const field of ['"gift"', '"codes"', '"billing"', '"bookable"'])
				expect(json).not.toContain(field);
			expect(menu.features.map((f) => f.id)).toContain(ORGS[kind].spendFeature);
			expect(Object.keys(ORGS[kind].tierMix).sort()).toEqual(
				tierIdsOf(kind).sort(),
			);
		});

	test("each org has its own id and name, and at least one preset", () => {
		const orgs = Object.values(ORGS);
		expect(new Set(orgs.map((o) => o.id)).size).toBe(orgs.length);
		expect(new Set(orgs.map((o) => o.name)).size).toBe(orgs.length);
		for (const kind of ORG_KINDS)
			expect(
				PROFILES.some((p) => (p.org ?? "school") === kind),
				`${kind} has a preset`,
			).toBe(true);
	});
});

describe("the school stays the default and hashes as before", () => {
	test("a school scenario carries no org and no knob added after its golden", () => {
		const scenario = resolveScenario({ profile: "monthly-members" });
		expect("org" in scenario).toBe(false);
		expect("seatChangeRate" in scenario.params).toBe(false);
		expect("upgradeRate" in scenario.params).toBe(false);
	});

	test("naming the school, or the new knobs at 0, moves no hash", () => {
		const plain = buildFixture({ profile: "monthly-members" }).hash;
		expect(
			buildFixture({ profile: "monthly-members", org: "school" }).hash,
		).toBe(plain);
		expect(
			buildFixture({
				profile: "monthly-members",
				params: { seatChangeRate: 0, upgradeRate: 0 },
			}).hash,
		).toBe(plain);
		expect(buildFixture({ org: "school" }).hash).toBe(buildFixture({}).hash);
	});

	test("an org's events carry its id where the school's would be", () => {
		for (const kind of ORG_KINDS) {
			const { events } = buildFixture({
				org: kind,
				params: { members: 3, months: 2 },
			});
			expect(new Set(events.map((e) => e.school))).toEqual(
				new Set([ORGS[kind].id]),
			);
		}
	});
});

describe("a tier knob is checked against the org's menu", () => {
	test("a school tier on a church preset names the church's tiers", () => {
		const text = problemsOf({
			profile: "church-giving",
			params: { tierMix: { audit: 1 } },
		});
		expect(text).toContain('tierMix={"audit":1} is not valid');
		expect(text).toContain("give-25, give-50, give-100, give-250");
	});

	test("a near miss suggests the org's tier", () => {
		expect(
			problemsOf({ org: "saas", params: { tierCounts: { buisness: 2 } } }),
		).toContain('did you mean "business"');
	});

	test("an unknown org, or one that is not the preset's, says the fix", () => {
		expect(problemsOf({ org: "studoi" })).toContain('Did you mean "studio"?');
		expect(problemsOf({ org: "church", profile: "saas-seats" })).toContain(
			'Drop "org"',
		);
	});

	test("an org's defaults weigh its own tiers", () => {
		expect(resolveScenario({ org: "creator" }).params.tierMix).toEqual(
			ORGS.creator.tierMix,
		);
	});
});

describe("studio-members and studio-class-packs", () => {
	const members = buildFixture({ profile: "studio-members" });
	const packs = buildFixture({ profile: "studio-class-packs" });
	test("classes are booked, roll over and expire", () => {
		expect(count(members.events, "credit.spent")).toBeGreaterThan(100);
		expect(count(members.events, "credit.expired")).toBeGreaterThan(0);
		expect(count(packs.events, "credit.expired")).toBeGreaterThan(0);
	});
	test("monthly and yearly memberships, and members leave", () => {
		const paid = payments(members.events);
		const yearly = paid.filter((p) =>
			ORGS.studio.menu.tiers.some(
				(t) =>
					t.id === p.tier &&
					t.prices.some((x) => x.interval === "year" && x.amount <= p.amount),
			),
		);
		expect(yearly.length).toBeGreaterThan(0);
		expect(members.stats.cancellations).toBeGreaterThan(10);
	});
	test("class packs dominate, and a second pack bought mid-month is billed on its own invoice", () => {
		const paid = payments(packs.events);
		const onPacks = paid.filter((p) => p.tier === "class-pack").length;
		expect(onPacks * 2).toBeGreaterThan(paid.length);
		expect(paid.some((p) => p.invoice.endsWith("_change"))).toBe(true);
	});
});

describe("church-giving", () => {
	const { events, stats } = buildFixture({ profile: "church-giving" });
	test("gifts at the four amounts, refunds of a few, disputes rare", () => {
		expect(new Set(payments(events).map((p) => p.tier))).toEqual(
			new Set(tierIdsOf("church")),
		);
		expect(stats.refunds).toBeGreaterThan(0);
		expect(stats.disputes).toBeLessThanOrEqual(1);
	});
	test("the only credits are retreat seats, and the nonprofit card rate applies", () => {
		const features = new Set(
			events
				.flatMap((e) => e.postings)
				.filter((p) => p.account.startsWith("credits:avail:"))
				.map((p) => p.account.split(":").at(-1)),
		);
		expect([...features]).toEqual(["retreat-seat"]);
		const gift = payments(events).find((p) => p.amount === 2500);
		expect(gift?.fee).toBe(Math.round(2500 * 0.022) + 30);
	});
});

describe("saas-seats and saas-annual", () => {
	const seats = buildFixture({ profile: "saas-seats" });
	test("seat raises and upgrades are billed mid-cycle, and some customers pay on two plans", () => {
		const paid = payments(seats.events);
		expect(
			paid.filter((p) => p.invoice.endsWith("_change")).length,
		).toBeGreaterThan(5);
		const plans = new Map<string, Set<string>>();
		for (const p of paid)
			plans.set(p.holder, (plans.get(p.holder) ?? new Set()).add(p.tier));
		expect([...plans.values()].some((tiers) => tiers.size > 1)).toBe(true);
		expect(count(seats.events, "credit.adjusted")).toBeGreaterThan(0);
	});
	test("API credits are spent", () => {
		expect(count(seats.events, "credit.spent")).toBeGreaterThan(100);
	});
	test("saas-annual: every subscription payment is a yearly price", () => {
		const { events } = buildFixture({ profile: "saas-annual" });
		const yearlyUnit = (tier: string) =>
			ORGS.saas.menu.tiers
				.find((t) => t.id === tier)
				?.prices.find((x) => x.interval === "year")?.amount as number;
		for (const p of payments(events))
			expect(p.amount).toBeGreaterThanOrEqual(yearlyUnit(p.tier));
	});
});

describe("creator-launch", () => {
	const launch = buildFixture({ profile: "creator-launch" });
	test("the launch month has far more new members than any later month", () => {
		const firstPayment = new Map<string, string>();
		for (const p of payments(launch.events))
			if (!firstPayment.has(p.holder)) firstPayment.set(p.holder, p.month);
		const byMonth = new Map<string, number>();
		for (const month of firstPayment.values())
			byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
		const [first, ...rest] = [...byMonth.entries()].sort();
		expect(first?.[1]).toBeGreaterThan(5 * Math.max(...rest.map(([, n]) => n)));
	});
	test("refunds run higher than the studio's", () => {
		const studio = buildFixture({ profile: "studio-members" });
		const rate = (fixture: typeof launch) =>
			fixture.stats.refunds / fixture.stats.paidInvoices;
		expect(rate(launch)).toBeGreaterThan(3 * rate(studio));
	});
});
