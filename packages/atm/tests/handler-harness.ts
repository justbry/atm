/**
 * The reference handler in a test: an in-memory handler database, a signed delivery of a Stripe event, and the outbox it
 * writes, with the recorded-shape events that drive an invoice, a refund and a payout through it.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { menuCatalogRows } from "../src/billing/grants.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	lookupKeyOf,
	menuLineItems,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { signStripePayload } from "../src/handler/stripe-signature.js";
import { handleStripeWebhook } from "../src/handler/stripe-webhook.js";
import type { WebhookDeps } from "../src/handler/types.js";
import type { AtmEvent } from "../src/types.js";
import {
	chargeRefunded,
	invoicePaid,
	paymentIntentOf,
	payoutPaid,
	priceIdOf,
	type RawEvent,
} from "./stripe-events.js";

export const SCHOOL = "sch_vol";
export const FAMILY = "fam_8k2";
export const SECRET = "whsec_unit_test_secret";
export const HOUR = 3_600_000;
export const T0 = Date.parse("2026-01-15T18:00:00Z");
export const T1 = Date.parse("2026-02-15T18:00:00Z");
export const SHIPPED_AT = 1_700_000_000_000;
// The numbers every test below puts in, in cents: what the family paid, what Stripe kept, what was refunded, what is left
// in Stripe's balance and so what Stripe pays out.
export const GROSS = 26_000;
export const FEE = 784;
export const REFUNDED = 5000;
export const PAYOUT = GROSS - FEE - REFUNDED;
export const menu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;

export const tierKey = () => {
	const price = menu.tiers
		.find((t) => t.id === "sparkle-2")
		?.prices.find((p) => p.interval === "month");
	return lookupKeyOf(
		SCHOOL,
		tierPriceKey("sparkle-2", "month"),
		price?.amount as number,
		menu.currency,
	);
};

export const paid = (invoiceId = "in_1"): RawEvent =>
	invoicePaid({
		eventId: `evt_${invoiceId}`,
		invoiceId,
		at: T0,
		subscriptionId: "sub_1",
		reason: "subscription_create",
		periodStart: T0,
		periodEnd: T1,
		lines: [{ lookupKey: tierKey(), amount: GROSS, interval: "month" }],
		metadata: { b4u_school: SCHOOL, family_id: FAMILY },
	});

/** The `invoice_payment.paid` that links a refund's payment intent to its invoice (the recorded shape). */
export const linked = (invoiceId: string): RawEvent => {
	const event = {
		...JSON.parse(
			readFileSync(
				`${import.meta.dir}/../fixtures/billing/stripe/recorded/invoice_payment.paid.json`,
				"utf8",
			),
		),
		livemode: true,
	};
	event.id = `evt_link_${invoiceId}`;
	event.created = Math.floor((T0 + 1000) / 1000);
	event.data.object.created = event.created;
	event.data.object.invoice = invoiceId;
	event.data.object.payment = {
		type: "payment_intent",
		payment_intent: paymentIntentOf(invoiceId),
	};
	return event;
};

export const refund = (
	amount: number,
	over: Partial<Parameters<typeof chargeRefunded>[0]> = {},
): RawEvent =>
	chargeRefunded({
		eventId: "evt_re_1",
		chargeId: "ch_in_1",
		invoiceId: "in_1",
		amount,
		chargeAmount: GROSS,
		at: T0 + HOUR,
		...over,
	});

export const payout = (over: Partial<Parameters<typeof payoutPaid>[0]> = {}) =>
	payoutPaid({
		eventId: "evt_po_1",
		payoutId: "po_1",
		amount: PAYOUT,
		at: T0 + 48 * HOUR,
		...over,
	});

/** A live endpoint for the school; `fees` is what the caller read from Stripe for each invoice, by invoice id. */
export const harness = (fees?: Record<string, number | null>) => {
	const raw = new Database(":memory:");
	const db = bunSqlite(raw);
	db.exec(HANDLER_DDL);
	const clock = { now: T0 };
	const asked: string[] = [];
	const deps: WebhookDeps = {
		db,
		secret: SECRET,
		schoolId: SCHOOL,
		nowMs: () => clock.now,
		workerId: "worker-a",
		context: () => ({
			menu,
			menuVersion: 3,
			policy: DEFAULT_POLICY,
			policyVersion: 1,
			catalog: menuCatalogRows({ menu, school: SCHOOL }),
			priceIds: Object.fromEntries(
				[...menuLineItems(SCHOOL, menu).keys()].map((key) => [
					key,
					priceIdOf(key),
				]),
			),
		}),
		...(fees
			? {
					paymentFee: (event: unknown) => {
						const invoiceId = (event as { data: { object: { id: string } } })
							.data.object.id;
						asked.push(invoiceId);
						return fees[invoiceId];
					},
				}
			: {}),
	};
	const deliver = (event: RawEvent, at = T0) => {
		clock.now = at + 20_000;
		const payload = JSON.stringify(event);
		return handleStripeWebhook(deps, {
			payload,
			signatureHeader: signStripePayload({
				payload,
				secret: SECRET,
				timestampSeconds: Math.floor(clock.now / 1000),
			}),
		});
	};
	const outbox = () =>
		(
			raw.query(`SELECT body FROM ledger_outbox ORDER BY id`).all() as {
				body: string;
			}[]
		).map((row) => JSON.parse(row.body) as AtmEvent);
	const claim = (eventId: string) =>
		raw
			.query(`SELECT state FROM atm_event_claims WHERE event_id = ?`)
			.get(eventId) as { state: string } | null;
	return { db, deps, deliver, outbox, claim, asked };
};
