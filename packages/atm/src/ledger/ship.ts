import { Conflict, putOnce, sha256Hex, utf8 } from "../store/store.js";
import type {
	OutboxBatch,
	OutboxRow,
	ShipConflict,
	ShipOutboxInput,
	ShipOutboxResult,
	ShippedBatch,
} from "../types.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const KEY_HASH_LENGTH = 16;

const byId = (a: OutboxRow, b: OutboxRow) =>
	a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Plan: the unshipped rows of one school as batches, one per event date, each a pure function of its rows. The lines
 * are the stored bodies as they are (never re-serialized), in id order. The key carries the first id (so a day's
 * batches sort by where they start) and the first 16 hex digits of the sha256 of the text, so the same rows give the
 * same key and bytes on every try and on every shipper, and different rows give a different key (two honest shippers
 * never conflict). `batch-` cannot meet `day.jsonl` or `late-*`, which belong to the combine step. Throws on a date
 * that is not `YYYY-MM-DD` or a body that is empty or holds a newline: either would put a row where the reader does
 * not look, or split one event into two lines.
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
		if (row.body.length === 0 || row.body.includes("\n"))
			throw new Error(
				`outbox row ${row.id} has an empty body or one with a newline`,
			);
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
 * Ship: plan the school's unshipped outbox rows, put each batch create-only (`putOnce`: an equal object already there
 * is an earlier try that landed, so success; different bytes is a `ShipConflict`, nothing written and the rows left
 * unshipped for an alert), then mark the batch's rows (`batch_key`, `shipped_at`) in one transaction. The mark only
 * touches rows still unshipped. A crash between put and mark is repaired by running it again: same rows, same key,
 * same bytes, so the put finds its object and the mark runs. A store error other than a conflict propagates; batches
 * already marked stay marked.
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
			for (const id of batch.ids)
				changes += db.run(
					`UPDATE ledger_outbox SET batch_key = ?, shipped_at = ? WHERE school_id = ? AND id = ? AND shipped_at IS NULL`,
					[batch.key, shippedAt, school, id],
				).changes;
			return changes;
		});
		shipped += marked;
		batches.push({ key: batch.key, date: batch.date, events: marked, status });
	}
	return { batches, conflicts, shipped };
};
