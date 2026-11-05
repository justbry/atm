import { createHmac, timingSafeEqual } from "node:crypto";
import type { SignatureVerdict, VerifySignatureInput } from "./types.js";

const DEFAULT_TOLERANCE_SECONDS = 300;
const TIMESTAMP = /^\d{1,12}$/;
const HEX = /^[0-9a-f]+$/i;

const digestOf = (secret: string, timestamp: string, payload: string): Buffer =>
	createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest();

/** The `Stripe-Signature` header for a payload, as Stripe would send it. For tests and local replays. */
export const signStripePayload = ({
	payload,
	secret,
	timestampSeconds,
}: {
	payload: string;
	secret: string;
	timestampSeconds: number;
}): string =>
	`t=${timestampSeconds},v1=${digestOf(secret, String(timestampSeconds), payload).toString("hex")}`;

/**
 * Checks a `Stripe-Signature` header: HMAC-SHA256 of `${t}.${payload}` under the endpoint secret, compared in constant
 * time against every `v1` value (Stripe sends two while a secret is being rolled), and a timestamp within tolerance.
 */
export const verifyStripeSignature = ({
	payload,
	header,
	secret,
	nowMs,
	toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}: VerifySignatureInput): SignatureVerdict => {
	let timestamp: string | null = null;
	const candidates: string[] = [];
	for (const part of header.split(",")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		const name = part.slice(0, separator).trim();
		const value = part.slice(separator + 1).trim();
		if (name === "t") timestamp = value;
		if (name === "v1") candidates.push(value);
	}
	if (
		timestamp === null ||
		!TIMESTAMP.test(timestamp) ||
		candidates.length === 0
	)
		return { ok: false, reason: "malformed" };

	const expected = digestOf(secret, timestamp, payload);
	let matched = false;
	for (const candidate of candidates) {
		if (!HEX.test(candidate)) continue;
		const received = Buffer.from(candidate, "hex");
		// timingSafeEqual throws on different lengths: a wrong length is simply not a match.
		if (
			received.length === expected.length &&
			timingSafeEqual(received, expected)
		)
			matched = true;
	}
	if (!matched) return { ok: false, reason: "no_match" };

	const ageSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
	if (ageSeconds > toleranceSeconds)
		return { ok: false, reason: "stale_timestamp" };
	return { ok: true };
};
