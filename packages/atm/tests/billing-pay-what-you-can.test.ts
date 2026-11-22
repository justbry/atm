/**
 * A pay-what-you-can add-on (B4 Uni's Go Learn, `plans/b4uni-merchant/PLAN.md`): a one-time Stripe price with
 * `custom_unit_amount`, sold alone in a payment-mode checkout, booked at the amount the buyer chose and granting nothing.
 */
import { describe, expect, test } from "bun:test";
import b4uni from "../fixtures/billing/menu/b4uni-merchant.json";
import { validateMenu } from "../src/billing/menu.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	addonPriceKey,
	checkoutParams,
	giftProductKeys,
	lookupKeyOf,
	menuToStripe,
	oneTimeCheckoutParams,
} from "../src/billing/stripe-menu.js";
import type { Menu, MenuAddon, StripeOp } from "../src/billing/types.js";
import { createStore } from "../src/scenario/store.js";
import { chargeRefunded, invoicePaid } from "../src/scenario/stripe-events.js";
import { harness } from "./handler-harness.js";

const MERCHANT = "b4uni";
const POLICY = { ...DEFAULT_POLICY, memberCode: null };
const RETURN = { success: "https://x/ok", cancel: "https://x/no" };
const menu = (): Menu => structuredClone(b4uni) as Menu;
const goLearn = (m: Menu) =>
	m.addons.find((a) => a.id === "go_learn") as MenuAddon;
const problems = (m: unknown): string[] => {
	const result = validateMenu(m);
	if (result.ok) throw new Error("expected problems");
	return result.problems;
};
const goLearnKey = (m: Menu) => {
	const addon = goLearn(m);
	return lookupKeyOf(
		MERCHANT,
		addonPriceKey(
			addon.id,
			addon.price.every,
			addon.gift,
			addon.price.payWhatYouCan,
		),
		addon.price.amount,
		m.currency,
	);
};
const oneTime = (addonIds: string[], familyId = "fam_7", m = menu()) =>
	oneTimeCheckoutParams({
		schoolId: MERCHANT,
		menu: m,
		addonIds,
		familyId,
		menuVersion: 1,
		returnUrls: RETURN,
	});

describe("validateMenu: pay what you can", () => {
	test("Go Learn is valid: 50 cents to $500, starting at $48", () => {
		expect(validateMenu(menu()).ok).toBe(true);
		expect(goLearn(menu()).price).toEqual({
			amount: 50,
			every: "once",
			payWhatYouCan: { maximum: 50000, preset: 4800 },
		});
	});

	test("the least is the schema's 50 cents; the preset sits between the least and the most", () => {
		const m = menu();
		goLearn(m).price.amount = 49;
		expect(problems(m)).toEqual(["addons.4.price.amount"]);
		const low = menu();
		(goLearn(low).price.payWhatYouCan as { preset?: number }).preset = 40;
		expect(problems(low)).toEqual(["addons.4.price.payWhatYouCan.preset"]);
		const high = menu();
		(goLearn(high).price.payWhatYouCan as { preset?: number }).preset = 50001;
		expect(problems(high)).toEqual(["addons.4.price.payWhatYouCan.preset"]);
		const upsideDown = menu();
		goLearn(upsideDown).price.amount = 60000;
		expect(problems(upsideDown)).toEqual([
			"addons.4.price.payWhatYouCan.maximum",
			"addons.4.price.payWhatYouCan.preset",
		]);
		const noPreset = menu();
		delete goLearn(noPreset).price.payWhatYouCan?.preset;
		expect(validateMenu(noPreset).ok).toBe(true);
	});

	test("one-time only, not a gift, no credits", () => {
		const monthly = menu();
		goLearn(monthly).price.every = "month";
		expect(problems(monthly)).toEqual(["addons.4.price.every"]);
		const gift = menu();
		goLearn(gift).gift = "dollars";
		expect(problems(gift)).toEqual(["addons.4.gift"]);
		const credits = menu();
		goLearn(credits).grants = [
			{ featureId: "credits", amount: 10, every: "month" },
		];
		expect(problems(credits)).toEqual(["addons.4.grants"]);
	});
});

describe("menuToStripe: pay what you can", () => {
	const priceOps = (ops: StripeOp[]) =>
		ops.filter((op) => op.op === "price.create" || op.op === "price.archive");

	test("the price is made with custom_unit_amount, not unit_amount", () => {
		const m = menu();
		const create = menuToStripe({
			schoolId: MERCHANT,
			menu: m,
			previous: null,
			policy: POLICY,
		}).find((op) => op.op === "price.create" && op.lookupKey === goLearnKey(m));
		expect(create).toMatchObject({
			op: "price.create",
			productKey: "a:go_learn",
			unitAmount: null,
			customUnitAmount: { minimum: 50, maximum: 50000, preset: 4800 },
			recurring: null,
		});
		expect(goLearnKey(m)).toBe(
			"b4u_b4uni_a_go_learn_once_pwyc-50000-4800_50_usd",
		);
	});

	test("a fixed price has no customUnitAmount", () => {
		const create = menuToStripe({
			schoolId: MERCHANT,
			menu: menu(),
			previous: null,
			policy: POLICY,
		}).find(
			(op) => op.op === "price.create" && op.productKey === "a:credits_50",
		);
		expect(create).toMatchObject({ unitAmount: 500 });
		expect(create).not.toHaveProperty("customUnitAmount");
	});

	test("a new maximum or preset is a new price, and the old one is archived", () => {
		const before = menu();
		const after = menu();
		(goLearn(after).price.payWhatYouCan as { maximum: number }).maximum =
			100000;
		const ops = priceOps(
			menuToStripe({
				schoolId: MERCHANT,
				menu: after,
				previous: before,
				policy: POLICY,
			}),
		);
		expect(ops.map((op) => [op.op, op.lookupKey])).toEqual([
			["price.create", goLearnKey(after)],
			["price.archive", goLearnKey(before)],
		]);
		expect(
			menuToStripe({
				schoolId: MERCHANT,
				menu: after,
				previous: after,
				policy: POLICY,
			}),
		).toEqual([]);
	});

	test("a dollar gift cannot pay for it (Stripe takes no coupon on it)", () => {
		expect(giftProductKeys(MERCHANT, menu())).not.toContain("a:go_learn");
		expect(giftProductKeys(MERCHANT, menu())).toContain("a:credits_50");
	});
});

describe("checkout: pay what you can is sold alone", () => {
	test("alone, in a payment-mode checkout with an invoice", () => {
		const result = oneTime(["go_learn"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.params.mode).toBe("payment");
		expect(result.params.line_items).toEqual([
			{ lookupKey: goLearnKey(menu()), quantity: 1 },
		]);
		expect(result.params.invoice_creation.invoice_data.metadata).toMatchObject({
			b4u_school: MERCHANT,
			family_id: "fam_7",
			addon_ids: "go_learn",
		});
	});

	test("with another add-on, or on a membership's checkout, it is refused", () => {
		expect(oneTime(["go_learn", "credits_50"])).toEqual({
			ok: false,
			reason: "addon_sold_alone",
			addonId: "go_learn",
		});
		expect(
			checkoutParams({
				schoolId: MERCHANT,
				menu: menu(),
				tierId: "go_build",
				interval: "year",
				addonIds: ["go_learn"],
				familyId: "fam_7",
				menuVersion: 1,
				returnUrls: RETURN,
				policy: POLICY,
			}),
		).toEqual({ ok: false, reason: "addon_sold_alone", addonId: "go_learn" });
	});

	test("a one-time add-on checks the holder's prefix too", () => {
		expect(oneTime(["go_learn"], "guide-u42")).toEqual({
			ok: false,
			reason: "holder_not_in_audience",
			familyId: "guide-u42",
		});
		expect(oneTime(["vetting"], "guide-u42").ok).toBe(true);
	});
});

describe("the handler books what the buyer chose", () => {
	const at = Date.UTC(2026, 10, 23, 17);
	const paid = (m: Menu, amount: number) =>
		invoicePaid({
			eventId: "evt_go_learn",
			invoiceId: "in_go_learn",
			at,
			subscriptionId: null,
			reason: "manual",
			periodStart: at,
			periodEnd: at,
			lines: [{ lookupKey: goLearnKey(m), amount, interval: null }],
			metadata: { b4u_school: MERCHANT, family_id: "fam_7" },
		});

	test("$13 chosen: applied, booked to the add-on's income, no credits", () => {
		const m = menu();
		const family = createStore({ menu: m, school: MERCHANT, family: "fam_7" });
		const result = family.handle(paid(m, 1300), at);
		expect(result.refused ?? null).toBeNull();
		const payment = family.events.find(
			(e) => e.event_type === "payment.succeeded",
		);
		expect(payment?.postings).toEqual([
			{ account: "assets:stripe", amount: "13.00", commodity: "USD" },
			{
				account: "income:billing:addon:go_learn",
				amount: "-13.00",
				commodity: "USD",
			},
		]);
		expect(
			family.events.filter((e) => e.event_type.startsWith("credit.")),
		).toEqual([]);
		expect(family.avail(at, "credits")).toBe(0);
	});

	test("through the reference webhook handler: 200 applied, booked once", () => {
		const m = menu();
		const h = harness(undefined, { school: MERCHANT, menu: m });
		const first = h.deliver(paid(m, 4800), at);
		expect(first.status).toBe(200);
		expect(first.body.outcome).toBe("applied");
		expect(h.deliver(paid(m, 4800), at).body.outcome).toBe("duplicate");
		const payments = h
			.outbox()
			.filter((event) => event.event_type === "payment.succeeded");
		expect(payments).toHaveLength(1);
		expect(payments[0]?.postings[1]).toEqual({
			account: "income:billing:addon:go_learn",
			amount: "-48.00",
			commodity: "USD",
		});
	});

	test("a price the menu does not know is still refused, as before", () => {
		const m = menu();
		const family = createStore({ menu: m, school: MERCHANT, family: "fam_7" });
		const stray = paid(m, 1300);
		stray.data.object.lines.data[0].pricing.price_details.price =
			"price_not_on_the_menu";
		expect(family.handle(stray, at).refused?.reason).toBe("unmatched_line");
	});

	test("a full refund books the refund and takes nothing back", () => {
		const m = menu();
		const family = createStore({ menu: m, school: MERCHANT, family: "fam_7" });
		family.handle(paid(m, 1300), at);
		const result = family.handle(
			chargeRefunded({
				eventId: "evt_refund",
				chargeId: "ch_go_learn",
				invoiceId: "in_go_learn",
				amount: 1300,
				chargeAmount: 1300,
				at: at + 3_600_000,
			}),
			at + 3_600_000,
		);
		expect(result.refused ?? null).toBeNull();
		const refund = family.events.find(
			(e) => e.event_type === "payment.refunded",
		);
		expect(refund?.payload.amount).toBe(1300);
	});
});
