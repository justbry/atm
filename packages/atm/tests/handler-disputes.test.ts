/**
 * A dispute's money lines through the real handler: what Stripe withdraws when a dispute opens (the disputed amount and
 * its dispute fee, both read from the dispute's own `balance_transactions`), what comes back when it is won (the amount,
 * not the fee), and that a redelivery or an out-of-order delivery books the fee once. Every number is worked out here
 * by hand, in cents, from the recorded `dispute-lost` and `dispute-won` events (26,000 disputed, a 1,500 fee, 27,500
 * withdrawn) and the 260.00 invoice with its 7.84 fee that `handler-harness` pays.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { mappingFor, normalize } from "../src/billing/normalize.js";
import { journalMonth, readEvents } from "../src/ledger/files.js";
import { reconcile } from "../src/ledger/reconcile.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { decimalToUnits } from "../src/ledger/util.js";
import { FolderStore } from "../src/store/folder-store.js";
import type {
	AtmEvent,
	BillingDispute,
	ReconcileStripe,
} from "../src/types.js";
import {
	FEE,
	GROSS,
	HOUR,
	harness,
	linked,
	paid,
	SCHOOL,
	SHIPPED_AT,
	T0,
} from "./handler-harness.js";
import { hasHledger, tmp } from "./helpers.js";
import { disputeEvent, type RawEvent } from "./stripe-events.js";

/** What Stripe charges when a card dispute opens (the recorded events: `fee_details` "Dispute fee", 1500). */
const DISPUTE_FEE = 1500;
/** The disputed amount is the whole payment, as in the recorded events (26,000). */
const DISPUTED = GROSS;
/** Stripe withdraws the amount and the fee together: the recorded balance transaction has `net` -27,500. */
const WITHDRAWN = DISPUTED + DISPUTE_FEE;
const OPENED = T0 + 2 * HOUR;
const CLOSED = T0 + 20 * HOUR;

const opened = (over: Partial<Parameters<typeof disputeEvent>[0]> = {}) =>
	disputeEvent({
		type: "charge.dispute.created",
		eventId: "evt_dp_created",
		disputeId: "du_1",
		chargeId: "ch_in_1",
		invoiceId: "in_1",
		status: "needs_response",
		at: OPENED,
		withdrawal: { fee: DISPUTE_FEE },
		...over,
	});

const closed = (
	status: "won" | "lost",
	over: Partial<Parameters<typeof disputeEvent>[0]> = {},
) =>
	disputeEvent({
		type: "charge.dispute.closed",
		eventId: `evt_dp_${status}`,
		disputeId: "du_1",
		chargeId: "ch_in_1",
		invoiceId: "in_1",
		status,
		at: CLOSED,
		openedAt: OPENED,
		withdrawal: { fee: DISPUTE_FEE },
		reversed: status === "won",
		...over,
	});

/** A paid and linked invoice, so a dispute on its charge finds the family. */
const started = () => {
	const h = harness({ in_1: FEE });
	expect(h.deliver(paid()).body.outcome).toBe("applied");
	expect(h.deliver(linked("in_1"), T0 + 1000).body.outcome).toBe("applied");
	return h;
};

const ofType = (events: AtmEvent[], type: string) =>
	events.filter((event) => event.event_type === type);

/** The cents posted to `account` by all the events, signed. */
const posted = (events: AtmEvent[], account: string): number =>
	events
		.flatMap((event) => event.postings)
		.filter((posting) => posting.account === account)
		.reduce(
			(total, posting) => total + Number(decimalToUnits(posting.amount, 2)),
			0,
		);

const lines = (event: AtmEvent | undefined) =>
	event?.postings.map((p) => `${p.account} ${p.amount} ${p.commodity}`);

/** What the mapping reads out of the recorded Stripe events (test mode, `fixtures/billing/stripe/recorded`). */
describe("the recorded dispute events carry the fee", () => {
	const recorded = (path: string): RawEvent =>
		JSON.parse(
			readFileSync(
				`${import.meta.dir}/../fixtures/billing/stripe/recorded/${path}`,
				"utf8",
			),
		);
	const factOf = (event: RawEvent): BillingDispute => {
		const mapping = mappingFor(event.type, event.api_version);
		if (!mapping.ok) throw new Error("no mapping");
		const result = normalize(event, mapping.value, { eventId: event.id });
		if (!result.ok) throw new Error(JSON.stringify(result.error));
		return result.value as BillingDispute;
	};

	test("a lost dispute: 26,000 withdrawn with a 1,500 fee, on the opening and on the closing", () => {
		for (const name of [
			"04-charge.dispute.created",
			"05-charge.dispute.closed",
		]) {
			const fact = factOf(recorded(`delivered/dispute-lost/${name}.json`));
			expect([name, fact.amount, fact.withdrawn, fact.fee]).toEqual([
				name,
				26000,
				-26000,
				1500,
			]);
		}
	});

	test("a won dispute: the closing lists the reversal after the withdrawal, and the fee is still the withdrawal's", () => {
		const closing = recorded(
			"delivered/dispute-won/05-charge.dispute.closed.json",
		);
		expect(
			closing.data.object.balance_transactions.map(
				(t: { amount: number; fee: number }) => [t.amount, t.fee],
			),
		).toEqual([
			[-26000, 1500],
			[26000, 0],
		]);
		const fact = factOf(closing);
		expect([fact.status, fact.withdrawn, fact.fee]).toEqual([
			"won",
			-26000,
			1500,
		]);
	});

	test("an inquiry has an empty list: no withdrawal, no fee", () => {
		const fact = factOf(recorded("charge.dispute.created.json"));
		expect([fact.withdrawn, fact.fee]).toEqual([undefined, undefined]);
	});
});

describe("a dispute opens", () => {
	test("books the withdrawal and the fee as their own lines, and the event balances", () => {
		const h = started();
		const response = h.deliver(opened(), OPENED);
		expect(response.body).toMatchObject({ outcome: "applied", events: 1 });
		const [dispute] = ofType(h.outbox(), "payment.disputed");
		// 26,000 disputed + 1,500 fee leave Stripe's balance: 275.00; the amount is the disputes expense, the fee its own line
		expect(lines(dispute)).toEqual([
			"assets:stripe -275.00 USD",
			"expenses:billing:disputes 260.00 USD",
			"expenses:billing:dispute-fees 15.00 USD",
		]);
		expect(dispute?.idem).toBe("stripe:du_1");
		expect(dispute?.payload).toMatchObject({
			id: "du_1",
			amount: DISPUTED,
			fee: DISPUTE_FEE,
			currency: "usd",
			charge: "ch_in_1",
			payment_intent: "pi_in_1",
			invoice: "in_1",
		});
		expect(
			posted([dispute as AtmEvent], "assets:stripe") +
				posted([dispute as AtmEvent], "expenses:billing:disputes") +
				posted([dispute as AtmEvent], "expenses:billing:dispute-fees"),
		).toBe(0);
	});

	test("an inquiry moved no money: no line, no fee", () => {
		const h = started();
		const response = h.deliver(
			opened({ withdrawal: undefined, status: "needs_response" }),
			OPENED,
		);
		expect(response.body.outcome).toBe("applied");
		expect(ofType(h.outbox(), "payment.disputed")).toEqual([]);
	});

	test("a dispute whose payment is not linked to a handled invoice is a 409 and books nothing", () => {
		const h = started();
		const stray = opened({ eventId: "evt_dp_stray", disputeId: "du_stray" });
		stray.data.object.payment_intent = "pi_unknown";
		stray.data.object.charge = "ch_unknown";
		const response = h.deliver(stray, OPENED);
		expect([response.status, response.body.outcome]).toEqual([
			409,
			"unmatched_payment",
		]);
		expect(ofType(h.outbox(), "payment.disputed")).toEqual([]);
	});
});

describe("a dispute is lost", () => {
	test("the fee is booked once, at the opening; the closing adds an event with no postings", () => {
		const h = started();
		h.deliver(opened(), OPENED);
		const response = h.deliver(closed("lost"), CLOSED);
		expect(response.body.outcome).toBe("applied");
		const events = h.outbox();
		expect(ofType(events, "payment.disputed")).toHaveLength(1);
		const [closing] = ofType(events, "dispute.closed");
		expect(closing?.postings).toEqual([]);
		expect(closing?.payload).toEqual({ id: "du_1", status: "lost" });
		expect(closing?.idem).toBe("stripe:du_1:closed");
		// income stays (260.00); the cash is down 275.00 and 7.84 less the fee on the payment: 252.16 - 275.00
		expect(posted(events, "assets:stripe")).toBe(GROSS - FEE - WITHDRAWN);
		expect(posted(events, "expenses:billing:disputes")).toBe(DISPUTED);
		expect(posted(events, "expenses:billing:dispute-fees")).toBe(DISPUTE_FEE);
		expect(posted(events, "income:billing:membership:sparkle-2")).toBe(-GROSS);
	});

	test("the closing alone books the opening line, dated at the dispute's creation, when its created event never came", () => {
		const h = started();
		expect(h.deliver(closed("lost"), CLOSED).body.outcome).toBe("applied");
		const [opening] = ofType(h.outbox(), "payment.disputed");
		expect(lines(opening)).toEqual([
			"assets:stripe -275.00 USD",
			"expenses:billing:disputes 260.00 USD",
			"expenses:billing:dispute-fees 15.00 USD",
		]);
		// T0 is 2026-01-15T18:00:00Z; the dispute opened two hours on
		expect(opening?.event_time).toBe("2026-01-15T20:00:00Z");
	});
});

describe("a dispute is won", () => {
	test("the amount comes back and the fee stays an expense", () => {
		const h = started();
		h.deliver(opened(), OPENED);
		expect(h.deliver(closed("won"), CLOSED).body.outcome).toBe("applied");
		const events = h.outbox();
		const [closing] = ofType(events, "dispute.closed");
		expect(lines(closing)).toEqual([
			"assets:stripe 260.00 USD",
			"expenses:billing:disputes -260.00 USD",
		]);
		// the disputes expense nets to nothing; Stripe's balance is down by the fee alone (1,500), on top of the payment
		expect(posted(events, "expenses:billing:disputes")).toBe(0);
		expect(posted(events, "expenses:billing:dispute-fees")).toBe(DISPUTE_FEE);
		expect(posted(events, "assets:stripe")).toBe(GROSS - FEE - DISPUTE_FEE);
	});
});

describe("redelivery and order", () => {
	test("the same Stripe event again is a duplicate and books nothing", () => {
		const h = started();
		h.deliver(opened(), OPENED);
		const before = h.outbox().length;
		expect(h.deliver(opened(), OPENED).body.outcome).toBe("duplicate");
		expect(h.outbox()).toHaveLength(before);
	});

	test("the same dispute under another Stripe event id books the fee once", () => {
		const h = started();
		h.deliver(opened(), OPENED);
		const again = h.deliver(
			opened({ eventId: "evt_dp_resent" }),
			OPENED + 5000,
		);
		expect(again.body.outcome).toBe("applied");
		const events = h.outbox();
		expect(ofType(events, "payment.disputed")).toHaveLength(1);
		expect(posted(events, "expenses:billing:dispute-fees")).toBe(DISPUTE_FEE);
	});

	test("the closing delivered under two event ids books the closing and the fee once", () => {
		const h = started();
		h.deliver(opened(), OPENED);
		h.deliver(closed("won"), CLOSED);
		h.deliver(closed("won", { eventId: "evt_dp_won_again" }), CLOSED + 5000);
		const events = h.outbox();
		expect(ofType(events, "payment.disputed")).toHaveLength(1);
		expect(ofType(events, "dispute.closed")).toHaveLength(1);
		expect(posted(events, "expenses:billing:dispute-fees")).toBe(DISPUTE_FEE);
		expect(posted(events, "expenses:billing:disputes")).toBe(0);
	});

	test("the closing before the opening gives the same lines as the opening before the closing", () => {
		const idemAndLines = (events: AtmEvent[]) =>
			ofType(events, "payment.disputed")
				.concat(ofType(events, "dispute.closed"))
				.map((event) => [event.idem, event.id, lines(event)]);
		const inOrder = started();
		inOrder.deliver(opened(), OPENED);
		inOrder.deliver(closed("won"), CLOSED);
		const swapped = started();
		swapped.deliver(closed("won"), CLOSED);
		swapped.deliver(opened(), OPENED);
		expect(idemAndLines(swapped.outbox())).toEqual(
			idemAndLines(inOrder.outbox()),
		);
		expect(ofType(swapped.outbox(), "payment.disputed")).toHaveLength(1);
	});
});

/** The journal and hledger over the handler's own log: the books balance, the accounts and commodities are declared. */
describe("through the shipper, the journal and hledger", () => {
	const books = async (events: RawEvent[]) => {
		const h = started();
		for (const [event, at] of events as [RawEvent, number][])
			expect(h.deliver(event, at).body.outcome).toBe("applied");
		const root = await tmp("handler-disputes");
		const shipped = await shipOutbox({
			db: h.db,
			store: new FolderStore({ root }),
			school: SCHOOL,
			nowMs: () => SHIPPED_AT,
		});
		expect(shipped.conflicts).toEqual([]);
		await journalMonth({ root, school: SCHOOL, month: "2026-01" });
		const dir = join(root, "schools", SCHOOL);
		const hledger = (args: string[]): string => {
			const run = Bun.spawnSync(["hledger", "-f", "main.journal", ...args], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(run.stderr.toString()).toBe("");
			expect(run.exitCode).toBe(0);
			return run.stdout.toString();
		};
		return { root, hledger };
	};
	/** The cents in the `"account","12.34 USD"` CSV row of a report; 0 when hledger left a zero balance out. */
	const cents = (csv: string, account: string): number => {
		const row = csv
			.split("\n")
			.find((line) => line.startsWith(`"${account}",`));
		if (!row) return 0;
		const amount = [...row.matchAll(/"([^"]*)"/g)][1]?.[1] ?? "";
		return Number(amount.replace(/[ ,]USD$/, "").replace(/[.,]/g, ""));
	};

	test.skipIf(!hasHledger)(
		"lost: income stays, the dispute and its fee are expenses, and the journal balances",
		async () => {
			const { root, hledger } = await books([
				[opened(), OPENED],
				[closed("lost"), CLOSED],
			]);
			try {
				hledger(["check", "balanced", "accounts", "commodities"]);
				const statement = hledger(["is", "-O", "csv"]);
				expect(cents(statement, "income:billing:membership:sparkle-2")).toBe(
					GROSS,
				);
				expect(cents(statement, "expenses:billing:disputes")).toBe(DISPUTED);
				expect(cents(statement, "expenses:billing:dispute-fees")).toBe(
					DISPUTE_FEE,
				);
				expect(cents(statement, "expenses:billing:stripe-fees")).toBe(FEE);
				// 260.00 - 260.00 - 15.00 - 7.84
				expect(cents(statement, "Net:")).toBe(
					GROSS - DISPUTED - DISPUTE_FEE - FEE,
				);
				// Stripe's balance: 260.00 - 7.84 - 275.00 = -22.84 (a negative balance Stripe collects from the next payments)
				expect(cents(hledger(["bs", "-O", "csv"]), "assets:stripe")).toBe(
					GROSS - FEE - WITHDRAWN,
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!hasHledger)(
		"won: the disputes expense nets to nothing and only the fee is lost",
		async () => {
			const { root, hledger } = await books([
				[opened(), OPENED],
				[closed("won"), CLOSED],
			]);
			try {
				hledger(["check", "balanced", "accounts", "commodities"]);
				const statement = hledger(["is", "-O", "csv"]);
				expect(cents(statement, "expenses:billing:disputes")).toBe(0);
				expect(cents(statement, "expenses:billing:dispute-fees")).toBe(
					DISPUTE_FEE,
				);
				// 260.00 - 15.00 - 7.84
				expect(cents(statement, "Net:")).toBe(GROSS - DISPUTE_FEE - FEE);
				expect(cents(hledger(["bs", "-O", "csv"]), "assets:stripe")).toBe(
					GROSS - FEE - DISPUTE_FEE,
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});

/** Stripe's side for the scenario, written out from the recorded balance transactions, not from the events. */
const stripeSide = (status: "lost" | "won"): ReconcileStripe => {
	const seconds = (ms: number) => Math.floor(ms / 1000);
	return {
		invoices: [
			{
				id: "in_1",
				status: "paid",
				amount_paid: GROSS,
				currency: "usd",
				created: seconds(T0),
				livemode: true,
				status_transitions: { paid_at: seconds(T0) },
			},
		],
		refunds: [],
		payouts: [],
		disputes: [
			{
				id: "du_1",
				amount: DISPUTED,
				currency: "usd",
				created: seconds(OPENED),
				status,
				livemode: true,
			},
		],
		balanceTransactions: [
			{
				id: "txn_charge",
				amount: GROSS,
				fee: FEE,
				net: GROSS - FEE,
				currency: "usd",
				created: seconds(T0),
				type: "charge",
			},
			{
				id: "txn_withdrawal",
				amount: -DISPUTED,
				fee: DISPUTE_FEE,
				net: -WITHDRAWN,
				currency: "usd",
				created: seconds(OPENED),
				type: "adjustment",
			},
			...(status === "won"
				? [
						{
							id: "txn_reversal",
							amount: DISPUTED,
							fee: 0,
							net: DISPUTED,
							currency: "usd",
							created: seconds(CLOSED),
							type: "adjustment",
						},
					]
				: []),
		],
	};
};

describe("reconcile against Stripe's own numbers", () => {
	const period = { month: "2026-01" };

	test("a lost and a won dispute, with the fee booked, reconcile clean: disputes, fees and net", () => {
		for (const status of ["lost", "won"] as const) {
			const h = started();
			h.deliver(opened(), OPENED);
			h.deliver(closed(status), CLOSED);
			const result = reconcile({
				events: h.outbox(),
				stripe: stripeSide(status),
				period,
			});
			expect([status, result.differences]).toEqual([status, []]);
			// fees: the 7.84 on the payment and the 15.00 dispute fee, two postings
			expect(result.counts.fees).toEqual({ stripe: 2, log: 2 });
		}
	});

	test("a log that books the dispute without its fee shows the 15.00 in fees and net", () => {
		const h = started();
		h.deliver(opened(), OPENED);
		h.deliver(closed("lost"), CLOSED);
		// what the handler wrote before the fee was read: the same dispute event, no fee
		const unbooked = h.outbox().map((event) =>
			event.event_type === "payment.disputed"
				? {
						...event,
						postings: [
							{ account: "assets:stripe", amount: "-260.00", commodity: "USD" },
							{
								account: "expenses:billing:disputes",
								amount: "260.00",
								commodity: "USD",
							},
						],
					}
				: event,
		);
		const result = reconcile({
			events: unbooked,
			stripe: stripeSide("lost"),
			period,
		});
		expect(result.differences.map((d) => `${d.kind} ${d.object}`)).toEqual([
			"amount_differs fees",
			"amount_differs net",
		]);
		expect(result.differences[0]).toMatchObject({
			stripe: { amount: FEE + DISPUTE_FEE },
			log: { amount: FEE },
		});
	});

	test("the log read back from the shipped folder reconciles the same", async () => {
		const h = started();
		h.deliver(opened(), OPENED);
		h.deliver(closed("lost"), CLOSED);
		const root = await tmp("handler-disputes-reconcile");
		try {
			await shipOutbox({
				db: h.db,
				store: new FolderStore({ root }),
				school: SCHOOL,
				nowMs: () => SHIPPED_AT,
			});
			const { events } = await readEvents(root, SCHOOL);
			const result = reconcile({ events, stripe: stripeSide("lost"), period });
			expect(result.differences).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
