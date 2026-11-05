import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAPPINGS } from "../src/billing/normalize.js";
import type { Mapping } from "../src/billing/types.js";
import {
	chargeRefunded,
	disputeEvent,
	invoicePaid,
	subscriptionDeleted,
} from "./stripe-events.js";
import {
	allMappingProblems,
	OBJECT_OF_EVENT,
	pathProblems,
	SPEC_VERSION,
	shapeProblems,
} from "./stripe-shape.js";

const dir = join(import.meta.dir, "../fixtures/billing/stripe");
const fixtures = readdirSync(dir)
	.filter((f) => f.endsWith(".json"))
	.sort();
const load = (name: string) =>
	JSON.parse(readFileSync(join(dir, name), "utf8"));

describe("Stripe's OpenAPI spec, pruned (schema/stripe/objects.clover.json)", () => {
	test("is the API version every mapping pins", () => {
		for (const m of MAPPINGS as readonly Mapping[])
			expect(m.stripeApiVersion).toBe(SPEC_VERSION);
	});

	test("covers an object for every event type a mapping reads", () => {
		for (const m of MAPPINGS as readonly Mapping[])
			expect(OBJECT_OF_EVENT[m.event]).toBeDefined();
	});
});

describe("mapping paths", () => {
	test("every path a mapping reads is a field of Stripe's object in that API version", () => {
		expect(allMappingProblems()).toEqual([]);
	});

	test("the check finds a path the API version does not have", () => {
		const mapping = structuredClone(
			MAPPINGS.find((m) => m.event === "charge.refunded"),
		) as Mapping;
		mapping.fields.invoiceId = {
			path: "$.data.object.invoice",
			type: "string",
			optional: true,
			default: null,
		};
		expect(pathProblems(mapping)).toEqual([
			"charge.refunded invoiceId: $.data.object.invoice is not in Stripe's charge",
		]);
		const invoice = structuredClone(
			MAPPINGS.find((m) => m.event === "invoice.paid"),
		) as Mapping;
		if (!invoice.lines) throw new Error("invoice.paid maps lines");
		invoice.lines.fields.lookupKey = {
			path: "$.price.lookup_key",
			type: "string",
			optional: true,
			default: null,
		};
		expect(pathProblems(invoice)).toEqual([
			"invoice.paid line lookupKey: $.price.lookup_key is not in Stripe's line item",
		]);
	});
});

describe("synthetic events", () => {
	test.each(fixtures)(
		"fixtures/billing/stripe/%s fits Stripe's shape",
		(name) => {
			expect(shapeProblems(load(name))).toEqual([]);
		},
	);

	test("the events the tests build fit Stripe's shape", () => {
		const T = Date.parse("2026-01-15T18:00:00Z");
		const events = [
			invoicePaid({
				eventId: "evt_1",
				invoiceId: "in_1",
				at: T,
				subscriptionId: "sub_1",
				reason: "subscription_create",
				periodStart: T,
				periodEnd: T + 86_400_000 * 30,
				lines: [
					{ lookupKey: "k1", amount: 26000, interval: "month" },
					{ lookupKey: "k2", amount: -500, proration: true },
				],
				metadata: { b4u_school: "sch", family_id: "fam" },
			}),
			invoicePaid({
				eventId: "evt_2",
				invoiceId: "in_2",
				at: T,
				subscriptionId: null,
				reason: "manual",
				periodStart: T,
				periodEnd: T,
				lines: [{ lookupKey: "gift", amount: 13000 }],
				metadata: {},
			}),
			chargeRefunded({
				eventId: "evt_3",
				refundId: "re_1",
				chargeId: "ch_1",
				invoiceId: "in_1",
				amount: 100,
				chargeAmount: 26000,
				at: T,
			}),
			disputeEvent({
				type: "charge.dispute.closed",
				eventId: "evt_4",
				disputeId: "dp_1",
				chargeId: "ch_1",
				invoiceId: "in_1",
				status: "lost",
				at: T,
			}),
			disputeEvent({
				type: "charge.dispute.created",
				eventId: "evt_5",
				disputeId: "dp_2",
				chargeId: "ch_1",
				invoiceId: null,
				status: "needs_response",
				at: T,
			}),
			subscriptionDeleted({
				eventId: "evt_6",
				subscriptionId: "sub_1",
				tierId: "sparkle-2",
				interval: "month",
				periodStart: T,
				periodEnd: T + 86_400_000 * 30,
				at: T,
			}),
		];
		for (const event of events) expect(shapeProblems(event)).toEqual([]);
	});

	test("the check finds a field Stripe's object does not have, and a value of the wrong type", () => {
		const invoice = load("invoice.paid.json");
		invoice.data.object.lines.data[0].proration = false;
		invoice.data.object.lines.data[0].price = { id: "price_x" };
		invoice.data.object.amount_paid = "30000";
		invoice.data.object.surprise = 1;
		expect(shapeProblems(invoice)).toEqual(
			expect.arrayContaining([
				"invoice.lines.data.0.proration: must NOT have additional properties",
				"invoice.lines.data.0.price: must NOT have additional properties",
				"invoice.amount_paid: must be integer",
				"invoice.surprise: must NOT have additional properties",
			]),
		);
		const charge = load("charge.refunded.json");
		charge.data.object.invoice = "in_1";
		expect(shapeProblems(charge)).toEqual([
			"charge.invoice: must NOT have additional properties",
		]);
	});
});
