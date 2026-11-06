/** `ledgerRows`: the ledger tab's rows from events, newest first, paged by a stable cursor, with no personal field. */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import {
	type LedgerRow,
	type LedgerRowFilter,
	ledgerRows,
} from "../src/ledger/ledger-rows.js";
import { ledgerEvent } from "../src/ledger/postings.js";
import type { AtmEvent } from "../src/types.js";
import { handBuiltLog } from "./ledger-read-log.js";

const ROOT = join(import.meta.dir, "../fixtures/vibes-year");
const TZ = "America/Denver";
const WHOLE_YEAR: LedgerRowFilter = { from: "2000-01-01", to: "2100-01-01" };

const allPages = (
	events: readonly AtmEvent[],
	filter: LedgerRowFilter,
	limit: number,
): LedgerRow[] => {
	const rows: LedgerRow[] = [];
	let cursor: string | null = null;
	for (let pages = 0; pages < 10_000; pages += 1) {
		const page = ledgerRows(events, filter, cursor, limit);
		rows.push(...page.rows);
		if (page.next === null) return rows;
		cursor = page.next;
	}
	throw new Error("the cursor never ended");
};

const idsOf = (rows: readonly LedgerRow[]) => rows.map((row) => row.event.id);

const { events } = await readEvents(ROOT, "sch_vol");

describe("ledgerRows on the golden year", () => {
	test("the log is not empty", () => {
		expect(events.length).toBeGreaterThan(50);
	});

	test("every event of the range is a row, once, newest first", () => {
		const page = ledgerRows(events, WHOLE_YEAR, null, 1000);
		const all = allPages(events, WHOLE_YEAR, 1000);
		expect(page.count).toBe(events.length);
		expect(all.length).toBe(events.length);
		expect(new Set(idsOf(all)).size).toBe(events.length);
		const orders = all.map((row) => `${row.localTime}|${row.event.id}`);
		expect(orders).toEqual([...orders].sort().reverse());
	});

	test("paging by any size lists the same rows in the same order", () => {
		const whole = idsOf(allPages(events, WHOLE_YEAR, 1000));
		for (const limit of [1, 7, 100, 333])
			expect(
				idsOf(allPages(events, WHOLE_YEAR, limit)),
				`limit ${limit}`,
			).toEqual(whole);
	});

	test("a page ends with a cursor, and the last page with null", () => {
		const first = ledgerRows(events, WHOLE_YEAR, null, 10);
		expect(first.rows.length).toBe(10);
		expect(first.next).not.toBeNull();
		const last = ledgerRows(events, WHOLE_YEAR, null, 1000);
		expect(last.next === null).toBe(events.length <= 1000);
	});

	test("the cursor is stable: events added after the first page do not move the next one", () => {
		const first = ledgerRows(events, WHOLE_YEAR, null, 10);
		const later = ledgerEvent({
			type: "payment.succeeded",
			school: "sch_vol",
			tz: TZ,
			eventTime: "2030-01-01T00:00:00Z",
			key: "family:fam_new",
			idem: "newer",
			amount: 100,
			incomeKind: "booking",
		});
		const older = ledgerEvent({
			type: "payment.succeeded",
			school: "sch_vol",
			tz: TZ,
			eventTime: "2001-01-01T00:00:00Z",
			key: "family:fam_old",
			idem: "older",
			amount: 100,
			incomeKind: "booking",
		});
		const before = ledgerRows(events, WHOLE_YEAR, first.next, 10);
		const after = ledgerRows(
			[...events, later, older],
			WHOLE_YEAR,
			first.next,
			10,
		);
		expect(idsOf(after.rows)).toEqual(idsOf(before.rows));
		expect(after.count).toBe(events.length + 2);
	});

	test("the date range is by the school's local day, inclusive", () => {
		const day = events[40]?.date as string;
		const rows = allPages(events, { from: day, to: day }, 1000);
		expect(rows.length).toBe(events.filter((e) => e.date === day).length);
		for (const row of rows) expect(row.event.date).toBe(day);
		expect(
			allPages(events, { from: "2100-01-01", to: "2100-01-02" }, 10),
		).toEqual([]);
	});

	test("type chips", () => {
		const byType = (type: LedgerRowFilter["type"]) =>
			allPages(events, { ...WHOLE_YEAR, type }, 1000);
		for (const row of byType("payment"))
			expect(row.event.event_type.startsWith("payment")).toBe(true);
		for (const row of byType("credit"))
			expect(row.event.event_type.startsWith("credit")).toBe(true);
		for (const row of byType("payout"))
			expect(row.event.event_type.startsWith("payout")).toBe(true);
		for (const row of byType("booking"))
			expect(row.event.labels.booking).toBeDefined();
		expect(byType("payment").length).toBeGreaterThan(0);
		expect(byType("credit").length).toBeGreaterThan(0);
		expect(byType("payout").length).toBeGreaterThan(0);
		expect(byType("admin")).toEqual([]);
		expect(byType("code")).toEqual([]);
	});

	test("drill-downs: income, memberships, refunds, fees, payouts", () => {
		const drill = (d: LedgerRowFilter["drill"]) =>
			allPages(events, { ...WHOLE_YEAR, drill: d }, 1000);
		const sales = events.filter((e) => e.event_type === "payment.succeeded");
		expect(drill("income").length).toBe(sales.length);
		expect(drill("fees").length).toBe(sales.length);
		expect(drill("memb").length).toBe(sales.length);
		expect(drill("book")).toEqual([]);
		expect(drill("gift")).toEqual([]);
		expect(drill("disc")).toEqual([]);
		expect(drill("refund").length).toBe(
			events.filter((e) => e.event_type === "payment.refunded").length,
		);
		expect(drill("payout").length).toBe(
			events.filter((e) => e.event_type === "payout.paid").length,
		);
	});

	test("money and credits are signed, and a row about no member has no holder", () => {
		const rows = allPages(events, WHOLE_YEAR, 1000);
		const payment = rows.find(
			(r) => r.event.event_type === "payment.succeeded",
		);
		expect(payment?.amountCents).toBeGreaterThan(0);
		expect(payment?.holderKey).toMatch(/^family:/);
		expect(payment?.paymentId).not.toBeNull();
		const refund = rows.find((r) => r.event.event_type === "payment.refunded");
		expect(refund?.amountCents).toBeLessThan(0);
		const payout = rows.find((r) => r.event.event_type === "payout.paid");
		expect(payout?.amountCents).toBeGreaterThan(0);
		expect(payout?.holderKey).toBeNull();
		const granted = rows.find((r) => r.event.event_type === "credit.granted");
		expect(granted?.credits).toBeGreaterThan(0);
		const held = rows.find((r) => r.event.event_type === "credit.held");
		expect(held?.credits).toBeLessThan(0);
		const spent = rows.find((r) => r.event.event_type === "credit.spent");
		expect(spent?.credits).toBeLessThan(0);
		const expired = rows.find((r) => r.event.event_type === "credit.expired");
		expect(expired?.credits ?? -1).toBeLessThan(0);
	});

	test("no row carries a billing field, an email or a name", () => {
		const rows = allPages(events, WHOLE_YEAR, 1000);
		const personal = events.flatMap((e) =>
			[e.payload.billing_email, e.payload.billing_name].filter(
				(value): value is string => typeof value === "string",
			),
		);
		expect(personal.length).toBeGreaterThan(0);
		const text = JSON.stringify(rows);
		for (const value of personal) expect(text).not.toContain(value);
		expect(text).not.toContain("billing_");
		for (const row of rows) expect("redacted" in row.event).toBe(false);
	});
});

describe("ledgerRows on small logs", () => {
	test("localTime is the school's wall time, across a daylight saving change", () => {
		const at = (iso: string) =>
			ledgerRows(
				[
					ledgerEvent({
						type: "payment.succeeded",
						school: "s",
						tz: TZ,
						eventTime: iso,
						key: "family:f",
						idem: iso,
						amount: 100,
						incomeKind: "booking",
					}),
				],
				WHOLE_YEAR,
			).rows[0]?.localTime;
		expect(at("2026-01-10T18:00:00Z")).toBe("2026-01-10T11:00");
		expect(at("2026-07-10T18:00:00Z")).toBe("2026-07-10T12:00");
		expect(at("2026-03-08T08:59:00Z")).toBe("2026-03-08T01:59");
		expect(at("2026-03-08T09:00:00Z")).toBe("2026-03-08T03:00");
	});

	test("promo, booking, and the code label filters", () => {
		const events = [
			ledgerEvent({
				type: "payment.succeeded",
				school: "s",
				tz: TZ,
				eventTime: "2026-02-01T18:00:00Z",
				key: "family:a",
				idem: "a",
				amount: 5000,
				incomeKind: "booking",
				labels: { booking: "bk_1", code: "c_01" },
			}),
			ledgerEvent({
				type: "payment.succeeded",
				school: "s",
				tz: TZ,
				eventTime: "2026-02-02T18:00:00Z",
				key: "family:b",
				idem: "b",
				amount: 6500,
				incomeKind: "membership:glow",
				labels: { code: "c_02" },
			}),
		];
		const f = (extra: Partial<LedgerRowFilter>) =>
			ledgerRows(events, { ...WHOLE_YEAR, ...extra }).rows;
		expect(f({ promo: "c_01" }).map((r) => r.event.idem)).toEqual(["a"]);
		expect(f({ type: "code" }).length).toBe(2);
		expect(f({ type: "booking" }).map((r) => r.event.idem)).toEqual(["a"]);
		expect(f({ drill: "book" }).map((r) => r.event.idem)).toEqual(["a"]);
		expect(f({ drill: "memb" }).map((r) => r.event.idem)).toEqual(["b"]);
		expect(f({})[0]?.promoId).toBe("c_02");
	});

	test("credits of a hand-built log: a grant adds, a hold takes off, a spend and a refund", () => {
		const { events } = handBuiltLog();
		const rows = ledgerRows(events, WHOLE_YEAR, null, 1000).rows;
		const by = (type: string) =>
			rows.filter((r) => r.event.event_type === type).map((r) => r.credits);
		expect(by("credit.granted")[0]).toBeGreaterThan(0);
		expect(by("credit.held").every((c) => c !== null && c < 0)).toBe(true);
		expect(by("credit.spent").every((c) => c !== null && c < 0)).toBe(true);
		expect(by("credit.refunded").every((c) => c !== null && c > 0)).toBe(true);
	});

	test("a bad cursor, limit or range is refused", () => {
		const events: AtmEvent[] = [];
		expect(() => ledgerRows(events, WHOLE_YEAR, "nonsense")).toThrow(/cursor/);
		expect(() => ledgerRows(events, WHOLE_YEAR, null, 0)).toThrow(/limit/);
		expect(() => ledgerRows(events, WHOLE_YEAR, null, 1001)).toThrow(/limit/);
		expect(() => ledgerRows(events, WHOLE_YEAR, null, 1.5)).toThrow(/limit/);
	});
});
