import type { Reader } from "../data/reader.ts";
import type { Clock, School } from "../data/types.ts";

/** The mockup's four schools (its `SC` table), with the counts its headless run shows on 2026-11-05: attention from
 * `attN`, overdue bookings from `groups().out`, expiring promos from `expiring`, stale when `lag` is over 15 minutes.
 * Vibes of Light's Plans tab shows `draft` as the mockup draws it. */
const schools: School[] = [
	{
		id: "vol",
		name: "Vibes of Light",
		timeZone: "America/Denver",
		currency: "USD",
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
		role: "admin",
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
		role: "owner",
		stale: false,
		lagMinutes: 1,
		attentionCount: 0,
		tabBadges: { plansDraft: false, bookingsOverdue: 0, promosExpiring: 0 },
	},
];

/** The fixture Reader. The clock is part of the contract for the dated documents later slices read; the school list
 * does not depend on it. */
export function createFixtureReader(_options: { clock: Clock }): Reader {
	return { schools: async () => schools };
}
