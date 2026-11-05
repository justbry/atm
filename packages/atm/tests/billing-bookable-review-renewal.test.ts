/**
 * A hold made in one cycle and released after the renewal must not carry last cycle's credits into the new one: they go
 * back only as the row's rollover rule allows (a rollover of last cycle's leftovers, within its cap), else they lapse.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { holdBooking, releaseBooking } from "../src/billing/bookable.js";
import type { BillingInvoice, Menu } from "../src/billing/types.js";
import { validateEvent } from "../src/ledger/validate.js";
import { reviewWorld } from "./billing-bookable-review-world.js";

const directory = `${import.meta.dir}/../fixtures/billing/grants`;
const load = <T>(name: string): T =>
	JSON.parse(readFileSync(`${directory}/${name}.json`, "utf8")) as T;
const DAY = 86_400_000;

const menuWithoutRollover = (): Menu => {
	const menu = load<Menu>("menu");
	for (const tier of menu.tiers)
		for (const grant of tier.grants)
			delete (grant as { rollover?: unknown }).rollover;
	return menu;
};

const menus = [
	["a menu without rollover", menuWithoutRollover],
	[
		"the fixture menu (rollover of at most 2, for 1 month)",
		() => load<Menu>("menu"),
	],
] as const;

describe.each(menus)("%s", (_name, makeMenu) => {
	const create = load<BillingInvoice>("inv-create-s2");
	const february = load<BillingInvoice>("inv-cycle-s2-feb");
	const march = load<BillingInvoice>("inv-cycle-s2-mar");

	/** Nobody books: what the member can spend in February and March. */
	const unbooked = () => {
		const world = reviewWorld(makeMenu());
		world.invoice(create);
		world.invoice(february);
		const inFebruary = world.available(february.paidAt + DAY);
		world.invoice(march);
		return { inFebruary, inMarch: world.available(march.paidAt + DAY) };
	};

	/** Both January visits held for a session on February 20, released in time on February 16 (after the renewal). */
	const heldOverRenewal = () => {
		const world = reviewWorld(makeMenu());
		world.invoice(create);
		const held = world.apply(
			holdBooking({
				...world.ctx(create.paidAt + DAY),
				bookingId: "b1",
				featureId: "visit",
				credits: 2,
				startsAt: create.paidAt + 36 * DAY,
				expiresAt: create.paidAt + 37 * DAY,
			}),
		);
		expect(held.ok).toBe(true);
		world.invoice(february);
		const released = world.apply(
			releaseBooking({ ...world.ctx(february.paidAt + DAY), bookingId: "b1" }),
		);
		return { world, released };
	};

	test("a release after the renewal leaves February as if nobody had booked", () => {
		const { world, released } = heldOverRenewal();
		expect(released.ok).toBe(true);
		expect(world.available(february.paidAt + DAY)).toBe(unbooked().inFebruary);
	});

	test("the March renewal runs and leaves March as if nobody had booked", () => {
		const { world } = heldOverRenewal();
		world.invoice(march);
		expect(world.available(march.paidAt + DAY)).toBe(unbooked().inMarch);
	});

	test("the release's events are valid and give back no more than the rule allows", () => {
		const { released } = heldOverRenewal();
		if (!released.ok) throw new Error(released.reason);
		for (const event of released.events)
			expect(validateEvent(event)).toEqual({ ok: true, errors: [] });
		const availableMoved = released.events
			.flatMap((event) => event.postings)
			.filter((posting) => posting.account.startsWith("credits:avail:"))
			.reduce((sum, posting) => sum + Number(posting.amount), 0);
		const heldMoved = released.events
			.flatMap((event) => event.postings)
			.filter((posting) => posting.account.startsWith("credits:held:"))
			.reduce((sum, posting) => sum + Number(posting.amount), 0);
		expect(heldMoved).toBe(-2);
		const unbookedFebruary = unbooked().inFebruary;
		// What the member can spend after the release, less what February refilled (2), is what came back.
		expect(availableMoved).toBe(unbookedFebruary - 2);
	});
});

test("without rollover, the units that lapsed at the renewal are booked as credit.expired", () => {
	const world = reviewWorld(menuWithoutRollover());
	const create = load<BillingInvoice>("inv-create-s2");
	const february = load<BillingInvoice>("inv-cycle-s2-feb");
	world.invoice(create);
	world.apply(
		holdBooking({
			...world.ctx(create.paidAt + DAY),
			bookingId: "b1",
			featureId: "visit",
			credits: 2,
			startsAt: create.paidAt + 36 * DAY,
			expiresAt: create.paidAt + 37 * DAY,
		}),
	);
	world.invoice(february);
	const released = world.apply(
		releaseBooking({ ...world.ctx(february.paidAt + DAY), bookingId: "b1" }),
	);
	if (!released.ok) throw new Error(released.reason);
	const expired = released.events.filter(
		(event) => event.event_type === "credit.expired",
	);
	expect(expired).toHaveLength(1);
	expect(expired[0]?.postings.map((p) => [p.account, p.amount])).toEqual([
		["credits:avail:family:fam_8k2:visit", "-2"],
		["credits:expired", "2"],
	]);
});

test("with rollover, the units come back as a rollover that lapses when last cycle's leftovers do", () => {
	const create = load<BillingInvoice>("inv-create-s2");
	const february = load<BillingInvoice>("inv-cycle-s2-feb");
	const plain = reviewWorld(load<Menu>("menu"));
	plain.invoice(create);
	plain.invoice(february);
	const world = reviewWorld(load<Menu>("menu"));
	world.invoice(create);
	world.apply(
		holdBooking({
			...world.ctx(create.paidAt + DAY),
			bookingId: "b1",
			featureId: "visit",
			credits: 2,
			startsAt: create.paidAt + 36 * DAY,
			expiresAt: create.paidAt + 37 * DAY,
		}),
	);
	world.invoice(february);
	world.apply(
		releaseBooking({ ...world.ctx(february.paidAt + DAY), bookingId: "b1" }),
	);
	const expiries = (
		rollovers: { balance: number; expiresAt: number | null }[],
	) =>
		rollovers
			.filter((rollover) => rollover.balance > 0)
			.map((rollover) => [rollover.balance, rollover.expiresAt]);
	expect(expiries(world.rollovers())).toEqual(expiries(plain.rollovers()));
});
