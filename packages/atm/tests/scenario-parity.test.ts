/**
 * One event stream through every KPI channel (the atm fold, hledger, DuckDB): the channels' KPI hashes must be equal and
 * must match the committed goldens in tests/golden/scenarios/. `UPDATE_GOLDEN=1` rewrites the goldens (review the diff).
 * A channel whose binary is missing is skipped by `runParity`, so this suite passes without hledger or DuckDB and proves
 * parity wherever they are installed.
 *
 * The channels read the events back from a folder after the real write path (outbox, ship, readEvents), not the
 * generator's in-memory list: a fixture whose events the outbox drops (two commands under one id) fails here.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { readEvents } from "../src/ledger/files.js";
import { appendToOutbox } from "../src/ledger/outbox.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { buildFixture } from "../src/scenario/fixture.js";
import { type KpiRow, kpiHash } from "../src/scenario/kpis.js";
import { runParity } from "../src/scenario/parity.js";
import { PROFILE_NAMES } from "../src/scenario/profiles.js";
import { summaryOf } from "../src/scenario/summary.js";
import { FolderStore } from "../src/store/folder-store.js";
import type { AtmEvent } from "../src/types.js";
import { hasDuckdb, hasHledger, tmp } from "./helpers.js";

const GOLDEN = join(import.meta.dir, "golden/scenarios");

/** Two ad-hoc scenarios that override a preset or start from the defaults. */
const ADHOC = [
	{
		name: "adhoc-annual-refunds",
		profile: "annual-prepay",
		seed: 7,
		params: { refundRate: 0.2, months: 14 },
	},
	{
		name: "adhoc-small-gbp",
		params: { members: 5, months: 3, tierMix: { scholar: 1 }, currency: "gbp" },
	},
] as const;

const goldenOf = (
	fixture: ReturnType<typeof buildFixture>,
	rows: readonly KpiRow[],
) => ({
	profile: fixture.scenario.name,
	seed: fixture.scenario.seed,
	params: fixture.scenario.params,
	fixtureHash: fixture.hash,
	kpisHash: kpiHash(rows),
	events: fixture.events.length,
	periods: fixture.periods.length,
	summary: summaryOf(rows),
	// not a KPI: a money.skipped marker has no postings, so hledger's journal cannot hold it (docs/scenarios.md, "Dropped")
	skippedNonUsd: fixture.stats.skipped.non_usd ?? 0,
});

/** The school-wide credits outstanding at each month's end, straight from the postings: available plus held, every holder, every feature. */
const outstandingFrom = (
	events: readonly AtmEvent[],
	periods: readonly string[],
): number[] =>
	periods.map((period) =>
		events
			.filter((e) => e.date.slice(0, 7) <= period)
			.flatMap((e) => e.postings)
			.filter((p) => /^credits:(avail|held):/.test(p.account))
			.reduce((n, p) => n + Number(p.amount), 0),
	);

const SHIPPED_AT = 1_700_000_000_000;

/** The events as the books will read them: appended to an outbox, shipped to a folder, read back. */
const readBack = async (events: readonly AtmEvent[]): Promise<AtmEvent[]> => {
	const school = events[0]?.school;
	if (school === undefined) return [];
	const db = bunSqlite(new Database(":memory:"));
	db.exec(HANDLER_DDL);
	appendToOutbox(db, events, "live");
	const root = await tmp("scenario-read-back");
	try {
		const shipped = await shipOutbox({
			db,
			store: new FolderStore({ root }),
			school,
			nowMs: () => SHIPPED_AT,
		});
		expect(shipped.conflicts).toEqual([]);
		return (await readEvents(root, school)).events;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};

const check = async (input: unknown) => {
	const fixture = buildFixture(input);
	const events = await readBack(fixture.events);
	expect(events.map((e) => e.idem).sort()).toEqual(
		fixture.events.map((e) => e.idem).sort(),
	);
	const parity = await runParity({ events, periods: fixture.periods });
	const ran = parity.runs.filter((r) => r.status === "ok");
	expect(ran.length).toBeGreaterThanOrEqual(1);
	if (parity.mismatches.length > 0)
		throw new Error(
			`channels disagree:\n${parity.mismatches.slice(0, 20).join("\n")}`,
		);
	expect(parity.equal).toBe(true);
	// credits_outstanding: one school-wide number a month (never a holder or an account), equal to the postings' sum in every channel
	const expected = outstandingFrom(events, fixture.periods);
	for (const run of ran) {
		const outstanding = run.rows.filter((r) =>
			r.kpiId.startsWith("credits_outstanding"),
		);
		expect(outstanding.map((r) => r.kpiId)).toEqual(
			fixture.periods.map(() => "credits_outstanding"),
		);
		expect(outstanding.map((r) => r.value)).toEqual(expected);
	}
	const rows = (ran[0] as Extract<(typeof ran)[number], { status: "ok" }>).rows;
	const doc = `${JSON.stringify(goldenOf(fixture, rows), null, 2)}\n`;
	const path = join(GOLDEN, `${fixture.scenario.name}.json`);
	if (process.env.UPDATE_GOLDEN) {
		await mkdir(GOLDEN, { recursive: true });
		await writeFile(path, doc);
	}
	expect(doc).toBe(await Bun.file(path).text());
	return { fixture, parity };
};

describe("channel parity and goldens", () => {
	for (const name of PROFILE_NAMES)
		test(`${name}: every channel that runs has one KPI hash, equal to the golden`, async () => {
			await check({ profile: name });
		}, 60_000);
	for (const adhoc of ADHOC)
		test(`${adhoc.name} (ad hoc): every channel that runs has one KPI hash, equal to the golden`, async () => {
			await check(adhoc);
		}, 60_000);

	test("all three channels ran where hledger and DuckDB are installed", async () => {
		const { parity } = await check({ profile: "monthly-members" });
		expect(parity.runs.filter((r) => r.status === "ok").length).toBe(
			1 + Number(hasHledger) + Number(hasDuckdb),
		);
	}, 60_000);
});

/** Moves one payment by a cent in both of its postings, so the transaction still balances. */
const oneCentMore = (events: readonly AtmEvent[]): AtmEvent[] => {
	let done = false;
	return events.map((e) => {
		if (done || e.event_type !== "payment.succeeded") return e;
		done = true;
		return {
			...e,
			postings: e.postings.map((p) =>
				p.account === "assets:stripe"
					? { ...p, amount: (Number(p.amount) + 0.01).toFixed(2) }
					: p.account.startsWith("income:")
						? { ...p, amount: (Number(p.amount) - 0.01).toFixed(2) }
						: p,
			),
		};
	});
};

describe.skipIf(!(hasHledger || hasDuckdb))("a one-cent mutation", () => {
	for (const channel of ["atm", "hledger", "duckdb"] as const) {
		const available =
			channel === "atm" || (channel === "hledger" ? hasHledger : hasDuckdb);
		test.skipIf(!available)(
			`in the ${channel} channel's input only is caught, with a readable per-KPI diff`,
			async () => {
				const fixture = buildFixture({ profile: "monthly-members" });
				const clean = await runParity({
					events: fixture.events,
					periods: fixture.periods,
				});
				const mutated = await runParity({
					events: fixture.events,
					periods: fixture.periods,
					mutate: { [channel]: oneCentMore },
				});
				expect(clean.equal).toBe(true);
				expect(mutated.equal).toBe(false);
				const text = mutated.mismatches.join("\n");
				// the gross collected moved by a cent, and the diff names the KPI and both values
				expect(text).toContain("Gross collected");
				expect(text).toMatch(/gross_collected \d{4}-\d{2}: \w+=\d+ \w+=\d+/);
				expect(text).toContain("Net income");
			},
			60_000,
		);
	}
});
