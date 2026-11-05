/**
 * The money lines `handleStripeEvent` makes: a paid invoice is a `payment.succeeded` (gross, Stripe's fee, the net in
 * `assets:stripe`), a refund a `payment.refunded` and a payout a `payout.paid`. Pure: the fee is the caller's input.
 * `tests/handler-money.test.ts` drives the real handler to the same numbers and to hledger's reports.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	lookupKeyOf,
	menuLineItems,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { buildJournal } from "../src/ledger/journal.js";
import { replayEvents } from "../src/ledger/replay.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent } from "../src/types.js";
import { createStore } from "./billing-store.js";
import { hasHledger, tmp } from "./helpers.js";
import {
	chargeRefunded,
	invoicePaid,
	payoutPaid,
	priceIdOf,
} from "./stripe-events.js";

const SCHOOL = "sch_vol";
const FAMILY = "fam_8k2";
const T0 = Date.parse("2026-01-15T18:00:00Z");
const T1 = Date.parse("2026-02-15T18:00:00Z");
const HOUR = 3_600_000;
const GROSS = 26_000;
const FEE = 784;
const menu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
const metadata = { b4u_school: SCHOOL, family_id: FAMILY };

const tierKey = () => {
	const price = menu.tiers
		.find((t) => t.id === "sparkle-2")
		?.prices.find((p) => p.interval === "month");
	return lookupKeyOf(
		SCHOOL,
		tierPriceKey("sparkle-2", "month"),
		price?.amount as number,
		menu.currency,
	);
};

const paid = (invoiceId = "in_1", amountPaid = GROSS) =>
	invoicePaid({
		eventId: `evt_${invoiceId}`,
		invoiceId,
		at: T0,
		subscriptionId: "sub_1",
		reason: "subscription_create",
		periodStart: T0,
		periodEnd: T1,
		lines: [{ lookupKey: tierKey(), amount: GROSS, interval: "month" }],
		metadata,
		amountPaid,
	});

const refundOf = (id: string, amount: number, refundedTotal: number) =>
	chargeRefunded({
		eventId: `evt_re_${id}`,
		chargeId: "ch_in_1",
		invoiceId: "in_1",
		amount,
		chargeAmount: GROSS,
		refundedTotal,
		at: T0 + HOUR,
	});

const money = (events: readonly AtmEvent[], type: string): AtmEvent[] =>
	events.filter((e) => e.event_type === type);

/** The posting amounts of an event, by account. */
const amounts = (e: AtmEvent): Record<string, string> =>
	Object.fromEntries(e.postings.map((p) => [p.account, p.amount]));

/** hledger over the journals of `events`; `args` is one hledger command, and its stdout comes back. */
const hledgerOver = async (events: AtmEvent[], args: string[]) => {
	const root = await tmp("billing-money");
	try {
		const build = buildJournal({ events, month: "2026-01" });
		for (const [path, text] of Object.entries(build.files)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), text);
		}
		const run = Bun.spawnSync(["hledger", "-f", "main.journal", ...args], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
		return run.stdout.toString();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};

const newStore = () => createStore({ menu, school: SCHOOL, family: FAMILY });

describe("a paid invoice", () => {
	test("books the gross, takes the fee out as an expense and the net into assets:stripe", () => {
		const store = newStore();
		const result = store.handle(paid(), T0, { fee: FEE });
		expect(result.refused).toBeUndefined();
		const [payment] = money(result.events, "payment.succeeded");
		expect(payment).toBeDefined();
		expect(amounts(payment as AtmEvent)).toEqual({
			"assets:stripe": "252.16",
			"expenses:billing:stripe-fees": "7.84",
			"income:billing:membership:sparkle-2": "-260.00",
		});
		expect(payment?.payload).toMatchObject({
			id: "in_1",
			amount_paid: GROSS,
			fee: FEE,
			fee_known: true,
		});
		expect(payment?.idem).toBe("stripe:in_1");
		expect(payment?.key).toBe(`family:${FAMILY}`);
		expect(payment?.event_time).toBe("2026-01-15T18:00:00Z");
		expect(validateEvent(payment as AtmEvent).errors).toEqual([]);
	});

	test("without a fee it books the gross and no fee line, and the event says the fee was not known", () => {
		const store = newStore();
		const [payment] = money(
			store.handle(paid(), T0).events,
			"payment.succeeded",
		);
		expect(amounts(payment as AtmEvent)).toEqual({
			"assets:stripe": "260.00",
			"income:billing:membership:sparkle-2": "-260.00",
		});
		expect(payment?.payload).toMatchObject({ fee: 0, fee_known: false });
		// a fee that is known to be nothing is another thing: no fee line, but a fee that was given
		const free = newStore();
		const [known] = money(
			free.handle(paid(), T0, { fee: 0 }).events,
			"payment.succeeded",
		);
		expect(Object.keys(amounts(known as AtmEvent))).not.toContain(
			"expenses:billing:stripe-fees",
		);
		expect(known?.payload).toMatchObject({ fee: 0, fee_known: true });
	});

	test("a fee that is not a whole number of cents up to what was paid is refused and nothing is written", () => {
		for (const fee of [-1, 1.5, GROSS + 1, Number.NaN]) {
			const result = newStore().handle(paid(), T0, { fee });
			expect([fee, result.refused?.reason]).toEqual([fee, "bad_event"]);
			expect(result.refused?.message).toContain("fee must be a whole number");
			expect(result.rowChanges).toBeNull();
			expect(result.events).toEqual([]);
		}
	});

	test("the same invoice handled again makes no second payment", () => {
		const store = newStore();
		store.handle(paid(), T0, { fee: FEE });
		const again = store.handle(paid(), T0, { fee: FEE });
		expect(again).toEqual({ rowChanges: null, events: [] });
		expect(money(store.events, "payment.succeeded")).toHaveLength(1);
	});

	test("an invoice that paid nothing, or paid in another currency, makes no money line", () => {
		const nothing = newStore().handle(paid("in_free", 0), T0);
		expect(nothing.refused).toBeUndefined();
		expect(money(nothing.events, "payment.succeeded")).toEqual([]);
		const euros = paid("in_eur");
		euros.data.object.currency = "eur";
		const result = newStore().handle(euros, T0);
		expect(result.refused).toBeUndefined();
		expect(money(result.events, "payment.succeeded")).toEqual([]);
	});
});

describe("a refund", () => {
	test("books what this event refunded: two partial refunds are their own amounts, not the running total", () => {
		const store = newStore();
		store.handle(paid(), T0, { fee: FEE });
		const first = store.handle(refundOf("a", 5000, 5000), T0 + HOUR);
		const second = store.handle(refundOf("b", 3000, 8000), T0 + 2 * HOUR);
		const refunds = [first, second].map((r) =>
			money(r.events, "payment.refunded").map(amounts),
		);
		expect(refunds).toEqual([
			[{ "assets:stripe": "-50.00", "income:billing:refunds": "50.00" }],
			[{ "assets:stripe": "-30.00", "income:billing:refunds": "30.00" }],
		]);
		expect(money(first.events, "payment.refunded")[0]?.payload).toMatchObject({
			id: "evt_re_a",
			amount: 5000,
		});
	});

	test("the same refund handled again says the same line, which the outbox's idem drops", () => {
		const store = newStore();
		store.handle(paid(), T0, { fee: FEE });
		const first = store.handle(refundOf("a", 5000, 5000), T0 + HOUR);
		const again = store.handle(refundOf("a", 5000, 5000), T0 + HOUR);
		expect(again.rowChanges).toBeNull();
		expect(again.events).toEqual(money(first.events, "payment.refunded"));
		expect(money(store.events, "payment.refunded")).toHaveLength(1);
	});

	test("a charge that names no handled invoice is not the school's money: no line", () => {
		const store = newStore();
		store.handle(paid(), T0, { fee: FEE });
		const stranger = chargeRefunded({
			eventId: "evt_re_x",
			chargeId: "ch_other",
			invoiceId: null,
			amount: 100,
			chargeAmount: GROSS,
			at: T0 + HOUR,
		});
		expect(store.handle(stranger, T0 + HOUR)).toEqual({
			rowChanges: null,
			events: [],
		});
	});

	test.skipIf(!hasHledger)(
		"a refund after a fee-bearing payment still balances, and the cash is gross less fee less refunds",
		async () => {
			const store = newStore();
			store.handle(paid(), T0, { fee: FEE });
			store.handle(refundOf("a", 5000, 5000), T0 + HOUR);
			store.handle(refundOf("b", 3000, 8000), T0 + 2 * HOUR);
			const check = await hledgerOver(store.events, [
				"check",
				"balanced",
				"accounts",
				"commodities",
			]);
			expect(check).toBe("");
			// 260.00 - 7.84 - 50.00 - 30.00
			const cash = await hledgerOver(store.events, [
				"bal",
				"assets:stripe",
				"-N",
				"--no-total",
				"-O",
				"csv",
			]);
			expect(cash).toContain('"assets:stripe","172.16 USD"');
		},
	);
});

describe("a payout", () => {
	const payout = (over: Partial<Parameters<typeof payoutPaid>[0]> = {}) =>
		payoutPaid({
			eventId: "evt_po_1",
			payoutId: "po_1",
			amount: 20_216,
			at: T0 + 48 * HOUR,
			...over,
		});
	const input = (event: unknown, school: string | null = SCHOOL) => ({
		event,
		eventId: "01KF6B43S000000A6T73VEVRVS",
		menu,
		menuVersion: 3,
		policy: DEFAULT_POLICY,
		policyVersion: 1,
		rows: [],
		revision: 0,
		catalog: menuCatalogRows({ menu, school: SCHOOL }),
		now: T0,
		priceIds: Object.fromEntries(
			[...menuLineItems(SCHOOL, menu).keys()].map((key) => [
				key,
				priceIdOf(key),
			]),
		),
		...(school === null ? {} : { school }),
	});

	test("moves the cash from assets:stripe to the payout clearing account, and writes no rows", () => {
		const result = handleStripeEvent(input(payout()));
		expect(result.refused).toBeUndefined();
		expect(result.rowChanges).toBeNull();
		const [event] = result.events;
		expect(event?.event_type).toBe("payout.paid");
		expect(amounts(event as AtmEvent)).toEqual({
			"assets:stripe": "-202.16",
			"assets:clearing:stripe-payouts": "202.16",
		});
		expect(event?.idem).toBe("stripe:po_1");
		expect(event?.school).toBe(SCHOOL);
		expect(event?.payload).toEqual({
			id: "po_1",
			amount: 20_216,
			currency: "usd",
		});
		expect(validateEvent(event as AtmEvent).errors).toEqual([]);
	});

	test("the same input gives the same event, and another delivery of the same payout the same idem", () => {
		const first = handleStripeEvent(input(payout()));
		expect(handleStripeEvent(input(payout()))).toEqual(first);
		const redelivered = handleStripeEvent(
			input(payout({ eventId: "evt_po_1_again" })),
		);
		expect(redelivered.events[0]?.idem).toBe(first.events[0]?.idem);
		expect(redelivered.events[0]?.id).toBe(first.events[0]?.id);
	});

	test("names no family, so it needs the school, and a payout in another currency makes no line", () => {
		const result = handleStripeEvent(input(payout(), null));
		expect(result.refused?.reason).toBe("bad_event");
		expect(result.events).toEqual([]);
		expect(handleStripeEvent(input(payout({ currency: "eur" })))).toEqual({
			rowChanges: null,
			events: [],
		});
	});

	test("a payout of nothing is not an event atm reads", () => {
		const result = handleStripeEvent(input(payout({ amount: 0 })));
		expect(result.refused?.reason).toBe("bad_event");
	});
});

describe("a log with fees, refunds and payouts", () => {
	test("replays: money lines are not engine commands, and the credits come out as without them", () => {
		const store = newStore();
		store.handle(paid(), T0, { fee: FEE });
		store.handle(refundOf("a", 5000, 5000), T0 + HOUR);
		const payout = handleStripeEvent({
			event: payoutPaid({
				eventId: "evt_po_1",
				payoutId: "po_1",
				amount: 20_216,
				at: T0 + 48 * HOUR,
			}),
			eventId: "01KF6B43S000000A6T73VEVRVS",
			menu,
			menuVersion: 1,
			policy: DEFAULT_POLICY,
			policyVersion: 1,
			rows: [],
			revision: 0,
			catalog: menuCatalogRows({ menu, school: SCHOOL }),
			now: T0,
			school: SCHOOL,
		});
		const events = [...store.events, ...payout.events];
		expect(events.map((e) => e.event_type)).toEqual(
			expect.arrayContaining([
				"payment.succeeded",
				"payment.refunded",
				"payout.paid",
			]),
		);
		const catalog = menuCatalogRows({ menu, school: SCHOOL });
		const whole = replayEvents({ events, catalog });
		const creditsOnly = replayEvents({
			events: events.filter((e) => !/^(payment|payout)\./.test(e.event_type)),
			catalog,
		});
		expect(whole.snapshot.states).toEqual(creditsOnly.snapshot.states);
		expect(whole.balances).toEqual(creditsOnly.balances);
		expect(whole.applied).toBe(events.length);
	});
});
