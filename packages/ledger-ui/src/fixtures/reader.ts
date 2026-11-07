import type { Disclosure, DisclosureFile } from "../data/disclosure.ts";
import type { KpiDocument, KpiQuery } from "../data/kpi-document.ts";
import type { MembersFixture } from "../data/members.ts";
import type { Reader } from "../data/reader.ts";
import type { SchoolSettings } from "../data/settings.ts";
import type { Clock, DashboardOptions, School } from "../data/types.ts";
import { bookingsBySchool } from "./bookings.ts";
import disclosureFixture from "./disclosure.json";
import { createLedgerReader } from "./ledger.ts";
import documentsFile from "./mart/documents.json";
import { membersFixtures } from "./members.ts";
import { plansBySchool } from "./plans.ts";
import { fixtureMemberPortal } from "./portal.ts";
import settingsFixture from "./settings.json";

/** The mockup's five schools (its `SC` table; test/golden/S0.json `fixtures.schools`), with the counts its headless
 * run shows on 2026-11-05: attention from `attN`, overdue bookings from `groups().out`, expiring promos from
 * `expiring`, stale when `lag` is over 15 minutes. Vibes of Light's Plans tab shows `draft` as the mockup draws it.
 * Who the signed-in person is at each school, and so what the Dashboard opens as, is the disclosure's `viewer`. B4 Uni,
 * the mockup's fixture school, opens its Dashboard on Jun (`dm=5`). */
const schools: School[] = [
	{
		id: "vol",
		name: "Vibes of Light",
		timeZone: "America/Denver",
		currency: "USD",
		creditUnit: { one: "session", other: "sessions" },
		role: "owner",
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
		stale: false,
		lagMinutes: 1,
		attentionCount: 0,
		tabBadges: { plansDraft: false, bookingsOverdue: 0, promosExpiring: 0 },
	},
	{
		id: "har",
		name: "Harbor Arts Academy",
		timeZone: "America/New_York",
		currency: "USD",
		creditUnit: { one: "credit", other: "credits" },
		role: "admin",
		stale: false,
		lagMinutes: 2,
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

/** The orchestrator's documents, computed at the mockup's clock (protocol §4): returned as they are, keyed as
 * `gates/oracle.ts` `documentKey` keys them: B4 Uni's `<preset>.<audience>`, another fixture school's
 * `<school>/<preset>.<audience>`, a school whose figures come from its events `<school>.<audience>`, PIN-locked ones
 * with `.pin-locked`. */
const documents = documentsFile as unknown as Record<string, KpiDocument>;
const fixtureSchools = new Set(["b4u", "har"]);
const documentKey = ({
	school,
	preset,
	audience,
	pinLocked,
}: KpiQuery): string =>
	`${fixtureSchools.has(school) ? (school === "b4u" ? preset : `${school}/${preset}`) : school}.${audience}${pinLocked ? ".pin-locked" : ""}`;

const plansOf = (schoolId: string) => {
	const plans = plansBySchool[schoolId];
	if (!plans) throw new Error(`no plans fixture for school ${schoolId}`);
	return plans;
};

const membersOf = (schoolId: string): MembersFixture => {
	const fixture = membersFixtures[schoolId];
	if (!fixture) throw new Error(`no Members fixture for school ${schoolId}`);
	return fixture;
};

/** Each school's disclosure as the server works it out at the clock: its own record, with the file they share. */
const disclosureFile = disclosureFixture.file as unknown as DisclosureFile;
const disclosures = disclosureFixture.schools as unknown as Record<
	string,
	Omit<Disclosure, "file">
>;
const settingsBySchool = settingsFixture.schools as unknown as Record<
	string,
	SchoolSettings
>;

/** The fixture Reader. The documents are fixed at the clock the gates use; the Ledger, Reports and Promos read the
 * clock for today. */
export function createFixtureReader(options: { clock: Clock }): Reader {
	return {
		...createLedgerReader({
			clock: options.clock,
			schools,
			reportDocument: ({ school, audience }) => {
				const document =
					documents[
						documentKey({
							school,
							preset: presets[0]?.id ?? "",
							audience,
							pinLocked: false,
						})
					];
				if (!document)
					throw new Error(`no ${audience} document for school ${school}`);
				return document;
			},
		}),
		schools: async () => schools,
		dashboardOptions: async () => ({ presets }),
		bookings: async ({ school, from, to }) => ({
			bookings: (bookingsBySchool[school] ?? []).filter(({ startsAt }) => {
				const day = startsAt.slice(0, 10);
				return day >= from && day <= to;
			}),
		}),
		menuVersions: async (schoolId) => plansOf(schoolId).versions,
		menuVersion: async (schoolId, version) => plansOf(schoolId).bodies[version],
		planSummary: async (schoolId) => plansOf(schoolId).summary,
		kpiDocument: async (query) => documents[documentKey(query)],
		members: async ({ schoolId, status }) => {
			const fixture = membersOf(schoolId).page;
			// The mockup's balance line reads "rollover 0" for every member: nothing rolls over in its data.
			const page = {
				...fixture,
				members: fixture.members.map((member) => ({
					...member,
					balances: member.balances.map((balance) => ({
						...balance,
						rolledOver: 0,
					})),
				})),
			};
			return status === undefined
				? page
				: {
						...page,
						members: page.members.filter((member) => member.status === status),
					};
		},
		people: async ({ schoolId }) => membersOf(schoolId).people,
		membersSummary: async ({ schoolId }) => membersOf(schoolId).summary,
		membersIncome: async ({ schoolId, from, to }) =>
			Object.entries(membersOf(schoolId).incomeByMonth)
				.filter(
					([month]) => month >= from.slice(0, 7) && month <= to.slice(0, 7),
				)
				.reduce((sum, [, cents]) => sum + cents, 0),
		capabilities: async ({ schoolId }) => membersOf(schoolId).capabilities,
		financeGrants: async ({ schoolId }) => membersOf(schoolId).financeGrants,
		memberDetail: async ({ schoolId, personId }) => {
			const detail = membersOf(schoolId).details[personId];
			if (!detail)
				throw new Error(`no member ${personId} in school ${schoolId}`);
			return {
				...detail,
				stripeDashboardUrl:
					detail.payments.length > 0
						? `https://dashboard.stripe.com/customers/${schoolId}-${personId}`
						: null,
			};
		},
		auditMember: async ({ schoolId, personId }) => {
			const school = membersOf(schoolId);
			const balance = school.page.members.find(
				({ profileId }) => profileId === personId,
			)?.balances[0];
			const unit = balance?.unit.other ?? school.summary.unit.other;
			// The mockup's audit: m_117's log misses a command (mockup.html audit, `bad`).
			const broken = personId === "m_117";
			const live = balance?.available ?? 0;
			return {
				steps: [
					{
						ok: true,
						text: "Read 14 events from 3 batches; 2 repeats dropped",
					},
					{ ok: true, text: "Every batch file matches the hash in its name" },
					{
						ok: true,
						text: "Replay through the engine reproduces each recorded change",
					},
					broken
						? {
								ok: false,
								text: `Replayed balance 4 ≠ live balance ${live}. A command is missing from the log (revision gap at r17).`,
							}
						: {
								ok: true,
								text: `Replayed balance ${live} equals live balance`,
							},
					{ ok: true, text: `Held ${unit} match open bookings` },
					{
						ok: true,
						text: "Stripe reconcile: all payments and refunds matched",
					},
				],
				clean: !broken,
				verdict: broken
					? "Don't adjust the balance by hand yet: restore the missing command, then re-run."
					: "Log, balance and Stripe agree.",
				reportFileName: `audit-${personId}.json`,
			};
		},
		invoiceItems: async ({ schoolId }) => membersOf(schoolId).invoiceItems,
		switchTiers: async ({ schoolId }) => membersOf(schoolId).switchTiers,
		memberPortal: async (query) => fixtureMemberPortal(query),
		disclosure: async (school) => {
			const disclosure = disclosures[school];
			if (!disclosure) throw new Error(`no disclosure for ${school}`);
			return { ...disclosure, file: disclosureFile };
		},
		settings: async (school) => {
			const settings = settingsBySchool[school];
			if (!settings) throw new Error(`no settings for ${school}`);
			return settings;
		},
	};
}
