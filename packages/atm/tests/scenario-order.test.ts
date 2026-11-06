/**
 * Stripe promises no order: any permutation of a case's deliveries may arrive, with the ones the handler cannot place yet
 * answered 409 and delivered again. Whatever the order, the books must come out the same, so H4 to H8 (the shipped log, the
 * journal, the reports and KPIs of every channel, the reconcile verdict) of a shuffled run equal those of the written order.
 * H1 to H3 (the deliveries, the handler's decisions and its outbox in applied order) are free to differ and are not compared.
 */
import { describe, expect, test } from "bun:test";
import { makeRng } from "../fixtures/rng.js";
import { loadScenarioBundles } from "../src/scenario/bundle.js";
import {
	bundleCheckpoints,
	compareStages,
} from "../src/scenario/bundle-check.js";
import { runBundle } from "../src/scenario/bundle-run.js";
import type { BundleHashes, BundleStep, ScenarioBundle } from "../src/types.js";
import { hasHledger } from "./helpers.js";

const SHUFFLES = 4;
const SAME_BOOKS = ["H4", "H5", "H6", "H7", "H8"] as const;

/** Cases whose every delivery is applied (or is a harmless repeat): a refusal is final, so its case has no order to vary. */
const shufflable = (bundle: ScenarioBundle): boolean =>
	bundle.steps.length >= 2 &&
	bundle.steps.every(
		(step) => step.kind === undefined || step.kind === "deliver",
	) &&
	bundle.expected.answers.every(([status]) => status === 200);

const shuffled = (bundle: ScenarioBundle, seed: number): ScenarioBundle => {
	const rng = makeRng(`${bundle.id}/${seed}`);
	const steps = [...bundle.steps];
	for (let index = steps.length - 1; index > 0; index--) {
		const other = rng.int(0, index);
		const moved = steps[index] as BundleStep;
		steps[index] = steps[other] as BundleStep;
		steps[other] = moved;
	}
	return { ...bundle, steps };
};

const booksOf = async (bundle: ScenarioBundle, redeliver: boolean) => {
	const run = await runBundle(bundle, { redeliver });
	try {
		const hashes: BundleHashes = { version: 1 };
		for (const entry of bundleCheckpoints(bundle, run)) {
			if (!SAME_BOOKS.includes(entry.stage as (typeof SAME_BOOKS)[number]))
				continue;
			hashes[entry.stage] =
				"checkpoint" in entry
					? entry.checkpoint.hash
					: Object.fromEntries(
							Object.entries(entry.channels).flatMap(([name, value]) =>
								"hash" in value ? [[name, value.hash]] : [],
							),
						);
		}
		return { run, hashes, actual: bundleCheckpoints(bundle, run) };
	} finally {
		await run.dispose();
	}
};

/**
 * Cases whose books change when their deliveries arrive in some other order, found by this test and pinned the way the
 * matrix pins a discrepancy: each is shuffled and must still diverge, so a fix makes it fail and says to take the case off
 * this list. Two causes: (1) a later invoice of a subscription (renewal, upgrade, quantity change) delivered before its
 * first is refused 422 and its credits are never granted, so Jan's grants and the renewal's go missing; (2) a dispute's
 * closing delivered before its opening, or a redelivery under a new event id, makes the credit events cite another
 * delivery as their cause, so their ids (and idems) differ from the written order's.
 */
const ORDER_SENSITIVE: ReadonlySet<string> = new Set([
	"renewal",
	"upgrade",
	"quantity-raise",
	"quantity-decrease",
	"dispute-lost",
	"dispute-won",
	"dispute-redelivered",
	"duplicate-delivery",
]);

const bundles = (await loadScenarioBundles()).filter(shufflable);

describe.skipIf(!hasHledger)(
	"deliveries in any order leave the books alone",
	() => {
		test("there are cases to shuffle", () => {
			expect(bundles.length).toBeGreaterThan(5);
		});

		for (const bundle of bundles)
			test(`${bundle.id}: ${SHUFFLES} shuffles ${ORDER_SENSITIVE.has(bundle.id) ? "change" : "keep"} H4 to H8`, async () => {
				const written = await booksOf(bundle, false);
				let diverged = 0;
				for (let seed = 1; seed <= SHUFFLES; seed++) {
					const other = await booksOf(shuffled(bundle, seed), true);
					const changed = compareStages(written.hashes, other.actual)
						.filter(
							(row) =>
								SAME_BOOKS.includes(row.stage as (typeof SAME_BOOKS)[number]) &&
								row.status !== "skipped",
						)
						.filter((row) => row.status !== "ok")
						.map((row) => `${row.label}: ${row.status}`);
					if (changed.length > 0) diverged += 1;
					if (!ORDER_SENSITIVE.has(bundle.id))
						expect(changed, `seed ${seed}`).toEqual([]);
				}
				if (ORDER_SENSITIVE.has(bundle.id))
					expect(
						diverged,
						`${bundle.id} no longer changes with the order: take it off ORDER_SENSITIVE`,
					).toBeGreaterThan(0);
			});
	},
);
