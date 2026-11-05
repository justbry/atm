import type { SubjectState } from "@autumn/balance-engine";
import { menuCatalogRows } from "../billing/grants.js";
import { commandOrg } from "../billing/policy.js";
import type {
	AtmBalance,
	AtmCatalogRow,
	AtmEvent,
	AtmHold,
	AtmSimulateBalanceChange,
	AtmSimulateChange,
	AtmSimulateDecision,
	AtmSimulateInput,
	AtmSimulatePostingChange,
	AtmSimulateRefusal,
	AtmSimulation,
	AtmSubjectState,
} from "../types.js";
import { buildJournal } from "./journal.js";
import { lapsedRows, lapseEvent, mutationToEvents } from "./postings.js";
import {
	balancesOf,
	compareChanges,
	contextFromEvent,
	HANDLER_COMMAND,
	inStoredOrder,
	type RecordedMutation,
	recordedMutations,
	replayEvents,
	replayOrder,
} from "./replay.js";
import { runOnState, toCatalog } from "./run.js";
import { canonicalize, decimalToUnits, unitsToDecimal } from "./util.js";

const MAX_LISTED = 20;
const DETAIL_WIDTH = 60;
const USD = "USD";
const USD_PLACES = 2;

type CommandShape = Record<string, unknown> & {
	type: string;
	commandId: string;
	identity: { customerId: string; entityId: string | null };
	org?: { config?: Record<string, unknown> };
};

type Mutation = ReturnType<typeof runOnState>["mutation"] & object;

type Decision = { mutation: Mutation; before: SubjectState | null };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const oneLine = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error))
		.trim()
		.replace(/\s*\n\s*/g, " ");

/** The row a change is about: its `id`, or its inserted row's. */
const rowIdOf = (change: Record<string, unknown>): string | null => {
	if (typeof change.id === "string") return change.id;
	const row = change.row;
	return isRecord(row) && typeof row.id === "string" ? row.id : null;
};

const describeChange = (change: unknown): AtmSimulateChange => {
	const {
		table,
		op,
		id: _id,
		row,
		...rest
	} = change as Record<string, unknown>;
	return {
		table: String(table),
		op: String(op),
		id: rowIdOf(change as Record<string, unknown>),
		detail: canonicalize(row === undefined ? rest : { ...rest, row }),
	};
};

/** What each side makes that the other does not, as a multiset: a change both make once cancels once. */
const differingChanges = (
	recorded: readonly unknown[],
	candidate: readonly unknown[],
): { removed: AtmSimulateChange[]; added: AtmSimulateChange[] } => {
	const left = recorded.map((c) => ({ c, text: canonicalize(c) }));
	const added: unknown[] = [];
	for (const change of candidate) {
		const text = canonicalize(change);
		const at = left.findIndex((l) => l.text === text);
		if (at < 0) added.push(change);
		else left.splice(at, 1);
	}
	return {
		removed: left.map((l) => describeChange(l.c)),
		added: added.map(describeChange),
	};
};

/** The key a change is matched by across two decisions of one command: its table and row. */
const changeKey = (change: unknown): string => {
	const record = change as Record<string, unknown>;
	const id = rowIdOf(record);
	return id === null
		? canonicalize(change)
		: `${String(record.table)}\u0000${id}`;
};

/**
 * The positions among the candidate's changes that belong to a recorded event: the changes the event's own slice (or,
 * in an old log, its own cut) names, found again by table and row, since a position means nothing once the decision
 * differs. Null when the event covers the whole mutation.
 */
const positionsFor = ({
	event,
	candidateChanges,
}: {
	event: AtmEvent;
	candidateChanges: readonly unknown[];
}): number[] | null => {
	const payload = event.payload as Record<string, unknown>;
	const own = (payload.mutation as RecordedMutation).changes;
	const slice = payload.slice;
	const named = Array.isArray(slice)
		? (slice as number[]).map((position) => own[position])
		: null;
	if (named === null) return null;
	const wanted = new Set(named.map(changeKey));
	const positions: number[] = [];
	for (const [position, change] of candidateChanges.entries())
		if (wanted.has(changeKey(change))) positions.push(position);
	return positions;
};

/** An old log's event holds only its own cut of the mutation and no slice: the same cut, as the changes it holds. */
const oldCutOf = (
	event: AtmEvent,
	recorded: RecordedMutation,
): readonly unknown[] | null => {
	const payload = event.payload as Record<string, unknown>;
	if (Array.isArray(payload.slice)) return null;
	const own = (payload.mutation as RecordedMutation).changes;
	return own.length < recorded.changes.length ? own : null;
};

const withPolicy = (
	command: CommandShape,
	policy: AtmSimulateInput["candidate"]["policy"],
): CommandShape => {
	if (!policy || !isRecord(command.org)) return command;
	return {
		...command,
		org: {
			...command.org,
			config: {
				...(command.org.config ?? {}),
				deduction_order: commandOrg(policy).config.deduction_order,
			},
		},
	};
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Sum of each event's postings by month (the school's calendar), account and commodity. */
const postingTotals = (events: readonly AtmEvent[]): Map<string, bigint> => {
	const totals = new Map<string, bigint>();
	for (const e of events) {
		const month = e.date.slice(0, 7);
		for (const p of e.postings) {
			const key = [month, p.account, p.commodity].join("\u0000");
			const places = p.commodity === USD ? USD_PLACES : 0;
			const units = decimalToUnits(p.amount, places);
			totals.set(key, (totals.get(key) ?? 0n) + units);
		}
	}
	return totals;
};

const postingChangesOf = (
	current: readonly AtmEvent[],
	candidate: readonly AtmEvent[],
): AtmSimulatePostingChange[] => {
	const a = postingTotals(current);
	const b = postingTotals(candidate);
	const out: AtmSimulatePostingChange[] = [];
	for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
		const was = a.get(key) ?? 0n;
		const now = b.get(key) ?? 0n;
		if (was === now) continue;
		const [month, account, commodity] = key.split("\u0000") as [
			string,
			string,
			string,
		];
		const places = commodity === USD ? USD_PLACES : 0;
		out.push({
			month,
			account,
			commodity,
			current: unitsToDecimal(was, places),
			candidate: unitsToDecimal(now, places),
		});
	}
	return out;
};

const balanceChangesOf = (
	current: readonly AtmBalance[],
	candidate: readonly AtmBalance[],
): AtmSimulateBalanceChange[] => {
	const at = (list: readonly AtmBalance[]) =>
		new Map(list.map((b) => [`${b.holder}\u0000${b.feature}`, b]));
	const a = at(current);
	const b = at(candidate);
	const out: AtmSimulateBalanceChange[] = [];
	for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
		const was = a.get(key);
		const now = b.get(key);
		const [holder, feature] = key.split("\u0000") as [string, string];
		const left = { avail: was?.avail ?? 0, held: was?.held ?? 0 };
		const right = { avail: now?.avail ?? 0, held: now?.held ?? 0 };
		if (left.avail === right.avail && left.held === right.held) continue;
		out.push({ holder, feature, current: left, candidate: right });
	}
	return out;
};

const monthsOf = (events: readonly AtmEvent[]) =>
	[...new Set(events.map((e) => e.date.slice(0, 7)))].sort();

const transactionsOf = (
	current: readonly AtmEvent[],
	candidate: readonly AtmEvent[],
	only: string | undefined,
): AtmSimulation["transactions"] => {
	const months = [...new Set([...monthsOf(current), ...monthsOf(candidate)])]
		.sort()
		.filter((month) => only === undefined || month === only);
	return months.map((month) => ({
		month,
		current: buildJournal({ events: current, month }).transactions,
		candidate: buildJournal({ events: candidate, month }).transactions,
	}));
};

const byId = (a: AtmEvent, b: AtmEvent) =>
	a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

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

const rowsOf = (changes: readonly AtmSimulateChange[]): string =>
	changes.length === 0
		? "nothing"
		: changes
				.map((c) => {
					const detail =
						c.op === "insert" ||
						c.detail === "{}" ||
						c.detail.length > DETAIL_WIDTH
							? ""
							: ` ${c.detail}`;
					return `${c.table} ${c.id ?? "?"} ${c.op}${detail}`;
				})
				.join(", ");

const summaryOf = (
	result: Omit<AtmSimulation, "summary" | "events">,
	eventCount: number,
): string => {
	const types = Object.entries(result.unaffected.byType)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([type, count]) => `${type} ${count}`)
		.join(", ");
	return [
		`simulate: ${eventCount} events replayed against the candidate${result.asOf ? `, balances as of ${result.asOf}` : ""}; ${result.differences === 0 ? "no differences" : `${result.differences} differences`}`,
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
			"commands decided differently",
			result.changed,
			(d) =>
				`${d.at} ${d.command} ${d.commandId}: not made ${rowsOf(d.removed)}; made instead ${rowsOf(d.added)}${d.resultChanged ? "; the engine's answer differs" : ""}`,
		),
		...listed(
			"commands the candidate refuses",
			result.refused,
			(r) => `${r.at} ${r.command} ${r.commandId}: ${r.reason}`,
		),
		`unaffected: ${result.unaffected.events} events no command made, carried over as they are${types ? ` (${types})` : ""}; a replay re-decides credits only and cannot change what Stripe charged`,
	].join("\n");
};

/**
 * The log's commands run again under a candidate catalog and policy, and the result set against the log. See
 * `AtmSimulateInput`. The current side is `replayEvents` of the log (so a log it refuses is refused here, with its
 * `ReplayError`); the candidate side takes the same commands in the same order from the same empty start, but does not
 * need the engine to decide what the log recorded. Where it decides the recorded mutation, the recorded events stand as
 * they are; where it decides another, the events are derived again from its mutation, each recorded event keeping its
 * feature, plan and slice (found again by table and row); a command it refuses (the engine throws, decides nothing, or
 * answers `rejected`) is listed with the reason, its events are not made, and the replay goes on from the state before it.
 * Events no command made are carried over as they are, except the cron's expiry of a row, which is judged again on the
 * candidate's row; and a row the candidate holds lapsed at `asOf` that the log's state does not is booked as expired at
 * its expiry, as the cron would have (rows lapsed in the middle of the log and removed by a later command are not). Nothing is written and the inputs are not changed.
 */
export const simulate = (input: AtmSimulateInput): AtmSimulation => {
	const { events, candidate } = input;
	if (input.month !== undefined && !MONTH.test(input.month))
		throw new Error(`month must be YYYY-MM, got ${input.month}`);
	if (input.catalog !== undefined && input.menu !== undefined)
		throw new Error("give the current catalog or the current menu, not both");
	if (candidate.catalog !== undefined && candidate.menu !== undefined)
		throw new Error(
			"give the candidate catalog or the candidate menu, not both",
		);
	const school = input.school ?? events[0]?.school;
	const rowsOf = (
		menu: AtmSimulateInput["menu"],
		which: string,
	): AtmCatalogRow[] => {
		if (!menu) throw new Error(`${which} has neither a catalog nor a menu`);
		if (school === undefined)
			throw new Error(
				`give a school: a menu needs it and the log has no events`,
			);
		return menuCatalogRows({ menu, school });
	};
	const currentRows = input.catalog ?? rowsOf(input.menu, "the current side");
	const candidateRows =
		candidate.catalog ??
		(candidate.menu ? rowsOf(candidate.menu, "the candidate") : currentRows);

	const current = replayEvents({
		events,
		catalog: currentRows,
		asOf: input.asOf,
	});
	const asOfMs = current.asOf ? Date.parse(current.asOf) : 0;

	const catalog = toCatalog(candidateRows);
	const ordered = replayOrder(events);
	const whole = recordedMutations(events);
	const states: Record<string, SubjectState> = {};
	const holds: Record<string, AtmHold> = {};
	const made: AtmEvent[] = [];
	const unaffected = { events: 0, byType: {} as Record<string, number> };
	const changed: (AtmSimulateDecision & { date: string })[] = [];
	const refused: (AtmSimulateRefusal & { date: string })[] = [];

	/** Where the log's own commands leave the subject: what the candidate's rows are compared with where a row lapses. */
	const currentCatalog = toCatalog(currentRows);
	const logStates: Record<string, SubjectState> = {};
	/** The `credit.expired` events of a lapse the candidate's books have (the cron's, carried, or booked here): one each. */
	const lapseIdems = new Set<string>();

	const carry = (e: AtmEvent) => {
		made.push(e);
		unaffected.events += 1;
		unaffected.byType[e.event_type] =
			(unaffected.byType[e.event_type] ?? 0) + 1;
	};

	/** The cron's expiry of a row, on the candidate's row: as it was, with the candidate's balance, or not at all. */
	const lapse = (e: AtmEvent) => {
		const lapsed = (e.payload as { lapsed?: unknown }).lapsed as
			| { table: string; id: string; balance: number; expires_at: number }[]
			| undefined;
		const [row] = lapsed ?? [];
		if (e.event_type !== "credit.expired" || lapsed?.length !== 1 || !row) {
			carry(e);
			return;
		}
		// booked already at the command that found the row lapsed
		if (lapseIdems.has(e.idem)) return;
		const state = states[e.key];
		const found = (
			row.table === "rollovers" ? state?.rollovers : state?.customerEntitlements
		)?.find((r) => r.id === row.id);
		if (!found || found.expires_at !== row.expires_at || found.balance <= 0)
			return;
		lapseIdems.add(e.idem);
		if (found.balance === row.balance) {
			carry(e);
			return;
		}
		made.push({
			...e,
			text: e.text.replace(
				`expired ${row.balance} `,
				`expired ${found.balance} `,
			),
			postings: e.postings.map((p) => ({
				...p,
				amount: `${p.amount.startsWith("-") ? "-" : ""}${found.balance}`,
			})),
			payload: {
				...e.payload,
				lapsed: [{ ...row, balance: found.balance }],
			},
		});
	};

	/** The events of a command decided differently: derived again from the candidate's mutation. */
	const derive = (
		group: AtmEvent[],
		decision: Decision,
		recorded: RecordedMutation,
	): AtmEvent[] => {
		const recordedIdems = new Set(group.map((e) => e.idem));
		const exact = new Map<string, AtmEvent>();
		const extra = new Map<string, AtmEvent>();
		const { command: _command, ...decided } =
			decision.mutation as unknown as Record<string, unknown>;
		const candidateChanges = decision.mutation.changes as readonly unknown[];
		// What the command was (a refund, a settling as forfeited, the reason of an adjustment, the units a lock held) is on
		// some of its events and not on the others: read it from the group, or an event of the group would be made again as
		// if the command were another (a release beside a forfeit would bring a spend with it).
		const fromGroup = <T>(read: (e: AtmEvent) => T | undefined) =>
			group.map(read).find((value) => value !== undefined);
		const settleAs = group.some((e) => e.event_type === "credit.forfeited")
			? "forfeited"
			: "spent";
		const refunded = group.some((e) => e.event_type === "credit.refunded");
		const reason = fromGroup((e) => e.payload.reason as string | undefined);
		const held = fromGroup((e) => e.payload.held as number | undefined);
		for (const e of group) {
			if (e.event_type.startsWith("plan.")) {
				exact.set(e.idem, {
					...e,
					payload: {
						...e.payload,
						command: decision.mutation.command,
						mutation: decided,
					},
				});
				continue;
			}
			const cut = oldCutOf(e, recorded);
			const slice = cut
				? [
						...new Set(
							candidateChanges.flatMap((change, position) =>
								cut.some((c) => changeKey(c) === changeKey(change))
									? [position]
									: [],
							),
						),
					]
				: positionsFor({ event: e, candidateChanges });
			if (slice?.length === 0) continue;
			const context = contextFromEvent(e, decision.before);
			const derived = mutationToEvents({
				mutation: decision.mutation as never,
				context: {
					...context,
					settleAs,
					as: refunded ? "refunded" : undefined,
					reason: context.reason ?? reason,
					held: context.held ?? held,
					slice: slice ?? undefined,
				},
			});
			const match = derived.find((d) => d.idem === e.idem);
			if (match) exact.set(match.idem, match);
			for (const d of derived)
				if (!recordedIdems.has(d.idem) && !extra.has(d.idem))
					extra.set(d.idem, d);
		}
		return [...exact.values(), ...extra.values()];
	};

	const settle = (
		command: CommandShape,
		group: AtmEvent[],
		mutation: Mutation,
	) => {
		for (const e of group) {
			if (e.event_type === "credit.held") {
				const lock = (
					mutation.changes as {
						table: string;
						op: string;
						row?: { id: string };
					}[]
				).find((c) => c.table === "locks" && c.op === "insert");
				const units = Number(
					e.postings.find((p) => p.account.startsWith("credits:held:"))?.amount,
				);
				if (lock?.row)
					holds[lock.row.id] = {
						holder: command.identity.customerId,
						feature: e.labels.feature as string,
						units,
					};
			} else if (
				["credit.released", "credit.spent", "credit.forfeited"].includes(
					e.event_type,
				)
			) {
				const lock = (command as { lock?: { id: string } }).lock;
				if (lock) delete holds[lock.id];
			}
		}
	};

	const groups = new Map<string, AtmEvent[]>();
	for (const e of ordered) {
		const command = (e.payload as { command?: CommandShape }).command;
		if (!command) continue;
		const key = `${command.identity.customerId}\u0000${command.commandId}`;
		groups.set(key, [...(groups.get(key) ?? []), e]);
	}

	/**
	 * Rows the candidate's clock has lapsed by `atMs` and the log's has not. The cron of the log booked what it saw, so a row
	 * the candidate holds that the log's state does not (a rollover the log's menu never made) is booked as expired at its
	 * expiry, as the cron would have, before the next command of the subject moves or removes it. A row both hold lapsed
	 * is the log's to have booked or not: it is left as the log has it.
	 */
	const bookLapses = (key: string, atMs: number) => {
		const state = states[key];
		if (!state) return;
		const lapsedOf = (
			of: SubjectState | undefined,
			featureOf: (internal: string) => string | undefined,
		) => {
			const rows: {
				feature: string;
				row: ReturnType<typeof lapsedRows>[number];
			}[] = [];
			const features = new Set(
				(of?.customerEntitlements ?? []).flatMap(
					(r) => featureOf(r.internal_feature_id) ?? [],
				),
			);
			if (of)
				for (const feature of features)
					for (const row of lapsedRows({ state: of, featureOf, feature, atMs }))
						rows.push({ feature, row });
			return rows;
		};
		const rowKey = (row: ReturnType<typeof lapsedRows>[number]) =>
			[row.table, row.id, row.expires_at].join("\u0000");
		const inLog = new Set(
			lapsedOf(logStates[key], (id) => currentCatalog.features[id]?.id).map(
				({ row }) => rowKey(row),
			),
		);
		for (const { feature, row } of lapsedOf(
			state,
			(id) => catalog.features[id]?.id,
		)) {
			if (inLog.has(rowKey(row))) continue;
			const sibling = [...ordered].reverse().find((e) => e.key === key);
			if (!sibling) continue;
			const plan = [...ordered]
				.reverse()
				.find(
					(e) =>
						e.key === key &&
						e.labels.feature === feature &&
						e.labels.plan !== undefined &&
						Date.parse(e.event_time) <= row.expires_at,
				)?.labels.plan;
			const lapseMade = lapseEvent({
				row,
				holder: key,
				key,
				feature,
				school: sibling.school,
				tz: sibling.tz,
				revision: state.revision,
				labels: plan === undefined ? undefined : { plan },
			});
			if (lapseIdems.has(lapseMade.idem)) continue;
			lapseIdems.add(lapseMade.idem);
			made.push(lapseMade);
		}
	};

	/**
	 * The log's own command on the log's own state, with the current catalog: the state the candidate's is compared with.
	 * Returns the state the command ran on.
	 */
	const advanceLog = (
		command: CommandShape,
		atMs: number,
		recorded: RecordedMutation,
	): SubjectState | null => {
		const subject = command.identity.customerId;
		const before = logStates[subject] ?? null;
		if (before !== null && before.revision >= recorded.revision.after)
			return before;
		const start =
			before && before.revision < recorded.revision.before
				? { ...before, revision: recorded.revision.before }
				: before;
		try {
			const run = runOnState({
				state: start ? clone(start) : null,
				catalog: currentCatalog,
				command: { ...command, occurredAt: atMs },
			});
			if (run.state) logStates[subject] = inStoredOrder(run.state);
		} catch {
			// `replayEvents` ran this command on the same events and did not throw
		}
		return start;
	};

	const handled = new Set<string>();
	for (const e of ordered) {
		const payload = e.payload as { command?: CommandShape; mutation?: unknown };
		const command = payload.command;
		if (!command) {
			lapse(e);
			continue;
		}
		const groupKey = `${command.identity.customerId}\u0000${command.commandId}`;
		if (handled.has(groupKey)) continue;
		handled.add(groupKey);
		const group = groups.get(groupKey) as AtmEvent[];
		const own = payload.mutation as RecordedMutation;
		const gathered = whole.get(`${e.key}\u0000${own.id}`) ?? {
			mutation: own,
			sliced: false,
		};
		const recorded = gathered.mutation;
		const subject = command.identity.customerId;
		const atMs = Date.parse(e.event_time);
		bookLapses(subject, atMs);
		const logStart = advanceLog(command, atMs, recorded);
		const before = states[subject] ?? null;
		if (before !== null && before.revision >= recorded.revision.after) {
			for (const g of group) carry(g);
			continue;
		}
		const header = {
			key: e.key,
			commandId: command.commandId,
			command: command.type,
			at: e.event_time,
			date: e.date,
			eventIds: group.map((g) => g.id),
		};
		const refuse = (reason: string) =>
			refused.push({
				...header,
				reason,
				lost: recorded.changes.map(describeChange),
			});
		// The engine runs at the stored revision, as `replayEvents` has it: a write of the grants row alone moves it with no command.
		const start =
			before && before.revision < recorded.revision.before
				? { ...before, revision: recorded.revision.before }
				: before;
		let run: ReturnType<typeof runOnState>;
		try {
			run = runOnState({
				state: start ? clone(start) : null,
				catalog,
				command: {
					...withPolicy(command, candidate.policy),
					occurredAt: Date.parse(e.event_time),
				},
			});
		} catch (error) {
			refuse(`the engine refused: ${oneLine(error)}`);
			continue;
		}
		if (!run.mutation || !run.state) {
			refuse("the engine decided nothing");
			continue;
		}
		const { command: _decidedCommand, ...decided } =
			run.mutation as unknown as Record<string, unknown>;
		const fit = compareChanges(decided.changes as unknown[], recorded.changes);
		// Fewer recorded changes than decided are an old booking's own cut only in a log of the old shape (0.3.0: a handler
		// command whose events are not marked `complete`); in a log of the current shape they are a decision that adds changes.
		const oldShape =
			HANDLER_COMMAND.test(command.commandId) &&
			group.every(
				(g) => (g.payload as { complete?: unknown }).complete !== true,
			);
		const same =
			canonicalize({ ...decided, changes: null }) ===
				canonicalize({ ...recorded, changes: null }) &&
			(fit === "same" || (fit === "partial" && !gathered.sliced && oldShape));
		// The recorded events carry the postings the log's own rows gave (what a reset expires is what was left): on rows
		// that differ from the log's, the same decision books other credits, so its events are made again.
		const onOtherRows =
			canonicalize({ ...start, revision: 0 }) !==
			canonicalize({ ...logStart, revision: 0 });
		let outcome: AtmEvent[];
		if (same && !onOtherRows) {
			outcome = group;
		} else {
			const result = decided.result as
				| { status?: string; reason?: string | null }
				| undefined;
			if (result?.status === "rejected") {
				refuse(`the engine rejected it: ${result.reason ?? "no reason given"}`);
				continue;
			}
			try {
				outcome = derive(
					group,
					{ mutation: run.mutation, before: start ? clone(start) : null },
					recorded,
				);
			} catch (error) {
				refuse(
					`the engine decided it but its events cannot be booked: ${oneLine(error)}`,
				);
				continue;
			}
			const { removed, added } = differingChanges(
				recorded.changes,
				decided.changes as unknown[],
			);
			const resultChanged =
				canonicalize(decided.result ?? null) !==
				canonicalize((recorded as Record<string, unknown>).result ?? null);
			if (removed.length > 0 || added.length > 0 || resultChanged)
				changed.push({ ...header, removed, added, resultChanged });
		}
		states[subject] = inStoredOrder(run.state);
		made.push(...outcome);
		settle(command, outcome, run.mutation);
	}

	for (const key of Object.keys(states)) bookLapses(key, asOfMs);

	const candidateEvents = [...made].sort(byId);
	const month = input.month;
	const inMonth = (date: string) =>
		month === undefined || date.startsWith(`${month}-`);
	const candidateBalances = balancesOf({
		states: states as unknown as Record<string, AtmSubjectState>,
		holds,
		catalog,
		asOfMs,
	});
	const postingChanges = postingChangesOf(events, candidateEvents).filter(
		(p) => month === undefined || p.month === month,
	);
	const strip = <T extends { date: string }>({
		date: _date,
		...rest
	}: T): Omit<T, "date"> => rest;
	const result: Omit<AtmSimulation, "summary" | "events"> = {
		balances: { current: current.balances, candidate: candidateBalances },
		balanceChanges: balanceChangesOf(current.balances, candidateBalances),
		postingChanges,
		transactions: transactionsOf(events, candidateEvents, month),
		changed: changed.filter((d) => inMonth(d.date)).map(strip),
		refused: refused.filter((r) => inMonth(r.date)).map(strip),
		unaffected,
		differences: 0,
		asOf: current.asOf,
	};
	result.differences =
		result.balanceChanges.length +
		result.postingChanges.length +
		result.changed.length +
		result.refused.length;
	return {
		events: candidateEvents,
		...result,
		summary: summaryOf(result, events.length),
	};
};
