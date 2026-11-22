// SPDX-License-Identifier: Apache-2.0
/**
 * The two-party statement (spec R-10 to R-16, R-19). One validated event stream gives two counts of the loan, the
 * lender's and the borrower's. A fact that hurts the party who recorded it counts in both views at once; a fact that
 * helps its recorder counts in the recorder's view only until the other party answers. No timer ever changes a number.
 */

import type { CountedPayment } from "./accrual";
import {
	comparePayments,
	daysOverdue,
	expectedDueToDate,
	replayBalance,
} from "./accrual";
import { compareDates, daysBetween } from "./date";
import { validateStream } from "./events";
import { formatMinor, maxBigint, minBigint, parseMinor } from "./money";
import { generateSchedule } from "./schedule";
import {
	type Balance,
	type CivilDate,
	type DifferenceItem,
	ENGINE_VERSION,
	type NoteCreatedEvent,
	type NoteEvent,
	type PaymentDisputedEvent,
	type PaymentRecordedEvent,
	type PaymentResolvedEvent,
	type PaymentStatus,
	type Role,
	type Statement,
} from "./types";

const DATE_LENGTH = 10;

/** What the events say about one recorded payment: nothing yet, confirmed, disputed, or resolved by both parties. */
type Decision =
	| { kind: "confirmed" }
	| { kind: "disputed"; dispute: PaymentDisputedEvent }
	| {
			kind: "resolved";
			dispute: PaymentDisputedEvent;
			agreedMinor: bigint;
	  };

/** A dispute still open on one payment, with the latest `payment.resolved` each role has filed since it. */
interface OpenDispute {
	dispute: PaymentDisputedEvent;
	filed: Map<Role, PaymentResolvedEvent>;
}

const STATUS_LABELS: Record<PaymentStatus, string> = {
	confirmed: "confirmed by both parties",
	"claimed-by-lender": "claimed by lender",
	"claimed-by-borrower": "claimed by borrower",
	disputed: "disputed",
	resolved: "resolved by agreement",
	reversed: "reversed",
};

/** Plain wording for a payment's status (R-19). Never reads as proof. */
export const statusLabel = (status: PaymentStatus): string =>
	STATUS_LABELS[status];

/** The agreed amount when both roles have filed a resolution for the same amount, else undefined. */
const matchingResolution = (open: OpenDispute): bigint | undefined => {
	const lender = open.filed.get("lender");
	const borrower = open.filed.get("borrower");
	if (lender === undefined || borrower === undefined) {
		return undefined;
	}
	const agreed = parseMinor(lender.agreed_amount_minor);
	return agreed === parseMinor(borrower.agreed_amount_minor)
		? agreed
		: undefined;
};

/**
 * Each payment's decision, from the confirmations, disputes and resolutions in seq order (R-11, R-12). The latest of
 * confirm, dispute and resolution decides. A confirmation withdraws any dispute, so a resolution filed after it has no
 * dispute to settle and is ignored. A dispute opens afresh, forgetting resolutions filed before it. A resolution takes
 * effect only while both roles' latest filings since the last dispute name the same amount; otherwise the dispute
 * stands. `events` must be in seq order.
 */
const decisionsFor = (events: NoteEvent[]): Map<string, Decision> => {
	const decisions = new Map<string, Decision>();
	const open = new Map<string, OpenDispute>();
	for (const event of events) {
		if (event.type === "payment.confirmed") {
			decisions.set(event.target, { kind: "confirmed" });
			open.delete(event.target);
		} else if (event.type === "payment.disputed") {
			decisions.set(event.target, { kind: "disputed", dispute: event });
			open.set(event.target, { dispute: event, filed: new Map() });
		} else if (event.type === "payment.resolved") {
			const standing = open.get(event.target);
			if (standing === undefined) {
				continue;
			}
			standing.filed.set(event.entered_by, event);
			const agreedMinor = matchingResolution(standing);
			decisions.set(
				event.target,
				agreedMinor === undefined
					? { kind: "disputed", dispute: standing.dispute }
					: { kind: "resolved", dispute: standing.dispute, agreedMinor },
			);
		}
	}
	return decisions;
};

/** A payment recorded by the lender or a reversal recorded by the borrower hurts the party who recorded it. */
const isAgainstInterest = (event: PaymentRecordedEvent): boolean =>
	(event.kind === "payment" && event.entered_by === "lender") ||
	(event.kind === "reversal" && event.entered_by === "borrower");

/** What `view` counts for one recorded event on its own, before a reversal is matched to its target (R-10, R-11). */
const rawCount = (
	event: PaymentRecordedEvent,
	decision: Decision | undefined,
	view: Role,
): bigint => {
	const amount = parseMinor(event.amount_minor);
	if (decision === undefined) {
		if (view === event.entered_by || isAgainstInterest(event)) {
			return amount;
		}
		return 0n;
	}
	if (decision.kind === "confirmed") {
		return amount;
	}
	if (decision.kind === "resolved") {
		return decision.agreedMinor;
	}
	return view === decision.dispute.entered_by
		? parseMinor(decision.dispute.counter_amount_minor)
		: amount;
};

/** What one view counts: a figure per recorded event, and the reversals it counts by the payment they undo. */
interface ViewCounts {
	/** A payment's counted amount; for a counted reversal, minus the amount of the payment it undoes (display only). */
	counts: Map<string, bigint>;
	/** Reversals this view counts, keyed by the id of the payment each undoes. */
	reversals: Map<string, PaymentRecordedEvent>;
}

/**
 * What `view` counts for every recorded event (R-9a, R-10). A reversal counts only when the view counts it and also
 * counts its target payment; it then undoes that whole payment. A reversal the view does not count, or one whose target
 * the view does not count, has no effect there.
 */
const countsForView = (
	recorded: PaymentRecordedEvent[],
	decisions: Map<string, Decision>,
	view: Role,
): ViewCounts => {
	const counts = new Map<string, bigint>();
	const reversals = new Map<string, PaymentRecordedEvent>();
	for (const event of recorded) {
		const raw = rawCount(event, decisions.get(event.id), view);
		if (event.kind === "payment") {
			counts.set(event.id, raw);
			continue;
		}
		const targetCount =
			event.reverses === undefined ? 0n : (counts.get(event.reverses) ?? 0n);
		if (raw > 0n && targetCount > 0n && event.reverses !== undefined) {
			reversals.set(event.reverses, event);
			counts.set(event.id, -targetCount);
		} else {
			counts.set(event.id, 0n);
		}
	}
	return { counts, reversals };
};

/**
 * The payments `view` applies on `asOf`: every payment it counts, except one undone by a reversal the view counts and
 * whose value date is on or before `asOf`. Before that date the payment still applies. A reversal is never a payment
 * itself, so the interest a reversed payment covered accrues again as if it had never been made.
 */
const toCountedPayments = (
	recorded: PaymentRecordedEvent[],
	view: ViewCounts,
	asOf: CivilDate,
): CountedPayment[] => {
	const counted: CountedPayment[] = [];
	for (const event of recorded) {
		if (event.kind !== "payment") {
			continue;
		}
		const amount = view.counts.get(event.id) ?? 0n;
		const reversal = view.reversals.get(event.id);
		const isUndone =
			reversal !== undefined && compareDates(reversal.value_date, asOf) <= 0;
		if (amount > 0n && !isUndone) {
			counted.push({
				id: event.id,
				value_date: event.value_date,
				amount_minor: amount,
				seq: event.seq,
			});
		}
	}
	return counted;
};

const unansweredDays = (event: PaymentRecordedEvent, asOf: CivilDate): number =>
	Math.max(0, daysBetween(event.entered_at.slice(0, DATE_LENGTH), asOf));

const differenceItem = (
	event: PaymentRecordedEvent,
	decision: Decision | undefined,
	lenderCount: bigint,
	borrowerCount: bigint,
	asOf: CivilDate,
): DifferenceItem => {
	const base = {
		event_id: event.id,
		value_date: event.value_date,
	};
	const amounts = {
		lender_counts_minor: formatMinor(lenderCount),
		borrower_counts_minor: formatMinor(borrowerCount),
		difference_minor: formatMinor(lenderCount - borrowerCount),
	};
	const item = ((): DifferenceItem => {
		if (decision === undefined) {
			return {
				...base,
				status: `claimed-by-${event.entered_by}`,
				...amounts,
				unanswered_days: unansweredDays(event, asOf),
			};
		}
		if (decision.kind === "disputed") {
			return {
				...base,
				status: "disputed",
				...amounts,
				unanswered_days: null,
				reason: decision.dispute.reason,
			};
		}
		// A confirmed or resolved reversal can still differ when its target is counted in only one view.
		return {
			...base,
			status: decision.kind === "confirmed" ? "confirmed" : "resolved",
			...amounts,
			unanswered_days: null,
		};
	})();
	return event.source === undefined ? item : { ...item, source: event.source };
};

const isRecorded = (event: NoteEvent): event is PaymentRecordedEvent =>
	event.type === "payment.recorded";

const noteCreated = (events: NoteEvent[]): NoteCreatedEvent => {
	const [first] = events;
	if (first === undefined || first.type !== "note.created") {
		throw new Error("The first event must be note.created");
	}
	return first;
};

/**
 * One view's overdue amount (R-16): what is due to date less what that view counts as paid, when positive, and never
 * more than the view's payoff. A paid-off view owes nothing, so it is never overdue (its payoff is 0).
 */
const overdueFor = (dueToDate: bigint, paid: bigint, view: Balance): bigint =>
	minBigint(maxBigint(0n, dueToDate - paid), parseMinor(view.payoff_minor));

/**
 * The statement of a note on `asOf`: the schedule, the lender's and the borrower's balance, the payments the two
 * views count differently, and expected-versus-paid for each view. A pure function of the events and the date.
 * Throws when the stream is invalid or `asOf` is before the issue date.
 */
export const statement = (events: unknown[], asOf: CivilDate): Statement => {
	const ordered = validateStream(events);
	const created = noteCreated(ordered);
	const { terms } = created;
	const schedule = generateSchedule(terms);
	const recorded = ordered.filter(isRecorded);
	const decisions = decisionsFor(ordered);
	const lenderView = countsForView(recorded, decisions, "lender");
	const borrowerView = countsForView(recorded, decisions, "borrower");
	const lender = replayBalance(
		terms,
		toCountedPayments(recorded, lenderView, asOf),
		asOf,
	);
	const borrower = replayBalance(
		terms,
		toCountedPayments(recorded, borrowerView, asOf),
		asOf,
	);

	const difference: DifferenceItem[] = [];
	for (const event of [...recorded].sort(comparePayments)) {
		if (compareDates(event.value_date, asOf) > 0) {
			continue;
		}
		const lenderCount = lenderView.counts.get(event.id) ?? 0n;
		const borrowerCount = borrowerView.counts.get(event.id) ?? 0n;
		if (lenderCount === borrowerCount) {
			continue;
		}
		difference.push(
			differenceItem(
				event,
				decisions.get(event.id),
				lenderCount,
				borrowerCount,
				asOf,
			),
		);
	}

	const dueToDate = expectedDueToDate(schedule, asOf);
	const lenderPaid = parseMinor(lender.paid_minor);
	const borrowerPaid = parseMinor(borrower.paid_minor);
	const lenderOverdue = overdueFor(dueToDate, lenderPaid, lender);
	const borrowerOverdue = overdueFor(dueToDate, borrowerPaid, borrower);
	return {
		engine_version: ENGINE_VERSION,
		note_id: created.note_id,
		currency: terms.currency,
		exponent: terms.exponent,
		as_of: asOf,
		schedule,
		lender,
		borrower,
		difference,
		payoff_gap_minor: formatMinor(
			parseMinor(lender.payoff_minor) - parseMinor(borrower.payoff_minor),
		),
		expected: {
			due_to_date_minor: formatMinor(dueToDate),
			lender_paid_minor: formatMinor(lenderPaid),
			borrower_paid_minor: formatMinor(borrowerPaid),
			lender_overdue_minor: formatMinor(lenderOverdue),
			borrower_overdue_minor: formatMinor(borrowerOverdue),
			lender_days_overdue:
				lenderOverdue === 0n ? 0 : daysOverdue(schedule, lenderPaid, asOf),
			borrower_days_overdue:
				borrowerOverdue === 0n ? 0 : daysOverdue(schedule, borrowerPaid, asOf),
		},
	};
};
