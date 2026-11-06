/**
 * `atm scenarios list|describe|schema|kpis|parity` and the `--profile` mode of `atm simulate`: a seeded school scenario
 * generated, replayed through every KPI channel and hashed. Exit 0 when every channel that ran agrees, 1 when they do not,
 * 2 for input it cannot use (one line per problem on stderr, written so a caller can fix the input and run again).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import {
	loadScenarioBundle,
	loadScenarioBundles,
	resolveBundleDirectory,
} from "./bundle.js";
import { checkBundle, formatCheck } from "./bundle-check.js";
import { duckdbAvailable, writeKpiParquet } from "./channels/duckdb.js";
import { buildFixture } from "./fixture.js";
import { type KpiRow, kpiHash } from "./kpis.js";
import {
	DEFAULT_PARAMS,
	PARAMS,
	parseSets,
	ScenarioInputError,
	scenarioSchema,
} from "./params.js";
import {
	CHANNEL_NAMES,
	type ChannelName,
	kpiDocument,
	type Parity,
	runParity,
} from "./parity.js";
import { PROFILE_NAMES, PROFILES, profileByName } from "./profiles.js";
import { roundTripEvents } from "./roundtrip.js";
import { summaryOf } from "./summary.js";

export type CliKit = {
	unattended: (
		name: string,
		json: boolean,
		run: () => Promise<void>,
	) => Promise<void>;
	exitTwoOnUsageError: (command: Command) => Command;
	writeJson: (value: unknown) => void;
	InputError: new (message: string) => Error;
};

export type ScenarioOptions = {
	profile?: string;
	scenario?: string;
	set?: string[];
	seed?: string;
	channels?: string;
	json?: boolean;
};

const collect = (value: string, previous: string[] = []) => [
	...previous,
	value,
];

/** The options every scenario command shares. */
export const withScenarioOptions = (command: Command): Command =>
	command
		.option(
			"--profile <name>",
			`a preset (${PROFILE_NAMES.join(", ")}); list them with: atm scenarios list`,
		)
		.option(
			"--scenario <file>",
			'an ad-hoc scenario, JSON like {"profile":"heavy-refunds","params":{"refundRate":0.2}} ("-" reads stdin); the flags below override it',
		)
		.option(
			"--set <key=value>",
			"override a knob, repeatable: --set refundRate=0.2 --set tierMix.audit=5 (knobs: atm scenarios describe <profile>)",
			collect,
		)
		.option("--seed <n>", "the seed, over the preset's")
		.option(
			"--channels <list>",
			`comma list of ${CHANNEL_NAMES.join(", ")}; default all (a missing hledger or duckdb is skipped, not failed)`,
		)
		.option("--json", "print one JSON line instead of the text");

/** Preset, file, `--set` and `--seed` into one scenario input; throws `ScenarioInputError` with a fix in each line. */
export const inputFromOptions = async (
	opts: ScenarioOptions,
): Promise<unknown> => {
	if (!opts.profile && !opts.scenario)
		throw new ScenarioInputError([
			`give --profile <name> (${PROFILE_NAMES.join(", ")}) or --scenario <file.json>`,
		]);
	let input: Record<string, unknown> = {};
	if (opts.scenario) {
		let text: string;
		try {
			text =
				opts.scenario === "-"
					? await Bun.stdin.text()
					: await readFile(opts.scenario, "utf8");
		} catch {
			throw new ScenarioInputError([
				`--scenario ${opts.scenario}: cannot read the file`,
			]);
		}
		try {
			input = JSON.parse(text) as Record<string, unknown>;
		} catch (error) {
			throw new ScenarioInputError([
				`--scenario ${opts.scenario} is not JSON: ${(error as Error).message}`,
			]);
		}
	}
	if (opts.profile) input.profile = opts.profile;
	if (opts.seed !== undefined) {
		const seed = Number(opts.seed);
		input.seed = Number.isInteger(seed) ? seed : opts.seed;
	}
	if (opts.set?.length)
		input.params = {
			...((input.params as object | undefined) ?? {}),
			...mergeSets(parseSets(opts.set)),
		};
	return input;
};

const mergeSets = (sets: Record<string, unknown>) => sets;

const channelsFrom = (opts: ScenarioOptions): ChannelName[] => {
	if (!opts.channels) return [...CHANNEL_NAMES];
	const names = opts.channels.split(",").map((s) => s.trim());
	const bad = names.filter((n) => !CHANNEL_NAMES.includes(n as ChannelName));
	if (bad.length || names.length === 0)
		throw new ScenarioInputError([
			`--channels ${JSON.stringify(opts.channels)}: unknown ${bad.join(", ")}. Use a comma list of ${CHANNEL_NAMES.join(", ")}`,
		]);
	return names as ChannelName[];
};

const parityLines = (parity: Parity): string[] => [
	...parity.runs.map((r) =>
		r.status === "ok"
			? `  ${r.name.padEnd(8)} ${r.hash}`
			: `  ${r.name.padEnd(8)} skipped: ${r.reason}`,
	),
	parity.equal
		? "parity: every channel that ran has the same hash"
		: `parity: MISMATCH (${parity.mismatches.length} KPI-period(s) differ)`,
	...parity.mismatches.slice(0, 40).map((m) => `  ${m}`),
	...(parity.mismatches.length > 40
		? [`  ... ${parity.mismatches.length - 40} more`]
		: []),
];

export type ScenarioRun = Awaited<ReturnType<typeof runScenario>>;

/** Generates the scenario and replays it through the channels. */
export const runScenario = async (opts: ScenarioOptions) => {
	const fixture = buildFixture(await inputFromOptions(opts));
	// the channels see the events as atm's write path returns them (outbox, ship, read), not as the generator built them
	const parity = await runParity({
		events: await roundTripEvents(fixture.events),
		periods: fixture.periods,
		channels: channelsFrom(opts),
	});
	const ran = parity.runs.find((r) => r.status === "ok");
	const rows: KpiRow[] = ran?.status === "ok" ? ran.rows : [];
	return { fixture, parity, rows };
};

const describeRun = ({ fixture, parity, rows }: ScenarioRun) => ({
	ok: true as const,
	profile: fixture.scenario.profile,
	name: fixture.scenario.name,
	seed: fixture.scenario.seed,
	params: fixture.scenario.params,
	fixtureHash: fixture.hash,
	events: fixture.events.length,
	periods: fixture.periods,
	stats: fixture.stats,
	kpisHash: rows.length ? kpiHash(rows) : null,
	parity: {
		equal: parity.equal,
		channels: parity.runs.map((r) =>
			r.status === "ok"
				? { name: r.name, status: r.status, hash: r.hash }
				: { name: r.name, status: r.status, reason: r.reason },
		),
		mismatches: parity.mismatches,
	},
	summary: summaryOf(rows),
});

/** The `atm simulate --profile ...` body. */
export const runScenarioSimulate = async (
	opts: ScenarioOptions,
	kit: CliKit,
) => {
	const run = await runScenario(opts).catch((error) => {
		throw asInputError(error, kit);
	});
	const out = describeRun(run);
	if (opts.json) kit.writeJson(out);
	else {
		const { fixture, parity } = run;
		process.stdout.write(
			[
				`scenario ${out.name} (seed ${out.seed}): ${out.events} events, ${fixture.periods[0]}..${fixture.periods.at(-1)}`,
				`fixture hash ${out.fixtureHash}`,
				`kpis hash by channel:`,
				...parityLines(parity),
				`summary: ${JSON.stringify(out.summary)}`,
				"",
			].join("\n"),
		);
	}
	if (!run.parity.equal) process.exitCode = 1;
};

/** A bad scenario input is the caller's to fix: one line, every problem in it. */
const asInputError = (error: unknown, kit: CliKit): unknown =>
	error instanceof ScenarioInputError
		? new kit.InputError(error.problems.join("; "))
		: error;

const wrap = (
	kit: CliKit,
	name: string,
	opts: { json?: boolean },
	run: () => Promise<void>,
) =>
	kit.unattended(name, opts.json === true, async () => {
		try {
			await run();
		} catch (error) {
			throw asInputError(error, kit);
		}
	});

export const addScenarioCommands = (program: Command, kit: CliKit): void => {
	const scenarios = program
		.command("scenarios")
		.alias("scenario")
		.description(
			"seeded school scenarios for the financial reports: presets (Before University, a demo school), ad-hoc knobs, a content hash of the fixture, and the same KPIs computed by the atm fold, hledger and DuckDB and compared",
		);
	kit.exitTwoOnUsageError(scenarios);

	kit.exitTwoOnUsageError(
		scenarios
			.command("list")
			.description("the presets, one line each")
			.option("--json", "one JSON line")
			.action((opts: { json?: boolean }) =>
				wrap(kit, "scenarios list", opts, async () => {
					if (opts.json)
						kit.writeJson({
							ok: true,
							profiles: PROFILES.map(({ name, summary, seed }) => ({
								name,
								summary,
								seed,
							})),
						});
					else
						process.stdout.write(
							`${PROFILES.map((p) => `${p.name.padEnd(16)} seed ${String(p.seed).padEnd(4)} ${p.summary}`).join("\n")}\n\nmore: atm scenarios describe <name>\n`,
						);
				}),
			),
	);

	kit.exitTwoOnUsageError(
		scenarios
			.command("describe")
			.argument("<profile>", "a preset name")
			.description(
				"a preset's seed, its knobs (which differ from the defaults) and copy-paste commands",
			)
			.option("--json", "one JSON line")
			.action((name: string, opts: { json?: boolean }) =>
				wrap(kit, "scenarios describe", opts, async () => {
					let profile: ReturnType<typeof profileByName>;
					try {
						profile = profileByName(name);
					} catch {
						throw new ScenarioInputError([
							`no preset ${JSON.stringify(name)}; presets: ${PROFILE_NAMES.join(", ")}`,
						]);
					}
					const params = { ...DEFAULT_PARAMS, ...profile.params };
					const examples = [
						`atm simulate --profile ${profile.name} --json`,
						`atm simulate --profile ${profile.name} --seed 7 --set refundRate=0.1 --json`,
						`atm scenario kpis --profile ${profile.name} --out ./out`,
					];
					if (opts.json)
						kit.writeJson({
							ok: true,
							...profile,
							params,
							defaults: DEFAULT_PARAMS,
							knobs: PARAMS,
							examples,
						});
					else
						process.stdout.write(
							[
								`${profile.name}: ${profile.summary}`,
								`seed ${profile.seed}`,
								"knobs (* = differs from the default):",
								...Object.entries(params).map(([k, v]) => {
									const differs =
										JSON.stringify(v) !==
										JSON.stringify(
											(DEFAULT_PARAMS as Record<string, unknown>)[k],
										);
									return `  ${differs ? "*" : " "} ${k} = ${JSON.stringify(v)}  (${PARAMS[k as keyof typeof PARAMS].doc})`;
								}),
								"",
								...examples.map((e) => `  ${e}`),
								"",
							].join("\n"),
						);
				}),
			),
	);

	kit.exitTwoOnUsageError(
		scenarios
			.command("schema")
			.description("the JSON Schema of an ad-hoc scenario (--scenario file)")
			.action(() => kit.writeJson(scenarioSchema(PROFILE_NAMES))),
	);

	kit.exitTwoOnUsageError(
		scenarios
			.command("check")
			.argument(
				"[target]",
				"a bundle folder or an id under fixtures/scenarios; default every committed bundle",
			)
			.description(
				"replay a scenario bundle (deliveries, Stripe side, hand numbers) through the handler, outbox, ship, journal, KPI channels and reconcile, and compare the H1 to H8 checkpoints with its hashes.json; exit 0 when all match, 1 with a diff of the first mismatching stage when not",
			)
			.option(
				"--update",
				"write hashes.json and the stage snapshots from this run (refused while the KPI channels disagree or the answers differ from expected.json)",
			)
			.option(
				"--snapshots",
				"write the readable stage text a later mismatch is diffed against (not committed); refused unless this run matches hashes.json",
			)
			.option(
				"--channels <list>",
				`comma list of ${CHANNEL_NAMES.join(", ")}; default all (a missing hledger or duckdb is skipped, not failed)`,
			)
			.option("--json", "print one JSON line instead of the table")
			.action(
				(
					target: string | undefined,
					opts: {
						update?: boolean;
						snapshots?: boolean;
						channels?: string;
						json?: boolean;
					},
				) =>
					wrap(kit, "scenarios check", opts, async () => {
						const channels = channelsFrom(opts);
						let bundles: Awaited<ReturnType<typeof loadScenarioBundles>>;
						try {
							bundles = target
								? [await loadScenarioBundle(resolveBundleDirectory(target))]
								: await loadScenarioBundles();
						} catch {
							throw new ScenarioInputError([
								`${target ?? "fixtures/scenarios"}: no bundle there; give a folder with scenario.json or an id from fixtures/scenarios`,
							]);
						}
						const results = [];
						for (const bundle of bundles)
							results.push(
								await checkBundle(bundle, {
									...(opts.update ? { update: true } : {}),
									...(opts.snapshots ? { snapshots: true } : {}),
									channels,
								}),
							);
						if (opts.json)
							kit.writeJson({
								ok: results.every((r) => r.ok),
								bundles: results.map(
									({ id, ok, rows, diff, answerProblems }) => ({
										id,
										ok,
										stages: rows.map(({ label, expected, actual, status }) => ({
											stage: label,
											expected,
											actual,
											status,
										})),
										diff,
										answerProblems,
									}),
								),
							});
						else
							process.stdout.write(
								results
									.map((r) =>
										opts.update || !r.ok || bundles.length === 1
											? formatCheck(r)
											: `bundle ${r.id}: ok\n`,
									)
									.join(""),
							);
						if (!results.every((r) => r.ok)) process.exitCode = 1;
					}),
			),
	);

	kit.exitTwoOnUsageError(
		withScenarioOptions(
			scenarios
				.command("parity")
				.description(
					"generate a scenario and compare the channels' KPI hashes; exit 0 when they agree, 1 with a per-KPI diff when they do not",
				),
		).action((opts: ScenarioOptions) =>
			wrap(kit, "scenarios parity", opts, () => runScenarioSimulate(opts, kit)),
		),
	);

	kit.exitTwoOnUsageError(
		withScenarioOptions(
			scenarios
				.command("kpis")
				.description(
					"write <out>/<name>/kpis.json (canonical, hashed) and kpis.parquet (long format: profile, kpi_id, period, value DOUBLE, unit; skipped when duckdb is missing) for a scenario",
				)
				.requiredOption("--out <dir>", "the folder to write under"),
		).action((opts: ScenarioOptions & { out: string }) =>
			wrap(kit, "scenarios kpis", opts, async () => {
				const run = await runScenario(opts);
				const { fixture, parity, rows } = run;
				if (!parity.equal) {
					process.stderr.write(`${parityLines(parity).join("\n")}\n`);
					process.exitCode = 1;
					return;
				}
				const dir = join(opts.out, fixture.scenario.name);
				await mkdir(dir, { recursive: true });
				await writeFile(
					join(dir, "kpis.json"),
					kpiDocument({
						profile: fixture.scenario.name,
						seed: fixture.scenario.seed,
						fixtureHash: fixture.hash,
						rows,
					}),
				);
				const parquet = duckdbAvailable()
					? await writeKpiParquet({
							rows,
							profile: fixture.scenario.name,
							path: join(dir, "kpis.parquet"),
						})
					: {
							written: false,
							reason: "duckdb is not installed or does not run",
						};
				const out = {
					ok: true,
					dir,
					kpisJson: join(dir, "kpis.json"),
					kpisParquet: parquet.written ? join(dir, "kpis.parquet") : null,
					parquetSkipped: parquet.written ? undefined : parquet.reason,
					kpisHash: kpiHash(rows),
					fixtureHash: fixture.hash,
				};
				if (opts.json) kit.writeJson(out);
				else
					process.stdout.write(
						`wrote ${out.kpisJson}\n${parquet.written ? `wrote ${out.kpisParquet}` : `skipped kpis.parquet: ${parquet.reason}`}\nkpis hash ${out.kpisHash}\n`,
					);
			}),
		),
	);
};
