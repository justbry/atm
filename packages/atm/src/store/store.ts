/**
 * The object store the ledger reads and writes through (ADR: Object Storage for the atm Store (R2)). The design
 * depends on this interface, never on a vendor SDK: an R2 implementation on `aws4fetch`, a folder implementation for
 * tests, and SeaweedFS (`weed mini`) standing in for R2 in CI.
 *
 * Content identity is the sha256 of the bytes, stored as `x-amz-meta-sha256` on every put. An ETag is an opaque token
 * that only `putIfMatch` may use. Two rules follow from that and live in the helpers below, so every caller applies
 * them the same way:
 *
 * - `AlreadyExists` on a create-only put: read the object's sha256. Equal bytes mean an earlier try landed (success);
 *   different bytes are a real conflict, which alerts and never overwrites (`putOnce`).
 * - `Stale` on a conditional put: read the object's sha256. If it equals the bytes just sent, an earlier try that
 *   timed out landed (success); otherwise the caller re-reads and recomputes (`replaceIfMatch`).
 */
import { createHash } from "node:crypto";
import type { Store } from "../types.js";

export type {
	ListOptions,
	ListPage,
	PresignOptions,
	PutResult,
	Store,
	StoreGet,
	StoreHead,
	StoreObject,
} from "../types.js";

// ---- Errors. Each class sets `name` itself: minifying renames classes. ----

export class StoreError extends Error {
	override name = "StoreError";
	constructor(
		message: string,
		readonly key: string | null = null,
	) {
		super(message);
	}
}

/** 412 on a create-only put: the key exists. */
export class AlreadyExists extends StoreError {
	override name = "AlreadyExists";
	constructor(key: string) {
		super(`${key} already exists`, key);
	}
}

/** 412 on `If-Match`: the object has another ETag than the caller read. */
export class Stale extends StoreError {
	override name = "Stale";
	constructor(key: string) {
		super(`${key} changed since it was read`, key);
	}
}

export class NotFound extends StoreError {
	override name = "NotFound";
	constructor(key: string) {
		super(`${key} does not exist`, key);
	}
}

/** Retryable: 429, 5xx, a network error or a timeout, after the store's own retries ran out. */
export class Transient extends StoreError {
	override name = "Transient";
	constructor(
		key: string | null,
		message: string,
		override readonly cause?: unknown,
	) {
		super(message, key);
	}
}

/** `delete` found other bytes than the caller expected; the object stays. */
export class ShaMismatch extends StoreError {
	override name = "ShaMismatch";
	constructor(
		key: string,
		readonly expected: string,
		readonly actual: string,
	) {
		super(`${key} holds sha256 ${actual}, not the expected ${expected}`, key);
	}
}

/**
 * The same key holds different bytes than a put-once step produced. Never overwritten: this alerts. The ledger's
 * steps are idempotent, so the only way to get here is a bug or a hand edit.
 */
export class Conflict extends StoreError {
	override name = "Conflict";
	constructor(
		key: string,
		readonly expected: string,
		readonly actual: string,
	) {
		super(
			`${key} already holds different bytes (sha256 ${actual}, this step made ${expected})`,
			key,
		);
	}
}

export class Unsupported extends StoreError {
	override name = "Unsupported";
	constructor(operation: string) {
		super(`${operation} is not supported by this store`);
	}
}

// ---- Content identity and the 412 rules ----

export const sha256Hex = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

export const utf8 = (text: string): Uint8Array =>
	new TextEncoder().encode(text);

const LONE_SURROGATE = /\p{Surrogate}/u;

/** False for a string with a lone surrogate, which has no UTF-8 form (`String.prototype.isWellFormed`, pre-ES2024). */
export const isWellFormed = (text: string): boolean =>
	!LONE_SURROGATE.test(text);

/** A byte range both stores accept: `start` a non-negative integer, `end` (inclusive) an integer not before it. */
export const checkRange = (
	key: string,
	range: { start: number; end?: number },
): void => {
	const { start, end } = range;
	if (!Number.isInteger(start) || start < 0) {
		throw new StoreError("range not satisfiable: bad start", key);
	}
	if (end !== undefined && !Number.isInteger(end)) {
		throw new StoreError("range not satisfiable: bad end", key);
	}
	if (end !== undefined && end < start) {
		throw new StoreError("range not satisfiable: end before start", key);
	}
};

/**
 * The object's sha256: the stored `x-amz-meta-sha256`, else the hash of its body (an object written by hand or by a
 * school has none). Throws `NotFound`.
 */
export const identify = async (store: Store, key: string): Promise<string> => {
	const head = await store.head(key);
	if (head.sha256 !== null) return head.sha256;
	return sha256Hex((await store.get(key)).body);
};

/**
 * Put-once step: create the object, or find an equal one already there. "created" when this call wrote it,
 * "existing" when an earlier try landed with the same bytes. Different bytes throw `Conflict` and nothing is written.
 */
export const putOnce = async (
	store: Store,
	key: string,
	body: Uint8Array,
): Promise<"created" | "existing"> => {
	try {
		await store.putIfAbsent(key, body);
		return "created";
	} catch (error) {
		if (!(error instanceof AlreadyExists)) throw error;
		const expected = sha256Hex(body);
		const actual = await identify(store, key);
		if (actual === expected) return "existing";
		throw new Conflict(key, expected, actual);
	}
};

/**
 * Upsert step: replace the object while it still has `etag`. "replaced" when this call wrote it, "existing" when
 * the object already holds these bytes (an earlier try that timed out landed). Another change throws `Stale`: the caller
 * re-reads and recomputes.
 */
export const replaceIfMatch = async (
	store: Store,
	key: string,
	body: Uint8Array,
	etag: string,
): Promise<"replaced" | "existing"> => {
	try {
		await store.putIfMatch(key, body, etag);
		return "replaced";
	} catch (error) {
		if (!(error instanceof Stale)) throw error;
		if ((await identify(store, key)) === sha256Hex(body)) return "existing";
		throw error;
	}
};
