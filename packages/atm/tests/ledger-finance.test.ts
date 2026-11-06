/**
 * The finance views: the month and member objects, the income statement and `membersIncome`. The statement is TypeScript
 * (a Worker cannot run hledger) and must equal what `hledger is` prints from the same events, so it is checked against
 * hledger over the fifteen scenario presets, for the whole log and for a range that starts and ends mid-month, with the
 * previous period; and, without hledger, against the committed income-statement CSV of the golden year.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { catalogPublishedEvent } from "../src/ledger/catalog.js";
import { SCHOOL_KPI_SPEC } from "../src/ledger/contributions.js";
import { readEvents } from "../src/ledger/files.js";
import {
	buildFinance,
	type FinanceMonthObject,
	financeMonthsFor,
	incomeStatement,
	membersIncome,
	previousPeriod,
	type StatementFigures,
	type StatementPeriod,
} from "../src/ledger/finance.js";
import { accountsJournal, monthJournal } from "../src/ledger/journal.js";
import { ledgerEvent } from "../src/ledger/postings.js";
import { decimalToUnits } from "../src/ledger/util.js";
import { atmChannel } from "../src/scenario/channels/atm.js";
import { generateScenario } from "../src/scenario/generate.js";
import { PROFILES, resolveScenario } from "../src/scenario/profiles.js";
import type { AtmEvent, Menu } from "../src/types.js";
import { hasHledger } from "./helpers.js";
import { menu as handMenu } from "./ledger-read-log.js";

const CENTS = 2;
const DAY_MS = 86_400_000;
const TZ = "America/Denver";

const presetEvents = (profile: string): AtmEvent[] =>
	generateScenario(resolveScenario({ profile })).events;

const monthsOf = (events: readonly AtmEvent[]) =>
	Object.fromEntries(
		Object.entries(buildFinance(events).months).map(([month, view]) => [
			month,
			{ school: "sch", month, ...view } satisfies FinanceMonthObject,
		]),
	);

const shiftDay = (date: string, days: number): string =>
	new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
		.toISOString()
		.slice(0, 10);

const datesOf = (events: readonly AtmEvent[]): string[] =>
	events.map((event) => event.date).sort();

// ---- hledger

const cellsOf = (line: string): string[] =>
	[...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] as string);

/** "2138.54 USD" -> 213854; "0" -> 0. */
const centsOf = (amount: string): number => {
	if (amount === "0") return 0;
	const [number] = amount.split(" ") as [string];
	return Number(decimalToUnits(number.replace(/,/g, ""), CENTS));
};

/** The journal of every event with postings, as one text hledger reads from stdin. */
const journalOf = (events: readonly AtmEvent[]): string => {
	const months = [
		...new Set(events.map((event) => event.date.slice(0, 7))),
	].sort();
	return [
		accountsJournal(events),
		...months.map((m) => monthJournal(events, m)),
	].join("\n");
};

type HledgerStatement = {
	accounts: Map<string, number>;
	net: number;
};

/** `hledger is` over `from`..`to` (inclusive days): each account's balance, revenue positive, and the net. */
const hledgerStatement = (
	journal: string,
	from: string,
	to: string,
): HledgerStatement => {
	const run = Bun.spawnSync(
		[
			"hledger",
			"-f",
			"journal:-",
			"is",
			"-b",
			from,
			"-e",
			shiftDay(to, 1),
			"-O",
			"csv",
		],
		{ stdin: Buffer.from(journal), stdout: "pipe", stderr: "pipe" },
	);
	expect(run.stderr.toString()).toBe("");
	expect(run.exitCode).toBe(0);
	const accounts = new Map<string, number>();
	let net = 0;
	for (const line of run.stdout.toString().trim().split("\n")) {
		const [label, value] = cellsOf(line);
		if (label === undefined || value === undefined) continue;
		if (label === "Net:") net = centsOf(value);
		else if (label.includes(":") && !label.endsWith(":"))
			accounts.set(label, centsOf(value));
	}
	return { accounts, net };
};

const linesOf = (period: StatementPeriod): Map<string, number> =>
	new Map(
		[...period.income, ...period.expenses].map((line) => [
			line.account,
			line.cents,
		]),
	);

const expectEqualsHledger = (
	period: StatementPeriod,
	hledger: HledgerStatement,
	label: string,
) => {
	// hledger drops an account whose balance is zero, as the statement does
	const shown = new Map(
		[...hledger.accounts].filter(([, value]) => value !== 0),
	);
	expect(Object.fromEntries(linesOf(period)), label).toEqual(
		Object.fromEntries(shown),
	);
	expect(period.figures.net, `${label} net`).toBe(hledger.net);
};

const figureNames = (figures: StatementFigures) =>
	Object.keys(figures) as (keyof StatementFigures)[];

describe.skipIf(!hasHledger)("the income statement equals hledger's", () => {
	for (const { name } of PROFILES) {
		test(name, () => {
			const events = presetEvents(name);
			const months = Object.values(monthsOf(events));
			const journal = journalOf(events);
			const dates = datesOf(events);
			const first = dates[0] as string;
			const last = dates.at(-1) as string;
			const ranges = [
				{ from: first, to: last },
				{ from: shiftDay(first, 40), to: shiftDay(first, 107) },
			];
			for (const { from, to } of ranges) {
				const statement = incomeStatement(months, { from, to, compare: true });
				expectEqualsHledger(
					statement,
					hledgerStatement(journal, from, to),
					`${name} ${from}..${to}`,
				);
				const previous = statement.previous;
				if (previous === null) throw new Error("compare gives a previous");
				const range = previousPeriod(from, to);
				expect([previous.from, previous.to]).toEqual([range.from, range.to]);
				expectEqualsHledger(
					previous,
					hledgerStatement(journal, range.from, range.to),
					`${name} previous of ${from}..${to}`,
				);
				for (const figure of figureNames(statement.figures))
					expect(previous.changes[figure], `${name} changes.${figure}`).toBe(
						statement.figures[figure] - previous.figures[figure],
					);
			}
		});
	}

	test("(control) the comparison fails for a statement one cent off", () => {
		const events = presetEvents("monthly-members");
		const months = Object.values(monthsOf(events));
		const dates = datesOf(events);
		const from = dates[0] as string;
		const to = dates.at(-1) as string;
		const statement = incomeStatement(months, { from, to, compare: false });
		expect(statement.income.length).toBeGreaterThan(0);
		const off = {
			...statement,
			income: statement.income.map((line, index) =>
				index === 0 ? { ...line, cents: line.cents + 1 } : line,
			),
		};
		expect(() =>
			expectEqualsHledger(
				off,
				hledgerStatement(journalOf(events), from, to),
				"off",
			),
		).toThrow();
	});

	test("a range with no events is all zeros", () => {
		const events = presetEvents("tiny-school");
		const months = Object.values(monthsOf(events));
		const statement = incomeStatement(months, {
			from: "2001-01-01",
			to: "2001-01-31",
			compare: false,
		});
		expect(statement.income).toEqual([]);
		expect(statement.expenses).toEqual([]);
		expect(statement.figures.net).toBe(0);
		expect(statement.previous).toBeNull();
	});
});

describe("the income statement against the committed golden", () => {
	test("each month of the golden year equals its column of hledger's monthly income statement", async () => {
		const { events } = await readEvents(
			join(import.meta.dir, "../fixtures/vibes-year"),
			"sch_vol",
		);
		const months = Object.values(monthsOf(events));
		const csv = await Bun.file(
			join(import.meta.dir, "golden/reports/income-statement-monthly.csv"),
		).text();
		const lines = csv.trim().split("\n").map(cellsOf);
		const header = lines[1] as string[];
		const monthNames = header.slice(1);
		const year = 2026;
		for (const [index, abbreviation] of monthNames.entries()) {
			const number = String(index + 1).padStart(2, "0");
			const from = `${year}-${number}-01`;
			const to = new Date(Date.UTC(year, index + 1, 0))
				.toISOString()
				.slice(0, 10);
			const statement = incomeStatement(months, { from, to, compare: false });
			const golden = new Map<string, number>();
			let net = 0;
			for (const cells of lines.slice(2)) {
				const label = cells[0] as string;
				const value = cells[index + 1] as string;
				if (label === "Net:") net = centsOf(value);
				else if (
					label.includes(":") &&
					!label.endsWith(":") &&
					centsOf(value) !== 0
				)
					golden.set(label, centsOf(value));
			}
			expect(Object.fromEntries(linesOf(statement)), abbreviation).toEqual(
				Object.fromEntries(golden),
			);
			expect(statement.figures.net, `${abbreviation} net`).toBe(net);
		}
	});
});

// ---- the objects

const payment = (over: {
	id: string;
	at: string;
	key: string;
	amount: number;
	fee?: number;
	kind: string;
	payload?: Record<string, unknown>;
}): AtmEvent =>
	ledgerEvent({
		type: "payment.succeeded",
		school: "sch_f",
		tz: TZ,
		eventTime: over.at,
		key: over.key,
		idem: over.id,
		amount: over.amount,
		fee: over.fee ?? 0,
		incomeKind: over.kind,
		payload: {
			id: `in_${over.id}`,
			amount_paid: over.amount,
			fee: over.fee ?? 0,
			currency: "usd",
			customer: "cus_x",
			billing_email: "ada@example.com",
			billing_name: "Ada Lovelace",
			...over.payload,
		},
	});

const hand = (): AtmEvent[] => [
	payment({
		id: "p1",
		at: "2026-01-10T18:00:00Z",
		key: "family:fam_a",
		amount: 6500,
		fee: 215,
		kind: "membership:glow",
	}),
	payment({
		id: "p2",
		at: "2026-01-31T18:00:00Z",
		key: "family:fam_b",
		amount: 4000,
		fee: 150,
		kind: "booking",
		payload: { booking: "bk_1", payment_intent: "pi_bk_1" },
	}),
	payment({
		id: "p3",
		at: "2026-02-01T18:00:00Z",
		key: "family:fam_a",
		amount: 6500,
		fee: 215,
		kind: "membership:glow",
	}),
	ledgerEvent({
		type: "payment.refunded",
		school: "sch_f",
		tz: TZ,
		eventTime: "2026-02-03T18:00:00Z",
		key: "family:fam_a",
		idem: "r1",
		amount: 2000,
		payload: {
			id: "re_1",
			amount: 2000,
			currency: "usd",
			payment_intent: "pi_1",
			billing_email: "ada@example.com",
		},
	}),
	ledgerEvent({
		type: "payment.disputed",
		school: "sch_f",
		tz: TZ,
		eventTime: "2026-02-05T18:00:00Z",
		key: "family:fam_b",
		idem: "d1",
		amount: 4000,
		fee: 1500,
		payload: { id: "dp_1", amount: 4000 },
	}),
	ledgerEvent({
		type: "payout.paid",
		school: "sch_f",
		tz: TZ,
		eventTime: "2026-02-06T18:00:00Z",
		key: "sch_f",
		idem: "po1",
		amount: 9000,
		payload: { id: "po_1", amount: 9000 },
	}),
	ledgerEvent({
		type: "fundraise.received",
		school: "sch_f",
		tz: TZ,
		eventTime: "2026-02-07T18:00:00Z",
		key: "sch_f",
		idem: "f1",
		amount: 2500,
		campaign: "spring-gala",
		payload: { id: "z_1", amount: 2500, campaign: "spring-gala" },
	}),
	ledgerEvent({
		type: "fundraise.received",
		school: "sch_f",
		tz: TZ,
		eventTime: "2026-02-08T18:00:00Z",
		key: "sch_f",
		idem: "f2",
		amount: 1000,
		campaign: "annual-fund",
		payload: { id: "z_2", amount: 1000, campaign: "annual-fund" },
	}),
	ledgerEvent({
		type: "fundraise.paid_out",
		school: "sch_f",
		tz: TZ,
		eventTime: "2026-03-02T18:00:00Z",
		key: "sch_f",
		idem: "f3",
		amount: 3500,
		payload: { id: "zp_1", amount: 3500 },
	}),
];

describe("the finance month object", () => {
	const { months } = buildFinance(hand());

	test("the month's money: gross, refunded, fees, net, disputes, payouts", () => {
		expect(months["2026-01"]?.money).toEqual({
			grossCents: 10500,
			refundedCents: 0,
			feeCents: 365,
			netCents: 10135,
			disputeCents: 0,
			disputeFeeCents: 0,
			payoutCents: 0,
		});
		expect(months["2026-02"]?.money).toEqual({
			grossCents: 6500,
			refundedCents: 2000,
			feeCents: 215,
			netCents: 4285,
			disputeCents: 4000,
			disputeFeeCents: 1500,
			payoutCents: 9000,
		});
		expect(months["2026-02"]?.counts).toEqual({
			payments: 1,
			refunds: 1,
			disputes: 1,
			payouts: 1,
		});
	});

	test("income by account and by plan", () => {
		expect(months["2026-01"]?.income).toEqual({
			byAccount: {
				"income:billing:booking": 4000,
				"income:billing:membership:glow": 6500,
			},
			byPlan: { glow: 6500 },
		});
	});

	test("fundraising by campaign, and what Zeffy paid out", () => {
		expect(months["2026-02"]?.fundraising).toEqual({
			byCampaign: {
				"annual-fund": { receivedCents: 1000 },
				"spring-gala": { receivedCents: 2500 },
			},
			receivedCents: 3500,
			paidOutCents: 0,
		});
		// a month whose only money is a Zeffy payout still has an object
		expect(months["2026-03"]?.fundraising).toEqual({
			byCampaign: {},
			receivedCents: 0,
			paidOutCents: 3500,
		});
	});

	test("days hold the profit-and-loss accounts, and the months' days add up to the month", () => {
		const day = months["2026-01"]?.days["2026-01-10"];
		expect(day?.accounts).toEqual({
			"expenses:billing:stripe-fees": 215,
			"income:billing:membership:glow": -6500,
		});
		expect(day?.counts.payments).toBe(1);
	});

	test("a failed payout takes its amount off the payouts and is not counted", () => {
		const failed = ledgerEvent({
			type: "payout.paid",
			school: "sch_f",
			tz: TZ,
			eventTime: "2026-02-09T18:00:00Z",
			key: "sch_f",
			idem: "po2",
			amount: 9000,
			failed: true,
			payload: { id: "po_1", amount: 9000, failed: true },
		});
		const view = buildFinance([...hand(), failed]).months["2026-02"];
		expect(view?.money.payoutCents).toBe(0);
		expect(view?.counts.payouts).toBe(1);
	});

	test("a payment in another currency is counted as skipped, not booked", () => {
		const skipped = ledgerEvent({
			type: "money.skipped",
			school: "sch_f",
			tz: TZ,
			eventTime: "2026-04-02T18:00:00Z",
			key: "sch_f",
			idem: "ms1",
			payload: {
				id: "in_cad",
				kind: "payment",
				reason: "non_usd",
				currency: "cad",
				amount: 5000,
			},
		});
		const view = buildFinance([...hand(), skipped]).months["2026-04"];
		expect(view?.skippedNonUsd).toBe(1);
		expect(view?.money.grossCents).toBe(0);
	});
});

describe("the finance member object", () => {
	const { members } = buildFinance(hand());

	test("a holder's payments, refunds and last payment", () => {
		const member = members["family:fam_a"];
		expect(
			member?.payments.map((p) => [p.date, p.amountCents, p.feeCents]),
		).toEqual([
			["2026-01-10", 6500, 215],
			["2026-02-01", 6500, 215],
		]);
		expect(member?.payments[0]?.incomeKind).toBe("membership:glow");
		expect(member?.refunds).toEqual([
			{
				date: "2026-02-03",
				eventId: member?.refunds[0]?.eventId as string,
				id: "re_1",
				paymentIntent: "pi_1",
				invoice: null,
				booking: null,
				amountCents: 2000,
			},
		]);
		expect(member?.lastPayment).toEqual({
			date: "2026-02-01",
			amountCents: 6500,
		});
		expect(member?.paidCents).toBe(13000);
		expect(member?.refundedCents).toBe(2000);
	});

	test("a booking's payment names the booking and its payment intent", () => {
		const payment = members["family:fam_b"]?.payments[0];
		expect(payment?.booking).toBe("bk_1");
		expect(payment?.paymentIntent).toBe("pi_bk_1");
		expect(payment?.incomeKind).toBe("booking");
	});

	test("only family holders have an object: a payout's key does not", () => {
		expect(Object.keys(members).sort()).toEqual([
			"family:fam_a",
			"family:fam_b",
		]);
	});

	test("no name, email or billing field is in any finance object", () => {
		const text = JSON.stringify(buildFinance(hand()));
		for (const secret of [
			"ada@example.com",
			"Ada Lovelace",
			"billing_",
			"cus_x",
		])
			expect(text).not.toContain(secret);
	});
});

describe("incomeStatement and membersIncome on a hand-built log", () => {
	const months = Object.values(monthsOf(hand()));

	test("the figures, signed as a statement shows them", () => {
		const statement = incomeStatement(months, {
			from: "2026-02-01",
			to: "2026-02-28",
			compare: false,
		});
		expect(statement.figures).toEqual({
			memberships: 6500,
			bookings: 0,
			otherIncome: 0,
			fundraising: 3500,
			income: 10000,
			refunds: -2000,
			fees: -215,
			disputes: -5500,
			otherExpenses: 0,
			net: 2285,
			paidOut: 9000,
		});
		expect(statement.counts).toEqual({
			payments: 1,
			refunds: 1,
			disputes: 1,
			payouts: 1,
		});
	});

	test("a range inside a month sums only its days", () => {
		const statement = incomeStatement(months, {
			from: "2026-01-11",
			to: "2026-01-31",
			compare: false,
		});
		expect(statement.figures.bookings).toBe(4000);
		expect(statement.figures.memberships).toBe(0);
	});

	test("previous is the period of the same length before, and changes is current less previous", () => {
		const statement = incomeStatement(months, {
			from: "2026-02-01",
			to: "2026-02-28",
			compare: true,
		});
		expect(statement.previous?.from).toBe("2026-01-04");
		expect(statement.previous?.to).toBe("2026-01-31");
		expect(statement.previous?.figures.memberships).toBe(6500);
		expect(statement.previous?.figures.bookings).toBe(4000);
		expect(statement.previous?.changes.memberships).toBe(0);
		expect(statement.previous?.changes.bookings).toBe(-4000);
		expect(statement.previous?.changes.income).toBe(10000 - 10500);
		expect(statement.previous?.changes.net).toBe(
			statement.figures.net - (statement.previous?.figures.net as number),
		);
	});

	test("membersIncome is memberships plus bookings for the range", () => {
		expect(membersIncome(months, "2026-01-01", "2026-01-31")).toBe(10500);
		expect(membersIncome(months, "2026-01-11", "2026-02-28")).toBe(4000 + 6500);
		expect(membersIncome(months, "2027-01-01", "2027-01-31")).toBe(0);
	});

	test("previousPeriod and financeMonthsFor", () => {
		expect(previousPeriod("2026-03-01", "2026-03-31")).toEqual({
			from: "2026-01-29",
			to: "2026-02-28",
		});
		expect(previousPeriod("2026-01-01", "2026-01-01")).toEqual({
			from: "2025-12-31",
			to: "2025-12-31",
		});
		expect(financeMonthsFor("2025-11-20", "2026-02-03")).toEqual([
			"2025-11",
			"2025-12",
			"2026-01",
			"2026-02",
		]);
		expect(financeMonthsFor("2026-05-01", "2026-05-31")).toEqual(["2026-05"]);
		// with compare, the months of the previous period too: 2026-04-01..2026-04-30 is 30 days, so before it ends 2026-03-31
		expect(financeMonthsFor("2026-04-01", "2026-04-30", true)).toEqual([
			"2026-03",
			"2026-04",
		]);
	});

	test("a bad range throws", () => {
		expect(() =>
			incomeStatement(months, {
				from: "2026-02-01",
				to: "2026-01-01",
				compare: false,
			}),
		).toThrow(/after/);
		expect(() => membersIncome(months, "2026-2-1", "2026-03-01")).toThrow(
			/YYYY-MM-DD/,
		);
	});
});

describe("daily gross", () => {
	test("each month's grossByDay is as long as the month, indexed from the 1st, and sums to the month's gross", () => {
		const { months } = buildFinance(hand());
		expect(months["2026-01"]?.grossByDay.length).toBe(31);
		expect(months["2026-02"]?.grossByDay.length).toBe(28);
		expect(months["2026-01"]?.grossByDay[9]).toBe(6500);
		expect(months["2026-01"]?.grossByDay[30]).toBe(4000);
		expect(months["2026-02"]?.grossByDay[0]).toBe(6500);
		// a refund and a dispute are not gross
		expect(months["2026-02"]?.grossByDay[2]).toBe(0);
	});

	test("over every preset, the days sum to the month's gross and to the gross_collected KPI", () => {
		for (const { name } of PROFILES) {
			const events = presetEvents(name);
			const { months } = buildFinance(events);
			const periods = Object.keys(months);
			const base = atmChannel.base({
				events,
				spec: SCHOOL_KPI_SPEC,
				periods,
			});
			for (const [month, view] of Object.entries(months)) {
				const total = view.grossByDay.reduce((sum, n) => sum + n, 0);
				expect(total, `${name} ${month}`).toBe(view.money.grossCents);
				expect(total, `${name} ${month} KPI`).toBe(
					base.gross_collected?.[month] ?? 0,
				);
			}
		}
	});
});

describe("plan order", () => {
	const menu = {
		...handMenu,
		tiers: [
			{ ...(handMenu.tiers[0] as Menu["tiers"][number]), id: "zeta" },
			{ ...(handMenu.tiers[0] as Menu["tiers"][number]), id: "alpha" },
			{ ...(handMenu.tiers[0] as Menu["tiers"][number]), id: "mid" },
		],
	};
	const paid = (kind: string, id: string) =>
		payment({
			id,
			at: "2026-01-10T18:00:00Z",
			key: `family:${id}`,
			amount: 1000,
			kind,
		});

	test("follows the latest catalog.published menu's tiers, paid or not, then plans the menu lacks by name", () => {
		const events = [
			catalogPublishedEvent({
				school: "sch_f",
				menu,
				version: 1,
				eventTime: "2026-01-01T00:00:00Z",
			}),
			paid("membership:mid", "a"),
			paid("membership:old-b", "b"),
			paid("membership:old-a", "c"),
		];
		const month = buildFinance(events).months["2026-01"];
		expect(month?.income.planOrder).toEqual([
			"zeta",
			"alpha",
			"mid",
			"old-a",
			"old-b",
		]);
		expect(Object.keys(month?.income.byPlan ?? {}).sort()).toEqual([
			"mid",
			"old-a",
			"old-b",
		]);
	});

	test("the latest menu by event id wins", () => {
		const later = {
			...menu,
			tiers: [...menu.tiers].reverse(),
		};
		const events = [
			catalogPublishedEvent({
				school: "sch_f",
				menu,
				version: 1,
				eventTime: "2026-01-01T00:00:00Z",
			}),
			catalogPublishedEvent({
				school: "sch_f",
				menu: later,
				version: 2,
				eventTime: "2026-01-05T00:00:00Z",
			}),
			paid("membership:mid", "a"),
		];
		expect(buildFinance(events).months["2026-01"]?.income.planOrder).toEqual([
			"mid",
			"alpha",
			"zeta",
		]);
	});

	test("without a catalog event there is no planOrder", () => {
		const month = buildFinance([paid("membership:mid", "a")]).months["2026-01"];
		expect(month?.income.planOrder).toBeUndefined();
	});
});
