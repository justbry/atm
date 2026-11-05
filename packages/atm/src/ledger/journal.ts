import type { AtmEvent, AtmJournalBuild } from "../types.js";
import { commodityOf } from "./postings.js";
import { canonicalize, sha256Hex } from "./util.js";

const byDateThenId = (a: AtmEvent, b: AtmEvent) =>
	a.date === b.date
		? a.id < b.id
			? -1
			: a.id > b.id
				? 1
				: 0
		: a.date < b.date
			? -1
			: 1;

/** A tag value runs to the next comma or the end of the line, so neither may appear in it. */
const tagValue = (v: string) => v.replace(/[,\r\n]+/g, " ").trim();

const transaction = (e: AtmEvent): string => {
	const tags = [
		`at:${e.event_time}`,
		...(e.key.includes(":") ? [e.key] : [`key:${e.key}`]).map(tagValue),
		...Object.entries(e.labels).map(([k, v]) => `${k}:${tagValue(v)}`),
	];
	const text = e.text.replace(/;/g, ",").replace(/[\r\n]+/g, " ");
	const width = Math.max(...e.postings.map((p) => p.account.length));
	const lines = e.postings.map(
		(p) => `    ${p.account.padEnd(width)}  ${p.amount} ${p.commodity}`,
	);
	return [
		`${e.date} * (${e.id}) ${e.event_type} | ${text}  ; ${tags.join(", ")}`,
		...lines,
		"",
	].join("\n");
};

/** Events with postings, as hledger transactions sorted by date then id. The same events always give the same bytes. */
export const monthJournal = (
	events: readonly AtmEvent[],
	month: string,
): string =>
	`${events
		.filter((e) => e.date.startsWith(`${month}-`) && e.postings.length > 0)
		.sort(byDateThenId)
		.map(transaction)
		.join("\n")}`;

/** `account` for every account any event uses, `commodity` for USD and each credit commodity. */
export const accountsJournal = (events: readonly AtmEvent[]): string => {
	const accounts = new Set<string>();
	const commodities = new Set<string>();
	for (const e of events) {
		for (const p of e.postings) {
			accounts.add(p.account);
			commodities.add(p.commodity);
		}
	}
	const decl = (c: string) =>
		c === "USD" ? "commodity 1,000.00 USD" : `commodity 1. ${c}`;
	return `${[
		...[...commodities].sort().map(decl),
		"",
		...[...accounts].sort().map((a) => `account ${a}`),
	].join("\n")}\n`;
};

export const MAIN_JOURNAL =
	"include ledger/accounts.journal\ninclude ledger/b4u/*.journal\n";

/**
 * The journal files for a school's month. `events` is every event of the school (accounts are declared from all of
 * them, so a month's journal never uses an undeclared account); only `month`'s events become transactions.
 * Paths are under the school's prefix. No clock is read: the bytes depend on the events alone.
 */
export const buildJournal = ({
	events,
	month,
}: {
	events: readonly AtmEvent[];
	month: string;
}): AtmJournalBuild => {
	if (!/^\d{4}-\d{2}$/.test(month))
		throw new Error(`month must be YYYY-MM, got ${month}`);
	for (const e of events)
		for (const p of e.postings) commodityOf(p.commodity.toLowerCase());
	const inMonth = events
		.filter((e) => e.date.startsWith(`${month}-`))
		.sort((a, b) => (a.id < b.id ? -1 : 1));
	const transactions = inMonth.filter((e) => e.postings.length > 0).length;
	return {
		month,
		transactions,
		inputsHash: sha256Hex(inMonth.map((e) => canonicalize(e)).join("\n")),
		files: {
			"ledger/accounts.journal": accountsJournal(events),
			[`ledger/b4u/${month}.journal`]: monthJournal(events, month),
			"main.journal": MAIN_JOURNAL,
		},
	};
};
