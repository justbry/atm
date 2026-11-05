/**
 * A member whose stored rows take booking results and further invoices in any order (the 0.8.0 booking review): the rules
 * decide each invoice against the grants row as stored, the engine runs its commands on the stored rows. `menu` is a
 * parameter so a test can run the same story on a menu with and without rollover.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SubjectState } from "@autumn/balance-engine";
import {
	EMPTY_GRANTS_STATE,
	invoiceToCommands,
	menuCatalogRows,
} from "../src/billing/grants.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	applyRowChanges,
	type BillingRow,
	grantsFromRows,
	grantsRow,
	rowsFromState,
	stateFromRows,
} from "../src/billing/rows.js";
import type {
	BillingInvoice,
	BillingPolicy,
	BookingContext,
	BookingResult,
	GrantResult,
	Menu,
} from "../src/billing/types.js";
import { buildJournal } from "../src/ledger/journal.js";
import { balancesOf } from "../src/ledger/replay.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import type { AtmEvent } from "../src/types.js";

/** `hledger check --strict` over the monthly journals of `events`. */
export const checkWithHledger = (events: readonly AtmEvent[]) => {
	const root = mkdtempSync(join(tmpdir(), "atm-booking-review-"));
	try {
		for (const month of new Set(events.map((e) => e.date.slice(0, 7)))) {
			const build = buildJournal({ events, month });
			for (const [path, text] of Object.entries(build.files)) {
				mkdirSync(dirname(join(root, path)), { recursive: true });
				writeFileSync(join(root, path), text);
			}
		}
		const check = Bun.spawnSync(
			["hledger", "-f", "main.journal", "check", "--strict"],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		return { exitCode: check.exitCode, stderr: check.stderr.toString() };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};

const SCHOOL = "sch_vol";
const HOLDER = "family:fam_8k2";
const IDENTITY = {
	orgId: SCHOOL,
	env: "live",
	customerId: HOLDER,
	entityId: null,
};

export const reviewWorld = (
	menu: Menu,
	policy: BillingPolicy = DEFAULT_POLICY,
) => {
	const catalogRows = menuCatalogRows({ menu, school: SCHOOL });
	const catalog = toCatalog(catalogRows);
	let rows: BillingRow[] = [grantsRow(EMPTY_GRANTS_STATE)];
	let revision = 0;
	const events: AtmEvent[] = [];
	const engine = () =>
		stateFromRows({
			identity: IDENTITY,
			revision,
			rows,
		}) as SubjectState | null;
	const runGrant = (result: GrantResult) => {
		let state = engine();
		if (state) state = { ...state, revision };
		for (const command of result.commands) {
			const run = runOnState({ state, catalog, command });
			const status = (run.mutation?.result as { status?: string } | undefined)
				?.status;
			if (status === "rejected")
				throw new Error(`the engine rejected ${command.type}`);
			state = run.state;
		}
		if (!state) throw new Error("the invoice made no subject");
		rows = [...rowsFromState(state), grantsRow(result.state)];
		revision = Math.max(state.revision, revision + 1);
	};
	const self = {
		events,
		get rows() {
			return rows;
		},
		get grants() {
			return grantsFromRows(rows);
		},
		engine,
		/** Decides a paid invoice with the rules and runs its commands on the stored rows. */
		invoice(invoice: BillingInvoice, now = invoice.paidAt) {
			runGrant(
				invoiceToCommands({
					invoice,
					menu,
					policy,
					state: grantsFromRows(rows),
					now,
					menuVersion: 1,
					policyVersion: 1,
				}),
			);
		},
		ctx(now: number): BookingContext {
			return {
				menu,
				menuVersion: 1,
				policy,
				policyVersion: 1,
				rows,
				revision,
				catalog: catalogRows,
				now,
			};
		},
		/** Writes a booking result as the caller does; returns it. */
		apply<T extends BookingResult>(result: T): T {
			if (result.ok && result.rowChanges)
				({ rows, revision } = applyRowChanges({
					rows,
					revision,
					changes: result.rowChanges,
				}));
			if (result.ok) events.push(...result.events);
			return result;
		},
		/** What the holder can spend of `feature` at `at`, as the engine counts it. */
		available(at: number, feature = "visit") {
			const state = engine();
			if (!state) return 0;
			return (
				balancesOf({
					states: { [HOLDER]: state as never },
					holds: {},
					catalog,
					asOfMs: at,
				}).find((balance) => balance.feature === feature)?.avail ?? 0
			);
		},
		rollovers() {
			return (engine()?.rollovers ?? []).map((rollover) => ({
				id: rollover.id,
				balance: rollover.balance,
				expiresAt: rollover.expires_at,
			}));
		},
	};
	return self;
};
