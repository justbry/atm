import type { BooksLevel, KpiDocument } from "../data/kpi-document.ts";
import type { Reader } from "../data/reader.ts";
import type { Clock, DashboardOptions, School } from "../data/types.ts";
import { bookingsBySchool } from "./bookings.ts";
import cellRules from "./mart/cell-rules.json";
import documentsFile from "./mart/documents.json";
import { plansBySchool } from "./plans.ts";

/** The mockup's four schools (its `SC` table), with the counts its headless run shows on 2026-11-05: attention from
 * `attN`, overdue bookings from `groups().out`, expiring promos from `expiring`, stale when `lag` is over 15 minutes.
 * Vibes of Light's Plans tab shows `draft` as the mockup draws it. The books level is `bkDefault`'s: at B4 Uni the
 * signed-in person is Jo A., an admin with the finance grant; elsewhere the owner. B4 Uni, the mockup's fixture
 * school, opens its Dashboard on Jun (`dm=5`). */
const schools: School[] = [
	{
		id: "vol",
		name: "Vibes of Light",
		timeZone: "America/Denver",
		currency: "USD",
		creditUnit: { one: "session", other: "sessions" },
		role: "owner",
		booksLevel: "owner",
		stale: false,
		lagMinutes: 2,
		attentionCount: 4,
		tabBadges: { plansDraft: true, bookingsOverdue: 2, promosExpiring: 1 },
	},
	{
		id: "b4u",
		name: "B4 Uni",
		timeZone: "America/Chicago",
		currency: "USD",
		creditUnit: { one: "credit", other: "credits" },
		role: "admin",
		booksLevel: "finance_admin",
		dashboardOpensOn: "2026-06",
		stale: false,
		lagMinutes: 3,
		attentionCount: 2,
		tabBadges: { plansDraft: false, bookingsOverdue: 1, promosExpiring: 0 },
	},
	{
		id: "map",
		name: "Maple Pilates",
		timeZone: "America/Toronto",
		currency: "CAD",
		creditUnit: { one: "class", other: "classes" },
		role: "owner",
		booksLevel: "owner",
		stale: true,
		lagMinutes: 26,
		attentionCount: 1,
		tabBadges: { plansDraft: false, bookingsOverdue: 0, promosExpiring: 0 },
	},
	{
		id: "nw",
		name: "Lotus Lane Yoga",
		timeZone: "America/Los_Angeles",
		currency: "USD",
		creditUnit: { one: "class", other: "classes" },
		role: "owner",
		booksLevel: "owner",
		stale: false,
		lagMinutes: 1,
		attentionCount: 0,
		tabBadges: { plansDraft: false, bookingsOverdue: 0, promosExpiring: 0 },
	},
];

/** The mart's 15 presets: the mockup's four scenarios first, with its labels and its annual-prepay note, then the
 * others by id. */
const presets: DashboardOptions["presets"] = [
	{ id: "monthly-members", label: "Monthly members" },
	{
		id: "annual-prepay",
		label: "Annual prepay",
		note: "Cash basis: a yearly payer counts in the month paid, so every month after January looks empty. MRR and churn are not computed.",
	},
	{ id: "disputes", label: "Disputes" },
	{ id: "heavy-refunds", label: "Heavy refunds" },
	{ id: "child-only", label: "Child only" },
	{ id: "churn-spike", label: "Churn spike" },
	{ id: "fee-oracle", label: "Fee oracle" },
	{ id: "free-only", label: "Free only" },
	{ id: "growth-12mo", label: "Growth over 12 months" },
	{ id: "non-usd", label: "Non-USD" },
	{ id: "one-payer-tier", label: "One payer tier" },
	{ id: "seminar-quantities", label: "Seminar quantities" },
	{ id: "single-refund-month", label: "Single refund month" },
	{ id: "tiny-school", label: "Tiny school" },
	{ id: "yearly-solo", label: "Yearly solo" },
];

/** The five books levels in rank order. */
const levels: DashboardOptions["levels"] = Object.entries(cellRules.levels)
	.sort(([, first], [, second]) => first.rank - second.rank)
	.map(([id, { name, pin, steps }]) => ({
		id: id as BooksLevel,
		name,
		pin,
		steps,
	}));

/** The orchestrator's documents, computed at the mockup's clock (protocol §4): returned as they are, keyed as
 * `gates/oracle.ts` `documentKey` keys them. */
const documents = documentsFile as unknown as Record<string, KpiDocument>;

const plansOf = (schoolId: string) => {
	const plans = plansBySchool[schoolId];
	if (!plans) throw new Error(`no plans fixture for school ${schoolId}`);
	return plans;
};

/** The fixture Reader. The documents are fixed at the clock the gates use, so it only names the clock. */
export function createFixtureReader(_options: { clock: Clock }): Reader {
	return {
		schools: async () => schools,
		dashboardOptions: async () => ({
			presets,
			levels,
			labels: cellRules.labels,
		}),
		bookings: async ({ school, from, to }) => ({
			bookings: (bookingsBySchool[school] ?? []).filter(({ startsAt }) => {
				const day = startsAt.slice(0, 10);
				return day >= from && day <= to;
			}),
		}),
		menuVersions: async (schoolId) => plansOf(schoolId).versions,
		menuVersion: async (schoolId, version) => plansOf(schoolId).bodies[version],
		planSummary: async (schoolId) => plansOf(schoolId).summary,
		kpiDocument: async ({ preset, level, pinLocked }) =>
			documents[`${preset}.${level}${pinLocked ? ".pin-locked" : ""}`],
	};
}
