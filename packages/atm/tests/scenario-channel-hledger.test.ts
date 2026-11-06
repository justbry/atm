/**
 * The hledger channel against the atm channel: the same KPI spec over the same events must give the same rows. The atm
 * channel folds the postings in TypeScript; the hledger channel has the `hledger` CLI do the adding over the journals
 * `buildJournal` writes. Run over the golden year (`fixtures/vibes-year`) and the multi-family fixture
 * (`fixtures/vibes-multi`); skipped when `hledger` is not installed.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import { loadScenarioBundle } from "../src/scenario/bundle.js";
import { runBundle } from "../src/scenario/bundle-run.js";
import { atmChannel } from "../src/scenario/channels/atm.js";
import { hledgerChannel } from "../src/scenario/channels/hledger.js";
import {
	diffKpis,
	evaluateKpis,
	type KpiRow,
	periodsFrom,
	SCHOOL_KPIS,
} from "../src/scenario/kpis.js";
import { hasHledger } from "./helpers.js";

const YEAR = join(import.meta.dir, "../fixtures/vibes-year");
const MULTI = join(import.meta.dir, "../fixtures/vibes-multi");

const rowsOf = async (
	channel: typeof atmChannel,
	events: Awaited<ReturnType<typeof readEvents>>["events"],
	periods: string[],
): Promise<KpiRow[]> =>
	evaluateKpis({
		spec: SCHOOL_KPIS,
		periods,
		base: await channel.base({ events, spec: SCHOOL_KPIS, periods }),
	});

const monthsOf = (events: { date: string }[]): string[] => {
	const months = events.map((e) => e.date.slice(0, 7)).sort();
	const start = months[0] as string;
	const [y1, m1] = start.split("-").map(Number) as [number, number];
	const [y2, m2] = (months.at(-1) as string).split("-").map(Number) as [
		number,
		number,
	];
	return periodsFrom(start, (y2 - y1) * 12 + (m2 - m1) + 1);
};

const value = (rows: KpiRow[], kpiId: string, period: string): number =>
	rows.find((r) => r.kpiId === kpiId && r.period === period)?.value ??
	Number.NaN;
const total = (rows: KpiRow[], kpiId: string): number =>
	rows.filter((r) => r.kpiId === kpiId).reduce((n, r) => n + r.value, 0);

describe.skipIf(!hasHledger)(
	"hledger channel parity with the atm channel",
	() => {
		const fixtures = [
			{ name: "vibes-year", root: YEAR, school: "sch_vol" },
			...readdirSync(join(MULTI, "schools")).map((school) => ({
				name: "vibes-multi",
				root: MULTI,
				school,
			})),
		];

		for (const { name, root, school } of fixtures) {
			test(`${name} ${school}: the rows are identical`, async () => {
				const { events } = await readEvents(root, school);
				const periods = monthsOf(events);
				const atm = await rowsOf(atmChannel, events, periods);
				const hledger = await rowsOf(hledgerChannel, events, periods);
				expect(
					diffKpis(
						{ name: "atm", rows: atm },
						{ name: "hledger", rows: hledger },
					),
				).toEqual([]);
				expect(hledger.length).toBe(atm.length);
				expect(hledger.length).toBeGreaterThan(0);
			});

			test(`${name} ${school}: a window of periods gives the same rows`, async () => {
				const { events } = await readEvents(root, school);
				const all = monthsOf(events);
				const periods = all.slice(1, -1);
				const atm = await rowsOf(atmChannel, events, periods);
				const hledger = await rowsOf(hledgerChannel, events, periods);
				expect(
					diffKpis(
						{ name: "atm", rows: atm },
						{ name: "hledger", rows: hledger },
					),
				).toEqual([]);
			});
		}

		test("vibes-year: the numbers are the fixture's own totals", async () => {
			const { events } = await readEvents(YEAR, "sch_vol");
			const periods = periodsFrom("2026-01", 12);
			const rows = await rowsOf(hledgerChannel, events, periods);
			// expected.json postingTotals: income 780.00 + 1560.00, refunds 130.00, fees 71.46, payouts 2138.54
			expect(total(rows, "gross_collected")).toBe(234000);
			expect(total(rows, "revenue_by_tier:sparkle-1")).toBe(78000);
			expect(total(rows, "revenue_by_tier:sparkle-2")).toBe(156000);
			expect(total(rows, "revenue_by_kind:membership")).toBe(234000);
			expect(total(rows, "refunds")).toBe(13000);
			expect(total(rows, "stripe_fees")).toBe(7146);
			expect(total(rows, "payouts")).toBe(213854);
			expect(total(rows, "net_income")).toBe(234000 - 13000 - 7146);
			// credits: issued 2 + 6 + 12, spent 8 + 3 + 4, expired 2
			expect(total(rows, "credits_granted")).toBe(20);
			expect(total(rows, "credits_consumed")).toBe(15);
			expect(total(rows, "credits_expired")).toBe(2);
			// a closing balance is a running total: the last month holds the whole year's postings
			expect(
				value(
					rows,
					"closing_balance_usd:income:billing:membership:sparkle-2",
					"2026-12",
				),
			).toBe(-156000);
			expect(
				value(
					rows,
					"closing_balance_usd:expenses:billing:stripe-fees",
					"2026-12",
				),
			).toBe(7146);
			expect(value(rows, "closing_balance_usd:assets:stripe", "2026-12")).toBe(
				0,
			);
			expect(
				value(rows, "closing_balance_credits:credits:issued:gift", "2026-12"),
			).toBe(-2);
			expect(
				value(
					rows,
					"closing_balance_credits:credits:spent:energy-45",
					"2026-12",
				),
			).toBe(8);
		});
	},
);

describe.skipIf(!hasHledger)(
	"a dimension of several accounts does not pull in the accounts of the KPI's own filter",
	() => {
		test("revenue by kind counts the membership of two tiers without the gift add-on beside it", async () => {
			const bundle = await loadScenarioBundle(
				join(import.meta.dir, "../fixtures/scenarios/codes"),
			);
			const run = await runBundle(bundle, { channels: [] });
			try {
				const school = run.schools[0] as (typeof run.schools)[number];
				// the same month holds sparkle-2 membership, a gift add-on and (renamed here) a second membership account
				let renamed = false;
				const events = school.events.map((event) => {
					if (renamed || event.event_type !== "payment.succeeded") return event;
					if (
						!event.postings.some(
							(p) => p.account === "income:billing:membership:sparkle-2",
						)
					)
						return event;
					renamed = true;
					return {
						...event,
						postings: event.postings.map((p) =>
							p.account === "income:billing:membership:sparkle-2"
								? { ...p, account: "income:billing:membership:sparkle-1" }
								: p,
						),
					};
				});
				expect(renamed).toBe(true);
				expect(
					events.some((event) =>
						event.postings.some((p) =>
							p.account.startsWith("income:billing:addon:"),
						),
					),
				).toBe(true);
				const periods = school.periods;
				const [atm, hledger] = await Promise.all(
					[atmChannel, hledgerChannel].map((channel) =>
						rowsOf(channel, events, periods),
					),
				);
				expect(
					diffKpis(
						{ name: "atm", rows: atm as KpiRow[] },
						{ name: "hledger", rows: hledger as KpiRow[] },
					),
				).toEqual([]);
			} finally {
				await run.dispose();
			}
		});
	},
);
