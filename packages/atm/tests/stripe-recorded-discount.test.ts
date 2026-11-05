/**
 * Discounted invoices as Stripe really sends them (test mode, 2025-10-29.clover), recorded 2026-11-05. The question was
 * whether an invoice line's `amount` is gross (price x quantity) with a coupon only in `discount_amounts`, or net. It is
 * gross: `subtotal` is the sum of the lines' `amount`, `total` is `subtotal` less the discount, `amount_paid` follows
 * `total`. A proration line is not discountable (`discountable: false`, discount 0), so a raise invoice under a coupon
 * is not discounted at all. See `fixtures/billing/stripe/recorded/README.md`, section "Discounted invoices".
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Fact, mappingFor, normalize } from "../src/billing/normalize.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type { BillingInvoice, Menu } from "../src/billing/types.js";
import { createStore } from "./billing-store.js";
import { priceIdOf, type RawEvent } from "./stripe-events.js";
import { shapeProblems } from "./stripe-shape.js";

const API = "2025-10-29.clover";
const SCHOOL = "sch_probe";
const SECOND = 1000;
const recordedDir = join(
	import.meta.dir,
	"../fixtures/billing/stripe/recorded/discount",
);
const load = (name: string): RawEvent =>
	JSON.parse(readFileSync(join(recordedDir, name), "utf8"));

/** The recorded files, listed by name on purpose: a new file is a new line here (and a check below compares the directory). */
const FILES = [
	"invoice.paid.discount_pct15_create.json",
	"invoice.paid.discount_amt500_create.json",
	"invoice.paid.discount_pct100_create.json",
	"invoice.paid.discount_pct15_raise_create.json",
	"invoice.paid.discount_pct15_raise.json",
	"invoice.paid.discount_pct15_cycle.json",
];

const invoiceOf = (event: RawEvent): BillingInvoice => {
	const mapping = mappingFor(event.type, event.api_version);
	if (!mapping.ok) throw new Error("no mapping");
	const result = normalize(event, mapping.value, { eventId: event.id });
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value as Fact as BillingInvoice;
};
const invoiceFrom = (name: string): BillingInvoice => invoiceOf(load(name));

const menu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
const quantityMenu: Menu = {
	...menu,
	tiers: menu.tiers.map((tier) =>
		tier.id === "sparkle-2" ? { ...tier, quantities: [1, 2, 4] } : tier,
	),
};
// the tier price the recorded invoices' lines are read as (their real price id is a probe price, not on the menu)
const tierKey = lookupKeyOf(
	SCHOOL,
	tierPriceKey("sparkle-2", "month"),
	26000,
	"usd",
);
const toMenuPrice = (event: RawEvent): RawEvent => {
	const copy = structuredClone(event);
	for (const line of copy.data.object.lines.data)
		line.pricing.price_details.price = priceIdOf(tierKey);
	return copy;
};

/** The same invoice as if no coupon had applied: no discount lists, the total and what was paid at the subtotal. */
const withoutDiscount = (event: RawEvent): RawEvent => {
	const copy = structuredClone(event);
	const invoice = copy.data.object;
	for (const line of invoice.lines.data) line.discount_amounts = [];
	invoice.discounts = [];
	invoice.total_discount_amounts = [];
	invoice.total = invoice.subtotal;
	invoice.amount_due = invoice.subtotal;
	invoice.amount_paid = invoice.subtotal;
	return copy;
};

describe("recorded discounted invoices (2025-10-29.clover)", () => {
	test("the directory holds exactly the files named here", () => {
		expect(
			readdirSync(recordedDir)
				.filter((name) => name.endsWith(".json"))
				.sort(),
		).toEqual([...FILES].sort());
	});

	test.each(FILES)("%s is a test-mode invoice.paid that normalizes", (name) => {
		const event = load(name);
		expect(event.api_version).toBe(API);
		expect(event.type).toBe("invoice.paid");
		expect(event.data.object.livemode).toBe(false);
		expect(event.data.object.status).toBe("paid");
		expect(invoiceOf(event).source).toEqual({
			eventId: event.id,
			mapping: `stripe/${event.type}@v1`,
			stripeApiVersion: API,
		});
	});

	test("every file's lines add up to its subtotal, and total is the subtotal less the discount (the line amount is gross)", () => {
		for (const name of FILES) {
			const invoice = load(name).data.object;
			const lineAmounts = invoice.lines.data.reduce(
				(sum: number, line: { amount: number }) => sum + line.amount,
				0,
			);
			const discount = invoice.total_discount_amounts.reduce(
				(sum: number, entry: { amount: number }) => sum + entry.amount,
				0,
			);
			expect(lineAmounts, name).toBe(invoice.subtotal);
			expect(invoice.subtotal - discount, name).toBe(invoice.total);
			expect(invoice.amount_paid, name).toBe(invoice.total);
		}
	});

	test("created with a 15% coupon: the line is gross (2 x 1500), the 450 is the discount, 2550 is paid", () => {
		const event = load("invoice.paid.discount_pct15_create.json");
		const raw = event.data.object;
		expect(raw.billing_reason).toBe("subscription_create");
		expect(raw.subtotal).toBe(3000);
		expect(raw.total).toBe(2550);
		expect(raw.lines.data[0].amount).toBe(3000);
		expect(raw.lines.data[0].subtotal).toBe(3000);
		// the line's own `discounts` is empty; the invoice's holds the discount's id
		expect(raw.lines.data[0].discounts).toEqual([]);
		expect(raw.discounts).toHaveLength(1);
		const invoice = invoiceOf(event);
		expect(invoice.reason).toBe("subscription_create");
		expect(invoice.lines).toHaveLength(1);
		expect(invoice.lines[0]).toMatchObject({
			quantity: 2,
			amount: 3000,
			discount: 450,
			proration: false,
		});
		expect(invoice.discount).toBe(450);
		expect(invoice.amountPaid).toBe(2550);
	});

	test("created with a 500-cent coupon: the line is gross (3000), the discount 500, 2500 is paid", () => {
		const invoice = invoiceFrom("invoice.paid.discount_amt500_create.json");
		expect(invoice.lines).toHaveLength(1);
		expect(invoice.lines[0]).toMatchObject({
			quantity: 2,
			amount: 3000,
			discount: 500,
		});
		expect(invoice.discount).toBe(500);
		expect(invoice.amountPaid).toBe(2500);
	});

	test("created with a 100% coupon: paid 0, the whole line discounted, the amount still 3000, no payment on the invoice", () => {
		const event = load("invoice.paid.discount_pct100_create.json");
		const raw = event.data.object;
		expect(raw.total).toBe(0);
		expect(raw.amount_due).toBe(0);
		// a free invoice has no payment, so nothing to expand
		expect(raw.payments.data).toEqual([]);
		const invoice = invoiceOf(event);
		expect(invoice.amountPaid).toBe(0);
		expect(invoice.discount).toBe(3000);
		expect(invoice.lines[0]).toMatchObject({ amount: 3000, discount: 3000 });
	});

	test("raised 2 -> 4 under a 15% coupon: proration lines are not discountable, so the pair and the total are undiscounted", () => {
		const event = load("invoice.paid.discount_pct15_raise.json");
		const raw = event.data.object;
		expect(raw.billing_reason).toBe("subscription_update");
		// the invoice still lists the coupon, with 0 taken off
		expect(raw.discounts).toHaveLength(1);
		expect(
			raw.total_discount_amounts.map((entry: RawEvent) => entry.amount),
		).toEqual([0]);
		for (const line of raw.lines.data) {
			expect(line.discountable).toBe(false);
			expect(
				line.discount_amounts.map((entry: RawEvent) => entry.amount),
			).toEqual([0]);
		}
		const invoice = invoiceOf(event);
		expect(invoice.reason).toBe("subscription_update");
		expect(invoice.lines.map((line) => [line.quantity, line.amount])).toEqual([
			[2, -1700],
			[4, 3400],
		]);
		for (const line of invoice.lines) {
			expect(line.proration).toBe(true);
			// a total of 0 leaves the key out
			expect(Object.hasOwn(line, "discount")).toBe(false);
		}
		expect(Object.hasOwn(invoice, "discount")).toBe(false);
		expect(invoice.amountPaid).toBe(1700);
	});

	test("the renewal after a raise under a 15% coupon: 4 x 1500 gross, 900 off, 5100 paid", () => {
		const invoice = invoiceFrom("invoice.paid.discount_pct15_cycle.json");
		expect(invoice.reason).toBe("subscription_cycle");
		expect(invoice.lines).toHaveLength(1);
		expect(invoice.lines[0]).toMatchObject({
			quantity: 4,
			amount: 6000,
			discount: 900,
			proration: false,
		});
		expect(invoice.discount).toBe(900);
		expect(invoice.amountPaid).toBe(5100);
	});

	test("the school and family come through the subscription's metadata", () => {
		for (const name of FILES) {
			const event = load(name);
			expect(event.data.object.metadata, name).toEqual({});
			expect(invoiceOf(event).metadata, name).toMatchObject({
				b4u_school: SCHOOL,
			});
		}
	});
});

describe("recorded discounted invoices grant in full", () => {
	/** The stored rows without the invoice's own record: the engine's balances, lots and events. */
	const engineRows = (rows: { table: string }[]) =>
		JSON.stringify(rows.filter((row) => row.table !== "atm_grants"));
	const createdAt = (event: RawEvent) =>
		event.data.object.status_transitions.paid_at * SECOND;
	const storeFor = (family: string) =>
		createStore({ menu: quantityMenu, school: SCHOOL, family });

	test.each([
		"invoice.paid.discount_pct15_create.json",
		"invoice.paid.discount_amt500_create.json",
		"invoice.paid.discount_pct100_create.json",
	])(
		"%s: a create grants what the same invoice at full price grants",
		(name) => {
			const event = toMenuPrice(load(name));
			const family = event.data.object.parent.subscription_details.metadata
				.family_id as string;
			const at = createdAt(event) + 5 * SECOND;
			const store = storeFor(family);
			store.handle(event, at);
			expect(store.results.at(-1)?.refused, name).toBeUndefined();
			const plain = storeFor(family);
			plain.handle(withoutDiscount(event), at);
			expect(plain.results.at(-1)?.refused, name).toBeUndefined();
			// 2 units of sparkle-2: the visits of the tier, whatever was paid
			expect(plain.avail(at)).toBeGreaterThan(0);
			expect(store.avail(at), name).toBe(plain.avail(at));
			expect(engineRows(store.rows), name).toBe(engineRows(plain.rows));
		},
	);

	test("create, raise 2 -> 4 and renewal under a 15% coupon grant as they would at full price", () => {
		const create = toMenuPrice(
			load("invoice.paid.discount_pct15_raise_create.json"),
		);
		const raise = toMenuPrice(load("invoice.paid.discount_pct15_raise.json"));
		const cycle = toMenuPrice(load("invoice.paid.discount_pct15_cycle.json"));
		const family = create.data.object.parent.subscription_details.metadata
			.family_id as string;
		const run = (events: RawEvent[]) => {
			const store = storeFor(family);
			for (const event of events) {
				store.handle(event, createdAt(event) + 5 * SECOND);
				expect(store.results.at(-1)?.refused, event.id).toBeUndefined();
			}
			return store;
		};
		const discounted = run([create, raise, cycle]);
		const plain = run([create, raise, cycle].map(withoutDiscount));
		const afterRaise = run([create, raise]);
		const afterCreate = run([create]);
		const raiseAt = createdAt(raise) + SECOND;
		// the raise added credits (the proration lines are what a raise is read from), and the renewal reset the quantity
		expect(afterRaise.avail(raiseAt)).toBeGreaterThan(
			afterCreate.avail(raiseAt),
		);
		const cycleAt = createdAt(cycle) + SECOND;
		expect(discounted.avail(cycleAt)).toBe(plain.avail(cycleAt));
		expect(engineRows(discounted.rows)).toBe(engineRows(plain.rows));
	});
});

describe("recorded discounted invoices carry no secret", () => {
	const UNLISTED_OR_NULL = /must NOT have additional properties|must be null$/;

	test.each(FILES)(
		"%s: no real account id, email, hosted link or key-like run",
		(name) => {
			const text = readFileSync(join(recordedDir, name), "utf8");
			expect(text).not.toMatch(/acct_[A-Za-z0-9]+/);
			expect(text).not.toMatch(/"[^"\s]+@[^"\s]+"/);
			expect(text).not.toMatch(/https:\/\/[a-z]+\.stripe\.com/);
			expect(text).not.toMatch(/[0-9a-f]{64}/i);
			expect(text).not.toMatch(/\b[rs]k_(test|live)_/);
		},
	);

	test.each(FILES)(
		"%s: no value of a wrong type against the OpenAPI spec",
		(name) => {
			for (const problem of shapeProblems(load(name)))
				expect(problem).toMatch(UNLISTED_OR_NULL);
		},
	);
});
