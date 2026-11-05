import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { menuCatalogRows } from "../src/billing/grants.js";
import { mappingFor, normalize } from "../src/billing/normalize.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	type BillingRow,
	sortRows,
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
import {
	signStripePayload,
	verifyStripeSignature,
} from "../src/handler/stripe-signature.js";
import { handleStripeWebhook } from "../src/handler/stripe-webhook.js";
import type {
	SqlDatabase,
	WebhookContext,
	WebhookDeps,
} from "../src/handler/types.js";
import { ULID_PATTERN } from "../src/ledger/ids.js";
import { balancesOf } from "../src/ledger/replay.js";
import { toCatalog } from "../src/ledger/run.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent } from "../src/types.js";
import { createStore } from "./billing-store.js";
import {
	chargeRefunded,
	disputeEvent,
	invoicePaid,
	paymentIntentOf,
	priceIdOf,
	type RawEvent,
	subscriptionEvent,
} from "./stripe-events.js";
import { shapeProblems } from "./stripe-shape.js";

const SCHOOL = "sch_vol";
const FAMILY = "fam_8k2";
const HOLDER = `family:${FAMILY}`;
const SUBJECT_KEY = `${SCHOOL}|live|${HOLDER}`;
const MENU_VERSION = 3;
// Not a real secret, and deliberately short of anything a secret scanner would flag.
const SECRET = "whsec_unit_test_secret";
const menu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
const D = (s: string) => Date.parse(s);
const T0 = D("2026-01-15T18:00:00Z");
const T1 = D("2026-02-15T18:00:00Z");
const T2 = D("2026-03-15T18:00:00Z");
const MINUTE = 60_000;
const metadata = { b4u_school: SCHOOL, family_id: FAMILY };

const tierKey = (tierId: string, interval: "month" | "year", world = menu) => {
	const price = world.tiers
		.find((t) => t.id === tierId)
		?.prices.find((p) => p.interval === interval);
	return lookupKeyOf(
		SCHOOL,
		tierPriceKey(tierId, interval),
		price?.amount as number,
		world.currency,
	);
};

const contextFor = (world: Menu): WebhookContext => ({
	menu: world,
	menuVersion: MENU_VERSION,
	policy: DEFAULT_POLICY,
	policyVersion: 1,
	catalog: menuCatalogRows({ menu: world, school: SCHOOL }),
	priceIds: Object.fromEntries(
		[...menuLineItems(SCHOOL, world).keys()].map((key) => [
			key,
			priceIdOf(key),
		]),
	),
});

const create = (): RawEvent =>
	invoicePaid({
		eventId: "evt_create",
		invoiceId: "in_1",
		at: T0 + 10_000,
		paidAt: T0 + 5000,
		subscriptionId: "sub_1",
		reason: "subscription_create",
		periodStart: T0,
		periodEnd: T1,
		lines: [
			{
				lookupKey: tierKey("sparkle-2", "month"),
				amount: 26000,
				interval: "month",
			},
		],
		metadata,
	});

const renew = (): RawEvent =>
	invoicePaid({
		eventId: "evt_cycle_2",
		invoiceId: "in_2",
		at: T1 + 10_000,
		subscriptionId: "sub_1",
		reason: "subscription_cycle",
		periodStart: T1,
		periodEnd: T2,
		lines: [
			{
				lookupKey: tierKey("sparkle-2", "month"),
				amount: 26000,
				interval: "month",
			},
		],
		metadata,
	});

const refund = (invoiceId: string): RawEvent =>
	chargeRefunded({
		eventId: "evt_re_1",
		refundId: "re_1",
		chargeId: `ch_${invoiceId}`,
		invoiceId,
		amount: 26000,
		chargeAmount: 26000,
		at: T1 + 3_600_000,
	});

const recordedPaymentPath = `${import.meta.dir}/../fixtures/billing/stripe/recorded/invoice_payment.paid.json`;
const recordedPayment = (): RawEvent =>
	JSON.parse(readFileSync(recordedPaymentPath, "utf8"));

/** An `invoice_payment.paid` event in the recorded shape: the invoice, and the payment intent a test gives its payment. */
const invoicePayment = (e: {
	eventId: string;
	invoiceId: string;
	at: number;
	payment?: { type: string; [key: string]: string };
}): RawEvent => {
	const event = recordedPayment();
	event.id = e.eventId;
	event.created = Math.floor(e.at / 1000);
	event.data.object.created = event.created;
	event.data.object.invoice = e.invoiceId;
	event.data.object.payment = e.payment ?? {
		type: "payment_intent",
		payment_intent: paymentIntentOf(e.invoiceId),
	};
	return event;
};

const link = (invoiceId: string, at = T1 + 20_000): RawEvent =>
	invoicePayment({ eventId: `evt_pay_${invoiceId}`, invoiceId, at });

/** A database wrapper that runs `before` ahead of the calls it matches; each hook is a function that may do or throw. */
const intercept = (
	base: SqlDatabase,
	hooks: {
		run?: (sql: string) => void;
		all?: (sql: string) => void;
		transaction?: () => void;
	},
): SqlDatabase => ({
	exec: (sql) => base.exec(sql),
	all: (sql, params) => {
		hooks.all?.(sql);
		return base.all(sql, params);
	},
	run: (sql, params) => {
		hooks.run?.(sql);
		return base.run(sql, params);
	},
	transaction: (fn) => {
		hooks.transaction?.();
		return base.transaction(fn);
	},
});

const harness = (
	options: {
		world?: Menu | null;
		claimStaleAfterMs?: number;
		workerId?: string;
		/** The caller's optional `paymentRefs` hook (an `invoice.paid` names its payment intent); off by default. */
		paymentRefsHook?: boolean;
	} = {},
) => {
	const raw = new Database(":memory:");
	const db = bunSqlite(raw);
	db.exec(HANDLER_DDL);
	const clock = { now: T0 + 20_000 };
	const calls = { context: 0 };
	let world: Menu | null = options.world === undefined ? menu : options.world;
	const deps: WebhookDeps = {
		db,
		secret: SECRET,
		schoolId: SCHOOL,
		nowMs: () => clock.now,
		workerId: options.workerId ?? "worker-a",
		claimStaleAfterMs: options.claimStaleAfterMs,
		context: () => {
			calls.context += 1;
			return world ? contextFor(world) : null;
		},
		paymentRefs: options.paymentRefsHook
			? (event) => {
					const { type, data } = event as {
						type: string;
						data: { object: { id: string } };
					};
					return type === "invoice.paid"
						? [paymentIntentOf(data.object.id)]
						: [];
				}
			: undefined,
	};
	const request = (event: unknown, signedAtMs = clock.now) => {
		const payload = JSON.stringify(event);
		return {
			payload,
			signatureHeader: signStripePayload({
				payload,
				secret: SECRET,
				timestampSeconds: Math.floor(signedAtMs / 1000),
			}),
		};
	};
	return {
		db,
		raw,
		deps,
		clock,
		calls,
		request,
		setWorld: (next: Menu | null) => {
			world = next;
		},
		deliver: (event: unknown, using: WebhookDeps = deps) =>
			handleStripeWebhook(using, request(event)),
		count: (table: string) =>
			(raw.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number })
				.n,
		claim: (stripeEventId: string) =>
			raw
				.query(`SELECT * FROM atm_event_claims WHERE event_id = ?`)
				.get(stripeEventId) as {
				state: string;
				claimed_at: number;
				claimed_by: string;
				outcome: string | null;
			} | null,
		revision: () =>
			(
				raw
					.query(`SELECT revision FROM atm_subjects WHERE subject_key = ?`)
					.get(SUBJECT_KEY) as { revision: number } | null
			)?.revision ?? 0,
		rows: (): BillingRow[] =>
			sortRows(
				(
					raw
						.query(
							`SELECT table_name, row_id, data FROM atm_rows WHERE subject_key = ?`,
						)
						.all(SUBJECT_KEY) as {
						table_name: string;
						row_id: string;
						data: string;
					}[]
				).map((r) => ({
					table: r.table_name,
					id: r.row_id,
					data: JSON.parse(r.data),
				})) as BillingRow[],
			),
		outbox: () =>
			raw.query(`SELECT * FROM ledger_outbox ORDER BY id`).all() as {
				school_id: string;
				id: string;
				idem: string;
				date: string;
				body: string;
				batch_key: string | null;
				shipped_at: number | null;
			}[],
	};
};
type Harness = ReturnType<typeof harness>;

const availOf = (h: Harness, asOfMs: number, feature = "visit") => {
	const state = stateFromRows({
		identity: {
			orgId: SCHOOL,
			env: "live",
			customerId: HOLDER,
			entityId: null,
		},
		revision: h.revision(),
		rows: h.rows(),
	});
	if (!state) return 0;
	return (
		balancesOf({
			states: { [HOLDER]: state as never },
			holds: {},
			catalog: toCatalog(menuCatalogRows({ menu, school: SCHOOL })),
			asOfMs,
		}).find((b) => b.feature === feature)?.avail ?? 0
	);
};

const nothingWritten = (h: Harness) => {
	expect(h.count("atm_rows")).toBe(0);
	expect(h.count("atm_subjects")).toBe(0);
	expect(h.count("ledger_outbox")).toBe(0);
	expect(h.count("atm_payment_index")).toBe(0);
	expect(h.count("atm_invoice_index")).toBe(0);
};

describe("verifyStripeSignature", () => {
	const payload = '{"id":"evt_1"}';
	const nowMs = 1_800_000_000_000;
	const seconds = nowMs / 1000;
	const sign = (secret = SECRET, at = seconds) =>
		signStripePayload({ payload, secret, timestampSeconds: at });

	test("a valid signature passes", () => {
		expect(
			verifyStripeSignature({ payload, header: sign(), secret: SECRET, nowMs }),
		).toEqual({ ok: true });
	});

	test("a wrong secret does not match", () => {
		expect(
			verifyStripeSignature({
				payload,
				header: sign("whsec_other"),
				secret: SECRET,
				nowMs,
			}),
		).toEqual({ ok: false, reason: "no_match" });
	});

	test("a timestamp outside the tolerance is stale, either way, and the tolerance can be set", () => {
		const check = (at: number, toleranceSeconds?: number) =>
			verifyStripeSignature({
				payload,
				header: sign(SECRET, at),
				secret: SECRET,
				nowMs,
				toleranceSeconds,
			});
		expect(check(seconds - 301)).toEqual({
			ok: false,
			reason: "stale_timestamp",
		});
		expect(check(seconds + 301)).toEqual({
			ok: false,
			reason: "stale_timestamp",
		});
		expect(check(seconds - 300)).toEqual({ ok: true });
		expect(check(seconds - 301, 600)).toEqual({ ok: true });
	});

	test("a tampered payload does not match", () => {
		expect(
			verifyStripeSignature({
				payload: `${payload} `,
				header: sign(),
				secret: SECRET,
				nowMs,
			}),
		).toEqual({ ok: false, reason: "no_match" });
	});

	test("any one of several v1 values may match", () => {
		const good = sign();
		const [timestamp, signature] = good.split(",") as [string, string];
		const wrongLength = "v1=abcd";
		const notHex = "v1=zz";
		const other = sign("whsec_other").split(",")[1] as string;
		for (const header of [
			`${timestamp},${other},${signature}`,
			`${timestamp},${signature},${other}`,
			`${timestamp},${wrongLength},${notHex},${signature}`,
		])
			expect(
				verifyStripeSignature({ payload, header, secret: SECRET, nowMs }),
			).toEqual({ ok: true });
		expect(
			verifyStripeSignature({
				payload,
				header: `${timestamp},${other},${wrongLength}`,
				secret: SECRET,
				nowMs,
			}),
		).toEqual({ ok: false, reason: "no_match" });
	});

	test("a header without a timestamp or a v1 is malformed", () => {
		const signature = sign().split(",")[1] as string;
		for (const header of [
			"",
			"garbage",
			signature,
			`t=${seconds}`,
			`t=abc,${signature}`,
		])
			expect(
				verifyStripeSignature({ payload, header, secret: SECRET, nowMs }),
			).toEqual({ ok: false, reason: "malformed" });
	});
});

describe("handleStripeWebhook", () => {
	test("a bad signature is 401 and touches nothing", () => {
		const h = harness();
		const wrong = signStripePayload({
			payload: JSON.stringify(create()),
			secret: "whsec_other",
			timestampSeconds: Math.floor(h.clock.now / 1000),
		});
		const response = handleStripeWebhook(h.deps, {
			payload: JSON.stringify(create()),
			signatureHeader: wrong,
		});
		expect(response).toEqual({
			status: 401,
			body: { outcome: "bad_signature", reason: "no_match" },
		});
		expect(h.count("atm_event_claims")).toBe(0);
		nothingWritten(h);
	});

	test("a signed body that is not a Stripe event is 400", () => {
		const h = harness();
		for (const body of [
			"not json",
			"[]",
			'{"id":"evt_x"}',
			'{"id":"evt_x","type":"invoice.paid","created":"soon","data":{"object":{}}}',
		]) {
			const response = handleStripeWebhook(h.deps, {
				payload: body,
				signatureHeader: signStripePayload({
					payload: body,
					secret: SECRET,
					timestampSeconds: Math.floor(h.clock.now / 1000),
				}),
			});
			expect(response.status).toBe(400);
			expect(response.body.outcome).toBe("bad_request");
		}
		expect(h.count("atm_event_claims")).toBe(0);
	});

	test("create, renew and refund end with the balances of the in-memory family service", () => {
		const h = harness();
		const store = createStore({
			menu,
			school: SCHOOL,
			family: FAMILY,
			menuVersion: MENU_VERSION,
		});
		const history: [RawEvent, number][] = [
			[create(), T0 + 10_000],
			[renew(), T1 + 10_000],
			[refund("in_2"), T1 + 3_600_000],
		];
		for (const [event, at] of history) {
			h.clock.now = at;
			const response = h.deliver(event);
			expect(response.status).toBe(200);
			expect(response.body.outcome).toBe("applied");
			store.handle(event, at);
			// The payment's link comes in its own event, which moves no credits.
			if (event.type === "invoice.paid") {
				const revision = h.revision();
				const linked = h.deliver(link(event.data.object.id, at + 1000));
				expect(linked.body.outcome).toBe("applied");
				expect(h.revision()).toBe(revision);
			}
			expect(h.revision()).toBe(store.revision);
			expect(h.rows()).toEqual(sortRows(store.rows));
			for (const asOf of [at, at + 1000, T2, T2 + 1000])
				expect(availOf(h, asOf)).toBe(store.avail(asOf));
		}
		expect(availOf(h, T1 + 3_700_000)).toBe(2);
		expect(h.outbox().map((row) => row.id)).toEqual(
			store.events.map((event) => event.id).sort(),
		);
		expect(h.outbox().length).toBeGreaterThan(0);
		for (const stripeId of ["evt_create", "evt_cycle_2", "evt_re_1"])
			expect(h.claim(stripeId)).toMatchObject({
				state: "done",
				outcome: "applied",
				claimed_by: "worker-a",
			});
	});

	test("every outbox event is valid, names its cause, and is the event's canonical line", () => {
		const h = harness();
		h.deliver(create());
		const rows = h.outbox();
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			const event = JSON.parse(row.body) as AtmEvent;
			expect(validateEvent(event).errors).toEqual([]);
			expect(event.cause).toMatch(new RegExp(ULID_PATTERN));
			expect(event.cause).not.toBe(event.id);
			expect(row).toMatchObject({
				school_id: SCHOOL,
				id: event.id,
				idem: event.idem,
				date: event.date,
				batch_key: null,
				shipped_at: null,
			});
			expect(row.body).not.toContain("\n");
		}
	});

	test("the same Stripe event twice: the second is a duplicate and changes nothing", () => {
		const h = harness();
		expect(h.deliver(create()).body.outcome).toBe("applied");
		const rows = h.rows();
		const outbox = h.outbox();
		const claim = h.claim("evt_create");
		h.clock.now += 10 * MINUTE;
		const again = h.deliver(create());
		expect(again).toEqual({
			status: 200,
			body: { outcome: "duplicate", stripeEventId: "evt_create" },
		});
		expect(h.rows()).toEqual(rows);
		expect(h.revision()).toBe(1);
		expect(h.outbox()).toEqual(outbox);
		expect(h.claim("evt_create")).toEqual(claim);
	});

	test("a fresh claim held by another worker is busy and nothing is written", () => {
		const h = harness();
		h.raw.run(
			`INSERT INTO atm_event_claims (event_id, state, claimed_at, claimed_by) VALUES ('evt_create', 'claimed', ?, 'worker-b')`,
			[h.clock.now - MINUTE],
		);
		const response = h.deliver(create());
		expect(response.status).toBe(409);
		expect(response.body.outcome).toBe("busy");
		nothingWritten(h);
		expect(h.claim("evt_create")).toMatchObject({
			state: "claimed",
			claimed_by: "worker-b",
		});
	});

	test("a stale claim is taken over and the event is processed exactly once", () => {
		const h = harness();
		const staleAt = h.clock.now - 10 * MINUTE;
		h.raw.run(
			`INSERT INTO atm_event_claims (event_id, state, claimed_at, claimed_by) VALUES ('evt_create', 'claimed', ?, 'worker-b')`,
			[staleAt],
		);
		const response = h.deliver(create());
		expect(response.body.outcome).toBe("applied");
		expect(h.claim("evt_create")).toMatchObject({
			state: "done",
			claimed_by: "worker-a",
			outcome: "applied",
		});
		const outbox = h.outbox();
		expect(h.revision()).toBe(1);
		expect(h.deliver(create()).body.outcome).toBe("duplicate");
		expect(h.outbox()).toEqual(outbox);
		expect(h.revision()).toBe(1);
	});

	test("the stale window is the deps' claimStaleAfterMs", () => {
		const h = harness({ claimStaleAfterMs: 2 * MINUTE });
		h.raw.run(
			`INSERT INTO atm_event_claims (event_id, state, claimed_at, claimed_by) VALUES ('evt_create', 'claimed', ?, 'worker-b')`,
			[h.clock.now - MINUTE],
		);
		expect(h.deliver(create()).body.outcome).toBe("busy");
		h.clock.now += 2 * MINUTE;
		expect(h.deliver(create()).body.outcome).toBe("applied");
	});

	test("two takers of one stale claim: exactly one wins", () => {
		const h = harness();
		h.raw.run(
			`INSERT INTO atm_event_claims (event_id, state, claimed_at, claimed_by) VALUES ('evt_create', 'claimed', ?, 'worker-x')`,
			[h.clock.now - 10 * MINUTE],
		);
		const workerB: WebhookDeps = { ...h.deps, workerId: "worker-b" };
		let raced: ReturnType<typeof handleStripeWebhook> | null = null;
		// Worker A has read the stale claim and is about to take it over; worker B takes it over, and finishes, first.
		const workerA: WebhookDeps = {
			...h.deps,
			db: intercept(h.db, {
				run: (sql) => {
					if (
						raced ||
						!sql.startsWith("UPDATE atm_event_claims SET claimed_at")
					)
						return;
					raced = h.deliver(create(), workerB);
				},
			}),
		};
		const responseA = h.deliver(create(), workerA);
		expect(raced as unknown).toMatchObject({ body: { outcome: "applied" } });
		expect(responseA.body.outcome).toBe("busy");
		expect(h.claim("evt_create")).toMatchObject({
			claimed_by: "worker-b",
			state: "done",
		});
		expect(h.revision()).toBe(1);
		const outbox = h.outbox();
		expect(outbox.length).toBeGreaterThan(0);
		expect(new Set(outbox.map((row) => row.idem)).size).toBe(outbox.length);
	});

	test("a worker that stalls after its claim and loses it commits nothing", () => {
		const h = harness();
		let transactions = 0;
		const stalled: WebhookDeps = {
			...h.deps,
			db: intercept(h.db, {
				transaction: () => {
					transactions += 1;
					// the claim's own transaction is the first; the work's is the second
					if (transactions === 2)
						h.raw.run(
							`UPDATE atm_event_claims SET claimed_by = 'worker-b', claimed_at = claimed_at + 1`,
						);
				},
			}),
		};
		const response = h.deliver(create(), stalled);
		expect(response.body.outcome).toBe("busy");
		nothingWritten(h);
		expect(h.claim("evt_create")).toMatchObject({
			state: "claimed",
			claimed_by: "worker-b",
		});
	});

	test("a crash inside the transaction leaves rows and outbox alone and the claim claimed; a later delivery succeeds", () => {
		const h = harness();
		// A throw from the context, and one from the database after the rows were written.
		const failures: (() => WebhookDeps)[] = [
			() => ({
				...h.deps,
				context: () => {
					throw new Error("context blew up");
				},
			}),
			() => ({
				...h.deps,
				db: intercept(h.db, {
					run: (sql) => {
						if (sql.startsWith("INSERT INTO ledger_outbox"))
							throw new Error("disk full");
					},
				}),
			}),
		];
		for (const failing of failures) {
			expect(() => h.deliver(create(), failing())).toThrow();
			nothingWritten(h);
			expect(h.claim("evt_create")).toMatchObject({
				state: "claimed",
				claimed_by: "worker-a",
			});
			// Stripe's retry inside the window finds the claim fresh ...
			expect(h.deliver(create()).body.outcome).toBe("busy");
			nothingWritten(h);
			// ... and one after it takes the claim over.
			h.clock.now += 10 * MINUTE;
			const retried = h.deliver(create(), {
				...h.deps,
				workerId: "worker-c",
			});
			expect(retried.body.outcome).toBe("applied");
			expect(h.claim("evt_create")).toMatchObject({
				state: "done",
				claimed_by: "worker-c",
			});
			expect(h.revision()).toBe(1);
			// reset for the next failure mode
			h.raw.run(`DELETE FROM atm_rows`);
			h.raw.run(`DELETE FROM atm_subjects`);
			h.raw.run(`DELETE FROM ledger_outbox`);
			h.raw.run(`DELETE FROM atm_payment_index`);
			h.raw.run(`DELETE FROM atm_invoice_index`);
			h.raw.run(`DELETE FROM atm_event_claims`);
		}
	});

	test("a stale revision is retried and the event is applied once", () => {
		const h = harness();
		let bumped = false;
		const racing: WebhookDeps = {
			...h.deps,
			db: intercept(h.db, {
				all: (sql) => {
					if (bumped || !sql.includes("FROM atm_rows")) return;
					bumped = true;
					// another writer moves the subject after this attempt read it (undone with the attempt)
					h.raw.run(
						`INSERT INTO atm_subjects (subject_key, revision) VALUES (?, 7) ON CONFLICT (subject_key) DO UPDATE SET revision = revision + 1`,
						[SUBJECT_KEY],
					);
				},
			}),
		};
		const response = h.deliver(create(), racing);
		expect(response.body.outcome).toBe("applied");
		expect(h.calls.context).toBe(2);
		expect(h.revision()).toBe(1);
		expect(h.claim("evt_create")?.state).toBe("done");
	});

	test("a revision that stays stale for 3 attempts is 409 and the claim is released", () => {
		const h = harness();
		const racing: WebhookDeps = {
			...h.deps,
			db: intercept(h.db, {
				all: (sql) => {
					if (!sql.includes("FROM atm_rows")) return;
					h.raw.run(
						`INSERT INTO atm_subjects (subject_key, revision) VALUES (?, 7) ON CONFLICT (subject_key) DO UPDATE SET revision = revision + 1`,
						[SUBJECT_KEY],
					);
				},
			}),
		};
		const response = h.deliver(create(), racing);
		expect(response.status).toBe(409);
		expect(response.body.outcome).toBe("stale_revision");
		expect(h.calls.context).toBe(3);
		expect(h.count("atm_rows")).toBe(0);
		expect(h.count("atm_subjects")).toBe(0);
		expect(h.count("ledger_outbox")).toBe(0);
		expect(h.claim("evt_create")).toBeNull();
		// the next delivery is not held up by a claim
		expect(h.deliver(create()).body.outcome).toBe("applied");
	});

	test("an event the menu cannot decide is 422, writes nothing and keeps no claim; once the menu is fixed the same event applies", () => {
		const h = harness();
		const without = structuredClone(menu);
		without.tiers = without.tiers.filter((tier) => tier.id !== "sparkle-2");
		h.setWorld(without);
		const response = h.deliver(create());
		expect(response.status).toBe(422);
		expect(response.body).toMatchObject({
			outcome: "refused",
			reason: "unmatched_line",
			stripeEventId: "evt_create",
		});
		nothingWritten(h);
		expect(h.claim("evt_create")).toBeNull();

		h.setWorld(menu);
		expect(h.deliver(create()).body.outcome).toBe("applied");
		expect(h.revision()).toBe(1);
	});

	test("an invoice with half of the family's metadata is 422 missing_metadata, before any claim", () => {
		const h = harness();
		for (const half of [{ b4u_school: SCHOOL }, { family_id: FAMILY }]) {
			const event = create();
			event.data.object.metadata = {};
			event.data.object.parent.subscription_details.metadata = half;
			const response = h.deliver(event);
			expect(response.status).toBe(422);
			expect(response.body).toMatchObject({
				outcome: "refused",
				reason: "missing_metadata",
			});
		}
		expect(h.count("atm_event_claims")).toBe(0);
		nothingWritten(h);
	});

	test("an invoice or subscription with no family metadata at all (another product) is 200 ignored, recorded done", () => {
		const h = harness();
		const invoice = create();
		invoice.data.object.metadata = {};
		invoice.data.object.parent.subscription_details.metadata = {};
		const subscription = subscriptionEvent({
			type: "customer.subscription.created",
			eventId: "evt_sub_other_product",
			subscriptionId: "sub_other_product",
			status: "active",
			items: [{ lookupKey: "some_other_product", interval: "month" }],
			periodStart: T0,
			periodEnd: T1,
			at: T0 + 10_000,
			metadata: null,
		});
		for (const event of [invoice, subscription]) {
			expect(h.deliver(event)).toEqual({
				status: 200,
				body: { outcome: "ignored", stripeEventId: event.id },
			});
			expect(h.claim(event.id)).toMatchObject({
				state: "done",
				outcome: "ignored",
			});
			expect(h.deliver(event).body.outcome).toBe("duplicate");
		}
		expect(h.calls.context).toBe(0);
		nothingWritten(h);
	});

	test("a school the service does not serve is 422 and keeps no claim", () => {
		const h = harness({ world: null });
		const response = h.deliver(create());
		expect(response.status).toBe(422);
		expect(response.body.outcome).toBe("unknown_school");
		expect(h.count("atm_event_claims")).toBe(0);
		nothingWritten(h);
	});

	test("a retryable refusal (a cancel before any invoice) is 409, writes nothing and keeps no claim", () => {
		const h = harness();
		const event = subscriptionEvent({
			type: "customer.subscription.deleted",
			eventId: "evt_sub_del",
			subscriptionId: "sub_1",
			status: "canceled",
			items: [{ lookupKey: tierKey("sparkle-2", "month"), interval: "month" }],
			periodStart: T0,
			periodEnd: T1,
			at: T0 + 86_400_000,
			metadata,
		});
		h.clock.now = T0 + 86_400_000;
		const response = h.deliver(event);
		expect(response.status).toBe(409);
		expect(response.body).toMatchObject({
			outcome: "refused",
			reason: "unknown_subscription",
		});
		nothingWritten(h);
		expect(h.claim("evt_sub_del")).toBeNull();
	});

	test("an event type we do not map is 200 ignored and records no claim, so a later version that maps it can take a re-send", () => {
		const h = harness();
		const event = { ...create(), id: "evt_other", type: "customer.created" };
		const response = h.deliver(event);
		expect(response).toEqual({
			status: 200,
			body: { outcome: "ignored", stripeEventId: "evt_other" },
		});
		expect(h.claim("evt_other")).toBeNull();
		nothingWritten(h);
		expect(h.deliver(event).body.outcome).toBe("ignored");
		expect(h.count("atm_event_claims")).toBe(0);
	});

	test("the outbox keeps one row per (school, idem)", () => {
		const first = harness();
		first.deliver(create());
		const [reference] = first.outbox();
		expect(reference).toBeDefined();

		const h = harness();
		// An event with this idem is already in the outbox, under another id and body: the insert drops ours.
		h.raw.run(
			`INSERT INTO ledger_outbox (school_id, id, idem, date, body) VALUES (?, '01ARZ3NDEKTSV4RRFFQ69G5FAV', ?, ?, 'seeded')`,
			[SCHOOL, reference?.idem as string, reference?.date as string],
		);
		expect(h.deliver(create()).body.outcome).toBe("applied");
		const rows = h.outbox();
		expect(rows.filter((row) => row.idem === reference?.idem)).toHaveLength(1);
		expect(rows.find((row) => row.idem === reference?.idem)?.body).toBe(
			"seeded",
		);
		expect(new Set(rows.map((row) => row.idem)).size).toBe(rows.length);
		expect(h.revision()).toBe(1);
	});

	test("invoice.paid records its invoice's subject in the invoice index, once, and no payment ref", () => {
		const h = harness();
		h.deliver(create());
		expect(h.raw.query(`SELECT * FROM atm_invoice_index`).all()).toEqual([
			{ invoice_id: "in_1", subject_key: SUBJECT_KEY },
		]);
		expect(h.count("atm_payment_index")).toBe(0);
		h.clock.now += MINUTE;
		h.deliver({ ...create(), id: "evt_create_again" });
		expect(h.count("atm_invoice_index")).toBe(1);
	});
});

describe("refunds and disputes find their invoice through invoice_payment.paid", () => {
	test("invoice.paid, invoice_payment.paid, then a full charge.refunded takes the unused credits back", () => {
		const h = harness();
		h.deliver(create());
		expect(availOf(h, T0 + 1)).toBe(2);
		const linked = h.deliver(link("in_1"));
		expect(linked).toEqual({
			status: 200,
			body: {
				outcome: "applied",
				stripeEventId: "evt_pay_in_1",
				events: 0,
				wroteRows: false,
			},
		});
		expect(h.raw.query(`SELECT * FROM atm_payment_index`).all()).toEqual([
			{ payment_ref: paymentIntentOf("in_1"), invoice_id: "in_1" },
		]);
		expect(h.claim("evt_pay_in_1")).toMatchObject({
			state: "done",
			outcome: "applied",
		});
		h.clock.now = T1 + 3_600_000;
		expect(h.deliver(refund("in_1")).body.outcome).toBe("applied");
		expect(availOf(h, T0 + 1)).toBe(0);
		expect(
			h.outbox().map((row) => (JSON.parse(row.body) as AtmEvent).event_type),
		).toContain("credit.adjusted");
	});

	test("a refund before invoice_payment.paid is a retryable 409 and keeps no claim; the redelivery applies after it", () => {
		const h = harness();
		h.deliver(create());
		const rows = h.rows();
		h.clock.now = T1 + 3_600_000;
		const early = h.deliver(refund("in_1"));
		expect(early.status).toBe(409);
		expect(early.body.outcome).toBe("unmatched_payment");
		expect(h.claim("evt_re_1")).toBeNull();
		expect(h.rows()).toEqual(rows);

		expect(h.deliver(link("in_1")).body.outcome).toBe("applied");
		expect(h.deliver(refund("in_1")).body.outcome).toBe("applied");
		expect(availOf(h, T0 + 1)).toBe(0);
	});

	test("a refund of a payment nothing was handled for is 409 and writes nothing", () => {
		const h = harness();
		const response = h.deliver(refund("in_1"));
		expect(response.status).toBe(409);
		expect(response.body.outcome).toBe("unmatched_payment");
		expect(h.count("atm_event_claims")).toBe(0);
		nothingWritten(h);
	});

	test("invoice_payment.paid before invoice.paid is a retryable 409 and keeps no claim; it applies once the invoice is handled", () => {
		const h = harness();
		const early = h.deliver(link("in_1"));
		expect(early.status).toBe(409);
		expect(early.body).toMatchObject({
			outcome: "unmatched_invoice",
			stripeEventId: "evt_pay_in_1",
		});
		expect(h.claim("evt_pay_in_1")).toBeNull();
		nothingWritten(h);

		h.deliver(create());
		const again = h.deliver(link("in_1"));
		expect(again.status).toBe(200);
		expect(again.body.outcome).toBe("applied");
		expect(h.count("atm_payment_index")).toBe(1);
		h.clock.now = T1 + 3_600_000;
		expect(h.deliver(refund("in_1")).body.outcome).toBe("applied");
		expect(availOf(h, T0 + 1)).toBe(0);
	});

	test("a lost dispute after the link takes the credits back", () => {
		const h = harness();
		h.deliver(create());
		h.deliver(link("in_1"));
		const dispute = (status: "needs_response" | "lost") =>
			disputeEvent({
				type:
					status === "lost"
						? "charge.dispute.closed"
						: "charge.dispute.created",
				eventId: `evt_dp_${status}`,
				disputeId: "dp_1",
				chargeId: "ch_in_1",
				invoiceId: "in_1",
				status,
				at: T1,
			});
		h.clock.now = T1;
		expect(h.deliver(dispute("needs_response")).status).toBe(200);
		expect(availOf(h, T0 + 1)).toBe(2);
		expect(h.deliver(dispute("lost")).body.outcome).toBe("applied");
		expect(availOf(h, T0 + 1)).toBe(0);
	});

	test("a replayed invoice_payment.paid is a duplicate and changes nothing", () => {
		const h = harness();
		h.deliver(create());
		h.deliver(link("in_1"));
		const claim = h.claim("evt_pay_in_1");
		const rows = h.rows();
		h.clock.now += 10 * MINUTE;
		expect(h.deliver(link("in_1"))).toEqual({
			status: 200,
			body: { outcome: "duplicate", stripeEventId: "evt_pay_in_1" },
		});
		expect(h.claim("evt_pay_in_1")).toEqual(claim);
		expect(h.count("atm_payment_index")).toBe(1);
		expect(h.rows()).toEqual(rows);

		// The same link again under another event id is applied and still one row.
		const again = invoicePayment({
			eventId: "evt_pay_again",
			invoiceId: "in_1",
			at: T1,
		});
		expect(h.deliver(again).body.outcome).toBe("applied");
		expect(h.count("atm_payment_index")).toBe(1);
		expect(h.rows()).toEqual(rows);
	});

	test("a payment of another family's invoice is not touched by this family's refund", () => {
		const h = harness();
		h.deliver(create());
		h.deliver(link("in_1"));
		const otherSubject = `${SCHOOL}|live|family:fam_other`;
		const other = invoicePaid({
			eventId: "evt_create_other",
			invoiceId: "in_9",
			at: T0 + 30_000,
			subscriptionId: "sub_9",
			reason: "subscription_create",
			periodStart: T0,
			periodEnd: T1,
			lines: [
				{
					lookupKey: tierKey("sparkle-2", "month"),
					amount: 26000,
					interval: "month",
				},
			],
			metadata: { b4u_school: SCHOOL, family_id: "fam_other" },
		});
		h.clock.now = T0 + 30_000;
		expect(h.deliver(other).body.outcome).toBe("applied");
		expect(h.deliver(link("in_9", T0 + 31_000)).body.outcome).toBe("applied");
		expect(
			h.raw.query(`SELECT * FROM atm_invoice_index ORDER BY invoice_id`).all(),
		).toEqual([
			{ invoice_id: "in_1", subject_key: SUBJECT_KEY },
			{ invoice_id: "in_9", subject_key: otherSubject },
		]);
		const otherRows = () =>
			h.raw
				.query(
					`SELECT * FROM atm_rows WHERE subject_key = ? ORDER BY table_name, row_id`,
				)
				.all(otherSubject);
		const otherBefore = otherRows();
		expect(otherBefore.length).toBeGreaterThan(0);

		h.clock.now = T1 + 3_600_000;
		expect(h.deliver(refund("in_1")).body.outcome).toBe("applied");
		expect(availOf(h, T0 + 1)).toBe(0);
		expect(otherRows()).toEqual(otherBefore);
	});

	test("a payment that names a charge (no payment intent) is indexed by the charge", () => {
		const h = harness();
		h.deliver(create());
		const event = invoicePayment({
			eventId: "evt_pay_charge",
			invoiceId: "in_1",
			at: T1,
			payment: { type: "charge", charge: "ch_in_1" },
		});
		expect(shapeProblems(event)).toEqual([]);
		expect(h.deliver(event).body.outcome).toBe("applied");
		expect(h.raw.query(`SELECT * FROM atm_payment_index`).all()).toEqual([
			{ payment_ref: "ch_in_1", invoice_id: "in_1" },
		]);
		h.clock.now = T1 + 3_600_000;
		expect(h.deliver(refund("in_1")).body.outcome).toBe("applied");
		expect(availOf(h, T0 + 1)).toBe(0);
	});

	test("an invoice.paid of an older API version is 422 with the version and the fix, not ignored", () => {
		const h = harness();
		const event = create();
		// What an endpoint on 2024-06-20 sends: the subscription and its metadata sit on the invoice itself.
		const { subscription_details: details } = event.data.object.parent;
		event.api_version = "2024-06-20";
		event.data.object.subscription = details.subscription;
		event.data.object.subscription_details = { metadata: details.metadata };
		event.data.object.parent = undefined;
		const response = h.deliver(event);
		expect(response.status).toBe(422);
		expect(response.body).toMatchObject({
			outcome: "refused",
			reason: "unknown_mapping",
		});
		expect(response.body.message).toContain("2024-06-20");
		expect(response.body.message).toContain(
			"recreate the endpoint with api_version 2025-10-29.clover",
		);
		expect(h.claim("evt_create")).toBeNull();
	});

	test("an invoice_payment.paid of another API version is 422 and keeps no claim", () => {
		const h = harness();
		h.deliver(create());
		const event = link("in_1");
		event.api_version = "2099-01-01.future";
		const response = h.deliver(event);
		expect(response.status).toBe(422);
		expect(response.body).toMatchObject({
			outcome: "refused",
			reason: "unknown_mapping",
		});
		// The answer names the endpoint's version and the fix, for whoever reads the 422 in Stripe's dashboard.
		expect(response.body.message).toContain("2099-01-01.future");
		expect(response.body.message).toContain(
			"recreate the endpoint with api_version 2025-10-29.clover",
		);
		expect(h.claim("evt_pay_in_1")).toBeNull();
		expect(h.count("atm_payment_index")).toBe(0);
	});

	test("the optional paymentRefs hook still links an invoice.paid's payment without invoice_payment.paid", () => {
		const h = harness({ paymentRefsHook: true });
		h.deliver(create());
		expect(h.raw.query(`SELECT * FROM atm_payment_index`).all()).toEqual([
			{ payment_ref: paymentIntentOf("in_1"), invoice_id: "in_1" },
		]);
		h.clock.now = T1 + 3_600_000;
		expect(h.deliver(refund("in_1")).body.outcome).toBe("applied");
		expect(availOf(h, T0 + 1)).toBe(0);
	});

	test("only the non-empty strings the paymentRefs hook returns are indexed", () => {
		const h = harness();
		const sloppy: WebhookDeps = {
			...h.deps,
			paymentRefs: () =>
				[
					null,
					7,
					{},
					"",
					paymentIntentOf("in_1"),
				] as unknown as readonly string[],
		};
		expect(h.deliver(create(), sloppy).body.outcome).toBe("applied");
		expect(h.raw.query(`SELECT * FROM atm_payment_index`).all()).toEqual([
			{ payment_ref: paymentIntentOf("in_1"), invoice_id: "in_1" },
		]);
		expect(h.claim("evt_create")?.state).toBe("done");
	});

	test("a refund whose payment intent and charge were indexed under different subjects is 422 ambiguous_payment", () => {
		const h = harness();
		h.deliver(create());
		h.deliver(link("in_1"));
		const otherSubject = `${SCHOOL}|live|family:fam_other`;
		// The charge was indexed under another family's invoice; the payment intent under this family's.
		h.raw.run(
			`INSERT INTO atm_invoice_index (invoice_id, subject_key) VALUES ('in_9', ?)`,
			[otherSubject],
		);
		h.raw.run(
			`INSERT INTO atm_payment_index (payment_ref, invoice_id) VALUES ('ch_in_1', 'in_9')`,
		);
		const rows = h.rows();
		const revision = h.revision();
		const outbox = h.outbox();
		h.clock.now = T1 + 3_600_000;
		const response = h.deliver(refund("in_1"));
		expect(response.status).toBe(422);
		expect(response.body).toMatchObject({
			outcome: "ambiguous_payment",
			stripeEventId: "evt_re_1",
		});
		expect(h.claim("evt_re_1")).toBeNull();
		expect(h.rows()).toEqual(rows);
		expect(h.revision()).toBe(revision);
		expect(h.outbox()).toEqual(outbox);
	});

	test("the recorded invoice_payment.paid normalises with its mapping and fits Stripe's spec", () => {
		const event = recordedPayment();
		expect(shapeProblems(event)).toEqual([]);
		const mapping = mappingFor(event.type, event.api_version);
		if (!mapping.ok) throw new Error("no mapping for the recorded event");
		expect(mapping.value.target).toBe("InvoicePaymentFact");
		const fact = normalize(event, mapping.value, { eventId: event.id });
		expect(fact).toEqual({
			ok: true,
			value: {
				source: {
					eventId: event.id,
					mapping: "stripe/invoice_payment.paid@v1",
					stripeApiVersion: "2025-10-29.clover",
				},
				id: event.id,
				invoiceId: "in_1UYLWLScrubTest05j61N5zH",
				paymentIntentId: "pi_3UYLWMScrubTest012RTKMak",
				chargeId: null,
				at: 1793865342000,
			},
		});
	});

	test("the recorded event is handled as it is: its invoice must be indexed, then the intent is", () => {
		const h = harness();
		const event = recordedPayment();
		h.clock.now = event.created * 1000;
		expect(h.deliver(event).body.outcome).toBe("unmatched_invoice");
		h.raw.run(
			`INSERT INTO atm_invoice_index (invoice_id, subject_key) VALUES (?, ?)`,
			[event.data.object.invoice, SUBJECT_KEY],
		);
		expect(h.deliver(event).body.outcome).toBe("applied");
		expect(h.raw.query(`SELECT * FROM atm_payment_index`).all()).toEqual([
			{
				payment_ref: event.data.object.payment.payment_intent,
				invoice_id: event.data.object.invoice,
			},
		]);
	});
});

describe("one endpoint, one school: an event for another school is 422 school_mismatch", () => {
	const OTHER_SCHOOL = "sch_other";
	const otherSubject = `${OTHER_SCHOOL}|live|${HOLDER}`;
	const otherMetadata = { b4u_school: OTHER_SCHOOL, family_id: FAMILY };

	/** Another school's invoice, indexed (as a shared database would hold it) with its payment intent and charge. */
	const seedOtherSchoolsInvoice = (h: Harness) => {
		h.raw.run(
			`INSERT INTO atm_invoice_index (invoice_id, subject_key) VALUES ('in_1', ?)`,
			[otherSubject],
		);
		h.raw.run(
			`INSERT INTO atm_payment_index (payment_ref, invoice_id) VALUES (?, 'in_1'), ('ch_in_1', 'in_1')`,
			[paymentIntentOf("in_1")],
		);
	};

	const refusedForSchool = (h: Harness, event: RawEvent) => {
		const response = h.deliver(event);
		expect(response.status).toBe(422);
		expect(response.body).toMatchObject({
			outcome: "school_mismatch",
			stripeEventId: event.id,
		});
		expect(h.claim(event.id)).toBeNull();
		expect(h.count("atm_rows")).toBe(0);
		expect(h.count("atm_subjects")).toBe(0);
		expect(h.count("ledger_outbox")).toBe(0);
		expect(h.calls.context).toBe(0);
	};

	test("an invoice.paid naming another school", () => {
		const h = harness();
		const event = create();
		event.data.object.parent.subscription_details.metadata = otherMetadata;
		refusedForSchool(h, event);
		nothingWritten(h);
	});

	test("a customer.subscription event naming another school", () => {
		const h = harness();
		for (const type of [
			"customer.subscription.created",
			"customer.subscription.updated",
			"customer.subscription.deleted",
		] as const)
			refusedForSchool(
				h,
				subscriptionEvent({
					type,
					eventId: `evt_${type}`,
					subscriptionId: "sub_1",
					status:
						type === "customer.subscription.deleted" ? "canceled" : "active",
					items: [
						{ lookupKey: tierKey("sparkle-2", "month"), interval: "month" },
					],
					periodStart: T0,
					periodEnd: T1,
					at: T0 + 10_000,
					metadata: otherMetadata,
				}),
			);
		nothingWritten(h);
	});

	test("a refund found through the index under another school's subject", () => {
		const h = harness();
		seedOtherSchoolsInvoice(h);
		h.clock.now = T1 + 3_600_000;
		refusedForSchool(h, refund("in_1"));
	});

	test("a dispute found through the index under another school's subject", () => {
		const h = harness();
		seedOtherSchoolsInvoice(h);
		h.clock.now = T1;
		for (const type of [
			"charge.dispute.created",
			"charge.dispute.closed",
		] as const)
			refusedForSchool(
				h,
				disputeEvent({
					type,
					eventId: `evt_${type}`,
					disputeId: "dp_1",
					chargeId: "ch_in_1",
					invoiceId: "in_1",
					status: type === "charge.dispute.closed" ? "lost" : "needs_response",
					at: T1,
				}),
			);
	});

	test("an invoice_payment.paid of an invoice indexed under another school's subject: claim released, no link", () => {
		const h = harness();
		h.raw.run(
			`INSERT INTO atm_invoice_index (invoice_id, subject_key) VALUES ('in_1', ?)`,
			[otherSubject],
		);
		refusedForSchool(h, link("in_1"));
		expect(h.count("atm_payment_index")).toBe(0);
	});
});
