import {
	type Member,
	type MemberBooking,
	type MemberDetail,
	type MembersSummary,
	type MembersWriter,
	type Person,
	type RefundablePayment,
	releaseReason,
} from "../data/members.ts";
import { endSentence, sentToast } from "./booking-text.ts";
import {
	type Applied,
	type Change,
	capitalized,
	countOf,
	pendingEvent,
	type RoleChange,
	roleTexts,
} from "./members-model.ts";

/** Everything a write needs besides its own fields. */
export type WriteContext = {
	writer: MembersWriter;
	schoolId: string;
	schoolName: string;
	/** `YYYY-MM-DDTHH:MM`, the clock's now. */
	now: string;
	unit: MembersSummary["unit"];
	rules: MembersSummary["bookingRules"];
	person: Person;
	/** `Dec 1`: the renewal the membership writes name. */
	renewal: string;
};

const ledger = (
	context: WriteContext,
	event: ReturnType<typeof pendingEvent>,
	paymentIntentId: string | null = null,
): Change => ({
	kind: "ledger",
	personId: context.person.id,
	event,
	paymentIntentId,
});

/** Brief C2 `credits/adjust`: the pending change shows as a ledger event and in the balance. */
export async function adjustCredits(
	context: WriteContext,
	member: Member,
	fields: {
		kind: "goodwill" | "gift" | "correction";
		amount: number;
		note: string;
	},
): Promise<Applied> {
	const featureId = member.balances[0]?.featureId;
	if (featureId === undefined)
		throw new Error(`membership ${member.membershipId} has no credits`);
	await context.writer.adjustCredits({
		schoolId: context.schoolId,
		membershipId: member.membershipId,
		featureId,
		...fields,
	});
	return {
		changes: [
			ledger(
				context,
				pendingEvent(context.now, {
					type: "credit.adjusted",
					text: `${capitalized(fields.kind)} · ${fields.note}`,
					credits: fields.amount,
				}),
			),
		],
		toast: sentToast,
	};
}

/** Brief C3 `invoices`: credits come only when it is paid, so there is no pending ledger event. */
export async function sendInvoice(
	context: WriteContext,
	member: Member,
	fields: { addonId: string; memo: string },
): Promise<Applied> {
	await context.writer.sendInvoice({
		schoolId: context.schoolId,
		familyId: member.familyId,
		addonId: fields.addonId,
		...(fields.memo === "" ? {} : { memo: fields.memo }),
	});
	return {
		changes: [],
		toast: `Invoice sent to ${context.person.name} via Stripe. It appears in the ledger when paid.`,
	};
}

/** Brief C1 `refunds`: the refund shows as an open payment row and takes from what is left on the payment. */
export async function refundPayment(
	context: WriteContext,
	payment: RefundablePayment,
	fields: { amountCents: number; whole: boolean; note: string },
): Promise<Applied> {
	const result = await context.writer.refund({
		schoolId: context.schoolId,
		paymentIntentId: payment.paymentIntentId,
		amountCents: fields.amountCents,
		reason: "requested_by_customer",
		note: fields.note,
	});
	if (result.status === "failed") throw new Error("Stripe refused the refund");
	return {
		changes: [
			ledger(
				context,
				pendingEvent(context.now, {
					type: "payment.refunded",
					kind: payment.kind === "booking" ? "booking" : "membership",
					text: `${fields.whole ? "Final" : "Partial"} refund · ${fields.note}`,
					amountCents: -fields.amountCents,
					bookingId: payment.bookingId,
				}),
				payment.paymentIntentId,
			),
		],
		toast: sentToast,
	};
}

/** Brief D3 `cancel`: a hold released inside its cutoff is forfeited when the school's rule spends it, unless the
 * admin waives. `quick` is the release with no second modal: its toast names the member. */
export async function releaseHold(
	context: WriteContext,
	booking: MemberBooking,
	fields: { waive: boolean; inside: boolean; quick: boolean },
): Promise<Applied> {
	await context.writer.cancelBooking({
		schoolId: context.schoolId,
		bookingId: booking.id,
		reason: releaseReason,
		waiveCutoff: fields.waive,
	});
	const late =
		fields.inside && context.rules.lateCancel === "spend" && !fields.waive;
	return {
		changes: [
			ledger(
				context,
				pendingEvent(context.now, {
					type: late ? "credit.forfeited" : "credit.released",
					text: `${booking.service}${late ? " · late cancel" : " · released"}`,
					credits: late ? -booking.creditsHeld : booking.creditsHeld,
					bookingId: booking.id,
				}),
			),
			{ kind: "booking", bookingId: booking.id },
		],
		toast: fields.quick
			? `Hold released for ${endSentence(context.person.name)}`
			: sentToast,
	};
}

/** Brief D2 `outcome`: attended spends the held credits, a no-show spends or releases them by the school's rule. */
export async function recordOutcome(
	context: WriteContext,
	booking: MemberBooking,
	state: "attended" | "no_show",
): Promise<Applied> {
	await context.writer.recordOutcome({
		schoolId: context.schoolId,
		bookingId: booking.id,
		state,
	});
	const held = booking.creditsHeld;
	const spends = state === "attended" || context.rules.noShow === "spend";
	const event =
		held === 0
			? pendingEvent(context.now, {
					type: "booking.outcome",
					text:
						state === "attended"
							? `${booking.service} attended`
							: `No-show, ${booking.service}`,
					bookingId: booking.id,
				})
			: pendingEvent(context.now, {
					type: spends ? "credit.spent" : "credit.released",
					text:
						state === "attended"
							? `${booking.service} attended`
							: `No-show${spends ? "," : " released,"} ${booking.service}`,
					credits: spends ? -held : held,
					bookingId: booking.id,
				});
	return {
		changes: [
			ledger(context, event),
			{ kind: "booking", bookingId: booking.id },
		],
		toast:
			state === "attended"
				? `Attendance confirmed for ${endSentence(context.person.name)}`
				: sentToast,
	};
}

/** Brief B4 and the roster write: the person's chips change at once, the server applies it at their next sign-in
 * refresh. */
export async function changeRole(
	context: WriteContext,
	change: RoleChange,
): Promise<Applied> {
	const { writer, schoolId, person } = context;
	if (change === "grant")
		await writer.grantFinance({ schoolId, subject: person.id });
	else if (change === "revoke")
		await writer.revokeFinance({ schoolId, subject: person.id });
	else
		await writer.changeRole({
			schoolId,
			personId: person.id,
			role: change === "make" ? "admin" : "member",
		});
	const { done } = roleTexts(change, person, context.schoolName);
	return {
		changes: [
			{ kind: "role", personId: person.id, role: change },
			ledger(
				context,
				pendingEvent(context.now, { type: "role.changed", text: done }),
			),
		],
		toast: `${done}. Applies at their next sign-in refresh (token lifetime 5 minutes).`,
	};
}

export async function switchPlan(
	context: WriteContext,
	member: Member,
	fields: { tierId: string; label: string; quantity: number },
): Promise<Applied> {
	await context.writer.switchTier({
		schoolId: context.schoolId,
		membershipId: member.membershipId,
		tierId: fields.tierId,
		quantity: fields.quantity,
	});
	return {
		changes: [
			ledger(
				context,
				pendingEvent(context.now, {
					type: "membership.changed",
					text: `Scheduled: ${member.tierName} ×${member.quantity} → ${fields.label} at renewal (${context.renewal})`,
				}),
			),
		],
		toast: `Switch to ${fields.label} scheduled for ${context.renewal}.`,
	};
}

export async function cancelMembership(
	context: WriteContext,
	member: Member,
	fields: { at: "period_end" | "now"; reason: string; available: number },
): Promise<Applied> {
	await context.writer.cancelMembership({
		schoolId: context.schoolId,
		membershipId: member.membershipId,
		at: fields.at,
		...(fields.reason === "" ? {} : { reason: fields.reason }),
	});
	const why = fields.reason === "" ? "" : ` · ${fields.reason}`;
	const now = fields.at === "now";
	return {
		changes: [
			{
				kind: "membership",
				membershipId: member.membershipId,
				change: now ? "cancel_now" : "cancel_period_end",
			},
			ledger(
				context,
				pendingEvent(context.now, {
					type: "membership.changed",
					text: now
						? `Canceled now${why} · ${countOf(fields.available, context.unit)} forfeited`
						: `Cancels at period end (${context.renewal})${why}`,
				}),
			),
		],
		toast: now
			? "Membership canceled."
			: `Membership will end on ${context.renewal}.`,
	};
}

export async function resumeMembership(
	context: WriteContext,
	member: Member,
): Promise<Applied> {
	await context.writer.resumeMembership({
		schoolId: context.schoolId,
		membershipId: member.membershipId,
	});
	return {
		changes: [
			{
				kind: "membership",
				membershipId: member.membershipId,
				change: "resume",
			},
			ledger(
				context,
				pendingEvent(context.now, {
					type: "membership.changed",
					text: `Resumed. Billing continues ${context.renewal}`,
				}),
			),
		],
		toast: "Membership resumed.",
	};
}

/** The bookings of the person whose hold can be released (mockup `kReleasable`): confirmed, with credits held, not
 * paid, not waiting for an outcome and with no write on its way. */
export const releasable = (
	detail: MemberDetail,
	person: Person,
	waiting: ReadonlySet<string>,
): MemberBooking[] =>
	detail.bookings
		.filter(
			(booking) =>
				booking.state === "confirmed" &&
				booking.creditsHeld > 0 &&
				booking.paidCents === null &&
				!waiting.has(booking.id) &&
				!person.attention.some(
					({ kind, bookingId }) =>
						kind === "needs_outcome" && bookingId === booking.id,
				),
		)
		.sort((first, second) => first.startsAt.localeCompare(second.startsAt));
