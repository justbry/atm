// SPDX-License-Identifier: Apache-2.0
/**
 * Civil-date math for tfd-notes: `YYYY-MM-DD` strings with no zone, no `Date`, no `Intl`.
 * Day numbers are computed with the proleptic Gregorian days-from-civil algorithm on `bigint`.
 * Supported years: 0001 to 9999.
 */
import type { CivilDate } from "./types";

export interface CivilParts {
	year: number;
	month: number;
	day: number;
}

const CIVIL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 1;
const MAX_YEAR = 9999;
const MONTHS_PER_YEAR = 12;
const DAYS_PER_MONTH = [
	31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
] as const;
/** Days from 0000-03-01 to 1970-01-01. */
const EPOCH_SHIFT_DAYS = 719_468n;

/** A digit string as a whole number; `parseInt` rather than `Number()`, which the portability test bans. */
const parseDigits = (digits: string): number => Number.parseInt(digits, 10);

const isLeapYear = (year: number): boolean =>
	(year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (year: number, month: number): number => {
	if (month === 2 && isLeapYear(year)) {
		return 29;
	}
	return DAYS_PER_MONTH[month - 1] ?? 0;
};

const partsOrNull = (text: string): CivilParts | null => {
	const match = CIVIL_DATE_PATTERN.exec(text);
	if (match === null) {
		return null;
	}
	const year = parseDigits(match[1] ?? "");
	const month = parseDigits(match[2] ?? "");
	const day = parseDigits(match[3] ?? "");
	if (
		year < MIN_YEAR ||
		year > MAX_YEAR ||
		month < 1 ||
		month > MONTHS_PER_YEAR
	) {
		return null;
	}
	if (day < 1 || day > daysInMonth(year, month)) {
		return null;
	}
	return { year, month, day };
};

export const isValidCivilDate = (text: string): boolean =>
	typeof text === "string" && partsOrNull(text) !== null;

/** Parse a `YYYY-MM-DD` string into its parts; throws on anything that is not a real calendar date. */
export const parseCivilDate = (text: CivilDate): CivilParts => {
	const parts = typeof text === "string" ? partsOrNull(text) : null;
	if (parts === null) {
		throw new Error(
			`Invalid civil date: ${JSON.stringify(text)} (expected a real YYYY-MM-DD date)`,
		);
	}
	return parts;
};

const formatParts = (year: number, month: number, day: number): CivilDate => {
	if (year < MIN_YEAR || year > MAX_YEAR) {
		throw new Error(
			`Civil date out of range: year ${year} (supported ${MIN_YEAR} to ${MAX_YEAR})`,
		);
	}
	const yearText = String(year).padStart(4, "0");
	const monthText = String(month).padStart(2, "0");
	const dayText = String(day).padStart(2, "0");
	return `${yearText}-${monthText}-${dayText}`;
};

/** Days since 1970-01-01 (negative before). Hinnant's days_from_civil, valid for year >= 0. */
const daysFromCivil = (parts: CivilParts): bigint => {
	const shiftedYear = BigInt(parts.month <= 2 ? parts.year - 1 : parts.year);
	const month = BigInt(parts.month);
	const day = BigInt(parts.day);
	const era = shiftedYear / 400n;
	const yearOfEra = shiftedYear - era * 400n;
	const monthIndex = month > 2n ? month - 3n : month + 9n;
	const dayOfYear = (153n * monthIndex + 2n) / 5n + day - 1n;
	const dayOfEra =
		yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
	return era * 146_097n + dayOfEra - EPOCH_SHIFT_DAYS;
};

const toWholeNumber = (value: bigint): number => parseDigits(value.toString());

const civilFromDays = (epochDays: bigint): CivilDate => {
	const shifted = epochDays + EPOCH_SHIFT_DAYS;
	if (shifted < 0n) {
		throw new Error("Civil date out of range: before 0000-03-01");
	}
	const era = shifted / 146_097n;
	const dayOfEra = shifted - era * 146_097n;
	const yearOfEra =
		(dayOfEra - dayOfEra / 1460n + dayOfEra / 36_524n - dayOfEra / 146_096n) /
		365n;
	const dayOfYear =
		dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
	const monthIndex = (5n * dayOfYear + 2n) / 153n;
	const day = dayOfYear - (153n * monthIndex + 2n) / 5n + 1n;
	const month = monthIndex < 10n ? monthIndex + 3n : monthIndex - 9n;
	const year = yearOfEra + era * 400n + (month <= 2n ? 1n : 0n);
	return formatParts(
		toWholeNumber(year),
		toWholeNumber(month),
		toWholeNumber(day),
	);
};

/** Whole days from `from` to `to` (`to - from`); negative when `to` is earlier. */
export const daysBetween = (from: CivilDate, to: CivilDate): number =>
	toWholeNumber(
		daysFromCivil(parseCivilDate(to)) - daysFromCivil(parseCivilDate(from)),
	);

/** `date` moved by a whole number of days (negative allowed). */
export const addDays = (date: CivilDate, days: number): CivilDate => {
	if (!Number.isSafeInteger(days)) {
		throw new Error(`addDays needs a whole number of days, got ${days}`);
	}
	return civilFromDays(daysFromCivil(parseCivilDate(date)) + BigInt(days));
};

/**
 * `anchor` moved by `monthsFromAnchor` months, keeping the anchor's day of month and clamping to the end of a shorter
 * month: Jan 31 + 1 month = Feb 28 (29 in a leap year), Jan 31 + 2 months = Mar 31. Always count from the anchor, never
 * from the previous result, so the day returns to 31 after a short month.
 */
export const addMonthsAnchored = (
	anchor: CivilDate,
	monthsFromAnchor: number,
): CivilDate => {
	if (!Number.isSafeInteger(monthsFromAnchor)) {
		throw new Error(
			`addMonthsAnchored needs a whole number of months, got ${monthsFromAnchor}`,
		);
	}
	const parts = parseCivilDate(anchor);
	const totalMonths =
		parts.year * MONTHS_PER_YEAR + (parts.month - 1) + monthsFromAnchor;
	const year = Math.floor(totalMonths / MONTHS_PER_YEAR);
	const month = totalMonths - year * MONTHS_PER_YEAR + 1;
	if (year < MIN_YEAR || year > MAX_YEAR) {
		throw new Error(
			`Civil date out of range: year ${year} (supported ${MIN_YEAR} to ${MAX_YEAR})`,
		);
	}
	return formatParts(
		year,
		month,
		Math.min(parts.day, daysInMonth(year, month)),
	);
};

/** -1, 0 or 1 as `left` is before, the same as, or after `right`. Both must be valid civil dates. */
export const compareDates = (left: CivilDate, right: CivilDate): -1 | 0 | 1 => {
	parseCivilDate(left);
	parseCivilDate(right);
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
};
