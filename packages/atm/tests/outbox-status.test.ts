import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { outboxStatus } from "../src/index.js";
import { deterministicUlid } from "../src/ledger/ids.js";

const SCHOOL = "sch_vol";
const OTHER_SCHOOL = "sch_other";
const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-03-15T12:00:00Z");

const ulidAt = (timeMs: number, seed: string) =>
	deterministicUlid({ timeMs, revision: 0, seed });

const newDatabase = () => {
	const db = bunSqlite(new Database(":memory:"));
	db.exec(HANDLER_DDL);
	return db;
};

const insert = (
	db: ReturnType<typeof newDatabase>,
	row: {
		id: string;
		date: string;
		school?: string;
		shippedAt?: number | null;
	},
) =>
	db.run(
		`INSERT INTO ledger_outbox (school_id, id, idem, date, body, batch_key, shipped_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
		[
			row.school ?? SCHOOL,
			row.id,
			`idem-${row.id}`,
			row.date,
			`{"id":"${row.id}","idem":"idem-${row.id}","date":"${row.date}"}`,
			row.shippedAt ?? null,
		],
	);

describe("outboxStatus", () => {
	test("an empty outbox has nothing waiting", () => {
		expect(
			outboxStatus({ db: newDatabase(), school: SCHOOL, nowMs: () => NOW }),
		).toEqual({
			school: SCHOOL,
			total: 0,
			shipped: 0,
			unshipped: 0,
			lastShippedAt: null,
			oldestUnshippedDate: null,
			oldestUnshippedId: null,
			oldestUnshippedAgeMs: null,
		});
	});

	test("counts shipped and unshipped rows, and reports the oldest unshipped one by date then id, with its age from the instant its id encodes", () => {
		const db = newDatabase();
		const oldest = ulidAt(NOW - 5 * HOUR_MS, "oldest");
		insert(db, {
			id: ulidAt(NOW - 30 * HOUR_MS, "shipped"),
			date: "2026-03-14",
			shippedAt: NOW - 20 * HOUR_MS,
		});
		insert(db, { id: oldest, date: "2026-03-15" });
		insert(db, { id: ulidAt(NOW - HOUR_MS, "newer"), date: "2026-03-15" });
		const status = outboxStatus({ db, school: SCHOOL, nowMs: () => NOW });
		expect(status).toMatchObject({
			total: 3,
			shipped: 1,
			unshipped: 2,
			lastShippedAt: NOW - 20 * HOUR_MS,
			oldestUnshippedDate: "2026-03-15",
			oldestUnshippedId: oldest,
			oldestUnshippedAgeMs: 5 * HOUR_MS,
		});
	});

	test("an older date wins over a smaller id", () => {
		const db = newDatabase();
		insert(db, { id: ulidAt(NOW - HOUR_MS, "a"), date: "2026-03-15" });
		insert(db, { id: ulidAt(NOW - 2 * HOUR_MS, "z"), date: "2026-03-14" });
		expect(
			outboxStatus({ db, school: SCHOOL, nowMs: () => NOW })
				.oldestUnshippedDate,
		).toBe("2026-03-14");
	});

	test("an id that is not a ULID is aged from the start of its date, in UTC", () => {
		const db = newDatabase();
		insert(db, { id: "evt_plain", date: "2026-03-15" });
		expect(
			outboxStatus({ db, school: SCHOOL, nowMs: () => NOW })
				.oldestUnshippedAgeMs,
		).toBe(12 * HOUR_MS);
	});

	test("an instant in the future is an age of zero, not a negative one", () => {
		const db = newDatabase();
		insert(db, { id: ulidAt(NOW + HOUR_MS, "ahead"), date: "2026-03-15" });
		expect(
			outboxStatus({ db, school: SCHOOL, nowMs: () => NOW })
				.oldestUnshippedAgeMs,
		).toBe(0);
	});

	test("a fully shipped outbox has no oldest row, and another school's rows are not counted", () => {
		const db = newDatabase();
		insert(db, {
			id: ulidAt(NOW - 3 * HOUR_MS, "done"),
			date: "2026-03-15",
			shippedAt: NOW - HOUR_MS,
		});
		insert(db, {
			id: ulidAt(NOW - 9 * HOUR_MS, "elsewhere"),
			date: "2026-03-14",
			school: OTHER_SCHOOL,
		});
		expect(
			outboxStatus({ db, school: SCHOOL, nowMs: () => NOW }),
		).toMatchObject({
			total: 1,
			shipped: 1,
			unshipped: 0,
			oldestUnshippedDate: null,
			oldestUnshippedAgeMs: null,
		});
		expect(
			outboxStatus({ db, school: OTHER_SCHOOL, nowMs: () => NOW }),
		).toMatchObject({
			total: 1,
			unshipped: 1,
			oldestUnshippedDate: "2026-03-14",
		});
	});
});
