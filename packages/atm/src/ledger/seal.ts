import type {
	AtmEvent,
	AtmPublicKeys,
	AtmSeal,
	AtmSignedSeal,
	AtmSigner,
	SealOfInput,
	SealReport,
} from "../types.js";
import { sealSchema } from "./schemas.js";
import { shapeCheck, signBytes, verifyBytes } from "./sign.js";
import { canonicalize, sha256Hex } from "./util.js";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** An instant as epoch ms; ISO text is not compared as text, because `...:01Z` sorts after `...:01.713Z`. */
const instant = (text: string, what: string): number => {
	const ms = Date.parse(text);
	if (Number.isNaN(ms))
		throw new Error(`${what} is not an ISO instant: ${text}`);
	return ms;
};

const monthEvents = (events: readonly AtmEvent[], month: string) =>
	events.filter((e) => e.date.startsWith(`${month}-`));

/** What a seal counts: the month's events written by `cutoff`, sorted by id, as `buildJournal` hashes them. */
const counted = (events: readonly AtmEvent[], cutoff: number) => {
	const inSeal = events
		.filter((e) => Date.parse(e.ingest_time) <= cutoff)
		.sort((a, b) => (a.id < b.id ? -1 : 1));
	return {
		events: inSeal.length,
		transactions: inSeal.filter((e) => e.postings.length > 0).length,
		events_hash: sha256Hex(inSeal.map((e) => canonicalize(e)).join("\n")),
	};
};

/** What the next seal in the chain names as `prev_seal_hash`. */
const sealHash = (signed: unknown): string => sha256Hex(canonicalize(signed));

/**
 * The seal of one month of a school's events at `sealedAt`, chained to `previous` (the school's last signed seal). A
 * month may be sealed again later, to cover events that arrived after its last seal. Throws when the month has an event
 * written after `sealedAt` (the caller is sealing before it was written), and on a bad month or instant. Pure.
 */
export const sealOf = ({
	school,
	month,
	events,
	sealedAt,
	previous,
}: SealOfInput): AtmSeal => {
	if (!MONTH.test(month))
		throw new Error(`month must be YYYY-MM, got ${month}`);
	const cutoff = instant(sealedAt, "sealedAt");
	if (previous && previous.seal.school !== school)
		throw new Error(
			`the previous seal is school ${previous.seal.school}'s, not ${school}'s`,
		);
	const inMonth = monthEvents(events, month);
	const late = inMonth.find(
		(e) => instant(e.ingest_time, `${e.id} ingest_time`) > cutoff,
	);
	if (late)
		throw new Error(
			`event ${late.id} of ${month} was written at ${late.ingest_time}, after sealedAt ${sealedAt}`,
		);
	return {
		v: 1,
		school,
		month,
		...counted(inMonth, cutoff),
		sealed_at: sealedAt,
		prev_seal_hash: previous ? sealHash(previous) : null,
	};
};

/** The seal signed with Ed25519 over `canonicalize(seal)`. Throws naming the key type when the key is not Ed25519. */
export const signSeal = (seal: AtmSeal, signer: AtmSigner): AtmSignedSeal => ({
	seal,
	key_id: signer.keyId,
	sig: signBytes(canonicalize(seal), signer),
});

const isSignedSeal = shapeCheck(sealSchema);

type Verdict = SealReport["seals"][number]["verdict"];

const textOr = (value: unknown, key: string): string => {
	const field =
		typeof value === "object" && value !== null
			? (value as { seal?: Record<string, unknown> }).seal?.[key]
			: undefined;
	return typeof field === "string" ? field : "";
};

/**
 * A school's seal chain, in the order the seals were made, against its events (one per `idem`). For each seal: its shape
 * and signature, then its link to the seal before it (a missing or reordered seal is `broken_link`), then its counts
 * and `events_hash` again at its own `sealed_at` (an edit, deletion or backdated insertion is `events_changed`). A month
 * event written after the month's latest valid seal is listed in `unsealedLate`, not counted as tampering. Never throws
 * on a bad seal.
 */
export const verifySeals = (
	seals: readonly unknown[],
	events: readonly AtmEvent[],
	keys: AtmPublicKeys,
): SealReport => {
	const latest = new Map<string, number>();
	const rows = seals.map((raw, index) => {
		const row = (verdict: Verdict) => ({
			month: textOr(raw, "month"),
			sealed_at: textOr(raw, "sealed_at"),
			verdict,
		});
		if (!isSignedSeal(raw)) return row("malformed");
		const { seal, key_id, sig } = raw as AtmSignedSeal;
		const signature = verifyBytes(canonicalize(seal), key_id, sig, keys);
		if (signature !== "ok") return row(signature);
		const cutoff = Date.parse(seal.sealed_at);
		latest.set(seal.month, Math.max(latest.get(seal.month) ?? 0, cutoff));
		const expected = index === 0 ? null : sealHash(seals[index - 1]);
		if (seal.prev_seal_hash !== expected) return row("broken_link");
		const again = counted(monthEvents(events, seal.month), cutoff);
		const same =
			again.events === seal.events &&
			again.transactions === seal.transactions &&
			again.events_hash === seal.events_hash;
		return row(same ? "ok" : "events_changed");
	});
	const unsealedLate = [...latest]
		.flatMap(([month, cutoff]) =>
			monthEvents(events, month)
				.filter((e) => Date.parse(e.ingest_time) > cutoff)
				.map((e) => ({ month, event_id: e.id, ingest_time: e.ingest_time })),
		)
		.sort((a, b) =>
			a.month === b.month
				? a.event_id < b.event_id
					? -1
					: 1
				: a.month < b.month
					? -1
					: 1,
		);
	return {
		ok: rows.every((r) => r.verdict === "ok"),
		seals: rows,
		unsealedLate,
	};
};
