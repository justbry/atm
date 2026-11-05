/**
 * The pure pieces of a stored input, shared by whatever stores, ships or replays one: the id a decision event names as
 * its `cause`, the trimmed fact the grant rules decide on, and the hash of the context they decided under. Nothing here
 * reads a clock or the database.
 */
import { deterministicUlid } from "../ledger/ids.js";
import { canonicalize, sha256Hex } from "../ledger/util.js";
import type { BillingFact, ReplayFact, WebhookContext } from "../types.js";

/** The only metadata keys the grant rules read (who the holder is). Every other key is dropped from a stored fact. */
export const REPLAY_METADATA_KEYS = ["b4u_school", "family_id"] as const;

/** A checkout session's metadata also names the booking it pays for, which the booking rules read. */
const CHECKOUT_METADATA_KEYS = [...REPLAY_METADATA_KEYS, "booking_id"] as const;

/** Members of a fact that no rule reads: where it came from, and an invoice's number and bearer links. */
const DROPPED_MEMBERS: ReadonlySet<string> = new Set([
	"source",
	"number",
	"hostedInvoiceUrl",
	"invoicePdf",
]);

const MS_PER_SECOND = 1000;

/**
 * The ULID a decision event names as its `cause` (and the id of every command): the one place it is computed. The seed is
 * the school and Stripe's event id, with no env; the instant is Stripe's `created`, so no clock is read.
 */
export const inputCauseId = ({
	school,
	eventId,
	stripeCreated,
}: {
	school: string;
	eventId: string;
	/** Whole seconds, as Stripe's `created`. */
	stripeCreated: number;
}): string =>
	deterministicUlid({
		timeMs: stripeCreated * MS_PER_SECOND,
		revision: 0,
		seed: canonicalize([school, eventId]),
	});

const pick = (
	metadata: unknown,
	keys: readonly string[],
): Record<string, string> => {
	const kept: Record<string, string> = {};
	if (typeof metadata !== "object" || metadata === null) return kept;
	const from = metadata as Record<string, unknown>;
	for (const key of keys) {
		const value = from[key];
		if (typeof value === "string") kept[key] = value;
	}
	return kept;
};

/**
 * The fact the rules read, from a normalized fact: drops `source`, the invoice number and the bearer links, and cuts
 * `metadata` to `REPLAY_METADATA_KEYS` (a checkout session's also keeps `booking_id`). Every other member is kept, in
 * order, so `handleStripeFact` decides what `handleStripeEvent` did.
 */
export const replayFactOf = (fact: BillingFact): ReplayFact => {
	const isCheckout = "sessionId" in fact;
	const keys = isCheckout ? CHECKOUT_METADATA_KEYS : REPLAY_METADATA_KEYS;
	const kept: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(fact)) {
		if (DROPPED_MEMBERS.has(name)) continue;
		kept[name] = name === "metadata" ? pick(value, keys) : value;
	}
	return kept as ReplayFact;
};

/** `sha256(canonicalize({ menu, policy, priceIds }))` as hex: names the menu, policy and price ids a decision ran under. */
export const contextHashOf = (
	context: Pick<WebhookContext, "menu" | "policy" | "priceIds">,
): string =>
	sha256Hex(
		canonicalize({
			menu: context.menu,
			policy: context.policy,
			priceIds: context.priceIds,
		}),
	);
