import {
	Conflict,
	NotFound,
	putOnce,
	sha256Hex,
	utf8,
} from "../store/store.js";
import type {
	OutboxBatch,
	OutboxRow,
	ShipConflict,
	ShipOutboxInput,
	ShipOutboxResult,
	ShippedBatch,
	Store,
} from "../types.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[0-9A-Za-z_-]+$/;
const KEY_HASH_LENGTH = 16;

const COMBINED_DAY_NAME = "day.jsonl";

const byId = (a: OutboxRow, b: OutboxRow) =>
	a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Throws unless the body is a JSON object that carries the row's own `id`, `idem` and `date`. */
const assertBodyMatchesRow = (row: OutboxRow): void => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.body);
	} catch {
		throw new Error(`outbox row ${row.id} has a body that is not JSON`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(
			`outbox row ${row.id} has a body that is not a JSON object`,
		);
	const fields = parsed as Record<string, unknown>;
	for (const field of ["id", "idem", "date"] as const)
		if (fields[field] !== row[field])
			throw new Error(
				`outbox row ${row.id} has ${field} ${JSON.stringify(row[field])} but its body says ${JSON.stringify(fields[field])}`,
			);
};

/**
 * Plan: the unshipped rows of one school as batches, one per event date, each a pure function of its rows. The lines
 * are the stored bodies as they are (never re-serialized), in id order. The key carries the first id (so a day's
 * batches sort by where they start) and the first 16 hex digits of the sha256 of the text, so the same rows give the
 * same key and bytes on every try and on every shipper, and different rows give a different key (two honest shippers
 * never conflict). `batch-` cannot meet `day.jsonl` or `late-*`, which belong to the combine step. Throws on a date
 * that is not `YYYY-MM-DD`, an id that is not plain characters (a `/` would nest the batch's name into a folder the
 * reader does not list), or a body that is empty, holds a newline, is not a JSON object, or disagrees with its row on
 * `id`, `idem` or `date`: each would put a row where the reader does not look, split one event into two lines, make
 * the reader throw for the whole school, or collapse events that share no real `idem`. The log is create-only, so a
 * bad row is refused here, before any put, for the whole school (all or nothing), never shipped.
 */
export const planOutbox = ({
	school,
	rows,
}: {
	school: string;
	rows: readonly OutboxRow[];
}): OutboxBatch[] => {
	const rowsByDate = new Map<string, OutboxRow[]>();
	for (const row of rows) {
		if (!DATE_PATTERN.test(row.date))
			throw new Error(
				`outbox row ${row.id} has date ${row.date}, not YYYY-MM-DD`,
			);
		if (!ID_PATTERN.test(row.id))
			throw new Error(`outbox row id ${row.id} is not letters, digits, _ or -`);
		if (row.body.length === 0 || row.body.includes("\n"))
			throw new Error(
				`outbox row ${row.id} has an empty body or one with a newline`,
			);
		assertBodyMatchesRow(row);
		const day = rowsByDate.get(row.date) ?? [];
		day.push(row);
		rowsByDate.set(row.date, day);
	}
	return [...rowsByDate.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([date, day]) => {
			const sorted = [...day].sort(byId);
			const text = `${sorted.map((row) => row.body).join("\n")}\n`;
			const sha256 = sha256Hex(utf8(text));
			return {
				key: `schools/${school}/events/date=${date}/batch-${sorted[0]?.id}-${sha256.slice(0, KEY_HASH_LENGTH)}.jsonl`,
				date,
				ids: sorted.map((row) => row.id),
				text,
				sha256,
			};
		});
};

/**
 * The key of the day's `day.jsonl` when the store holds one, else null. The reader keeps only `late-*` beside a
 * `day.jsonl`, so a `batch-*` put into such a day would be marked shipped and never read.
 */
const combinedDayKey = async (
	store: Store,
	batchKey: string,
): Promise<string | null> => {
	const key = `${batchKey.slice(0, batchKey.lastIndexOf("/") + 1)}${COMBINED_DAY_NAME}`;
	try {
		await store.head(key);
		return key;
	} catch (error) {
		if (error instanceof NotFound) return null;
		throw error;
	}
};

/**
 * Ship: plan the school's unshipped outbox rows, put each batch create-only (`putOnce`: an equal object already there
 * is an earlier try that landed, so success; different bytes is a `ShipConflict`, nothing written and the rows left
 * unshipped for an alert), then mark the batch's rows (`batch_key`, `shipped_at`) in one transaction. The mark only
 * touches rows still unshipped, by id and body, so a row the handler inserts after the plan (a row of the other env with the
 * same id too: its body names its env) is not marked and ships next time.
 * A day that already holds a `day.jsonl` is a `ShipConflict` too (nothing put, rows unshipped): the reader keeps only
 * `late-*` beside it, so a `batch-*` there would be marked shipped and never read. A crash between put and mark is
 * repaired by running it again when no row arrived for that day in between (same rows, same key, same bytes, so the
 * put finds its object and the mark runs); if one did, the rerun puts a second, overlapping batch under another key
 * and the first stays as a file whose events the reader drops by `idem`. A store error other than a conflict
 * propagates; batches already marked stay marked.
 */
export const shipOutbox = async ({
	db,
	store,
	school,
	nowMs,
}: ShipOutboxInput): Promise<ShipOutboxResult> => {
	const rows = db.all<OutboxRow>(
		`SELECT id, idem, date, body FROM ledger_outbox WHERE school_id = ? AND shipped_at IS NULL ORDER BY date, id`,
		[school],
	);
	const batches: ShippedBatch[] = [];
	const conflicts: ShipConflict[] = [];
	let shipped = 0;
	for (const batch of planOutbox({ school, rows })) {
		const combined = await combinedDayKey(store, batch.key);
		if (combined !== null) {
			conflicts.push({
				key: batch.key,
				date: batch.date,
				ids: batch.ids,
				message: `${combined} exists: the reader keeps only late-* batches beside a day.jsonl, so this batch would be marked shipped and never read`,
			});
			continue;
		}
		let status: ShippedBatch["status"];
		try {
			status = await putOnce(store, batch.key, utf8(batch.text));
		} catch (error) {
			if (!(error instanceof Conflict)) throw error;
			conflicts.push({
				key: batch.key,
				date: batch.date,
				ids: batch.ids,
				message: error.message,
			});
			continue;
		}
		const shippedAt = nowMs();
		const marked = db.transaction(() => {
			let changes = 0;
			for (const row of rows)
				if (row.date === batch.date)
					changes += db.run(
						`UPDATE ledger_outbox SET batch_key = ?, shipped_at = ? WHERE school_id = ? AND id = ? AND body = ? AND shipped_at IS NULL`,
						[batch.key, shippedAt, school, row.id, row.body],
					).changes;
			return changes;
		});
		shipped += marked;
		batches.push({ key: batch.key, date: batch.date, events: marked, status });
	}
	return { batches, conflicts, shipped };
};
