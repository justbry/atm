import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mountApp } from "../../src/app/mount.tsx";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";
import {
	cleanup,
	click,
	clock,
	count,
	element,
	fill,
	open,
	press,
	settle,
	text,
} from "./helpers.ts";

afterEach(cleanup);

const stepUpDraft = async (): Promise<void> => {
	await fill("[data-test=override-field][data-field=rule-audience]", "public");
	await fill("[data-test=override-field][data-field=every]", "quarter");
	await click("[data-test=disclosure-save]");
	await fill("[data-test=dialog-field][data-field=pin]", "1234");
	await click("[data-test=dialog-confirm]");
};

test("a dialog takes Escape: it closes alone and the drawer stays open", async () => {
	await open("#/vol/plans");
	await click("[data-test=settings-button]");
	await click("[data-test=key-revoke][data-key=k1]");
	expect(count("[data-test=dialog]")).toBe(1);
	await press(document.body, "Escape");
	expect(count("[data-test=dialog]")).toBe(0);
	expect(element(".drawer").classList.contains("on")).toBe(true);
	await press(document.body, "Escape");
	expect(element(".drawer").classList.contains("on")).toBe(false);
});

test("what a write changed is still there when the drawer is closed and opened again", async () => {
	await open("#/vol/plans");
	await click("[data-test=settings-button]");
	await click("[data-test=stripe-remove]");
	await fill("[data-test=dialog-field][data-field=pin]", "1234");
	await click("[data-test=dialog-confirm]");
	expect(count("[data-test=stripe-check]")).toBe(0);
	await click("[data-test=basis-option][data-basis=deferred]");
	await click("[data-test=basis-save]");
	await press(document.body, "Escape");
	await click("[data-test=settings-button]");
	expect(text("[data-test=connection-row][data-connection=stripe]")).toContain(
		"Not connected",
	);
	expect(count("[data-test=basis-option][data-basis=deferred].on")).toBe(1);
});

test("a created key is listed with its prefix and the secret is shown once", async () => {
	const writer = await open("#/vol/plans");
	await click("[data-test=settings-button]");
	await click("[data-test=key-create]");
	await click("[data-test=key-create-option][data-kind=sk]");
	await fill("[data-test=dialog-field][data-field=label]", "Server");
	await click("[data-test=dialog-confirm]");
	expect(text("[data-test=dialog-title]")).toBe("Key created");
	const secret = text(".codebig");
	expect(secret.startsWith("b4u_sk_live_")).toBe(true);
	await click("[data-test=dialog-confirm]");
	expect(document.body.textContent).not.toContain(secret);
	expect(writer.calls.map(({ method }) => method)).toEqual(["createKey"]);
	const created = [...document.querySelectorAll("[data-test=key-row]")].pop();
	expect(created?.textContent).toContain("Server");
	expect(created?.textContent).toContain(`${secret.slice(0, 15)}…`);
});

test("a write that fails keeps its dialog open and says so", async () => {
	const reader = createFixtureReader({ clock });
	const writer = createFixtureWriter({ mode: "instant" });
	window.location.hash = "#/vol/plans";
	const container = document.createElement("div");
	container.id = "app";
	document.body.appendChild(container);
	const { unmount } = mountApp(container, {
		reader,
		writer: {
			...writer,
			revokeKey: () => Promise.reject(new Error("offline")),
		},
		clock,
	});
	try {
		await settle();
		await click("[data-test=settings-button]");
		await click("[data-test=key-revoke][data-key=k1]");
		await click("[data-test=dialog-confirm]");
		expect(text("[data-test=dialog] [role=alert]")).toBe(
			"Could not save. Try again.",
		);
		expect(count("[data-test=key-row]")).toBe(3);
		expect(count("[data-test=dialog-confirm][aria-busy=true]")).toBe(0);
	} finally {
		unmount();
	}
});

test("a confirmed step-up becomes the saved disclosure: nothing left to reset or save", async () => {
	await open("#/vol/plans");
	await click("[data-test=settings-button]");
	await stepUpDraft();
	await click("[data-test=dialog-confirm]");
	expect(count("[data-test=dialog]")).toBe(0);
	expect(text("[data-test=override-message]")).toBe(
		"No changes. The school uses the B4 Uni file plus its saved override.",
	);
	expect(count("[data-test=disclosure-save][disabled]")).toBe(1);
	expect(count("[data-test=disclosure-reset][disabled]")).toBe(1);
	expect(
		text(
			"[data-test=disclosure-cell][data-class=income][data-audience=public]",
		),
	).toBe("categories · quarter · 12 months");
});

test("a cancelled step-up leaves the draft to reset", async () => {
	await open("#/vol/plans");
	await click("[data-test=settings-button]");
	await stepUpDraft();
	await click("[data-test=dialog-cancel]");
	expect(count("[data-test=disclosure-reset]:not([disabled])")).toBe(1);
	await click("[data-test=disclosure-reset]");
	expect(text("[data-test=override-message]")).toBe(
		"No changes. The school uses the B4 Uni file.",
	);
});

test("the Public step-up asks the Writer twice, the second only after the link is opened", async () => {
	const writer = await open("#/vol/plans", { mode: "hold" });
	await click("[data-test=settings-button]");
	await stepUpDraft();
	expect(writer.calls.map(({ method }) => method)).toEqual(["saveDisclosure"]);
	writer.release();
	await settle();
	await click("[data-test=dialog-confirm]");
	expect(writer.calls.map(({ method }) => method)).toEqual([
		"saveDisclosure",
		"confirmDisclosureStepUp",
	]);
});

test("moving a KPI to another class shows in the table and the KPI list", async () => {
	await open("#/vol/plans");
	await click("[data-test=settings-button]");
	await fill("[data-test=override-field][data-field=kpi]", "arpa");
	await fill("[data-test=override-field][data-field=class]", "income");
	expect(text("[data-test=disclosure-kpis][data-class=people]")).toBe(
		"paying_members, new_paying_members",
	);
	expect(text("[data-test=disclosure-kpis][data-class=income]")).toContain(
		"arpa",
	);
});

test("an admin reads the settings: the write controls do nothing and the editor is read-only", async () => {
	const writer = await open("#/b4u/plans");
	await click("[data-test=settings-button]");
	element("[data-test=key-revoke]").click();
	element("[data-test=basis-save]").click();
	expect(count("[data-test=dialog]")).toBe(0);
	expect(writer.calls).toEqual([]);
	expect(count("[data-test=override-field]:not([disabled])")).toBe(0);
});

test("a viewer below the admins gets the lock panel in place of the table, whoever previews", async () => {
	await open("#/vol/plans?as=governance");
	await click("[data-test=settings-button]");
	expect(count("[data-test=lock-panel][data-surface=settings-books]")).toBe(1);
	expect(count("[data-test=disclosure-cell]")).toBe(0);
	expect(count("[data-test=override-field]")).toBe(0);
});

test("a Canadian school's settings write money as C$, from the same rule as every other figure", async () => {
	await open("#/map/plans");
	await click("[data-test=settings-button]");
	expect(text("[data-test=basis-note]")).toContain("C$");
	expect(text("[data-test=rounding-note]")).toContain("C$");
	expect(text("[data-test=rounding-note]")).not.toContain("CA$");
});

test("Copy key and Copy all write to the clipboard, then toast; a refused clipboard gets an honest failure toast", async () => {
	const copied: string[] = [];
	let allowed = true;
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: (value: string) => {
				if (!allowed) return Promise.reject(new Error("blocked"));
				copied.push(value);
				return Promise.resolve();
			},
		},
	});
	try {
		await open("#/vol/plans");
		await click("[data-test=settings-button]");
		await click("[data-test=key-create]");
		await click("[data-test=key-create-option][data-kind=sk]");
		await fill("[data-test=dialog-field][data-field=label]", "Server");
		await click("[data-test=dialog-confirm]");
		const secret = text(".codebig");
		await click("[data-test=dialog] .row2 button");
		expect(copied).toEqual([secret]);
		expect(text("[data-test=toast]")).toBe("Key copied.");
		allowed = false;
		await click("[data-test=dialog] .row2 button");
		expect(copied).toEqual([secret]);
		expect(text("[data-test=toast]")).toStartWith("Could not copy");
		await click("[data-test=dialog-confirm]");

		allowed = true;
		await click("[data-test=key-create]");
		await click("[data-test=key-create-option][data-kind=rd]");
		await fill("[data-test=dialog-field][data-field=label]", "Reader");
		await click("[data-test=dialog-confirm]");
		const credential = element(".pre").textContent ?? "";
		await click("[data-test=dialog] .row2 button");
		expect(copied.at(-1)).toBe(credential);
		expect(text("[data-test=toast]")).toBe("Credential copied.");
	} finally {
		Reflect.deleteProperty(navigator, "clipboard");
	}
});

test("opening the drawer focuses Close without scrolling the frame", async () => {
	const calls: Array<FocusOptions | undefined> = [];
	const focus = HTMLElement.prototype.focus;
	HTMLElement.prototype.focus = function (options?: FocusOptions): void {
		if (this.classList.contains("x")) calls.push(options);
		focus.call(this, options);
	};
	try {
		await open("#/vol/plans");
		await click("[data-test=settings-button]");
		expect(calls).toEqual([{ preventScroll: true }]);
	} finally {
		HTMLElement.prototype.focus = focus;
	}
});

test("a dialog is fixed to the viewport and capped to the screen, so its title shows wherever the page is scrolled", () => {
	const css = readFileSync(
		new URL("../../src/theme.css", import.meta.url),
		"utf8",
	);
	expect(css).toMatch(/\.bg \{[^}]*position: fixed;/);
	expect(css).toMatch(/\.modal \{[^}]*max-width: calc\(100vw - 24px\);/);
});

test("the PIN dialog hands the opener to the step-up dialog: focus goes back to Check and save only when the last dialog closes", async () => {
	const returned: string[] = [];
	const focus = HTMLElement.prototype.focus;
	HTMLElement.prototype.focus = function (options?: FocusOptions): void {
		if (this.getAttribute("data-test") === "disclosure-save")
			returned.push("save");
		focus.call(this, options);
	};
	try {
		await open("#/vol/plans");
		await click("[data-test=settings-button]");
		await fill(
			"[data-test=override-field][data-field=rule-audience]",
			"public",
		);
		await fill("[data-test=override-field][data-field=every]", "quarter");
		element("[data-test=disclosure-save]").focus();
		returned.length = 0;
		await click("[data-test=disclosure-save]");
		await fill("[data-test=dialog-field][data-field=pin]", "1234");
		await click("[data-test=dialog-confirm]");
		expect(text("[data-test=dialog-title]")).toContain(
			"Confirm by email: this publishes your books",
		);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(returned).toEqual([]);
		await click("[data-test=dialog-confirm]");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(count("[data-test=dialog]")).toBe(0);
		expect(returned).toEqual(["save"]);
	} finally {
		HTMLElement.prototype.focus = focus;
	}
});
