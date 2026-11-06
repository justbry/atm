/**
 * S4: kill the shippers mid-run and rerun them. `atm inputs ship` and `atm ship` are stopped with SIGKILL, once at an exact
 * store operation (`scripts/golden-e2e-kill.ts` counts the folder store's puts and deletes) and once by a timer on the real
 * `src/bin.ts`; each is then run again to the end, and the folder must be what an uninterrupted run made, object for object and
 * byte for byte, with every row marked shipped. The erasure settle (rewrite a batch, delete the old one) gets the same
 * treatment, and its end state must hold no erased fact.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { eraseStoredInputs } from "../src/handler/inputs.js";
import { readEvents } from "../src/ledger/files.js";
import { erasureDrillBundle } from "./golden-e2e-erasure.js";
import {
	atm,
	BIN_SOURCE,
	buildBundleWorld,
	type Cli,
	copyWorld,
	differences,
	fingerprint,
	fingerprintHash,
	KILL_WRAPPER,
	makeWorld,
	Outcomes,
	objectsOnly,
	type World,
} from "./golden-e2e-lib.js";
import { buildOutboxWorld } from "./golden-e2e-years.js";

const SCHOOL = "sch_vol";
const MULTI_SCHOOL = "sch_multi";
const DRILL_FAMILIES = 8;
const SETTLE_FAMILIES = 3;
const ERASED = 1;
const TIMER_DELAYS_MS = [25, 50, 75, 100, 130, 160, 200, 260];
const SHIP_SAMPLE_POINTS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

const inputsArgs = (world: World, school: string) => [
	"inputs",
	"ship",
	"--db",
	world.databaseFor(school),
	"--school",
	school,
	"--env",
	"live",
	"--root",
	world.root,
	"--json",
];
const shipArgs = (world: World, school: string) => [
	"ship",
	"--db",
	world.databaseFor(school),
	"--root",
	world.root,
	"--school",
	school,
	"--json",
];

/** The wrapper: the same command line, dying at the `at`-th store operation. */
const killedAt = (
	args: readonly string[],
	spec: { op: "put" | "delete"; at: number; phase: "before" | "after" },
): Cli => {
	const run = Bun.spawnSync([process.execPath, KILL_WRAPPER, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			ATM_KILL_OP: spec.op,
			ATM_KILL_AT: String(spec.at),
			ATM_KILL_PHASE: spec.phase,
		},
	});
	return {
		code: run.exitCode,
		signal: run.signalCode ?? null,
		stdout: run.stdout.toString(),
		stderr: run.stderr.toString(),
	};
};

/** The real bin, killed by a timer after `delayMs`. */
const killedAfter = async (
	args: readonly string[],
	delayMs: number,
): Promise<{ killed: boolean }> => {
	const child = Bun.spawn([process.execPath, BIN_SOURCE, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), delayMs);
	await child.exited;
	clearTimeout(timer);
	return { killed: child.signalCode === "SIGKILL" };
};

/** The rows of a table that are not marked shipped, in the world's database. */
const unshipped = (world: World, school: string, table: string): number => {
	const database = new Database(world.databaseFor(school), { readonly: true });
	try {
		return (
			database
				.query(
					`SELECT COUNT(*) AS n FROM ${table} WHERE shipped_at IS NULL AND school_id = ?`,
				)
				.get(school) as { n: number }
		).n;
	} finally {
		database.close();
	}
};

const leftovers = (print: Record<string, string>): string[] =>
	Object.keys(print).filter((path) =>
		path
			.split("/")
			.some(
				(segment) =>
					segment.startsWith(".atm-tmp-") || segment.endsWith(".lock"),
			),
	);

export type CrashReport = {
	rows: {
		drill: string;
		trials: number;
		killed: number;
		converged: number;
		leftoverTemp: number;
	}[];
};

type Drill = {
	name: string;
	template: World;
	school: string;
	args: (world: World) => string[];
	table: string;
	/** which store operation to kill at, and the points. */
	op: "put" | "delete";
	points: number[];
	/** Kill the real bin after these many milliseconds (put drills only). */
	timers: number[];
	prepare?: (world: World) => Promise<void> | void;
};

const runDrill = async (
	rec: Outcomes,
	report: CrashReport,
	drill: Drill,
): Promise<void> => {
	// the reference: uninterrupted
	const reference = await copyWorld(drill.template, `${drill.name}-ref`);
	let referencePrint: Record<string, string> = {};
	try {
		await drill.prepare?.(reference);
		const run = atm(drill.args(reference));
		rec.expect(
			`${drill.name}: the uninterrupted run exits 0`,
			run.code === 0,
			() => `${run.code} ${run.stderr.slice(0, 200)}`,
		);
		referencePrint = objectsOnly(fingerprint(reference.root));
		rec.expect(
			`${drill.name}: the uninterrupted run leaves nothing unshipped`,
			unshipped(reference, drill.school, drill.table) === 0,
			() => "rows left",
		);
	} finally {
		await reference.dispose();
	}
	const referenceHash = fingerprintHash(referencePrint);
	const objects = Object.keys(referencePrint).length;
	const entry = {
		drill: drill.name,
		trials: 0,
		killed: 0,
		converged: 0,
		leftoverTemp: 0,
	};
	const problems: string[] = [];
	const trial = async (
		label: string,
		interrupt: (world: World) => Promise<boolean> | boolean,
	) => {
		const world = await copyWorld(drill.template, `${drill.name}-trial`);
		try {
			await drill.prepare?.(world);
			const initial = objectsOnly(fingerprint(world.root));
			entry.trials += 1;
			const killed = await interrupt(world);
			if (killed) entry.killed += 1;
			// nothing is on disk under another name than the reference's, and no object is cut short
			const midway = objectsOnly(fingerprint(world.root));
			const strangers = Object.keys(midway).filter(
				(path) => !(path in referencePrint) && !(path in initial),
			);
			const cut = Object.keys(midway).filter(
				(path) =>
					path in referencePrint && midway[path] !== referencePrint[path],
			);
			if (strangers.length > 0 || cut.length > 0)
				problems.push(
					`${label}: after the kill, objects not in the reference [${strangers.slice(0, 2)}] or different bytes [${cut.slice(0, 2)}]`,
				);
			const rerun = atm(drill.args(world));
			const after = fingerprint(world.root);
			const afterObjects = objectsOnly(after);
			entry.leftoverTemp += leftovers(after).length;
			const same =
				rerun.code === 0 &&
				fingerprintHash(afterObjects) === referenceHash &&
				unshipped(world, drill.school, drill.table) === 0;
			if (same) entry.converged += 1;
			else
				problems.push(
					`${label}: rerun exit ${rerun.code}; ${differences(referencePrint, afterObjects).slice(0, 3).join("; ")}; unshipped ${unshipped(world, drill.school, drill.table)}; ${rerun.stderr.slice(0, 160)}`,
				);
		} finally {
			await world.dispose();
		}
	};
	for (const phase of ["before", "after"] as const)
		for (const at of drill.points)
			await trial(`${drill.op} ${at} ${phase}`, (world) => {
				const run = killedAt(drill.args(world), { op: drill.op, at, phase });
				return run.signal === "SIGKILL" || run.code === 137;
			});
	if (drill.op === "put")
		for (const delay of drill.timers)
			await trial(`timer ${delay}ms`, async (world) => {
				const result = await killedAfter(drill.args(world), delay);
				return result.killed;
			});
	report.rows.push(entry);
	rec.expect(
		`${drill.name}: ${entry.trials} kills (${entry.killed} landed) each rerun to the uninterrupted bytes (${objects} objects), none unshipped`,
		problems.length === 0 && entry.converged === entry.trials,
		() => problems.slice(0, 4).join(" | "),
	);
};

const range = (count: number): number[] =>
	Array.from({ length: count }, (_, index) => index + 1);

export const checkCrash = async (
	full: boolean,
): Promise<{
	rec: Outcomes;
	report: CrashReport;
}> => {
	const rec = new Outcomes("crash-drill");
	const report: CrashReport = { rows: [] };

	// ---- inputs ship: eight families on eight days, so eight batches and a context ----
	const { bundle } = await erasureDrillBundle(DRILL_FAMILIES);
	const inputsTemplate = await makeWorld("crash-inputs");
	// ---- ship: the twelve-family golden log, one batch a day ----
	const shipTemplate = await makeWorld("crash-ship");
	try {
		await buildBundleWorld(bundle, inputsTemplate);
		const { events } = await readEvents(
			join(import.meta.dir, "../fixtures/vibes-multi"),
			MULTI_SCHOOL,
		);
		buildOutboxWorld(events, shipTemplate, MULTI_SCHOOL);
		const dayCount = new Set(events.map((event) => event.date)).size;

		await runDrill(rec, report, {
			name: "inputs ship",
			template: inputsTemplate,
			school: SCHOOL,
			args: (world) => inputsArgs(world, SCHOOL),
			table: "atm_event_inputs",
			op: "put",
			points: full ? range(DRILL_FAMILIES + 2) : [1, 4, 9],
			timers: full ? TIMER_DELAYS_MS : [60, 130],
		});
		await runDrill(rec, report, {
			name: "ship",
			template: shipTemplate,
			school: MULTI_SCHOOL,
			args: (world) => shipArgs(world, MULTI_SCHOOL),
			table: "ledger_outbox",
			op: "put",
			points: (full
				? [...SHIP_SAMPLE_POINTS, dayCount - 1, dayCount]
				: [1, 21, dayCount]
			).filter((point) => point >= 1 && point <= dayCount),
			timers: full ? TIMER_DELAYS_MS : [60, 130],
		});
	} finally {
		await inputsTemplate.dispose();
		await shipTemplate.dispose();
	}

	// ---- the erasure settle: rewrite a batch, delete the old one ----
	const settle = await erasureDrillBundle(SETTLE_FAMILIES);
	const erasedHolder = (settle.families[ERASED] as { holder: string }).holder;
	const settleTemplate = await makeWorld("crash-settle");
	try {
		await buildBundleWorld(settle.bundle, settleTemplate);
		// ship everything, then erase one holder: the template is a database whose queue holds the erasure, folder to follow
		const shippedOnce = await copyWorld(settleTemplate, "crash-settle-seed");
		try {
			atm(inputsArgs(shippedOnce, SCHOOL));
			const raw = new Database(shippedOnce.databaseFor(SCHOOL));
			const db = bunSqlite(raw);
			db.transaction(() =>
				eraseStoredInputs(db, {
					env: "live",
					school: SCHOOL,
					subjectKey: `${SCHOOL}|live|${erasedHolder}`,
					nowMs: Date.parse("2026-03-01T00:00:00Z"),
				}),
			);
			raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			raw.close();
			// the settle drill copies the database, and the folder, which `prepare` restores from the first run
			const firstFolder = new Map<string, string>();
			for (const [path] of Object.entries(fingerprint(shippedOnce.root)))
				firstFolder.set(
					path,
					readFileSync(join(shippedOnce.root, path)).toString("latin1"),
				);
			const settleDrill: Drill = {
				name: "erasure settle",
				template: shippedOnce,
				school: SCHOOL,
				args: (world) => inputsArgs(world, SCHOOL),
				table: "atm_event_inputs",
				op: "put",
				points: full ? range(SETTLE_FAMILIES + 1) : [1, 3],
				timers: [],
				prepare: async (world) => {
					for (const [path, text] of firstFolder) {
						await mkdir(dirname(join(world.root, path)), { recursive: true });
						await writeFile(
							join(world.root, path),
							Buffer.from(text, "latin1"),
						);
					}
				},
			};
			await runDrill(rec, report, settleDrill);
			await runDrill(rec, report, {
				...settleDrill,
				name: "erasure settle (delete)",
				op: "delete",
				points: full ? range(SETTLE_FAMILIES) : [1],
			});
		} finally {
			await shippedOnce.dispose();
		}
	} finally {
		await settleTemplate.dispose();
	}
	return { rec, report };
};
