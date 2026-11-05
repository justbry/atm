import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { R2Store, type R2StoreOptions } from "../src/store/r2-store.js";
import {
	AlreadyExists,
	NotFound,
	ShaMismatch,
	Stale,
	StoreError,
	sha256Hex,
	Transient,
	utf8,
} from "../src/store/store.js";
import { decodeEntities, parseXml } from "../src/store/xml.js";

// ---- A fake S3: path-style, in memory, with preconditions and fault injection ----

type Method = "GET" | "PUT" | "HEAD" | "DELETE";

type Fault = {
	/** Only a request with this method takes the fault. */
	on?: Method;
	/** Runs before the fault answers: another writer getting in between two tries. */
	before?: () => void;
} & (
	| { kind: "status"; status: number; code?: string }
	| { kind: "network" }
	/** Never answers, but gives up when the request is aborted. */
	| { kind: "hang" }
	/** Never answers and ignores the abort signal. */
	| { kind: "stall" }
	/** The server applies the request, then the connection dies before the answer arrives. */
	| { kind: "commit-then-network-error" }
	/** The server answers normally once `before` has run. */
	| { kind: "pass" }
);

type Recorded = {
	method: string;
	url: URL;
	headers: Headers;
	body: Uint8Array;
};

type Stored = {
	body: Uint8Array;
	etag: string;
	meta: Record<string, string>;
};

const META_PREFIX = "x-amz-meta-";
const DEFAULT_MAX_KEYS = 1000;

const errorXml = (code: string, message: string): string =>
	`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

const errorResponse = (status: number, code: string, message = code) =>
	new Response(errorXml(code, message), { status });

class FakeS3 {
	readonly objects = new Map<string, Stored>();
	readonly requests: Recorded[] = [];
	readonly faults: Fault[] = [];
	aborted = 0;
	/** Emit every non-ASCII character of a list response as a numeric entity. */
	escapeNonAscii = false;
	/** SeaweedFS answers 412 where AWS and R2 answer 404 for If-Match on a missing key. */
	missingIfMatchStatus = 404;
	/** AWS and R2 answer 204 to a DELETE of a missing key; some S3 servers answer 404. */
	missingDeleteStatus = 204;
	/** A 200 to a PUT carries the ETag unless this is off. */
	putReturnsEtag = true;
	/** A truncated list leaves out its NextContinuationToken: a broken server. */
	omitContinuationToken = false;
	private version = 0;

	constructor(readonly bucket: string) {}

	readonly fetch = ((input: Request) =>
		this.handle(input)) as unknown as typeof fetch;

	seed(key: string, body: Uint8Array, withMetadata = true): Stored {
		const meta: Record<string, string> = withMetadata
			? { sha256: sha256Hex(body) }
			: {};
		return this.store(key, body, meta);
	}

	requestsFor(method: Method): Recorded[] {
		return this.requests.filter((request) => request.method === method);
	}

	private store(
		key: string,
		body: Uint8Array,
		meta: Record<string, string>,
	): Stored {
		this.version += 1;
		const etag = `"${createHash("md5").update(String(this.version)).update(body).digest("hex")}"`;
		const stored = { body, etag, meta };
		this.objects.set(key, stored);
		return stored;
	}

	private async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const body = new Uint8Array(await request.arrayBuffer());
		const method = request.method as Method;
		this.requests.push({ method, url, headers: request.headers, body });
		const index = this.faults.findIndex(
			(candidate) => !candidate.on || candidate.on === method,
		);
		const [fault] = index >= 0 ? this.faults.splice(index, 1) : [];
		if (!fault) return this.serve(method, url, request.headers, body);
		fault.before?.();
		switch (fault.kind) {
			case "status":
				return errorResponse(fault.status, fault.code ?? "InternalError");
			case "network":
				throw new TypeError("fetch failed");
			case "hang":
				return await new Promise<Response>((_, reject) => {
					request.signal.addEventListener("abort", () => {
						this.aborted += 1;
						reject(
							new DOMException("The operation was aborted.", "AbortError"),
						);
					});
				});
			case "stall":
				return await new Promise<Response>(() => undefined);
			case "commit-then-network-error":
				this.serve(method, url, request.headers, body);
				throw new TypeError("fetch failed");
			case "pass":
				return this.serve(method, url, request.headers, body);
			default:
				throw new Error("unknown fault");
		}
	}

	private serve(
		method: Method,
		url: URL,
		headers: Headers,
		body: Uint8Array,
	): Response {
		const signed =
			headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256") ||
			url.searchParams.has("X-Amz-Signature");
		if (!signed) return errorResponse(403, "AccessDenied", "Access Denied");
		const [, bucket, ...rest] = url.pathname.split("/");
		if (bucket !== this.bucket) return errorResponse(404, "NoSuchBucket");
		const key = rest.map((segment) => decodeURIComponent(segment)).join("/");
		if (!key) return this.list(url);
		const existing = this.objects.get(key);
		switch (method) {
			case "PUT":
				return this.put(key, headers, body, existing);
			case "GET":
			case "HEAD":
				return this.read(method, headers, existing);
			case "DELETE":
				if (!existing && this.missingDeleteStatus === 404) {
					return errorResponse(404, "NoSuchKey");
				}
				this.objects.delete(key);
				return new Response(null, { status: 204 });
			default:
				return errorResponse(405, "MethodNotAllowed");
		}
	}

	private put(
		key: string,
		headers: Headers,
		body: Uint8Array,
		existing: Stored | undefined,
	): Response {
		if (headers.get("if-none-match") === "*" && existing) {
			return errorResponse(412, "PreconditionFailed");
		}
		const ifMatch = headers.get("if-match");
		if (ifMatch !== null) {
			if (!existing) {
				return errorResponse(this.missingIfMatchStatus, "NoSuchKey");
			}
			if (existing.etag !== ifMatch) {
				return errorResponse(412, "PreconditionFailed");
			}
		}
		const meta: Record<string, string> = {};
		for (const [name, value] of headers) {
			if (name.startsWith(META_PREFIX)) {
				meta[name.slice(META_PREFIX.length)] = value;
			}
		}
		const stored = this.store(key, body, meta);
		const answer: Record<string, string> = this.putReturnsEtag
			? { ETag: stored.etag }
			: {};
		return new Response(null, { status: 200, headers: answer });
	}

	private read(
		method: "GET" | "HEAD",
		headers: Headers,
		stored: Stored | undefined,
	): Response {
		if (!stored) return errorResponse(404, "NoSuchKey");
		const answer: Record<string, string> = { ETag: stored.etag };
		for (const [name, value] of Object.entries(stored.meta)) {
			answer[`${META_PREFIX}${name}`] = value;
		}
		const total = stored.body.length;
		const range = /^bytes=(\d+)-(\d*)$/.exec(headers.get("range") ?? "");
		if (!range) {
			answer["Content-Length"] = String(total);
			return new Response(method === "HEAD" ? null : stored.body, {
				status: 200,
				headers: answer,
			});
		}
		const start = Number(range[1]);
		const end = Math.min(range[2] ? Number(range[2]) : total - 1, total - 1);
		const slice = stored.body.slice(start, end + 1);
		answer["Content-Range"] = `bytes ${start}-${end}/${total}`;
		answer["Content-Length"] = String(slice.length);
		return new Response(slice, { status: 206, headers: answer });
	}

	private escape(text: string): string {
		const escaped = text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&apos;");
		if (!this.escapeNonAscii) return escaped;
		return escaped.replace(
			/[^ -~]/gu,
			(char) => `&#x${(char.codePointAt(0) ?? 0).toString(16)};`,
		);
	}

	private list(url: URL): Response {
		const query = url.searchParams;
		const prefix = query.get("prefix") ?? "";
		const delimiter = query.get("delimiter") ?? "";
		const maxKeys = Number(query.get("max-keys") ?? DEFAULT_MAX_KEYS);
		const token = query.get("continuation-token");
		const after = token
			? Buffer.from(token, "base64url").toString("utf8")
			: null;
		type Item =
			| { kind: "key"; key: string }
			| { kind: "prefix"; value: string };
		const items: Item[] = [];
		for (const key of [...this.objects.keys()].sort()) {
			if (!key.startsWith(prefix)) continue;
			const tail = key.slice(prefix.length);
			const cut = delimiter ? tail.indexOf(delimiter) : -1;
			const item: Item =
				cut < 0
					? { kind: "key", key }
					: {
							kind: "prefix",
							value: prefix + tail.slice(0, cut + delimiter.length),
						};
			const last = items[items.length - 1];
			if (
				item.kind === "prefix" &&
				last?.kind === "prefix" &&
				last.value === item.value
			) {
				continue;
			}
			items.push(item);
		}
		const resume = after
			? items.findIndex(
					(item) =>
						(item.kind === "key" ? item.key : item.value) > after.slice(2),
				)
			: 0;
		const remaining = resume < 0 ? [] : items.slice(resume);
		const page = remaining.slice(0, maxKeys);
		const truncated = remaining.length > page.length;
		const lastItem = page[page.length - 1];
		let xml =
			'<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">';
		xml += `<Name>${this.bucket}</Name><Prefix>${this.escape(prefix)}</Prefix>`;
		xml += `<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>`;
		xml += `<IsTruncated>${truncated}</IsTruncated>`;
		if (truncated && lastItem && !this.omitContinuationToken) {
			const marker =
				lastItem.kind === "key" ? `k:${lastItem.key}` : `p:${lastItem.value}`;
			xml += `<NextContinuationToken>${Buffer.from(marker).toString("base64url")}</NextContinuationToken>`;
		}
		for (const item of page) {
			if (item.kind === "prefix") {
				xml += `<CommonPrefixes><Prefix>${this.escape(item.value)}</Prefix></CommonPrefixes>`;
				continue;
			}
			const stored = this.objects.get(item.key) as Stored;
			xml += `<Contents><Key>${this.escape(item.key)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>${this.escape(stored.etag)}</ETag><Size>${stored.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
		}
		xml += "</ListBucketResult>";
		return new Response(xml, {
			status: 200,
			headers: { "Content-Type": "application/xml" },
		});
	}
}

// ---- Harness ----

const BUCKET = "atm-bucket";
const HOST = "acct.r2.example.test";
const ROOT = "school/";

const setup = (overrides: Partial<R2StoreOptions> = {}) => {
	const s3 = new FakeS3(BUCKET);
	const sleeps: number[] = [];
	const store = new R2Store({
		endpoint: `https://${HOST}`,
		bucket: BUCKET,
		prefix: "school",
		accessKeyId: "AKIDEXAMPLE",
		secretAccessKey: "secret-example",
		fetch: s3.fetch,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		// 1 turns full jitter into the ceiling of each wait, so the sleeps show the schedule itself.
		random: () => 1,
		...overrides,
	});
	return { s3, store, sleeps };
};

const failureOf = async (promise: Promise<unknown>): Promise<unknown> => {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
};

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const CHECKSUM_HEADER =
	/^(x-amz-checksum-|x-amz-sdk-checksum|x-amz-trailer$|content-md5$)/;

const faults = (count: number, fault: Fault): Fault[] =>
	Array.from({ length: count }, () => ({ ...fault }));

// ---- Puts ----

describe("R2Store puts", () => {
	it("sends the sha256 header on every put and no checksum headers", async () => {
		const { s3, store } = setup();
		const first = await store.putIfAbsent("a.txt", utf8("one"));
		await store.putIfMatch("a.txt", utf8("two"), first.etag);
		const puts = s3.requestsFor("PUT");
		expect(puts).toHaveLength(2);
		expect(puts[0]?.headers.get("x-amz-meta-sha256")).toBe(
			sha256Hex(utf8("one")),
		);
		expect(puts[1]?.headers.get("x-amz-meta-sha256")).toBe(
			sha256Hex(utf8("two")),
		);
		expect(puts[0]?.headers.get("if-none-match")).toBe("*");
		expect(puts[1]?.headers.get("if-match")).toBe(first.etag);
		for (const request of s3.requests) {
			for (const [name] of request.headers) {
				expect(CHECKSUM_HEADER.test(name)).toBe(false);
			}
		}
	});

	it("returns the stored etag and sha256 from a put", async () => {
		const { s3, store } = setup();
		const result = await store.putIfAbsent("a.txt", utf8("one"));
		expect(result.sha256).toBe(sha256Hex(utf8("one")));
		expect(result.etag).toBe(s3.objects.get(`${ROOT}a.txt`)?.etag as string);
	});

	it("throws AlreadyExists on a 412 without a second try or a head", async () => {
		const { s3, store, sleeps } = setup();
		await store.putIfAbsent("a.txt", utf8("one"));
		const error = await failureOf(store.putIfAbsent("a.txt", utf8("one")));
		expect(error).toBeInstanceOf(AlreadyExists);
		expect((error as AlreadyExists).key).toBe("a.txt");
		expect(s3.requestsFor("PUT")).toHaveLength(2);
		expect(s3.requestsFor("HEAD")).toHaveLength(0);
		expect(sleeps).toEqual([]);
		expect(text(s3.objects.get(`${ROOT}a.txt`)?.body as Uint8Array)).toBe(
			"one",
		);
	});

	it("throws Stale on a 412 from If-Match", async () => {
		const { s3, store } = setup();
		const first = await store.putIfAbsent("a.txt", utf8("one"));
		await store.putIfMatch("a.txt", utf8("two"), first.etag);
		const error = await failureOf(
			store.putIfMatch("a.txt", utf8("three"), first.etag),
		);
		expect(error).toBeInstanceOf(Stale);
		expect(s3.requestsFor("HEAD")).toHaveLength(0);
		expect(text(s3.objects.get(`${ROOT}a.txt`)?.body as Uint8Array)).toBe(
			"two",
		);
	});

	it("throws NotFound on a 404 from If-Match on a missing key", async () => {
		const { store } = setup();
		const error = await failureOf(
			store.putIfMatch("missing.txt", utf8("x"), '"anything"'),
		);
		expect(error).toBeInstanceOf(NotFound);
	});

	it("surfaces SeaweedFS's 412 for If-Match on a missing key as Stale", async () => {
		const { s3, store } = setup();
		s3.missingIfMatchStatus = 412;
		const error = await failureOf(
			store.putIfMatch("missing.txt", utf8("x"), '"anything"'),
		);
		expect(error).toBeInstanceOf(Stale);
	});

	it("treats a 412 on a retry of putIfAbsent as success when an earlier try landed", async () => {
		const { s3, store, sleeps } = setup();
		s3.faults.push({ kind: "commit-then-network-error", on: "PUT" });
		const result = await store.putIfAbsent("a.txt", utf8("one"));
		const stored = s3.objects.get(`${ROOT}a.txt`) as Stored;
		expect(result).toEqual({
			etag: stored.etag,
			sha256: sha256Hex(utf8("one")),
		});
		expect(s3.requestsFor("PUT")).toHaveLength(2);
		expect(s3.requestsFor("HEAD")).toHaveLength(1);
		expect(sleeps).toEqual([200]);
	});

	it("treats a 412 on a retry of putIfMatch as success when an earlier try landed", async () => {
		const { s3, store } = setup();
		const first = await store.putIfAbsent("a.txt", utf8("one"));
		s3.faults.push({ kind: "commit-then-network-error", on: "PUT" });
		const result = await store.putIfMatch("a.txt", utf8("two"), first.etag);
		const stored = s3.objects.get(`${ROOT}a.txt`) as Stored;
		expect(result).toEqual({
			etag: stored.etag,
			sha256: sha256Hex(utf8("two")),
		});
		expect(result.etag).not.toBe(first.etag);
		expect(s3.requestsFor("PUT")).toHaveLength(3);
	});

	it("also lands a retry after a 5xx when the object holds the bytes sent", async () => {
		const { s3, store } = setup();
		s3.faults.push({
			kind: "status",
			status: 503,
			on: "PUT",
			before: () => {
				s3.seed(`${ROOT}a.txt`, utf8("one"));
			},
		});
		const result = await store.putIfAbsent("a.txt", utf8("one"));
		expect(result.etag).toBe(s3.objects.get(`${ROOT}a.txt`)?.etag as string);
	});

	it("throws AlreadyExists when a retry's 412 finds different bytes", async () => {
		const { s3, store } = setup();
		s3.faults.push({
			kind: "status",
			status: 503,
			on: "PUT",
			before: () => {
				s3.seed(`${ROOT}a.txt`, utf8("someone else's bytes"));
			},
		});
		const error = await failureOf(store.putIfAbsent("a.txt", utf8("one")));
		expect(error).toBeInstanceOf(AlreadyExists);
		expect(s3.requestsFor("HEAD")).toHaveLength(1);
		expect(text(s3.objects.get(`${ROOT}a.txt`)?.body as Uint8Array)).toBe(
			"someone else's bytes",
		);
	});

	it("throws Stale when a retry's 412 finds different bytes", async () => {
		const { s3, store } = setup();
		const first = await store.putIfAbsent("a.txt", utf8("one"));
		s3.faults.push({
			kind: "network",
			on: "PUT",
			before: () => {
				s3.seed(`${ROOT}a.txt`, utf8("someone else's bytes"));
			},
		});
		const error = await failureOf(
			store.putIfMatch("a.txt", utf8("two"), first.etag),
		);
		expect(error).toBeInstanceOf(Stale);
		expect(s3.requestsFor("HEAD")).toHaveLength(1);
	});

	it("reads the ETag back when a put's 200 carries none", async () => {
		const { s3, store } = setup();
		s3.putReturnsEtag = false;
		const result = await store.putIfAbsent("a.txt", utf8("one"));
		expect(result).toEqual({
			etag: s3.objects.get(`${ROOT}a.txt`)?.etag as string,
			sha256: sha256Hex(utf8("one")),
		});
		expect(s3.requestsFor("HEAD")).toHaveLength(1);
	});

	it("never pairs a later writer's ETag with this put's sha256", async () => {
		const { s3, store } = setup();
		s3.putReturnsEtag = false;
		s3.faults.push({
			kind: "pass",
			on: "HEAD",
			before: () => {
				s3.seed(`${ROOT}a.txt`, utf8("a later writer"));
			},
		});
		const created = await failureOf(store.putIfAbsent("a.txt", utf8("one")));
		expect(created).toBeInstanceOf(AlreadyExists);

		const first = s3.seed(`${ROOT}b.txt`, utf8("one"));
		s3.faults.push({
			kind: "pass",
			on: "HEAD",
			before: () => {
				s3.seed(`${ROOT}b.txt`, utf8("a later writer"));
			},
		});
		const replaced = await failureOf(
			store.putIfMatch("b.txt", utf8("two"), first.etag),
		);
		expect(replaced).toBeInstanceOf(Stale);
	});

	it("throws AlreadyExists when a retry's 412 finds an object without sha256", async () => {
		const { s3, store } = setup();
		s3.faults.push({
			kind: "status",
			status: 500,
			on: "PUT",
			before: () => {
				s3.seed(`${ROOT}a.txt`, utf8("one"), false);
			},
		});
		const error = await failureOf(store.putIfAbsent("a.txt", utf8("one")));
		expect(error).toBeInstanceOf(AlreadyExists);
	});
});

// ---- Retries ----

describe("R2Store retries", () => {
	it("retries a 429 and then succeeds, and never reports it as Stale", async () => {
		const { s3, store, sleeps } = setup();
		const first = await store.putIfAbsent("a.txt", utf8("one"));
		s3.faults.push(...faults(2, { kind: "status", status: 429, on: "PUT" }));
		const result = await store.putIfMatch("a.txt", utf8("two"), first.etag);
		expect(result.sha256).toBe(sha256Hex(utf8("two")));
		expect(s3.requestsFor("PUT")).toHaveLength(4);
		expect(sleeps).toEqual([200, 400]);
	});

	it("throws Transient with the cause after five failed tries", async () => {
		const { s3, store, sleeps } = setup();
		s3.faults.push(...faults(5, { kind: "status", status: 503, on: "PUT" }));
		const error = await failureOf(store.putIfAbsent("a.txt", utf8("one")));
		expect(error).toBeInstanceOf(Transient);
		expect((error as Transient).key).toBe("a.txt");
		expect((error as Transient).cause).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("503");
		expect(s3.requestsFor("PUT")).toHaveLength(5);
		expect(sleeps).toEqual([200, 400, 800, 1600]);
		expect(s3.objects.size).toBe(0);
	});

	it("throws Transient after five network errors", async () => {
		const { s3, store } = setup();
		s3.faults.push(...faults(5, { kind: "network" }));
		const error = await failureOf(store.head("a.txt"));
		expect(error).toBeInstanceOf(Transient);
		expect(((error as Transient).cause as Error).message).toBe("fetch failed");
		expect(s3.requests).toHaveLength(5);
	});

	it("retries a request that hits the timeout and aborts it", async () => {
		const { s3, store, sleeps } = setup({ timeoutMs: 20 });
		s3.faults.push({ kind: "hang", on: "PUT" });
		const result = await store.putIfAbsent("a.txt", utf8("one"));
		expect(result.sha256).toBe(sha256Hex(utf8("one")));
		expect(s3.requestsFor("PUT")).toHaveLength(2);
		expect(s3.aborted).toBe(1);
		expect(sleeps).toEqual([200]);
	});

	it("times out a fetch that ignores the abort signal", async () => {
		const { s3, store } = setup({ timeoutMs: 20 });
		s3.faults.push({ kind: "stall", on: "GET" });
		s3.seed(`${ROOT}a.txt`, utf8("one"));
		const got = await store.get("a.txt");
		expect(text(got.body)).toBe("one");
		expect(s3.requestsFor("GET")).toHaveLength(2);
	});

	it("backs off exponentially from 200 ms with a 5 s cap", async () => {
		const { s3, store, sleeps } = setup({ maxTries: 10 });
		s3.faults.push(...faults(9, { kind: "status", status: 503, on: "PUT" }));
		await store.putIfAbsent("a.txt", utf8("one"));
		expect(sleeps).toEqual([200, 400, 800, 1600, 3200, 5000, 5000, 5000, 5000]);
	});

	it("applies full jitter to each wait", async () => {
		const { s3, store, sleeps } = setup({ random: () => 0.5 });
		s3.faults.push(...faults(4, { kind: "status", status: 503, on: "PUT" }));
		await store.putIfAbsent("a.txt", utf8("one"));
		expect(sleeps).toEqual([100, 200, 400, 800]);
	});

	it("retries a 409 ConditionalRequestConflict through the 412 rules", async () => {
		const { s3, store, sleeps } = setup();
		s3.faults.push({
			kind: "status",
			status: 409,
			code: "ConditionalRequestConflict",
			on: "PUT",
		});
		const result = await store.putIfAbsent("a.txt", utf8("one"));
		expect(result.sha256).toBe(sha256Hex(utf8("one")));
		expect(s3.requestsFor("PUT")).toHaveLength(2);
		expect(sleeps).toEqual([200]);

		s3.faults.push({
			kind: "status",
			status: 409,
			code: "ConditionalRequestConflict",
			on: "PUT",
			before: () => {
				s3.seed(`${ROOT}b.txt`, utf8("the concurrent writer's bytes"));
			},
		});
		const error = await failureOf(store.putIfAbsent("b.txt", utf8("one")));
		expect(error).toBeInstanceOf(AlreadyExists);
		expect(text(s3.objects.get(`${ROOT}b.txt`)?.body as Uint8Array)).toBe(
			"the concurrent writer's bytes",
		);
	});

	it("does not retry a 409 with another S3 code", async () => {
		const { s3, store, sleeps } = setup();
		s3.faults.push({
			kind: "status",
			status: 409,
			code: "OperationAborted",
			on: "PUT",
		});
		const error = await failureOf(store.putIfAbsent("a.txt", utf8("one")));
		expect(error).toBeInstanceOf(StoreError);
		expect(error).not.toBeInstanceOf(Transient);
		expect(s3.requestsFor("PUT")).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	it("refuses maxTries and timeoutMs that cannot run a request", () => {
		for (const maxTries of [0, -1, 1.5, Number.NaN]) {
			expect(() => setup({ maxTries })).toThrow(StoreError);
		}
		for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => setup({ timeoutMs })).toThrow(StoreError);
		}
		expect(() => setup({ maxTries: 1, timeoutMs: 1 })).not.toThrow();
	});

	it("does not retry a 403 and reports it as a StoreError with the S3 code", async () => {
		const { s3, store, sleeps } = setup();
		s3.faults.push({ kind: "status", status: 403, code: "AccessDenied" });
		const error = await failureOf(store.head("a.txt"));
		expect(error).toBeInstanceOf(StoreError);
		expect(error).not.toBeInstanceOf(Transient);
		expect(error).not.toBeInstanceOf(NotFound);
		expect((error as Error).message).toContain("403");
		expect((error as Error).message).toContain("AccessDenied");
		expect(s3.requests).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});
});

// ---- Reads ----

describe("R2Store reads", () => {
	it("returns head and get with the stored sha256 and the same etag", async () => {
		const { store } = setup();
		const put = await store.putIfAbsent("a.txt", utf8("hello"));
		const head = await store.head("a.txt");
		const got = await store.get("a.txt");
		expect(head).toEqual({
			key: "a.txt",
			size: 5,
			etag: put.etag,
			sha256: sha256Hex(utf8("hello")),
		});
		expect(got.sha256).toBe(head.sha256);
		expect(got.etag).toBe(put.etag);
		expect(got.size).toBe(5);
		expect(text(got.body)).toBe("hello");
		expect(got.range).toBeUndefined();
	});

	it("returns sha256 null for an object without the metadata", async () => {
		const { s3, store } = setup();
		s3.seed(`${ROOT}raw.txt`, utf8("by hand"), false);
		expect((await store.head("raw.txt")).sha256).toBeNull();
		expect((await store.get("raw.txt")).sha256).toBeNull();
	});

	it("throws NotFound from head and get on a missing key", async () => {
		const { store } = setup();
		expect(await failureOf(store.head("nope"))).toBeInstanceOf(NotFound);
		expect(await failureOf(store.get("nope"))).toBeInstanceOf(NotFound);
	});

	it("takes the total size of a range get from Content-Range", async () => {
		const { s3, store } = setup();
		await store.putIfAbsent("digits", utf8("0123456789"));
		const middle = await store.get("digits", { start: 2, end: 5 });
		expect(text(middle.body)).toBe("2345");
		expect(middle.size).toBe(10);
		expect(middle.range).toEqual({ start: 2, end: 5 });
		const tail = await store.get("digits", { start: 7 });
		expect(text(tail.body)).toBe("789");
		expect(tail.size).toBe(10);
		expect(tail.range).toEqual({ start: 7, end: 9 });
		const ranges = s3.requestsFor("GET").map((r) => r.headers.get("range"));
		expect(ranges).toEqual(["bytes=2-5", "bytes=7-"]);
	});

	it("refuses a bad range before sending anything", async () => {
		const { s3, store } = setup();
		s3.seed(`${ROOT}digits`, utf8("0123456789"));
		for (const range of [
			{ start: -1 },
			{ start: 1.5 },
			{ start: Number.NaN },
			{ start: 0, end: 2.5 },
			{ start: 5, end: 2 },
		]) {
			const error = await failureOf(store.get("digits", range));
			expect(error).toBeInstanceOf(StoreError);
			expect((error as Error).message).toContain("range not satisfiable");
		}
		expect(s3.requests).toHaveLength(0);
	});
});

// ---- Delete ----

describe("R2Store delete", () => {
	it("deletes on a sha256 match without sending If-Match", async () => {
		const { s3, store } = setup();
		await store.putIfAbsent("a.txt", utf8("one"));
		expect(await store.delete("a.txt", sha256Hex(utf8("one")))).toBe(true);
		expect(s3.objects.size).toBe(0);
		expect(s3.requestsFor("DELETE")).toHaveLength(1);
		for (const request of s3.requests) {
			expect(request.headers.has("if-match")).toBe(false);
		}
		const [deletion] = s3.requestsFor("DELETE");
		expect(deletion?.headers.has("if-none-match")).toBe(false);
	});

	it("leaves the object and sends no DELETE on a sha256 mismatch", async () => {
		const { s3, store } = setup();
		await store.putIfAbsent("a.txt", utf8("one"));
		const error = await failureOf(
			store.delete("a.txt", sha256Hex(utf8("something else"))),
		);
		expect(error).toBeInstanceOf(ShaMismatch);
		expect((error as ShaMismatch).expected).toBe(
			sha256Hex(utf8("something else")),
		);
		expect((error as ShaMismatch).actual).toBe(sha256Hex(utf8("one")));
		expect(s3.objects.has(`${ROOT}a.txt`)).toBe(true);
		expect(s3.requestsFor("DELETE")).toHaveLength(0);
		for (const request of s3.requests) {
			expect(request.headers.has("if-match")).toBe(false);
		}
	});

	it("returns false for a missing key", async () => {
		const { s3, store } = setup();
		expect(await store.delete("gone.txt", sha256Hex(utf8("x")))).toBe(false);
		expect(s3.requestsFor("DELETE")).toHaveLength(0);
	});

	it("hashes the body of an object without metadata", async () => {
		const { s3, store } = setup();
		s3.seed(`${ROOT}raw.txt`, utf8("by hand"), false);
		const error = await failureOf(
			store.delete("raw.txt", sha256Hex(utf8("not it"))),
		);
		expect(error).toBeInstanceOf(ShaMismatch);
		expect((error as ShaMismatch).actual).toBe(sha256Hex(utf8("by hand")));
		expect(s3.objects.has(`${ROOT}raw.txt`)).toBe(true);
		expect(await store.delete("raw.txt", sha256Hex(utf8("by hand")))).toBe(
			true,
		);
		expect(s3.objects.size).toBe(0);
	});

	it("reports true when a retried delete finds the object already gone", async () => {
		const { s3, store } = setup();
		await store.putIfAbsent("a.txt", utf8("one"));
		s3.faults.push({ kind: "commit-then-network-error", on: "DELETE" });
		expect(await store.delete("a.txt", sha256Hex(utf8("one")))).toBe(true);
		expect(s3.requestsFor("DELETE")).toHaveLength(1);
		expect(s3.requestsFor("HEAD")).toHaveLength(2);
	});

	it("compares the sha256 again before retrying a delete", async () => {
		const { s3, store } = setup();
		await store.putIfAbsent("a.txt", utf8("one"));
		s3.faults.push({
			kind: "status",
			status: 503,
			on: "DELETE",
			before: () => {
				s3.seed(`${ROOT}a.txt`, utf8("a new writer's bytes"));
			},
		});
		const error = await failureOf(
			store.delete("a.txt", sha256Hex(utf8("one"))),
		);
		expect(error).toBeInstanceOf(ShaMismatch);
		expect(text(s3.objects.get(`${ROOT}a.txt`)?.body as Uint8Array)).toBe(
			"a new writer's bytes",
		);
		expect(s3.requestsFor("DELETE")).toHaveLength(1);
	});

	it("reads a 404 to a DELETE as gone, true only after a retry", async () => {
		const { s3, store } = setup();
		s3.missingDeleteStatus = 404;
		const vanish = () => {
			s3.objects.delete(`${ROOT}a.txt`);
		};
		await store.putIfAbsent("a.txt", utf8("one"));
		s3.faults.push({ kind: "pass", on: "DELETE", before: vanish });
		expect(await store.delete("a.txt", sha256Hex(utf8("one")))).toBe(false);

		await store.putIfAbsent("a.txt", utf8("one"));
		s3.faults.push(
			{ kind: "status", status: 503, on: "DELETE" },
			{ kind: "pass", on: "DELETE", before: vanish },
		);
		expect(await store.delete("a.txt", sha256Hex(utf8("one")))).toBe(true);
		expect(s3.requestsFor("DELETE")).toHaveLength(3);
	});
});

// ---- List ----

describe("R2Store list", () => {
	const seedTree = async (store: R2Store) => {
		for (const key of [
			"a/1",
			"a/2",
			"b/1",
			"root.txt",
			"sp ace+plus%pct.txt",
			"r&d <1> \"q\" 'a'.txt",
			"日本/é.txt",
		]) {
			await store.putIfAbsent(key, utf8(key));
		}
	};

	it("lists only keys under the root prefix and strips it", async () => {
		const { s3, store } = setup();
		await seedTree(store);
		s3.seed("other/zzz", utf8("elsewhere"));
		const page = await store.list();
		expect(page.objects.map((object) => object.key)).toEqual([
			"a/1",
			"a/2",
			"b/1",
			"r&d <1> \"q\" 'a'.txt",
			"root.txt",
			"sp ace+plus%pct.txt",
			"日本/é.txt",
		]);
		expect(page.prefixes).toEqual([]);
		expect(page.next).toBeNull();
		const request = s3.requestsFor("GET")[0] as Recorded;
		expect(request.url.pathname).toBe(`/${BUCKET}`);
		expect(request.url.searchParams.get("list-type")).toBe("2");
		expect(request.url.searchParams.get("prefix")).toBe(ROOT);
	});

	it("returns size and the same etag head returns, entities decoded", async () => {
		const { store } = setup();
		const put = await store.putIfAbsent("a.txt", utf8("hello"));
		const page = await store.list();
		expect(page.objects).toEqual([{ key: "a.txt", size: 5, etag: put.etag }]);
		expect(put.etag.startsWith('"')).toBe(true);
	});

	it("paginates with a continuation token", async () => {
		const { s3, store } = setup();
		await seedTree(store);
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = await store.list({ maxKeys: 3, cursor });
			expect(page.objects.length).toBeLessThanOrEqual(3);
			seen.push(...page.objects.map((object) => object.key));
			cursor = page.next ?? undefined;
			pages += 1;
		} while (cursor);
		expect(pages).toBe(3);
		expect(seen).toHaveLength(7);
		expect(new Set(seen).size).toBe(7);
		const sent = s3
			.requestsFor("GET")
			.map((r) => r.url.searchParams.get("max-keys"));
		expect(sent).toEqual(["3", "3", "3"]);
	});

	it("groups keys by delimiter into prefixes with the root stripped", async () => {
		const { store } = setup();
		await seedTree(store);
		const page = await store.list({ delimiter: "/" });
		expect(page.objects.map((object) => object.key)).toEqual([
			"r&d <1> \"q\" 'a'.txt",
			"root.txt",
			"sp ace+plus%pct.txt",
		]);
		expect(page.prefixes).toEqual(["a/", "b/", "日本/"]);
		const inside = await store.list({ prefix: "a/", delimiter: "/" });
		expect(inside.objects.map((object) => object.key)).toEqual(["a/1", "a/2"]);
		expect(inside.prefixes).toEqual([]);
	});

	it("paginates a delimited listing across prefixes and keys", async () => {
		const { store } = setup();
		await seedTree(store);
		const keys: string[] = [];
		const prefixes: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await store.list({ delimiter: "/", maxKeys: 2, cursor });
			keys.push(...page.objects.map((object) => object.key));
			prefixes.push(...page.prefixes);
			cursor = page.next ?? undefined;
		} while (cursor);
		expect(keys).toHaveLength(3);
		expect(prefixes).toEqual(["a/", "b/", "日本/"]);
	});

	it("decodes numeric entities for unicode keys", async () => {
		const { s3, store } = setup();
		await store.putIfAbsent("日本/😀 emoji.txt", utf8("x"));
		s3.escapeNonAscii = true;
		const page = await store.list({ delimiter: "/" });
		expect(page.prefixes).toEqual(["日本/"]);
		const inside = await store.list({ prefix: "日本/" });
		expect(inside.objects.map((object) => object.key)).toEqual([
			"日本/😀 emoji.txt",
		]);
	});

	it("refuses a truncated list without a continuation token", async () => {
		const { s3, store } = setup();
		await seedTree(store);
		s3.omitContinuationToken = true;
		const error = await failureOf(store.list({ maxKeys: 2 }));
		expect(error).toBeInstanceOf(StoreError);
		expect((error as Error).message).toContain("NextContinuationToken");
	});

	it("puts the S3 error code in the message of a failed list", async () => {
		const { s3, store } = setup();
		s3.faults.push({ kind: "status", status: 403, code: "AccessDenied" });
		const error = await failureOf(store.list());
		expect(error).toBeInstanceOf(StoreError);
		expect((error as Error).message).toContain("AccessDenied");
	});
});

// ---- URLs ----

describe("R2Store urls", () => {
	it("sends every request path-style under bucket and prefix", async () => {
		const { s3, store } = setup();
		const put = await store.putIfAbsent("dir/a.txt", utf8("one"));
		await store.head("dir/a.txt");
		await store.get("dir/a.txt");
		await store.putIfMatch("dir/a.txt", utf8("two"), put.etag);
		await store.list({ prefix: "dir/" });
		await store.delete("dir/a.txt", sha256Hex(utf8("two")));
		expect(s3.requests.length).toBeGreaterThanOrEqual(6);
		for (const request of s3.requests) {
			expect(request.url.host).toBe(HOST);
			expect(request.url.protocol).toBe("https:");
			expect(request.headers.get("authorization")).toStartWith(
				"AWS4-HMAC-SHA256",
			);
			expect(request.headers.get("authorization")).toContain(
				"/auto/s3/aws4_request",
			);
		}
		const objectPaths = s3.requests
			.filter((request) => request.url.pathname !== `/${BUCKET}`)
			.map((request) => request.url.pathname);
		expect(new Set(objectPaths)).toEqual(
			new Set([`/${BUCKET}/${ROOT}dir/a.txt`]),
		);
		const listed = s3.requests.find((r) => r.url.pathname === `/${BUCKET}`);
		expect(listed?.url.searchParams.get("prefix")).toBe(`${ROOT}dir/`);
	});

	it("keeps no prefix when none is given and tolerates a trailing slash on the endpoint", async () => {
		const { s3, store } = setup({
			prefix: undefined,
			endpoint: `https://${HOST}/`,
		});
		await store.putIfAbsent("a.txt", utf8("one"));
		expect(s3.requests[0]?.url.pathname).toBe(`/${BUCKET}/a.txt`);
		expect(s3.objects.has("a.txt")).toBe(true);
	});

	it("percent-encodes each path segment and keeps the slashes", async () => {
		const { s3, store } = setup();
		const keys = [
			"a b",
			"plus+sign",
			"100%",
			"日本語/ファイル.txt",
			"paren(s)*!'.txt",
			"deep/er/path/x",
		];
		for (const key of keys) {
			const put = await store.putIfAbsent(key, utf8(key));
			const head = await store.head(key);
			expect(head.etag).toBe(put.etag);
			expect(s3.objects.has(`${ROOT}${key}`)).toBe(true);
			expect(text((await store.get(key)).body)).toBe(key);
		}
		const paths = new Set(s3.requests.map((request) => request.url.pathname));
		expect(paths).toContain(`/${BUCKET}/${ROOT}a%20b`);
		expect(paths).toContain(`/${BUCKET}/${ROOT}plus%2Bsign`);
		expect(paths).toContain(`/${BUCKET}/${ROOT}100%25`);
		expect(paths).toContain(`/${BUCKET}/${ROOT}deep/er/path/x`);
		expect(paths).toContain(`/${BUCKET}/${ROOT}paren%28s%29%2A%21%27.txt`);
	});

	it("rejects a key with a dot segment before sending anything", async () => {
		const { s3, store } = setup();
		const error = await failureOf(store.head("a/../b"));
		expect(error).toBeInstanceOf(StoreError);
		expect(s3.requests).toHaveLength(0);
	});

	it("rejects a key with a lone surrogate as a StoreError, not a URIError", async () => {
		const { s3, store } = setup();
		for (const key of ["a\uD800", "\uDC00b/c"]) {
			const error = await failureOf(store.head(key));
			expect(error).toBeInstanceOf(StoreError);
		}
		expect(s3.requests).toHaveLength(0);
	});

	it("presigns a GET url with a signature and the requested expiry", async () => {
		const { s3, store } = setup();
		const url = new URL(
			await store.presign("dir/file name.txt", { expiresInSeconds: 900 }),
		);
		expect(url.host).toBe(HOST);
		expect(url.pathname).toBe(`/${BUCKET}/${ROOT}dir/file%20name.txt`);
		expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
		expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]+$/);
		expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
		expect(url.searchParams.get("X-Amz-Credential")).toStartWith(
			"AKIDEXAMPLE/",
		);
		expect(url.searchParams.get("X-Amz-Credential")).toContain(
			"/auto/s3/aws4_request",
		);
		expect(s3.requests).toHaveLength(0);
	});

	it("carries a session token in the presigned query", async () => {
		const { store } = setup({ sessionToken: "token-example" });
		const url = new URL(await store.presign("a.txt", { expiresInSeconds: 60 }));
		expect(url.searchParams.get("X-Amz-Security-Token")).toBe("token-example");
	});

	it("refuses an expiry outside 1 second to 7 days", async () => {
		const { store } = setup();
		for (const expiresInSeconds of [0, -5, 1.5, 7 * 24 * 60 * 60 + 1]) {
			expect(
				await failureOf(store.presign("a.txt", { expiresInSeconds })),
			).toBeInstanceOf(StoreError);
		}
	});
});

// ---- XML ----

describe("xml", () => {
	it("decodes named and numeric entities in a single pass", () => {
		expect(
			decodeEntities(
				"&amp;lt; &lt;&gt;&quot;&apos; &#65;&#x1F600; &#xZZ; &#9999999999;",
			),
		).toBe("&lt; <>\"' A😀 &#xZZ; &#9999999999;");
	});

	it("parses nested elements, self-closing tags, prologs and keeps whitespace in text", () => {
		const root = parseXml(
			'<?xml version="1.0"?>\n<A xmlns="urn:x"><B> padded key </B><C/><D></D><E><F>1</F><F>2</F></E><!-- c --></A>',
		);
		expect(root.name).toBe("A");
		expect(root.children.map((child) => child.name)).toEqual([
			"B",
			"C",
			"D",
			"E",
		]);
		expect(root.children[0]?.text).toBe(" padded key ");
		expect(root.children[1]?.text).toBe("");
		expect(root.children[3]?.children.map((child) => child.text)).toEqual([
			"1",
			"2",
		]);
	});

	it("throws on unbalanced or empty input", () => {
		expect(() => parseXml("<A><B></A>")).toThrow();
		expect(() => parseXml("<A>")).toThrow();
		expect(() => parseXml("not xml")).toThrow();
		expect(() => parseXml("")).toThrow();
	});

	it("throws a StoreError on input no token matches instead of skipping it", () => {
		for (const xml of [
			"<A>< </A>",
			"<!DOCTYPE A><A/>",
			"<A></A><",
			"<A><B>1</B> < </A>",
		]) {
			expect(() => parseXml(xml)).toThrow(StoreError);
		}
	});
});
