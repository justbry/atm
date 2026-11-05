/**
 * A policy that skipped `resolvePolicy` and carries an unusable rate, through the real handler: the family's credits are
 * still granted and the payment still booked, and no share is made, whichever way the rate is wrong. A rate within floating
 * point noise of two decimals is booked at the normalized rate.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import type { BillingPolicy } from "../src/billing/types.js";
import {
	formatShareStatement,
	shareStatement,
} from "../src/ledger/share-statement.js";
import {
	invoiceRefund,
	membershipInvoice,
	ofType,
	SCHOOL,
	world,
} from "./revenue-share-world.js";

const policy = (percent: number): BillingPolicy => ({
	...DEFAULT_POLICY,
	revenueShare: { percent },
});

const BAD_RATES = [
	2.555,
	0.001,
	100.01,
	150,
	-5,
	-0.01,
	Number.NaN,
	Number.POSITIVE_INFINITY,
];

test("an invalid rate never blocks an invoice: credits granted, payment booked, no share", () => {
	for (const percent of BAD_RATES) {
		const s = world({ policy: policy(percent) });
		const r = s.handle(membershipInvoice());
		expect(r.refused).toBeUndefined();
		expect(s.rows.length).toBeGreaterThan(0);
		expect(ofType(r.events, "payment.succeeded")).toHaveLength(1);
		expect(ofType(r.events, "share.accrued")).toHaveLength(0);
		// and its refund is booked with nothing to reverse
		const refund = s.handle(
			invoiceRefund({ eventId: "evt_r", refundedTotal: 1000 }),
		);
		expect(refund.refused).toBeUndefined();
		expect(ofType(refund.events, "payment.refunded")).toHaveLength(1);
		expect(ofType(refund.events, "share.reversed")).toHaveLength(0);
	}
});

test("an invalid rate never blocks a booking: the payment is booked, no share", () => {
	const dir = `${import.meta.dir}/../fixtures/billing/stripe/recorded/booking`;
	const completed = JSON.parse(
		readFileSync(`${dir}/checkout.session.completed.json`, "utf8"),
	);
	for (const percent of BAD_RATES) {
		const s = world({ school: "sch_demo", policy: policy(percent) });
		const r = s.handle(completed);
		expect(r.refused).toBeUndefined();
		expect(ofType(r.events, "payment.succeeded")).toHaveLength(1);
		expect(ofType(r.events, "share.accrued")).toHaveLength(0);
	}
});

test("a rate within floating point noise of two decimals is booked and shown at the normalized rate", () => {
	const s = world({ policy: policy(2.5000000001) });
	const share = ofType(
		s.handle(membershipInvoice()).events,
		"share.accrued",
	)[0];
	expect(share?.payload.share).toBe(650);
	expect(share?.payload.percent).toBe(2.5);
	expect(share?.text).toContain("(2.5% of");
	expect(share?.text).not.toContain("2.5000000001");
	const statement = shareStatement({
		events: s.events,
		school: SCHOOL,
		month: "2026-01",
	});
	expect(formatShareStatement(statement)).not.toContain("2.5000000001");
	expect(statement.rows[0]?.percent).toBe(2.5);
});
