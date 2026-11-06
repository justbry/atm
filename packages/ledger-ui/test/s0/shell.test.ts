import { afterEach, expect, test } from "bun:test";
import { mountApp } from "../../src/app/mount.tsx";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";

const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
let unmount: (() => void) | null = null;

const macrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
const element = <Type extends Element = HTMLElement>(
	selector: string,
): Type => {
	const found = document.querySelector<Type>(selector);
	if (!found) throw new Error(`no element matches ${selector}`);
	return found;
};
const text = (selector: string): string =>
	(element(selector).textContent ?? "").replace(/\s+/g, " ").trim();
const root = (): HTMLElement => element("#app");
const settle = async (): Promise<void> => {
	for (
		let attempt = 0;
		attempt < 400 && root().dataset.route !== window.location.hash;
		attempt += 1
	)
		await macrotask();
	await macrotask();
	await macrotask();
};
const click = async (selector: string): Promise<void> => {
	element(selector).click();
	await settle();
};
const press = async (target: Element, key: string): Promise<void> => {
	target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	await settle();
};
const fill = async (selector: string, value: string): Promise<void> => {
	const input = element<HTMLInputElement>(selector);
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
};
const open = async (hash: string): Promise<void> => {
	window.location.hash = hash;
	const container = document.createElement("div");
	container.id = "app";
	document.body.appendChild(container);
	unmount = mountApp(container, {
		reader: createFixtureReader({ clock }),
		writer: createFixtureWriter({ mode: "instant" }),
		clock,
	}).unmount;
	await settle();
};

afterEach(() => {
	unmount?.();
	unmount = null;
	document.body.innerHTML = "";
	window.location.hash = "";
});

test("an empty or unknown hash is replaced by the route it shows", async () => {
	await open("");
	expect(window.location.hash).toBe("#/vol/plans");
	expect(root().dataset.route).toBe("#/vol/plans");
	unmount?.();
	document.body.innerHTML = "";
	await open("#/nowhere/nothing?theme=dark");
	expect(window.location.hash).toBe("#/vol/plans?theme=dark");
	expect(root().classList.contains("dark")).toBe(true);
});

test("theme=system puts neither class on the root; unmount removes the app's marks", async () => {
	await open("#/vol/plans");
	expect(root().className).toBe("app");
	unmount?.();
	unmount = null;
	expect(root().className).toBe("");
	expect(root().dataset.route).toBeUndefined();
	expect(root().childElementCount).toBe(0);
});

test("the period control shows only on Ledger, Reports and All schools", async () => {
	await open("#/vol/plans");
	expect(element(".pgrp").hidden).toBe(true);
	await click("[data-test=tab][data-tab=ledger]");
	expect(element(".pgrp").hidden).toBe(false);
	expect(text("[data-test=period-button]")).toBe("Nov 2026");
	expect(element<HTMLButtonElement>("[data-test=period-next]").disabled).toBe(
		true,
	);
});

test("Escape closes a popover and returns focus to its trigger", async () => {
	await open("#/vol/ledger");
	const trigger = element("[data-test=school-switcher]");
	await click("[data-test=school-switcher]");
	expect(trigger.getAttribute("aria-expanded")).toBe("true");
	expect(document.activeElement?.getAttribute("aria-label")).toBe(
		"Find a school",
	);
	await press(element("input[type=search]"), "Escape");
	expect(document.querySelector("[data-test=school-option]")).toBeNull();
	expect(trigger.getAttribute("aria-expanded")).toBe("false");
	expect(document.activeElement).toBe(trigger);
});

test("a click outside closes a popover; opening another closes the first", async () => {
	await open("#/vol/ledger");
	await click("[data-test=help-button]");
	expect(document.querySelectorAll("[data-test=help-link]").length).toBe(4);
	await click("[data-test=period-button]");
	expect(document.querySelector("[data-test=help-link]")).toBeNull();
	expect(document.querySelectorAll("[data-test=period-option]").length).toBe(5);
	await click("[data-test=brand]");
	expect(document.querySelector("[data-test=period-option]")).toBeNull();
});

test("the school search filters the switcher", async () => {
	await open("#/vol/plans");
	await click("[data-test=school-switcher]");
	await fill("input[type=search]", "pil");
	expect(
		[...document.querySelectorAll("[data-test=school-option]")].map((option) =>
			option.getAttribute("data-school"),
		),
	).toEqual(["map"]);
});

test("All schools hides the tabs and shows the period control", async () => {
	await open("#/vol/members?member=m_204");
	await click("[data-test=school-switcher]");
	await click("[data-test=school-option][data-school=all]");
	expect(window.location.hash).toBe("#/all/all");
	expect(text("[data-test=school-switcher]")).toBe("All schools");
	expect(document.querySelectorAll("[data-test=tab]").length).toBe(0);
	expect(element(".pgrp").hidden).toBe(false);
	await click("[data-test=period-button]");
	expect(text(".tzn")).toBe("Each school's own time zone");
	await click("[data-test=school-switcher]");
	await click("[data-test=school-option][data-school=b4u]");
	expect(window.location.hash).toBe("#/b4u/plans");
});

test("a preset and a custom range write month= to the hash", async () => {
	await open("#/vol/ledger");
	await click("[data-test=period-button]");
	expect(text(".tzn")).toBe("Times in America/Denver");
	const yearToDate = [
		...document.querySelectorAll<HTMLElement>("[data-test=period-option]"),
	].find((option) => option.textContent?.includes("Year to date"));
	yearToDate?.click();
	await settle();
	expect(window.location.hash).toBe(
		"#/vol/ledger?month=2026-01-01..2026-11-05",
	);
	expect(text("[data-test=period-button]")).toBe("Jan 1 – Nov 5, 2026");
	expect(document.activeElement).toBe(element("[data-test=period-button]"));

	await click("[data-test=period-button]");
	const apply = element<HTMLButtonElement>(".cus .btn");
	await fill("input[aria-label=From]", "2026-10-20");
	await fill("input[aria-label=To]", "2026-10-10");
	expect(text(".cnote")).toBe("Start is after the end.");
	expect(apply.disabled).toBe(true);
	await fill("input[aria-label=To]", "");
	expect(text(".cnote")).toBe("Pick both dates.");
	await fill("input[aria-label=To]", "2026-10-29");
	expect(apply.disabled).toBe(false);
	await click(".cus .btn");
	expect(window.location.hash).toBe(
		"#/vol/ledger?month=2026-10-20..2026-10-29",
	);
	await click("[data-test=period-prev]");
	expect(text("[data-test=period-button]")).toBe("Oct 10 – Oct 19, 2026");
});

test("tab badges come from the school; Maple Pilates shows the stale banner", async () => {
	await open("#/b4u/plans");
	expect(
		[...document.querySelectorAll("[data-test=tab-badge]")].map(
			(badge) => badge.textContent,
		),
	).toEqual(["1"]);
	expect(document.querySelector(".banner")).toBeNull();
	await click("[data-test=school-switcher]");
	await click("[data-test=school-option][data-school=map]");
	expect(document.querySelectorAll("[data-test=tab-badge]").length).toBe(0);
	expect(text(".banner")).toBe(
		"Data is 26 min behind: the shipper may be stuck. Recent events can be missing.",
	);
});

test("arrow keys, Home and End move between tabs", async () => {
	await open("#/vol/plans");
	await press(element("[data-test=tab][data-tab=plans]"), "ArrowLeft");
	expect(window.location.hash).toBe("#/vol/reports");
	expect(document.activeElement).toBe(
		element("[data-test=tab][data-tab=reports]"),
	);
	await press(element("[data-test=tab][data-tab=reports]"), "Home");
	expect(window.location.hash).toBe("#/vol/plans");
	await press(element("[data-test=tab][data-tab=plans]"), "ArrowRight");
	expect(window.location.hash).toBe("#/vol/dashboard");
	expect(
		element("[data-test=tab][data-tab=dashboard]").getAttribute("tabindex"),
	).toBe("0");
});

test("a help link closes the menu and shows its toast", async () => {
	await open("#/vol/plans");
	await click("[data-test=help-button]");
	await click("[data-test=help-link]");
	expect(document.querySelector("[data-test=help-link]")).toBeNull();
	expect(text(".toast.on")).toBe("Opening the School SDK readme…");
	expect(document.activeElement).toBe(element("[data-test=help-button]"));
});

test("settings opens a drawer whose Appearance writes theme= to the hash", async () => {
	await open("#/vol/plans?theme=light");
	await click("[data-test=settings-button]");
	expect(element(".drawer").classList.contains("on")).toBe(true);
	expect(text(".drawer .mut")).toBe("You and Vibes of Light");
	const dark = [...document.querySelectorAll<HTMLElement>(".seg button")].find(
		(button) => button.textContent === "Dark",
	);
	dark?.click();
	await settle();
	expect(window.location.hash).toBe("#/vol/plans?theme=dark");
	expect(root().classList.contains("dark")).toBe(true);
	expect(root().classList.contains("light")).toBe(false);
	await press(document.body, "Escape");
	expect(element(".drawer").classList.contains("on")).toBe(false);
	expect(document.activeElement).toBe(element("[data-test=settings-button]"));
});
