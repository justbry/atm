import { afterEach, expect, test } from "bun:test";
import { cleanUp, count, element, open, text } from "../s5/helpers.ts";

afterEach(cleanUp);

// ---- Round 7: the member portal reads as the mockup's `mpBal` and `mpBooks` do

test("the allowance line says no further refresh for an ending membership, and the renewal date for an active one", async () => {
	await open("#/vol/members?portal=m_051");
	expect(text("[data-test=portal-plan-status]")).toBe("Ends Nov 11");
	expect(text("[data-test=portal-balance]")).toContain(
		"No further refresh: your membership ends on Nov 11.",
	);
	expect(text("[data-test=portal-balance]")).not.toContain("refreshes on");
	cleanUp();
	await open("#/b4u/members?portal=s_21");
	expect(text("[data-test=portal-balance]")).toContain(
		"Your allowance refreshes on Dec 1.",
	);
});

test("School books puts the lock before 'Members see this' where the net is withheld", async () => {
	await open("#/vol/members?portal=m_051");
	const net = element(
		'[data-test=books-card] [data-kpi="net_income"][data-period="2024"]',
	);
	expect(net.className).toBe("khid");
	expect(net.dataset.hid).toBe("members_only");
	expect(net.firstElementChild?.tagName.toLowerCase()).toBe("svg");
	expect(net.textContent).toBe("Members see this");
	expect(text("[data-test=books-text]")).toContain(
		"2024: — collected, Members see this net.",
	);
	// A suppressed amount stays the bare dash, with no lock.
	const gross = element(
		'[data-test=books-card] [data-kpi="gross_collected"][data-period="2024"]',
	);
	expect(gross.className).toBe("kcutv");
	expect(count('[data-test=books-card] [data-kpi="gross_collected"] svg')).toBe(
		0,
	);
});

test("the Viewing as badge shows no focus ring after a pointer open, and shows it after a keyboard open", async () => {
	window.dispatchEvent(new Event("pointerdown"));
	await open("#/b4u/members?portal=s_21");
	const badge = element("[data-test=portal-viewing]");
	expect(document.activeElement).toBe(badge);
	expect(badge.hasAttribute("data-pointer-focus")).toBe(true);
	cleanUp();
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
	await open("#/b4u/members?portal=s_21");
	const keyboardBadge = element("[data-test=portal-viewing]");
	expect(document.activeElement).toBe(keyboardBadge);
	expect(keyboardBadge.hasAttribute("data-pointer-focus")).toBe(false);
});
