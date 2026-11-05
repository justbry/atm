/**
 * Reference webhook handler for the family service: one Stripe webhook in, rows and decision events out, on a
 * synchronous SQLite the caller owns. For Bun and Node.
 *
 *   verify signature -> claim the Stripe event id (stale-claim takeover) -> in ONE transaction:
 *     load the subject's rows -> handleStripeEvent -> write rows (revision-checked) -> events into the outbox
 *     -> invoice index (and the caller's payment refs) -> claim done
 *
 *   invoice_payment.paid: the same verify and claim, then in ONE transaction: normalise -> the invoice must be in the
 *     invoice index -> payment index (payment intent and charge -> invoice) -> claim done. It decides nothing and moves
 *     no credits; it only records which payment paid which invoice.
 *
 * Decisions
 *
 * - One endpoint, one school. `deps.secret` proves only which Stripe account sent the event; the `b4u_school` in its
 *   metadata is that account's claim, and `deps.context` answers for every school the service serves. So the handler
 *   takes the school the endpoint and its secret belong to (`deps.schoolId`) and refuses, with 422 `school_mismatch`
 *   before any claim (or releasing it, for `invoice_payment.paid`) and writing nothing, any event whose school is
 *   another: from the metadata of an `invoice.paid` or `customer.subscription.*`, or from the subject the invoice
 *   index names for a refund, a dispute or an `invoice_payment.paid`. Serve each school from its own endpoint.
 * - The handler sets no limit on the body's size. The caller must cap the raw body (say 1 MiB; Stripe's events are
 *   far smaller) before it is read into memory and HMACed here.
 * - The claim is its own short transaction, so a second delivery sees it at once. Its `done` state is written only in
 *   the transaction that wrote the rows. A crash before commit leaves rows and outbox as they were and the claim
 *   `claimed`; a later delivery takes it over once it is older than `claimStaleAfterMs`, with a compare-and-set
 *   UPDATE on the stale `claimed_at` (one taker wins, the other answers busy). The transaction starts by checking the
 *   claim is still this worker's, and ends by marking it done with the same check, so a worker that stalled past the
 *   window cannot commit over the one that took over.
 * - A thrown error (the context, the database, a bug) is not caught: it propagates and the claim stays `claimed`,
 *   exactly as for a crash. The caller answers 500 and Stripe retries.
 * - Live balances stay in the caller's SQLite (`atm_rows`). Decision events go to `ledger_outbox` in the same
 *   transaction; `body` is the event's canonical line, fixed at insert, and the insert is ON CONFLICT
 *   (school_id, idem) DO NOTHING. The table's primary key (school_id, id) is not that target, and SQLite aborts on
 *   it; that is deliberate. An event's id is `deterministicUlid` of its instant, its revision and a 56-bit hash of
 *   (school, idem), so the same id under another idem takes a hash collision at the same millisecond and revision.
 *   Were it to happen, a throw (500, retry) is right; `INSERT OR IGNORE` would silently drop a distinct decision.
 * - The revision is read and checked inside the write transaction (`BEGIN IMMEDIATE` in `bunSqlite`), so a conflict
 *   cannot happen on one SQLite file; the check and the 3 attempts are for drivers whose transactions are not
 *   exclusive. After 3 stale attempts the claim is released and the answer is 409.
 * - The Stripe event id is deduplicated here; `handleStripeEvent` gets a ULID derived from the school and that id
 *   and the event's `created`, so the same delivery always decides the same way.
 * - A refund or dispute names its charge and payment intent, never the invoice, and the webhook's invoice names no
 *   payment (API 2025-10-29.clover). The link comes from `invoice_payment.paid`, whose object has the `invoice` and the
 *   payment (`{ type: 'payment_intent', payment_intent }`, or `{ type: 'charge', charge }`). Two indexes, both written
 *   in the transaction of the event that teaches them:
 *     atm_invoice_index  invoice id -> subject   when an `invoice.paid` is applied (it carries the family's metadata)
 *     atm_payment_index  payment intent / charge id -> invoice id   when an `invoice_payment.paid` is handled
 *   A refund or dispute joins the two: payment ref -> invoice -> subject, and passes `invoiceIds` to
 *   `handleStripeEvent`, which checks the invoice is one this holder was paid. When its payment intent and its charge
 *   lead to different subjects, nothing says which is right: 422 `ambiguous_payment`, before any claim.
 * - `invoice_payment.paid` and `invoice.paid` can arrive in either order (Stripe does not promise one). The two orders
 *   and the refund's, where each waits for what it needs (a wait is a 409 and no claim, so Stripe retries):
 *
 *     arrives                      invoice indexed?  payment indexed?  answer
 *     invoice.paid                 -                 -                 200 applied; the invoice is indexed
 *     invoice_payment.paid         yes               -                 200 applied; the payment is indexed
 *     invoice_payment.paid         no                -                 409 `unmatched_invoice`; retry after invoice.paid
 *     refund / dispute             -                 yes               decided as `handleStripeEvent` says
 *     refund / dispute             -                 no                409 `unmatched_payment`; retry after the link
 *
 * - Another product on the same Stripe account. An `invoice.paid` or `customer.subscription.*` with neither
 *   `b4u_school` nor `family_id` in its metadata is not a family's: 200 `ignored`, recorded done (its metadata cannot
 *   change, so a retry could never decide otherwise). Half of them (one key, or an empty value) is a broken checkout:
 *   422 `missing_metadata`. But an `invoice_payment.paid`, refund or dispute names no family, and the invoice it
 *   leads to is never indexed when its `invoice.paid` was ignored, so it keeps the retryable 409 (`unmatched_invoice`,
 *   `unmatched_payment`): it cannot tell "not ours" from "ours, not linked yet", and a 200 there would lose a real
 *   family's refund that came early. Stripe retries a non-2xx in live mode with backoff for up to three days, emails
 *   the account about a failing endpoint and may disable it. So the deployer should give this endpoint only the
 *   event types above (Stripe's "enabled events"), and a Stripe account whose other products have many payments,
 *   refunds or disputes should keep the families on their own account.
 * - `deps.paymentRefs` is optional now: refs it names for an `invoice.paid` are written to `atm_payment_index` with the
 *   invoice's rows, so callers that already know the payment (an expanded invoice, their own records) keep working.
 *   Only its non-empty strings are used. `invoice.payments` is read too when the event came expanded.
 *
 * Answers (Stripe retries every non-2xx for up to three days)
 *
 *   200 applied            rows, outbox and claim done committed (also when the event changes nothing)
 *   200 duplicate          the Stripe event id is already done; nothing else is touched
 *   200 ignored            an event type we do not map, with no claim recorded (a later version that maps it takes the
 *                          owner's re-send); or an invoice / subscription event with no family metadata, recorded done
 *   400 bad_request        the body is not a Stripe event
 *   401 bad_signature      nothing is touched
 *   409 busy               another worker holds a fresh claim (or took it over); Stripe will retry
 *   409 unmatched_payment  a refund or dispute whose payment is not linked to an invoice yet (its
 *                          invoice_payment.paid, or the invoice itself, may not be handled yet)
 *   409 unmatched_invoice  an invoice_payment.paid whose invoice is not indexed (its invoice.paid is not handled yet)
 *   409 stale_revision     3 attempts lost the revision race
 *   409 refused            `unmatched_invoice`, `unknown_subscription`: the cause may arrive on its own, retry
 *   422 refused            `unmatched_line`, `missing_metadata`, `unknown_mapping`, `bad_event`, `rejected`;
 *                          and 422 `unknown_school` when `context` returns null: a human has to fix something
 *   422 school_mismatch    the event's school is not `deps.schoolId`
 *   422 ambiguous_payment  a refund or dispute whose payment intent and charge lead to different subjects
 *
 * A refused event never keeps its claim, and nothing is written for it. What decides a refusal (the menu, the code's
 * mappings, the school's configuration) changes by a human's hand, and the owner then re-sends the same Stripe event
 * from the dashboard; a `done` claim would answer that with `duplicate` and the credits would never be granted. The
 * price is that Stripe keeps retrying a 422 until it gives up, which is the nudge we want. Only `applied` and a
 * family-less `ignored` are `done`.
 *
 * Not here, on purpose: no R2 writes, no shipper from the outbox to R2 batches, no compare-and-swap per subject on
 * R2, no Worker version (the ledger's schema validation uses ajv, which compiles with `new Function`, and Workers
 * refuse that).
 *
 * For the owner to review: the 422 versus 409 split above; releasing the claim on every refusal; 409 for a refund of
 * an unknown payment (a charge that is not ours retries until Stripe gives up), and the same for an
 * `invoice_payment.paid` of an unknown invoice (see "Another product" above); one attempt
 * budget (3) for stale revisions; `now` for the engine is the event's `created`, in whole seconds.
 */
import { resolveEnv } from "../billing/env.js";
import { handleStripeEvent } from "../billing/handle.js";
import {
	describeNormalizeError,
	mappingFor,
	normalize,
} from "../billing/normalize.js";
import { type BillingRow, StaleRevision, subjectKey } from "../billing/rows.js";
import { deterministicUlid } from "../ledger/ids.js";
import { canonicalize } from "../ledger/util.js";
import type {
	BillingInvoice,
	InvoicePaymentFact,
	RowChanges,
	StripeEventRefusal,
} from "../types.js";
import { verifyStripeSignature } from "./stripe-signature.js";
import type {
	SqlDatabase,
	WebhookDeps,
	WebhookOutcome,
	WebhookRequest,
	WebhookResponse,
} from "./types.js";

const DEFAULT_CLAIM_STALE_AFTER_MS = 300_000;
const MAX_ATTEMPTS = 3;
const SUBSCRIPTION_EVENT_PREFIX = "customer.subscription.";
const INVOICE_PAYMENT_EVENT = "invoice_payment.paid";
const HANDLED_TYPES: ReadonlySet<string> = new Set([
	"invoice.paid",
	INVOICE_PAYMENT_EVENT,
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"charge.refunded",
	"charge.dispute.created",
	"charge.dispute.closed",
]);
const RETRYABLE_REFUSALS: ReadonlySet<StripeEventRefusal["reason"]> = new Set([
	"unmatched_invoice",
	"unknown_subscription",
]);

type JsonObject = Record<string, unknown>;

type StripeEvent = {
	id: string;
	type: string;
	created: number;
	object: JsonObject;
	raw: unknown;
};

/** Where the claim stands for this worker: both values identify it, a takeover changes `claimedAt`. */
type Claim = { claimedAt: number };

/** The worker no longer holds its claim (taken over after a stall); everything it wrote is rolled back. */
class ClaimLost extends Error {
	override name = "ClaimLost";
}

type Located =
	| { kind: "subject"; subjectKey: string; invoiceIds: Record<string, string> }
	| { kind: "ignored" }
	| { kind: "missing_metadata"; message: string }
	| { kind: "school_mismatch"; school: string }
	| { kind: "ambiguous_payment"; message: string }
	| { kind: "unmatched_payment"; message: string };

type Applied =
	| { kind: "applied"; events: number; wroteRows: boolean }
	| { kind: "unknown_school" }
	| { kind: "refused"; refusal: StripeEventRefusal };

const reply = (
	status: number,
	outcome: WebhookOutcome,
	rest: Omit<WebhookResponse["body"], "outcome"> = {},
): WebhookResponse => ({ status, body: { outcome, ...rest } });

const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stringAt = (
	object: JsonObject | undefined,
	key: string,
): string | null => {
	const value = object?.[key];
	return typeof value === "string" && value !== "" ? value : null;
};

const parseEvent = (payload: string): StripeEvent | null => {
	let raw: unknown;
	try {
		raw = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!isObject(raw)) return null;
	const id = stringAt(raw, "id");
	const type = stringAt(raw, "type");
	const data = raw.data;
	const object = isObject(data) ? data.object : undefined;
	if (!id || !type || !isObject(object)) return null;
	const created = raw.created;
	if (typeof created !== "number" || !Number.isInteger(created) || created < 0)
		return null;
	return { id, type, created, object, raw };
};

// ---- Finding the subject ----

const schoolOf = (key: string): string => key.split("|")[0] ?? key;

/** The payment intent and charge ids an event names. A refund's object is the charge; a dispute names its charge. */
const paymentRefsOf = (event: StripeEvent): string[] => {
	const refs = [
		stringAt(event.object, "payment_intent"),
		event.type === "charge.refunded"
			? stringAt(event.object, "id")
			: stringAt(event.object, "charge"),
	];
	return refs.filter((ref): ref is string => ref !== null);
};

/**
 * What `invoice.paid` paid with, from the caller's optional `paymentRefs` and from `invoice.payments` when the event
 * came expanded. The hook's answer is not trusted to be typed: only its non-empty strings are kept, since anything else
 * would fail the bind and leave the claim `claimed` until the stale window passes.
 */
const invoiceRefsOf = (deps: WebhookDeps, event: StripeEvent): string[] => {
	const fromHook: unknown = deps.paymentRefs?.(event.raw);
	const refs = new Set<string>();
	if (Array.isArray(fromHook))
		for (const ref of fromHook as unknown[])
			if (typeof ref === "string" && ref !== "") refs.add(ref);
	const payments = event.object.payments;
	const listed =
		isObject(payments) && Array.isArray(payments.data) ? payments.data : [];
	for (const entry of listed) {
		const payment = isObject(entry) ? entry.payment : undefined;
		if (!isObject(payment)) continue;
		for (const key of ["payment_intent", "charge"]) {
			const ref = stringAt(payment, key);
			if (ref) refs.add(ref);
		}
	}
	return [...refs];
};

/**
 * The metadata that names the holder. An invoice's checkout metadata sits at `parent.subscription_details.metadata`
 * (its own top-level `metadata` is empty for a subscription invoice), so `invoice.paid` is read through its mapping,
 * which merges the two with the invoice's own keys winning, the same metadata `handleStripeEvent` will see. A
 * subscription event carries its metadata at the top. An invoice that does not normalize falls back to the same merge
 * read from the raw object; `handleStripeEvent` then refuses it with the real reason.
 */
const holderMetadata = (event: StripeEvent): JsonObject => {
	if (event.type !== "invoice.paid")
		return isObject(event.object.metadata) ? event.object.metadata : {};
	const apiVersion = isObject(event.raw) ? event.raw.api_version : undefined;
	const mapping = mappingFor(
		event.type,
		typeof apiVersion === "string" ? apiVersion : "",
	);
	const normalized = mapping.ok
		? normalize(event.raw, mapping.value, { eventId: event.id })
		: mapping;
	if (normalized.ok) {
		const { metadata } = normalized.value as BillingInvoice;
		return isObject(metadata) ? metadata : {};
	}
	// The subscription's metadata sits under `parent` from clover on, and on the invoice's `subscription_details` before
	// it: an endpoint left on an older version must still be located, so that it is refused with the version and the fix
	// rather than ignored as another product's invoice.
	const parent = event.object.parent;
	const parentDetails = isObject(parent)
		? parent.subscription_details
		: undefined;
	const inherited = isObject(parentDetails)
		? parentDetails.metadata
		: undefined;
	const olderDetails = event.object.subscription_details;
	const olderInherited = isObject(olderDetails)
		? olderDetails.metadata
		: undefined;
	return {
		...(isObject(olderInherited) ? olderInherited : {}),
		...(isObject(inherited) ? inherited : {}),
		...(isObject(event.object.metadata) ? event.object.metadata : {}),
	};
};

const HOLDER_KEYS = ["b4u_school", "family_id"] as const;

const locateHolder = (deps: WebhookDeps, event: StripeEvent): Located => {
	const metadata = holderMetadata(event);
	// Not a family's product at all: nothing of ours to decide, and nothing a retry could change.
	if (!HOLDER_KEYS.some((key) => key in metadata)) return { kind: "ignored" };
	const school = stringAt(metadata, "b4u_school");
	const family = stringAt(metadata, "family_id");
	if (school !== null && school !== deps.schoolId)
		return { kind: "school_mismatch", school };
	let key: string | null = null;
	if (school && family)
		try {
			key = subjectKey({
				orgId: school,
				env: resolveEnv(deps.env),
				customerId: `family:${family}`,
				entityId: null,
			});
		} catch {
			key = null;
		}
	if (key === null)
		return {
			kind: "missing_metadata",
			message: `${event.id} has no usable b4u_school/family_id metadata to name the holder`,
		};
	return { kind: "subject", subjectKey: key, invoiceIds: {} };
};

const locateSubject = (deps: WebhookDeps, event: StripeEvent): Located => {
	if (
		event.type === "invoice.paid" ||
		event.type.startsWith(SUBSCRIPTION_EVENT_PREFIX)
	)
		return locateHolder(deps, event);
	const refs = paymentRefsOf(event);
	// payment ref -> invoice (written by invoice_payment.paid) -> subject (written by invoice.paid)
	const hits =
		refs.length === 0
			? []
			: deps.db.all<{
					payment_ref: string;
					invoice_id: string;
					subject_key: string;
				}>(
					`SELECT payment.payment_ref, payment.invoice_id, invoice.subject_key FROM atm_payment_index AS payment JOIN atm_invoice_index AS invoice ON invoice.invoice_id = payment.invoice_id WHERE payment.payment_ref IN (${refs.map(() => "?").join(", ")})`,
					refs,
				);
	const first = hits[0];
	if (!first)
		return {
			kind: "unmatched_payment",
			message: `${event.id}: no handled invoice is linked to ${refs.join(", ") || "any payment"}; retry once its invoice and its invoice_payment.paid are handled`,
		};
	const subjects = new Set(hits.map((hit) => hit.subject_key));
	if (subjects.size > 1)
		return {
			kind: "ambiguous_payment",
			message: `${event.id}: ${hits.map((hit) => `${hit.payment_ref} -> ${hit.invoice_id}`).join(", ")} name more than one subject`,
		};
	const school = schoolOf(first.subject_key);
	if (school !== deps.schoolId) return { kind: "school_mismatch", school };
	const invoiceIds: Record<string, string> = {};
	for (const hit of hits) invoiceIds[hit.payment_ref] = hit.invoice_id;
	return { kind: "subject", subjectKey: first.subject_key, invoiceIds };
};

// ---- The claim ----

type ClaimResult =
	| { kind: "owned"; claim: Claim }
	| { kind: "duplicate" }
	| { kind: "busy" };

/** Takes the Stripe event id: a new claim, or a compare-and-set takeover of a stale one. */
const claimEvent = (deps: WebhookDeps, stripeEventId: string): ClaimResult => {
	const { db } = deps;
	const staleAfter = deps.claimStaleAfterMs ?? DEFAULT_CLAIM_STALE_AFTER_MS;
	// A claim can vanish between our insert and our read (released by its worker): look again.
	for (let round = 0; round < MAX_ATTEMPTS; round++) {
		const now = deps.nowMs();
		const inserted = db.transaction(
			() =>
				db.run(
					`INSERT INTO atm_event_claims (event_id, state, claimed_at, claimed_by) VALUES (?, 'claimed', ?, ?) ON CONFLICT (event_id) DO NOTHING`,
					[stripeEventId, now, deps.workerId],
				).changes,
		);
		if (inserted === 1) return { kind: "owned", claim: { claimedAt: now } };
		const [existing] = db.all<{ state: string; claimed_at: number }>(
			`SELECT state, claimed_at FROM atm_event_claims WHERE event_id = ?`,
			[stripeEventId],
		);
		if (!existing) continue;
		if (existing.state === "done") return { kind: "duplicate" };
		if (now - existing.claimed_at < staleAfter) return { kind: "busy" };
		const taken = db.run(
			`UPDATE atm_event_claims SET claimed_at = ?, claimed_by = ? WHERE event_id = ? AND state = 'claimed' AND claimed_at = ?`,
			[now, deps.workerId, stripeEventId, existing.claimed_at],
		).changes;
		return taken === 1
			? { kind: "owned", claim: { claimedAt: now } }
			: { kind: "busy" };
	}
	return { kind: "busy" };
};

const releaseClaim = (
	deps: WebhookDeps,
	stripeEventId: string,
	claim: Claim,
): void => {
	deps.db.run(
		`DELETE FROM atm_event_claims WHERE event_id = ? AND state = 'claimed' AND claimed_by = ? AND claimed_at = ?`,
		[stripeEventId, deps.workerId, claim.claimedAt],
	);
};

const finishClaim = (
	deps: WebhookDeps,
	stripeEventId: string,
	claim: Claim,
): void => {
	const { changes } = deps.db.run(
		`UPDATE atm_event_claims SET state = 'done', done_at = ?, outcome = 'applied' WHERE event_id = ? AND state = 'claimed' AND claimed_by = ? AND claimed_at = ?`,
		[deps.nowMs(), stripeEventId, deps.workerId, claim.claimedAt],
	);
	if (changes !== 1) throw new ClaimLost(`claim on ${stripeEventId} was lost`);
};

const assertClaimIsOurs = (
	deps: WebhookDeps,
	stripeEventId: string,
	claim: Claim,
): void => {
	const [row] = deps.db.all<{
		state: string;
		claimed_by: string;
		claimed_at: number;
	}>(
		`SELECT state, claimed_by, claimed_at FROM atm_event_claims WHERE event_id = ?`,
		[stripeEventId],
	);
	if (
		row?.state !== "claimed" ||
		row.claimed_by !== deps.workerId ||
		row.claimed_at !== claim.claimedAt
	)
		throw new ClaimLost(`claim on ${stripeEventId} is not ours`);
};

// ---- Rows ----

const loadSubject = (
	db: SqlDatabase,
	key: string,
): { rows: BillingRow[]; revision: number } => {
	const [subject] = db.all<{ revision: number }>(
		`SELECT revision FROM atm_subjects WHERE subject_key = ?`,
		[key],
	);
	const stored = db.all<{ table_name: string; row_id: string; data: string }>(
		`SELECT table_name, row_id, data FROM atm_rows WHERE subject_key = ? ORDER BY table_name, row_id`,
		[key],
	);
	return {
		revision: subject?.revision ?? 0,
		rows: stored.map((row) => ({
			table: row.table_name,
			id: row.row_id,
			data: JSON.parse(row.data),
		})) as BillingRow[],
	};
};

/** The step-by-step write from `schema/storage/rows.v1.sql`; a revision that is not the expected one is StaleRevision. */
const writeRows = (db: SqlDatabase, changes: RowChanges): void => {
	const { subjectKey: key, expectedRevision, nextRevision } = changes;
	let moved = db.run(
		`UPDATE atm_subjects SET revision = ? WHERE subject_key = ? AND revision = ?`,
		[nextRevision, key, expectedRevision],
	).changes;
	if (moved === 0 && expectedRevision === 0)
		moved = db.run(
			`INSERT INTO atm_subjects (subject_key, revision) VALUES (?, ?) ON CONFLICT (subject_key) DO NOTHING`,
			[key, nextRevision],
		).changes;
	if (moved === 0) {
		const [current] = db.all<{ revision: number }>(
			`SELECT revision FROM atm_subjects WHERE subject_key = ?`,
			[key],
		);
		throw new StaleRevision(expectedRevision, current?.revision ?? 0, key);
	}
	for (const upsert of changes.upserts)
		db.run(
			`INSERT INTO atm_rows (subject_key, table_name, row_id, data) VALUES (?, ?, ?, ?) ON CONFLICT (subject_key, table_name, row_id) DO UPDATE SET data = excluded.data`,
			[key, upsert.table, upsert.id, JSON.stringify(upsert.data)],
		);
	for (const removed of changes.deletes)
		db.run(
			`DELETE FROM atm_rows WHERE subject_key = ? AND table_name = ? AND row_id = ?`,
			[key, removed.table, removed.id],
		);
};

// ---- One attempt ----

const applyOnce = ({
	deps,
	event,
	located,
	claim,
}: {
	deps: WebhookDeps;
	event: StripeEvent;
	located: Extract<Located, { kind: "subject" }>;
	claim: Claim;
}): Applied => {
	const { db } = deps;
	assertClaimIsOurs(deps, event.id, claim);
	const school = schoolOf(located.subjectKey);
	const context = deps.context(school);
	if (!context) {
		releaseClaim(deps, event.id, claim);
		return { kind: "unknown_school" };
	}
	const { rows, revision } = loadSubject(db, located.subjectKey);
	const result = handleStripeEvent({
		event: event.raw,
		eventId: deterministicUlid({
			timeMs: event.created * 1000,
			revision: 0,
			seed: canonicalize([school, event.id]),
		}),
		menu: context.menu,
		menuVersion: context.menuVersion,
		policy: context.policy,
		policyVersion: context.policyVersion,
		rows,
		revision,
		catalog: context.catalog,
		now: event.created * 1000,
		priceIds: context.priceIds,
		invoiceIds: located.invoiceIds,
		env: deps.env,
	});
	if (result.refused) {
		releaseClaim(deps, event.id, claim);
		return { kind: "refused", refusal: result.refused };
	}
	if (result.rowChanges) {
		if (result.rowChanges.subjectKey !== located.subjectKey)
			throw new Error(
				`${event.id} decided rows for ${result.rowChanges.subjectKey}, not ${located.subjectKey}`,
			);
		writeRows(db, result.rowChanges);
	}
	for (const decision of result.events)
		db.run(
			`INSERT INTO ledger_outbox (school_id, id, idem, date, body, batch_key, shipped_at) VALUES (?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT (school_id, idem) DO NOTHING`,
			[
				decision.school,
				decision.id,
				decision.idem,
				decision.date,
				canonicalize(decision),
			],
		);
	if (event.type === "invoice.paid") {
		const invoiceId = stringAt(event.object, "id");
		if (invoiceId) {
			db.run(
				`INSERT INTO atm_invoice_index (invoice_id, subject_key) VALUES (?, ?) ON CONFLICT (invoice_id) DO NOTHING`,
				[invoiceId, located.subjectKey],
			);
			for (const ref of invoiceRefsOf(deps, event))
				db.run(
					`INSERT INTO atm_payment_index (payment_ref, invoice_id) VALUES (?, ?) ON CONFLICT (payment_ref) DO NOTHING`,
					[ref, invoiceId],
				);
		}
	}
	finishClaim(deps, event.id, claim);
	return {
		kind: "applied",
		events: result.events.length,
		wroteRows: result.rowChanges !== null,
	};
};

const answerForRefusal = (
	stripeEventId: string,
	refusal: StripeEventRefusal,
): WebhookResponse =>
	reply(RETRYABLE_REFUSALS.has(refusal.reason) ? 409 : 422, "refused", {
		stripeEventId,
		reason: refusal.reason,
		message: refusal.message,
	});

const settle = (
	deps: WebhookDeps,
	event: StripeEvent,
	claim: Claim,
	located: Extract<Located, { kind: "subject" }>,
): WebhookResponse => {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		let applied: Applied;
		try {
			applied = deps.db.transaction(() =>
				applyOnce({ deps, event, located, claim }),
			);
		} catch (error) {
			if (error instanceof StaleRevision) continue;
			if (error instanceof ClaimLost) return afterLostClaim(deps, event.id);
			throw error;
		}
		if (applied.kind === "applied")
			return reply(200, "applied", {
				stripeEventId: event.id,
				events: applied.events,
				wroteRows: applied.wroteRows,
			});
		if (applied.kind === "unknown_school")
			return reply(422, "unknown_school", {
				stripeEventId: event.id,
				message: `no context for school ${schoolOf(located.subjectKey)}`,
			});
		return answerForRefusal(event.id, applied.refusal);
	}
	releaseClaim(deps, event.id, claim);
	return reply(409, "stale_revision", { stripeEventId: event.id });
};

type Recorded =
	| { kind: "recorded"; refs: number }
	| { kind: "unmatched_invoice"; invoiceId: string }
	| { kind: "school_mismatch"; school: string }
	| { kind: "refused"; refusal: StripeEventRefusal };

/** The payment intent and the charge an invoice payment names, in the order they are indexed. */
const paymentRefsOfFact = (fact: InvoicePaymentFact): string[] =>
	[fact.paymentIntentId, fact.chargeId].filter(
		(ref): ref is string => ref !== null,
	);

/** One transaction for an `invoice_payment.paid`: link the payment to its invoice and mark the claim done. */
const recordPaymentOnce = (
	deps: WebhookDeps,
	event: StripeEvent,
	claim: Claim,
): Recorded => {
	const { db } = deps;
	assertClaimIsOurs(deps, event.id, claim);
	const apiVersion = isObject(event.raw) ? event.raw.api_version : undefined;
	const mapping = mappingFor(
		event.type,
		typeof apiVersion === "string" ? apiVersion : "",
	);
	const normalized = mapping.ok
		? normalize(event.raw, mapping.value, { eventId: event.id })
		: mapping;
	if (!normalized.ok) {
		releaseClaim(deps, event.id, claim);
		return {
			kind: "refused",
			refusal: {
				reason: mapping.ok ? "bad_event" : "unknown_mapping",
				message: describeNormalizeError(normalized.error),
			},
		};
	}
	const fact = normalized.value as InvoicePaymentFact;
	const [known] = db.all<{ subject_key: string }>(
		`SELECT subject_key FROM atm_invoice_index WHERE invoice_id = ?`,
		[fact.invoiceId],
	);
	if (!known) {
		releaseClaim(deps, event.id, claim);
		return { kind: "unmatched_invoice", invoiceId: fact.invoiceId };
	}
	const school = schoolOf(known.subject_key);
	if (school !== deps.schoolId) {
		releaseClaim(deps, event.id, claim);
		return { kind: "school_mismatch", school };
	}
	const refs = paymentRefsOfFact(fact);
	for (const ref of refs)
		db.run(
			`INSERT INTO atm_payment_index (payment_ref, invoice_id) VALUES (?, ?) ON CONFLICT (payment_ref) DO NOTHING`,
			[ref, fact.invoiceId],
		);
	finishClaim(deps, event.id, claim);
	return { kind: "recorded", refs: refs.length };
};

const settlePayment = (
	deps: WebhookDeps,
	event: StripeEvent,
	claim: Claim,
): WebhookResponse => {
	let recorded: Recorded;
	try {
		recorded = deps.db.transaction(() => recordPaymentOnce(deps, event, claim));
	} catch (error) {
		if (error instanceof ClaimLost) return afterLostClaim(deps, event.id);
		throw error;
	}
	if (recorded.kind === "recorded")
		return reply(200, "applied", {
			stripeEventId: event.id,
			events: 0,
			wroteRows: false,
		});
	if (recorded.kind === "unmatched_invoice")
		return reply(409, "unmatched_invoice", {
			stripeEventId: event.id,
			message: `${event.id}: invoice ${recorded.invoiceId} is not indexed; retry once its invoice.paid is handled`,
		});
	if (recorded.kind === "school_mismatch")
		return schoolMismatch(deps, event.id, recorded.school);
	return answerForRefusal(event.id, recorded.refusal);
};

/** Our transaction rolled back because the claim was no longer ours: the one who took it is (or was) doing the work. */
const afterLostClaim = (
	deps: WebhookDeps,
	stripeEventId: string,
): WebhookResponse => {
	const [row] = deps.db.all<{ state: string }>(
		`SELECT state FROM atm_event_claims WHERE event_id = ?`,
		[stripeEventId],
	);
	return row?.state === "done"
		? reply(200, "duplicate", { stripeEventId })
		: reply(409, "busy", { stripeEventId });
};

const schoolMismatch = (
	deps: WebhookDeps,
	stripeEventId: string,
	school: string,
): WebhookResponse =>
	reply(422, "school_mismatch", {
		stripeEventId,
		message: `${stripeEventId} is for school ${school}, and this endpoint serves ${deps.schoolId}`,
	});

/**
 * A type we do not map: answered and not recorded, so that once a later version maps it, the owner's re-send from the
 * dashboard is handled instead of answered `duplicate`.
 */
const ignoreUnmapped = (event: StripeEvent): WebhookResponse =>
	reply(200, "ignored", { stripeEventId: event.id });

/** A mapped type that names no family at all (another product on the account): its metadata cannot change, so done. */
const ignoreForeign = (
	deps: WebhookDeps,
	event: StripeEvent,
): WebhookResponse => {
	const now = deps.nowMs();
	const { changes } = deps.db.run(
		`INSERT INTO atm_event_claims (event_id, state, claimed_at, claimed_by, done_at, outcome) VALUES (?, 'done', ?, ?, ?, 'ignored') ON CONFLICT (event_id) DO NOTHING`,
		[event.id, now, deps.workerId, now],
	);
	return changes === 1
		? reply(200, "ignored", { stripeEventId: event.id })
		: afterLostClaim(deps, event.id);
};

/** Handles one Stripe webhook delivery. Synchronous: the database is. Throws on an error it cannot answer for (see above). */
export const handleStripeWebhook = (
	deps: WebhookDeps,
	request: WebhookRequest,
): WebhookResponse => {
	// Before anything is verified or claimed: a bad env is the caller's code, and every delivery would hit it.
	resolveEnv(deps.env);
	const verdict = verifyStripeSignature({
		payload: request.payload,
		header: request.signatureHeader,
		secret: deps.secret,
		nowMs: deps.nowMs(),
	});
	if (!verdict.ok)
		return reply(401, "bad_signature", { reason: verdict.reason });

	const event = parseEvent(request.payload);
	if (!event)
		return reply(400, "bad_request", {
			message:
				"the body is not a Stripe event (id, type, created, data.object)",
		});
	if (!HANDLED_TYPES.has(event.type)) return ignoreUnmapped(event);

	if (event.type === INVOICE_PAYMENT_EVENT) {
		const claimed = claimEvent(deps, event.id);
		if (claimed.kind === "duplicate")
			return reply(200, "duplicate", { stripeEventId: event.id });
		if (claimed.kind === "busy")
			return reply(409, "busy", { stripeEventId: event.id });
		return settlePayment(deps, event, claimed.claim);
	}

	const located = locateSubject(deps, event);
	if (located.kind === "ignored") return ignoreForeign(deps, event);
	if (located.kind === "school_mismatch")
		return schoolMismatch(deps, event.id, located.school);
	if (located.kind === "ambiguous_payment")
		return reply(422, "ambiguous_payment", {
			stripeEventId: event.id,
			message: located.message,
		});
	if (located.kind === "missing_metadata")
		return reply(422, "refused", {
			stripeEventId: event.id,
			reason: "missing_metadata",
			message: located.message,
		});
	if (located.kind === "unmatched_payment")
		return reply(409, "unmatched_payment", {
			stripeEventId: event.id,
			message: located.message,
		});

	const claimed = claimEvent(deps, event.id);
	if (claimed.kind === "duplicate")
		return reply(200, "duplicate", { stripeEventId: event.id });
	if (claimed.kind === "busy")
		return reply(409, "busy", { stripeEventId: event.id });
	return settle(deps, event, claimed.claim, located);
};
