/**
 * The test keys receipts and seals are signed with. Nothing key-like is committed: each private key is made here from a
 * fixed seed (sha256 of a phrase, wrapped as Ed25519 PKCS#8), and because Ed25519 is deterministic the golden receipt's
 * signature can be pinned. Only the public key's fingerprint is pinned (tests/golden/receipt/key.json).
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import type { AtmPublicKeys, AtmSigner } from "../src/types.js";

/** The fixed DER prefix of an Ed25519 PKCS#8 private key (RFC 8410); the 32-byte seed follows it. */
const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";

const keyFromPhrase = (phrase: string) =>
	createPrivateKey({
		key: Buffer.concat([
			Buffer.from(ED25519_PKCS8_PREFIX, "hex"),
			createHash("sha256").update(phrase).digest(),
		]),
		format: "der",
		type: "pkcs8",
	});

const signerFrom = (keyId: string, phrase: string) => {
	const key = keyFromPhrase(phrase);
	const signer: AtmSigner = {
		keyId,
		privateKeyPem: String(key.export({ format: "pem", type: "pkcs8" })),
	};
	const publicKeyPem = String(
		createPublicKey(key).export({ format: "pem", type: "spki" }),
	);
	return { signer, publicKeyPem };
};

export const TEST_KEY_ID = "atm-test-1";

const main = signerFrom(TEST_KEY_ID, "atm test key v1");
const other = signerFrom("atm-test-other", "atm test key other");

export const testSigner: AtmSigner = main.signer;
/** A second key, published under no id in `testKeys`. */
export const otherSigner: AtmSigner = other.signer;
export const testKeys: AtmPublicKeys = { [TEST_KEY_ID]: main.publicKeyPem };

/** sha256 (hex) of the test public key's SPKI DER: what pins the key. */
export const testKeyFingerprint = (): string =>
	createHash("sha256")
		.update(
			createPublicKey(main.publicKeyPem).export({
				format: "der",
				type: "spki",
			}),
		)
		.digest("hex");
