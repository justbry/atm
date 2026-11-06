/**
 * `atm keys new`, `atm receipt`, `atm verify receipt`, `atm seal` and `atm verify seals` end to end over a temporary
 * folder: the golden year goes through the handler's outbox and `atm ship`, as a school's books do, then a receipt and a
 * seal are made and checked, and an edit to an event file breaks both.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { readEvents } from "../src/ledger/files.js";
import { appendToOutbox } from "../src/ledger/outbox.js";
import type { AtmEvent, AtmSignedReceipt } from "../src/types.js";
import { readTree, tmp } from "./helpers.js";

const SCHOOL = "sch_vol";
const KEY_ID = "trifold-test";
const BIN = join(import.meta.dir, "../src/bin.ts");
const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const OWNER_ONLY = 0o600;
const PERMISSION_BITS = 0o777;

let folder = "";
let root = "";
let keys = "";
let fixtureEvents: AtmEvent[] = [];

const atm = (args: string[]) => {
	const run = Bun.spawnSync([process.execPath, BIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: run.exitCode,
		stdout: run.stdout.toString(),
		stderr: run.stderr.toString(),
	};
};

const schoolArgs = () => ["--root", root, "--school", SCHOOL];
const signing = () => [
	"--key",
	join(keys, `${KEY_ID}.private.pem`),
	"--key-id",
	KEY_ID,
];
const keysFile = () => join(keys, "keys.json");

beforeAll(async () => {
	folder = await tmp("cli-receipt");
	root = join(folder, "books");
	keys = join(folder, "keys");
	await mkdir(root);
	({ events: fixtureEvents } = await readEvents(FIXTURE, SCHOOL));
	const database = new Database(join(folder, "handler.sqlite"), {
		create: true,
	});
	const db = bunSqlite(database);
	db.exec(HANDLER_DDL);
	appendToOutbox(db, fixtureEvents, "live");
	database.close();
	const shipped = atm([
		"ship",
		"--db",
		join(folder, "handler.sqlite"),
		...schoolArgs(),
	]);
	expect(shipped.exitCode).toBe(0);
});

afterAll(async () => {
	await rm(folder, { recursive: true, force: true });
});

describe("signed receipts and sealed months from the CLI", () => {
	test("keys new writes the pair and keys.json, the private key owner-only, and overwrites nothing", async () => {
		const made = atm(["keys", "new", "--out", keys, "--id", KEY_ID]);
		expect(made.stderr).toBe("");
		expect(made.exitCode).toBe(0);
		expect(Object.keys(await readTree(keys)).sort()).toEqual([
			"keys.json",
			`${KEY_ID}.private.pem`,
			`${KEY_ID}.public.pem`,
		]);
		const mode = (await stat(join(keys, `${KEY_ID}.private.pem`))).mode;
		expect(mode & PERMISSION_BITS).toBe(OWNER_ONLY);
		const published = JSON.parse(await readFile(keysFile(), "utf8"));
		expect(published).toEqual({
			[KEY_ID]: await readFile(join(keys, `${KEY_ID}.public.pem`), "utf8"),
		});
		const again = atm(["keys", "new", "--out", keys, "--id", KEY_ID]);
		expect(again.exitCode).toBe(2);
		expect(again.stderr).toContain("already exists");
		expect(atm(["keys", "new", "--out", keys, "--id", "../x"]).exitCode).toBe(
			2,
		);
	});

	test("receipt, verify receipt against the books, then an edited event file fails with event_changed", async () => {
		const printed = atm(["receipt", ...schoolArgs(), ...signing()]);
		expect(printed.stderr).toBe("");
		expect(printed.exitCode).toBe(0);
		const receipts = printed.stdout
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as AtmSignedReceipt);
		const receipted = fixtureEvents.filter((event) =>
			["payment.succeeded", "payment.refunded"].includes(event.event_type),
		);
		expect(receipts.map((signed) => signed.receipt.event_id)).toEqual(
			receipted.map((event) => event.id),
		);
		const receipt = receipts.find(
			(signed) => signed.receipt.event_type === "payment.succeeded",
		) as AtmSignedReceipt;
		const one = atm([
			"receipt",
			...schoolArgs(),
			...signing(),
			"--event",
			receipt.receipt.event_id,
		]);
		expect(JSON.parse(one.stdout)).toEqual(receipt);
		const file = join(folder, "receipt.json");
		await writeFile(file, `${JSON.stringify(receipt)}\n`);

		const signatureOnly = atm([
			"verify",
			"receipt",
			file,
			"--keys",
			keysFile(),
		]);
		expect(signatureOnly.exitCode).toBe(0);
		expect(JSON.parse(signatureOnly.stdout)).toEqual({ ok: true });
		const againstBooks = [
			"verify",
			"receipt",
			file,
			"--keys",
			keysFile(),
			...schoolArgs(),
		];
		expect(atm(againstBooks)).toMatchObject({ exitCode: 0, stderr: "" });

		const tree = await readTree(join(root, "schools", SCHOOL));
		const [path, text] = Object.entries(tree).find(([, body]) =>
			body.includes(receipt.receipt.event_id),
		) as [string, string];
		const amount = `"amount_paid":${receipt.receipt.amount}`;
		expect(text).toContain(amount);
		await writeFile(
			join(root, "schools", SCHOOL, path),
			text.replace(amount, `"amount_paid":${receipt.receipt.amount + 1}`),
		);
		const edited = atm(againstBooks);
		expect(edited.exitCode).toBe(1);
		expect(JSON.parse(edited.stdout)).toEqual({
			ok: false,
			reason: "event_changed",
		});
		await writeFile(join(root, "schools", SCHOOL, path), text);

		await writeFile(file, "not a receipt");
		const garbage = atm(["verify", "receipt", file, "--keys", keysFile()]);
		expect(garbage.exitCode).toBe(1);
		expect(JSON.parse(garbage.stdout)).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	test("seal appends to ledger/seals.jsonl, verify seals passes, and an edit in the sealed month fails it", async () => {
		for (const month of ["2026-03", "2026-04"]) {
			const sealed = atm([
				"seal",
				...schoolArgs(),
				"--month",
				month,
				...signing(),
			]);
			expect(sealed.stderr).toBe("");
			expect(sealed.exitCode).toBe(0);
		}
		const chain = (
			await readFile(
				join(root, "schools", SCHOOL, "ledger/seals.jsonl"),
				"utf8",
			)
		)
			.trimEnd()
			.split("\n");
		expect(chain.map((line) => JSON.parse(line).seal.month)).toEqual([
			"2026-03",
			"2026-04",
		]);
		const verify = ["verify", "seals", ...schoolArgs(), "--keys", keysFile()];
		const passed = atm(verify);
		expect(passed.exitCode).toBe(0);
		expect(JSON.parse(passed.stdout)).toMatchObject({
			ok: true,
			unsealedLate: [],
		});

		const tree = await readTree(join(root, "schools", SCHOOL));
		const [path, text] = Object.entries(tree).find(([key]) =>
			key.startsWith("events/date=2026-03-"),
		) as [string, string];
		await writeFile(
			join(root, "schools", SCHOOL, path),
			text.replace('"text":"', '"text":"edited '),
		);
		const failed = atm(verify);
		expect(failed.exitCode).toBe(1);
		expect(
			JSON.parse(failed.stdout).seals.map(
				(row: { verdict: string }) => row.verdict,
			),
		).toEqual(["events_changed", "ok"]);
	});
});
