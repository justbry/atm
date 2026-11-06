/**
 * The Store on a Cloudflare R2 bucket BINDING (`env.BUCKET` in a Worker): no S3 endpoint, no keys, no signing. Conditional
 * puts are R2's `onlyIf` (`etagDoesNotMatch: "*"` for create-only, `etagMatches` for replace). `R2Store` is the S3 twin
 * for a process outside Cloudflare.
 *
 * The binding is typed here, to the extent used (`R2BucketBinding`), so the package needs no `@cloudflare/workers-types`:
 * the real `R2Bucket` is assignable to it. Needs the `nodejs_compat` flag, like the rest of `atm/worker` (`sha256Hex` is
 * `node:crypto`).
 */
import type {
	ListOptions,
	ListPage,
	PresignOptions,
	PutResult,
	Store,
	StoreGet,
	StoreHead,
} from "../types.js";
import {
	AlreadyExists,
	checkRange,
	NotFound,
	ShaMismatch,
	Stale,
	sha256Hex,
	Unsupported,
} from "./store.js";

/** What a bucket binding returns about an object. `customMetadata.sha256` is the hash this store records on every put. */
export type R2BindingObject = {
	key: string;
	size: number;
	etag: string;
	customMetadata?: Record<string, string>;
};

/** An object read with its body; `range` is set when the read was a range read. */
export type R2BindingObjectBody = R2BindingObject & {
	arrayBuffer(): Promise<ArrayBuffer>;
	range?: { offset?: number; length?: number };
};

/** The part of Cloudflare's `R2Bucket` this store calls. */
export type R2BucketBinding = {
	get(
		key: string,
		options?: { range?: { offset: number; length?: number } },
	): Promise<R2BindingObjectBody | null>;
	head(key: string): Promise<R2BindingObject | null>;
	/** Resolves to null when `onlyIf` is not met. */
	put(
		key: string,
		value: Uint8Array,
		options: {
			onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
			customMetadata?: Record<string, string>;
		},
	): Promise<R2BindingObject | null>;
	delete(key: string): Promise<void>;
	list(options: {
		prefix?: string;
		delimiter?: string;
		limit?: number;
		cursor?: string;
		include?: ("httpMetadata" | "customMetadata")[];
	}): Promise<{
		objects: R2BindingObject[];
		delimitedPrefixes: string[];
		truncated: boolean;
		cursor?: string;
	}>;
};

/** R2 lists at most this many keys per call; a larger `maxKeys` is a smaller page, which `next` continues. */
const MAX_LIST_LIMIT = 1000;
const QUOTED_ETAG = /^"(.*)"$/;

/** A binding refuses a quoted ETag in `onlyIf` and reports unquoted ones; S3 (`R2Store`) quotes them. Accept either. */
const unquoted = (etag: string): string => etag.replace(QUOTED_ETAG, "$1");

const headOf = (object: R2BindingObject): StoreHead => ({
	key: object.key,
	size: object.size,
	etag: object.etag,
	sha256: object.customMetadata?.sha256 ?? null,
});

export class R2BindingStore implements Store {
	constructor(private readonly bucket: R2BucketBinding) {}

	async putIfAbsent(key: string, body: Uint8Array): Promise<PutResult> {
		const result = await this.put(key, body, { etagDoesNotMatch: "*" });
		if (result === null) throw new AlreadyExists(key);
		return result;
	}

	async putIfMatch(
		key: string,
		body: Uint8Array,
		etag: string,
	): Promise<PutResult> {
		const result = await this.put(key, body, { etagMatches: unquoted(etag) });
		if (result !== null) return result;
		// the condition failed: either the key is not there (NotFound) or it has another ETag (Stale)
		if ((await this.bucket.head(key)) === null) throw new NotFound(key);
		throw new Stale(key);
	}

	async get(
		key: string,
		range?: { start: number; end?: number },
	): Promise<StoreGet> {
		if (range === undefined) {
			const object = await this.bucket.get(key);
			if (object === null) throw new NotFound(key);
			return {
				...headOf(object),
				body: new Uint8Array(await object.arrayBuffer()),
			};
		}
		checkRange(key, range);
		const length =
			range.end === undefined ? undefined : range.end - range.start + 1;
		const object = await this.bucket.get(key, {
			range: { offset: range.start, length },
		});
		if (object === null) throw new NotFound(key);
		const body = new Uint8Array(await object.arrayBuffer());
		return {
			...headOf(object),
			body,
			range: { start: range.start, end: range.start + body.length - 1 },
		};
	}

	async head(key: string): Promise<StoreHead> {
		const object = await this.bucket.head(key);
		if (object === null) throw new NotFound(key);
		return headOf(object);
	}

	async list(options: ListOptions = {}): Promise<ListPage> {
		const page = await this.bucket.list({
			prefix: options.prefix,
			delimiter: options.delimiter,
			limit:
				options.maxKeys === undefined
					? undefined
					: Math.min(options.maxKeys, MAX_LIST_LIMIT),
			cursor: options.cursor,
			include: ["customMetadata"],
		});
		if (page.truncated && page.cursor === undefined) {
			// `next: null` here would pass a partial listing off as complete
			throw new Error("R2 list was truncated without a cursor");
		}
		return {
			objects: page.objects.map(headOf),
			prefixes: page.delimitedPrefixes,
			next: page.truncated ? (page.cursor ?? null) : null,
		};
	}

	/**
	 * Like the S3 store: HEAD, compare the recorded sha256 (the body's hash when the object has none), then DELETE. R2 has
	 * no conditional delete, so this guards against a wrong key, not a race.
	 */
	async delete(key: string, expectedSha256: string): Promise<boolean> {
		const head = await this.bucket.head(key);
		if (head === null) return false;
		let actual = head.customMetadata?.sha256;
		if (actual === undefined) {
			// written by hand or by a school: no metadata, so the body is the identity
			const object = await this.bucket.get(key);
			if (object === null) return false;
			actual = sha256Hex(new Uint8Array(await object.arrayBuffer()));
		}
		if (actual !== expectedSha256) {
			throw new ShaMismatch(key, expectedSha256, actual);
		}
		await this.bucket.delete(key);
		return true;
	}

	/** A binding has no URLs to sign. */
	async presign(_key: string, _options: PresignOptions): Promise<string> {
		throw new Unsupported("presign");
	}

	private async put(
		key: string,
		body: Uint8Array,
		onlyIf: { etagMatches?: string; etagDoesNotMatch?: string },
	): Promise<PutResult | null> {
		const sha256 = sha256Hex(body);
		const stored = await this.bucket.put(key, body, {
			onlyIf,
			customMetadata: { sha256 },
		});
		return stored === null ? null : { etag: stored.etag, sha256 };
	}
}
