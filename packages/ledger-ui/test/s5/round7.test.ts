import { afterEach, expect, test } from "bun:test";
import type { KpiDocument } from "../../src/data/kpi-document.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { cleanUp, clock, count, open, text } from "./helpers.ts";

afterEach(cleanUp);

const reader = createFixtureReader({ clock });
const bookingsLockBody = "[data-test=lock-body]";

// ---- Round 7: the Ledger lock names what each audience sees (mockup `bkBlocked`)

test("the Ledger lock for an admin without the finance grant points to Members, not to Reports", async () => {
	await open("#/vol/ledger?as=admin");
	expect(text(bookingsLockBody)).toBe(
		"This lists who paid what: one row per person with amounts, refunds and member ids. Admins without the finance grant see the roster, balances and bookings in Members. Every identified read is audited.",
	);
	cleanUp();
	await open("#/vol/ledger?as=public");
	expect(text(bookingsLockBody)).toContain(
		"Public sees totals in Reports and the Dashboard.",
	);
	expect(text(bookingsLockBody)).not.toContain("Admins without");
	cleanUp();
	await open("#/vol/ledger?as=governance");
	expect(text(bookingsLockBody)).toContain(
		"Governance sees totals in Reports and the Dashboard.",
	);
});

// ---- Round 7: Reports reads the same cells as the Dashboard

const documentFor = async (
	school: string,
	audience: "public" | "member" | "governance",
): Promise<KpiDocument> => {
	const found = await reader.kpiDocument({
		school,
		preset: "monthly-members",
		audience,
		pinLocked: false,
	});
	if (!found) throw new Error(`no ${audience} document for ${school}`);
	return found;
};

test("Public Reports at Vibes of Light says <10 payments and — for the money, as its Dashboard does", async () => {
	await open("#/vol/reports?as=public");
	expect(text("[data-test=report-status]")).toContain(
		"Public document · 2024: <10 payments",
	);
	expect(text("[data-line=income] [data-test=report-line-amount]")).toBe("—");
	expect(count("[data-line=memberships] .kcutv")).toBe(1);
	expect(text("[data-test=report-period].kon b")).toBe("—");
	const dashboard = await documentFor("vol", "public");
	expect(dashboard.tables.year?.series.gross_collected?.[0]).toEqual({
		hidden: "suppressed",
		text: "Hidden: fewer than 5 payers",
	});
});

test("every audience's Reports figures are the cells of its KPI document at the period shown", async () => {
	const audiences = ["public", "member", "governance"] as const;
	for (const school of ["vol", "b4u", "har"])
		for (const audience of audiences) {
			const document = await documentFor(school, audience);
			const report = await reader.audienceReport({
				school,
				audience,
				from: "2026-06-15",
				to: "2026-06-15",
			});
			const table = document.tables[document.grain];
			const shown = document.periods.find(
				({ label }) => label === report.periodLabel,
			);
			expect(shown?.state).toBe("shown");
			const index = table?.periods.indexOf(shown?.period ?? "") ?? -1;
			const cell = (kpi: string) => table?.series[kpi]?.[index];
			expect(report.payments).toEqual(cell("payments_count") ?? 0);
			expect(report.figures.income).toEqual(cell("gross_collected") ?? 0);
			expect(report.figures.refunds).toEqual(cell("refunds") ?? 0);
			expect(report.figures.fees).toEqual(cell("stripe_fees") ?? 0);
			expect(report.figures.net).toEqual(cell("net_income") ?? 0);
			expect(report.figures.paidOut).toEqual(cell("payouts") ?? 0);
			expect(report.rounding?.unitCents ?? 0).toBe(document.roundTo);
		}
});

test("a Reports period that is still inside its delay says when it publishes, with the clock", async () => {
	await open("#/vol/reports?as=public");
	const waiting = document.querySelectorAll(
		"[data-test=report-period].kwait [data-hid=embargoed]",
	);
	expect(waiting.length).toBe(2);
	expect(waiting[0]?.textContent).toBe("Published after 7 Jan 2027");
});
