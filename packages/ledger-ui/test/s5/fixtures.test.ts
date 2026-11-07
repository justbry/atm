import { expect, test } from "bun:test";
import {
	audienceOf,
	isPreview,
	maskCode,
	needsPin,
	seesIdentities,
} from "../../src/data/ledger.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";
import { clock } from "./helpers.ts";

const reader = createFixtureReader({ clock });
const november = { from: "2026-11-01", to: "2026-11-30" };
const everything = { type: null, drill: null, promo: null } as const;

test("an event's id is its school and its index in the mockup's table, and its key is its family's", async () => {
	const vol = await reader.ledger({
		school: "vol",
		...november,
		...everything,
	});
	const ids = vol.days.flatMap((day) =>
		day.entries.map(({ event }) => event.id),
	);
	expect(ids).toEqual([
		"vol-e0",
		"vol-e2",
		"vol-e1",
		"vol-e3",
		"vol-e4",
		"vol-e5",
		"vol-e6",
		"vol-e7",
		"vol-e9",
		"vol-e8",
		"vol-e10",
		"vol-e12",
		"vol-e11",
		"vol-e13",
		"vol-e14",
	]);
	const keys = Object.fromEntries(
		vol.days.flatMap((day) =>
			day.entries.map(({ event }) => [event.id, event.key]),
		),
	);
	expect(keys["vol-e0"]).toBe("family:m_093");
	expect(keys["vol-e5"]).toBe("school:vol");
	const b4u = await reader.ledger({
		school: "b4u",
		...november,
		...everything,
	});
	expect(
		b4u.days.flatMap((day) => day.entries.map(({ event }) => event.key)),
	).toEqual([
		"family:fam_wu",
		"family:fam_wu",
		"family:fam_wu",
		"family:fam_wu",
		"family:s_22",
	]);
});

test("an event's UTC instant is its local time in the school's zone, across the autumn clock change", async () => {
	const ledger = (day: string) =>
		reader.ledger({
			school: "vol",
			from: day,
			to: day,
			...everything,
		});
	const november4 = await ledger("2026-11-04");
	expect(november4.days[0]?.entries[0]?.event.event_time).toBe(
		"2026-11-04T23:20:00Z",
	);
	const october15 = await ledger("2026-10-15");
	expect(october15.days[0]?.entries[0]?.event.event_time).toBe(
		"2026-10-15T16:00:00Z",
	);
});

test("a day sums its credits and its money other than payouts, and a filter sums only the rows it keeps", async () => {
	const all = await reader.ledger({
		school: "vol",
		...november,
		...everything,
	});
	const third = all.days.find((day) => day.date === "2026-11-03");
	expect(third).toMatchObject({ count: 4, credits: -2, amountCents: 5000 });
	const credits = await reader.ledger({
		school: "vol",
		...november,
		type: "credit",
		drill: null,
		promo: null,
	});
	expect(credits.count).toBe(8);
	expect(credits.days.find((day) => day.date === "2026-11-04")).toMatchObject({
		count: 3,
		credits: 22,
		amountCents: 0,
	});
});

test("the statement's lines add up, in every school and period", async () => {
	for (const school of ["vol", "b4u", "map", "nw"])
		for (const period of [
			november,
			{ from: "2026-10-01", to: "2026-10-31" },
			{ from: "2026-01-01", to: "2026-11-05" },
		]) {
			const { amounts, counts } = await reader.incomeStatement({
				school,
				...period,
				compare: false,
			});
			const { discounts } = amounts;
			if (discounts === null) throw new Error("the fixtures record discounts");
			expect(amounts.income).toBe(
				amounts.memberships + amounts.bookings + discounts,
			);
			expect(amounts.net).toBe(amounts.income + amounts.refunds + amounts.fees);
			expect(counts.payments).toBeGreaterThanOrEqual(0);
		}
});

test("the sparkline is daily up to 62 days and weekly beyond, and stops at the clock's today", async () => {
	const month = await reader.incomeStatement({
		school: "vol",
		...november,
		compare: false,
	});
	expect(month.income).toMatchObject({ step: "day", through: "2026-11-05" });
	expect(month.income.points).toHaveLength(5);
	expect(month.income.peak).toEqual({
		start: "2026-11-01",
		amountCents: 18_200,
	});
	const year = await reader.incomeStatement({
		school: "vol",
		from: "2026-01-01",
		to: "2026-12-31",
		compare: false,
	});
	expect(year.income.step).toBe("week");
	expect(year.income.through).toBe("2026-11-05");
});

test("compare answers the period of the same length before: months by months, days by days", async () => {
	const months = await reader.incomeStatement({
		school: "vol",
		from: "2026-09-01",
		to: "2026-11-30",
		compare: true,
	});
	expect(months.previous).toMatchObject({
		from: "2026-06-01",
		to: "2026-08-31",
	});
	const days = await reader.incomeStatement({
		school: "vol",
		from: "2026-11-01",
		to: "2026-11-10",
		compare: true,
	});
	expect(days.previous).toMatchObject({ from: "2026-10-22", to: "2026-10-31" });
	const none = await reader.incomeStatement({
		school: "vol",
		...november,
		compare: false,
	});
	expect(none.previous).toBeNull();
});

test("the audience documents publish after their delay and say when", async () => {
	const report = (audience: "public" | "member" | "governance", from: string) =>
		reader.audienceReport({
			school: "b4u",
			audience,
			from,
			to: from,
		});
	const publicReport = await report("public", "2026-06-15");
	expect(publicReport.periodLabel).toBe("2024");
	expect(publicReport.periods.map(({ income }) => income)).toEqual([
		420_000,
		{ hidden: "embargoed", text: "Published after 7 Jan 2027" },
		{ hidden: "embargoed", text: "Published after 7 Jan 2028" },
	]);
	expect(publicReport.rounding).toEqual({ unitCents: 10_000, size: "small" });
	const member = await report("member", "2026-06-15");
	expect(member.periodLabel).toBe("Q2 2026");
	expect(member.periods.at(-1)?.income).toEqual({
		hidden: "embargoed",
		text: "Published after 18 Feb 2027",
	});
	const governance = await report("governance", "2026-10-15");
	expect(governance.periodLabel).toBe("Sep 2026");
	expect(governance.periods.at(-3)?.income).toEqual({
		hidden: "embargoed",
		text: "Published after 7 Nov 2026",
	});
	expect(governance.rounding).toBeNull();
	expect(governance.figures.paidOut).toBe(57_018);
	expect(publicReport.figures.paidOut).toEqual({
		hidden: "no_grant",
		text: "Governance and up see this",
	});
});

test("below Governance a small amount reads under the unit, never 0", async () => {
	const member = await reader.audienceReport({
		school: "b4u",
		audience: "member",
		from: "2026-06-01",
		to: "2026-06-30",
	});
	expect(member.figures.refunds).toEqual({ lt: 10_000 });
	expect(member.figures.fees).toBe(10_000);
});

test("governance sees how gifts spread: cells under five donors are rounded and say why", async () => {
	const spread = await reader.donors({
		school: "b4u",
		audience: "governance",
		year: 2026,
	});
	if (spread.kind !== "spread") throw new Error("expected the spread");
	expect(spread.through).toBe("2026-09");
	expect(spread.donors).toBe(62);
	expect(spread.buckets.map(({ donors }) => donors)).toEqual([
		40,
		20,
		{ lt: 10 },
	]);
	expect(spread.buckets.map(({ why }) => why !== null)).toEqual([
		false,
		true,
		true,
	]);
	expect(spread.medianCents).toBe(4500);
	for (const audience of ["public", "member"] as const)
		expect(
			await reader.donors({ school: "b4u", audience, year: 2026 }),
		).toEqual({ kind: "none" });
});

test("a promo's uses are exact to finance and the owner, <10 to governance from 1 to 4, and hidden below", async () => {
	const uses = async (
		audience: Parameters<typeof reader.promos>[0]["audience"],
	) =>
		(await reader.promos({ school: "vol", audience })).promos.map(
			({ used }) => used,
		);
	expect(await uses("owner")).toEqual([3, 0, 1, 0]);
	expect(await uses("finance")).toEqual([3, 0, 1, 0]);
	expect(await uses("governance")).toEqual([{ lt: 10 }, 0, { lt: 10 }, 0]);
	expect(await uses("member")).toEqual(Array(4).fill({ hidden: "no_grant" }));
});

test("the fixture Writer records every call and answers what it made", async () => {
	const writer = createFixtureWriter({ mode: "instant" });
	const created = await writer.createPromo({
		school: "vol",
		type: "session",
		value: 4,
		expiresOn: "2026-12-31",
		note: "Welcome",
	});
	expect(created).toEqual({
		id: "c_new",
		code: "SESS1000",
		type: "session",
		value: 4,
		used: 0,
		maxUses: 1,
		expiresOn: "2026-12-31",
		status: "active",
	});
	const disabled = await writer.disablePromo({
		school: "vol",
		promoId: "c_01",
	});
	expect(disabled).toMatchObject({ code: "SPRING10", status: "disabled" });
	await expect(
		writer.disablePromo({ school: "vol", promoId: "c_99" }),
	).rejects.toThrow("no promo c_99");
	expect(writer.calls.map(({ method }) => method)).toEqual([
		"createPromo",
		"disablePromo",
		"disablePromo",
	]);
});

test("in hold mode a call stays pending until release", async () => {
	const writer = createFixtureWriter({ mode: "hold" });
	let answered = false;
	const download = writer
		.download({ name: "a.csv", type: "text/csv;charset=utf-8", text: "" })
		.then(() => {
			answered = true;
		});
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(writer.calls).toHaveLength(1);
	expect(answered).toBe(false);
	writer.release();
	await download;
	expect(answered).toBe(true);
});

test("the contract's audience rules: nobody previews above themselves, and only finance and the owner see people", () => {
	expect(audienceOf("owner", "finance_admin")).toBe("finance");
	expect(audienceOf("finance", "owner")).toBe("finance");
	expect(audienceOf("public", "finance_admin")).toBe("public");
	expect(audienceOf("nonsense", "owner")).toBe("owner");
	expect(audienceOf(null, "finance_admin")).toBe("finance");
	expect(isPreview("public", "owner")).toBe(true);
	expect(isPreview("finance", "finance_admin")).toBe(false);
	expect(seesIdentities("governance")).toBe(false);
	expect(needsPin("governance")).toBe(true);
	expect(needsPin("member")).toBe(false);
	expect(maskCode("SPRING10")).toBe("SPR•••10");
	expect(maskCode("UNI15")).toBe("UNI15");
});
