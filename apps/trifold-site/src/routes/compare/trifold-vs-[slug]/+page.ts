import { COMPETITORS } from "#lib/compare/competitors";
import type { EntryGenerator } from "./$types";

/** One page per entry in COMPETITORS. The page reads its entry itself; no load function, so no load code ships. */
export const entries: EntryGenerator = () =>
	COMPETITORS.map((competitor) => ({ slug: competitor.slug }));
