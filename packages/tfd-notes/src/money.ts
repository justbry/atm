// SPDX-License-Identifier: Apache-2.0
/**
 * Money and rate parsing for tfd-notes. Everything is `bigint`: no `Number`, no floats (spec R-2, R-3, R-5).
 */

/** An exact fraction of two `bigint`, denominator positive. */
export interface Rational {
	num: bigint;
	den: bigint;
}

const MINOR_PATTERN = /^(?:0|-?[1-9]\d*)$/;
const RATE_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/;
const TEN = 10n;

/** Parse a minor-unit digit string: optional leading minus, no plus, no `-0`, no leading zeros except `"0"`. */
export const parseMinor = (text: string): bigint => {
	if (typeof text !== "string" || !MINOR_PATTERN.test(text)) {
		throw new Error(
			`Invalid minor-unit amount: ${JSON.stringify(text)} (expected digits like "35000" or "-500")`,
		);
	}
	return BigInt(text);
};

export const formatMinor = (value: bigint): string => value.toString();

/**
 * Parse an annual rate from a decimal string of at most 6 places into an exact fraction `{num, den}` with
 * `den = 10 ** places` (not reduced): `"0.0525"` is 525/10000, `"0"` is 0/1. The rate must be below 1 (under 100% a
 * year in v1). Rejects `".5"`, `"5%"`, `"1e-2"`, negatives, and more than 6 places.
 */
export const parseRate = (text: string): Rational => {
	const match = typeof text === "string" ? RATE_PATTERN.exec(text) : null;
	if (match === null) {
		throw new Error(
			`Invalid rate: ${JSON.stringify(text)} (expected a decimal like "0.0525" with at most 6 places)`,
		);
	}
	const fraction = match[2] ?? "";
	const num = BigInt(`${match[1]}${fraction}`);
	const den = TEN ** BigInt(fraction.length);
	if (num >= den) {
		throw new Error(
			`Invalid rate: ${JSON.stringify(text)} (must be below 1, i.e. under 100% a year)`,
		);
	}
	return { num, den };
};

/** `num / den` rounded half up to a whole number. `den` must be positive and `num` non-negative. */
export const roundHalfUp = (num: bigint, den: bigint): bigint => {
	if (den <= 0n) {
		throw new Error("roundHalfUp needs a positive denominator");
	}
	if (num < 0n) {
		throw new Error("roundHalfUp needs a non-negative numerator");
	}
	return (2n * num + den) / (2n * den);
};

/** `num / den` rounded up to a whole number. `den` must be positive and `num` non-negative. */
export const ceilDiv = (num: bigint, den: bigint): bigint => {
	if (den <= 0n) {
		throw new Error("ceilDiv needs a positive denominator");
	}
	if (num < 0n) {
		throw new Error("ceilDiv needs a non-negative numerator");
	}
	return (num + den - 1n) / den;
};

export const minBigint = (left: bigint, right: bigint): bigint =>
	left < right ? left : right;
export const maxBigint = (left: bigint, right: bigint): bigint =>
	left > right ? left : right;
