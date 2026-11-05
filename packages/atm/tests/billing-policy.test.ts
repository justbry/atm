import { describe, expect, test } from "bun:test";
import {
	commandOrg,
	DEFAULT_POLICY,
	resolvePolicy,
} from "../src/billing/policy.js";

describe("resolvePolicy", () => {
	test("defaults are the spec table", () => {
		expect(DEFAULT_POLICY).toEqual({
			v: 1,
			upgradeGrant: "prorated",
			removeOnFullRefund: true,
			removeOnLostDispute: true,
			giftSessionMonths: 6,
			giftDollarMinimum: 2500,
			giftDollarMonths: 12,
			memberCode: { code: "MEMBER15", percentOff: 15 },
			deductionOrder: "expiry",
			lowCreditThreshold: 2,
			cancelCutoffHours: 24,
			noShow: "spend",
			lateCancel: "spend",
		});
	});

	test("the deduction order is expiry or engine, nothing else", () => {
		expect(resolvePolicy({ deductionOrder: "engine" }).deductionOrder).toBe(
			"engine",
		);
		expect(() => resolvePolicy({ deductionOrder: "newest" })).toThrow(
			/deductionOrder/,
		);
	});

	test("commandOrg carries the policy's order and the family service's fixed settings", () => {
		expect(commandOrg(DEFAULT_POLICY).config).toEqual({
			reverse_deduction_order: false,
			block_overdue_entitlements: false,
			include_past_due: true,
			deduction_order: "expiry",
		});
		expect(
			commandOrg(resolvePolicy({ deductionOrder: "engine" })).config
				.deduction_order,
		).toBe("engine");
	});

	test("commandOrg falls back to the default for a stored policy that predates the field", () => {
		const { deductionOrder: _removed, ...stored } = DEFAULT_POLICY;
		expect(
			commandOrg(stored as unknown as typeof DEFAULT_POLICY).config
				.deduction_order,
		).toBe("expiry");
	});

	test("nothing or an empty object gives the defaults, as a copy", () => {
		expect(resolvePolicy(undefined)).toEqual(DEFAULT_POLICY);
		expect(resolvePolicy(null)).toEqual(DEFAULT_POLICY);
		const p = resolvePolicy({});
		expect(p).toEqual(DEFAULT_POLICY);
		p.giftSessionMonths = 1;
		expect(DEFAULT_POLICY.giftSessionMonths).toBe(6);
	});

	test("an override replaces only what it names", () => {
		const p = resolvePolicy({ upgradeGrant: "full", giftSessionMonths: 3 });
		expect(p).toEqual({
			...DEFAULT_POLICY,
			upgradeGrant: "full",
			giftSessionMonths: 3,
		});
	});

	test("the member code can be renamed or turned off", () => {
		expect(
			resolvePolicy({ memberCode: { code: "FRIEND10", percentOff: 10 } })
				.memberCode,
		).toEqual({
			code: "FRIEND10",
			percentOff: 10,
		});
		expect(resolvePolicy({ memberCode: null }).memberCode).toBeNull();
	});

	test("an unknown key is refused", () => {
		expect(() => resolvePolicy({ upgradeGrnt: "full" })).toThrow(
			/policy is invalid/,
		);
		expect(() =>
			resolvePolicy({ memberCode: { code: "AB", percentOff: 5, extra: 1 } }),
		).toThrow();
	});

	test("cycleFromPeriodStart is gone: the engine always anchors on the period start, so naming it is refused", () => {
		expect(() => resolvePolicy({ cycleFromPeriodStart: false })).toThrow(
			/cycleFromPeriodStart/,
		);
		expect("cycleFromPeriodStart" in DEFAULT_POLICY).toBe(false);
	});

	test("a wrong value is refused", () => {
		expect(() => resolvePolicy({ upgradeGrant: "sometimes" })).toThrow();
		expect(() => resolvePolicy({ giftSessionMonths: 0 })).toThrow();
		expect(() => resolvePolicy({ removeOnFullRefund: "yes" })).toThrow();
		expect(() =>
			resolvePolicy({ memberCode: { code: "X", percentOff: 150 } }),
		).toThrow();
		expect(() => resolvePolicy("full")).toThrow();
	});
});
