/**
 * Reading a SQLite database as bytes, for the tests that prove a string is nowhere in it: the main file, the write-ahead
 * log and the shared-memory file, whichever of them exist. A string kept in a table, in an index, in a freed page or in the
 * log all show up here.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";

const SIDE_FILES = ["", "-wal", "-journal"] as const;

/** The bytes of the database file and of its `-wal` and `-journal` files, joined. */
export const databaseBytes = (path: string): Buffer =>
	Buffer.concat(
		SIDE_FILES.map((suffix) => `${path}${suffix}`)
			.filter((file) => existsSync(file))
			.map((file) => readFileSync(file)),
	);

/** The strings among `needles` that occur in the bytes. */
export const foundIn = (bytes: Buffer, needles: Iterable<string>): string[] =>
	[...needles].filter((needle) => bytes.includes(needle));

/** Opens a database in write-ahead log mode, so that a write is first in the `-wal` file, as in the family service. */
export const walMode = (raw: Database): Database => {
	raw.exec("PRAGMA journal_mode = WAL");
	// keep the log: nothing is folded into the main file until the test says so
	raw.exec("PRAGMA wal_autocheckpoint = 0");
	return raw;
};

const MIN_LENGTH = 6;
/** Plain lower-case words (enums) and bare digits (a scrubbed postal code is `00000`, which any page of numbers contains). */
const PLAIN_WORD = /^([a-z_]+|[0-9 -]+)$/;
const PERSONAL_PARENTS = [
	"customer_details",
	"billing_details",
	"shipping",
	"customer_address",
	"customer_shipping",
	"collected_information",
	"evidence",
	"payment_method_details",
	"payment_method",
] as const;
const PERSONAL_KEYS = new Set([
	"customer_name",
	"customer_email",
	"customer_phone",
	"email",
	"phone",
	"line1",
	"line2",
	"city",
	"postal_code",
	"last4",
	"fingerprint",
	"receipt_url",
	"receipt_email",
	"hosted_invoice_url",
	"invoice_pdf",
	"account_name",
	"individual_name",
	"business_name",
]);

/**
 * The personal strings of a Stripe payload, computed from it: the values at the keys that hold a name, an email, an address,
 * a phone, a card detail or a link, the values under a parent that holds them, and any string with an `@` or a `://`. Plain
 * lower-case words and short codes (`card`, `US`) are left out: they are enums, not people.
 */
export const personalStringsOf = (
	value: unknown,
	into = new Set<string>(),
	path: readonly string[] = [],
): Set<string> => {
	if (typeof value === "string") {
		const key = path.at(-1) ?? "";
		const personal =
			PERSONAL_KEYS.has(key) ||
			path.some((part) =>
				(PERSONAL_PARENTS as readonly string[]).includes(part),
			) ||
			value.includes("@") ||
			value.includes("://");
		if (personal && value.length >= MIN_LENGTH && !PLAIN_WORD.test(value))
			into.add(value);
		return into;
	}
	if (Array.isArray(value))
		for (const item of value) personalStringsOf(item, into, path);
	else if (typeof value === "object" && value !== null)
		for (const [key, item] of Object.entries(value))
			personalStringsOf(item, into, [...path, key]);
	return into;
};
