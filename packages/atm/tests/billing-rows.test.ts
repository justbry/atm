import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SubjectState } from "@autumn/balance-engine";
import { generateYear } from "../fixtures/vibes.js";
import { EMPTY_GRANTS_STATE } from "../src/billing/grants.js";
import {
	applyRowChanges,
	type BillingRow,
	GRANTS_ROW_ID,
	GRANTS_TABLE,
	grantsFromRows,
	grantsRow,
	rowChangesFromMutation,
	rowsFromState,
	StaleRevision,
	sortRows,
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

describe("the grants row", () => {
	const grants = {
		...EMPTY_GRANTS_STATE,
		identity: { orgId: "sch_vol", customerId: "family:fam_x" },
		tierId: "sparkle-2",
		invoices: { in_1: { paidAt: 1, granted: [], removed: false } },
	};

	test("is a JSON row of the subject: one table, one id, and the state back as it was", () => {
		const row = grantsRow(grants);
		expect([row.table, row.id]).toEqual([GRANTS_TABLE, GRANTS_ROW_ID]);
		expect(grantsFromRows([row])).toEqual(grants);
		expect(JSON.parse(JSON.stringify(row))).toEqual(row);
		expect(row.data).not.toBe(grants);
	});

	test("no grants row is the empty state; a stored state missing a newer key takes its default", () => {
		expect(grantsFromRows([])).toEqual(EMPTY_GRANTS_STATE);
		const { endedAt: _gone, ...old } = grants;
		expect(
			grantsFromRows([{ table: GRANTS_TABLE, id: GRANTS_ROW_ID, data: old }])
				.endedAt,
		).toBeNull();
		expect(() =>
			grantsFromRows([
				{ table: GRANTS_TABLE, id: GRANTS_ROW_ID, data: { v: 2 } },
			]),
		).toThrow(/version/);
	});

	test("is not engine state: left out of the state, and rows holding only it are no subject", () => {
		const y = runYear();
		const withGrants = [...y.rows, grantsRow(grants)];
		expect(
			stateFromRows({
				identity: y.identity,
				revision: y.revision,
				rows: withGrants,
			}),
		).toEqual(
			stateFromRows({
				identity: y.identity,
				revision: y.revision,
				rows: y.rows,
			}),
		);
		expect(
			stateFromRows({
				identity: y.identity,
				revision: 0,
				rows: [grantsRow(grants)],
			}),
		).toBeNull();
	});

	test("rows list the grants row last, after every engine table", () => {
		const y = runYear();
		const sorted = sortRows([grantsRow(grants), ...y.rows]);
		expect(sorted[sorted.length - 1]?.table).toBe(GRANTS_TABLE);
	});

	test("an engine mutation neither deletes it nor changes it, and the one revision check guards both", () => {
		const y = runYear();
		const rows = [...y.rows, grantsRow(grants)];
		const state = stateFromRows({
			identity: y.identity,
			revision: y.revision,
			rows,
		});
		const run = runOnState({
			state,
			catalog: toCatalog(fixture.catalog),
			command: {
				schemaVersion: 1,
				type: "reset",
				org: { config: {} },
				commandId: "cmd_after_year",
				requestId: "cmd_after_year",
				identity: y.identity,
				occurredAt: Date.parse("2027-02-01T00:00:00Z"),
			},
		});
		expect(run.mutation).not.toBeNull();
		const changes = rowChangesFromMutation({
			mutation: run.mutation as never,
			rows,
			revision: y.revision,
		});
		expect(changes.deletes.some((d) => d.table === GRANTS_TABLE)).toBe(false);
		expect(changes.upserts.some((u) => u.table === GRANTS_TABLE)).toBe(false);
		const applied = applyRowChanges({ rows, revision: y.revision, changes });
		expect(applied.rows.find((r) => r.table === GRANTS_TABLE)).toEqual(
			grantsRow(grants),
		);
		expect(() =>
			applyRowChanges({ rows, revision: y.revision + 1, changes }),
		).toThrow(StaleRevision);
	});
});
