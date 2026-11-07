import { afterEach, expect, test } from "bun:test";
import { cleanUp, count, element, open, text } from "../s5/helpers.ts";

afterEach(cleanUp);

const download = (): HTMLButtonElement =>
	element<HTMLButtonElement>("[data-test=history-download]");

test("the portal opened by the owner or a finance admin shows the amounts and exports", async () => {
	await open("#/b4u/members?portal=s_21&portalTab=billing");
	expect(download().disabled).toBe(false);
	expect(download().title).toBe("Download this history as CSV");
	expect(count("[data-test=history-amount] .khid")).toBe(0);
	expect(text("[data-test=history-amount]")).toMatch(/^\$/);
});

test("the portal opened by an admin without the grant shows no amounts and cannot export", async () => {
	await open("#/b4u/members?portal=s_21&portalTab=billing&as=admin");
	expect(download().disabled).toBe(true);
	expect(download().title).toBe("Finance admins only");
	const amounts = [
		...document.querySelectorAll("[data-test=history-amount]"),
	].map((cell) => (cell.textContent ?? "").trim());
	expect(amounts.length).toBeGreaterThan(0);
	expect(amounts.every((amount) => amount === "Finance only")).toBe(true);
	expect(text("[data-test=history-card]")).not.toMatch(/\$\d/);
});

test("Harbor Arts' members have a portal, whose history reads Finance only to its admin", async () => {
	await open("#/har/members?portal=h_32&portalTab=billing");
	expect(text("[data-test=portal-id]")).toContain("h_32");
	expect(text("[data-test=history-card]")).toContain("Invoice paid, Ensemble");
	expect(download().disabled).toBe(true);
	expect(text("[data-test=history-card]")).not.toMatch(/\$\d/);
});
