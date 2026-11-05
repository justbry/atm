/**
 * A `Store` over a directory tree: keys are relative file paths under `root`. It exists for tests and local runs; R2 is
 * the real store. The ETag of an object IS the sha256 hex of its bytes, so nothing is stored besides the files.
 *
 * Limits of a filesystem against S3 (all documented, none silent):
 *
 * - A key cannot be a file and a directory at once. S3 allows "a" and "a/b" together; here `putIfAbsent("a/b")` while
 *   "a" is a file, and `putIfAbsent("a")` while "a/b" exists, throw `StoreError` (never `AlreadyExists`). An empty
 *   directory left behind by a delete is removed when a key needs its name.
 * - Keys are validated before they touch the disk: no empty key, no leading or trailing "/", no empty, "." or ".."
 *   segment, no backslash, no NUL byte, nothing that resolves outside `root`.
 * - Two names are reserved because the store keeps its own files beside the keys: a segment that ends in ".lock"
 *   (the writer lock `<key>.lock`) and a segment that starts with ".atm-tmp-" (temp files and takeover markers). They
 *   are rejected as keys and never listed, so a crash can leave junk behind but never a phantom object.
 * - A case-insensitive or Unicode-normalizing filesystem (the macOS default) folds keys that S3 keeps apart.
 * - Symbolic links are not followed by `list`.
 * - Hard links must work on the volume (`putIfAbsent` uses `link`); FAT and some network mounts refuse them.
 *
 * Atomicity:
 *
 * - `putIfAbsent` writes the bytes to a temp file in the key's directory, then `link()`s the temp file to the key and
 *   unlinks the temp file. `link` fails with EEXIST when the key exists, atomically, and the key appears with all its
 *   bytes at once. The ADR's `open(path, "wx")` is also create-only, but it makes the key visible empty and then
 *   fills it, so a concurrent reader (or a crash) would see a partial object. Link-after-write cannot.
 * - `putIfMatch` writes its temp file first (outside the lock, so the lock is held for microseconds, never for the
 *   duration of a large write), then takes `<key>.lock`, compares the sha256 of the current bytes with the ETag, and
 *   `rename()`s the temp file over the key. Readers see the old or the new bytes whole.
 *
 * The writer lock (`<key>.lock`, created with the exclusive flag; also taken by `delete`):
 *
 * - It holds `{ pid, token, acquiredAt }`. The token proves ownership: release only unlinks a lock that still holds the
 *   releaser's token, and the holder re-checks the token right before its commit step.
 * - Staleness is the lock file's mtime, not its content (a crash between create and write leaves an empty lock, which
 *   ages out like any other). A lock older than `lockStaleAfterMs` is taken over.
 * - Removing a stale lock is itself raced, and a plain "unlink it" lets two contenders each delete the other's fresh
 *   lock. So a takeover first creates an exclusive marker named after the stale lock's identity (inode and mtime). Only
 *   the contender holding the marker may remove that lock, and it first re-stats the lock: if it is no longer the same
 *   inode and mtime, or no longer stale, it leaves it alone. Others retry. A marker older than `lockStaleAfterMs`
 *   (its owner crashed mid-takeover) is removed, which re-opens a tiny window that needs a crash plus two contenders in the
 *   same instant; the holder's ownership re-check narrows it further.
 * - A lock that is still fresh after a bounded wait (half of `lockStaleAfterMs`, at most 5 s) throws `Transient`.
 *   The wait is shorter than the stale age on purpose: a busy lock reports `Transient` to be retried, a dead one is
 *   taken over on a later call.
 */
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rmdir,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { FolderStoreOptions } from "../types.js";
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

export type { FolderStoreOptions } from "../types.js";

import {
	AlreadyExists,
	NotFound,
	ShaMismatch,
	Stale,
	StoreError,
	sha256Hex,
	Transient,
	Unsupported,
} from "./store.js";

const DEFAULT_LOCK_STALE_AFTER_MS = 30_000;
const MAX_LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 5;
const DEFAULT_MAX_KEYS = 1000;
const LOCK_SUFFIX = ".lock";
const TEMP_PREFIX = ".atm-tmp-";
const LINK_ATTEMPTS = 3;

const sleep = (milliseconds: number): Promise<void> =>
	new Promise((done) => setTimeout(done, milliseconds));

const hasErrorCode = (error: unknown, ...codes: string[]): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	typeof error.code === "string" &&
	codes.includes(error.code);

const isReservedName = (name: string): boolean =>
	name.endsWith(LOCK_SUFFIX) || name.startsWith(TEMP_PREFIX);

const compareUtf8 = (left: Uint8Array, right: Uint8Array): number =>
	Buffer.compare(left, right);

type ListEntry =
	| { kind: "object"; value: string }
	| { kind: "prefix"; value: string };

/** The cursor is the last entry of the previous page, so a resumed page starts strictly after it. */
const encodeCursor = (entry: ListEntry): string =>
	Buffer.from(
		JSON.stringify({ kind: entry.kind, value: entry.value }),
		"utf8",
	).toString("base64url");

const decodeCursor = (cursor: string): ListEntry => {
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"kind" in parsed &&
			"value" in parsed &&
			(parsed.kind === "object" || parsed.kind === "prefix") &&
			typeof parsed.value === "string"
		) {
			return { kind: parsed.kind, value: parsed.value };
		}
	} catch {
		// fall through to the error below
	}
	throw new StoreError("invalid list cursor");
};

export class FolderStore implements Store {
	private readonly root: string;
	private readonly lockStaleAfterMs: number;
	private readonly lockWaitMs: number;

	constructor(options: FolderStoreOptions) {
		this.root = resolve(options.root);
		this.lockStaleAfterMs =
			options.lockStaleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;
		if (!(this.lockStaleAfterMs > 0)) {
			throw new StoreError("lockStaleAfterMs must be positive");
		}
		this.lockWaitMs = Math.min(this.lockStaleAfterMs / 2, MAX_LOCK_WAIT_MS);
	}

	// ---- Keys ----

	/** Validates the key and returns its absolute path. */
	private pathOf(key: string): string {
		const problem = this.keyProblem(key);
		if (problem !== null) throw new StoreError(`invalid key: ${problem}`, key);
		const path = resolve(this.root, key);
		if (!path.startsWith(this.root + sep)) {
			throw new StoreError("invalid key: resolves outside the root", key);
		}
		return path;
	}

	private keyProblem(key: string): string | null {
		if (typeof key !== "string" || key === "") return "empty key";
		if (key.startsWith("/")) return 'leading "/"';
		if (key.endsWith("/")) return 'ends with "/"';
		if (key.includes("\\")) return "contains a backslash";
		if (key.includes("\0")) return "contains a NUL byte";
		for (const segment of key.split("/")) {
			if (segment === "") return "empty segment";
			if (segment === "." || segment === "..") {
				return `"${segment}" segment`;
			}
			if (isReservedName(segment)) {
				return `segment "${segment}" is reserved for the store's own files`;
			}
		}
		return null;
	}

	// ---- Reads ----

	async head(key: string): Promise<StoreHead> {
		const bytes = await this.readObject(key);
		const digest = sha256Hex(bytes);
		return { key, size: bytes.length, etag: digest, sha256: digest };
	}

	async get(
		key: string,
		range?: { start: number; end?: number },
	): Promise<StoreGet> {
		const bytes = await this.readObject(key);
		const digest = sha256Hex(bytes);
		const whole = { key, size: bytes.length, etag: digest, sha256: digest };
		if (range === undefined) return { ...whole, body: bytes };

		const { start } = range;
		if (!Number.isInteger(start) || start < 0) {
			throw new StoreError("range not satisfiable: bad start", key);
		}
		if (range.end !== undefined && !Number.isInteger(range.end)) {
			throw new StoreError("range not satisfiable: bad end", key);
		}
		if (range.end !== undefined && range.end < start) {
			throw new StoreError("range not satisfiable: end before start", key);
		}
		if (start >= bytes.length) {
			throw new StoreError("range not satisfiable", key);
		}
		const end = Math.min(range.end ?? bytes.length - 1, bytes.length - 1);
		return {
			...whole,
			body: bytes.subarray(start, end + 1),
			range: { start, end },
		};
	}

	/** The object's bytes, or `NotFound` (also when the path is a directory or a parent is a file). */
	private async readObject(key: string): Promise<Uint8Array> {
		const path = this.pathOf(key);
		try {
			return await readFile(path);
		} catch (error) {
			if (hasErrorCode(error, "ENOENT", "ENOTDIR", "EISDIR")) {
				throw new NotFound(key);
			}
			throw error;
		}
	}

	// ---- Writes ----

	async putIfAbsent(key: string, body: Uint8Array): Promise<PutResult> {
		const path = this.pathOf(key);
		await this.makeParentDirectory(key, path);
		const tempPath = this.tempPathBeside(path);
		try {
			await writeFile(tempPath, body, { flag: "wx" });
			await this.linkCreateOnly(key, tempPath, path);
		} finally {
			await unlink(tempPath).catch(ignoreMissing);
		}
		const digest = sha256Hex(body);
		return { etag: digest, sha256: digest };
	}

	async putIfMatch(
		key: string,
		body: Uint8Array,
		etag: string,
	): Promise<PutResult> {
		const path = this.pathOf(key);
		if (!(await this.isFile(path))) throw new NotFound(key);

		const tempPath = this.tempPathBeside(path);
		try {
			await writeFile(tempPath, body, { flag: "wx" });
			const lockPath = `${path}${LOCK_SUFFIX}`;
			const token = await this.acquireLock(key, lockPath);
			try {
				const current = await this.readObject(key);
				if (sha256Hex(current) !== etag) throw new Stale(key);
				await this.assertLockHeld(key, lockPath, token);
				await rename(tempPath, path);
			} finally {
				await this.releaseLock(lockPath, token);
			}
		} finally {
			await unlink(tempPath).catch(ignoreMissing);
		}
		const digest = sha256Hex(body);
		return { etag: digest, sha256: digest };
	}

	async delete(key: string, expectedSha256: string): Promise<boolean> {
		const path = this.pathOf(key);
		if (!(await this.isFile(path))) return false;

		const lockPath = `${path}${LOCK_SUFFIX}`;
		let token: string;
		try {
			token = await this.acquireLock(key, lockPath);
		} catch (error) {
			if (error instanceof NotFound) return false;
			throw error;
		}
		try {
			let current: Uint8Array;
			try {
				current = await this.readObject(key);
			} catch (error) {
				if (error instanceof NotFound) return false;
				throw error;
			}
			const actual = sha256Hex(current);
			if (actual !== expectedSha256) {
				throw new ShaMismatch(key, expectedSha256, actual);
			}
			await this.assertLockHeld(key, lockPath, token);
			await unlink(path);
			return true;
		} finally {
			await this.releaseLock(lockPath, token);
		}
	}

	presign(_key: string, _options: PresignOptions): Promise<string> {
		return Promise.reject(new Unsupported("presign"));
	}

	private tempPathBeside(path: string): string {
		return join(dirname(path), `${TEMP_PREFIX}${randomUUID()}`);
	}

	private async isFile(path: string): Promise<boolean> {
		try {
			return (await stat(path)).isFile();
		} catch (error) {
			if (hasErrorCode(error, "ENOENT", "ENOTDIR")) return false;
			throw error;
		}
	}

	private async makeParentDirectory(key: string, path: string): Promise<void> {
		try {
			await mkdir(dirname(path), { recursive: true });
		} catch (error) {
			if (hasErrorCode(error, "ENOTDIR", "EEXIST")) {
				throw new StoreError(
					`${key} needs a directory where a key (a file) already exists`,
					key,
				);
			}
			throw error;
		}
	}

	/** `link()` is create-only and atomic. A directory in the way is removed if empty, else it is a key/prefix clash. */
	private async linkCreateOnly(
		key: string,
		tempPath: string,
		path: string,
	): Promise<void> {
		for (let attempt = 1; attempt <= LINK_ATTEMPTS; attempt++) {
			try {
				await link(tempPath, path);
				return;
			} catch (error) {
				if (hasErrorCode(error, "ENOENT")) {
					// The parent directory vanished under us (a concurrent cleanup): make it again.
					await this.makeParentDirectory(key, path);
					continue;
				}
				if (!hasErrorCode(error, "EEXIST")) throw error;
				const existing = await lstat(path).catch((statError: unknown) => {
					if (hasErrorCode(statError, "ENOENT")) return null;
					throw statError;
				});
				if (existing === null) continue;
				if (!existing.isDirectory()) throw new AlreadyExists(key);
				try {
					await rmdir(path);
				} catch (rmdirError) {
					if (hasErrorCode(rmdirError, "ENOTEMPTY", "EEXIST")) {
						throw new StoreError(
							`${key} is a prefix of existing keys; a filesystem cannot hold both`,
							key,
						);
					}
					if (!hasErrorCode(rmdirError, "ENOENT")) throw rmdirError;
				}
			}
		}
		throw new Transient(key, `${key} kept changing while it was created`);
	}

	// ---- Writer lock ----

	private async acquireLock(key: string, lockPath: string): Promise<string> {
		const token = randomUUID();
		const content = JSON.stringify({
			pid: process.pid,
			token,
			acquiredAt: new Date().toISOString(),
		});
		const deadline = Date.now() + this.lockWaitMs;
		for (;;) {
			try {
				await writeFile(lockPath, content, { flag: "wx" });
				return token;
			} catch (error) {
				if (hasErrorCode(error, "ENOENT", "ENOTDIR")) throw new NotFound(key);
				if (!hasErrorCode(error, "EEXIST")) throw error;
			}
			if (await this.removeIfStale(lockPath)) continue;
			if (Date.now() >= deadline) {
				throw new Transient(key, `${key} is locked by another writer`);
			}
			await sleep(LOCK_POLL_MS);
		}
	}

	/** True when the lock is gone (removed here or vanished), so the caller should try to create it again. */
	private async removeIfStale(lockPath: string): Promise<boolean> {
		const seen = await this.statOrNull(lockPath);
		if (seen === null) return true;
		if (this.isStale(seen.mtimeMs)) {
			return await this.takeOver(lockPath, seen);
		}
		return false;
	}

	private isStale(mtimeMs: number): boolean {
		return Date.now() - mtimeMs > this.lockStaleAfterMs;
	}

	private async takeOver(
		lockPath: string,
		seen: { ino: number; mtimeMs: number },
	): Promise<boolean> {
		const markerPath = join(
			dirname(lockPath),
			`${TEMP_PREFIX}takeover-${seen.ino}-${Math.trunc(seen.mtimeMs)}-${sha256Hex(Buffer.from(lockPath)).slice(0, 16)}`,
		);
		try {
			await writeFile(markerPath, "", { flag: "wx" });
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
			// Another contender holds the marker; if its owner crashed, the marker ages out like a lock.
			const marker = await this.statOrNull(markerPath);
			if (marker !== null && this.isStale(marker.mtimeMs)) {
				await unlink(markerPath).catch(ignoreMissing);
			}
			return false;
		}
		try {
			const again = await this.statOrNull(lockPath);
			if (again === null) return true;
			const unchanged =
				again.ino === seen.ino && again.mtimeMs === seen.mtimeMs;
			if (!unchanged || !this.isStale(again.mtimeMs)) return false;
			await unlink(lockPath).catch(ignoreMissing);
			return true;
		} finally {
			await unlink(markerPath).catch(ignoreMissing);
		}
	}

	private async statOrNull(
		path: string,
	): Promise<{ ino: number; mtimeMs: number } | null> {
		try {
			const { ino, mtimeMs } = await stat(path);
			return { ino, mtimeMs };
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return null;
			throw error;
		}
	}

	private async lockHolds(lockPath: string, token: string): Promise<boolean> {
		try {
			return (await readFile(lockPath, "utf8")).includes(token);
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return false;
			throw error;
		}
	}

	/** A holder stalled past the stale age may have been taken over; it must not commit then. */
	private async assertLockHeld(
		key: string,
		lockPath: string,
		token: string,
	): Promise<void> {
		if (!(await this.lockHolds(lockPath, token))) {
			throw new Transient(key, `${key}: the writer lock was taken over`);
		}
	}

	private async releaseLock(lockPath: string, token: string): Promise<void> {
		if (await this.lockHolds(lockPath, token)) {
			await unlink(lockPath).catch(ignoreMissing);
		}
	}

	// ---- List ----

	async list(options: ListOptions = {}): Promise<ListPage> {
		const prefix = options.prefix ?? "";
		const delimiter = options.delimiter === "" ? undefined : options.delimiter;
		const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
		if (!Number.isInteger(maxKeys) || maxKeys < 0) {
			throw new StoreError("maxKeys must be a non-negative integer");
		}
		const after =
			options.cursor === undefined ? null : decodeCursor(options.cursor);

		const entries = this.entriesAfter(
			await this.collectKeys(prefix),
			prefix,
			delimiter,
			after,
		);
		const page = entries.slice(0, maxKeys);
		const truncated = entries.length > maxKeys && page.length > 0;

		const objects: StoreObject[] = [];
		const prefixes: string[] = [];
		for (const entry of page) {
			if (entry.kind === "prefix") {
				prefixes.push(entry.value);
				continue;
			}
			const object = await this.describe(entry.value);
			if (object !== null) objects.push(object);
		}
		const last = page.at(-1);
		return {
			objects,
			prefixes,
			next: truncated && last !== undefined ? encodeCursor(last) : null,
		};
	}

	/** Every key under the root that can match `prefix`, in ascending UTF-8 byte order. */
	private async collectKeys(prefix: string): Promise<string[]> {
		const keys: string[] = [];
		const walk = async (directory: string, keyPrefix: string) => {
			let children: Dirent[];
			try {
				children = await readdir(directory, { withFileTypes: true });
			} catch (error) {
				if (hasErrorCode(error, "ENOENT", "ENOTDIR")) return;
				throw error;
			}
			for (const child of children) {
				if (isReservedName(child.name)) continue;
				const childKey = `${keyPrefix}${child.name}`;
				if (child.isDirectory()) {
					const directoryKey = `${childKey}/`;
					const canMatch =
						directoryKey.startsWith(prefix) || prefix.startsWith(directoryKey);
					if (canMatch) await walk(join(directory, child.name), directoryKey);
				} else if (child.isFile() && childKey.startsWith(prefix)) {
					keys.push(childKey);
				}
			}
		};
		await walk(this.root, "");
		return keys
			.map((key) => ({ key, bytes: Buffer.from(key, "utf8") }))
			.sort((left, right) => compareUtf8(left.bytes, right.bytes))
			.map(({ key }) => key);
	}

	/** Keys (sorted) become objects and collapsed common prefixes, dropping everything up to and including `after`. */
	private entriesAfter(
		sortedKeys: string[],
		prefix: string,
		delimiter: string | undefined,
		after: ListEntry | null,
	): ListEntry[] {
		const afterBytes = after === null ? null : Buffer.from(after.value, "utf8");
		const entries: ListEntry[] = [];
		let lastPrefix: string | null = null;
		for (const key of sortedKeys) {
			const remainder = key.slice(prefix.length);
			const delimiterAt =
				delimiter === undefined ? -1 : remainder.indexOf(delimiter);
			if (delimiter !== undefined && delimiterAt >= 0) {
				const common = `${prefix}${remainder.slice(0, delimiterAt + delimiter.length)}`;
				if (common === lastPrefix) continue;
				lastPrefix = common;
				if (isBeforeOrAt(common, "prefix", after, afterBytes)) continue;
				entries.push({ kind: "prefix", value: common });
				continue;
			}
			if (isBeforeOrAt(key, "object", after, afterBytes)) continue;
			entries.push({ kind: "object", value: key });
		}
		return entries;
	}

	private async describe(key: string): Promise<StoreObject | null> {
		try {
			const { size, etag } = await this.head(key);
			return { key, size, etag };
		} catch (error) {
			// Deleted between the directory walk and now: not an object any more.
			if (error instanceof NotFound) return null;
			throw error;
		}
	}
}

/**
 * Whether an entry sorts at or before the cursor. After an object cursor, everything up to that key is done; after a
 * prefix cursor, the whole common prefix is done, and every key inside it starts with it, so the entry is skipped when
 * it is that prefix or sorts below it.
 */
const isBeforeOrAt = (
	value: string,
	kind: ListEntry["kind"],
	after: ListEntry | null,
	afterBytes: Buffer | null,
): boolean => {
	if (after === null || afterBytes === null) return false;
	if (
		after.kind === "prefix" &&
		kind === "object" &&
		value.startsWith(after.value)
	) {
		return true;
	}
	return compareUtf8(Buffer.from(value, "utf8"), afterBytes) <= 0;
};

const ignoreMissing = (error: unknown): void => {
	if (!hasErrorCode(error, "ENOENT")) throw error;
};
