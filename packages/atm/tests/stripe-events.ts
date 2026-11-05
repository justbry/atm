/**
 * Synthetic raw Stripe events for tests: the committed fixture files in `fixtures/billing/stripe/` as templates, with
 * the fields the mapping files read overridden. Same `api_version`, same nesting; ids and prices are invented.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const API_VERSION = "2025-10-29.clover";

// biome-ignore lint/suspicious/noExplicitAny: raw Stripe JSON is edited by path in tests, untyped
export type RawEvent = any;

const dir = join(import.meta.dir, "../fixtures/billing/stripe");
/**
 * The committed files are sandbox events (`livemode: false`); a test's synthetic event stands for the live endpoint the
 * handler serves by default (`env: "live"`), which refuses an event whose `livemode` disagrees.
 */
const template = (name: string): RawEvent => ({
	...JSON.parse(readFileSync(join(dir, name), "utf8")),
	livemode: true,
});

const seconds = (ms: number) => Math.floor(ms / 1000);

/** The Stripe price id a test gives a lookup key; pass the same pairs as `priceIds`. */
export const priceIdOf = (lookupKey: string) => `price_${lookupKey}`;

/** The payment intent a test gives an invoice's payment; pass the pairs as `invoiceIds`. */
export const paymentIntentOf = (invoiceId: string) => `pi_${invoiceId}`;

export type EventLine = {
	lookupKey: string;
	amount: number;
	/** null for a one-time price. */
	interval?: "month" | "year" | null;
	quantity?: number;
	proration?: boolean;
	periodStart?: number;
	periodEnd?: number;
};

export type InvoiceEvent = {
	eventId: string;
	invoiceId: string;
	/** Event time (ms): the event's `created`. */
	at: number;
	paidAt?: number;
	subscriptionId: string | null;
	reason:
		| "subscription_create"
		| "subscription_cycle"
		| "subscription_update"
		| "manual";
	periodStart: number;
	periodEnd: number;
	lines: EventLine[];
	metadata: Record<string, string>;
	amountPaid?: number;
};

export const invoicePaid = (e: InvoiceEvent): RawEvent => {
	const event = template("invoice.paid.json");
	const invoice = event.data.object;
	const line = invoice.lines.data[0];
	event.id = e.eventId;
	event.created = seconds(e.at);
	invoice.id = e.invoiceId;
	invoice.billing_reason = e.reason;
	invoice.period_start = seconds(e.periodStart);
	invoice.period_end = seconds(e.periodEnd);
	invoice.status_transitions.paid_at = seconds(e.paidAt ?? e.at);
	invoice.amount_paid =
		e.amountPaid ?? e.lines.reduce((n, l) => n + l.amount, 0);
	// As real Stripe: checkout's `subscription_data.metadata` sits on the subscription details of the invoice's parent,
	// and the invoice's own `metadata` is empty; an invoice without a subscription keeps its metadata at the top.
	invoice.metadata = e.subscriptionId === null ? e.metadata : {};
	invoice.parent =
		e.subscriptionId === null
			? null
			: {
					type: "subscription_details",
					quote_details: null,
					subscription_details: {
						subscription: e.subscriptionId,
						metadata: e.metadata,
					},
				};
	invoice.lines.data = e.lines.map((l, i) => {
		const out = structuredClone(line);
		out.id = `il_${e.invoiceId}_${i}`;
		out.amount = l.amount;
		out.quantity = l.quantity ?? 1;
		out.period = {
			start: seconds(l.periodStart ?? e.periodStart),
			end: seconds(l.periodEnd ?? e.periodEnd),
		};
		// API 2025-10-29.clover: a line names its price by id only, and proration sits on its parent.
		out.pricing.price_details.price = priceIdOf(l.lookupKey);
		out.pricing.unit_amount_decimal = String(l.amount);
		out.parent.subscription_item_details.proration = l.proration ?? false;
		out.parent.subscription_item_details.subscription_item = `si_${e.invoiceId}_${i}`;
		return out;
	});
	return event;
};

export const chargeRefunded = (e: {
	eventId: string;
	/** Not in the event: a real charge carries no refund object, so the fact's id is the event id. Kept for callers. */
	refundId?: string;
	chargeId: string;
	/** The invoice the charge paid: a charge names only its payment intent (`paymentIntentOf`). */
	invoiceId: string | null;
	amount: number;
	/** The charge's amount: a refund of all of it is a full refund. */
	chargeAmount: number;
	/** Total refunded so far, including this refund. */
	refundedTotal?: number;
	at: number;
}): RawEvent => {
	const event = template("charge.refunded.json");
	const charge = event.data.object;
	event.id = e.eventId;
	event.created = seconds(e.at);
	charge.id = e.chargeId;
	charge.payment_intent = e.invoiceId ? paymentIntentOf(e.invoiceId) : null;
	charge.amount = e.chargeAmount;
	charge.amount_captured = e.chargeAmount;
	// As real Stripe: the charge has no refund list; the event says what changed in `previous_attributes`.
	charge.amount_refunded = e.refundedTotal ?? e.amount;
	charge.refunded = charge.amount_refunded === e.chargeAmount;
	event.data.previous_attributes = {
		amount_refunded: charge.amount_refunded - e.amount,
	};
	return event;
};

export const disputeEvent = (e: {
	type: "charge.dispute.created" | "charge.dispute.closed";
	eventId: string;
	disputeId: string;
	chargeId: string;
	invoiceId: string | null;
	status: "needs_response" | "won" | "lost";
	at: number;
	/** When the dispute was opened (ms), its own `created`; the event's time when absent. A closing event comes later. */
	openedAt?: number;
	/** The disputed amount (the template's 26000 when absent). */
	amount?: number;
	/**
	 * What Stripe took from the balance when the dispute opened, as the recorded events carry it in the dispute's own
	 * `balance_transactions`: the amount withdrawn (negative) and the dispute fee in `fee`. Absent: an inquiry, an empty list.
	 */
	withdrawal?: { fee: number };
	/** A won dispute: Stripe adds the reversal of the amount, with a fee of 0 (the recorded `dispute-won` events). */
	reversed?: boolean;
}): RawEvent => {
	const event = template(
		e.type === "charge.dispute.closed"
			? "charge.dispute.closed.json"
			: "charge.dispute.created.json",
	);
	const dispute = event.data.object;
	event.id = e.eventId;
	event.type = e.type;
	event.created = seconds(e.at);
	dispute.id = e.disputeId;
	dispute.charge = e.chargeId;
	dispute.payment_intent = e.invoiceId ? paymentIntentOf(e.invoiceId) : null;
	dispute.status = e.status;
	dispute.created = seconds(e.openedAt ?? e.at);
	if (e.amount !== undefined) dispute.amount = e.amount;
	const transaction = (
		id: string,
		amount: number,
		fee: number,
		at: number,
	) => ({
		id,
		object: "balance_transaction",
		amount,
		available_on: seconds(e.at) + 345_600,
		balance_type: "payments",
		created: at,
		currency: "usd",
		description: `Chargeback ${amount < 0 ? "withdrawal" : "reversal"} for ${e.chargeId}`,
		exchange_rate: null,
		fee,
		fee_details:
			fee === 0
				? []
				: [
						{
							amount: fee,
							application: null,
							currency: "usd",
							description: "Dispute fee",
							type: "stripe_fee",
						},
					],
		net: amount - fee,
		reporting_category: amount < 0 ? "dispute" : "dispute_reversal",
		source: e.disputeId,
		status: "pending",
		type: "adjustment",
	});
	if (e.withdrawal) {
		const transactions = [
			transaction(
				`txn_${e.disputeId}`,
				-dispute.amount,
				e.withdrawal.fee,
				seconds(e.at),
			),
		];
		if (e.reversed)
			transactions.push(
				transaction(`txn_${e.disputeId}_won`, dispute.amount, 0, seconds(e.at)),
			);
		dispute.balance_transaction = transactions[0]?.id;
		dispute.balance_transactions = transactions;
	}
	return event;
};

export const subscriptionEvent = (e: {
	type:
		| "customer.subscription.created"
		| "customer.subscription.updated"
		| "customer.subscription.deleted";
	eventId: string;
	subscriptionId: string;
	status: string;
	/** The subscription's items, each named by its price's lookup key (`priceIdOf` gives the price id). */
	items: {
		lookupKey: string;
		interval: "month" | "year";
		/** Units of the price; default 1. */
		quantity?: number;
	}[];
	periodStart: number;
	periodEnd: number;
	cancelAtPeriodEnd?: boolean;
	at: number;
	/** What the checkout wrote; null leaves it out (a subscription made outside the family service). */
	metadata?: Record<string, string> | null;
}): RawEvent => {
	const event = template(`${e.type}.json`);
	const sub = event.data.object;
	event.id = e.eventId;
	event.created = seconds(e.at);
	sub.id = e.subscriptionId;
	sub.status = e.status;
	sub.cancel_at_period_end = e.cancelAtPeriodEnd ?? false;
	if (e.metadata !== undefined) sub.metadata = e.metadata ?? {};
	const base = sub.items.data[0];
	sub.items.data = e.items.map((item, i) => ({
		...base,
		id: `si_${e.subscriptionId}_${i}`,
		quantity: item.quantity ?? 1,
		current_period_start: seconds(e.periodStart),
		current_period_end: seconds(e.periodEnd),
		price: {
			...base.price,
			id: priceIdOf(item.lookupKey),
			lookup_key: item.lookupKey,
			recurring: { interval: item.interval, interval_count: 1 },
		},
	}));
	return event;
};

/** A `payout.paid` event: `amount` is what reaches the bank, net of Stripe's fees. */
export const payoutPaid = (e: {
	eventId: string;
	payoutId: string;
	amount: number;
	currency?: string;
	/** Event time (ms): the event's `created`. */
	at: number;
}): RawEvent => {
	const event = template("payout.paid.json");
	event.id = e.eventId;
	event.created = seconds(e.at);
	event.data.object.id = e.payoutId;
	event.data.object.amount = e.amount;
	event.data.object.currency = e.currency ?? "usd";
	return event;
};

export const subscriptionDeleted = (e: {
	eventId: string;
	subscriptionId: string;
	tierId: string;
	interval: "month" | "year";
	periodStart: number;
	periodEnd: number;
	at: number;
}): RawEvent => {
	const event = template("customer.subscription.deleted.json");
	const sub = event.data.object;
	event.id = e.eventId;
	event.created = seconds(e.at);
	sub.id = e.subscriptionId;
	sub.status = "canceled";
	sub.metadata = { ...sub.metadata, tier_id: e.tierId };
	sub.items.data[0].current_period_start = seconds(e.periodStart);
	sub.items.data[0].current_period_end = seconds(e.periodEnd);
	sub.items.data[0].price.recurring = {
		interval: e.interval,
		interval_count: 1,
	};
	return event;
};
