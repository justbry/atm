/**
 * The organizations a scenario can simulate. Before University (`school`) is the default and the only one the books were
 * first built for; the others reuse its billing shape (tiers, grants, quantities, rollover, once and recurring add-ons,
 * monthly and yearly prices) with a menu of their own. Every name, price and id is invented; no organization's data and
 * no key is in them. The atm identifiers stay school-named (`school`, `b4u_school`, `family:` holders): an org's id goes
 * where a school's does.
 */

import churchMenu from "../../fixtures/billing/menu/cedar-hill-church.json";
import studioMenu from "../../fixtures/billing/menu/ironbark-studio.json";
import saasMenu from "../../fixtures/billing/menu/lumen-notes.json";
import creatorMenu from "../../fixtures/billing/menu/night-kitchen-courses.json";
import type { Menu } from "../billing/types.js";
import {
	BEFORE_UNIVERSITY_MENU,
	SCHOOL_ID,
	SCHOOL_NAME,
	SERVICES,
} from "./school.js";

export const ORG_KINDS = [
	"school",
	"studio",
	"church",
	"saas",
	"creator",
] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

export const DEFAULT_ORG: OrgKind = "school";

export type Org = {
	kind: OrgKind;
	/** The display name, invented. */
	name: string;
	/** What kind of organization it stands for, in a few words. */
	label: string;
	/** The id the books carry as `school` and the invoices as `b4u_school`. */
	id: string;
	menu: Menu;
	/** The credit features a member spends, by the order the menu lists them (the cron lapses each). */
	features: string[];
	/** The feature a member books with `usageRate`. */
	spendFeature: string;
	/** What a booking of `spendFeature` is spent on. */
	services: readonly string[];
	/** The tier weights of a scenario of this org that names none. */
	tierMix: Record<string, number>;
};

const orgOf = (
	org: Omit<Org, "features" | "menu"> & { menu: unknown },
): Org => {
	const menu = org.menu as Menu;
	return { ...org, menu, features: menu.features.map((f) => f.id) };
};

export const ORGS: Record<OrgKind, Org> = {
	school: orgOf({
		kind: "school",
		name: SCHOOL_NAME,
		label: "a school",
		id: SCHOOL_ID,
		menu: BEFORE_UNIVERSITY_MENU,
		spendFeature: "class",
		services: SERVICES,
		tierMix: { audit: 3, scholar: 4, seminar: 2, fellow: 1 },
	}),
	studio: orgOf({
		kind: "studio",
		name: "Ironbark Studio",
		label: "a fitness and membership studio",
		id: "org_ironbark_studio",
		menu: studioMenu,
		spendFeature: "class",
		services: ["strength", "spin", "yoga", "mobility"],
		tierMix: { "off-peak": 3, core: 4, "class-pack": 2, "all-access": 1 },
	}),
	church: orgOf({
		kind: "church",
		name: "Cedar Hill Community Church",
		label: "a church or nonprofit",
		id: "org_cedar_hill_church",
		menu: churchMenu,
		spendFeature: "retreat-seat",
		services: ["family-retreat"],
		tierMix: { "give-25": 4, "give-50": 4, "give-100": 2, "give-250": 1 },
	}),
	saas: orgOf({
		kind: "saas",
		name: "Lumen Notes",
		label: "a SaaS or digital product",
		id: "org_lumen_notes",
		menu: saasMenu,
		spendFeature: "api-calls",
		services: ["sync", "export", "search"],
		tierMix: { solo: 5, team: 3, business: 1 },
	}),
	creator: orgOf({
		kind: "creator",
		name: "Night Kitchen Courses",
		label: "a creator or online-course business",
		id: "org_night_kitchen_courses",
		menu: creatorMenu,
		spendFeature: "live-session",
		services: ["cook-along"],
		tierMix: { community: 4, "kitchen-table": 1 },
	}),
};

export const isOrgKind = (value: unknown): value is OrgKind =>
	typeof value === "string" && (ORG_KINDS as readonly string[]).includes(value);

export const tierIdsOf = (kind: OrgKind): string[] =>
	ORGS[kind].menu.tiers.map((t) => t.id);
