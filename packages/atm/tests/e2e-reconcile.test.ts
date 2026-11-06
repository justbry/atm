/**
 * The end-to-end reconciliation matrix. Each case in `e2e-cases.ts` delivers Stripe events to the reference handler and
 * follows the money three ways:
 *
 *   1. the handler's outbox -> `atm ship` -> `atm journal` / `atm report` (hledger) -> the numbers in the reports;
 *   2. `atm reconcile` of the shipped log against a Stripe side written by hand from Stripe's documented shapes;
 *   3. the numbers written by hand in the case.
 *
 * It also checks that hledger passes `check balanced accounts commodities`, that every credit commodity sums to zero over the
 * book, and that the credit balances of the replayed log are the credit register's. The reports, the registers, the
 * decisions and the reconcile output of each case are committed under `golden/e2e/<case>/`; `UPDATE_GOLDEN=1` rewrites them.
 * A DISCREPANCY (or KNOWN) case asserts what the code does today and that it differs from the hand number.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatReconcile } from "../src/ledger/reconcile-files.js";
import { CASES } from "./e2e-cases.js";
import {
	type BookRun,
	type Case,
	differenceLine,
	dollars,
	eventsCsv,
	type Numbers,
	runCase,
	stripeBalanceOf,
	stripeFeesOf,
	stripeInvoice,
} from "./e2e-matrix.js";
import { RECORDED_CASES } from "./e2e-recorded-cases.js";
import { hasHledger } from "./helpers.js";

const ALL_CASES = [...CASES, ...RECORDED_CASES];
const GOLDEN = join(import.meta.dir, "golden/e2e");
const INCOME = "income:";
const CREDIT_PREFIXES = ["avail:", "held:"];
const MATRIX_HEADER =
	"case,school,verdict,hand_income,report_income,hand_refunds,report_refunds,hand_disputes,report_disputes,hand_fees,report_fees,hand_dispute_fees,report_dispute_fees,hand_stripe,report_stripe,hand_clearing,report_clearing,hand_net,report_net,reconcile";

const sumIncome = (numbers: Numbers): number =>
	Object.entries(numbers)
		.filter(([name]) => name.startsWith(INCOME))
		.reduce((total, [, cents]) => total + cents, 0);

const golden = async (dir: string, name: string, text: string) => {
	const path = join(dir, name);
	if (process.env.UPDATE_GOLDEN) {
		if (text === "") await rm(path, { force: true });
		else {
			await mkdir(dir, { recursive: true });
			await writeFile(path, text);
		}
	}
	// a register with nothing in it has no golden file
	if (text === "")
		expect(await Bun.file(path).exists(), `${name} exists`).toBe(false);
	else expect(text, name).toBe(await Bun.file(path).text());
};

/** The month names a book reconciles, in order. */
const months = (book: Case["books"][number]): string[] =>
	Object.keys(book.reconcile).sort();

const expectReport = (
	label: string,
	report: Numbers,
	hand: Numbers,
	pinned: Numbers,
) => {
	const names = new Set([
		...Object.keys(report),
		...Object.keys(hand),
		...Object.keys(pinned),
	]);
	for (const name of names) {
		const expected =
			name in pinned ? (pinned[name] as number) : (hand[name] ?? 0);
		expect(report[name] ?? 0, `${label}: ${name}`).toBe(expected);
	}
	for (const [name, cents] of Object.entries(pinned))
		expect(
			cents,
			`${label}: the pinned ${name} is the hand number, so it is no discrepancy`,
		).not.toBe(hand[name] ?? 0);
};

const expectBook = async (c: Case, index: number, got: BookRun) => {
	const book = c.books[index] as Case["books"][number];
	const label = `${c.id}/${book.school}`;
	const { hand, pinned = {} } = book;

	// (3) the hand numbers against the reports hledger printed from the handler's log
	expectReport(label, got.report, hand, pinned);

	// a book that crosses a month: each month's column of the income statement is the hand number for that month
	if (book.monthly) {
		expect(Object.keys(book.handMonthly ?? {}), `${label}: months`).toEqual(
			Object.keys(got.monthly),
		);
		for (const [month, expected] of Object.entries(book.handMonthly ?? {}))
			expectReport(`${label} ${month}`, got.monthly[month] ?? {}, expected, {});
	}

	// the reports agree with each other, whatever the hand says: net = revenue - refunds - disputes - fees, and the cash is the net
	const { report } = got;
	expect(report.net ?? 0, `${label}: net income`).toBe(
		sumIncome(report) -
			(report.refunds ?? 0) -
			(report.disputes ?? 0) -
			(report.fees ?? 0) -
			(report.disputeFees ?? 0),
	);
	expect((report.stripe ?? 0) + (report.clearing ?? 0), `${label}: cash`).toBe(
		report.net ?? 0,
	);

	// the oracle is consistent with itself: Stripe's own records add up to the hand numbers
	const strayBalance = book.foreign?.balance ?? 0;
	const strayFees = book.foreign?.fees ?? 0;
	expect(
		stripeBalanceOf(book.stripe) - strayBalance,
		`${label}: Stripe's balance`,
	).toBe(hand.stripe ?? 0);
	expect(stripeFeesOf(book.stripe) - strayFees, `${label}: Stripe's fees`).toBe(
		(hand.fees ?? 0) + (hand.disputeFees ?? 0),
	);
	expect(
		(book.stripe.refunds ?? []).reduce(
			(total, refund) => total + refund.amount,
			0,
		),
		`${label}: Stripe's refunds`,
	).toBe(hand.refunds ?? 0);

	// an erased family's personal data is in no shipped file and no journal
	expect(got.leaks, `${label}: files holding personal data`).toEqual([]);

	// every credit commodity sums to zero over the book
	for (const [commodity, units] of Object.entries(got.creditSums))
		expect(units, `${label}: ${commodity} over the credit accounts`).toBe(0n);

	// the replayed log's credit balances are the credit register's
	const creditNames = new Set(
		[...Object.keys(report), ...Object.keys(got.replayed)].filter((name) =>
			CREDIT_PREFIXES.some((prefix) => name.startsWith(prefix)),
		),
	);
	for (const name of creditNames)
		expect(got.replayed[name] ?? 0, `${label}: replayed ${name}`).toBe(
			report[name] ?? 0,
		);

	// (2) reconcile against Stripe's side
	for (const month of months(book))
		expect(
			(got.reconciled[month]?.differences ?? []).map(differenceLine),
			`${label}: reconcile ${month}`,
		).toEqual(book.reconcile[month] as string[]);

	// the markers for money the books do not hold: reconcile's count is the hand number
	for (const month of months(book))
		expect(
			got.reconciled[month]?.skipped ?? {},
			`${label}: skipped in ${month}`,
		).toEqual(book.skipped?.[month] ?? {});

	// the goldens: the handler's decisions, the reports, the registers and the reconcile text
	const dir =
		index === 0 ? join(GOLDEN, c.id) : join(GOLDEN, c.id, book.school);
	await golden(dir, "events.csv", eventsCsv(got.events));
	await golden(
		dir,
		"income-statement.csv",
		got.files["income-statement"] ?? "",
	);
	await golden(dir, "balance-sheet.csv", got.files["balance-sheet"] ?? "");
	await golden(dir, "credits.csv", got.files.credits ?? "");
	await golden(
		dir,
		"refunds-register.csv",
		registerText(got.files["refunds-register"]),
	);
	await golden(
		dir,
		"disputes-register.csv",
		registerText(got.files["disputes-register"]),
	);
	if (book.monthly) {
		await golden(
			dir,
			"income-statement-monthly.csv",
			got.files["income-statement-monthly"] ?? "",
		);
		await golden(
			dir,
			"balance-sheet-monthly.csv",
			got.files["balance-sheet-monthly"] ?? "",
		);
	}
	await golden(
		dir,
		"reconcile.txt",
		months(book)
			.map((month) => formatReconcile(got.reconciled[month] as never))
			.join("\n"),
	);
};

/** hledger prints a register with nothing in it as nothing, or as its header line alone. */
const registerText = (csv: string | undefined): string =>
	(csv ?? "").trim().split("\n").length <= 1 ? "" : (csv as string);

const matrixRow = (c: Case, index: number, got: BookRun): string => {
	const book = c.books[index] as Case["books"][number];
	const { hand } = book;
	const { report } = got;
	const differences = months(book).reduce(
		(total, month) => total + (got.reconciled[month]?.differences.length ?? 0),
		0,
	);
	// the differences the log's own `money.skipped` count explains
	const skipped = Object.values(book.skipped ?? {}).reduce(
		(total, reasons) =>
			total + Object.values(reasons).reduce((sum, n) => sum + n, 0),
		0,
	);
	const explained = skipped > 0 ? ` (${skipped} skipped)` : "";
	return [
		c.id,
		book.school,
		c.verdict,
		dollars(sumIncome(hand)),
		dollars(sumIncome(report)),
		dollars(hand.refunds ?? 0),
		dollars(report.refunds ?? 0),
		dollars(hand.disputes ?? 0),
		dollars(report.disputes ?? 0),
		dollars(hand.fees ?? 0),
		dollars(report.fees ?? 0),
		dollars(hand.disputeFees ?? 0),
		dollars(report.disputeFees ?? 0),
		dollars(hand.stripe ?? 0),
		dollars(report.stripe ?? 0),
		dollars(hand.clearing ?? 0),
		dollars(report.clearing ?? 0),
		dollars(hand.net ?? 0),
		dollars(report.net ?? 0),
		differences === 0
			? "clean"
			: `${differences} difference${differences === 1 ? "" : "s"}${explained}`,
	].join(",");
};

/**
 * Controls for the oracle: a clean case with one thing in Stripe's side moved by hand, and the one difference `atm reconcile`
 * must then print. The matrix's clean cases cannot notice reconcile ceasing to compare an invoice's or a payout's amount,
 * a dispute's outcome or an invoice's date (only a case that expects a difference sees a comparison break), so these do.
 */
const controlled = (
	id: string,
	move: (
		stripe: Case["books"][number]["stripe"],
	) => Case["books"][number]["stripe"],
): Case => {
	const found = ALL_CASES.find((c) => c.id === id) as Case;
	const [book] = found.books as [Case["books"][number]];
	return { ...found, books: [{ ...book, stripe: move(book.stripe) }] };
};

const controlDifferences = async (c: Case): Promise<string[]> => {
	const run = await runCase(c);
	return (run.books[0]?.reconciled["2026-01"]?.differences ?? []).map(
		differenceLine,
	);
};

describe.skipIf(!hasHledger)("reconcile controls", () => {
	test("an invoice and a payout that Stripe has for other amounts are amount_differs", async () => {
		// the books have 260.00 paid and 252.16 paid out; Stripe says 250.00 and 250.00 (its balance transactions are untouched)
		const c = controlled("payout-with-fees", (stripe) => ({
			...stripe,
			invoices: (stripe.invoices ?? []).map((invoice) => ({
				...invoice,
				amount_paid: 25_000,
			})),
			payouts: (stripe.payouts ?? []).map((payout) => ({
				...payout,
				amount: 25_000,
			})),
		}));
		expect(await controlDifferences(c)).toEqual([
			"amount_differs invoice in_1",
			"amount_differs payout po_1",
		]);
	});

	test("a dispute Stripe says was won, that the books lost, is outcome_differs", async () => {
		const c = controlled("dispute-lost", (stripe) => ({
			...stripe,
			disputes: (stripe.disputes ?? []).map((dispute) => ({
				...dispute,
				status: "won",
			})),
		}));
		expect(await controlDifferences(c)).toEqual([
			"outcome_differs dispute dp_1",
		]);
	});

	test("an invoice Stripe dates in February, that the books date 15 January, is period_differs", async () => {
		const c = controlled("create", (stripe) => ({
			...stripe,
			invoices: [stripeInvoice("in_1", 26_000, "2026-02-20T18:00:00Z")],
		}));
		expect(await controlDifferences(c)).toEqual([
			"period_differs invoice in_1",
		]);
	});
});

describe.skipIf(!hasHledger)("the end-to-end reconciliation matrix", () => {
	const rows = new Map<string, string[]>();

	for (const c of ALL_CASES) {
		test(`${c.id}: ${c.title}`, async () => {
			const run = await runCase(c);
			const delivered = c.steps.flatMap((step) =>
				step.kind === "erase" ? [] : [step.answer],
			);
			expect(run.answers).toEqual(delivered);
			// a delivery answered `non_usd` warns once, a case that passes no fee warns once per payment (D1: `fee_unknown`),
			// and nothing else does
			const nonUsd = delivered.filter(
				([, outcome]) => outcome === "non_usd",
			).length;
			expect(
				run.warnings.filter((line) => !line.includes("fee_unknown")),
			).toHaveLength(nonUsd);
			expect(
				run.warnings.filter((line) => line.includes("fee_unknown")),
			).toHaveLength(c.id === "fee-unknown" ? 1 : 0);
			expect(run.books).toHaveLength(c.books.length);
			const caseRows: string[] = [];
			for (const [index, got] of run.books.entries()) {
				await expectBook(c, index, got);
				caseRows.push(matrixRow(c, index, got));
			}
			rows.set(c.id, caseRows);

			// the verdict is what the case pins, not what the author says
			const pinnedAny = c.books.some(
				(book) => Object.keys(book.pinned ?? {}).length > 0,
			);
			// differences the log's own `skipped` count explains are by design, not a discrepancy
			const differs = c.books.some(
				(book) =>
					book.skipped === undefined &&
					Object.values(book.reconcile).some((lines) => lines.length > 0),
			);
			if (c.verdict === "OK") {
				expect(
					pinnedAny || differs,
					`${c.id} is OK but pins a difference`,
				).toBe(false);
				expect(c.discrepancies ?? []).toEqual([]);
			} else {
				expect(
					pinnedAny || differs,
					`${c.id} is ${c.verdict} but pins nothing`,
				).toBe(true);
				expect(
					(c.discrepancies ?? []).length,
					`${c.id} names no discrepancy`,
				).toBeGreaterThan(0);
			}
		});
	}

	test("matrix.csv is every case's hand numbers beside the reports'", async () => {
		// a run of one case with -t leaves the others out: the matrix is checked only when every case ran
		if (rows.size !== ALL_CASES.length) return;
		const text = `${[MATRIX_HEADER, ...ALL_CASES.flatMap((c) => rows.get(c.id) ?? [])].join("\n")}\n`;
		await golden(GOLDEN, "matrix.csv", text);
	});
});
