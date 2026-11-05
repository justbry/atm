/**
 * The quantity raise as two pure functions, so a caller that has no `GrantsState` reuses the rule instead of copying it:
 * `prorationPair` reads Stripe's pair of proration lines, `raiseUnits` turns a raise into the units to grant.
 * `invoiceToCommands` calls both; there is one copy of the rule.
 */
import type {
	BillingPolicy,
	ProrationLine,
	ProrationPair,
	RaiseUnitsInput,
} from "../types.js";

/** Units of an upgrade: `diff` x share of the cycle left, rounded up (integer math; never negative). */
export const upgradeUnits = ({
	diff,
	policy,
	at,
	start,
	end,
}: {
	diff: number;
	policy: Pick<BillingPolicy, "upgradeGrant">;
	at: number;
	start: number | null;
	end: number | null;
}): number => {
	if (diff <= 0 || policy.upgradeGrant === "none") return 0;
	if (policy.upgradeGrant === "full" || start === null || end === null)
		return diff;
	const span = end - start;
	if (span <= 0) return diff;
	const left = Math.min(Math.max(end - at, 0), span);
	return Math.floor((diff * left + span - 1) / span);
};

/**
 * The charge line of a raise: the positive proration line (of a price `isTierPrice` accepts) that starts LAST. A decrease
 * made with `create_prorations` leaves an older pair pending, and it rides on whichever invoice comes next (a later
 * raise, an add-on purchase, a renewal); that stale pair starts earlier and is not the raise.
 */
export const raiseLine = <Line extends ProrationLine>(
	lines: readonly Line[],
	isTierPrice: (line: Line) => boolean,
): Line | undefined =>
	lines
		.filter((l) => l.proration && l.amount > 0 && isTierPrice(l))
		.reduce<Line | undefined>(
			(latest, l) =>
				latest === undefined ||
				(l.periodStart ?? Number.NEGATIVE_INFINITY) >
					(latest.periodStart ?? Number.NEGATIVE_INFINITY)
					? l
					: latest,
			undefined,
		);

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const assertOptionalInstant = (
	index: number,
	name: "periodStart" | "periodEnd",
	value: unknown,
): void => {
	if (value === undefined || isFiniteNumber(value)) return;
	throw new Error(
		`prorationPair: lines[${index}].${name} must be undefined or a finite number (ms), got ${String(value)}`,
	);
};

/** Checks the arguments, and each proration line `isTierPrice` accepts; any other line is ignored, never validated. */
const assertPairInput = <Line extends ProrationLine>(
	lines: readonly Line[],
	isTierPrice: (line: Line) => boolean,
): void => {
	if (!Array.isArray(lines))
		throw new Error(
			`prorationPair: lines must be an array, got ${String(lines)}`,
		);
	if (typeof isTierPrice !== "function")
		throw new Error(
			`prorationPair: isTierPrice must be a function, got ${String(isTierPrice)}`,
		);
	for (const [index, line] of lines.entries()) {
		if (!line.proration || !isTierPrice(line)) continue;
		if (!(isFiniteNumber(line.quantity) && Number.isInteger(line.quantity)))
			throw new Error(
				`prorationPair: lines[${index}].quantity must be an integer, got ${String(line.quantity)}`,
			);
		if (!isFiniteNumber(line.amount))
			throw new Error(
				`prorationPair: lines[${index}].amount must be a finite number, got ${String(line.amount)}`,
			);
		assertOptionalInstant(index, "periodStart", line.periodStart);
		assertOptionalInstant(index, "periodEnd", line.periodEnd);
		if (
			line.periodStart !== undefined &&
			line.periodEnd !== undefined &&
			line.periodEnd < line.periodStart
		)
			throw new Error(
				`prorationPair: lines[${index}].periodEnd (${line.periodEnd}) is before periodStart (${line.periodStart})`,
			);
	}
};

/**
 * Stripe's proration pair for a raise of a subscription item's quantity (API 2025-10-29.clover, recorded): the credit
 * line, negative, holds the OLD quantity (what was left of the cycle at that count); the charge line, positive, holds
 * the NEW total, not the difference. `isTierPrice` picks the lines of the tier's price (the caller knows its price ids;
 * add-on and other lines are ignored). With several pairs on one invoice, the charge that starts last is the raise, and
 * its credit is the one that starts with it. Null when the invoice has no such charge line. A decrease made with
 * `create_prorations` leaves a pair too (the credit at the old count, a positive charge for the time left at the lower
 * one), so a non-null result is not always a raise: its `newQuantity` is below `oldQuantity`, and `raiseUnits` gives 0.
 *
 * `start` and `end` are the charge line's period: when the raise took effect and the end of the cycle (ms; null when the
 * line gives none). `oldQuantity` is Stripe's count and is null without a credit line. It is not the baseline for
 * `raiseUnits`: after a decrease that waits for the renewal, Stripe's count is lower than the one the credits still
 * reflect. Pass the quantity your credits reflect.
 *
 * Throws an `Error` naming the problem when `lines` is not an array, `isTierPrice` is not a function, or a proration line
 * `isTierPrice` accepts has a `quantity` that is not an integer, an `amount` that is not a finite number, a
 * `periodStart` or `periodEnd` that is neither undefined nor a finite number, or a `periodEnd` before its `periodStart`.
 * Lines that are not prorations, or that `isTierPrice` rejects, are ignored and never validated.
 */
export const prorationPair = <Line extends ProrationLine>(
	lines: readonly Line[],
	isTierPrice: (line: Line) => boolean,
): ProrationPair | null => {
	assertPairInput(lines, isTierPrice);
	const charge = raiseLine(lines, isTierPrice);
	if (!charge) return null;
	const credits = lines.filter(
		(l) => l.proration && l.amount < 0 && isTierPrice(l),
	);
	const credit =
		charge.periodStart === undefined
			? credits[0]
			: credits.find((l) => l.periodStart === charge.periodStart);
	return {
		oldQuantity: credit ? credit.quantity : null,
		newQuantity: charge.quantity,
		start: charge.periodStart ?? null,
		end: charge.periodEnd ?? null,
	};
};

/** Two instants of one clock differ by far less than this factor; seconds against milliseconds differ by 1000. */
const UNIT_MIX_FACTOR = 100;

const assertCount = (name: string, value: unknown): void => {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error(
			`raiseUnits: ${name} must be a finite number, got ${String(value)}`,
		);
	if (!Number.isInteger(value) || value < 0)
		throw new Error(
			`raiseUnits: ${name} must be a non-negative integer, got ${value}`,
		);
};

const assertCycleBound = (name: string, value: unknown): void => {
	if (value === null) return;
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error(
			`raiseUnits: ${name} must be null or a finite number (ms), got ${String(value)}`,
		);
};

/** True when two nonzero instants differ in magnitude by `UNIT_MIX_FACTOR` or more. */
const looksMixed = (a: number, b: number): boolean => {
	if (a === 0 || b === 0) return false;
	const small = Math.min(Math.abs(a), Math.abs(b));
	const large = Math.max(Math.abs(a), Math.abs(b));
	return small * UNIT_MIX_FACTOR <= large;
};

const assertRaiseInput = (input: RaiseUnitsInput): void => {
	const { perUnit, oldQuantity, newQuantity, at, cycleStart, cycleEnd } = input;
	assertCount("perUnit", perUnit);
	assertCount("oldQuantity", oldQuantity);
	assertCount("newQuantity", newQuantity);
	if (typeof at !== "number" || !Number.isFinite(at))
		throw new Error(
			`raiseUnits: at must be a finite number (ms), got ${String(at)}`,
		);
	assertCycleBound("cycleStart", cycleStart);
	assertCycleBound("cycleEnd", cycleEnd);
	if (cycleStart !== null && cycleEnd !== null && cycleEnd < cycleStart)
		throw new Error(
			`raiseUnits: cycleEnd (${cycleEnd}) is before cycleStart (${cycleStart})`,
		);
	for (const [name, bound] of [
		["cycleStart", cycleStart],
		["cycleEnd", cycleEnd],
	] as const) {
		if (bound !== null && looksMixed(at, bound))
			throw new Error(
				`raiseUnits: at (${at}) and ${name} (${bound}) look like different units (seconds against milliseconds); pass both in ms`,
			);
	}
};

/**
 * The units a raise of the quantity grants: (new - old) x `perUnit` x the share of the cycle left at `at`, rounded up,
 * per `policy.upgradeGrant` (`prorated`: the share; `full`: all of the difference; `none`: 0). The same count or a
 * decrease gives 0. Without a cycle (either end null, or an empty one) the whole difference is granted; a raise at or
 * after the cycle's end has no share left and grants 0.
 *
 * Throws an `Error` naming the field when the input is bad, instead of returning a wrong number: `perUnit`,
 * `oldQuantity`, `newQuantity` or `at` that is not a finite number (NaN, Infinity, null, undefined, a string);
 * `perUnit`, `oldQuantity` or `newQuantity` that is negative or not an integer; a cycle bound that is neither null nor a
 * finite number; `cycleEnd` before `cycleStart`; or `at` and a cycle bound in different units. The last is a heuristic:
 * the function cannot see a unit, so it rejects an `at` and a nonzero cycle bound whose magnitudes differ by a factor of
 * 100 or more (seconds against milliseconds differ by about 1000, while instants within years of each other in one unit
 * differ by far less). Seconds on both sides pass, and are read as milliseconds.
 */
export const raiseUnits = (input: RaiseUnitsInput): number => {
	assertRaiseInput(input);
	const {
		perUnit,
		oldQuantity,
		newQuantity,
		at,
		cycleStart,
		cycleEnd,
		policy,
	} = input;
	return upgradeUnits({
		diff: (newQuantity - oldQuantity) * perUnit,
		policy,
		at,
		start: cycleStart,
		end: cycleEnd,
	});
};
