import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FolderStore } from "../src/store/folder-store.js";
import { tmp } from "./helpers.js";
import { storeContract } from "./store-contract.js";

storeContract("FolderStore", async () => {
	const root = await tmp("store-folder");
	return {
		store: new FolderStore({ root }),
		cleanup: () => rm(root, { recursive: true, force: true }),
		supportsPresign: false,
		// the ETag IS the sha256 of the bytes, so the folder hashes an object that has no metadata
		hashesMissingMetadata: true,
		writeWithoutMetadata: async (key, body) => {
			const path = join(root, key);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, body);
		},
	};
});
