import type { ViewAs } from "../data/disclosure.ts";
import {
	type Menu,
	type MenuAddon,
	type MenuAudience,
	type MenuFeature,
	type MenuGrant,
	type MenuInterval,
	type MenuTier,
	type MenuVersionBody,
	type PlanSummary,
	type PlanTierCount,
	planLimits,
} from "../data/plans.ts";
import { formatMoney } from "./money.ts";
import type { Viewing } from "./viewing.ts";

export type PlanKind = "tiers" | "addons";

/** What the Plans pane needs of the View as row it is drawn for (S7's `Viewing`). */
export type PlansView = {
	audience: ViewAs;
	/** Not the signed-in person's own row: writes are off. */
	preview: boolean;
	/** Owner, finance admin or admin: sees the draft, Get started and the strip. */
	admin: boolean;
	/** Owner or finance admin: sees every figure. */
	finance: boolean;
};

export const plansViewOf = ({
	option,
	preview,
}: Pick<Viewing, "option" | "preview">): PlansView => ({
	audience: option.value,
	preview,
	admin: option.admin,
	finance: option.value === "owner" || option.value === "finance",
});

/** One school's Plans tab for the life of the mount: the live menu, the draft all three views show, and the facts
 * around them. The Shell keeps it, so a draft survives leaving the tab. */
export type PlansSession = {
	/** The live version's number; 0 before the first publish. */
	version: number;
	/** The newest published menu; before the first publish, the school's empty menu. */
	live: Menu;
	/** Which items of the live version have a Stripe product and prices (`MenuVersionBody.stripe`). */
	stripe: MenuVersionBody["stripe"];
	draft: Menu;
	summary: PlanSummary;
	/** The Code text as typed, kept while it differs from the layout or does not parse; null: the draft's own layout. */
	yamlText: string | null;
	/** The draft differs from the live menu (the Plans tab's draft badge). */
	hasChanges: boolean;
};

/** A tier whose audience a publish changed: what its members read from then on, and the day it moved. */
export type AudienceMove = { audience: MenuAudience; on: string };

/** The tiers the draft gives another audience than the live menu does (mockup `#pgo`): a tier is `member` when it
 * names none. A tier new in the draft moves nobody. */
export function audienceMoves(
	live: Menu,
	draft: Menu,
	on: string,
): Record<string, AudienceMove> {
	const moves: Record<string, AudienceMove> = {};
	for (const tier of draft.tiers) {
		const before = live.tiers.find(({ id }) => id === tier.id);
		const audience = tier.audience ?? "member";
		if (before && (before.audience ?? "member") !== audience)
			moves[tier.id] = { audience, on };
	}
	return moves;
}

/** A menu written the same way whatever order its keys were built in, to tell whether two menus are the same. */
export const canonical = (menu: Menu): string =>
	JSON.stringify(menu, (_key, value: unknown) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value).sort(([first], [second]) =>
						first.localeCompare(second),
					),
				)
			: value,
	);

/** The session with a new draft (and, for a Code edit, the text that made it). */
export function withDraft(
	session: PlansSession,
	draft: Menu,
	yamlText: string | null = null,
): PlansSession {
	return {
		...session,
		draft,
		yamlText,
		hasChanges: diffMenus(session.live, draft).length > 0,
	};
}

/** A school with no menu version yet starts from its currency, time zone and the features plans can grant. */
export const emptyMenu = (
	currency: string,
	timeZone: string,
	features: MenuFeature[],
): Menu => ({
	currency: currency.toLowerCase(),
	timeZone,
	features,
	tiers: [],
	addons: [],
});

function replaceOrAppend<Item extends { id: string }>(
	items: Item[],
	item: Item,
	replaces: string | null,
): Item[] {
	if (replaces === null) return [...items, item];
	return items.map((existing) => (existing.id === replaces ? item : existing));
}
/** The menu with a membership replaced (`replaces` is its id) or added (null). */
export const withTier = (
	menu: Menu,
	tier: MenuTier,
	replaces: string | null,
): Menu => ({ ...menu, tiers: replaceOrAppend(menu.tiers, tier, replaces) });
/** The menu with a pack replaced (`replaces` is its id) or added (null). */
export const withAddon = (
	menu: Menu,
	addon: MenuAddon,
	replaces: string | null,
): Menu => ({ ...menu, addons: replaceOrAppend(menu.addons, addon, replaces) });

export const tierCount = (
	summary: PlanSummary,
	tierId: string,
): PlanTierCount =>
	summary.tiers.find((count) => count.tierId === tierId) ?? {
		tierId,
		active: 0,
		ending: 0,
		activeUnits: 0,
		monthlyMinor: null,
	};

/** The mockup's `slug`: a new plan's id. */
export const slug = (name: string): string =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);

const priceOf = (tier: MenuTier, interval: MenuInterval): number | undefined =>
	tier.prices.find((price) => price.interval === interval)?.amount;
export const monthlyAmount = (tier: MenuTier): number | undefined =>
	priceOf(tier, "month");
export const yearlyAmount = (tier: MenuTier): number | undefined =>
	priceOf(tier, "year");

/** The words for a feature's amounts ("session", "sessions"). */
export const unitWords = (menu: Menu, featureId: string): MenuFeature["unit"] =>
	menu.features.find(({ id }) => id === featureId)?.unit ?? {
		one: featureId,
		other: featureId,
	};

/** The unit word a tier is sold per ("per session"): that of the first thing it grants. */
const tierUnit = (menu: Menu, tier: MenuTier): string =>
	unitWords(menu, tier.grants[0]?.featureId ?? "").one;

/** Mockup `priceTxt`: "$32.50 per session / month · $350.00 / year", "Not for sale", "$40.00 one time". */
export function priceText(menu: Menu, item: MenuTier | MenuAddon): string {
	if ("prices" in item) {
		const month = monthlyAmount(item);
		if (!(item.public || month)) return "Not for sale";
		const year = yearlyAmount(item);
		const per = item.quantities ? ` per ${tierUnit(menu, item)}` : "";
		return `${formatMoney(month ?? 0, menu.currency)}${per} / month${
			year ? ` · ${formatMoney(year, menu.currency)} / year` : ""
		}`;
	}
	const { amount, every } = item.price;
	return `${formatMoney(amount, menu.currency)} ${
		every === "once" ? "one time" : `/ ${every}`
	}`;
}

/** Mockup `grantTxt`: "8 sessions per unit each month, rolls over 1 mo". A pack charged once grants "once" (the
 * stored `every` of its grants is month, whatever it is charged). */
export function grantText(
	menu: Menu,
	grant: MenuGrant,
	options: { perUnit: boolean; once: boolean },
	scale = 1,
): string {
	const amount = grant.amount * scale;
	const unit = unitWords(menu, grant.featureId);
	const rollover = grant.rollover?.months;
	return `${amount} ${amount === 1 ? unit.one : unit.other}${
		options.perUnit ? " per unit" : ""
	} ${options.once ? "once" : `each ${grant.every}`}${
		rollover ? `, rolls over ${rollover} mo` : ""
	}`;
}

export const audienceName: Record<MenuAudience, string> = {
	member: "Member",
	governance: "Governance",
	public: "Public",
};
export const tierAudience = (tier: MenuTier): MenuAudience =>
	tier.audience ?? "member";

/** One item the draft changes, with the lines the code view and the review dialog list. */
export type PlanChange = {
	id: string;
	name: string;
	kind: PlanKind;
	status: "new" | "changed" | "removed";
	lines: Array<{ title: string; detail: string }>;
};

const sameGrants = (first: MenuGrant[], second: MenuGrant[]): boolean =>
	first.length === second.length &&
	first.every((grant, index) => {
		const other = second[index];
		return (
			other !== undefined &&
			grant.featureId === other.featureId &&
			grant.amount === other.amount &&
			grant.every === other.every &&
			(grant.rollover?.months ?? 0) === (other.rollover?.months ?? 0)
		);
	});
const sizesText = (tier: MenuTier): string =>
	tier.quantities ? tier.quantities.join(", ") : "one size";

function changedTierLines(
	menu: Menu,
	live: MenuTier,
	draft: MenuTier,
): PlanChange["lines"] {
	const lines: PlanChange["lines"] = [];
	const { currency } = menu;
	if (draft.name !== live.name)
		lines.push({
			title: `Name "${live.name}" → "${draft.name}"`,
			detail: "Update the Stripe product name",
		});
	if (draft.blurb !== live.blurb)
		lines.push({ title: "Description changed", detail: "No Stripe change" });
	const liveMonth = monthlyAmount(live) ?? 0;
	const draftMonth = monthlyAmount(draft) ?? 0;
	if (draftMonth !== liveMonth)
		lines.push({
			title: `Monthly price ${formatMoney(liveMonth, currency)} → ${formatMoney(draftMonth, currency)}`,
			detail: `Create a ${formatMoney(draftMonth, currency)}/month price and archive the ${formatMoney(liveMonth, currency)} one`,
		});
	const liveYear = yearlyAmount(live) ?? 0;
	const draftYear = yearlyAmount(draft) ?? 0;
	if (draftYear !== liveYear)
		lines.push({
			title: `Yearly price ${liveYear ? formatMoney(liveYear, currency) : "none"} → ${draftYear ? formatMoney(draftYear, currency) : "none"}`,
			detail: draftYear
				? `Create a ${formatMoney(draftYear, currency)}/year price${liveYear ? " and archive the old one" : ""}`
				: "Archive the yearly price",
		});
	if (tierAudience(draft) !== tierAudience(live))
		lines.push({
			title: `Audience ${audienceName[tierAudience(live)]} → ${audienceName[tierAudience(draft)]}`,
			detail:
				"Access moves at once: every member on this tier gets the new audience at their next read, with a notice. No Stripe change",
		});
	if ((draft.quantities ?? []).join() !== (live.quantities ?? []).join())
		lines.push({
			title: `Sold in ${sizesText(draft)} (was ${sizesText(live)})`,
			detail: "No price change. The billing portal setup is updated",
		});
	return lines;
}

function changedItemLines(
	menu: Menu,
	live: MenuTier | MenuAddon,
	draft: MenuTier | MenuAddon,
): PlanChange["lines"] {
	const lines: PlanChange["lines"] = [];
	if ("prices" in live && "prices" in draft)
		lines.push(...changedTierLines(menu, live, draft));
	else if ("price" in live && "price" in draft) {
		if (draft.name !== live.name)
			lines.push({
				title: `Name "${live.name}" → "${draft.name}"`,
				detail: "Update the Stripe product name",
			});
		if (
			draft.price.amount !== live.price.amount ||
			draft.price.every !== live.price.every
		)
			lines.push({
				title: `Price ${priceText(menu, live)} → ${priceText(menu, draft)}`,
				detail: "Create a new price and archive the old one",
			});
	}
	if (!sameGrants(draft.grants, live.grants))
		lines.push({
			title: "What members get changed",
			detail: "No Stripe change. New amounts apply from the next invoice",
		});
	if ("public" in live && "public" in draft && draft.public !== live.public)
		lines.push({
			title: draft.public ? "Now on sale" : "Now hidden",
			detail: draft.public
				? "No Stripe change"
				: "No Stripe change. Not sold, current members keep it",
		});
	return lines;
}

/** Mockup `diff`: the draft against the live menu, item by item, memberships then packs, then what the draft removed.
 * Against the empty menu of an unpublished school every item is new. */
export function diffMenus(live: Menu, draft: Menu): PlanChange[] {
	const changes: PlanChange[] = [];
	for (const kind of ["tiers", "addons"] as const) {
		for (const item of draft[kind]) {
			const before = live[kind].find(({ id }) => id === item.id);
			if (!before) {
				changes.push({
					id: item.id,
					name: item.name,
					kind,
					status: "new",
					lines: [
						{
							title: "New plan",
							detail: "Create a Stripe product and its prices",
						},
						...("audience" in item &&
						item.audience &&
						item.audience !== "member"
							? [
									{
										title: `Audience: ${audienceName[item.audience]}`,
										detail:
											"Starts a new version; existing members keep theirs. No Stripe change",
									},
								]
							: []),
					],
				});
				continue;
			}
			const lines = changedItemLines(draft, before, item);
			if (lines.length > 0)
				changes.push({
					id: item.id,
					name: item.name,
					kind,
					status: "changed",
					lines,
				});
		}
	}
	for (const kind of ["tiers", "addons"] as const)
		for (const before of live[kind])
			if (!draft[kind].some(({ id }) => id === before.id))
				changes.push({
					id: before.id,
					name: before.name,
					kind,
					status: "removed",
					lines: [
						{
							title: "Removed",
							detail:
								"Archive the Stripe product and its prices. Current members keep what they bought",
						},
					],
				});
	return changes;
}

const sizeLimit = 6;
const sizeMaximum = 50;
const sizesAreValid = (sizes: number[]): boolean =>
	sizes.length <= sizeLimit &&
	sizes.every(
		(size) => Number.isInteger(size) && size >= 1 && size <= sizeMaximum,
	) &&
	new Set(sizes).size === sizes.length;

/** Mockup `problems`: what keeps a draft from being saved or published. */
export function problems(menu: Menu): string[] {
	const found: string[] = [];
	if (menu.tiers.length > planLimits.tiers)
		found.push(`At most ${planLimits.tiers} memberships.`);
	if (menu.addons.length > planLimits.addons)
		found.push(`At most ${planLimits.addons} packs and add-ons.`);
	const ids = new Set<string>();
	for (const item of [...menu.tiers, ...menu.addons]) {
		const label = item.name || "A plan";
		if (!item.name.trim()) found.push("A plan needs a name.");
		if (ids.has(item.id)) found.push(`${label}: another plan has the same id.`);
		ids.add(item.id);
		if ("prices" in item) {
			const month = monthlyAmount(item) ?? 0;
			if ((item.public || month) && !(month > 0))
				found.push(`${label}: monthly price must be above 0.`);
			const year = yearlyAmount(item);
			if (year !== undefined && !(year > 0))
				found.push(`${label}: yearly price must be above 0.`);
			if (item.quantities && !sizesAreValid(item.quantities))
				found.push(
					`${label}: sizes must be 1 to ${sizeLimit} different whole numbers from 1 to ${sizeMaximum}.`,
				);
		} else if (!(item.price.amount > 0))
			found.push(`${label}: price must be above 0.`);
		for (const grant of item.grants)
			if (!Number.isInteger(grant.amount) || grant.amount < 1)
				found.push(`${label}: each grant needs a whole number above 0.`);
	}
	return [...new Set(found)];
}

/** "1 change", "2 changes". */
export const changeCount = (count: number): string =>
	`${count} change${count === 1 ? "" : "s"}`;
