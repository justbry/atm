import type {
	SubjectState,
	SubjectStateMutation,
} from "@autumn/balance-engine";
import type {
	AtmEvent,
	AtmEventContext,
	AtmEventType,
	AtmLedgerEventInput,
	AtmPosting,
} from "../types.js";
import { deterministicUlid } from "./ids.js";
import {
	canonicalize,
	centsToString,
	isoInstant,
	localDate,
	unitsToString,
} from "./util.js";

/** The money commodity: dollars in the books. A credit's commodity must never be this one. */
export const MONEY_COMMODITY = "USD";

/** `visit` -> `VISIT`: a credit commodity is the feature id in capitals, letters only (hledger needs quotes otherwise). */
export const commodityOf = (feature: string): string => {
	const code = feature.toUpperCase().replace(/[^A-Z]/g, "");
	if (!code)
		throw new Error(
			`feature ${JSON.stringify(feature)} has no letters for a commodity`,
		);
	return code;
};

const post = (
	account: string,
	amount: string,
	commodity: string,
): AtmPosting => ({
	account,
	amount,
	commodity,
});

const asMs = (t: string | number): number =>
	typeof t === "number" ? t : Date.parse(t);

/** Fixed field order, so the same event is always the same bytes. */
const buildEvent = (e: {
	type: AtmEventType;
	school: string;
	source: string;
	eventMs: number;
	ingestMs: number;
	tz: string;
	key: string;
	labels: Record<string, string>;
	idem: string;
	cause?: string;
	text: string;
	postings: AtmPosting[];
	payload: Record<string, unknown>;
	redacted?: Record<string, unknown>;
	revision: number;
}): AtmEvent => {
	const sorted = Object.fromEntries(
		Object.entries(e.labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
	const id = deterministicUlid({
		timeMs: e.eventMs,
		revision: e.revision,
		seed: canonicalize([e.school, e.idem]),
	});
	return {
		v: 1,
		id,
		school: e.school,
		source: e.source,
		event_type: e.type,
		event_time: isoInstant(e.eventMs),
		ingest_time: isoInstant(e.ingestMs),
		date: localDate(e.eventMs, e.tz),
		tz: e.tz,
		key: e.key,
		labels: sorted,
		idem: e.idem,
		...(e.cause ? { cause: e.cause } : {}),
		text: e.text,
		postings: e.postings,
		payload: JSON.parse(canonicalize(e.payload)) as Record<string, unknown>,
		...(e.redacted
			? {
					redacted: JSON.parse(canonicalize(e.redacted)) as Record<
						string,
						unknown
					>,
				}
			: {}),
	};
};

// ---------------------------------------------------------------------------------------------------------------
// One rule per event type (the spec's "Event types and postings" table).
// ---------------------------------------------------------------------------------------------------------------

type CreditRule = {
	holder: string;
	feature: string;
	units: number;
	plan?: string;
	service?: string;
};

const avail = (r: CreditRule) => `credits:avail:${r.holder}:${r.feature}`;
const held = (r: CreditRule) => `credits:held:${r.holder}:${r.feature}`;
const need = (v: string | undefined, what: string): string => {
	if (!v) throw new Error(`${what} is required`);
	return v;
};

/** Credit events: positive units, two lines that cancel in the feature's commodity. */
export const creditRules = {
	"credit.granted": (r: CreditRule) => [
		[avail(r), r.units],
		[`credits:issued:${need(r.plan, "plan")}`, -r.units],
	],
	"credit.held": (r: CreditRule) => [
		[avail(r), -r.units],
		[held(r), r.units],
	],
	"credit.released": (r: CreditRule) => [
		[avail(r), r.units],
		[held(r), -r.units],
	],
	"credit.spent": (r: CreditRule) => [
		[held(r), -r.units],
		[`credits:spent:${need(r.service, "service")}`, r.units],
	],
	"credit.refunded": (r: CreditRule) => [
		[`credits:spent:${need(r.service, "service")}`, -r.units],
		[avail(r), r.units],
	],
	"credit.forfeited": (r: CreditRule) => [
		[held(r), -r.units],
		["credits:forfeited", r.units],
	],
	"credit.expired": (r: CreditRule) => [
		[avail(r), -r.units],
		["credits:expired", r.units],
	],
} as const;

/** `credit.adjusted` goes either way: positive units add to the balance. */
const adjustedLines = (r: CreditRule, signed: number): [string, number][] => [
	[avail(r), signed],
	["credits:adjust", -signed],
];

type CreditType = keyof typeof creditRules | "credit.adjusted";

/** Credit events that say something about a balance without moving it: no postings. */
type BookkeepingOnly =
	| "credit.expiration_changed"
	| "credit.low"
	| "credit.depleted";
const isAlert = (type: string): type is "credit.low" | "credit.depleted" =>
	type === "credit.low" || type === "credit.depleted";
const isBookkeepingOnly = (type: string): type is BookkeepingOnly =>
	type === "credit.expiration_changed" || isAlert(type);

const creditPostings = (
	type: CreditType,
	r: CreditRule,
	signed?: number,
): AtmPosting[] => {
	const commodity = commodityOf(r.feature);
	const lines =
		type === "credit.adjusted"
			? adjustedLines(r, signed ?? 0)
			: (creditRules[type](r) as unknown as [string, number][]);
	return lines.map(([account, n]) =>
		post(account, unitsToString(n), commodity),
	);
};

const usd = (account: string, cents: number) =>
	post(account, centsToString(cents), MONEY_COMMODITY);

/** Money and bookkeeping events, which have no engine mutation behind them. */
export const moneyPostings = (i: AtmLedgerEventInput): AtmPosting[] => {
	const amount = i.amount ?? 0;
	const positive = () => {
		if (!Number.isInteger(amount) || amount <= 0) {
			throw new Error(`${i.type} needs a positive whole amount of cents`);
		}
		return amount;
	};
	switch (i.type) {
		case "payment.succeeded": {
			const gross = positive();
			const fee = i.fee ?? 0;
			const lines = [usd("assets:stripe", gross - fee)];
			if (fee !== 0) lines.push(usd("expenses:billing:stripe-fees", fee));
			lines.push(
				usd(`income:billing:${need(i.incomeKind, "incomeKind")}`, -gross),
			);
			return lines;
		}
		case "payment.refunded":
			return [
				usd("assets:stripe", -positive()),
				usd("income:billing:refunds", amount),
			];
		case "payment.disputed":
			return [
				usd("assets:stripe", -positive()),
				usd("expenses:billing:disputes", amount),
			];
		case "dispute.closed":
			// Won: the money comes back. Lost: the dispute's own debit already stands.
			return i.won
				? [
						usd("assets:stripe", positive()),
						usd("expenses:billing:disputes", -amount),
					]
				: [];
		case "payout.paid":
			return [
				usd("assets:stripe", -positive()),
				usd("assets:clearing:stripe-payouts", amount),
			];
		case "fundraise.received":
			return [
				usd("assets:clearing:zeffy", positive()),
				usd(`income:fundraising:${need(i.campaign, "campaign")}`, -amount),
			];
		case "fundraise.paid_out":
			return [
				usd("assets:clearing:zeffy", -positive()),
				usd("assets:clearing:zeffy-payouts", amount),
			];
		case "share.charged":
			return [
				usd("expenses:billing:b4uni-share", positive()),
				usd("liabilities:b4uni", -amount),
			];
		case "plan.attached":
		case "plan.changed":
		case "plan.canceled":
		case "subject.erased":
		case "referral.qualified":
		case "referral.rewarded":
		case "catalog.published":
		case "policy.published":
			return [];
		default:
			throw new Error(`${i.type} is an engine event: use mutationToEvents`);
	}
};

const defaultSource = (type: AtmEventType): string => {
	if (
		type.startsWith("payment.") ||
		type === "dispute.closed" ||
		type === "payout.paid"
	)
		return "stripe";
	if (type.startsWith("fundraise.")) return "zeffy";
	return "family";
};

/** Personal fields stripped from a payment's payload for readers that must not carry them. */
const PERSONAL: Partial<Record<AtmEventType, string[]>> = {
	"payment.succeeded": ["billing_email", "billing_name"],
	"payment.refunded": ["billing_email", "billing_name"],
};

export const redactPayload = (
	type: AtmEventType,
	payload: Record<string, unknown>,
): Record<string, unknown> | undefined => {
	const fields = PERSONAL[type];
	if (!fields || !fields.some((f) => f in payload)) return undefined;
	return Object.fromEntries(
		Object.entries(payload).filter(([k]) => !fields.includes(k)),
	);
};

/** An event that is not an engine mutation: a payment, payout, plan change or other bookkeeping line. */
export const ledgerEvent = (i: AtmLedgerEventInput): AtmEvent => {
	const postings = moneyPostings(i);
	const payload = i.payload ?? {};
	const eventMs = asMs(i.eventTime);
	const money = i.amount !== undefined ? ` ${centsToString(i.amount)} USD` : "";
	return buildEvent({
		type: i.type,
		school: i.school,
		source: i.source ?? defaultSource(i.type),
		eventMs,
		ingestMs: i.ingestTime === undefined ? eventMs : asMs(i.ingestTime),
		tz: i.tz,
		key: i.key,
		labels: i.labels ?? {},
		idem: i.idem,
		cause: i.cause,
		text: i.text ?? `${i.type.replace(".", " ")}${money}`,
		postings,
		payload,
		redacted: i.redacted ?? redactPayload(i.type, payload),
		revision: i.revision ?? 0,
	});
};

// ---------------------------------------------------------------------------------------------------------------
// Engine mutations to events.
// ---------------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const isLive = (expiresAt: unknown, atMs: number) =>
	expiresAt === null || expiresAt === undefined || (expiresAt as number) > atMs;

const beforeRow = (
	before: SubjectState | null | undefined,
	table: "customerEntitlements" | "rollovers",
	id: string,
): Row | undefined =>
	(before?.[table] as Row[] | undefined)?.find((r) => r.id === id);

/**
 * How much the feature's available balance moved, read off the row changes: balance columns on grants,
 * rollovers inserted, trimmed or removed. A rollover already past its expiry is not part of the balance
 * (the engine drops it by the clock and the cron books its expiry), so a change to it moves nothing.
 */
const balanceMoves = (
	m: SubjectStateMutation,
	before: SubjectState | null | undefined,
	atMs: number,
) => {
	let inserted = 0; // new balance rows (grants, carried-over rollovers)
	let delta = 0;
	let rolled = 0;
	let rolloverExpiry: number | null = null;
	let refilled = 0;
	let replaced = 0;
	for (const c of m.changes) {
		if (c.table === "customerEntitlements") {
			if (c.op === "insert") {
				inserted += num(c.row.balance);
				delta += num(c.row.balance);
			} else if (c.op === "increment") delta += num(c.add.balance);
			else if (c.op === "update") {
				const a = (c.after as Row).balance;
				const b = (c.before as Row).balance;
				if (typeof a === "number" && typeof b === "number") {
					refilled += a;
					replaced += b;
					delta += a - b;
				}
			} else {
				const row = beforeRow(before, "customerEntitlements", c.id);
				if (!before || !row)
					throw new Error(
						`cannot tell the balance row ${c.id} held: pass context.before`,
					);
				if (isLive(row.expires_at, atMs)) delta -= num(row.balance);
			}
		} else if (c.table === "rollovers") {
			const row =
				c.op === "insert" ? undefined : beforeRow(before, "rollovers", c.id);
			if (c.op === "insert") {
				rolled += num(c.row.balance);
				delta += num(c.row.balance);
				if (num(c.row.balance) > 0 && c.row.expires_at != null) {
					rolloverExpiry =
						rolloverExpiry === null
							? (c.row.expires_at as number)
							: Math.min(rolloverExpiry, c.row.expires_at as number);
				}
			} else if (row && !isLive(row.expires_at, atMs)) {
			} else if (c.op === "increment") delta += num(c.add.balance);
			else if (c.op === "update") {
				const a = (c.after as Row).balance;
				const b = (c.before as Row).balance;
				if (typeof a === "number" && typeof b === "number") delta += a - b;
			} else {
				if (!row)
					throw new Error(
						`cannot tell the rollover ${c.id} held: pass context.before`,
					);
				delta -= num(row.balance);
			}
		}
	}
	return { inserted, delta, rolled, rolloverExpiry, refilled, replaced };
};

type ExpiryMove = {
	rowId: string;
	previousExpiresAt: number | null;
	expiresAt: number;
	/** The same write cleared `next_reset_at`: the row no longer refills. */
	refillsEnded: boolean;
};

/**
 * Balance rows whose `expires_at` the mutation moved to a date without touching their balance: the credits stay, their
 * end date moves (a canceled subscription stops refilling and lets the last cycle's credits run out on their own clock).
 * A row that gets a new balance in the same change is a reset or a refill, not this; an expiry cleared to none is not
 * reported (nothing ends).
 */
const expiryMoves = (m: SubjectStateMutation): ExpiryMove[] => {
	const moves: ExpiryMove[] = [];
	// A row whose balance moves anywhere in the mutation (an increment as well as a set) is a draw or a refill.
	const balanceMoved = new Set(
		m.changes.flatMap((c) =>
			c.table === "customerEntitlements" &&
			c.op === "increment" &&
			"balance" in ((c as { add?: Record<string, unknown> }).add ?? {})
				? [c.id]
				: [],
		),
	);
	for (const c of m.changes) {
		if (c.table !== "customerEntitlements" || c.op !== "update") continue;
		const before = c.before as Row;
		const after = c.after as Row;
		if (!("expires_at" in after) || typeof after.expires_at !== "number")
			continue;
		const previous = (before.expires_at as number | null | undefined) ?? null;
		if (previous === after.expires_at) continue;
		if (balanceMoved.has(c.id)) continue;
		if ("balance" in after && after.balance !== before.balance) continue;
		moves.push({
			rowId: c.id,
			previousExpiresAt: previous,
			expiresAt: after.expires_at,
			refillsEnded:
				after.next_reset_at === null && (before.next_reset_at ?? null) !== null,
		});
	}
	return moves;
};

type AvailableAround = { before: number; after: number };

/**
 * The feature's available balance before and after a draw, summed over all its credit rows as `balancesOf` counts it
 * (balance rows and rollovers not yet past their expiry at the time of the command); holds already came off the rows.
 * `given` are the changes the caller says make up the feature's move; without them, the mutation's changes to the rows
 * of `drawnFeature` (the internal feature the command draws), so a multi-feature mutation never sums features.
 * `before` is the state they were computed against. Null when nothing is drawn (the balance does not go down), when no
 * state is given, or when the changes touch no balance row.
 */
const availableAround = (
	m: SubjectStateMutation,
	given: SubjectStateMutation["changes"] | null,
	drawnFeature: string | undefined,
	before: SubjectState | null | undefined,
	atMs: number,
): AvailableAround | null => {
	if (!before) return null;
	const internalOf = new Map<string, string>();
	for (const r of before.customerEntitlements)
		internalOf.set(r.id, r.internal_feature_id);
	for (const c of given ?? m.changes)
		if (c.table === "customerEntitlements" && c.op === "insert")
			internalOf.set(
				(c.row as Row).id as string,
				(c.row as Row).internal_feature_id as string,
			);
	const owners = new Map<string, string>();
	for (const r of before.rollovers) owners.set(r.id, r.cus_ent_id);
	const featureOfChange = (
		c: SubjectStateMutation["changes"][number],
	): string | undefined => {
		if (c.table === "customerEntitlements")
			return internalOf.get(
				c.op === "insert" ? ((c.row as Row).id as string) : c.id,
			);
		if (c.table !== "rollovers") return undefined;
		const owner =
			c.op === "insert"
				? ((c.row as Row).cus_ent_id as string)
				: owners.get(c.id);
		return owner ? internalOf.get(owner) : undefined;
	};
	const changes =
		given ??
		(drawnFeature === undefined
			? m.changes
			: m.changes.filter((c) => featureOfChange(c) === drawnFeature));
	const { delta } = balanceMoves(
		{ ...m, changes } as SubjectStateMutation,
		before,
		atMs,
	);
	if (delta >= 0) return null;
	const features = new Set<string>();
	for (const c of changes) {
		const internal = featureOfChange(c);
		if (internal) features.add(internal);
	}
	if (features.size === 0) return null;
	const rowIds = new Set<string>();
	let total = 0;
	for (const r of before.customerEntitlements) {
		if (!features.has(r.internal_feature_id)) continue;
		rowIds.add(r.id);
		if (isLive(r.expires_at, atMs)) total += r.balance;
	}
	for (const r of before.rollovers)
		if (rowIds.has(r.cus_ent_id) && isLive(r.expires_at, atMs))
			total += r.balance;
	return { before: total, after: total + delta };
};

/**
 * Units a release kept off its lock (`payload.withheld`, written by the booking commands, so a replay reads it back): the
 * lock it finalizes holds only the units that come back, and these left `credits:held` too. `expired` lapsed while held
 * (their row lapsed, or reset with no rollover room for them); `refunded` belong to an invoice refunded or lost in a
 * dispute while they were held. Each is booked as released and then expired or adjusted (with `reason`). None: zeros.
 */
const withheldOf = (
	payload: Record<string, unknown> | undefined,
): { expired: number; refunded: number; reason?: string } => {
	const withheld = payload?.withheld as
		| { expired?: unknown; refunded?: unknown; reason?: unknown }
		| undefined;
	const units = (value: unknown) =>
		typeof value === "number" && Number.isSafeInteger(value) && value > 0
			? value
			: 0;
	return {
		expired: units(withheld?.expired),
		refunded: units(withheld?.refunded),
		...(typeof withheld?.reason === "string"
			? { reason: withheld.reason }
			: {}),
	};
};

const bookingOf = (m: SubjectStateMutation): string | undefined => {
	const lockInsert = m.changes.find(
		(c) => c.table === "locks" && c.op === "insert",
	);
	if (lockInsert && lockInsert.op === "insert")
		return (lockInsert.row as { lock_id: string }).lock_id;
	const lock = (m.command as unknown as { lock?: { lock_id?: string } }).lock;
	return lock?.lock_id;
};

/**
 * The events an engine mutation makes, with their postings. The accounts come from the row changes, one rule per
 * event type; nothing is written by hand per event. A reset is a `credit.expired` for what does not roll over plus
 * a `credit.granted` for the new cycle; what rolls over stays in `credits:avail` with `labels.expires_at`.
 * A mutation that moves nothing makes no events.
 */
export const mutationToEvents = ({
	mutation,
	context,
}: {
	mutation: SubjectStateMutation;
	context: AtmEventContext;
}): AtmEvent[] => {
	const command = mutation.command as unknown as Record<string, unknown> & {
		type: string;
		occurredAt: number;
	};
	const atMs = command.occurredAt;
	const holder = mutation.identity.entityId ?? mutation.identity.customerId;
	const feature = context.feature;
	const commodity = commodityOf(feature);
	const { id: mutationId, revision } = mutation;
	const { command: _command, ...mutationWithoutCommand } =
		mutation as unknown as Record<string, unknown>;
	// The events are made from the slice the caller names; the payload keeps the whole mutation.
	const moved: SubjectStateMutation = context.slice
		? ({
				...mutation,
				changes: context.slice.map((position) => mutation.changes[position]),
			} as SubjectStateMutation)
		: mutation;
	const booking = bookingOf(moved);
	const baseLabels: Record<string, string> = {
		feature,
		...(mutation.identity.entityId
			? { entity: mutation.identity.entityId }
			: {}),
		...(context.plan ? { plan: context.plan } : {}),
		...(context.service ? { service: context.service } : {}),
		...(booking ? { booking } : {}),
		...(context.labels ?? {}),
	};
	const made: AtmEvent[] = [];
	const emit = (
		type: CreditType | BookkeepingOnly,
		suffix: string,
		units: number,
		text: string,
		extra: {
			signed?: number;
			labels?: Record<string, string>;
			payload?: Record<string, unknown>;
		} = {},
	) => {
		const rule: CreditRule = {
			holder,
			feature,
			units,
			plan: context.plan,
			service: context.service,
		};
		const labels = { ...baseLabels, ...(extra.labels ?? {}) };
		// An alert judges the feature's total over every plan, so no one plan names it.
		if (isAlert(type)) delete labels.plan;
		made.push(
			buildEvent({
				type,
				school: context.school,
				source: context.source ?? "family",
				eventMs: atMs,
				ingestMs:
					context.ingestTime === undefined ? atMs : asMs(context.ingestTime),
				tz: context.tz,
				key: mutation.identity.customerId,
				labels,
				idem: `${context.idemPrefix ?? "engine"}:${mutationId}:${suffix}`,
				cause: context.cause,
				text,
				postings: isBookkeepingOnly(type)
					? []
					: creditPostings(type, rule, extra.signed),
				payload: {
					command: mutation.command,
					mutation: mutationWithoutCommand,
					...(context.slice ? { slice: context.slice } : {}),
					...(context.payload ?? {}),
					...(extra.payload ?? {}),
				},
				revision: revision.after,
			}),
		);
	};
	const what = (n: number) => `${n} ${feature}`;
	const moves = balanceMoves(
		moved,
		context.before as unknown as SubjectState | null | undefined,
		atMs,
	);

	switch (command.type) {
		case "track": {
			const result = mutation.result as {
				status: string;
				deltas: { balanceDelta: number }[];
			};
			if (result.status !== "applied") return [];
			if (!booking)
				throw new Error("a spend books a hold first: track with a lock");
			const n = result.deltas.reduce((s, d) => s - d.balanceDelta, 0);
			if (n > 0)
				emit("credit.held", "held", n, `held ${what(n)} for ${booking}`);
			break;
		}
		case "finalize": {
			const result = mutation.result as {
				status: string;
				lockValue: number;
				finalValue: number;
			};
			if (result.status !== "applied") return [];
			const { lockValue: lockUnits, finalValue } = result;
			if (finalValue > lockUnits)
				throw new Error(
					"a finalize above its lock deducts more; not mapped to an event",
				);
			const withheld = withheldOf(context.payload);
			const released =
				lockUnits - finalValue + withheld.expired + withheld.refunded;
			if (released > 0)
				emit(
					"credit.released",
					"released",
					released,
					`released ${what(released)} for ${booking}`,
				);
			if (withheld.expired > 0)
				emit(
					"credit.expired",
					"expired",
					withheld.expired,
					`expired ${what(withheld.expired)} held for ${booking}: they lapsed while held`,
				);
			if (withheld.refunded > 0)
				emit(
					"credit.adjusted",
					"adjusted",
					withheld.refunded,
					`adjusted -${withheld.refunded} ${feature}`,
					{
						signed: -withheld.refunded,
						payload: { reason: need(withheld.reason, "withheld.reason") },
					},
				);
			if (finalValue > 0) {
				if (context.settleAs === "forfeited")
					emit(
						"credit.forfeited",
						"forfeited",
						finalValue,
						`forfeited ${what(finalValue)} for ${booking}`,
					);
				else
					emit(
						"credit.spent",
						"spent",
						finalValue,
						`spent ${what(finalValue)} on ${need(context.service, "service")}`,
					);
			}
			break;
		}
		case "confirmExpiredLock": {
			const n = need(
				context.held === undefined ? undefined : String(context.held),
				"context.held (units the lock held)",
			);
			const units = Number(n);
			if (context.settleAs === "spent")
				emit(
					"credit.spent",
					"spent",
					units,
					`spent ${what(units)} on ${need(context.service, "service")}`,
					{ payload: { held: units } },
				);
			else
				emit(
					"credit.forfeited",
					"forfeited",
					units,
					`forfeited ${what(units)} for ${booking}`,
					{ payload: { held: units } },
				);
			break;
		}
		case "reset": {
			if (moves.refilled === 0 && moves.rolled === 0 && moves.replaced === 0)
				break;
			const granted = moves.refilled;
			const expired = granted - moves.delta;
			if (expired < 0)
				throw new Error(`a reset cannot add more than it refills (${expired})`);
			if (expired > 0)
				emit(
					"credit.expired",
					"expired",
					expired,
					`expired ${what(expired)} at reset`,
					{ payload: { leftover: moves.replaced, rolled_over: moves.rolled } },
				);
			if (granted > 0) {
				emit(
					"credit.granted",
					"granted",
					granted,
					`granted ${what(granted)} on ${need(context.plan, "plan")}${moves.rolled > 0 ? `, ${moves.rolled} rolled over` : ""}`,
					{
						labels:
							moves.rolled > 0 && moves.rolloverExpiry !== null
								? {
										rolled_over: String(moves.rolled),
										expires_at: isoInstant(moves.rolloverExpiry),
									}
								: {},
					},
				);
			}
			break;
		}
		case "applyBillingPlan": {
			if (moves.delta > 0) {
				const grantExpiry = moved.changes.flatMap((c) =>
					c.table === "customerEntitlements" &&
					c.op === "insert" &&
					c.row.expires_at != null
						? [c.row.expires_at as number]
						: [],
				)[0];
				emit(
					"credit.granted",
					"granted",
					moves.delta,
					`granted ${what(moves.delta)} on ${need(context.plan, "plan")}`,
					{
						labels:
							grantExpiry === undefined
								? {}
								: { expires_at: isoInstant(grantExpiry) },
					},
				);
			} else if (moves.delta < 0) {
				emit(
					"credit.adjusted",
					"adjusted",
					-moves.delta,
					`adjusted ${what(moves.delta)}`,
					{
						signed: moves.delta,
						payload: { reason: need(context.reason, "context.reason") },
					},
				);
			}
			break;
		}
		case "updateBalance":
		case "deleteBalance":
		case "recalculateBalance": {
			const d = moves.delta;
			if (d === 0) break;
			if (d > 0 && context.as === "refunded") {
				emit(
					"credit.refunded",
					"refunded",
					d,
					`refunded ${what(d)} on ${need(context.service, "service")}`,
				);
			} else {
				emit(
					"credit.adjusted",
					"adjusted",
					Math.abs(d),
					`adjusted ${d > 0 ? "+" : ""}${d} ${feature}`,
					{
						signed: d,
						payload: { reason: need(context.reason, "context.reason") },
					},
				);
			}
			break;
		}
		default:
			throw new Error(`no ledger events for a ${command.type} command`);
	}
	for (const expiry of expiryMoves(moved)) {
		const date = isoInstant(expiry.expiresAt);
		// The key is scoped to the command: row ids repeat across holders (every family has a ce_tier_visit_month).
		emit(
			"credit.expiration_changed",
			`expiry:${expiry.rowId}`,
			0,
			`${feature} credits now expire ${date}${expiry.refillsEnded ? ", refills ended" : ""}`,
			{
				labels: { expires_at: date },
				payload: {
					row_id: expiry.rowId,
					previous_expires_at: expiry.previousExpiresAt,
					expires_at: expiry.expiresAt,
					refills_ended: expiry.refillsEnded,
				},
			},
		);
	}
	// Alerts are for draws by the family's own activity only: a booking's hold (`track`) or its settling (`finalize`).
	// The rules' own take-backs (a refund or lost dispute is an `applyBillingPlan`), edits by hand and resets make none,
	// so a refund never sends "pack used up". The alerts are opt-in: without `lowCreditThreshold`, the events it always got.
	const threshold = context.lowCreditThreshold;
	const isDraw = command.type === "track" || command.type === "finalize";
	const around =
		!isDraw || threshold === undefined
			? null
			: availableAround(
					moved,
					(context.featureChanges as unknown as
						| SubjectStateMutation["changes"]
						| undefined) ?? null,
					command.internalFeatureId as string | undefined,
					context.before as unknown as SubjectState | null | undefined,
					atMs,
				);
	if (around && threshold !== undefined) {
		const alertPayload = (limit: number | null) => ({
			feature,
			available: around.after,
			threshold: limit,
			previous_available: around.before,
		});
		if (around.before > 0 && around.after <= 0) {
			emit(
				"credit.depleted",
				`depleted:${feature}`,
				0,
				`${feature} credits used up`,
				{ payload: alertPayload(null) },
			);
		} else if (
			around.before > threshold &&
			around.after > 0 &&
			around.after <= threshold
		) {
			emit(
				"credit.low",
				`low:${feature}`,
				0,
				`${around.after} ${feature} left`,
				{ payload: alertPayload(threshold) },
			);
		}
	}
	void commodity;
	return made;
};

/**
 * The record of a command that moved no credits (the cycle-end update after a renewal, a plan change that keeps the
 * sessions): a `plan.changed` with the command and its whole mutation and no postings. Every command the writer ran is in
 * the log once, so a replay can run the whole chain and its revisions follow on. `complete` is the writer's claim that it
 * logs every command it runs (`payload.complete`, read by `replayEvents`).
 */
export const planChangedEvent = ({
	mutation,
	tz,
	cause,
	labels,
	source,
	ingestTime,
	complete,
}: {
	mutation: SubjectStateMutation;
	tz: string;
	cause?: string;
	labels?: Record<string, string>;
	source?: string;
	ingestTime?: string | number;
	complete: boolean;
}): AtmEvent => {
	const { command, ...decided } = mutation as unknown as Record<
		string,
		unknown
	> & { command: { type: string; occurredAt: number } };
	return ledgerEvent({
		type: "plan.changed",
		school: mutation.identity.orgId,
		tz,
		eventTime: command.occurredAt,
		ingestTime,
		source,
		key: mutation.identity.customerId,
		idem: `plan:${mutation.id}`,
		cause,
		labels,
		text: `${command.type} moved no credits`,
		payload: { command, mutation: decided, ...(complete ? { complete } : {}) },
		revision: mutation.revision.after,
	});
};

// ---------------------------------------------------------------------------------------------------------------
// Expiry by the clock (no mutation: the engine drops lapsed rows when it reads, the cron books the expiry).
// ---------------------------------------------------------------------------------------------------------------

export type LapsedRow = {
	table: "customerEntitlements" | "rollovers";
	id: string;
	balance: number;
	expires_at: number;
};

/** Rows of `feature` past their expiry at `atMs` that still hold a balance. */
export const lapsedRows = ({
	state,
	featureOf,
	feature,
	atMs,
}: {
	state: SubjectState;
	/** Maps a row's `internal_feature_id` to a feature id. */
	featureOf: (internalFeatureId: string) => string | undefined;
	feature: string;
	atMs: number;
}): LapsedRow[] => {
	const own = state.customerEntitlements.filter(
		(r) => featureOf(r.internal_feature_id) === feature,
	);
	const out: LapsedRow[] = [];
	for (const r of own) {
		if (r.expires_at != null && r.expires_at <= atMs && r.balance > 0) {
			out.push({
				table: "customerEntitlements",
				id: r.id,
				balance: r.balance,
				expires_at: r.expires_at,
			});
		}
	}
	const ids = new Set(own.map((r) => r.id));
	for (const r of state.rollovers) {
		if (
			ids.has(r.cus_ent_id) &&
			r.expires_at != null &&
			r.expires_at <= atMs &&
			r.balance > 0
		) {
			out.push({
				table: "rollovers",
				id: r.id,
				balance: r.balance,
				expires_at: r.expires_at,
			});
		}
	}
	return out.sort(
		(a, b) => a.expires_at - b.expires_at || (a.id < b.id ? -1 : 1),
	);
};

/**
 * The `credit.expired` event for one lapsed row, at the instant it lapsed. Idempotent on the holder, the row and its
 * expiry: row ids repeat across holders (every family has a `ce_tier_visit_month`), and the ledger keeps one event per
 * idem for the whole school.
 */
export const lapseEvent = ({
	row,
	holder,
	key,
	feature,
	school,
	tz,
	revision,
	labels,
	ingestTime,
}: {
	row: LapsedRow;
	holder: string;
	key: string;
	feature: string;
	school: string;
	tz: string;
	revision: number;
	labels?: Record<string, string>;
	ingestTime?: string | number;
}): AtmEvent =>
	buildEvent({
		type: "credit.expired",
		school,
		source: "cron",
		eventMs: row.expires_at,
		ingestMs: ingestTime === undefined ? row.expires_at : asMs(ingestTime),
		tz,
		key,
		labels: { feature, ...(labels ?? {}) },
		idem: `lapse:${key}:${row.id}:${row.expires_at}`,
		text: `expired ${row.balance} ${feature} (${row.table === "rollovers" ? "rollover" : "grant"} lapsed)`,
		postings: creditPostings("credit.expired", {
			holder,
			feature,
			units: row.balance,
		}),
		payload: { lapsed: [row] },
		revision,
	});

/** The largest revision an id holds (24 bits): `deterministicUlid` clamps above it, which would tie the alert with its expiries. */
const MAX_REVISION = 0xffffff;

/** The units drawn strictly after `atMs`, as the caller counted them: a negative count is no draw, and one that is not finite is an error. */
const drawnSince = (
	drawnAfter: (instantMs: number) => number,
	atMs: number,
): number => {
	const drawn = drawnAfter(atMs);
	if (typeof drawn !== "number" || !Number.isFinite(drawn))
		throw new Error(
			`lapseAlertEvents: drawnAfter(${atMs}) must be a finite number, got ${String(drawn)}`,
		);
	return Math.max(drawn, 0);
};

/**
 * What `feature` held in live rows and rollovers at `atMs`: a row with no expiry, or one that ends after it, at its
 * current balance, plus `drawn`, the units drawn since that the current balances no longer hold.
 */
const liveTotalAt = ({
	state,
	featureOf,
	feature,
	atMs,
	drawn,
}: {
	state: SubjectState;
	featureOf: (internalFeatureId: string) => string | undefined;
	feature: string;
	atMs: number;
	drawn: number;
}): number => {
	const own = state.customerEntitlements.filter(
		(r) => featureOf(r.internal_feature_id) === feature,
	);
	const ids = new Set(own.map((r) => r.id));
	let total = 0;
	for (const r of own) if (isLive(r.expires_at, atMs)) total += r.balance;
	for (const r of state.rollovers)
		if (ids.has(r.cus_ent_id) && isLive(r.expires_at, atMs)) total += r.balance;
	return total + drawn;
};

/**
 * The `credit.depleted` events for a feature whose credits ran out by the clock: for each instant a row lapsed (up to
 * `atMs`), the feature's total over every plan goes from above 0 just before it to 0 or below at it. Rows that lapse at
 * the same instant (two packs, a rollover and its grant) make one event, and a lapse that leaves other credits makes
 * none. There is no `credit.low` on a lapse. Opt-in by being called: `lapseEvent` makes the same `credit.expired`
 * events with or without it, so a cron that never calls this gets what it always got. Idempotent on the holder key, the
 * feature and the instant, so a second run on the same state books nothing new.
 *
 * The state holds the balances now, not at the lapse, and records no draw times, so a cron that runs late would judge
 * a past instant on credits the family has since drawn from another live row (grant A holds 10 and lapses at t1, grant
 * B holds 5 with no expiry, the family draws 5 from B at t2 > t1: the truth at t1 is 15 down to 5, no event, but the
 * state shows 0). `drawnAfter(t)` closes that: it returns the units of this feature the holder drew STRICTLY after `t`
 * and up to `atMs` (a draw at the time `t` itself is not counted), which the cron reads from its ledger or journal. For a
 * lapse at the instant `I` it is called once, with `I - 1`, so it counts the draws at `I` or later: a draw at exactly `I`
 * could not have used the row that lapsed at `I`, so it counts as after the lapse. That one number is added back to the
 * current balances for BOTH totals the alert compares (just before `I`, and at `I`), so a draw at exactly `I` is never
 * counted on one side only. It is required, not defaulted, because a default of 0 would keep the bug for a caller that
 * did not think of it. Only draws count: a refund take-back, a reset or an admin edit after the
 * instant is not added back unless the caller folds it into the number. A negative return counts as 0 and one that is
 * not a finite number throws. `() => 0` is right only when `state` is as of the lapse (the state the cron gave
 * `lapsedRows`, before it books anything later); on a later state it gives the wrong answer described above.
 *
 * The `credit.depleted` shares its `eventMs` with the `credit.expired` events of the same instant (`lapseEvent`), and
 * every order the ledger has (`replayOrder`, the journal, the month files) compares ids: the instant, then 24 bits of
 * revision, then a hash. So `revision` is the revision of the `credit.expired` events, the highest if you number them
 * apart, and the alert takes `revision + 1` itself: it sorts after every `credit.expired` of that instant and holder,
 * not by the hash that would order two events of one revision. Its `eventMs` stays the instant. The idempotency key does
 * not carry the revision. A `revision` of 16777215 (the largest the id holds) or more, or one that is not a whole
 * number, throws.
 */
export const lapseAlertEvents = ({
	state,
	featureOf,
	feature,
	atMs,
	drawnAfter,
	key,
	school,
	tz,
	revision,
	labels,
	ingestTime,
}: {
	state: SubjectState;
	featureOf: (internalFeatureId: string) => string | undefined;
	feature: string;
	atMs: number;
	/** The units of `feature` the holder drew strictly after `t` and up to `atMs` (draws only; called with `instant - 1`, see above). */
	drawnAfter: (instantMs: number) => number;
	key: string;
	school: string;
	tz: string;
	revision: number;
	labels?: Record<string, string>;
	ingestTime?: string | number;
}): AtmEvent[] => {
	// Checked before the first lapse is found, so a caller that never passes it is told at once, not on the day a row lapses.
	if (typeof drawnAfter !== "function")
		throw new Error(
			`lapseAlertEvents: drawnAfter must be a function, got ${String(drawnAfter)}`,
		);
	if (!Number.isInteger(revision) || revision < 0 || revision >= MAX_REVISION)
		throw new Error(
			`lapseAlertEvents: revision must be a whole number from 0 to ${MAX_REVISION - 1}, got ${String(revision)}`,
		);
	const instants = new Set<number>();
	for (const row of lapsedRows({ state, featureOf, feature, atMs }))
		instants.add(row.expires_at);
	const events: AtmEvent[] = [];
	for (const instant of [...instants].sort((a, b) => a - b)) {
		const drawn = drawnSince(drawnAfter, instant - 1);
		const before = liveTotalAt({
			state,
			featureOf,
			feature,
			atMs: instant - 1,
			drawn,
		});
		const after = liveTotalAt({
			state,
			featureOf,
			feature,
			atMs: instant,
			drawn,
		});
		if (before <= 0 || after > 0) continue;
		events.push(
			buildEvent({
				type: "credit.depleted",
				school,
				source: "cron",
				eventMs: instant,
				ingestMs: ingestTime === undefined ? instant : asMs(ingestTime),
				tz,
				key,
				labels: { feature, ...(labels ?? {}) },
				idem: `lapse:${key}:depleted:${feature}:${instant}`,
				text: `${feature} credits used up`,
				postings: [],
				payload: {
					feature,
					available: after,
					threshold: null,
					previous_available: before,
					cause: "expired",
				},
				revision: revision + 1,
			}),
		);
	}
	return events;
};
