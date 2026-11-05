/**
 * Gift codes: a session gift certificate (credits, redeemed in atm, no Stripe) and a dollar gift certificate (a one-use
 * Stripe promotion code). Member codes are on the menu (`menu.codes`, `menuToStripe`, `checkoutParams`). Pure: no clock, no
 * randomness, no I/O; every time is an input and every id is made from the code's or the gift's own id.
 *
 * Who may create a code is the caller's decision (atm has no users and only validates what it is given); a code never
 * stacks with another at checkout (Stripe takes one).
 */
import { createHash } from "node:crypto";
import { mutationToEvents, planChangedEvent } from "../ledger/postings.js";
import { runOnState, toCatalog } from "../ledger/run.js";
import type { AtmEvent, AtmIdentity, GrantsState } from "../types.js";
import { resolveEnv } from "./env.js";
import { addZonedMonths, customerRow, giftEntId, rowOp } from "./grants.js";
import { commandOrg } from "./policy.js";
import {
	GRANTS_TABLE,
	grantsFromRows,
	grantsRow,
	rowChangesFromMutation,
	stateFromRows,
	subjectKey,
} from "./rows.js";
import { giftProductKeys } from "./stripe-menu.js";
import type {
	CreateSessionGiftCodeInput,
	CreateSessionGiftCodeResult,
	DollarGiftInput,
	DollarGiftResult,
	GiftCodeRefusal,
	GiftCodeRefusalReason,
	GiftStripeOp,
	RedeemedCode,
	RedeemSessionGiftCodeInput,
	RedeemSessionGiftCodeResult,
	SessionGiftCode,
} from "./types.js";

/** What a person types for a gift: letters, digits, `-` and `_`, 6 to 40 (a member code may be as short as 2; a gift is worth money, so it is harder to guess). */
const GIFT_CODE_PATTERN = /^[A-Za-z0-9_-]{6,40}$/;
/** Most credits one session gift code may hold: the largest a menu grant may be (`schema/catalog/menu.v1.json`). */
export const MAX_GIFT_CREDITS = 100_000;
/** The label a code's decision events carry as their mapping: no Stripe event, no mapping file. */
const CODE_MAPPING = "atm/session-gift-code@v1";

const refuse = (
	reason: GiftCodeRefusalReason,
	message: string,
): GiftCodeRefusal => ({ ok: false, reason, message });

const isWhole = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value);

/**
 * A session gift code, or why it cannot be made: `bad_code` (an empty id, or a code text outside letters, digits, `-` and
 * `_`, 6 to 40), `unknown_feature` (the menu has no such feature), `bad_credits` (not a whole number from 1 to
 * `MAX_GIFT_CREDITS`), `bad_expiry` (`redeemBy` must be a whole number of ms after `createdAt`). Its credits will lapse
 * `policy.giftSessionMonths` after the redemption (stored on the code, so a later policy change leaves it alone).
 * Unique code text is the caller's rule: it stores the code in a table with a unique index on the text without case.
 */
export const createSessionGiftCode = (
	input: CreateSessionGiftCodeInput,
): CreateSessionGiftCodeResult => {
	if (typeof input.id !== "string" || input.id === "")
		return refuse("bad_code", "a gift code needs an id of its own");
	if (!GIFT_CODE_PATTERN.test(input.code))
		return refuse(
			"bad_code",
			"a gift code is 6 to 40 letters, digits, `-` or `_`",
		);
	if (!input.menu.features.some((feature) => feature.id === input.featureId))
		return refuse(
			"unknown_feature",
			`the menu has no feature ${JSON.stringify(input.featureId)}`,
		);
	if (
		!isWhole(input.credits) ||
		input.credits < 1 ||
		input.credits > MAX_GIFT_CREDITS
	)
		return refuse(
			"bad_credits",
			`credits must be a whole number from 1 to ${MAX_GIFT_CREDITS}`,
		);
	if (
		!isWhole(input.createdAt) ||
		!isWhole(input.redeemBy) ||
		input.redeemBy <= input.createdAt
	)
		return refuse(
			"bad_expiry",
			"redeemBy must be a whole number of ms after createdAt",
		);
	return {
		ok: true,
		code: {
			v: 1,
			id: input.id,
			kind: "sessions",
			code: input.code,
			featureId: input.featureId,
			credits: input.credits,
			redeemBy: input.redeemBy,
			creditMonths: input.policy.giftSessionMonths,
			createdAt: input.createdAt,
			redeemed: null,
		},
	};
};

/** The gift's credit row: one per code, named from the code's id. `ce_gift_` is how the ledger reads it as a gift. */
const giftRowId = (code: SessionGiftCode): string =>
	`ce_gift_code_${code.id}_${code.featureId}`;

/**
 * Redeems a session gift code for a holder. Pure: it decides against the code's state and the holder's rows, and returns
 * what to write.
 *
 * Checks, in order: the text typed matches the code without case (`code_mismatch`); a replay by the same holder (the
 * grants state already names this code id) is ok with `rowChanges: null`, no events and the stored `code` unchanged,
 * even after `redeemBy`; the code was not redeemed by anyone (`already_redeemed`); it is not past `redeemBy` at `now`
 * (`expired`); the menu still has its feature (`unknown_feature`).
 *
 * Then `credits` of the feature become a NEW credit row (one `applyBillingPlan` insert, the way a session gift add-on
 * bought at Checkout does: the entitlement `ent_gift_<feature>`, the row `ce_gift_code_<codeId>_<feature>`), lapsing
 * `code.creditMonths` months after `now` on the school's calendar; a holder with no engine rows gets a customer made in the
 * same plan. `GrantsState.redeemed[code.id]` records it. The events come from the engine's own mutation (`credit.granted`
 * on the plan `gift`), labelled with the menu and policy versions.
 *
 * CALLER CONTRACT: `code` in the result is the code's next state (redeemed by this holder at `now`). Write it in the SAME
 * transaction as `rowChanges`, and write it with a guarded update (`UPDATE ... SET redeemed = ? WHERE id = ? AND redeemed
 * IS NULL`, and fail the whole transaction when no row changed). This function sees only the one holder's rows and the
 * code state it is handed: two holders redeeming at the same moment each read an unredeemed code and both succeed unless
 * the guarded write refuses the second. The subject's own revision check does not help: they are different subjects.
 */
export const redeemSessionGiftCode = (
	input: RedeemSessionGiftCodeInput,
): RedeemSessionGiftCodeResult => {
	const { code, now } = input;
	if (input.entered.trim().toLowerCase() !== code.code.toLowerCase())
		return refuse("code_mismatch", "that is not this gift code");

	const grants = grantsFromRows(input.rows);
	const earlier = grants.redeemed?.[code.id];
	if (earlier)
		return {
			ok: true,
			rowChanges: null,
			events: [],
			code,
			redeemed: earlier,
		};
	if (code.redeemed !== null)
		return refuse("already_redeemed", "this gift code was already redeemed");
	if (now > code.redeemBy)
		return refuse("expired", "this gift code can no longer be redeemed");
	if (!input.menu.features.some((feature) => feature.id === code.featureId))
		return refuse(
			"unknown_feature",
			`the menu no longer has the feature ${JSON.stringify(code.featureId)}`,
		);

	const env = resolveEnv(input.env);
	const who = grants.identity ?? grants.holder ?? input.holder;
	const identity: AtmIdentity = {
		orgId: who.orgId,
		env,
		customerId: who.customerId,
		entityId: null,
	};
	const rowId = giftRowId(code);
	const expiresAt = addZonedMonths(now, code.creditMonths, input.menu.timeZone);
	const engineRows = input.rows.filter((row) => row.table !== GRANTS_TABLE);
	const hasEngineRows = engineRows.length > 0;
	// A subject whose only row so far is the grants row (a dollar gift came first) holds a later revision: its engine rows
	// are made at revision zero and the write is moved up to the stored revision, as `handleStripeEvent` does.
	const engineRevision = hasEngineRows ? input.revision : 0;
	const commandId = `gift:${code.id}:1`;
	const command = {
		schemaVersion: 1,
		type: "applyBillingPlan",
		org: commandOrg(input.policy),
		commandId,
		requestId: commandId,
		identity,
		occurredAt: now,
		entityIds: [],
		expiringPooledBalanceIds: [],
		ops: [
			...(hasEngineRows
				? []
				: [
						{
							op: "insert",
							table: "customer",
							row: customerRow(who.customerId),
						},
					]),
			rowOp({
				rowId,
				cpId: null,
				entitlementId: giftEntId(code.featureId),
				feature: code.featureId,
				customerId: who.customerId,
				balance: code.credits,
				nextResetAt: null,
				expiresAt,
				t: now,
			}),
		],
	};
	const catalog = toCatalog(input.catalog);
	const before = stateFromRows({
		identity,
		revision: engineRevision,
		rows: input.rows,
	});
	const run = runOnState({ state: before, catalog, command });
	const mutation = run.mutation;
	if (
		!mutation ||
		(mutation.result as { status?: string } | undefined)?.status === "rejected"
	)
		return refuse(
			"unknown_feature",
			`the engine could not grant ${JSON.stringify(code.featureId)}: the catalog does not carry its gift entitlement`,
		);
	const changes = rowChangesFromMutation({
		mutation,
		rows: engineRows,
		revision: engineRevision,
	});

	const redeemed: RedeemedCode = {
		codeId: code.id,
		feature: code.featureId,
		credits: code.credits,
		at: now,
		rowId,
		expiresAt,
	};
	const next: GrantsState = {
		...grants,
		identity: grants.identity ?? who,
		rows: { ...grants.rows, [rowId]: 1 },
		redeemed: { ...grants.redeemed, [code.id]: redeemed },
	};
	const labels = {
		menu_version: String(input.menuVersion),
		policy_version: String(input.policyVersion),
		mapping: CODE_MAPPING,
		// no stored input event caused this (a person typed a code), so no `cause`: the code's id is the trace
		gift_code: code.id,
	};
	const credited: AtmEvent[] = mutationToEvents({
		mutation,
		context: {
			school: who.orgId,
			tz: input.menu.timeZone,
			feature: code.featureId,
			plan: "gift",
			reason: "session gift code redeemed",
			labels,
			// the write logs every command it ran, so a replay may step over a revision gap in the log
			payload: { complete: true },
			before: before as never,
		},
	});
	const events =
		credited.length > 0
			? credited
			: [
					planChangedEvent({
						mutation,
						tz: input.menu.timeZone,
						labels,
						complete: true,
					}),
				];

	// The subject's write is the engine's rows plus the grants row under one revision step.
	return {
		ok: true,
		rowChanges: {
			subjectKey: subjectKey(identity),
			expectedRevision: input.revision,
			nextRevision: changes.nextRevision + (input.revision - engineRevision),
			upserts: [...changes.upserts, grantsRow(next)],
			deletes: changes.deletes,
		},
		events,
		code: { ...code, redeemed: { holderId: who.customerId, at: now } },
		redeemed,
	};
};

const sha24 = (text: string): string =>
	createHash("sha256").update(text).digest("hex").slice(0, 24);

type WithoutKey<T> = T extends unknown ? Omit<T, "idempotencyKey"> : never;
const stampGift = (
	schoolId: string,
	op: WithoutKey<GiftStripeOp>,
): GiftStripeOp =>
	({
		...op,
		idempotencyKey: `atm:${schoolId}:${op.op}:${sha24(JSON.stringify(op))}`,
	}) as GiftStripeOp;

/**
 * The Stripe steps for a dollar gift certificate, or why not: `bad_code` (text outside letters, digits, `-` and `_`, 6 to
 * 40), `below_minimum` (not a whole number of cents, or under `policy.giftDollarMinimum`), `bad_expiry` (`issuedAt` is not
 * a whole number of ms), `nothing_to_sell` (the menu has no public tier or non-gift add-on to apply it to).
 *
 * The ops: a coupon for `amount` cents off in the menu's currency, limited to the product keys of every public tier and
 * every add-on that is not itself a gift (a certificate does not pay for another certificate), and a promotion code for it
 * with `maxRedemptions` 1 that ends at `expiresAt` (`issuedAt` plus `policy.giftDollarMonths` on the school's calendar).
 * The executor makes the coupon with `duration: once`, so it takes its amount off the first invoice it meets.
 *
 * STRIPE KEEPS NO REMAINDER: a fixed amount larger than that invoice is used up in full, and the difference is lost, not
 * kept for a later purchase (Stripe does not carry a coupon's unused amount over, and a customer balance is not made). A
 * $100 gift on a $60 membership is worth $60. Tell the buyer; if the remainder matters, issue a gift in sessions instead.
 *
 * The coupon id comes from the school and the gift id, so running the ops twice finds the same coupon and code
 * (`coupon.ensure_amount` and `promotion_code.ensure_limited` are find-or-create); the idempotency keys are from the op.
 */
export const dollarGiftOps = (input: DollarGiftInput): DollarGiftResult => {
	const { schoolId, menu, policy } = input;
	if (typeof input.giftId !== "string" || input.giftId === "")
		return refuse("bad_code", "a dollar gift needs an id of its own");
	if (!GIFT_CODE_PATTERN.test(input.code))
		return refuse(
			"bad_code",
			"a gift code is 6 to 40 letters, digits, `-` or `_`",
		);
	if (!isWhole(input.amount) || input.amount < policy.giftDollarMinimum)
		return refuse(
			"below_minimum",
			`a dollar gift is a whole number of cents, at least ${policy.giftDollarMinimum}`,
		);
	if (!isWhole(input.issuedAt))
		return refuse("bad_expiry", "issuedAt must be a whole number of ms");
	const appliesToProductKeys = giftProductKeys(schoolId, menu);
	if (appliesToProductKeys.length === 0)
		return refuse(
			"nothing_to_sell",
			"the menu has no public tier or add-on a dollar gift could pay for",
		);
	const expiresAt = addZonedMonths(
		input.issuedAt,
		policy.giftDollarMonths,
		menu.timeZone,
	);
	const couponId = `b4u_${schoolId.slice(0, 8)}_gift_${input.giftId}`;
	return {
		ok: true,
		expiresAt,
		ops: [
			stampGift(schoolId, {
				op: "coupon.ensure_amount",
				id: couponId,
				amountOff: input.amount,
				currency: menu.currency,
				appliesToProductKeys,
			}),
			stampGift(schoolId, {
				op: "promotion_code.ensure_limited",
				code: input.code,
				couponId,
				maxRedemptions: 1,
				expiresAt,
			}),
		],
	};
};
