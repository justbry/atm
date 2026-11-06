import { afterEach, expect, test } from "bun:test";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { cleanUp, clock, count, element, open, text } from "./helpers.ts";

afterEach(cleanUp);

test("Harbor Arts has its ARTS20 code: below Governance its Used column says who sees it, and Redemptions is off", async () => {
	await open("#/har/promos");
	const row = "[data-test=promo-row][data-promo=c_h1]";
	expect(count(row)).toBe(1);
	expect(text(`${row} [data-test=promo-used]`)).toBe(
		"Governance and up see this",
	);
	const redemptions = element<HTMLButtonElement>(
		`${row} [data-test=promo-redemptions]`,
	);
	expect(redemptions.disabled).toBe(true);
	expect(redemptions.title).toBe("Finance admins only: lists who redeemed");
});

test("the fixture Reader answers every school-scoped read for Harbor Arts", async () => {
	const reader = createFixtureReader({ clock });
	const { rules, unit } = await reader.schoolRules("har");
	expect(rules.cancelCutoffHours).toBe(24);
	expect(unit.other).toBe("credits");
	const page = await reader.ledger({
		school: "har",
		from: "2026-01-01",
		to: "2026-11-05",
		type: null,
		drill: null,
		promo: null,
	});
	expect(page.count).toBe(3);
	const donors = await reader.donors({
		school: "har",
		audience: "finance",
		year: 2026,
	});
	expect(donors.kind).toBe("identified");
	const promos = await reader.promos({ school: "har", audience: "finance" });
	expect(promos.promos.map(({ code, used }) => [code, used])).toEqual([
		["ARTS20", 3],
	]);
});
