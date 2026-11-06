import { afterEach, expect, test } from "bun:test";
import { audienceMoves } from "../../src/app/plans-menu.ts";
import type { Menu } from "../../src/data/plans.ts";
import {
	cleanUp,
	click,
	count,
	element,
	fill,
	open,
	settle,
	text,
} from "../s5/helpers.ts";

afterEach(cleanUp);

const menu = (
	audiences: Array<[string, "member" | "governance" | undefined]>,
): Menu => ({
	currency: "usd",
	timeZone: "America/Denver",
	features: [],
	tiers: audiences.map(([id, audience]) => ({
		id,
		name: id,
		blurb: "",
		public: true,
		prices: [],
		grants: [],
		...(audience ? { audience } : {}),
	})),
	addons: [],
});

test("a tier moves when the draft names another audience than the live menu, member being the default", () => {
	const live = menu([
		["sparkle", undefined],
		["board", "governance"],
		["glow", "member"],
	]);
	const draft = menu([
		["sparkle", "governance"],
		["board", "governance"],
		["glow", undefined],
		["fresh", "governance"],
	]);
	expect(audienceMoves(live, draft, "2026-11-05")).toEqual({
		sparkle: { audience: "governance", on: "2026-11-05" },
	});
});

test("after a publish, the tier's members read the new audience in the portal and see the notice", async () => {
	await open("#/vol/members?portal=m_204&theme=light");
	const card = "[data-test=books-card]";
	expect(element(card).dataset.audience).toBe("member");
	expect(count("[data-audchg]")).toBe(0);

	window.location.hash = "#/vol/plans?theme=light";
	await settle();
	await click("[data-test=plan-row][data-plan=sparkle]");
	const audience = element<HTMLSelectElement>("[data-field=audience]");
	audience.value = "governance";
	audience.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
	await click("[data-test=plan-drawer-save]");
	await click("[data-test=plan-review]");
	await fill("[data-test=plan-publish-pin]", "1234");
	await click("[data-test=plan-publish-go]");

	window.location.hash = "#/vol/members?portal=m_204&theme=light";
	await settle();
	expect(element(card).dataset.audience).toBe("governance");
	expect(text("[data-audchg]")).toBe(
		"What members can see changed on 5 Nov 2026.",
	);
	expect(text("[data-test=books-pill]")).toBe("Governance");

	window.location.hash = "#/vol/members?portal=m_051&theme=light";
	await settle();
	expect(count("[data-test=books-card]")).toBe(1);
	expect(count("[data-audchg]")).toBe(0);
});
