/**
 * A small XML reader for S3 responses (ListObjectsV2 results and `<Error>` bodies). It builds an element tree and
 * knows nothing else: no attributes, namespaces, doctypes or schema. Text keeps its whitespace, because an object key
 * may begin or end with a space.
 */
import { StoreError } from "./store.js";

export type XmlElement = {
	name: string;
	/** The element's own text, entities decoded. */
	text: string;
	children: XmlElement[];
};

const TOKEN =
	/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s/>!?]+)[^>]*?(\/?)>|([^<]+)/g;
const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;

/** One pass, so `&amp;lt;` becomes `&lt;` and not `<`. A numeric entity that is no code point stays as written. */
export const decodeEntities = (text: string): string =>
	text.replace(ENTITY, (match, entity: string) => {
		const named = NAMED_ENTITIES[entity];
		if (named !== undefined) return named;
		const codePoint = entity.startsWith("#x")
			? Number.parseInt(entity.slice(2), HEX_RADIX)
			: Number.parseInt(entity.slice(1), DECIMAL_RADIX);
		try {
			return String.fromCodePoint(codePoint);
		} catch {
			return match;
		}
	});

/** The root element. Throws `StoreError` on text that is not one well-formed element. */
export const parseXml = (xml: string): XmlElement => {
	const document: XmlElement = { name: "", text: "", children: [] };
	const stack: XmlElement[] = [document];
	let position = 0;
	for (const match of xml.matchAll(TOKEN)) {
		// matchAll skips what no token matches (a stray "<", a doctype): that is malformed, not ignorable.
		if (match.index !== position) {
			throw new StoreError(`malformed XML: unexpected input at ${position}`);
		}
		position += match[0].length;
		const [, cdata, closing, name, selfClosing, text] = match;
		const current = stack[stack.length - 1] as XmlElement;
		if (cdata !== undefined) {
			current.text += cdata;
		} else if (text !== undefined) {
			current.text += decodeEntities(text);
		} else if (name !== undefined && closing) {
			if (stack.length < 2 || current.name !== name) {
				throw new StoreError(`malformed XML: unexpected </${name}>`);
			}
			stack.pop();
		} else if (name !== undefined) {
			const element: XmlElement = { name, text: "", children: [] };
			current.children.push(element);
			if (!selfClosing) stack.push(element);
		}
	}
	if (position !== xml.length) {
		throw new StoreError(`malformed XML: unexpected input at ${position}`);
	}
	const [root] = document.children;
	if (stack.length !== 1 || document.children.length !== 1 || !root) {
		throw new StoreError(
			"malformed XML: expected exactly one closed root element",
		);
	}
	return root;
};

export const childrenNamed = (
	element: XmlElement,
	name: string,
): XmlElement[] => element.children.filter((child) => child.name === name);

/** The text of the first child with this name; undefined when there is none. */
export const childText = (
	element: XmlElement,
	name: string,
): string | undefined => childrenNamed(element, name)[0]?.text;
