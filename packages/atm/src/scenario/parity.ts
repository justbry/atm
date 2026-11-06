/**
 * Replays one event stream through every KPI channel (the atm fold, hledger, DuckDB), hashes each channel's KPIs and
 * compares them. A channel whose binary is missing is skipped with a reason, never failed.
 */
import { canonicalize } from "../ledger/util.js";
import type { AtmEvent } from "../types.js";
import { atmChannel } from "./channels/atm.js";
import { duckdbChannel } from "./channels/duckdb.js";
import { hledgerChannel } from "./channels/hledger.js";
import {
	type BaseValues,
	diffKpis,
	evaluateKpis,
	type KpiChannel,
	type KpiRow,
	type KpiSpec,
	kpiHash,
	SCHOOL_KPIS,
} from "./kpis.js";

const runsWithVersion = (command: string, args: string[]): boolean => {
	try {
		return (
			Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" })
				.exitCode === 0
		);
	} catch {
		return false;
	}
};

export type ChannelName = "atm" | "hledger" | "duckdb";
export const CHANNEL_NAMES: readonly ChannelName[] = [
	"atm",
	"hledger",
	"duckdb",
];

const CHANNELS: Record<
	ChannelName,
	{ channel: KpiChannel; available: () => boolean }
> = {
	atm: { channel: atmChannel, available: () => true },
	hledger: {
		channel: hledgerChannel,
		available: () => runsWithVersion("hledger", ["--version"]),
	},
	duckdb: {
		channel: duckdbChannel,
		available: () => runsWithVersion("duckdb", ["--version"]),
	},
};

export type ChannelRun =
	| {
			name: ChannelName;
			status: "ok";
			/** What the channel computed before the shared derived-KPI math: the channel's report (H6). */
			base: BaseValues;
			rows: KpiRow[];
			hash: string;
	  }
	| { name: ChannelName; status: "skipped"; reason: string };

export type Parity = {
	runs: ChannelRun[];
	/** Every channel that ran has the atm channel's hash. */
	equal: boolean;
	/** One readable line per KPI-period that differs from the atm channel, labelled with the KPI's title. */
	mismatches: string[];
};

export const runParity = async ({
	events,
	periods,
	spec = SCHOOL_KPIS,
	channels = CHANNEL_NAMES,
	mutate,
}: {
	events: readonly AtmEvent[];
	periods: readonly string[];
	spec?: KpiSpec;
	channels?: readonly ChannelName[];
	/** Test hook: change the events one channel sees (a one-cent mutation) to prove the diff catches drift. */
	mutate?: Partial<
		Record<ChannelName, (events: readonly AtmEvent[]) => readonly AtmEvent[]>
	>;
}): Promise<Parity> => {
	const runs: ChannelRun[] = [];
	for (const name of channels) {
		const entry = CHANNELS[name];
		if (!entry.available()) {
			runs.push({
				name,
				status: "skipped",
				reason: `${name} is not installed or does not run`,
			});
			continue;
		}
		const seen = mutate?.[name]?.(events) ?? events;
		const base = await entry.channel.base({ events: seen, spec, periods });
		const rows = evaluateKpis({ spec, base, periods });
		runs.push({ name, status: "ok", base, rows, hash: kpiHash(rows) });
	}
	const ok = runs.filter(
		(r): r is Extract<ChannelRun, { status: "ok" }> => r.status === "ok",
	);
	const reference = ok[0];
	const titles = new Map(spec.kpis.map((k) => [k.id, k.title]));
	const mismatches: string[] = [];
	if (reference)
		for (const other of ok.slice(1))
			for (const line of diffKpis(
				{ name: reference.name, rows: reference.rows },
				{ name: other.name, rows: other.rows },
			)) {
				const id = line.split(" ")[0]?.split(":")[0] as string;
				mismatches.push(`${titles.get(id) ?? id}: ${line}`);
			}
	return {
		runs,
		equal: ok.every((r) => r.hash === reference?.hash),
		mismatches,
	};
};

/** The document `kpis.json` holds: the rows plus the hash they are checked against (sha256 of `canonicalize` of the rows without `unit`). */
export const kpiDocument = ({
	profile,
	seed,
	fixtureHash,
	rows,
}: {
	profile: string;
	seed: number;
	fixtureHash: string;
	rows: readonly KpiRow[];
}): string =>
	`${canonicalize({ version: 1, profile, seed, fixtureHash, kpisHash: kpiHash(rows), rows })}\n`;
