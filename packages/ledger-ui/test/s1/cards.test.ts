import { afterEach, expect, test } from "bun:test";
import type { KpiDocument } from "../../src/data/kpi-document.ts";
import type { Reader } from "../../src/data/reader.ts";
import documents from "../../src/fixtures/mart/documents.json";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import {
	cleanUp,
	click,
	clock,
	count,
	element,
	open as openApp,
	text,
} from "../s5/helpers.ts";

afterEach(cleanUp);

/** Each open starts from an empty page, so the next reads the app it opened. */
const open = async (hash: string): Promise<void> => {
	cleanUp();
	await openApp(hash);
};

const committed = documents as unknown as Record<string, KpiDocument>;
const subLine = (kpi: string): string =>
	text(`[data-test=kpi-card][data-k=${kpi}] i`);

test("a month card's sub-line prints the change the document carries, and says nothing when there is none", async () => {
	await open("#/b4u/dashboard?as=governance&view=money&month=2026-01");
	expect(subLine("gross_collected")).toBe("First month");
	await open("#/b4u/dashboard?as=governance&view=money&month=2026-02");
	expect(subLine("gross_collected")).toBe("▼ $60 vs Jan");
	await open("#/b4u/dashboard?as=governance&view=money&month=2026-03");
	expect(subLine("gross_collected")).toBe("Same as Feb");
	await open("#/b4u/dashboard?as=governance&view=money&month=2026-04");
	expect(subLine("gross_collected")).toBe("▼ $29 vs Mar");
	expect(subLine("net_income")).toBe("▼ $34 vs Mar");
});

test("a count card prints its change as an integer", async () => {
	const month = committed["monthly-members.governance"]?.tables.month;
	const changes = month?.changes?.paying_members ?? [];
	const index = changes.findIndex((change) => change !== null && change !== 0);
	const change = changes[index] ?? 0;
	const period = month?.periods[index] ?? "";
	await open(`#/b4u/dashboard?as=governance&view=members&month=${period}`);
	expect(subLine("paying_members")).toBe(
		`${change > 0 ? "▲" : "▼"} ${Math.abs(change)} vs ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(period.slice(5)) - 2]}`,
	);
});

test("Dispute cost is one cell: the month names its two parts and tones the cost, the year only says lost + fees", async () => {
	await open(
		"#/b4u/dashboard?preset=disputes&as=governance&view=risk&month=2026-04",
	);
	const card = "[data-test=kpi-card][data-k=dispute_cost]";
	expect(count(`${card} [data-kpi=dispute_cost]`)).toBe(1);
	expect(text(`${card} i`)).toMatch(/^lost \$[\d,.]+ \+ fees \$[\d,.]+$/);
	const cost =
		committed["disputes.governance"]?.tables.month?.series.dispute_cost;
	const april = cost?.[3];
	expect(typeof april).toBe("number");
	expect(element(card).className).toContain(
		(april as number) > 5000 ? "bad" : (april as number) > 0 ? "warn" : "ok",
	);
	await open(
		"#/b4u/dashboard?as=member&view=risk&month=2026-01-01..2026-03-31",
	);
	expect(subLine("dispute_cost")).toBe("lost + fees");
	expect(count("[data-test=kpi-card][data-k=dispute_cost] [data-kpi]")).toBe(1);
});

test("the plan breakdown below Governance is one row with the small lock figure, not a panel", async () => {
	await open("#/b4u/dashboard?as=member&view=money");
	const row = "[data-test=lock-panel][data-surface=dashboard-plan]";
	expect(element(row).className).toBe("krow");
	expect(text(`${row} [data-test=lock-who]`)).toBe(
		"Governance and up see this",
	);
	expect(count(`${row} h4`)).toBe(0);
	expect(count(`${row} [data-test=lock-when]`)).toBe(0);
});

test("the Member's year note replaces the generic rounding line", async () => {
	await open(
		"#/har/dashboard?preset=monthly-members&as=member&view=money&month=2025-10-01..2025-12-31",
	);
	expect(count("[data-test=year-note]")).toBe(1);
	expect(text("[data-test=pane]")).not.toContain(
		"Each period is rounded on its own",
	);
	await open("#/b4u/dashboard?as=public&view=money");
	expect(text("[data-test=pane]")).toContain(
		"Each period is rounded on its own",
	);
});

test("the four scenarios are the only scenario control; preset= still names all 15, and a preset outside the four presses none", async () => {
	await open("#/b4u/dashboard?as=governance");
	const seg = element('[aria-label="Fixture scenario"]');
	expect(seg.getAttribute("role")).toBe("group");
	expect(seg.querySelectorAll("[data-test=preset-option]").length).toBe(4);
	expect(count("[data-test=preset-option]")).toBe(4);
	expect(count('select[aria-label="More scenarios"]')).toBe(0);
	await click("[data-test=preset-option][data-preset=disputes]");
	expect(window.location.hash).toContain("preset=disputes");
	await open("#/b4u/dashboard?as=governance&preset=fee-oracle");
	expect(count("[data-test=preset-option][aria-pressed=true]")).toBe(0);
	expect(count("[data-test=preset-option].on")).toBe(0);
});

test("the view, scenario and period controls are named groups, as the mockup names them", async () => {
	await open("#/b4u/dashboard?as=governance");
	expect(element('[aria-label="Dashboard view"]').getAttribute("role")).toBe(
		"group",
	);
	expect(element('[aria-label="Month"]').getAttribute("role")).toBe("group");
	await open("#/b4u/dashboard?as=public");
	expect(element('[aria-label="Period"]').getAttribute("role")).toBe("group");
});

test("Gross by plan follows the document's tier order when it carries one, the first row in chart-1", async () => {
	const reader = createFixtureReader({ clock });
	const ordered: Reader = {
		...reader,
		kpiDocument: async (query) => {
			const document = await reader.kpiDocument(query);
			const month = document?.tables.month;
			if (!(document && month)) return document;
			const order = month.periods.map(() => [
				"revenue_by_tier:scholar",
				"revenue_by_tier:fellow",
				"revenue_by_tier:seminar",
				"revenue_by_tier:audit",
			]);
			return {
				...document,
				tables: {
					...document.tables,
					month: {
						...month,
						order: { ...month.order, revenue_by_tier: order },
					},
				},
			};
		},
	};
	cleanUp();
	await openApp("#/b4u/dashboard?as=finance&view=money&month=2026-04", {
		reader: ordered,
	});
	const rows = [
		...document.querySelectorAll(
			"[data-kpi^='revenue_by_tier:'][data-period='2026-04']",
		),
	].map((cell) => cell.getAttribute("data-kpi"));
	expect(rows).toEqual([
		"revenue_by_tier:scholar",
		"revenue_by_tier:fellow",
		"revenue_by_tier:seminar",
		"revenue_by_tier:audit",
	]);
	const firstBar = element<HTMLElement>("[data-kpi='revenue_by_tier:scholar']")
		.closest(".krow")
		?.querySelector<HTMLElement>(".t i");
	expect(firstBar?.style.background).toContain("--chart-1");
});
