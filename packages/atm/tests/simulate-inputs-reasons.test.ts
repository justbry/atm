/**
 * Why a holder's history is not replayed, in the order the design checks them (`docs/simulate-from-inputs.md`, decision 19
 * as narrowed): `erased`, `inputs_not_stored`, `context_missing`, `non_input_writes`, `booking_writes`. Each is carried over
 * unchanged and counted; the rest of the school replays. A holder with a credit hold is replayed until a refund or lost
 * dispute that can take the held credits back.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import { eraseStoredInputs } from "../src/handler/inputs.js";
import { simulateFromInputs } from "../src/ledger/simulate-inputs.js";
import type { BillingPolicy } from "../src/types.js";
import {
	menu,
	FAMILY as PLAY_FAMILY,
	SCHOOL as PLAY_SCHOOL,
} from "./billing-play.js";
import { harness, T0 } from "./handler-harness.js";
import { historyStore } from "./simulate-inputs-history.js";
import { logOf, readStored } from "./simulate-inputs-world.js";
import { chargeRefunded, invoicePaid } from "./stripe-events.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HOLDER = `${PLAY_SCHOOL}|live|family:${PLAY_FAMILY}`;
const GROSS = 26000;

const sparkle2 = () => ({
	lookupKey: lookupKeyOf(
		PLAY_SCHOOL,
		tierPriceKey("sparkle-2", "month"),
		GROSS,
		menu.currency,
	),
	amount: GROSS,
	interval: "month" as const,
});

const payment = (id: string, at: number) =>
	invoicePaid({
		eventId: `evt_${id}`,
		invoiceId: id,
		at,
		subscriptionId: "sub_1",
		reason: "subscription_create",
		periodStart: at,
		periodEnd: at + 30 * DAY,
		lines: [sparkle2()],
		metadata: { b4u_school: PLAY_SCHOOL, family_id: PLAY_FAMILY },
	});

const renewal = (id: string, at: number) =>
	invoicePaid({
		eventId: `evt_${id}`,
		invoiceId: id,
		at,
		subscriptionId: "sub_1",
		reason: "subscription_cycle",
		periodStart: at,
		periodEnd: at + 30 * DAY,
		lines: [sparkle2()],
		metadata: { b4u_school: PLAY_SCHOOL, family_id: PLAY_FAMILY },
	});

const fullRefund = (invoiceId: string, at: number) =>
	chargeRefunded({
		eventId: `evt_re_${invoiceId}`,
		chargeId: `ch_${invoiceId}`,
		invoiceId,
		amount: GROSS,
		chargeAmount: GROSS,
		at,
	});

const policy = (over: Partial<BillingPolicy>): BillingPolicy => ({
	...DEFAULT_POLICY,
	...over,
});

const world = () => {
	const h = harness();
	const store = historyStore(h, { seed: 1, style: "plain" });
	return { h, store };
};

const simulate = async (
	h: ReturnType<typeof harness>,
	candidate: Parameters<typeof simulateFromInputs>[0]["candidate"],
	current: Parameters<typeof simulateFromInputs>[0]["current"] = undefined,
) =>
	simulateFromInputs({
		...(current ? { current } : {}),
		events: logOf(h),
		inputs: await readStored(h, "live", PLAY_SCHOOL),
		env: "live",
		school: PLAY_SCHOOL,
		candidate,
	});

describe("booking_writes: a credit hold, then a refund that can take credits back", () => {
	// By hand: the invoice grants 2 visits; the family service holds 1 (a booking: a lock row, a credit.held event), settles it
	// as spent, and the invoice is then refunded in full. The refund reads the booking records, which the replay does not
	// reproduce, so the holder is replayed up to the refund and the refund's own decisions (the refunded payment line and the
	// credit adjustment: 2 events) are carried over unchanged.
	test("replayed up to the refund; the refund and what follows is carried, counted and named", async () => {
		const { h, store } = world();
		store.handle(payment("in_1", T0), T0);
		store.spend(1, T0 + DAY, "hold");
		store.handle(fullRefund("in_1", T0 + 2 * DAY), T0 + 2 * DAY);
		const sim = await simulate(h, {
			policy: policy({ removeOnFullRefund: false }),
		});
		expect(sim.baseline.identical).toBe(true);
		expect(sim.notReplayable.items).toEqual([
			{
				subjectKey: HOLDER,
				reason: "booking_writes",
				decisions: 2,
				firstDecisionAt: new Date(T0 + 2 * DAY).toISOString(),
			},
		]);
		// the payment ran (and the hold was carried); the refund did not, so the candidate cannot change it
		expect(sim.deliveries.map((d) => [d.eventId, d.kind])).toEqual([
			["evt_in_1", "same"],
		]);
		expect(sim.replayed.carriedCommands).toBe(2);
		expect(sim.differences).toBe(0);
	});

	test("a hold with no refund after it replays whole: the candidate changes what the invoice grants", async () => {
		const { h, store } = world();
		store.handle(payment("in_1", T0), T0);
		store.spend(1, T0 + DAY, "hold");
		const sim = await simulate(h, {
			menu: {
				...menu,
				tiers: menu.tiers.map((t) =>
					t.id === "sparkle-2"
						? { ...t, grants: t.grants.map((g) => ({ ...g, amount: 3 })) }
						: t,
				),
			},
		});
		expect(sim.baseline.identical).toBe(true);
		expect(sim.notReplayable.items).toEqual([]);
		expect(sim.replayed.carriedCommands).toBe(2);
		// 3 granted, 1 held and spent: 2 left, against 1
		const visit = (side: "current" | "candidate") =>
			sim.balances[side].find((b) => b.feature === "visit")?.avail;
		expect([visit("current"), visit("candidate")]).toEqual([1, 2]);
	});

	test("a hold, then an input that cannot take credits back (a renewal): replayed whole, nothing flagged", async () => {
		const { h, store } = world();
		store.handle(payment("in_1", T0), T0);
		store.spend(1, T0 + DAY, "hold");
		store.handle(renewal("in_2", T0 + 3 * DAY), T0 + 3 * DAY);
		const sim = await simulate(h, {});
		expect(sim.baseline.identical).toBe(true);
		expect(sim.notReplayable.items).toEqual([]);
		expect(sim.replayed).toEqual({ holders: 1, inputs: 2, carriedCommands: 2 });
	});

	test("a refund with no hold before it replays whole: removeOnFullRefund: false keeps the 2 visits", async () => {
		const { h, store } = world();
		store.handle(payment("in_1", T0), T0);
		store.handle(fullRefund("in_1", T0 + 2 * DAY), T0 + 2 * DAY);
		const sim = await simulate(h, {
			policy: policy({ removeOnFullRefund: false }),
		});
		expect(sim.notReplayable.items).toEqual([]);
		const visit = (side: "current" | "candidate") =>
			sim.balances[side].find((b) => b.feature === "visit")?.avail;
		expect([visit("current"), visit("candidate")]).toEqual([0, 2]);
	});
});

describe("the version labels come from the input's own row", () => {
	// The context hash covers the menu, policy and price ids and not their version labels, so a version bump with the same
	// content shares one context row (version 3). The second delivery was decided under version 4 and its events say so.
	test("a menu version bumped with no change to the menu: the replay labels each input with its own version", async () => {
		const { h, store } = world();
		store.handle(payment("in_1", T0), T0);
		const context = h.deps.context;
		h.deps.context = (school) => {
			const was = context(school);
			return was ? { ...was, menuVersion: 4, policyVersion: 2 } : was;
		};
		store.handle(renewal("in_2", T0 + 3 * DAY), T0 + 3 * DAY);
		const sim = await simulate(h, {});
		expect(sim.baseline.identical).toBe(true);
		expect(
			logOf(h)
				.filter((e) => e.labels.menu_version !== undefined)
				.map((e) => [e.labels.menu_version, e.labels.policy_version]),
		).toEqual([
			["3", "1"],
			["3", "1"],
			["4", "2"],
			["4", "2"],
		]);
		expect((await readStored(h, "live", PLAY_SCHOOL)).contexts.size).toBe(1);
	});
});

describe("non_input_writes: a write that is neither a stored input nor a logged command", () => {
	test("a spend the family service did not log leaves a revision gap: the holder's next input is carried, with the reason", async () => {
		const { h, store } = world();
		store.handle(payment("in_1", T0), T0);
		store.spend(1, T0 + DAY, "spend", { log: false });
		store.handle(renewal("in_2", T0 + 3 * DAY), T0 + 3 * DAY);
		const sim = await simulate(h, {});
		expect(sim.baseline.identical).toBe(true);
		// the renewal, carried over, made 2 events: the payment line and the plan change
		expect(
			logOf(h)
				.filter((e) => Date.parse(e.event_time) >= T0 + 3 * DAY)
				.map((e) => e.event_type),
		).toEqual(["payment.succeeded", "plan.changed"]);
		expect(sim.notReplayable.items.map((i) => [i.reason, i.decisions])).toEqual(
			[["non_input_writes", 2]],
		);
		expect(sim.replayed.inputs).toBe(1);
	});
});

describe("erased: a holder whose inputs are tombstones", () => {
	test("its history is carried over, counted, and still excluded when a new event for it is stored after the erasure", async () => {
		const { h, store } = world();
		store.handle(payment("in_1", T0), T0);
		store.handle(payment("in_2", T0 + 3 * DAY), T0 + 3 * DAY);
		const erased = h.db.transaction(() =>
			eraseStoredInputs(h.db, {
				env: "live",
				school: PLAY_SCHOOL,
				subjectKey: HOLDER,
				nowMs: T0 + 5 * DAY,
			}),
		);
		expect(erased.inputs).toBe(2);
		// the erasure does not stop a new event for the holder from being stored afterwards
		store.handle(payment("in_3", T0 + 6 * DAY), T0 + 6 * DAY);
		// another family is replayed as usual
		store.handle(
			invoicePaid({
				eventId: "evt_other",
				invoiceId: "in_other",
				at: T0 + 7 * DAY,
				subscriptionId: "sub_o",
				reason: "subscription_create",
				periodStart: T0,
				periodEnd: T0 + 30 * DAY,
				lines: [sparkle2()],
				metadata: { b4u_school: PLAY_SCHOOL, family_id: "fam_other" },
			}),
			T0 + 7 * DAY,
		);
		const sim = await simulate(h, {});
		expect(sim.baseline.identical).toBe(true);
		expect(sim.notReplayable.items).toHaveLength(1);
		const [item] = sim.notReplayable.items;
		expect(item?.reason).toBe("erased");
		expect(item?.subjectKey).toBe(HOLDER);
		// the holder's events: two payment lines and two grants, plus the one stored after the erasure (one of each)
		expect(item?.decisions).toBe(
			logOf(h).filter((e) => e.key === `family:${PLAY_FAMILY}`).length,
		);
		expect(sim.replayed).toEqual({ holders: 1, inputs: 1, carriedCommands: 0 });
	});
});

describe("context_missing: the menu and policy an input was decided under are not in the source", () => {
	test("the holder is carried from that input, named, and the other holders replay", async () => {
		const { h, store } = world();
		store.handle(payment("in_1", T0), T0);
		h.raw.exec("DELETE FROM atm_input_contexts");
		const sim = await simulate(h, {}, { menu });
		expect(sim.notReplayable.items.map((i) => [i.reason, i.decisions])).toEqual(
			[["context_missing", 2]],
		);
		expect(sim.replayed.inputs).toBe(0);
	});
});
