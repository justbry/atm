import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Fact, mappingFor, normalize } from "../src/billing/normalize.js";
import type { BillingInvoice, SubscriptionFact } from "../src/billing/types.js";
import { shapeProblems } from "./stripe-shape.js";

/**
 * Recorded Stripe payloads about quantity: a subscription created with two units, raised to four mid-cycle, a renewal
 * carrying leftover proration lines, and a subscription with two items. Real API objects from the Stripe sandbox (test
 * mode, 2025-10-29.clover), scrubbed, wrapped as events. See `fixtures/billing/stripe/recorded/README.md`.
 */

const API = "2025-10-29.clover";
const recordedDir = join(
	import.meta.dir,
	"../fixtures/billing/stripe/recorded",
);

// biome-ignore lint/suspicious/noExplicitAny: recorded Stripe JSON is read by path, untyped
const load = (name: string): any =>
	JSON.parse(readFileSync(join(recordedDir, name), "utf8"));

/** The quantity fixtures, listed by name on purpose: a new file is a new line here. */
const QUANTITY_EVENTS: string[] = [
	"invoice.paid.quantity_create.json",
	"invoice.paid.quantity_raise.json",
	"invoice.paid.quantity_cycle_with_prorations.json",
	"customer.subscription.updated.quantity_raise.json",
	"customer.subscription.created.two_items.json",
	"invoice.paid.two_items_create.json",
];

const SECOND = 1000;
/** Sandbox test clock: the subscription starts here (seconds), a 30-day month later the period ends. */
const CREATED_AT = 1793871784;
const CHANGED_AT = 1794735784;
const PERIOD_END = 1796463784;
const NEXT_PERIOD_END = 1799142184;
const LOWERED_AT = 1794994984;
const SUBSCRIPTION_METADATA = {
	b4u_school: "sch_probe",
	family_id: "fam_probe",
};

const normalized = (event: { id: string; type: string }): Fact => {
	const mapping = mappingFor(event.type, API);
	if (!mapping.ok) throw new Error(`no mapping for ${event.type}`);
	const result = normalize(event, mapping.value, { eventId: event.id });
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value;
};

const invoiceFrom = (name: string): BillingInvoice =>
	normalized(load(name)) as BillingInvoice;

describe("recorded quantity payloads (2025-10-29.clover)", () => {
	test.each(QUANTITY_EVENTS)("%s normalizes with its mapping", (name) => {
		const event = load(name);
		expect(event.api_version).toBe(API);
		expect(event.object).toBe("event");
		expect(event.data.object.livemode).toBe(false);
		expect(normalized(event).source).toEqual({
			eventId: event.id,
			mapping: `stripe/${event.type}@v1`,
			stripeApiVersion: API,
		});
	});

	test("created with quantity 2: one tier line of quantity 2, not a proration, 2 x 1500", () => {
		const event = load("invoice.paid.quantity_create.json");
		const invoice = invoiceFrom("invoice.paid.quantity_create.json");
		expect(invoice.reason).toBe("subscription_create");
		expect(invoice.amountPaid).toBe(3000);
		expect(invoice.lines).toHaveLength(1);
		const [line] = invoice.lines;
		expect(line?.quantity).toBe(2);
		expect(line?.amount).toBe(3000);
		expect(line?.proration).toBe(false);
		expect(line?.priceId).toBe(
			event.data.object.lines.data[0].pricing.price_details.price,
		);
		expect(line?.periodStart).toBe(CREATED_AT * SECOND);
		expect(line?.periodEnd).toBe(PERIOD_END * SECOND);
	});

	test("raised 2 -> 4 mid-cycle: two proration lines on one price, the old quantity credited and the new total charged", () => {
		const event = load("invoice.paid.quantity_raise.json");
		const invoice = invoiceFrom("invoice.paid.quantity_raise.json");
		expect(invoice.reason).toBe("subscription_update");
		expect(invoice.amountPaid).toBe(2000);
		expect(invoice.lines).toHaveLength(2);
		const [credit, charge] = invoice.lines;
		expect(credit?.proration).toBe(true);
		expect(charge?.proration).toBe(true);
		// the old quantity, credited
		expect(credit?.quantity).toBe(2);
		expect(credit?.amount).toBe(-2000);
		// the new total (not the delta of 2), charged
		expect(charge?.quantity).toBe(4);
		expect(charge?.amount).toBe(4000);
		// the same price on both lines
		expect(credit?.priceId).toBe(charge?.priceId as string);
		expect(credit?.priceId).toBe(
			event.data.object.lines.data[0].pricing.price_details.price,
		);
		// the net is what was paid
		expect((credit?.amount ?? 0) + (charge?.amount ?? 0)).toBe(
			invoice.amountPaid,
		);
	});

	test("raised 2 -> 4: the invoice covers the elapsed part of the cycle, its lines the remaining part", () => {
		const invoice = invoiceFrom("invoice.paid.quantity_raise.json");
		expect(invoice.periodStart).toBe(CREATED_AT * SECOND);
		expect(invoice.periodEnd).toBe(CHANGED_AT * SECOND);
		for (const line of invoice.lines) {
			expect(line.periodStart).toBe(CHANGED_AT * SECOND);
			expect(line.periodEnd).toBe(PERIOD_END * SECOND);
			// a line starts later than the invoice's own period start
			expect(line.periodStart).toBeGreaterThan(invoice.periodStart);
		}
	});

	test("raised 2 -> 4: the credit line names the invoice line it credits", () => {
		const created = load("invoice.paid.quantity_create.json").data.object;
		const raised = load("invoice.paid.quantity_raise.json").data.object;
		const [credit, charge] = raised.lines.data;
		expect(raised.billing_reason).toBe("subscription_update");
		expect(credit.parent.subscription_item_details.proration_details).toEqual({
			credited_items: {
				invoice: created.id,
				invoice_line_items: [created.lines.data[0].id],
			},
		});
		expect(charge.parent.subscription_item_details.proration_details).toEqual({
			credited_items: null,
		});
		// both lines are about the one subscription item
		expect(credit.parent.subscription_item_details.subscription_item).toBe(
			charge.parent.subscription_item_details.subscription_item,
		);
	});

	test("renewal after a decrease with prorations: the old cycle's proration lines ride on the cycle invoice beside the tier line", () => {
		const event = load("invoice.paid.quantity_cycle_with_prorations.json");
		const invoice = invoiceFrom(
			"invoice.paid.quantity_cycle_with_prorations.json",
		);
		expect(invoice.reason).toBe("subscription_cycle");
		expect(invoice.amountPaid).toBe(1300);
		// the invoice's own period is the old cycle
		expect(invoice.periodStart).toBe(CREATED_AT * SECOND);
		expect(invoice.periodEnd).toBe(PERIOD_END * SECOND);
		expect(invoice.lines).toHaveLength(3);
		const prorations = invoice.lines.filter((line) => line.proration);
		const tierLines = invoice.lines.filter((line) => !line.proration);
		expect(tierLines).toHaveLength(1);
		expect(prorations).toHaveLength(2);
		// the tier line: the new quantity, for the new cycle
		expect(tierLines[0]?.quantity).toBe(2);
		expect(tierLines[0]?.amount).toBe(3000);
		expect(tierLines[0]?.periodStart).toBe(PERIOD_END * SECOND);
		expect(tierLines[0]?.periodEnd).toBe(NEXT_PERIOD_END * SECOND);
		// the proration lines: the old quantity credited, the new one charged, for the tail of the old cycle
		expect(prorations.map((line) => [line.quantity, line.amount])).toEqual([
			[4, -3400],
			[2, 1700],
		]);
		for (const line of prorations) {
			expect(line.periodStart).toBe(LOWERED_AT * SECOND);
			expect(line.periodEnd).toBe(PERIOD_END * SECOND);
		}
		// one price throughout
		expect(new Set(invoice.lines.map((line) => line.priceId)).size).toBe(1);
		expect(invoice.lines[0]?.priceId).toBe(
			event.data.object.lines.data[2].pricing.price_details.price,
		);
		// the lines add up to the total
		expect(invoice.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(
			invoice.amountPaid,
		);
	});

	test("customer.subscription.updated after the raise: the item's quantity is 4, its period unchanged", () => {
		const event = load("customer.subscription.updated.quantity_raise.json");
		const item = event.data.object.items.data[0];
		expect(item.quantity).toBe(4);
		expect(event.data.object.items.data).toHaveLength(1);
		const subscription = normalized(event) as SubscriptionFact;
		expect(subscription.status).toBe("active");
		expect(subscription.items).toEqual([
			{
				lookupKey: null,
				interval: "month",
				priceId: item.price.id,
				quantity: 4,
			},
		]);
		expect(subscription.currentPeriodStart).toBe(CREATED_AT * SECOND);
		expect(subscription.currentPeriodEnd).toBe(PERIOD_END * SECOND);
		expect(subscription.metadata).toEqual(SUBSCRIPTION_METADATA);
		// the raise invoice is the subscription's latest invoice
		const raised = load("invoice.paid.quantity_raise.json").data.object;
		expect(event.data.object.latest_invoice).toBe(raised.id);
		expect(raised.parent.subscription_details.subscription).toBe(
			event.data.object.id,
		);
	});

	test("a subscription with two items: tier (quantity 3) first, then the add-on (quantity 1)", () => {
		const event = load("customer.subscription.created.two_items.json");
		const items = event.data.object.items.data;
		expect(items).toHaveLength(2);
		expect(items.map((item: { quantity: number }) => item.quantity)).toEqual([
			3, 1,
		]);
		const subscription = normalized(event) as SubscriptionFact;
		expect(subscription.items.map((item) => item.quantity)).toEqual([3, 1]);
		expect(subscription.items.map((item) => item.priceId)).toEqual(
			items.map((item: { price: { id: string } }) => item.price.id),
		);
		expect(new Set(subscription.items.map((item) => item.priceId)).size).toBe(
			2,
		);
		expect(subscription.metadata).toEqual(SUBSCRIPTION_METADATA);
	});

	test("the two-item create invoice: lines in the item order, and the subscription's metadata merged into the invoice's", () => {
		const subscription = load("customer.subscription.created.two_items.json")
			.data.object;
		const event = load("invoice.paid.two_items_create.json");
		const invoice = invoiceFrom("invoice.paid.two_items_create.json");
		expect(invoice.reason).toBe("subscription_create");
		expect(invoice.amountPaid).toBe(5000);
		expect(invoice.subscriptionId).toBe(subscription.id);
		expect(invoice.lines.map((line) => [line.quantity, line.amount])).toEqual([
			[3, 4500],
			[1, 500],
		]);
		expect(invoice.lines.map((line) => line.priceId)).toEqual(
			subscription.items.data.map(
				(item: { price: { id: string } }) => item.price.id,
			),
		);
		for (const line of invoice.lines) expect(line.proration).toBe(false);
		// the invoice's own metadata is empty: the data comes through the subscription's
		expect(event.data.object.metadata).toEqual({});
		expect(event.data.object.parent.subscription_details.metadata).toEqual(
			SUBSCRIPTION_METADATA,
		);
		expect(invoice.metadata).toEqual(SUBSCRIPTION_METADATA);
	});

	test("every quantity invoice carries the school and family through the subscription's metadata", () => {
		for (const name of QUANTITY_EVENTS.filter((file) =>
			file.startsWith("invoice."),
		)) {
			const event = load(name);
			expect(event.data.object.metadata).toEqual({});
			expect(invoiceFrom(name).metadata).toEqual(SUBSCRIPTION_METADATA);
		}
	});

	test("the quantity files carry no real account id, email, hosted link, or idempotency key", () => {
		for (const name of QUANTITY_EVENTS) {
			const text = readFileSync(join(recordedDir, name), "utf8");
			expect(text).not.toMatch(/acct_[A-Za-z0-9]+/);
			expect(text).not.toMatch(/"[^"\s]+@[^"\s]+"/);
			expect(text).not.toMatch(/https:\/\/[a-z]+\.stripe\.com/);
			expect(text).not.toMatch(/https:\/\/files\.stripe\.com/);
			// the envelope has none; nothing else may hold one but the scrubbed value
			for (const [, value] of text.matchAll(/"idempotency_key":\s*(.+?),?\n/g))
				expect(["null", '"scrubbed-idempotency-key"']).toContain(value);
			// no 64-hex-character secret-looking run
			expect(text).not.toMatch(/[0-9a-f]{64}/i);
		}
	});
});

describe("recorded quantity payloads against the pruned OpenAPI spec", () => {
	// Same rule as tests/stripe-recorded.test.ts: real Stripe sends fields the pruned spec lacks (and the nullable
	// branch those sit under), never a value of the wrong type.
	const UNLISTED_OR_NULL = /must NOT have additional properties|must be null$/;

	test.each(QUANTITY_EVENTS)("%s: no value of a wrong type", (name) => {
		for (const problem of shapeProblems(load(name)))
			expect(problem).toMatch(UNLISTED_OR_NULL);
	});
});
