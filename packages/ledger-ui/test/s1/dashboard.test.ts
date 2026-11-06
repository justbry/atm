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
const element = (selector: string): HTMLElement => {
	const found = document.querySelector<HTMLElement>(selector);
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

test("the fixture Reader offers the five levels in rank order and returns only committed documents", async () => {
	const reader = createFixtureReader({ clock });
	const { levels, presets } = await reader.dashboardOptions();
	expect(levels.map(({ id, name, pin }) => [id, name, pin])).toEqual([
		["public", "Public", false],
		["member", "Member", false],
		["governance", "Governance", true],
		["finance_admin", "Finance admin", true],
		["owner", "Owner", true],
	]);
	const keys = presets.flatMap(({ id }) =>
		levels.flatMap((level) =>
			level.pin
				? [`${id}.${level.id}`, `${id}.${level.id}.pin-locked`]
				: [`${id}.${level.id}`],
		),
	);
	expect(keys.sort()).toEqual(Object.keys(committed).sort());
	expect(
		await reader.kpiDocument({
			preset: "monthly-members",
			level: "public",
			pinLocked: true,
		}),
	).toBeUndefined();
	expect(
		await reader.kpiDocument({
			preset: "nowhere",
			level: "owner",
			pinLocked: false,
		}),
	).toBeUndefined();
});

test("unknown view, level and month fall back to the school's level, Money and its opening month", async () => {
	await open(
		"#/b4u/dashboard?preset=disputes&level=nobody&view=charts&month=2031-01",
	);
	expect(text("[data-test=books-level].on")).toBe("Finance admin");
	expect(text("[data-test=dash-view].on")).toBe("Money");
	expect(text("[data-test=dash-period].on")).toBe("Jun");
});

test("a school without an opening month opens on the last period the level shows", async () => {
	await open("#/vol/dashboard?preset=monthly-members");
	expect(text("[data-test=books-level].on")).toBe("Owner");
	expect(text("[data-test=dash-period].on")).toBe("Nov");
	await click("[data-test=books-level][data-level=governance]");
	expect(text("[data-test=dash-period].on")).toBe("Sep");
	await click("[data-test=books-level][data-level=public]");
	expect(text("[data-test=dash-period].on")).toBe("2024");
	await click("[data-test=dash-view][data-view=members]");
	expect(text("[data-test=dash-period].on")).toBe("2025");
});

test("the step buttons stop at the first month and before a month Governance does not see yet", async () => {
	await open(
		"#/b4u/dashboard?preset=monthly-members&level=governance&month=2026-01",
	);
	const previous = (): HTMLButtonElement =>
		element('[data-test=dash-step][data-step="-1"]') as HTMLButtonElement;
	const next = (): HTMLButtonElement =>
		element('[data-test=dash-step][data-step="1"]') as HTMLButtonElement;
	expect(previous().disabled).toBe(true);
	expect(next().disabled).toBe(false);
	await click('[data-test=dash-step][data-step="1"]');
	expect(window.location.hash).toContain("month=2026-02");
	await click('[data-test=dash-period][data-period="2026-09"]');
	expect(next().disabled).toBe(true);
	expect(count("[data-test=dash-step]")).toBe(2);
});

test("a period a level does not show yet is a waiting box, and its rows say when, never 0", async () => {
	await open(
		"#/b4u/dashboard?preset=monthly-members&level=member&view=money&month=2026-Q4",
	);
	expect(count("[data-test=kpi-card]")).toBe(0);
	expect(text("[data-test=dash-wait]")).toContain(
		"Q4 2026 shows from Apr 2027.",
	);
	expect(element("#app").textContent).toContain("from Apr 2027");
	expect(count('[data-kpi="gross_collected"][data-period="2026-Q4"]')).toBe(0);
});

test("a flag's Show button opens its period, and the flagged cells are the document's", async () => {
	await open(
		"#/b4u/dashboard?preset=heavy-refunds&level=owner&view=risk&month=2026-06",
	);
	const flags = [...document.querySelectorAll("[data-test=dash-flag]")];
	expect(flags.length).toBeGreaterThan(0);
	const first = flags[0];
	expect(first?.textContent).toContain("Refund rate");
	const period =
		first
			?.querySelector("[data-kpi=refund_rate]")
			?.getAttribute("data-period") ?? "";
	(first?.querySelector("button") as HTMLButtonElement).click();
	await settle();
	expect(window.location.hash).toContain(`month=${period}`);
	expect(element("[data-test=dash-period].on").dataset.period).toBe(period);
});

test("charts draw a bar only for a number: Governance's months not shown yet have none", async () => {
	await open(
		"#/b4u/dashboard?preset=monthly-members&level=governance&view=money&month=2026-06",
	);
	const governance = committed["monthly-members.governance"];
	const numbers = (kpi: string): number =>
		(governance?.series[kpi] ?? []).filter((cell) => typeof cell === "number")
			.length;
	const grossVersusNet = element("#app").querySelector("svg.kc");
	const bars = grossVersusNet?.querySelectorAll("rect:not(.col)").length;
	expect(bars).toBe(numbers("gross_collected") + numbers("net_income"));
	expect(numbers("gross_collected")).toBe(9);
});

test("a band reads 'under $1,000' and a hidden cell its label with the reason, never 0", async () => {
	await open(
		"#/b4u/dashboard?preset=monthly-members&level=public&view=money&month=2024",
	);
	const fees = element('[data-test=kpi-value][data-kpi="stripe_fees"]');
	expect(fees.dataset.cell).toBe("lt");
	expect(fees.textContent).toBe("under $1,000");
	const refunds = element('[data-test=kpi-value][data-kpi="refunds"]');
	expect(refunds.dataset.cell).toBe("suppressed");
	expect(refunds.getAttribute("title")).toBe("Hidden: fewer than 5 payers");
	expect(refunds.closest(".kcard")?.classList.contains("kcut")).toBe(true);
});

test("the PIN state survives a level switch and applies only from Governance up", async () => {
	await open(
		"#/b4u/dashboard?preset=monthly-members&level=governance&pin=locked",
	);
	expect(count("[data-test=pin-lock]")).toBe(1);
	await click("[data-test=books-level][data-level=owner]");
	expect(text("[data-test=pin-lock]")).toContain("Owner opens the books");
	await click("[data-test=books-level][data-level=member]");
	expect(count("[data-test=pin-lock]")).toBe(0);
	expect(count("[data-test=pin-chip]")).toBe(0);
	expect(count("[data-test=kpi-card]")).toBe(5);
});

test("unlocking shows the books and says so", async () => {
	await open(
		"#/b4u/dashboard?preset=monthly-members&level=owner&pin=locked&month=2026-06",
	);
	const input = element("[data-test=pin-input]") as HTMLInputElement;
	input.value = "123";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await macrotask();
	expect(
		(element("[data-test=pin-unlock]") as HTMLButtonElement).disabled,
	).toBe(true);
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
