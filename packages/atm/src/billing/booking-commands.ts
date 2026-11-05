/**
 * The commands of a bookable item that run on a subject's stored rows: hold credits on an engine lock, then spend them or give
 * them back. Each takes the rows and revision as stored (as `handleStripeEvent` does) and returns one write for the subject
 * (the engine's rows and the grants row under one revision) with the ledger events, or a typed refusal. Pure: no clock, no
 * randomness; every id is made from the booking id.
 *
 * Engine mapping: hold is `track` with a lock, settle is `finalize` (`finalValue` null spends what the lock took, 0 gives it
 * back) and an expired hold that confirms is `confirmExpiredLock`. `commandOrg(policy)` is on every command that draws, so
 * the row that lapses soonest is drawn first and a release returns the credits to the rows they came from.
 *
 * The engine's stored rows keep only an open lock's ids, and `finalize` needs the whole lock row, so the row is kept in
 * `GrantsState.bookings[id].lock` until the booking is settled.
 *
 * A hold whose `expiresAt` has passed (the lock's own expiry action is not run by the engine; a caller's sweep applies it
 * with `settleExpiredHold`): a call that would do what the expiry action does (spend on a `confirm` hold, give back on a
 * `release` hold) still works, with the caller's own `settledBy`; a call that would do the opposite is `hold_expired`.
 */
import type {
	SubjectState,
	SubjectStateMutation,
} from "@autumn/balance-engine";
import { mutationToEvents, planChangedEvent } from "../ledger/postings.js";
import { runOnState, toCatalog } from "../ledger/run.js";
import type {
	AtmEvent,
	AtmEventContext,
	AtmIdentity,
	BillingPolicy,
	BillingRow,
	BookingContext,
	BookingCost,
	BookingRecord,
	BookingRefusal,
	BookingRefusalReason,
	BookingResult,
	ExpiredHold,
	GrantsState,
	HoldBookingInput,
	SettleBookingInput,
} from "../types.js";
import { resolveEnv } from "./env.js";
import { commandOrg, DEFAULT_POLICY } from "./policy.js";
import {
	grantsFromRows,
	grantsRow,
	rowChangesFromMutation,
	stateFromRows,
} from "./rows.js";

const MS_PER_HOUR = 3_600_000;
/** The `credits:spent:<service>` account a confirmed booking is booked to: atm knows the feature, not the caller's booking type. */
const BOOKING_SERVICE = "booking";
const BOOKING_MAPPING = "atm/booking";

type Action = "spend" | "release";
type SettledBy = NonNullable<BookingRecord["settledBy"]>;
type Expiry = "confirm" | "release";
type CreditCost = Extract<BookingCost, { kind: "credits" }>;

const refuse = (
	reason: BookingRefusalReason,
	message: string,
): BookingRefusal => ({ ok: false, reason, message });

/** The booking rules of a policy; one stored before the fields existed gets the defaults. */
const rulesOf = (policy: BillingPolicy) => ({
	cancelCutoffHours:
		policy.cancelCutoffHours ?? DEFAULT_POLICY.cancelCutoffHours,
	noShow: policy.noShow ?? DEFAULT_POLICY.noShow,
	lateCancel: policy.lateCancel ?? DEFAULT_POLICY.lateCancel,
	lowCreditThreshold:
		policy.lowCreditThreshold ?? DEFAULT_POLICY.lowCreditThreshold,
});

const expiryOf = (action: Action): Expiry =>
	action === "spend" ? "confirm" : "release";
const actionOf = (expiry: Expiry): Action =>
	expiry === "confirm" ? "spend" : "release";

/** What a held record's lock does at its expiry; the record names it, the lock row is the fallback. */
const recordExpiry = (record: BookingRecord): Expiry => {
	if (record.expiryAction) return record.expiryAction;
	return record.lock?.expiry_action === "confirm" ? "confirm" : "release";
};

const lockIdOf = (bookingId: string) => `bk_${bookingId}`;
const lockRowIdOf = (bookingId: string) => `lock_${bookingId}`;
const commandIdOf = (bookingId: string, step: string) =>
	`bk:${bookingId}:${step}`;

const isCredits = (cost: BookingCost): cost is CreditCost =>
	cost.kind === "credits";

const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ---- Running one engine command ----

type Step = {
	/** The engine command, without identity, time and ids (made here). */
	command: Record<string, unknown>;
	step: string;
	feature: string;
	/** How the events book a confirmed lock, and the units a `confirmExpiredLock` closed. */
	events: Pick<AtmEventContext, "settleAs" | "service" | "held">;
	/** The booking record after the command; the open lock row is `mutation`'s for a hold, else dropped. */
	next: (mutation: SubjectStateMutation) => BookingRecord;
	bookingId: string;
};

const lockInsertOf = (mutation: SubjectStateMutation) => {
	const change = mutation.changes.find(
		(c) => c.table === "locks" && c.op === "insert",
	);
	return change && change.op === "insert"
		? (change.row as Record<string, unknown>)
		: null;
};

/** The engine's own refusals that mean something to a booking; matched by name, the engine's classes are not exported. */
const engineRefusal = (error: unknown, step: Step): BookingRefusal | null => {
	if (!(error instanceof Error)) return null;
	if (error.name === "LockNotFoundError")
		return refuse(
			"no_hold",
			`the engine holds no open lock for booking ${step.bookingId}: the stored rows and the booking record disagree`,
		);
	if (error.name === "LockAlreadyExistsError")
		return refuse(
			"booking_conflict",
			`the engine already holds an open lock ${lockIdOf(step.bookingId)} that no booking record names`,
		);
	const reason = (error as Error & { reason?: unknown }).reason;
	if (
		error.name === "UnsupportedCommandError" &&
		reason === "feature_not_found"
	)
		return refuse(
			"feature_not_in_plan",
			`the holder has no credits of ${step.feature}`,
		);
	return null;
};

const execute = ({
	input,
	grants,
	step,
}: {
	input: BookingContext;
	grants: GrantsState;
	step: Step;
}): BookingResult => {
	const holder = grants.identity;
	if (!holder)
		return refuse("not_a_member", "the holder has no credits to book with");
	const identity: AtmIdentity = {
		orgId: holder.orgId,
		env: resolveEnv(input.env),
		customerId: holder.customerId,
		entityId: null,
	};
	const state = stateFromRows({
		identity,
		revision: input.revision,
		rows: input.rows,
	});
	if (!state)
		return refuse("not_a_member", "the holder has no credits to book with");
	const command: Record<string, unknown> = {
		schemaVersion: 1,
		org: commandOrg(input.policy),
		commandId: commandIdOf(step.bookingId, step.step),
		requestId: commandIdOf(step.bookingId, step.step),
		identity,
		occurredAt: input.now,
		...step.command,
	};
	let run: ReturnType<typeof runOnState>;
	try {
		run = runOnState({
			state,
			catalog: toCatalog(input.catalog),
			command,
		});
	} catch (error) {
		const refusal = engineRefusal(error, step);
		if (refusal) return refusal;
		throw error;
	}
	const { mutation } = run;
	if (!mutation) throw new Error(`${String(command.type)} decided nothing`);
	const status = (mutation.result as { status?: string } | undefined)?.status;
	if (status === "rejected")
		return refuse(
			"insufficient_credits",
			`the engine rejected ${String(command.type)} ${command.commandId}: not enough ${step.feature} to spend`,
		);

	const booking = step.next(mutation);
	const nextGrants: GrantsState = {
		...grants,
		bookings: { ...grants.bookings, [step.bookingId]: booking },
	};
	const changes = rowChangesFromMutation({
		mutation,
		rows: input.rows,
		revision: input.revision,
	});
	const rowChanges = {
		...changes,
		upserts: [...changes.upserts, grantsRow(nextGrants)],
	};
	return {
		ok: true,
		rowChanges,
		events: eventsOf({ input, mutation, state, identity, step }),
		booking,
	};
};

const eventsOf = ({
	input,
	mutation,
	state,
	identity,
	step,
}: {
	input: BookingContext;
	mutation: SubjectStateMutation;
	state: SubjectState;
	identity: AtmIdentity;
	step: Step;
}): AtmEvent[] => {
	const labels = {
		menu_version: String(input.menuVersion),
		policy_version: String(input.policyVersion),
		mapping: BOOKING_MAPPING,
	};
	const events = mutationToEvents({
		mutation,
		context: {
			school: identity.orgId,
			tz: input.menu.timeZone,
			feature: step.feature,
			labels,
			// This write logs every command it runs, so a replay may step over a revision gap in the log.
			payload: { complete: true },
			before: state as never,
			lowCreditThreshold: rulesOf(input.policy).lowCreditThreshold,
			...step.events,
		},
	});
	if (events.length > 0) return events;
	return [
		planChangedEvent({
			mutation,
			tz: input.menu.timeZone,
			labels,
			complete: true,
		}),
	];
};

// ---- Hold ----

const sameHold = (record: BookingRecord, input: HoldBookingInput): boolean =>
	isCredits(record.cost) &&
	record.cost.featureId === input.featureId &&
	record.cost.credits === input.credits &&
	record.startsAt === input.startsAt &&
	record.expiresAt === input.expiresAt;

const badHold = (input: HoldBookingInput): BookingRefusal | null => {
	const { bookingId, featureId, credits, startsAt, expiresAt, now } = input;
	if (typeof bookingId !== "string" || bookingId === "")
		return refuse("bad_input", "bookingId must be a non-empty string");
	if (!input.menu.features.some((f) => f.id === featureId))
		return refuse(
			"bad_input",
			`featureId ${JSON.stringify(featureId)} is not a feature of the menu`,
		);
	if (!Number.isSafeInteger(credits) || credits < 1)
		return refuse("bad_input", "credits must be a whole number of 1 or more");
	if (![startsAt, expiresAt, now].every(Number.isFinite))
		return refuse(
			"bad_input",
			"startsAt, expiresAt and now must be times (ms)",
		);
	if (expiresAt < startsAt)
		return refuse(
			"bad_input",
			"the hold lapses before the session starts (expiresAt is before startsAt)",
		);
	return null;
};

/** Holds the booking's credits on a lock. */
export const holdBooking = (input: HoldBookingInput): BookingResult => {
	const invalid = badHold(input);
	if (invalid) return invalid;
	const { bookingId, featureId, credits, startsAt, expiresAt, now } = input;
	const grants = grantsFromRows(input.rows);
	const known = grants.bookings?.[bookingId];
	if (known)
		return sameHold(known, input)
			? { ok: true, rowChanges: null, events: [], booking: known }
			: refuse(
					"booking_conflict",
					`booking ${bookingId} is already ${known.state} with other fields (${JSON.stringify(known.cost)}, starts ${String(known.startsAt)}, expires ${String(known.expiresAt)})`,
				);
	if (expiresAt <= now)
		return refuse("bad_input", "expiresAt must be after the time of the call");

	const expiryAction = expiryOf(
		rulesOf(input.policy).noShow === "spend" ? "spend" : "release",
	);
	return execute({
		input,
		grants,
		step: {
			bookingId,
			step: "hold",
			feature: featureId,
			events: {},
			command: {
				type: "track",
				featureId,
				internalFeatureId: `feat_${featureId}`,
				value: credits,
				overageBehavior: "reject",
				enforceOverdueBlock: true,
				properties: null,
				usageEvent: null,
				lock: {
					id: lockRowIdOf(bookingId),
					lockId: lockIdOf(bookingId),
					expiresAt,
					expiryAction,
				},
			},
			next: (mutation) => {
				const lock = lockInsertOf(mutation);
				if (!lock) throw new Error("a hold's track made no lock row");
				return {
					state: "held",
					cost: { kind: "credits", featureId, credits },
					startsAt,
					expiresAt,
					expiryAction,
					lock: jsonClone(lock),
					heldAt: now,
				};
			},
		},
	});
};

// ---- Settling ----

type Intent = {
	action: Action;
	by: SettledBy;
	/** The call: a cancel's replay is judged on how it settled, not on the clock of the replay. */
	call: "confirm" | "release" | "cancel" | "no_show" | "expiry";
	late?: boolean;
	/** How the events book a spend: `confirm` is `spent`, the rest are credits the holder forfeits. */
	forfeits?: boolean;
};

const sameSettled = (record: BookingRecord, intent: Intent): boolean => {
	if (intent.call === "cancel")
		return record.state === "released" || record.settledBy === "late_cancel";
	return record.state === (intent.action === "spend" ? "spent" : "released");
};

const settledResult = (
	record: BookingRecord,
	intent: Intent,
	bookingId: string,
): BookingResult => {
	if (!sameSettled(record, intent))
		return refuse(
			"already_settled",
			`booking ${bookingId} is already ${record.state}${record.settledBy ? ` (${record.settledBy})` : ""}; this call would ${intent.action} it`,
		);
	return {
		ok: true,
		rowChanges: null,
		events: [],
		booking: record,
		...(intent.call === "cancel"
			? { late: record.settledBy === "late_cancel" }
			: {}),
	};
};

type Decide = (
	record: BookingRecord & { cost: CreditCost },
	input: SettleBookingInput,
) => Intent | BookingRefusal;

const isExpired = (record: BookingRecord, now: number) =>
	record.expiresAt !== null && record.expiresAt <= now;

const settle = (input: SettleBookingInput, decide: Decide): BookingResult => {
	const { bookingId } = input;
	if (typeof bookingId !== "string" || bookingId === "")
		return refuse("bad_input", "bookingId must be a non-empty string");
	const grants = grantsFromRows(input.rows);
	const record = grants.bookings?.[bookingId];
	if (!record)
		return refuse("no_hold", `nothing is held for booking ${bookingId}`);
	if (
		!isCredits(record.cost) ||
		record.state === "paid" ||
		record.state === "refunded"
	)
		return refuse(
			"not_credits",
			`booking ${bookingId} is not a credits booking (${record.state}, ${record.cost.kind})`,
		);
	const credited = record as BookingRecord & { cost: CreditCost };
	const intent = decide(credited, input);
	if ("ok" in intent) return intent;
	if (record.state !== "held") return settledResult(record, intent, bookingId);

	const expiry = recordExpiry(record);
	if (
		isExpired(record, input.now) &&
		intent.call !== "expiry" &&
		intent.action !== actionOf(expiry)
	)
		return refuse(
			"hold_expired",
			`booking ${bookingId}'s hold lapsed at ${String(record.expiresAt)} and its expiry action is ${expiry}: use settleExpiredHold (this call would ${intent.action})`,
		);
	if (!record.lock)
		return refuse(
			"no_hold",
			`booking ${bookingId} is held but its record has no lock row`,
		);
	const { cost } = credited;
	const { lock } = record;
	const feature = cost.featureId;
	const settledRecord = (state: "spent" | "released"): BookingRecord => {
		const { lock: _lock, ...rest } = record;
		return { ...rest, state, settledAt: input.now, settledBy: intent.by };
	};
	const result = intent.action === "spend" ? "spent" : "released";
	const confirmsExpired = intent.call === "expiry" && intent.action === "spend";
	const executed = execute({
		input,
		grants,
		step: {
			bookingId,
			step: intent.by,
			feature,
			events:
				intent.action === "spend" && !intent.forfeits
					? { settleAs: "spent", service: BOOKING_SERVICE }
					: {
							settleAs: "forfeited",
							...(confirmsExpired ? { held: cost.credits } : {}),
						},
			command: confirmsExpired
				? {
						type: "confirmExpiredLock",
						lock: { id: lock.id, lock_id: lock.lock_id },
					}
				: {
						type: "finalize",
						lock,
						internalFeatureId: `feat_${feature}`,
						finalValue: intent.action === "spend" ? null : 0,
						properties: null,
					},
			next: () => settledRecord(result),
		},
	});
	if (!executed.ok || intent.call !== "cancel") return executed;
	return { ...executed, late: intent.late === true };
};

/** Spends what the booking holds (the session happened). */
export const confirmBooking = (input: SettleBookingInput): BookingResult =>
	settle(input, () => ({ action: "spend", by: "confirm", call: "confirm" }));

/** Gives back what the booking holds. */
export const releaseBooking = (input: SettleBookingInput): BookingResult =>
	settle(input, () => ({ action: "release", by: "release", call: "release" }));

/** A member's cancel: released before the cutoff, `policy.lateCancel` after it. */
export const cancelBooking = (input: SettleBookingInput): BookingResult =>
	settle(input, (record) => {
		const rules = rulesOf(input.policy);
		const cutoff =
			record.startsAt === null
				? Number.POSITIVE_INFINITY
				: record.startsAt - rules.cancelCutoffHours * MS_PER_HOUR;
		if (input.now <= cutoff)
			return { action: "release", by: "cancel", call: "cancel", late: false };
		return {
			action: rules.lateCancel === "spend" ? "spend" : "release",
			by: "late_cancel",
			call: "cancel",
			late: true,
			forfeits: true,
		};
	});

/** The session passed without the member: `policy.noShow`. */
export const noShowBooking = (input: SettleBookingInput): BookingResult =>
	settle(input, () => ({
		action: rulesOf(input.policy).noShow === "spend" ? "spend" : "release",
		by: "no_show",
		call: "no_show",
		forfeits: true,
	}));

/** The holds whose expiry has passed and nobody settled, soonest first. */
export const expiredHolds = ({
	rows,
	now,
}: {
	rows: readonly BillingRow[];
	now: number;
}): ExpiredHold[] =>
	Object.entries(grantsFromRows(rows).bookings ?? {})
		.flatMap(([bookingId, record]) =>
			record.state === "held" &&
			isCredits(record.cost) &&
			record.expiresAt !== null &&
			record.expiresAt <= now
				? [
						{
							bookingId,
							expiresAt: record.expiresAt,
							expiryAction: recordExpiry(record),
							featureId: record.cost.featureId,
							credits: record.cost.credits,
						},
					]
				: [],
		)
		.sort(
			(a, b) =>
				a.expiresAt - b.expiresAt ||
				(a.bookingId < b.bookingId ? -1 : a.bookingId > b.bookingId ? 1 : 0),
		);

/** Applies an expired hold's own expiry action: `confirm` keeps it spent, `release` gives it back. */
export const settleExpiredHold = (input: SettleBookingInput): BookingResult =>
	settle(input, (record) => {
		if (record.state === "held" && !isExpired(record, input.now))
			return refuse(
				"bad_input",
				`booking ${input.bookingId}'s hold lapses at ${String(record.expiresAt)}, after the time of the call`,
			);
		const action = actionOf(recordExpiry(record));
		return { action, by: "expiry", call: "expiry", forfeits: true };
	});
