// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import {
	addDays,
	addMonthsAnchored,
	compareDates,
	daysBetween,
	isValidCivilDate,
	parseCivilDate,
} from "../src/date";

describe("isValidCivilDate and parseCivilDate", () => {
	const valid = [
		"2026-01-01",
		"2000-02-29",
		"2024-02-29",
		"2026-12-31",
		"0001-01-01",
		"9999-12-31",
	];
	const invalid = [
		"2026-02-29", // 2026 is not a leap year
		"1900-02-29", // divisible by 100, not by 400
		"2100-02-29",
		"2026-13-01",
		"2026-00-10",
		"2026-04-31",
		"2026-01-00",
		"2026-1-1",
		"26-01-01",
		"2026/01/01",
		"2026-01-01T00:00:00Z",
		" 2026-01-01",
		"0000-01-01",
		"",
	];

	it("accepts real calendar dates, including leap days", () => {
		for (const text of valid) {
			expect(isValidCivilDate(text)).toBe(true);
		}
	});

	it("rejects impossible dates and loose formats", () => {
		for (const text of invalid) {
			expect(isValidCivilDate(text)).toBe(false);
			expect(() => parseCivilDate(text)).toThrow();
		}
	});

	it("parses the parts", () => {
		expect(parseCivilDate("2028-02-29")).toEqual({
			year: 2028,
			month: 2,
			day: 29,
		});
	});
});

describe("daysBetween", () => {
	it("counts whole days, negative when going backwards", () => {
		expect(daysBetween("2026-01-01", "2026-01-01")).toBe(0);
		expect(daysBetween("2026-01-01", "2026-02-01")).toBe(31);
		expect(daysBetween("2026-02-01", "2026-03-01")).toBe(28);
		expect(daysBetween("2026-03-01", "2026-02-01")).toBe(-28);
	});

	it("counts 365 days in 2026 and 366 in leap 2028", () => {
		expect(daysBetween("2026-01-01", "2027-01-01")).toBe(365);
		expect(daysBetween("2028-01-01", "2029-01-01")).toBe(366);
		expect(daysBetween("2027-12-31", "2028-12-31")).toBe(366);
	});

	it("knows the century rules", () => {
		expect(daysBetween("2000-02-28", "2000-03-01")).toBe(2);
		expect(daysBetween("1900-02-28", "1900-03-01")).toBe(1);
		expect(daysBetween("2100-02-28", "2100-03-01")).toBe(1);
	});

	it("matches known day counts", () => {
		// 1970-01-01 to 2000-01-01: 30 * 365 = 10950 plus 7 leap days (1972 to 1996) = 10957; plus Jan 31 and Feb 29 (2000).
		expect(daysBetween("1970-01-01", "2000-03-01")).toBe(11_017);
		// 2026-01-01 to 2028-01-01: 365 + 365 = 730; plus Jan 31, Feb 29, Mar 31 = 821 (to Apr 1); plus 29 = 850 (Apr 30).
		expect(daysBetween("2026-01-01", "2028-04-30")).toBe(850);
	});
});

describe("addDays", () => {
	it("moves forward and backward across month, year and leap boundaries", () => {
		expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
		expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
		expect(addDays("2026-03-08", 7)).toBe("2026-03-15");
		expect(addDays("2026-03-08", 0)).toBe("2026-03-08");
	});

	it("round-trips with daysBetween", () => {
		for (const days of [-1000, -365, -1, 0, 1, 59, 60, 366, 1461, 40_000]) {
			const moved = addDays("2026-06-15", days);
			expect(daysBetween("2026-06-15", moved)).toBe(days);
		}
	});

	it("rejects results outside years 1 to 9999 and fractional days", () => {
		expect(() => addDays("9999-12-31", 1)).toThrow();
		expect(() => addDays("0001-01-01", -1)).toThrow();
		expect(() => addDays("2026-01-01", 1.5)).toThrow();
	});
});

describe("addMonthsAnchored", () => {
	it("clamps to month end and returns to the anchor day", () => {
		expect(addMonthsAnchored("2026-01-31", 0)).toBe("2026-01-31");
		expect(addMonthsAnchored("2026-01-31", 1)).toBe("2026-02-28");
		expect(addMonthsAnchored("2026-01-31", 2)).toBe("2026-03-31");
		expect(addMonthsAnchored("2026-01-31", 3)).toBe("2026-04-30");
		expect(addMonthsAnchored("2026-01-31", 4)).toBe("2026-05-31");
	});

	it("uses Feb 29 in a leap year", () => {
		expect(addMonthsAnchored("2028-01-31", 1)).toBe("2028-02-29");
		expect(addMonthsAnchored("2028-01-30", 1)).toBe("2028-02-29");
		expect(addMonthsAnchored("2028-01-29", 1)).toBe("2028-02-29");
		expect(addMonthsAnchored("2027-01-29", 1)).toBe("2027-02-28");
	});

	it("crosses years and supports 12, 24 and negative months", () => {
		expect(addMonthsAnchored("2026-11-15", 2)).toBe("2027-01-15");
		expect(addMonthsAnchored("2026-02-01", 35)).toBe("2029-01-01");
		expect(addMonthsAnchored("2028-02-29", 12)).toBe("2029-02-28");
		expect(addMonthsAnchored("2028-02-29", 48)).toBe("2032-02-29");
		expect(addMonthsAnchored("2026-03-31", -1)).toBe("2026-02-28");
		expect(addMonthsAnchored("2026-01-15", -2)).toBe("2025-11-15");
	});

	it("rejects out-of-range results", () => {
		expect(() => addMonthsAnchored("9999-12-01", 1)).toThrow();
		expect(() => addMonthsAnchored("2026-01-01", 0.5)).toThrow();
	});
});

describe("compareDates", () => {
	it("orders dates", () => {
		expect(compareDates("2026-01-01", "2026-01-02")).toBe(-1);
		expect(compareDates("2026-01-02", "2026-01-01")).toBe(1);
		expect(compareDates("2026-01-01", "2026-01-01")).toBe(0);
		expect(compareDates("2025-12-31", "2026-01-01")).toBe(-1);
	});

	it("throws on an invalid date", () => {
		expect(() => compareDates("2026-02-30", "2026-03-01")).toThrow();
	});
});
