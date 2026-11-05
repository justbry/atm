import { describe, expect, test } from "bun:test";
import type { SubjectState } from "@autumn/balance-engine";
import { catalogRows, generateYear } from "../fixtures/vibes.js";
import { ulidTime } from "../src/ledger/ids.js";
import {
	lapsedRows,
	lapseEvent,
	ledgerEvent,
	mutationToEvents,
} from "../src/ledger/postings.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import { decimalToUnits, localDate } from "../src/ledger/util.js";
import type {
	AtmEvent,
	AtmEventContext,
	AtmEventType,
	AtmLedgerEventInput,
} from "../src/types.js";

const SCHOOL = "sch_vol";
const catalog = toCatalog(catalogRows());
const identity = {
	orgId: SCHOOL,
	env: "live",
	customerId: "family:fam_t",
	entityId: null,
};
const org = {
	config: {
		reverse_deduction_order: false,
		block_overdue_entitlements: false,
		include_past_due: true,
	},
};
const T = Date.UTC(2026, 0, 5, 17, 0, 0);
const DAY = 86_400_000;
const ctx: AtmEventContext = {
	school: SCHOOL,
	tz: "America/Denver",
	feature: "visit",
	plan: "sparkle-2@v1",
	service: "massage-90",
};

let n = 0;
const cmd = (type: string, t: number, extra: Record<string, unknown> = {}) => {
	n += 1;
	return {
		schemaVersion: 1,
		type,
		org,
		commandId: `c${n}`,
		requestId: `r${n}`,
		identity,
		occurredAt: t,
		...extra,
	};
};
const attach = (
	balance: number,
	entitlement: string,
	resetAt: number,
	state: SubjectState | null = null,
) =>
	runOnState({
		state,
		catalog,
		command: cmd("applyBillingPlan", T, {
			entityIds: [],
			expiringPooledBalanceIds: [],
			ops: [
				{
					op: "insert",
					table: "customer",
					row: {
						internal_id: "cus_t",
						id: identity.customerId,
						config: null,
						spend_limits: null,
						overage_allowed: null,
						usage_limits: null,
						usage_alerts: null,
						processor: null,
					},
				},
				{
					op: "insert",
					table: "customerProducts",
					row: {
						id: "cp_1",
						internal_customer_id: "cus_t",
						internal_product_id:
							entitlement === "ent_s2" ? "prod_sparkle-2" : "prod_sparkle-1",
						internal_entity_id: null,
						status: "active",
						options: [],
						quantity: 1,
						created_at: T,
						starts_at: T,
						access_starts_at: null,
						ended_at: null,
						customer_license_link_id: null,
					},
				},
				{
					op: "insert",
					table: "customerEntitlements",
					row: {
						id: "ce_1",
						customer_product_id: "cp_1",
						entitlement_id: entitlement,
						internal_customer_id: "cus_t",
						internal_entity_id: null,
						internal_feature_id: "feat_visit",
						balance,
						adjustment: 0,
						additional_balance: 0,
						unlimited: false,
						usage_allowed: false,
						next_reset_at: resetAt,
						reset_cycle_anchor: null,
						expires_at: null,
						external_id: null,
						created_at: T,
					},
				},
			],
		}),
	});
const hold = (state: SubjectState, t: number, lock = "bk_1") =>
	runOnState({
		state,
		catalog,
		command: cmd("track", t, {
			featureId: "visit",
			internalFeatureId: "feat_visit",
			value: 1,
			overageBehavior: "reject",
			properties: null,
			usageEvent: null,
			lock: {
				id: `lock_${lock}`,
				lockId: lock,
				expiresAt: t + DAY,
				expiryAction: "confirm",
			},
		}),
	});
const lockOf = (m: {
	changes: { table: string; op: string; row?: unknown }[];
}) => m.changes.find((c) => c.table === "locks" && c.op === "insert")?.row;
const events = (
	run: ReturnType<typeof runOnState>,
	c: Partial<AtmEventContext> = {},
	before?: SubjectState | null,
) =>
	mutationToEvents({
		mutation: run.mutation as never,
		context: { ...ctx, before: (before ?? null) as never, ...c },
	});

const sumsToZero = (e: AtmEvent) => {
	const by = new Map<string, bigint>();
	for (const p of e.postings)
		by.set(
			p.commodity,
			(by.get(p.commodity) ?? 0n) +
				decimalToUnits(p.amount, p.commodity === "USD" ? 2 : 0),
		);
	return [...by.values()].every((v) => v === 0n);
};
const lines = (e: AtmEvent) =>
	e.postings.map((p) => `${p.account} ${p.amount} ${p.commodity}`);

const base = {
	school: SCHOOL,
	tz: "America/Denver",
	eventTime: "2026-11-03T17:02:11Z",
	key: "family:fam_t",
};
const money = (
	input: Partial<AtmLedgerEventInput> & { type: AtmEventType },
): AtmEvent => ledgerEvent({ ...base, idem: `x:${input.type}`, ...input });

describe("one rule per event type", () => {
	test("payment.succeeded: net to assets:stripe, the fee, the gross as income", () => {
		const e = money({
			type: "payment.succeeded",
			amount: 26000,
			fee: 784,
			incomeKind: "membership:sparkle-2",
		});
		expect(lines(e)).toEqual([
			"assets:stripe 252.16 USD",
			"expenses:billing:stripe-fees 7.84 USD",
			"income:billing:membership:sparkle-2 -260.00 USD",
		]);
	});
	test("payment.refunded: the reverse, to income:billing:refunds", () => {
		expect(lines(money({ type: "payment.refunded", amount: 13000 }))).toEqual([
			"assets:stripe -130.00 USD",
			"income:billing:refunds 130.00 USD",
		]);
	});
	test("payment.disputed and dispute.closed", () => {
		expect(lines(money({ type: "payment.disputed", amount: 13000 }))).toEqual([
			"assets:stripe -130.00 USD",
			"expenses:billing:disputes 130.00 USD",
		]);
		expect(
			lines(money({ type: "dispute.closed", amount: 13000, won: true })),
		).toEqual([
			"assets:stripe 130.00 USD",
			"expenses:billing:disputes -130.00 USD",
		]);
		expect(
			money({ type: "dispute.closed", amount: 13000, won: false }).postings,
		).toEqual([]);
	});
	test("payout.paid", () => {
		expect(lines(money({ type: "payout.paid", amount: 50000 }))).toEqual([
			"assets:stripe -500.00 USD",
			"assets:clearing:stripe-payouts 500.00 USD",
		]);
	});
	test("fundraise.received and fundraise.paid_out", () => {
		expect(
			lines(
				money({
					type: "fundraise.received",
					amount: 2500,
					campaign: "spring-gala",
				}),
			),
		).toEqual([
			"assets:clearing:zeffy 25.00 USD",
			"income:fundraising:spring-gala -25.00 USD",
		]);
		expect(lines(money({ type: "fundraise.paid_out", amount: 2500 }))).toEqual([
			"assets:clearing:zeffy -25.00 USD",
			"assets:clearing:zeffy-payouts 25.00 USD",
		]);
	});
	test("share.charged", () => {
		expect(lines(money({ type: "share.charged", amount: 1200 }))).toEqual([
			"expenses:billing:b4uni-share 12.00 USD",
			"liabilities:b4uni -12.00 USD",
		]);
	});
	test("the events with no postings have none", () => {
		for (const type of [
			"plan.attached",
			"plan.changed",
			"plan.canceled",
			"subject.erased",
			"referral.qualified",
			"referral.rewarded",
			"catalog.published",
			"policy.published",
		] as const) {
			expect(money({ type }).postings).toEqual([]);
		}
	});
	test("a payment's redacted copy drops the personal fields; the payload keeps them", () => {
		const e = money({
			type: "payment.succeeded",
			amount: 100,
			fee: 0,
			incomeKind: "x",
			payload: { id: "in_1", billing_email: "a@b.test", amount_paid: 100 },
		});
		expect(e.payload.billing_email).toBe("a@b.test");
		expect(e.redacted).toEqual({ id: "in_1", amount_paid: 100 });
	});
	test("an engine event type is refused by ledgerEvent", () => {
		expect(() => money({ type: "credit.held" })).toThrow(/mutationToEvents/);
	});

	test("credit.granted: a plan attach", () => {
		const run = attach(2, "ent_s2", T + 30 * DAY);
		const [e] = events(run);
		expect(e?.event_type).toBe("credit.granted");
		expect(lines(e as AtmEvent)).toEqual([
			"credits:avail:family:fam_t:visit 2 VISIT",
			"credits:issued:sparkle-2@v1 -2 VISIT",
		]);
	});
	test("credit.held, credit.released, credit.spent, credit.forfeited", () => {
		const a = attach(2, "ent_s2", T + 30 * DAY);
		const h = hold(a.state as SubjectState, T + DAY);
		const [held] = events(h);
		expect(held?.event_type).toBe("credit.held");
		expect(lines(held as AtmEvent)).toEqual([
			"credits:avail:family:fam_t:visit -1 VISIT",
			"credits:held:family:fam_t:visit 1 VISIT",
		]);
		expect(held?.labels.booking).toBe("bk_1");

		const settle = (finalValue: number | null) =>
			runOnState({
				state: h.state,
				catalog,
				command: cmd("finalize", T + 2 * DAY, {
					lock: lockOf(h.mutation as never),
					internalFeatureId: "feat_visit",
					finalValue,
					properties: null,
				}),
			});
		const [released] = events(settle(0));
		expect(released?.event_type).toBe("credit.released");
		expect(lines(released as AtmEvent)).toEqual([
			"credits:avail:family:fam_t:visit 1 VISIT",
			"credits:held:family:fam_t:visit -1 VISIT",
		]);
		const [spent] = events(settle(null));
		expect(spent?.event_type).toBe("credit.spent");
		expect(lines(spent as AtmEvent)).toEqual([
			"credits:held:family:fam_t:visit -1 VISIT",
			"credits:spent:massage-90 1 VISIT",
		]);
		const [forfeited] = events(settle(null), { settleAs: "forfeited" });
		expect(lines(forfeited as AtmEvent)).toEqual([
			"credits:held:family:fam_t:visit -1 VISIT",
			"credits:forfeited 1 VISIT",
		]);

		const expired = runOnState({
			state: h.state,
			catalog,
			command: cmd("confirmExpiredLock", T + 3 * DAY, {
				lock: { id: "lock_bk_1", lock_id: "bk_1" },
			}),
		});
		expect(() => events(expired)).toThrow(/context\.held/);
		const [noshow] = events(expired, { held: 1 });
		expect(noshow?.event_type).toBe("credit.forfeited");
		expect(lines(noshow as AtmEvent)).toEqual([
			"credits:held:family:fam_t:visit -1 VISIT",
			"credits:forfeited 1 VISIT",
		]);
	});
	test("credit.refunded and credit.adjusted: updateBalance", () => {
		const a = attach(2, "ent_s2", T + 30 * DAY);
		const up = (addToBalance: number) =>
			runOnState({
				state: a.state,
				catalog,
				command: cmd("updateBalance", T + DAY, {
					featureId: "visit",
					internalFeatureId: "feat_visit",
					addToBalance,
				}),
			});
		const [refunded] = events(up(1), { as: "refunded" });
		expect(refunded?.event_type).toBe("credit.refunded");
		expect(lines(refunded as AtmEvent)).toEqual([
			"credits:spent:massage-90 -1 VISIT",
			"credits:avail:family:fam_t:visit 1 VISIT",
		]);
		const [down] = events(up(-1), { reason: "refund of payment" });
		expect(down?.event_type).toBe("credit.adjusted");
		expect(lines(down as AtmEvent)).toEqual([
			"credits:avail:family:fam_t:visit -1 VISIT",
			"credits:adjust 1 VISIT",
		]);
		expect(down?.payload.reason).toBe("refund of payment");
		expect(() => events(up(-1))).toThrow(/reason/);
		const [up1] = events(up(1), { reason: "goodwill" });
		expect(lines(up1 as AtmEvent)).toEqual([
			"credits:avail:family:fam_t:visit 1 VISIT",
			"credits:adjust -1 VISIT",
		]);
	});
	test("credit.expired: a reset books what does not roll over, then grants the new cycle", () => {
		// sparkle-1 rolls over at most 1: of 2 left, 1 rolls and 1 expires
		const a = attach(2, "ent_s1", T + DAY);
		const r = runOnState({
			state: a.state,
			catalog,
			command: cmd("reset", T + DAY + 5000),
		});
		const out = events(r, { plan: "sparkle-1@v1" }, a.state);
		expect(out.map((e) => e.event_type)).toEqual([
			"credit.expired",
			"credit.granted",
		]);
		expect(lines(out[0] as AtmEvent)).toEqual([
			"credits:avail:family:fam_t:visit -1 VISIT",
			"credits:expired 1 VISIT",
		]);
		expect(lines(out[1] as AtmEvent)).toEqual([
			"credits:avail:family:fam_t:visit 1 VISIT",
			"credits:issued:sparkle-1@v1 -1 VISIT",
		]);
		expect(out[1]?.labels.rolled_over).toBe("1");
		expect(out[1]?.labels.expires_at).toBeDefined();
	});
	test("credit.expired: a row the clock lapsed", () => {
		const a = attach(1, "ent_s2", T + 30 * DAY);
		const state = JSON.parse(JSON.stringify(a.state)) as SubjectState;
		Object.assign(state.customerEntitlements[0] as object, {
			expires_at: T + DAY,
			balance: 1,
		});
		const rows = lapsedRows({
			state,
			featureOf: (i) => catalog.features[i]?.id,
			feature: "visit",
			atMs: T + 2 * DAY,
		});
		expect(rows).toHaveLength(1);
		const e = lapseEvent({
			row: rows[0] as never,
			holder: identity.customerId,
			key: identity.customerId,
			feature: "visit",
			school: SCHOOL,
			tz: "America/Denver",
			revision: 3,
		});
		expect(lines(e)).toEqual([
			"credits:avail:family:fam_t:visit -1 VISIT",
			"credits:expired 1 VISIT",
		]);
		expect(e.event_time).toBe(
			new Date(T + DAY).toISOString().replace(".000", ""),
		);
	});
	test("a mutation that moves nothing makes no events; a spend without a hold is refused", () => {
		const a = attach(2, "ent_s2", T + 30 * DAY);
		const up = runOnState({
			state: a.state,
			catalog,
			command: cmd("updateBalance", T + DAY, {
				featureId: "visit",
				internalFeatureId: "feat_visit",
				nextResetAt: T + 40 * DAY,
			}),
		});
		expect(events(up)).toEqual([]);
		const lockless = runOnState({
			state: a.state,
			catalog,
			command: cmd("track", T + DAY, {
				featureId: "visit",
				internalFeatureId: "feat_visit",
				value: 1,
				overageBehavior: "reject",
				properties: null,
				usageEvent: null,
			}),
		});
		expect(() => events(lockless)).toThrow(/hold first/);
	});
});

describe("every event", () => {
	const year = generateYear({ seed: 1 }).events;
	test("with postings sums to zero per commodity, and has none or at least two", () => {
		expect(year.filter((e) => e.postings.length > 0).length).toBeGreaterThan(
			50,
		);
		for (const e of year) {
			expect(e.postings.length === 0 || e.postings.length >= 2).toBe(true);
			expect(sumsToZero(e)).toBe(true);
		}
	});
	test("has an id whose time is its event time, and a date in its zone", () => {
		for (const e of year) {
			expect(ulidTime(e.id)).toBe(Date.parse(e.event_time));
			expect(e.date).toBe(localDate(Date.parse(e.event_time), e.tz));
		}
	});
	test("ids, idems and keys are decided by the input: the same input gives the same event", () => {
		const a = attach(2, "ent_s2", T + 30 * DAY);
		const h = hold(a.state as SubjectState, T + DAY);
		const again = events(h);
		expect(events(h)).toEqual(again);
		expect(events(h)[0]?.id).toBe(again[0]?.id);
		const e1 = money({ type: "payout.paid", amount: 100, idem: "stripe:po_1" });
		const e2 = money({ type: "payout.paid", amount: 100, idem: "stripe:po_1" });
		expect(e2).toEqual(e1);
		expect(
			money({ type: "payout.paid", amount: 100, idem: "stripe:po_2" }).id,
		).not.toBe(e1.id);
		expect(new Set(year.map((e) => e.id)).size).toBe(year.length);
		expect(new Set(year.map((e) => e.idem)).size).toBe(year.length);
	});
	test("two events of one millisecond sort in the order the engine decided them", () => {
		const first = ledgerEvent({
			...base,
			type: "payout.paid",
			amount: 1,
			idem: "a",
			revision: 1,
		});
		const second = ledgerEvent({
			...base,
			type: "payout.paid",
			amount: 1,
			idem: "b",
			revision: 2,
		});
		expect(first.id < second.id).toBe(true);
	});
});
