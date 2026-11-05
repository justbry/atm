/**
 * One Vibes of Light member's year (2026), run through the real balance engine. Every command carries its own
 * time; nothing reads the clock. A seed decides the small things (the signup day and hour, booking ids, services,
 * the days and hours of sessions); the story itself is fixed so every kind of event is in every seed's year:
 * payment grant, spends (hold then finalize), hold then release, a no-show forfeit, rollovers at resets, a
 * downgrade that keeps its sessions, a payment refund with its credit adjustment, a credit refund, gift grants
 * (one used, one lapsing) and the cron's expiry of what lapses.
 */
import type { SubjectState } from "@autumn/balance-engine";
import {
	lapsedRows,
	lapseEvent,
	ledgerEvent,
	mutationToEvents,
} from "../src/ledger/postings.js";
import { balancesOf } from "../src/ledger/replay.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import { canonicalize } from "../src/ledger/util.js";
import type {
	AtmCatalogRow,
	AtmEvent,
	AtmEventContext,
	AtmHold,
} from "../src/types.js";
import { makeRng } from "./rng.js";

export const SCHOOL = "sch_vol";
export const TZ = "America/Denver";
export const FEATURE = "visit";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const SERVICES = ["massage-90", "light-60", "energy-45"] as const;

export const catalogRows = (): AtmCatalogRow[] => {
	const created = Date.UTC(2026, 0, 1);
	const ent = (
		id: string,
		product: string | null,
		allowance: number,
		rollover: unknown,
		interval: string,
	) => ({
		table: "entitlements",
		row: {
			id,
			created_at: created,
			internal_feature_id: "feat_visit",
			internal_product_id: product,
			is_custom: false,
			allowance_type: "fixed",
			allowance,
			interval,
			interval_count: 1,
			org_id: SCHOOL,
			usage_limit: null,
			rollover,
		},
	});
	const product = (id: string) => ({
		table: "products",
		row: {
			id,
			name: id,
			description: null,
			is_add_on: false,
			is_default: false,
			version: 1,
			version_slug: "v1",
			active: true,
			deleted_at: null,
			previous_version_slug: null,
			group: "",
			env: "live",
			internal_id: `prod_${id}`,
			org_id: SCHOOL,
			created_at: created,
			base_variant_id: null,
			archived: false,
			config: { ignore_past_due: false },
			metadata: {},
		},
	});
	return [
		{
			table: "features",
			row: {
				internal_id: "feat_visit",
				org_id: SCHOOL,
				created_at: created,
				env: "live",
				id: FEATURE,
				name: "Visit",
				type: "metered",
				config: {},
				archived: false,
				event_names: [],
			},
		},
		// Monthly: n sessions at payment, the unused ones last one more month (rollover of one month, capped at n).
		ent(
			"ent_s2",
			"prod_sparkle-2",
			2,
			{ max: 2, duration: "month", length: 1 },
			"month",
		),
		ent(
			"ent_s1",
			"prod_sparkle-1",
			1,
			{ max: 1, duration: "month", length: 1 },
			"month",
		),
		// Gift certificate: one use, no cycle.
		ent("ent_gift", null, 1, null, "lifetime"),
		product("sparkle-2"),
		product("sparkle-1"),
	];
};

type Outcome = "attend" | "cancel" | "noshow";

/** Bookings per month (January is index 0) in the order they are made. */
const BOOKINGS: Outcome[][] = [
	["attend", "attend"],
	["attend"],
	["attend", "attend", "attend"],
	["cancel", "attend"],
	["attend", "noshow"],
	["attend"],
	["attend"],
	["attend", "attend", "attend"],
	["attend"],
	[],
	["attend"],
	["attend"],
];

const ORG = {
	config: {
		reverse_deduction_order: false,
		block_overdue_entitlements: false,
		include_past_due: true,
	},
};
const DOWNGRADE_MONTH = 6; // the July payment is the first at the smaller plan

type Action = { t: number; order: number; run: () => void };

export type Fixture = {
	seed: number;
	school: string;
	events: AtmEvent[];
	catalog: AtmCatalogRow[];
	expected: {
		seed: number;
		school: string;
		holder: string;
		asOf: string;
		lastEventId: string;
		eventCount: number;
		balances: {
			holder: string;
			feature: string;
			avail: number;
			held: number;
		}[];
		/** Sum of every event's postings per account and commodity. */
		postingTotals: Record<string, string>;
	};
};

export const generateYear = ({ seed }: { seed: number }): Fixture => {
	const rng = makeRng(seed);
	const fam = `fam_${rng.id(4)}`;
	const holder = `family:${fam}`;
	const identity = {
		orgId: SCHOOL,
		env: "live",
		customerId: holder,
		entityId: null,
	};
	const rows = catalogRows();
	const catalog = toCatalog(rows);
	const featureOf = (internal: string) => catalog.features[internal]?.id;

	const events: AtmEvent[] = [];
	let state: SubjectState | null = null;
	const holds: Record<string, AtmHold> = {};
	const lockRows = new Map<string, Record<string, unknown>>();
	const lapsed = new Set<string>();
	let counter = 0;
	let planLabel = "sparkle-2@v1";
	let allowance = 2;
	let netSincePayout = 0;
	const lastId = () => events[events.length - 1]?.id;

	const signupDay = rng.int(2, 26);
	const signupHour = rng.int(15, 20);
	const signupMinute = rng.int(0, 59);
	const renewal = (m: number) =>
		Date.UTC(2026, m, signupDay, signupHour, signupMinute, 0);

	const base = (type: string, t: number) => {
		counter += 1;
		return {
			schemaVersion: 1,
			type,
			org: ORG,
			commandId: `cmd_${String(counter).padStart(3, "0")}`,
			requestId: `req_${String(counter).padStart(3, "0")}`,
			identity,
			occurredAt: t,
		};
	};
	const ingest = (t: number) => t + rng.int(200, 2500);

	/** The cron books the expiry of anything lapsed by `t`, at the instant it lapsed. */
	const lapse = (t: number) => {
		if (!state) return;
		for (const row of lapsedRows({
			state,
			featureOf,
			feature: FEATURE,
			atMs: t,
		})) {
			const k = `${row.id}:${row.expires_at}`;
			if (lapsed.has(k)) continue;
			lapsed.add(k);
			events.push(
				lapseEvent({
					row,
					holder,
					key: holder,
					feature: FEATURE,
					school: SCHOOL,
					tz: TZ,
					revision: state.revision,
					labels: { plan: planLabel },
					ingestTime: ingest(row.expires_at),
				}),
			);
		}
	};

	const exec = (
		command: Record<string, unknown>,
		ctx: Partial<AtmEventContext> & { plan?: string },
	) => {
		const t = command.occurredAt as number;
		lapse(t);
		const before = state;
		const run = runOnState({ state, catalog, command });
		if (!run.mutation)
			throw new Error(`${String(command.type)} decided nothing`);
		const rejected =
			(run.mutation.result as { status?: string }).status === "rejected";
		if (rejected)
			throw new Error(
				`${String(command.type)} was rejected at ${new Date(t).toISOString()}`,
			);
		state = run.state;
		const made = mutationToEvents({
			mutation: run.mutation,
			context: {
				school: SCHOOL,
				tz: TZ,
				feature: FEATURE,
				plan: planLabel,
				ingestTime: new Date(ingest(t)).toISOString(),
				before: before as never,
				...ctx,
			},
		});
		events.push(...made);
		return { mutation: run.mutation, made };
	};

	const planEvent = (
		type: "plan.attached" | "plan.changed",
		t: number,
		mutation: unknown,
		text: string,
		cause?: string,
	) =>
		events.push(
			ledgerEvent({
				type,
				school: SCHOOL,
				tz: TZ,
				eventTime: t,
				ingestTime: ingest(t),
				key: holder,
				idem: `plan:${(mutation as { id: string }).id}`,
				labels: { plan: planLabel, feature: FEATURE },
				cause,
				text,
				payload: {
					command: (mutation as { command: unknown }).command,
					mutation: withoutCommand(mutation),
				},
				revision: (mutation as { revision: { before: number } }).revision
					.before,
			}),
		);

	const actions: Action[] = [];
	let order = 0;
	const at = (t: number, run: () => void) =>
		actions.push({ t, order: order++, run });

	const fee = (cents: number) => Math.round(cents * 0.029) + 30;
	const payment = (m: number, t: number, planSlug: string, units: number) => {
		const gross = 13000 * units;
		const f = fee(gross);
		const id = `in_${m}_${rng.id(5)}`;
		netSincePayout += gross - f;
		events.push(
			ledgerEvent({
				type: "payment.succeeded",
				school: SCHOOL,
				tz: TZ,
				eventTime: t,
				ingestTime: ingest(t),
				key: holder,
				idem: `stripe:${id}`,
				amount: gross,
				fee: f,
				incomeKind: `membership:${planSlug}`,
				labels: { plan: `${planSlug}@v1` },
				text: `membership payment ${gross / 100} USD for ${planSlug}`,
				payload: {
					id,
					amount_paid: gross,
					fee: f,
					currency: "usd",
					customer: `cus_${fam}`,
					billing_email: "member@example.test",
					billing_name: "Test Member",
				},
			}),
		);
		return events[events.length - 1] as AtmEvent;
	};

	// ---- January: first payment, the plan, its grant -------------------------------------------------------------
	const t0 = renewal(0);
	at(t0, () => {
		const paid = payment(0, t0, "sparkle-2", 2);
		const t = t0 + 1000;
		const command = {
			...base("applyBillingPlan", t),
			entityIds: [],
			expiringPooledBalanceIds: [],
			ops: [
				{
					op: "insert",
					table: "customer",
					row: {
						internal_id: `cus_${fam}`,
						id: holder,
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
						internal_customer_id: `cus_${fam}`,
						internal_product_id: "prod_sparkle-2",
						internal_entity_id: null,
						status: "active",
						options: [],
						quantity: 1,
						created_at: t,
						starts_at: t,
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
						entitlement_id: "ent_s2",
						internal_customer_id: `cus_${fam}`,
						internal_entity_id: null,
						internal_feature_id: "feat_visit",
						balance: 2,
						adjustment: 0,
						additional_balance: 0,
						unlimited: false,
						usage_allowed: false,
						next_reset_at: renewal(1),
						reset_cycle_anchor: null,
						expires_at: null,
						external_id: null,
						created_at: t,
					},
				},
			],
		};
		const { mutation, made } = exec(command, { cause: paid.id });
		planEvent("plan.attached", t, mutation, `attached ${planLabel}`, paid.id);
		// the plan event is the cause of the grant
		const attached = events[events.length - 1] as AtmEvent;
		for (const ev of made)
			events[events.indexOf(ev)] = withCause(ev, attached.id);
	});

	// ---- each month ------------------------------------------------------------------------------------------------
	for (let m = 0; m < 12; m++) {
		const R = renewal(m);
		if (m > 0) {
			const slug = m >= DOWNGRADE_MONTH ? "sparkle-1" : "sparkle-2";
			const units = m >= DOWNGRADE_MONTH ? 1 : 2;
			let paid: AtmEvent | undefined;
			at(R, () => {
				paid = payment(m, R, slug, units);
			});
			const tr = R + 5000 + rng.int(0, 25) * 1000;
			at(tr, () => {
				if (m === DOWNGRADE_MONTH) {
					planLabel = "sparkle-1@v1";
					allowance = 1;
				}
				exec(base("reset", tr), {
					source: "cron",
					cause: paid?.id,
					plan: planLabel,
				});
			});
			// payout of what Stripe holds, three days after the renewal
			const tp = R + 3 * DAY + rng.int(0, 5) * HOUR;
			at(tp, () => {
				if (netSincePayout <= 0) return;
				const amount = netSincePayout;
				netSincePayout = 0;
				events.push(
					ledgerEvent({
						type: "payout.paid",
						school: SCHOOL,
						tz: TZ,
						eventTime: tp,
						ingestTime: ingest(tp),
						key: holder,
						idem: `stripe:po_${m}`,
						amount,
						text: `payout ${amount / 100} USD`,
						payload: { id: `po_${m}`, amount, currency: "usd" },
					}),
				);
			});
		} else {
			const tp = R + 3 * DAY;
			at(tp, () => {
				const amount = netSincePayout;
				netSincePayout = 0;
				events.push(
					ledgerEvent({
						type: "payout.paid",
						school: SCHOOL,
						tz: TZ,
						eventTime: tp,
						ingestTime: ingest(tp),
						key: holder,
						idem: "stripe:po_0",
						amount,
						text: `payout ${amount / 100} USD`,
						payload: { id: "po_0", amount, currency: "usd" },
					}),
				);
			});
		}

		// bookings
		(BOOKINGS[m] ?? []).forEach((outcome, k) => {
			const holdT =
				R + (2 + 5 * k + rng.int(0, 1)) * DAY + rng.int(0, 8) * HOUR;
			const sessionT = holdT + 3 * DAY + rng.int(0, 6) * HOUR;
			scheduleBooking({ outcome, holdT, sessionT });
		});
	}

	function scheduleBooking({
		outcome,
		holdT,
		sessionT,
		open = false,
	}: {
		outcome: Outcome;
		holdT: number;
		sessionT: number;
		open?: boolean;
	}) {
		const booking = `bk_${rng.id(6)}`;
		const service = rng.pick(SERVICES);
		const lockId = `lock_${booking}`;
		const expiresAt = sessionT + 2 * HOUR;
		let heldEvent: AtmEvent | undefined;
		at(holdT, () => {
			const { mutation, made } = exec(
				{
					...base("track", holdT),
					featureId: FEATURE,
					internalFeatureId: "feat_visit",
					value: 1,
					overageBehavior: "reject",
					properties: null,
					usageEvent: null,
					lock: {
						id: lockId,
						lockId: booking,
						expiresAt,
						expiryAction: "confirm",
					},
				},
				{
					service,
					labels: { service },
					payload: { booking_id: booking, service },
				},
			);
			const lock = mutation.changes.find(
				(c) => c.table === "locks" && c.op === "insert",
			);
			if (lock?.op === "insert")
				lockRows.set(lockId, lock.row as Record<string, unknown>);
			heldEvent = made[0];
			holds[lockId] = { holder, feature: FEATURE, units: 1 };
		});
		if (open) return;
		const settle = (t: number, finalValue: number | null) => {
			const { made } = exec(
				{
					...base("finalize", t),
					lock: lockRows.get(lockId),
					internalFeatureId: "feat_visit",
					finalValue,
					properties: null,
				},
				{ service, cause: heldEvent?.id, labels: { service } },
			);
			delete holds[lockId];
			return made;
		};
		if (outcome === "attend")
			at(sessionT + HOUR, () => settle(sessionT + HOUR, null));
		if (outcome === "cancel") at(holdT + DAY, () => settle(holdT + DAY, 0));
		if (outcome === "noshow") {
			const tc = expiresAt + 5 * 60_000;
			at(tc, () => {
				exec(
					{
						...base("confirmExpiredLock", tc),
						lock: { id: lockId, lock_id: booking },
					},
					{
						source: "cron",
						held: 1,
						cause: heldEvent?.id,
						labels: { service },
					},
				);
				delete holds[lockId];
			});
		}
	}

	// ---- December: a booking still open at the end of the year -----------------------------------------------------
	scheduleBooking({
		outcome: "attend",
		holdT: Date.UTC(2026, 11, 28, 17, 0, 0),
		sessionT: Date.UTC(2027, 0, 4, 17, 0, 0),
		open: true,
	});

	// ---- gifts: one is used in August, the other lapses unused six months after it was given -----------------------
	for (const [i, day] of [12, 20].entries()) {
		const tg = Date.UTC(2026, 2, day, 18, rng.int(0, 59), 0);
		at(tg, () => {
			const expires = Date.UTC(
				2026,
				8,
				day,
				18,
				new Date(tg).getUTCMinutes(),
				0,
			);
			const cmd = {
				...base("applyBillingPlan", tg),
				entityIds: [],
				expiringPooledBalanceIds: [],
				ops: [
					{
						op: "insert",
						table: "customerEntitlements",
						row: {
							id: `ce_gift_${i + 1}`,
							customer_product_id: null,
							entitlement_id: "ent_gift",
							internal_customer_id: `cus_${fam}`,
							internal_entity_id: null,
							internal_feature_id: "feat_visit",
							balance: 1,
							adjustment: 0,
							additional_balance: 0,
							unlimited: false,
							usage_allowed: false,
							next_reset_at: null,
							reset_cycle_anchor: null,
							expires_at: expires,
							external_id: null,
							created_at: tg,
						},
					},
				],
			};
			exec(cmd, { plan: "gift", labels: { gift: `gc_${i + 1}` } });
		});
	}

	// ---- June: downgrade to the one-session plan, keeping every session already granted ------------------------------
	const tDown = renewal(5) + 15 * DAY;
	at(tDown, () => {
		const cmd = {
			...base("applyBillingPlan", tDown),
			entityIds: [],
			expiringPooledBalanceIds: [],
			ops: [
				{
					op: "update",
					table: "customerProducts",
					id: "cp_1",
					set: { internal_product_id: "prod_sparkle-1" },
				},
				{
					op: "update",
					table: "customerEntitlements",
					id: "ce_1",
					set: { entitlement_id: "ent_s1" },
				},
			],
		};
		const { mutation, made } = exec(cmd, { plan: "sparkle-1@v1" });
		if (made.length > 0)
			throw new Error("a downgrade must keep sessions, not move credits");
		planEvent(
			"plan.changed",
			tDown,
			mutation,
			"changed sparkle-2@v1 to sparkle-1@v1; sessions kept",
		);
	});

	// ---- October: the studio refunds the payment, and takes back the session it paid for ----------------------------
	const tRefund = renewal(9) + DAY;
	at(tRefund, () => {
		const payEvent = events
			.filter((e) => e.event_type === "payment.succeeded")
			.slice(-1)[0] as AtmEvent;
		const refund = ledgerEvent({
			type: "payment.refunded",
			school: SCHOOL,
			tz: TZ,
			eventTime: tRefund,
			ingestTime: ingest(tRefund),
			key: holder,
			idem: "stripe:re_9",
			amount: 13000,
			cause: payEvent.id,
			text: "refunded the October payment 130 USD",
			payload: {
				id: "re_9",
				amount: 13000,
				currency: "usd",
				billing_email: "member@example.test",
			},
		});
		events.push(refund);
		netSincePayout -= 13000;
		const tAdj = tRefund + 60_000;
		exec(
			{
				...base("updateBalance", tAdj),
				featureId: FEATURE,
				internalFeatureId: "feat_visit",
				addToBalance: -1,
			},
			{
				cause: refund.id,
				reason: "payment refunded",
				payload: { reason: "payment refunded" },
			},
		);
	});

	// ---- November: an attended session is reversed by the studio -------------------------------------------------------
	const tReverse = renewal(10) + 12 * DAY;
	at(tReverse, () => {
		const spent = [...events]
			.reverse()
			.find((e) => e.event_type === "credit.spent") as AtmEvent;
		exec(
			{
				...base("updateBalance", tReverse),
				featureId: FEATURE,
				internalFeatureId: "feat_visit",
				addToBalance: 1,
			},
			{
				as: "refunded",
				service: spent.labels.service,
				cause: spent.id,
				labels: { service: spent.labels.service as string },
			},
		);
	});

	// ---- end of year: the cron's last look at what has lapsed -----------------------------------------------------------
	const tEnd = Date.UTC(2026, 11, 31, 23, 59, 0);
	at(tEnd, () => lapse(tEnd));

	actions.sort((a, b) => a.t - b.t || a.order - b.order);
	for (const a of actions) a.run();
	void allowance;
	void lastId;

	events.sort((a, b) => (a.id < b.id ? -1 : 1));
	const last = events[events.length - 1] as AtmEvent;
	const asOfMs = Date.parse(last.event_time);
	const totals = new Map<string, bigint>();
	for (const e of events) {
		for (const p of e.postings) {
			const k = `${p.account} ${p.commodity}`;
			const places = p.commodity === "USD" ? 2 : 0;
			const [i = "0", f = ""] = p.amount.replace("-", "").split(".");
			const units =
				BigInt(i + f.padEnd(places, "0")) *
				(p.amount.startsWith("-") ? -1n : 1n);
			totals.set(k, (totals.get(k) ?? 0n) + units);
		}
	}
	const postingTotals: Record<string, string> = {};
	for (const k of [...totals.keys()].sort()) {
		const v = totals.get(k) as bigint;
		const places = k.endsWith(" USD") ? 2 : 0;
		const abs = (v < 0n ? -v : v).toString().padStart(places + 1, "0");
		postingTotals[k] =
			`${v < 0n ? "-" : ""}${places ? `${abs.slice(0, -places)}.${abs.slice(-places)}` : abs}`;
	}
	const balances = balancesOf({
		states: { [holder]: state as never },
		holds,
		catalog,
		asOfMs,
	});
	return {
		seed,
		school: SCHOOL,
		events,
		catalog: rows,
		expected: {
			seed,
			school: SCHOOL,
			holder,
			asOf: last.event_time,
			lastEventId: last.id,
			eventCount: events.length,
			balances,
			postingTotals,
		},
	};
};

const withoutCommand = (mutation: unknown) => {
	const { command: _c, ...rest } = mutation as Record<string, unknown>;
	return rest;
};

void canonicalize;

const FIELD_ORDER = [
	"v",
	"id",
	"school",
	"source",
	"event_type",
	"event_time",
	"ingest_time",
	"date",
	"tz",
	"key",
	"labels",
	"idem",
	"cause",
	"text",
	"postings",
	"payload",
	"redacted",
];

/** The event with `cause` set, its keys back in the envelope's fixed order. */
const withCause = (e: AtmEvent, cause: string): AtmEvent => {
	const next = { ...e, cause } as Record<string, unknown>;
	return Object.fromEntries(
		FIELD_ORDER.filter((k) => k in next).map((k) => [k, next[k]]),
	) as unknown as AtmEvent;
};
