import type { OutboxStatus, OutboxStatusInput } from "../types.js";
import { ULID_PATTERN, ulidTime } from "./ids.js";

const ULID = new RegExp(ULID_PATTERN);

type CountRow = {
	total: number;
	shipped: number;
	last_shipped_at: number | null;
};
type OldestRow = { id: string; date: string };

/** When an outbox row's event happened: the time its ULID id encodes, else the start of its date in UTC, else null. */
const eventInstantMs = (row: OldestRow): number | null => {
	if (ULID.test(row.id)) return ulidTime(row.id);
	const dateMs = Date.parse(`${row.date}T00:00:00Z`);
	return Number.isNaN(dateMs) ? null : dateMs;
};

/**
 * The state of one school's outbox for a health check: counts, the newest `shipped_at`, and the oldest unshipped row
 * (the order `shipOutbox` takes, date then id) with its age. Reads only.
 */
export const outboxStatus = ({
	db,
	school,
	nowMs,
}: OutboxStatusInput): OutboxStatus => {
	const [counts] = db.all<CountRow>(
		`SELECT COUNT(*) AS total, COALESCE(SUM(shipped_at IS NOT NULL), 0) AS shipped, MAX(shipped_at) AS last_shipped_at FROM ledger_outbox WHERE school_id = ?`,
		[school],
	);
	const [oldest] = db.all<OldestRow>(
		`SELECT id, date FROM ledger_outbox WHERE school_id = ? AND shipped_at IS NULL ORDER BY date, id LIMIT 1`,
		[school],
	);
	const total = counts?.total ?? 0;
	const shipped = counts?.shipped ?? 0;
	const instantMs = oldest === undefined ? null : eventInstantMs(oldest);
	return {
		school,
		total,
		shipped,
		unshipped: total - shipped,
		lastShippedAt: counts?.last_shipped_at ?? null,
		oldestUnshippedDate: oldest?.date ?? null,
		oldestUnshippedId: oldest?.id ?? null,
		oldestUnshippedAgeMs:
			instantMs === null ? null : Math.max(0, nowMs() - instantMs),
	};
};
