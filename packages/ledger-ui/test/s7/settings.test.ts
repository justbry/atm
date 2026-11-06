import { afterEach, expect, test } from "bun:test";
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
