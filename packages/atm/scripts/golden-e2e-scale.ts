#!/usr/bin/env bun
/**
 * S7, the scale probe. The eight recorded sandbox scenarios (`fixtures/billing/stripe/recorded/delivered`: eight families and
 * about 45 Stripe events) are repeated `--copies` times with new ids and the time moved from copy to copy, delivered through the
 * reference handler into a WAL database file, and then the real command line is run over it under `/usr/bin/time -l`: `atm
 * inputs ship`, `atm ship`, `atm journal` (every month), `atm report`, `atm simulate --inputs` from the database and from the
 * folder, with no candidate and with one. It prints wall time, peak resident memory and the sizes of the database and the
 * folder.
 *
 *   bun scripts/golden-e2e-scale.ts [--copies 20,100,500] [--bin src/bin.ts|dist/atm.js] [--step-timeout 600] [--ship-index] [--json]
 *
 * macOS only (`/usr/bin/time -l`). Nothing is written outside a temporary directory, which is removed at the end.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import {
	RECORDED_SCHOOL,
	recordedMenu,
	recordedPriceIds,
} from "../tests/e2e-recorded.js";
import { cloneJson } from "../tests/golden-e2e-clone.js";
import {
	BIN_SOURCE,
	createWalDatabase,
	makeWorld,
	type World,
} from "../tests/golden-e2e-lib.js";
import { harness } from "../tests/handler-harness.js";
import {
	deliverWithRetries,
	SCENARIOS,
	scenarioEvents,
} from "../tests/simulate-inputs-world.js";

const DAY_SECONDS = 86_400;
const SHIFT_DAYS = 300;
const BYTES_PER_MEGABYTE = 1_048_576;

type Measured = {
	step: string;
	seconds: number;
	peakMegabytes: number;
	exit: number;
	output: string;
};

const argumentOf = (name: string, fallback: string): string => {
	const at = process.argv.indexOf(name);
	return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};

const STEP_TIMEOUT_SECONDS = Number(argumentOf("--step-timeout", "600"));

/** Runs a command under `/usr/bin/time -l`; the peak is "maximum resident set size" (bytes on macOS). */
const measure = (
	step: string,
	bin: string,
	args: readonly string[],
): Measured => {
	const started = performance.now();
	const run = Bun.spawnSync(
		["/usr/bin/time", "-l", process.execPath, bin, ...args],
		{ stdout: "pipe", stderr: "pipe", timeout: STEP_TIMEOUT_SECONDS * 1000 },
	);
	const timedOut = run.exitCode === null || run.signalCode != null;
	const seconds = (performance.now() - started) / 1000;
	const stderr = run.stderr.toString();
	const peak = /(\d+)\s+maximum resident set size/.exec(stderr);
	return {
		step,
		seconds,
		peakMegabytes: peak ? Number(peak[1]) / BYTES_PER_MEGABYTE : Number.NaN,
		exit: timedOut ? -1 : (run.exitCode ?? -1),
		output: timedOut
			? `STOPPED after ${STEP_TIMEOUT_SECONDS} s`
			: (run.stdout.toString().trim().split("\n").slice(-1)[0] ?? ""),
	};
};

const sizeOfTree = (dir: string): { bytes: number; files: number } => {
	let bytes = 0;
	let files = 0;
	const walk = (path: string) => {
		if (!existsSync(path)) return;
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) walk(full);
			else {
				bytes += statSync(full).size;
				files += 1;
			}
		}
	};
	walk(dir);
	return { bytes, files };
};

const megabytes = (bytes: number): number => bytes / BYTES_PER_MEGABYTE;

/** Delivers the recorded scenarios `copies` times; returns the events delivered and the seconds it took. */
const deliverCopies = (
	world: World,
	copies: number,
): { delivered: number; seconds: number } => {
	createWalDatabase(world.databaseFor(RECORDED_SCHOOL));
	const raw = new Database(world.databaseFor(RECORDED_SCHOOL));
	const h = harness(undefined, {
		school: RECORDED_SCHOOL,
		menu: recordedMenu,
		env: "test",
		priceIds: recordedPriceIds(),
		raw,
	});
	const started = performance.now();
	let delivered = 0;
	for (let copy = 0; copy < copies; copy++) {
		const suffix = `_k${copy}`;
		const shiftSeconds = (copy % SHIFT_DAYS) * DAY_SECONDS;
		for (const scenario of SCENARIOS) {
			const events = scenarioEvents(scenario).map((event) =>
				cloneJson(event, suffix, { personal: false, shiftSeconds }),
			);
			delivered += events.length;
			deliverWithRetries(h, events);
		}
	}
	const seconds = (performance.now() - started) / 1000;
	raw.exec("PRAGMA wal_checkpoint(PASSIVE)");
	raw.close();
	return { delivered, seconds };
};

const runOne = async (copies: number, bin: string) => {
	const world = await makeWorld(`scale-${copies}`);
	try {
		const { delivered, seconds: deliverSeconds } = deliverCopies(world, copies);
		const database = world.databaseFor(RECORDED_SCHOOL);
		const counts = new Database(database, { readonly: true });
		const stored = (
			counts.query("SELECT COUNT(*) AS n FROM atm_event_inputs").get() as {
				n: number;
			}
		).n;
		const refused = (
			counts
				.query(
					"SELECT COUNT(*) AS n FROM atm_event_inputs WHERE outcome = 'refused'",
				)
				.get() as { n: number }
		).n;
		const outbox = (
			counts.query("SELECT COUNT(*) AS n FROM ledger_outbox").get() as {
				n: number;
			}
		).n;
		const holders = (
			counts.query("SELECT COUNT(*) AS n FROM atm_subjects").get() as {
				n: number;
			}
		).n;
		counts.close();
		const steps: Measured[] = [];
		steps.push(
			measure("atm inputs ship", bin, [
				"inputs",
				"ship",
				"--db",
				database,
				"--school",
				RECORDED_SCHOOL,
				"--env",
				"test",
				"--root",
				world.root,
				"--json",
			]),
		);
		if (process.argv.includes("--ship-index")) {
			// an experiment, not the product: the index the shipper's UPDATE would need to find a row by school and id
			const tuned = new Database(database);
			tuned.exec(
				"CREATE INDEX IF NOT EXISTS experiment_outbox_school_id ON ledger_outbox (school_id, id)",
			);
			tuned.close();
		}
		steps.push(
			measure("atm ship", bin, [
				"ship",
				"--db",
				database,
				"--root",
				world.root,
				"--school",
				RECORDED_SCHOOL,
				"--json",
			]),
		);
		const shipped = steps.at(-1)?.exit === 0;
		const { events } = shipped
			? await readEvents(world.root, RECORDED_SCHOOL)
			: { events: [] };
		const months = [
			...new Set(events.map((event) => event.date.slice(0, 7))),
		].sort();
		const journalStarted = performance.now();
		let journalPeak = 0;
		let journalExit = 0;
		for (const month of shipped ? months : []) {
			const run = measure(`atm journal ${month}`, bin, [
				"journal",
				"--root",
				world.root,
				"--school",
				RECORDED_SCHOOL,
				"--month",
				month,
			]);
			journalPeak = Math.max(journalPeak, run.peakMegabytes);
			journalExit = Math.max(journalExit, run.exit);
		}
		steps.push({
			step: `atm journal x${months.length} months`,
			seconds: (performance.now() - journalStarted) / 1000,
			peakMegabytes: journalPeak,
			exit: journalExit,
			output: `${events.length} events`,
		});
		if (shipped)
			steps.push(
				measure("atm report credits", bin, [
					"report",
					"--root",
					world.root,
					"--school",
					RECORDED_SCHOOL,
					"--month",
					months.at(-1) as string,
					"--report",
					"credits",
					"--format",
					"csv",
				]),
			);
		const simulate = (source: string, extra: string[] = []) => [
			"simulate",
			"--root",
			world.root,
			"--school",
			RECORDED_SCHOOL,
			"--inputs",
			source,
			"--env",
			"test",
			"--json",
			...extra,
		];
		if (shipped) {
			steps.push(
				measure("atm simulate --inputs db (identity)", bin, simulate(database)),
			);
			steps.push(
				measure(
					"atm simulate --inputs folder (identity)",
					bin,
					simulate(world.root),
				),
			);
			const policy = join(world.dir, "policy-full.json");
			await Bun.write(policy, JSON.stringify({ upgradeGrant: "full" }));
			steps.push(
				measure(
					"atm simulate --inputs db (upgradeGrant full)",
					bin,
					simulate(database, ["--policy", policy]),
				),
			);
		}
		const databaseBytes = ["", "-wal"].reduce(
			(total, suffix) =>
				total +
				(statSync(`${database}${suffix}`, { throwIfNoEntry: false })?.size ??
					0),
			0,
		);
		const inputsTree = sizeOfTree(
			join(world.root, "schools", RECORDED_SCHOOL, "inputs"),
		);
		const eventsTree = sizeOfTree(
			join(world.root, "schools", RECORDED_SCHOOL, "events"),
		);
		const ledgerTree = sizeOfTree(
			join(world.root, "schools", RECORDED_SCHOOL, "ledger"),
		);
		return {
			copies,
			delivered,
			stored,
			refused,
			outbox,
			holders,
			deliverSeconds,
			databaseMegabytes: megabytes(databaseBytes),
			inputsFolder: {
				megabytes: megabytes(inputsTree.bytes),
				files: inputsTree.files,
			},
			eventsFolder: {
				megabytes: megabytes(eventsTree.bytes),
				files: eventsTree.files,
			},
			journals: {
				megabytes: megabytes(ledgerTree.bytes),
				files: ledgerTree.files,
			},
			steps,
		};
	} finally {
		await world.dispose();
	}
};

const bin = argumentOf("--bin", BIN_SOURCE);
const copyList = argumentOf("--copies", "20,100,500").split(",").map(Number);
type Result = Awaited<ReturnType<typeof runOne>>;
const print = (result: Result) => {
	console.log(
		`\ncopies ${result.copies}: ${result.delivered} events delivered in ${result.deliverSeconds.toFixed(1)} s; ${result.stored} stored inputs (${result.refused} refused), ${result.outbox} log events, ${result.holders} holders`,
	);
	console.log(
		`  database ${result.databaseMegabytes.toFixed(1)} MB; inputs folder ${result.inputsFolder.megabytes.toFixed(1)} MB in ${result.inputsFolder.files} files; events folder ${result.eventsFolder.megabytes.toFixed(1)} MB in ${result.eventsFolder.files} files; journals ${result.journals.megabytes.toFixed(1)} MB in ${result.journals.files} files`,
	);
	for (const step of result.steps)
		console.log(
			`  ${step.step.padEnd(46)} ${step.seconds.toFixed(2).padStart(7)} s  ${step.peakMegabytes.toFixed(0).padStart(5)} MB peak  exit ${step.exit}  ${step.output.slice(0, 90)}`,
		);
};

for (const copies of copyList) {
	const result = await runOne(copies, bin);
	if (process.argv.includes("--json")) console.log(JSON.stringify(result));
	else print(result);
}
