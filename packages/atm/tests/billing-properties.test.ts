/**
 * Seeded random sequences of what happens to one family's membership: pay, upgrade, downgrade, renew, refund (full and
 * partial), dispute (open, won, lost), cancel, with gifts and the family's own spending between. Each sequence goes through
 * `handleStripeEvent` as the family service would call it, and these must hold after every step:
 *   - no credit row or rollover is ever below zero;
 *   - every event's postings sum to zero in each commodity;
 *   - the same inputs give the same rows and events, byte for byte;
 *   - one grant per invoice: handling any event a second time changes nothing;
 *   - replaying the log through the engine ends on the rows and balances the write path ended with.
 * A failing seed is the seed in the test name: run it alone to see the sequence.
 */
import { describe, expect, test } from "bun:test";
import { menuCatalogRows } from "../src/billing/grants.js";
import { grantsFromRows } from "../src/billing/rows.js";
import { replayEvents } from "../src/ledger/replay.js";
import type { AtmEvent } from "../src/types.js";
import { FAMILY, HOUR, menu, play, SCHOOL } from "./billing-play.js";
import { createStore, engineRowsOf } from "./billing-store.js";

const sumsToZero = (e: AtmEvent) => {
	const by = new Map<string, number>();
	for (const p of e.postings)
		by.set(p.commodity, (by.get(p.commodity) ?? 0) + Number(p.amount));
	return [...by.values()].every((v) => v === 0);
};

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

describe("random histories of one family", () => {
	test.each(SEEDS)(
		"seed %d: no balance below zero, every event balanced, one grant per invoice",
		(seed) => {
			const store = createStore({ menu, school: SCHOOL, family: FAMILY });
			const { sent, violations } = play({ seed, steps: 40, store });
			expect(violations).toEqual([]);
			for (const e of store.events) expect(sumsToZero(e)).toBe(true);

			// one grant per invoice: every invoice paid has one record, with each row once
			const grants = grantsFromRows(store.rows);
			const paid = sent.filter(
				(s) => (s.event as { type: string }).type === "invoice.paid",
			);
			expect(Object.keys(grants.invoices).sort()).toEqual(
				paid
					.map(
						(s) =>
							(s.event as { data: { object: { id: string } } }).data.object.id,
					)
					.sort(),
			);
			for (const record of Object.values(grants.invoices)) {
				const rowIds = record.granted.map((g) => g.rowId);
				expect(new Set(rowIds).size).toBe(rowIds.length);
			}

			// and handling any event again, in any order, writes nothing and says nothing new
			const before = JSON.stringify({
				rows: store.rows,
				events: store.events,
				revision: store.revision,
			});
			for (const { event, at } of [...sent].reverse()) {
				const again = store.handle(event, at);
				const id = (event as { id: string }).id;
				// a refusal has the same empty shape, so say it was not one
				expect([id, again.refused]).toEqual([id, undefined]);
				expect([id, again.rowChanges]).toEqual([id, null]);
				// a refund says its money line again, with the same idem: the log already holds it (the outbox drops it)
				expect([
					id,
					again.events.filter(
						(e) => !store.events.some((k) => k.idem === e.idem),
					),
				]).toEqual([id, []]);
			}
			expect(
				JSON.stringify({
					rows: store.rows,
					events: store.events,
					revision: store.revision,
				}),
			).toBe(before);
		},
	);

	test.each(SEEDS.slice(0, 20))(
		"seed %d: the same inputs give the same rows and events, byte for byte",
		(seed) => {
			const run = () => {
				const store = createStore({ menu, school: SCHOOL, family: FAMILY });
				play({ seed, steps: 40, store });
				return JSON.stringify({
					rows: store.rows,
					events: store.events,
					revision: store.revision,
				});
			};
			expect(run()).toBe(run());
		},
	);

	test.each(SEEDS)(
		"seed %d: replaying the log through the engine ends on the rows and balances the write path ended with",
		(seed) => {
			const store = createStore({ menu, school: SCHOOL, family: FAMILY });
			play({ seed, steps: 40, store });
			const catalog = menuCatalogRows({ menu, school: SCHOOL });
			const replayed = replayEvents({ events: store.events, catalog });
			expect(engineRowsOf(replayed.snapshot.states[store.holder])).toBe(
				engineRowsOf(store.engineState()),
			);
			const last = Date.parse(replayed.asOf as string);
			for (const asOf of [
				last,
				last + 40 * 24 * HOUR,
				last + 400 * 24 * HOUR,
			]) {
				const again = replayEvents({
					events: store.events,
					catalog,
					asOf: new Date(asOf).toISOString(),
				});
				for (const feature of ["visit", "retreat"])
					expect([
						asOf,
						feature,
						again.balances.find((b) => b.feature === feature)?.avail ?? 0,
					]).toEqual([asOf, feature, store.avail(asOf, feature)]);
			}
		},
	);

	test("the histories cover every kind of step", () => {
		const types = new Map<string, number>();
		let credits = 0;
		for (const seed of SEEDS) {
			const store = createStore({ menu, school: SCHOOL, family: FAMILY });
			const { sent } = play({ seed, steps: 40, store });
			for (const { event } of sent) {
				const e = event as {
					type: string;
					data: { object: { billing_reason?: string; status?: string } };
				};
				const key = [
					e.type,
					e.data.object.billing_reason ?? e.data.object.status ?? "",
				].join(" ");
				types.set(key, (types.get(key) ?? 0) + 1);
			}
			credits += store.events.length;
		}
		for (const key of [
			"invoice.paid subscription_create",
			"invoice.paid subscription_cycle",
			"invoice.paid subscription_update",
			"invoice.paid manual",
			"charge.refunded succeeded",
			"charge.dispute.created needs_response",
			"charge.dispute.closed won",
			"charge.dispute.closed lost",
			"customer.subscription.deleted canceled",
		])
			expect(types.get(key) ?? 0).toBeGreaterThan(0);
		expect(credits).toBeGreaterThan(300);
	});
});
