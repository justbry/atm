/**
 * A `late-*` batch landing after month end. January's payments are delivered, shipped and combined into each day's
 * `day.jsonl` as the log's combiner does; then an endpoint outage ends and Stripe delivers events dated in January (an
 * invoice paid on the 15th, a refund made on the 20th) in February. The shipper cannot put a batch beside a combined day
 * (it refuses, `ship.ts`), so the rows ship as `late-*` files, and the reader keeps `day.jsonl` plus `late-*`
 * (`listEventFiles`): January's journal, reports and reconcile hold them.
 *
 * Every number is written by hand from the price list, none read from the handler, the log or a report. The price list
 * (fixtures/billing/grants/menu.json, USD cents): sparkle-2 26,000 a month and 2 visits; sparkle-1 13,000 and 1 visit.
 * Stripe's fee is 2.9% + 30 cents, rounded: 784 on 26,000 and 407 on 13,000.
 */
import {
	DAY,
	HOUR,
	invoice,
	JAN15,
	link,
	ms,
	refundOf,
	tierLine,
} from "../e2e-events.js";
import {
	type Case,
	type Step,
	stripeBalance,
	stripeInvoice,
	stripeRefund,
} from "../e2e-matrix.js";
import { FAMILY, SCHOOL } from "../handler-harness.js";
import type { RawEvent } from "../stripe-events.js";

const SPARKLE_2 = 26_000;
const SPARKLE_1 = 13_000;
const FEE_26 = 784;
const FEE_13 = 407;
const REFUND = 3000;
const SECOND = 1000;
const OTHER_FAMILY = "fam_b2";
const THIRD_FAMILY = "fam_c3";
const PAID_FIRST = ms(JAN15);
const PAID_LATE = ms("2026-01-15T22:00:00Z");
const PAID_THIRD = ms("2026-01-20T18:00:00Z");
const REFUNDED_AT = ms("2026-01-20T19:00:00Z");
const MONTH_END = ms("2026-01-31T23:00:00Z");
const COMBINED_AT = ms("2026-02-01T03:00:00Z");
const DELIVERED_LATE = ms("2026-02-03T10:00:00Z");

const stamp = (atMs: number): string =>
	`${new Date(atMs).toISOString().slice(0, 19)}Z`;

const applied = (at: number, event: RawEvent): Step => ({
	at,
	event,
	answer: [200, "applied"],
});

const charge = (invoiceId: string, gross: number, fee: number, atMs: number) =>
	stripeBalance(`txn_${invoiceId}`, "charge", gross, fee, stamp(atMs));

const firstInvoice = (): RawEvent =>
	invoice({
		id: "in_1",
		at: PAID_FIRST,
		end: PAID_FIRST + 31 * DAY,
		lines: [tierLine("sparkle-2", { amount: SPARKLE_2 })],
	});

const thirdInvoice = (): RawEvent =>
	invoice({
		id: "in_2",
		at: PAID_THIRD,
		subscription: "sub_3",
		family: THIRD_FAMILY,
		lines: [tierLine("sparkle-1", { amount: SPARKLE_1 })],
	});

/** Paid on 15 January at 22:00 UTC by a second family, and delivered on 3 February. */
const lateInvoice = (): RawEvent =>
	invoice({
		id: "in_late",
		at: PAID_LATE,
		subscription: "sub_2",
		family: OTHER_FAMILY,
		lines: [tierLine("sparkle-2", { amount: SPARKLE_2 })],
	});

const lateRefund = (): RawEvent =>
	refundOf({
		id: "evt_re_late",
		invoiceId: "in_2",
		amount: REFUND,
		charged: SPARKLE_1,
		at: REFUNDED_AT,
	});

export const CASES: Case[] = [
	{
		id: "late-events",
		title:
			"January events delivered in February land as late-* beside the combined days",
		path: "ship; combine day.jsonl; invoice.paid and charge.refunded dated January, delivered in February; ship late-*",
		fees: { in_1: FEE_26, in_2: FEE_13, in_late: FEE_26 },
		steps: [
			applied(PAID_FIRST, firstInvoice()),
			applied(PAID_FIRST + SECOND, link("in_1", PAID_FIRST + SECOND)),
			applied(PAID_THIRD, thirdInvoice()),
			applied(PAID_THIRD + SECOND, link("in_2", PAID_THIRD + SECOND)),
			// month end: the shipper writes one batch per day, then the combiner turns each day into day.jsonl
			{ kind: "ship", at: MONTH_END },
			{ kind: "combine", at: COMBINED_AT, date: "2026-01-15" },
			{ kind: "combine", at: COMBINED_AT, date: "2026-01-20" },
			// January is closed: its journal is built before the late events land, and must be rebuilt once they have
			{ kind: "journal", at: COMBINED_AT, month: "2026-01" },
			// February: the delayed events arrive and are applied; their rows are dated in January
			applied(DELIVERED_LATE, lateInvoice()),
			applied(DELIVERED_LATE + SECOND, link("in_late", PAID_LATE + SECOND)),
			applied(DELIVERED_LATE + 2 * SECOND, lateRefund()),
			// the combined days take only late-* files
			{ kind: "ship", at: DELIVERED_LATE + HOUR, late: true },
		],
		verdict: "OK",
		books: [
			{
				school: SCHOOL,
				// With the late events January is 3 payments, 1 refund: income 26,000 + 26,000 + 13,000 = 65,000; fees
				// 784 + 784 + 407 = 1,975; refunds 3,000; Stripe's balance and net 65,000 - 3,000 - 1,975 = 60,025.
				// Without them (the books as closed on 1 February) it is 39,000 income, 1,191 fees, 37,809 net: the late
				// events add 26,000 income, 784 fee, 3,000 refund = 22,216 net, which is 60,025 - 37,809.
				// Credits: 2 visits for the first family, 2 for the second, 1 for the third.
				hand: {
					"income:membership:sparkle-2": 52_000,
					"income:membership:sparkle-1": 13_000,
					refunds: 3000,
					fees: 1975,
					stripe: 60_025,
					net: 60_025,
					[`avail:family:${FAMILY}:visit`]: 2,
					[`avail:family:${OTHER_FAMILY}:visit`]: 2,
					[`avail:family:${THIRD_FAMILY}:visit`]: 1,
				},
				// Stripe's side already holds the late invoice and refund, as it always did: January is clean only
				// because the final log has the late-* files too (without them reconcile would print missing_in_log
				// invoice in_late, and the fee and net totals)
				stripe: {
					invoices: [
						stripeInvoice("in_1", SPARKLE_2, JAN15),
						stripeInvoice("in_late", SPARKLE_2, stamp(PAID_LATE)),
						stripeInvoice("in_2", SPARKLE_1, stamp(PAID_THIRD)),
					],
					refunds: [
						stripeRefund("re_late", REFUND, stamp(REFUNDED_AT), "in_2"),
					],
					disputes: [],
					payouts: [],
					balanceTransactions: [
						charge("in_1", SPARKLE_2, FEE_26, PAID_FIRST),
						charge("in_late", SPARKLE_2, FEE_26, PAID_LATE),
						charge("in_2", SPARKLE_1, FEE_13, PAID_THIRD),
						stripeBalance(
							"txn_re_late",
							"refund",
							-REFUND,
							0,
							stamp(REFUNDED_AT),
						),
					],
				},
				reconcile: { "2026-01": [] },
			},
		],
		notes: [
			"The runner journals and reconciles once, after every step, so January's books here are the final ones (day.jsonl plus late-*); the 'as closed' numbers are in the hand comment only.",
			"Without the late events: income 26,000 + 13,000 = 39,000; fees 784 + 407 = 1,191; net 39,000 - 1,191 = 37,809. With them: +26,000 income, +784 fee, -3,000 refund = +22,216: 60,025.",
			"The late refund is of the third family's 130.00 payment (13,000), partial, so no credits are taken back.",
		],
	},
];
