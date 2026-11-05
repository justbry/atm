/**
 * The hledger channel: the KPI spec computed by the `hledger` CLI over the journals `buildJournal` writes, so that hledger,
 * not our fold, does the adding. `sum` KPIs are `hledger bal -M --flat` (with `--historical` when cumulative) under
 * queries (`desc:` for the event type, `tag:` for the label, `acct:` for the account, `cur:` for the commodity); `count` and
 * `distinct` read `hledger print -O json`, taking the event type from the description, the key and the labels from the tags.
 *
 * What hledger cannot see, and so what differs from the atm channel by construction:
 * - an event with no postings is not a transaction (`monthJournal` leaves it out), so a `count` or `distinct` over such an
 *   event type counts 0 here;
 * - the `credits` commodity sums every non-USD commodity into one number; hledger cannot add different commodities, so a
 *   cell with several is added in TypeScript (the fixtures have one credit commodity);
 * - regexes are POSIX ERE and case-insensitive in hledger (there is no way to turn that off), so the channel refuses to run
 *   when a filter would match differently with and without case (`assertCaseSafe`);
 * - a label value is written as a tag value, which cannot hold a comma or a line break (`tagValue` in the journal).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildJournal } from "../../ledger/journal.js";
import type { AtmEvent } from "../../types.js";
import {
	type BaseKpi,
	type BaseValues,
	isBase,
	type KpiChannel,
	periodsFrom,
} from "../kpis.js";

const USD = "USD";

type Where = BaseKpi["compute"]["where"];

/** A literal as a POSIX ERE (backslash before every character the dialect gives a meaning to). */
const literal = (text: string): string =>
	text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");

const monthAfter = (month: string): string =>
	periodsFrom(month, 2)[1] as string;

/** Every difference between a case-sensitive and a case-insensitive reading of the spec over these events. */
const assertCaseSafe = (events: readonly AtmEvent[], kpis: BaseKpi[]): void => {
	const types = new Set<string>(events.map((e) => e.event_type));
	const accounts = new Set<string>();
	const commodities = new Set<string>();
	const labelValues = new Map<string, Set<string>>();
	for (const e of events) {
		for (const p of e.postings) {
			accounts.add(p.account);
			commodities.add(p.commodity);
		}
		for (const [name, value] of Object.entries(e.labels))
			(
				labelValues.get(name) ?? labelValues.set(name, new Set()).get(name)
			)?.add(value);
	}
	const fold = (values: Iterable<string>, what: string) => {
		const seen = new Map<string, string>();
		for (const v of values) {
			const prior = seen.get(v.toLowerCase());
			if (prior !== undefined && prior !== v)
				throw new Error(
					`hledger channel: ${what} "${prior}" and "${v}" differ only by case, which hledger cannot tell apart`,
				);
			seen.set(v.toLowerCase(), v);
		}
	};
	fold(types, "event types");
	fold(accounts, "accounts");
	fold(commodities, "commodities");
	for (const c of commodities)
		if (c !== USD && c.toUpperCase() === USD)
			throw new Error(
				`hledger channel: commodity "${c}" differs from USD only by case`,
			);
	const agree = (pattern: string, values: Iterable<string>, what: string) => {
		const exact = new RegExp(pattern);
		const loose = new RegExp(pattern, "i");
		for (const v of values)
			if (exact.test(v) !== loose.test(v))
				throw new Error(
					`hledger channel: /${pattern}/ on ${what} "${v}" depends on case, and hledger ignores case`,
				);
	};
	for (const kpi of kpis) {
		const where = kpi.compute.where;
		for (const t of where.eventType ?? [])
			if (
				!types.has(t) &&
				[...types].some((x) => x.toLowerCase() === t.toLowerCase())
			)
				throw new Error(
					`hledger channel: event type "${t}" differs only by case`,
				);
		if (where.account) agree(where.account, accounts, "account");
		if (where.label)
			agree(
				where.label.pattern,
				labelValues.get(where.label.name) ?? [],
				`label ${where.label.name}`,
			);
	}
};

/** The hledger queries for a `where` (the commodity is added by the caller). */
const whereQueries = (where: Where): string[] => [
	...(where.eventType
		? [`desc:^(${where.eventType.map(literal).join("|")})[ ][|]`]
		: []),
	...(where.account ? [`acct:${where.account}`] : []),
	...(where.label
		? [`tag:^${literal(where.label.name)}$=${where.label.pattern}`]
		: []),
];

type Amount = {
	acommodity: string;
	aquantity: { decimalMantissa: number; decimalPlaces: number };
};
type MultiBalance = {
	prDates: [{ contents: string }, { contents: string }][];
	prRows: { prrName: string; prrAmounts: Amount[][] }[];
	prTotals: { prrAmounts: Amount[][] };
};
type Transaction = {
	tdate: string;
	tdescription: string;
	ttags: [string, string][];
};

/** An amount's quantity in minor units of `places` decimals, as hledger's own mantissa and scale give it. */
const units = (amount: Amount, places: number): bigint => {
	const { decimalMantissa, decimalPlaces } = amount.aquantity;
	const mantissa = BigInt(decimalMantissa);
	if (decimalPlaces <= places)
		return mantissa * 10n ** BigInt(places - decimalPlaces);
	const scale = 10n ** BigInt(decimalPlaces - places);
	if (mantissa % scale !== 0n)
		throw new Error(
			`hledger channel: ${mantissa}e-${decimalPlaces} is not a whole number of ${places}-place units`,
		);
	return mantissa / scale;
};

const run = (cwd: string, args: string[]): string => {
	const result = Bun.spawnSync(
		["hledger", "--no-conf", "-f", "main.journal", ...args],
		{
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (result.exitCode !== 0)
		throw new Error(
			`hledger ${args.join(" ")} failed: ${result.stderr.toString().trim().split("\n")[0]}`,
		);
	return result.stdout.toString();
};

const writeBooks = async (
	events: readonly AtmEvent[],
	dir: string,
): Promise<void> => {
	const months = [...new Set(events.map((e) => e.date.slice(0, 7)))].sort();
	for (const month of months)
		for (const [path, text] of Object.entries(
			buildJournal({ events, month }).files,
		)) {
			await mkdir(dirname(join(dir, path)), { recursive: true });
			await writeFile(join(dir, path), text);
		}
};

const dimensionOf = (pattern: string, text: string): string | null =>
	new RegExp(pattern).exec(text)?.[1] ?? null;

export const hledgerChannel: KpiChannel = {
	name: "hledger",
	base: async ({ events, spec, periods }) => {
		const out: BaseValues = {};
		if (periods.length === 0) return out;
		const first = [...periods].sort()[0] as string;
		const last = [...periods].sort().at(-1) as string;
		const known = new Set(periods);
		const kpis = spec.kpis.filter(isBase);
		assertCaseSafe(events, kpis);
		const dir = await mkdtemp(join(tmpdir(), "atm-kpi-hledger-"));
		try {
			await writeBooks(events, dir);
			const range = (cumulative: boolean) =>
				cumulative
					? ["-e", `${monthAfter(last)}-01`]
					: ["-b", `${first}-01`, "-e", `${monthAfter(last)}-01`];
			const set = (id: string, period: string, n: number) => {
				const values = out[id] ?? {};
				values[period] = n + 0;
				out[id] = values;
			};

			for (const kpi of kpis) {
				const c = kpi.compute;
				if (c.op === "sum") {
					const places = c.commodity === "usd" ? 2 : 0;
					const filters = [
						...whereQueries(c.where),
						c.commodity === "usd" ? `cur:^${USD}$` : `not:cur:^${USD}$`,
					];
					// the columns: the requested months; a cumulative sum starts from the first posting (--historical)
					const columns = [
						"-M",
						"--flat",
						...(c.cumulative ? ["--historical"] : []),
						"-b",
						`${first}-01`,
						"-e",
						`${monthAfter(last)}-01`,
					];
					const report = JSON.parse(
						run(dir, ["bal", ...columns, "-O", "json", ...filters]),
					) as MultiBalance;
					const months = report.prDates.map((d) => d[0].contents.slice(0, 7));
					const cells = (amounts: Amount[][]) =>
						months.flatMap((month, i) =>
							known.has(month)
								? [
										[
											month,
											(amounts[i] ?? []).reduce(
												(n, a) => n + units(a, places),
												0n,
											),
										] as const,
									]
								: [],
						);
					// the accounts with a matching posting: a dimension exists when one does, even if it nets to zero
					const used = run(dir, [
						"accounts",
						"--used",
						...range(Boolean(c.cumulative)),
						...filters,
					])
						.split("\n")
						.filter((l) => l.length > 0);
					if (!c.by) {
						const total = cells(report.prTotals.prrAmounts);
						if (used.length > 0)
							for (const [month, n] of total)
								set(kpi.id, month, Number(n) * c.sign);
						continue;
					}
					const groups = new Map<string, string[]>();
					for (const account of used) {
						const dim = dimensionOf(c.by.pattern, account);
						if (dim === null) continue;
						groups.set(dim, [...(groups.get(dim) ?? []), account]);
					}
					const rows = new Map(
						report.prRows.map((r) => [r.prrName, r.prrAmounts] as const),
					);
					for (const [dim, accounts] of groups) {
						const id = `${kpi.id}:${dim}`;
						out[id] ??= {};
						// one account: its own row. Several: hledger adds them (the total of a report limited to them).
						const amounts =
							accounts.length === 1
								? (rows.get(accounts[0] as string) ?? [])
								: (
										JSON.parse(
											run(dir, [
												"bal",
												...columns,
												"-O",
												"json",
												...filters,
												`acct:^(${accounts.map(literal).join("|")})$`,
											]),
										) as MultiBalance
									).prTotals.prrAmounts;
						for (const [month, n] of cells(amounts))
							set(id, month, Number(n) * c.sign);
					}
					continue;
				}
				// count and distinct: the transactions that pass the same filters, read as events
				const filters = whereQueries(c.where);
				const txns = JSON.parse(
					run(dir, [
						"print",
						"-O",
						"json",
						"-b",
						`${first}-01`,
						"-e",
						`${monthAfter(last)}-01`,
						...filters,
					]),
				) as Transaction[];
				const seen = new Set<string>();
				const firstPeriod = new Map<string, string>();
				for (const t of [...txns].sort((a, b) =>
					a.tdate < b.tdate ? -1 : a.tdate > b.tdate ? 1 : 0,
				)) {
					const period = t.tdate.slice(0, 7);
					if (!known.has(period)) continue;
					// tags: at, then the key (`key:<key>`, or the key itself when it holds a colon), then the labels
					const [, keyTag] = t.ttags;
					const key =
						keyTag === undefined
							? ""
							: keyTag[0] === "key"
								? keyTag[1]
								: `${keyTag[0]}:${keyTag[1]}`;
					let dim: string | null | undefined;
					if (c.by) {
						const text =
							c.by.from === "account"
								? undefined
								: t.ttags
										.slice(2)
										.find(
											([name]) => name === c.by?.from.slice("label:".length),
										)?.[1];
						dim = text === undefined ? null : dimensionOf(c.by.pattern, text);
						if (dim === null) continue;
					}
					const id = dim === undefined ? kpi.id : `${kpi.id}:${dim}`;
					if (c.op === "count") {
						set(id, period, (out[id]?.[period] ?? 0) + 1);
						continue;
					}
					if (c.first) {
						const prior = firstPeriod.get(`${id}\u0000${key}`);
						if (prior !== undefined && prior !== period) continue;
						firstPeriod.set(`${id}\u0000${key}`, period);
					}
					const holder = `${id}\u0000${period}\u0000${key}`;
					if (seen.has(holder)) continue;
					seen.add(holder);
					set(id, period, (out[id]?.[period] ?? 0) + 1);
				}
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
		return out;
	},
};
