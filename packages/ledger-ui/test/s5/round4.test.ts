import { afterEach, expect, test } from "bun:test";
import { h, render } from "preact";
import { cellText, Figure } from "../../src/app/report-figure.tsx";
import type { IncomeStatement, ReportCell } from "../../src/data/ledger.ts";
import type { Reader } from "../../src/data/reader.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { cleanUp, clock, count, element, open, text } from "./helpers.ts";

afterEach(cleanUp);

const base = createFixtureReader({ clock });

// ---- Rules in force

test("Edit in school settings shows for an admin, whose statement is not visible, and not for governance", async () => {
	await open("#/har/reports");
	// Harbor's admin has no finance grant: the page is the audience's document, not the statement.
	expect(count("[data-test=report-doc-note]")).toBe(1);
	expect(text("[data-test=report-rules-edit]")).toBe("Edit in school settings");
	cleanUp();
	await open("#/vol/reports?as=governance");
	expect(count("[data-test=report-rules-edit]")).toBe(0);
	cleanUp();
	await open("#/vol/reports");
	expect(count("[data-test=report-rules-edit]")).toBe(1);
});

// ---- The compare tiles

test("a compare tile's sign and amount are the server's change, never the difference of two amounts", async () => {
	const statement = await base.incomeStatement({
		school: "vol",
		from: "2026-11-01",
		to: "2026-11-30",
		compare: true,
	});
	if (!statement.previous) throw new Error("no previous period");
	const changes = {
		...statement.previous.changes,
		income: 12_345,
		refunds: -678,
	};
	const reader: Reader = {
		...base,
		incomeStatement: async (): Promise<IncomeStatement> => ({
			...statement,
			previous: {
				...(statement.previous as NonNullable<IncomeStatement["previous"]>),
				amounts: { ...statement.amounts },
				changes,
			},
		}),
	};
	await open("#/vol/reports?compare=1", { reader });
	// The two periods' amounts are equal; only the server's change speaks.
	expect(
		text(
			"[data-test=report-kpi][data-item=income] [data-test=report-kpi-change]",
		),
	).toMatch(/^▲ \$123\.45 vs /);
	expect(
		text(
			"[data-test=report-kpi][data-item=refund] [data-test=report-kpi-change]",
		),
	).toMatch(/^▼ \$6\.78 vs /);
});

// ---- One reading of a figure

const shown: Array<[string, ReportCell, boolean, string, string]> = [
	["a money number", 123_456, true, "$1,235", ""],
	["a count", 14, false, "14", ""],
	["a money floor", { lt: 10_000 }, true, "under $100", ""],
	["a count floor", { lt: 10 }, false, "<10", ""],
	["a rounded count", { approx: 40, why: "Rounded" }, false, "40", ""],
	[
		"an embargoed figure",
		{ hidden: "embargoed", until: "2027-01-07" },
		true,
		"",
		"Published after 7 Jan 2027",
	],
	[
		"a members-only figure",
		{ hidden: "members_only", who: "Members" },
		true,
		"",
		"Members see this",
	],
	[
		"a hidden figure",
		{ hidden: "no_grant", text: "Finance admins and the owner see this" },
		true,
		"",
		"Finance admins and the owner see this",
	],
];

test("one function reads every cell as text, and the figure on the page shows that text", () => {
	for (const [name, cell, money, value, hidden] of shown) {
		expect({ name, ...cellText(cell, money, "USD", true) }).toEqual({
			name,
			value,
			hidden,
		});
		const host = document.createElement("div");
		render(
			h(Figure, { cell, money, currency: "USD", whole: true, noun: "payers" }),
			host,
		);
		expect({ name, shown: host.textContent }).toEqual({
			name,
			shown: value === "" ? hidden : value,
		});
		render(null, host);
	}
	expect(
		cellText(
			{ hidden: "suppressed", text: "Hidden: fewer than 5" },
			true,
			"USD",
			true,
		),
	).toEqual({ value: "—", hidden: "Hidden: fewer than 5" });
});

// ---- A read the Reader rejects

/** A Reader whose `method` is rejected the first time and answered after. */
function failingOnce(method: "ledger" | "incomeStatement" | "promos"): {
	reader: Reader;
	calls: () => number;
} {
	let calls = 0;
	const reader: Reader = {
		...base,
		[method]: (...query: never[]) => {
			calls += 1;
			if (calls === 1) return Promise.reject(new Error("offline"));
			return (base[method] as (...rest: never[]) => Promise<unknown>)(...query);
		},
	};
	return { reader, calls: () => calls };
}
const tryAgain = (): HTMLButtonElement => {
	const button = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find(({ textContent }) => textContent === "Try again");
	if (!button) throw new Error("no Try again button");
	return button;
};

test("the Ledger, Reports and Promos say what they could not load, and Try again reads it again", async () => {
	for (const [hash, method, what, rendered] of [
		["#/vol/ledger", "ledger", "the ledger", "[data-test=ledger-type]"],
		[
			"#/vol/reports",
			"incomeStatement",
			"the report",
			"[data-test=report-kpi]",
		],
		["#/vol/promos", "promos", "the promos", "[data-test=promo-row]"],
	] as const) {
		const { reader, calls } = failingOnce(method);
		await open(hash, { reader });
		expect(element("[role=alert]").textContent).toContain(
			`Could not load ${what}.`,
		);
		expect(count(rendered)).toBe(0);
		tryAgain().click();
		for (let turn = 0; turn < 50 && count(rendered) === 0; turn += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
		expect(count(rendered)).toBeGreaterThan(0);
		expect(calls()).toBeGreaterThanOrEqual(2);
		expect(count("[role=alert]")).toBe(0);
		cleanUp();
	}
});
