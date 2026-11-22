// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { statement, statusLabel } from "../src/statement";
import type { PaymentStatus } from "../src/types";

type Fields = Record<string, unknown>;

/*
 * Shared loan for most tests: 100,000 minor units at 3.65% simple interest, which is exactly 10 minor units a day on
 * the full principal (100,000 * 0.0365 / 365). Issued 2026-01-01, no schedule. Day 10 is 2026-01-11, day 20 is
 * 2026-01-21, day 30 is 2026-01-31.
 *
 * A 30,000 payment on day 10: interest due 10 days * 10 = 100, so 100 to interest and 29,900 to principal, which
 * leaves principal 70,100. Ten more days on 70,100 accrue 70,100 * 0.0365 * 10 / 365 = 70.1, rounded to 70.
 * Payoff on day 20 with that payment = 70,100 + 70 = 70,170; without it = 100,000 + 200 = 100,200.
 */
const TERMS: Fields = {
	currency: "USD",
	exponent: 2,
	principal_minor: "100000",
	issue_date: "2026-01-01",
	annual_rate: "0.0365",
	day_count: "actual/365",
	rounding: "half-up",
	timezone: "America/Denver",
	schedule: { type: "none" },
};

const DAY_10 = "2026-01-11";
const DAY_20 = "2026-01-21";

const make = (
	seq: number,
	type: string,
	enteredBy: string,
	enteredAt: string,
	fields: Fields,
): Fields => ({
	schema: "tfd.note-event.v1",
	id: `evt-${seq}`,
	note_id: "note-1",
	seq,
	entered_at: enteredAt,
	entered_by: enteredBy,
	type,
	...fields,
});

const created = (terms: Fields = TERMS): Fields =>
	make(1, "note.created", "lender", "2026-01-01T09:00:00Z", { terms });

const payment = (
	seq: number,
	enteredBy: string,
	amount: string,
	valueDate: string,
	enteredAt = "2026-01-12T10:00:00Z",
): Fields =>
	make(seq, "payment.recorded", enteredBy, enteredAt, {
		kind: "payment",
		amount_minor: amount,
		value_date: valueDate,
	});

const reversal = (
	seq: number,
	enteredBy: string,
	amount: string,
	valueDate: string,
	reverses: string,
): Fields =>
	make(seq, "payment.recorded", enteredBy, "2026-01-16T10:00:00Z", {
		kind: "reversal",
		amount_minor: amount,
		value_date: valueDate,
		reverses,
	});

const confirmation = (seq: number, enteredBy: string, target: string): Fields =>
	make(seq, "payment.confirmed", enteredBy, "2026-01-17T10:00:00Z", { target });

const dispute = (
	seq: number,
	enteredBy: string,
	target: string,
	counter: string,
	reason: string,
): Fields =>
	make(seq, "payment.disputed", enteredBy, "2026-01-13T10:00:00Z", {
		target,
		counter_amount_minor: counter,
		reason,
	});

const resolution = (
	seq: number,
	enteredBy: string,
	target: string,
	agreed: string,
): Fields =>
	make(seq, "payment.resolved", enteredBy, "2026-01-18T10:00:00Z", {
		target,
		agreed_amount_minor: agreed,
	});

describe("statement ordering (AC-3)", () => {
	const stream = [
		created(),
		payment(2, "borrower", "30000", DAY_10),
		payment(3, "lender", "5000", "2026-01-16"),
		confirmation(4, "lender", "evt-2"),
		dispute(5, "borrower", "evt-3", "4000", "I paid 40"),
	];

	it("gives the identical statement for any input order of the same events", () => {
		const expected = statement(stream, DAY_20);
		const shuffled = [stream[3], stream[0], stream[4], stream[2], stream[1]];
		expect(statement(shuffled, DAY_20)).toEqual(expected);
		expect(JSON.stringify(statement([...stream].reverse(), DAY_20))).toBe(
			JSON.stringify(expected),
		);
	});

	it("rejects a gap in seq", () => {
		const gapped = [created(), payment(3, "borrower", "30000", DAY_10)];
		expect(() => statement(gapped, DAY_20)).toThrow("gap");
	});

	it("rejects a repeated seq", () => {
		const repeated = [
			created(),
			payment(2, "borrower", "30000", DAY_10),
			payment(2, "lender", "100", DAY_10),
		];
		expect(() => statement(repeated, DAY_20)).toThrow("repeated");
	});
});

describe("two views (AC-4, AC-5)", () => {
	it("a borrower-recorded payment moves only the borrower view until the lender confirms", () => {
		const claimed = [created(), payment(2, "borrower", "30000", DAY_10)];
		const before = statement(claimed, DAY_20);
		// Lender never saw it: 100,000 + 20 days * 10 = 100,200. Borrower: 70,100 principal + 70 interest.
		expect(before.lender).toEqual({
			principal_minor: "100000",
			interest_minor: "200",
			payoff_minor: "100200",
			paid_minor: "0",
			overpaid_minor: "0",
		});
		expect(before.borrower).toEqual({
			principal_minor: "70100",
			interest_minor: "70",
			payoff_minor: "70170",
			paid_minor: "30000",
			overpaid_minor: "0",
		});
		// 100,200 - 70,170 = 30,030.
		expect(before.payoff_gap_minor).toBe("30030");
		// Entered 2026-01-12, as of 2026-01-21: 9 days.
		expect(before.difference).toEqual([
			{
				event_id: "evt-2",
				value_date: DAY_10,
				status: "claimed-by-borrower",
				lender_counts_minor: "0",
				borrower_counts_minor: "30000",
				difference_minor: "-30000",
				unanswered_days: 9,
			},
		]);

		const after = statement(
			[...claimed, confirmation(3, "lender", "evt-2")],
			DAY_20,
		);
		expect(after.lender).toEqual(before.borrower);
		expect(after.borrower).toEqual(before.borrower);
		expect(after.difference).toEqual([]);
		expect(after.payoff_gap_minor).toBe("0");
	});

	it("a lender-recorded payment moves both views at once", () => {
		const result = statement(
			[created(), payment(2, "lender", "30000", DAY_10)],
			DAY_20,
		);
		expect(result.lender.payoff_minor).toBe("70170");
		expect(result.borrower.payoff_minor).toBe("70170");
		expect(result.lender.paid_minor).toBe("30000");
		expect(result.borrower.paid_minor).toBe("30000");
		expect(result.difference).toEqual([]);
	});

	it("a borrower dispute with a counter-amount moves only the borrower view and shows its reason", () => {
		const result = statement(
			[
				created(),
				payment(2, "lender", "30000", DAY_10),
				dispute(3, "borrower", "evt-2", "20000", "I handed over 200"),
			],
			DAY_20,
		);
		// Lender keeps 30,000: payoff 70,170. Borrower counts 20,000: interest 100, principal 100,000 - 19,900 = 80,100;
		// ten more days on 80,100 = 80.1 -> 80; payoff 80,180.
		expect(result.lender.payoff_minor).toBe("70170");
		expect(result.lender.paid_minor).toBe("30000");
		expect(result.borrower.payoff_minor).toBe("80180");
		expect(result.borrower.paid_minor).toBe("20000");
		// 70,170 - 80,180 = -10,010.
		expect(result.payoff_gap_minor).toBe("-10010");
		expect(result.difference).toEqual([
			{
				event_id: "evt-2",
				value_date: DAY_10,
				status: "disputed",
				lender_counts_minor: "30000",
				borrower_counts_minor: "20000",
				difference_minor: "10000",
				unanswered_days: null,
				reason: "I handed over 200",
			},
		]);
	});

	it("the last of confirm, dispute and resolve decides", () => {
		const events = [
			created(),
			payment(2, "lender", "30000", DAY_10),
			dispute(3, "borrower", "evt-2", "20000", "short"),
			confirmation(4, "borrower", "evt-2"),
		];
		const result = statement(events, DAY_20);
		expect(result.borrower.paid_minor).toBe("30000");
		expect(result.difference).toEqual([]);
	});
});

describe("back-dated payments (AC-7)", () => {
	it("replays to the same totals as the same events in date order", () => {
		// Both lender-recorded. 30,000 on day 10, 10,000 on day 20, as of day 30 (2026-01-31).
		// Day 10: interest 100, principal 70,100. Day 20: 10 days on 70,100 = 70.1; pay 70 interest + 9,930 principal,
		// principal 60,170, remainder 0.1 carried. Day 30: 10 days on 60,170 = 60.17 + 0.1 = 60.27 -> 60.
		// Payoff = 60,170 + 60 = 60,230; paid 40,000.
		const dateOrder = [
			created(),
			payment(2, "lender", "30000", DAY_10),
			payment(3, "lender", "10000", DAY_20),
		];
		const backDated = [
			created(),
			payment(2, "lender", "10000", DAY_20),
			payment(3, "lender", "30000", DAY_10),
		];
		const inOrder = statement(dateOrder, "2026-01-31");
		const late = statement(backDated, "2026-01-31");
		expect(late.lender).toEqual(inOrder.lender);
		expect(late.borrower).toEqual(inOrder.borrower);
		expect(late.lender).toEqual({
			principal_minor: "60170",
			interest_minor: "60",
			payoff_minor: "60230",
			paid_minor: "40000",
			overpaid_minor: "0",
		});
	});
});

describe("overpayment (AC-8)", () => {
	it("reports the excess as overpaid and never lets the balance go negative", () => {
		// 150,000 on day 10: interest 100 + principal 100,000 = 100,100 applied; 49,900 overpaid. Nothing accrues after.
		const result = statement(
			[created(), payment(2, "lender", "150000", DAY_10)],
			DAY_20,
		);
		for (const view of [result.lender, result.borrower]) {
			expect(view).toEqual({
				principal_minor: "0",
				interest_minor: "0",
				payoff_minor: "0",
				paid_minor: "100100",
				overpaid_minor: "49900",
			});
		}
	});
});

describe("custom schedule with a balloon (AC-9)", () => {
	// 1,200,000 at 6%: installments 10,000 on 02-01, 10,000 on 03-01 and a balloon of 1,197,692 on 04-01.
	const balloonTerms: Fields = {
		...TERMS,
		principal_minor: "1200000",
		annual_rate: "0.06",
		schedule: {
			type: "custom",
			installments: [
				{ due: "2026-02-01", amount_minor: "10000" },
				{ due: "2026-03-01", amount_minor: "10000" },
				{ due: "2026-04-01", amount_minor: "1197692" },
			],
		},
	};
	const lenderPaidFirst = (): Fields =>
		payment(2, "lender", "10000", "2026-02-01", "2026-02-01T10:00:00Z");

	it("matches hand-computed due, overdue and days overdue", () => {
		const events = [created(balloonTerms), lenderPaidFirst()];
		// As of 2026-02-15 only installment 1 (10,000) is due and 10,000 is paid.
		const early = statement(events, "2026-02-15").expected;
		expect(early.due_to_date_minor).toBe("10000");
		expect(early.lender_overdue_minor).toBe("0");
		expect(early.lender_days_overdue).toBe(0);

		// As of 2026-03-15 due is 20,000, paid 10,000: overdue 10,000. Cumulative 20,000 first exceeds paid at the
		// 03-01 row, so 14 days overdue (03-01 to 03-15).
		const mid = statement(events, "2026-03-15").expected;
		expect(mid.due_to_date_minor).toBe("20000");
		expect(mid.lender_paid_minor).toBe("10000");
		expect(mid.lender_overdue_minor).toBe("10000");
		expect(mid.lender_days_overdue).toBe(14);

		// As of 2026-04-10 the balloon is due too: 10,000 + 10,000 + 1,197,692 = 1,217,692. Overdue 1,207,692.
		// 03-01 to 04-10: 31 days in March + 9 = 40.
		const late = statement(events, "2026-04-10").expected;
		expect(late.due_to_date_minor).toBe("1217692");
		expect(late.lender_overdue_minor).toBe("1207692");
		expect(late.lender_days_overdue).toBe(40);
	});

	it("counts overdue separately in each view", () => {
		const events = [
			created(balloonTerms),
			lenderPaidFirst(),
			payment(3, "borrower", "10000", "2026-03-01", "2026-03-02T10:00:00Z"),
		];
		const { expected } = statement(events, "2026-04-10");
		// Lender counts 10,000: overdue 1,207,692, first short row is 03-01 (40 days).
		// Borrower counts 20,000: overdue 1,197,692; cumulative 20,000 does not exceed 20,000, the balloon row does,
		// so days run from 04-01: 9.
		expect(expected.lender_paid_minor).toBe("10000");
		expect(expected.borrower_paid_minor).toBe("20000");
		expect(expected.lender_overdue_minor).toBe("1207692");
		expect(expected.borrower_overdue_minor).toBe("1197692");
		expect(expected.lender_days_overdue).toBe(40);
		expect(expected.borrower_days_overdue).toBe(9);
	});

	it("gives zeros for a note with no schedule", () => {
		const { expected } = statement(
			[created(), payment(2, "borrower", "30000", DAY_10)],
			DAY_20,
		);
		expect(expected).toEqual({
			due_to_date_minor: "0",
			lender_paid_minor: "0",
			borrower_paid_minor: "30000",
			lender_overdue_minor: "0",
			borrower_overdue_minor: "0",
			lender_days_overdue: 0,
			borrower_days_overdue: 0,
		});
	});
});

describe("reversals (R-9a)", () => {
	// Borrower pays 30,000 on day 10, the lender confirms, then the lender reverses it on 2026-01-15 (a bounced check).
	const bounced = [
		created(),
		payment(2, "borrower", "30000", DAY_10),
		confirmation(3, "lender", "evt-2"),
		reversal(4, "lender", "30000", "2026-01-15", "evt-2"),
	];
	// No payment at all: 100,000 plus 20 days at 10 a day.
	const neverPaid = {
		principal_minor: "100000",
		interest_minor: "200",
		payoff_minor: "100200",
		paid_minor: "0",
		overpaid_minor: "0",
	};

	it("a lender reversal helps the lender only until the borrower confirms", () => {
		const before = statement(bounced, DAY_20);
		// The lender view drops the payment as if it never happened: payoff 100,000 + 200 = 100,200.
		expect(before.lender).toEqual(neverPaid);
		// The borrower view still counts the payment: 30,000 on day 10, then 10 days on 70,100 = 70.1 -> 70.
		expect(before.borrower.paid_minor).toBe("30000");
		expect(before.borrower.payoff_minor).toBe("70170");
		expect(before.difference).toEqual([
			{
				event_id: "evt-4",
				value_date: "2026-01-15",
				status: "claimed-by-lender",
				lender_counts_minor: "-30000",
				borrower_counts_minor: "0",
				difference_minor: "-30000",
				unanswered_days: 5,
			},
		]);

		const after = statement(
			[...bounced, confirmation(5, "borrower", "evt-4")],
			DAY_20,
		);
		expect(after.borrower).toEqual(neverPaid);
		expect(after.lender).toEqual(neverPaid);
		expect(after.difference).toEqual([]);
	});

	it("a borrower reversal counts in both views, but only where the target counts", () => {
		// The borrower claims a payment and then takes it back. The reversal hurts its recorder, so it is
		// against-interest, but the lender never counted the payment, so the lender ignores the reversal.
		const result = statement(
			[
				created(),
				payment(2, "borrower", "30000", DAY_10),
				reversal(3, "borrower", "30000", "2026-01-15", "evt-2"),
			],
			DAY_20,
		);
		expect(result.lender).toEqual(neverPaid);
		expect(result.borrower).toEqual(neverPaid);
		expect(result.difference.map((item) => item.lender_counts_minor)).toEqual([
			"0",
			"0",
		]);
		expect(result.difference.map((item) => item.borrower_counts_minor)).toEqual(
			["30000", "-30000"],
		);
	});

	it("a lender payment reversed by the borrower is undone in both views at once", () => {
		const result = statement(
			[
				created(),
				payment(2, "lender", "30000", DAY_10),
				reversal(3, "borrower", "30000", "2026-01-15", "evt-2"),
			],
			DAY_20,
		);
		expect(result.lender).toEqual(neverPaid);
		expect(result.borrower).toEqual(neverPaid);
		expect(result.difference).toEqual([]);
	});

	it("restores the interest the reversed payment covered, as if it was never paid", () => {
		// 100,000 at 5% with no schedule. A lender payment of 5,000 on 2026-07-01 is reversed on 2026-07-02.
		const fivePercent: Fields = {
			...TERMS,
			annual_rate: "0.05",
			issue_date: "2026-01-01",
		};
		const withReversal = [
			created(fivePercent),
			payment(2, "lender", "5000", "2026-07-01"),
			reversal(3, "lender", "5000", "2026-07-02", "evt-2"),
		];
		const never = statement([created(fivePercent)], "2026-12-31");
		const reversed = statement(withReversal, "2026-12-31");
		expect(reversed.lender.principal_minor).toBe("100000");
		expect(reversed.lender).toEqual(never.lender);
		expect(reversed.lender.payoff_minor).toBe(never.lender.payoff_minor);
		// Interest 2026-01-01 to 2026-12-31 is 364 days: 100,000 * 0.05 * 364 / 365 = 4986.30 -> 4986.
		expect(never.lender.interest_minor).toBe("4986");
	});

	it("still applies the payment as of a date before the reversal's value date", () => {
		const events = [
			created({ ...TERMS, annual_rate: "0.05" }),
			payment(2, "lender", "5000", "2026-07-01"),
			reversal(3, "lender", "5000", "2026-07-02", "evt-2"),
		];
		const onPaymentDay = statement(events, "2026-07-01");
		expect(onPaymentDay.lender.paid_minor).toBe("5000");
		expect(BigInt(onPaymentDay.lender.principal_minor)).toBeLessThan(100_000n);
		// The reversal is not yet in effect, so it is not listed either.
		expect(onPaymentDay.difference.map((item) => item.event_id)).toEqual([]);
		const onReversalDay = statement(events, "2026-07-02");
		expect(onReversalDay.lender.paid_minor).toBe("0");
		expect(onReversalDay.lender.principal_minor).toBe("100000");
	});

	it("a disputed reversal does not count for the disputing party", () => {
		const result = statement(
			[
				created(),
				payment(2, "lender", "30000", DAY_10),
				reversal(3, "lender", "30000", "2026-01-15", "evt-2"),
				dispute(4, "borrower", "evt-3", "0", "The check cleared"),
			],
			DAY_20,
		);
		// The lender recorded the reversal and it helps the lender, so the lender view undoes the payment; the
		// borrower disputed it to 0, so the borrower view still counts the payment.
		expect(result.lender).toEqual(neverPaid);
		expect(result.borrower.paid_minor).toBe("30000");
		expect(result.difference.map((item) => item.status)).toEqual(["disputed"]);
	});

	it("a reversal has no effect in a view that does not count its target", () => {
		// The lender disputes the borrower's payment down to 0, then reverses it: the lender view never counted it.
		const result = statement(
			[
				created(),
				payment(2, "borrower", "30000", DAY_10),
				dispute(3, "lender", "evt-2", "0", "Nothing arrived"),
				reversal(4, "lender", "30000", "2026-01-15", "evt-2"),
			],
			DAY_20,
		);
		expect(result.lender).toEqual(neverPaid);
		expect(result.lender.paid_minor).toBe("0");
		expect(result.borrower.paid_minor).toBe("30000");
	});

	it("rejects a second reversal of the same payment, a partial one and an earlier one", () => {
		const base = [created(), payment(2, "lender", "30000", DAY_10)];
		expect(() =>
			statement(
				[
					...base,
					reversal(3, "lender", "30000", "2026-01-15", "evt-2"),
					reversal(4, "lender", "30000", "2026-01-16", "evt-2"),
				],
				DAY_20,
			),
		).toThrow('payment "evt-2" is already reversed by "evt-3"');
		expect(() =>
			statement(
				[...base, reversal(3, "lender", "10000", "2026-01-15", "evt-2")],
				DAY_20,
			),
		).toThrow("one whole payment");
		expect(() =>
			statement(
				[...base, reversal(3, "lender", "30000", "2026-01-10", "evt-2")],
				DAY_20,
			),
		).toThrow("before");
	});
});

describe("dispute and resolution (R-11)", () => {
	// The borrower pays 10,000 on day 10; the lender disputes it down to 0.
	const disputedStream = [
		created(),
		payment(2, "borrower", "10000", DAY_10),
		dispute(3, "lender", "evt-2", "0", "Nothing arrived"),
	];

	it("a dispute moves only the disputer's view and lists the difference", () => {
		const result = statement(disputedStream, DAY_20);
		expect(result.lender.paid_minor).toBe("0");
		expect(result.borrower.paid_minor).toBe("10000");
		expect(result.difference).toEqual([
			{
				event_id: "evt-2",
				value_date: DAY_10,
				status: "disputed",
				lender_counts_minor: "0",
				borrower_counts_minor: "10000",
				difference_minor: "-10000",
				unanswered_days: null,
				reason: "Nothing arrived",
			},
		]);
	});

	it("a resolution filed by one party alone leaves the dispute standing", () => {
		const result = statement(
			[...disputedStream, resolution(4, "borrower", "evt-2", "10000")],
			DAY_20,
		);
		expect(result.lender.paid_minor).toBe("0");
		expect(result.borrower.paid_minor).toBe("10000");
		expect(result.difference.map((item) => item.status)).toEqual(["disputed"]);
		const bySecondParty = statement(
			[...disputedStream, resolution(4, "lender", "evt-2", "4000")],
			DAY_20,
		);
		expect(bySecondParty.lender.paid_minor).toBe("0");
		expect(bySecondParty.borrower.paid_minor).toBe("10000");
	});

	it("both parties resolving the same amount equalises both views at that amount", () => {
		const result = statement(
			[
				...disputedStream,
				resolution(4, "borrower", "evt-2", "6000"),
				resolution(5, "lender", "evt-2", "6000"),
			],
			DAY_20,
		);
		expect(result.lender.paid_minor).toBe("6000");
		expect(result.borrower.paid_minor).toBe("6000");
		expect(result.lender).toEqual(result.borrower);
		expect(result.difference).toEqual([]);
		expect(result.payoff_gap_minor).toBe("0");
	});

	it("both parties resolving different amounts leaves the dispute standing", () => {
		const result = statement(
			[
				...disputedStream,
				resolution(4, "borrower", "evt-2", "6000"),
				resolution(5, "lender", "evt-2", "5000"),
			],
			DAY_20,
		);
		expect(result.lender.paid_minor).toBe("0");
		expect(result.borrower.paid_minor).toBe("10000");
		expect(result.difference.map((item) => item.status)).toEqual(["disputed"]);
	});

	it("a party who changes its figure to match the other settles it; changing away unsettles it", () => {
		const matched = [
			...disputedStream,
			resolution(4, "borrower", "evt-2", "6000"),
			resolution(5, "lender", "evt-2", "5000"),
			resolution(6, "lender", "evt-2", "6000"),
		];
		expect(statement(matched, DAY_20).lender.paid_minor).toBe("6000");
		const unsettled = statement(
			[...matched, resolution(7, "borrower", "evt-2", "7000")],
			DAY_20,
		);
		expect(unsettled.lender.paid_minor).toBe("0");
		expect(unsettled.borrower.paid_minor).toBe("10000");
	});

	it("a later dispute reopens a resolved payment", () => {
		const result = statement(
			[
				...disputedStream,
				resolution(4, "borrower", "evt-2", "6000"),
				resolution(5, "lender", "evt-2", "6000"),
				dispute(6, "lender", "evt-2", "1000", "Second look"),
			],
			DAY_20,
		);
		expect(result.lender.paid_minor).toBe("1000");
		expect(result.borrower.paid_minor).toBe("10000");
		// Resolutions filed before the new dispute are forgotten: one filing after it does not settle anything.
		const oneFiled = statement(
			[
				...disputedStream,
				resolution(4, "borrower", "evt-2", "6000"),
				resolution(5, "lender", "evt-2", "6000"),
				dispute(6, "lender", "evt-2", "1000", "Second look"),
				resolution(7, "borrower", "evt-2", "6000"),
			],
			DAY_20,
		);
		expect(oneFiled.lender.paid_minor).toBe("1000");
	});

	it("a confirmation by the disputing party withdraws the dispute", () => {
		const result = statement(
			[...disputedStream, confirmation(4, "lender", "evt-2")],
			DAY_20,
		);
		expect(result.lender.paid_minor).toBe("10000");
		expect(result.borrower.paid_minor).toBe("10000");
		expect(result.difference).toEqual([]);
	});

	it("a confirmation after a settled resolution decides, and a resolution filed after it is ignored", () => {
		const settled = [
			...disputedStream,
			resolution(4, "borrower", "evt-2", "6000"),
			resolution(5, "lender", "evt-2", "6000"),
		];
		const confirmed = statement(
			[...settled, confirmation(6, "lender", "evt-2")],
			DAY_20,
		);
		expect(confirmed.lender.paid_minor).toBe("10000");
		expect(confirmed.borrower.paid_minor).toBe("10000");
		const ignored = statement(
			[
				...disputedStream,
				confirmation(4, "lender", "evt-2"),
				resolution(5, "borrower", "evt-2", "6000"),
				resolution(6, "lender", "evt-2", "6000"),
			],
			DAY_20,
		);
		expect(ignored.lender.paid_minor).toBe("10000");
		expect(ignored.borrower.paid_minor).toBe("10000");
	});

	it("the same two-sided settlement works for a lender-recorded payment", () => {
		// The lender recorded 30,000; the borrower disputes it to 20,000; both settle on 25,000.
		const result = statement(
			[
				created(),
				payment(2, "lender", "30000", DAY_10),
				dispute(3, "borrower", "evt-2", "20000", "I handed over 200"),
				resolution(4, "lender", "evt-2", "25000"),
				resolution(5, "borrower", "evt-2", "25000"),
			],
			DAY_20,
		);
		// 25,000 on day 10: interest 100, principal 100,000 - 24,900 = 75,100. Days 10 to 20 are 10 days:
		// 75,100 * 0.0365 * 10 / 365 = 75.1 -> 75; payoff 75,175.
		expect(result.lender.paid_minor).toBe("25000");
		expect(result.lender.payoff_minor).toBe("75175");
		expect(result.borrower).toEqual(result.lender);
		expect(result.difference).toEqual([]);
	});
});

describe("difference item source (R-14)", () => {
	it("carries the backfill source of the payment", () => {
		const backfilled = make(
			2,
			"payment.recorded",
			"borrower",
			"2026-01-12T10:00:00Z",
			{
				kind: "payment",
				amount_minor: "30000",
				value_date: DAY_10,
				source: "borrower-states",
			},
		);
		const result = statement(
			[created(), backfilled, payment(3, "borrower", "100", DAY_10)],
			DAY_20,
		);
		expect(result.difference.map((item) => item.source)).toEqual([
			"borrower-states",
			undefined,
		]);
		expect("source" in (result.difference[1] ?? {})).toBe(false);
	});
});

describe("overdue is capped at the payoff (R-16)", () => {
	it("is zero for a view that has paid the note off early", () => {
		const terms: Fields = {
			...TERMS,
			annual_rate: "0.05",
			schedule: {
				type: "amortized",
				frequency: "monthly",
				count: 12,
				first_due: "2026-02-01",
			},
		};
		// 100,000 plus one day of interest (13.7 -> 14) clears the note on 2026-01-02.
		const result = statement(
			[created(terms), payment(2, "lender", "100014", "2026-01-02")],
			"2027-06-01",
		);
		expect(result.lender.payoff_minor).toBe("0");
		expect(result.expected.lender_overdue_minor).toBe("0");
		expect(result.expected.lender_days_overdue).toBe(0);
		expect(result.expected.borrower_overdue_minor).toBe("0");
		expect(result.expected.borrower_days_overdue).toBe(0);
		// More was due than was paid, which the cap alone hides.
		expect(BigInt(result.expected.due_to_date_minor)).toBeGreaterThan(100_014n);
	});

	it("never exceeds the view's payoff", () => {
		const terms: Fields = {
			...TERMS,
			schedule: {
				type: "custom",
				installments: [{ due: "2026-01-11", amount_minor: "500000" }],
			},
		};
		// Due 500,000 against a payoff of 100,100; nothing paid, so the overdue is the payoff, not the 500,000.
		const result = statement([created(terms)], DAY_20);
		expect(result.expected.lender_overdue_minor).toBe("100200");
		expect(result.expected.lender_days_overdue).toBe(10);
	});
});

describe("unanswered age (R-12)", () => {
	it("counts whole days from the date part of entered_at to as_of", () => {
		// 2026-01-12T23:59:59Z to 2026-01-30 is 18 days; the time of day does not matter.
		const result = statement(
			[
				created(),
				payment(2, "borrower", "30000", DAY_10, "2026-01-12T23:59:59Z"),
			],
			"2026-01-30",
		);
		expect(result.difference[0]?.unanswered_days).toBe(18);
	});

	it("is clamped at 0 when entered after as_of, and null once answered", () => {
		const entered = statement(
			[
				created(),
				payment(2, "borrower", "30000", DAY_10, "2026-02-05T08:00:00Z"),
			],
			DAY_20,
		);
		expect(entered.difference[0]?.unanswered_days).toBe(0);

		const disputed = statement(
			[
				created(),
				payment(2, "lender", "30000", DAY_10),
				dispute(3, "borrower", "evt-2", "20000", "short"),
			],
			DAY_20,
		);
		expect(disputed.difference[0]?.unanswered_days).toBeNull();
	});

	it("changes no number as time passes", () => {
		const events = [created(), payment(2, "borrower", "30000", DAY_10)];
		const soon = statement(events, "2026-01-12");
		const later = statement(events, "2026-06-30");
		expect(soon.lender.paid_minor).toBe(later.lender.paid_minor);
		expect(later.difference[0]?.status).toBe("claimed-by-borrower");
	});
});

describe("payments after as_of", () => {
	it("are not applied and not listed in the difference", () => {
		const result = statement(
			[created(), payment(2, "borrower", "30000", "2026-02-01")],
			DAY_20,
		);
		expect(result.borrower.paid_minor).toBe("0");
		expect(result.difference).toEqual([]);
	});
});

describe("statusLabel (R-19)", () => {
	it("uses plain wording and never claims proof", () => {
		const statuses: PaymentStatus[] = [
			"confirmed",
			"claimed-by-lender",
			"claimed-by-borrower",
			"disputed",
			"resolved",
			"reversed",
		];
		expect(statuses.map(statusLabel)).toEqual([
			"confirmed by both parties",
			"claimed by lender",
			"claimed by borrower",
			"disputed",
			"resolved by agreement",
			"reversed",
		]);
		for (const status of statuses) {
			expect(statusLabel(status)).not.toMatch(/proof|enforceable|binding/i);
		}
	});
});
