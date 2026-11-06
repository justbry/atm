/**
 * A booking's events through `simulateFromInputs`: the family service's endpoint in miniature (the recipe in `UPGRADING.md`,
 * "Storing the inputs of a booking") stores them, and the baseline replay must give the outbox the endpoint wrote. Design:
 * `docs/simulate-from-inputs.md`, "Addendum: booking events are stored".
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
	inputCauseId,
	readInputs,
	recordInput,
} from "../src/handler/inputs.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { appendToOutbox } from "../src/ledger/outbox.js";
import { simulateFromInputs } from "../src/ledger/simulate-inputs.js";
import type {
	AtmEvent,
	RowChanges,
	SqlDatabase,
	StripeEventResult,
} from "../src/types.js";
import { priceIdOf, type RawEvent } from "./stripe-events.js";

const SCHOOL = "sch_demo";
const ENV = "test";
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

const partialRefund = () => load("charge.refunded.partial.json");

const replayOf = (e: ReturnType<typeof endpoint>, candidate = {}) =>
	simulateFromInputs({
		events: e.outbox().sort((a, b) => (a.id < b.id ? -1 : 1)),
		inputs: readInputs(e.db, { env: ENV, school: SCHOOL }),
		env: ENV,
		school: SCHOOL,
		candidate,
	});

describe("a booking's events: the baseline is the outbox", () => {
	test("a paid session, a partial refund and a full refund (one named by the booking index only): every line is made again, and the inputs are the endpoint's", () => {
		const e = endpoint(new Database(":memory:"));
		e.handle(completed(), { fee: FEE });
		e.handle(load("checkout.session.completed.second.json"), { fee: FEE });
		const partial = partialRefund();
		// the charge names no booking: only the family service's index does
		delete partial.data.object.metadata.booking_id;
		expect(e.handle(partial).status).toBe(200);
		const full = fullRefund();
		expect(e.handle(full).status).toBe(200);
		expect(e.handle(expired()).status).toBe(200);
		expect(e.handle(subscriptionSession()).status).toBe(200);
		const sim = replayOf(e);
		expect(sim.baseline.mismatches).toEqual([]);
		expect(sim.baseline.identical).toBe(true);
		expect(sim.baseline.inputs).toBe(6);
		expect(sim.notReplayable.items).toEqual([]);
		// two paid sessions and two refunds: four money lines; the outbox holds nothing else
		expect(
			e
				.outbox()
				.map((event) => event.event_type)
				.sort(),
		).toEqual([
			"payment.refunded",
			"payment.refunded",
			"payment.succeeded",
			"payment.succeeded",
		]);
		expect(sim.differences).toBe(0);
		// the replay's lines are the outbox's, byte for byte
		expect(sim.events.map((event) => event.idem).sort()).toEqual(
			e
				.outbox()
				.map((event) => event.idem)
				.sort(),
		);
	});

	test("the grant rules do not touch a booking: a candidate policy leaves its inputs the same, and the lines unchanged", () => {
		const e = endpoint(new Database(":memory:"));
		e.handle(completed(), { fee: FEE });
		e.handle(fullRefund());
		const sim = replayOf(e, {
			policy: {
				...DEFAULT_POLICY,
				upgradeGrant: "none",
				removeOnFullRefund: false,
			},
		});
		expect(
			sim.deliveries.map((d) => [d.type, d.kind, d.recorded.booking]),
		).toEqual([
			["checkout.session.completed", "same", "paid"],
			["charge.refunded", "same", "refunded"],
		]);
		expect(sim.differences).toBe(0);
	});

	test("a refund that waited for its payment (stored refused as unmatched_booking would be a 409): the order applied is the order replayed", () => {
		const e = endpoint(new Database(":memory:"));
		// the refund before its session: a wait (409), nothing stored
		const early = e.handle(fullRefund());
		expect(early).toMatchObject({ status: 409 });
		e.handle(completed(), { fee: FEE });
		e.handle(fullRefund());
		const sim = replayOf(e);
		expect(sim.baseline.identical).toBe(true);
		expect(sim.baseline.inputs).toBe(2);
	});
});
