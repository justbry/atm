/**
 * Moving a caller that grants on its own onto `handleStripeEvent`: `grantsStateFromCallerRows` builds atm's rows from
 * B4 Uni's `school_memberships` and `school_credit_lots`. The caller's own grant rule (family-service
 * `src/school-billing/grant.ts`) is ported below as `callerGrant`, by hand, and is the oracle: what a renewal after the
 * import grants (units, expiry, rollover) is compared with what that rule grants for the same invoice.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { grantsStateFromCallerRows } from "../src/billing/adopt.js";
import { menuCatalogRows } from "../src/billing/grants.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	applyRowChanges,
	type BillingRow,
	grantsFromRows,
	stateFromRows,
} from "../src/billing/rows.js";
import {
	addonPriceKey,
	lookupKeyOf,
	menuLineItems,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import { deterministicUlid } from "../src/ledger/ids.js";
import { balancesOf } from "../src/ledger/replay.js";
import { toCatalog } from "../src/ledger/run.js";
import type {
	CallerCreditLotRow,
	CallerMembershipRow,
	GrantsState,
	Menu,
	StripeEventResult,
} from "../src/types.js";
import {
	chargeRefunded,
	invoicePaid,
	paymentIntentOf,
	priceIdOf,
} from "./stripe-events.js";

const SCHOOL = "sch_vol";
const FAMILY = "fam_8k2";
const HOLDER = `family:${FAMILY}`;
const D = (iso: string) => Date.parse(iso);
const HOUR_MS = 3_600_000;

const baseMenu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
/** The school's calendar is UTC unless a test says otherwise, so month arithmetic agrees between the caller and atm. */
const utcMenu: Menu = { ...baseMenu, timeZone: "UTC" };

// ---- The caller's own rule, ported from family-service src/school-billing/grant.ts and time.ts -----------------------

const offsetMs = (ms: number, timeZone: string): number => {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(new Date(ms));
	const number = (type: string) =>
		Number(parts.find((p) => p.type === type)?.value);
	const local = Date.UTC(
		number("year"),
		number("month") - 1,
		number("day"),
		number("hour"),
		number("minute"),
		number("second"),
	);
	return local - Math.floor(ms / 1000) * 1000;
};

const addMonthsInZone = (ms: number, months: number, timeZone: string) => {
	const offset = offsetMs(ms, timeZone);
	const wall = new Date(ms + offset);
	const year = wall.getUTCFullYear();
	const month = wall.getUTCMonth() + months;
	const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	const local = Date.UTC(
		year,
		month,
		Math.min(wall.getUTCDate(), daysInMonth),
		wall.getUTCHours(),
		wall.getUTCMinutes(),
		wall.getUTCSeconds(),
		wall.getUTCMilliseconds(),
	);
	return local - offsetMs(local - offset, timeZone);
};

const YEAR_MS = 365 * 86_400_000;
const GRANTING_REASONS = ["subscription_create", "subscription_cycle"];

type CallerInvoice = {
	id: string;
	reason: "subscription_create" | "subscription_cycle";
	periodStart: number;
	periodEnd: number;
	/** The event's time (ms): the lot's `created_at`. */
	atMs: number;
};

/** What `grantForInvoice` writes for one paid invoice: one lot per tier grant and per add-on grant, balance = the amount. */
const callerGrant = ({
	membership,
	menu,
	invoice,
	existing,
}: {
	membership: CallerMembershipRow;
	menu: Menu;
	invoice: CallerInvoice;
	existing: readonly CallerCreditLotRow[];
}): CallerCreditLotRow[] => {
	if (!GRANTING_REASONS.includes(invoice.reason)) return [];
	const tierGrants = menu.tiers.find((t) => t.id === membership.tier_id)
		?.grants as Menu["tiers"][number]["grants"];
	const items = tierGrants.map((grant) => ({
		source: "tier",
		grant,
		every: grant.every as "month" | "year" | "once",
	}));
	for (const id of membership.addon_ids.split(",").filter(Boolean)) {
		const addon = menu.addons.find((a) => a.id === id);
		if (!addon) continue;
		if (
			addon.price.every === "once" &&
			invoice.reason !== "subscription_create"
		)
			continue;
		for (const grant of addon.grants)
			items.push({ source: `addon:${id}`, grant, every: addon.price.every });
	}
	const out: CallerCreditLotRow[] = [];
	for (const item of items) {
		const { grant } = item;
		const per = grant.amount * membership.quantity;
		let amount: number;
		if (item.source !== "tier")
			amount =
				grant.amount *
				(item.every === "month" && membership.interval === "year" ? 12 : 1);
		else if (grant.every === membership.interval) amount = per;
		else if (grant.every === "month" && membership.interval === "year")
			amount = per * 12;
		else if (invoice.reason === "subscription_create") amount = per;
		else
			amount = existing.some(
				(l) =>
					l.feature_id === grant.featureId &&
					l.created_at > invoice.atMs - YEAR_MS,
			)
				? 0
				: per;
		if (amount <= 0) continue;
		const months = grant.rollover?.months;
		const expiresAt =
			item.every === "once"
				? months === undefined
					? null
					: addMonthsInZone(invoice.atMs, months, menu.timeZone)
				: months === undefined
					? invoice.periodEnd
					: addMonthsInZone(invoice.periodEnd, months, menu.timeZone);
		const id = `lot_${createHash("sha256")
			.update(
				`${membership.id}|${grant.featureId}|${invoice.id}|${item.source}`,
			)
			.digest("hex")
			.slice(0, 24)}`;
		out.push({
			id,
			membership_id: membership.id,
			school_id: membership.school_id,
			feature_id: grant.featureId,
			invoice_id: invoice.id,
			source: item.source,
			every: item.every,
			allowance: amount,
			removed_at: null,
			balance: amount,
			adjustment: 0,
			additional_balance: 0,
			next_reset_at: null,
			expires_at: expiresAt,
			created_at: invoice.atMs,
		});
	}
	return out;
};

// ---- Fixtures -----------------------------------------------------------------------------------------------------

const secondsOf = (ms: number) => Math.floor(ms / 1000);

const membershipRow = (
	overrides: Partial<CallerMembershipRow> = {},
): CallerMembershipRow => ({
	id: "mem_1",
	school_id: SCHOOL,
	family_id: FAMILY,
	profile_id: null,
	tier_id: "sparkle-2",
	interval: "month",
	addon_ids: "",
	menu_version: 3,
	stripe_customer_id: "cus_1",
	quantity: 1,
	stripe_subscription_id: "sub_1",
	status: "active",
	current_period_end: secondsOf(D("2026-03-15T18:00:00Z")),
	cancel_at_period_end: 0,
	revision: 4,
	stripe_event_at: secondsOf(D("2026-02-15T18:00:10Z")),
	created_at: secondsOf(D("2026-01-15T18:00:10Z")),
	updated_at: secondsOf(D("2026-02-15T18:00:10Z")),
	...overrides,
});

/** The three cycles of the main scenario: paid on the 15th at 18:00:10 UTC, each for the month that follows. */
const JAN = D("2026-01-15T18:00:00Z");
const FEB = D("2026-02-15T18:00:00Z");
const MAR = D("2026-03-15T18:00:00Z");
const APR = D("2026-04-15T18:00:00Z");
const invoiceAt = (
	id: string,
	reason: CallerInvoice["reason"],
	periodStart: number,
	periodEnd: number,
): CallerInvoice => ({
	id,
	reason,
	periodStart,
	periodEnd,
	atMs: periodStart + 10_000,
});
const IN_1 = invoiceAt("in_1", "subscription_create", JAN, FEB);
const IN_2 = invoiceAt("in_2", "subscription_cycle", FEB, MAR);
const IN_3 = invoiceAt("in_3", "subscription_cycle", MAR, APR);

const tierKey = (menu: Menu, tierId: string, interval: "month" | "year") => {
	const price = menu.tiers
		.find((t) => t.id === tierId)
		?.prices.find((p) => p.interval === interval);
	return lookupKeyOf(
		SCHOOL,
		tierPriceKey(tierId, interval),
		price?.amount as number,
		menu.currency,
	);
};
const addonKey = (menu: Menu, addonId: string) => {
	const addon = menu.addons.find(
		(a) => a.id === addonId,
	) as Menu["addons"][number];
	return lookupKeyOf(
		SCHOOL,
		addonPriceKey(addon.id, addon.price.every, addon.gift),
		addon.price.amount,
		menu.currency,
	);
};

/** The invoice.paid event for a caller invoice: the tier's line, and the add-ons the membership holds. */
const paidEvent = ({
	menu,
	membership,
	invoice,
}: {
	menu: Menu;
	membership: CallerMembershipRow;
	invoice: CallerInvoice;
}) => {
	const tier = menu.tiers.find(
		(t) => t.id === membership.tier_id,
	) as Menu["tiers"][number];
	const price = tier.prices.find((p) => p.interval === membership.interval);
	const lines = [
		{
			lookupKey: tierKey(menu, tier.id, membership.interval),
			amount: (price?.amount ?? 0) * membership.quantity,
			interval: membership.interval,
			quantity: membership.quantity,
		},
	];
	for (const id of membership.addon_ids.split(",").filter(Boolean)) {
		const addon = menu.addons.find(
			(a) => a.id === id,
		) as Menu["addons"][number];
		if (
			addon.price.every === "once" &&
			invoice.reason !== "subscription_create"
		)
			continue;
		lines.push({
			lookupKey: addonKey(menu, id),
			amount: addon.price.amount,
			interval:
				addon.price.every === "once" ? (null as never) : addon.price.every,
			quantity: 1,
		});
	}
	return invoicePaid({
		eventId: `evt_${invoice.id}`,
		invoiceId: invoice.id,
		at: invoice.atMs,
		subscriptionId: membership.stripe_subscription_id,
		reason: invoice.reason,
		periodStart: invoice.periodStart,
		periodEnd: invoice.periodEnd,
		lines,
		metadata: { b4u_school: SCHOOL, family_id: FAMILY },
	});
};

/** atm's side: rows and revision as the family service would store them, one handled event at a time. */
const atmStore = (
	menu: Menu,
	initial: readonly BillingRow[] = [],
	/** Payment intent to invoice id for invoices handled before the import: atm cannot read them from the caller's rows. */
	knownPayments: Readonly<Record<string, string>> = {},
) => {
	const catalogRows = menuCatalogRows({ menu, school: SCHOOL });
	const catalog = toCatalog(catalogRows);
	const priceIds = Object.fromEntries(
		[...menuLineItems(SCHOOL, menu).keys()].map((key) => [key, priceIdOf(key)]),
	);
	const invoiceIds: Record<string, string> = { ...knownPayments };
	let rows: BillingRow[] = [...initial];
	let revision = 1;
	return {
		get rows() {
			return rows;
		},
		get grants() {
			return grantsFromRows(rows);
		},
		handle(event: unknown, at: number): StripeEventResult {
			const raw = event as {
				id: string;
				type: string;
				data: { object: { id: string } };
			};
			if (raw.type === "invoice.paid")
				invoiceIds[paymentIntentOf(raw.data.object.id)] = raw.data.object.id;
			const result = handleStripeEvent({
				event,
				eventId: deterministicUlid({
					timeMs: at,
					revision: 0,
					seed: JSON.stringify([SCHOOL, raw.id]),
				}),
				menu,
				menuVersion: 3,
				policy: DEFAULT_POLICY,
				policyVersion: 1,
				rows,
				revision,
				catalog: catalogRows,
				now: at,
				priceIds,
				invoiceIds,
			});
			if (result.rowChanges)
				({ rows, revision } = applyRowChanges({
					rows,
					revision,
					changes: result.rowChanges,
				}));
			return result;
		},
		/** The units the engine counts as available at `asOfMs`: refilling rows and live rollovers. */
		avail(asOfMs: number, feature = "visit"): number {
			const state = stateFromRows({
				identity: {
					orgId: SCHOOL,
					env: "live",
					customerId: HOLDER,
					entityId: null,
				},
				revision,
				rows,
			});
			if (!state) return 0;
			return (
				balancesOf({
					states: { [HOLDER]: state as never },
					holds: {},
					catalog,
					asOfMs,
				}).find((b) => b.feature === feature)?.avail ?? 0
			);
		},
		rowsOf: (table: BillingRow["table"]) =>
			rows.filter((r) => r.table === table),
	};
};

/** What the caller would hold available at `asOfMs`: every lot not past its expiry. */
const callerAvail = (
	lots: readonly CallerCreditLotRow[],
	asOfMs: number,
	feature = "visit",
) =>
	lots
		.filter(
			(l) =>
				l.feature_id === feature &&
				(l.expires_at === null || l.expires_at > asOfMs),
		)
		.reduce((sum, l) => sum + l.balance, 0);

const only = <T>(items: readonly T[]): T => {
	expect(items).toHaveLength(1);
	return items[0] as T;
};

// ---- Tests --------------------------------------------------------------------------------------------------------

describe("a member mid-cycle, moved onto atm", () => {
	// January's lot has 1 of its 2 left; February's lot (paid at renewal) has 2 of 2; it is the 25th of February.
	const membership = membershipRow();
	const januaryLot = {
		...only(
			callerGrant({ membership, menu: utcMenu, invoice: IN_1, existing: [] }),
		),
		balance: 1,
	};
	const februaryLot = only(
		callerGrant({
			membership,
			menu: utcMenu,
			invoice: IN_2,
			existing: [januaryLot],
		}),
	);
	const lots = [januaryLot, februaryLot];
	const now = D("2026-02-25T12:00:00Z");
	const imported = grantsStateFromCallerRows({
		membership,
		lots,
		menu: utcMenu,
		now,
	});

	test("the caller's rule, as ported, gives lots that last a cycle and a rollover month", () => {
		expect(januaryLot).toMatchObject({
			allowance: 2,
			expires_at: D("2026-03-15T18:00:00Z"),
		});
		expect(februaryLot).toMatchObject({
			allowance: 2,
			expires_at: D("2026-04-15T18:00:00Z"),
		});
	});

	test("the newest lot is the refilling row, the older one's leftover its rollover, each invoice a decided invoice", () => {
		const store = atmStore(utcMenu, imported.rows);
		const row = only(store.rowsOf("customerEntitlements"));
		expect(row.data).toMatchObject({
			id: "ce_tier_visit_month",
			balance: 2,
			next_reset_at: MAR,
			expires_at: null,
			created_at: JAN + 10_000,
		});
		expect(only(store.rowsOf("rollovers")).data).toMatchObject({
			cus_ent_id: "ce_tier_visit_month",
			balance: 1,
			expires_at: januaryLot.expires_at,
		});
		expect(imported.state).toMatchObject({
			identity: { orgId: SCHOOL, customerId: HOLDER },
			subscriptionId: "sub_1",
			tierId: "sparkle-2",
			interval: "month",
			quantity: 1,
			cycleStart: FEB,
			cycleEnd: MAR,
			anchor: null,
			endedAt: null,
			rows: { ce_tier_visit_month: 2 },
		});
		expect(Object.keys(imported.state.invoices).sort()).toEqual([
			"in_1",
			"in_2",
		]);
		expect(imported.state.membership).toMatchObject({
			status: "active",
			tierId: "sparkle-2",
			renewsAt: MAR,
			at: D("2026-02-15T18:00:10Z"),
		});
		// What the engine counts equals what the caller counts, now and as each lot lapses.
		for (const at of [
			now,
			D("2026-03-14T00:00:00Z"),
			D("2026-03-16T00:00:00Z"),
			D("2026-04-14T00:00:00Z"),
		])
			expect(store.avail(at)).toBe(callerAvail(lots, at));
	});

	test("the renewal after the import grants what the caller's rule grants: units, expiry and rollover", () => {
		const store = atmStore(utcMenu, imported.rows);
		const expected = only(
			callerGrant({ membership, menu: utcMenu, invoice: IN_3, existing: lots }),
		);
		const result = store.handle(
			paidEvent({ menu: utcMenu, membership, invoice: IN_3 }),
			IN_3.atMs,
		);
		expect(result.refused).toBeUndefined();
		expect(result.rowChanges).not.toBeNull();

		// Units: the invoice grants the caller's allowance, and the row is refilled to it.
		const grantedNow = only(store.grants.invoices.in_3?.granted ?? []);
		expect(grantedNow).toMatchObject({
			feature: "visit",
			units: expected.allowance,
		});
		expect(only(store.rowsOf("customerEntitlements")).data.balance).toBe(
			expected.allowance,
		);
		// Expiry: the credits of this invoice lapse where the caller's lot does (cycle end plus the rollover month).
		expect(grantedNow.rolloverExpiresAt).toBe(expected.expires_at);
		// Rollover: what February's cycle left carries over, expiring where the caller's February lot expires;
		// January's leftover lapsed at the same instant the cycle turned, so it is gone in both.
		const caller = [februaryLot, expected];
		const rollover = only(store.rowsOf("rollovers"));
		expect(rollover.data).toMatchObject({
			balance: februaryLot.balance,
			expires_at: februaryLot.expires_at,
		});
		for (const at of [
			D("2026-03-16T00:00:00Z"),
			D("2026-04-14T00:00:00Z"),
			D("2026-04-16T00:00:00Z"),
		])
			expect(store.avail(at)).toBe(callerAvail(caller, at));
		// The cycle moved on.
		expect(store.grants).toMatchObject({ cycleStart: MAR, cycleEnd: APR });
	});

	test("an invoice the caller already granted grants nothing again, whichever of them is replayed", () => {
		const store = atmStore(utcMenu, imported.rows);
		for (const invoice of [IN_1, IN_2]) {
			const result = store.handle(
				paidEvent({ menu: utcMenu, membership, invoice }),
				invoice.atMs,
			);
			expect(result.refused).toBeUndefined();
			expect(result.rowChanges).toBeNull();
			expect(result.events).toEqual([]);
		}
		expect(store.rows).toEqual(imported.rows);
	});

	test("a refund of an invoice handled before the import is refused until the caller says which invoice the payment paid", () => {
		const store = atmStore(utcMenu, imported.rows);
		const refundAt = IN_2.atMs + HOUR_MS;
		const result = store.handle(
			chargeRefunded({
				eventId: "evt_refund_in_2",
				chargeId: "ch_in_2",
				invoiceId: "in_2",
				amount: 26000,
				chargeAmount: 26000,
				at: refundAt,
			}),
			refundAt,
		);
		expect(result.refused?.reason).toBe("unmatched_invoice");
		expect(result.rowChanges).toBeNull();
	});

	test("a refund of the caller's last invoice, after the renewal, takes back what its lot still holds", () => {
		// A refund names its charge and payment intent, not its invoice. atm learned that link from `invoice_payment.paid`
		// for the invoices it handled; for one handled before the import the caller passes it as `invoiceIds`.
		const store = atmStore(utcMenu, imported.rows, {
			[paymentIntentOf("in_2")]: "in_2",
		});
		store.handle(
			paidEvent({ menu: utcMenu, membership, invoice: IN_3 }),
			IN_3.atMs,
		);
		const before = store.avail(D("2026-03-16T00:00:00Z"));
		const refundAt = IN_3.atMs + HOUR_MS;
		const result = store.handle(
			chargeRefunded({
				eventId: "evt_refund_in_2",
				chargeId: "ch_in_2",
				invoiceId: "in_2",
				amount: 26000,
				chargeAmount: 26000,
				at: refundAt,
			}),
			refundAt,
		);
		expect(result.refused).toBeUndefined();
		// The caller takes min(balance, allowance) of the invoice's lot: the 2 February left.
		expect(before - store.avail(D("2026-03-16T00:00:00Z"))).toBe(
			Math.min(februaryLot.balance, februaryLot.allowance),
		);
		expect(store.grants.invoices.in_2?.removed).toBe(true);
	});
});

describe("what the rows determine, and what moving does not make the same", () => {
	test("rows imported for a member whose first invoice atm would have handled are the rows atm itself makes", () => {
		const membership = membershipRow({
			current_period_end: secondsOf(FEB),
			stripe_event_at: secondsOf(IN_1.atMs),
			updated_at: secondsOf(IN_1.atMs),
		});
		const lots = callerGrant({
			membership,
			menu: utcMenu,
			invoice: IN_1,
			existing: [],
		});
		const imported = grantsStateFromCallerRows({
			membership,
			lots,
			menu: utcMenu,
			now: IN_1.atMs + 1000,
		});
		const native = atmStore(utcMenu, []);
		native.handle(
			paidEvent({ menu: utcMenu, membership, invoice: IN_1 }),
			IN_1.atMs,
		);
		const engineOnly = (rows: readonly BillingRow[]) =>
			rows.filter((r) => r.table !== "atm_grants");
		expect(engineOnly(imported.rows)).toEqual(engineOnly(native.rows));
		// The grants state differs only in what the lots cannot say (the billing anchor) and the membership record.
		const { anchor, membership: record, ...importedRest } = imported.state;
		const {
			anchor: nativeAnchor,
			membership: nativeRecord,
			...nativeRest
		} = native.grants;
		expect(importedRest).toEqual(nativeRest);
		expect(anchor).toBeNull();
		expect(nativeAnchor).toBe(JAN);
		expect(nativeRecord).toBeNull();
		expect(record).not.toBeNull();
	});

	test("a quantity of 2: the renewal grants twice the amount, as the caller's lot does", () => {
		const membership = membershipRow({ quantity: 2 });
		const january = only(
			callerGrant({ membership, menu: utcMenu, invoice: IN_1, existing: [] }),
		);
		const february = only(
			callerGrant({
				membership,
				menu: utcMenu,
				invoice: IN_2,
				existing: [january],
			}),
		);
		const lots = [{ ...january, balance: 0 }, february];
		const imported = grantsStateFromCallerRows({
			membership,
			lots,
			menu: utcMenu,
			now: D("2026-02-25T12:00:00Z"),
		});
		expect(imported.state.quantity).toBe(2);
		const store = atmStore(utcMenu, imported.rows);
		const expected = only(
			callerGrant({ membership, menu: utcMenu, invoice: IN_3, existing: lots }),
		);
		const result = store.handle(
			paidEvent({ menu: utcMenu, membership, invoice: IN_3 }),
			IN_3.atMs,
		);
		expect(result.refused).toBeUndefined();
		expect(expected.allowance).toBe(4);
		expect(only(store.grants.invoices.in_3?.granted ?? []).units).toBe(4);
		expect(only(store.rowsOf("customerEntitlements")).data.balance).toBe(4);
		expect(only(store.rowsOf("rollovers")).data).toMatchObject({
			balance: february.balance,
			expires_at: february.expires_at,
		});
	});

	test("a tier with a yearly grant and an add-on: the renewal grants the monthly allowance and the add-on, not the yearly grant or the one-time pack", () => {
		const membership = membershipRow({
			tier_id: "sparkle-4",
			addon_ids: "glow,pack",
		});
		const january = callerGrant({
			membership,
			menu: utcMenu,
			invoice: IN_1,
			existing: [],
		});
		// Visit (tier), retreat (yearly), glow (recurring add-on), pack (one-time, on the first invoice only).
		expect(
			january.map((l) => `${l.source}/${l.feature_id}/${l.every}`),
		).toEqual([
			"tier/visit/month",
			"tier/retreat/year",
			"addon:glow/visit/month",
			"addon:pack/visit/once",
		]);
		const february = callerGrant({
			membership,
			menu: utcMenu,
			invoice: IN_2,
			existing: january,
		});
		expect(february.map((l) => `${l.source}/${l.feature_id}`)).toEqual([
			"tier/visit",
			"addon:glow/visit",
		]);
		const lots = [...january, ...february];
		const imported = grantsStateFromCallerRows({
			membership,
			lots,
			menu: utcMenu,
			now: D("2026-02-25T12:00:00Z"),
		});
		const store = atmStore(utcMenu, imported.rows);
		const expected = callerGrant({
			membership,
			menu: utcMenu,
			invoice: IN_3,
			existing: lots,
		});
		const result = store.handle(
			paidEvent({ menu: utcMenu, membership, invoice: IN_3 }),
			IN_3.atMs,
		);
		expect(result.refused).toBeUndefined();
		const granted = (store.grants.invoices.in_3?.granted ?? []).map(
			(g) => `${g.rowId}=${g.units}`,
		);
		expect(granted.sort()).toEqual(
			["ce_tier_visit_month=4", "ce_addon_glow_visit_month=1"].sort(),
		);
		expect(expected.map((l) => `${l.source}=${l.allowance}`)).toEqual([
			"tier=4",
			"addon:glow=1",
		]);
		// The retreat (yearly) and the pack (one-time) rows are untouched by the renewal. The caller's yearly lot expires with
		// the first MONTH's period (its rule gives a grant with no rollover `expires_at` = the invoice's period end), so by
		// the 25th of February it holds nothing and the import says so; atm then refills it a year after the first invoice.
		const retreat = store
			.rowsOf("customerEntitlements")
			.find((r) => r.id === "ce_tier_retreat_year");
		expect(january.find((l) => l.feature_id === "retreat")?.expires_at).toBe(
			FEB,
		);
		expect(retreat?.data).toMatchObject({
			balance: 0,
			next_reset_at: D("2027-01-15T18:00:10Z"),
		});
		const pack = store
			.rowsOf("customerEntitlements")
			.find((r) => r.id === `ce_once_in_1_pack_visit`);
		expect(pack?.data.balance).toBe(1);
	});

	test("a membership Stripe has told the caller about but that no invoice granted yet is just the membership: the first invoice then grants as for a new member", () => {
		const membership = membershipRow({ current_period_end: secondsOf(FEB) });
		const imported = grantsStateFromCallerRows({
			membership,
			lots: [],
			menu: utcMenu,
			now: JAN,
		});
		expect(imported.rows.map((r) => r.table)).toEqual(["atm_grants"]);
		expect(imported.state).toMatchObject({
			holder: { orgId: SCHOOL, customerId: HOLDER },
			tierId: null,
			membership: { status: "active", tierId: "sparkle-2" },
		});
		const store = atmStore(utcMenu, imported.rows);
		const result = store.handle(
			paidEvent({ menu: utcMenu, membership, invoice: IN_1 }),
			IN_1.atMs,
		);
		expect(result.refused).toBeUndefined();
		expect(store.avail(JAN + 20_000)).toBe(2);
	});

	test("a canceled membership: the credits live out their own expiry and nothing refills", () => {
		const membership = membershipRow({
			status: "canceled",
			stripe_event_at: secondsOf(D("2026-02-20T00:00:00Z")),
		});
		const january = only(
			callerGrant({ membership, menu: utcMenu, invoice: IN_1, existing: [] }),
		);
		const imported = grantsStateFromCallerRows({
			membership,
			lots: [january],
			menu: utcMenu,
			now: D("2026-02-25T12:00:00Z"),
		});
		expect(imported.state.endedAt).toBe(D("2026-02-20T00:00:00Z"));
		expect(imported.state.membership?.status).toBe("ended");
		const row = only(
			imported.rows.filter((r) => r.table === "customerEntitlements"),
		);
		expect(row.data).toMatchObject({
			next_reset_at: null,
			expires_at: january.expires_at,
		});
	});

	test("a lot past its expiry holds nothing, and its leftover is not carried over", () => {
		const membership = membershipRow();
		const january = {
			...only(
				callerGrant({ membership, menu: utcMenu, invoice: IN_1, existing: [] }),
			),
			balance: 1,
		};
		const february = only(
			callerGrant({
				membership,
				menu: utcMenu,
				invoice: IN_2,
				existing: [january],
			}),
		);
		const imported = grantsStateFromCallerRows({
			membership,
			lots: [january, february],
			// After January's lot expired (Mar 15 18:00:00) and before the renewal is paid.
			menu: utcMenu,
			now: D("2026-03-15T18:00:05Z"),
		});
		expect(imported.rows.some((r) => r.table === "rollovers")).toBe(false);
		// Still a decided invoice.
		expect(imported.state.invoices.in_1).toBeDefined();
	});
});

describe("where atm's rules are not the caller's, so the same renewal grants a little differently", () => {
	test("a leftover above the rollover cap: the caller keeps all of it, atm carries at most `max`", () => {
		const membership = membershipRow();
		const january = {
			...only(
				callerGrant({ membership, menu: utcMenu, invoice: IN_1, existing: [] }),
			),
			balance: 0,
		};
		// 3 left of 2 granted (a manual top-up through updateBalance); the menu caps the rollover at 2.
		const february = {
			...only(
				callerGrant({
					membership,
					menu: utcMenu,
					invoice: IN_2,
					existing: [january],
				}),
			),
			balance: 3,
		};
		const lots = [january, february];
		const imported = grantsStateFromCallerRows({
			membership,
			lots,
			menu: utcMenu,
			now: D("2026-02-25T12:00:00Z"),
		});
		const store = atmStore(utcMenu, imported.rows);
		store.handle(
			paidEvent({ menu: utcMenu, membership, invoice: IN_3 }),
			IN_3.atMs,
		);
		const callerLots = [
			february,
			...callerGrant({
				membership,
				menu: utcMenu,
				invoice: IN_3,
				existing: lots,
			}),
		];
		const at = D("2026-03-16T00:00:00Z");
		expect(callerAvail(callerLots, at)).toBe(5);
		expect(store.avail(at)).toBe(4);
	});

	test("a school calendar that changes its clocks: atm's rollover expiry is a whole hour from the caller's lot", () => {
		const menu = baseMenu; // America/Denver
		const membership = membershipRow({ current_period_end: secondsOf(FEB) });
		// January's cycle ends Feb 15 18:00Z (11:00 in Denver, MST). A month on, the caller's lot ends at 11:00 Denver, which
		// is MDT by then: 17:00Z. atm's engine counts the rollover month on the UTC calendar: 18:00Z.
		const january = {
			...only(callerGrant({ membership, menu, invoice: IN_1, existing: [] })),
			balance: 1,
		};
		expect(january.expires_at).toBe(D("2026-03-15T17:00:00Z"));
		const imported = grantsStateFromCallerRows({
			membership,
			lots: [january],
			menu,
			now: D("2026-02-10T12:00:00Z"),
		});
		const store = atmStore(menu, imported.rows);
		const result = store.handle(
			paidEvent({ menu, membership, invoice: IN_2 }),
			IN_2.atMs,
		);
		expect(result.refused).toBeUndefined();
		const rollover = only(store.rowsOf("rollovers")).data;
		expect(rollover.balance).toBe(1);
		expect(rollover.expires_at).toBe(D("2026-03-15T18:00:00Z"));
		expect(
			(rollover.expires_at as number) - (january.expires_at as number),
		).toBe(HOUR_MS);
	});

	test("a cycle not renewed: the caller's lot lapses at the cycle end plus the rollover month, atm's refilling row stays until the next invoice or the cancellation", () => {
		const membership = membershipRow();
		const january = {
			...only(
				callerGrant({ membership, menu: utcMenu, invoice: IN_1, existing: [] }),
			),
			balance: 0,
		};
		const february = only(
			callerGrant({
				membership,
				menu: utcMenu,
				invoice: IN_2,
				existing: [january],
			}),
		);
		const imported = grantsStateFromCallerRows({
			membership,
			lots: [january, february],
			menu: utcMenu,
			now: D("2026-02-25T12:00:00Z"),
		});
		const store = atmStore(utcMenu, imported.rows);
		const lapsedAt = D("2026-04-16T00:00:00Z");
		expect(callerAvail([january, february], lapsedAt)).toBe(0);
		expect(store.avail(lapsedAt)).toBe(2);
	});
});

describe("rows that cannot be placed are refused, naming the problem", () => {
	const membership = membershipRow();
	const january = only(
		callerGrant({ membership, menu: utcMenu, invoice: IN_1, existing: [] }),
	);
	const run = (overrides: {
		membership?: Partial<CallerMembershipRow>;
		lots?: CallerCreditLotRow[];
		menu?: Menu;
	}) =>
		grantsStateFromCallerRows({
			membership: membershipRow(overrides.membership),
			lots: overrides.lots ?? [january],
			menu: overrides.menu ?? utcMenu,
			now: D("2026-01-20T00:00:00Z"),
		});

	test("the baseline imports", () => {
		expect(() => run({})).not.toThrow();
	});

	test("a tier the menu does not have", () => {
		expect(() => run({ membership: { tier_id: "gold" } })).toThrow(
			/tier "gold", which the menu does not have/,
		);
	});

	test("a tier the menu does not price at the membership's interval", () => {
		expect(() =>
			run({ membership: { tier_id: "sparkle-1", interval: "year" } }),
		).toThrow(/sparkle-1 billed every year, which the menu does not price/);
	});

	test("a feature the menu does not have", () => {
		expect(() =>
			run({ lots: [{ ...january, feature_id: "massage" }] }),
		).toThrow(/feature "massage", which the menu does not have/);
	});

	test("an add-on the menu does not have", () => {
		expect(() => run({ membership: { addon_ids: "glow,nope" } })).toThrow(
			/add-on "nope", which the menu does not have/,
		);
		expect(() => run({ lots: [{ ...january, source: "addon:nope" }] })).toThrow(
			/add-on "nope", which the menu does not have/,
		);
	});

	test("a lot that is no grant of the membership's tier", () => {
		expect(() =>
			run({ lots: [{ ...january, feature_id: "retreat" }] }),
		).toThrow(/is not a grant of tier sparkle-2/);
	});

	test("a tier grant, or an add-on, with no lot: atm would never refill it", () => {
		expect(() => run({ membership: { tier_id: "sparkle-4" } })).toThrow(
			/no lot for tier sparkle-4's grant of retreat every year/,
		);
		expect(() => run({ membership: { addon_ids: "glow" } })).toThrow(
			/no lot for add-on glow's grant of visit/,
		);
	});

	test("a lot of another member, a source atm does not know, and a lot of an add-on the membership no longer has", () => {
		expect(() =>
			run({ lots: [{ ...january, membership_id: "mem_9" }] }),
		).toThrow(/belongs to membership mem_9/);
		expect(() => run({ lots: [{ ...january, source: "promo" }] })).toThrow(
			/source atm does not know/,
		);
		expect(() =>
			run({
				lots: [
					january,
					{
						...january,
						id: "lot_glow",
						source: "addon:glow",
						invoice_id: "in_1",
					},
				],
			}),
		).toThrow(/which membership mem_1 no longer has/);
	});

	test("credit rows on different cycles: a renewal was granted to some and not others", () => {
		const withGlow = membershipRow({ tier_id: "sparkle-4", addon_ids: "glow" });
		const first = callerGrant({
			membership: withGlow,
			menu: utcMenu,
			invoice: IN_1,
			existing: [],
		});
		const second = callerGrant({
			membership: withGlow,
			menu: utcMenu,
			invoice: IN_2,
			existing: first,
		});
		const pick = (
			lots: CallerCreditLotRow[],
			source: string,
			feature: string,
		) =>
			lots.find(
				(l) => l.source === source && l.feature_id === feature,
			) as CallerCreditLotRow;
		expect(() =>
			run({
				membership: { tier_id: "sparkle-4", addon_ids: "glow" },
				lots: [
					pick(second, "tier", "visit"),
					pick(first, "tier", "retreat"),
					pick(first, "addon:glow", "visit"),
				],
			}),
		).toThrow(/on different cycles/);
	});

	test("a lot that is not a whole number of the menu's per-unit amount", () => {
		expect(() => run({ lots: [{ ...january, allowance: 3 }] })).toThrow(
			/not a whole number of the menu's 2 per unit/,
		);
	});

	test("every problem is named in one error", () => {
		let message = "";
		try {
			run({
				membership: { tier_id: "sparkle-2", addon_ids: "nope" },
				lots: [{ ...january, feature_id: "massage" }],
			});
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain('add-on "nope"');
		expect(message).toContain('feature "massage"');
	});
});

describe("the state it returns is a state atm accepts", () => {
	test("the grants row round-trips through grantsFromRows, and the rows are canonical and JSON-safe", () => {
		const membership = membershipRow();
		const january = only(
			callerGrant({ membership, menu: utcMenu, invoice: IN_1, existing: [] }),
		);
		const imported = grantsStateFromCallerRows({
			membership,
			lots: [january],
			menu: utcMenu,
			now: D("2026-01-20T00:00:00Z"),
		});
		const state: GrantsState = grantsFromRows(imported.rows);
		expect(state).toEqual(imported.state);
		expect(JSON.parse(JSON.stringify(imported.rows))).toEqual(imported.rows);
	});
});
