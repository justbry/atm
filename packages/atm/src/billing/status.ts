/** A subscription's state as the membership shows it. Pure. */
import type {
	MembershipStatus,
	SubscriptionFact,
	SubscriptionStatus,
} from "./types.js";

const STATUS: Record<SubscriptionFact["status"], MembershipStatus> = {
	active: "active",
	trialing: "active",
	past_due: "past_due",
	unpaid: "past_due",
	incomplete: "payment_incomplete",
	incomplete_expired: "ended",
	canceled: "ended",
	paused: "inactive",
};

export function subscriptionStatus(fact: SubscriptionFact): SubscriptionStatus {
	const status = STATUS[fact.status];
	const live = status === "active" || status === "past_due";
	const cancelAtPeriodEnd = status !== "ended" && fact.cancelAtPeriodEnd;
	const periodEnd = Number.isFinite(fact.currentPeriodEnd)
		? fact.currentPeriodEnd
		: null;
	return {
		status,
		renewsAt: live && !cancelAtPeriodEnd ? periodEnd : null,
		cancelAtPeriodEnd,
		endsAt: live && cancelAtPeriodEnd ? periodEnd : null,
		active: status === "active",
	};
}

export type { MembershipStatus, SubscriptionStatus };
