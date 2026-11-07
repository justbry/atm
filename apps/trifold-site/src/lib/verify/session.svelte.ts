// SPDX-License-Identifier: Apache-2.0
/**
 * One verifier's state, shared by the inline (homepage) and full (/verify) verifiers. The crypto loads on the first
 * check, so pages that only show the verifier pay nothing for it up front.
 */
import publicKey from "#lib/samples/public-key.json";
import sample from "#lib/samples/receipt.json";
import tampered from "#lib/samples/receipt-tampered.json";
import type { Books, Outcome } from "./check";
import type { PublicKeys } from "./core";

const SAMPLE_KEYS = publicKey.keys as PublicKeys;
const SWEEP_MS = 1200;

export const SAMPLE_TEXT = JSON.stringify(sample, null, 2);
export const TAMPERED_TEXT = JSON.stringify(tampered, null, 2);
export const TAMPERED_CENTS = tampered.receipt.amount;

const loadBooks = async (school: string): Promise<Books | null> => {
	if (school !== publicKey.school) return null;
	return (await import("#lib/samples/books.json")).default as unknown as Books;
};

export const preloadVerifier = () => import("./check");

export class VerifierSession {
	text = $state("");
	keysText = $state("");
	keysError = $state("");
	checking = $state(false);
	outcome = $state<Outcome | null>(null);
	which = $state<"sample" | "tampered" | "own">("own");

	/** The receipt card's light: green on a clean pass, clay on anything else. */
	get cardState(): "idle" | "pass" | "fail" {
		if (this.outcome === null) return "idle";
		return this.outcome.kind === "signed" &&
			this.outcome.books !== "event_changed"
			? "pass"
			: "fail";
	}

	keys(): PublicKeys | null {
		this.keysError = "";
		if (!this.keysText.trim()) return SAMPLE_KEYS;
		try {
			const parsed = JSON.parse(this.keysText) as unknown;
			const map =
				typeof parsed === "object" && parsed !== null && "keys" in parsed
					? (parsed as { keys: unknown }).keys
					: parsed;
			if (typeof map !== "object" || map === null || Array.isArray(map))
				throw new Error("not an object");
			return map as PublicKeys;
		} catch {
			this.keysError =
				'Keys must be JSON like { "key_id": "-----BEGIN PUBLIC KEY-----…" }.';
			return null;
		}
	}

	async verify(source: string = this.text): Promise<void> {
		const keys = this.keys();
		if (!keys) return;
		this.checking = true;
		this.outcome = null;
		let value: unknown;
		try {
			value = JSON.parse(source);
		} catch {
			value = source;
		}
		const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
		const { checkReceipt } = await preloadVerifier();
		// The proof sweep runs once (1.2s) so the check reads as a step; the result itself is ready at once.
		const [result] = await Promise.all([
			checkReceipt(value, keys, loadBooks),
			new Promise((resolve) => setTimeout(resolve, reduced ? 0 : SWEEP_MS)),
		]);
		this.outcome = result;
		this.checking = false;
	}

	load(kind: "sample" | "tampered", run = true): void {
		this.which = kind;
		this.text = kind === "sample" ? SAMPLE_TEXT : TAMPERED_TEXT;
		this.keysText = "";
		if (run) void this.verify();
	}
}
