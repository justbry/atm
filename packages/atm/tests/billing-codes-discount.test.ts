/**
 * A discount never changes what a paid invoice grants (0.8.0). Stripe's invoice line `amount` is read as the GROSS line
 * (price x quantity before any discount; `subtotal` is documented as "before any discounts or taxes", and an invoice's
 * `subtotal` is the sum of its lines' amounts); what a coupon took off is `discount_amounts`, which `InvoiceLine.discount`
 * and `BillingInvoice.discount` carry as a fact. Credits follow the quantity and the menu, so a 15% off invoice and a 100%
 * off invoice grant in full, and a raise reads the gross amounts of its proration pair.
 *
 * SYNTHETIC (the gross reading is now VERIFIED): the two files in `fixtures/billing/stripe/synthetic/` are a recorded
 * invoice with discount fields added by hand. Real discounted invoices were recorded afterwards
 * (`fixtures/billing/stripe/recorded/discount/`, `tests/stripe-recorded-discount.test.ts`) and confirm that a line's
 * `amount` is gross. They differ from these files in the line's own `discounts` (empty on Stripe) and in proration
 * lines (not discountable on Stripe, discount 0); these tests stay for what a recording cannot make: several discounts
 * on one line, and a coupon on a proration line.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Fact, mappingFor, normalize } from "../src/billing/normalize.js";
import { prorationPair, raiseUnits } from "../src/billing/raise.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type {
	BillingInvoice,
	InvoiceLine,
	Menu,
} from "../src/billing/types.js";
import { createStore } from "./billing-store.js";
import {
	type EventLine,
	invoicePaid,
	priceIdOf,
	type RawEvent,
} from "./stripe-events.js";
import { shapeProblems } from "./stripe-shape.js";

const SCHOOL = "sch_vol";
const FAMILY = "fam_disc";
const SECOND = 1000;
const DAY = 86_400 * SECOND;
const T0 = Date.parse("2026-01-15T18:00:00Z");
const T1 = T0 + 30 * DAY;
const menu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
const sparkleKey = lookupKeyOf(
	SCHOOL,
	tierPriceKey("sparkle-2", "month"),
	26000,
	"usd",
);
const metadata = { b4u_school: SCHOOL, family_id: FAMILY };
const syntheticDir = join(
	import.meta.dir,
	"../fixtures/billing/stripe/synthetic",
);
const load = (name: string): RawEvent =>
	JSON.parse(readFileSync(join(syntheticDir, name), "utf8"));

const invoiceOf = (event: RawEvent): BillingInvoice => {
	const mapping = mappingFor(event.type, event.api_version);
	if (!mapping.ok) throw new Error("no mapping");
	const result = normalize(event, mapping.value, { eventId: event.id });
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value as Fact as BillingInvoice;
};

/** The same event with `discounts[i]` cents taken off line i (its `amount` stays gross) and the invoice's totals following. */
const discounted = (event: RawEvent, discounts: number[]): RawEvent => {
	const copy = structuredClone(event);
	const invoice = copy.data.object;
	let total = 0;
	invoice.lines.data.forEach((line: RawEvent, index: number) => {
		const off = discounts[index] ?? 0;
		total += off;
		line.discount_amounts =
			off > 0 ? [{ amount: off, discount: "di_synth" }] : [];
	});
	invoice.total_discount_amounts =
		total > 0 ? [{ amount: total, discount: "di_synth" }] : [];
	invoice.amount_paid -= total;
	return copy;
};

describe("SYNTHETIC discounted invoice facts", () => {
	test("a 15% off invoice: the line keeps its gross amount, the discount is a fact, amountPaid is net", () => {
		const invoice = invoiceOf(load("invoice.paid.discount_15pct.json"));
		expect(invoice.lines).toHaveLength(1);
		expect(invoice.lines[0]?.amount).toBe(1500);
		expect(invoice.lines[0]?.discount).toBe(225);
		expect(invoice.discount).toBe(225);
		expect(invoice.amountPaid).toBe(1275);
	});

	test("a 100% off invoice: paid 0, the whole line discounted, the amount still gross", () => {
		const invoice = invoiceOf(load("invoice.paid.discount_100pct.json"));
		expect(invoice.amountPaid).toBe(0);
		expect(invoice.discount).toBe(1500);
		expect(invoice.lines[0]).toMatchObject({ amount: 1500, discount: 1500 });
	});

	test("several discounts on one line are added up", () => {
		const event = load("invoice.paid.discount_15pct.json");
		const line = event.data.object.lines.data[0];
		line.discount_amounts = [
			{ amount: 100, discount: "di_a" },
			{ amount: 50, discount: "di_b" },
		];
		event.data.object.total_discount_amounts = line.discount_amounts;
		const invoice = invoiceOf(event);
		expect(invoice.lines[0]?.discount).toBe(150);
		expect(invoice.discount).toBe(150);
	});

	test("an invoice with no discount has no discount key, as before", () => {
		const event = invoicePaid({
			eventId: "evt_plain",
			invoiceId: "in_plain",
			at: T0,
			subscriptionId: "sub_1",
			reason: "subscription_create",
			periodStart: T0,
			periodEnd: T1,
			lines: [{ lookupKey: sparkleKey, amount: 26000, interval: "month" }],
			metadata,
		});
		const invoice = invoiceOf(event);
		expect(Object.hasOwn(invoice, "discount")).toBe(false);
		expect(Object.hasOwn(invoice.lines[0] as InvoiceLine, "discount")).toBe(
			false,
		);
		// the recorded invoices carry empty lists: still no key
		const recorded = JSON.parse(
			readFileSync(
				join(
					import.meta.dir,
					"../fixtures/billing/stripe/recorded/invoice.paid.subscription_create.json",
				),
				"utf8",
			),
		);
		expect(recorded.data.object.total_discount_amounts).toEqual([]);
		expect(Object.hasOwn(invoiceOf(recorded), "discount")).toBe(false);
	});

	test("a discount that is not a whole number is refused, not coerced", () => {
		const event = load("invoice.paid.discount_15pct.json");
		event.data.object.lines.data[0].discount_amounts = [{ amount: "225" }];
		const mapping = mappingFor(event.type, event.api_version);
		if (!mapping.ok) throw new Error("no mapping");
		const result = normalize(event, mapping.value, { eventId: event.id });
		expect(result.ok).toBe(false);
	});

	test("the synthetic files are in Stripe's shape: nothing of the wrong type", () => {
		for (const name of [
			"invoice.paid.discount_15pct.json",
			"invoice.paid.discount_100pct.json",
		])
			for (const problem of shapeProblems(load(name)))
				expect(problem).toMatch(
					/must NOT have additional properties|must be null$/,
				);
	});
});

describe("SYNTHETIC credits do not follow discounts", () => {
	const create = (event: RawEvent) => {
		const store = createStore({ menu, school: SCHOOL, family: FAMILY });
		const line = event.data.object.lines.data[0];
		line.pricing.price_details.price = priceIdOf(sparkleKey);
		event.data.object.parent.subscription_details.metadata = metadata;
		event.data.object.parent.subscription_details.subscription = "sub_1";
		event.data.object.status_transitions.paid_at = Math.floor(T0 / SECOND);
		line.period = {
			start: Math.floor(T0 / SECOND),
			end: Math.floor(T1 / SECOND),
		};
		store.handle(event, T0 + 5 * SECOND);
		return store;
	};
	const full = () => {
		const store = createStore({ menu, school: SCHOOL, family: FAMILY });
		store.handle(
			invoicePaid({
				eventId: "evt_full",
				invoiceId: "in_full",
				at: T0 + 5 * SECOND,
				subscriptionId: "sub_1",
				reason: "subscription_create",
				periodStart: T0,
				periodEnd: T1,
				lines: [{ lookupKey: sparkleKey, amount: 26000, interval: "month" }],
				metadata,
			}),
			T0 + 5 * SECOND,
		);
		return store;
	};

	test("create: a 15% off and a 100% off invoice grant what a full-price one does", () => {
		const reference = full().avail(T0 + DAY);
		expect(reference).toBe(2);
		for (const name of [
			"invoice.paid.discount_15pct.json",
			"invoice.paid.discount_100pct.json",
		]) {
			const store = create(load(name));
			expect(store.results.at(-1)?.refused, name).toBeUndefined();
			expect(store.avail(T0 + DAY), name).toBe(reference);
		}
	});

	test("create: the stored rows are the same with and without the discount (the invoice's record apart)", () => {
		const plain = full();
		const free = create(load("invoice.paid.discount_100pct.json"));
		const engineRows = (rows: typeof plain.rows) =>
			JSON.stringify(rows.filter((row) => row.table !== "atm_grants"));
		expect(engineRows(free.rows)).toBe(engineRows(plain.rows));
	});

	test("cycle: a discounted renewal refills in full", () => {
		const reference = full();
		const store = full();
		const cycle = (id: string, off: number) =>
			discounted(
				invoicePaid({
					eventId: `evt_${id}`,
					invoiceId: `in_${id}`,
					at: T1 + 5 * SECOND,
					subscriptionId: "sub_1",
					reason: "subscription_cycle",
					periodStart: T0,
					periodEnd: T1,
					lines: [
						{
							lookupKey: sparkleKey,
							amount: 26000,
							interval: "month",
							periodStart: T1,
							periodEnd: T1 + 30 * DAY,
						},
					],
					metadata,
				}),
				[off],
			);
		reference.spend(2, T0 + 2 * DAY);
		store.spend(2, T0 + 2 * DAY);
		reference.handle(cycle("cyc", 0), T1 + 5 * SECOND);
		store.handle(cycle("cyc", 26000), T1 + 5 * SECOND);
		expect(store.results.at(-1)?.refused).toBeUndefined();
		expect(store.avail(T1 + DAY)).toBe(reference.avail(T1 + DAY));
		expect(store.avail(T1 + DAY)).toBeGreaterThanOrEqual(2);
	});

	test("raise: a discount on the proration lines changes no grant (prorationPair reads gross amounts)", () => {
		const quantityMenu: Menu = {
			...menu,
			tiers: menu.tiers.map((tier) =>
				tier.id === "sparkle-2" ? { ...tier, quantities: [1, 2, 4] } : tier,
			),
		};
		const key = lookupKeyOf(
			SCHOOL,
			tierPriceKey("sparkle-2", "month"),
			26000,
			"usd",
		);
		const RAISED = T0 + 10 * DAY;
		const lines: EventLine[] = [
			{
				lookupKey: key,
				amount: -1000 * 2,
				interval: "month",
				quantity: 2,
				proration: true,
				periodStart: RAISED,
				periodEnd: T1,
			},
			{
				lookupKey: key,
				amount: 1000 * 4,
				interval: "month",
				quantity: 4,
				proration: true,
				periodStart: RAISED,
				periodEnd: T1,
			},
		];
		const run = (discount: number[]) => {
			const store = createStore({
				menu: quantityMenu,
				school: SCHOOL,
				family: FAMILY,
			});
			store.handle(
				invoicePaid({
					eventId: "evt_q",
					invoiceId: "in_q",
					at: T0 + 5 * SECOND,
					subscriptionId: "sub_1",
					reason: "subscription_create",
					periodStart: T0,
					periodEnd: T0,
					lines: [
						{
							lookupKey: key,
							amount: 3000,
							interval: "month",
							quantity: 2,
							periodStart: T0,
							periodEnd: T1,
						},
					],
					metadata,
				}),
				T0 + 5 * SECOND,
			);
			store.handle(
				discounted(
					invoicePaid({
						eventId: "evt_r",
						invoiceId: "in_r",
						at: RAISED,
						subscriptionId: "sub_1",
						reason: "subscription_update",
						periodStart: T0,
						periodEnd: RAISED,
						lines,
						metadata,
					}),
					discount,
				),
				RAISED,
			);
			return store;
		};
		const plain = run([0, 0]);
		expect(plain.results.at(-1)?.refused).toBeUndefined();
		const reference = plain.avail(RAISED + DAY);
		// created at 2 units (4 visits); the raise to 4 units adds some more
		expect(reference).toBeGreaterThan(4);
		// a coupon on the new total, on both lines, and a 100% one: the same credits
		for (const discount of [
			[0, 400],
			[200, 400],
			[0, 4000],
			[2000, 4000],
		]) {
			const store = run(discount);
			expect(store.results.at(-1)?.refused, String(discount)).toBeUndefined();
			expect(store.avail(RAISED + DAY), String(discount)).toBe(reference);
		}
	});

	test("prorationPair and raiseUnits take the line's gross amount, not what it was discounted to", () => {
		const gross = (discount?: number): InvoiceLine[] => [
			{
				kind: "tier",
				interval: "month",
				quantity: 2,
				proration: true,
				amount: -2000,
				periodStart: T0 + 10 * DAY,
				periodEnd: T1,
			},
			{
				kind: "tier",
				interval: "month",
				quantity: 4,
				proration: true,
				amount: 4000,
				...(discount === undefined ? {} : { discount }),
				periodStart: T0 + 10 * DAY,
				periodEnd: T1,
			},
		];
		const isTier = (line: InvoiceLine) => line.kind === "tier";
		const plain = prorationPair(gross(), isTier);
		const free = prorationPair(gross(4000), isTier);
		expect(free).toEqual(plain);
		expect(plain).toMatchObject({ oldQuantity: 2, newQuantity: 4 });
		const units = (discount?: number) => {
			const pair = prorationPair(gross(discount), isTier);
			if (!pair) throw new Error("no pair");
			return raiseUnits({
				perUnit: 2,
				oldQuantity: pair.oldQuantity ?? 0,
				newQuantity: pair.newQuantity,
				at: T0 + 10 * DAY,
				cycleStart: T0,
				cycleEnd: T1,
				policy: { upgradeGrant: "prorated" },
			});
		};
		expect(units(4000)).toBe(units());
	});
});
