/** The `catalog.published` builder: the event a menu publish writes, which `membersOf` reads back as the catalog. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import {
	catalogPublishedEvent,
	publishedPlans,
} from "../src/ledger/catalog.js";
import { membersOf } from "../src/ledger/summary.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { Menu } from "../src/types.js";
import { handBuiltLog, menu as handMenu } from "./ledger-read-log.js";

const menu = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../fixtures/billing/grants/menu.json"),
		"utf8",
	),
) as Menu;
const AT = Date.UTC(2026, 0, 1);

describe("catalogPublishedEvent", () => {
	const event = catalogPublishedEvent({
		school: "sch_vol",
		menu,
		version: 3,
		eventTime: AT,
	});

	test("is a catalog.published event with the plans, the menu and the version", () => {
		expect(event.event_type).toBe("catalog.published");
		expect(event.payload.version).toBe(3);
		expect(event.payload.menu).toEqual(menu);
		expect(event.payload.plans).toEqual(publishedPlans(menu, 3));
		for (const tier of menu.tiers)
			expect(event.payload.plans).toContain(`${tier.id}@v3`);
		expect(event.postings).toEqual([]);
		expect(event.key).toBe("sch_vol");
		expect(event.idem).toBe("settings:catalog:3");
		expect(event.tz).toBe(menu.timeZone);
		expect(event.event_time).toBe("2026-01-01T00:00:00Z");
	});

	test("passes the event schema checks", () => {
		expect(validateEvent(event)).toEqual({ ok: true, errors: [] });
	});

	test("a gift certificate is not a plan", () => {
		const withGift: Menu = {
			...menu,
			addons: [
				...menu.addons,
				{
					id: "gift-50",
					name: "Gift",
					price: { amount: 5000, every: "once" },
					grants: [],
					gift: "dollars",
				},
			],
		};
		expect(publishedPlans(withGift, 1)).not.toContain("gift-50@v1");
	});

	test("the same version is the same idem, so publishing twice is one event", () => {
		const again = catalogPublishedEvent({
			school: "sch_vol",
			menu,
			version: 3,
			eventTime: AT + 5000,
		});
		expect(again.idem).toBe(event.idem);
		expect(
			catalogPublishedEvent({
				school: "sch_vol",
				menu,
				version: 4,
				eventTime: AT,
			}).idem,
		).not.toBe(event.idem);
	});

	test("a log with only this event's menu gives membersOf its catalog", () => {
		const { events } = handBuiltLog();
		const published = catalogPublishedEvent({
			school: "sch_hand",
			menu: handMenu,
			version: 1,
			eventTime: Date.UTC(2026, 0, 1),
		});
		const asOf = new Date(Date.UTC(2026, 1, 20));
		const given = membersOf(events, asOf, {
			catalog: menuCatalogRows({ menu: handMenu, school: "sch_hand" }),
		});
		const derived = membersOf([...events, published], asOf);
		expect(derived).toEqual(given);
	});

	test("a menu with nothing to publish is refused", () => {
		expect(() =>
			catalogPublishedEvent({
				school: "s",
				menu: { ...menu, tiers: [], addons: [] },
				version: 1,
				eventTime: AT,
			}),
		).toThrow(/nothing|no tier/);
	});
});
