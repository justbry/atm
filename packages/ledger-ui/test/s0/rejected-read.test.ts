import { afterEach, expect, test } from "bun:test";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { cleanUp, clock, open } from "../s5/helpers.ts";

afterEach(cleanUp);

const macrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

test("a read the Reader rejects leaves no unhandled rejection", async () => {
	const unhandled: unknown[] = [];
	const onRejection = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onRejection);
	const reader = createFixtureReader({ clock });
	const refusing = {
		...reader,
		settings: () => Promise.reject(new Error("no settings")),
		menuVersions: () => Promise.reject(new Error("no plans")),
		people: () => Promise.reject(new Error("no people")),
		promos: () => Promise.reject(new Error("no promos")),
	};
	for (const tab of ["dashboard", "plans", "members", "promos"]) {
		await open(`#/har/${tab}`, { reader: refusing });
		for (let turn = 0; turn < 10; turn += 1) await macrotask();
		cleanUp();
	}
	process.off("unhandledRejection", onRejection);
	expect(unhandled).toEqual([]);
});
