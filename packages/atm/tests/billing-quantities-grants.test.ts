/**
 * A tier sold in a quantity (Vibes of Light: 1, 2 or 4 sessions a month): the menu's grants are per unit, and what a
 * paid invoice grants is the unit amount x its tier line's quantity. The periods and amounts are those of the Stripe
 * sandbox probe (API 2025-10-29.clover, a monthly price of 1500 a unit): created at quantity 2, raised to 4 ten days in
 * with always_invoice, lowered to 2 three days later, renewed at the period end.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	EMPTY_GRANTS_STATE,
	invoiceToCommands,
	subscriptionToCommands,
} from "../src/billing/grants.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	GRANTS_ROW_ID,
	GRANTS_TABLE,
	grantsFromRows,
} from "../src/billing/rows.js";
import {
	addonPriceKey,
	lookupKeyOf,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type {
	BillingInvoice,
	BillingPolicy,
	GrantsState,
	InvoiceLine,
	Menu,
	RowData,
} from "../src/billing/types.js";
import { createStore, type Store } from "./billing-store.js";
import {
	chargeRefunded,
	type EventLine,
	invoicePaid,
	subscriptionEvent,
} from "./stripe-events.js";

const SCHOOL = "sch_vol";
const FAMILY = "fam_q42";
const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;
const baseMenu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
// sparkle-2 is sold in 1, 2 or 4 units; each unit grants 2 visits a month, rolling over up to 2.
const menu: Menu = {
	...baseMenu,
	tiers: baseMenu.tiers.map((t) =>
		t.id === "sparkle-2" ? { ...t, quantities: [1, 2, 4] } : t,
	),
};
const metadata = { b4u_school: SCHOOL, family_id: FAMILY };

// The probe's instants (seconds to ms).
const CREATED = 1793871784 * SECOND;
const RAISED = 1794735784 * SECOND;
const LOWERED = 1794994984 * SECOND;
const CYCLE_END = 1796463784 * SECOND;
const NEXT_END = 1799142184 * SECOND;

const tierKey = (tierId: string, interval: "month" | "year") => {
	const price = menu.tiers
		.find((t) => t.id === tierId)
		?.prices.find((p) => p.interval === interval);
	return lookupKeyOf(
		SCHOOL,
		tierPriceKey(tierId, interval),
		price?.amount as number,
		menu.currency,
	);
};

const newStore = () => createStore({ menu, school: SCHOOL, family: FAMILY });
const grantsOf = (s: Store) => grantsFromRows(s.rows);

/** The probe's create invoice: one tier line at `quantity`, its period the first cycle; the invoice's own period a point. */
const create = (
	s: Store,
	{
		quantity = 2,
		tierId = "sparkle-2",
		interval = "month",
		end = CYCLE_END,
	}: {
		quantity?: number;
		tierId?: string;
		interval?: "month" | "year";
		end?: number;
	} = {},
) =>
	s.handle(
		invoicePaid({
			eventId: "evt_create",
			invoiceId: "in_create",
			at: CREATED,
			subscriptionId: "sub_q",
			reason: "subscription_create",
			periodStart: CREATED,
			periodEnd: CREATED,
			lines: [
				{
					lookupKey: tierKey(tierId, interval),
					amount: 1500 * quantity,
					interval,
					quantity,
					periodStart: CREATED,
					periodEnd: end,
				},
			],
			metadata,
		}),
		CREATED,
	);

/** The probe's raise lines: the credit at the OLD quantity, the charge at the NEW total, both from the change to the cycle end. */
const raiseLines = ({
	from = 2,
	to = 4,
	fromTier = "sparkle-2",
	toTier = "sparkle-2",
}: {
	from?: number;
	to?: number;
	fromTier?: string;
	toTier?: string;
} = {}): EventLine[] => [
	{
		lookupKey: tierKey(fromTier, "month"),
		amount: -1000 * from,
		interval: "month",
		quantity: from,
		proration: true,
		periodStart: RAISED,
		periodEnd: CYCLE_END,
	},
	{
		lookupKey: tierKey(toTier, "month"),
		amount: 1000 * to,
		interval: "month",
		quantity: to,
		proration: true,
		periodStart: RAISED,
		periodEnd: CYCLE_END,
	},
];

/** The probe's `subscription_update` invoice: its own period is the cycle start to the change. */
const raiseEvent = (lines: EventLine[] = raiseLines(), id = "raise") =>
	invoicePaid({
		eventId: `evt_${id}`,
		invoiceId: `in_${id}`,
		at: RAISED,
		subscriptionId: "sub_q",
		reason: "subscription_update",
		periodStart: CREATED,
		periodEnd: RAISED,
		lines,
		metadata,
	});

/** The probe's renewal: its own period is the old cycle, the tier line's the new one; `extra` lines ride before it. */
const renewal = (
	s: Store,
	{
		quantity,
		extra = [],
		id = "cycle_2",
	}: { quantity: number; extra?: EventLine[]; id?: string },
) =>
	s.handle(
		invoicePaid({
			eventId: `evt_${id}`,
			invoiceId: `in_${id}`,
			at: CYCLE_END + DAY,
			subscriptionId: "sub_q",
			reason: "subscription_cycle",
			periodStart: CREATED,
			periodEnd: CYCLE_END,
			lines: [
				...extra,
				{
					lookupKey: tierKey("sparkle-2", "month"),
					amount: 1500 * quantity,
					interval: "month",
					quantity,
					periodStart: CYCLE_END,
					periodEnd: NEXT_END,
				},
			],
			metadata,
		}),
		CYCLE_END + DAY,
	);

const updated = (
	quantity: number,
	at: number,
	eventId = `evt_sub_${quantity}`,
) =>
	subscriptionEvent({
		type: "customer.subscription.updated",
		eventId,
		subscriptionId: "sub_q",
		status: "active",
		items: [
			{ lookupKey: tierKey("sparkle-2", "month"), interval: "month", quantity },
		],
		periodStart: CREATED,
		periodEnd: CYCLE_END,
		at,
		metadata,
	});

const refund = (s: Store, invoiceId: string, amount: number, at: number) =>
	s.handle(
		chargeRefunded({
			eventId: `evt_re_${invoiceId}`,
			chargeId: `ch_${invoiceId}`,
			invoiceId,
			amount,
			chargeAmount: amount,
			at,
		}),
		at,
	);

/** The tier's customer product as the engine stores it. */
const tierProduct = (s: Store) =>
	s.rows.find((r) => r.table === "customerProducts" && r.id === "cp_tier")
		?.data as { quantity: number } | undefined;

const grantedUnits = (s: Store, invoiceId: string) =>
	grantsOf(s).invoices[invoiceId]?.granted.map((g) => g.units);

describe("create and renewal at a quantity", () => {
	test("a create at quantity 2 grants twice the unit amount", () => {
		const s = newStore();
		expect(create(s, { quantity: 2 }).refused).toBeUndefined();
		expect(s.avail(CREATED + SECOND)).toBe(4);
		expect(grantsOf(s).quantity).toBe(2);
		expect(grantedUnits(s, "in_create")).toEqual([4]);
		expect(tierProduct(s)?.quantity).toBe(2);
	});

	test("a create at quantity 1 is as before", () => {
		const s = newStore();
		create(s, { quantity: 1 });
		expect(s.avail(CREATED + SECOND)).toBe(2);
		expect(grantsOf(s).quantity).toBe(1);
		expect(grantedUnits(s, "in_create")).toEqual([2]);
		expect(tierProduct(s)?.quantity).toBe(1);
	});

	test("a renewal at quantity 2 refills twice the unit amount", () => {
		const s = newStore();
		create(s, { quantity: 2 });
		s.spend(4, CREATED + DAY);
		expect(renewal(s, { quantity: 2 }).refused).toBeUndefined();
		expect(s.avail(CYCLE_END + DAY)).toBe(4);
		expect(grantedUnits(s, "in_cycle_2")).toEqual([4]);
		expect(grantsOf(s).quantity).toBe(2);
	});

	test("the rollover cap scales with the quantity: a member of 4 keeps up to 4 x the unit max", () => {
		const one = newStore();
		create(one, { quantity: 1 });
		renewal(one, { quantity: 1 });
		// 2 fresh, 2 unused carried over (the unit max is 2)
		expect(one.avail(CYCLE_END + DAY)).toBe(4);

		const four = newStore();
		create(four, { quantity: 4 });
		renewal(four, { quantity: 4 });
		// 8 fresh, 8 unused carried over: the cap is 2 x 4
		expect(four.avail(CYCLE_END + DAY)).toBe(16);
		const third = NEXT_END + (NEXT_END - CYCLE_END);
		four.handle(
			invoicePaid({
				eventId: "evt_cycle_3",
				invoiceId: "in_cycle_3",
				at: NEXT_END + HOUR,
				subscriptionId: "sub_q",
				reason: "subscription_cycle",
				periodStart: CYCLE_END,
				periodEnd: NEXT_END,
				lines: [
					{
						lookupKey: tierKey("sparkle-2", "month"),
						amount: 6000,
						interval: "month",
						quantity: 4,
						periodStart: NEXT_END,
						periodEnd: third,
					},
				],
				metadata,
			}),
			NEXT_END + HOUR,
		);
		// 16 unused, 8 fresh: the cap keeps 8 of the leftovers
		expect(four.avail(NEXT_END + HOUR)).toBe(16);
	});

	test("a full refund of a yearly payment at quantity 2 takes back 12 x 2 per unit amount", () => {
		const s = newStore();
		const yearEnd = CREATED + 365 * DAY;
		create(s, { quantity: 2, interval: "year", end: yearEnd });
		// 2 visits a month a unit, a year of them, 2 units
		expect(grantedUnits(s, "in_create")).toEqual([2 * 12 * 2]);
		expect(s.avail(CREATED + SECOND)).toBe(48);
		expect(refund(s, "in_create", 3000, CREATED + DAY).refused).toBeUndefined();
		expect(s.avail(CREATED + DAY + SECOND)).toBe(0);
	});
});

describe("a raise mid-cycle (2 -> 4, always_invoice)", () => {
	// Twenty of the cycle's thirty days are left: (4 - 2) x 2 visits x 20/30 = 2.67, rounded up.
	const RAISE_UNITS = 3;

	test("grants the prorated difference of the units, and the credits now reflect 4", () => {
		const s = newStore();
		create(s, { quantity: 2 });
		const r = s.handle(raiseEvent(), RAISED);
		expect(r.refused).toBeUndefined();
		expect(s.avail(RAISED + SECOND)).toBe(4 + RAISE_UNITS);
		const state = grantsOf(s);
		expect(state.quantity).toBe(4);
		expect(state.cycleStart).toBe(CREATED);
		expect(state.cycleEnd).toBe(CYCLE_END);
		expect(grantedUnits(s, "in_raise")).toEqual([RAISE_UNITS]);
		expect(tierProduct(s)?.quantity).toBe(4);
	});

	test("the subscription event alone grants nothing; either order of event and invoice ends the same", () => {
		const eventFirst = newStore();
		create(eventFirst, { quantity: 2 });
		const sub = eventFirst.handle(updated(4, RAISED), RAISED);
		expect(sub.events).toEqual([]);
		expect(sub.rowChanges?.upserts.map((u) => u.table)).toEqual([GRANTS_TABLE]);
		expect(eventFirst.avail(RAISED + SECOND)).toBe(4);
		expect(grantsOf(eventFirst).quantity).toBe(2);
		expect(grantsOf(eventFirst).membership?.quantity).toBe(4);
		eventFirst.handle(raiseEvent(), RAISED);

		const invoiceFirst = newStore();
		create(invoiceFirst, { quantity: 2 });
		invoiceFirst.handle(raiseEvent(), RAISED);
		invoiceFirst.handle(updated(4, RAISED), RAISED);

		for (const s of [eventFirst, invoiceFirst]) {
			expect(s.avail(RAISED + SECOND)).toBe(4 + RAISE_UNITS);
			expect(grantsOf(s).quantity).toBe(4);
			expect(grantsOf(s).membership?.quantity).toBe(4);
		}
		expect(grantsOf(eventFirst)).toEqual(grantsOf(invoiceFirst));
		const engineRows = (s: Store) =>
			s.rows.filter((r) => r.table !== GRANTS_TABLE).map((r) => r.data);
		expect(engineRows(eventFirst)).toEqual(engineRows(invoiceFirst));
	});

	test("a replayed raise invoice grants nothing twice", () => {
		const s = newStore();
		create(s, { quantity: 2 });
		s.handle(raiseEvent(), RAISED);
		const again = s.handle(raiseEvent(), RAISED + HOUR);
		expect(again).toEqual({ rowChanges: null, events: [] });
		expect(s.avail(RAISED + HOUR)).toBe(4 + RAISE_UNITS);
	});

	test("a full refund of the raise invoice takes back only the raise", () => {
		const s = newStore();
		create(s, { quantity: 2 });
		s.handle(raiseEvent(), RAISED);
		expect(refund(s, "in_raise", 2000, RAISED + HOUR).refused).toBeUndefined();
		expect(s.avail(RAISED + HOUR + SECOND)).toBe(4);
		expect(grantsOf(s).invoices.in_create?.removed).toBe(false);
	});

	test("without the credit line the old quantity is the one the credits reflect", () => {
		const s = newStore();
		create(s, { quantity: 2 });
		const [, charge] = raiseLines();
		s.handle(raiseEvent([charge as EventLine]), RAISED);
		expect(grantedUnits(s, "in_raise")).toEqual([RAISE_UNITS]);
	});

	test("a charge line at no more units than before grants nothing", () => {
		const s = newStore();
		create(s, { quantity: 4 });
		s.handle(raiseEvent(raiseLines({ from: 4, to: 2 })), RAISED);
		expect(grantedUnits(s, "in_raise")).toEqual([]);
		expect(grantsOf(s).quantity).toBe(4);
		expect(s.avail(RAISED + SECOND)).toBe(8);
	});
});

describe("a raise under another upgrade policy", () => {
	const line = (over: Partial<InvoiceLine>): InvoiceLine => ({
		kind: "tier",
		tierId: "sparkle-2",
		interval: "month",
		quantity: 1,
		proration: true,
		amount: 0,
		periodStart: RAISED,
		periodEnd: CYCLE_END,
		...over,
	});
	const raise: BillingInvoice = {
		source: {
			eventId: "evt_raise",
			mapping: "stripe.invoice.paid.v1",
			stripeApiVersion: "2025-10-29.clover",
		},
		id: "in_raise",
		customerId: "cus_q",
		subscriptionId: "sub_q",
		reason: "subscription_update",
		currency: "usd",
		amountPaid: 2000,
		paidAt: RAISED,
		periodStart: CREATED,
		periodEnd: RAISED,
		lines: [
			line({ quantity: 2, amount: -2000 }),
			line({ quantity: 4, amount: 4000 }),
		],
		metadata,
	};
	const after = (policy: BillingPolicy) => {
		const s = newStore();
		create(s, { quantity: 2 });
		return invoiceToCommands({
			invoice: raise,
			menu,
			policy,
			state: grantsOf(s),
			now: RAISED,
			menuVersion: 1,
			policyVersion: 1,
		});
	};
	const added = (r: ReturnType<typeof invoiceToCommands>) =>
		r.commands
			.filter((c) => c.type === "updateBalance")
			.map((c) => c.addToBalance);

	test("'full' grants the whole difference of the units", () => {
		const r = after({ ...DEFAULT_POLICY, upgradeGrant: "full" });
		// The product's quantity is updated whatever the policy grants: the next renewal refills at the new count.
		expect(JSON.stringify(r.commands)).toMatch(
			/"table":"customerProducts"[^}]*"quantity":4|"quantity":4[^}]*"table":"customerProducts"/,
		);
		expect(added(r)).toEqual([4]);
		expect(r.state.invoices.in_raise?.granted.map((g) => g.units)).toEqual([4]);
		expect(r.state.quantity).toBe(4);
	});

	test("'none' grants nothing, and the next renewal refills at 4", () => {
		const r = after({ ...DEFAULT_POLICY, upgradeGrant: "none" });
		// The product's quantity is updated whatever the policy grants: the next renewal refills at the new count.
		expect(JSON.stringify(r.commands)).toMatch(
			/"table":"customerProducts"[^}]*"quantity":4|"quantity":4[^}]*"table":"customerProducts"/,
		);
		expect(added(r)).toEqual([]);
		expect(r.state.invoices.in_raise?.granted).toEqual([]);
		expect(r.state.quantity).toBe(4);
	});
});

describe("a decrease (4 -> 2)", () => {
	test("grants nothing now, keeps the sessions, and the renewal at 2 refills twice the unit amount", () => {
		const s = newStore();
		create(s, { quantity: 4 });
		s.spend(2, CREATED + DAY);
		const sub = s.handle(updated(2, LOWERED), LOWERED);
		expect(sub.events).toEqual([]);
		expect(s.avail(LOWERED + SECOND)).toBe(6);
		expect(grantsOf(s).quantity).toBe(4);
		expect(grantsOf(s).membership?.quantity).toBe(2);

		expect(renewal(s, { quantity: 2 }).refused).toBeUndefined();
		expect(grantedUnits(s, "in_cycle_2")).toEqual([4]);
		expect(grantsOf(s).quantity).toBe(2);
		expect(tierProduct(s)?.quantity).toBe(2);
		// 4 fresh; of the 6 unused, the cap at the new quantity (2 x 2) carries 4
		expect(s.avail(CYCLE_END + DAY)).toBe(8);
	});

	test("with create_prorations the renewal's proration lines grant nothing", () => {
		const s = newStore();
		create(s, { quantity: 4 });
		s.spend(8, CREATED + DAY);
		const prorations: EventLine[] = [
			{
				lookupKey: tierKey("sparkle-2", "month"),
				amount: -3400,
				interval: "month",
				quantity: 4,
				proration: true,
				periodStart: LOWERED,
				periodEnd: CYCLE_END,
			},
			{
				lookupKey: tierKey("sparkle-2", "month"),
				amount: 1700,
				interval: "month",
				quantity: 2,
				proration: true,
				periodStart: LOWERED,
				periodEnd: CYCLE_END,
			},
		];
		const r = renewal(s, { quantity: 2, extra: prorations });
		expect(r.refused).toBeUndefined();
		expect(grantedUnits(s, "in_cycle_2")).toEqual([4]);
		expect(s.avail(CYCLE_END + DAY)).toBe(4);
		const state = grantsOf(s);
		expect(state.quantity).toBe(2);
		expect(state.cycleStart).toBe(CYCLE_END);
		expect(state.cycleEnd).toBe(NEXT_END);
	});
});

describe("the membership's quantity", () => {
	test("a subscription event that changes only the quantity is a change of the membership, and grants nothing", () => {
		const s = newStore();
		create(s, { quantity: 2 });
		s.handle(updated(2, CREATED + HOUR, "evt_sub_a"), CREATED + HOUR);
		expect(grantsOf(s).membership?.quantity).toBe(2);
		const same = s.handle(
			updated(2, CREATED + HOUR, "evt_sub_b"),
			CREATED + HOUR,
		);
		expect(same.rowChanges).toBeNull();
		const r = s.handle(updated(4, CREATED + 2 * HOUR), CREATED + 2 * HOUR);
		expect(r.events).toEqual([]);
		expect(r.rowChanges?.upserts.map((u) => u.table)).toEqual([GRANTS_TABLE]);
		const state = grantsOf(s);
		expect(state.membership?.quantity).toBe(4);
		expect(state.quantity).toBe(2);
		expect(s.avail(CREATED + 2 * HOUR)).toBe(4);
	});
});

describe("a tier change and a quantity change in one update", () => {
	test("grants new amount x new quantity less old amount x old quantity, prorated", () => {
		const s = newStore();
		create(s, { quantity: 1 });
		const r = s.handle(
			raiseEvent(
				raiseLines({
					from: 1,
					to: 2,
					fromTier: "sparkle-2",
					toTier: "sparkle-4",
				}),
			),
			RAISED,
		);
		expect(r.refused).toBeUndefined();
		// visits: 4 x 2 - 2 x 1 = 6, x 20/30 = 4; the yearly retreat is a new row of 1 x 2
		expect(s.avail(RAISED + SECOND)).toBe(2 + 4);
		expect(s.avail(RAISED + SECOND, "retreat")).toBe(2);
		const state = grantsOf(s);
		expect(state.tierId).toBe("sparkle-4");
		expect(state.quantity).toBe(2);
		expect(tierProduct(s)?.quantity).toBe(2);
	});
});

describe("a state stored before quantities", () => {
	test("loads with quantity 1, and its membership with quantity 1", () => {
		const s = newStore();
		create(s, { quantity: 1 });
		s.handle(updated(1, CREATED + HOUR), CREATED + HOUR);
		const {
			quantity: _quantity,
			membership,
			...legacy
		} = grantsOf(s) as GrantsState;
		const { quantity: _membershipQuantity, ...legacyMembership } =
			membership ?? {};
		const loaded = grantsFromRows([
			{
				table: GRANTS_TABLE,
				id: GRANTS_ROW_ID,
				data: {
					...legacy,
					membership: legacyMembership,
				} as unknown as RowData,
			},
		]);
		expect(loaded.quantity).toBe(1);
		expect(loaded.membership?.quantity).toBe(1);
		expect(loaded).toEqual(grantsOf(s));
	});
});

describe("a line that pays for no units", () => {
	test("a tier line at quantity 0 grants nothing, is not coerced to one unit, and is not refused", () => {
		const s = newStore();
		const result = create(s, { quantity: 0 });
		expect(result.refused).toBeUndefined();
		expect(result.events).toEqual([]);
		expect(grantsOf(s).quantity).toBe(1);
	});

	test("a cycle invoice whose tier line dropped to 0 changes no credits and keeps the quantity credits reflect", () => {
		const s = newStore();
		create(s, { quantity: 2 });
		const before = grantsOf(s).quantity;
		const result = s.handle(
			invoicePaid({
				eventId: "evt_cycle_zero",
				invoiceId: "in_cycle_zero",
				at: CYCLE_END,
				subscriptionId: "sub_q",
				reason: "subscription_cycle",
				periodStart: CREATED,
				periodEnd: CYCLE_END,
				lines: [
					{
						lookupKey: tierKey("sparkle-2", "month"),
						amount: 0,
						interval: "month",
						quantity: 0,
						periodStart: CYCLE_END,
						periodEnd: NEXT_END,
					},
				],
				metadata,
			}),
			CYCLE_END,
		);
		expect(result.refused).toBeUndefined();
		expect(grantsOf(s).quantity).toBe(before);
	});
});

describe("invoices that carry more than the raise", () => {
	const STALE = RAISED - 5 * DAY;
	const glowKey = lookupKeyOf(
		SCHOOL,
		addonPriceKey("glow", "month"),
		5000,
		menu.currency,
	);
	const glowLine: EventLine = {
		lookupKey: glowKey,
		amount: 5000,
		interval: "month",
		quantity: 1,
		proration: true,
		periodStart: RAISED,
		periodEnd: CYCLE_END,
	};
	/** An older decrease (4 -> 2, create_prorations) still pending: the pair rides on whatever invoice comes next. */
	const stalePair = (): EventLine[] => [
		{
			lookupKey: tierKey("sparkle-2", "month"),
			amount: -3400,
			interval: "month",
			quantity: 4,
			proration: true,
			periodStart: STALE,
			periodEnd: CYCLE_END,
		},
		{
			lookupKey: tierKey("sparkle-2", "month"),
			amount: 1700,
			interval: "month",
			quantity: 2,
			proration: true,
			periodStart: STALE,
			periodEnd: CYCLE_END,
		},
	];

	test("a raise and an add-on bought in one update both grant", () => {
		const s = newStore();
		create(s, { quantity: 2 });
		s.handle(raiseEvent([...raiseLines(), glowLine]), RAISED);
		expect(grantsOf(s).quantity).toBe(4);
		expect(grantsOf(s).addonIds).toContain("glow");
	});

	test("an add-on bought while an older decrease pair is pending grants the add-on and reads no raise", () => {
		const s = newStore();
		create(s, { quantity: 4 });
		s.handle(raiseEvent([...stalePair(), glowLine]), RAISED);
		expect(grantsOf(s).addonIds).toContain("glow");
		expect(grantsOf(s).quantity).toBe(4);
	});

	test("a raise next to a stale pair grants the same as the raise alone, whichever pair comes first", () => {
		const alone = newStore();
		create(alone, { quantity: 2 });
		alone.handle(raiseEvent(raiseLines({ from: 2, to: 3 })), RAISED);
		const expected = grantedUnits(alone, "in_raise");
		expect(expected?.length).toBeGreaterThan(0);

		for (const order of ["stale first", "raise first"]) {
			const s = newStore();
			create(s, { quantity: 2 });
			const lines =
				order === "stale first"
					? [...stalePair(), ...raiseLines({ from: 2, to: 3 })]
					: [...raiseLines({ from: 2, to: 3 }), ...stalePair()];
			s.handle(raiseEvent(lines), RAISED);
			expect(grantedUnits(s, "in_raise")).toEqual(expected);
			expect(grantsOf(s).quantity).toBe(3);
		}
	});

	test("the credit line, not the stored quantity, says how many units the member had", () => {
		// The credits reflect 4 (stored), but Stripe's credit line says the member had 2 and now has 3.
		const s = newStore();
		create(s, { quantity: 4 });
		s.handle(raiseEvent(raiseLines({ from: 2, to: 3 })), RAISED);
		expect(grantedUnits(s, "in_raise")?.length).toBeGreaterThan(0);
	});
});

describe("a membership stored before quantities", () => {
	test("replaying its subscription event changes nothing, whatever the order of keys in the stored row", () => {
		const membership = {
			subscriptionId: "sub_q",
			status: "active",
			tierId: "sparkle-2",
			interval: "month",
			renewsAt: CYCLE_END,
			cancelAtPeriodEnd: false,
			endsAt: null,
			at: CREATED + HOUR,
			quantity: 1,
		};
		const state = {
			...EMPTY_GRANTS_STATE,
			subscriptionId: "sub_q",
			tierId: "sparkle-2",
			interval: "month",
			membership,
		} as GrantsState;
		const result = subscriptionToCommands({
			subscription: {
				source: { eventId: "evt", mapping: "m", stripeApiVersion: "v" },
				id: "sub_q",
				customerId: "cus_q",
				status: "active",
				items: [
					{
						priceId: "price_q",
						lookupKey: tierKey("sparkle-2", "month"),
						interval: "month",
						quantity: 1,
					},
				],
				currentPeriodStart: CREATED,
				currentPeriodEnd: CYCLE_END,
				cancelAtPeriodEnd: false,
				at: CREATED + HOUR,
				metadata: {},
			},
			plan: { tierId: "sparkle-2", interval: "month", quantity: 1 },
			menu,
			policy: DEFAULT_POLICY,
			state,
			subject: null,
			now: CREATED + HOUR,
			menuVersion: 1,
			policyVersion: 1,
		});
		expect(result.state).toBe(state);
	});
});
