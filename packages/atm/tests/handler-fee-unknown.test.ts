/**
 * A payment booked without its Stripe fee (e2e matrix finding D1), through the real handler. No webhook event carries the
 * fee, so without the caller's `paymentFee` (or when it answers null) the payment is booked at its gross amount, and the
 * fee is never booked later. The books are unchanged by this; what changed is that nothing is silent: the answer lists the
 * payment (`body.feeUnknown`), the handler warns once, `reconcile` counts the payments with `fee_known: false` and `atm
 * report` says so on stderr.
 *
 * The numbers, by hand: the family pays 260.00. Stripe keeps 2.9% + 30 cents = 7.54 + 0.30 = 7.84, so 252.16 reaches
 * `assets:stripe`. Without the fee the books hold 260.00 there; Stripe then pays out 252.16, and 7.84 is left in
 * `assets:stripe` for ever (and net income is 7.84 too high).
 */
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import { reconcile } from "../src/ledger/reconcile.js";
import { formatReconcile } from "../src/ledger/reconcile-files.js";
import { feeUnknownNote, reportMonth } from "../src/ledger/report.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { FolderStore } from "../src/store/folder-store.js";
import type { AtmEvent } from "../src/types.js";
import { stripeBalance } from "./e2e-matrix.js";
import {
	FEE,
	GROSS,
	harness,
	menu,
	paid,
	payout,
	SCHOOL,
	SHIPPED_AT,
	T0,
} from "./handler-harness.js";
import { hasHledger, tmp } from "./helpers.js";

const BIN = join(import.meta.dir, "../src/bin.ts");

/** What Stripe really pays out for the one payment: 260.00 less its fee of 7.84, in cents. */
const NET_PAYOUT = 25_216;

/** A handler whose `warn` is a list, so a test reads what would have gone to stderr. */
const quiet = (fees?: Record<string, number | null>) => {
	const h = harness(fees);
	const warned: string[] = [];
	h.deps.warn = (line) => warned.push(line);
	return { ...h, warned };
};

const payments = (events: AtmEvent[]) =>
	events.filter((event) => event.event_type === "payment.succeeded");

describe("the answer says a payment was booked without its fee", () => {
	test("no paymentFee dependency: 200 applied, the payment listed, one warning that says gross and names the missing dependency", () => {
		const h = quiet();
		const response = h.deliver(paid());
		expect(response.status).toBe(200);
		expect(response.body.outcome).toBe("applied");
		expect(response.body.feeUnknown).toEqual(["in_1 26000 cents"]);
		expect(h.warned).toHaveLength(1);
		expect(h.warned[0]).toContain("evt_in_1");
		expect(h.warned[0]).toContain("in_1 26000 cents");
		expect(h.warned[0]).toContain("gross");
		expect(h.warned[0]).toContain("no paymentFee dependency");
		// the books are as they were: 260.00 in assets:stripe, no fee line, fee_known false
		const [payment] = payments(h.outbox());
		expect(payment?.postings.map((p) => [p.account, p.amount])).toEqual([
			["assets:stripe", "260.00"],
			["income:billing:membership:sparkle-2", "-260.00"],
		]);
		expect(payment?.payload).toMatchObject({ fee: 0, fee_known: false });
	});

	test("a paymentFee that answers null is listed too, and the warning says it did not know the fee", () => {
		const h = quiet({ in_1: null });
		const response = h.deliver(paid());
		expect(response.body.outcome).toBe("applied");
		expect(response.body.feeUnknown).toEqual(["in_1 26000 cents"]);
		expect(h.warned).toHaveLength(1);
		expect(h.warned[0]).toContain("paymentFee did not know the fee");
		expect(h.warned[0]).not.toContain("no paymentFee dependency");
	});

	test("a payment with its fee answers as before: no feeUnknown, no warning, 252.16 / 7.84 / -260.00", () => {
		const h = quiet({ in_1: FEE });
		const response = h.deliver(paid());
		expect(response.body).toEqual({
			outcome: "applied",
			stripeEventId: "evt_in_1",
			events: response.body.events as number,
			wroteRows: true,
		});
		expect("feeUnknown" in response.body).toBe(false);
		expect(h.warned).toEqual([]);
		const [payment] = payments(h.outbox());
		expect(payment?.postings.map((p) => [p.account, p.amount])).toEqual([
			["assets:stripe", "252.16"],
			["expenses:billing:stripe-fees", "7.84"],
			["income:billing:membership:sparkle-2", "-260.00"],
		]);
		expect(payment?.payload).toMatchObject({ fee: 784, fee_known: true });
	});

	test("the same Stripe event again is a duplicate and says nothing more", () => {
		const h = quiet();
		h.deliver(paid());
		const again = h.deliver(paid());
		expect(again.body.outcome).toBe("duplicate");
		expect("feeUnknown" in again.body).toBe(false);
		expect(h.warned).toHaveLength(1);
		expect(payments(h.outbox())).toHaveLength(1);
	});

	test("events that are not a payment (a payout) never say it", () => {
		const h = quiet();
		const response = h.deliver(payout());
		expect(response.body.outcome).toBe("applied");
		expect("feeUnknown" in response.body).toBe(false);
		expect(h.warned).toEqual([]);
	});

	test("a fee that is known on a later delivery is not booked, and that delivery says the payment stays without it", () => {
		// first delivery: the fee is not readable yet
		const fees: Record<string, number | null> = { in_1: null };
		const h = quiet(fees);
		h.deliver(paid());
		// the owner re-sends the invoice under another Stripe event id once the balance transaction is readable
		fees.in_1 = FEE;
		const later = h.deliver({ ...paid(), id: "evt_in_1_resent" }, T0 + 60_000);
		expect(later.body.outcome).toBe("applied");
		expect(later.body.feeUnknown).toEqual([
			"in_1 26000 cents (fee 784 known now, not booked: the first delivery booked the payment without it)",
		]);
		expect(h.warned).toHaveLength(2);
		expect(h.warned[1]).toContain("evt_in_1_resent");
		expect(h.warned[1]).toContain("784");
		// the books keep the first: one payment, no fee, 260.00 in assets:stripe
		const held = payments(h.outbox());
		expect(held).toHaveLength(1);
		expect(held[0]?.postings[0]).toMatchObject({
			account: "assets:stripe",
			amount: "260.00",
		});
		expect(held[0]?.payload).toMatchObject({ fee: 0, fee_known: false });
	});

	test("a re-send of a payment booked with its fee, whatever the new answer, says nothing and keeps the first", () => {
		const fees: Record<string, number | null> = { in_1: FEE };
		const h = quiet(fees);
		h.deliver(paid());
		fees.in_1 = null;
		const later = h.deliver({ ...paid(), id: "evt_in_1_resent" }, T0 + 60_000);
		// this delivery's own event has no fee, but the outbox holds the payment with it
		expect("feeUnknown" in later.body).toBe(false);
		expect(payments(h.outbox())).toHaveLength(1);
		expect(payments(h.outbox())[0]?.payload).toMatchObject({
			fee: 784,
			fee_known: true,
		});
	});

	test("a refused paid invoice (#87) booked gross says so in its 422 note, and the retry that applies lists the payment the refusal booked", () => {
		const withoutTier = {
			...menu,
			tiers: menu.tiers.filter((tier) => tier.id !== "sparkle-2"),
		};
		const warned: string[] = [];
		const h = harness(undefined, { menu: withoutTier });
		h.deps.warn = (line) => warned.push(line);
		const refused = h.deliver(paid());
		expect([refused.status, refused.body.reason]).toEqual([
			422,
			"unmatched_line",
		]);
		expect(refused.body.message).toContain(
			"booked at the gross amount, without a Stripe fee (fee_known false)",
		);
		// the owner lists the tier; Stripe's retry applies and grants the credits, the outbox keeps the refusal's payment
		h.deps.context = harness().deps.context;
		const retry = h.deliver(paid(), T0 + 3_600_000);
		expect(retry.body.outcome).toBe("applied");
		expect(retry.body.feeUnknown).toEqual(["in_1 26000 cents"]);
		expect(payments(h.outbox())).toHaveLength(1);
		expect(warned).toHaveLength(1);
	});

	test("a held outbox row that is not JSON never fails the delivery: it is applied and says nothing about a fee", () => {
		const h = quiet();
		h.raw.run(
			`INSERT INTO ledger_outbox (school_id, id, idem, date, body) VALUES (?, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'stripe:in_1', '2026-01-15', 'seeded')`,
			[SCHOOL],
		);
		const response = h.deliver(paid());
		expect(response.body.outcome).toBe("applied");
		expect("feeUnknown" in response.body).toBe(false);
	});

	test("order does not matter: a payout before its payment books the same two lines, and the payment is still listed", () => {
		const forward = quiet();
		forward.deliver(paid());
		forward.deliver(payout(), T0 + 48 * 3_600_000);
		const backward = quiet();
		backward.deliver(payout(), T0 + 48 * 3_600_000);
		const response = backward.deliver(paid());
		expect(response.body.feeUnknown).toEqual(["in_1 26000 cents"]);
		const idems = (h: ReturnType<typeof quiet>) =>
			h
				.outbox()
				.filter((event) => event.event_type.match(/^(payment|payout)\./))
				.map((event) => event.idem)
				.sort();
		expect(idems(backward)).toEqual(idems(forward));
		expect(idems(forward)).toEqual(["stripe:in_1", "stripe:po_1"]);
	});
});

describe("reconcile counts the payments booked without a fee", () => {
	const shipped = async (h: ReturnType<typeof quiet>) => {
		const root = await tmp("handler-fee-unknown");
		const result = await shipOutbox({
			db: h.db,
			store: new FolderStore({ root }),
			school: SCHOOL,
			nowMs: () => SHIPPED_AT,
		});
		expect(result.conflicts).toEqual([]);
		return root;
	};

	test("one payment without a fee counts 1 and prints it; the fees difference says why", async () => {
		const h = quiet();
		h.deliver(paid());
		const root = await shipped(h);
		try {
			const { events } = await readEvents(root, SCHOOL);
			const result = reconcile({
				events,
				stripe: {
					invoices: [],
					balanceTransactions: [
						stripeBalance(
							"txn_1",
							"charge",
							GROSS,
							FEE,
							"2026-01-15T18:00:30Z",
						),
					],
				},
				period: { month: "2026-01" },
				timeZone: "America/Denver",
			});
			expect(result.feeUnknown).toBe(1);
			const text = formatReconcile(result);
			expect(text).toContain(
				"no fee booked: 1 payment(s) with fee_known false (their fee is not in the log)",
			);
			const fees = result.differences.find(
				(difference) => difference.object === "fees",
			);
			expect(fees?.kind).toBe("not_in_log");
			expect(fees?.message).toContain(
				"1 payment(s) in the log have fee_known false",
			);
			// another month counts none
			const february = reconcile({
				events,
				stripe: { invoices: [] },
				period: { month: "2026-02" },
				timeZone: "America/Denver",
			});
			expect(february.feeUnknown).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a payment with its fee counts 0, prints nothing about it and its fees difference is not touched", async () => {
		const h = quiet({ in_1: FEE });
		h.deliver(paid());
		const root = await shipped(h);
		try {
			const { events } = await readEvents(root, SCHOOL);
			const result = reconcile({
				events,
				stripe: {
					invoices: [],
					balanceTransactions: [
						stripeBalance(
							"txn_1",
							"charge",
							GROSS,
							FEE,
							"2026-01-15T18:00:30Z",
						),
					],
				},
				period: { month: "2026-01" },
				timeZone: "America/Denver",
			});
			expect(result.feeUnknown).toBe(0);
			expect(formatReconcile(result)).not.toContain("no fee booked");
			expect(
				result.differences.filter((difference) => difference.object === "fees"),
			).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an event without fee_known (a log written by hand) is not counted", async () => {
		const h = quiet({ in_1: FEE });
		h.deliver(paid());
		const root = await shipped(h);
		try {
			const { events } = await readEvents(root, SCHOOL);
			const bare = events.map((event) => {
				const { fee_known: _dropped, ...payload } = event.payload;
				return { ...event, payload };
			});
			const result = reconcile({
				events: bare,
				stripe: { invoices: [] },
				period: { month: "2026-01" },
				timeZone: "America/Denver",
			});
			expect(result.feeUnknown).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("the books through hledger and atm report", () => {
	/** One payment without a fee, its payout of what Stripe really sent, shipped. */
	const grossBooks = async () => {
		const h = quiet();
		h.deliver(paid());
		h.deliver(payout({ amount: NET_PAYOUT }), T0 + 48 * 3_600_000);
		const root = await tmp("handler-fee-unknown");
		const result = await shipOutbox({
			db: h.db,
			store: new FolderStore({ root }),
			school: SCHOOL,
			nowMs: () => SHIPPED_AT,
		});
		expect(result.conflicts).toEqual([]);
		return root;
	};

	test.skipIf(!hasHledger)(
		"the journal balances; assets:stripe keeps 7.84 after the payout and net income is 260.00 (the cost of the missing fee), and atm report says so on stderr",
		async () => {
			const root = await grossBooks();
			try {
				const run = await reportMonth({
					root,
					school: SCHOOL,
					month: "2026-01",
					report: "balance-sheet",
					format: "csv",
				});
				expect(run.feeUnknown).toEqual({ inMonth: 1, total: 1 });
				// the next month has none of its own, and still reports the one in all events
				const february = await reportMonth({
					root,
					school: SCHOOL,
					month: "2026-02",
					report: "balance-sheet",
					format: "csv",
				});
				expect(february.feeUnknown).toEqual({ inMonth: 0, total: 1 });
				expect(feeUnknownNote({ ...run, month: "2026-01" })).toBe(
					"atm report: 1 payment(s) in 2026-01 were booked without their Stripe fee (1 in all events); expenses:billing:stripe-fees and net income are off by those fees, and assets:stripe keeps them after a payout\n",
				);
				const books = join(root, "schools", SCHOOL);
				const hledger = (args: string[]): string => {
					const spawned = Bun.spawnSync(
						["hledger", "-f", "main.journal", ...args],
						{ cwd: books, stdout: "pipe", stderr: "pipe" },
					);
					expect(spawned.stderr.toString()).toBe("");
					expect(spawned.exitCode).toBe(0);
					return spawned.stdout.toString();
				};
				hledger(["check", "balanced", "accounts", "commodities"]);
				// 260.00 in, 252.16 paid out: 7.84 left in assets:stripe, as a payment with the fee would not leave
				expect(NET_PAYOUT).toBe(GROSS - FEE);
				expect(hledger(["bal", "assets:stripe", "-N"]).trim()).toContain(
					"7.84 USD  assets:stripe",
				);
				expect(hledger(["bal", "expenses", "-N"]).trim()).toBe("");
				const cli = Bun.spawnSync(
					[
						process.execPath,
						BIN,
						"report",
						"--root",
						root,
						"--school",
						SCHOOL,
						"--month",
						"2026-01",
						"--report",
						"income-statement",
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				expect(cli.exitCode).toBe(0);
				expect(cli.stderr.toString()).toBe(
					feeUnknownNote({ ...run, month: "2026-01" }) as string,
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!hasHledger)(
		"payments with their fee leave stderr empty and a null note",
		async () => {
			const h = quiet({ in_1: FEE });
			h.deliver(paid());
			const root = await tmp("handler-fee-unknown");
			try {
				await shipOutbox({
					db: h.db,
					store: new FolderStore({ root }),
					school: SCHOOL,
					nowMs: () => SHIPPED_AT,
				});
				const run = await reportMonth({
					root,
					school: SCHOOL,
					month: "2026-01",
					report: "income-statement",
				});
				expect(run.feeUnknown).toEqual({ inMonth: 0, total: 0 });
				expect(feeUnknownNote({ ...run, month: "2026-01" })).toBeNull();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
