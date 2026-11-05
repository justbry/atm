/**
 * The Stripe events the matrix's cases deliver, built from `stripe-events.ts` (the committed fixtures as templates) with
 * the times and amounts a case names. Prices come from the school's menu, so a line is always one the handler knows.
 */
import { readFileSync } from "node:fs";
import {
	addonPriceKey,
	lookupKeyOf,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { menu as baseMenu, FAMILY, SCHOOL } from "./handler-harness.js";
import {
	chargeRefunded,
	disputeEvent,
	type EventLine,
	invoicePaid,
	paymentIntentOf,
	payoutPaid,
	type RawEvent,
	subscriptionEvent,
} from "./stripe-events.js";

export const SECOND = 1000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const ms = (iso: string): number => Date.parse(iso);

/** The clock of the cases: the first payment, the renewal after it, and the one after that. */
export const JAN15 = "2026-01-15T18:00:00Z";
export const FEB15 = "2026-02-15T18:00:00Z";
export const MAR15 = "2026-03-15T18:00:00Z";

export const tierLine = (
	tierId: string,
	{
		interval = "month",
		school = SCHOOL,
		menu = baseMenu,
		...over
	}: Partial<EventLine> & {
		interval?: "month" | "year";
		school?: string;
		menu?: Menu;
		amount: number;
	},
): EventLine => {
	const price = menu.tiers
		.find((tier) => tier.id === tierId)
		?.prices.find((p) => p.interval === interval);
	return {
		lookupKey: lookupKeyOf(
			school,
			tierPriceKey(tierId, interval),
			price?.amount as number,
			menu.currency,
		),
		interval,
		...over,
	};
};

export const addonLine = (
	addonId: string,
	{
		school = SCHOOL,
		menu = baseMenu,
		...over
	}: Partial<EventLine> & { school?: string; menu?: Menu; amount: number },
): EventLine => {
	const addon = menu.addons.find((a) => a.id === addonId);
	if (!addon) throw new Error(`no add-on ${addonId} on the menu`);
	return {
		lookupKey: lookupKeyOf(
			school,
			addonPriceKey(addon.id, addon.price.every, addon.gift),
			addon.price.amount,
			menu.currency,
		),
		interval: addon.price.every === "once" ? null : addon.price.every,
		...over,
	};
};

export type InvoiceOptions = {
	id: string;
	/** When the invoice was paid (ms). */
	at: number;
	reason?:
		| "subscription_create"
		| "subscription_cycle"
		| "subscription_update"
		| "manual";
	/** null for an invoice outside a subscription (a one-time purchase). */
	subscription?: string | null;
	start?: number;
	end?: number;
	lines: EventLine[];
	family?: string;
	school?: string;
	/** The invoice's own currency; default usd. */
	currency?: string;
	/** What was charged when it is not the sum of the lines (a discount). */
	amountPaid?: number;
	/** Replace the holder metadata (another product's invoice carries none). */
	metadata?: Record<string, string>;
};

export const invoice = (o: InvoiceOptions): RawEvent => {
	const event = invoicePaid({
		eventId: `evt_${o.id}`,
		invoiceId: o.id,
		at: o.at,
		subscriptionId: o.subscription === undefined ? "sub_1" : o.subscription,
		reason: o.reason ?? "subscription_create",
		periodStart: o.start ?? o.at,
		periodEnd: o.end ?? o.at + 31 * DAY,
		lines: o.lines,
		metadata: o.metadata ?? {
			b4u_school: o.school ?? SCHOOL,
			family_id: o.family ?? FAMILY,
		},
		...(o.amountPaid === undefined ? {} : { amountPaid: o.amountPaid }),
	});
	if (o.currency) event.data.object.currency = o.currency;
	return event;
};

/** The same delivery sent again under a new Stripe event id (the dashboard's resend keeps the id; a second event does not). */
export const resent = (event: RawEvent, id: string): RawEvent => ({
	...event,
	id,
});

/** The recorded `invoice_payment.paid`, pointed at an invoice's payment intent: what lets a refund or a dispute find its invoice. */
export const link = (invoiceId: string, at: number): RawEvent => {
	const event = {
		...JSON.parse(
			readFileSync(
				`${import.meta.dir}/../fixtures/billing/stripe/recorded/invoice_payment.paid.json`,
				"utf8",
			),
		),
		livemode: true,
	};
	event.id = `evt_link_${invoiceId}`;
	event.created = Math.floor(at / SECOND);
	event.data.object.created = event.created;
	event.data.object.invoice = invoiceId;
	event.data.object.payment = {
		type: "payment_intent",
		payment_intent: paymentIntentOf(invoiceId),
	};
	return event;
};

export const refundOf = (o: {
	id: string;
	invoiceId: string;
	amount: number;
	/** The charge's amount: a refund of all of it is a full refund. */
	charged: number;
	/** Total refunded so far, this refund included. */
	total?: number;
	at: number;
	/** Leave out `previous_attributes`, as an event that does not say what changed. */
	withoutPrevious?: boolean;
}): RawEvent => {
	const event = chargeRefunded({
		eventId: o.id,
		chargeId: `ch_${o.invoiceId}`,
		invoiceId: o.invoiceId,
		amount: o.amount,
		chargeAmount: o.charged,
		...(o.total === undefined ? {} : { refundedTotal: o.total }),
		at: o.at,
	});
	if (o.withoutPrevious) delete event.data.previous_attributes;
	return event;
};

export const disputeOf = (o: {
	type: "charge.dispute.created" | "charge.dispute.closed";
	id: string;
	invoiceId: string;
	status: "needs_response" | "won" | "lost";
	at: number;
	/** When the dispute was opened (ms); a closing event is later than that. */
	openedAt?: number;
	/** What Stripe took from the balance when it opened, as the recorded events carry it: the dispute fee, in cents. */
	fee?: number;
	/** A won dispute: the reversal of the amount (fee 0) is listed after the withdrawal. */
	reversed?: boolean;
}): RawEvent =>
	disputeEvent({
		type: o.type,
		eventId: o.id,
		disputeId: "dp_1",
		chargeId: `ch_${o.invoiceId}`,
		invoiceId: o.invoiceId,
		status: o.status,
		at: o.at,
		...(o.openedAt === undefined ? {} : { openedAt: o.openedAt }),
		...(o.fee === undefined ? {} : { withdrawal: { fee: o.fee } }),
		...(o.reversed ? { reversed: true } : {}),
	});

export const payoutOf = (o: {
	id: string;
	payoutId: string;
	amount: number;
	at: number;
	currency?: string;
	type?: string;
}): RawEvent => {
	const event = payoutPaid({
		eventId: o.id,
		payoutId: o.payoutId,
		amount: o.amount,
		at: o.at,
		...(o.currency ? { currency: o.currency } : {}),
	});
	if (o.type) event.type = o.type;
	return event;
};

export const subscriptionOf = (o: {
	type:
		| "customer.subscription.created"
		| "customer.subscription.updated"
		| "customer.subscription.deleted";
	id: string;
	status: string;
	tierId: string;
	quantity?: number;
	start: number;
	end: number;
	at: number;
	menu?: Menu;
	family?: string;
}): RawEvent =>
	subscriptionEvent({
		type: o.type,
		eventId: o.id,
		subscriptionId: "sub_1",
		status: o.status,
		items: [
			{
				lookupKey: tierLine(o.tierId, { amount: 0, menu: o.menu }).lookupKey,
				interval: "month",
				...(o.quantity === undefined ? {} : { quantity: o.quantity }),
			},
		],
		periodStart: o.start,
		periodEnd: o.end,
		at: o.at,
		metadata: { b4u_school: SCHOOL, family_id: o.family ?? FAMILY },
	});
