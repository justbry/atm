import { afterEach, expect, test } from "bun:test";
import type { LedgerQuery } from "../../src/data/ledger.ts";
import type { Reader } from "../../src/data/reader.ts";
import type { Writer } from "../../src/data/writer.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";
import {
	cleanUp,
	click,
	clock,
	count,
	element,
	fill,
	open,
	settle,
	text,
} from "./helpers.ts";

afterEach(cleanUp);

/** The fixture Reader, with the Ledger calls it was asked for kept in `queries`. */
const watching = (): { reader: Reader; queries: LedgerQuery[] } => {
	const reader = createFixtureReader({ clock });
	const queries: LedgerQuery[] = [];
	return {
		queries,
		reader: {
			...reader,
			ledger: (query) => {
				queries.push(query);
				return reader.ledger(query);
			},
		},
	};
};

test("the Ledger asks the Reader for the route's period, type, drill-down and promo, and nothing else", async () => {
	const { reader, queries } = watching();
	await open("#/vol/ledger?month=2026-10&type=credit&drill=refund&promo=c_01", {
		reader,
	});
	expect(queries).toEqual([
		{
			school: "vol",
			from: "2026-10-01",
			to: "2026-10-31",
			type: "credit",
			drill: "refund",
			promo: "c_01",
		},
	]);
});

test("an unknown type or drill-down in the route is ignored", async () => {
	const { reader, queries } = watching();
	await open("#/vol/ledger?type=everything&drill=nonsense", { reader });
	expect(queries[0]).toMatchObject({ type: null, drill: null });
	expect(count("[data-test=ledger-filter]")).toBe(0);
	expect(count("[data-test=ledger-type][data-type=all].on")).toBe(1);
});

test("an audience without the grant gets the lock panel and no read", async () => {
	for (const audience of ["public", "member", "governance"]) {
		const { reader, queries } = watching();
		await open(`#/vol/ledger?as=${audience}`, { reader });
		expect(count("[data-test=lock-panel]")).toBe(1);
		expect(queries).toEqual([]);
		cleanUp();
	}
});

test("a finance admin cannot preview the owner: as=owner shows Finance admin", async () => {
	await open("#/b4u/ledger?as=owner&pin=locked");
	expect(text("[data-test=pin-lock]")).toContain(
		"Finance admin opens the books with your family PIN.",
	);
});

test("the PIN prompt unlocks the books once four digits are typed, and the rows come back", async () => {
	const { reader, queries } = watching();
	await open("#/b4u/ledger?month=2026-11&pin=locked", { reader });
	expect(queries).toEqual([]);
	expect(element("[data-test=pin-unlock]").hasAttribute("disabled")).toBe(true);
	await fill("[data-test=pin-input]", "1234");
	await click("[data-test=pin-unlock]");
	expect(window.location.hash).toBe("#/b4u/ledger?month=2026-11");
	expect(count("[data-test=ledger-row]")).toBe(5);
	expect(text("[data-test=toast]")).toBe("Books unlocked for this session.");
});

test("a count of one reads event, not events", async () => {
	await open("#/vol/ledger?type=payout");
	expect(text("[data-test=ledger-count]")).toBe("1 event · America/Denver");
	expect(text("[data-test=ledger-day-label]")).toBe("Tue Nov 3 · 1 event");
});

test("the Details button opens a row's details line and closes it again", async () => {
	await open("#/vol/ledger");
	const button = element("[data-test=ledger-row][data-event=vol-e5] button");
	expect(button.getAttribute("aria-expanded")).toBe("false");
	await click("[data-test=ledger-row][data-event=vol-e5] button");
	expect(text("[data-test=ledger-details]")).toContain(
		"payment.succeeded · source stripe",
	);
	expect(text("[data-test=ledger-details]")).toContain('"kind":"gift"');
	expect(
		element("[data-test=ledger-row][data-event=vol-e5] button").getAttribute(
			"aria-expanded",
		),
	).toBe("true");
	await click("[data-test=ledger-row][data-event=vol-e5] button");
	expect(count("[data-test=ledger-details]")).toBe(0);
});

test("a write the outbox has not shipped is listed first, under Waiting to ship, with a pending badge", async () => {
	const base = createFixtureReader({ clock });
	const reader: Reader = {
		...base,
		ledger: async (query) => {
			const page = await base.ledger(query);
			const first = page.days[0]?.entries[0];
			if (!first) throw new Error("no rows");
			return {
				...page,
				pending: [{ ...first, pending: true }],
				days: page.days.map((day, index) => ({
					...day,
					entries: index === 0 ? day.entries.slice(1) : day.entries,
				})),
			};
		},
	};
	const writer = createFixtureWriter({ mode: "instant" });
	await open("#/vol/ledger", { reader, writer });
	expect(text("[data-test=ledger-pending]")).toBe(
		"Waiting to ship (1) · each ships within 5 min",
	);
	expect(
		text("[data-test=ledger-row][data-event=vol-e0] [data-test=ledger-time]"),
	).toBe("just now");
	expect(
		text("[data-test=ledger-row][data-event=vol-e0] [data-test=ledger-event]"),
	).toBe("Sessions held pending");
	expect(element("[data-test=ledger-row]").getAttribute("data-event")).toBe(
		"vol-e0",
	);
	await click("[data-test=ledger-csv]");
	const [call] = writer.calls;
	const lines = (call?.args[0] as { text: string }).text.split("\r\n");
	expect(lines[1]).toContain(",Pending,");
	expect(lines[1]).toContain("Held for Massage 90");
});

test("a download that fails says so and offers the button again", async () => {
	const base = createFixtureWriter({ mode: "instant" });
	const writer: Writer = {
		...base,
		download: () => Promise.reject(new Error("blocked")),
	};
	await open("#/vol/ledger", { writer });
	await click("[data-test=ledger-csv]");
	expect(text("[data-test=toast]")).toBe("Could not save the file. Try again.");
	expect(element("[data-test=ledger-csv]").hasAttribute("disabled")).toBe(
		false,
	);
});

test("the Ledger does not claim the file is saved until the Writer answers", async () => {
	const writer = createFixtureWriter({ mode: "hold" });
	await open("#/vol/ledger", { writer });
	element("[data-test=ledger-csv]").click();
	await settle();
	expect(element("[data-test=ledger-csv]").getAttribute("aria-busy")).toBe(
		"true",
	);
	expect(text("[data-test=toast]")).toBe("");
	writer.release();
	await settle();
	expect(text("[data-test=toast]")).toBe("Downloaded 15 rows");
});
