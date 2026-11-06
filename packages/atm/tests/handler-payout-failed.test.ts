/**
 * `payout.failed` through the real handler (D3 of the end-to-end matrix). A payout that was paid out of the Stripe balance
 * and then failed has its money back in the Stripe balance, so the books must put it back: the payout clearing account
 * down, `assets:stripe` up, by the payout's amount, and nothing else moves (the fees were Stripe's and stay).
 *
 * The numbers are the matrix's, worked out by hand: a payment of 260.00 with a fee of 7.84 leaves 252.16 in Stripe's
 * balance, and a payout of 252.16 takes all of it. The payout failing puts the 252.16 back.
 *
 *   after the payment                      assets:stripe  252.16   clearing   0.00
 *   after payout.paid     (252.16 out)     assets:stripe    0.00   clearing 252.16
 *   after payout.failed   (252.16 back)    assets:stripe  252.16   clearing   0.00
 */
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { journalMonth, readEvents } from "../src/ledger/files.js";
import { reconcile } from "../src/ledger/reconcile.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { validateEvent } from "../src/ledger/validate.js";
import { FolderStore } from "../src/store/folder-store.js";
import type {
	AtmEvent,
	ReconcileStripe,
	StripePayoutRecord,
} from "../src/types.js";
import {
	FEE,
	GROSS,
	HOUR,
	harness,
	paid,
	payout,
	SCHOOL,
	SHIPPED_AT,
	T0,
} from "./handler-harness.js";
import { hasHledger, tmp } from "./helpers.js";
import { payoutFailed } from "./stripe-events.js";

/** 260.00 paid less the 7.84 fee: what is in Stripe's balance, and so what the payout takes. */
const PAID_OUT = 25_216;
const PAID_AT = T0 + 48 * HOUR;
const FAILED_AT = T0 + 96 * HOUR;
const STRIPE = "assets:stripe";
const CLEARING = "assets:clearing:stripe-payouts";
const FEES = "expenses:billing:stripe-fees";
const PERIOD = { month: "2026-01" };

const failed = (over: Partial<Parameters<typeof payoutFailed>[0]> = {}) =>
	payoutFailed({
		eventId: "evt_po_1_failed",
		payoutId: "po_1",
		amount: PAID_OUT,
		at: FAILED_AT,
		...over,
	});

const ofType = (events: AtmEvent[], type: string) =>
	events.filter((event) => event.event_type === type);

/** Cents of an account over a list of events, from the postings' own decimal text ("252.16" is 25216). */
const cents = (events: AtmEvent[], account: string): number =>
	events
		.flatMap((event) => event.postings)
		.filter((posting) => posting.account === account)
		.reduce(
			(total, posting) => total + Number(posting.amount.replace(".", "")),
			0,
		);

/** A live endpoint that has booked the payment of 260.00 with its fee of 7.84. */
const booked = () => {
	const h = harness({ in_1: FEE });
	expect(h.deliver(paid()).body.outcome).toBe("applied");
	return h;
};

/** The same, with the non_usd warning (which goes to stderr) collected rather than printed. */
const quietBooked = () => {
	const h = booked();
	h.deps.warn = () => undefined;
	return h;
};

describe("payout.failed after payout.paid", () => {
	test("puts the payout back: the clearing account to 0.00 and assets:stripe back to 252.16, the fee untouched", () => {
		const { deliver, outbox } = booked();
		expect(deliver(payout({ amount: PAID_OUT }), PAID_AT).body.outcome).toBe(
			"applied",
		);
		const before = outbox();
		// what the matrix showed before this change: the payout stays in clearing
		expect(cents(before, STRIPE)).toBe(0);
		expect(cents(before, CLEARING)).toBe(25_216);

		const response = deliver(failed(), FAILED_AT);
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({
			outcome: "applied",
			stripeEventId: "evt_po_1_failed",
			events: 1,
			wroteRows: false,
		});
		const events = outbox();
		expect(cents(events, STRIPE)).toBe(25_216);
		expect(cents(events, CLEARING)).toBe(0);
		// 7.84 of fee, as before; nothing was re-priced
		expect(cents(events, FEES)).toBe(784);
		expect(cents(events, "income:billing:membership:sparkle-2")).toBe(-26_000);
		// two payout lines now: the payout and its reversal
		expect(ofType(events, "payout.paid")).toHaveLength(2);
	});

	test("the reversal is a payout.paid with the sides swapped, its own idem, the event's date and failed: true", () => {
		const { deliver, outbox } = booked();
		deliver(payout({ amount: PAID_OUT }), PAID_AT);
		deliver(failed(), FAILED_AT);
		const [first, reversal] = ofType(outbox(), "payout.paid");
		expect(first?.idem).toBe("stripe:po_1");
		expect(first?.postings).toEqual([
			{ account: STRIPE, amount: "-252.16", commodity: "USD" },
			{ account: CLEARING, amount: "252.16", commodity: "USD" },
		]);
		expect(reversal?.idem).toBe("stripe:po_1:failed");
		expect(reversal?.postings).toEqual([
			{ account: STRIPE, amount: "252.16", commodity: "USD" },
			{ account: CLEARING, amount: "-252.16", commodity: "USD" },
		]);
		expect(reversal?.payload).toEqual({
			id: "po_1",
			amount: PAID_OUT,
			currency: "usd",
			failed: true,
		});
		// dated by the failure, 19 January (the payout was 17 January), not by the payout
		expect(first?.date).toBe("2026-01-17");
		expect(reversal?.date).toBe("2026-01-19");
		expect(reversal?.event_time).toBe("2026-01-19T18:00:00Z");
		expect(reversal?.text).toBe("payout failed 252.16 USD");
		expect(validateEvent(reversal)).toEqual({ ok: true, errors: [] });
	});

	test("the same failed event delivered again is a duplicate, and under a new Stripe event id books nothing more", () => {
		const { deliver, outbox } = booked();
		deliver(payout({ amount: PAID_OUT }), PAID_AT);
		expect(deliver(failed(), FAILED_AT).body.outcome).toBe("applied");
		const once = outbox();

		expect(deliver(failed(), FAILED_AT).body.outcome).toBe("duplicate");
		// the dashboard's re-send, or Stripe's own, under another event id: still one reversal
		const again = deliver(failed({ eventId: "evt_po_1_failed_2" }), FAILED_AT);
		expect(again.status).toBe(200);
		expect(outbox()).toEqual(once);
		expect(cents(outbox(), CLEARING)).toBe(0);
		expect(cents(outbox(), STRIPE)).toBe(25_216);
	});

	test("the paid event delivered again after the failure books nothing: the payout is not back in clearing", () => {
		const { deliver, outbox } = booked();
		deliver(payout({ amount: PAID_OUT }), PAID_AT);
		deliver(failed(), FAILED_AT);
		const settled = outbox();
		deliver(payout({ amount: PAID_OUT, eventId: "evt_po_1_again" }), PAID_AT);
		expect(outbox()).toEqual(settled);
		expect(cents(outbox(), CLEARING)).toBe(0);
	});

	test("a payout that fails and is paid again as a new payout books normally: only the new payout is in clearing", () => {
		const { deliver, outbox } = booked();
		deliver(payout({ amount: PAID_OUT }), PAID_AT);
		deliver(failed(), FAILED_AT);
		const repaid = deliver(
			payout({
				eventId: "evt_po_2",
				payoutId: "po_2",
				amount: PAID_OUT,
				at: FAILED_AT + 24 * HOUR,
			}),
			FAILED_AT + 24 * HOUR,
		);
		expect(repaid.body.outcome).toBe("applied");
		const events = outbox();
		// 252.16 in, out (po_1), back (failed), out again (po_2)
		expect(cents(events, STRIPE)).toBe(0);
		expect(cents(events, CLEARING)).toBe(25_216);
		expect(ofType(events, "payout.paid").map((e) => e.idem)).toEqual([
			"stripe:po_1",
			"stripe:po_1:failed",
			"stripe:po_2",
		]);
	});

	test("a payout of an amount of nothing is refused 422, as for payout.paid, and writes nothing", () => {
		const { deliver, outbox } = booked();
		deliver(payout({ amount: PAID_OUT }), PAID_AT);
		const before = outbox();
		const response = deliver(failed({ amount: 0 }), FAILED_AT);
		expect([response.status, response.body.reason]).toEqual([422, "bad_event"]);
		expect(outbox()).toEqual(before);
	});
});

describe("payout.failed before payout.paid, or with no payout.paid at all", () => {
	test("arriving first it waits, 409 unmatched_payment with no claim; once the payout is booked the retry reverses it", () => {
		const { deliver, outbox, claim } = booked();
		const early = deliver(failed(), FAILED_AT);
		expect(early.status).toBe(409);
		expect(early.body.outcome).toBe("unmatched_payment");
		expect(early.body.message).toContain("po_1");
		expect(claim("evt_po_1_failed")).toBeNull();
		// nothing was booked: the books are only the payment, never a negative clearing account
		expect(ofType(outbox(), "payout.paid")).toEqual([]);
		expect(cents(outbox(), CLEARING)).toBe(0);
		expect(cents(outbox(), STRIPE)).toBe(25_216);

		// Stripe retries the failure: still nothing to reverse
		expect(deliver(failed(), FAILED_AT + HOUR).status).toBe(409);

		// the payout.paid that was late arrives, then the retry of the failure
		expect(deliver(payout({ amount: PAID_OUT }), PAID_AT).body.outcome).toBe(
			"applied",
		);
		expect(deliver(failed(), FAILED_AT + 2 * HOUR).body.outcome).toBe(
			"applied",
		);
		const events = outbox();
		expect(cents(events, CLEARING)).toBe(0);
		expect(cents(events, STRIPE)).toBe(25_216);
		expect(ofType(events, "payout.paid")).toHaveLength(2);
	});

	test("a payout that failed and was never paid is never booked: 409 on every retry, the books stay as they were", () => {
		const { deliver, outbox } = booked();
		const before = outbox();
		for (let retry = 0; retry < 3; retry++)
			expect(deliver(failed(), FAILED_AT + retry * HOUR).status).toBe(409);
		expect(outbox()).toEqual(before);
		// Stripe never moved the 252.16 to the bank, and neither did the books: assets:stripe still holds it
		expect(cents(outbox(), STRIPE)).toBe(25_216);
	});

	test("another payout's booking is not this payout's: po_2 paid does not let po_1's failure through", () => {
		const { deliver, outbox } = booked();
		deliver(
			payout({ eventId: "evt_po_2", payoutId: "po_2", amount: 100 }),
			PAID_AT,
		);
		const before = outbox();
		expect(deliver(failed(), FAILED_AT).status).toBe(409);
		expect(outbox()).toEqual(before);
	});
});

describe("a non-USD payout that fails", () => {
	const inEuros = (event: ReturnType<typeof failed>) => {
		event.data.object.currency = "eur";
		return event;
	};

	test("is answered non_usd after the paid one, with no payout line, and leaves the one marker the payout already has", () => {
		const { deliver, outbox } = quietBooked();
		const eur = payout({ amount: PAID_OUT });
		eur.data.object.currency = "eur";
		expect(deliver(eur, PAID_AT).body.outcome).toBe("non_usd");
		const response = deliver(inEuros(failed()), FAILED_AT);
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({
			outcome: "non_usd",
			skipped: [`payout po_1 ${PAID_OUT} eur`],
		});
		const events = outbox();
		expect(ofType(events, "payout.paid")).toEqual([]);
		// one marker for the payout, not one for its failure too
		expect(ofType(events, "money.skipped")).toHaveLength(1);
		expect(cents(events, CLEARING)).toBe(0);
		expect(cents(events, STRIPE)).toBe(25_216);
	});

	test("does not wait for a payout line: arriving first it is answered non_usd, not 409, and the later paid adds no marker", () => {
		const { deliver, outbox } = quietBooked();
		const first = deliver(inEuros(failed()), FAILED_AT);
		expect(first.body.outcome).toBe("non_usd");
		const eur = payout({ amount: PAID_OUT });
		eur.data.object.currency = "eur";
		deliver(eur, PAID_AT);
		const events = outbox();
		expect(ofType(events, "money.skipped")).toHaveLength(1);
		expect(ofType(events, "payout.paid")).toEqual([]);
	});
});

describe("reconcile of a payout that failed", () => {
	const record = (status: string): StripePayoutRecord => ({
		id: "po_1",
		amount: PAID_OUT,
		currency: "usd",
		created: Math.floor(PAID_AT / 1000),
		status,
		livemode: true,
	});
	const stripeSide = (
		status: string,
		failedAt = FAILED_AT,
	): ReconcileStripe => ({
		invoices: [
			{
				id: "in_1",
				status: "paid",
				amount_paid: GROSS,
				currency: "usd",
				created: Math.floor(T0 / 1000),
				livemode: true,
				status_transitions: { paid_at: Math.floor(T0 / 1000) },
			},
		],
		refunds: [],
		disputes: [],
		payouts: [record(status)],
		balanceTransactions: [
			{
				id: "txn_charge",
				amount: GROSS,
				fee: FEE,
				net: GROSS - FEE,
				currency: "usd",
				created: Math.floor(T0 / 1000),
				type: "charge",
			},
			{
				id: "txn_po_1",
				amount: -PAID_OUT,
				fee: 0,
				net: -PAID_OUT,
				currency: "usd",
				created: Math.floor(PAID_AT / 1000),
				type: "payout",
			},
			{
				id: "txn_po_1_failure",
				amount: PAID_OUT,
				fee: 0,
				net: PAID_OUT,
				currency: "usd",
				created: Math.floor(failedAt / 1000),
				type: "payout_failure",
			},
		],
	});
	const run = (events: AtmEvent[], status: string) =>
		reconcile({
			events,
			stripe: stripeSide(status),
			period: PERIOD,
			timeZone: "America/Denver",
		});

	test("a payout Stripe says failed and the log paid and reversed is not a difference, in either month it falls in", () => {
		const { deliver, outbox } = booked();
		deliver(payout({ amount: PAID_OUT }), PAID_AT);
		deliver(failed(), FAILED_AT);
		const clean = run(outbox(), "failed");
		expect(clean.differences).toEqual([]);
		expect(clean.counts.payout).toEqual({ stripe: 0, log: 0 });
	});

	test("a failure that falls in the next month is no difference in January (paid) or in February (reversed)", () => {
		const { deliver, outbox } = booked();
		deliver(payout({ amount: PAID_OUT }), PAID_AT);
		const february = T0 + 18 * 24 * HOUR;
		expect(deliver(failed({ at: february }), february).body.outcome).toBe(
			"applied",
		);
		const [, reversal] = ofType(outbox(), "payout.paid");
		expect(reversal?.date).toBe("2026-02-02");
		for (const month of ["2026-01", "2026-02"]) {
			const result = reconcile({
				events: outbox(),
				stripe: stripeSide("failed", february),
				period: { month },
				timeZone: "America/Denver",
			});
			expect([month, result.differences]).toEqual([month, []]);
		}
	});

	test("a payout Stripe says failed and the log still has as paid is missing_in_stripe: the failure is not booked yet", () => {
		const { deliver, outbox } = booked();
		deliver(payout({ amount: PAID_OUT }), PAID_AT);
		const result = run(outbox(), "failed");
		expect(
			result.differences.map((d) => `${d.kind} ${d.object} ${d.id}`),
		).toEqual(["missing_in_stripe payout po_1"]);
	});

	test("a payout the log reversed and Stripe says paid is a difference, not hidden by the reversal", () => {
		const { deliver, outbox } = booked();
		deliver(payout({ amount: PAID_OUT }), PAID_AT);
		deliver(failed(), FAILED_AT);
		const result = run(outbox(), "paid");
		expect(
			result.differences.map((d) => `${d.kind} ${d.object} ${d.id}`),
		).toEqual(["missing_in_log payout po_1"]);
	});

	test("a payout that failed and was paid again as po_2 pairs with Stripe's po_2 and ignores the failed po_1", () => {
		const { deliver, outbox } = booked();
		deliver(payout({ amount: PAID_OUT }), PAID_AT);
		deliver(failed(), FAILED_AT);
		deliver(
			payout({
				eventId: "evt_po_2",
				payoutId: "po_2",
				amount: PAID_OUT,
				at: FAILED_AT + 24 * HOUR,
			}),
			FAILED_AT + 24 * HOUR,
		);
		const stripe = stripeSide("failed");
		stripe.payouts = [
			record("failed"),
			{
				...record("paid"),
				id: "po_2",
				created: Math.floor((FAILED_AT + 24 * HOUR) / 1000),
			},
		];
		const result = reconcile({
			events: outbox(),
			stripe: {
				...stripe,
				balanceTransactions: (stripe.balanceTransactions ?? []).concat([
					{
						id: "txn_po_2",
						amount: -PAID_OUT,
						fee: 0,
						net: -PAID_OUT,
						currency: "usd",
						created: Math.floor((FAILED_AT + 24 * HOUR) / 1000),
						type: "payout",
					},
				]),
			},
			period: PERIOD,
			timeZone: "America/Denver",
		});
		expect(result.differences).toEqual([]);
		expect(result.counts.payout).toEqual({ stripe: 1, log: 1 });
	});
});

describe("a failed payout through the shipped journal and hledger", () => {
	test.skipIf(!hasHledger)(
		"hledger check passes, the clearing account is zero and assets:stripe holds 252.16 again",
		async () => {
			const { db, deliver } = booked();
			deliver(payout({ amount: PAID_OUT }), PAID_AT);
			deliver(failed(), FAILED_AT);
			const root = await tmp("handler-payout-failed");
			try {
				const shipped = await shipOutbox({
					db,
					store: new FolderStore({ root }),
					school: SCHOOL,
					nowMs: () => SHIPPED_AT,
				});
				expect(shipped.conflicts).toEqual([]);
				await journalMonth({ root, school: SCHOOL, month: "2026-01" });
				const { events } = await readEvents(root, SCHOOL);
				expect(
					events.filter((event) => event.event_type === "payout.paid"),
				).toHaveLength(2);
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
				const sheet = hledger(["bs", "-O", "csv"]);
				expect(sheet).toContain('"assets:stripe","252.16 USD"');
				// hledger leaves out an account whose balance is zero
				expect(sheet).not.toContain("assets:clearing:stripe-payouts");
				const statement = hledger(["is", "-O", "csv"]);
				expect(statement).toContain(
					'"expenses:billing:stripe-fees","7.84 USD"',
				);
				// net income: 260.00 - 7.84, as before the payout: a failed payout is not income or expense
				expect(statement).toContain('"Net:","252.16 USD"');
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
