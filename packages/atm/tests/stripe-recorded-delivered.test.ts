import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { menuToStripe } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { signStripePayload } from "../src/handler/stripe-signature.js";
import { handleStripeWebhook } from "../src/handler/stripe-webhook.js";
import type {
	WebhookContext,
	WebhookDeps,
	WebhookResponse,
} from "../src/handler/types.js";

/**
 * Webhook deliveries recorded from a Stripe sandbox (test mode, endpoint pinned to 2025-10-29.clover), scrubbed.
 * Unlike the older files in `recorded/`, these are whole events as Stripe delivered them: the envelope is real. Each
 * scenario directory is one family's events in the order Stripe created them. See `recorded/README.md`.
 */

const SCHOOL = "spike-school";
const SECRET = "whsec_recorded_test_secret";
const API = "2025-10-29.clover";
const SECOND = 1000;
const MAX_PASSES = 4;
const deliveredDir = join(
	import.meta.dir,
	"../fixtures/billing/stripe/recorded/delivered",
);

// biome-ignore lint/suspicious/noExplicitAny: recorded Stripe JSON is read by path, untyped
type Recorded = any;

const read = (path: string): Recorded =>
	JSON.parse(readFileSync(join(deliveredDir, path), "utf8"));

const scenarioFiles = (scenario: string): string[] =>
	readdirSync(join(deliveredDir, scenario))
		.filter((name) => name.endsWith(".json"))
		.sort();

const scenarioEvents = (scenario: string): Recorded[] =>
	scenarioFiles(scenario).map((name) => read(`${scenario}/${name}`));

const SCENARIOS = readdirSync(deliveredDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

const menu = read("menu.json") as Menu;
const priceIdsByKey = read("prices.json") as Record<string, string>;

/** Stripe price ids by lookup key: the menu's own `menuToStripe` names each price's key, `prices.json` has its id. */
const priceIds = (): Record<string, string> => {
	const ids: Record<string, string> = {};
	for (const op of menuToStripe({
		schoolId: SCHOOL,
		menu,
		previous: null,
		policy: DEFAULT_POLICY,
	})) {
		if (op.op !== "price.create") continue;
		const priceId = priceIdsByKey[op.metadata.b4u_key ?? ""];
		if (!priceId) throw new Error(`no recorded price for ${op.lookupKey}`);
		ids[op.lookupKey] = priceId;
	}
	return ids;
};

const context = (): WebhookContext => ({
	menu,
	menuVersion: 1,
	policy: DEFAULT_POLICY,
	policyVersion: 1,
	catalog: menuCatalogRows({ menu, school: SCHOOL }),
	priceIds: priceIds(),
});

const harness = () => {
	const db = bunSqlite(new Database(":memory:"));
	db.exec(HANDLER_DDL);
	const clock = { now: 0 };
	const deps: WebhookDeps = {
		db,
		secret: SECRET,
		schoolId: SCHOOL,
		nowMs: () => clock.now,
		workerId: "recorded",
		context,
	};
	const deliver = (event: Recorded): WebhookResponse => {
		clock.now = (event.created + 1) * SECOND;
		const payload = JSON.stringify(event);
		return handleStripeWebhook(deps, {
			payload,
			signatureHeader: signStripePayload({
				payload,
				secret: SECRET,
				timestampSeconds: event.created + 1,
			}),
		});
	};
	return { db, deliver };
};

/** Delivers in order, then retries the retryable 409s, as Stripe does, until none are left. */
const deliverAll = (
	deliver: (event: Recorded) => WebhookResponse,
	events: Recorded[],
): WebhookResponse[] => {
	let pending = events;
	const final: WebhookResponse[] = [];
	for (let pass = 0; pass < MAX_PASSES && pending.length > 0; pass += 1) {
		const retry: Recorded[] = [];
		for (const event of pending) {
			const response = deliver(event);
			if (response.status === 409) retry.push(event);
			else final.push(response);
		}
		pending = retry;
	}
	expect(pending.map((event) => event.id)).toEqual([]);
	return final;
};

const familyOf = (events: Recorded[]): string => {
	for (const event of events) {
		const object = event.data.object;
		const metadata =
			object.parent?.subscription_details?.metadata ?? object.metadata;
		if (metadata?.family_id) return metadata.family_id;
	}
	throw new Error("no family in the events");
};

type Rows = { entitlements: Record<string, number>; grants: Recorded };

const rowsOf = (db: ReturnType<typeof harness>["db"], family: string): Rows => {
	const subject = `${SCHOOL}|live|family:${family}`;
	const entitlements: Record<string, number> = {};
	for (const row of db.all<{ row_id: string; data: string }>(
		"SELECT row_id, data FROM atm_rows WHERE subject_key = ? AND table_name = 'customerEntitlements'",
		[subject],
	))
		entitlements[row.row_id] = JSON.parse(row.data).balance;
	const [grants] = db.all<{ data: string }>(
		"SELECT data FROM atm_rows WHERE subject_key = ? AND table_name = 'atm_grants'",
		[subject],
	);
	return { entitlements, grants: grants ? JSON.parse(grants.data) : null };
};

const replay = (scenario: string) => {
	const { db, deliver } = harness();
	const events = scenarioEvents(scenario);
	const responses = deliverAll(deliver, events);
	return { db, deliver, events, responses, ...rowsOf(db, familyOf(events)) };
};

const GIFT_LOT_PATTERN = /^ce_gift_.*_gift-visit_visit$/;

describe("recorded deliveries (2025-10-29.clover)", () => {
	test("the scenario directories are the ones this file expects", () => {
		expect(SCENARIOS).toEqual([
			"dispute-lost",
			"dispute-won",
			"full-refund",
			"gift-checkout-and-portal",
			"partial-refund",
			"schedule-decrease",
			"tier-and-quantity-change",
			"yearly-raise",
		]);
	});

	test.each(SCENARIOS)(
		"%s: whole events from the pinned endpoint",
		(scenario) => {
			const events = scenarioEvents(scenario);
			expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
			for (const event of events) {
				expect(event.object).toBe("event");
				expect(event.api_version).toBe(API);
				expect(event.livemode).toBe(false);
				expect(event.id).toMatch(/^evt_/);
			}
			const created = events.map((event) => event.created);
			expect(created).toEqual([...created].sort((a, b) => a - b));
		},
	);

	test.each(SCENARIOS)(
		"%s: every delivery ends 200 once retried",
		(scenario) => {
			const { responses } = replay(scenario);
			expect(responses.length).toBeGreaterThan(0);
			for (const response of responses) {
				expect(response.status).toBe(200);
				expect(["applied", "duplicate", "ignored"]).toContain(
					response.body.outcome,
				);
			}
		},
	);

	test("a tier change and a quantity change in one update: sparkle x2 to shine x4 grants the 2 extra units", () => {
		const { entitlements, grants } = replay("tier-and-quantity-change");
		expect(grants.tierId).toBe("shine");
		expect(grants.quantity).toBe(4);
		expect(entitlements).toEqual({ ce_tier_visit_month: 4 });
	});

	test("a raise 2 to 4 on a yearly plan grants the prorated year: 24 for the create, 19 for the raise", () => {
		const { entitlements, grants } = replay("yearly-raise");
		expect(grants.interval).toBe("year");
		expect(grants.quantity).toBe(4);
		expect(entitlements).toEqual({ ce_tier_visit_year: 43 });
	});

	test("a decrease through a subscription schedule leaves the credits until the renewal, which resets to the lower count", () => {
		const { entitlements, grants } = replay("schedule-decrease");
		expect(grants.quantity).toBe(2);
		expect(entitlements).toEqual({ ce_tier_visit_month: 2 });
	});

	test("a full refund takes the unused credits back; a partial refund changes nothing", () => {
		expect(replay("full-refund").entitlements).toEqual({
			ce_tier_visit_month: 0,
		});
		expect(replay("partial-refund").entitlements).toEqual({
			ce_tier_visit_month: 2,
		});
	});

	test("a lost dispute takes the unused credits back; a won one changes nothing", () => {
		expect(replay("dispute-lost").entitlements).toEqual({
			ce_tier_visit_month: 0,
		});
		expect(replay("dispute-won").entitlements).toEqual({
			ce_tier_visit_month: 2,
		});
	});

	test("a Checkout with a gift line grants the tier and a separate gift lot; a portal raise adds 2; a portal decrease waits for the renewal", () => {
		const { entitlements, grants } = replay("gift-checkout-and-portal");
		const giftLots = Object.entries(entitlements).filter(([id]) =>
			GIFT_LOT_PATTERN.test(id),
		);
		expect(giftLots.map(([, balance]) => balance)).toEqual([1]);
		expect(entitlements.ce_tier_visit_month).toBe(4);
		expect(grants.quantity).toBe(4);
		expect(grants.addonIds).toEqual([]);
	});

	test("as delivered, a payment link and its invoice arrive in either order, and a refund waits for the link", () => {
		const events = scenarioEvents("full-refund");
		const byType = (type: string): Recorded =>
			events.find((event) => event.type === type);
		const { db, deliver } = harness();
		expect(deliver(byType("customer.subscription.created")).status).toBe(200);
		expect(deliver(byType("invoice_payment.paid")).body.outcome).toBe(
			"unmatched_invoice",
		);
		expect(deliver(byType("invoice.paid")).body.outcome).toBe("applied");
		expect(deliver(byType("charge.refunded")).body.outcome).toBe(
			"unmatched_payment",
		);
		expect(deliver(byType("invoice_payment.paid")).body.outcome).toBe(
			"applied",
		);
		expect(deliver(byType("charge.refunded")).body.outcome).toBe("applied");
		expect(rowsOf(db, familyOf(events)).entitlements).toEqual({
			ce_tier_visit_month: 0,
		});
		expect(deliver(byType("charge.refunded")).body.outcome).toBe("duplicate");
	});

	test.each(SCENARIOS)(
		"%s: nothing of the account is left in the files",
		(scenario) => {
			for (const name of scenarioFiles(scenario)) {
				const text = readFileSync(join(deliveredDir, scenario, name), "utf8");
				expect(text).not.toMatch(
					/DsfMqSNUOE|trycloudflare|whsec_|sk_test_|rk_test_/,
				);
				for (const account of text.match(/acct_[A-Za-z0-9]+/g) ?? [])
					expect(account).toBe("acct_Scrubbed");
				for (const email of text.match(/[\w.+-]+@[\w.-]+/g) ?? [])
					expect(email).toBe("member@example.test");
				for (const link of text.match(/https?:\/\/[^"\s]+/g) ?? [])
					expect(link).toMatch(/^https:\/\/example\.test\//);
			}
		},
	);
});
