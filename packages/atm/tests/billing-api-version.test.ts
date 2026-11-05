/**
 * An endpoint left on an older Stripe API version sends invoice lines in the older shape (`line.price.id`,
 * `line.proration`), not the pinned clover one (`line.pricing.price_details.price`,
 * `line.parent.subscription_item_details.proration`). atm refuses such an event and says which version the endpoint is
 * on and how to fix it; it never reads a second, unchecked shape. The pre-clover event here is the recorded clover one
 * rewritten into the older layout.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import {
	describeNormalizeError,
	mappingFor,
	normalize,
} from "../src/billing/normalize.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import type { Menu } from "../src/billing/types.js";
import { deterministicUlid } from "../src/ledger/ids.js";

const CLOVER = "2025-10-29.clover";
const OLDER = "2024-06-20";

// biome-ignore lint/suspicious/noExplicitAny: raw Stripe JSON is rewritten by path in tests, untyped
type RawEvent = any;

const recordedDir = join(
	import.meta.dir,
	"../fixtures/billing/stripe/recorded",
);
const recorded = (name: string): RawEvent =>
	JSON.parse(readFileSync(join(recordedDir, name), "utf8"));

/** The recorded clover invoice event in the layout of an endpoint on `2024-06-20`: price and proration on the line, the subscription on the invoice. */
const preClover = (name: string): RawEvent => {
	const event = recorded(name);
	const invoice = event.data.object;
	const subscription = invoice.parent.subscription_details;
	event.api_version = OLDER;
	invoice.subscription = subscription.subscription;
	invoice.subscription_details = { metadata: subscription.metadata };
	invoice.parent = undefined;
	for (const line of invoice.lines.data) {
		const details = line.parent.subscription_item_details;
		line.price = {
			id: line.pricing.price_details.price,
			object: "price",
			product: line.pricing.price_details.product,
			unit_amount: Number(line.pricing.unit_amount_decimal),
			currency: line.currency,
		};
		line.proration = details.proration;
		line.subscription = details.subscription;
		line.subscription_item = details.subscription_item;
		line.pricing = undefined;
		line.parent = undefined;
	}
	return event;
};

const menu = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../fixtures/billing/grants/menu.json"),
		"utf8",
	),
) as Menu;
const SCHOOL = "sch_vol";

const handle = (event: RawEvent) =>
	handleStripeEvent({
		event,
		eventId: deterministicUlid({ timeMs: 1, revision: 0, seed: "api-version" }),
		menu,
		menuVersion: 1,
		policy: DEFAULT_POLICY,
		policyVersion: 1,
		rows: [],
		revision: 0,
		catalog: menuCatalogRows({ menu, school: SCHOOL }),
		now: Date.now(),
		priceIds: {},
	});

describe("an event from an API version atm does not read", () => {
	test.each([
		"invoice.paid.subscription_create.json",
		"invoice.paid.subscription_cycle.json",
	])(
		"%s at the older version is refused with the version and the fix",
		(name) => {
			const result = handle(preClover(name));
			expect(result.rowChanges).toBeNull();
			expect(result.events).toEqual([]);
			expect(result.refused?.reason).toBe("unknown_mapping");
			const message = result.refused?.message ?? "";
			expect(message).toContain(OLDER);
			expect(message).toContain(
				`recreate the endpoint with api_version ${CLOVER}`,
			);
			expect(message).not.toContain("{");
		},
	);

	test("the pre-clover layout really is the older one: the clover paths are gone, the older ones are there", () => {
		const event = preClover("invoice.paid.subscription_cycle.json");
		const line = event.data.object.lines.data[0];
		expect(line.pricing).toBeUndefined();
		expect(line.parent).toBeUndefined();
		expect(line.price.id).toMatch(/^price_/);
		expect(line.proration).toBe(false);
	});

	test("normalize with the clover mapping names both versions", () => {
		const event = preClover("invoice.paid.subscription_cycle.json");
		const mapping = mappingFor("invoice.paid", CLOVER);
		if (!mapping.ok) throw new Error("the clover mapping is missing");
		const result = normalize(event, mapping.value, { eventId: event.id });
		expect(result).toEqual({
			ok: false,
			error: { kind: "api_version", expected: CLOVER, got: OLDER },
		});
		if (result.ok) return;
		expect(describeNormalizeError(result.error)).toContain(OLDER);
		expect(describeNormalizeError(result.error)).toContain(
			`recreate the endpoint with api_version ${CLOVER}`,
		);
		expect(describeNormalizeError(result.error)).toStartWith(
			`the event is at Stripe API version ${OLDER}`,
		);
	});

	test("an event type no mapping reads is not blamed on the version", () => {
		const result = handle({ type: "customer.created", api_version: OLDER });
		expect(result.refused?.reason).toBe("unknown_mapping");
		expect(result.refused?.message).toContain("no mapping for the event type");
	});

	test("an event with no api_version is said to have none, not to be at a blank version", () => {
		const result = mappingFor("invoice.paid", "");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const message = describeNormalizeError(result.error);
		expect(message).toContain("no api_version");
		expect(message).toContain(CLOVER);
		expect(message).not.toContain("version , ");
	});

	test("a pre-clover body relabelled as clover (Stripe never sends one) grants nothing: its lines match no menu price", () => {
		const event = preClover("invoice.paid.subscription_cycle.json");
		event.api_version = CLOVER;
		event.data.object.metadata = {
			b4u_school: SCHOOL,
			family_id: "fam_8k2",
		};
		const result = handle(event);
		expect(result.rowChanges).toBeNull();
		expect(result.events).toEqual([]);
		expect(result.refused?.reason).toBe("unmatched_line");
	});

	test("the clover event is still read, so the refusal is about the version and not the event", () => {
		const event = recorded("invoice.paid.subscription_cycle.json");
		const mapping = mappingFor("invoice.paid", event.api_version);
		if (!mapping.ok) throw new Error("the clover mapping is missing");
		expect(normalize(event, mapping.value, { eventId: event.id }).ok).toBe(
			true,
		);
	});
});
