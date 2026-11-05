/**
 * A what-if on the grant rules, from stored inputs (`atm simulate --inputs`). The Stripe inputs the handler stored
 * (`atm_event_inputs`, see `src/handler/inputs.ts`) are decided again through `handleStripeFact`, with the menu and policy
 * in force when each was handled (the baseline) and then with a candidate (the candidate), and the two are set against the
 * log. Design and decisions: `docs/simulate-from-inputs.md`. The 0.6.0 command-level mode is `simulate.ts`, unchanged.
 *
 * One replay (`replayInputs`) is the driver both sides use:
 *   - the inputs go in `applied_order`, the order the handler applied them in (not Stripe's `created`), and each runs at
 *     its own `created * 1000`; no clock is read;
 *   - the holder starts from its seed (its rows before its first stored input) or from nothing, and its two index
 *     tables (invoice to holder, payment ref to invoice) are rebuilt in the order of replay;
 *   - the log's other commands for the holder (the family service's spends, holds, ...) are carried: each runs on the
 *     replay's rows at its recorded place, which is its recorded revision;
 *   - the history it cannot re-decide is left as the log has it and counted (`NotReplayable`).
 * Nothing is written and the inputs are not changed.
 */
import type { SubjectState } from "@autumn/balance-engine";
import { menuCatalogRows } from "../billing/grants.js";
import { handleStripeFact } from "../billing/handle.js";
import { mappingFor } from "../billing/normalize.js";
import {
	applyRowChanges,
	type BillingRow,
	rowChangesFromMutation,
	stateFromRows,
	subjectKey,
} from "../billing/rows.js";
import { menuLineItems } from "../billing/stripe-menu.js";
import type {
	AtmBalance,
	AtmEnv,
	AtmEvent,
	AtmHold,
	AtmSimulateRefusal,
	AtmSubjectState,
	BillingPolicy,
	DecisionSummary,
	InputsBaselineMismatch,
	InputsDeliveryChange,
	InputsRead,
	InputsSimulateErrorConstructor,
	InputsSimulateInput,
	InputsSimulation,
	Menu,
	NotReplayable,
	ReplayFact,
	StoredContext,
	StoredInput,
	StripeEventRefusal,
	StripeEventResult,
} from "../types.js";
import {
	balanceChangesOf,
	byId,
	type CommandShape,
	clone,
	deriveEvents,
	describeChange,
	oneLine,
	postingChangesOf,
	settleHold,
	transactionsOf,
	withPolicy,
} from "./simulate.js";
import {
	balancesOf,
	compareChanges,
	HANDLER_COMMAND,
	type RecordedMutation,
	recordedMutations,
	replayEvents,
} from "./replay.js";
import { runOnState, toCatalog } from "./run.js";
import { canonicalize } from "./util.js";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MS_PER_SECOND = 1000;
const MAX_LISTED = 20;
const AVAIL_PREFIX = "credits:avail:";
/** The money lines the handler decides (they name their input as `cause`, and no command). */
const MONEY_LINES: ReadonlySet<string> = new Set([
	"payment.succeeded",
	"payment.refunded",
	"payment.disputed",
	"dispute.closed",
	"payout.paid",
	"money.skipped",
]);
/** The policy settings the booking calls decide: stored inputs cannot simulate them. */
const BOOKING_POLICY_FIELDS = [
	"cancelCutoffHours",
	"noShow",
	"lateCancel",
] as const;

/** Thrown for input `simulateFromInputs` cannot use; the CLI answers it with one stderr line and exit 2. */
export class InputsSimulateError extends Error {
	constructor(message?: string) {
		super(message);
		this.name = "InputsSimulateError";
	}
}
/** The constructor's type, for the package's public surface. */
export const InputsSimulateErrorType: InputsSimulateErrorConstructor =
	InputsSimulateError;

const isoOf = (ms: number): string => new Date(ms).toISOString();

type Context = {
	menu: Menu;
	menuVersion: string | number;
	policy: BillingPolicy;
	policyVersion: string | number;
	priceIds: Record<string, string>;
};

export type ReplayInputsOptions = {
	events: readonly AtmEvent[];
	inputs: InputsRead;
	env: AtmEnv;
	school: string;
	/** Which menu and policy to decide with, per input: the recorded context or a replacement. */
	contextFor: (input: StoredInput, recorded: StoredContext | undefined) => Context;
	/** The draw order to run the carried commands under, by instant; undefined keeps the command as recorded. */
	carriedPolicy?: (atMs: number) => BillingPolicy | undefined;
	/** The baseline run. Given, this run is a candidate: it stops where the baseline stopped and compares with its states. */
	against?: ReplayInputsResult;
};

type Halt = { token: string; reason: NotReplayable["reason"] };

export type InputOutcome = {
	appliedOrder: number;
	subjectKey: string;
	events: AtmEvent[];
	refused: StripeEventRefusal | null;
	rowsDigest: string;
	booking: DecisionSummary["booking"];
	/** The invoices the refund or dispute was linked to (payment ref to invoice). */
	invoiceIds: Record<string, string>;
};

export type ReplayInputsResult = {
	/** Decision events and carried events, deduped by idem (first wins), in id order. */
	events: AtmEvent[];
	/** By Stripe event id, for every input that ran. */
	byInput: Map<string, InputOutcome>;
	/** The rows and revision of every holder that ran, as the replay leaves them. */
	rows: Map<string, { rows: BillingRow[]; revision: number }>;
	notReplayable: NotReplayable[];
	/** Commands the engine refused (a candidate only). */
	refused: AtmSimulateRefusal[];
	/** Where a holder stopped being replayed, by subject key. */
	halts: Map<string, Halt>;
	/** The baseline's mismatches with the log (empty for a candidate). */
	mismatches: InputsBaselineMismatch[];
	/** The state each carried command ran on, for the candidate to compare with, by command key. */
	preStates: Map<string, string>;
	/** Holders that ran at least one input, by subject key. */
	holders: Set<string>;
	/** The log events a replayed input or command replaced. */
	replaced: Set<AtmEvent>;
	carriedCommands: number;
	/** The open holds the carried commands left, by lock id. */
	holds: Record<string, AtmHold>;
};

type Carried = {
	key: string;
	customerId: string;
	command: CommandShape;
	group: AtmEvent[];
	recorded: RecordedMutation;
	atMs: number;
	booking: boolean;
};

type Holder = {
	key: string;
	customerId: string;
	rows: BillingRow[];
	revision: number;
	/** Started from nothing (no seed): a refusal before its first applied input can run. */
	fresh: boolean;
	applied: boolean;
	halted: Halt | null;
	context: Context | null;
	sawBooking: boolean;
	queue: Carried[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A decision the handler made: it names a ULID as its cause and is a handler command or a money line. */
const isHandlerDecision = (e: AtmEvent): boolean => {
	if (typeof e.cause !== "string") return false;
	const command = (e.payload as { command?: { commandId?: unknown } }).command;
	if (command !== undefined)
		return (
			typeof command.commandId === "string" &&
			HANDLER_COMMAND.test(command.commandId)
		);
	return MONEY_LINES.has(e.event_type);
};

const mutationOf = (e: AtmEvent): RecordedMutation | null => {
	const mutation = (e.payload as { mutation?: RecordedMutation }).mutation;
	return mutation && typeof mutation.id === "string" ? mutation : null;
};

/** The refs a refund or dispute fact names its payment by (a payment intent and a charge). */
const refsOf = (fact: ReplayFact): string[] => {
	const named = fact as { paymentIntentId?: unknown; chargeId?: unknown };
	return [named.paymentIntentId, named.chargeId].filter(
		(ref): ref is string => typeof ref === "string" && ref !== "",
	);
};

const rowsDigestOf = (
	changes: { upserts: unknown; deletes: unknown } | null,
): string =>
	changes === null
		? canonicalize(null)
		: canonicalize({ upserts: changes.upserts, deletes: changes.deletes });

/** Whether the input is one that can call `removeInvoice`: a full refund that is an invoice's, or a lost dispute. */
const removesInvoice = (
	fact: ReplayFact,
	invoiceIds: Record<string, string>,
): boolean => {
	const named = fact as { full?: unknown; status?: unknown; bookingId?: unknown };
	if (named.status === "lost") return true;
	return (
		named.full === true &&
		named.bookingId === undefined &&
		Object.keys(invoiceIds).length > 0
	);
};

/**
 * The inputs of one school and env, and the log's carried commands, decided again with the contexts `contextFor` gives.
 * See the header. A baseline (no `against`) records where each holder stops; a candidate stops at the same places.
 */
export const replayInputs = (
	options: ReplayInputsOptions,
): ReplayInputsResult => {
	const { events, inputs, env, school, contextFor, against } = options;
	const mode = against ? "candidate" : "baseline";
	const customerSubject = (customerId: string): string =>
		subjectKey({ orgId: school, env, customerId, entityId: null });
	const identityOf = (customerId: string) => ({
		orgId: school,
		env,
		customerId,
		entityId: null,
	});

	// ---- Classify the log ----
	const allInputs = [...inputs.inputs, ...inputs.refused];
	const inputIds = new Set(allInputs.map((input) => input.inputId));
	const erasedHolders = new Set<string>();
	for (const input of inputs.inputs)
		if (input.erasedAt !== null)
			for (const e of events)
				if (e.cause === input.inputId) erasedHolders.add(e.key);
	/** Handler decisions whose input is in no stored input: decided before the storage began, or never shipped. */
	const unstored = new Map<string, AtmEvent[]>();
	const carriedByKey = new Map<string, AtmEvent[]>();
	const whole = recordedMutations(events);
	for (const e of events) {
		if (typeof e.cause === "string" && inputIds.has(e.cause)) continue;
		if (isHandlerDecision(e)) {
			unstored.set(e.key, [...(unstored.get(e.key) ?? []), e]);
			continue;
		}
		const command = (e.payload as { command?: CommandShape }).command;
		if (!command || !mutationOf(e)) continue;
		const key = `${command.identity.customerId}\u0000${command.commandId}`;
		carriedByKey.set(key, [...(carriedByKey.get(key) ?? []), e]);
	}
	const carriedOf = new Map<string, Carried[]>();
	for (const [key, group] of carriedByKey) {
		const first = group[0] as AtmEvent;
		const command = (first.payload as { command: CommandShape }).command;
		const own = mutationOf(first) as RecordedMutation;
		const recorded = (
			whole.get(`${first.key}\u0000${own.id}`) ?? { mutation: own }
		).mutation;
		const customerId = command.identity.customerId;
		const carried: Carried = {
			key,
			customerId,
			command,
			group,
			recorded,
			atMs: Date.parse(first.event_time),
			booking:
				command.commandId.startsWith("bk:") ||
				group.some((e) => e.labels.booking !== undefined),
		};
		carriedOf.set(customerId, [...(carriedOf.get(customerId) ?? []), carried]);
	}
	for (const list of carriedOf.values())
		list.sort(
			(a, b) =>
				a.recorded.revision.before - b.recorded.revision.before ||
				(a.group[0] as AtmEvent).id.localeCompare(
					(b.group[0] as AtmEvent).id,
				),
		);

	// ---- State of the run ----
	const holders = new Map<string, Holder>();
	const invoiceIndex = new Map<string, string>();
	const paymentIndex = new Map<string, string>();
	const seen = new Set<string>();
	const byInput = new Map<string, InputOutcome>();
	const produced: AtmEvent[] = [];
	const replaced = new Set<AtmEvent>();
	const halts = new Map<string, Halt>(against?.halts ?? []);
	const mismatches: InputsBaselineMismatch[] = [];
	const preStates = new Map<string, string>();
	const refused: AtmSimulateRefusal[] = [];
	const holds: Record<string, AtmHold> = {};
	const executedHolders = new Set<string>();
	const catalogs = new WeakMap<Menu, ReturnType<typeof menuCatalogRows>>();
	const engineCatalogs = new WeakMap<Menu, ReturnType<typeof toCatalog>>();
	let carriedCommands = 0;

	const catalogRowsOf = (menu: Menu) => {
		let rows = catalogs.get(menu);
		if (!rows) {
			rows = menuCatalogRows({ menu, school, env });
			catalogs.set(menu, rows);
		}
		return rows;
	};
	const engineCatalogOf = (menu: Menu) => {
		let catalog = engineCatalogs.get(menu);
		if (!catalog) {
			catalog = toCatalog(catalogRowsOf(menu));
			engineCatalogs.set(menu, catalog);
		}
		return catalog;
	};

	/** The events a step made that no earlier one made under the same idem (the outbox keeps the first). */
	const fresh = (made: readonly AtmEvent[]): AtmEvent[] => {
		const kept: AtmEvent[] = [];
		for (const e of made) {
			if (seen.has(e.idem)) continue;
			seen.add(e.idem);
			kept.push(e);
		}
		produced.push(...kept);
		return kept;
	};

	const contextOfInput = (input: StoredInput): Context | null => {
		if (input.contextHash === null) return null;
		const recorded = inputs.contexts.get(input.contextHash);
		return recorded ? contextFor(input, recorded) : null;
	};

	const holderOf = (key: string, customerId: string): Holder => {
		const known = holders.get(key);
		if (known) return known;
		const seed = inputs.seeds.get(key);
		const holder: Holder = {
			key,
			customerId,
			rows: seed ? clone(seed.rows) : [],
			revision: seed?.revision ?? 0,
			fresh: seed === undefined,
			applied: false,
			halted: null,
			context: null,
			sawBooking: false,
			queue: [],
		};
		holder.queue = (carriedOf.get(customerId) ?? []).filter(
			(c) => c.recorded.revision.after > holder.revision,
		);
		const first = allInputs.find(
			(input) => input.subjectKey === key && input.contextHash !== null,
		);
		holder.context = first ? contextOfInput(first) : null;
		holders.set(key, holder);
		return holder;
	};

	/** Why a holder's rows are ahead of what the replay knows: a decision that is in no stored input, or a write nothing records. */
	const gapReason = (
		holder: Holder,
		reachedBy: number,
	): NotReplayable["reason"] => {
		const missing = (unstored.get(holder.customerId) ?? []).some((e) => {
			const after = mutationOf(e)?.revision.after;
			return (
				after !== undefined &&
				after > holder.revision &&
				after <= reachedBy
			);
		});
		return missing ? "inputs_not_stored" : "non_input_writes";
	};

	const halt = (holder: Holder, token: string, reason: Halt["reason"]) => {
		holder.halted = { token, reason };
		if (mode === "baseline") halts.set(holder.key, { token, reason });
	};

	const haltedHere = (holder: Holder, token: string): boolean => {
		const planned = halts.get(holder.key);
		if (mode === "candidate" && planned?.token === token) {
			holder.halted = planned;
			return true;
		}
		return false;
	};

	const mismatch = (
		eventId: string,
		holder: Holder,
		reason: InputsBaselineMismatch["reason"],
		recordedEvents: readonly AtmEvent[],
		replayedEvents: readonly AtmEvent[],
	) => {
		if (mode !== "baseline") return;
		mismatches.push({
			eventId,
			subjectKey: holder.key,
			reason,
			recordedIdems: recordedEvents.map((e) => e.idem).sort(),
			replayedIdems: replayedEvents.map((e) => e.idem).sort(),
		});
	};

	const logDecisions = new Map<string, AtmEvent[]>();
	for (const e of events)
		if (typeof e.cause === "string" && inputIds.has(e.cause))
			logDecisions.set(e.cause, [...(logDecisions.get(e.cause) ?? []), e]);
	for (const group of logDecisions.values()) group.sort(byId);

	// ---- A carried command ----
	const runCarried = (holder: Holder, carried: Carried): void => {
		const token = `cmd:${carried.key}`;
		if (haltedHere(holder, token)) return;
		const { recorded } = carried;
		if (mode === "baseline" && holder.revision < recorded.revision.before) {
			halt(holder, token, gapReason(holder, recorded.revision.before));
			return;
		}
		if (mode === "baseline" && holder.revision > recorded.revision.before)
			mismatch(
				carried.command.commandId,
				holder,
				"revision_gap",
				carried.group,
				[],
			);
		holder.revision = recorded.revision.before;
		if (carried.booking) holder.sawBooking = true;
		const context = holder.context;
		if (!context) {
			// no menu ever seen for the holder: nothing to run the command under
			if (mode === "baseline")
				mismatch(
					carried.command.commandId,
					holder,
					"context_missing",
					carried.group,
					[],
				);
			return;
		}
		const header = {
			key: carried.customerId,
			commandId: carried.command.commandId,
			command: carried.command.type,
			at: (carried.group[0] as AtmEvent).event_time,
			date: (carried.group[0] as AtmEvent).date,
			eventIds: carried.group.map((e) => e.id),
		};
		const refuse = (reason: string) => {
			if (mode === "baseline") {
				mismatch(
					carried.command.commandId,
					holder,
					"events_differ",
					carried.group,
					[],
				);
				return;
			}
			refused.push({
				...header,
				reason,
				lost: recorded.changes.map(describeChange),
			});
		};
		const state = stateFromRows({
			identity: identityOf(carried.customerId),
			revision: holder.revision,
			rows: holder.rows,
		});
		const startDigest = canonicalize({ ...state, revision: 0 });
		if (mode === "baseline") preStates.set(carried.key, startDigest);
		const command =
			mode === "candidate"
				? withPolicy(carried.command, options.carriedPolicy?.(carried.atMs))
				: carried.command;
		let run: ReturnType<typeof runOnState>;
		try {
			run = runOnState({
				state,
				catalog: engineCatalogOf(context.menu),
				command: { ...command, occurredAt: carried.atMs },
			});
		} catch (error) {
			refuse(`the engine refused: ${oneLine(error)}`);
			return;
		}
		if (!run.mutation || !run.state) {
			refuse("the engine decided nothing");
			return;
		}
		const { command: _decidedCommand, ...decided } =
			run.mutation as unknown as Record<string, unknown>;
		const result = decided.result as { status?: string; reason?: string | null } | undefined;
		if (result?.status === "rejected") {
			refuse(`the engine rejected it: ${result.reason ?? "no reason given"}`);
			return;
		}
		const fit = compareChanges(decided.changes as unknown[], recorded.changes);
		const same =
			fit === "same" &&
			canonicalize({ ...decided, changes: null }) ===
				canonicalize({ ...recorded, changes: null });
		let outcome: AtmEvent[] = carried.group;
		if (mode === "candidate") {
			const onOtherRows =
				startDigest !== (against?.preStates.get(carried.key) ?? startDigest);
			if (!same || onOtherRows) {
				try {
					outcome = deriveEvents(
						carried.group,
						{ mutation: run.mutation, before: state ? clone(state) : null },
						recorded,
					);
				} catch (error) {
					refuse(
						`the engine decided it but its events cannot be booked: ${oneLine(error)}`,
					);
					return;
				}
			}
			settleHold(holds, carried.command, outcome, run.mutation);
		} else if (!same) {
			mismatch(
				carried.command.commandId,
				holder,
				"events_differ",
				carried.group,
				[],
			);
		}
		const changes = rowChangesFromMutation({
			mutation: run.mutation as never,
			rows: holder.rows,
			revision: holder.revision,
		});
		({ rows: holder.rows, revision: holder.revision } = applyRowChanges({
			rows: holder.rows,
			revision: holder.revision,
			changes,
		}));
		for (const e of carried.group) replaced.add(e);
		fresh(outcome);
		carriedCommands += 1;
		executedHolders.add(holder.key);
	};

	/** The holder's carried commands that ran before a point: those whose write ended at or before `upTo`. */
	const flush = (holder: Holder, upTo: number): void => {
		while (!holder.halted) {
			const next = holder.queue[0];
			if (!next || next.recorded.revision.after > upTo) return;
			holder.queue.shift();
			runCarried(holder, next);
		}
	};

	// ---- An input ----
	const runInput = (input: StoredInput): void => {
		if (input.subjectKey === null || input.fact === null) return;
		const isApplied = input.outcome === "applied";
		const customerId = input.subjectKey.split("|")[2] as string;
		const holder = holderOf(input.subjectKey, customerId);
		if (erasedHolders.has(customerId) || holder.halted) return;
		if (!isApplied && !holder.fresh && !holder.applied) return;
		const token = `in:${input.appliedOrder}`;
		if (haltedHere(holder, token)) return;
		if (input.revisionBefore !== null) flush(holder, input.revisionBefore);
		if (holder.halted) return;
		const logged = logDecisions.get(input.inputId) ?? [];

		// invoice_payment.paid: teaches the payment index, decides nothing
		if (input.type === "invoice_payment.paid") {
			const fact = input.fact as {
				invoiceId?: string;
				paymentIntentId?: string | null;
				chargeId?: string | null;
			};
			if (fact.invoiceId && invoiceIndex.has(fact.invoiceId))
				for (const ref of [fact.paymentIntentId, fact.chargeId])
					if (typeof ref === "string" && !paymentIndex.has(ref))
						paymentIndex.set(ref, fact.invoiceId);
			holder.applied = true;
			executedHolders.add(holder.key);
			byInput.set(input.eventId, {
				appliedOrder: input.appliedOrder,
				subjectKey: input.subjectKey,
				events: [],
				refused: null,
				rowsDigest: rowsDigestOf(null),
				booking: null,
				invoiceIds: {},
			});
			return;
		}

		const context = contextOfInput(input);
		if (!context) {
			halt(holder, token, "context_missing");
			return;
		}
		holder.context = context;
		const mapping = mappingFor(input.type, input.apiVersion);
		if (!mapping.ok) {
			mismatch(input.eventId, holder, "events_differ", logged, []);
			return;
		}
		const refs = refsOf(input.fact);
		const invoiceIds: Record<string, string> = {};
		for (const ref of refs) {
			const invoice = paymentIndex.get(ref);
			if (invoice !== undefined && invoiceIndex.has(invoice))
				invoiceIds[ref] = invoice;
		}
		if (
			mode === "baseline" &&
			isApplied &&
			holder.sawBooking &&
			removesInvoice(input.fact, invoiceIds)
		) {
			halt(holder, token, "booking_writes");
			return;
		}
		if (mode === "baseline" && input.revisionBefore !== null) {
			if (holder.revision < input.revisionBefore) {
				halt(holder, token, gapReason(holder, input.revisionBefore));
				return;
			}
			if (holder.revision > input.revisionBefore)
				mismatch(input.eventId, holder, "revision_gap", logged, []);
		}
		if (input.revisionBefore !== null) holder.revision = input.revisionBefore;
		// What the handler would have waited for (a refund whose invoice is not indexed) is a wait in the candidate.
		const baselineLinked = Object.keys(
			against?.byInput.get(input.eventId)?.invoiceIds ?? {},
		).length;
		const waits =
			mode === "candidate" &&
			baselineLinked > 0 &&
			Object.keys(invoiceIds).length === 0;
		const result: StripeEventResult = waits
			? {
					rowChanges: null,
					events: [],
					refused: {
						reason: "unmatched_invoice",
						message: `${input.eventId} waits: its invoice is not handled under the candidate`,
					},
				}
			: handleStripeFact({
					fact: input.fact,
					target: mapping.value.target,
					type: input.type,
					apiVersion: input.apiVersion,
					mapping: input.mapping,
					eventId: input.inputId,
					menu: context.menu,
					menuVersion: context.menuVersion,
					policy: context.policy,
					policyVersion: context.policyVersion,
					rows: holder.rows,
					revision: holder.revision,
					catalog: catalogRowsOf(context.menu),
					now: input.stripeCreated * MS_PER_SECOND,
					priceIds: context.priceIds,
					invoiceIds,
					...(input.bookingRefs ? { bookingIds: input.bookingRefs } : {}),
					...(input.fee === null ? {} : { fee: input.fee }),
					env,
					school,
				});
		for (const e of logged) replaced.add(e);
		executedHolders.add(holder.key);

		if (result.refused) {
			const made = fresh(result.refused.payment ?? []);
			byInput.set(input.eventId, {
				appliedOrder: input.appliedOrder,
				subjectKey: input.subjectKey,
				events: made,
				refused: result.refused,
				rowsDigest: rowsDigestOf(null),
				booking: null,
				invoiceIds,
			});
			if (isApplied)
				mismatch(input.eventId, holder, "refused_differently", logged, made);
			else if (result.refused.reason !== input.reason)
				mismatch(input.eventId, holder, "refused_differently", logged, made);
			else compareDecision(input, holder, logged, made);
			return;
		}
		if (!isApplied) {
			// stored as refused, accepted now: the baseline's replay is wrong; a candidate accepts it as a new input
			if (mode === "baseline")
				mismatch(input.eventId, holder, "refused_differently", logged, []);
		}
		if (result.rowChanges)
			({ rows: holder.rows, revision: holder.revision } = applyRowChanges({
				rows: holder.rows,
				revision: holder.revision,
				changes: result.rowChanges,
			}));
		if (input.type === "invoice.paid") {
			const invoiceId = (input.fact as { id?: string }).id;
			if (invoiceId && !invoiceIndex.has(invoiceId)) {
				invoiceIndex.set(invoiceId, input.subjectKey);
			}
			if (invoiceId)
				for (const ref of input.paymentRefs ?? [])
					if (!paymentIndex.has(ref)) paymentIndex.set(ref, invoiceId);
		}
		const made = fresh(result.events);
		byInput.set(input.eventId, {
			appliedOrder: input.appliedOrder,
			subjectKey: input.subjectKey,
			events: made,
			refused: null,
			rowsDigest: rowsDigestOf(result.rowChanges),
			booking: result.booking?.action ?? null,
			invoiceIds,
		});
		if (isApplied) {
			holder.applied = true;
			compareDecision(input, holder, logged, made);
		}
	};

	/** The baseline: what the input decided must be what the log holds for it, by idem and canonical body. */
	const compareDecision = (
		input: StoredInput,
		holder: Holder,
		logged: readonly AtmEvent[],
		made: readonly AtmEvent[],
	) => {
		if (mode !== "baseline") return;
		const text = (list: readonly AtmEvent[]) =>
			canonicalize(
				[...list]
					.sort((a, b) => (a.idem < b.idem ? -1 : a.idem > b.idem ? 1 : 0))
					.map((e) => e),
			);
		if (text(logged) !== text(made))
			mismatch(input.eventId, holder, "events_differ", logged, made);
	};

	// ---- The pass ----
	const order = [
		...inputs.inputs.filter((input) => input.erasedAt === null),
		...inputs.refused.filter((input) => input.reason !== "bad_event"),
	].sort((a, b) => a.appliedOrder - b.appliedOrder);
	for (const input of order) runInput(input);
	for (const holder of holders.values())
		if (!holder.halted) flush(holder, Number.POSITIVE_INFINITY);

	// ---- What was left as the log has it ----
	const notReplayable = accountNotReplayable({
		events,
		inputs,
		school,
		env,
		holders,
		executedHolders,
		replaced,
		unstored,
		erasedHolders,
		allInputs,
		customerSubject,
		byInput,
	});

	const kept = events.filter((e) => !replaced.has(e));
	const merged: AtmEvent[] = [...kept];
	const idems = new Set(kept.map((e) => e.idem));
	for (const e of produced) {
		if (idems.has(e.idem)) continue;
		idems.add(e.idem);
		merged.push(e);
	}
	merged.sort(byId);

	const rows = new Map<string, { rows: BillingRow[]; revision: number }>();
	for (const holder of holders.values())
		if (executedHolders.has(holder.key))
			rows.set(holder.key, { rows: holder.rows, revision: holder.revision });

	return {
		events: merged,
		byInput,
		rows,
		notReplayable,
		refused,
		halts,
		mismatches,
		preStates,
		holders: executedHolders,
		replaced,
		carriedCommands,
		holds,
	};
};

/** The history a replay left as the log has it, by holder and reason. */
const accountNotReplayable = ({
	events,
	inputs,
	holders,
	executedHolders,
	replaced,
	unstored,
	erasedHolders,
	allInputs,
	customerSubject,
}: {
	events: readonly AtmEvent[];
	inputs: InputsRead;
	school: string;
	env: AtmEnv;
	holders: Map<string, Holder>;
	executedHolders: Set<string>;
	replaced: Set<AtmEvent>;
	unstored: Map<string, AtmEvent[]>;
	erasedHolders: Set<string>;
	allInputs: StoredInput[];
	customerSubject: (customerId: string) => string;
	byInput: Map<string, InputOutcome>;
}): NotReplayable[] => {
	const items = new Map<string, NotReplayable>();
	const add = (
		subject: string | null,
		reason: NotReplayable["reason"],
		list: readonly AtmEvent[],
	) => {
		if (list.length === 0) return;
		const key = `${subject}\u0000${reason}`;
		const times = list.map((e) => Date.parse(e.event_time));
		const first = isoOf(Math.min(...times));
		const known = items.get(key);
		if (known) {
			known.decisions += list.length;
			if (known.firstDecisionAt === null || first < known.firstDecisionAt)
				known.firstDecisionAt = first;
			return;
		}
		items.set(key, {
			subjectKey: subject,
			reason,
			decisions: list.length,
			firstDecisionAt: first,
		});
	};
	// erased holders: everything of theirs is left as it is
	const decisionsOf = new Map<string, AtmEvent[]>();
	const inputIds = new Set(allInputs.map((input) => input.inputId));
	for (const e of events)
		if (typeof e.cause === "string" && inputIds.has(e.cause))
			decisionsOf.set(e.key, [...(decisionsOf.get(e.key) ?? []), e]);
	for (const customerId of erasedHolders)
		add(
			customerSubject(customerId),
			"erased",
			events.filter((e) => e.key === customerId),
		);
	// decisions of inputs that were never stored
	for (const [customerId, list] of unstored)
		if (!erasedHolders.has(customerId))
			add(customerSubject(customerId), "inputs_not_stored", list);
	// holders that stopped: what is left of their stored decisions and carried commands
	for (const holder of holders.values()) {
		if (!holder.halted) continue;
		const left = events.filter(
			(e) =>
				e.key === holder.customerId &&
				!replaced.has(e) &&
				!(unstored.get(holder.customerId) ?? []).includes(e) &&
				(isHandlerDecision(e) ||
					(e.payload as { command?: unknown }).command !== undefined),
		);
		const fromHalt = left.filter(
			(e) =>
				!inputs.seeds.has(holder.key) ||
				(mutationOf(e)?.revision.after ?? Number.POSITIVE_INFINITY) >
					(inputs.seeds.get(holder.key)?.revision ?? 0),
		);
		add(holder.key, holder.halted.reason, fromHalt);
	}
	void executedHolders;
	return [...items.values()].sort((a, b) =>
		`${a.subjectKey}\u0000${a.reason}` < `${b.subjectKey}\u0000${b.reason}`
			? -1
			: 1,
	);
};

// ---- The what-if ----

const creditsOf = (events: readonly AtmEvent[]) => {
	const granted: Record<string, number> = {};
	const removed: Record<string, number> = {};
	for (const e of events)
		for (const p of e.postings) {
			if (!p.account.startsWith(AVAIL_PREFIX)) continue;
			const feature = p.account.slice(p.account.lastIndexOf(":") + 1);
			const units = Number(p.amount);
			if (units > 0) granted[feature] = (granted[feature] ?? 0) + units;
			if (units < 0) removed[feature] = (removed[feature] ?? 0) - units;
		}
	return { granted, removed };
};

const summaryOfDecision = (
	events: readonly AtmEvent[],
	outcome: Pick<InputOutcome, "refused" | "rowsDigest" | "booking">,
): DecisionSummary => ({
	refused: outcome.refused ? { reason: outcome.refused.reason } : null,
	events: events.length,
	...creditsOf(events),
	rowsDigest: outcome.rowsDigest,
	booking: outcome.booking,
});

/** An event by what it books: its idem, kind, time, labels and postings (its id and revision follow the replay's count of writes). */
const economicsOf = (events: readonly AtmEvent[]): string =>
	canonicalize(
		[...events]
			.sort((a, b) => (a.idem < b.idem ? -1 : a.idem > b.idem ? 1 : 0))
			.map((e) => ({
				idem: e.idem,
				type: e.event_type,
				time: e.event_time,
				labels: e.labels,
				postings: e.postings,
			})),
	);

/** A line item with no price: the same product at the same interval in two menus. */
const identityOf = (item: Record<string, unknown>): string =>
	canonicalize({
		kind: item.kind,
		tierId: item.tierId,
		addonId: item.addonId,
		interval: item.interval,
		gift: item.gift,
	});

/**
 * The Stripe price ids a candidate menu's prices stand for. A price's lookup key names its amount, so a menu with another
 * amount has other keys and the recorded invoice lines would match nothing; the same product at the same interval keeps the
 * price id it was bought under. Prices the recorded menu did not have (a price the candidate adds) keep none: a line that
 * names its lookup key still matches by it.
 */
export const candidatePriceIds = ({
	school,
	from,
	fromIds,
	to,
}: {
	school: string;
	from: Menu;
	fromIds: Readonly<Record<string, string>>;
	to: Menu;
}): Record<string, string> => {
	const was = menuLineItems(school, from);
	const now = menuLineItems(school, to);
	const toKey = new Map<string, string>();
	for (const [key, item] of now)
		toKey.set(identityOf(item as unknown as Record<string, unknown>), key);
	const out: Record<string, string> = { ...fromIds };
	for (const [key, item] of was) {
		const priceId = fromIds[key];
		const next = toKey.get(identityOf(item as unknown as Record<string, unknown>));
		if (priceId && next) out[next] = priceId;
	}
	return out;
};

const fieldsDiffering = (
	a: BillingPolicy,
	b: BillingPolicy,
): string[] =>
	(
		[...new Set([...Object.keys(a), ...Object.keys(b)])] as (keyof BillingPolicy)[]
	)
		.filter((field) => canonicalize(a[field]) !== canonicalize(b[field]))
		.sort();

const listed = <T>(
	title: string,
	items: readonly T[],
	line: (item: T) => string,
): string[] => {
	if (items.length === 0) return [`${title}: none`];
	return [
		`${title}: ${items.length}`,
		...items.slice(0, MAX_LISTED).map((item) => `  ${line(item)}`),
		...(items.length > MAX_LISTED
			? [`  ... and ${items.length - MAX_LISTED} more`]
			: []),
	];
};

const unitsText = (units: Record<string, number>): string => {
	const text = Object.entries(units)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([feature, n]) => `${n} ${feature}`)
		.join(", ");
	return text === "" ? "none" : text;
};

/**
 * Replays the stored inputs (and the log's carried commands) twice, with the recorded context (the baseline, which must
 * equal the log) and with the candidate, and diffs them. Writes nothing. Throws `InputsSimulateError` for input it cannot
 * use. See the header and `docs/simulate-from-inputs.md`, section 5.
 */
export const simulateFromInputs = (
	input: InputsSimulateInput,
): InputsSimulation => {
	const { events, inputs, env, school, candidate, current } = input;
	if (input.month !== undefined && !MONTH.test(input.month))
		throw new InputsSimulateError(`month must be YYYY-MM, got ${input.month}`);
	if (inputs.inputs.length === 0 && inputs.refused.length === 0)
		throw new InputsSimulateError(
			`no stored inputs for school ${school} (${env}) in ${inputs.origin}`,
		);
	const effectiveFrom = input.effectiveFrom ?? Number.NEGATIVE_INFINITY;
	const hasCandidate = candidate.menu !== undefined || candidate.policy !== undefined;

	// The context hash leaves out the two version labels: they are read from the input's own row.
	const recordedOf = (
		stored: StoredInput,
		recorded: StoredContext,
	): Context => ({
		menu: current?.menu ?? recorded.menu,
		menuVersion: stored.menuVersion ?? recorded.menuVersion,
		policy: current?.policy ?? recorded.policy,
		policyVersion: stored.policyVersion ?? recorded.policyVersion,
		priceIds: current?.menu
			? candidatePriceIds({
					school,
					from: recorded.menu,
					fromIds: recorded.priceIds,
					to: current.menu,
				})
			: { ...recorded.priceIds },
	});
	const candidateOf = (stored: StoredInput, recorded: StoredContext): Context => {
		const base = recordedOf(stored, recorded);
		if (!hasCandidate || stored.stripeCreated * MS_PER_SECOND < effectiveFrom)
			return base;
		return {
			...base,
			menu: candidate.menu ?? base.menu,
			policy: candidate.policy ?? base.policy,
			priceIds: candidate.menu
				? candidatePriceIds({
						school,
						from: base.menu,
						fromIds: base.priceIds,
						to: candidate.menu,
					})
				: base.priceIds,
		};
	};

	// The policy settings the booking calls decide.
	const notSimulated = new Set<string>();
	let otherDifference = candidate.menu !== undefined;
	if (candidate.policy !== undefined)
		for (const stored of inputs.contexts.values()) {
			const fields = fieldsDiffering(
				current?.policy ?? stored.policy,
				candidate.policy,
			);
			for (const field of fields)
				if ((BOOKING_POLICY_FIELDS as readonly string[]).includes(field))
					notSimulated.add(field);
				else otherDifference = true;
		}
	if (notSimulated.size > 0 && !otherDifference)
		throw new InputsSimulateError(
			`${[...notSimulated].sort().join(", ")} ${notSimulated.size === 1 ? "is" : "are"} decided by booking calls, which are not stored: nothing to simulate (cancelCutoffHours, noShow and lateCancel cannot be tried from stored inputs)`,
		);

	let baseline: ReplayInputsResult;
	let trial: ReplayInputsResult;
	try {
		baseline = replayInputs({
			events,
			inputs,
			env,
			school,
			contextFor: (stored, recorded) =>
				recordedOf(stored, recorded as StoredContext),
		});
		trial = replayInputs({
			events,
			inputs,
			env,
			school,
			contextFor: (stored, recorded) =>
				candidateOf(stored, recorded as StoredContext),
			carriedPolicy: (atMs) =>
				hasCandidate && atMs >= effectiveFrom ? candidate.policy : undefined,
			against: baseline,
		});
	} catch (error) {
		throw new InputsSimulateError(`the replay failed: ${oneLine(error)}`);
	}
	const baselineInputs = [...baseline.byInput.values()].length;
	if (baseline.mismatches.length > 0 && input.allowBaselineDrift !== true) {
		const first = baseline.mismatches[0] as InputsBaselineMismatch;
		throw new InputsSimulateError(
			`the baseline does not reproduce the log: ${baseline.mismatches.length} input(s) decided differently from the recorded events (first: ${first.eventId}, ${first.reason}, recorded ${first.recordedIdems.join(",") || "none"}, replayed ${first.replayedIdems.join(",") || "none"}); the replay cannot be trusted as the basis of a what-if. Run again with --allow-baseline-drift to see the difference anyway`,
		);
	}

	// ---- The recorded side ----
	const lastContext = [...inputs.contexts.values()].sort(
		(a, b) => a.firstUsedAt - b.firstUsedAt,
	).at(-1);
	const recordedMenu = current?.menu ?? lastContext?.menu;
	if (!recordedMenu)
		throw new InputsSimulateError(
			`no menu is stored for school ${school} (${env}) in ${inputs.origin}; give --current-menu`,
		);
	const currentRows = menuCatalogRows({ menu: recordedMenu, school, env });
	let recorded: ReturnType<typeof replayEvents>;
	try {
		recorded = replayEvents({
			events,
			catalog: currentRows,
			asOf: input.asOf,
		});
	} catch (error) {
		throw new InputsSimulateError(
			`the log cannot be replayed: ${oneLine(error)}`,
		);
	}
	const asOfMs = recorded.asOf ? Date.parse(recorded.asOf) : 0;
	const candidateMenu = candidate.menu ?? recordedMenu;
	const candidateCatalog = toCatalog(
		menuCatalogRows({ menu: candidateMenu, school, env }),
	);

	// ---- The candidate's balances ----
	const states: Record<string, AtmSubjectState> = clone(
		recorded.snapshot.states,
	);
	const holds: Record<string, AtmHold> = {};
	const replayedHolders = new Set<string>();
	for (const [subject, rows] of trial.rows) {
		const customerId = subject.split("|")[2] as string;
		replayedHolders.add(customerId);
		const state = stateFromRows({
			identity: { orgId: school, env, customerId, entityId: null },
			revision: rows.revision,
			rows: rows.rows,
		});
		if (state) states[customerId] = state as unknown as AtmSubjectState;
		else delete states[customerId];
	}
	for (const [lock, hold] of Object.entries(recorded.snapshot.holds))
		if (!replayedHolders.has(hold.holder)) holds[lock] = hold;
	for (const customerId of replayedHolders) {
		const open = (states[customerId] as unknown as SubjectState | undefined)
			?.openLocks;
		for (const lock of (open ?? []) as { id: string }[]) {
			const made = trial.holds[lock.id] ?? recorded.snapshot.holds[lock.id];
			if (made) holds[lock.id] = made;
		}
	}
	const candidateBalances: AtmBalance[] = balancesOf({
		states,
		holds,
		catalog: candidateCatalog,
		asOfMs,
	});

	// ---- The diff ----
	const month = input.month;
	const inMonth = (date: string) =>
		month === undefined || date.startsWith(`${month}-`);
	const byEventId = new Map<string, StoredInput>();
	for (const stored of [...inputs.inputs, ...inputs.refused])
		byEventId.set(stored.eventId, stored);
	const loggedBy = new Map<string, AtmEvent[]>();
	for (const e of events)
		if (typeof e.cause === "string")
			loggedBy.set(e.cause, [...(loggedBy.get(e.cause) ?? []), e]);
	const deliveries: InputsDeliveryChange[] = [];
	for (const [eventId, was] of baseline.byInput) {
		const stored = byEventId.get(eventId) as StoredInput;
		const now = trial.byInput.get(eventId);
		if (!now) continue;
		const logged = stored.outcome === "applied" ? (loggedBy.get(stored.inputId) ?? []) : [];
		const before = summaryOfDecision(
			stored.outcome === "refused" ? was.events : logged,
			{
				refused:
					stored.outcome === "refused" && stored.reason
						? { reason: stored.reason, message: "" }
						: null,
				rowsDigest: was.rowsDigest,
				booking: was.booking,
			},
		);
		const after = summaryOfDecision(now.events, now);
		const wasMade = before.events > 0 || was.rowsDigest !== canonicalize(null);
		let kind: InputsDeliveryChange["kind"];
		if (stored.outcome === "refused")
			kind = now.refused ? "same" : "newly_applied";
		else if (now.refused) kind = "newly_refused";
		else if (
			wasMade &&
			after.events === 0 &&
			now.rowsDigest === canonicalize(null)
		)
			kind = "no_longer_applied";
		else if (
			economicsOf(was.events) === economicsOf(now.events) &&
			was.rowsDigest === now.rowsDigest
		)
			kind = "same";
		else kind = "changed";
		const at = isoOf(stored.stripeCreated * MS_PER_SECOND);
		if (!inMonth(at.slice(0, 10))) continue;
		deliveries.push({
			eventId,
			type: stored.type,
			appliedOrder: was.appliedOrder,
			subjectKey: was.subjectKey,
			at,
			kind,
			recorded: before,
			candidate: after,
		});
	}
	deliveries.sort(
		(a, b) => (a.appliedOrder ?? 0) - (b.appliedOrder ?? 0),
	);

	const candidateEvents = trial.events;
	const postingChanges = postingChangesOf(events, candidateEvents).filter(
		(p) => month === undefined || p.month === month,
	);
	const balanceChanges = balanceChangesOf(recorded.balances, candidateBalances);
	const refused = trial.refused.filter((r) =>
		inMonth((r as AtmSimulateRefusal & { date?: string }).at.slice(0, 10)),
	);
	const kept = candidateEvents.filter((e) => !trial.replaced.has(e));
	const unaffected = { events: 0, byType: {} as Record<string, number> };
	for (const e of events) {
		if (trial.replaced.has(e)) continue;
		unaffected.events += 1;
		unaffected.byType[e.event_type] =
			(unaffected.byType[e.event_type] ?? 0) + 1;
	}
	void kept;
	const notReplayableItems = trial.notReplayable;
	const first = [...inputs.inputs, ...inputs.refused].sort(
		(a, b) => a.receivedAt - b.receivedAt || a.appliedOrder - b.appliedOrder,
	)[0];
	const differing = deliveries.filter((d) => d.kind !== "same");
	const replayed = {
		holders: baseline.holders.size,
		inputs: baselineInputs,
		carriedCommands: baseline.carriedCommands,
	};
	const result: InputsSimulation = {
		events: candidateEvents,
		balances: { current: recorded.balances, candidate: candidateBalances },
		balanceChanges,
		postingChanges,
		transactions: transactionsOf(events, candidateEvents, month),
		asOf: recorded.asOf,
		unaffected,
		baseline: {
			identical: baseline.mismatches.length === 0,
			inputs: baselineInputs,
			mismatches: baseline.mismatches,
		},
		deliveries,
		notReplayable: {
			decisions: notReplayableItems.reduce((n, item) => n + item.decisions, 0),
			holders: new Set(notReplayableItems.map((item) => item.subjectKey)).size,
			firstStoredAt: first ? isoOf(first.receivedAt) : null,
			firstStoredEventId: first?.eventId ?? null,
			items: notReplayableItems,
		},
		replayed,
		refused,
		notSimulated: [...notSimulated].sort(),
		differences:
			differing.length +
			balanceChanges.length +
			postingChanges.length +
			refused.length,
		summary: "",
	};
	result.summary = summaryOf(result, input, differing);
	return result;
};

const summaryOf = (
	result: InputsSimulation,
	input: InputsSimulateInput,
	differing: readonly InputsDeliveryChange[],
): string => {
	const stored = input.inputs.inputs.length;
	const lines = [
		`simulate: ${stored} stored inputs of school ${input.school} (${input.env}) replayed against the candidate${result.asOf ? `, balances as of ${result.asOf}` : ""}; ${result.differences === 0 ? "no differences" : `${result.differences} differences`}`,
		`baseline: ${result.baseline.identical ? `the replay reproduces the log (${result.baseline.inputs} inputs)` : `DRIFT, ${result.baseline.mismatches.length} inputs decided differently from the log (reported, not counted)`}`,
		`replayed: ${result.replayed.inputs} inputs of ${result.replayed.holders} holders, ${result.replayed.carriedCommands} carried commands`,
	];
	if (result.baseline.mismatches.length > 0)
		lines.push(
			...listed(
				"baseline drift",
				result.baseline.mismatches,
				(m) =>
					`${m.eventId} (${m.reason}): log ${m.recordedIdems.join(",") || "none"}, replay ${m.replayedIdems.join(",") || "none"}`,
			),
		);
	lines.push(
		...listed(
			"deliveries decided differently",
			differing,
			(d) =>
				`${d.at} ${d.type} ${d.eventId} ${d.kind}: granted ${unitsText(d.recorded.granted)} -> ${unitsText(d.candidate.granted)}; taken back ${unitsText(d.recorded.removed)} -> ${unitsText(d.candidate.removed)}${d.candidate.refused ? `; refused: ${d.candidate.refused.reason}` : ""}`,
		),
		...listed(
			"balances that differ",
			result.balanceChanges,
			(b) =>
				`${b.holder} ${b.feature}: avail ${b.current.avail} -> ${b.candidate.avail}, held ${b.current.held} -> ${b.candidate.held}`,
		),
		...listed(
			"posting totals that differ",
			result.postingChanges,
			(p) =>
				`${p.month} ${p.account} ${p.commodity}: ${p.current} -> ${p.candidate}`,
		),
		...listed(
			"commands the candidate refuses",
			result.refused,
			(r) => `${r.at} ${r.command} ${r.commandId}: ${r.reason}`,
		),
	);
	if (result.notSimulated.length > 0)
		lines.push(
			`not simulated: ${result.notSimulated.join(", ")} (decided by booking calls, which are not stored)`,
		);
	const first = result.notReplayable.firstStoredAt;
	lines.push(
		`inputs: ${stored} stored for school ${input.school} (${input.env}), from ${first ?? "none"}${result.notReplayable.firstStoredEventId ? ` (first: ${result.notReplayable.firstStoredEventId})` : ""}; ${result.replayed.holders} holders replayed.`,
	);
	if (result.notReplayable.decisions > 0)
		lines.push(
			`not replayable: ${result.notReplayable.decisions} decisions of ${result.notReplayable.holders} holders could not be decided again and were carried over unchanged (${[...new Set(result.notReplayable.items.map((item) => item.reason))].join(", ")}). A what-if on the grant rules covers only the history the stored inputs reach${first ? `, from ${first} (the first delivery stored)` : ""}.`,
		);
	lines.push(
		`unaffected: ${result.unaffected.events} events no replayed input or command made, carried over as they are; a replay re-decides credits only and cannot change what Stripe charged`,
	);
	return lines.join("\n");
};
