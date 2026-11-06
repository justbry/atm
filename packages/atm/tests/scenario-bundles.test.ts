/**
 * Every committed scenario bundle (`fixtures/scenarios/<id>/`) replayed: the H1 to H8 checkpoints equal `hashes.json`
 * (`atm scenario check`), and a bundle outside the matrix also meets its hand numbers. The matrix itself
 * (`e2e-reconcile.test.ts`) checks the bundles that carry a place in it, goldens included.
 */
import { describe, expect, test } from "bun:test";
import { loadScenarioBundles } from "../src/scenario/bundle.js";
import { checkBundle, formatCheck } from "../src/scenario/bundle-check.js";
import { expectBookInvariants } from "./e2e-invariants.js";
import { loadCases, runCase } from "./e2e-matrix.js";
import { hasHledger } from "./helpers.js";

const bundles = await loadScenarioBundles();
const cases = await loadCases();

describe("scenario bundles", () => {
	test("there are bundles, ids are unique and every one has its goldens", () => {
		expect(bundles.length).toBeGreaterThan(0);
		expect(new Set(bundles.map((b) => b.id)).size).toBe(bundles.length);
		for (const bundle of bundles)
			expect(
				Object.keys(bundle.hashes).length,
				`${bundle.id}: hashes.json`,
			).toBeGreaterThan(1);
	});

	for (const bundle of bundles) {
		test(`${bundle.id}: checkpoints equal hashes.json`, async () => {
			const result = await checkBundle(bundle);
			expect(result.ok, formatCheck(result)).toBe(true);
		});

		if (bundle.scenario.order === undefined)
			test.skipIf(!hasHledger)(
				`${bundle.id}: meets its hand numbers`,
				async () => {
					const c = cases.find((entry) => entry.id === bundle.id);
					if (!c) throw new Error(`no case for ${bundle.id}`);
					const run = await runCase(c);
					expect(run.answers).toEqual(bundle.expected.answers);
					for (const [index, book] of run.books.entries())
						expectBookInvariants(c, index, book);
				},
			);
	}
});
