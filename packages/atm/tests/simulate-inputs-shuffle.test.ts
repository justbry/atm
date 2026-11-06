import { expect, test } from "bun:test";
import { makeRng } from "../fixtures/rng.js";
import { canonicalize } from "../src/ledger/util.js";
import { play, SCHOOL } from "./billing-play.js";
import { harness } from "./handler-harness.js";
import { baselineOf } from "./simulate-inputs-world.js";

const FROM = 5000;
const TO = 5150;

/**
 * Baseline identity over histories delivered in a random order, a fifth of them twice, with every 409 retried (refunds before
 * their invoice, raises out of order): the outbox is what the replay of the stored inputs makes.
 */
test("fully shuffled deliveries with duplicates and retries", async () => {
	const bad: string[] = [];
	let flagged = 0;
	let inputs = 0;
	let refusedRows = 0;
	for (let seed = FROM; seed < TO; seed++) {
		const sent: { event: unknown; at: number }[] = [];
		play({
			seed,
			steps: 25,
			store: {
				handle: (event, at) => {
					sent.push({ event, at });
					return { refused: null };
				},
				spend: () => {},
				avail: () => 0,
				rows: [],
			},
		});
		const h = harness();
		h.deps.claimStaleAfterMs = 1;
		h.deps.paymentRefs = (raw) => {
			const id = (raw as { data: { object: { id: string } } }).data.object.id;
			return [`pi_${id}`, `ch_${id}`];
		};
		const rng = makeRng(`shuffle-${seed}`);
		const order = [...sent];
		for (let i = order.length - 1; i > 0; i--) {
			const j = rng.int(0, i);
			[order[i], order[j]] = [order[j] as never, order[i] as never];
		}
		const deliveries = order.flatMap((x) => (rng.next() < 0.2 ? [x, x] : [x]));
		let last = 0;
		let pending = deliveries;
		for (let pass = 0; pass < 12 && pending.length > 0; pass++) {
			const retry: typeof pending = [];
			for (const d of pending) {
				last = Math.max(last, d.at) + 1000;
				const r = h.deliver(d.event as never, last);
				if (r.status === 409) retry.push(d);
			}
			pending = retry;
		}
		const base = await baselineOf(h, "live", SCHOOL);
		inputs += base.inputs.inputs.length;
		refusedRows += base.inputs.refused.length;
		if (base.result.mismatches.length > 0)
			bad.push(
				`${seed}: ${JSON.stringify(base.result.mismatches).slice(0, 250)}`,
			);
		if (canonicalize(base.result.events) !== canonicalize(base.events))
			bad.push(`${seed}: events differ`);
		if (base.result.notReplayable.length > 0) {
			flagged += 1;
			for (const n of base.result.notReplayable)
				if (n.reason !== "booking_writes") bad.push(`${seed}: ${n.reason}`);
		}
	}
	expect(inputs).toBeGreaterThan(1000);
	expect(refusedRows).toBeGreaterThan(30);
	expect(flagged).toBe(0);
	expect(bad).toEqual([]);
}, 600000);
