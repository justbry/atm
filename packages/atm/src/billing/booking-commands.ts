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
 *
 * What a release gives back (every way a booking is released: release, cancel, a late cancel or a no-show that releases,
 * an expired hold that releases). The units of each row the lock drew from go back to that row, except:
 * - units an invoice refunded or lost in a dispute while they were held is owed (`InvoiceRecord.owed`): taken back, booked
 *   `credit.adjusted`; a spend of them clears what is owed instead (they were used);
 * - units of a row that has lapsed (`expires_at` at or before the call), or that is gone: they lapsed while held, booked
 *   `credit.expired`; the row is not refilled, so the cron's lapse of it and the books agree in any order;
 * - units of a tier or add-on row that has reset since the hold (`BookingRecord.resetsAt`): last cycle's units, so they do
 *   not go to the new cycle. They come back as a rollover lapsing when last cycle's leftovers do, as far as the row's
 *   rollover rule (its catalog entitlement: months and cap, less the rollovers the row already holds) allows; the rest
 *   lapse (`credit.expired`). A row with no rollover lapses them all.
 * Units that do not come back are left off the lock the `finalize` settles, so the engine never puts them back; the events
 * book them as released, then expired or adjusted (`payload.withheld`).
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
	HoldLock,
	SettleBookingInput,
} from "../types.js";
import {
	CREDIT_ROWS,
	lockDeltasOf,
	ROLLOVER_ROWS,
	resetSinceHold,
	settleOwed,
} from "./booking-holds.js";
import { resolveEnv } from "./env.js";
import { addUtcMonths } from "./grants.js";
import { commandOrg, DEFAULT_POLICY } from "./policy.js";
import {
	applyRowChanges,
	diffRows,
	GRANTS_TABLE,
	grantsFromRows,
	grantsRow,
	rowChangesFromMutation,
	stateFromRows,
	subjectKey,
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

/** How the events of one engine command are booked. */
type EventsOf = Pick<
	AtmEventContext,
	"settleAs" | "service" | "held" | "reason" | "payload"
>;

/** A command run after the step's own in the same write (a release's units moved to a rollover). */
type FollowUp = {
	command: Record<string, unknown>;
	step: string;
	events: EventsOf;
};

type Step = {
	/** The engine command, without identity, time and ids (made here). */
	command: Record<string, unknown>;
	step: string;
	feature: string;
	/** How the events book a confirmed lock, and the units a `confirmExpiredLock` closed. */
	events: EventsOf;
	/** The booking record after the command (`before`: the state it ran on); the open lock row is `mutation`'s for a hold, else dropped. */
	next: (mutation: SubjectStateMutation, before: SubjectState) => BookingRecord;
	bookingId: string;
	followUps?: FollowUp[];
	/** The invoice records after the command, when it settles what a removed invoice is owed. */
	invoices?: GrantsState["invoices"];
	/** Decides the parts above from the subject's state as stored, when they depend on it (a release). */
	plan?: (state: SubjectState) => Partial<Step>;
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
	step: given,
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
	const step: Step = given.plan ? { ...given, ...given.plan(state) } : given;
	const catalog = toCatalog(input.catalog);
	const parts = [
		{ command: step.command, step: step.step, events: step.events },
		...(step.followUps ?? []),
	];
	const runs: {
		mutation: SubjectStateMutation;
		before: SubjectState;
		events: EventsOf;
	}[] = [];
	let current = state;
	for (const part of parts) {
		const command: Record<string, unknown> = {
			schemaVersion: 1,
			org: commandOrg(input.policy),
			commandId: commandIdOf(step.bookingId, part.step),
			requestId: commandIdOf(step.bookingId, part.step),
			identity,
			occurredAt: input.now,
			...part.command,
		};
		let run: ReturnType<typeof runOnState>;
		try {
			run = runOnState({ state: current, catalog, command });
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
		runs.push({ mutation, before: current, events: part.events });
		current = run.state as SubjectState;
	}

	const [first] = runs;
	if (!first) throw new Error("a booking step runs at least one command");
	const booking = step.next(first.mutation, first.before);
	const nextGrants: GrantsState = {
		...grants,
		...(step.invoices ? { invoices: step.invoices } : {}),
		bookings: { ...grants.bookings, [step.bookingId]: booking },
	};
	// The engine's rows after every command, as one write: the rows each mutation leaves, one revision step each.
	const initial = input.rows.filter((row) => row.table !== GRANTS_TABLE);
	let written = { rows: initial, revision: input.revision };
	for (const { mutation } of runs)
		written = applyRowChanges({
			...written,
			changes: rowChangesFromMutation({ mutation, ...written }),
		});
	const engine = diffRows(initial, written.rows);
	const rowChanges = {
		subjectKey: subjectKey(identity),
		expectedRevision: input.revision,
		nextRevision: written.revision,
		upserts: [...engine.upserts, grantsRow(nextGrants)],
		deletes: engine.deletes,
	};
	return {
		ok: true,
		rowChanges,
		events: runs.flatMap((run) => eventsOf({ input, identity, step, ...run })),
		booking,
	};
};

const eventsOf = ({
	input,
	mutation,
	before,
	identity,
	step,
	events: booked,
}: {
	input: BookingContext;
	mutation: SubjectStateMutation;
	before: SubjectState;
	identity: AtmIdentity;
	step: Step;
	events: EventsOf;
}): AtmEvent[] => {
	// `booking` is the caller's booking id (the engine's own label there would be the lock id).
	const labels = {
		menu_version: String(input.menuVersion),
		policy_version: String(input.policyVersion),
		mapping: BOOKING_MAPPING,
		booking: step.bookingId,
	};
	const { payload, ...rest } = booked;
	const events = mutationToEvents({
		mutation,
		context: {
			school: identity.orgId,
			tz: input.menu.timeZone,
			feature: step.feature,
			labels,
			// This write logs every command it runs, so a replay may step over a revision gap in the log.
			payload: { complete: true, ...payload },
			before: before as never,
			lowCreditThreshold: rulesOf(input.policy).lowCreditThreshold,
			...rest,
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

/** When each refilling row the lock drew from is due to reset, by row id; null when it drew from none. */
const resetsOf = (
	lock: HoldLock,
	before: SubjectState,
): Record<string, number> | null => {
	const resets: Record<string, number> = {};
	for (const delta of lockDeltasOf(lock)) {
		if (delta.table !== CREDIT_ROWS) continue;
		const row = before.customerEntitlements.find((r) => r.id === delta.id);
		if (typeof row?.next_reset_at === "number")
			resets[delta.id] = row.next_reset_at;
	}
	return Object.keys(resets).length > 0 ? resets : null;
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
			next: (mutation, before) => {
				const lock = lockInsertOf(mutation);
				if (!lock) throw new Error("a hold's track made no lock row");
				const resetsAt = resetsOf(lock, before);
				return {
					state: "held",
					cost: { kind: "credits", featureId, credits },
					startsAt,
					expiresAt,
					expiryAction,
					lock: jsonClone(lock),
					...(resetsAt ? { resetsAt } : {}),
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
		const { lock: _lock, resetsAt: _resetsAt, ...rest } = record;
		return { ...rest, state, settledAt: input.now, settledBy: intent.by };
	};
	const result = intent.action === "spend" ? "spent" : "released";
	const confirmsExpired = intent.call === "expiry" && intent.action === "spend";
	const finalize = (settled: HoldLock) => ({
		type: "finalize",
		lock: settled,
		internalFeatureId: `feat_${feature}`,
		finalValue: intent.action === "spend" ? null : 0,
		properties: null,
	});
	const step: Step = {
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
			: finalize(lock),
		next: () => settledRecord(result),
	};
	const executed = execute({
		input,
		grants,
		step:
			intent.action === "spend"
				? { ...step, invoices: spentOwed(grants, lock) }
				: {
						...step,
						plan: (state) => {
							const plan = releasePlan({ input, grants, record, state });
							return {
								command: finalize(plan.lock),
								events: plan.withheld
									? { ...step.events, payload: { withheld: plan.withheld } }
									: step.events,
								followUps: plan.rollovers.map(
									(rollover): FollowUp => ({
										step: `${intent.by}:rollover:${rollover.rowId}`,
										events: { reason: ROLLOVER_REASON },
										command: rolloverCommand(bookingId, rollover),
									}),
								),
								invoices: plan.invoices,
							};
						},
					},
	});
	if (!executed.ok || intent.call !== "cancel") return executed;
	return { ...executed, late: intent.late === true };
};

// ---- What a release gives back ----

const REFUND_REASON =
	"held credits of an invoice refunded or lost in a dispute while they were held";
const ROLLOVER_REASON =
	"released credits of a past cycle moved into a rollover of that cycle's leftovers";

type RolloverBack = { rowId: string; units: number; expiresAt: number };

type ReleasePlan = {
	/** The lock to finalize: only the units that come back to their rows. */
	lock: HoldLock;
	/** What does not come back, as the events book it; null when everything does. */
	withheld: { expired?: number; refunded?: number; reason?: string } | null;
	/** Units given back to a row that reset since the hold, moved on into a rollover of last cycle's leftovers. */
	rollovers: RolloverBack[];
	invoices: GrantsState["invoices"];
};

/** A spend keeps the held credits spent: what refunded invoices are owed on the lock's rows is settled by it. */
const spentOwed = (
	grants: GrantsState,
	lock: HoldLock,
): GrantsState["invoices"] => {
	let { invoices } = grants;
	for (const delta of lockDeltasOf(lock))
		({ invoices } = settleOwed({
			invoices,
			rowId: delta.id,
			units: delta.units,
		}));
	return invoices;
};

/** The lock's delta for `units` of what it took (credits are one per unit, so a share of each count). */
const deltaFor = (
	delta: Record<string, unknown>,
	took: number,
	units: number,
): Record<string, unknown> => {
	if (units === took) return delta;
	const share = (value: unknown) =>
		typeof value === "number" ? (value * units) / took : value;
	return {
		...delta,
		balanceDelta: share(delta.balanceDelta),
		usageDelta: share(delta.usageDelta),
		valueDelta: share(delta.valueDelta),
	};
};

type CatalogRollover = {
	max?: number | null;
	max_percentage?: number | null;
	duration?: string;
	length?: number;
};

/**
 * How many of `units` given back to a row that reset since the hold its rollover rule carries over, and when they lapse:
 * a rollover of the cycle that ended at the reset (`due`, the reset the hold saw coming) lapses `length` months later, and
 * the row's rollovers stay within the cap (`max`, or `max_percentage` of its refill at the product's quantity, as the
 * engine reads it). Nothing when the row has no rollover, when that rollover would already have lapsed, or the cap is full.
 */
const rolloverRoom = ({
	input,
	state,
	rowId,
	due,
	units,
	movedAlready,
}: {
	input: BookingContext;
	state: SubjectState;
	rowId: string;
	due: number;
	units: number;
	movedAlready: number;
}): { units: number; expiresAt: number } | null => {
	const row = state.customerEntitlements.find((r) => r.id === rowId);
	const entitlement = input.catalog.find(
		(entry) =>
			entry.table === "entitlements" && entry.row.id === row?.entitlement_id,
	)?.row;
	const rollover = entitlement?.rollover as CatalogRollover | null | undefined;
	if (
		!row ||
		!rollover ||
		rollover.duration !== "month" ||
		!Number.isSafeInteger(rollover.length)
	)
		return null;
	const expiresAt = addUtcMonths(due, rollover.length as number);
	if (expiresAt <= input.now) return null;
	const quantity =
		state.customerProducts.find((p) => p.id === row.customer_product_id)
			?.quantity ?? 1;
	const allowance = Number(entitlement?.allowance) || 0;
	const cap =
		typeof rollover.max_percentage === "number"
			? Math.floor(
					Number(
						((allowance * quantity * rollover.max_percentage) / 100).toFixed(6),
					),
				)
			: typeof rollover.max === "number"
				? rollover.max
				: Number.POSITIVE_INFINITY;
	const rolled = state.rollovers
		.filter(
			(r) =>
				r.cus_ent_id === rowId &&
				(r.expires_at === null || r.expires_at > input.now),
		)
		.reduce((sum, r) => sum + r.balance, 0);
	const room = Math.max(0, cap - rolled - movedAlready);
	const given = Math.min(units, room);
	return given > 0 ? { units: given, expiresAt } : null;
};

/** Which of the lock's units come back, and how the rest are booked (see the file header). */
const releasePlan = ({
	input,
	grants,
	record,
	state,
}: {
	input: BookingContext;
	grants: GrantsState;
	record: BookingRecord;
	state: SubjectState;
}): ReleasePlan => {
	const lock = record.lock as HoldLock;
	const deltas = (lock.deltas as Record<string, unknown>[] | undefined) ?? [];
	let { invoices } = grants;
	let expired = 0;
	let refunded = 0;
	const rollovers: RolloverBack[] = [];
	const kept: Record<string, unknown>[] = [];
	for (const delta of deltas) {
		const [taken] = lockDeltasOf({ deltas: [delta] });
		if (!taken) {
			kept.push(delta);
			continue;
		}
		const owed = settleOwed({
			invoices,
			rowId: taken.id,
			units: taken.units,
		});
		invoices = owed.invoices;
		refunded += owed.settled;
		let back = taken.units - owed.settled;
		if (back > 0) {
			const row =
				taken.table === CREDIT_ROWS
					? state.customerEntitlements.find((r) => r.id === taken.id)
					: taken.table === ROLLOVER_ROWS
						? state.rollovers.find((r) => r.id === taken.id)
						: undefined;
			const known =
				taken.table === CREDIT_ROWS || taken.table === ROLLOVER_ROWS;
			const lapsed =
				known &&
				(!row ||
					(row.expires_at !== null &&
						row.expires_at !== undefined &&
						row.expires_at <= input.now));
			const reset =
				!lapsed &&
				taken.table === CREDIT_ROWS &&
				resetSinceHold({
					record,
					rowId: taken.id,
					nextResetAt: (row as { next_reset_at?: number | null } | undefined)
						?.next_reset_at,
					now: input.now,
				});
			if (lapsed) {
				expired += back;
				back = 0;
			} else if (reset) {
				const moved = rollovers
					.filter((r) => r.rowId === taken.id)
					.reduce((sum, r) => sum + r.units, 0);
				const room = rolloverRoom({
					input,
					state,
					rowId: taken.id,
					due: record.resetsAt?.[taken.id] as number,
					units: back,
					movedAlready: moved,
				});
				expired += back - (room?.units ?? 0);
				back = room?.units ?? 0;
				if (room) rollovers.push({ rowId: taken.id, ...room });
			}
		}
		if (back > 0) kept.push(deltaFor(delta, taken.units, back));
	}
	const withheld =
		expired > 0 || refunded > 0
			? {
					...(expired > 0 ? { expired } : {}),
					...(refunded > 0 ? { refunded, reason: REFUND_REASON } : {}),
				}
			: null;
	return {
		lock: withheld ? { ...lock, deltas: kept } : lock,
		withheld,
		rollovers,
		invoices,
	};
};

/**
 * Moves units a release gave back to a row that reset since the hold into a rollover of the row: off the new cycle's
 * balance, onto last cycle's leftovers, lapsing when they do. One rollover per booking and row, named from both.
 */
const rolloverCommand = (
	bookingId: string,
	rollover: RolloverBack,
): Record<string, unknown> => ({
	type: "applyBillingPlan",
	entityIds: [],
	expiringPooledBalanceIds: [],
	ops: [
		{
			op: "increment",
			table: CREDIT_ROWS,
			id: rollover.rowId,
			add: { balance: -rollover.units },
		},
		{
			op: "insert",
			table: ROLLOVER_ROWS,
			row: {
				id: `roll_${lockIdOf(bookingId)}_${rollover.rowId}`,
				cus_ent_id: rollover.rowId,
				balance: rollover.units,
				usage: 0,
				expires_at: rollover.expiresAt,
				entities: {},
			},
		},
	],
});

/** Spends what the booking holds (the session happened). */
export const confirmBooking = (input: SettleBookingInput): BookingResult =>
	settle(input, () => ({ action: "spend", by: "confirm", call: "confirm" }));

/** Gives back what the booking holds. */
export const releaseBooking = (input: SettleBookingInput): BookingResult =>
	settle(input, () => ({ action: "release", by: "release", call: "release" }));

/**
 * A member's cancel: released before the cutoff, `policy.lateCancel` between the cutoff and the start. From `startsAt` on
 * it is `session_started`: a session that has started is not cancelled (a no-show is `noShowBooking`). A cancel that
 * settled the booking earlier replays as it settled.
 */
export const cancelBooking = (input: SettleBookingInput): BookingResult =>
	settle(input, (record) => {
		if (
			record.state === "held" &&
			record.startsAt !== null &&
			input.now >= record.startsAt
		)
			return refuse(
				"session_started",
				`booking ${input.bookingId}'s session started at ${String(record.startsAt)}: it cannot be cancelled now; settle it with noShowBooking (or confirmBooking)`,
			);
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
