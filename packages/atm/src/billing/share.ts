/**
 * B4 Uni's revenue share: the rules, and the events the handler makes from them. A school can agree to pay B4 Uni a
 * percentage (`policy.revenueShare`) of what it collects. The share is booked in the school's own ledger, `share.accrued`
 * when a payment is booked and `share.reversed` when a refund takes part of it back (postings in
 * `../ledger/postings.ts`); `shareStatement` (`../ledger/share-statement.ts`) turns the log into the month's statement.
 *
 *   share      = round half up of collected x percent / 100, whole cents, never above collected
 *   reversed   = share - round half up of share x refunded so far / collected (from the running total)
 *
 * Both are integer arithmetic (the percent as whole hundredths, the products as BigInt), so a rate such as 2.5 or 0.07
 * is never a floating point error and the result is the same on every machine. The base is the amount collected (what
 * the customer paid, after discounts) before Stripe's fee. Pure: no clock, no network.
 *
 * What the handler remembers: the share accrued on a payment and what a refund has reversed so far are kept on the
 * payment's record (`InvoiceRecord.share`, `BookingRecord.payment.share`), so a refund reverses its own part of what
 * was accrued, whatever the policy says by then. A payment booked before the school had a rate has no record of a share,
 * so a refund of it reverses nothing. USD only, like the money lines: a payment that is not in USD makes no share.
 *
 * A policy must pass `resolvePolicy`, which refuses a rate that is not 0 to 100 with at most two decimals. A policy built by
 * hand with such a rate makes no share, consistently and without an error: the handler never refuses a family's credits or
 * payment lines because of a rate.
 */
import { ledgerEvent } from "../ledger/postings.js";
import type { AtmEvent, BillingPolicy } from "../types.js";
import type { Booker } from "./money.js";

const HUNDREDTHS_PER_PERCENT = 100;
/** 100 percent, in hundredths of a percent. */
const FULL_HUNDREDTHS = 10_000n;
const HALF_FULL_HUNDREDTHS = 5_000n;
const CENTS_PER_DOLLAR = 100;
/** How far a rate may be from a whole number of hundredths before it is refused: floating point noise, not a third decimal. */
const HUNDREDTHS_TOLERANCE = 1e-6;

/** The cents of a payment's share accrued and reversed so far, as the payment's record keeps them. */
type ShareRecord = { accrued: number; reversed: number };

/**
 * A rate as a whole number of hundredths of a percent (2.5 -> 250), or null when it is not a usable rate: not a finite
 * number, below 0, above 100, or with more than two decimals (noise within `HUNDREDTHS_TOLERANCE` of a whole number of
 * hundredths is floating point, not a third decimal). The one rule every caller shares: `resolvePolicy` refuses a null,
 * `rateOf` turns it into no share.
 */
export const hundredthsOf = (percent: unknown): number | null => {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
	if (percent < 0 || percent > 100) return null;
	const hundredths = Math.round(percent * HUNDREDTHS_PER_PERCENT);
	return Math.abs(percent * HUNDREDTHS_PER_PERCENT - hundredths) >
		HUNDREDTHS_TOLERANCE
		? null
		: hundredths;
};

/**
 * A rate as a whole number of hundredths of a percent (2.5 -> 250). Throws for a rate outside 0 to 100 or with more than
 * two decimals, so an unchecked rate never reaches the arithmetic.
 */
export const percentToHundredths = (percent: number): number => {
	const hundredths = hundredthsOf(percent);
	if (hundredths === null)
		throw new RangeError(
			`a revenue share rate is a percent from 0 to 100 with at most two decimals, got ${String(percent)}`,
		);
	return hundredths;
};

const assertCents = (cents: number, what: string): void => {
	if (!Number.isSafeInteger(cents) || cents < 0)
		throw new RangeError(
			`${what} must be a whole number of cents, got ${String(cents)}`,
		);
};

/**
 * The share of a payment: `collected x percent / 100` in whole cents, rounded half up (2.5% of 10 cents is 0.25 cents,
 * 0; 50% of 1 cent is 0.5 cents, 1), never above `collected`. 0 for a rate of `null` or 0 and for nothing collected.
 */
export const shareOf = (collected: number, percent: number | null): number => {
	if (percent === null) return 0;
	const hundredths = BigInt(percentToHundredths(percent));
	assertCents(collected, "collected");
	const share =
		(BigInt(collected) * hundredths + HALF_FULL_HUNDREDTHS) / FULL_HUNDREDTHS;
	return Math.min(Number(share), collected);
};

/**
 * The share left after the charge's total refunded so far (`refundedTotal`): `share - round(share x refundedTotal /
 * collected)`, rounded half up. Taken from the running total, so the reversals of any number of partial refunds add up
 * to exactly one rounding of the whole, never drift, and never exceed `share`; a refund of all of `collected`, or more
 * (a total larger than the payment is clamped to it), leaves exactly 0. Does not rise as `refundedTotal` rises.
 */
export const shareAfterRefund = ({
	share,
	collected,
	refundedTotal,
}: {
	share: number;
	collected: number;
	refundedTotal: number;
}): number => {
	assertCents(share, "share");
	assertCents(collected, "collected");
	if (share === 0 || collected === 0) return share;
	const refunded = BigInt(Math.min(Math.max(refundedTotal, 0), collected));
	const whole = BigInt(collected);
	const reversed = (2n * BigInt(share) * refunded + whole) / (2n * whole);
	return share - Number(reversed);
};

/**
 * The rate a policy puts on a payment, or null for none: a policy stored without the field has none, and so has 0. The
 * rate is the normalized one (whole hundredths over 100: 2.5000000001 is 2.5), the number the events and the statement
 * show. A rate that is not valid (not a finite number, below 0, above 100, more than two decimals) is no share too, never
 * an error: a policy that skipped `resolvePolicy` must not block a family's credits or payment lines.
 */
export const rateOf = (policy: BillingPolicy): number | null => {
	const hundredths = hundredthsOf(policy.revenueShare?.percent ?? 0);
	return hundredths === null || hundredths <= 0
		? null
		: hundredths / HUNDREDTHS_PER_PERCENT;
};

type Common = {
	/** The money lines the handler made for this fact: a share follows only a payment (or refund) the books took. */
	money: readonly AtmEvent[];
	/** The id of the payment the share is for (an invoice id, or a booking's payment intent id). */
	paymentId: string;
	labels: Record<string, string>;
	booker: Booker;
	holder: { customerId: string };
};

/**
 * The share of a payment the handler has just booked: a `share.accrued` after its `payment.succeeded`, when the policy
 * has a rate and the share is at least one cent. Nothing for a payment the books did not take (a free invoice, a
 * non-USD one, whose marker is not a payment). `accrued` is what the payment's record keeps (0 when none).
 */
export const accrueShare = ({
	policy,
	kind,
	collected,
	money,
	paymentId,
	labels,
	booker,
	holder,
}: Common & {
	policy: BillingPolicy;
	kind: "invoice" | "booking";
	collected: number;
}): { events: AtmEvent[]; accrued: number } => {
	const payment = money.find(
		(event) => event.event_type === "payment.succeeded",
	);
	const percent = rateOf(policy);
	if (!payment || percent === null) return { events: [], accrued: 0 };
	const share = shareOf(collected, percent);
	if (share <= 0) return { events: [], accrued: 0 };
	return {
		accrued: share,
		events: [
			ledgerEvent({
				type: "share.accrued",
				school: booker.school,
				tz: booker.tz,
				eventTime: payment.event_time,
				key: holder.customerId,
				idem: `stripe:${paymentId}:share`,
				cause: booker.cause,
				labels,
				amount: share,
				text: `revenue share ${share / CENTS_PER_DOLLAR} USD (${percent}% of ${collected / CENTS_PER_DOLLAR} USD) on ${kind} ${paymentId}`,
				payload: {
					payment_id: paymentId,
					kind,
					collected,
					percent,
					share,
				},
			}),
		],
	};
};

/**
 * The part of a payment's share that a refund takes back: a `share.reversed` after its `payment.refunded`, from what the
 * payment's record says was accrued and reversed so far and the charge's running total refunded. Nothing when the record
 * has no share (the payment was booked before the school had a rate), when the refund was not booked, or when the total
 * adds nothing (a redelivery, or an older event that arrives late). The idem carries the running total, so a redelivery
 * books once and two refunds book separately. `share` is the record to keep: unchanged when nothing was reversed.
 */
export const reverseShare = ({
	record,
	collected,
	refundedTotal,
	refundId,
	refundAt,
	money,
	paymentId,
	labels,
	booker,
	holder,
}: Common & {
	record: ShareRecord | undefined;
	collected: number;
	/** The charge's total refunded so far, after this refund. */
	refundedTotal: number;
	refundId: string;
	refundAt: number;
}): { events: AtmEvent[]; share: ShareRecord | undefined } => {
	const booked = money.some((event) => event.event_type === "payment.refunded");
	if (!record || !booked) return { events: [], share: record };
	const left = shareAfterRefund({
		share: record.accrued,
		collected,
		refundedTotal,
	});
	const reversedTotal = record.accrued - left;
	const before = record.accrued - record.reversed;
	const reversed = reversedTotal - record.reversed;
	if (reversed <= 0) return { events: [], share: record };
	return {
		share: { accrued: record.accrued, reversed: reversedTotal },
		events: [
			ledgerEvent({
				type: "share.reversed",
				school: booker.school,
				tz: booker.tz,
				eventTime: refundAt,
				key: holder.customerId,
				idem: `stripe:${refundId}:share-reversed:${refundedTotal}`,
				cause: booker.cause,
				labels,
				amount: reversed,
				text: `revenue share ${reversed / CENTS_PER_DOLLAR} USD reversed on ${paymentId}`,
				payload: {
					payment_id: paymentId,
					refunded_total: refundedTotal,
					share_before: before,
					share_after: left,
					reversed,
				},
			}),
		],
	};
};
