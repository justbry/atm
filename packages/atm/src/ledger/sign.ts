/**
 * Ed25519 signing for receipts and seals. Ed25519 is deterministic (RFC 8032): the same text and key always give the same
 * signature, which is what lets a receipt be regenerated from the books instead of stored.
 */
import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import type { AtmPublicKeys, AtmSigner } from "../types.js";

const ED25519 = "ed25519";

const privateKeyOf = (pem: string): KeyObject => {
	const key = createPrivateKey(pem);
	if (key.asymmetricKeyType !== ED25519)
		throw new Error(
			`the signing key is ${key.asymmetricKeyType ?? key.type}, not ${ED25519}`,
		);
	return key;
};

/** Ed25519 over the UTF-8 bytes of `text`, base64url. Throws on a key that is not an Ed25519 private key. */
export const signText = (text: string, signer: AtmSigner): string =>
	sign(
		null,
		Buffer.from(text, "utf8"),
		privateKeyOf(signer.privateKeyPem),
	).toString("base64url");

/** Whether `sig` is a valid Ed25519 signature of `text` under the public key. False, never a throw, on bad input. */
export const verifyText = (
	text: string,
	sig: string,
	publicKeyPem: string,
): boolean => {
	try {
		const key = createPublicKey(publicKeyPem);
		if (key.asymmetricKeyType !== ED25519) return false;
		return verify(
			null,
			Buffer.from(text, "utf8"),
			key,
			Buffer.from(sig, "base64url"),
		);
	} catch {
		return false;
	}
};

/**
 * Checks `sig` over `text` under the key published as `keyId`: null when it verifies, else why not. A key id that is only
 * inherited (`__proto__`, `toString`) is unknown. Never throws.
 */
export const verifySignedText = (
	text: string,
	signed: { key_id: string; sig: string },
	keys: AtmPublicKeys,
): "unknown_key" | "bad_signature" | null => {
	const publicKeyPem = Object.hasOwn(keys, signed.key_id)
		? keys[signed.key_id]
		: undefined;
	if (publicKeyPem === undefined) return "unknown_key";
	return verifyText(text, signed.sig, publicKeyPem) ? null : "bad_signature";
};

/** A new Ed25519 key pair as PEM: PKCS#8 for the private key, SPKI for the public one. */
export const generateSigningKey = (): {
	privateKeyPem: string;
	publicKeyPem: string;
} => {
	const { privateKey, publicKey } = generateKeyPairSync(ED25519, {
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	return { privateKeyPem: privateKey, publicKeyPem: publicKey };
};
