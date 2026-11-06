import { afterEach, expect, test } from "bun:test";
import { mountApp } from "../../src/app/mount.tsx";
import type { Reader } from "../../src/data/reader.ts";
import type { Writer } from "../../src/data/writer.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";

const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
let unmount: (() => void) | null = null;

const macrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
const wait = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));
const element = <Type extends HTMLElement = HTMLElement>(
	selector: string,
): Type => {
	const found = document.querySelector<Type>(selector);
	if (!found) throw new Error(`no element matches ${selector}`);
	return found;
};
const text = (selector: string): string =>
	(element(selector).textContent ?? "").replace(/\s+/g, " ").trim();
const count = (selector: string): number =>
	document.querySelectorAll(selector).length;
const settle = async (): Promise<void> => {
	for (
		let attempt = 0;
		attempt < 400 && element("#app").dataset.route !== window.location.hash;
		attempt += 1
	)
		await macrotask();
	await macrotask();
	await macrotask();
};
const open = async (
	hash: string,
	options: { reader?: Reader; writer?: Writer } = {},
): Promise<void> => {
	window.location.hash = hash;
	const container = document.createElement("div");
	container.id = "app";
	document.body.appendChild(container);
	unmount = mountApp(container, {
		reader: options.reader ?? createFixtureReader({ clock }),
		writer: options.writer ?? createFixtureWriter({ mode: "instant" }),
		clock,
	}).unmount;
	await settle();
};
const click = async (selector: string): Promise<void> => {
	element(selector).click();
	await settle();
};
const fill = async (selector: string, value: string): Promise<void> => {
	const control = element<HTMLInputElement>(selector);
	control.value = value;
	control.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
};
const go = async (hash: string): Promise<void> => {
	window.location.hash = hash;
	await settle();
};
const glowPrice = "[data-test=plan-row][data-plan=glow] [data-test=plan-price]";

afterEach(() => {
	unmount?.();
	unmount = null;
	document.body.innerHTML = "";
	window.location.hash = "";
});

test("the Plans pane reports its route only once the plans are on screen", async () => {
	window.location.hash = "#/vol/plans?theme=light";
	const container = document.createElement("div");
	container.id = "app";
	document.body.appendChild(container);
	let release: () => void = () => {};
	const reader = createFixtureReader({ clock });
	const slow: Reader = {
		...reader,
		planSummary: async (schoolId) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return reader.planSummary(schoolId);
		},
	};
	unmount = mountApp(container, {
		reader: slow,
		writer: createFixtureWriter({ mode: "instant" }),
		clock,
	}).unmount;
	await wait(30);
	expect(container.dataset.route).toBeUndefined();
	expect(count("[data-test=plan-row]")).toBe(0);
	release();
	await settle();
	expect(container.dataset.route).toBe("#/vol/plans?theme=light");
	expect(count("[data-test=plan-row]")).toBe(5);
});

test("the plans are read once; a draft kept for the school comes back after leaving the tab", async () => {
	let reads = 0;
	const reader = createFixtureReader({ clock });
	const counting: Reader = {
		...reader,
		menuVersions: (schoolId) => {
			reads += 1;
			return reader.menuVersions(schoolId);
		},
	};
	const writer = createFixtureWriter({ mode: "instant" });
	await open("#/vol/plans?theme=light", { reader: counting, writer });
	await click("[data-test=plan-discard]");
	await go("#/vol/bookings?theme=light");
	expect(count("[data-test=tab][data-tab=plans] [data-test=tab-badge]")).toBe(
		0,
	);
	await go("#/b4u/plans?theme=light");
	await go("#/vol/plans?theme=light");
	expect(text(glowPrice)).toBe("$65.00 / month · $702.00 / year");
	expect(count("[data-test=plan-draft-badge]")).toBe(0);
	expect(reads).toBe(2);
	expect(writer.calls.map(({ method }) => method)).toEqual(["saveMenu"]);
});

test("the tab's badge follows the draft: it appears with a change and goes with a discard", async () => {
	await open("#/b4u/plans?theme=light");
	expect(count("[data-test=tab][data-tab=plans] [data-test=tab-badge]")).toBe(
		0,
	);
	await click("[data-test=plan-row][data-plan=sparkle]");
	await fill("[data-test=plan-field][data-field=month]", "21");
	await click("[data-test=plan-drawer-save]");
	expect(text("[data-test=tab][data-tab=plans] [data-test=tab-badge]")).toBe(
		"draft",
	);
	await click("[data-test=plan-discard]");
	expect(count("[data-test=tab][data-tab=plans] [data-test=tab-badge]")).toBe(
		0,
	);
});

test("typed YAML is applied after a pause, once, and a draft with problems is not saved", async () => {
	const writer = createFixtureWriter({ mode: "instant" });
	await open("#/vol/plans?mode=code&theme=light", { writer });
	const original = element<HTMLTextAreaElement>("[data-test=plan-yaml]").value;
	const typed = (month: string): string =>
		original.replace("      month: 70\n", `      month: ${month}\n`);
	await fill("[data-test=plan-yaml]", typed("0"));
	expect(text("[data-test=plan-yaml-status]")).toBe("Valid");
	await wait(400);
	await settle();
	expect(text("[data-test=plan-yaml-status]")).toBe("1 problem");
	expect(writer.calls).toEqual([]);
	await fill("[data-test=plan-yaml]", typed("71"));
	await fill("[data-test=plan-yaml]", typed("72"));
	expect(writer.calls).toEqual([]);
	await wait(400);
	await settle();
	expect(writer.calls.map(({ method }) => method)).toEqual(["saveMenu"]);
	expect(text("[data-test=plan-yaml-status]")).toBe("Valid");
	await click("[data-test=plan-mode][data-mode=edit]");
	expect(text(glowPrice)).toBe("$72.00 / month · $702.00 / year");
});

test("Format rewrites the standard layout, and says so when the text does not parse", async () => {
	await open("#/vol/plans?mode=code&theme=light");
	const original = element<HTMLTextAreaElement>("[data-test=plan-yaml]").value;
	await fill("[data-test=plan-yaml]", `# my note\n${original}`);
	await click("[data-test=plan-yaml-format]");
	expect(text("[data-test=toast]")).toBe("Formatted.");
	expect(element<HTMLTextAreaElement>("[data-test=plan-yaml]").value).toBe(
		original,
	);
	await fill(
		"[data-test=plan-yaml]",
		original.replace("name: Sparkle", 'name: "Spark'),
	);
	await click("[data-test=plan-yaml-format]");
	expect(text("[data-test=toast]")).toBe("Fix line 11 before formatting.");
});

test("a save that fails says so and keeps the draft on screen", async () => {
	const writer: Writer = {
		...createFixtureWriter({ mode: "instant" }),
		saveMenu: () => Promise.reject(new Error("offline")),
	};
	await open("#/vol/plans?theme=light", { writer });
	await click("[data-test=plan-discard]");
	expect(text("[data-test=toast]")).toBe(
		"Could not save the draft. Try again.",
	);
	expect(text(glowPrice)).toBe("$65.00 / month · $702.00 / year");
});

test("a publish that fails leaves the review open, asks to try again and publishes nothing", async () => {
	const writer: Writer = {
		...createFixtureWriter({ mode: "instant" }),
		publishMenu: () => Promise.reject(new Error("offline")),
	};
	await open("#/vol/plans?theme=light", { writer });
	await click("[data-test=plan-review]");
	await fill("[data-test=plan-publish-pin]", "1234");
	await click("[data-test=plan-publish-go]");
	expect(text("[data-test=toast]")).toBe("Could not publish. Try again.");
	expect(count("[data-test=plan-publish-dialog]")).toBe(1);
	expect(text("[data-test=plan-publish-go]")).toBe("Publish v4");
	expect(text("[data-test=plan-version]")).toBe("v3 published");
});

test("Escape and the backdrop close the review, but not while a publish is pending", async () => {
	const writer = createFixtureWriter({ mode: "hold" });
	await open("#/vol/plans?theme=light", { writer });
	await click("[data-test=plan-review]");
	element("[data-test=plan-publish-dialog]").dispatchEvent(
		new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
	);
	await settle();
	expect(count("[data-test=plan-publish-dialog]")).toBe(0);
	await click("[data-test=plan-review]");
	await fill("[data-test=plan-publish-pin]", "1234");
	await click("[data-test=plan-publish-go]");
	element("[data-test=plan-publish-dialog]").dispatchEvent(
		new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
	);
	element(".bg").click();
	await settle();
	expect(count("[data-test=plan-publish-dialog]")).toBe(1);
	writer.release();
	await settle();
	expect(count("[data-test=plan-publish-dialog]")).toBe(0);
});

test("a person may not preview an audience above their own: the route's as= is ignored", async () => {
	await open("#/b4u/plans?as=owner&theme=light");
	expect(count("[data-test=plan-add][disabled]")).toBe(0);
	expect(count("[data-test=plan-stat]")).toBe(4);
	await go("#/b4u/plans?as=governance&theme=light");
	expect(count("[data-test=plan-add][disabled]")).toBe(2);
	expect(count("[data-test=plan-stat]")).toBe(0);
	expect(count("[data-test=plan-setup]")).toBe(0);
});

test("Get started's Connect Stripe opens the settings drawer, from its step and from Next", async () => {
	await open("#/nw/plans?theme=light");
	await click("[data-test=plan-setup-step][data-step=stripe]");
	expect(
		element("[data-test=settings-button]").getAttribute("aria-expanded"),
	).toBe("true");
	await click("[data-test=settings-button]");
	await click("[data-test=plan-setup-next]");
	expect(
		element("[data-test=settings-button]").getAttribute("aria-expanded"),
	).toBe("true");
});

test("the drawer's grants can be added up to the limit and removed down to one", async () => {
	await open("#/vol/plans?theme=light");
	await click("[data-test=plan-row][data-plan=glow]");
	for (const wanted of [2, 3]) {
		await click("[data-test=plan-grant-add]");
		expect(count("[data-test=plan-grant]")).toBe(wanted);
	}
	expect(count("[data-test=plan-grant-add][disabled]")).toBe(1);
	await click("[data-test=plan-grant-remove]");
	await click("[data-test=plan-grant-remove]");
	expect(count("[data-test=plan-grant]")).toBe(1);
	expect(count("[data-test=plan-grant-remove][disabled]")).toBe(1);
});

test("a pack charged once shows its grants' frequency as Once, and a monthly pack as each month", async () => {
	await open("#/vol/plans?theme=light");
	await click("[data-test=plan-row][data-plan=pack8]");
	const every = "[data-test=plan-grant-field][data-field=every]";
	expect(element<HTMLSelectElement>(every).value).toBe("once");
	expect(count(`${every}[disabled]`)).toBe(1);
	await fill("[data-test=plan-field][data-field=every]", "month");
	expect(element<HTMLSelectElement>(every).value).toBe("month");
	await click("[data-test=plan-drawer-save]");
	expect(
		text("[data-test=plan-row][data-plan=pack8] [data-test=plan-price]"),
	).toBe("$40.00 / month");
	expect(
		text("[data-test=plan-row][data-plan=pack8] [data-test=plan-grants]"),
	).toBe("8 sessions each month");
});
