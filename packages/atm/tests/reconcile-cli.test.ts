/** `atm reconcile` run as a process: exit 0 when the books agree, 1 when they differ, 2 for input it cannot use. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import type { ReconcileResult, ReconcileStripe } from "../src/types.js";
import { tmp } from "./helpers.js";
import { stripeSideOf } from "./stripe-side.js";

const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const BIN = join(import.meta.dir, "../src/bin.ts");
const SCHOOL = "sch_vol";
type FiveLists = Omit<ReconcileStripe, "paymentIntents">;
const FILE_NAMES: Record<keyof FiveLists, string> = {
	invoices: "invoices.json",
	refunds: "refunds.json",
	disputes: "disputes.json",
	payouts: "payouts.json",
	balanceTransactions: "balance_transactions.json",
};

let root: string;
let scratch: string;
let stripe: Required<FiveLists>;

beforeAll(async () => {
	root = await tmp("reconcile-root");
	scratch = await tmp("reconcile-stripe");
	await cp(FIXTURE, root, { recursive: true });
	stripe = stripeSideOf((await readEvents(FIXTURE, SCHOOL)).events);
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(scratch, { recursive: true, force: true });
});

/** A folder of the files `stripe ... list` would print; `lists` overrides what is written, `null` leaves a file out. */
let folderCount = 0;
const stripeFolder = async (
	lists: { [K in keyof ReconcileStripe]?: unknown } = {},
): Promise<string> => {
	const folder = join(scratch, `stripe-${folderCount++}`);
	await mkdir(folder);
	for (const [list, file] of Object.entries(FILE_NAMES)) {
		const data =
			list in lists
				? lists[list as keyof ReconcileStripe]
				: stripe[list as keyof FiveLists];
		if (data === null) continue;
		await writeFile(join(folder, file), JSON.stringify(data));
	}
	return folder;
};

const atm = async (...args: string[]) => {
	const run = Bun.spawn(["bun", BIN, "reconcile", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(run.stdout).text(),
		new Response(run.stderr).text(),
		run.exited,
	]);
	return { stdout, stderr, exitCode };
};

const base = (folder: string) => [
	"--root",
	root,
	"--school",
	SCHOOL,
	"--stripe",
	folder,
];

describe("atm reconcile", () => {
	test("exit 0 and a summary when the books agree", async () => {
		const run = await atm(...base(await stripeFolder()), "--month", "2026-01");
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.stdout).toContain(
			"reconcile 2026-01 (America/Denver, live mode)",
		);
		expect(run.stdout).toContain("invoice: Stripe 1, log 1");
		expect(run.stdout).toContain("no differences");
	});

	test("a range of days works as a month does", async () => {
		const run = await atm(
			...base(await stripeFolder()),
			"--from",
			"2026-01-01",
			"--to",
			"2026-12-31",
		);
		expect(run.exitCode).toBe(0);
	});

	test("exit 1 and a line per difference when an invoice is a cent off", async () => {
		const changed = stripe.invoices.map((invoice, index) =>
			index === 0
				? { ...invoice, amount_paid: invoice.amount_paid + 1 }
				: invoice,
		);
		const folder = await stripeFolder({ invoices: changed });
		const run = await atm(...base(folder), "--month", "2026-01");
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toContain("amount_differs: invoice in_0_lw1hm");
		expect(run.stdout).toContain("1 difference(s)");
	});

	test("--json prints the result, and still exits 1 on a difference", async () => {
		const folder = await stripeFolder({ refunds: [] });
		const run = await atm(...base(folder), "--month", "2026-10", "--json");
		expect(run.exitCode).toBe(1);
		const result = JSON.parse(run.stdout) as ReconcileResult;
		expect(result.differences.map((d) => [d.kind, d.object, d.id])).toEqual([
			["missing_in_stripe", "refund", "re_9"],
		]);
		expect(result.period.label).toBe("2026-10");
	});

	test("--json on clean books has no differences and exit 0", async () => {
		const run = await atm(
			...base(await stripeFolder()),
			"--month",
			"2026-01",
			"--json",
		);
		expect(run.exitCode).toBe(0);
		expect((JSON.parse(run.stdout) as ReconcileResult).differences).toEqual([]);
	});

	test("a missing file runs none of its checks, so it exits 2 with the result still printed", async () => {
		const folder = await stripeFolder({ refunds: null, disputes: null });
		const run = await atm(...base(folder), "--month", "2026-01");
		expect(run.exitCode).toBe(2);
		expect(run.stdout).toContain("not supplied: refunds.json");
		expect(run.stdout).toContain("not supplied: disputes.json");
		expect(run.stderr.trim().split("\n")).toHaveLength(1);
		expect(run.stderr).toContain("refunds.json, disputes.json");
		const json = await atm(...base(folder), "--month", "2026-01", "--json");
		expect(json.exitCode).toBe(2);
		expect((JSON.parse(json.stdout) as ReconcileResult).notSupplied).toEqual([
			"refunds",
			"disputes",
		]);
	});

	test("the list object `stripe ... list` prints is read like a bare array", async () => {
		const folder = await stripeFolder({
			invoices: { object: "list", data: stripe.invoices, has_more: false },
		});
		expect((await atm(...base(folder), "--month", "2026-01")).exitCode).toBe(0);
	});

	test("--mode test ignores the live objects", async () => {
		const run = await atm(
			...base(await stripeFolder()),
			"--month",
			"2026-01",
			"--mode",
			"test",
		);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toContain(
			"ignored 23 Stripe record(s): live_mode_object",
		);
	});
});

describe("atm reconcile with input it cannot use", () => {
	const expectBad = (
		run: { stderr: string; stdout: string; exitCode: number },
		message: string,
	) => {
		expect(run.exitCode).toBe(2);
		expect(run.stdout).toBe("");
		expect(run.stderr.trim().split("\n")).toHaveLength(1);
		expect(run.stderr).toContain(message);
	};

	test("a missing option", async () => {
		expectBad(
			await atm("--root", root, "--school", SCHOOL, "--month", "2026-01"),
			"--root, --school and --stripe are required",
		);
	});

	test("no period, and both kinds of period", async () => {
		const folder = await stripeFolder();
		expectBad(
			await atm(...base(folder)),
			"give --month YYYY-MM, or both --from and --to",
		);
		expectBad(
			await atm(...base(folder), "--month", "2026-01", "--from", "2026-01-01"),
			"not both",
		);
	});

	test("a month that is not a month, a range backwards, a zone that is not one", async () => {
		const folder = await stripeFolder();
		expectBad(await atm(...base(folder), "--month", "2026-13"), "YYYY-MM");
		expectBad(
			await atm(...base(folder), "--from", "2026-02-02", "--to", "2026-02-01"),
			"on or before",
		);
		expectBad(
			await atm(
				...base(folder),
				"--month",
				"2026-01",
				"--time-zone",
				"Mars/Olympus",
			),
			"IANA",
		);
		expectBad(
			await atm(...base(folder), "--month", "2026-01", "--mode", "staging"),
			"live or test",
		);
	});

	test("an unknown option exits 2 too, not 1", async () => {
		const run = await atm(
			...base(await stripeFolder()),
			"--month",
			"2026-01",
			"--nope",
		);
		expect(run.exitCode).toBe(2);
	});

	test("a Stripe folder that is not there, is empty, or holds bad JSON", async () => {
		expectBad(
			await atm(...base(join(scratch, "nope")), "--month", "2026-01"),
			"is not a folder",
		);
		const empty = join(scratch, "empty");
		await mkdir(empty);
		expectBad(await atm(...base(empty), "--month", "2026-01"), "has none of");
		const broken = await stripeFolder();
		await writeFile(join(broken, "payouts.json"), "{not json");
		expectBad(
			await atm(...base(broken), "--month", "2026-01"),
			"payouts.json is not valid JSON",
		);
	});

	test("a list that is not a list, a record without its numbers, a page with more to fetch", async () => {
		expectBad(
			await atm(
				...base(await stripeFolder({ refunds: { id: "re_1" } })),
				"--month",
				"2026-10",
			),
			"refunds.json must be a JSON array",
		);
		expectBad(
			await atm(
				...base(await stripeFolder({ refunds: [{ id: "re_1" }] })),
				"--month",
				"2026-10",
			),
			"refunds.json record 0",
		);
		expectBad(
			await atm(
				...base(
					await stripeFolder({
						payouts: { object: "list", data: [], has_more: true },
					}),
				),
				"--month",
				"2026-10",
			),
			"has_more",
		);
	});

	test("a school that is not one folder name", async () => {
		const folder = await stripeFolder();
		for (const school of ["..", ".", "a/b"]) {
			const run = await atm(
				"--root",
				root,
				"--school",
				school,
				"--stripe",
				folder,
				"--month",
				"2026-01",
			);
			expectBad(run, "must be one folder name");
		}
	});

	test("an amount that is not whole cents", async () => {
		const run = await atm(
			...base(
				await stripeFolder({
					refunds: [{ id: "re_1", amount: 129.99, created: 1 }],
				}),
			),
			"--month",
			"2026-10",
		);
		expectBad(run, "refunds.json record 0");
	});

	test("an events file that is not JSON is bad input, not a crash that exits 1", async () => {
		const broken = await tmp("reconcile-broken");
		const day = join(broken, "schools", "sch_bad", "events", "date=2026-01-05");
		await mkdir(day, { recursive: true });
		await writeFile(join(day, "batch-1.jsonl"), "{not json\n");
		const run = await atm(
			"--root",
			broken,
			"--school",
			"sch_bad",
			"--stripe",
			await stripeFolder(),
			"--month",
			"2026-01",
			"--time-zone",
			"UTC",
		);
		expectBad(run, "cannot read the events of sch_bad");
		await rm(broken, { recursive: true, force: true });
	});

	test("a school that has no folder", async () => {
		const run = await atm(
			"--root",
			root,
			"--school",
			"sch_nope",
			"--stripe",
			await stripeFolder(),
			"--month",
			"2026-01",
		);
		expectBad(run, "no school folder");
	});

	test("no events and no --time-zone", async () => {
		const empty = await tmp("reconcile-empty");
		await mkdir(join(empty, "schools", "sch_empty"), { recursive: true });
		const folder = await stripeFolder();
		expectBad(
			await atm(
				"--root",
				empty,
				"--school",
				"sch_empty",
				"--stripe",
				folder,
				"--month",
				"2026-01",
			),
			"pass timeZone",
		);
		const withZone = await atm(
			"--root",
			empty,
			"--school",
			"sch_empty",
			"--stripe",
			folder,
			"--month",
			"2026-01",
			"--time-zone",
			"America/Denver",
		);
		expect(withZone.exitCode).toBe(1);
		await rm(empty, { recursive: true, force: true });
	});
});
