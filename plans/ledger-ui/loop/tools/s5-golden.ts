/**
 * Writes packages/ledger-ui/test/golden/S5.json: the mockup's Ledger, Reports and Promos on the dev mockup (read
 * headless with s5-text.mjs at 742105b64, disclosure v2, frozen), the audience gating of the same
 * mockup per View as (s5-v2-text.mjs), and the CSV bytes written with the contract's own helper (src/data/ledger.ts), checked
 * against the mockup's bytes when its s5-text output is given. Usage, from packages/ledger-ui:
 * bun ../../plans/ledger-ui/loop/tools/s5-golden.ts [s5-text.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type DonorRow,
	donorsColumns,
	type LedgerEntry,
	ledgerColumns,
	type StatementCsvRow,
	statementColumns,
	statementLines,
	toCsv,
} from "../../../../packages/ledger-ui/src/data/ledger.ts";

const packageRoot = join(import.meta.dir, "../../../../packages/ledger-ui");
const mockup = "mockup 742105b64";

type Text = string | { text: string; moves: true };
type Expectation = {
	text?: Record<string, Text>;
	contains?: Record<string, string[]>;
	count?: Record<string, number>;
	hash?: string;
	writes?: Array<{ method: string; args: unknown[] }>;
	absent?: string[];
};
type Step =
	| { click: string; expect?: Expectation }
	| { fill: string; value: string; expect?: Expectation }
	| { key: string; target: string; expect?: Expectation }
	| { release: true; expect?: Expectation };
type Entry = {
	id: string;
	source: string;
	route: string;
	writer?: "hold";
	covers?: Record<string, string>;
	steps?: Step[];
	expect: Expectation;
	shot?: { full: true; mockupSteps: string };
};

const moving = (text: string): Text => ({ text, moves: true });
const hook = (name: string, more = ""): string => `[data-test=${name}]${more}`;
const within = (outer: string, inner: string): string => `${outer} ${inner}`;
const ledgerRow = (id: string): string =>
	hook("ledger-row", `[data-event=${id}]`);
const ledgerDay = (date: string): string =>
	hook("ledger-day", `[data-day="${date}"]`);
const promoRow = (id: string): string =>
	hook("promo-row", `[data-promo=${id}]`);
const reportLine = (line: string): string =>
	hook("report-line", `[data-line=${line}]`);
const reportKpi = (item: string): string =>
	hook("report-kpi", `[data-item=${item}]`);
const mockupTab = (tab: string, school?: string): string =>
	`${school ? `document.querySelector('#sw').click();document.querySelector('[data-sc=${school}]').click();` : ""}document.querySelector('.tab[data-p=${tab}]').click()`;

// ---- The CSV files, from the contract's helper over the fixture rows the entries expect.

const entry = (
	date: string,
	member: string | null,
	text: string,
	type: LedgerEntry["event"]["event_type"],
	credits: number | null,
	amountCents: number | null,
	paymentId: string | null,
): LedgerEntry =>
	({
		event: { date, text, event_type: type } as LedgerEntry["event"],
		pending: false,
		localTime: `${date}T00:00`,
		member: member
			? { key: `family:${member}`, id: member, name: member }
			: null,
		credits,
		amountCents,
		paymentId,
		promo: null,
	}) satisfies LedgerEntry;
/** b4u, Nov 2026, in the table's order (newest first; the mockup writes its array order). */
const b4uNovember = [
	entry(
		"2026-11-03",
		"s_26",
		"Plan allowance",
		"credit.granted",
		8,
		null,
		null,
	),
	entry(
		"2026-11-03",
		"s_25",
		"Plan allowance",
		"credit.granted",
		8,
		null,
		null,
	),
	entry(
		"2026-11-03",
		"s_21",
		"Plan allowance",
		"credit.granted",
		12,
		null,
		null,
	),
	entry(
		"2026-11-03",
		"s_21",
		"Invoice paid, Shine ×2",
		"payment.succeeded",
		null,
		9000,
		"pay_26",
	),
	entry(
		"2026-11-02",
		"s_22",
		"Held for Tutoring",
		"credit.held",
		-1,
		null,
		null,
	),
];
const ledgerCsv = toCsv(ledgerColumns("USD"), b4uNovember);
const b4uStatement: StatementCsvRow[] = statementLines.map(([line, key]) => ({
	line,
	amountCents: {
		memberships: 9000,
		bookings: 0,
		discounts: 0,
		income: 9000,
		refunds: 0,
		fees: -270,
		net: 8730,
		giftsSold: 0,
		paidOut: 0,
	}[key],
}));
const statementCsv = toCsv(
	statementColumns({ currency: "USD", from: "2026-11-01", to: "2026-11-30" }),
	b4uStatement,
);
const donor = (
	name: string,
	kind: DonorRow["kind"],
	id: string,
	fund: string | null,
	payments: number,
	totalCents: number,
	lastPaymentOn: string,
): DonorRow => ({
	name,
	kind,
	id,
	fund,
	payments,
	totalCents,
	lastPaymentOn,
	anonymous: false,
});
/** vol, 2026 to date (mockup `SC.vol.don` and the 2026 payments of `SC.vol.E`), largest total first. */
const volDonors = [
	donor("Ana Pruitt", "donor", "d_790c", "Appeal", 1, 30000, "2026-09-14"),
	donor("Ivy N.", "member", "m_012", null, 2, 24700, "2026-11-01"),
	donor("Jon K.", "member", "m_117", null, 1, 12000, "2026-10-12"),
	donor("Mia Rowe", "donor", "d_3c9e", "General", 1, 12000, "2026-05-19"),
	donor("Lee T.", "member", "m_088", null, 2, 10500, "2026-11-02"),
	donor("Ana P.", "member", "m_093", null, 1, 6500, "2026-11-04"),
	donor("Mia R.", "member", "m_204", null, 1, 6500, "2026-11-01"),
	donor("Sam O.", "member", "m_051", null, 1, 6000, "2026-10-14"),
	donor("Ravi Shah", "donor", "d_9e67", "General", 1, 6000, "2026-03-02"),
	donor("Jon Kemp", "donor", "d_dad5", "General", 1, 4000, "2026-07-08"),
	donor("Pat Ellis", "donor", "d_0030", "General", 1, 2500, "2026-02-11"),
];
const donorsCsv = toCsv(donorsColumns("USD"), volDonors);

const mockupDump = process.argv[2];
if (mockupDump) {
	const dump = JSON.parse(readFileSync(mockupDump, "utf8")) as Record<
		string,
		{ raw: string }
	>;
	const lines = (text: string): string[] => text.split("\r\n");
	const sameLines = (ours: string, theirs: string): boolean =>
		JSON.stringify([...lines(ours)].sort()) ===
		JSON.stringify([...lines(theirs)].sort());
	const checks: Array<[string, boolean]> = [
		[
			"ledger csv (same lines; the mockup writes its array order)",
			sameLines(ledgerCsv, dump["csv.led.b4u.nov"]?.raw ?? ""),
		],
		["statement csv", statementCsv === dump["csv.rep.b4u.nov"]?.raw],
		["donors csv", donorsCsv === dump["csv.don.vol"]?.raw],
	];
	const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
	if (failed.length > 0)
		throw new Error(
			`the CSV helper differs from the mockup: ${failed.join(", ")}`,
		);
}

const download = (name: string, text: string) => ({
	method: "download",
	args: [{ name, type: "text/csv;charset=utf-8", text }],
});

const namesOfB4u = [
	"Dana W.",
	"Omar F.",
	"Kai W.",
	"Lia W.",
	"Pia L.",
	"Ines Kim",
	"Tom Kim",
];
const ledgerLock = (audience: string): string =>
	`This lists who paid what: one row per person with amounts, refunds and member ids. ${audience} sees totals in Reports and the Dashboard. Every identified read is audited.`;
const donorsLock = (audience: string): string =>
	`Names and per-person amounts. Governance sees how gifts spread. ${audience} sees totals and categories only.`;
const lockedLedger: Expectation["count"] = {
	[hook("ledger-row")]: 0,
	[hook("ledger-day")]: 0,
	[hook("ledger-type")]: 0,
	[hook("ledger-csv")]: 0,
	[hook("ledger-count")]: 0,
	[hook("ledger-empty")]: 0,
};

const entries: Entry[] = [
	// ---------------------------------------------------------------- Ledger
	{
		id: "ledger-default",
		source: `${mockup} ledger() on vol (owner), Nov 2026: the seven type chips with All on and the credit chip named after the unit, the count, Download CSV with its title, the column heads, 4 day groups and 15 rows, newest first; s5-text.mjs led.vol`,
		route: "#/vol/ledger?theme=light",
		covers: { tab: "ledger", audience: "owner" },
		expect: {
			text: {
				[hook("ledger-count")]: moving("15 events · America/Denver"),
				[hook("ledger-csv")]: "Download CSV",
				[hook("ledger-credit-head")]: "Sessions",
				[hook("ledger-type", "[data-type=credit]")]: "Sessions",
				[hook("ledger-type", "[data-type=all]")]: "All",
				[within(ledgerDay("2026-11-04"), hook("ledger-day-label"))]:
					"Wed Nov 4 · 4 events",
				[within(ledgerDay("2026-11-04"), hook("ledger-day-credits"))]:
					moving("+22"),
				[within(ledgerDay("2026-11-04"), hook("ledger-day-amount"))]:
					moving("$65.00"),
				[within(ledgerDay("2026-11-02"), hook("ledger-day-amount"))]: "−$10.00",
				[within(ledgerDay("2026-11-01"), hook("ledger-day-label"))]:
					"Sun Nov 1 · 4 events",
				[within(ledgerDay("2026-11-01"), hook("ledger-day-amount"))]: "$182.00",
				[within(ledgerRow("vol-e0"), hook("ledger-time"))]: "16:20",
				[within(ledgerRow("vol-e0"), hook("ledger-event"))]: "Sessions held",
				[within(ledgerRow("vol-e0"), hook("ledger-member"))]:
					moving("Ana P. m_093"),
				[within(ledgerRow("vol-e0"), hook("ledger-what"))]:
					"Held for Massage 90 · bk_9ab · family Details",
				[within(ledgerRow("vol-e0"), hook("ledger-credits"))]: moving("−1"),
				[within(ledgerRow("vol-e0"), hook("ledger-amount"))]: "",
			},
			count: {
				[hook("ledger-type")]: 7,
				[hook("ledger-type", ".on")]: 1,
				[hook("ledger-type", "[data-type=all].on")]: 1,
				[hook("ledger-day")]: 4,
				[hook("ledger-row")]: 15,
				[hook("ledger-details")]: 0,
				[hook("ledger-pending")]: 0,
				[hook("ledger-empty")]: 0,
				[hook("ledger-filter")]: 0,
				[hook(
					"ledger-csv",
					'[title="Download the rows in this view as CSV"]:not([disabled])',
				)]: 1,
				[hook("lock-panel")]: 0,
			},
			contains: {
				[hook("ledger-type")]: [
					"All",
					"Payments",
					"Sessions",
					"Bookings",
					"Promos",
					"Payouts",
					"Admin actions",
				],
				[hook("pane")]: ["Time", "Event", "Member", "What happened", "Amount"],
			},
		},
		shot: { full: true, mockupSteps: mockupTab("led") },
	},
	{
		id: "ledger-row-kinds",
		source: `${mockup} rowHtml: payment amounts signed with two decimals and no currency, a payout unsigned, a refund with −, a gift sold to nobody shows — and its promo masked, a booking payment its booking id; the event labels of lab() and L; s5-text.mjs led.vol`,
		route: "#/vol/ledger?theme=light",
		expect: {
			text: {
				[within(ledgerRow("vol-e2"), hook("ledger-event"))]: "Payment",
				[within(ledgerRow("vol-e2"), hook("ledger-amount"))]: moving("+65.00"),
				[within(ledgerRow("vol-e2"), hook("ledger-credits"))]: "",
				[within(ledgerRow("vol-e1"), hook("ledger-event"))]: "Sessions granted",
				[within(ledgerRow("vol-e1"), hook("ledger-credits"))]: "+24",
				[within(ledgerRow("vol-e4"), hook("ledger-event"))]: "Sessions used",
				[within(ledgerRow("vol-e5"), hook("ledger-event"))]: "Gift sold",
				[within(ledgerRow("vol-e5"), hook("ledger-member"))]: "—",
				[within(ledgerRow("vol-e5"), hook("ledger-what"))]:
					"Gift certificate sold, GIFT50 · promo GIF•••X2 · stripe Details",
				[within(ledgerRow("vol-e6"), hook("ledger-event"))]: "Out of sessions",
				[within(ledgerRow("vol-e7"), hook("ledger-event"))]: "Payout",
				[within(ledgerRow("vol-e7"), hook("ledger-amount"))]: "202.16",
				[within(ledgerRow("vol-e8"), hook("ledger-event"))]: "Refund",
				[within(ledgerRow("vol-e8"), hook("ledger-amount"))]: "−50.00",
				[within(ledgerRow("vol-e9"), hook("ledger-event"))]:
					"Sessions returned",
				[within(ledgerRow("vol-e9"), hook("ledger-credits"))]: "−4",
				[within(ledgerRow("vol-e10"), hook("ledger-event"))]: "Booking payment",
				[within(ledgerRow("vol-e10"), hook("ledger-what"))]:
					"Group event paid · bk_3cd · stripe Details",
				[within(ledgerRow("vol-e11"), hook("ledger-what"))]:
					"Invoice paid, Sparkle ×4 (10% off) · promo SPR•••10 · stripe Details",
				[within(ledgerRow("vol-e11"), hook("ledger-amount"))]: "+117.00",
				[within(ledgerRow("vol-e13"), hook("ledger-event"))]:
					"Sessions forfeited",
				[within(ledgerRow("vol-e14"), hook("ledger-event"))]:
					"Sessions expired",
				[within(ledgerRow("vol-e14"), hook("ledger-time"))]: "00:00",
				[within(ledgerDay("2026-11-03"), hook("ledger-day-credits"))]: "−2",
				[within(ledgerDay("2026-11-03"), hook("ledger-day-amount"))]: "$50.00",
			},
			count: {
				[within(ledgerRow("vol-e8"), hook("ledger-amount", ".neg"))]: 1,
				[within(ledgerRow("vol-e2"), hook("ledger-amount", ".neg"))]: 0,
			},
		},
	},
	{
		id: "ledger-details",
		source: `${mockup} #lb onclick: a row opens its details line (event type, source, and the event as JSON with its labels); a second click closes it`,
		route: "#/vol/ledger?theme=light",
		steps: [
			{
				click: ledgerRow("vol-e0"),
				expect: {
					count: { [hook("ledger-details")]: 1 },
					contains: {
						[hook("ledger-details")]: [
							"credit.held · source family",
							'"event_type":"credit.held"',
							'"booking":"bk_9ab"',
						],
					},
				},
			},
			{ click: ledgerRow("vol-e0") },
		],
		expect: { count: { [hook("ledger-details")]: 0 } },
	},
	...(
		[
			["payment", 6, 4, "6 events · America/Denver"],
			["credit", 8, 4, "8 events · America/Denver"],
			["booking", 5, 4, "5 events · America/Denver"],
			["code", 2, 2, "2 events · America/Denver"],
			["payout", 1, 1, null],
		] as const
	).map(
		([type, rows, days, count]): Entry => ({
			id: `ledger-type-${type}`,
			source: `${mockup} #lchips [data-t=${type}] and okT: the chip turns on and the rows narrow; s5-text.mjs led.vol.${type}`,
			route: "#/vol/ledger?theme=light",
			steps: [{ click: hook("ledger-type", `[data-type=${type}]`) }],
			expect: {
				hash: `type=${type}`,
				...(count ? { text: { [hook("ledger-count")]: count } } : {}),
				count: {
					[hook("ledger-row")]: rows,
					[hook("ledger-day")]: days,
					[hook("ledger-type", `[data-type=${type}].on`)]: 1,
					[hook("ledger-type", ".on")]: 1,
					[hook("ledger-empty")]: 0,
				},
			},
		}),
	),
	{
		id: "ledger-type-credit-day-totals",
		source: `${mockup} #lchips [data-t=credit]: the day groups sum only the shown rows; s5-text.mjs led.vol.credit`,
		route: "#/vol/ledger?type=credit&theme=light",
		expect: {
			text: {
				[within(ledgerDay("2026-11-04"), hook("ledger-day-label"))]:
					"Wed Nov 4 · 3 events",
				[within(ledgerDay("2026-11-04"), hook("ledger-day-credits"))]: "+22",
				[within(ledgerDay("2026-11-04"), hook("ledger-day-amount"))]: "",
				[within(ledgerDay("2026-11-01"), hook("ledger-day-credits"))]: "−8",
			},
			count: {
				[hook("ledger-row")]: 8,
				[hook("ledger-type", "[data-type=credit].on")]: 1,
			},
		},
	},
	{
		id: "ledger-type-empty",
		source: `${mockup} #lchips [data-t=admin] on vol in Nov: no admin action, so the empty line, not an empty table with a 0; s5-text.mjs led.vol.admin`,
		route: "#/vol/ledger?type=admin&theme=light",
		expect: {
			text: {
				[hook("ledger-empty")]: "No events in this period.",
				[hook("ledger-count")]: "0 events · America/Denver",
			},
			count: {
				[hook("ledger-row")]: 0,
				[hook("ledger-day")]: 0,
				[hook("ledger-type", "[data-type=admin].on")]: 1,
			},
		},
	},
	{
		id: "ledger-type-all",
		source: `${mockup} #lchips [data-t=""]: All clears the type`,
		route: "#/vol/ledger?type=payout&theme=light",
		steps: [{ click: hook("ledger-type", "[data-type=all]") }],
		expect: {
			text: { [hook("ledger-count")]: "15 events · America/Denver" },
			count: {
				[hook("ledger-row")]: 15,
				[hook("ledger-type", "[data-type=all].on")]: 1,
			},
			absent: ["type=payout"],
		},
	},
	{
		id: "ledger-finance",
		source: `${mockup} ledger() on b4u, where the signed-in Jo A. is an admin with the finance grant (spec v2: finance sees names, live): credits are 'Credits', 2 day groups, 5 rows; s5-text.mjs led.b4u`,
		route: "#/b4u/ledger?month=2026-11&theme=light",
		covers: { tab: "ledger", audience: "finance" },
		expect: {
			text: {
				[hook("ledger-count")]: "5 events · America/Chicago",
				[hook("ledger-credit-head")]: "Credits",
				[hook("ledger-type", "[data-type=credit]")]: "Credits",
				[within(ledgerDay("2026-11-03"), hook("ledger-day-label"))]:
					"Tue Nov 3 · 4 events",
				[within(ledgerDay("2026-11-03"), hook("ledger-day-credits"))]:
					moving("+28"),
				[within(ledgerDay("2026-11-03"), hook("ledger-day-amount"))]:
					moving("$90.00"),
				[within(ledgerDay("2026-11-02"), hook("ledger-day-label"))]:
					"Mon Nov 2 · 1 event",
				[within(ledgerDay("2026-11-02"), hook("ledger-day-amount"))]: "",
				[within(ledgerRow("b4u-e1"), hook("ledger-member"))]:
					moving("Lia W. s_26"),
				[within(ledgerRow("b4u-e1"), hook("ledger-time"))]: "10:06",
				[within(ledgerRow("b4u-e4"), hook("ledger-what"))]:
					"Held for Tutoring · bk_b11 · family Details",
			},
			count: {
				[hook("ledger-day")]: 2,
				[hook("ledger-row")]: 5,
				[hook("lock-panel")]: 0,
			},
			contains: { [hook("pane")]: ["Dana W.", "Omar F.", "Kai W."] },
		},
	},
	{
		id: "ledger-as-finance-preview",
		source: `${mockup} ledger() as Finance admin: the owner of vol previews the finance audience (as=finance), which still sees every row (spec v2 'finance gets the owner's view')`,
		route: "#/vol/ledger?as=finance&theme=light",
		expect: {
			text: { [hook("ledger-count")]: "15 events · America/Denver" },
			count: { [hook("ledger-row")]: 15, [hook("lock-panel")]: 0 },
		},
	},
	{
		id: "ledger-last-month",
		source: `${mockup} ledger() on vol at Oct 2026 (the period control's month=): an adjustment by an admin, a redeemed gift, a day with only a payout shows no totals; s5-text.mjs led.vol.oct`,
		route: "#/vol/ledger?month=2026-10&theme=light",
		expect: {
			text: {
				[hook("ledger-count")]: "7 events · America/Denver",
				[within(ledgerRow("vol-e15"), hook("ledger-event"))]: "Adjustment",
				[within(ledgerRow("vol-e15"), hook("ledger-what"))]:
					"Goodwill · late cancel · by admin@vibes · admin Details",
				[within(ledgerRow("vol-e15"), hook("ledger-credits"))]: "+2",
				[within(ledgerRow("vol-e16"), hook("ledger-event"))]: "Gift redeemed",
				[within(ledgerRow("vol-e16"), hook("ledger-what"))]:
					"Gift redeemed · promo WEL•••E4 · family Details",
				[within(ledgerDay("2026-10-03"), hook("ledger-day-label"))]:
					"Sat Oct 3 · 1 event",
				[within(ledgerDay("2026-10-03"), hook("ledger-day-credits"))]: "",
				[within(ledgerDay("2026-10-03"), hook("ledger-day-amount"))]: "",
				[within(ledgerDay("2026-10-15"), hook("ledger-day-amount"))]: "$130.00",
			},
			count: { [hook("ledger-row")]: 7, [hook("ledger-day")]: 6 },
		},
	},
	{
		id: "ledger-empty-school",
		source: `${mockup} ledger() on Lotus Lane (no events): the empty line, the count at 0 and the CSV link stay; s5-text.mjs led.nw`,
		route: "#/nw/ledger?theme=light",
		expect: {
			text: {
				[hook("ledger-empty")]: "No events in this period.",
				[hook("ledger-count")]: "0 events · America/Los_Angeles",
				[hook("ledger-credit-head")]: "Classes",
			},
			count: {
				[hook("ledger-row")]: 0,
				[hook("ledger-day")]: 0,
				[hook("ledger-csv")]: 1,
			},
		},
	},
	{
		id: "ledger-csv",
		source: `${mockup} kLedgerCsv through kCsv and kSave on b4u, Nov 2026: BOM, CRLF, the ledger header with the event and credits columns, credits with two decimals, the file name keeps the period, the toast counts the rows; smoke.mjs 'admin csv: ledger export uses the same helper'. Rows in the table's order (the mockup writes its array order)`,
		route: "#/b4u/ledger?month=2026-11&theme=light",
		steps: [{ click: hook("ledger-csv") }],
		expect: {
			writes: [download("ledger-2026-11-01_2026-11-30.csv", ledgerCsv)],
			text: { [hook("toast")]: "Downloaded 5 rows" },
		},
	},
	{
		id: "ledger-csv-pending",
		source:
			"protocol §7 hold writer: while the download is pending its button is busy and disabled and nothing claims the file is saved; the toast comes when the Writer answers",
		route: "#/b4u/ledger?month=2026-11&theme=light",
		writer: "hold",
		steps: [
			{
				click: hook("ledger-csv"),
				expect: {
					writes: [download("ledger-2026-11-01_2026-11-30.csv", ledgerCsv)],
					count: { [hook("ledger-csv", '[aria-busy="true"][disabled]')]: 1 },
					absent: ["Downloaded"],
				},
			},
			{ release: true },
		],
		expect: {
			text: { [hook("toast")]: "Downloaded 5 rows" },
			count: {
				[hook("ledger-csv", '[aria-busy="true"]')]: 0,
				[hook("ledger-csv", ":not([disabled])")]: 1,
			},
		},
	},
	{
		id: "ledger-drill",
		source: `${mockup} drill('income') from Reports: the Ledger with the 'Filter: Income ×' chip (DD.income: payments other than gifts) and All on; clicking the chip clears it (#cfx); s5-text.mjs drill.income, drill.clear`,
		route: "#/vol/ledger?drill=income&theme=light",
		steps: [
			{
				click: hook("ledger-filter"),
				expect: {
					text: { [hook("ledger-count")]: "15 events · America/Denver" },
					count: { [hook("ledger-filter")]: 0, [hook("ledger-row")]: 15 },
					absent: ["Filter: Income"],
				},
			},
		],
		expect: { count: { [hook("ledger-row")]: 15 } },
	},
	{
		id: "ledger-drill-open",
		source: `${mockup} drill('income'): 4 payments (the gift sold is not income); s5-text.mjs drill.income`,
		route: "#/vol/ledger?drill=income&theme=light",
		expect: {
			text: {
				[hook("ledger-filter")]: "Filter: Income ×",
				[hook("ledger-count")]: "4 events · America/Denver",
			},
			count: {
				[hook("ledger-row")]: 4,
				[hook("ledger-type", "[data-type=all].on")]: 1,
				[ledgerRow("vol-e5")]: 0,
			},
		},
	},
	{
		id: "ledger-promo-filter",
		source: `${mockup} [data-red] (a promo's Redemptions): the Ledger for the year to date with the 'Promo SPR•••10 ×' chip and the one payment that used it; s5-text.mjs cod.vol.redemptions`,
		route: "#/vol/ledger?month=2026-01-01..2026-11-05&promo=c_01&theme=light",
		expect: {
			text: {
				[hook("ledger-filter")]: "Promo SPR•••10 ×",
				[within(ledgerRow("vol-e11"), hook("ledger-member"))]: "Ivy N. m_012",
			},
			count: { [hook("ledger-row")]: 1 },
		},
	},
	...(["public", "member", "governance"] as const).map((audience): Entry => {
		const name = {
			public: "Public",
			member: "Member",
			governance: "Governance",
		}[audience];
		return {
			id: `ledger-as-${audience}`,
			source: `${mockup} bkBlocked() (s5-v2-text.mjs b4u.${audience}.led): the Ledger is a row per person, identities, so ${name} gets the lock panel naming who sees it (spec v2: rows and names for finance and owner only), never an empty table`,
			route: `#/b4u/ledger?as=${audience}&theme=light`,
			covers: { tab: "ledger", audience },
			expect: {
				text: {
					[hook("lock-title")]: "Finance admins and the owner see this",
					[hook("lock-body")]: ledgerLock(name),
				},
				count: {
					[hook("lock-panel", '[data-lock="no_grant"]')]: 1,
					...lockedLedger,
				},
				absent: namesOfB4u,
			},
		};
	}),
	{
		id: "ledger-pin-locked",
		source: `${mockup} bkLock (PIN locked from Governance up, smoke.mjs 'books locked: Ledger shows the lock'): Finance admin with pin=locked sees the PIN prompt, not the rows`,
		route: "#/b4u/ledger?as=finance&pin=locked&theme=light",
		expect: {
			contains: {
				[hook("pin-lock")]: [
					"Enter your PIN to see books",
					"Finance admin opens the books with your family PIN. Nothing is shown until you unlock.",
				],
			},
			count: { [hook("pin-lock")]: 1, ...lockedLedger },
			absent: namesOfB4u,
		},
	},
	// ---------------------------------------------------------------- Reports
	{
		id: "reports-default",
		source: `${mockup} reports() on vol (owner), Nov 2026: the reconciliation line and basis, the daily sparkline to the clock's today, the four KPIs and the gift liability, the income statement with its drill rows, the rules in force, Donors and payers with the audit line; s5-text.mjs rep.vol`,
		route: "#/vol/reports?theme=light",
		covers: { tab: "reports", audience: "owner" },
		expect: {
			text: {
				[hook("report-download")]: "Download",
				[hook("report-status")]: moving(
					"Matches Stripe · 5 payments, 1 refund, 1 payout Cash basis",
				),
				[hook("report-spark-title")]: "Daily income",
				[hook("report-spark-summary")]: moving(
					"$287.00 · peak $182.00 (Nov 1)",
				),
				[within(reportKpi("income"), hook("report-kpi-label"))]: "Income",
				[within(reportKpi("income"), hook("report-kpi-value"))]:
					moving("$287.00"),
				[within(reportKpi("refund"), hook("report-kpi-value"))]: "−$50.00",
				[within(reportKpi("fees"), hook("report-kpi-label"))]: "Stripe fees",
				[within(reportKpi("fees"), hook("report-kpi-value"))]: "−$10.11",
				[within(reportKpi("payout"), hook("report-kpi-label"))]: "Paid out",
				[within(reportKpi("payout"), hook("report-kpi-value"))]: "$202.16",
				[within(reportKpi("gifts"), hook("report-kpi-label"))]:
					"Gift certificates outstanding",
				[within(reportKpi("gifts"), hook("report-kpi-value"))]:
					"$50.00 + 2 sessions",
				[within(reportKpi("gifts"), hook("report-kpi-change"))]:
					"2 unredeemed gifts (a liability)",
				[hook("report-statement-title")]: "Income statement · Nov 2026",
				[within(reportLine("memberships"), hook("report-line-amount"))]:
					"$260.00",
				[within(reportLine("bookings"), hook("report-line-amount"))]: "$40.00",
				[within(reportLine("discounts"), hook("report-line-amount"))]:
					"−$13.00",
				[within(reportLine("income"), hook("report-line-amount"))]: "$287.00",
				[within(reportLine("refunds"), hook("report-line-amount"))]: "−$50.00",
				[within(reportLine("fees"), hook("report-line-amount"))]: "−$10.11",
				[within(reportLine("net"), hook("report-line-label"))]: "Net",
				[within(reportLine("net"), hook("report-line-amount"))]:
					moving("$226.89"),
				[reportLine("gifts")]:
					"Not income: gift certificates sold $50.00 (held as a liability until redeemed) ›",
				[hook("report-rule", "[data-rule=cutoff]")]:
					"Cancel cutoff (default) 24 hours before",
				[hook("report-rule", "[data-rule=no-show]")]:
					"No-show sessions are spent",
				[hook("report-rule", "[data-rule=late-cancel]")]:
					"Late cancel sessions are forfeited",
				[hook("report-rules-edit")]: "Edit in school settings",
				[hook("donors-title")]: moving(
					"Donors and payers 2026 to date · 5 donors, 6 member payers",
				),
				[hook("donors-csv")]: "Download CSV",
				[hook("donors-audit")]: "Every identified read is audited.",
				[within(hook("donor-row", "[data-id=d_790c]"), hook("donor-name"))]:
					moving("Ana Pruitt"),
				[within(hook("donor-row", "[data-id=d_790c]"), hook("donor-kind"))]:
					"Donor · Appeal",
				[within(hook("donor-row", "[data-id=d_790c]"), hook("donor-total"))]:
					moving("$300.00"),
				[within(hook("donor-row", "[data-id=d_790c]"), hook("donor-last"))]:
					"Sep 14",
				[within(hook("donor-row", "[data-id=m_012]"), hook("donor-kind"))]:
					"Member",
				[within(hook("donor-row", "[data-id=m_012]"), hook("donor-payments"))]:
					"2",
			},
			count: {
				[hook("report-kpi")]: 5,
				[hook("report-kpi", '[title="Show these events in the ledger"]')]: 4,
				[hook("report-kpi", '[data-item=gifts][title="Open promos"]')]: 1,
				[hook("report-line")]: 8,
				[hook("report-line", '[title="Show these events in the ledger"]')]: 7,
				[hook("report-spark-point")]: 5,
				[hook("report-rule")]: 3,
				[hook("report-kpi-change")]: 1,
				[hook(
					"report-download",
					'[title="Download the income statement as CSV"]',
				)]: 1,
				[hook(
					"donors-csv",
					'[title="Download donors and payers as CSV"]:not([disabled])',
				)]: 1,
				[hook("donor-row")]: 11,
				[hook("donors-more")]: 0,
				[hook("lock-panel")]: 0,
				[hook("report-grain")]: 0,
			},
			contains: {
				[hook("report-spark-axis")]: ["Nov 1", "Nov 5"],
				[hook("report-rules")]: [
					"Rules in force",
					"School policy: every audience sees it. An item can set its own cutoff.",
				],
				[hook("report-spark")]: ["Daily income"],
			},
		},
		shot: { full: true, mockupSteps: mockupTab("rep") },
	},
	{
		id: "reports-finance",
		source: `${mockup} reports() on b4u as Jo A. (finance): the statement, the rules (48 hours, credits released), and Donors and payers: 62 donors and 3 member payers (the June payments count), the top 15 of 65 by amount, the donor who asked to be anonymous shown as Anonymous to the finance admin (spec v2: the owner alone sees the name), and the audit line; smoke.mjs 'books fin: Donors and payers table with names, amounts and the audit line'; s5-text.mjs rep.b4u`,
		route: "#/b4u/reports?month=2026-11&theme=light",
		covers: { tab: "reports", audience: "finance" },
		expect: {
			text: {
				[within(reportLine("memberships"), hook("report-line-amount"))]:
					moving("$90.00"),
				[within(reportLine("fees"), hook("report-line-amount"))]: "−$2.70",
				[within(reportLine("net"), hook("report-line-amount"))]:
					moving("$87.30"),
				[within(reportLine("refunds"), hook("report-line-amount"))]: "$0.00",
				[within(reportKpi("gifts"), hook("report-kpi-value"))]: "$0.00",
				[within(reportKpi("gifts"), hook("report-kpi-change"))]:
					"0 unredeemed gifts (a liability)",
				[hook("report-spark-summary")]: "$90.00 · peak $90.00 (Nov 3)",
				[hook("report-rule", "[data-rule=cutoff]")]:
					"Cancel cutoff (default) 48 hours before",
				[hook("report-rule", "[data-rule=no-show]")]:
					"No-show credits are released",
				[hook("report-rule", "[data-rule=late-cancel]")]:
					"Late cancel credits are released",
				[hook("donors-title")]: moving(
					"Donors and payers 2026 to date · 62 donors, 3 member payers",
				),
				[hook("donors-more")]:
					"Top 15 of 65 by amount. Download for the full list.",
				[hook("donors-audit")]: "Every identified read is audited.",
				[within(hook("donor-row", "[data-id=d_7041]"), hook("donor-name"))]:
					moving("Ines Kim"),
				[within(hook("donor-row", "[data-id=d_7041]"), hook("donor-kind"))]:
					"Donor · Building fund",
				[within(hook("donor-row", "[data-id=d_7041]"), hook("donor-id"))]:
					"d_7041",
				[within(hook("donor-row", "[data-id=d_7041]"), hook("donor-payments"))]:
					"1",
				[within(hook("donor-row", "[data-id=d_7041]"), hook("donor-total"))]:
					"$5,000.00",
				[within(hook("donor-row", "[data-id=d_7041]"), hook("donor-last"))]:
					"Feb 22",
				[within(hook("donor-row", "[data-id=d_2b08]"), hook("donor-name"))]:
					"Raj Ruiz",
				[within(hook("donor-row", "[data-id=d_d20a]"), hook("donor-name"))]:
					"Anonymous name with the owner only",
			},
			count: {
				[hook("donor-row")]: 15,
				[hook("donor-row", "[data-id=s_21]")]: 0,
				[hook("lock-panel")]: 0,
			},
			absent: ["Tom Kim", "Anonymous to finance"],
		},
	},
	{
		id: "reports-as-finance-preview",
		source: `${mockup} reports() as Finance admin: the owner of vol previews the finance audience and still sees the statement and the donors table`,
		route: "#/vol/reports?as=finance&theme=light",
		expect: {
			text: {
				[within(reportLine("net"), hook("report-line-amount"))]: "$226.89",
			},
			count: { [hook("donor-row")]: 11, [hook("lock-panel")]: 0 },
		},
	},
	{
		id: "reports-compare",
		source: `${mockup} reports() with cmp (the period dialog's 'Compare with previous period', compare=1 in the route): each KPI says how it moved against Oct 2026, the sparkline draws the previous period dashed; s5-cmp.mjs`,
		route: "#/vol/reports?compare=1&theme=light",
		expect: {
			text: {
				[within(reportKpi("income"), hook("report-kpi-change"))]:
					"▼ $23.00 vs Oct 2026",
				[within(reportKpi("refund"), hook("report-kpi-change"))]:
					"▼ $50.00 vs Oct 2026",
				[within(reportKpi("fees"), hook("report-kpi-change"))]:
					"▼ $0.81 vs Oct 2026",
				[within(reportKpi("payout"), hook("report-kpi-change"))]:
					"▲ $12.16 vs Oct 2026",
			},
			contains: {
				[hook("report-spark-axis")]: [
					"Nov 1",
					"dashed: previous period",
					"Nov 5",
				],
			},
			count: { [hook("report-kpi-change")]: 5 },
		},
	},
	{
		id: "reports-year-to-date",
		source: `${mockup} reports() on vol for Jan 1 to Nov 5 (a day range): the partial-period line instead of the Stripe match, weekly points over 62 days, the statement titled with the range; s5-text.mjs rep.vol.ytd`,
		route: "#/vol/reports?month=2026-01-01..2026-11-05&theme=light",
		expect: {
			text: {
				[hook("report-status")]:
					"Partial month: summed from daily totals. The hledger report and the Stripe match run on whole months. Cash basis",
				[hook("report-spark-title")]: "Weekly income",
				[hook("report-spark-summary")]:
					"$662.00 · peak $287.00 (week of Oct 29)",
				[hook("report-statement-title")]:
					"Income statement · Jan 1 – Nov 5, 2026",
				[within(reportLine("memberships"), hook("report-line-amount"))]:
					"$635.00",
				[within(reportLine("net"), hook("report-line-amount"))]: "$590.64",
				[within(reportKpi("payout"), hook("report-kpi-value"))]: "$392.16",
			},
			count: { [hook("report-spark-point")]: 45 },
			contains: { [hook("report-spark-axis")]: ["Jan 1", "Nov 5"] },
		},
	},
	{
		id: "reports-empty-school",
		source: `${mockup} reports() on Lotus Lane (no events, no donors): zeros where the books are zero, and 'No donors or payers yet.'; s5-text.mjs rep.nw`,
		route: "#/nw/reports?theme=light",
		expect: {
			text: {
				[hook("report-status")]:
					"Matches Stripe · 0 payments, 0 refunds, 0 payouts Cash basis",
				[within(reportLine("net"), hook("report-line-amount"))]: "$0.00",
				[hook("donors-title")]:
					"Donors and payers 2026 to date · 0 donors, 0 member payers",
				[hook("donors-empty")]: "No donors or payers yet.",
				[hook("donors-audit")]: "Every identified read is audited.",
			},
			count: { [hook("donor-row")]: 0 },
		},
	},
	{
		id: "reports-download",
		source: `${mockup} kReportCsv on b4u, Nov 2026: the eight statement lines with signed two-decimal amounts, the currency and the period; smoke.mjs 'admin csv: Reports download exports the income statement lines'`,
		route: "#/b4u/reports?month=2026-11&theme=light",
		steps: [{ click: hook("report-download") }],
		expect: {
			writes: [
				download("income-statement-2026-11-01_2026-11-30.csv", statementCsv),
			],
			text: { [hook("toast")]: "Downloaded 8 rows" },
		},
	},
	{
		id: "reports-download-pending",
		source:
			"protocol §7 hold writer: the Download button is busy while the file is pending; the toast comes when the Writer answers",
		route: "#/b4u/reports?month=2026-11&theme=light",
		writer: "hold",
		steps: [
			{
				click: hook("report-download"),
				expect: {
					writes: [
						download(
							"income-statement-2026-11-01_2026-11-30.csv",
							statementCsv,
						),
					],
					count: {
						[hook("report-download", '[aria-busy="true"][disabled]')]: 1,
					},
					absent: ["Downloaded"],
				},
			},
			{ release: true },
		],
		expect: {
			text: { [hook("toast")]: "Downloaded 8 rows" },
			count: { [hook("report-download", '[aria-busy="true"]')]: 0 },
		},
	},
	{
		id: "reports-donors-csv",
		source: `${mockup} kDonorsCsv on vol (owner): every row, not only the 15 shown, name, kind, id, fund, payments, total, currency, last payment; the file is named for the clock's day`,
		route: "#/vol/reports?theme=light",
		steps: [{ click: hook("donors-csv") }],
		expect: {
			writes: [download("donors-2026-11-05.csv", donorsCsv)],
			text: { [hook("toast")]: "Downloaded 11 rows" },
		},
	},
	{
		id: "reports-donors-csv-pending",
		source:
			"protocol §7 hold writer: the donors Download CSV is busy while the file is pending",
		route: "#/vol/reports?theme=light",
		writer: "hold",
		steps: [
			{
				click: hook("donors-csv"),
				expect: {
					writes: [download("donors-2026-11-05.csv", donorsCsv)],
					count: { [hook("donors-csv", '[aria-busy="true"][disabled]')]: 1 },
					absent: ["Downloaded"],
				},
			},
			{ release: true },
		],
		expect: { text: { [hook("toast")]: "Downloaded 11 rows" } },
	},
	{
		id: "reports-drill-kpi",
		source: `${mockup} [data-dd] on a KPI: the Ledger with that drill-down (drill() keeps the period, sets the type to All); s5-text.mjs drill.refund`,
		route: "#/vol/reports?theme=light",
		steps: [{ click: reportKpi("refund") }],
		expect: {
			hash: "#/vol/ledger",
			text: { [hook("ledger-filter")]: "Filter: Refunds ×" },
			count: { [hook("ledger-row")]: 1, [ledgerRow("vol-e8")]: 1 },
		},
	},
	{
		id: "reports-drill-line",
		source: `${mockup} [data-dd=gift] on the statement's 'Not income' line: the Ledger with 'Filter: Gift certificates sold ×'; s5-text.mjs drill.gift`,
		route: "#/vol/reports?theme=light",
		steps: [{ click: reportLine("gifts") }],
		expect: {
			hash: "drill=gift",
			text: { [hook("ledger-filter")]: "Filter: Gift certificates sold ×" },
			count: { [hook("ledger-row")]: 1, [ledgerRow("vol-e5")]: 1 },
		},
	},
	{
		id: "reports-gifts-to-promos",
		source: `${mockup} [data-go=cod] on 'Gift certificates outstanding': opens Promos`,
		route: "#/vol/reports?theme=light",
		steps: [{ click: reportKpi("gifts") }],
		expect: { hash: "#/vol/promos", count: { [hook("promo-row")]: 4 } },
	},
	...(
		[
			[
				"public",
				"Public",
				"year",
				"Public sees years.",
				"years, money rounded to $100 (small school)",
				3,
				["Published after 7 Jan 2027", "Published after 7 Jan 2028"],
			],
			[
				"member",
				"Member",
				"quarter",
				"Members see quarters.",
				"quarters, money rounded to $100 (small school)",
				4,
				["Published after 18 Nov 2026", "Published after 18 Feb 2027"],
			],
		] as const
	).map(
		([audience, name, grain, sees, rounding, periods, embargoes]): Entry => ({
			id: `reports-as-${audience}`,
			source: `${mockup} reportsDoc and bkDonors (s5-v2-text.mjs b4u.${audience}.rep): below finance, Reports is the ${name} document at its grain (spec v2: ${grain}, aggregates only), the Stripe reconciliation and the drill-downs are finance-only, and Donors and payers is a lock panel; figures are the document's (S1b, S7), not checked here`,
			route: `#/b4u/reports?as=${audience}&theme=light`,
			covers: { tab: "reports", audience },
			expect: {
				text: {
					[hook("report-grain")]: `Income by ${grain}`,
					[hook("report-grain-note")]:
						`${sees} Days show to finance admins and the owner.`,
					[within(hook("donors"), hook("lock-title"))]:
						"Finance admins and the owner see this",
					[within(hook("donors"), hook("lock-body"))]: donorsLock(name),
					[hook("report-rule", "[data-rule=cutoff]")]:
						"Cancel cutoff (default) 48 hours before",
					[within(reportKpi("payout"), hook("report-kpi-value"))]:
						"Governance and up see this",
					[within(reportKpi("gifts"), hook("report-kpi-value"))]:
						"Governance and up see this",
				},
				contains: {
					[hook("report-status")]: [
						`${name} document`,
						"Reconciliation with Stripe: Finance admins and the owner see this",
					],
					[hook("report-statement-title")]: [`${name} document`],
					[hook("report-rules")]: ["School policy: every audience sees it."],
					[hook("report-doc-note")]: [
						`Figures from the ${name} document: ${rounding}. A figure inside its delay shows when it publishes.`,
					],
					[hook("report-period", ".kwait")]: [...embargoes],
				},
				count: {
					[hook("report-download", `[title^="Download the ${name} document"]`)]:
						1,
					[hook(
						"report-kpi",
						'[disabled][title="Finance admins only: the rows behind a figure"]',
					)]: 4,
					[hook(
						"report-kpi",
						'[data-item=gifts][disabled][title="Finance admins only"]',
					)]: 1,
					[hook("report-line", '[title="Show these events in the ledger"]')]: 0,
					[within(
						hook("donors"),
						hook("lock-panel", '[data-lock="no_grant"]'),
					)]: 1,
					[hook("donor-row")]: 0,
					[hook("donors-csv")]: 0,
					[hook("report-spark-point")]: 0,
					[hook("report-rules-edit")]: 0,
					[hook("report-period")]: periods,
					[hook("report-period", ".kwait")]: embargoes.length,
					[within(hook("report-period"), "[data-hid=embargoed]")]:
						embargoes.length,
					[within(reportKpi("payout"), "[data-hid=no_grant]")]: 1,
				},
				absent: [
					...namesOfB4u,
					"Every identified read is audited",
					"Matches Stripe",
				],
			},
		}),
	),
	{
		id: "reports-as-governance",
		source:
			"mockup 742105b64 reportsDoc and bkDonors for Governance (s5-v2-text.mjs b4u.governance.rep): months, exact, the statement's plan lines, and 'How donors give' as a spread with no names and no rows; smoke.mjs 'books gov: Reports show the distribution instead of the Donors table'",
		route: "#/b4u/reports?as=governance&theme=light",
		covers: { tab: "reports", audience: "governance" },
		expect: {
			text: {
				[hook("report-grain")]: "Income by month",
				[hook("report-grain-note")]:
					"Governance sees months. Days show to finance admins and the owner.",
			},
			contains: {
				[hook("report-status")]: [
					"Governance document",
					"Reconciliation with Stripe: Finance admins and the owner see this",
				],
				[hook("donors")]: [
					"How donors give",
					"spread, no names",
					"Names, emails and per-person rows show to finance admins and the owner only.",
				],
				[hook("report-doc-note")]: [
					"Figures from the Governance document: months, exact. A figure inside its delay shows when it publishes.",
				],
				[hook("report-period", ".kwait")]: [
					"Published after 7 Nov 2026",
					"Published after 7 Dec 2026",
					"Published after 7 Jan 2027",
				],
			},
			count: {
				[hook("report-period")]: 12,
				[hook("report-period", ".kwait")]: 3,
				[hook("donor-row")]: 0,
				[hook("donors-csv")]: 0,
				[within(hook("donors"), hook("lock-panel"))]: 0,
				[hook(
					"report-download",
					'[title^="Download the Governance document"]',
				)]: 1,
			},
			absent: [...namesOfB4u, "Every identified read is audited"],
		},
	},
	{
		id: "reports-pin-locked",
		source: `${mockup} bkLock on Reports (smoke.mjs 'books locked: Reports and Ledger show the lock, not names'): the owner of vol with pin=locked sees the PIN prompt, no statement and no names (a finance admin may not preview Owner: as=owner from b4u falls back to Finance admin)`,
		route: "#/vol/reports?pin=locked&theme=light",
		covers: { tab: "reports", audience: "owner-pin-locked" },
		expect: {
			contains: {
				[hook("pin-lock")]: [
					"Enter your PIN to see books",
					"Owner opens the books with your family PIN. Nothing is shown until you unlock.",
				],
			},
			count: {
				[hook("report-line")]: 0,
				[hook("report-kpi")]: 0,
				[hook("donor-row")]: 0,
				[hook("report-spark-point")]: 0,
			},
			absent: [
				"Ana Pruitt",
				"Ivy N.",
				"Ana P.",
				"Every identified read is audited",
			],
		},
	},
	// ---------------------------------------------------------------- Promos
	{
		id: "promos-default",
		source: `${mockup} codes() on vol (owner): the owner's note, Create promo enabled, four codes masked (mask()), types, values, uses (n or n/max), expiry with 'soon' for an active gift within 30 days, status badges, Redemptions on every row and Disable on the active ones; s5-text.mjs cod.vol`,
		route: "#/vol/promos?theme=light",
		covers: { tab: "promos", audience: "owner" },
		expect: {
			text: {
				[hook("promo-note")]:
					"Owners create promos. Admins can view and disable.",
				[hook("promo-new")]: "Create promo",
				[within(promoRow("c_01"), hook("promo-code"))]: "SPR•••10",
				[within(promoRow("c_01"), hook("promo-type"))]: "Member % off",
				[within(promoRow("c_01"), hook("promo-value"))]: "10% off tiers",
				[within(promoRow("c_01"), hook("promo-used"))]: moving("3"),
				[within(promoRow("c_01"), hook("promo-expires"))]: "2026-12-31",
				[within(promoRow("c_01"), hook("promo-status"))]: "active",
				[within(promoRow("c_02"), hook("promo-code"))]: "GIF•••X2",
				[within(promoRow("c_02"), hook("promo-type"))]: "Dollar gift",
				[within(promoRow("c_02"), hook("promo-value"))]: "$50.00",
				[within(promoRow("c_02"), hook("promo-used"))]: "0/1",
				[within(promoRow("c_03"), hook("promo-type"))]: "Session gift",
				[within(promoRow("c_03"), hook("promo-value"))]: "4 sessions",
				[within(promoRow("c_03"), hook("promo-used"))]: moving("1/1"),
				[within(promoRow("c_03"), hook("promo-status"))]: "redeemed",
				[within(promoRow("c_04"), hook("promo-code"))]: "THA•••U2",
				[within(promoRow("c_04"), hook("promo-expires"))]: "2026-11-30 soon",
				[within(promoRow("c_04"), hook("promo-soon"))]: "soon",
			},
			count: {
				[hook("promo-row")]: 4,
				[hook("promo-new", ":not([disabled])")]: 1,
				[hook("promo-soon")]: 1,
				[hook("promo-redemptions")]: 4,
				[hook("promo-disable")]: 3,
				[within(promoRow("c_03"), hook("promo-disable"))]: 0,
				[hook("promo-reveal", '[aria-label="Show code"]')]: 4,
				[hook("promo-copy", '[aria-label="Copy code"]')]: 4,
				[hook("promo-empty")]: 0,
			},
			contains: {
				[hook("pane")]: ["Code", "Type", "Value", "Used", "Expires", "Status"],
			},
		},
		shot: { full: true, mockupSteps: mockupTab("cod") },
	},
	{
		id: "promos-reveal",
		source: `${mockup} [data-rev]: the eye shows the full code and becomes Hide code; a second click masks it again; s5-text.mjs cod.vol.reveal`,
		route: "#/vol/promos?theme=light",
		steps: [
			{
				click: within(promoRow("c_01"), hook("promo-reveal")),
				expect: {
					text: { [within(promoRow("c_01"), hook("promo-code"))]: "SPRING10" },
					count: {
						[within(
							promoRow("c_01"),
							hook("promo-reveal", '[aria-label="Hide code"]'),
						)]: 1,
					},
				},
			},
			{ click: within(promoRow("c_01"), hook("promo-reveal")) },
		],
		expect: {
			text: { [within(promoRow("c_01"), hook("promo-code"))]: "SPR•••10" },
			absent: ["SPRING10"],
		},
	},
	{
		id: "promos-finance-admin",
		source: `${mockup} codes() on b4u, where Jo A. is an admin (finance grant, not owner): the admin's note, Create promo disabled with the owner-role title, a 5-character code shown unmasked; s5-text.mjs cod.b4u`,
		route: "#/b4u/promos?theme=light",
		covers: { tab: "promos", audience: "finance" },
		expect: {
			text: {
				[hook("promo-note")]:
					"You are an admin here: you can view and disable promos. Owners create them.",
				[within(promoRow("c_11"), hook("promo-code"))]: "UNI15",
				[within(promoRow("c_11"), hook("promo-value"))]: "15% off tiers",
				[within(promoRow("c_11"), hook("promo-used"))]: moving("2"),
			},
			count: {
				[hook("promo-row")]: 1,
				[hook(
					"promo-new",
					'[disabled][title="Creating promos needs the owner role in this school"]',
				)]: 1,
				[hook("promo-disable")]: 1,
				[hook("promo-redemptions", ":not([disabled])")]: 1,
			},
		},
	},
	{
		id: "promos-empty",
		source: `${mockup} codes() on Lotus Lane: 'No promos yet.' and no rows; s5-text.mjs cod.nw`,
		route: "#/nw/promos?theme=light",
		expect: {
			text: { [hook("promo-empty")]: "No promos yet." },
			count: {
				[hook("promo-row")]: 0,
				[hook("promo-new", ":not([disabled])")]: 1,
			},
		},
	},
	{
		id: "promos-disable",
		source: `${mockup} [data-dis]: the promo is disabled, its row loses Disable and the soon badge, the toast names the masked code; s5-text.mjs cod.vol.disable`,
		route: "#/vol/promos?theme=light",
		steps: [{ click: within(promoRow("c_04"), hook("promo-disable")) }],
		expect: {
			writes: [
				{ method: "disablePromo", args: [{ school: "vol", promoId: "c_04" }] },
			],
			text: {
				[hook("toast")]:
					"Promo THA•••U2 disabled. It stops working at checkout now.",
				[within(promoRow("c_04"), hook("promo-status"))]: "disabled",
				[within(promoRow("c_04"), hook("promo-expires"))]: "2026-11-30",
			},
			count: {
				[within(promoRow("c_04"), hook("promo-disable"))]: 0,
				[hook("promo-soon")]: 0,
				[hook("promo-disable")]: 2,
			},
		},
	},
	{
		id: "promos-disable-pending",
		source:
			"protocol §7 hold writer: while disablePromo is pending the row's Disable is busy and the status still reads active; the toast and the disabled status come when the Writer answers",
		route: "#/vol/promos?theme=light",
		writer: "hold",
		steps: [
			{
				click: within(promoRow("c_04"), hook("promo-disable")),
				expect: {
					writes: [
						{
							method: "disablePromo",
							args: [{ school: "vol", promoId: "c_04" }],
						},
					],
					text: { [within(promoRow("c_04"), hook("promo-status"))]: "active" },
					count: {
						[within(
							promoRow("c_04"),
							hook("promo-disable", '[aria-busy="true"][disabled]'),
						)]: 1,
					},
					absent: ["stops working at checkout"],
				},
			},
			{ release: true },
		],
		expect: {
			text: {
				[within(promoRow("c_04"), hook("promo-status"))]: "disabled",
				[hook("toast")]:
					"Promo THA•••U2 disabled. It stops working at checkout now.",
			},
		},
	},
	{
		id: "promos-new-dialog",
		source: `${mockup} openAct('code'): the dialog's title and subtitle, the type options, value 10 and expiry 2026-12-31 by default, the required note, the preview line; Create promo stays disabled until the note has 3 characters; Cancel closes it; s5-text.mjs cod.vol.new`,
		route: "#/vol/promos?theme=light",
		steps: [
			{
				click: hook("promo-new"),
				expect: {
					text: {
						[hook("dialog-title")]: "Create promo · Vibes of Light",
						[hook("promo-preview")]:
							"Members get 10% off membership tiers at checkout until 2026-12-31. Sessions granted stay full. One code per checkout.",
						[hook("dialog-confirm")]: "Create promo",
					},
					contains: {
						[hook("dialog")]: [
							"New promo",
							"Member % off",
							"Dollar gift certificate",
							"Session gift certificate",
							"Value (% off, dollars or sessions)",
							"Expires",
							"Note (required)",
						],
					},
					count: {
						[hook("promo-type-input", " option")]: 3,
						[hook("promo-value-input", '[value="10"]')]: 1,
						[hook("promo-expires-input", '[value="2026-12-31"]')]: 1,
						[hook("dialog-confirm", "[disabled]")]: 1,
					},
				},
			},
			{
				fill: hook("promo-note-input"),
				value: "ok",
				expect: { count: { [hook("dialog-confirm", "[disabled]")]: 1 } },
			},
			{ click: hook("dialog-cancel") },
		],
		expect: {
			count: { [hook("dialog")]: 0, [hook("promo-row")]: 4 },
			writes: [],
		},
	},
	{
		id: "promos-new-validation",
		source: `${mockup} ACT.code.prev: a value of 0 and a percentage over 100 are refused with the reason; a dollar gift and a session gift preview what they do; s5-text.mjs cod.vol.new.zero, .150, .dollar, .session`,
		route: "#/vol/promos?theme=light",
		steps: [
			{ click: hook("promo-new") },
			{ fill: hook("promo-note-input"), value: "Autumn offer" },
			{
				fill: hook("promo-value-input"),
				value: "0",
				expect: {
					text: { [hook("promo-preview")]: "Enter a value above 0." },
					count: { [hook("dialog-confirm", "[disabled]")]: 1 },
				},
			},
			{
				fill: hook("promo-value-input"),
				value: "150",
				expect: {
					text: { [hook("promo-preview")]: "A percentage can't exceed 100." },
					count: { [hook("dialog-confirm", "[disabled]")]: 1 },
				},
			},
			{ fill: hook("promo-type-input"), value: "dollar" },
			{
				fill: hook("promo-value-input"),
				value: "50",
				expect: {
					text: {
						[hook("promo-preview")]:
							"A one-use Stripe promotion code worth $50.00, expiring 2026-12-31. Nothing is booked until it is sold or redeemed.",
					},
					count: { [hook("dialog-confirm", ":not([disabled])")]: 1 },
				},
			},
			{ fill: hook("promo-type-input"), value: "session" },
			{
				fill: hook("promo-value-input"),
				value: "4",
				expect: {
					text: {
						[hook("promo-preview")]:
							"Redeeming grants 4 sessions once, expiring 2026-12-31. No money moves in Stripe.",
					},
				},
			},
		],
		expect: { writes: [] },
	},
	{
		id: "promos-create",
		source: `${mockup} ACT.code then promoDone: the created dialog shows the full code once, its type, value and expiry, and how it will appear masked; Done closes it and the new code heads the table masked with no uses; the fixture Writer answers CODE1000 (the mockup's prefix, the lowest of its random range); s5-text.mjs cod.vol.created`,
		route: "#/vol/promos?theme=light",
		steps: [
			{ click: hook("promo-new") },
			{ fill: hook("promo-note-input"), value: "Autumn offer" },
			{
				click: hook("dialog-confirm"),
				expect: {
					writes: [
						{
							method: "createPromo",
							args: [
								{
									school: "vol",
									type: "member",
									value: 10,
									expiresOn: "2026-12-31",
									note: "Autumn offer",
								},
							],
						},
					],
					text: {
						[hook("dialog-title")]: "Promo created · Vibes of Light",
						[hook("promo-created-code")]: "CODE1000",
						[hook("promo-created-summary")]:
							"Member % off · 10% off tiers · expires 2026-12-31",
						[hook("promo-created-note")]:
							"The full code is shown only now. Later it appears masked (COD•••00); an owner can still reveal it.",
						[hook("dialog-confirm")]: "Done",
					},
					count: { [hook("promo-email-input")]: 0 },
				},
			},
			{ click: hook("dialog-confirm") },
		],
		expect: {
			text: {
				[within(promoRow("c_new"), hook("promo-code"))]: "COD•••00",
				[within(promoRow("c_new"), hook("promo-used"))]: "0",
				[within(promoRow("c_new"), hook("promo-status"))]: "active",
			},
			count: {
				[hook("dialog")]: 0,
				[hook("promo-row")]: 5,
				[`${hook("promo-row")}:first-child[data-promo=c_new]`]: 1,
			},
		},
	},
	{
		id: "promos-create-gift",
		source: `${mockup} ACT.code for a dollar gift: the value is sent in minor units, the code is GIFT…, and the created dialog offers to email it (gift codes only)`,
		route: "#/vol/promos?theme=light",
		steps: [
			{ click: hook("promo-new") },
			{ fill: hook("promo-type-input"), value: "dollar" },
			{ fill: hook("promo-value-input"), value: "50" },
			{ fill: hook("promo-note-input"), value: "Raffle prize" },
			{ click: hook("dialog-confirm") },
		],
		expect: {
			writes: [
				{
					method: "createPromo",
					args: [
						{
							school: "vol",
							type: "dollar",
							value: 5000,
							expiresOn: "2026-12-31",
							note: "Raffle prize",
						},
					],
				},
			],
			text: {
				[hook("promo-created-code")]: "GIFT1000",
				[hook("promo-created-summary")]:
					"Dollar gift · $50.00 · expires 2026-12-31",
			},
			contains: { [hook("dialog")]: ["Email it to the recipient (optional)"] },
			count: { [hook("promo-email-input")]: 1 },
		},
	},
	{
		id: "promos-create-pending",
		source:
			"protocol §7 hold writer: while createPromo is pending the dialog stays open with Create promo busy, no code is shown and the table is unchanged; the created dialog comes when the Writer answers",
		route: "#/vol/promos?theme=light",
		writer: "hold",
		steps: [
			{ click: hook("promo-new") },
			{ fill: hook("promo-note-input"), value: "Autumn offer" },
			{
				click: hook("dialog-confirm"),
				expect: {
					writes: [
						{
							method: "createPromo",
							args: [
								{
									school: "vol",
									type: "member",
									value: 10,
									expiresOn: "2026-12-31",
									note: "Autumn offer",
								},
							],
						},
					],
					text: { [hook("dialog-title")]: "Create promo · Vibes of Light" },
					count: {
						[hook("dialog-confirm", '[aria-busy="true"][disabled]')]: 1,
						[hook("promo-created-code")]: 0,
						[hook("promo-row")]: 4,
					},
				},
			},
			{ release: true },
		],
		expect: { text: { [hook("promo-created-code")]: "CODE1000" } },
	},
	{
		id: "promos-redemptions",
		source: `${mockup} [data-red]: Redemptions opens the Ledger for the year to date filtered to that code; s5-text.mjs cod.vol.redemptions`,
		route: "#/vol/promos?theme=light",
		steps: [{ click: within(promoRow("c_01"), hook("promo-redemptions")) }],
		expect: {
			hash: "promo=c_01",
			text: { [hook("ledger-filter")]: "Promo SPR•••10 ×" },
			count: { [hook("ledger-row")]: 1 },
		},
	},
	...(["public", "member"] as const).map(
		(audience): Entry => ({
			id: `promos-as-${audience}`,
			source: `${mockup} codes() (s5-v2-text.mjs vol.${audience}.cod): a preview below governance shows the codes masked but not how often each was used (a breakdown: Governance and up), not who redeemed (finance and owner), and no action ('Exit preview to act')`,
			route: `#/vol/promos?as=${audience}&theme=light`,
			covers: { tab: "promos", audience },
			expect: {
				text: {
					[hook("promo-note")]:
						"Owners and admins manage promos. Redemption counts are a breakdown (Governance and up); who redeemed is finance and owner only.",
					[within(promoRow("c_01"), hook("promo-used"))]:
						"Governance and up see this",
				},
				count: {
					[hook("promo-row")]: 4,
					[hook(
						"promo-used",
						'[data-hid="no_grant"][title="Governance and up see this"]',
					)]: 4,
					[hook(
						"promo-redemptions",
						'[disabled][title="Finance admins only: lists who redeemed"]',
					)]: 4,
					[hook("promo-reveal", '[disabled][title="Owners and admins only"]')]:
						4,
					[hook("promo-new", '[disabled][title="Exit preview to act"]')]: 1,
				},
				absent: ["SPRING10"],
			},
		}),
	),
	{
		id: "promos-as-governance",
		source:
			"mockup 742105b64 codes() for Governance (s5-v2-text.mjs vol.governance.cod): uses are a breakdown Governance sees, and a count from 1 to 9 under the cell rules shows as <10 (spec v2 small counts), never 0; who redeemed stays finance and owner only",
		route: "#/vol/promos?as=governance&theme=light",
		covers: { tab: "promos", audience: "governance" },
		expect: {
			text: {
				[within(promoRow("c_01"), hook("promo-used"))]: "<10",
				[within(promoRow("c_02"), hook("promo-used"))]: "0/1",
				[within(promoRow("c_03"), hook("promo-used"))]: "<10/1",
			},
			count: {
				[hook(
					"promo-used",
					'[title="Rounded to the nearest 10: fewer than 5 redeemers"]',
				)]: 2,
				[hook(
					"promo-redemptions",
					'[disabled][title="Finance admins only: lists who redeemed"]',
				)]: 4,
				[hook("promo-new", '[disabled][title="Exit preview to act"]')]: 1,
			},
		},
	},
	{
		id: "promos-as-finance-preview",
		source:
			"mockup 742105b64 codes() as Finance admin from the owner's seat (s5-v2-text.mjs vol.finance.cod): exact uses and Redemptions enabled, but a preview does not act ('Exit preview to act')",
		route: "#/vol/promos?as=finance&theme=light",
		expect: {
			text: { [within(promoRow("c_01"), hook("promo-used"))]: "3" },
			count: {
				[hook("promo-redemptions", ":not([disabled])")]: 4,
				[hook("promo-new", '[disabled][title="Exit preview to act"]')]: 1,
			},
		},
	},
];

const golden = {
	slice: "S5",
	source:
		"The mockup's schools (plans/ledger-ui/design/mockup.html on dev at 742105b64, disclosure v2 merged and frozen, its SC table): Vibes of Light (vol, the owner Kim R.), B4 Uni (b4u, Jo A., an admin with the finance grant), Lotus Lane Yoga (nw, empty). Ledger events from SC.<school>.E, promos from SC.<school>.K, donors from SC.<school>.don and bkMakeDonors, rules from SC.<school>.rules; the statement as the mockup's calc() works it (Stripe fees invented at 3% of cash taken). Audience gating per spec v2 and the same mockup (View as, VW, lockPanel, kFigHtml). Read headless with plans/ledger-ui/loop/tools/s5-text.mjs and s5-v2-text.mjs; written by s5-golden.ts.",
	notes: [
		"Data: src/data/ledger.ts (LedgerReader, LedgerWriter). The Reader gives ledger({ school, from, to, type, drill, promo }), incomeStatement({ school, from, to, compare }), audienceReport({ school, audience, from, to }), donors({ school, audience, year }), promos({ school, audience }) and schoolRules(school); the Writer gives download(file), createPromo(request) and disablePromo(request). The fixture Reader and Writer share no state: after a write the UI shows what the Writer answered.",
		"Routes: #/<school>/ledger?month=&type=&drill=&promo=&as=&pin=; #/<school>/reports?month=&compare=&as=&pin=; #/<school>/promos?as=. month is the period control's (S0). type is payment, credit, booking, code, payout or admin (absent: All). drill is a LedgerDrill (a Reports KPI or statement line); promo a promo id (its Redemptions, which also sets month to the year to date). compare=1 is the period dialog's 'Compare with previous period'. as is the audience (shared contract; absent: the signed-in person's, b4u finance, the other schools owner); pin=locked from governance up shows the PIN prompt (S1's pin-lock).",
		"Fixture ids: a ledger event's id is <school>-e<index>, its index in the mockup's SC.<school>.E after the mockup's own unshifts (s5-events.mjs lists them); payment ids are the mockup's (pay_<index><school name length>, or the pid it presets); a member's key is family:<member id>, except B4 Uni's Wu family (s_21, s_25, s_26: family:fam_wu); an event about no member has key school:<school>. Within a day the rows keep the mockup table's order (vol Nov: e0, e2, e1, e3 | e4, e5, e6, e7 | e9, e8, e10 | e12, e11, e13, e14; b4u Nov: e1, e0, e3, e2 | e4).",
		"root.dataset.route is set once the tab shows the route's data (or its lock panel).",
		"Ledger hooks: ledger-type (data-type all|payment|credit|booking|code|payout|admin, class 'on' when selected; the credit chip is named after the unit), ledger-filter (the drill or promo chip; clicking it removes drill and promo), ledger-count, ledger-csv, ledger-credit-head (the credits column head), ledger-day (data-day) with ledger-day-label, ledger-day-credits and ledger-day-amount, ledger-pending (the 'Waiting to ship' row), ledger-row (data-event) with ledger-time, ledger-event, ledger-member, ledger-what (text, then ' · <booking>', ' · promo <masked>', ' · <source>', ' Details'), ledger-credits, ledger-amount (class neg when negative), ledger-details (the row's details line, toggled by clicking the row), ledger-empty.",
		"Reports hooks: report-download, report-status, report-spark with report-spark-title, report-spark-summary, report-spark-point (one per drawn point, its title '<day or week>: <amount>'), report-spark-axis; report-kpi (data-item income|refund|fees|payout|gifts) with report-kpi-label, report-kpi-value, report-kpi-change; report-statement-title; report-line (data-line memberships|bookings|discounts|income|refunds|fees|net|gifts) with report-line-label and report-line-amount; report-rules, report-rule (data-rule cutoff|no-show|late-cancel; its two cells), report-rules-edit; below finance report-grain, report-grain-note, report-period (one per period of the grain) and report-doc-note. Clicking a report-kpi or report-line with the title 'Show these events in the ledger' opens the Ledger with that drill; the gifts KPI opens Promos.",
		"Donors hooks: donors (the card), donors-title, donors-csv, donor-row (data-id) with donor-name, donor-kind, donor-id, donor-payments, donor-total, donor-last; donors-more, donors-audit, donors-empty. Governance gets the spread (no donor-row); public and member a lock panel inside donors.",
		"Promos hooks: promo-note, promo-new, promo-row (data-promo, newest first), promo-code, promo-reveal, promo-copy, promo-type, promo-value, promo-used (data-hid when hidden; a title when rounded or hidden), promo-expires, promo-soon, promo-status, promo-redemptions, promo-disable, promo-empty. The create dialog is the shared dialog (dialog, dialog-title, dialog-confirm, dialog-cancel) with promo-type-input (a select whose option values are member, dollar, session; it answers the input event), promo-value-input, promo-expires-input, promo-note-input and promo-preview; once created, the same dialog shows promo-created-code, promo-created-summary, promo-created-note, promo-email-input (gifts only) and dialog-confirm 'Done'.",
		"Lock panels (spec v2: who may see it and when, never an empty table or a 0): lock-panel (data-lock no_grant), lock-title, lock-body. The Ledger below finance is one; Reports below finance keeps the audience's document and puts one in the Donors card for public and member. PIN-locked views use S1's pin-lock.",
		"Audience figures below finance (spec v2 kFigHtml): a hidden figure carries data-hid (embargoed, members_only, no_grant) and its text: embargoed 'Published after <d Mon yyyy>' (the cell's until), members_only 'Members see this', no_grant 'Governance and up see this' or 'Finance admins and the owner see this'; an embargoed report-period carries class kwait. A count from 1 to 9 under the cell rules reads <10 with the title 'Rounded to the nearest 10: fewer than 5 <who>'. Money is rounded per audience and school size by the Reader; the doc note says how.",
		"as= never previews above the signed-in person: a finance admin asking for as=owner gets Finance admin (mockup vaAllowed; audienceOf in the contract). B4 Uni's mockup opens every tab on Jun 2026 (pDef), so its finance entries pin month=2026-11; period-button labels are S0 and S0b's and are not checked here.",
		"Anonymous donors (spec v2): the Reader gives the finance admin name 'Anonymous' and anonymous true, and the row reads 'Anonymous name with the owner only'; the owner gets the name and the badge 'Anonymous to finance' (no entry: no mockup school lets its owner see B4 Uni's donors).",
		"Writes: every write's button is disabled with aria-busy='true' while the Writer's promise is pending; toasts use the shared toast hook. A preview (an as= other than the signed-in person's own audience) acts on nothing: Create promo is disabled with the title 'Exit preview to act'.",
		"Texts the mockup gets wrong are not checked: its plural for one ('1 events', '1 payments'); its CSV currency for a C$ school (USD); its CSV row order (its array order, not the table's).",
		"Not mapped: the Ledger's pending rows ('Waiting to ship', written by S2 and S4 actions, have no entry here); the Copy code and Copy checkout link toasts; the created gift's Send by email (no Writer call in the mockup); a tab badge that drops after a disable (the badge is the School's, read once); Maple Pilates (its C$ money and USD CSV); the audience documents' figures (S1b and S7's disclosure documents).",
	],
	hooks: [
		"lock-panel",
		"lock-title",
		"lock-body",
		"ledger-type",
		"ledger-filter",
		"ledger-count",
		"ledger-csv",
		"ledger-credit-head",
		"ledger-day",
		"ledger-day-label",
		"ledger-day-credits",
		"ledger-day-amount",
		"ledger-pending",
		"ledger-row",
		"ledger-time",
		"ledger-event",
		"ledger-member",
		"ledger-what",
		"ledger-credits",
		"ledger-amount",
		"ledger-details",
		"ledger-empty",
		"report-download",
		"report-status",
		"report-spark",
		"report-spark-title",
		"report-spark-summary",
		"report-spark-point",
		"report-spark-axis",
		"report-kpi",
		"report-kpi-label",
		"report-kpi-value",
		"report-kpi-change",
		"report-statement-title",
		"report-line",
		"report-line-label",
		"report-line-amount",
		"report-rules",
		"report-rule",
		"report-rules-edit",
		"report-grain",
		"report-grain-note",
		"report-period",
		"report-doc-note",
		"donors",
		"donors-title",
		"donors-csv",
		"donor-row",
		"donor-name",
		"donor-kind",
		"donor-id",
		"donor-payments",
		"donor-total",
		"donor-last",
		"donors-more",
		"donors-audit",
		"donors-empty",
		"promo-note",
		"promo-new",
		"promo-row",
		"promo-code",
		"promo-reveal",
		"promo-copy",
		"promo-type",
		"promo-value",
		"promo-used",
		"promo-expires",
		"promo-soon",
		"promo-status",
		"promo-redemptions",
		"promo-disable",
		"promo-empty",
		"promo-type-input",
		"promo-value-input",
		"promo-expires-input",
		"promo-note-input",
		"promo-preview",
		"promo-created-code",
		"promo-created-summary",
		"promo-created-note",
		"promo-email-input",
		"toast",
		"dialog",
		"dialog-title",
		"dialog-confirm",
		"dialog-cancel",
	],
	moves: {
		fields: [
			"ledger.count",
			"ledger.days[].count",
			"ledger.days[].credits",
			"ledger.days[].amountCents",
			"ledger.days[].entries[].credits",
			"ledger.days[].entries[].amountCents",
			"ledger.days[].entries[].member.name",
			"incomeStatement.counts.payments",
			"incomeStatement.amounts.memberships",
			"incomeStatement.amounts.income",
			"incomeStatement.amounts.net",
			"incomeStatement.income.totalCents",
			"incomeStatement.income.peak.amountCents",
			"donors.donorCount",
			"donors.payerCount",
			"donors.rows[].name",
			"donors.rows[].totalCents",
			"promos.promos[].used",
		],
	},
	matrix: {
		tab: ["ledger", "reports", "promos"],
		audience: ["public", "member", "governance", "finance", "owner"],
	},
	entries,
};

writeFileSync(
	join(packageRoot, "test/golden/S5.json"),
	`${JSON.stringify(golden, null, "\t")}\n`,
);
