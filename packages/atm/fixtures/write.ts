import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AtmEvent } from "../src/types.js";
import { generateYear } from "./vibes.js";

const WINDOW_MS = 5 * 60_000;

/** `schools/<id>/events/date=YYYY-MM-DD/<first_ulid>-<last_ulid>.jsonl`: events grouped by local date and five-minute ingest window. */
export const batchEvents = (
	events: readonly AtmEvent[],
): Map<string, AtmEvent[]> => {
	const groups = new Map<string, AtmEvent[]>();
	for (const e of events) {
		const k = `${e.school}\u0000${e.date}\u0000${Math.floor(Date.parse(e.ingest_time) / WINDOW_MS)}`;
		const list = groups.get(k);
		if (list) list.push(e);
		else groups.set(k, [e]);
	}
	const out = new Map<string, AtmEvent[]>();
	for (const list of groups.values()) {
		list.sort((a, b) => (a.id < b.id ? -1 : 1));
		const first = list[0] as AtmEvent;
		const last = list[list.length - 1] as AtmEvent;
		out.set(
			`schools/${first.school}/events/date=${first.date}/${first.id}-${last.id}.jsonl`,
			list,
		);
	}
	return out;
};

export const eventLines = (events: readonly AtmEvent[]): string =>
	events.map((e) => `${JSON.stringify(e)}\n`).join("");

/** Writes one seed's year under `outDir`: the event batches, `expected.json` and `catalog.json`. Returns the paths written. */
export const writeFixture = async ({
	seed,
	outDir,
}: {
	seed: number;
	outDir: string;
}): Promise<string[]> => {
	const fixture = generateYear({ seed });
	const files: Record<string, string> = {
		"expected.json": `${JSON.stringify(fixture.expected, null, 2)}\n`,
		"catalog.json": `${JSON.stringify(fixture.catalog, null, 2)}\n`,
	};
	for (const [key, list] of batchEvents(fixture.events))
		files[key] = eventLines(list);
	for (const [path, text] of Object.entries(files)) {
		const full = join(outDir, path);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, text);
	}
	return Object.keys(files).sort();
};
