/**
 * The attacker of spec v3 test 6 (rebuild a holder). The attacker knows the public menu (every tier, interval, seat
 * quantity and add-on price) and Stripe's fee formula (2.9% + 30 cents, rounded as the generator rounds it), reads only the
 * cells a document publishes, and solves for the payments that could have produced them.
 *
 * The unknowns, per period, are `n[p]`: how many payments were made at each price point `p` (a membership option, with or
 * without one add-on, or an add-on alone). Every published cell is an equation over them:
 *
 * - `gross_collected`, `revenue_by_kind:*`, `revenue_by_tier:*`, `stripe_fees` and `payments_count` for the period;
 * - `paying_members` as a lower bound on the membership payments (a holder pays at least once);
 * - the one-period change of a cumulative `closing_balance_usd:` cell (a published closing balance gives that period's
 *   movement when the period before it is published too, or is the first); a ledger opens at zero.
 *
 * `payFits` is exact: a price point fits when some non-negative integer `n` satisfies every equation and has `n[p] >= 1`.
 * It runs a dynamic program over the price points whose states are the partial sums of the published rows (pruned at the
 * published value, because every coefficient is non-negative), and carries on each state the set of price points used by
 * some path to it, so one pass answers every price point. The search is bounded by `MAX_STATES` (it throws rather than
 * answer from a partial search) and by `payments <= holders * months in the period`, the headcount the attacker is given.
 *
 * Refund and dispute cells live apart from payments (a refund can be partial and can land a month after its payment), so
 * `refundFits` answers the one question the single-refund preset asks: which amounts could the refunding holder have
 * been refunded.
 *
 * Simplifications that only weaken the attacker (so the fits here are an upper bound on what a smarter one is left with):
 * a hidden cell is no equation, a cell absent from the document is no equation (the attacker is not given that a tier
 * is empty), and a period that follows a hidden closing balance has no movement. Asset accounts carry payout timing and
 * are not modelled.
 */

import { BEFORE_UNIVERSITY_MENU } from "../src/scenario/school.js";
import type { Cell, SuppressedDocument } from "../src/scenario/suppress.js";

export const STRIPE_FEE_PERCENT = 2.9;
export const STRIPE_FEE_FIXED_CENTS = 30;
/** Search bound: the number of distinct partial sums the solver may hold at once. */
export const MAX_STATES = 4_000_000;

/** Stripe's fee on a payment, as the scenario generator books it. */
export const stripeFee = (paid: number): number =>
	paid > 0
		? Math.min(
				paid,
				Math.round((paid * STRIPE_FEE_PERCENT) / 100) + STRIPE_FEE_FIXED_CENTS,
			)
		: 0;

export type PricePoint = {
	key: string;
	/** The tier whose income account books the payment; null for an add-on alone. */
	tier: string | null;
	/** The membership's billing interval; null for an add-on alone. */
	interval: "month" | "year" | null;
	membership: number;
	addon: number;
	/** What the payment moves (membership and add-on). */
	total: number;
	fee: number;
};

/** Every payment the public menu allows: a membership option with none or one add-on, and each add-on alone. */
export const pricePoints = (): PricePoint[] => {
	const points = new Map<string, PricePoint>();
	const add = (
		tier: string | null,
		interval: "month" | "year" | null,
		membership: number,
		addon: number,
	) => {
		const key = `${tier ?? "addon"}:${membership}+${addon}`;
		const total = membership + addon;
		points.set(key, {
			key,
			tier,
			interval,
			membership,
			addon,
			total,
			fee: stripeFee(total),
		});
	};
	for (const tier of BEFORE_UNIVERSITY_MENU.tiers)
		for (const price of tier.prices)
			for (const quantity of tier.quantities ?? [1]) {
				const membership = price.amount * quantity;
				add(tier.id, price.interval, membership, 0);
				for (const addon of BEFORE_UNIVERSITY_MENU.addons)
					if (
						addon.price.every === "once" ||
						addon.price.every === price.interval
					)
						add(tier.id, price.interval, membership, addon.price.amount);
			}
	for (const addon of BEFORE_UNIVERSITY_MENU.addons)
		add(null, null, 0, addon.price.amount);
	return [...points.values()];
};

export type Equation = {
	label: string;
	/** The equation's coefficient for each price point, in `pricePoints()` order. */
	coefficients: number[];
	lower: number;
	upper: number;
};

export type SolveInput = {
	points: PricePoint[];
	equations: Equation[];
};

export type Solution = {
	/** False when no payments fit every equation (the model and the document disagree). */
	feasible: boolean;
	/** The price point keys that appear in at least one fitting solution. */
	fits: string[];
	states: number;
};

type State = { vector: number[]; used: bigint };

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** The equation divided by the gcd of its coefficients; null when no whole number can meet its bounds. */
const reduced = (equation: Equation): Equation | null => {
	const divisor = equation.coefficients.reduce((n, c) => gcd(n, c), 0);
	if (divisor <= 1) return equation;
	const lower = Math.ceil(equation.lower / divisor);
	const upper = Math.floor(equation.upper / divisor);
	if (lower > upper) return null;
	return {
		...equation,
		coefficients: equation.coefficients.map((c) => c / divisor),
		lower,
		upper,
	};
};

const NOTHING: Solution = { feasible: false, fits: [], states: 0 };

export const solve = (input: SolveInput): Solution => {
	const { points } = input;
	const equations: Equation[] = [];
	for (const equation of input.equations) {
		const smaller = reduced(equation);
		if (!smaller) return NOTHING;
		equations.push(smaller);
	}
	// An equation is settled once the last price point it touches has been added: its dimension is checked and dropped,
	// so the state holds only the sums still open (a tier's money while that tier is added, the totals throughout).
	const settledAfter = equations.map((equation) =>
		equation.coefficients.reduce((last, c, i) => (c > 0 ? i : last), -1),
	);
	for (const [i, equation] of equations.entries())
		if (settledAfter[i] === -1 && (equation.lower > 0 || equation.upper < 0))
			return NOTHING;
	const upper = equations.map((equation) => equation.upper);
	let states = new Map<string, State>();
	const origin: State = { vector: equations.map(() => 0), used: 0n };
	states.set(origin.vector.join(","), origin);
	let peak = 1;
	for (const [index, point] of points.entries()) {
		void point;
		const bit = 1n << BigInt(index);
		const step = equations.map(
			(equation) => equation.coefficients[index] as number,
		);
		const queue = [...states.values()];
		while (queue.length > 0) {
			const state = queue.pop() as State;
			const next = state.vector.map((value, i) => value + (step[i] as number));
			if (next.some((value, i) => value > (upper[i] as number))) continue;
			const key = next.join(",");
			const existing = states.get(key);
			const used = state.used | bit;
			if (!existing) {
				const created: State = { vector: next, used };
				states.set(key, created);
				queue.push(created);
				if (states.size > MAX_STATES)
					throw new Error(
						`solver passed ${MAX_STATES} states; raise MAX_STATES or tighten the model`,
					);
			} else if ((existing.used | used) !== existing.used) {
				existing.used |= used;
				queue.push(existing);
			}
		}
		peak = Math.max(peak, states.size);
		const settling = equations
			.map((_, i) => i)
			.filter((i) => settledAfter[i] === index);
		if (settling.length > 0) {
			const kept = new Map<string, State>();
			for (const state of states.values()) {
				const meets = settling.every(
					(i) =>
						(state.vector[i] as number) >= (equations[i] as Equation).lower &&
						(state.vector[i] as number) <= (equations[i] as Equation).upper,
				);
				if (!meets) continue;
				const vector = state.vector.map((value, i) =>
					settling.includes(i) ? 0 : value,
				);
				const key = vector.join(",");
				const merged = kept.get(key);
				if (merged) merged.used |= state.used;
				else kept.set(key, { vector, used: state.used });
			}
			states = kept;
			if (states.size === 0) return { ...NOTHING, states: peak };
		}
	}
	let used = 0n;
	for (const state of states.values()) used |= state.used;
	return {
		feasible: states.size > 0,
		fits: points
			.filter((_, index) => (used >> BigInt(index)) & 1n)
			.map((point) => point.key),
		states: peak,
	};
};

/** A document as the attacker reads it: periods and cells. */
export type PublishedDocument = Pick<SuppressedDocument, "periods" | "series">;

const cellAt = (
	document: PublishedDocument,
	kpiId: string,
	index: number,
): Cell | undefined => document.series[kpiId]?.[index];

/** The movement of a cumulative cell over one period; undefined when it cannot be told. */
const movement = (
	document: PublishedDocument,
	kpiId: string,
	index: number,
): number | undefined => {
	const closing = cellAt(document, kpiId, index);
	if (closing === undefined || closing === null) return undefined;
	if (index === 0) return closing;
	const opening = cellAt(document, kpiId, index - 1);
	if (opening === undefined || opening === null) return undefined;
	return closing - opening;
};

const TIER_CLOSING = /^closing_balance_usd:income:billing:membership:(.+)$/;
const FEE_CLOSING = "closing_balance_usd:expenses:billing:stripe-fees";

export type Headcount = { payers: number; monthsInPeriod: number };

/** Every equation the published cells of one period give over the price points. */
export const paymentEquations = ({
	document,
	index,
	points,
	headcount,
}: {
	document: PublishedDocument;
	index: number;
	points: PricePoint[];
	headcount: Headcount;
}): Equation[] => {
	const equations: Equation[] = [];
	const exact = (
		label: string,
		value: number | null | undefined,
		coefficient: (point: PricePoint) => number,
	) => {
		if (value === undefined || value === null) return;
		equations.push({
			label,
			coefficients: points.map(coefficient),
			lower: value,
			upper: value,
		});
	};
	const tierMoney = (tier: string) => (point: PricePoint) =>
		point.tier === tier ? point.total : 0;

	exact(
		"gross_collected",
		cellAt(document, "gross_collected", index),
		(p) => p.total,
	);
	exact(
		"revenue_by_kind:membership",
		cellAt(document, "revenue_by_kind:membership", index),
		(p) => (p.tier === null ? 0 : p.total),
	);
	exact(
		"revenue_by_kind:addon",
		cellAt(document, "revenue_by_kind:addon", index),
		(p) => (p.tier === null ? p.total : 0),
	);
	exact("stripe_fees", cellAt(document, "stripe_fees", index), (p) => p.fee);
	for (const kpiId of Object.keys(document.series)) {
		const tier = /^revenue_by_tier:(.+)$/.exec(kpiId)?.[1];
		if (tier) exact(kpiId, cellAt(document, kpiId, index), tierMoney(tier));
		const closingTier = TIER_CLOSING.exec(kpiId)?.[1];
		if (closingTier) {
			const change = movement(document, kpiId, index);
			// an income account closes negative: its movement is minus the revenue
			exact(
				kpiId,
				change === undefined ? undefined : -change,
				tierMoney(closingTier),
			);
		}
	}
	exact(FEE_CLOSING, movement(document, FEE_CLOSING, index), (p) => p.fee);

	// the count of payments: published, else bounded by the headcount
	const published = cellAt(document, "payments_count", index);
	const paymentBound = headcount.payers * headcount.monthsInPeriod;
	equations.push({
		label: "payments_count",
		coefficients: points.map(() => 1),
		lower: published ?? 0,
		upper: published ?? paymentBound,
	});
	const payingMembers = cellAt(document, "paying_members", index);
	if (payingMembers !== undefined && payingMembers !== null)
		equations.push({
			label: "paying_members",
			coefficients: points.map((p) => (p.tier === null ? 0 : 1)),
			lower: payingMembers,
			upper: paymentBound,
		});
	return equations;
};

/** The equations a given payment mix satisfies; empty when it fits all of them (for checking the model). */
export const violations = ({
	equations,
	points,
	counts,
}: {
	equations: Equation[];
	points: PricePoint[];
	counts: ReadonlyMap<string, number>;
}): string[] =>
	equations.flatMap((equation) => {
		const value = points.reduce(
			(sum, point, i) =>
				sum +
				(counts.get(point.key) ?? 0) * (equation.coefficients[i] as number),
			0,
		);
		return value >= equation.lower && value <= equation.upper
			? []
			: [
					`${equation.label}: ${value} not in ${equation.lower}..${equation.upper}`,
				];
	});

/**
 * The refund amounts, in cents, the refunded holder could have been paid, given the period's refund cells: the refund
 * count and amount, and the movement of the refunds account. Each refund is between 1 cent and the dearest payment.
 */
export const refundFits = ({
	document,
	index,
	largestPayment,
}: {
	document: PublishedDocument;
	index: number;
	largestPayment: number;
}): number => {
	const count = cellAt(document, "refunds_count", index);
	const published = cellAt(document, "refunds", index);
	const account = movement(
		document,
		"closing_balance_usd:income:billing:refunds",
		index,
	);
	const total = published ?? account;
	let fits = 0;
	for (let amount = 1; amount <= largestPayment; amount++) {
		if (total !== undefined && total !== null) {
			// the other refunds are what is left of the total
			const others = total - amount;
			if (others < 0) continue;
			if (count !== undefined && count !== null) {
				const remaining = count - 1;
				if (others < remaining || others > remaining * largestPayment) continue;
			}
		}
		fits += 1;
	}
	return fits;
};
