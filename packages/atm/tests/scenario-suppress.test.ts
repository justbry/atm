/** The KPI suppression evaluator on synthetic shares: each rule at its threshold, then the events-to-shares tooling. */
import { describe, expect, test } from "bun:test";
import {
	type BaseValues,
	evaluateKpis,
	periodsFrom,
	SCHOOL_KPIS,
} from "../src/scenario/kpis.js";
import {
	type Contributions,
	contributionsFromEvents,
	type Shares,
	type SuppressedDocument,
	suppressKpis,
} from "../src/scenario/suppress.js";
import type { AtmEvent } from "../src/types.js";

const PERIODS = periodsFrom("2026-01", 3);
const FIRST = PERIODS[0] as string;
const ENOUGH_PAYERS = 12;

/** `count` holders (`prefix:1` ..) each contributing `each`. */
const evenShares = (count: number, each: number, prefix = "family"): Shares =>
	Object.fromEntries(
		Array.from({ length: count }, (_, i) => [`${prefix}:h${i + 1}`, each]),
	);

const total = (shares: Shares): number =>
	Object.values(shares).reduce((n, v) => n + v, 0);

type Cells = Record<string, Shares>;

/** One period (the first): each id's shares become its value and its contributions. */
const run = ({
	cells,
	providers,
	activePayers = ENOUGH_PAYERS,
	periods = [FIRST],
}: {
	cells: Cells;
	providers?: Cells;
	activePayers?: number;
	periods?: string[];
}): SuppressedDocument => {
	const base: BaseValues = {};
	const contributions: Contributions = {};
	for (const [id, shares] of Object.entries(cells)) {
		base[id] = { [FIRST]: total(shares) };
		contributions[id] = { [FIRST]: shares };
	}
	const providerContributions = providers
		? Object.fromEntries(
				Object.entries(providers).map(([id, shares]) => [
					id,
					{ [FIRST]: shares },
				]),
			)
		: undefined;
	return suppressKpis({
		spec: SCHOOL_KPIS,
		rows: evaluateKpis({ spec: SCHOOL_KPIS, base, periods }),
		contributions,
		...(providerContributions ? { providerContributions } : {}),
		activePayers,
	});
};

const cellOf = (doc: SuppressedDocument, id: string, period = FIRST) =>
	doc.series[id]?.[doc.periods.indexOf(period)];
const reasonOf = (doc: SuppressedDocument, id: string, period = FIRST) =>
	doc.reasons[id]?.[doc.periods.indexOf(period)];

describe("cell rules", () => {
	test("returns the default rules", () => {
		const doc = run({ cells: {} });
		expect(doc.rules).toEqual({ minContributors: 5, maxShare: 0.6 });
		expect(doc.grain).toBe("month");
	});

	test("4 holders hide a cell, 5 show it", () => {
		const doc = run({
			cells: {
				credits_granted: evenShares(4, 10),
				credits_expired: evenShares(5, 10),
			},
		});
		expect(cellOf(doc, "credits_granted")).toBeNull();
		expect(reasonOf(doc, "credits_granted")).toBe("few_holders");
		expect(cellOf(doc, "credits_expired")).toBe(50);
		expect(reasonOf(doc, "credits_expired")).toBeNull();
	});

	test("a holder with a zero share is not a contributor", () => {
		const doc = run({
			cells: { credits_granted: { ...evenShares(4, 10), "family:zero": 0 } },
		});
		expect(reasonOf(doc, "credits_granted")).toBe("few_holders");
	});

	test("the largest holder at exactly 60% is shown, above it is hidden", () => {
		const atLimit = { "family:big": 60, ...evenShares(4, 10, "profile") };
		const above = { "family:big": 61, ...evenShares(4, 10, "profile") };
		const doc = run({
			cells: { credits_granted: atLimit, credits_expired: above },
		});
		expect(cellOf(doc, "credits_granted")).toBe(100);
		expect(cellOf(doc, "credits_expired")).toBeNull();
		expect(reasonOf(doc, "credits_expired")).toBe("dominant_holder");
		const hidden = doc.hiddenCells.find((c) => c.kpiId === "credits_expired");
		expect(hidden?.contributors).toBe(5);
		expect(hidden?.largestShare).toBeCloseTo(0.604, 3);
	});

	test("a negative total is tested on its absolute value", () => {
		const doc = run({
			cells: {
				credits_granted: evenShares(5, -20),
				credits_expired: { "family:big": -70, ...evenShares(4, -10) },
			},
		});
		expect(cellOf(doc, "credits_granted")).toBe(-100);
		expect(reasonOf(doc, "credits_expired")).toBe("dominant_holder");
	});

	test("contributors that cancel out to a zero total are hidden", () => {
		const doc = run({
			cells: {
				credits_granted: {
					...evenShares(3, 10),
					"family:a": -15,
					"family:b": -15,
				},
			},
		});
		expect(cellOf(doc, "credits_granted")).toBeNull();
		expect(reasonOf(doc, "credits_granted")).toBe("dominant_holder");
	});

	test("an empty cell is shown as 0, or hidden when asked", () => {
		const base = evaluateKpis({
			spec: SCHOOL_KPIS,
			base: {},
			periods: [FIRST],
		});
		const input = {
			spec: SCHOOL_KPIS,
			rows: base,
			contributions: {},
			activePayers: ENOUGH_PAYERS,
		};
		expect(cellOf(suppressKpis(input), "credits_granted")).toBe(0);
		expect(
			cellOf(
				suppressKpis({ ...input, hideEmptyCells: true }),
				"credits_granted",
			),
		).toBeNull();
	});

	test("a nonzero cell with no contribution data is hidden", () => {
		const doc = suppressKpis({
			spec: SCHOOL_KPIS,
			rows: evaluateKpis({
				spec: SCHOOL_KPIS,
				base: { credits_granted: { [FIRST]: 50 } },
				periods: [FIRST],
			}),
			contributions: {},
			activePayers: ENOUGH_PAYERS,
		});
		expect(reasonOf(doc, "credits_granted")).toBe("few_holders");
	});

	test("rules are parameters and come back in the output", () => {
		const doc = suppressKpis({
			spec: SCHOOL_KPIS,
			rows: evaluateKpis({
				spec: SCHOOL_KPIS,
				base: { credits_granted: { [FIRST]: 30 } },
				periods: [FIRST],
			}),
			contributions: { credits_granted: { [FIRST]: evenShares(3, 10) } },
			activePayers: ENOUGH_PAYERS,
			rules: { minContributors: 3, maxShare: 0.4 },
		});
		expect(doc.rules).toEqual({ minContributors: 3, maxShare: 0.4 });
		expect(cellOf(doc, "credits_granted")).toBe(30);
	});
});

describe("provider rule", () => {
	const cells = { credits_consumed: evenShares(5, 10) };

	test("is not applied without provider contributions", () => {
		expect(cellOf(run({ cells }), "credits_consumed")).toBe(50);
	});

	test("4 providers hide a booking cell, 5 show it", () => {
		const few = run({
			cells,
			providers: { credits_consumed: evenShares(4, 10, "tutor") },
		});
		expect(reasonOf(few, "credits_consumed")).toBe("few_providers");
		const enough = run({
			cells,
			providers: { credits_consumed: evenShares(5, 10, "tutor") },
		});
		expect(cellOf(enough, "credits_consumed")).toBe(50);
	});

	test("a provider over 60% hides it", () => {
		const doc = run({
			cells,
			providers: {
				credits_consumed: { "tutor:big": 31, ...evenShares(4, 5, "tutor") },
			},
		});
		expect(reasonOf(doc, "credits_consumed")).toBe("dominant_provider");
		expect(doc.hiddenCells[0]?.largestShare).toBeCloseTo(0.62, 2);
	});

	test("does not apply to a KPI outside the provider set", () => {
		const doc = run({
			cells: { credits_granted: evenShares(5, 10) },
			providers: { credits_granted: evenShares(1, 50, "tutor") },
		});
		expect(cellOf(doc, "credits_granted")).toBe(50);
	});
});

describe("complementary suppression", () => {
	const kinds = (membership: Shares) => ({
		"revenue_by_kind:membership": membership,
		"revenue_by_kind:addon": evenShares(5, 100),
		"revenue_by_kind:booking": evenShares(5, 200),
	});
	const withTotal = (cells: Cells): Cells => {
		const all = Object.entries(cells)
			.filter(([id]) => id.startsWith("revenue_by_kind:"))
			.flatMap(([, shares]) => Object.entries(shares));
		return { ...cells, gross_collected: Object.fromEntries(all) };
	};

	test("one hidden term hides the next smallest visible one", () => {
		const doc = run({ cells: withTotal(kinds(evenShares(3, 50))) });
		expect(reasonOf(doc, "revenue_by_kind:membership")).toBe("few_holders");
		expect(reasonOf(doc, "revenue_by_kind:addon")).toBe("complement");
		expect(cellOf(doc, "revenue_by_kind:booking")).toBe(1000);
		expect(cellOf(doc, "gross_collected")).not.toBeNull();
	});

	test("nothing extra is hidden when every term is visible", () => {
		const doc = run({ cells: withTotal(kinds(evenShares(5, 50))) });
		expect(doc.hiddenCells).toEqual([]);
	});

	test("two hidden terms are enough, and a hidden total needs nothing", () => {
		const twoHidden = run({
			cells: withTotal({
				...kinds(evenShares(3, 50)),
				"revenue_by_kind:addon": evenShares(3, 100),
			}),
		});
		expect(reasonOf(twoHidden, "revenue_by_kind:booking")).toBeNull();
		const hiddenTotal = run({
			cells: {
				...kinds(evenShares(3, 50)),
				gross_collected: evenShares(3, 500),
			},
		});
		expect(reasonOf(hiddenTotal, "revenue_by_kind:addon")).toBeNull();
	});

	test("hides a nonzero term before an empty one", () => {
		const doc = run({
			cells: withTotal({
				"revenue_by_kind:membership": evenShares(3, 50),
				"revenue_by_kind:booking": evenShares(5, 200),
			}),
		});
		expect(reasonOf(doc, "revenue_by_kind:booking")).toBe("complement");
	});

	test("tiers add up to the membership kind and the hiding cascades", () => {
		const doc = run({
			cells: withTotal({
				...kinds(evenShares(5, 100)),
				"revenue_by_tier:fellow": evenShares(2, 100),
				"revenue_by_tier:scholar": evenShares(5, 60),
				"revenue_by_tier:guest": evenShares(5, 40),
			}),
		});
		expect(reasonOf(doc, "revenue_by_tier:fellow")).toBe("few_holders");
		expect(reasonOf(doc, "revenue_by_tier:guest")).toBe("complement");
		expect(cellOf(doc, "revenue_by_tier:scholar")).toBe(300);
	});
});

describe("derived KPIs", () => {
	test("are hidden whenever an input is hidden", () => {
		const doc = run({
			cells: {
				gross_collected: evenShares(3, 100),
				refunds: evenShares(5, 10),
				paying_members: evenShares(5, 1),
				payments_count: evenShares(5, 1),
				disputes_opened: evenShares(5, 1),
			},
		});
		expect(reasonOf(doc, "net_income")).toBe("derived_input");
		expect(reasonOf(doc, "refund_rate")).toBe("derived_input");
		expect(reasonOf(doc, "arpa")).toBe("derived_input");
		expect(cellOf(doc, "dispute_rate")).toBe(1);
		expect(
			doc.hiddenCells.find((c) => c.kpiId === "net_income")?.contributors,
		).toBeNull();
	});

	test("a hidden denominator hides the ratio", () => {
		const doc = run({
			cells: {
				gross_collected: evenShares(5, 100),
				refunds: evenShares(5, 10),
				paying_members: evenShares(2, 1),
			},
		});
		expect(reasonOf(doc, "arpa")).toBe("derived_input");
		expect(cellOf(doc, "refund_rate")).toBe(0.1);
	});

	test("an input hidden in another period does not hide the cell", () => {
		const [first, second] = PERIODS as [string, string];
		const doc = suppressKpis({
			spec: SCHOOL_KPIS,
			rows: evaluateKpis({
				spec: SCHOOL_KPIS,
				base: {
					credits_granted: { [first]: 50, [second]: 50 },
					credits_expired: { [first]: 5, [second]: 5 },
				},
				periods: [first, second],
			}),
			contributions: {
				credits_granted: {
					[first]: evenShares(5, 10),
					[second]: evenShares(5, 10),
				},
				credits_expired: {
					[first]: evenShares(5, 1),
					[second]: evenShares(2, 2),
				},
			},
			activePayers: ENOUGH_PAYERS,
		});
		expect(doc.series.breakage_rate).toEqual([0.1, null]);
	});
});

describe("paired fees", () => {
	test("a hidden count hides its fee", () => {
		const doc = run({
			cells: {
				stripe_fees: evenShares(5, 30),
				payments_count: evenShares(4, 1),
			},
		});
		expect(reasonOf(doc, "payments_count")).toBe("few_holders");
		expect(reasonOf(doc, "stripe_fees")).toBe("paired_fee");
	});

	test("a hidden fee hides its count", () => {
		const doc = run({
			cells: {
				dispute_fees: evenShares(4, 1500),
				disputes_opened: evenShares(5, 1),
			},
		});
		expect(reasonOf(doc, "dispute_fees")).toBe("few_holders");
		expect(reasonOf(doc, "disputes_opened")).toBe("paired_fee");
	});

	test("visible on both sides stays visible", () => {
		const doc = run({
			cells: {
				stripe_fees: evenShares(5, 30),
				payments_count: evenShares(5, 1),
			},
		});
		expect(cellOf(doc, "stripe_fees")).toBe(150);
		expect(cellOf(doc, "payments_count")).toBe(5);
	});

	test("credits_expired and new_paying_members follow the plain rules", () => {
		const doc = run({
			cells: {
				credits_expired: evenShares(5, 2),
				new_paying_members: evenShares(4, 1),
			},
		});
		expect(cellOf(doc, "credits_expired")).toBe(10);
		expect(reasonOf(doc, "new_paying_members")).toBe("few_holders");
	});
});

describe("grain", () => {
	/** Three months; each month has too few holders on its own, the quarter has enough. */
	const monthly = (): {
		spec: typeof SCHOOL_KPIS;
		rows: ReturnType<typeof evaluateKpis>;
		contributions: Contributions;
	} => {
		const [jan, feb, mar] = PERIODS as [string, string, string];
		const shares: Record<string, Shares> = {
			[jan]: { "family:a": 100, "family:b": 100, "family:c": 100 },
			[feb]: { "family:c": 100, "family:d": 100, "family:e": 100 },
			[mar]: { "family:a": 100 },
		};
		const members: Record<string, Shares> = {
			[jan]: { "family:a": 1, "family:b": 1, "family:c": 1 },
			[feb]: { "family:c": 1, "family:d": 1, "family:e": 1 },
			[mar]: { "family:a": 1 },
		};
		const balance = Object.fromEntries(
			PERIODS.map((period, i) => [
				period,
				evenShares(5, 10 * (i + 1), "family"),
			]),
		);
		return {
			spec: SCHOOL_KPIS,
			rows: evaluateKpis({
				spec: SCHOOL_KPIS,
				base: {
					gross_collected: { [jan]: 300, [feb]: 300, [mar]: 100 },
					paying_members: { [jan]: 3, [feb]: 3, [mar]: 1 },
					"closing_balance_usd:assets:cash": {
						[jan]: 50,
						[feb]: 100,
						[mar]: 150,
					},
				},
				periods: PERIODS,
			}),
			contributions: {
				gross_collected: shares,
				paying_members: members,
				"closing_balance_usd:assets:cash": balance,
			},
		};
	};

	test("9 active payers switch to quarters, 10 keep months", () => {
		expect(suppressKpis({ ...monthly(), activePayers: 9 }).grain).toBe(
			"quarter",
		);
		const tenPayers = suppressKpis({ ...monthly(), activePayers: 10 });
		expect(tenPayers.grain).toBe("month");
		expect(tenPayers.periods).toEqual(PERIODS);
		expect(tenPayers.activePayers).toBe(10);
	});

	test("months that fail alone pass as a quarter, with the quarter's own values", () => {
		const month = suppressKpis({ ...monthly(), activePayers: 10 });
		expect(month.series.gross_collected).toEqual([null, null, null]);
		const quarter = suppressKpis({ ...monthly(), activePayers: 9 });
		expect(quarter.periods).toEqual(["2026-Q1"]);
		// five holders over the quarter; family:a has 200 of 700
		expect(quarter.series.gross_collected).toEqual([700]);
		// distinct holders over the quarter, not the sum of the months
		expect(quarter.series.paying_members).toEqual([5]);
		// a derived KPI is evaluated from the aggregated base
		expect(quarter.series.arpa).toEqual([140]);
		// a closing balance takes the last month
		expect(quarter.series["closing_balance_usd:assets:cash"]).toEqual([150]);
	});
});

describe("no holder id in the result", () => {
	test("neither as a key nor as a value, and credit accounts are not exported", () => {
		const doc = suppressKpis({
			spec: SCHOOL_KPIS,
			rows: evaluateKpis({
				spec: SCHOOL_KPIS,
				base: {
					credits_granted: { [FIRST]: 20 },
					"closing_balance_credits:credits:avail:family:h1": { [FIRST]: 5 },
					"closing_balance_usd:liabilities:profile:h2": { [FIRST]: 5 },
					"closing_balance_usd:assets:cash": { [FIRST]: 9 },
				},
				periods: [FIRST],
			}),
			contributions: {
				credits_granted: { [FIRST]: evenShares(2, 10, "profile") },
				"closing_balance_usd:assets:cash": {
					[FIRST]: evenShares(1, 9, "family"),
				},
			},
			providerContributions: {
				credits_consumed: { [FIRST]: evenShares(1, 1, "family") },
			},
			activePayers: 3,
		});
		const json = JSON.stringify(doc);
		expect(json).not.toContain("family:");
		expect(json).not.toContain("profile:");
		expect(
			Object.keys(doc.series).some((id) =>
				id.startsWith("closing_balance_credits"),
			),
		).toBe(false);
		expect(doc.hiddenCells.length).toBeGreaterThan(0);
	});
});

describe("contributionsFromEvents", () => {
	let sequence = 0;
	const payment = ({
		key,
		date,
		account,
		amount,
		labels = {},
	}: {
		key: string;
		date: string;
		account: string;
		amount: string;
		labels?: Record<string, string>;
	}): AtmEvent => {
		sequence += 1;
		return {
			v: 1,
			id: `event-${sequence}`,
			school: "school-test",
			source: "test",
			event_type: "payment.succeeded",
			event_time: `${date}T10:00:00Z`,
			ingest_time: `${date}T10:00:00Z`,
			date,
			tz: "UTC",
			key,
			labels,
			idem: `idem-${sequence}`,
			text: "payment",
			postings: [
				{ account, amount: `-${amount}`, commodity: "USD" },
				{ account: "assets:clearing:stripe", amount, commodity: "USD" },
			],
			payload: {},
		};
	};
	const MEMBERSHIP = "income:billing:membership:scholar";
	const BOOKING = "income:billing:booking";
	const periods = periodsFrom("2026-01", 12);

	const eventsOf = (holders: number, account = MEMBERSHIP, labels = {}) =>
		Array.from({ length: holders }, (_, i) =>
			payment({
				key: `family:h${i + 1}`,
				date: "2026-03-10",
				account,
				amount: "50.00",
				labels,
			}),
		);

	test("derives rows, per-holder shares and the active payers", async () => {
		const events = eventsOf(5);
		const result = await contributionsFromEvents({
			events,
			spec: SCHOOL_KPIS,
			periods,
		});
		expect(result.activePayers).toBe(5);
		expect(result.providerContributions).toBeUndefined();
		expect(
			Object.keys(result.contributions.gross_collected?.["2026-03"] ?? {}),
		).toHaveLength(5);
		expect(
			result.contributions.gross_collected?.["2026-03"]?.["family:h1"],
		).toBe(5000);
		expect(
			result.contributions.paying_members?.["2026-03"]?.["family:h1"],
		).toBe(1);
		expect(
			result.rows.find(
				(r) => r.kpiId === "gross_collected" && r.period === "2026-03",
			)?.value,
		).toBe(25000);
	});

	test("counts only payers in the 12 months ending at the last period", async () => {
		const events = [
			...eventsOf(3),
			payment({
				key: "family:old",
				date: "2025-12-31",
				account: MEMBERSHIP,
				amount: "50.00",
			}),
		];
		const result = await contributionsFromEvents({
			events,
			spec: SCHOOL_KPIS,
			periods,
		});
		expect(result.activePayers).toBe(3);
	});

	test("feeds the evaluator: 5 payers show a month, grain follows the payer count", async () => {
		const input = { spec: SCHOOL_KPIS, periods };
		const five = await contributionsFromEvents({
			events: eventsOf(5),
			...input,
		});
		const monthly = suppressKpis({
			spec: SCHOOL_KPIS,
			...five,
			activePayers: 10,
		});
		expect(cellOf(monthly, "gross_collected", "2026-03")).toBe(25000);
		expect(cellOf(monthly, "payments_count", "2026-03")).toBe(5);
		const small = suppressKpis({ spec: SCHOOL_KPIS, ...five });
		expect(small.grain).toBe("quarter");
		expect(cellOf(small, "gross_collected", "2026-Q1")).toBe(25000);
	});

	test("provider shares exist only when a provider label is present", async () => {
		const labelled = [
			...eventsOf(4, BOOKING, { provider: "tutor-a" }),
			...eventsOf(1, BOOKING, { provider: "tutor-b" }).map((event) => ({
				...event,
				key: "family:h9",
			})),
		];
		const result = await contributionsFromEvents({
			events: labelled,
			spec: SCHOOL_KPIS,
			periods,
		});
		const byProvider =
			result.providerContributions?.["revenue_by_kind:booking"]?.["2026-03"];
		expect(byProvider).toEqual({ "tutor-a": 20000, "tutor-b": 5000 });
		// five holders pass the holder rule; two providers do not
		const doc = suppressKpis({
			spec: SCHOOL_KPIS,
			...result,
			activePayers: ENOUGH_PAYERS,
		});
		expect(reasonOf(doc, "revenue_by_kind:booking", "2026-03")).toBe(
			"few_providers",
		);
		expect(JSON.stringify(doc)).not.toContain("tutor-");
	});
});
