/**
 * Moving a caller that grants credits on its own onto `handleStripeEvent`. B4 Uni's family service keeps one
 * `school_memberships` row per subscription and one `school_credit_lots` row per grant per invoice (a lot is a balance
 * with an `expires_at`; nothing refills it). atm keeps one refilling row per tier or add-on grant, the leftovers of
 * earlier cycles as rollover rows, and a `GrantsState` that remembers which invoices were granted. This builds atm's
 * rows from the caller's, so that the next Stripe event decides what the caller's own rules would have decided and an
 * invoice the caller already granted grants nothing again.
 *
 * What the rows determine is read from them; what they do not is not guessed. It throws, naming every problem, on
 * anything it cannot place: a tier, add-on or feature the menu does not have, a lot that is no grant of the
 * membership's tier, a tier grant or add-on with no lot (atm would never refill it), rows on different cycles.
 *
 * Pure: no I/O, no clock (`now` is passed). The same input always gives the same output.
 */
import type {
	BillingRow,
	CallerCreditLotRow,
	CallerMembershipRow,
	CallerRowsImport,
	CallerRowsInput,
	GrantedRow,
	GrantsState,
	Interval,
	InvoiceRecord,
	MembershipRecord,
	MenuAddon,
	MenuTier,
} from "../types.js";
import {
	addonCp,
	addonProductId,
	addonSpecs,
	addUtcMonths,
	addZonedMonths,
	customerRow,
	EMPTY_GRANTS_STATE,
	giftEntId,
	onceEntId,
	productOp,
	type RowSpec,
	rolloverExpiry,
	rowOp,
	TIER_CP,
	tierProductId,
	tierSpecs,
} from "./grants.js";
import { grantsRow, sortRows } from "./rows.js";
import { subscriptionStatus } from "./status.js";

const MS_PER_SECOND = 1000;
const MONTHS_PER_INTERVAL: Record<Interval, number> = { month: 1, year: 12 };
const TIER_SOURCE = "tier";
const ADDON_SOURCE_PREFIX = "addon:";
/** `allowance / amount` is a whole quantity up to the floating point a REAL column carries. */
const QUANTITY_TOLERANCE = 1e-9;

type Lot = CallerCreditLotRow;

/** One credit row atm will hold, with the caller's lots that fed it (oldest first). */
type RowPlan = {
	rowId: string;
	spec: RowSpec;
	cpId: string;
	lots: Lot[];
};

/** A one-time add-on's lot: its own row, never refilled. */
type OncePlan = { lot: Lot; addon: MenuAddon; feature: string };

const byCreation = (a: Lot, b: Lot): number =>
	a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const lapsed = (lot: Lot, now: number): boolean =>
	lot.expires_at !== null && lot.expires_at <= now;

const customerIdOf = (familyId: string): string => `family:${familyId}`;

/** What the caller's rows say about one member, as atm's rows and grants state. See the file comment. */
export const grantsStateFromCallerRows = (
	input: CallerRowsInput,
): CallerRowsImport => {
	const { membership, lots, menu, now } = input;
	const problems: string[] = [];
	const problem = (message: string) => problems.push(message);
	const label = `membership ${membership.id}`;
	const holder = {
		orgId: membership.school_id,
		customerId: customerIdOf(membership.family_id),
	};

	const tier = menu.tiers.find((t) => t.id === membership.tier_id);
	if (!tier)
		problem(
			`${label} is on tier ${JSON.stringify(membership.tier_id)}, which the menu does not have`,
		);
	else if (!tier.prices.some((p) => p.interval === membership.interval))
		problem(
			`${label} is on tier ${tier.id} billed every ${membership.interval}, which the menu does not price`,
		);
	if (!Number.isInteger(membership.quantity) || membership.quantity < 1)
		problem(
			`${label} has quantity ${membership.quantity}, not a whole number from 1`,
		);

	const addonIds = membership.addon_ids
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "");
	const membershipAddons: MenuAddon[] = [];
	for (const id of addonIds) {
		const addon = menu.addons.find((a) => a.id === id);
		if (addon) membershipAddons.push(addon);
		else
			problem(
				`${label} has add-on ${JSON.stringify(id)}, which the menu does not have`,
			);
	}
	const recurringAddons = membershipAddons.filter(
		(a) => a.price.every !== "once",
	);

	const membershipRecord = membershipRecordOf(membership, tier);
	const customerId = holder.customerId;
	const createdAtMs = membership.created_at * MS_PER_SECOND;
	const ended = membership.status === "canceled";

	// ---- no lots: the subscription is known, nothing has been paid for yet -------------------------------------
	if (lots.length === 0) {
		throwIfAny(problems);
		const state: GrantsState = {
			...structuredClone(EMPTY_GRANTS_STATE),
			holder,
			membership: membershipRecord,
		};
		return { state, rows: [grantsRow(state)] };
	}

	// ---- place every lot on a row atm will hold ---------------------------------------------------------------
	const cycleLength = MONTHS_PER_INTERVAL[membership.interval];
	const tierRowSpecs = tier
		? tierSpecs(menu, tier.id, membership.interval)
		: [];
	const rowPlans = new Map<string, RowPlan>();
	const onceLots: OncePlan[] = [];
	const planOf = (spec: RowSpec, cpId: string): RowPlan => {
		const have = rowPlans.get(spec.rowId);
		if (have) return have;
		const made: RowPlan = { rowId: spec.rowId, spec, cpId, lots: [] };
		rowPlans.set(spec.rowId, made);
		return made;
	};
	for (const lot of [...lots].sort(byCreation)) {
		const where = `lot ${lot.id} (${lot.source}, ${lot.feature_id}, invoice ${lot.invoice_id})`;
		if (lot.membership_id !== membership.id)
			problem(
				`${where} belongs to membership ${lot.membership_id}, not ${membership.id}`,
			);
		if (lot.school_id !== membership.school_id)
			problem(
				`${where} belongs to school ${lot.school_id}, not ${membership.school_id}`,
			);
		if (!menu.features.some((f) => f.id === lot.feature_id)) {
			problem(
				`${where} grants feature ${JSON.stringify(lot.feature_id)}, which the menu does not have`,
			);
			continue;
		}
		if (lot.source === TIER_SOURCE) {
			if (!tier) continue;
			if (lot.every === "once") {
				problem(`${where} is a one-time lot of the tier, which has none`);
				continue;
			}
			// A monthly grant paid yearly is one yearly row of twelve times the amount (the caller records `every: month`).
			const interval: Interval =
				membership.interval === "year" && lot.every === "month"
					? "year"
					: lot.every;
			const spec = tierRowSpecs.find(
				(s) => s.feature === lot.feature_id && s.interval === interval,
			);
			if (!spec) {
				problem(
					`${where} is not a grant of tier ${tier.id} (${membership.interval}) on the menu: it grants ${lot.feature_id} every ${lot.every}`,
				);
				continue;
			}
			planOf(spec, TIER_CP).lots.push(lot);
			continue;
		}
		if (!lot.source.startsWith(ADDON_SOURCE_PREFIX)) {
			problem(
				`${where} has a source atm does not know (expected tier or addon:<id>)`,
			);
			continue;
		}
		const addonId = lot.source.slice(ADDON_SOURCE_PREFIX.length);
		const addon = menu.addons.find((a) => a.id === addonId);
		if (!addon) {
			problem(
				`${where} is for add-on ${JSON.stringify(addonId)}, which the menu does not have`,
			);
			continue;
		}
		if (addon.price.every === "once") {
			const grants = addon.grants.some((g) => g.featureId === lot.feature_id);
			if (!grants || lot.every !== "once") {
				problem(
					`${where} is not a one-time grant of add-on ${addon.id} on the menu`,
				);
				continue;
			}
			if (addon.gift === "dollars") {
				problem(
					`${where} is a credit lot of a dollar gift certificate, which grants no credits`,
				);
				continue;
			}
			onceLots.push({ lot, addon, feature: lot.feature_id });
			continue;
		}
		if (!recurringAddons.some((a) => a.id === addon.id)) {
			problem(
				`${where} is for add-on ${addon.id}, which ${label} no longer has (addon_ids ${JSON.stringify(membership.addon_ids)}): atm cannot take a lot of a dropped add-on`,
			);
			continue;
		}
		const specs = addonSpecs(menu, addon.id).filter(
			(s) => s.feature === lot.feature_id,
		);
		const spec = specs.length === 1 ? specs[0] : undefined;
		if (!spec) {
			problem(
				`${where} matches ${specs.length} grants of add-on ${addon.id} on the menu, not one`,
			);
			continue;
		}
		planOf(spec, `cp_addon_${addon.id}`).lots.push(lot);
	}

	// Everything the menu says the plan grants must have a lot, or atm would never refill it (it refills rows it holds).
	if (tier)
		for (const spec of tierRowSpecs)
			if (!rowPlans.has(spec.rowId))
				problem(
					`${label} has no lot for tier ${tier.id}'s grant of ${spec.feature} every ${spec.interval}: atm would never refill it`,
				);
	for (const addon of recurringAddons)
		for (const spec of addonSpecs(menu, addon.id))
			if (!rowPlans.has(spec.rowId))
				problem(
					`${label} has no lot for add-on ${addon.id}'s grant of ${spec.feature}: atm would never refill it`,
				);

	// Each credit row's lots by invoice: an invoice twice in one row is not something the caller's unique index allows.
	const epochs = new Map<string, Map<string, number>>();
	for (const plan of rowPlans.values()) {
		const byInvoice = new Map<string, number>();
		for (const lot of plan.lots) {
			if (byInvoice.has(lot.invoice_id))
				problem(
					`credit row ${plan.rowId} has two lots for invoice ${lot.invoice_id}`,
				);
			byInvoice.set(lot.invoice_id, byInvoice.size + 1);
		}
		epochs.set(plan.rowId, byInvoice);
	}

	// ---- the cycle the credits are in: read from the newest lot of every row that refills with the plan -----------
	const zone = menu.timeZone;
	const cycleRows = [...rowPlans.values()].filter(
		(p) => p.spec.interval === p.spec.plan,
	);
	const cycleEnds = new Map<string, number>();
	for (const plan of cycleRows) {
		const newest = plan.lots[plan.lots.length - 1] as Lot;
		const end = cycleEndOf({
			lot: newest,
			rollover: plan.spec.rollover,
			membershipEnd:
				membership.current_period_end === null
					? null
					: membership.current_period_end * MS_PER_SECOND,
			zone,
		});
		if (end === null)
			problem(
				`lot ${newest.id} expires at ${newest.expires_at}, which is not the end of a cycle plus the ${plan.spec.rollover?.months ?? 0} rollover month(s) the menu gives ${plan.spec.feature}: the lot and the menu disagree`,
			);
		else cycleEnds.set(plan.rowId, end);
	}
	const distinctEnds = new Set(cycleEnds.values());
	if (distinctEnds.size > 1)
		problem(
			`the credit rows of ${label} are on different cycles (ends ${[...distinctEnds].join(", ")}): a renewal was granted to some and not others`,
		);
	const cycleEnd =
		[...distinctEnds][0] ??
		(membership.current_period_end === null
			? null
			: membership.current_period_end * MS_PER_SECOND);
	const cycleStart =
		cycleEnd === null ? null : addUtcMonths(cycleEnd, -cycleLength);

	// ---- the quantity the credits reflect: what the tier's newest lot granted over the menu's per-unit amount ------
	let creditQuantity = membership.quantity;
	const quantities = new Set<number>();
	for (const plan of cycleRows.filter((p) => p.cpId === TIER_CP)) {
		const newest = plan.lots[plan.lots.length - 1] as Lot;
		const units = newest.allowance / plan.spec.amount;
		const whole = Math.round(units);
		if (whole < 1 || Math.abs(units - whole) > QUANTITY_TOLERANCE)
			problem(
				`lot ${newest.id} grants ${newest.allowance} ${plan.spec.feature}, which is not a whole number of the menu's ${plan.spec.amount} per unit`,
			);
		else quantities.add(whole);
	}
	if (quantities.size > 1)
		problem(
			`the tier's rows of ${label} were granted at different quantities (${[...quantities].join(", ")})`,
		);
	if (quantities.size === 1) creditQuantity = [...quantities][0] as number;
	for (const plan of cycleRows.filter((p) => p.cpId !== TIER_CP)) {
		const newest = plan.lots[plan.lots.length - 1] as Lot;
		if (newest.allowance !== plan.spec.amount)
			problem(
				`lot ${newest.id} grants ${newest.allowance} ${plan.spec.feature}, but add-on ${plan.cpId.replace("cp_addon_", "")} grants ${plan.spec.amount} on the menu`,
			);
	}

	for (const plan of rowPlans.values())
		if (plan.cpId === TIER_CP && removalIsPartial(plan.lots))
			problem(
				`credit row ${plan.rowId} has lots taken back for some invoices only`,
			);
	throwIfAny(problems);

	// ---- build the rows -----------------------------------------------------------------------------------------
	const engineRows: BillingRow[] = [];
	const addRow = (table: BillingRow["table"], id: string, data: unknown) =>
		engineRows.push({
			table,
			id,
			data: JSON.parse(JSON.stringify(data)) as BillingRow["data"],
		});
	const customer = customerRow(customerId);
	addRow("customer", customer.internal_id, customer);
	const tierId = (tier as MenuTier).id;
	const tierProduct = productOp(
		TIER_CP,
		tierProductId(tierId, membership.interval),
		customerId,
		createdAtMs,
		creditQuantity,
	).row as { id: string };
	addRow("customerProducts", tierProduct.id, tierProduct);
	for (const addon of recurringAddons) {
		const product = productOp(
			addonCp(addon.id),
			addonProductId(addon.id, addon.price.every),
			customerId,
			createdAtMs,
		).row as { id: string };
		addRow("customerProducts", product.id, product);
	}

	const state: GrantsState = {
		...structuredClone(EMPTY_GRANTS_STATE),
		identity: holder,
		holder,
		subscriptionId: membership.stripe_subscription_id,
		tierId,
		interval: membership.interval,
		anchor: null,
		cycleStart,
		cycleEnd,
		quantity: creditQuantity,
		addonIds: recurringAddons.map((a) => a.id),
		endedAt: ended
			? (membership.stripe_event_at ?? membership.updated_at) * MS_PER_SECOND
			: null,
		membership: membershipRecord,
	};
	const granted = new Map<string, GrantedRow[]>();
	const grantedOf = (invoiceId: string): GrantedRow[] => {
		const have = granted.get(invoiceId);
		if (have) return have;
		const made: GrantedRow[] = [];
		granted.set(invoiceId, made);
		return made;
	};

	for (const plan of rowPlans.values()) {
		const { spec } = plan;
		const first = plan.lots[0] as Lot;
		const newest = plan.lots[plan.lots.length - 1] as Lot;
		const own = spec.interval === spec.plan;
		// A row on its own interval (a yearly grant on a monthly plan) is refilled a full interval after its seed: the lot's
		// event time is the nearest the rows come to the seed (the invoice's period start is not kept).
		const boundary = own
			? (cycleEnds.get(plan.rowId) as number)
			: addUtcMonths(newest.created_at, MONTHS_PER_INTERVAL[spec.interval]);
		const row = rowOp({
			rowId: plan.rowId,
			cpId: plan.cpId,
			entitlementId: spec.entId,
			feature: spec.feature,
			customerId,
			balance: lapsed(newest, now) ? 0 : newest.balance,
			nextResetAt: ended ? null : boundary,
			expiresAt: ended ? newest.expires_at : null,
			t: first.created_at,
		}).row as Record<string, unknown>;
		row.adjustment = newest.adjustment;
		row.additional_balance = newest.additional_balance;
		addRow("customerEntitlements", plan.rowId, row);
		state.rows[plan.rowId] = plan.lots.length;

		// What earlier cycles left, still alive: the rollovers the engine would have made, with the caller's own expiry.
		for (const older of plan.lots.slice(0, -1)) {
			if (lapsed(older, now) || older.balance <= 0) continue;
			addRow("rollovers", `roll_${older.id}`, {
				id: `roll_${older.id}`,
				cus_ent_id: plan.rowId,
				balance: older.balance,
				usage: 0,
				expires_at: older.expires_at,
				entities: {},
			});
		}
		for (const lot of plan.lots) {
			const epoch = (epochs.get(plan.rowId) as Map<string, number>).get(
				lot.invoice_id,
			) as number;
			grantedOf(lot.invoice_id).push({
				invoiceId: lot.invoice_id,
				rowId: plan.rowId,
				feature: spec.feature,
				units: lot.allowance,
				epoch,
				// The newest lot's leftovers become the rollover the engine makes at the next reset (its own month arithmetic);
				// an older lot's already are one, expiring where the caller's lot expires.
				rolloverExpiresAt:
					lot === newest
						? rolloverExpiry(spec.rollover, boundary)
						: spec.rollover
							? lot.expires_at
							: null,
			});
		}
	}

	for (const { lot, addon, feature } of onceLots) {
		const gift = addon.gift === "sessions";
		const rowId = `ce_${gift ? "gift" : "once"}_${lot.invoice_id}_${addon.id}_${feature}`;
		if (!lapsed(lot, now)) {
			const row = rowOp({
				rowId,
				cpId: null,
				entitlementId: gift ? giftEntId(feature) : onceEntId(addon.id, feature),
				feature,
				customerId,
				balance: lot.balance,
				nextResetAt: null,
				expiresAt: lot.expires_at,
				t: lot.created_at,
			}).row as Record<string, unknown>;
			row.adjustment = lot.adjustment;
			row.additional_balance = lot.additional_balance;
			addRow("customerEntitlements", rowId, row);
			state.rows[rowId] = 1;
		}
		grantedOf(lot.invoice_id).push({
			invoiceId: lot.invoice_id,
			rowId,
			feature,
			units: lot.allowance,
			epoch: 1,
			rolloverExpiresAt: null,
		});
	}

	// Every invoice the lots name is a decided invoice: a replay finds its record and grants nothing.
	const lotsByInvoice = new Map<string, Lot[]>();
	for (const lot of lots) {
		const same = lotsByInvoice.get(lot.invoice_id) ?? [];
		same.push(lot);
		lotsByInvoice.set(lot.invoice_id, same);
	}
	for (const [invoiceId, same] of [...lotsByInvoice].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		const record: InvoiceRecord = {
			paidAt: Math.min(...same.map((l) => l.created_at)),
			granted: grantedOf(invoiceId),
			removed: same.every((l) => l.removed_at !== null),
		};
		state.invoices[invoiceId] = record;
	}
	return { state, rows: sortRows([...engineRows, grantsRow(state)]) };
};

const throwIfAny = (problems: readonly string[]): void => {
	if (problems.length === 0) return;
	throw new Error(
		`the caller's rows cannot be moved onto atm as they are: ${problems.join("; ")}`,
	);
};

/** Some lots of a row taken back and others not, which a refund or a lost dispute does not make (it takes back a whole invoice). */
const removalIsPartial = (lots: readonly Lot[]): boolean => {
	const byInvoice = new Map<string, boolean[]>();
	for (const lot of lots) {
		const flags = byInvoice.get(lot.invoice_id) ?? [];
		flags.push(lot.removed_at !== null);
		byInvoice.set(lot.invoice_id, flags);
	}
	return [...byInvoice.values()].some(
		(flags) => flags.some(Boolean) && !flags.every(Boolean),
	);
};

/**
 * The end of the cycle a lot was granted for. A lot lasts to the cycle's end plus the grant's rollover months on the
 * school's calendar (no rollover: to the cycle's end), so the end is read back from the expiry: the membership's own
 * renewal date when that fits, else the expiry minus the months. Null when neither gives the expiry again.
 */
const cycleEndOf = ({
	lot,
	rollover,
	membershipEnd,
	zone,
}: {
	lot: Lot;
	rollover: RowSpec["rollover"];
	membershipEnd: number | null;
	zone: string;
}): number | null => {
	if (lot.expires_at === null) return null;
	if (!rollover) return lot.expires_at;
	const { months } = rollover;
	const candidates = [
		membershipEnd,
		addZonedMonths(lot.expires_at, -months, zone),
	];
	return (
		candidates.find(
			(candidate) =>
				candidate !== null &&
				addZonedMonths(candidate, months, zone) === lot.expires_at,
		) ?? null
	);
};

const membershipRecordOf = (
	membership: CallerMembershipRow,
	tier: MenuTier | undefined,
): MembershipRecord => {
	const periodEnd =
		membership.current_period_end === null
			? Number.NaN
			: membership.current_period_end * MS_PER_SECOND;
	const at =
		(membership.stripe_event_at ?? membership.updated_at) * MS_PER_SECOND;
	const shown = subscriptionStatus({
		source: {
			eventId: membership.id,
			mapping: "caller/school_memberships",
			stripeApiVersion: "",
		},
		id: membership.stripe_subscription_id,
		customerId: membership.stripe_customer_id,
		status: membership.status,
		items: [],
		currentPeriodStart: 0,
		currentPeriodEnd: periodEnd,
		cancelAtPeriodEnd: membership.cancel_at_period_end === 1,
		at,
		metadata: {},
	});
	return {
		subscriptionId: membership.stripe_subscription_id,
		status: shown.status,
		tierId: tier?.id ?? null,
		interval: membership.interval,
		quantity: membership.quantity,
		renewsAt: shown.renewsAt,
		cancelAtPeriodEnd: shown.cancelAtPeriodEnd,
		endsAt: shown.endsAt,
		at,
	};
};
