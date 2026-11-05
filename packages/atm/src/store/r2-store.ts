/**
 * The Store on an S3-compatible bucket: Cloudflare R2 in production, SeaweedFS in CI (ADR: Object Storage for the atm
 * Store (R2)). Requests are signed with `aws4fetch` and sent through a `fetch` of our own, so tests can pass a fake S3
 * and so the library's built-in retry loop never competes with ours.
 *
 * Retries: 429, 5xx, a network error and a timeout are retried with exponential backoff and full jitter, at most
 * `maxTries` tries, each with its own timeout. A 412 on a retry may mean an earlier try landed: the object is read
 * back, and when it holds the bytes this call sent, the call succeeded.
 */
import { AwsClient } from "aws4fetch";
import type { R2StoreOptions } from "../types.js";
import type {
	ListOptions,
	ListPage,
	PresignOptions,
	PutResult,
	Store,
	StoreGet,
	StoreHead,
	StoreObject,
} from "./store.js";
import {
	AlreadyExists,
	NotFound,
	ShaMismatch,
	Stale,
	StoreError,
	sha256Hex,
	Transient,
} from "./store.js";
import { childrenNamed, childText, parseXml } from "./xml.js";

export type { R2StoreOptions } from "../types.js";

const DEFAULT_MAX_TRIES = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 5000;
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;
const SHA256_HEADER = "x-amz-meta-sha256";
const PRECONDITION_FAILED = 412;
const NOT_FOUND = 404;
const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR_FROM = 500;
const PARTIAL_CONTENT = 206;
const OK = 200;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;
const RFC3986_RESERVED = /[!'()*]/g;

type Method = "GET" | "PUT" | "HEAD" | "DELETE";

type Spec = {
	method: Method;
	url: string;
	headers?: Record<string, string>;
	body?: Uint8Array;
};

/** A whole response, body read inside the request's timeout. */
type Raw = { status: number; headers: Headers; body: Uint8Array };

/** Percent-encode every path segment, keep '/'. Also encodes ! ' ( ) *, which encodeURIComponent leaves alone. */
export const encodeKey = (key: string): string =>
	key
		.split("/")
		.map((segment) =>
			encodeURIComponent(segment).replace(
				RFC3986_RESERVED,
				(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
			),
		)
		.join("/");

const isTransientStatus = (status: number): boolean =>
	status === TOO_MANY_REQUESTS || status >= SERVER_ERROR_FROM;

const sha256Of = (headers: Headers): string | null => {
	const value = headers.get(SHA256_HEADER)?.trim().toLowerCase();
	return value ? value : null;
};

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** "HTTP 403 AccessDenied: Access Denied", the S3 code and message taken from an `<Error>` body when there is one. */
const describe = (raw: Raw): string => {
	let detail = "";
	if (raw.body.length > 0) {
		try {
			const root = parseXml(new TextDecoder().decode(raw.body));
			const code = childText(root, "Code");
			const message = childText(root, "Message");
			if (code) detail += ` ${code}`;
			if (message) detail += `: ${message}`;
		} catch {
			// Not XML (a proxy's HTML page, say): the status alone has to do.
		}
	}
	return `HTTP ${raw.status}${detail}`;
};

export class R2Store implements Store {
	private readonly aws: AwsClient;
	private readonly baseUrl: string;
	private readonly rootPrefix: string;
	private readonly fetchImpl: (request: Request) => Promise<Response>;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly random: () => number;
	private readonly maxTries: number;
	private readonly timeoutMs: number;

	constructor(options: R2StoreOptions) {
		this.aws = new AwsClient({
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			sessionToken: options.sessionToken,
			service: "s3",
			region: options.region ?? "auto",
		});
		this.baseUrl = `${options.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(options.bucket)}`;
		const trimmedPrefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
		this.rootPrefix = trimmedPrefix ? `${trimmedPrefix}/` : "";
		this.fetchImpl = options.fetch ?? ((input) => globalThis.fetch(input));
		this.sleep =
			options.sleep ??
			((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.random = options.random ?? Math.random;
		this.maxTries = Math.max(1, options.maxTries ?? DEFAULT_MAX_TRIES);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async putIfAbsent(key: string, body: Uint8Array): Promise<PutResult> {
		return await this.put(key, body, { "If-None-Match": "*" }, () => {
			return new AlreadyExists(key);
		});
	}

	async putIfMatch(
		key: string,
		body: Uint8Array,
		etag: string,
	): Promise<PutResult> {
		return await this.put(key, body, { "If-Match": etag }, () => {
			return new Stale(key);
		});
	}

	async head(key: string): Promise<StoreHead> {
		const head = await this.headOrNull(key);
		if (!head) throw new NotFound(key);
		return head;
	}

	async get(
		key: string,
		range?: { start: number; end?: number },
	): Promise<StoreGet> {
		const spec: Spec = { method: "GET", url: this.objectUrl(key) };
		if (range) {
			spec.headers = { Range: `bytes=${range.start}-${range.end ?? ""}` };
		}
		const { raw } = await this.execute(key, spec);
		if (raw.status === NOT_FOUND) throw new NotFound(key);
		if (raw.status !== OK && raw.status !== PARTIAL_CONTENT) {
			throw this.failure(key, spec, raw);
		}
		const etag = this.requireEtag(key, raw);
		const sha256 = sha256Of(raw.headers);
		if (raw.status === PARTIAL_CONTENT) {
			const match = CONTENT_RANGE.exec(raw.headers.get("content-range") ?? "");
			if (!match) {
				throw new StoreError(
					`GET ${key}: HTTP 206 without a usable Content-Range`,
					key,
				);
			}
			const [, start, end, total] = match;
			return {
				key,
				size: Number(total),
				etag,
				sha256,
				body: raw.body,
				range: { start: Number(start), end: Number(end) },
			};
		}
		if (!range) {
			return { key, size: raw.body.length, etag, sha256, body: raw.body };
		}
		// A server that ignored Range answered with the whole object: cut the range out here.
		const end = Math.min(range.end ?? raw.body.length - 1, raw.body.length - 1);
		return {
			key,
			size: raw.body.length,
			etag,
			sha256,
			body: raw.body.slice(range.start, end + 1),
			range: { start: range.start, end },
		};
	}

	async list(options: ListOptions = {}): Promise<ListPage> {
		const url = new URL(this.baseUrl);
		url.searchParams.set("list-type", "2");
		const prefix = this.rootPrefix + (options.prefix ?? "");
		if (prefix) url.searchParams.set("prefix", prefix);
		if (options.delimiter) url.searchParams.set("delimiter", options.delimiter);
		if (options.maxKeys !== undefined) {
			url.searchParams.set("max-keys", String(options.maxKeys));
		}
		if (options.cursor) {
			url.searchParams.set("continuation-token", options.cursor);
		}
		const spec: Spec = { method: "GET", url: url.toString() };
		const { raw } = await this.execute(null, spec);
		if (raw.status !== OK) throw this.failure(null, spec, raw);
		let root: ReturnType<typeof parseXml>;
		try {
			root = parseXml(new TextDecoder().decode(raw.body));
		} catch (error) {
			throw new StoreError(`LIST: unreadable response (${messageOf(error)})`);
		}
		if (root.name !== "ListBucketResult") {
			throw new StoreError(`LIST: unexpected <${root.name}> response`);
		}
		const objects: StoreObject[] = childrenNamed(root, "Contents").map(
			(entry) => ({
				key: this.stripRoot(childText(entry, "Key") ?? ""),
				size: Number(childText(entry, "Size") ?? 0),
				etag: childText(entry, "ETag") ?? "",
			}),
		);
		const prefixes = childrenNamed(root, "CommonPrefixes").map((entry) =>
			this.stripRoot(childText(entry, "Prefix") ?? ""),
		);
		const truncated = childText(root, "IsTruncated")?.trim() === "true";
		const token = childText(root, "NextContinuationToken");
		return { objects, prefixes, next: truncated && token ? token : null };
	}

	async delete(key: string, expectedSha256: string): Promise<boolean> {
		const head = await this.headOrNull(key);
		if (!head) return false;
		let actual = head.sha256;
		if (actual === null) {
			// Written by hand or by a school: no metadata, so the body is the identity.
			try {
				actual = sha256Hex((await this.get(key)).body);
			} catch (error) {
				if (error instanceof NotFound) return false;
				throw error;
			}
		}
		if (actual !== expectedSha256) {
			throw new ShaMismatch(key, expectedSha256, actual);
		}
		// No If-Match: R2 documents no conditional DELETE. This guards against a wrong key, not a race.
		const spec: Spec = { method: "DELETE", url: this.objectUrl(key) };
		const { raw, retried } = await this.execute(key, spec);
		if (raw.status === NOT_FOUND) {
			// After a retry the earlier try probably removed it.
			return retried;
		}
		if (raw.status !== OK && raw.status !== 204) {
			throw this.failure(key, spec, raw);
		}
		return true;
	}

	async presign(key: string, options: PresignOptions): Promise<string> {
		const { expiresInSeconds } = options;
		if (
			!Number.isInteger(expiresInSeconds) ||
			expiresInSeconds < 1 ||
			expiresInSeconds > MAX_PRESIGN_SECONDS
		) {
			throw new StoreError(
				`presign ${key}: expiresInSeconds must be a whole number from 1 to ${MAX_PRESIGN_SECONDS}`,
				key,
			);
		}
		const url = new URL(this.objectUrl(key));
		// aws4fetch only adds its own 86400 default when X-Amz-Expires is absent.
		url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
		const signed = await this.aws.sign(url.toString(), {
			method: "GET",
			aws: { signQuery: true },
		});
		return signed.url;
	}

	// ---- Puts ----

	private async put(
		key: string,
		body: Uint8Array,
		condition: Record<string, string>,
		conflict: () => StoreError,
	): Promise<PutResult> {
		const sha256 = sha256Hex(body);
		const spec: Spec = {
			method: "PUT",
			url: this.objectUrl(key),
			headers: { ...condition, [SHA256_HEADER]: sha256 },
			body,
		};
		const { raw, retried } = await this.execute(key, spec);
		if (raw.status === OK) {
			const etag = raw.headers.get("etag") ?? (await this.head(key)).etag;
			return { etag, sha256 };
		}
		if (raw.status === PRECONDITION_FAILED) {
			if (retried) {
				// An earlier try may have landed before it timed out or answered 5xx: same bytes there means it did.
				const head = await this.headOrNull(key);
				if (head?.sha256 === sha256) return { etag: head.etag, sha256 };
			}
			throw conflict();
		}
		if (raw.status === NOT_FOUND && "If-Match" in condition) {
			throw new NotFound(key);
		}
		throw this.failure(key, spec, raw);
	}

	private async headOrNull(key: string): Promise<StoreHead | null> {
		const spec: Spec = { method: "HEAD", url: this.objectUrl(key) };
		const { raw } = await this.execute(key, spec);
		if (raw.status === NOT_FOUND) return null;
		if (raw.status !== OK) throw this.failure(key, spec, raw);
		return {
			key,
			size: Number(raw.headers.get("content-length") ?? 0),
			etag: this.requireEtag(key, raw),
			sha256: sha256Of(raw.headers),
		};
	}

	// ---- Requests ----

	/** Send with retries. Returns the first answer that is not transient, and whether an earlier try failed. */
	private async execute(
		key: string | null,
		spec: Spec,
	): Promise<{ raw: Raw; retried: boolean }> {
		let cause: unknown;
		for (let attempt = 1; attempt <= this.maxTries; attempt++) {
			try {
				const raw = await this.attempt(spec);
				if (!isTransientStatus(raw.status)) {
					return { raw, retried: attempt > 1 };
				}
				cause = new Error(describe(raw));
			} catch (error) {
				cause = error;
			}
			if (attempt < this.maxTries) await this.sleep(this.backoff(attempt));
		}
		throw new Transient(
			key,
			`${spec.method} ${key ?? "list"} failed after ${this.maxTries} tries: ${messageOf(cause)}`,
			cause,
		);
	}

	/** Full jitter: a random wait up to min(cap, base * 2^(failures - 1)). */
	private backoff(failures: number): number {
		const ceiling = Math.min(
			BACKOFF_CAP_MS,
			BACKOFF_BASE_MS * 2 ** (failures - 1),
		);
		return this.random() * ceiling;
	}

	/** One signed request with its own timeout, response body included. */
	private async attempt(spec: Spec): Promise<Raw> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error(`timed out after ${this.timeoutMs} ms`));
			}, this.timeoutMs);
		});
		const exchange = (async (): Promise<Raw> => {
			const request = await this.aws.sign(spec.url, {
				method: spec.method,
				headers: spec.headers,
				body: spec.body as BodyInit | undefined,
				signal: controller.signal,
			});
			const response = await this.fetchImpl(request);
			return {
				status: response.status,
				headers: response.headers,
				body: new Uint8Array(await response.arrayBuffer()),
			};
		})();
		// If the timeout wins, the exchange may still fail later; nobody awaits it then.
		exchange.catch(() => undefined);
		try {
			return await Promise.race([exchange, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	// ---- Keys and errors ----

	private objectUrl(key: string): string {
		const unsafe = key
			.split("/")
			.some((segment) => segment === "." || segment === "..");
		if (!key || unsafe) {
			throw new StoreError(`invalid key ${JSON.stringify(key)}`, key);
		}
		return `${this.baseUrl}/${encodeKey(this.rootPrefix + key)}`;
	}

	private stripRoot(fullKey: string): string {
		return fullKey.startsWith(this.rootPrefix)
			? fullKey.slice(this.rootPrefix.length)
			: fullKey;
	}

	private requireEtag(key: string, raw: Raw): string {
		const etag = raw.headers.get("etag");
		if (!etag) throw new StoreError(`${key}: response carries no ETag`, key);
		return etag;
	}

	private failure(key: string | null, spec: Spec, raw: Raw): StoreError {
		return new StoreError(
			`${spec.method} ${key ?? "list"} failed: ${describe(raw)}`,
			key,
		);
	}
}
