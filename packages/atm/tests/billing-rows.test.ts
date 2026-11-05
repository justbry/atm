import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SubjectState } from "@autumn/balance-engine";
import { generateYear } from "../fixtures/vibes.js";
import {
	applyRowChanges,
	type BillingRow,
	rowChangesFromMutation,
	rowsFromState,
	StaleRevision,
	stateFromRows,
	subjectFromRows,
	subjectKey,
} from "../src/billing/rows.js";
import { balancesOf } from "../src/ledger/replay.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import { canonicalize } from "../src/ledger/util.js";
import type { AtmEvent, AtmHold } from "../src/types.js";

const fixture = generateYear({ seed: 1 });
const expected = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../fixtures/vibes-year/expected.json"),
		"utf8",
	),
);

type Cmd = Record<string, unknown> & {
	type: string;
	commandId: string;
	identity: { orgId: string; env: string; customerId: string; entityId: null };
};

/** The year's engine commands in id order, once per commandId, run through rows only. */
const runYear = () => {
	let rows: BillingRow[] = [];
	let revision = 0;
	const seen = new Set<string>();
	const holds: Record<string, AtmHold> = {};
	const changesLog: ReturnType<typeof rowChangesFromMutation>[] = [];
	let identity: Cmd["identity"] | null = null;
	const sorted = [...fixture.events].sort((a, b) => (a.id < b.id ? -1 : 1));
	for (const e of sorted as AtmEvent[]) {
		const cmd = (e.payload as { command?: Cmd }).command;
		if (!cmd || seen.has(cmd.commandId)) {
			if (cmd) trackHold(e, cmd, holds);
			continue;
		}
		seen.add(cmd.commandId);
		identity = cmd.identity;
		const state = stateFromRows({ identity: cmd.identity, revision, rows });
		const run = runOnState({
			state,
			catalog: toCatalog(fixture.catalog),
			command: { ...cmd, occurredAt: Date.parse(e.event_time) },
		});
		expect(run.mutation).not.toBeNull();
		const changes = rowChangesFromMutation({
			mutation: run.mutation as never,
			rows,
			revision,
		});
		const next = applyRowChanges({ rows, revision, changes });
		// What the engine holds equals what the rows hold.
		expect(canonicalize(next.rows)).toBe(
			canonicalize(rowsFromState(run.state as SubjectState)),
		);
		expect(next.revision).toBe((run.state as SubjectState).revision);
		changesLog.push(changes);
		rows = next.rows;
		revision = next.revision;
		trackHold(e, cmd, holds, run.mutation as never);
	}
	return {
		rows,
		revision,
		identity: identity as Cmd["identity"],
		holds,
		changesLog,
	};
};

const trackHold = (
	e: AtmEvent,
	cmd: Cmd,
	holds: Record<string, AtmHold>,
	mutation?: { changes: { table: string; op: string; row?: { id: string } }[] },
) => {
	if (e.event_type === "credit.held" && mutation) {
		const lock = mutation.changes.find(
			(c) => c.table === "locks" && c.op === "insert",
		);
		const units = Number(
			e.postings.find((p) => p.account.startsWith("credits:held:"))?.amount,
		);
		if (lock?.row)
			holds[lock.row.id] = {
				holder: cmd.identity.customerId,
				feature: e.labels.feature as string,
				units,
			};
	} else if (
		["credit.released", "credit.spent", "credit.forfeited"].includes(
			e.event_type,
		)
	) {
		const lock = (cmd as { lock?: { id: string } }).lock;
		if (lock) delete holds[lock.id];
	}
};

describe("billing rows", () => {
	test("the fixture year through rows alone ends at expected.json's balances", () => {
		const y = runYear();
		const state = stateFromRows({
			identity: y.identity,
			revision: y.revision,
			rows: y.rows,
		});
		const balances = balancesOf({
			states: { [y.identity.customerId]: state as never },
			holds: y.holds,
			catalog: toCatalog(fixture.catalog),
			asOfMs: Date.parse(expected.asOf),
		});
		expect(balances).toEqual(expected.balances);
	});

	test("deletes are produced and applied (a settled lock leaves no row)", () => {
		const y = runYear();
		expect(y.changesLog.some((c) => c.deletes.length > 0)).toBe(true);
		// Spent and released locks are gone; only the hold still open at year end remains.
		expect(y.rows.filter((r) => r.table === "openLocks").length).toBe(
			Object.keys(y.holds).length,
		);
	});

	test("the final rows match the committed golden (fixtures/billing/rows/vibes-year.rows.json)", () => {
		const y = runYear();
		const path = join(
			import.meta.dir,
			"../fixtures/billing/rows/vibes-year.rows.json",
		);
		const golden = { identity: y.identity, revision: y.revision, rows: y.rows };
		if (process.env.UPDATE_GOLDEN)
			writeFileSync(path, `${JSON.stringify(golden, null, "\t")}\n`);
		expect(canonicalize(JSON.parse(readFileSync(path, "utf8")))).toBe(
			canonicalize(golden),
		);
	});

	test("determinism: two runs give identical row changes", () => {
		expect(canonicalize(runYear().changesLog)).toBe(
			canonicalize(runYear().changesLog),
		);
	});

	test("subjectFromRows joins the catalog: the customer's grants are in the engine subject", () => {
		const y = runYear();
		const s = subjectFromRows({
			identity: y.identity,
			revision: y.revision,
			rows: y.rows,
			catalog: fixture.catalog,
		});
		expect(s.revision).toBe(y.revision);
		expect(
			s.customer_products.length + s.extra_customer_entitlements.length,
		).toBeGreaterThan(0);
		expect(() =>
			subjectFromRows({
				identity: y.identity,
				revision: 0,
				rows: [],
				catalog: fixture.catalog,
			}),
		).toThrow();
	});

	test("a stale revision is refused", () => {
		const sorted = [...fixture.events].sort((a, b) => (a.id < b.id ? -1 : 1));
		const first = sorted.find(
			(e) => (e.payload as { command?: Cmd }).command,
		) as AtmEvent;
		const cmd = (first.payload as { command: Cmd }).command;
		const run = runOnState({
			state: null,
			catalog: toCatalog(fixture.catalog),
			command: { ...cmd, occurredAt: Date.parse(first.event_time) },
		});
		expect(() =>
			rowChangesFromMutation({
				mutation: run.mutation as never,
				rows: [],
				revision: 3,
			}),
		).toThrow(StaleRevision);
		const changes = rowChangesFromMutation({
			mutation: run.mutation as never,
			rows: [],
			revision: 0,
		});
		expect(changes.expectedRevision).toBe(0);
		expect(changes.nextRevision).toBe(1);
		expect(() => applyRowChanges({ rows: [], revision: 5, changes })).toThrow(
			StaleRevision,
		);
	});

	test("subjectKey is stable and separates entities", () => {
		const id = {
			orgId: "o",
			env: "live",
			customerId: "family:f1",
			entityId: null,
		};
		expect(subjectKey(id)).toBe("o|live|family:f1");
		expect(subjectKey({ ...id, entityId: "e1" })).toBe("o|live|family:f1|e1");
		expect(() => subjectKey({ ...id, customerId: "a|b" })).toThrow();
	});

	test("the reference DDL loads in bun:sqlite and holds the year's rows with the revision guard", () => {
		const y = runYear();
		const db = new Database(":memory:");
		db.exec(
			readFileSync(
				join(import.meta.dir, "../schema/storage/rows.v1.sql"),
				"utf8",
			),
		);
		const key = subjectKey(y.identity);
		db.run("INSERT INTO atm_subjects(subject_key, revision) VALUES (?, ?)", [
			key,
			y.revision,
		]);
		const ins = db.prepare(
			"INSERT INTO atm_rows(subject_key, table_name, row_id, data) VALUES (?,?,?,?)",
		);
		for (const r of y.rows) ins.run(key, r.table, r.id, JSON.stringify(r.data));
		const read: BillingRow[] = (
			db
				.query(
					"SELECT table_name, row_id, data FROM atm_rows WHERE subject_key = ?",
				)
				.all(key) as {
				table_name: string;
				row_id: string;
				data: string;
			}[]
		).map((r) => ({
			table: r.table_name as never,
			id: r.row_id,
			data: JSON.parse(r.data),
		}));
		expect(
			canonicalize(
				read.sort((a, b) => (a.table + a.id < b.table + b.id ? -1 : 1)),
			),
		).toBe(
			canonicalize(
				[...y.rows].sort((a, b) => (a.table + a.id < b.table + b.id ? -1 : 1)),
			),
		);
		const guarded = db.run(
			"UPDATE atm_subjects SET revision = ? WHERE subject_key = ? AND revision = ?",
			[y.revision + 1, key, y.revision - 1],
		);
		expect(guarded.changes).toBe(0);
	});
});
