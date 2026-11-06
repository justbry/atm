import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { menuToStripe } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { signStripePayload } from "../src/handler/stripe-signature.js";
import { handleStripeWebhook } from "../src/handler/stripe-webhook.js";
import type {
	WebhookContext,
	WebhookDeps,
	WebhookResponse,
} from "../src/handler/types.js";
import { deterministicUlid } from "../src/ledger/ids.js";
import type { AtmEnv } from "../src/types.js";

/**
 * `env` is part of the subject key (`<school>|<env>|<customer>`), so a school with a Stripe test endpoint and a live one
 * must be able to say which it is. Omitted, everything is what it was: `"live"`.
 */

const SCHOOL = "spike-school";
const SECRET = "whsec_env_test_secret";
const SECOND = 1000;
const FIXTURE_SCENARIO = "full-refund";
const deliveredDir = join(
	import.meta.dir,
	"../fixtures/billing/stripe/recorded/delivered",
);

// biome-ignore lint/suspicious/noExplicitAny: recorded Stripe JSON is read by path, untyped
type Recorded = any;

const read = (path: string): Recorded =>
	JSON.parse(readFileSync(join(deliveredDir, path), "utf8"));

const menu = read("menu.json") as Menu;
const priceIdsByKey = read("prices.json") as Record<string, string>;
const invoiceEvent = read(`${FIXTURE_SCENARIO}/03-invoice.paid.json`);
const invoiceId: string = invoiceEvent.data.object.id;
const familyId: string =
	invoiceEvent.data.object.parent.subscription_details.metadata.family_id;

const priceIds = (): Record<string, string> => {
	const ids: Record<string, string> = {};
	for (const op of menuToStripe({
		schoolId: SCHOOL,
		menu,
		previous: null,
		policy: DEFAULT_POLICY,
	})) {
		if (op.op !== "price.create") continue;
		const priceId = priceIdsByKey[op.metadata.b4u_key ?? ""];
		if (!priceId) throw new Error(`no recorded price for ${op.lookupKey}`);
		ids[op.lookupKey] = priceId;
	}
	return ids;
};

const contextFor = (env?: AtmEnv) => (): WebhookContext => ({
	menu,
	menuVersion: 1,
	policy: DEFAULT_POLICY,
	policyVersion: 1,
	catalog: menuCatalogRows({ menu, school: SCHOOL, env }),
	priceIds: priceIds(),
});

const harness = ({
	db = bunSqlite(new Database(":memory:")),
	env,
}: {
	db?: ReturnType<typeof bunSqlite>;
	env?: AtmEnv;
} = {}) => {
	db.exec(HANDLER_DDL);
	const clock = { now: 0 };
	const deps: WebhookDeps = {
		db,
		secret: SECRET,
		schoolId: SCHOOL,
		nowMs: () => clock.now,
		workerId: "env-test",
		// a delivery with no paymentFee warns (fee_unknown) once per payment; tests/handler-fee-unknown.test.ts reads those lines
		warn: () => undefined,
		context: contextFor(env),
		...(env === undefined ? {} : { env }),
	};
	/** The event exactly as given. */
	const deliverAsIs = (event: Recorded): WebhookResponse => {
		clock.now = (event.created + 1) * SECOND;
		const payload = JSON.stringify(event);
		return handleStripeWebhook(deps, {
			payload,
			signatureHeader: signStripePayload({
				payload,
				secret: SECRET,
				timestampSeconds: event.created + 1,
			}),
		});
	};
	// The recordings are sandbox events (livemode false). Most tests here are about where an env puts the rows, so each
	// harness is sent events of its own mode; the handler refuses a mismatch (see "livemode against env" below).
	const deliver = (event: Recorded): WebhookResponse =>
		deliverAsIs({ ...event, livemode: env !== "test" });
	return { db, deps, deliver, deliverAsIs };
};

const subjectKeysOf = (db: ReturnType<typeof bunSqlite>): string[] =>
	db
		.all<{ subject_key: string }>(
			"SELECT DISTINCT subject_key FROM atm_rows ORDER BY subject_key",
		)
		.map((row) => row.subject_key);

const rowCount = (db: ReturnType<typeof bunSqlite>, key: string): number =>
	db.all<{ n: number }>(
		"SELECT COUNT(*) AS n FROM atm_rows WHERE subject_key = ?",
		[key],
	)[0]?.n ?? 0;

const stripeEventInput = (env?: AtmEnv) => ({
	event: invoiceEvent,
	eventId: deterministicUlid({
		timeMs: invoiceEvent.created * SECOND,
		revision: 0,
		seed: invoiceEvent.id,
	}),
	menu,
	menuVersion: 1,
	policy: DEFAULT_POLICY,
	policyVersion: 1,
	rows: [],
	revision: 0,
	catalog: menuCatalogRows({ menu, school: SCHOOL, env }),
	now: invoiceEvent.created * SECOND,
	priceIds: priceIds(),
	...(env === undefined ? {} : { env }),
});

const BAD_ENVS: unknown[] = ["prod", "", "LIVE", "Test", null, 1, {}];

describe("env defaults to live", () => {
	test("omitted gives the same catalog rows as 'live'", () => {
		expect(menuCatalogRows({ menu, school: SCHOOL })).toEqual(
			menuCatalogRows({ menu, school: SCHOOL, env: "live" }),
		);
	});

	test("the catalog rows of 'test' differ from 'live' only in the products' and features' env", () => {
		const live = menuCatalogRows({ menu, school: SCHOOL, env: "live" });
		const test = menuCatalogRows({ menu, school: SCHOOL, env: "test" });
		const rewritten = JSON.parse(
			JSON.stringify(test).replaceAll('"env":"test"', '"env":"live"'),
		);
		expect(rewritten).toEqual(live);
		expect(JSON.stringify(test)).toContain('"env":"test"');
		expect(JSON.stringify(live)).not.toContain('"env":"test"');
	});

	test("omitted gives the same rows, events and subject key as 'live'", () => {
		const omitted = handleStripeEvent(stripeEventInput());
		const live = handleStripeEvent(stripeEventInput("live"));
		expect(omitted.refused).toBeUndefined();
		expect(omitted.rowChanges).not.toBeNull();
		expect(omitted).toEqual(live);
		expect(omitted.rowChanges?.subjectKey).toBe(
			`${SCHOOL}|live|family:${familyId}`,
		);
	});

	test("'test' puts the same rows under the |test| subject, and nothing under |live|", () => {
		const live = handleStripeEvent(stripeEventInput("live"));
		const test = handleStripeEvent(stripeEventInput("test"));
		expect(test.refused).toBeUndefined();
		expect(test.rowChanges?.subjectKey).toBe(
			`${SCHOOL}|test|family:${familyId}`,
		);
		expect(JSON.stringify(test)).not.toContain("|live|");
		expect(JSON.stringify(live)).not.toContain("|test|");
		expect(test.events.map((event) => event.id)).toEqual(
			live.events.map((event) => event.id),
		);
	});

	test("a grants command carries the env its input names", () => {
		const identityEnvs = (env?: AtmEnv): string[] => {
			const result = handleStripeEvent(stripeEventInput(env));
			return result.events.flatMap((event) => {
				const command = (
					event.payload as { command?: { identity?: { env?: string } } }
				).command;
				return command?.identity?.env ? [command.identity.env] : [];
			});
		};
		expect(new Set(identityEnvs())).toEqual(new Set(["live"]));
		expect(new Set(identityEnvs("test"))).toEqual(new Set(["test"]));
	});
});

describe("env on the reference webhook handler", () => {
	test("omitted lands the rows under |live|", () => {
		const { db, deliver } = harness();
		expect(deliver(invoiceEvent).body.outcome).toBe("applied");
		expect(subjectKeysOf(db)).toEqual([`${SCHOOL}|live|family:${familyId}`]);
	});

	test("'live' is the same as omitted, row for row", () => {
		const omitted = harness();
		const live = harness({ env: "live" });
		omitted.deliver(invoiceEvent);
		live.deliver(invoiceEvent);
		const dump = (db: ReturnType<typeof bunSqlite>) =>
			db.all("SELECT * FROM atm_rows ORDER BY 1, 2, 3");
		expect(dump(live.db)).toEqual(dump(omitted.db));
		const outbox = (db: ReturnType<typeof bunSqlite>) =>
			db.all("SELECT * FROM ledger_outbox ORDER BY 1, 2");
		expect(outbox(live.db)).toEqual(outbox(omitted.db));
	});

	test("'test' lands the rows under <school>|test|family:<id> and nothing under |live|", () => {
		const { db, deliver } = harness({ env: "test" });
		expect(deliver(invoiceEvent).body.outcome).toBe("applied");
		const testKey = `${SCHOOL}|test|family:${familyId}`;
		expect(subjectKeysOf(db)).toEqual([testKey]);
		expect(rowCount(db, testKey)).toBeGreaterThan(0);
		expect(rowCount(db, `${SCHOOL}|live|family:${familyId}`)).toBe(0);
		const [index] = db.all<{ subject_key: string }>(
			"SELECT subject_key FROM atm_invoice_index WHERE invoice_id = ?",
			[invoiceId],
		);
		expect(index?.subject_key).toBe(testKey);
		for (const row of db.all<{ body: string }>(
			"SELECT body FROM ledger_outbox",
		))
			expect(row.body).not.toContain("|live|");
	});

	test("a refund through a test endpoint takes the credits back from the |test| subject", () => {
		const events = [
			"01-invoice_payment.paid.json",
			"02-customer.subscription.created.json",
			"03-invoice.paid.json",
			"04-charge.refunded.json",
		].map((name) => read(`${FIXTURE_SCENARIO}/${name}`));
		const { db, deliver } = harness({ env: "test" });
		for (const event of events) deliver(event);
		// invoice_payment.paid came first and waits for its invoice: deliver it again, then the refund.
		expect(deliver(events[0]).body.outcome).toBe("applied");
		expect(deliver(events[3]).body.outcome).toBe("applied");
		expect(subjectKeysOf(db)).toEqual([`${SCHOOL}|test|family:${familyId}`]);
		const balances = db
			.all<{ data: string }>(
				"SELECT data FROM atm_rows WHERE table_name = 'customerEntitlements'",
			)
			.map((row) => JSON.parse(row.data).balance);
		expect(balances).toEqual([0]);
	});

	test("a test delivery and a live delivery of the same event do not share rows", () => {
		const test = harness({ env: "test" });
		const live = harness({ env: "live" });
		expect(test.deliver(invoiceEvent).body.outcome).toBe("applied");
		expect(live.deliver(invoiceEvent).body.outcome).toBe("applied");
		expect(subjectKeysOf(test.db)).toEqual([
			`${SCHOOL}|test|family:${familyId}`,
		]);
		expect(subjectKeysOf(live.db)).toEqual([
			`${SCHOOL}|live|family:${familyId}`,
		]);
	});

	test("in one database a test and a live delivery land under two subjects when Stripe's ids differ, as they do between modes", () => {
		const { db } = harness();
		const live = harness({ db, env: "live" });
		const test = harness({ db, env: "test" });
		// Stripe never reuses an id across modes: give the test-mode copy its own event and invoice ids.
		const testMode = JSON.parse(
			JSON.stringify(invoiceEvent)
				.replaceAll(invoiceEvent.id, "evt_env_test_copy")
				.replaceAll(invoiceId, "in_env_test_copy"),
		);
		expect(live.deliver(invoiceEvent).body.outcome).toBe("applied");
		expect(test.deliver(testMode).body.outcome).toBe("applied");
		const liveKey = `${SCHOOL}|live|family:${familyId}`;
		const testKey = `${SCHOOL}|test|family:${familyId}`;
		expect(subjectKeysOf(db)).toEqual([liveKey, testKey].sort());
		expect(rowCount(db, liveKey)).toBe(rowCount(db, testKey));
		const claims = db.all<{ event_id: string; state: string }>(
			"SELECT event_id, state FROM atm_event_claims ORDER BY event_id",
		);
		expect(claims.map((claim) => claim.state)).toEqual(["done", "done"]);
		expect(claims).toHaveLength(2);
	});

	test("the claim, invoice index and outbox are keyed by env as well as Stripe's id: one id delivered under both envs in one database is decided once in each", () => {
		// It cannot arise from Stripe (an event id is never shared between test and live mode); it is what happens if a
		// caller reuses one id for both. Before the tables carried env, the second delivery was answered `duplicate`.
		const { db } = harness();
		const live = harness({ db, env: "live" });
		const test = harness({ db, env: "test" });
		expect(live.deliver(invoiceEvent).body.outcome).toBe("applied");
		expect(test.deliver(invoiceEvent).body.outcome).toBe("applied");
		expect(subjectKeysOf(db)).toEqual([
			`${SCHOOL}|live|family:${familyId}`,
			`${SCHOOL}|test|family:${familyId}`,
		]);
		expect(
			db.all("SELECT env, event_id, state FROM atm_event_claims ORDER BY env"),
		).toEqual([
			{ env: "live", event_id: invoiceEvent.id, state: "done" },
			{ env: "test", event_id: invoiceEvent.id, state: "done" },
		]);
	});
});

describe("a bad env throws, naming the field", () => {
	test.each(BAD_ENVS)("menuCatalogRows: %p", (value) => {
		expect(() =>
			// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript passing a bad value
			menuCatalogRows({ menu, school: SCHOOL, env: value as any }),
		).toThrow(/^env must be "live" or "test"/);
	});

	test.each(BAD_ENVS)("handleStripeEvent: %p", (value) => {
		expect(() =>
			// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript passing a bad value
			handleStripeEvent({ ...stripeEventInput(), env: value as any }),
		).toThrow(/^env must be "live" or "test"/);
	});

	test.each(BAD_ENVS)("handleStripeWebhook (WebhookDeps): %p", (value) => {
		const { db, deps } = harness();
		// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript passing a bad value
		const bad = { ...deps, env: value as any };
		const payload = JSON.stringify(invoiceEvent);
		expect(() =>
			handleStripeWebhook(bad, {
				payload,
				signatureHeader: signStripePayload({
					payload,
					secret: SECRET,
					timestampSeconds: invoiceEvent.created + 1,
				}),
			}),
		).toThrow(/^env must be "live" or "test"/);
		expect(db.all("SELECT * FROM atm_event_claims")).toEqual([]);
	});

	// A bad env is resolved once at the entry point. It must not reach the per-event holder lookup, whose catch would
	// answer it as a family with no metadata (a 422 `missing_metadata`) instead of throwing.
	test.each(BAD_ENVS)(
		"handleStripeWebhook throws, not missing_metadata, for an event with half the holder metadata: %p",
		(value) => {
			const { db, deps } = harness();
			// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript passing a bad value
			const bad = { ...deps, env: value as any };
			const half = structuredClone(invoiceEvent);
			half.data.object.metadata = {};
			half.data.object.parent.subscription_details.metadata = {
				b4u_school: SCHOOL,
			};
			const payload = JSON.stringify(half);
			expect(() =>
				handleStripeWebhook(bad, {
					payload,
					signatureHeader: signStripePayload({
						payload,
						secret: SECRET,
						timestampSeconds: half.created + 1,
					}),
				}),
			).toThrow(/^env must be "live" or "test"/);
			expect(db.all("SELECT * FROM atm_event_claims")).toEqual([]);
			expect(db.all("SELECT * FROM atm_rows")).toEqual([]);
		},
	);

	test.each(BAD_ENVS)(
		"handleStripeEvent throws on %p before its other checks run",
		(value) => {
			// An unusable eventId would otherwise be refused as bad_event: the env check comes first.
			expect(() =>
				handleStripeEvent({
					...stripeEventInput(),
					eventId: "not-a-ulid",
					// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript passing a bad value
					env: value as any,
				}),
			).toThrow(/^env must be "live" or "test"/);
		},
	);

	test("the error is an Error, and says what it got", () => {
		let caught: unknown;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript passing a bad value
			menuCatalogRows({ menu, school: SCHOOL, env: "prod" as any });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe(
			'env must be "live" or "test", got "prod"',
		);
	});
});

describe("livemode against env", () => {
	const nothingWritten = (db: ReturnType<typeof bunSqlite>) => {
		for (const table of [
			"atm_event_claims",
			"atm_rows",
			"ledger_outbox",
			"atm_invoice_index",
		])
			expect(db.all(`SELECT * FROM ${table}`)).toEqual([]);
	};
	const { livemode: _livemode, ...withoutLivemode } = invoiceEvent;

	test("a test-mode event to a default (live) handler is 422 livemode_mismatch and writes nothing", () => {
		const { db, deliverAsIs } = harness();
		const response = deliverAsIs({ ...invoiceEvent, livemode: false });
		expect(response.status).toBe(422);
		expect(response.body.outcome).toBe("livemode_mismatch");
		expect(response.body.stripeEventId).toBe(invoiceEvent.id);
		expect(response.body.message).toContain("livemode=false");
		expect(response.body.message).toContain('env "live"');
		nothingWritten(db);
	});

	test("a live-mode event to an env: test handler is 422 livemode_mismatch and writes nothing", () => {
		const { db, deliverAsIs } = harness({ env: "test" });
		const response = deliverAsIs({ ...invoiceEvent, livemode: true });
		expect(response.status).toBe(422);
		expect(response.body.outcome).toBe("livemode_mismatch");
		expect(response.body.message).toContain("livemode=true");
		expect(response.body.message).toContain('env "test"');
		nothingWritten(db);
	});

	test("the same event is applied once the mode agrees, and the refusal kept no claim", () => {
		const { db, deliverAsIs } = harness();
		expect(deliverAsIs(invoiceEvent).body.outcome).toBe("livemode_mismatch");
		const live = { ...invoiceEvent, livemode: true };
		expect(deliverAsIs(live).body.outcome).toBe("applied");
		expect(subjectKeysOf(db)).toEqual([`${SCHOOL}|live|family:${familyId}`]);
	});

	test("a matching livemode applies, on either env", () => {
		const live = harness();
		expect(
			live.deliverAsIs({ ...invoiceEvent, livemode: true }).body.outcome,
		).toBe("applied");
		const test = harness({ env: "test" });
		expect(
			test.deliverAsIs({ ...invoiceEvent, livemode: false }).body.outcome,
		).toBe("applied");
	});

	test("an event with no livemode field is not refused, on either env", () => {
		expect("livemode" in withoutLivemode).toBe(false);
		for (const env of [undefined, "live", "test"] as const) {
			const { deliverAsIs } = harness({ env });
			expect(deliverAsIs(withoutLivemode).body.outcome).toBe("applied");
		}
	});

	test("an invoice_payment.paid is checked too, before its claim", () => {
		const payment = read(`${FIXTURE_SCENARIO}/01-invoice_payment.paid.json`);
		const { db, deliverAsIs } = harness();
		const response = deliverAsIs({ ...payment, livemode: false });
		expect(response.body.outcome).toBe("livemode_mismatch");
		expect(db.all("SELECT * FROM atm_event_claims")).toEqual([]);
	});
});
