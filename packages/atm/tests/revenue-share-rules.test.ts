/**
 * The revenue share's two rules, `shareOf` (what a payment owes) and `shareAfterRefund` (what is left after refunds),
 * worked by hand at the rounding edges and checked over many generated cases against a second way of computing them.
 * The generator is a fixed-seed linear congruential one, so every run draws the same cases.
 */
import { describe, expect, test } from "bun:test";
import {
	percentToHundredths,
	shareAfterRefund,
	shareOf,
} from "../src/billing/share.js";

/** A small deterministic generator: the same sequence every run. */
const sequence = (seed: number) => {
	let state = seed;
	return (below: number): number => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state % below;
	};
};

/** Round half up of `numerator / denominator` for whole numbers small enough to be exact in a double. */
const roundHalfUp = (numerator: number, denominator: number): number =>
	Math.floor((2 * numerator + denominator) / (2 * denominator));

describe("shareOf: round half up in whole cents", () => {
	test("hand-worked values at the half-cent edges", () => {
		// 50% of 1 cent is 0.5 cents: half rounds up
		expect(shareOf(1, 50)).toBe(1);
		// 50% of 3 cents is 1.5: 2
		expect(shareOf(3, 50)).toBe(2);
		// 2.5% of 10 cents is 0.25: 0; of 20 is 0.5: 1; of 60 is 1.5: 2; of 59 is 1.475: 1
		expect(shareOf(10, 2.5)).toBe(0);
		expect(shareOf(20, 2.5)).toBe(1);
		expect(shareOf(60, 2.5)).toBe(2);
		expect(shareOf(59, 2.5)).toBe(1);
		// 2.5% of 26000 is exactly 650
		expect(shareOf(26_000, 2.5)).toBe(650);
		// 3.33% of 26000 is 865.8: 866
		expect(shareOf(26_000, 3.33)).toBe(866);
	});

	test("0.01 percent: 4999 cents owe 0.4999 cents (0), 5000 owe 0.5 (1), 10000 owe 1", () => {
		expect(shareOf(4999, 0.01)).toBe(0);
		expect(shareOf(5000, 0.01)).toBe(1);
		expect(shareOf(10_000, 0.01)).toBe(1);
		expect(shareOf(14_999, 0.01)).toBe(1);
		expect(shareOf(15_000, 0.01)).toBe(2);
	});

	test("100 percent is everything collected, and 0 percent or no rate is nothing", () => {
		for (const collected of [0, 1, 2, 99, 26_000, 123_456_789])
			expect(shareOf(collected, 100)).toBe(collected);
		for (const collected of [0, 1, 26_000]) {
			expect(shareOf(collected, 0)).toBe(0);
			expect(shareOf(collected, null)).toBe(0);
		}
	});

	test("tiny amounts: a cent or two at a small rate owe nothing, at a large rate they round up", () => {
		expect(shareOf(1, 10)).toBe(0);
		expect(shareOf(1, 49.99)).toBe(0);
		expect(shareOf(1, 50)).toBe(1);
		expect(shareOf(1, 100)).toBe(1);
		expect(shareOf(2, 25)).toBe(1);
		expect(shareOf(2, 24.99)).toBe(0);
	});

	test("rates that are floating point traps come out exact: 1.1, 0.07, 8.2, 4.35 and 0.29 percent", () => {
		// 1.1 * 100 is 110.00000000000001 and 4.35 * 100 is 434.99999999999994 as doubles
		expect(shareOf(1000, 1.1)).toBe(11);
		expect(shareOf(10_000, 0.07)).toBe(7);
		expect(shareOf(50_000, 8.2)).toBe(4100);
		expect(shareOf(20_000, 4.35)).toBe(870);
		expect(shareOf(10_000, 0.29)).toBe(29);
		expect(percentToHundredths(4.35)).toBe(435);
		expect(percentToHundredths(0.29)).toBe(29);
		expect(percentToHundredths(1.1)).toBe(110);
	});

	test("a rate with a third decimal, below 0, above 100 or not a number is refused, not rounded", () => {
		for (const bad of [2.555, 0.001, -0.01, 100.01, Number.NaN, Infinity])
			expect(() => shareOf(1000, bad)).toThrow(RangeError);
		expect(() => shareOf(10.5, 5)).toThrow(RangeError);
		expect(() => shareOf(-1, 5)).toThrow(RangeError);
	});

	test("over generated amounts and rates: equals the exact rounding, never above collected, never negative", () => {
		const draw = sequence(7);
		for (let trial = 0; trial < 5000; trial += 1) {
			const collected = draw(2_000_000);
			const hundredths = draw(10_001);
			const share = shareOf(collected, hundredths / 100);
			expect(share).toBe(roundHalfUp(collected * hundredths, 10_000));
			expect(share).toBeGreaterThanOrEqual(0);
			expect(share).toBeLessThanOrEqual(collected);
		}
	});

	test("does not fall as the amount collected rises, and does not fall as the rate rises", () => {
		for (const hundredths of [1, 7, 250, 333, 5000, 9999, 10_000]) {
			let last = 0;
			for (let collected = 0; collected <= 3000; collected += 1) {
				const share = shareOf(collected, hundredths / 100);
				expect(share).toBeGreaterThanOrEqual(last);
				last = share;
			}
		}
		for (const collected of [1, 99, 26_000]) {
			let last = 0;
			for (let hundredths = 0; hundredths <= 10_000; hundredths += 1) {
				const share = shareOf(collected, hundredths / 100);
				expect(share).toBeGreaterThanOrEqual(last);
				last = share;
			}
		}
	});

	test("a large payment is exact where a double product would not be: 90 trillion cents at 99.99 percent", () => {
		const collected = 90_000_000_000_000;
		// 9e13 x 9999 = 8.9991e17, beyond 2^53 as a double; the exact share is 8.9991e13
		expect(shareOf(collected, 99.99)).toBe(89_991_000_000_000);
	});
});

describe("shareAfterRefund: the share left, from the running total refunded", () => {
	test("hand-worked: a share of 866 on 26000 after 5000, 15000 and all of it", () => {
		const base = { share: 866, collected: 26_000 };
		// 866 x 5000 / 26000 = 166.5: 167 reversed
		expect(shareAfterRefund({ ...base, refundedTotal: 5000 })).toBe(866 - 167);
		// 866 x 15000 / 26000 = 499.6: 500 reversed
		expect(shareAfterRefund({ ...base, refundedTotal: 15_000 })).toBe(
			866 - 500,
		);
		expect(shareAfterRefund({ ...base, refundedTotal: 26_000 })).toBe(0);
	});

	test("nothing refunded leaves the share, a refund of everything leaves exactly 0, and so does one larger than the payment", () => {
		for (const [share, collected] of [
			[1, 1],
			[1, 3],
			[866, 26_000],
			[650, 26_000],
			[3, 7],
		] as const) {
			expect(shareAfterRefund({ share, collected, refundedTotal: 0 })).toBe(
				share,
			);
			expect(
				shareAfterRefund({ share, collected, refundedTotal: collected }),
			).toBe(0);
			expect(
				shareAfterRefund({ share, collected, refundedTotal: collected + 1 }),
			).toBe(0);
			expect(
				shareAfterRefund({ share, collected, refundedTotal: 10 * collected }),
			).toBe(0);
			// a negative total (nothing a refund can be) leaves the share
			expect(shareAfterRefund({ share, collected, refundedTotal: -5 })).toBe(
				share,
			);
		}
	});

	test("rounds half up: a share of 1 on 2 cents loses its cent at the first cent refunded, a share of 3 on 4 cents is 2 left after 1", () => {
		// 1 x 1 / 2 = 0.5: reversed 1
		expect(shareAfterRefund({ share: 1, collected: 2, refundedTotal: 1 })).toBe(
			0,
		);
		// 3 x 1 / 4 = 0.75: reversed 1
		expect(shareAfterRefund({ share: 3, collected: 4, refundedTotal: 1 })).toBe(
			2,
		);
		// 1 x 1 / 3 = 0.33: reversed 0
		expect(shareAfterRefund({ share: 1, collected: 3, refundedTotal: 1 })).toBe(
			1,
		);
	});

	test("no share or nothing collected is left as it is", () => {
		expect(
			shareAfterRefund({ share: 0, collected: 100, refundedTotal: 50 }),
		).toBe(0);
		expect(shareAfterRefund({ share: 0, collected: 0, refundedTotal: 0 })).toBe(
			0,
		);
	});

	test("over every refunded total of generated payments: never rises, stays within 0 and the share, and equals the exact rounding", () => {
		const draw = sequence(11);
		for (let trial = 0; trial < 300; trial += 1) {
			const collected = 1 + draw(3000);
			const share = shareOf(collected, draw(10_001) / 100);
			let last = share;
			for (let refunded = 0; refunded <= collected; refunded += 1) {
				const left = shareAfterRefund({
					share,
					collected,
					refundedTotal: refunded,
				});
				expect(left).toBe(share - roundHalfUp(share * refunded, collected));
				expect(left).toBeLessThanOrEqual(last);
				expect(left).toBeGreaterThanOrEqual(0);
				last = left;
			}
			expect(last).toBe(0);
		}
	});

	test("many partial refunds: what each takes back adds up to exactly the share, however they are cut", () => {
		const draw = sequence(13);
		for (let trial = 0; trial < 400; trial += 1) {
			const collected = 1 + draw(200_000);
			const share = shareOf(collected, draw(10_001) / 100);
			let refunded = 0;
			let left = share;
			let reversedSum = 0;
			// up to 40 partial refunds of random size, then whatever is left of the payment
			for (let refund = 0; refund < 40 && refunded < collected; refund += 1) {
				refunded = Math.min(collected, refunded + 1 + draw(collected));
				const next = shareAfterRefund({
					share,
					collected,
					refundedTotal: refunded,
				});
				const reversed = left - next;
				expect(reversed).toBeGreaterThanOrEqual(0);
				reversedSum += reversed;
				left = next;
			}
			const last = shareAfterRefund({
				share,
				collected,
				refundedTotal: collected,
			});
			reversedSum += left - last;
			expect(reversedSum).toBe(share);
		}
	});

	test("a hundred refunds of one cent each of a 100 cent payment reverse a share of 33 to the cent, with no drift", () => {
		const share = shareOf(100, 33);
		expect(share).toBe(33);
		let left = share;
		let reversedSum = 0;
		for (let refunded = 1; refunded <= 100; refunded += 1) {
			const next = shareAfterRefund({
				share,
				collected: 100,
				refundedTotal: refunded,
			});
			reversedSum += left - next;
			left = next;
		}
		expect(left).toBe(0);
		expect(reversedSum).toBe(33);
	});

	test("a share or an amount that is not whole cents is refused", () => {
		expect(() =>
			shareAfterRefund({ share: 1.5, collected: 10, refundedTotal: 1 }),
		).toThrow(RangeError);
		expect(() =>
			shareAfterRefund({ share: 1, collected: -10, refundedTotal: 1 }),
		).toThrow(RangeError);
	});
});
