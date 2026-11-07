import { afterEach, expect, test } from "bun:test";
import { h, render } from "preact";
import { QuantityDialog } from "../../src/app/portal-dialogs.tsx";
import type { Plan } from "../../src/app/portal-format.ts";
import { historyCsvColumns, type PortalMember } from "../../src/data/portal.ts";
import type { DashboardOptions, School } from "../../src/data/types.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";
import {
	cleanUp,
	click,
	clock,
	count,
	element,
	open,
	settle,
	text,
} from "../s5/helpers.ts";

const macrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
const row = (id: string): string => `[data-test=member-row][data-id=${id}]`;
const tabButton = (id: string): string =>
	`[data-test=portal-tab][data-portal-tab=${id}]`;
const keyDown = async (selector: string, key: string): Promise<void> => {
	element(selector).dispatchEvent(
		new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
	);
	await settle();
};

afterEach(cleanUp);

test("a booking cancelled in the portal stays on its way after Exit and reopening, and the roster drawer shows it too", async () => {
	await open("#/b4u/members?portal=s_22&portalTab=bookings");
	await click("[data-test=portal-action][data-action=cancel-booking]");
	expect(text("[data-test=portal-booking-status]")).toBe("waiting to ship");
	await click("[data-test=portal-exit]");
	await click(`${row("s_22")} [data-test=view-as-member]`);
	await click(tabButton("bookings"));
	expect(count("[data-test=portal-action][data-action=cancel-booking]")).toBe(
		0,
	);
	expect(text("[data-test=portal-booking-status]")).toBe("waiting to ship");
	await click("[data-test=portal-exit]");
	await click(`${row("s_22")} .member-open`);
	expect(text("[data-test=drawer-booking]")).toContain("waiting to ship");
});

test("a membership change sent stays sent after Exit and reopening", async () => {
	await open("#/b4u/members?portal=s_21");
	await click("[data-test=portal-action][data-action=cancel]");
	await click("[data-test=dialog-confirm]");
	await click("[data-test=portal-exit]");
	await click(`${row("s_21")} [data-test=view-as-member]`);
	expect(text("[data-test=portal-plan-status]")).toBe("Ends Dec 1");
	expect(text("[data-test=portal-plan-note]")).toBe(
		"A change is on its way. It can take a few minutes.",
	);
	expect(count("[data-test=portal-action][data-action=resume][disabled]")).toBe(
		1,
	);
	expect(
		count("[data-test=portal-action][data-action=quantity][disabled]"),
	).toBe(1);
});

test("a portal for someone who does not exist shows the Members tab without a portal", async () => {
	await open("#/b4u/members?portal=nobody");
	expect(count("[data-test=portal]")).toBe(0);
	expect(count(row("s_21"))).toBe(1);
	expect(element(".top").hasAttribute("inert")).toBe(false);
	expect(element(".tabs").hasAttribute("inert")).toBe(false);
});

test("the portal tabs follow the tabs pattern: one tab stop, arrows, Home and End, and a panel they control", async () => {
	await open("#/b4u/members?portal=s_21");
	const tabs = [
		...document.querySelectorAll<HTMLElement>("[data-test=portal-tab]"),
	];
	expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
	const panel = element("[data-test=portal-frame] [role=tabpanel]");
	expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel.id);
	expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0]?.id ?? "");
	expect(
		count("[data-test=portal-tab]:not([aria-selected=true])[aria-controls]"),
	).toBe(0);
	await keyDown(tabButton("overview"), "ArrowRight");
	expect(window.location.hash).toContain("portalTab=bookings");
	expect(document.activeElement).toBe(element(tabButton("bookings")));
	expect(element(tabButton("bookings")).tabIndex).toBe(0);
	await keyDown(tabButton("bookings"), "End");
	expect(window.location.hash).toContain("portalTab=family");
	await keyDown(tabButton("family"), "ArrowRight");
	expect(window.location.hash).not.toContain("portalTab");
	await keyDown(tabButton("overview"), "ArrowLeft");
	expect(window.location.hash).toContain("portalTab=family");
	await keyDown(tabButton("family"), "Home");
	expect(window.location.hash).not.toContain("portalTab");
});

test("the history download writes the contract's columns", async () => {
	const written: string[] = [];
	const createObjectURL = URL.createObjectURL;
	const linkClick = HTMLAnchorElement.prototype.click;
	const blobs: Blob[] = [];
	URL.createObjectURL = (blob: Blob | MediaSource) => {
		blobs.push(blob as Blob);
		return "blob:test";
	};
	HTMLAnchorElement.prototype.click = function capture(
		this: HTMLAnchorElement,
	) {
		const blob = blobs.shift();
		if (blob) blob.text().then((csv) => written.push(csv));
	};
	try {
		await open("#/b4u/members?portal=s_25&portalTab=billing");
		await click("[data-test=history-download]");
		await macrotask();
	} finally {
		URL.createObjectURL = createObjectURL;
		HTMLAnchorElement.prototype.click = linkClick;
	}
	const [header] = (written[0] ?? "").slice(1).split("\r\n");
	expect(header).toBe(historyCsvColumns(false).join(","));
});

const quantitySchool = {
	currency: "USD",
	creditUnit: { one: "session", other: "sessions" },
} as School;
const offered = (quantity: number, priceCents: number) => ({
	quantity,
	priceCents,
});
const quantityMember = {
	name: "Mia R.",
	tierName: "Sparkle",
	quantity: 2,
	priceCents: 9000,
	quantityOptions: [offered(1, 4500), offered(3, 13000)],
} as unknown as PortalMember;
const quantityPlan: Plan = {
	quantity: 2,
	priceCents: 9000,
	label: "Sparkle ×2",
	ended: false,
	endsOn: "Dec 1",
	scheduled: null,
	waiting: false,
};

test("Change amount never shows an invented $0 when the current amount is no longer offered", async () => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	render(
		h(QuantityDialog, {
			school: quantitySchool,
			viewed: quantityMember,
			plan: quantityPlan,
			onClose: () => undefined,
			onConfirm: () => undefined,
		}),
		container,
	);
	expect(text("[data-test=dialog-preview]")).toBe("No change.");
	const select = element<HTMLSelectElement>("[data-test=quantity-select]");
	select.value = "3";
	select.dispatchEvent(new Event("input", { bubbles: true }));
	await macrotask();
	expect(text("[data-test=dialog-preview]")).toContain("$130.00");
	expect(text("[data-test=dialog]")).not.toContain("$0.00");
	render(null, container);
});

test("opening the portal from the ⋯ menu focuses the Viewing as bar; Exit returns focus to the row's ⋯ button", async () => {
	await open("#/b4u/members");
	await click(`${row("s_21")} [data-test=member-menu-button]`);
	await click("[data-test=member-menu-item][data-action=view-as-member]");
	expect(document.activeElement).toBe(element("[data-test=portal-viewing]"));
	await click("[data-test=portal-exit]");
	await macrotask();
	expect(document.activeElement).toBe(
		element(`${row("s_21")} [data-test=member-menu-button]`),
	);
});

test("Escape returns focus to the row too", async () => {
	await open("#/b4u/members?portal=s_21");
	document.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
	);
	await settle();
	await macrotask();
	expect(document.activeElement).toBe(
		element(`${row("s_21")} [data-test=member-menu-button]`),
	);
});

test("the history table keeps scope=col headers, and the stacked layout hides them visually, not from the page", async () => {
	await open("#/b4u/members?portal=s_21&portalTab=billing");
	const headers = [...document.querySelectorAll(".mpt.k thead th")];
	expect(headers.map((header) => header.getAttribute("scope"))).toEqual([
		"col",
		"col",
		"col",
		"col",
	]);
	const css = await Bun.file(
		new URL("../../src/theme.css", import.meta.url),
	).text();
	const stacked = css.slice(
		css.indexOf("@media (max-width: 520px) {\n\t.mpt.k,"),
	);
	const rule = /\.mpt\.k thead \{([^}]*)\}/.exec(stacked)?.[1] ?? "";
	expect(rule).not.toContain("display: none");
	expect(rule).toContain("clip: rect(0 0 0 0)");
});

test("the portal fills the viewport, not a fixed-height box", async () => {
	const css = await Bun.file(
		new URL("../../src/theme.css", import.meta.url),
	).text();
	const rule = /\n\.vm \{([^}]*)\}/.exec(css)?.[1] ?? "";
	expect(rule).toContain("position: fixed");
	expect(rule).toContain("inset: 0");
});

test("a school with no dashboard preset still opens the portal, without the School books figures", async () => {
	const reader = createFixtureReader({ clock });
	await open("#/b4u/members?portal=s_21", {
		reader: {
			...reader,
			dashboardOptions: async () => ({
				...(await reader.dashboardOptions()),
				// the contract promises one preset; the portal must not read past an empty list
				presets: [] as unknown as DashboardOptions["presets"],
			}),
		},
		writer: createFixtureWriter({ mode: "instant" }),
	});
	expect(count("[data-test=portal]")).toBe(1);
	expect(count("[data-test=books-card] [data-kpi]")).toBe(0);
});
