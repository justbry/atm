import type { Cell, KpiDocument } from "../data/kpi-document.ts";
import {
	type AudienceReport,
	type AudienceReportQuery,
	type DonorRow,
	type DonorsQuery,
	type DonorsReport,
	type IncomeSeries,
	type IncomeStatement,
	type LedgerDay,
	type LedgerDrill,
	type LedgerEntry,
	type LedgerEvent,
	type LedgerPage,
	type LedgerQuery,
	type LedgerReader,
	type LedgerTypeFilter,
	type Promo,
	type ReportCell,
	type StatementAmounts,
	seesIdentities,
	type ViewerAudience,
} from "../data/ledger.ts";
import type { Clock, School } from "../data/types.ts";
import {
	eventsBySchool,
	memberNames,
	promosBySchool,
	rulesBySchool,
	type SourceDonor,
	type SourceEvent,
	volDonors,
} from "./ledger-data.ts";

const dayMilliseconds = 86_400_000;
/** cell-rules `minContributors`: a count below this shows as `<10`. */
const smallCount = 5;
const wholeWeek = 7;
const longestDailySeries = 62;
/** The mockup's 3% of cash taken, which it invents for Stripe's fee. */
const feeRate = 0.03;

// ---- Dates, as UTC calendar days.

const toDay = (milliseconds: number): string =>
	new Date(milliseconds).toISOString().slice(0, 10);
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, days: number): string =>
	toDay(dayNumber(day) + days * dayMilliseconds);
const endOfMonth = (day: string): string => {
	const date = new Date(dayNumber(`${day.slice(0, 7)}-01`));
	date.setUTCMonth(date.getUTCMonth() + 1, 0);
	return toDay(date.getTime());
};
const addMonths = (firstOfMonth: string, months: number): string => {
	const date = new Date(dayNumber(firstOfMonth));
	date.setUTCMonth(date.getUTCMonth() + months);
	return toDay(date.getTime());
};
const monthsSpanned = (from: string, to: string): number =>
	(Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
	Number(to.slice(5, 7)) -
	Number(from.slice(5, 7)) +
	1;
const isWholeMonths = (from: string, to: string): boolean =>
	from.endsWith("-01") && endOfMonth(to) === to;
/** The period of the same length before this one (whole months step by months, other ranges by days). */
function previousPeriod(
	from: string,
	to: string,
): { from: string; to: string } {
	if (isWholeMonths(from, to)) {
		const months = monthsSpanned(from, to);
		const start = addMonths(from, -months);
		return { from: start, to: endOfMonth(addMonths(start, months - 1)) };
	}
	const days = (dayNumber(to) - dayNumber(from)) / dayMilliseconds + 1;
	return { from: addDays(from, -days), to: addDays(to, -days) };
}

/** A zone's wall time as a UTC instant (the fixtures write local times; atm writes `event_time` in UTC). */
function utcInstant(local: string, timeZone: string): string {
	const wall = Date.parse(`${local}:00Z`);
	const format = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
	const wallAt = (instant: number): number => {
		const part = Object.fromEntries(
			format.formatToParts(instant).map(({ type, value }) => [type, value]),
		);
		return Date.UTC(
			Number(part.year),
			Number(part.month) - 1,
			Number(part.day),
			Number(part.hour),
			Number(part.minute),
		);
	};
	const firstGuess = wall - (wallAt(wall) - wall);
	const instant = wall - (wallAt(firstGuess) - firstGuess);
	return `${new Date(instant).toISOString().slice(0, 16)}:00Z`;
}

// ---- The events, as atm's read slice would list them.

/** B4 Uni's Wu family shares one key; everyone else is their own family. */
const familyOf = (member: string): string =>
	["s_21", "s_25", "s_26"].includes(member) ? "fam_wu" : member;

type Row = { index: number; source: SourceEvent; entry: LedgerEntry };

function rowsOf(school: School): Row[] {
	const sources = eventsBySchool[school.id] ?? [];
	return sources
		.map((source, index): Row => {
			const id = `${school.id}-e${index}`;
			const instant = utcInstant(source.at, school.timeZone);
			const labels: Record<string, string> = {};
			if (source.booking) labels.booking = source.booking;
			if (source.code) labels.code = source.code;
			if (source.kind) labels.kind = source.kind;
			const event: LedgerEvent = {
				v: 1,
				id,
				school: school.id,
				source: source.source,
				event_type: source.type,
				event_time: instant,
				ingest_time: instant,
				date: source.at.slice(0, 10),
				tz: school.timeZone,
				key: source.member
					? `family:${familyOf(source.member)}`
					: `school:${school.id}`,
				labels,
				idem: id,
				text: source.text,
				postings: [],
				payload: source.discountCents
					? { discount_cents: source.discountCents }
					: {},
			};
			const code = promosBySchool[school.id]?.find(
				(promo) => promo.id === source.code,
			);
			return {
				index,
				source,
				entry: {
					event,
					pending: false,
					localTime: source.at,
					member: source.member
						? {
								key: event.key,
								id: source.member,
								name: memberNames[school.id]?.[source.member] ?? source.member,
							}
						: null,
					credits: source.credits ?? null,
					amountCents: source.amountCents ?? null,
					paymentId: source.paymentId ?? null,
					promo: code ? { id: code.id, code: code.code } : null,
				},
			};
		})
		.sort(
			(first, second) =>
				second.source.at.localeCompare(first.source.at) ||
				second.index - first.index,
		);
}

const typeFilters: Record<LedgerTypeFilter, (source: SourceEvent) => boolean> =
	{
		payment: ({ type }) => type.startsWith("payment"),
		credit: ({ type }) => type.startsWith("credit"),
		booking: ({ booking }) => Boolean(booking),
		code: ({ code }) => Boolean(code),
		payout: ({ type }) => type.startsWith("payout"),
		admin: ({ source }) => source === "admin",
	};

const isSale = ({ type }: SourceEvent): boolean => type === "payment.succeeded";
const drillFilters: Record<LedgerDrill, (source: SourceEvent) => boolean> = {
	income: (source) => isSale(source) && source.kind !== "gift",
	memb: (source) =>
		isSale(source) && (source.kind ?? "membership") === "membership",
	book: (source) => isSale(source) && source.kind === "booking",
	disc: (source) => isSale(source) && (source.discountCents ?? 0) > 0,
	refund: ({ type }) => type === "payment.refunded",
	fees: isSale,
	payout: ({ type }) => type === "payout.paid",
	gift: ({ kind }) => kind === "gift",
};

function ledgerPage(school: School, query: LedgerQuery): LedgerPage {
	const rows = rowsOf(school).filter(({ source }) => {
		const day = source.at.slice(0, 10);
		return (
			day >= query.from &&
			day <= query.to &&
			(query.type === null || typeFilters[query.type](source)) &&
			(query.drill === null || drillFilters[query.drill](source)) &&
			(query.promo === null || source.code === query.promo)
		);
	});
	const days: LedgerDay[] = [];
	for (const { entry } of rows) {
		const date = entry.event.date;
		let day = days.at(-1);
		if (day?.date !== date) {
			day = { date, count: 0, credits: 0, amountCents: 0, entries: [] };
			days.push(day);
		}
		day.count += 1;
		day.credits += entry.credits ?? 0;
		if (entry.event.event_type !== "payout.paid")
			day.amountCents += entry.amountCents ?? 0;
		day.entries.push(entry);
	}
	return {
		school: school.id,
		from: query.from,
		to: query.to,
		timeZone: school.timeZone,
		currency: school.currency,
		unit: school.creditUnit,
		count: rows.length,
		pending: [],
		days,
	};
}

// ---- The income statement (the mockup's `calc` and `series`).

const sum = (values: Iterable<number>): number => {
	let total = 0;
	for (const value of values) total += value;
	return total;
};

/** The fixtures record every line, so none of their amounts is null. */
type RecordedAmounts = { [Line in keyof StatementAmounts]: number };

function statementOf(
	sources: SourceEvent[],
	from: string,
	to: string,
): {
	amounts: RecordedAmounts;
	counts: IncomeStatement["counts"];
} {
	const inPeriod = sources.filter(({ at }) => {
		const day = at.slice(0, 10);
		return day >= from && day <= to;
	});
	const sales = inPeriod.filter(isSale);
	const gross = (kind: string): number =>
		sum(
			sales
				.filter((sale) => (sale.kind ?? "membership") === kind)
				.map((sale) => (sale.amountCents ?? 0) + (sale.discountCents ?? 0)),
		);
	const discounts = sum(sales.map((sale) => sale.discountCents ?? 0));
	const memberships = gross("membership");
	const bookings = gross("booking");
	const income = memberships + bookings - discounts;
	const refunds = sum(
		inPeriod
			.filter(({ type }) => type === "payment.refunded")
			.map((refund) => refund.amountCents ?? 0),
	);
	const fees = -Math.round(
		sum(sales.map((sale) => sale.amountCents ?? 0)) * feeRate,
	);
	const payouts = inPeriod.filter(({ type }) => type === "payout.paid");
	return {
		amounts: {
			memberships,
			bookings,
			discounts: -discounts,
			income,
			refunds,
			fees,
			net: income + refunds + fees,
			giftsSold: sum(
				sales
					.filter(({ kind }) => kind === "gift")
					.map((sale) => sale.amountCents ?? 0),
			),
			paidOut: sum(payouts.map((payout) => payout.amountCents ?? 0)),
		},
		counts: {
			payments: sales.length,
			refunds: inPeriod.filter(({ type }) => type === "payment.refunded")
				.length,
			payouts: payouts.length,
		},
	};
}

function incomeSeries(
	sources: SourceEvent[],
	from: string,
	to: string,
	today: string,
): IncomeSeries {
	const through = to > today ? today : to;
	if (from > through)
		return { step: "day", points: [], through, totalCents: 0, peak: null };
	const days = (dayNumber(through) - dayNumber(from)) / dayMilliseconds + 1;
	const step = days > longestDailySeries ? wholeWeek : 1;
	const amounts: number[] = Array(Math.ceil(days / step)).fill(0);
	for (const source of sources) {
		const day = source.at.slice(0, 10);
		if (
			!isSale(source) ||
			source.kind === "gift" ||
			day < from ||
			day > through
		)
			continue;
		const slot = Math.floor(
			(dayNumber(day) - dayNumber(from)) / dayMilliseconds / step,
		);
		amounts[slot] = (amounts[slot] ?? 0) + (source.amountCents ?? 0);
	}
	const points = amounts.map((amountCents, index) => ({
		start: addDays(from, index * step),
		amountCents,
	}));
	const peakAmount = Math.max(...amounts);
	return {
		step: step === 1 ? "day" : "week",
		points,
		through,
		totalCents: sum(amounts),
		peak: points.find(({ amountCents }) => amountCents === peakAmount) ?? null,
	};
}

function giftsOutstanding(
	school: string,
): NonNullable<IncomeStatement["giftsOutstanding"]> {
	const active = (promosBySchool[school] ?? []).filter(
		({ type, status }) => type !== "member" && status === "active",
	);
	const totalOf = (type: Promo["type"]): number =>
		sum(active.filter((gift) => gift.type === type).map((gift) => gift.value));
	return {
		amountCents: totalOf("dollar"),
		credits: totalOf("session"),
		count: active.length,
	};
}

// ---- Public, Member and Governance: the audience's document.

const monthNames = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
const firstPublicYear = 2024;
const quarterDelayDays = 49;

type Grain = "year" | "quarter" | "month";

type DocumentPeriod = {
	label: string;
	from: string;
	to: string;
	/** The first day the period's money shows (a year 12 months after it closes, a quarter 49 days, a month 7). */
	shownFrom: string;
};

function documentPeriods(
	grain: Grain,
	year: number,
	today: string,
): DocumentPeriod[] {
	if (grain === "year")
		return Array.from(
			{ length: Number(today.slice(0, 4)) - firstPublicYear + 1 },
			(_, index) => {
				const label = String(firstPublicYear + index);
				return {
					label,
					from: `${label}-01-01`,
					to: `${label}-12-31`,
					shownFrom: addDays(`${Number(label) + 1}-12-31`, wholeWeek),
				};
			},
		);
	const months = grain === "quarter" ? 3 : 1;
	return Array.from({ length: 12 / months }, (_, index) => {
		const from = `${year}-${String(index * months + 1).padStart(2, "0")}-01`;
		const to = endOfMonth(addMonths(from, months - 1));
		return {
			label:
				grain === "quarter"
					? `Q${index + 1} ${year}`
					: `${monthNames[index]} ${year}`,
			from,
			to,
			shownFrom: addDays(
				to,
				grain === "quarter" ? quarterDelayDays : wholeWeek,
			),
		};
	});
}

const notComputed: Cell = { hidden: "not_computed", text: "Not computed" };

/** Reports reads the audience's own KPI document (the Dashboard's, from `documents.json`): every cell, its rounding,
 * its "<10" and its "—" are the document's, so the two surfaces cannot disagree about one school, audience and
 * period. The fixture only picks which period to show and lays the cells out. */
function audienceDocument(
	school: School,
	document: KpiDocument,
	query: AudienceReportQuery,
): AudienceReport {
	const { audience } = query;
	const { grain } = document;
	const table = document.tables[grain];
	if (!table)
		throw new Error(`the ${audience} document of ${school.id} has no table`);
	const asked = document.periods.find(
		({ from, to }) => from <= query.from && query.from <= to,
	);
	const shown =
		(asked?.state === "shown"
			? asked
			: document.periods.filter(({ state }) => state === "shown").at(-1)) ??
		document.periods[0];
	if (!shown) throw new Error(`no ${grain} periods for ${school.id}`);
	const cellAt = (kpi: string, period: string): Cell =>
		table.series[kpi]?.[table.periods.indexOf(period)] ?? notComputed;
	const cell = (kpi: string): Cell => cellAt(kpi, shown.period);
	// A preset with no booking or discount revenue has no series for it: its line reads 0 where the income does, and
	// whatever withholds the income (delay, minimum payers) withholds the line.
	const kindCell = (kpi: string): Cell =>
		table.series[kpi]
			? cell(kpi)
			: typeof cell("gross_collected") === "number"
				? 0
				: cell("gross_collected");
	const year = shown.period.slice(0, 4);
	const strip = document.periods.filter(
		({ period }) => grain === "year" || period.startsWith(year),
	);
	const index = table.periods.indexOf(shown.period);
	const tierKpis = table.order?.revenue_by_tier?.[index] ?? [];
	const tiers = tierKpis.flatMap((kpi) => {
		const income = cell(kpi);
		// A plan with nothing in the period has no line (mockup `reportsDoc` keeps the tiers with a figure).
		return income === 0
			? []
			: [{ name: document.meta[kpi]?.title ?? kpi, income }];
	});
	const governance = audience === "governance";
	const governanceUp: ReportCell = {
		hidden: "no_grant",
		who: "Governance and up",
	};
	return {
		audience,
		grain,
		periodLabel: shown.label,
		payments: cell("payments_count"),
		periods: strip.map(({ period, label }) => ({
			label,
			income: cellAt("gross_collected", period),
		})),
		figures: {
			memberships: kindCell("revenue_by_kind:membership"),
			bookings: kindCell("revenue_by_kind:booking"),
			discounts: kindCell("revenue_by_kind:discount"),
			income: cell("gross_collected"),
			refunds: cell("refunds"),
			fees: cell("stripe_fees"),
			net: cell("net_income"),
			paidOut: cell("payouts"),
			// The documents carry no gift liability: the Governance row reads the school's promos, the rest see none.
			giftsOutstanding: governance
				? giftsOutstanding(school.id).amountCents
				: governanceUp,
		},
		tiers,
		rounding:
			document.roundTo === 0
				? null
				: { unitCents: document.roundTo, size: document.size },
	};
}

// ---- Donors and payers.

const donorFirstNames = [
	"Jane",
	"Omar",
	"Priya",
	"Lena",
	"Tom",
	"Ines",
	"Raj",
	"Maya",
];
const donorLastNames = [
	"Smith",
	"Okafor",
	"Nair",
	"Brandt",
	"Cole",
	"Ruiz",
	"Haddad",
	"Kim",
];
/** The mockup's `bkMakeDonors` amounts, in whole dollars. */
const donorAmounts: number[] = [
	...Array(2).fill(5),
	...[10, 15, 20, 25, 30, 35, 40, 45].flatMap((amount) =>
		Array(4).fill(amount),
	),
	50,
	50,
	60,
	60,
	75,
	90,
	100,
	120,
	150,
	150,
	200,
	200,
	250,
	250,
	300,
	300,
	350,
	400,
	450,
	500,
	500,
	600,
	750,
	900,
	1000,
	1500,
	2500,
	5000,
];
const twoDigits = (value: number): string => String(value).padStart(2, "0");
/** B4 Uni's donors are the mockup's `bkMakeDonors`; Harbor Arts' are the same list with each gift twenty times larger
 * and its ids drawn from the original amount (`bkPseudo(amount + 300)`). */
const harborGiftScale = 20;
const harborIdOffset = 300;
const donorsOf = (school: string): SourceDonor[] => {
	if (school === "vol") return volDonors;
	if (school !== "b4u" && school !== "har") return [];
	const harbor = school === "har";
	return donorAmounts.map((amount, index) => {
		const idSeed = harbor ? amount + harborIdOffset : index;
		const scaled = harbor ? amount * harborGiftScale : amount;
		return {
			id: `d_${(((idSeed + 1) * 40_503 + 7919) % 65_536).toString(16).padStart(4, "0")}`,
			name: `${donorFirstNames[index % 8]} ${donorLastNames[Math.floor(index / 8) % 8]}`,
			amountCents: scaled * 100,
			date: `2026-${twoDigits(((index * 5) % 8) + 1)}-${twoDigits(((index * 3) % 27) + 1)}`,
			fund:
				amount === 5000
					? "Building fund"
					: index % 3 === 0
						? "Scholarships"
						: "General",
			...(amount === 2500 ? { anonymous: true as const } : {}),
		};
	});
};

const donorBuckets: ReadonlyArray<
	readonly [string, (cents: number) => boolean]
> = [
	["under $100", (cents) => cents < 10_000],
	["$100 to $999", (cents) => cents >= 10_000 && cents < 100_000],
	["$1,000 or more", (cents) => cents >= 100_000],
];

function identifiedDonors(
	school: School,
	query: DonorsQuery,
): Extract<DonorsReport, { kind: "identified" }> {
	const year = String(query.year);
	const payers = new Map<string, DonorRow>();
	for (const source of eventsBySchool[school.id] ?? []) {
		if (
			!isSale(source) ||
			source.kind === "gift" ||
			source.member === null ||
			!source.at.startsWith(year)
		)
			continue;
		const row: DonorRow = payers.get(source.member) ?? {
			id: source.member,
			name: memberNames[school.id]?.[source.member] ?? source.member,
			kind: "member",
			fund: null,
			payments: 0,
			totalCents: 0,
			lastPaymentOn: "",
			anonymous: false,
		};
		row.payments += 1;
		row.totalCents += source.amountCents ?? 0;
		row.lastPaymentOn =
			source.at.slice(0, 10) > row.lastPaymentOn
				? source.at.slice(0, 10)
				: row.lastPaymentOn;
		payers.set(source.member, row);
	}
	const donors = donorsOf(school.id).filter(({ date }) =>
		date.startsWith(year),
	);
	const rows: DonorRow[] = [
		...payers.values(),
		...donors.map(
			(donor): DonorRow => ({
				id: donor.id,
				name:
					donor.anonymous && query.audience !== "owner"
						? "Anonymous"
						: donor.name,
				kind: "donor",
				fund: donor.fund,
				payments: 1,
				totalCents: donor.amountCents,
				lastPaymentOn: donor.date,
				anonymous: donor.anonymous === true,
			}),
		),
	].sort((first, second) => second.totalCents - first.totalCents);
	return {
		kind: "identified",
		year: query.year,
		donorCount: donors.length,
		payerCount: payers.size,
		rows,
	};
}

function donorSpread(
	school: School,
	clock: Clock,
	query: DonorsQuery,
): Extract<DonorsReport, { kind: "spread" }> {
	const closed = documentPeriods("month", query.year, clock.today)
		.filter(({ shownFrom }) => shownFrom <= clock.today)
		.at(-1);
	const through = closed?.to ?? `${query.year}-01-31`;
	const amounts = donorsOf(school.id)
		.filter(
			({ date }) => date.startsWith(String(query.year)) && date <= through,
		)
		.map(({ amountCents }) => amountCents)
		.sort((first, second) => first - second);
	const items = donorBuckets.map(([label, within]) => ({
		label,
		count: amounts.filter(within).length,
		why: null as string | null,
	}));
	const failing = items.filter(({ count }) => count > 0 && count < smallCount);
	for (const item of failing) item.why = "fewer than 5 donors";
	if (failing.length === 1) {
		const neighbour = items
			.filter(({ why, count }) => !why && count > 0)
			.sort((first, second) => first.count - second.count)[0];
		if (neighbour)
			neighbour.why =
				"rounded so the cell beside it can't be worked out from the total";
	}
	const hidden = amounts.length < smallCount;
	const middle = Math.floor(amounts.length / 2);
	const median =
		amounts.length % 2
			? (amounts[middle] ?? 0)
			: ((amounts[middle - 1] ?? 0) + (amounts[middle] ?? 0)) / 2;
	return {
		kind: "spread",
		through: through.slice(0, 7),
		donors: amounts.length > 0 && hidden ? { lt: 10 } : amounts.length,
		buckets: hidden
			? []
			: items.map(({ label, count, why }) => ({
					label,
					donors: why
						? count < 10
							? { lt: 10 }
							: Math.round(count / 10) * 10
						: count,
					why,
				})),
		medianCents: hidden
			? { hidden: "suppressed", text: "Hidden: fewer than 5 donors" }
			: median,
	};
}

// ---- The Reader methods.

export function createLedgerReader(options: {
	clock: Clock;
	schools: School[];
	/** The KPI document the Dashboard shows for this school and audience: Reports reads its cells. */
	reportDocument: (query: AudienceReportQuery) => KpiDocument;
}): LedgerReader {
	const { clock, schools } = options;
	const schoolOf = (id: string): School => {
		const school = schools.find((candidate) => candidate.id === id);
		if (!school) throw new Error(`no school ${id}`);
		return school;
	};
	return {
		ledger: async (query) => ledgerPage(schoolOf(query.school), query),
		incomeStatement: async ({ school: id, from, to, compare }) => {
			const school = schoolOf(id);
			const sources = eventsBySchool[id] ?? [];
			const previous = previousPeriod(from, to);
			const { amounts } = statementOf(sources, from, to);
			const before = statementOf(sources, previous.from, previous.to).amounts;
			const changes = Object.fromEntries(
				Object.entries(amounts).map(([line, cents]) => [
					line,
					cents - before[line as keyof RecordedAmounts],
				]),
			) as StatementAmounts;
			return {
				school: id,
				from,
				to,
				currency: school.currency,
				unit: school.creditUnit,
				basis: { kind: "cash" },
				matchesStripe: isWholeMonths(from, to),
				...statementOf(sources, from, to),
				giftsOutstanding: giftsOutstanding(id),
				income: incomeSeries(sources, from, to, clock.today),
				previous: compare
					? {
							...previous,
							amounts: before,
							changes,
							income: incomeSeries(
								sources,
								previous.from,
								previous.to,
								clock.today,
							),
						}
					: null,
			};
		},
		audienceReport: async (query) =>
			audienceDocument(
				schoolOf(query.school),
				options.reportDocument(query),
				query,
			),
		donors: async (query) => {
			const school = schoolOf(query.school);
			if (seesIdentities(query.audience))
				return identifiedDonors(school, query);
			return query.audience === "governance"
				? donorSpread(school, clock, query)
				: { kind: "none" };
		},
		promos: async ({ school: id, audience }) => {
			const school = schoolOf(id);
			return {
				currency: school.currency,
				unit: school.creditUnit,
				promos: (promosBySchool[id] ?? []).map((promo) => ({
					...promo,
					used: usesFor(promo.used, audience),
				})),
			};
		},
		schoolRules: async (id) => {
			const rules = rulesBySchool[id];
			if (!rules) throw new Error(`no rules for ${id}`);
			return { rules, unit: schoolOf(id).creditUnit };
		},
	};
}

/** What an audience may see of how often a code was used (spec v2 small counts). */
function usesFor(used: number, audience: ViewerAudience): Promo["used"] {
	if (seesIdentities(audience)) return used;
	if (audience !== "governance") return { hidden: "no_grant" };
	return used > 0 && used < smallCount ? { lt: 10 } : used;
}
