/**
 * The Store contract suite (ADR: Object Storage for the atm Store (R2), "written once and run against every
 * backend"). Each backend's test file calls `storeContract(name, makeStore)`: FolderStore (tests/store-folder.test.ts),
 * R2Store against SeaweedFS (tests/store-seaweedfs.test.ts) and against staging R2 (tests/store-r2.test.ts).
 *
 * `makeStore` returns a fresh, isolated store (its own temp dir or key prefix) for every test, plus the capability
 * flags of that backend and `cleanup`. Nothing here depends on how a backend is built.
 *
 * Runtime: the checks use only `node:crypto`, `fetch`, timers and the Store interface, so they behave the same under
 * Bun and Node. The registration calls come from `bun:test`; to run under `node --test` alias that import to
 * `node:test` (+ an `expect` shim), nothing else in this file is Bun specific.
 *
 * The numbers in the test names are the ADR's 17 checks. Checks 8 (staging R2 rate limiting) and 16 (temporary
 * credentials refused outside their prefix) are R2-only and live in tests/store-r2.test.ts. Check 17 is this file
 * being runtime-neutral.
 */
import { describe, expect, test } from "bun:test";
import {
	AlreadyExists,
	Conflict,
	identify,
	NotFound,
	putOnce,
	replaceIfMatch,
	ShaMismatch,
	Stale,
	type Store,
	sha256Hex,
	Transient,
	Unsupported,
	utf8,
} from "../src/store/store.js";

/** What a backend hands the suite for one test. */
export type ContractBackend = {
	store: Store;
	/** Remove everything the test left behind (and stop nothing shared: the server outlives a test). */
	cleanup: () => Promise<void>;
	/** True when `presign` returns URLs; false when it throws `Unsupported` (the folder store). */
	supportsPresign: boolean;
	/**
	 * What `head().sha256` says for an object written without `x-amz-meta-sha256`: true when the store hashes the body
	 * itself, false when it answers null (the caller then hashes the body: `identify`).
	 */
	hashesMissingMetadata: boolean;
	/** Write an object by hand, bypassing the Store: no `x-amz-meta-sha256`. `key` is the Store's key. */
	writeWithoutMetadata: (key: string, body: Uint8Array) => Promise<void>;
};

export type MakeStore = () => Promise<ContractBackend>;

const TEST_TIMEOUT_MS = 30_000;
const PRESIGN_EXPIRY_SECONDS = 2;
/** Real wait past the presigned URL's expiry; the server's clock moves in whole seconds. */
const PRESIGN_WAIT_MS = 4000;
const CONCURRENT_WRITERS = 8;

/** Delete every object under the store (any sha256, hand-written ones included). Backends call this in `cleanup`. */
export const emptyStore = async (store: Store): Promise<void> => {
	let cursor: string | undefined;
	do {
		const page = await store.list({ cursor });
		for (const object of page.objects) {
			await store.delete(object.key, await identify(store, object.key));
		}
		cursor = page.next ?? undefined;
	} while (cursor !== undefined);
};

/** The error a promise rejects with (fails the test when it resolves). */
export const failureOf = async (
	promise: Promise<unknown>,
): Promise<unknown> => {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw, but it resolved");
};

/** A Store that performs the put and then reports a timeout once: the first try landed, the caller never heard. */
const timesOutAfterPutIfMatch = (inner: Store): Store => {
	let timedOut = false;
	return {
		putIfAbsent: (key, body) => inner.putIfAbsent(key, body),
		putIfMatch: async (key, body, etag) => {
			const result = await inner.putIfMatch(key, body, etag);
			if (timedOut) return result;
			timedOut = true;
			throw new Transient(key, "simulated timeout after the put landed");
		},
		get: (key, range) => inner.get(key, range),
		head: (key) => inner.head(key),
		list: (options) => inner.list(options),
		delete: (key, expectedSha256) => inner.delete(key, expectedSha256),
		presign: (key, options) => inner.presign(key, options),
	};
};

const everyByte = (): Uint8Array => {
	const bytes = new Uint8Array(256);
	for (let value = 0; value < bytes.length; value++) bytes[value] = value;
	return bytes;
};

const sleep = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export const storeContract = (name: string, makeStore: MakeStore): void => {
	const check = (
		title: string,
		body: (backend: ContractBackend) => Promise<void>,
	) => {
		test(
			title,
			async () => {
				const backend = await makeStore();
				try {
					await body(backend);
				} finally {
					await backend.cleanup();
				}
			},
			TEST_TIMEOUT_MS,
		);
	};

	describe(`store contract: ${name}`, () => {
		// ---- Basics ----

		check(
			"put then get round-trips text, empty and binary bodies",
			async ({ store }) => {
				const bodies: Record<string, Uint8Array> = {
					"text.txt": utf8("hello\nworld"),
					empty: new Uint8Array(0),
					"all-bytes.bin": everyByte(),
				};
				for (const [key, body] of Object.entries(bodies)) {
					await store.putIfAbsent(key, body);
					const got = await store.get(key);
					expect(Array.from(got.body)).toEqual(Array.from(body));
					expect(got.size).toBe(body.length);
					expect(got.range).toBeUndefined();
					expect(got.key).toBe(key);
				}
			},
		);

		check(
			"a put reports the sha256 and an etag of what it stored",
			async ({ store }) => {
				const body = utf8("identity");
				const result = await store.putIfAbsent("identity", body);
				expect(result.sha256).toBe(sha256Hex(body));
				expect(result.etag.length).toBeGreaterThan(0);
				const head = await store.head("identity");
				expect(head.sha256).toBe(sha256Hex(body));
				expect(head.size).toBe(body.length);
				expect(head.key).toBe("identity");
				expect((await store.get("identity")).etag).toBe(head.etag);
			},
		);

		check(
			"keys with spaces, plus, percent, unicode and nested slashes",
			async ({ store }) => {
				const keys = [
					"a b/c d.txt",
					"plus+sign/1+1=2",
					"percent%20/100%/%2F",
					"unicode/café/日本語/\u{1f4a1}.txt",
					"deeply/nested/path/with/many/segments/file",
					"tilde~and(parens)!*'",
				];
				for (const key of keys) {
					const body = utf8(`body of ${key}`);
					await store.putIfAbsent(key, body);
					const got = await store.get(key);
					expect(new TextDecoder().decode(got.body)).toBe(`body of ${key}`);
					expect((await store.head(key)).key).toBe(key);
				}
				const listed = (await store.list()).objects.map((object) => object.key);
				expect(listed.slice().sort()).toEqual(keys.slice().sort());
				// the next put of the same key is still refused: the key was not mangled on the way in
				for (const key of keys) {
					expect(
						await failureOf(store.putIfAbsent(key, utf8("x"))),
					).toBeInstanceOf(AlreadyExists);
				}
			},
		);

		check("get and head of a missing key throw NotFound", async ({ store }) => {
			expect(await failureOf(store.get("missing"))).toBeInstanceOf(NotFound);
			expect(await failureOf(store.head("missing"))).toBeInstanceOf(NotFound);
			expect(
				await failureOf(store.get("missing", { start: 0, end: 1 })),
			).toBeInstanceOf(NotFound);
		});

		check("list of an empty prefix is empty", async ({ store }) => {
			const page = await store.list({ prefix: "nothing/here/" });
			expect(page.objects).toEqual([]);
			expect(page.prefixes).toEqual([]);
			expect(page.next).toBeNull();
			const whole = await store.list();
			expect(whole.objects).toEqual([]);
		});

		// ---- Check 1 to 3: create-only puts ----

		check(
			"1: a second create-only put to the same key returns AlreadyExists",
			async ({ store }) => {
				await store.putIfAbsent("once", utf8("first"));
				const error = await failureOf(
					store.putIfAbsent("once", utf8("second")),
				);
				expect(error).toBeInstanceOf(AlreadyExists);
				expect((error as AlreadyExists).key).toBe("once");
				expect(new TextDecoder().decode((await store.get("once")).body)).toBe(
					"first",
				);
			},
		);

		check(
			"2: a retry with identical bytes after AlreadyExists resolves as success via sha256",
			async ({ store }) => {
				const body = utf8("same bytes");
				expect(await putOnce(store, "retry", body)).toBe("created");
				expect(await putOnce(store, "retry", body)).toBe("existing");
				expect(await putOnce(store, "retry", body)).toBe("existing");
			},
		);

		check(
			"3: a retry with different bytes after AlreadyExists surfaces a conflict",
			async ({ store }) => {
				await putOnce(store, "clash", utf8("original"));
				const error = await failureOf(
					putOnce(store, "clash", utf8("different")),
				);
				expect(error).toBeInstanceOf(Conflict);
				expect((error as Conflict).expected).toBe(sha256Hex(utf8("different")));
				expect((error as Conflict).actual).toBe(sha256Hex(utf8("original")));
				expect(new TextDecoder().decode((await store.get("clash")).body)).toBe(
					"original",
				);
			},
		);

		// ---- Check 4 to 7, 12: conditional replaces ----

		check(
			"4: putIfMatch with a stale ETag returns Stale",
			async ({ store }) => {
				const first = await store.putIfAbsent("doc", utf8("v1"));
				const second = await store.putIfMatch("doc", utf8("v2"), first.etag);
				expect(second.sha256).toBe(sha256Hex(utf8("v2")));
				const error = await failureOf(
					store.putIfMatch("doc", utf8("v3"), first.etag),
				);
				expect(error).toBeInstanceOf(Stale);
				expect(new TextDecoder().decode((await store.get("doc")).body)).toBe(
					"v2",
				);
			},
		);

		check(
			"5: a putIfMatch retried after a timeout whose first try landed resolves as success via sha256",
			async ({ store }) => {
				const created = await store.putIfAbsent("timeout", utf8("v1"));
				const flaky = timesOutAfterPutIfMatch(store);
				const body = utf8("v2");
				const firstTry = await failureOf(
					replaceIfMatch(flaky, "timeout", body, created.etag),
				);
				expect(firstTry).toBeInstanceOf(Transient);
				// the caller retries with the etag it read before; the object has moved on, but to these very bytes
				expect(await replaceIfMatch(flaky, "timeout", body, created.etag)).toBe(
					"existing",
				);
				expect(
					new TextDecoder().decode((await store.get("timeout")).body),
				).toBe("v2");
			},
		);

		check(
			"5b: replaceIfMatch says replaced on a fresh etag and surfaces Stale for other bytes",
			async ({ store }) => {
				const created = await store.putIfAbsent("replace", utf8("v1"));
				expect(
					await replaceIfMatch(store, "replace", utf8("v2"), created.etag),
				).toBe("replaced");
				const error = await failureOf(
					replaceIfMatch(store, "replace", utf8("v3"), created.etag),
				);
				expect(error).toBeInstanceOf(Stale);
			},
		);

		check(
			"6: two concurrent putIfMatch calls with the same ETag: one wins, the other gets Stale",
			async ({ store }) => {
				const created = await store.putIfAbsent("race", utf8("v0"));
				const outcomes = await Promise.allSettled(
					[utf8("left"), utf8("right")].map((body) =>
						store.putIfMatch("race", body, created.etag),
					),
				);
				const winners = outcomes.filter(
					(outcome) => outcome.status === "fulfilled",
				);
				const losers = outcomes.filter(
					(outcome) => outcome.status === "rejected",
				);
				expect(winners).toHaveLength(1);
				expect(losers).toHaveLength(1);
				expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(
					Stale,
				);
			},
		);

		check(
			"6b: many concurrent putIfMatch calls with the same ETag: exactly one wins",
			async ({ store }) => {
				const created = await store.putIfAbsent("crowd", utf8("v0"));
				const bodies = Array.from({ length: CONCURRENT_WRITERS }, (_, index) =>
					utf8(`writer ${index}`),
				);
				const outcomes = await Promise.allSettled(
					bodies.map((body) => store.putIfMatch("crowd", body, created.etag)),
				);
				const winners = outcomes.flatMap((outcome, index) =>
					outcome.status === "fulfilled" ? [index] : [],
				);
				expect(winners).toHaveLength(1);
				for (const outcome of outcomes) {
					if (outcome.status === "rejected") {
						expect(outcome.reason).toBeInstanceOf(Stale);
					}
				}
				const stored = await store.get("crowd");
				expect(stored.sha256).toBe(sha256Hex(bodies[winners[0] as number]));
			},
		);

		check(
			"7: putIfMatch on a missing key is refused (NotFound or Stale)",
			async ({ store }) => {
				const error = await failureOf(
					store.putIfMatch("never-created", utf8("x"), '"0123456789abcdef"'),
				);
				expect(error instanceof NotFound || error instanceof Stale).toBe(true);
				expect(await failureOf(store.head("never-created"))).toBeInstanceOf(
					NotFound,
				);
			},
		);

		check(
			"12: the ETag from HEAD is accepted by the next putIfMatch",
			async ({ store }) => {
				await store.putIfAbsent("head-etag", utf8("v1"));
				const head = await store.head("head-etag");
				await store.putIfMatch("head-etag", utf8("v2"), head.etag);
				const again = await store.head("head-etag");
				expect(again.etag).not.toBe(head.etag);
				await store.putIfMatch("head-etag", utf8("v3"), again.etag);
				expect(
					new TextDecoder().decode((await store.get("head-etag")).body),
				).toBe("v3");
			},
		);

		check(
			"the ETag a put returns is accepted by the next putIfMatch",
			async ({ store }) => {
				const first = await store.putIfAbsent("put-etag", utf8("v1"));
				const second = await store.putIfMatch(
					"put-etag",
					utf8("v2"),
					first.etag,
				);
				const third = await store.putIfMatch(
					"put-etag",
					utf8("v3"),
					second.etag,
				);
				expect(third.sha256).toBe(sha256Hex(utf8("v3")));
				expect(third.etag).toBe((await store.head("put-etag")).etag);
			},
		);

		// ---- Check 9: delete ----

		check(
			"9: delete with an unexpected sha256 is refused; with the right one it deletes; a second delete is false",
			async ({ store }) => {
				const body = utf8("to delete");
				await store.putIfAbsent("doomed", body);
				const wrong = await failureOf(
					store.delete("doomed", sha256Hex(utf8("something else"))),
				);
				expect(wrong).toBeInstanceOf(ShaMismatch);
				expect((wrong as ShaMismatch).actual).toBe(sha256Hex(body));
				expect((await store.get("doomed")).sha256).toBe(sha256Hex(body));

				expect(await store.delete("doomed", sha256Hex(body))).toBe(true);
				expect(await failureOf(store.head("doomed"))).toBeInstanceOf(NotFound);
				expect(await store.delete("doomed", sha256Hex(body))).toBe(false);
			},
		);

		// ---- Check 10, 11: list ----

		check(
			"10: LIST immediately after PUT shows the new object",
			async ({ store }) => {
				for (let index = 0; index < 3; index++) {
					const key = `fresh/${index}`;
					const result = await store.putIfAbsent(key, utf8(`n${index}`));
					const page = await store.list({ prefix: "fresh/" });
					const found = page.objects.find((object) => object.key === key);
					expect(found?.etag).toBe(result.etag);
					expect(found?.size).toBe(2);
				}
			},
		);

		check(
			"11: list pages correctly with prefix, delimiter and a small maxKeys",
			async ({ store }) => {
				const inside = [
					"p/a",
					"p/b",
					"p/c",
					"p/d1/x",
					"p/d1/y",
					"p/d2/x",
					"p/d3/deep/z",
				];
				for (const key of [...inside, "q/outside", "pp"]) {
					await store.putIfAbsent(key, utf8(key));
				}

				// with a delimiter: keys and common prefixes share the maxKeys budget
				const objects: string[] = [];
				const prefixes: string[] = [];
				let pages = 0;
				let cursor: string | undefined;
				do {
					const page = await store.list({
						prefix: "p/",
						delimiter: "/",
						maxKeys: 2,
						cursor,
					});
					pages++;
					expect(
						page.objects.length + page.prefixes.length,
					).toBeLessThanOrEqual(2);
					objects.push(...page.objects.map((object) => object.key));
					prefixes.push(...page.prefixes);
					cursor = page.next ?? undefined;
					expect(pages).toBeLessThan(20);
				} while (cursor !== undefined);
				expect(pages).toBeGreaterThanOrEqual(3);
				expect(objects).toEqual(["p/a", "p/b", "p/c"]);
				expect(prefixes).toEqual(["p/d1/", "p/d2/", "p/d3/"]);

				// the delimiter one level down
				const deeper = await store.list({ prefix: "p/d3/", delimiter: "/" });
				expect(deeper.objects).toEqual([]);
				expect(deeper.prefixes).toEqual(["p/d3/deep/"]);
				expect(deeper.next).toBeNull();

				// without a delimiter: every key once, ascending, whatever the page size
				const flat: string[] = [];
				cursor = undefined;
				do {
					const page = await store.list({ prefix: "p/", maxKeys: 3, cursor });
					expect(page.objects.length).toBeLessThanOrEqual(3);
					expect(page.prefixes).toEqual([]);
					flat.push(...page.objects.map((object) => object.key));
					cursor = page.next ?? undefined;
				} while (cursor !== undefined);
				expect(flat).toEqual([...inside].sort());

				// the whole store, default page size
				const all = await store.list();
				expect(all.objects.map((object) => object.key)).toEqual(
					[...inside, "q/outside", "pp"].sort(),
				);
			},
		);

		// ---- Check 13: objects written by hand ----

		check(
			"13: an object without x-amz-meta-sha256 is identified by a hash of its body",
			async ({ store, writeWithoutMetadata, hashesMissingMetadata }) => {
				const body = utf8("written by a school, not by atm");
				await writeWithoutMetadata("by-hand/object", body);

				const head = await store.head("by-hand/object");
				expect(head.sha256).toBe(
					hashesMissingMetadata ? sha256Hex(body) : null,
				);
				const got = await store.get("by-hand/object");
				expect(got.sha256).toBe(hashesMissingMetadata ? sha256Hex(body) : null);
				expect(sha256Hex(got.body)).toBe(sha256Hex(body));
				expect(await identify(store, "by-hand/object")).toBe(sha256Hex(body));

				// the same rule decides put-once on it: equal bytes are success, others a conflict
				expect(await putOnce(store, "by-hand/object", body)).toBe("existing");
				expect(
					await failureOf(putOnce(store, "by-hand/object", utf8("other"))),
				).toBeInstanceOf(Conflict);
				// and the ETag HEAD gave is good for a conditional replace
				await store.putIfMatch("by-hand/object", utf8("by atm now"), head.etag);
				expect((await store.head("by-hand/object")).sha256).toBe(
					sha256Hex(utf8("by atm now")),
				);
			},
		);

		check(
			"13b: delete of an object without x-amz-meta-sha256 checks the hash of its body",
			async ({ store, writeWithoutMetadata }) => {
				const body = utf8("no metadata");
				await writeWithoutMetadata("by-hand/delete-me", body);
				expect(
					await failureOf(
						store.delete("by-hand/delete-me", sha256Hex(utf8("no"))),
					),
				).toBeInstanceOf(ShaMismatch);
				expect(await store.delete("by-hand/delete-me", sha256Hex(body))).toBe(
					true,
				);
			},
		);

		// ---- Check 14: ranges ----

		check(
			"14: a range GET returns exactly the requested bytes, size is the total, range is set",
			async ({ store }) => {
				const body = utf8("0123456789");
				await store.putIfAbsent("ranged", body);

				const middle = await store.get("ranged", { start: 2, end: 5 });
				expect(new TextDecoder().decode(middle.body)).toBe("2345");
				expect(middle.size).toBe(10);
				expect(middle.range).toEqual({ start: 2, end: 5 });

				const open = await store.get("ranged", { start: 7 });
				expect(new TextDecoder().decode(open.body)).toBe("789");
				expect(open.size).toBe(10);
				expect(open.range).toEqual({ start: 7, end: 9 });

				const single = await store.get("ranged", { start: 0, end: 0 });
				expect(new TextDecoder().decode(single.body)).toBe("0");
				expect(single.range).toEqual({ start: 0, end: 0 });

				const binary = everyByte();
				await store.putIfAbsent("ranged-binary", binary);
				const slice = await store.get("ranged-binary", {
					start: 250,
					end: 255,
				});
				expect(Array.from(slice.body)).toEqual([250, 251, 252, 253, 254, 255]);
				expect(slice.size).toBe(256);
				expect(slice.sha256).toBe(sha256Hex(binary));
			},
		);

		// ---- Check 15: presign ----

		check(
			"15: a presigned GET works, then fails after expiry (Unsupported where there are no URLs)",
			async ({ store, supportsPresign }) => {
				const body = utf8("presigned body");
				await store.putIfAbsent("signed/file name.txt", body);
				if (!supportsPresign) {
					expect(
						await failureOf(
							store.presign("signed/file name.txt", {
								expiresInSeconds: PRESIGN_EXPIRY_SECONDS,
							}),
						),
					).toBeInstanceOf(Unsupported);
					return;
				}
				const url = await store.presign("signed/file name.txt", {
					expiresInSeconds: PRESIGN_EXPIRY_SECONDS,
				});
				const response = await fetch(url);
				expect(response.status).toBe(200);
				expect(
					Array.from(new Uint8Array(await response.arrayBuffer())),
				).toEqual(Array.from(body));

				await sleep(PRESIGN_WAIT_MS);
				const expired = await fetch(url);
				await expired.arrayBuffer();
				expect(expired.ok).toBe(false);
				expect([400, 403]).toContain(expired.status);
			},
		);
	});
};
