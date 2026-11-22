// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { generateSchedule } from "../src/schedule";
import type { Frequency, NoteTerms, ScheduleRow } from "../src/types";

const baseTerms = (overrides: Partial<NoteTerms>): NoteTerms => ({
	currency: "USD",
	exponent: 2,
	principal_minor: "1000000",
	issue_date: "2026-01-01",
	annual_rate: "0.05",
	day_count: "actual/365",
	rounding: "half-up",
	timezone: "America/Denver",
	schedule: { type: "none" },
	...overrides,
});

const amortizedTerms = (
	overrides: Partial<NoteTerms>,
	frequency: Frequency,
	count: number,
	firstDue: string,
) =>
	baseTerms({
		...overrides,
		schedule: { type: "amortized", frequency, count, first_due: firstDue },
	});

const sum = (
	rows: ScheduleRow[],
	field: "payment_minor" | "interest_minor" | "principal_minor",
): bigint => {
	let total = 0n;
	for (const row of rows) {
		total += BigInt(row[field]);
	}
	return total;
};

describe("schedule type none", () => {
	it("has no rows", () => {
		expect(generateSchedule(baseTerms({}))).toEqual([]);
	});
});

describe("amortized: $10,000.00 at 5%, 36 monthly installments (AC-1)", () => {
	const terms = amortizedTerms({}, "monthly", 36, "2026-02-01");
	const rows = generateSchedule(terms);

	it("has 36 rows ending at a zero balance", () => {
		expect(rows).toHaveLength(36);
		expect(rows[35]?.balance_after_minor).toBe("0");
		expect(rows[0]?.due).toBe("2026-02-01");
		expect(rows[35]?.due).toBe("2029-01-01");
	});

	it("first two rows match hand arithmetic", () => {
		// Row 1: Jan 1 to Feb 1 is 31 days. 1,000,000 * 0.05 * 31 / 365 = 1,550,000 / 365 = 4246.575..., so 4247 (half up);
		// the exact remainder is 4246.575 - 4247 = -0.425 and carries forward.
		expect(rows[0]?.interest_minor).toBe("4247");
		// With the level payment 29969 (checked against an independent search in Python): principal 29969 - 4247 = 25722,
		// balance 974,278.
		expect(rows[0]?.payment_minor).toBe("29969");
		expect(rows[0]?.principal_minor).toBe("25722");
		expect(rows[0]?.balance_after_minor).toBe("974278");
		// Row 2: Feb 1 to Mar 1 is 28 days on 974,278: 974,278 * 0.05 * 28 / 365 = 1,363,989.2 / 365 = 3736.956...
		// Accrued = 3736.956 - 0.425 = 3736.531..., so 3737 (half up). Principal 29969 - 3737 = 26232, balance 948,046.
		expect(rows[1]?.interest_minor).toBe("3737");
		expect(rows[1]?.principal_minor).toBe("26232");
		expect(rows[1]?.balance_after_minor).toBe("948046");
	});

	it("level payment on 35 rows, final row absorbs rounding", () => {
		for (const row of rows.slice(0, 35)) {
			expect(row.payment_minor).toBe("29969");
		}
		// Final: remaining principal 29,836 plus the interest due 126 = 29,962. The final period (Dec 1 to Jan 1) is 31 days:
		// 29,836 * 0.05 * 31 / 365 = 126.70 on its own, but the remainder carried from earlier rows (-0.39)
		// leaves 126.31 accrued, so 126 is due (the old per-row rounding gave 127 and 29,835).
		expect(rows[35]?.payment_minor).toBe("29962");
		expect(rows[35]?.interest_minor).toBe("126");
		expect(rows[35]?.principal_minor).toBe("29836");
	});

	it("principal sums to the loan and interest to payments minus principal", () => {
		expect(sum(rows, "principal_minor")).toBe(1_000_000n);
		expect(sum(rows, "interest_minor")).toBe(
			sum(rows, "payment_minor") - 1_000_000n,
		);
		// 35 * 29969 + 29962 = 1,048,915 + 29,962 = 1,078,877
		expect(sum(rows, "payment_minor")).toBe(1_078_877n);
	});

	it("is identical across runs and the balance chain holds", () => {
		expect(JSON.stringify(generateSchedule(terms))).toBe(JSON.stringify(rows));
		let balance = 1_000_000n;
		for (const row of rows) {
			balance -= BigInt(row.principal_minor);
			expect(row.balance_after_minor).toBe(balance.toString());
		}
	});
});

describe("amortized: rate 0 (AC-2)", () => {
	it("uses ceil(principal / count) and the last row takes the remainder", () => {
		// 1000 / 3 = 333.33 -> 334, 334, then 1000 - 668 = 332.
		const rows = generateSchedule(
			amortizedTerms(
				{ exponent: 0, principal_minor: "1000", annual_rate: "0" },
				"weekly",
				3,
				"2026-01-08",
			),
		);
		expect(rows.map((row) => row.payment_minor)).toEqual(["334", "334", "332"]);
		expect(rows.map((row) => row.interest_minor)).toEqual(["0", "0", "0"]);
		expect(rows.map((row) => row.balance_after_minor)).toEqual([
			"666",
			"332",
			"0",
		]);
	});

	it("divides evenly when it can", () => {
		const rows = generateSchedule(
			amortizedTerms(
				{ exponent: 0, principal_minor: "900", annual_rate: "0" },
				"monthly",
				3,
				"2026-02-01",
			),
		);
		expect(rows.map((row) => row.payment_minor)).toEqual(["300", "300", "300"]);
	});
});

describe("amortized: due dates", () => {
	it("a monthly schedule from Jan 31 hits Feb 28, then Mar 31 and Apr 30", () => {
		const rows = generateSchedule(
			amortizedTerms({ issue_date: "2026-01-01" }, "monthly", 4, "2026-01-31"),
		);
		expect(rows.map((row) => row.due)).toEqual([
			"2026-01-31",
			"2026-02-28",
			"2026-03-31",
			"2026-04-30",
		]);
	});

	it("uses Feb 29 in a leap year", () => {
		const rows = generateSchedule(
			amortizedTerms({ issue_date: "2027-12-31" }, "monthly", 3, "2028-01-31"),
		);
		expect(rows.map((row) => row.due)).toEqual([
			"2028-01-31",
			"2028-02-29",
			"2028-03-31",
		]);
	});

	it("weekly adds 7 days and biweekly adds 14", () => {
		const weekly = generateSchedule(
			amortizedTerms({}, "weekly", 3, "2026-01-08"),
		);
		expect(weekly.map((row) => row.due)).toEqual([
			"2026-01-08",
			"2026-01-15",
			"2026-01-22",
		]);
		const biweekly = generateSchedule(
			amortizedTerms({}, "biweekly", 3, "2026-01-15"),
		);
		expect(biweekly.map((row) => row.due)).toEqual([
			"2026-01-15",
			"2026-01-29",
			"2026-02-12",
		]);
	});

	it("a leap-year period accrues 366 days over 365: first period crosses Feb 29", () => {
		// Issue 2028-02-01, one installment due 2028-03-01: 29 days (leap February), not 28.
		// 1,000,000 * 0.05 * 29 / 365 = 1,450,000 / 365 = 3972.6 -> 3973. With 28 days it would be 3835.6 -> 3836.
		const [row] = generateSchedule(
			amortizedTerms({ issue_date: "2028-02-01" }, "monthly", 1, "2028-03-01"),
		);
		expect(row?.interest_minor).toBe("3973");
		// A single installment of a year in a leap year: 366 / 365 of the annual interest.
		// 1,000,000 * 0.05 * 366 / 365 = 50,136.99 -> 50,137.
		const [yearRow] = generateSchedule(
			amortizedTerms({ issue_date: "2028-01-01" }, "monthly", 1, "2029-01-01"),
		);
		expect(yearRow?.interest_minor).toBe("50137");
		expect(yearRow?.payment_minor).toBe("1050137");
	});
});

describe("amortized: single installment and invariants", () => {
	it("pays principal plus interest in one row", () => {
		// Jan 1 to Feb 1: 31 days, 4247 interest (see the 36-installment test).
		const rows = generateSchedule(
			amortizedTerms({}, "monthly", 1, "2026-02-01"),
		);
		expect(rows).toEqual([
			{
				n: 1,
				due: "2026-02-01",
				payment_minor: "1004247",
				interest_minor: "4247",
				principal_minor: "1000000",
				balance_after_minor: "0",
			},
		]);
	});

	it("clears a principal smaller than the installment count early and never overpays", () => {
		// 2 over 5 installments at rate 0: level payment ceil(2 / 5) = 1, so rows pay 1, 1, then nothing is left.
		const rows = generateSchedule(
			amortizedTerms(
				{ exponent: 0, principal_minor: "2", annual_rate: "0" },
				"weekly",
				5,
				"2026-01-08",
			),
		);
		expect(rows.map((row) => row.payment_minor)).toEqual([
			"1",
			"1",
			"0",
			"0",
			"0",
		]);
		expect(rows.map((row) => row.balance_after_minor)).toEqual([
			"1",
			"0",
			"0",
			"0",
			"0",
		]);
	});

	it("holds the invariants across a sweep of loans", () => {
		const principals = ["1", "99", "100000", "25000000"];
		const rates = ["0", "0.0001", "0.0525", "0.18", "0.999999"];
		const frequencies: Frequency[] = ["weekly", "biweekly", "monthly"];
		for (const principal of principals) {
			for (const rate of rates) {
				for (const frequency of frequencies) {
					for (const count of [1, 2, 7, 24]) {
						const rows = generateSchedule(
							amortizedTerms(
								{ principal_minor: principal, annual_rate: rate },
								frequency,
								count,
								"2026-01-31",
							),
						);
						expect(rows).toHaveLength(count);
						expect(rows[count - 1]?.balance_after_minor).toBe("0");
						expect(sum(rows, "principal_minor")).toBe(BigInt(principal));
						expect(sum(rows, "interest_minor")).toBe(
							sum(rows, "payment_minor") - BigInt(principal),
						);
						const level = BigInt(rows[0]?.payment_minor ?? "0");
						for (const row of rows) {
							expect(BigInt(row.payment_minor) <= level).toBe(true);
							expect(BigInt(row.payment_minor) >= 0n).toBe(true);
							expect(BigInt(row.balance_after_minor) >= 0n).toBe(true);
						}
					}
				}
			}
		}
	});
});

describe("amortized: the installment limit", () => {
	it("accepts a weekly century of 5200 installments and ends at zero", () => {
		const rows = generateSchedule(
			amortizedTerms(
				{ principal_minor: "123456789", annual_rate: "0.0725" },
				"weekly",
				5200,
				"2026-01-08",
			),
		);
		expect(rows).toHaveLength(5200);
		expect(rows[5199]?.balance_after_minor).toBe("0");
	});
});

describe("amortized: rejected terms", () => {
	it("rejects count < 1, first_due not after issue_date, and non-positive principal", () => {
		expect(() =>
			generateSchedule(amortizedTerms({}, "monthly", 0, "2026-02-01")),
		).toThrow("count");
		expect(() =>
			generateSchedule(amortizedTerms({}, "monthly", 1.5, "2026-02-01")),
		).toThrow("count");
		expect(() =>
			generateSchedule(amortizedTerms({}, "monthly", 3, "2026-01-01")),
		).toThrow("first_due");
		expect(() =>
			generateSchedule(amortizedTerms({}, "monthly", 3, "2025-12-31")),
		).toThrow("first_due");
		expect(() =>
			generateSchedule(amortizedTerms({}, "weekly", 5201, "2026-01-08")),
		).toThrow("5200");
		expect(() =>
			generateSchedule(
				amortizedTerms({ principal_minor: "0" }, "monthly", 3, "2026-02-01"),
			),
		).toThrow("principal");
		expect(() =>
			generateSchedule(
				amortizedTerms({ principal_minor: "-5" }, "monthly", 3, "2026-02-01"),
			),
		).toThrow("principal");
	});

	it("rejects a bad rate or amount string", () => {
		expect(() =>
			generateSchedule(
				amortizedTerms({ annual_rate: "5%" }, "monthly", 3, "2026-02-01"),
			),
		).toThrow();
		expect(() =>
			generateSchedule(
				amortizedTerms(
					{ principal_minor: "10.00" },
					"monthly",
					3,
					"2026-02-01",
				),
			),
		).toThrow();
	});
});

describe("custom schedule (AC-9)", () => {
	// 12,000.00 at 6%, issued Jan 1 2026; two small payments, then a balloon due Apr 1.
	const terms = baseTerms({
		principal_minor: "1200000",
		annual_rate: "0.06",
		schedule: {
			type: "custom",
			installments: [
				{ due: "2026-02-01", amount_minor: "10000" },
				{ due: "2026-03-01", amount_minor: "10000" },
				{ due: "2026-04-01", amount_minor: "1197693" },
			],
		},
	});

	it("computes interest per period on the running balance", () => {
		const rows = generateSchedule(terms);
		// Row 1: 1,200,000 * 0.06 * 31 / 365 = 2,232,000 / 365 = 6115.07 -> 6115; principal 10000 - 6115 = 3885;
		// balance 1,196,115.
		// Row 2: 1,196,115 * 0.06 * 28 / 365 = 2,009,473.2 / 365 = 5505.4 -> 5505; principal 4495; balance 1,191,620.
		// Row 3: 1,191,620 * 0.06 * 31 / 365 = 2,216,413.2 / 365 = 6072.37 on its own; the remainders carried from rows
		// 1 and 2 (6115.07 - 6115 = +0.07, then 5505.41 - 5505 = +0.41, 0.07 + 0.41 = 0.47) make 6072.84, so 6073 is due and the balloon
		// 1,197,693 clears 1,191,620 + 6073.
		expect(rows.map((row) => row.interest_minor)).toEqual([
			"6115",
			"5505",
			"6073",
		]);
		expect(rows.map((row) => row.principal_minor)).toEqual([
			"3885",
			"4495",
			"1191620",
		]);
		expect(rows.map((row) => row.balance_after_minor)).toEqual([
			"1196115",
			"1191620",
			"0",
		]);
		expect(rows.map((row) => row.payment_minor)).toEqual([
			"10000",
			"10000",
			"1197693",
		]);
	});

	it("expected-vs-paid and days overdue match hand-computed vectors", async () => {
		const { daysOverdue, expectedDueToDate } = await import("../src/accrual");
		const rows = generateSchedule(terms);
		// On Mar 15: rows 1 and 2 are due, expected 20,000.
		expect(expectedDueToDate(rows, "2026-03-15")).toBe(20_000n);
		// Paid 10,000: cumulative 10,000 does not exceed it, cumulative 20,000 does at row 2 (due Mar 1): 14 days.
		expect(daysOverdue(rows, 10_000n, "2026-03-15")).toBe(14);
		// Paid nothing: row 1 (due Feb 1) is already short: 42 days (Feb 1 to Mar 15 = 27 + 15).
		expect(daysOverdue(rows, 0n, "2026-03-15")).toBe(42);
		// Paid in full to date: not overdue.
		expect(daysOverdue(rows, 20_000n, "2026-03-15")).toBe(0);
		// Apr 10: all three due, expected 10,000 + 10,000 + 1,197,693 = 1,217,693; only the instalments were paid:
		// the balloon (due Apr 1) is the first row whose cumulative exceeds 20,000: 9 days.
		expect(expectedDueToDate(rows, "2026-04-10")).toBe(1_217_693n);
		expect(daysOverdue(rows, 20_000n, "2026-04-10")).toBe(9);
		expect(daysOverdue(rows, 1_217_693n, "2026-04-10")).toBe(0);
		// Before anything is due.
		expect(expectedDueToDate(rows, "2026-01-15")).toBe(0n);
		expect(daysOverdue(rows, 0n, "2026-01-15")).toBe(0);
	});

	it("keeps interest unpaid in its own bucket when a payment is below the interest due", () => {
		const rows = generateSchedule(
			baseTerms({
				principal_minor: "1000000",
				annual_rate: "0.0365", // 1,000,000 * 0.0365 / 365 = 100 minor units a day
				issue_date: "2026-01-01",
				schedule: {
					type: "custom",
					installments: [
						{ due: "2026-01-11", amount_minor: "500" },
						{ due: "2026-01-21", amount_minor: "1500" },
					],
				},
			}),
		);
		// Row 1: 10 days * 100 = 1000 interest due; payment 500 all goes to interest, 500 stays unpaid, principal is
		// untouched and the balance does not grow.
		expect(rows[0]?.interest_minor).toBe("500");
		expect(rows[0]?.principal_minor).toBe("0");
		expect(rows[0]?.balance_after_minor).toBe("1000000");
		// Row 2: 10 more days add 1000 (on principal only, never on the unpaid 500): 500 + 1000 = 1500 due, all paid as
		// interest.
		expect(rows[1]?.interest_minor).toBe("1500");
		expect(rows[1]?.principal_minor).toBe("0");
		expect(rows[1]?.balance_after_minor).toBe("1000000");
	});

	it("leaves a payment above principal plus interest unapplied but keeps it as given", () => {
		const [row] = generateSchedule(
			baseTerms({
				principal_minor: "1000",
				annual_rate: "0",
				schedule: {
					type: "custom",
					installments: [{ due: "2026-02-01", amount_minor: "5000" }],
				},
			}),
		);
		expect(row?.payment_minor).toBe("5000");
		expect(row?.interest_minor).toBe("0");
		expect(row?.principal_minor).toBe("1000");
		expect(row?.balance_after_minor).toBe("0");
	});

	it("rejects dates that are not strictly increasing and after issue, and negative amounts", () => {
		const custom = (installments: { due: string; amount_minor: string }[]) =>
			baseTerms({ schedule: { type: "custom", installments } });
		expect(() =>
			generateSchedule(custom([{ due: "2026-01-01", amount_minor: "1" }])),
		).toThrow();
		expect(() =>
			generateSchedule(
				custom([
					{ due: "2026-03-01", amount_minor: "1" },
					{ due: "2026-03-01", amount_minor: "1" },
				]),
			),
		).toThrow();
		expect(() =>
			generateSchedule(custom([{ due: "2026-02-01", amount_minor: "-1" }])),
		).toThrow();
		expect(() =>
			generateSchedule(custom([{ due: "2026-02-30", amount_minor: "1" }])),
		).toThrow();
	});
});
