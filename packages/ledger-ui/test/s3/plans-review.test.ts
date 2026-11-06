import { afterEach, expect, test } from "bun:test";
import { h, render } from "preact";
import { mountApp } from "../../src/app/mount.tsx";
import { PlanPublishDialog } from "../../src/app/plan-publish-dialog.tsx";
import { classOf } from "../../src/data/disclosure.ts";
import type { Menu } from "../../src/data/plans.ts";
import type { Reader } from "../../src/data/reader.ts";
import type { Writer } from "../../src/data/writer.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";

const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
let unmount: (() => void) | null = null;

const macrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
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
	for (let turn = 0; turn < 6; turn += 1) await macrotask();
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
const press = async (selector: string, key: string): Promise<void> => {
	element(selector).dispatchEvent(
		new KeyboardEvent("keydown", { key, bubbles: true }),
	);
	await settle();
};

const review = "[data-test=plan-review]";
const promoField = "input[aria-label='Promo code']";
const promoMessage = ".pvbar output.msg";
const sparkleRow = "[data-test=plan-row][data-plan=sparkle]";
const monthly = (plan: string): string =>
	`[data-test=plan-row][data-plan=${plan}] [data-test=plan-monthly]`;
const card = (plan: string): string =>
	`[data-test=plan-card][data-plan=${plan}]`;

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
/** A Writer whose saves and publishes are recorded, and whose saves wait for `release` or fail while `failing`. */
function controlledWriter(): {
	writer: Writer;
	calls: string[];
	pending: Deferred[];
	failing: { value: boolean };
} {
	const calls: string[] = [];
	const pending: Deferred[] = [];
	const failing = { value: false };
	const base = createFixtureWriter({ mode: "instant" });
	const writer: Writer = {
		...base,
		saveMenu: (_schoolId, _menu: Menu) => {
			calls.push("saveMenu");
			if (failing.value) return Promise.reject(new Error("offline"));
			const held = deferred();
			pending.push(held);
			return held.promise;
		},
		publishMenu: () => {
			calls.push("publishMenu");
			return Promise.resolve();
		},
	};
	return { writer, calls, pending, failing };
}
const editSparkleMonth = async (month: string): Promise<void> => {
	await click(sparkleRow);
	await fill("[data-test=plan-field][data-field=month]", month);
	await click("[data-test=plan-drawer-save]");
};

afterEach(() => {
	unmount?.();
	unmount = null;
	document.body.innerHTML = "";
	window.location.hash = "";
});

test("Monthly is the server's figure, kept when the draft price changes, and a dash where the server has none", async () => {
	await open("#/vol/plans?theme=light");
	expect(text(monthly("glow"))).toBe("$65.00");
	await click("[data-test=plan-row][data-plan=glow]");
	await fill("[data-test=plan-field][data-field=month]", "90");
	await click("[data-test=plan-drawer-save]");
	expect(
		text("[data-test=plan-row][data-plan=glow] [data-test=plan-price]"),
	).toContain("$90.00");
	expect(text(monthly("glow"))).toBe("$65.00");
	unmount?.();
	document.body.innerHTML = "";
	await open("#/b4u/plans?theme=light");
	expect(count("[data-test=plan-row][data-kind=tiers]")).toBeGreaterThan(0);
	expect(text(monthly("board"))).toBe("—");
	expect(text(monthly("board"))).not.toContain("$0");
});

test("Review and publish waits for the save, says why, and is off with the reason when the save failed", async () => {
	const { writer, pending, failing, calls } = controlledWriter();
	await open("#/vol/plans?theme=light", { writer });
	expect(element<HTMLButtonElement>(review).disabled).toBe(false);
	await editSparkleMonth("21");
	expect(element<HTMLButtonElement>(review).disabled).toBe(true);
	const reasonId = element(review).getAttribute("aria-describedby");
	expect(reasonId).not.toBeNull();
	expect(text(`#${reasonId}`)).toBe("Saving the draft…");
	pending[0]?.resolve();
	await settle();
	expect(element<HTMLButtonElement>(review).disabled).toBe(false);
	expect(element(review).getAttribute("aria-describedby")).toBeNull();

	failing.value = true;
	await editSparkleMonth("22");
	expect(element<HTMLButtonElement>(review).disabled).toBe(true);
	const failedId = element(review).getAttribute("aria-describedby") ?? "";
	expect(text(`#${failedId}`)).toContain("could not be saved");
	failing.value = false;
	await click("button.btn.s:not([data-test])");
	expect(text(`#${element(review).getAttribute("aria-describedby")}`)).toBe(
		"Saving the draft…",
	);
	pending[1]?.resolve();
	await settle();
	expect(element<HTMLButtonElement>(review).disabled).toBe(false);
	expect(calls).toEqual(["saveMenu", "saveMenu", "saveMenu"]);
});

test("Publish waits for a save still on its way, then calls publishMenu once", async () => {
	const { writer, pending, calls } = controlledWriter();
	await open("#/vol/plans?mode=code&theme=light", { writer });
	const original = element<HTMLTextAreaElement>("[data-test=plan-yaml]").value;
	await fill(
		"[data-test=plan-yaml]",
		original.replace("      month: 70\n", "      month: 71\n"),
	);
	await click(review);
	expect(calls).toEqual(["saveMenu"]);
	await fill("[data-test=plan-publish-pin]", "1234");
	await click("[data-test=plan-publish-go]");
	expect(calls).toEqual(["saveMenu"]);
	pending[0]?.resolve();
	await settle();
	expect(calls).toEqual(["saveMenu", "publishMenu"]);
});

test("a publish whose last save failed publishes nothing and says to retry the save", async () => {
	const { writer, calls, failing } = controlledWriter();
	await open("#/vol/plans?mode=code&theme=light", { writer });
	const original = element<HTMLTextAreaElement>("[data-test=plan-yaml]").value;
	failing.value = true;
	await fill(
		"[data-test=plan-yaml]",
		original.replace("      month: 70\n", "      month: 71\n"),
	);
	await click(review);
	await fill("[data-test=plan-publish-pin]", "1234");
	await click("[data-test=plan-publish-go]");
	expect(calls).toEqual(["saveMenu"]);
	expect(text("[data-test=toast]")).toBe(
		"The draft is not saved yet. Retry the save, then publish.",
	);
});

test("after a publish the Code view's stripe lines and Reset follow the new live version", async () => {
	const writer = createFixtureWriter({ mode: "instant" });
	await open("#/vol/plans?theme=light", { writer });
	await click("[data-test=plan-add][data-kind=addons]");
	await fill("[data-test=plan-field][data-field=name]", "Fresh pack");
	await fill("[data-test=plan-field][data-field=price]", "25");
	await click("[data-test=plan-drawer-save]");
	await click("[data-test=plan-mode][data-mode=code]");
	const before = element<HTMLTextAreaElement>("[data-test=plan-yaml]").value;
	expect(before).toContain("version: 3");
	expect(before).toContain("# stripe: created when you publish");
	expect(
		element<HTMLButtonElement>("[data-test=plan-yaml-reset]").disabled,
	).toBe(false);
	await click(review);
	await fill("[data-test=plan-publish-pin]", "1234");
	await click("[data-test=plan-publish-go]");
	expect(text("[data-test=plan-version]")).toBe("v4 published");
	const after = element<HTMLTextAreaElement>("[data-test=plan-yaml]").value;
	expect(after).toContain("version: 4");
	expect(after).not.toContain("created when you publish");
	expect(
		element<HTMLButtonElement>("[data-test=plan-yaml-reset]").disabled,
	).toBe(true);
	expect(writer.calls.map(({ method }) => method)).toEqual([
		"saveMenu",
		"publishMenu",
	]);
});

test("the family PIN reaches the publish handler and not the Writer", async () => {
	const handed: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	render(
		h(PlanPublishDialog, {
			schoolName: "Vibes of Light",
			fromVersion: 3,
			changes: [],
			affectedMembers: 0,
			owner: true,
			pending: false,
			onPublish: (pin: string) => handed.push(pin),
			onCancel: () => undefined,
		}),
		container,
	);
	const pinField = element<HTMLInputElement>("[data-test=plan-publish-pin]");
	pinField.value = "4821";
	pinField.dispatchEvent(new Event("input", { bubbles: true }));
	await macrotask();
	element("[data-test=plan-publish-go]").click();
	await macrotask();
	expect(handed).toEqual(["4821"]);
	render(null, container);
	container.remove();

	const writer = createFixtureWriter({ mode: "instant" });
	await open("#/vol/plans?theme=light", { writer });
	await click(review);
	await fill("[data-test=plan-publish-pin]", "4821");
	await click("[data-test=plan-publish-go]");
	expect(writer.calls).toEqual([{ method: "publishMenu", args: ["vol"] }]);
});

test("a promo code of the school takes its percent off the memberships, with Apply and with Enter", async () => {
	await open("#/vol/plans?mode=preview&show=live&theme=light");
	expect(element(promoField).getAttribute("placeholder")).toBe("Promo code");
	expect(text(`${card("sparkle")} [data-test=plan-card-price]`)).toBe("$32.50");
	await fill(promoField, "spring10");
	await click("button.promo-apply");
	expect(text(promoMessage)).toBe("SPRING10: 10% off memberships");
	expect(count(`${promoMessage} svg`)).toBe(1);
	expect(text(`${card("sparkle")} .pr s`)).toBe("$32.50");
	expect(text(`${card("sparkle")} [data-test=plan-card-price]`)).toBe("$29.25");
	expect(count(`${card("pack8")} .pr s`)).toBe(0);
	expect(text(`${card("pack8")} [data-test=plan-card-price]`)).toBe("$40.00");

	await fill(promoField, "gift50-7qx2");
	await press(promoField, "Enter");
	expect(text(promoMessage)).toBe("Not a valid code here");
	expect(count(`${card("sparkle")} .pr s`)).toBe(0);
	await fill(promoField, "SPRING10");
	await press(promoField, "Enter");
	expect(text(promoMessage)).toBe("SPRING10: 10% off memberships");
});

test("the audience hint names the grain the school's Member rule gives", async () => {
	const reader = createFixtureReader({ clock });
	const monthly: Reader = {
		...reader,
		disclosure: async (schoolId) => {
			const disclosure = await reader.disclosure(schoolId);
			const kpiClass = classOf(disclosure.file, "gross_collected");
			if (!kpiClass || kpiClass === "personal")
				throw new Error("gross_collected has no ruled class");
			const rule = disclosure.file.disclose[kpiClass]?.member;
			if (!rule) throw new Error("the Member audience has no rule");
			return {
				...disclosure,
				file: {
					...disclosure.file,
					disclose: {
						...disclosure.file.disclose,
						[kpiClass]: {
							...disclosure.file.disclose[kpiClass],
							member: { ...rule, every: "month" },
						},
					},
				},
			};
		},
	};
	await open("#/vol/plans?theme=light");
	await click(sparkleRow);
	expect(text("[data-test=plan-drawer-hint]")).toContain(
		"Member: quarters, money rounded",
	);
	unmount?.();
	document.body.innerHTML = "";
	await open("#/vol/plans?theme=light", { reader: monthly });
	await click(sparkleRow);
	expect(text("[data-test=plan-drawer-hint]")).toContain(
		"Member: months, money rounded",
	);
});

test("Reset to published follows the one set of changes: off when there are none", async () => {
	await open("#/vol/plans?mode=code&theme=light");
	expect(count("[data-test=plan-change]")).toBeGreaterThan(0);
	expect(
		element<HTMLButtonElement>("[data-test=plan-yaml-reset]").disabled,
	).toBe(false);
	await click("[data-test=plan-yaml-reset]");
	expect(count("[data-test=plan-change]")).toBe(0);
	expect(
		element<HTMLButtonElement>("[data-test=plan-yaml-reset]").disabled,
	).toBe(true);
});

test("a plan card is a plain container with a real Edit button, and Choose is a tab stop", async () => {
	await open("#/vol/plans?mode=preview&theme=light");
	const glow = element(card("glow"));
	expect(glow.getAttribute("role")).toBeNull();
	expect(glow.getAttribute("tabindex")).toBeNull();
	expect(count("[data-test=plan-card][role]")).toBe(0);
	expect(count("[data-test=plan-card] [role=button]")).toBe(0);
	for (const choose of document.querySelectorAll("[data-test=plan-choose]"))
		expect(choose.getAttribute("tabindex")).toBeNull();
	const edit = element<HTMLButtonElement>(
		`${card("glow")} button[aria-label='Edit Glow']`,
	);
	expect(edit.tagName).toBe("BUTTON");
	await click(`${card("glow")} button[aria-label='Edit Glow']`);
	expect(count("[data-test=plan-drawer]")).toBe(1);
});

test("the Code view has one live region, and the parse error is not a second alert inside it", async () => {
	await open("#/vol/plans?mode=code&theme=light");
	const original = element<HTMLTextAreaElement>("[data-test=plan-yaml]").value;
	await fill(
		"[data-test=plan-yaml]",
		original.replace("name: Sparkle", 'name: "Spark'),
	);
	expect(count("[data-test=plan-yaml-message] .err")).toBe(1);
	expect(count("[data-test=plan-yaml-message][aria-live=polite]")).toBe(1);
	expect(count("[data-test=plan-yaml-message] [role=alert]")).toBe(0);
	expect(count("[data-test=plan-yaml-message] [aria-live]")).toBe(0);
});

test("the review says 'keeps' for one current member and 'keep' for more", async () => {
	await open("#/vol/plans?theme=light");
	await click(review);
	expect(text("[data-test=plan-publish-summary]")).toContain(
		"1 current member keeps the version they bought.",
	);
	await click("[data-test=plan-publish-cancel]");
	await editSparkleMonth("21");
	await click(review);
	expect(text("[data-test=plan-publish-summary]")).toContain(
		"4 current members keep the version they bought.",
	);
});

test("leaving the tab mid-save keeps the save's status: pending on return, failed if it failed meanwhile", async () => {
	const { writer, pending, failing } = controlledWriter();
	await open("#/vol/plans?theme=light", { writer });
	await editSparkleMonth("21");
	expect(element<HTMLButtonElement>(review).disabled).toBe(true);
	await click("[data-tab=dashboard]");
	await click("[data-tab=plans]");
	// The save is still on its way: the pane must not say "saved".
	expect(element<HTMLButtonElement>(review).disabled).toBe(true);
	expect(text(`#${element(review).getAttribute("aria-describedby")}`)).toBe(
		"Saving the draft…",
	);
	pending[0]?.resolve();
	await settle();
	expect(element<HTMLButtonElement>(review).disabled).toBe(false);

	// A save that is rejected while the tab is away is failed on return, with Retry save.
	let rejectSave: () => void = () => {};
	const slow: Writer = {
		...writer,
		saveMenu: () =>
			new Promise<void>((_resolve, reject) => {
				rejectSave = () => reject(new Error("offline"));
			}),
	};
	unmount?.();
	document.body.innerHTML = "";
	failing.value = false;
	await open("#/vol/plans?theme=light", { writer: slow });
	await editSparkleMonth("22");
	await click("[data-tab=dashboard]");
	rejectSave();
	await settle();
	await click("[data-tab=plans]");
	expect(element<HTMLButtonElement>(review).disabled).toBe(true);
	expect(
		text(`#${element(review).getAttribute("aria-describedby")}`),
	).toContain("could not be saved");
	expect(
		[...document.querySelectorAll("button")].some(({ textContent }) =>
			textContent?.includes("Retry save"),
		),
	).toBe(true);
});
