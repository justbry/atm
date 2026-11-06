/**
 * A `Store` over a Worker's R2 bucket binding, for the test Worker. The binding's types are declared here, to the extent
 * used, so the package needs no `@cloudflare/workers-types`.
 */
import {
	AlreadyExists,
	NotFound,
	Stale,
	sha256Hex,
	Unsupported,
} from "../../src/store/store.js";
import type {
	ListOptions,
	ListPage,
	PutResult,
	Store,
	StoreGet,
	StoreHead,
} from "../../src/types.js";

type R2ObjectHead = {
	key: string;
	size: number;
	etag: string;
	customMetadata?: Record<string, string>;
};
type R2ObjectBody = R2ObjectHead & { arrayBuffer(): Promise<ArrayBuffer> };

export type R2BucketBinding = {
	get(key: string): Promise<R2ObjectBody | null>;
	head(key: string): Promise<R2ObjectHead | null>;
	put(
		key: string,
		value: Uint8Array,
		options: {
			onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
			customMetadata?: Record<string, string>;
		},
	): Promise<R2ObjectHead | null>;
	delete(key: string): Promise<void>;
	list(options: {
		prefix?: string;
		delimiter?: string;
		limit?: number;
		cursor?: string;
	}): Promise<{
		objects: R2ObjectHead[];
		delimitedPrefixes: string[];
		truncated: boolean;
		cursor?: string;
	}>;
};

const headOf = (object: R2ObjectHead): StoreHead => ({
	key: object.key,
	size: object.size,
	etag: object.etag,
	sha256: object.customMetadata?.sha256 ?? null,
});

export const r2BindingStore = (bucket: R2BucketBinding): Store => {
	const put = async (
		key: string,
		body: Uint8Array,
		onlyIf: { etagMatches?: string; etagDoesNotMatch?: string },
	): Promise<PutResult | null> => {
		const sha256 = sha256Hex(body);
		const stored = await bucket.put(key, body, {
			onlyIf,
			customMetadata: { sha256 },
		});
		return stored === null ? null : { etag: stored.etag, sha256 };
	};
	return {
		async putIfAbsent(key, body) {
			const result = await put(key, body, { etagDoesNotMatch: "*" });
			if (result === null) throw new AlreadyExists(key);
			return result;
		},
		async putIfMatch(key, body, etag) {
			if ((await bucket.head(key)) === null) throw new NotFound(key);
			const result = await put(key, body, { etagMatches: etag });
			if (result === null) throw new Stale(key);
			return result;
		},
		async get(key, range): Promise<StoreGet> {
			if (range !== undefined) throw new Unsupported("a range read");
			const object = await bucket.get(key);
			if (object === null) throw new NotFound(key);
			return {
				...headOf(object),
				body: new Uint8Array(await object.arrayBuffer()),
			};
		},
		async head(key) {
			const object = await bucket.head(key);
			if (object === null) throw new NotFound(key);
			return headOf(object);
		},
		async list(options: ListOptions = {}): Promise<ListPage> {
			const page = await bucket.list({
				prefix: options.prefix,
				delimiter: options.delimiter,
				limit: options.maxKeys,
				cursor: options.cursor,
			});
			return {
				objects: page.objects.map(headOf),
				prefixes: page.delimitedPrefixes,
				next: page.truncated ? (page.cursor ?? null) : null,
			};
		},
		async delete(key) {
			await bucket.delete(key);
			return true;
		},
		presign() {
			throw new Unsupported("presign");
		},
	};
};
