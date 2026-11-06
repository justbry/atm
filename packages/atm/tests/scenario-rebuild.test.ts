/**
 * Spec v3 test 6, the rebuild-a-holder property test. An attacker who knows the public menu prices and Stripe's fee
 * reads only the cells a document publishes and solves for the payments behind them (tests/rebuild-solver.ts). For a
 * target holder in a target period, the *fits* are the price points of the attacker's prior class (the target's tier, or
 * "the one yearly payer") that some payment mix consistent with every published cell includes.
 *
 * Per triple (preset, target holder, period):
 * - the model is sound: the real payments of the period satisfy every equation of the raw and the suppressed document;
 * - the test bites: the raw document pins the target (fewer than K fits), or the triple is listed in `NO_BITE`;
 * - the suppressed document keeps at least K fits, or the triple is in `KNOWN_LEAKS`, where the leak is asserted so a
 *   fix flips the test.
 * A second view drops the cumulative `closing_balance_usd:` cells, to separate what they give away from what the menu's
 * subset-sum gives away on its own.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	analysePreset,
	type PresetAnalysis,
	REPORT_PATH,
} from "../fixtures/suppression-report.js";
import { SCHOOL_KPIS } from "../src/scenario/kpis.js";
import { PROFILE_NAMES } from "../src/scenario/profiles.js";
import { suppressKpis } from "../src/scenario/suppress.js";
import type { AtmEvent } from "../src/types.js";
import {
	type PricePoint,
	type PublishedDocument,
	paymentEquations,
	pricePoints,
	refundFits,
	solve,
	violations,
} from "./rebuild-solver.js";

/** The anonymity floor: fewer fits than this and the attacker has pinned the holder. */
const MINIMUM_FITS = 2;
const HOLDER_ID = /(family|profile):/;
const CLOSING_BALANCE = "closing_balance_usd:";

type View = "raw" | "suppressed" | "withoutClosingBalances";
const VIEWS: readonly View[] = ["raw", "suppressed", "withoutClosingBalances"];

type Triple = {
	id: string;
	preset: string;
	channel: "payments" | "refund";
	/** The attacker's prior about the target, as a class of price points. */
	className: string;
	isInClass: (point: PricePoint) => boolean;
	holderOf: (events: readonly AtmEvent[]) => string;
	/** A document period: a month, or a quarter for a quarterly document. */
	period: string;
};

const inTier =
	(tier: string) =>
	(point: PricePoint): boolean =>
		point.tier === tier;

const centsOf = (amount: string): number =>
	Math.round(Math.abs(Number(amount)) * 100);

/** The membership income posting of a payment: its tier and what it moved. */
const membershipOf = (
	event: AtmEvent,
): { tier: string; total: number } | null => {
	const postings = event.postings.filter((posting) =>
		posting.account.startsWith("income:billing:membership:"),
	);
	if (postings.length === 0) return null;
	return {
		tier: (postings[0] as { account: string }).account
			.split(":")
			.pop() as string,
		total: postings.reduce((sum, posting) => sum + centsOf(posting.amount), 0),
	};
};

const payments = (events: readonly AtmEvent[]): AtmEvent[] =>
	events.filter((event) => event.event_type === "payment.succeeded");

const holdersWhere = (
	events: readonly AtmEvent[],
	keep: (payment: { tier: string; total: number }) => boolean,
): string[] => [
	...new Set(
		payments(events)
			.filter((event) => {
				const membership = membershipOf(event);
				return membership !== null && keep(membership);
			})
			.map((event) => event.key),
	),
];

const only = (holders: string[], what: string): string => {
	if (holders.length !== 1)
		throw new Error(`expected one ${what}, found ${holders.length}`);
	return holders[0] as string;
};

const first = (holders: string[], what: string): string => {
	const [holder] = holders;
	if (holder === undefined) throw new Error(`no ${what}`);
	return holder;
};

const quarterOf = (month: string): string => {
	const [year, monthNumber] = month.split("-") as [string, string];
	return `${year}-Q${Math.floor((Number(monthNumber) - 1) / 3) + 1}`;
};

const periodOf = (event: AtmEvent, document: PublishedDocument): string => {
	const month = event.date.slice(0, 7);
	return document.periods[0]?.includes("Q") ? quarterOf(month) : month;
};

const YEARLY_FLOOR = 12_000;

const TRIPLES: readonly Triple[] = [
	{
		id: "one-payer-tier",
		preset: "one-payer-tier",
		channel: "payments",
		className: "the fellow tier (a single payer)",
		isInClass: inTier("fellow"),
		holderOf: (events) =>
			only(
				holdersWhere(events, ({ tier }) => tier === "fellow"),
				"fellow payer",
			),
		period: "2026-03",
	},
	{
		id: "tiny-school",
		preset: "tiny-school",
		channel: "payments",
		className: "the scholar tier",
		isInClass: inTier("scholar"),
		holderOf: (events) =>
			first(
				holdersWhere(events, ({ tier }) => tier === "scholar"),
				"scholar payer",
			),
		period: "2026-Q1",
	},
	{
		id: "yearly-solo",
		preset: "yearly-solo",
		channel: "payments",
		className: "a yearly price (one family pays yearly)",
		isInClass: (point) => point.interval === "year",
		holderOf: (events) =>
			only(
				holdersWhere(events, ({ total }) => total >= YEARLY_FLOOR),
				"yearly payer",
			),
		period: "2026-01",
	},
	{
		id: "fee-oracle",
		preset: "fee-oracle",
		channel: "payments",
		className: "the scholar tier (every payment is the same)",
		isInClass: inTier("scholar"),
		holderOf: (events) => (payments(events)[0] as AtmEvent).key,
		period: "2026-03",
	},
	{
		id: "seminar-quantities",
		preset: "seminar-quantities",
		channel: "payments",
		className: "the seminar tier (1, 2 or 4 seats)",
		isInClass: inTier("seminar"),
		holderOf: (events) => (payments(events)[0] as AtmEvent).key,
		period: "2026-03",
	},
	{
		id: "single-refund-month",
		preset: "single-refund-month",
		channel: "refund",
		className: "the refund amounts the menu allows",
		isInClass: () => true,
		holderOf: (events) =>
			only(
				[
					...new Set(
						events
							.filter((event) => event.event_type === "payment.refunded")
							.map((event) => event.key),
					),
				],
				"refunding holder",
			),
		period: "2026-04",
	},
];

/**
 * Triples the raw document does not pin: the preset's design does not give the attacker the holder from the cells even
 * unsuppressed (a month of 1, 2 and 4 seat payments is a subset-sum with several solutions), so there is nothing for
 * suppression to protect and the triple only checks the model.
 */
const NO_BITE: Record<string, string> = {
	"seminar-quantities":
		"the raw cells fit 1, 2 and 4 seats at once: the total and count of a mixed month do not decide a holder",
};

/**
 * Triples where the suppressed document still pins the target: a real leak, not an expected result. The test asserts the
 * leak so that fixing it fails the test and removes the entry. `withoutClosingBalances` says whether the leak also holds
 * once the cumulative closing-balance cells are dropped from the document.
 */
const KNOWN_LEAKS: Record<
	string,
	{ withoutClosingBalances: boolean; note: string }
> = {
	"one-payer-tier": {
		withoutClosingBalances: true,
		note: "complement hides the audit tier because the fellow tier is hidden, but the closing_balance_usd:income:billing:membership:<tier> cells are cumulative and shown for audit, scholar and seminar, so each month's movement of those tiers is public and the fellow payment is membership minus the three. Without them the leak remains: membership total minus scholar and seminar leaves audit plus fellow, and at the menu prices only one split of that sum fits.",
	},
	"fee-oracle": {
		withoutClosingBalances: true,
		note: "inherent to the preset: every holder pays the same price point, so any shown revenue cell (12 holders, none dominant) fixes it. Suppression cannot hide a value everyone shares.",
	},
};

type Result = {
	fits: number;
	fitKeys: string[];
	modelErrors: string[];
};

const withoutClosingBalances = (
	document: PublishedDocument,
): PublishedDocument => ({
	periods: document.periods,
	series: Object.fromEntries(
		Object.entries(document.series).filter(
			([kpiId]) => !kpiId.startsWith(CLOSING_BALANCE),
		),
	),
});

const documentOf = (
	analysis: PresetAnalysis,
	view: View,
): PublishedDocument => {
	if (view === "suppressed") return analysis.document;
	if (view === "withoutClosingBalances")
		return withoutClosingBalances(analysis.document);
	// every cell shown: the same grain, with rules that hide nothing
	const everything = suppressKpis({
		spec: SCHOOL_KPIS,
		rows: analysis.rows,
		contributions: analysis.contributions,
		activePayers: analysis.activePayers,
		rules: { minContributors: 0, maxShare: 1 },
	});
	return {
		periods: everything.periods,
		series: Object.fromEntries(
			Object.entries(everything.series).filter(
				([kpiId]) => !kpiId.startsWith("closing_balance_usd:assets:"),
			),
		),
	};
};

const POINTS = pricePoints();
const LARGEST_PAYMENT = Math.max(...POINTS.map((point) => point.total));

/** The payment mix of a period, read from the events: price point key to count. */
const actualMix = (
	events: readonly AtmEvent[],
	document: PublishedDocument,
	period: string,
	only?: string,
): Map<string, number> => {
	const mix = new Map<string, number>();
	for (const event of payments(events)) {
		if (periodOf(event, document) !== period) continue;
		if (only !== undefined && event.key !== only) continue;
		const membership = membershipOf(event);
		if (!membership) continue;
		const point = POINTS.find(
			(candidate) =>
				candidate.tier === membership.tier &&
				candidate.total === membership.total,
		);
		if (!point)
			throw new Error(
				`no price point for ${membership.tier} ${membership.total}`,
			);
		mix.set(point.key, (mix.get(point.key) ?? 0) + 1);
	}
	return mix;
};

const evaluate = ({
	analysis,
	triple,
	view,
}: {
	analysis: PresetAnalysis;
	triple: Triple;
	view: View;
}): Result => {
	const document = documentOf(analysis, view);
	const index = document.periods.indexOf(triple.period);
	if (index === -1)
		throw new Error(`no period ${triple.period} in ${triple.id}`);
	if (triple.channel === "refund")
		return {
			fits: refundFits({ document, index, largestPayment: LARGEST_PAYMENT }),
			fitKeys: [],
			modelErrors: [],
		};
	const payers = new Set(payments(analysis.events).map((event) => event.key))
		.size;
	const equations = paymentEquations({
		document,
		index,
		points: POINTS,
		headcount: {
			payers,
			monthsInPeriod: document.periods[0]?.includes("Q") ? 3 : 1,
		},
	});
	const modelErrors = violations({
		equations,
		points: POINTS,
		counts: actualMix(analysis.events, document, triple.period),
	});
	const solution = solve({ points: POINTS, equations });
	const fitKeys = POINTS.filter(
		(point) => triple.isInClass(point) && solution.fits.includes(point.key),
	).map((point) => point.key);
	return { fits: fitKeys.length, fitKeys, modelErrors };
};

const analyses = new Map<string, PresetAnalysis>();
const results = new Map<string, Result>();
const resultKey = (triple: Triple, view: View) => `${triple.id}/${view}`;

beforeAll(async () => {
	for (const triple of TRIPLES) {
		const analysis = await analysePreset(triple.preset);
		analyses.set(triple.preset, analysis);
		for (const view of VIEWS)
			results.set(
				resultKey(triple, view),
				evaluate({ analysis, triple, view }),
			);
	}
	if (process.env.REBUILD_TABLE)
		console.table(
			TRIPLES.map((triple) => ({
				triple: triple.id,
				period: triple.period,
				class: triple.className,
				raw: results.get(resultKey(triple, "raw"))?.fits,
				suppressed: results.get(resultKey(triple, "suppressed"))?.fits,
				withoutClosingBalances: results.get(
					resultKey(triple, "withoutClosingBalances"),
				)?.fits,
			})),
		);
}, 120_000);

const resultOf = (triple: Triple, view: View): Result =>
	results.get(resultKey(triple, view)) as Result;

describe("rebuild a holder", () => {
	for (const triple of TRIPLES) {
		describe(triple.id, () => {
			test("the model reproduces the real payments", () => {
				for (const view of VIEWS)
					expect(resultOf(triple, view).modelErrors).toEqual([]);
			});

			test("the target's real price point is among the fits", () => {
				if (triple.channel === "refund") return;
				const analysis = analyses.get(triple.preset) as PresetAnalysis;
				const holder = triple.holderOf(analysis.events);
				for (const view of VIEWS) {
					const document = documentOf(analysis, view);
					const own = [
						...actualMix(
							analysis.events,
							document,
							triple.period,
							holder,
						).keys(),
					];
					for (const key of own) {
						const point = POINTS.find((p) => p.key === key) as PricePoint;
						if (triple.isInClass(point))
							expect(resultOf(triple, view).fitKeys).toContain(key);
					}
				}
			});

			const noBite = NO_BITE[triple.id];
			test(
				noBite
					? "the raw document does not pin the target (no bite)"
					: "the raw document pins the target",
				() => {
					const raw = resultOf(triple, "raw").fits;
					if (noBite) expect(raw).toBeGreaterThanOrEqual(MINIMUM_FITS);
					else expect(raw).toBeLessThan(MINIMUM_FITS);
					expect(raw).toBeGreaterThan(0);
				},
			);

			const leak = KNOWN_LEAKS[triple.id];
			test(
				leak
					? "KNOWN LEAK: the suppressed document still pins the target"
					: "the suppressed document leaves at least k fits",
				() => {
					const fits = resultOf(triple, "suppressed").fits;
					if (leak) {
						expect(fits).toBeLessThan(MINIMUM_FITS);
						expect(fits).toBeGreaterThan(0);
					} else expect(fits).toBeGreaterThanOrEqual(MINIMUM_FITS);
				},
			);

			test("the document without its closing balances", () => {
				const fits = resultOf(triple, "withoutClosingBalances").fits;
				if (leak?.withoutClosingBalances)
					expect(fits).toBeLessThan(MINIMUM_FITS);
				else expect(fits).toBeGreaterThanOrEqual(MINIMUM_FITS);
			});
		});
	}
});

describe("no holder id in any output", () => {
	for (const name of PROFILE_NAMES)
		test(`${name}: no key or value of the suppressed document names a holder`, async () => {
			const { document } = await analysePreset(name);
			expect(JSON.stringify(document)).not.toMatch(HOLDER_ID);
			for (const key of Object.keys(document.series))
				expect(key).not.toMatch(HOLDER_ID);
		});

	test("the committed report names no holder", () => {
		expect(readFileSync(REPORT_PATH, "utf8")).not.toMatch(HOLDER_ID);
	});
});
