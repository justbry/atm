/**
 * A booking's Stripe events are stored by the family service's own endpoint, which calls `recordInput` in its transaction (the
 * reference handler never decides them). This is that endpoint in miniature, on SQLite: it follows the recipe in `UPGRADING.md`
 * ("Storing the inputs of a booking"). Design: `docs/simulate-from-inputs.md`, "Addendum: booking events are stored".
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import {
	handleStripeEvent,
	normalizeStripeEvent,
} from "../src/billing/handle.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	type BillingRow,
	StaleRevision,
	subjectKey,
} from "../src/billing/rows.js";
import { menuLineItems } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import {
	eraseStoredInputs,
	inputCauseId,
	readInputs,
	recordInput,
} from "../src/handler/inputs.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { appendToOutbox } from "../src/ledger/outbox.js";
import type {
	AtmEvent,
	RowChanges,
	SqlDatabase,
	StripeEventResult,
} from "../src/types.js";
import { tmp } from "./helpers.js";
import {
	databaseBytes,
	foundIn,
	personalStringsOf,
	walMode,
} from "./stored-inputs-bytes.js";
import { priceIdOf, type RawEvent } from "./stripe-events.js";

const SCHOOL = "sch_demo";
const FAMILY = "fam_demo1";
const ENV = "test";
const HOLDER = subjectKey({
	orgId: SCHOOL,
	env: ENV,
	customerId: `family:${FAMILY}`,
	entityId: null,
});
const NOW = Date.parse("2026-11-05T12:00:00Z");
const FEE = 117;
const bookingDir = join(
	import.meta.dir,
	"../fixtures/billing/stripe/recorded/booking",
);
const load = (name: string): RawEvent =>
	JSON.parse(readFileSync(join(bookingDir, name), "utf8"));
const menu = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../fixtures/billing/grants/menu.json"),
		"utf8",
	),
) as Menu;
const catalog = menuCatalogRows({ menu, school: SCHOOL, env: ENV });
const priceIds = Object.fromEntries(
	[...menuLineItems(SCHOOL, menu).keys()].map((key) => [key, priceIdOf(key)]),
);

const completed = () => load("checkout.session.completed.json");
const expired = () => load("checkout.session.expired.json");
const fullRefund = () => load("charge.refunded.full.json");
const subscriptionSession = (): RawEvent => {
	const event = load("checkout.session.completed.subscription.json");
	// recorded for another school: the holder here is this one's
	event.data.object.metadata.b4u_school = SCHOOL;
	return event;
};
const paymentIntentId = completed().data.object.payment_intent as string;

const directories: string[] = [];
afterAll(async () => {
	for (const dir of directories)
		await rm(dir, { recursive: true, force: true });
});

/** The rows write of the family service: revision-checked, as `schema/storage/rows.v1.sql` says. */
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
	if (moved === 0) throw new StaleRevision(expectedRevision, 0, key);
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

const loadRows = (db: SqlDatabase, key: string) => {
	const [subject] = db.all<{ revision: number }>(
		`SELECT revision FROM atm_subjects WHERE subject_key = ?`,
		[key],
	);
	const rows = db
		.all<{ table_name: string; row_id: string; data: string }>(
			`SELECT table_name, row_id, data FROM atm_rows WHERE subject_key = ? ORDER BY table_name, row_id`,
			[key],
		)
		.map((row) => ({
			table: row.table_name,
			id: row.row_id,
			data: JSON.parse(row.data),
		})) as BillingRow[];
	return { rows, revision: subject?.revision ?? 0 };
};

const RETRYABLE = new Set(["unmatched_booking", "unmatched_invoice"]);

type Answer =
	| { status: 200; result: StripeEventResult; stored: "stored" | "existing" }
	| { status: 409 | 422; reason: string };

/**
 * The family service's booking endpoint, in miniature: ONE write-serialized transaction that loads the holder's rows,
 * decides with `handleStripeEvent` (with its booking index and the fee it read from Stripe), writes the rows, appends the
 * decision events, writes its own booking tables, and then calls `recordInput`. A throw rolls all of it back.
 */
const endpoint = (raw: Database) => {
	const db = bunSqlite(raw);
	db.exec(HANDLER_DDL);
	// the family service's own booking tables: booking -> holder, and payment intent or charge -> booking
	db.exec(
		`CREATE TABLE IF NOT EXISTS bk_bookings (booking_id TEXT PRIMARY KEY, subject_key TEXT NOT NULL)`,
	);
	db.exec(
		`CREATE TABLE IF NOT EXISTS bk_index (ref TEXT PRIMARY KEY, booking_id TEXT NOT NULL)`,
	);

	const handle = (
		event: RawEvent,
		options: { fee?: number; throwAfterRecord?: boolean } = {},
	): Answer =>
		db.transaction((): Answer => {
			const object = event.data.object;
			const inputId = inputCauseId({
				school: SCHOOL,
				eventId: event.id,
				stripeCreated: event.created,
			});
			// the booking index entries for this fact's payment intent and charge
			const refs = [
				object.payment_intent,
				event.type === "charge.refunded" ? object.id : null,
			].filter((ref): ref is string => typeof ref === "string");
			const bookingRefs: Record<string, string> = {};
			for (const ref of refs) {
				const [hit] = db.all<{ booking_id: string }>(
					`SELECT booking_id FROM bk_index WHERE ref = ?`,
					[ref],
				);
				if (hit) bookingRefs[ref] = hit.booking_id;
			}
			let holder: string | null = null;
			if (event.type.startsWith("checkout.session.")) {
				holder = subjectKey({
					orgId: object.metadata.b4u_school,
					env: ENV,
					customerId: `family:${object.metadata.family_id}`,
					entityId: null,
				});
			} else {
				const bookingId =
					Object.values(bookingRefs)[0] ?? object.metadata?.booking_id;
				const [known] = db.all<{ subject_key: string }>(
					`SELECT subject_key FROM bk_bookings WHERE booking_id = ?`,
					[bookingId ?? null],
				);
				holder = known?.subject_key ?? null;
			}
			if (holder === null) return { status: 409, reason: "unmatched_booking" };
			const { rows, revision } = loadRows(db, holder);
			const fee = options.fee === undefined ? {} : { fee: options.fee };
			const result = handleStripeEvent({
				event,
				eventId: inputId,
				menu,
				menuVersion: 3,
				policy: DEFAULT_POLICY,
				policyVersion: 1,
				rows,
				revision,
				catalog,
				now: event.created * 1000,
				priceIds,
				bookingIds: bookingRefs,
				env: ENV,
				school: SCHOOL,
				...fee,
			});
			const normalized = normalizeStripeEvent(event, inputId);
			if (!normalized.ok) throw new Error("the booking fixtures normalize");
			const common = {
				env: ENV,
				schoolId: SCHOOL,
				event: {
					id: event.id,
					type: event.type,
					created: event.created,
					apiVersion: normalized.apiVersion,
					livemode: event.livemode,
				},
				rawBody: JSON.stringify(event),
				normalized,
				subjectKey: holder,
				revisionBefore: revision,
				rowsBefore: rows,
				context: {
					menu,
					menuVersion: 3,
					policy: DEFAULT_POLICY,
					policyVersion: 1,
					catalog,
					priceIds,
				},
				fee: options.fee ?? null,
				paymentRefs: null,
				inputId,
				bookingRefs: Object.keys(bookingRefs).length > 0 ? bookingRefs : null,
				nowMs: NOW,
			} as const;
			if (result.refused) {
				// a wait is answered 409 and stored nothing; any other refusal is a 422 and is stored
				if (RETRYABLE.has(result.refused.reason))
					return { status: 409, reason: result.refused.reason };
				recordInput(db, {
					...common,
					outcome: "refused",
					reason: result.refused.reason,
					revisionAfter: revision,
				});
				return { status: 422, reason: result.refused.reason };
			}
			if (result.rowChanges) writeRows(db, result.rowChanges);
			appendToOutbox(db, result.events, ENV);
			if (result.booking?.action === "paid") {
				db.run(
					`INSERT INTO bk_bookings (booking_id, subject_key) VALUES (?, ?) ON CONFLICT (booking_id) DO NOTHING`,
					[result.booking.bookingId, holder],
				);
				if (result.booking.paymentIntentId)
					db.run(
						`INSERT INTO bk_index (ref, booking_id) VALUES (?, ?) ON CONFLICT (ref) DO NOTHING`,
						[result.booking.paymentIntentId, result.booking.bookingId],
					);
			}
			const stored = recordInput(db, {
				...common,
				outcome: "applied",
				reason: null,
				revisionAfter: result.rowChanges?.nextRevision ?? revision,
			});
			if (options.throwAfterRecord)
				throw new Error("the endpoint failed after recordInput");
			return { status: 200, result, stored };
		});

	const inputs = () =>
		raw
			.query(`SELECT * FROM atm_event_inputs ORDER BY applied_order`)
			.all() as Record<string, unknown>[];
	const outbox = () =>
		(
			raw.query(`SELECT body FROM ledger_outbox ORDER BY id`).all() as {
				body: string;
			}[]
		).map((row) => JSON.parse(row.body) as AtmEvent);
	const count = (table: string) =>
		(raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
	return { raw, db, handle, inputs, outbox, count };
};

const idOf = (event: RawEvent) =>
	inputCauseId({
		school: SCHOOL,
		eventId: event.id,
		stripeCreated: event.created,
	});

describe("a booking's events, stored by the endpoint", () => {
	test("a paid session: its input, the fee, the revisions and the decision events that name it", () => {
		const e = endpoint(new Database(":memory:"));
		const session = completed();
		const answer = e.handle(session, { fee: FEE });
		expect(answer.status).toBe(200);
		const [row, ...rest] = e.inputs();
		expect(rest).toEqual([]);
		expect(row).toMatchObject({
			env: ENV,
			event_id: session.id,
			school_id: SCHOOL,
			subject_key: HOLDER,
			type: "checkout.session.completed",
			outcome: "applied",
			reason: null,
			attempts: 1,
			revision_before: 0,
			revision_after: 1,
			fee: FEE,
			payment_refs: null,
			booking_refs: null,
			input_id: idOf(session),
			stripe_created: session.created,
		});
		expect(row?.mapping).toMatch(/^stripe\/checkout\.session\.completed@/);
		// the fact is trimmed: the booking id stays, the free-form metadata and the customer's details do not
		const body = JSON.parse(row?.body as string) as {
			v: number;
			fact: { metadata: Record<string, string>; sessionId: string };
		};
		expect(body.v).toBe(1);
		expect(body.fact.metadata).toEqual({
			b4u_school: SCHOOL,
			booking_id: "bk_trig1",
			family_id: FAMILY,
		});
		expect(JSON.stringify(body)).not.toContain("customer_details");
		expect(row?.raw_sha256).toHaveLength(64);
		// the money line names the input
		const lines = e
			.outbox()
			.filter((event) => event.event_type === "payment.succeeded");
		expect(lines).toHaveLength(1);
		expect(lines[0]?.cause).toBe(row?.input_id as string);
		// and it is the context the decision ran under
		expect(e.count("atm_input_contexts")).toBe(1);
	});

	test("an expired session is stored, and decided as nothing to write", () => {
		const e = endpoint(new Database(":memory:"));
		const answer = e.handle(expired());
		expect(answer).toMatchObject({ status: 200 });
		if (answer.status !== 200) throw new Error("answered 200");
		expect(answer.result.booking?.action).toBe("expired");
		const [row] = e.inputs();
		expect(row).toMatchObject({
			type: "checkout.session.expired",
			outcome: "applied",
			revision_before: 0,
			revision_after: 0,
		});
		expect(e.outbox()).toEqual([]);
	});

	test("a session that decides nothing (a subscription-mode session) is stored too", () => {
		const e = endpoint(new Database(":memory:"));
		const answer = e.handle(subscriptionSession());
		expect(answer.status).toBe(200);
		const [row] = e.inputs();
		expect(row).toMatchObject({
			type: "checkout.session.completed",
			outcome: "applied",
			revision_before: 0,
			revision_after: 0,
		});
		expect(
			(JSON.parse(row?.body as string) as { fact: { mode: string } }).fact.mode,
		).toBe("subscription");
		expect(e.outbox()).toEqual([]);
	});

	test("a refund named only by the booking index stores the index entries it was decided with", () => {
		const e = endpoint(new Database(":memory:"));
		e.handle(completed(), { fee: FEE });
		const refund = fullRefund();
		// the charge carries no booking id: only the family service's index names the booking
		delete refund.data.object.metadata.booking_id;
		const answer = e.handle(refund);
		expect(answer.status).toBe(200);
		if (answer.status !== 200) throw new Error("answered 200");
		expect(answer.result.booking?.action).toBe("refunded");
		const row = e.inputs().find((input) => input.event_id === refund.id);
		expect(row).toMatchObject({
			type: "charge.refunded",
			outcome: "applied",
			subject_key: HOLDER,
			input_id: idOf(refund),
			revision_before: 1,
			revision_after: 2,
		});
		expect(JSON.parse(row?.booking_refs as string)).toEqual({
			[paymentIntentId]: "bk_trig1",
		});
		const lines = e
			.outbox()
			.filter((event) => event.event_type === "payment.refunded");
		expect(lines).toHaveLength(1);
		expect(lines[0]?.cause).toBe(row?.input_id as string);
	});

	test("a refund named only by the charge's metadata stores no booking refs", () => {
		const e = endpoint(new Database(":memory:"));
		e.handle(completed(), { fee: FEE });
		// the index knows nothing of the payment: the charge's own metadata names the booking
		e.raw.run(`DELETE FROM bk_index`);
		const refund = fullRefund();
		const answer = e.handle(refund);
		expect(answer.status).toBe(200);
		if (answer.status !== 200) throw new Error("answered 200");
		expect(answer.result.booking?.action).toBe("refunded");
		const row = e.inputs().find((input) => input.event_id === refund.id);
		expect(row).toMatchObject({ outcome: "applied", booking_refs: null });
		expect(
			e.outbox().filter((event) => event.event_type === "payment.refunded"),
		).toHaveLength(1);
	});

	test("a redelivery is 'existing' and stores nothing; a paid booking taken by another session is stored as a refusal", () => {
		const e = endpoint(new Database(":memory:"));
		expect(e.handle(completed(), { fee: FEE })).toMatchObject({
			stored: "stored",
		});
		const before = e.inputs();
		expect(e.handle(completed(), { fee: FEE })).toMatchObject({
			stored: "existing",
		});
		expect(e.inputs()).toEqual(before);
		expect(e.count("ledger_outbox")).toBe(1);

		// the same booking paid by a second session
		const other = completed();
		other.id = "evt_other_session";
		other.data.object.id = "cs_test_Other";
		other.data.object.payment_intent = "pi_other";
		expect(e.handle(other, { fee: FEE })).toMatchObject({
			status: 422,
			reason: "rejected",
		});
		const refused = e
			.inputs()
			.find((row) => row.event_id === "evt_other_session");
		expect(refused).toMatchObject({
			outcome: "refused",
			reason: "rejected",
			attempts: 1,
		});
		expect(e.handle(other, { fee: FEE })).toMatchObject({ status: 422 });
		expect(
			e.inputs().find((row) => row.event_id === "evt_other_session"),
		).toMatchObject({
			attempts: 2,
			applied_order: refused?.applied_order as number,
		});
		expect(e.count("ledger_outbox")).toBe(1);
	});

	test("a wait stores nothing: a refund of an unknown booking", () => {
		const e = endpoint(new Database(":memory:"));
		expect(e.handle(fullRefund())).toEqual({
			status: 409,
			reason: "unmatched_booking",
		});
		expect(e.count("atm_event_inputs")).toBe(0);
	});

	test("a failure after recordInput rolls back the rows, the outbox, the booking tables and the input together", () => {
		const e = endpoint(new Database(":memory:"));
		expect(() =>
			e.handle(completed(), { fee: FEE, throwAfterRecord: true }),
		).toThrow("after recordInput");
		for (const table of [
			"atm_event_inputs",
			"atm_input_contexts",
			"ledger_outbox",
			"atm_rows",
			"atm_subjects",
			"bk_bookings",
			"bk_index",
		])
			expect(e.count(table)).toBe(0);
		// the retry stores it once
		expect(e.handle(completed(), { fee: FEE })).toMatchObject({
			stored: "stored",
		});
		expect(e.count("atm_event_inputs")).toBe(1);
	});

	test("the read a replay makes carries the booking columns, and an erasure clears them", () => {
		const e = endpoint(new Database(":memory:"));
		e.handle(completed(), { fee: FEE });
		const refund = fullRefund();
		delete refund.data.object.metadata.booking_id;
		e.handle(refund);
		const read = readInputs(e.db, { env: ENV, school: SCHOOL });
		expect(
			read.inputs.map((input) => [
				input.type,
				input.inputId,
				input.bookingRefs,
			]),
		).toEqual([
			["checkout.session.completed", idOf(completed()), null],
			["charge.refunded", idOf(refund), { [paymentIntentId]: "bk_trig1" }],
		]);
		expect(read.inputs[0]?.fee).toBe(FEE);

		const outboxBefore = e.outbox();
		expect(
			eraseStoredInputs(e.db, {
				env: ENV,
				school: SCHOOL,
				subjectKey: HOLDER,
				nowMs: NOW,
			}),
		).toMatchObject({ inputs: 2 });
		for (const row of e.inputs())
			expect(row).toMatchObject({
				body: null,
				subject_key: null,
				booking_refs: null,
				fee: null,
				raw_sha256: null,
				erased_at: NOW,
			});
		// the input ids name no person and stay; the money events stay
		expect(e.inputs().map((row) => row.input_id)).toEqual([
			idOf(completed()),
			idOf(refund),
		]);
		expect(e.outbox()).toEqual(outboxBefore);
	});
});

describe("a booking input holds no personal data", () => {
	test("no name, email, address, reference, profile id or link of the session is in the file or its log", async () => {
		const dir = await tmp("inputs-booking");
		directories.push(dir);
		const path = join(dir, "family.sqlite");
		const e = endpoint(walMode(new Database(path)));
		const marker = randomBytes(6).toString("hex");
		const session = completed();
		Object.assign(session.data.object, {
			client_reference_id: `ref-${marker}`,
			customer_email: `payer.${marker}@mail.example.test`,
			success_url: `https://shop.example.test/${marker}/done`,
		});
		Object.assign(session.data.object.metadata, {
			profile_id: `profile-${marker}`,
			note: `note ${marker}`,
		});
		const refund = fullRefund();
		Object.assign(refund.data.object, {
			receipt_url: `https://pay.example.test/${marker}/receipt`,
			billing_details: {
				name: `Payer ${marker}`,
				email: `payer.${marker}@mail.example.test`,
			},
		});
		const needles = personalStringsOf([session, refund]);
		for (const text of [`ref-${marker}`, `profile-${marker}`, `note ${marker}`])
			needles.add(text);
		expect(needles.size).toBeGreaterThan(8);

		expect(e.handle(session, { fee: FEE }).status).toBe(200);
		expect(e.handle(refund).status).toBe(200);
		expect(e.count("atm_event_inputs")).toBe(2);
		const raw = JSON.stringify([session, refund]);
		for (const needle of needles) expect(raw).toContain(needle);
		for (const checkpointed of [false, true]) {
			if (checkpointed) e.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			const bytes = databaseBytes(path);
			expect(foundIn(bytes, needles)).toEqual([]);
			expect(bytes.includes("://")).toBe(false);
		}
	});
});
