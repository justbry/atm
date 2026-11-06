import { afterEach, expect, test } from "bun:test";
import { cleanUp, click, count, open, settle } from "../s5/helpers.ts";

afterEach(cleanUp);

const attention = (personId: string): string =>
	`[data-test=member-row][data-id=${personId}] [data-test=attention-badge]`;
const go = async (hash: string): Promise<void> => {
	window.location.hash = hash;
	await settle();
};

test("an outcome recorded on Bookings clears that member's attention reason on Members", async () => {
	await open("#/vol/members");
	expect(count(attention("m_093"))).toBeGreaterThan(0);
	await go("#/vol/bookings?range=day");
	await click("[data-test=booking-bulk][data-day=overdue]");
	await go("#/vol/members");
	expect(count(attention("m_093"))).toBe(0);
});

test("a school's pending bookings are its own: another school's Members are untouched", async () => {
	await open("#/vol/bookings?range=day");
	await click("[data-test=booking-bulk][data-day=overdue]");
	await go("#/b4u/members");
	expect(count("[data-test=member-row]")).toBeGreaterThan(0);
	await go("#/vol/members");
	expect(count(attention("m_093"))).toBe(0);
});
