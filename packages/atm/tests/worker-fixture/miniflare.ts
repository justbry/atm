/** What the Miniflare tests share: the compatibility date, the bucket binding, seeding it from a folder, reaching it from Node. */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Miniflare, MiniflareOptions } from "miniflare";

export const COMPATIBILITY_DATE = "2026-07-01";
export const BUCKET = "BUCKET";

type Module = { type: "ESModule"; path: string; contents: string };

/** A Worker of `script` (one module, `worker.js`) or of several modules (the first is the entry), over an R2 bucket. */
export const workerOptions = (
	script: string | Module[],
	compatibilityFlags: string[],
): MiniflareOptions => ({
	modules:
		typeof script === "string"
			? [{ type: "ESModule", path: "worker.js", contents: script }]
			: script,
	compatibilityDate: COMPATIBILITY_DATE,
	// IPv4 explicitly: "localhost" has intermittently failed to connect (EADDRNOTAVAIL) while Miniflare started
	host: "127.0.0.1",
	compatibilityFlags,
	r2Buckets: [BUCKET],
});

/** The part of the bucket these tests use: Miniflare types it from `@cloudflare/workers-types`, which the package does not install. */
export type TestBucket = {
	put(key: string, value: Uint8Array): Promise<unknown>;
	get(key: string): Promise<{ text(): Promise<string> } | null>;
};
export const bucketOf = async (miniflare: Miniflare): Promise<TestBucket> =>
	(await miniflare.getR2Bucket(BUCKET)) as unknown as TestBucket;

const filesUnder = async (directory: string): Promise<string[]> => {
	const found: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...(await filesUnder(path)));
		else found.push(path);
	}
	return found.sort();
};

/** Puts every file under `root` into the bucket, keyed by its path relative to `root` (but `expected.json`). */
export const seedBucket = async (
	miniflare: Miniflare,
	root: string,
): Promise<void> => {
	const bucket = await bucketOf(miniflare);
	for (const path of await filesUnder(root)) {
		const key = relative(root, path);
		if (key === "expected.json") continue;
		await bucket.put(key, await readFile(path));
	}
};
