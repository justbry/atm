/**
 * The recorded sandbox deliveries (`fixtures/billing/stripe/recorded/delivered`, whole events as Stripe sent them), as the
 * matrix's cases deliver them: the menu they were made against, the price ids they carry, and one event by file number.
 */
import { readdirSync, readFileSync } from "node:fs";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { menuToStripe } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import type { RawEvent } from "./stripe-events.js";

const DELIVERED = `${import.meta.dir}/../fixtures/billing/stripe/recorded/delivered`;
const SECOND = 1000;
export const RECORDED_SCHOOL = "spike-school";

const read = (path: string): RawEvent =>
	JSON.parse(readFileSync(`${DELIVERED}/${path}`, "utf8"));

/** The menu the recordings were made against. */
export const recordedMenu = read("menu.json") as Menu;

/** Stripe's price id for each of the recorded menu's lookup keys: `menuToStripe` names the key, `prices.json` has the id. */
export const recordedPriceIds = (): Record<string, string> => {
	const byKey = read("prices.json") as Record<string, string>;
	const ids: Record<string, string> = {};
	for (const op of menuToStripe({
		schoolId: RECORDED_SCHOOL,
		menu: recordedMenu,
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

/** One recorded event by scenario and file number ("04" is `04-*.json`), with the instant Stripe made it. */
export const recorded = (
	scenario: string,
	number: string,
): { event: RawEvent; at: number } => {
	const name = readdirSync(`${DELIVERED}/${scenario}`).find((file) =>
		file.startsWith(`${number}-`),
	);
	if (!name) throw new Error(`no recorded file ${number} in ${scenario}`);
	const event = read(`${scenario}/${name}`);
	return { event, at: event.created * SECOND };
};
