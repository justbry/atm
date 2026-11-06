import { describe, expect, test } from "bun:test";
import {
	bookingsDays,
	bookingsLabel,
	bookingsPeriodRoute,
	readBookingsPeriod,
} from "../../src/app/bookings-period.ts";
import {
	formatPeriod,
	periodName,
	periodPresets,
	periodWord,
	snapPeriod,
	stepAllowed,
} from "../../src/app/period.ts";
import { parseRoute } from "../../src/app/route.ts";
import type { Disclosure } from "../../src/data/disclosure.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { clock } from "./helpers.ts";

const today = "2026-11-05";
const disclosure = (await createFixtureReader({ clock }).disclosure(
	"b4u",
)) as Disclosure;
const publicView = disclosure.views.public;
const memberView = disclosure.views.member;
const governanceView = disclosure.views.governance;

describe("the period's name and word", () => {
	test("a year, a quarter and a month are named as the mockup's pMeta names them", () => {
		expect(periodName({ from: "2024-01-01", to: "2024-12-31" })).toBe("2024");
		expect(periodName({ from: "2026-04-01", to: "2026-06-30" })).toBe(
			"Q2 2026",
		);
		expect(periodName({ from: "2026-09-01", to: "2026-11-30" })).toBe(
			"Sep – Nov 2026",
		);
		expect(periodWord({ from: "2024-01-01", to: "2024-12-31" })).toBe("Year");
		expect(periodWord({ from: "2026-04-01", to: "2026-06-30" })).toBe(
			"Quarter",
		);
		expect(periodWord({ from: "2026-11-01", to: "2026-11-30" })).toBe("Month");
		expect(periodWord({ from: "2026-09-01", to: "2026-11-30" })).toBe("Custom");
		expect(periodWord({ from: "2026-10-01", to: "2026-11-30" })).toBe("Custom");
		expect(periodWord({ from: "2026-01-01", to: today })).toBe("Custom");
	});
});

describe("periodPresets", () => {
	test("computes the mockup's eight presets from the clock", () => {
		expect(
			periodPresets(today).map(({ label, period }) => [
				label,
				period.from,
				period.to,
			]),
		).toEqual([
			["This month", "2026-11-01", "2026-11-30"],
			["Last month", "2026-10-01", "2026-10-31"],
			["This quarter", "2026-10-01", "2026-12-31"],
			["Last quarter", "2026-07-01", "2026-09-30"],
			["Last 3 months", "2026-09-01", "2026-11-30"],
			["This year", "2026-01-01", "2026-12-31"],
			["Last year", "2025-01-01", "2025-12-31"],
			["Year to date", "2026-01-01", "2026-11-05"],
		]);
	});
	test("the first quarter of the year looks back into the last year", () => {
		const presets = periodPresets("2026-02-10");
		expect(presets[3]?.period).toEqual({
			from: "2025-10-01",
			to: "2025-12-31",
		});
	});
});

describe("snapPeriod", () => {
	const november = { from: "2026-11-01", to: "2026-11-30" };
	test("a live audience, or All schools, keeps every period", () => {
		expect(snapPeriod(november, disclosure.views.finance)).toEqual(november);
		expect(snapPeriod(november, null)).toEqual(november);
	});
	test("Public snaps to the last year it may read that ends on or before the period", () => {
		expect(snapPeriod(november, publicView)).toEqual({
			from: "2024-01-01",
			to: "2024-12-31",
		});
	});
	test("Member snaps to the last closed quarter, Governance to the last published month", () => {
		expect(snapPeriod(november, memberView)).toEqual({
			from: "2026-04-01",
			to: "2026-06-30",
		});
		expect(snapPeriod(november, governanceView)).toEqual({
			from: "2026-09-01",
			to: "2026-09-30",
		});
	});
	test("a period before everything listed snaps to the first one", () => {
		expect(
			snapPeriod({ from: "2020-05-01", to: "2020-05-31" }, publicView),
		).toEqual({ from: "2024-01-01", to: "2024-12-31" });
	});
	test("a period the audience may read is kept", () => {
		const quarter = { from: "2025-01-01", to: "2025-03-31" };
		expect(snapPeriod(quarter, memberView)).toEqual(quarter);
	});
});

describe("stepAllowed", () => {
	test("a step to a period that has not started says so, whoever looks", () => {
		const next = { from: "2026-12-01", to: "2026-12-31" };
		expect(stepAllowed(next, disclosure.views.finance, today)).toEqual({
			ok: false,
			title: "Not started yet",
		});
	});
	test("a live audience steps anywhere in the past", () => {
		expect(
			stepAllowed(
				{ from: "2019-01-01", to: "2019-01-31" },
				disclosure.views.finance,
				today,
			),
		).toEqual({ ok: true, title: null });
	});
	test("an embargoed period is refused with when it publishes", () => {
		expect(
			stepAllowed({ from: "2025-01-01", to: "2025-12-31" }, publicView, today),
		).toEqual({ ok: false, title: "Published after 7 Jan 2027" });
	});
	test("a period the audience may read is allowed", () => {
		expect(
			stepAllowed({ from: "2024-01-01", to: "2024-12-31" }, publicView, today),
		).toEqual({ ok: true, title: null });
	});
});

describe("the Bookings period", () => {
	test("range and offset default to this week and leave the hash when they are the default", () => {
		const route = parseRoute("#/vol/bookings?range=day&offset=2&as=admin", [
			"vol",
		]);
		const period = readBookingsPeriod(route.query);
		expect(period).toEqual({ range: "day", offset: 2 });
		expect(
			bookingsPeriodRoute(route, { range: "week", offset: 0 }).query.toString(),
		).toBe("as=admin");
		expect(
			bookingsPeriodRoute(route, { range: "week", offset: 1 }).query.toString(),
		).toBe("offset=1&as=admin");
	});
	test("a malformed offset is 0 and an unknown range is a week", () => {
		expect(
			readBookingsPeriod(new URLSearchParams("range=month&offset=x")),
		).toEqual({ range: "week", offset: 0 });
	});
	test("a day is named by its offset, a week by its Monday", () => {
		const day = { range: "day", offset: 2 } as const;
		expect(bookingsDays(day, today)).toEqual({
			from: "2026-11-07",
			to: "2026-11-07",
		});
		expect(bookingsLabel(day, "2026-11-07")).toBe("Sat Nov 7");
		const week = { range: "week", offset: 2 } as const;
		expect(bookingsDays(week, today)).toEqual({
			from: "2026-11-16",
			to: "2026-11-22",
		});
		expect(bookingsLabel(week, "2026-11-16")).toBe("Week of Nov 16");
	});
});

test("the clock's month leaves the hash, any other period writes month=", () => {
	expect(formatPeriod({ from: "2026-11-01", to: "2026-11-30" }, today)).toBe(
		null,
	);
	expect(formatPeriod({ from: "2026-09-01", to: "2026-09-30" }, today)).toBe(
		"2026-09",
	);
});

describe("the viewed period's label", () => {
	test("an audience with a coarser grain or a delay is named by its last visible period", () => {
		const asked = { from: "2026-11-01", to: "2026-11-30" };
		expect(periodName(snapPeriod(asked, publicView))).toBe("2024");
		expect(periodName(snapPeriod(asked, memberView))).toBe("Q2 2026");
		expect(periodName(snapPeriod(asked, governanceView))).toBe("Sep 2026");
		expect(periodName(snapPeriod(asked, disclosure.views.finance))).toBe(
			"Nov 2026",
		);
	});
});
