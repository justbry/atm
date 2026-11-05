/**
 * A member's stored rows for the bookable-item tests: the paid invoices of the grants fixtures run through the rules and the
 * engine, then split into rows as the family service stores them. `ctx` is the context every booking command takes, `apply`
 * writes a result the way the caller does (one transaction: the rows, then the events).
 */
import { readFileSync } from "node:fs";
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
	GrantsState,
	Menu,
} from "../src/billing/types.js";
import { balancesOf } from "../src/ledger/replay.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import type { AtmEvent } from "../src/types.js";

export const SCHOOL = "sch_vol";
export const HOLDER = "family:fam_8k2";
export const DAY = 86_400_000;
export const HOUR = 3_600_000;

const dir = `${import.meta.dir}/../fixtures/billing/grants`;
export const load = <T>(name: string): T =>
	JSON.parse(readFileSync(`${dir}/${name}.json`, "utf8")) as T;
export const menu = load<Menu>("menu");
export const catalogRows = menuCatalogRows({ menu, school: SCHOOL });
const catalog = toCatalog(catalogRows);

/** The time the fixtures' first invoice was paid (2026-01-15T18:00:05Z). */
export const PAID_AT = (load<BillingInvoice>("inv-create-s2") as BillingInvoice)
	.paidAt;

export type Booked = ReturnType<typeof member>;

/** The tier invoice of `inv-create-s2-year` with the pack line of `inv-create-s2-pack`: a yearly tier row and a pack row that lapses sooner. */
export const yearlyWithPack = (): BillingInvoice => {
	const year = load<BillingInvoice>("inv-create-s2-year");
	const pack = load<BillingInvoice>("inv-create-s2-pack");
	return { ...year, lines: [...year.lines, ...pack.lines.slice(1)] };
};

export const member = ({
	invoices = ["inv-create-s2"],
	policy = DEFAULT_POLICY,
}: {
	invoices?: (string | BillingInvoice)[];
	policy?: BillingPolicy;
} = {}) => {
	let engine: SubjectState | null = null;
	let grants: GrantsState = EMPTY_GRANTS_STATE;
	for (const entry of invoices) {
		const invoice =
			typeof entry === "string" ? load<BillingInvoice>(entry) : entry;
		const decided = invoiceToCommands({
			invoice,
			menu,
			policy,
			state: grants,
			now: invoice.paidAt,
			menuVersion: 1,
			policyVersion: 1,
		});
		grants = decided.state;
		for (const command of decided.commands)
			engine = runOnState({ state: engine, catalog, command }).state;
	}
	if (!engine) throw new Error("no invoice made a subject");
	let rows: BillingRow[] = [...rowsFromState(engine), grantsRow(grants)];
	let revision = engine.revision;
	const events: AtmEvent[] = [];

	const self = {
		policy,
		get rows() {
			return rows;
		},
		get revision() {
			return revision;
		},
		events,
		get grants() {
			return grantsFromRows(rows);
		},
		/** The engine's rows as stored now. */
		get engine(): SubjectState {
			return stateFromRows({
				identity: {
					orgId: SCHOOL,
					env: "live",
					customerId: HOLDER,
					entityId: null,
				},
				revision,
				rows,
			}) as SubjectState;
		},
		/** What every booking command takes, at `now`. */
		ctx(now: number, over: Partial<BookingContext> = {}): BookingContext {
			return {
				menu,
				menuVersion: 1,
				policy,
				policyVersion: 1,
				rows,
				revision,
				catalog: catalogRows,
				now,
				...over,
			};
		},
		/** Writes a result as the caller does; returns it. */
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
		/** The balance of a feature as the engine counts it at `at`, with the credits its open holds keep. */
		balance(at: number, feature = "visit") {
			const holds = Object.fromEntries(
				Object.entries(grantsFromRows(rows).bookings ?? {}).flatMap(
					([id, record]) =>
						record.state === "held" && record.cost.kind === "credits"
							? [
									[
										id,
										{
											holder: HOLDER,
											feature: record.cost.featureId,
											units: record.cost.credits,
										},
									],
								]
							: [],
				),
			);
			const found = balancesOf({
				states: { [HOLDER]: self.engine as never },
				holds,
				catalog,
				asOfMs: at,
			}).find((b) => b.feature === feature);
			return { avail: found?.avail ?? 0, held: found?.held ?? 0 };
		},
		/** The balance of each credit row, by row id. */
		rowBalances(): Record<string, number> {
			return Object.fromEntries(
				self.engine.customerEntitlements.map((r) => [r.id, r.balance]),
			);
		},
	};
	return self;
};

export const typesOf = (events: readonly AtmEvent[]) =>
	events.map((e) => e.event_type);
