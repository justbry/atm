// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import {
	ceilDiv,
	formatMinor,
	parseMinor,
	parseRate,
	roundHalfUp,
} from "../src/money";

describe("parseMinor", () => {
	const accepted: [string, bigint][] = [
		["0", 0n],
		["7", 7n],
		["-7", -7n],
		["35000", 35_000n],
		["-1000000", -1_000_000n],
		[
			"123456789012345678901234567890",
			123_456_789_012_345_678_901_234_567_890n,
		],
	];
	const rejected = [
		"",
		"+5",
		"-0",
		"00",
		"007",
		"-007",
		"1.5",
		" 5",
		"5 ",
		"1e3",
		"--1",
		"-",
		"1,000",
		"0x10",
		"٣",
	];

	it("accepts strict digit strings", () => {
		for (const [text, expected] of accepted) {
			expect(parseMinor(text)).toBe(expected);
		}
	});

	it("rejects everything else", () => {
		for (const text of rejected) {
			expect(() => parseMinor(text)).toThrow();
		}
	});

	it("round-trips through formatMinor", () => {
		for (const [text] of accepted) {
			expect(formatMinor(parseMinor(text))).toBe(text);
		}
	});
});

describe("parseRate", () => {
	const accepted: [string, bigint, bigint][] = [
		["0", 0n, 1n],
		["0.0", 0n, 10n],
		["0.05", 5n, 100n],
		["0.0525", 525n, 10_000n],
		["0.000001", 1n, 1_000_000n],
		["0.999999", 999_999n, 1_000_000n],
		["0.5", 5n, 10n],
	];
	const rejected = [
		".5",
		"5%",
		"1e-2",
		"0.0000001", // 7 places
		"-0.1",
		"-0",
		"1",
		"1.0",
		"1.5",
		"2",
		"0.",
		"00.5",
		"01",
		"0,5",
		"+0.05",
		" 0.05",
		"0.05 ",
		"",
	];

	it("parses a decimal string exactly", () => {
		for (const [text, num, den] of accepted) {
			expect(parseRate(text)).toEqual({ num, den });
		}
	});

	it("rejects loose forms, 7 places, negatives and rates of 100% or more", () => {
		for (const text of rejected) {
			expect(() => parseRate(text)).toThrow();
		}
	});
});

describe("roundHalfUp", () => {
	const table: [bigint, bigint, bigint][] = [
		[0n, 7n, 0n],
		[4n, 10n, 0n],
		[5n, 10n, 1n], // exactly one half rounds up
		[14n, 10n, 1n],
		[15n, 10n, 2n],
		[1n, 2n, 1n],
		[3n, 2n, 2n],
		[1n, 3n, 0n],
		[2n, 3n, 1n],
		[7n, 1n, 7n],
		[1_550_000n, 365n, 4247n], // 4246.58...
		[2_232_000n, 365n, 6115n], // 6115.07...
	];

	it("rounds half up", () => {
		for (const [num, den, expected] of table) {
			expect(roundHalfUp(num, den)).toBe(expected);
		}
	});

	it("rejects a non-positive denominator and a negative numerator", () => {
		expect(() => roundHalfUp(1n, 0n)).toThrow();
		expect(() => roundHalfUp(1n, -2n)).toThrow();
		expect(() => roundHalfUp(-1n, 2n)).toThrow();
	});
});

describe("ceilDiv", () => {
	it("rounds up", () => {
		expect(ceilDiv(1000n, 3n)).toBe(334n);
		expect(ceilDiv(999n, 3n)).toBe(333n);
		expect(ceilDiv(0n, 3n)).toBe(0n);
		expect(() => ceilDiv(1n, 0n)).toThrow();
	});
});
