/**
 * Sealed months: a signature over one month of a school's events, chained to the school's previous seal, so an edit, a
 * deletion or a backdated insertion in a sealed month breaks that seal. Spec: plans/atm-signed-receipts.md.
 *
 * A seal counts only the month's events written at or before `sealed_at` (their `ingest_time`). A Stripe event delivered
 * after the seal still lands in its month (its `date` follows `event_time`), so the earlier seal keeps verifying, the event
 * is reported as unsealed and late, and sealing the month again covers it. Pure: the caller passes the time.
 */
import type {
	AtmEvent,
	AtmPublicKeys,
	AtmSeal,
	AtmSealReport,
	AtmSealVerdict,
	AtmSignedSeal,
	AtmSigner,
} from "../types.js";
import { byEventId } from "./order.js";
import { signText, verifyText } from "./sign.js";
import { canonicalize, sha256Hex } from "./util.js";

const MONTH = /^\d{4}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SEAL_KEYS = new Set([
	"v",
	"school",
	"month",
	"events",
	"transactions",
	"events_hash",
	"sealed_at",
	"prev_seal_hash",
]);
const SIGNED_KEYS = new Set(["seal", "key_id", "sig"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const instantMs = (name: string, value: string): number => {
	const ms = Date.parse(value);
	if (!INSTANT.test(value) || Number.isNaN(ms))
		throw new Error(
			`${name} ${JSON.stringify(value)} is not a UTC ISO instant`,
		);
	return ms;
};

const monthEvents = (
	events: readonly AtmEvent[],
	school: string,
	month: string,
): AtmEvent[] =>
	events
		.filter((e) => e.school === school && e.date.startsWith(`${month}-`))
		.sort(byEventId);

/** What a seal with this cutoff counts: the month's events written at or before it. */
const counted = (
	events: readonly AtmEvent[],
	school: string,
	month: string,
	cutoffMs: number,
) => {
	const included = monthEvents(events, school, month).filter(
		(e) => Date.parse(e.ingest_time) <= cutoffMs,
	);
	return {
		events: included.length,
		transactions: included.filter((e) => e.postings.length > 0).length,
		events_hash: sha256Hex(included.map((e) => canonicalize(e)).join("\n")),
	};
};

/** sha256 of a signed seal's canonical form: what the next seal's `prev_seal_hash` names. */
export const sealHash = (signed: unknown): string =>
	sha256Hex(canonicalize(signed));

/**
 * The seal of one month of a school's events. `events` may hold the whole log: the month's are picked by `date`. Throws
 * when a month event was written after `sealedAt` (the caller is sealing before it was written), or on a bad month or time.
 */
export const sealOf = ({
	school,
	month,
	events,
	sealedAt,
	previous,
}: {
	school: string;
	month: string;
	events: readonly AtmEvent[];
	sealedAt: string;
	previous: AtmSignedSeal | null;
}): AtmSeal => {
	if (!MONTH.test(month))
		throw new Error(`month must be YYYY-MM, got ${month}`);
	const cutoffMs = instantMs("sealedAt", sealedAt);
	const later = monthEvents(events, school, month).find(
		(e) => Date.parse(e.ingest_time) > cutoffMs,
	);
	if (later)
		throw new Error(
			`event ${later.id} was written at ${later.ingest_time}, after sealedAt ${sealedAt}`,
		);
	return {
		v: 1,
		school,
		month,
		...counted(events, school, month, cutoffMs),
		sealed_at: sealedAt,
		prev_seal_hash: previous === null ? null : sealHash(previous),
	};
};

/** Signs a seal: Ed25519 over `canonicalize(seal)`. */
export const signSeal = (seal: AtmSeal, signer: AtmSigner): AtmSignedSeal => ({
	seal,
	key_id: signer.keyId,
	sig: signText(canonicalize(seal), signer),
});

const isSealShape = (value: unknown): value is AtmSeal =>
	isRecord(value) &&
	Object.keys(value).every((key) => SEAL_KEYS.has(key)) &&
	value.v === 1 &&
	typeof value.school === "string" &&
	typeof value.month === "string" &&
	MONTH.test(value.month) &&
	Number.isSafeInteger(value.events) &&
	Number.isSafeInteger(value.transactions) &&
	typeof value.events_hash === "string" &&
	SHA256_HEX.test(value.events_hash) &&
	typeof value.sealed_at === "string" &&
	INSTANT.test(value.sealed_at) &&
	(value.prev_seal_hash === null ||
		(typeof value.prev_seal_hash === "string" &&
			SHA256_HEX.test(value.prev_seal_hash)));

/** Whether `value` has the shape of a signed seal, with no field missing, extra or of the wrong type. */
export const isSignedSeal = (value: unknown): value is AtmSignedSeal =>
	isRecord(value) &&
	Object.keys(value).every((key) => SIGNED_KEYS.has(key)) &&
	typeof value.key_id === "string" &&
	typeof value.sig === "string" &&
	isSealShape(value.seal);

const verdictOf = (
	signed: unknown,
	previous: unknown,
	index: number,
	events: readonly AtmEvent[],
	keys: AtmPublicKeys,
): AtmSealVerdict => {
	if (!isSignedSeal(signed)) return "malformed";
	const publicKeyPem = Object.hasOwn(keys, signed.key_id)
		? keys[signed.key_id]
		: undefined;
	if (publicKeyPem === undefined) return "unknown_key";
	if (!verifyText(canonicalize(signed.seal), signed.sig, publicKeyPem))
		return "bad_signature";
	const expectedLink = index === 0 ? null : sealHash(previous);
	if (signed.seal.prev_seal_hash !== expectedLink) return "broken_link";
	const { seal } = signed;
	const now = counted(
		events,
		seal.school,
		seal.month,
		Date.parse(seal.sealed_at),
	);
	return now.events_hash === seal.events_hash &&
		now.events === seal.events &&
		now.transactions === seal.transactions
		? "ok"
		: "events_changed";
};

/**
 * Checks a school's seal chain, in the order the seals were made, against its events: each seal's shape, key and
 * signature, its link to the seal before it (a missing or reordered seal is `broken_link`), and the events it counted (an
 * edit, a deletion or a backdated insertion is `events_changed`). Lists the events of sealed months written after their
 * month's latest seal. Never throws on a bad seal.
 */
export const verifySeals = (
	seals: readonly unknown[],
	events: readonly AtmEvent[],
	keys: AtmPublicKeys,
): AtmSealReport => {
	const report: AtmSealReport["seals"] = seals.map((signed, index) => {
		const shaped = isSignedSeal(signed) ? signed.seal : null;
		return {
			index,
			month: shaped?.month ?? null,
			sealed_at: shaped?.sealed_at ?? null,
			verdict: verdictOf(signed, seals[index - 1], index, events, keys),
		};
	});
	const latest = new Map<string, AtmSeal>();
	for (const signed of seals)
		if (isSignedSeal(signed))
			latest.set(`${signed.seal.school}|${signed.seal.month}`, signed.seal);
	const unsealedLate: AtmSealReport["unsealedLate"] = [];
	for (const seal of latest.values()) {
		const cutoffMs = Date.parse(seal.sealed_at);
		for (const e of monthEvents(events, seal.school, seal.month))
			if (Date.parse(e.ingest_time) > cutoffMs)
				unsealedLate.push({
					month: seal.month,
					event_id: e.id,
					ingest_time: e.ingest_time,
				});
	}
	return {
		ok: report.every((s) => s.verdict === "ok"),
		seals: report,
		unsealedLate,
	};
};
