import {
	historyCsvColumns,
	type PortalHistoryRow,
	paymentStatusLabels,
} from "../data/portal.ts";

const byteOrderMark = "﻿";
const lineEnd = "\r\n";
const formulaStart = /^[=+\-@\t\r]/;
const needsQuotes = /[",\r\n]/;
const quote = /"/g;
const minorUnitsPerUnit = 100;

/** A signed decimal with two places, from minor units ("-40.00"), without going through a float. */
function amountText(amountCents: number): string {
	const size = Math.abs(amountCents);
	const whole = Math.trunc(size / minorUnitsPerUnit);
	const fraction = String(size % minorUnitsPerUnit).padStart(2, "0");
	return `${amountCents < 0 ? "-" : ""}${whole}.${fraction}`;
}

/** RFC 4180 quoting; a text cell that a spreadsheet would read as a formula gets a leading apostrophe (an amount
 * is a real number and skips that guard). */
function cell(text: string, isAmount = false): string {
	const safe = !isAmount && formulaStart.test(text) ? `'${text}` : text;
	return needsQuotes.test(safe) ? `"${safe.replace(quote, '""')}"` : safe;
}

/** The history as a file (mockup `kCsv`): UTF-8 with a byte order mark, CRLF line ends, the columns of
 * `historyCsvColumns`; `member` (the row's `profileId`) only in a family export. */
export function historyCsv(
	rows: ReadonlyArray<PortalHistoryRow>,
	family: boolean,
): string {
	const columns = historyCsvColumns(family);
	const lines = rows.map((row) => {
		const values: Record<string, string> = {
			date: cell(row.date),
			member: cell(row.profileId),
			description: cell(row.description),
			amount: cell(amountText(row.amountCents), true),
			currency: cell(row.currency),
			status: cell(paymentStatusLabels[row.status]),
			invoice_id: cell(row.invoiceId),
			payment_id: cell(row.paymentId),
		};
		return columns.map((column) => values[column]).join(",");
	});
	return `${byteOrderMark}${[columns.join(","), ...lines].join(lineEnd)}${lineEnd}`;
}
