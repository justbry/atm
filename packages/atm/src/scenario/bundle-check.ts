/**
 * `atm scenario check`: runs a bundle through the pipeline, takes the H1 to H8 checkpoints and compares them with the
 * bundle's `hashes.json`. A table says which stage differs; the first mismatch gets a readable diff of that stage alone,
 * read from the stage snapshots (`stages/`, not committed: `--snapshots` writes them from a run that matches the goldens, `--update` writes them with the hashes).
 *
 * Internal to tests, CI and the job. Never show a stage hash, or a snapshot, to a viewer.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	canonicalDeliveries,
	canonicalJournal,
	canonicalKpis,
	canonicalLedgerTree,
	canonicalMutations,
	canonicalOutbox,
	canonicalReconcile,
	canonicalReports,
} from "../ledger/checkpoints.js";
import type {
	BundleHashes,
	ChannelReport,
	Checkpoint,
	CheckpointKpiRow,
	CheckpointStage,
	FileTree,
	ReconcileVerdictInput,
	ScenarioBundle,
	StageHash,
} from "../types.js";
import { bundleSchools, writeBundleHashes } from "./bundle.js";
import { type BundleRun, runBundle, type SchoolRun } from "./bundle-run.js";

const STAGE_DIRECTORY = "stages";
const REFERENCE_CHANNEL = "atm";
const HASH_SHOWN = 12;
const DIFF_CONTEXT = 3;
const DIFF_LINES = 24;

const STAGE_NAMES: Record<CheckpointStage, string> = {
	H1: "deliveries",
	H2: "mutations",
	H3: "outbox",
	H4: "ledger tree",
	H5: "journal",
	H6: "reports",
	H7: "kpis",
	H8: "reconcile",
};

/** One computed stage: a single checkpoint, or one per channel (`null` for a channel that could not run, with why). */
export type StageActual =
	| { stage: CheckpointStage; checkpoint: Checkpoint }
	| {
			stage: CheckpointStage;
			channels: Record<string, Checkpoint | { skipped: string }>;
	  };

export type StageStatus = "ok" | "mismatch" | "new" | "skipped" | "updated";

export type StageRow = {
	stage: CheckpointStage;
	/** `H6 hledger` for a channel stage. */
	label: string;
	name: string;
	expected: string | null;
	actual: string | null;
	status: StageStatus;
	/** The canonical text of the stage as it is now (a channel's own for a channel stage); not for display. */
	canonical?: string;
};

export type CheckResult = {
	id: string;
	rows: StageRow[];
	ok: boolean;
	/** A readable diff of the first mismatching stage; empty when all match. */
	diff: string;
	/** Answers that differ from `expected.json` (the handler's answer to each delivery, hand-written). */
	answerProblems: string[];
};

const channelStage = (run: BundleRun, stage: "H6" | "H7"): StageActual => {
	const names = new Set<string>();
	for (const school of run.schools)
		for (const channel of school.channels) names.add(channel.name);
	const channels: Record<string, Checkpoint | { skipped: string }> = {};
	for (const name of [...names].sort()) {
		const runs = run.schools.map((school) =>
			school.channels.find((channel) => channel.name === name),
		);
		const skipped = runs.find((entry) => entry?.status === "skipped");
		if (skipped?.status === "skipped") {
			channels[name] = { skipped: skipped.reason };
			continue;
		}
		if (stage === "H6") {
			const merged: Record<string, ChannelReport[string]> = {};
			for (const [index, school] of run.schools.entries()) {
				const entry = runs[index];
				if (entry?.status !== "ok") continue;
				Object.assign(
					merged,
					run.schools.length === 1
						? entry.base
						: Object.fromEntries(
								Object.entries(entry.base).map(([id, values]) => [
									`${school.school}/${id}`,
									values,
								]),
							),
				);
			}
			channels[name] = canonicalReports({ [name]: merged })[name] as Checkpoint;
		} else {
			const rows: CheckpointKpiRow[] = [];
			for (const [index, school] of run.schools.entries()) {
				const entry = runs[index];
				if (entry?.status !== "ok") continue;
				for (const row of entry.rows)
					rows.push({
						kpiId:
							run.schools.length === 1
								? row.kpiId
								: `${school.school}/${row.kpiId}`,
						period: row.period,
						value: row.value,
					});
			}
			channels[name] = canonicalKpis({ [name]: rows })[name] as Checkpoint;
		}
	}
	return { stage, channels };
};

/** The eight checkpoints of a finished run. */
export const bundleCheckpoints = (
	bundle: ScenarioBundle,
	run: BundleRun,
): StageActual[] => {
	const schools = bundleSchools(bundle.scenario);
	const bySchool = <T>(pick: (school: SchoolRun) => T): Record<string, T> =>
		Object.fromEntries(
			run.schools.map((school) => [school.school, pick(school)]),
		);
	// the answers belong to the bundle's deliveries; with several schools they are kept whole under the first
	const mutations = canonicalMutations(
		bySchool((school) => ({
			answers: school.school === schools[0] ? run.answers : [],
			decisions: school.decisions,
			mutations: school.mutations,
		})),
	);
	return [
		{
			stage: "H1",
			checkpoint: canonicalDeliveries(bundle.steps),
		},
		{ stage: "H2", checkpoint: mutations },
		{
			stage: "H3",
			checkpoint: canonicalOutbox(bySchool((school) => school.outbox)),
		},
		{
			stage: "H4",
			checkpoint: canonicalLedgerTree(
				bySchool((school): FileTree => school.tree),
			),
		},
		{
			stage: "H5",
			checkpoint: canonicalJournal(bySchool((school): FileTree => school.tree)),
		},
		channelStage(run, "H6"),
		channelStage(run, "H7"),
		{
			stage: "H8",
			checkpoint: canonicalReconcile(
				bySchool(
					(school) =>
						school.reconciled as unknown as Record<
							string,
							ReconcileVerdictInput
						>,
				),
			),
		},
	];
};

const shown = (hash: string | null | undefined): string | null =>
	hash ? hash.slice(0, HASH_SHOWN) : null;

const compare = (
	stage: CheckpointStage,
	label: string,
	expected: string | undefined,
	checkpoint: Checkpoint,
): StageRow => ({
	stage,
	label,
	name: STAGE_NAMES[stage],
	expected: shown(expected),
	actual: shown(checkpoint.hash),
	status:
		expected === undefined
			? "new"
			: expected === checkpoint.hash
				? "ok"
				: "mismatch",
	canonical: checkpoint.canonical,
});

/** The table rows for the actual stages against a bundle's goldens. */
export const compareStages = (
	hashes: BundleHashes,
	actual: readonly StageActual[],
): StageRow[] =>
	actual.flatMap((entry): StageRow[] => {
		const golden = hashes[entry.stage] as StageHash | undefined;
		if ("checkpoint" in entry)
			return [
				compare(
					entry.stage,
					entry.stage,
					typeof golden === "string" ? golden : undefined,
					entry.checkpoint,
				),
			];
		return Object.entries(entry.channels).map(([name, value]): StageRow => {
			const expected =
				golden !== undefined && typeof golden === "object"
					? golden[name]
					: undefined;
			if ("skipped" in value)
				return {
					stage: entry.stage,
					label: `${entry.stage} ${name}`,
					name: STAGE_NAMES[entry.stage],
					expected: shown(expected),
					actual: null,
					status: "skipped",
				};
			return compare(entry.stage, `${entry.stage} ${name}`, expected, value);
		});
	});

const pretty = (canonical: string): string =>
	JSON.stringify(JSON.parse(canonical), null, 1);

/** A short unified-style diff of two multi-line texts: the first differing region with a little context. */
export const textDiff = (expected: string, actual: string): string => {
	const left = expected.split("\n");
	const right = actual.split("\n");
	let start = 0;
	while (
		start < left.length &&
		start < right.length &&
		left[start] === right[start]
	)
		start += 1;
	let endLeft = left.length;
	let endRight = right.length;
	while (
		endLeft > start &&
		endRight > start &&
		left[endLeft - 1] === right[endRight - 1]
	) {
		endLeft -= 1;
		endRight -= 1;
	}
	const from = Math.max(0, start - DIFF_CONTEXT);
	const lines: string[] = [`@@ line ${start + 1} @@`];
	for (const line of left.slice(from, start)) lines.push(`  ${line}`);
	for (const line of left.slice(start, endLeft)) lines.push(`- ${line}`);
	for (const line of right.slice(start, endRight)) lines.push(`+ ${line}`);
	for (const line of right.slice(endRight, endRight + DIFF_CONTEXT))
		lines.push(`  ${line}`);
	if (lines.length > DIFF_LINES)
		return [
			...lines.slice(0, DIFF_LINES),
			`... ${lines.length - DIFF_LINES} more lines`,
		].join("\n");
	return lines.join("\n");
};

const snapshotPath = (dir: string, row: StageRow): string =>
	join(dir, STAGE_DIRECTORY, `${row.label.replace(" ", ".")}.json`);

/** The readable diff of one mismatching stage against its snapshot (a channel with none is compared with the atm channel's). */
const diffOf = async (dir: string, row: StageRow): Promise<string> => {
	const header = `${row.label} (${row.name}) differs`;
	const candidates = [
		snapshotPath(dir, row),
		snapshotPath(dir, {
			...row,
			label: row.label.replace(/ .*/, ` ${REFERENCE_CHANNEL}`),
		}),
	];
	for (const path of candidates) {
		const expected = await readFile(path, "utf8").catch(() => null);
		if (expected === null) continue;
		const own = row.canonical;
		if (own === undefined) break;
		if (expected.trimEnd() === pretty(own))
			return `${header}\nthe snapshot in ${STAGE_DIRECTORY}/ equals this run, so hashes.json is stale; run with --update`;
		return `${header}\n${textDiff(expected.trimEnd(), pretty(own))}`;
	}
	return `${header}\n(no snapshot to diff against in ${join(dir, STAGE_DIRECTORY)}: the snapshots are not committed. On a tree that still passes, run atm scenario check <id> --snapshots, then change the code and check again)`;
};

/** Hashes for `hashes.json` from the stages: a channel stage keeps its old golden for a channel that did not run. */
const hashesFrom = (
	previous: BundleHashes,
	actual: readonly StageActual[],
): BundleHashes => {
	const next: BundleHashes = { version: 1 };
	for (const entry of actual) {
		if ("checkpoint" in entry) {
			next[entry.stage] = entry.checkpoint.hash;
			continue;
		}
		const old = previous[entry.stage];
		const merged: Record<string, string> = {};
		for (const [name, value] of Object.entries(entry.channels)) {
			if ("skipped" in value) {
				const kept = typeof old === "object" ? old[name] : undefined;
				if (kept) merged[name] = kept;
			} else merged[name] = value.hash;
		}
		next[entry.stage] = merged;
	}
	return next;
};

const writeSnapshots = async (
	dir: string,
	rows: readonly StageRow[],
): Promise<void> => {
	await mkdir(join(dir, STAGE_DIRECTORY), { recursive: true });
	// the channels agree (an update is refused otherwise), so one snapshot per channel stage serves them all
	for (const row of rows) {
		const [, channel] = row.label.split(" ");
		if (row.canonical === undefined) continue;
		if (channel !== undefined && channel !== REFERENCE_CHANNEL) continue;
		await writeFile(snapshotPath(dir, row), `${pretty(row.canonical)}\n`);
	}
};

/** Every channel that ran must agree on H7 (the parity promise): a bundle is never frozen with channels that disagree. */
const channelsDisagree = (actual: readonly StageActual[]): string | null => {
	const kpis = actual.find((entry) => entry.stage === "H7");
	if (!kpis || !("channels" in kpis)) return null;
	const hashes = new Set(
		Object.values(kpis.channels).flatMap((value) =>
			"hash" in value ? [value.hash] : [],
		),
	);
	return hashes.size > 1
		? `the KPI channels disagree (${Object.entries(kpis.channels)
				.map(
					([name, value]) =>
						`${name} ${"hash" in value ? value.hash.slice(0, HASH_SHOWN) : "skipped"}`,
				)
				.join(", ")}); run atm scenarios parity on the bundle's events`
		: null;
};

const answerProblems = (bundle: ScenarioBundle, run: BundleRun): string[] => {
	const problems: string[] = [];
	const expected = bundle.expected.answers;
	if (expected.length !== run.answers.length)
		problems.push(
			`expected.json lists ${expected.length} answers, the handler gave ${run.answers.length}`,
		);
	for (const [index, answer] of run.answers.entries())
		if (JSON.stringify(answer) !== JSON.stringify(expected[index]))
			problems.push(
				`delivery ${index + 1}: expected ${JSON.stringify(expected[index])}, the handler answered ${JSON.stringify(answer)}`,
			);
	return problems;
};

export type CheckOptions = {
	update?: boolean;
	/** Write the stage snapshots a later diff reads, but only from a run that matches the goldens (they are not committed). */
	snapshots?: boolean;
	channels?: readonly ("atm" | "hledger" | "duckdb")[];
};

/** Runs one bundle and compares (or, with `update`, rewrites) its goldens. */
export const checkBundle = async (
	bundle: ScenarioBundle,
	options: CheckOptions = {},
): Promise<CheckResult> => {
	const run = await runBundle(bundle, {
		...(options.channels ? { channels: options.channels } : {}),
	});
	try {
		const actual = bundleCheckpoints(bundle, run);
		let rows = compareStages(bundle.hashes, actual);
		const problems = answerProblems(bundle, run);
		if (options.update) {
			const disagreement = channelsDisagree(actual);
			if (disagreement) throw new Error(`${bundle.id}: ${disagreement}`);
			if (problems.length > 0)
				throw new Error(
					`${bundle.id}: the handler's answers differ from expected.json, so the bundle is not frozen:\n${problems.join("\n")}`,
				);
			await writeBundleHashes(bundle.dir, hashesFrom(bundle.hashes, actual));
			await writeSnapshots(bundle.dir, rows);
			rows = rows.map((row) =>
				row.status === "skipped" ? row : { ...row, status: "updated" },
			);
			return { id: bundle.id, rows, ok: true, diff: "", answerProblems: [] };
		}
		if (options.snapshots) {
			const unmatched = rows.filter(
				(row) => row.status !== "ok" && row.status !== "skipped",
			);
			if (unmatched.length > 0 || problems.length > 0)
				throw new Error(
					`${bundle.id}: --snapshots writes the text of a run that matches hashes.json, and this one does not (${unmatched.map((row) => row.label).join(", ") || "answers"}); use --update to freeze it`,
				);
			await writeSnapshots(bundle.dir, rows);
		}
		const first = rows.find((row) => row.status === "mismatch");
		const diff = first ? await diffOf(bundle.dir, first) : "";
		return {
			id: bundle.id,
			rows,
			ok:
				problems.length === 0 &&
				rows.every((row) => row.status === "ok" || row.status === "skipped"),
			diff,
			answerProblems: problems,
		};
	} finally {
		await run.dispose();
	}
};

/** The table `atm scenario check` prints: stage, expected, actual, status. */
export const formatCheck = (result: CheckResult): string => {
	const header = ["stage", "expected", "actual", "status"];
	const body = result.rows.map((row) => [
		`${row.label} ${row.name}`,
		row.expected ?? "-",
		row.actual ?? "-",
		row.status,
	]);
	const widths = header.map((_, column) =>
		Math.max(
			header[column]?.length ?? 0,
			...body.map((line) => line[column]?.length ?? 0),
		),
	);
	const line = (cells: string[]) =>
		cells
			.map((cell, column) => cell.padEnd(widths[column] ?? 0))
			.join("  ")
			.trimEnd();
	return [
		`bundle ${result.id}`,
		line(header),
		...body.map(line),
		...result.answerProblems.map((problem) => `answers: ${problem}`),
		...(result.diff ? ["", result.diff] : []),
		"",
	].join("\n");
};
