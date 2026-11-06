/**
 * Events through atm's real write path and back: `appendToOutbox` (one row per `(school, env, idem)`), `shipOutbox` into a
 * folder, `readEvents`. The generator builds events in memory; nothing in memory dedupes by `idem`, so a collision that the
 * outbox would silently drop (two subjects' commands sharing a command id) only shows up here. Needs Bun (`bun:sqlite`).
 */
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunSqlite } from "../handler/bun-sqlite.js";
import { HANDLER_DDL } from "../handler/schema.js";
import { readEvents } from "../ledger/files.js";
import { appendToOutbox } from "../ledger/outbox.js";
import { shipOutbox } from "../ledger/ship.js";
import { FolderStore } from "../store/folder-store.js";
import type { AtmEvent } from "../types.js";

const SHIPPED_AT = 1_700_000_000_000;
const LOST_SHOWN = 5;

export class RoundTripError extends Error {}

/** The events as the log's reader returns them after outbox and ship; throws `RoundTripError` naming what was lost when it is not all of them. */
export const roundTripEvents = async (
	events: readonly AtmEvent[],
): Promise<AtmEvent[]> => {
	const raw = new Database(":memory:");
	const db = bunSqlite(raw);
	db.exec(HANDLER_DDL);
	const root = await mkdtemp(join(tmpdir(), "atm-roundtrip-"));
	try {
		appendToOutbox(db, events, "live");
		const store = new FolderStore({ root });
		for (const school of new Set(events.map((event) => event.school))) {
			const shipped = await shipOutbox({
				db,
				store,
				school,
				nowMs: () => SHIPPED_AT,
			});
			if (shipped.conflicts.length > 0)
				throw new RoundTripError(
					`ship conflicts: ${JSON.stringify(shipped.conflicts)}`,
				);
		}
		const back: AtmEvent[] = [];
		for (const school of new Set(events.map((event) => event.school)))
			back.push(...(await readEvents(root, school)).events);
		if (back.length !== events.length) {
			const kept = new Set(back.map((event) => event.id));
			const byType = new Map<string, number>();
			for (const event of events)
				if (!kept.has(event.id))
					byType.set(event.event_type, (byType.get(event.event_type) ?? 0) + 1);
			const idems = new Map<string, number>();
			for (const event of events)
				idems.set(event.idem, (idems.get(event.idem) ?? 0) + 1);
			const repeated = [...idems.entries()]
				.filter(([, n]) => n > 1)
				.slice(0, LOST_SHOWN)
				.map(([idem]) => idem);
			throw new RoundTripError(
				`${events.length} events went in and ${back.length} came back (lost: ${[...byType.entries()].map(([type, n]) => `${type} ${n}`).join(", ")}); the outbox keeps one row per idem, repeated idems such as ${repeated.join(", ")}`,
			);
		}
		return back;
	} finally {
		raw.close();
		await rm(root, { recursive: true, force: true });
	}
};
