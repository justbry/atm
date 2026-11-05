import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SubjectState } from "@autumn/balance-engine";
import { menuCatalogRows } from "../src/billing/grants.js";
import { commandOrg, DEFAULT_POLICY } from "../src/billing/policy.js";
import { buildJournal } from "../src/ledger/journal.js";
import { mutationToEvents } from "../src/ledger/postings.js";
import { balancesOf, replayEvents } from "../src/ledger/replay.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent, AtmEventContext } from "../src/types.js";

const SCHOOL = "sch_vol";
const HOLDER = "family:fam_alerts";
const menu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
);
const catalogRows = menuCatalogRows({ menu, school: SCHOOL });
const catalog = toCatalog(catalogRows);
const identity = {
	orgId: SCHOOL,
	env: "live",
	customerId: HOLDER,
	entityId: null,
};
const T = Date.UTC(2026, 0, 5, 17, 0, 0);
const DAY = 86_400_000;
const org = commandOrg(DEFAULT_POLICY);

/** The first tier entitlement the menu's catalog has for a feature: the row's product and entitlement. */
const entitlementOf = (feature: string) => {
	const found = catalogRows.find(
		(r) =>
			r.table === "entitlements" &&
			r.row.internal_feature_id === `feat_${feature}` &&
			r.row.internal_product_id !== null,
	);
	if (!found) throw new Error(`no tier entitlement for ${feature}`);
	return found.row as { id: string; internal_product_id: string };
};

let commandCount = 0;
const command = (type: string, at: number, extra: Record<string, unknown>) => {
	commandCount += 1;
	return {
		schemaVersion: 1,
		type,
		org,
		commandId: `alerts_${commandCount}`,
		requestId: `alerts_${commandCount}`,
		identity,
		occurredAt: at,
		...extra,
	};
};

/** One family with one balance row per feature, and the log of every event written for it. */
const family = (balances: Record<string, number>) => {
	const featureIds = Object.keys(balances);
	const productId = entitlementOf(featureIds[0] as string).internal_product_id;
	const run = runOnState({
		state: null,
		catalog,
		command: command("applyBillingPlan", T, {
			entityIds: [],
			expiringPooledBalanceIds: [],
			ops: [
				{
					op: "insert",
					table: "customer",
					row: {
						internal_id: "cus_alerts",
						id: HOLDER,
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
						internal_customer_id: "cus_alerts",
						internal_product_id: productId,
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
				...featureIds.map((feature) => ({
					op: "insert",
					table: "customerEntitlements",
					row: {
						id: `ce_${feature}`,
						customer_product_id: "cp_1",
						entitlement_id: entitlementOf(feature).id,
						internal_customer_id: "cus_alerts",
						internal_entity_id: null,
						internal_feature_id: `feat_${feature}`,
						balance: balances[feature],
						adjustment: 0,
						additional_balance: 0,
						unlimited: false,
						usage_allowed: false,
						next_reset_at: T + 30 * DAY,
						reset_cycle_anchor: null,
						expires_at: null,
						external_id: null,
						created_at: T,
					},
				})),
			],
		}),
	});
	const initial = run.state as SubjectState;
	let state = initial;
	let clock = T;
	const log: AtmEvent[] = [];
	const context = (
		feature: string,
		extra: Partial<AtmEventContext>,
		before: SubjectState,
	): AtmEventContext => ({
		school: SCHOOL,
		tz: "America/Denver",
		feature,
		plan: "sparkle-4@v1",
		service: "massage-90",
		reason: "test",
		before: before as never,
		...extra,
	});
	const apply = (
		type: string,
		feature: string,
		extra: Record<string, unknown>,
		eventContext: Partial<AtmEventContext>,
	) => {
		clock += DAY;
		const before = state;
		const made = runOnState({
			state,
			catalog,
			command: command(type, clock, {
				featureId: feature,
				internalFeatureId: `feat_${feature}`,
				...extra,
			}),
		});
		state = made.state as SubjectState;
		const events = mutationToEvents({
			mutation: made.mutation as never,
			context: context(feature, eventContext, before),
		});
		log.push(...events);
		return { events, mutation: made.mutation, before };
	};
	return {
		/** The subject as the plan left it, before any event of `log`. */
		initial,
		get state() {
			return state;
		},
		log,
		/** A booking takes `units` out: the hold, which is the draw. */
		draw: (
			feature: string,
			units: number,
			eventContext: Partial<AtmEventContext> = { lowCreditThreshold: 2 },
		) =>
			apply(
				"track",
				feature,
				{
					value: units,
					overageBehavior: "reject",
					properties: null,
					usageEvent: null,
					lock: {
						id: `lock_${commandCount + 1}`,
						lockId: `bk_${commandCount + 1}`,
						expiresAt: clock + 2 * DAY,
						expiryAction: "confirm",
					},
				},
				eventContext,
			),
		/** The family service adds or takes credit by hand. */
		adjust: (
			feature: string,
			units: number,
			eventContext: Partial<AtmEventContext> = { lowCreditThreshold: 2 },
		) => apply("updateBalance", feature, { addToBalance: units }, eventContext),
		available: (feature: string) =>
			balancesOf({
				states: { [HOLDER]: state as never },
				holds: {},
				catalog,
				asOfMs: clock,
			}).find((b) => b.feature === feature)?.avail ?? 0,
	};
};

/** Replay starts from the subject as the plan left it: attaching the plan is not an event of this log. */
const startOf = (subject: { initial: SubjectState }) => ({
	states: { [HOLDER]: subject.initial as never },
	holds: {},
	lastEventId: null,
});

const alerts = (events: readonly AtmEvent[]) =>
	events.filter(
		(e) => e.event_type === "credit.low" || e.event_type === "credit.depleted",
	);
const typesOf = (events: readonly AtmEvent[]) =>
	events.map((e) => e.event_type);

describe("credit.low and credit.depleted", () => {
	test("a draw from 5 to 2 with a threshold of 2 is credit.low, with no postings; 2 to 1 is nothing; 1 to 0 is credit.depleted", () => {
		const visits = family({ visit: 5 });
		const down = visits.draw("visit", 3);
		expect(typesOf(down.events)).toEqual(["credit.held", "credit.low"]);
		const [, low] = down.events as [AtmEvent, AtmEvent];
		expect(low.postings).toEqual([]);
		expect(low.payload).toMatchObject({
			feature: "visit",
			available: 2,
			threshold: 2,
			previous_available: 5,
		});
		expect(low.idem).toBe(`engine:${down.mutation?.id}:low:visit`);
		expect(low.text).toBe("2 visit left");
		expect(low.labels.feature).toBe("visit");
		expect(visits.available("visit")).toBe(2);

		expect(typesOf(visits.draw("visit", 1).events)).toEqual(["credit.held"]);

		const out = visits.draw("visit", 1);
		expect(typesOf(out.events)).toEqual(["credit.held", "credit.depleted"]);
		const depleted = out.events[1] as AtmEvent;
		expect(depleted.postings).toEqual([]);
		expect(depleted.payload).toMatchObject({
			feature: "visit",
			available: 0,
			threshold: null,
			previous_available: 1,
		});
		expect(depleted.idem).toBe(`engine:${out.mutation?.id}:depleted:visit`);
		expect(depleted.text).toBe("visit credits used up");
		for (const e of [low, depleted])
			expect(validateEvent(e)).toEqual({ ok: true, errors: [] });
	});

	test("a draw from above the threshold straight to 0 is only credit.depleted", () => {
		const visits = family({ visit: 5 });
		expect(typesOf(visits.draw("visit", 5).events)).toEqual([
			"credit.held",
			"credit.depleted",
		]);
	});

	test("a draw that stays above the threshold is nothing", () => {
		const visits = family({ visit: 5 });
		expect(typesOf(visits.draw("visit", 2).events)).toEqual(["credit.held"]);
		expect(visits.available("visit")).toBe(3);
	});

	test("nothing for a balance that does not go down: a refill, a refund, a grant", () => {
		const visits = family({ visit: 1 });
		const grant = visits.adjust("visit", 4);
		expect(typesOf(grant.events)).toEqual(["credit.adjusted"]);
		const refund = visits.adjust("visit", 1, {
			lowCreditThreshold: 2,
			as: "refunded",
		});
		expect(typesOf(refund.events)).toEqual(["credit.refunded"]);
		expect(visits.available("visit")).toBe(6);
	});

	test("a take-back by hand crosses the same way as a draw", () => {
		const visits = family({ visit: 3 });
		expect(typesOf(visits.adjust("visit", -1).events)).toEqual([
			"credit.adjusted",
			"credit.low",
		]);
		expect(typesOf(visits.adjust("visit", -2).events)).toEqual([
			"credit.adjusted",
			"credit.depleted",
		]);
	});

	test("a threshold of 0 never makes credit.low, but running out still makes credit.depleted", () => {
		const visits = family({ visit: 3 });
		expect(
			typesOf(visits.draw("visit", 2, { lowCreditThreshold: 0 }).events),
		).toEqual(["credit.held"]);
		expect(
			typesOf(visits.draw("visit", 1, { lowCreditThreshold: 0 }).events),
		).toEqual(["credit.held", "credit.depleted"]);
	});

	test("a caller that gives no threshold gets neither event: the events it always got", () => {
		const visits = family({ visit: 3 });
		expect(typesOf(visits.draw("visit", 2, {}).events)).toEqual([
			"credit.held",
		]);
		expect(typesOf(visits.draw("visit", 1, {}).events)).toEqual([
			"credit.held",
		]);
	});

	test("a balance row of the feature that is not touched counts: the draw is judged on the feature's total", () => {
		const visits = family({ visit: 2 });
		// A pack the family bought on top of the tier: a second row of the same feature.
		const pack = runOnState({
			state: visits.state,
			catalog,
			command: command("applyBillingPlan", T + DAY / 2, {
				entityIds: [],
				expiringPooledBalanceIds: [],
				ops: [
					{
						op: "insert",
						table: "customerEntitlements",
						row: {
							...(visits.state.customerEntitlements[0] as object),
							id: "ce_pack",
							balance: 10,
							next_reset_at: null,
						},
					},
				],
			}),
		});
		const rows = pack.state as SubjectState;
		expect(rows.customerEntitlements.map((r) => r.balance).sort()).toEqual([
			10, 2,
		]);
		const draw = runOnState({
			state: rows,
			catalog,
			command: command("updateBalance", T + DAY, {
				featureId: "visit",
				internalFeatureId: "feat_visit",
				customerEntitlementId: "ce_visit",
				addToBalance: -2,
			}),
		});
		const events = mutationToEvents({
			mutation: draw.mutation as never,
			context: {
				school: SCHOOL,
				tz: "America/Denver",
				feature: "visit",
				reason: "test",
				before: rows as never,
				lowCreditThreshold: 2,
			},
		});
		// The tier row is at 0, the family still has 10: nothing ran out; without the pack it would have.
		expect(typesOf(events)).toEqual(["credit.adjusted"]);
		expect(typesOf(family({ visit: 2 }).adjust("visit", -2).events)).toEqual([
			"credit.adjusted",
			"credit.depleted",
		]);
	});

	test("two features are each their own: the low one and the depleted one", () => {
		const both = family({ visit: 4, retreat: 1 });
		const retreat = both.draw("retreat", 1);
		expect(typesOf(retreat.events)).toEqual(["credit.held", "credit.depleted"]);
		expect(retreat.events[1]?.payload).toMatchObject({ feature: "retreat" });
		const visit = both.draw("visit", 2);
		expect(typesOf(visit.events)).toEqual(["credit.held", "credit.low"]);
		expect(visit.events[1]?.payload).toMatchObject({
			feature: "visit",
			available: 2,
			previous_available: 4,
		});
		expect(both.available("retreat")).toBe(0);
		expect(both.available("visit")).toBe(2);
	});

	test("the same mutation gives the same events, ids and idems", () => {
		const visits = family({ visit: 5 });
		const down = visits.draw("visit", 4);
		const again = mutationToEvents({
			mutation: down.mutation as never,
			context: {
				school: SCHOOL,
				tz: "America/Denver",
				feature: "visit",
				plan: "sparkle-4@v1",
				service: "massage-90",
				before: down.before as never,
				lowCreditThreshold: 2,
			},
		});
		expect(again).toEqual(down.events);
		expect(again.map((e) => [e.id, e.idem])).toEqual(
			down.events.map((e) => [e.id, e.idem]),
		);
		expect(new Set(again.map((e) => e.idem)).size).toBe(again.length);
	});

	test("without the state the mutation was computed against, the balance before is unknown: no alert", () => {
		const visits = family({ visit: 1 });
		const out = visits.draw("visit", 1, {
			lowCreditThreshold: 2,
			before: null,
		});
		expect(typesOf(out.events)).toEqual(["credit.held"]);
	});

	test("a feature's changes can be given to one call and an empty list to the others", () => {
		const visits = family({ visit: 3 });
		const none = visits.draw("visit", 3, {
			lowCreditThreshold: 2,
			featureChanges: [],
		});
		expect(typesOf(none.events)).toEqual(["credit.held"]);
	});
});

describe("the events against their schemas", () => {
	const sample = () => {
		const visits = family({ visit: 5 });
		const low = visits.draw("visit", 3).events[1] as AtmEvent;
		const depleted = visits.draw("visit", 2).events[1] as AtmEvent;
		return { low, depleted };
	};
	const without = (event: AtmEvent, key: string): AtmEvent => {
		const payload = { ...event.payload };
		delete payload[key];
		return { ...event, payload };
	};

	test("both are valid envelopes and payloads", () => {
		const { low, depleted } = sample();
		expect(low.event_type).toBe("credit.low");
		expect(depleted.event_type).toBe("credit.depleted");
		expect(validateEvent(low).errors).toEqual([]);
		expect(validateEvent(depleted).errors).toEqual([]);
	});

	test("each field of the payload is required", () => {
		const { low, depleted } = sample();
		for (const key of [
			"feature",
			"available",
			"threshold",
			"previous_available",
		]) {
			expect(validateEvent(without(low, key)).ok).toBe(false);
			expect(validateEvent(without(depleted, key)).ok).toBe(false);
		}
	});

	test("a low event needs a threshold of at least 1 and a depleted event has none", () => {
		const { low, depleted } = sample();
		expect(
			validateEvent({ ...low, payload: { ...low.payload, threshold: 0 } }).ok,
		).toBe(false);
		expect(
			validateEvent({
				...depleted,
				payload: { ...depleted.payload, threshold: 2 },
			}).ok,
		).toBe(false);
	});

	test("an alert with postings that do not balance is refused like any event", () => {
		const { low } = sample();
		expect(
			validateEvent({
				...low,
				postings: [
					{ account: "credits:avail:x:visit", amount: "1", commodity: "VISIT" },
				],
			}).ok,
		).toBe(false);
	});
});

describe("the log with alerts in it", () => {
	const settled = () => {
		const both = family({ visit: 5, retreat: 1 });
		both.draw("visit", 3);
		both.draw("visit", 1);
		both.draw("retreat", 1);
		both.draw("visit", 1);
		return both;
	};

	test("replaying it reproduces the balances, and each recorded alert is the one its mutation derives", () => {
		const both = settled();
		expect(alerts(both.log).map((e) => e.event_type)).toEqual([
			"credit.low",
			"credit.depleted",
			"credit.depleted",
		]);
		const replayed = replayEvents({
			events: both.log,
			catalog: catalogRows,
			snapshot: startOf(both),
		});
		for (const feature of ["visit", "retreat"])
			expect(
				replayed.balances.find((b) => b.feature === feature)?.avail ?? 0,
			).toBe(both.available(feature));
	});

	test("a recorded alert that its mutation would not derive is refused", () => {
		const both = settled();
		const forged = both.log.map((e) =>
			e.event_type === "credit.low"
				? { ...e, payload: { ...e.payload, available: 1 } }
				: e,
		);
		expect(() =>
			replayEvents({
				events: forged,
				catalog: catalogRows,
				snapshot: startOf(both),
			}),
		).toThrow(/differs from the one the mutation derives/);
	});

	test("the journal ignores events with no postings: its transactions are the same with or without the alerts", () => {
		const both = settled();
		const month = both.log[0]?.date.slice(0, 7) as string;
		const withAlerts = buildJournal({ events: both.log, month });
		const without = buildJournal({
			events: both.log.filter((e) => alerts([e]).length === 0),
			month,
		});
		expect(withAlerts.transactions).toBe(without.transactions);
		expect(withAlerts.files[`ledger/b4u/${month}.journal`]).toBe(
			without.files[`ledger/b4u/${month}.journal`],
		);
	});
});
