import { afterEach, expect, test } from "bun:test";
import { mountApp } from "../../src/app/mount.tsx";
import type { Cell, KpiDocument } from "../../src/data/kpi-document.ts";
import type { Reader } from "../../src/data/reader.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";

const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
let unmount: (() => void) | null = null;

const macrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
const text = (selector: string): string => {
	const found = document.querySelector(selector);
	if (!found) throw new Error(`no element matches ${selector}`);
	return (found.textContent ?? "").replace(/\s+/g, " ").trim();
};
const open = async (hash: string, reader: Reader): Promise<void> => {
	window.location.hash = hash;
	const container = document.createElement("div");
	container.id = "app";
	document.body.appendChild(container);
	unmount = mountApp(container, {
		reader,
		writer: createFixtureWriter({ mode: "instant" }),
		clock,
	}).unmount;
	for (
		let attempt = 0;
		attempt < 400 &&
		document.querySelector<HTMLElement>("#app")?.dataset.route !==
			window.location.hash;
		attempt += 1
	)
		await macrotask();
	await macrotask();
	await macrotask();
};

afterEach(() => {
	unmount?.();
	unmount = null;
	document.body.innerHTML = "";
	window.location.hash = "";
});

const base = createFixtureReader({ clock });
/** The Reader, with the month table's refund rate for November 2026 replaced (or removed with `null`). */
const withRefundRate = (cell: Cell | null): Reader => ({
	...base,
	kpiDocument: async (query) => {
		const document = await base.kpiDocument(query);
		const copy = structuredClone(document) as KpiDocument;
		const table = copy.tables.month;
		const index = table?.periods.indexOf("2026-11") ?? -1;
		if (!table || index < 0) throw new Error("no November in the month table");
		if (cell === null) delete table.series.refund_rate;
		else if (table.series.refund_rate) table.series.refund_rate[index] = cell;
		return copy;
	},
});
const refundsLine = "[data-test=kpi-card][data-k=refunds] i";

// ---- Round 7: the Refunds card's line is never a fragment (mockup `kpct(rr)+" of gross"`)

test("the Refunds card reads '<rate> of gross' when the rate is a number", async () => {
	await open("#/b4u/dashboard?as=finance&month=2026-11", base);
	expect(text(refundsLine)).toMatch(/^\d+\.\d% of gross$/);
});

test("the Refunds card says the rate's own withheld text alone when the rate is missing", async () => {
	await open("#/b4u/dashboard?as=finance&month=2026-11", withRefundRate(null));
	expect(text(refundsLine)).toBe("Not computed");
});

test("the Refunds card says the rate's own withheld text alone when the rate is hidden", async () => {
	await open(
		"#/b4u/dashboard?as=finance&month=2026-11",
		withRefundRate({ hidden: "embargoed", text: "Published after 7 Dec 2026" }),
	);
	expect(text(refundsLine)).toBe("Published after 7 Dec 2026");
	expect(text(refundsLine)).not.toContain("of gross");
	expect(text(refundsLine)).not.toContain("0.0%");
});
