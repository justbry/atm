/**
 * The family service in miniature for the revenue-share tests: one subject's stored rows and revision, a policy the test
 * may change between events, the real `handleStripeEvent`, and the events it was handed. Invoice events are built with
 * `tests/stripe-events.ts` (a tier invoice of 26000 cents, the menu's `sparkle-2` monthly price) and a booking's are the
 * recorded sandbox objects.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	applyRowChanges,
	type BillingRow,
	grantsFromRows,
} from "../src/billing/rows.js";
import {
	lookupKeyOf,
	menuLineItems,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type {
	BillingPolicy,
	Menu,
	StripeEventResult,
} from "../src/billing/types.js";
import { deterministicUlid } from "../src/ledger/ids.js";
import { canonicalize } from "../src/ledger/util.js";
import type { AtmEvent } from "../src/types.js";
import {
	chargeRefunded,
	invoicePaid,
	paymentIntentOf,
	priceIdOf,
	type RawEvent,
} from "./stripe-events.js";

export const SCHOOL = "sch_vol";
export const FAMILY = "fam_8k2";
/** The invoice's amount in cents: the menu's `sparkle-2` monthly price. */
export const PRICE = 26_000;
export const HOUR = 3_600_000;
export const T0 = Date.parse("2026-01-15T18:00:00Z");
export const T1 = Date.parse("2026-02-15T18:00:00Z");

/** Handler time for events that need none of their own. */
const NOW = Date.parse("2026-11-05T12:00:00Z");

export const menu = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../fixtures/billing/grants/menu.json"),
		"utf8",
	),
) as Menu;

const tierKey = (): string => {
	const price = menu.tiers
		.find((tier) => tier.id === "sparkle-2")
		?.prices.find((entry) => entry.interval === "month");
	return lookupKeyOf(
		SCHOOL,
		tierPriceKey("sparkle-2", "month"),
		price?.amount as number,
		menu.currency,
	);
};

const priceIds = Object.fromEntries(
	[...menuLineItems(SCHOOL, menu).keys()].map((key) => [key, priceIdOf(key)]),
);

/** The `invoice.paid` of a first membership invoice; `amountPaid` is what the customer paid after discounts. */
export const membershipInvoice = ({
	invoiceId = "in_1",
	at = T0,
	reason = "subscription_create",
	amountPaid,
	currency,
}: {
	invoiceId?: string;
	at?: number;
	reason?: "subscription_create" | "subscription_cycle";
	amountPaid?: number;
	currency?: string;
} = {}): RawEvent => {
	const event = invoicePaid({
		eventId: `evt_${invoiceId}`,
		invoiceId,
		at,
		subscriptionId: "sub_1",
		reason,
		periodStart: at,
		periodEnd: at + 30 * 24 * HOUR,
		lines: [{ lookupKey: tierKey(), amount: PRICE, interval: "month" }],
		metadata: { b4u_school: SCHOOL, family_id: FAMILY },
		...(amountPaid === undefined ? {} : { amountPaid }),
	});
	if (currency) event.data.object.currency = currency;
	return event;
};

/** A `charge.refunded` of the invoice's charge: `refundedTotal` is the charge's total refunded after it. */
export const invoiceRefund = ({
	eventId,
	invoiceId = "in_1",
	refundedTotal,
	previousTotal = 0,
	chargeAmount = PRICE,
	at = T0 + HOUR,
	currency,
}: {
	eventId: string;
	invoiceId?: string;
	refundedTotal: number;
	previousTotal?: number;
	chargeAmount?: number;
	at?: number;
	currency?: string;
}): RawEvent => {
	const event = chargeRefunded({
		eventId,
		chargeId: `ch_${invoiceId}`,
		invoiceId,
		amount: refundedTotal - previousTotal,
		chargeAmount,
		refundedTotal,
		at,
	});
	if (currency) event.data.object.currency = currency;
	return event;
};

/** What the fixtures give back as a stored input event's id. */
const inputEventId = (school: string, stripeEventId: string, at: number) =>
	deterministicUlid({
		timeMs: at,
		revision: 0,
		seed: canonicalize([school, stripeEventId]),
	});

export const world = ({
	school = SCHOOL,
	policy: initialPolicy = DEFAULT_POLICY,
	worldMenu = menu,
}: {
	school?: string;
	policy?: BillingPolicy;
	worldMenu?: Menu;
} = {}) => {
	const catalog = menuCatalogRows({ menu: worldMenu, school });
	let policy = initialPolicy;
	let rows: BillingRow[] = [];
	let revision = 0;
	const events: AtmEvent[] = [];
	const results: StripeEventResult[] = [];
	const invoiceIds: Record<string, string> = {};
	return {
		events,
		results,
		get rows() {
			return rows;
		},
		get grants() {
			return grantsFromRows(rows);
		},
		/** The policy the next events are decided under (a rate that changes). */
		setPolicy: (next: BillingPolicy) => {
			policy = next;
		},
		handle: (
			event: RawEvent,
			{ at = NOW, fee }: { at?: number; fee?: number } = {},
		): StripeEventResult => {
			if (event.type === "invoice.paid")
				invoiceIds[paymentIntentOf(event.data.object.id)] =
					event.data.object.id;
			const result = handleStripeEvent({
				event,
				eventId: inputEventId(school, event.id, at),
				menu: worldMenu,
				menuVersion: 3,
				policy,
				policyVersion: 1,
				rows,
				revision,
				catalog,
				now: at,
				priceIds,
				invoiceIds,
				...(fee === undefined ? {} : { fee }),
			});
			if (result.rowChanges)
				({ rows, revision } = applyRowChanges({
					rows,
					revision,
					changes: result.rowChanges,
				}));
			results.push(result);
			events.push(...result.events);
			return result;
		},
	};
};

export const ofType = (events: readonly AtmEvent[], type: string): AtmEvent[] =>
	events.filter((event) => event.event_type === type);

export const typesOf = (events: readonly AtmEvent[]): string[] =>
	events.map((event) => event.event_type);

/** `policy` with B4 Uni's rate. */
export const withShare = (percent: number): BillingPolicy => ({
	...DEFAULT_POLICY,
	revenueShare: { percent },
});
