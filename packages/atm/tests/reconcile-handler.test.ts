/**
 * `reconcile` against a log the reference handler made. The school's side is what the real handler wrote for an invoice,
 * two partial refunds and a payout, shipped and read back; Stripe's side is built by hand from Stripe's documented
 * shapes (an invoice, refund objects with their own `re_` ids, a payout, balance transactions), never from the events.
 * A `charge.refunded` delivers a Charge, which carries no refund id, so the handler's refund event is labelled with the
 * Stripe event id (`evt_…`) and is tied to Stripe's refund list by what it does carry: the payment intent and the charge.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { readEvents } from "../src/ledger/files.js";
import { ledgerEvent } from "../src/ledger/postings.js";
import { reconcile } from "../src/ledger/reconcile.js";
import { replayEvents } from "../src/ledger/replay.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { validateEvent } from "../src/ledger/validate.js";
import { FolderStore } from "../src/store/folder-store.js";
import type {
	AtmEvent,
	ReconcileDifference,
	ReconcileStripe,
	StripeRefundRecord,
} from "../src/types.js";
import {
	FEE,
	GROSS,
	HOUR,
	harness,
	linked,
	paid,
	refund,
	SCHOOL,
	SHIPPED_AT,
	T0,
} from "./handler-harness.js";
import { tmp } from "./helpers.js";
import { paymentIntentOf, payoutPaid } from "./stripe-events.js";

const SECOND_REFUND = 3000;
const FIRST_REFUND = 5000;
const PAYOUT_AMOUNT = GROSS - FEE - FIRST_REFUND - SECOND_REFUND;
const PERIOD = { month: "2026-01" };
const seconds = (ms: number) => Math.floor(ms / 1000);
const CHARGE = "ch_in_1";
const INTENT = paymentIntentOf("in_1");

/** A refund object as Stripe's `GET /v1/refunds` returns it: its own `re_` id, the charge and the payment intent it refunds. */
const stripeRefund = (
	id: string,
	amount: number,
	at: number,
	over: Partial<StripeRefundRecord> = {},
): StripeRefundRecord => ({
	id,
	amount,
	currency: "usd",
	charge: CHARGE,
	payment_intent: INTENT,
	created: seconds(at),
	status: "succeeded",
	...over,
});

/** Stripe's side for the scenario, written out from the documented shapes. */
const stripeSide = (refunds: StripeRefundRecord[]): ReconcileStripe => ({
	invoices: [
		{
			id: "in_1",
			status: "paid",
			amount_paid: GROSS,
			currency: "usd",
			created: seconds(T0),
			livemode: true,
			status_transitions: { paid_at: seconds(T0) },
		},
	],
	refunds,
	payouts: [
		{
			id: "po_1",
			amount: PAYOUT_AMOUNT,
			currency: "usd",
			created: seconds(T0 + 48 * HOUR),
			status: "paid",
			livemode: true,
		},
	],
	balanceTransactions: [
		{
			id: "txn_charge",
			amount: GROSS,
			fee: FEE,
			net: GROSS - FEE,
			currency: "usd",
			created: seconds(T0),
			type: "charge",
		},
		...refunds.map((record) => ({
			id: `txn_${record.id}`,
			amount: -record.amount,
			fee: 0,
			net: -record.amount,
			currency: "usd",
			created: record.created,
			type: "refund",
		})),
		{
			id: "txn_payout",
			amount: -PAYOUT_AMOUNT,
			fee: 0,
			net: -PAYOUT_AMOUNT,
			currency: "usd",
			created: seconds(T0 + 48 * HOUR),
			type: "payout",
		},
	],
});

const HAND_MADE_REFUNDS = [
	stripeRefund("re_3UYPRcScrubTest02A", FIRST_REFUND, T0 + HOUR),
	stripeRefund("re_3UYPRcScrubTest02B", SECOND_REFUND, T0 + 2 * HOUR),
];

let events: AtmEvent[];
beforeAll(async () => {
	const { db, deliver } = harness({ in_1: FEE });
	const applied = (outcome: { body: { outcome: string } }) =>
		expect(outcome.body.outcome).toBe("applied");
	applied(deliver(paid()));
	applied(deliver(linked("in_1"), T0 + 1000));
	applied(
		deliver(
			refund(FIRST_REFUND, { eventId: "evt_re_1", at: T0 + HOUR }),
			T0 + HOUR,
		),
	);
	applied(
		deliver(
			refund(SECOND_REFUND, {
				eventId: "evt_re_2",
				refundedTotal: FIRST_REFUND + SECOND_REFUND,
				at: T0 + 2 * HOUR,
			}),
			T0 + 2 * HOUR,
		),
	);
	applied(
		deliver(
			payoutPaid({
				eventId: "evt_po_1",
				payoutId: "po_1",
				amount: PAYOUT_AMOUNT,
				at: T0 + 48 * HOUR,
			}),
			T0 + 48 * HOUR,
		),
	);
	const root = await tmp("reconcile-handler");
	try {
		const shipped = await shipOutbox({
			db,
			store: new FolderStore({ root }),
			school: SCHOOL,
			nowMs: () => SHIPPED_AT,
		});
		expect(shipped.conflicts).toEqual([]);
		events = (await readEvents(root, SCHOOL)).events;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const refundEvents = () =>
	events.filter((event) => event.event_type === "payment.refunded");

const kinds = (differences: ReconcileDifference[]) =>
	differences.map((difference) => `${difference.kind} ${difference.object}`);

const run = (log: readonly AtmEvent[], stripe: ReconcileStripe) =>
	reconcile({ events: log, stripe, period: PERIOD });

describe("a log the handler made, against Stripe's own objects", () => {
	test("an invoice, two partial refunds and a payout reconcile clean", () => {
		expect(refundEvents().map((event) => event.payload.id)).toEqual([
			"evt_re_1",
			"evt_re_2",
		]);
		const result = run(events, stripeSide(HAND_MADE_REFUNDS));
		expect(result.differences).toEqual([]);
		expect(result.counts.refund).toEqual({ stripe: 2, log: 2 });
	});

	test("the handler's refund event carries what ties it to Stripe's refund list", () => {
		const [first, second] = refundEvents();
		expect(first?.payload).toEqual({
			id: "evt_re_1",
			amount: FIRST_REFUND,
			currency: "usd",
			charge: CHARGE,
			payment_intent: INTENT,
			invoice: "in_1",
			amount_refunded: FIRST_REFUND,
		});
		expect(second?.payload).toMatchObject({
			amount: SECOND_REFUND,
			amount_refunded: FIRST_REFUND + SECOND_REFUND,
		});
		for (const event of refundEvents())
			expect(validateEvent(event).ok).toBe(true);
	});

	test("a refund Stripe has and the log lacks is missing_in_log", () => {
		const log = events.filter((event) => event.payload.id !== "evt_re_2");
		const result = run(log, stripeSide(HAND_MADE_REFUNDS));
		const missing = result.differences.filter(
			(difference) => difference.object === "refund",
		);
		expect(kinds(missing)).toEqual(["missing_in_log refund"]);
		expect(missing[0]).toMatchObject({
			id: "re_3UYPRcScrubTest02B",
			stripe: { amount: SECOND_REFUND },
			log: null,
		});
	});

	test("a refund the log has and Stripe lacks is missing_in_stripe, under the event's id", () => {
		const result = run(events, stripeSide(HAND_MADE_REFUNDS.slice(0, 1)));
		const missing = result.differences.filter(
			(difference) => difference.object === "refund",
		);
		expect(kinds(missing)).toEqual(["missing_in_stripe refund"]);
		expect(missing[0]).toMatchObject({
			id: "evt_re_2",
			log: { amount: SECOND_REFUND },
			stripe: null,
		});
	});

	test("a refund whose amount changed is amount_differs, not two missing records", () => {
		const changed = [
			HAND_MADE_REFUNDS[0] as StripeRefundRecord,
			stripeRefund("re_3UYPRcScrubTest02B", SECOND_REFUND + 1, T0 + 2 * HOUR),
		];
		const result = run(events, stripeSide(changed));
		const refunds = result.differences.filter(
			(difference) => difference.object === "refund",
		);
		expect(kinds(refunds)).toEqual(["amount_differs refund"]);
		expect(refunds[0]).toMatchObject({
			id: "re_3UYPRcScrubTest02B",
			stripe: { amount: SECOND_REFUND + 1 },
			log: { amount: SECOND_REFUND },
			eventIds: [refundEvents()[1]?.id],
		});
	});

	test("a refund on another payment is not paired by amount alone", () => {
		const elsewhere = [
			HAND_MADE_REFUNDS[0] as StripeRefundRecord,
			stripeRefund("re_other", SECOND_REFUND, T0 + 2 * HOUR, {
				charge: "ch_other",
				payment_intent: "pi_other",
			}),
		];
		const result = run(events, stripeSide(elsewhere));
		expect(
			kinds(
				result.differences.filter(
					(difference) => difference.object === "refund",
				),
			),
		).toEqual(["missing_in_stripe refund", "missing_in_log refund"]);
	});
});

describe("the refund payload's optional fields", () => {
	test("an old refund payload (id, amount, currency) and one with the new fields both validate; a wrong type does not", () => {
		const [handlerMade] = refundEvents() as [AtmEvent];
		const { charge, payment_intent, invoice, amount_refunded, ...old } =
			handlerMade.payload;
		expect([charge, payment_intent, invoice, amount_refunded]).toHaveLength(4);
		expect(validateEvent({ ...handlerMade, payload: old }).ok).toBe(true);
		expect(validateEvent(handlerMade).ok).toBe(true);
		for (const bad of [
			{ charge: 5 },
			{ payment_intent: "" },
			{ amount_refunded: 1.5 },
		])
			expect(
				validateEvent({
					...handlerMade,
					payload: { ...handlerMade.payload, ...bad },
				}).ok,
			).toBe(false);
	});

	test("replay accepts the log with the new fields, and the same log without them", () => {
		const bare = events.map((event) =>
			event.event_type === "payment.refunded"
				? {
						...event,
						payload: {
							id: event.payload.id,
							amount: event.payload.amount,
							currency: event.payload.currency,
						},
					}
				: event,
		);
		for (const log of [events, bare])
			expect(() => replayEvents({ events: log, catalog: [] })).not.toThrow();
	});
});

/** A `payment.refunded` as the handler books it from a `charge.refunded` event. */
const booked = ({
	id,
	amount,
	at,
	payment = { charge: CHARGE, payment_intent: INTENT },
}: {
	id: string;
	amount: number;
	at: number;
	payment?: Record<string, string>;
}): AtmEvent =>
	ledgerEvent({
		type: "payment.refunded",
		school: SCHOOL,
		tz: "America/Denver",
		eventTime: at,
		key: "family:fam_8k2",
		idem: `stripe:${id}`,
		amount,
		payload: { id, amount, currency: "usd", ...payment },
	});

const refundDifferences = (
	log: readonly AtmEvent[],
	refunds: StripeRefundRecord[],
	period: { month: string } = PERIOD,
) =>
	reconcile({
		events: log,
		stripe: { refunds },
		period,
		timeZone: "America/Denver",
	}).differences;

describe("refunds of one payment are a multiset", () => {
	const equal = [
		booked({ id: "evt_a", amount: 2500, at: T0 + HOUR }),
		booked({ id: "evt_b", amount: 2500, at: T0 + 2 * HOUR }),
	];
	const twoEqual = [
		stripeRefund("re_a", 2500, T0 + HOUR),
		stripeRefund("re_b", 2500, T0 + 2 * HOUR),
	];

	test("two equal refunds on one payment pair one to one, not collapse", () => {
		expect(refundDifferences(equal, twoEqual)).toEqual([]);
	});

	test("a third equal refund in Stripe only is exactly one missing_in_log", () => {
		const differences = refundDifferences(equal, [
			...twoEqual,
			stripeRefund("re_c", 2500, T0 + 3 * HOUR),
		]);
		expect(kinds(differences)).toEqual(["missing_in_log refund"]);
		expect(differences[0]?.id).toBe("re_c");
	});

	test("a third equal refund in the log only is exactly one missing_in_stripe", () => {
		const differences = refundDifferences(
			[...equal, booked({ id: "evt_c", amount: 2500, at: T0 + 3 * HOUR })],
			twoEqual,
		);
		expect(kinds(differences)).toEqual(["missing_in_stripe refund"]);
		expect(differences[0]?.id).toBe("evt_c");
	});

	test("a payment with no payment intent is paired by its charge", () => {
		const byCharge = { charge: "ch_only" };
		expect(
			refundDifferences(
				[
					booked({
						id: "evt_a",
						amount: 700,
						at: T0 + HOUR,
						payment: byCharge,
					}),
				],
				[
					stripeRefund("re_a", 700, T0 + HOUR, {
						...byCharge,
						payment_intent: null,
					}),
				],
			),
		).toEqual([]);
	});

	test("a Stripe list of one month pairs a refund by its own day, not the earlier equal one", () => {
		const february = Date.parse("2026-02-10T18:00:00Z");
		const march = Date.parse("2026-03-10T18:00:00Z");
		expect(
			refundDifferences(
				[
					booked({ id: "evt_feb", amount: 900, at: february }),
					booked({ id: "evt_mar", amount: 900, at: march }),
				],
				[stripeRefund("re_mar", 900, march)],
				{ month: "2026-03" },
			),
		).toEqual([]);
	});

	test("a refund pairs with the equal Stripe refund nearest in time, not an earlier one of another month", () => {
		// The log's refund of 20 Jan falls just past midnight where Stripe's falls just before it, so no day matches; the
		// December refund of the same amount is on the log only (Stripe's list is January's) and must not take January's.
		const differences = refundDifferences(
			[
				booked({
					id: "evt_dec",
					amount: 900,
					at: Date.parse("2025-12-15T18:00:00Z"),
				}),
				booked({
					id: "evt_jan",
					amount: 900,
					at: Date.parse("2026-01-20T07:00:30Z"),
				}),
			],
			[stripeRefund("re_jan", 900, Date.parse("2026-01-20T06:59:00Z"))],
		);
		expect(differences).toEqual([]);
	});

	test("a missing middle refund is reported as missing, not as a period shift of the last one", () => {
		const day = (date: string) => Date.parse(`${date}T18:00:00Z`);
		const differences = refundDifferences(
			[
				booked({ id: "evt_1", amount: 900, at: day("2026-01-06") }),
				booked({ id: "evt_3", amount: 900, at: day("2026-02-04") }),
			],
			[
				stripeRefund("re_1", 900, day("2026-01-05")),
				stripeRefund("re_2", 900, day("2026-01-20")),
				stripeRefund("re_3", 900, day("2026-02-03")),
			],
		);
		expect(kinds(differences)).toEqual(["missing_in_log refund"]);
		expect(differences[0]?.id).toBe("re_2");
	});

	test("a refund the log dates in another month than Stripe is period_differs", () => {
		const differences = refundDifferences(
			[booked({ id: "evt_a", amount: 900, at: T0 })],
			[stripeRefund("re_a", 900, Date.parse("2026-02-01T18:00:00Z"))],
			{ month: "2026-02" },
		);
		expect(kinds(differences)).toEqual(["period_differs refund"]);
	});

	test("an event labelled with a refund id (re_...) is matched by that id, whatever payment it names", () => {
		const log = [
			booked({
				id: "re_a",
				amount: 2500,
				at: T0 + HOUR,
				payment: { charge: "ch_x", payment_intent: "pi_x" },
			}),
		];
		expect(
			refundDifferences(log, [stripeRefund("re_a", 2500, T0 + HOUR)]),
		).toEqual([]);
		expect(
			kinds(refundDifferences(log, [stripeRefund("re_a", 2400, T0 + HOUR)])),
		).toEqual(["amount_differs refund"]);
	});

	test("a refund id (re_...) is never paired by payment: it keeps its own Stripe refund when another equal one is nearer in time", () => {
		const log = [booked({ id: "re_b", amount: 2500, at: T0 + HOUR })];
		const differences = refundDifferences(log, twoEqual);
		expect(kinds(differences)).toEqual(["missing_in_log refund"]);
		expect(differences[0]?.id).toBe("re_a");
	});

	test("a Stripe refund that an event with a refund id matches is not paired with an evt_ event", () => {
		const log = [
			booked({ id: "re_b", amount: 2500, at: T0 + 2 * HOUR }),
			booked({ id: "evt_a", amount: 2500, at: T0 + 2 * HOUR }),
		];
		expect(refundDifferences(log, twoEqual)).toEqual([]);
	});

	test("refunds of unequal amounts pair by amount, not by order or day", () => {
		const log = [
			booked({ id: "evt_a", amount: 2500, at: T0 + HOUR }),
			booked({ id: "evt_b", amount: 3000, at: T0 + 2 * HOUR }),
		];
		const stripe = [
			stripeRefund("re_a", 3000, T0 + HOUR),
			stripeRefund("re_b", 2500, T0 + 2 * HOUR),
		];
		expect(refundDifferences(log, stripe)).toEqual([]);
	});

	test("a payment is told by its payment intent, else its charge, and by nothing else", () => {
		const intentOnly = { payment_intent: "pi_x" };
		const chargeOnly = { charge: "ch_x" };
		const log = (payment: Record<string, string>) => [
			booked({ id: "evt_a", amount: 700, at: T0 + HOUR, payment }),
		];
		const stripe = (over: Partial<StripeRefundRecord>) => [
			stripeRefund("re_a", 700, T0 + HOUR, over),
		];
		// the event names an intent and a charge, Stripe's refund only the charge
		expect(
			refundDifferences(
				log({ payment_intent: "pi_x", charge: "ch_x" }),
				stripe({ charge: "ch_x", payment_intent: null }),
			),
		).toEqual([]);
		// the event names only a charge, Stripe's refund only an intent: nothing ties them
		expect(
			kinds(
				refundDifferences(
					log(chargeOnly),
					stripe({ charge: null, payment_intent: "pi_x" }),
				),
			),
		).toEqual(["missing_in_stripe refund", "missing_in_log refund"]);
		// the reverse
		expect(
			kinds(
				refundDifferences(
					log(intentOnly),
					stripe({ charge: "ch_x", payment_intent: null }),
				),
			),
		).toEqual(["missing_in_stripe refund", "missing_in_log refund"]);
		// two charges, no intent anywhere
		expect(
			kinds(
				refundDifferences(
					log(chargeOnly),
					stripe({ charge: "ch_y", payment_intent: null }),
				),
			),
		).toEqual(["missing_in_stripe refund", "missing_in_log refund"]);
	});

	test("a refund of another amount outside the period is not paired with one in it", () => {
		// the log's refund is January's; Stripe's of another amount is February's, out of the period asked
		const differences = refundDifferences(
			[booked({ id: "evt_a", amount: 3000, at: T0 })],
			[stripeRefund("re_a", 2000, Date.parse("2026-02-10T18:00:00Z"))],
		);
		expect(kinds(differences)).toEqual(["missing_in_stripe refund"]);
	});

	test("a log from the handler before these fields (an evt_ id, no charge) cannot be tied: reported on both sides", () => {
		const old = ledgerEvent({
			type: "payment.refunded",
			school: SCHOOL,
			tz: "America/Denver",
			eventTime: T0 + HOUR,
			key: "family:fam_8k2",
			idem: "stripe:evt_old",
			amount: 2500,
			payload: { id: "evt_old", amount: 2500, currency: "usd" },
		});
		expect(
			kinds(refundDifferences([old], [stripeRefund("re_a", 2500, T0 + HOUR)])),
		).toEqual(["missing_in_stripe refund", "missing_in_log refund"]);
	});
});
