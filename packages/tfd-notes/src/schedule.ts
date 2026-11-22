// SPDX-License-Identifier: Apache-2.0
/**
 * Payment schedules (spec R-5, R-7, R-8): `none`, `custom` and `amortized`. Exact `bigint` arithmetic throughout.
 *
 * One rounding contract with `replayBalance`: a schedule is exactly what `replayBalance` would report if the borrower
 * paid every row's payment on its due date. Both run the same step (`accrueDays`, then `applyPayment` in accrual.ts):
 * interest accrues exactly, simple, actual days over 365; at each due date the interest due is the exact accrued figure
 * rounded half up (never below zero); the payment covers interest first, then principal; the exact remainder carries
 * forward. Unpaid interest stays in its own bucket and is never added to principal.
 */
import {
	accrueDays,
	applyPayment,
	type InterestState,
	roundedInterest,
} from "./accrual";
import { addDays, addMonthsAnchored, compareDates, daysBetween } from "./date";
import {
	ceilDiv,
	formatMinor,
	minBigint,
	parseMinor,
	parseRate,
	type Rational,
} from "./money";
import type { CivilDate, Frequency, NoteTerms, ScheduleRow } from "./types";

const WEEK_DAYS = 7;
const BIWEEK_DAYS = 14;
/** A weekly century. More installments than this are refused so a hostile terms object cannot stall a statement. */
export const MAX_INSTALLMENTS = 5200;

/** The due date of installment `index` (from 0) counted from `firstDue`; the validator checks the last one with it. */
export const dueDateFor = (
	firstDue: CivilDate,
	frequency: Frequency,
	index: number,
): CivilDate => {
	if (frequency === "weekly") {
		return addDays(firstDue, WEEK_DAYS * index);
	}
	if (frequency === "biweekly") {
		return addDays(firstDue, BIWEEK_DAYS * index);
	}
	return addMonthsAnchored(firstDue, index);
};

interface Step {
	state: InterestState;
	row: ScheduleRow;
}

/**
 * One installment: take `payment` from the state already accrued to the due date, as `replayBalance` would. For a custom
 * row the payment is the caller's amount, unchanged, so `payment - interest - principal` is positive when it exceeds
 * principal plus interest due (the excess is simply unapplied; the overdue logic later caps it).
 */
const installmentStep = (
	accrued: InterestState,
	rate: Rational,
	payment: bigint,
	number: number,
	due: CivilDate,
): Step => {
	const applied = applyPayment(accrued, rate, payment);
	return {
		state: applied.state,
		row: {
			n: number,
			due,
			payment_minor: formatMinor(payment),
			interest_minor: formatMinor(applied.split.interest),
			principal_minor: formatMinor(applied.split.principal),
			balance_after_minor: formatMinor(applied.state.principal),
		},
	};
};

const customSchedule = (
	terms: NoteTerms,
	principal: bigint,
	rate: Rational,
): ScheduleRow[] => {
	if (terms.schedule.type !== "custom") {
		return [];
	}
	const rows: ScheduleRow[] = [];
	let state: InterestState = { principal, accruedNumerator: 0n };
	let previousDate = terms.issue_date;
	for (const installment of terms.schedule.installments) {
		if (compareDates(installment.due, previousDate) <= 0) {
			throw new Error(
				`Custom installment due dates must be strictly increasing and after ${terms.issue_date}: got ${installment.due} after ${previousDate}`,
			);
		}
		const payment = parseMinor(installment.amount_minor);
		if (payment < 0n) {
			throw new Error(
				`Custom installment amount must not be negative: ${installment.amount_minor}`,
			);
		}
		const step = installmentStep(
			accrueDays(state, rate, daysBetween(previousDate, installment.due)),
			rate,
			payment,
			rows.length + 1,
			installment.due,
		);
		state = step.state;
		rows.push(step.row);
		previousDate = installment.due;
	}
	return rows;
};

interface AmortizedPlan {
	dueDates: CivilDate[];
	/** Days in each period: issue -> due 1, due 1 -> due 2, ... */
	periodDays: number[];
}

/** Level-payment installments 1 to count-1 (each paying at most `payment`), returning the state before the last. */
const simulateToFinalPeriod = (
	principal: bigint,
	rate: Rational,
	plan: AmortizedPlan,
	payment: bigint,
): InterestState => {
	let state: InterestState = { principal, accruedNumerator: 0n };
	for (const days of plan.periodDays.slice(0, -1)) {
		state = applyPayment(accrueDays(state, rate, days), rate, payment).state;
	}
	return state;
};

/**
 * The smallest level payment p >= 1 for which the final installment (principal left plus the final period's interest
 * due, rounded half up) is at most p. Feasibility is monotone in p (a larger payment never leaves more principal or
 * more accrued interest), so: exponential search for a feasible upper bound, then binary search.
 */
const findLevelPayment = (
	principal: bigint,
	rate: Rational,
	plan: AmortizedPlan,
): bigint => {
	const isFeasible = (payment: bigint): boolean => {
		const beforeFinal = simulateToFinalPeriod(principal, rate, plan, payment);
		const finalPeriod = accrueDays(
			beforeFinal,
			rate,
			plan.periodDays[plan.periodDays.length - 1] ?? 0,
		);
		return (
			beforeFinal.principal + roundedInterest(finalPeriod, rate) <= payment
		);
	};
	let high = 1n;
	while (!isFeasible(high)) {
		high *= 2n;
	}
	let low = high === 1n ? 1n : high / 2n + 1n;
	while (low < high) {
		const middle = (low + high) / 2n;
		if (isFeasible(middle)) {
			high = middle;
		} else {
			low = middle + 1n;
		}
	}
	return low;
};

const amortizedPlan = (terms: NoteTerms): AmortizedPlan => {
	if (terms.schedule.type !== "amortized") {
		return { dueDates: [], periodDays: [] };
	}
	const { count, first_due: firstDue, frequency } = terms.schedule;
	const dueDates: CivilDate[] = [];
	const periodDays: number[] = [];
	let previousDate = terms.issue_date;
	for (let index = 0; index < count; index += 1) {
		const due = dueDateFor(firstDue, frequency, index);
		dueDates.push(due);
		periodDays.push(daysBetween(previousDate, due));
		previousDate = due;
	}
	return { dueDates, periodDays };
};

const amortizedSchedule = (
	terms: NoteTerms,
	principal: bigint,
	rate: Rational,
): ScheduleRow[] => {
	if (terms.schedule.type !== "amortized") {
		return [];
	}
	const { count, first_due: firstDue } = terms.schedule;
	if (!Number.isInteger(count) || count < 1) {
		throw new Error(`Amortized schedule needs count >= 1, got ${count}`);
	}
	if (count > MAX_INSTALLMENTS) {
		throw new Error(
			`Amortized schedule allows at most ${MAX_INSTALLMENTS} installments, got ${count}`,
		);
	}
	if (principal <= 0n) {
		throw new Error(
			`Amortized schedule needs a positive principal, got ${terms.principal_minor}`,
		);
	}
	if (compareDates(firstDue, terms.issue_date) <= 0) {
		throw new Error(
			`first_due (${firstDue}) must be after issue_date (${terms.issue_date})`,
		);
	}
	const plan = amortizedPlan(terms);
	const lastIndex = count - 1;
	let levelPayment = 0n;
	if (count > 1) {
		levelPayment =
			rate.num === 0n
				? ceilDiv(principal, BigInt(count))
				: findLevelPayment(principal, rate, plan);
	}
	const rows: ScheduleRow[] = [];
	let state: InterestState = { principal, accruedNumerator: 0n };
	for (const [index, days] of plan.periodDays.entries()) {
		const accrued = accrueDays(state, rate, days);
		// Rows 1 to count-1 pay the level payment, capped at what is owed so a tiny principal is cleared early and later
		// rows are 0. The final row pays principal left plus interest due, so it always clears the note.
		const owed = accrued.principal + roundedInterest(accrued, rate);
		const payment = index === lastIndex ? owed : minBigint(levelPayment, owed);
		const step = installmentStep(
			accrued,
			rate,
			payment,
			index + 1,
			plan.dueDates[index] ?? "",
		);
		state = step.state;
		rows.push(step.row);
	}
	return rows;
};

/** The schedule rows for a note's terms. `none` gives no rows. Throws on terms that cannot form a schedule. */
export const generateSchedule = (terms: NoteTerms): ScheduleRow[] => {
	if (terms.schedule.type === "none") {
		return [];
	}
	const principal = parseMinor(terms.principal_minor);
	const rate = parseRate(terms.annual_rate);
	if (terms.schedule.type === "custom") {
		return customSchedule(terms, principal, rate);
	}
	return amortizedSchedule(terms, principal, rate);
};
