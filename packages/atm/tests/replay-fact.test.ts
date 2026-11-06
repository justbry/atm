/**
 * The refactor behind stored inputs changes nothing: `handleStripeFact(replayFactOf(fact))` decides exactly what
 * `handleStripeEvent(rawEvent)` decides, on the same rows, over
 *   - 300 seeded random histories of one family (`billing-play.ts`), every step and every repeat delivery;
 *   - every recorded Stripe event the handlers read (the 14 top-level ones, the 6 discounted invoices, the 44 of the 8
 *     delivered scenarios) and the 6 recorded booking events, with the rows evolving as the family service writes them.
 * Also: `replayFactOf` keeps nothing personal and no link; `inputCauseId` is the cause the handler writes; and a fact
 * trimmed too far, or a `handleStripeFact` that ignores the event type, is caught by the same comparison.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import {
	handleStripeEvent,
	handleStripeFact,
	normalizeStripeEvent,
} from "../src/billing/handle.js";
import { mappingFor, redactPersonal } from "../src/billing/normalize.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { applyRowChanges, type BillingRow } from "../src/billing/rows.js";
import { menuLineItems, menuToStripe } from "../src/billing/stripe-menu.js";
import type {
	Menu,
	StripeEventInput,
	StripeEventResult,
} from "../src/billing/types.js";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import {
	contextHashOf,
	inputCauseId,
	REPLAY_METADATA_KEYS,
	replayFactOf,
} from "../src/handler/inputs.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import { signStripePayload } from "../src/handler/stripe-signature.js";
import { handleStripeWebhook } from "../src/handler/stripe-webhook.js";
import type { WebhookContext, WebhookDeps } from "../src/handler/types.js";
import { deterministicUlid } from "../src/ledger/ids.js";
import { canonicalize } from "../src/ledger/util.js";
import type { BillingFact, ReplayFact } from "../src/types.js";
import { FAMILY, play, menu as propertyMenu, SCHOOL } from "./billing-play.js";
import { createStore } from "./billing-store.js";
import { priceIdOf } from "./stripe-events.js";

const SEED_COUNT = 300;
const MAX_PASSES = 4;
const SECOND = 1000;
const API = "2025-10-29.clover";
const SECRET = "whsec_replay_fact_test_secret";
const DELIVERED_SCHOOL = "spike-school";
const BOOKING_SCHOOL = "sch_demo";

const recordedRoot = join(
	import.meta.dir,
	"../fixtures/billing/stripe/recorded",
);
const deliveredRoot = join(recordedRoot, "delivered");
const grantsMenuPath = join(
	import.meta.dir,
	"../fixtures/billing/grants/menu.json",
);

// biome-ignore lint/suspicious/noExplicitAny: recorded Stripe JSON is read by path, untyped
type Recorded = any;

const readJson = (path: string): Recorded =>
	JSON.parse(readFileSync(path, "utf8"));

const eventsIn = (dir: string, only?: readonly string[]): Recorded[] =>
	(
		only ??
		readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.sort()
	)
		.map((name) => readJson(join(dir, name)))
		.filter((json) => json.object === "event");

const SCENARIOS = readdirSync(deliveredRoot, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

const topLevel = eventsIn(recordedRoot);
const discounted = eventsIn(join(recordedRoot, "discount"));
const scenarioEvents = (scenario: string): Recorded[] =>
	eventsIn(join(deliveredRoot, scenario));
const delivered = SCENARIOS.flatMap(scenarioEvents);
const BOOKING_ORDER = [
	"checkout.session.completed.json",
	"checkout.session.completed.second.json",
	"checkout.session.completed.subscription.json",
	"checkout.session.expired.json",
	"charge.refunded.full.json",
	"charge.refunded.partial.json",
] as const;
const bookingEvents = eventsIn(join(recordedRoot, "booking"), BOOKING_ORDER);

const deliveredMenu = readJson(join(deliveredRoot, "menu.json")) as Menu;
const deliveredPriceIds = (): Record<string, string> => {
	const byKey = readJson(join(deliveredRoot, "prices.json")) as Record<
		string,
		string
	>;
	const ids: Record<string, string> = {};
	for (const op of menuToStripe({
		schoolId: DELIVERED_SCHOOL,
		menu: deliveredMenu,
		previous: null,
		policy: DEFAULT_POLICY,
	})) {
		if (op.op !== "price.create") continue;
		const priceId = byKey[op.metadata.b4u_key ?? ""];
		if (!priceId) throw new Error(`no recorded price for ${op.lookupKey}`);
		ids[op.lookupKey] = priceId;
	}
	return ids;
};

/** What `handleStripeFact` decides from the stored form of the same input; `mutate` breaks one thing on purpose. */
type Mutation = {
	trim?: (fact: ReplayFact) => ReplayFact;
	type?: (type: string) => string;
};
const viaFact = (
	input: StripeEventInput,
	mutation: Mutation = {},
): StripeEventResult => {
	const { event, ...rest } = input;
	const normalized = normalizeStripeEvent(event, input.eventId);
	if (!normalized.ok)
		return { rowChanges: null, events: [], refused: normalized.refusal };
	const trimmed = replayFactOf(normalized.fact);
	return handleStripeFact({
		...rest,
		fact: mutation.trim ? mutation.trim(trimmed) : trimmed,
		target: normalized.target,
		type: mutation.type ? mutation.type(normalized.type) : normalized.type,
		apiVersion: normalized.apiVersion,
		mapping: normalized.mappingLabel,
	});
};

const same = (a: StripeEventResult, b: StripeEventResult): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

// ---- the family service in miniature, over recorded events ----

type World = {
	school: string;
	menu: Menu;
	priceIds: Record<string, string>;
	env?: "test" | "live";
};

/**
 * Handles `events` in order the way the family service does (rows and revision evolve, a refusal is retried on the next
 * pass, the payment and booking indexes are learned), asking `check` about every input.
 */
const drive = (
	world: World,
	events: Recorded[],
	check: (input: StripeEventInput, result: StripeEventResult) => void,
) => {
	let rows: BillingRow[] = [];
	let revision = 0;
	const invoiceIds: Record<string, string> = {};
	const bookingIds: Record<string, string> = {};
	const catalog = menuCatalogRows({
		menu: world.menu,
		school: world.school,
		env: world.env ?? "live",
	});
	const results: { id: string; result: StripeEventResult }[] = [];
	let pending = events;
	for (let pass = 0; pass < MAX_PASSES && pending.length > 0; pass += 1) {
		const retry: Recorded[] = [];
		for (const event of pending) {
			const input: StripeEventInput = {
				event,
				eventId: inputCauseId({
					school: world.school,
					eventId: event.id,
					stripeCreated: event.created,
				}),
				menu: world.menu,
				menuVersion: 1,
				policy: DEFAULT_POLICY,
				policyVersion: 1,
				rows,
				revision,
				catalog,
				now: event.created * SECOND,
				priceIds: world.priceIds,
				invoiceIds,
				bookingIds,
				...(world.env ? { env: world.env } : {}),
			};
			const result = handleStripeEvent(input);
			check(input, result);
			results.push({ id: event.id, result });
			if (result.refused) retry.push(event);
			if (result.rowChanges)
				({ rows, revision } = applyRowChanges({
					rows,
					revision,
					changes: result.rowChanges,
				}));
			const object = event.data.object;
			if (event.type === "invoice_payment.paid") {
				const ref = object.payment?.payment_intent ?? object.payment?.charge;
				if (ref) invoiceIds[ref] = object.invoice;
			}
			if (result.booking?.action === "paid" && result.booking.paymentIntentId)
				bookingIds[result.booking.paymentIntentId] = result.booking.bookingId;
		}
		pending = retry;
	}
	return results;
};

const deliveredWorld: World = {
	school: DELIVERED_SCHOOL,
	menu: deliveredMenu,
	priceIds: deliveredPriceIds(),
	env: "test",
};
const bookingMenu = readJson(grantsMenuPath) as Menu;
const bookingWorld: World = {
	school: BOOKING_SCHOOL,
	menu: bookingMenu,
	priceIds: Object.fromEntries(
		[...menuLineItems(BOOKING_SCHOOL, bookingMenu).keys()].map((key) => [
			key,
			priceIdOf(key),
		]),
	),
};

/** Every recorded input, in the way each is replayed: the delivered scenarios as histories, the rest one by one. */
const driveAllRecorded = (
	check: (input: StripeEventInput, result: StripeEventResult) => void,
) => {
	const ids = new Set<string>();
	const note =
		(inner: typeof check): typeof check =>
		(input, result) => {
			ids.add((input.event as { id: string }).id);
			inner(input, result);
		};
	for (const scenario of SCENARIOS)
		drive(deliveredWorld, scenarioEvents(scenario), note(check));
	for (const event of [...topLevel, ...discounted])
		drive(deliveredWorld, [event], note(check));
	drive(bookingWorld, bookingEvents, note(check));
	return ids;
};

// ---- 1. random histories ----

const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => i + 1);

describe("handleStripeFact(replayFactOf(fact)) equals handleStripeEvent(rawEvent)", () => {
	test.each(SEEDS)("seed %d: every step of a random history", (seed) => {
		let compared = 0;
		const store = createStore({
			menu: propertyMenu,
			school: SCHOOL,
			family: FAMILY,
			onHandled: (input, result) => {
				compared += 1;
				expect(JSON.stringify(viaFact(input))).toBe(JSON.stringify(result));
			},
		});
		const { sent } = play({ seed, steps: 40, store });
		// and each again, in reverse: the repeat deliveries decide nothing, the same way
		for (const { event, at } of [...sent].reverse()) store.handle(event, at);
		expect(compared).toBe(sent.length * 2);
	});

	test("the histories reach every kind of decision (the check has something to compare)", () => {
		const kinds = new Set<string>();
		let events = 0;
		for (const seed of SEEDS.slice(0, 40)) {
			const store = createStore({
				menu: propertyMenu,
				school: SCHOOL,
				family: FAMILY,
				onHandled: (input, result) => {
					const type = (input.event as { type: string }).type;
					kinds.add(type);
					events += result.events.length;
				},
			});
			play({ seed, steps: 40, store });
		}
		for (const type of [
			"invoice.paid",
			"charge.refunded",
			"charge.dispute.created",
			"charge.dispute.closed",
			"customer.subscription.deleted",
		])
			expect(kinds.has(type)).toBe(true);
		expect(events).toBeGreaterThan(300);
	});
});

// ---- 2. recorded events ----

describe("the recorded events", () => {
	test("the fixtures are the ones the design measured: 14 + 6 + 44 events, 8 scenarios, and 6 booking events", () => {
		expect(topLevel.length).toBe(14);
		expect(discounted.length).toBe(6);
		expect(SCENARIOS.length).toBe(8);
		expect(delivered.length).toBe(44);
		expect(bookingEvents.length).toBe(BOOKING_ORDER.length);
	});

	test("all 64 decide the same through the fact, as histories (delivered) and one by one", () => {
		let compared = 0;
		const applied = new Set<string>();
		const ids = driveAllRecorded((input, result) => {
			compared += 1;
			expect(JSON.stringify(viaFact(input))).toBe(JSON.stringify(result));
			if (result.rowChanges || result.events.length > 0 || result.booking)
				applied.add((input.event as { id: string }).id);
		});
		// 64 handler events + 6 booking ones, each at least once (a refusal is retried, so some are compared more than once)
		expect(ids.size).toBe(64 + bookingEvents.length);
		expect(compared).toBeGreaterThanOrEqual(ids.size);
		// the comparison is not between refusals: most events change rows or write events (a payment link, an ignored
		// subscription and a few refusals do not)
		expect(applied.size).toBeGreaterThanOrEqual(30);
	});

	test.each(SCENARIOS)(
		"%s: the scenario replays identically, rows and all",
		(scenario) => {
			const events = scenarioEvents(scenario);
			const run = (decide: (input: StripeEventInput) => StripeEventResult) => {
				let last = "";
				drive(deliveredWorld, events, (input) => {
					last += JSON.stringify(decide(input));
				});
				return last;
			};
			expect(run((input) => viaFact(input))).toBe(
				run((input) => handleStripeEvent(input)),
			);
		},
	);

	test("a booking refund named only by its charge's metadata decides the same through the fact (the refund fact's booking id is read)", () => {
		const dropBookingId = (fact: ReplayFact): ReplayFact => {
			const { bookingId: _dropped, ...rest } = fact as { bookingId?: string };
			return rest as ReplayFact;
		};
		let refunded = 0;
		let caught = 0;
		drive(bookingWorld, bookingEvents, (input) => {
			// no index of payment intents to bookings: the charge's own `metadata.booking_id` is all the refund has
			const bare: StripeEventInput = { ...input, bookingIds: undefined };
			const direct = handleStripeEvent(bare);
			if (direct.booking?.action === "refunded") refunded += 1;
			expect(same(viaFact(bare), direct)).toBe(true);
			if (!same(viaFact(bare, { trim: dropBookingId }), direct)) caught += 1;
		});
		expect(refunded).toBeGreaterThan(0);
		expect(caught).toBeGreaterThan(0);
	});

	test("the booking events decide a booking outcome through the fact too", () => {
		const outcomes: string[] = [];
		drive(bookingWorld, bookingEvents, (input, result) => {
			expect(JSON.stringify(viaFact(input))).toBe(JSON.stringify(result));
			if (result.booking) outcomes.push(result.booking.action);
		});
		expect(outcomes).toContain("paid");
		expect(outcomes).toContain("refunded");
		expect(outcomes).toContain("expired");
	});
});

// ---- 3. privacy ----

type Leaf = { path: string[]; value: string };
const leavesOf = (value: unknown, path: string[] = []): Leaf[] => {
	if (typeof value === "string") return [{ path, value }];
	if (Array.isArray(value))
		return value.flatMap((item, index) =>
			leavesOf(item, [...path, String(index)]),
		);
	if (value !== null && typeof value === "object")
		return Object.entries(value).flatMap(([key, item]) =>
			leavesOf(item, [...path, key]),
		);
	return [];
};

const MIN_PERSONAL_LENGTH = 4;
const PERSONAL_KEYS: ReadonlySet<string> = new Set([
	"customer_name",
	"customer_email",
	"customer_phone",
	"account_name",
	"display_name",
	"number",
	"receipt_url",
	"hosted_invoice_url",
	"invoice_pdf",
	"last4",
	"fingerprint",
]);
const PERSONAL_UNDER_KEYS: ReadonlySet<string> = new Set([
	"name",
	"email",
	"phone",
	"line1",
	"line2",
	"city",
	"state",
	"postal_code",
]);
const PERSONAL_PARENTS: ReadonlySet<string> = new Set([
	"customer_details",
	"billing_details",
	"shipping",
	"address",
	"evidence",
	"customer_address",
]);
const URL_PATTERN = /^https?:\/\//;

/**
 * The personal strings of a raw event, found in the raw event and not named here: what the mapping's own `personal` paths
 * remove, a value under a name that holds a person (customer name, email, address lines, card last four), and any link.
 */
const personalStrings = (event: Recorded): string[] => {
	const found = new Set<string>();
	const mapping = mappingFor(event.type, event.api_version);
	if (mapping.ok) {
		const kept = new Map<string, number>();
		for (const { value } of leavesOf(redactPersonal(event, mapping.value)))
			kept.set(value, (kept.get(value) ?? 0) + 1);
		for (const { value } of leavesOf(event)) {
			const left = kept.get(value) ?? 0;
			if (left > 0) kept.set(value, left - 1);
			else found.add(value);
		}
	}
	for (const { path, value } of leavesOf(event)) {
		const key = path[path.length - 1] ?? "";
		const parent = path[path.length - 2] ?? "";
		const isPerson =
			PERSONAL_KEYS.has(key) ||
			(PERSONAL_UNDER_KEYS.has(key) && PERSONAL_PARENTS.has(parent));
		if (isPerson || URL_PATTERN.test(value)) found.add(value);
	}
	return [...found].filter((value) => value.length >= MIN_PERSONAL_LENGTH);
};

const everyRecordedEvent = (): Recorded[] => [
	...topLevel,
	...discounted,
	...delivered,
	...bookingEvents,
];

describe("replayFactOf keeps nothing personal", () => {
	test("for every recorded event, the serialized trimmed fact holds none of the raw event's personal strings and no link", () => {
		let checked = 0;
		let strings = 0;
		for (const event of everyRecordedEvent()) {
			const normalized = normalizeStripeEvent(
				event,
				"01HZZZZZZZZZZZZZZZZZZZZZZZ",
			);
			if (!normalized.ok) continue;
			checked += 1;
			const text = JSON.stringify(replayFactOf(normalized.fact));
			expect(text).not.toContain("://");
			const personal = personalStrings(event);
			strings += personal.length;
			for (const value of personal)
				expect([event.id, text.includes(value)]).toEqual([event.id, false]);
		}
		expect(checked).toBe(64 + bookingEvents.length);
		// the scrub left personal strings to look for (names, an email, an address, last four, links)
		expect(strings).toBeGreaterThan(100);
	});

	test("the check has teeth: the untrimmed facts do hold links, numbers and personal strings", () => {
		const untrimmed: string[] = [];
		for (const event of everyRecordedEvent()) {
			const normalized = normalizeStripeEvent(
				event,
				"01HZZZZZZZZZZZZZZZZZZZZZZZ",
			);
			if (normalized.ok) untrimmed.push(JSON.stringify(normalized.fact));
		}
		const text = untrimmed.join("\n");
		expect(text).toContain("://");
		expect(text).toContain("hostedInvoiceUrl");
		expect(text).toContain('"source"');
	});

	test("metadata is cut to the keys the rules read; a checkout session also keeps its booking id", () => {
		const noisy = {
			source: { eventId: "x", mapping: "m", stripeApiVersion: API },
			id: "in_1",
			metadata: {
				b4u_school: "s",
				family_id: "f",
				profile_id: "p",
				note: "n",
			},
			number: "N-1",
			hostedInvoiceUrl: "https://example.test/i",
			invoicePdf: "https://example.test/p",
			lines: [],
		} as unknown as BillingFact;
		const trimmed = replayFactOf(noisy) as unknown as Record<string, unknown>;
		expect(Object.keys(trimmed)).toEqual(["id", "metadata", "lines"]);
		expect(Object.keys(trimmed.metadata as object)).toEqual([
			...REPLAY_METADATA_KEYS,
		]);
		const session = {
			sessionId: "cs_1",
			metadata: {
				b4u_school: "s",
				family_id: "f",
				booking_id: "b",
				other: "o",
			},
		} as unknown as BillingFact;
		expect(
			Object.keys((replayFactOf(session) as { metadata: object }).metadata),
		).toEqual([...REPLAY_METADATA_KEYS, "booking_id"]);
	});

	test("a trimmed fact is smaller than the whole one, and still a plain JSON value", () => {
		for (const event of delivered) {
			const normalized = normalizeStripeEvent(
				event,
				"01HZZZZZZZZZZZZZZZZZZZZZZZ",
			);
			if (!normalized.ok) continue;
			const trimmed = replayFactOf(normalized.fact);
			expect(JSON.stringify(trimmed).length).toBeLessThan(
				JSON.stringify(normalized.fact).length,
			);
			expect(JSON.parse(JSON.stringify(trimmed))).toEqual(trimmed);
		}
	});
});

// ---- 4. the cause id ----

const deliveredContext = (): WebhookContext => ({
	menu: deliveredMenu,
	menuVersion: 1,
	policy: DEFAULT_POLICY,
	policyVersion: 1,
	catalog: menuCatalogRows({
		menu: deliveredMenu,
		school: DELIVERED_SCHOOL,
		env: "test",
	}),
	priceIds: deliveredPriceIds(),
});

/** The reference handler over one scenario's events (retried on 409 as Stripe does); returns its outbox. */
const outboxOf = (events: Recorded[]): { cause?: string }[] => {
	const raw = new Database(":memory:");
	const db = bunSqlite(raw);
	db.exec(HANDLER_DDL);
	const clock = { now: 0 };
	const deps: WebhookDeps = {
		db,
		secret: SECRET,
		schoolId: DELIVERED_SCHOOL,
		nowMs: () => clock.now,
		workerId: "replay-fact",
		// a delivery with no paymentFee warns (fee_unknown) once per payment; tests/handler-fee-unknown.test.ts reads those lines
		warn: () => undefined,
		env: "test",
		context: deliveredContext,
	};
	let pending = events;
	for (let pass = 0; pass < MAX_PASSES && pending.length > 0; pass += 1) {
		const retry: Recorded[] = [];
		for (const event of pending) {
			clock.now = (event.created + 1) * SECOND;
			const payload = JSON.stringify(event);
			const response = handleStripeWebhook(deps, {
				payload,
				signatureHeader: signStripePayload({
					payload,
					secret: SECRET,
					timestampSeconds: event.created + 1,
				}),
			});
			if (response.status === 409) retry.push(event);
		}
		pending = retry;
	}
	return (
		raw.query("SELECT body FROM ledger_outbox ORDER BY id").all() as {
			body: string;
		}[]
	).map((row) => JSON.parse(row.body));
};

describe("inputCauseId is the cause the handler writes", () => {
	test.each(SCENARIOS)(
		"%s: every outbox cause is the id of a delivered event",
		(scenario) => {
			const events = scenarioEvents(scenario);
			const expected = new Map(
				events.map((event) => [
					inputCauseId({
						school: DELIVERED_SCHOOL,
						eventId: event.id,
						stripeCreated: event.created,
					}),
					event.type as string,
				]),
			);
			const causes = new Set(
				outboxOf(events).flatMap((event) => (event.cause ? [event.cause] : [])),
			);
			expect(causes.size).toBeGreaterThan(0);
			for (const cause of causes) expect(expected.has(cause)).toBe(true);
			// the first invoice's own decision is in the outbox under its cause
			const firstInvoice = events.find(
				(event) => event.type === "invoice.paid",
			);
			expect(
				causes.has(
					inputCauseId({
						school: DELIVERED_SCHOOL,
						eventId: firstInvoice.id,
						stripeCreated: firstInvoice.created,
					}),
				),
			).toBe(true);
		},
	);

	test("it is a ULID of the event's own second, and the school and Stripe id both change it", () => {
		const base = {
			school: "sch_a",
			eventId: "evt_1",
			stripeCreated: 1_700_000_000,
		};
		const id = inputCauseId(base);
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(inputCauseId(base)).toBe(id);
		expect(inputCauseId({ ...base, school: "sch_b" })).not.toBe(id);
		expect(inputCauseId({ ...base, eventId: "evt_2" })).not.toBe(id);
		expect(
			inputCauseId({ ...base, stripeCreated: base.stripeCreated + 1 }),
		).not.toBe(id);
	});

	test("it is the expression the handler computed inline before the extraction", () => {
		const base = {
			school: "sch_a",
			eventId: "evt_1",
			stripeCreated: 1_700_000_000,
		};
		expect(inputCauseId(base)).toBe(
			deterministicUlid({
				timeMs: base.stripeCreated * SECOND,
				revision: 0,
				seed: canonicalize([base.school, base.eventId]),
			}),
		);
	});

	test("contextHashOf is a stable hash of the menu, policy and price ids", () => {
		const context = deliveredContext();
		const hash = contextHashOf(context);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(contextHashOf({ ...context, catalog: [] } as WebhookContext)).toBe(
			hash,
		);
		expect(
			contextHashOf({
				...context,
				priceIds: { ...context.priceIds, extra: "x" },
			}),
		).not.toBe(hash);
		// the key order of the stored menu and policy does not change it
		const reversed = (value: unknown): unknown =>
			Array.isArray(value)
				? value.map(reversed)
				: value !== null && typeof value === "object"
					? Object.fromEntries(
							Object.entries(value)
								.reverse()
								.map(([key, item]) => [key, reversed(item)]),
						)
					: value;
		expect(contextHashOf(reversed(context) as WebhookContext)).toBe(hash);
	});
});

// ---- 5. mutations ----

describe("the comparison catches a broken refactor", () => {
	const mismatches = (mutation: Mutation): string[] => {
		const found: string[] = [];
		driveAllRecorded((input, result) => {
			if (!same(viaFact(input, mutation), result))
				found.push((input.event as { id: string }).id);
		});
		return found;
	};

	test("the unmutated path has no mismatch on the recorded events", () => {
		expect(mismatches({})).toEqual([]);
	});

	test("replayFactOf dropping metadata.family_id is caught on the recorded events", () => {
		const dropFamily = (fact: ReplayFact): ReplayFact => {
			const metadata = (fact as { metadata?: Record<string, string> }).metadata;
			if (!metadata) return fact;
			const { family_id: _dropped, ...rest } = metadata;
			return { ...fact, metadata: rest } as ReplayFact;
		};
		expect(mismatches({ trim: dropFamily }).length).toBeGreaterThan(0);
	});

	test("replayFactOf dropping metadata.family_id is caught on the random histories", () => {
		const dropFamily = (fact: ReplayFact): ReplayFact => {
			const metadata = (fact as { metadata?: Record<string, string> }).metadata;
			if (!metadata) return fact;
			const { family_id: _dropped, ...rest } = metadata;
			return { ...fact, metadata: rest } as ReplayFact;
		};
		let caught = 0;
		for (const seed of SEEDS.slice(0, 20)) {
			const store = createStore({
				menu: propertyMenu,
				school: SCHOOL,
				family: FAMILY,
				onHandled: (input, result) => {
					if (!same(viaFact(input, { trim: dropFamily }), result)) caught += 1;
				},
			});
			play({ seed, steps: 40, store });
		}
		expect(caught).toBeGreaterThan(0);
	});

	test("replayFactOf dropping the booking id of a checkout session is caught", () => {
		const dropBooking = (fact: ReplayFact): ReplayFact => {
			const metadata = (fact as { metadata?: Record<string, string> }).metadata;
			if (!metadata) return fact;
			const { booking_id: _dropped, ...rest } = metadata;
			return { ...fact, metadata: rest } as ReplayFact;
		};
		expect(mismatches({ trim: dropBooking }).length).toBeGreaterThan(0);
	});

	test("handleStripeFact ignoring the event type is caught (a closed dispute read as an opened one)", () => {
		const ignoresType = (_type: string) => "charge.dispute.created";
		const found = mismatches({ type: ignoresType });
		expect(found.length).toBeGreaterThan(0);
		// and it is the closed disputes that differ
		const closed = delivered.filter(
			(event) => event.type === "charge.dispute.closed",
		);
		expect(closed.length).toBeGreaterThan(0);
		expect(found.some((id) => closed.some((event) => event.id === id))).toBe(
			true,
		);
	});

	test("the time of a replay is the event's created second: nothing reads a clock", () => {
		const realNow = Date.now;
		Date.now = () => {
			throw new Error("the clock was read");
		};
		try {
			let compared = 0;
			driveAllRecorded((input, result) => {
				compared += 1;
				expect(same(viaFact(input), result)).toBe(true);
			});
			expect(compared).toBeGreaterThan(0);
		} finally {
			Date.now = realNow;
		}
	});
});
