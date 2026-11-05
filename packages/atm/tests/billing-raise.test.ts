/**
 * The quantity raise as two pure functions (`prorationPair`, `raiseUnits`), through the public entry point, and the
 * check that `invoiceToCommands` grants what they say: one copy of the rule.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	DEFAULT_POLICY,
	EMPTY_GRANTS_STATE,
	type InvoiceLine,
	invoiceToCommands,
	type Menu,
	type ProrationLine,
	prorationPair,
	raiseUnits,
} from "../src/index.js";

const DAY = 24 * 3600 * 1000;
const CYCLE_START = Date.UTC(2026, 0, 1);
const CYCLE_END = CYCLE_START + 30 * DAY;
const TEN_DAYS_IN = CYCLE_START + 10 * DAY;

const policyOf = (upgradeGrant: "prorated" | "full" | "none") => ({
	upgradeGrant,
});

const raise = (over: Partial<Parameters<typeof raiseUnits>[0]> = {}) =>
	raiseUnits({
		perUnit: 2,
		oldQuantity: 2,
		newQuantity: 4,
		at: TEN_DAYS_IN,
		cycleStart: CYCLE_START,
		cycleEnd: CYCLE_END,
		policy: policyOf("prorated"),
		...over,
	});

describe("raiseUnits", () => {
	test("prorated: the extra units x per unit x the share of the cycle left, rounded up", () => {
		// (4 - 2) x 2 = 4 units, 20 of the 30 days left: 2.67, rounded up
		expect(raise()).toBe(3);
	});

	test("rounds up to one unit when only a sliver of the cycle is left", () => {
		expect(
			raise({
				perUnit: 1,
				oldQuantity: 1,
				newQuantity: 2,
				at: CYCLE_END - DAY,
			}),
		).toBe(1);
	});

	test("a raise at the end of the cycle has no share left", () => {
		expect(raise({ at: CYCLE_END })).toBe(0);
	});

	test("a raise before the cycle starts is the whole difference, not more", () => {
		expect(raise({ at: CYCLE_START - 5 * DAY })).toBe(4);
	});

	test("full grants all of the difference, whenever it is made", () => {
		expect(raise({ policy: policyOf("full") })).toBe(4);
		expect(raise({ policy: policyOf("full"), at: CYCLE_END - DAY })).toBe(4);
	});

	test("none grants nothing", () => {
		expect(raise({ policy: policyOf("none") })).toBe(0);
	});

	test("a decrease or the same count grants nothing, under any policy", () => {
		for (const upgradeGrant of ["prorated", "full", "none"] as const) {
			const policy = policyOf(upgradeGrant);
			expect(raise({ oldQuantity: 4, newQuantity: 2, policy })).toBe(0);
			expect(raise({ oldQuantity: 3, newQuantity: 3, policy })).toBe(0);
		}
	});

	test("without a cycle the whole difference is granted", () => {
		expect(raise({ cycleStart: null, cycleEnd: null })).toBe(4);
		expect(raise({ cycleEnd: null })).toBe(4);
	});

	test("takes a whole BillingPolicy as well", () => {
		expect(raise({ policy: DEFAULT_POLICY })).toBe(3);
	});
});

describe("prorationPair", () => {
	const line = (over: Partial<InvoiceLine> = {}): InvoiceLine => ({
		kind: "tier",
		priceId: "price_shine",
		tierId: "shine",
		interval: "month",
		quantity: 1,
		proration: true,
		amount: 0,
		periodStart: TEN_DAYS_IN,
		periodEnd: CYCLE_END,
		...over,
	});
	const credit = (quantity: number, over: Partial<InvoiceLine> = {}) =>
		line({ quantity, amount: -1000 * quantity, ...over });
	const charge = (quantity: number, over: Partial<InvoiceLine> = {}) =>
		line({ quantity, amount: 1000 * quantity, ...over });
	const isShine = (l: InvoiceLine) => l.priceId === "price_shine";

	test("reads the old quantity off the credit line and the new total off the charge line", () => {
		expect(prorationPair([credit(2), charge(4)], isShine)).toEqual({
			oldQuantity: 2,
			newQuantity: 4,
			start: TEN_DAYS_IN,
			end: CYCLE_END,
		});
	});

	test("the order of the lines does not matter", () => {
		expect(prorationPair([charge(4), credit(2)], isShine)).toEqual(
			prorationPair([credit(2), charge(4)], isShine),
		);
	});

	test("with several pairs the positive line that starts last is the raise, with its own credit", () => {
		const earlier = TEN_DAYS_IN - 3 * DAY;
		const stale = [
			credit(4, { periodStart: earlier }),
			charge(2, { periodStart: earlier }),
		];
		const wanted = {
			oldQuantity: 2,
			newQuantity: 3,
			start: TEN_DAYS_IN,
			end: CYCLE_END,
		};
		expect(prorationPair([...stale, credit(2), charge(3)], isShine)).toEqual(
			wanted,
		);
		expect(prorationPair([credit(2), charge(3), ...stale], isShine)).toEqual(
			wanted,
		);
	});

	test("lines of another price are ignored", () => {
		const addon = line({
			kind: "addon",
			priceId: "price_glow",
			quantity: 9,
			amount: 900,
			periodStart: TEN_DAYS_IN + DAY,
		});
		expect(prorationPair([credit(2), charge(4), addon], isShine)).toEqual({
			oldQuantity: 2,
			newQuantity: 4,
			start: TEN_DAYS_IN,
			end: CYCLE_END,
		});
		expect(prorationPair([addon], isShine)).toBeNull();
	});

	test("a line that is not a proration is not a raise", () => {
		expect(
			prorationPair([charge(4, { proration: false })], isShine),
		).toBeNull();
	});

	test("no charge line gives null", () => {
		expect(prorationPair([], isShine)).toBeNull();
		expect(prorationPair([credit(2)], isShine)).toBeNull();
	});

	test("a charge without its credit line has no old quantity", () => {
		expect(prorationPair([charge(4)], isShine)).toEqual({
			oldQuantity: null,
			newQuantity: 4,
			start: TEN_DAYS_IN,
			end: CYCLE_END,
		});
	});

	test("a charge without a period has no start or end", () => {
		const bare = (l: InvoiceLine): InvoiceLine => ({
			...l,
			periodStart: undefined,
			periodEnd: undefined,
		});
		expect(prorationPair([bare(credit(2)), bare(charge(4))], isShine)).toEqual({
			oldQuantity: 2,
			newQuantity: 4,
			start: null,
			end: null,
		});
	});

	test("a decrease's pair reads as fewer units, and raiseUnits grants nothing for it", () => {
		const pair = prorationPair([credit(4), charge(2)], isShine);
		expect(pair).toMatchObject({ oldQuantity: 4, newQuantity: 2 });
		expect(
			raiseUnits({
				perUnit: 2,
				oldQuantity: pair?.oldQuantity ?? 0,
				newQuantity: pair?.newQuantity ?? 0,
				at: TEN_DAYS_IN,
				cycleStart: CYCLE_START,
				cycleEnd: CYCLE_END,
				policy: DEFAULT_POLICY,
			}),
		).toBe(0);
	});

	test("takes lines a caller built from raw Stripe, not only InvoiceLine", () => {
		type RawLine = ProrationLine & { priceId: string };
		const raw: RawLine[] = [
			{
				priceId: "price_shine",
				proration: true,
				amount: -2000,
				quantity: 2,
				periodStart: TEN_DAYS_IN,
				periodEnd: CYCLE_END,
			},
			{
				priceId: "price_shine",
				proration: true,
				amount: 4000,
				quantity: 4,
				periodStart: TEN_DAYS_IN,
				periodEnd: CYCLE_END,
			},
		];
		expect(prorationPair(raw, (l) => l.priceId === "price_shine")).toEqual({
			oldQuantity: 2,
			newQuantity: 4,
			start: TEN_DAYS_IN,
			end: CYCLE_END,
		});
	});
});

describe("invoiceToCommands grants what the two functions say", () => {
	const baseMenu = JSON.parse(
		readFileSync(
			`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
			"utf8",
		),
	) as Menu;
	const menu: Menu = {
		...baseMenu,
		tiers: baseMenu.tiers.map((t) =>
			t.id === "sparkle-2" ? { ...t, quantities: [1, 2, 4] } : t,
		),
	};
	const source = { eventId: "evt_x", mapping: "test", stripeApiVersion: "x" };
	const tierLine = (over: Partial<InvoiceLine>): InvoiceLine => ({
		kind: "tier",
		tierId: "sparkle-2",
		interval: "month",
		quantity: 2,
		proration: false,
		amount: 0,
		periodStart: CYCLE_START,
		periodEnd: CYCLE_END,
		...over,
	});
	const invoice = (
		id: string,
		reason: "subscription_create" | "subscription_update",
		paidAt: number,
		lines: InvoiceLine[],
	) => ({
		source,
		id,
		customerId: "cus_x",
		subscriptionId: "sub_x",
		reason,
		paidAt,
		periodStart: CYCLE_START,
		periodEnd: paidAt,
		currency: "usd",
		amountPaid: lines.reduce((total, l) => total + l.amount, 0),
		lines,
		metadata: { b4u_school: "sch_x", family_id: "fam_x" },
	});

	test("a raise 2 -> 4 ten days in grants raiseUnits for each row, from the credits' quantity", () => {
		const created = invoiceToCommands({
			invoice: invoice("in_1", "subscription_create", CYCLE_START, [
				tierLine({ amount: 4000 }),
			]),
			menu,
			policy: DEFAULT_POLICY,
			state: EMPTY_GRANTS_STATE,
			now: CYCLE_START,
			menuVersion: 1,
			policyVersion: 1,
		});
		const lines = [
			tierLine({
				proration: true,
				quantity: 2,
				amount: -2000,
				periodStart: TEN_DAYS_IN,
			}),
			tierLine({
				proration: true,
				quantity: 4,
				amount: 4000,
				periodStart: TEN_DAYS_IN,
			}),
		];
		const raised = invoiceToCommands({
			invoice: invoice("in_2", "subscription_update", TEN_DAYS_IN, lines),
			menu,
			policy: DEFAULT_POLICY,
			state: created.state,
			now: TEN_DAYS_IN,
			menuVersion: 1,
			policyVersion: 1,
		});
		const pair = prorationPair(lines, (l) => l.kind === "tier");
		const perUnit = 2; // sparkle-2 grants 2 visits a unit a month
		const expected = raiseUnits({
			perUnit,
			oldQuantity: created.state.quantity,
			newQuantity: pair?.newQuantity ?? 0,
			at: pair?.start ?? 0,
			cycleStart: created.state.cycleStart,
			cycleEnd: created.state.cycleEnd,
			policy: DEFAULT_POLICY,
		});
		expect(expected).toBeGreaterThan(0);
		const granted = raised.state.invoices.in_2?.granted.map((g) => g.units);
		expect(granted).toEqual([expected]);
		expect(raised.state.quantity).toBe(4);
	});
});
