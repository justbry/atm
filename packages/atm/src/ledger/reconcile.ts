import type {
	AtmEvent,
	AtmEventType,
	ReconcileDifference,
	ReconcileInput,
	ReconcileKind,
	ReconcileObject,
	ReconcilePeriod,
	ReconcileResult,
	ReconcileSide,
	ReconcileStripe,
	ReconcileStripeList,
} from "../types.js";
import { decimalToUnits, localDate } from "./util.js";

const STRIPE_ACCOUNT = "assets:stripe";
const FEES_ACCOUNT = "expenses:billing:stripe-fees";
/** Stripe's dispute fee is a fee in its balance transactions, so it is compared with the payment fees. */
const DISPUTE_FEES_ACCOUNT = "expenses:billing:dispute-fees";
const FEE_ACCOUNTS: readonly string[] = [FEES_ACCOUNT, DISPUTE_FEES_ACCOUNT];
const CENTS = 2;
const MS_PER_SECOND = 1000;
const MONTH = /^(\d{4})-(\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STRIPE_PREFIX = /^stripe:/;
const REFUND_ID_PREFIX = "re_";
const LEDGER_CURRENCY = "usd";

/** Balance transaction types that move money out to the bank (or back): compared as payouts, not in the net. */
const PAYOUT_TRANSACTION_TYPES = new Set([
	"payout",
	"payout_cancel",
	"payout_failure",
	"payout_minimum_balance_hold",
	"payout_minimum_balance_release",
]);
/** A refund in these states moved no money. */
const REFUND_STATES_WITHOUT_MONEY = new Set([
	"failed",
	"canceled",
	"requires_action",
]);
const DISPUTE_OUTCOMES = new Set(["won", "lost"]);
/** Inquiries and prevented disputes: Stripe takes nothing from the balance for them. */
const DISPUTE_STATES_WITHOUT_MONEY = new Set([
	"warning_needs_response",
	"warning_under_review",
	"warning_closed",
	"prevented",
]);

const OBJECT_ORDER: ReconcileObject[] = [
	"invoice",
	"refund",
	"dispute",
	"payout",
	"fees",
	"net",
];

/** Thrown for a period or time zone that cannot be used; the CLI turns it into its bad-input exit. */
export class ReconcileInputError extends Error {}

type Scope = {
	from: string;
	to: string;
	label: string;
	timeZone: string;
	has: (day: string) => boolean;
};

const realDay = (day: string): boolean =>
	DAY.test(day) &&
	new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

const resolvePeriod = (period: ReconcilePeriod): Omit<Scope, "timeZone"> => {
	let from: string;
	let to: string;
	let label: string;
	if ("month" in period) {
		const match = MONTH.exec(period.month);
		const month = Number(match?.[2]);
		if (!match || month < 1 || month > 12)
			throw new ReconcileInputError(
				`period.month must be YYYY-MM, got ${JSON.stringify(period.month)}`,
			);
		const lastDay = new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate();
		from = `${period.month}-01`;
		to = `${period.month}-${String(lastDay).padStart(2, "0")}`;
		label = period.month;
	} else {
		from = period.from;
		to = period.to;
		if (!realDay(from) || !realDay(to) || from > to)
			throw new ReconcileInputError(
				`period needs from and to as YYYY-MM-DD with from on or before to, got ${JSON.stringify(from)} and ${JSON.stringify(to)}`,
			);
		label = `${from}..${to}`;
	}
	return { from, to, label, has: (day) => day >= from && day <= to };
};

const latestZone = (events: readonly AtmEvent[]): string | undefined => {
	let latest: AtmEvent | undefined;
	for (const event of events)
		if (!latest || event.event_time > latest.event_time) latest = event;
	return latest?.tz;
};

const validZone = (timeZone: string): string => {
	try {
		localDate(0, timeZone);
	} catch {
		throw new ReconcileInputError(
			`${JSON.stringify(timeZone)} is not an IANA time zone`,
		);
	}
	return timeZone;
};

/** A record on either side, reduced to what is compared. */
type Item = {
	id: string;
	amount: number | null;
	currency: string | null;
	date: string;
	status: string | null;
	/** Seconds since the epoch: orders refunds on one payment. Only refunds carry it. */
	at?: number;
	/** What a refund names: the payment intent and the charge it refunds. */
	paymentIntent?: string | null;
	charge?: string | null;
};

const lower = (text: string | null | undefined): string | null =>
	typeof text === "string" ? text.toLowerCase() : null;

const sideOf = (item: Item): ReconcileSide => ({
	amount: item.amount,
	currency: item.currency,
	date: item.date,
	status: item.status,
});

/** The Stripe id the event is about: `payload.id`, else the `idem` without its `stripe:` prefix. */
const stripeIdOf = (event: AtmEvent): string =>
	typeof event.payload.id === "string" && event.payload.id !== ""
		? event.payload.id
		: event.idem.replace(STRIPE_PREFIX, "");

const itemOfEvent = (event: AtmEvent): Item => {
	const field =
		event.event_type === "payment.succeeded" ? "amount_paid" : "amount";
	const amount = event.payload[field];
	const status = event.payload.status;
	return {
		id: stripeIdOf(event),
		amount: Number.isInteger(amount) ? (amount as number) : null,
		currency: lower(event.payload.currency as string | undefined),
		date: event.date,
		status: typeof status === "string" ? status : null,
	};
};

/** The text of a payload field when it is a non-empty string. */
const textOf = (value: unknown): string | null =>
	typeof value === "string" && value !== "" ? value : null;

/**
 * A refund event the handler made is labelled with the Stripe event id (`evt_...`, a `charge.refunded` delivers a Charge,
 * which has no refund id) and names the charge and the payment intent instead. Its refund is found among Stripe's by those
 * and the amount. An event with a `re_...` id, or with neither, is matched by its id as before.
 */
const isTiedRefund = (event: AtmEvent): boolean =>
	!stripeIdOf(event).startsWith(REFUND_ID_PREFIX) &&
	(textOf(event.payload.payment_intent) !== null ||
		textOf(event.payload.charge) !== null);

/** Whether a refund event and a Stripe refund are of one payment: the same payment intent, else the same charge. */
const samePayment = (event: AtmEvent, refund: Item): boolean => {
	const eventIntent = textOf(event.payload.payment_intent);
	if (eventIntent !== null && refund.paymentIntent)
		return eventIntent === refund.paymentIntent;
	const eventCharge = textOf(event.payload.charge);
	return eventCharge !== null && eventCharge === refund.charge;
};

/**
 * Pairs the handler-made refund events with Stripe's refunds, one to one, and returns the Stripe id each event stands for.
 * Refunds of one payment are a multiset in time order: an event takes the unpaired Stripe refund of the same payment
 * and amount nearest to it in time (one on its own day first), so two equal refunds pair two to two, and a third on one
 * side only is left over. Left-over pairs of one payment, both in the period or both out, are the same refund with
 * another amount: paired so that it is `amount_differs`, not a missing record on each side. Refunds of equal amount on
 * one payment cannot be told apart, only counted.
 */
const tieRefunds = (
	events: readonly AtmEvent[],
	stripe: readonly Item[],
	scope: Scope,
): Map<string, string> => {
	const tied = events
		.filter(isTiedRefund)
		.sort(
			(a, b) =>
				Date.parse(a.event_time) - Date.parse(b.event_time) ||
				(a.id < b.id ? -1 : 1),
		);
	const byId = new Set(
		events.filter((event) => !isTiedRefund(event)).map(stripeIdOf),
	);
	const pool = stripe
		.filter((refund) => !byId.has(refund.id))
		.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.id < b.id ? -1 : 1));
	const paired = new Map<string, string>();
	const taken = new Set<string>();
	const sameMoney = (event: AtmEvent, refund: Item) => {
		const item = itemOfEvent(event);
		return (
			item.amount === refund.amount &&
			(item.currency === null ||
				refund.currency === null ||
				item.currency === refund.currency)
		);
	};
	const rules: ((event: AtmEvent, refund: Item) => boolean)[] = [
		(event, refund) => sameMoney(event, refund) && event.date === refund.date,
		sameMoney,
		(event, refund) => scope.has(event.date) === scope.has(refund.date),
	];
	// Each rule pairs the closest in time first, over every event and refund at once: an event taking the earliest equal
	// refund would take one that a later event is nearer to, and pair that one wrongly.
	for (const rule of rules) {
		const candidates = tied.flatMap((event) =>
			pool
				.filter(
					(refund) =>
						!paired.has(event.id) &&
						!taken.has(refund.id) &&
						samePayment(event, refund) &&
						rule(event, refund),
				)
				.map((refund) => ({
					event,
					refund,
					gap: Math.abs(
						Date.parse(event.event_time) / MS_PER_SECOND - (refund.at ?? 0),
					),
				})),
		);
		// Stable: equal gaps keep the order of the events and then of the refunds.
		candidates.sort((a, b) => a.gap - b.gap);
		for (const { event, refund } of candidates) {
			if (paired.has(event.id) || taken.has(refund.id)) continue;
			paired.set(event.id, refund.id);
			taken.add(refund.id);
		}
	}
	return paired;
};

type Pairing = {
	object: ReconcileObject;
	eventType: AtmEventType;
	/** Stripe's records already filtered to those that count; undefined when the list was not supplied. */
	stripe: readonly Item[] | undefined;
	/** The school's events of `eventType`, of any date. */
	events: readonly AtmEvent[];
	/** Report `period_differs`: only where both sides date the thing by the same instant. */
	flagPeriodShift: boolean;
	/** Whether Stripe's record should already be in the log (an open dispute has no `dispute.closed` yet). */
	expectedInLog?: (item: Item) => boolean;
	compareStatus?: boolean;
	/** False for a record that has no amount of its own (a `dispute.closed` names the dispute, not its sum): amount and currency are not compared. */
	compareAmount?: boolean;
	/** The Stripe id an event stands for, when it is not the one it carries (a handler-made refund event, see `tieRefunds`). */
	idOf?: (event: AtmEvent) => string;
};

const describeItem = (item: Item): string =>
	`${item.amount ?? "no amount"} ${item.currency ?? "(no currency)"} on ${item.date}`;

/** Matches Stripe's records to the log's events by id and reports every difference in the period. */
const pair = (
	pairing: Pairing,
	scope: Scope,
	period: string,
): ReconcileDifference[] => {
	if (!pairing.stripe) return [];
	const found: ReconcileDifference[] = [];
	const stripeById = new Map(pairing.stripe.map((item) => [item.id, item]));
	const eventsById = new Map<string, AtmEvent[]>();
	for (const event of pairing.events) {
		const id = pairing.idOf?.(event) ?? stripeIdOf(event);
		eventsById.set(id, [...(eventsById.get(id) ?? []), event]);
	}
	const ids = [...new Set([...stripeById.keys(), ...eventsById.keys()])].sort();
	const { object, eventType } = pairing;
	for (const id of ids) {
		const stripe = stripeById.get(id);
		const events = eventsById.get(id) ?? [];
		const first = events[0];
		const log = first ? itemOfEvent(first) : undefined;
		const stripeIn = stripe ? scope.has(stripe.date) : false;
		const logIn = log ? scope.has(log.date) : false;
		if (!stripeIn && !logIn) continue;
		const add = (kind: ReconcileKind, message: string, involved = events) =>
			found.push({
				kind,
				object,
				id,
				eventType,
				eventIds: involved.map((event) => event.id),
				stripe: stripe ? sideOf(stripe) : null,
				log: log ? sideOf(log) : null,
				period,
				message: `${object} ${id}: ${message}`,
			});
		if (events.length > 1)
			add(
				"duplicate_in_log",
				`${events.length} ${eventType} events carry this id (${events.map((event) => event.id).join(", ")})`,
			);
		if (stripe && !log) {
			if (pairing.expectedInLog?.(stripe) ?? true)
				add(
					"missing_in_log",
					`Stripe has ${describeItem(stripe)}, the log has no ${eventType}`,
				);
			continue;
		}
		if (!stripe && log) {
			add(
				"missing_in_stripe",
				`the log has ${eventType} ${describeItem(log)}, Stripe's records have none`,
			);
			continue;
		}
		if (!stripe || !log) continue;
		if (pairing.flagPeriodShift && stripeIn !== logIn) {
			add(
				"period_differs",
				`Stripe dates it ${stripe.date}, the log ${log.date}, either side of the period`,
			);
			continue;
		}
		if (pairing.compareStatus && stripe.status !== log.status) {
			add(
				"outcome_differs",
				`Stripe says ${stripe.status}, the log says ${log.status ?? "nothing"}`,
			);
			continue;
		}
		const currencyDiffers =
			stripe.currency !== null &&
			log.currency !== null &&
			stripe.currency !== log.currency;
		if (
			(pairing.compareAmount ?? true) &&
			(stripe.amount !== log.amount || currencyDiffers)
		)
			add(
				"amount_differs",
				`Stripe has ${describeItem(stripe)}, the log has ${describeItem(log)}`,
			);
	}
	return found;
};

const sum = (numbers: readonly number[]): number =>
	numbers.reduce((total, n) => total + n, 0);

/** Cents of every posting to `account` in USD, as an integer. */
const postedCents = (
	events: readonly AtmEvent[],
	accounts: readonly string[],
): number[] =>
	events.flatMap((event) =>
		event.postings
			.filter((p) => accounts.includes(p.account) && p.commodity === "USD")
			.map((p) => Number(decimalToUnits(p.amount, CENTS))),
	);

const totalSide = (amount: number): ReconcileSide => ({
	amount,
	currency: LEDGER_CURRENCY,
	date: null,
	status: null,
});

const byObjectIdKind = (a: ReconcileDifference, b: ReconcileDifference) =>
	OBJECT_ORDER.indexOf(a.object) - OBJECT_ORDER.indexOf(b.object) ||
	(a.id ?? "").localeCompare(b.id ?? "") ||
	a.kind.localeCompare(b.kind);

/**
 * Compares a school's events with Stripe's records for one period and reports every difference. Pure: it reads only
 * its argument. Matching is by Stripe's id (`payload.id` of the event), except a refund event labelled with a Stripe event
 * id that names its payment (the handler's, see `tieRefunds`); a record counts for the period when it is dated
 * in it, by the school's calendar (an event's own `date`, the one `buildJournal` uses; a Stripe record's `created`, or
 * an invoice's `paid_at`, in the school's zone). A pair is compared when either side is in the period.
 */
export const reconcile = (input: ReconcileInput): ReconcileResult => {
	const mode = input.mode ?? "live";
	const timeZone = validZone(
		input.timeZone ??
			latestZone(input.events) ??
			(() => {
				throw new ReconcileInputError(
					"the school has no events to read its time zone from; pass timeZone (--time-zone on the CLI)",
				);
			})(),
	);
	const scope: Scope = { ...resolvePeriod(input.period), timeZone };
	const dayOf = (seconds: number) =>
		localDate(seconds * MS_PER_SECOND, timeZone);
	const ignored: Record<string, number> = {};
	/** Counts the record as skipped; false, so a filter callback can return it. */
	const ignore = (reason: string): false => {
		ignored[reason] = (ignored[reason] ?? 0) + 1;
		return false;
	};
	/** `livemode` is on invoices, disputes and payouts; refunds and balance transactions have none, so the key that listed them decides. */
	const inMode = (record: { livemode?: boolean }) => {
		if (record.livemode === undefined || record.livemode === (mode === "live"))
			return true;
		ignore(`${record.livemode ? "live" : "test"}_mode_object`);
		return false;
	};

	const { stripe } = input;
	const events = [...input.events].sort((a, b) => (a.id < b.id ? -1 : 1));
	const ofType = (type: AtmEventType) =>
		events.filter((event) => event.event_type === type);
	const inScope = (event: AtmEvent) => scope.has(event.date);

	const invoices = stripe.invoices
		?.filter(inMode)
		.filter((invoice) => {
			if (invoice.status !== "paid") return ignore("invoice_not_paid");
			// atm books a payment only when money moved (a 100% discount is a paid invoice of 0).
			if (invoice.amount_paid <= 0) return ignore("invoice_nothing_paid");
			return true;
		})
		.map(
			(invoice): Item => ({
				id: invoice.id,
				amount: invoice.amount_paid,
				currency: lower(invoice.currency),
				date: dayOf(invoice.status_transitions?.paid_at ?? invoice.created),
				status: null,
			}),
		);
	const refunds = stripe.refunds
		?.filter((refund) => {
			if (!REFUND_STATES_WITHOUT_MONEY.has(refund.status ?? "")) return true;
			return ignore("refund_not_succeeded");
		})
		.map(
			(refund): Item => ({
				id: refund.id,
				amount: refund.amount,
				currency: lower(refund.currency),
				date: dayOf(refund.created),
				status: null,
				at: refund.created,
				paymentIntent: refund.payment_intent ?? null,
				charge: refund.charge ?? null,
			}),
		);
	const refundEvents = ofType("payment.refunded");
	const tiedRefunds = refunds
		? tieRefunds(refundEvents, refunds, scope)
		: new Map<string, string>();
	const disputeRecords = stripe.disputes?.filter(inMode).filter((dispute) => {
		if (!DISPUTE_STATES_WITHOUT_MONEY.has(dispute.status)) return true;
		return ignore("dispute_no_money_moved");
	});
	const disputes = disputeRecords?.map(
		(dispute): Item => ({
			id: dispute.id,
			amount: dispute.amount,
			currency: lower(dispute.currency),
			date: dayOf(dispute.created),
			status: dispute.status,
		}),
	);
	/** The outcome check: what Stripe says of each dispute, with no amount (`dispute.closed` has none). */
	const outcomes = disputes?.map((item) => ({
		...item,
		amount: null,
		currency: null,
	}));
	const payouts = stripe.payouts
		?.filter(inMode)
		.filter((payout) => {
			if (payout.status === undefined || payout.status === "paid") return true;
			return ignore("payout_not_paid");
		})
		.map(
			(payout): Item => ({
				id: payout.id,
				amount: payout.amount,
				currency: lower(payout.currency),
				date: dayOf(payout.created),
				status: null,
			}),
		);

	const differences: ReconcileDifference[] = [
		...pair(
			{
				object: "invoice",
				eventType: "payment.succeeded",
				stripe: invoices,
				events: ofType("payment.succeeded"),
				flagPeriodShift: true,
			},
			scope,
			scope.label,
		),
		...pair(
			{
				object: "refund",
				eventType: "payment.refunded",
				stripe: refunds,
				events: refundEvents,
				flagPeriodShift: true,
				idOf: (event) => tiedRefunds.get(event.id) ?? stripeIdOf(event),
			},
			scope,
			scope.label,
		),
		...pair(
			{
				object: "dispute",
				eventType: "payment.disputed",
				stripe: disputes,
				events: ofType("payment.disputed"),
				// The log dates the line by Stripe's withdrawal (its balance transaction, which `reconcile`'s fee and net checks
				// scope by), not by the dispute's `created`: a second later, or weeks for an inquiry that became a chargeback.
				flagPeriodShift: false,
			},
			scope,
			scope.label,
		),
		// A dispute closes on a later day than it opens, so the closing is never flagged for its date, and only an outcome Stripe has is expected in the log.
		...pair(
			{
				object: "dispute",
				eventType: "dispute.closed",
				stripe: outcomes,
				events: ofType("dispute.closed"),
				flagPeriodShift: false,
				compareStatus: true,
				compareAmount: false,
				expectedInLog: (item) => DISPUTE_OUTCOMES.has(item.status ?? ""),
			},
			scope,
			scope.label,
		),
		// A payout's event is dated by its arrival in some logs and by its creation in others; the date only picks the period.
		...(logHasPayouts(events)
			? pair(
					{
						object: "payout",
						eventType: "payout.paid",
						stripe: payouts,
						events: ofType("payout.paid"),
						flagPeriodShift: false,
					},
					scope,
					scope.label,
				)
			: payoutsNotInLog(payouts, scope)),
		...money({
			transactions: stripe.balanceTransactions,
			events: events.filter(inScope),
			scope,
			dayOf,
			ignore,
		}),
	].sort(byObjectIdKind);

	const inPeriod = (items: readonly Item[] | undefined) =>
		items ? items.filter((item) => scope.has(item.date)).length : null;
	const logCount = (type: AtmEventType) => ofType(type).filter(inScope).length;
	const balanceTransactions = stripe.balanceTransactions?.filter(
		(transaction) => scope.has(dayOf(transaction.created)),
	);
	/** What the handler applied but did not book (a non-USD invoice, refund, payout or dispute), counted from its own markers. */
	const skipped: Record<string, number> = {};
	for (const event of ofType("money.skipped").filter(inScope)) {
		const reason = textOf(event.payload.reason) ?? "unknown";
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	}
	const feePostings = postedCents(events.filter(inScope), FEE_ACCOUNTS);
	const notSupplied = (
		[
			"invoices",
			"refunds",
			"disputes",
			"payouts",
			"balanceTransactions",
		] as const
	).filter((list: ReconcileStripeList) => stripe[list] === undefined);
	return {
		period: {
			from: scope.from,
			to: scope.to,
			label: scope.label,
			timeZone,
		},
		mode,
		differences,
		notSupplied,
		counts: {
			invoice: {
				stripe: inPeriod(invoices),
				log: logCount("payment.succeeded"),
			},
			refund: { stripe: inPeriod(refunds), log: logCount("payment.refunded") },
			dispute: {
				stripe: inPeriod(disputes),
				log: logCount("payment.disputed"),
			},
			payout: { stripe: inPeriod(payouts), log: logCount("payout.paid") },
			fees: {
				stripe:
					balanceTransactions?.filter((transaction) => transaction.fee !== 0)
						.length ?? null,
				log: feePostings.length,
			},
			net: {
				stripe: balanceTransactions?.length ?? null,
				log: events.filter(inScope).filter(movesStripeBalance).length,
			},
		},
		ignored,
		skipped,
	};
};

const logHasPayouts = (events: readonly AtmEvent[]): boolean =>
	events.some((event) => event.event_type === "payout.paid");

/** Payouts are individually identified, but a log with no `payout.paid` at all gets one record, not one per payout. */
const payoutsNotInLog = (
	payouts: readonly Item[] | undefined,
	scope: Scope,
): ReconcileDifference[] => {
	const inPeriod = payouts?.filter((payout) => scope.has(payout.date)) ?? [];
	if (inPeriod.length === 0) return [];
	const total = sum(inPeriod.map((payout) => payout.amount ?? 0));
	return [
		{
			kind: "not_in_log",
			object: "payout",
			id: null,
			eventType: "payout.paid",
			eventIds: [],
			stripe: totalSide(total),
			log: null,
			period: scope.label,
			message: `payouts: Stripe paid out ${total} cents in ${inPeriod.length} payouts (${inPeriod.map((payout) => payout.id).join(", ")}); the log has no payout.paid events`,
		},
	];
};

const movesStripeBalance = (event: AtmEvent): boolean =>
	event.event_type !== "payout.paid" &&
	event.postings.some((p) => p.account === STRIPE_ACCOUNT);

/**
 * The totals: fees, and the net of the money postings. They are sums, not matches: a charge cannot be tied to its
 * invoice (API 2025-10-29.clover: neither names the other), so a fee is compared as a total. Payouts leave the net
 * (they are compared above). When the log has no fee postings, the net is compared before Stripe's fees.
 */
const money = ({
	transactions,
	events,
	scope,
	dayOf,
	ignore,
}: {
	transactions: ReconcileStripe["balanceTransactions"];
	events: readonly AtmEvent[];
	scope: Scope;
	dayOf: (seconds: number) => string;
	ignore: (reason: string) => false;
}): ReconcileDifference[] => {
	if (!transactions) return [];
	const counted = transactions.filter((transaction) => {
		if (!scope.has(dayOf(transaction.created))) return false;
		if (PAYOUT_TRANSACTION_TYPES.has(transaction.type)) return false;
		if (lower(transaction.currency) !== LEDGER_CURRENCY)
			return ignore("balance_transaction_other_currency");
		return true;
	});
	const found: ReconcileDifference[] = [];
	const stripeFees = sum(counted.map((transaction) => transaction.fee));
	const feePostings = postedCents(events, FEE_ACCOUNTS);
	const logFees = sum(feePostings);
	const feesInLog = feePostings.length > 0;
	if (!feesInLog && stripeFees !== 0) {
		found.push({
			kind: "not_in_log",
			object: "fees",
			id: null,
			eventType: null,
			eventIds: [],
			stripe: totalSide(stripeFees),
			log: null,
			period: scope.label,
			message: `fees: Stripe took ${stripeFees} cents in fees; the log has no ${FEES_ACCOUNT} or ${DISPUTE_FEES_ACCOUNT} postings`,
		});
	} else if (stripeFees !== logFees) {
		found.push({
			kind: "amount_differs",
			object: "fees",
			id: null,
			eventType: null,
			eventIds: events
				.filter((event) =>
					event.postings.some((p) => FEE_ACCOUNTS.includes(p.account)),
				)
				.map((event) => event.id),
			stripe: totalSide(stripeFees),
			log: totalSide(logFees),
			period: scope.label,
			message: `fees: Stripe took ${stripeFees} cents, the log booked ${logFees}`,
		});
	}
	const stripeNet = sum(
		counted.map((transaction) =>
			feesInLog ? transaction.net : transaction.amount,
		),
	);
	const logNet = sum(
		events
			.filter(movesStripeBalance)
			.flatMap((event) => postedCents([event], [STRIPE_ACCOUNT])),
	);
	if (stripeNet !== logNet) {
		const stripeNetByType: Record<string, number> = {};
		for (const transaction of counted)
			stripeNetByType[transaction.type] =
				(stripeNetByType[transaction.type] ?? 0) +
				(feesInLog ? transaction.net : transaction.amount);
		found.push({
			kind: "amount_differs",
			object: "net",
			id: null,
			eventType: null,
			eventIds: [],
			stripe: totalSide(stripeNet),
			log: totalSide(logNet),
			period: scope.label,
			message: `net: Stripe's balance moved ${stripeNet} cents${feesInLog ? "" : " before fees"} (payouts apart), the log's ${STRIPE_ACCOUNT} postings ${logNet}`,
			stripeNetByType,
		});
	}
	return found;
};
