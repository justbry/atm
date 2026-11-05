import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateMulti } from "./vibes-multi.js";
import { batchEvents, eventLines } from "./write.js";

/**
 * Writes one seed of the twelve-family fixture under `outDir`: the event batches (`batchEvents`, as the first fixture's), the
 * late batch under its day, `expected.json` and `catalog.json`. The late event is not in the ordinary batches; the late batch
 * also carries a second delivery of an event the day already holds. Returns the paths written.
 */
export const writeMultiFixture = async ({
	seed,
	outDir,
}: {
	seed: number;
	outDir: string;
}): Promise<string[]> => {
	const fixture = generateMulti({ seed });
	const lateIds = new Set(fixture.late.map((event) => event.id));
	const files: Record<string, string> = {
		"expected.json": `${JSON.stringify(fixture.expected, null, 2)}\n`,
		"catalog.json": `${JSON.stringify(fixture.catalog, null, 2)}\n`,
	};
	for (const [key, list] of batchEvents(
		fixture.events.filter((event) => !lateIds.has(event.id)),
	))
		files[key] = eventLines(list);
	files[fixture.expected.late.file] = eventLines(
		[...fixture.late, ...fixture.lateDuplicates].sort((a, b) =>
			a.id < b.id ? -1 : 1,
		),
	);
	for (const [path, text] of Object.entries(files)) {
		const full = join(outDir, path);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, text);
	}
	return Object.keys(files).sort();
};
