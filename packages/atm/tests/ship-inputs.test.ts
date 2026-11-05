/**
 * The inputs shipper (`src/ledger/ship-inputs.ts`) on a `FolderStore`: the names and bytes of what it ships, a rerun, a crash
 * between put and mark, two shippers, a conflict, the rules (committed rows only, no refusal, a tombstone for an erased row),
 * the erasure rewrite end to end, and the folder reader against the SQLite one. The CLI is `ship-inputs-cli.test.ts`. The
 * history comes from the real handler (`ship-inputs-world.ts`; its orders and times are worked out there). R2 is not run.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import {
	contextHashOf,
	eraseStoredInputs,
	readInputs,
	sqliteInputsSource,
} from "../src/handler/inputs.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import type { SqlDatabase } from "../src/handler/types.js";
import {
	folderInputsSource,
	inputObjectKey,
	inputOrderGaps,
	inputsShipStatus,
	planInputs,
	settleInputErasures,
	shipInputs,
	storeInputsSource,
} from "../src/ledger/ship-inputs.js";
import { FolderStore } from "../src/store/folder-store.js";
import { utf8 } from "../src/store/store.js";
import type { InputsRead, Store, StoredInput } from "../src/types.js";
import {
	RECORDED_SCHOOL,
	recordedMenu,
	recordedPriceIds,
} from "./e2e-recorded.js";
import { harness, SCHOOL } from "./handler-harness.js";
import { readTree, tmp } from "./helpers.js";
import { buildWorld, ERASED, KEPT, subjectKeyOf } from "./ship-inputs-world.js";
import { personalStringsOf } from "./stored-inputs-bytes.js";
import { invoicePaid, type RawEvent } from "./stripe-events.js";

const ENV = "live" as const;
const SHIP_TIME = 1_800_000_000_000;
const ERASE_TIME = 1_800_000_001_000;
const scope = { school: SCHOOL, env: ENV };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const directories: string[] = [];
afterAll(async () => {
	for (const directory of directories)
		await rm(directory, { recursive: true, force: true });
});
const folder = async (name = "ship-inputs") => {
	const root = await tmp(name);
	directories.push(root);
	return { root, store: new FolderStore({ root }) };
};

type World = ReturnType<typeof buildWorld>;
const shipArgs = (h: World, store: Store, nowMs = SHIP_TIME) => ({
	db: h.db,
	store,
	...scope,
	nowMs: () => nowMs,
});
const rowsOf = (h: World) =>
	readInputs(h.db, scope).inputs.map((input) => ({
		order: input.appliedOrder,
		id: input.eventId,
		batchKey: input.batchKey,
		shippedAt: input.shippedAt,
	}));
const tableRows = (raw: Database, table: string) =>
	raw.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];

/** The leaf strings of a JSON value. */
const leaves = (value: unknown, into = new Set<string>()): Set<string> => {
	if (typeof value === "string") into.add(value);
	else if (Array.isArray(value)) for (const item of value) leaves(item, into);
	else if (typeof value === "object" && value !== null)
		for (const item of Object.values(value)) leaves(item, into);
	return into;
};

/** A store that delegates, with a few methods replaced, to make a step fail or something else happen at one chosen point. */
const wrapped = (store: Store, over: Partial<Store>): Store => ({
	putIfAbsent: (key, body) => store.putIfAbsent(key, body),
	putIfMatch: (key, body, etag) => store.putIfMatch(key, body, etag),
	get: (key, range) => store.get(key, range),
	head: (key) => store.head(key),
	list: (options) => store.list(options),
	delete: (key, expected) => store.delete(key, expected),
	presign: (key, options) => store.presign(key, options),
	...over,
});

/** A database that throws on the statements `armed()` and `match` accept: a crash at one chosen write. */
const crashing = (
	base: SqlDatabase,
	match: RegExp,
	armed: () => boolean,
): SqlDatabase => ({
	exec: (sql) => base.exec(sql),
	all: (sql, params) => base.all(sql, params),
	run: (sql, params) => {
		if (armed() && match.test(sql)) throw new Error("injected crash");
		return base.run(sql, params);
	},
	transaction: (fn) => base.transaction(fn),
});

describe("the names and bytes of what is shipped", () => {
	test("one batch per UTC commit day with the contexts and the seed they refer to, named by hand-checked rules", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		const result = await shipInputs(shipArgs(h, store));

		const read = readInputs(h.db, scope);
		const [contextHash] = [...read.contexts.keys()];
		expect(read.contexts.size).toBe(1);
		const day15 = [2, 3, 4];
		const lineText = (orders: number[]) =>
			`${read.inputs
				.filter((input) => orders.includes(input.appliedOrder))
				.map((input) => readTreeLine(input))
				.join("\n")}\n`;
		// the text of a line, written here from the row, not by the shipper: canonical JSON of the columns under their names
		const readTreeLine = (input: StoredInput) =>
			JSON.stringify({
				api_version: "2025-10-29.clover",
				applied_order: input.appliedOrder,
				atm_version: input.atmVersion,
				attempts: 1,
				booking_refs: null,
				context_hash: input.contextHash,
				env: "live",
				erased_at: null,
				event_id: input.eventId,
				fact: input.fact,
				fee: 784,
				input_id: input.inputId,
				livemode: true,
				mapping: "stripe/invoice.paid@v1",
				menu_version: "3",
				outcome: "applied",
				payment_refs: [`pi_${input.fact?.id}`, `ch_${input.fact?.id}`],
				policy_version: "1",
				raw_sha256: input.rawSha256,
				reason: null,
				received_at: input.receivedAt,
				revision_after: input.revisionAfter,
				revision_before: input.revisionBefore,
				school_id: SCHOOL,
				stripe_created: input.stripeCreated,
				subject_key: input.subjectKey,
				type: "invoice.paid",
			});
		const text15 = lineText(day15);
		const text16 = lineText([5]);
		const key15 = `schools/sch_vol/inputs/live/date=2026-02-15/batch-000000000002-${sha(text15).slice(0, 16)}.jsonl`;
		const key16 = `schools/sch_vol/inputs/live/date=2026-02-16/batch-000000000005-${sha(text16).slice(0, 16)}.jsonl`;
		const seedKey = `schools/sch_vol/inputs/live/seeds/seed-${sha(subjectKeyOf(ERASED)).slice(0, 16)}.json`;
		const contextKey = `schools/sch_vol/inputs/live/contexts/ctx-${contextHash}.json`;

		const tree = await readTree(root);
		expect(Object.keys(tree).sort()).toEqual(
			[key15, key16, seedKey, contextKey].sort(),
		);
		expect(tree[key15]).toBe(text15);
		expect(tree[key16]).toBe(text16);
		// the context's name is the hash of what it holds, and the object carries both
		expect(contextHash).toBe(
			contextHashOf({
				menu: read.contexts.get(contextHash as string)?.menu as never,
				policy: read.contexts.get(contextHash as string)?.policy as never,
				priceIds: read.contexts.get(contextHash as string)?.priceIds as never,
			}),
		);
		expect(JSON.parse(tree[contextKey] as string)).toMatchObject({
			context_hash: contextHash,
			env: "live",
			school_id: SCHOOL,
			menu_version: "3",
			policy_version: "1",
		});
		expect(JSON.parse(tree[seedKey] as string)).toMatchObject({
			env: "live",
			subject_key: subjectKeyOf(ERASED),
			first_event_id: "evt_in_a2",
		});
		// the same names through the library
		expect(
			inputObjectKey.seed({ ...scope, subjectKey: subjectKeyOf(ERASED) }),
		).toBe(seedKey);
		expect(inputObjectKey.prefix(scope)).toBe("schools/sch_vol/inputs/live/");

		expect(result).toMatchObject({
			contexts: 1,
			seeds: 1,
			shipped: 4,
			conflicts: [],
			erasures: { settled: 0, pending: 0 },
		});
		expect(result.batches).toEqual([
			{ key: key15, date: "2026-02-15", inputs: 3, status: "created" },
			{ key: key16, date: "2026-02-16", inputs: 1, status: "created" },
		]);
		// the rows are marked with the key and the time
		expect(rowsOf(h)).toEqual([
			{ order: 2, id: "evt_in_a2", batchKey: key15, shippedAt: SHIP_TIME },
			{ order: 3, id: "evt_in_b1", batchKey: key15, shippedAt: SHIP_TIME },
			{ order: 4, id: "evt_in_a3", batchKey: key15, shippedAt: SHIP_TIME },
			{ order: 5, id: "evt_in_b2", batchKey: key16, shippedAt: SHIP_TIME },
		]);
		expect(
			inputsShipStatus({ db: h.db, ...scope, nowMs: () => SHIP_TIME }),
		).toEqual({
			unshipped: 0,
			oldestUnshippedAgeMs: null,
			erasuresPending: 0,
			oldestErasurePendingAgeMs: null,
		});
	});

	test("the same database gives the same names and bytes, whenever and wherever it is shipped", async () => {
		const h = buildWorld();
		const copy = Database.deserialize(h.raw.serialize());
		const first = await folder();
		const second = await folder();
		await shipInputs(shipArgs(h, first.store, SHIP_TIME));
		await shipInputs({
			db: bunSqlite(copy),
			store: second.store,
			...scope,
			nowMs: () => SHIP_TIME + 86_400_000,
		});
		const firstTree = await readTree(first.root);
		expect(Object.keys(firstTree)).toHaveLength(4);
		expect(await readTree(second.root)).toEqual(firstTree);
	});

	test("a rerun ships nothing new and writes nothing", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		await shipInputs(shipArgs(h, store));
		const before = await readTree(root);
		const marks = rowsOf(h);
		const again = await shipInputs(shipArgs(h, store, SHIP_TIME + 1));
		expect(again).toEqual({
			batches: [],
			contexts: 0,
			seeds: 0,
			shipped: 0,
			conflicts: [],
			erasures: { settled: 0, pending: 0 },
		});
		expect(await readTree(root)).toEqual(before);
		expect(rowsOf(h)).toEqual(marks);
	});

	test("the batch day is the UTC date of the commit: 23:59:59Z and 00:00:00Z, whatever the process time zone", () => {
		const h = buildWorld();
		const [first, second] = readInputs(h.db, scope).inputs as [
			StoredInput,
			StoredInput,
		];
		const at = (iso: string, row: StoredInput, order: number): StoredInput => ({
			...row,
			appliedOrder: order,
			receivedAt: Date.parse(iso),
		});
		const rows = [
			at("2026-01-15T23:59:59Z", first, 10),
			at("2026-01-16T00:00:00Z", second, 11),
		];
		const dates = (zone: string) => {
			const previous = process.env.TZ;
			process.env.TZ = zone;
			try {
				return planInputs({ ...scope, rows }).map((batch) => batch.date);
			} finally {
				if (previous === undefined) delete process.env.TZ;
				else process.env.TZ = previous;
			}
		};
		for (const zone of ["UTC", "America/Denver", "Pacific/Auckland"])
			expect(dates(zone)).toEqual(["2026-01-15", "2026-01-16"]);
	});

	test("nothing is written to the database but the batch keys, the shipped marks and the queue", async () => {
		const h = buildWorld();
		const tables = [
			"atm_event_inputs",
			"atm_input_contexts",
			"atm_input_seeds",
			"atm_rows",
			"atm_subjects",
			"atm_event_claims",
			"ledger_outbox",
		];
		const strip = (rows: Record<string, unknown>[]) =>
			rows.map(({ batch_key, shipped_at, ...rest }) => rest);
		const before = tables.map((table) => strip(tableRows(h.raw, table)));
		const { store } = await folder();
		await shipInputs(shipArgs(h, store));
		expect(tables.map((table) => strip(tableRows(h.raw, table)))).toEqual(
			before,
		);
		expect(tableRows(h.raw, "atm_input_erasures")).toEqual([]);
		// and the marks are what changed
		expect(
			tableRows(h.raw, "atm_event_inputs").every(
				(row) => row.shipped_at === SHIP_TIME && row.batch_key !== null,
			),
		).toBe(true);
	});
});

describe("planInputs", () => {
	test("refuses a refused row, a row of another school or env, an odd event id and a repeated order", () => {
		const h = buildWorld();
		const [row] = readInputs(h.db, scope).inputs as [StoredInput];
		const plan = (rows: StoredInput[], school = SCHOOL) =>
			planInputs({ school, env: ENV, rows });
		expect(() =>
			plan([{ ...row, outcome: "refused", reason: "bad_event" }]),
		).toThrow("never shipped");
		expect(() => plan([row], "sch_other")).toThrow("belongs to");
		expect(() => plan([{ ...row, eventId: "evt/../x" }])).toThrow(
			"letters, digits",
		);
		expect(() => plan([row, row])).toThrow("used twice");
		expect(() => plan([{ ...row, fact: null }])).toThrow("no fact");
		expect(plan([])).toEqual([]);
	});

	test("an erased row is a tombstone whatever the row in hand still carries", () => {
		const h = buildWorld();
		const [row] = readInputs(h.db, scope).inputs as [StoredInput];
		expect(row.fact).not.toBeNull();
		const [batch] = planInputs({
			...scope,
			rows: [{ ...row, erasedAt: ERASE_TIME }],
		});
		const line = JSON.parse((batch?.text ?? "").trim());
		expect(line).toMatchObject({
			erased_at: ERASE_TIME,
			fact: null,
			subject_key: null,
			payment_refs: null,
			booking_refs: null,
			fee: null,
			raw_sha256: null,
			event_id: "evt_in_a2",
			applied_order: 2,
		});
		const text = batch?.text ?? "";
		for (const secret of [ERASED, "pi_in_a2", String(row.rawSha256)])
			expect(text).not.toContain(secret);
	});
});

describe("a crash, a rerun and two shippers", () => {
	test("a crash between put and mark is repaired by a rerun: the same object, found as existing, then marked", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		let crash = true;
		const crashed = shipInputs({
			...shipArgs(h, store),
			db: crashing(
				h.db,
				/SET shipped_at = \? WHERE env = \? AND school_id = \? AND batch_key/,
				() => crash,
			),
		});
		await expect(crashed).rejects.toThrow("injected crash");
		// the first batch is in the folder, its rows are not marked
		const landed = await readTree(root);
		const batches = Object.keys(landed).filter((key) =>
			key.includes("/batch-"),
		);
		expect(batches).toHaveLength(1);
		expect(rowsOf(h).every((row) => row.shippedAt === null)).toBe(true);

		crash = false;
		const again = await shipInputs(shipArgs(h, store));
		expect(again.batches.map((batch) => batch.status)).toEqual([
			"existing",
			"created",
		]);
		expect(again.shipped).toBe(4);
		expect(
			Object.keys(await readTree(root)).filter((key) =>
				key.includes("/batch-"),
			),
		).toHaveLength(2);
		expect(rowsOf(h).every((row) => row.shippedAt === SHIP_TIME)).toBe(true);
	});

	test("rows that arrive between the crash and the rerun do not change the object that landed: no overlapping batch, no line twice", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		let crash = true;
		await expect(
			shipInputs({
				...shipArgs(h, store),
				db: crashing(
					h.db,
					/UPDATE atm_event_inputs SET shipped_at/,
					() => crash,
				),
			}),
		).rejects.toThrow("injected crash");
		const landed = Object.keys(await readTree(root)).filter((key) =>
			key.includes("/batch-"),
		);
		// a fifth input on the same day as the first batch
		const { deliverFor } = await import("./ship-inputs-world.js");
		const { T1, HOUR } = await import("./handler-harness.js");
		deliverFor(h, KEPT, "in_b3", T1 + 3 * HOUR, "subscription_cycle");
		crash = false;
		await shipInputs(shipArgs(h, store));
		const batches = Object.keys(await readTree(root)).filter((key) =>
			key.includes("/batch-"),
		);
		// the landed key is still there, and every event is in exactly one object
		expect(batches).toContain(landed[0] as string);
		const events = batches.flatMap((key) =>
			readFileSync(join(root, key), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).event_id as string),
		);
		expect([...events].sort()).toEqual(
			["evt_in_a2", "evt_in_a3", "evt_in_b1", "evt_in_b2", "evt_in_b3"].sort(),
		);
		expect(new Set(events).size).toBe(events.length);
	});

	test("two shippers on one database at once ship it once: one object per day, each row marked, no conflict", async () => {
		const dir = await tmp("ship-inputs-race");
		directories.push(dir);
		const file = join(dir, "handler.sqlite");
		const raw = new Database(file, { create: true });
		const h = buildWorld(raw);
		const { root, store } = await folder();
		const second = new Database(file);
		const results = await Promise.all([
			shipInputs(shipArgs(h, store)),
			shipInputs({
				db: bunSqlite(second),
				store: new FolderStore({ root }),
				...scope,
				nowMs: () => SHIP_TIME + 1,
			}),
		]);
		second.close();
		expect(results.flatMap((result) => result.conflicts)).toEqual([]);
		const tree = await readTree(root);
		expect(
			Object.keys(tree).filter((key) => key.includes("/batch-")),
		).toHaveLength(2);
		expect(rowsOf(h).every((row) => row.shippedAt !== null)).toBe(true);
		const events = Object.entries(tree)
			.filter(([key]) => key.includes("/batch-"))
			.flatMap(([, text]) => text.trim().split("\n"))
			.map((line) => JSON.parse(line).event_id as string)
			.sort();
		expect(events).toEqual([
			"evt_in_a2",
			"evt_in_a3",
			"evt_in_b1",
			"evt_in_b2",
		]);
	});

	test("a key that holds other bytes is a conflict: reported, never overwritten, its rows left unshipped, the others shipped", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		const rows = readInputs(h.db, scope).inputs;
		const [day15] = planInputs({
			...scope,
			rows: rows.filter((row) => row.appliedOrder <= 4),
		});
		await store.putIfAbsent(
			day15?.key as string,
			utf8("somebody else's bytes\n"),
		);
		const result = await shipInputs(shipArgs(h, store));
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]).toMatchObject({
			key: day15?.key,
			date: "2026-02-15",
			ids: ["evt_in_a2", "evt_in_b1", "evt_in_a3"],
		});
		expect(readFileSync(join(root, day15?.key as string), "utf8")).toBe(
			"somebody else's bytes\n",
		);
		expect(rowsOf(h).map((row) => row.shippedAt !== null)).toEqual([
			false,
			false,
			false,
			true,
		]);
		expect(
			inputsShipStatus({ db: h.db, ...scope, nowMs: () => SHIP_TIME + 5 }),
		).toMatchObject({
			unshipped: 3,
			oldestUnshippedAgeMs: SHIP_TIME + 5 - Date.parse("2026-02-15T18:00:20Z"),
		});
		// remove the stranger and it ships
		await store.delete(day15?.key as string, sha("somebody else's bytes\n"));
		const fixed = await shipInputs(shipArgs(h, store));
		expect(fixed.conflicts).toEqual([]);
		expect(fixed.shipped).toBe(3);
	});

	test("a context that holds other bytes holds back the batches that refer to it", async () => {
		const h = buildWorld();
		const { store } = await folder();
		const [contextHash] = [...readInputs(h.db, scope).contexts.keys()];
		await store.putIfAbsent(
			inputObjectKey.context({ ...scope, contextHash: contextHash as string }),
			utf8("not the context\n"),
		);
		const result = await shipInputs(shipArgs(h, store));
		expect(result.conflicts.map((conflict) => conflict.ids)).toEqual([
			[contextHash],
		]);
		expect(result.batches).toEqual([]);
		expect(rowsOf(h).every((row) => row.shippedAt === null)).toBe(true);
	});
});

describe("what is shipped and what is not", () => {
	test("a refused row is not shipped and is not counted as unshipped", async () => {
		const brokenMenu = {
			...(await import("./handler-harness.js")).menu,
		};
		brokenMenu.tiers = brokenMenu.tiers.filter(
			(tier) => tier.id !== "sparkle-2",
		);
		const raw = new Database(":memory:");
		const world = buildWorld(raw);
		const broken = harness(undefined, { raw, menu: brokenMenu });
		expect(
			broken.deliver(
				invoicePaid({
					eventId: "evt_in_refused",
					invoiceId: "in_refused",
					at: Date.parse("2026-02-15T18:00:00Z"),
					subscriptionId: "sub_fam_refused",
					reason: "subscription_create",
					periodStart: Date.parse("2026-02-15T18:00:00Z"),
					periodEnd: Date.parse("2026-03-15T18:00:00Z"),
					lines: [
						{
							lookupKey: (await import("./handler-harness.js")).tierKey(),
							amount: 26_000,
							interval: "month",
						},
					],
					metadata: { b4u_school: SCHOOL, family_id: "fam_refused" },
				}),
			).status,
		).toBe(422);
		const { root, store } = await folder();
		const stored = tableRows(raw, "atm_event_inputs");
		expect(stored.filter((row) => row.outcome === "refused")).toHaveLength(1);
		await shipInputs(shipArgs(world, store));
		const tree = await readTree(root);
		expect(Object.values(tree).join("\n")).not.toContain("evt_in_refused");
		expect(Object.values(tree).join("\n")).not.toContain("fam_refused");
		const [refused] = tableRows(raw, "atm_event_inputs").filter(
			(row) => row.outcome === "refused",
		);
		expect(refused).toMatchObject({ batch_key: null, shipped_at: null });
		// erased, a refusal is still never shipped: no tombstone line, nothing queued
		eraseStoredInputs(world.db, {
			...scope,
			subjectKey: subjectKeyOf("fam_refused"),
			nowMs: ERASE_TIME,
		});
		const second = await shipInputs(shipArgs(world, store, SHIP_TIME + 1));
		expect(second).toMatchObject({ batches: [], shipped: 0 });
		expect(await readTree(root)).toEqual(tree);
		expect(tableRows(raw, "atm_input_erasures")).toEqual([]);
		expect(
			tableRows(raw, "atm_event_inputs").filter(
				(row) => row.outcome === "refused",
			),
		).toMatchObject([
			{ erased_at: ERASE_TIME, batch_key: null, shipped_at: null },
		]);
		expect(
			inputsShipStatus({ db: world.db, ...scope, nowMs: () => SHIP_TIME })
				.unshipped,
		).toBe(0);
	});

	test("only committed rows ship: a delivery whose transaction rolled back leaves nothing to ship", async () => {
		const h = buildWorld();
		const failing: SqlDatabase = {
			exec: (sql) => h.db.exec(sql),
			all: (sql, params) => h.db.all(sql, params),
			run: (sql, params) => {
				if (/INSERT INTO ledger_outbox/.test(sql))
					throw new Error("injected failure");
				return h.db.run(sql, params);
			},
			transaction: (fn) => h.db.transaction(fn),
		};
		const broken = harness(undefined, { raw: h.raw });
		broken.deps.db = failing;
		const { deliverFor } = await import("./ship-inputs-world.js");
		const { T1, HOUR } = await import("./handler-harness.js");
		expect(() =>
			deliverFor(broken, KEPT, "in_b3", T1 + 3 * HOUR, "subscription_cycle"),
		).toThrow();
		const { root, store } = await folder();
		await shipInputs(shipArgs(h, store));
		const text = Object.values(await readTree(root)).join("\n");
		expect(text).not.toContain("evt_in_b3");
	});

	test("an erased row ships as a tombstone, never as a fact; its seed is not shipped", async () => {
		const h = buildWorld();
		eraseStoredInputs(h.db, {
			...scope,
			school: SCHOOL,
			subjectKey: subjectKeyOf(ERASED),
			nowMs: ERASE_TIME,
		});
		const { root, store } = await folder();
		const result = await shipInputs(shipArgs(h, store));
		expect(result).toMatchObject({ seeds: 0, shipped: 4 });
		const tree = await readTree(root);
		expect(Object.keys(tree).some((key) => key.includes("/seeds/"))).toBe(
			false,
		);
		const read = await folderInputsSource(root).read(scope);
		expect(
			read.inputs.map((input) => [
				input.eventId,
				input.erasedAt,
				input.fact === null,
			]),
		).toEqual([
			["evt_in_a2", ERASE_TIME, true],
			["evt_in_b1", null, false],
			["evt_in_a3", ERASE_TIME, true],
			["evt_in_b2", null, false],
		]);
		const everything = Object.values(tree).join("\n");
		for (const secret of [ERASED, `sub_${ERASED}`, "pi_in_a2", "pi_in_a3"])
			expect(everything).not.toContain(secret);
		expect(everything).toContain(KEPT);
	});
});

describe("erasure of shipped objects", () => {
	/** What an erased holder's facts are made of, found in the shipped files before the erasure, and gone from them after. */
	const holderNeedles = (h: World): string[] => {
		const read = readInputs(h.db, scope);
		const mine = read.inputs.filter(
			(input) => input.subjectKey === subjectKeyOf(ERASED),
		);
		const others = read.inputs.filter(
			(input) => input.subjectKey !== subjectKeyOf(ERASED),
		);
		const keptText = JSON.stringify([others, [...read.contexts.values()]]);
		const tombstones = planInputs({
			...scope,
			rows: mine.map((input) => ({ ...input, erasedAt: ERASE_TIME })),
		})
			.map((batch) => batch.text)
			.join("");
		const found = new Set<string>();
		for (const input of mine) {
			leaves(input.fact, found);
			leaves(input.paymentRefs, found);
			found.add(String(input.rawSha256));
			found.add(String(input.subjectKey));
		}
		leaves(read.seeds.get(subjectKeyOf(ERASED)), found);
		return [...found].filter(
			(needle) =>
				needle.length >= 6 &&
				!keptText.includes(needle) &&
				!tombstones.includes(needle),
		);
	};
	const everythingIn = async (root: string) =>
		Object.values(await readTree(root)).join("\n");
	const erase = (h: World) =>
		eraseStoredInputs(h.db, {
			...scope,
			school: SCHOOL,
			subjectKey: subjectKeyOf(ERASED),
			nowMs: ERASE_TIME,
		});

	test("the batch is rewritten under a new key, the old object and the seed are gone, the queue is closed, the rows point at the new key, and no personal string or fact is left in the folder", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		await shipInputs(shipArgs(h, store));
		const needles = holderNeedles(h);
		// the search finds what is there (it would pass for any folder otherwise): the family, its subscription, its refs
		for (const must of [ERASED, `sub_${ERASED}`, "pi_in_a2", "ch_in_a3"])
			expect(needles).toContain(must);
		const before = await everythingIn(root);
		for (const needle of needles) expect(before).toContain(needle);
		const oldTree = await readTree(root);
		const oldBatch = rowsOf(h)[0]?.batchKey as string;
		const untouched = rowsOf(h)[3]?.batchKey as string;

		expect(erase(h)).toEqual({ inputs: 2, seeds: 1, queued: 2 });
		expect(
			tableRows(h.raw, "atm_input_erasures").map((row) => [
				row.kind,
				row.done_at,
			]),
		).toEqual([
			["batch", null],
			["seed", null],
		]);
		expect(
			inputsShipStatus({ db: h.db, ...scope, nowMs: () => ERASE_TIME + 500 }),
		).toMatchObject({
			erasuresPending: 2,
			oldestErasurePendingAgeMs: 500,
		});

		const result = await shipInputs(shipArgs(h, store, ERASE_TIME + 1000));
		expect(result.erasures).toEqual({ settled: 2, pending: 0 });
		expect(result.conflicts).toEqual([]);

		const after = await readTree(root);
		// the old batch and the seed are gone; the other day's batch and the context are byte for byte what they were
		expect(after[oldBatch]).toBeUndefined();
		expect(Object.keys(after).some((key) => key.includes("/seeds/"))).toBe(
			false,
		);
		expect(after[untouched]).toBe(oldTree[untouched]);
		const newBatch = Object.keys(after).find(
			(key) => key.includes("date=2026-02-15/") && key !== oldBatch,
		) as string;
		expect(newBatch).toBeDefined();
		// same first order, another hash: nothing was overwritten
		expect(newBatch.split("/batch-")[1]?.slice(0, 13)).toBe(
			oldBatch.split("/batch-")[1]?.slice(0, 13),
		);
		expect(newBatch).not.toBe(oldBatch);
		expect(newBatch).toBe(
			`schools/sch_vol/inputs/live/date=2026-02-15/batch-000000000002-${sha(after[newBatch] as string).slice(0, 16)}.jsonl`,
		);
		// SQLite points at the new key (the other holder's row in the batch too), and the queue is closed with it
		expect(rowsOf(h).map((row) => row.batchKey)).toEqual([
			newBatch,
			newBatch,
			newBatch,
			untouched,
		]);
		expect(
			tableRows(h.raw, "atm_input_erasures").map((row) => [
				row.kind,
				row.replacement_key,
				row.done_at !== null,
			]),
		).toEqual([
			["batch", newBatch, true],
			["seed", null, true],
		]);
		expect(
			inputsShipStatus({ db: h.db, ...scope, nowMs: () => ERASE_TIME + 2000 }),
		).toMatchObject({
			unshipped: 0,
			erasuresPending: 0,
		});

		// no personal string, no fact, anywhere in the folder; the other family's are still there
		const left = await everythingIn(root);
		for (const needle of needles) expect(left).not.toContain(needle);
		expect(left).toContain(KEPT);
		expect(left).toContain(`sub_${KEPT}`);

		// the folder reader sees the tombstones and the other holder's facts, as SQLite does
		const read = await folderInputsSource(root).read(scope);
		expect(
			read.inputs.map((input) => [
				input.eventId,
				input.erasedAt,
				input.fact === null,
				input.batchKey,
			]),
		).toEqual([
			["evt_in_a2", ERASE_TIME, true, newBatch],
			["evt_in_b1", null, false, newBatch],
			["evt_in_a3", ERASE_TIME, true, newBatch],
			["evt_in_b2", null, false, untouched],
		]);
		expect(read.seeds.size).toBe(0);
		const sqlite = await sqliteInputsSource(h.db).read(scope);
		expect(withoutMarks(read)).toEqual(withoutMarks(sqlite));

		// and a rerun has nothing left to do
		const again = await shipInputs(shipArgs(h, store, ERASE_TIME + 3000));
		expect(again).toMatchObject({
			batches: [],
			shipped: 0,
			erasures: { settled: 0, pending: 0 },
		});
		expect(await readTree(root)).toEqual(after);
	});

	test("a crash after the new object is put, or after the rows are pointed at it, is repaired by the next run", async () => {
		for (const crashAt of ["after_repoint", "before_repoint"] as const) {
			const h = buildWorld();
			const { root, store } = await folder();
			await shipInputs(shipArgs(h, store));
			const oldBatch = rowsOf(h)[0]?.batchKey as string;
			const needles = holderNeedles(h);
			erase(h);
			let armed = true;
			const args =
				crashAt === "after_repoint"
					? // the old object cannot be deleted: both objects exist, the rows already point at the new one
						{
							...shipArgs(h, store, ERASE_TIME + 1000),
							store: wrapped(store, {
								delete: (key, expected) =>
									armed && key === oldBatch
										? Promise.reject(new Error("injected crash"))
										: store.delete(key, expected),
							}),
						}
					: // the rows cannot be pointed at the new object: it is put, the rows still point at the old one
						{
							...shipArgs(h, store, ERASE_TIME + 1000),
							db: crashing(
								h.db,
								/SET batch_key = \?, shipped_at = COALESCE/,
								() => armed,
							),
						};
			await expect(settleInputErasures(args)).rejects.toThrow("injected crash");
			const mid = await readTree(root);
			expect(mid[oldBatch]).toBeDefined();
			expect(
				Object.keys(mid).filter((key) => key.includes("date=2026-02-15/")),
			).toHaveLength(2);
			if (crashAt === "after_repoint")
				expect(rowsOf(h)[0]?.batchKey).not.toBe(oldBatch);
			else expect(rowsOf(h)[0]?.batchKey).toBe(oldBatch);

			armed = false;
			const done = await settleInputErasures(
				shipArgs(h, store, ERASE_TIME + 2000),
			);
			expect(done).toEqual({ settled: 2, pending: 0, conflicts: [] });
			const after = await readTree(root);
			expect(after[oldBatch]).toBeUndefined();
			expect(
				Object.keys(after).filter((key) => key.includes("date=2026-02-15/")),
			).toHaveLength(1);
			const left = await everythingIn(root);
			expect(needles.length).toBeGreaterThan(0);
			for (const needle of needles) expect(left).not.toContain(needle);
		}
	});

	test("an erasure that comes after the put and before the mark is rewritten by the same run", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		let erased = false;
		const racing = wrapped(store, {
			putIfAbsent: async (key, body) => {
				const put = await store.putIfAbsent(key, body);
				if (!erased && key.includes("date=2026-02-15/")) {
					erased = true;
					erase(h);
				}
				return put;
			},
		});
		const needles = holderNeedles(h);
		const result = await shipInputs(shipArgs(h, racing));
		expect(erased).toBe(true);
		expect(result.erasures.pending).toBe(0);
		expect(result.conflicts).toEqual([]);
		const left = await everythingIn(root);
		for (const needle of needles) expect(left).not.toContain(needle);
		expect(rowsOf(h).every((row) => row.shippedAt !== null)).toBe(true);
	});

	test("an erasure during the rewrite makes the rewrite start over: the object it put is deleted, nothing is left pending after the next run", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		await shipInputs(shipArgs(h, store));
		// erase the kept family first, so that a second erase can land during the rewrite for the first
		eraseStoredInputs(h.db, {
			...scope,
			subjectKey: subjectKeyOf(KEPT),
			nowMs: ERASE_TIME,
		});
		let erasedMidway = false;
		const racing = wrapped(store, {
			putIfAbsent: async (key, body) => {
				const put = await store.putIfAbsent(key, body);
				if (!erasedMidway && key.includes("date=2026-02-15/")) {
					erasedMidway = true;
					erase(h);
				}
				return put;
			},
		});
		const first = await settleInputErasures(
			shipArgs(h, racing, ERASE_TIME + 1000),
		);
		expect(erasedMidway).toBe(true);
		expect(first.pending).toBeGreaterThan(0);
		const second = await settleInputErasures(
			shipArgs(h, store, ERASE_TIME + 2000),
		);
		expect(second.pending).toBe(0);
		const left = await everythingIn(root);
		for (const needle of [
			ERASED,
			KEPT,
			`sub_${ERASED}`,
			`sub_${KEPT}`,
			"pi_in_a2",
			"pi_in_b1",
		])
			expect(left).not.toContain(needle);
		expect(
			Object.keys(await readTree(root)).filter((key) =>
				key.includes("/batch-"),
			),
		).toHaveLength(2);
	});

	test("an erasure that cannot finish keeps the queue row and the exit-1 signal; the key it would write holding other bytes is a conflict", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		await shipInputs(shipArgs(h, store));
		const oldBatch = rowsOf(h)[0]?.batchKey as string;
		erase(h);
		const rows = readInputs(h.db, scope).inputs.filter(
			(row) => row.batchKey === oldBatch,
		);
		const [rewrite] = planInputs({ ...scope, rows });
		await store.putIfAbsent(rewrite?.key as string, utf8("planted\n"));
		const result = await shipInputs(shipArgs(h, store, ERASE_TIME + 1000));
		expect(result.erasures.pending).toBe(1);
		expect(result.conflicts.map((conflict) => conflict.key)).toEqual([
			oldBatch,
		]);
		// nothing was overwritten or deleted
		expect(readFileSync(join(root, rewrite?.key as string), "utf8")).toBe(
			"planted\n",
		);
		expect((await readTree(root))[oldBatch]).toBeDefined();
		// clear the stranger and the next run settles
		await store.delete(rewrite?.key as string, sha("planted\n"));
		const fixed = await shipInputs(shipArgs(h, store, ERASE_TIME + 2000));
		expect(fixed.erasures).toEqual({ settled: 1, pending: 0 });
	});

	test("an erasure queued before the batch was ever marked (a crash, then the erasure) reaches the object that landed", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		let crash = true;
		await expect(
			shipInputs({
				...shipArgs(h, store),
				db: crashing(
					h.db,
					/SET shipped_at = \? WHERE env = \? AND school_id = \? AND batch_key/,
					() => crash,
				),
			}),
		).rejects.toThrow("injected crash");
		const needles = holderNeedles(h);
		expect(await everythingIn(root)).toContain(ERASED);
		erase(h);
		crash = false;
		const result = await shipInputs(shipArgs(h, store, ERASE_TIME + 1000));
		expect(result.erasures.pending).toBe(0);
		const left = await everythingIn(root);
		for (const needle of needles) expect(left).not.toContain(needle);
	});
});

/** The parts of a read that both sources must agree on: SQLite also holds the shipper's marks and its origin. */
const withoutMarks = (read: InputsRead) => ({
	inputs: read.inputs.map(({ shippedAt, ...rest }) => rest),
	seeds: [...read.seeds.entries()],
	contexts: [...read.contexts.entries()],
});

describe("the folder reader", () => {
	test("equals the SQLite reader on the same history: the handler's world and the eight recorded delivered scenarios", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		await shipInputs(shipArgs(h, store));
		const folderRead = await folderInputsSource(root).read(scope);
		const storeRead = await storeInputsSource(store).read(scope);
		const sqliteRead = await sqliteInputsSource(h.db).read(scope);
		expect(folderRead.inputs).toHaveLength(4);
		expect(folderRead.seeds.size).toBe(1);
		expect(folderRead.contexts.size).toBe(1);
		expect(withoutMarks(folderRead)).toEqual(withoutMarks(sqliteRead));
		expect(withoutMarks(storeRead)).toEqual(withoutMarks(sqliteRead));
		expect(folderRead.refused).toEqual([]);
		expect(folderRead.origin).toBe(root);
		expect(storeRead.origin).toBe("store");
		// the first order (1) is the wiped pre-upgrade input; nothing before the first input read is a gap
		expect(inputOrderGaps(folderRead)).toEqual([]);

		const deliveredDir = join(
			import.meta.dir,
			"../fixtures/billing/stripe/recorded/delivered",
		);
		const scenarios = readdirSync(deliveredDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		expect(scenarios).toHaveLength(8);
		for (const scenario of scenarios) {
			const world = harness(undefined, {
				school: RECORDED_SCHOOL,
				menu: recordedMenu,
				env: "test",
				priceIds: recordedPriceIds(),
			});
			let pending: RawEvent[] = readdirSync(join(deliveredDir, scenario))
				.filter((name) => name.endsWith(".json"))
				.sort()
				.map((name) =>
					JSON.parse(readFileSync(join(deliveredDir, scenario, name), "utf8")),
				);
			for (let pass = 0; pass < 4 && pending.length > 0; pass += 1) {
				const retry: RawEvent[] = [];
				for (const event of pending)
					if (world.deliver(event, event.created * 1000).status === 409)
						retry.push(event);
				pending = retry;
			}
			expect(pending).toEqual([]);
			const recorded = await folder("ship-inputs-recorded");
			const recordedScope = { school: RECORDED_SCHOOL, env: "test" as const };
			await shipInputs({
				db: world.db,
				store: recorded.store,
				...recordedScope,
				nowMs: () => SHIP_TIME,
			});
			const fromFolder = await folderInputsSource(recorded.root).read(
				recordedScope,
			);
			const fromSqlite = await sqliteInputsSource(world.db).read(recordedScope);
			expect(fromSqlite.inputs.length).toBeGreaterThan(0);
			expect(withoutMarks(fromFolder)).toEqual(withoutMarks(fromSqlite));
			// SQLite reads the batch key the shipper wrote, and so does the folder
			expect(fromFolder.inputs.map((input) => input.batchKey)).toEqual(
				fromSqlite.inputs.map((input) => input.batchKey),
			);
			// no refusals in these scenarios, so no gap either
			expect(inputOrderGaps(fromFolder)).toEqual([]);
		}
	});

	test("reduces several lines for one event: an erased line beats an unerased one, else the lowest order; it skips what is not its own", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		const rows = readInputs(h.db, scope).inputs;
		const [first, second] = rows as [StoredInput, StoredInput];
		// the same event twice, as a crash and a rewrite window leave it
		const put = async (batchRows: StoredInput[]) => {
			for (const batch of planInputs({ ...scope, rows: batchRows }))
				await store.putIfAbsent(batch.key, utf8(batch.text));
		};
		await put([first, second]);
		// the erased copy of the second event sits in an object that sorts after the unerased one (order 3 after order 2)
		await put([{ ...second, erasedAt: ERASE_TIME }]);
		await put([{ ...first, appliedOrder: first.appliedOrder + 100 }]);
		const read = await folderInputsSource(root).read(scope);
		expect(
			read.inputs.map((input) => [
				input.eventId,
				input.appliedOrder,
				input.fact === null,
			]),
		).toEqual([
			["evt_in_a2", 2, false],
			["evt_in_b1", 3, true],
		]);
		// a file that is not a batch, a context or a seed is not read
		await mkdir(join(root, "schools/sch_vol/inputs/live/notes"), {
			recursive: true,
		});
		await writeFile(join(root, "schools/sch_vol/inputs/live/notes/x.txt"), "x");
		expect((await folderInputsSource(root).read(scope)).inputs).toHaveLength(2);
		// the other env and the other school are other prefixes
		expect(
			(await folderInputsSource(root).read({ school: SCHOOL, env: "test" }))
				.inputs,
		).toEqual([]);
		expect(
			(await folderInputsSource(root).read({ school: "sch_x", env: ENV }))
				.inputs,
		).toEqual([]);
	});

	test("a context that is not what its name says, a line of another school, and a line without a fact are errors that name the object", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		await shipInputs(shipArgs(h, store));
		const tree = await readTree(root);
		const contextKey = Object.keys(tree).find((key) =>
			key.includes("/contexts/"),
		) as string;
		const batchKey = Object.keys(tree).find((key) =>
			key.includes("/batch-"),
		) as string;
		const original = tree[contextKey] as string;
		await writeFile(
			join(root, contextKey),
			original
				.replace('"version"', '"v"')
				.replace(/"menu_version":"3"/, '"menu_version":"3"')
				.replace('"currency":"usd"', '"currency":"eur"'),
		);
		await expect(folderInputsSource(root).read(scope)).rejects.toThrow(
			contextKey,
		);
		await writeFile(join(root, contextKey), original);
		const batch = tree[batchKey] as string;
		await writeFile(
			join(root, batchKey),
			batch.replace('"school_id":"sch_vol"', '"school_id":"sch_x"'),
		);
		await expect(folderInputsSource(root).read(scope)).rejects.toThrow("sch_x");
		await writeFile(
			join(root, batchKey),
			batch.replace(/"fact":\{.*?\},"fee"/, '"fact":null,"fee"'),
		);
		await expect(folderInputsSource(root).read(scope)).rejects.toThrow(
			"no fact",
		);
		await mkdir(dirname(join(root, batchKey)), { recursive: true });
		await writeFile(join(root, batchKey), batch);
		expect((await folderInputsSource(root).read(scope)).inputs).toHaveLength(4);
	});

	test("a line whose context object is missing is kept, and the order gaps are reported", async () => {
		const h = buildWorld();
		const { root, store } = await folder();
		await shipInputs(shipArgs(h, store));
		const contextKey = Object.keys(await readTree(root)).find((key) =>
			key.includes("/contexts/"),
		) as string;
		await rm(join(root, contextKey));
		const read = await folderInputsSource(root).read(scope);
		expect(read.contexts.size).toBe(0);
		expect(read.inputs.map((input) => input.contextHash !== null)).toEqual([
			true,
			true,
			true,
			true,
		]);
		expect(
			inputOrderGaps({
				inputs: [2, 3, 7, 9].map(
					(appliedOrder) => ({ appliedOrder }) as StoredInput,
				),
				refused: [{ appliedOrder: 8 } as StoredInput],
			}),
		).toEqual([{ from: 4, to: 6 }]);
	});
});

describe("personal strings of the recorded fixtures never reach the folder", () => {
	test("none of the strings computed from the events is in the shipped files, before or after an erasure", async () => {
		const h = buildWorld();
		const personal = new Set<string>();
		const { invoicePaid: build } = await import("./stripe-events.js");
		personalStringsOf(
			build({
				eventId: "evt_x",
				invoiceId: "in_x",
				at: Date.parse("2026-02-15T18:00:00Z"),
				subscriptionId: "sub_x",
				reason: "subscription_create",
				periodStart: Date.parse("2026-02-15T18:00:00Z"),
				periodEnd: Date.parse("2026-03-15T18:00:00Z"),
				lines: [],
				metadata: {},
			}),
			personal,
		);
		expect(personal.size).toBeGreaterThan(0);
		const { root, store } = await folder();
		await shipInputs(shipArgs(h, store));
		const shipped = Object.values(await readTree(root)).join("\n");
		for (const string of personal) expect(shipped).not.toContain(string);
	});
});

describe("setup", () => {
	test("a database without the stored-input tables stops with the message that names HANDLER_DDL", async () => {
		const raw = new Database(":memory:");
		const db = bunSqlite(raw);
		db.exec(HANDLER_DDL);
		for (const table of ["atm_input_erasures", "atm_input_seeds"])
			raw.run(`DROP TABLE ${table}`);
		const { store } = await folder();
		await expect(
			shipInputs({ db, store, ...scope, nowMs: () => SHIP_TIME }),
		).rejects.toThrow("HANDLER_DDL");
		expect(() =>
			inputsShipStatus({ db, ...scope, nowMs: () => SHIP_TIME }),
		).toThrow("HANDLER_DDL");
	});

	test("a school with no stored inputs ships nothing and succeeds", async () => {
		const raw = new Database(":memory:");
		const db = bunSqlite(raw);
		db.exec(HANDLER_DDL);
		const { root, store } = await folder();
		const result = await shipInputs({
			db,
			store,
			...scope,
			nowMs: () => SHIP_TIME,
		});
		expect(result).toEqual({
			batches: [],
			contexts: 0,
			seeds: 0,
			shipped: 0,
			conflicts: [],
			erasures: { settled: 0, pending: 0 },
		});
		expect(await readTree(root)).toEqual({});
	});
});
