/**
 * The Store contract against staging R2, plus the two checks only R2 can answer: rate limiting (check 8) and
 * temporary credentials scoped to a prefix (check 16). Skipped unless the staging bucket's variables are set:
 *
 *   ATM_R2_ENDPOINT           https://<account>.r2.cloudflarestorage.com
 *   ATM_R2_BUCKET             the staging bucket (every run writes under contract/<uuid>/ and deletes it again)
 *   ATM_R2_ACCESS_KEY_ID      an R2 API token's access key (object read and write on that bucket)
 *   ATM_R2_SECRET_ACCESS_KEY
 *
 * Check 16 also needs the Cloudflare account to mint temporary credentials; without these it is skipped:
 *
 *   ATM_R2_ACCOUNT_ID         the Cloudflare account id
 *   ATM_R2_API_TOKEN          a Cloudflare API token allowed to create R2 temporary access credentials
 *
 * The parent access key of the temporary credentials is ATM_R2_ACCESS_KEY_ID.
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { R2Store } from "../src/store/r2-store.js";
import { replaceIfMatch, Stale, Transient, utf8 } from "../src/store/store.js";
import { emptyStore, failureOf, storeContract } from "./store-contract.js";

const endpoint = process.env.ATM_R2_ENDPOINT;
const bucket = process.env.ATM_R2_BUCKET;
const accessKeyId = process.env.ATM_R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.ATM_R2_SECRET_ACCESS_KEY;
const accountId = process.env.ATM_R2_ACCOUNT_ID;
const apiToken = process.env.ATM_R2_API_TOKEN;

const hasR2 = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
const canMintTemporaryCredentials = hasR2 && Boolean(accountId && apiToken);

const TEST_TIMEOUT_MS = 120_000;
const QUICK_WRITES = 5;
const RACING_WRITERS = 20;
const RETRIES_PER_WRITE = 10;
const RETRY_PAUSE_MS = 500;
const TEMPORARY_CREDENTIAL_SECONDS = 900;

const sleep = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const encodePath = (key: string) =>
	key.split("/").map(encodeURIComponent).join("/");

type Credentials = {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
};

const requireEnv = (value: string | undefined, name: string): string => {
	if (value === undefined || value === "")
		throw new Error(`${name} is not set`);
	return value;
};

const parentCredentials = (): Credentials => ({
	accessKeyId: requireEnv(accessKeyId, "ATM_R2_ACCESS_KEY_ID"),
	secretAccessKey: requireEnv(secretAccessKey, "ATM_R2_SECRET_ACCESS_KEY"),
});

const storeOn = (
	prefix: string,
	credentials: Credentials,
	extra: {
		fetch?: typeof fetch;
		maxTries?: number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
) =>
	new R2Store({
		endpoint: requireEnv(endpoint, "ATM_R2_ENDPOINT"),
		bucket: requireEnv(bucket, "ATM_R2_BUCKET"),
		prefix,
		...credentials,
		region: "auto",
		...extra,
	});

const newRunPrefix = () => `contract/${randomUUID()}/`;

describe.skipIf(!hasR2)("staging R2", () => {
	storeContract("R2Store on staging R2", async () => {
		const prefix = newRunPrefix();
		const store = storeOn(prefix, parentCredentials());
		const client = new AwsClient({
			...parentCredentials(),
			service: "s3",
			region: "auto",
		});
		return {
			store,
			cleanup: () => emptyStore(store),
			supportsPresign: true,
			hashesMissingMetadata: false,
			writeWithoutMetadata: async (key, body) => {
				const url = `${requireEnv(endpoint, "ATM_R2_ENDPOINT")}/${requireEnv(bucket, "ATM_R2_BUCKET")}/${encodePath(`${prefix}${key}`)}`;
				const response = await client.fetch(url, { method: "PUT", body });
				const text = await response.text();
				if (response.status !== 200) {
					throw new Error(`raw put ${key}: HTTP ${response.status} ${text}`);
				}
			},
		};
	});

	test(
		"8: quick writes to one key surface 429 as Transient and retry, never as Stale; racing If-Match PUTs have one winner",
		async () => {
			let rateLimited = 0;
			const countingFetch = (async (...args: Parameters<typeof fetch>) => {
				const response = await globalThis.fetch(...args);
				if (response.status === 429) rateLimited++;
				return response;
			}) as typeof fetch;
			// maxTries 1: the store's own retries are off, so a 429 reaches the test as Transient.
			const store = storeOn(newRunPrefix(), parentCredentials(), {
				fetch: countingFetch,
				maxTries: 1,
			});
			try {
				const created = await store.putIfAbsent("hot", utf8("v0"));
				let etag = created.etag;
				let transientSeen = 0;
				for (let write = 1; write <= QUICK_WRITES; write++) {
					const body = utf8(`v${write}`);
					let landed = false;
					for (
						let attempt = 0;
						attempt < RETRIES_PER_WRITE && !landed;
						attempt++
					) {
						try {
							await replaceIfMatch(store, "hot", body, etag);
							landed = true;
						} catch (error) {
							// a 429 is Transient; Stale here would mean a 429 was read as a lost race
							expect(error).toBeInstanceOf(Transient);
							transientSeen++;
							await sleep(RETRY_PAUSE_MS);
						}
					}
					expect(landed).toBe(true);
					etag = (await store.head("hot")).etag;
				}
				expect(new TextDecoder().decode((await store.get("hot")).body)).toBe(
					`v${QUICK_WRITES}`,
				);

				// 20 racing If-Match PUTs with the same ETag
				const outcomes = await Promise.allSettled(
					Array.from({ length: RACING_WRITERS }, (_, index) =>
						store.putIfMatch("hot", utf8(`racer ${index}`), etag),
					),
				);
				const winners = outcomes.filter(
					(outcome) => outcome.status === "fulfilled",
				);
				const rejections = outcomes.flatMap((outcome) =>
					outcome.status === "rejected" ? [outcome.reason as unknown] : [],
				);
				const stale = rejections.filter((reason) => reason instanceof Stale);
				const transient = rejections.filter(
					(reason) => reason instanceof Transient,
				);
				process.stderr.write(
					`R2 check 8: ${rateLimited} responses were 429; sequential Transient ${transientSeen}; racing winners ${winners.length}, Stale ${stale.length}, Transient ${transient.length}\n`,
				);
				expect(stale.length + transient.length).toBe(rejections.length);
				expect(winners.length).toBeLessThanOrEqual(1);
				// every racer got a verdict, so one of them must have won
				if (transient.length === 0) expect(winners).toHaveLength(1);
			} finally {
				await emptyStore(store);
			}
		},
		TEST_TIMEOUT_MS,
	);

	test.skipIf(!canMintTemporaryCredentials)(
		"16: a session-token credential is refused outside its prefix, on LIST and GET",
		async () => {
			const runPrefix = newRunPrefix();
			const parent = storeOn(runPrefix, parentCredentials());
			try {
				await parent.putIfAbsent("inside/doc", utf8("allowed"));
				await parent.putIfAbsent("outside/doc", utf8("forbidden"));

				const minted = await mintTemporaryCredentials(`${runPrefix}inside/`);
				const inside = storeOn(`${runPrefix}inside/`, minted);
				expect(new TextDecoder().decode((await inside.get("doc")).body)).toBe(
					"allowed",
				);
				expect(
					(await inside.list()).objects.map((object) => object.key),
				).toEqual(["doc"]);

				const outside = storeOn(`${runPrefix}outside/`, minted);
				expect(await failureOf(outside.get("doc"))).toBeInstanceOf(Error);
				expect(await failureOf(outside.list())).toBeInstanceOf(Error);
				// broader than the credential's prefix is refused as well
				const wide = storeOn(runPrefix, minted);
				expect(await failureOf(wide.get("outside/doc"))).toBeInstanceOf(Error);
				expect(await failureOf(wide.list())).toBeInstanceOf(Error);

				// the refused reads did not disturb the object
				expect(
					new TextDecoder().decode((await parent.get("outside/doc")).body),
				).toBe("forbidden");
			} finally {
				await emptyStore(parent);
			}
		},
		TEST_TIMEOUT_MS,
	);
});

/** Cloudflare's temp-access-credentials API: read and write on one prefix of the bucket, for a few minutes. */
const mintTemporaryCredentials = async (
	prefix: string,
): Promise<Credentials> => {
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${requireEnv(accountId, "ATM_R2_ACCOUNT_ID")}/r2/temp-access-credentials`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${requireEnv(apiToken, "ATM_R2_API_TOKEN")}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				bucket: requireEnv(bucket, "ATM_R2_BUCKET"),
				parentAccessKeyId: requireEnv(accessKeyId, "ATM_R2_ACCESS_KEY_ID"),
				permission: "object-read-write",
				ttlSeconds: TEMPORARY_CREDENTIAL_SECONDS,
				prefixes: [prefix],
			}),
		},
	);
	const payload = (await response.json()) as {
		success?: boolean;
		result?: Credentials;
		errors?: unknown;
	};
	if (!response.ok || !payload.success || !payload.result) {
		throw new Error(
			`minting temporary credentials failed: HTTP ${response.status} ${JSON.stringify(payload.errors)}`,
		);
	}
	const {
		accessKeyId: id,
		secretAccessKey: secret,
		sessionToken,
	} = payload.result;
	return { accessKeyId: id, secretAccessKey: secret, sessionToken };
};
