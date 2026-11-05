/**
 * B4 Uni's revenue share through the real `handleStripeEvent`: a `share.accrued` right after each `payment.succeeded` (an
 * invoice's and a paid booking's) and a `share.reversed` after each `payment.refunded`, from the rate the school's policy
 * has, with the share kept on the payment's record so that a rate that changes later leaves what was accrued as it was.
 *
 * The numbers are worked out in the tests. An invoice of 26000 cents at 3.33 percent owes 865.8, which rounds to 866;
 * refunded 5000 it gives back 866 x 5000 / 26000 = 166.5 -> 167, at 15000 in all 499.6 -> 500, and all of it 866, so the
 * three refunds reverse 167, 333 and 366.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import type { BillingPolicy } from "../src/billing/types.js";
import { canonicalize } from "../src/ledger/util.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent } from "../src/types.js";
import {
	HOUR,
	invoiceRefund,
	membershipInvoice,
	ofType,
	PRICE,
	SCHOOL,
	T0,
	T1,
	typesOf,
	withShare,
	world,
} from "./revenue-share-world.js";

const RATE = 3.33;
const SHARE = 866;
const NOTHING = { rowChanges: null, events: [] };

const only = (events: readonly AtmEvent[], type: string): AtmEvent => {
	const found = ofType(events, type);
	expect(found).toHaveLength(1);
	return found[0] as AtmEvent;
};

describe("an invoice's payment accrues the share", () => {
	test("share.accrued follows payment.succeeded, with the rate, the base and the share in its payload and the opposite signs of the cost", () => {
		const s = world({ policy: withShare(RATE) });
		const result = s.handle(membershipInvoice(), { fee: 784 });
		expect(result.refused).toBeUndefined();
		const money = result.events.filter((event) =>
			event.event_type.match(/^(payment|share)\./),
		);
		expect(typesOf(money)).toEqual(["payment.succeeded", "share.accrued"]);
		const payment = only(result.events, "payment.succeeded");
		const share = only(result.events, "share.accrued");
		expect(share.idem).toBe("stripe:in_1:share");
		expect(share.postings).toEqual([
			{
				account: "expenses:billing:b4uni-share",
				amount: "8.66",
				commodity: "USD",
			},
			{ account: "liabilities:b4uni", amount: "-8.66", commodity: "USD" },
		]);
		// on the gross: Stripe's fee of 784 is not taken off first
		expect(share.payload).toEqual({
			payment_id: "in_1",
			kind: "invoice",
			collected: PRICE,
			percent: RATE,
			share: SHARE,
		});
		expect(share.school).toBe(SCHOOL);
		expect(share.key).toBe(payment.key);
		expect(share.event_time).toBe(payment.event_time);
		expect(share.date).toBe(payment.date);
		expect(share.cause).toBe(payment.cause);
		expect(share.labels).toEqual(payment.labels);
		expect(share.source).toBe("family");
		expect(validateEvent(share).errors).toEqual([]);
		expect(s.grants.invoices.in_1?.share).toEqual({
			accrued: SHARE,
			reversed: 0,
		});
		expect(s.grants.invoices.in_1?.paid).toBe(PRICE);
	});

	test("a discount lowers the share: it is taken on what the customer paid, not on the list price", () => {
		const s = world({ policy: withShare(RATE) });
		// 15 percent off: 22100 paid. 22100 x 3.33 / 100 = 735.93 -> 736
		const result = s.handle(membershipInvoice({ amountPaid: 22_100 }));
		const share = only(result.events, "share.accrued");
		expect(share.payload).toMatchObject({ collected: 22_100, share: 736 });
		expect(share.postings[0]?.amount).toBe("7.36");
		expect(s.grants.invoices.in_1?.share).toEqual({
			accrued: 736,
			reversed: 0,
		});
	});

	test("an invoice that collected nothing (100 percent off) makes no payment and no share", () => {
		const s = world({ policy: withShare(RATE) });
		const result = s.handle(membershipInvoice({ amountPaid: 0 }));
		expect(ofType(result.events, "payment.succeeded")).toEqual([]);
		expect(ofType(result.events, "share.accrued")).toEqual([]);
		expect(s.grants.invoices.in_1?.share).toBeUndefined();
		expect(s.grants.invoices.in_1?.paid).toBeUndefined();
	});

	test("a share that rounds to nothing is no event and no record: 0.01 percent of 4000 cents is 0.4 cents", () => {
		const s = world({ policy: withShare(0.01) });
		const result = s.handle(membershipInvoice({ amountPaid: 4000 }));
		expect(ofType(result.events, "payment.succeeded")).toHaveLength(1);
		expect(ofType(result.events, "share.accrued")).toEqual([]);
		expect(s.grants.invoices.in_1?.share).toBeUndefined();
		// and 0.01 percent of 26000 is 2.6 cents: 3
		const wider = world({ policy: withShare(0.01) });
		expect(
			only(wider.handle(membershipInvoice()).events, "share.accrued").payload
				.share,
		).toBe(3);
	});

	test("a payment in another currency makes the marker and no share", () => {
		const s = world({ policy: withShare(RATE) });
		const result = s.handle(membershipInvoice({ currency: "eur" }));
		expect(ofType(result.events, "money.skipped")).toHaveLength(1);
		expect(ofType(result.events, "share.accrued")).toEqual([]);
		expect(s.grants.invoices.in_1?.share).toBeUndefined();
		// its refund reverses nothing either
		const refunded = s.handle(
			invoiceRefund({
				eventId: "evt_re_eur",
				refundedTotal: 5000,
				currency: "eur",
			}),
		);
		expect(ofType(refunded.events, "share.reversed")).toEqual([]);
	});

	test("a replay decides nothing, and the payment decided again from lost rows makes the same share event", () => {
		const s = world({ policy: withShare(RATE) });
		s.handle(membershipInvoice());
		expect(s.handle(membershipInvoice())).toEqual(NOTHING);
		expect(ofType(s.events, "share.accrued")).toHaveLength(1);
		const again = world({ policy: withShare(RATE) });
		const [firstShare] = ofType(s.events, "share.accrued");
		const [secondShare] = ofType(
			again.handle(membershipInvoice()).events,
			"share.accrued",
		);
		// the same (school, idem) and the same id: the outbox keeps one
		expect(secondShare).toEqual(firstShare as AtmEvent);
	});

	test("the share is on the invoice, not the subscription: a renewal accrues its own, under its own invoice id", () => {
		const s = world({ policy: withShare(RATE) });
		s.handle(membershipInvoice({ invoiceId: "in_1", at: T0 }));
		s.handle(
			membershipInvoice({
				invoiceId: "in_2",
				at: T1,
				reason: "subscription_cycle",
			}),
			{ at: T1 },
		);
		expect(
			ofType(s.events, "share.accrued").map((event) => event.idem),
		).toEqual(["stripe:in_1:share", "stripe:in_2:share"]);
	});
});

describe("a refund reverses its part of the share", () => {
	/** An invoice paid under the rate, then refunds by running total. */
	const paidInvoice = (policy: BillingPolicy = withShare(RATE)) => {
		const s = world({ policy });
		s.handle(membershipInvoice());
		return s;
	};

	test("partial, partial, then the rest: 167, 333 and 366, which add up to the share of 866", () => {
		const s = paidInvoice();
		const first = s.handle(
			invoiceRefund({ eventId: "evt_re_a", refundedTotal: 5000 }),
		);
		expect(typesOf(first.events)).toEqual([
			"payment.refunded",
			"share.reversed",
		]);
		const reversal = only(first.events, "share.reversed");
		expect(reversal.idem).toBe("stripe:evt_re_a:share-reversed:5000");
		expect(reversal.payload).toEqual({
			payment_id: "in_1",
			refunded_total: 5000,
			share_before: 866,
			share_after: 699,
			reversed: 167,
		});
		expect(reversal.postings).toEqual([
			{
				account: "expenses:billing:b4uni-share",
				amount: "-1.67",
				commodity: "USD",
			},
			{ account: "liabilities:b4uni", amount: "1.67", commodity: "USD" },
		]);
		expect(validateEvent(reversal).errors).toEqual([]);
		expect(s.grants.invoices.in_1?.share).toEqual({
			accrued: 866,
			reversed: 167,
		});

		const second = s.handle(
			invoiceRefund({
				eventId: "evt_re_b",
				refundedTotal: 15_000,
				previousTotal: 5000,
				at: T0 + 2 * HOUR,
			}),
		);
		expect(only(second.events, "share.reversed").payload).toMatchObject({
			refunded_total: 15_000,
			share_before: 699,
			share_after: 366,
			reversed: 333,
		});

		const last = s.handle(
			invoiceRefund({
				eventId: "evt_re_c",
				refundedTotal: PRICE,
				previousTotal: 15_000,
				at: T0 + 3 * HOUR,
			}),
		);
		expect(only(last.events, "share.reversed").payload).toMatchObject({
			share_before: 366,
			share_after: 0,
			reversed: 366,
		});
		const reversed = ofType(s.events, "share.reversed").map(
			(event) => event.payload.reversed as number,
		);
		expect(reversed).toEqual([167, 333, 366]);
		expect(reversed.reduce((sum, cents) => sum + cents, 0)).toBe(866);
		expect(s.grants.invoices.in_1?.share).toEqual({
			accrued: 866,
			reversed: 866,
		});
		// the full refund took the credits back, and the record kept the share it reversed
		expect(s.grants.invoices.in_1?.removed).toBe(true);
	});

	test("a full refund at once reverses the whole share", () => {
		const s = paidInvoice();
		const result = s.handle(
			invoiceRefund({ eventId: "evt_re_full", refundedTotal: PRICE }),
		);
		expect(only(result.events, "share.reversed").payload).toMatchObject({
			share_before: 866,
			share_after: 0,
			reversed: 866,
		});
	});

	test("the redelivery of a refund reverses nothing more, and the same refund under a new event id none either", () => {
		const s = paidInvoice();
		s.handle(invoiceRefund({ eventId: "evt_re_a", refundedTotal: 5000 }));
		const again = s.handle(
			invoiceRefund({ eventId: "evt_re_a", refundedTotal: 5000 }),
		);
		expect(ofType(again.events, "share.reversed")).toEqual([]);
		const resent = s.handle(
			invoiceRefund({ eventId: "evt_re_a2", refundedTotal: 5000 }),
		);
		expect(ofType(resent.events, "share.reversed")).toEqual([]);
		expect(ofType(s.events, "share.reversed")).toHaveLength(1);
	});

	test("a refund decided again from lost rows makes the same reversal event, which the outbox keeps once", () => {
		const one = paidInvoice();
		const first = one.handle(
			invoiceRefund({ eventId: "evt_re_a", refundedTotal: 5000 }),
		);
		const two = paidInvoice();
		const second = two.handle(
			invoiceRefund({ eventId: "evt_re_a", refundedTotal: 5000 }),
		);
		expect(only(second.events, "share.reversed")).toEqual(
			only(first.events, "share.reversed"),
		);
	});

	test("the later total first: the older refund then reverses nothing, and the books end at the same share", () => {
		const s = paidInvoice();
		const later = s.handle(
			invoiceRefund({
				eventId: "evt_re_b",
				refundedTotal: 15_000,
				previousTotal: 5000,
				at: T0 + 2 * HOUR,
			}),
		);
		expect(only(later.events, "share.reversed").payload).toMatchObject({
			reversed: 500,
		});
		const older = s.handle(
			invoiceRefund({ eventId: "evt_re_a", refundedTotal: 5000 }),
		);
		expect(ofType(older.events, "share.reversed")).toEqual([]);
		expect(s.grants.invoices.in_1?.share).toEqual({
			accrued: 866,
			reversed: 500,
		});
	});

	test("a payment booked before the school had a rate accrues nothing, and its refund reverses nothing", () => {
		const s = world();
		s.handle(membershipInvoice());
		expect(ofType(s.events, "share.accrued")).toEqual([]);
		s.setPolicy(withShare(RATE));
		const refunded = s.handle(
			invoiceRefund({ eventId: "evt_re_a", refundedTotal: 5000 }),
		);
		expect(typesOf(refunded.events)).toEqual(["payment.refunded"]);
		expect(s.grants.invoices.in_1?.share).toBeUndefined();
		// the next payment, under the rate, accrues and its own refund reverses
		s.handle(
			membershipInvoice({
				invoiceId: "in_2",
				at: T1,
				reason: "subscription_cycle",
			}),
			{ at: T1 },
		);
		expect(ofType(s.events, "share.accrued")).toHaveLength(1);
		const second = s.handle(
			invoiceRefund({
				eventId: "evt_re_2",
				invoiceId: "in_2",
				refundedTotal: PRICE,
				at: T1 + HOUR,
			}),
			{ at: T1 + HOUR },
		);
		expect(only(second.events, "share.reversed").payload).toMatchObject({
			payment_id: "in_2",
			reversed: 866,
		});
	});

	test("a rate that changes between the payment and the refund changes nothing: the accrued share is reversed, at any rate or none", () => {
		for (const later of [withShare(10), withShare(0.01), DEFAULT_POLICY]) {
			const s = paidInvoice(withShare(RATE));
			s.setPolicy(later);
			const result = s.handle(
				invoiceRefund({ eventId: "evt_re_a", refundedTotal: 5000 }),
			);
			expect(only(result.events, "share.reversed").payload).toMatchObject({
				share_before: 866,
				share_after: 699,
				reversed: 167,
			});
		}
	});

	test("a refund larger than the payment is clamped: the reversal never exceeds the share accrued", () => {
		const s = paidInvoice();
		const result = s.handle(
			invoiceRefund({
				eventId: "evt_re_big",
				refundedTotal: PRICE + 1000,
				chargeAmount: PRICE + 1000,
			}),
		);
		expect(only(result.events, "share.reversed").payload).toMatchObject({
			share_before: 866,
			share_after: 0,
			reversed: 866,
		});
	});
});

describe("no rate, no share", () => {
	/** A scenario that exercises every money line: two payments, partial and full refunds. */
	const scenario = (policy: BillingPolicy) => {
		const s = world({ policy });
		s.handle(membershipInvoice(), { fee: 784 });
		s.handle(invoiceRefund({ eventId: "evt_re_a", refundedTotal: 5000 }));
		s.handle(
			invoiceRefund({
				eventId: "evt_re_b",
				refundedTotal: PRICE,
				previousTotal: 5000,
				at: T0 + 2 * HOUR,
			}),
		);
		s.handle(
			membershipInvoice({
				invoiceId: "in_2",
				at: T1,
				reason: "subscription_cycle",
			}),
			{ at: T1 },
		);
		return s;
	};

	test("a policy with no rate, a null rate, a rate of 0 or no field at all gives the same events and the same rows, byte for byte", () => {
		const { revenueShare: _dropped, ...stored } = DEFAULT_POLICY;
		const policies: BillingPolicy[] = [
			DEFAULT_POLICY,
			{ ...DEFAULT_POLICY, revenueShare: { percent: 0 } },
			stored as unknown as BillingPolicy,
		];
		const [base, ...others] = policies.map(scenario);
		expect(typesOf((base as ReturnType<typeof scenario>).events)).not.toContain(
			"share.accrued",
		);
		expect(typesOf((base as ReturnType<typeof scenario>).events)).not.toContain(
			"share.reversed",
		);
		for (const other of others) {
			expect(canonicalize(other.events)).toBe(
				canonicalize((base as ReturnType<typeof scenario>).events),
			);
			expect(canonicalize(other.rows)).toBe(
				canonicalize((base as ReturnType<typeof scenario>).rows),
			);
		}
		// no record of a share anywhere in the stored state
		expect(
			JSON.stringify((base as ReturnType<typeof scenario>).rows),
		).not.toContain('"share"');
	});

	test("with a rate the same scenario has the same payment lines, and the share events besides", () => {
		const without = scenario(DEFAULT_POLICY);
		const withRate = scenario(withShare(RATE));
		// the credit events are not compared: a share on the record is a write of the grants row, which moves the revision they carry
		const money = (events: readonly AtmEvent[]) =>
			events.filter((event) => event.event_type.startsWith("payment."));
		expect(canonicalize(money(withRate.events))).toBe(
			canonicalize(money(without.events)),
		);
		expect(
			typesOf(withRate.events).filter((t) => t.startsWith("share.")),
		).toEqual([
			"share.accrued",
			"share.reversed",
			"share.reversed",
			"share.accrued",
		]);
	});
});

describe("a paid booking's payment", () => {
	const dir = `${import.meta.dir}/../fixtures/billing/stripe/recorded/booking`;
	// biome-ignore lint/suspicious/noExplicitAny: recorded Stripe JSON is read and edited by path, untyped
	const load = (name: string): any =>
		JSON.parse(readFileSync(`${dir}/${name}.json`, "utf8"));
	const completed = load("checkout.session.completed");
	const second = load("checkout.session.completed.second");
	const fullRefund = load("charge.refunded.full");
	const partialRefund = load("charge.refunded.partial");
	const intentOne = completed.data.object.payment_intent as string;
	const intentTwo = second.data.object.payment_intent as string;
	const BOOKING_SCHOOL = "sch_demo";
	// 3000 cents at 2.5 percent: 75
	const BOOKING_RATE = 2.5;

	test("accrues its share on the amount the session collected, keyed by its payment intent", () => {
		const s = world({
			school: BOOKING_SCHOOL,
			policy: withShare(BOOKING_RATE),
		});
		const result = s.handle(completed, { fee: 117 });
		expect(typesOf(result.events)).toEqual([
			"payment.succeeded",
			"share.accrued",
		]);
		const share = only(result.events, "share.accrued");
		expect(share.idem).toBe(`stripe:${intentOne}:share`);
		expect(share.payload).toEqual({
			payment_id: intentOne,
			kind: "booking",
			collected: 3000,
			percent: BOOKING_RATE,
			share: 75,
		});
		expect(share.labels).toMatchObject({ booking: "bk_trig1" });
		expect(share.postings[0]).toEqual({
			account: "expenses:billing:b4uni-share",
			amount: "0.75",
			commodity: "USD",
		});
		expect(validateEvent(share).errors).toEqual([]);
		expect(s.grants.bookings?.bk_trig1?.payment?.share).toEqual({
			accrued: 75,
			reversed: 0,
		});
	});

	test("a replay of the session decides nothing", () => {
		const s = world({
			school: BOOKING_SCHOOL,
			policy: withShare(BOOKING_RATE),
		});
		s.handle(completed);
		expect(s.handle(completed)).toEqual(NOTHING);
		expect(ofType(s.events, "share.accrued")).toHaveLength(1);
	});

	test("a full refund reverses all of it", () => {
		const s = world({
			school: BOOKING_SCHOOL,
			policy: withShare(BOOKING_RATE),
		});
		s.handle(completed);
		const result = s.handle(fullRefund);
		expect(typesOf(result.events)).toEqual([
			"payment.refunded",
			"share.reversed",
		]);
		const reversal = only(result.events, "share.reversed");
		expect(reversal.idem).toBe(`stripe:${fullRefund.id}:share-reversed:3000`);
		expect(reversal.payload).toEqual({
			payment_id: intentOne,
			refunded_total: 3000,
			share_before: 75,
			share_after: 0,
			reversed: 75,
		});
		expect(validateEvent(reversal).errors).toEqual([]);
		// the redelivery reverses nothing more
		expect(s.handle(fullRefund)).toEqual(NOTHING);
	});

	test("a partial refund then the rest: 1000 of 3000 reverses 25, and the rest the other 50", () => {
		const s = world({
			school: BOOKING_SCHOOL,
			policy: withShare(BOOKING_RATE),
		});
		s.handle(second);
		const first = s.handle(partialRefund);
		expect(only(first.events, "share.reversed").payload).toMatchObject({
			payment_id: intentTwo,
			refunded_total: 1000,
			share_before: 75,
			share_after: 50,
			reversed: 25,
		});
		const rest = structuredClone(partialRefund);
		rest.id = "evt_rest";
		rest.data.object.amount_refunded = 3000;
		rest.data.object.refunded = true;
		rest.data.previous_attributes = { amount_refunded: 1000 };
		const last = s.handle(rest);
		expect(only(last.events, "share.reversed").payload).toMatchObject({
			share_before: 50,
			share_after: 0,
			reversed: 50,
		});
		expect(s.grants.bookings?.bk_trig2?.payment?.share).toEqual({
			accrued: 75,
			reversed: 75,
		});
	});

	test("a booking paid before the school had a rate accrues nothing and its refund reverses nothing", () => {
		const s = world({ school: BOOKING_SCHOOL });
		s.handle(completed);
		s.setPolicy(withShare(BOOKING_RATE));
		const result = s.handle(fullRefund);
		expect(typesOf(result.events)).toEqual(["payment.refunded"]);
		expect(s.grants.bookings?.bk_trig1?.payment?.share).toBeUndefined();
	});

	test("a booking in another currency makes the marker and no share", () => {
		const s = world({
			school: BOOKING_SCHOOL,
			policy: withShare(BOOKING_RATE),
		});
		const euro = structuredClone(completed);
		euro.data.object.currency = "eur";
		const result = s.handle(euro);
		expect(typesOf(result.events)).toEqual(["money.skipped"]);
		expect(s.grants.bookings?.bk_trig1?.payment?.share).toBeUndefined();
	});

	test("with no rate the booking's events and record are as they were: no share key anywhere", () => {
		const s = world({ school: BOOKING_SCHOOL });
		s.handle(completed);
		s.handle(fullRefund);
		expect(typesOf(s.events)).toEqual([
			"payment.succeeded",
			"payment.refunded",
		]);
		expect(JSON.stringify(s.rows)).not.toContain('"share"');
	});
});
