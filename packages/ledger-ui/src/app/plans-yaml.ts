import type {
	Menu,
	MenuAddon,
	MenuAudience,
	MenuGrant,
	MenuInterval,
	MenuTier,
	MenuVersionBody,
} from "../data/plans.ts";

/**
 * Plans as YAML (the Code view): the mockup's restricted subset (`kEmit`, `kParse`) over a `Menu`, with a small emitter
 * and parser written here, no library. Block maps, block lists of maps, one-line lists of numbers, plain, 'single' and
 * "double" scalars and # comments. No anchors, aliases, tags, block text, inline maps, tabs or second documents. The
 * layout and the round trip are specified in `data/plans.ts`.
 */

const plainScalar = /^[A-Za-z0-9][A-Za-z0-9 .,;!?()/&+_-]*$/;
const yamlWord = /^(true|false|null|yes|no|on|off|y|n)$/i;
const numberText = /^-?\d+(\.\d+)?$/;
const keyStart = /^[A-Za-z_][A-Za-z0-9_-]*\s*:(\s|$)/;
const keyValue = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*))?$/;
const planIdPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;
const audiences: MenuAudience[] = ["member", "governance", "public"];
const intervals: MenuInterval[] = ["month", "year"];
const packCharges = ["once", "month", "year"] as const;
const centsPerUnit = 100;
const centsTolerance = 1e-6;

const scalarText = (value: string): string =>
	value !== "" &&
	plainScalar.test(value) &&
	!/\s$/.test(value) &&
	!yamlWord.test(value) &&
	!numberText.test(value)
		? value
		: JSON.stringify(value);
const majorUnits = (cents: number): string => String(cents / centsPerUnit);

type StripeFacts = MenuVersionBody["stripe"];

/** The `# stripe:` line over an item: what the LIVE version has on Stripe for it, never an id. */
function stripeNote(
	stripe: StripeFacts,
	kind: "tiers" | "addons",
	id: string,
): string {
	const key = kind === "tiers" ? `t:${id}` : `a:${id}`;
	if (!stripe.products.includes(key))
		return "# stripe: created when you publish";
	const prices = stripe.prices
		.filter((price) => price.startsWith(`${key}:`))
		.map((price) => price.slice(key.length + 1));
	const labels =
		kind === "tiers"
			? intervals.filter((interval) => prices.includes(interval))
			: prices.slice(0, 1);
	return `# stripe: ${[
		"product",
		...labels.map((label) => (kind === "addons" ? "price" : `${label} price`)),
	].join(" · ")}`;
}

function grantLines(grants: MenuGrant[]): string[] {
	return [
		"    grants:",
		...grants.flatMap((grant) => [
			`      - feature: ${scalarText(grant.featureId)}`,
			`        units: ${grant.amount}`,
			`        every: ${scalarText(grant.every)}`,
			`        rollover: ${grant.rollover?.months ?? 0}`,
		]),
	];
}

function tierLines(tier: MenuTier, stripe: StripeFacts): string[] {
	const month = tier.prices.find(({ interval }) => interval === "month");
	const year = tier.prices.find(({ interval }) => interval === "year");
	return [
		`  ${stripeNote(stripe, "tiers", tier.id)}`,
		`  - id: ${scalarText(tier.id)}`,
		`    name: ${scalarText(tier.name)}`,
		`    blurb: ${scalarText(tier.blurb)}`,
		`    public: ${tier.public}`,
		...(tier.audience && tier.audience !== "member"
			? [`    audience: ${scalarText(tier.audience)}`]
			: []),
		...(month || year
			? [
					"    prices:",
					...(month ? [`      month: ${majorUnits(month.amount)}`] : []),
					...(year ? [`      year: ${majorUnits(year.amount)}`] : []),
				]
			: []),
		...(tier.quantities
			? [`    quantities: [${tier.quantities.join(", ")}]`]
			: []),
		...grantLines(tier.grants),
	];
}

const addonLines = (addon: MenuAddon, stripe: StripeFacts): string[] => [
	`  ${stripeNote(stripe, "addons", addon.id)}`,
	`  - id: ${scalarText(addon.id)}`,
	`    name: ${scalarText(addon.name)}`,
	`    price: ${majorUnits(addon.price.amount)}`,
	`    every: ${scalarText(addon.price.every)}`,
	...grantLines(addon.grants),
];

/** The Code text of a draft: the header, the read-only `version`, `currency` and `timeZone`, then the plans. */
export function emitMenu(options: {
	schoolName: string;
	version: number;
	menu: Menu;
	stripe: StripeFacts;
}): string {
	const { schoolName, version, menu, stripe } = options;
	const lines = [
		`# ${schoolName}: plans. Edit here, then Review and publish.`,
		"# Each plan is keyed by its id: rename a plan by changing name, not id.",
		"# Lines that start with # stripe: are read-only and come back when you Format.",
		`version: ${version}`,
		`currency: ${scalarText(menu.currency.toUpperCase())}`,
		`timeZone: ${scalarText(menu.timeZone)}`,
		"",
		...(menu.tiers.length > 0
			? [
					"memberships:",
					...menu.tiers.flatMap((tier) => tierLines(tier, stripe)),
				]
			: ["memberships: []"]),
		"",
		...(menu.addons.length > 0
			? ["packs:", ...menu.addons.flatMap((addon) => addonLines(addon, stripe))]
			: ["packs: []"]),
	];
	return `${lines.join("\n")}\n`;
}

class YamlError extends Error {
	readonly line: number;
	constructor(line: number, message: string) {
		super(message);
		this.line = line;
	}
}

type Scalar = string | number | boolean | null;
type Entry = { line: number; node: Node };
type Node =
	| { kind: "scalar"; line: number; value: Scalar }
	| { kind: "flow"; line: number; values: Scalar[] }
	| { kind: "map"; line: number; entries: Map<string, Entry> }
	| { kind: "seq"; line: number; items: Node[] };
type Row = { line: number; indent: number; text: string };

function stripComment(source: string, line: number): string {
	let quote = "";
	let previous = "";
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? "";
		if (quote) {
			if (quote === '"' && char === "\\") {
				index += 1;
				continue;
			}
			if (char === quote) {
				if (quote === "'" && source[index + 1] === "'") {
					index += 1;
					continue;
				}
				quote = "";
			}
			continue;
		}
		if (
			(char === '"' || char === "'") &&
			(previous === "" || ":-[,".includes(previous))
		) {
			quote = char;
			previous = char;
			continue;
		}
		if (char === "#" && (index === 0 || /\s/.test(source[index - 1] ?? "")))
			return source.slice(0, index);
		if (!/\s/.test(char)) previous = char;
	}
	if (quote)
		throw new YamlError(
			line,
			"This quote is never closed. Text must stay on one line.",
		);
	return source;
}

function readRows(text: string): Row[] {
	const rows: Row[] = [];
	const sources = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "").split("\n");
	for (const [index, source] of sources.entries()) {
		const line = index + 1;
		const body = stripComment(source, line);
		if (!body.trim()) continue;
		if (/^ *\t/.test(body))
			throw new YamlError(line, "Tabs aren't allowed. Indent with spaces.");
		const indent = (body.match(/^ */) ?? [""])[0].length;
		rows.push({ line, indent, text: body.slice(indent).replace(/\s+$/, "") });
	}
	return rows;
}

function rejectStart(text: string, line: number): void {
	const first = text[0];
	if (first === "&")
		throw new YamlError(
			line,
			"Anchors (&) aren't accepted. Write the value out in full.",
		);
	if (first === "*")
		throw new YamlError(
			line,
			"Aliases (*) aren't accepted. Write the value out in full.",
		);
	if (first === "!")
		throw new YamlError(
			line,
			"Tags (!) aren't accepted. Write the plain value.",
		);
	if (first === "|" || first === ">")
		throw new YamlError(
			line,
			"Block text (| or >) isn't accepted. Put the text on one line.",
		);
	if (first === "{")
		throw new YamlError(
			line,
			"Inline { } maps aren't accepted. Put each key on its own line.",
		);
	if (text.startsWith("<<"))
		throw new YamlError(
			line,
			"Merge keys (<<) aren't accepted. Write the values out in full.",
		);
	if (first === "@" || first === "`" || first === "%")
		throw new YamlError(
			line,
			`"${first}" can't start a value. Put the text in quotes.`,
		);
}

function readScalar(text: string, line: number): Scalar {
	if (text.startsWith('"')) {
		const quoted = text.match(/^"((?:[^"\\]|\\.)*)"$/);
		if (!quoted)
			throw new YamlError(line, "Text after a closing quote isn't accepted.");
		try {
			const decoded: string = JSON.parse(`"${quoted[1]}"`);
			return decoded;
		} catch {
			throw new YamlError(
				line,
				"This quoted text has an escape that isn't accepted. Use \\n, \\t, \\\" or \\\\.",
			);
		}
	}
	if (text.startsWith("'")) {
		const quoted = text.match(/^'((?:[^']|'')*)'$/);
		if (!quoted)
			throw new YamlError(line, "Text after a closing quote isn't accepted.");
		return (quoted[1] ?? "").replace(/''/g, "'");
	}
	rejectStart(text, line);
	if (text === "null" || text === "~") return null;
	if (text === "true") return true;
	if (text === "false") return false;
	if (numberText.test(text)) return Number(text);
	if (/^(yes|no|on|off|y|n)$/i.test(text))
		throw new YamlError(
			line,
			`Write true or false, or put "${text}" in quotes if it is text.`,
		);
	if (/:(\s|$)/.test(text))
		throw new YamlError(line, "Put text that contains a colon in quotes.");
	return text;
}

function readFlow(text: string, line: number): Node {
	if (!text.endsWith("]"))
		throw new YamlError(line, "This list is missing its closing ].");
	const inner = text.slice(1, -1);
	const parts: string[] = [];
	let current = "";
	let quote = "";
	for (let index = 0; index < inner.length; index += 1) {
		const char = inner[index] ?? "";
		if (quote) {
			current += char;
			if (quote === '"' && char === "\\") {
				index += 1;
				current += inner[index] ?? "";
				continue;
			}
			if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === ",") {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);
	const items = parts.map((part) => part.trim());
	if (items[items.length - 1] === "") items.pop();
	return {
		kind: "flow",
		line,
		values: items.map((item) => {
			if (!item) throw new YamlError(line, "This list has an empty item.");
			if (item.startsWith("[") || item.startsWith("{"))
				throw new YamlError(line, "Lists inside lists aren't accepted.");
			return readScalar(item, line);
		}),
	};
}

const readValue = (text: string, line: number): Node =>
	text.startsWith("[")
		? readFlow(text, line)
		: { kind: "scalar", line, value: readScalar(text, line) };

const isDash = (row: Row): boolean =>
	row.text === "-" || row.text.startsWith("- ");

/** Rows to a node tree; every node knows its line. */
function buildTree(rows: Row[]): Node {
	let index = 0;
	const block = (row: Row, indent: number): Node =>
		isDash(row) ? sequence(row, indent) : mapping(row, indent);
	function sequence(first: Row, indent: number): Node {
		const items: Node[] = [];
		for (
			let row = rows[index];
			row && row.indent === indent && isDash(row);
			row = rows[index]
		) {
			const rest = row.text.slice(1).replace(/^ +/, "");
			if (!rest) {
				index += 1;
				const next = rows[index];
				items.push(
					next && next.indent > indent
						? block(next, next.indent)
						: { kind: "scalar", line: row.line, value: null },
				);
				continue;
			}
			const at = indent + (row.text.length - rest.length);
			const inner = { line: row.line, indent: at, text: rest };
			rows[index] = inner;
			if (isDash(inner)) items.push(sequence(inner, at));
			else if (keyStart.test(rest)) items.push(mapping(inner, at));
			else {
				index += 1;
				items.push(readValue(rest, row.line));
			}
		}
		return { kind: "seq", line: first.line, items };
	}
	function mapping(first: Row, indent: number): Node {
		const entries = new Map<string, Entry>();
		for (
			let row = rows[index];
			row && row.indent === indent && !isDash(row);
			row = rows[index]
		) {
			const match = row.text.match(keyValue);
			if (!match) {
				rejectStart(row.text, row.line);
				throw new YamlError(row.line, "Expected key: value on this line.");
			}
			const [, key = "", value] = match;
			if (entries.has(key))
				throw new YamlError(
					row.line,
					`"${key}" appears twice in the same place.`,
				);
			index += 1;
			const next = rows[index];
			if (value === undefined || value === "") {
				if (next && next.indent > indent)
					entries.set(key, { line: row.line, node: block(next, next.indent) });
				else if (next && next.indent === indent && isDash(next))
					entries.set(key, { line: row.line, node: sequence(next, indent) });
				else
					entries.set(key, {
						line: row.line,
						node: { kind: "scalar", line: row.line, value: null },
					});
			} else
				entries.set(key, { line: row.line, node: readValue(value, row.line) });
		}
		const after = rows[index];
		if (after && after.indent > indent)
			throw new YamlError(
				after.line,
				"This line is indented more than the line above it.",
			);
		return { kind: "map", line: first.line, entries };
	}
	const first = rows[0];
	if (!first) throw new YamlError(1, "The document is empty.");
	const root = block(first, first.indent);
	const left = rows[index];
	if (left)
		throw new YamlError(
			left.line,
			"This line doesn't line up with the lines above it.",
		);
	return root;
}

/** Where each plan sits in the text, for the gutter and the problem list. */
type ParsedItem = { name: string; line: number };

export type ParsedMenu =
	| {
			ok: true;
			menu: Menu;
			items: ParsedItem[];
			membershipsLine: number | null;
			packsLine: number | null;
	  }
	| { ok: false; line: number; message: string };

const typeText = {
	string: "text",
	number: "a number",
	boolean: "true or false",
} as const;

function scalarOf(
	entry: Entry,
	what: string,
	type: keyof typeof typeText,
	nullable: boolean,
): Scalar {
	const { node } = entry;
	if (node.kind !== "scalar")
		throw new YamlError(
			entry.line,
			`${what} must be ${typeText[type]}, on one line.`,
		);
	if (node.value === null && nullable) return null;
	if (typeof node.value !== type)
		throw new YamlError(
			entry.line,
			`${what} must be ${typeText[type]}${nullable ? " or left out" : ""}.`,
		);
	return node.value;
}
const stringOf = (entry: Entry, what: string): string =>
	String(scalarOf(entry, what, "string", false));
const numberOf = (entry: Entry, what: string): number =>
	Number(scalarOf(entry, what, "number", false));
const booleanOf = (entry: Entry, what: string): boolean =>
	scalarOf(entry, what, "boolean", false) === true;
const optionalNumberOf = (entry: Entry, what: string): number | null => {
	const value = scalarOf(entry, what, "number", true);
	return value === null ? null : Number(value);
};
function choiceOf<Choice extends string>(
	entry: Entry,
	what: string,
	choices: readonly Choice[],
): Choice {
	const value = stringOf(entry, what);
	const chosen = choices.find((choice) => choice === value);
	if (chosen === undefined)
		throw new YamlError(
			entry.line,
			`${what} must be one of: ${choices.join(", ")}.`,
		);
	return chosen;
}
/** Amounts are written in major units and kept as whole cents. */
function centsOf(entry: Entry, what: string): number {
	const amount = numberOf(entry, what);
	const cents = Math.round(amount * centsPerUnit);
	if (Math.abs(amount * centsPerUnit - cents) > centsTolerance)
		throw new YamlError(
			entry.line,
			`${what} can have two decimals at most: amounts are whole cents.`,
		);
	return cents;
}
function allowKeys(
	node: Extract<Node, { kind: "map" }>,
	keys: string[],
	where: string,
): void {
	for (const [key, entry] of node.entries)
		if (!keys.includes(key))
			throw new YamlError(
				entry.line,
				`Unknown key "${key}" in ${where}. Use: ${keys.join(", ")}.`,
			);
}
function mapOf(entry: Entry, what: string): Extract<Node, { kind: "map" }> {
	if (entry.node.kind !== "map")
		throw new YamlError(
			entry.line,
			`${what} must be a list of keys, one per line.`,
		);
	return entry.node;
}
function listOf(entry: Entry, what: string): Node[] {
	const { node } = entry;
	if (node.kind === "seq") return node.items;
	if (node.kind === "scalar" && node.value === null) return [];
	if (node.kind === "flow" && node.values.length === 0) return [];
	throw new YamlError(
		entry.line,
		`${what} must be a list. Start each entry with "- ".`,
	);
}

type BuildContext = {
	version: number;
	previous: Menu;
};

function readGrants(
	entry: Entry | undefined,
	parent: Node,
	context: BuildContext,
	before: MenuGrant[],
): MenuGrant[] {
	if (!entry)
		throw new YamlError(
			parent.line,
			"grants is missing. A plan needs at least one.",
		);
	const list = listOf(entry, "grants");
	if (list.length === 0)
		throw new YamlError(entry.line, "A plan needs at least one grant.");
	const featureIds = context.previous.features.map(({ id }) => id);
	return list.map((item, index) => {
		if (item.kind !== "map")
			throw new YamlError(
				item.line,
				"Each grant is a set of keys: feature, units, every, rollover.",
			);
		allowKeys(item, ["feature", "units", "every", "rollover"], "a grant");
		const feature = item.entries.get("feature");
		const units = item.entries.get("units");
		const every = item.entries.get("every");
		const rollover = item.entries.get("rollover");
		const featureId = feature
			? choiceOf(feature, "feature", featureIds)
			: featureIds[0];
		if (featureId === undefined)
			throw new YamlError(item.line, "This school has nothing to grant.");
		if (!units) throw new YamlError(item.line, "A grant needs units.");
		if (!every) throw new YamlError(item.line, "A grant needs every.");
		const months = rollover ? numberOf(rollover, "rollover") : 0;
		/** `rollover.max` is stored but not offered: an edit keeps the draft's value. */
		const max = before[index]?.rollover?.max;
		return {
			featureId,
			amount: numberOf(units, "units"),
			every: choiceOf(every, "every", intervals),
			...(months > 0
				? { rollover: { months, ...(max === undefined ? {} : { max }) } }
				: {}),
		};
	});
}

function readCommon(map: Extract<Node, { kind: "map" }>): {
	id: string;
	name: string;
} {
	const id = map.entries.get("id");
	if (!id) throw new YamlError(map.line, "Every plan needs an id.");
	const identifier = stringOf(id, "id");
	if (!planIdPattern.test(identifier))
		throw new YamlError(
			id.line,
			"id uses lowercase letters, digits and dashes, up to 40.",
		);
	const name = map.entries.get("name");
	return { id: identifier, name: name ? stringOf(name, "name") : "" };
}

function readTier(
	map: Extract<Node, { kind: "map" }>,
	context: BuildContext,
): MenuTier {
	allowKeys(
		map,
		[
			"id",
			"name",
			"blurb",
			"public",
			"audience",
			"prices",
			"quantities",
			"grants",
		],
		"a membership",
	);
	const { id, name } = readCommon(map);
	const blurb = map.entries.get("blurb");
	const visible = map.entries.get("public");
	const audience = map.entries.get("audience");
	const prices = map.entries.get("prices");
	const quantities = map.entries.get("quantities");
	const tierPrices: MenuTier["prices"] = [];
	if (prices) {
		const priceMap = mapOf(prices, "prices");
		allowKeys(priceMap, ["month", "year"], "prices");
		const month = priceMap.entries.get("month");
		const year = priceMap.entries.get("year");
		if (month)
			tierPrices.push({ interval: "month", amount: centsOf(month, "month") });
		if (year && optionalNumberOf(year, "year") !== null)
			tierPrices.push({ interval: "year", amount: centsOf(year, "year") });
	}
	let sizes: number[] = [];
	if (quantities) {
		const { node } = quantities;
		if (node.kind === "flow") sizes = numbersOf(node.values, quantities);
		else if (node.kind === "seq")
			sizes = numbersOf(
				node.items.map((item) => {
					if (item.kind !== "scalar")
						throw new YamlError(item.line, "Sizes are plain numbers.");
					return item.value;
				}),
				quantities,
			);
		else if (!(node.kind === "scalar" && node.value === null))
			throw new YamlError(
				quantities.line,
				"quantities is a list of numbers, like [1, 2, 4].",
			);
	}
	const chosen = audience
		? choiceOf(audience, "audience", audiences)
		: "member";
	const before = context.previous.tiers.find((tier) => tier.id === id);
	return {
		id,
		name,
		blurb: blurb ? stringOf(blurb, "blurb") : "",
		public: visible ? booleanOf(visible, "public") : true,
		prices: tierPrices,
		grants: readGrants(
			map.entries.get("grants"),
			map,
			context,
			before?.grants ?? [],
		),
		...(sizes.length > 0 ? { quantities: sizes } : {}),
		...(chosen === "member" ? {} : { audience: chosen }),
	};
}

function numbersOf(values: Scalar[], entry: Entry): number[] {
	const numbers = values.filter(
		(value): value is number => typeof value === "number",
	);
	if (numbers.length !== values.length)
		throw new YamlError(entry.line, "quantities are numbers, like [1, 2, 4].");
	return numbers;
}

function readAddon(
	map: Extract<Node, { kind: "map" }>,
	context: BuildContext,
): MenuAddon {
	allowKeys(map, ["id", "name", "price", "every", "grants"], "a pack");
	const { id, name } = readCommon(map);
	const price = map.entries.get("price");
	const every = map.entries.get("every");
	const before = context.previous.addons.find((addon) => addon.id === id);
	return {
		id,
		name,
		price: {
			amount: price ? centsOf(price, "price") : 0,
			every: every ? choiceOf(every, "every", packCharges) : "once",
		},
		grants: readGrants(
			map.entries.get("grants"),
			map,
			context,
			before?.grants ?? [],
		),
	};
}

function readMenu(root: Node, context: BuildContext): ParsedMenu {
	if (root.kind !== "map")
		throw new YamlError(
			root.line,
			"The document must be keys such as memberships: and packs:.",
		);
	allowKeys(
		root,
		["version", "currency", "timeZone", "memberships", "packs"],
		"the top level",
	);
	const { previous } = context;
	const currency = previous.currency.toUpperCase();
	const version = root.entries.get("version");
	if (version && numberOf(version, "version") !== context.version)
		throw new YamlError(
			version.line,
			`version is the published version (${context.version}). It changes when you publish, so leave it as ${context.version}.`,
		);
	const currencyEntry = root.entries.get("currency");
	if (currencyEntry && stringOf(currencyEntry, "currency") !== currency)
		throw new YamlError(
			currencyEntry.line,
			`currency is set in Settings (${currency}), not in plans.`,
		);
	const zone = root.entries.get("timeZone");
	if (zone && stringOf(zone, "timeZone") !== previous.timeZone)
		throw new YamlError(
			zone.line,
			`timeZone is set in Settings (${previous.timeZone}), not in plans.`,
		);
	const items: ParsedItem[] = [];
	const tiers: MenuTier[] = [];
	const addons: MenuAddon[] = [];
	const memberships = root.entries.get("memberships");
	const packs = root.entries.get("packs");
	if (memberships)
		for (const item of listOf(memberships, "memberships")) {
			if (item.kind !== "map")
				throw new YamlError(
					item.line,
					"Each membership is a set of keys, starting with - id:.",
				);
			const tier = readTier(item, context);
			tiers.push(tier);
			items.push({ name: tier.name, line: item.line });
		}
	if (packs)
		for (const item of listOf(packs, "packs")) {
			if (item.kind !== "map")
				throw new YamlError(
					item.line,
					"Each pack is a set of keys, starting with - id:.",
				);
			const addon = readAddon(item, context);
			addons.push(addon);
			items.push({ name: addon.name, line: item.line });
		}
	return {
		ok: true,
		menu: { ...previous, tiers, addons },
		items,
		membershipsLine: memberships?.line ?? null,
		packsLine: packs?.line ?? null,
	};
}

/** The draft a Code text describes. `previous` is the draft being edited: it keeps the currency, time zone and features
 * (read-only here) and the grants' `rollover.max`. A refused text names its line and says why. */
export function parseMenu(
	text: string,
	options: { version: number; previous: Menu },
): ParsedMenu {
	try {
		const rows = readRows(text);
		if (rows[0]?.text === "---") rows.shift();
		const extra = rows.find((row) => row.text === "---" || row.text === "...");
		if (extra)
			throw new YamlError(extra.line, "Only one document is accepted.");
		if (rows.length === 0)
			throw new YamlError(
				1,
				"The document is empty. Use Reset to published to start again.",
			);
		return readMenu(buildTree(rows), options);
	} catch (error) {
		if (error instanceof YamlError)
			return { ok: false, line: error.line, message: error.message };
		throw error;
	}
}
