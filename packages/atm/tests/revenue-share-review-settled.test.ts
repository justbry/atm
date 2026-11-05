/**
 * A share event carries its amount twice: in the payload (cents) and as the posting to `liabilities:b4uni`. The books read
 * the posting, so the statement reads it too, and `validateEvent` refuses an event whose two numbers differ.
 */
import { expect, test } from "bun:test";
import { ledgerEvent } from "../src/ledger/postings.js";
import { shareStatement } from "../src/ledger/share-statement.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent } from "../src/types.js";
import {
	invoiceRefund,
	membershipInvoice,
	ofType,
	SCHOOL,
	withShare,
	world,
} from "./revenue-share-world.js";

const settle = (amount: number, payloadAmount: number): AtmEvent =>
	ledgerEvent({
		type: "share.settled",
		school: SCHOOL,
		tz: "America/Denver",
		eventTime: Date.parse("2026-01-20T18:00:00Z"),
		key: "b4uni",
		idem: "settle:wire-1",
		amount,
		payload: { amount: payloadAmount },
	});

test("a share.settled whose payload.amount differs from its posting does not validate", () => {
	const { errors } = validateEvent(settle(2600, 260));
	expect(errors.map((e) => e.path)).toEqual(["/payload/amount"]);
	expect(errors[0]?.message).toContain(
		"differs from the liabilities:b4uni posting",
	);
	expect(validateEvent(settle(2600, 2600)).errors).toEqual([]);
});

test("a share.accrued or share.reversed whose payload differs from its posting does not validate", () => {
	const s = world({ policy: withShare(10) });
	s.handle(membershipInvoice());
	s.handle(invoiceRefund({ eventId: "evt_r", refundedTotal: 13_000 }));
	const accrued = ofType(s.events, "share.accrued")[0] as AtmEvent;
	const reversed = ofType(s.events, "share.reversed")[0] as AtmEvent;
	expect(validateEvent(accrued).errors).toEqual([]);
	expect(validateEvent(reversed).errors).toEqual([]);
	const wrongAccrued = {
		...accrued,
		payload: { ...accrued.payload, share: 1 },
	};
	const wrongReversed = {
		...reversed,
		payload: { ...reversed.payload, reversed: 1 },
	};
	expect(validateEvent(wrongAccrued).errors.map((e) => e.path)).toEqual([
		"/payload/share",
	]);
	expect(validateEvent(wrongReversed).errors.map((e) => e.path)).toEqual([
		"/payload/reversed",
	]);
});

test("the statement reads the settled amount from the posting, so it ties to the liability account", () => {
	const s = world({ policy: withShare(10) }); // 2600 owed on 26000
	s.handle(membershipInvoice());
	// the posting says 2600, the payload 260: the books hold 0 owed
	const settled = settle(2600, 260);
	const st = shareStatement({
		events: [...s.events, settled],
		school: SCHOOL,
		month: "2026-01",
	});
	expect(st.totals.settled).toBe(2600);
	expect(st.balanceOwed).toBe(0);
	expect(st.totals.owed).toBe(st.balanceOwed);
});
