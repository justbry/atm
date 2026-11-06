import type {
	FamilyRole,
	MemberPortal,
	PortalAddon,
	PortalAudience,
	PortalBooking,
	PortalHistoryRow,
	PortalMember,
	PortalQuery,
	PortalUnit,
	QuantityChanged,
	QuantityOption,
} from "../data/portal.ts";

/** The member portal's fixtures, from the mockup's B4 Uni (the Wu family and the people beside them) and Vibes of
 * Light (`SC.b4u`, `SC.vol`, read at 2026-11-05). The server's job is done here: every document holds one family and
 * nothing of any other (consistency check C5), and each person's history is the mockup's `kHist` (`kLive` from the
 * school's events, `kFixture`'s 21 invented months). */

type Menu = Record<
	string,
	{
		name: string;
		/** Minor units per unit of quantity, per month. */
		unitCents: number;
		/** The quantities the tier is sold in, or null when it is sold in one size. */
		quantities: number[] | null;
		/** Credits granted each month per unit of quantity. */
		monthlyGrant: number;
	}
>;
type SchoolFixture = {
	unit: PortalUnit;
	menu: Menu;
	addons: PortalAddon[];
};

const schools: Record<string, SchoolFixture> = {
	b4u: {
		unit: { one: "credit", other: "credits" },
		menu: {
			sparkle: {
				name: "Sparkle",
				unitCents: 2000,
				quantities: null,
				monthlyGrant: 8,
			},
			shine: {
				name: "Shine",
				unitCents: 4500,
				quantities: [1, 2],
				monthlyGrant: 12,
			},
			board: {
				name: "Board",
				unitCents: 0,
				quantities: null,
				monthlyGrant: 2,
			},
		},
		addons: [],
	},
	vol: {
		unit: { one: "session", other: "sessions" },
		menu: {
			sparkle: {
				name: "Sparkle",
				unitCents: 3250,
				quantities: [1, 2, 4],
				monthlyGrant: 8,
			},
			shine: {
				name: "Shine",
				unitCents: 3000,
				quantities: [2, 4],
				monthlyGrant: 6,
			},
		},
		addons: [
			{ id: "pack8", name: "Top-up pack", priceCents: 4000, grants: 8 },
			{ id: "pack16", name: "Big top-up pack", priceCents: 7200, grants: 16 },
		],
	},
	har: {
		unit: { one: "credit", other: "credits" },
		menu: {
			studio: {
				name: "Studio",
				unitCents: 12_000,
				quantities: null,
				monthlyGrant: 8,
			},
			ensemble: {
				name: "Ensemble",
				unitCents: 24_000,
				quantities: null,
				monthlyGrant: 16,
			},
			board: {
				name: "Board",
				unitCents: 0,
				quantities: null,
				monthlyGrant: 2,
			},
		},
		addons: [],
	},
};

/** One live row the school's events give a person (the mockup's `kLive`). */
type LiveRow = Pick<
	PortalHistoryRow,
	"date" | "description" | "amountCents" | "status"
> & {
	/** A refund row names the payment it returns; its invoice is that payment's. */
	refundOf?: { date: string; description: string };
	paymentId?: string;
};

type PersonFixture = {
	school: string;
	profileId: string;
	name: string;
	family: { id: string; role: FamilyRole } | null;
	tier: string;
	quantity: number;
	status: "active" | "canceled";
	/** The day the period ends, in the school's time zone (`YYYY-MM-DD`). */
	periodEnds: string;
	balance: { available: number; held: number; used: number };
	/** Whose audience the School books card shows: the person's own, as the server computes it. */
	audience: PortalAudience;
	live: LiveRow[];
};

const renewal = "2026-12-01";
const familyOf = (role: FamilyRole): PersonFixture["family"] => ({
	id: "fam_wu",
	role,
});

/** Family order is the order here: the adult, then the learners. */
const people: PersonFixture[] = [
	{
		school: "b4u",
		profileId: "s_21",
		name: "Dana W.",
		family: familyOf("adult"),
		tier: "shine",
		quantity: 2,
		status: "active",
		periodEnds: renewal,
		balance: { available: 10, held: 2, used: 0 },
		audience: "member",
		live: [
			{
				date: "2026-11-03",
				description: "Invoice paid, Shine ×2",
				amountCents: 9000,
				status: "paid",
			},
			{
				date: "2026-06-02",
				description: "Invoice paid, Shine ×2",
				amountCents: 9000,
				status: "paid",
			},
		],
	},
	{
		school: "b4u",
		profileId: "s_25",
		name: "Kai W.",
		family: familyOf("teen"),
		tier: "sparkle",
		quantity: 1,
		status: "active",
		periodEnds: renewal,
		balance: { available: 5, held: 1, used: 2 },
		audience: "public",
		live: [],
	},
	{
		school: "b4u",
		profileId: "s_26",
		name: "Lia W.",
		family: familyOf("child"),
		tier: "sparkle",
		quantity: 1,
		status: "active",
		periodEnds: renewal,
		balance: { available: 6, held: 1, used: 1 },
		audience: "public",
		live: [],
	},
	{
		school: "b4u",
		profileId: "s_22",
		name: "Omar F.",
		family: null,
		tier: "sparkle",
		quantity: 1,
		status: "active",
		periodEnds: renewal,
		balance: { available: 1, held: 1, used: 6 },
		audience: "member",
		live: [
			{
				date: "2026-06-02",
				description: "Invoice paid, Sparkle",
				amountCents: 2000,
				status: "paid",
			},
		],
	},
	{
		school: "b4u",
		profileId: "s_23",
		name: "Pia L.",
		family: null,
		tier: "shine",
		quantity: 1,
		status: "active",
		periodEnds: renewal,
		balance: { available: 22, held: 0, used: 2 },
		audience: "member",
		live: [],
	},
	{
		school: "b4u",
		profileId: "s_24",
		name: "Raj S.",
		family: null,
		tier: "sparkle",
		quantity: 1,
		status: "active",
		periodEnds: renewal,
		balance: { available: 14, held: 0, used: 2 },
		audience: "member",
		live: [],
	},
	{
		school: "b4u",
		profileId: "s_27",
		name: "Marta G.",
		family: null,
		tier: "board",
		quantity: 1,
		status: "active",
		periodEnds: renewal,
		balance: { available: 2, held: 0, used: 0 },
		audience: "governance",
		live: [],
	},
	{
		school: "vol",
		profileId: "m_051",
		name: "Sam O.",
		family: null,
		tier: "shine",
		quantity: 2,
		status: "canceled",
		periodEnds: "2026-11-11",
		balance: { available: 9, held: 0, used: 3 },
		audience: "public",
		live: [
			{
				date: "2026-11-02",
				description: "Partial refund",
				amountCents: -5000,
				status: "refunded",
				refundOf: { date: "2026-10-14", description: "Invoice paid, Shine ×2" },
				paymentId: "pay_51",
			},
			{
				date: "2026-10-14",
				description: "Invoice paid, Shine ×2",
				amountCents: 6000,
				status: "partly_refunded",
				paymentId: "pay_51",
			},
		],
	},
	{
		school: "vol",
		profileId: "m_204",
		name: "Mia R.",
		family: null,
		tier: "sparkle",
		quantity: 2,
		status: "active",
		periodEnds: renewal,
		balance: { available: 0, held: 1, used: 15 },
		audience: "member",
		live: [
			{
				date: "2026-11-01",
				description: "Invoice paid, Sparkle ×2",
				amountCents: 6500,
				status: "paid",
			},
		],
	},
];

/** Harbor Arts Academy's four members (mockup `SC.har.M`; their invoices are `SC.har.E`). None is in a family. */
const harborPeople: PersonFixture[] = [
	{
		school: "har",
		profileId: "h_31",
		name: "Rosa T.",
		family: null,
		tier: "studio",
		quantity: 1,
		status: "active",
		periodEnds: renewal,
		balance: { available: 5, held: 0, used: 3 },
		audience: "member",
		live: [
			{
				date: "2026-11-01",
				description: "Invoice paid, Studio",
				amountCents: 12_000,
				status: "paid",
			},
			{
				date: "2026-06-01",
				description: "Invoice paid, Studio",
				amountCents: 12_000,
				status: "paid",
			},
		],
	},
	{
		school: "har",
		profileId: "h_32",
		name: "Ben A.",
		family: null,
		tier: "ensemble",
		quantity: 1,
		status: "active",
		periodEnds: renewal,
		balance: { available: 9, held: 2, used: 5 },
		audience: "member",
		live: [
			{
				date: "2026-11-02",
				description: "Invoice paid, Ensemble",
				amountCents: 24_000,
				status: "paid",
			},
		],
	},
	{
		school: "har",
		profileId: "h_33",
		name: "Cy L.",
		family: null,
		tier: "studio",
		quantity: 1,
		status: "active",
		periodEnds: renewal,
		balance: { available: 2, held: 0, used: 6 },
		audience: "member",
		live: [],
	},
	{
		school: "har",
		profileId: "h_34",
		name: "Dee M.",
		family: null,
		tier: "board",
		quantity: 1,
		status: "active",
		periodEnds: renewal,
		balance: { available: 2, held: 0, used: 0 },
		audience: "governance",
		live: [],
	},
];
people.push(...harborPeople);

type BookingFixture = Omit<PortalBooking, "state" | "paidCents">;
const tutoring = (
	id: string,
	profileId: string,
	startsAt: string,
	held: number,
): BookingFixture => ({
	id,
	profileId,
	service: "Tutoring",
	startsAt,
	hosts: [{ id: "dr. lee", name: "Dr. Lee" }],
	cutoffMinutes: 2880,
	held,
});
/** The bookings not done, from the mockup's `B` (Vibes of Light keeps only the one the portal's people hold). */
const bookingsBySchool: Record<string, BookingFixture[]> = {
	b4u: [
		tutoring("bk_b11", "s_22", "2026-11-09T16:00", 1),
		tutoring("bk_b13", "s_25", "2026-11-10T16:00", 1),
		tutoring("bk_b14", "s_26", "2026-11-11T15:30", 1),
		tutoring("bk_b12", "s_21", "2026-11-04T15:00", 2),
	],
	vol: [
		{
			id: "bk_8zz",
			profileId: "m_204",
			service: "Massage 90",
			startsAt: "2026-11-04T17:00",
			hosts: [{ id: "kim", name: "Kim" }],
			cutoffMinutes: 1440,
			held: 1,
		},
	],
	har: [
		{
			id: "bk_h1",
			profileId: "h_32",
			service: "Ensemble lesson",
			startsAt: "2026-11-09T17:00",
			hosts: [{ id: "ms. ode", name: "Ms. Ode" }],
			cutoffMinutes: 1440,
			held: 2,
		},
	],
};

/** The mockup's `kId`: a short, stable id from a seed (FNV-1a, 32 bits, twice). */
const fnv = (seed: string): number => {
	let hash = 2166136261;
	for (const character of seed) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash;
};
const stripeId = (prefix: string, seed: string): string =>
	`${prefix}${fnv(seed).toString(16).padStart(8, "0")}${fnv(`${seed}x`).toString(16).padStart(8, "0").slice(0, 6)}`;

const newestFirst = (
	first: PortalHistoryRow,
	second: PortalHistoryRow,
): number =>
	second.date.localeCompare(first.date) ||
	Number(second.amountCents < 0) - Number(first.amountCents < 0);

const monthsOfInvention = 21;
const firstInventedMonth = 2024 * 12 + 11;
const inventedMonth = (index: number): string => {
	const total = firstInventedMonth + index;
	return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
};
const goodwillPercent = 25;
const packCents = 4000;
const packCredits = 8;

/** The events' times are 10:00; an invoice's id is made from its day, time and text. */
const liveInvoiceId = (
	profileId: string,
	{ date, description }: { date: string; description: string },
): string => stripeId("in_", `${profileId}${date}T10:00${description}`);

/** One person's history: the live rows, then the mockup's `kFixture` (21 invented months and the packs, refunds,
 * gift and open invoice the card pages through), newest first. */
function historyOf(
	person: PersonFixture,
	unit: PortalUnit,
): PortalHistoryRow[] {
	const { profileId } = person;
	const tier = schools[person.school]?.menu[person.tier];
	const priceCents = (tier?.unitCents ?? 0) * person.quantity;
	const rows: PortalHistoryRow[] = [];
	const add = (
		date: string,
		description: string,
		amountCents: number,
		status: PortalHistoryRow["status"],
		paid = true,
	): void => {
		rows.push({
			profileId,
			date,
			description,
			amountCents,
			currency: "USD",
			status,
			invoiceId: stripeId("in_", `${profileId}${date}${description}`),
			paymentId: paid
				? stripeId("pay_", `${profileId}${date}${description}`)
				: "",
			refundPending: false,
		});
	};
	for (const live of person.live)
		rows.push({
			profileId,
			date: live.date,
			description: live.description,
			amountCents: live.amountCents,
			currency: "USD",
			status: live.status,
			invoiceId: liveInvoiceId(profileId, live.refundOf ?? live),
			paymentId:
				live.paymentId ??
				stripeId("pay_", `${profileId}${live.date}${live.description}`),
			refundPending: false,
		});
	const memo = `Invoice paid, ${tier?.name ?? ""} monthly`;
	const pack = `Top-up pack · ${packCredits} ${unit.other}`;
	for (let index = 0; index < monthsOfInvention; index += 1) {
		const month = inventedMonth(index);
		if (index === 4) {
			add(`${month}-01`, memo, priceCents, "failed", false);
			add(`${month}-03`, `${memo} (retry)`, priceCents, "paid");
		} else if (index === 9) {
			add(`${month}-01`, memo, priceCents, "partly_refunded");
			add(
				`${month}-12`,
				"Refund, goodwill",
				-Math.round((priceCents * goodwillPercent) / 100),
				"refunded",
			);
		} else add(`${month}-01`, memo, priceCents, "paid");
	}
	add("2025-06-18", pack, packCents, "paid");
	add("2025-11-20", pack, packCents, "refunded");
	add("2025-11-22", "Refund, pack returned", -packCents, "refunded");
	add(
		"2026-02-14",
		"Gift certificate redeemed, GIFT25 (credit applied)",
		2500,
		"paid",
	);
	add(
		"2026-10-31",
		"Invoice sent, Top-up pack (unpaid)",
		packCents,
		"open",
		false,
	);
	return rows.sort(newestFirst);
}

const secondsOfSchoolNoon = (day: string): number =>
	Date.parse(`${day}T18:00:00Z`) / 1000;

function memberOf(person: PersonFixture, unit: PortalUnit): PortalMember {
	const menu = schools[person.school]?.menu[person.tier];
	const unitCents = menu?.unitCents ?? 0;
	const quantityOptions: QuantityOption[] | null =
		menu?.quantities?.map((quantity) => ({
			quantity,
			priceCents: unitCents * quantity,
		})) ?? null;
	return {
		key: `family:${person.family?.id ?? `fam_${person.profileId}`}`,
		familyId: person.family?.id ?? `fam_${person.profileId}`,
		profileId: person.profileId,
		name: person.name,
		familyRole: person.family?.role ?? null,
		tierId: person.tier,
		tierName: menu?.name ?? "",
		quantity: person.quantity,
		interval: "month",
		status: person.status,
		currentPeriodEnd: secondsOfSchoolNoon(person.periodEnds),
		cancelAtPeriodEnd: false,
		menuVersion: 1,
		balances: [
			{
				featureId: "credits",
				featureName: unit.other.replace(/^./, (letter) => letter.toUpperCase()),
				unit,
				available: person.balance.available,
				held: person.balance.held,
				expiresAt: null,
				used: person.balance.used,
			},
		],
		priceCents: unitCents * person.quantity,
		quantityOptions,
		pendingChange: false,
	};
}

const familyLabels: Record<string, string> = { fam_wu: "Wu family" };

/** The portal of one person as the server scopes it: an adult sees the family, anyone else only themselves. */
export function fixtureMemberPortal({
	school,
	profileId,
}: PortalQuery): MemberPortal | undefined {
	const fixture = schools[school];
	const viewed = people.find(
		(person) => person.school === school && person.profileId === profileId,
	);
	if (!(fixture && viewed)) return undefined;
	const familyId = viewed.family?.id;
	const kin = familyId
		? people.filter(
				(person) => person.school === school && person.family?.id === familyId,
			)
		: [];
	const scope = viewed.family?.role === "adult" ? "family" : "own";
	const included = scope === "family" ? kin : [viewed];
	const includedIds = included.map((person) => person.profileId);
	const guardian = kin.find((person) => person.family?.role === "adult");
	return {
		school,
		profileId,
		scope,
		family:
			familyId && viewed.family
				? {
						familyId,
						label: familyLabels[familyId] ?? "",
						members: kin.flatMap((person) =>
							person.family
								? [
										{
											profileId: person.profileId,
											name: person.name,
											familyRole: person.family.role,
										},
									]
								: [],
						),
					}
				: null,
		people: included.map((person) => memberOf(person, fixture.unit)),
		bookings: (bookingsBySchool[school] ?? [])
			.filter((booking) => includedIds.includes(booking.profileId))
			.sort((first, second) => first.startsAt.localeCompare(second.startsAt))
			.map((booking) => ({ ...booking, state: "confirmed", paidCents: null })),
		history: included
			.flatMap((person) => historyOf(person, fixture.unit))
			.sort(newestFirst),
		addons: fixture.addons,
		books: {
			audience: viewed.audience,
			guardian:
				viewed.family && scope === "own" && guardian
					? { profileId: guardian.profileId, name: guardian.name }
					: null,
		},
	};
}

/** Who the portal serves, for the tests that read every document. */
export const portalProfiles: ReadonlyArray<PortalQuery> = people.map(
	({ school, profileId }) => ({ school, profileId }),
);

const cycleDays = 30;
const cycleDaysLeft = 26;
/** What the server answers to Change amount: a decrease waits for the renewal; an increase is charged now, prorated
 * over the days left in the cycle (the mockup's `share`), with the credits it grants. */
export function fixtureQuantityChanged(
	{ school, profileId }: PortalQuery,
	quantity: number,
): QuantityChanged {
	const person = people.find(
		(candidate) =>
			candidate.school === school && candidate.profileId === profileId,
	);
	const menu = person ? schools[school]?.menu[person.tier] : undefined;
	if (!(person && menu) || quantity <= person.quantity)
		return { at: "renewal" };
	const added = quantity - person.quantity;
	return {
		at: "now",
		chargedCents: Math.round(
			(added * menu.unitCents * cycleDaysLeft) / cycleDays,
		),
		granted: Math.ceil((added * menu.monthlyGrant * cycleDaysLeft) / cycleDays),
	};
}
