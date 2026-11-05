/**
 * Menu → Stripe. Pure: no I/O, no clock. `menuToStripe` says which Stripe objects must exist for a menu (as a diff
 * against the menu last published), `checkoutParams` builds the Checkout Session for one purchase. The family service
 * only runs the steps.
 *
 * Rules (tiers spec, "Default billing rules"):
 * - Only public tiers are published: a tier that is not public is a draft and is never sold. Dropping a tier (or
 *   making it non-public) archives its prices and product; existing subscribers keep theirs.
 * - An item without a usable price (no price, or a non-positive or fractional amount) is never published.
 * - The member code is a coupon limited to the tier products, never add-ons.
 * - Stripe bills one interval per subscription: a subscription carries one-time add-ons, and recurring add-ons only
 *   on a plan of the same interval.
 * - Prices are immutable: a changed amount, interval or currency is a new price (new lookup key) and the old one is archived.
 * - A tier sold in `quantities` has per-unit prices: the count is the Checkout line's quantity, never part of a price or
 *   lookup key, so changing a tier's `quantities` publishes nothing.
 */
import { createHash } from "node:crypto";
import { quantitiesOf } from "./menu.js";
import type {
	AddonEvery,
	BillingPolicy,
	CheckoutInput,
	CheckoutParams,
	CheckoutParamsWithPrices,
	CheckoutRefusal,
	CheckoutResult,
	GiftKind,
	Interval,
	LineItem,
	Menu,
	MenuToStripeInput,
	OneTimeCheckoutInput,
	OneTimeCheckoutParams,
	OneTimeCheckoutParamsWithPrices,
	OneTimeCheckoutResult,
	PortalConfigIds,
	StripeOp,
} from "./types.js";

type Wanted = {
	key: string;
	name: string;
	description?: string;
	metadata: Record<string, string>;
	prices: {
		priceKey: string;
		lookupKey: string;
		amount: number;
		every: AddonEvery;
		gift?: GiftKind;
	}[];
};

const usable = (amount: unknown): amount is number =>
	typeof amount === "number" && Number.isInteger(amount) && amount > 0;

/** A price's lookup key names the school, the item, the interval, the amount and the currency: a changed amount is a new price, an unchanged one is found again. */
export const lookupKeyOf = (
	schoolId: string,
	priceKey: string,
	amount: number,
	currency: string,
): string =>
	`b4u_${schoolId.slice(0, 8)}_${priceKey.replace(/:/g, "_")}_${amount}_${currency}`;

/** `t:<tierId>:<interval>` or `a:<addonId>:<every>`: the menu's name for a price, before the amount and currency are added. */
export const tierPriceKey = (tierId: string, interval: Interval): string =>
	`t:${tierId}:${interval}`;
/** A gift add-on's key names the gift kind: flipping the flag is a new price (prices are immutable), not a stale one. */
export const addonPriceKey = (
	addonId: string,
	every: AddonEvery,
	gift?: GiftKind,
): string => `a:${addonId}:${every}${gift ? `:gift-${gift}` : ""}`;

/** What the menu asks Stripe to hold, in menu order: a product per public tier and per add-on that has a usable price. */
function wantedOf(schoolId: string, menu: Menu): Wanted[] {
	const out: Wanted[] = [];
	for (const t of menu.tiers) {
		if (!t.public) continue;
		const prices = t.prices
			.filter((p) => usable(p.amount))
			.map((p) => {
				const priceKey = tierPriceKey(t.id, p.interval);
				return {
					priceKey,
					lookupKey: lookupKeyOf(schoolId, priceKey, p.amount, menu.currency),
					amount: p.amount,
					every: p.interval,
				};
			});
		if (prices.length === 0) continue;
		out.push({
			key: `t:${t.id}`,
			name: t.name,
			...(t.blurb ? { description: t.blurb } : {}),
			metadata: {
				b4u_school: schoolId,
				b4u_key: `t:${t.id}`,
				b4u_group: "membership",
				b4u_tier: t.id,
			},
			prices,
		});
	}
	for (const a of menu.addons) {
		if (!usable(a.price.amount)) continue;
		const priceKey = addonPriceKey(a.id, a.price.every, a.gift);
		out.push({
			key: `a:${a.id}`,
			name: a.name,
			description: a.name,
			metadata: {
				b4u_school: schoolId,
				b4u_key: `a:${a.id}`,
				b4u_group: "addon",
				b4u_addon: a.id,
			},
			prices: [
				{
					priceKey,
					lookupKey: lookupKeyOf(
						schoolId,
						priceKey,
						a.price.amount,
						menu.currency,
					),
					amount: a.price.amount,
					every: a.price.every,
					...(a.gift ? { gift: a.gift } : {}),
				},
			],
		});
	}
	return out;
}

/**
 * The menu's items by Stripe lookup key (and by price id for each key in `priceIds`), for `resolveInvoice`. Every tier
 * with a usable price is here, public or not: a tier dropped from sale still renews for the families that hold it.
 */
export function menuLineItems(
	schoolId: string,
	menu: Menu,
	priceIds: Readonly<Record<string, string>> = {},
): Map<string, LineItem> {
	const out = new Map<string, LineItem>();
	const add = (lookupKey: string, item: LineItem) => {
		const known = { ...item, lookupKey };
		out.set(lookupKey, known);
		const priceId = priceIds[lookupKey];
		if (priceId) out.set(priceId, known);
	};
	for (const t of menu.tiers)
		for (const p of t.prices)
			if (usable(p.amount))
				add(
					lookupKeyOf(
						schoolId,
						tierPriceKey(t.id, p.interval),
						p.amount,
						menu.currency,
					),
					{ kind: "tier", tierId: t.id, interval: p.interval },
				);
	for (const a of menu.addons)
		if (usable(a.price.amount))
			add(
				lookupKeyOf(
					schoolId,
					addonPriceKey(a.id, a.price.every, a.gift),
					a.price.amount,
					menu.currency,
				),
				{
					kind: "addon",
					addonId: a.id,
					interval: a.price.every === "once" ? null : a.price.every,
					...(a.gift ? { gift: a.gift } : {}),
				},
			);
	return out;
}

const desc = (w: Wanted): { description?: string } =>
	w.description ? { description: w.description } : {};

const digest = (s: string, n: number): string =>
	createHash("sha256").update(s).digest("hex").slice(0, n);

type WithoutKey<T> = T extends unknown ? Omit<T, "idempotencyKey"> : never;
const stamp = (schoolId: string, op: WithoutKey<StripeOp>): StripeOp =>
	({
		...op,
		idempotencyKey: `atm:${schoolId}:${op.op}:${digest(JSON.stringify(op), 24)}`,
	}) as StripeOp;

/** The member discount a policy asks for, as Stripe objects: one coupon on the tier products, one code for it. Null when there is no code or no tier product. */
function memberPlan(schoolId: string, menu: Menu, policy: BillingPolicy) {
	const mc = policy.memberCode;
	if (!mc) return null;
	const appliesToProductKeys = wantedOf(schoolId, menu)
		.filter((w) => w.key.startsWith("t:"))
		.map((w) => w.key)
		.sort();
	if (appliesToProductKeys.length === 0) return null;
	// The coupon's product list cannot change in Stripe, so the id names it: another list, another coupon.
	const id = `b4u_${schoolId.slice(0, 8)}_member_${mc.percentOff}_${digest(appliesToProductKeys.join(","), 8)}`;
	return { id, percentOff: mc.percentOff, appliesToProductKeys, code: mc.code };
}

/**
 * The steps that make Stripe match `menu`, given that it matches `previous`: creates first, then archives, then the
 * member code. Publishing the same menu again gives `[]`. Product and price creates are find-or-create by
 * `b4u_key` and `lookupKey`; every op carries a deterministic idempotency key.
 */
export function menuToStripe(input: MenuToStripeInput): StripeOp[] {
	const { schoolId, menu, previous, policy } = input;
	const want = wantedOf(schoolId, menu);
	const had = previous ? wantedOf(schoolId, previous) : [];
	const hadProduct = new Map(had.map((w) => [w.key, w]));
	const wantProduct = new Map(want.map((w) => [w.key, w]));
	const hadLookups = new Set(
		had.flatMap((w) => w.prices.map((p) => p.lookupKey)),
	);
	const wantLookups = new Set(
		want.flatMap((w) => w.prices.map((p) => p.lookupKey)),
	);
	const ops: StripeOp[] = [];

	for (const w of want) {
		const old = hadProduct.get(w.key);
		if (!old)
			ops.push(
				stamp(schoolId, {
					op: "product.create",
					key: w.key,
					name: w.name,
					...desc(w),
					metadata: w.metadata,
				}),
			);
		else if (old.name !== w.name || old.description !== w.description)
			ops.push(
				stamp(schoolId, {
					op: "product.update",
					key: w.key,
					name: w.name,
					...desc(w),
					active: true,
				}),
			);
	}
	for (const w of want)
		for (const p of w.prices) {
			if (hadLookups.has(p.lookupKey)) continue;
			ops.push(
				stamp(schoolId, {
					op: "price.create",
					productKey: w.key,
					lookupKey: p.lookupKey,
					currency: menu.currency,
					unitAmount: p.amount,
					recurring: p.every === "once" ? null : { interval: p.every },
					metadata: {
						b4u_school: schoolId,
						b4u_key: p.priceKey,
						...(p.gift ? { b4u_gift: p.gift } : {}),
					},
				}),
			);
		}
	for (const w of had)
		for (const p of w.prices)
			if (!wantLookups.has(p.lookupKey))
				ops.push(
					stamp(schoolId, { op: "price.archive", lookupKey: p.lookupKey }),
				);
	for (const w of had)
		if (!wantProduct.has(w.key))
			ops.push(
				stamp(schoolId, {
					op: "product.update",
					key: w.key,
					name: w.name,
					...desc(w),
					active: false,
				}),
			);

	const now = memberPlan(schoolId, menu, policy);
	const before = previous
		? memberPlan(schoolId, previous, input.previousPolicy ?? policy)
		: null;
	if (JSON.stringify(now) !== JSON.stringify(before)) {
		// Old code and coupon go first, so no old code stays live and a code name is free to move to a new coupon.
		if (before && (before.code !== now?.code || before.id !== now?.id))
			ops.push(
				stamp(schoolId, { op: "promotion_code.deactivate", code: before.code }),
			);
		if (before && before.id !== now?.id)
			ops.push(stamp(schoolId, { op: "coupon.archive", id: before.id }));
		if (now) {
			if (now.id !== before?.id)
				ops.push(
					stamp(schoolId, {
						op: "coupon.ensure",
						id: now.id,
						percentOff: now.percentOff,
						appliesToProductKeys: now.appliesToProductKeys,
					}),
				);
			ops.push(
				stamp(schoolId, {
					op: "promotion_code.ensure",
					code: now.code,
					couponId: now.id,
					firstTimeOnly: true,
				}),
			);
		}
	}
	return ops;
}

// ---- Checkout ----

/**
 * The Checkout Session for a tier and interval plus add-ons, or why not. `tier_not_found` covers a missing tier, a tier
 * that is not public, and an interval the tier has no usable price for. `quantity_not_offered`: the quantity is not one
 * of the tier's `quantities` (not 1, for a tier without them). The tier's line is at the quantity bought (its price is
 * per unit, so the member code's percentage applies to each unit alike); add-ons are one each.
 */
export function checkoutParams(input: CheckoutInput): CheckoutResult {
	const { schoolId, menu, tierId, interval, policy } = input;
	const tier = menu.tiers.find((t) => t.id === tierId);
	const price = tier?.prices.find((p) => p.interval === interval);
	if (!tier || !tier.public || !price || !usable(price.amount))
		return { ok: false, reason: "tier_not_found" };
	const quantity = input.quantity ?? 1;
	if (!quantitiesOf(tier).includes(quantity))
		return { ok: false, reason: "quantity_not_offered", quantity };

	const tierLine = {
		lookupKey: lookupKeyOf(
			schoolId,
			tierPriceKey(tier.id, interval),
			price.amount,
			menu.currency,
		),
		quantity,
	};
	const lines: string[] = [];
	const addonIds = [...new Set(input.addonIds ?? [])];
	for (const id of addonIds) {
		const a = menu.addons.find((x) => x.id === id);
		if (!a || !usable(a.price.amount))
			return { ok: false, reason: "addon_not_found", addonId: id };
		if (a.price.every !== "once" && a.price.every !== interval)
			return { ok: false, reason: "addon_interval_mismatch", addonId: id };
		lines.push(
			lookupKeyOf(
				schoolId,
				addonPriceKey(a.id, a.price.every, a.gift),
				a.price.amount,
				menu.currency,
			),
		);
	}
	const metadata: Record<string, string> = {
		b4u_school: schoolId,
		family_id: input.familyId,
		tier_id: tier.id,
		interval,
		menu_version: String(input.menuVersion),
		...(input.forProfileId ? { profile_id: input.forProfileId } : {}),
		...(addonIds.length ? { addon_ids: addonIds.join(",") } : {}),
	};
	return {
		ok: true,
		params: {
			mode: "subscription",
			client_reference_id: input.familyId,
			success_url: input.returnUrls.success,
			cancel_url: input.returnUrls.cancel,
			line_items: [
				tierLine,
				...lines.map((lookupKey) => ({ lookupKey, quantity: 1 as const })),
			],
			metadata,
			// `quantity` on the subscription is informational, and left out at the default of 1: the tier item's quantity at
			// Stripe is the truth (the billing portal can change it, and this metadata then goes stale).
			subscription_data: {
				metadata:
					quantity === 1
						? { ...metadata }
						: { ...metadata, quantity: String(quantity) },
			},
			...(policy.memberCode ? { allow_promotion_codes: true as const } : {}),
		},
	};
}

/**
 * The payment-mode Checkout Session for add-ons priced `once` with no membership (a gift certificate, a pack), or why
 * not. Stripe makes no invoice for a payment-mode session unless `invoice_creation[enabled]=true`, and atm grants credits
 * only from a paid invoice (a `manual` one, with no subscription), so this always turns it on. The invoice's own
 * `metadata` carries `b4u_school` and `family_id` (the session's metadata does not reach the invoice), which is how
 * `handleStripeEvent` finds the family. Stripe prices post-payment invoices for Checkout apart from Invoicing.
 * `addon_not_one_time`: the add-on repeats (`month` or `year`), so it belongs on a membership's checkout. Add-ons are one
 * each; repeats are dropped.
 */
export function oneTimeCheckoutParams(
	input: OneTimeCheckoutInput,
): OneTimeCheckoutResult {
	const { schoolId, menu } = input;
	const addonIds = [...new Set(input.addonIds)];
	if (addonIds.length === 0) return { ok: false, reason: "no_addons" };
	const lookupKeys: string[] = [];
	for (const id of addonIds) {
		const addon = menu.addons.find((candidate) => candidate.id === id);
		if (!addon || !usable(addon.price.amount))
			return { ok: false, reason: "addon_not_found", addonId: id };
		if (addon.price.every !== "once")
			return { ok: false, reason: "addon_not_one_time", addonId: id };
		lookupKeys.push(
			lookupKeyOf(
				schoolId,
				addonPriceKey(addon.id, addon.price.every, addon.gift),
				addon.price.amount,
				menu.currency,
			),
		);
	}
	const metadata: Record<string, string> = {
		b4u_school: schoolId,
		family_id: input.familyId,
		menu_version: String(input.menuVersion),
		addon_ids: addonIds.join(","),
		...(input.forProfileId ? { profile_id: input.forProfileId } : {}),
	};
	return {
		ok: true,
		params: {
			mode: "payment",
			client_reference_id: input.familyId,
			success_url: input.returnUrls.success,
			cancel_url: input.returnUrls.cancel,
			line_items: lookupKeys.map((lookupKey) => ({
				lookupKey,
				quantity: 1 as const,
			})),
			metadata,
			invoice_creation: {
				enabled: true,
				invoice_data: {
					metadata: { ...metadata },
					...(input.invoice?.description
						? { description: input.invoice.description }
						: {}),
					...(input.invoice?.footer ? { footer: input.invoice.footer } : {}),
				},
			},
		},
	};
}

/** `params` with each line's lookup key swapped for its Stripe price id, quantities kept; null when a price id is missing (not published yet). */
export function withPriceIds(
	params: CheckoutParams,
	priceIds: Readonly<Record<string, string>>,
): CheckoutParamsWithPrices | null;
export function withPriceIds(
	params: OneTimeCheckoutParams,
	priceIds: Readonly<Record<string, string>>,
): OneTimeCheckoutParamsWithPrices | null;
export function withPriceIds(
	params: CheckoutParams | OneTimeCheckoutParams,
	priceIds: Readonly<Record<string, string>>,
): CheckoutParamsWithPrices | OneTimeCheckoutParamsWithPrices | null {
	if (params.mode === "payment") {
		const items: { price: string; quantity: 1 }[] = [];
		for (const line of params.line_items) {
			const price = priceIds[line.lookupKey];
			if (!price) return null;
			items.push({ price, quantity: line.quantity });
		}
		return { ...params, line_items: items };
	}
	const [tierLine, ...addonLines] = params.line_items;
	const tierPrice = priceIds[tierLine.lookupKey];
	if (!tierPrice) return null;
	const addonItems: { price: string; quantity: 1 }[] = [];
	for (const line of addonLines) {
		const price = priceIds[line.lookupKey];
		if (!price) return null;
		addonItems.push({ price, quantity: line.quantity });
	}
	return {
		...params,
		line_items: [
			{ price: tierPrice, quantity: tierLine.quantity },
			...addonItems,
		],
	};
}

// ---- Billing portal ----

/**
 * The billing portal configuration for a menu with tiers sold in quantities, as form fields for
 * `POST /v1/billing_portal/configurations` (Stripe API `2025-10-29.clover`). Only the quantity of those tiers' prices can
 * change (a tier switch is not offered), between the tier's smallest and largest count. A raise is billed at once
 * (`always_invoice`), so its paid `subscription_update` invoice grants the extra units now; a decrease is scheduled for
 * the renewal (`decreasing_item_amount`) and grants nothing. Cancel stays at the period end; the payment method and the
 * invoice history are open.
 *
 * A tier is included when it is public, lists more than one count, has its product in `ids.products` and at least one of
 * its prices in `ids.prices` (Stripe requires `prices` on every product); a tier price missing from `ids.prices` is left
 * out of that tier's `prices`. Null when no tier qualifies. Stripe takes the quantity as a range, so a tier sold in
 * `[1, 2, 4]` also lets a member pick 3 in the portal. The configuration is marked `metadata[b4u_key]=portal`.
 */
export function portalConfigOf(
	menu: Menu,
	ids: PortalConfigIds,
): Record<string, string> | null {
	const products = [];
	for (const tier of menu.tiers) {
		const counts = quantitiesOf(tier);
		const product = ids.products[`t:${tier.id}`];
		if (!tier.public || counts.length < 2 || !product) continue;
		const prices = tier.prices.flatMap((price) => {
			const priceId = ids.prices[tierPriceKey(tier.id, price.interval)];
			return priceId ? [priceId] : [];
		});
		// Stripe requires `prices` on every product of a subscription update.
		if (prices.length === 0) continue;
		products.push({
			product,
			prices,
			adjustable_quantity: {
				enabled: true,
				minimum: Math.min(...counts),
				maximum: Math.max(...counts),
			},
		});
	}
	if (products.length === 0) return null;
	return toStripeForm({
		features: {
			invoice_history: { enabled: true },
			payment_method_update: { enabled: true },
			subscription_cancel: { enabled: true, mode: "at_period_end" },
			subscription_update: {
				enabled: true,
				default_allowed_updates: ["quantity"],
				proration_behavior: "always_invoice",
				schedule_at_period_end: {
					conditions: [{ type: "decreasing_item_amount" }],
				},
				products,
			},
		},
		metadata: { b4u_key: "portal" },
	});
}

/** Flattens nested params to Stripe's form encoding (`line_items[0][price]`, `metadata[k]`). Booleans and numbers become strings. */
export function toStripeForm(
	params: Record<string, unknown>,
): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (prefix: string, v: unknown) => {
		if (v === undefined || v === null) return;
		if (Array.isArray(v))
			v.forEach((x, i) => {
				walk(`${prefix}[${i}]`, x);
			});
		else if (typeof v === "object")
			for (const [k, x] of Object.entries(v)) walk(`${prefix}[${k}]`, x);
		else out[prefix] = String(v);
	};
	for (const [k, v] of Object.entries(params)) {
		if (typeof v === "object" && v !== null) walk(k, v);
		else if (v !== undefined && v !== null) out[k] = String(v);
	}
	return out;
}

export type {
	CheckoutInput,
	CheckoutParams,
	CheckoutRefusal,
	CheckoutResult,
	MenuToStripeInput,
	OneTimeCheckoutInput,
	OneTimeCheckoutParams,
	OneTimeCheckoutResult,
};
