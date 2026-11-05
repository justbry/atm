/**
 * The quantity raise as two pure functions, so a caller that has no `GrantsState` reuses the rule instead of copying it:
 * `prorationPair` reads Stripe's pair of proration lines, `raiseUnits` turns a raise into the units to grant.
 * `invoiceToCommands` calls the unchecked cores (`prorationPairUnchecked`, `raiseUnitsUnchecked`), so the webhook path never
 * throws on a malformed Stripe value; the public checked functions are the ones `src/index.ts` exports. There is one copy
 * of the rule.
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
 * The proration lines of the tier's price: the ones the selection looks at. `isTierPrice` is the caller's predicate (it
 * may be a menu lookup), so every selection step works from this one pass: it runs once per proration line, and never on
 * a line that is not a proration.
 */
const acceptedLines = <Line extends ProrationLine>(
	lines: readonly Line[],
	isTierPrice: (line: Line) => boolean,
): ReadonlySet<Line> =>
	new Set(lines.filter((l) => l.proration && isTierPrice(l)));

/** The accepted positive line that starts LAST (the raise's charge), if any. */
const latestCharge = <Line extends ProrationLine>(
	lines: readonly Line[],
	accepted: ReadonlySet<Line>,
): Line | undefined =>
	lines
		.filter((l) => accepted.has(l) && l.amount > 0)
		.reduce<Line | undefined>(
			(latest, l) =>
				latest === undefined ||
				(l.periodStart ?? Number.NEGATIVE_INFINITY) >
					(latest.periodStart ?? Number.NEGATIVE_INFINITY)
					? l
					: latest,
			undefined,
		);

/**
 * The charge line of a raise: the positive proration line (of a price `isTierPrice` accepts) that starts LAST. A decrease
 * made with `create_prorations` leaves an older pair pending, and it rides on whichever invoice comes next (a later
 * raise, an add-on purchase, a renewal); that stale pair starts earlier and is not the raise.
 */
export const raiseLine = <Line extends ProrationLine>(
	lines: readonly Line[],
	isTierPrice: (line: Line) => boolean,
): Line | undefined => latestCharge(lines, acceptedLines(lines, isTierPrice));

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

/** Checks the two arguments. */
const assertPairArguments = <Line extends ProrationLine>(
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
};

const assertQuantity = (index: number, line: ProrationLine): void => {
	if (!(isFiniteNumber(line.quantity) && Number.isInteger(line.quantity)))
		throw new Error(
			`prorationPair: lines[${index}].quantity must be an integer, got ${String(line.quantity)}`,
		);
};

/**
 * Checks what the selection compares on every accepted line: `amount` (its sign) and `periodStart` (which starts last).
 * A line whose amount is not a number cannot be told from the raise, so its quantity is checked too, before the amount.
 */
const assertSelectionInput = <Line extends ProrationLine>(
	lines: readonly Line[],
	accepted: ReadonlySet<Line>,
): void => {
	for (const line of accepted) {
		const index = lines.indexOf(line);
		if (!isFiniteNumber(line.amount)) {
			assertQuantity(index, line);
			throw new Error(
				`prorationPair: lines[${index}].amount must be a finite number, got ${String(line.amount)}`,
			);
		}
		assertOptionalInstant(index, "periodStart", line.periodStart);
	}
};

/** Checks what the result is built from on one chosen line (the charge, or the credit it paired with). */
const assertChosenLine = (index: number, line: ProrationLine): void => {
	assertQuantity(index, line);
	assertOptionalInstant(index, "periodEnd", line.periodEnd);
	if (
		line.periodStart !== undefined &&
		line.periodEnd !== undefined &&
		line.periodEnd < line.periodStart
	)
		throw new Error(
			`prorationPair: lines[${index}].periodEnd (${line.periodEnd}) is before periodStart (${line.periodStart})`,
		);
};

/** The raise's charge line and the credit line that starts with it (if any). */
const choosePair = <Line extends ProrationLine>(
	lines: readonly Line[],
	accepted: ReadonlySet<Line>,
): { charge: Line; credit: Line | undefined } | null => {
	const charge = latestCharge(lines, accepted);
	if (!charge) return null;
	const credits = lines.filter((l) => accepted.has(l) && l.amount < 0);
	const credit =
		charge.periodStart === undefined
			? credits[0]
			: credits.find((l) => l.periodStart === charge.periodStart);
	return { charge, credit };
};

const pairOf = (
	charge: ProrationLine,
	credit?: ProrationLine,
): ProrationPair => ({
	oldQuantity: credit ? credit.quantity : null,
	newQuantity: charge.quantity,
	start: charge.periodStart ?? null,
	end: charge.periodEnd ?? null,
});

/**
 * `prorationPair` without the input checks: what 0.3.0 did, for a caller on a path that must not throw (the webhook
 * engine reads Stripe's data through this, and a throw there makes Stripe retry the same event for days). Garbage in
 * gives the same garbage out as before.
 */
export const prorationPairUnchecked = <Line extends ProrationLine>(
	lines: readonly Line[],
	isTierPrice: (line: Line) => boolean,
): ProrationPair | null => {
	const chosen = choosePair(lines, acceptedLines(lines, isTierPrice));
	return chosen ? pairOf(chosen.charge, chosen.credit) : null;
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
 * Throws an `Error` naming the problem when `lines` is not an array or `isTierPrice` is not a function; when a proration
 * line `isTierPrice` accepts has an `amount` that is not a finite number or a `periodStart` that is neither undefined
 * nor a finite number (the selection compares those, on every such line); or when the line the result is built from (the
 * charge, and the credit paired with it) has a `quantity` that is not an integer, a `periodEnd` that is neither
 * undefined nor a finite number, or a `periodEnd` before its `periodStart`. An older pair that is not chosen is checked
 * only for the first two, so a stale pair with a bad quantity or `periodEnd` does not make a valid raise throw. Lines
 * that are not prorations, or that `isTierPrice` rejects, are ignored and never validated.
 */
export const prorationPair = <Line extends ProrationLine>(
	lines: readonly Line[],
	isTierPrice: (line: Line) => boolean,
): ProrationPair | null => {
	assertPairArguments(lines, isTierPrice);
	const accepted = acceptedLines(lines, isTierPrice);
	assertSelectionInput(lines, accepted);
	const chosen = choosePair(lines, accepted);
	if (!chosen) return null;
	assertChosenLine(lines.indexOf(chosen.charge), chosen.charge);
	if (chosen.credit)
		assertChosenLine(lines.indexOf(chosen.credit), chosen.credit);
	return pairOf(chosen.charge, chosen.credit);
};

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
};

/**
 * `raiseUnits` without the input checks: what 0.3.0 did, for the webhook engine, which must not throw on what Stripe
 * sends. Garbage in gives the same garbage out as before.
 */
export const raiseUnitsUnchecked = ({
	perUnit,
	oldQuantity,
	newQuantity,
	at,
	cycleStart,
	cycleEnd,
	policy,
}: RaiseUnitsInput): number =>
	upgradeUnits({
		diff: (newQuantity - oldQuantity) * perUnit,
		policy,
		at,
		start: cycleStart,
		end: cycleEnd,
	});

/**
 * The units a raise of the quantity grants: (new - old) x `perUnit` x the share of the cycle left at `at`, rounded up,
 * per `policy.upgradeGrant` (`prorated`: the share; `full`: all of the difference; `none`: 0). The same count or a
 * decrease gives 0. Without a cycle (either end null, or an empty one) the whole difference is granted; a raise at or
 * after the cycle's end has no share left and grants 0.
 *
 * Throws an `Error` naming the field when the input is bad, instead of returning a wrong number: `perUnit`,
 * `oldQuantity`, `newQuantity` or `at` that is not a finite number (NaN, Infinity, null, undefined, a string);
 * `perUnit`, `oldQuantity` or `newQuantity` that is negative or not an integer (a menu grant is a whole number, and the
 * `full` policy returns the difference as is, so a fraction would come back as a fractional count of units); a cycle
 * bound that is neither null nor a finite number; or `cycleEnd` before `cycleStart`.
 *
 * The function cannot see a unit: `at`, `cycleStart` and `cycleEnd` must all be milliseconds (the unit of
 * `prorationPair`'s `start` and `end`). It does not guess: a cycle in seconds against `at` in milliseconds is not
 * detected, and gives a wrong share. Any instants on one clock are fine, so small synthetic values work.
 */
export const raiseUnits = (input: RaiseUnitsInput): number => {
	assertRaiseInput(input);
	return raiseUnitsUnchecked(input);
};
