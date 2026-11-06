/**
 * Writes packages/ledger-ui/test/golden/S1.json: the frozen mockup's Dashboard (atm dev 742105b64, disclosure v2) per
 * audience through the hash's `as=`, read headless with s1-text.mjs, with values from the generated fixture documents
 * written as the mockup writes them. Usage, from packages/ledger-ui (after bun scripts/import-mart.ts):
 * bun ../../plans/ledger-ui/loop/tools/s1-golden.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Audience } from "../../../../packages/ledger-ui/src/data/disclosure.ts";
import type {
	Cell,
	KpiDocument,
	TableGrain,
} from "../../../../packages/ledger-ui/src/data/kpi-document.ts";

const packageRoot = join(import.meta.dir, "../../../../packages/ledger-ui");
const documents = JSON.parse(
	readFileSync(join(packageRoot, "src/fixtures/mart/documents.json"), "utf8"),
) as Record<string, KpiDocument>;

type View = "money" | "members" | "risk";
const viewNames: Record<View, string> = {
	money: "Money",
	members: "Members",
	risk: "Risk",
};
const audienceNames: Record<Audience, string> = {
	public: "Public",
	member: "Member",
	governance: "Governance",
	finance: "Finance admin",
	owner: "Owner",
};
const monthNames = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
const aggregate = (audience: Audience): boolean =>
	audience === "public" || audience === "member";
/** The mockup's cards (dashAgg and dashFull kcard calls) and the KPI each value shows; null: Dispute cost, which the
 * mockup sums (disputes lost plus fees) and the document gives as two cells. */
const cards: Record<
	"aggregate" | "full",
	Record<View, Array<[string, string | null]>>
> = {
	aggregate: {
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
			["Avg per paying member", "arpa"],
			["Credits used", "credits_consumed"],
		],
		risk: [
			["Refund rate", "refund_rate"],
			["Disputes opened", "disputes_opened"],
			["Dispute cost", null],
			["Net income", "net_income"],
		],
	},
	full: {
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
			["Avg per paying member", "arpa"],
			["Credits used", "credits_consumed"],
		],
		risk: [
			["Refund rate", "refund_rate"],
			["Disputes opened", "disputes_opened"],
			["Dispute cost", null],
			["Net income", "net_income"],
		],
	},
};
const cardsOf = (audience: Audience) =>
	cards[aggregate(audience) ? "aggregate" : "full"];
/** What C4 requires per view (test/consistency.test.ts): the cards' cells, the sub-lines' cells and the boxes'. */
const aggregateViews: Record<View, string[]> = {
	money: [
		"gross_collected",
		"refunds",
		"stripe_fees",
		"net_income",
		"payouts",
		"revenue_by_kind:*",
	],
	members: [
		"paying_members",
		"new_paying_members",
		"arpa",
		"credits_consumed",
		"credits_granted",
		"credits_expired",
	],
	risk: [
		"refund_rate",
		"refunds",
		"disputes_opened",
		"disputes_lost",
		"net_income",
	],
};
const fullViews: Record<View, string[]> = {
	money: [
		"gross_collected",
		"refunds",
		"refund_rate",
		"stripe_fees",
		"net_income",
		"payouts",
		"revenue_by_tier:*",
		"donations_by_fund:*",
	],
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
	risk: [
		"refund_rate",
		"refunds",
		"disputes_opened",
		"disputes_lost",
		"dispute_fees",
		"net_income",
	],
};

const documentOf = (key: string): KpiDocument => {
	const found = documents[key];
	if (!found) throw new Error(`no document ${key}`);
	return found;
};
const money = (cents: number, symbol: string, decimals: boolean): string =>
	`${cents < 0 ? "−" : ""}${symbol}${
		decimals
			? (Math.abs(cents) / 100).toLocaleString("en-US", {
					minimumFractionDigits: 2,
					maximumFractionDigits: 2,
				})
			: Math.round(Math.abs(cents) / 100).toLocaleString("en-US")
	}`;
const grainOf = (period: string): TableGrain =>
	/^\d{4}$/.test(period)
		? "year"
		: /-Q\d$/.test(period)
			? "quarter"
			: /^\d{4}-\d{2}$/.test(period)
				? "month"
				: "day";
const cellOf = (document: KpiDocument, kpi: string, period: string): Cell => {
	const table = document.tables[grainOf(period)];
	const cell = table?.series[kpi]?.[table.periods.indexOf(period)];
	if (cell === undefined)
		throw new Error(`${kpi}@${period} not in ${document.school}`);
	return cell;
};
const text = (document: KpiDocument, kpi: string, period: string): string => {
	const cell = cellOf(document, kpi, period);
	const format = document.meta[kpi]?.format ?? "money";
	const isMoney = format === "money" || format === "money0";
	if (typeof cell === "number") {
		if (isMoney) return money(cell, document.symbol, format === "money");
		if (format === "percent1") return `${(cell * 100).toFixed(1)}%`;
		return String(cell);
	}
	if ("lt" in cell)
		return isMoney
			? `under ${money(cell.lt, document.symbol, false)}`
			: `<${cell.lt}`;
	if ("approx" in cell) return String(cell.approx);
	return cell.hidden === "suppressed" ? "—" : cell.text;
};
const kindOf = (document: KpiDocument, kpi: string, period: string): string => {
	const cell = cellOf(document, kpi, period);
	return typeof cell === "number"
		? "number"
		: "lt" in cell
			? "lt"
			: "approx" in cell
				? "approx"
				: cell.hidden;
};
const value = (kpi: string): string =>
	`[data-test=kpi-value][data-kpi="${kpi}"]`;
const cell = (kpi: string, period: string): string =>
	`[data-kpi="${kpi}"][data-period="${period}"]`;
const periodButton = (period: string): string =>
	`[data-test=dash-period][data-period="${period}"]`;
const stripLabel = (document: KpiDocument, period: string): string => {
	const found = document.periods.find((entry) => entry.period === period);
	if (!found) throw new Error(`${period} not in the strip`);
	return document.grain === "month"
		? (monthNames[Number(period.slice(5, 7)) - 1] ?? period)
		: found.label;
};
const monthParameter = (document: KpiDocument, period: string): string => {
	const found = document.periods.find((entry) => entry.period === period);
	if (!found) throw new Error(`${period} not in the strip`);
	return document.grain === "month" ? period : `${found.from}..${found.to}`;
};
const route = (
	school: string,
	preset: string | null,
	audience: Audience | null,
	view: View | null,
	month: string | null,
	extra = "",
): string => {
	const query = [
		preset ? `preset=${preset}` : "",
		audience ? `as=${audience}` : "",
		extra,
		view ? `view=${view}` : "",
		month ? `month=${month}` : "",
		"theme=light",
	].filter(Boolean);
	return `#/${school}/dashboard?${query.join("&")}`;
};
const cardValues = (
	document: KpiDocument,
	view: View,
	period: string,
): Record<string, string> =>
	Object.fromEntries(
		cardsOf(document.audience)[view].flatMap(([, kpi]) =>
			kpi ? [[value(kpi), text(document, kpi, period)]] : [],
		),
	);
const badgesOf = (document: KpiDocument): string[] => [
	`Cash basis · ${document.symbol}`,
	document.dataSource === "fixture"
		? "Fixture data: invented"
		: "From this school's events",
];
const pinLines = (audience: Audience): string[] => [
	"Enter your PIN to see books",
	`${audienceNames[audience]} opens the books with your family PIN. Nothing is shown until you unlock.`,
	"Your family PIN",
	"Unlock",
];
const unitLabel: Record<string, string> = {
	b4u: "Credits used",
	har: "Credits used",
	vol: "Sessions used",
	map: "Classes used",
	nw: "Classes used",
};

/** The matrix: each view at each audience, on B4 Uni (as=) for the four it holds and on Vibes of Light for Owner. */
const sample: Record<
	Audience,
	{ school: string; preset: string | null; period: string }
> = {
	public: { school: "b4u", preset: "monthly-members", period: "2024" },
	member: { school: "b4u", preset: "monthly-members", period: "2026-Q2" },
	governance: { school: "b4u", preset: "monthly-members", period: "2026-06" },
	finance: { school: "b4u", preset: "monthly-members", period: "2026-06" },
	owner: { school: "vol", preset: null, period: "2026-11" },
};
const keyOf = (
	school: string,
	preset: string | null,
	audience: Audience,
	pinLocked = false,
): string =>
	`${preset === null ? school : school === "b4u" ? preset : `${school}/${preset}`}.${audience}${pinLocked ? ".pin-locked" : ""}`;
const audiencesInOrder: Audience[] = [
	"public",
	"member",
	"governance",
	"finance",
	"owner",
];
const matrixEntries = audiencesInOrder.flatMap((audience) =>
	(["money", "members", "risk"] as View[]).map((view) => {
		const { school, preset, period } = sample[audience];
		const document = documentOf(keyOf(school, preset, audience));
		const labels = cardsOf(audience)[view].map(([label]) =>
			label === "Credits used" ? (unitLabel[school] ?? label) : label,
		);
		return {
			id: `matrix-${view}-${audience}`,
			source: `mockup 742105b64 dashboard() on ${school === "b4u" ? "B4 Uni, Monthly members" : "Vibes of Light"}, View as ${audienceNames[audience]}, ${view}: the cards, the caption, the strip and the badges; values from documents.json ${keyOf(school, preset, audience)} at ${period}, written as the mockup writes them`,
			route: route(
				school,
				preset,
				audience,
				view,
				monthParameter(document, period),
			),
			covers: { view, as: audience },
			expect: {
				text: {
					"[data-test=view-as]": `View as ${audienceNames[audience]}`,
					"[data-test=dash-view].on": viewNames[view],
					"[data-test=dash-period].on": stripLabel(document, period),
					"[data-test=dash-caption]":
						document.captions[period.slice(0, 4)] ?? "",
					...cardValues(document, view, period),
				},
				count: {
					"[data-test=kpi-card]": labels.length,
					"[data-test=dash-view]": 3,
					"[data-test=dash-period]": document.periods.length,
					"[data-test=dash-step]": document.grain === "month" ? 2 : 0,
					"[data-test=pin-chip]": aggregate(audience) ? 0 : 1,
					"[data-test=pin-lock]": 0,
					"[data-test=preset-option]": preset ? 15 : 0,
				},
				contains: {
					"[data-test=kpi-label]": labels,
					"[data-test=dash-badge]": badgesOf(document),
				},
			},
		};
	}),
);

const b4u = (
	audience: Audience,
	preset = "monthly-members",
	pinLocked = false,
) => documentOf(keyOf("b4u", preset, audience, pinLocked));
const publicB4u = b4u("public");
const memberB4u = b4u("member");
const governanceB4u = b4u("governance");
const financeB4u = b4u("finance");
const ownerVol = documentOf("vol.owner");
const memberHar = documentOf("har/monthly-members.member");
const flagsOf = (document: KpiDocument): number => {
	const table = document.tables.month;
	if (!table) return 0;
	return table.periods.filter((_, index) => {
		const rate = table.series.refund_rate?.[index];
		const disputes = table.series.disputes_opened?.[index];
		return (
			(typeof rate === "number" && rate > 0.1) ||
			(typeof disputes === "number" && disputes >= 3)
		);
	}).length;
};
const donorLine = (document: KpiDocument, period: string): string => {
	const part = (bucket: string, title: string): string =>
		`${text(document, `donors_by_size:${bucket}`, period)} ${title}`;
	return `${text(document, "donors_count", period)} donors: ${part("under-100", "under $100")}, ${part("100-999", "$100 to $999")}, ${part("1000-plus", "$1,000 or more")}; median gift ${text(document, "donors_median_gift", period)}`;
};
const novemberDays = (financeB4u.tables.day?.periods ?? []).filter((day) =>
	day.startsWith("2026-11-"),
);
const novemberLater = novemberDays.filter((day) => {
	const index = financeB4u.tables.day?.periods.indexOf(day) ?? -1;
	const found = financeB4u.tables.day?.series.gross_collected?.[index];
	return typeof found === "object" && "hidden" in found;
}).length;
const disputesFinance = b4u("finance", "disputes");
const mockupSteps = (steps: string[]): string =>
	[
		"document.querySelector('#sw').click()",
		"document.querySelector('[data-sc=b4u]').click()",
		"document.querySelector('.tab[data-p=dash]').click()",
		...steps,
	].join(";");
const viewAsStep = (sub: string): string =>
	`document.querySelector('#kview').click();document.querySelector('#kvp [data-bv=${sub}]').click()`;

const entries = [
	...matrixEntries,
	{
		id: "b4u-default",
		source:
			"mockup setSchool: B4 Uni (s.kpi) opens on Money and Jun (dm=5) as its signed-in person, Jo A., Finance admin; smoke.mjs 'b4u jun gross' $623.00 and 'b4u jun net' $592.04",
		route: "#/b4u/dashboard?theme=light",
		expect: {
			text: {
				"[data-test=view-as]": "View as Finance admin",
				"[data-test=dash-view].on": "Money",
				"[data-test=dash-period].on": "Jun",
				[value("gross_collected")]: "$623.00",
				[value("net_income")]: "$592.04",
				"[data-test=dash-caption]": financeB4u.captions["2026"] ?? "",
				"[data-test=open-key]": "hatched = open month, live",
			},
			count: { "[data-test=dash-period]": 12, "[data-test=pin-chip]": 1 },
		},
	},
	{
		id: "b4u-members-paying",
		source: "smoke.mjs 'b4u members paying 23'",
		route: "#/b4u/dashboard?theme=light",
		steps: [{ click: "[data-test=dash-view][data-view=members]" }],
		expect: {
			hash: "view=members",
			text: { [value("paying_members")]: "23" },
		},
	},
	{
		id: "school-switch-drops-the-dashboard-query",
		source:
			"mockup setSchool: switching school resets View as, the view and the period, and a school not opened yet opens on Plans; then its Dashboard tab (smoke.mjs sc('b4u');tab('dash')) shows B4 Uni's own Money view and Jun (S7 notes: switching school drops as=)",
		route: route("vol", null, "public", "risk", "2024-01-01..2024-12-31"),
		steps: [
			{ click: "[data-test=school-switcher]" },
			{
				click: "[data-test=school-option][data-school=b4u]",
				expect: { hash: "#/b4u/plans" },
			},
			{ click: "[data-test=tab][data-tab=dashboard]" },
		],
		expect: {
			hash: "#/b4u/dashboard",
			text: {
				"[data-test=view-as]": "View as Finance admin",
				"[data-test=dash-view].on": "Money",
				"[data-test=dash-period].on": "Jun",
				[value("gross_collected")]: "$623.00",
			},
		},
	},
	{
		id: "vol-from-its-events",
		source:
			"mockup kpiSeries for a school without fixture data: Vibes of Light reads its own events, has no preset switcher and opens on the open month (Nov)",
		route: "#/vol/dashboard?theme=light",
		expect: {
			text: {
				"[data-test=view-as]": "View as Owner",
				"[data-test=dash-period].on": "Nov",
				...cardValues(ownerVol, "money", "2026-11"),
				[cell("revenue_by_tier:sparkle", "2026-11")]: text(
					ownerVol,
					"revenue_by_tier:sparkle",
					"2026-11",
				),
			},
			contains: { "[data-test=dash-badge]": badgesOf(ownerVol) },
			count: {
				"[data-test=preset-option]": 0,
				[`${periodButton("2026-11")}.kopen[title="Open month: live, can still change"]`]: 1,
				[`${periodButton("2026-12")}[title="Not started yet"]`]: 1,
			},
		},
	},
	{
		id: "nw-no-payments-yet",
		source:
			"mockup dashFull empty state: Lotus Lane Yoga has no payments (smoke.mjs 'nw empty')",
		route: "#/nw/dashboard?theme=light",
		expect: {
			text: {
				"[data-test=dash-empty]":
					"No payments yet. This dashboard fills in after the first payment.",
			},
			count: { "[data-test=kpi-card]": 0 },
			contains: { "[data-test=dash-badge]": ["From this school's events"] },
		},
	},
	{
		id: "har-large-school-member",
		source:
			"mockup: Harbor Arts Academy (fixture data times 40, a large school) as its signed-in admin without the finance grant, Rosa T., whose audience is Member: quarters, money rounded to $100",
		route: "#/har/dashboard?theme=light",
		expect: {
			text: {
				"[data-test=view-as]": "View as Admin",
				"[data-test=dash-period].on": "Q2 2026",
				"[data-test=dash-caption]": memberHar.captions["2026"] ?? "",
				[value("gross_collected")]: text(
					memberHar,
					"gross_collected",
					"2026-Q2",
				),
				[value("stripe_fees")]: text(memberHar, "stripe_fees", "2026-Q2"),
			},
			count: { "[data-test=pin-chip]": 0 },
		},
	},
	{
		id: "har-large-school-public",
		source: "mockup: a large school's public money is rounded to $1,000",
		route: route(
			"har",
			"monthly-members",
			"public",
			"money",
			"2024-01-01..2024-12-31",
		),
		expect: {
			text: {
				[value("gross_collected")]: text(
					documentOf("har/monthly-members.public"),
					"gross_collected",
					"2024",
				),
				"[data-test=dash-caption]":
					documentOf("har/monthly-members.public").captions["2024"] ?? "",
			},
		},
	},
	{
		id: "public-year",
		source:
			"mockup dashAgg for Public: years 2024 to 2026 (2024 invented from 2026, BK_SCALE 0.58), money rounded to $100 at a small school, Losses for members, Cash for governance, later years published after their delay; the plan row is S7's dashboard-plan lock panel",
		route: route(
			"b4u",
			"monthly-members",
			"public",
			"money",
			"2024-01-01..2024-12-31",
		),
		expect: {
			text: {
				[value("gross_collected")]: text(publicB4u, "gross_collected", "2024"),
				[value("refunds")]: text(publicB4u, "refunds", "2024"),
				[value("payouts")]: text(publicB4u, "payouts", "2024"),
				[cell("gross_collected", "2025")]: text(
					publicB4u,
					"gross_collected",
					"2025",
				),
				[cell("revenue_by_kind:membership", "2024")]: text(
					publicB4u,
					"revenue_by_kind:membership",
					"2024",
				),
			},
			count: {
				[`${periodButton("2025")}[disabled][title="Published after 7 Jan 2027"]`]: 1,
				[`${periodButton("2026")}[disabled][title="Published after 7 Jan 2028"]`]: 1,
				[`${value("refunds")}[data-cell=${kindOf(publicB4u, "refunds", "2024")}][title="Members see this"]`]: 1,
				[`${value("payouts")}[data-cell=no_grant]`]: 1,
				"[data-test=lock-panel][data-surface=dashboard-plan]": 1,
			},
			contains: {
				"[data-test=dash-period]": ["2024", "2025", "2026"],
				"[data-test=pane]": [
					"Gross by year",
					"Income by kind, 2024",
					"Each period is rounded on its own, so a year is not the sum of its rounded quarters.",
				],
			},
			absent: ["Gross by plan"],
		},
		shot: {
			full: true,
			mockupSteps: mockupSteps([viewAsStep("public")]),
		},
	},
	{
		id: "public-members-by-quarter",
		source:
			"mockup dashAgg Members for Public: People total by quarter (no delay), Activity categories by month",
		route: route(
			"b4u",
			"monthly-members",
			"public",
			"members",
			"2024-01-01..2024-12-31",
		),
		expect: {
			text: {
				...cardValues(publicB4u, "members", "2024"),
				[cell("paying_members", "2024-Q1")]: text(
					publicB4u,
					"paying_members",
					"2024-Q1",
				),
				[cell("credits_consumed", "2024-01")]: text(
					publicB4u,
					"credits_consumed",
					"2024-01",
				),
			},
			contains: {
				"[data-test=pane]": [
					"Paying members by quarter",
					"Credits used by month",
				],
			},
		},
	},
	{
		id: "member-quarter",
		source:
			"mockup dashAgg for Member: quarters of 2025 (invented, BK_SCALE 0.82) and 2026, 6 weeks after each closes, money rounded to $100, the year's own total; refunds fail the cell rules on the mart's holders (the mockup counts the period's payers and shows 'under $100')",
		route: route(
			"b4u",
			"monthly-members",
			"member",
			"money",
			"2026-04-01..2026-06-30",
		),
		expect: {
			text: {
				...cardValues(memberB4u, "money", "2026-Q2"),
				[cell("gross_collected", "2026")]: text(
					memberB4u,
					"gross_collected",
					"2026",
				),
			},
			count: {
				"[data-test=dash-period]": 8,
				[`${periodButton("2026-Q3")}[disabled][title="Published after 18 Nov 2026"]`]: 1,
				[`${periodButton("2026-Q4")}[disabled][title="Published after 18 Feb 2027"]`]: 1,
				[`${value("refunds")}[title="${text(memberB4u, "refunds", "2026-Q2") === "—" ? `Hidden: fewer than 5 payers` : ""}"]`]: 1,
			},
			contains: {
				"[data-test=dash-period]": ["Q1 2025", "Q4 2025", "Q2 2026", "Q4 2026"],
				"[data-test=pane]": ["Gross by quarter", "2026 total"],
			},
		},
	},
	{
		id: "governance-month",
		source:
			"mockup dashFull for Governance: exact closed months (Oct to Dec wait, disabled), plan and fund breakdowns under the cell rules; plans read the mart's holders (the mockup estimates payers from the average)",
		route: route("b4u", "monthly-members", "governance", "money", "2026-06"),
		expect: {
			text: {
				...cardValues(governanceB4u, "money", "2026-06"),
				[cell("revenue_by_tier:scholar", "2026-06")]: text(
					governanceB4u,
					"revenue_by_tier:scholar",
					"2026-06",
				),
				[cell("donations_by_fund:general", "2026-06")]: text(
					governanceB4u,
					"donations_by_fund:general",
					"2026-06",
				),
				[cell("donations_by_fund:building-fund", "2026-06")]: "—",
			},
			count: {
				[`${periodButton("2026-10")}[disabled][title="Published after 7 Nov 2026"]`]: 1,
				[`${periodButton("2026-11")}[disabled][title="Published after 7 Dec 2026"]`]: 1,
				[`${periodButton("2026-12")}[disabled][title="Published after 7 Jan 2027"]`]: 1,
				"[data-test=open-key]": 0,
				"[data-test=dash-period]": 12,
			},
			contains: {
				"[data-test=pane]": [
					"Gross by plan, Jun",
					"Donations by fund, 2026 to Jun",
				],
				"[data-test=kpi-why]": [
					"Building fund: fewer than 5 donors",
					"Scholarships: hidden so the cell beside it can't be worked out from the total",
				],
			},
		},
		shot: {
			full: true,
			mockupSteps: mockupSteps([viewAsStep("governance")]),
		},
	},
	{
		id: "governance-donors",
		source:
			"mockup bkDist for Governance (spread): by September 62 donors, the $1,000 or more bucket under 5 shown as <10 and its neighbour rounded to the nearest 10, the median shown",
		route: route("b4u", "monthly-members", "governance", "members", "2026-09"),
		expect: {
			text: { "[data-test=donor-line]": donorLine(governanceB4u, "2026-09") },
			contains: {
				"[data-test=kpi-why]": [
					"$100 to $999: rounded so the cell beside it can't be worked out from the total",
					"$1,000 or more: fewer than 5 donors",
				],
				"[data-test=pane]": [
					"How donors give, 2026 to Sep",
					"No names, no rows",
				],
			},
			count: {
				'[data-kpi="donors_by_size:1000-plus"][data-period="2026-09"][data-cell=lt]': 1,
			},
		},
	},
	{
		id: "finance-open-month",
		source:
			"mockup dashFull for Finance admin: live, the open month (Nov) hatched with its title and the days so far; Dec not started yet",
		route: route("b4u", "monthly-members", null, "money", "2026-11"),
		expect: {
			text: {
				"[data-test=dash-period].on": "Nov",
				"[data-test=open-key]": "hatched = open month, live",
				...cardValues(financeB4u, "money", "2026-11"),
			},
			count: {
				[`${periodButton("2026-11")}.kopen[title="Open month: live, can still change"]`]: 1,
				'[data-kpi="gross_collected"][data-day^="2026-11-"]':
					novemberDays.length,
				'[data-kpi="gross_collected"][data-day^="2026-11-"][data-cell=future]':
					novemberLater,
				"[data-test=kpi-why]": 0,
			},
			contains: {
				"[data-test=pane]": [
					"Gross by day, Nov",
					"Days so far (live)",
					"Donations by fund, 2026 to Nov",
				],
			},
		},
	},
	{
		id: "finance-donors",
		source:
			"mockup bkDist with the rules off for Finance admin, and the link to Reports",
		route: route("b4u", "monthly-members", null, "members", "2026-06"),
		expect: {
			text: { "[data-test=donor-line]": donorLine(financeB4u, "2026-06") },
			contains: {
				"[data-test=pane]": [
					"Spread only here; names are in Reports",
					"Names and amounts: Donors and payers in Reports. Every identified read is audited.",
				],
			},
		},
	},
	{
		id: "owner-caption",
		source:
			"mockup bkCaption for Owner (Vibes of Light): anonymous donors' names show to the owner only",
		route: "#/vol/dashboard?theme=light",
		expect: {
			text: { "[data-test=dash-caption]": ownerVol.captions["2026"] ?? "" },
		},
		shot: {
			full: true,
			mockupSteps: "document.querySelector('.tab[data-p=dash]').click()",
		},
	},
	{
		id: "pin-locked",
		source:
			"mockup bkLock: Governance and up open the books with the family PIN; nothing shows until then (smoke.mjs 'books ... PIN locked: lock state, not zeros')",
		route: route(
			"b4u",
			"monthly-members",
			"governance",
			"money",
			"2026-06",
			"pin=locked",
		),
		expect: {
			contains: { "[data-test=pin-lock]": pinLines("governance") },
			count: {
				"[data-test=pin-chip].on": 1,
				"[data-test=pin-unlock][disabled]": 1,
				"[data-test=kpi-card]": 0,
			},
		},
	},
	{
		id: "pin-chip",
		source:
			"mockup bkKt: the PIN locked chip with its title; clicking it locks the books",
		route: route("b4u", "monthly-members", "governance", "money", "2026-06"),
		steps: [{ click: "[data-test=pin-chip]" }],
		expect: {
			hash: "pin=locked",
			text: { "[data-test=pin-chip]": "PIN locked" },
			count: {
				'[data-test=pin-chip][title^="Governance, Finance admin and Owner open books"]': 1,
				"[data-test=pin-lock]": 1,
			},
		},
	},
	{
		id: "pin-unlock",
		source:
			"mockup: Unlock enables at 4 digits (smoke.mjs 'books PIN: entering the PIN unlocks the books')",
		route: route(
			"b4u",
			"monthly-members",
			"finance",
			"money",
			"2026-06",
			"pin=locked",
		),
		steps: [
			{ fill: "[data-test=pin-input]", value: "1234" },
			{ click: "[data-test=pin-unlock]" },
		],
		expect: { count: { "[data-test=pin-lock]": 0, "[data-test=kpi-card]": 5 } },
	},
	{
		id: "disputes-flags",
		source: `smoke.mjs 'disputes flags' (at least 5): Finance admin's Disputes document flags ${flagsOf(disputesFinance)} months`,
		route: route("b4u", "disputes", null, "risk", "2026-06"),
		expect: {
			count: { "[data-test=dash-flag]": flagsOf(disputesFinance) },
			contains: {
				"[data-test=dash-flag]": ["3 disputes", "5 disputes", "Show ›"],
			},
		},
	},
	{
		id: "annual-note",
		source: "smoke.mjs 'annual note' and 'annual jan gross' $5,735.00",
		route: route("b4u", "annual-prepay", null, "money", "2026-01"),
		expect: {
			text: {
				"[data-test=dash-note]":
					"Cash basis: a yearly payer counts in the month paid, so every month after January looks empty. MRR and churn are not computed.",
				[value("gross_collected")]: "$5,735.00",
			},
		},
	},
	{
		id: "month-step",
		source: "smoke.mjs 'month step': ‹ moves the month back one",
		route: route("b4u", "monthly-members", null, "money", "2026-06"),
		steps: [{ click: '[data-test=dash-step][data-step="-1"]' }],
		expect: {
			hash: "month=2026-05",
			text: { "[data-test=dash-period].on": "May" },
		},
	},
	{
		id: "preset-switch",
		source:
			"mockup [data-dsc]: the mockup's four labels first; the mart's 15 presets",
		route: route("b4u", "monthly-members", null, "money", "2026-06"),
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
		source: "mockup dashFull empty state on a preset with no payments",
		route: route("b4u", "free-only", null, "money", "2026-06"),
		expect: {
			text: {
				"[data-test=dash-empty]":
					"No payments yet. This dashboard fills in after the first payment.",
			},
			count: { "[data-test=kpi-card]": 0 },
		},
	},
	{
		id: "non-usd",
		source:
			"bundle non-usd params.currency eur, written with €; atm skips non-USD payments (stats.skipped.non_usd 260), so it is empty",
		route: route("b4u", "non-usd", null, "money", "2026-06"),
		expect: {
			contains: { "[data-test=dash-badge]": ["Cash basis · €"] },
			count: { "[data-test=dash-empty]": 1 },
		},
	},
	{
		id: "stale-banner",
		source: "mockup: Maple Pilates is 26 min behind (the shell's banner)",
		route: "#/map/dashboard?theme=light",
		expect: {
			text: {
				"[data-test=stale-banner]":
					"Data is 26 min behind: the shipper may be stuck. Recent events can be missing.",
			},
		},
	},
];

/** happy-dom 20.0.10 cannot parse a quoted attribute value with an apostrophe: no selector may carry one. */
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

const golden = {
	slice: "S1",
	notes: [
		"Mockup: frozen at atm dev 742105b64 (disclosure v2, #125). Data: src/data/kpi-document.ts with the generated src/fixtures/mart/documents.json (scripts/import-mart.ts; gates/oracle.ts on the disclosure object of src/data/disclosure.ts and src/fixtures/disclosure.json). The Reader gives kpiDocument({ school, preset, audience, pinLocked }) and dashboardOptions() (the presets). B4 Uni and Harbor Arts Academy show the mart's presets (fixture data); Vibes of Light, Maple Pilates and Lotus Lane Yoga their own events (gates/mockup-schools.json, the mockup's kpiSeries), with no preset switcher.",
		"Route (S2 and S7's grammar): #/<school>/dashboard?preset=&as=&pin=&view=&month=. as= picks the View as row (resolveViewAs over the school's disclosure; the audience is option.audience, so Admin reads its member document); absent, the signed-in person's own. pin=locked from Governance up shows the PIN prompt (ignored below). month= is S0's period: YYYY-MM for a month, YYYY-MM-DD..YYYY-MM-DD for a quarter or a year (the document period's from..to); a period the audience may not pick snaps as S7's notes say. Without preset=, view= and month=, a fixture school opens on Monthly members, Money and the month the mockup opens it on (B4 Uni: Jun; Harbor Arts Academy as Member: Q2 2026), an events school on Money and the open month. Switching school drops as=, view=, month= and preset=.",
		"root.dataset.route is set only after the Dashboard has rendered the document of that route (or its PIN prompt).",
		"Every rendered KPI cell carries data-kpi, data-period (the document table's period: YYYY, YYYY-Qn or YYYY-MM) and data-cell (cellKind: number, lt, approx or the hidden kind), and its text is exactly the cell as the mockup writes it (kpi-document.ts KpiFormat, with the document's symbol): a hidden cell its text, '—' when suppressed; a cell with a reason carries title (a hidden cell its text; an lt or approx 'Rounded to the nearest 10: <why>'). Day cells (Finance admin and Owner, 'Gross by day') carry data-day (YYYY-MM-DD), data-cell and, for a number, data-value; their text is not checked. Labels, captions, legends and reason lines sit outside the cell element.",
		"Series rows and charts read the table of the KPI's own grain (meta.every): 'Gross by year' the year table, 'Paying members by quarter' the quarter table, 'Credits used by month' the month table, each over the selected period's year; Member also shows the year's own total (the year table). Plans (revenue_by_tier), funds (donations_by_fund, in table.order) and donors (donors_count, donors_by_size, donors_median_gift) are in the documents from Governance up; below it the plan row is S7's dashboard-plan lock panel.",
		"kpi-card is one of the mockup's cards (5 Money, 4 Members, 4 Risk) with kpi-label and kpi-value (the card KPI's cell); Dispute cost shows disputes_lost and dispute_fees as cells (the UI derives no sum). dash-period is a strip button (data-period, disabled with its title when not shown, class on when chosen; at the month grain its text is the month's short name and the live audiences' open month carries class kopen with title 'Open month: live, can still change'); dash-step the ‹ › buttons of the month strip; open-key 'hatched = open month, live'. dash-caption the caption (document.captions[year]), dash-badge the badges ('Cash basis · <symbol>', 'Fixture data: invented' or 'From this school's events'), dash-note the annual-prepay note, dash-empty 'No payments yet…' (document.empty), dash-flag a 'Needs a look' row, donor-line the spread sentence, kpi-why a reason line '<title>: <why>'. pin-chip the PIN locked chip, pin-lock the prompt with pin-input and pin-unlock (enabled at 4 digits).",
		"Not checked here: the card sub-lines that compare months ('▲ $29 vs May'), the chart bars, the Reports, Ledger and Members surfaces of the disclosure (S5, S4), the View as dropdown itself (S7).",
	],
	hooks: [
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
		"dash-badge",
		"dash-note",
		"dash-empty",
		"dash-flag",
		"donor-line",
		"pin-chip",
		"pin-lock",
		"pin-input",
		"pin-unlock",
		"stale-banner",
		"view-as",
		"lock-panel",
		"lock-who",
		"lock-when",
	],
	views: Object.fromEntries(
		audiencesInOrder.map((audience) => [
			audience,
			aggregate(audience) ? aggregateViews : fullViews,
		]),
	),
	matrix: {
		view: ["money", "members", "risk"],
		as: audiencesInOrder,
	},
	entries,
};

writeFileSync(
	join(packageRoot, "test/golden/S1.json"),
	`${JSON.stringify(golden, null, "\t")}\n`,
);
process.stdout.write(`S1.json: ${entries.length} entries\n`);
