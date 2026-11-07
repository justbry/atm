/**
 * The thin adapter (protocol v9 addendum §3): the smoke body's helper names over the UI mounted in happy-dom, driven
 * by `map.json`. Needs the global happy-dom window (`test/setup.ts`).
 *
 * map.json, in the order the adapter applies it on every `$`, `$$` and `txt`:
 * - aliases: each element matching `ui` gets the mockup's attribute (`attribute`, from one of its own attributes through
 *   `values` or a named `transform`, or a `constant`; `attribute: "id"` gives the element the mockup's id) or class
 *   (`class`), only while it also matches `when` when one is given. The adapter recomputes what it set and never
 *   touches what the UI set itself, so `[data-bv=fin]`, `.on` and `.dataset.p` read the UI's current state.
 * - selectors: literal rewrites of the selector string, in order, where an alias cannot say it (a mockup id the UI
 *   element already has another id for, a structure the UI draws differently).
 * - openers: a mockup popover (`#pp`) the UI mounts only while open, and the mockup button that opens it (`#pb`).
 * - absent: mockup selectors whose element the UI unmounts where the mockup hides it; `$` answers a hidden stand-in.
 * - internals: what `window.__t` holds: the UI functions and fixture data standing for the mockup's internals
 *   (`test/parity/internals.ts`); a name mapped to null is absent, so the checks that need it do not run.
 * PARITY_MAP_EXTRA (comma-separated paths) merges more map fragments after map.json, for trying entries out.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { options } from "preact";
import { saveFile } from "../../src/app/download.ts";
import { mountApp } from "../../src/app/mount.tsx";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";
import { uiInternals } from "./internals.ts";
import { type CompiledSmoke, mapPath } from "./smoke.ts";

type Alias = {
	ui: string;
	attribute?: string;
	class?: string;
	from?: string;
	values?: Record<string, string>;
	transform?: keyof typeof transforms;
	constant?: string;
	when?: string;
};
type ParityMap = {
	selectors: Array<{ mockup: string; ui: string }>;
	aliases: Alias[];
	openers: Array<{ mockup: string; open: string }>;
	absent: Array<{ mockup: string; html: string; pick?: string }>;
	helpers: Record<string, string>;
	internals: Record<string, string | null>;
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
	/** Any period (`2026`, `2026-Q3`, `2026-06`) → the mockup's key without dashes (`2026`, `2026Q3`, `202606`). */
	anyPeriodKey: (value: string): string | null =>
		value ? value.replace(/-/g, "") : null,
};

const escapeRegExp = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The mockup writes its stylesheet with no spaces around `{ } : ; ,` and no `;` before `}`; the UI's CSS is formatted. */
export const minifyCss = (css: string): string =>
	css
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([{};,>])\s*/g, "$1")
		.replace(/:\s+/g, ":")
		.replace(/\s*\/\s*/g, "/")
		.replace(/;}/g, "}")
		.trim();

const filesUnder = (directory: string, pattern: RegExp): string[] =>
	readdirSync(directory)
		.sort()
		.flatMap((name) => {
			const path = join(directory, name);
			if (statSync(path).isDirectory()) return filesUnder(path, pattern);
			return pattern.test(name) ? [path] : [];
		});
const sourceText = (directory: string, pattern: RegExp): string =>
	filesUnder(directory, pattern)
		.map((path) => readFileSync(path, "utf8"))
		.join("\n");

const loadMap = (): ParityMap => {
	const map = JSON.parse(readFileSync(mapPath, "utf8")) as ParityMap;
	for (const path of (process.env.PARITY_MAP_EXTRA ?? "")
		.split(",")
		.filter(Boolean)) {
		const extra = JSON.parse(readFileSync(path, "utf8")) as Partial<ParityMap>;
		map.selectors.push(...(extra.selectors ?? []));
		map.aliases.push(...(extra.aliases ?? []));
		map.openers.push(...(extra.openers ?? []));
		map.absent.push(...(extra.absent ?? []));
		Object.assign(map.internals, extra.internals ?? {});
	}
	return map;
};

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
	const map = loadMap();
	const rewrites = map.selectors.map(({ mockup, ui }) => ({
		pattern: new RegExp(`(?<![\\w-])${escapeRegExp(mockup)}(?![\\w-])`, "g"),
		ui,
	}));
	const toUi = (selector: string): string =>
		rewrites.reduce(
			(current, { pattern, ui }) => current.replace(pattern, ui),
			selector,
		);

	/** What the adapter set on each element, so it can recompute or take it back. */
	const ownedAttributes = new WeakMap<Element, Set<string>>();
	const ownedClasses = new WeakMap<Element, Set<string>>();
	const own = <Key>(
		table: WeakMap<Element, Set<Key>>,
		element: Element,
	): Set<Key> => {
		let set = table.get(element);
		if (!set) {
			set = new Set();
			table.set(element, set);
		}
		return set;
	};
	const aliasValue = (alias: Alias, element: Element): string | null => {
		if (alias.when && !element.matches(alias.when)) return null;
		if (alias.constant !== undefined) return alias.constant;
		if (!alias.from) return "";
		const raw = element.getAttribute(alias.from);
		if (raw === null) return null;
		return alias.transform
			? transforms[alias.transform](raw)
			: (alias.values?.[raw] ?? raw);
	};
	/** Runs before every selector: cheap enough, and a MutationObserver in happy-dom stops reporting once a render
	 * throws, so nothing may depend on one. */
	const decorate = (): void => {
		for (const alias of map.aliases)
			for (const element of document.querySelectorAll(alias.ui)) {
				const value = aliasValue(alias, element);
				if (alias.class) {
					const classes = own(ownedClasses, element);
					if (value !== null && !element.classList.contains(alias.class)) {
						element.classList.add(alias.class);
						classes.add(alias.class);
					} else if (value === null && classes.has(alias.class)) {
						element.classList.remove(alias.class);
						classes.delete(alias.class);
					}
					continue;
				}
				if (!alias.attribute) continue;
				const attributes = own(ownedAttributes, element);
				if (
					!attributes.has(alias.attribute) &&
					element.hasAttribute(alias.attribute)
				)
					continue;
				if (value === null) {
					if (attributes.has(alias.attribute)) {
						element.removeAttribute(alias.attribute);
						attributes.delete(alias.attribute);
					}
				} else if (element.getAttribute(alias.attribute) !== value) {
					element.setAttribute(alias.attribute, value);
					attributes.add(alias.attribute);
				} else attributes.add(alias.attribute);
			}
	};
	let used: string[] = [];
	/** happy-dom announces a hash change on the next task; the mockup redraws in the click. Announcing it here, before
	 * a selector is resolved, lets a pane whose data is already loaded be on screen when the body reads it. */
	let announcedHash = window.location.hash;
	const announceHash = (): void => {
		if (window.location.hash === announcedHash) return;
		announcedHash = window.location.hash;
		window.dispatchEvent(new HashChangeEvent("hashchange"));
	};
	/** The mockup keeps its popovers in the page, hidden; the UI mounts one only while it is open. A selector into a
	 * closed one (`#pp [data-bp=...]`) opens it first through its button, as a person would. */
	const openers = map.openers.map(({ mockup, open }) => ({
		pattern: new RegExp(`(?<![\\w-])${escapeRegExp(mockup)}(?![\\w-])`),
		target: mockup,
		open,
	}));
	const resolve = (selector: string): string => {
		announceHash();
		decorate();
		for (const opener of openers)
			if (
				opener.pattern.test(selector) &&
				!document.querySelector(toUi(opener.target))
			) {
				(
					document.querySelector(toUi(opener.open)) as HTMLElement | null
				)?.click();
				decorate();
			}
		const ui = toUi(selector);
		if (!used.includes(ui)) used.push(ui);
		return ui;
	};
	/** The UI unmounts what the mockup only hides (a closed menu, a modal's backdrop, a lock panel while the books
	 * are readable). For the selectors listed in map.json `absent`, `$` answers a detached stand-in that reads as
	 * hidden and closed (no text, no `on` class) instead of null; `$$` still counts only what is on screen. */
	const standIns = new Map(
		map.absent.map(({ mockup, html, pick }) => [mockup, { html, pick }]),
	);
	const standIn = (selector: string): Element | null => {
		const entry = standIns.get(selector);
		if (!entry) return null;
		const holder = document.createElement("div");
		holder.innerHTML = entry.html;
		return entry.pick
			? holder.querySelector(entry.pick)
			: holder.firstElementChild;
	};

	const $ = (selector: string): Element | null =>
		document.querySelector(resolve(selector)) ?? standIn(selector);
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
	const onRejection = (reason: unknown): void => {
		errs.push(
			`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
		);
	};
	process.on("unhandledRejection", onRejection);

	/** A person changing a select fires `input` and then `change`; the body dispatches only `change`, so the adapter adds
	 * the `input` a browser would have fired before it. */
	let forwarding = false;
	const onChange = (event: Event): void => {
		const target = event.target;
		if (forwarding || !(target instanceof HTMLSelectElement)) return;
		forwarding = true;
		target.dispatchEvent(new Event("input", { bubbles: true }));
		forwarding = false;
	};
	document.addEventListener("change", onChange, true);

	/** Renders on each state change at once, so a click is on screen before the next selector. */
	const originalDebounce = options.debounceRendering;
	options.debounceRendering = (render) => render();
	/** The body stubs these for its downloads; they are put back afterwards. */
	const originalCreateObjectURL = URL.createObjectURL;
	const originalRevokeObjectURL = URL.revokeObjectURL;
	const originalAnchorClick = HTMLAnchorElement.prototype.click;

	const style = document.createElement("style");
	style.textContent = minifyCss(sourceText(join(packageRoot, "src"), /\.css$/));
	document.head.prepend(style);
	window.location.hash = "";
	const root = document.createElement("div");
	root.id = "app";
	document.body.appendChild(root);
	const reader = createFixtureReader({ clock });
	/** The fixture Writer records a download and delivers nothing; the books panes save through `Writer.download`
	 * (S5's contract), which in a browser delivers the file. The harness's Writer records it and then saves it the
	 * way the UI saves its other files (`saveFile`), so the body's download capture sees it. */
	const fixtureWriter = createFixtureWriter({ mode: "instant" });
	const writer: typeof fixtureWriter = {
		...fixtureWriter,
		download: async (file) => {
			await fixtureWriter.download(file);
			saveFile(file);
		},
	};
	const { unmount } = mountApp(root, { reader, writer, clock });

	/** Waits for the route to be on screen, then for the DOM to stay still for two tasks (data loading, effects). */
	const settle = async (): Promise<void> => {
		announceHash();
		for (
			let attempt = 0;
			attempt < 60 && root.dataset.route !== window.location.hash;
			attempt += 1
		)
			await macrotask();
		for (let attempt = 0; attempt < 40; attempt += 1) {
			const before = document.body.innerHTML;
			await macrotask();
			await macrotask();
			if (document.body.innerHTML === before) break;
		}
		decorate();
	};
	await settle();
	/** Each popover loads its panel on first open; open and close each once so a later open renders in the click. */
	for (const { open } of map.openers) {
		const button = document.querySelector(toUi(open)) as HTMLElement | null;
		if (!button) continue;
		button.click();
		await settle();
		button.click();
		await settle();
	}

	const internals = await uiInternals(reader, map.internals);
	(window as unknown as { __t?: unknown }).__t = internals;
	const environment: Record<string, unknown> = {
		d: document,
		$,
		$$,
		txt,
		win: window,
		errs,
		__m: [undefined, sourceText(join(packageRoot, "src"), /\.(ts|tsx)$/)],
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
			document.removeEventListener("change", onChange, true);
			unmount();
			root.remove();
			style.remove();
			window.location.hash = "";
			delete (window as unknown as { __t?: unknown }).__t;
			if (originalDebounce) options.debounceRendering = originalDebounce;
			else delete options.debounceRendering;
			console.error = originalError;
			window.removeEventListener("error", onError);
			process.off("unhandledRejection", onRejection);
			URL.createObjectURL = originalCreateObjectURL;
			URL.revokeObjectURL = originalRevokeObjectURL;
			HTMLAnchorElement.prototype.click = originalAnchorClick;
		},
	};
}
