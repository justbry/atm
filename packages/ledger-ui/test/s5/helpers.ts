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
export const click = async (selector: string): Promise<void> => {
	element(selector).click();
	await settle();
};
/** Types into a field the way a person does: sets the value and fires `input`. */
export const fill = async (selector: string, value: string): Promise<void> => {
	const field = element<HTMLInputElement>(selector);
	field.value = value;
	field.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
};
export const open = async (
	hash: string,
	options: { reader?: Reader; writer?: Writer } = {},
): Promise<void> => {
	window.location.hash = hash;
	const container = document.createElement("div");
	container.id = "app";
	document.body.appendChild(container);
	unmount = mountApp(container, {
		reader: options.reader ?? createFixtureReader({ clock }),
		writer: options.writer ?? createFixtureWriter({ mode: "instant" }),
		clock,
	}).unmount;
	await settle();
};

/** Each test file runs this after every test: it unmounts the app and clears the page. */
export const cleanUp = (): void => {
	unmount?.();
	unmount = null;
	document.body.innerHTML = "";
	window.location.hash = "";
};
