/**
 * Sealed months: a signature over one month of a school's events, chained to the school's previous seal, so an edit or a
 * deletion in a sealed month breaks that seal. Spec: plans/atm-signed-receipts.md.
 *
 * A seal names the ids of the events it covers: the month's events in the folder when it was made. An event that reaches
 * the folder later (a late Stripe delivery, or an outbox row shipped after the seal) still lands in its month, so the
 * earlier seal keeps verifying, the event is listed as unsealed, and sealing the month again covers it. Membership is by
 * id, not by `ingest_time`, because the handler stamps `ingest_time` before the shipper puts the event in the folder.
 * Pure: the caller passes the time.
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
import { signText, verifySignedText } from "./sign.js";
import { canonicalize, sha256Hex } from "./util.js";

const MONTH = /^\d{4}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SEAL_KEYS = new Set([
	"v",
	"school",
	"month",
	"events",
	"event_ids",
	"transactions",
	"events_hash",
	"sealed_at",
	"prev_seal_hash",
]);
const SIGNED_KEYS = new Set(["seal", "key_id", "sig"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const checkInstant = (name: string, value: string): void => {
	if (!INSTANT.test(value) || Number.isNaN(Date.parse(value)))
		throw new Error(
			`${name} ${JSON.stringify(value)} is not a UTC ISO instant`,
		);
};

/** Ids in strictly increasing order: sorted, no repeat. */
const isIdList = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.every(
		(id, index) =>
			typeof id === "string" && (index === 0 || value[index - 1] < id),
	);

const monthEvents = (
	events: readonly AtmEvent[],
	school: string,
	month: string,
): AtmEvent[] =>
	events
		.filter((e) => e.school === school && e.date.startsWith(`${month}-`))
		.sort(byEventId);

/** What a seal records about the events it covers, given in id order. */
const counted = (covered: readonly AtmEvent[]) => ({
	events: covered.length,
	event_ids: covered.map((e) => e.id),
	transactions: covered.filter((e) => e.postings.length > 0).length,
	events_hash: sha256Hex(covered.map((e) => canonicalize(e)).join("\n")),
});

/** sha256 of a signed seal's canonical form: what the next seal's `prev_seal_hash` names. */
export const sealHash = (signed: unknown): string =>
	sha256Hex(canonicalize(signed));

/**
 * The seal of one month of a school's events: every event of the month in `events` (which may hold the whole log; the
 * month's are picked by `date`). Throws on a bad month or time.
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
	checkInstant("sealedAt", sealedAt);
	return {
		v: 1,
		school,
		month,
		...counted(monthEvents(events, school, month)),
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
	isIdList(value.event_ids) &&
	value.event_ids.length === value.events &&
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
	inMonthOf: (seal: AtmSeal) => readonly AtmEvent[],
	keys: AtmPublicKeys,
): AtmSealVerdict => {
	if (!isSignedSeal(signed)) return "malformed";
	const failure = verifySignedText(canonicalize(signed.seal), signed, keys);
	if (failure !== null) return failure;
	const expectedLink = index === 0 ? null : sealHash(previous);
	if (signed.seal.prev_seal_hash !== expectedLink) return "broken_link";
	const { seal } = signed;
	const byId = new Map(inMonthOf(seal).map((e) => [e.id, e]));
	const covered: AtmEvent[] = [];
	for (const id of seal.event_ids) {
		const event = byId.get(id);
		if (event === undefined) return "events_changed";
		covered.push(event);
	}
	const now = counted(covered);
	return now.events_hash === seal.events_hash &&
		now.transactions === seal.transactions
		? "ok"
		: "events_changed";
};

/**
 * Checks a school's seal chain, in the order the seals were made, against its events: each seal's shape, key and
 * signature, its link to the seal before it (a missing or reordered seal is `broken_link`), and the events it counted (an
 * edit or a deletion is `events_changed`). Lists the events of sealed months that their month's latest seal does not
 * cover (late, or inserted after it). Never throws on a bad seal.
 */
export const verifySeals = (
	seals: readonly unknown[],
	events: readonly AtmEvent[],
	keys: AtmPublicKeys,
): AtmSealReport => {
	// Each month's events are picked and sorted once, however many seals name the month.
	const byMonth = new Map<string, AtmEvent[]>();
	const inMonthOf = (seal: AtmSeal): AtmEvent[] => {
		const monthKey = `${seal.school}|${seal.month}`;
		let inMonth = byMonth.get(monthKey);
		if (inMonth === undefined) {
			inMonth = monthEvents(events, seal.school, seal.month);
			byMonth.set(monthKey, inMonth);
		}
		return inMonth;
	};
	const report: AtmSealReport["seals"] = seals.map((signed, index) => {
		const shaped = isSignedSeal(signed) ? signed.seal : null;
		return {
			index,
			month: shaped?.month ?? null,
			sealed_at: shaped?.sealed_at ?? null,
			verdict: verdictOf(signed, seals[index - 1], index, inMonthOf, keys),
		};
	});
	const latest = new Map<string, AtmSeal>();
	for (const signed of seals)
		if (isSignedSeal(signed))
			latest.set(`${signed.seal.school}|${signed.seal.month}`, signed.seal);
	const unsealedLate: AtmSealReport["unsealedLate"] = [];
	for (const seal of latest.values()) {
		const covered = new Set(seal.event_ids);
		for (const e of inMonthOf(seal))
			if (!covered.has(e.id))
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
