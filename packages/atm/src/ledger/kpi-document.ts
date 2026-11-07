/**
 * The KPI document (disclosure spec v2 "Documents and routes"): the one document for a school, audience and PIN state,
 * from the school's KPI rows and its disclosure, with every rule taken from the disclosure object (the B4 Uni file and
 * the school's override, `kpiRule`, `classRule`, the rounding by audience and school size, the small-count rounding).
 * Worker-safe (`atm/worker`): pure, no I/O, no clock read, no Ajv. It is `packages/ledger-ui/gates/oracle.ts`'s
 * `kpiDocument` copied here, minus the fixture sources (`martSource`, `eventsSource`); the oracle stays where it is as
 * the independent implementation, and `tests/kpi-document-oracle.test.ts` compares the two on the 15 presets, the five
 * audiences and both PIN states. It ports the frozen mockup's `bkFig`, `pAllow`, `pList`, `bkCaption`, `bkDist`,
 * `bkFundHtml`, `bkRules`, `bkYearLine` and `bkDays` (atm dev 742105b64): the cell rules count the period's paying
 * members (the most in one month of it) as the mockup's `bkFig` does, and a plan's payers as its share of gross over the
 * average per paying member (`dashFull`); a donor bucket or fund counts its gifts.
 */
import { type KpiCatalogKind, kpiCatalog } from "./kpi-catalog.js";
import {
	type Audience,
	applyOverride,
	audienceNames,
	audiences,
	classRule,
	type DetailStep,
	type DisclosureFile,
	type DisclosureGrain,
	detailSteps,
	disclosureGrains,
	type KpiClass,
	type KpiDisclosure,
	kpiClassNames,
	kpiRule,
	type SchoolSize,
} from "./kpi-disclosure.js";
import type {
	Cell,
	DocumentPeriod,
	KpiDocument,
	KpiFormat,
	KpiMeta,
	KpiTable,
	TableGrain,
} from "./kpi-document-types.js";

/** One row of a school's KPI export (`kpiId`, month `YYYY-MM`, whole-number `value`, `unit`); atm's `KpiRow` fits. */
export type KpiDocumentRow = {
	kpiId: string;
	period: string;
	unit: string;
	value: number;
};
/**
 * Per KPI cell, who contributed to it: `kpiId` (or `kpiId:dimension`) to month `YYYY-MM` to the cell's distinct holders
 * and the largest holder's share of the cell's amount (0 to 1). It is the shape of `views/kpi/contributions/YYYY-MM.json`
 * (S8a) read for a year. No holder id is in it. `kpiDocument` accepts it and does not read it yet: the oracle's cell
 * rules count the period's paying members (the mockup's `bkFig`, G1g), not the cell's own holders, and the Worker's
 * document must equal the oracle's.
 */
export type KpiContribution = { holders: number; largestShare: number };
export type KpiContributions = Record<string, Record<string, KpiContribution>>;
/** A gift: `amount` in minor units, `date` `YYYY-MM-DD`, the `fund` it went to. atm books none yet. */
export type KpiGift = { amount: number; date: string; fund: string };
/** What a document needs besides the rows, the disclosure, the audience and the PIN state. */
export type KpiDocumentContext = {
	school: string;
	/** ISO 4217, lower case. */
	currency: string;
	/** The server's clock: `today` (`YYYY-MM-DD`) fixes the year, the embargoes and the open month; `now` is `asOf`. */
	clock: { today: string; now: string };
	/** A fixture school's preset (document `source` is `{ kind: "mart", preset }`, badge "fixture"); absent for a school's own events. */
	preset?: string | null;
	/** The plan ids in the school's plan order; absent, the ids found in the rows, alphabetical. */
	plans?: readonly string[];
	/** Gifts, for the donors' KPIs (governance and up); absent or empty, there are none. */
	donors?: readonly KpiGift[];
	/** Gross per day of each month of the year; absent, the month's gross is split by the mockup's weights. */
	days?: readonly (readonly number[])[] | null;
	/** The figures are scaled (a large fixture school), not the school's books. */
	invented?: boolean;
};

type Dimension = { id: string; title: string };
type Gift = KpiGift;
/** Twelve months of the year's figures, as the document is built from them. */
type MonthlySource = {
	kind: "mart" | "events";
	/** 12 values per KPI id (null: no row). */
	values: Record<string, Array<number | null>>;
	tiers: Dimension[];
	kinds: Dimension[];
	funds: Dimension[];
	donors: Gift[];
	/** Gross per day of each month; null: split the month's gross by the mockup's weights. */
	days: number[][] | null;
	invented: boolean;
};

/** Spec v4's cell rules (disclosure spec v2 "Cell rules"); the small-count unit is the file's `counts`. */
const minContributors = 5;
/** The year table's sum of the year's four rounded quarters (mockup bkYearLine's note), beside the year's own total. */
export const roundedQuartersKpi = "gross_collected_rounded_quarters";
const maxShare = 0.6;
const ratioPrecision = 4;
const kpiSpecVersion = "school.v1";
/** The mockup's earlier years (`BK_SCALE`): invented from the year's months so Public and Member have something to
 * show. */
const yearScale: Record<number, number> = { 2024: 0.58, 2025: 0.82 };
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

/** A catalog entry's kind. The catalog (`kpiCatalog`) is atm's catalog facts the documents need, with the mockup's
 * labels (its `KPI` table), in the document's order: generated from the ledger model by `bun model/build.ts`. */
type Kind = KpiCatalogKind;
/** The mockup's donor buckets (`bkBuckets`), in cents. */
const donorBuckets: Array<Dimension & { below: number | null }> = [
	{ id: "under-100", title: "under $100", below: 10000 },
	{ id: "100-999", title: "$100 to $999", below: 100000 },
	{ id: "1000-plus", title: "$1,000 or more", below: null },
];
const kindTitles: Record<string, string> = {
	membership: "Memberships",
	booking: "Bookings and events",
	discount: "Discounts given",
};
const reasons = {
	fewer: (noun: string) => `fewer than ${minContributors} ${noun}`,
	share: (noun: string) =>
		`one ${noun.replace(/s$/, "")} is over ${maxShare * 100}%`,
	hiddenPair: "hidden so the cell beside it can't be worked out from the total",
	roundedPair:
		"rounded so the cell beside it can't be worked out from the total",
};

const slug = (text: string): string =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
const capitalized = (text: string): string =>
	`${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const fundsOf = (gifts: Gift[]): Dimension[] =>
	[...new Set(gifts.map((gift) => gift.fund))].map((fund) => ({
		id: slug(fund),
		title: fund,
	}));
const monthsOfYear = (year: number): string[] =>
	monthNames.map((_, index) => `${year}-${String(index + 1).padStart(2, "0")}`);

/** The mart presets' plan order as the mockup shows it (its embedded `t:{Scholar,Fellow,Seminar,Audit}`, atm's

/** The year's twelve months of each KPI the document reads, from the export rows. */
const sourceOf = (
	rows: readonly KpiDocumentRow[],
	context: KpiDocumentContext,
	year: number,
): MonthlySource => {
	const months = monthsOfYear(year);
	const value = new Map(
		rows.map((row) => [`${row.kpiId}@${row.period}`, row.value]),
	);
	const ids = [
		...new Set(
			rows
				.map((row) => row.kpiId)
				.filter(
					(id) =>
						Object.hasOwn(kpiCatalog, id) ||
						id.startsWith("revenue_by_tier:") ||
						id.startsWith("revenue_by_kind:"),
				),
		),
	].sort();
	const values: MonthlySource["values"] = {};
	for (const id of ids)
		values[id] = months.map((month) => value.get(`${id}@${month}`) ?? null);
	const planIds =
		context.plans ??
		ids
			.filter((id) => id.startsWith("revenue_by_tier:"))
			.map((id) => id.slice("revenue_by_tier:".length));
	const donors = (context.donors ?? []).map((gift) => ({ ...gift }));
	return {
		kind: context.preset ? "mart" : "events",
		values,
		tiers: planIds.map((plan) => ({ id: plan, title: capitalized(plan) })),
		kinds: ids
			.filter((id) => id.startsWith("revenue_by_kind:"))
			.map((id) => {
				const kind = id.slice("revenue_by_kind:".length);
				return { id: kind, title: kindTitles[kind] ?? capitalized(kind) };
			}),
		funds: fundsOf(donors),
		donors,
		days: context.days?.map((day) => [...day]) ?? null,
		invented: context.invented ?? false,
	};
};

// ---- Dates (UTC calendar arithmetic on ISO dates, as the mockup's addDays, addMonths, eom)
const isoOf = (time: number): string =>
	new Date(time).toISOString().slice(0, 10);
const endOfMonth = (iso: string): string => {
	const [year = 0, month = 1] = iso.split("-").map(Number);
	return isoOf(Date.UTC(year, month, 0));
};
const addDays = (iso: string, days: number): string =>
	isoOf(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000);
const addMonths = (iso: string, months: number): string => {
	const [year = 0, month = 1, day = 1] = iso.split("-").map(Number);
	const target = Date.UTC(year, month - 1 + months, 1);
	const last = new Date(Date.UTC(year, month + months, 0)).getUTCDate();
	const shifted = new Date(target);
	shifted.setUTCDate(Math.min(day, last));
	return isoOf(shifted.getTime());
};
const addAfter = (iso: string, after: string | null): string => {
	if (!after) return iso;
	const [count = "0", unit = ""] = after.split(" ");
	if (unit.startsWith("month")) return addMonths(iso, Number(count));
	if (unit.startsWith("week")) return addDays(iso, 7 * Number(count));
	return addDays(iso, Number(count));
};
/** A period closes 7 days after its last month ends (spec "Closed months"). */
const closeOf = (to: string): string => addDays(endOfMonth(to), 7);
const longDate = (iso: string): string =>
	`${Number(iso.slice(8, 10))} ${monthNames[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** atm's `roundedRatio`: half up, away from zero, on integers; 0 when the denominator is 0 (atm and the mockup). */
const ratio = (numerator: number, denominator: number): number => {
	if (denominator === 0) return 0;
	if (!Number.isInteger(numerator) || !Number.isInteger(denominator))
		return (
			Math.round((numerator / denominator) * 10 ** ratioPrecision) /
			10 ** ratioPrecision
		);
	const scale = 10n ** BigInt(ratioPrecision);
	const scaled = BigInt(numerator) * scale;
	const divisor = BigInt(denominator);
	const negative = scaled < 0n !== divisor < 0n;
	const absolute = (value: bigint): bigint => (value < 0n ? -value : value);
	const quotient =
		(2n * absolute(scaled) + absolute(divisor)) / (2n * absolute(divisor));
	return Number(negative ? -quotient : quotient) / Number(scale);
};
const noNegativeZero = (value: number): number => (value === 0 ? 0 : value);

const grainRank = (grain: string): number =>
	disclosureGrains.indexOf(grain as DisclosureGrain);
const detailRank = (detail: string): number =>
	detailSteps.indexOf(detail as DetailStep);

type Period = {
	period: string;
	label: string;
	from: string;
	to: string;
	grain: TableGrain;
	year: number;
	/** Month indexes of the source year (0 to 11). */
	months: number[];
	invented: boolean;
};
const yearPeriod = (year: number): Period => ({
	period: String(year),
	label: String(year),
	from: `${year}-01-01`,
	to: `${year}-12-31`,
	grain: "year",
	year,
	months: [...Array(12).keys()],
	invented: year in yearScale,
});
const quarterPeriod = (year: number, quarter: number): Period => ({
	period: `${year}-Q${quarter + 1}`,
	label: `Q${quarter + 1} ${year}`,
	from: `${year}-${String(3 * quarter + 1).padStart(2, "0")}-01`,
	to: endOfMonth(`${year}-${String(3 * quarter + 3).padStart(2, "0")}-01`),
	grain: "quarter",
	year,
	months: [3 * quarter, 3 * quarter + 1, 3 * quarter + 2],
	invented: year in yearScale,
});
const monthPeriod = (year: number, index: number): Period => ({
	period: `${year}-${String(index + 1).padStart(2, "0")}`,
	label: `${monthNames[index]} ${year}`,
	from: `${year}-${String(index + 1).padStart(2, "0")}-01`,
	to: endOfMonth(`${year}-${String(index + 1).padStart(2, "0")}-01`),
	grain: "month",
	year,
	months: [index],
	invented: year in yearScale,
});

/** What the disclosure gives one audience (the contract's rules, read once). */
type AudiencePolicy = {
	audience: Audience;
	live: boolean;
	identities: boolean;
	/** Below governance every figure is ruled; governance only breakdowns and spreads; live audiences none. */
	ruled: (need: DetailStep | undefined) => boolean;
	roundTo: number;
	failingRoundTo: number;
	grain: "year" | "quarter" | "month";
	years: number[];
	rule: (kpi: string) => ReturnType<typeof kpiRule>;
};
const audiencePolicy = (
	file: DisclosureFile,
	audience: Audience,
	size: SchoolSize,
	year: number,
): AudiencePolicy => {
	const rank = audiences.indexOf(audience);
	const gross = kpiRule(file, audience, "gross_collected");
	if (!gross) throw new Error(`${audience} has no rule for gross_collected`);
	const live = gross.live;
	const grain = live ? "month" : (gross.every as "year" | "quarter" | "month");
	const rounding = file.rounding[size];
	const roundTo =
		audience === "public" || audience === "member" ? rounding[audience] : 0;
	return {
		audience,
		live,
		identities: Boolean(file.audiences[audience].identities),
		ruled: (need) =>
			!live &&
			(rank < audiences.indexOf("governance") ||
				(need !== undefined && detailRank(need) >= detailRank("breakdown"))),
		roundTo,
		failingRoundTo: file.counts.failingRoundTo,
		grain,
		years:
			grain === "year"
				? [year - 2, year - 1, year]
				: grain === "quarter"
					? [year - 1, year]
					: [year],
		rule: (kpi) => kpiRule(file, audience, kpi),
	};
};

/** The first audience that sees the KPI (at the detail and grain asked), as the mockup's `whoSees` and `whoTxt`. */
const whoSees = (
	file: DisclosureFile,
	kpi: string,
	need?: DetailStep,
	grain?: TableGrain,
): { reason: "members_only" | "no_grant"; text: string } => {
	const who = audiences.find((audience) => {
		const rule = kpiRule(file, audience, kpi);
		return (
			rule &&
			(!need || detailRank(rule.detail) >= detailRank(need)) &&
			(!grain || grainRank(rule.every) >= grainRank(grain))
		);
	});
	return {
		reason: who === "member" ? "members_only" : "no_grant",
		text:
			who === "member"
				? "Members see this"
				: who === "governance"
					? "Governance and up see this"
					: "Finance admins and the owner see this",
	};
};

export function kpiDocument(
	rows: readonly KpiDocumentRow[],
	_contributions: KpiContributions,
	disclosure: KpiDisclosure,
	audience: Audience,
	pinLocked: boolean,
	context: KpiDocumentContext,
): KpiDocument {
	const { school, clock } = context;
	const { size } = disclosure;
	const file = applyOverride(disclosure.file, disclosure.override);
	const year = Number(clock.today.slice(0, 4));
	const source = sourceOf(rows, context, year);
	const today = clock.today;
	const clockMonth = Number(clock.today.slice(5, 7)) - 1;
	const policy = audiencePolicy(file, audience, size, year);
	if (
		pinLocked &&
		!(audiences.indexOf(audience) >= audiences.indexOf("governance"))
	)
		throw new Error(`${audience} opens no books with a PIN`);

	// ---- The KPIs this audience's document carries: the dimensions expanded; plans, funds and donors from governance up
	const dimensions: Record<string, Dimension[]> = {
		"revenue_by_kind:*": source.kinds,
		"revenue_by_tier:*": source.tiers,
		"donations_by_fund:*": source.funds,
		"donors_by_size:*": donorBuckets,
	};
	const governanceUp =
		audiences.indexOf(audience) >= audiences.indexOf("governance");
	const kpis = Object.entries(kpiCatalog).flatMap(([key, entry]) => {
		const donorKpi = key.startsWith("donor") || key.startsWith("donations");
		if ((donorKpi || key.startsWith("revenue_by_tier")) && !governanceUp)
			return [];
		if (donorKpi && source.donors.length === 0) return [];
		if (!key.endsWith(":*")) return [{ id: key, entry, title: entry.title }];
		const prefix = key.slice(0, -1);
		return (dimensions[key] ?? []).map((dimension) => ({
			id: `${prefix}${dimension.id}`,
			entry: {
				...entry,
			},
			title: dimension.title,
		}));
	});
	const catalogOf = new Map(kpis.map((kpi) => [kpi.id, kpi]));

	// ---- Values: a month of the year, or of an invented earlier year (scaled, rounded per month as bkYear)
	const monthValue = (
		id: string,
		periodYear: number,
		month: number,
	): number | null => {
		const value = source.values[id]?.[month];
		if (value === null || value === undefined) return null;
		const factor = periodYear === year ? 1 : (yearScale[periodYear] ?? 0);
		return factor === 1 ? value : Math.round(value * factor);
	};
	const sumOf = (id: string, period: Period): number | null => {
		const found = period.months
			.map((month) => monthValue(id, period.year, month))
			.filter((value): value is number => value !== null);
		return found.length
			? found.reduce((total, value) => total + value, 0)
			: null;
	};
	const figureOf = (id: string, period: Period): number | null => {
		if (id === "paying_members") {
			const found = period.months
				.map((month) => monthValue(id, period.year, month))
				.filter((value): value is number => value !== null);
			return found.length ? Math.max(...found) : null;
		}
		const entry = catalogOf.get(id)?.entry ?? kpiCatalog[id];
		if (entry?.kind === "rate") {
			const [numerator, denominator] = entry.inputs ?? [];
			const top = numerator ? sumOf(numerator, period) : null;
			const bottom = denominator ? sumOf(denominator, period) : null;
			// A rate over nothing is not a rate: not_computed, never 0 (GOAL.md: null is never shown as 0).
			return top === null || bottom === null || bottom === 0
				? null
				: ratio(top, bottom);
		}
		if (id === "dispute_cost") {
			const lost = sumOf("disputes_lost", period);
			const fees = sumOf("dispute_fees", period);
			return lost === null || fees === null ? null : lost + fees;
		}
		if (id === "arpa") {
			const gross = sumOf("gross_collected", period);
			const payers = figureOf("paying_members", period);
			return gross === null || payers === null || payers === 0
				? null
				: Math.round((gross / payers) * 100) / 100;
		}
		return sumOf(id, period);
	};

	// ---- The cell rules: the cell's own holders on the mart, the period's paying members on the mockup's schools
	/** Mockup bkFig: a figure fails when the period has fewer than 5 paying members (the most in one month of it);
	 * dashFull counts a plan's payers as its gross over the average per paying member. */
	const failure = (id: string, period: Period, value: number): string => {
		if (value === 0) return "";
		const payers = id.startsWith("revenue_by_tier:")
			? planPayers(value, period)
			: (figureOf("paying_members", period) ?? 0);
		return payers < minContributors ? reasons.fewer("payers") : "";
	};
	const planPayers = (value: number, period: Period): number =>
		Math.round(value / Math.max(1, figureOf("arpa", period) ?? 0));
	const roundCount = (value: number, why: string): Cell =>
		value < policy.failingRoundTo
			? { lt: policy.failingRoundTo, why }
			: {
					approx:
						Math.round(value / policy.failingRoundTo) * policy.failingRoundTo,
					why,
				};
	const finish = (kind: Kind, value: number, why: string): Cell => {
		if (why) {
			if (kind === "count") return roundCount(value, why);
			return { hidden: "suppressed", text: `Hidden: ${why}` };
		}
		if (kind !== "money" || policy.roundTo === 0) return noNegativeZero(value);
		const rounded = noNegativeZero(
			Math.round(value / policy.roundTo) * policy.roundTo,
		);
		return value > 0 && rounded === 0 ? { lt: policy.roundTo } : rounded;
	};
	/** A cell before its value: hidden by the audience's rule, its grain, its detail or its delay (mockup bkFig). */
	const gate = (id: string, period: Period): Cell | null => {
		const entry = catalogOf.get(id)?.entry;
		if (!entry) throw new Error(`${id} is not in the catalog`);
		const rule = policy.rule(entry.ruleOf);
		if (!rule) {
			const who = whoSees(file, entry.ruleOf);
			return { hidden: who.reason, text: who.text };
		}
		if (rule.live) return null;
		if (grainRank(period.grain) > grainRank(rule.every)) {
			const who = whoSees(file, entry.ruleOf, undefined, period.grain);
			return { hidden: who.reason, text: who.text };
		}
		if (entry.need && detailRank(entry.need) > detailRank(rule.detail)) {
			const who = whoSees(file, entry.ruleOf, entry.need);
			return { hidden: who.reason, text: who.text };
		}
		const published = addAfter(closeOf(period.to), rule.after);
		if (published > today)
			return {
				hidden: "embargoed",
				text: `Published after ${longDate(published)}`,
			};
		return null;
	};
	const cellOf = (id: string, period: Period): Cell => {
		const gated = gate(id, period);
		if (gated) return gated;
		const value = figureOf(id, period);
		if (value === null) return { hidden: "not_computed", text: "Not computed" };
		const entry = catalogOf.get(id)?.entry;
		const why =
			entry && policy.ruled(entry.need) ? failure(id, period, value) : "";
		return finish(entry?.kind ?? "money", value, why);
	};

	// ---- Tables
	const tablePeriods: Partial<Record<TableGrain, Period[]>> =
		policy.grain === "month"
			? { month: monthNames.map((_, index) => monthPeriod(year, index)) }
			: {
					year: policy.years.map(yearPeriod),
					quarter: policy.years.flatMap((periodYear) =>
						[0, 1, 2, 3].map((quarter) => quarterPeriod(periodYear, quarter)),
					),
					month: policy.years.flatMap((periodYear) =>
						monthNames.map((_, index) => monthPeriod(periodYear, index)),
					),
				};
	const plainKpis = kpis.filter(
		({ id }) => !id.startsWith("donor") && !id.startsWith("donations"),
	);
	const tables: KpiDocument["tables"] = {};
	for (const [grain, periods] of Object.entries(tablePeriods) as Array<
		[TableGrain, Period[]]
	>) {
		const series: Record<string, Cell[]> = {};
		for (const { id } of plainKpis)
			series[id] = periods.map((period) => cellOf(id, period));
		const table: KpiTable = {
			periods: periods.map((period) => period.period),
			series,
		};
		complementPlans(table, periods);
		const tierIds = plainKpis
			.filter(({ id }) => id.startsWith("revenue_by_tier:"))
			.map(({ id }) => id);
		if (tierIds.length > 0)
			table.order = { revenue_by_tier: periods.map(() => tierIds) };
		if (grain === "month" && governanceUp) addDonors(table, periods);
		tables[grain] = table;
	}
	/** Mockup bkYearLine: at the quarter grain the year's own total (the year table's gross, rounded from the year's
	 * events) and the sum of its four rounded quarters, which the mockup shows beside it when all five are figures. */
	const yearTable = tables.year;
	const quarterTable = tables.quarter;
	if (policy.grain === "quarter" && yearTable && quarterTable)
		yearTable.series[roundedQuartersKpi] = yearTable.periods.map(
			(period, index) => {
				const total = yearTable.series.gross_collected?.[index];
				const quarters = [1, 2, 3, 4].map(
					(quarter) =>
						quarterTable.series.gross_collected?.[
							quarterTable.periods.indexOf(`${period}-Q${quarter}`)
						],
				);
				if (
					typeof total !== "number" ||
					!quarters.every((cell) => typeof cell === "number")
				)
					return { hidden: "not_computed", text: "Not computed" };
				return quarters.reduce<number>(
					(sum, cell) => sum + (typeof cell === "number" ? cell : 0),
					0,
				);
			},
		);

	/** Mockup dlt: in the month table, each money or count cell's change against the month before, when both are
	 * figures as this audience sees them. */
	const monthTable = tables.month;
	if (monthTable) {
		const changes: Record<string, Array<number | null>> = {};
		for (const { id, entry } of plainKpis) {
			const cells = monthTable.series[id];
			if (entry.kind === "rate" || !cells) continue;
			changes[id] = cells.map((cell, index) => {
				const before = cells[index - 1];
				return typeof cell === "number" && typeof before === "number"
					? cell - before
					: null;
			});
		}
		monthTable.changes = changes;
	}

	/** bkRules over the plans of a period (governance): one hidden plan hides the smallest shown one too. */
	function complementPlans(table: KpiTable, periods: Period[]): void {
		const ids = plainKpis
			.filter(({ id }) => id.startsWith("revenue_by_tier:"))
			.map(({ id }) => id);
		if (!policy.ruled("breakdown")) return;
		periods.forEach((period, index) => {
			const isCut = (id: string): boolean => {
				const found = table.series[id]?.[index];
				return (
					typeof found === "object" &&
					"hidden" in found &&
					found.hidden === "suppressed"
				);
			};
			const cut = ids.filter(isCut);
			if (cut.length !== 1) return;
			const next = ids
				.map((id) => ({ id, value: table.series[id]?.[index] }))
				.filter(
					(term): term is { id: string; value: number } =>
						typeof term.value === "number" &&
						planPayers(term.value, period) > 0,
				)
				.sort((first, second) => first.value - second.value)[0];
			const cells = next ? table.series[next.id] : undefined;
			if (next && cells)
				cells[index] = {
					hidden: "suppressed",
					text: `Hidden: ${reasons.hiddenPair}`,
				};
		});
	}

	/** The donors (mockup bkDist and bkFundHtml), 2026 from January to the end of each month. */
	function addDonors(table: KpiTable, periods: Period[]): void {
		if (source.donors.length === 0) return;
		const ruled = policy.ruled("spread");
		const funds = source.funds;
		const series: Record<string, Cell[]> = {
			donors_count: [],
			donors_median_gift: [],
			...Object.fromEntries(
				donorBuckets.map((bucket) => [`donors_by_size:${bucket.id}`, []]),
			),
			...Object.fromEntries(
				funds.map((fund) => [`donations_by_fund:${fund.id}`, []]),
			),
		};
		const order: string[][] = [];
		for (const period of periods) {
			const given = source.donors.filter((gift) => gift.date <= period.to);
			const count = given.length;
			const sorted = given.map((gift) => gift.amount).sort((a, b) => a - b);
			const median =
				count === 0
					? null
					: count % 2
						? (sorted[(count - 1) / 2] ?? 0)
						: ((sorted[count / 2 - 1] ?? 0) + (sorted[count / 2] ?? 0)) / 2;
			const buckets = donorBuckets.map((bucket, index) => {
				const lower = donorBuckets[index - 1]?.below ?? 0;
				const inside = given.filter(
					(gift) =>
						gift.amount >= lower &&
						(bucket.below === null || gift.amount < bucket.below),
				);
				return {
					id: `donors_by_size:${bucket.id}`,
					count: inside.length,
					why: "",
				};
			});
			if (ruled) {
				const failing = buckets.filter(
					(bucket) => bucket.count > 0 && bucket.count < minContributors,
				);
				for (const bucket of failing) bucket.why = reasons.fewer("donors");
				if (failing.length === 1) {
					const next = buckets
						.filter((bucket) => !bucket.why && bucket.count > 0)
						.sort((first, second) => first.count - second.count)[0];
					if (next) next.why = reasons.roundedPair;
				}
			}
			const tooFew = ruled && count > 0 && count < minContributors;
			const fundItems = funds
				.map((fund) => {
					const inside = given.filter((gift) => gift.fund === fund.title);
					const sum = inside.reduce((total, gift) => total + gift.amount, 0);
					return {
						id: `donations_by_fund:${fund.id}`,
						count: inside.length,
						sum,
						top: Math.max(0, ...inside.map((gift) => gift.amount)),
						why: "",
					};
				})
				.sort((first, second) => second.sum - first.sum);
			if (policy.ruled("breakdown")) {
				for (const item of fundItems)
					item.why =
						item.count === 0
							? ""
							: item.count < minContributors
								? reasons.fewer("donors")
								: item.top / item.sum > maxShare
									? reasons.share("donors")
									: "";
				const hidden = fundItems.filter((item) => item.why);
				if (hidden.length === 1) {
					const next = fundItems
						.filter((item) => !item.why && item.count > 0)
						.sort((first, second) => first.sum - second.sum)[0];
					if (next) next.why = reasons.hiddenPair;
				}
			}
			order.push(
				fundItems.filter((item) => item.count > 0).map((item) => item.id),
			);
			const put = (id: string, cell: Cell): void => {
				const gated = gate(id, period);
				series[id]?.push(gated ?? cell);
			};
			put(
				"donors_count",
				tooFew
					? { lt: policy.failingRoundTo, why: reasons.fewer("donors") }
					: count,
			);
			put(
				"donors_median_gift",
				median === null
					? { hidden: "not_computed", text: "No donations recorded yet" }
					: tooFew
						? {
								hidden: "suppressed",
								text: `Hidden: ${reasons.fewer("donors")}`,
							}
						: median,
			);
			for (const bucket of buckets)
				put(
					bucket.id,
					tooFew
						? {
								hidden: "suppressed",
								text: `Hidden: ${reasons.fewer("donors")}`,
							}
						: bucket.why
							? roundCount(bucket.count, bucket.why)
							: bucket.count,
				);
			for (const item of fundItems)
				put(
					item.id,
					item.why
						? { hidden: "suppressed", text: `Hidden: ${item.why}` }
						: item.sum,
				);
		}
		Object.assign(table.series, series);
		table.order = { ...table.order, donations_by_fund: order };
	}

	// ---- Days (live audiences): the month's gross by day, as the mockup draws it
	if (policy.live) {
		const dayPeriods: string[] = [];
		const cells: Cell[] = [];
		monthNames.forEach((_, month) => {
			const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
			const last =
				month === clockMonth ? Number(clock.today.slice(8, 10)) : count;
			const gross = monthValue("gross_collected", year, month);
			const fromEvents = source.days?.[month];
			const weights = [...Array(count).keys()].map((day) =>
				day < last ? 1 + ((day * 7 + month * 3) % 5) : 0,
			);
			const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
			let left = gross ?? 0;
			for (let day = 0; day < count; day += 1) {
				dayPeriods.push(
					`${year}-${String(month + 1).padStart(2, "0")}-${String(day + 1).padStart(2, "0")}`,
				);
				if (day >= last) {
					cells.push({ hidden: "future", text: "not yet" });
					continue;
				}
				if (fromEvents) {
					cells.push(fromEvents[day] ?? 0);
					continue;
				}
				if (gross === null) {
					cells.push({ hidden: "not_computed", text: "Not computed" });
					continue;
				}
				if (day < last - 1) {
					const share = Math.round((gross * (weights[day] ?? 0)) / totalWeight);
					left -= share;
					cells.push(share);
				} else cells.push(left);
			}
		});
		tables.day = { periods: dayPeriods, series: { gross_collected: cells } };
	}

	// ---- The strip: the audience's periods and what the period control says of each (mockup pList and pAllow)
	const stripPeriods =
		policy.grain === "year"
			? policy.years.map(yearPeriod)
			: policy.grain === "quarter"
				? policy.years.flatMap((periodYear) =>
						[0, 1, 2, 3].map((quarter) => quarterPeriod(periodYear, quarter)),
					)
				: monthNames.map((_, index) => monthPeriod(year, index));
	const grossRule = policy.rule("gross_collected");
	const periods: DocumentPeriod[] = stripPeriods.map((period) => {
		const published =
			grossRule && !grossRule.live
				? addAfter(closeOf(period.to), grossRule.after)
				: null;
		/** The Dashboard's strip (mockup dashAgg and dashFull's mstrip): below the live audiences a period not shown yet,
		 * started or not, waits for its close plus the delay ("Published after 7 Jan 2027"); only the live audiences
		 * see a month after the clock as "Not started yet". */
		const state: DocumentPeriod["state"] =
			published && published > today
				? "embargoed"
				: period.from > today
					? "future"
					: "shown";
		return {
			period: period.period,
			label: period.label,
			from: period.from,
			to: period.to,
			state,
			title:
				state === "future"
					? "Not started yet"
					: state === "embargoed" && published
						? `Published after ${longDate(published)}`
						: null,
			open:
				policy.live &&
				period.grain === "month" &&
				period.months[0] === clockMonth,
			invented: period.invented,
		};
	});

	// ---- Captions (mockup bkCaption), by year
	const captionOf = (captionYear: number): string => {
		const name = audienceNames[audience];
		if (policy.identities)
			return `${name} sees everything, live: months and days, the open month included, names included. Cell rules are off, so no figure is hidden or banded. ${audience === "owner" ? "Owner-only actions (refunds, roles, publishing) stay on their own tabs. Anonymous donors' names show to the owner only. " : ""}Every identified read is audited.`;
		const classes: KpiClass[] = [
			"income",
			"losses",
			"cash",
			"people",
			"activity",
		];
		const parts = classes.map((kpiClass) => {
			const own = classRule(file, kpiClass, audience);
			if (own)
				return `${kpiClassNames[kpiClass]}: ${own.live ? "everything, live" : `${own.detail} by ${own.every}${own.after ? `, ${own.after} after it closes` : ""}`}`;
			const first = audiences.find((other) => classRule(file, kpiClass, other));
			const who =
				first === "member"
					? "Members"
					: first === "governance"
						? "Governance and up"
						: "Finance admins and the owner";
			return `${kpiClassNames[kpiClass]}: ${who} only`;
		});
		const money = policy.roundTo
			? `rounded to ${formatMoney0(policy.roundTo, context.currency)} (${size} school, fixed for ${captionYear} on 1 Jan ${captionYear})`
			: "exact";
		const rules =
			audiences.indexOf(audience) < audiences.indexOf("governance")
				? `Cell rules on: a count under ${minContributors} payers shows as <${policy.failingRoundTo} or to the nearest ${policy.failingRoundTo}; an amount is hidden.`
				: "Cell rules on for breakdowns and spreads. No names, emails or per-person rows.";
		const next = periods.find((period) => period.state === "embargoed");
		const nextText = next
			? policy.grain === "month"
				? ` ${monthNames[Number(next.period.slice(5, 7)) - 1]}: published after ${(next.title ?? "").replace("Published after ", "")}.`
				: ` ${next.label}: published after ${(next.title ?? "").replace("Published after ", "")}.`
			: "";
		return `${name} document · ${parts.join(" · ")}. Money ${money}. ${rules}${nextText}`;
	};
	const captions = Object.fromEntries(
		policy.years.map((captionYear) => [
			String(captionYear),
			captionOf(captionYear),
		]),
	);

	// ---- No payments yet (mockup dashFull): the year's months the audience sees hold no gross and no payer
	const seen = monthNames
		.map((_, month) => month)
		.filter((month) => periods[month]?.state !== "embargoed");
	const empty =
		policy.grain === "month" &&
		seen.every(
			(month) =>
				!monthValue("gross_collected", year, month) &&
				!monthValue("paying_members", year, month),
		);

	// ---- Meta
	const meta: Record<string, KpiMeta> = {};
	for (const { id, entry, title } of kpis) {
		const rule = policy.rule(entry.ruleOf);
		const wholeUnits =
			entry.kind === "money" &&
			(policy.roundTo > 0 || entry.format === "money0");
		const format: KpiFormat =
			entry.kind === "count"
				? "integer"
				: entry.kind === "rate"
					? "percent1"
					: wholeUnits
						? "money0"
						: "money";
		meta[id] = {
			title,
			kind: entry.kind,
			format,
			kpiClass:
				(Object.entries(file.classes).find(([, members]) =>
					members.includes(entry.ruleOf),
				)?.[0] as KpiClass | undefined) ?? "income",
			every: !rule
				? policy.grain
				: rule.live
					? "day"
					: (rule.every as TableGrain),
			detail: rule?.detail ?? "total",
			invented:
				source.invented || id.startsWith("donor") || id.startsWith("donations"),
		};
	}

	if (tables.year?.series[roundedQuartersKpi])
		meta[roundedQuartersKpi] = {
			title: "The four rounded quarters",
			kind: "money",
			format: "money0",
			kpiClass: "income",
			every: "year",
			detail: policy.rule("gross_collected")?.detail ?? "total",
			invented: source.invented,
		};

	// ---- The PIN-locked document: nothing shows until the PIN is entered (mockup bkLock)
	if (pinLocked)
		for (const table of Object.values(tables))
			if (table) {
				for (const cells of Object.values(table.series))
					cells.fill({ hidden: "locked", text: "Locked" });
				delete table.changes;
			}

	const notes = [
		...(policy.years.some((periodYear) => periodYear in yearScale)
			? [
					"Years before 2026 are invented from 2026's months scaled by the mockup's BK_SCALE (0.58 for 2024, 0.82 for 2025), rounded per month.",
				]
			: []),
		...(source.invented
			? [
					"A large school: B4 Uni's mart figures times 40 for money and 10 for counts, as the mockup's Harbor Arts Academy.",
				]
			: []),
		...(governanceUp && source.donors.length
			? [
					"Donors and donations are the mockup's fixture gifts (atm books no donations yet).",
				]
			: []),
		...(policy.live && !source.days
			? ["Days split each month's gross by the mockup's weights (bkDays)."]
			: []),
	];

	return {
		school,
		source: context.preset
			? { kind: "mart", preset: context.preset }
			: { kind: "events" },
		dataSource: source.kind === "mart" ? "fixture" : "events",
		audience,
		pinLocked,
		year,
		basis: "cash",
		currency: context.currency,
		symbol: currencySymbols[context.currency] ?? "$",
		kpiSpecVersion,
		asOf: clock.now,
		size,
		roundTo: policy.roundTo,
		live: policy.live,
		cellRules: policy.live
			? "off"
			: audiences.indexOf(audience) < audiences.indexOf("governance")
				? "on"
				: "breakdown and spread",
		grain: policy.grain,
		periods,
		captions,
		empty,
		tables,
		meta,
		notComputed: [
			{
				id: "mrr",
				reason:
					"MRR is not computed: cash basis, a yearly payer counts in the month paid",
			},
			{ id: "churned_members", reason: "Churn is not computed: cash basis" },
		],
		notes,
		verified: true,
	};
}

/** The mockup's money symbols (`s.cur`). */
const currencySymbols: Record<string, string> = {
	usd: "$",
	cad: "C$",
	eur: "€",
};
/** The mockup's `kusd0`. */
const formatMoney0 = (cents: number, currency: string): string =>
	`${cents < 0 ? "−" : ""}${currencySymbols[currency] ?? "$"}${Math.round(Math.abs(cents) / 100).toLocaleString("en-US")}`;
