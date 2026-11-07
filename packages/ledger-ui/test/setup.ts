import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** The mart fixtures are generated, not committed: build them before any test imports them (scripts/import-mart.ts). */
const packageRoot = join(import.meta.dir, "..");
if (!existsSync(join(packageRoot, "src/fixtures/mart/documents.json"))) {
	const result = spawnSync("bun", ["scripts/import-mart.ts"], {
		cwd: packageRoot,
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(`could not generate the mart fixtures:\n${result.stderr}`);
}

GlobalRegistrator.register({ url: "https://ledger.test/" });
