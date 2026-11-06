import { afterEach, expect, test } from "bun:test";
import type { PromosQuery } from "../../src/data/ledger.ts";
import type { Reader } from "../../src/data/reader.ts";
import type { Writer } from "../../src/data/writer.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";
import {
	cleanUp,
	click,
	clock,
	count,
	element,
	fill,
	open,
	settle,
	text,
} from "./helpers.ts";

afterEach(cleanUp);

const row = (id: string): string => `[data-test=promo-row][data-promo=${id}]`;

test("the Promos tab asks the Reader for the school and the audience, and only once", async () => {
	const base = createFixtureReader({ clock });
	const asked: PromosQuery[] = [];
	const reader: Reader = {
		...base,
		promos: (query) => {
			asked.push(query);
			return base.promos(query);
		},
	};
	await open("#/vol/promos?as=governance", { reader });
	expect(asked).toEqual([{ school: "vol", audience: "governance" }]);
});

test("a Disable the Writer refuses is said, and the promo stays active with its button back", async () => {
	const writer: Writer = {
		...createFixtureWriter({ mode: "instant" }),
		disablePromo: () => Promise.reject(new Error("offline")),
	};
	await open("#/vol/promos", { writer });
	await click(`${row("c_04")} [data-test=promo-disable]`);
	expect(text("[data-test=toast]")).toBe("Could not send. Try again.");
	expect(text(`${row("c_04")} [data-test=promo-status]`)).toBe("active");
	expect(
		element(`${row("c_04")} [data-test=promo-disable]`).hasAttribute(
			"disabled",
		),
	).toBe(false);
});

test("an admin who is not the owner may disable a promo, and a short code is named whole", async () => {
	const writer = createFixtureWriter({ mode: "instant" });
	await open("#/b4u/promos", { writer });
	await click(`${row("c_11")} [data-test=promo-disable]`);
	expect(writer.calls).toEqual([
		{ method: "disablePromo", args: [{ school: "b4u", promoId: "c_11" }] },
	]);
	expect(text("[data-test=toast]")).toBe(
		"Promo UNI15 disabled. It stops working at checkout now.",
	);
});

test("a preview cannot disable: the button is off and says why", async () => {
	await open("#/vol/promos?as=finance");
	const button = element(`${row("c_04")} [data-test=promo-disable]`);
	expect(button.hasAttribute("disabled")).toBe(true);
	expect(button.getAttribute("title")).toBe("Exit preview to act");
});

test("a Create the Writer refuses keeps the dialog open with its button back, and says so", async () => {
	const writer: Writer = {
		...createFixtureWriter({ mode: "instant" }),
		createPromo: () => Promise.reject(new Error("offline")),
	};
	await open("#/vol/promos", { writer });
	await click("[data-test=promo-new]");
	await fill("[data-test=promo-note-input]", "Autumn offer");
	await click("[data-test=dialog-confirm]");
	expect(text("[data-test=toast]")).toBe("Could not send. Try again.");
	expect(count("[data-test=dialog]")).toBe(1);
	expect(count("[data-test=promo-created-code]")).toBe(0);
	expect(element("[data-test=dialog-confirm]").hasAttribute("disabled")).toBe(
		false,
	);
	expect(count("[data-test=promo-row]")).toBe(4);
});

test("Escape closes the create dialog and nothing is written", async () => {
	const writer = createFixtureWriter({ mode: "instant" });
	await open("#/vol/promos", { writer });
	await click("[data-test=promo-new]");
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
	await settle();
	expect(count("[data-test=dialog]")).toBe(0);
	expect(writer.calls).toEqual([]);
});

test("a dollar value is sent in minor units and a fraction of a dollar is kept", async () => {
	const writer = createFixtureWriter({ mode: "instant" });
	await open("#/vol/promos", { writer });
	await click("[data-test=promo-new]");
	await fill("[data-test=promo-type-input]", "dollar");
	await fill("[data-test=promo-value-input]", "12.5");
	await fill("[data-test=promo-note-input]", "Raffle");
	await click("[data-test=dialog-confirm]");
	expect(writer.calls[0]?.args[0]).toMatchObject({
		type: "dollar",
		value: 1250,
	});
	expect(text("[data-test=promo-created-summary]")).toBe(
		"Dollar gift · $12.50 · expires 2026-12-31",
	);
});

test("the created dialog offers a copy of the code, and tells the truth when the clipboard refuses", async () => {
	const copied: string[] = [];
	let allowed = true;
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: (value: string) => {
				if (!allowed) return Promise.reject(new Error("blocked"));
				copied.push(value);
				return Promise.resolve();
			},
		},
	});
	await open("#/vol/promos");
	await click("[data-test=promo-new]");
	await fill("[data-test=promo-note-input]", "Autumn offer");
	await click("[data-test=dialog-confirm]");
	const [copyCode, copyLink] = [
		...document.querySelectorAll<HTMLButtonElement>(".row2 .btn"),
	];
	expect(copyLink?.hasAttribute("disabled")).toBe(true);
	copyCode?.click();
	await settle();
	expect(copied).toEqual(["CODE1000"]);
	expect(text("[data-test=toast]")).toBe("Code copied.");
	allowed = false;
	copyCode?.click();
	await settle();
	expect(text("[data-test=toast]")).toBe(
		"Could not copy the code: the browser blocked the clipboard.",
	);
});

test("Redemptions opens the Ledger for the year to date and keeps the audience", async () => {
	await open("#/vol/promos?as=finance&theme=light");
	await click(`${row("c_01")} [data-test=promo-redemptions]`);
	expect(window.location.hash).toBe(
		"#/vol/ledger?as=finance&theme=light&month=2026-01-01..2026-11-05&promo=c_01",
	);
	expect(text("[data-test=ledger-filter]")).toBe("Promo SPR•••10 ×");
});

test("a code is shown whole only to those who may reveal it, and only after they ask", async () => {
	await open("#/vol/promos?as=governance");
	expect(text(`${row("c_01")} [data-test=promo-code]`)).toBe("SPR•••10");
	expect(
		element(`${row("c_01")} [data-test=promo-copy]`).hasAttribute("disabled"),
	).toBe(true);
	expect(document.body.textContent).not.toContain("SPRING10");
});

test("a promo the Reader hides the uses of is never drawn as 0", async () => {
	await open("#/vol/promos?as=member");
	for (const used of document.querySelectorAll("[data-test=promo-used]"))
		expect(used.textContent).toBe("Governance and up see this");
});
