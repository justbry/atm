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
const template = (name: string): RawEvent =>
	JSON.parse(readFileSync(join(dir, name), "utf8"));

const seconds = (ms: number) => Math.floor(ms / 1000);

export type EventLine = {
	lookupKey: string;
	amount: number;
	/** null for a one-time price. */
	interval?: "month" | "year" | null;
	quantity?: number;
	proration?: boolean;
	periodStart?: number;
	periodEnd?: number;
	/** The Stripe price's metadata, e.g. `{ b4u_gift: "sessions" }`. */
	priceMetadata?: Record<string, string>;
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
	invoice.metadata = e.metadata;
	invoice.parent =
		e.subscriptionId === null
			? null
			: {
					type: "subscription_details",
					quote_details: null,
					subscription_details: {
						subscription: e.subscriptionId,
						metadata: {},
					},
				};
	invoice.lines.data = e.lines.map((l, i) => {
		const out = structuredClone(line);
		out.id = `il_${e.invoiceId}_${i}`;
		out.amount = l.amount;
		out.quantity = l.quantity ?? 1;
		out.proration = l.proration ?? false;
		out.period = {
			start: seconds(l.periodStart ?? e.periodStart),
			end: seconds(l.periodEnd ?? e.periodEnd),
		};
		out.price.id = `price_${l.lookupKey}`;
		out.price.lookup_key = l.lookupKey;
		out.price.unit_amount = l.amount;
		out.price.recurring = l.interval
			? { interval: l.interval, interval_count: 1 }
			: null;
		out.price.type = l.interval ? "recurring" : "one_time";
		if (l.priceMetadata) out.price.metadata = l.priceMetadata;
		out.pricing.price_details.price = `price_${l.lookupKey}`;
		return out;
	});
	return event;
};

export const chargeRefunded = (e: {
	eventId: string;
	refundId: string;
	chargeId: string;
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
	charge.invoice = e.invoiceId;
	charge.amount = e.chargeAmount;
	charge.amount_captured = e.chargeAmount;
	charge.amount_refunded = e.refundedTotal ?? e.amount;
	charge.refunds.data = [
		{
			...charge.refunds.data[0],
			id: e.refundId,
			amount: e.amount,
			charge: e.chargeId,
		},
	];
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
	dispute.invoice = e.invoiceId;
	dispute.status = e.status;
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
