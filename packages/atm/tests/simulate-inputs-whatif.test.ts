/**
 * What-ifs on the grant rules, from stored inputs. Every history is delivered through the real handler into SQLite; the
 * candidate is tried with `simulateFromInputs`. Each what-if has its numbers worked out by hand in the test (from the menu
 * and the README's rules), and is also committed under golden/simulate/ (`UPDATE_GOLDEN=1` rewrites them), so the golden is
 * not the only witness.
 *
 * The menu is `fixtures/billing/grants/menu.json`: sparkle-2 sells 2 visits a month (rollover max 2 for 1 month) at
 * $260.00 a month, sparkle-4 4 visits a month and a yearly retreat at $520.00. The cycle of the monthly histories runs from
 * 2026-01-15T18:00Z to 2026-02-15T18:00Z, 31 days.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addUtcMonths } from "../src/billing/grants.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { buildJournal } from "../src/ledger/journal.js";
import {
	InputsSimulateError,
	simulateFromInputs,
} from "../src/ledger/simulate-inputs.js";
import type {
	AtmEnv,
	AtmEvent,
	BillingPolicy,
	InputsSimulation,
} from "../src/types.js";
import { RECORDED_SCHOOL, recordedMenu } from "./e2e-recorded.js";
import {
	FAMILY,
	HOUR,
	harness,
	menu,
	paid,
	SCHOOL,
	T0,
	T1,
} from "./handler-harness.js";
import { hasHledger, tmp } from "./helpers.js";
import {
	deliverWithRetries,
	type Harness,
	logOf,
	readStored,
	recordedHarness,
	scenarioEvents,
} from "./simulate-inputs-world.js";
import { invoicePaid, priceIdOf, type RawEvent } from "./stripe-events.js";

const GOLDEN = join(import.meta.dir, "golden/simulate");
const DAY = 24 * HOUR;
const METADATA = { b4u_school: SCHOOL, family_id: FAMILY };

const price = (tierId: string): number =>
	menu.tiers
		.find((t) => t.id === tierId)
		?.prices.find((p) => p.interval === "month")?.amount as number;
const tierLine = (tierId: string, over: Record<string, unknown> = {}) => ({
	lookupKey: lookupKeyOf(
		SCHOOL,
		tierPriceKey(tierId, "month"),
		price(tierId),
		menu.currency,
	),
	amount: price(tierId),
	interval: "month" as const,
	...over,
});

/** A tier of the menu with its fields replaced. */
const withTier = (
	base: Menu,
	tierId: string,
	change: (tier: Menu["tiers"][number]) => Menu["tiers"][number],
): Menu => ({
	...base,
	tiers: base.tiers.map((tier) => (tier.id === tierId ? change(tier) : tier)),
});

const policyOf = (over: Partial<BillingPolicy>): BillingPolicy => ({
	...DEFAULT_POLICY,
	...over,
});

const whatIf = async (
	h: Harness,
	candidate: {
		menu?: Menu;
		policy?: BillingPolicy;
		priceIds?: Record<string, string>;
	},
	over: {
		env?: AtmEnv;
		school?: string;
		effectiveFrom?: number;
		allowBaselineDrift?: boolean;
		events?: readonly AtmEvent[];
	} = {},
): Promise<InputsSimulation> => {
	const env = over.env ?? "live";
	const school = over.school ?? SCHOOL;
	return simulateFromInputs({
		events: over.events ?? logOf(h),
		inputs: await readStored(h, env, school),
		env,
		school,
		candidate,
		...(over.effectiveFrom === undefined
			? {}
			: { effectiveFrom: over.effectiveFrom }),
		...(over.allowBaselineDrift ? { allowBaselineDrift: true } : {}),
	});
};

const golden = (name: string, sim: InputsSimulation) => {
	const { events: _events, ...rest } = sim;
	const text = `${JSON.stringify(rest, null, 2)}\n`;
	const file = join(GOLDEN, name);
	if (process.env.UPDATE_GOLDEN) writeFileSync(file, text);
	expect(text).toBe(readFileSync(file, "utf8"));
};

const kinds = (sim: InputsSimulation) =>
	sim.deliveries.map((d) => [d.eventId, d.kind]);
const availOf = (sim: InputsSimulation, feature = "visit") =>
	sim.balances.candidate.find((b) => b.feature === feature)?.avail;
const recordedAvail = (sim: InputsSimulation, feature = "visit") =>
	sim.balances.current.find((b) => b.feature === feature)?.avail;

// ---- A plan switch: sparkle-2 to sparkle-4 ten days before the cycle ends ----

/**
 * sparkle-2 monthly on 2026-01-15T18:00Z (2 visits), then on 2026-02-05T18:00Z (21 days in, 10 of the 31 days left) the
 * switch to sparkle-4, billed as Stripe bills it: the unused part of sparkle-2 as a credit line and the rest of sparkle-4's
 * cycle as a charge, both proration lines.
 */
const planSwitch = () => {
	const h = harness();
	h.deliver(paid());
	const at = T0 + 21 * DAY;
	const span = T1 - T0;
	const left = T1 - at;
	const upgrade: RawEvent = invoicePaid({
		eventId: "evt_up",
		invoiceId: "in_up",
		at,
		subscriptionId: "sub_1",
		reason: "subscription_update",
		periodStart: at,
		periodEnd: T1,
		lines: [
			tierLine("sparkle-2", {
				amount: -Math.floor((price("sparkle-2") * left) / span),
				proration: true,
			}),
			tierLine("sparkle-4", {
				amount: Math.floor((price("sparkle-4") * left) / span),
				proration: true,
			}),
		],
		metadata: METADATA,
	});
	expect(h.deliver(upgrade, at).status).toBe(200);
	return h;
};

describe("upgradeGrant on a plan switch (sparkle-2 to sparkle-4, 10 of 31 days left)", () => {
	// By hand: the allowance goes from 2 to 4 visits a month, a difference of 2. Prorated that is 2 x 10/31 = 0.645 rounded
	// up to 1 (the default rule, so the history as recorded: 2 + 1 = 3 visits). Full is the whole difference, 2, so 2 + 2 = 4.
	// None grants nothing for the switch: 2. The retreat is a feature sparkle-2 lacked: the new plan gives it, 1, whatever
	// the rule says about the difference.
	test("prorated (the default): the identity, 1 extra visit, balance 3", async () => {
		const sim = await whatIf(planSwitch(), {
			policy: policyOf({ upgradeGrant: "prorated" }),
		});
		expect(sim.baseline.identical).toBe(true);
		expect(sim.differences).toBe(0);
		expect(kinds(sim)).toEqual([
			["evt_in_1", "same"],
			["evt_up", "same"],
		]);
		expect(sim.deliveries[1]?.recorded.granted).toEqual({
			visit: 1,
			retreat: 1,
		});
		expect(recordedAvail(sim)).toBe(3);
		expect(availOf(sim)).toBe(3);
		golden("inputs-upgrade-prorated.json", sim);
	});

	test("full: the whole difference, 2 extra visits, balance 4", async () => {
		const sim = await whatIf(planSwitch(), {
			policy: policyOf({ upgradeGrant: "full" }),
		});
		expect(kinds(sim)).toEqual([
			["evt_in_1", "same"],
			["evt_up", "changed"],
		]);
		expect(sim.deliveries[1]?.recorded.granted).toEqual({
			visit: 1,
			retreat: 1,
		});
		expect(sim.deliveries[1]?.candidate.granted).toEqual({
			visit: 2,
			retreat: 1,
		});
		expect(recordedAvail(sim)).toBe(3);
		expect(availOf(sim)).toBe(4);
		expect(sim.balanceChanges).toEqual([
			{
				holder: `family:${FAMILY}`,
				feature: "visit",
				current: { avail: 3, held: 0 },
				candidate: { avail: 4, held: 0 },
			},
		]);
		// the credit postings of February move by the one visit; no money moves
		expect(
			sim.postingChanges.map((p) => [
				p.month,
				p.account,
				p.current,
				p.candidate,
			]),
		).toEqual([
			["2026-02", "credits:adjust", "-1", "-2"],
			["2026-02", `credits:avail:family:${FAMILY}:visit`, "1", "2"],
		]);
		expect(sim.postingChanges.some((p) => p.commodity === "USD")).toBe(false);
		golden("inputs-upgrade-full.json", sim);
	});

	test("none: no extra visit, balance 2", async () => {
		const sim = await whatIf(planSwitch(), {
			policy: policyOf({ upgradeGrant: "none" }),
		});
		expect(kinds(sim)).toEqual([
			["evt_in_1", "same"],
			["evt_up", "changed"],
		]);
		expect(sim.deliveries[1]?.candidate.granted).toEqual({ retreat: 1 });
		expect(availOf(sim)).toBe(2);
		expect(availOf(sim, "retreat")).toBe(1);
		expect(
			sim.balanceChanges.map((b) => [
				b.feature,
				b.current.avail,
				b.candidate.avail,
			]),
		).toEqual([["visit", 3, 2]]);
		golden("inputs-upgrade-none.json", sim);
	});
});

// ---- A renewal: a different tier price and allowance, and a rollover change ----

/** sparkle-2 monthly on 2026-01-15, renewed on 2026-02-15 with nothing taken out in between. */
const renewal = () => {
	const h = harness();
	h.deliver(paid());
	const end = addUtcMonths(T1, 1);
	const cycle: RawEvent = invoicePaid({
		eventId: "evt_cycle",
		invoiceId: "in_cycle",
		at: T1,
		subscriptionId: "sub_1",
		reason: "subscription_cycle",
		periodStart: T1,
		periodEnd: end,
		lines: [tierLine("sparkle-2")],
		metadata: METADATA,
	});
	expect(h.deliver(cycle, T1).status).toBe(200);
	return h;
};

describe("a candidate menu on a renewal", () => {
	// By hand, as recorded: January grants the allowance, 2 visits. At the renewal the 2 unused visits roll over (the rollover
	// keeps at most 2 for a month) and the allowance refills to 2: 2 + 2 = 4 available.
	test("the history as recorded: 4 visits after the renewal", async () => {
		const sim = await whatIf(renewal(), {});
		expect(sim.baseline.identical).toBe(true);
		expect(sim.differences).toBe(0);
		expect(recordedAvail(sim)).toBe(4);
	});

	// Allowance 3 instead of 2 and the price $270.00 instead of $260.00. January grants 3. At the renewal 3 unused visits roll
	// over but the cap is 2, so 2 stay; the allowance refills to 3: 3 + 2 = 5 available. The price changes no credit and no
	// money: the family paid what Stripe charged ($260.00 each time), the invoice's lines are found again through their price ids.
	test("allowance 3 and a price of $270.00: January grants 3, the renewal rolls over 2 and refills 3, 5 visits", async () => {
		const candidate = withTier(menu, "sparkle-2", (tier) => ({
			...tier,
			prices: tier.prices.map((p) =>
				p.interval === "month" ? { ...p, amount: 27000 } : p,
			),
			grants: tier.grants.map((g) => ({ ...g, amount: 3 })),
		}));
		const sim = await whatIf(renewal(), { menu: candidate });
		expect(sim.baseline.identical).toBe(true);
		expect(kinds(sim)).toEqual([
			["evt_in_1", "changed"],
			["evt_cycle", "changed"],
		]);
		expect(sim.deliveries[0]?.recorded.granted).toEqual({ visit: 2 });
		expect(sim.deliveries[0]?.candidate.granted).toEqual({ visit: 3 });
		expect(recordedAvail(sim)).toBe(4);
		expect(availOf(sim)).toBe(5);
		expect(sim.postingChanges.some((p) => p.commodity === "USD")).toBe(false);
		expect(sim.refused).toEqual([]);
		golden("inputs-renewal-allowance-price.json", sim);
	});

	// A rollover that keeps 1 visit instead of 2: the renewal rolls over min(2, 1) = 1 and refills 2: 1 + 2 = 3.
	test("a rollover of at most 1: the renewal keeps 1 of the 2 unused visits, 3 in all", async () => {
		const candidate = withTier(menu, "sparkle-2", (tier) => ({
			...tier,
			grants: tier.grants.map((g) => ({
				...g,
				rollover: { max: 1, months: 1 },
			})),
		}));
		const sim = await whatIf(renewal(), { menu: candidate });
		expect(kinds(sim)).toEqual([
			["evt_in_1", "same"],
			["evt_cycle", "changed"],
		]);
		expect(recordedAvail(sim)).toBe(4);
		expect(availOf(sim)).toBe(3);
		golden("inputs-renewal-rollover.json", sim);
	});

	test("--effective-from keeps the deliveries before it as they were: a candidate from 2026-02-01 leaves January alone", async () => {
		const candidate = withTier(menu, "sparkle-2", (tier) => ({
			...tier,
			grants: tier.grants.map((g) => ({ ...g, amount: 3 })),
		}));
		const sim = await whatIf(
			renewal(),
			{ menu: candidate },
			{ effectiveFrom: Date.parse("2026-02-01T00:00:00Z") },
		);
		// January grants 2 as recorded; at the renewal the 2 unused roll over (cap 2) and the allowance refills to 3: 5 too
		expect(kinds(sim)).toEqual([
			["evt_in_1", "same"],
			["evt_cycle", "changed"],
		]);
		expect(availOf(sim)).toBe(5);
	});
});

// ---- A raise on a yearly plan, recorded by a Stripe sandbox ----

describe("a quantity raise (recorded: yearly-raise, 2 units to 4 units on a yearly plan)", () => {
	const raised = async (candidate: { menu?: Menu; policy?: BillingPolicy }) => {
		const h = recordedHarness();
		deliverWithRetries(h, scenarioEvents("yearly-raise"));
		return whatIf(h, candidate, { env: "test", school: RECORDED_SCHOOL });
	};
	const raiseOf = (sim: InputsSimulation) =>
		sim.deliveries.find(
			(d) => d.type === "invoice.paid" && d.recorded.granted.visit === 19,
		);

	// By hand: 2 units on a yearly plan hold 12 monthly allowances of 1 visit each: 24 visits, as the first invoice grants.
	// The raise to 4 units adds 2 units, 2 x 12 = 24 in full. The raise invoice credits the old line for 216986 of its
	// 288000 cents, the share of the year left, 0.7534 (275 of 365 days): prorated that is 24 x 0.7534 = 18.08, rounded
	// up to 19. So the history holds 24 + 19 = 43 visits.
	test("prorated (as recorded): the raise grants 19, 43 visits", async () => {
		const sim = await raised({
			policy: policyOf({ upgradeGrant: "prorated" }),
		});
		expect(sim.differences).toBe(0);
		expect(raiseOf(sim)?.recorded.granted).toEqual({ visit: 19 });
		expect(recordedAvail(sim)).toBe(43);
	});

	test("full: the raise grants all 24, 48 visits", async () => {
		const sim = await raised({ policy: policyOf({ upgradeGrant: "full" }) });
		const raise = raiseOf(sim);
		expect(raise?.kind).toBe("changed");
		expect(raise?.candidate.granted).toEqual({ visit: 24 });
		expect(availOf(sim)).toBe(48);
		expect(sim.balanceChanges).toHaveLength(1);
		golden("inputs-raise-full.json", sim);
	});

	test("none: the raise grants nothing, 24 visits", async () => {
		const sim = await raised({ policy: policyOf({ upgradeGrant: "none" }) });
		expect(raiseOf(sim)?.candidate.granted).toEqual({});
		expect(availOf(sim)).toBe(24);
		golden("inputs-raise-none.json", sim);
	});

	// A tier that gives 2 visits a unit instead of 1, at prices $1000.00 higher: the first invoice grants 2 units x 12 months
	// x 2 = 48, the raise 2 x 12 x 2 = 48 in full, 48 x 0.7534 = 36.16 rounded up to 37 prorated. 48 + 37 = 85 visits.
	test("allowance 2 a unit and dearer prices: the sign-up grants 48, the raise 37, 85 visits", async () => {
		const candidate = withTier(recordedMenu, "sparkle", (tier) => ({
			...tier,
			prices: tier.prices.map((p) => ({ ...p, amount: p.amount + 100_000 })),
			grants: tier.grants.map((g) => ({ ...g, amount: 2 })),
		}));
		const sim = await raised({ menu: candidate });
		const raise = sim.deliveries.find(
			(d) => d.type === "invoice.paid" && d.recorded.granted.visit === 19,
		);
		expect(
			sim.deliveries
				.filter((d) => d.type === "invoice.paid")
				.map((d) => d.candidate.granted.visit),
		).toEqual([48, 37]);
		expect(raise?.candidate.granted).toEqual({ visit: 37 });
		expect(availOf(sim)).toBe(85);
		expect(recordedAvail(sim)).toBe(43);
		expect(sim.postingChanges.some((p) => p.commodity === "USD")).toBe(false);
		golden("inputs-raise-allowance.json", sim);
	});
});

// ---- Refusals ----

describe("a candidate that the rules refuse, and a refusal that the candidate accepts", () => {
	test("a menu without sparkle-2: its invoice is newly_refused, with the reason, and no credit follows", async () => {
		const sim = await whatIf(renewal(), {
			menu: { ...menu, tiers: menu.tiers.filter((t) => t.id !== "sparkle-2") },
		});
		expect(kinds(sim)).toEqual([
			["evt_in_1", "newly_refused"],
			["evt_cycle", "newly_refused"],
		]);
		expect(sim.deliveries[0]?.candidate.refused?.reason).toBe("unmatched_line");
		expect(sim.deliveries[0]?.candidate.granted).toEqual({});
		expect(availOf(sim)).toBeUndefined();
		// the money is Stripe's: the $260.00 + $260.00 stand; only the income account changes, from the tier's to "other",
		// because the refused invoice's tier is not on the menu
		const usd = sim.postingChanges.filter((p) => p.commodity === "USD");
		expect(
			usd.map((p) => [p.month, p.account, p.current, p.candidate]),
		).toEqual([
			["2026-01", "income:billing:membership:sparkle-2", "-260.00", "0.00"],
			["2026-01", "income:billing:other", "0.00", "-260.00"],
			["2026-02", "income:billing:membership:sparkle-2", "-260.00", "0.00"],
			["2026-02", "income:billing:other", "0.00", "-260.00"],
		]);
		expect(sim.differences).toBeGreaterThan(0);
	});

	// The handler's menu does not sell sparkle-1, so its first invoice is a stored 422 refusal (a payment line, no credit).
	// A candidate that sells it grants its 1 visit: newly_applied, from a SQLite source (which holds the refusals).
	test("a stored refusal that the candidate accepts is newly_applied: sparkle-1 grants 1 visit", async () => {
		const served = {
			...menu,
			tiers: menu.tiers.filter((t) => t.id !== "sparkle-1"),
		};
		const h = harness(undefined, { menu: served });
		const event: RawEvent = invoicePaid({
			eventId: "evt_s1",
			invoiceId: "in_s1",
			at: T0,
			subscriptionId: "sub_s1",
			reason: "subscription_create",
			periodStart: T0,
			periodEnd: T1,
			lines: [tierLine("sparkle-1")],
			metadata: METADATA,
		});
		expect(h.deliver(event).status).toBe(422);
		// the line names its price by id: the candidate publishes sparkle-1 under the id the family was charged
		const sim = await whatIf(h, {
			menu,
			priceIds: {
				[tierLine("sparkle-1").lookupKey]: priceIdOf(
					tierLine("sparkle-1").lookupKey,
				),
			},
		});
		expect(sim.baseline.identical).toBe(true);
		expect(kinds(sim)).toEqual([["evt_s1", "newly_applied"]]);
		expect(sim.deliveries[0]?.recorded.refused?.reason).toBe("unmatched_line");
		expect(sim.deliveries[0]?.candidate.granted).toEqual({ visit: 1 });
		expect(availOf(sim)).toBe(1);
	});

	// A full refund of the $260.00 invoice takes its 2 visits back (removeOnFullRefund, the default). A policy that keeps
	// them leaves 2 available instead of 0; the refund of the money stands.
	test("removeOnFullRefund: false keeps the 2 visits a full refund took back", async () => {
		const h = harness();
		h.deps.paymentRefs = () => ["pi_in_1", "ch_in_1"];
		h.deliver(paid());
		const { refund } = await import("./handler-harness.js");
		expect(h.deliver(refund(26000), T0 + HOUR).status).toBe(200);
		const sim = await whatIf(h, {
			policy: policyOf({ removeOnFullRefund: false }),
		});
		expect(sim.baseline.identical).toBe(true);
		expect(recordedAvail(sim)).toBe(0);
		expect(availOf(sim)).toBe(2);
		const refunded = sim.deliveries.find((d) => d.type === "charge.refunded");
		expect(refunded?.kind).toBe("changed");
		expect(refunded?.recorded.removed).toEqual({ visit: 2 });
		expect(refunded?.candidate.removed).toEqual({});
	});
});

// ---- What cannot be replayed ----

describe("not replayable: history before the inputs were stored", () => {
	/**
	 * A pays on 2026-01-15, then the inputs are wiped (the state of a database the handler of this version found: its
	 * history is in the log and not in the tables), then A's renewal on 2026-02-15 and a second family's first payment come in
	 * and are stored (A with a seed of its rows).
	 */
	const migrated = () => {
		const h = harness();
		h.deliver(paid("in_1"));
		for (const table of [
			"atm_event_inputs",
			"atm_input_contexts",
			"atm_input_seeds",
		])
			h.raw.exec(`DELETE FROM ${table}`);
		const cycle: RawEvent = invoicePaid({
			eventId: "evt_cycle",
			invoiceId: "in_cycle",
			at: T1,
			subscriptionId: "sub_1",
			reason: "subscription_cycle",
			periodStart: T1,
			periodEnd: addUtcMonths(T1, 1),
			lines: [tierLine("sparkle-2")],
			metadata: METADATA,
		});
		h.deliver(cycle, T1);
		h.deliver(
			invoicePaid({
				eventId: "evt_b",
				invoiceId: "in_b",
				at: T1 + HOUR,
				subscriptionId: "sub_b",
				reason: "subscription_create",
				periodStart: T1,
				periodEnd: addUtcMonths(T1, 1),
				lines: [tierLine("sparkle-1")],
				metadata: { b4u_school: SCHOOL, family_id: "fam_b" },
			}),
			T1 + HOUR,
		);
		return h;
	};

	// By hand: A's first payment made 2 events (the payment line and one credit grant) before any input was stored. They are
	// carried over unchanged and counted: 2 decisions of 1 holder, reason inputs_not_stored. A's renewal replays from the seed
	// (its rows after January: 2 visits) and B replays from nothing. 2 holders and 2 inputs are replayed.
	test("the decisions before the first stored input are counted, named, and carried over; the rest replays", async () => {
		const h = migrated();
		const sim = await whatIf(h, {
			menu: withTier(menu, "sparkle-2", (tier) => ({
				...tier,
				grants: tier.grants.map((g) => ({
					...g,
					rollover: { max: 1, months: 1 },
				})),
			})),
		});
		expect(sim.baseline.identical).toBe(true);
		expect(sim.notReplayable.items).toEqual([
			{
				subjectKey: `${SCHOOL}|live|family:${FAMILY}`,
				reason: "inputs_not_stored",
				decisions: 2,
				firstDecisionAt: new Date(T0).toISOString(),
			},
		]);
		expect(sim.notReplayable.decisions).toBe(2);
		expect(sim.notReplayable.holders).toBe(1);
		expect(sim.replayed).toEqual({ holders: 2, inputs: 2, carriedCommands: 0 });
		expect(sim.notReplayable.firstStoredEventId).toBe("evt_cycle");
		expect(sim.notReplayable.firstStoredAt).toBe(
			new Date(T1 + 20_000).toISOString(),
		);
		// the January grant stands (2 visits, in the seed), and the renewal rolls over 1 of them (candidate cap 1) instead of 2
		expect(kinds(sim)).toEqual([
			["evt_cycle", "changed"],
			["evt_b", "same"],
		]);
		expect(recordedAvail(sim)).toBe(4);
		expect(availOf(sim)).toBe(3);
		expect(sim.summary).toContain("not replayable: 2 decisions of 1 holders");
		expect(sim.summary).toContain("evt_cycle");
		golden("inputs-not-replayable.json", sim);
	});

	test("a holder with no seed at all (rows before its first stored input, none kept) is inputs_not_stored from its first decision", async () => {
		const h = harness();
		h.deliver(paid("in_1"));
		h.raw.exec("DELETE FROM atm_event_inputs");
		h.raw.exec("DELETE FROM atm_input_contexts");
		h.raw.exec("DELETE FROM atm_input_seeds");
		const cycle: RawEvent = invoicePaid({
			eventId: "evt_cycle",
			invoiceId: "in_cycle",
			at: T1,
			subscriptionId: "sub_1",
			reason: "subscription_cycle",
			periodStart: T1,
			periodEnd: addUtcMonths(T1, 1),
			lines: [tierLine("sparkle-2")],
			metadata: METADATA,
		});
		h.deliver(cycle, T1);
		h.raw.exec("DELETE FROM atm_input_seeds");
		const sim = await whatIf(h, {}, { allowBaselineDrift: false });
		expect(sim.baseline.identical).toBe(true);
		// the holder's whole history is carried over: the two payment lines, the two grants and the renewal's plan change
		expect(
			logOf(h)
				.map((e) => e.event_type)
				.sort(),
		).toEqual([
			"credit.granted",
			"credit.granted",
			"payment.succeeded",
			"payment.succeeded",
			"plan.changed",
		]);
		expect(sim.notReplayable.items.map((i) => [i.reason, i.decisions])).toEqual(
			[["inputs_not_stored", 5]],
		);
		expect(sim.replayed.inputs).toBe(0);
	});
});

describe("the candidate's journal", () => {
	const journalOf = async (events: readonly AtmEvent[]) => {
		const dir = await tmp("simulate-inputs-journal");
		const months = [...new Set(events.map((e) => e.date.slice(0, 7)))].sort();
		await mkdir(join(dir, "ledger/b4u"), { recursive: true });
		for (const month of months) {
			const build = buildJournal({ events, month });
			for (const [path, text] of Object.entries(build.files))
				await writeFile(join(dir, path), text);
		}
		return dir;
	};
	const hledger = (cwd: string, args: string[]) =>
		Bun.spawnSync(["hledger", "-f", "main.journal", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});

	test.skipIf(!hasHledger)(
		"hledger accepts it (balanced, accounts and commodities declared) and its credit accounts sum to zero",
		async () => {
			const sims = [
				await whatIf(planSwitch(), {
					policy: policyOf({ upgradeGrant: "full" }),
				}),
				await whatIf(planSwitch(), {
					policy: policyOf({ upgradeGrant: "none" }),
				}),
				await whatIf(renewal(), {
					menu: withTier(menu, "sparkle-2", (tier) => ({
						...tier,
						grants: tier.grants.map((g) => ({ ...g, amount: 3 })),
					})),
				}),
			];
			for (const sim of sims) {
				expect(sim.differences).toBeGreaterThan(0);
				const cwd = await journalOf(sim.events);
				const check = hledger(cwd, [
					"check",
					"balanced",
					"accounts",
					"commodities",
				]);
				expect(check.stderr.toString()).toBe("");
				expect(check.exitCode).toBe(0);
				const credits = hledger(cwd, [
					"bal",
					"credits:",
					"--flat",
					"-O",
					"csv",
				]);
				expect(credits.exitCode).toBe(0);
				expect(credits.stdout.toString().trim().split("\n").at(-1)).toMatch(
					/^"Total:","0"$/,
				);
			}
		},
	);

	test("without hledger: every candidate event is balanced per commodity, and the transactions are counted from the journal", async () => {
		const sim = await whatIf(planSwitch(), {
			policy: policyOf({ upgradeGrant: "full" }),
		});
		for (const e of sim.events) {
			const by = new Map<string, number>();
			for (const p of e.postings)
				by.set(p.commodity, (by.get(p.commodity) ?? 0) + Number(p.amount));
			expect([e.id, [...by.values()].every((v) => v === 0)]).toEqual([
				e.id,
				true,
			]);
		}
		for (const { month, candidate } of sim.transactions)
			expect(candidate).toBe(
				buildJournal({ events: sim.events, month }).transactions,
			);
	});
});

describe("the policy settings the booking calls decide", () => {
	test("a candidate that changes only cancelCutoffHours, noShow or lateCancel is refused: nothing to simulate", async () => {
		const h = harness();
		h.deliver(paid());
		for (const over of [
			{ cancelCutoffHours: 48 },
			{ noShow: "release" as const },
			{ lateCancel: "release" as const },
			{ cancelCutoffHours: 12, noShow: "release" as const },
		])
			await expect(whatIf(h, { policy: policyOf(over) })).rejects.toThrow(
				/decided by booking calls, which are not stored: nothing to simulate/,
			);
	});

	test("beside another change they are listed as not simulated, and the rest is computed", async () => {
		const sim = await whatIf(planSwitch(), {
			policy: policyOf({
				upgradeGrant: "full",
				cancelCutoffHours: 48,
				noShow: "release",
			}),
		});
		expect(sim.notSimulated).toEqual(["cancelCutoffHours", "noShow"]);
		expect(availOf(sim)).toBe(4);
		expect(sim.summary).toContain("not simulated: cancelCutoffHours, noShow");
	});

	test("the error is an InputsSimulateError", async () => {
		const h = harness();
		h.deliver(paid());
		await expect(
			whatIf(h, { policy: policyOf({ lateCancel: "release" }) }),
		).rejects.toBeInstanceOf(InputsSimulateError);
	});
});
