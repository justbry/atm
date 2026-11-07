import type { LockPanel, ViewAs } from "../data/disclosure.ts";
import {
	type AttentionReason,
	type Capabilities,
	type Capability,
	type CapabilityAction,
	eventLabels,
	type HistoryEvent,
	type Member,
	type MemberBalance,
	type MemberDetail,
	membersLock,
	type PaymentRow,
	type Person,
	type RefundablePayment,
} from "../data/members.ts";
import type { IconName } from "./icon.tsx";
import { monthAndDay } from "./period.ts";
import type { Change as PortalChange } from "./portal-format.ts";
import type { Viewing } from "./viewing.ts";

/** What the Members tab does with the answers of the Reader and the Writer: the pending effects of a write (shown
 * until the ledger ships), who is looking (`as=`), and the texts built from the contract's data. It
 * derives no number the server derives: it adds and subtracts what a pending write says, as the mockup's `proj`. */

export type Audience = Person["audience"];
export const audienceIcons: Record<Audience, IconName> = {
	public: "eye",
	member: "user",
	governance: "users",
	finance: "coin",
	owner: "key",
};
export const roleLabels: Record<Person["role"], string> = {
	owner: "Owner",
	admin: "Admin",
	member: "Member",
};
/** Owners first, then admins, then members. */
export const roleRank = (person: Person): number =>
	({ owner: 0, admin: 1, member: 2 })[person.role];

/** The lock panel the roster and the member portal show below the admins (the contract's `membersLock`). */
export const rosterLock: LockPanel = {
	reason: membersLock.code,
	who: membersLock.title,
	when: membersLock.text,
};

// ---- View as (`as=`, resolved by the shell from the school's disclosure: S7's `Viewing`)

export type Viewer = {
	/** Whose view is on screen: the signed-in person's own row, or a preview of another. */
	subject: ViewAs;
	/** Every write control is off (title `previewLock`) and nothing is saved. */
	preview: boolean;
	/** The roster shows: the owner, a finance admin or an admin. Below them it is the lock panel. */
	roster: boolean;
	/** Money shows per person: the owner and finance admins. */
	finance: boolean;
};

/** What the Members tab needs of the View as row it is drawn for. */
export const viewerOf = ({
	option,
	preview,
}: Pick<Viewing, "option" | "preview">): Viewer => ({
	subject: option.value,
	preview,
	roster: option.admin,
	finance: option.value === "owner" || option.value === "finance",
});

// ---- Pending effects

/** A write the Writer has answered whose effect the ledger has not shipped yet (within 5 minutes). The tab keeps the
 * list for the life of the mount and never re-reads after a write. */
export type Change =
	/** A ledger event, shown first in the person's history and counted in their balance. */
	| {
			kind: "ledger";
			personId: string;
			event: HistoryEvent;
			/** The payment a refund is for. */
			paymentIntentId: string | null;
	  }
	| { kind: "role"; personId: string; role: RoleChange }
	/** `other`: the portal sent a change that leaves the standing as it is (a new quantity). */
	| {
			kind: "membership";
			membershipId: string;
			personId: string;
			change: "cancel_period_end" | "cancel_now" | "resume" | "other";
	  }
	/** The booking has a write on its way: its attention reasons and its actions are off. */
	| { kind: "booking"; bookingId: string };

export type RoleChange = "make" | "remove" | "grant" | "revoke";

/** What a finished write adds to the tab: the changes and the toast. */
export type Applied = { changes: Change[]; toast: string };

const ledgerChanges = (changes: Change[], personId: string) =>
	changes.flatMap((change) =>
		change.kind === "ledger" && change.personId === personId ? [change] : [],
	);

export function pendingBookingIds(changes: Change[]): Set<string> {
	return new Set(
		changes.flatMap((change) =>
			change.kind === "booking" ? [change.bookingId] : [],
		),
	);
}

/** A plan change or a payment on its way holds the next one back (mockup `waiting`). */
export const changeWaiting = (changes: Change[], personId: string): boolean =>
	changes.some(
		(change) => change.kind === "membership" && change.personId === personId,
	) ||
	ledgerChanges(changes, personId).some(
		({ event }) =>
			event.type === "membership.changed" || event.type === "payment.succeeded",
	);

/** The membership changes the shell keeps by profile id (the member portal's map, which the roster writes into as
 * well) as the roster's changes, so that a cancel or resume made in either place shows in both. */
export function membershipChangesOf(
	members: Member[],
	kept: Record<string, PortalChange>,
): Change[] {
	return members.flatMap((member): Change[] => {
		if (member.profileId === null) return [];
		const sent = kept[member.profileId];
		if (!sent || (!sent.waiting && sent.ending === undefined)) return [];
		const change = sent.ending
			? sent.endsNow
				? "cancel_now"
				: "cancel_period_end"
			: sent.ending === false
				? "resume"
				: "other";
		return [
			{
				kind: "membership",
				membershipId: member.membershipId,
				personId: member.profileId,
				change,
			},
		];
	});
}

/** What the roster's finished write adds to the shell's membership map for the person: a cancel or resume sets the
 * ending, any plan change marks the person as waiting for the ledger. */
export function portalChangeOf(change: Change): PortalChange | null {
	if (change.kind === "membership") {
		if (change.change === "other") return { waiting: true };
		return {
			waiting: true,
			ending: change.change !== "resume",
			endsNow: change.change === "cancel_now",
		};
	}
	if (change.kind === "ledger" && change.event.type === "membership.changed")
		return { waiting: true };
	return null;
}

/** The balance as the mockup's `proj` shows it: the Reader's, then each pending event. */
export type Projection = {
	available: number;
	held: number;
	used: number;
	/** The Reader's available, before any pending event. */
	reported: number;
};

export function project(
	balance: MemberBalance,
	personId: string,
	changes: Change[],
): Projection {
	let { available, held } = balance;
	let used = Math.max(0, balance.granted - balance.available - balance.held);
	for (const { event } of ledgerChanges(changes, personId)) {
		const credits = event.credits ?? 0;
		const size = Math.abs(credits);
		if (event.type === "credit.released") {
			held -= size;
			available += size;
		} else if (
			event.type === "credit.spent" ||
			event.type === "credit.forfeited"
		) {
			held -= size;
			used += size;
		} else if (
			event.type === "credit.adjusted" ||
			event.type === "credit.granted"
		)
			available += credits;
	}
	return {
		available,
		held: Math.max(0, held),
		used,
		reported: balance.available,
	};
}

/** The three bar segments as percentages of the whole bar (mockup `bar3`). */
export function barOf(
	balance: MemberBalance,
	projection: Projection,
): { low: boolean; percents: Record<"used" | "held" | "available", string> } {
	const total = Math.max(
		balance.granted,
		projection.used + projection.held + projection.available,
		1,
	);
	const percent = (value: number): string =>
		`${((value / total) * 100).toFixed(1)}%`;
	return {
		low:
			projection.available === 0 ||
			balance.available / balance.granted < lowShare,
		percents: {
			used: percent(projection.used),
			held: percent(projection.held),
			available: percent(projection.available),
		},
	};
}
const lowShare = 0.2;

/** Whether the membership has ended or will, with the pending cancels and resumes applied in order. */
export type Standing = {
	canceled: boolean;
	cancelsAtPeriodEnd: boolean;
	endsToday: boolean;
};

export function standingOf(member: Member, changes: Change[]): Standing {
	let canceled = member.status === "canceled";
	let cancelsAtPeriodEnd = member.cancelAtPeriodEnd;
	let endsToday = false;
	for (const change of changes) {
		if (
			change.kind !== "membership" ||
			change.membershipId !== member.membershipId
		)
			continue;
		if (change.change === "other") continue;
		if (change.change === "cancel_period_end") cancelsAtPeriodEnd = true;
		else if (change.change === "cancel_now") {
			canceled = true;
			endsToday = true;
		} else {
			canceled = false;
			cancelsAtPeriodEnd = false;
			endsToday = false;
		}
	}
	return { canceled, cancelsAtPeriodEnd, endsToday };
}

/** Why a person needs attention now: the Reader's reasons, less those of a booking with a write on its way, and none
 * for a canceled membership. */
export function attentionOf(
	person: Person,
	canceled: boolean,
	changes: Change[],
): AttentionReason[] {
	if (canceled) return [];
	const waiting = pendingBookingIds(changes);
	return person.attention.filter(
		({ bookingId }) => bookingId === null || !waiting.has(bookingId),
	);
}
/** The booking is inside its cutoff: the server says so in the person's attention. */
export const insideCutoffOf = (
	person: Person,
	booking: { id: string },
): boolean =>
	person.attention.some(
		({ kind, bookingId }) =>
			kind === "inside_cutoff" && bookingId === booking.id,
	);
export const attentionScore = (reasons: AttentionReason[]): number =>
	reasons.reduce((sum, { tone }) => sum + (tone === "bad" ? 2 : 1), 0);

export function attentionLabel(
	reason: AttentionReason,
	unitPlural: string,
): string {
	const labels = {
		out: `Out of ${unitPlural}`,
		low: "Low",
		needs_outcome: "Needs outcome",
		inside_cutoff: "Inside cutoff",
	} as const;
	return labels[reason.kind];
}

// ---- Roles

/** The people with the pending role changes applied, in the order they were made. A member who loses their role and
 * holds no plan leaves the list. A role gives or takes the finance and owner audiences at once; every other audience
 * is the server's. */
export function applyRoles(people: Person[], changes: Change[]): Person[] {
	return people.flatMap((person) => {
		const mine = changes.flatMap((change) =>
			change.kind === "role" && change.personId === person.id
				? [change.role]
				: [],
		);
		if (mine.length === 0) return [person];
		let { role, financeGrant } = person;
		for (const change of mine) {
			if (change === "make") role = "admin";
			else if (change === "remove") {
				role = "member";
				financeGrant = false;
			} else financeGrant = change === "grant";
		}
		if (role === "member" && !person.planHolder) return [];
		return [
			{
				...person,
				role,
				financeGrant,
				...audienceAfter(person, role, financeGrant),
			},
		];
	});
}

function audienceAfter(
	person: Person,
	role: Person["role"],
	financeGrant: boolean,
): Pick<Person, "audience" | "audienceReason"> {
	if (role === "owner")
		return { audience: "owner", audienceReason: "Owner on the roster" };
	if (role === "admin" && financeGrant)
		return {
			audience: "finance",
			audienceReason: "Admin with the finance grant",
		};
	if (person.audience !== "finance" && person.audience !== "owner")
		return {
			audience: person.audience,
			audienceReason: person.audienceReason,
		};
	return person.planHolder
		? {
				audience: "member",
				audienceReason: "Adult with a live membership.",
			}
		: {
				audience: "public",
				audienceReason: `No live membership: Public.${role === "admin" ? adminNote : ""}`,
			};
}
const adminNote =
	" An admin without the finance grant gets audiences like anyone else.";

/** Why a role action is not allowed now (mockup `roleGuard`), or "". */
export function roleGuard(
	capabilities: Capabilities,
	people: Person[],
	person: Person,
	change: RoleChange,
): string {
	if (capabilities.role !== "owner") return "Owner role needed";
	if (person.role !== "owner" || change !== "remove") return "";
	const owners = people.filter(({ role }) => role === "owner").length;
	if (owners <= 1) return "Last owner: add another owner first";
	return person.you ? "Owners can't demote themselves" : "";
}

/** The role modal's texts (mockup `roleModal`). */
export function roleTexts(
	change: RoleChange,
	person: Person,
	schoolName: string,
): { title: string; body: string; done: string } {
	const { name } = person;
	const texts = {
		make: {
			title: `Make ${name} an admin?`,
			body: `${name} will see every member, the dashboard and bookings in ${schoolName}. Money stays off until you grant finance.`,
			done: `${name} is now an admin`,
		},
		remove: {
			title:
				person.role === "owner"
					? `Remove ${name} as owner?`
					: `Remove ${name} as admin?`,
			body: `${name} goes back to member access: only their own data and their family's. Any plan they hold stays.`,
			done: `${name} is now a member`,
		},
		grant: {
			title: `Grant finance to ${name}?`,
			body: `${name} will see money in the dashboard and ledger.`,
			done: `${name} has finance access`,
		},
		revoke: {
			title: `Revoke finance from ${name}?`,
			body: `${name} stops seeing money in the dashboard and ledger.`,
			done: `${name} no longer has finance access`,
		},
	};
	return texts[change];
}

// ---- Capabilities

/** Why an action is off, in the words of the menu or of the drawer's buttons, or "" when it is allowed. */
export function capabilityReason(
	capabilities: Capabilities,
	action: CapabilityAction,
	place: "menu" | "drawer",
): string {
	const capability: Capability = capabilities.actions[action];
	if (capability.allowed) return "";
	if (capability.reason === "stripe_permission_missing")
		return `The Stripe key lacks ${capability.permission}. Fix it in Settings.`;
	if (capability.reason === "owner_only")
		return place === "menu" || action !== "refund"
			? "Owner role needed"
			: "Refunds need the owner role in this school";
	return "Not available yet";
}

// ---- Texts and formats

/** `20`, or `2 sessions`. */
export const countOf = (
	count: number,
	unit: { one: string; other: string },
): string => `${count} ${count === 1 ? unit.one : unit.other}`;
export const capitalized = (text: string): string =>
	`${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;

/** `Dec 1` for unix seconds, in the school's time zone. */
export const formatDay = (seconds: number, timeZone: string): string =>
	new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		timeZone,
	}).format(new Date(seconds * 1000));
/** `Nov 4 17:00` for `YYYY-MM-DDTHH:MM`. */
export const formatWallTime = (wallTime: string): string =>
	`${monthAndDay(wallTime.slice(0, 10))} ${wallTime.slice(11)}`;
/** `Nov 1, 26` for `YYYY-MM-DD`. */
export const formatPaymentDay = (date: string): string =>
	`${monthAndDay(date)}, ${date.slice(2, 4)}`;

/** `+2`, `−1`: the sign of the mockup's `sgn`. */
export const signed = (value: number, text: string): string =>
	value < 0 ? `−${text}` : `+${text}`;
export const amountText = (cents: number): string =>
	signed(cents, (Math.abs(cents) / 100).toFixed(2));

/** The label of a history event (mockup `lab`). */
export function eventLabel(
	event: HistoryEvent,
	unit: { other: string },
): string {
	if (event.type === "payment.succeeded") {
		if (event.kind === "booking") return "Booking payment";
		return event.kind === "gift" ? "Gift sold" : "Payment";
	}
	if (event.type === "payment.refunded")
		return event.kind === "booking" ? "Booking refund" : "Refund";
	if (event.type === "credit.granted" && event.kind === "gift_redeemed")
		return "Gift redeemed";
	return (eventLabels[event.type] ?? event.type)
		.replace("{U}", capitalized(unit.other))
		.replace("{u}", unit.other);
}

export const eventColors: Record<string, string> = {
	"credit.granted": "var(--success)",
	"credit.spent": "var(--chart-1)",
	"credit.held": "var(--chart-3,var(--warning))",
	"credit.released": "var(--muted-foreground)",
	"credit.forfeited": "var(--destructive)",
	"credit.depleted": "var(--destructive)",
	"credit.refunded": "var(--warning)",
	"credit.adjusted": "var(--chart-5,var(--primary))",
	"payment.succeeded": "var(--info)",
	"payment.refunded": "var(--warning)",
	"membership.changed": "var(--chart-4,var(--primary))",
};

/** The pending ledger event every write adds (mockup `ev` with `pend`). */
export function pendingEvent(
	now: string,
	fields: Pick<HistoryEvent, "type" | "text"> &
		Partial<
			Pick<HistoryEvent, "kind" | "credits" | "amountCents" | "bookingId">
		>,
): HistoryEvent {
	return {
		at: now,
		kind: null,
		credits: null,
		amountCents: null,
		bookingId: null,
		promo: null,
		source: "you",
		...fields,
	};
}

/** The person's history: events on their way first, then the Reader's, as given. */
export const historyOf = (
	detail: MemberDetail,
	personId: string,
	changes: Change[],
): Array<{ event: HistoryEvent; pending: boolean }> => [
	...ledgerChanges(changes, personId)
		.reverse()
		.map(({ event }) => ({ event, pending: true })),
	...detail.history.map((event) => ({ event, pending: false })),
];

export function refundedOf(
	payment: RefundablePayment,
	changes: Change[],
): number {
	return changes.reduce(
		(sum, change) =>
			change.kind === "ledger" &&
			change.paymentIntentId === payment.paymentIntentId
				? sum - (change.event.amountCents ?? 0)
				: sum,
		payment.refundedCents,
	);
}

/** The payment rows with a refund on its way on top, and the payment it is for turned to Refunded or Partly
 * refunded (mockup `kLive`). */
export function paymentsOf(
	detail: MemberDetail,
	personId: string,
	changes: Change[],
	today: string,
): PaymentRow[] {
	const refunds = ledgerChanges(changes, personId)
		.filter(({ paymentIntentId }) => paymentIntentId !== null)
		.reverse();
	const refunded = (paymentId: string | null): number =>
		refunds.reduce(
			(sum, { paymentIntentId, event }) =>
				paymentIntentId === paymentId ? sum - (event.amountCents ?? 0) : sum,
			0,
		);
	return [
		...refunds.map(({ event, paymentIntentId }) => ({
			date: today,
			description: event.text,
			amountCents: event.amountCents ?? 0,
			status: "Open" as const,
			invoiceId: null,
			paymentId: paymentIntentId,
		})),
		...detail.payments.map((row) => {
			const pending = refunded(row.paymentId);
			if (pending === 0 || row.amountCents <= 0) return row;
			const already =
				detail.refundable.find(
					({ paymentIntentId }) => paymentIntentId === row.paymentId,
				)?.refundedCents ?? 0;
			return {
				...row,
				status:
					already + pending >= row.amountCents
						? ("Refunded" as const)
						: ("Partly refunded" as const),
			};
		}),
	];
}
