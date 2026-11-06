/**
 * The ledger-commodity rule for a menu's feature ids. Pure and free of Ajv, so the replay path (`billing/grants.ts`)
 * can use it without pulling in the schema validator that `billing/menu.ts` imports.
 */
import { commodityOf, MONEY_COMMODITY } from "../ledger/postings.js";

/** A feature id that cannot be a ledger commodity, or two that would share one. `path` is the dotted path of the feature at fault. */
export type CommodityProblem = { path: string; message: string };

/**
 * A credit's hledger commodity is its feature id in capitals with every non-letter dropped (`commodityOf`), so `light-60` and
 * `light-90` are both `LIGHT`, and an id with no letter has no commodity at all. Two features on one commodity would add up
 * into one balance in the books, and an id with none throws when the first credit is journaled. A feature whose commodity is the
 * money commodity (`usd`, `u-s-d`, `usd-2`: every id whose letters spell USD) would add its credits up with the dollars. The menu is where it is refused.
 * `commodityOf` is not changed: renaming a commodity would rewrite the journals already built.
 */
export const commodityProblems = (
	features: readonly { id: string }[],
): CommodityProblem[] => {
	const problems: CommodityProblem[] = [];
	const owner = new Map<string, string>();
	features.forEach((feature, index) => {
		const path = `features.${index}.id`;
		let commodity: string;
		try {
			commodity = commodityOf(feature.id);
		} catch {
			problems.push({
				path,
				message: `feature id ${JSON.stringify(feature.id)} has no letter: a credit commodity is the feature id in capitals with letters only, so it has none`,
			});
			return;
		}
		// The books count dollars in USD with two places; a credit in USD would add up with them (and has none).
		if (commodity === MONEY_COMMODITY) {
			problems.push({
				path,
				message: `feature id ${JSON.stringify(feature.id)} becomes the credit commodity ${commodity}, which is the money commodity (dollars): give it an id whose letters do not spell ${MONEY_COMMODITY}`,
			});
			return;
		}
		const first = owner.get(commodity);
		if (first === undefined) {
			owner.set(commodity, feature.id);
			return;
		}
		// An id repeated exactly is the duplicate-id rule's, not a collision of two features.
		if (first === feature.id) return;
		problems.push({
			path,
			message: `feature ids ${JSON.stringify(first)} and ${JSON.stringify(feature.id)} both become the credit commodity ${commodity} (letters only, in capitals): give them ids whose letters differ`,
		});
	});
	return problems;
};
