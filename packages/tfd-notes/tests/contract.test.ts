// SPDX-License-Identifier: Apache-2.0
/**
 * The rounding contract (spec R-4, R-5, R-8, R-9): a schedule is exactly what `replayBalance` reports when the borrower
 * pays every row's payment on its due date. A seeded property test over amortized notes, plus the two cases a reviewer
 * found that the first version got wrong (a 1-minor-unit residue, and custom schedules that capitalised interest).
 */
import { describe, expect, it } from "bun:test";
import { type CountedPayment, replayBalance } from "../src/accrual";
import { addDays } from "../src/date";
import { generateSchedule } from "../src/schedule";
import type { Frequency, NoteTerms, ScheduleRow } from "../src/types";

const NOTE_COUNT = 400;
const SEED = 20_260_731;
const UINT32_RANGE = 4_294_967_296;
const MAX_PRINCIPAL = 1_000_000_000;
const MAX_COUNT = 130;
const MAX_RATE_FRACTION = 0.2;

/** A small seeded generator (mulberry32): the same sequence on every runtime, no `Math.random`. */
const seededGenerator = (seed: number): (() => number) => {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d_2b_79_f5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), state | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_RANGE;
	};
};

const pad = (value: number, width: number): string =>
	String(value).padStart(width, "0");

const isLeapYear = (year: number): boolean =>
	(year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const monthLength = (year: number, month: number): number => {
	if (month === 2) {
		return isLeapYear(year) ? 29 : 28;
	}
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

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

/** Each row's payment on its due date, as `replayBalance` takes them. */
const paymentsFor = (rows: ScheduleRow[]): CountedPayment[] =>
	rows.map((row) => ({
		id: `row-${row.n}`,
		value_date: row.due,
		amount_minor: BigInt(row.payment_minor),
		seq: row.n,
	}));

const totalOf = (payments: CountedPayment[]): bigint => {
	let total = 0n;
	for (const payment of payments) {
		total += payment.amount_minor;
	}
	return total;
};

/** A rate from 0 to 0.2 with `places` decimal places (0 places means rate "0"). */
const randomRate = (next: () => number): string => {
	const places = Math.floor(next() * 7);
	if (places === 0 || next() < 0.1) {
		return "0";
	}
	const scale = 10 ** places;
	const digits = Math.floor(next() * (MAX_RATE_FRACTION * scale + 1));
	return `0.${pad(digits, places)}`;
};

interface RandomNote {
	terms: NoteTerms;
	count: number;
}

const randomNote = (next: () => number): RandomNote => {
	const pick = (below: number): number => Math.floor(next() * below);
	const year = 2024 + pick(9);
	const month = 1 + pick(12);
	// Days 29 to 31 are over-represented so month-end anchoring and leap years are exercised.
	const day = Math.min(
		monthLength(year, month),
		next() < 0.4 ? 29 + pick(3) : 1 + pick(31),
	);
	const issueDate = `${year}-${pad(month, 2)}-${pad(day, 2)}`;
	const frequencies: Frequency[] = ["weekly", "biweekly", "monthly"];
	const frequency = frequencies[pick(3)] ?? "monthly";
	const count = 1 + pick(MAX_COUNT);
	// Principals from 1 up to 10^9 minor units, log-uniform so both tiny and large notes appear.
	const principal = Math.min(MAX_PRINCIPAL, 1 + Math.floor(10 ** (next() * 9)));
	return {
		count,
		terms: baseTerms({
			principal_minor: String(principal),
			issue_date: issueDate,
			annual_rate: randomRate(next),
			schedule: {
				type: "amortized",
				frequency,
				count,
				first_due: addDays(issueDate, 1 + pick(40)),
			},
		}),
	};
};

describe("one rounding contract: schedule == replay of the rows paid on their due dates", () => {
	it("holds for 400 seeded random amortized notes", () => {
		const next = seededGenerator(SEED);
		for (let index = 0; index < NOTE_COUNT; index += 1) {
			const { terms, count } = randomNote(next);
			const rows = generateSchedule(terms);
			const payments = paymentsFor(rows);
			expect(rows).toHaveLength(count);
			for (const [position, row] of rows.entries()) {
				const balance = replayBalance(
					terms,
					payments.slice(0, position + 1),
					row.due,
				);
				if (balance.principal_minor !== row.balance_after_minor) {
					throw new Error(
						`Replay principal ${balance.principal_minor} != row balance ${row.balance_after_minor} at row ${row.n} of ${JSON.stringify(terms)}`,
					);
				}
				// Interest can stay unpaid between rows (a long first period accrues more than the level payment covers);
				// it carries in its own bucket, so only principal and overpaid are compared at every row.
				expect(balance.overpaid_minor).toBe("0");
			}
			const lastDue = rows[count - 1]?.due ?? "";
			const finalBalance = replayBalance(terms, payments, lastDue);
			expect(finalBalance.payoff_minor).toBe("0");
			expect(finalBalance.overpaid_minor).toBe("0");
			expect(BigInt(finalBalance.paid_minor)).toBe(totalOf(payments));
		}
	});

	it("keeps the schedule invariants for the same notes", () => {
		const next = seededGenerator(SEED);
		for (let index = 0; index < NOTE_COUNT; index += 1) {
			const { terms } = randomNote(next);
			const rows = generateSchedule(terms);
			const principal = BigInt(terms.principal_minor);
			let principalTotal = 0n;
			let interestTotal = 0n;
			let paymentTotal = 0n;
			for (const row of rows) {
				principalTotal += BigInt(row.principal_minor);
				interestTotal += BigInt(row.interest_minor);
				paymentTotal += BigInt(row.payment_minor);
				expect(BigInt(row.balance_after_minor) >= 0n).toBe(true);
			}
			expect(rows.at(-1)?.balance_after_minor).toBe("0");
			expect(principalTotal).toBe(principal);
			expect(interestTotal).toBe(paymentTotal - principal);
		}
	});

	it("the reviewer's repro: 40,595 at 7%, 7 monthly installments, leaves no residue", () => {
		const terms = baseTerms({
			principal_minor: "40595",
			annual_rate: "0.07",
			issue_date: "2026-01-31",
			schedule: {
				type: "amortized",
				frequency: "monthly",
				count: 7,
				first_due: "2026-02-28",
			},
		});
		const rows = generateSchedule(terms);
		const payments = paymentsFor(rows);
		const balance = replayBalance(terms, payments, rows[6]?.due ?? "");
		expect(balance).toEqual({
			principal_minor: "0",
			interest_minor: "0",
			payoff_minor: "0",
			paid_minor: totalOf(payments).toString(),
			overpaid_minor: "0",
		});
	});

	it("a custom schedule that defers all payment keeps unpaid interest out of principal", () => {
		const terms = baseTerms({
			principal_minor: "100000",
			annual_rate: "0.1",
			issue_date: "2027-01-01",
			schedule: {
				type: "custom",
				installments: [
					{ due: "2028-01-01", amount_minor: "0" },
					{ due: "2028-12-31", amount_minor: "120000" },
				],
			},
		});
		const rows = generateSchedule(terms);
		// Year 1 accrues 10,000 and nothing is paid: the balance stays 100,000 (interest is not capitalised). The next
		// 365 days (Jan 1 to Dec 31 2028) accrue another 10,000 on the same principal, so 20,000 is due with the balloon.
		expect(rows.map((row) => row.interest_minor)).toEqual(["0", "20000"]);
		expect(rows.map((row) => row.principal_minor)).toEqual(["0", "100000"]);
		expect(rows.map((row) => row.balance_after_minor)).toEqual(["100000", "0"]);
		const payments = paymentsFor(rows);
		for (const [position, row] of rows.entries()) {
			const balance = replayBalance(
				terms,
				payments.slice(0, position + 1),
				row.due,
			);
			expect(balance.principal_minor).toBe(row.balance_after_minor);
			expect(BigInt(balance.principal_minor) >= 0n).toBe(true);
		}
		expect(replayBalance(terms, payments, "2028-12-31").payoff_minor).toBe("0");
	});
});
