/**
 * `atm keys new`, `atm receipt`, `atm seal` and `atm verify` end to end over a copy of the golden year: exit 0 valid, 1 not
 * valid, 2 an error.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmp } from "./helpers.js";

const SCHOOL = "sch_vol";
const KEY_ID = "test-key-1";
const BIN = join(import.meta.dir, "../src/bin.ts");
const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const PRIVATE_KEY_MODE = 0o600;
const PERMISSION_BITS = 0o777;

let root = "";
let keysDir = "";

const atm = (args: string[]) => {
	const run = Bun.spawnSync([process.execPath, BIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: run.exitCode,
		stdout: run.stdout.toString(),
		stderr: run.stderr.toString(),
	};
};

const signing = () => [
	"--key",
	join(keysDir, `${KEY_ID}.private.pem`),
	"--key-id",
	KEY_ID,
];

beforeEach(async () => {
	root = await tmp("receipt-cli");
	keysDir = join(root, "keys");
	await cp(FIXTURE, root, { recursive: true });
	expect(atm(["keys", "new", "--out", keysDir, "--id", KEY_ID]).code).toBe(0);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("keys new", () => {
	test("writes a private key only its owner can read, the public key and keys.json, and never overwrites", async () => {
		const mode = (await stat(join(keysDir, `${KEY_ID}.private.pem`))).mode;
		expect(mode & PERMISSION_BITS).toBe(PRIVATE_KEY_MODE);
		const keys = JSON.parse(await readFile(join(keysDir, "keys.json"), "utf8"));
		expect(Object.keys(keys)).toEqual([KEY_ID]);
		expect(await readdir(keysDir)).toContain(`${KEY_ID}.public.pem`);
		const again = atm(["keys", "new", "--out", keysDir, "--id", KEY_ID]);
		expect(again.code).toBe(2);
		expect(again.stderr).toContain("already has a key");
	});
});

describe("receipt and verify receipt", () => {
	test("every payment and refund gets a receipt that verifies against the books, until the books change", async () => {
		const run = atm([
			"receipt",
			"--root",
			root,
			"--school",
			SCHOOL,
			...signing(),
		]);
		expect(run.code).toBe(0);
		const lines = run.stdout.trim().split("\n");
		expect(lines.length).toBe(13); // 12 payments and 1 refund in the golden year
		const file = join(root, "receipt.json");
		await writeFile(file, lines[0] as string);
		const keys = join(keysDir, "keys.json");
		const valid = atm([
			"verify",
			"receipt",
			file,
			"--keys",
			keys,
			"--root",
			root,
			"--school",
			SCHOOL,
		]);
		expect(valid).toMatchObject({ code: 0, stdout: "valid\n" });

		const receipt = JSON.parse(lines[0] as string).receipt;
		const eventsDir = join(
			root,
			"schools",
			SCHOOL,
			"events",
			`date=${receipt.date}`,
		);
		for (const name of await readdir(eventsDir)) {
			const path = join(eventsDir, name);
			const text = await readFile(path, "utf8");
			await writeFile(
				path,
				text.replace(
					`"amount_paid":${receipt.amount}`,
					`"amount_paid":${receipt.amount - 1}`,
				),
			);
		}
		const changed = atm([
			"verify",
			"receipt",
			file,
			"--keys",
			keys,
			"--root",
			root,
			"--school",
			SCHOOL,
			"--json",
		]);
		expect(changed.code).toBe(1);
		expect(JSON.parse(changed.stdout)).toEqual({
			ok: false,
			reason: "event_changed",
		});
	});

	test("a tampered receipt is not valid; a bad option is an error", async () => {
		const run = atm([
			"receipt",
			"--root",
			root,
			"--school",
			SCHOOL,
			...signing(),
		]);
		const signed = JSON.parse(run.stdout.trim().split("\n")[0] as string);
		signed.receipt.amount += 100;
		const file = join(root, "tampered.json");
		await writeFile(file, JSON.stringify(signed));
		const keys = join(keysDir, "keys.json");
		expect(atm(["verify", "receipt", file, "--keys", keys])).toMatchObject({
			code: 1,
			stdout: "not valid: bad_signature\n",
		});
		expect(
			atm(["verify", "receipt", file, "--keys", keys, "--root", root]).code,
		).toBe(2);
		expect(
			atm([
				"receipt",
				"--root",
				root,
				"--school",
				SCHOOL,
				"--event",
				"nope",
				...signing(),
			]).code,
		).toBe(2);
	});
});

describe("seal and verify seals", () => {
	test("seals of past months (the fixture runs past today) chain in ledger/seals.jsonl and verify until a sealed month is edited", async () => {
		for (const month of ["2026-09", "2026-10"])
			expect(
				atm([
					"seal",
					"--root",
					root,
					"--school",
					SCHOOL,
					"--month",
					month,
					...signing(),
				]).code,
			).toBe(0);
		const sealsFile = join(root, "schools", SCHOOL, "ledger", "seals.jsonl");
		expect((await readFile(sealsFile, "utf8")).trim().split("\n").length).toBe(
			2,
		);
		const keys = join(keysDir, "keys.json");
		const ok = atm([
			"verify",
			"seals",
			"--root",
			root,
			"--school",
			SCHOOL,
			"--keys",
			keys,
		]);
		expect(ok.code).toBe(0);
		expect(ok.stdout).toContain("ok 2026-09");

		const events = join(root, "schools", SCHOOL, "events");
		const day = (await readdir(events)).find((d) =>
			d.startsWith("date=2026-09-"),
		);
		const dayDir = join(events, day as string);
		const name = (await readdir(dayDir))[0] as string;
		const text = await readFile(join(dayDir, name), "utf8");
		await writeFile(
			join(dayDir, name),
			text.replace('"text":"', '"text":"edited '),
		);
		const broken = atm([
			"verify",
			"seals",
			"--root",
			root,
			"--school",
			SCHOOL,
			"--keys",
			keys,
			"--json",
		]);
		expect(broken.code).toBe(1);
		expect(JSON.parse(broken.stdout).seals[0].verdict).toBe("events_changed");
	});
});
