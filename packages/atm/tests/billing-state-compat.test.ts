import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	EMPTY_GRANTS_STATE,
	invoiceToCommands,
} from "../src/billing/grants.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { grantsFromRows, grantsRow } from "../src/billing/rows.js";
import type {
	BillingInvoice,
	BookingRecord,
	GrantsState,
	Menu,
	RedeemedCode,
} from "../src/billing/types.js";

const dir = `${import.meta.dir}/../fixtures/billing/grants`;
const load = <T>(name: string): T =>
	JSON.parse(readFileSync(`${dir}/${name}.json`, "utf8")) as T;

const booking: BookingRecord = {
	state: "spent",
	cost: { kind: "credits", featureId: "visit", credits: 1 },
	startsAt: 1_000,
	expiresAt: 2_000,
	settledAt: 3_000,
	settledBy: "confirm",
};
const redeemed: RedeemedCode = {
	codeId: "gift_1",
	feature: "visit",
	credits: 2,
	at: 5_000,
	rowId: "ce_gift_visit_gift_1",
	expiresAt: null,
};

describe("the grants state keeps 0.6.0's shape", () => {
	test("a state stored before bookings and gift codes loads without either key", () => {
		const stored = grantsRow(EMPTY_GRANTS_STATE);
		const state = grantsFromRows([stored]);
		expect(Object.hasOwn(state, "bookings")).toBe(false);
		expect(Object.hasOwn(state, "redeemed")).toBe(false);
		expect(JSON.stringify(state)).toBe(JSON.stringify(EMPTY_GRANTS_STATE));
	});

	test("a rule that does not touch bookings adds no key to a state that has none", () => {
		const menu = load<Menu>("menu");
		const invoice = load<BillingInvoice>("inv-create-s2");
		const result = invoiceToCommands({
			invoice,
			menu,
			policy: DEFAULT_POLICY,
			state: EMPTY_GRANTS_STATE,
			now: invoice.paidAt,
			menuVersion: 1,
			policyVersion: 1,
		});
		expect(Object.hasOwn(result.state, "bookings")).toBe(false);
		expect(Object.hasOwn(result.state, "redeemed")).toBe(false);
	});

	test("bookings and redeemed codes survive a state round trip and an invoice", () => {
		const menu = load<Menu>("menu");
		const invoice = load<BillingInvoice>("inv-create-s2");
		const state: GrantsState = {
			...EMPTY_GRANTS_STATE,
			bookings: { bk_1: booking },
			redeemed: { gift_1: redeemed },
		};
		const loaded = grantsFromRows([grantsRow(state)]);
		expect(loaded.bookings).toEqual({ bk_1: booking });
		expect(loaded.redeemed).toEqual({ gift_1: redeemed });
		const result = invoiceToCommands({
			invoice,
			menu,
			policy: DEFAULT_POLICY,
			state: loaded,
			now: invoice.paidAt,
			menuVersion: 1,
			policyVersion: 1,
		});
		expect(result.state.bookings).toEqual({ bk_1: booking });
		expect(result.state.redeemed).toEqual({ gift_1: redeemed });
	});
});
