import { expect, test } from "bun:test";
import {
	type CsvColumn,
	csvCell,
	csvFileNames,
	donorsColumns,
	downloadedToast,
	type HistoryCsvRow,
	historyColumns,
	ledgerColumns,
	statementColumns,
	statementLines,
	toCsv,
} from "../../src/data/ledger.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { clock } from "./helpers.ts";

const byteOrderMark = "﻿";
const reader = createFixtureReader({ clock });

test("a file is a byte order mark, a header line and one line per row, every line ended by CRLF", () => {
	const columns: Array<CsvColumn<string>> = [
		{ header: "name", kind: "text", value: (row) => row },
	];
	expect(toCsv(columns, ["a", "b"])).toBe(`${byteOrderMark}name\r\na\r\nb\r\n`);
	expect(toCsv(columns, [])).toBe(`${byteOrderMark}name\r\n`);
});

test("text that could run as a formula is guarded, and numbers never are", () => {
	for (const formula of ["=1+1", "+1", "-1", "@cmd", "\tx", "\rx"])
		expect(csvCell(formula, "text").replace(/^"|"$/g, "")).toBe(`'${formula}`);
	expect(csvCell(-250, "money")).toBe("-2.50");
	expect(csvCell(-250, "number")).toBe("-250.00");
	expect(csvCell(5, "text")).toBe("5");
	expect(csvCell("-5", "text")).toBe("'-5");
});

test("a value with a quote, a comma or a line end is quoted with its quotes doubled", () => {
	expect(csvCell('say "hi", ok', "text")).toBe('"say ""hi"", ok"');
	expect(csvCell("a\nb", "text")).toBe('"a\nb"');
	expect(csvCell("Invoice paid, Shine ×2", "text")).toBe(
		'"Invoice paid, Shine ×2"',
	);
	expect(csvCell("plain", "text")).toBe("plain");
	expect(csvCell(null, "text")).toBe("");
	expect(csvCell(null, "money")).toBe("");
});

test("money is written in two decimals from minor units, rounding half away from zero", () => {
	expect(csvCell(0, "money")).toBe("0.00");
	expect(csvCell(5, "money")).toBe("0.05");
	expect(csvCell(100_000, "money")).toBe("1000.00");
	expect(csvCell(-1011, "money")).toBe("-10.11");
});

test("the Ledger's file for B4 Uni in November is the table's rows in the table's order, byte for byte", async () => {
	const page = await reader.ledger({
		school: "b4u",
		from: "2026-11-01",
		to: "2026-11-30",
		type: null,
		drill: null,
		promo: null,
	});
	const rows = page.days.flatMap((day) => day.entries);
	expect(toCsv(ledgerColumns(page.currency ?? ""), rows)).toBe(
		[
			`${byteOrderMark}date,member,description,amount,currency,status,invoice_id,payment_id,event,credits`,
			"2026-11-03,s_26,Plan allowance,,USD,Posted,,,credit.granted,8.00",
			"2026-11-03,s_25,Plan allowance,,USD,Posted,,,credit.granted,8.00",
			"2026-11-03,s_21,Plan allowance,,USD,Posted,,,credit.granted,12.00",
			'2026-11-03,s_21,"Invoice paid, Shine ×2",90.00,USD,Posted,,pay_26,payment.succeeded,',
			"2026-11-02,s_22,Held for Tutoring,,USD,Posted,,,credit.held,-1.00",
			"",
		].join("\r\n"),
	);
	expect(csvFileNames.ledger(page.from, page.to)).toBe(
		"ledger-2026-11-01_2026-11-30.csv",
	);
});

test("the income statement's file lists the eight lines, signed, with the currency and the period", async () => {
	const statement = await reader.incomeStatement({
		school: "vol",
		from: "2026-11-01",
		to: "2026-11-30",
		compare: false,
	});
	const rows = statementLines.map(([line, field]) => ({
		line,
		amountCents: statement.amounts[field],
	}));
	expect(toCsv(statementColumns(statement), rows)).toBe(
		[
			`${byteOrderMark}line,amount,currency,period_from,period_to`,
			"Memberships,260.00,USD,2026-11-01,2026-11-30",
			"Bookings and events,40.00,USD,2026-11-01,2026-11-30",
			"Discounts given,-13.00,USD,2026-11-01,2026-11-30",
			"Income,287.00,USD,2026-11-01,2026-11-30",
			"Refunds,-50.00,USD,2026-11-01,2026-11-30",
			"Stripe fees,-10.11,USD,2026-11-01,2026-11-30",
			"Net,226.89,USD,2026-11-01,2026-11-30",
			"Gift certificates sold (not income),50.00,USD,2026-11-01,2026-11-30",
			"",
		].join("\r\n"),
	);
	expect(csvFileNames.statement("2026-11-01", "2026-11-30")).toBe(
		"income-statement-2026-11-01_2026-11-30.csv",
	);
});

test("the donors file holds every row, not only the fifteen shown", async () => {
	const report = await reader.donors({
		school: "b4u",
		audience: "finance",
		year: 2026,
	});
	if (report.kind !== "identified") throw new Error("expected the rows");
	const lines = toCsv(donorsColumns("USD"), report.rows).split("\r\n");
	expect(lines[0]).toBe(
		`${byteOrderMark}name,kind,id,fund,payments,total,currency,last_payment`,
	);
	expect(lines[1]).toBe(
		"Ines Kim,Donor,d_7041,Building fund,1,5000.00,USD,2026-02-22",
	);
	expect(lines).toHaveLength(report.rows.length + 2);
	expect(report.rows).toHaveLength(65);
	expect(csvFileNames.donors("2026-11-05")).toBe("donors-2026-11-05.csv");
});

test("the member history's file adds the member column only for a guardian's family export", () => {
	const row: HistoryCsvRow = {
		date: "2026-11-03",
		member: "Lia W.",
		description: "Invoice paid, Shine ×2",
		amountCents: 9000,
		currency: "USD",
		status: "Paid",
		invoiceId: "in_1",
		paymentId: "pay_26",
	};
	expect(toCsv(historyColumns(false), [row])).toBe(
		[
			`${byteOrderMark}date,description,amount,currency,status,invoice_id,payment_id`,
			'2026-11-03,"Invoice paid, Shine ×2",90.00,USD,Paid,in_1,pay_26',
			"",
		].join("\r\n"),
	);
	expect(toCsv(historyColumns(true), [row]).split("\r\n")[0]).toBe(
		`${byteOrderMark}date,member,description,amount,currency,status,invoice_id,payment_id`,
	);
	expect(
		csvFileNames.history(
			"s_21",
			["2026-11-03", "2026-06-02", "2026-10-20"],
			"2026-11-05",
		),
	).toBe("invoices-s_21-2026-06-02-2026-11-03.csv");
	expect(csvFileNames.history("s_21", [], "2026-11-05")).toBe(
		"invoices-s_21-2026-11-05-2026-11-05.csv",
	);
});

test("the toast counts the rows and says row for one", () => {
	expect(downloadedToast(1)).toBe("Downloaded 1 row");
	expect(downloadedToast(5)).toBe("Downloaded 5 rows");
	expect(downloadedToast(0)).toBe("Downloaded 0 rows");
});
