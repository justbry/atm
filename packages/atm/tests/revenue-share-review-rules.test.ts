/**
 * The rate rules against every two-decimal percent: a plain JSON Schema validator and `resolvePolicy` agree on the
 * valid ones, and `resolvePolicy` alone refuses a third decimal.
 */
import { expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import policySchema from "../schema/catalog/policy.v1.json";
import { DEFAULT_POLICY, resolvePolicy } from "../src/billing/policy.js";
import { hundredthsOf, rateOf } from "../src/billing/share.js";

const percents: string[] = [];
for (let hundredths = 0; hundredths <= 10_000; hundredths++)
	percents.push(
		`${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`,
	);

test("a plain Ajv (no multipleOfPrecision) accepts every two-decimal percent", () => {
	const validate = new Ajv2020({ strict: false }).compile(policySchema);
	const rejected = percents.filter(
		(text) => !validate({ revenueShare: { percent: Number.parseFloat(text) } }),
	);
	expect(rejected).toEqual([]);
});

test("the schema still bounds the rate to 0..100 for every validator", () => {
	const validate = new Ajv2020({ strict: false }).compile(policySchema);
	for (const percent of [-0.01, -5, 100.01, 101, Number.NaN])
		expect(validate({ revenueShare: { percent } })).toBe(false);
});

test("resolvePolicy accepts every two-decimal percent and keeps it", () => {
	const bad: string[] = [];
	for (const text of percents) {
		const percent = Number.parseFloat(text);
		try {
			if (
				resolvePolicy({ revenueShare: { percent } }).revenueShare?.percent !==
				percent
			)
				bad.push(text);
		} catch {
			bad.push(text);
		}
	}
	expect(bad).toEqual([]);
});

test("resolvePolicy refuses three decimals, negatives, more than 100 and NaN", () => {
	for (const percent of [
		2.555,
		0.001,
		99.999,
		-0.01,
		-5,
		100.01,
		150,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])
		expect(() => resolvePolicy({ revenueShare: { percent } })).toThrow(
			/revenueShare\/percent/,
		);
	expect(resolvePolicy({ revenueShare: null }).revenueShare).toBeNull();
	expect(resolvePolicy({}).revenueShare).toBeNull();
});

test("hundredthsOf and rateOf: every invalid value is no share, valid ones are normalized", () => {
	for (const percent of [
		2.555,
		100.01,
		150,
		-5,
		-0.01,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		"2.5",
		null,
	])
		expect(hundredthsOf(percent)).toBeNull();
	for (const percent of [
		2.555,
		100.01,
		-5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		0,
	])
		expect(rateOf({ ...DEFAULT_POLICY, revenueShare: { percent } })).toBeNull();
	expect(rateOf({ ...DEFAULT_POLICY, revenueShare: null })).toBeNull();
	expect(
		rateOf({ ...DEFAULT_POLICY, revenueShare: { percent: 2.5000000001 } }),
	).toBe(2.5);
	expect(rateOf({ ...DEFAULT_POLICY, revenueShare: { percent: 100 } })).toBe(
		100,
	);
	for (const [hundredths, text] of percents.entries())
		expect(hundredthsOf(Number.parseFloat(text))).toBe(hundredths);
});
