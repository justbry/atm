/**
 * The Store contract against `R2BindingStore` over an R2 bucket binding in Miniflare (workerd's own R2 implementation,
 * on disk in memory): the same suite FolderStore and R2Store pass. The store runs in this process against the binding
 * Miniflare hands back; `ledger-read-workerd.test.ts` runs it inside workerd.
 */
import { afterAll, beforeAll } from "bun:test";
import { Miniflare } from "miniflare";
import {
	R2BindingStore,
	type R2BucketBinding,
} from "../src/store/r2-binding-store.js";
import { emptyStore, storeContract } from "./store-contract.js";
import { BUCKET, workerOptions } from "./worker-fixture/miniflare.js";

let miniflare: Miniflare;
let bucket: R2BucketBinding;
beforeAll(async () => {
	miniflare = new Miniflare(
		workerOptions("export default { fetch: () => new Response('ok') };", []),
	);
	await miniflare.ready;
	bucket = (await miniflare.getR2Bucket(BUCKET)) as unknown as R2BucketBinding;
}, 60_000);
afterAll(async () => {
	await miniflare.dispose();
});

storeContract("R2BindingStore over Miniflare", async () => {
	const store = new R2BindingStore(bucket);
	return {
		store,
		cleanup: () => emptyStore(store),
		supportsPresign: false,
		// a binding does not hash an object that was put without our metadata
		hashesMissingMetadata: false,
		writeWithoutMetadata: async (key, body) => {
			await bucket.put(key, body, {});
		},
	};
});
