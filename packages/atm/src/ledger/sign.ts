// SPDX-License-Identifier: Apache-2.0
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { AtmPublicKeys, AtmSigner } from "../types.js";

/** Receipts and seals are signed with Ed25519 only: deterministic (RFC 8032), so the same bytes and key give the same signature. */
const ED25519 = "ed25519";

const encoder = new TextEncoder();

/** `sig` of `text` (its UTF-8 bytes), base64url without padding. Throws naming the key type when the key is not an Ed25519 private key. */
export const signBytes = (text: string, signer: AtmSigner): string => {
	const key = createPrivateKey(signer.privateKeyPem);
	if (key.asymmetricKeyType !== ED25519)
		throw new Error(
			`signing needs an Ed25519 private key; ${signer.keyId} is ${key.asymmetricKeyType ?? key.type}`,
		);
	return sign(null, encoder.encode(text), key).toString("base64url");
};

/**
 * Whether `sig` is an Ed25519 signature of `text` by the key published as `keyId`. A key id `keys` does not hold, or holds
 * as anything but an Ed25519 public key, is `unknown_key`. A `sig` that is not the one base64url spelling of 64 bytes is
 * `bad_signature`. Never throws.
 */
export const verifyBytes = (
	text: string,
	keyId: string,
	sig: string,
	keys: AtmPublicKeys,
): "ok" | "unknown_key" | "bad_signature" => {
	const pem = Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;
	if (typeof pem !== "string") return "unknown_key";
	let key: ReturnType<typeof createPublicKey>;
	try {
		key = createPublicKey(pem);
	} catch {
		return "unknown_key";
	}
	if (key.asymmetricKeyType !== ED25519) return "unknown_key";
	const bytes = Buffer.from(sig, "base64url");
	if (bytes.toString("base64url") !== sig) return "bad_signature";
	return verify(null, encoder.encode(text), key, bytes)
		? "ok"
		: "bad_signature";
};

/** A shape check from one of `schema/`'s signed-document schemas, compiled on first use. */
export const shapeCheck = (
	schema: Record<string, unknown>,
): ((value: unknown) => boolean) => {
	let check: ValidateFunction | null = null;
	return (value) => {
		check ??= new Ajv2020({ strict: false }).compile(schema);
		return check(value);
	};
};
