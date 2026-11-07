/**
 * The `catalog.published` event for a menu: what a family service writes when a school publishes its menu, so the log
 * records the menu the grant rules read (`membersOf` takes the latest one as its catalog). Pure and Worker-safe; the one
 * generic `ledgerEvent` builds it, with the payload (`plans`, `menu`, `version`) and the idempotency key that the
 * schema and the readers expect.
 */
import type { AtmEvent, CatalogPublishedInput, Menu } from "../types.js";
import { ledgerEvent } from "./postings.js";

export type { CatalogPublishedInput };

/**
 * The plans a menu publishes at `version`, as `<id>@v<version>`: its tiers and its recurring or one-time add-ons. A gift
 * certificate is not a plan (its credits carry the plan `gift`).
 */
export const publishedPlans = (
	menu: Menu,
	version: number | string,
): string[] => [
	...menu.tiers.map((tier) => `${tier.id}@v${version}`),
	...menu.addons
		.filter((addon) => addon.gift === undefined)
		.map((addon) => `${addon.id}@v${version}`),
];

/**
 * The event: type `catalog.published`, key the school id (it belongs to no holder), idem `settings:catalog:<version>`
 * (publishing the same version twice is one event), no postings. Throws on a menu with no tier or add-on to publish.
 */
export const catalogPublishedEvent = ({
	school,
	menu,
	version,
	eventTime,
	tz,
	source,
	ingestTime,
}: CatalogPublishedInput): AtmEvent => {
	const plans = publishedPlans(menu, version);
	if (plans.length === 0)
		throw new Error("the menu has no tier or add-on to publish");
	return ledgerEvent({
		type: "catalog.published",
		school,
		tz: tz ?? menu.timeZone,
		eventTime,
		...(ingestTime === undefined ? {} : { ingestTime }),
		...(source === undefined ? {} : { source }),
		key: school,
		idem: `settings:catalog:${version}`,
		payload: { plans, menu, version },
	});
};
