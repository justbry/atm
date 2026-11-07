// SPDX-License-Identifier: Apache-2.0
/**
 * One verification as a visitor sees it: the signature (always), then the school's books and seal when the verifier
 * holds them (today only the sample school's). Each step reuses the tfd port in core.ts.
 */
import {
	type BooksEvent,
	type BooksVerdict,
	checkReceiptAgainstEvents,
	isSignedReceipt,
	type PublicKeys,
	type SealVerdict,
	type SignatureVerdict,
	type SignedReceipt,
	verifyReceipt,
	verifySealChain,
} from "./core";

export type Books = {
	school: string;
	events: BooksEvent[];
	seals: unknown[];
};

export type Outcome =
	| { kind: "malformed" }
	| { kind: "unknown_key"; keyId: string }
	| { kind: "bad_signature" }
	| {
			kind: "signed";
			signed: SignedReceipt;
			/** null when the verifier doesn't hold this school's books. */
			books: BooksVerdict | null;
			/** The month's seal: null when there is no books copy or no seal for the month. */
			seal: { month: string; verdict: SealVerdict; covers: boolean } | null;
	  };

/** Parse pasted or dropped text. Accepts the signed receipt JSON as is. */
export const parseReceipt = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

export const checkReceipt = async (
	value: unknown,
	keys: PublicKeys,
	loadBooks: (school: string) => Promise<Books | null>,
): Promise<Outcome> => {
	const signature: SignatureVerdict = await verifyReceipt(value, keys);
	if (signature === "malformed" || !isSignedReceipt(value))
		return { kind: "malformed" };
	if (signature === "unknown_key")
		return { kind: "unknown_key", keyId: value.key_id };
	if (signature === "bad_signature") return { kind: "bad_signature" };

	const books = await loadBooks(value.receipt.school);
	if (!books) return { kind: "signed", signed: value, books: null, seal: null };

	const booksVerdict = await checkReceiptAgainstEvents(value, books.events);
	const month = value.receipt.date.slice(0, 7);
	const verdicts = await verifySealChain(books.seals, books.events, keys);
	// The month's latest seal decides, as in tfd's verifySeals.
	let seal: Extract<Outcome, { kind: "signed" }>["seal"] = null;
	for (const [index, raw] of books.seals.entries()) {
		const candidate = raw as {
			seal?: { month?: string; event_ids?: string[] };
		};
		if (candidate.seal?.month !== month) continue;
		seal = {
			month,
			verdict: verdicts[index] ?? "malformed",
			covers:
				candidate.seal.event_ids?.includes(value.receipt.event_id) ?? false,
		};
	}
	return { kind: "signed", signed: value, books: booksVerdict, seal };
};
