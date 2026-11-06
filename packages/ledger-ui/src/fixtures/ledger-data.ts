import type { LedgerEventType, Promo, SchoolRules } from "../data/ledger.ts";

/** An event as the mockup's `SC.<school>.E` holds it (its table, in its order): the fixture Reader turns each into an
 * atm event with the id `<school>-e<index>`. Amounts are minor units, signed; credits are whole credits, signed. */
export type SourceEvent = {
	/** The school's local wall time, `YYYY-MM-DDTHH:MM`. */
	at: string;
	type: LedgerEventType;
	/** The member's id; none for a payout or a gift sold to a guest. */
	member: string | null;
	text: string;
	credits?: number;
	amountCents?: number;
	source: string;
	/** `membership`, `booking`, `gift` or `gift_redeemed`. */
	kind?: string;
	booking?: string;
	/** The promo id the event is labelled with. */
	code?: string;
	paymentId?: string;
	/** What a code took off the invoice (the mockup's `disc`). */
	discountCents?: number;
};

/** A promo as the mockup keeps it: how often it was used is a count here; the Reader shows each audience what it may
 * see of it. */
export type SourcePromo = Omit<Promo, "used"> & { used: number };

/** A donor who is not a member (the mockup's `SC.<school>.don`). */
export type SourceDonor = {
	id: string;
	name: string;
	amountCents: number;
	/** The day of the gift, `YYYY-MM-DD`. */
	date: string;
	fund: string;
	/** The donor asked to be anonymous to the finance admin (spec v2). */
	anonymous?: true;
};

/** The mockup's events per school, newest first as it lists them. */
export const eventsBySchool: Record<string, SourceEvent[]> = {
	vol: [
		{
			at: "2026-11-04T16:20",
			type: "credit.held",
			member: "m_093",
			text: "Held for Massage 90",
			credits: -1,
			source: "family",
			booking: "bk_9ab",
		},
		{
			at: "2026-11-04T09:12",
			type: "credit.granted",
			member: "m_093",
			text: "Plan allowance, Glow",
			credits: 24,
			source: "stripe",
		},
		{
			at: "2026-11-04T09:12",
			type: "payment.succeeded",
			member: "m_093",
			text: "Invoice paid, Glow monthly",
			amountCents: 6500,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_214",
		},
		{
			at: "2026-11-04T07:30",
			type: "credit.held",
			member: "m_204",
			text: "Held for Massage 90",
			credits: -1,
			source: "family",
			booking: "bk_8zz",
		},
		{
			at: "2026-11-03T18:40",
			type: "credit.spent",
			member: "m_204",
			text: "Massage 90 attended",
			credits: -2,
			source: "family",
			booking: "bk_7aa",
		},
		{
			at: "2026-11-03T11:30",
			type: "payment.succeeded",
			member: null,
			text: "Gift certificate sold, GIFT50",
			amountCents: 5000,
			source: "stripe",
			kind: "gift",
			code: "c_02",
			paymentId: "pay_514",
		},
		{
			at: "2026-11-03T11:05",
			type: "credit.depleted",
			member: "m_204",
			text: "Balance reached 0",
			source: "family",
		},
		{
			at: "2026-11-03T07:00",
			type: "payout.paid",
			member: null,
			text: "Payout to bank",
			amountCents: 20216,
			source: "stripe",
		},
		{
			at: "2026-11-02T15:22",
			type: "payment.refunded",
			member: "m_051",
			text: "Partial refund",
			amountCents: -5000,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_51",
		},
		{
			at: "2026-11-02T15:22",
			type: "credit.refunded",
			member: "m_051",
			text: "Taken back after refund",
			credits: -4,
			source: "stripe",
		},
		{
			at: "2026-11-02T10:00",
			type: "payment.succeeded",
			member: "m_088",
			text: "Group event paid",
			amountCents: 4000,
			source: "stripe",
			kind: "booking",
			booking: "bk_3cd",
			paymentId: "pay_1014",
		},
		{
			at: "2026-11-01T10:00",
			type: "payment.succeeded",
			member: "m_012",
			text: "Invoice paid, Sparkle ×4 (10% off)",
			amountCents: 11700,
			source: "stripe",
			kind: "membership",
			code: "c_01",
			paymentId: "pay_1114",
			discountCents: 1300,
		},
		{
			at: "2026-11-01T10:00",
			type: "payment.succeeded",
			member: "m_204",
			text: "Invoice paid, Sparkle ×2",
			amountCents: 6500,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_1214",
		},
		{
			at: "2026-11-01T08:00",
			type: "credit.forfeited",
			member: "m_117",
			text: "Late cancel, Massage 90",
			credits: -2,
			source: "family",
			booking: "bk_2xy",
		},
		{
			at: "2026-11-01T00:00",
			type: "credit.expired",
			member: "m_117",
			text: "Rollover over cap",
			credits: -6,
			source: "cron",
		},
		{
			at: "2026-10-30T12:10",
			type: "credit.adjusted",
			member: "m_088",
			text: "Goodwill · late cancel · by admin@vibes",
			credits: 2,
			source: "admin",
		},
		{
			at: "2026-10-20T09:00",
			type: "credit.granted",
			member: "m_088",
			text: "Gift redeemed",
			credits: 4,
			source: "family",
			kind: "gift_redeemed",
			code: "c_03",
		},
		{
			at: "2026-10-15T10:00",
			type: "payment.succeeded",
			member: "m_012",
			text: "Invoice paid, Sparkle ×4",
			amountCents: 13000,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_1714",
		},
		{
			at: "2026-10-15T10:00",
			type: "credit.granted",
			member: "m_012",
			text: "Plan allowance",
			credits: 32,
			source: "stripe",
		},
		{
			at: "2026-10-14T10:00",
			type: "payment.succeeded",
			member: "m_051",
			text: "Invoice paid, Shine ×2",
			amountCents: 6000,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_51",
		},
		{
			at: "2026-10-12T09:00",
			type: "payment.succeeded",
			member: "m_117",
			text: "Invoice paid, Shine ×4",
			amountCents: 12000,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_2014",
		},
		{
			at: "2026-10-03T07:00",
			type: "payout.paid",
			member: null,
			text: "Payout to bank",
			amountCents: 19000,
			source: "stripe",
		},
		{
			at: "2026-09-20T10:00",
			type: "payment.succeeded",
			member: "m_088",
			text: "Invoice paid, Sparkle",
			amountCents: 6500,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_2214",
		},
	],
	b4u: [
		{
			at: "2026-11-03T10:05",
			type: "credit.granted",
			member: "s_25",
			text: "Plan allowance",
			credits: 8,
			source: "stripe",
		},
		{
			at: "2026-11-03T10:06",
			type: "credit.granted",
			member: "s_26",
			text: "Plan allowance",
			credits: 8,
			source: "stripe",
		},
		{
			at: "2026-11-03T10:00",
			type: "payment.succeeded",
			member: "s_21",
			text: "Invoice paid, Shine ×2",
			amountCents: 9000,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_26",
		},
		{
			at: "2026-11-03T10:00",
			type: "credit.granted",
			member: "s_21",
			text: "Plan allowance",
			credits: 12,
			source: "stripe",
		},
		{
			at: "2026-11-02T14:10",
			type: "credit.held",
			member: "s_22",
			text: "Held for Tutoring",
			credits: -1,
			source: "family",
			booking: "bk_b11",
		},
		{
			at: "2026-10-20T09:00",
			type: "payment.succeeded",
			member: "s_23",
			text: "Invoice paid, Shine",
			amountCents: 4500,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_56",
		},
		{
			at: "2026-10-04T07:00",
			type: "payout.paid",
			member: null,
			text: "Payout to bank",
			amountCents: 15000,
			source: "stripe",
		},
		{
			at: "2026-06-02T10:00",
			type: "payment.succeeded",
			member: "s_21",
			text: "Invoice paid, Shine ×2",
			amountCents: 9000,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_76",
		},
		{
			at: "2026-06-02T10:05",
			type: "payment.succeeded",
			member: "s_22",
			text: "Invoice paid, Sparkle",
			amountCents: 2000,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_86",
		},
		{
			at: "2026-06-03T09:00",
			type: "payment.succeeded",
			member: "s_23",
			text: "Invoice paid, Shine",
			amountCents: 4500,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_96",
		},
	],
	map: [
		{
			at: "2026-11-04T11:30",
			type: "payment.succeeded",
			member: "p_09",
			text: "Invoice paid, Glow",
			amountCents: 8500,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_013",
		},
		{
			at: "2026-11-04T11:30",
			type: "credit.granted",
			member: "p_09",
			text: "Plan allowance",
			credits: 24,
			source: "stripe",
		},
		{
			at: "2026-11-02T16:00",
			type: "credit.depleted",
			member: "p_07",
			text: "Balance reached 0",
			source: "family",
		},
		{
			at: "2026-11-01T00:00",
			type: "credit.expired",
			member: "p_07",
			text: "Rollover over cap",
			credits: -4,
			source: "cron",
		},
		{
			at: "2026-10-18T10:00",
			type: "payment.succeeded",
			member: "p_07",
			text: "Invoice paid, Glow",
			amountCents: 21000,
			source: "stripe",
			kind: "membership",
			paymentId: "pay_413",
		},
	],
	nw: [],
};

/** Who the members are, by id (the mockup's `people`): brief A item 1's members list, joined to events by key. */
export const memberNames: Record<string, Record<string, string>> = {
	vol: {
		m_204: "Mia R.",
		m_117: "Jon K.",
		m_093: "Ana P.",
		m_088: "Lee T.",
		m_051: "Sam O.",
		m_012: "Ivy N.",
	},
	b4u: {
		s_21: "Dana W.",
		s_22: "Omar F.",
		s_23: "Pia L.",
		s_24: "Raj S.",
		s_25: "Kai W.",
		s_26: "Lia W.",
		s_27: "Marta G.",
	},
	map: { p_07: "Chloe B.", p_08: "Eli M.", p_09: "Noor A." },
	nw: {},
};

/** The mockup's `rules` per school. */
export const rulesBySchool: Record<string, SchoolRules> = {
	vol: { cancelCutoffHours: 24, noShow: "spend", lateCancel: "spend" },
	b4u: { cancelCutoffHours: 48, noShow: "release", lateCancel: "release" },
	map: { cancelCutoffHours: 24, noShow: "spend", lateCancel: "release" },
	nw: { cancelCutoffHours: 24, noShow: "spend", lateCancel: "release" },
};

/** The mockup's promo codes (`SC.<school>.K`), in its order; the Reader lists them newest first. */
export const promosBySchool: Record<string, SourcePromo[]> = {
	vol: [
		{
			id: "c_01",
			code: "SPRING10",
			type: "member",
			value: 10,
			used: 3,
			maxUses: null,
			expiresOn: "2026-12-31",
			status: "active",
		},
		{
			id: "c_02",
			code: "GIFT50-7QX2",
			type: "dollar",
			value: 5000,
			used: 0,
			maxUses: 1,
			expiresOn: "2027-03-01",
			status: "active",
		},
		{
			id: "c_03",
			code: "WELCOME4",
			type: "session",
			value: 4,
			used: 1,
			maxUses: 1,
			expiresOn: "2027-04-20",
			status: "redeemed",
		},
		{
			id: "c_04",
			code: "THANKYOU2",
			type: "session",
			value: 2,
			used: 0,
			maxUses: 1,
			expiresOn: "2026-11-30",
			status: "active",
		},
	],
	b4u: [
		{
			id: "c_11",
			code: "UNI15",
			type: "member",
			value: 15,
			used: 2,
			maxUses: null,
			expiresOn: "2026-12-31",
			status: "active",
		},
	],
	map: [],
	nw: [],
};

/** The mockup's named donors (`SC.vol.don`); B4 Uni's 62 are generated below, as its `bkMakeDonors` does. */
export const volDonors: SourceDonor[] = [
	{
		id: "d_0030",
		name: "Pat Ellis",
		amountCents: 2500,
		date: "2026-02-11",
		fund: "General",
	},
	{
		id: "d_9e67",
		name: "Ravi Shah",
		amountCents: 6000,
		date: "2026-03-02",
		fund: "General",
	},
	{
		id: "d_3c9e",
		name: "Mia Rowe",
		amountCents: 12000,
		date: "2026-05-19",
		fund: "General",
	},
	{
		id: "d_dad5",
		name: "Jon Kemp",
		amountCents: 4000,
		date: "2026-07-08",
		fund: "General",
	},
	{
		id: "d_790c",
		name: "Ana Pruitt",
		amountCents: 30000,
		date: "2026-09-14",
		fund: "Appeal",
	},
];
