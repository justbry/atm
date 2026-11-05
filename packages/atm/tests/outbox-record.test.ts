/**
 * The family service's own engine commands, recorded in the outbox the handler writes. The service in miniature: one
 * subject's rows in the handler's SQLite tables, and for each command the order the README gives: run the engine, write
 * the rows (revision-checked), record the events, all in one transaction. Then the log is shipped and replayed, and the
 * credit accounts hledger prints are compared with what the commands spent.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { commandOrg, DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	type BillingRow,
	rowChangesFromMutation,
	stateFromRows,
} from "../src/billing/rows.js";
import {
	lookupKeyOf,
	menuLineItems,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { signStripePayload } from "../src/handler/stripe-signature.js";
import { handleStripeWebhook } from "../src/handler/stripe-webhook.js";
import type { SqlDatabase, WebhookDeps } from "../src/handler/types.js";
import { journalMonth } from "../src/ledger/files.js";
import { recordEngineCommand, recordLapse } from "../src/ledger/outbox.js";
import {
	balancesOf,
	ReplayError,
	replayEvents,
	replayOrder,
} from "../src/ledger/replay.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { validateEvent } from "../src/ledger/validate.js";
import { FolderStore } from "../src/store/folder-store.js";
import type {
	AtmCommandContext,
	AtmEvent,
	RecordedEvents,
} from "../src/types.js";
import { engineRowsOf } from "./billing-store.js";
import { hasHledger, tmp } from "./helpers.js";
import { invoicePaid, priceIdOf, type RawEvent } from "./stripe-events.js";

const SCHOOL = "sch_vol";
const FAMILY = "fam_outbox";
const HOLDER = `family:${FAMILY}`;
const SECRET = "whsec_unit_test_secret";
const SERVICE = "massage-90";
const DAY = 86_400_000;
const T0 = Date.parse("2026-01-15T18:00:00Z");
const T1 = Date.parse("2026-02-15T18:00:00Z");
const T2 = Date.parse("2026-03-15T18:00:00Z");
const menu = JSON.parse(
	await readFile(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
const catalogRows = menuCatalogRows({ menu, school: SCHOOL });
const catalog = toCatalog(catalogRows);
const identity = {
	orgId: SCHOOL,
	env: "live",
	customerId: HOLDER,
	entityId: null,
};
const SUBJECT_KEY = `${SCHOOL}|live|${HOLDER}`;
const org = commandOrg(DEFAULT_POLICY);
const featureOf = (internalFeatureId: string) =>
	catalog.features[internalFeatureId]?.id;

const priceOf = (tierId: string) =>
	menu.tiers
		.find((tier) => tier.id === tierId)
		?.prices.find((price) => price.interval === "month")?.amount as number;

const monthlyInvoice = ({
	invoiceId,
	reason,
	start,
	end,
}: {
	invoiceId: string;
	reason: "subscription_create" | "subscription_cycle";
	start: number;
	end: number;
}): RawEvent =>
	invoicePaid({
		eventId: `evt_${invoiceId}`,
		invoiceId,
		at: start + 10_000,
		subscriptionId: "sub_1",
		reason,
		periodStart: start,
		periodEnd: end,
		lines: [
			{
				lookupKey: lookupKeyOf(
					SCHOOL,
					tierPriceKey("sparkle-4", "month"),
					priceOf("sparkle-4"),
					menu.currency,
				),
				amount: priceOf("sparkle-4"),
				interval: "month",
			},
		],
		metadata: { b4u_school: SCHOOL, family_id: FAMILY },
	});

/** The handler and the family service on one database, as they are in production: one file, two writers. */
const newSchool = () => {
	const db = bunSqlite(new Database(":memory:"));
	db.exec(HANDLER_DDL);
	const clock = { now: T0 };
	const deps: WebhookDeps = {
		db,
		secret: SECRET,
		schoolId: SCHOOL,
		nowMs: () => clock.now,
		workerId: "worker-a",
		context: () => ({
			menu,
			menuVersion: 3,
			policy: DEFAULT_POLICY,
			policyVersion: 1,
			catalog: catalogRows,
			priceIds: Object.fromEntries(
				[...menuLineItems(SCHOOL, menu).keys()].map((key) => [
					key,
					priceIdOf(key),
				]),
			),
		}),
	};
	return {
		db,
		/** One Stripe event through the real handler. */
		deliver: (event: RawEvent, at: number) => {
			clock.now = at + 20_000;
			const payload = JSON.stringify(event);
			const response = handleStripeWebhook(deps, {
				payload,
				signatureHeader: signStripePayload({
					payload,
					secret: SECRET,
					timestampSeconds: Math.floor(clock.now / 1000),
				}),
			});
			expect(response.body.outcome).toBe("applied");
		},
	};
};

const storedRows = (db: SqlDatabase) => {
	const [subject] = db.all<{ revision: number }>(
		`SELECT revision FROM atm_subjects WHERE subject_key = ?`,
		[SUBJECT_KEY],
	);
	const rows = db
		.all<{ table_name: string; row_id: string; data: string }>(
			`SELECT table_name, row_id, data FROM atm_rows WHERE subject_key = ? ORDER BY table_name, row_id`,
			[SUBJECT_KEY],
		)
		.map((row) => ({
			table: row.table_name,
			id: row.row_id,
			data: JSON.parse(row.data),
		})) as BillingRow[];
	return { rows, revision: subject?.revision ?? 0 };
};

/** The engine's state as the stored rows hold it now. */
const stateOf = (db: SqlDatabase) =>
	stateFromRows({ identity, ...storedRows(db) });

/** The revision-checked write of `schema/storage/rows.v1.sql`, as the handler does it. */
const writeRows = (
	db: SqlDatabase,
	changes: ReturnType<typeof rowChangesFromMutation>,
) => {
	const moved = db.run(
		`UPDATE atm_subjects SET revision = ? WHERE subject_key = ? AND revision = ?`,
		[changes.nextRevision, SUBJECT_KEY, changes.expectedRevision],
	).changes;
	if (moved !== 1) throw new Error("stale revision");
	for (const upsert of changes.upserts)
		db.run(
			`INSERT INTO atm_rows (subject_key, table_name, row_id, data) VALUES (?, ?, ?, ?) ON CONFLICT (subject_key, table_name, row_id) DO UPDATE SET data = excluded.data`,
			[SUBJECT_KEY, upsert.table, upsert.id, JSON.stringify(upsert.data)],
		);
	for (const removed of changes.deletes)
		db.run(
			`DELETE FROM atm_rows WHERE subject_key = ? AND table_name = ? AND row_id = ?`,
			[SUBJECT_KEY, removed.table, removed.id],
		);
};

const outboxEvents = (db: SqlDatabase): AtmEvent[] =>
	db
		.all<{ body: string }>(`SELECT body FROM ledger_outbox ORDER BY id`)
		.map((row) => JSON.parse(row.body) as AtmEvent);

const lockOf = (mutation: unknown) =>
	(
		mutation as { changes: { table: string; op: string; row?: unknown }[] }
	).changes.find((change) => change.table === "locks" && change.op === "insert")
		?.row;

/** The stored rows of any subject of the school (the single-subject helpers above are the first family's). */
const rowsOfHolder = (db: SqlDatabase, holder: string) => {
	const key = `${SCHOOL}|live|${holder}`;
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
	return { key, rows, revision: subject?.revision ?? 0 };
};

/** A visit taken by hand for any family of the school, under a command id the caller picks. */
const spendFor = ({
	db,
	holder,
	commandId,
	at,
}: {
	db: SqlDatabase;
	holder: string;
	commandId: string;
	at: number;
}): RecordedEvents =>
	db.transaction(() => {
		const subject = { ...identity, customerId: holder };
		const { key, rows, revision } = rowsOfHolder(db, holder);
		const before = stateFromRows({ identity: subject, rows, revision });
		const { mutation } = runOnState({
			state: before,
			catalog,
			command: {
				schemaVersion: 1,
				type: "updateBalance",
				org,
				commandId,
				requestId: commandId,
				identity: subject,
				occurredAt: at,
				featureId: "visit",
				internalFeatureId: "feat_visit",
				addToBalance: -1,
			},
		});
		const changes = rowChangesFromMutation({
			mutation: mutation as never,
			rows,
			revision,
		});
		db.run(
			`UPDATE atm_subjects SET revision = ? WHERE subject_key = ? AND revision = ?`,
			[changes.nextRevision, key, changes.expectedRevision],
		);
		for (const upsert of changes.upserts)
			db.run(
				`INSERT INTO atm_rows (subject_key, table_name, row_id, data) VALUES (?, ?, ?, ?) ON CONFLICT (subject_key, table_name, row_id) DO UPDATE SET data = excluded.data`,
				[key, upsert.table, upsert.id, JSON.stringify(upsert.data)],
			);
		return recordEngineCommand({
			db,
			mutation: mutation as never,
			before: before as never,
			context: { tz: menu.timeZone, feature: "visit", reason: "visit taken" },
		});
	});

type Commanded = {
	mutation: ReturnType<typeof runOnState>["mutation"];
	recorded: RecordedEvents;
};

/** The family service: each command runs the engine, writes the rows and records the events in one transaction. */
const familyService = (db: SqlDatabase) => {
	let sequence = 0;
	const run = ({
		type,
		at,
		fields,
		context,
		commandId = `${type}_${++sequence}`,
		logsEveryCommand,
	}: {
		type: string;
		at: number;
		fields: Record<string, unknown>;
		context: Partial<AtmCommandContext>;
		commandId?: string;
		logsEveryCommand?: boolean;
	}): Commanded =>
		db.transaction(() => {
			const { rows, revision } = storedRows(db);
			const before = stateFromRows({ identity, rows, revision });
			const { mutation } = runOnState({
				state: before,
				catalog,
				command: {
					schemaVersion: 1,
					type,
					org,
					commandId,
					requestId: commandId,
					identity,
					occurredAt: at,
					...fields,
				},
			});
			const rejected =
				(mutation?.result as { status?: string } | undefined)?.status ===
				"rejected";
			// a command the engine rejected, or decided nothing for, changes no rows
			if (mutation && !rejected)
				writeRows(db, rowChangesFromMutation({ mutation, rows, revision }));
			const recorded = recordEngineCommand({
				db,
				mutation: mutation as never,
				before: before as never,
				context: {
					tz: menu.timeZone,
					feature: "visit",
					service: SERVICE,
					...context,
				},
				logsEveryCommand,
			});
			return { mutation, recorded };
		});
	return {
		run,
		/** A visit taken by hand, no hold first. */
		spend: (units: number, at: number) =>
			run({
				type: "updateBalance",
				at,
				fields: {
					featureId: "visit",
					internalFeatureId: "feat_visit",
					addToBalance: -units,
				},
				context: { reason: "visit taken" },
			}),
		/** The booking holds `units`: a `track` with a lock. */
		hold: (units: number, at: number, booking: string) =>
			run({
				type: "track",
				at,
				fields: {
					featureId: "visit",
					internalFeatureId: "feat_visit",
					value: units,
					overageBehavior: "reject",
					properties: null,
					usageEvent: null,
					lock: {
						id: `lock_${booking}`,
						lockId: booking,
						expiresAt: at + 2 * DAY,
						expiryAction: "confirm",
					},
				},
				context: {},
			}),
		/** The hold settles at `finalValue` (null: all of it spent; 0: released). */
		finalize: (held: Commanded, finalValue: number | null, at: number) =>
			run({
				type: "finalize",
				at,
				fields: {
					featureId: "visit",
					internalFeatureId: "feat_visit",
					lock: lockOf(held.mutation),
					finalValue,
					properties: null,
				},
				context: {},
			}),
		/** A canceled booking's credit goes back. */
		refund: (units: number, at: number) =>
			run({
				type: "updateBalance",
				at,
				fields: {
					featureId: "visit",
					internalFeatureId: "feat_visit",
					addToBalance: units,
				},
				context: { as: "refunded" },
			}),
	};
};

/** The create in January, with the member's tier granting 4 visits. */
const withCreate = () => {
	const school = newSchool();
	school.deliver(
		monthlyInvoice({
			invoiceId: "in_1",
			reason: "subscription_create",
			start: T0,
			end: T1,
		}),
		T0,
	);
	return school;
};

/** What a replay of the log must end on: the rows the service wrote, and the balances the engine counts from them. */
const expectReplayMatchesRows = (db: SqlDatabase, events: AtmEvent[]) => {
	const replayed = replayEvents({ events, catalog: catalogRows });
	const live = stateOf(db);
	expect(engineRowsOf(replayed.snapshot.states[HOLDER])).toBe(
		engineRowsOf(live),
	);
	const asOfMs = Date.parse(replayed.asOf as string);
	const [expected] = balancesOf({
		states: { [HOLDER]: live as never },
		holds: {},
		catalog,
		asOfMs,
	}).filter((balance) => balance.feature === "visit");
	const found = replayed.balances.find(
		(balance) => balance.feature === "visit",
	);
	expect(found?.avail).toBe(expected?.avail as number);
	return replayed;
};

/** A booking taken and settled, a visit by hand, and a refund: the commands the family service runs. */
const bookSomeVisits = (service: ReturnType<typeof familyService>) => {
	const commands: Commanded[] = [];
	commands.push(service.spend(1, T0 + DAY));
	const first = service.hold(2, T0 + 2 * DAY, "bk_1");
	commands.push(first, service.finalize(first, null, T0 + 3 * DAY));
	const second = service.hold(1, T0 + 4 * DAY, "bk_2");
	commands.push(second, service.finalize(second, 0, T0 + 5 * DAY));
	commands.push(service.refund(1, T0 + 6 * DAY));
	return commands;
};

const typesOf = (events: readonly AtmEvent[]) =>
	events
		.filter((event) => event.key === HOLDER)
		.map((event) => event.event_type);

describe("recordEngineCommand", () => {
	test("a spend, a hold, a finalize, a release and a refund are in the outbox, and the replay ends on the rows and balances", () => {
		const { db } = withCreate();
		const service = familyService(db);
		bookSomeVisits(service);
		// a hold left open: the replay counts it as held, not as available
		service.hold(1, T0 + 7 * DAY, "bk_3");

		const events = outboxEvents(db);
		expect(typesOf(events).filter((type) => type !== "credit.granted")).toEqual(
			[
				"credit.adjusted",
				"credit.held",
				"credit.spent",
				"credit.held",
				"credit.released",
				"credit.refunded",
				"credit.held",
			],
		);
		for (const event of events) expect(validateEvent(event).errors).toEqual([]);

		const replayed = expectReplayMatchesRows(db, events);
		const visits = replayed.balances.find(
			(balance) => balance.feature === "visit",
		);
		expect(visits?.held).toBe(1);
		// 4 granted, 1 by hand, 2 spent, 1 released, 1 refunded, 1 held: 4 - 1 - 2 + 1 - 1 = 1 available
		expect(visits?.avail).toBe(1);
	});

	test("a mutation dropped from the log is caught: a log without the finalize does not replay to the rows", () => {
		const { db } = withCreate();
		bookSomeVisits(familyService(db));
		const events = outboxEvents(db);
		const spent = events.find((event) => event.event_type === "credit.spent");
		expect(spent).toBeDefined();
		const without = events.filter((event) => event !== spent);
		const live = engineRowsOf(stateOf(db));
		let replayedRows: string | null = null;
		try {
			replayedRows = engineRowsOf(
				replayEvents({ events: without, catalog: catalogRows }).snapshot.states[
					HOLDER
				],
			);
		} catch (error) {
			expect(error).toBeInstanceOf(ReplayError);
		}
		// either the replay stops at the command that no longer fits, or it ends on other rows: never on the live ones
		expect(replayedRows).not.toBe(live);
		// and the whole log does
		expect(() => expectReplayMatchesRows(db, events)).not.toThrow();
	});

	test("a retried command (the same command id) writes no second event", () => {
		const { db } = withCreate();
		const service = familyService(db);
		const spent = service.spend(1, T0 + DAY);
		expect(spent.recorded.inserted).toBe(1);
		const before = outboxEvents(db).length;
		const context = {
			tz: menu.timeZone,
			feature: "visit",
			reason: "visit taken",
		};

		// recorded again as it is
		const again = recordEngineCommand({
			db,
			mutation: spent.mutation as never,
			before: null,
			context,
		});
		expect(again.events.length).toBe(1);
		expect(again.inserted).toBe(0);
		expect(outboxEvents(db).length).toBe(before);
	});

	test("the handler's grants and the service's spends share one outbox and replay together, in revision order", () => {
		const school = withCreate();
		const { db } = school;
		const service = familyService(db);
		bookSomeVisits(service);
		school.deliver(
			monthlyInvoice({
				invoiceId: "in_2",
				reason: "subscription_cycle",
				start: T1,
				end: T2,
			}),
			T1,
		);
		const held = service.hold(2, T1 + DAY, "bk_4");
		service.finalize(held, null, T1 + 2 * DAY);

		const events = outboxEvents(db);
		const order = replayOrder(events).filter((event) => event.key === HOLDER);
		const writers = order.map((event) =>
			/^[0-7][0-9A-HJKMNP-TV-Z]{25}:\d+$/.test(
				(event.payload.command as { commandId: string }).commandId,
			)
				? "handler"
				: "service",
		);
		const changes = writers.filter(
			(writer, index) => index === 0 || writer !== writers[index - 1],
		);
		expect(changes).toEqual(["handler", "service", "handler", "service"]);
		const revisions = order.map(
			(event) =>
				(event.payload.mutation as { revision: { after: number } }).revision
					.after,
		);
		expect(revisions).toEqual([...revisions].sort((a, b) => a - b));

		expectReplayMatchesRows(db, events);
	});

	test("an engine command that fails, is rejected or decides nothing writes no event", () => {
		const { db } = withCreate();
		const service = familyService(db);
		const baseline = outboxEvents(db).length;
		const rows = engineRowsOf(stateOf(db));

		// fails: a finalize of a lock no hold made; the engine throws and the transaction rolls back
		expect(() =>
			service.run({
				type: "finalize",
				at: T0 + DAY,
				fields: {
					featureId: "visit",
					internalFeatureId: "feat_visit",
					lock: { id: "lock_none", lockId: "bk_none", expiresAt: T0 + DAY },
					finalValue: null,
					properties: null,
				},
				context: {},
			}),
		).toThrow();

		// rejected: a hold for more than the member has
		const tooMany = service.hold(99, T0 + DAY, "bk_big");
		expect(
			(tooMany.mutation?.result as { status: string } | undefined)?.status,
		).toBe("rejected");
		expect(tooMany.recorded).toEqual({ events: [], inserted: 0 });

		// decides nothing: the engine returns no mutation for an add of zero
		const nothing = service.run({
			type: "updateBalance",
			at: T0 + DAY,
			fields: {
				featureId: "visit",
				internalFeatureId: "feat_visit",
				addToBalance: 0,
			},
			context: { reason: "nothing" },
		});
		expect(nothing.mutation).toBeNull();
		expect(nothing.recorded).toEqual({ events: [], inserted: 0 });

		expect(outboxEvents(db).length).toBe(baseline);
		expect(engineRowsOf(stateOf(db))).toBe(rows);
	});

	test("a command that moves no credits is a plan.changed, as the handler writes one, and replays", () => {
		const school = withCreate();
		const { db } = school;
		const service = familyService(db);
		// the cycle-end update after a renewal is the handler's plan.changed
		school.deliver(
			monthlyInvoice({
				invoiceId: "in_2",
				reason: "subscription_cycle",
				start: T1,
				end: T2,
			}),
			T1,
		);
		// a hold of nothing keeps a lock and moves no credits
		const empty = service.hold(0, T1 + DAY, "bk_zero");
		expect(empty.recorded.events.map((event) => event.event_type)).toEqual([
			"plan.changed",
		]);
		const events = outboxEvents(db);
		const fromHandler = events.find(
			(event) => event.event_type === "plan.changed" && event.cause,
		) as AtmEvent;
		const fromService = empty.recorded.events[0] as AtmEvent;
		expect(fromHandler).toBeDefined();
		expect(validateEvent(fromService).errors).toEqual([]);
		// the handler names the Stripe event as the cause; the service names one only when it passes `context.cause`
		expect(Object.keys(fromService).sort()).toEqual(
			Object.keys(fromHandler)
				.filter((field) => field !== "cause")
				.sort(),
		);
		expect(fromService.postings).toEqual([]);
		expect(fromService.idem).toBe(`plan:${empty.mutation?.id}`);
		expect(Object.keys(fromService.payload).sort()).toEqual(
			["command", "mutation"].sort(),
		);
		// the handler claims it logs every command; this caller has not said so
		expect(fromHandler.payload.complete).toBe(true);
		expect(fromService.payload.complete).toBeUndefined();

		expectReplayMatchesRows(db, events);
	});

	test("complete is written only when the caller says it records every command, and the log replays either way", () => {
		for (const logsEveryCommand of [false, true]) {
			const { db } = withCreate();
			const service = familyService(db);
			const held = service.run({
				type: "track",
				at: T0 + DAY,
				fields: {
					featureId: "visit",
					internalFeatureId: "feat_visit",
					value: 1,
					overageBehavior: "reject",
					properties: null,
					usageEvent: null,
					lock: {
						id: "lock_bk_1",
						lockId: "bk_1",
						expiresAt: T0 + 3 * DAY,
						expiryAction: "confirm",
					},
				},
				context: {},
				logsEveryCommand,
			});
			service.run({
				type: "track",
				at: T0 + 2 * DAY,
				fields: {
					featureId: "visit",
					internalFeatureId: "feat_visit",
					value: 0,
					overageBehavior: "reject",
					properties: null,
					usageEvent: null,
					lock: {
						id: "lock_bk_2",
						lockId: "bk_2",
						expiresAt: T0 + 4 * DAY,
						expiryAction: "confirm",
					},
				},
				context: {},
				logsEveryCommand,
			});
			const own = outboxEvents(db).filter(
				(event) =>
					!/^[0-7][0-9A-HJKMNP-TV-Z]{25}:\d+$/.test(
						(event.payload.command as { commandId: string }).commandId,
					),
			);
			expect(own.map((event) => event.event_type)).toEqual([
				"credit.held",
				"plan.changed",
			]);
			for (const event of own)
				expect(event.payload.complete).toBe(
					logsEveryCommand ? true : undefined,
				);
			expect(held.recorded.inserted).toBe(1);
			expectReplayMatchesRows(db, outboxEvents(db));
		}
	});
});

describe("recordEngineCommand refuses what it cannot record once", () => {
	test("a command id another subject of the school already used is refused, not dropped", () => {
		const school = withCreate();
		const { db } = school;
		const otherFamily = "family:fam_two";
		const invoice = monthlyInvoice({
			invoiceId: "in_two",
			reason: "subscription_create",
			start: T0,
			end: T1,
		});
		(invoice.data.object.metadata as Record<string, string>).family_id =
			"fam_two";
		school.deliver(invoice, T0);

		const first = spendFor({
			db,
			holder: HOLDER,
			commandId: "req-1",
			at: T0 + DAY,
		});
		expect(first.inserted).toBe(1);
		const events = outboxEvents(db).length;
		const revision = rowsOfHolder(db, otherFamily).revision;
		// the second family's spend would be one more event under the same idem, which the outbox drops while the rows move
		expect(() =>
			spendFor({ db, holder: otherFamily, commandId: "req-1", at: T0 + DAY }),
		).toThrow(/req-1/);
		// the transaction rolled back: no event, and the rows did not move either
		expect(outboxEvents(db).length).toBe(events);
		expect(rowsOfHolder(db, otherFamily).revision).toBe(revision);
		// a command id of its own books
		expect(
			spendFor({ db, holder: otherFamily, commandId: "req-2", at: T0 + DAY })
				.inserted,
		).toBe(1);
	});

	test("a command id reused for a second command of the subject is refused, and the log still replays", () => {
		const { db } = withCreate();
		const service = familyService(db);
		const held = service.run({
			type: "track",
			at: T0 + DAY,
			commandId: "bk_1",
			fields: {
				featureId: "visit",
				internalFeatureId: "feat_visit",
				value: 1,
				overageBehavior: "reject",
				properties: null,
				usageEvent: null,
				lock: {
					id: "lock_bk_1",
					lockId: "bk_1",
					expiresAt: T0 + 3 * DAY,
					expiryAction: "confirm",
				},
			},
			context: {},
		});
		// the booking's id names the finalize too: two commands under one id, which a replay cannot tell apart
		expect(() =>
			service.run({
				type: "finalize",
				at: T0 + 2 * DAY,
				commandId: "bk_1",
				fields: {
					featureId: "visit",
					internalFeatureId: "feat_visit",
					lock: lockOf(held.mutation),
					finalValue: null,
					properties: null,
				},
				context: {},
			}),
		).toThrow(/bk_1/);
		expectReplayMatchesRows(db, outboxEvents(db));
	});

	test("a retry that ran the engine again on rows that moved on is refused: its rows would change and its event would not", () => {
		const { db } = withCreate();
		const service = familyService(db);
		const spent = service.spend(1, T0 + DAY);
		const before = outboxEvents(db).length;
		const rerun = runOnState({
			state: stateOf(db),
			catalog,
			command: spent.mutation?.command as never,
		});
		expect(() =>
			recordEngineCommand({
				db,
				mutation: rerun.mutation as never,
				before: null,
				context: {
					tz: menu.timeZone,
					feature: "visit",
					reason: "visit taken",
				},
			}),
		).toThrow(/already/);
		expect(outboxEvents(db).length).toBe(before);
	});

	test("a reset, which moves several features, is refused", () => {
		const { db } = withCreate();
		const service = familyService(db);
		service.spend(2, T0 + DAY);
		const before = outboxEvents(db).length;
		// every row is due: the visits and the retreat refill together, and the retreat's credit would be booked as visits
		expect(() =>
			service.run({
				type: "reset",
				at: T0 + 400 * DAY,
				fields: {},
				context: { plan: "sparkle-4" },
			}),
		).toThrow(/reset/);
		expect(outboxEvents(db).length).toBe(before);
	});

	test("a command that moves no credits carries the source and ingest time the caller gave, as the credit events do", () => {
		const { db } = withCreate();
		const service = familyService(db);
		const ingestTime = "2026-01-17T18:00:00Z";
		const empty = service.run({
			type: "track",
			at: T0 + DAY,
			fields: {
				featureId: "visit",
				internalFeatureId: "feat_visit",
				value: 0,
				overageBehavior: "reject",
				properties: null,
				usageEvent: null,
				lock: {
					id: "lock_bk_zero",
					lockId: "bk_zero",
					expiresAt: T0 + 3 * DAY,
					expiryAction: "confirm",
				},
			},
			context: { source: "queue", ingestTime },
		});
		const [event] = empty.recorded.events;
		expect(event?.event_type).toBe("plan.changed");
		expect(event?.source).toBe("queue");
		expect(event?.ingest_time).toBe(ingestTime);
	});
});

describe("recordLapse", () => {
	test("the rollover that lapses is booked once, and the log replays", () => {
		const school = withCreate();
		const { db } = school;
		const service = familyService(db);
		service.spend(1, T0 + DAY);
		// the renewal carries the leftover visits over for a month
		school.deliver(
			monthlyInvoice({
				invoiceId: "in_2",
				reason: "subscription_cycle",
				start: T1,
				end: T2,
			}),
			T1,
		);
		const atMs = T1 + 40 * DAY;
		const input = {
			db,
			state: stateOf(db) as never,
			featureOf,
			feature: "visit",
			atMs,
			tz: menu.timeZone,
		};
		const first = recordLapse(input);
		expect(first.events.map((event) => event.event_type)).toEqual([
			"credit.expired",
		]);
		expect(first.inserted).toBe(1);
		const again = recordLapse(input);
		expect(again.events.length).toBe(1);
		expect(again.inserted).toBe(0);

		const events = outboxEvents(db);
		for (const event of events) expect(validateEvent(event).errors).toEqual([]);
		const replayed = replayEvents({
			events,
			catalog: catalogRows,
			asOf: new Date(atMs).toISOString(),
		});
		expect(engineRowsOf(replayed.snapshot.states[HOLDER])).toBe(
			engineRowsOf(stateOf(db)),
		);
	});
});

describe("the log the service and the handler wrote, shipped and journaled", () => {
	test.skipIf(!hasHledger)(
		"hledger balances the credit accounts to what the commands spent and accepts the journal",
		async () => {
			const school = withCreate();
			const { db } = school;
			const service = familyService(db);
			bookSomeVisits(service);
			school.deliver(
				monthlyInvoice({
					invoiceId: "in_2",
					reason: "subscription_cycle",
					start: T1,
					end: T2,
				}),
				T1,
			);
			const held = service.hold(2, T1 + DAY, "bk_4");
			service.finalize(held, null, T1 + 2 * DAY);

			const root = await tmp("outbox-record");
			try {
				const shipped = await shipOutbox({
					db,
					store: new FolderStore({ root }),
					school: SCHOOL,
					nowMs: () => T2,
				});
				expect(shipped.conflicts).toEqual([]);
				expect(shipped.shipped).toBe(outboxEvents(db).length);
				for (const month of ["2026-01", "2026-02"])
					await journalMonth({ root, school: SCHOOL, month });
				const books = join(root, "schools", SCHOOL);
				const hledger = (args: string[]) => {
					const run = Bun.spawnSync(
						["hledger", "-f", "main.journal", ...args],
						{
							cwd: books,
							stdout: "pipe",
							stderr: "pipe",
						},
					);
					expect(run.stderr.toString()).toBe("");
					expect(run.exitCode).toBe(0);
					return run.stdout.toString();
				};
				hledger(["check", "balanced", "accounts", "commodities"]);

				// the report: each account's balance in visits, by name
				const balances = new Map<string, number>();
				for (const line of hledger(["bal", "credits:", "-O", "csv"])
					.trim()
					.split("\n")
					.slice(1)) {
					const [account, amount] = [...line.matchAll(/"([^"]*)"/g)].map(
						(match) => match[1] as string,
					);
					if (account && amount)
						balances.set(account, Number.parseInt(amount, 10));
				}
				// spent: 2 (the first booking) minus 1 refunded, then 2 more after the renewal
				expect(balances.get(`credits:spent:${SERVICE}`)).toBe(3);
				// what was held is settled: the second booking was released, the others spent
				expect(balances.get(`credits:held:${HOLDER}:visit`)).toBeUndefined();
				// the engine's own count: the rows the service wrote, at the end of the log
				const available = balances.get(`credits:avail:${HOLDER}:visit`);
				const replayed = expectReplayMatchesRows(db, outboxEvents(db));
				expect(available).toBe(
					replayed.balances.find((balance) => balance.feature === "visit")
						?.avail as number,
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
