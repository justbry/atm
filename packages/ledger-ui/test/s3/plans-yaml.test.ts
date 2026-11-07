import { expect, test } from "bun:test";
import { emitMenu, parseMenu } from "../../src/app/plans-yaml.ts";
import type { Menu } from "../../src/data/plans.ts";
import { plansBySchool } from "../../src/fixtures/plans.ts";

const noStripe = { products: [], prices: [], portal: false };
const vibes = plansBySchool.vol?.bodies[3];
if (!vibes) throw new Error("the Vibes of Light fixture has no v3");
const menu = vibes.menu;

const emit = (draft: Menu = menu, stripe = vibes.stripe): string =>
	emitMenu({ schoolName: "Vibes of Light", version: 3, menu: draft, stripe });
/** The emitted text with one line replaced, parsed as Vibes of Light's draft. */
const parseWith = (change: (text: string) => string) =>
	parseMenu(change(emit()), { version: 3, previous: menu });

test("parse(emit(menu)) is the menu, for every menu a fixture school has", () => {
	for (const [schoolId, plans] of Object.entries(plansBySchool))
		for (const body of Object.values(plans.bodies)) {
			const text = emitMenu({
				schoolName: schoolId,
				version: body.version,
				menu: body.menu,
				stripe: body.stripe,
			});
			const parsed = parseMenu(text, {
				version: body.version,
				previous: body.menu,
			});
			expect(parsed.ok ? parsed.menu : parsed).toEqual(body.menu);
		}
});

test("the emitted layout is the contract's: header, read-only keys, ids, grants", () => {
	const lines = emit().split("\n");
	expect(lines.slice(0, 8)).toEqual([
		"# Vibes of Light: plans. Edit here, then Review and publish.",
		"# Each plan is keyed by its id: rename a plan by changing name, not id.",
		"# Lines that start with # stripe: are read-only and come back when you Format.",
		"version: 3",
		"currency: USD",
		"timeZone: America/Denver",
		"",
		"memberships:",
	]);
	expect(lines).toContain("      month: 32.5");
	expect(lines).toContain("    quantities: [1, 2, 4]");
	expect(lines).toContain("    every: once");
	expect(emit().endsWith("\n")).toBe(true);
	expect(
		emit({ ...menu, tiers: [], addons: [] }).includes(
			"memberships: []\n\npacks: []\n",
		),
	).toBe(true);
});

test("a # stripe: line says what the live version has on Stripe, never an id", () => {
	const text = emit();
	expect(text).toContain(
		"  # stripe: product · month price · year price\n  - id: sparkle",
	);
	expect(text).toContain("  # stripe: product · price\n  - id: pack8");
	expect(text).not.toMatch(/prod_|price_/);
	const unpublished = emit(menu, noStripe);
	expect(unpublished).toContain(
		"  # stripe: created when you publish\n  - id: sparkle",
	);
	const monthOnly = emit(menu, {
		...noStripe,
		products: ["t:sparkle"],
		prices: ["t:sparkle:month"],
	});
	expect(monthOnly).toContain(
		"  # stripe: product · month price\n  - id: sparkle",
	);
});

test("a scalar is plain unless it would read as something else", () => {
	const named = (name: string, blurb: string): string =>
		emit({
			...menu,
			tiers: [{ ...menu.tiers[0], name, blurb } as Menu["tiers"][number]],
		});
	expect(named("Sparkle", "A little time, every month")).toContain(
		"    name: Sparkle\n    blurb: A little time, every month\n",
	);
	expect(named("yes", "")).toContain('    name: "yes"\n    blurb: ""\n');
	expect(named("12", "Ends: soon")).toContain(
		'    name: "12"\n    blurb: "Ends: soon"\n',
	);
	expect(named("Tab ", "x")).toContain('    name: "Tab "\n');
});

test("a tier with no price leaves prices: out, and a Code text without it parses to none", () => {
	const board = plansBySchool.b4u?.bodies[3];
	if (!board) throw new Error("no B4 Uni v3");
	const text = emitMenu({
		schoolName: "B4 Uni",
		version: 3,
		menu: board.menu,
		stripe: board.stripe,
	});
	const boardBlock = text.slice(text.indexOf("  - id: board"));
	expect(boardBlock.slice(0, boardBlock.indexOf("    grants:"))).not.toContain(
		"prices:",
	);
	const parsed = parseMenu(text, { version: 3, previous: board.menu });
	expect(parsed.ok && parsed.menu.tiers[2]?.prices).toEqual([]);
});

test("each construct the subset refuses is refused with its line and the mockup's words", () => {
	const refused: Array<[string, string, string]> = [
		[
			"anchor",
			"name: &a Sparkle",
			"Anchors (&) aren't accepted. Write the value out in full.",
		],
		[
			"alias",
			"name: *a",
			"Aliases (*) aren't accepted. Write the value out in full.",
		],
		[
			"tag",
			"name: !!str Sparkle",
			"Tags (!) aren't accepted. Write the plain value.",
		],
		[
			"block text",
			"blurb: |",
			"Block text (| or >) isn't accepted. Put the text on one line.",
		],
		[
			"inline map",
			"name: {a: 1}",
			"Inline { } maps aren't accepted. Put each key on its own line.",
		],
		[
			"merge key",
			"name: <<x",
			"Merge keys (<<) aren't accepted. Write the values out in full.",
		],
		[
			"unquoted yes",
			"public: yes",
			'Write true or false, or put "yes" in quotes if it is text.',
		],
		[
			"open quote",
			'name: "Spark',
			"This quote is never closed. Text must stay on one line.",
		],
		[
			"unknown key",
			"color: red",
			'Unknown key "color" in a membership. Use: id, name, blurb, public, audience, prices, quantities, grants.',
		],
	];
	for (const [label, replacement, message] of refused) {
		const text = emit().replace("    name: Sparkle", `    ${replacement}`);
		const parsed = parseMenu(text, { version: 3, previous: menu });
		expect({ label, parsed }).toEqual({
			label,
			parsed: { ok: false, line: 11, message },
		});
	}
});

test("tabs, a second document and an empty text are refused", () => {
	expect(
		parseWith((text) => text.replace("version: 3", "\tversion: 3")),
	).toEqual({
		ok: false,
		line: 4,
		message: "Tabs aren't allowed. Indent with spaces.",
	});
	expect(parseWith((text) => `${text}---\nversion: 3\n`)).toMatchObject({
		ok: false,
		message: "Only one document is accepted.",
	});
	expect(
		parseMenu("# only a comment\n", { version: 3, previous: menu }),
	).toEqual({
		ok: false,
		line: 1,
		message: "The document is empty. Use Reset to published to start again.",
	});
});

test("the read-only keys must match: version, currency and time zone", () => {
	expect(
		parseWith((text) => text.replace("version: 3", "version: 4")),
	).toMatchObject({
		ok: false,
		line: 4,
		message:
			"version is the published version (3). It changes when you publish, so leave it as 3.",
	});
	expect(parseWith((text) => text.replace("USD", "CAD"))).toMatchObject({
		ok: false,
		message: "currency is set in Settings (USD), not in plans.",
	});
	expect(
		parseWith((text) => text.replace("America/Denver", "Europe/Paris")),
	).toMatchObject({
		ok: false,
		message: "timeZone is set in Settings (America/Denver), not in plans.",
	});
});

test("amounts come back as cents and must be whole cents", () => {
	const parsed = parseWith((text) =>
		text.replace("month: 32.5", "month: 19.99"),
	);
	expect(parsed.ok && parsed.menu.tiers[0]?.prices[0]).toEqual({
		interval: "month",
		amount: 1999,
	});
	expect(
		parseWith((text) => text.replace("month: 32.5", "month: 19.999")),
	).toMatchObject({
		ok: false,
		message: "month can have two decimals at most: amounts are whole cents.",
	});
});

test("a grant names a feature of the menu, and a stored rollover cap survives an edit", () => {
	expect(
		parseWith((text) => text.replace("feature: sessions", "feature: classes")),
	).toMatchObject({ ok: false, message: "feature must be one of: sessions." });
	const capped: Menu = {
		...menu,
		tiers: menu.tiers.map((tier) =>
			tier.id === "sparkle"
				? {
						...tier,
						grants: [
							{
								featureId: "sessions",
								amount: 8,
								every: "month",
								rollover: { months: 1, max: 20 },
							},
						],
					}
				: tier,
		),
	};
	const parsed = parseMenu(emit(capped), { version: 3, previous: capped });
	expect(parsed.ok && parsed.menu.tiers[0]?.grants[0]?.rollover).toEqual({
		months: 1,
		max: 20,
	});
});

test("a parsed text says where each plan and list sits, for the gutter", () => {
	const parsed = parseWith((text) => text);
	if (!parsed.ok) throw new Error(parsed.message);
	expect(parsed.items.slice(0, 2)).toEqual([
		{ name: "Sparkle", line: 10 },
		{ name: "Shine", line: 24 },
	]);
	expect(parsed.membershipsLine).toBe(8);
});
