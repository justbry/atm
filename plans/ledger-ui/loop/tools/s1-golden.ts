/**
 * Writes packages/ledger-ui/test/golden/S1.json: the mockup's Dashboard copy (read headless with s1-text.mjs from the
 * mockup at e2d561e74, PR #113) and values taken from the committed fixture documents, formatted per cell-rules.
 * Usage, from packages/ledger-ui: bun ../../plans/ledger-ui/loop/tools/s1-golden.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	Cell,
	Grain,
	KpiDocument,
	Viewer,
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
const viewers: Viewer[] = ["owner", "finance", "admin", "locked", "demo"];
const grains: Grain[] = ["month", "quarter"];
const viewNames: Record<View, string> = {
	money: "Money",
	members: "Members",
	risk: "Risk",
};
/** The mockup's cards per view (mockup.html dashboard(): kc(...) calls) and the KPI each card's value shows. */
const cards: Record<View, Array<[string, string | null]>> = {
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
};
const views: Record<View, string[]> = {
	money: [
		"gross_collected",
		"refunds",
		"refund_rate",
		"stripe_fees",
		"net_income",
		"payouts",
		"revenue_by_tier:*",
		"mrr",
		"arr",
	],
	members: [
		"paying_members",
		"new_paying_members",
		"arpa",
		"credits_consumed",
		"credits_granted",
		"credits_expired",
		"churned_members",
		"credits_outstanding",
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
const badges = [
	"Cash basis · $",
	"Fixture data: invented",
	"Owners and admins only",
];
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
const periodLabel = (period: string): string =>
	period.includes("Q")
		? period.slice(5)
		: (monthNames[Number(period.slice(5, 7)) - 1] ?? period);

const documentOf = (preset: string, viewer: Viewer, grain: Grain) => {
	const document = documents[`${preset}.${viewer}.${grain}`];
	if (!document) throw new Error(`no document ${preset}.${viewer}.${grain}`);
	return document;
};
const text = (document: KpiDocument, kpi: string, period: string): string => {
	const cell = document.series[kpi]?.[document.periods.indexOf(period)] as
		| Cell
		| undefined;
	const format = document.meta[kpi]?.format;
	if (cell === undefined || !format)
		throw new Error(`${kpi}@${period} not in the document`);
	if (typeof cell !== "number")
		return "lt" in cell ? `<${cell.lt}` : (labels[cell.hidden] ?? "");
	if (format === "money")
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: document.currency.toUpperCase(),
		}).format(cell / 100);
	if (format === "integer") return new Intl.NumberFormat("en-US").format(cell);
	return new Intl.NumberFormat("en-US", {
		style: "percent",
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	}).format(cell);
};
const route = (
	preset: string,
	viewer: Viewer,
	grain: Grain,
	view: View,
	period: string,
): string =>
	`#/b4u/dashboard?preset=${preset}&viewer=${viewer}&grain=${grain}&view=${view}&month=${period}&theme=light`;
const valueSelector = (kpi: string): string =>
	`[data-test=kpi-value][data-kpi="${kpi}"]`;
const cellSelector = (kpi: string, period: string): string =>
	`[data-kpi="${kpi}"][data-period="${period}"]`;
const mockupSteps = (preset: string, view: View, monthIndex: number): string =>
	[
		"document.querySelector('#sw').click()",
		"document.querySelector('[data-sc=b4u]').click()",
		"document.querySelector('.tab[data-p=dash]').click()",
		`document.querySelector('#dash [data-dsc=${preset}]').click()`,
		`document.querySelector('#dash [data-dv=${view}]').click()`,
		`document.querySelector('#dash .kmonths [data-dm="${monthIndex}"]').click()`,
	].join(";");

/** The copy of one Dashboard state, and its card values when `withValues` (owner only: the owner's numbers hold under
 * any viewer model; the other viewers' cells are C4's to check against their documents). */
const dashboardExpect = (
	document: KpiDocument,
	view: View,
	period: string,
	withValues: boolean,
) => ({
	text: {
		"[data-test=dash-view].on": viewNames[view],
		"[data-test=dash-month].on": periodLabel(period),
		"[data-test=preset-option].on": "Monthly members",
		...Object.fromEntries(
			withValues
				? cards[view].flatMap(([, kpi]) =>
						kpi ? [[valueSelector(kpi), text(document, kpi, period)]] : [],
					)
				: [],
		),
	},
	count: {
		"[data-test=kpi-card]": cards[view].length,
		"[data-test=dash-view]": 3,
		"[data-test=dash-month]": document.periods.length,
		"[data-test=preset-option]": 15,
	},
	contains: {
		"[data-test=kpi-label]": cards[view].map(([label]) => label),
		"[data-test=dash-badge]": badges,
	},
});

const matrixEntries = viewers.flatMap((viewer) =>
	grains.flatMap((grain) =>
		(["money", "members", "risk"] as View[]).map((view) => {
			const period = grain === "month" ? "2026-06" : "2026-Q2";
			const document = documentOf("monthly-members", viewer, grain);
			return {
				id: `matrix-${view}-${viewer}-${grain}`,
				source: `mockup e2d561e74 dashboard() on b4u, Monthly members, ${view}: card labels, the three .kt badges, the view and month buttons${viewer === "owner" ? `; values from documents.json monthly-members.owner.${grain} at ${period}, formatted per cell-rules` : "; this viewer's values are checked by C4"}`,
				route: route("monthly-members", viewer, grain, view, period),
				covers: { view, viewer, grain },
				expect: dashboardExpect(document, view, period, viewer === "owner"),
			};
		}),
	),
);

const owner = documentOf("monthly-members", "owner", "month");
const ownerQuarter = documentOf("monthly-members", "owner", "quarter");
const demo = documentOf("monthly-members", "demo", "month");
const disputesOwner = documentOf("disputes", "owner", "month");
const annualOwner = documentOf("annual-prepay", "owner", "month");
const roleNote = (role: string, school: string): string =>
	`You are ${role} in ${school}. Owners and admins own the dashboard and see everyone's data. Members see only themselves and their family.`;
const flagsOf = (document: KpiDocument): number =>
	document.periods.filter((_, index) => {
		const rate = document.series.refund_rate?.[index];
		const disputes = document.series.disputes_opened?.[index];
		return (
			(typeof rate === "number" && rate > 0.1) ||
			(typeof disputes === "number" && disputes >= 3)
		);
	}).length;

const entries = [
	...matrixEntries,
	{
		id: "smoke-b4u-june-money",
		source:
			"smoke.mjs 'b4u jun gross' $623.00 and 'b4u jun net' $592.04 (mockup b4u opens on Jun, dm=5); rows monthly-members gross_collected 2026-06 = 62300, net_income = 59204",
		route: route("monthly-members", "owner", "month", "money", "2026-06"),
		expect: {
			text: {
				[valueSelector("gross_collected")]: "$623.00",
				[valueSelector("net_income")]: "$592.04",
				[valueSelector("stripe_fees")]: text(owner, "stripe_fees", "2026-06"),
				[valueSelector("payouts")]: text(owner, "payouts", "2026-06"),
			},
		},
		shot: {
			full: true,
			mockupSteps: mockupSteps("monthly-members", "money", 5),
		},
	},
	{
		id: "smoke-b4u-june-paying",
		source:
			"smoke.mjs 'b4u members paying 23'; rows monthly-members paying_members 2026-06 = 23",
		route: route("monthly-members", "owner", "month", "members", "2026-06"),
		expect: { text: { [valueSelector("paying_members")]: "23" } },
	},
	{
		id: "smoke-disputes-flags",
		source: `smoke.mjs 'disputes flags' (at least 5); mockup 'Needs a look' flags a month when refund rate > 10% or disputes >= 3 ('3 disputes', 'Show ›'); the owner's disputes document flags ${flagsOf(disputesOwner)} months (Mar, Apr, May, Jun, Sep, as the mockup)`,
		route: route("disputes", "owner", "month", "risk", "2026-06"),
		expect: {
			count: { "[data-test=dash-flag]": flagsOf(disputesOwner) },
			contains: {
				"[data-test=dash-flag]": [
					"Mar",
					"3 disputes",
					"May",
					"5 disputes",
					"Sep",
					"4 disputes",
					"Show ›",
				],
			},
			text: {
				[valueSelector("disputes_opened")]: text(
					disputesOwner,
					"disputes_opened",
					"2026-06",
				),
				[valueSelector("refund_rate")]: text(
					disputesOwner,
					"refund_rate",
					"2026-06",
				),
			},
		},
	},
	{
		id: "risk-disputes-finance",
		source:
			"the finance viewer on Disputes, Risk, Jun: the screen for the shot; its cells (most disputes hidden by the cell rules) are checked by C4, so the entry holds copy only",
		route: route("disputes", "finance", "month", "risk", "2026-06"),
		expect: {
			text: { "[data-test=preset-option].on": "Disputes" },
			count: { "[data-test=kpi-card]": 4 },
			contains: {
				"[data-test=kpi-label]": cards.risk.map(([label]) => label),
			},
		},
		shot: { full: true, mockupSteps: mockupSteps("disputes", "risk", 5) },
	},
	{
		id: "smoke-annual-note",
		source:
			"smoke.mjs 'annual note' and 'annual jan gross' $5,735.00; mockup .note copy for annual-prepay; rows annual-prepay gross_collected 2026-01 = 573500",
		route: route("annual-prepay", "owner", "month", "money", "2026-01"),
		expect: {
			text: {
				"[data-test=dash-note]":
					"Cash basis: a yearly payer counts in the month paid, so every month after January looks empty. MRR and churn are not computed.",
				[valueSelector("gross_collected")]: "$5,735.00",
				[valueSelector("net_income")]: text(
					annualOwner,
					"net_income",
					"2026-01",
				),
				"[data-test=preset-option].on": "Annual prepay",
			},
		},
	},
	{
		id: "no-note-on-monthly",
		source: "mockup: the .note shows for annual-prepay only",
		route: route("monthly-members", "owner", "month", "money", "2026-06"),
		expect: { count: { "[data-test=dash-note]": 0 } },
	},
	{
		id: "month-step",
		source:
			"smoke.mjs 'month step': [data-dstep=-1] moves the month back one; mockup .kmonths ‹ › buttons",
		route: route("monthly-members", "owner", "month", "money", "2026-06"),
		steps: [{ click: '[data-test=dash-step][data-step="-1"]' }],
		expect: {
			hash: "month=2026-05",
			text: {
				"[data-test=dash-month].on": "May",
				[valueSelector("payouts")]: text(owner, "payouts", "2026-05"),
			},
		},
	},
	{
		id: "view-switch",
		source: "mockup [data-dv] buttons switch Money, Members, Risk",
		route: route("monthly-members", "owner", "month", "money", "2026-06"),
		steps: [{ click: "[data-test=dash-view][data-view=members]" }],
		expect: {
			hash: "view=members",
			text: { "[data-test=dash-view].on": "Members" },
			count: { "[data-test=kpi-card]": 4 },
		},
	},
	{
		id: "preset-switch",
		source:
			"mockup [data-dsc] switcher: the mockup's four labels; the mart's 15 presets",
		route: route("monthly-members", "owner", "month", "money", "2026-06"),
		steps: [{ click: "[data-test=preset-option][data-preset=disputes]" }],
		expect: {
			hash: "preset=disputes",
			text: {
				"[data-test=preset-option].on": "Disputes",
				[valueSelector("gross_collected")]: text(
					disputesOwner,
					"gross_collected",
					"2026-06",
				),
			},
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
		id: "month-buttons-stop-at-the-clock",
		source:
			"protocol §3: periods after the clock's month are not in the document (the mockup draws Dec); quarters read Q1 to Q4",
		route: route("monthly-members", "owner", "quarter", "money", "2026-Q4"),
		expect: {
			count: { "[data-test=dash-month]": ownerQuarter.periods.length },
			contains: { "[data-test=dash-month]": ["Q1", "Q2", "Q3", "Q4"] },
			text: { "[data-test=dash-month].on": "Q4" },
		},
	},
	{
		id: "empty-free-only",
		source:
			"mockup dashboard() empty state (smoke.mjs 'nw empty'): free-only has no payment in any closed period, so the cards give way to the notice",
		route: route("free-only", "owner", "month", "money", "2026-06"),
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
			"bundle non-usd params.currency eur; mockup badge 'Cash basis · ' plus the currency symbol (s.cur), here the document currency's. atm skips non-USD payments (bundle stats.skipped.non_usd 260), so the preset has no money and shows the empty state",
		route: route("non-usd", "owner", "month", "money", "2026-06"),
		expect: {
			contains: { "[data-test=dash-badge]": ["Cash basis · €"] },
			count: { "[data-test=dash-empty]": 1 },
			absent: ["Cash basis · $"],
		},
	},
	{
		id: "stale-banner",
		source:
			"mockup: Maple Pilates is 26 min behind; S0's shell banner, now hooked (spec v3: stale banner when lagMinutes > 15)",
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
		route: route("monthly-members", "owner", "month", "money", "2026-06"),
		expect: { count: { "[data-test=stale-banner]": 0 } },
	},
	{
		id: "verified-badge",
		source:
			"spec v3 'Manifest and integrity': a verified badge for the owner and admins; documents.json verified: true",
		route: route("monthly-members", "owner", "month", "money", "2026-06"),
		expect: { text: { "[data-test=verified-badge]": "Verified" } },
	},
	{
		id: "scope-badge",
		source:
			"mockup e2d561e74 (PR #113): the third .kt badge 'Owners and admins only' with its title",
		route: route("monthly-members", "owner", "month", "money", "2026-06"),
		expect: {
			count: {
				'[data-test=dash-badge][title="Members never see the dashboard; they get the member portal"]': 1,
			},
		},
	},
	{
		id: "viewer-chip-admin",
		source:
			"mockup e2d561e74 (PR #113) renderHead(): #kview 'You see all members' with the role note as its title; B4 Uni's role is admin",
		route: "#/b4u/dashboard?theme=light",
		expect: {
			text: { "[data-test=viewer-chip]": "You see all members" },
			count: {
				[`[data-test=viewer-chip][title="${roleNote("an admin", "B4 Uni")}"]`]: 1,
			},
		},
	},
	{
		id: "viewer-chip-owner",
		source:
			"mockup e2d561e74 (PR #113) renderHead(): Vibes of Light's role is owner",
		route: "#/vol/dashboard?theme=light",
		expect: {
			text: { "[data-test=viewer-chip]": "You see all members" },
			count: {
				[`[data-test=viewer-chip][title="${roleNote("an owner", "Vibes of Light")}"]`]: 1,
			},
		},
	},
	{
		id: "viewer-chip-all-schools",
		source: "mockup e2d561e74 renderHead(): #kview is hidden on All schools",
		route: "#/all/all?theme=light",
		expect: { count: { "[data-test=viewer-chip]": 0 } },
	},
	{
		id: "demo-only-shown",
		source:
			"cell-rules demo-only: MRR, ARR (12 x MRR) and churned members from bundle.mrr, shown with the label 'derived, demo only' to the demo viewer",
		route: route("monthly-members", "demo", "month", "money", "2026-06"),
		expect: {
			text: {
				[cellSelector("mrr", "2026-06")]: text(demo, "mrr", "2026-06"),
				[cellSelector("arr", "2026-06")]: text(demo, "arr", "2026-06"),
			},
			contains: { "[data-test=demo-note]": ["derived, demo only"] },
		},
	},
	{
		id: "demo-only-hidden",
		source:
			"cell-rules demo-only: every other viewer gets it in notComputed and renders not_computed, without the demo label",
		route: route("monthly-members", "owner", "month", "money", "2026-06"),
		expect: {
			text: {
				[cellSelector("mrr", "2026-06")]: labels.not_computed ?? "",
				[cellSelector("arr", "2026-06")]: labels.not_computed ?? "",
			},
			count: { "[data-test=demo-note]": 0 },
		},
	},
	{
		id: "credits-outstanding-blocked",
		source:
			"cell-rules credits_outstanding: blocked for every viewer, with its label",
		route: route("monthly-members", "owner", "month", "members", "2026-06"),
		expect: {
			text: {
				[cellSelector("credits_outstanding", "2026-06")]: labels.blocked ?? "",
				[cellSelector("churned_members", "2026-06")]: labels.not_computed ?? "",
			},
		},
	},
	{
		id: "open-period-owner",
		source:
			"cell-rules owner openPeriod shown: the clock's month (Nov) is in the document and the owner sees it",
		route: route("monthly-members", "owner", "month", "money", "2026-11"),
		expect: {
			text: {
				[valueSelector("gross_collected")]: text(
					owner,
					"gross_collected",
					"2026-11",
				),
			},
		},
	},
	{
		id: "admin-members-quarter",
		source:
			"the admin viewer on Members by quarter, Q2: the screen for the shot; its cells (banded counts, locked amounts, distinct counts not computed per quarter) are checked by C4, so the entry holds copy only. The mockup has no quarter state: its closest screen is Members on Jun",
		route: route("monthly-members", "admin", "quarter", "members", "2026-Q2"),
		expect: {
			text: { "[data-test=dash-month].on": "Q2" },
			count: { "[data-test=kpi-card]": 4 },
			contains: {
				"[data-test=kpi-label]": cards.members.map(([label]) => label),
			},
		},
		shot: {
			full: true,
			mockupSteps: mockupSteps("monthly-members", "members", 5),
		},
	},
];

const golden = {
	slice: "S1",
	notes: [
		"Routes: #/<school>/dashboard?preset=&viewer=&grain=&view=&month=, month a document period (YYYY-MM or YYYY-Qn). Every school's Dashboard shows the Before University mart documents; the viewer is set by the hash only; the viewer chip in the top bar follows the school's role, as the mockup's #kview does.",
		"root.dataset.route is set only after the Dashboard has rendered the document of that route.",
		"Every rendered KPI cell carries data-kpi, data-period and data-cell (cellKind of src/data/kpi-document.ts: number, lt or the hidden kind), and its text is exactly the cell: money with Intl.NumberFormat('en-US', { style: 'currency', currency }) from minor units, integers with en-US grouping, percents with Intl percent and one decimal, lt as <N, a hidden kind as its cell-rules label. Labels, captions and the 'derived, demo only' note sit outside the cell element.",
		"kpi-card is one of the mockup's cards (5 Money, 4 Members, 4 Risk); its value element is kpi-value with the card KPI's data-kpi. Dispute cost shows disputes_lost and dispute_fees as two cells (the UI derives nothing, so no sum). MRR and ARR (Money), churned members and credits outstanding (Members) render as cells outside the card row.",
		"empty: a document with every payments_count cell 0 or open_period shows dash-empty in place of the cards and charts (mockup line 725); C4 then requires no KPI.",
		"dash-view buttons carry data-view, preset-option buttons data-preset, dash-step buttons data-step (-1 or 1); the selected view, month and preset buttons carry the mockup's class 'on'. Clicking one navigates by hash.",
	],
	hooks: [
		"dash-view",
		"dash-month",
		"dash-step",
		"preset-option",
		"kpi-card",
		"kpi-label",
		"kpi-value",
		"dash-badge",
		"dash-note",
		"dash-empty",
		"dash-flag",
		"demo-note",
		"stale-banner",
		"verified-badge",
		"viewer-chip",
	],
	views,
	matrix: {
		view: ["money", "members", "risk"],
		viewer: viewers,
		grain: grains,
	},
	entries,
};

writeFileSync(
	join(packageRoot, "test/golden/S1.json"),
	`${JSON.stringify(golden, null, "\t")}\n`,
);
process.stdout.write(`S1.json: ${entries.length} entries\n`);
