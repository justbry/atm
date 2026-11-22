// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import {
	accrueDays,
	applyPayment,
	type CountedPayment,
	replayBalance,
} from "../src/accrual";
import type { NoteTerms } from "../src/types";

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

const payment = (
	id: string,
	valueDate: string,
	amount: bigint,
	seq: number,
): CountedPayment => ({
	id,
	value_date: valueDate,
	amount_minor: amount,
	seq,
});

describe("interest accrual", () => {
	// 100,000 at 3.65% is exactly 100,000 * 0.0365 / 365 = 10 minor units a day.
	const terms = baseTerms({ principal_minor: "100000", annual_rate: "0.0365" });

	it("accrues simple daily interest with no payments", () => {
		// 10 days * 10 = 100.
		expect(replayBalance(terms, [], "2026-01-11")).toEqual({
			principal_minor: "100000",
			interest_minor: "100",
			payoff_minor: "100100",
			paid_minor: "0",
			overpaid_minor: "0",
		});
		expect(replayBalance(terms, [], "2026-01-01").interest_minor).toBe("0");
	});

	it("applies a payment to interest first, then principal, and interest never compounds", () => {
		// Day 10: interest due 100, payment 1000 -> 100 interest + 900 principal; principal 99,100.
		// Next 10 days on 99,100: 99,100 * 0.0365 * 10 / 365 = 99.1 -> 99.
		expect(
			replayBalance(
				terms,
				[payment("a", "2026-01-11", 1000n, 1)],
				"2026-01-21",
			),
		).toEqual({
			principal_minor: "99100",
			interest_minor: "99",
			payoff_minor: "99199",
			paid_minor: "1000",
			overpaid_minor: "0",
		});
	});

	it("a payment below the interest due leaves the rest of the interest unpaid, and principal untouched", () => {
		// Day 10: interest 100, pay 50 -> 50 applied to interest, 50 stays due. 10 more days add 100 on the full principal
		// (not on the unpaid interest): 50 + 100 = 150.
		expect(
			replayBalance(terms, [payment("a", "2026-01-11", 50n, 1)], "2026-01-21"),
		).toEqual({
			principal_minor: "100000",
			interest_minor: "150",
			payoff_minor: "100150",
			paid_minor: "50",
			overpaid_minor: "0",
		});
	});

	it("leap years: a period across Feb 29 accrues 366 days, a plain year 365, both over 365", () => {
		const leap = baseTerms({
			principal_minor: "1000000",
			annual_rate: "0.0525",
			issue_date: "2027-12-31",
		});
		// 2027-12-31 to 2028-12-31 is 366 days: 1,000,000 * 0.0525 * 366 / 365 = 52,643.84 -> 52,644.
		expect(replayBalance(leap, [], "2028-12-31").interest_minor).toBe("52644");
		const plain = baseTerms({
			principal_minor: "1000000",
			annual_rate: "0.0525",
			issue_date: "2026-12-31",
		});
		// 365 days: exactly 52,500.
		expect(replayBalance(plain, [], "2027-12-31").interest_minor).toBe("52500");
	});

	it("carries rounding remainders exactly between payments", () => {
		// Hand check of the AC-7 vector below: payments of 30,000 on Feb 1 and 50,000 on Mar 1 on 1,000,000 at 5%.
		// Feb 1: 31 days -> 4246.575; interest due rounds to 4247 and 4247 is applied (0.425 over-collected, carried as -0.425).
		//   principal 1,000,000 - 25,753 = 974,247.
		// Mar 1: 28 days on 974,247 -> 3736.838; less the carried 0.425 = 3736.413 -> 3736 due; principal 50,000 - 3736 = 46,264
		//   -> 927,983. Paid 80,000 in total.
		const balance = replayBalance(
			baseTerms({}),
			[
				payment("a", "2026-02-01", 30_000n, 1),
				payment("b", "2026-03-01", 50_000n, 2),
			],
			"2026-03-01",
		);
		expect(balance.principal_minor).toBe("927983");
		expect(balance.paid_minor).toBe("80000");
		// Mar 1 to Mar 31 is 30 days: 927,983 * 0.05 * 30 / 365 = 3813.9, plus 0.413 carried = 3814.3 -> 3814.
		const later = replayBalance(
			baseTerms({}),
			[
				payment("a", "2026-02-01", 30_000n, 1),
				payment("b", "2026-03-01", 50_000n, 2),
			],
			"2026-03-31",
		);
		expect(later.interest_minor).toBe("3814");
		expect(later.payoff_minor).toBe("931797");
	});
});

describe("overpayment (AC-8)", () => {
	it("reports the excess as overpaid and never goes negative", () => {
		const terms = baseTerms({
			exponent: 0,
			principal_minor: "1000",
			annual_rate: "0",
		});
		expect(
			replayBalance(
				terms,
				[payment("a", "2026-02-01", 1500n, 1)],
				"2026-03-01",
			),
		).toEqual({
			principal_minor: "0",
			interest_minor: "0",
			payoff_minor: "0",
			paid_minor: "1000",
			overpaid_minor: "500",
		});
	});

	it("overpaying past the interest and principal with a rate", () => {
		// 100,000 at 8%: Feb 1 pays 30,000 (31 days: 679.45 -> 679 interest, 29,321 principal -> 70,679). Mar 1 (28 days:
		// 70,679 * 0.08 * 28 / 365 = 433.76, plus the 0.452 carried = 434.21 -> 434): pay 90,000 = 434 + 70,679 + 18,887 over.
		const terms = baseTerms({ principal_minor: "100000", annual_rate: "0.08" });
		const balance = replayBalance(
			terms,
			[
				payment("a", "2026-02-01", 30_000n, 1),
				payment("b", "2026-03-01", 90_000n, 2),
			],
			"2026-03-10",
		);
		expect(balance).toEqual({
			principal_minor: "0",
			interest_minor: "0",
			payoff_minor: "0",
			paid_minor: "101113",
			overpaid_minor: "18887",
		});
	});
});

describe("ordering (AC-7)", () => {
	const terms = baseTerms({});

	it("a payment dated before an earlier-entered one replays to the same totals as date order", () => {
		// Entered first (seq 1) but dated later (Mar 1); entered second (seq 2) but dated Feb 1.
		const enteredOrder = [
			payment("a", "2026-03-01", 50_000n, 1),
			payment("b", "2026-02-01", 30_000n, 2),
		];
		// The same events renumbered in date order.
		const dateOrder = [
			payment("b", "2026-02-01", 30_000n, 1),
			payment("a", "2026-03-01", 50_000n, 2),
		];
		const expected = {
			principal_minor: "927983",
			interest_minor: "0",
			payoff_minor: "927983",
			paid_minor: "80000",
			overpaid_minor: "0",
		};
		expect(replayBalance(terms, enteredOrder, "2026-03-01")).toEqual(expected);
		expect(replayBalance(terms, dateOrder, "2026-03-01")).toEqual(expected);
		expect(
			replayBalance(terms, [...enteredOrder].reverse(), "2026-03-01"),
		).toEqual(expected);
	});

	it("same value date: seq decides, and does not change the input array", () => {
		const input = [
			payment("late", "2026-02-01", 100n, 5),
			payment("early", "2026-02-01", 100n, 2),
		];
		const snapshot = JSON.stringify(input, (_key, value: unknown) =>
			typeof value === "bigint" ? `${value}n` : value,
		);
		replayBalance(terms, input, "2026-03-01");
		expect(
			JSON.stringify(input, (_key, value: unknown) =>
				typeof value === "bigint" ? `${value}n` : value,
			),
		).toBe(snapshot);
	});
});

describe("dates outside the note", () => {
	const terms = baseTerms({});

	it("throws for a payment before issue_date", () => {
		expect(() =>
			replayBalance(terms, [payment("a", "2025-12-31", 100n, 1)], "2026-03-01"),
		).toThrow("before issue_date");
	});

	it("ignores a payment after as_of", () => {
		const withLater = replayBalance(
			terms,
			[payment("a", "2026-06-01", 100_000n, 1)],
			"2026-03-01",
		);
		expect(withLater).toEqual(replayBalance(terms, [], "2026-03-01"));
	});

	it("applies a payment dated exactly on as_of and on issue_date", () => {
		const balance = replayBalance(
			terms,
			[payment("a", "2026-01-01", 1000n, 1)],
			"2026-01-01",
		);
		expect(balance.principal_minor).toBe("999000");
		expect(balance.paid_minor).toBe("1000");
	});

	it("throws when as_of is before issue_date", () => {
		expect(() => replayBalance(terms, [], "2025-12-31")).toThrow("as_of");
	});
});

describe("negative amounts", () => {
	it("are refused: a reversal drops the payment it undoes instead (R-9a)", () => {
		const terms = baseTerms({
			exponent: 0,
			principal_minor: "1000",
			annual_rate: "0",
		});
		expect(() =>
			replayBalance(
				terms,
				[payment("r", "2026-02-05", -400n, 1)],
				"2026-03-01",
			),
		).toThrow("negative amount");
	});
});

describe("the shared payment step (used by schedule and replay)", () => {
	// 100,000 at 3.65% is 10 minor units a day; rate 365 / 10,000 as an exact fraction.
	const rate = { num: 365n, den: 10_000n };

	it("covers interest first, then principal, and reports the unapplied rest", () => {
		const accrued = accrueDays(
			{ principal: 100_000n, accruedNumerator: 0n },
			rate,
			10,
		);
		const { state, split } = applyPayment(accrued, rate, 1_000n);
		expect(split).toEqual({
			interest: 100n,
			principal: 900n,
			unapplied: 0n,
			dueInterest: 100n,
		});
		expect(state.principal).toBe(99_100n);
		expect(state.accruedNumerator).toBe(0n);
		const payoff = applyPayment(state, rate, 500_000n);
		expect(payoff.split.principal).toBe(99_100n);
		expect(payoff.split.unapplied).toBe(500_000n - 99_100n);
		expect(payoff.state.principal).toBe(0n);
	});

	it("keeps interest unpaid in its own bucket and never adds it to principal", () => {
		const accrued = accrueDays(
			{ principal: 100_000n, accruedNumerator: 0n },
			rate,
			10,
		);
		const { state, split } = applyPayment(accrued, rate, 40n);
		expect(split.interest).toBe(40n);
		expect(split.principal).toBe(0n);
		expect(state.principal).toBe(100_000n);
		// 60 of the 100 is still accrued, exactly: 60 * (10,000 * 365).
		expect(state.accruedNumerator).toBe(60n * 10_000n * 365n);
	});

	it("carries an over-rounded remainder forward as a slightly negative accrual", () => {
		// 7,300 * 0.003 * 10 / 365 = 0.6 exactly: 1 is due (half up), and paying it leaves -0.4 accrued.
		const slow = { num: 3n, den: 1_000n };
		const accrued = accrueDays(
			{ principal: 7_300n, accruedNumerator: 0n },
			slow,
			10,
		);
		const { state, split } = applyPayment(accrued, slow, 1n);
		expect(split.dueInterest).toBe(1n);
		expect(split.interest).toBe(1n);
		// -0.4 * (1,000 * 365)
		expect(state.accruedNumerator).toBe(-146_000n);
	});
});
