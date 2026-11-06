import { describe, expect, test } from "bun:test";
import {
	formatPeriod,
	parsePeriod,
	periodLabel,
	periodPresets,
	shiftPeriod,
} from "../../src/app/period.ts";

const today = "2026-11-05";

describe("periodLabel", () => {
	test("labels whole months, month ranges and day ranges as the mockup's plabel", () => {
		expect(periodLabel({ from: "2026-11-01", to: "2026-11-30" })).toBe(
			"Nov 2026",
		);
		expect(periodLabel({ from: "2026-09-01", to: "2026-11-30" })).toBe(
			"Sep – Nov 2026",
		);
		expect(periodLabel({ from: "2025-12-01", to: "2026-02-28" })).toBe(
			"Dec 2025 – Feb 2026",
		);
		expect(periodLabel({ from: "2026-01-01", to: "2026-11-05" })).toBe(
			"Jan 1 – Nov 5, 2026",
		);
	});
	test("a day range across a year boundary keeps the start year", () => {
		expect(periodLabel({ from: "2026-12-15", to: "2027-01-10" })).toBe(
			"Dec 15, 2026 – Jan 10, 2027",
		);
		expect(periodLabel({ from: "2026-12-15", to: "2026-12-20" })).toBe(
			"Dec 15 – Dec 20, 2026",
		);
	});
});

describe("periodPresets", () => {
	test("computes the eight presets from the clock", () => {
		expect(
			periodPresets(today).map(({ label, period }) => [
				label,
				periodLabel(period),
			]),
		).toEqual([
			["This month", "Nov 2026"],
			["Last month", "Oct 2026"],
			["This quarter", "Oct – Dec 2026"],
			["Last quarter", "Jul – Sep 2026"],
			["Last 3 months", "Sep – Nov 2026"],
			["This year", "Jan – Dec 2026"],
			["Last year", "Jan – Dec 2025"],
			["Year to date", "Jan 1 – Nov 5, 2026"],
		]);
	});
	test("crosses the year boundary in January", () => {
		const [, lastMonth, , lastQuarter, lastThreeMonths, , lastYear] =
			periodPresets("2026-01-20");
		expect(lastMonth?.period).toEqual({ from: "2025-12-01", to: "2025-12-31" });
		expect(lastQuarter?.period).toEqual({
			from: "2025-10-01",
			to: "2025-12-31",
		});
		expect(lastThreeMonths?.period).toEqual({
			from: "2025-11-01",
			to: "2026-01-31",
		});
		expect(lastYear?.period).toEqual({ from: "2025-01-01", to: "2025-12-31" });
	});
});

describe("shiftPeriod", () => {
	test("steps whole months by their length, ending on the month's last day", () => {
		expect(shiftPeriod({ from: "2026-03-01", to: "2026-03-31" }, -1)).toEqual({
			from: "2026-02-01",
			to: "2026-02-28",
		});
		expect(shiftPeriod({ from: "2026-09-01", to: "2026-11-30" }, -1)).toEqual({
			from: "2026-06-01",
			to: "2026-08-31",
		});
	});
	test("steps day ranges by their number of days", () => {
		expect(shiftPeriod({ from: "2026-11-01", to: "2026-11-05" }, 1)).toEqual({
			from: "2026-11-06",
			to: "2026-11-10",
		});
	});
});

describe("parsePeriod and formatPeriod", () => {
	test("round-trip a month, a month range and a day range", () => {
		for (const period of [
			{ from: "2026-10-01", to: "2026-10-31" },
			{ from: "2026-09-01", to: "2026-11-30" },
			{ from: "2026-01-01", to: "2026-11-05" },
		])
			expect(parsePeriod(formatPeriod(period, today), today)).toEqual(period);
		expect(formatPeriod({ from: "2026-10-01", to: "2026-10-31" }, today)).toBe(
			"2026-10",
		);
	});
	test("the clock's month is the default and has no parameter", () => {
		const thisMonth = { from: "2026-11-01", to: "2026-11-30" };
		expect(parsePeriod(null, today)).toEqual(thisMonth);
		expect(formatPeriod(thisMonth, today)).toBeNull();
	});
	test("malformed, reversed and future values fall back to the clock's month", () => {
		for (const value of [
			"nonsense",
			"2026-13",
			"2026-02-30..2026-03-01",
			"2026-10-10..2026-10-01",
			"2026-12",
			"2026-01-01..2026-02-01..2026-03-01",
		])
			expect(parsePeriod(value, today)).toEqual({
				from: "2026-11-01",
				to: "2026-11-30",
			});
	});
});
