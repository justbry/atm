/**
 * The finance read models: the books side of a school's money, built from the event log and kept apart from the month
 * and member views under `views/finance/`, so a reader that may not see books data never reads this prefix.
 *
 * - `views/finance/months/YYYY-MM.json` (`FinanceMonthObject`): the month's money (gross, refunded, fees, net, disputes,
 *   payouts), income by account and by plan, fundraising by campaign, and a `days` breakdown of the profit-and-loss
 *   accounts, which is what lets an income statement cover any range of days from month objects alone.
 * - `views/finance/members/<hash>.json` (`FinanceMemberObject`): one holder's payments, refunds and last payment. The
 *   object name is `memberViewName(school, key)`, the same hash as the member summary's. The body holds the holder key
 *   (`family:<id>`), a Stripe payment, invoice or refund id, dates and cents. Never a name, an email, a billing field or a
 *   Stripe customer id: the events' personal fields are not read.
 *
 * `incomeStatement` and `membersIncome` are TypeScript over those objects: a Worker cannot run hledger. They equal what
 * `hledger is` prints from the same events (`tests/finance-statement.test.ts` compares them over the fifteen presets).
 *
 * Pure and Worker-safe: no `node:fs`, no Ajv, no hledger. USD only, as the journals are: a `money.skipped` event is
 * counted (`skippedNonUsd`) and nothing more.
 */
import type { AtmEvent } from "../types.js";
import { byText } from "./order.js";
import { MONEY_COMMODITY } from "./postings.js";
import { decimalToUnits } from "./util.js";

const MONEY_DECIMALS = 2;
const BILLING_INCOME = "income:billing:";
const MEMBERSHIP_INCOME = "income:billing:membership:";
const BOOKING_INCOME = "income:billing:booking";
const FUNDRAISING_INCOME = "income:fundraising:";
const REFUNDS_ACCOUNT = "income:billing:refunds";
const FEES_ACCOUNT = "expenses:billing:stripe-fees";
const DISPUTES_ACCOUNT = "expenses:billing:disputes";
const DISPUTE_FEES_ACCOUNT = "expenses:billing:dispute-fees";
const STRIPE_PAYOUTS_ACCOUNT = "assets:clearing:stripe-payouts";
const ZEFFY_PAYOUTS_ACCOUNT = "assets:clearing:zeffy-payouts";
const FAMILY_KEY = /^family:/;
const DAY_MS = 86_400_000;

/** What happened on one local day, in the profit-and-loss accounts only. */
export type FinanceDay = {
	/** Cents posted to each `income:*` and `expenses:*` account, as posted: a credit (income) is negative. Accounts that net to 0 are left out. */
	accounts: Record<string, number>;
	/** Cents paid out of Stripe: the postings to `assets:clearing:stripe-payouts` (a failed payout takes its amount off again). */
	payoutCents: number;
	counts: FinanceCounts;
};

export type FinanceCounts = {
	/** `payment.succeeded` events. */
	payments: number;
	/** `payment.refunded` events. */
	refunds: number;
	/** `payment.disputed` events. */
	disputes: number;
	/** `payout.paid` events that were not a failed payout's reversal. */
	payouts: number;
};

/** The month's money in cents. */
export type FinanceMoney = {
	/** Cash taken before fees: the credits to `income:billing:*` other than refunds. */
	grossCents: number;
	/** Cash given back: the postings to `income:billing:refunds`. */
	refundedCents: number;
	/** Stripe's fees: the postings to `expenses:billing:stripe-fees`. */
	feeCents: number;
	/** `grossCents - refundedCents - feeCents`. Disputes are not in it: they are their own lines. */
	netCents: number;
	/** The postings to `expenses:billing:disputes`: money Stripe withdrew for disputes, less what won disputes returned. */
	disputeCents: number;
	/** The postings to `expenses:billing:dispute-fees`. */
	disputeFeeCents: number;
	/** Cents paid out of Stripe in the month. */
	payoutCents: number;
};

/** What one Zeffy campaign received; a payout names no campaign, so paid out is a total (`fundraising.paidOutCents`). */
export type FundraisingCampaign = { receivedCents: number };

/** A finance month object: the month's books data. Every figure is in cents. */
export type FinanceMonthObject = {
	school: string;
	month: string;
	money: FinanceMoney;
	counts: FinanceCounts;
	/** `money.skipped` events for a currency other than USD: money the books left out. */
	skippedNonUsd: number;
	income: {
		/** Revenue by `income:billing:*` account (refunds excluded), positive. */
		byAccount: Record<string, number>;
		/** Revenue by plan: the `income:billing:membership:<plan>` accounts, keyed by `<plan>`. */
		byPlan: Record<string, number>;
		/**
		 * The plan ids in the order of the latest `catalog.published` menu's tiers (every tier, paid or not, then any paid plan
		 * the menu lacks, by name); absent when the log has no readable catalog event. A JSON object has no order, so this is
		 * the order `byPlan` cannot carry.
		 */
		planOrder?: string[];
	};
	/**
	 * Gross collected on each day of the month, in cents: index 0 is the 1st, and the array is as long as the month. The
	 * `payment.succeeded` credits to `income:billing:*` by the event's local date, so its sum is `money.grossCents` and
	 * each day is what the `gross_collected` KPI counts for it.
	 */
	grossByDay: number[];
	fundraising: {
		/** Received by campaign (`income:fundraising:<campaign>`). */
		byCampaign: Record<string, FundraisingCampaign>;
		receivedCents: number;
		/** Cents Zeffy paid out (`fundraise.paid_out`), all campaigns together. */
		paidOutCents: number;
	};
	/** By `YYYY-MM-DD`, the school's local day. */
	days: Record<string, FinanceDay>;
};

/** One payment: `payment.succeeded`. */
export type FinancePayment = {
	/** The school's local day. */
	date: string;
	eventId: string;
	/** The payload's `id`: an invoice (`in_...`) or, for a booking's payment, its payment intent. */
	id: string;
	paymentIntent: string | null;
	booking: string | null;
	/** The income account after `income:billing:`, e.g. `membership:sparkle-2` or `booking`; null when the event has none. */
	incomeKind: string | null;
	amountCents: number;
	feeCents: number;
};

/** One refund: `payment.refunded`. */
export type FinanceRefund = {
	date: string;
	eventId: string;
	/** The payload's `id`: a refund (`re_...`) or the Stripe event that reported it. */
	id: string;
	paymentIntent: string | null;
	invoice: string | null;
	booking: string | null;
	amountCents: number;
};

/** A finance member object. */
export type FinanceMemberObject = {
	school: string;
	/** The holder, e.g. `family:fam_8k2`. */
	key: string;
	/** Oldest first. */
	payments: FinancePayment[];
	/** Oldest first. */
	refunds: FinanceRefund[];
	/** The newest payment (by event id); null when the holder has none. */
	lastPayment: { date: string; amountCents: number } | null;
	paidCents: number;
	refundedCents: number;
};

/** A finance month without the school and month its object adds (as `MonthView` is to `MonthObject`). */
export type FinanceMonthView = Omit<FinanceMonthObject, "school" | "month">;

export type FinanceViews = {
	/** By `YYYY-MM`, ascending. Only months with a USD posting or a non-USD skip. */
	months: Record<string, FinanceMonthView>;
	/** By holder key. Only holders with a payment or a refund. */
	members: Record<string, Omit<FinanceMemberObject, "school">>;
};

const sortedRecord = <Value>(record: Record<string, Value>) =>
	Object.fromEntries(Object.entries(record).sort(([a], [b]) => byText(a, b)));

const cents = (amount: string): number =>
	Number(decimalToUnits(amount, MONEY_DECIMALS));

const isProfitAndLoss = (account: string): boolean =>
	account.startsWith("income:") || account.startsWith("expenses:");

const textOf = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

type MonthAccumulator = {
	days: Map<string, FinanceDay>;
	/** Gross collected by local day: the `payment.succeeded` credits to `income:billing:*`, as the `gross_collected` KPI counts them. */
	gross: Map<string, number>;
	skippedNonUsd: number;
	hasUsd: boolean;
};

const emptyCounts = (): FinanceCounts => ({
	payments: 0,
	refunds: 0,
	disputes: 0,
	payouts: 0,
});

const dayOf = (month: MonthAccumulator, date: string): FinanceDay => {
	let day = month.days.get(date);
	if (!day) {
		day = { accounts: {}, payoutCents: 0, counts: emptyCounts() };
		month.days.set(date, day);
	}
	return day;
};

const countEvent = (day: FinanceDay, event: AtmEvent): void => {
	if (event.event_type === "payment.succeeded") day.counts.payments += 1;
	else if (event.event_type === "payment.refunded") day.counts.refunds += 1;
	else if (event.event_type === "payment.disputed") day.counts.disputes += 1;
	else if (event.event_type === "payout.paid" && event.payload.failed !== true)
		day.counts.payouts += 1;
};

const accumulateMonth = (
	months: Map<string, MonthAccumulator>,
	event: AtmEvent,
): void => {
	const isSkip =
		event.event_type === "money.skipped" && event.payload.reason === "non_usd";
	const usd = event.postings.filter(
		(posting) => posting.commodity === MONEY_COMMODITY,
	);
	if (!isSkip && usd.length === 0) return;
	const month = event.date.slice(0, 7);
	let accumulator = months.get(month);
	if (!accumulator) {
		accumulator = {
			days: new Map(),
			gross: new Map(),
			skippedNonUsd: 0,
			hasUsd: false,
		};
		months.set(month, accumulator);
	}
	if (isSkip) accumulator.skippedNonUsd += 1;
	if (usd.length === 0) return;
	accumulator.hasUsd = true;
	const day = dayOf(accumulator, event.date);
	countEvent(day, event);
	if (event.event_type === "payment.succeeded")
		for (const posting of usd)
			if (posting.account.startsWith(BILLING_INCOME))
				accumulator.gross.set(
					event.date,
					(accumulator.gross.get(event.date) ?? 0) - cents(posting.amount),
				);
	for (const posting of usd) {
		const value = cents(posting.amount);
		if (isProfitAndLoss(posting.account))
			day.accounts[posting.account] =
				(day.accounts[posting.account] ?? 0) + value;
		else if (posting.account === STRIPE_PAYOUTS_ACCOUNT)
			day.payoutCents += value;
	}
};

/** The sum of a day's postings to the accounts `matches` selects, in the sign they were posted. */
const postedTo = (
	accounts: Record<string, number>,
	matches: (account: string) => boolean,
): number => {
	let total = 0;
	for (const [account, value] of Object.entries(accounts))
		if (matches(account)) total += value;
	return total;
};

/** Gross collected on each day of the month, the first day first (index 0 is the 1st); 0 for a day with no payment. */
const grossByDay = (month: string, gross: Map<string, number>): number[] => {
	const count = new Date(
		Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
	).getUTCDate();
	return Array.from(
		{ length: count },
		(_, day) => gross.get(`${month}-${String(day + 1).padStart(2, "0")}`) ?? 0,
	);
};

/** The menu's plans in the menu's order, then any plan paid in the month that the menu does not list, by name. */
const orderedPlans = (
	byPlan: Record<string, number>,
	order: readonly string[],
): string[] => [
	...order,
	...Object.keys(byPlan)
		.filter((plan) => !order.includes(plan))
		.sort(byText),
];

/** The tier ids of the latest `catalog.published` menu, in the menu's order; null when the log has none (or none readable). */
const planOrderOf = (events: readonly AtmEvent[]): string[] | null => {
	let latest: AtmEvent | null = null;
	for (const event of events)
		if (
			event.event_type === "catalog.published" &&
			(latest === null || byText(latest.id, event.id) < 0)
		)
			latest = event;
	const tiers = (latest?.payload.menu as { tiers?: unknown } | undefined)
		?.tiers;
	if (!Array.isArray(tiers)) return null;
	const ids = tiers
		.map((tier) => (tier as { id?: unknown } | null)?.id)
		.filter((id): id is string => typeof id === "string");
	return [...new Set(ids)];
};

const finishMonth = (
	month: string,
	accumulator: MonthAccumulator,
	paidOutByMonth: Map<string, number>,
	planOrder: readonly string[] | null,
): FinanceMonthView => {
	const accounts: Record<string, number> = {};
	const counts = emptyCounts();
	let payoutCents = 0;
	for (const day of accumulator.days.values()) {
		for (const [account, value] of Object.entries(day.accounts))
			accounts[account] = (accounts[account] ?? 0) + value;
		payoutCents += day.payoutCents;
		counts.payments += day.counts.payments;
		counts.refunds += day.counts.refunds;
		counts.disputes += day.counts.disputes;
		counts.payouts += day.counts.payouts;
	}
	const byAccount: Record<string, number> = {};
	const byPlan: Record<string, number> = {};
	const byCampaign: Record<string, FundraisingCampaign> = {};
	let receivedCents = 0;
	for (const [account, value] of Object.entries(accounts)) {
		if (value === 0) continue;
		if (account.startsWith(FUNDRAISING_INCOME)) {
			byCampaign[account.slice(FUNDRAISING_INCOME.length)] = {
				receivedCents: -value,
			};
			receivedCents -= value;
		} else if (
			account.startsWith(BILLING_INCOME) &&
			account !== REFUNDS_ACCOUNT
		) {
			byAccount[account] = -value;
			if (account.startsWith(MEMBERSHIP_INCOME))
				byPlan[account.slice(MEMBERSHIP_INCOME.length)] = -value;
		}
	}
	const grossCents = Object.values(byAccount).reduce((sum, n) => sum + n, 0);
	const refundedCents = accounts[REFUNDS_ACCOUNT] ?? 0;
	const feeCents = accounts[FEES_ACCOUNT] ?? 0;
	const days = Object.fromEntries(
		[...accumulator.days]
			.sort(([a], [b]) => byText(a, b))
			.map(([date, day]) => [
				date,
				{
					accounts: sortedRecord(
						Object.fromEntries(
							Object.entries(day.accounts).filter(([, value]) => value !== 0),
						),
					),
					payoutCents: day.payoutCents,
					counts: day.counts,
				},
			]),
	);
	return {
		money: {
			grossCents,
			refundedCents,
			feeCents,
			netCents: grossCents - refundedCents - feeCents,
			disputeCents: accounts[DISPUTES_ACCOUNT] ?? 0,
			disputeFeeCents: accounts[DISPUTE_FEES_ACCOUNT] ?? 0,
			payoutCents,
		},
		counts,
		skippedNonUsd: accumulator.skippedNonUsd,
		income: {
			byAccount: sortedRecord(byAccount),
			byPlan: sortedRecord(byPlan),
			...(planOrder === null
				? {}
				: { planOrder: orderedPlans(byPlan, planOrder) }),
		},
		grossByDay: grossByDay(month, accumulator.gross),
		fundraising: {
			byCampaign: sortedRecord(byCampaign),
			receivedCents,
			paidOutCents: paidOutByMonth.get(month) ?? 0,
		},
		days,
	};
};

const paymentOf = (event: AtmEvent): FinancePayment => {
	const income = event.postings.find((posting) =>
		posting.account.startsWith(BILLING_INCOME),
	);
	const fee = event.postings.find(
		(posting) => posting.account === FEES_ACCOUNT,
	);
	return {
		date: event.date,
		eventId: event.id,
		id: textOf(event.payload.id) ?? event.id,
		paymentIntent: textOf(event.payload.payment_intent),
		booking: textOf(event.payload.booking),
		incomeKind: income ? income.account.slice(BILLING_INCOME.length) : null,
		amountCents: income ? -cents(income.amount) : 0,
		feeCents: fee ? cents(fee.amount) : 0,
	};
};

const refundOf = (event: AtmEvent): FinanceRefund => {
	const refunds = event.postings.find(
		(posting) => posting.account === REFUNDS_ACCOUNT,
	);
	return {
		date: event.date,
		eventId: event.id,
		id: textOf(event.payload.id) ?? event.id,
		paymentIntent: textOf(event.payload.payment_intent),
		invoice: textOf(event.payload.invoice),
		booking: textOf(event.payload.booking),
		amountCents: refunds ? cents(refunds.amount) : 0,
	};
};

const byEventIdOf = (a: { eventId: string }, b: { eventId: string }) =>
	byText(a.eventId, b.eventId);

const buildMembers = (events: readonly AtmEvent[]): FinanceViews["members"] => {
	const members = new Map<
		string,
		{ payments: FinancePayment[]; refunds: FinanceRefund[] }
	>();
	const memberOf = (key: string) => {
		let member = members.get(key);
		if (!member) {
			member = { payments: [], refunds: [] };
			members.set(key, member);
		}
		return member;
	};
	for (const event of events) {
		if (!FAMILY_KEY.test(event.key)) continue;
		if (event.event_type === "payment.succeeded")
			memberOf(event.key).payments.push(paymentOf(event));
		else if (event.event_type === "payment.refunded")
			memberOf(event.key).refunds.push(refundOf(event));
	}
	return Object.fromEntries(
		[...members]
			.sort(([a], [b]) => byText(a, b))
			.map(([key, member]) => {
				const payments = member.payments.sort(byEventIdOf);
				const refunds = member.refunds.sort(byEventIdOf);
				const last = payments.at(-1);
				return [
					key,
					{
						key,
						payments,
						refunds,
						lastPayment: last
							? { date: last.date, amountCents: last.amountCents }
							: null,
						paidCents: payments.reduce((sum, p) => sum + p.amountCents, 0),
						refundedCents: refunds.reduce((sum, r) => sum + r.amountCents, 0),
					},
				];
			}),
	);
};

/**
 * The finance months and members of a log. Pass the events of one cut of the log (`buildViews` gives it the events up to
 * `asOf`), so the finance objects describe the same cut as the month and member views.
 */
export const buildFinance = (events: readonly AtmEvent[]): FinanceViews => {
	const months = new Map<string, MonthAccumulator>();
	const paidOutByMonth = new Map<string, number>();
	const planOrder = planOrderOf(events);
	for (const event of events) {
		accumulateMonth(months, event);
		if (event.event_type !== "fundraise.paid_out") continue;
		const month = event.date.slice(0, 7);
		const paidOut = event.postings
			.filter((posting) => posting.account === ZEFFY_PAYOUTS_ACCOUNT)
			.reduce((sum, posting) => sum + cents(posting.amount), 0);
		paidOutByMonth.set(month, (paidOutByMonth.get(month) ?? 0) + paidOut);
	}
	// a month whose only money is a Zeffy payout still needs an object: its postings are on balance-sheet accounts
	for (const month of paidOutByMonth.keys())
		if (!months.has(month))
			months.set(month, {
				days: new Map(),
				gross: new Map(),
				skippedNonUsd: 0,
				hasUsd: true,
			});
	return {
		months: Object.fromEntries(
			[...months]
				.filter(
					([, accumulator]) =>
						accumulator.hasUsd || accumulator.skippedNonUsd > 0,
				)
				.sort(([a], [b]) => byText(a, b))
				.map(([month, accumulator]) => [
					month,
					finishMonth(month, accumulator, paidOutByMonth, planOrder),
				]),
		),
		members: buildMembers(events),
	};
};

// ---------------------------------------------------------------------------------------------------------------
// The income statement.
// ---------------------------------------------------------------------------------------------------------------

/** One account of the statement: `cents` is positive for revenue in `income` and for cost in `expenses`. */
export type StatementLine = { account: string; cents: number };

/**
 * The statement's figures in cents, signed as a statement shows them: revenue is positive, refunds, fees, disputes and
 * other expenses are negative, and `net` is their sum.
 */
export type StatementFigures = {
	/** `income:billing:membership:*`. */
	memberships: number;
	/** `income:billing:booking`. */
	bookings: number;
	/** The rest of the revenue accounts other than refunds: add-ons and unclassified payments. */
	otherIncome: number;
	/** `income:fundraising:*`. */
	fundraising: number;
	/** Every revenue account other than refunds: memberships, bookings, other income and fundraising. */
	income: number;
	/** `income:billing:refunds`, negative. */
	refunds: number;
	/** `expenses:billing:stripe-fees`, negative. */
	fees: number;
	/** `expenses:billing:disputes` and `expenses:billing:dispute-fees`, negative. */
	disputes: number;
	/** Every other `expenses:*` account (the B4 Uni share), negative. */
	otherExpenses: number;
	/** `income + refunds + fees + disputes + otherExpenses`: what `hledger is` prints as its net. */
	net: number;
	/** Cents paid out of Stripe in the range. Not a profit-and-loss figure: it moves cash between balance-sheet accounts. */
	paidOut: number;
};

export type StatementPeriod = {
	from: string;
	to: string;
	/** Every revenue account with a balance in the range, `income:billing:refunds` included (negative), by account. */
	income: StatementLine[];
	/** Every expense account with a balance in the range, by account. */
	expenses: StatementLine[];
	figures: StatementFigures;
	counts: FinanceCounts;
};

export type IncomeStatementResult = StatementPeriod & {
	/** The period of the same length that ends the day before `from`; null unless `compare`. */
	previous:
		| (StatementPeriod & {
				/** Each figure of this period less the same figure of the previous one. */
				changes: StatementFigures;
		  })
		| null;
};

/** `YYYY-MM-DD` shifted by `days`, by the calendar (no time zone: these are the school's local days). */
const shiftDay = (date: string, days: number): string =>
	new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
		.toISOString()
		.slice(0, 10);

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const checkRange = (from: string, to: string): void => {
	for (const [name, value] of [
		["from", from],
		["to", to],
	] as const)
		if (!DAY_PATTERN.test(value) || Number.isNaN(Date.parse(value)))
			throw new Error(`${name} ${JSON.stringify(value)} is not YYYY-MM-DD`);
	if (from > to)
		throw new Error(`from ${from} is after to ${to}: the range is empty`);
};

/** The period of the same length as `from`..`to` that ends the day before `from`. */
export const previousPeriod = (
	from: string,
	to: string,
): { from: string; to: string } => {
	checkRange(from, to);
	const length =
		Math.round(
			(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
				DAY_MS,
		) + 1;
	const previousTo = shiftDay(from, -1);
	return { from: shiftDay(previousTo, -(length - 1)), to: previousTo };
};

const monthsBetween = (from: string, to: string): string[] => {
	const months: string[] = [];
	let year = Number(from.slice(0, 4));
	let month = Number(from.slice(5, 7));
	const last = to.slice(0, 7);
	for (;;) {
		const name = `${year}-${String(month).padStart(2, "0")}`;
		months.push(name);
		if (name >= last) return months;
		month += 1;
		if (month > 12) {
			month = 1;
			year += 1;
		}
	}
};

/**
 * The `YYYY-MM` months that the days `from`..`to` touch, and so the finance month objects a statement needs: with
 * `compare`, also those of `previousPeriod(from, to)`. Ascending.
 */
export const financeMonthsFor = (
	from: string,
	to: string,
	compare = false,
): string[] => {
	checkRange(from, to);
	const months = monthsBetween(from, to);
	if (!compare) return months;
	const previous = previousPeriod(from, to);
	return [
		...new Set([...monthsBetween(previous.from, previous.to), ...months]),
	];
};

type PeriodTotals = {
	accounts: Map<string, number>;
	payoutCents: number;
	counts: FinanceCounts;
};

const totalsOf = (
	months: readonly Pick<FinanceMonthObject, "days">[],
	from: string,
	to: string,
): PeriodTotals => {
	const totals: PeriodTotals = {
		accounts: new Map(),
		payoutCents: 0,
		counts: emptyCounts(),
	};
	for (const month of months)
		for (const [date, day] of Object.entries(month.days)) {
			if (date < from || date > to) continue;
			for (const [account, value] of Object.entries(day.accounts))
				totals.accounts.set(
					account,
					(totals.accounts.get(account) ?? 0) + value,
				);
			totals.payoutCents += day.payoutCents;
			totals.counts.payments += day.counts.payments;
			totals.counts.refunds += day.counts.refunds;
			totals.counts.disputes += day.counts.disputes;
			totals.counts.payouts += day.counts.payouts;
		}
	return totals;
};

/** `0 - n`, not `-n`: a statement never shows `-0`. */
const negate = (n: number): number => 0 - n;

const figuresOf = (totals: PeriodTotals): StatementFigures => {
	const accounts = Object.fromEntries(totals.accounts);
	const revenue = (matches: (account: string) => boolean) =>
		negate(postedTo(accounts, matches));
	const memberships = revenue((a) => a.startsWith(MEMBERSHIP_INCOME));
	const bookings = revenue((a) => a.startsWith(BOOKING_INCOME));
	const fundraising = revenue((a) => a.startsWith(FUNDRAISING_INCOME));
	const income = revenue(
		(a) => a.startsWith("income:") && a !== REFUNDS_ACCOUNT,
	);
	const refunds = negate(accounts[REFUNDS_ACCOUNT] ?? 0);
	const fees = negate(accounts[FEES_ACCOUNT] ?? 0);
	const disputes = negate(
		(accounts[DISPUTES_ACCOUNT] ?? 0) + (accounts[DISPUTE_FEES_ACCOUNT] ?? 0),
	);
	const otherExpenses = negate(
		postedTo(
			accounts,
			(a) =>
				a.startsWith("expenses:") &&
				a !== FEES_ACCOUNT &&
				a !== DISPUTES_ACCOUNT &&
				a !== DISPUTE_FEES_ACCOUNT,
		),
	);
	return {
		memberships,
		bookings,
		otherIncome: income - memberships - bookings - fundraising,
		fundraising,
		income,
		refunds,
		fees,
		disputes,
		otherExpenses,
		net: income + refunds + fees + disputes + otherExpenses,
		paidOut: totals.payoutCents,
	};
};

const linesOf = (
	totals: PeriodTotals,
	root: "income:" | "expenses:",
): StatementLine[] =>
	[...totals.accounts]
		.filter(([account, value]) => account.startsWith(root) && value !== 0)
		.map(([account, value]) => ({
			account,
			cents: root === "income:" ? -value : value,
		}))
		.sort((a, b) => byText(a.account, b.account));

const periodOf = (
	months: readonly Pick<FinanceMonthObject, "days">[],
	from: string,
	to: string,
): StatementPeriod => {
	const totals = totalsOf(months, from, to);
	return {
		from,
		to,
		income: linesOf(totals, "income:"),
		expenses: linesOf(totals, "expenses:"),
		figures: figuresOf(totals),
		counts: totals.counts,
	};
};

const FIGURE_NAMES = [
	"memberships",
	"bookings",
	"otherIncome",
	"fundraising",
	"income",
	"refunds",
	"fees",
	"disputes",
	"otherExpenses",
	"net",
	"paidOut",
] as const satisfies readonly (keyof StatementFigures)[];

const changesOf = (
	current: StatementFigures,
	previous: StatementFigures,
): StatementFigures => {
	const changes = { ...current };
	for (const name of FIGURE_NAMES)
		changes[name] = current[name] - previous[name];
	return changes;
};

/**
 * The income statement for the days `from`..`to` (inclusive, the school's local days) from finance month objects. The
 * objects must cover `financeMonthsFor(from, to, compare)`; a
 * day in a month not given counts as no activity. With `compare`, `previous` is the same statement for the period of the
 * same length before it, and `previous.changes` each figure of this period less that of the previous one: the server's
 * arithmetic, so a UI never subtracts.
 *
 * The lines are the profit-and-loss accounts `hledger is` prints, with their balances; `figures.net` is its net.
 */
export const incomeStatement = (
	months: readonly Pick<FinanceMonthObject, "days">[],
	{ from, to, compare }: { from: string; to: string; compare: boolean },
): IncomeStatementResult => {
	checkRange(from, to);
	const current = periodOf(months, from, to);
	if (!compare) return { ...current, previous: null };
	const range = previousPeriod(from, to);
	const previous = periodOf(months, range.from, range.to);
	return {
		...current,
		previous: {
			...previous,
			changes: changesOf(current.figures, previous.figures),
		},
	};
};

/**
 * Income from members for the days `from`..`to`: memberships plus bookings, in cents (the UI's "income": refunds, fees
 * and add-ons are not in it). From the same finance month objects as `incomeStatement`.
 */
export const membersIncome = (
	months: readonly Pick<FinanceMonthObject, "days">[],
	from: string,
	to: string,
): number => {
	checkRange(from, to);
	const { memberships, bookings } = figuresOf(totalsOf(months, from, to));
	return memberships + bookings;
};
