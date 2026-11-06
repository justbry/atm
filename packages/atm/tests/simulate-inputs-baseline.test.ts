/**
 * The baseline identity of `simulateFromInputs`: every input the real handler stored, decided again with the menu and policy
 * it was decided under, must give the events the handler put in the outbox, by `idem` and canonical body. This is the first
 * test of the replay; a what-if is only as good as it. Histories: the 8 recorded sandbox scenarios delivered through the
 * handler, and 300 seeded histories of `billing-play.ts` over the handler (some in order, some with deliveries held back and
 * retried after a 409, sent twice, failing once and retried, refused under a broken menu and applied later), with the
 * family service's spends and credit holds. Design: `docs/simulate-from-inputs.md`, sections 4 and 10.
 */
import { describe, expect, test } from "bun:test";
import { simulateFromInputs } from "../src/ledger/simulate-inputs.js";
import { canonicalize } from "../src/ledger/util.js";
import { play, SCHOOL } from "./billing-play.js";
import { RECORDED_SCHOOL } from "./e2e-recorded.js";
import { harness, paid } from "./handler-harness.js";
import { historyStore } from "./simulate-inputs-history.js";
import {
	baselineOf,
	deliverWithRetries,
	logOf,
	readStored,
	recordedHarness,
	SCENARIOS,
	scenarioEvents,
} from "./simulate-inputs-world.js";

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);
const STEPS = 14;
/** Seeds up to this one are delivered in order, the rest are what Stripe does. */
const PLAIN_SEEDS = 100;

describe("baseline identity: the recorded sandbox scenarios through the handler", () => {
	test.each(SCENARIOS)(
		"%s: the replay of the stored inputs is the outbox, event for event",
		async (scenario) => {
			const h = recordedHarness();
			deliverWithRetries(h, scenarioEvents(scenario));
			const { inputs, result, events } = await baselineOf(
				h,
				"test",
				RECORDED_SCHOOL,
			);
			expect(result.mismatches).toEqual([]);
			expect(result.notReplayable).toEqual([]);
			// every stored input ran, and the events are the outbox's, byte for byte
			expect(result.byInput.size).toBe(inputs.inputs.length);
			expect(canonicalize(result.events)).toBe(canonicalize(events));
			expect(events.length).toBeGreaterThan(0);
		},
	);

	test("the 8 scenarios in all: 44 inputs stored, the events of the outbox, and no candidate is the identity", async () => {
		let inputsTotal = 0;
		let eventsTotal = 0;
		for (const scenario of SCENARIOS) {
			const h = recordedHarness();
			deliverWithRetries(h, scenarioEvents(scenario));
			const events = logOf(h);
			const sim = simulateFromInputs({
				events,
				inputs: await readStored(h, "test", RECORDED_SCHOOL),
				env: "test",
				school: RECORDED_SCHOOL,
				candidate: {},
			});
			expect(sim.baseline.identical).toBe(true);
			expect(sim.differences).toBe(0);
			expect(sim.deliveries.every((d) => d.kind === "same")).toBe(true);
			inputsTotal += sim.baseline.inputs;
			eventsTotal += events.length;
		}
		expect(inputsTotal).toBe(44);
		expect(eventsTotal).toBe(39);
	});
});

describe("baseline identity: 300 seeded histories through the handler", () => {
	test("each reproduces the outbox exactly; a history with a credit hold is not replayed from the refund that follows it", async () => {
		const totals: Record<string, number> = {};
		let inputs = 0;
		let events = 0;
		let identical = 0;
		const flagged: string[] = [];
		const carried: number[] = [];
		for (const seed of SEEDS) {
			const h = harness();
			const store = historyStore(h, {
				seed,
				style: seed <= PLAIN_SEEDS ? "plain" : "mixed",
				bumpVersion: seed % 2 === 0,
			});
			play({ seed, steps: STEPS, store });
			store.flush();
			for (const [name, n] of Object.entries(store.counts))
				totals[name] = (totals[name] ?? 0) + n;
			const base = await baselineOf(h, "live", SCHOOL);
			// not a single input decided differently from the log
			expect({ seed, mismatches: base.result.mismatches }).toEqual({
				seed,
				mismatches: [],
			});
			inputs += base.result.byInput.size;
			events += base.events.length;
			// everything the replay leaves is the log's, in the log's order
			expect(canonicalize(base.result.events)).toBe(canonicalize(base.events));
			carried.push(base.result.carriedPayments.length);
			if (base.result.notReplayable.length === 0) identical += 1;
			else {
				// the only history left unreplayed is the one after a credit hold and an invoice-removing input
				for (const item of base.result.notReplayable)
					expect({ seed, reason: item.reason }).toEqual({
						seed,
						reason: "booking_writes",
					});
				flagged.push(String(seed));
			}
		}
		// the histories did what they were built to do
		expect(totals.deferred).toBeGreaterThan(50);
		expect(totals.duplicated).toBeGreaterThan(50);
		expect(totals.failed).toBeGreaterThan(30);
		expect(totals.refused).toBeGreaterThan(30);
		expect(totals.holds).toBeGreaterThan(20);
		expect(totals.spends).toBeGreaterThan(100);
		expect(inputs).toBeGreaterThan(1000);
		expect(events).toBeGreaterThan(2000);
		expect(identical + flagged.length).toBe(SEEDS.length);
		expect(identical).toBeGreaterThan(250);
		// refused first, applied later: the payment line of the refusal is the log's, and was carried, in many of them
		expect(carried.filter((n) => n > 0).length).toBeGreaterThan(5);
	});
});

describe("what the replay does not trust", () => {
	test("a permanent refusal (a price the menu does not know) books its payment line, and the replay of the refusal makes the same line", async () => {
		const h = harness({ in_1: 300 });
		const event = paid("in_1");
		// the line's price is not the menu's: 422 unmatched_line, with the payment line booked and no credit
		event.data.object.lines.data[0].pricing.price_details.price =
			"price_unknown";
		const object = event.data.object;
		for (const l of object.lines.data)
			l.price = { id: "price_unknown", lookup_key: "b4u_unknown_key" };
		const response = h.deliver(event);
		expect(response.status).toBe(422);
		const base = await baselineOf(h, "live", "sch_vol");
		expect(base.inputs.inputs).toEqual([]);
		expect(base.inputs.refused).toHaveLength(1);
		expect(base.result.mismatches).toEqual([]);
		expect(base.result.byInput.get("evt_in_1")?.refused?.reason).toBe(
			"unmatched_line",
		);
		expect(base.events.map((e) => e.event_type)).toEqual(["payment.succeeded"]);
		expect(canonicalize(base.result.events)).toBe(canonicalize(base.events));
	});
});
