/**
 * Review findings on the baseline of `simulateFromInputs` (PR #97), each a history through the real handler:
 *  - an invoice refused (422) twice under two different menu versions and never applied: the outbox keeps the payment line of
 *    the first refusal, the stored row has only the second's context;
 *  - an invoice refused, then another invoice of the holder applied, then the first refused again: the refused row keeps its
 *    first place but the revision of its last attempt, which is no revision gap;
 *  - a holder that stopped at an input that decided nothing is still said to be not replayable;
 *  - a lost dispute with no money that a candidate that keeps the credits makes `no_longer_applied`.
 */
import { describe, expect, test } from "bun:test";
import { menuCatalogRows } from "../src/billing/grants.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { simulateFromInputs } from "../src/ledger/simulate-inputs.js";
import { SCHOOL as PLAY_SCHOOL, play } from "./billing-play.js";
import {
	FAMILY,
	FEE,
	GROSS,
	harness,
	menu,
	paid,
	refund,
	SCHOOL,
	T0,
	T1,
	tierKey,
} from "./handler-harness.js";
import { historyStore } from "./simulate-inputs-history.js";
import { baselineOf, logOf, readStored } from "./simulate-inputs-world.js";
import {
	disputeEvent,
	invoicePaid,
	priceIdOf,
	type RawEvent,
} from "./stripe-events.js";

const HOUR = 3_600_000;
const metadata = { b4u_school: SCHOOL, family_id: FAMILY };
const menuWithoutSparkle2: Menu = {
	...menu,
	tiers: menu.tiers.filter((tier) => tier.id !== "sparkle-2"),
};

/** The context of an endpoint that serves `served` under the given menu version label. */
const contextOf = (served: Menu, menuVersion: number) => () => ({
	menu: served,
	menuVersion,
	policy: DEFAULT_POLICY,
	policyVersion: 1,
	catalog: menuCatalogRows({ menu: served, school: SCHOOL, env: "live" }),
	priceIds: Object.fromEntries(
		[...Object.keys(menuPriceIds)].map((key) => [key, priceIdOf(key)]),
	),
});
const menuPriceIds = Object.fromEntries(
	menu.tiers.flatMap((tier) =>
		tier.prices.map((price) => [
			lookupKeyOf(
				SCHOOL,
				tierPriceKey(tier.id, price.interval),
				price.amount,
				menu.currency,
			),
			true,
		]),
	),
);

const sparkle2Invoice = (): RawEvent =>
	invoicePaid({
		eventId: "evt_in_1",
		invoiceId: "in_1",
		at: T0,
		subscriptionId: "sub_1",
		reason: "subscription_create",
		periodStart: T0,
		periodEnd: T1,
		lines: [{ lookupKey: tierKey(), amount: GROSS, interval: "month" }],
		metadata,
	});

const sparkle1Invoice = (): RawEvent => {
	const price = menu.tiers
		.find((tier) => tier.id === "sparkle-1")
		?.prices.find((p) => p.interval === "month")?.amount as number;
	return invoicePaid({
		eventId: "evt_in_2",
		invoiceId: "in_2",
		at: T0 + HOUR,
		subscriptionId: "sub_1",
		reason: "subscription_create",
		periodStart: T0,
		periodEnd: T1,
		lines: [
			{
				lookupKey: lookupKeyOf(
					SCHOOL,
					tierPriceKey("sparkle-1", "month"),
					price,
					menu.currency,
				),
				amount: price,
				interval: "month",
			},
		],
		metadata,
	});
};

describe("a payment line booked by a refusal that is not the last", () => {
	test("refused under menu version 3, refused again under version 4, never applied: the baseline holds, the first line is carried", async () => {
		const h = harness({ in_1: FEE }, { menu: menuWithoutSparkle2 });
		h.deps.context = contextOf(menuWithoutSparkle2, 3);
		expect(h.deliver(sparkle2Invoice(), T0).status).toBe(422);
		h.deps.context = contextOf(menuWithoutSparkle2, 4);
		expect(h.deliver(sparkle2Invoice(), T0 + HOUR).status).toBe(422);
		// the outbox keeps the first refusal's line, labelled with version 3
		expect(logOf(h).map((e) => e.labels.menu_version)).toEqual(["3"]);
		const base = await baselineOf(h, "live", SCHOOL);
		expect(base.result.mismatches).toEqual([]);
		expect(base.result.carriedPayments).toEqual(["evt_in_1"]);
		// a candidate does not decide that line again (the version label of the log stays)
		const sim = simulateFromInputs({
			events: logOf(h),
			inputs: await readStored(h, "live", SCHOOL),
			env: "live",
			school: SCHOOL,
			candidate: {},
		});
		expect(sim.baseline.identical).toBe(true);
		expect(sim.baseline.carriedPayments).toBe(1);
		expect(sim.differences).toBe(0);
	});
});

describe("a refusal that is refused again after the holder moved on", () => {
	test("the holder is replayed whole: no revision gap, the refusal is decided where its last attempt was", async () => {
		const h = harness({ in_1: FEE, in_2: FEE }, { menu: menuWithoutSparkle2 });
		h.deps.context = contextOf(menuWithoutSparkle2, 3);
		expect(h.deliver(sparkle2Invoice(), T0).status).toBe(422);
		// another invoice of the same holder is applied (the menu sells sparkle-1), then Stripe retries the first
		expect(h.deliver(sparkle1Invoice(), T0 + HOUR).status).toBe(200);
		expect(h.deliver(sparkle2Invoice(), T0 + 2 * HOUR).status).toBe(422);
		const inputs = await readStored(h, "live", SCHOOL);
		const [refusal] = inputs.refused;
		const [applied] = inputs.inputs;
		// the stored shape that made it a gap: the refusal keeps its place and takes the later revision
		expect(refusal?.appliedOrder).toBeLessThan(applied?.appliedOrder ?? 0);
		expect(refusal?.revisionBefore).toBeGreaterThan(
			applied?.revisionBefore ?? 0,
		);
		const base = await baselineOf(h, "live", SCHOOL);
		expect(base.result.mismatches).toEqual([]);
		expect(base.result.notReplayable).toEqual([]);
		expect(base.result.byInput.size).toBe(2);
		const sim = simulateFromInputs({
			events: logOf(h),
			inputs,
			env: "live",
			school: SCHOOL,
			candidate: {},
		});
		expect(sim.differences).toBe(0);
		expect(sim.notReplayable.items).toEqual([]);
		expect(sim.replayed.inputs).toBe(2);
	});
});

describe("a holder that stops at an input that decided nothing", () => {
	// seed 1193 of the seeded histories: a credit hold, then a lost dispute with no money in it (no event), which the baseline
	// cannot replay (booking_writes); there is no decision left to carry, and the holder was left out of the report
	test("is reported, with no decision to carry", async () => {
		const seed = 1193;
		const h = harness();
		const store = historyStore(h, { seed, style: "mixed", bumpVersion: true });
		play({ seed, steps: 14, store });
		store.flush();
		const base = await baselineOf(h, "live", PLAY_SCHOOL);
		expect(base.result.mismatches).toEqual([]);
		expect(base.result.notReplayable).toHaveLength(1);
		expect(base.result.notReplayable[0]).toMatchObject({
			reason: "booking_writes",
			decisions: 0,
		});
		const sim = simulateFromInputs({
			events: base.events,
			inputs: base.inputs,
			env: "live",
			school: PLAY_SCHOOL,
			candidate: {},
		});
		expect(sim.notReplayable.holders).toBe(1);
		expect(sim.summary).toContain("not replayable: 0 decisions of 1 holders");
	});
});

describe("a delivery the candidate no longer applies", () => {
	test("a lost dispute with no money took 2 visits back; a policy that keeps them makes it no_longer_applied", async () => {
		const h = harness();
		h.deps.paymentRefs = () => ["pi_in_1", "ch_in_1"];
		h.deliver(paid());
		const lost = disputeEvent({
			type: "charge.dispute.closed",
			eventId: "evt_dp_1",
			disputeId: "dp_1",
			chargeId: "ch_in_1",
			invoiceId: "in_1",
			status: "lost",
			at: T0 + HOUR,
		});
		expect(h.deliver(lost, T0 + HOUR).status).toBe(200);
		const sim = simulateFromInputs({
			events: logOf(h),
			inputs: await readStored(h, "live", SCHOOL),
			env: "live",
			school: SCHOOL,
			candidate: { policy: { ...DEFAULT_POLICY, removeOnLostDispute: false } },
		});
		expect(sim.baseline.identical).toBe(true);
		expect(
			sim.deliveries.map((d) => [d.eventId, d.kind, d.recorded.removed]),
		).toEqual([
			["evt_in_1", "same", {}],
			["evt_dp_1", "no_longer_applied", { visit: 2 }],
		]);
		expect(
			sim.balanceChanges.map((b) => [b.current.avail, b.candidate.avail]),
		).toEqual([[0, 2]]);
	});
});

describe("a refund of an invoice the candidate refuses", () => {
	test("waits as the handler would (409 unmatched_invoice): newly_refused, nothing decided", async () => {
		const h = harness();
		h.deps.paymentRefs = () => ["pi_in_1", "ch_in_1"];
		h.deliver(paid());
		expect(h.deliver(refund(GROSS), T0 + HOUR).status).toBe(200);
		const sim = simulateFromInputs({
			events: logOf(h),
			inputs: await readStored(h, "live", SCHOOL),
			env: "live",
			school: SCHOOL,
			candidate: { menu: menuWithoutSparkle2 },
		});
		expect(
			sim.deliveries.map((d) => [
				d.eventId,
				d.kind,
				d.candidate.refused?.reason,
			]),
		).toEqual([
			["evt_in_1", "newly_refused", "unmatched_line"],
			["evt_re_1", "newly_refused", "unmatched_invoice"],
		]);
		expect(sim.deliveries[1]?.candidate.events).toBe(0);
	});
});
