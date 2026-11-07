import { afterEach, expect, test } from "bun:test";
import { cleanup, click, element, open, text } from "./helpers.ts";

afterEach(cleanup);

const pill = (): HTMLElement => element("[data-test=period-button]");

test("at B4 Uni the pill names the June the Dashboard opens on, with the pending dot", async () => {
	await open("#/b4u/dashboard");
	expect(text("[data-test=period-button]")).toBe("Month");
	expect(pill().title).toBe("Jun 2026");
	expect(pill().getAttribute("aria-label")).toBe("Period: Jun 2026");
	expect(pill().classList.contains("pnd")).toBe(true);
	expect(element("[data-test=dash-period].on").dataset.period).toBe("2026-06");
});

test("the pill follows a month= in the route over the school's opening month", async () => {
	await open("#/b4u/dashboard?month=2026-04");
	expect(pill().title).toBe("Apr 2026");
	expect(pill().classList.contains("pnd")).toBe(true);
	expect(element("[data-test=dash-period].on").dataset.period).toBe("2026-04");
});

test("the Ledger, which reads the route alone, keeps the clock's month in the pill", async () => {
	await open("#/b4u/ledger");
	expect(pill().title).toBe("Nov 2026");
	expect(pill().classList.contains("pnd")).toBe(false);
});

test("a school that opens on the clock's month keeps a plain pill", async () => {
	await open("#/vol/dashboard");
	expect(text("[data-test=period-button]")).toBe("Month");
	expect(pill().title).toBe("Nov 2026");
	expect(pill().classList.contains("pnd")).toBe(false);
});

test("a pointer-opened Settings drawer focuses a close button with no ring, and a keyboard open keeps it", async () => {
	window.dispatchEvent(new MouseEvent("mousedown"));
	await open("#/vol/plans");
	await click("[data-test=settings-button]");
	const closeButton = element(".drawer.on .x");
	expect(document.activeElement).toBe(closeButton);
	expect(closeButton.hasAttribute("data-pointer-focus")).toBe(true);
	await click(".drawer.on .x");
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
	await click("[data-test=settings-button]");
	const reopened = element(".drawer.on .x");
	expect(document.activeElement).toBe(reopened);
	expect(reopened.hasAttribute("data-pointer-focus")).toBe(false);
});

test("a pointer-opened member drawer focuses a close button with no ring", async () => {
	window.dispatchEvent(new MouseEvent("mousedown"));
	await open("#/vol/members?member=m_117");
	const closeButton = element(".drawer .x");
	expect(document.activeElement).toBe(closeButton);
	expect(closeButton.hasAttribute("data-pointer-focus")).toBe(true);
});
