/**
 * The books' lines for a booking's one-time payment (a payment-mode Checkout Session made by `bookingCheckoutParams`, no
 * invoice): `payment.succeeded` to `income:billing:booking` and `payment.refunded`, made by the real `handleStripeEvent`
 * from the recorded booking files (`fixtures/billing/stripe/recorded/booking`, sandbox objects: a paid session for 3000
 * cents, a full refund of 3000 and a partial refund of 1000 of another 3000), then the outbox, the folder shipper, the
 * journal, hledger, and `reconcile` against a Stripe side written by hand.
 *
 * The amounts are worked out in the tests from three numbers: PRICE 3000 (what a session collects), FEE 117 (what Stripe
 * kept, 3.9 percent of 3000 rounded down, so a net of 2883) and PART 1000 (the partial refund).
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	applyRowChanges,
	type BillingRow,
	grantsFromRows,
	grantsRow,
} from "../src/billing/rows.js";
import type { Menu } from "../src/billing/types.js";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { journalMonth } from "../src/ledger/files.js";
import { deterministicUlid } from "../src/ledger/ids.js";
import { appendToOutbox } from "../src/ledger/outbox.js";
import { reconcile } from "../src/ledger/reconcile.js";
import { readStripeDirectory } from "../src/ledger/reconcile-files.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { canonicalize } from "../src/ledger/util.js";
import { validateEvent } from "../src/ledger/validate.js";
import { FolderStore } from "../src/store/folder-store.js";
import type {
	AtmEvent,
	ReconcileDifference,
	ReconcileStripe,
	StripeEventResult,
} from "../src/types.js";
import { hasHledger, tmp } from "./helpers.js";

const SCHOOL = "sch_demo";
const NOW = Date.parse("2026-11-05T12:00:00Z");
const SHIPPED_AT = 1_700_000_000_000;
const PRICE = 3000;
const FEE = 117;
const PART = 1000;

const bookingDir = `${import.meta.dir}/../fixtures/billing/stripe/recorded/booking`;
// biome-ignore lint/suspicious/noExplicitAny: recorded Stripe JSON is read and edited by path, untyped
const load = (name: string): any =>
	JSON.parse(readFileSync(`${bookingDir}/${name}`, "utf8"));

const menu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
const catalog = menuCatalogRows({ menu, school: SCHOOL });

const completed = load("checkout.session.completed.json");
const second = load("checkout.session.completed.second.json");
const fullRefund = load("charge.refunded.full.json");
const partialRefund = load("charge.refunded.partial.json");

const intentOne = completed.data.object.payment_intent as string;
const intentTwo = second.data.object.payment_intent as string;
const chargeOne = fullRefund.data.object.id as string;
const chargeTwo = partialRefund.data.object.id as string;

const inputEventId = (stripeEventId: string) =>
	deterministicUlid({
		timeMs: NOW,
		revision: 0,
		seed: canonicalize([SCHOOL, stripeEventId]),
	});

/** The family service in miniature: the stored rows and revision, one write per event, and the events it was handed. */
const world = () => {
	let rows: BillingRow[] = [];
	let revision = 0;
	const events: AtmEvent[] = [];
	const api = {
		get rows() {
			return rows;
		},
		get grants() {
			return grantsFromRows(rows);
		},
		events,
		/** `fee` is what the caller read from Stripe's balance transaction for the payment. */
		handle(event: { id: string }, fee?: number): StripeEventResult {
			const result = handleStripeEvent({
				event,
				eventId: inputEventId(event.id),
				menu,
				menuVersion: 3,
				policy: DEFAULT_POLICY,
				policyVersion: 1,
				rows,
				revision,
				catalog,
				now: NOW,
				...(fee === undefined ? {} : { fee }),
			});
			if (result.rowChanges)
				({ rows, revision } = applyRowChanges({
					rows,
					revision,
					changes: result.rowChanges,
				}));
			events.push(...result.events);
			return result;
		},
		/** An older record: the state as it was stored before the books took a booking's payment (no `booked`). */
		forgetBooked: (bookingId: string) => {
			const grants = grantsFromRows(rows);
			const record = grants.bookings?.[bookingId];
			if (!record?.payment) throw new Error(`${bookingId} has no payment`);
			const { booked: _booked, ...payment } = record.payment;
			const older = {
				...grants,
				bookings: { ...grants.bookings, [bookingId]: { ...record, payment } },
			};
			rows = rows.map((row) =>
				row.table === grantsRow(older).table ? grantsRow(older) : row,
			);
		},
	};
	return api;
};

const NOTHING = { rowChanges: null, events: [] };
const ofType = (events: readonly AtmEvent[], type: string) =>
	events.filter((event) => event.event_type === type);

/** The event of a type in a result that made exactly one. */
const only = (result: StripeEventResult, type: string): AtmEvent => {
	const found = ofType(result.events, type);
	expect(found).toHaveLength(1);
	return found[0] as AtmEvent;
};

describe("a paid booking books its payment", () => {
	test("with no fee: gross to assets:stripe and income:billing:booking, idem by the payment intent, the booking in the labels", () => {
		const result = world().handle(completed);
		expect(result.refused).toBeUndefined();
		expect(result.events.map((event) => event.event_type)).toEqual([
			"payment.succeeded",
		]);
		const payment = only(result, "payment.succeeded");
		expect(payment.idem).toBe(`stripe:${intentOne}`);
		expect(payment.key).toBe("family:fam_demo1");
		expect(payment.school).toBe(SCHOOL);
		expect(payment.labels).toMatchObject({
			booking: "bk_trig1",
			mapping: "stripe/checkout.session.completed@v1",
		});
		expect(payment.postings).toEqual([
			{ account: "assets:stripe", amount: "30.00", commodity: "USD" },
			{
				account: "income:billing:booking",
				amount: "-30.00",
				commodity: "USD",
			},
		]);
		expect(payment.payload).toEqual({
			id: intentOne,
			amount_paid: PRICE,
			fee: 0,
			fee_known: false,
			currency: "usd",
			customer: "family:fam_demo1",
			booking: "bk_trig1",
			session: completed.data.object.id,
			payment_intent: intentOne,
		});
		expect(validateEvent(payment).errors).toEqual([]);
	});

	test("with a fee: the fee leaves the cash and is an expense, the income stays the gross", () => {
		const result = world().handle(completed, FEE);
		const payment = only(result, "payment.succeeded");
		// 30.00 collected, 1.17 kept by Stripe, 28.83 reaches the balance
		expect(payment.postings).toEqual([
			{ account: "assets:stripe", amount: "28.83", commodity: "USD" },
			{
				account: "expenses:billing:stripe-fees",
				amount: "1.17",
				commodity: "USD",
			},
			{
				account: "income:billing:booking",
				amount: "-30.00",
				commodity: "USD",
			},
		]);
		expect(payment.payload).toMatchObject({ fee: FEE, fee_known: true });
		expect(validateEvent(payment).errors).toEqual([]);
	});

	test("a fee that is not whole cents from 0 to the amount is refused with nothing written", () => {
		for (const fee of [1.5, -1, PRICE + 1]) {
			const s = world();
			const result = s.handle(completed, fee);
			expect([fee, result.refused?.reason]).toEqual([fee, "bad_event"]);
			expect(result.refused?.message).toContain(
				`the ${PRICE} the booking paid`,
			);
			expect(result.rowChanges).toBeNull();
			expect(result.events).toEqual([]);
			expect(s.rows).toEqual([]);
		}
	});

	test("the record says the books took the payment", () => {
		const s = world();
		s.handle(completed);
		expect(s.grants.bookings?.bk_trig1?.payment?.booked).toBe(true);
	});

	test("a replay books nothing again, and the same payment under a new event id has the same idem", () => {
		const s = world();
		s.handle(completed);
		expect(s.handle(completed)).toEqual(NOTHING);
		// the async event of the same session (a delayed method) finds the record
		const later = structuredClone(completed);
		later.id = "evt_unverified_async_succeeded";
		later.type = "checkout.session.async_payment_succeeded";
		expect(s.handle(later)).toEqual(NOTHING);
		expect(ofType(s.events, "payment.succeeded")).toHaveLength(1);
		// a caller that lost its rows and decides it again makes the same line, which the outbox's (school, idem) key drops
		const again = world().handle(completed);
		expect(only(again, "payment.succeeded").idem).toBe(s.events[0]?.idem);
	});

	test("a session that is not a booking's, and one still unpaid, book nothing", () => {
		const unpaid = structuredClone(completed);
		unpaid.data.object.payment_status = "unpaid";
		expect(world().handle(unpaid)).toEqual(NOTHING);
		const bare = structuredClone(completed);
		bare.data.object.metadata = { b4u_school: SCHOOL, family_id: "fam_demo1" };
		expect(world().handle(bare)).toEqual(NOTHING);
	});

	test("in another currency: a money.skipped marker of kind booking and no payment line, and the record is not marked", () => {
		const s = world();
		const euro = structuredClone(completed);
		euro.data.object.currency = "eur";
		const result = s.handle(euro);
		expect(result.events.map((event) => event.event_type)).toEqual([
			"money.skipped",
		]);
		const [marker] = result.events;
		expect(marker?.payload).toEqual({
			id: intentOne,
			kind: "booking",
			reason: "non_usd",
			currency: "eur",
			amount: PRICE,
		});
		expect(marker?.idem).toBe(`stripe:${intentOne}:non_usd`);
		expect(marker?.postings).toEqual([]);
		expect(s.grants.bookings?.bk_trig1?.state).toBe("paid");
		expect(s.grants.bookings?.bk_trig1?.payment?.booked).toBeUndefined();
		expect(validateEvent(marker as AtmEvent).errors).toEqual([]);

		// its refund leaves a refund marker and no payment.refunded: there is no payment for it to take back from
		const refund = structuredClone(fullRefund);
		refund.data.object.currency = "eur";
		const refunded = s.handle(refund);
		expect(refunded.events.map((event) => event.event_type)).toEqual([
			"money.skipped",
		]);
		expect(refunded.events[0]?.payload).toMatchObject({
			kind: "refund",
			currency: "eur",
			amount: PRICE,
		});
		expect(refunded.booking?.action).toBe("refunded");
	});
});

describe("a refund of a booking's payment", () => {
	test("a full refund books payment.refunded for the charge's amount, with what ties it to Stripe's refund", () => {
		const s = world();
		s.handle(completed, FEE);
		const result = s.handle(fullRefund);
		expect(result.booking?.action).toBe("refunded");
		const refund = only(result, "payment.refunded");
		expect(refund.idem).toBe(`stripe:${fullRefund.id}`);
		expect(refund.labels).toMatchObject({ booking: "bk_trig1" });
		expect(refund.postings).toEqual([
			{ account: "assets:stripe", amount: "-30.00", commodity: "USD" },
			{ account: "income:billing:refunds", amount: "30.00", commodity: "USD" },
		]);
		expect(refund.payload).toEqual({
			id: fullRefund.id,
			amount: PRICE,
			currency: "usd",
			charge: chargeOne,
			payment_intent: intentOne,
			booking: "bk_trig1",
			amount_refunded: PRICE,
		});
		expect(validateEvent(refund).errors).toEqual([]);
	});

	test("a partial refund books what it refunded and then a full one books the rest: 1000, then 2000 of 3000", () => {
		const s = world();
		s.handle(second);
		const first = s.handle(partialRefund);
		expect(first.booking?.action).toBe("partly_refunded");
		expect(only(first, "payment.refunded").payload).toMatchObject({
			amount: PART,
			amount_refunded: PART,
		});
		const rest = structuredClone(partialRefund);
		rest.id = "evt_rest";
		rest.data.object.amount_refunded = PRICE;
		rest.data.object.refunded = true;
		rest.data.previous_attributes = { amount_refunded: PART };
		const last = s.handle(rest);
		expect(last.booking?.action).toBe("refunded");
		expect(only(last, "payment.refunded").payload).toMatchObject({
			amount: PRICE - PART,
			amount_refunded: PRICE,
		});
		const booked = ofType(s.events, "payment.refunded")
			.map((event) => event.payload.amount as number)
			.reduce((total, amount) => total + amount, 0);
		expect(booked).toBe(PRICE);
	});

	test("each event books its own amount whatever the order: the later event first (2000), then the older one (1000)", () => {
		const s = world();
		s.handle(second);
		const rest = structuredClone(partialRefund);
		rest.id = "evt_rest";
		rest.data.object.amount_refunded = PRICE;
		rest.data.object.refunded = true;
		rest.data.previous_attributes = { amount_refunded: PART };
		expect(only(s.handle(rest), "payment.refunded").payload.amount).toBe(
			PRICE - PART,
		);
		const late = s.handle(partialRefund);
		expect(late.rowChanges).toBeNull();
		expect(only(late, "payment.refunded").payload.amount).toBe(PART);
		const booked = ofType(s.events, "payment.refunded").map(
			(event) => event.payload.amount as number,
		);
		expect(booked).toEqual([PRICE - PART, PART]);
	});

	test("the redelivery of a refund decides nothing and makes the same line, which the outbox keeps once", () => {
		const s = world();
		s.handle(completed);
		const first = s.handle(fullRefund);
		const again = s.handle(fullRefund);
		expect(again.rowChanges).toBeNull();
		expect(again.booking).toBeUndefined();
		expect(again.events).toEqual(first.events);
	});

	test("a refund of a payment the books never took books nothing, though the booking outcome is decided", () => {
		const s = world();
		s.handle(completed);
		s.forgetBooked("bk_trig1");
		const result = s.handle(fullRefund);
		expect(result.booking?.action).toBe("refunded");
		expect(result.events).toEqual([]);
		expect(ofType(s.events, "payment.refunded")).toEqual([]);
	});

	test("an older stored record has no booked mark: the record without it is still a valid one", () => {
		const s = world();
		s.handle(completed);
		s.forgetBooked("bk_trig1");
		expect(s.grants.bookings?.bk_trig1?.payment).not.toHaveProperty("booked");
		expect(s.grants.bookings?.bk_trig1?.state).toBe("paid");
	});
});

/** Both bookings, paid with a fee, one refunded in full and one in part: the log of every test below. */
const scenario = () => {
	const s = world();
	s.handle(completed, FEE);
	s.handle(second, FEE);
	s.handle(fullRefund);
	s.handle(partialRefund);
	return s;
};

describe("the shipped log, the journal and hledger", () => {
	/** The cents in a `"account","12.34 USD"` CSV row, 0 when hledger left the account out (a zero balance). */
	const cents = (csv: string, account: string): bigint => {
		const row = csv
			.split("\n")
			.find((line) => line.startsWith(`"${account}",`));
		if (!row) return 0n;
		const [, amount] = [...row.matchAll(/"([^"]*)"/g)].map((m) => m[1]) as [
			string,
			string,
		];
		return BigInt(amount.replace(/[ ,]USD$/, "").replace(/[.,]/g, ""));
	};

	test("the events go through the outbox once, however often they are appended", async () => {
		const db = bunSqlite(new Database(":memory:"));
		db.exec(HANDLER_DDL);
		const { events } = scenario();
		expect(events).toHaveLength(4);
		expect(appendToOutbox(db, events, "live")).toBe(4);
		expect(appendToOutbox(db, events, "live")).toBe(0);
	});

	test.skipIf(!hasHledger)(
		"two payments with a fee, a full and a partial refund: income, refunds, fees and the cash hold hand-worked totals",
		async () => {
			const db = bunSqlite(new Database(":memory:"));
			db.exec(HANDLER_DDL);
			appendToOutbox(db, scenario().events, "live");
			const root = await tmp("booking-money");
			try {
				const shipped = await shipOutbox({
					db,
					store: new FolderStore({ root }),
					school: SCHOOL,
					nowMs: () => SHIPPED_AT,
				});
				expect(shipped.conflicts).toEqual([]);
				expect(shipped.shipped).toBe(4);
				await journalMonth({ root, school: SCHOOL, month: "2026-11" });
				const books = join(root, "schools", SCHOOL);
				const hledger = (args: string[]): string => {
					const run = Bun.spawnSync(
						["hledger", "-f", "main.journal", ...args],
						{ cwd: books, stdout: "pipe", stderr: "pipe" },
					);
					expect(run.stderr.toString()).toBe("");
					expect(run.exitCode).toBe(0);
					return run.stdout.toString();
				};
				hledger(["check", "balanced", "accounts", "commodities"]);

				// income: two sessions of 3000. refunds: 3000 + 1000. fees: 2 x 117.
				const statement = hledger(["is", "-O", "csv"]);
				expect(cents(statement, "income:billing:booking")).toBe(
					BigInt(2 * PRICE),
				);
				expect(cents(statement, "income:billing:refunds")).toBe(
					BigInt(-(PRICE + PART)),
				);
				expect(cents(statement, "expenses:billing:stripe-fees")).toBe(
					BigInt(2 * FEE),
				);
				const netIncome = 2 * PRICE - (PRICE + PART) - 2 * FEE;
				expect(netIncome).toBe(1766);
				expect(cents(statement, "Net:")).toBe(BigInt(netIncome));

				// Stripe's balance: 2 x (3000 - 117) came in and 4000 went back
				const sheet = hledger(["bs", "-O", "csv"]);
				expect(cents(sheet, "assets:stripe")).toBe(BigInt(netIncome));
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});

describe("reconcile pairs a booking's payment by payment intent and its refund by payment intent and amount", () => {
	const PERIOD = { month: "2026-11" };

	/** What Stripe lists for the scenario, written from its documented shapes: the intents, the refunds and the balance. */
	const stripeSide = (): ReconcileStripe => {
		const paidAt = completed.data.object.created as number;
		const intent = (id: string, created: number, amount = PRICE) => ({
			id,
			status: "succeeded",
			amount,
			currency: "usd",
			created,
			livemode: false,
			metadata: { booking_id: "bk" },
		});
		const refundRecord = (
			id: string,
			amount: number,
			charge: string,
			intentId: string,
			created: number,
		) => ({
			id,
			amount,
			currency: "usd",
			charge,
			payment_intent: intentId,
			created,
			status: "succeeded",
		});
		const refundedAt = fullRefund.created as number;
		const charge = (id: string, created: number) => ({
			id,
			amount: PRICE,
			fee: FEE,
			net: PRICE - FEE,
			currency: "usd",
			created,
			type: "charge",
		});
		const back = (id: string, amount: number, created: number) => ({
			id,
			amount: -amount,
			fee: 0,
			net: -amount,
			currency: "usd",
			created,
			type: "refund",
		});
		return {
			invoices: [],
			paymentIntents: [
				intent(intentOne, paidAt),
				intent(intentTwo, second.data.object.created as number),
				// an intent that paid an invoice names no booking: not this check's
				{
					id: "pi_for_an_invoice",
					status: "succeeded",
					amount: 26_000,
					currency: "usd",
					created: paidAt,
					livemode: false,
					metadata: {},
				},
			],
			refunds: [
				refundRecord("re_whole", PRICE, chargeOne, intentOne, refundedAt),
				refundRecord(
					"re_part",
					PART,
					chargeTwo,
					intentTwo,
					partialRefund.created as number,
				),
			],
			disputes: [],
			payouts: [],
			balanceTransactions: [
				charge("txn_one", paidAt),
				charge("txn_two", second.data.object.created as number),
				back("txn_back_one", PRICE, refundedAt),
				back("txn_back_two", PART, partialRefund.created as number),
			],
		};
	};

	const run = (
		events: readonly AtmEvent[],
		stripe: ReconcileStripe,
		mode: "live" | "test" = "test",
	) =>
		reconcile({
			events,
			stripe,
			period: PERIOD,
			mode,
			timeZone: menu.timeZone,
		});
	const ofObject = (differences: ReconcileDifference[], object: string) =>
		differences.filter((difference) => difference.object === object);

	test("a log and a Stripe side that agree have no difference, and the intent of an invoice is ignored", () => {
		const result = run(scenario().events, stripeSide());
		expect(result.differences).toEqual([]);
		expect(result.notSupplied).toEqual([]);
		expect(result.counts.payment).toEqual({ stripe: 2, log: 2 });
		expect(result.counts.invoice).toEqual({ stripe: 0, log: 0 });
		expect(result.counts.refund).toEqual({ stripe: 2, log: 2 });
		expect(result.ignored).toEqual({ payment_intent_not_booking: 1 });
	});

	test("a payment Stripe has and the log lacks is missing_in_log", () => {
		const events = scenario().events.filter(
			(event) =>
				!(
					event.event_type === "payment.succeeded" &&
					event.idem === `stripe:${intentTwo}`
				),
		);
		const differences = ofObject(
			run(events, stripeSide()).differences,
			"payment",
		);
		expect(differences.map((d) => [d.kind, d.id])).toEqual([
			["missing_in_log", intentTwo],
		]);
		expect(differences[0]?.stripe).toMatchObject({
			amount: PRICE,
			currency: "usd",
		});
	});

	test("a payment the log has and Stripe lacks is missing_in_stripe", () => {
		const stripe = stripeSide();
		stripe.paymentIntents = stripe.paymentIntents?.filter(
			(intent) => intent.id !== intentOne,
		);
		const differences = ofObject(
			run(scenario().events, stripe).differences,
			"payment",
		);
		expect(differences.map((d) => [d.kind, d.id])).toEqual([
			["missing_in_stripe", intentOne],
		]);
	});

	test("an amount that differs is amount_differs, with both sides' amounts", () => {
		const stripe = stripeSide();
		stripe.paymentIntents = stripe.paymentIntents?.map((intent) =>
			intent.id === intentOne ? { ...intent, amount: PRICE + 100 } : intent,
		);
		const differences = ofObject(
			run(scenario().events, stripe).differences,
			"payment",
		);
		expect(differences).toHaveLength(1);
		expect(differences[0]).toMatchObject({
			kind: "amount_differs",
			id: intentOne,
			stripe: { amount: PRICE + 100 },
			log: { amount: PRICE },
		});
	});

	test("a refund the log lacks is missing_in_log, and a payment intent that did not succeed is ignored", () => {
		const events = scenario().events.filter(
			(event) => event.idem !== `stripe:${partialRefund.id}`,
		);
		const stripe = stripeSide();
		stripe.paymentIntents = [
			...(stripe.paymentIntents ?? []),
			{
				id: "pi_never_paid",
				status: "canceled",
				amount: PRICE,
				currency: "usd",
				created: completed.data.object.created,
				livemode: false,
				metadata: { booking_id: "bk_none" },
			},
		];
		const result = run(events, stripe);
		expect(ofObject(result.differences, "refund").map((d) => d.kind)).toEqual([
			"missing_in_log",
		]);
		expect(result.ignored).toMatchObject({ payment_intent_not_succeeded: 1 });
		expect(ofObject(result.differences, "payment")).toEqual([]);
	});

	test("a log with a booking's payment and no payment intents is notSupplied; a log with none needs no list", () => {
		const { paymentIntents: _left, ...without } = stripeSide();
		const result = run(scenario().events, without);
		expect(result.notSupplied).toEqual(["paymentIntents"]);
		// the booking's payments are not read as invoices missing from Stripe
		expect(ofObject(result.differences, "invoice")).toEqual([]);
		expect(result.counts.payment).toEqual({ stripe: null, log: 2 });

		const plain = run([], { ...without, refunds: [], balanceTransactions: [] });
		expect(plain.notSupplied).toEqual([]);
		expect(plain.counts).not.toHaveProperty("payment");
	});

	test("a test-mode intent is ignored by a live run", () => {
		const result = run(scenario().events, stripeSide(), "live");
		expect(result.ignored).toMatchObject({ test_mode_object: 3 });
		expect(result.counts.payment?.stripe).toBe(0);
	});

	test("payment_intents.json is read like the other lists, and a record without an amount is refused", async () => {
		const folder = await tmp("booking-money-stripe");
		try {
			const list = stripeSide().paymentIntents;
			await writeFile(
				join(folder, "payment_intents.json"),
				JSON.stringify({ object: "list", data: list, has_more: false }),
			);
			expect((await readStripeDirectory(folder)).paymentIntents).toHaveLength(
				3,
			);
			await writeFile(
				join(folder, "payment_intents.json"),
				JSON.stringify([{ id: "pi_x", created: 1 }]),
			);
			await expect(readStripeDirectory(folder)).rejects.toThrow(
				"payment_intents.json record 0 needs a string id and numeric amount, created",
			);
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	});
});
