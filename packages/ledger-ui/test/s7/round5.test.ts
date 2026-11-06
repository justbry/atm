import { afterEach, expect, test } from "bun:test";
import { h, render } from "preact";
import { useDialogChain } from "../../src/app/settings-shared.tsx";
import {
	cleanup,
	click,
	count,
	element,
	fill,
	open,
	press,
	settle,
	text,
} from "./helpers.ts";

afterEach(cleanup);

const createSecretKey = async (
	mode: "instant" | "hold",
): Promise<Awaited<ReturnType<typeof open>>> => {
	const writer = await open("#/vol/plans", { mode });
	await click("[data-test=settings-button]");
	await click("[data-test=key-create]");
	await click("[data-test=key-create-option][data-kind=sk]");
	await fill("[data-test=dialog-field][data-field=label]", "Server");
	return writer;
};

test("a dialog whose write is on its way ignores Escape, the backdrop and Cancel, then shows the next dialog", async () => {
	const writer = await createSecretKey("hold");
	await click("[data-test=dialog-confirm]");
	expect(writer.calls.map(({ method }) => method)).toEqual(["createKey"]);
	expect(element<HTMLButtonElement>("[data-test=dialog-cancel]").disabled).toBe(
		true,
	);
	await press(element("[data-test=dialog]"), "Escape");
	expect(count("[data-test=dialog]")).toBe(1);
	await click(".bg");
	expect(count("[data-test=dialog]")).toBe(1);
	element("[data-test=dialog-cancel]").click();
	await settle();
	expect(count("[data-test=dialog]")).toBe(1);
	writer.release();
	await settle();
	expect(text("[data-test=dialog-title]")).toBe("Key created");
});

test("a dialog that follows another is shown only while the one before it is still on screen", () => {
	const shown: string[] = [];
	let chain: ReturnType<typeof useDialogChain> | undefined;
	const Probe = (): null => {
		chain = useDialogChain((dialog) => {
			shown.push(dialog === null ? "closed" : String(dialog));
		});
		return null;
	};
	const container = document.createElement("div");
	render(h(Probe, {}), container);
	if (!chain) throw new Error("the hook did not run");

	const afterFirst = chain.show("first");
	afterFirst("second");
	expect(shown).toEqual(["first", "second"]);

	const afterThird = chain.show("third");
	chain.close();
	const afterClosed = afterThird("fourth");
	afterClosed("fifth");
	expect(shown).toEqual(["first", "second", "third", "closed"]);

	afterFirst("sixth");
	expect(shown).toEqual(["first", "second", "third", "closed"]);
	render(null, container);
});

test("the Compare box of the period popover writes compare=1 to the route, and unticking removes it", async () => {
	await open("#/vol/reports");
	await click("[data-test=period-button]");
	const compare = (): HTMLInputElement =>
		element<HTMLInputElement>(".chk input[type=checkbox]");
	expect(compare().checked).toBe(false);
	await click(".chk input[type=checkbox]");
	expect(window.location.hash).toContain("compare=1");
	expect(compare().checked).toBe(true);
	await click(".chk input[type=checkbox]");
	expect(window.location.hash).not.toContain("compare");
	expect(compare().checked).toBe(false);
});

test("the Cash and Deferred buttons say which one is on", async () => {
	await open("#/vol/plans");
	await click("[data-test=settings-button]");
	const pressed = (basis: string): string | null =>
		element(`[data-test=basis-option][data-basis=${basis}]`).getAttribute(
			"aria-pressed",
		);
	const first = pressed("cash") === "true" ? "cash" : "deferred";
	const other = first === "cash" ? "deferred" : "cash";
	expect(pressed(first)).toBe("true");
	expect(pressed(other)).toBe("false");
	await click(`[data-test=basis-option][data-basis=${other}]`);
	expect(pressed(first)).toBe("false");
	expect(pressed(other)).toBe("true");
});

test("Create promo hands its opener to Promo created: focus returns to New promo only when the last dialog closes", async () => {
	const returned: string[] = [];
	const focus = HTMLElement.prototype.focus;
	HTMLElement.prototype.focus = function (options?: FocusOptions): void {
		if (this.getAttribute("data-test") === "promo-new") returned.push("new");
		focus.call(this, options);
	};
	try {
		await open("#/vol/promos");
		element("[data-test=promo-new]").focus();
		returned.length = 0;
		await click("[data-test=promo-new]");
		await fill("[data-test=promo-note-input]", "Autumn offer");
		await click("[data-test=dialog-confirm]");
		expect(count("[data-test=promo-created-code]")).toBe(1);
		expect(returned).toEqual([]);
		await click("[data-test=dialog-confirm]");
		expect(count("[data-test=dialog]")).toBe(0);
		expect(returned).toEqual(["new"]);
	} finally {
		HTMLElement.prototype.focus = focus;
	}
});
