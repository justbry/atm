/** Fixes from the 0.8.0 money review: two gift codes never share a credit row, and a dollar gift has an upper limit. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	createSessionGiftCode,
	dollarGiftOps,
	redeemSessionGiftCode,
} from "../src/billing/codes.js";
import { menuCatalogRows } from "../src/billing/grants.js";
import { MAX_LINE_TOTAL, validateMenu } from "../src/billing/menu.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { applyRowChanges, type BillingRow } from "../src/billing/rows.js";
import type { Menu } from "../src/billing/types.js";

const SCHOOL = "sch_vol";
const NOW = Date.parse("2026-03-01T00:00:00Z");
const base = JSON.parse(
	readFileSync(
		`${import.meta.dir}/../fixtures/billing/grants/menu.json`,
		"utf8",
	),
) as Menu;

describe("a session gift code's credit row", () => {
	test("two codes whose id and feature join to the same text get different rows and both redeem", () => {
		const menu: Menu = {
			...base,
			features: [
				...base.features,
				{ id: "c", name: "Cee", unit: { one: "cee", other: "cees" } },
				{ id: "b_c", name: "Bee Cee", unit: { one: "bc", other: "bcs" } },
			],
		};
		expect(validateMenu(menu).ok).toBe(true);
		const catalog = menuCatalogRows({ menu, school: SCHOOL });
		const make = (id: string, code: string, featureId: string) => {
			const made = createSessionGiftCode({
				id,
				code,
				featureId,
				credits: 5,
				createdAt: NOW,
				redeemBy: NOW + 100 * 86_400_000,
				menu,
				policy: DEFAULT_POLICY,
			});
			if (!made.ok) throw new Error(made.reason);
			return made.code;
		};
		let rows: BillingRow[] = [];
		let revision = 0;
		const redeem = (code: ReturnType<typeof make>) => {
			const result = redeemSessionGiftCode({
				code,
				entered: code.code,
				holder: { orgId: SCHOOL, customerId: "family:fam_one" },
				menu,
				menuVersion: 1,
				policy: DEFAULT_POLICY,
				policyVersion: 1,
				rows,
				revision,
				catalog,
				now: NOW,
			});
			if (result.ok && result.rowChanges)
				({ rows, revision } = applyRowChanges({
					rows,
					revision,
					changes: result.rowChanges,
				}));
			return result;
		};
		const first = redeem(make("a", "GIFTAAAA1", "b_c"));
		const second = redeem(make("a_b", "GIFTBBBB2", "c"));
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!(first.ok && second.ok)) return;
		expect(first.redeemed.rowId).not.toBe(second.redeemed.rowId);
		const giftRows = rows.filter((row) => row.id.startsWith("ce_gift_code_"));
		expect(giftRows).toHaveLength(2);
	});
});

describe("dollarGiftOps upper limit", () => {
	const input = {
		schoolId: SCHOOL,
		menu: base,
		policy: DEFAULT_POLICY,
		giftId: "gift_1",
		code: "GIFTCODE1",
		issuedAt: NOW,
	};

	test("the largest amount Stripe takes is accepted, one cent more is refused", () => {
		expect(dollarGiftOps({ ...input, amount: MAX_LINE_TOTAL }).ok).toBe(true);
		expect(
			dollarGiftOps({ ...input, amount: MAX_LINE_TOTAL + 1 }),
		).toMatchObject({ ok: false, reason: "above_maximum" });
		expect(
			dollarGiftOps({ ...input, amount: 1_000_000_000_000 }),
		).toMatchObject({ ok: false, reason: "above_maximum" });
	});
});
