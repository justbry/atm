/**
 * The golden end-to-end check (`docs/golden-e2e-check.md`): the golden fixtures put through the whole pipeline with the real
 * `atm` command line as separate processes, on file-backed WAL SQLite and a folder, never through library calls.
 *
 *   S1  every bundle (the 39 matrix cases and the rest) through the reference handler into one database file per school, then
 *       `atm inputs ship`, `atm ship`, `atm journal`, `atm report`, `atm reconcile` and `atm simulate --inputs` (database and
 *       folder, no candidate and with candidates), against the committed goldens
 *   S2  the golden year and the multi-school fixture: ship, journal, report, reconcile, byte for byte against golden/{journal,reports,multi}
 *   S3  an erasure drill with a search of every file and table for the erased family's strings and ids
 *   S4  SIGKILL of `atm inputs ship`, `atm ship` and the erasure settle, then a rerun, against an uninterrupted run
 *   S5  hashes of the database and the folder around every read-only command (inside S1 to S4)
 *   S6  the same under TZ=America/Denver and TZ=Asia/Tokyo
 *
 * The default run is a sample that takes about two minutes. `ATM_GOLDEN_E2E=full` runs every bundle, all kill points and both
 * time zones over everything. `ATM_GOLDEN_E2E_SHARD=1/6` runs one sixth of either run (of its bundles, then of the tests after
 * them), to run six processes at once. S7, the scale probe, is `scripts/golden-e2e-scale.ts`. A finding is something the
 * design says should not happen: the ones known today are listed below and pinned, so a test fails when one appears or goes
 * away.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultBundlesDirectory,
	loadScenarioBundle,
} from "../src/scenario/bundle.js";
import {
	checkBundle,
	REFUSED_NOT_IN_FOLDER,
	type RunOptions,
} from "./golden-e2e-cases.js";
import { checkCrash } from "./golden-e2e-crash.js";
import { checkErasure } from "./golden-e2e-erasure.js";
import { makeWorld, type Outcomes } from "./golden-e2e-lib.js";
import { checkWhatIfs } from "./golden-e2e-whatif.js";
import { checkLogFixture } from "./golden-e2e-years.js";
import { hasHledger } from "./helpers.js";

const FULL = process.env.ATM_GOLDEN_E2E === "full";
const SHARD = /^(\d+)\/(\d+)$/.exec(process.env.ATM_GOLDEN_E2E_SHARD ?? "");
if (
	process.env.ATM_GOLDEN_E2E_SHARD &&
	!(SHARD && Number(SHARD[1]) >= 1 && Number(SHARD[1]) <= Number(SHARD[2]))
)
	throw new Error(
		`ATM_GOLDEN_E2E_SHARD must be i/n with 1 <= i <= n, not ${process.env.ATM_GOLDEN_E2E_SHARD}`,
	);
const QUICK_BUNDLES = ["create", "second-school", "refused-invoice"];
const TIME_ZONES = ["America/Denver", "Asia/Tokyo"] as const;
const MINUTES = 60_000;
/** A time zone for every process of the run (`ATM_GOLDEN_E2E_TZ=Asia/Tokyo`), the handler's included. */
const ZONE = process.env.ATM_GOLDEN_E2E_TZ;
const TEST_TIMEOUT = FULL ? 20 * MINUTES : 4 * MINUTES;

/** The raw bytes finding of S3: the erased facts stay in the `-wal` until it is checkpointed. */
const ERASED_FACT_IN_WAL =
	"after: an erased fact is still in the raw bytes of the SQLite file or its -wal";

/** Findings pinned by scenario: what the run shows today and the design says it should not. */
const KNOWN_FINDINGS: Record<string, string[]> = {
	"refused-invoice": [REFUSED_NOT_IN_FOLDER],
	"renewal-before-create": [REFUSED_NOT_IN_FOLDER],
	"erasure-drill": [ERASED_FACT_IN_WAL],
};

const findingsOf = (rec: Outcomes): string[] =>
	rec.outcomes
		.filter((outcome) => outcome.status === "FINDING")
		.map((outcome) => outcome.check);

/** With ATM_GOLDEN_E2E_REPORT=<file>, one JSON line per scenario run (for the results table of the doc). */
const REPORT_FILE = process.env.ATM_GOLDEN_E2E_REPORT;
const note = (line: Record<string, unknown>) => {
	if (REPORT_FILE)
		appendFileSync(
			REPORT_FILE,
			`${JSON.stringify({ zone: ZONE ?? null, ...line })}\n`,
		);
};

const expectPinned = (scenario: string, rec: Outcomes) => {
	note({
		scenario,
		checks: rec.outcomes.length,
		findings: rec.outcomes
			.filter((outcome) => outcome.status === "FINDING")
			.map((outcome) => ({ check: outcome.check, detail: outcome.detail })),
	});
	const known = KNOWN_FINDINGS[scenario] ?? [];
	const found = findingsOf(rec);
	const gone = known.filter((check) => !found.includes(check));
	const detail = rec.outcomes
		.filter((outcome) => outcome.status === "FINDING")
		.map((outcome) => `${outcome.check}: ${outcome.detail}`)
		.join("\n");
	// A pinned finding that no longer shows is either a fix (update KNOWN_FINDINGS and docs/golden-e2e-check.md knowingly) or a
	// check that stopped looking; the message says so, because the bare list diff does not.
	const goneNote = gone.length
		? `\nPINNED FINDING NO LONGER REPORTED in ${scenario}: ${gone.join(" | ")}\nIf the behavior was fixed, remove it from KNOWN_FINDINGS and update docs/golden-e2e-check.md; if not, this check stopped detecting it.`
		: "";
	expect(found, `${detail}${goneNote}`).toEqual(known);
};

const withTimeZone = async <T>(zone: string, run: () => Promise<T>) => {
	const before = process.env.TZ;
	process.env.TZ = zone;
	try {
		return await run();
	} finally {
		if (before === undefined) delete process.env.TZ;
		else process.env.TZ = before;
	}
};

/** Every bundle of the run, in every shard: the full run's are all of them, the sample's three. */
const BUNDLES: string[] = FULL
	? readdirSync(defaultBundlesDirectory(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort()
	: QUICK_BUNDLES;

/** The tests after the bundles of S1, one unit each for a shard. */
const LATER_UNITS = [
	"what-if",
	"years",
	"erasure",
	"crash",
	"zones",
	"dist",
] as const;

/** With a shard set, this process runs every n-th unit of the run, from the i-th: the bundles, then the later tests. */
const inShard = (position: number): boolean =>
	!SHARD || position % Number(SHARD[2]) === Number(SHARD[1]) - 1;

const bundleIds = (): string[] =>
	BUNDLES.filter((_, position) => inShard(position));

const runsHere = (unit: (typeof LATER_UNITS)[number]): boolean =>
	inShard(BUNDLES.length + LATER_UNITS.indexOf(unit));

const runBundle = async (
	id: string,
	options: RunOptions,
	zone: string | undefined = ZONE,
): Promise<Outcomes> => {
	const bundle = await loadScenarioBundle(join(defaultBundlesDirectory(), id));
	const world = await makeWorld(id);
	try {
		return zone
			? await withTimeZone(zone, () =>
					checkBundle(bundle, world, { ...options, tz: zone }),
				)
			: await checkBundle(bundle, world, options);
	} finally {
		await world.dispose();
	}
};

const logFixture = (
	name: Parameters<typeof checkLogFixture>[0],
): Promise<Outcomes> =>
	ZONE
		? withTimeZone(ZONE, () => checkLogFixture(name, { tz: ZONE }))
		: checkLogFixture(name, {});

if (!hasHledger)
	test.skip("golden end-to-end check: skipped because hledger is not installed (brew install hledger); it builds journals and reports with it", () => {});
else {
	describe("S1: bundles through the command line", () => {
		for (const id of bundleIds())
			test(
				`${id}`,
				async () => {
					expectPinned(id, await runBundle(id, {}));
					// with ATM_GOLDEN_E2E_TZ set, runBundle puts the handler and every process in that zone
				},
				TEST_TIMEOUT,
			);
	});

	describe.if(runsHere("what-if"))("S1: the what-if goldens", () => {
		test(
			"upgradeGrant prorated, full and none, a price and allowance change and a rollover cap equal golden/simulate",
			async () => {
				expectPinned(
					"what-if goldens",
					await checkWhatIfs(ZONE ? { tz: ZONE } : {}),
				);
			},
			TEST_TIMEOUT,
		);
	});

	describe.if(runsHere("years"))(
		"S2: the golden year and the multi-school fixture",
		() => {
			test(
				"vibes-multi",
				async () => {
					expectPinned("vibes-multi", await logFixture("vibes-multi"));
				},
				TEST_TIMEOUT,
			);
			if (FULL)
				test(
					"vibes-year",
					async () => {
						expectPinned("vibes-year", await logFixture("vibes-year"));
					},
					TEST_TIMEOUT,
				);
		},
	);

	describe.if(runsHere("erasure"))("S3: an erasure drill", () => {
		test(
			"one family is erased and nothing of it is left but what the design keeps",
			async () => {
				const { rec, report } = await checkErasure({});
				note({ scenario: "erasure-report", report });
				expectPinned("erasure-drill", rec);
			},
			TEST_TIMEOUT,
		);
	});

	describe.if(runsHere("crash"))("S4: SIGKILL and rerun", () => {
		test(
			"atm inputs ship, atm ship and the erasure settle converge to an uninterrupted run",
			async () => {
				const { rec, report } = await checkCrash(FULL);
				note({ scenario: "crash-report", report });
				expectPinned("crash-drill", rec);
			},
			TEST_TIMEOUT,
		);
	});

	describe.if(runsHere("zones") && !ZONE)("S6: time zones", () => {
		test(
			"create and vibes-multi give the same bytes under Denver and Tokyo as under the machine's zone",
			async () => {
				const reference = await runBundle("create", {});
				const referenceMulti = await checkLogFixture("vibes-multi", {});
				for (const zone of TIME_ZONES) {
					const rec = await runBundle("create", { tz: zone }, zone);
					expectPinned("create", rec);
					expect(rec.facts.folder, `create folder under ${zone}`).toBe(
						reference.facts.folder as string,
					);
					const multi = await withTimeZone(zone, () =>
						checkLogFixture("vibes-multi", { tz: zone }),
					);
					expectPinned("vibes-multi", multi);
					expect(multi.facts.folder, `vibes-multi folder under ${zone}`).toBe(
						referenceMulti.facts.folder as string,
					);
				}
			},
			TEST_TIMEOUT,
		);
	});

	describe.if(runsHere("dist") && !ZONE)("the built dist/atm.js", () => {
		test(
			"create through the built command line",
			async () => {
				const out = await mkdtemp(join(tmpdir(), "atm-golden-dist-"));
				try {
					const build = Bun.spawnSync(
						[process.execPath, join(import.meta.dir, "../build.ts"), out],
						{ stdout: "pipe", stderr: "pipe" },
					);
					expect(build.exitCode, build.stderr.toString()).toBe(0);
					const bin = join(out, "atm.js");
					expect(existsSync(bin)).toBe(true);
					expectPinned("create", await runBundle("create", { bin }));
				} finally {
					await rm(out, { recursive: true, force: true });
				}
			},
			TEST_TIMEOUT,
		);
	});
}
