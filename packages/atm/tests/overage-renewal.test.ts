import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { commandOrg, DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	type BillingRow,
	rowChangesFromMutation,
	stateFromRows,
	subjectFromRows,
} from "../src/billing/rows.js";
import { menuToStripe } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { signStripePayload } from "../src/handler/stripe-signature.js";
import { handleStripeWebhook } from "../src/handler/stripe-webhook.js";
import type { SqlDatabase, WebhookResponse } from "../src/handler/types.js";
import {
	lapsedRows,
	mutationToEvents,
	recordEngineCommand,
	runEngineCommand,
} from "../src/index.js";
import type { RowChanges } from "../src/types.js";

/**
 * KNOWN GAP (verified 2026-11-05): a renewal invoice for a holder who is in overage is refused, and nothing a retry
 * does changes that.
 *
 * A caller can let a holder spend below zero: `overage_allowed` (and optionally `spend_limits`) on the customer row.
 * The renewal's `reset` then meets a negative row, and `mutationToEvents` throws "a reset cannot add more than it
 * refills (-N)" because the ledger has no event for forgiving an overdraft. `handleStripeEvent` turns the throw into a
 * `rejected` refusal, so the handler answers 422, releases the claim and writes nothing: no credits, no cycle move, no
 * `payment.succeeded`, and the invoice is never indexed.
 *
 * When this is fixed (the reset books the forgiven overage, or the row is kept, or the boundary refuses overage rows),
 * the tests marked KNOWN GAP below must change to expect the renewal to apply; the control tests and the recovery test
 * stay as they are. Design options: docs/usage-metering.md, "A reset forgives overage".
 *
 * Real events: the recorded sandbox deliveries of `schedule-decrease` (create, subscription events, then a
 * `subscription_cycle` renewal invoice that lowers 4 to 2), through the reference handler on an in-memory database.
 * The spend is the real path: `runEngineCommand` `track` with `commandOrg(policy)`, persisted under the revision check.
 */

const SCHOOL = "spike-school";
const SECRET = "whsec_recorded_test_secret";
const SECOND = 1000;
const FEATURE = "visit";
const INTERNAL_FEATURE = "feat_visit";
const TIER_ROW = "ce_tier_visit_month";
const SPEND_AT = 1_793_880_200_000;
const RENEWAL_RESET_AT = 1_796_472_126_001;
const EXPIRED_AFTER_PACK = 1_801_000_000_000;
const deliveredDir = join(
	import.meta.dir,
	"../fixtures/billing/stripe/recorded/delivered",
);

// biome-ignore lint/suspicious/noExplicitAny: recorded Stripe JSON is read by path, untyped
type Recorded = any;
const read = (path: string): Recorded =>
	JSON.parse(readFileSync(join(deliveredDir, path), "utf8"));

const menu = read("menu.json") as Menu;
const priceIdsByKey = read("prices.json") as Record<string, string>;
const priceIds: Record<string, string> = {};
for (const op of menuToStripe({
	schoolId: SCHOOL,
	menu,
	previous: null,
	policy: DEFAULT_POLICY,
})) {
	if (op.op === "price.create")
		priceIds[op.lookupKey] = priceIdsByKey[op.metadata.b4u_key ?? ""] as string;
}
const catalog = menuCatalogRows({ menu, school: SCHOOL, env: "test" });

const renewalInvoice = read("schedule-decrease/06-invoice.paid.json");
const renewalPayment = read("schedule-decrease/07-invoice_payment.paid.json");
const familyId: string =
	renewalInvoice.data.object.parent.subscription_details.metadata.family_id;
const customerId = `family:${familyId}`;
const subject = `${SCHOOL}|test|${customerId}`;
const identity = {
	orgId: SCHOOL,
	env: "test" as const,
	customerId,
	entityId: null,
};

const holderBeforeRenewal = () => {
	const db = bunSqlite(new Database(":memory:"));
	db.exec(HANDLER_DDL);
	const clock = { now: 0 };
	const deliver = (event: Recorded): WebhookResponse => {
		clock.now = (event.created + 1) * SECOND;
		const payload = JSON.stringify(event);
		return handleStripeWebhook(
			{
				db,
				secret: SECRET,
				schoolId: SCHOOL,
				nowMs: () => clock.now,
				workerId: "overage",
				env: "test",
				context: () => ({
					menu,
					menuVersion: 1,
					policy: DEFAULT_POLICY,
					policyVersion: 1,
					catalog,
					priceIds,
				}),
			},
			{
				payload,
				signatureHeader: signStripePayload({
					payload,
					secret: SECRET,
					timestampSeconds: event.created + 1,
				}),
			},
		);
	};
	for (const name of [
		"01-invoice.paid",
		"02-invoice_payment.paid",
		"03-customer.subscription.created",
		"04-customer.subscription.updated",
		"05-customer.subscription.updated",
	])
		expect(deliver(read(`schedule-decrease/${name}.json`)).status).toBe(200);
	return { db, deliver };
};

const load = (db: SqlDatabase): { rows: BillingRow[]; revision: number } => {
	const [current] = db.all<{ revision: number }>(
		"SELECT revision FROM atm_subjects WHERE subject_key = ?",
		[subject],
	);
	const stored = db.all<{ table_name: string; row_id: string; data: string }>(
		"SELECT table_name, row_id, data FROM atm_rows WHERE subject_key = ? ORDER BY table_name, row_id",
		[subject],
	);
	return {
		revision: current?.revision ?? 0,
		rows: stored.map((row) => ({
			table: row.table_name,
			id: row.row_id,
			data: JSON.parse(row.data),
		})) as BillingRow[],
	};
};

/** The write the handler makes: the revision check, then the upserts and deletes. */
const write = (db: SqlDatabase, changes: RowChanges): void => {
	const moved = db.run(
		"UPDATE atm_subjects SET revision = ? WHERE subject_key = ? AND revision = ?",
		[changes.nextRevision, subject, changes.expectedRevision],
	).changes;
	expect(moved).toBe(1);
	for (const upsert of changes.upserts)
		db.run(
			"INSERT INTO atm_rows (subject_key, table_name, row_id, data) VALUES (?, ?, ?, ?) ON CONFLICT (subject_key, table_name, row_id) DO UPDATE SET data = excluded.data",
			[subject, upsert.table, upsert.id, JSON.stringify(upsert.data)],
		);
};

/** A caller's own write of rows (the customer's controls, a pack lot, a rollover): one revision step. */
const putRows = (
	db: SqlDatabase,
	upserts: { table: string; id: string; data: unknown }[],
): void => {
	const { revision } = load(db);
	write(db, {
		subjectKey: subject,
		expectedRevision: revision,
		nextRevision: revision + 1,
		upserts,
		deletes: [],
	} as RowChanges);
};

const customerRowOf = (db: SqlDatabase): BillingRow =>
	load(db).rows.find((row) => row.table === "customer") as BillingRow;

const allowOverage = (
	db: SqlDatabase,
	extra: Record<string, unknown> = {},
): void => {
	const customer = customerRowOf(db);
	putRows(db, [
		{
			table: "customer",
			id: customer.id,
			data: {
				...customer.data,
				overage_allowed: [{ feature_id: FEATURE, enabled: true }],
				...extra,
			},
		},
	]);
};

let commandCount = 0;
const engineCommand = (type: string, fields: Record<string, unknown>) => {
	commandCount += 1;
	const commandId = `overage_${commandCount}`;
	return {
		schemaVersion: 1,
		type,
		org: commandOrg(DEFAULT_POLICY),
		commandId,
		requestId: commandId,
		identity,
		occurredAt: SPEND_AT,
		...fields,
	};
};

/** One `track` through the engine, persisted under the revision check. Returns the engine's result. */
const track = (db: SqlDatabase, value: number): { status: string } => {
	const { rows, revision } = load(db);
	const decision = runEngineCommand({
		subject: subjectFromRows({ identity, revision, rows, catalog }),
		command: engineCommand("track", {
			featureId: FEATURE,
			internalFeatureId: INTERNAL_FEATURE,
			value,
			overageBehavior: "reject",
			properties: null,
			usageEvent: null,
		}) as never,
	}) as unknown as { type: string; result: { status: string } };
	if (decision.type !== "mutation") throw new Error("track made no mutation");
	if (decision.result.status !== "rejected")
		write(
			db,
			rowChangesFromMutation({
				mutation: decision as never,
				rows,
				revision,
			}),
		);
	return decision.result;
};

const balances = (db: SqlDatabase): Record<string, number> =>
	Object.fromEntries(
		load(db)
			.rows.filter((row) => row.table === "customerEntitlements")
			.map((row) => [row.id, (row.data as { balance: number }).balance]),
	);

const rolloverBalances = (db: SqlDatabase): number[] =>
	load(db)
		.rows.filter((row) => row.table === "rollovers")
		.map((row) => (row.data as { balance: number }).balance);

const grantsOf = (db: SqlDatabase) =>
	load(db).rows.find((row) => row.table === "atm_grants")?.data as {
		cycleStart: number;
		cycleEnd: number;
		quantity: number;
		invoices: Record<string, unknown>;
	};

/** What a renewal changes or does not: rows, revision, cycle, invoice record, outbox, claims. */
const snapshot = (db: SqlDatabase) => {
	const grants = grantsOf(db);
	return {
		revision: load(db).revision,
		balances: balances(db),
		rollovers: rolloverBalances(db),
		cycleStart: grants.cycleStart,
		cycleEnd: grants.cycleEnd,
		quantity: grants.quantity,
		invoices: Object.keys(grants.invoices).length,
		outbox: db
			.all<{ body: string }>("SELECT body FROM ledger_outbox")
			.map((row) => (JSON.parse(row.body) as { event_type: string }).event_type)
			.sort(),
		claims: db.all<{ event_id: string }>(
			"SELECT event_id FROM atm_event_claims ORDER BY event_id",
		).length,
	};
};

const addPackAndRollover = (db: SqlDatabase): void => {
	const tier = load(db).rows.find((row) => row.id === TIER_ROW) as BillingRow;
	putRows(db, [
		{
			table: "customerEntitlements",
			id: "ce_pack",
			data: {
				...tier.data,
				id: "ce_pack",
				balance: 5,
				next_reset_at: null,
				expires_at: 1_800_000_000_000,
			},
		},
		{
			table: "rollovers",
			id: "roll_1",
			data: {
				id: "roll_1",
				cus_ent_id: TIER_ROW,
				balance: 3,
				usage: 0,
				expires_at: 1_798_000_000_000,
				entities: {},
			},
		},
	]);
};

const REFILLS_CAP_MESSAGE = "a reset cannot add more than it refills";

/** A renewal that is refused: 422, the cause, and the same answer however often Stripe retries. */
const expectRefusedEveryTime = (
	db: SqlDatabase,
	deliver: (event: Recorded) => WebhookResponse,
	overdrawnBy: number,
) => {
	const before = snapshot(db);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const response = deliver(renewalInvoice);
		expect(response.status).toBe(422);
		expect(response.body).toMatchObject({
			outcome: "refused",
			reason: "rejected",
			message: `${REFILLS_CAP_MESSAGE} (-${overdrawnBy})`,
		});
		// nothing written, and the claim is released, so the next delivery runs the handler again (it is not `duplicate`)
		expect(snapshot(db)).toEqual(before);
	}
	// its payment can never be linked: the invoice is not indexed
	const payment = deliver(renewalPayment);
	expect(payment.status).toBe(409);
	expect(payment.body.outcome).toBe("unmatched_invoice");
};

describe("a renewal for a holder in overage", () => {
	test("control: with overage allowed, a balance at zero or above renews (4 becomes the lower grant 2)", () => {
		const atZero = holderBeforeRenewal();
		allowOverage(atZero.db);
		expect(track(atZero.db, 4).status).toBe("applied");
		expect(balances(atZero.db)).toEqual({ [TIER_ROW]: 0 });
		const renewed = atZero.deliver(renewalInvoice);
		expect(renewed.status).toBe(200);
		expect(renewed.body.outcome).toBe("applied");
		expect(balances(atZero.db)).toEqual({ [TIER_ROW]: 2 });
		expect(atZero.deliver(renewalInvoice).body.outcome).toBe("duplicate");
		expect(atZero.deliver(renewalPayment).body.outcome).toBe("applied");

		const positive = holderBeforeRenewal();
		allowOverage(positive.db);
		expect(track(positive.db, 1).status).toBe("applied");
		expect(positive.deliver(renewalInvoice).body.outcome).toBe("applied");
		expect(balances(positive.db)).toEqual({ [TIER_ROW]: 2 });
	});

	test("KNOWN GAP: overage allowed, no spend limit, balance -30: the renewal is refused 422 on every retry and nothing changes", () => {
		const { db, deliver } = holderBeforeRenewal();
		allowOverage(db);
		expect(track(db, 34).status).toBe("applied");
		expect(balances(db)).toEqual({ [TIER_ROW]: -30 });
		const before = snapshot(db);
		expect(before.cycleEnd).toBe(1_796_472_126_000);
		expect(before.invoices).toBe(1);
		expectRefusedEveryTime(db, deliver, 30);
		// still the old cycle, no credits, no new invoice record, no payment.succeeded or credit events
		expect(balances(db)).toEqual({ [TIER_ROW]: -30 });
		expect(grantsOf(db).cycleEnd).toBe(1_796_472_126_000);
		expect(snapshot(db).outbox).toEqual(before.outbox);
	});

	test("KNOWN GAP: with spend_limits overage_limit 20, balance -20: refused the same way", () => {
		const { db, deliver } = holderBeforeRenewal();
		allowOverage(db, {
			spend_limits: [{ feature_id: FEATURE, enabled: true, overage_limit: 20 }],
		});
		// 30 is more overage than the limit lets in; 24 takes the balance to the limit
		expect(track(db, 30).status).toBe("rejected");
		expect(track(db, 24).status).toBe("applied");
		expect(balances(db)).toEqual({ [TIER_ROW]: -20 });
		expectRefusedEveryTime(db, deliver, 20);
	});

	test("overage lands on the tier row only (a rollover and a pack lot are drained first); a positive pack or rollover does not offset it", () => {
		const control = holderBeforeRenewal();
		addPackAndRollover(control.db);
		expect(control.deliver(renewalInvoice).body.outcome).toBe("applied");
		// the renewal resets the tier row (4 to 2) and leaves the pack lot and the rollover alone
		expect(balances(control.db)).toEqual({ ce_pack: 5, [TIER_ROW]: 2 });
		expect(rolloverBalances(control.db)).toEqual([3]);

		const drawn = holderBeforeRenewal();
		addPackAndRollover(drawn.db);
		allowOverage(drawn.db);
		expect(track(drawn.db, 20).status).toBe("applied");
		expect(balances(drawn.db)).toEqual({ ce_pack: 0, [TIER_ROW]: -8 });
		expect(rolloverBalances(drawn.db)).toEqual([0]);
		expectRefusedEveryTime(drawn.db, drawn.deliver, 8);

		// a pack lot or rollover that arrives after the overage sits beside the negative tier row, and changes nothing
		const later = holderBeforeRenewal();
		allowOverage(later.db);
		expect(track(later.db, 12).status).toBe("applied");
		addPackAndRollover(later.db);
		expect(balances(later.db)).toEqual({ ce_pack: 5, [TIER_ROW]: -8 });
		expectRefusedEveryTime(later.db, later.deliver, 8);
	});

	test("persist_free_overage is not reachable from the handler, and on it the reset still cannot be booked", () => {
		const { db } = holderBeforeRenewal();
		allowOverage(db);
		track(db, 34);
		const { rows, revision } = load(db);
		const before = stateFromRows({ identity, revision, rows });
		const resetWith = (persist: boolean) => {
			const config = {
				...commandOrg(DEFAULT_POLICY).config,
				persist_free_overage: persist,
			};
			const mutation = runEngineCommand({
				subject: subjectFromRows({ identity, revision, rows, catalog }),
				command: engineCommand("reset", {
					org: { config },
					occurredAt: RENEWAL_RESET_AT,
				}) as never,
			}) as never;
			const [row] = rowChangesFromMutation({
				mutation,
				rows,
				revision,
			}).upserts;
			return {
				mutation,
				balance: (row?.data as { balance: number }).balance,
			};
		};
		for (const [persist, balance] of [
			[false, 4],
			[true, -26],
		] as const) {
			const reset = resetWith(persist);
			expect(reset.balance).toBe(balance);
			expect(() =>
				mutationToEvents({
					mutation: reset.mutation,
					context: {
						school: SCHOOL,
						tz: "UTC",
						feature: FEATURE,
						plan: "shine@v1",
						before: before as never,
					},
				}),
			).toThrow(`${REFILLS_CAP_MESSAGE} (-30)`);
		}
		// the renewal's own reset command carries `ORG` in grants.ts, which sets no `persist_free_overage`, and
		// `BillingPolicy` has no such field: the flag is off on the handler path (balance 4 above, never -26)
		expect(Object.keys(DEFAULT_POLICY)).not.toContain("persist_free_overage");
	});

	test("a row past its expiry while negative is not lapsed: no credit.expired, nothing closes it", () => {
		const { db } = holderBeforeRenewal();
		addPackAndRollover(db);
		const pack = load(db).rows.find(
			(row) => row.id === "ce_pack",
		) as BillingRow;
		putRows(db, [
			{
				table: "customerEntitlements",
				id: "ce_pack",
				data: { ...pack.data, balance: -3 },
			},
		]);
		const { rows, revision } = load(db);
		const lapsed = lapsedRows({
			state: stateFromRows({ identity, revision, rows }) as never,
			featureOf: (internalFeatureId) =>
				internalFeatureId === INTERNAL_FEATURE ? FEATURE : undefined,
			feature: FEATURE,
			atMs: EXPIRED_AFTER_PACK,
		});
		// the positive rollover lapses; the pack lot at -3 is skipped (`lapsedRows` takes balance > 0 only)
		expect(lapsed.map((row) => row.id)).toEqual(["roll_1"]);
	});

	test("recovery without a code change: zero the row with an updateBalance (booked credit.adjusted), then re-send the renewal", () => {
		const { db, deliver } = holderBeforeRenewal();
		allowOverage(db);
		track(db, 34);
		expect(deliver(renewalInvoice).status).toBe(422);
		const { rows, revision } = load(db);
		const mutation = runEngineCommand({
			subject: subjectFromRows({ identity, revision, rows, catalog }),
			command: engineCommand("updateBalance", {
				featureId: FEATURE,
				internalFeatureId: INTERNAL_FEATURE,
				customerEntitlementFilters: { cusEntIds: [TIER_ROW] },
				addToBalance: 30,
			}) as never,
		}) as never;
		db.transaction(() => {
			write(db, rowChangesFromMutation({ mutation, rows, revision }));
			const recorded = recordEngineCommand({
				db,
				mutation,
				before: stateFromRows({ identity, revision, rows }) as never,
				context: {
					tz: "UTC",
					feature: FEATURE,
					reason: "forgive overage before the renewal",
				},
			});
			expect(recorded.events.map((event) => event.event_type)).toEqual([
				"credit.adjusted",
			]);
		});
		expect(balances(db)).toEqual({ [TIER_ROW]: 0 });
		const renewed = deliver(renewalInvoice);
		expect(renewed.status).toBe(200);
		expect(renewed.body.outcome).toBe("applied");
		expect(balances(db)).toEqual({ [TIER_ROW]: 2 });
		expect(deliver(renewalPayment).body.outcome).toBe("applied");
	});
});
