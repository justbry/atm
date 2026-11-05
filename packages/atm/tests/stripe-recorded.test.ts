import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Fact, mappingFor, normalize } from "../src/billing/normalize.js";
import type {
	BillingDispute,
	BillingInvoice,
	BillingRefund,
	SubscriptionFact,
} from "../src/billing/types.js";
import { shapeProblems } from "./stripe-shape.js";

const API = "2025-10-29.clover";
const recordedDir = join(
	import.meta.dir,
	"../fixtures/billing/stripe/recorded",
);

// biome-ignore lint/suspicious/noExplicitAny: recorded Stripe JSON is read by path, untyped
const load = (name: string): any =>
	JSON.parse(readFileSync(join(recordedDir, name), "utf8"));

/** The events in `fixtures/billing/stripe/recorded/`, listed by name on purpose: a new file is a new line here. */
const RECORDED_EVENTS: string[] = [
	"invoice.paid.subscription_create.json",
	"invoice.paid.subscription_cycle.json",
	"customer.subscription.created.json",
	"customer.subscription.updated.json",
	"customer.subscription.deleted.json",
	"charge.refunded.json",
	"charge.dispute.created.json",
];

/** A real API invoice, not an event: wrapped as `invoice.paid` the way the other recorded invoice is. */
const INVOICE_OBJECT_FILE = "invoice.with-subscription-metadata.json";

const normalized = (event: { id: string; type: string }): Fact => {
	const mapping = mappingFor(event.type, API);
	if (!mapping.ok) throw new Error(`no mapping for ${event.type}`);
	const result = normalize(event, mapping.value, { eventId: event.id });
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value;
};

const wrapAsInvoicePaid = (invoice: { id: string; created: number }) => ({
	id: "evt_wrapped_for_the_test",
	object: "event",
	api_version: API,
	created: invoice.created,
	type: "invoice.paid",
	data: { object: invoice },
});

describe("recorded Stripe payloads (2025-10-29.clover)", () => {
	test.each(RECORDED_EVENTS)("%s normalizes with its mapping", (name) => {
		const event = load(name);
		expect(event.api_version).toBe(API);
		expect(normalized(event).source).toEqual({
			eventId: event.id,
			mapping: `stripe/${event.type}@v1`,
			stripeApiVersion: API,
		});
	});

	test("charge.refunded: the charge carries no refund list, so the fact is the event's and the charge's totals", () => {
		const event = load("charge.refunded.json");
		expect(event.data.object.refunds).toBeUndefined();
		expect(event.data.previous_attributes.amount_refunded).toBe(0);
		const refund = normalized(event) as BillingRefund;
		expect(refund).toEqual({
			source: {
				eventId: event.id,
				mapping: "stripe/charge.refunded@v1",
				stripeApiVersion: API,
			},
			id: event.id,
			chargeId: event.data.object.id,
			paymentIntentId: event.data.object.payment_intent,
			amount: 100,
			full: true,
			at: event.created * 1000,
		});
	});

	test("charge.refunded: a partial refund of the same real charge is not full", () => {
		const event = load("charge.refunded.json");
		event.data.object.amount_refunded = 40;
		event.data.object.refunded = false;
		const refund = normalized(event) as BillingRefund;
		expect(refund.full).toBe(false);
		expect(refund.amount).toBe(40);
	});

	test("charge.refunded: a partly captured charge refunded in full is full, whether or not the uncaptured part counts as refunded", () => {
		// The captured part alone refunded.
		const capturedOnly = load("charge.refunded.json");
		capturedOnly.data.object.amount_captured = 60;
		capturedOnly.data.object.amount_refunded = 60;
		expect((normalized(capturedOnly) as BillingRefund).full).toBe(true);
		// The released remainder counted in amount_refunded too.
		const withRemainder = load("charge.refunded.json");
		withRemainder.data.object.amount_captured = 60;
		withRemainder.data.object.amount_refunded = 100;
		expect((normalized(withRemainder) as BillingRefund).full).toBe(true);
	});

	test("invoice.paid, subscription_create: reason, subscription, price and the line's period", () => {
		const event = load("invoice.paid.subscription_create.json");
		const invoice = normalized(event) as BillingInvoice;
		const object = event.data.object;
		expect(invoice.reason).toBe("subscription_create");
		expect(invoice.subscriptionId).toBe(
			object.parent.subscription_details.subscription,
		);
		expect(invoice.amountPaid).toBe(1500);
		expect(invoice.lines).toHaveLength(1);
		expect(invoice.lines[0]?.priceId).toBe(
			object.lines.data[0].pricing.price_details.price,
		);
		expect(invoice.lines[0]?.periodStart).toBe(
			object.lines.data[0].period.start * 1000,
		);
		expect(invoice.lines[0]?.periodEnd).toBe(
			object.lines.data[0].period.end * 1000,
		);
		// This invoice was made without subscription metadata: nothing to merge.
		expect(invoice.metadata).toEqual({});
	});

	test("invoice.paid: the number, the hosted page and the PDF are on the fact, for a receipt link", () => {
		for (const name of [
			"invoice.paid.subscription_create.json",
			"invoice.paid.subscription_cycle.json",
			"invoice.paid.quantity_raise.json",
		]) {
			const event = load(name);
			const invoice = normalized(event) as BillingInvoice;
			expect(invoice.number).toBe(event.data.object.number);
			expect(invoice.hostedInvoiceUrl).toBe(
				event.data.object.hosted_invoice_url,
			);
			expect(invoice.invoicePdf).toBe(event.data.object.invoice_pdf);
			expect(invoice.number).toMatch(/^[A-Z0-9]+-\d{4}$/);
		}
	});

	test("invoice.paid: a missing or null number and links read as null", () => {
		const event = load("invoice.paid.subscription_create.json");
		event.data.object.number = null;
		event.data.object.hosted_invoice_url = undefined;
		event.data.object.invoice_pdf = null;
		const invoice = normalized(event) as BillingInvoice;
		expect(invoice.number).toBeNull();
		expect(invoice.hostedInvoiceUrl).toBeNull();
		expect(invoice.invoicePdf).toBeNull();
	});

	test("invoice.paid, subscription_cycle: the invoice's own period is the previous one; the line holds the new one", () => {
		const event = load("invoice.paid.subscription_cycle.json");
		const object = event.data.object;
		const invoice = normalized(event) as BillingInvoice;
		expect(invoice.reason).toBe("subscription_cycle");
		expect(invoice.subscriptionId).toBe(
			object.parent.subscription_details.subscription,
		);
		expect(invoice.lines[0]?.priceId).toBe(
			object.lines.data[0].pricing.price_details.price,
		);
		const [line] = invoice.lines;
		expect(line?.periodStart).toBe(1796457498000);
		expect(line?.periodEnd).toBe(1799135898000);
		// the invoice's top-level period ends where the line's begins
		expect(invoice.periodStart).toBe(1793865498000);
		expect(invoice.periodEnd).toBe(line?.periodStart as number);
	});

	test("an invoice from a subscription with metadata: the subscription's metadata is merged into the fact's", () => {
		const raw = load(INVOICE_OBJECT_FILE);
		expect(raw.object).toBe("invoice");
		expect(raw.metadata).toEqual({});
		expect(raw.parent.subscription_details.metadata).toEqual({
			b4u_school: "sch_probe",
			family_id: "fam_probe",
		});
		const invoice = normalized(wrapAsInvoicePaid(raw)) as BillingInvoice;
		expect(invoice.metadata).toEqual({
			b4u_school: "sch_probe",
			family_id: "fam_probe",
		});
		expect(invoice).not.toHaveProperty("subscriptionMetadata");
	});

	test("an invoice's own metadata wins over the subscription's, key by key", () => {
		const raw = load(INVOICE_OBJECT_FILE);
		raw.metadata = { family_id: "fam_own", extra: "yes" };
		const invoice = normalized(wrapAsInvoicePaid(raw)) as BillingInvoice;
		expect(invoice.metadata).toEqual({
			b4u_school: "sch_probe",
			family_id: "fam_own",
			extra: "yes",
		});
	});

	test("customer.subscription.*: status, period of the first item, and its price and interval", () => {
		const expected = [
			["customer.subscription.created.json", "active"],
			["customer.subscription.updated.json", "active"],
			["customer.subscription.deleted.json", "canceled"],
		] as const;
		for (const [name, status] of expected) {
			const event = load(name);
			const item = event.data.object.items.data[0];
			const subscription = normalized(event) as SubscriptionFact;
			expect(subscription.status).toBe(status);
			expect(subscription.id).toBe(event.data.object.id);
			expect(subscription.currentPeriodStart).toBe(
				item.current_period_start * 1000,
			);
			expect(subscription.currentPeriodEnd).toBe(
				item.current_period_end * 1000,
			);
			expect(subscription.items).toEqual([
				{
					lookupKey: null,
					interval: "month",
					priceId: item.price.id,
					quantity: 1,
				},
			]);
			expect(item.quantity).toBe(1);
		}
	});

	test("charge.dispute.created: a warning is open; the dispute names its charge and payment intent", () => {
		const event = load("charge.dispute.created.json");
		const dispute = normalized(event) as BillingDispute;
		expect(dispute).toEqual({
			source: {
				eventId: event.id,
				mapping: "stripe/charge.dispute.created@v1",
				stripeApiVersion: API,
			},
			id: event.data.object.id,
			chargeId: event.data.object.charge,
			paymentIntentId: event.data.object.payment_intent,
			status: "open",
			at: event.created * 1000,
		});
		expect(event.data.object.status).toBe("warning_needs_response");
	});

	test("the recorded files carry no real account id, email, phone or receipt link", () => {
		const names = [...RECORDED_EVENTS, INVOICE_OBJECT_FILE];
		const text = names
			.map((name) => readFileSync(join(recordedDir, name), "utf8"))
			.join("\n");
		// Not the real account's id tail by name (that would put it back in the repo): any account id, any email, any
		// Stripe-hosted receipt or invoice link.
		expect(text).not.toMatch(/acct_[A-Za-z0-9]+/);
		expect(text).not.toMatch(/"[^"\s]+@[^"\s]+"/);
		expect(text).not.toMatch(/https:\/\/(pay|invoice|receipt)\.stripe\.com/);
		expect(text).not.toMatch(/https:\/\/files\.stripe\.com/);
	});
});

describe("recorded payloads against the pruned OpenAPI spec", () => {
	// Real Stripe sends fields the pruned spec (schema/stripe/objects.clover.json) lacks. The check stays strict for the
	// synthetic events; for real ones it may only complain about fields the spec does not list (or the nullable branch
	// those sit under), never about a value of the wrong type or a field a mapping reads.
	const UNLISTED_OR_NULL = /must NOT have additional properties|must be null$/;

	test.each([...RECORDED_EVENTS, INVOICE_OBJECT_FILE])(
		"%s: no value of a wrong type",
		(name) => {
			const raw = load(name);
			const event = raw.object === "invoice" ? wrapAsInvoicePaid(raw) : raw;
			for (const problem of shapeProblems(event))
				expect(problem).toMatch(UNLISTED_OR_NULL);
		},
	);
});
