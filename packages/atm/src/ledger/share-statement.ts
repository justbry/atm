/**
 * The revenue-share statement of one school and one month, from its events alone: what B4 Uni is owed for the payments
 * the school collected (`share.accrued`), less what refunds took back (`share.reversed`) and what the school has paid
 * (`share.settled`). B4 Uni turns it into an invoice outside atm; `atm share` prints it.
 *
 * Pure and deterministic: no clock, no store. An event is in the month by its date in the school's time zone (its own
 * `date`, or the date of its instant in `tz` when one is given), the same rule `buildJournal` uses. A second event with an
 * `idem` already seen is dropped (the first by id wins, as `readEvents` does), so a log with a duplicate gives the same
 * statement. Only the school's own events count. Amounts are whole cents.
 */
import type { AtmEvent, ShareStatement, ShareStatementRow } from "../types.js";
import { centsToString, decimalToUnits, localDate } from "./util.js";

const MONTH = /^\d{4}-\d{2}$/;
const LIABILITY_ACCOUNT = "liabilities:b4uni";
const CENTS_PER_DOLLAR_PLACES = 2;

const byId = (a: AtmEvent, b: AtmEvent): number =>
	a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const centsOf = (value: unknown): number =>
	typeof value === "number" && Number.isSafeInteger(value) ? value : 0;

const textOf = (value: unknown): string | null =>
	typeof value === "string" && value !== "" ? value : null;

/** What the statement for `month` says: see `ShareStatement`. Throws for a month that is not `YYYY-MM` or a time zone that is not one. */
export const shareStatement = ({
	events,
	school,
	month,
	tz,
}: {
	events: readonly AtmEvent[];
	school: string;
	month: string;
	/** An IANA zone to date the events in, instead of each event's own `date`. */
	tz?: string;
}): ShareStatement => {
	if (!MONTH.test(month))
		throw new Error(`month must be YYYY-MM, got ${month}`);
	if (tz !== undefined) localDate(0, tz);
	const dateOf = (event: AtmEvent): string =>
		tz === undefined ? event.date : localDate(Date.parse(event.event_time), tz);
	const seen = new Set<string>();
	const own = [...events]
		.filter((event) => event.school === school)
		.sort(byId)
		.filter((event) => {
			if (seen.has(event.idem)) return false;
			seen.add(event.idem);
			return true;
		});

	// The accrual of each payment, wherever it is dated, for the columns of a refund's row.
	const accrual = new Map<string, AtmEvent>();
	for (const event of own)
		if (event.event_type === "share.accrued") {
			const paymentId = textOf(event.payload.payment_id);
			if (paymentId !== null && !accrual.has(paymentId))
				accrual.set(paymentId, event);
		}

	const rows = new Map<string, ShareStatementRow>();
	const rowOf = (paymentId: string, event: AtmEvent): ShareStatementRow => {
		const existing = rows.get(paymentId);
		if (existing) return existing;
		const made = accrual.get(paymentId);
		const kind = made?.payload.kind;
		const row: ShareStatementRow = {
			paymentId,
			kind: kind === "invoice" || kind === "booking" ? kind : null,
			date: dateOf(made ?? event),
			collected: made ? centsOf(made.payload.collected) : null,
			percent:
				typeof made?.payload.percent === "number" ? made.payload.percent : null,
			accrued: 0,
			reversed: 0,
		};
		rows.set(paymentId, row);
		return row;
	};
	const settlements: ShareStatement["settlements"] = [];
	let settled = 0;
	let liability = 0n;

	for (const event of own) {
		const date = dateOf(event);
		const inMonth = date.startsWith(`${month}-`);
		if (date.slice(0, 7) <= month)
			for (const posting of event.postings)
				if (posting.account === LIABILITY_ACCOUNT)
					liability -= decimalToUnits(posting.amount, CENTS_PER_DOLLAR_PLACES);
		if (!inMonth) continue;
		const paymentId = textOf(event.payload.payment_id);
		if (event.event_type === "share.accrued" && paymentId !== null)
			rowOf(paymentId, event).accrued += centsOf(event.payload.share);
		else if (event.event_type === "share.reversed" && paymentId !== null)
			rowOf(paymentId, event).reversed += centsOf(event.payload.reversed);
		else if (event.event_type === "share.settled") {
			const amount = centsOf(event.payload.amount);
			settled += amount;
			settlements.push({
				date,
				amount,
				reference: textOf(event.payload.reference),
			});
		}
	}

	const sorted = [...rows.values()].sort((a, b) =>
		a.date === b.date
			? a.paymentId < b.paymentId
				? -1
				: a.paymentId > b.paymentId
					? 1
					: 0
			: a.date < b.date
				? -1
				: 1,
	);
	const accrued = sorted.reduce((sum, row) => sum + row.accrued, 0);
	const reversed = sorted.reduce((sum, row) => sum + row.reversed, 0);
	return {
		school,
		month,
		rows: sorted,
		settlements,
		totals: { accrued, reversed, settled, owed: accrued - reversed - settled },
		balanceOwed: Number(liability),
	};
};

const csvCell = (value: string): string =>
	/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const dollars = (cents: number | null): string =>
	cents === null ? "" : centsToString(cents);

/**
 * A statement as CSV-style text: a header and a row per payment, then `name,amount` lines for the totals. Amounts are
 * decimal dollars, the rate a percent. The same statement is always the same bytes.
 */
export const formatShareStatement = (statement: ShareStatement): string => {
	const { totals } = statement;
	const lines = [
		"payment_id,kind,date,collected,percent,accrued,reversed",
		...statement.rows.map((row) =>
			[
				csvCell(row.paymentId),
				row.kind ?? "",
				row.date,
				dollars(row.collected),
				row.percent === null ? "" : String(row.percent),
				dollars(row.accrued),
				dollars(row.reversed),
			].join(","),
		),
		"",
		`accrued,${dollars(totals.accrued)}`,
		`reversed,${dollars(totals.reversed)}`,
		`settled,${dollars(totals.settled)}`,
		`owed for ${statement.month},${dollars(totals.owed)}`,
		`balance owed at the end of ${statement.month},${dollars(statement.balanceOwed)}`,
	];
	return `${lines.join("\n")}\n`;
};
