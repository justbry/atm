/**
 * `atm simulate --inputs`: exit 0 no difference, 1 a difference, 2 input it cannot use (one line on stderr, and with
 * `--json` `{"ok":false,"error":...}`), the shape of `--json`, and that it writes nothing: the handler's database and the
 * log's folder are byte for byte what they were after every run, whatever its exit. The mode is `simulate-inputs.ts`.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addUtcMonths } from "../src/billing/grants.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import { shipInputs } from "../src/ledger/ship-inputs.js";
import { canonicalize } from "../src/ledger/util.js";
import { FolderStore } from "../src/store/folder-store.js";
import {
	FAMILY,
	HOUR,
	harness,
	menu,
	paid,
	SCHOOL,
	T0,
	T1,
} from "./handler-harness.js";
import { tmp } from "./helpers.js";
import { logOf } from "./simulate-inputs-world.js";
import { invoicePaid } from "./stripe-events.js";

const BIN = join(import.meta.dir, "../src/bin.ts");
const STACK_FRAME = /\n\s+at /;
const DAY = 24 * HOUR;

let folder = "";
let root = "";
let databaseFile = "";
let drifted = "";
let shipped = "";
const files: Record<string, string> = {};

const price = (tierId: string) =>
	menu.tiers
		.find((t) => t.id === tierId)
		?.prices.find((p) => p.interval === "month")?.amount as number;
const line = (tierId: string, over: Record<string, unknown> = {}) => ({
	lookupKey: lookupKeyOf(
		SCHOOL,
		tierPriceKey(tierId, "month"),
		price(tierId),
		menu.currency,
	),
	amount: price(tierId),
	interval: "month" as const,
	...over,
});

beforeAll(async () => {
	folder = await tmp("simulate-inputs-cli");
	root = join(folder, "log");
	databaseFile = join(folder, "handler.sqlite");
	const raw = new Database(databaseFile, { create: true });
	const h = harness(undefined, { raw });
	h.deliver(paid());
	const at = T0 + 21 * DAY;
	const span = T1 - T0;
	const left = T1 - at;
	h.deliver(
		invoicePaid({
			eventId: "evt_up",
			invoiceId: "in_up",
			at,
			subscriptionId: "sub_1",
			reason: "subscription_update",
			periodStart: at,
			periodEnd: T1,
			lines: [
				line("sparkle-2", {
					amount: -Math.floor((price("sparkle-2") * left) / span),
					proration: true,
				}),
				line("sparkle-4", {
					amount: Math.floor((price("sparkle-4") * left) / span),
					proration: true,
				}),
			],
			metadata: { b4u_school: SCHOOL, family_id: FAMILY },
		}),
		at,
	);
	const events = logOf(h);
	// the same inputs, shipped to a folder
	shipped = join(folder, "shipped");
	await mkdir(shipped);
	await shipInputs({
		db: h.db,
		store: new FolderStore({ root: shipped }),
		school: SCHOOL,
		env: "live",
		nowMs: () => T1,
	});
	raw.close();
	const eventsDir = join(root, "schools", SCHOOL, "events", "date=2026-01-15");
	await mkdir(eventsDir, { recursive: true });
	await writeFile(
		join(eventsDir, "batch.jsonl"),
		`${events.map((e) => canonicalize(e)).join("\n")}\n`,
	);
	// a log that is not the one the inputs decided: the first payment line says $261.00
	const other = join(folder, "drifted");
	const otherDir = join(other, "schools", SCHOOL, "events", "date=2026-01-15");
	await mkdir(otherDir, { recursive: true });
	const changed = events.map((e) =>
		e.event_type === "payment.succeeded" && e.idem === "stripe:in_1"
			? {
					...e,
					postings: e.postings.map((p) =>
						p.account === "assets:stripe" ? { ...p, amount: "252.17" } : p,
					),
				}
			: e,
	);
	await writeFile(
		join(otherDir, "batch.jsonl"),
		`${changed.map((e) => canonicalize(e)).join("\n")}\n`,
	);
	drifted = other;
	files.full = join(folder, "full.json");
	await writeFile(files.full, JSON.stringify({ upgradeGrant: "full" }));
	files.prorated = join(folder, "prorated.json");
	await writeFile(files.prorated, JSON.stringify({ upgradeGrant: "prorated" }));
	files.noShow = join(folder, "noshow.json");
	await writeFile(files.noShow, JSON.stringify({ noShow: "release" }));
	files.badPolicy = join(folder, "bad-policy.json");
	await writeFile(
		files.badPolicy,
		JSON.stringify({ upgradeGrant: "sometimes" }),
	);
	files.menu = join(folder, "menu.json");
	await writeFile(files.menu, JSON.stringify(menu));
	files.badMenu = join(folder, "bad-menu.json");
	await writeFile(files.badMenu, JSON.stringify({ currency: "usd" }));
	files.notSqlite = join(folder, "not-sqlite.sqlite");
	await writeFile(files.notSqlite, "this is not a database");
	files.noTable = join(folder, "no-table.sqlite");
	const empty = new Database(files.noTable, { create: true });
	empty.exec("CREATE TABLE unrelated (x INTEGER)");
	empty.close();
	files.emptyFile = join(folder, "empty.sqlite");
	await writeFile(files.emptyFile, "");
	// The handler's database in WAL mode with no -wal or -shm beside it: closed, checkpointed (macOS keeps the empty files,
	// so they are removed here). On Linux a read-only connection would create both and leave them.
	files.walAtRest = join(folder, "wal-at-rest.sqlite");
	await copyFile(databaseFile, files.walAtRest);
	const wal = new Database(files.walAtRest);
	wal.exec("PRAGMA journal_mode = WAL");
	wal.close();
	await rm(`${files.walAtRest}-wal`, { force: true });
	await rm(`${files.walAtRest}-shm`, { force: true });
	expect(readFileSync(files.walAtRest)[18]).toBe(2);
	expect(DEFAULT_POLICY.upgradeGrant).toBe("prorated");
	expect(addUtcMonths(T0, 1)).toBe(T1);
});

afterAll(async () => {
	await rm(folder, { recursive: true, force: true });
});

/** Every file under a directory with the sha256 of its bytes, and its size and mtime: nothing may change. */
const fingerprint = (dir: string, rel = ""): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) Object.assign(out, fingerprint(dir, path));
		else {
			const full = join(dir, path);
			out[path] =
				`${createHash("sha256").update(readFileSync(full)).digest("hex")} ${statSync(full).size} ${statSync(full).mtimeMs}`;
		}
	}
	return out;
};

const atm = (args: string[]) => {
	const before = fingerprint(folder);
	const run = Bun.spawnSync([process.execPath, BIN, "simulate", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	// the CLI writes nothing: the database and the log are what they were, byte for byte, and no file appeared beside them
	expect(fingerprint(folder)).toEqual(before);
	return {
		code: run.exitCode,
		out: run.stdout.toString(),
		err: run.stderr.toString(),
	};
};

const base = (extra: string[] = [], log = root) => [
	"--root",
	log,
	"--school",
	SCHOOL,
	"--inputs",
	databaseFile,
	"--env",
	"live",
	...extra,
];

const oneLineError = (err: string) => {
	expect(err.trimEnd().split("\n")).toHaveLength(1);
	expect(err).not.toMatch(STACK_FRAME);
};

describe("atm simulate --inputs: exit 0, 1 and 2", () => {
	test("a WAL database with no -wal beside it: the same answer, and no file appears beside it", () => {
		const run = atm(
			base().map((a) => (a === databaseFile ? (files.walAtRest as string) : a)),
		);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		expect(run.out).toContain("the replay reproduces the log (2 inputs)");
	});

	test("no candidate flags and a baseline that holds: exit 0, no difference", () => {
		const run = atm(base());
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		expect(run.out).toContain("no differences");
		expect(run.out).toContain("the replay reproduces the log (2 inputs)");
	});

	test("the policy the history was decided under as the candidate: exit 0", () => {
		expect(atm(base(["--policy", files.prorated as string])).code).toBe(0);
	});

	test("a candidate policy that changes a decision: exit 1, the changes in the text", () => {
		const run = atm(base(["--policy", files.full as string]));
		expect(run.code).toBe(1);
		expect(run.err).toBe("");
		expect(run.out).toContain("deliveries decided differently: 1");
		expect(run.out).toContain(
			"evt_up changed: granted 1 retreat, 1 visit -> 1 retreat, 2 visit",
		);
		expect(run.out).toContain("visit: avail 3 -> 4");
	});

	test("--effective-from after the switch leaves it alone: exit 0", () => {
		const run = atm(
			base([
				"--policy",
				files.full as string,
				"--effective-from",
				"2026-03-01T00:00:00Z",
			]),
		);
		expect(run.code).toBe(0);
	});

	test("--effective-from before it applies the candidate: exit 1", () => {
		expect(
			atm(
				base([
					"--policy",
					files.full as string,
					"--effective-from",
					"2026-02-01T00:00:00Z",
				]),
			).code,
		).toBe(1);
	});

	test("--json is one line: the shape, the changes only, no events", () => {
		const run = atm(base(["--policy", files.full as string, "--json"]));
		expect(run.code).toBe(1);
		const lines = run.out.trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		const result = JSON.parse(lines[0] as string);
		expect(Object.keys(result).sort()).toEqual(
			[
				"asOf",
				"balanceChanges",
				"baseline",
				"deliveries",
				"differences",
				"env",
				"notReplayable",
				"notSimulated",
				"ok",
				"postingChanges",
				"refused",
				"replayed",
				"school",
				"summary",
				"transactions",
				"unaffected",
			].sort(),
		);
		expect(result.ok).toBe(true);
		expect(result.env).toBe("live");
		expect(result.baseline).toEqual({
			identical: true,
			inputs: 2,
			carriedPayments: 0,
			mismatches: [],
		});
		expect(
			result.deliveries.map((d: { eventId: string; kind: string }) => [
				d.eventId,
				d.kind,
			]),
		).toEqual([["evt_up", "changed"]]);
		expect(result.balanceChanges).toHaveLength(1);
		expect(result.replayed).toEqual({
			holders: 1,
			inputs: 2,
			carriedCommands: 0,
		});
		expect(result.differences).toBe(
			1 + result.balanceChanges.length + result.postingChanges.length,
		);
		expect(result.events).toBeUndefined();
	});

	test("--month limits the postings and the deliveries to it", () => {
		const january = atm(
			base(["--policy", files.full as string, "--month", "2026-01", "--json"]),
		);
		// the switch is in February: January has no posting change and no delivery change (the balance, as of the last event, still differs)
		expect(JSON.parse(january.out).postingChanges).toEqual([]);
		expect(JSON.parse(january.out).deliveries).toEqual([]);
		expect(JSON.parse(january.out).balanceChanges).toHaveLength(1);
		const february = atm(
			base(["--policy", files.full as string, "--month", "2026-02", "--json"]),
		);
		expect(february.code).toBe(1);
		expect(
			JSON.parse(february.out).postingChanges.every(
				(p: { month: string }) => p.month === "2026-02",
			),
		).toBe(true);
	});
});

describe("atm simulate --inputs <shipped folder>", () => {
	const fromFolder = (extra: string[]) =>
		base(extra).map((a) => (a === databaseFile ? (shipped as string) : a));

	test("the same inputs from the folder give the same answer as from the database: the identity, and a candidate", () => {
		expect(atm(fromFolder([])).code).toBe(0);
		const fromDb = atm(base(["--policy", files.full as string, "--json"]));
		const fromShipped = atm(
			fromFolder(["--policy", files.full as string, "--json"]),
		);
		expect(fromShipped.code).toBe(1);
		const strip = (text: string) => {
			const { summary: _summary, ...rest } = JSON.parse(text);
			return rest;
		};
		expect(strip(fromShipped.out)).toEqual(strip(fromDb.out));
	});
});

describe("atm simulate --inputs: input it cannot use is exit 2 with one line", () => {
	const bad: [string, () => string[], RegExp][] = [
		[
			"no --env",
			() => ["--root", "x", "--school", SCHOOL, "--inputs", "x"],
			/--env must be live or test with --inputs/,
		],
		[
			"a bad --env",
			() => base().map((a) => (a === "live" ? "staging" : a)),
			/--env must be live or test/,
		],
		[
			"--catalog",
			() => base(["--catalog", "x.json"]),
			/--catalog and --current-catalog are not used with --inputs/,
		],
		[
			"a bad --month",
			() => base(["--month", "2026-13"]),
			/--month 2026-13 is not YYYY-MM/,
		],
		[
			"a bad --effective-from",
			() => base(["--effective-from", "soon"]),
			/--effective-from soon is not an ISO instant/,
		],
		[
			"an unreadable policy",
			() => base(["--policy", "/nonexistent/policy.json"]),
			/--policy \/nonexistent\/policy.json cannot be read as JSON/,
		],
		[
			"a policy that does not validate",
			() => base(["--policy", files.badPolicy as string]),
			/--policy .*bad-policy.json: /,
		],
		[
			"a menu that does not validate",
			() => base(["--menu", files.badMenu as string]),
			/is not a valid menu/,
		],
		[
			"a database that is not SQLite",
			() =>
				base().map((a) =>
					a === databaseFile ? (files.notSqlite as string) : a,
				),
			/cannot be (opened|read)/,
		],
		[
			"an empty file",
			() =>
				base().map((a) =>
					a === databaseFile ? (files.emptyFile as string) : a,
				),
			/holds no stored inputs for school sch_vol \(live\)/,
		],
		[
			"a database with no inputs table",
			() =>
				base().map((a) => (a === databaseFile ? (files.noTable as string) : a)),
			/holds no stored inputs for school sch_vol \(live\).*run atm simulate without --inputs/,
		],
		[
			"a database that does not exist",
			() =>
				base().map((a) => (a === databaseFile ? "/nonexistent/h.sqlite" : a)),
			/does not exist/,
		],
		[
			"a folder with no shipped inputs",
			() => base().map((a) => (a === databaseFile ? (root as string) : a)),
			/no inputs under .*schools\/sch_vol\/inputs\/live: run atm inputs ship, or point --inputs at the handler's database/,
		],
		[
			"stored inputs of another env",
			() => base().map((a) => (a === "live" ? "test" : a)),
			/holds no stored inputs for school sch_vol \(test\)/,
		],
		[
			"a school with no events",
			() => base().map((a) => (a === SCHOOL ? "sch_other" : a)),
			/no events under/,
		],
		[
			"only booking-call settings changed",
			() => base(["--policy", files.noShow as string]),
			/decided by booking calls, which are not stored: nothing to simulate/,
		],
		[
			"a baseline that does not reproduce the log",
			() => base([], drifted),
			/the baseline does not reproduce the log: 1 input\(s\) decided differently/,
		],
	];
	test.each(bad)("%s", (_name, args, message) => {
		const run = atm(args());
		expect(run.code).toBe(2);
		expect(run.out).toBe("");
		oneLineError(run.err);
		expect(run.err).toMatch(message);
	});

	test("with --json the error is one line on stdout too", () => {
		const run = atm(base([], drifted).concat(["--json"]));
		expect(run.code).toBe(2);
		oneLineError(run.err);
		const line = JSON.parse(run.out.trimEnd());
		expect(line.ok).toBe(false);
		expect(line.error).toBe(run.err.trimEnd());
	});

	test("--allow-baseline-drift goes on and reports the drift without counting it", () => {
		const run = atm(base(["--allow-baseline-drift", "--json"], drifted));
		expect(run.code).toBe(0);
		const result = JSON.parse(run.out.trimEnd());
		expect(result.baseline.identical).toBe(false);
		expect(
			result.baseline.mismatches.map(
				(m: { eventId: string; reason: string }) => [m.eventId, m.reason],
			),
		).toEqual([["evt_in_1", "events_differ"]]);
		expect(result.differences).toBe(0);
		expect(result.summary).toContain("DRIFT");
	});

	test("the new flags are for --inputs", () => {
		const run = atm([
			"--root",
			root,
			"--school",
			SCHOOL,
			"--menu",
			files.menu as string,
			"--current-menu",
			files.menu as string,
			"--env",
			"live",
		]);
		expect(run.code).toBe(2);
		expect(run.err).toBe("--env is for --inputs\n");
	});
});
