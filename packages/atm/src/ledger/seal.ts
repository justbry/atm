// SPDX-License-Identifier: Apache-2.0
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

const checkInstant = (text: string, what: string): void => {
	if (Number.isNaN(Date.parse(text)))
		throw new Error(`${what} is not an ISO instant: ${text}`);
};

const monthEvents = (events: readonly AtmEvent[], month: string) =>
	events.filter((e) => e.date.startsWith(`${month}-`));

/** The events of each `YYYY-MM` month by id, built once for a whole chain. */
const eventsByMonth = (events: readonly AtmEvent[]) => {
	const months = new Map<string, Map<string, AtmEvent>>();
	for (const event of events) {
		// As `monthEvents` reads it: the `YYYY-MM` before the day's "-".
		if (event.date[7] !== "-") continue;
		const month = event.date.slice(0, 7);
		const byEventId = months.get(month) ?? new Map<string, AtmEvent>();
		byEventId.set(event.id, event);
		months.set(month, byEventId);
	}
	return months;
};

const byId = (a: AtmEvent, b: AtmEvent) => (a.id < b.id ? -1 : 1);

/** What a seal records about the events it covers, given sorted by id: `events_hash` as `buildJournal` hashes them. */
const counted = (covered: readonly AtmEvent[]) => ({
	events: covered.length,
	event_ids: covered.map((e) => e.id),
	transactions: covered.filter((e) => e.postings.length > 0).length,
	events_hash: sha256Hex(covered.map((e) => canonicalize(e)).join("\n")),
});

/** What the next seal in the chain names as `prev_seal_hash`. */
const sealHash = (signed: unknown): string => sha256Hex(canonicalize(signed));

/**
 * The seal of one month of a school's events, chained to `previous` (the school's last signed seal). It covers every event
 * of the month in `events` and names them by id, so membership never depends on `ingest_time`: the handler stamps that
 * before `atm ship` puts the event in the folder, so an event stamped before a seal can arrive after it. A month may be
 * sealed again later, to cover events that arrived after its last seal. Throws on a bad month or instant, and when two
 * of the month's events share an id (the seal could not name them apart, so `verifySeals` would call it malformed). Pure.
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
	checkInstant(sealedAt, "sealedAt");
	if (previous && previous.seal.school !== school)
		throw new Error(
			`the previous seal is school ${previous.seal.school}'s, not ${school}'s`,
		);
	const covered = monthEvents(events, month).sort(byId);
	const repeated = covered.find(
		(event, index) => index > 0 && covered[index - 1]?.id === event.id,
	);
	if (repeated)
		throw new Error(`two events of ${month} share the id ${repeated.id}`);
	return {
		v: 1,
		school,
		month,
		...counted(covered),
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

const matchesSchema = shapeCheck(sealSchema);

/** The schema, plus what it cannot say: `event_ids` strictly increasing (sorted, no repeat) and as many as `events`. */
const isSignedSeal = (value: unknown): value is AtmSignedSeal => {
	if (!matchesSchema(value)) return false;
	const { event_ids: ids, events } = (value as AtmSignedSeal).seal;
	return (
		ids.length === events &&
		ids.every((id, index) => index === 0 || (ids[index - 1] as string) < id)
	);
};

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
 * and signature, then its link to the seal before it (a missing or reordered seal is `broken_link`), then the events it
 * names, by id, hashed and counted again (an edit or a deletion is `events_changed`). A month event not named by the
 * month's latest seal with a good signature (its own verdict aside) is listed in `unsealedLate`, not counted as
 * tampering: atm cannot tell a late delivery from an insertion. Never throws on a bad seal.
 */
export const verifySeals = (
	seals: readonly unknown[],
	events: readonly AtmEvent[],
	keys: AtmPublicKeys,
): SealReport => {
	const months = eventsByMonth(events);
	const latest = new Map<string, AtmSeal>();
	const rows = seals.map((raw, index) => {
		const row = (verdict: Verdict) => ({
			month: textOr(raw, "month"),
			sealed_at: textOr(raw, "sealed_at"),
			verdict,
		});
		if (!isSignedSeal(raw)) return row("malformed");
		const { seal, key_id, sig } = raw;
		const signature = verifyBytes(canonicalize(seal), key_id, sig, keys);
		if (signature !== "ok") return row(signature);
		latest.set(seal.month, seal);
		const expected = index === 0 ? null : sealHash(seals[index - 1]);
		if (seal.prev_seal_hash !== expected) return row("broken_link");
		const inMonth = months.get(seal.month);
		const covered = seal.event_ids.map((id) => inMonth?.get(id));
		if (covered.some((e) => e === undefined)) return row("events_changed");
		const again = counted(covered as AtmEvent[]);
		const same =
			again.transactions === seal.transactions &&
			again.events_hash === seal.events_hash;
		return row(same ? "ok" : "events_changed");
	});
	const unsealedLate = [...latest.values()]
		.flatMap((seal) => {
			const named = new Set(seal.event_ids);
			return [...(months.get(seal.month)?.values() ?? [])]
				.filter((e) => !named.has(e.id))
				.map((e) => ({
					month: seal.month,
					event_id: e.id,
					ingest_time: e.ingest_time,
				}));
		})
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
