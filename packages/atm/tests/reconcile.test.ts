/**
 * `reconcile` against the golden year (`fixtures/vibes-year`): a log whose Stripe side is built from its own events
 * reconciles clean, and each concrete mutation is reported as the one difference it is.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import { ledgerEvent } from "../src/ledger/postings.js";
import { reconcile } from "../src/ledger/reconcile.js";
import type {
	AtmEvent,
	ReconcileDifference,
	ReconcileStripe,
} from "../src/types.js";
import { stripeSideOf } from "./stripe-side.js";

const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const SCHOOL = "sch_vol";
const YEAR = { from: "2026-01-01", to: "2026-12-31" };
const TZ = "America/Denver";

let events: AtmEvent[];
beforeAll(async () => {
	events = (await readEvents(FIXTURE, SCHOOL)).events;
});

const ofType = (type: AtmEvent["event_type"]) =>
	events.filter((event) => event.event_type === type);

/** The golden year's events with `change` applied to the one event `id` belongs to. */
const mutate = (
	id: string,
	change: (event: AtmEvent) => AtmEvent | null,
): AtmEvent[] =>
	events.flatMap((event) => {
		if (event.payload.id !== id) return [event];
		const changed = change(event);
		return changed ? [changed] : [];
	});

/** A payment event as the handler books it: gross less fee to Stripe, the fee, the income. */
const payment = ({
	id,
	instant,
	amount = 13000,
	fee = 0,
}: {
	id: string;
	instant: string;
	amount?: number;
	fee?: number;
}): AtmEvent =>
	ledgerEvent({
		type: "payment.succeeded",
		school: SCHOOL,
		tz: TZ,
		eventTime: instant,
		key: "family:fam_edge",
		idem: `stripe:${id}`,
		amount,
		fee,
		incomeKind: "membership:sparkle-1",
		payload: {
			id,
			amount_paid: amount,
			fee,
			currency: "usd",
			customer: "cus_edge",
		},
	});

const kinds = (differences: ReconcileDifference[]) =>
	differences.map((difference) => `${difference.kind} ${difference.object}`);

const run = (
	log: readonly AtmEvent[],
	stripe: ReconcileStripe = stripeSideOf(events),
) => reconcile({ events: log, stripe, period: YEAR });

describe("a log that matches Stripe", () => {
	test("the golden year reconciles clean, every record matched", () => {
		const result = run(events);
		expect(result.differences).toEqual([]);
		expect(result.notSupplied).toEqual([]);
		expect(result.period).toEqual({
			...YEAR,
			label: "2026-01-01..2026-12-31",
			timeZone: TZ,
		});
		expect(result.counts.invoice).toEqual({ stripe: 12, log: 12 });
		expect(result.counts.refund).toEqual({ stripe: 1, log: 1 });
		expect(result.counts.payout).toEqual({ stripe: 11, log: 11 });
		expect(result.counts.fees.log).toBe(12);
	});

	test("the Stripe side comes from the events' own invoice ids and amounts", () => {
		const stripe = stripeSideOf(events);
		expect(stripe.invoices.map((invoice) => invoice.id)).toEqual(
			ofType("payment.succeeded").map((event) => event.payload.id as string),
		);
		expect(stripe.invoices[0]?.amount_paid).toBe(26000);
	});

	test("every month of the year reconciles clean by itself", () => {
		const months = [...new Set(events.map((event) => event.date.slice(0, 7)))];
		expect(months.length).toBeGreaterThan(6);
		for (const month of months) {
			const result = reconcile({
				events,
				stripe: stripeSideOf(events),
				period: { month },
			});
			expect(result.differences).toEqual([]);
		}
	});
});

describe("each difference is detected", () => {
	const paymentId = "in_0_lw1hm";

	test("a payment event dropped is missing_in_log, and the fee and net totals follow", () => {
		const result = run(mutate(paymentId, () => null));
		expect(kinds(result.differences)).toEqual([
			"missing_in_log invoice",
			"amount_differs fees",
			"amount_differs net",
		]);
		const missing = result.differences.find((d) => d.kind === "missing_in_log");
		expect(missing).toMatchObject({
			id: paymentId,
			eventType: "payment.succeeded",
			period: "2026-01-01..2026-12-31",
			stripe: { amount: 26000, currency: "usd", date: "2026-01-17" },
			log: null,
		});
		const net = result.differences.find((d) => d.object === "net");
		expect(net?.stripe?.amount).toBe((net?.log?.amount ?? 0) + 25216);
	});

	test("a payment event twice is duplicate_in_log", () => {
		const original = ofType("payment.succeeded")[0] as AtmEvent;
		const copy: AtmEvent = {
			...original,
			id: "01KF6B43S000000A6T73VEVRVT",
			idem: "stripe:evt_second_delivery",
		};
		const result = run([...events, copy]);
		const duplicate = result.differences.find(
			(d) => d.kind === "duplicate_in_log",
		);
		expect(duplicate).toMatchObject({
			object: "invoice",
			id: paymentId,
			eventIds: [original.id, copy.id],
		});
		// The money is booked twice, so the net moves too.
		expect(kinds(result.differences)).toEqual([
			"duplicate_in_log invoice",
			"amount_differs fees",
			"amount_differs net",
		]);
	});

	test("an amount one cent off is amount_differs with both amounts", () => {
		const result = run(
			mutate(paymentId, (event) => ({
				...event,
				payload: { ...event.payload, amount_paid: 26001 },
			})),
		);
		expect(result.differences).toHaveLength(1);
		expect(result.differences[0]).toMatchObject({
			kind: "amount_differs",
			object: "invoice",
			id: paymentId,
			stripe: { amount: 26000 },
			log: { amount: 26001 },
		});
	});

	test("a currency that differs is amount_differs", () => {
		const result = run(
			mutate(paymentId, (event) => ({
				...event,
				payload: { ...event.payload, currency: "eur" },
			})),
		);
		expect(kinds(result.differences)).toEqual(["amount_differs invoice"]);
	});

	test("a refund dropped is missing_in_log", () => {
		const result = run(mutate("re_9", () => null));
		expect(result.differences.find((d) => d.object === "refund")).toMatchObject(
			{
				kind: "missing_in_log",
				id: "re_9",
				eventType: "payment.refunded",
				stripe: { amount: 13000 },
			},
		);
		expect(result.differences.find((d) => d.object === "net")).toBeDefined();
	});

	test("a refund Stripe does not have is missing_in_stripe", () => {
		const stripe = stripeSideOf(events);
		const result = run(events, { ...stripe, refunds: [] });
		expect(kinds(result.differences)).toEqual(["missing_in_stripe refund"]);
	});

	test("a payout missing from the log is missing_in_log", () => {
		const result = run(mutate("po_3", () => null));
		expect(result.differences).toHaveLength(1);
		expect(result.differences[0]).toMatchObject({
			kind: "missing_in_log",
			object: "payout",
			id: "po_3",
			eventType: "payout.paid",
		});
	});

	test("a payout amount off by a cent is amount_differs", () => {
		const result = run(
			mutate("po_3", (event) => ({
				...event,
				payload: {
					...event.payload,
					amount: (event.payload.amount as number) + 1,
				},
			})),
		);
		expect(kinds(result.differences)).toEqual(["amount_differs payout"]);
	});

	test("a fee changed in the log is amount_differs on the fees and the net", () => {
		const result = run(
			mutate(paymentId, (event) => ({
				...event,
				postings: event.postings.map((posting) =>
					posting.account === "expenses:billing:stripe-fees"
						? { ...posting, amount: "7.85" }
						: posting.account === "assets:stripe"
							? { ...posting, amount: "252.15" }
							: posting,
				),
			})),
		);
		expect(kinds(result.differences)).toEqual([
			"amount_differs fees",
			"amount_differs net",
		]);
		const fees = result.differences[0];
		expect(fees?.stripe?.amount).toBe((fees?.log?.amount ?? 0) - 1);
	});
});

describe("fees and payouts the log does not carry", () => {
	test("no fee postings is one fees record, not one per payment", () => {
		const bare = events.map((event) =>
			event.event_type === "payment.succeeded"
				? {
						...event,
						postings: [
							{
								account: "assets:stripe",
								amount: `${(event.payload.amount_paid as number) / 100}.00`,
								commodity: "USD",
							},
							...event.postings.filter((p) => p.account.startsWith("income:")),
						],
					}
				: event,
		);
		const result = run(bare);
		expect(result.differences).toHaveLength(1);
		expect(result.differences[0]).toMatchObject({
			kind: "not_in_log",
			object: "fees",
			id: null,
			stripe: { amount: 7146 },
			log: null,
		});
	});

	test("a log with no payout events is one payouts record", () => {
		const result = run(
			events.filter((event) => event.event_type !== "payout.paid"),
		);
		expect(result.differences).toHaveLength(1);
		expect(result.differences[0]).toMatchObject({
			kind: "not_in_log",
			object: "payout",
			stripe: { amount: 213854 },
		});
		expect(result.differences[0]?.message).toContain("11 payouts");
	});
});

describe("what is ignored", () => {
	test("test-mode objects are ignored in live mode, and counted", () => {
		const stripe = stripeSideOf(events);
		const result = run(events, {
			...stripe,
			invoices: [
				...stripe.invoices,
				{
					...(stripe.invoices[0] as (typeof stripe.invoices)[number]),
					id: "in_test_1",
					livemode: false,
				},
			],
			payouts: [
				...stripe.payouts,
				{
					...(stripe.payouts[0] as (typeof stripe.payouts)[number]),
					id: "po_test_1",
					livemode: false,
				},
			],
		});
		expect(result.differences).toEqual([]);
		expect(result.ignored).toEqual({ test_mode_object: 2 });
	});

	test("in test mode the live objects are the ones ignored", () => {
		const result = reconcile({
			events: [],
			timeZone: TZ,
			stripe: stripeSideOf(events),
			period: YEAR,
			mode: "test",
		});
		expect(result.ignored.live_mode_object).toBe(23);
		expect(result.counts.invoice.stripe).toBe(0);
	});

	test("an invoice that is not paid, or paid nothing, is ignored", () => {
		const stripe = stripeSideOf(events);
		const base = stripe.invoices[0] as (typeof stripe.invoices)[number];
		const result = run(events, {
			...stripe,
			invoices: [
				...stripe.invoices,
				{ ...base, id: "in_open", status: "open" },
				{ ...base, id: "in_void", status: "void" },
				{ ...base, id: "in_free", amount_paid: 0 },
			],
		});
		expect(result.differences).toEqual([]);
		expect(result.ignored).toEqual({
			invoice_not_paid: 2,
			invoice_nothing_paid: 1,
		});
	});

	test("a refund that failed moved no money and is ignored", () => {
		const stripe = stripeSideOf(events);
		const result = run(events, {
			...stripe,
			refunds: [
				...stripe.refunds,
				{
					id: "re_failed",
					amount: 500,
					currency: "usd",
					created: 1_790_000_000,
					status: "failed",
				},
			],
		});
		expect(result.differences).toEqual([]);
		expect(result.ignored).toEqual({ refund_not_succeeded: 1 });
	});

	test("a list left out is reported as not supplied and its checks do not run", () => {
		const {
			refunds: _refunds,
			balanceTransactions: _balances,
			...rest
		} = stripeSideOf(events);
		const result = run(events, rest);
		expect(result.notSupplied).toEqual(["refunds", "balanceTransactions"]);
		expect(result.differences).toEqual([]);
		expect(result.counts.refund.stripe).toBeNull();
	});
});

describe("the period, in the school's calendar", () => {
	const at = (id: string, instant: string) => payment({ id, instant });
	const invoice = (id: string, paidAt: string) => ({
		id,
		status: "paid",
		amount_paid: 13000,
		currency: "usd",
		created: Date.parse(paidAt) / 1000,
		status_transitions: { paid_at: Date.parse(paidAt) / 1000 },
	});
	const check = (log: AtmEvent[], paidAt: string, month: string) =>
		reconcile({
			events: log,
			stripe: { invoices: [invoice("in_edge", paidAt)] },
			period: { month },
			timeZone: TZ,
		});

	// Mountain standard time is UTC-7 in February: 06:59Z is 23:59 on the 28th, 07:00Z is midnight on the 1st.
	const LAST_MINUTE = "2026-02-28T23:59:00-07:00";
	const FIRST_MINUTE = "2026-03-01T00:00:00-07:00";

	test("an invoice paid at 23:59 on the last day is February's, not March's", () => {
		const log = [at("in_edge", LAST_MINUTE)];
		expect(log[0]?.date).toBe("2026-02-28");
		expect(check(log, LAST_MINUTE, "2026-02").differences).toEqual([]);
		const march = check(log, LAST_MINUTE, "2026-03");
		expect(march.differences).toEqual([]);
		expect(march.counts.invoice).toEqual({ stripe: 0, log: 0 });
	});

	test("an invoice paid a minute later is March's", () => {
		const log = [at("in_edge", FIRST_MINUTE)];
		expect(log[0]?.date).toBe("2026-03-01");
		expect(check(log, FIRST_MINUTE, "2026-03").differences).toEqual([]);
		expect(check(log, FIRST_MINUTE, "2026-02").counts.invoice).toEqual({
			stripe: 0,
			log: 0,
		});
	});

	test("a UTC reading would put 20:00 on the 28th in March; the school's zone keeps it in February", () => {
		const paidAt = "2026-03-01T03:00:00Z";
		const log = [at("in_edge", paidAt)];
		expect(log[0]?.date).toBe("2026-02-28");
		expect(check(log, paidAt, "2026-02").counts.invoice).toEqual({
			stripe: 1,
			log: 1,
		});
		expect(check(log, paidAt, "2026-02").differences).toEqual([]);
	});

	test("the log and Stripe on either side of midnight is period_differs in both months", () => {
		const log = [at("in_edge", LAST_MINUTE)];
		for (const month of ["2026-02", "2026-03"]) {
			const result = check(log, FIRST_MINUTE, month);
			expect(kinds(result.differences)).toEqual(["period_differs invoice"]);
			expect(result.differences[0]).toMatchObject({
				stripe: { date: "2026-03-01" },
				log: { date: "2026-02-28" },
			});
		}
	});

	test("a missing payment is reported only in the month it belongs to", () => {
		const february = check([], LAST_MINUTE, "2026-02");
		expect(kinds(february.differences)).toEqual(["missing_in_log invoice"]);
		expect(check([], LAST_MINUTE, "2026-03").differences).toEqual([]);
	});

	test("a time zone is needed when there are no events, and a bad one is refused", () => {
		const base = { events: [], stripe: {}, period: { month: "2026-02" } };
		expect(() => reconcile(base)).toThrow("pass timeZone");
		expect(() => reconcile({ ...base, timeZone: "Mars/Olympus" })).toThrow(
			"IANA",
		);
		expect(() =>
			reconcile({ ...base, timeZone: TZ, period: { month: "2026-13" } }),
		).toThrow("YYYY-MM");
		expect(() =>
			reconcile({
				...base,
				timeZone: TZ,
				period: { from: "2026-03-02", to: "2026-03-01" },
			}),
		).toThrow("on or before");
	});
});

describe("disputes", () => {
	const dispute = (
		type: "payment.disputed" | "dispute.closed",
		id: string,
		instant: string,
		extra: { amount: number; won?: boolean; status?: string },
	): AtmEvent =>
		ledgerEvent({
			type,
			school: SCHOOL,
			tz: TZ,
			eventTime: instant,
			key: "family:fam_edge",
			idem: `stripe:${id}:${type}`,
			amount: extra.amount,
			won: extra.won,
			payload: extra.status
				? { id, status: extra.status }
				: { id, amount: extra.amount },
		});
	const stripeDispute = (status: string) => ({
		id: "dp_1",
		amount: 5000,
		currency: "usd",
		created: Date.parse("2026-04-10T12:00:00Z") / 1000,
		status,
		livemode: true,
	});
	const opened = dispute("payment.disputed", "dp_1", "2026-04-10T12:00:00Z", {
		amount: 5000,
	});
	const check = (log: AtmEvent[], status: string) =>
		reconcile({
			events: log,
			stripe: { disputes: [stripeDispute(status)] },
			period: { month: "2026-04" },
			timeZone: TZ,
		});

	test("an open dispute in Stripe and in the log is clean", () => {
		expect(check([opened], "needs_response").differences).toEqual([]);
	});

	test("a lost dispute with the same outcome in the log is clean", () => {
		const closed = dispute("dispute.closed", "dp_1", "2026-05-02T12:00:00Z", {
			amount: 5000,
			status: "lost",
		});
		expect(check([opened, closed], "lost").differences).toEqual([]);
	});

	test("an outcome Stripe has and the log lacks is missing_in_log on dispute.closed", () => {
		const result = check([opened], "won");
		expect(result.differences).toHaveLength(1);
		expect(result.differences[0]).toMatchObject({
			kind: "missing_in_log",
			object: "dispute",
			eventType: "dispute.closed",
			id: "dp_1",
		});
	});

	test("won in the log and lost in Stripe is outcome_differs", () => {
		const closed = dispute("dispute.closed", "dp_1", "2026-05-02T12:00:00Z", {
			amount: 5000,
			won: true,
			status: "won",
		});
		const result = check([opened, closed], "lost");
		expect(result.differences).toHaveLength(1);
		expect(result.differences[0]).toMatchObject({
			kind: "outcome_differs",
			stripe: { status: "lost" },
			log: { status: "won" },
		});
	});

	test("closed in the log while Stripe still has it open is outcome_differs", () => {
		const closed = dispute("dispute.closed", "dp_1", "2026-04-20T12:00:00Z", {
			amount: 5000,
			status: "lost",
		});
		expect(kinds(check([opened, closed], "under_review").differences)).toEqual([
			"outcome_differs dispute",
		]);
	});

	test("an amount that differs is amount_differs", () => {
		const smaller = dispute(
			"payment.disputed",
			"dp_1",
			"2026-04-10T12:00:00Z",
			{ amount: 4999 },
		);
		expect(kinds(check([smaller], "needs_response").differences)).toEqual([
			"amount_differs dispute",
		]);
	});

	test("an inquiry with no money moved is ignored", () => {
		const result = check([], "warning_needs_response");
		expect(result.differences).toEqual([]);
		expect(result.ignored).toEqual({ dispute_no_money_moved: 1 });
	});

	test("Stripe's dispute fee, which atm does not book, shows in the fees and the net", () => {
		const log = [
			payment({ id: "in_apr", instant: "2026-04-02T12:00:00Z", fee: 429 }),
			opened,
		];
		const stripe = stripeSideOf(log, { disputeFee: 1500 });
		const result = reconcile({
			events: log,
			stripe,
			period: { month: "2026-04" },
		});
		expect(kinds(result.differences)).toEqual([
			"amount_differs fees",
			"amount_differs net",
		]);
		expect(result.differences[0]).toMatchObject({
			stripe: { amount: 1929 },
			log: { amount: 429 },
		});
		expect(result.differences[1]?.stripeNetByType).toEqual({
			charge: 12571,
			adjustment: -6500,
		});
	});

	test("with no fee postings at all the dispute fee is one fees record and the net still ties", () => {
		const stripe = stripeSideOf([opened], { disputeFee: 1500 });
		const result = reconcile({
			events: [opened],
			stripe,
			period: { month: "2026-04" },
		});
		expect(kinds(result.differences)).toEqual(["not_in_log fees"]);
	});
});
