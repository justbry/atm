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
 */
export const prorationPair = <Line extends ProrationLine>(
	lines: readonly Line[],
	isTierPrice: (line: Line) => boolean,
): ProrationPair | null => {
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

/**
 * The units a raise of the quantity grants: (new - old) x `perUnit` x the share of the cycle left at `at`, rounded up,
 * per `policy.upgradeGrant` (`prorated`: the share; `full`: all of the difference; `none`: 0). The same count or a
 * decrease gives 0. Without a cycle (either end null, or an empty one) the whole difference is granted; a raise at or
 * after the cycle's end has no share left and grants 0.
 */
export const raiseUnits = ({
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
