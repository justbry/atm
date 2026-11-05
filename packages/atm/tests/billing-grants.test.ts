import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SubjectState } from "@autumn/balance-engine";
import {
	addUtcMonths,
	addZonedMonths,
	disputeToCommands,
	EMPTY_GRANTS_STATE,
	type GrantCommand,
	type GrantsState,
	invoiceToCommands,
	menuCatalogRows,
	refundToCommands,
	subscriptionEndedToCommands,
} from "../src/billing/grants.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { rowsFromState, subjectFromRows } from "../src/billing/rows.js";
import type {
	BillingDispute,
	BillingInvoice,
	BillingPolicy,
	BillingRefund,
	Menu,
	SubscriptionFact,
} from "../src/billing/types.js";
import { mutationToEvents } from "../src/ledger/postings.js";
import { balancesOf } from "../src/ledger/replay.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";

const dir = `${import.meta.dir}/../fixtures/billing/grants`;
const load = <T>(name: string): T =>
	JSON.parse(readFileSync(`${dir}/${name}.json`, "utf8")) as T;
const menu = load<Menu>("menu");
const invoice = (name: string) => load<BillingInvoice>(name);
const D = (s: string) => Date.parse(s);

const HOLDER = "family:fam_8k2";
const catalog = toCatalog(menuCatalogRows({ menu, school: "sch_vol" }));
const V = { menuVersion: 3, policyVersion: 1 };

/** A little world: the engine state and the rules' state, advanced fact by fact. */
const world = (policy: BillingPolicy = DEFAULT_POLICY) => {
	let engine: SubjectState | null = null;
	let grants: GrantsState = EMPTY_GRANTS_STATE;
	const log: GrantCommand[] = [];
	const run = (commands: GrantCommand[]) => {
		for (const command of commands) {
			const r = runOnState({ state: engine, catalog, command });
			const status = (r.mutation?.result as { status?: string } | undefined)
				?.status;
			if (status === "rejected") throw new Error(`${command.type} rejected`);
			engine = r.state;
			log.push(command);
		}
	};
	const w = {
		get engine() {
			return engine as SubjectState;
		},
		get grants() {
			return grants;
		},
		log,
		invoice(inv: BillingInvoice, now = inv.paidAt) {
			const r = invoiceToCommands({
				invoice: inv,
				menu,
				policy,
				state: grants,
				now,
				...V,
			});
			grants = r.state;
			run(r.commands);
			return r;
		},
		refund(refund: BillingRefund, now = refund.at) {
			const r = refundToCommands({
				refund,
				policy,
				state: grants,
				now,
				subject: w.subject(),
				...V,
			});
			grants = r.state;
			run(r.commands);
			return r;
		},
		dispute(dispute: BillingDispute, now = dispute.at) {
			const r = disputeToCommands({
				dispute,
				policy,
				state: grants,
				now,
				subject: w.subject(),
				...V,
			});
			grants = r.state;
			run(r.commands);
			return r;
		},
		/** The engine subject as the family service would build it from its stored rows. */
		subject() {
			if (!engine) return null;
			return subjectFromRows({
				identity: {
					orgId: "sch_vol",
					env: "live",
					customerId: HOLDER,
					entityId: null,
				},
				revision: 0,
				rows: rowsFromState(engine),
				catalog: menuCatalogRows({ menu, school: "sch_vol" }),
			});
		},
		end(fact: SubscriptionFact, now = fact.at) {
			const r = subscriptionEndedToCommands({
				subscription: fact,
				menu,
				policy,
				state: grants,
				subject: w.subject(),
				now,
				...V,
			});
			grants = r.state;
			run(r.commands);
			return r;
		},
		/** Use `n` from a row (a booking, short of the engine's hold-and-finalize steps). */
		spend(rowId: string, n: number, at: number) {
			run([
				{
					type: "updateBalance",
					schemaVersion: 1,
					commandId: `spend_${log.length}`,
					requestId: `spend_${log.length}`,
					org: {
						config: {
							reverse_deduction_order: false,
							block_overdue_entitlements: false,
							include_past_due: true,
						},
					},
					identity: {
						orgId: "sch_vol",
						env: "live",
						customerId: HOLDER,
						entityId: null,
					},
					occurredAt: at,
					featureId: "visit",
					internalFeatureId: "feat_visit",
					customerEntitlementFilters: { cusEntIds: [rowId] },
					addToBalance: -n,
				},
			]);
		},
		rows: () =>
			Object.fromEntries(
				(engine?.customerEntitlements ?? []).map((r) => [r.id, r.balance]),
			) as Record<string, number>,
		row: (id: string) => engine?.customerEntitlements.find((r) => r.id === id),
		avail(asOf: number, feature = "visit") {
			const b = balancesOf({
				states: { [HOLDER]: engine as never },
				holds: {},
				catalog,
				asOfMs: asOf,
			});
			return b.find((x) => x.feature === feature)?.avail ?? 0;
		},
		rollovers: (asOf: number) =>
			(engine?.rollovers ?? []).filter(
				(r) => r.expires_at === null || r.expires_at > asOf,
			),
	};
	return w;
};

const T1 = D("2026-02-15T18:00:00Z");
const T2 = D("2026-03-15T18:00:00Z");
const S2 = "ce_tier_visit_month";

describe("create", () => {
	test("a new sparkle-2 member gets two visits, the engine's reset at the period end", () => {
		const w = world();
		const r = w.invoice(invoice("inv-create-s2"));
		expect(r.commands.map((c) => c.type)).toEqual(["applyBillingPlan"]);
		expect(w.avail(T1 - 1)).toBe(2);
		expect(w.row(S2)?.next_reset_at).toBe(T1);
		expect(r.state.tierId).toBe("sparkle-2");
	});

	test("a yearly payment carries the year of a monthly grant, reset yearly", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2-year"));
		expect(w.avail(T1)).toBe(24);
		expect(w.row("ce_tier_visit_year")?.next_reset_at).toBe(
			D("2027-01-15T18:00:00Z"),
		);
	});

	test("a yearly grant on a monthly plan is a yearly row whose date the engine sets", () => {
		const w = world();
		const r = w.invoice(invoice("inv-create-s4"));
		expect(r.commands.map((c) => c.type)).toEqual([
			"applyBillingPlan",
			"reset",
		]);
		expect(w.avail(T1)).toBe(4);
		expect(w.avail(T1, "retreat")).toBe(1);
		expect(w.row("ce_tier_retreat_year")?.next_reset_at).toBe(
			D("2027-01-15T18:00:00Z"),
		);
	});

	test("a replayed invoice decides nothing", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		const again = w.invoice(invoice("inv-create-s2"));
		expect(again.commands).toEqual([]);
		expect(w.avail(T1 - 1)).toBe(2);
	});

	test("every command carries the input event id and the decision labels", () => {
		const w = world();
		const r = w.invoice(invoice("inv-create-s4"));
		for (const [i, c] of r.commands.entries()) {
			expect(c.commandId).toBe(`evt_in_s4:${i + 1}`);
			expect(c.requestId).toBe(c.commandId);
		}
		expect(r.labels).toEqual({
			menu_version: "3",
			policy_version: "1",
			mapping: "stripe-2026-10-28@1",
		});
	});
});

describe("renewal", () => {
	test("unused visits roll over once, refill, and the rollover lapses a month after the cycle that ended", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		const r = w.invoice(invoice("inv-cycle-s2-feb"));
		expect(r.commands.map((c) => c.type)).toEqual(["reset"]);
		expect(w.avail(T1 + 1000)).toBe(4);
		expect(w.row(S2)?.next_reset_at).toBe(T2);
		const roll = w.engine.rollovers;
		expect(roll).toHaveLength(1);
		expect(roll[0]?.expires_at).toBe(addUtcMonths(T1, 1));
		expect(w.avail(addUtcMonths(T1, 1) + 1)).toBe(2);
	});

	test("a renewal paid after retries keeps the period-start anchor: same boundary, same rollover expiry", () => {
		const onTime = world();
		onTime.invoice(invoice("inv-create-s2"));
		onTime.invoice(invoice("inv-cycle-s2-feb"));
		const late = world();
		late.invoice(invoice("inv-create-s2"));
		const r = late.invoice(invoice("inv-cycle-s2-feb-retry"));
		expect(r.commands.find((c) => c.type === "reset")?.occurredAt).toBe(T1 + 1);
		expect(late.row(S2)?.next_reset_at).toBe(
			onTime.row(S2)?.next_reset_at as number,
		);
		expect(late.engine.rollovers[0]?.expires_at).toBe(
			onTime.engine.rollovers[0]?.expires_at as number,
		);
		expect(late.avail(D("2026-02-19T00:00:00Z"))).toBe(4);
	});

	test("the rollover cap is enforced across cycles", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		w.invoice(invoice("inv-cycle-s2-feb"));
		w.invoice(invoice("inv-cycle-s2-mar"));
		w.invoice(invoice("inv-cycle-s2-apr"));
		const t = D("2026-04-16T00:00:00Z");
		const rolled = w.rollovers(t).reduce((n, r) => n + r.balance, 0);
		expect(rolled).toBe(2); // never over max 2, though six unused visits passed through
		expect(w.avail(t)).toBe(4);
	});

	test("no payment, no reset: a cancelled member keeps what was granted and nothing new comes", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		expect(w.avail(D("2026-06-01T00:00:00Z"))).toBe(2);
		expect(w.log).toHaveLength(1);
	});
});

describe("upgrade and downgrade", () => {
	const setup = (policy?: BillingPolicy) => {
		const w = world(policy);
		w.invoice(invoice("inv-create-s2"));
		return w;
	};
	const t = D("2026-02-11T00:00:00Z");

	test("prorated: the difference x share of the cycle left, rounded up (2 x 5/31 -> 1)", () => {
		const w = setup();
		const r = w.invoice(invoice("inv-upgrade-s2-s4-mid"));
		expect(r.commands.map((c) => c.type)).toEqual([
			"applyBillingPlan",
			"updateBalance",
			"reset",
		]);
		expect(w.avail(t)).toBe(2 + 1);
		expect(w.avail(t, "retreat")).toBe(1);
		expect(r.state.tierId).toBe("sparkle-4");
	});

	test("after an upgrade the next cycle resets to the new allowance", () => {
		const w = setup();
		w.invoice(invoice("inv-upgrade-s2-s4-mid"));
		const base = invoice("inv-cycle-s2-feb");
		w.invoice({
			...base,
			id: "in_5",
			source: { ...base.source, eventId: "evt_in_5" },
			lines: [
				{
					...(base.lines[0] as BillingInvoice["lines"][number]),
					tierId: "sparkle-4",
					amount: 52000,
				},
			],
		});
		expect(w.row(S2)?.balance).toBe(4);
	});

	test("full: the whole difference", () => {
		const w = setup({ ...DEFAULT_POLICY, upgradeGrant: "full" });
		w.invoice(invoice("inv-upgrade-s2-s4-mid"));
		expect(w.avail(t)).toBe(2 + 2);
	});

	test("none: nothing", () => {
		const w = setup({ ...DEFAULT_POLICY, upgradeGrant: "none" });
		const r = w.invoice(invoice("inv-upgrade-s2-s4-mid"));
		expect(r.commands.some((c) => c.type === "updateBalance")).toBe(false);
		expect(w.avail(t)).toBe(2);
	});

	test("a lower tier grants nothing now, and the next reset uses the new allowance with sessions kept", () => {
		const w = setup();
		const r = w.invoice(invoice("inv-upgrade-s2-s1"));
		expect(r.commands.some((c) => c.type === "updateBalance")).toBe(false);
		expect(w.avail(t)).toBe(2);
		const feb = w.invoice(invoice("inv-cycle-s1-feb"));
		expect(feb.commands.map((c) => c.type)).toEqual(["reset"]);
		expect(w.row(S2)?.balance).toBe(1);
		// the kept sessions roll over, capped by the new tier's max of 1
		expect(w.rollovers(T1 + 1000).reduce((n, x) => n + x.balance, 0)).toBe(1);
	});

	test("a downgrade that takes effect on the cycle invoice moves the plan, then resets", () => {
		const w = setup();
		const r = w.invoice(invoice("inv-cycle-s1-feb"));
		expect(r.commands.map((c) => c.type)).toEqual([
			"applyBillingPlan",
			"reset",
		]);
		expect(r.state.tierId).toBe("sparkle-1");
		expect(w.row(S2)?.balance).toBe(1);
		expect(w.avail(T1 + 1000)).toBe(2);
	});
});

describe("refunds and disputes", () => {
	const refund = load<BillingRefund>("refund-full");
	const partial = load<BillingRefund>("refund-partial");

	test("a full refund removes the unused visits, not the used ones, and never goes below zero", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		w.spend(S2, 1, D("2026-01-16T00:00:00Z"));
		const r = w.refund(refund);
		expect(r.commands).toHaveLength(1);
		expect(w.avail(D("2026-01-21T00:00:00Z"))).toBe(0);
		const second = w.refund({
			...refund,
			id: "re_x",
			source: { ...refund.source, eventId: "evt_re_x" },
		});
		expect(second.commands).toEqual([]);
	});

	test("when all visits are used there is nothing to remove", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		w.spend(S2, 2, D("2026-01-16T00:00:00Z"));
		expect(w.refund(refund).commands).toEqual([]);
		expect(w.avail(D("2026-01-21T00:00:00Z"))).toBe(0);
	});

	test("a partial refund changes nothing", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		expect(w.refund(partial).commands).toEqual([]);
		expect(w.avail(D("2026-01-21T00:00:00Z"))).toBe(2);
	});

	test("the policy can keep visits on a full refund", () => {
		const w = world({ ...DEFAULT_POLICY, removeOnFullRefund: false });
		w.invoice(invoice("inv-create-s2"));
		expect(w.refund(refund).commands).toEqual([]);
	});

	test("a dispute opened or won changes nothing; lost removes like a full refund", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		expect(w.dispute(load("dispute-open")).commands).toEqual([]);
		expect(w.dispute(load("dispute-won")).commands).toEqual([]);
		expect(w.avail(D("2026-01-23T00:00:00Z"))).toBe(2);
		expect(w.dispute(load("dispute-lost")).commands).toHaveLength(1);
		expect(w.avail(D("2026-01-23T00:00:00Z"))).toBe(0);
	});

	test("a lost dispute after a refund removes nothing twice", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		w.refund(refund);
		expect(w.dispute(load("dispute-lost")).commands).toEqual([]);
	});

	test("pay, reset with rollover, refund the first invoice: its leftovers go too", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		w.invoice(invoice("inv-cycle-s2-feb"));
		// 2 refilled by the second invoice + 2 carried over from the first
		expect(w.avail(T1 + 1000)).toBe(4);
		const r = w.refund(refund);
		expect(r.commands).toHaveLength(1);
		expect(w.avail(T1 + 1000)).toBe(2);
		expect(w.row(S2)?.balance).toBe(2);
		expect(w.engine.rollovers.reduce((n, x) => n + x.balance, 0)).toBe(0);
	});

	test("the cut books as one balanced credit.adjusted for what was taken back", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		w.invoice(invoice("inv-cycle-s2-feb"));
		const before = w.engine;
		const r = refundToCommands({
			refund,
			policy: DEFAULT_POLICY,
			state: w.grants,
			subject: w.subject(),
			now: refund.at,
			...V,
		});
		const m = runOnState({
			state: before,
			catalog,
			command: r.commands[0] as GrantCommand,
		});
		const events = mutationToEvents({
			mutation: m.mutation as never,
			context: {
				school: "sch_vol",
				tz: "UTC",
				feature: "visit",
				reason: "refund",
				before: before as never,
			},
		});
		expect(events.map((e) => e.event_type)).toEqual(["credit.adjusted"]);
		const sum = (events[0]?.postings ?? []).reduce(
			(n, p) => n + Number(p.amount),
			0,
		);
		expect(sum).toBe(0);
		expect(events[0]?.payload).toMatchObject({ mutation: expect.anything() });
	});

	test("a refund of the older invoice cuts only what it granted: the newer invoice's refill stays", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		w.invoice(invoice("inv-cycle-s2-feb"));
		w.spend(S2, 1, T1 + 2000); // draws the carried-over visit first
		expect(w.avail(T1 + 3000)).toBe(3);
		w.refund(refund);
		expect(w.avail(T1 + 3000)).toBe(2);
		expect(w.row(S2)?.balance).toBe(2);
	});

	test("no sequence of refunds and disputes drives a balance below zero", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		w.invoice(invoice("inv-cycle-s2-feb"));
		w.spend(S2, 2, T1 + 2000);
		w.spend(S2, 2, T1 + 2001);
		w.refund(refund);
		w.dispute(load("dispute-lost"));
		for (const [id, balance] of Object.entries(w.rows())) {
			expect([id, balance >= 0]).toEqual([id, true]);
		}
		for (const roll of w.engine.rollovers)
			expect(roll.balance).toBeGreaterThanOrEqual(0);
	});
});

describe("add-ons and gifts", () => {
	test("a one-time add-on grants once, with its own expiry", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2-pack"));
		expect(w.avail(T1 - 1)).toBe(2 + 2);
		const expires = addUtcMonths(D("2026-01-15T18:00:05Z"), 3);
		expect(w.avail(expires + 1)).toBe(2);
		w.invoice(invoice("inv-cycle-s2-feb"));
		expect(w.rows().ce_once_in_p_pack_visit).toBe(2);
	});

	test("a recurring add-on refills with each cycle", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2-glow"));
		expect(w.avail(T1 - 1)).toBe(3);
		const base = invoice("inv-cycle-s2-feb");
		w.invoice({
			...base,
			lines: [
				...base.lines,
				{
					kind: "addon",
					addonId: "glow",
					interval: "month",
					quantity: 1,
					proration: false,
					amount: 5000,
				},
			],
		});
		// 2 + 1 refilled; 2 of the tier's 2 carried over (max 2); the add-on has no rollover
		expect(w.avail(T1 + 1000)).toBe(5);
	});

	test("a session gift lasts six months from purchase, then lapses", () => {
		const w = world();
		w.invoice(invoice("inv-gift-sessions"));
		expect(w.avail(D("2026-09-12T18:29:00Z"))).toBe(1);
		expect(w.avail(D("2026-09-12T18:31:00Z"))).toBe(0);
	});

	test("the gift expires on the school's calendar: noon in Denver in January is noon in Denver in July", () => {
		const bought = D("2026-01-12T19:30:00Z"); // 12:30 MST
		const w = world();
		w.invoice({ ...invoice("inv-gift-sessions"), paidAt: bought });
		const noon = D("2026-07-12T18:30:00Z"); // 12:30 MDT, an hour before UTC arithmetic says
		expect(w.avail(noon - 1)).toBe(1);
		expect(w.avail(noon + 1)).toBe(0);
		expect(noon).toBeLessThan(addUtcMonths(bought, 6));
	});

	test("the gift kind can come from the Stripe price on the line alone", () => {
		const w = world();
		const base = invoice("inv-gift-sessions");
		w.invoice({
			...base,
			lines: [
				{
					...(base.lines[0] as BillingInvoice["lines"][number]),
					addonId: "pack",
					gift: "sessions",
				},
			],
		});
		// the pack's own 3-month rollover is not used: a gift lasts the policy's six months
		expect(w.avail(D("2026-09-12T18:29:00Z"))).toBe(1);
		expect(w.avail(D("2026-09-12T18:31:00Z"))).toBe(0);
	});

	test("a metadata gift flag on an invoice no longer grants anything", () => {
		const w = world();
		const base = invoice("inv-gift-sessions");
		const r = w.invoice({
			...base,
			lines: [
				{
					kind: "unknown",
					interval: null,
					quantity: 1,
					proration: false,
					amount: 13000,
				},
			],
			metadata: { ...base.metadata, gift: "sessions", gift_feature: "visit" },
		});
		expect(r.commands).toEqual([]);
	});

	test("a dollar gift grants no credits", () => {
		const w = world();
		expect(w.invoice(invoice("inv-gift-dollars")).commands).toEqual([]);
	});
});

describe("determinism", () => {
	test("the same input gives byte-identical commands", () => {
		const run = () =>
			invoiceToCommands({
				invoice: invoice("inv-create-s2-glow"),
				menu,
				policy: DEFAULT_POLICY,
				state: EMPTY_GRANTS_STATE,
				now: 1,
				...V,
			});
		expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
	});

	test("the state survives a JSON round trip", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		const stored = JSON.parse(JSON.stringify(w.grants)) as GrantsState;
		const r = invoiceToCommands({
			invoice: invoice("inv-cycle-s2-feb"),
			menu,
			policy: DEFAULT_POLICY,
			state: stored,
			now: 1,
			...V,
		});
		expect(r.commands.map((c) => c.type)).toEqual(["reset"]);
	});
});

describe("cancellation", () => {
	const ended = (over: Partial<SubscriptionFact> = {}): SubscriptionFact => ({
		source: {
			eventId: "evt_sub_del_1",
			mapping: "stripe-2026-10-28@1",
			stripeApiVersion: "2026-10-28",
		},
		id: "sub_1",
		customerId: "cus_1",
		status: "canceled",
		tierId: "sparkle-2",
		interval: "month",
		currentPeriodStart: D("2026-01-15T18:00:00Z"),
		currentPeriodEnd: T1,
		cancelAtPeriodEnd: false,
		at: D("2026-01-20T00:00:00Z"),
		metadata: {},
		...over,
	});

	test("the last cycle's unused visits keep their life, then lapse with the rollover window", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		const r = w.end(ended());
		expect(r.commands.map((c) => c.type)).toEqual(["applyBillingPlan"]);
		expect(w.avail(D("2026-01-21T00:00:00Z"))).toBe(2); // not gone at the cancel
		expect(w.avail(T1 + 1000)).toBe(2); // still usable through the cycle that was paid for
		expect(w.row(S2)?.next_reset_at).toBeNull();
		const lapse = addUtcMonths(T1, 1);
		expect(w.row(S2)?.expires_at).toBe(lapse);
		expect(w.avail(lapse - 1)).toBe(2);
		expect(w.avail(lapse + 1)).toBe(0);
	});

	test("visits used before the cancel stay used", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		w.spend(S2, 1, D("2026-01-16T00:00:00Z"));
		w.end(ended());
		expect(w.avail(D("2026-01-21T00:00:00Z"))).toBe(1);
		expect(w.avail(addUtcMonths(T1, 1) + 1)).toBe(0);
	});

	test("nothing refills after the cancel, and a late renewal invoice grants nothing", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		w.end(ended());
		const late = w.invoice(invoice("inv-cycle-s2-feb"));
		expect(late.commands).toEqual([]);
		expect(w.avail(T1 + 1000)).toBe(2);
	});

	test("after a renewal the carried-over visits keep their own expiry and the refill lapses a month after its cycle", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		w.invoice(invoice("inv-cycle-s2-feb"));
		w.end(ended({ at: D("2026-02-20T00:00:00Z"), currentPeriodEnd: T2 }));
		expect(w.avail(D("2026-02-21T00:00:00Z"))).toBe(4);
		expect(w.avail(addUtcMonths(T1, 1) + 1)).toBe(2);
		expect(w.avail(addUtcMonths(T2, 1) + 1)).toBe(0);
	});

	test("an end replayed, for another subscription, or not a cancel decides nothing", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		expect(w.end(ended({ status: "active" })).commands).toEqual([]);
		expect(w.end(ended({ id: "sub_other" })).commands).toEqual([]);
		expect(w.end(ended()).commands).toHaveLength(1);
		expect(w.end(ended()).commands).toEqual([]);
	});

	test("a yearly grant on a monthly plan lapses at its own reset date", () => {
		const w = world();
		w.invoice(invoice("inv-create-s4"));
		w.end(ended({ tierId: "sparkle-4" }));
		const retreatAt = D("2027-01-15T18:00:00Z");
		expect(w.avail(retreatAt - 1, "retreat")).toBe(1);
		expect(w.avail(addUtcMonths(retreatAt, 1) + 1, "retreat")).toBe(0);
	});
});

describe("plan moves that outlive their rows", () => {
	const reissue = (
		inv: BillingInvoice,
		id: string,
		over: Partial<BillingInvoice> = {},
	): BillingInvoice => ({
		...inv,
		id,
		source: { ...inv.source, eventId: `evt_${id}` },
		...over,
	});

	test("a downgrade that drops a feature and an upgrade that brings it back revive the kept row instead of inserting it twice", () => {
		const w = world();
		w.invoice(invoice("inv-create-s4"));
		expect(w.avail(T1, "retreat")).toBe(1);
		// renewal at sparkle-2, which has no retreat: the row stops refilling and keeps its session
		w.invoice(reissue(invoice("inv-cycle-s2-feb"), "in_down"));
		expect(w.grants.retired).toEqual({ ce_tier_retreat_year: 1 });
		expect(w.grants.rows.ce_tier_retreat_year).toBeUndefined();
		expect(w.avail(T1 + 1000, "retreat")).toBe(1);
		// mid-cycle back up to sparkle-4
		w.invoice(reissue(invoice("inv-upgrade-s2-s4-mid"), "in_up"));
		expect(w.grants.retired).toEqual({});
		expect(w.grants.rows.ce_tier_retreat_year).toBe(2);
		expect(w.avail(T1 + 2000, "retreat")).toBeGreaterThanOrEqual(1);
	});

	test("the same on the renewal itself", () => {
		const w = world();
		w.invoice(invoice("inv-create-s4"));
		w.invoice(reissue(invoice("inv-cycle-s2-feb"), "in_down"));
		const base = invoice("inv-cycle-s2-feb");
		w.invoice(
			reissue(base, "in_back", {
				periodStart: T2,
				periodEnd: addUtcMonths(T2, 1),
				lines: [
					{
						...(base.lines[0] as BillingInvoice["lines"][number]),
						tierId: "sparkle-4",
						amount: 52000,
					},
				],
			}),
		);
		expect(w.grants.retired).toEqual({});
		expect(w.avail(T2 + 1000, "retreat")).toBeGreaterThanOrEqual(1);
	});

	test("a row the plan moved off lapses when the subscription ends, as its old tier's rollover would", () => {
		const w = world();
		w.invoice(invoice("inv-create-s4"));
		w.invoice(reissue(invoice("inv-cycle-s2-feb"), "in_down"));
		expect(w.avail(D("2027-06-01T00:00:00Z"), "retreat")).toBe(1);
		w.end({
			source: {
				eventId: "evt_sub_del",
				mapping: "stripe-2026-10-28@1",
				stripeApiVersion: "2026-10-28",
			},
			id: "sub_1",
			customerId: "cus_1",
			status: "canceled",
			tierId: "sparkle-2",
			interval: "month",
			currentPeriodStart: T1,
			currentPeriodEnd: T2,
			cancelAtPeriodEnd: false,
			at: T1 + 86_400_000,
			metadata: {},
		});
		expect(w.avail(T2 - 1, "retreat")).toBe(1);
		expect(w.avail(T2 + 1, "retreat")).toBe(0);
	});

	test("a refund of an invoice that granted nothing (a dollar gift) is marked once, whenever the family gets credits", () => {
		const w = world();
		w.invoice(invoice("inv-gift-dollars"));
		expect(w.grants.holder).toEqual({ orgId: "sch_vol", customerId: HOLDER });
		expect(w.grants.identity).toBeNull();
		const refund = load<BillingRefund>("refund-full");
		const gift = { ...refund, invoiceId: "in_gd" };
		expect(w.refund(gift).commands).toEqual([]);
		expect(w.grants.invoices.in_gd?.removed).toBe(true);
		w.invoice(invoice("inv-create-s2"));
		const before = JSON.stringify(w.grants);
		w.refund(gift);
		expect(JSON.stringify(w.grants)).toBe(before);
	});

	test("a second subscription for a family whose first ended is refused, not half-applied", () => {
		const w = world();
		w.invoice(invoice("inv-create-s2"));
		w.end({
			source: {
				eventId: "evt_sub_del",
				mapping: "stripe-2026-10-28@1",
				stripeApiVersion: "2026-10-28",
			},
			id: "sub_1",
			customerId: "cus_1",
			status: "canceled",
			tierId: "sparkle-2",
			interval: "month",
			currentPeriodStart: T1,
			currentPeriodEnd: T2,
			cancelAtPeriodEnd: false,
			at: T1,
			metadata: {},
		});
		expect(() =>
			w.invoice(
				reissue(invoice("inv-create-s2"), "in_new", {
					subscriptionId: "sub_2",
				}),
			),
		).toThrow(/second subscription/);
	});
});

describe("addZonedMonths", () => {
	test("the same wall clock months on, across the clocks changing", () => {
		expect(addZonedMonths(D("2026-01-12T19:30:00Z"), 6, "America/Denver")).toBe(
			D("2026-07-12T18:30:00Z"),
		);
		expect(addZonedMonths(D("2026-07-12T18:30:00Z"), 6, "America/Denver")).toBe(
			D("2027-01-12T19:30:00Z"),
		);
	});
	test("the day is clamped to a shorter month", () => {
		expect(addZonedMonths(D("2026-08-31T12:00:00Z"), 6, "America/Denver")).toBe(
			D("2027-02-28T13:00:00Z"),
		);
	});
	test("UTC gives the UTC calendar", () => {
		const t = D("2026-03-12T18:30:45.123Z");
		expect(addZonedMonths(t, 6, "UTC")).toBe(addUtcMonths(t, 6));
	});
	test("a zone ahead of UTC across midnight keeps its own local day", () => {
		// 2026-01-31 23:30 in Auckland (+13) is 10:30Z; one month on is 2026-02-28 23:30 Auckland (+13) = 10:30Z
		expect(
			addZonedMonths(D("2026-01-31T10:30:00Z"), 1, "Pacific/Auckland"),
		).toBe(D("2026-02-28T10:30:00Z"));
	});
});
