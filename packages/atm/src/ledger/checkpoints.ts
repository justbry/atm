/**
 * Hash checkpoints: one canonicalizer per stage of the pipeline, so two runs of the same case (here, in CI, or in the
 * family service's contract test) can be compared stage by stage and the first stage that differs names the layer at fault.
 *
 *   H1  deliveries             the Stripe events and the family-service steps put in, in delivery order
 *   H2  mutations, decisions   what the handler answered, what it decided about each input, and every row it wrote, in order
 *   H3  outbox                 the decision events waiting to ship (id order)
 *   H4  ledger file tree       the shipped event files: sorted paths, lines in id order
 *   H5  journal                everything else the log folder holds: the journals and the build record
 *   H6  reports, per channel   the base aggregates each KPI channel computed (atm fold, hledger, DuckDB)
 *   H7  KPI doc, per channel   the evaluated KPI rows of each channel
 *   H8  reconcile verdict      what `atm reconcile` found for each month
 *
 * Canonical form, every stage: object keys sorted, whole numbers only (money as integer minor units; a number with a
 * fraction is refused, except a ratio KPI's value), instants as ISO 8601 UTC with `Z`, and the volatile fields (when a row
 * shipped or was claimed, which worker, run ids) left out. Each hash is the sha256 of that text.
 *
 * These hashes belong to tests, CI and the export job. Never put one in anything a viewer can read: hidden cells have small
 * value sets, and a hash of unsuppressed KPI data is an oracle that can be brute-forced.
 */
import type {
	ChannelReport,
	Checkpoint,
	CheckpointKpiRow,
	CheckpointStep,
	FileTree,
	MutationCheckpointInput,
	OutboxCheckpointRow,
	ReconcileVerdictInput,
} from "../types.js";
import { canonicalize, isoInstant, sha256Hex } from "./util.js";

/** Fields that change from run to run or machine to machine and say nothing about what the books hold. */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
	"shippedAt",
	"shipped_at",
	"receivedAt",
	"received_at",
	"claimedAt",
	"claimed_at",
	"claimedBy",
	"claimed_by",
	"doneAt",
	"done_at",
	"takenAt",
	"taken_at",
	"firstUsedAt",
	"first_used_at",
	"runId",
	"run_id",
	"workerId",
]);

type Stable =
	| null
	| boolean
	| number
	| string
	| Stable[]
	| { [key: string]: Stable };

const stable = (
	value: unknown,
	path: string,
	allowFraction: boolean,
): Stable => {
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error(`checkpoint: ${path} is not a finite number`);
		if (!Number.isInteger(value) && !allowFraction)
			throw new Error(
				`checkpoint: ${path} is ${value}; money is whole minor units`,
			);
		return value;
	}
	if (Array.isArray(value))
		return value.map((entry, index) =>
			stable(entry, `${path}[${index}]`, allowFraction),
		);
	if (typeof value === "object" && value !== undefined) {
		const out: { [key: string]: Stable } = {};
		for (const key of Object.keys(value).sort()) {
			const entry = (value as Record<string, unknown>)[key];
			if (entry === undefined || VOLATILE_KEYS.has(key)) continue;
			out[key] = stable(entry, `${path}.${key}`, allowFraction);
		}
		return out;
	}
	throw new Error(`checkpoint: ${path} is a ${typeof value}, not JSON`);
};

const text = (value: unknown, allowFraction = false): string =>
	canonicalize(stable(value, "$", allowFraction));

const checkpoint = (canonical: string): Checkpoint => ({
	canonical,
	hash: sha256Hex(canonical),
});

const bySchool = <T>(
	entries: Readonly<Record<string, T>>,
	canonicalOf: (entry: T) => unknown,
): Record<string, unknown> =>
	Object.fromEntries(
		Object.keys(entries)
			.sort()
			.map((school) => [school, canonicalOf(entries[school] as T)]),
	);

// ---- H1: deliveries ----

export const canonicalDeliveries = (
	steps: readonly CheckpointStep[],
): Checkpoint =>
	checkpoint(
		text(steps.map(({ atMs, ...rest }) => ({ ...rest, at: isoInstant(atMs) }))),
	);

// ---- H2: engine mutations and decisions ----

export const canonicalMutations = (
	perSchool: Readonly<Record<string, MutationCheckpointInput>>,
): Checkpoint =>
	checkpoint(
		text(
			bySchool(perSchool, ({ answers, decisions, mutations }) => ({
				answers,
				decisions,
				mutations,
			})),
		),
	);

// ---- H3: outbox ----

export const canonicalOutbox = (
	perSchool: Readonly<Record<string, readonly OutboxCheckpointRow[]>>,
): Checkpoint =>
	checkpoint(
		text(
			bySchool(perSchool, (rows) =>
				[...rows]
					.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
					.map((row) => ({
						id: row.id,
						idem: row.idem,
						date: row.date,
						event: JSON.parse(row.body) as unknown,
					})),
			),
		),
	);

// ---- H4 and H5: the log folder ----

const EVENTS_PREFIX = "events/";

const isJsonLines = (path: string): boolean => path.endsWith(".jsonl");

/** Lines of a JSON-lines file as parsed objects in event id order (a line without an id keeps its place). */
const sortedLines = (content: string): unknown[] =>
	content
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { id?: string })
		.sort((a, b) => {
			const left = a.id ?? "";
			const right = b.id ?? "";
			return left < right ? -1 : left > right ? 1 : 0;
		});

const fileCanonical = (path: string, content: string): unknown => {
	if (isJsonLines(path)) return sortedLines(content);
	if (path.endsWith(".json")) return JSON.parse(content) as unknown;
	return content;
};

const subTree = (tree: FileTree, keep: (path: string) => boolean): unknown[] =>
	Object.keys(tree)
		.filter(keep)
		.sort()
		.map((path) => ({
			path,
			content: fileCanonical(path, tree[path] as string),
		}));

/** The shipped event files (`events/date=…/…jsonl`): sorted paths, lines in id order. */
export const canonicalLedgerTree = (
	perSchool: Readonly<Record<string, FileTree>>,
): Checkpoint =>
	checkpoint(
		text(
			bySchool(perSchool, (tree) =>
				subTree(tree, (path) => path.startsWith(EVENTS_PREFIX)),
			),
		),
	);

/** Everything else in the folder: the journals, the account declarations and the build record. */
export const canonicalJournal = (
	perSchool: Readonly<Record<string, FileTree>>,
): Checkpoint =>
	checkpoint(
		text(
			bySchool(perSchool, (tree) =>
				subTree(tree, (path) => !path.startsWith(EVENTS_PREFIX)),
			),
		),
	);

// ---- H6 and H7: per channel ----

/** What one KPI channel reported (H6), one canonical text per channel name. */
export const canonicalReports = (
	perChannel: Readonly<Record<string, ChannelReport>>,
): Record<string, Checkpoint> =>
	Object.fromEntries(
		Object.keys(perChannel)
			.sort()
			.map((name) => [name, checkpoint(text(perChannel[name], false))]),
	);

const byKpi = (a: CheckpointKpiRow, b: CheckpointKpiRow) =>
	a.kpiId < b.kpiId
		? -1
		: a.kpiId > b.kpiId
			? 1
			: a.period < b.period
				? -1
				: a.period > b.period
					? 1
					: 0;

/**
 * The evaluated KPI rows of one channel (H7): `{kpiId, period, value}` sorted by id then period. This is the text
 * `kpiHash` hashes, so a channel's H7 equals the hash `atm scenarios parity` prints for it. A ratio's value may have a
 * fraction; every other KPI is whole units.
 */
export const canonicalKpis = (
	perChannel: Readonly<Record<string, readonly CheckpointKpiRow[]>>,
): Record<string, Checkpoint> =>
	Object.fromEntries(
		Object.keys(perChannel)
			.sort()
			.map((name) => [
				name,
				checkpoint(
					text(
						[...(perChannel[name] as readonly CheckpointKpiRow[])]
							.sort(byKpi)
							.map(({ kpiId, period, value }) => ({ kpiId, period, value })),
						true,
					),
				),
			]),
	);

// ---- H8: reconcile ----

export const canonicalReconcile = (
	perSchool: Readonly<
		Record<string, Readonly<Record<string, ReconcileVerdictInput>>>
	>,
): Checkpoint =>
	checkpoint(
		text(
			bySchool(perSchool, (months) =>
				Object.fromEntries(
					Object.keys(months)
						.sort()
						.map((month) => {
							const verdict = months[month] as ReconcileVerdictInput;
							return [
								month,
								{
									clean: verdict.differences.length === 0,
									differences: verdict.differences.map(
										({ kind, object, id, period, stripe, log }) => ({
											kind,
											object,
											id,
											period,
											stripe,
											log,
										}),
									),
									counts: verdict.counts,
									ignored: verdict.ignored,
									skipped: verdict.skipped,
								},
							];
						}),
				),
			),
		),
	);
