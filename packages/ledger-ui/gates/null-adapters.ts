import type { Reader } from "../src/data/reader.ts";
import type { Writer } from "../src/data/writer.ts";

/** Adapters whose every call stays pending: the size build measures the app without any data or fixture code. */
const pending = new Proxy({}, { get: () => () => new Promise(() => {}) });
export const nullReader = pending as Reader;
export const nullWriter = pending as Writer;
