// SPDX-License-Identifier: Apache-2.0
/**
 * Balance replay (spec R-4, R-5, R-9, R-16): simple daily interest, actual days over 365, on principal outstanding
 * only, replayed from counted payments. Accrued interest is exact between payments: it is held as an integer numerator
 * over the fixed denominator `rate.den * 365`, so nothing is rounded until a payment or the report date.
 */
import { compareDates, daysBetween } from "./date";
import {
	formatMinor,
	minBigint,
	parseMinor,
	parseRate,
	type Rational,
	roundHalfUp,
} from "./money";
import type { Balance, CivilDate, NoteTerms, ScheduleRow } from "./types";

const DAYS_PER_YEAR = 365n;

/**
 * Where a note stands between payments: the principal outstanding and the exact accrued interest as an integer
 * numerator over `interestDenominator(rate)`. The accrued figure can be fractional or slightly negative (a payment
 * rounds interest half up, so it can take a little more than was exactly accrued).
 */
export interface InterestState {
	principal: bigint;
	accruedNumerator: bigint;
}

/** What one payment did to the state. `unapplied` is the part beyond the payoff (the statement's `overpaid`). */
export interface PaymentSplit {
	interest: bigint;
	principal: bigint;
	unapplied: bigint;
	/** The interest due just before the payment: the exact accrued interest rounded half up, never below zero. */
	dueInterest: bigint;
}

/** The fixed denominator of `accruedNumerator`: rate denominator times 365. */
export const interestDenominator = (rate: Rational): bigint =>
	rate.den * DAYS_PER_YEAR;

/** The state after `days` more days on the outstanding principal (simple interest: nothing accrues on interest). */
export const accrueDays = (
	state: InterestState,
	rate: Rational,
	days: number,
): InterestState => ({
	principal: state.principal,
	accruedNumerator:
		state.accruedNumerator + state.principal * rate.num * BigInt(days),
});

/** The accrued interest rounded half up to a minor unit; zero when nothing (or less than nothing) has accrued. */
export const roundedInterest = (
	state: InterestState,
	rate: Rational,
): bigint =>
	state.accruedNumerator <= 0n
		? 0n
		: roundHalfUp(state.accruedNumerator, interestDenominator(rate));

/**
 * The one payment step shared by `replayBalance` and `generateSchedule` (R-5, R-9): a payment first covers the interest
 * due, then principal up to what is outstanding; the rest is unapplied. Interest left unpaid stays in its own bucket
 * (it is never added to principal); the exact remainder carries forward.
 */
export const applyPayment = (
	state: InterestState,
	rate: Rational,
	amount: bigint,
): { state: InterestState; split: PaymentSplit } => {
	const dueInterest = roundedInterest(state, rate);
	const interest = minBigint(amount, dueInterest);
	const principal = minBigint(amount - interest, state.principal);
	return {
		state: {
			principal: state.principal - principal,
			accruedNumerator:
				state.accruedNumerator - interest * interestDenominator(rate),
		},
		split: {
			interest,
			principal,
			unapplied: amount - interest - principal,
			dueInterest,
		},
	};
};

/** A payment a view counts. `amount_minor` is never negative: a reversal drops the payment it undoes (R-9a). */
export interface CountedPayment {
	id: string;
	value_date: CivilDate;
	amount_minor: bigint;
	seq: number;
}

/** Orders payments by value date, then by `seq`: the replay order of both the balance and the statement. */
export const comparePayments = (
	left: Pick<CountedPayment, "value_date" | "seq">,
	right: Pick<CountedPayment, "value_date" | "seq">,
): number => {
	const byDate = compareDates(left.value_date, right.value_date);
	return byDate === 0 ? left.seq - right.seq : byDate;
};

/**
 * The balance on `asOf` after replaying `payments` in (value_date, seq) order; the input order does not matter.
 *
 * - A negative amount or a payment dated before `issue_date` throws; one dated after `asOf` is ignored.
 * - A payment first covers interest due (the exact accrued interest rounded half up, never below zero), then
 *   principal up to what is outstanding; the rest is `overpaid_minor` and is not applied. Interest left unpaid, or
 *   over-collected by rounding, carries forward exactly (it can be fractional or slightly negative).
 * - At `asOf`, interest is the exact accrued amount rounded half up; payoff = principal + interest.
 */
export const replayBalance = (
	terms: NoteTerms,
	payments: CountedPayment[],
	asOf: CivilDate,
): Balance => {
	const rate = parseRate(terms.annual_rate);
	const initialPrincipal = parseMinor(terms.principal_minor);
	if (initialPrincipal <= 0n) {
		throw new Error(`Principal must be positive, got ${terms.principal_minor}`);
	}
	if (compareDates(asOf, terms.issue_date) < 0) {
		throw new Error(
			`as_of (${asOf}) is before issue_date (${terms.issue_date})`,
		);
	}
	let state: InterestState = {
		principal: initialPrincipal,
		accruedNumerator: 0n,
	};
	let lastDate = terms.issue_date;
	let paid = 0n;
	let overpaid = 0n;

	const accrueTo = (date: CivilDate): void => {
		state = accrueDays(state, rate, daysBetween(lastDate, date));
		lastDate = date;
	};

	for (const payment of [...payments].sort(comparePayments)) {
		if (payment.amount_minor < 0n) {
			throw new Error(
				`Payment ${payment.id} has a negative amount ${payment.amount_minor}; a reversal drops the payment it undoes instead (R-9a)`,
			);
		}
		if (compareDates(payment.value_date, terms.issue_date) < 0) {
			throw new Error(
				`Payment ${payment.id} is dated ${payment.value_date}, before issue_date ${terms.issue_date}`,
			);
		}
		if (compareDates(payment.value_date, asOf) > 0) {
			continue;
		}
		accrueTo(payment.value_date);
		const applied = applyPayment(state, rate, payment.amount_minor);
		state = applied.state;
		overpaid += applied.split.unapplied;
		paid += applied.split.interest + applied.split.principal;
	}

	accrueTo(asOf);
	const interest = roundedInterest(state, rate);
	return {
		principal_minor: formatMinor(state.principal),
		interest_minor: formatMinor(interest),
		payoff_minor: formatMinor(state.principal + interest),
		paid_minor: formatMinor(paid),
		overpaid_minor: formatMinor(overpaid),
	};
};

/** Sum of `payment_minor` of the rows due on or before `asOf` (spec R-16). */
export const expectedDueToDate = (
	schedule: ScheduleRow[],
	asOf: CivilDate,
): bigint => {
	let expected = 0n;
	for (const row of schedule) {
		if (compareDates(row.due, asOf) <= 0) {
			expected += parseMinor(row.payment_minor);
		}
	}
	return expected;
};

/**
 * Days overdue on `asOf` (spec R-16): 0 when `paidMinor` covers everything due; otherwise the whole days from the
 * due date of the first row whose cumulative expected exceeds `paidMinor` to `asOf`. Rows must be in due order.
 * A row due on `asOf` itself counts as due, so it can be 0 days overdue while money is still short.
 */
export const daysOverdue = (
	schedule: ScheduleRow[],
	paidMinor: bigint,
	asOf: CivilDate,
): number => {
	let cumulative = 0n;
	for (const row of schedule) {
		if (compareDates(row.due, asOf) > 0) {
			return 0;
		}
		cumulative += parseMinor(row.payment_minor);
		if (cumulative > paidMinor) {
			return daysBetween(row.due, asOf);
		}
	}
	return 0;
};
