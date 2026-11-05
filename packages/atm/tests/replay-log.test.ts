/**
 * The log `handleStripeEvent` writes, replayed through the engine. The engine's decisions from the recorded commands
 * must give the rows the live write path ended with, and the balances it counted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import {
	ReplayError,
	replayEvents,
	replayOrder,
} from "../src/ledger/replay.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent } from "../src/types.js";
import { createStore, engineRowsOf } from "./billing-store.js";
import { invoicePaid, subscriptionDeleted } from "./stripe-events.js";

const SCHOOL = "sch_vol";
const FAMILY = "fam_replay";
const menu = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../fixtures/billing/grants/menu.json"),
		"utf8",
	),
) as Menu;
const catalogRows = menuCatalogRows({ menu, school: SCHOOL });
const metadata = { b4u_school: SCHOOL, family_id: FAMILY };
const T0 = Date.parse("2026-01-15T18:00:00Z");
const T1 = Date.parse("2026-02-15T18:00:00Z");
const T2 = Date.parse("2026-03-15T18:00:00Z");

const priceOf = (tierId: string) =>
	menu.tiers
		.find((t) => t.id === tierId)
		?.prices.find((p) => p.interval === "month")?.amount as number;

const payment = ({
	tierId,
	reason,
	start,
	end,
	invoice,
}: {
	tierId: string;
	reason: "subscription_create" | "subscription_cycle";
	start: number;
	end: number;
	invoice: string;
}) =>
	invoicePaid({
		eventId: `evt_${invoice}`,
		invoiceId: invoice,
		at: start + 10_000,
		subscriptionId: "sub_1",
		reason,
		periodStart: start,
		periodEnd: end,
		lines: [
			{
				lookupKey: lookupKeyOf(
					SCHOOL,
					tierPriceKey(tierId, "month"),
					priceOf(tierId),
					menu.currency,
				),
				amount: priceOf(tierId),
				interval: "month",
			},
		],
		metadata,
	});

const newStore = () => createStore({ menu, school: SCHOOL, family: FAMILY });

describe("replaying the log the write path made", () => {
	test("a sparkle-4 create replays to the live balances", () => {
		const store = newStore();
		store.handle(
			payment({
				tierId: "sparkle-4",
				reason: "subscription_create",
				start: T0,
				end: T1,
				invoice: "in_1",
			}),
			T0 + 10_000,
		);
		const replayed = replayEvents({
			events: store.events,
			catalog: catalogRows,
		});
		expect(engineRowsOf(replayed.snapshot.states[store.holder])).toBe(
			engineRowsOf(store.engineState()),
		);
		for (const feature of ["visit", "retreat"])
			expect(
				replayed.balances.find((b) => b.feature === feature)?.avail ?? 0,
			).toBe(store.avail(T0 + 20_000, feature));
	});

	test("the write's reset has an earlier time than its plan but replays after it, and a cursor is a place in that order", () => {
		const store = newStore();
		store.handle(
			payment({
				tierId: "sparkle-4",
				reason: "subscription_create",
				start: T0,
				end: T1,
				invoice: "in_1",
			}),
			T0 + 10_000,
		);
		const order = replayOrder(store.events);
		const commands = order.map(
			(e) => (e.payload.command as { type: string }).type,
		);
		expect(commands[0]).toBe("applyBillingPlan");
		expect(commands).toContain("reset");
		const ids = store.events.map((e) => e.id);
		expect([...ids].sort()).not.toEqual(order.map((e) => e.id));

		const whole = replayEvents({ events: store.events, catalog: catalogRows });
		const firstEvent = order[0] as AtmEvent;
		const part = replayEvents({
			events: store.events,
			catalog: catalogRows,
			lastEventId: firstEvent.id,
		});
		expect(part.applied).toBe(1);
		const rest = replayEvents({
			events: store.events,
			catalog: catalogRows,
			snapshot: part.snapshot,
		});
		expect(rest.applied + part.applied).toBe(store.events.length);
		expect(rest.balances).toEqual(whole.balances);
		expect(rest.lastEventId).toBe(whole.lastEventId);
	});

	test("a command that moves no credits is in the log as a plan.changed with its whole mutation", () => {
		const store = newStore();
		store.handle(
			payment({
				tierId: "sparkle-2",
				reason: "subscription_create",
				start: T0,
				end: T1,
				invoice: "in_1",
			}),
			T0 + 10_000,
		);
		store.handle(
			payment({
				tierId: "sparkle-2",
				reason: "subscription_cycle",
				start: T1,
				end: T2,
				invoice: "in_2",
			}),
			T1 + 10_000,
		);
		const planChanges = store.events.filter(
			(e) => e.event_type === "plan.changed",
		);
		expect(planChanges.length).toBeGreaterThan(0);
		for (const e of planChanges) {
			expect(validateEvent(e).errors).toEqual([]);
			expect(e.postings).toEqual([]);
			expect(e.cause).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
		}
	});

	test("a slice that names changes the mutation does not have is a ReplayError, not a crash", () => {
		const store = newStore();
		store.handle(
			payment({
				tierId: "sparkle-4",
				reason: "subscription_create",
				start: T0,
				end: T1,
				invoice: "in_1",
			}),
			T0 + 10_000,
		);
		const sliced = store.events.find((e) => Array.isArray(e.payload.slice));
		expect(sliced).toBeDefined();
		for (const slice of [[99], [-1], [1.5], "0"]) {
			const events = store.events.map((e) =>
				e === sliced ? { ...e, payload: { ...e.payload, slice } } : e,
			);
			expect(() => replayEvents({ events, catalog: catalogRows })).toThrow(
				ReplayError,
			);
		}
	});

	test("a sparkle-4 subscription replays through the year-end, where one reset moves both of its rows", () => {
		const store = newStore();
		const monthsPaid = 14;
		for (let month = 0; month < monthsPaid; month += 1) {
			const start = Date.UTC(2026, month, 15, 18);
			store.handle(
				payment({
					tierId: "sparkle-4",
					reason: month === 0 ? "subscription_create" : "subscription_cycle",
					start,
					end: Date.UTC(2026, month + 1, 15, 18),
					invoice: `in_${month}`,
				}),
				start + 10_000,
			);
		}
		// the retreat row resets once a year, in the same command as the visit row's monthly reset
		const replayed = replayEvents({
			events: store.events,
			catalog: catalogRows,
		});
		expect(engineRowsOf(replayed.snapshot.states[store.holder])).toBe(
			engineRowsOf(store.engineState()),
		);
	});

	test("a sparkle-2 create, renew and cancel replays to the live balances", () => {
		const store = newStore();
		store.handle(
			payment({
				tierId: "sparkle-2",
				reason: "subscription_create",
				start: T0,
				end: T1,
				invoice: "in_1",
			}),
			T0 + 10_000,
		);
		store.handle(
			payment({
				tierId: "sparkle-2",
				reason: "subscription_cycle",
				start: T1,
				end: T2,
				invoice: "in_2",
			}),
			T1 + 10_000,
		);
		store.handle(
			subscriptionDeleted({
				eventId: "evt_sd",
				subscriptionId: "sub_1",
				tierId: "sparkle-2",
				interval: "month",
				periodStart: T1,
				periodEnd: T2,
				at: T1 + 86_400_000,
			}),
			T1 + 86_400_000,
		);
		// every command of the three writes is in the log, so the engine's rows end where the write path left them
		expect(
			engineRowsOf(
				replayEvents({ events: store.events, catalog: catalogRows }).snapshot
					.states[store.holder],
			),
		).toBe(engineRowsOf(store.engineState()));
		for (const asOf of [T1 + 2 * 86_400_000, T2 - 1, T2 + 1]) {
			const replayed = replayEvents({
				events: store.events,
				catalog: catalogRows,
				asOf: new Date(asOf).toISOString(),
			});
			expect(
				replayed.balances.find((b) => b.feature === "visit")?.avail ?? 0,
			).toBe(store.avail(asOf));
		}
	});
});
