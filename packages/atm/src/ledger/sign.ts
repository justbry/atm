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
import type { AtmSigner } from "../types.js";

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
