/**
 * What every bundle must satisfy about a book, apart from its golden files: the hand numbers against the reports, Stripe's
 * records against the hand numbers, the credit sums and the reconcile differences. Shared by the matrix
 * (`e2e-reconcile.test.ts`, which also checks the goldens) and `scenario-bundles.test.ts` (which checks the hashes).
 */
import { expect } from "bun:test";
import {
	type BookRun,
	type Case,
	differenceLine,
	type Numbers,
	stripeBalanceOf,
	stripeFeesOf,
} from "./e2e-matrix.js";

const INCOME = "income:";
const CREDIT_PREFIXES = ["avail:", "held:"];

export const sumIncome = (numbers: Numbers): number =>
	Object.entries(numbers)
		.filter(([name]) => name.startsWith(INCOME))
		.reduce((total, [, cents]) => total + cents, 0);

/** The month names a book reconciles, in order. */
export const months = (book: Case["books"][number]): string[] =>
	Object.keys(book.reconcile).sort();

const expectReport = (
	label: string,
	report: Numbers,
	hand: Numbers,
	pinned: Numbers,
) => {
	const names = new Set([
		...Object.keys(report),
		...Object.keys(hand),
		...Object.keys(pinned),
	]);
	for (const name of names) {
		const expected =
			name in pinned ? (pinned[name] as number) : (hand[name] ?? 0);
		expect(report[name] ?? 0, `${label}: ${name}`).toBe(expected);
	}
	for (const [name, cents] of Object.entries(pinned))
		expect(
			cents,
			`${label}: the pinned ${name} is the hand number, so it is no discrepancy`,
		).not.toBe(hand[name] ?? 0);
};

/** Everything a book must satisfy whatever its goldens say: the hand numbers, the oracle's own sums, no leaks, credits, reconcile. */
export const expectBookInvariants = (c: Case, index: number, got: BookRun) => {
	const book = c.books[index] as Case["books"][number];
	const label = `${c.id}/${book.school}`;
	const { hand, pinned = {} } = book;

	// (3) the hand numbers against the reports hledger printed from the handler's log
	expectReport(label, got.report, hand, pinned);

	// a book that crosses a month: each month's column of the income statement is the hand number for that month
	if (book.monthly) {
		expect(Object.keys(book.handMonthly ?? {}), `${label}: months`).toEqual(
			Object.keys(got.monthly),
		);
		for (const [month, expected] of Object.entries(book.handMonthly ?? {}))
			expectReport(`${label} ${month}`, got.monthly[month] ?? {}, expected, {});
	}

	// the reports agree with each other, whatever the hand says: net = revenue - refunds - disputes - fees, and the cash is the net
	const { report } = got;
	expect(report.net ?? 0, `${label}: net income`).toBe(
		sumIncome(report) -
			(report.refunds ?? 0) -
			(report.disputes ?? 0) -
			(report.fees ?? 0) -
			(report.disputeFees ?? 0),
	);
	expect((report.stripe ?? 0) + (report.clearing ?? 0), `${label}: cash`).toBe(
		report.net ?? 0,
	);

	// the oracle is consistent with itself: Stripe's own records add up to the hand numbers
	const strayBalance = book.foreign?.balance ?? 0;
	const strayFees = book.foreign?.fees ?? 0;
	expect(
		stripeBalanceOf(book.stripe) - strayBalance,
		`${label}: Stripe's balance`,
	).toBe(hand.stripe ?? 0);
	expect(stripeFeesOf(book.stripe) - strayFees, `${label}: Stripe's fees`).toBe(
		(hand.fees ?? 0) + (hand.disputeFees ?? 0),
	);
	expect(
		(book.stripe.refunds ?? []).reduce(
			(total, refund) => total + refund.amount,
			0,
		),
		`${label}: Stripe's refunds`,
	).toBe(hand.refunds ?? 0);

	// an erased family's personal data is in no shipped file and no journal
	expect(got.leaks, `${label}: files holding personal data`).toEqual([]);

	// every credit commodity sums to zero over the book
	for (const [commodity, units] of Object.entries(got.creditSums))
		expect(units, `${label}: ${commodity} over the credit accounts`).toBe(0n);

	// the replayed log's credit balances are the credit register's
	const creditNames = new Set(
		[...Object.keys(report), ...Object.keys(got.replayed)].filter((name) =>
			CREDIT_PREFIXES.some((prefix) => name.startsWith(prefix)),
		),
	);
	for (const name of creditNames)
		expect(got.replayed[name] ?? 0, `${label}: replayed ${name}`).toBe(
			report[name] ?? 0,
		);

	// (2) reconcile against Stripe's side
	for (const month of months(book))
		expect(
			(got.reconciled[month]?.differences ?? []).map(differenceLine),
			`${label}: reconcile ${month}`,
		).toEqual(book.reconcile[month] as string[]);

	// the markers for money the books do not hold: reconcile's count is the hand number
	for (const month of months(book))
		expect(
			got.reconciled[month]?.skipped ?? {},
			`${label}: skipped in ${month}`,
		).toEqual(book.skipped?.[month] ?? {});
};
