import { expect, test } from "bun:test";
import type { MemberPortal } from "../../src/data/portal.ts";
import { portalProfiles } from "../../src/fixtures/portal.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";

/** Consistency check C5 (protocol §5): a member-facing document holds no other family's key or amounts. */
const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
const reader = createFixtureReader({ clock });

const documents = await Promise.all(
	portalProfiles.map(async (query) => {
		const portal = await reader.memberPortal(query);
		if (!portal) throw new Error(`no portal for ${query.profileId}`);
		return portal;
	}),
);
const peopleOf = (portal: MemberPortal): Set<string> =>
	new Set(portal.people.map(({ profileId }) => profileId));
const keyOf = (portal: MemberPortal): string => portal.people[0]?.key ?? "";

test("the fixtures serve the people the portal's golden file needs", () => {
	expect(documents.length).toBeGreaterThanOrEqual(9);
	expect(documents.map(({ profileId }) => profileId)).toEqual(
		expect.arrayContaining([
			"s_21",
			"s_25",
			"s_26",
			"s_22",
			"s_27",
			"m_051",
			"m_204",
		]),
	);
});

for (const portal of documents) {
	const label = `${portal.school}/${portal.profileId}`;
	const mine = peopleOf(portal);
	const others = documents.filter(
		(other) => other.school === portal.school && keyOf(other) !== keyOf(portal),
	);

	test(`${label}: every person, booking and history row is the viewed family's`, () => {
		expect(portal.people.length).toBeGreaterThan(0);
		expect(mine.has(portal.profileId)).toBe(true);
		for (const person of portal.people) expect(person.key).toBe(keyOf(portal));
		for (const booking of portal.bookings)
			expect(mine.has(booking.profileId)).toBe(true);
		for (const row of portal.history)
			expect(mine.has(row.profileId)).toBe(true);
		if (portal.scope === "own") expect(portal.people).toHaveLength(1);
	});

	test(`${label}: no other family's key, person, invoice or payment is in it`, () => {
		const serialized = JSON.stringify(portal);
		for (const other of others) {
			expect(serialized).not.toContain(keyOf(other));
			for (const person of other.people.filter(
				({ profileId }) => !mine.has(profileId),
			)) {
				expect(serialized).not.toContain(person.profileId);
				expect(serialized).not.toContain(person.name);
			}
			// Their money is their rows: an id from their history is nowhere in this document.
			for (const row of other.history.filter(
				({ profileId }) => !mine.has(profileId),
			)) {
				expect(serialized).not.toContain(row.invoiceId);
				if (row.paymentId !== "")
					expect(serialized).not.toContain(row.paymentId);
			}
		}
		expect(others.length).toBeGreaterThan(0);
	});

	test(`${label}: the family list is the viewed person's own family`, () => {
		const members = portal.family?.members ?? [];
		if (portal.family) {
			expect(portal.family.familyId).toBe(portal.people[0]?.familyId ?? "");
			expect(keyOf(portal)).toBe(`family:${portal.family.familyId}`);
		}
		if (portal.scope === "family")
			expect(new Set(members.map(({ profileId }) => profileId))).toEqual(mine);
		else
			for (const { profileId } of members)
				expect(documents.some((other) => other.profileId === profileId)).toBe(
					true,
				);
	});
}

test("an adult sees the family's history in full and a learner only their own", async () => {
	const adult = await reader.memberPortal({ school: "b4u", profileId: "s_21" });
	const teen = await reader.memberPortal({ school: "b4u", profileId: "s_25" });
	const kai = adult?.history.filter(({ profileId }) => profileId === "s_25");
	expect(adult?.history).toHaveLength(86);
	expect(teen?.history).toEqual(kai ?? []);
});
