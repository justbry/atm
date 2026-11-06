/**
 * A copy of a fixture's Stripe event for another family: every id the handler keys on gets a suffix, and the personal strings
 * (a name, an e-mail, an address) get one too, so a history can be repeated many times through the real handler without one
 * copy's ids meeting another's. Price and product ids and the school stay: they belong to the menu, not to a family.
 */
import type { BundleStep } from "../src/types.js";

/** Stripe's id prefixes that name an object of one customer's history. */
const ID_PATTERN =
	/\b(?:evt|in|il|ii|sub|si|cus|pi|ch|re|pyr|py|dp|po|txn|inpay|du|cs|fam|ipay|sched|pm|src|fee|ba|card|seti|cn|tr|trr)_[A-Za-z0-9_]+/g;

const PERSONAL_KEYS = new Set([
	"customer_email",
	"customer_name",
	"customer_phone",
	"email",
	"name",
	"phone",
	"line1",
	"line2",
	"city",
	"postal_code",
	"receipt_email",
	"description_name",
]);
const MIN_PERSONAL_LENGTH = 4;
/** A whole number in this range is read as a Unix time in seconds (2020 to 2036) and moves with the copy. */
const UNIX_SECONDS_FROM = 1_577_836_800;
const UNIX_SECONDS_TO = 2_100_000_000;

const suffixed = (text: string, suffix: string): string =>
	text.replace(ID_PATTERN, (id) => `${id}${suffix}`);

/** Walks a JSON value and rewrites its strings; the keys stay. */
const rewrite = (
	value: unknown,
	key: string | null,
	suffix: string,
	personal: boolean,
	shiftSeconds: number,
): unknown => {
	if (typeof value === "number")
		return Number.isInteger(value) &&
			value >= UNIX_SECONDS_FROM &&
			value < UNIX_SECONDS_TO
			? value + shiftSeconds
			: value;
	if (typeof value === "string") {
		if (personal && key !== null && PERSONAL_KEYS.has(key))
			return value.includes("@")
				? value.replace("@", `+${suffix.slice(1)}@`)
				: `${value} ${suffix.slice(1)}`;
		return suffixed(value, suffix);
	}
	if (Array.isArray(value))
		return value.map((item) =>
			rewrite(item, key, suffix, personal, shiftSeconds),
		);
	if (typeof value === "object" && value !== null)
		return Object.fromEntries(
			Object.entries(value).map(([name, inner]) => [
				name,
				rewrite(inner, name, suffix, personal, shiftSeconds),
			]),
		);
	return value;
};

/** `suffix` like `_c2`; the personal strings become `name c2` and `mail+c2@host`. */
export const cloneJson = <T>(
	value: T,
	suffix: string,
	options: { personal?: boolean; shiftSeconds?: number } = {},
): T =>
	rewrite(
		value,
		null,
		suffix,
		options.personal ?? true,
		options.shiftSeconds ?? 0,
	) as T;

/** The family-specific strings an event carries: names, e-mails, phone numbers, street, city, postal code. */
export const personalStringsOf = (value: unknown): string[] => {
	const found = new Set<string>();
	const visit = (inner: unknown, key: string | null) => {
		if (typeof inner === "string") {
			if (
				key !== null &&
				PERSONAL_KEYS.has(key) &&
				inner.length >= MIN_PERSONAL_LENGTH
			)
				found.add(inner);
		} else if (Array.isArray(inner)) for (const item of inner) visit(item, key);
		else if (typeof inner === "object" && inner !== null)
			for (const [name, item] of Object.entries(inner)) visit(item, name);
	};
	visit(value, null);
	return [...found];
};

/** A bundle step for another family: its event (when it has one), the family it names and the ids a later step refers to. */
export const cloneStep = (
	step: BundleStep,
	suffix: string,
	shiftMs: number,
): BundleStep => {
	const moved = { ...step, atMs: step.atMs + shiftMs };
	if ("event" in moved)
		return { ...moved, event: cloneJson(moved.event, suffix) };
	if ("family" in moved)
		return { ...moved, family: `${moved.family}${suffix}` } as BundleStep;
	return moved;
};
