/**
 * "Before University": the public, open-access demo school of the scenario fixtures. Its menu is in buzz-school's `Menu`
 * shape (tiers, grants, quantities, rollover, once and recurring add-ons, monthly and yearly prices) and nothing past it:
 * no `gift`, `codes` or bookable `billing`, which atm 0.8.0 adds and buzz-school's menu does not have. Every name and
 * price is invented; no school's data and no key is in it.
 */
import menuJson from "../../fixtures/billing/menu/before-university.json";
import type { Menu } from "../billing/types.js";

export const SCHOOL_ID = "sch_before_university";
export const SCHOOL_NAME = "Before University";
export const BEFORE_UNIVERSITY_MENU = menuJson as Menu;

/** What a class credit is spent on. */
export const SERVICES = ["lecture", "lab", "office-hours"] as const;
