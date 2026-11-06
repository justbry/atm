import type { Booking, BookingBilling } from "../data/bookings.ts";

/** The mockup's bookings per school (its `SC.<school>.B`, read at 2026-11-05T12:00), in the shape of the Bookings
 * contract. The mockup has no end time, event id or family id: the end follows the item's name, the event id is the
 * item's slug, and `attendee.key` is the mockup's member id (an opaque key to the UI). Billing is the mockup's `n`
 * (credits held), `paid` (dollars) or neither (free). */
type MockupBooking = {
	id: string;
	service: string;
	eventId: string;
	startsAt: string;
	endsAt: string;
	hosts: string[];
	member: { key: string; name: string };
	state: Booking["state"];
	cutoffMinutes: number;
	billing: BookingBilling;
};

const held = (credits: number): BookingBilling => ({ kind: "held", credits });

const toBooking = (booking: MockupBooking): Booking => ({
	id: booking.id,
	eventId: booking.eventId,
	service: booking.service,
	startsAt: booking.startsAt,
	endsAt: booking.endsAt,
	hosts: booking.hosts.map((name) => ({ id: name.toLowerCase(), name })),
	attendee: booking.member,
	guest: false,
	state: booking.state,
	cutoffMinutes: booking.cutoffMinutes,
	seriesId: null,
	attendance: null,
	billing: booking.billing,
});

const vibesOfLight: MockupBooking[] = [
	{
		id: "bk_8zz",
		service: "Massage 90",
		eventId: "ev_massage_90",
		startsAt: "2026-11-04T17:00",
		endsAt: "2026-11-04T18:30",
		hosts: ["Kim"],
		member: { key: "m_204", name: "Mia R." },
		state: "confirmed",
		cutoffMinutes: 1440,
		billing: held(1),
	},
	{
		id: "bk_6qq",
		service: "Consult 30",
		eventId: "ev_consult_30",
		startsAt: "2026-11-04T10:00",
		endsAt: "2026-11-04T10:30",
		hosts: ["Ravi"],
		member: { key: "m_093", name: "Ana P." },
		state: "confirmed",
		cutoffMinutes: 720,
		billing: { kind: "free" },
	},
	{
		id: "bk_5kd",
		service: "Facial",
		eventId: "ev_facial",
		startsAt: "2026-11-05T18:00",
		endsAt: "2026-11-05T19:00",
		hosts: ["Kim"],
		member: { key: "m_012", name: "Ivy N." },
		state: "confirmed",
		cutoffMinutes: 720,
		billing: held(2),
	},
	{
		id: "bk_rq1",
		service: "Facial",
		eventId: "ev_facial",
		startsAt: "2026-11-07T11:00",
		endsAt: "2026-11-07T12:00",
		hosts: ["Kim"],
		member: { key: "m_088", name: "Lee T." },
		state: "requested",
		cutoffMinutes: 720,
		billing: held(1),
	},
	{
		id: "bk_7hq",
		service: "Massage 90",
		eventId: "ev_massage_90",
		startsAt: "2026-11-08T10:00",
		endsAt: "2026-11-08T11:30",
		hosts: ["Kim"],
		member: { key: "m_117", name: "Jon K." },
		state: "confirmed",
		cutoffMinutes: 1440,
		billing: held(2),
	},
	{
		id: "bk_9ab",
		service: "Massage 90",
		eventId: "ev_massage_90",
		startsAt: "2026-11-10T14:00",
		endsAt: "2026-11-10T15:30",
		hosts: ["Kim"],
		member: { key: "m_093", name: "Ana P." },
		state: "confirmed",
		cutoffMinutes: 1440,
		billing: held(1),
	},
	{
		id: "bk_3cd",
		service: "Group event",
		eventId: "ev_group_event",
		startsAt: "2026-11-12T18:00",
		endsAt: "2026-11-12T19:30",
		hosts: ["Kim", "Ravi"],
		member: { key: "m_088", name: "Lee T." },
		state: "confirmed",
		cutoffMinutes: 720,
		billing: { kind: "paid", amountMinor: 4000, currency: "USD" },
	},
];

const b4Uni: MockupBooking[] = [
	{
		id: "bk_b11",
		service: "Tutoring",
		eventId: "ev_tutoring",
		startsAt: "2026-11-09T16:00",
		endsAt: "2026-11-09T17:00",
		hosts: ["Dr. Lee"],
		member: { key: "s_22", name: "Omar F." },
		state: "confirmed",
		cutoffMinutes: 2880,
		billing: held(1),
	},
	{
		id: "bk_b13",
		service: "Tutoring",
		eventId: "ev_tutoring",
		startsAt: "2026-11-10T16:00",
		endsAt: "2026-11-10T17:00",
		hosts: ["Dr. Lee"],
		member: { key: "s_25", name: "Kai W." },
		state: "confirmed",
		cutoffMinutes: 2880,
		billing: held(1),
	},
	{
		id: "bk_b14",
		service: "Tutoring",
		eventId: "ev_tutoring",
		startsAt: "2026-11-11T15:30",
		endsAt: "2026-11-11T16:30",
		hosts: ["Dr. Lee"],
		member: { key: "s_26", name: "Lia W." },
		state: "confirmed",
		cutoffMinutes: 2880,
		billing: held(1),
	},
	{
		id: "bk_b12",
		service: "Tutoring",
		eventId: "ev_tutoring",
		startsAt: "2026-11-04T15:00",
		endsAt: "2026-11-04T16:00",
		hosts: ["Dr. Lee"],
		member: { key: "s_21", name: "Dana W." },
		state: "confirmed",
		cutoffMinutes: 2880,
		billing: held(2),
	},
];

/** Maple Pilates and Lotus Lane Yoga have no bookings in the mockup. */
export const bookingsBySchool: Record<string, Booking[]> = {
	vol: vibesOfLight.map(toBooking),
	b4u: b4Uni.map(toBooking),
};
