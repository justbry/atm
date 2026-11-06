/**
 * A scenario bundle: one case as plain data, a directory of five files that any consumer can load and replay.
 *
 *   scenario.json     who and what: the school, its menu, the case's title and the inputs the runner needs (the caller's
 *                     fee lookup, the Stripe price ids of recorded deliveries). A generated profile names `profile`, `seed`
 *                     and `params` instead of deliveries.
 *   deliveries.jsonl  one line per step, in delivery order: whole Stripe events with `atMs`, and the few things the family
 *                     service does between them (`erase`, `ship`, `combine`, `lapse`). Duplicates and reorders are written
 *                     out; nothing is shuffled at load time.
 *   stripe-side.json  the reconcile oracle per school: Stripe's balance transactions, payouts, refunds, disputes, invoices.
 *   expected.json     the hand-written numbers, never computed: what the handler must answer, what each book's reports must
 *                     say, which differences `atm reconcile` must print.
 *   hashes.json       the golden H1 to H8 checkpoints (`checkpoints.ts`). These stay inside tests, CI and the job: never put
 *                     one in anything a viewer can read.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	BundleExpected,
	BundleHashes,
	BundleScenario,
	BundleStep,
	ReconcileStripe,
	ScenarioBundle,
} from "../types.js";

const FILES = {
	scenario: "scenario.json",
	deliveries: "deliveries.jsonl",
	stripeSide: "stripe-side.json",
	expected: "expected.json",
	hashes: "hashes.json",
} as const;

/** The folder the committed bundles live in: `fixtures/scenarios` beside `src` (and `dist`) of the package. */
export const defaultBundlesDirectory = (): string => {
	let directory = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 4; depth++) {
		const candidate = join(directory, "fixtures", "scenarios");
		if (existsSync(candidate)) return candidate;
		directory = dirname(directory);
	}
	throw new Error(
		"fixtures/scenarios was not found next to the package; pass the folder to loadScenarioBundles",
	);
};

const readJson = async <T>(path: string): Promise<T> =>
	JSON.parse(await readFile(path, "utf8")) as T;

/** One bundle from its folder. A missing `hashes.json` is an empty set of goldens (a bundle not yet updated). */
export const loadScenarioBundle = async (
	dir: string,
): Promise<ScenarioBundle> => {
	const scenario = await readJson<BundleScenario>(join(dir, FILES.scenario));
	const deliveries = await readFile(join(dir, FILES.deliveries), "utf8").catch(
		() => "",
	);
	const steps = deliveries
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as BundleStep);
	const stripeSide = await readJson<Record<string, ReconcileStripe>>(
		join(dir, FILES.stripeSide),
	).catch(() => ({}));
	const expected = await readJson<BundleExpected>(join(dir, FILES.expected));
	const hashes = await readJson<BundleHashes>(join(dir, FILES.hashes)).catch(
		(): BundleHashes => ({ version: 1 }),
	);
	return {
		id: scenario.id,
		dir,
		scenario,
		steps,
		stripeSide,
		expected,
		hashes,
	};
};

/** Every bundle under `directory` (default: the package's own), by id. */
export const loadScenarioBundles = async (
	directory: string = defaultBundlesDirectory(),
): Promise<ScenarioBundle[]> => {
	const names = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const bundles: ScenarioBundle[] = [];
	for (const name of names)
		if (existsSync(join(directory, name, FILES.scenario)))
			bundles.push(await loadScenarioBundle(join(directory, name)));
	return bundles;
};

/** `<dir|id>` as `atm scenario check` takes it: an existing folder, or an id under the committed folder. */
export const resolveBundleDirectory = (
	target: string,
	directory: string = defaultBundlesDirectory(),
): string =>
	existsSync(join(target, FILES.scenario)) ? target : join(directory, target);

/** The bundle's books, in order. */
export const bundleSchools = (scenario: BundleScenario): string[] =>
	scenario.schools ?? [scenario.school];

/** Writes `hashes.json` (sorted keys, one trailing newline). */
export const writeBundleHashes = async (
	dir: string,
	hashes: BundleHashes,
): Promise<void> => {
	await writeFile(
		join(dir, FILES.hashes),
		`${JSON.stringify(sortedCopy(hashes), null, "\t")}\n`,
	);
};

const sortedCopy = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(sortedCopy);
	if (typeof value === "object" && value !== null)
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, entry]) => [key, sortedCopy(entry)]),
		);
	return value;
};

export const BUNDLE_FILES = FILES;
