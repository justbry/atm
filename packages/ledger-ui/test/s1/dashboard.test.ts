import { afterEach, expect, test } from "bun:test";
import { mountApp } from "../../src/app/mount.tsx";
import type { KpiDocument } from "../../src/data/kpi-document.ts";
import type { Reader } from "../../src/data/reader.ts";
import documents from "../../src/fixtures/mart/documents.json";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";

const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
const committed = documents as unknown as Record<string, KpiDocument>;
let unmount: (() => void) | null = null;

const macrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
const element = <T extends HTMLElement = HTMLElement>(selector: string): T => {
	const found = document.querySelector<T>(selector);
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
};
const open = async (
	hash: string,
	reader: Reader = createFixtureReader({ clock }),
): Promise<void> => {
	unmount?.();
	document.body.innerHTML = "";
	window.location.hash = hash;
	const container = document.createElement("div");
	container.id = "app";
	document.body.appendChild(container);
	unmount = mountApp(container, {
		reader,
		writer: createFixtureWriter({ mode: "instant" }),
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

test("the fixture Reader gives the presets, the five schools, each school's disclosure and exactly the committed documents", async () => {
	const reader = createFixtureReader({ clock });
	const options = await reader.dashboardOptions();
	expect(Object.keys(options)).toEqual(["presets"]);
	expect(options.presets.length).toBe(15);
	expect((await reader.schools()).map(({ id }) => id)).toEqual([
		"vol",
		"b4u",
		"map",
		"nw",
		"har",
	]);
	expect((await reader.disclosure("har")).viewer.viewAs).toBe("admin");
	expect(
		await reader.kpiDocument({
			school: "har",
			preset: "monthly-members",
			audience: "member",
			pinLocked: false,
		}),
	).toEqual(committed["har/monthly-members.member"]);
	expect(
		await reader.kpiDocument({
			school: "vol",
			preset: "disputes",
			audience: "governance",
			pinLocked: true,
		}),
	).toEqual(committed["vol.governance.pin-locked"]);
	expect(
		await reader.kpiDocument({
			school: "b4u",
			preset: "monthly-members",
			audience: "public",
			pinLocked: true,
		}),
	).toBeUndefined();
});

test("an unknown view, a row the viewer does not hold and a month after today fall back to Money, their own row and this month", async () => {
	await open("#/b4u/dashboard?as=owner&view=charts&month=2031-01");
	expect(text("[data-test=dash-view].on")).toBe("Money");
	expect(text("[data-test=dash-caption]")).toStartWith("Finance admin sees");
	expect(text("[data-test=dash-period].on")).toBe("Nov");
});

test("a period the audience may not pick snaps to the last pickable one before it, without rewriting the route", async () => {
	await open("#/b4u/dashboard?as=governance&month=2026-11");
	expect(text("[data-test=dash-period].on")).toBe("Sep");
	expect(element("#app").dataset.route).toBe(
		"#/b4u/dashboard?as=governance&month=2026-11",
	);
	await open("#/b4u/dashboard?as=public&month=2026-06");
	expect(text("[data-test=dash-period].on")).toBe("2024");
	await click('[data-test=dash-period][data-period="2024"]');
	expect(window.location.hash).toContain("month=2024-01-01..2024-12-31");
});

test("the step buttons stop at the first month and before a month Governance may not see yet", async () => {
	await open("#/b4u/dashboard?as=governance&month=2026-01");
	const previous = (): HTMLButtonElement =>
		element('[data-test=dash-step][data-step="-1"]');
	const next = (): HTMLButtonElement =>
		element('[data-test=dash-step][data-step="1"]');
	expect(previous().disabled).toBe(true);
	await click('[data-test=dash-step][data-step="1"]');
	expect(window.location.hash).toContain("month=2026-02");
	await click('[data-test=dash-period][data-period="2026-09"]');
	expect(next().disabled).toBe(true);
	expect(
		element<HTMLButtonElement>('[data-test=dash-period][data-period="2026-10"]')
			.disabled,
	).toBe(true);
});

test("a flag's Show button opens its month, and the flagged cells are the document's", async () => {
	await open("#/b4u/dashboard?preset=heavy-refunds&view=risk&month=2026-06");
	const flags = [...document.querySelectorAll("[data-test=dash-flag]")];
	expect(flags.length).toBeGreaterThan(0);
	const period =
		flags[0]
			?.querySelector("[data-kpi=refund_rate]")
			?.getAttribute("data-period") ?? "";
	(flags[0]?.querySelector("button") as HTMLButtonElement).click();
	await settle();
	expect(window.location.hash).toContain(`month=${period}`);
	expect(element("[data-test=dash-period].on").dataset.period).toBe(period);
});

test("charts draw a bar only for a number: Governance's months not shown yet have none and say so", async () => {
	await open("#/b4u/dashboard?as=governance&view=money&month=2026-06");
	const month = committed["monthly-members.governance"]?.tables.month;
	const numbers = (kpi: string): number =>
		(month?.series[kpi] ?? []).filter((cell) => typeof cell === "number")
			.length;
	const grossVersusNet = element("#app").querySelector("svg.kc");
	expect(grossVersusNet?.querySelectorAll("rect:not(.col)").length).toBe(
		numbers("gross_collected") + numbers("net_income"),
	);
	expect(numbers("gross_collected")).toBe(9);
	const titles = [...(grossVersusNet?.querySelectorAll("title") ?? [])]
		.map((title) => title.textContent ?? "")
		.filter((title) => /^(Oct|Nov|Dec)/.test(title));
	expect(titles.length).toBe(3);
	expect(titles.every((title) => title.includes("not shown yet"))).toBe(true);
});

test("a withheld cell reads its reason with its title, and a suppressed one '—', never 0", async () => {
	await open(
		"#/b4u/dashboard?as=public&view=money&month=2024-01-01..2024-12-31",
	);
	const refunds = element('[data-test=kpi-value][data-kpi="refunds"]');
	expect(refunds.dataset.cell).toBe("members_only");
	expect(refunds.dataset.hid).toBe("members_only");
	expect(refunds.title).toBe("Members see this");
	expect(refunds.closest(".kcard")?.textContent).toContain(
		"Not in this document",
	);
	await open(
		"#/b4u/dashboard?as=member&view=money&month=2026-04-01..2026-06-30",
	);
	const cut = element('[data-test=kpi-value][data-kpi="refunds"]');
	expect(cut.textContent).toBe("—");
	expect(cut.title).toBe("Hidden: fewer than 5 payers");
	expect(cut.closest(".kcard")?.classList.contains("kcut")).toBe(true);
});

test("Admin reads its own membership's document, with the plan breakdown as its lock panel", async () => {
	await open("#/har/dashboard");
	expect(text("[data-test=dash-caption]")).toStartWith("Member document");
	expect(
		text(
			"[data-test=lock-panel][data-surface=dashboard-plan] [data-test=lock-who]",
		),
	).toBe("Governance and up see this");
	expect(count("[data-test=pin-chip]")).toBe(0);
});

test("the PIN applies only from Governance up, and unlocking says so", async () => {
	await open("#/b4u/dashboard?as=member&pin=locked");
	expect(count("[data-test=pin-lock]")).toBe(0);
	expect(count("[data-test=kpi-card]")).toBe(5);
	await open("#/b4u/dashboard?pin=locked&month=2026-06");
	expect(text("[data-test=pin-lock]")).toContain(
		"Finance admin opens the books",
	);
	expect(count("[data-test=pin-chip].on")).toBe(1);
	expect(count("[data-test=dash-period]")).toBe(0);
	const input = element<HTMLInputElement>("[data-test=pin-input]");
	input.value = "123";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await macrotask();
	expect(element<HTMLButtonElement>("[data-test=pin-unlock]").disabled).toBe(
		true,
	);
	input.value = "1234";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await macrotask();
	await click("[data-test=pin-unlock]");
	expect(window.location.hash).not.toContain("pin=");
	expect(text(".toast")).toBe("Books unlocked for this session.");
	expect(text('[data-test=kpi-value][data-kpi="gross_collected"]')).toBe(
		"$623.00",
	);
});

test("the live audiences draw every day of the month, the days after today as stubs", async () => {
	await open("#/b4u/dashboard?view=money&month=2026-11");
	const days = [
		...document.querySelectorAll<SVGRectElement>(
			'[data-kpi="gross_collected"][data-day^="2026-11-"]',
		),
	];
	expect(days.length).toBe(30);
	const day = committed["monthly-members.finance"]?.tables.day;
	const first =
		day?.series.gross_collected?.[day.periods.indexOf("2026-11-01")];
	expect(days[0]?.getAttribute("data-value")).toBe(String(first));
	expect(
		days.filter((rect) => rect.getAttribute("data-cell") === "future").length,
	).toBe(25);
});

test("switching school drops the Dashboard's query; the school opens as its own person on its own month", async () => {
	await open(
		"#/vol/dashboard?as=public&view=risk&month=2024-01-01..2024-12-31&pin=locked&theme=dark",
	);
	await click("[data-test=school-switcher]");
	await click("[data-test=school-option][data-school=b4u]");
	expect(window.location.hash).toBe("#/b4u/plans?theme=dark");
	await click("[data-test=tab][data-tab=dashboard]");
	expect(text("[data-test=dash-view].on")).toBe("Money");
	expect(text("[data-test=dash-period].on")).toBe("Jun");
	expect(text('[data-test=kpi-value][data-kpi="gross_collected"]')).toBe(
		"$623.00",
	);
});

test("Bookings follow the View as row: Governance sees the lock panel, Admin the list", async () => {
	await open("#/b4u/bookings?as=governance");
	expect(count("[data-test=lock-panel][data-lock=admins_only]")).toBe(1);
	await open("#/b4u/bookings?as=admin");
	expect(count("[data-test=lock-panel]")).toBe(0);
	expect(count("[data-test=booking-note]")).toBe(1);
});

test("the route is recorded only once the document of that route is on screen", async () => {
	let release: (() => void) | null = null;
	const fixtures = createFixtureReader({ clock });
	const held: Reader = {
		...fixtures,
		kpiDocument: async (query) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return fixtures.kpiDocument(query);
		},
	};
	window.location.hash = "#/b4u/dashboard?preset=disputes";
	const container = document.createElement("div");
	container.id = "app";
	document.body.appendChild(container);
	unmount = mountApp(container, {
		reader: held,
		writer: createFixtureWriter({ mode: "instant" }),
		clock,
	}).unmount;
	for (let attempt = 0; attempt < 5; attempt += 1) await macrotask();
	expect(container.dataset.route).toBeUndefined();
	expect(document.querySelector("[data-test=kpi-card]")).toBeNull();
	(release as (() => void) | null)?.();
	await settle();
	expect(container.dataset.route).toBe("#/b4u/dashboard?preset=disputes");
	expect(count("[data-test=kpi-card]")).toBe(5);
});
