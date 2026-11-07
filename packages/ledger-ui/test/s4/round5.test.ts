import { afterEach, expect, test } from "bun:test";
import { mountApp } from "../../src/app/mount.tsx";
import type { MemberAudit } from "../../src/data/members.ts";
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

afterEach(() => {
	unmount?.();
	unmount = null;
	document.body.innerHTML = "";
	window.location.hash = "";
});

const remind =
	"[data-test=booking-action][data-action=remind][data-booking=bk_rq1]";
const balanceLine = "[data-test=drawer-balance]";

test("the drawer's balance line prints the server's rollover, and leaves the clause out when it sends none", async () => {
	await open("#/vol/members?member=m_117&theme=light");
	expect(text(balanceLine)).toContain(" · rollover 0");

	unmount?.();
	document.body.innerHTML = "";
	const reader = createFixtureReader({ clock });
	const rolled = async (rolledOver: number | undefined): Promise<Reader> => ({
		...reader,
		members: async (query) => {
			const page = await reader.members(query);
			return {
				...page,
				members: page.members.map((member) => ({
					...member,
					balances: member.balances.map(
						({ rolledOver: _dropped, ...rest }) => ({
							...rest,
							...(rolledOver === undefined ? {} : { rolledOver }),
						}),
					),
				})),
			};
		},
	});
	await open("#/vol/members?member=m_117&theme=light", {
		reader: await rolled(3),
	});
	expect(text(balanceLine)).toContain(" · rollover 3");

	unmount?.();
	document.body.innerHTML = "";
	await open("#/vol/members?member=m_117&theme=light", {
		reader: await rolled(undefined),
	});
	expect(text(balanceLine)).not.toContain("rollover");
});

const auditReader = (audit: MemberAudit): Reader => ({
	...createFixtureReader({ clock }),
	auditMember: async () => audit,
});
const audited = (steps: boolean[], clean: boolean): MemberAudit => ({
	steps: steps.map((ok, index) => ({ ok, text: `Step ${index + 1}` })),
	clean,
	verdict: "Restore the missing command.",
	reportFileName: "audit-m_012.json",
});

test("the audit label counts the steps that failed, in the singular and the plural", async () => {
	await open("#/vol/members?theme=light", {
		reader: auditReader(audited([true, false, false, true], false)),
	});
	await click(menuButton("m_012"));
	await click(menuItem("audit"));
	expect(text("[data-test=modal-preview]")).toBe(
		"2 problems. Restore the missing command.",
	);

	unmount?.();
	document.body.innerHTML = "";
	await open("#/vol/members?theme=light", {
		reader: auditReader(audited([false, true], false)),
	});
	await click(menuButton("m_012"));
	await click(menuItem("audit"));
	expect(text("[data-test=modal-preview]")).toBe(
		"1 problem. Restore the missing command.",
	);

	unmount?.();
	document.body.innerHTML = "";
	await open("#/vol/members?theme=light", {
		reader: auditReader(audited([true, true], true)),
	});
	await click(menuButton("m_012"));
	await click(menuItem("audit"));
	expect(text("[data-test=modal-preview]")).toBe(
		"Clean. Restore the missing command.",
	);
});

test("the audit runs once for the person it was opened for, however often the pane renders", async () => {
	const reader = createFixtureReader({ clock });
	let audits = 0;
	const counting: Reader = {
		...reader,
		auditMember: (query) => {
			audits += 1;
			return reader.auditMember(query);
		},
	};
	await open("#/vol/members?theme=light", { reader: counting });
	await click(menuButton("m_012"));
	await click(menuItem("audit"));
	expect(audits).toBe(1);
	const exportButton = [
		...document.querySelectorAll<HTMLButtonElement>(
			"[data-test=modal-confirm]",
		),
	].find((button) => button.textContent === "Export report");
	exportButton?.click();
	await settle();
	expect(text("[data-test=toast]")).toBe("audit-m_012.json downloaded.");
	expect(audits).toBe(1);
});

test("the drawer's Remind host writes the reminder for the drawer's booking, and toasts after the Writer answers", async () => {
	const writer = createFixtureWriter({ mode: "hold" });
	await open("#/vol/members?member=m_088&theme=light", { writer });
	await click(remind);
	expect(writer.calls).toEqual([
		{ method: "remindHost", args: [{ school: "vol", bookingId: "bk_rq1" }] },
	]);
	expect(count("[data-test=toast]")).toBe(0);
	writer.release();
	await settle();
	expect(text("[data-test=toast]")).toBe("Reminder sent to Kim.");

	unmount?.();
	document.body.innerHTML = "";
	const failing: Writer = {
		...createFixtureWriter({ mode: "instant" }),
		remindHost: () => Promise.reject(new Error("offline")),
	};
	await open("#/vol/members?member=m_088&theme=light", { writer: failing });
	await click(remind);
	expect(text("[data-test=toast]")).toBe(
		"Could not send the reminder. Try again.",
	);
});
