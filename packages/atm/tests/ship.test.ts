import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	lookupKeyOf,
	menuLineItems,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { signStripePayload } from "../src/handler/stripe-signature.js";
import { handleStripeWebhook } from "../src/handler/stripe-webhook.js";
import type { SqlDatabase, WebhookDeps } from "../src/handler/types.js";
import {
	journalMonth,
	listEventFiles,
	readEvents,
} from "../src/ledger/files.js";
import { buildJournal } from "../src/ledger/journal.js";
import { planOutbox, shipOutbox } from "../src/ledger/ship.js";
import { FolderStore } from "../src/store/folder-store.js";
import { sha256Hex, utf8 } from "../src/store/store.js";
import type { AtmEvent, OutboxRow } from "../src/types.js";
import { hasHledger, tmp } from "./helpers.js";
import { invoicePaid, priceIdOf, type RawEvent } from "./stripe-events.js";

const SCHOOL = "sch_vol";
const OTHER_SCHOOL = "sch_other";
const FAMILY = "fam_8k2";
const SECRET = "whsec_unit_test_secret";
const T0 = Date.parse("2026-01-15T18:00:00Z");
const T1 = Date.parse("2026-02-15T18:00:00Z");
const T2 = Date.parse("2026-03-15T18:00:00Z");
const SHIPPED_AT = 1_700_000_000_000;
const menu = JSON.parse(
	await readFile(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;

type OutboxRecord = {
	school_id: string;
	id: string;
	idem: string;
	date: string;
	body: string;
	batch_key: string | null;
	shipped_at: number | null;
};

const newDatabase = () => {
	const raw = new Database(":memory:");
	const db = bunSqlite(raw);
	db.exec(HANDLER_DDL);
	return { raw, db };
};

const outboxOf = (db: SqlDatabase) =>
	db.all<OutboxRecord>(`SELECT * FROM ledger_outbox ORDER BY id`);

/** The body of a row the handler could have inserted, for tests that need no valid event: it names its own id, idem and date. */
const bodyOf = (id: string, date: string, extra = "") =>
	`{"id":"${id}","idem":"idem-${id}","date":"${date}"${extra}}`;

/** A row the handler could have inserted, for tests that need no valid event. */
const insertRow = (
	db: SqlDatabase,
	row: {
		id: string;
		date: string;
		body?: string;
		idem?: string;
		school?: string;
	},
) =>
	db.run(
		`INSERT INTO ledger_outbox (school_id, id, idem, date, body, batch_key, shipped_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
		[
			row.school ?? SCHOOL,
			row.id,
			row.idem ?? `idem-${row.id}`,
			row.date,
			row.body ?? bodyOf(row.id, row.date),
		],
	);

const tierKey = (tierId: string) => {
	const price = menu.tiers
		.find((tier) => tier.id === tierId)
		?.prices.find((candidate) => candidate.interval === "month");
	return lookupKeyOf(
		SCHOOL,
		tierPriceKey(tierId, "month"),
		price?.amount as number,
		menu.currency,
	);
};

const monthlyInvoice = (
	eventId: string,
	invoiceId: string,
	at: number,
	reason: "subscription_create" | "subscription_cycle",
	periodStart: number,
	periodEnd: number,
): RawEvent =>
	invoicePaid({
		eventId,
		invoiceId,
		at: at + 10_000,
		subscriptionId: "sub_1",
		reason,
		periodStart,
		periodEnd,
		lines: [
			{ lookupKey: tierKey("sparkle-2"), amount: 26000, interval: "month" },
		],
		metadata: { b4u_school: SCHOOL, family_id: FAMILY },
	});

/** The real webhook handler, delivered a create in January, a renewal in February and one in March. */
const filledByHandler = () => {
	const { raw, db } = newDatabase();
	const clock = { now: T0 + 20_000 };
	const deps: WebhookDeps = {
		db,
		secret: SECRET,
		schoolId: SCHOOL,
		nowMs: () => clock.now,
		workerId: "worker-a",
		// a delivery with no paymentFee warns (fee_unknown) once per payment; tests/handler-fee-unknown.test.ts reads those lines
		warn: () => undefined,
		context: () => ({
			menu,
			menuVersion: 3,
			policy: DEFAULT_POLICY,
			policyVersion: 1,
			catalog: menuCatalogRows({ menu, school: SCHOOL }),
			priceIds: Object.fromEntries(
				[...menuLineItems(SCHOOL, menu).keys()].map((key) => [
					key,
					priceIdOf(key),
				]),
			),
		}),
	};
	const deliveries: [RawEvent, number][] = [
		[monthlyInvoice("evt_c1", "in_1", T0, "subscription_create", T0, T1), T0],
		[monthlyInvoice("evt_c2", "in_2", T1, "subscription_cycle", T1, T2), T1],
		[
			monthlyInvoice(
				"evt_c3",
				"in_3",
				T2,
				"subscription_cycle",
				T2,
				T2 + (T2 - T1),
			),
			T2,
		],
	];
	for (const [event, at] of deliveries) {
		clock.now = at + 20_000;
		const payload = JSON.stringify(event);
		const response = handleStripeWebhook(deps, {
			payload,
			signatureHeader: signStripePayload({
				payload,
				secret: SECRET,
				timestampSeconds: Math.floor(clock.now / 1000),
			}),
		});
		expect(response.body.outcome).toBe("applied");
	}
	return { raw, db };
};

const setup = async () => {
	const root = await tmp("ship");
	return {
		root,
		store: new FolderStore({ root }),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
};

const ship = (db: SqlDatabase, store: FolderStore, school = SCHOOL) =>
	shipOutbox({ db, store, school, nowMs: () => SHIPPED_AT });

const rowsOf = (...rows: OutboxRow[]) => rows;
const row = (id: string, date: string, body = bodyOf(id, date)): OutboxRow => ({
	id,
	idem: `idem-${id}`,
	date,
	body,
});

describe("planOutbox", () => {
	test("groups by date, orders by id, and keeps the bodies byte for byte", () => {
		const batches = planOutbox({
			school: SCHOOL,
			rows: rowsOf(
				row("03", "2026-02-02", bodyOf("03", "2026-02-02", ',"note":"b"')),
				row("02", "2026-01-01"),
				row("04", "2026-02-02"),
				row("01", "2026-01-01"),
			),
		});
		expect(batches.map((batch) => batch.date)).toEqual([
			"2026-01-01",
			"2026-02-02",
		]);
		expect(batches.map((batch) => batch.ids)).toEqual([
			["01", "02"],
			["03", "04"],
		]);
		expect(batches[0]?.text).toBe(
			`${bodyOf("01", "2026-01-01")}\n${bodyOf("02", "2026-01-01")}\n`,
		);
		expect(batches[1]?.text).toBe(
			`${bodyOf("03", "2026-02-02", ',"note":"b"')}\n${bodyOf("04", "2026-02-02")}\n`,
		);
		expect(batches[0]?.sha256).toBe(sha256Hex(utf8(batches[0]?.text ?? "")));
	});

	test("names a batch from its content: the same rows in any order give the same key, other rows another", () => {
		const first = row("01", "2026-01-01");
		const second = row("02", "2026-01-01");
		const [forward] = planOutbox({ school: SCHOOL, rows: [first, second] });
		const [backward] = planOutbox({ school: SCHOOL, rows: [second, first] });
		expect(forward).toEqual(backward);
		expect(forward?.key).toMatch(
			/^schools\/sch_vol\/events\/date=2026-01-01\/batch-01-[0-9a-f]{16}\.jsonl$/,
		);
		const [alone] = planOutbox({ school: SCHOOL, rows: [first] });
		expect(alone?.key).not.toBe(forward?.key);
		const [changed] = planOutbox({
			school: SCHOOL,
			rows: [
				first,
				row("02", "2026-01-01", bodyOf("02", "2026-01-01", ',"x":1')),
			],
		});
		expect(changed?.key).not.toBe(forward?.key);
	});

	test("a batch name is a plain .jsonl that is neither day.jsonl nor late-*", () => {
		const [batch] = planOutbox({
			school: SCHOOL,
			rows: [row("01", "2026-01-01")],
		});
		const name = batch?.key.split("/").pop() ?? "";
		expect(name.endsWith(".jsonl")).toBe(true);
		expect(name).not.toBe("day.jsonl");
		expect(name.startsWith("late-")).toBe(false);
	});

	test("no rows is no batches", () => {
		expect(planOutbox({ school: SCHOOL, rows: [] })).toEqual([]);
	});

	test("refuses a row the reader would not read or would collapse: a bad id, a body that is not JSON, or one that disagrees with its row", () => {
		const plan = (rowToPlan: OutboxRow) =>
			planOutbox({
				school: SCHOOL,
				rows: [row("00", "2026-01-01"), rowToPlan],
			});
		expect(() => plan(row("a/b", "2026-01-01"))).toThrow("is not letters");
		expect(() => plan(row("01", "2026-01-01", "not json"))).toThrow("not JSON");
		expect(() => plan(row("01", "2026-01-01", "[1]"))).toThrow(
			"not a JSON object",
		);
		expect(() =>
			plan(row("01", "2026-01-01", '{"id":"01","date":"2026-01-01"}')),
		).toThrow("idem");
		expect(() =>
			plan(row("01", "2026-01-01", bodyOf("01", "2026-01-02"))),
		).toThrow("date");
		expect(() =>
			plan(row("01", "2026-01-01", bodyOf("02", "2026-01-01"))),
		).toThrow("id");
	});

	test("refuses a date that is not a day and a body that is not one line", () => {
		expect(() =>
			planOutbox({ school: SCHOOL, rows: [row("01", "2026-01-01/../x")] }),
		).toThrow("not YYYY-MM-DD");
		expect(() =>
			planOutbox({ school: SCHOOL, rows: [row("01", "2026-01-01", "a\nb")] }),
		).toThrow("newline");
		expect(() =>
			planOutbox({ school: SCHOOL, rows: [row("01", "2026-01-01", "")] }),
		).toThrow("empty body");
	});
});

describe("shipOutbox", () => {
	test("an empty outbox ships nothing and writes no file", async () => {
		const { db } = newDatabase();
		const { root, store, cleanup } = await setup();
		const result = await ship(db, store);
		expect(result).toEqual({ batches: [], conflicts: [], shipped: 0 });
		expect(await readdir(root)).toEqual([]);
		await cleanup();
	});

	test("ships each day to its own batch and marks the rows with the key and the time", async () => {
		const { db } = newDatabase();
		const { root, store, cleanup } = await setup();
		insertRow(db, { id: "01", date: "2026-01-01" });
		insertRow(db, { id: "02", date: "2026-01-01" });
		insertRow(db, { id: "03", date: "2026-01-02" });
		const result = await ship(db, store);
		expect(result.shipped).toBe(3);
		expect(result.conflicts).toEqual([]);
		expect(
			result.batches.map(({ date, events, status }) => [date, events, status]),
		).toEqual([
			["2026-01-01", 2, "created"],
			["2026-01-02", 1, "created"],
		]);
		const files = await listEventFiles(root, SCHOOL);
		expect(files.length).toBe(2);
		const marked = outboxOf(db);
		expect(marked.map((record) => record.shipped_at)).toEqual([
			SHIPPED_AT,
			SHIPPED_AT,
			SHIPPED_AT,
		]);
		expect(marked.map((record) => record.batch_key)).toEqual([
			result.batches[0]?.key,
			result.batches[0]?.key,
			result.batches[1]?.key,
		]);
		for (const batch of result.batches)
			expect(await readFile(join(root, batch.key), "utf8")).toBe(
				batch.date === "2026-01-01"
					? `${bodyOf("01", "2026-01-01")}\n${bodyOf("02", "2026-01-01")}\n`
					: `${bodyOf("03", "2026-01-02")}\n`,
			);
		await cleanup();
	});

	test("ships only the school it is given", async () => {
		const { db } = newDatabase();
		const { root, store, cleanup } = await setup();
		insertRow(db, { id: "01", date: "2026-01-01" });
		insertRow(db, { id: "02", date: "2026-01-01", school: OTHER_SCHOOL });
		await ship(db, store);
		expect(await listEventFiles(root, SCHOOL)).toHaveLength(1);
		expect(await listEventFiles(root, OTHER_SCHOOL)).toEqual([]);
		expect(
			outboxOf(db).map((record) => [record.school_id, record.shipped_at]),
		).toEqual([
			[SCHOOL, SHIPPED_AT],
			[OTHER_SCHOOL, null],
		]);
		await cleanup();
	});

	test("a rerun is a no-op", async () => {
		const { db } = newDatabase();
		const { root, store, cleanup } = await setup();
		insertRow(db, { id: "01", date: "2026-01-01" });
		await ship(db, store);
		const marked = outboxOf(db);
		const files = await listEventFiles(root, SCHOOL);
		const again = await shipOutbox({
			db,
			store,
			school: SCHOOL,
			nowMs: () => SHIPPED_AT + 1,
		});
		expect(again).toEqual({ batches: [], conflicts: [], shipped: 0 });
		expect(outboxOf(db)).toEqual(marked);
		expect(await listEventFiles(root, SCHOOL)).toEqual(files);
		await cleanup();
	});

	test("rows that arrive later go to a new batch; the shipped one is never rewritten", async () => {
		const { db } = newDatabase();
		const { root, store, cleanup } = await setup();
		insertRow(db, { id: "01", date: "2026-01-01" });
		const [early] = (await ship(db, store)).batches;
		const earlyBytes = await readFile(join(root, early?.key ?? ""), "utf8");
		insertRow(db, { id: "02", date: "2026-01-01" });
		const [late] = (await ship(db, store)).batches;
		expect(late?.key).not.toBe(early?.key);
		expect(late?.status).toBe("created");
		expect(await readFile(join(root, early?.key ?? ""), "utf8")).toBe(
			earlyBytes,
		);
		expect(await listEventFiles(root, SCHOOL)).toHaveLength(2);
		await cleanup();
	});

	test("a crash between the put and the mark is repaired by a rerun: same key, same bytes, one file", async () => {
		const { raw, db } = newDatabase();
		const { root, store, cleanup } = await setup();
		insertRow(db, { id: "01", date: "2026-01-01" });
		insertRow(db, { id: "02", date: "2026-01-01" });
		const crashing: SqlDatabase = {
			...db,
			exec: (sql) => db.exec(sql),
			all: (sql, params) => db.all(sql, params),
			run: (sql, params) => db.run(sql, params),
			transaction: () => {
				throw new Error("crash before the mark");
			},
		};
		await expect(ship(crashing, store)).rejects.toThrow("crash before");
		const [file] = await listEventFiles(root, SCHOOL);
		expect(file).toBeDefined();
		const bytes = await readFile(
			join(root, "schools", SCHOOL, file ?? ""),
			"utf8",
		);
		expect(outboxOf(db).every((record) => record.shipped_at === null)).toBe(
			true,
		);

		const result = await ship(db, store);
		expect(result.shipped).toBe(2);
		expect(result.batches.map((batch) => batch.status)).toEqual(["existing"]);
		expect(await listEventFiles(root, SCHOOL)).toEqual([file as string]);
		expect(
			await readFile(join(root, "schools", SCHOOL, file ?? ""), "utf8"),
		).toBe(bytes);
		expect(
			outboxOf(db).every((record) => record.shipped_at === SHIPPED_AT),
		).toBe(true);
		raw.close();
		await cleanup();
	});

	test("two shippers on the same rows converge on one file and every row marked once", async () => {
		const { db } = newDatabase();
		const { root, store, cleanup } = await setup();
		insertRow(db, { id: "01", date: "2026-01-01" });
		insertRow(db, { id: "02", date: "2026-01-01" });
		const [first, second] = await Promise.all([
			ship(db, store),
			ship(db, new FolderStore({ root })),
		]);
		expect(first.conflicts).toEqual([]);
		expect(second.conflicts).toEqual([]);
		expect(first.batches[0]?.key).toBe(second.batches[0]?.key);
		expect(
			[first.batches[0]?.status, second.batches[0]?.status].sort(),
		).toEqual(["created", "existing"]);
		expect(first.shipped + second.shipped).toBe(2);
		expect(await listEventFiles(root, SCHOOL)).toHaveLength(1);
		expect(new Set(outboxOf(db).map((record) => record.batch_key)).size).toBe(
			1,
		);
		await cleanup();
	});

	test("a key that holds different bytes is a conflict: nothing is overwritten and its rows stay unshipped", async () => {
		const { db } = newDatabase();
		const { root, store, cleanup } = await setup();
		insertRow(db, { id: "01", date: "2026-01-01" });
		insertRow(db, { id: "02", date: "2026-01-02" });
		const [clashing] = planOutbox({
			school: SCHOOL,
			rows: rowsOf(row("01", "2026-01-01")),
		});
		const foreign = utf8('{"id":"someone else"}\n');
		await store.putIfAbsent(clashing?.key ?? "", foreign);

		const result = await ship(db, store);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]).toMatchObject({
			key: clashing?.key,
			date: "2026-01-01",
			ids: ["01"],
		});
		expect(result.conflicts[0]?.message).toContain("different bytes");
		// The other day still ships.
		expect(result.shipped).toBe(1);
		expect(
			outboxOf(db).map((record) => [record.id, record.shipped_at]),
		).toEqual([
			["01", null],
			["02", SHIPPED_AT],
		]);
		expect(await readFile(join(root, clashing?.key ?? ""), "utf8")).toBe(
			'{"id":"someone else"}\n',
		);
		await cleanup();
	});

	test("a day that already holds a day.jsonl is a conflict: a batch there would be shipped and never read", async () => {
		const { db } = newDatabase();
		const { root, store, cleanup } = await setup();
		const dayKey = `schools/${SCHOOL}/events/date=2026-01-01/day.jsonl`;
		await store.putIfAbsent(dayKey, utf8('{"id":"00","idem":"idem-00"}\n'));
		insertRow(db, { id: "01", date: "2026-01-01" });
		insertRow(db, { id: "02", date: "2026-01-02" });

		const result = await ship(db, store);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]).toMatchObject({
			date: "2026-01-01",
			ids: ["01"],
		});
		expect(result.conflicts[0]?.message).toContain("day.jsonl");
		expect(result.shipped).toBe(1);
		expect(
			outboxOf(db).map((record) => [record.id, record.shipped_at]),
		).toEqual([
			["01", null],
			["02", SHIPPED_AT],
		]);
		expect(await listEventFiles(root, SCHOOL)).toEqual([
			"events/date=2026-01-01/day.jsonl",
			expect.stringContaining("events/date=2026-01-02/batch-02-"),
		]);
		await cleanup();
	});

	test("a row the handler inserts between the plan and the mark stays unshipped and ships next run", async () => {
		const { db } = newDatabase();
		const { root, store, cleanup } = await setup();
		insertRow(db, { id: "01", date: "2026-01-01" });
		const racing = Object.create(store) as FolderStore;
		racing.putIfAbsent = async (key, body) => {
			const result = await store.putIfAbsent(key, body);
			insertRow(db, { id: "02", date: "2026-01-01" });
			return result;
		};
		const first = await ship(db, racing);
		expect(first.shipped).toBe(1);
		expect(
			outboxOf(db).map((record) => [record.id, record.shipped_at]),
		).toEqual([
			["01", SHIPPED_AT],
			["02", null],
		]);
		const second = await ship(db, store);
		expect(second.shipped).toBe(1);
		expect(second.batches[0]?.key).not.toBe(first.batches[0]?.key);
		expect(await listEventFiles(root, SCHOOL)).toHaveLength(2);
		await cleanup();
	});

	test("a crash between the put and the mark, then a new row for that day: the rerun writes a second batch and the reader still has each event once", async () => {
		const { db } = newDatabase();
		const { root, store, cleanup } = await setup();
		const body = (id: string) => bodyOf(id, "2026-01-01");
		insertRow(db, { id: "01", date: "2026-01-01", body: body("01") });
		insertRow(db, { id: "02", date: "2026-01-01", body: body("02") });
		const crashing: SqlDatabase = {
			...db,
			exec: (sql) => db.exec(sql),
			all: (sql, params) => db.all(sql, params),
			run: (sql, params) => db.run(sql, params),
			transaction: () => {
				throw new Error("crash before the mark");
			},
		};
		await expect(ship(crashing, store)).rejects.toThrow("crash before");
		insertRow(db, { id: "03", date: "2026-01-01", body: body("03") });

		const result = await ship(db, store);
		expect(result.shipped).toBe(3);
		const files = await listEventFiles(root, SCHOOL);
		expect(files).toHaveLength(2);
		const { events } = await readEvents(root, SCHOOL);
		expect(events.map((event) => event.id)).toEqual(["01", "02", "03"]);
		await cleanup();
	});

	test("a row that would be shipped unread refuses the whole shipment before any put and leaves every row unshipped", async () => {
		const { db } = newDatabase();
		const { root, store, cleanup } = await setup();
		insertRow(db, { id: "01", date: "2026-01-01" });
		insertRow(db, { id: "a/b", date: "2026-01-02" });
		await expect(ship(db, store)).rejects.toThrow("is not letters");
		expect(outboxOf(db).every((record) => record.shipped_at === null)).toBe(
			true,
		);
		expect(await readdir(root)).toEqual([]);
		await cleanup();
	});

	test("an error other than a conflict propagates and leaves the rows unshipped", async () => {
		const { db } = newDatabase();
		const { root, store, cleanup } = await setup();
		insertRow(db, { id: "01", date: "2026-01-01" });
		const broken = Object.create(store) as FolderStore;
		broken.putIfAbsent = () => Promise.reject(new Error("store is down"));
		await expect(ship(db, broken)).rejects.toThrow("store is down");
		expect(outboxOf(db)[0]?.shipped_at).toBeNull();
		expect(await readdir(root)).toEqual([]);
		await cleanup();
	});
});

describe("the handler's outbox, shipped, read and journaled", () => {
	const eventsOf = (db: SqlDatabase): AtmEvent[] =>
		outboxOf(db).map((record) => JSON.parse(record.body) as AtmEvent);

	test("readEvents gives back the events the handler decided", async () => {
		const { db } = filledByHandler();
		const { root, store, cleanup } = await setup();
		const outbox = outboxOf(db);
		expect(new Set(outbox.map((record) => record.date)).size).toBeGreaterThan(
			1,
		);
		const result = await ship(db, store);
		expect(result.conflicts).toEqual([]);
		expect(result.shipped).toBe(outbox.length);
		expect(outboxOf(db).every((record) => record.batch_key !== null)).toBe(
			true,
		);

		const { events } = await readEvents(root, SCHOOL);
		expect(events).toEqual(eventsOf(db));
		await cleanup();
	});

	test("journalMonth over the shipped files is buildJournal over the same events", async () => {
		const { db } = filledByHandler();
		const { root, store, cleanup } = await setup();
		await ship(db, store);
		const direct = buildJournal({ events: eventsOf(db), month: "2026-02" });
		const run = await journalMonth({ root, school: SCHOOL, month: "2026-02" });
		expect(run.build.inputsHash).toBe(direct.inputsHash);
		expect(run.build.transactions).toBeGreaterThan(0);
		for (const [path, text] of Object.entries(direct.files))
			expect(await readFile(join(root, "schools", SCHOOL, path), "utf8")).toBe(
				text,
			);
		await cleanup();
	});

	test("a second shipment after another delivery adds a batch and the journal follows", async () => {
		const { db } = filledByHandler();
		const { root, store, cleanup } = await setup();
		const outbox = outboxOf(db);
		const held = outbox.at(-1) as OutboxRecord;
		db.run(`DELETE FROM ledger_outbox WHERE id = ?`, [held.id]);
		await ship(db, store);
		insertRow(db, {
			id: held.id,
			date: held.date,
			idem: held.idem,
			body: held.body,
		});
		await ship(db, store);
		const { events } = await readEvents(root, SCHOOL);
		expect(events.map((event) => event.id)).toEqual(
			outbox.map((record) => record.id),
		);
		await cleanup();
	});

	test.skipIf(!hasHledger)(
		"hledger accepts the journal built from shipped events",
		async () => {
			const { db } = filledByHandler();
			const { root, store, cleanup } = await setup();
			await ship(db, store);
			for (const month of ["2026-01", "2026-02", "2026-03"])
				await journalMonth({ root, school: SCHOOL, month });
			const checked = Bun.spawnSync(
				[
					"hledger",
					"-f",
					"main.journal",
					"check",
					"balanced",
					"accounts",
					"commodities",
				],
				{ cwd: join(root, "schools", SCHOOL), stdout: "pipe", stderr: "pipe" },
			);
			expect(checked.stderr.toString()).toBe("");
			expect(checked.exitCode).toBe(0);
			await cleanup();
		},
	);
});

describe("atm ship", () => {
	const bin = join(import.meta.dir, "../src/bin.ts");
	const runShip = (args: string[]) =>
		Bun.spawnSync(["bun", bin, "ship", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});

	test("ships a SQLite file to a folder that atm journal reads, and a second run ships nothing", async () => {
		const { raw } = filledByHandler();
		const folder = await tmp("ship-cli");
		const databaseFile = join(folder, "handler.sqlite");
		raw.exec(`VACUUM INTO '${databaseFile}'`);
		const root = join(folder, "log");
		await mkdir(root);
		const args = ["--db", databaseFile, "--root", root, "--school", SCHOOL];

		const first = runShip(args);
		expect(first.stderr.toString()).toBe("");
		expect(first.exitCode).toBe(0);
		expect(first.stdout.toString()).toMatch(
			/\d+ events shipped in 3 batches; 0 conflicts/,
		);

		const second = runShip(args);
		expect(second.exitCode).toBe(0);
		expect(second.stdout.toString()).toContain(
			"0 events shipped in 0 batches; 0 conflicts",
		);

		const journal = Bun.spawnSync(
			[
				"bun",
				bin,
				"journal",
				"--root",
				root,
				"--school",
				SCHOOL,
				"--month",
				"2026-02",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(journal.exitCode).toBe(0);
		await rm(folder, { recursive: true, force: true });
	});

	test("a --root that is not an existing folder exits 2, creates nothing and leaves every row unshipped", async () => {
		const { raw } = filledByHandler();
		const folder = await tmp("ship-cli-typo-root");
		const databaseFile = join(folder, "handler.sqlite");
		raw.exec(`VACUUM INTO '${databaseFile}'`);
		const typo = join(folder, "lgo");
		const result = runShip([
			"--db",
			databaseFile,
			"--root",
			typo,
			"--school",
			SCHOOL,
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain(
			`--root ${typo} is not an existing folder`,
		);
		expect(await readdir(folder)).toEqual(["handler.sqlite"]);
		const database = new Database(databaseFile, { readonly: true });
		const unshipped = database
			.query("SELECT COUNT(*) AS n FROM ledger_outbox WHERE shipped_at IS NULL")
			.get() as { n: number };
		database.close();
		expect(unshipped.n).toBeGreaterThan(0);
		await rm(folder, { recursive: true, force: true });
	});

	test("a --root that is a file is refused too", async () => {
		const { raw } = filledByHandler();
		const folder = await tmp("ship-cli-file-root");
		const databaseFile = join(folder, "handler.sqlite");
		raw.exec(`VACUUM INTO '${databaseFile}'`);
		const result = runShip([
			"--db",
			databaseFile,
			"--root",
			databaseFile,
			"--school",
			SCHOOL,
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("is not an existing folder");
		await rm(folder, { recursive: true, force: true });
	});

	test("a --school with no rows in the outbox exits 2, names the schools that have some and ships nothing", async () => {
		const { raw } = filledByHandler();
		const folder = await tmp("ship-cli-typo-school");
		const databaseFile = join(folder, "handler.sqlite");
		raw.exec(`VACUUM INTO '${databaseFile}'`);
		const root = join(folder, "log");
		await mkdir(root);
		const result = runShip([
			"--db",
			databaseFile,
			"--root",
			root,
			"--school",
			`${SCHOOL}x`,
		]);
		expect(result.exitCode).toBe(2);
		const message = result.stderr.toString();
		expect(message).toContain(
			`--school ${SCHOOL}x has no rows in ledger_outbox`,
		);
		expect(message).toContain(`schools there: ${SCHOOL}`);
		expect(await readdir(root)).toEqual([]);
		await rm(folder, { recursive: true, force: true });
	});

	test("exits 1 and says so when a batch key holds other bytes", async () => {
		const { raw } = filledByHandler();
		const folder = await tmp("ship-cli-conflict");
		const databaseFile = join(folder, "handler.sqlite");
		raw.exec(`VACUUM INTO '${databaseFile}'`);
		const root = join(folder, "log");
		await mkdir(root);
		const [first] = planOutbox({
			school: SCHOOL,
			rows: outboxOf(bunSqlite(raw))
				.filter((record) => record.date === "2026-01-15")
				.map(({ id, idem, date, body }) => ({ id, idem, date, body })),
		});
		await new FolderStore({ root }).putIfAbsent(
			first?.key ?? "",
			utf8("not what the handler decided\n"),
		);
		const result = runShip([
			"--db",
			databaseFile,
			"--root",
			root,
			"--school",
			SCHOOL,
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain(`conflict ${first?.key}`);
		await rm(folder, { recursive: true, force: true });
	});
});
