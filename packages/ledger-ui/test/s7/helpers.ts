import { mountApp } from "../../src/app/mount.tsx";
import type { Reader } from "../../src/data/reader.ts";
import type { Writer } from "../../src/data/writer.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";

export const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
let unmount: (() => void) | null = null;

const macrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
export const element = <Type extends HTMLElement = HTMLElement>(
	selector: string,
): Type => {
	const found = document.querySelector<Type>(selector);
	if (!found) throw new Error(`no element matches ${selector}`);
	return found;
};
export const text = (selector: string): string =>
	(element(selector).textContent ?? "").replace(/\s+/g, " ").trim();
export const count = (selector: string): number =>
	document.querySelectorAll(selector).length;
export const settle = async (): Promise<void> => {
	for (
		let attempt = 0;
		attempt < 400 && element("#app").dataset.route !== window.location.hash;
		attempt += 1
	)
		await macrotask();
	await macrotask();
	await macrotask();
};

/** Mounts the app at `hash` with the fixture Reader and an instant (or held) fixture Writer. */
export const open = async (
	hash: string,
	options: { reader?: Reader; mode?: "instant" | "hold" } = {},
): Promise<ReturnType<typeof createFixtureWriter>> => {
	window.location.hash = hash;
	const container = document.createElement("div");
	container.id = "app";
	document.body.appendChild(container);
	const writer: Writer & ReturnType<typeof createFixtureWriter> =
		createFixtureWriter({ mode: options.mode ?? "instant" });
	unmount = mountApp(container, {
		reader: options.reader ?? createFixtureReader({ clock }),
		writer,
		clock,
	}).unmount;
	await settle();
	return writer;
};
export const click = async (selector: string): Promise<void> => {
	element(selector).click();
	await settle();
};
export const fill = async (selector: string, value: string): Promise<void> => {
	const input = element<HTMLInputElement>(selector);
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
};
export const press = async (target: Element, key: string): Promise<void> => {
	target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	await settle();
};

/** Each test file registers this with `afterEach`: the app is unmounted and the route cleared. */
export const cleanup = (): void => {
	unmount?.();
	unmount = null;
	document.body.innerHTML = "";
	window.location.hash = "";
};
