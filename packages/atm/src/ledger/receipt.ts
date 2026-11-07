// SPDX-License-Identifier: Apache-2.0
import type {
	AtmEvent,
	AtmPublicKeys,
	AtmReceipt,
	AtmSignedReceipt,
	AtmSigner,
	LedgerVerdict,
	ReceiptVerdict,
} from "../types.js";
import { receiptSchema } from "./schemas.js";
import { shapeCheck, signBytes, verifyBytes } from "./sign.js";
import { canonicalize, sha256Hex } from "./util.js";

/**
 * The event types that get a receipt, and the payload field that is their amount. A dispute gets none: it is between the
 * family and its bank, not an agreement between school and family.
 */
const AMOUNT_FIELD = {
	"payment.succeeded": "amount_paid",
	"payment.refunded": "amount",
} as const;

type ReceiptedType = keyof typeof AMOUNT_FIELD;

const isReceipted = (type: string): type is ReceiptedType =>
	Object.hasOwn(AMOUNT_FIELD, type);

/** A required payload field, or an error naming it: a receipt never carries a guessed value. */
const required = <T>(
	event: AtmEvent,
	field: string,
	is: (value: unknown) => value is T,
	what: string,
): T => {
	const value = event.payload[field];
	if (!is(value))
		throw new Error(
			`${event.event_type} ${event.id}: payload.${field} must be ${what}, got ${JSON.stringify(value) ?? "nothing"}`,
		);
	return value;
};

const isText = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0;

const isCents = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * The receipt of a `payment.succeeded` or `payment.refunded` event, from the event alone; `null` for every other type.
 * Throws an error naming the field when a required payload field is missing or of the wrong type. Pure: the same event
 * always gives the same receipt, so the books can make a family's receipt again at any time.
 */
export const receiptOf = (event: AtmEvent): AtmReceipt | null => {
	if (!isReceipted(event.event_type)) return null;
	const amount = required(
		event,
		AMOUNT_FIELD[event.event_type],
		isCents,
		"whole cents above 0",
	);
	return {
		v: 1,
		school: event.school,
		key: event.key,
		event_id: event.id,
		event_type: event.event_type,
		event_time: event.event_time,
		date: event.date,
		amount,
		currency: required(event, "currency", isText, "a non-empty string"),
		stripe_id: required(event, "id", isText, "a non-empty string"),
		cause: event.cause ?? null,
		event_hash: sha256Hex(canonicalize(event)),
	};
};

/** The receipt signed with Ed25519 over `canonicalize(receipt)`. Throws naming the key type when the key is not Ed25519. */
export const signReceipt = (
	receipt: AtmReceipt,
	signer: AtmSigner,
): AtmSignedReceipt => ({
	receipt,
	key_id: signer.keyId,
	sig: signBytes(canonicalize(receipt), signer),
});

const isSignedReceipt = shapeCheck(receiptSchema);

/**
 * A signed receipt from anyone (a family's file is untrusted): its shape against `schema/receipt.v1.json`, then its key
 * id, then its signature. Never throws.
 */
export const verifyReceipt = (
	signed: unknown,
	keys: AtmPublicKeys,
): ReceiptVerdict => {
	if (!isSignedReceipt(signed)) return { ok: false, reason: "malformed" };
	const { receipt, key_id, sig } = signed as AtmSignedReceipt;
	const verdict = verifyBytes(canonicalize(receipt), key_id, sig, keys);
	return verdict === "ok" ? { ok: true } : { ok: false, reason: verdict };
};

/**
 * A signed receipt against the school's events: the event it names, made into a receipt again and compared byte for
 * byte. `missing_event` when no event has its id, `not_receipted` when the event's type no longer gets a receipt,
 * `event_changed` for any other difference (also an event that no longer makes a receipt at all). The signature is
 * `verifyReceipt`'s job.
 */
export const checkReceiptAgainstEvents = (
	signed: AtmSignedReceipt,
	events: readonly AtmEvent[],
): LedgerVerdict => {
	const event = events.find((e) => e.id === signed.receipt.event_id);
	if (!event) return { ok: false, reason: "missing_event" };
	let again: AtmReceipt | null;
	try {
		again = receiptOf(event);
	} catch {
		return { ok: false, reason: "event_changed" };
	}
	if (!again) return { ok: false, reason: "not_receipted" };
	return canonicalize(again) === canonicalize(signed.receipt)
		? { ok: true }
		: { ok: false, reason: "event_changed" };
};
