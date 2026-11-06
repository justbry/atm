/**
 * Writes a hand-authored case as a scenario bundle: `scenario.json`, `deliveries.jsonl`, `stripe-side.json` and
 * `expected.json` under `fixtures/scenarios/<id>/`. The numbers in the case are written by hand; this only serializes them.
 * `hashes.json` and `stages/` come from `atm scenario check <id> --update` once the bundle passes its hand numbers.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleOfCase, type Case } from "./e2e-matrix.js";

export const BUNDLES_DIRECTORY = join(import.meta.dir, "../fixtures/scenarios");

const pretty = (value: unknown): string =>
	`${JSON.stringify(value, null, "\t")}\n`;

export const writeCaseBundle = async (c: Case): Promise<string> => {
	const bundle = bundleOfCase(c);
	const dir = join(BUNDLES_DIRECTORY, c.id);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "scenario.json"),
		pretty({
			...bundle.scenario,
			...(c.order === undefined ? {} : { order: c.order }),
		}),
	);
	await writeFile(
		join(dir, "deliveries.jsonl"),
		`${bundle.steps.map((step) => JSON.stringify(step)).join("\n")}\n`,
	);
	await writeFile(join(dir, "stripe-side.json"), pretty(bundle.stripeSide));
	await writeFile(join(dir, "expected.json"), pretty(bundle.expected));
	return dir;
};
