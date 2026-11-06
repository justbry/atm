import { afterEach, expect, test } from "bun:test";
import type { Disclosure } from "../../src/data/disclosure.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import {
	cleanup,
	click,
	clock,
	count,
	element,
	open,
	press,
	settle,
	text,
} from "./helpers.ts";

afterEach(cleanup);

test("choosing a row of View as writes as=, keeps the tab and snaps the period with a toast", async () => {
	await open("#/b4u/ledger");
	await click("[data-test=view-as]");
	await click("[data-test=view-as-option][data-as=governance]");
	expect(window.location.hash).toBe("#/b4u/ledger?as=governance&month=2026-09");
	expect(text("[data-test=toast]")).toBe(
		"Period changed to Sep 2026: Governance sees months",
	);
	expect(text("[data-test=period-button]")).toBe("Month");
	expect(element("[data-test=view-as]").classList.contains("pnd")).toBe(true);
});

test("choosing the viewer's own row, or Exit preview, removes as= and keeps the rest of the route", async () => {
	await open(
		"#/b4u/dashboard?as=member&filter=cutoff&month=2026-04-01..2026-06-30",
	);
	await click("[data-test=view-as]");
	await click("[data-test=view-as-option][data-as=finance]");
	expect(window.location.hash).toBe(
		"#/b4u/dashboard?filter=cutoff&month=2026-04-01..2026-06-30",
	);
	expect(count("[data-test=preview-banner]")).toBe(0);
});

test("switching school ends the preview", async () => {
	await open("#/vol/plans?as=public");
	await click("[data-test=school-switcher]");
	await click("[data-test=school-option][data-school=map]");
	expect(window.location.hash).toBe("#/map/plans");
});

test("an unknown as= is ignored and the route is not rewritten", async () => {
	await open("#/vol/plans?as=nobody");
	expect(window.location.hash).toBe("#/vol/plans?as=nobody");
	expect(text("[data-test=view-as]")).toBe("View as Owner");
	expect(count("[data-test=preview-banner]")).toBe(0);
});

test("the steps in the period popover keep it open and move the one period", async () => {
	await open("#/vol/ledger");
	await click("[data-test=period-button]");
	await click("[data-test=period-prev]");
	await click("[data-test=period-prev]");
	expect(window.location.hash).toBe("#/vol/ledger?month=2026-09");
	expect(count("[data-test=period-label]")).toBe(1);
	expect(text("[data-test=period-label]")).toBe("Sep 2026");
	await click("[data-test=period-option]:nth-of-type(1)");
	expect(window.location.hash).toBe("#/vol/ledger");
	expect(count("[data-test=period-label]")).toBe(0);
});

test("a custom range is Custom on the closed control and writes both dates", async () => {
	await open("#/vol/members");
	await click("[data-test=period-button]");
	const dates = document.querySelectorAll<HTMLInputElement>(".cus input");
	for (const [index, value] of ["2026-10-20", "2026-10-29"].entries()) {
		const input = dates[index];
		if (!input) throw new Error("the custom range has two dates");
		input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
	await settle();
	await click(".cus .btn");
	expect(window.location.hash).toBe(
		"#/vol/members?month=2026-10-20..2026-10-29",
	);
	expect(text("[data-test=period-button]")).toBe("Custom");
});

test("on Bookings the control writes range and offset, keeps filter and as, and leaves the money period alone", async () => {
	await open("#/vol/bookings?filter=outcome&as=admin&month=2026-09");
	expect(element("[data-test=period-button]").getAttribute("aria-label")).toBe(
		"Bookings period: This week",
	);
	expect(text("[data-test=period-button]")).toBe("Week");
	await click("[data-test=period-button]");
	await click("[data-test=period-next]");
	expect(window.location.hash).toBe(
		"#/vol/bookings?filter=outcome&as=admin&month=2026-09&offset=1",
	);
	expect(text("[data-test=period-label]")).toBe("Next week");
	expect(text(".pop .tzn")).toBe(
		"The money period (Q2 2026) comes back when you leave Bookings. Times in America/Denver.",
	);
	await click("[data-test=period-option]:nth-of-type(1)");
	expect(window.location.hash).toBe(
		"#/vol/bookings?filter=outcome&as=admin&month=2026-09&range=day",
	);
	expect(text("[data-test=period-button]")).toBe("Day");
	await click("[data-test=tab][data-tab=ledger]");
	expect(element("[data-test=period-button]").getAttribute("aria-label")).toBe(
		"Period: Q2 2026",
	);
});

test("previewing Admin disables the booking actions with the reason", async () => {
	await open("#/vol/bookings?as=admin");
	expect(count("[data-test=booking-action]")).toBeGreaterThan(0);
	expect(count("[data-test=booking-action]:not([disabled])")).toBe(0);
	expect(count("[data-test=booking-bulk]:not([disabled])")).toBe(0);
	expect(element("[data-test=booking-action]").getAttribute("title")).toBe(
		"Exit preview to act",
	);
});

test("every school's own View as row is held, and no row above it is", async () => {
	const reader = createFixtureReader({ clock });
	for (const school of ["vol", "b4u", "map", "nw", "har"]) {
		const disclosure: Disclosure = await reader.disclosure(school);
		const own = disclosure.viewAs.find(
			({ value }) => value === disclosure.viewer.viewAs,
		);
		expect(own?.held).toBe(true);
	}
	const harbor = await reader.disclosure("har");
	expect(
		harbor.viewAs.filter(({ held }) => held).map(({ value }) => value),
	).toEqual(["admin", "member", "public"]);
});

test("Escape closes a popover, then the next press the drawer; the bar is inert behind the drawer", async () => {
	await open("#/vol/plans");
	await click("[data-test=settings-button]");
	expect(element(".top").hasAttribute("inert")).toBe(true);
	expect(element(".drawer").classList.contains("on")).toBe(true);
	await press(document.body, "Escape");
	expect(element(".drawer").classList.contains("on")).toBe(false);
	expect(element(".top").hasAttribute("inert")).toBe(false);
});
