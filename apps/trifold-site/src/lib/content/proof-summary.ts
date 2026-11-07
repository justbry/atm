/**
 * The part of src/lib/content/proof.ts the homepage shows (the three-way diagram and the verticals line), kept apart so
 * the homepage doesn't ship the rest of the proof page's text. proof.ts re-exports it, so other pages import from there.
 */

/** One sample school year (growth-12mo, seed 7) through the engine, hledger and DuckDB: the same KPI hash from each. */
export const SEED_7_HASH =
	"19f08b808b15d1fce659314f23067a48424b1dc16d51e2a3e79c599a673b7d48";
/** The hash as the diagram prints it: first eight and last four characters. */
export const SEED_7_HASH_SHORT = `${SEED_7_HASH.slice(0, 8)}…${SEED_7_HASH.slice(-4)}`;
export const SEED_7_EVENTS = 1964;

/** The one line that ties the verticals together. */
export const UNIFIED_LINE =
	"Same engine, same proof. Every vertical is a seeded scenario, and its KPI hashes match across the engine, hledger and DuckDB.";
