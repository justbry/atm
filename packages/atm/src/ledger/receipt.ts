/**
 * Signed receipts: the family's copy of a paid or refunded payment, the third record beside the school's books and
 * Stripe's. A receipt is a pure function of its event, so it is never stored: the books regenerate it byte for byte, and a
 * receipt that no longer matches them shows the books were changed. Spec: plans/atm-signed-receipts.md.
 *
 * `event_hash` is sha256 of `canonicalize(event)`, so `canonicalize` is part of the receipt format: changing it needs a
 * receipt v2, and tests/receipt.test.ts pins the bytes.
 */
import type {
	AtmEvent,
	AtmPublicKeys,
	AtmReceipt,
	AtmReceiptedEventType,
	AtmReceiptLedgerVerdict,
	AtmReceiptRefs,
	AtmReceiptVerdict,
	AtmSignedReceipt,
	AtmSigner,
} from "../types.js";
import { signText, verifyText } from "./sign.js";
import { canonicalize, sha256Hex } from "./util.js";

const AMOUNT_FIELD: Record<AtmReceiptedEventType, string> = {
	"payment.succeeded": "amount_paid",
	"payment.refunded": "amount",
};
const REF_FIELDS: readonly (keyof AtmReceiptRefs)[] = [
	"invoice",
	"payment_intent",
	"charge",
	"booking",
];
const RECEIPT_KEYS = new Set([
	"v",
	"school",
	"key",
	"event_id",
	"event_type",
	"event_time",
	"date",
	"amount",
	"currency",
	"stripe_id",
	"refs",
	"cause",
	"event_hash",
]);
const SIGNED_KEYS = new Set(["receipt", "key_id", "sig"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

const isReceiptedType = (type: string): type is AtmReceiptedEventType =>
	Object.hasOwn(AMOUNT_FIELD, type);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (
	payload: Record<string, unknown>,
	field: string,
	event: AtmEvent,
): string => {
	const value = payload[field];
	if (typeof value !== "string" || value.length === 0)
		throw new Error(
			`${event.event_type} ${event.id}: payload.${field} must be a non-empty string`,
		);
	return value;
};

/**
 * The receipt of a `payment.succeeded` or `payment.refunded` event, or null for any other type. Pure: the same event gives
 * the same receipt. Throws, naming the field, when a required payload field is missing or of the wrong type.
 */
export const receiptOf = (event: AtmEvent): AtmReceipt | null => {
	const type = event.event_type;
	if (!isReceiptedType(type)) return null;
	const payload = event.payload;
	const amountField = AMOUNT_FIELD[type];
	const amount = payload[amountField];
	if (!Number.isSafeInteger(amount) || (amount as number) <= 0)
		throw new Error(
			`${type} ${event.id}: payload.${amountField} must be a positive whole number of cents`,
		);
	const refs: AtmReceiptRefs = {};
	for (const field of REF_FIELDS) {
		const value = payload[field];
		if (typeof value === "string" && value.length > 0) refs[field] = value;
	}
	return {
		v: 1,
		school: event.school,
		key: event.key,
		event_id: event.id,
		event_type: type,
		event_time: event.event_time,
		date: event.date,
		amount: amount as number,
		currency: requireString(payload, "currency", event),
		stripe_id: requireString(payload, "id", event),
		refs: Object.keys(refs).length > 0 ? refs : undefined,
		cause: event.cause ?? null,
		event_hash: sha256Hex(canonicalize(event)),
	};
};

/** Signs a receipt: Ed25519 over `canonicalize(receipt)`. Deterministic, so the same receipt and key give the same `sig`. */
export const signReceipt = (
	receipt: AtmReceipt,
	signer: AtmSigner,
): AtmSignedReceipt => ({
	receipt,
	key_id: signer.keyId,
	sig: signText(canonicalize(receipt), signer),
});

const isReceiptShape = (value: unknown): value is AtmReceipt => {
	if (!isRecord(value)) return false;
	if (Object.keys(value).some((key) => !RECEIPT_KEYS.has(key))) return false;
	const refsOk =
		value.refs === undefined ||
		(isRecord(value.refs) &&
			Object.entries(value.refs).every(
				([key, ref]) =>
					(REF_FIELDS as readonly string[]).includes(key) &&
					typeof ref === "string",
			));
	return (
		value.v === 1 &&
		typeof value.school === "string" &&
		typeof value.key === "string" &&
		typeof value.event_id === "string" &&
		typeof value.event_type === "string" &&
		isReceiptedType(value.event_type) &&
		typeof value.event_time === "string" &&
		typeof value.date === "string" &&
		Number.isSafeInteger(value.amount) &&
		typeof value.currency === "string" &&
		typeof value.stripe_id === "string" &&
		(value.cause === null || typeof value.cause === "string") &&
		typeof value.event_hash === "string" &&
		SHA256_HEX.test(value.event_hash) &&
		refsOk
	);
};

/** Whether `value` has the shape of a signed receipt, with no field missing, extra or of the wrong type. */
export const isSignedReceipt = (value: unknown): value is AtmSignedReceipt =>
	isRecord(value) &&
	Object.keys(value).every((key) => SIGNED_KEYS.has(key)) &&
	typeof value.key_id === "string" &&
	typeof value.sig === "string" &&
	isReceiptShape(value.receipt);

/**
 * Checks a signed receipt from anyone (a family's file is untrusted input): its shape, its key id among `keys`, then the
 * signature. Never throws.
 */
export const verifyReceipt = (
	signed: unknown,
	keys: AtmPublicKeys,
): AtmReceiptVerdict => {
	if (!isSignedReceipt(signed)) return { ok: false, reason: "malformed" };
	const publicKeyPem = Object.hasOwn(keys, signed.key_id)
		? keys[signed.key_id]
		: undefined;
	if (publicKeyPem === undefined) return { ok: false, reason: "unknown_key" };
	return verifyText(canonicalize(signed.receipt), signed.sig, publicKeyPem)
		? { ok: true }
		: { ok: false, reason: "bad_signature" };
};

/**
 * The tamper check: regenerates the receipt from the school's events and compares it with the family's copy. Checks the
 * books, not the signature (that is `verifyReceipt`).
 */
export const checkReceiptAgainstEvents = (
	signed: AtmSignedReceipt,
	events: readonly AtmEvent[],
): AtmReceiptLedgerVerdict => {
	const event = events.find((e) => e.id === signed.receipt.event_id);
	if (!event) return { ok: false, reason: "missing_event" };
	if (!isReceiptedType(event.event_type))
		return { ok: false, reason: "not_receipted" };
	let regenerated: AtmReceipt | null;
	try {
		regenerated = receiptOf(event);
	} catch {
		return { ok: false, reason: "event_changed" };
	}
	return regenerated !== null &&
		canonicalize(regenerated) === canonicalize(signed.receipt)
		? { ok: true }
		: { ok: false, reason: "event_changed" };
};
