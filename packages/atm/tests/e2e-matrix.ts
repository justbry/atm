/**
 * The runner behind `e2e-reconcile.test.ts`: one case (a list of Stripe deliveries to the reference handler) goes through
 * the handler, the outbox, `atm ship`, `atm journal` / `atm report` (hledger) and `atm reconcile`, and comes back as the
 * numbers each layer shows. Nothing here knows what the right answer is: the hand numbers and the Stripe side live in
 * the case, written by hand, so a bug in the handler cannot move the oracle with it.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import type { Menu } from "../src/billing/types.js";
import { journalMonth, readEvents } from "../src/ledger/files.js";
import { appendToOutbox } from "../src/ledger/outbox.js";
import { ledgerEvent } from "../src/ledger/postings.js";
import { reconcile } from "../src/ledger/reconcile.js";
import { reconcileFolder } from "../src/ledger/reconcile-files.js";
import { replayEvents } from "../src/ledger/replay.js";
import { reportMonth } from "../src/ledger/report.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { decimalToUnits } from "../src/ledger/util.js";
import { FolderStore } from "../src/store/folder-store.js";
import type {
	AtmEvent,
	ReconcileResult,
	ReconcileStripe,
	StripeBalanceTransactionRecord,
	StripeDisputeRecord,
	StripeInvoiceRecord,
	StripePayoutRecord,
	StripeRefundRecord,
} from "../src/types.js";
import {
	menu as baseMenu,
	type FeeLookup,
	harness,
	SHIPPED_AT,
} from "./handler-harness.js";
import { readTree, tmp } from "./helpers.js";
import type { RawEvent } from "./stripe-events.js";

const MS_PER_SECOND = 1000;
const CENTS = 2;
const CENTS_PER_DOLLAR = 100;

// ---- The case ----

/** What the handler answered: the HTTP status, the outcome, and the refusal's reason when there is one. */
export type Answer = [status: number, outcome: string, reason?: string];

export type Step =
	| {
			kind?: "deliver";
			/** The clock of the delivery (ms); the event carries its own `created`. */
			at: number;
			event: RawEvent;
			/** The endpoint that receives it (a school's own); default the case's first school. */
			school?: string;
			answer: Answer;
			/** The caller's fee lookup throws for this delivery (Stripe answers 5xx and retries). */
			feeFails?: boolean;
	  }
	| {
			/** The family service records an erasure after the payments: `subject.erased`, naming the payment objects. */
			kind: "erase";
			at: number;
			school?: string;
			family: string;
	  };

/**
 * Cents (USD) or credit units, by name:
 *   `income:<kind>`          revenue of `income:billing:<kind>`, positive (hledger's sign)
 *   `refunds`, `disputes`    money handed back / lost, positive
 *   `fees`                   Stripe's fees as an expense
 *   `stripe`, `clearing`     assets:stripe and assets:clearing:stripe-payouts
 *   `net`                    net income (= the balance sheet's net, as the books are cash basis)
 *   `avail:<holder>:<feature>`, `held:<holder>:<feature>`  credit balances
 * A name left out is zero.
 */
export type Numbers = Record<string, number>;

export type Book = {
	school: string;
	/** Written by hand, in the test body: what the school's books must say. */
	hand: Numbers;
	/** Today's behaviour where it differs from `hand`: asserted exactly, and must differ from `hand` (it is a discrepancy). */
	pinned?: Numbers;
	/** Stripe's own records, written by hand from its documented shapes. */
	stripe: ReconcileStripe;
	/** Expected reconcile differences per month ("kind object id"); a month listed here is reconciled. */
	reconcile: Record<string, string[]>;
	/** Also print the monthly income statement (a case that crosses a month). */
	monthly?: boolean;
	/** With `monthly`: what each month column of the income statement must say, by hand (`income:<kind>`, `refunds`, `fees`). */
	handMonthly?: Record<string, Numbers>;
	/** What Stripe's lists hold that is not this school's (another product's invoice on a shared account). */
	foreign?: { balance: number; fees: number };
};

export type Verdict = "OK" | "KNOWN" | "DISCREPANCY";

export type Case = {
	id: string;
	title: string;
	/** Which handler path it walks (the matrix doc's column). */
	path: string;
	menu?: Menu;
	/** The caller's fee lookup: by invoice id; left out, the endpoint has no `paymentFee` at all. */
	fees?: Record<string, number | null>;
	steps: Step[];
	books: Book[];
	/** Strings no shipped file or journal may hold (a parent's name and email). */
	personal?: string[];
	/** The environment the events were made in (the recorded deliveries are sandbox events: `test`); default `live`. */
	env?: "test" | "live";
	/** Stripe price ids by lookup key, when the events carry ids the generated ones do not (the recorded deliveries). */
	priceIds?: Record<string, string>;
	verdict: Verdict;
	/** The ids of the matrix doc's discrepancies this case pins (empty for OK). */
	discrepancies?: string[];
};

// ---- Stripe's side, by hand ----

const seconds = (iso: string): number => Date.parse(iso) / MS_PER_SECOND;

export const stripeInvoice = (
	id: string,
	cents: number,
	paidAt: string,
	currency = "usd",
): StripeInvoiceRecord => ({
	id,
	status: "paid",
	amount_paid: cents,
	currency,
	created: seconds(paidAt) - 60,
	livemode: true,
	status_transitions: { paid_at: seconds(paidAt) },
});

export const stripeRefund = (
	id: string,
	cents: number,
	at: string,
	invoiceId: string,
	/** The refunded charge and its payment intent, when they are not the ones the synthetic events give an invoice. */
	refs: { charge: string; intent: string } = {
		charge: `ch_${invoiceId}`,
		intent: `pi_${invoiceId}`,
	},
): StripeRefundRecord => ({
	id,
	amount: cents,
	currency: "usd",
	charge: refs.charge,
	payment_intent: refs.intent,
	created: seconds(at),
	status: "succeeded",
});

export const stripePayout = (
	id: string,
	cents: number,
	at: string,
	status = "paid",
	currency = "usd",
): StripePayoutRecord => ({
	id,
	amount: cents,
	currency,
	created: seconds(at),
	status,
	livemode: true,
});

export const stripeDispute = (
	id: string,
	cents: number,
	at: string,
	status: string,
): StripeDisputeRecord => ({
	id,
	amount: cents,
	currency: "usd",
	created: seconds(at),
	status,
	livemode: true,
});

/** A balance transaction: `amount` is signed (a charge positive, a refund negative), `fee` what Stripe kept, `net` = amount - fee. */
export const stripeBalance = (
	id: string,
	type: string,
	amount: number,
	fee: number,
	at: string,
	currency = "usd",
): StripeBalanceTransactionRecord => ({
	id,
	type,
	amount,
	fee,
	net: amount - fee,
	currency,
	created: seconds(at),
});

/** What is left in Stripe's balance once every transaction is counted: the sum of `net` (a case keeps to one currency). */
export const stripeBalanceOf = (stripe: ReconcileStripe): number =>
	(stripe.balanceTransactions ?? []).reduce(
		(total, transaction) => total + transaction.net,
		0,
	);

/** The fees Stripe kept, net of any it gave back. */
export const stripeFeesOf = (stripe: ReconcileStripe): number =>
	(stripe.balanceTransactions ?? []).reduce(
		(total, transaction) => total + transaction.fee,
		0,
	);

// ---- Running a case ----

export type BookRun = {
	school: string;
	events: AtmEvent[];
	/** Everything `Numbers` names, read from the hledger reports `atm report` prints. */
	report: Numbers;
	/** The monthly income statement per month column, when the book asked for it. */
	monthly: Record<string, Numbers>;
	/** The credit balances the replayed events give, in the same names. */
	replayed: Numbers;
	/** Credit units per commodity over the whole book (must be zero). */
	creditSums: Record<string, bigint>;
	/** The reports and registers as hledger printed them, by golden file name. */
	files: Record<string, string>;
	reconciled: Record<string, ReconcileResult>;
	/** The files of the school (events, journals) that hold one of the case's `personal` strings. */
	leaks: string[];
};

export type CaseRun = {
	answers: Answer[];
	books: BookRun[];
};

const cellsOf = (line: string): string[] =>
	[...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] as string);

/** One amount cell ("1,234.56 USD", "2 VISIT", "-1 RETREAT, 3 VISIT" or "0") as units per commodity. */
const AMOUNT = /^-?[\d,]+(\.\d+)? [A-Z]+(, -?[\d,]+(\.\d+)? [A-Z]+)*$/;

const amountsOf = (cell: string): Map<string, bigint> => {
	const out = new Map<string, bigint>();
	// a heading, a column title or a zero: no amount
	if (!AMOUNT.test(cell)) return out;
	for (const part of cell.split(", ")) {
		const [number, commodity] = part.split(" ") as [string, string];
		const places = commodity === "USD" ? CENTS : 0;
		out.set(
			commodity,
			(out.get(commodity) ?? 0n) +
				decimalToUnits(number.replace(/,/g, ""), places),
		);
	}
	return out;
};

/** A CSV report's rows as label -> units per commodity; a label that repeats (a commodity per line) adds up. */
export const rowsOf = (csv: string): Map<string, Map<string, bigint>> => {
	const out = new Map<string, Map<string, bigint>>();
	const seenTotals = new Set<string>();
	for (const line of csv.trim().split("\n")) {
		const [label, cell] = cellsOf(line);
		if (label === undefined || cell === undefined) continue;
		// "Total:" and the section headings repeat; the first of each label is the one wanted
		if (label.endsWith(":") && seenTotals.has(label)) continue;
		if (label.endsWith(":")) seenTotals.add(label);
		const row = out.get(label) ?? new Map<string, bigint>();
		for (const [commodity, units] of amountsOf(cell))
			row.set(commodity, (row.get(commodity) ?? 0n) + units);
		out.set(label, row);
	}
	return out;
};

const usd = (rows: Map<string, Map<string, bigint>>, label: string): number =>
	Number(rows.get(label)?.get("USD") ?? 0n);

const hledger = (books: string, args: string[]): string => {
	const run = Bun.spawnSync(["hledger", "-f", "main.journal", ...args], {
		cwd: books,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (run.stderr.toString() !== "" || run.exitCode !== 0)
		throw new Error(
			`hledger ${args.join(" ")} failed (${run.exitCode}): ${run.stderr.toString()}`,
		);
	return run.stdout.toString();
};

const INCOME_PREFIX = "income:billing:";
const REFUNDS = "income:billing:refunds";

/** The report numbers in `Numbers` names, from `atm report`'s three reports and nothing else. */
const readReports = (reports: Record<string, string>): Numbers => {
	const statement = rowsOf(reports["income-statement"] as string);
	const sheet = rowsOf(reports["balance-sheet"] as string);
	const credits = rowsOf(reports.credits as string);
	const numbers: Numbers = {};
	for (const label of statement.keys()) {
		if (!label.startsWith(INCOME_PREFIX) || label === REFUNDS) continue;
		numbers[`income:${label.slice(INCOME_PREFIX.length)}`] = usd(
			statement,
			label,
		);
	}
	// hledger shows a refund (a debit to income) as a negative revenue
	numbers.refunds = 0 - usd(statement, REFUNDS);
	numbers.disputes = usd(statement, "expenses:billing:disputes");
	numbers.fees = usd(statement, "expenses:billing:stripe-fees");
	numbers.net = usd(statement, "Net:");
	numbers.stripe = usd(sheet, "assets:stripe");
	numbers.clearing = usd(sheet, "assets:clearing:stripe-payouts");
	for (const [label, row] of credits) {
		const match = /^credits:(avail|held):(.+)$/.exec(label);
		if (match)
			numbers[`${match[1]}:${match[2]}`] = Number(
				row.values().next().value ?? 0n,
			);
	}
	return numbers;
};

/**
 * The monthly income statement (`is -M`) as numbers per month column ("Jan", "Feb"): `income:<kind>`, `refunds`,
 * `disputes` and `fees`, in the same names and signs as `readReports`.
 */
const monthlyNumbers = (csv: string): Record<string, Numbers> => {
	const lines = csv.trim().split("\n").map(cellsOf);
	const header = lines.find((cells) => cells[0] === "Account");
	if (!header) throw new Error("the monthly income statement has no header");
	const out: Record<string, Numbers> = {};
	for (const [column, month] of header.slice(1).entries()) {
		const numbers: Numbers = {};
		for (const cells of lines) {
			const label = cells[0] ?? "";
			const cents = Number(amountsOf(cells[column + 1] ?? "").get("USD") ?? 0n);
			if (label === REFUNDS) numbers.refunds = 0 - cents;
			else if (label.startsWith(INCOME_PREFIX))
				numbers[`income:${label.slice(INCOME_PREFIX.length)}`] = cents;
			else if (label === "expenses:billing:stripe-fees") numbers.fees = cents;
			else if (label === "expenses:billing:disputes") numbers.disputes = cents;
		}
		out[month] = numbers;
	}
	return out;
};

const csvQuote = (text: string) => `"${text.replace(/"/g, '""')}"`;

/** The handler's decisions in a line each: the date, the type, the idem and the postings. */
export const eventsCsv = (events: readonly AtmEvent[]): string =>
	`${[
		"date,event_type,idem,postings",
		...events.map((event) =>
			[
				event.date,
				event.event_type,
				event.idem,
				csvQuote(
					event.postings
						.map((p) => `${p.account} ${p.amount} ${p.commodity}`)
						.join(" | "),
				),
			].join(","),
		),
	].join("\n")}\n`;

const replayedBalances = (
	events: readonly AtmEvent[],
	menu: Menu,
	school: string,
	env?: "test" | "live",
): Numbers => {
	const out: Numbers = {};
	const { balances } = replayEvents({
		events,
		catalog: menuCatalogRows({ menu, school, ...(env ? { env } : {}) }),
	});
	for (const balance of balances) {
		const name = `${balance.holder}:${balance.feature}`;
		if (balance.avail !== 0) out[`avail:${name}`] = balance.avail;
		if (balance.held !== 0) out[`held:${name}`] = balance.held;
	}
	return out;
};

const journalAll = async (
	root: string,
	school: string,
	events: readonly AtmEvent[],
	monthly: boolean,
): Promise<Record<string, string>> => {
	const months = [
		...new Set(events.map((event) => event.date.slice(0, 7))),
	].sort();
	for (const month of months.slice(0, -1))
		await journalMonth({ root, school, month });
	// `atm report` for the last month builds its journal, and every earlier one was built above
	const run = await reportMonth({
		root,
		school,
		month: months.at(-1) as string,
		report: "all",
		format: "csv",
	});
	const files: Record<string, string> = {};
	for (const report of run.reports) files[report.report] = report.text;
	const books = join(root, "schools", school);
	// the balance and the account declarations must pass hledger's own checks
	hledger(books, ["check", "balanced", "accounts", "commodities"]);
	files["refunds-register"] = hledger(books, ["reg", REFUNDS, "-O", "csv"]);
	files["disputes-register"] = hledger(books, [
		"reg",
		"expenses:billing:disputes",
		"-O",
		"csv",
	]);
	if (monthly) {
		files["income-statement-monthly"] = hledger(books, [
			"is",
			"-M",
			"-O",
			"csv",
		]);
		files["balance-sheet-monthly"] = hledger(books, ["bs", "-M", "-O", "csv"]);
	}
	return files;
};

const writeStripeFolder = async (
	folder: string,
	stripe: ReconcileStripe,
): Promise<void> => {
	await mkdir(folder, { recursive: true });
	const names = {
		invoices: "invoices.json",
		refunds: "refunds.json",
		disputes: "disputes.json",
		payouts: "payouts.json",
		balanceTransactions: "balance_transactions.json",
	} as const;
	for (const [list, file] of Object.entries(names))
		await writeFile(
			join(folder, file),
			JSON.stringify(stripe[list as keyof ReconcileStripe] ?? []),
		);
};

/** Runs the case end to end in a temporary folder; the folder is removed whatever happens. */
export const runCase = async (c: Case): Promise<CaseRun> => {
	const menu = c.menu ?? baseMenu;
	const failing = { fee: false };
	const fees = c.fees;
	const lookup: FeeLookup | undefined = fees
		? (invoiceId) => {
				if (failing.fee) throw new Error("the fee lookup failed");
				return fees[invoiceId];
			}
		: undefined;
	const schools = [...new Set(c.books.map((book) => book.school))];
	const endpoints = new Map(
		schools.map((school) => [
			school,
			harness(lookup, { school, menu, env: c.env, priceIds: c.priceIds }),
		]),
	);
	const endpoint = (school: string | undefined) => {
		const found = endpoints.get(school ?? (schools[0] as string));
		if (!found) throw new Error(`the case has no endpoint for ${school}`);
		return found;
	};
	const answers: Answer[] = [];
	for (const step of c.steps) {
		const served = endpoint(step.school);
		if (step.kind === "erase") {
			const own = served
				.outbox()
				.filter(
					(event) =>
						event.key === `family:${step.family}` &&
						event.event_type.startsWith("payment."),
				);
			appendToOutbox(served.db, [
				ledgerEvent({
					type: "subject.erased",
					school: step.school ?? (schools[0] as string),
					tz: menu.timeZone,
					eventTime: step.at,
					key: `family:${step.family}`,
					idem: `erase:${step.family}`,
					payload: { objects: own.map((event) => `event:${event.id}`) },
				}),
			]);
			continue;
		}
		failing.fee = step.feeFails === true;
		let answer: Answer;
		try {
			const { status, body } = served.deliver(step.event, step.at);
			answer = body.reason
				? [status, body.outcome, body.reason]
				: [status, body.outcome];
		} catch {
			// the handler lets an error out: the caller answers 500 and Stripe retries
			answer = [500, "threw"];
		}
		failing.fee = false;
		answers.push(answer);
	}

	const root = await tmp("e2e-matrix");
	try {
		const store = new FolderStore({ root });
		for (const [school, served] of endpoints) {
			const shipped = await shipOutbox({
				db: served.db,
				store,
				school,
				nowMs: () => SHIPPED_AT,
			});
			if (shipped.conflicts.length > 0)
				throw new Error(`ship conflicts: ${JSON.stringify(shipped.conflicts)}`);
		}
		const books: BookRun[] = [];
		for (const book of c.books) {
			const { events } = await readEvents(root, book.school);
			const folder = join(root, `stripe-${book.school}`);
			await writeStripeFolder(folder, book.stripe);
			const reconciled: Record<string, ReconcileResult> = {};
			if (events.length === 0) {
				// nothing was booked, so there is no folder to journal or read: the books are empty and Stripe's side is not
				for (const month of Object.keys(book.reconcile))
					reconciled[month] = reconcile({
						events,
						stripe: book.stripe,
						period: { month },
						timeZone: menu.timeZone,
					});
				books.push({
					leaks: [],
					school: book.school,
					events,
					report: {},
					monthly: {},
					replayed: {},
					creditSums: {},
					files: {},
					reconciled,
				});
				continue;
			}
			const files = await journalAll(
				root,
				book.school,
				events,
				book.monthly === true,
			);
			const sums: Record<string, bigint> = {};
			for (const [label, row] of rowsOf(files.credits as string)) {
				if (!label.startsWith("credits:")) continue;
				for (const [commodity, units] of row)
					sums[commodity] = (sums[commodity] ?? 0n) + units;
			}
			for (const month of Object.keys(book.reconcile))
				reconciled[month] = await reconcileFolder({
					root,
					school: book.school,
					period: { month },
					stripeDirectory: folder,
				});
			const tree = await readTree(join(root, "schools", book.school));
			const leaks = Object.entries(tree)
				.filter(([, text]) =>
					(c.personal ?? []).some((needle) => text.includes(needle)),
				)
				.map(([path]) => path);
			books.push({
				leaks,
				school: book.school,
				events,
				report: readReports(files),
				monthly: files["income-statement-monthly"]
					? monthlyNumbers(files["income-statement-monthly"])
					: {},
				replayed: replayedBalances(events, menu, book.school, c.env),
				creditSums: sums,
				files,
				reconciled,
			});
		}
		return { answers, books };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};

/** A reconcile difference as one comparable line: the kind, the object and the Stripe id (or `-` for a total). */
export const differenceLine = (
	difference: ReconcileResult["differences"][number],
): string => `${difference.kind} ${difference.object} ${difference.id ?? "-"}`;

export const dollars = (cents: number): string =>
	`${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / CENTS_PER_DOLLAR)}.${String(Math.abs(cents) % CENTS_PER_DOLLAR).padStart(2, "0")}`;
