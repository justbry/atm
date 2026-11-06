import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { IncomeStatement } from "../../src/data/ledger.ts";
import type { Reader } from "../../src/data/reader.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";
import {
	cleanUp,
	click,
	clock,
	count,
	element,
	open,
	text,
} from "./helpers.ts";

afterEach(cleanUp);

const base = createFixtureReader({ clock });
const amounts = {
	memberships: 700_000,
	bookings: 30_000,
	discounts: -5000,
	income: 725_000,
	refunds: -12_300,
	fees: -4500,
	net: 708_200,
	giftsSold: 2500,
	paidOut: 650_000,
};
/** A statement no school fixture produces, so a pane that works anything out itself is caught. */
const statementOf = (change: Partial<IncomeStatement>): IncomeStatement => ({
	school: "vol",
	from: "2026-11-01",
	to: "2026-11-30",
	currency: "USD",
	unit: { one: "session", other: "sessions" },
	basis: { kind: "cash" },
	matchesStripe: true,
	counts: { payments: 1, refunds: 1, payouts: 1 },
	amounts,
	giftsOutstanding: { amountCents: 1000, credits: 1, count: 1 },
	income: {
		step: "day",
		points: [{ start: "2026-11-01", amountCents: 100 }],
		through: "2026-11-05",
		totalCents: 123_456,
		peak: { start: "2026-11-01", amountCents: 7700 },
	},
	previous: null,
	...change,
});
const readerWith = (statement: IncomeStatement): Reader => ({
	...base,
	incomeStatement: async () => statement,
});

test("every figure is the Reader's: nothing on the statement is worked out in the pane", async () => {
	await open("#/vol/reports", { reader: readerWith(statementOf({})) });
	expect(
		text(
			"[data-test=report-kpi][data-item=income] [data-test=report-kpi-value]",
		),
	).toBe("$7,250.00");
	expect(
		text(
			"[data-test=report-line][data-line=net] [data-test=report-line-amount]",
		),
	).toBe("$7,082.00");
	expect(
		text(
			"[data-test=report-line][data-line=discounts] [data-test=report-line-amount]",
		),
	).toBe("−$50.00");
	expect(text("[data-test=report-spark-summary]")).toBe(
		"$1,234.56 · peak $77.00 (Nov 1)",
	);
	expect(text("[data-test=report-status]")).toBe(
		"Matches Stripe · 1 payment, 1 refund, 1 payout Cash basis",
	);
	expect(
		text(
			"[data-test=report-kpi][data-item=gifts] [data-test=report-kpi-value]",
		),
	).toBe("$10.00 + 1 session");
	expect(
		text(
			"[data-test=report-kpi][data-item=gifts] [data-test=report-kpi-change]",
		),
	).toBe("1 unredeemed gift (a liability)");
});

test("a partial month and a deferred basis are said as the Reader says them", async () => {
	await open("#/vol/reports?month=2026-11-01..2026-11-20", {
		reader: readerWith(
			statementOf({
				matchesStripe: false,
				basis: { kind: "deferred", from: "2026-12-01" },
				income: {
					step: "week",
					points: [
						{ start: "2026-11-01", amountCents: 100 },
						{ start: "2026-11-08", amountCents: 300 },
					],
					through: "2026-11-05",
					totalCents: 400,
					peak: { start: "2026-11-08", amountCents: 300 },
				},
			}),
		),
	});
	expect(text("[data-test=report-status]")).toBe(
		"Partial month: summed from daily totals. The hledger report and the Stripe match run on whole months. Deferred from Dec 1",
	);
	expect(text("[data-test=report-spark-title]")).toBe("Weekly income");
	expect(text("[data-test=report-spark-summary]")).toBe(
		"$4.00 · peak $3.00 (week of Nov 8)",
	);
	expect(count("[data-test=report-spark-point]")).toBe(2);
	expect(text("[data-test=report-statement-title]")).toBe(
		"Income statement · Nov 1 – Nov 20, 2026",
	);
});

test("a period with no series says there is no data yet, and draws no points", async () => {
	await open("#/vol/reports", {
		reader: readerWith(
			statementOf({
				income: {
					step: "day",
					points: [],
					through: "2026-11-05",
					totalCents: 0,
					peak: null,
				},
			}),
		),
	});
	expect(text("[data-test=report-spark]")).toContain(
		"No data yet for this period.",
	);
	expect(count("[data-test=report-spark-point]")).toBe(0);
});

test("compare reads the change from the previous period's amounts and draws it dashed", async () => {
	const previous = statementOf({}).income;
	await open("#/vol/reports?compare=1", {
		reader: readerWith(
			statementOf({
				previous: {
					from: "2026-10-01",
					to: "2026-10-31",
					amounts: { ...amounts, income: 800_000, paidOut: 600_000 },
					changes: {
						memberships: 0,
						bookings: 0,
						discounts: 0,
						income: -75_000,
						refunds: 0,
						fees: 0,
						net: 0,
						giftsSold: 0,
						paidOut: 50_000,
					},
					income: previous,
				},
			}),
		),
	});
	expect(
		text(
			"[data-test=report-kpi][data-item=income] [data-test=report-kpi-change]",
		),
	).toBe("▼ $750.00 vs Oct 2026");
	expect(
		text(
			"[data-test=report-kpi][data-item=payout] [data-test=report-kpi-change]",
		),
	).toBe("▲ $500.00 vs Oct 2026");
	expect(
		text(
			"[data-test=report-kpi][data-item=refund] [data-test=report-kpi-change]",
		),
	).toBe("▲ $0.00 vs Oct 2026");
	expect(count("[data-test=report-spark] polyline[stroke-dasharray]")).toBe(1);
});

test("the Reader is asked for the statement of the route's period, and the Download file carries it", async () => {
	const asked: unknown[] = [];
	const reader: Reader = {
		...base,
		incomeStatement: (query) => {
			asked.push(query);
			return base.incomeStatement(query);
		},
	};
	const writer = createFixtureWriter({ mode: "instant" });
	await open("#/vol/reports?month=2026-01-01..2026-11-05&compare=1", {
		reader,
		writer,
	});
	expect(asked).toEqual([
		{ school: "vol", from: "2026-01-01", to: "2026-11-05", compare: true },
	]);
	await click("[data-test=report-download]");
	expect(writer.calls[0]?.args[0]).toMatchObject({
		name: "income-statement-2026-01-01_2026-11-05.csv",
	});
});

test("a statement line opens its events from a real button, and the row itself is not a tab stop", async () => {
	await open("#/vol/reports");
	const line = element("[data-test=report-line][data-line=memberships]");
	expect(line.hasAttribute("tabindex")).toBe(false);
	const button = element<HTMLButtonElement>(
		"[data-test=report-line][data-line=memberships] [data-test=report-line-label] button.drill",
	);
	expect(button.type).toBe("button");
	button.click();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(window.location.hash).toBe("#/vol/ledger?drill=memb");
});

test("the gift line ends without its own arrow (the stylesheet adds the one), and opens the gift events from its button", async () => {
	await open("#/vol/reports");
	const gifts = "[data-test=report-line][data-line=gifts]";
	expect(text(gifts)).not.toContain("›");
	expect(element(gifts).hasAttribute("tabindex")).toBe(false);
	element<HTMLButtonElement>(`${gifts} button`).click();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(window.location.hash).toBe("#/vol/ledger?drill=gift");
});

test("Reports keeps the statement and the rules side by side until the mockup's own 600px breakpoint", () => {
	const blocks = [
		...readFileSync(
			new URL("../../src/theme.css", import.meta.url),
			"utf8",
		).matchAll(/@media[^{]+\{((?:[^{}]|\{[^{}]*\})*)\}/g),
	].map((match) => match[0]);
	expect(
		blocks.filter(
			(block) => block.includes("728px") && block.includes(".two2"),
		),
	).toEqual([]);
});

test("Net is not a drill-down, and the line says nothing about it", async () => {
	await open("#/vol/reports");
	const net = element("[data-test=report-line][data-line=net]");
	expect(net.hasAttribute("title")).toBe(false);
	expect(net.hasAttribute("tabindex")).toBe(false);
});

test("Edit in school settings is offered to owners and admins and says where it goes", async () => {
	await open("#/vol/reports");
	await click("[data-test=report-rules-edit]");
	expect(text("[data-test=toast]")).toBe(
		"Opening school settings in buzz-school…",
	);
});

test("below finance the Reader is asked for the audience's document and the statement is never read", async () => {
	const asked: unknown[] = [];
	let statementReads = 0;
	const reader: Reader = {
		...base,
		incomeStatement: (query) => {
			statementReads += 1;
			return base.incomeStatement(query);
		},
		audienceReport: (query) => {
			asked.push(query);
			return base.audienceReport(query);
		},
	};
	await open("#/b4u/reports?as=member&month=2026-06", { reader });
	expect(asked).toEqual([
		{
			school: "b4u",
			audience: "member",
			from: "2026-06-01",
			to: "2026-06-30",
		},
	]);
	expect(statementReads).toBe(0);
	expect(text("[data-test=report-status]")).toContain(
		"Member document · Q2 2026",
	);
});

test("an audience document's Download is its six figures, hidden ones named, and its file is named for the audience and period", async () => {
	const writer = createFixtureWriter({ mode: "instant" });
	await open("#/b4u/reports?as=public", { writer });
	await click("[data-test=report-download]");
	const file = writer.calls[0]?.args[0] as { name: string; text: string };
	expect(file.name).toBe("books-public-2024.csv");
	expect(file.text.split("\r\n")).toEqual([
		"﻿line,kpi,value,hidden,audience,period",
		'Income,gross_collected,"$4,200",,public,2024',
		"Refunds,refunds,,Members see this,public,2024",
		"Stripe fees,stripe_fees,,Members see this,public,2024",
		"Net,net_income,,Members see this,public,2024",
		"Paid out,payouts,,Governance and up see this,public,2024",
		"Payments,payments_count,156,,public,2024",
		"",
	]);
	expect(text("[data-test=toast]")).toBe("Downloaded 6 rows");
});

test("the owner sees an anonymous donor's name with a badge; the finance admin gets the Reader's Anonymous", async () => {
	const reader: Reader = {
		...base,
		donors: async ({ audience }) => ({
			kind: "identified",
			year: 2026,
			donorCount: 1,
			payerCount: 0,
			rows: [
				{
					id: "d_1",
					name: audience === "owner" ? "Rae Quill" : "Anonymous",
					kind: "donor",
					fund: null,
					payments: 1,
					totalCents: 250_000,
					lastPaymentOn: "2026-02-02",
					anonymous: true,
				},
			],
		}),
	};
	await open("#/vol/reports", { reader });
	expect(text("[data-test=donor-name]")).toBe("Rae Quill Anonymous to finance");
	expect(text("[data-test=donors-title]")).toBe(
		"Donors and payers 2026 to date · 1 donor, 0 member payers",
	);
	cleanUp();
	await open("#/vol/reports?as=finance", { reader });
	expect(text("[data-test=donor-name]")).toBe(
		"Anonymous name with the owner only",
	);
});

test("fewer than five donors shows no spread, only the reason", async () => {
	const reader: Reader = {
		...base,
		donors: async () => ({
			kind: "spread",
			through: "2026-09",
			donors: { lt: 10 },
			buckets: [],
			medianCents: {
				hidden: "suppressed",
				text: "Hidden: fewer than 5 donors",
			},
		}),
	};
	await open("#/vol/reports?as=governance", { reader });
	expect(text("[data-test=donors]")).toContain("<10 donors");
	expect(text("[data-test=donors]")).toContain(
		"Fewer than 5 donors so far, so no spread is shown.",
	);
});
