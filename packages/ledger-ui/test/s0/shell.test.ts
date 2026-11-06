import { afterEach, expect, test } from "bun:test";
import { Fragment, h, render } from "preact";
import { mountApp } from "../../src/app/mount.tsx";
import { Popover } from "../../src/app/popover.tsx";
import { SettingsDrawer } from "../../src/app/settings-drawer.tsx";
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

test("one period control is on every tab: the period's word, its label in the name, the steps in its popover", async () => {
	await open("#/vol/plans");
	expect(document.querySelectorAll("[data-test=period-button]").length).toBe(1);
	expect(text("[data-test=period-button]")).toBe("Month");
	expect(element("[data-test=period-button]").getAttribute("aria-label")).toBe(
		"Period: Nov 2026",
	);
	await click("[data-test=tab][data-tab=ledger]");
	expect(document.querySelectorAll("[data-test=period-button]").length).toBe(1);
	await click("[data-test=period-button]");
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
	expect(document.querySelectorAll("[data-test=period-option]").length).toBe(9);
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
	expect(document.querySelectorAll("[data-test=period-button]").length).toBe(1);
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
	expect(text("[data-test=period-button]")).toBe("Custom");
	expect(element("[data-test=period-button]").getAttribute("aria-label")).toBe(
		"Period: Jan 1 – Nov 5, 2026",
	);
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
	if (!document.querySelector("[data-test=period-prev]"))
		await click("[data-test=period-button]");
	await click("[data-test=period-prev]");
	expect(element("[data-test=period-button]").getAttribute("aria-label")).toBe(
		"Period: Oct 10 – Oct 19, 2026",
	);
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
	await press(element("[data-test=tab][data-tab=plans]"), "End");
	expect(window.location.hash).toBe("#/vol/reports");
	await press(element("[data-test=tab][data-tab=reports]"), "ArrowLeft");
	expect(window.location.hash).toBe("#/vol/ledger");
	expect(
		element("[data-test=tab][data-tab=ledger]").getAttribute("tabindex"),
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

test("tab badges tell a screen reader what their number means; the visible text is unchanged", async () => {
	await open("#/vol/plans");
	const nameOf = (tab: string): string | null =>
		element(`[data-test=tab][data-tab=${tab}]`).getAttribute("aria-label");
	expect(nameOf("plans")).toBe("Plans: draft");
	expect(nameOf("bookings")).toBe("Bookings: 2 overdue bookings");
	expect(nameOf("promos")).toBe("Promos: 1 expiring promo");
	expect(nameOf("dashboard")).toBeNull();
	expect(
		[...document.querySelectorAll("[data-test=tab-badge]")].map(
			(badge) => badge.textContent,
		),
	).toEqual(["draft", "2", "1"]);
});

test("switching school restores that school's last tab; leaving All schools returns to it", async () => {
	const switchTo = async (schoolId: string): Promise<void> => {
		await click("[data-test=school-switcher]");
		await click(`[data-test=school-option][data-school=${schoolId}]`);
	};
	await open("#/vol/plans");
	await click("[data-test=tab][data-tab=members]");
	await switchTo("b4u");
	expect(window.location.hash).toBe("#/b4u/plans");
	await click("[data-test=tab][data-tab=bookings]");
	await switchTo("vol");
	expect(window.location.hash).toBe("#/vol/members");
	await switchTo("all");
	expect(window.location.hash).toBe("#/all/all");
	await switchTo("vol");
	expect(window.location.hash).toBe("#/vol/members");
	await switchTo("all");
	await switchTo("b4u");
	expect(window.location.hash).toBe("#/b4u/bookings");
});

test("popover triggers name their popup; a click outside returns focus to the trigger", async () => {
	await open("#/vol/ledger");
	const switcher = element("[data-test=school-switcher]");
	expect(switcher.getAttribute("aria-haspopup")).toBe("listbox");
	expect(
		element("[data-test=period-button]").getAttribute("aria-haspopup"),
	).toBe("dialog");
	await click("[data-test=school-switcher]");
	expect(document.activeElement?.getAttribute("aria-label")).toBe(
		"Find a school",
	);
	await click("[data-test=brand]");
	expect(document.querySelector("[data-test=school-option]")).toBeNull();
	expect(document.activeElement).toBe(switcher);

	await click("[data-test=school-switcher]");
	const settings = element("[data-test=settings-button]");
	settings.focus();
	await click("[data-test=settings-button]");
	expect(document.querySelector("[data-test=school-option]")).toBeNull();
	expect(document.activeElement).not.toBe(switcher);
});

test("the settings drawer is a modal dialog that keeps focus inside", async () => {
	await open("#/vol/plans");
	const drawer = element(".drawer");
	expect(drawer.getAttribute("role")).toBe("dialog");
	const titleId = drawer.getAttribute("aria-labelledby") ?? "";
	expect(text(`[id="${titleId}"]`)).toBe("Settings");
	await click("[data-test=settings-button]");
	const closeButton = element(".drawer .x");
	expect(document.activeElement).toBe(closeButton);
	const focusable = [
		...drawer.querySelectorAll<HTMLElement>(
			"button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]",
		),
	];
	const last = focusable[focusable.length - 1] as HTMLElement;
	expect(drawer.contains(last)).toBe(true);
	last.focus();
	await press(last, "Tab");
	expect(document.activeElement).toBe(closeButton);
	closeButton.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
	);
	await settle();
	expect(document.activeElement).toBe(last);
	element("[data-test=help-button]").focus();
	await press(element("[data-test=help-button]"), "Tab");
	expect(document.activeElement).toBe(closeButton);
});

test("in the shell a popover and the drawer are open one at a time: opening the drawer closes the popover", async () => {
	await open("#/vol/plans");
	await click("[data-test=help-button]");
	expect(document.querySelectorAll("[data-test=help-link]").length).toBe(4);
	await click("[data-test=settings-button]");
	expect(document.querySelector("[data-test=help-link]")).toBeNull();
	expect(element(".drawer").classList.contains("on")).toBe(true);
	await press(document.body, "Escape");
	expect(element(".drawer").classList.contains("on")).toBe(false);
});

test("Escape closes an open popover first and the drawer only on the next press", async () => {
	// The shell's top bar is inert while the drawer is open, so this mounts a popover the open drawer leaves reachable,
	// as a popover inside the drawer is.
	const container = document.createElement("div");
	container.id = "app";
	container.dataset.route = window.location.hash;
	document.body.appendChild(container);
	let closes = 0;
	render(
		h(Fragment, null, [
			h(SettingsDrawer, {
				id: "drawer",
				open: true,
				subtitle: "You and Volunteers",
				theme: "system",
				onThemeChange: () => undefined,
				onClose: () => {
					closes += 1;
				},
			}),
			h(Popover, {
				trigger: { class: "ib", "data-test": "reachable-popover" },
				label: "Open",
				children: () =>
					h("button", { type: "button", "data-test": "popover-item" }, "Item"),
			}),
		]),
		container,
	);
	await click("[data-test=reachable-popover]");
	await press(element("[data-test=popover-item]"), "Escape");
	expect(document.querySelector("[data-test=popover-item]")).toBeNull();
	expect(closes).toBe(0);
	await press(document.body, "Escape");
	expect(closes).toBe(1);
	render(null, container);
});

test("Copy a prompt puts the prompt on the clipboard, and says so when it cannot", async () => {
	const copied: string[] = [];
	let blocked = false;
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: async (value: string): Promise<void> => {
				if (blocked) throw new Error("denied");
				copied.push(value);
			},
		},
	});
	const copyPrompt = async (): Promise<void> => {
		await click("[data-test=help-button]");
		const links = [
			...document.querySelectorAll<HTMLElement>("[data-test=help-link]"),
		];
		links[links.length - 1]?.click();
		await settle();
	};
	await open("#/vol/plans");
	await copyPrompt();
	expect(copied.length).toBe(1);
	expect(copied[0]).toContain("read-only");
	expect(text(".toast.on")).toBe(
		"Prompt copied. It gives an assistant read-only context.",
	);
	blocked = true;
	await copyPrompt();
	expect(copied.length).toBe(1);
	expect(text(".toast.on")).toBe(
		"Could not copy the prompt: the browser blocked the clipboard.",
	);
	Reflect.deleteProperty(navigator, "clipboard");
});

const listedSchools = (selector: string): Array<string | null> =>
	[...document.querySelectorAll(selector)].map((option) =>
		option.getAttribute("data-school"),
	);
const focusedSchool = (): string | null | undefined =>
	document.activeElement?.getAttribute("data-school");

test("the school switcher is a listbox after its search field, the current school selected", async () => {
	await open("#/vol/plans");
	const trigger = element("[data-test=school-switcher]");
	await click("[data-test=school-switcher]");
	const listbox = element("[role=listbox]");
	expect(listbox.getAttribute("aria-label")).toBe("Schools");
	expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
	expect(trigger.getAttribute("aria-controls")).toBe(listbox.id);
	const search = element("input[type=search]");
	expect(listbox.contains(search)).toBe(false);
	expect(
		search.compareDocumentPosition(listbox) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(listedSchools("[role=listbox] [role=option]")).toEqual(
		listedSchools("[data-test=school-option]"),
	);
	expect(listedSchools("[role=option]").length).toBe(6);
	expect(listedSchools("[role=option][aria-selected=true]")).toEqual(["vol"]);
	expect(listedSchools("[role=option][aria-selected=false]").length).toBe(5);
	expect(listedSchools("[role=option][tabindex='0']")).toEqual(["vol"]);
});

test("arrow keys, Home and End move between schools; Enter and Space choose", async () => {
	await open("#/vol/plans");
	const trigger = element("[data-test=school-switcher]");
	await click("[data-test=school-switcher]");
	const order = listedSchools("[role=option]");
	const listbox = element("[role=listbox]");
	await press(element("input[type=search]"), "ArrowDown");
	expect(focusedSchool()).toBe("vol");
	await press(listbox, "ArrowDown");
	expect(focusedSchool()).toBe(order[2]);
	await press(listbox, "ArrowUp");
	await press(listbox, "ArrowUp");
	expect(focusedSchool()).toBe("all");
	await press(listbox, "ArrowUp");
	expect(focusedSchool()).toBe("all");
	await press(listbox, "End");
	expect(focusedSchool()).toBe(order[order.length - 1]);
	await press(listbox, "ArrowDown");
	expect(focusedSchool()).toBe(order[order.length - 1]);
	await press(listbox, "Home");
	expect(focusedSchool()).toBe("all");
	await press(element("[role=option][data-school=map]"), "Enter");
	expect(window.location.hash).toBe("#/map/plans");
	expect(document.querySelector("[role=listbox]")).toBeNull();
	expect(document.activeElement).toBe(trigger);

	await click("[data-test=school-switcher]");
	await press(element("[role=option][data-school=b4u]"), " ");
	expect(window.location.hash).toBe("#/b4u/plans");
	expect(document.querySelector("[role=listbox]")).toBeNull();
});

test("the period panel is a dialog that takes focus and gives it back", async () => {
	await open("#/vol/ledger");
	const trigger = element("[data-test=period-button]");
	await click("[data-test=period-button]");
	const dialog = element("[role=dialog][aria-label=Period]");
	expect(dialog.classList.contains("pop")).toBe(true);
	expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
	const focused = document.activeElement;
	expect(dialog.contains(focused)).toBe(true);
	expect(focused?.getAttribute("aria-current")).toBe("true");
	expect(focused?.textContent).toContain("This month");
	await press(focused ?? document.body, "Escape");
	expect(document.querySelector("[role=dialog][aria-label=Period]")).toBeNull();
	expect(document.activeElement).toBe(trigger);

	await click("[data-test=period-button]");
	await click("[data-test=brand]");
	expect(document.querySelector("[role=dialog][aria-label=Period]")).toBeNull();
	expect(document.activeElement).toBe(trigger);
});

test("a custom period opens the dialog on its start date", async () => {
	await open("#/vol/ledger?month=2026-10-20..2026-10-29");
	await click("[data-test=period-button]");
	expect(document.activeElement).toBe(element("input[aria-label=From]"));
});

test("the custom range stops at the clock's today", async () => {
	await open("#/vol/ledger");
	await click("[data-test=period-button]");
	expect(element("input[aria-label=From]").getAttribute("max")).toBe(
		clock.today,
	);
	expect(element("input[aria-label=To]").getAttribute("max")).toBe(clock.today);
	const apply = element<HTMLButtonElement>(".cus .btn");
	await fill("input[aria-label=From]", "2026-11-06");
	await fill("input[aria-label=To]", "2026-11-20");
	expect(text(".cnote")).toBe("Start is after today.");
	expect(apply.disabled).toBe(true);
	await fill("input[aria-label=From]", clock.today);
	expect(apply.disabled).toBe(false);
	await fill("input[aria-label=To]", "2026-11-04");
	expect(text(".cnote")).toBe("Start is after the end.");
	expect(apply.disabled).toBe(true);
});

test("the open drawer is modal: its button names it, and the app behind it is inert", async () => {
	await open("#/map/plans");
	const settings = element("[data-test=settings-button]");
	const drawer = element(".drawer");
	expect(settings.getAttribute("aria-haspopup")).toBe("dialog");
	expect(drawer.id).not.toBe("");
	expect(settings.getAttribute("aria-controls")).toBe(drawer.id);
	const regions = [".top", ".tabs", ".banner", "[data-test=pane]"];
	const inertRegions = (): string[] =>
		regions.filter((selector) => element(selector).hasAttribute("inert"));
	expect(drawer.hasAttribute("aria-modal")).toBe(false);
	expect(inertRegions()).toEqual([]);
	await click("[data-test=settings-button]");
	expect(drawer.getAttribute("aria-modal")).toBe("true");
	expect(drawer.hasAttribute("inert")).toBe(false);
	expect(inertRegions()).toEqual(regions);
	await press(document.body, "Escape");
	expect(drawer.hasAttribute("aria-modal")).toBe(false);
	expect(inertRegions()).toEqual([]);
	expect(document.activeElement).toBe(settings);
});
