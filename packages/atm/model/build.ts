#!/usr/bin/env bun
/**
 * Writes, on demand, what the ledger model (`model/ledger.v1.json`, resolved against `kpis/school.v1.json`) generates:
 * the KPI catalog, the disclosure class table, the KPI document's OpenAPI components and the JSON-LD context
 * (`src/model/generate.ts`). Nothing reads these files and none is committed: the Worker computes the catalog in-process
 * (`src/ledger/kpi-catalog.ts`) and the tests compute every value in memory. The default directory, `dist/model/`, is
 * ignored by git.
 * Usage: bun model/build.ts [--out <dir>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { generateModelFiles } from "../src/model/generate.js";
import { LEDGER_MODEL } from "../src/model/ledger-model.js";

const packageRoot = join(import.meta.dir, "..");
const outFlag = process.argv.indexOf("--out");
const outValue = outFlag === -1 ? undefined : process.argv[outFlag + 1];
if (outFlag !== -1 && (outValue === undefined || outValue.startsWith("--"))) {
	process.stderr.write(
		"--out needs a directory\nUsage: bun model/build.ts [--out <dir>]\n",
	);
	process.exit(1);
}
const directory =
	outValue === undefined ? join(packageRoot, "dist/model") : resolve(outValue);

const files = generateModelFiles(LEDGER_MODEL);
mkdirSync(directory, { recursive: true });
for (const file of files)
	writeFileSync(join(directory, file.name), file.content);
const fromHere = relative(process.cwd(), directory);
const shown = fromHere.startsWith("..") ? directory : fromHere || ".";
process.stdout.write(
	`wrote ${files.length} files to ${shown}: ${files.map((file) => file.name).join(", ")}\n`,
);
