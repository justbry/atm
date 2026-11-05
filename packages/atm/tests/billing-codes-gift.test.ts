/**
 * Gift codes (0.8.0): the dollar gift certificate's Stripe steps (`dollarGiftOps`) and the session gift code
 * (`createSessionGiftCode`, `redeemSessionGiftCode`), which grants credits as a new row through the engine with no Stripe.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	createSessionGiftCode,
	dollarGiftOps,
	MAX_GIFT_CREDITS,
	redeemSessionGiftCode,
} from "../src/billing/codes.js";
import {
	addZonedMonths,
	EMPTY_GRANTS_STATE,
	menuCatalogRows,
} from "../src/billing/grants.js";
import { commandOrg, DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	applyRowChanges,
	type BillingRow,
	GRANTS_TABLE,
	grantsFromRows,
	grantsRow,
	stateFromRows,
} from "../src/billing/rows.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type {
	BillingPolicy,
	Menu,
	RedeemSessionGiftCodeInput,
	SessionGiftCode,
} from "../src/billing/types.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import { validateEvent } from "../src/ledger/validate.js";
import { createStore } from "./billing-store.js";
import { invoicePaid } from "./stripe-events.js";

const SCHOOL = "sch_vol";
const FAMILY = "fam_gift";
const HOLDER = { orgId: SCHOOL, customerId: `family:${FAMILY}` };
const OTHER = { orgId: SCHOOL, customerId: "family:fam_other" };
const DAY = 86_400_000;
const T0 = Date.parse("2026-01-15T18:00:00Z");
const menu = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;
const catalog = menuCatalogRows({ menu, school: SCHOOL });
const policy: BillingPolicy = DEFAULT_POLICY;
const metadata = { b4u_school: SCHOOL, family_id: FAMILY };

describe("dollarGiftOps", () => {
	const input = {
		schoolId: "0c1d2e3f-aaaa-bbbb-cccc-111122223333",
		menu,
		policy,
		giftId: "g1",
		code: "THANKS-2026",
		amount: 5000,
		issuedAt: Date.parse("2026-01-15T18:00:00Z"),
	};

	test("a coupon for the amount off the products a certificate may pay for, and a one-use promotion code that ends", () => {
		const result = dollarGiftOps(input);
		if (!result.ok) throw new Error(result.message);
		const [coupon, promotion] = result.ops;
		expect(coupon).toMatchObject({
			op: "coupon.ensure_amount",
			id: "b4u_0c1d2e3f_gift_g1",
			amountOff: 5000,
			currency: "usd",
			// every public tier and non-gift add-on, never the gift add-ons themselves
			appliesToProductKeys: [
				"t:sparkle-1",
				"t:sparkle-2",
				"t:sparkle-4",
				"a:pack",
				"a:glow",
			],
		});
		expect(promotion).toMatchObject({
			op: "promotion_code.ensure_limited",
			code: "THANKS-2026",
			couponId: "b4u_0c1d2e3f_gift_g1",
			maxRedemptions: 1,
			expiresAt: result.expiresAt,
		});
		expect(result.ops).toHaveLength(2);
	});

	test("the keys are deterministic and tell gifts apart", () => {
		const first = dollarGiftOps(input);
		const again = dollarGiftOps(input);
		const other = dollarGiftOps({
			...input,
			giftId: "g2",
			code: "THANKS-2027",
		});
		if (!first.ok || !again.ok || !other.ok) throw new Error("refused");
		expect(again).toEqual(first);
		for (const op of first.ops) expect(op.idempotencyKey).toMatch(/^atm:/);
		const keys = (ops: typeof first.ops) => ops.map((op) => op.idempotencyKey);
		expect(keys(other.ops).some((key) => keys(first.ops).includes(key))).toBe(
			false,
		);
	});

	test("the amount is a whole number of cents, at least the policy's minimum", () => {
		expect(dollarGiftOps({ ...input, amount: 2499 })).toMatchObject({
			ok: false,
			reason: "below_minimum",
		});
		expect(dollarGiftOps({ ...input, amount: 2500 }).ok).toBe(true);
		expect(dollarGiftOps({ ...input, amount: 2500.5 })).toMatchObject({
			ok: false,
			reason: "below_minimum",
		});
		expect(
			dollarGiftOps({
				...input,
				amount: 1000,
				policy: { ...policy, giftDollarMinimum: 1000 },
			}).ok,
		).toBe(true);
	});

	test("the code is 6 to 40 letters, digits, - and _", () => {
		for (const code of ["short", "has space", "x".repeat(41), "bad!code", ""])
			expect(dollarGiftOps({ ...input, code })).toMatchObject({
				ok: false,
				reason: "bad_code",
			});
		expect(dollarGiftOps({ ...input, code: "abc123" }).ok).toBe(true);
	});

	test("it ends giftDollarMonths on from issue, on the school's calendar (a month end clamps)", () => {
		const oneMonth = { ...policy, giftDollarMonths: 1 };
		const end = (issuedAt: string) => {
			const result = dollarGiftOps({
				...input,
				policy: oneMonth,
				issuedAt: Date.parse(issuedAt),
			});
			if (!result.ok) throw new Error(result.message);
			return result.expiresAt;
		};
		// noon in Denver on Jan 31 (19:00 UTC, MST): Feb 28 at noon
		expect(end("2026-01-31T19:00:00Z")).toBe(
			Date.parse("2026-02-28T19:00:00Z"),
		);
		// 8pm on Feb 28 in Denver is Mar 1 in UTC; a month on is Mar 28 8pm in Denver (MDT after Mar 8), not Apr 1
		expect(end("2026-03-01T03:00:00Z")).toBe(
			Date.parse("2026-03-29T02:00:00Z"),
		);
		// the default is twelve months
		const year = dollarGiftOps(input);
		if (!year.ok) throw new Error("refused");
		expect(year.expiresAt).toBe(
			addZonedMonths(input.issuedAt, 12, menu.timeZone),
		);
		expect(year.expiresAt).toBe(Date.parse("2027-01-15T18:00:00Z"));
	});

	test("a menu with nothing to sell cannot carry a gift; a bad issue time is refused", () => {
		const bare: Menu = {
			...menu,
			tiers: menu.tiers.map((tier) => ({ ...tier, public: false })),
			addons: menu.addons.filter((addon) => addon.gift),
		};
		expect(dollarGiftOps({ ...input, menu: bare })).toMatchObject({
			ok: false,
			reason: "nothing_to_sell",
		});
		expect(dollarGiftOps({ ...input, issuedAt: Number.NaN })).toMatchObject({
			ok: false,
			reason: "bad_expiry",
		});
	});
});

describe("createSessionGiftCode", () => {
	const input = {
		id: "code_1",
		code: "VISIT-FOR-YOU",
		featureId: "visit",
		credits: 2,
		redeemBy: T0 + 90 * DAY,
		createdAt: T0,
		menu,
		policy,
	};

	test("a code with the policy's credit months and nobody who redeemed it", () => {
		expect(createSessionGiftCode(input)).toEqual({
			ok: true,
			code: {
				v: 1,
				id: "code_1",
				kind: "sessions",
				code: "VISIT-FOR-YOU",
				featureId: "visit",
				credits: 2,
				redeemBy: T0 + 90 * DAY,
				creditMonths: 6,
				createdAt: T0,
				redeemed: null,
			},
		});
		const longer = createSessionGiftCode({
			...input,
			policy: { ...policy, giftSessionMonths: 9 },
		});
		expect(longer.ok && longer.code.creditMonths).toBe(9);
	});

	test("each thing that can be wrong has its own reason", () => {
		const reason = (change: Partial<typeof input>) => {
			const result = createSessionGiftCode({ ...input, ...change });
			return result.ok ? "ok" : result.reason;
		};
		expect(reason({ code: "short" })).toBe("bad_code");
		expect(reason({ code: "bad code!" })).toBe("bad_code");
		expect(reason({ id: "" })).toBe("bad_code");
		expect(reason({ featureId: "nope" })).toBe("unknown_feature");
		expect(reason({ credits: 0 })).toBe("bad_credits");
		expect(reason({ credits: 1.5 })).toBe("bad_credits");
		expect(reason({ credits: -1 })).toBe("bad_credits");
		expect(reason({ credits: MAX_GIFT_CREDITS + 1 })).toBe("bad_credits");
		expect(reason({ credits: MAX_GIFT_CREDITS })).toBe("ok");
		expect(reason({ redeemBy: T0 })).toBe("bad_expiry");
		expect(reason({ redeemBy: T0 - DAY })).toBe("bad_expiry");
		expect(reason({ redeemBy: Number.NaN })).toBe("bad_expiry");
	});
});

describe("redeemSessionGiftCode", () => {
	const made = (change: Partial<SessionGiftCode> = {}): SessionGiftCode => {
		const result = createSessionGiftCode({
			id: "code_1",
			code: "VISIT-FOR-YOU",
			featureId: "visit",
			credits: 2,
			redeemBy: T0 + 90 * DAY,
			createdAt: T0,
			menu,
			policy,
		});
		if (!result.ok) throw new Error(result.message);
		return { ...result.code, ...change };
	};
	const NOW = T0 + 10 * DAY;
	const redeem = (
		change: Partial<RedeemSessionGiftCodeInput> & { code?: SessionGiftCode },
	) =>
		redeemSessionGiftCode({
			code: made(),
			entered: "visit-for-you",
			holder: HOLDER,
			menu,
			menuVersion: 4,
			policy,
			policyVersion: 2,
			rows: [],
			revision: 0,
			catalog,
			now: NOW,
			...change,
		});
	const must = (result: ReturnType<typeof redeem>) => {
		if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
		return result;
	};
	const written = (
		rows: readonly BillingRow[],
		revision: number,
		result: ReturnType<typeof must>,
	) => {
		if (!result.rowChanges) throw new Error("nothing to write");
		return applyRowChanges({ rows, revision, changes: result.rowChanges });
	};
	const availOf = (rows: BillingRow[], revision: number, asOf: number) =>
		createStore({
			menu,
			school: SCHOOL,
			family: FAMILY,
			start: { rows, revision },
		}).avail(asOf);

	test("a new family with no rows: a customer and a gift row are made, the credits count, and the code is redeemed", () => {
		const result = must(redeem({}));
		expect(result.rowChanges).toMatchObject({
			subjectKey: `${SCHOOL}|live|${HOLDER.customerId}`,
			expectedRevision: 0,
			nextRevision: 1,
			deletes: [],
		});
		const tables = result.rowChanges?.upserts.map((row) => row.table).sort();
		expect(tables).toEqual(["atm_grants", "customer", "customerEntitlements"]);
		const row = result.rowChanges?.upserts.find(
			(r) => r.table === "customerEntitlements",
		);
		expect(row?.id).toBe("ce_gift_code_6_code_1_visit");
		expect(row?.data).toMatchObject({
			entitlement_id: "ent_gift_visit",
			balance: 2,
			next_reset_at: null,
			// 6 months on the school's calendar (Denver), not UTC
			expires_at: addZonedMonths(NOW, 6, menu.timeZone),
		});
		const next = written([], 0, result);
		expect(availOf(next.rows, next.revision, NOW + DAY)).toBe(2);
		const grants = grantsFromRows(next.rows);
		expect(grants.redeemed?.code_1).toEqual(result.redeemed);
		expect(result.redeemed).toEqual({
			codeId: "code_1",
			feature: "visit",
			credits: 2,
			at: NOW,
			rowId: "ce_gift_code_6_code_1_visit",
			expiresAt: addZonedMonths(NOW, 6, menu.timeZone),
		});
		expect(grants.rows.ce_gift_code_6_code_1_visit).toBe(1);
		expect(grants.identity).toEqual(HOLDER);
		// the code's next state
		expect(result.code).toEqual({
			...made(),
			redeemed: { holderId: HOLDER.customerId, at: NOW },
		});
	});

	test("the gift lapses when it should: usable before, gone after", () => {
		const result = must(redeem({}));
		const next = written([], 0, result);
		const lapse = addZonedMonths(NOW, 6, menu.timeZone);
		expect(availOf(next.rows, next.revision, lapse - DAY)).toBe(2);
		expect(availOf(next.rows, next.revision, lapse + DAY)).toBe(0);
	});

	test("the events are the engine's own: a credit.granted on the plan gift, labelled and valid", () => {
		const { events } = must(redeem({}));
		expect(events.map((event) => event.event_type)).toContain("credit.granted");
		const granted = events.find(
			(event) => event.event_type === "credit.granted",
		);
		expect(granted?.labels).toMatchObject({
			feature: "visit",
			plan: "gift",
			menu_version: "4",
			policy_version: "2",
			mapping: "atm/session-gift-code@v1",
			gift_code: "code_1",
		});
		for (const event of events)
			expect(validateEvent(event).errors, event.idem).toEqual([]);
	});

	test("the same inputs give the same result: no clock, no randomness", () => {
		expect(JSON.stringify(redeem({}))).toBe(JSON.stringify(redeem({})));
		const result = must(redeem({}));
		expect(JSON.stringify(result.events)).toContain("gift:code_1");
	});

	test("a holder whose only row is the grants row (a dollar gift came first) keeps its revision and gets a customer", () => {
		const first = grantsRow({ ...EMPTY_GRANTS_STATE, holder: HOLDER });
		const result = must(redeem({ rows: [first], revision: 1 }));
		expect(result.rowChanges).toMatchObject({
			expectedRevision: 1,
			nextRevision: 2,
		});
		const next = written([first], 1, result);
		expect(next.rows.some((row) => row.table === "customer")).toBe(true);
		expect(availOf(next.rows, next.revision, NOW + DAY)).toBe(2);
		expect(grantsFromRows(next.rows).holder).toEqual(HOLDER);
	});

	describe("a family with a membership", () => {
		const member = () => {
			const store = createStore({ menu, school: SCHOOL, family: FAMILY });
			store.handle(
				invoicePaid({
					eventId: "evt_create",
					invoiceId: "in_1",
					at: T0 + 5000,
					subscriptionId: "sub_1",
					reason: "subscription_create",
					periodStart: T0,
					periodEnd: T0 + 30 * DAY,
					lines: [
						{
							lookupKey: lookupKeyOf(
								SCHOOL,
								tierPriceKey("sparkle-2", "month"),
								26000,
								"usd",
							),
							amount: 26000,
							interval: "month",
						},
					],
					metadata,
				}),
				T0 + 5000,
			);
			return store;
		};

		test("the credits are a NEW row beside the tier's; nothing existing is touched", () => {
			const store = member();
			const before = store.avail(NOW);
			const result = must(
				redeem({ rows: store.rows, revision: store.revision }),
			);
			const upserts = result.rowChanges?.upserts ?? [];
			expect(result.rowChanges?.deletes).toEqual([]);
			expect(upserts.map((row) => `${row.table}:${row.id}`).sort()).toEqual([
				"atm_grants:grants",
				"customerEntitlements:ce_gift_code_6_code_1_visit",
			]);
			expect(result.rowChanges?.expectedRevision).toBe(store.revision);
			expect(result.rowChanges?.nextRevision).toBe(store.revision + 1);
			const next = written(store.rows, store.revision, result);
			expect(availOf(next.rows, next.revision, NOW)).toBe(before + 2);
			// the membership record is as it was
			const grants = grantsFromRows(next.rows);
			expect(grants.tierId).toBe("sparkle-2");
			expect(grants.membership).toEqual(grantsFromRows(store.rows).membership);
		});

		test("the row that lapses soonest is drawn first (commandOrg), the gift before a yearly tier row", () => {
			const store = createStore({ menu, school: SCHOOL, family: FAMILY });
			store.handle(
				invoicePaid({
					eventId: "evt_year",
					invoiceId: "in_y",
					at: T0 + 5000,
					subscriptionId: "sub_y",
					reason: "subscription_create",
					periodStart: T0,
					periodEnd: T0 + 365 * DAY,
					lines: [
						{
							lookupKey: lookupKeyOf(
								SCHOOL,
								tierPriceKey("sparkle-2", "year"),
								260000,
								"usd",
							),
							amount: 260000,
							interval: "year",
						},
					],
					metadata,
				}),
				T0 + 5000,
			);
			const result = must(
				redeem({ rows: store.rows, revision: store.revision }),
			);
			const next = written(store.rows, store.revision, result);
			const identity = {
				orgId: SCHOOL,
				env: "live" as const,
				customerId: HOLDER.customerId,
				entityId: null,
			};
			const drawn = (deductionOrder: BillingPolicy["deductionOrder"]) => {
				const run = runOnState({
					state: stateFromRows({
						identity,
						revision: next.revision,
						rows: next.rows,
					}),
					catalog: toCatalog(catalog),
					command: {
						schemaVersion: 1,
						type: "track",
						org: commandOrg({ ...policy, deductionOrder }),
						commandId: "track_1",
						requestId: "track_1",
						identity,
						occurredAt: NOW + DAY,
						featureId: "visit",
						internalFeatureId: "feat_visit",
						value: 1,
						overageBehavior: "reject",
						properties: null,
						usageEvent: null,
					},
				});
				return (run.mutation?.changes ?? [])
					.filter(
						(c) => c.table === "customerEntitlements" && c.op === "increment",
					)
					.map((c) => (c as { id: string }).id);
			};
			expect(drawn("expiry")).toEqual(["ce_gift_code_6_code_1_visit"]);
			expect(drawn("engine")).not.toContain("ce_gift_code_6_code_1_visit");
		});
	});

	test("a second redeem by the same holder is a replay: ok, nothing to write, the stored code unchanged", () => {
		const first = must(redeem({}));
		const next = written([], 0, first);
		// the caller stored the code's next state; the replay is handed that
		const again = must(
			redeem({ code: first.code, rows: next.rows, revision: next.revision }),
		);
		expect(again.rowChanges).toBeNull();
		expect(again.events).toEqual([]);
		expect(again.code).toEqual(first.code);
		expect(again.redeemed).toEqual(first.redeemed);
		// and a replay before the code's state was written (the first write succeeded, the code row did not) is the same
		const stale = must(redeem({ rows: next.rows, revision: next.revision }));
		expect(stale.rowChanges).toBeNull();
		expect(stale.code).toEqual(made());
		// never a second row of credits
		expect(availOf(next.rows, next.revision, NOW + DAY)).toBe(2);
	});

	test("a replay is still ok after the code's redeemBy", () => {
		const first = must(redeem({}));
		const next = written([], 0, first);
		const late = redeem({
			code: first.code,
			rows: next.rows,
			revision: next.revision,
			now: T0 + 200 * DAY,
		});
		expect(late.ok && late.rowChanges).toBeNull();
	});

	test("another holder, with the code's state as stored after the first redemption, is already_redeemed", () => {
		const first = must(redeem({}));
		const second = redeem({ code: first.code, holder: OTHER });
		expect(second).toMatchObject({ ok: false, reason: "already_redeemed" });
	});

	test("atm alone cannot stop two holders who both read the unredeemed code: the caller's guarded write must", () => {
		const a = must(redeem({ holder: HOLDER }));
		const b = must(redeem({ holder: OTHER }));
		// both pass, and each says the code's next state is theirs: only `UPDATE ... WHERE redeemed IS NULL` lets one stand
		expect(a.code.redeemed?.holderId).toBe(HOLDER.customerId);
		expect(b.code.redeemed?.holderId).toBe(OTHER.customerId);
	});

	test("past redeemBy it is expired; at redeemBy it still works", () => {
		expect(redeem({ now: T0 + 90 * DAY + 1 })).toMatchObject({
			ok: false,
			reason: "expired",
		});
		expect(redeem({ now: T0 + 90 * DAY }).ok).toBe(true);
	});

	test("the wrong text is code_mismatch, checked without case and ignoring outer spaces", () => {
		expect(redeem({ entered: "VISIT-FOR-ME" })).toMatchObject({
			ok: false,
			reason: "code_mismatch",
		});
		expect(redeem({ entered: "" })).toMatchObject({
			ok: false,
			reason: "code_mismatch",
		});
		expect(redeem({ entered: "  Visit-For-You " }).ok).toBe(true);
	});

	test("the text is checked before anything else", () => {
		expect(
			redeem({
				entered: "nope",
				code: made({ redeemed: { holderId: "x", at: 1 } }),
				now: T0 + 999 * DAY,
			}),
		).toMatchObject({ reason: "code_mismatch" });
	});

	test("a feature the menu no longer has is unknown_feature, and nothing is written", () => {
		const result = redeem({ code: made({ featureId: "gone" }) });
		expect(result).toMatchObject({ ok: false, reason: "unknown_feature" });
	});

	test("a gift of a second feature is its own row on the same holder", () => {
		const first = must(redeem({}));
		const next = written([], 0, first);
		const retreat = must(
			redeem({
				code: made({
					id: "code_2",
					code: "RETREAT-GIFT",
					featureId: "retreat",
					credits: 1,
				}),
				entered: "RETREAT-GIFT",
				rows: next.rows,
				revision: next.revision,
			}),
		);
		const after = written(next.rows, next.revision, retreat);
		const grants = grantsFromRows(after.rows);
		expect(Object.keys(grants.redeemed ?? {}).sort()).toEqual([
			"code_1",
			"code_2",
		]);
		expect(after.rows.filter((r) => r.table === "customer")).toHaveLength(1);
		expect(
			after.rows.some((r) => r.table === GRANTS_TABLE && r.id === "grants"),
		).toBe(true);
	});
});
