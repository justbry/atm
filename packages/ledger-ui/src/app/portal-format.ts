import type { CsvColumn } from "../data/ledger.ts";
import {
	historyCsvColumns,
	type PortalHistoryRow,
	type PortalMember,
	type PortalUnit,
	paymentStatusLabels,
} from "../data/portal.ts";
import type { School } from "../data/types.ts";
import { monthAndDay } from "./period.ts";

const millisecondsPerSecond = 1000;

/** "1 credit", "2 credits". */
export const count = (amount: number, unit: PortalUnit): string =>
	`${amount} ${amount === 1 ? unit.one : unit.other}`;

/** The school's calendar day (`YYYY-MM-DD`) of a Unix second; "en-CA" writes the date in that order. */
const schoolDay = (seconds: number, timeZone: string): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(seconds * millisecondsPerSecond);

/** What a change the member asked for has done so far, kept by the portal until the Reader says it itself:
 * `waiting` the request was sent (the ledger has not shipped it), `quantity` an increase, `scheduledQuantity` a
 * decrease that waits for the renewal, `ending` a cancel (true) or a resume (false). */
export type Change = {
	waiting: boolean;
	quantity?: number;
	scheduledQuantity?: number;
	ending?: boolean;
};

/** A member's plan as the portal writes it: the Reader's membership with the changes made in this session. */
export type Plan = {
	quantity: number;
	priceCents: number;
	/** "Shine ×2". */
	label: string;
	ended: boolean;
	/** The day the period ends, "Dec 1". */
	endsOn: string;
	/** The plan a decrease switches to at the renewal, "Shine ×1". */
	scheduled: string | null;
	waiting: boolean;
};

export function planOf(
	member: PortalMember,
	change: Change | undefined,
	school: School,
): Plan {
	const quantity = change?.quantity ?? member.quantity;
	const priceCents =
		member.quantityOptions?.find((option) => option.quantity === quantity)
			?.priceCents ?? member.priceCents;
	return {
		quantity,
		priceCents,
		label: `${member.tierName} ×${quantity}`,
		ended:
			change?.ending ??
			(member.status === "canceled" || member.cancelAtPeriodEnd),
		endsOn: monthAndDay(schoolDay(member.currentPeriodEnd, school.timeZone)),
		scheduled:
			change?.scheduledQuantity === undefined
				? null
				: `${member.tierName} ×${change.scheduledQuantity}`,
		waiting: member.pendingChange || change?.waiting === true,
	};
}

const historyCsvCells: Record<
	string,
	Pick<CsvColumn<PortalHistoryRow>, "kind" | "value">
> = {
	date: { kind: "text", value: (row) => row.date },
	member: { kind: "text", value: (row) => row.profileId },
	description: { kind: "text", value: (row) => row.description },
	amount: { kind: "money", value: (row) => row.amountCents },
	currency: { kind: "text", value: (row) => row.currency },
	status: { kind: "text", value: (row) => paymentStatusLabels[row.status] },
	invoice_id: { kind: "text", value: (row) => row.invoiceId },
	payment_id: { kind: "text", value: (row) => row.paymentId },
};

/** The history download's columns for the shared CSV helper: the contract's `historyCsvColumns` names them and their
 * order, this gives each its kind and the row's value. */
export const historyCsvColumnsOf = (
	family: boolean,
): Array<CsvColumn<PortalHistoryRow>> =>
	historyCsvColumns(family).map((header) => {
		const cell = historyCsvCells[header];
		if (!cell) throw new Error(`No value for the history CSV column ${header}`);
		return { header, ...cell };
	});
