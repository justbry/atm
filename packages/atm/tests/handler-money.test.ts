/**
 * The reference handler's books: a fee supplied with an `invoice.paid`, a refund, and Stripe's `payout.paid`, through the
 * real handler, the outbox, the folder shipper, `journalMonth` and hledger's income statement and balance sheet.
 */
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { signStripePayload } from "../src/handler/stripe-signature.js";
import { handleStripeWebhook } from "../src/handler/stripe-webhook.js";
import { journalMonth } from "../src/ledger/files.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { FolderStore } from "../src/store/folder-store.js";
import type { AtmEvent } from "../src/types.js";
import {
	FEE,
	GROSS,
	HOUR,
	harness,
	linked,
	PAYOUT,
	paid,
	payout,
	REFUNDED,
	refund,
	SCHOOL,
	SECRET,
	SHIPPED_AT,
	T0,
} from "./handler-harness.js";
import { hasHledger, tmp } from "./helpers.js";

const ofType = (events: AtmEvent[], type: string) =>
	events.filter((e) => e.event_type === type);

describe("the fee of a payment", () => {
	test("a fee the caller supplies is booked: gross, fee, and the net in assets:stripe", () => {
		const { deliver, outbox, asked } = harness({ in_1: FEE });
		expect(deliver(paid()).body.outcome).toBe("applied");
		const [payment] = ofType(outbox(), "payment.succeeded");
		expect(payment?.postings).toEqual([
			{ account: "assets:stripe", amount: "252.16", commodity: "USD" },
			{
				account: "expenses:billing:stripe-fees",
				amount: "7.84",
				commodity: "USD",
			},
			{
				account: "income:billing:membership:sparkle-2",
				amount: "-260.00",
				commodity: "USD",
			},
		]);
		expect(payment?.payload).toMatchObject({ fee: FEE, fee_known: true });
		expect(asked).toEqual(["in_1"]);
	});

	test("without the dependency the payment books its gross and no fee line, and says the fee was not known", () => {
		const { deliver, outbox } = harness();
		expect(deliver(paid()).body.outcome).toBe("applied");
		const [payment] = ofType(outbox(), "payment.succeeded");
		expect(payment?.postings.map((p) => p.account)).toEqual([
			"assets:stripe",
			"income:billing:membership:sparkle-2",
		]);
		expect(payment?.postings[0]?.amount).toBe("260.00");
		expect(payment?.payload).toMatchObject({ fee: 0, fee_known: false });
	});

	test("a fee the dependency does not know yet books no fee, and the fee is not booked by a later delivery", () => {
		const fees: Record<string, number | null> = { in_1: null };
		const { deliver, outbox } = harness(fees);
		expect(deliver(paid()).body.outcome).toBe("applied");
		fees.in_1 = FEE;
		// the owner re-sends the event from the dashboard once the fee is known: the claim is done
		expect(deliver(paid()).body.outcome).toBe("duplicate");
		const payments = ofType(outbox(), "payment.succeeded");
		expect(payments).toHaveLength(1);
		expect(payments[0]?.payload).toMatchObject({ fee: 0, fee_known: false });
	});

	test("a fee that is not a whole number of cents up to what was paid is refused 422, nothing written, the claim released", () => {
		for (const fee of [1.5, -1, GROSS + 1]) {
			const { deliver, outbox, claim } = harness({ in_1: fee });
			const response = deliver(paid());
			expect([fee, response.status, response.body.reason]).toEqual([
				fee,
				422,
				"bad_event",
			]);
			expect(outbox()).toEqual([]);
			expect(claim("evt_in_1")).toBeNull();
		}
	});

	test("the dependency is asked for an invoice.paid and for nothing else", () => {
		const { deliver, asked } = harness({ in_1: FEE });
		deliver(paid());
		deliver(linked("in_1"));
		deliver(refund(REFUNDED));
		deliver(payout());
		expect(asked).toEqual(["in_1"]);
	});
});

describe("Stripe's payout.paid", () => {
	test("is booked once from assets:stripe to the payout clearing account, and a duplicate delivery changes nothing", () => {
		const { deliver, outbox, claim } = harness();
		const first = deliver(payout());
		expect(first.status).toBe(200);
		expect(first.body).toMatchObject({
			outcome: "applied",
			events: 1,
			wroteRows: false,
		});
		const [booked] = outbox();
		expect(booked?.event_type).toBe("payout.paid");
		expect(booked?.postings).toEqual([
			{ account: "assets:stripe", amount: "-202.16", commodity: "USD" },
			{
				account: "assets:clearing:stripe-payouts",
				amount: "202.16",
				commodity: "USD",
			},
		]);
		expect(booked?.school).toBe(SCHOOL);
		expect(claim("evt_po_1")?.state).toBe("done");

		expect(deliver(payout()).body.outcome).toBe("duplicate");
		expect(outbox()).toHaveLength(1);
	});

	test("the same payout under another Stripe event id is still booked once", () => {
		const { deliver, outbox } = harness();
		deliver(payout());
		const again = deliver(payout({ eventId: "evt_po_1_resent" }));
		expect(again.body.outcome).toBe("applied");
		expect(outbox()).toHaveLength(1);
	});

	test("two payouts are two lines; a payout in another currency is answered non_usd with no line (tests/handler-non-usd.test.ts)", () => {
		const { deliver, outbox, deps } = harness();
		deps.warn = () => undefined;
		deliver(payout());
		deliver(payout({ eventId: "evt_po_2", payoutId: "po_2", amount: 100 }));
		expect(outbox().map((e) => e.idem)).toEqual(["stripe:po_1", "stripe:po_2"]);
		const euros = deliver(
			payout({ eventId: "evt_po_3", payoutId: "po_3", currency: "eur" }),
		);
		expect(euros.body).toMatchObject({ outcome: "non_usd", events: 1 });
		expect(outbox().map((e) => e.event_type)).toEqual([
			"payout.paid",
			"payout.paid",
			"money.skipped",
		]);
	});

	test("a test-mode payout to a live endpoint is refused before any claim, and an unknown school releases its claim", () => {
		const { deliver, outbox, claim, deps } = harness();
		const testMode = payout();
		testMode.livemode = false;
		const refused = deliver(testMode);
		expect([refused.status, refused.body.outcome]).toEqual([
			422,
			"livemode_mismatch",
		]);
		expect(claim("evt_po_1")).toBeNull();

		const unknown = { ...deps, context: () => null };
		const payload = JSON.stringify(payout());
		const response = handleStripeWebhook(unknown, {
			payload,
			signatureHeader: signStripePayload({
				payload,
				secret: SECRET,
				timestampSeconds: Math.floor(T0 / 1000),
			}),
		});
		expect([response.status, response.body.outcome]).toEqual([
			422,
			"unknown_school",
		]);
		expect(outbox()).toEqual([]);
		expect(claim("evt_po_1")).toBeNull();
	});

	test("the other payout events are not mapped: answered ignored, nothing recorded (payout.failed is: tests/handler-payout-failed.test.ts)", () => {
		const { deliver, outbox, claim } = harness();
		for (const type of [
			"payout.created",
			"payout.canceled",
			"payout.reconciliation_completed",
		]) {
			const event = payout();
			event.type = type;
			expect(deliver(event).body.outcome).toBe("ignored");
		}
		expect(outbox()).toEqual([]);
		expect(claim("evt_po_1")).toBeNull();
	});

	test("a payout with an amount of nothing is refused, not booked", () => {
		const { deliver, outbox } = harness();
		const response = deliver(payout({ amount: 0 }));
		expect([response.status, response.body.reason]).toEqual([422, "bad_event"]);
		expect(outbox()).toEqual([]);
	});
});

describe("the handler's log through hledger", () => {
	/** The cents in a one-line `"account","12.34 USD"` CSV row, 0 when hledger left the account out (a zero balance). */
	const cents = (csv: string, account: string): bigint => {
		const row = csv
			.split("\n")
			.find((line) => line.startsWith(`"${account}",`));
		if (!row) return 0n;
		const [, amount] = [...row.matchAll(/"([^"]*)"/g)].map((m) => m[1]) as [
			string,
			string,
		];
		return BigInt(amount.replace(/[ ,]USD$/, "").replace(/[.,]/g, ""));
	};

	test.skipIf(!hasHledger)(
		"a payment with its fee, a partial refund and a payout: is and bs show the fee expense and the cash moved to the payout clearing account",
		async () => {
			const { db, deliver } = harness({ in_1: FEE });
			expect(deliver(paid()).body.outcome).toBe("applied");
			expect(deliver(linked("in_1"), T0 + 1000).body.outcome).toBe("applied");
			expect(deliver(refund(REFUNDED), T0 + HOUR).body.outcome).toBe("applied");
			expect(deliver(payout(), T0 + 48 * HOUR).body.outcome).toBe("applied");

			const root = await tmp("handler-money");
			try {
				const shipped = await shipOutbox({
					db,
					store: new FolderStore({ root }),
					school: SCHOOL,
					nowMs: () => SHIPPED_AT,
				});
				expect(shipped.conflicts).toEqual([]);
				await journalMonth({ root, school: SCHOOL, month: "2026-01" });
				const books = join(root, "schools", SCHOOL);
				const hledger = (args: string[]): string => {
					const run = Bun.spawnSync(
						["hledger", "-f", "main.journal", ...args],
						{
							cwd: books,
							stdout: "pipe",
							stderr: "pipe",
						},
					);
					expect(run.stderr.toString()).toBe("");
					expect(run.exitCode).toBe(0);
					return run.stdout.toString();
				};
				hledger(["check", "balanced", "accounts", "commodities"]);

				// hledger shows income as a positive number and a refund (a debit to income) as a negative one
				const statement = hledger(["is", "-O", "csv"]);
				expect(cents(statement, "income:billing:membership:sparkle-2")).toBe(
					BigInt(GROSS),
				);
				expect(cents(statement, "income:billing:refunds")).toBe(
					BigInt(-REFUNDED),
				);
				expect(cents(statement, "expenses:billing:stripe-fees")).toBe(
					BigInt(FEE),
				);
				// net income: 260.00 - 50.00 - 7.84
				expect(cents(statement, "Net:")).toBe(BigInt(GROSS - REFUNDED - FEE));

				const sheet = hledger(["bs", "-O", "csv"]);
				expect(cents(sheet, "assets:clearing:stripe-payouts")).toBe(
					BigInt(PAYOUT),
				);
				// Stripe's balance is empty: every cent that came in was refunded, kept as a fee or paid out
				expect(cents(sheet, "assets:stripe")).toBe(0n);
				expect(cents(sheet, "Net:")).toBe(BigInt(GROSS - REFUNDED - FEE));
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
