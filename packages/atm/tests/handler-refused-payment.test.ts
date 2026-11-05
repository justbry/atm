/**
 * A paid invoice whose credits the handler refuses (e2e matrix finding D4). Stripe has collected the money when it sends
 * `invoice.paid`, so a refusal that rolls the whole delivery back leaves the books short by that income until a person fixes
 * the menu and the event is sent again. The handler now books the payment in the transaction that releases the claim, and
 * still answers 422 so Stripe keeps retrying; the retry grants the credits and books the payment no second time (its idem is
 * the invoice id).
 *
 * The numbers, by hand: the family pays 260.00. Stripe keeps 2.9% + 30 cents = 7.54 + 0.30 = 7.84, so 252.16 reaches
 * `assets:stripe`. A refund of 50.00 leaves 202.16 there.
 */
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { addonPriceKey, lookupKeyOf } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { signStripePayload } from "../src/handler/stripe-signature.js";
import { handleStripeWebhook } from "../src/handler/stripe-webhook.js";
import { journalMonth, readEvents } from "../src/ledger/files.js";
import { reconcile } from "../src/ledger/reconcile.js";
import { formatReconcile } from "../src/ledger/reconcile-files.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { FolderStore } from "../src/store/folder-store.js";
import type { AtmEvent } from "../src/types.js";
import { createStore } from "./billing-store.js";
import { stripeInvoice, stripeRefund } from "./e2e-matrix.js";
import {
	FAMILY,
	FEE,
	GROSS,
	HOUR,
	harness,
	linked,
	menu,
	REFUNDED,
	refund,
	SCHOOL,
	SECRET,
	SHIPPED_AT,
	T0,
	T1,
	tierKey,
} from "./handler-harness.js";
import { hasHledger, tmp } from "./helpers.js";
import {
	invoicePaid,
	type RawEvent,
	subscriptionDeleted,
} from "./stripe-events.js";

const SPARKLE_2_PAYMENT_INCOME = "income:billing:other";
const NET = GROSS - FEE;
const metadata = { b4u_school: SCHOOL, family_id: FAMILY };

/** The menu a school has before it lists the tier its families already pay for. */
const menuWithoutSparkle2: Menu = {
	...menu,
	tiers: menu.tiers.filter((tier) => tier.id !== "sparkle-2"),
};

/** The first delivery of the invoice: the tier line is not on the menu, so it is refused 422 `unmatched_line`. */
const refusedHarness = () =>
	harness({ in_1: FEE }, { menu: menuWithoutSparkle2 });

/** The owner lists the tier: the same endpoint now serves the whole menu. */
const fixTheMenu = (h: ReturnType<typeof harness>) => {
	h.deps.context = harness().deps.context;
};

const tierInvoice = (): RawEvent =>
	invoicePaid({
		eventId: "evt_in_1",
		invoiceId: "in_1",
		at: T0,
		subscriptionId: "sub_1",
		reason: "subscription_create",
		periodStart: T0,
		periodEnd: T1,
		lines: [{ lookupKey: tierKey(), amount: GROSS, interval: "month" }],
		metadata,
	});

const ofType = (events: AtmEvent[], type: string) =>
	events.filter((event) => event.event_type === type);

const creditEvents = (events: AtmEvent[]) =>
	events.filter((event) => event.event_type.startsWith("credit."));

const count = (h: ReturnType<typeof harness>, table: string): number =>
	(h.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** The postings of the one payment, as `account amount`. */
const postingsOf = (event: AtmEvent | undefined): string[] =>
	(event?.postings ?? []).map(
		(posting) => `${posting.account} ${posting.amount}`,
	);

describe("a paid invoice the menu does not know (422 unmatched_line)", () => {
	test("books the payment, still answers 422, releases the claim and grants no credits", () => {
		const h = refusedHarness();
		const response = h.deliver(tierInvoice());
		expect(response.status).toBe(422);
		expect(response.body).toMatchObject({
			outcome: "refused",
			reason: "unmatched_line",
			stripeEventId: "evt_in_1",
		});
		// Stripe keeps retrying: no claim, and the invoice is not indexed
		expect(h.claim("evt_in_1")).toBeNull();
		expect(count(h, "atm_invoice_index")).toBe(0);
		// no credits: no rows, no credit event
		expect(count(h, "atm_rows")).toBe(0);
		expect(count(h, "atm_subjects")).toBe(0);
		expect(creditEvents(h.outbox())).toEqual([]);
		// the money: 260.00 in, 7.84 fee, 252.16 in Stripe's balance; the tier is not on the menu, so it is `other`
		const events = h.outbox();
		expect(events.map((event) => event.event_type)).toEqual([
			"payment.succeeded",
		]);
		expect(postingsOf(events[0])).toEqual([
			"assets:stripe 252.16",
			"expenses:billing:stripe-fees 7.84",
			`${SPARKLE_2_PAYMENT_INCOME} -260.00`,
		]);
		expect(events[0]?.idem).toBe("stripe:in_1");
		expect(events[0]?.payload).toMatchObject({
			amount_paid: GROSS,
			fee: FEE,
			fee_known: true,
		});
		// the answer says so
		expect(response.body.message).toContain("payment");
	});

	test("refused, the menu fixed, then retried: the credits are granted and the income is booked once", () => {
		const h = refusedHarness();
		expect(h.deliver(tierInvoice()).status).toBe(422);
		const [booked] = h.outbox();

		fixTheMenu(h);
		const retry = h.deliver(tierInvoice(), T0 + HOUR);
		expect(retry.status).toBe(200);
		expect(retry.body).toMatchObject({ outcome: "applied", wroteRows: true });
		expect(h.claim("evt_in_1")?.state).toBe("done");
		expect(count(h, "atm_invoice_index")).toBe(1);

		const events = h.outbox();
		const payments = ofType(events, "payment.succeeded");
		// one payment of 260.00, the line the refused delivery booked, unchanged
		expect(payments).toHaveLength(1);
		expect(payments[0]).toEqual(booked as AtmEvent);
		expect(postingsOf(payments[0])).toEqual([
			"assets:stripe 252.16",
			"expenses:billing:stripe-fees 7.84",
			`${SPARKLE_2_PAYMENT_INCOME} -260.00`,
		]);
		// and now the credits: a sparkle-2 tier grants 2 visits
		expect(creditEvents(events).length).toBeGreaterThan(0);
		expect(count(h, "atm_rows")).toBeGreaterThan(0);

		// a third delivery is a duplicate and moves nothing
		const before = h.outbox();
		expect(h.deliver(tierInvoice(), T0 + 2 * HOUR).body.outcome).toBe(
			"duplicate",
		);
		expect(h.outbox()).toEqual(before);
	});

	test("refused and never fixed: Stripe's retries leave one payment, no credits, and no claim", () => {
		const h = refusedHarness();
		for (const hours of [0, 1, 4, 24]) {
			expect(h.deliver(tierInvoice(), T0 + hours * HOUR).status).toBe(422);
		}
		const events = h.outbox();
		expect(ofType(events, "payment.succeeded")).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(h.claim("evt_in_1")).toBeNull();
		expect(count(h, "atm_rows")).toBe(0);
	});

	test("the same invoice under another Stripe event id, after the fix, still books the payment once", () => {
		const h = refusedHarness();
		h.deliver(tierInvoice());
		fixTheMenu(h);
		const resent = { ...tierInvoice(), id: "evt_in_1_resent" };
		expect(h.deliver(resent, T0 + HOUR).body.outcome).toBe("applied");
		expect(ofType(h.outbox(), "payment.succeeded")).toHaveLength(1);
	});

	test("the fee of the first delivery is the one booked, as for any invoice", () => {
		const fees: Record<string, number | null> = { in_1: FEE };
		const h = harness(fees, { menu: menuWithoutSparkle2 });
		h.deliver(tierInvoice());
		fees.in_1 = 100;
		fixTheMenu(h);
		h.deliver(tierInvoice(), T0 + HOUR);
		const [payment] = ofType(h.outbox(), "payment.succeeded");
		expect(payment?.payload).toMatchObject({ fee: FEE, fee_known: true });
	});

	test("an invoice with no fee known books the gross and says the fee is unknown, refused or not", () => {
		const h = harness(undefined, { menu: menuWithoutSparkle2 });
		expect(h.deliver(tierInvoice()).status).toBe(422);
		const [payment] = h.outbox();
		expect(postingsOf(payment)).toEqual([
			"assets:stripe 260.00",
			`${SPARKLE_2_PAYMENT_INCOME} -260.00`,
		]);
		expect(payment?.payload).toMatchObject({ fee: 0, fee_known: false });
	});

	test("a refund and the payment link of a refused invoice still wait (409), and are handled once the invoice is", () => {
		const h = refusedHarness();
		h.deliver(tierInvoice());
		const link = h.deliver(linked("in_1"), T0 + 1000);
		expect([link.status, link.body.outcome]).toEqual([
			409,
			"unmatched_invoice",
		]);
		const early = h.deliver(refund(REFUNDED), T0 + HOUR);
		expect([early.status, early.body.outcome]).toEqual([
			409,
			"unmatched_payment",
		]);
		expect(count(h, "atm_payment_index")).toBe(0);
		expect(ofType(h.outbox(), "payment.refunded")).toEqual([]);

		fixTheMenu(h);
		expect(h.deliver(tierInvoice(), T0 + 2 * HOUR).body.outcome).toBe(
			"applied",
		);
		expect(h.deliver(linked("in_1"), T0 + 3 * HOUR).body.outcome).toBe(
			"applied",
		);
		const refunded = h.deliver(refund(REFUNDED), T0 + 4 * HOUR);
		expect(refunded.body.outcome).toBe("applied");
		const events = h.outbox();
		expect(ofType(events, "payment.succeeded")).toHaveLength(1);
		const [refundLine] = ofType(events, "payment.refunded");
		expect(refundLine?.payload).toMatchObject({ amount: REFUNDED });
	});

	test("the payment is dated by when the invoice was paid in the school's calendar, whenever the retry comes", () => {
		// 03:00 UTC on 1 February is 20:00 on 31 January in Denver
		const paidAt = Date.parse("2026-02-01T03:00:00Z");
		const late = (): RawEvent => ({
			...invoicePaid({
				eventId: "evt_in_1",
				invoiceId: "in_1",
				at: paidAt,
				subscriptionId: "sub_1",
				reason: "subscription_create",
				periodStart: paidAt,
				periodEnd: paidAt + 30 * 24 * HOUR,
				lines: [{ lookupKey: tierKey(), amount: GROSS, interval: "month" }],
				metadata,
			}),
		});
		const h = refusedHarness();
		h.deliver(late(), paidAt);
		fixTheMenu(h);
		h.deliver(late(), Date.parse("2026-03-10T12:00:00Z"));
		const payments = ofType(h.outbox(), "payment.succeeded");
		expect(payments).toHaveLength(1);
		expect(payments[0]?.date).toBe("2026-01-31");
	});
});

describe("the other reasons that refuse a paid invoice after the claim", () => {
	const paidTier = (): RawEvent => tierInvoice();

	test("tier_on_other_subscription: the payment is booked as the tier's income, the credits are not moved", () => {
		const h = harness({ in_1: FEE, in_other: FEE });
		expect(h.deliver(paidTier()).body.outcome).toBe("applied");
		const before = h.outbox();
		const other = invoicePaid({
			eventId: "evt_in_other",
			invoiceId: "in_other",
			at: T1,
			subscriptionId: "sub_2",
			reason: "subscription_cycle",
			periodStart: T1,
			periodEnd: T1 + 30 * 24 * HOUR,
			lines: [{ lookupKey: tierKey(), amount: GROSS, interval: "month" }],
			metadata,
		});
		const response = h.deliver(other, T1);
		expect(response.status).toBe(422);
		expect(response.body.reason).toBe("tier_on_other_subscription");
		const added = h.outbox().slice(before.length);
		expect(added.map((event) => event.event_type)).toEqual([
			"payment.succeeded",
		]);
		expect(added[0]?.idem).toBe("stripe:in_other");
		expect(postingsOf(added[0])).toEqual([
			"assets:stripe 252.16",
			"expenses:billing:stripe-fees 7.84",
			"income:billing:membership:sparkle-2 -260.00",
		]);
		expect(h.claim("evt_in_other")).toBeNull();
		// the same refusal again books nothing more
		h.deliver(other, T1 + HOUR);
		expect(h.outbox()).toHaveLength(before.length + 1);
	});

	test("addon_only_subscription: the payment is booked as the add-on's income, no credits", () => {
		const glowKey = lookupKeyOf(
			SCHOOL,
			addonPriceKey("glow", "month"),
			5000,
			menu.currency,
		);
		const h = harness({ in_glow: 175 });
		const addonOnly = invoicePaid({
			eventId: "evt_in_glow",
			invoiceId: "in_glow",
			at: T0,
			subscriptionId: "sub_glow",
			reason: "subscription_create",
			periodStart: T0,
			periodEnd: T1,
			lines: [{ lookupKey: glowKey, amount: 5000, interval: "month" }],
			metadata,
		});
		const response = h.deliver(addonOnly);
		expect(response.status).toBe(422);
		expect(response.body.reason).toBe("addon_only_subscription");
		const events = h.outbox();
		expect(events.map((event) => event.event_type)).toEqual([
			"payment.succeeded",
		]);
		// 50.00 paid, 1.75 kept (5,000 x 2.9% = 145, plus 30), 48.25 in the balance
		expect(postingsOf(events[0])).toEqual([
			"assets:stripe 48.25",
			"expenses:billing:stripe-fees 1.75",
			"income:billing:addon:glow -50.00",
		]);
		expect(count(h, "atm_rows")).toBe(0);
		expect(h.claim("evt_in_glow")).toBeNull();
	});

	test("rejected (the grant rules threw: a second subscription for a family whose first ended): the payment is booked, nothing else", () => {
		const h = harness({ in_1: FEE, in_new: FEE });
		expect(h.deliver(tierInvoice()).body.outcome).toBe("applied");
		h.deliver(
			subscriptionDeleted({
				eventId: "evt_sd",
				subscriptionId: "sub_1",
				tierId: "sparkle-2",
				interval: "month",
				periodStart: T0,
				periodEnd: T1,
				at: T0 + 24 * HOUR,
			}),
			T0 + 24 * HOUR,
		);
		const before = h.outbox();
		const rowsBefore = h.db.all(
			`SELECT * FROM atm_rows ORDER BY table_name, row_id`,
		);
		const second = invoicePaid({
			eventId: "evt_in_new",
			invoiceId: "in_new",
			at: T1,
			subscriptionId: "sub_2",
			reason: "subscription_create",
			periodStart: T1,
			periodEnd: T1 + 30 * 24 * HOUR,
			lines: [{ lookupKey: tierKey(), amount: GROSS, interval: "month" }],
			metadata,
		});
		const response = h.deliver(second, T1);
		expect(response.status).toBe(422);
		expect(response.body.reason).toBe("rejected");
		const added = h.outbox().slice(before.length);
		expect(added.map((event) => event.event_type)).toEqual([
			"payment.succeeded",
		]);
		expect(postingsOf(added[0])).toEqual([
			"assets:stripe 252.16",
			"expenses:billing:stripe-fees 7.84",
			"income:billing:membership:sparkle-2 -260.00",
		]);
		expect(
			h.db.all(`SELECT * FROM atm_rows ORDER BY table_name, row_id`),
		).toEqual(rowsBefore);
		expect(h.claim("evt_in_new")).toBeNull();
	});

	test("a refused non-USD invoice leaves the money.skipped marker and no payment, as an applied one does", () => {
		const h = refusedHarness();
		h.deps.warn = () => undefined;
		const euros = tierInvoice();
		euros.data.object.currency = "eur";
		expect(h.deliver(euros).status).toBe(422);
		const events = h.outbox();
		expect(events.map((event) => event.event_type)).toEqual(["money.skipped"]);
		expect(events[0]?.payload).toMatchObject({
			kind: "invoice",
			id: "in_1",
			currency: "eur",
			amount: GROSS,
		});
		// after the fix the answer is the usual non_usd, and the marker is not doubled
		fixTheMenu(h);
		const retry = euros;
		const applied = h.deliver(retry, T0 + HOUR);
		expect(applied.body.outcome).toBe("non_usd");
		expect(ofType(h.outbox(), "money.skipped")).toHaveLength(1);
		expect(ofType(h.outbox(), "payment.succeeded")).toEqual([]);
	});
});

describe("what stays unbooked: the refusals where booking the payment would be wrong or impossible", () => {
	const send = (
		h: ReturnType<typeof harness>,
		event: RawEvent,
		over: { secret?: string; payload?: string } = {},
	) => {
		const payload = over.payload ?? JSON.stringify(event);
		return handleStripeWebhook(h.deps, {
			payload,
			signatureHeader: signStripePayload({
				payload,
				secret: over.secret ?? SECRET,
				timestampSeconds: Math.floor((T0 + 20_000) / 1000),
			}),
		});
	};

	test("a bad signature, a body that is not an event, a test-mode event on a live endpoint", () => {
		const h = refusedHarness();
		expect(send(h, tierInvoice(), { secret: "whsec_other" }).status).toBe(401);
		expect(send(h, tierInvoice(), { payload: "not json" }).status).toBe(400);
		const testMode = tierInvoice();
		testMode.livemode = false;
		expect(send(h, testMode).body.outcome).toBe("livemode_mismatch");
		expect(h.outbox()).toEqual([]);
	});

	test("an invoice for another school is school_mismatch, and half a holder is missing_metadata: both before any claim", () => {
		const h = refusedHarness();
		const otherSchool = invoicePaid({
			eventId: "evt_other_school",
			invoiceId: "in_other_school",
			at: T0,
			subscriptionId: "sub_x",
			reason: "subscription_create",
			periodStart: T0,
			periodEnd: T1,
			lines: [{ lookupKey: tierKey(), amount: GROSS, interval: "month" }],
			metadata: { b4u_school: "sch_elsewhere", family_id: FAMILY },
		});
		expect(h.deliver(otherSchool).body.outcome).toBe("school_mismatch");
		const half = invoicePaid({
			eventId: "evt_half",
			invoiceId: "in_half",
			at: T0,
			subscriptionId: "sub_x",
			reason: "subscription_create",
			periodStart: T0,
			periodEnd: T1,
			lines: [{ lookupKey: tierKey(), amount: GROSS, interval: "month" }],
			metadata: { b4u_school: SCHOOL },
		});
		const response = h.deliver(half);
		expect([response.status, response.body.reason]).toEqual([
			422,
			"missing_metadata",
		]);
		expect(h.outbox()).toEqual([]);
		expect(h.claim("evt_other_school")).toBeNull();
		expect(h.claim("evt_half")).toBeNull();
	});

	test("another product's invoice (no holder metadata) is ignored and books nothing", () => {
		const h = refusedHarness();
		const foreign = invoicePaid({
			eventId: "evt_foreign",
			invoiceId: "in_foreign",
			at: T0,
			subscriptionId: null,
			reason: "manual",
			periodStart: T0,
			periodEnd: T1,
			lines: [{ lookupKey: "other_product", amount: 5000, interval: null }],
			metadata: {},
		});
		expect(h.deliver(foreign).body.outcome).toBe("ignored");
		expect(h.outbox()).toEqual([]);
	});

	test("a fee that cannot be booked (bad_event) is refused with nothing written", () => {
		const h = harness({ in_1: GROSS + 1 }, { menu: menuWithoutSparkle2 });
		const response = h.deliver(tierInvoice());
		expect([response.status, response.body.reason]).toEqual([
			422,
			"unmatched_line",
		]);
		// the menu refusal comes first, and a fee the invoice cannot have paid is not booked
		expect(h.outbox()).toEqual([]);
	});

	test("an event from another API version (unknown_mapping) and a school the service does not know are refused with nothing written", () => {
		const h = refusedHarness();
		const older = tierInvoice();
		older.api_version = "2024-06-20";
		const response = h.deliver(older);
		expect([response.status, response.body.reason]).toEqual([
			422,
			"unknown_mapping",
		]);
		expect(h.outbox()).toEqual([]);

		h.deps.context = () => null;
		const unknown = h.deliver(tierInvoice());
		expect([unknown.status, unknown.body.outcome]).toEqual([
			422,
			"unknown_school",
		]);
		expect(h.outbox()).toEqual([]);
	});
});

describe("reconcile against Stripe's side of a refused invoice", () => {
	const reconciled = async (h: ReturnType<typeof harness>) => {
		const root = await tmp("refused-reconcile");
		try {
			const shipped = await shipOutbox({
				db: h.db,
				store: new FolderStore({ root }),
				school: SCHOOL,
				nowMs: () => SHIPPED_AT,
			});
			expect(shipped.conflicts).toEqual([]);
			const { events } = await readEvents(root, SCHOOL);
			return reconcile({
				events,
				stripe: {
					invoices: [stripeInvoice("in_1", GROSS, "2026-01-15T18:00:00Z")],
					// Stripe refunded 50.00 of it at 19:00
					refunds: [
						stripeRefund("re_1", REFUNDED, "2026-01-15T19:00:00Z", "in_1"),
					],
				},
				period: { month: "2026-01" },
				timeZone: "America/Denver",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	};

	test("the invoice and its fee are in the log; only the refund, which waits for the invoice, is missing", async () => {
		const h = refusedHarness();
		h.deliver(tierInvoice());
		h.deliver(linked("in_1"), T0 + 1000);
		h.deliver(refund(REFUNDED), T0 + HOUR);
		const result = await reconciled(h);
		const lines = formatReconcile(result);
		expect(lines).not.toContain("missing_in_log: invoice");
		expect(lines).toContain("missing_in_log: refund");
	});

	test("once the menu is fixed and the events are retried, nothing is missing", async () => {
		const h = refusedHarness();
		h.deliver(tierInvoice());
		fixTheMenu(h);
		h.deliver(tierInvoice(), T0 + HOUR);
		h.deliver(linked("in_1"), T0 + 2 * HOUR);
		h.deliver(refund(REFUNDED), T0 + 3 * HOUR);
		const result = await reconciled(h);
		expect(formatReconcile(result)).not.toContain("missing_in_log");
	});
});

describe("the books of a refused invoice, through hledger", () => {
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

	const books = async (
		h: ReturnType<typeof harness>,
		run: (hledger: (args: string[]) => string) => void,
	) => {
		const root = await tmp("refused-payment");
		try {
			const shipped = await shipOutbox({
				db: h.db,
				store: new FolderStore({ root }),
				school: SCHOOL,
				nowMs: () => SHIPPED_AT,
			});
			expect(shipped.conflicts).toEqual([]);
			await journalMonth({ root, school: SCHOOL, month: "2026-01" });
			const hledger = (args: string[]): string => {
				const spawned = Bun.spawnSync(
					["hledger", "-f", "main.journal", ...args],
					{
						cwd: join(root, "schools", SCHOOL),
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				expect(spawned.stderr.toString()).toBe("");
				expect(spawned.exitCode).toBe(0);
				return spawned.stdout.toString();
			};
			hledger(["check", "balanced", "accounts", "commodities"]);
			run(hledger);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	};

	test.skipIf(!hasHledger)(
		"refused and never fixed: 260.00 income, 7.84 fee, 252.16 in Stripe's balance",
		async () => {
			const h = refusedHarness();
			h.deliver(tierInvoice());
			await books(h, (hledger) => {
				const statement = hledger(["is", "-O", "csv"]);
				expect(cents(statement, SPARKLE_2_PAYMENT_INCOME)).toBe(BigInt(GROSS));
				expect(cents(statement, "expenses:billing:stripe-fees")).toBe(
					BigInt(FEE),
				);
				expect(cents(statement, "Net:")).toBe(BigInt(NET));
				const sheet = hledger(["bs", "-O", "csv"]);
				expect(cents(sheet, "assets:stripe")).toBe(BigInt(NET));
			});
		},
	);

	test.skipIf(!hasHledger)(
		"refused, fixed, retried, partly refunded: the income is 260.00 once and the refund 50.00 (202.16 left)",
		async () => {
			const h = refusedHarness();
			h.deliver(tierInvoice());
			fixTheMenu(h);
			h.deliver(tierInvoice(), T0 + HOUR);
			h.deliver(linked("in_1"), T0 + 2 * HOUR);
			h.deliver(refund(REFUNDED), T0 + 3 * HOUR);
			await books(h, (hledger) => {
				const statement = hledger(["is", "-O", "csv"]);
				expect(cents(statement, SPARKLE_2_PAYMENT_INCOME)).toBe(BigInt(GROSS));
				expect(cents(statement, "income:billing:refunds")).toBe(
					BigInt(-REFUNDED),
				);
				expect(cents(statement, "Net:")).toBe(BigInt(NET - REFUNDED));
				const sheet = hledger(["bs", "-O", "csv"]);
				expect(cents(sheet, "assets:stripe")).toBe(BigInt(NET - REFUNDED));
			});
		},
	);
});

describe("review of the refused payment: what the message says, and the cases the first tests did not reach", () => {
	const otherSubscriptionInvoice = (): RawEvent =>
		invoicePaid({
			eventId: "evt_in_other",
			invoiceId: "in_other",
			at: T1,
			subscriptionId: "sub_2",
			reason: "subscription_cycle",
			periodStart: T1,
			periodEnd: T1 + 30 * 24 * HOUR,
			lines: [{ lookupKey: tierKey(), amount: GROSS, interval: "month" }],
			metadata,
		});

	test("handleStripeEvent alone books nothing, so its message does not claim the payment is booked", () => {
		const store = createStore({
			menu: menuWithoutSparkle2,
			school: SCHOOL,
			family: FAMILY,
		});
		const result = store.handle(tierInvoice(), T0, { fee: FEE });
		expect(result.refused?.reason).toBe("unmatched_line");
		// the line is there for the caller to book; the pure function wrote nothing
		expect(
			ofType(result.refused?.payment ?? [], "payment.succeeded"),
		).toHaveLength(1);
		expect(result.events).toEqual([]);
		expect(result.refused?.message).not.toContain("is booked");
	});

	test("a refund instead of a fix is not booked: the 422 says so, and the refund waits for good", () => {
		const h = harness({ in_1: FEE, in_other: FEE });
		expect(h.deliver(tierInvoice()).body.outcome).toBe("applied");
		const response = h.deliver(otherSubscriptionInvoice(), T1);
		expect(response.body.reason).toBe("tier_on_other_subscription");
		// the advice is to refund it; the booked income stays, and the refund of an unapplied invoice is never booked
		expect(response.body.message).toContain("refund this invoice");
		expect(response.body.message).toContain("by hand");
		const link = h.deliver(linked("in_other"), T1 + HOUR);
		expect([link.status, link.body.outcome]).toEqual([
			409,
			"unmatched_invoice",
		]);
		expect(ofType(h.outbox(), "payment.refunded")).toEqual([]);
	});

	test("the test endpoint books the refused payment in the test env, not the live one", () => {
		const h = harness(
			{ in_1: FEE },
			{ menu: menuWithoutSparkle2, env: "test" },
		);
		expect(h.deliver(tierInvoice()).status).toBe(422);
		expect(h.raw.query("SELECT env FROM ledger_outbox").all()).toEqual([
			{ env: "test" },
		]);
	});

	test("a payment that cannot be built (a time zone no calendar knows) leaves the refusal as it was: 422, nothing booked, claim released", () => {
		const h = harness(
			{ in_1: FEE },
			{ menu: { ...menuWithoutSparkle2, timeZone: "Mars/Phobos" } },
		);
		const response = h.deliver(tierInvoice());
		expect([response.status, response.body.reason]).toEqual([
			422,
			"unmatched_line",
		]);
		expect(h.outbox()).toEqual([]);
		expect(h.claim("evt_in_1")).toBeNull();
	});
});
