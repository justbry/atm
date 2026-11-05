import { describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateYear } from "../fixtures/vibes.js";
import {
	journalMonth,
	listEventFiles,
	readEvents,
} from "../src/ledger/files.js";
import { buildJournal } from "../src/ledger/journal.js";
import { decimalToUnits } from "../src/ledger/util.js";
import { hasHledger, readTree, tmp } from "./helpers.js";

const GOLDEN_FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const GOLDEN_DIR = join(import.meta.dir, "golden/journal");
const GOLDEN_MONTH = "2026-03";
const fixture = generateYear({ seed: 1 });
const bin = join(import.meta.dir, "../src/bin.ts");

const copyFixture = async () => {
	const dir = await tmp("journal");
	await cp(GOLDEN_FIXTURE, dir, { recursive: true });
	return dir;
};
const school = (dir: string) => join(dir, "schools/sch_vol");
const months = [
	...new Set(fixture.events.map((e) => e.date.slice(0, 7))),
].sort();

const cli = (dir: string, month: string) =>
	Bun.spawnSync(
		[
			"bun",
			bin,
			"journal",
			"--root",
			dir,
			"--school",
			"sch_vol",
			"--month",
			month,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

describe("atm journal", () => {
	test("a month's files match the golden files byte for byte", async () => {
		const dir = await copyFixture();
		const run = cli(dir, GOLDEN_MONTH);
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
		const got = await readTree(school(dir));
		const journals = Object.fromEntries(
			Object.entries(got).filter(
				([k]) => k.endsWith(".journal") || k === "ledger/build.json",
			),
		);
		if (process.env.UPDATE_GOLDEN) {
			for (const [path, text] of Object.entries(journals)) {
				await mkdir(join(GOLDEN_DIR, path, ".."), { recursive: true });
				await writeFile(join(GOLDEN_DIR, path), text);
			}
		}
		expect(journals).toEqual(await readTree(GOLDEN_DIR));
	});

	test("declares every account and a commodity per credit feature", async () => {
		const accounts = buildJournal({ events: fixture.events, month: "2026-01" })
			.files["ledger/accounts.journal"] as string;
		const used = new Set(
			fixture.events.flatMap((e) => e.postings.map((p) => p.account)),
		);
		for (const a of used) expect(accounts).toContain(`account ${a}\n`);
		expect(accounts).toContain("commodity 1,000.00 USD\n");
		expect(accounts).toContain("commodity 1. VISIT\n");
	});

	test("one transaction per event with postings, sorted by date then id, with no wall-clock", () => {
		const b = buildJournal({ events: fixture.events, month: GOLDEN_MONTH });
		const text = b.files[`ledger/b4u/${GOLDEN_MONTH}.journal`] as string;
		const heads = text.split("\n").filter((l) => /^\d{4}-/.test(l));
		expect(heads.length).toBe(b.transactions);
		const keys = heads.map(
			(l) => `${l.slice(0, 10)} ${/\((\w+)\)/.exec(l)?.[1]}`,
		);
		expect(keys).toEqual([...keys].sort());
		expect(text).not.toMatch(/generated/i);
		// an event with no postings is not a transaction
		expect(text).not.toContain("plan.attached");
	});

	test("the same events give the same bytes in any input order", () => {
		const a = buildJournal({ events: fixture.events, month: GOLDEN_MONTH });
		const b = buildJournal({
			events: [...fixture.events].reverse(),
			month: GOLDEN_MONTH,
		});
		expect(b).toEqual(a);
	});

	test("a second run writes nothing", async () => {
		const dir = await copyFixture();
		const first = await journalMonth({
			root: dir,
			school: "sch_vol",
			month: GOLDEN_MONTH,
		});
		expect(first.written.length).toBeGreaterThan(0);
		const before = await readTree(school(dir));
		const second = await journalMonth({
			root: dir,
			school: "sch_vol",
			month: GOLDEN_MONTH,
		});
		expect(second.unchanged).toBe(true);
		expect(await readTree(school(dir))).toEqual(before);
	});

	test("a day with day.jsonl reads that file and its late-* batches, not the batches it combined", async () => {
		const dir = await copyFixture();
		const day = fixture.events[0]?.date as string;
		const base = join(school(dir), "events", `date=${day}`);
		await writeFile(join(base, "day.jsonl"), "");
		await writeFile(join(base, "late-x.jsonl"), "");
		const listed = (await listEventFiles(dir, "sch_vol")).filter((f) =>
			f.includes(`date=${day}/`),
		);
		expect(listed).toEqual([
			`events/date=${day}/day.jsonl`,
			`events/date=${day}/late-x.jsonl`,
		]);
	});

	test("an event repeated under the same idem is read once", async () => {
		const dir = await copyFixture();
		const { files } = await readEvents(dir, "sch_vol");
		const key = files[0]?.key as string;
		const text = await readFile(join(school(dir), key), "utf8");
		await writeFile(
			join(school(dir), key.replace(".jsonl", "-dup.jsonl")),
			text,
		);
		const { events } = await readEvents(dir, "sch_vol");
		expect(events.length).toBe(fixture.events.length);
	});
});

const hledger = (cwd: string, args: string[]) =>
	Bun.spawnSync(["hledger", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

describe.skipIf(!hasHledger)("hledger agrees", () => {
	const buildAll = async () => {
		const dir = await copyFixture();
		for (const m of months) expect(cli(dir, m).exitCode).toBe(0);
		return school(dir);
	};

	test("check balanced accounts commodities passes on main.journal", async () => {
		const cwd = await buildAll();
		const r = hledger(cwd, [
			"-f",
			"main.journal",
			"check",
			"balanced",
			"accounts",
			"commodities",
		]);
		expect(r.stderr.toString()).toBe("");
		expect(r.exitCode).toBe(0);
	});

	test("bal totals equal the sum of postings, per account and commodity", async () => {
		const cwd = await buildAll();
		const r = hledger(cwd, [
			"-f",
			"main.journal",
			"bal",
			"--flat",
			"--no-total",
			"-O",
			"csv",
		]);
		expect(r.exitCode).toBe(0);
		const got: Record<string, bigint> = {};
		for (const line of r.stdout.toString().trim().split("\n").slice(1)) {
			const m = /^"([^"]+)","(-?[\d,.]+) ([A-Z]+)"$/.exec(line);
			expect(m, line).not.toBeNull();
			got[`${m?.[1]} ${m?.[3]}`] = decimalToUnits(
				(m?.[2] as string).replace(/,/g, ""),
				m?.[3] === "USD" ? 2 : 0,
			);
		}
		const want: Record<string, bigint> = {};
		for (const e of fixture.events) {
			for (const p of e.postings) {
				const k = `${p.account} ${p.commodity}`;
				want[k] =
					(want[k] ?? 0n) +
					decimalToUnits(p.amount, p.commodity === "USD" ? 2 : 0);
			}
		}
		for (const k of Object.keys(want)) if (want[k] === 0n) delete want[k];
		expect(got).toEqual(want);
	});

	test("a month's totals (-p) equal that month's postings, and stats counts the transactions", async () => {
		const cwd = await buildAll();
		const month = GOLDEN_MONTH;
		const r = hledger(cwd, [
			"-f",
			"main.journal",
			"bal",
			"-p",
			month,
			"--flat",
			"--no-total",
			"-O",
			"csv",
		]);
		expect(r.exitCode).toBe(0);
		const want: Record<string, bigint> = {};
		for (const e of fixture.events.filter((e) => e.date.startsWith(month))) {
			for (const p of e.postings) {
				const k = `${p.account} ${p.commodity}`;
				want[k] =
					(want[k] ?? 0n) +
					decimalToUnits(p.amount, p.commodity === "USD" ? 2 : 0);
			}
		}
		const got: Record<string, bigint> = {};
		for (const line of r.stdout.toString().trim().split("\n").slice(1)) {
			const m = /^"([^"]+)","(-?[\d,.]+) ([A-Z]+)"$/.exec(line);
			got[`${m?.[1]} ${m?.[3]}`] = decimalToUnits(
				(m?.[2] as string).replace(/,/g, ""),
				m?.[3] === "USD" ? 2 : 0,
			);
		}
		for (const k of Object.keys(want)) if (want[k] === 0n) delete want[k];
		expect(got).toEqual(want);
		const stats = hledger(cwd, [
			"-f",
			"main.journal",
			"stats",
		]).stdout.toString();
		const n = /Txns\s*:\s*(\d+)/.exec(stats)?.[1];
		expect(Number(n)).toBe(
			fixture.events.filter((e) => e.postings.length > 0).length,
		);
	});
});
