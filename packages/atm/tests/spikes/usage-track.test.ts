import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutationToEvents } from "../../src/ledger/postings.js";
import {
	balancesOf,
	checkCommand,
	decide,
	emptyCounts,
	finalizeCommand,
	holderId,
	keyOf,
	loadSubject,
	lockOf,
	openDatabase,
	resetCommand,
	runContention,
	runEngineOnly,
	runWorkload,
	seedHolders,
	spend,
	trackCommand,
} from "./usage-track-harness.js";

/**
 * Feasibility spike: atm's spend path as a usage wallet. The numbers live in the spike's report; these tests pin the
 * behaviour the report states (so a change in the engine that moves it shows here) and run the benchmark code once, small.
 */

const HOLDER = holderId(0);
const CYCLE_END = Date.UTC(2026, 1, 5, 17, 0, 0) + 1;
const rowsOf = (db: ReturnType<typeof openDatabase>["db"]) =>
	db.all<{ data: string }>(
		`SELECT data FROM atm_rows WHERE table_name = 'customerEntitlements'`,
	);

const wallet = (shape: Parameters<typeof seedHolders>[2]) => {
	const { db } = openDatabase(":memory:");
	seedHolders(db, 1, shape);
	return db;
};

const statusOf = (result: { mutation: unknown }): string =>
	(result.mutation as { result: { status: string } }).result.status;

const typesOf = (db: ReturnType<typeof openDatabase>["db"]): string[] =>
	db
		.all<{ body: string }>(`SELECT body FROM ledger_outbox ORDER BY id`)
		.map((row) => (JSON.parse(row.body) as { event_type: string }).event_type);

describe("usage track spike", () => {
	test("a track reads the holder's rows, writes the one row it moved, and moves the revision by one", () => {
		const db = wallet({ balance: 100 });
		const counts = emptyCounts();
		spend({
			db,
			command: trackCommand({ holder: HOLDER, value: 10 }),
			options: { counts },
		});
		expect(counts).toMatchObject({
			rowsRead: 3,
			rowsUpserted: 1,
			rowsDeleted: 0,
		});
		expect(balancesOf(db, 0)).toMatchObject({
			revision: 2,
			rows: { ce_credit: 90 },
		});
	});

	test("overage allowed: 100 credits, 130 units in five held calls end at -30, with one low, one depleted and no overage field", () => {
		const db = wallet({ balance: 100 });
		const calls = [40, 40, 19, 1, 30];
		const locks: unknown[] = [];
		for (const [index, value] of calls.entries()) {
			const held = spend({
				db,
				command: trackCommand({
					holder: HOLDER,
					value,
					overageBehavior: "overflow",
					lockId: `bk${index}`,
					commandId: `call${index}`,
				}),
				options: { outbox: { service: "llm" } },
			});
			expect(statusOf(held)).toBe("applied");
			locks.push(lockOf(held.mutation as never));
		}
		const { rows, total } = balancesOf(db, 0);
		expect(rows.ce_credit).toBe(-30);
		expect(Math.max(0, -total)).toBe(30);
		// 40 -> 60, 40 -> 20, 19 -> 1 (low), 1 -> 0 (depleted), 30 -> -30 (no event: it started at 0)
		const types = typesOf(db);
		expect(types.filter((type) => type === "credit.held")).toHaveLength(5);
		expect(types.filter((type) => type === "credit.low")).toHaveLength(1);
		expect(types.filter((type) => type === "credit.depleted")).toHaveLength(1);
		expect(types).toHaveLength(7);
		const events = db
			.all<{ body: string }>(`SELECT body FROM ledger_outbox ORDER BY id`)
			.map((row) => JSON.parse(row.body) as Record<string, unknown>);
		// the last hold took 30 units that were all overage, and its event says only "held 30": no field splits the overage
		const lastHold = events.find((event) => event.idem === "engine:call4:held");
		expect(lastHold?.text).toBe("held 30 credit for bk4");
		expect(Object.keys(lastHold?.payload as object).sort()).toEqual([
			"command",
			"mutation",
		]);
		const depleted = events.find(
			(event) => event.event_type === "credit.depleted",
		);
		expect(depleted?.payload).toMatchObject({
			available: 0,
			previous_available: 1,
		});
		// settling a hold above its lock is not mapped to an event
		expect(() =>
			spend({
				db,
				command: finalizeCommand({
					holder: HOLDER,
					lock: locks[0],
					finalValue: 45,
				}),
				options: { outbox: { service: "llm" } },
			}),
		).toThrow("a finalize above its lock deducts more");
	});

	test("a plain track (no hold) has no ledger event: mutationToEvents refuses it", () => {
		const db = wallet({ balance: 100 });
		const { mutation } = decide({
			command: trackCommand({ holder: HOLDER, value: 10 }),
			snapshot: loadSubject(db, keyOf(0)),
		});
		expect(() =>
			mutationToEvents({
				mutation: mutation as never,
				context: { school: "usage-school", tz: "UTC", feature: "credit" },
			}),
		).toThrow("a spend books a hold first");
	});

	test("one batch of the summed quantity: reject is all or nothing, cap drops the excess, overflow goes negative", () => {
		const outcome = (behavior: "reject" | "cap" | "overflow") => {
			const db = wallet({ balance: 100 });
			const result = spend({
				db,
				command: trackCommand({
					holder: HOLDER,
					value: 130,
					overageBehavior: behavior,
				}),
			});
			return { status: statusOf(result), balance: balancesOf(db, 0).total };
		};
		expect(outcome("reject")).toEqual({ status: "rejected", balance: 100 });
		expect(outcome("cap")).toEqual({ status: "applied", balance: 0 });
		expect(outcome("overflow")).toEqual({ status: "applied", balance: -30 });

		const db = wallet({ balance: 100 });
		const results = Array.from({ length: 13 }, () =>
			statusOf(
				spend({ db, command: trackCommand({ holder: HOLDER, value: 10 }) }),
			),
		);
		expect(results.filter((status) => status === "applied")).toHaveLength(10);
		expect(balancesOf(db, 0).total).toBe(0);
	});

	test("check reports allowed or not, not the balance, and writes nothing", () => {
		const db = wallet({ balance: 100 });
		const allowed = spend({
			db,
			command: checkCommand({ holder: HOLDER, required: 100 }),
		}).decision;
		const refused = spend({
			db,
			command: checkCommand({ holder: HOLDER, required: 101 }),
		}).decision;
		expect(allowed).toMatchObject({ allowed: true });
		expect(refused).toMatchObject({
			allowed: false,
			reason: "insufficient_balance",
		});
		expect(balancesOf(db, 0).revision).toBe(1);
	});

	test("the engine keeps exact decimals but the stored balance is a double", () => {
		const balanceAfter = (start: number, values: number[]): number => {
			const db = wallet({ balance: start });
			for (const value of values)
				spend({ db, command: trackCommand({ holder: HOLDER, value }) });
			return balancesOf(db, 0).rows.ce_credit as number;
		};
		expect(balanceAfter(1, Array(10).fill(0.1))).toBe(0);
		expect(balanceAfter(10, [0.5])).toBe(9.5);
		expect(balanceAfter(1, [1e-6])).toBe(0.999999);
		expect(balanceAfter(1e12, [1e12])).toBe(0);
		// below the double's resolution at the balance's size, a small draw is lost
		expect(balanceAfter(1e12, [1e-6])).toBe(1e12 - 1e-6);
	});

	test("the ledger books whole credits only: a fractional hold throws in mutationToEvents", () => {
		const db = wallet({ balance: 100 });
		expect(() =>
			spend({
				db,
				command: trackCommand({
					holder: HOLDER,
					value: 0.5,
					lockId: "bk",
				}),
				options: { outbox: { service: "llm" } },
			}),
		).toThrow("credits are whole units");
		// the throw rolled the transaction back
		expect(balancesOf(db, 0)).toMatchObject({ revision: 1 });
		expect(rowsOf(db)).toHaveLength(1);
	});

	test("a cycle reset forgives the overage, and the ledger cannot book a reset over an overdrawn row", () => {
		const db = wallet({ balance: 100 });
		spend({
			db,
			command: trackCommand({
				holder: HOLDER,
				value: 130,
				overageBehavior: "overflow",
			}),
		});
		const snapshot = loadSubject(db, keyOf(0));
		const { mutation, changes } = decide({
			command: resetCommand({ holder: HOLDER, at: CYCLE_END }),
			snapshot,
		});
		// the row's -30 is in the mutation's guard (`before`), and nowhere after the write
		expect(JSON.stringify(mutation)).toContain('"balance":-30');
		expect(changes?.upserts[0]?.data).toMatchObject({ balance: 1_000_000 });
		expect(() =>
			mutationToEvents({
				mutation: mutation as never,
				context: {
					school: "usage-school",
					tz: "UTC",
					feature: "credit",
					plan: "metered@v1",
				},
			}),
		).toThrow("a reset cannot add more than it refills");
	});

	test("the benchmark code runs: engine only, one workload, and two processes on one hot holder", async () => {
		expect(
			runEngineOnly({ runs: 200, value: 1 }).runsPerSecond,
		).toBeGreaterThan(0);
		const report = runWorkload({
			label: "smoke",
			holders: 50,
			tracks: 200,
			value: 1,
			pick: "zipf",
		});
		expect(report.rowsReadPerTrack).toBe(3);
		const dir = mkdtempSync(join(tmpdir(), "atm-usage-"));
		try {
			const contention = await runContention({
				path: join(dir, "wallet.db"),
				workers: 2,
				holders: "same",
				pattern: "optimistic",
				durationMs: 300,
				startDelayMs: 600,
			});
			expect(contention.committed).toBeGreaterThan(0);
			expect(contention.revisionOk).toBe(true);
			expect(contention.balanceOk).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
