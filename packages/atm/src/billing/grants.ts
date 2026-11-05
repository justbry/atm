/**
 * Which paid invoice grants what credits, and when credits go away: the B4 Uni rules ("Default billing rules" in
 * the tiers spec) as pure functions. Facts in (a normalized invoice, refund or dispute, the menu, the policy, a
 * small JSON `GrantsState`), engine commands out. No I/O, no clock: every command carries its own `occurredAt`.
 *
 * The engine owns the credits' life: a tier's grant is a customer entitlement with a reset interval and a
 * rollover; a cycle's invoice runs the engine's own `reset` (refill, carry over within `max`, rollover expiry
 * counted from the cycle that ended). A renewal paid late or after retries still resets from the invoice's period
 * start, so the next boundary and the rollover expiry never drift. One-off grants (gifts, one-time add-ons) are
 * rows with an `expires_at`.
 *
 * Run the commands in order through `runOnState` (or the family service's equivalent) against a catalog made by
 * `menuCatalogRows` from the same menu; every command carries `${source.eventId}:${step}` as `commandId` and
 * `requestId`, so the ledger event it makes can name the input event as its cause.
 *
 * The one date calculation here is `addUtcMonths`, for the `expires_at` of a one-off grant (the engine takes that
 * instant as input; its own month arithmetic is for resets and rollovers).
 */

import { subscriptionStatus } from "./status.js";
import type {
	AtmSubject,
	BillingDispute,
	BillingInvoice,
	BillingPolicy,
	BillingRefund,
	FactSource,
	GrantCommand,
	GrantedRow,
	GrantLabels,
	GrantResult,
	GrantsState,
	Interval,
	InvoiceGrantInput,
	InvoiceLine,
	InvoiceRecord,
	MembershipRecord,
	Menu,
	MenuGrant,
	GrantRemovalInput as RemovalInput,
	Rollover,
	SubscriptionEndInput,
	SubscriptionFact,
	GrantVersions as Versions,
} from "./types.js";

export const EMPTY_GRANTS_STATE: GrantsState = {
	v: 1,
	identity: null,
	holder: null,
	subscriptionId: null,
	tierId: null,
	interval: null,
	anchor: null,
	cycleStart: null,
	cycleEnd: null,
	quantity: 1,
	addonIds: [],
	endedAt: null,
	rows: {},
	retired: {},
	membership: null,
	invoices: {},
};

const ORG = {
	config: {
		reverse_deduction_order: false,
		block_overdue_entitlements: false,
		include_past_due: true,
	},
};

// ---------------------------------------------------------------------------------------------------------------
// Names: one place for every id the catalog and the commands share.
// ---------------------------------------------------------------------------------------------------------------

const featId = (feature: string) => `feat_${feature}`;
const tierProductId = (tierId: string, interval: Interval) =>
	`tier_${tierId}_${interval}`;
const addonProductId = (addonId: string, every: string) =>
	`addon_${addonId}_${every}`;
const internalProduct = (productId: string) => `prod_${productId}`;
const entId = (productId: string, feature: string, interval: string) =>
	`ent_${productId}_${feature}_${interval}`;
const giftEntId = (feature: string) => `ent_gift_${feature}`;
const onceEntId = (addonId: string, feature: string) =>
	`ent_addon_${addonId}_once_${feature}`;
const tierRowId = (feature: string, interval: string) =>
	`ce_tier_${feature}_${interval}`;
const addonRowId = (addonId: string, feature: string, interval: string) =>
	`ce_addon_${addonId}_${feature}_${interval}`;
const TIER_CP = "cp_tier";
const addonCp = (addonId: string) => `cp_addon_${addonId}`;
const customerInternal = (customerId: string) => `cus_${customerId}`;

/**
 * What one grant is on a plan billed `plan`: a yearly payment carries the whole year of a monthly grant (12 x,
 * reset yearly); a yearly grant on a monthly plan is a yearly row.
 */
const effective = (
	plan: Interval,
	g: MenuGrant,
): { interval: Interval; amount: number } =>
	plan === "year" && g.every === "month"
		? { interval: "year", amount: g.amount * 12 }
		: { interval: g.every, amount: g.amount };

type RowSpec = {
	rowId: string;
	entId: string;
	productId: string;
	feature: string;
	interval: Interval;
	amount: number;
	rollover: MenuGrant["rollover"];
	/** The plan's billing interval. A row on a different interval is refilled by its own reset, not the cycle's. */
	plan: Interval;
};

const specsOf = ({
	grants,
	plan,
	productId,
	rowId,
}: {
	grants: MenuGrant[];
	plan: Interval;
	productId: string;
	rowId: (feature: string, interval: Interval) => string;
}): RowSpec[] => {
	const byKey = new Map<string, RowSpec>();
	for (const g of grants) {
		const e = effective(plan, g);
		const key = `${g.featureId}|${e.interval}`;
		const have = byKey.get(key);
		if (have) {
			have.amount += e.amount;
			continue;
		}
		byKey.set(key, {
			rowId: rowId(g.featureId, e.interval),
			entId: entId(productId, g.featureId, e.interval),
			productId,
			feature: g.featureId,
			interval: e.interval,
			amount: e.amount,
			rollover: g.rollover,
			plan,
		});
	}
	return [...byKey.values()];
};

const tierOf = (menu: Menu, tierId: string) => {
	const t = menu.tiers.find((x) => x.id === tierId);
	if (!t) throw new Error(`tier ${JSON.stringify(tierId)} is not on the menu`);
	return t;
};
const addonOf = (menu: Menu, addonId: string) => {
	const a = menu.addons.find((x) => x.id === addonId);
	if (!a)
		throw new Error(`add-on ${JSON.stringify(addonId)} is not on the menu`);
	return a;
};

const tierSpecs = (menu: Menu, tierId: string, interval: Interval) =>
	specsOf({
		grants: tierOf(menu, tierId).grants,
		plan: interval,
		productId: tierProductId(tierId, interval),
		rowId: tierRowId,
	});

/** A recurring add-on is billed on its own interval; its grants follow the same rule as a tier's. */
const addonSpecs = (menu: Menu, addonId: string) => {
	const addon = addonOf(menu, addonId);
	const every = addon.price.every;
	if (every === "once") return [];
	return specsOf({
		grants: addon.grants,
		plan: every,
		productId: addonProductId(addonId, every),
		rowId: (feature, interval) => addonRowId(addonId, feature, interval),
	});
};

// ---------------------------------------------------------------------------------------------------------------
// The catalog the commands refer to.
// ---------------------------------------------------------------------------------------------------------------

type CatalogRowOut = { table: string; row: Record<string, unknown> };

/** Nine decimals of a percentage, rounded up: enough for any allowance, never a unit short after the engine's floor. */
const PERCENT_SCALE = 1e9;

/**
 * The engine's rollover terms for a row granting `allowance` per unit. A tier sold in a quantity refills `allowance` x
 * the customer product's quantity, and its cap must grow with it: the engine scales only `max_percentage` (of the
 * refill, floored), not `max`, so the cap is written as `max` over the per-unit allowance. A zero allowance keeps `max`.
 */
const rolloverConfig = (r: MenuGrant["rollover"], allowance: number) => {
	if (!r) return null;
	const cap =
		r.max === undefined
			? {}
			: allowance > 0
				? {
						max_percentage:
							Math.ceil((r.max * 100 * PERCENT_SCALE) / allowance) /
							PERCENT_SCALE,
					}
				: { max: r.max };
	return { ...cap, duration: "month", length: r.months };
};

/**
 * The engine catalog rows (features, products, entitlements) for a menu: one product per tier and price
 * interval, one per recurring add-on, and the entitlements the commands name. Pass it to `toCatalog`.
 */
export const menuCatalogRows = ({
	menu,
	school,
	createdAt = 0,
}: {
	menu: Menu;
	school: string;
	createdAt?: number;
}): CatalogRowOut[] => {
	const rows: CatalogRowOut[] = [];
	const ent = (
		id: string,
		product: string | null,
		feature: string,
		allowance: number,
		interval: string,
		rollover: unknown,
	) =>
		rows.push({
			table: "entitlements",
			row: {
				id,
				created_at: createdAt,
				internal_feature_id: featId(feature),
				internal_product_id: product === null ? null : internalProduct(product),
				is_custom: false,
				allowance_type: "fixed",
				allowance,
				interval,
				interval_count: 1,
				org_id: school,
				usage_limit: null,
				rollover,
			},
		});
	const product = (id: string, name: string, isAddOn: boolean) =>
		rows.push({
			table: "products",
			row: {
				id,
				name,
				description: null,
				is_add_on: isAddOn,
				is_default: false,
				version: 1,
				version_slug: "v1",
				active: true,
				deleted_at: null,
				previous_version_slug: null,
				group: isAddOn ? "addon" : "membership",
				env: "live",
				internal_id: internalProduct(id),
				org_id: school,
				created_at: createdAt,
				base_variant_id: null,
				archived: false,
				config: { ignore_past_due: false },
				metadata: {},
			},
		});
	for (const f of menu.features) {
		rows.push({
			table: "features",
			row: {
				internal_id: featId(f.id),
				org_id: school,
				created_at: createdAt,
				env: "live",
				id: f.id,
				name: f.name,
				type: "metered",
				config: {},
				archived: false,
				event_names: [],
			},
		});
		// Gift certificate: a one-off row with its own expiry, no cycle.
		ent(giftEntId(f.id), null, f.id, 1, "lifetime", null);
	}
	for (const tier of menu.tiers) {
		for (const price of tier.prices) {
			const pid = tierProductId(tier.id, price.interval);
			product(pid, tier.name, false);
			for (const s of tierSpecs(menu, tier.id, price.interval))
				ent(
					s.entId,
					pid,
					s.feature,
					s.amount,
					s.interval,
					rolloverConfig(s.rollover, s.amount),
				);
		}
	}
	for (const addon of menu.addons) {
		if (addon.price.every === "once") {
			for (const g of addon.grants)
				ent(
					onceEntId(addon.id, g.featureId),
					null,
					g.featureId,
					g.amount,
					"lifetime",
					null,
				);
			continue;
		}
		const pid = addonProductId(addon.id, addon.price.every);
		product(pid, addon.name, true);
		for (const s of addonSpecs(menu, addon.id))
			ent(
				s.entId,
				pid,
				s.feature,
				s.amount,
				s.interval,
				rolloverConfig(s.rollover, s.amount),
			);
	}
	return rows;
};

// ---------------------------------------------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------------------------------------------

/** `ms` plus whole months on the UTC calendar, the day clamped to the end of a shorter month. */
export const addUtcMonths = (ms: number, months: number): number => {
	const d = new Date(ms);
	const target = d.getUTCMonth() + months;
	const daysIn = new Date(
		Date.UTC(d.getUTCFullYear(), target + 1, 0),
	).getUTCDate();
	return Date.UTC(
		d.getUTCFullYear(),
		target,
		Math.min(d.getUTCDate(), daysIn),
		d.getUTCHours(),
		d.getUTCMinutes(),
		d.getUTCSeconds(),
		d.getUTCMilliseconds(),
	);
};

const DAY_MS = 86_400_000;

const WALL_PARTS = {
	hourCycle: "h23",
	year: "numeric",
	month: "numeric",
	day: "numeric",
	hour: "numeric",
	minute: "numeric",
	second: "numeric",
} as const;

/** The wall clock of `ms` in `timeZone` as if it were UTC: the number to add months to and to turn back into an instant. */
const wallMs = (ms: number, timeZone: string): number => {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", { ...WALL_PARTS, timeZone })
			.formatToParts(new Date(ms))
			.map((p) => [p.type, Number(p.value)]),
	);
	return (
		Date.UTC(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour,
			parts.minute,
			parts.second,
		) +
		(ms % 1000)
	);
};

/**
 * `ms` plus whole months on the calendar of `timeZone` (same wall-clock time, day clamped to the end of a shorter
 * month): a gift bought at noon in Denver in January lapses at noon in Denver six months on, across the clocks changing.
 */
export const addZonedMonths = (
	ms: number,
	months: number,
	timeZone: string,
): number => {
	const target = addUtcMonths(wallMs(ms, timeZone), months);
	// The zone's offset a day before and a day after the target bracket any clock change near it.
	const offsetAt = (instant: number) => wallMs(instant, timeZone) - instant;
	const before = target - offsetAt(target - DAY_MS);
	const after = target - offsetAt(target + DAY_MS);
	const fits = (instant: number) => wallMs(instant, timeZone) === target;
	// A wall time that happens twice (clocks back) is its first time; one that never happens (clocks forward) is read
	// with the offset from before the change, which lands just after the gap. Either way the same rule in every zone.
	if (fits(before) && fits(after)) return Math.min(before, after);
	return fits(after) && !fits(before) ? after : before;
};

const labelsOf = (source: FactSource, v: Versions): GrantLabels => ({
	menu_version: String(v.menuVersion),
	policy_version: String(v.policyVersion),
	mapping: source.mapping,
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** When a refill's leftovers lapse if the engine rolls them over at `boundary` (the end of the cycle that refilled the row). */
const rolloverExpiry = (rollover: Rollover | undefined, boundary: number) =>
	rollover ? addUtcMonths(boundary, rollover.months) : null;

type HeldRollover = {
	id: string;
	balance: number;
	expiresAt: number | null;
	row: Record<string, unknown>;
};
type Held = {
	balance: number;
	nextResetAt: number | null;
	expiresAt: number | null;
	rollovers: HeldRollover[];
};

const numberOrNull = (v: unknown): number | null =>
	typeof v === "number" ? v : null;

/** What each credit row of the subject holds now: balance, next reset, own expiry and its rollovers. No subject, no rows. */
const heldOf = (subject: AtmSubject | null): Map<string, Held> => {
	const held = new Map<string, Held>();
	if (!subject) return held;
	const rows = [
		...subject.customer_products.flatMap(
			(p) =>
				(p.customer_entitlements as Record<string, unknown>[] | undefined) ??
				[],
		),
		...subject.extra_customer_entitlements,
	];
	for (const r of rows) {
		const rollovers =
			(r.rollovers as Record<string, unknown>[] | undefined) ?? [];
		held.set(r.id as string, {
			balance: typeof r.balance === "number" ? r.balance : 0,
			nextResetAt: numberOrNull(r.next_reset_at),
			expiresAt: numberOrNull(r.expires_at),
			rollovers: rollovers.map((o) => ({
				id: o.id as string,
				balance: typeof o.balance === "number" ? o.balance : 0,
				expiresAt: numberOrNull(o.expires_at),
				row: {
					id: o.id,
					cus_ent_id: o.cus_ent_id,
					balance: o.balance,
					usage: o.usage ?? 0,
					expires_at: o.expires_at,
					entities: o.entities ?? {},
				},
			})),
		});
	}
	return held;
};

/** Units of an upgrade: `diff` x share of the cycle left, rounded up (integer math; never negative). */
const upgradeUnits = ({
	diff,
	policy,
	at,
	start,
	end,
}: {
	diff: number;
	policy: BillingPolicy;
	at: number;
	start: number | null;
	end: number | null;
}): number => {
	if (diff <= 0 || policy.upgradeGrant === "none") return 0;
	if (policy.upgradeGrant === "full" || start === null || end === null)
		return diff;
	const span = end - start;
	if (span <= 0) return diff;
	const left = Math.min(Math.max(end - at, 0), span);
	return Math.floor((diff * left + span - 1) / span);
};

type Op = Record<string, unknown>;

class Builder {
	readonly commands: GrantCommand[] = [];
	constructor(
		private readonly source: FactSource,
		private readonly identity: {
			orgId: string;
			customerId: string;
		},
	) {}
	get ident() {
		return {
			orgId: this.identity.orgId,
			env: "live",
			customerId: this.identity.customerId,
			entityId: null,
		};
	}
	private base(type: string, occurredAt: number) {
		const step = this.commands.length + 1;
		const id = `${this.source.eventId}:${step}`;
		return {
			schemaVersion: 1,
			type,
			org: ORG,
			commandId: id,
			requestId: id,
			identity: this.ident,
			occurredAt,
		};
	}
	plan(occurredAt: number, ops: Op[]) {
		if (ops.length === 0) return;
		this.commands.push({
			...this.base("applyBillingPlan", occurredAt),
			entityIds: [],
			expiringPooledBalanceIds: [],
			ops,
		});
	}
	reset(occurredAt: number) {
		this.commands.push(this.base("reset", occurredAt));
	}
	add(occurredAt: number, feature: string, rowId: string, units: number) {
		this.commands.push({
			...this.base("updateBalance", occurredAt),
			featureId: feature,
			internalFeatureId: featId(feature),
			customerEntitlementFilters: { cusEntIds: [rowId] },
			addToBalance: units,
		});
	}
}

const customerRow = (customerId: string) => ({
	internal_id: customerInternal(customerId),
	id: customerId,
	config: null,
	spend_limits: null,
	overage_allowed: null,
	usage_limits: null,
	usage_alerts: null,
	processor: null,
});

const productOp = (
	cpId: string,
	productId: string,
	customerId: string,
	t: number,
	quantity = 1,
): Op => ({
	op: "insert",
	table: "customerProducts",
	row: {
		id: cpId,
		internal_customer_id: customerInternal(customerId),
		internal_product_id: internalProduct(productId),
		internal_entity_id: null,
		status: "active",
		options: [],
		quantity,
		created_at: t,
		starts_at: t,
		access_starts_at: null,
		ended_at: null,
		customer_license_link_id: null,
	},
});

const rowOp = ({
	rowId,
	cpId,
	entitlementId,
	feature,
	customerId,
	balance,
	nextResetAt,
	expiresAt,
	t,
}: {
	rowId: string;
	cpId: string | null;
	entitlementId: string;
	feature: string;
	customerId: string;
	balance: number;
	nextResetAt: number | null;
	expiresAt: number | null;
	t: number;
}): Op => ({
	op: "insert",
	table: "customerEntitlements",
	row: {
		id: rowId,
		customer_product_id: cpId,
		entitlement_id: entitlementId,
		internal_customer_id: customerInternal(customerId),
		internal_entity_id: null,
		internal_feature_id: featId(feature),
		balance,
		adjustment: 0,
		additional_balance: 0,
		unlimited: false,
		usage_allowed: false,
		next_reset_at: nextResetAt,
		reset_cycle_anchor: null,
		expires_at: expiresAt,
		external_id: null,
		created_at: t,
	},
});

/** The tier's customer product at `quantity` units: the engine's refill (and its rollover cap) is the allowance x it. */
const tierQuantityOp = (quantity: number): Op => ({
	op: "update",
	table: "customerProducts",
	id: TIER_CP,
	set: { quantity },
});

const stopRefill = (rowId: string): Op => ({
	op: "update",
	table: "customerEntitlements",
	id: rowId,
	set: { next_reset_at: null },
});

// ---------------------------------------------------------------------------------------------------------------
// Invoice -> commands
// ---------------------------------------------------------------------------------------------------------------

const identityFrom = (
	invoice: BillingInvoice,
	state: GrantsState,
): { orgId: string; customerId: string } => {
	if (state.identity) return state.identity;
	// Known from an earlier invoice (a dollar gift): the checkout metadata is not needed again.
	if (state.holder) return state.holder;
	const orgId = invoice.metadata.b4u_school;
	const family = invoice.metadata.family_id;
	if (!orgId || !family)
		throw new Error(
			`invoice ${invoice.id} has no b4u_school/family_id metadata to name the holder`,
		);
	return { orgId, customerId: `family:${family}` };
};

/** Who an invoice's credits belong to: the school and the family named in its checkout metadata. Throws when it names neither. */
export const invoiceHolder = (
	invoice: BillingInvoice,
): { orgId: string; customerId: string } =>
	identityFrom(invoice, EMPTY_GRANTS_STATE);

/**
 * The engine commands one paid invoice calls for, in order, and the state after them.
 *
 * A tier's grants are per unit: its tier line's `quantity` (Stripe's) multiplies every one, and `state.quantity` keeps
 * the quantity the credits reflect.
 *
 * - `subscription_create`: the customer, the tier's product and its credit rows (the whole allowance x the line's
 *   quantity, next reset at the period end), recurring add-ons, and one-time add-ons.
 * - `subscription_cycle`: if the tier changed since (a downgrade took effect) the plan moves to it first, sessions
 *   kept; then the engine's `reset` at the period start (the policy's anchor): refill to the allowance x the tier
 *   line's quantity (a decrease made since takes effect here), rollover within `max` x that quantity (so at a decrease
 *   the carry-over cap follows the new, lower count: the engine has one cap per row). Proration lines on it grant nothing. Nothing is granted for an unpaid cycle because nothing runs for it.
 * - `subscription_update` with a positive proration line for another tier (an upgrade), or for the same tier at a
 *   higher quantity (a raise): the difference of allowance x quantity (the credit line's quantity is the old one, the
 *   charge line's the new total) x share of the cycle left, rounded up, per `policy.upgradeGrant`. A lower tier, or the
 *   same tier at no more units, grants nothing.
 * - Gift certificate (an add-on with `gift`, or a line whose Stripe price says so): `sessions` is a one-off row per
 *   grant with `expires_at` = `policy.giftSessionMonths` after `paidAt` on the menu's calendar (`menu.timeZone`);
 *   `dollars` grants no credits.
 *
 * A replayed invoice (already in `state.invoices`) gives no commands.
 */
export const invoiceToCommands = (input: InvoiceGrantInput): GrantResult => {
	const { invoice, menu, policy, now } = input;
	const labels = labelsOf(invoice.source, input);
	if (input.state.invoices[invoice.id])
		return { commands: [], labels, state: input.state };
	const state = clone(input.state);
	const who = identityFrom(invoice, state);
	state.holder ??= who;
	const b = new Builder(invoice.source, who);
	const record: InvoiceRecord = {
		paidAt: invoice.paidAt,
		granted: [],
		removed: false,
	};
	// A line that pays for no units (a paused add-on, a tier at quantity 0) grants nothing, and is not coerced to one unit.
	const lines = invoice.lines.filter(
		(l: InvoiceLine) => l.kind !== "unknown" && l.quantity >= 1,
	);
	// Once the subscription has ended nothing more is granted for it, whatever invoice still arrives.
	const live =
		state.endedAt === null || invoice.subscriptionId !== state.subscriptionId;
	const tierLine = live
		? lines.find(
				(l) => l.kind === "tier" && !l.proration && l.tierId && l.interval,
			)
		: undefined;
	// The raise is the positive proration line that starts LAST: a decrease made with create_prorations leaves an older
	// pair pending, and it rides on whichever invoice comes next (a later raise, an add-on purchase, a renewal).
	const upLine = live
		? lines
				.filter(
					(l) =>
						l.kind === "tier" &&
						l.proration &&
						l.tierId &&
						l.interval &&
						l.amount > 0,
				)
				.reduce<InvoiceLine | undefined>(
					(latest, l) =>
						latest === undefined ||
						(l.periodStart ?? Number.NEGATIVE_INFINITY) >
							(latest.periodStart ?? Number.NEGATIVE_INFINITY)
							? l
							: latest,
					undefined,
				)
		: undefined;
	const recurring = live
		? lines.filter(
				(l) => l.kind === "addon" && !l.proration && l.addonId && l.interval,
			)
		: [];
	const once = lines.filter(
		(l) => l.kind === "addon" && !l.proration && l.addonId && !l.interval,
	);
	/** A line's gift kind: the Stripe price's own metadata when the line shows it, else the menu's add-on. */
	const giftOf = (l: InvoiceLine) =>
		l.gift ?? addonOf(menu, l.addonId as string).gift ?? null;
	// A dollar certificate is a coupon the family service issues: it grants no credits.
	const credited = once.filter((l) => giftOf(l) !== "dollars");
	// The service period this invoice pays for. Stripe's own period fields disagree by invoice: a renewal's invoice period
	// is the PREVIOUS one while its tier line carries the new one, and a first invoice's period is a single instant while
	// its line carries the real one. So the tier line's period wins; the invoice's is the fallback (manual and gift
	// invoices, add-on-only invoices, lines without a period). Start and end come from one source: a line with only one of
	// them would pair, say, the new start with the invoice's end (the previous period's end, the same instant).
	const periodLine = tierLine ?? upLine;
	const { periodStart, periodEnd } =
		periodLine?.periodStart !== undefined && periodLine.periodEnd !== undefined
			? { periodStart: periodLine.periodStart, periodEnd: periodLine.periodEnd }
			: invoice;
	// The cycle always anchors on the period start (not the payment time: a late renewal resets from the start). The engine
	// refills rows whose reset is strictly before the command's time, so the reset runs 1 ms after the anchor.
	const anchorAt = periodStart + 1;
	// A row seeded later than the anchor (an off-cycle add-on bought mid-cycle, seeded at its line's start) is refilled only
	// by a reset after its seed, so the reset runs at the later of the two.
	let resetAt = anchorAt;
	const ops: Op[] = [];
	let needReset = false;
	let created = false;
	/** Rows this cycle invoice refills, and the Stripe end of the cycle they now run to. */
	let cycleRows: { rowIds: string[]; end: number } | null = null;

	/** Remember what this invoice put into a row; `boundary` is the end of the cycle that refilled it. */
	const grantRow = (s: RowSpec, units: number, boundary: number) => {
		record.granted.push({
			invoiceId: invoice.id,
			rowId: s.rowId,
			feature: s.feature,
			units,
			epoch: state.rows[s.rowId] ?? 1,
			rolloverExpiresAt: rolloverExpiry(s.rollover, boundary),
		});
	};
	/** Insert a plan's row: full allowance now when its cycle is the invoice's, else seeded and refilled by `reset`. */
	const insertSpec = (
		s: RowSpec,
		cpId: string,
		balance: number,
		cycleEnd: number,
		seedAt: number,
		quantity = 1,
	) => {
		const matches = s.interval === s.plan;
		const full = s.amount * quantity;
		ops.push(
			rowOp({
				rowId: s.rowId,
				cpId,
				entitlementId: s.entId,
				feature: s.feature,
				customerId: who.customerId,
				balance: matches ? balance : 0,
				nextResetAt: matches ? cycleEnd : seedAt,
				expiresAt: null,
				t: now,
			}),
		);
		state.rows[s.rowId] = 1;
		if (matches) {
			if (balance > 0) grantRow(s, balance, cycleEnd);
		} else {
			needReset = true;
			resetAt = Math.max(resetAt, seedAt + 1);
			// An off-cycle row (a yearly grant on a monthly plan) is refilled by the engine a full interval after its seed date.
			grantRow(s, full, addUtcMonths(seedAt, s.interval === "year" ? 12 : 1));
		}
	};
	const attachAddon = (line: InvoiceLine, share: "full" | "prorate") => {
		const addonId = line.addonId as string;
		const specs = addonSpecs(menu, addonId);
		const addon = addonOf(menu, addonId);
		if (addon.price.every === "once") return;
		const pid = addonProductId(addonId, addon.price.every);
		const end = line.periodEnd ?? periodEnd;
		ops.push(productOp(addonCp(addonId), pid, who.customerId, now));
		for (const s of specs) {
			const full = s.amount * line.quantity;
			const units =
				share === "full"
					? full
					: upgradeUnits({
							diff: full,
							policy,
							at: line.periodStart ?? invoice.paidAt,
							start: state.cycleStart,
							end: state.cycleEnd,
						});
			insertSpec(
				s,
				addonCp(addonId),
				units,
				end,
				line.periodStart ?? periodStart,
				line.quantity,
			);
		}
		if (!state.addonIds.includes(addonId)) state.addonIds.push(addonId);
	};

	// ---- the tier --------------------------------------------------------------------------------------------
	const isCreate =
		tierLine !== undefined &&
		(invoice.reason === "subscription_create" || state.tierId === null);
	if (isCreate && tierLine && state.endedAt !== null)
		// The tier's credit rows and product have fixed ids; a second subscription would insert them again.
		throw new Error(
			`invoice ${invoice.id} starts subscription ${invoice.subscriptionId}, but ${state.subscriptionId} ended: a second subscription for the same family is not supported yet`,
		);
	if (isCreate && tierLine) {
		const tierId = tierLine.tierId as string;
		const interval = tierLine.interval as Interval;
		const end = periodEnd;
		const quantity = tierLine.quantity;
		created = true;
		if (state.identity === null)
			ops.push({
				op: "insert",
				table: "customer",
				row: customerRow(who.customerId),
			});
		ops.push(
			productOp(
				TIER_CP,
				tierProductId(tierId, interval),
				who.customerId,
				now,
				quantity,
			),
		);
		for (const s of tierSpecs(menu, tierId, interval))
			insertSpec(s, TIER_CP, s.amount * quantity, end, periodStart, quantity);
		state.tierId = tierId;
		state.interval = interval;
		state.quantity = quantity;
		state.subscriptionId = invoice.subscriptionId;
		state.anchor = periodStart;
		state.cycleStart = periodStart;
		state.cycleEnd = end;
		for (const l of recurring) attachAddon(l, "full");
	} else if (
		tierLine &&
		invoice.reason === "subscription_cycle" &&
		state.tierId
	) {
		const tierId = tierLine.tierId as string;
		const interval = tierLine.interval as Interval;
		const end = periodEnd;
		// The renewal's tier line says how many units this cycle pays for (a decrease since takes effect here). Its proration
		// lines, if any (a decrease made with create_prorations rides on the renewal), grant nothing.
		const quantity = tierLine.quantity;
		if (quantity !== state.quantity) ops.push(tierQuantityOp(quantity));
		state.quantity = quantity;
		if (tierId !== state.tierId || interval !== state.interval) {
			moveTier({
				menu,
				state,
				to: { tierId, interval },
				ops,
				insert: (s) =>
					insertSpec(
						s,
						TIER_CP,
						s.amount * quantity,
						end,
						periodStart,
						quantity,
					),
				// The reset at the period start refills it: what is left rolls over, the allowance comes back.
				revive: (s) => {
					ops.push({
						op: "update",
						table: "customerEntitlements",
						id: s.rowId,
						set: { next_reset_at: periodStart },
					});
					state.rows[s.rowId] = (state.rows[s.rowId] ?? 0) + 1;
					grantRow(
						s,
						s.amount * quantity,
						s.interval === s.plan
							? end
							: addUtcMonths(periodStart, s.interval === "year" ? 12 : 1),
					);
					needReset = true;
				},
				units: () => 0,
			});
		}
		// Rows on the plan's own interval are refilled by this cycle; add-on rows too.
		const want = new Set(recurring.map((l) => l.addonId as string));
		for (const id of state.addonIds) {
			if (!want.has(id)) {
				for (const s of addonSpecs(menu, id)) {
					ops.push(stopRefill(s.rowId));
					state.retired[s.rowId] = state.rows[s.rowId] ?? 1;
					delete state.rows[s.rowId];
				}
			}
		}
		for (const l of recurring) {
			if (!state.addonIds.includes(l.addonId as string)) attachAddon(l, "full");
		}
		state.addonIds = state.addonIds.filter((id) => want.has(id));
		const refilled: string[] = [];
		// The tier's rows refill at its quantity; an add-on's product is one unit, so its rows refill their allowance.
		for (const { s, units } of [
			...tierSpecs(menu, tierId, interval).map((spec) => ({
				s: spec,
				units: spec.amount * quantity,
			})),
			...state.addonIds
				.flatMap((id) => addonSpecs(menu, id))
				.map((spec) => ({ s: spec, units: spec.amount })),
		]) {
			if (s.interval !== s.plan) continue;
			if (!(s.rowId in state.rows)) continue;
			refilled.push(s.rowId);
			const fresh = record.granted.some((g) => g.rowId === s.rowId);
			if (!fresh) {
				state.rows[s.rowId] = (state.rows[s.rowId] ?? 0) + 1;
				grantRow(s, units, end);
			}
		}
		needReset = true;
		cycleRows = { rowIds: refilled, end };
		state.cycleStart = periodStart;
		state.cycleEnd = end;
	} else if (
		upLine &&
		invoice.reason === "subscription_update" &&
		state.tierId
	) {
		const tierId = upLine.tierId as string;
		const interval = upLine.interval as Interval;
		const sameTier = tierId === state.tierId && interval === state.interval;
		// Stripe's raise (API 2025-10-29.clover, recorded): the credit line of the plan left carries the OLD quantity, the
		// charge line the NEW total (not the difference). Without a credit line the quantity the credits reflect is the old.
		// The credit of THIS raise starts when its charge does; a stale pair's credit starts earlier and is not it.
		const credits = lines.filter(
			(l) =>
				l.kind === "tier" &&
				l.proration &&
				l.amount < 0 &&
				l.tierId === state.tierId &&
				l.interval === state.interval,
		);
		const creditLine =
			upLine.periodStart === undefined
				? credits[0]
				: credits.find((l) => l.periodStart === upLine.periodStart);
		const oldQuantity = creditLine ? creditLine.quantity : state.quantity;
		const newQuantity = upLine.quantity;
		// Another tier is always a move (a lower one grants nothing); the same tier grants only for more units.
		if (!sameTier || newQuantity > oldQuantity) {
			const at = upLine.periodStart ?? invoice.paidAt;
			const newEnd =
				interval === state.interval ? (state.cycleEnd ?? periodEnd) : periodEnd;
			const oldSpecs = tierSpecs(
				menu,
				state.tierId,
				state.interval as Interval,
			);
			// What each row held per cycle before: the old tier's allowance x the old quantity. A tier change that also changes
			// the quantity (new amount x new quantity against old amount x old quantity) is not checked against real Stripe data.
			const oldAmount = new Map(
				oldSpecs.map((s) => [s.rowId, s.amount * oldQuantity]),
			);
			const adds: { s: RowSpec; units: number }[] = [];
			const prorated = (diff: number) =>
				upgradeUnits({
					diff,
					policy,
					at,
					start: state.cycleStart,
					end: state.cycleEnd,
				});
			/** A row the plan keeps: the prorated difference of what it holds per cycle is added. */
			const keep = (s: RowSpec) => {
				const units = prorated(
					s.amount * newQuantity - (oldAmount.get(s.rowId) ?? 0),
				);
				if (units > 0) adds.push({ s, units });
				return units;
			};
			/**
			 * A row on its own interval (a yearly grant on a monthly plan) renews at its own reset date, which the invoice rules
			 * do not see (only removals read the subject's rows). Prorating its extra units over the plan's month would grant
			 * nearly a year's difference for one month's charge, so a raise grants nothing for it: its next refill is already at
			 * the new quantity.
			 */
			const keepSameTier = (s: RowSpec) =>
				s.interval === s.plan ? keep(s) : 0;
			if (sameTier) {
				for (const s of oldSpecs) if (s.rowId in state.rows) keepSameTier(s);
			} else
				moveTier({
					menu,
					state,
					to: { tierId, interval },
					ops,
					insert: (s) => {
						const units = prorated(s.amount * newQuantity);
						insertSpec(s, TIER_CP, units, newEnd, at, newQuantity);
					},
					revive: (s) => {
						if (s.interval === s.plan) {
							// the cycle's own row: what is left stays, the prorated difference is added
							ops.push({
								op: "update",
								table: "customerEntitlements",
								id: s.rowId,
								set: { next_reset_at: newEnd },
							});
							const units = prorated(s.amount * newQuantity);
							if (units > 0) adds.push({ s, units });
							return;
						}
						// a row on its own interval is refilled by a reset from now
						ops.push({
							op: "update",
							table: "customerEntitlements",
							id: s.rowId,
							set: { next_reset_at: at },
						});
						state.rows[s.rowId] = (state.rows[s.rowId] ?? 0) + 1;
						grantRow(
							s,
							s.amount * newQuantity,
							addUtcMonths(at, s.interval === "year" ? 12 : 1),
						);
						needReset = true;
					},
					units: keep,
				});
			if (newQuantity !== state.quantity) ops.push(tierQuantityOp(newQuantity));
			state.quantity = newQuantity;
			b.plan(now, ops.splice(0));
			for (const { s, units } of adds) {
				b.add(now, s.feature, s.rowId, units);
				grantRow(s, units, newEnd);
			}
			if (interval !== state.interval) {
				state.cycleStart = periodStart;
				state.cycleEnd = periodEnd;
			}
			state.tierId = tierId;
			state.interval = interval;
			if (needReset) b.reset(at + 1);
			needReset = false;
		}
	}
	// Add-ons bought mid-cycle. This runs whatever else the update invoice does: a member may raise the quantity and buy an
	// add-on at once, or buy one while an older proration pair is still pending on the subscription.
	if (live && state.tierId && invoice.reason === "subscription_update") {
		for (const l of lines.filter(
			(x) => x.kind === "addon" && x.addonId && x.interval && x.amount > 0,
		)) {
			if (!state.addonIds.includes(l.addonId as string))
				attachAddon(l, "prorate");
		}
	}

	// ---- one-time add-ons and gifts, on any invoice ----------------------------------------------------------
	if (state.identity === null && !created && credited.length > 0) {
		ops.push({
			op: "insert",
			table: "customer",
			row: customerRow(who.customerId),
		});
	}
	for (const l of credited) {
		const addon = addonOf(menu, l.addonId as string);
		// A session gift lives `giftSessionMonths` on the school's calendar; other one-time grants lapse by their own rollover months.
		const gift = giftOf(l) === "sessions";
		for (const g of addon.grants) {
			const rowId = `ce_${gift ? "gift" : "once"}_${invoice.id}_${addon.id}_${g.featureId}`;
			const units = g.amount * l.quantity;
			const expiresAt = gift
				? addZonedMonths(
						invoice.paidAt,
						policy.giftSessionMonths,
						menu.timeZone,
					)
				: g.rollover
					? addUtcMonths(invoice.paidAt, g.rollover.months)
					: null;
			ops.push(
				rowOp({
					rowId,
					cpId: null,
					entitlementId: gift
						? giftEntId(g.featureId)
						: onceEntId(addon.id, g.featureId),
					feature: g.featureId,
					customerId: who.customerId,
					balance: units,
					nextResetAt: null,
					expiresAt,
					t: now,
				}),
			);
			record.granted.push({
				invoiceId: invoice.id,
				rowId,
				feature: g.featureId,
				units,
				epoch: 1,
				rolloverExpiresAt: null,
			});
			state.rows[rowId] = 1;
		}
	}

	b.plan(now, ops);
	if (needReset) b.reset(resetAt);
	if (cycleRows) {
		// The engine steps a row's next reset a month on from the last one, so after a month-end it drifts from Stripe's
		// periods (Jan 31, Feb 28, then Mar 28, not Mar 31). Put each refilled row's next reset on Stripe's cycle end, so
		// rollover expiries, and the leftovers traced to an invoice, follow the cycle Stripe bills.
		const { rowIds, end } = cycleRows;
		b.plan(
			anchorAt,
			rowIds.map(
				(id): Op => ({
					op: "update",
					table: "customerEntitlements",
					id,
					set: { next_reset_at: end },
				}),
			),
		);
	}
	if (b.commands.length > 0 && state.identity === null) state.identity = who;
	state.invoices[invoice.id] = record;
	return { commands: b.commands, labels, state };
};

/**
 * Moves the subscription to another tier in the plan ops: the product changes, rows with the same feature and
 * interval keep their balance and point at the new entitlement, new rows are inserted, rows the new tier lacks
 * stop refilling (what is left stays). `units(spec)` is called for each kept row and `insert(spec)` for each new one.
 */
const moveTier = ({
	menu,
	state,
	to,
	ops,
	insert,
	revive,
	units,
}: {
	menu: Menu;
	state: GrantsState;
	to: { tierId: string; interval: Interval };
	ops: Op[];
	insert: (s: RowSpec) => void;
	/** A row the plan once moved off and now moves back onto: it still exists, so it is updated, not inserted. */
	revive: (s: RowSpec) => void;
	units: (s: RowSpec) => number;
}) => {
	const oldSpecs = tierSpecs(
		menu,
		state.tierId as string,
		state.interval as Interval,
	);
	const newSpecs = tierSpecs(menu, to.tierId, to.interval);
	ops.push({
		op: "update",
		table: "customerProducts",
		id: TIER_CP,
		set: {
			internal_product_id: internalProduct(
				tierProductId(to.tierId, to.interval),
			),
		},
	});
	const oldIds = new Set(oldSpecs.map((s) => s.rowId));
	for (const s of newSpecs) {
		if (oldIds.has(s.rowId)) {
			ops.push({
				op: "update",
				table: "customerEntitlements",
				id: s.rowId,
				set: { entitlement_id: s.entId },
			});
			units(s);
		} else if (s.rowId in state.retired) {
			state.rows[s.rowId] = state.retired[s.rowId] as number;
			delete state.retired[s.rowId];
			ops.push({
				op: "update",
				table: "customerEntitlements",
				id: s.rowId,
				set: { entitlement_id: s.entId },
			});
			revive(s);
		} else insert(s);
	}
	const newIds = new Set(newSpecs.map((s) => s.rowId));
	for (const s of oldSpecs) {
		if (!newIds.has(s.rowId)) {
			ops.push(stopRefill(s.rowId));
			state.retired[s.rowId] = state.rows[s.rowId] ?? 1;
			delete state.rows[s.rowId];
		}
	}
	state.tierId = to.tierId;
	state.interval = to.interval;
};

// ---------------------------------------------------------------------------------------------------------------
// Refund and dispute -> commands
// ---------------------------------------------------------------------------------------------------------------

/**
 * Takes one invoice's unused credits back, reading what the rows hold from the subject so no row goes below zero:
 * - credits still in the refill they were granted into come off the row (`increment`);
 * - credits of a refill that has since reset were carried over by the engine as a rollover that lapses at
 *   `rolloverExpiresAt`: that rollover is cut by what the invoice granted (delete, then insert what stays).
 * A row that already lapsed, or is not in the subject, gives nothing back.
 */
const removeInvoice = ({
	invoiceId,
	source,
	input,
}: {
	invoiceId: string | null;
	source: FactSource;
	input: RemovalInput;
}): GrantResult => {
	const labels = labelsOf(source, input);
	const record = invoiceId ? input.state.invoices[invoiceId] : undefined;
	if (!record || record.removed)
		return { commands: [], labels, state: input.state };
	const state = clone(input.state);
	// An invoice that granted nothing (a dollar gift, before any credit row) is marked all the same: handling the
	// event again later, once the subject exists, must not change anything.
	if (!state.identity) {
		(state.invoices[invoiceId as string] as InvoiceRecord).removed = true;
		return { commands: [], labels, state };
	}
	const b = new Builder(source, state.identity);
	const held = heldOf(input.subject);
	const cut = new Map<string, number>();
	const ops: Op[] = [];
	for (const g of record.granted) {
		const row = held.get(g.rowId);
		if (!row) continue;
		const refills = state.rows[g.rowId] ?? state.retired[g.rowId] ?? g.epoch;
		if (refills === g.epoch) {
			const alive = row.expiresAt === null || row.expiresAt > input.now;
			const units = alive ? Math.min(g.units, Math.max(0, row.balance)) : 0;
			if (units <= 0) continue;
			row.balance -= units;
			ops.push({
				op: "increment",
				table: "customerEntitlements",
				id: g.rowId,
				add: { balance: -units },
			});
			continue;
		}
		if (g.rolloverExpiresAt === null) continue;
		let left = g.units;
		for (const roll of row.rollovers) {
			if (left <= 0) break;
			if (roll.expiresAt !== g.rolloverExpiresAt) continue;
			if (roll.expiresAt <= input.now) continue;
			const units = Math.min(
				left,
				Math.max(0, roll.balance - (cut.get(roll.id) ?? 0)),
			);
			if (units <= 0) continue;
			cut.set(roll.id, (cut.get(roll.id) ?? 0) + units);
			left -= units;
		}
	}
	for (const row of held.values()) {
		for (const roll of row.rollovers) {
			const units = cut.get(roll.id);
			if (units === undefined) continue;
			ops.push({ op: "delete", table: "rollovers", id: roll.id });
			if (roll.balance - units > 0)
				ops.push({
					op: "insert",
					table: "rollovers",
					row: {
						...roll.row,
						id: `roll_cut_${roll.id}`,
						balance: roll.balance - units,
					},
				});
		}
	}
	b.plan(input.now, ops);
	(state.invoices[invoiceId as string] as InvoiceRecord).removed = true;
	return { commands: b.commands, labels, state };
};

/**
 * A canceled subscription ends the refills and lets the last cycle's unused credits live out their own life: each
 * tier and recurring add-on row stops resetting and expires where its unused credits would have lapsed had the
 * subscription gone on (the end of the cycle that paid for them plus the row's rollover months), not now. Credits
 * already used are untouched; credits rolled over earlier keep their own expiry. Any status but `canceled`, another
 * subscription, or a second end gives no commands.
 */
export const subscriptionEndedToCommands = (
	input: SubscriptionEndInput,
): GrantResult => {
	const { subscription: fact, menu, state: prior, now } = input;
	const labels = labelsOf(fact.source, input);
	const none = { commands: [], labels, state: prior };
	if (
		fact.status !== "canceled" ||
		prior.identity === null ||
		prior.tierId === null ||
		prior.interval === null ||
		prior.subscriptionId !== fact.id ||
		prior.endedAt !== null
	)
		return none;
	const state = clone(prior);
	state.endedAt = fact.at;
	const held = heldOf(input.subject);
	const ops: Op[] = [];
	const specs = [
		...tierSpecs(menu, prior.tierId, prior.interval),
		...prior.addonIds.flatMap((id) => addonSpecs(menu, id)),
	];
	for (const s of specs) {
		const row = held.get(s.rowId);
		if (!row || !(s.rowId in state.rows)) continue;
		const boundary = row.nextResetAt ?? prior.cycleEnd ?? fact.at;
		ops.push({
			op: "update",
			table: "customerEntitlements",
			id: s.rowId,
			set: {
				next_reset_at: null,
				expires_at: rolloverExpiry(s.rollover, boundary) ?? boundary,
			},
		});
	}
	// Rows the plan had moved off keep what they hold, but not for ever: they lapse as their old tier's rollover would.
	const everySpec = [
		...menu.tiers.flatMap((t) =>
			t.prices.flatMap((p) => tierSpecs(menu, t.id, p.interval)),
		),
		...menu.addons.flatMap((a) => addonSpecs(menu, a.id)),
	];
	for (const rowId of Object.keys(prior.retired)) {
		const row = held.get(rowId);
		if (!row || row.expiresAt !== null) continue;
		const rollover = everySpec.find((s) => s.rowId === rowId)?.rollover;
		const boundary = prior.cycleEnd ?? fact.at;
		ops.push({
			op: "update",
			table: "customerEntitlements",
			id: rowId,
			set: { expires_at: rolloverExpiry(rollover, boundary) ?? boundary },
		});
	}
	const b = new Builder(fact.source, prior.identity);
	b.plan(now, ops);
	return { commands: b.commands, labels, state };
};

/** Who a subscription's credits belong to, from the checkout metadata it carries; null when it names neither school nor family. */
export const subscriptionHolder = (
	fact: SubscriptionFact,
): { orgId: string; customerId: string } | null => {
	const orgId = fact.metadata.b4u_school;
	const family = fact.metadata.family_id;
	return orgId && family ? { orgId, customerId: `family:${family}` } : null;
};

/**
 * A `customer.subscription.*` event. Records what Stripe says the membership is (status via `subscriptionStatus`, the
 * tier, interval and quantity the menu names for its tier item, renewal or end date) in `state.membership`; a canceled subscription
 * also lets its credits lapse (`subscriptionEndedToCommands`). Nothing is granted here: credits come from paid invoices,
 * so `state.tierId`, `state.interval` and `state.quantity` stay where the invoices put them (a quantity change alone
 * updates only `membership.quantity`). An event about another subscription than the
 * holder's, or older than the one on record, changes nothing; replaying one changes nothing.
 */
export const subscriptionToCommands = (
	input: SubscriptionEndInput,
): GrantResult => {
	const { subscription: fact, plan } = input;
	const prior = input.state;
	const current = prior.membership;
	const shown = subscriptionStatus(fact);
	// The membership follows the holder's own subscription: an event about another one (an older subscription that
	// ended late, say) says nothing about it.
	if (prior.subscriptionId !== null && fact.id !== prior.subscriptionId)
		return unchanged(input);
	// An event that does not supersede the membership on record changes nothing, a canceled one included: it must
	// neither end the subscription nor lapse its credits.
	if (current && !supersedes(current, fact.id, fact.at, shown.status))
		return unchanged(input);
	const ended = subscriptionEndedToCommands(input);
	// A canceled subscription's price may have left the menu since: the tier on record (the membership's, else the
	// one its invoices put in the plan) stays.
	const keepTier = fact.status === "canceled";
	const recorded =
		current?.subscriptionId === fact.id
			? {
					tierId: current.tierId,
					interval: current.interval,
					quantity: current.quantity ?? 1,
				}
			: {
					tierId: prior.tierId,
					interval: prior.interval,
					quantity: prior.quantity ?? 1,
				};
	const membership: MembershipRecord = {
		subscriptionId: fact.id,
		status: shown.status,
		tierId: plan?.tierId ?? (keepTier ? recorded.tierId : null),
		interval: plan?.interval ?? (keepTier ? recorded.interval : null),
		quantity: plan?.quantity ?? (keepTier ? recorded.quantity : 1),
		renewsAt: shown.renewsAt,
		cancelAtPeriodEnd: shown.cancelAtPeriodEnd,
		endsAt: shown.endsAt,
		at: fact.at,
	};
	if (sameMembership(current, membership)) return ended;
	return { ...ended, state: { ...ended.state, membership } };
};

/** Field by field, so key order in a stored row (a legacy one gets `quantity` last) never counts as a change. */
const sameMembership = (
	a: MembershipRecord | null,
	b: MembershipRecord,
): boolean =>
	a !== null &&
	a.subscriptionId === b.subscriptionId &&
	a.status === b.status &&
	a.tierId === b.tierId &&
	a.interval === b.interval &&
	a.quantity === b.quantity &&
	a.renewsAt === b.renewsAt &&
	a.cancelAtPeriodEnd === b.cancelAtPeriodEnd &&
	a.endsAt === b.endsAt &&
	a.at === b.at;

const unchanged = (input: SubscriptionEndInput): GrantResult => ({
	commands: [],
	labels: labelsOf(input.subscription.source, input),
	state: input.state,
});

/** How final a membership status is: an ended one is not undone by a status Stripe sent in the same second. */
const STATUS_RANK: Record<MembershipRecord["status"], number> = {
	ended: 2,
	active: 1,
	past_due: 1,
	inactive: 1,
	incomplete: 0,
};

/**
 * Whether an event (its subscription, second and shown status) replaces the membership on record. Older never does.
 * Another subscription's event replaces it from the same second on. For the same subscription, events of one second
 * come in any order, so one does not replace a more final status.
 */
const supersedes = (
	current: MembershipRecord,
	subscriptionId: string,
	at: number,
	status: MembershipRecord["status"],
): boolean => {
	if (at < current.at) return false;
	if (at > current.at || current.subscriptionId !== subscriptionId) return true;
	return STATUS_RANK[status] >= STATUS_RANK[current.status];
};

/** A full refund (policy.removeOnFullRefund) takes back that invoice's unused credits; a partial refund changes nothing. */
export const refundToCommands = (
	input: RemovalInput & { refund: BillingRefund },
): GrantResult => {
	const { refund, policy } = input;
	if (!refund.full || !policy.removeOnFullRefund)
		return {
			commands: [],
			labels: labelsOf(refund.source, input),
			state: input.state,
		};
	return removeInvoice({
		invoiceId: refund.invoiceId ?? null,
		source: refund.source,
		input,
	});
};

/** A lost dispute (policy.removeOnLostDispute) is a full refund; open and won disputes change nothing. */
export const disputeToCommands = (
	input: RemovalInput & { dispute: BillingDispute },
): GrantResult => {
	const { dispute, policy } = input;
	if (dispute.status !== "lost" || !policy.removeOnLostDispute)
		return {
			commands: [],
			labels: labelsOf(dispute.source, input),
			state: input.state,
		};
	return removeInvoice({
		invoiceId: dispute.invoiceId ?? null,
		source: dispute.source,
		input,
	});
};

export type {
	GrantCommand,
	GrantLabels,
	GrantResult,
	GrantedRow,
	GrantsState,
	InvoiceRecord,
};
