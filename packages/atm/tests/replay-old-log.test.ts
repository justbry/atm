/**
 * Logs written by atm 0.3.0, replayed. The fixtures in `fixtures/log-0.3.0/` were made with that release's writer
 * (`generate.ts.txt` says how): `events.jsonl` is what it put in the log, `commands.json` every engine command it ran with
 * the whole mutation the engine decided (the oracle), `state.json` and `rows.json` where the stored rows ended.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BillingRow } from "../src/billing/rows.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import {
	ReplayError,
	ReplayGapError,
	replayEvents,
} from "../src/ledger/replay.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import type { AtmCatalogRow, AtmEvent } from "../src/types.js";
import { createStore, engineRowsOf } from "./billing-store.js";
import { invoicePaid } from "./stripe-events.js";

const DIR = join(import.meta.dir, "../fixtures/log-0.3.0");
const read = (...path: string[]) =>
	JSON.parse(readFileSync(join(DIR, ...path), "utf8"));
const catalogRows = read("catalog.json") as AtmCatalogRow[];
const catalog = toCatalog(catalogRows);

type Command = {
	command: Record<string, unknown> & { type: string; commandId: string };
	mutation: {
		id: string;
		revision: { before: number; after: number };
		changes: unknown[];
	};
};
const load = (name: string) => ({
	events: readFileSync(join(DIR, name, "events.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as AtmEvent),
	commands: read(name, "commands.json") as Command[],
	state: read(name, "state.json"),
	stored: read(name, "rows.json") as { revision: number; rows: BillingRow[] },
});

/** The engine's state after the first `n` commands the 0.3.0 writer ran: the state the stored rows had then. */
const afterCommands = (commands: Command[], n: number) => {
	let state = null as ReturnType<typeof runOnState>["state"];
	for (const { command } of commands.slice(0, n))
		({ state } = runOnState({ state, catalog, command }));
	return state;
};

const SCHOOL = "sch_vol";
const FAMILY = "fam_old";
const menu = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../fixtures/billing/grants/menu.json"),
		"utf8",
	),
) as Menu;
const T1 = Date.parse("2026-02-15T18:00:00Z");
const T2 = Date.parse("2026-03-15T18:00:00Z");
const renewal = (
	tierId: string,
	invoice: string,
	start: number,
	end: number,
) => {
	const amount = menu.tiers
		.find((t) => t.id === tierId)
		?.prices.find((p) => p.interval === "month")?.amount as number;
	return invoicePaid({
		eventId: `evt_${invoice}`,
		invoiceId: invoice,
		at: start + 10_000,
		subscriptionId: "sub_1",
		reason: "subscription_cycle",
		periodStart: start,
		periodEnd: end,
		lines: [
			{
				lookupKey: lookupKeyOf(
					SCHOOL,
					tierPriceKey(tierId, "month"),
					amount,
					menu.currency,
				),
				amount,
				interval: "month",
			},
		],
		metadata: { b4u_school: SCHOOL, family_id: FAMILY },
	});
};

describe("what a 0.3.0 log lacks", () => {
	test("a mutation booked per feature holds only each event's slice, and the slices put together are the engine's changes where every slice made an event", () => {
		const { events, commands } = load("sparkle-2-year");
		for (const { mutation } of commands) {
			const siblings = events.filter(
				(e) =>
					(e.payload.mutation as { id: string }).id === mutation.id &&
					e.event_type.startsWith("credit."),
			);
			if (siblings.length === 0) continue;
			const together = siblings.flatMap(
				(e) => (e.payload.mutation as { changes: unknown[] }).changes,
			);
			expect(together.length).toBe(mutation.changes.length);
			expect(events.every((e) => e.payload.slice === undefined)).toBe(true);
		}
	});

	test("a slice that made no event is gone: the first sparkle-4 write holds 1 of its 4 changes", () => {
		const { events, commands } = load("sparkle-4-create");
		const plan = commands[0] as Command;
		expect(plan.command.type).toBe("applyBillingPlan");
		expect(plan.mutation.changes).toHaveLength(4);
		const recorded = events
			.filter(
				(e) => (e.payload.mutation as { id: string }).id === plan.mutation.id,
			)
			.flatMap((e) => (e.payload.mutation as { changes: unknown[] }).changes);
		expect(recorded).toHaveLength(1);
	});

	test("commands that moved no credits were never logged: the cycle-end update after the renewal has no event", () => {
		const { events, commands } = load("sparkle-2-year");
		const logged = new Set(
			events.map((e) => (e.payload.command as { commandId: string }).commandId),
		);
		const lost = commands.filter((c) => !logged.has(c.command.commandId));
		expect(lost.map((c) => c.command.type)).toEqual(["applyBillingPlan"]);
		expect(lost[0]?.mutation.revision).toEqual({ before: 2, after: 3 });
	});
});

describe("replaying a 0.3.0 log", () => {
	test("a log with no lost command replays to the rows the writer ended on, with the old bookings checked against their own cut", () => {
		const { events, state } = load("sparkle-4-create");
		const replayed = replayEvents({ events, catalog: catalogRows });
		expect(replayed.applied).toBe(events.length);
		expect(engineRowsOf(replayed.snapshot.states["family:fam_old"])).toBe(
			engineRowsOf(state),
		);
	});

	test("a mutation that 0.3.0 booked as an event per feature, each with its own cut, replays whatever order the events come in", () => {
		// The year-end reset of a sparkle-4 subscription moves both rows in one mutation: 0.3.0 wrote one event per feature,
		// the retreat event first (features sort), each recording only its own changes. The log is made by the current
		// writer and cut back to that shape (the cycle-end plan.changed kept, so no command is lost).
		const store = createStore({ menu, school: SCHOOL, family: FAMILY });
		for (let month = 0; month < 14; month += 1) {
			const start = Date.UTC(2026, month, 15, 18);
			store.handle(
				renewal(
					"sparkle-4",
					`in_${month}`,
					start,
					Date.UTC(2026, month + 1, 15, 18),
				),
				start + 10_000,
			);
		}
		const oldShape = store.events.map((e): AtmEvent => {
			const {
				complete: _complete,
				slice,
				...payload
			} = e.payload as Record<string, unknown>;
			const whole = payload.mutation as { changes: unknown[] };
			return {
				...e,
				payload: slice
					? {
							...payload,
							mutation: {
								...whole,
								changes: (slice as number[]).map((at) => whole.changes[at]),
							},
						}
					: payload,
			};
		});
		const siblings = oldShape.filter(
			(e) =>
				e.event_type.startsWith("credit.") &&
				(e.payload.mutation as { changes: unknown[] }).changes.length <
					(
						store.events.find((x) => x.id === e.id)?.payload.mutation as {
							changes: unknown[];
						}
					).changes.length,
		);
		expect(siblings.length).toBeGreaterThan(1);
		const live = engineRowsOf(store.engineState());
		for (const events of [oldShape, [...oldShape].reverse()]) {
			const replayed = replayEvents({ events, catalog: catalogRows });
			expect(engineRowsOf(replayed.snapshot.states[store.holder])).toBe(live);
		}
	});

	test("a changed old booking is still caught", () => {
		const { events } = load("sparkle-4-create");
		const forged = events.map((e) =>
			e.event_type === "credit.granted" ? { ...e, text: `${e.text} twice` } : e,
		);
		expect(() =>
			replayEvents({ events: forged, catalog: catalogRows }),
		).toThrow(ReplayError);
		const wrongChange = events.map((e, i) => {
			if (i !== 0) return e;
			const mutation = e.payload.mutation as {
				changes: { row?: { balance?: number } }[];
			};
			const changes = structuredClone(mutation.changes);
			if (changes[0]?.row) changes[0].row.balance = 99;
			return {
				...e,
				payload: { ...e.payload, mutation: { ...mutation, changes } },
			};
		});
		expect(() =>
			replayEvents({ events: wrongChange, catalog: catalogRows }),
		).toThrow(/decides differently/);
	});

	test("a log that lost the cycle-end update stops at the gap with a typed error, and the prefix is the state before it", () => {
		const { events, commands } = load("sparkle-2-year");
		let error: unknown;
		try {
			replayEvents({ events, catalog: catalogRows });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ReplayGapError);
		const gap = error as ReplayGapError;
		const cancel = events.find(
			(e) => e.event_type === "credit.expiration_changed",
		) as AtmEvent;
		expect(gap.eventId).toBe(cancel.id);
		expect(gap.gap).toEqual({ subject: "family:fam_old", after: 2, before: 3 });
		expect(gap.message).toContain("0.3.0");
		expect(gap.message).toContain("cannot be rebuilt past this point");
		expect(gap.prefix.applied).toBe(2);
		expect(engineRowsOf(gap.prefix.snapshot.states["family:fam_old"])).toBe(
			engineRowsOf(afterCommands(commands, 2)),
		);
	});

	test("a write of the grants row alone leaves the same gap, and is refused as well: it cannot be told from a lost command", () => {
		const { events, commands, state } = load("sparkle-2-gift-spend");
		expect(() => replayEvents({ events, catalog: catalogRows })).toThrow(
			ReplayGapError,
		);
		// here the gap was harmless (the gift moved no engine row), which is the case the log cannot prove
		const logged = new Set(
			events.map((e) => (e.payload.command as { commandId: string }).commandId),
		);
		const lost = commands.filter((c) => !logged.has(c.command.commandId));
		expect(lost.map((c) => c.command.type)).toEqual(["applyBillingPlan"]);
		expect(engineRowsOf(afterCommands(commands, commands.length))).toBe(
			engineRowsOf(state),
		);
	});

	test("replaying up to the event before the gap works, and so does resuming a snapshot of it", () => {
		const { events } = load("sparkle-2-year");
		const ordered = [...events].sort((a, b) => (a.id < b.id ? -1 : 1));
		const part = replayEvents({
			events,
			catalog: catalogRows,
			lastEventId: (ordered[1] as AtmEvent).id,
		});
		expect(part.applied).toBe(2);
		expect(() =>
			replayEvents({ events, catalog: catalogRows, snapshot: part.snapshot }),
		).toThrow(ReplayGapError);
	});
});

describe("a log that goes on in the current shape", () => {
	test("old events and new ones with no lost command between replay as one log", () => {
		const old = load("sparkle-4-create");
		const store = createStore({
			menu,
			school: SCHOOL,
			family: FAMILY,
			start: old.stored,
		});
		store.handle(renewal("sparkle-4", "in_2", T1, T2), T1 + 10_000);
		expect(store.events.length).toBeGreaterThan(0);
		const mixed = [...old.events, ...store.events];
		const replayed = replayEvents({ events: mixed, catalog: catalogRows });
		expect(replayed.applied).toBe(mixed.length);
		expect(engineRowsOf(replayed.snapshot.states[store.holder])).toBe(
			engineRowsOf(store.engineState()),
		);
	});

	test("new events after a lost command stop at the boundary, naming it", () => {
		const old = load("sparkle-2-month-end");
		const store = createStore({
			menu,
			school: SCHOOL,
			family: FAMILY,
			start: old.stored,
		});
		const mar31 = Date.parse("2026-03-31T18:00:00Z");
		store.handle(
			renewal("sparkle-2", "in_3", mar31, mar31 + 30 * 86_400_000),
			mar31 + 10_000,
		);
		expect(store.events.length).toBeGreaterThan(0);
		let error: unknown;
		try {
			replayEvents({
				events: [...old.events, ...store.events],
				catalog: catalogRows,
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ReplayGapError);
		const gap = error as ReplayGapError;
		expect(gap.gap).toEqual({ subject: store.holder, after: 2, before: 3 });
		expect(gap.eventId).toBe(
			store.events.find((e) => e.payload.complete === true)?.id as string,
		);
		expect(gap.prefix.applied).toBe(old.events.length);
		expect(gap.prefix.lossySubjects).toEqual([store.holder]);
	});
});

describe("a 0.3.0 log that ends after a lost command", () => {
	test("replays, and says the subject may lack the last command: here the cycle-end update moved a reset date", () => {
		const { events, commands, state } = load("sparkle-2-month-end");
		const replayed = replayEvents({ events, catalog: catalogRows });
		expect(replayed.applied).toBe(events.length);
		expect(replayed.lossySubjects).toEqual(["family:fam_old"]);
		// the rows the writer ended on had the lost command; the log cannot give it back
		const ended = engineRowsOf(state);
		expect(engineRowsOf(afterCommands(commands, 3))).toBe(ended);
		expect(engineRowsOf(replayed.snapshot.states["family:fam_old"])).toBe(
			engineRowsOf(afterCommands(commands, 2)),
		);
		expect(engineRowsOf(afterCommands(commands, 2))).not.toBe(ended);
	});

	test("a log with nothing lost still names the subject: the last command may have had a lost one after it", () => {
		const { events } = load("sparkle-4-create");
		expect(
			replayEvents({ events, catalog: catalogRows }).lossySubjects,
		).toEqual(["family:fam_old"]);
	});
});

describe("a log the current writer made", () => {
	test("marks every event as written with every command logged, and names no lossy subject", () => {
		const store = createStore({ menu, school: SCHOOL, family: FAMILY });
		store.handle(renewal("sparkle-2", "in_1", T1, T2), T1 + 10_000);
		expect(store.events.length).toBeGreaterThan(0);
		// the money lines of the payment (`payment.*`) are not commands
		for (const e of store.events.filter(
			(e) => !e.event_type.startsWith("payment."),
		))
			expect(e.payload.complete).toBe(true);
		const replayed = replayEvents({
			events: store.events,
			catalog: catalogRows,
		});
		expect(replayed.lossySubjects).toBeUndefined();
	});
});
