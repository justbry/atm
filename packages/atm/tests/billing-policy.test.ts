import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, resolvePolicy } from "../src/billing/policy.js";

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
		});
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
