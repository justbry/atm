/**
 * A second golden fixture: twelve families of one school over four months (November 2026 to February 2027), run through
 * the real balance engine. It is there for what the first one (`vibes.ts`, one family, 2026) cannot show:
 *
 * - a year boundary, and payments at the boundary instants of the school's day (Denver, UTC-7 all through this span): at
 *   23:30 and 23:59:59 on the last day of a month, which are the next month in UTC, and at 00:00:00 and 00:30 on the first;
 * - a dispute lost and a dispute won, on two families, a partial refund, a payout that sums many payments;
 * - a fundraise received (three gifts and a fourth after the payout) and paid out;
 * - a family that cancels (`plan.canceled`, `credit.expiration_changed`, then its credits lapse) and one that is erased
 *   (`subject.erased`; its payments carry no personal field);
 * - `credit.low` and `credit.depleted`, which have no postings;
 * - a payment that reached the log late: dated in a month already journaled, written in a `late-*.jsonl` batch under its day
 *   together with a second delivery of an event the day already holds.
 *
 * Nothing here reads the clock or the process time zone. Every instant is a local wall time turned to UTC by a fixed
 * seven-hour offset, and the month an event belongs to is worked out here from that offset, not by the code under test.
 * `expected` is the generator's own ledger of what it decided: the money lines are its own arithmetic (gross, fee, net),
 * and the credit lines are those of the engine events it made, summed by this file. `buildJournal` is never called.
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
import type {
	AtmCatalogRow,
	AtmEvent,
	AtmEventContext,
	AtmHold,
	ReconcileStripe,
} from "../src/types.js";
import { makeRng } from "./rng.js";
import { FEATURE, TZ, catalogRows as yearCatalogRows } from "./vibes.js";

export const MULTI_SCHOOL = "sch_multi";
export const MULTI_FEATURE = FEATURE;
export const MULTI_TZ = TZ;
/** Where a stripe-held payout key, a Zeffy payout key and the like live: no family owns them. */
export const PAYOUT_KEY = "stripe:payouts";
export const FUNDRAISE_KEY = "zeffy:fundraising";
export const CAMPAIGN = "fall-fair";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Denver is on standard time (UTC-7) from 2026-11-01 02:00 to 2027-03-14: every instant below is inside it. */
const LOCAL_OFFSET = 7 * HOUR;
const FIRST_LOCAL_INSTANT = Date.UTC(2026, 10, 2) + LOCAL_OFFSET;
const LAST_LOCAL_INSTANT = Date.UTC(2027, 2, 2) + LOCAL_OFFSET;

/** A local wall time as a UTC instant. `month` is 1 to 12. */
const local = (
	year: number,
	month: number,
	day: number,
	hour = 0,
	minute = 0,
	second = 0,
): number =>
	Date.UTC(year, month - 1, day, hour, minute, second) + LOCAL_OFFSET;
const localDayOf = (instant: number): string =>
	new Date(instant - LOCAL_OFFSET).toISOString().slice(0, 10);
const localMonthOf = (instant: number): string =>
	localDayOf(instant).slice(0, 7);
const utcDayOf = (instant: number): string =>
	new Date(instant).toISOString().slice(0, 10);

/** The cron's last look at what has lapsed: after the school's midnight, when the last rollovers expire and the resets of the 23:59:59 payments have run. */
export const LAST_LOOK = local(2027, 3, 1, 1, 0, 0);

type Outcome = "attend" | "cancel" | "noshow";
type Tier = "sparkle-2" | "sparkle-1";
type Schedule = "eom-2330" | "som-0000" | "eom-235959" | "som-0030" | "regular";

type FamilySpec = {
	tier: Tier;
	schedule: Schedule;
	/** Outcomes of the bookings made after each of the four renewals (November to February), in order. */
	bookings: [Outcome[], Outcome[], Outcome[], Outcome[]];
	name: string;
	email: string;
};

const FAMILIES: FamilySpec[] = [
	// the school-day boundary, as the school's clock sees it
	{
		tier: "sparkle-2",
		schedule: "eom-2330",
		bookings: [["attend"], ["attend", "attend"], ["attend"], []],
		name: "Marlow Ashgrove",
		email: "marlow.ashgrove@example.test",
	},
	{
		tier: "sparkle-2",
		schedule: "som-0000",
		bookings: [
			["attend", "cancel"],
			["attend"],
			["attend", "attend"],
			["attend"],
		],
		name: "Odalys Brennick",
		email: "odalys.brennick@example.test",
	},
	{
		tier: "sparkle-1",
		schedule: "eom-235959",
		bookings: [["attend"], ["attend"], [], ["attend"]],
		name: "Pernell Castellan",
		email: "pernell.castellan@example.test",
	},
	{
		tier: "sparkle-1",
		schedule: "som-0030",
		bookings: [["attend"], ["cancel"], ["attend"], []],
		name: "Quillon Delacroix",
		email: "quillon.delacroix@example.test",
	},
	// 4: partial refund in December, and the first to be alerted (two sessions, both held in November)
	{
		tier: "sparkle-2",
		schedule: "regular",
		bookings: [["attend", "attend"], ["attend"], ["attend"], []],
		name: "Rosalind Evergreen",
		email: "rosalind.evergreen@example.test",
	},
	// 5: dispute lost on the December payment
	{
		tier: "sparkle-2",
		schedule: "regular",
		bookings: [["attend"], ["attend", "attend"], ["attend"], ["attend"]],
		name: "Soren Fairweather",
		email: "soren.fairweather@example.test",
	},
	// 6: dispute won on the January payment
	{
		tier: "sparkle-2",
		schedule: "regular",
		bookings: [["attend"], [], ["attend"], []],
		name: "Tamsin Gallowglass",
		email: "tamsin.gallowglass@example.test",
	},
	// 7: cancels in December
	{
		tier: "sparkle-2",
		schedule: "regular",
		bookings: [["attend"], ["attend"], [], []],
		name: "Ulric Hawthorne",
		email: "ulric.hawthorne@example.test",
	},
	// 8: the late payment is his second child's
	{
		tier: "sparkle-1",
		schedule: "regular",
		bookings: [["attend"], ["attend"], [], ["attend"]],
		name: "Vesper Ironwood",
		email: "vesper.ironwood@example.test",
	},
	// 9: erased in February
	{
		tier: "sparkle-1",
		schedule: "regular",
		bookings: [["attend"], [], ["attend"], ["attend"]],
		name: "Wystan Juniper",
		email: "wystan.juniper@example.test",
	},
	// 10: a booking still open on the last day
	{
		tier: "sparkle-1",
		schedule: "regular",
		bookings: [[], ["attend"], ["attend"], []],
		name: "Xanthe Kestrel",
		email: "xanthe.kestrel@example.test",
	},
	// 11: a no-show
	{
		tier: "sparkle-1",
		schedule: "regular",
		bookings: [["noshow"], ["attend"], ["attend"], []],
		name: "Yarrow Lindqvist",
		email: "yarrow.lindqvist@example.test",
	},
];

const REFUND_FAMILY = 4;
const LOST_FAMILY = 5;
const WON_FAMILY = 6;
const CANCEL_FAMILY = 7;
const LATE_FAMILY = 8;
const ERASED_FAMILY = 9;
const OPEN_FAMILY = 10;

const ORG = {
	config: {
		reverse_deduction_order: false,
		block_overdue_entitlements: false,
		include_past_due: true,
	},
};

const GROSS_PER_SESSION = 13000;
const PARTIAL_REFUND = 5000;
const FUNDRAISE_GIFTS = [5000, 12000, 2500];
const FUNDRAISE_AFTER_PAYOUT = 4000;
const LATE_GROSS = 13000;
const LOW_CREDIT_THRESHOLD = 1;

/** Stripe's fee on a card payment: 2.9 percent and 30 cents. */
const feeOf = (cents: number): number => Math.round(cents * 0.029) + 30;

export type MultiBoundary = {
	/** The payment's `idem`. */
	idem: string;
	instant: string;
	/** The school-local calendar day, worked out here from the fixed offset. */
	localDate: string;
	utcDate: string;
	/** The school-local month: the one the journal must put it in. */
	month: string;
	/** The UTC month, which differs from `month` for the last evening of a month. */
	utcMonth: string;
};

type Listed<T> = T extends readonly (infer Item)[] | undefined ? Item[] : never;
/** Stripe's lists in the shape `reconcile` reads, each record checked against its type. */
type FiveLists = Required<Omit<ReconcileStripe, "paymentIntents">>;
type StripeSide = {
	[List in keyof FiveLists]: Listed<FiveLists[List]>;
};

export type MultiFixture = {
	seed: number;
	school: string;
	/** Every event, the late ones included, sorted by id. */
	events: AtmEvent[];
	/** The events that reached the log in a later batch (`late-*.jsonl`): they are also in `events`. */
	late: AtmEvent[];
	/** What the late batch holds that the log already had: a second delivery, dropped by `idem`. */
	lateDuplicates: AtmEvent[];
	catalog: AtmCatalogRow[];
	expected: {
		seed: number;
		school: string;
		tz: string;
		asOf: string;
		lastEventId: string;
		eventCount: number;
		holders: { holder: string; tier: Tier; schedule: Schedule }[];
		balances: {
			holder: string;
			feature: string;
			avail: number;
			held: number;
		}[];
		/** Sum of every posting per account and commodity: the money lines from this file's own arithmetic, the credit lines from the engine's events. */
		postingTotals: Record<string, string>;
		/** The same, by the school-local month the generator put the event in (`YYYY-MM`). */
		postingTotalsByMonth: Record<string, Record<string, string>>;
		/** Events with postings (hledger transactions) per local month. */
		transactionsByMonth: Record<string, number>;
		eventCountsByType: Record<string, number>;
		boundary: MultiBoundary[];
		late: {
			file: string;
			eventId: string;
			idem: string;
			month: string;
			duplicateIdem: string;
		};
		erased: {
			holder: string;
			/** The fake personal data the family's payments carried before the erasure. None of it may remain anywhere. */
			personal: string[];
			objects: string[];
		};
		/** What each family would show of its personal data in the event files: the control for the erased one. */
		personalByHolder: Record<string, string[]>;
		/** Stripe's side as the generator decided it, in the shape of `reconcile`'s input. */
		stripe: StripeSide;
	};
};

type Posting = [account: string, commodity: string, units: number];

type Family = {
	index: number;
	spec: FamilySpec;
	id: string;
	holder: string;
	identity: {
		orgId: string;
		env: string;
		customerId: string;
		entityId: null;
	};
	units: number;
	renewals: number[];
	state: SubjectState | null;
	planLabel: string;
	lapsed: Set<string>;
	paidEvents: AtmEvent[];
};

type Action = { t: number; order: number; run: () => void };

const places = (commodity: string): number => (commodity === "USD" ? 2 : 0);

const unitsToText = (units: bigint, commodity: string): string => {
	const decimals = places(commodity);
	const negative = units < 0n;
	const digits = (negative ? -units : units)
		.toString()
		.padStart(decimals + 1, "0");
	const text = decimals
		? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`
		: digits;
	return negative ? `-${text}` : text;
};

const postingUnits = (amount: string, commodity: string): bigint => {
	const negative = amount.startsWith("-");
	const [whole = "0", fraction = ""] = amount.replace("-", "").split(".");
	const digits = BigInt(whole + fraction.padEnd(places(commodity), "0"));
	return negative ? -digits : digits;
};

export const generateMulti = ({ seed }: { seed: number }): MultiFixture => {
	const rng = makeRng(`multi:${seed}`);
	const rows = yearCatalogRows().map((row) => ({
		...row,
		row: { ...row.row, org_id: MULTI_SCHOOL },
	})) as AtmCatalogRow[];
	const catalog = toCatalog(rows);
	const featureOf = (internal: string) => catalog.features[internal]?.id;

	const used = new Set<string>();
	const familyId = (): string => {
		for (;;) {
			const id = `fam_${rng.id(4)}`;
			if (!used.has(id)) {
				used.add(id);
				return id;
			}
		}
	};

	const families: Family[] = FAMILIES.map((spec, index) => {
		const id = familyId();
		const day = rng.int(3, 26);
		const hour = rng.int(9, 20);
		const minute = rng.int(0, 59);
		const months: [number, number][] = [
			[2026, 11],
			[2026, 12],
			[2027, 1],
			[2027, 2],
		];
		const renewals = months.map(([year, month], m) => {
			switch (spec.schedule) {
				case "eom-2330":
					return local(year, month, [30, 31, 31, 28][m] as number, 23, 30);
				case "eom-235959":
					return local(year, month, [30, 31, 31, 28][m] as number, 23, 59, 59);
				case "som-0000":
					return local(year, month, m === 0 ? 2 : 1, 0, 0, 0);
				case "som-0030":
					return local(year, month, m === 0 ? 2 : 1, 0, 30, 0);
				default:
					return local(year, month, day, hour, minute, 0);
			}
		});
		return {
			index,
			spec,
			id,
			holder: `family:${id}`,
			identity: {
				orgId: MULTI_SCHOOL,
				env: "live",
				customerId: `family:${id}`,
				entityId: null,
			},
			units: spec.tier === "sparkle-2" ? 2 : 1,
			renewals,
			state: null,
			planLabel: `${spec.tier}@v1`,
			lapsed: new Set<string>(),
			paidEvents: [],
		};
	});
	const family = (index: number): Family => families[index] as Family;

	const events: AtmEvent[] = [];
	const late: AtmEvent[] = [];
	const lateDuplicates: AtmEvent[] = [];
	const holds: Record<string, AtmHold> = {};
	const lockRows = new Map<string, Record<string, unknown>>();
	let counter = 0;

	// ---- the generator's own ledger ---------------------------------------------------------------------------------
	const totals = new Map<string, bigint>();
	const byMonth = new Map<string, Map<string, bigint>>();
	const transactions = new Map<string, number>();
	const bookUnits = (instant: number, postings: Posting[]) => {
		const month = localMonthOf(instant);
		const monthTotals = byMonth.get(month) ?? new Map<string, bigint>();
		byMonth.set(month, monthTotals);
		for (const [account, commodity, units] of postings) {
			const key = `${account} ${commodity}`;
			totals.set(key, (totals.get(key) ?? 0n) + BigInt(units));
			monthTotals.set(key, (monthTotals.get(key) ?? 0n) + BigInt(units));
		}
		transactions.set(month, (transactions.get(month) ?? 0) + 1);
	};
	/** A money line the generator decided: cents, and the postings are its own arithmetic. */
	const bookMoney = (instant: number, postings: [string, number][]) =>
		bookUnits(
			instant,
			postings.map(([account, cents]) => [account, "USD", cents]),
		);
	/** The credit lines of the engine events a command made: what the engine decided, summed here. */
	const bookCredits = (made: AtmEvent[]) => {
		for (const event of made) {
			if (event.postings.length === 0) continue;
			const instant = Date.parse(event.event_time);
			const month = localMonthOf(instant);
			const monthTotals = byMonth.get(month) ?? new Map<string, bigint>();
			byMonth.set(month, monthTotals);
			for (const posting of event.postings) {
				const key = `${posting.account} ${posting.commodity}`;
				const units = postingUnits(posting.amount, posting.commodity);
				totals.set(key, (totals.get(key) ?? 0n) + units);
				monthTotals.set(key, (monthTotals.get(key) ?? 0n) + units);
			}
			transactions.set(month, (transactions.get(month) ?? 0) + 1);
		}
	};
	/** An event with no postings is not a transaction: nothing is booked for it. */
	const push = (event: AtmEvent, options: { late?: boolean } = {}) => {
		events.push(event);
		if (options.late) late.push(event);
	};

	// ---- Stripe's side, from the decisions --------------------------------------------------------------------------
	const stripe: StripeSide = {
		invoices: [],
		refunds: [],
		disputes: [],
		payouts: [],
		balanceTransactions: [],
	};
	const seconds = (instant: number) => Math.floor(instant / SECOND);
	let stripeBalance = 0;

	const ingest = (t: number) => t + rng.int(200, 2500);

	const base = (f: Family, type: string, t: number) => {
		counter += 1;
		const id = `cmd_${String(f.index).padStart(2, "0")}_${String(counter).padStart(4, "0")}`;
		return {
			schemaVersion: 1,
			type,
			org: ORG,
			commandId: id,
			requestId: id.replace("cmd_", "req_"),
			identity: f.identity,
			occurredAt: t,
		};
	};

	const exec = (
		f: Family,
		command: Record<string, unknown>,
		ctx: Partial<AtmEventContext>,
	) => {
		const t = command.occurredAt as number;
		const before = f.state;
		const run = runOnState({ state: before, catalog, command });
		if (!run.mutation)
			throw new Error(
				`${String(command.type)} decided nothing for ${f.id} at ${new Date(t).toISOString()}`,
			);
		const rejected =
			(run.mutation.result as { status?: string }).status === "rejected";
		if (rejected)
			throw new Error(
				`${String(command.type)} was rejected for ${f.id} at ${new Date(t).toISOString()}`,
			);
		f.state = run.state;
		const made = mutationToEvents({
			mutation: run.mutation,
			context: {
				school: MULTI_SCHOOL,
				tz: MULTI_TZ,
				feature: MULTI_FEATURE,
				plan: f.planLabel,
				ingestTime: new Date(ingest(t)).toISOString(),
				before: before as never,
				...ctx,
			},
		});
		for (const event of made) push(event);
		bookCredits(made);
		return { mutation: run.mutation, made };
	};

	/** The cron books the expiry of anything lapsed by `t`, at the instant it lapsed. */
	const lapse = (f: Family, t: number) => {
		if (!f.state) return;
		for (const row of lapsedRows({
			state: f.state,
			featureOf,
			feature: MULTI_FEATURE,
			atMs: t,
		})) {
			const key = `${row.id}:${row.expires_at}`;
			if (f.lapsed.has(key)) continue;
			f.lapsed.add(key);
			const event = lapseEvent({
				row,
				holder: f.holder,
				key: f.holder,
				feature: MULTI_FEATURE,
				school: MULTI_SCHOOL,
				tz: MULTI_TZ,
				revision: f.state.revision,
				labels: { plan: f.planLabel },
				ingestTime: ingest(row.expires_at),
			});
			push(event);
			bookCredits([event]);
		}
	};

	const planEvent = (
		f: Family,
		type: "plan.attached" | "plan.canceled",
		t: number,
		mutation: unknown,
		text: string,
		cause?: string,
	) => {
		const { command, ...decided } = mutation as {
			command: unknown;
			id: string;
			revision: { before: number };
		};
		const event = ledgerEvent({
			type,
			school: MULTI_SCHOOL,
			tz: MULTI_TZ,
			eventTime: t,
			ingestTime: ingest(t),
			key: f.holder,
			idem: `plan:${decided.id}`,
			labels: { plan: f.planLabel, feature: MULTI_FEATURE },
			cause,
			text,
			payload: { command, mutation: decided },
			revision: decided.revision.before,
		});
		push(event);
		return event;
	};

	const actions: Action[] = [];
	let order = 0;
	const at = (t: number, run: () => void) => {
		if (t < FIRST_LOCAL_INSTANT || t >= LAST_LOCAL_INSTANT)
			throw new Error(
				`${new Date(t).toISOString()} is outside the fixed offset`,
			);
		actions.push({ t, order: order++, run });
	};

	const personalByHolder: Record<string, string[]> = {};
	const boundary: MultiBoundary[] = [];

	/** A payment the family made: the event, the generator's own money lines, and Stripe's record of it. */
	const payment = ({
		f,
		t,
		gross,
		kind,
		id,
		text,
		late: isLate = false,
	}: {
		f: Family;
		t: number;
		gross: number;
		kind: string;
		id: string;
		text: string;
		late?: boolean;
	}): AtmEvent => {
		const fee = feeOf(gross);
		const erased = f.index === ERASED_FAMILY;
		personalByHolder[f.holder] = [f.spec.name, f.spec.email];
		const event = ledgerEvent({
			type: "payment.succeeded",
			school: MULTI_SCHOOL,
			tz: MULTI_TZ,
			eventTime: t,
			ingestTime: isLate
				? local(2027, 2, 20, 12, 0, 0) + rng.int(0, 999)
				: ingest(t),
			key: f.holder,
			idem: `stripe:${id}`,
			amount: gross,
			fee,
			incomeKind: `membership:${kind}`,
			labels: { plan: `${kind}@v1` },
			text,
			payload: {
				id,
				amount_paid: gross,
				fee,
				currency: "usd",
				customer: `cus_${f.id}`,
				// the erased family's payments were rewritten without their personal fields
				...(erased
					? {}
					: { billing_email: f.spec.email, billing_name: f.spec.name }),
			},
		});
		push(event, { late: isLate });
		f.paidEvents.push(event);
		bookMoney(t, [
			["assets:stripe", gross - fee],
			["expenses:billing:stripe-fees", fee],
			[`income:billing:membership:${kind}`, -gross],
		]);
		stripeBalance += gross - fee;
		stripe.invoices.push({
			id,
			status: "paid",
			amount_paid: gross,
			currency: "usd",
			created: seconds(t) - 60,
			livemode: true,
			status_transitions: { paid_at: seconds(t) },
		});
		stripe.balanceTransactions.push({
			id: `txn_${id}`,
			amount: gross,
			fee,
			net: gross - fee,
			currency: "usd",
			created: seconds(t),
			type: "charge",
		});
		// within an hour of the school's midnight, or on a different day in UTC: the instants a month can be mistaken at
		const timeOfDay = (t - LOCAL_OFFSET) % DAY;
		if (
			localDayOf(t) !== utcDayOf(t) ||
			timeOfDay < HOUR ||
			timeOfDay >= 23 * HOUR
		)
			boundary.push({
				idem: `stripe:${id}`,
				instant: event.event_time,
				localDate: localDayOf(t),
				utcDate: utcDayOf(t),
				month: localMonthOf(t),
				utcMonth: utcDayOf(t).slice(0, 7),
			});
		return event;
	};

	// ---- each family: the plan, the grants, the renewals, the bookings --------------------------------------------------
	const paymentIds = new Map<string, string>();
	const attachCommand = (f: Family, t: number) => ({
		...base(f, "applyBillingPlan", t),
		entityIds: [],
		expiringPooledBalanceIds: [],
		ops: [
			{
				op: "insert",
				table: "customer",
				row: {
					internal_id: `cus_${f.id}`,
					id: f.holder,
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
					id: `cp_${f.index}`,
					internal_customer_id: `cus_${f.id}`,
					internal_product_id: `prod_${f.spec.tier}`,
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
					id: `ce_${f.index}`,
					customer_product_id: `cp_${f.index}`,
					entitlement_id: f.units === 2 ? "ent_s2" : "ent_s1",
					internal_customer_id: `cus_${f.id}`,
					internal_entity_id: null,
					internal_feature_id: "feat_visit",
					balance: f.units,
					adjustment: 0,
					additional_balance: 0,
					unlimited: false,
					usage_allowed: false,
					next_reset_at: f.renewals[1],
					reset_cycle_anchor: null,
					expires_at: null,
					external_id: null,
					created_at: t,
				},
			},
		],
	});

	for (const f of families) {
		const canceled = f.index === CANCEL_FAMILY;
		// the cancelled family pays in November and December only
		const paidMonths = canceled ? 2 : 4;
		for (let m = 0; m < paidMonths; m++) {
			const R = f.renewals[m] as number;
			const gross = GROSS_PER_SESSION * f.units;
			const id = `in_${rng.id(8)}`;
			paymentIds.set(`${f.index}:${m}`, id);
			let paid: AtmEvent | undefined;
			at(R, () => {
				paid = payment({
					f,
					t: R,
					gross,
					kind: f.spec.tier,
					id,
					text: `membership payment ${gross / 100} USD for ${f.spec.tier}`,
				});
				if (m > 0) return;
				const t = R + SECOND;
				const { mutation } = exec(f, attachCommand(f, t), { cause: paid.id });
				planEvent(
					f,
					"plan.attached",
					t,
					mutation,
					`attached ${f.planLabel}`,
					paid.id,
				);
			});
			if (m > 0) {
				// the cron's reset follows the payment by a few seconds: after the 23:59:59 payment of the last day it is already March
				const tr = R + 5 * SECOND + rng.int(0, 25) * SECOND;
				at(tr, () => {
					lapse(f, tr);
					exec(f, base(f, "reset", tr), {
						source: "cron",
						cause: paid?.id,
					});
				});
			}
			for (const [k, outcome] of (f.spec.bookings[m] ?? []).entries()) {
				const holdT = R + (2 + 5 * k) * DAY + rng.int(0, 8) * HOUR;
				const sessionT = holdT + 3 * DAY + rng.int(0, 6) * HOUR;
				// a booking whose session falls after the last day is left out, except the one family's open booking below
				if (sessionT + 3 * HOUR >= LAST_LOCAL_INSTANT - DAY) continue;
				scheduleBooking(f, { outcome, holdT, sessionT });
			}
		}
	}

	function scheduleBooking(
		f: Family,
		{
			outcome,
			holdT,
			sessionT,
			open = false,
		}: { outcome: Outcome; holdT: number; sessionT: number; open?: boolean },
	) {
		const booking = `bk_${rng.id(6)}`;
		const service = rng.pick(["massage-90", "light-60", "energy-45"] as const);
		const lockId = `lock_${booking}`;
		const expiresAt = sessionT + 2 * HOUR;
		let heldEvent: AtmEvent | undefined;
		at(holdT, () => {
			lapse(f, holdT);
			const { mutation, made } = exec(
				f,
				{
					...base(f, "track", holdT),
					featureId: MULTI_FEATURE,
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
					lowCreditThreshold: LOW_CREDIT_THRESHOLD,
				},
			);
			const lock = mutation.changes.find(
				(c) => c.table === "locks" && c.op === "insert",
			);
			if (lock?.op === "insert")
				lockRows.set(lockId, lock.row as Record<string, unknown>);
			heldEvent = made.find((e) => e.event_type === "credit.held");
			holds[lockId] = { holder: f.holder, feature: MULTI_FEATURE, units: 1 };
		});
		if (open) return;
		const settle = (t: number, finalValue: number | null) => {
			lapse(f, t);
			exec(
				f,
				{
					...base(f, "finalize", t),
					lock: lockRows.get(lockId),
					internalFeatureId: "feat_visit",
					finalValue,
					properties: null,
				},
				{
					service,
					cause: heldEvent?.id,
					labels: { service },
					lowCreditThreshold: LOW_CREDIT_THRESHOLD,
				},
			);
			delete holds[lockId];
		};
		if (outcome === "attend")
			at(sessionT + HOUR, () => settle(sessionT + HOUR, null));
		if (outcome === "cancel") at(holdT + DAY, () => settle(holdT + DAY, 0));
		if (outcome === "noshow") {
			const tc = expiresAt + 5 * MINUTE;
			at(tc, () => {
				lapse(f, tc);
				exec(
					f,
					{
						...base(f, "confirmExpiredLock", tc),
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

	// ---- a booking still open on the last day (held, not settled) ---------------------------------------------------------
	scheduleBooking(family(OPEN_FAMILY), {
		outcome: "attend",
		holdT: local(2027, 2, 27, 17, 0, 0),
		sessionT: local(2027, 3, 1, 17, 0, 0) - 1,
		open: true,
	});

	// ---- payouts: each takes the whole of Stripe's balance at its time, so it sums every payment made since the last ----------
	const payoutDays: [number, number, number][] = [
		[2026, 11, 12],
		[2026, 12, 12],
		[2027, 1, 12],
		[2027, 2, 12],
		[2027, 2, 27],
	];
	for (const [n, [year, month, day]] of payoutDays.entries()) {
		const tp = local(year, month, day, 10, 0, 0);
		at(tp, () => {
			const amount = stripeBalance;
			if (amount <= 0) throw new Error(`payout ${n} has nothing to pay`);
			stripeBalance = 0;
			const id = `po_${n + 1}`;
			const event = ledgerEvent({
				type: "payout.paid",
				school: MULTI_SCHOOL,
				tz: MULTI_TZ,
				eventTime: tp,
				ingestTime: ingest(tp),
				key: PAYOUT_KEY,
				idem: `stripe:${id}`,
				amount,
				text: `payout ${amount / 100} USD`,
				payload: { id, amount, currency: "usd" },
			});
			push(event);
			bookMoney(tp, [
				["assets:stripe", -amount],
				["assets:clearing:stripe-payouts", amount],
			]);
			stripe.payouts.push({
				id,
				amount,
				currency: "usd",
				created: seconds(tp),
				status: "paid",
				livemode: true,
			});
			stripe.balanceTransactions.push({
				id: `txn_${id}`,
				amount: -amount,
				fee: 0,
				net: -amount,
				currency: "usd",
				created: seconds(tp),
				type: "payout",
			});
		});
	}

	// ---- December: the partial refund, and a dispute lost ---------------------------------------------------------------------
	const paymentOf = (f: Family, m: number): AtmEvent =>
		f.paidEvents.find(
			(e) => e.payload.id === paymentIds.get(`${f.index}:${m}`),
		) as AtmEvent;
	const refundFamily = family(REFUND_FAMILY);
	const tRefund = (refundFamily.renewals[1] as number) + DAY + 2 * HOUR;
	at(tRefund, () => {
		const paid = paymentOf(refundFamily, 1);
		const id = `re_${rng.id(8)}`;
		const event = ledgerEvent({
			type: "payment.refunded",
			school: MULTI_SCHOOL,
			tz: MULTI_TZ,
			eventTime: tRefund,
			ingestTime: ingest(tRefund),
			key: refundFamily.holder,
			idem: `stripe:${id}`,
			amount: PARTIAL_REFUND,
			cause: paid.id,
			text: `refunded ${PARTIAL_REFUND / 100} USD of the December payment`,
			payload: {
				id,
				amount: PARTIAL_REFUND,
				currency: "usd",
				billing_email: refundFamily.spec.email,
			},
		});
		push(event);
		bookMoney(tRefund, [
			["assets:stripe", -PARTIAL_REFUND],
			["income:billing:refunds", PARTIAL_REFUND],
		]);
		stripeBalance -= PARTIAL_REFUND;
		stripe.refunds.push({
			id,
			amount: PARTIAL_REFUND,
			currency: "usd",
			created: seconds(tRefund),
			status: "succeeded",
		});
		stripe.balanceTransactions.push({
			id: `txn_${id}`,
			amount: -PARTIAL_REFUND,
			fee: 0,
			net: -PARTIAL_REFUND,
			currency: "usd",
			created: seconds(tRefund),
			type: "refund",
		});
	});

	/** A dispute on a payment, opened at `opened` and closed at `closed` as won or lost. */
	const dispute = (
		f: Family,
		m: number,
		opened: number,
		closed: number,
		status: "won" | "lost",
	) => {
		const id = `dp_${rng.id(8)}`;
		const amount = GROSS_PER_SESSION * f.units;
		let openEvent: AtmEvent | undefined;
		at(opened, () => {
			const paid = paymentOf(f, m);
			openEvent = ledgerEvent({
				type: "payment.disputed",
				school: MULTI_SCHOOL,
				tz: MULTI_TZ,
				eventTime: opened,
				ingestTime: ingest(opened),
				key: f.holder,
				idem: `stripe:${id}`,
				amount,
				cause: paid.id,
				text: `dispute opened on a ${amount / 100} USD payment`,
				payload: { id, amount, reason: "fraudulent" },
			});
			push(openEvent);
			bookMoney(opened, [
				["assets:stripe", -amount],
				["expenses:billing:disputes", amount],
			]);
			stripeBalance -= amount;
			stripe.balanceTransactions.push({
				id: `txn_${id}`,
				amount: -amount,
				fee: 0,
				net: -amount,
				currency: "usd",
				created: seconds(opened),
				type: "adjustment",
			});
		});
		at(closed, () => {
			push(
				ledgerEvent({
					type: "dispute.closed",
					school: MULTI_SCHOOL,
					tz: MULTI_TZ,
					eventTime: closed,
					ingestTime: ingest(closed),
					key: f.holder,
					idem: `stripe:${id}:closed`,
					amount,
					won: status === "won",
					cause: openEvent?.id,
					text: `dispute ${status}`,
					payload: { id, status },
				}),
			);
			if (status === "won") {
				bookMoney(closed, [
					["assets:stripe", amount],
					["expenses:billing:disputes", -amount],
				]);
				stripeBalance += amount;
				stripe.balanceTransactions.push({
					id: `txn_${id}_won`,
					amount,
					fee: 0,
					net: amount,
					currency: "usd",
					created: seconds(closed),
					type: "adjustment",
				});
			}
			// a lost dispute books nothing: the debit at the opening stands
		});
		stripe.disputes.push({
			id,
			amount,
			currency: "usd",
			created: seconds(opened),
			status,
			livemode: true,
		});
	};
	const lostFamily = family(LOST_FAMILY);
	dispute(
		lostFamily,
		1,
		(lostFamily.renewals[1] as number) + 3 * DAY + 4 * HOUR,
		(lostFamily.renewals[1] as number) + 20 * DAY + 2 * HOUR,
		"lost",
	);
	const wonFamily = family(WON_FAMILY);
	dispute(
		wonFamily,
		2,
		(wonFamily.renewals[2] as number) + 4 * DAY + HOUR,
		(wonFamily.renewals[2] as number) + 19 * DAY + 3 * HOUR,
		"won",
	);

	// ---- fundraise: three gifts, one payout of their sum, a fourth gift after it --------------------------------------------------
	let zeffyBalance = 0;
	const gift = (n: number, t: number, amount: number) =>
		at(t, () => {
			const id = `zf_${n}`;
			push(
				ledgerEvent({
					type: "fundraise.received",
					school: MULTI_SCHOOL,
					tz: MULTI_TZ,
					eventTime: t,
					ingestTime: ingest(t),
					key: FUNDRAISE_KEY,
					idem: `zeffy:${id}`,
					amount,
					campaign: CAMPAIGN,
					text: `fundraise gift ${amount / 100} USD for ${CAMPAIGN}`,
					payload: { id, amount, campaign: CAMPAIGN },
				}),
			);
			bookMoney(t, [
				["assets:clearing:zeffy", amount],
				[`income:fundraising:${CAMPAIGN}`, -amount],
			]);
			zeffyBalance += amount;
		});
	gift(1, local(2026, 12, 3, 14, 5, 0), FUNDRAISE_GIFTS[0] as number);
	gift(2, local(2026, 12, 10, 19, 40, 0), FUNDRAISE_GIFTS[1] as number);
	gift(3, local(2026, 12, 19, 8, 15, 0), FUNDRAISE_GIFTS[2] as number);
	const tZeffyPayout = local(2027, 1, 6, 12, 0, 0);
	at(tZeffyPayout, () => {
		const amount = zeffyBalance;
		zeffyBalance = 0;
		push(
			ledgerEvent({
				type: "fundraise.paid_out",
				school: MULTI_SCHOOL,
				tz: MULTI_TZ,
				eventTime: tZeffyPayout,
				ingestTime: ingest(tZeffyPayout),
				key: FUNDRAISE_KEY,
				idem: "zeffy:zp_1",
				amount,
				text: `fundraise payout ${amount / 100} USD`,
				payload: { id: "zp_1", amount },
			}),
		);
		bookMoney(tZeffyPayout, [
			["assets:clearing:zeffy", -amount],
			["assets:clearing:zeffy-payouts", amount],
		]);
	});
	gift(4, local(2027, 2, 9, 16, 30, 0), FUNDRAISE_AFTER_PAYOUT);

	// ---- the cancelling family: the plan ends at its period's end, the credits left lapse then ----------------------------------------------
	const canceller = family(CANCEL_FAMILY);
	const tCancel = (canceller.renewals[1] as number) + 6 * DAY + 3 * HOUR;
	const periodEnd = canceller.renewals[2] as number;
	at(tCancel, () => {
		lapse(canceller, tCancel);
		const { mutation } = exec(
			canceller,
			{
				...base(canceller, "applyBillingPlan", tCancel),
				entityIds: [],
				expiringPooledBalanceIds: [],
				ops: [
					{
						op: "update",
						table: "customerEntitlements",
						id: `ce_${canceller.index}`,
						set: { expires_at: periodEnd, next_reset_at: null },
					},
				],
			},
			{ labels: { reason: "canceled" } },
		);
		planEvent(
			canceller,
			"plan.canceled",
			tCancel,
			mutation,
			`canceled ${canceller.planLabel}; it ends ${new Date(periodEnd).toISOString()}`,
			paymentOf(canceller, 1).id,
		);
	});
	at(periodEnd, () => lapse(canceller, periodEnd));

	// ---- the late payment: dated in November, written to the log in February ------------------------------------------------------------
	const lateFamily = family(LATE_FAMILY);
	const tLate = local(2026, 11, 12, 9, 0, 0);
	const lateId = `in_${rng.id(8)}`;
	at(tLate, () => {
		payment({
			f: lateFamily,
			t: tLate,
			gross: LATE_GROSS,
			kind: "sparkle-1",
			id: lateId,
			text: `membership payment ${LATE_GROSS / 100} USD for sparkle-1, a second child`,
			late: true,
		});
	});

	// ---- the erasure --------------------------------------------------------------------------------------------------------------------------
	const erasedFamily = family(ERASED_FAMILY);
	const tErase = local(2027, 2, 27, 12, 0, 0) + 30 * MINUTE;
	let erasedObjects: string[] = [];
	at(tErase, () => {
		erasedObjects = erasedFamily.paidEvents.map((e) => `event:${e.id}`);
		push(
			ledgerEvent({
				type: "subject.erased",
				school: MULTI_SCHOOL,
				tz: MULTI_TZ,
				eventTime: tErase,
				ingestTime: ingest(tErase),
				key: erasedFamily.holder,
				idem: `erase:${erasedFamily.id}`,
				text: "erased a subject: personal fields removed from its events",
				payload: { objects: erasedObjects },
			}),
		);
	});

	// ---- the last look at what has lapsed -----------------------------------------------------------------------------------------------------
	at(LAST_LOOK, () => {
		for (const f of families) lapse(f, LAST_LOOK);
	});

	actions.sort((a, b) => a.t - b.t || a.order - b.order);
	for (const action of actions) action.run();

	// ---- the late batch: the late payment and a second delivery of the November payout ---------------------------------------------------------------
	const lateEvent = late[0];
	if (!lateEvent || late.length !== 1)
		throw new Error("one late event expected");
	const duplicateOf = events.find((e) => e.idem === "stripe:po_1") as AtmEvent;
	if (duplicateOf.date !== lateEvent.date)
		throw new Error(
			"the second delivery must be dated on the late event's day",
		);
	lateDuplicates.push({ ...duplicateOf });

	events.sort((a, b) => (a.id < b.id ? -1 : 1));

	// every event's `date` is the school-local day, as this file worked it out from the fixed offset
	for (const e of events) {
		const expectedDay = localDayOf(Date.parse(e.event_time));
		if (e.date !== expectedDay)
			throw new Error(
				`${e.id} is dated ${e.date}, this file says ${expectedDay}`,
			);
	}
	// the money lines of the events are the generator's own arithmetic
	const moneyTypes = new Set([
		"payment.succeeded",
		"payment.refunded",
		"payment.disputed",
		"dispute.closed",
		"payout.paid",
		"fundraise.received",
		"fundraise.paid_out",
	]);
	const fromEvents = new Map<string, bigint>();
	for (const e of events)
		if (moneyTypes.has(e.event_type))
			for (const p of e.postings)
				fromEvents.set(
					`${p.account} ${p.commodity}`,
					(fromEvents.get(`${p.account} ${p.commodity}`) ?? 0n) +
						postingUnits(p.amount, p.commodity),
				);
	for (const [key, units] of fromEvents)
		if (units !== (totals.get(key) ?? 0n))
			throw new Error(
				`the events and the generator's ledger disagree on ${key}`,
			);

	const last = events[events.length - 1] as AtmEvent;
	const asOfMs = Date.parse(last.event_time);
	const render = (map: Map<string, bigint>): Record<string, string> =>
		Object.fromEntries(
			[...map.keys()].sort().map((key) => {
				const commodity = key.split(" ")[1] as string;
				return [key, unitsToText(map.get(key) as bigint, commodity)];
			}),
		);
	const postingTotalsByMonth = Object.fromEntries(
		[...byMonth.keys()]
			.sort()
			.map((month) => [
				month,
				render(byMonth.get(month) as Map<string, bigint>),
			]),
	);
	const eventCountsByType: Record<string, number> = {};
	for (const e of events)
		eventCountsByType[e.event_type] =
			(eventCountsByType[e.event_type] ?? 0) + 1;
	const balances = balancesOf({
		states: Object.fromEntries(
			families.map((f) => [f.holder, f.state as never]),
		),
		holds,
		catalog,
		asOfMs,
	});
	const erasedPersonal = [erasedFamily.spec.name, erasedFamily.spec.email];

	return {
		seed,
		school: MULTI_SCHOOL,
		events,
		late,
		lateDuplicates,
		catalog: rows,
		expected: {
			seed,
			school: MULTI_SCHOOL,
			tz: MULTI_TZ,
			asOf: last.event_time,
			lastEventId: last.id,
			eventCount: events.length,
			holders: families.map((f) => ({
				holder: f.holder,
				tier: f.spec.tier,
				schedule: f.spec.schedule,
			})),
			balances,
			postingTotals: render(totals),
			postingTotalsByMonth,
			transactionsByMonth: Object.fromEntries(
				[...transactions.keys()].sort().map((m) => [m, transactions.get(m)]),
			) as Record<string, number>,
			eventCountsByType: Object.fromEntries(
				Object.entries(eventCountsByType).sort(([a], [b]) => (a < b ? -1 : 1)),
			),
			boundary: boundary.sort((a, b) => (a.instant < b.instant ? -1 : 1)),
			late: {
				file: `schools/${MULTI_SCHOOL}/events/date=${lateEvent.date}/late-${lateEvent.id}.jsonl`,
				eventId: lateEvent.id,
				idem: lateEvent.idem,
				month: lateEvent.date.slice(0, 7),
				duplicateIdem: duplicateOf.idem,
			},
			erased: {
				holder: erasedFamily.holder,
				personal: erasedPersonal,
				objects: erasedObjects,
			},
			personalByHolder: Object.fromEntries(
				Object.entries(personalByHolder).filter(
					([holder]) => holder !== erasedFamily.holder,
				),
			),
			stripe,
		},
	};
};
