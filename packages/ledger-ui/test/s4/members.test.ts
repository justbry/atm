import { afterEach, expect, test } from "bun:test";
import { mountApp } from "../../src/app/mount.tsx";
import type { Person } from "../../src/data/members.ts";
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
const row = (id: string): string => `[data-test=member-row][data-id=${id}]`;
const menuButton = (id: string): string =>
	`${row(id)} [data-test=member-menu-button]`;
const menuItem = (action: string): string =>
	`[data-test=member-menu-item][data-action=${action}]`;
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
const press = async (selector: string, key: string): Promise<void> => {
	element(selector).dispatchEvent(
		new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
	);
	await settle();
};
/** A key pressed where the focus is, as a real one is. */
const pressFocused = async (key: string): Promise<void> => {
	document.activeElement?.dispatchEvent(
		new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
	);
	await settle();
};
const fill = async (selector: string, value: string): Promise<void> => {
	const field = element<HTMLInputElement>(selector);
	field.value = value;
	field.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
};
const focusedAction = (): string | null =>
	document.activeElement?.getAttribute("data-action") ?? null;

afterEach(() => {
	unmount?.();
	unmount = null;
	document.body.innerHTML = "";
	window.location.hash = "";
});

const secondOwner: Person = {
	id: "u_zed",
	name: "Zed Q.",
	role: "owner",
	financeGrant: false,
	planHolder: false,
	memberKey: null,
	family: null,
	audience: "owner",
	audienceReason: "Owner on the roster",
	you: false,
	attention: [],
};
/** Vibes of Light with a second owner: no fixture school has one. */
const readerWithSecondOwner = (): Reader => {
	const reader = createFixtureReader({ clock });
	return {
		...reader,
		people: async (query) => [...(await reader.people(query)), secondOwner],
	};
};

test("the last owner cannot be removed", async () => {
	await open("#/vol/members");
	await click(menuButton("u_kim"));
	const item = element<HTMLButtonElement>(menuItem("remove-owner"));
	expect(item.disabled).toBe(true);
	expect(item.title).toBe("Last owner: add another owner first");
});

test("with a second owner, the signed-in owner cannot demote themselves but can remove the other, who then leaves the roster", async () => {
	const writer = createFixtureWriter({ mode: "instant" });
	await open("#/vol/members", { reader: readerWithSecondOwner(), writer });
	await click(menuButton("u_kim"));
	const self = element<HTMLButtonElement>(menuItem("remove-owner"));
	expect(self.disabled).toBe(true);
	expect(self.title).toBe("Owners can't demote themselves");
	await click(menuButton("u_kim"));
	await click(menuButton("u_zed"));
	expect(element<HTMLButtonElement>(menuItem("remove-owner")).disabled).toBe(
		false,
	);
	await click(menuItem("remove-owner"));
	expect(text("[data-test=modal-title]")).toBe("Remove Zed Q. as owner?");
	await click("[data-test=modal-confirm]");
	expect(writer.calls).toEqual([
		{
			method: "changeRole",
			args: [{ schoolId: "vol", personId: "u_zed", role: "member" }],
		},
	]);
	expect(count(row("u_zed"))).toBe(0);
	await click(menuButton("u_kim"));
	expect(element<HTMLButtonElement>(menuItem("remove-owner")).title).toBe(
		"Last owner: add another owner first",
	);
});

test("the keyboard opens the menu on its first item, walks the items that are on, and Escape returns to the button", async () => {
	await open("#/vol/members");
	await press(menuButton("m_204"), "ArrowDown");
	expect(focusedAction()).toBe("view-as-member");
	// Mia R. has nothing to release: that item is off and the walk skips it.
	await pressFocused("ArrowDown");
	expect(focusedAction()).toBe("invoice");
	await pressFocused("ArrowDown");
	await pressFocused("ArrowDown");
	expect(focusedAction()).toBe("refund");
	await pressFocused("ArrowDown");
	expect(focusedAction()).toBe("switch");
	await pressFocused("End");
	expect(focusedAction()).toBe("receipt");
	await pressFocused("ArrowDown");
	expect(focusedAction()).toBe("view-as-member");
	await pressFocused("ArrowUp");
	expect(focusedAction()).toBe("receipt");
	await pressFocused("Home");
	expect(focusedAction()).toBe("view-as-member");
	await press(menuItem("invoice"), "Escape");
	expect(count("[data-test=member-menu]")).toBe(0);
	expect(document.activeElement).toBe(element(menuButton("m_204")));
});

test("Tab leaves the menu, which closes", async () => {
	await open("#/vol/members");
	await press(menuButton("m_204"), "ArrowDown");
	await press(menuItem("view-as-member"), "Tab");
	expect(count("[data-test=member-menu]")).toBe(0);
});

test("Escape in the menu of the drawer closes the menu only; the next Escape closes the drawer", async () => {
	await open("#/vol/members?member=m_012");
	await press(
		"[data-test=member-drawer] [data-test=member-menu-button]",
		"ArrowDown",
	);
	expect(count("[data-test=member-menu]")).toBe(1);
	await press(menuItem("view-as-member"), "Escape");
	expect(count("[data-test=member-menu]")).toBe(0);
	expect(count("[data-test=member-drawer]")).toBe(1);
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
	await settle();
	expect(count("[data-test=member-drawer]")).toBe(0);
	expect(window.location.hash).not.toContain("member=");
});

test("closing the drawer puts focus back on the member who opened it", async () => {
	await open("#/vol/members");
	await click(`${row("m_093")} .member-open`);
	expect(count("[data-test=member-drawer]")).toBe(1);
	await click("[data-test=drawer-close]");
	expect(document.activeElement).toBe(element(`${row("m_093")} .member-open`));
});

test("a modal closed by Cancel hands focus back to the ⋯ button it came from", async () => {
	await open("#/vol/members");
	await click(menuButton("m_012"));
	await click(menuItem("adjust"));
	expect(count("[data-test=modal]")).toBe(1);
	await click("[data-test=modal-cancel]");
	expect(count("[data-test=modal]")).toBe(0);
	expect(document.activeElement).toBe(element(menuButton("m_012")));
});

test("Escape closes a modal, and the drawer behind it stays", async () => {
	await open("#/vol/members?member=m_012");
	await click("[data-test=drawer-action][data-action=adjust]");
	await pressFocused("Escape");
	expect(count("[data-test=modal]")).toBe(0);
	expect(count("[data-test=member-drawer]")).toBe(1);
});

test("a write that fails keeps the modal open, says so, and can be sent again", async () => {
	const reader = createFixtureReader({ clock });
	let attempts = 0;
	const base = createFixtureWriter({ mode: "instant" });
	const writer: Writer = {
		...base,
		adjustCredits: async (request) => {
			attempts += 1;
			if (attempts === 1) throw new Error("offline");
			return base.adjustCredits(request);
		},
	};
	await open("#/vol/members", { reader, writer });
	await click(menuButton("m_012"));
	await click(menuItem("adjust"));
	await fill("[data-test=modal-field][data-field=note]", "late cancel");
	await click("[data-test=modal-confirm]");
	expect(text("[data-test=toast]")).toBe("Could not send. Try again.");
	expect(count("[data-test=modal]")).toBe(1);
	expect(element<HTMLButtonElement>("[data-test=modal-confirm]").disabled).toBe(
		false,
	);
	await click("[data-test=modal-confirm]");
	expect(count("[data-test=modal]")).toBe(0);
	expect(text(`${row("m_012")} [data-test=member-available]`)).toBe(
		"20 → 22/32 +2 held",
	);
});

test("a held write changes nothing on screen until the Writer answers", async () => {
	const writer = createFixtureWriter({ mode: "hold" });
	await open("#/vol/members?member=m_204", { writer });
	await click(
		"[data-test=booking-action][data-action=noshow][data-booking=bk_8zz]",
	);
	expect(text("[data-test=modal-preview]")).toBe(
		"Rule: a no-show spends the sessions. 1 session are spent.",
	);
	await click("[data-test=modal-confirm]");
	expect(writer.calls).toEqual([
		{
			method: "recordOutcome",
			args: [{ schoolId: "vol", bookingId: "bk_8zz", state: "no_show" }],
		},
	]);
	expect(text(`${row("m_204")} [data-test=member-available]`)).toBe(
		"0/16 +1 held",
	);
	writer.release();
	await settle();
	expect(count("[data-test=modal]")).toBe(0);
	expect(text(`${row("m_204")} [data-test=member-available]`)).toBe("0/16");
	expect(text("[data-test=drawer-booking]")).toContain("waiting to ship");
});

test("the eye only navigates to the member portal route", async () => {
	await open("#/vol/members?theme=light");
	element(`${row("m_012")} [data-test=view-as-member]`).click();
	await macrotask();
	expect(window.location.hash).toBe("#/vol/members?theme=light&portal=m_012");
});

test("an admin preview shows the roster and keeps money to finance", async () => {
	await open("#/vol/members?as=admin&member=m_012");
	expect(count("[data-test=lock-panel]")).toBe(0);
	expect(text("[data-test=members-stat][data-stat=income] b")).toBe(
		"Finance only",
	);
	expect(text("[data-test=payment-row]:nth-child(1)")).toContain(
		"Finance only",
	);
	expect(element<HTMLButtonElement>("[data-test=payments-csv]").title).toBe(
		"Finance admins only",
	);
	expect(
		element<HTMLButtonElement>("[data-test=drawer-action][data-action=invoice]")
			.title,
	).toBe("Exit preview to act");
});

test("the search is not part of the route", async () => {
	await open("#/vol/members?theme=light");
	await fill("[data-test=member-search]", "ivy");
	expect(count("[data-test=member-row]")).toBe(1);
	expect(window.location.hash).toBe("#/vol/members?theme=light");
});

test("Download CSV saves the member's payments as a file, not a write, and counts the rows", async () => {
	const saved: Blob[] = [];
	const original = URL.createObjectURL;
	URL.createObjectURL = (blob: Blob | MediaSource) => {
		saved.push(blob as Blob);
		return "blob:test";
	};
	const writer = createFixtureWriter({ mode: "instant" });
	try {
		await open("#/vol/members", { writer });
		await click(menuButton("m_012"));
		await click(menuItem("csv"));
	} finally {
		URL.createObjectURL = original;
	}
	expect(text("[data-test=toast]")).toBe("Downloaded 30 rows");
	expect(writer.calls).toEqual([]);
	const file = await saved[0]?.text();
	const lines = (file ?? "").replace("﻿", "").split("\r\n");
	expect(lines[0]).toBe(
		"date,description,amount,currency,status,invoice_id,payment_id",
	);
	expect(lines[1]).toBe(
		'2026-11-01,"Invoice paid, Sparkle ×4 (10% off)",117.00,USD,Paid,in_m_012_20261101_0,pay_1114',
	);
	expect(lines).toHaveLength(32);
});

test("the fixture Writer records every Members write and, held, answers only on release", async () => {
	const writer = createFixtureWriter({ mode: "hold" });
	const requests = [
		writer.refund({
			schoolId: "vol",
			paymentIntentId: "pay_1114",
			amountCents: 11700,
			reason: "requested_by_customer",
			note: "duplicate charge",
		}),
		writer.sendInvoice({
			schoolId: "vol",
			familyId: "fam_m_012",
			addonId: "pack8",
		}),
		writer.grantFinance({ schoolId: "vol", subject: "m_093" }),
	];
	await macrotask();
	expect(writer.calls.map(({ method }) => method)).toEqual([
		"refund",
		"sendInvoice",
		"grantFinance",
	]);
	let answered = false;
	Promise.all(requests).then(() => {
		answered = true;
	});
	await macrotask();
	expect(answered).toBe(false);
	writer.release();
	const [refund, invoice, grant] = await Promise.all(requests);
	expect(refund).toMatchObject({ status: "pending", refundedCents: 11700 });
	expect(invoice).toMatchObject({ status: "open" });
	expect(grant).toEqual({ accepted: true });
});

test("the fixture Reader serves each school's fixture, and income is the months the period covers", async () => {
	const reader = createFixtureReader({ clock });
	expect(
		await reader.membersIncome({
			schoolId: "vol",
			from: "2026-10-01",
			to: "2026-11-30",
		}),
	).toBe(31000 + 28700);
	expect(
		(await reader.members({ schoolId: "vol", status: "canceled" })).members.map(
			({ profileId }) => profileId,
		),
	).toEqual(["m_051"]);
	expect((await reader.people({ schoolId: "nw" })).map(({ id }) => id)).toEqual(
		["u_len", "u_bo", "u_ula"],
	);
	await expect(
		reader.memberDetail({ schoolId: "vol", personId: "nobody" }),
	).rejects.toThrow("no member nobody in school vol");
});
