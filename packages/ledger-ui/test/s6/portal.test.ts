import { afterEach, expect, test } from "bun:test";
import type { Download } from "../../src/app/download.ts";
import { mountApp } from "../../src/app/mount.tsx";
import { historyCsv } from "../../src/app/portal-csv.ts";
import type { PortalHistoryRow } from "../../src/data/portal.ts";
import type { Writer } from "../../src/data/writer.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";

const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
const byteOrderMark = "﻿";
let unmount: (() => void) | null = null;
let files: Array<{ name: string; text: string }> = [];

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
	await macrotask();
	await macrotask();
};
const open = async (hash: string, writer?: Writer): Promise<void> => {
	window.location.hash = hash;
	const container = document.createElement("div");
	container.id = "app";
	document.body.appendChild(container);
	const download: Download = (file) => {
		files.push(file);
	};
	unmount = mountApp(container, {
		reader: createFixtureReader({ clock }),
		writer: writer ?? createFixtureWriter({ mode: "instant" }),
		clock,
		download,
	}).unmount;
	await settle();
};
const click = async (selector: string): Promise<void> => {
	element(selector).click();
	await settle();
};
const choose = async (selector: string, value: string): Promise<void> => {
	const select = element<HTMLSelectElement>(selector);
	select.value = value;
	select.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
};
/** The fixture Writer with one call made to fail. */
const failing = (method: keyof Writer): Writer => ({
	...createFixtureWriter({ mode: "instant" }),
	[method]: () => Promise.reject(new Error("offline")),
});

afterEach(() => {
	unmount?.();
	unmount = null;
	files = [];
	document.body.innerHTML = "";
	window.location.hash = "";
});

const family = "#/b4u/members?portal=s_21&portalTab=billing";

test("the family export is the whole history, one row per line, with a member column", async () => {
	await open(family);
	await click("[data-test=history-download]");
	const [file] = files;
	expect(files).toHaveLength(1);
	expect(file?.name).toBe("invoices-s_21-2024-12-01-2026-11-03.csv");
	const csv = file?.text ?? "";
	expect(csv.startsWith(byteOrderMark)).toBe(true);
	expect(csv.endsWith("\r\n")).toBe(true);
	const lines = csv.slice(byteOrderMark.length).split("\r\n");
	expect(lines[0]).toBe(
		"date,member,description,amount,currency,status,invoice_id,payment_id",
	);
	expect(lines).toHaveLength(1 + 86 + 1);
	expect(lines[1]).toStartWith(
		'2026-11-03,s_21,"Invoice paid, Shine ×2",90.00,USD,Paid,in_',
	);
	expect(lines[2]).toStartWith(
		'2026-10-31,s_21,"Invoice sent, Top-up pack (unpaid)",40.00,USD,Open,in_',
	);
	expect(
		lines.find((line) => line.includes("Refund, pack returned")),
	).toStartWith(
		'2025-11-22,s_21,"Refund, pack returned",-40.00,USD,Refunded,in_',
	);
	expect(new Set(lines.slice(1, -1).map((line) => line.split(",")[1]))).toEqual(
		new Set(["s_21", "s_25", "s_26"]),
	);
});

test("the export is the period the card shows, named by its first and last day", async () => {
	await open(`${family}&history=last`);
	await click("[data-test=history-download]");
	expect(files[0]?.name).toBe("invoices-s_21-2025-01-01-2025-12-01.csv");
	expect(files[0]?.text.split("\r\n")).toHaveLength(1 + 51 + 1);
	await choose("[data-test=history-period]", "this");
	await click("[data-test=history-download]");
	expect(files[1]?.name).toBe("invoices-s_21-2026-01-01-2026-11-03.csv");
	expect(files[1]?.text.split("\r\n")).toHaveLength(1 + 32 + 1);
});

test("a learner's export has no member column and holds only their rows", async () => {
	await open("#/b4u/members?portal=s_25&portalTab=billing");
	await click("[data-test=history-download]");
	const lines = (files[0]?.text ?? "")
		.slice(byteOrderMark.length)
		.split("\r\n");
	expect(files[0]?.name).toBe("invoices-s_25-2024-12-01-2026-10-31.csv");
	expect(lines[0]).toBe(
		"date,description,amount,currency,status,invoice_id,payment_id",
	);
	expect(lines).toHaveLength(1 + 28 + 1);
	expect(text("[data-test=toast]")).toBe("Downloaded 28 rows");
});

test("a text a spreadsheet would read as a formula is written as text, and quotes are doubled", () => {
	const row: PortalHistoryRow = {
		profileId: "s_1",
		date: "2026-01-02",
		description: '=SUM(1,1) "gift"',
		amountCents: -5,
		currency: "USD",
		status: "partly_refunded",
		invoiceId: "",
		paymentId: "",
		refundPending: false,
	};
	expect(historyCsv([row], false)).toBe(
		`${byteOrderMark}date,description,amount,currency,status,invoice_id,payment_id\r\n2026-01-02,"'=SUM(1,1) ""gift""",-0.05,USD,Partly refunded,,\r\n`,
	);
});

test("a decrease waits for the renewal and an increase shows what the server charged", async () => {
	await open("#/vol/members?portal=m_204");
	await click("[data-test=portal-action][data-action=quantity]");
	expect(text("[data-test=dialog-preview]")).toBe("No change.");
	await choose("[data-test=quantity-select]", "4");
	expect(text("[data-test=dialog-preview]")).toContain("From Dec 1: $130.00");
	await click("[data-test=dialog-confirm]");
	expect(text("[data-test=toast]")).toBe(
		"Upgraded to ×4. Charged $56.33 and 14 sessions added once it ships.",
	);
	expect(text("[data-test=portal-plan-name]")).toBe("Sparkle ×4");
	expect(text("[data-test=portal-plan-price]")).toBe("$130.00 / month");
});

test("a failed write says so and gives the buttons back", async () => {
	await open("#/b4u/members?portal=s_21", failing("portalCancelMembership"));
	await click("[data-test=portal-action][data-action=cancel]");
	await click("[data-test=dialog-confirm]");
	expect(text("[data-test=toast]")).toBe("Could not send. Try again.");
	expect(text("[data-test=portal-plan-status]")).toBe("Active");
	expect(count("[data-test=portal-plan-note]")).toBe(0);
	expect(count("[data-test=portal-action][data-action=cancel][disabled]")).toBe(
		0,
	);
});

test("a failed booking cancel offers the button again", async () => {
	await open(
		"#/b4u/members?portal=s_22&portalTab=bookings",
		failing("portalCancelBooking"),
	);
	await click("[data-test=portal-action][data-action=cancel-booking]");
	expect(text("[data-test=toast]")).toBe("Could not send. Try again.");
	expect(count("[data-test=portal-action][data-action=cancel-booking]")).toBe(
		1,
	);
	expect(count("[data-test=portal-booking-status]")).toBe(0);
});

test("Copy snippet puts the page snippet on the clipboard", async () => {
	const written: string[] = [];
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: async (value: string) => {
				written.push(value);
			},
		},
	});
	await open("#/b4u/members?portal=s_21");
	await click("[data-test=portal-embed]");
	await click("[data-test=embed-copy]");
	Reflect.deleteProperty(navigator, "clipboard");
	expect(written).toEqual([
		element("[data-test=embed-snippet][data-step=page]").textContent ?? "",
	]);
});

test("the top bar and tabs are out of reach while the portal covers them, and again after Exit", async () => {
	await open("#/b4u/members?portal=s_21&theme=light");
	expect(element(".top").hasAttribute("inert")).toBe(true);
	expect(element(".tabs").hasAttribute("inert")).toBe(true);
	await click("[data-test=portal-exit]");
	expect(element(".top").hasAttribute("inert")).toBe(false);
	expect(window.location.hash).toBe("#/b4u/members?theme=light");
});

test("the lock panel leaves the page usable", async () => {
	await open("#/b4u/members?portal=s_21&as=member");
	expect(count("[data-test=lock-panel]")).toBe(1);
	expect(element(".top").hasAttribute("inert")).toBe(false);
});

test("an audience above the signed-in person's own is not taken: the page opens as their own", async () => {
	await open("#/b4u/members?portal=s_21&as=owner");
	expect(count("[data-test=portal]")).toBe(1);
	expect(
		count("[data-test=portal-action][data-action=quantity][disabled]"),
	).toBe(0);
});

test("a portal for someone who does not exist leaves the page ready and the top bar usable", async () => {
	await open("#/b4u/members?portal=nobody");
	expect(count("[data-test=portal]")).toBe(0);
	expect(count("[data-test=lock-panel]")).toBe(0);
	expect(element(".top").hasAttribute("inert")).toBe(false);
});

test("switching family member keeps the tab and a change already made", async () => {
	await open("#/b4u/members?portal=s_21");
	await click("[data-test=portal-action][data-action=cancel]");
	await click("[data-test=dialog-confirm]");
	await click("[data-test=portal-family-switch][data-profile=s_25]");
	expect(text("[data-test=portal-plan-status]")).toBe("Active");
	await click("[data-test=portal-family-switch][data-profile=s_21]");
	expect(text("[data-test=portal-plan-status]")).toBe("Ends Dec 1");
	expect(text("[data-test=portal-plan-note]")).toBe(
		"A change is on its way. It can take a few minutes.",
	);
});
