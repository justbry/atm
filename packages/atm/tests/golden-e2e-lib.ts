/**
 * Shared by `golden-e2e-check.test.ts` and `scripts/golden-e2e-scale.ts`: the real `atm` command line as a separate process, a
 * world (file-backed WAL SQLite plus a folder) built from the golden fixtures, fingerprints of what a command may not change,
 * and the record of what each check found.
 *
 * Everything here drives the product through its command line. The only library calls are the ones that build the input (the
 * reference handler delivering a fixture's Stripe events into a database file, the harness) and the ones that read an answer
 * back to compare it (`readEvents`, a hash, a grep).
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleSchools } from "../src/scenario/bundle.js";
import { runBundle } from "../src/scenario/bundle-run.js";
import type { ReconcileStripe, ScenarioBundle } from "../src/types.js";

export const PACKAGE_DIR = join(import.meta.dir, "..");
export const BIN_SOURCE = join(PACKAGE_DIR, "src/bin.ts");
export const BIN_DIST = join(PACKAGE_DIR, "dist/atm.js");
export const KILL_WRAPPER = join(PACKAGE_DIR, "scripts/golden-e2e-kill.ts");

export type Cli = {
	code: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
};

/** `atm <args>` as a separate process: `bun src/bin.ts` or the built `dist/atm.js`, in the environment given. */
export const atm = (
	args: readonly string[],
	options: { bin?: string; env?: Record<string, string> } = {},
): Cli => {
	const run = Bun.spawnSync(
		[process.execPath, options.bin ?? BIN_SOURCE, ...args],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...options.env },
		},
	);
	return {
		code: run.exitCode,
		signal: run.signalCode ?? null,
		stdout: run.stdout.toString(),
		stderr: run.stderr.toString(),
	};
};

export const sha256 = (bytes: string | Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

/** Every file under `dir` as `relative path -> sha256 + size` (a name that is not a file, such as a socket, is left out). */
export const fingerprint = (dir: string, rel = ""): Record<string, string> => {
	const out: Record<string, string> = {};
	if (!existsSync(join(dir, rel))) return out;
	for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) Object.assign(out, fingerprint(dir, path));
		else if (entry.isFile() && entry.name.endsWith("-shm"))
			// the WAL index is shared memory a reader updates by design; only its presence is part of the state
			out[path] = "wal-index";
		else if (entry.isFile()) {
			const bytes = readFileSync(join(dir, path));
			out[path] = `${sha256(bytes)} ${bytes.length}`;
		}
	}
	return out;
};

/** The paths whose bytes or presence differ between two fingerprints, with what each said. */
export const differences = (
	before: Record<string, string>,
	after: Record<string, string>,
): string[] =>
	[...new Set([...Object.keys(before), ...Object.keys(after)])]
		.sort()
		.filter((path) => before[path] !== after[path])
		.map(
			(path) =>
				`${path}: ${before[path] ?? "absent"} -> ${after[path] ?? "absent"}`,
		);

/** One hash of a fingerprint, for a table. */
export const fingerprintHash = (print: Record<string, string>): string =>
	sha256(JSON.stringify(Object.entries(print).sort()));

/** The files of a folder that are objects of the store: the store's own temporary files and writer locks left out. */
export const objectsOnly = (
	print: Record<string, string>,
): Record<string, string> =>
	Object.fromEntries(
		Object.entries(print).filter(
			([path]) =>
				!path
					.split("/")
					.some(
						(segment) =>
							segment.startsWith(".atm-tmp-") || segment.endsWith(".lock"),
					),
		),
	);

export type World = {
	/** Everything of the run: databases, the log folder, the Stripe side. */
	dir: string;
	/** The folder `--root` names: `schools/<id>/events` and `schools/<id>/inputs` go under it. */
	root: string;
	databaseFor: (school: string) => string;
	stripeFor: (school: string) => string;
	dispose: () => Promise<void>;
};

export const makeWorld = async (name: string): Promise<World> => {
	const dir = await mkdtemp(join(tmpdir(), `atm-golden-e2e-${name}-`));
	const root = join(dir, "log");
	await mkdir(root);
	await mkdir(join(dir, "db"));
	return {
		dir,
		root,
		databaseFor: (school) => join(dir, "db", `${school}.sqlite`),
		stripeFor: (school) => join(dir, "stripe", school),
		dispose: () => rm(dir, { recursive: true, force: true }),
	};
};

/** A new world whose databases are copies of another's (the database file and its `-wal`) and whose folder is empty. */
export const copyWorld = async (
	template: World,
	name: string,
): Promise<World> => {
	const copy = await makeWorld(name);
	for (const file of readdirSync(join(template.dir, "db")))
		if (!file.endsWith("-shm"))
			await cp(join(template.dir, "db", file), join(copy.dir, "db", file));
	return copy;
};

/** An empty database file in WAL mode, as the family service runs its handler's. */
export const createWalDatabase = (file: string): void => {
	const database = new Database(file, { create: true });
	database.exec("PRAGMA journal_mode = WAL");
	database.close();
};

const STRIPE_FILES = {
	invoices: "invoices.json",
	refunds: "refunds.json",
	disputes: "disputes.json",
	payouts: "payouts.json",
	balanceTransactions: "balance_transactions.json",
	paymentIntents: "payment_intents.json",
} as const;

/** The folder of JSON that `atm reconcile --stripe` reads (payment intents only for a school that supplies them). */
export const writeStripeSide = async (
	folder: string,
	stripe: ReconcileStripe,
): Promise<void> => {
	await mkdir(folder, { recursive: true });
	for (const [list, file] of Object.entries(STRIPE_FILES)) {
		const records = stripe[list as keyof ReconcileStripe];
		if (records === undefined && list === "paymentIntents") continue;
		await writeFile(join(folder, file), JSON.stringify(records ?? []));
	}
};

/**
 * Delivers a bundle to the reference handler, one file-backed WAL database per school, the way the matrix does
 * (`runBundle`), then leaves what a family service's database holds before its first shipper runs: the outbox unshipped (the
 * run shipped to a folder of its own), and the runner's own helper tables (`bundle_*` mutation log and its triggers) gone.
 * The `bk_*` tables are the family service's booking index and stay.
 */
export const buildBundleWorld = async (
	bundle: ScenarioBundle,
	world: World,
): Promise<void> => {
	const schools = bundleSchools(bundle.scenario);
	for (const school of new Set([bundle.scenario.school, ...schools]))
		createWalDatabase(world.databaseFor(school));
	const run = await runBundle(bundle, {
		channels: [],
		databaseFor: world.databaseFor,
	});
	await run.dispose();
	for (const school of schools) {
		const database = new Database(world.databaseFor(school));
		database.exec(`
			DROP TRIGGER IF EXISTS bundle_rows_insert;
			DROP TRIGGER IF EXISTS bundle_rows_update;
			DROP TRIGGER IF EXISTS bundle_rows_delete;
			DROP TABLE IF EXISTS bundle_mutation_log;
			UPDATE ledger_outbox SET batch_key = NULL, shipped_at = NULL;
		`);
		database.close();
		await writeStripeSide(
			world.stripeFor(school),
			bundle.stripeSide[school] ?? {},
		);
	}
};

/** A line of the report of a check. A finding is something that is not as the design says; a pass is as it says. */
export type Outcome = {
	scenario: string;
	check: string;
	status: "PASS" | "FINDING";
	detail: string;
};

export class Outcomes {
	readonly outcomes: Outcome[] = [];
	/** Values a caller compares across runs (the hash of the shipped folder under two time zones). */
	readonly facts: Record<string, string> = {};
	constructor(private readonly scenario: string) {}
	pass(check: string, detail = ""): void {
		this.outcomes.push({
			scenario: this.scenario,
			check,
			status: "PASS",
			detail,
		});
	}
	finding(check: string, detail: string): void {
		this.outcomes.push({
			scenario: this.scenario,
			check,
			status: "FINDING",
			detail,
		});
	}
	/** Passes when `ok`, else a finding whose text is `detail()`. */
	expect(check: string, ok: boolean, detail: () => string): boolean {
		if (ok) this.pass(check);
		else this.finding(check, detail());
		return ok;
	}
}

/** The first line a text differs on, for a finding. */
export const firstDifference = (left: string, right: string): string => {
	if (left === right) return "identical";
	const a = left.split("\n");
	const b = right.split("\n");
	for (let index = 0; index < Math.max(a.length, b.length); index++)
		if (a[index] !== b[index])
			return `line ${index + 1}: ${JSON.stringify(a[index] ?? null)} vs ${JSON.stringify(b[index] ?? null)}`;
	return "same lines";
};

export const sizeOf = (path: string): number => statSync(path).size;

export const hasDir = (path: string): boolean =>
	existsSync(path) && statSync(path).isDirectory();
