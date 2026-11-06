import { afterEach, expect, test } from "bun:test";
import { mountApp } from "../../src/app/mount.tsx";
import type { Capabilities, MemberAudit } from "../../src/data/members.ts";
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
	for (let turn = 0; turn < 4; turn += 1) await macrotask();
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
const go = async (hash: string): Promise<void> => {
	window.location.hash = hash;
	await settle();
};

afterEach(() => {
	unmount?.();
	unmount = null;
	document.body.innerHTML = "";
	window.location.hash = "";
});

/** The fixture Reader with its capabilities changed by `change`. */
const readerWithActions = (
	change: (actions: Capabilities["actions"]) => Capabilities["actions"],
): Reader => {
	const reader = createFixtureReader({ clock });
	return {
		...reader,
		capabilities: async (query) => {
			const capabilities = await reader.capabilities(query);
			return { ...capabilities, actions: change(capabilities.actions) };
		},
	};
};

// ---- Audit member

test("Audit member shows the server's steps in order with their marks, then its verdict", async () => {
	await open("#/vol/members?theme=light");
	await click(menuButton("m_117"));
	await click(menuItem("audit"));
	const steps = [...document.querySelectorAll(".steps li")];
	expect(steps.map((step) => step.textContent?.trim())).toEqual([
		"Read 14 events from 3 batches; 2 repeats dropped",
		"Every batch file matches the hash in its name",
		"Replay through the engine reproduces each recorded change",
		expect.stringContaining("Replayed balance 4 ≠ live balance"),
		"Held sessions match open bookings",
		"Stripe reconcile: all payments and refunds matched",
	]);
	expect(steps.map((step) => step.querySelector("span")?.className)).toEqual([
		"ok",
		"ok",
		"ok",
		"no",
		"ok",
		"ok",
	]);
	expect(text("[data-test=modal-preview]")).toBe(
		"1 problem. Don't adjust the balance by hand yet: restore the missing command, then re-run.",
	);
	expect(element("[data-test=modal-preview] b").className).toBe("err");
});

test("a clean audit says Clean. and Export report saves the audit as JSON, then toasts the file", async () => {
	const writer = createFixtureWriter({ mode: "instant" });
	await open("#/vol/members?theme=light", { writer });
	await click(menuButton("m_012"));
	await click(menuItem("audit"));
	expect(text("[data-test=modal-preview]")).toBe(
		"Clean. Log, balance and Stripe agree.",
	);
	const exportButton = [
		...document.querySelectorAll<HTMLButtonElement>(
			"[data-test=modal-confirm]",
		),
	].find((button) => button.textContent === "Export report");
	expect(exportButton).toBeDefined();
	exportButton?.click();
	await settle();
	const [download] = writer.calls.filter(({ method }) => method === "download");
	const file = download?.args[0] as { name: string; text: string };
	expect(file.name).toBe("audit-m_012.json");
	const saved = JSON.parse(file.text) as MemberAudit;
	expect(saved.reportFileName).toBe("audit-m_012.json");
	expect(saved.clean).toBe(true);
	expect(text("[data-test=toast]")).toBe("audit-m_012.json downloaded.");
});

test("while the audit is read the modal says so and shows no verdict; a failed read says so", async () => {
	const reader = createFixtureReader({ clock });
	const held: {
		answer: (audit: MemberAudit) => void;
		fail: () => void;
	} = { answer: () => {}, fail: () => {} };
	let calls = 0;
	const slow: Reader = {
		...reader,
		auditMember: (query) => {
			calls += 1;
			return new Promise<MemberAudit>((resolve, reject) => {
				if (calls === 1) held.answer = resolve;
				else held.fail = () => reject(new Error("offline"));
				void query;
			});
		},
	};
	await open("#/vol/members?theme=light", { reader: slow });
	await click(menuButton("m_012"));
	await click(menuItem("audit"));
	expect(text("[data-test=modal]")).toContain("Replaying the log…");
	expect(count("[data-test=modal-preview]")).toBe(0);
	expect(count(".steps li")).toBe(0);
	held.answer({
		steps: [{ ok: true, text: "One step" }],
		clean: true,
		verdict: "All agree.",
		reportFileName: "audit-m_012.json",
	});
	await settle();
	expect(text("[data-test=modal-preview]")).toBe("Clean. All agree.");
	await click("[data-test=modal-cancel]");
	await click(menuButton("m_012"));
	await click(menuItem("audit"));
	held.fail();
	await settle();
	expect(text("[data-test=modal]")).toContain("Could not run the audit.");
	expect(count("[data-test=modal-preview]")).toBe(0);
});

test("audit and Resend receipt are off with 'Not available yet' while the capability is not built", async () => {
	const reader = readerWithActions((actions) => ({
		...actions,
		audit: { allowed: false, reason: "not_built" },
		resendReceipt: { allowed: false, reason: "not_built" },
	}));
	await open("#/vol/members?theme=light", { reader });
	await click(menuButton("m_012"));
	for (const action of ["audit", "receipt"]) {
		const item = element<HTMLButtonElement>(menuItem(action));
		expect(item.disabled).toBe(true);
		expect(item.title).toBe("Not available yet");
	}
});

// ---- View in Stripe and Resend receipt

test("View in Stripe is a link to the person's dashboard page, in a new tab, and off with a reason when they have none", async () => {
	await open("#/vol/members?theme=light");
	await click(menuButton("m_012"));
	const link = element<HTMLAnchorElement>(menuItem("stripe"));
	expect(link.tagName).toBe("A");
	expect(link.getAttribute("href")).toStartWith("https://");
	expect(link.target).toBe("_blank");
	expect(link.rel).toBe("noopener");
	unmount?.();
	document.body.innerHTML = "";
	const reader = createFixtureReader({ clock });
	await open("#/vol/members?theme=light", {
		reader: {
			...reader,
			memberDetail: async (query) => ({
				...(await reader.memberDetail(query)),
				stripeDashboardUrl: null,
			}),
		},
	});
	await click(menuButton("m_012"));
	const off = element<HTMLButtonElement>(menuItem("stripe"));
	expect(off.tagName).toBe("BUTTON");
	expect(off.disabled).toBe(true);
	expect(off.title).toBe("Not on Stripe");
});

test("Resend receipt calls the Writer and toasts only after it answers; a failure toasts as one", async () => {
	const base = createFixtureWriter({ mode: "hold" });
	await open("#/vol/members?theme=light", { writer: base });
	await click(menuButton("m_012"));
	await click(menuItem("receipt"));
	expect(base.calls).toEqual([
		{
			method: "resendReceipt",
			args: [{ schoolId: "vol", personId: "m_012" }],
		},
	]);
	expect(element(".toast").classList.contains("on")).toBe(false);
	base.release();
	await settle();
	expect(text("[data-test=toast]")).toBe("Receipt resent to Ivy N.");
	unmount?.();
	document.body.innerHTML = "";
	const instant = createFixtureWriter({ mode: "instant" });
	const failing: Writer = {
		...instant,
		resendReceipt: () => Promise.reject(new Error("offline")),
	};
	await open("#/vol/members?theme=light", { writer: failing });
	await click(menuButton("m_012"));
	await click(menuItem("receipt"));
	expect(text("[data-test=toast]")).toBe(
		"Could not resend the receipt. Try again.",
	);
});

// ---- Pending changes survive navigation

test("a role change stays on the roster when the period or the tab changes", async () => {
	await open("#/vol/members?theme=light");
	await click(menuButton("m_204"));
	await click(menuItem("make-admin"));
	await click("[data-test=modal-confirm]");
	expect(text(`${row("m_204")} [data-test=role-chip]`)).toContain("Admin");
	await go("#/vol/members?theme=light&month=2026-10");
	expect(text(`${row("m_204")} [data-test=role-chip]`)).toContain("Admin");
	await click("[data-tab=bookings]");
	await click("[data-tab=members]");
	expect(text(`${row("m_204")} [data-test=role-chip]`)).toContain("Admin");
});

test("a credit adjustment stays pending on the roster after the tab is left", async () => {
	await open("#/vol/members?theme=light");
	await click(menuButton("m_012"));
	await click(menuItem("adjust"));
	const note = element<HTMLInputElement>(
		"[data-test=modal-field][data-field=note]",
	);
	note.value = "late cancel";
	note.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
	await click("[data-test=modal-confirm]");
	const shown = text(`${row("m_012")} [data-test=member-available]`);
	expect(shown).toBe("20 → 22/32 +2 held");
	await click("[data-tab=dashboard]");
	await click("[data-tab=members]");
	expect(text(`${row("m_012")} [data-test=member-available]`)).toBe(shown);
});

test("a cancel made on the roster is what the drawer and the member portal show", async () => {
	await open("#/vol/members?theme=light");
	await click(menuButton("m_204"));
	await click(menuItem("cancel"));
	await click("[data-test=modal-confirm]");
	await go("#/vol/members?theme=light&member=m_204");
	expect(text("[data-test=renews-badge]")).toStartWith("ends ");
	await go("#/vol/members?theme=light&portal=m_204");
	expect(count("[data-test=portal-action][data-action=resume]")).toBe(1);
	expect(count("[data-test=portal-action][data-action=cancel]")).toBe(0);
});

test("a cancel made in the member portal is what the roster and its menu show", async () => {
	await open("#/vol/members?theme=light&portal=m_204");
	await click("[data-test=portal-action][data-action=cancel]");
	await click("[data-test=dialog-confirm]");
	await go("#/vol/members?theme=light&member=m_204");
	expect(text("[data-test=renews-badge]")).toStartWith("ends ");
	await click("[data-test=member-drawer] [data-test=member-menu-button]");
	expect(count(menuItem("resume"))).toBe(1);
	expect(count(menuItem("cancel"))).toBe(0);
});

// ---- Small fixes

test("the status chips carry aria-pressed like the role chips", async () => {
	await open("#/vol/members?theme=light");
	const pressed = (slug: string): string | null =>
		element(`[data-test=member-filter][data-filter=${slug}]`).getAttribute(
			"aria-pressed",
		);
	expect([pressed("all"), pressed("attention"), pressed("canceled")]).toEqual([
		"true",
		"false",
		"false",
	]);
	await click("[data-test=member-filter][data-filter=canceled]");
	expect([pressed("all"), pressed("attention"), pressed("canceled")]).toEqual([
		"false",
		"false",
		"true",
	]);
});

test("the members table scrolls sideways in its own wrapper", async () => {
	await open("#/vol/members?theme=light");
	const wrapper = element(".members-table");
	expect(wrapper.querySelector("table")).not.toBeNull();
	expect(wrapper.contains(element("[data-test=member-menu-button]"))).toBe(
		true,
	);
	expect(wrapper.contains(element("[data-test=member-search]"))).toBe(false);
});

test("the drawer of a canceled membership says when it ends, not when it renews", async () => {
	await open("#/vol/members?member=m_051&theme=light");
	expect(text("[data-test=renews-badge]")).toStartWith("ends ");
	await go("#/vol/members?member=m_012&theme=light");
	expect(text("[data-test=renews-badge]")).toStartWith("renews ");
});
