import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	mkdir,
	open,
	readdir,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { FolderStore } from "../src/store/folder-store.js";
import {
	AlreadyExists,
	NotFound,
	ShaMismatch,
	Stale,
	StoreError,
	sha256Hex,
	Transient,
	Unsupported,
	utf8,
} from "../src/store/store.js";
import { tmp } from "./helpers.js";

const directories: string[] = [];

const makeStore = async (lockStaleAfterMs?: number) => {
	const root = await tmp("folder-store");
	directories.push(root);
	return { root, store: new FolderStore({ root, lockStaleAfterMs }) };
};

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

const settle = async <T>(promise: Promise<T>): Promise<T | Error> => {
	try {
		return await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
};

const LONG_AGO = new Date(Date.now() - 3_600_000);

describe("key validation", () => {
	const invalidKeys: [string, string][] = [
		["empty", ""],
		["leading slash", "/a"],
		["trailing slash", "a/"],
		["dot segment", "a/./b"],
		["dot-dot segment", "a/../b"],
		["escaping the root", "../outside"],
		["leading dot-dot", "../../etc/passwd"],
		["empty segment", "a//b"],
		["backslash", "a\\b"],
		["NUL byte", "a\0b"],
		["lone dot", "."],
		["lone dot-dot", ".."],
		["lock suffix", "a/b.lock"],
		["temp prefix", "a/.atm-tmp-1"],
		["lock suffix in another case", "a/b.LOCK"],
		["temp prefix in another case", "a/.ATM-tmp-1"],
		["lone high surrogate", "a\uD800"],
		["lone low surrogate", "\uDC00/b"],
	];

	for (const [label, key] of invalidKeys) {
		test(`rejects ${label}`, async () => {
			const { store } = await makeStore();
			const body = utf8("x");
			const attempts: (() => Promise<unknown>)[] = [
				() => store.putIfAbsent(key, body),
				() => store.putIfMatch(key, body, sha256Hex(body)),
				() => store.get(key),
				() => store.head(key),
				() => store.delete(key, sha256Hex(body)),
			];
			for (const attempt of attempts) {
				const error = await settle(attempt());
				expect(error).toBeInstanceOf(StoreError);
				expect(error).not.toBeInstanceOf(NotFound);
				expect(error).not.toBeInstanceOf(AlreadyExists);
				expect((error as StoreError).message).toContain("invalid key");
			}
		});
	}

	test("accepts ordinary keys, spaces, dots and non-ASCII", async () => {
		const { store } = await makeStore();
		for (const key of [
			"a/b/c.json",
			"with space/and.dots.in.name",
			".hidden",
			"café/\u{1f600}.txt",
			"..not-a-traversal",
		]) {
			await store.putIfAbsent(key, utf8(key));
			expect((await store.get(key)).body).toEqual(utf8(key));
		}
	});

	test("a key that needs a file and a directory at one path is a StoreError", async () => {
		const { store } = await makeStore();
		await store.putIfAbsent("a", utf8("file"));
		const below = await settle(store.putIfAbsent("a/b", utf8("x")));
		expect(below).toBeInstanceOf(StoreError);
		expect(below).not.toBeInstanceOf(AlreadyExists);

		await store.putIfAbsent("c/d", utf8("file"));
		const above = await settle(store.putIfAbsent("c", utf8("x")));
		expect(above).toBeInstanceOf(StoreError);
		expect(above).not.toBeInstanceOf(AlreadyExists);

		// a directory is not an object
		await expect(store.get("c")).rejects.toBeInstanceOf(NotFound);
		await expect(store.head("c")).rejects.toBeInstanceOf(NotFound);
		expect(await store.delete("c", sha256Hex(utf8("x")))).toBe(false);
		// a file in the middle of a path is not an object path either
		await expect(store.get("a/b")).rejects.toBeInstanceOf(NotFound);
	});

	test("an empty directory left by a delete does not block the key's name", async () => {
		const { store } = await makeStore();
		const body = utf8("x");
		await store.putIfAbsent("c/d", body);
		expect(await store.delete("c/d", sha256Hex(body))).toBe(true);
		await store.putIfAbsent("c", utf8("now a file"));
		expect((await store.get("c")).body).toEqual(utf8("now a file"));
	});

	test("a key never names another key's lock, whatever its case", async () => {
		const { store } = await makeStore(1);
		const body = utf8("keep me");
		await store.putIfAbsent("x", body);
		const error = await settle(store.putIfAbsent("x.LOCK", utf8("lock-ish")));
		expect(error).toBeInstanceOf(StoreError);
		expect((error as StoreError).message).toContain("invalid key");
		// Had "x.LOCK" been accepted, this write would find it as a stale lock on a case-insensitive disk and unlink it.
		await store.putIfMatch("x", utf8("new"), sha256Hex(body));
		expect((await store.get("x")).body).toEqual(utf8("new"));
	});

	test("refuses a key whose path runs through a symbolic link", async () => {
		const { root, store } = await makeStore();
		const outside = await tmp("folder-store-outside");
		directories.push(outside);
		await writeFile(join(outside, "secret"), "outside the root");
		await symlink(outside, join(root, "linked"));
		await symlink(join(outside, "secret"), join(root, "secret-link"));
		const body = utf8("x");
		const attempts: (() => Promise<unknown>)[] = [
			() => store.putIfAbsent("linked/new.txt", body),
			() => store.get("linked/secret"),
			() => store.get("secret-link"),
			() => store.putIfMatch("linked/secret", body, sha256Hex(body)),
			() => store.delete("linked/secret", sha256Hex(body)),
		];
		for (const attempt of attempts) {
			const error = await settle(attempt());
			expect(error).toBeInstanceOf(StoreError);
			expect((error as StoreError).message).toContain("symbolic link");
		}
		expect(await readdir(outside)).toEqual(["secret"]);
	});

	test("presign is unsupported", async () => {
		const { store } = await makeStore();
		await expect(
			store.presign("a", { expiresInSeconds: 60 }),
		).rejects.toBeInstanceOf(Unsupported);
	});
});

describe("hidden files", () => {
	test("list never shows locks, temp files, takeover markers or empty directories", async () => {
		const { root, store } = await makeStore();
		await store.putIfAbsent("dir/real.txt", utf8("real"));
		await writeFile(join(root, "dir/real.txt.lock"), "{}");
		await writeFile(join(root, "dir/.atm-tmp-leftover"), "partial");
		await writeFile(join(root, "dir/.atm-tmp-takeover-1-2-abc"), "");
		await mkdir(join(root, "empty/nested"), { recursive: true });
		await mkdir(join(root, "only-hidden"), { recursive: true });
		await writeFile(join(root, "only-hidden/x.lock"), "{}");

		const flat = await store.list();
		expect(flat.objects.map((object) => object.key)).toEqual(["dir/real.txt"]);
		expect(flat.prefixes).toEqual([]);

		const grouped = await store.list({ delimiter: "/" });
		expect(grouped.objects).toEqual([]);
		expect(grouped.prefixes).toEqual(["dir/"]);
	});

	test("a crash leftover does not break later puts", async () => {
		const { root, store } = await makeStore();
		await mkdir(join(root, "dir"), { recursive: true });
		await writeFile(join(root, "dir/.atm-tmp-crashed"), "half a body");
		await writeFile(join(root, "dir/old.lock"), "{}");

		const first = await store.putIfAbsent("dir/new", utf8("one"));
		const second = await store.putIfMatch("dir/new", utf8("two"), first.etag);
		expect(second.sha256).toBe(sha256Hex(utf8("two")));
		expect((await store.get("dir/new")).body).toEqual(utf8("two"));
		// a key named like the dead lock's base still works: the old lock is stale by mtime only once old
		await store.putIfAbsent("dir/old", utf8("old"));
		const old = await utimes(
			join(root, "dir/old.lock"),
			LONG_AGO,
			LONG_AGO,
		).then(() => store.head("dir/old"));
		await store.putIfMatch("dir/old", utf8("older"), old.etag);
		const names = await readdir(join(root, "dir"));
		expect(names.filter((name) => name.startsWith(".atm-tmp-new"))).toEqual([]);
		expect(names).not.toContain("old.lock");
	});

	test("no temp file or lock stays after puts, a failed match and a delete", async () => {
		const { root, store } = await makeStore();
		const created = await store.putIfAbsent("k", utf8("one"));
		await store.putIfAbsent("k", utf8("again")).catch(() => undefined);
		await store
			.putIfMatch("k", utf8("two"), sha256Hex(utf8("wrong")))
			.catch(() => undefined);
		await store.delete("k", sha256Hex(utf8("wrong"))).catch(() => undefined);
		expect(await readdir(root)).toEqual(["k"]);
		expect(await store.delete("k", created.sha256)).toBe(true);
		expect(await readdir(root)).toEqual([]);
	});
});

describe("locks", () => {
	test("a stale lock is taken over and removed", async () => {
		const { root, store } = await makeStore(1000);
		const created = await store.putIfAbsent("k", utf8("one"));
		const lockPath = join(root, "k.lock");
		await writeFile(lockPath, '{"pid":1,"token":"dead"}');
		await utimes(lockPath, LONG_AGO, LONG_AGO);

		await store.putIfMatch("k", utf8("two"), created.etag);
		expect((await store.get("k")).body).toEqual(utf8("two"));
		expect(await readdir(root)).toEqual(["k"]);
	});

	test("an empty stale lock (crash between create and write) is taken over by delete", async () => {
		const { root, store } = await makeStore(1000);
		const created = await store.putIfAbsent("k", utf8("one"));
		await writeFile(join(root, "k.lock"), "");
		await utimes(join(root, "k.lock"), LONG_AGO, LONG_AGO);
		expect(await store.delete("k", created.sha256)).toBe(true);
		expect(await readdir(root)).toEqual([]);
	});

	test("a busy lock gives Transient within a bounded wait and is left alone", async () => {
		const { root, store } = await makeStore(400);
		const created = await store.putIfAbsent("k", utf8("one"));
		const lockPath = join(root, "k.lock");
		await writeFile(lockPath, '{"pid":1,"token":"someone-else"}');

		const started = Date.now();
		const putError = await settle(
			store.putIfMatch("k", utf8("two"), created.etag),
		);
		expect(putError).toBeInstanceOf(Transient);
		expect(Date.now() - started).toBeLessThan(2000);
		// the put above used up half the stale age; start the delete from a fresh lock
		await utimes(lockPath, new Date(), new Date());
		const deleteError = await settle(store.delete("k", created.sha256));
		expect(deleteError).toBeInstanceOf(Transient);

		expect((await stat(lockPath)).isFile()).toBe(true);
		expect((await store.get("k")).body).toEqual(utf8("one"));
		expect((await readdir(root)).sort()).toEqual(["k", "k.lock"]);
	});

	test("a lock held briefly is waited for", async () => {
		const { root, store } = await makeStore(5000);
		const created = await store.putIfAbsent("k", utf8("one"));
		const lockPath = join(root, "k.lock");
		await writeFile(lockPath, '{"pid":1,"token":"brief"}');
		setTimeout(() => rm(lockPath, { force: true }), 100);
		await store.putIfMatch("k", utf8("two"), created.etag);
		expect((await store.get("k")).body).toEqual(utf8("two"));
	});

	test("many contenders over one stale lock never let two writers in", async () => {
		const { root, store } = await makeStore(300);
		const created = await store.putIfAbsent("k", utf8("zero"));
		const lockPath = join(root, "k.lock");
		await writeFile(lockPath, '{"pid":1,"token":"dead"}');
		await utimes(lockPath, LONG_AGO, LONG_AGO);

		const results = await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				settle(store.putIfMatch("k", utf8(`writer ${index}`), created.etag)),
			),
		);
		const winners = results.filter((result) => !(result instanceof Error));
		const losers = results.filter((result) => result instanceof Error);
		expect(winners).toHaveLength(1);
		for (const loser of losers) expect(loser).toBeInstanceOf(Stale);
		expect((await readdir(root)).sort()).toEqual(["k"]);
	});
});

describe("concurrency", () => {
	test("two putIfMatch with the same ETag: one wins, one is Stale", async () => {
		const { root, store } = await makeStore();
		const created = await store.putIfAbsent("k", utf8("zero"));
		const results = await Promise.all([
			settle(store.putIfMatch("k", utf8("left"), created.etag)),
			settle(store.putIfMatch("k", utf8("right"), created.etag)),
		]);
		const winners = results.filter((result) => !(result instanceof Error));
		const losers = results.filter((result) => result instanceof Error);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		expect(losers[0]).toBeInstanceOf(Stale);
		const winner = winners[0] as { sha256: string };
		expect((await store.head("k")).sha256).toBe(winner.sha256);
		expect(await readdir(root)).toEqual(["k"]);
	});

	test("a chain of concurrent putIfMatch loses no update", async () => {
		const { store } = await makeStore();
		await store.putIfAbsent("counter", utf8("0"));
		const increments = 8;
		const worker = async () => {
			for (;;) {
				const current = await store.get("counter");
				const next = utf8(
					String(Number(new TextDecoder().decode(current.body)) + 1),
				);
				const error = await settle(
					store.putIfMatch("counter", next, current.etag),
				);
				if (!(error instanceof Error)) return;
				if (!(error instanceof Stale || error instanceof Transient))
					throw error;
			}
		};
		await Promise.all(Array.from({ length: increments }, worker));
		expect(new TextDecoder().decode((await store.get("counter")).body)).toBe(
			String(increments),
		);
	});

	test("two putIfAbsent: one creates, the other is AlreadyExists", async () => {
		const { root, store } = await makeStore();
		const results = await Promise.all([
			settle(store.putIfAbsent("deep/k", utf8("left"))),
			settle(store.putIfAbsent("deep/k", utf8("right"))),
		]);
		const winners = results.filter((result) => !(result instanceof Error));
		const losers = results.filter((result) => result instanceof Error);
		expect(winners).toHaveLength(1);
		expect(losers[0]).toBeInstanceOf(AlreadyExists);
		const winner = winners[0] as { sha256: string };
		expect((await store.head("deep/k")).sha256).toBe(winner.sha256);
		expect(await readdir(join(root, "deep"))).toEqual(["k"]);
	});

	test("putIfAbsent over an existing key leaves the bytes untouched", async () => {
		const { store } = await makeStore();
		await store.putIfAbsent("k", utf8("first"));
		await expect(store.putIfAbsent("k", utf8("second"))).rejects.toBeInstanceOf(
			AlreadyExists,
		);
		expect((await store.get("k")).body).toEqual(utf8("first"));
	});

	test("no partial object is visible while a large putIfAbsent runs", async () => {
		const { root, store } = await makeStore();
		const size = 8 * 1024 * 1024;
		const big = new Uint8Array(size).fill(7);
		const path = join(root, "big/object");
		let finished = false;
		const writing = store.putIfAbsent("big/object", big).finally(() => {
			finished = true;
		});
		const sizesSeen = new Set<number>();
		while (!finished) {
			try {
				sizesSeen.add((await stat(path)).size);
			} catch {
				// not there yet
			}
			await new Promise((done) => setImmediate(done));
		}
		await writing;
		sizesSeen.add((await stat(path)).size);
		expect([...sizesSeen]).toEqual([size]);
		expect(await readdir(dirname(path))).toEqual(["object"]);
	});

	test("no partial object is visible while a large putIfMatch replaces one", async () => {
		const { root, store } = await makeStore();
		const size = 8 * 1024 * 1024;
		const created = await store.putIfAbsent("k", new Uint8Array(100).fill(1));
		const big = new Uint8Array(size).fill(2);
		let finished = false;
		const writing = store.putIfMatch("k", big, created.etag).finally(() => {
			finished = true;
		});
		const sizesSeen = new Set<number>();
		while (!finished) {
			sizesSeen.add((await stat(join(root, "k"))).size);
			await new Promise((done) => setImmediate(done));
		}
		await writing;
		sizesSeen.add((await stat(join(root, "k"))).size);
		expect([...sizesSeen].sort()).toEqual([100, size].sort());
	});
});

describe("durability", () => {
	test("putIfAbsent and putIfMatch flush the bytes before the key shows them", async () => {
		const { root, store } = await makeStore();
		const probe = await open(join(root, "probe"), "w");
		const fileHandle = Object.getPrototypeOf(probe);
		await probe.close();
		await rm(join(root, "probe"));
		const path = join(root, "k");
		const keyVisibleAtSync: boolean[] = [];
		const original = fileHandle.sync;
		const spy = spyOn(fileHandle, "sync").mockImplementation(function (
			this: unknown,
		) {
			keyVisibleAtSync.push(existsSync(path));
			return original.call(this);
		});
		try {
			const created = await store.putIfAbsent("k", utf8("one"));
			expect(keyVisibleAtSync[0]).toBe(false);
			const synced = keyVisibleAtSync.length;
			await store.putIfMatch("k", utf8("two"), created.etag);
			expect(keyVisibleAtSync.length).toBeGreaterThan(synced);
		} finally {
			spy.mockRestore();
		}
		expect((await store.get("k")).body).toEqual(utf8("two"));
	});
});

describe("get ranges", () => {
	const text = "0123456789";

	test("serves the inclusive range and the total size", async () => {
		const { store } = await makeStore();
		await store.putIfAbsent("k", utf8(text));
		const got = await store.get("k", { start: 2, end: 5 });
		expect(new TextDecoder().decode(got.body)).toBe("2345");
		expect(got.size).toBe(10);
		expect(got.range).toEqual({ start: 2, end: 5 });
		expect(got.etag).toBe(sha256Hex(utf8(text)));
	});

	test("end defaults to the last byte and is clamped to size - 1", async () => {
		const { store } = await makeStore();
		await store.putIfAbsent("k", utf8(text));
		const open = await store.get("k", { start: 7 });
		expect(new TextDecoder().decode(open.body)).toBe("789");
		expect(open.range).toEqual({ start: 7, end: 9 });
		const clamped = await store.get("k", { start: 8, end: 9999 });
		expect(new TextDecoder().decode(clamped.body)).toBe("89");
		expect(clamped.range).toEqual({ start: 8, end: 9 });
		const last = await store.get("k", { start: 9, end: 9 });
		expect(new TextDecoder().decode(last.body)).toBe("9");
	});

	test("a whole-object get has no range", async () => {
		const { store } = await makeStore();
		await store.putIfAbsent("k", utf8(text));
		const got = await store.get("k");
		expect(got.range).toBeUndefined();
		expect(got.size).toBe(10);
	});

	test("start at or past the size is not satisfiable", async () => {
		const { store } = await makeStore();
		await store.putIfAbsent("k", utf8(text));
		await store.putIfAbsent("empty", new Uint8Array(0));
		for (const [key, range] of [
			["k", { start: 10 }],
			["k", { start: 11, end: 20 }],
			["k", { start: 3, end: 2 }],
			["k", { start: -1 }],
			["empty", { start: 0 }],
		] as const) {
			const error = await settle(store.get(key, range));
			expect(error).toBeInstanceOf(StoreError);
			expect((error as StoreError).message).toContain("range not satisfiable");
		}
	});

	test("a range on a missing key is NotFound", async () => {
		const { store } = await makeStore();
		await expect(store.get("nope", { start: 0 })).rejects.toBeInstanceOf(
			NotFound,
		);
	});
});

describe("delete", () => {
	test("a sha mismatch leaves the file and no lock", async () => {
		const { root, store } = await makeStore();
		const created = await store.putIfAbsent("k", utf8("keep me"));
		const wrong = sha256Hex(utf8("something else"));
		const error = await settle(store.delete("k", wrong));
		expect(error).toBeInstanceOf(ShaMismatch);
		expect((error as ShaMismatch).expected).toBe(wrong);
		expect((error as ShaMismatch).actual).toBe(created.sha256);
		expect((await store.get("k")).body).toEqual(utf8("keep me"));
		expect(await readdir(root)).toEqual(["k"]);
	});

	test("deleting twice: true then false", async () => {
		const { store } = await makeStore();
		const created = await store.putIfAbsent("k", utf8("x"));
		expect(await store.delete("k", created.sha256)).toBe(true);
		expect(await store.delete("k", created.sha256)).toBe(false);
		await expect(store.get("k")).rejects.toBeInstanceOf(NotFound);
	});

	test("deleting a key that never existed is false, even under a missing directory", async () => {
		const { store } = await makeStore();
		expect(await store.delete("no/such/key", sha256Hex(utf8("x")))).toBe(false);
	});

	test("two concurrent deletes: one true, one false", async () => {
		const { store } = await makeStore();
		const created = await store.putIfAbsent("k", utf8("x"));
		const results = await Promise.all([
			store.delete("k", created.sha256),
			store.delete("k", created.sha256),
		]);
		expect(results.sort()).toEqual([false, true]);
	});

	test("putIfMatch on a missing key is NotFound, on a changed one Stale", async () => {
		const { store } = await makeStore();
		await expect(
			store.putIfMatch("missing", utf8("x"), sha256Hex(utf8("x"))),
		).rejects.toBeInstanceOf(NotFound);
		const created = await store.putIfAbsent("k", utf8("one"));
		await store.putIfMatch("k", utf8("two"), created.etag);
		await expect(
			store.putIfMatch("k", utf8("three"), created.etag),
		).rejects.toBeInstanceOf(Stale);
	});
});

describe("list", () => {
	const keys = [
		"a/b/one",
		"a/b/two",
		"a/bc",
		"a/be/deep/x",
		"a/bd",
		"a/c/one",
		"a/z",
		"b",
		"top",
		"zz/1",
		"zz/2",
	];

	const fill = async () => {
		const made = await makeStore();
		for (const key of keys) {
			await made.store.putIfAbsent(key, utf8(`body of ${key}`));
		}
		return made.store;
	};

	/** Every page of a listing, with each key and prefix tagged so double or missing entries show up. */
	const pages = async (
		store: FolderStore,
		options: { prefix?: string; delimiter?: string; maxKeys: number },
	) => {
		const collected: { objects: string[]; prefixes: string[] }[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 100; guard++) {
			const page = await store.list({ ...options, cursor });
			collected.push({
				objects: page.objects.map((object) => object.key),
				prefixes: page.prefixes,
			});
			expect(page.objects.length + page.prefixes.length).toBeLessThanOrEqual(
				options.maxKeys,
			);
			if (page.next === null) return collected;
			cursor = page.next;
		}
		throw new Error("listing did not end");
	};

	test("keys come back in ascending byte order with etag and size", async () => {
		const store = await fill();
		const page = await store.list();
		expect(page.objects.map((object) => object.key)).toEqual([...keys].sort());
		expect(page.prefixes).toEqual([]);
		expect(page.next).toBeNull();
		const first = page.objects[0];
		expect(first?.size).toBe(utf8("body of a/b/one").length);
		expect(first?.etag).toBe(sha256Hex(utf8("body of a/b/one")));
	});

	test("a prefix that is not directory aligned matches by plain string prefix", async () => {
		const store = await fill();
		const page = await store.list({ prefix: "a/b" });
		expect(page.objects.map((object) => object.key)).toEqual([
			"a/b/one",
			"a/b/two",
			"a/bc",
			"a/bd",
			"a/be/deep/x",
		]);
		const grouped = await store.list({ prefix: "a/b", delimiter: "/" });
		expect(grouped.objects.map((object) => object.key)).toEqual([
			"a/bc",
			"a/bd",
		]);
		expect(grouped.prefixes).toEqual(["a/b/", "a/be/"]);
	});

	test("a delimiter collapses to prefix + up to the first delimiter", async () => {
		const store = await fill();
		const top = await store.list({ delimiter: "/" });
		expect(top.objects.map((object) => object.key)).toEqual(["b", "top"]);
		expect(top.prefixes).toEqual(["a/", "zz/"]);
		const inner = await store.list({ prefix: "a/", delimiter: "/" });
		expect(inner.objects.map((object) => object.key)).toEqual([
			"a/bc",
			"a/bd",
			"a/z",
		]);
		expect(inner.prefixes).toEqual(["a/b/", "a/be/", "a/c/"]);
		const exact = await store.list({ prefix: "a/b/", delimiter: "/" });
		expect(exact.objects.map((object) => object.key)).toEqual([
			"a/b/one",
			"a/b/two",
		]);
		expect(exact.prefixes).toEqual([]);
	});

	test("a multi-character delimiter works", async () => {
		const { store } = await makeStore();
		for (const key of ["x/a--1", "x/a--2", "x/b", "y"]) {
			await store.putIfAbsent(key, utf8(key));
		}
		const page = await store.list({ prefix: "x/", delimiter: "--" });
		expect(page.objects.map((object) => object.key)).toEqual(["x/b"]);
		expect(page.prefixes).toEqual(["x/a--"]);
	});

	test("a prefix that matches nothing, or a missing directory, is an empty page", async () => {
		const store = await fill();
		for (const prefix of ["nothing", "a/b/one/deeper", "zzz/"]) {
			expect(await store.list({ prefix })).toEqual({
				objects: [],
				prefixes: [],
				next: null,
			});
		}
		const { store: emptyStore } = await makeStore();
		expect(await emptyStore.list()).toEqual({
			objects: [],
			prefixes: [],
			next: null,
		});
	});

	for (const maxKeys of [1, 2, 3]) {
		test(`pagination with maxKeys ${maxKeys} returns every key once`, async () => {
			const store = await fill();
			const collected = await pages(store, { maxKeys });
			const all = collected.flatMap((page) => page.objects);
			expect(all).toEqual([...keys].sort());
			expect(new Set(all).size).toBe(all.length);
		});

		test(`pagination with a delimiter and maxKeys ${maxKeys} returns every key and prefix once`, async () => {
			const store = await fill();
			for (const prefix of ["", "a/", "a/b", "a/bc", "z"]) {
				const whole = await store.list({ prefix, delimiter: "/" });
				const collected = await pages(store, {
					prefix,
					delimiter: "/",
					maxKeys,
				});
				const objects = collected.flatMap((page) => page.objects);
				const prefixes = collected.flatMap((page) => page.prefixes);
				expect(objects).toEqual(whole.objects.map((object) => object.key));
				expect(prefixes).toEqual(whole.prefixes);
				expect(new Set(prefixes).size).toBe(prefixes.length);
			}
		});
	}

	test("a page boundary right after a common prefix resumes after the whole prefix", async () => {
		const store = await fill();
		const first = await store.list({
			prefix: "a/",
			delimiter: "/",
			maxKeys: 1,
		});
		expect(first.prefixes).toEqual(["a/b/"]);
		expect(first.objects).toEqual([]);
		expect(first.next).not.toBeNull();
		const second = await store.list({
			prefix: "a/",
			delimiter: "/",
			maxKeys: 1,
			cursor: first.next ?? undefined,
		});
		// "a/b/one" and "a/b/two" are inside the finished prefix: the next entry is "a/bc"
		expect(second.objects.map((object) => object.key)).toEqual(["a/bc"]);
	});

	test("the default page size is 1000 and keys and prefixes count together", async () => {
		const { store } = await makeStore();
		for (const key of ["p/1", "p/2", "q", "r", "s"]) {
			await store.putIfAbsent(key, utf8(key));
		}
		const page = await store.list({ delimiter: "/", maxKeys: 3 });
		expect(page.objects.length + page.prefixes.length).toBe(3);
		expect(page.next).not.toBeNull();
		const rest = await store.list({
			delimiter: "/",
			maxKeys: 3,
			cursor: page.next ?? undefined,
		});
		expect(rest.objects.length + rest.prefixes.length).toBe(1);
		expect(rest.next).toBeNull();
	});

	test("order is by UTF-8 bytes, not UTF-16 code units", async () => {
		const { store } = await makeStore();
		// U+FF5E (3 UTF-8 bytes, 1 code unit) sorts below U+1F600 (4 bytes, 2 code units starting with 0xD83D)
		// in UTF-8 but above it in UTF-16 order.
		const high = "\u{1f600}";
		const low = "～";
		await store.putIfAbsent(high, utf8("x"));
		await store.putIfAbsent(low, utf8("x"));
		const page = await store.list();
		expect(page.objects.map((object) => object.key)).toEqual([low, high]);
	});

	test("a malformed cursor is a StoreError", async () => {
		const { store } = await makeStore();
		await expect(
			store.list({ cursor: "!!not a cursor" }),
		).rejects.toBeInstanceOf(StoreError);
	});
});
