// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

/** JSON with every object's keys sorted, so the same value is always the same bytes. */
export const canonicalize = (value: unknown): string =>
	JSON.stringify(sortKeys(value));

const sortKeys = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => [k, sortKeys(v)]),
		);
	}
	return value;
};

export const sha256Hex = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

/** Instants are UTC ISO 8601 with `Z` and whole seconds when they have no milliseconds. */
export const isoInstant = (ms: number): string => {
	const text = new Date(ms).toISOString();
	return text.endsWith(".000Z") ? `${text.slice(0, -5)}Z` : text;
};

const dateParts = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` of an instant in an IANA time zone. DST comes from the zone rules, never an offset. */
export const localDate = (ms: number, tz: string): string => {
	let format = dateParts.get(tz);
	if (!format) {
		format = new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		dateParts.set(tz, format);
	}
	const parts = Object.fromEntries(
		format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
	);
	return `${parts.year}-${parts.month}-${parts.day}`;
};

/** Whole credits are printed as integers; credit commodities have no decimal places. */
export const unitsToString = (n: number): string => {
	if (!Number.isInteger(n)) {
		throw new Error(`credits are whole units; got ${n}`);
	}
	return String(n === 0 ? 0 : n);
};

/** Integer cents to a USD decimal string with two places: 13000 -> "130.00". */
export const centsToString = (cents: number): string => {
	if (!Number.isInteger(cents))
		throw new Error(`cents must be whole: ${cents}`);
	const sign = cents < 0 ? "-" : "";
	const abs = Math.abs(cents);
	return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

/** A decimal string to an integer count of the smallest unit (`places` decimal places); throws on more places. */
export const decimalToUnits = (text: string, places: number): bigint => {
	const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
	if (!m) throw new Error(`not a decimal string: ${JSON.stringify(text)}`);
	const frac = m[3] ?? "";
	if (frac.length > places && /[1-9]/.test(frac.slice(places))) {
		throw new Error(`${text} has more than ${places} decimal places`);
	}
	const padded = frac.slice(0, places).padEnd(places, "0");
	const units = BigInt(`${m[2]}${padded}`);
	return m[1] === "-" ? -units : units;
};

export const unitsToDecimal = (units: bigint, places: number): string => {
	const sign = units < 0n ? "-" : "";
	const abs = units < 0n ? -units : units;
	if (places === 0) return `${sign}${abs}`;
	const s = abs.toString().padStart(places + 1, "0");
	return `${sign}${s.slice(0, -places)}.${s.slice(-places)}`;
};
