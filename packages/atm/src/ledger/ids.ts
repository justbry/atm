import { createHash } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const encode = (value: bigint, length: number): string => {
	let out = "";
	let v = value;
	for (let i = 0; i < length; i++) {
		out = ALPHABET[Number(v & 31n)] + out;
		v >>= 5n;
	}
	return out;
};

export const ULID_PATTERN = "^[0-7][0-9A-HJKMNP-TV-Z]{25}$";

/**
 * A ULID decided by its inputs: the 48-bit time is the event's own instant, and the 80 random bits are
 * 24 bits of the timeline's revision (so events in one millisecond still sort in the order the engine
 * decided them) followed by 56 bits of a hash of `seed`. The same inputs always give the same id.
 */
export const deterministicUlid = ({
	timeMs,
	revision,
	seed,
}: {
	timeMs: number;
	revision: number;
	seed: string;
}): string => {
	if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs >= 2 ** 48) {
		throw new Error(`ULID time out of range: ${timeMs}`);
	}
	const digest = createHash("sha256").update(seed).digest();
	let hash = 0n;
	for (let i = 0; i < 7; i++) hash = (hash << 8n) | BigInt(digest[i] ?? 0);
	const rev = BigInt(Math.min(Math.max(revision, 0), 0xffffff));
	const random = (rev << 56n) | hash;
	return encode(BigInt(timeMs), 10) + encode(random, 16);
};

/** The millisecond a ULID encodes. */
export const ulidTime = (id: string): number => {
	let v = 0n;
	for (const ch of id.slice(0, 10))
		v = (v << 5n) | BigInt(ALPHABET.indexOf(ch));
	return Number(v);
};
