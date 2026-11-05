import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { mappingFileNames, renderIndex } from "../schema/mapping/build.js";
import {
	type Fact,
	type LineItem,
	MAPPINGS,
	type Mapping,
	mappingFor,
	mappingLabels,
	normalize,
	redactPersonal,
	resolveInvoice,
	resolveLines,
} from "../src/billing/normalize.js";
import type {
	BillingDispute,
	BillingInvoice,
	BillingRefund,
	SubscriptionFact,
} from "../src/billing/types.js";

const API = "2025-10-29.clover";
const fixtureDir = join(import.meta.dir, "../fixtures/billing/stripe");
// biome-ignore lint/suspicious/noExplicitAny: fixture JSON is read by path, untyped
const load = (name: string): any =>
	JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
const clone = <T>(v: T): T => structuredClone(v);

const mapping = (event: string): Mapping => {
	const r = mappingFor(event, API);
	if (!r.ok) throw new Error(`no mapping for ${event}`);
	return r.value;
};

const menu = new Map<string, LineItem>([
	["vol_sparkle_2s_month", { kind: "tier", tierId: "sparkle" }],
	["vol_shine_1s_month", { kind: "tier", tierId: "shine" }],
	["vol_addon_human_design_month", { kind: "addon", addonId: "human_design" }],
]);

const expectOk = (r: ReturnType<typeof normalize>): Fact => {
	if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
	return r.value;
};

describe("mapping index", () => {
	test("schema/mapping/index.ts is the generated output for the mapping files (run `bun schema/mapping/build.ts`)", () => {
		const committed = readFileSync(
			join(import.meta.dir, "../schema/mapping/index.ts"),
			"utf8",
		);
		expect(committed).toBe(renderIndex(mappingFileNames()));
	});

	test("MAPPINGS holds exactly the mapping files on disk", () => {
		expect(MAPPINGS.map((m) => m.event).sort()).toEqual(
			mappingFileNames()
				.map(
					(f) =>
						JSON.parse(
							readFileSync(
								join(import.meta.dir, "../schema/mapping", f),
								"utf8",
							),
						).event,
				)
				.sort(),
		);
	});
});

describe("mapping files", () => {
	test("every mapping file validates against mapping.schema.json", () => {
		const schema = JSON.parse(
			readFileSync(
				join(import.meta.dir, "../schema/mapping/mapping.schema.json"),
				"utf8",
			),
		);
		const ajv = new Ajv2020({ allErrors: true, strict: false });
		const validate = ajv.compile(schema);
		for (const m of MAPPINGS) {
			expect({
				event: m.event,
				errors: validate(m) ? [] : validate.errors,
			}).toEqual({ event: m.event, errors: [] });
		}
	});

	test("every path in every mapping parses", () => {
		for (const m of MAPPINGS) {
			const specs = [
				...Object.values(m.fields),
				...Object.values(m.lines?.fields ?? {}),
			];
			const paths = [
				...specs.flatMap((s) => [s.path, s.equalsPath ?? ""]),
				m.lines?.path ?? "",
				...m.personal,
			];
			for (const p of paths.filter(Boolean))
				expect(() => redactPersonal({}, { ...m, personal: [p] })).not.toThrow();
		}
	});

	test("mappingLabels gives the envelope labels", () => {
		expect(mappingLabels(mapping("invoice.paid"))).toEqual({
			mapping: "stripe/invoice.paid@v1",
			stripe_api_version: API,
		});
	});
});

describe("fixtures normalize to their facts", () => {
	test("invoice.paid: a monthly join with a tier line and an add-on line", () => {
		const raw = load("invoice.paid.json");
		const r = expectOk(
			normalize(raw, mapping("invoice.paid"), { eventId: raw.id }),
		);
		const inv = r as BillingInvoice & { lines: unknown[] };
		expect(inv.source).toEqual({
			eventId: "evt_SYNTH_0001",
			mapping: "stripe/invoice.paid@v1",
			stripeApiVersion: API,
		});
		expect({
			id: inv.id,
			customerId: inv.customerId,
			subscriptionId: inv.subscriptionId,
			reason: inv.reason,
			currency: inv.currency,
			amountPaid: inv.amountPaid,
			paidAt: inv.paidAt,
			periodStart: inv.periodStart,
			periodEnd: inv.periodEnd,
			metadata: inv.metadata,
		}).toEqual({
			id: "in_SYNTH_0001",
			customerId: "cus_SYNTH_0001",
			subscriptionId: "sub_SYNTH_0001",
			reason: "subscription_create",
			currency: "usd",
			amountPaid: 30000,
			paidAt: 1793491300000,
			periodStart: 1793491200000,
			periodEnd: 1796083200000,
			metadata: {
				b4u_school: "school_synth",
				family_id: "fam_SYNTH_0001",
				profile_id: "prof_SYNTH_0001",
				tier_id: "sparkle",
				interval: "month",
				menu_version: "1",
			},
		});
		expect(inv.lines).toEqual([
			{
				kind: "unknown",
				lookupKey: "vol_sparkle_2s_month",
				priceId: "price_SYNTH_sparkle_2s_month",
				interval: "month",
				quantity: 1,
				proration: false,
				amount: 26000,
				periodStart: 1793491200000,
				periodEnd: 1796083200000,
			},
			{
				kind: "unknown",
				lookupKey: "vol_addon_human_design_month",
				priceId: "price_SYNTH_addon_hd_month",
				interval: "month",
				quantity: 1,
				proration: false,
				amount: 4000,
				periodStart: 1793491200000,
				periodEnd: 1796083200000,
			},
		]);
		const resolved = resolveInvoice(inv, menu);
		expect(resolved.lines.map((l) => [l.kind, l.tierId ?? l.addonId])).toEqual([
			["tier", "sparkle"],
			["addon", "human_design"],
		]);
	});

	test("invoice.paid upgrade: proration lines, reason subscription_update", () => {
		const raw = load("invoice.paid.upgrade.json");
		const inv = expectOk(
			normalize(raw, mapping("invoice.paid"), { eventId: raw.id }),
		) as BillingInvoice;
		expect(inv.reason).toBe("subscription_update");
		expect(inv.amountPaid).toBe(5000);
		expect(inv.metadata).toEqual({});
		const resolved = resolveInvoice(inv, menu);
		expect(
			resolved.lines.map((l) => [l.kind, l.tierId, l.proration, l.amount]),
		).toEqual([
			["tier", "sparkle", true, -13000],
			["tier", "shine", true, 18000],
		]);
	});

	test("charge.refunded: a full refund", () => {
		const raw = load("charge.refunded.json");
		const r = expectOk(
			normalize(raw, mapping("charge.refunded"), { eventId: raw.id }),
		) as BillingRefund;
		expect(r).toEqual({
			source: {
				eventId: "evt_SYNTH_0003",
				mapping: "stripe/charge.refunded@v1",
				stripeApiVersion: API,
			},
			id: "re_SYNTH_0001",
			invoiceId: "in_SYNTH_0001",
			chargeId: "ch_SYNTH_0001",
			amount: 26000,
			full: true,
			at: 1793495100000,
		});
	});

	test("charge.dispute.created: open", () => {
		const raw = load("charge.dispute.created.json");
		const d = expectOk(
			normalize(raw, mapping("charge.dispute.created"), { eventId: raw.id }),
		) as BillingDispute;
		expect(d).toEqual({
			source: {
				eventId: "evt_SYNTH_0004",
				mapping: "stripe/charge.dispute.created@v1",
				stripeApiVersion: API,
			},
			id: "dp_SYNTH_0001",
			invoiceId: null,
			chargeId: "ch_SYNTH_0002",
			status: "open",
			at: 1793600000000,
		});
	});

	test("charge.dispute.closed: won", () => {
		const raw = load("charge.dispute.closed.json");
		const d = expectOk(
			normalize(raw, mapping("charge.dispute.closed"), { eventId: raw.id }),
		) as BillingDispute;
		expect(d.status).toBe("won");
		expect(d.at).toBe(1795000000000);
	});

	test("customer.subscription.created: active, monthly, with tier metadata", () => {
		const raw = load("customer.subscription.created.json");
		const s = expectOk(
			normalize(raw, mapping("customer.subscription.created"), {
				eventId: raw.id,
			}),
		) as SubscriptionFact;
		expect(s).toEqual({
			source: {
				eventId: "evt_SYNTH_0006",
				mapping: "stripe/customer.subscription.created@v1",
				stripeApiVersion: API,
			},
			id: "sub_SYNTH_0001",
			customerId: "cus_SYNTH_0001",
			status: "active",
			tierId: "sparkle",
			interval: "month",
			currentPeriodStart: 1793491200000,
			currentPeriodEnd: 1796083200000,
			cancelAtPeriodEnd: false,
			at: 1793491150000,
			metadata: {
				b4u_school: "school_synth",
				family_id: "fam_SYNTH_0001",
				profile_id: "prof_SYNTH_0001",
				tier_id: "sparkle",
				interval: "month",
				menu_version: "1",
				addon_ids: "human_design",
			},
		});
	});

	test("customer.subscription.updated: cancel at period end", () => {
		const raw = load("customer.subscription.updated.json");
		const s = expectOk(
			normalize(raw, mapping("customer.subscription.updated"), {
				eventId: raw.id,
			}),
		) as SubscriptionFact;
		expect(s.status).toBe("active");
		expect(s.cancelAtPeriodEnd).toBe(true);
	});

	test("customer.subscription.deleted: canceled", () => {
		const raw = load("customer.subscription.deleted.json");
		const s = expectOk(
			normalize(raw, mapping("customer.subscription.deleted"), {
				eventId: raw.id,
			}),
		) as SubscriptionFact;
		expect(s.status).toBe("canceled");
		expect(s.at).toBe(1796083300000);
	});
});

describe("errors", () => {
	test("a missing required path fails and names it", () => {
		const raw = load("invoice.paid.json");
		delete raw.data.object.amount_paid;
		const r = normalize(raw, mapping("invoice.paid"), { eventId: raw.id });
		expect(r).toEqual({
			ok: false,
			error: {
				kind: "missing_path",
				field: "amountPaid",
				path: "$.data.object.amount_paid",
			},
		});
	});

	test("a missing line field fails and names it", () => {
		const raw = load("invoice.paid.json");
		delete raw.data.object.lines.data[1].amount;
		const r = normalize(raw, mapping("invoice.paid"), { eventId: raw.id });
		expect(r).toEqual({
			ok: false,
			error: { kind: "missing_path", field: "amount", path: "$.amount" },
		});
	});

	test("an unknown subscription status is a bad value, not a guess", () => {
		const raw = load("customer.subscription.created.json");
		raw.data.object.status = "frozen";
		const r = normalize(raw, mapping("customer.subscription.created"), {
			eventId: raw.id,
		});
		expect(r).toEqual({
			ok: false,
			error: {
				kind: "bad_value",
				field: "status",
				path: "$.data.object.status",
			},
		});
	});

	test("a wrong event type is refused", () => {
		const raw = load("charge.refunded.json");
		const r = normalize(raw, mapping("invoice.paid"), { eventId: raw.id });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.kind).toBe("event_type");
	});

	test("an event from another API version is refused", () => {
		const raw = load("invoice.paid.json");
		raw.api_version = "2020-08-27";
		const r = normalize(raw, mapping("invoice.paid"), { eventId: raw.id });
		expect(r).toEqual({
			ok: false,
			error: { kind: "api_version", expected: API, got: "2020-08-27" },
		});
	});

	test("an unknown API version has no mapping", () => {
		expect(mappingFor("invoice.paid", "2020-08-27")).toEqual({
			ok: false,
			error: {
				kind: "unknown_mapping",
				event: "invoice.paid",
				apiVersion: "2020-08-27",
				known: [API],
			},
		});
		expect(mappingFor("no.such.event", API).ok).toBe(false);
	});
});

describe("values", () => {
	test("seconds become milliseconds", () => {
		const raw = load("charge.refunded.json");
		const r = expectOk(
			normalize(raw, mapping("charge.refunded"), { eventId: raw.id }),
		) as BillingRefund;
		expect(r.at).toBe(raw.created * 1000);
	});

	test("an unknown billing reason is 'other'", () => {
		const raw = load("invoice.paid.json");
		raw.data.object.billing_reason = "subscription_threshold";
		const inv = expectOk(
			normalize(raw, mapping("invoice.paid"), { eventId: raw.id }),
		) as BillingInvoice;
		expect(inv.reason).toBe("other");
	});

	test("a full refund is amount_refunded equal to amount; a partial one is not", () => {
		const raw = load("charge.refunded.json");
		raw.data.object.amount_refunded = 10000;
		raw.data.object.refunds.data[0].amount = 10000;
		const r = expectOk(
			normalize(raw, mapping("charge.refunded"), { eventId: raw.id }),
		) as BillingRefund;
		expect(r.full).toBe(false);
		expect(r.amount).toBe(10000);
	});

	test("a dispute still needing a response is open; a lost one is lost", () => {
		const raw = load("charge.dispute.created.json");
		expect(
			(
				expectOk(
					normalize(raw, mapping("charge.dispute.created"), {
						eventId: raw.id,
					}),
				) as BillingDispute
			).status,
		).toBe("open");
		raw.data.object.status = "lost";
		expect(
			(
				expectOk(
					normalize(raw, mapping("charge.dispute.created"), {
						eventId: raw.id,
					}),
				) as BillingDispute
			).status,
		).toBe("lost");
	});

	test("an optional missing field takes its default", () => {
		const raw = load("customer.subscription.created.json");
		delete raw.data.object.metadata.tier_id;
		const s = expectOk(
			normalize(raw, mapping("customer.subscription.created"), {
				eventId: raw.id,
			}),
		) as SubscriptionFact;
		expect(s.tierId).toBeNull();
	});
});

describe("line resolution", () => {
	test("a line matches by price id when no lookup key matches; lookup keys stay on the line", () => {
		const raw = load("invoice.paid.json");
		const inv = expectOk(
			normalize(raw, mapping("invoice.paid"), { eventId: raw.id }),
		) as BillingInvoice;
		const byPrice = new Map<string, LineItem>([
			["price_SYNTH_sparkle_2s_month", { kind: "tier", tierId: "sparkle" }],
		]);
		const lines = resolveLines(inv.lines, byPrice);
		expect(lines.map((l) => l.kind)).toEqual(["tier", "unknown"]);
		expect(lines[0]).toMatchObject({
			lookupKey: "vol_sparkle_2s_month",
			priceId: "price_SYNTH_sparkle_2s_month",
		});
		expect(lines[1]).toMatchObject({
			kind: "unknown",
			lookupKey: "vol_addon_human_design_month",
		});
	});
});

describe("redaction", () => {
	test("removes exactly the personal paths", () => {
		const raw = load("invoice.paid.json");
		const m = mapping("invoice.paid");
		const before = clone(raw);
		const red = redactPersonal(raw, m) as typeof raw;
		const expected = clone(raw);
		for (const k of [
			"customer_email",
			"customer_name",
			"customer_address",
			"customer_phone",
		])
			delete expected.data.object[k];
		expect(red).toEqual(expected);
		expect(raw).toEqual(before); // input untouched
	});

	test("the redacted payload still normalizes to the same fact", () => {
		const raw = load("charge.refunded.json");
		const m = mapping("charge.refunded");
		const direct = normalize(raw, m, { eventId: raw.id });
		const viaRedacted = normalize(redactPersonal(raw, m), m, {
			eventId: raw.id,
		});
		expect(viaRedacted).toEqual(direct);
	});
});

describe("determinism", () => {
	test("the same input gives byte-identical output, every time", () => {
		for (const [file, event] of [
			["invoice.paid.json", "invoice.paid"],
			["charge.dispute.closed.json", "charge.dispute.closed"],
			["customer.subscription.updated.json", "customer.subscription.updated"],
		] as const) {
			const raw = load(file);
			const a = JSON.stringify(
				normalize(raw, mapping(event), { eventId: raw.id }),
			);
			const b = JSON.stringify(
				normalize(clone(raw), mapping(event), { eventId: raw.id }),
			);
			expect(b).toBe(a);
		}
	});
});
