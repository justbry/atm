/**
 * What a bookable item costs and the commands that hold, spend and release its credits. Pure: nothing is read from the clock
 * or written; every call takes the subject's rows and the time. The signatures are fixed in `ROADMAP.md` ("0.8.0 design")
 * and `types.ts`.
 *
 * This file is the pricing half (`validateBilling`, `quoteBooking`); the commands that run on stored rows live in
 * `booking-commands.ts` and are exported from here so callers have one module.
 */

import { MAX_LINE_TOTAL } from "./menu.js";
import type {
	Billing,
	BillingValidation,
	BookingCost,
	BookingQuote,
	BookingRefusal,
	GrantsState,
	Menu,
	QuoteInput,
} from "./types.js";

export {
	cancelBooking,
	confirmBooking,
	expiredHolds,
	holdBooking,
	noShowBooking,
	releaseBooking,
	settleExpiredHold,
} from "./booking-commands.js";

// ---- validateBilling ----

type Problem = { path: string; message: string; currency?: true };

const KEYS_BY_KIND = {
	free: ["kind"],
	included: ["kind", "featureId", "credits", "tierIds"],
	price: ["kind", "amount", "currency"],
	included_or_price: [
		"kind",
		"featureId",
		"credits",
		"tierIds",
		"amount",
		"currency",
	],
} as const;

type Kind = keyof typeof KEYS_BY_KIND;
const isKind = (value: unknown): value is Kind =>
	typeof value === "string" && Object.hasOwn(KEYS_BY_KIND, value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const featureProblems = (
	input: Record<string, unknown>,
	menu: Menu,
): Problem[] => {
	const { featureId } = input;
	if (typeof featureId !== "string" || featureId === "")
		return [{ path: "featureId", message: "featureId must be a feature id" }];
	if (!menu.features.some((feature) => feature.id === featureId))
		return [
			{
				path: "featureId",
				message: `featureId ${JSON.stringify(featureId)} is not a feature of the menu`,
			},
		];
	return [];
};

const creditsProblems = (input: Record<string, unknown>): Problem[] =>
	Number.isSafeInteger(input.credits) && (input.credits as number) >= 1
		? []
		: [
				{
					path: "credits",
					message: "credits must be a whole number of 1 or more",
				},
			];

const tierIdsProblems = (
	input: Record<string, unknown>,
	menu: Menu,
): Problem[] => {
	if (input.tierIds === undefined) return [];
	const { tierIds } = input;
	if (!Array.isArray(tierIds) || tierIds.length === 0)
		return [
			{
				path: "tierIds",
				message:
					"tierIds must be a list of one or more tier ids (leave it out for every tier)",
			},
		];
	const problems: Problem[] = [];
	const seen = new Set<unknown>();
	for (const [index, tierId] of tierIds.entries()) {
		const path = `tierIds.${index}`;
		if (typeof tierId !== "string" || !menu.tiers.some((t) => t.id === tierId))
			problems.push({
				path,
				message: `${path} ${JSON.stringify(tierId)} is not a tier of the menu`,
			});
		else if (seen.has(tierId))
			problems.push({ path, message: `${path} repeats tier ${tierId}` });
		seen.add(tierId);
	}
	return problems;
};

const priceProblems = (
	input: Record<string, unknown>,
	menu: Menu,
): Problem[] => {
	const problems: Problem[] = [];
	const { amount, currency } = input;
	if (
		!Number.isSafeInteger(amount) ||
		(amount as number) <= 0 ||
		(amount as number) > MAX_LINE_TOTAL
	)
		problems.push({
			path: "amount",
			message: `amount must be a whole number of cents above 0 and at most ${MAX_LINE_TOTAL}`,
		});
	if (currency !== menu.currency)
		problems.push({
			path: "currency",
			message: `currency must be the menu's (${menu.currency}), got ${JSON.stringify(currency)}`,
			currency: true,
		});
	return problems;
};

const billingProblems = (input: unknown, menu: Menu): Problem[] => {
	if (!isRecord(input))
		return [{ path: "billing", message: "billing must be an object" }];
	if (!isKind(input.kind))
		return [
			{
				path: "kind",
				message: `kind must be one of ${Object.keys(KEYS_BY_KIND).join(", ")}`,
			},
		];
	const { kind } = input;
	const allowed: readonly string[] = KEYS_BY_KIND[kind];
	const problems: Problem[] = Object.keys(input)
		.filter((key) => !allowed.includes(key))
		.map((key) => ({
			path: key,
			message: `${key} is not a field of a ${kind} billing`,
		}));
	if (kind === "included" || kind === "included_or_price")
		problems.push(
			...featureProblems(input, menu),
			...creditsProblems(input),
			...tierIdsProblems(input, menu),
		);
	if (kind === "price" || kind === "included_or_price")
		problems.push(...priceProblems(input, menu));
	return problems;
};

/** A clean copy of a billing that passed `billingProblems`: only its own fields. */
const copyBilling = (input: Record<string, unknown>): Billing => {
	const kind = input.kind as Kind;
	const picked = Object.fromEntries(
		KEYS_BY_KIND[kind]
			.filter((key) => input[key] !== undefined)
			.map((key) => [
				key,
				key === "tierIds" ? [...(input.tierIds as string[])] : input[key],
			]),
	);
	return picked as Billing;
};

/** Checks an unknown value as a `Billing` against the menu: the feature exists, credits are a whole number of 1 or more, the amount is a whole number of cents above 0, the currency is the menu's, every tier id exists. */
export const validateBilling = (
	input: unknown,
	menu: Menu,
): BillingValidation => {
	const problems = billingProblems(input, menu);
	if (problems.length > 0)
		return {
			ok: false,
			problems: [...new Set(problems.map((p) => p.path))],
			messages: problems.map((p) => p.message),
		};
	return { ok: true, billing: copyBilling(input as Record<string, unknown>) };
};

// ---- quoteBooking ----

const refusal = (
	reason: BookingRefusal["reason"],
	message: string,
): BookingRefusal => ({ ok: false, reason, message });

const planHasFeature = ({
	grants,
	menu,
	tierId,
	featureId,
}: {
	grants: GrantsState;
	menu: Menu;
	tierId: string | null;
	featureId: string;
}): boolean => {
	const grantsFeature = (list: readonly { featureId: string }[]) =>
		list.some((grant) => grant.featureId === featureId);
	const tier = tierId ? menu.tiers.find((t) => t.id === tierId) : undefined;
	if (tier && grantsFeature(tier.grants)) return true;
	for (const addonId of grants.addonIds) {
		const addon = menu.addons.find((a) => a.id === addonId);
		if (addon && grantsFeature(addon.grants)) return true;
	}
	// A pack, a session gift or a gift code the holder was given: rows of the feature that no tier or recurring add-on made.
	const given = Object.values(grants.invoices).some(
		(record) =>
			!record.removed &&
			record.granted.some((granted) => granted.feature === featureId),
	);
	if (given) return true;
	return Object.values(grants.redeemed ?? {}).some(
		(code) => code.feature === featureId,
	);
};

/** Why this holder cannot have the item's credits, or null when they can. */
const creditRefusal = ({
	billing,
	input,
}: {
	billing: Extract<Billing, { kind: "included" | "included_or_price" }>;
	input: QuoteInput;
}): BookingRefusal | null => {
	const { grants, menu, now, available } = input;
	const tierId = input.tierId === undefined ? grants.tierId : input.tierId;
	if (tierId === null && grants.identity === null && grants.holder === null)
		return refusal("not_a_member", "the holder has no credits or membership");
	const endsAt = grants.membership?.endsAt ?? grants.endedAt;
	const lapsed = endsAt !== null && endsAt <= now;
	if ((grants.membership && grants.membership.status !== "active") || lapsed)
		return refusal(
			"membership_not_active",
			`the membership is ${lapsed ? "over" : (grants.membership?.status ?? "not active")}`,
		);
	if (billing.tierIds && (tierId === null || !billing.tierIds.includes(tierId)))
		return refusal(
			"tier_not_included",
			`the item's credits are for ${billing.tierIds.join(", ")}, the holder's tier is ${tierId ?? "none"}`,
		);
	if (!planHasFeature({ grants, menu, tierId, featureId: billing.featureId }))
		return refusal(
			"feature_not_in_plan",
			`the holder's plan has no credits of ${billing.featureId}`,
		);
	if (typeof available === "number" && available < billing.credits)
		return refusal(
			"insufficient_credits",
			`${available} ${billing.featureId} can be spent now, the item costs ${billing.credits}`,
		);
	return null;
};

/** The cost of one booking for this holder: credits to hold, a price to pay, nothing, or why not. */
export const quoteBooking = (input: QuoteInput): BookingQuote => {
	const problems = billingProblems(input.billing, input.menu);
	if (problems.length > 0) {
		const onlyCurrency = problems.every((p) => p.currency);
		return refusal(
			onlyCurrency ? "currency_mismatch" : "invalid_billing",
			problems.map((p) => p.message).join("; "),
		);
	}
	const { billing } = input;
	const price = (b: Extract<Billing, { amount: number }>): BookingCost => ({
		kind: "price",
		amount: b.amount,
		currency: b.currency,
	});
	switch (billing.kind) {
		case "free":
			return { ok: true, cost: { kind: "free" } };
		case "price":
			return { ok: true, cost: price(billing) };
		case "included": {
			const refused = creditRefusal({ billing, input });
			if (refused) return refused;
			return {
				ok: true,
				cost: {
					kind: "credits",
					featureId: billing.featureId,
					credits: billing.credits,
				},
			};
		}
		case "included_or_price": {
			if (creditRefusal({ billing, input }) !== null)
				return { ok: true, cost: price(billing), via: "price" };
			return {
				ok: true,
				cost: {
					kind: "credits",
					featureId: billing.featureId,
					credits: billing.credits,
				},
				via: "included",
			};
		}
		default:
			return refusal("invalid_billing", "billing has an unknown kind");
	}
};
