/** The period control's arithmetic, after the mockup's `plabel`, `PRE` and `shifted`. Dates are `YYYY-MM-DD` strings
 * read as UTC calendar days; the clock's `today` is the only source of the current date. */
export type Period = { from: string; to: string };

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
const dayMilliseconds = 86_400_000;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const isoMonthPattern = /^\d{4}-\d{2}$/;

const toDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00Z`);
const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);
const isValidDate = (isoDate: string): boolean =>
	isoDatePattern.test(isoDate) &&
	!Number.isNaN(toDate(isoDate).getTime()) &&
	toIsoDate(toDate(isoDate)) === isoDate;
export const addDays = (isoDate: string, days: number): string =>
	toIsoDate(new Date(toDate(isoDate).getTime() + days * dayMilliseconds));
/** Only called with the first day of a month, so no month overflows. */
const addMonths = (isoDate: string, months: number): string => {
	const date = toDate(isoDate);
	date.setUTCMonth(date.getUTCMonth() + months);
	return toIsoDate(date);
};
const endOfMonth = (isoDate: string): string => {
	const date = toDate(isoDate);
	date.setUTCMonth(date.getUTCMonth() + 1, 0);
	return toIsoDate(date);
};
const startOfMonth = (isoDate: string): string => `${isoDate.slice(0, 7)}-01`;
const isWholeMonths = ({ from, to }: Period): boolean =>
	from.endsWith("-01") && endOfMonth(to) === to;
const monthsSpanned = ({ from, to }: Period): number =>
	(Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
	Number(to.slice(5, 7)) -
	Number(from.slice(5, 7)) +
	1;
const monthName = (isoDate: string): string =>
	monthNames[Number(isoDate.slice(5, 7)) - 1] ?? "";
const monthAndYear = (isoDate: string): string =>
	`${monthName(isoDate)} ${isoDate.slice(0, 4)}`;
/** `Nov 4`. */
export const monthAndDay = (isoDate: string): string =>
	`${monthName(isoDate)} ${Number(isoDate.slice(8))}`;

const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekdayIndex = (isoDate: string): number => toDate(isoDate).getUTCDay();
/** `Wed`. */
export const weekdayName = (isoDate: string): string =>
	weekdayNames[weekdayIndex(isoDate)] ?? "";
const daysPerWeek = 7;
/** The Monday of the week that holds `isoDate`. */
export const weekStart = (isoDate: string): string =>
	addDays(isoDate, -((weekdayIndex(isoDate) + daysPerWeek - 1) % daysPerWeek));

export const samePeriod = (first: Period, second: Period): boolean =>
	first.from === second.from && first.to === second.to;

const monthPeriod = (isoDate: string): Period => ({
	from: startOfMonth(isoDate),
	to: endOfMonth(isoDate),
});

/** `Nov 2026`, `Sep – Nov 2026`, `Dec 2025 – Feb 2026`, or for day ranges `Jan 1 – Nov 5, 2026` and, across a year,
 * `Dec 15, 2026 – Jan 10, 2027`. */
export function periodLabel(period: Period): string {
	const { from, to } = period;
	const fromYear = from.slice(0, 4);
	const toYear = to.slice(0, 4);
	if (!isWholeMonths(period))
		return fromYear === toYear
			? `${monthAndDay(from)} – ${monthAndDay(to)}, ${toYear}`
			: `${monthAndDay(from)}, ${fromYear} – ${monthAndDay(to)}, ${toYear}`;
	if (monthsSpanned(period) === 1) return monthAndYear(from);
	if (fromYear === toYear) return `${monthName(from)} – ${monthAndYear(to)}`;
	return `${monthAndYear(from)} – ${monthAndYear(to)}`;
}

/** The popover's presets, computed from the clock. */
export function periodPresets(
	today: string,
): Array<{ label: string; period: Period }> {
	const thisMonth = monthPeriod(today);
	const lastMonth = monthPeriod(addMonths(thisMonth.from, -1));
	return [
		{ label: "This month", period: thisMonth },
		{ label: "Last month", period: lastMonth },
		{
			label: "Last 3 months",
			period: { from: addMonths(thisMonth.from, -2), to: thisMonth.to },
		},
		{
			label: "Year to date",
			period: { from: `${today.slice(0, 4)}-01-01`, to: today },
		},
	];
}

/** The previous or next period of the same length: whole months step by months, other ranges by days. */
export function shiftPeriod(period: Period, direction: 1 | -1): Period {
	if (isWholeMonths(period)) {
		const months = monthsSpanned(period);
		const from = addMonths(period.from, direction * months);
		return { from, to: endOfMonth(addMonths(from, months - 1)) };
	}
	const days =
		Math.round(
			(toDate(period.to).getTime() - toDate(period.from).getTime()) /
				dayMilliseconds,
		) + 1;
	return {
		from: addDays(period.from, direction * days),
		to: addDays(period.to, direction * days),
	};
}

const readPeriod = (value: string): Period | null => {
	if (isoMonthPattern.test(value))
		return isValidDate(`${value}-01`) ? monthPeriod(`${value}-01`) : null;
	const [from = "", to = "", extra] = value.split("..");
	const valid =
		extra === undefined && isValidDate(from) && isValidDate(to) && from <= to;
	return valid ? { from, to } : null;
};

/** Reads the hash's `month=`: `YYYY-MM`, or `YYYY-MM-DD..YYYY-MM-DD`. Missing, malformed, reversed or starting after
 * the clock's today, it is the clock's month. */
export function parsePeriod(value: string | null, today: string): Period {
	const period = value === null ? null : readPeriod(value);
	return period && period.from <= today ? period : monthPeriod(today);
}

/** The `month=` value for a period, or null for the clock's month (the default). */
export function formatPeriod(period: Period, today: string): string | null {
	if (samePeriod(period, monthPeriod(today))) return null;
	if (isWholeMonths(period) && monthsSpanned(period) === 1)
		return period.from.slice(0, 7);
	return `${period.from}..${period.to}`;
}
