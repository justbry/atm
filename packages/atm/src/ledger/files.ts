import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AtmEvent, AtmJournalBuild } from "../types.js";
import { buildJournal } from "./journal.js";
import { sha256Hex } from "./util.js";

const exists = async (path: string) =>
	readFile(path).then(
		() => true,
		() => false,
	);

/**
 * A school's event objects, by partition and file name. When a day has `day.jsonl` the day is that file plus its
 * `late-*` batches (the batches it combined are not read twice); otherwise it is the batches.
 */
export const listEventFiles = async (
	root: string,
	school: string,
): Promise<string[]> => {
	const base = join(root, "schools", school, "events");
	const days = (await readdir(base).catch(() => []))
		.filter((d) => d.startsWith("date="))
		.sort();
	const out: string[] = [];
	for (const day of days) {
		const names = (await readdir(join(base, day)))
			.filter((n) => n.endsWith(".jsonl"))
			.sort();
		const combined = names.includes("day.jsonl");
		for (const n of names) {
			if (combined && n !== "day.jsonl" && !n.startsWith("late-")) continue;
			out.push(`events/${day}/${n}`);
		}
	}
	return out;
};

/** Reads the school's events, dropping a second event with an `idem` already seen (the first by id wins). */
export const readEvents = async (
	root: string,
	school: string,
): Promise<{
	events: AtmEvent[];
	files: { key: string; sha256: string; lines: number }[];
}> => {
	const files: { key: string; sha256: string; lines: number }[] = [];
	const events: AtmEvent[] = [];
	for (const key of await listEventFiles(root, school)) {
		const text = await readFile(join(root, "schools", school, key), "utf8");
		const lines = text.split("\n").filter((l) => l.length > 0);
		files.push({ key, sha256: sha256Hex(text), lines: lines.length });
		for (const line of lines) events.push(JSON.parse(line) as AtmEvent);
	}
	events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const seen = new Set<string>();
	return {
		events: events.filter((e) => {
			if (seen.has(e.idem)) return false;
			seen.add(e.idem);
			return true;
		}),
		files,
	};
};

export type JournalRun = {
	build: AtmJournalBuild;
	written: string[];
	unchanged: boolean;
};

type BuildRecord = {
	months: Record<
		string,
		{
			inputs_hash: string;
			transactions: number;
			events: { key: string; sha256: string; lines: number }[];
		}
	>;
};

/**
 * `atm journal`: reads the school's events under `root`, writes the month's journal, `accounts.journal`,
 * `main.journal` and `ledger/build.json`. A file is rewritten only when its bytes would change, so a second run
 * writes nothing.
 */
export const journalMonth = async ({
	root,
	school,
	month,
}: {
	root: string;
	school: string;
	month: string;
}): Promise<JournalRun> => {
	const { events, files } = await readEvents(root, school);
	if (events.length === 0)
		throw new Error(
			`no events under ${join(root, "schools", school, "events")}`,
		);
	const build = buildJournal({ events, month });
	const prefix = join(root, "schools", school);
	const buildPath = join(prefix, "ledger/build.json");
	let record: BuildRecord = { months: {} };
	if (await exists(buildPath))
		record = JSON.parse(await readFile(buildPath, "utf8")) as BuildRecord;
	record.months[month] = {
		inputs_hash: build.inputsHash,
		transactions: build.transactions,
		events: files
			.filter((f) => f.key.startsWith(`events/date=${month}-`))
			.map(({ key, sha256, lines }) => ({ key, sha256, lines })),
	};
	record.months = Object.fromEntries(
		Object.entries(record.months).sort(([a], [b]) => (a < b ? -1 : 1)),
	);
	const out: Record<string, string> = {
		...build.files,
		"ledger/build.json": `${JSON.stringify(record, null, 2)}\n`,
	};
	const written: string[] = [];
	for (const [path, text] of Object.entries(out).sort(([a], [b]) =>
		a < b ? -1 : 1,
	)) {
		const full = join(prefix, path);
		const current = await readFile(full, "utf8").catch(() => null);
		if (current === text) continue;
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, text);
		written.push(path);
	}
	return { build, written, unchanged: written.length === 0 };
};
