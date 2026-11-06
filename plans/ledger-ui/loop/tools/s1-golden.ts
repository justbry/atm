/**
 * Writes packages/ledger-ui/test/golden/S1.json: the mockup's Dashboard copy for the five books levels (read headless
 * with s1-text.mjs from the mockup at 10ca2a6c1, #115) and values taken from the committed fixture documents, formatted
 * per cell-rules v3. Usage, from packages/ledger-ui: bun ../../plans/ledger-ui/loop/tools/s1-golden.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	BooksLevel,
	Cell,
	KpiDocument,
	LagClass,
} from "../../../../packages/ledger-ui/src/data/kpi-document.ts";

const packageRoot = join(import.meta.dir, "../../../../packages/ledger-ui");
const mart = join(packageRoot, "src/fixtures/mart");
const documents = JSON.parse(
	readFileSync(join(mart, "documents.json"), "utf8"),
) as Record<string, KpiDocument>;
const labels = (
	JSON.parse(readFileSync(join(mart, "cell-rules.json"), "utf8")) as {
		labels: Record<string, string>;
	}
).labels;

type View = "money" | "members" | "risk";
const levels: BooksLevel[] = [
	"public",
	"member",
	"governance",
	"finance_admin",
	"owner",
];
const levelNames: Record<BooksLevel, string> = {
	public: "Public",
	member: "Member",
	governance: "Governance",
	finance_admin: "Finance admin",
	owner: "Owner",
};
const hasPin = (level: BooksLevel): boolean =>
	level === "governance" || level === "finance_admin" || level === "owner";
const aggregate = (level: BooksLevel): boolean =>
	level === "public" || level === "member";
const viewNames: Record<View, string> = {
	money: "Money",
	members: "Members",
	risk: "Risk",
};
/** The mockup's cards (dashAgg and dashFull kc(...) calls) and the KPI each card's value shows. */
const aggregateCards: Record<View, Array<[string, string | null]>> = {
	money: [
		["Gross collected", "gross_collected"],
		["Refunds", "refunds"],
		["Payment fees", "stripe_fees"],
		["Net income", "net_income"],
		["Paid out", "payouts"],
	],
	members: [
		["Paying members", "paying_members"],
		["New paying", "new_paying_members"],
		["Credits used", "credits_consumed"],
	],
	risk: [
		["Refund rate", "refund_rate"],
		["Disputes opened", "disputes_opened"],
		["Dispute cost", null],
	],
};
const fullCards: Record<View, Array<[string, string | null]>> = {
	money: aggregateCards.money,
	members: [
		["Paying members", "paying_members"],
		["New paying", "new_paying_members"],
		["Avg per paying member", "arpa"],
		["Credits used", "credits_consumed"],
	],
	risk: [
		["Refund rate", "refund_rate"],
		["Disputes opened", "disputes_opened"],
		["Dispute cost", null],
		["Net income", "net_income"],
	],
};
const cardsOf = (level: BooksLevel) =>
	aggregate(level) ? aggregateCards : fullCards;
const aggregateViews: Record<View, string[]> = {
	money: [
		"gross_collected",
		"refunds",
		"refund_rate",
		"stripe_fees",
		"net_income",
		"payouts",
	],
	members: [
		"paying_members",
		"new_paying_members",
		"credits_consumed",
		"credits_granted",
		"credits_expired",
	],
	risk: [
		"refund_rate",
		"refunds",
		"disputes_opened",
		"disputes_lost",
		"dispute_fees",
	],
};
const fullViews: Record<View, string[]> = {
	money: [...aggregateViews.money, "revenue_by_tier:*", "donations_by_fund:*"],
	members: [
		"paying_members",
		"new_paying_members",
		"arpa",
		"credits_consumed",
		"credits_granted",
		"credits_expired",
		"donors_count",
		"donors_by_size:*",
		"donors_median_gift",
	],
	risk: [...aggregateViews.risk, "net_income"],
};
const badges = ["Cash basis · $", "Fixture data: invented"];
const samplePeriod: Record<BooksLevel, string> = {
	public: "2024",
	member: "2026-Q2",
	governance: "2026-06",
	finance_admin: "2026-06",
	owner: "2026-06",
};
const lagOf = (view: View): LagClass =>
	view === "members" ? "usage" : "money";

const documentOf = (
	preset: string,
	level: BooksLevel,
	pinLocked = false,
): KpiDocument => {
	const key = `${preset}.${level}${pinLocked ? ".pin-locked" : ""}`;
	const document = documents[key];
	if (!document) throw new Error(`no document ${key}`);
	return document;
};
const money = (cents: number, currency: string, decimals: boolean): string =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: currency.toUpperCase(),
		...(decimals ? {} : { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
	}).format(cents / 100);
const cellOf = (document: KpiDocument, kpi: string, period: string): Cell => {
	const cell = document.series[kpi]?.[document.periods.indexOf(period)];
	if (cell === undefined)
		throw new Error(`${kpi}@${period} not in the document`);
	return cell;
};
const text = (document: KpiDocument, kpi: string, period: string): string => {
	const cell = cellOf(document, kpi, period);
	const format = document.meta[kpi]?.format;
	if (!format) throw new Error(`${kpi} has no meta`);
	const isMoney = format === "money" || format === "money0";
	if (typeof cell !== "number")
		return "lt" in cell
			? isMoney
				? `under ${money(cell.lt, document.currency, false)}`
				: `<${cell.lt}`
			: (labels[cell.hidden] ?? "");
	if (isMoney) return money(cell, document.currency, format === "money");
	if (format === "integer") return new Intl.NumberFormat("en-US").format(cell);
	return new Intl.NumberFormat("en-US", {
		style: "percent",
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	}).format(cell);
};
const labelOf = (document: KpiDocument, period: string): string =>
	document.periodInfo.find((info) => info.period === period)?.label ?? period;
const route = (
	preset: string,
	level: BooksLevel,
	pinLocked: boolean,
	view: View,
	period: string,
): string =>
	`#/b4u/dashboard?preset=${preset}&level=${level}${pinLocked ? "&pin=locked" : ""}&view=${view}&month=${period}&theme=light`;
const value = (kpi: string): string =>
	`[data-test=kpi-value][data-kpi="${kpi}"]`;
const cell = (kpi: string, period: string): string =>
	`[data-kpi="${kpi}"][data-period="${period}"]`;
const periodButton = (period: string): string =>
	`[data-test=dash-period][data-period="${period}"]`;
const mockupLevel: Record<BooksLevel, string> = {
	public: "public",
	member: "member",
	governance: "gov",
	finance_admin: "fin",
	owner: "owner",
};
/** Clicks the mockup into the closest screen: b4u, the Dashboard, the level, the preset, the view, the period. */
const mockupSteps = (
	level: BooksLevel,
	preset: string,
	view: View,
	period: string,
): string =>
	[
		"document.querySelector('#sw').click()",
		"document.querySelector('[data-sc=b4u]').click()",
		"document.querySelector('.tab[data-p=dash]').click()",
		`document.querySelector('#dash [data-bv=${mockupLevel[level]}]').click()`,
		`document.querySelector('#dash [data-dsc=${preset}]').click()`,
		`document.querySelector('#dash [data-dv=${view}]').click()`,
		aggregate(level)
			? `document.querySelector('#dash [data-dpk="${period.replace("-", "")}"]').click()`
			: `document.querySelector('#dash .kmonths [data-dm="${Number(period.slice(5, 7)) - 1}"]').click()`,
	].join(";");
const cardValues = (
	document: KpiDocument,
	level: BooksLevel,
	view: View,
	period: string,
): Record<string, string> =>
	Object.fromEntries(
		cardsOf(level)[view].flatMap(([, kpi]) =>
			kpi ? [[value(kpi), text(document, kpi, period)]] : [],
		),
	);
const lockLines = (level: BooksLevel): string[] => [
	"Enter your PIN to see books",
	`${levelNames[level]} opens the books with your family PIN. Nothing is shown until you unlock.`,
	"Your family PIN",
	"Unlock",
];

const matrixEntries = levels.flatMap((level) =>
	[false, true].flatMap((pinLocked) =>
		(["money", "members", "risk"] as View[]).map((view) => {
			const period = samplePeriod[level];
			const locked = pinLocked && hasPin(level);
			const document = documentOf("monthly-members", level, locked);
			const covers = {
				view,
				level,
				pinLocked: pinLocked ? "locked" : "open",
			};
			const id = `matrix-${view}-${level}-${covers.pinLocked}`;
			const common = {
				text: {
					"[data-test=books-level].on": levelNames[level],
				},
				count: {
					"[data-test=books-level]": 5,
					"[data-test=pin-chip]": hasPin(level) ? 1 : 0,
				},
			};
			if (locked)
				return {
					id,
					source: `mockup 10ca2a6c1 bkSwitch and bkLock: ${levelNames[level]} with the PIN locked shows only the PIN prompt; the chip is on`,
					route: route("monthly-members", level, true, view, period),
					covers,
					expect: {
						text: common.text,
						count: {
							...common.count,
							"[data-test=pin-chip].on": 1,
							"[data-test=pin-lock]": 1,
							"[data-test=pin-unlock][disabled]": 1,
							"[data-test=kpi-card]": 0,
							"[data-test=dash-period]": 0,
						},
						contains: { "[data-test=pin-lock]": lockLines(level) },
					},
				};
			const cards = cardsOf(level)[view];
			return {
				id,
				source: `mockup 10ca2a6c1 dashboard() on b4u, Monthly members, ${levelNames[level]}, ${view}: the switcher, the caption, the period strip, the cards and badges; values from documents.json monthly-members.${level} at ${period}, formatted per cell-rules v3${pinLocked ? "; pin=locked is ignored below Governance (no PIN)" : ""}`,
				route: route("monthly-members", level, pinLocked, view, period),
				covers,
				expect: {
					text: {
						...common.text,
						"[data-test=dash-view].on": viewNames[view],
						"[data-test=dash-period].on": labelOf(document, period),
						"[data-test=dash-caption]": document.caption[lagOf(view)],
						"[data-test=preset-option].on": "Monthly members",
						...cardValues(document, level, view, period),
					},
					count: {
						...common.count,
						"[data-test=pin-lock]": 0,
						"[data-test=kpi-card]": cards.length,
						"[data-test=dash-view]": 3,
						"[data-test=dash-period]": document.periods.length,
						"[data-test=preset-option]": 15,
					},
					contains: {
						"[data-test=kpi-label]": cards.map(([label]) => label),
						"[data-test=dash-badge]": badges,
					},
				},
			};
		}),
	),
);

const publicDocument = documentOf("monthly-members", "public");
const memberDocument = documentOf("monthly-members", "member");
const governance = documentOf("monthly-members", "governance");
const owner = documentOf("monthly-members", "owner");
const financeAdmin = documentOf("monthly-members", "finance_admin");
const disputesOwner = documentOf("disputes", "owner");
const annualOwner = documentOf("annual-prepay", "owner");
const tinyPublic = documentOf("tiny-school", "public");
const why = (document: KpiDocument, kpi: string, period: string): string => {
	const found = cellOf(document, kpi, period);
	return typeof found === "object" && "why" in found && found.why
		? `Hidden: ${found.why}`
		: "";
};
const hiddenWith = (
	document: KpiDocument,
	kpi: string,
	period: string,
): string => `${value(kpi)}[title="${why(document, kpi, period)}"]`;
const flagsOf = (document: KpiDocument): number =>
	document.periods.filter((_, index) => {
		const rate = document.series.refund_rate?.[index];
		const disputes = document.series.disputes_opened?.[index];
		return (
			(typeof rate === "number" && rate > 0.1) ||
			(typeof disputes === "number" && disputes >= 3)
		);
	}).length;
const donorLine = (document: KpiDocument, period: string): string => {
	const part = (kpi: string, title: string) =>
		`${text(document, `donors_by_size:${kpi}`, period)} ${title}`;
	return `${text(document, "donors_count", period)} donors: ${part("under-100", "under $100")}, ${part("100-999", "$100 to $999")}, ${part("1000-plus", "$1,000 or more")}; median gift ${text(document, "donors_median_gift", period)}`;
};
const novemberDays = (owner.days?.periods ?? []).filter((day) =>
	day.startsWith("2026-11-"),
);
const novemberWaiting = novemberDays.filter((day) => {
	const index = owner.days?.periods.indexOf(day) ?? -1;
	const found = owner.days?.series.gross_collected?.[index];
	return typeof found === "object" && "hidden" in found;
}).length;

const entries = [
	...matrixEntries,
	{
		id: "books-default-level",
		source:
			"mockup bkDefault and bkSwitch: at B4 Uni the signed-in person is Jo A., an admin with the finance grant, so the Dashboard opens as Finance admin; b4u opens on Jun (dm=5); smoke.mjs 'books: viewer defaults to the signed-in level (finance admin)'",
		route: "#/b4u/dashboard?preset=monthly-members&theme=light",
		expect: {
			text: {
				"[data-test=books-level].on": "Finance admin",
				"[data-test=books-note]":
					"You are Finance admin here. This switch previews what each level sees.",
				"[data-test=dash-period].on": "Jun",
				"[data-test=open-key]": "hatched = open month, live",
				"[data-test=dash-caption]": financeAdmin.caption.money,
			},
			contains: {
				"[data-test=books-level]": levels.map((level) => levelNames[level]),
			},
			count: { "[data-test=pin-lock]": 0 },
		},
	},
	{
		id: "books-note-owner-school",
		source:
			"mockup bkSwitch: at Vibes of Light the signed-in person is Kim R., the owner",
		route: "#/vol/dashboard?preset=monthly-members&theme=light",
		expect: {
			text: {
				"[data-test=books-level].on": "Owner",
				"[data-test=books-note]":
					"You are Owner here. This switch previews what each level sees.",
			},
		},
	},
	{
		id: "level-switch",
		source:
			"mockup [data-bv] buttons; smoke.mjs 'books: five viewers in the switcher', 'books public: year grain only'",
		route: route("monthly-members", "owner", false, "money", "2026-06"),
		steps: [{ click: "[data-test=books-level][data-level=public]" }],
		expect: {
			hash: "level=public",
			text: { "[data-test=books-level].on": "Public" },
			count: {
				"[data-test=dash-period]": 3,
				"[data-test=pin-chip]": 0,
				"[data-test=dash-step]": 0,
			},
		},
	},
	{
		id: "pin-chip",
		source:
			"mockup bkSwitch: the PIN locked chip from Governance up, with its title; smoke.mjs 'books: PIN chip only from Governance up'",
		route: route("monthly-members", "governance", false, "money", "2026-06"),
		steps: [{ click: "[data-test=pin-chip]" }],
		expect: {
			hash: "pin=locked",
			text: { "[data-test=pin-chip]": "PIN locked" },
			count: {
				'[data-test=pin-chip][title="Governance, Finance admin and Owner open books with the family PIN"]': 1,
				"[data-test=pin-lock]": 1,
				"[data-test=kpi-card]": 0,
			},
		},
	},
	{
		id: "pin-unlock",
		source:
			"mockup bkLock: Unlock enables at 4 digits and opens the books; smoke.mjs 'books PIN: entering the PIN unlocks the books'",
		route: route("monthly-members", "governance", true, "money", "2026-06"),
		steps: [
			{ fill: "[data-test=pin-input]", value: "1234" },
			{ click: "[data-test=pin-unlock]" },
		],
		expect: {
			count: {
				"[data-test=pin-lock]": 0,
				"[data-test=pin-chip].on": 0,
				"[data-test=kpi-card]": 5,
			},
		},
	},
	{
		id: "public-year",
		source:
			"mockup dashAgg for Public: years 2024 to 2026, money rounded to $1,000, 2025 and 2026 hatched with 'Shows from'; 2024 is invented (BK_SCALE 0.58); smoke.mjs 'books public' checks. Refunds and net income are hidden by the cell rules (fewer than 5 refunding payers a month), where the mockup's payer-count rule shows them",
		route: route("monthly-members", "public", false, "money", "2024"),
		expect: {
			text: {
				[value("gross_collected")]: text(
					publicDocument,
					"gross_collected",
					"2024",
				),
				[value("stripe_fees")]: text(publicDocument, "stripe_fees", "2024"),
				[value("payouts")]: text(publicDocument, "payouts", "2024"),
				[value("refunds")]: text(publicDocument, "refunds", "2024"),
				[cell("gross_collected", "2024")]: text(
					publicDocument,
					"gross_collected",
					"2024",
				),
				"[data-test=dash-caption]": publicDocument.caption.money,
			},
			count: {
				[`${periodButton("2025")}.kwait[title="Shows from Jan 2027"]`]: 1,
				[`${periodButton("2026")}.kwait[title="Shows from Jan 2028"]`]: 1,
				[hiddenWith(publicDocument, "refunds", "2024")]: 1,
				"[data-test=kpi-card]": 5,
			},
			contains: {
				"[data-test=dash-period]": ["2024", "2025", "2026"],
				"[data-test=pane]": [
					"Gross by year",
					"from Jan 2027",
					"from Jan 2028",
					"Rounded on their own, so a year is not the sum of its rounded quarters.",
					"Breakdowns by plan or fund show from Governance up. Names show to Finance admin and Owner only.",
				],
			},
			absent: ["Gross by plan", "donors"],
		},
		shot: {
			full: true,
			mockupSteps: mockupSteps("public", "monthly-members", "money", "2024"),
		},
	},
	{
		id: "public-not-yet",
		source:
			"mockup dashAgg: a year before its delay shows the waiting box, no figures, not zeros; smoke.mjs 'books public: 2026 shows from Jan 2028 and has no figures'",
		route: route("monthly-members", "public", false, "money", "2025"),
		expect: {
			contains: {
				"[data-test=dash-wait]": [
					"2025 is not shown yet",
					"2025 shows from Jan 2027.",
					"A year's money shows 12 months after the year closes.",
				],
			},
			count: { "[data-test=kpi-card]": 0 },
		},
	},
	{
		id: "public-usage",
		source:
			"mockup dashAgg: Public usage shows once the year has closed, so 2025's members show; smoke.mjs 'books public: usage shows once the year closed'",
		route: route("monthly-members", "public", false, "members", "2025"),
		expect: {
			text: {
				"[data-test=dash-caption]": publicDocument.caption.usage,
				...cardValues(publicDocument, "public", "members", "2025"),
			},
			count: { "[data-test=dash-wait]": 0, "[data-test=kpi-card]": 3 },
		},
	},
	{
		id: "public-usage-not-yet",
		source: "mockup dashAgg waiting box for Public usage",
		route: route("monthly-members", "public", false, "members", "2026"),
		expect: {
			contains: {
				"[data-test=dash-wait]": [
					"2026 is not shown yet",
					"2026 shows from Jan 2027.",
					"Usage shows once the year has closed.",
				],
			},
		},
	},
	{
		id: "public-tiny-school",
		source:
			"smoke.mjs 'books: tiny school hides cells under the 5-contributor rule at Public': tiny-school has 4 families, so its totals read — with the reason",
		route: route("tiny-school", "public", false, "money", "2024"),
		expect: {
			text: { [value("gross_collected")]: labels.suppressed ?? "" },
			count: { [hiddenWith(tinyPublic, "gross_collected", "2024")]: 1 },
		},
	},
	{
		id: "member-quarters",
		source:
			"mockup dashAgg for Member: quarters of 2025 (invented, BK_SCALE 0.82) and 2026, money rounded to $100; smoke.mjs 'books member' checks",
		route: route("monthly-members", "member", false, "money", "2026-Q2"),
		expect: {
			text: {
				"[data-test=dash-caption]": memberDocument.caption.money,
				...cardValues(memberDocument, "member", "money", "2026-Q2"),
			},
			count: {
				"[data-test=dash-period]": 8,
				[`${periodButton("2026-Q3")}.kwait[title="Shows from Jan 2027"]`]: 1,
				[`${periodButton("2026-Q4")}.kwait[title="Shows from Apr 2027"]`]: 1,
			},
			contains: {
				"[data-test=dash-period]": [
					"Q1 2025",
					"Q2 2025",
					"Q3 2025",
					"Q4 2025",
					"Q1 2026",
					"Q2 2026",
					"Q3 2026",
					"Q4 2026",
				],
				"[data-test=pane]": ["Gross by quarter"],
			},
		},
	},
	{
		id: "member-not-yet",
		source:
			"mockup dashAgg waiting box for Member; smoke.mjs 'books member: a quarter shows after it closed plus one quarter'",
		route: route("monthly-members", "member", false, "money", "2026-Q3"),
		expect: {
			contains: {
				"[data-test=dash-wait]": [
					"Q3 2026 is not shown yet",
					"Q3 2026 shows from Jan 2027.",
					"A quarter shows once it has closed and one more quarter has passed.",
				],
			},
			count: { "[data-test=kpi-card]": 0 },
		},
	},
	{
		id: "governance-month",
		source:
			"mockup dashFull for Governance: exact closed months (Jan to Sep; Oct and Nov wait, disabled), plan and fund breakdowns under the cell rules with — and the reason; smoke.mjs 'books gov' checks. Plans use the mart's contributor counts, where the mockup estimates payers from the average",
		route: route("monthly-members", "governance", false, "money", "2026-06"),
		expect: {
			text: {
				"[data-test=dash-caption]": governance.caption.money,
				...cardValues(governance, "governance", "money", "2026-06"),
				[cell("revenue_by_tier:scholar", "2026-06")]: text(
					governance,
					"revenue_by_tier:scholar",
					"2026-06",
				),
				[cell("revenue_by_tier:fellow", "2026-06")]: text(
					governance,
					"revenue_by_tier:fellow",
					"2026-06",
				),
				[cell("donations_by_fund:general", "2026-06")]: text(
					governance,
					"donations_by_fund:general",
					"2026-06",
				),
				[cell("donations_by_fund:building-fund", "2026-06")]: text(
					governance,
					"donations_by_fund:building-fund",
					"2026-06",
				),
			},
			count: {
				[`${periodButton("2026-10")}.kwait[disabled][title="Shows from Nov 7"]`]: 1,
				[`${periodButton("2026-11")}.kwait[disabled][title="Shows from Dec 7"]`]: 1,
				"[data-test=open-key]": 0,
			},
			contains: {
				"[data-test=pane]": [
					"Gross by plan, Jun",
					"Donations by fund, 2026 to Jun",
				],
				"[data-test=kpi-why]": [
					"Fellow: fewer than 5 payers",
					"Building fund: fewer than 5 donors",
					"Scholarships: hidden so the cell beside it can't be worked out from the total",
				],
			},
		},
		shot: {
			full: true,
			mockupSteps: mockupSteps(
				"governance",
				"monthly-members",
				"money",
				"2026-06",
			),
		},
	},
	{
		id: "governance-donors",
		source:
			"mockup bkDist for Governance (spec G4): 62 donors by September, the $1,000 or more bucket under 5 and its neighbour hidden, the median shown; smoke.mjs 'books gov: distribution (G4) with complementary suppression and the median, no rows'",
		route: route("monthly-members", "governance", false, "members", "2026-09"),
		expect: {
			text: {
				"[data-test=donor-line]": donorLine(governance, "2026-09"),
				...cardValues(governance, "governance", "members", "2026-09"),
			},
			contains: {
				"[data-test=pane]": [
					"How donors give, 2026 to Sep",
					"No names, no rows",
				],
				"[data-test=kpi-why]": [
					"$100 to $999: hidden so the cell beside it can't be worked out from the total",
					"$1,000 or more: fewer than 5 donors",
				],
			},
			absent: ["Jane Smith", "Donors and payers"],
		},
	},
	{
		id: "governance-donors-june",
		source: "mockup bkDist for Governance at Jun: 47 donors so far",
		route: route("monthly-members", "governance", false, "members", "2026-06"),
		expect: {
			text: { "[data-test=donor-line]": donorLine(governance, "2026-06") },
		},
	},
	{
		id: "owner-open-month",
		source:
			"mockup dashFull for Owner: live, the open month (Nov) hatched with its title, days so far; smoke.mjs 'books owner: open month is hatched and live, days shown'",
		route: route("monthly-members", "owner", false, "money", "2026-11"),
		expect: {
			text: {
				"[data-test=dash-caption]": owner.caption.money,
				"[data-test=dash-period].on": "Nov",
				"[data-test=open-key]": "hatched = open month, live",
				...cardValues(owner, "owner", "money", "2026-11"),
			},
			count: {
				[`${periodButton("2026-11")}.kopen[title="Open month: live, can still change"]`]: 1,
				"[data-test=dash-period].kopen": 1,
				'[data-kpi="gross_collected"][data-day^="2026-11-"]':
					novemberDays.length,
				'[data-kpi="gross_collected"][data-day^="2026-11-"][data-cell=not_yet]':
					novemberWaiting,
				"[data-test=kpi-why]": 0,
			},
			contains: {
				"[data-test=pane]": [
					"Gross by day, Nov",
					"Days so far (live)",
					"Gross by plan, Nov",
					"Donations by fund, 2026 to Nov",
				],
			},
		},
		shot: {
			full: true,
			mockupSteps: mockupSteps("owner", "monthly-members", "money", "2026-11"),
		},
	},
	{
		id: "finance-admin-donors",
		source:
			"mockup dashFull for Finance admin: the distribution with the rules off, and the link to Reports for names",
		route: route(
			"monthly-members",
			"finance_admin",
			false,
			"members",
			"2026-06",
		),
		expect: {
			text: { "[data-test=donor-line]": donorLine(financeAdmin, "2026-06") },
			count: { "[data-test=kpi-why]": 0 },
			contains: {
				"[data-test=pane]": [
					"Distribution only here; names are in Reports",
					"Names and amounts: Donors and payers in Reports. Every identified read is audited.",
				],
			},
		},
	},
	{
		id: "smoke-b4u-june",
		source:
			"smoke.mjs 'b4u jun gross' $623.00, 'b4u jun net' $592.04, 'b4u members paying 23' (b4u opens as Finance admin on Jun); rows monthly-members 2026-06",
		route: "#/b4u/dashboard?preset=monthly-members&view=money&theme=light",
		steps: [
			{
				click: "[data-test=dash-view][data-view=members]",
				expect: { text: { [value("paying_members")]: "23" } },
			},
		],
		expect: {
			text: { "[data-test=dash-view].on": "Members" },
		},
	},
	{
		id: "smoke-b4u-june-money",
		source: "smoke.mjs 'b4u jun gross' and 'b4u jun net'",
		route: "#/b4u/dashboard?preset=monthly-members&theme=light",
		expect: {
			text: {
				[value("gross_collected")]: "$623.00",
				[value("net_income")]: "$592.04",
			},
		},
	},
	{
		id: "smoke-disputes-flags",
		source: `smoke.mjs 'disputes flags' (at least 5): the owner's disputes document flags ${flagsOf(disputesOwner)} months (refund rate over 10% or 3 disputes or more)`,
		route: route("disputes", "owner", false, "risk", "2026-06"),
		expect: {
			count: { "[data-test=dash-flag]": flagsOf(disputesOwner) },
			contains: {
				"[data-test=dash-flag]": [
					"3 disputes",
					"5 disputes",
					"4 disputes",
					"Show ›",
				],
			},
		},
	},
	{
		id: "smoke-annual-note",
		source:
			"smoke.mjs 'annual note' and 'annual jan gross' $5,735.00; the mockup's note for annual-prepay",
		route: route("annual-prepay", "owner", false, "money", "2026-01"),
		expect: {
			text: {
				"[data-test=dash-note]":
					"Cash basis: a yearly payer counts in the month paid, so every month after January looks empty. MRR and churn are not computed.",
				[value("gross_collected")]: text(
					annualOwner,
					"gross_collected",
					"2026-01",
				),
				"[data-test=preset-option].on": "Annual prepay",
			},
		},
	},
	{
		id: "month-step",
		source: "smoke.mjs 'month step': ‹ moves the month back one",
		route: route("monthly-members", "owner", false, "money", "2026-06"),
		steps: [{ click: '[data-test=dash-step][data-step="-1"]' }],
		expect: {
			hash: "month=2026-05",
			text: { "[data-test=dash-period].on": "May" },
		},
	},
	{
		id: "preset-switch",
		source:
			"mockup [data-dsc] switcher: the mockup's four labels; the mart's 15 presets",
		route: route("monthly-members", "owner", false, "money", "2026-06"),
		steps: [{ click: "[data-test=preset-option][data-preset=disputes]" }],
		expect: {
			hash: "preset=disputes",
			text: { "[data-test=preset-option].on": "Disputes" },
			contains: {
				"[data-test=preset-option]": [
					"Monthly members",
					"Annual prepay",
					"Disputes",
					"Heavy refunds",
				],
			},
		},
	},
	{
		id: "empty-free-only",
		source:
			"mockup dashFull empty state (smoke.mjs 'nw empty'): free-only has no payment in any period shown",
		route: route("free-only", "owner", false, "money", "2026-06"),
		expect: {
			text: {
				"[data-test=dash-empty]":
					"No payments yet. This dashboard fills in after the first payment.",
			},
			count: { "[data-test=kpi-card]": 0 },
		},
	},
	{
		id: "non-usd-euro",
		source:
			"bundle non-usd params.currency eur; the badge 'Cash basis · ' plus the currency symbol (s.cur). atm skips non-USD payments (stats.skipped.non_usd 260), so the preset is empty",
		route: route("non-usd", "owner", false, "money", "2026-06"),
		expect: {
			contains: { "[data-test=dash-badge]": ["Cash basis · €"] },
			count: { "[data-test=dash-empty]": 1 },
			absent: ["Cash basis · $"],
		},
	},
	{
		id: "stale-banner",
		source:
			"mockup: Maple Pilates is 26 min behind; S0's shell banner, hooked (spec v3: stale banner when lagMinutes > 15)",
		route: "#/map/dashboard?theme=light",
		expect: {
			text: {
				"[data-test=stale-banner]":
					"Data is 26 min behind: the shipper may be stuck. Recent events can be missing.",
			},
		},
	},
	{
		id: "no-stale-banner",
		source: "the documents' lagMinutes is 2 and B4 Uni's is 3: no banner",
		route: route("monthly-members", "owner", false, "money", "2026-06"),
		expect: { count: { "[data-test=stale-banner]": 0 } },
	},
	{
		id: "verified-badge",
		source:
			"spec v3 'Manifest and integrity': a verified badge; documents.json verified: true",
		route: route("monthly-members", "owner", false, "money", "2026-06"),
		expect: { text: { "[data-test=verified-badge]": "Verified" } },
	},
];

const golden = {
	slice: "S1",
	notes: [
		"Routes: #/<school>/dashboard?preset=&level=&pin=&view=&month=. level is public, member, governance, finance_admin or owner; absent, it is the signed-in person's level at the school (B4 Uni: Jo A., admin with the finance grant, so finance_admin; Vibes of Light, Maple Pilates, Lotus Lane: the owner). pin=locked applies from governance up and is ignored below. month is a document period (YYYY, YYYY-Qn or YYYY-MM); absent, b4u opens on Jun at the month levels (the mockup's dm=5) and on the last period shown at Public and Member. Every school's Dashboard shows the Before University mart documents.",
		"root.dataset.route is set only after the Dashboard has rendered the document of that route.",
		"Every rendered KPI cell carries data-kpi, data-period and data-cell (cellKind of src/data/kpi-document.ts: number, lt or the hidden kind), and its text is exactly the cell: money with Intl.NumberFormat('en-US', { style: 'currency', currency }) from minor units, money0 the same with no decimals, integers with en-US grouping, percents with Intl percent and one decimal, an amount lt as 'under $1,000', a hidden kind as its cell-rules label (suppressed is '—'). A suppressed cell with a reason carries title 'Hidden: <why>'. Labels, captions and reason lines sit outside the cell element.",
		"Day cells (finance admin and owner, Money view, 'Gross by day') carry data-kpi, data-day (YYYY-MM-DD), data-cell and, for a number, data-value with the raw minor units; their text is not checked (the mockup shows it as a tooltip).",
		"kpi-card is one of the mockup's cards: Public and Member 5 Money, 3 Members, 3 Risk; Governance, Finance admin and Owner 5, 4, 4. Its value element is kpi-value with the card KPI's data-kpi. Dispute cost shows disputes_lost and dispute_fees as two cells (the UI derives nothing, so no sum).",
		"dash-period is the period strip's button for every grain (data-period); a period not shown yet carries class kwait and title 'Shows from <shownFromLabel>' (Governance's are also disabled); the open month carries class kopen and title 'Open month: live, can still change'. dash-step (data-step -1 or 1) only on the month strip. Selected view, period, level and preset buttons carry the mockup's class 'on'; clicking one navigates by hash.",
		"dash-caption is the level's caption for the view's lag class (document.caption.money for Money and Risk, .usage for Members). dash-wait is the 'not shown yet' box (document.periodInfo[].waiting). kpi-why lines read '<term title>: <why>'. donor-line is the distribution sentence.",
		"PIN-locked documents are shown as the PIN prompt only (pin-lock, pin-input, pin-unlock disabled until 4 digits); C4 requires no KPI for them, and none for empty documents (every payments_count cell 0 or not_yet) or for a period not shown yet for the view's lag class.",
	],
	hooks: [
		"books-level",
		"books-note",
		"pin-chip",
		"pin-lock",
		"pin-input",
		"pin-unlock",
		"dash-view",
		"dash-period",
		"dash-step",
		"open-key",
		"preset-option",
		"kpi-card",
		"kpi-label",
		"kpi-value",
		"kpi-why",
		"dash-caption",
		"dash-wait",
		"dash-badge",
		"dash-note",
		"dash-empty",
		"dash-flag",
		"donor-line",
		"stale-banner",
		"verified-badge",
	],
	views: Object.fromEntries(
		levels.map((level) => [
			level,
			aggregate(level) ? aggregateViews : fullViews,
		]),
	),
	matrix: {
		view: ["money", "members", "risk"],
		level: levels,
		pinLocked: ["open", "locked"],
	},
	entries,
};

/** happy-dom 20.0.10 cannot parse a quoted attribute value with an apostrophe: no selector may carry one (use a
 * prefix selector such as [title^="..."] instead). */
const selectorsOf = (value: unknown, key = ""): string[] =>
	typeof value !== "object" || value === null
		? []
		: Object.entries(value).flatMap(([name, inner]) => [
				...(["text", "count", "contains"].includes(key) ? [name] : []),
				...(["click", "fill", "target"].includes(name) &&
				typeof inner === "string"
					? [inner]
					: []),
				...selectorsOf(inner, name),
			]);
const withApostrophe = selectorsOf(entries).filter((selector) =>
	selector.includes("'"),
);
if (withApostrophe.length)
	throw new Error(`selectors with an apostrophe: ${withApostrophe.join(", ")}`);

writeFileSync(
	join(packageRoot, "test/golden/S1.json"),
	`${JSON.stringify(golden, null, "\t")}\n`,
);
process.stdout.write(`S1.json: ${entries.length} entries\n`);
