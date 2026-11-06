/**
 * The thin adapter (protocol v9 addendum §3): the smoke body's helper names over the UI mounted in happy-dom, driven
 * by `map.json`. Needs the global happy-dom window (`test/setup.ts`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { options } from "preact";
import { mountApp } from "../../src/app/mount.tsx";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";
import { type CompiledSmoke, mapPath } from "./smoke.ts";

type Alias = {
	ui: string;
	attribute: string;
	from?: string;
	values?: Record<string, string>;
	transform?: keyof typeof transforms;
	constant?: string;
};
type ParityMap = {
	selectors: Array<{ mockup: string; ui: string }>;
	aliases: Alias[];
	helpers: Record<string, string>;
};

const packageRoot = join(import.meta.dir, "..", "..");
const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };

/** Named alias transforms; null leaves the element without the attribute. */
const transforms = {
	/** `2026-06` → `5`. */
	monthIndex: (value: string): string | null => {
		const match = /^\d{4}-(\d\d)$/.exec(value);
		return match ? String(Number(match[1]) - 1) : null;
	},
	/** `2026` → `2026`, `2026-Q3` → `2026Q3`; months have none. */
	periodKey: (value: string): string | null =>
		/^\d{4}(-Q\d)?$/.test(value) ? value.replace("-", "") : null,
};

const escapeRegExp = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The mockup writes its stylesheet with no spaces around `{ } : ; ,` and no `;` before `}`; theme.css is formatted. */
export const minifyCss = (css: string): string =>
	css
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([{};,>])\s*/g, "$1")
		.replace(/:\s+/g, ":")
		.replace(/;}/g, "}")
		.trim();

const sourceText = (directory: string): string =>
	readdirSync(directory)
		.sort()
		.map((name) => {
			const path = join(directory, name);
			if (statSync(path).isDirectory()) return sourceText(path);
			return /\.(ts|tsx)$/.test(name) ? readFileSync(path, "utf8") : "";
		})
		.join("\n");

export type UiEnvironment = {
	environment: Record<string, unknown>;
	settle: () => Promise<void>;
	takeSelectors: () => string[];
	cleanup: () => void;
};

const macrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

/** Mounts the UI at `#/` (the first school, Plans, as the mockup opens) and returns the body's environment. */
export async function uiEnvironment(
	compiled: CompiledSmoke,
): Promise<UiEnvironment> {
	const map = JSON.parse(readFileSync(mapPath, "utf8")) as ParityMap;
	const rewrites = map.selectors.map(({ mockup, ui }) => ({
		pattern: new RegExp(`(?<![\\w-])${escapeRegExp(mockup)}(?![\\w-])`, "g"),
		ui,
	}));
	const toUi = (selector: string): string =>
		rewrites.reduce(
			(current, { pattern, ui }) => current.replace(pattern, ui),
			selector,
		);
	const decorate = (): void => {
		for (const alias of map.aliases)
			for (const element of document.querySelectorAll(alias.ui)) {
				if (element.hasAttribute(alias.attribute)) continue;
				let value: string | null | undefined = alias.constant;
				if (value === undefined && alias.from) {
					const raw = element.getAttribute(alias.from) ?? "";
					value = alias.transform
						? transforms[alias.transform](raw)
						: (alias.values?.[raw] ?? raw);
				}
				if (value !== null && value !== undefined)
					element.setAttribute(alias.attribute, value);
			}
	};
	let used: string[] = [];
	/** happy-dom announces a hash change on the next task; the mockup redraws in the click. Announcing it here, before
	 * a selector is resolved, lets a pane whose data is already loaded be on screen when the body reads it, as the
	 * mockup's helpers expect (`portal`: tab("mem") then a row). Data that still loads is waited for between steps. */
	let announcedHash = window.location.hash;
	const announceHash = (): void => {
		if (window.location.hash === announcedHash) return;
		announcedHash = window.location.hash;
		window.dispatchEvent(new HashChangeEvent("hashchange"));
	};
	const resolve = (selector: string): string => {
		announceHash();
		decorate();
		const ui = toUi(selector);
		if (!used.includes(ui)) used.push(ui);
		return ui;
	};

	const $ = (selector: string): Element | null =>
		document.querySelector(resolve(selector));
	const $$ = (selector: string): Element[] => [
		...document.querySelectorAll(resolve(selector)),
	];
	const txt = (selector: string): string =>
		($(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();

	/** Errors the page reports while the body runs (the mockup's `errs`). */
	const errs: string[] = [];
	const originalError = console.error;
	console.error = (...parts: unknown[]): void => {
		errs.push(parts.map(String).join(" "));
	};
	const onError = (event: Event): void => {
		errs.push(`window error: ${(event as ErrorEvent).message}`);
	};
	window.addEventListener("error", onError);

	/** Renders on each state change at once, so a click is on screen before the next selector; data still loads
	 * asynchronously and is waited for between steps. */
	const originalDebounce = options.debounceRendering;
	options.debounceRendering = (render) => render();
	/** The body stubs these for its downloads; they are put back afterwards. */
	const originalCreateObjectURL = URL.createObjectURL;
	const originalRevokeObjectURL = URL.revokeObjectURL;
	const originalAnchorClick = HTMLAnchorElement.prototype.click;

	const style = document.createElement("style");
	style.textContent = minifyCss(
		readFileSync(join(packageRoot, "src/theme.css"), "utf8"),
	);
	document.head.prepend(style);
	window.location.hash = "";
	const root = document.createElement("div");
	root.id = "app";
	document.body.appendChild(root);
	const { unmount } = mountApp(root, {
		reader: createFixtureReader({ clock }),
		writer: createFixtureWriter({ mode: "instant" }),
		clock,
	});

	const settle = async (): Promise<void> => {
		for (
			let attempt = 0;
			attempt < 60 && root.dataset.route !== window.location.hash;
			attempt += 1
		)
			await macrotask();
		await macrotask();
		await macrotask();
		decorate();
	};
	await settle();

	const environment: Record<string, unknown> = {
		d: document,
		$,
		$$,
		txt,
		win: window,
		errs,
		__m: [undefined, sourceText(join(packageRoot, "src"))],
	};
	/** Prelude helpers (`tab`, `sc`) re-evaluated over the adapter's names. */
	const adapterNames = Object.keys(environment);
	for (const [name, source] of Object.entries(map.helpers)) {
		if (source !== "prelude") continue;
		const initializer = compiled.preludeInitializers[name];
		if (!initializer) continue;
		environment[name] = new Function(
			...adapterNames,
			`return (${initializer});`,
		)(...adapterNames.map((adapterName) => environment[adapterName]));
	}

	return {
		environment,
		settle,
		takeSelectors: () => {
			const taken = used;
			used = [];
			return taken;
		},
		cleanup: () => {
			unmount();
			root.remove();
			style.remove();
			window.location.hash = "";
			if (originalDebounce) options.debounceRendering = originalDebounce;
			else delete options.debounceRendering;
			console.error = originalError;
			window.removeEventListener("error", onError);
			URL.createObjectURL = originalCreateObjectURL;
			URL.revokeObjectURL = originalRevokeObjectURL;
			HTMLAnchorElement.prototype.click = originalAnchorClick;
		},
	};
}
