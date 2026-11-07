/**
 * Display facts for the sample school. The signed record comes from receipt.json (made by scripts/make-samples.ts with
 * atm); the itemised lines are what the school's Stripe invoice carries. All invented.
 */
export const SCHOOL_NAMES: Record<string, string> = {
	sch_juniper: "Juniper Microschool",
};

export const SAMPLE_SCHOOL = {
	id: "sch_juniper",
	name: "Juniper Microschool",
	place: "Boise, ID",
	address: "1420 W Idaho St, Boise, ID 83702",
	ein: "84-3921047",
} as const;

export const SAMPLE_INVOICE = {
	paidBy: "The Kessler family",
	student: "Mara Kessler",
	description: "Tutoring · October 2026 · 32 hours · $25.00/hr",
	paidWith: "Visa ···· 4242",
} as const;

export const formatAmount = (cents: number, currency: string): string => {
	const code = currency.toUpperCase();
	const value = (cents / 100).toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
	return code === "USD" ? `$${value}` : `${value} ${code}`;
};

export const shortId = (id: string, head = 8, tail = 4): string =>
	id.length > head + tail + 1 ? `${id.slice(0, head)}…${id.slice(-tail)}` : id;

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** "2026-10" → "October 2026". */
export const monthName = (month: string): string => {
	const [year, number] = month.split("-");
	return `${MONTHS[Number(number) - 1] ?? month} ${year}`;
};
